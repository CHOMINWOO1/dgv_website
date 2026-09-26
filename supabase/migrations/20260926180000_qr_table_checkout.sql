-- Finalize every confirmed, unpaid QR order for one table as one paid sale.
--
-- This deployment is schema-only: it changes indexes/functions/privileges but
-- does not mutate existing business rows. The previously deployed single-order
-- checkout remains callable during the DB-first rollout window and is revoked
-- only by the post-frontend migration.

set lock_timeout = '5s';

-- Multiple QR submissions now intentionally point at one paid ledger row.
-- Keep the restrictive FK, replacing only its historical one-to-one index.
alter table public.qr_orders
  drop constraint if exists qr_orders_finalized_order_id_key;

create index if not exists qr_orders_finalized_order_id_idx
  on public.qr_orders (finalized_order_id)
  where finalized_order_id is not null;

-- A deleted consolidated sale must leave one tombstone on every contributing
-- QR submission, so voided_order_id can no longer be unique either.
drop index if exists public.qr_orders_voided_order_id_key;

create index if not exists qr_orders_voided_order_id_idx
  on public.qr_orders (voided_order_id)
  where voided_order_id is not null;

comment on column public.qr_orders.finalized_order_id is
  'Paid orders.id shared by every QR submission included in the same table checkout.';
comment on column public.qr_orders.voided_order_id is
  'Audit tombstone for a deleted paid orders.id; all QR submissions from a consolidated sale retain the same value.';

