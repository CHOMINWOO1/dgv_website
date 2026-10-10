-- Let the staff reservation-check page determine whether only the reservation-
-- linked orders currently on screen are sales-excluded. This migration creates
-- read-only functions and privileges; it does not update or delete table rows.

set lock_timeout = '5s';

create function private.app_get_reservation_sales_excluded_ids_impl(
  p_order_ids uuid[]
)
returns table (order_id uuid)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_role text := public.current_app_role();
  v_requested_count integer := coalesce(pg_catalog.cardinality(p_order_ids), 0);
begin
  if (select auth.uid()) is null
     or v_role is null
     or v_role not in ('staff', 'admin') then
    raise exception using
      errcode = '42501',
      message = 'staff or admin role required';
  end if;

  if p_order_ids is null then
    raise exception using
      errcode = '22023',
      message = 'reservation order ids are required';
  end if;

  if v_requested_count > 500 then
    raise exception using
      errcode = '22023',
      message = 'at most 500 reservation order ids may be checked at once';
  end if;

  if v_requested_count = 0 then
    return;
  end if;

  return query
  select distinct requested.order_id
  from pg_catalog.unnest(p_order_ids) as requested(order_id)
  join public.resv_groups as reservation
    on reservation.confirmed_order_id = requested.order_id
  join public.orders as app_order
    on app_order.id = requested.order_id
  where requested.order_id is not null
    and app_order.sales_excluded is true
  order by requested.order_id;
end;
$$;

create function public.app_get_reservation_sales_excluded_ids(
  p_order_ids uuid[]
)
returns table (order_id uuid)
language sql
stable
security invoker
set search_path = ''
as $$
  select *
  from private.app_get_reservation_sales_excluded_ids_impl(p_order_ids)
$$;

revoke execute on function private.app_get_reservation_sales_excluded_ids_impl(uuid[])
  from public, anon, authenticated, service_role;
revoke execute on function public.app_get_reservation_sales_excluded_ids(uuid[])
  from public, anon, authenticated, service_role;

grant execute on function private.app_get_reservation_sales_excluded_ids_impl(uuid[])
  to authenticated;
grant execute on function public.app_get_reservation_sales_excluded_ids(uuid[])
  to authenticated;

comment on function public.app_get_reservation_sales_excluded_ids(uuid[]) is
  'Staff/admin read-only lookup returning only sales-excluded order ids that are linked to reservations supplied by the caller.';
