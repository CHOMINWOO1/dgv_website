-- Keep employee reservation/menu reads unchanged while making all order and
-- sales data admin-only. Also keep confirmed reservations and their generated
-- orders synchronized through the supported RPC surface.
--
-- This migration contains DDL and function definitions only. It does not
-- update, delete, or insert application data when the migration is applied.

drop policy if exists orders_staff_read on public.orders;
drop policy if exists orders_admin_read on public.orders;

create policy orders_admin_read
on public.orders
for select
to authenticated
using ((select public.has_app_role(array['admin']::text[])));

drop policy if exists order_items_staff_read on public.order_items;
drop policy if exists order_items_admin_read on public.order_items;

create policy order_items_admin_read
on public.order_items
for select
to authenticated
using ((select public.has_app_role(array['admin']::text[])));

drop policy if exists order_custom_items_staff_read on public.order_custom_items;
drop policy if exists order_custom_items_admin_read on public.order_custom_items;

create policy order_custom_items_admin_read
on public.order_custom_items
for select
to authenticated
using ((select public.has_app_role(array['admin']::text[])));

create or replace function public.app_update_order(
  p_order_id uuid,
  p_status text,
  p_guide_name text,
  p_team_no text,
  p_payment_method text,
  p_items jsonb
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_total_usd bigint := 0;
  v_total_vnd bigint := 0;
  v_payment_method text;
  v_source text;
begin
  if not public.has_app_role(array['admin']::text[]) then
    raise exception using errcode = '42501', message = 'admin role required';
  end if;

  if p_order_id is null then
    raise exception using errcode = '22023', message = 'p_order_id is required';
  end if;

  select o.source
  into v_source
  from public.orders as o
  where o.id = p_order_id
  for update;

  if not found then
    return false;
  end if;

  if v_source = 'reservation_confirm'
     or exists (
       select 1
       from public.resv_groups as r
       where r.confirmed_order_id = p_order_id
     ) then
    raise exception using
      errcode = '23514',
      message = 'reservation-confirmed orders must be edited through app_update_reservation';
  end if;

  if p_items is null
     or pg_catalog.jsonb_typeof(p_items) <> 'array'
     or pg_catalog.jsonb_array_length(p_items) = 0
     or pg_catalog.jsonb_array_length(p_items) > 250 then
    raise exception using errcode = '22023', message = 'p_items must contain 1 to 250 items';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_items) as e(item)
    where pg_catalog.jsonb_typeof(e.item) <> 'object'
       or coalesce(e.item ->> 'item_type', '') not in ('menu', 'custom')
       or coalesce(e.item ->> 'qty', '') !~ '^[1-9][0-9]*$'
       or (
         e.item ->> 'item_type' = 'menu'
         and coalesce(e.item ->> 'menu_item_id', '')
           !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       )
       or (
         e.item ->> 'item_type' = 'custom'
         and (
           length(btrim(coalesce(e.item ->> 'ko_name', ''))) = 0
           or coalesce(e.item ->> 'unit_usd', '') !~ '^[0-9]+$'
           or coalesce(e.item ->> 'unit_vnd', '') !~ '^[0-9]+$'
         )
       )
  ) then
    raise exception using errcode = '22023', message = 'p_items contains an invalid item';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_items) as e(item)
    where (e.item ->> 'qty')::numeric > 100000
       or case when e.item ->> 'item_type' = 'custom' then
         (e.item ->> 'unit_usd')::numeric > 2147483647
         or (e.item ->> 'unit_vnd')::numeric > 2147483647
       else false end
       or case when e.item ->> 'item_type' = 'menu' then
         not exists (
           select 1
           from public.menu_items as m
           where m.id = (e.item ->> 'menu_item_id')::uuid
             and m.is_active = true
             and m.price_usd is not null
             and m.price_vnd is not null
             and m.price_usd >= 0
             and m.price_vnd >= 0
         )
       else false end
  ) then
    raise exception using errcode = '22023', message = 'p_items contains unavailable menu data or an out-of-range value';
  end if;

  v_payment_method := lower(coalesce(nullif(btrim(p_payment_method), ''), 'cash'));
  if v_payment_method not in ('cash', 'card', 'bank') then
    raise exception using errcode = '22023', message = 'invalid payment method';
  end if;

  if length(coalesce(p_status, '')) > 40
     or length(coalesce(p_guide_name, '')) > 200
     or length(coalesce(p_team_no, '')) > 200 then
    raise exception using errcode = '22023', message = 'order metadata is too long';
  end if;

  perform pg_catalog.set_config('app.rpc_write', 'on', true);

  delete from public.order_items where order_id = p_order_id;
  delete from public.order_custom_items where order_id = p_order_id;

  insert into public.order_items (
    order_id,
    menu_item_id,
    qty,
    unit_usd,
    unit_vnd,
    line_usd,
    line_vnd,
    is_custom,
    custom_ko_name,
    custom_vi_name
  )
  select
    p_order_id,
    m.id,
    (e.item ->> 'qty')::integer,
    m.price_usd,
    m.price_vnd,
    ((e.item ->> 'qty')::bigint * m.price_usd::bigint)::integer,
    ((e.item ->> 'qty')::bigint * m.price_vnd::bigint)::integer,
    false,
    null,
    null
  from pg_catalog.jsonb_array_elements(p_items) as e(item)
  join public.menu_items as m
    on m.id = case
      when e.item ->> 'item_type' = 'menu'
        then (e.item ->> 'menu_item_id')::uuid
      else null
    end
  where e.item ->> 'item_type' = 'menu';

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
    p_order_id,
    coalesce(nullif(btrim(e.item ->> 'kind'), ''), 'special'),
    btrim(e.item ->> 'ko_name'),
    nullif(btrim(e.item ->> 'vi_name'), ''),
    (e.item ->> 'qty')::integer,
    (e.item ->> 'unit_usd')::integer,
    (e.item ->> 'unit_vnd')::integer,
    (
      (e.item ->> 'qty')::bigint
      * (e.item ->> 'unit_usd')::bigint
    )::integer,
    (
      (e.item ->> 'qty')::bigint
      * (e.item ->> 'unit_vnd')::bigint
    )::integer
  from pg_catalog.jsonb_array_elements(p_items) as e(item)
  where e.item ->> 'item_type' = 'custom';

  select
    coalesce(sum(lines.line_usd), 0),
    coalesce(sum(lines.line_vnd), 0)
  into v_total_usd, v_total_vnd
  from (
    select oi.line_usd::bigint as line_usd, oi.line_vnd::bigint as line_vnd
    from public.order_items as oi
    where oi.order_id = p_order_id
    union all
    select ci.line_usd::bigint, ci.line_vnd::bigint
    from public.order_custom_items as ci
    where ci.order_id = p_order_id
  ) as lines;

  if v_total_usd > 2147483647 or v_total_vnd > 2147483647 then
    raise exception using errcode = '22003', message = 'order total is out of range';
  end if;

  update public.orders
  set status = coalesce(nullif(lower(btrim(p_status)), ''), status),
      guide_name = nullif(btrim(p_guide_name), ''),
      team_no = nullif(btrim(p_team_no), ''),
      payment_method = v_payment_method,
      total_usd = v_total_usd::integer,
      total_vnd = v_total_vnd::integer
  where id = p_order_id;

  perform pg_catalog.set_config('app.rpc_write', 'off', true);
  return true;