create or replace function private.app_finalize_qr_table_orders_checked_impl(
  p_table_id uuid,
  p_expected_orders jsonb,
  p_payment_method text,
  p_guide_name text,
  p_team_no text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_table public.qr_tables%rowtype;
  v_paid_order public.orders%rowtype;
  v_payment_choice text := pg_catalog.lower(
    coalesce(nullif(pg_catalog.btrim(p_payment_method), ''), 'cash')
  );
  v_payment_method text;
  v_guide_name text := nullif(pg_catalog.btrim(p_guide_name), '');
  v_team_no text := nullif(pg_catalog.btrim(p_team_no), '');
  v_expected_ids uuid[];
  v_expected_versions timestamp with time zone[];
  v_expected_count integer;
  v_distinct_expected_count integer;
  v_expected_row_count integer;
  v_finalized_count integer;
  v_existing_paid_ids uuid[];
  v_existing_paid_id uuid;
  v_linked_ids uuid[];
  v_choice_matches boolean;
  v_actual_ids uuid[];
  v_actual_versions timestamp with time zone[];
  v_base_usd bigint;
  v_base_vnd bigint;
  v_paid_usd bigint;
  v_paid_vnd bigint;
  v_fee_usd bigint := 0;
  v_fee_vnd bigint := 0;
  v_updated_count integer;
  v_finalized_at timestamp with time zone := now();
begin
  if (select auth.uid()) is null
     or not public.has_app_role(array['staff', 'admin']::text[]) then
    raise exception using errcode = '42501', message = 'staff or admin role required';
  end if;
  if p_table_id is null then
    raise exception using errcode = '22023', message = 'QR table id is required';
  end if;
  if v_payment_choice not in ('cash', 'card', 'card_fee7', 'bank') then
    raise exception using errcode = '22023', message = 'invalid payment method';
  end if;
  v_payment_method := case
    when v_payment_choice = 'card_fee7' then 'card'
    else v_payment_choice
  end;
  if pg_catalog.length(coalesce(p_guide_name, '')) > 200
     or pg_catalog.length(coalesce(p_team_no, '')) > 200 then
    raise exception using errcode = '22023', message = 'order metadata is too long';
  end if;
  if p_expected_orders is null
     or pg_catalog.jsonb_typeof(p_expected_orders) <> 'array'
     or pg_catalog.jsonb_array_length(p_expected_orders) not between 1 and 200 then
    raise exception using
      errcode = '22023',
      message = 'expected QR orders must contain 1 to 200 rows';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_expected_orders) as expected(item)
    where pg_catalog.jsonb_typeof(expected.item) <> 'object'
       or not (expected.item ? 'id')
       or not (expected.item ? 'updated_at')
       or expected.item - 'id' - 'updated_at' <> '{}'::jsonb
       or pg_catalog.jsonb_typeof(expected.item -> 'id') <> 'string'
       or pg_catalog.jsonb_typeof(expected.item -> 'updated_at') <> 'string'
       or coalesce(expected.item ->> 'id', '')
          !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or pg_catalog.length(coalesce(expected.item ->> 'updated_at', '')) not between 20 and 40
  ) then
    raise exception using errcode = '22023', message = 'expected QR order row is invalid';
  end if;

  begin
    select
      pg_catalog.array_agg(
        (expected.item ->> 'id')::uuid
        order by (expected.item ->> 'id')::uuid
      ),
      pg_catalog.array_agg(
        (expected.item ->> 'updated_at')::timestamp with time zone
        order by (expected.item ->> 'id')::uuid
      )
    into v_expected_ids, v_expected_versions
    from pg_catalog.jsonb_array_elements(p_expected_orders) as expected(item);
  exception
    when sqlstate '22P02' or sqlstate '22007' or sqlstate '22008' then
      raise exception using errcode = '22023', message = 'expected QR order row is invalid';
  end;

  select pg_catalog.count(*)::integer,
         pg_catalog.count(distinct expected_id)::integer
  into v_expected_count, v_distinct_expected_count
  from pg_catalog.unnest(v_expected_ids) as expected_id;

  if v_expected_count <> v_distinct_expected_count then
    raise exception using errcode = '22023', message = 'duplicate expected QR orders are not allowed';
  end if;

  -- The table lock conflicts with the guest submit path's FOR SHARE lock. Once
  -- acquired, no new order can slip between the exact-set check and checkout.
  select table_row.*
  into v_table
  from public.qr_tables as table_row
  where table_row.id = p_table_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'QR table not found';
  end if;

  -- Lock every row that can affect this attempt in UUID order. Staff status
  -- changes and edits that already started finish first; later ones wait.
  perform qr_order.id
  from public.qr_orders as qr_order
  where qr_order.table_id = v_table.id
    and (
      qr_order.id = any(v_expected_ids)
      or (
        qr_order.finalized_order_id is null
        and qr_order.status in ('submitted', 'accepted')
      )
    )
  order by qr_order.id
  for update;

  select
    pg_catalog.count(*)::integer,
    pg_catalog.count(*) filter (
      where qr_order.finalized_order_id is not null
    )::integer,
    pg_catalog.array_agg(distinct qr_order.finalized_order_id) filter (
      where qr_order.finalized_order_id is not null
    )
  into v_expected_row_count, v_finalized_count, v_existing_paid_ids
  from public.qr_orders as qr_order
  where qr_order.table_id = v_table.id
    and qr_order.id = any(v_expected_ids);

  if v_expected_row_count <> v_expected_count then
    raise exception using
      errcode = '55000',
      message = 'QR table orders changed after checkout was opened; reload before payment';
  end if;

  -- A network retry carries the pre-checkout timestamps. If the exact same QR
  -- set already points at one live paid sale with identical details, return it
  -- rather than creating a duplicate. New orders placed after that sale do not
  -- change the meaning of this already-completed request.
  if v_finalized_count = v_expected_count then
    if pg_catalog.cardinality(v_existing_paid_ids) <> 1 then
      raise exception using
        errcode = '55000',
        message = 'expected QR orders were finalized into different paid orders';
    end if;

    v_existing_paid_id := v_existing_paid_ids[1];

    perform qr_order.id
    from public.qr_orders as qr_order
    where qr_order.finalized_order_id = v_existing_paid_id
    order by qr_order.id
    for update;

    select pg_catalog.array_agg(qr_order.id order by qr_order.id)
    into v_linked_ids
    from public.qr_orders as qr_order
    where qr_order.finalized_order_id = v_existing_paid_id;

    if v_linked_ids is distinct from v_expected_ids then
      raise exception using
        errcode = '55000',
        message = 'paid order QR set does not match this checkout request';
    end if;

    select pg_catalog.bool_and(
      qr_order.finalized_payment_choice is not distinct from v_payment_choice
    )
    into v_choice_matches
    from public.qr_orders as qr_order
    where qr_order.id = any(v_expected_ids);

    select paid_order.*
    into v_paid_order
    from public.orders as paid_order
    where paid_order.id = v_existing_paid_id;

    if not found then
      raise exception using
        errcode = '55000',
        message = 'finalized QR orders reference a missing paid order';
    end if;
    if v_choice_matches is distinct from true
       or pg_catalog.lower(v_paid_order.payment_method) is distinct from v_payment_method
       or v_paid_order.guide_name is distinct from v_guide_name
       or v_paid_order.team_no is distinct from v_team_no then
      raise exception using
        errcode = '55000',
        message = 'QR table was already finalized with different payment details';
    end if;

    return v_existing_paid_id;
  elsif v_finalized_count <> 0 then
    raise exception using
      errcode = '55000',
      message = 'some QR table orders were already finalized; reload before payment';
  end if;

  if exists (
    select 1
    from public.qr_orders as qr_order
    where qr_order.table_id = v_table.id
      and qr_order.status = 'submitted'
      and qr_order.finalized_order_id is null
  ) then
    raise exception using
      errcode = '55000',
      message = 'unconfirmed QR orders remain for this table';
  end if;

  select
    pg_catalog.array_agg(qr_order.id order by qr_order.id),
    pg_catalog.array_agg(qr_order.updated_at order by qr_order.id)
  into v_actual_ids, v_actual_versions
  from public.qr_orders as qr_order
  where qr_order.table_id = v_table.id
    and qr_order.status = 'accepted'
    and qr_order.finalized_order_id is null;

  if v_actual_ids is distinct from v_expected_ids
     or v_actual_versions is distinct from v_expected_versions then
    raise exception using
      errcode = '55000',
      message = 'QR table orders changed after checkout was opened; reload before payment';
  end if;

  -- Validate every order total against its immutable item snapshots before
  -- using the stored order totals as the table subtotal.
  if exists (
    select 1
    from public.qr_orders as qr_order
    cross join lateral (
      select
        pg_catalog.count(*)::integer as line_count,
        coalesce(pg_catalog.sum(item.line_usd::bigint), 0) as total_usd,
        coalesce(pg_catalog.sum(item.line_vnd::bigint), 0) as total_vnd
      from public.qr_order_items as item
      where item.qr_order_id = qr_order.id
    ) as snapshot
    where qr_order.id = any(v_expected_ids)
      and (
        snapshot.line_count = 0
        or snapshot.total_usd <> qr_order.total_usd::bigint
        or snapshot.total_vnd <> qr_order.total_vnd::bigint
      )
  ) then
    raise exception using
      errcode = '55000',
      message = 'QR order total does not match its item snapshots';
  end if;

  select
    coalesce(pg_catalog.sum(qr_order.total_usd::bigint), 0),
    coalesce(pg_catalog.sum(qr_order.total_vnd::bigint), 0)
  into v_base_usd, v_base_vnd
  from public.qr_orders as qr_order
  where qr_order.id = any(v_expected_ids);

  v_paid_usd := v_base_usd;
  v_paid_vnd := v_base_vnd;
  if v_payment_choice = 'card_fee7' then
    -- Match calc.html on the combined table subtotal: USD rounds to one dollar
    -- and VND rounds to the nearest 1,000 after applying 7% once.
    v_paid_usd := pg_catalog.round(v_base_usd::numeric * 1.07)::bigint;
    v_paid_vnd := (
      pg_catalog.round((v_base_vnd::numeric * 1.07) / 1000) * 1000
    )::bigint;
    v_fee_usd := v_paid_usd - v_base_usd;
    v_fee_vnd := v_paid_vnd - v_base_vnd;
  end if;

  if v_paid_usd > 2147483647 or v_paid_vnd > 2147483647 then
    raise exception using errcode = '22003', message = 'paid order total is out of range';
  end if;

  perform pg_catalog.set_config('app.rpc_write', 'on', true);

  insert into public.orders (
    created_at,
    source,
    status,
    total_usd,
    total_vnd,
    guide_name,
    team_no,
    payment_method,
    sales_excluded
  )
  values (
    v_finalized_at,
    'qr_table',
    'paid',
    0,
    0,
    v_guide_name,
    v_team_no,
    v_payment_method,
    false
  )
  returning * into v_paid_order;

  -- Keep each guest-facing name and unit price as ordered. A later menu edit
  -- cannot rewrite a paid sale, and line order remains deterministic.
  insert into public.order_custom_items (
    order_id,
    kind,
    ko_name,
    vi_name,
    qty,
    unit_usd,
    unit_vnd,
    line_usd,
    line_vnd
  )
  select
    v_paid_order.id,
    item.menu_type,
    item.ko_name,
    item.vi_name,
    item.qty,
    item.unit_usd,
    item.unit_vnd,
    item.line_usd,
    item.line_vnd
  from public.qr_orders as qr_order
  join public.qr_order_items as item on item.qr_order_id = qr_order.id
  where qr_order.id = any(v_expected_ids)
  order by qr_order.submitted_at, qr_order.id, item.created_at, item.id;

  if v_payment_choice = 'card_fee7' then
    insert into public.order_custom_items (
      order_id,
      kind,
      ko_name,
      vi_name,
      qty,
      unit_usd,
      unit_vnd,
      line_usd,
      line_vnd
    )
    values (
      v_paid_order.id,
      'fee7',
      'Service fee 7%',
      'Phí dịch vụ 7%',
      1,
      v_fee_usd::integer,
      v_fee_vnd::integer,
      v_fee_usd::integer,
      v_fee_vnd::integer
    );
  end if;

  select paid_order.*
  into v_paid_order
  from public.orders as paid_order
  where paid_order.id = v_paid_order.id;

  if v_paid_order.total_usd::bigint <> v_paid_usd
     or v_paid_order.total_vnd::bigint <> v_paid_vnd then
    raise exception using errcode = '55000', message = 'paid order total verification failed';
  end if;

  update public.qr_orders as qr_order
  set finalized_at = v_finalized_at,
      finalized_order_id = v_paid_order.id,
      finalized_payment_choice = v_payment_choice,
      updated_at = v_finalized_at
  where qr_order.id = any(v_expected_ids)
    and qr_order.table_id = v_table.id
    and qr_order.status = 'accepted'
    and qr_order.finalized_order_id is null;

  get diagnostics v_updated_count = row_count;
  if v_updated_count <> v_expected_count then
    raise exception using
      errcode = '55000',
      message = 'QR table orders changed while payment was being finalized';
  end if;

  perform pg_catalog.set_config('app.rpc_write', 'off', true);
  return v_paid_order.id;
