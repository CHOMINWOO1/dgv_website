-- Allow staff and administrators to correct an open QR order without exposing
-- direct table writes. This migration only creates functions and privileges;
-- it does not update, delete, or rewrite any existing rows when applied.

set lock_timeout = '5s';

create function private.app_update_qr_order_impl(
  p_order_id uuid,
  p_expected_updated_at timestamp with time zone,
  p_note text,
  p_items jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_role text := public.current_app_role();
  v_order public.qr_orders%rowtype;
  v_note text := nullif(pg_catalog.btrim(p_note), '');
  v_lines jsonb;
  v_line_count integer;
  v_total_qty bigint;
  v_total_usd bigint;
  v_total_vnd bigint;
begin
  if (select auth.uid()) is null
     or v_role is null
     or v_role not in ('staff', 'admin') then
    raise exception using
      errcode = '42501',
      message = 'staff or admin role required';
  end if;

  if p_order_id is null then
    raise exception using errcode = '22023', message = 'QR order id is required';
  end if;
  if p_expected_updated_at is null then
    raise exception using
      errcode = '22023',
      message = 'expected QR order version is required';
  end if;
  if p_note is not null
     and (
       pg_catalog.length(p_note) > 500
       or p_note ~ '[[:cntrl:]]'
     ) then
    raise exception using errcode = '22023', message = 'order note is invalid';
  end if;
  if p_items is null
     or pg_catalog.jsonb_typeof(p_items) <> 'array'
     or pg_catalog.jsonb_array_length(p_items) not between 1 and 40 then
    raise exception using
      errcode = '22023',
      message = 'order must contain 1 to 40 lines';
  end if;

  -- Accept only {menu_item_id, qty}. Requiring the JSON types as well as the
  -- textual formats prevents strings, decimals, booleans, or extra fields
  -- from being silently coerced by PostgreSQL.
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_items) as entry(item)
    where pg_catalog.jsonb_typeof(entry.item) <> 'object'
       or entry.item - 'menu_item_id' - 'qty' <> '{}'::jsonb
       or pg_catalog.jsonb_typeof(entry.item -> 'menu_item_id') <> 'string'
       or pg_catalog.jsonb_typeof(entry.item -> 'qty') <> 'number'
       or coalesce(entry.item ->> 'menu_item_id', '')
          !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or coalesce(entry.item ->> 'qty', '') !~ '^[1-9][0-9]*$'
       or case
         when coalesce(entry.item ->> 'qty', '') ~ '^[1-9][0-9]*$'
           then (entry.item ->> 'qty')::numeric > 20
         else false
       end
  ) then
    raise exception using errcode = '22023', message = 'order contains an invalid line';
  end if;

  if (
    select pg_catalog.count(distinct (entry.item ->> 'menu_item_id')::uuid)
    from pg_catalog.jsonb_array_elements(p_items) as entry(item)
  ) <> pg_catalog.jsonb_array_length(p_items) then
    raise exception using
      errcode = '22023',
      message = 'duplicate menu items are not allowed';
  end if;

  select qr_order.*
  into v_order
  from public.qr_orders as qr_order
  where qr_order.id = p_order_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'QR order not found';
  end if;
  if v_order.updated_at is distinct from p_expected_updated_at then
    raise exception using
      errcode = '55000',
      message = 'QR order changed after this edit screen was opened';
  end if;
  if v_order.status not in ('submitted', 'accepted')
     or v_order.finalized_order_id is not null then
    raise exception using
      errcode = '55000',
      message = 'only open, unfinalized QR orders can be edited';
  end if;

  select coalesce(pg_catalog.sum((entry.item ->> 'qty')::bigint), 0)
  into v_total_qty
  from pg_catalog.jsonb_array_elements(p_items) as entry(item);

  if v_total_qty > 100 then
    raise exception using
      errcode = '22023',
      message = 'order quantity is too large';
  end if;

  -- Lock every referenced menu row in a deterministic order. Existing order
  -- lines use their immutable captured price/name even if that menu was later
  -- archived; only newly added lines use the current menu row below.
  perform menu.id
  from public.menu_items as menu
  join pg_catalog.jsonb_array_elements(p_items) as entry(item)
    on menu.id = (entry.item ->> 'menu_item_id')::uuid
  order by menu.id
  for share of menu;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_items) as entry(item)
    left join public.qr_order_items as old_line
      on old_line.qr_order_id = v_order.id
     and old_line.menu_item_id = (entry.item ->> 'menu_item_id')::uuid
    left join public.menu_items as menu
      on menu.id = (entry.item ->> 'menu_item_id')::uuid
    where old_line.id is null
      and (
        menu.id is null
        or menu.archived_at is not null
        or menu.is_active is distinct from true
        or menu.is_orderable is distinct from true
        or menu.is_sold_out is distinct from false
        or menu.requires_preorder is distinct from false
        or menu.price_usd is null
        or menu.price_vnd is null
        or menu.price_usd < 0
        or menu.price_vnd < 0
        or pg_catalog.length(pg_catalog.btrim(coalesce(menu.type, ''))) = 0
        or pg_catalog.length(pg_catalog.btrim(coalesce(menu.ko_name, ''))) = 0
      )
  ) then
    raise exception using
      errcode = '22023',
      message = 'order contains an unavailable menu item';
  end if;

  with requested as (
    select
      (entry.item ->> 'menu_item_id')::uuid as menu_item_id,
      (entry.item ->> 'qty')::integer as qty,
      entry.ordinality
    from pg_catalog.jsonb_array_elements(p_items)
      with ordinality as entry(item, ordinality)
  ), snapshots as (
    select
      requested.menu_item_id,
      requested.qty,
      case when old_line.id is not null then old_line.menu_type else menu.type end as menu_type,
      case when old_line.id is not null then old_line.ko_name else menu.ko_name end as ko_name,
      case when old_line.id is not null then old_line.vi_name else menu.vi_name end as vi_name,
      case when old_line.id is not null then old_line.en_name else menu.en_name end as en_name,
      case when old_line.id is not null then old_line.unit_usd else menu.price_usd end as unit_usd,
      case when old_line.id is not null then old_line.unit_vnd else menu.price_vnd end as unit_vnd,
      case when old_line.id is not null then old_line.created_at else now() end as created_at,
      requested.ordinality
    from requested
    left join public.qr_order_items as old_line
      on old_line.qr_order_id = v_order.id
     and old_line.menu_item_id = requested.menu_item_id
    left join public.menu_items as menu
      on menu.id = requested.menu_item_id
  )
  select
    coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'menu_item_id', snapshots.menu_item_id,
          'qty', snapshots.qty,
          'menu_type', snapshots.menu_type,
          'ko_name', snapshots.ko_name,
          'vi_name', snapshots.vi_name,
          'en_name', snapshots.en_name,
          'unit_usd', snapshots.unit_usd,
          'unit_vnd', snapshots.unit_vnd,
          'line_usd', snapshots.qty::bigint * snapshots.unit_usd::bigint,
          'line_vnd', snapshots.qty::bigint * snapshots.unit_vnd::bigint,
          'created_at', snapshots.created_at
        ) order by snapshots.ordinality
      ),
      '[]'::jsonb
    ),
    pg_catalog.count(*)::integer,
    coalesce(pg_catalog.sum(snapshots.qty::bigint * snapshots.unit_usd::bigint), 0),
    coalesce(pg_catalog.sum(snapshots.qty::bigint * snapshots.unit_vnd::bigint), 0)
  into v_lines, v_line_count, v_total_usd, v_total_vnd
  from snapshots;

  if v_line_count <> pg_catalog.jsonb_array_length(p_items)
     or v_total_usd > 2147483647
     or v_total_vnd > 2147483647 then
    raise exception using
      errcode = '22023',
      message = 'order total is too large';
  end if;

  delete from public.qr_order_items as old_line
  where old_line.qr_order_id = v_order.id;

  insert into public.qr_order_items (
    qr_order_id,
    menu_item_id,
    qty,
    menu_type,
    ko_name,
    vi_name,
    en_name,
    unit_usd,
    unit_vnd,
    line_usd,
    line_vnd,
    created_at
  )
  select
    v_order.id,
    line.menu_item_id,
    line.qty,
    line.menu_type,
    line.ko_name,
    line.vi_name,
    line.en_name,
    line.unit_usd,
    line.unit_vnd,
    line.line_usd,
    line.line_vnd,
    line.created_at
  from pg_catalog.jsonb_to_recordset(v_lines) as line(
    menu_item_id uuid,
    qty integer,
    menu_type text,
    ko_name text,
    vi_name text,
    en_name text,
    unit_usd integer,
    unit_vnd integer,
    line_usd integer,
    line_vnd integer,
    created_at timestamp with time zone
  );

  update public.qr_orders as qr_order
  set
    note = v_note,
    total_usd = v_total_usd::integer,
    total_vnd = v_total_vnd::integer,
    updated_at = now()
  where qr_order.id = v_order.id
  returning qr_order.* into v_order;

  return (pg_catalog.to_jsonb(v_order) - 'request_hash')
    || pg_catalog.jsonb_build_object('line_count', v_line_count);