end;
$$;

create or replace function public.app_update_reservation(
  p_id bigint,
  p_res_date date,
  p_res_time time without time zone,
  p_guests_count integer,
  p_price integer,
  p_menu_ko text,
  p_menu_vi text,
  p_note text,
  p_branch text,
  p_guide_name text
)
returns bigint
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_reservation public.resv_groups%rowtype;
  v_order_source text;
  v_custom_item_id uuid;
  v_custom_item_kind text;
  v_custom_unit_usd integer;
  v_line_vnd bigint;
  v_order_total_usd integer;
  v_order_total_vnd integer;
begin
  if not public.has_app_role(array['admin']::text[]) then
    raise exception using errcode = '42501', message = 'admin role required';
  end if;

  if p_id is null or p_res_date is null or p_res_time is null then
    raise exception using errcode = '22023', message = 'reservation id, date, and time are required';
  end if;

  if p_guests_count is null or p_guests_count <= 0 or p_guests_count > 100000 then
    raise exception using errcode = '22023', message = 'guest count must be between 1 and 100000';
  end if;

  if p_price is not null and p_price < 0 then
    raise exception using errcode = '22023', message = 'price must be zero or greater';
  end if;

  if length(btrim(coalesce(p_branch, ''))) = 0
     or length(p_branch) > 200
     or length(coalesce(p_menu_ko, '')) > 500
     or length(coalesce(p_menu_vi, '')) > 500
     or length(coalesce(p_guide_name, '')) > 200
     or length(coalesce(p_note, '')) > 4000 then
    raise exception using errcode = '22023', message = 'reservation text is missing or too long';
  end if;

  select r.*
  into v_reservation
  from public.resv_groups as r
  where r.id = p_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'reservation not found';
  end if;

  if v_reservation.confirmed then
    if v_reservation.confirmed_at is null
       or v_reservation.confirmed_order_id is null then
      raise exception using
        errcode = '23514',
        message = 'confirmed reservation has an incomplete order reference';
    end if;

    if p_price is null or p_price <= 0 then
      raise exception using errcode = '22023', message = 'a positive reservation price is required';
    end if;

    if length(btrim(coalesce(p_menu_ko, ''))) = 0 then
      raise exception using errcode = '22023', message = 'a reservation menu is required';
    end if;

    v_line_vnd := p_price::bigint * p_guests_count::bigint;
    if v_line_vnd > 2147483647 then
      raise exception using errcode = '22003', message = 'reservation total is out of range';
    end if;

    select o.source
    into v_order_source
    from public.orders as o
    where o.id = v_reservation.confirmed_order_id
    for update;

    if not found or v_order_source is distinct from 'reservation_confirm' then
      raise exception using
        errcode = '23514',
        message = 'linked order is missing or was not created from a reservation';
    end if;

    if exists (
      select 1
      from public.resv_groups as other_reservation
      where other_reservation.confirmed_order_id = v_reservation.confirmed_order_id
        and other_reservation.id <> p_id
    ) then
      raise exception using
        errcode = '23514',
        message = 'linked order is referenced by more than one reservation';
    end if;

    perform 1
    from public.order_items as oi
    where oi.order_id = v_reservation.confirmed_order_id
    for update;

    if found then
      raise exception using
        errcode = '23514',
        message = 'linked order contains non-reservation items';
    end if;

    select ci.id, ci.kind, ci.unit_usd
    into v_custom_item_id, v_custom_item_kind, v_custom_unit_usd
    from public.order_custom_items as ci
    where ci.order_id = v_reservation.confirmed_order_id
    order by ci.id
    limit 1
    for update;

    if not found
       or v_custom_item_kind is distinct from 'group_resv'
       or v_custom_unit_usd is distinct from 0 then
      raise exception using
        errcode = '23514',
        message = 'linked order does not contain exactly one valid reservation item';
    end if;

    perform 1
    from public.order_custom_items as ci
    where ci.order_id = v_reservation.confirmed_order_id
      and ci.id <> v_custom_item_id
    for update;

    if found then
      raise exception using
        errcode = '23514',
        message = 'linked order does not contain exactly one valid reservation item';
    end if;
  elsif v_reservation.confirmed_at is not null
        or v_reservation.confirmed_order_id is not null then
    raise exception using
      errcode = '23514',
      message = 'unconfirmed reservation has an order reference';
  end if;

  perform pg_catalog.set_config('app.rpc_write', 'on', true);

  update public.resv_groups
  set res_date = p_res_date,
      res_time = p_res_time,
      guests_count = p_guests_count,
      price = p_price,
      menu_ko = nullif(btrim(p_menu_ko), ''),
      menu_vi = nullif(btrim(p_menu_vi), ''),
      note = nullif(btrim(p_note), ''),
      branch = btrim(p_branch),
      guide_name = nullif(btrim(p_guide_name), '')
  where id = p_id;

  if v_reservation.confirmed then
    update public.orders
    set created_at = (p_res_date + p_res_time)
          at time zone 'Asia/Ho_Chi_Minh',
        guide_name = nullif(btrim(p_guide_name), '')
    where id = v_reservation.confirmed_order_id;

    update public.order_custom_items
    set ko_name = btrim(p_menu_ko),
        vi_name = nullif(btrim(p_menu_vi), ''),
        qty = p_guests_count,
        unit_usd = 0,
        unit_vnd = p_price
    where id = v_custom_item_id;

    select o.total_usd, o.total_vnd
    into v_order_total_usd, v_order_total_vnd
    from public.orders as o
    where o.id = v_reservation.confirmed_order_id;

    if v_order_total_usd is distinct from 0
       or v_order_total_vnd is distinct from v_line_vnd::integer then
      raise exception using
        errcode = '23514',
        message = 'linked order totals did not synchronize';
    end if;
  end if;

  perform pg_catalog.set_config('app.rpc_write', 'off', true);
  return p_id;
