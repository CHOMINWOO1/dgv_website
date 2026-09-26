-- Give staff and administrators the same narrowly scoped QR inbox actions.
--
-- This migration adds nullable schema metadata and changes RPC definitions and
-- privileges. It does not UPDATE or DELETE existing QR orders, paid orders, or
-- order items.

-- Persist the checkout choice on new finalizations. Existing finalized rows
-- deliberately remain NULL and use the strict legacy fallback below, so this
-- schema addition never rewrites historical business data.
alter table public.qr_orders
  add column if not exists finalized_payment_choice text;

alter table public.qr_orders
  add constraint qr_orders_finalized_payment_choice_check
  check (
    finalized_payment_choice is null
    or finalized_payment_choice in ('cash', 'card', 'card_fee7', 'bank')
  ) not valid;

alter table public.qr_orders
  validate constraint qr_orders_finalized_payment_choice_check;

create or replace function private.app_update_qr_order_status_impl(
  p_order_id uuid,
  p_status text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text := public.current_app_role();
  v_target text := pg_catalog.lower(pg_catalog.btrim(p_status));
  v_order public.qr_orders%rowtype;
  v_allowed boolean := false;
begin
  if (select auth.uid()) is null
     or v_role is null
     or v_role not in ('staff', 'admin') then
    raise exception using errcode = '42501', message = 'staff or admin role required';
  end if;
  if p_order_id is null
     or v_target is null
     or v_target not in ('accepted', 'cancelled') then
    raise exception using errcode = '22023', message = 'invalid order status';
  end if;

  select * into v_order
  from public.qr_orders
  where id = p_order_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'QR order not found';
  end if;

  if v_order.status = v_target then
    return (pg_catalog.to_jsonb(v_order) - 'request_hash')
      || pg_catalog.jsonb_build_object('idempotent', true);
  end if;
  if v_order.finalized_order_id is not null then
    raise exception using errcode = '55000', message = 'finalized QR order cannot change status';
  end if;

  v_allowed :=
    (v_order.status = 'submitted' and v_target = 'accepted')
    or (
      v_order.status in ('submitted', 'accepted')
      and v_target = 'cancelled'
    );

  if not v_allowed then
    raise exception using errcode = '22023', message = 'invalid QR order status transition';
  end if;

  update public.qr_orders
  set status = v_target,
      updated_at = now(),
      accepted_at = case when v_target = 'accepted' then now() else accepted_at end,
      cancelled_at = case when v_target = 'cancelled' then now() else cancelled_at end
  where id = p_order_id
  returning * into v_order;

  return (pg_catalog.to_jsonb(v_order) - 'request_hash')
    || pg_catalog.jsonb_build_object('idempotent', false);
end;
$$;

create or replace function private.app_finalize_qr_order_checked_impl(
  p_qr_order_id uuid,
  p_expected_updated_at timestamp with time zone,
  p_payment_method text,
  p_guide_name text,
  p_team_no text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_qr_order public.qr_orders%rowtype;
  v_paid_order public.orders%rowtype;
  v_payment_choice text := pg_catalog.lower(
    coalesce(nullif(pg_catalog.btrim(p_payment_method), ''), 'cash')
  );
  v_payment_method text;
  v_guide_name text := nullif(pg_catalog.btrim(p_guide_name), '');
  v_team_no text := nullif(pg_catalog.btrim(p_team_no), '');
  v_existing_choice text;
  v_line_count integer;
  v_base_usd bigint;
  v_base_vnd bigint;
  v_paid_usd bigint;
  v_paid_vnd bigint;
  v_fee_usd bigint := 0;
  v_fee_vnd bigint := 0;
begin
  if (select auth.uid()) is null
     or not public.has_app_role(array['staff', 'admin']::text[]) then
    raise exception using errcode = '42501', message = 'staff or admin role required';
  end if;
  if p_qr_order_id is null then
    raise exception using errcode = '22023', message = 'QR order id is required';
  end if;
  if v_payment_choice not in ('cash', 'card', 'card_fee7', 'bank') then
    raise exception using errcode = '22023', message = 'invalid payment method';
  end if;
  -- card_fee7 is an RPC-only choice. Keep the existing ledger convention by
  -- storing both card modes as payment_method = 'card'. Legacy callers that
  -- already send 'card' continue to receive the original no-fee behavior.
  v_payment_method := case
    when v_payment_choice = 'card_fee7' then 'card'
    else v_payment_choice
  end;
  if pg_catalog.length(coalesce(p_guide_name, '')) > 200
     or pg_catalog.length(coalesce(p_team_no, '')) > 200 then
    raise exception using errcode = '22023', message = 'order metadata is too long';
  end if;

  select * into v_qr_order
  from public.qr_orders
  where id = p_qr_order_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'QR order not found';
  end if;
  if v_qr_order.finalized_order_id is not null then
    select * into v_paid_order
    from public.orders
    where id = v_qr_order.finalized_order_id;

    if not found then
      raise exception using errcode = '55000', message = 'finalized QR order references a missing paid order';
    end if;

    v_existing_choice := v_qr_order.finalized_payment_choice;
    if v_existing_choice is null then
      -- Legacy rows predate finalized_payment_choice. Only recognize the exact
      -- generated service-fee marker; a menu whose type happens to be `fee7`
      -- must not be mistaken for a surcharge.
      v_existing_choice := case
        when pg_catalog.lower(v_paid_order.payment_method) = 'card'
         and exists (
           select 1
           from public.order_custom_items as paid_item
           where paid_item.order_id = v_paid_order.id
             and paid_item.kind = 'fee7'
             and paid_item.ko_name = 'Service fee 7%'
             and paid_item.vi_name = 'Phí dịch vụ 7%'
             and paid_item.qty = 1
             and paid_item.unit_usd = paid_item.line_usd
             and paid_item.unit_vnd = paid_item.line_vnd
             and paid_item.line_usd::bigint =
               v_paid_order.total_usd::bigint - v_qr_order.total_usd::bigint
             and paid_item.line_vnd::bigint =
               v_paid_order.total_vnd::bigint - v_qr_order.total_vnd::bigint
         ) then 'card_fee7'
        else pg_catalog.lower(v_paid_order.payment_method)
      end;
    end if;

    if v_existing_choice is distinct from v_payment_choice
       or v_paid_order.guide_name is distinct from v_guide_name
       or v_paid_order.team_no is distinct from v_team_no then
      raise exception using
        errcode = '55000',
        message = 'QR order was already finalized with different payment details';
    end if;

    return v_qr_order.finalized_order_id;
  end if;
  if v_qr_order.updated_at is distinct from p_expected_updated_at then
    raise exception using
      errcode = '55000',
      message = 'QR order changed after checkout was opened; reload before payment';
  end if;
  if v_qr_order.status <> 'accepted' then
    raise exception using errcode = '22023', message = 'only accepted QR orders can be finalized';
  end if;

  -- Recalculate from the immutable QR item snapshots and compare against the
  -- stored submission total before writing the paid ledger row.
  select
    pg_catalog.count(*)::integer,
    coalesce(pg_catalog.sum(i.line_usd::bigint), 0),
    coalesce(pg_catalog.sum(i.line_vnd::bigint), 0)
  into v_line_count, v_base_usd, v_base_vnd
  from public.qr_order_items as i
  where i.qr_order_id = v_qr_order.id;

  if v_line_count = 0 then
    raise exception using errcode = '22023', message = 'QR order has no items';
  end if;
  if v_base_usd <> v_qr_order.total_usd::bigint
     or v_base_vnd <> v_qr_order.total_vnd::bigint then
    raise exception using errcode = '55000', message = 'QR order total does not match its item snapshots';
  end if;

  v_paid_usd := v_base_usd;
  v_paid_vnd := v_base_vnd;
  if v_payment_choice = 'card_fee7' then
    -- Match calc.html exactly: USD rounds to an integer and VND rounds to the
    -- nearest 1,000 after applying the 7% service fee.
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
    now(),
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

  -- QR rows are copied as custom paid-order rows so later menu edits cannot
  -- rewrite the name or price that the guest actually ordered.
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
    i.menu_type,
    i.ko_name,
    i.vi_name,
    i.qty,
    i.unit_usd,
    i.unit_vnd,
    i.line_usd,
    i.line_vnd
  from public.qr_order_items as i
  where i.qr_order_id = v_qr_order.id
  order by i.created_at, i.id;

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

  select * into v_paid_order
  from public.orders
  where id = v_paid_order.id;

  if v_paid_order.total_usd::bigint <> v_paid_usd
     or v_paid_order.total_vnd::bigint <> v_paid_vnd then
    raise exception using errcode = '55000', message = 'paid order total verification failed';
  end if;

  update public.qr_orders
  set finalized_at = now(),
      finalized_order_id = v_paid_order.id,
      finalized_payment_choice = v_payment_choice,
      updated_at = now()
  where id = v_qr_order.id;

  perform pg_catalog.set_config('app.rpc_write', 'off', true);
  return v_paid_order.id;
end;
$$;

-- New clients send the row version captured when the checkout modal opened.
-- A distinct RPC name avoids PostgREST overload ambiguity and lets the legacy
-- four-argument endpoint remain callable during the DB-first deployment phase.
create or replace function public.app_finalize_qr_order_checked(
  p_qr_order_id uuid,
  p_expected_updated_at timestamp with time zone,
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
  select private.app_finalize_qr_order_checked_impl(
    p_qr_order_id,
    p_expected_updated_at,
    p_payment_method,
    p_guide_name,
    p_team_no
  )
$$;

-- Transitional compatibility for the already-deployed four-argument web
-- client. It captures the latest row version immediately before entering the
-- checked core; the post-deploy migration revokes this endpoint after the new
-- GitHub Pages JavaScript has been verified live.
create or replace function private.app_finalize_qr_order_impl(
  p_qr_order_id uuid,
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
  v_expected_updated_at timestamp with time zone;
begin
  if (select auth.uid()) is null
     or not public.has_app_role(array['staff', 'admin']::text[]) then
    raise exception using errcode = '42501', message = 'staff or admin role required';
  end if;

  select qr_order.updated_at
  into v_expected_updated_at
  from public.qr_orders as qr_order
  where qr_order.id = p_qr_order_id;

  return private.app_finalize_qr_order_checked_impl(
    p_qr_order_id,
    v_expected_updated_at,
    p_payment_method,
    p_guide_name,
    p_team_no
  );
end;
$$;

-- Reassert the DB-first deployment ACL. The checked RPC is available to the
-- new client while the legacy grants remain only until the post-deploy cutover.
revoke execute on function private.app_update_qr_order_status_impl(uuid, text)
  from public, anon, service_role;
revoke execute on function private.app_finalize_qr_order_checked_impl(uuid, timestamp with time zone, text, text, text)
  from public, anon, service_role;
grant execute on function private.app_update_qr_order_status_impl(uuid, text)
  to authenticated;
grant execute on function private.app_finalize_qr_order_checked_impl(uuid, timestamp with time zone, text, text, text)
  to authenticated;

revoke execute on function public.app_update_qr_order_status(uuid, text)
  from public, anon, service_role;
revoke execute on function public.app_finalize_qr_order_checked(uuid, timestamp with time zone, text, text, text)
  from public, anon, service_role;
grant execute on function public.app_update_qr_order_status(uuid, text)
  to authenticated;
grant execute on function public.app_finalize_qr_order_checked(uuid, timestamp with time zone, text, text, text)
  to authenticated;

-- Keep the legacy ACL only for the short DB-first compatibility window.
revoke execute on function private.app_finalize_qr_order_impl(uuid, text, text, text)
  from public, anon, service_role;
revoke execute on function public.app_finalize_qr_order(uuid, text, text, text)
  from public, anon, service_role;
grant execute on function private.app_finalize_qr_order_impl(uuid, text, text, text)
  to authenticated;
grant execute on function public.app_finalize_qr_order(uuid, text, text, text)
  to authenticated;

comment on function public.app_finalize_qr_order_checked(uuid, timestamp with time zone, text, text, text) is
  'Staff/admin QR checkout. card_fee7 appends the calc-compatible fee7 line; legacy card remains fee-free.';

comment on function public.app_finalize_qr_order(uuid, text, text, text) is
  'Temporary legacy QR checkout endpoint. Revoke after the checked GitHub Pages client is deployed.';