end;
$$;

create function public.app_update_qr_order(
  p_order_id uuid,
  p_expected_updated_at timestamp with time zone,
  p_note text,
  p_items jsonb
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.app_update_qr_order_impl(
    p_order_id,
    p_expected_updated_at,
    p_note,
    p_items
  )
$$;

-- Staff do not have broad SELECT access to the paid orders ledger. Expose only
-- the final totals for QR orders they can already see so a card_fee7 checkout
-- is not displayed as the pre-fee QR total in the inbox history.
create function private.app_get_qr_paid_totals_impl(p_qr_order_ids uuid[])
returns table (
  qr_order_id uuid,
  total_usd integer,
  total_vnd integer,
  payment_method text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null
     or not public.has_app_role(array['staff', 'admin']::text[]) then
    raise exception using
      errcode = '42501',
      message = 'staff or admin role required';
  end if;
  if p_qr_order_ids is null
     or pg_catalog.cardinality(p_qr_order_ids) > 200 then
    raise exception using
      errcode = '22023',
      message = 'QR order id list is invalid';
  end if;

  return query
  select
    qr_order.id,
    paid_order.total_usd,
    paid_order.total_vnd,
    case
      when qr_order.finalized_payment_choice is not null
        then qr_order.finalized_payment_choice
      -- Legacy finalized rows predate finalized_payment_choice. Recognize only
      -- the exact generated fee marker whose amounts reconcile the QR base and
      -- paid totals; a real menu row named/type'd fee7 must not be mistaken for
      -- the service fee.
      when pg_catalog.lower(paid_order.payment_method) = 'card'
       and exists (
         select 1
         from public.order_custom_items as paid_line
         where paid_line.order_id = paid_order.id
           and paid_line.kind = 'fee7'
           and paid_line.ko_name = 'Service fee 7%'
           and paid_line.vi_name = 'Phí dịch vụ 7%'
           and paid_line.qty = 1
           and paid_line.unit_usd = paid_line.line_usd
           and paid_line.unit_vnd = paid_line.line_vnd
           and paid_line.line_usd::bigint =
             paid_order.total_usd::bigint - qr_order.total_usd::bigint
           and paid_line.line_vnd::bigint =
             paid_order.total_vnd::bigint - qr_order.total_vnd::bigint
       ) then 'card_fee7'
      else pg_catalog.lower(paid_order.payment_method)
    end
  from (
    select distinct requested.qr_order_id
    from pg_catalog.unnest(p_qr_order_ids) as requested(qr_order_id)
  ) as requested
  join public.qr_orders as qr_order
    on qr_order.id = requested.qr_order_id
  join public.orders as paid_order
    on paid_order.id = qr_order.finalized_order_id;
end;
$$;

create function public.app_get_qr_paid_totals(p_qr_order_ids uuid[])
returns table (
  qr_order_id uuid,
  total_usd integer,
  total_vnd integer,
  payment_method text
)
language sql
stable
security invoker
set search_path = ''
as $$
  select *
  from private.app_get_qr_paid_totals_impl(p_qr_order_ids)
$$;

revoke execute on function private.app_update_qr_order_impl(uuid, timestamp with time zone, text, jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function public.app_update_qr_order(uuid, timestamp with time zone, text, jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function private.app_get_qr_paid_totals_impl(uuid[])
  from public, anon, authenticated, service_role;
revoke execute on function public.app_get_qr_paid_totals(uuid[])
  from public, anon, authenticated, service_role;

grant execute on function private.app_update_qr_order_impl(uuid, timestamp with time zone, text, jsonb)
  to authenticated;
grant execute on function public.app_update_qr_order(uuid, timestamp with time zone, text, jsonb)
  to authenticated;
grant execute on function private.app_get_qr_paid_totals_impl(uuid[])
  to authenticated;
grant execute on function public.app_get_qr_paid_totals(uuid[])
  to authenticated;

comment on function public.app_update_qr_order(uuid, timestamp with time zone, text, jsonb) is
  'Staff/admin edit for open QR orders. Existing line snapshots and idempotency identity are preserved; newly added lines use current server prices.';
comment on function public.app_get_qr_paid_totals(uuid[]) is
  'Staff/admin QR-only paid-total lookup used by inbox history; it does not expose unrelated paid orders.';