end;
$$;

create function public.app_update_and_confirm_reservation(
  p_id bigint,
  p_res_date date,
  p_res_time time without time zone,
  p_guests_count integer,
  p_price integer,
  p_menu_ko text,
  p_menu_vi text,
  p_note text,
  p_branch text,
  p_guide_name text,
  p_payment_method text,
  p_team_no text
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_confirmed boolean;
begin
  if not public.has_app_role(array['admin']::text[]) then
    raise exception using errcode = '42501', message = 'admin role required';
  end if;

  select r.confirmed
  into v_confirmed
  from public.resv_groups as r
  where r.id = p_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'reservation not found';
  end if;

  if v_confirmed then
    raise exception using
      errcode = '23514',
      message = 'reservation is already confirmed; use app_update_reservation';
  end if;

  perform public.app_update_reservation(
    p_id,
    p_res_date,
    p_res_time,
    p_guests_count,
    p_price,
    p_menu_ko,
    p_menu_vi,
    p_note,
    p_branch,
    p_guide_name
  );

  return public.app_confirm_reservation(
    p_id,
    p_payment_method,
    p_team_no
  );
end;
$$;

revoke all on function public.app_update_order(
  uuid,
  text,
  text,
  text,
  text,
  jsonb
) from public, anon, authenticated, service_role;

revoke all on function public.app_update_reservation(
  bigint,
  date,
  time without time zone,
  integer,
  integer,
  text,
  text,
  text,
  text,
  text
) from public, anon, authenticated, service_role;

revoke all on function public.app_update_and_confirm_reservation(
  bigint,
  date,
  time without time zone,
  integer,
  integer,
  text,
  text,
  text,
  text,
  text,
  text,
  text
) from public, anon, authenticated, service_role;

grant execute on function public.app_update_order(
  uuid,
  text,
  text,
  text,
  text,
  jsonb
) to authenticated;

grant execute on function public.app_update_reservation(
  bigint,
  date,
  time without time zone,
  integer,
  integer,
  text,
  text,
  text,
  text,
  text
) to authenticated;

grant execute on function public.app_update_and_confirm_reservation(
  bigint,
  date,
  time without time zone,
  integer,
  integer,
  text,
  text,
  text,
  text,
  text,
  text,
  text
) to authenticated;