end;
$$;

create or replace function public.app_finalize_qr_table_orders_checked(
  p_table_id uuid,
  p_expected_orders jsonb,
  p_payment_method text,
  p_guide_name text default null,
  p_team_no text default null
)
returns uuid
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.app_finalize_qr_table_orders_checked_impl(
    p_table_id,
    p_expected_orders,
    p_payment_method,
    p_guide_name,
    p_team_no
  )
$$;

-- The paid-order delete path must clear every QR source row before the
-- restrictive FK permits deleting their shared paid order.
create or replace function private.app_delete_order_impl(p_order_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order_id uuid;
  v_deleted_id uuid;
  v_voided_at timestamp with time zone := now();
begin
  if (select auth.uid()) is null
     or not public.has_app_role(array['admin']::text[]) then
    raise exception using errcode = '42501', message = 'admin role required';
  end if;
  if p_order_id is null then
    raise exception using errcode = '22023', message = 'order id is required';
  end if;

  select paid_order.id
  into v_order_id
  from public.orders as paid_order
  where paid_order.id = p_order_id
  for update;

  if not found then
    return false;
  end if;

  if exists (
    select 1
    from public.resv_groups as reservation
    where reservation.confirmed_order_id = v_order_id
  ) then
    raise exception using
      errcode = '23503',
      message = 'unconfirm the reservation before deleting its order';
  end if;

  perform qr_order.id
  from public.qr_orders as qr_order
  where qr_order.finalized_order_id = v_order_id
  order by qr_order.id
  for update;

  perform pg_catalog.set_config('app.rpc_write', 'on', true);

  update public.qr_orders as qr_order
  set status = 'cancelled',
      cancelled_at = v_voided_at,
      voided_order_id = v_order_id,
      voided_at = v_voided_at,
      finalized_order_id = null,
      finalized_at = null,
      updated_at = v_voided_at
  where qr_order.finalized_order_id = v_order_id;

  delete from public.orders as paid_order
  where paid_order.id = v_order_id
  returning paid_order.id into v_deleted_id;

  perform pg_catalog.set_config('app.rpc_write', 'off', true);
  return v_deleted_id is not null;
end;
$$;

revoke execute on function private.app_finalize_qr_table_orders_checked_impl(uuid, jsonb, text, text, text)
  from public, anon, authenticated, service_role;
revoke execute on function public.app_finalize_qr_table_orders_checked(uuid, jsonb, text, text, text)
  from public, anon, authenticated, service_role;
revoke execute on function private.app_delete_order_impl(uuid)
  from public, anon, authenticated, service_role;

grant execute on function private.app_finalize_qr_table_orders_checked_impl(uuid, jsonb, text, text, text)
  to authenticated;
grant execute on function public.app_finalize_qr_table_orders_checked(uuid, jsonb, text, text, text)
  to authenticated;
grant execute on function private.app_delete_order_impl(uuid)
  to authenticated;

comment on function public.app_finalize_qr_table_orders_checked(uuid, jsonb, text, text, text) is
  'Staff/admin table checkout. Requires the exact accepted/unpaid QR order id and updated_at set, creates one paid sale, and applies calc-compatible card_fee7 rounding once to the combined subtotal.';

comment on function private.app_delete_order_impl(uuid) is
  'Admin-only paid-order deletion core. Preserves every contributing QR source and item snapshot as a void tombstone, including consolidated table sales.';

comment on function public.app_delete_order(uuid) is
  'Admin-only paid-order deletion. Preserves all finalized QR source rows and item snapshots, including consolidated table sales, as cancelled audit records.';

comment on table public.qr_orders is
  'Guest QR order queue; accepted rows enter the paid ledger as one sale per table through app_finalize_qr_table_orders_checked.';

