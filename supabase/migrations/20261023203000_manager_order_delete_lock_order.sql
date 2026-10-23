-- Follow-up to 20261023193000_manager_role_least_privilege.sql.
--
-- Manager QR edit/status and checkout retry paths lock qr_orders before their
-- linked paid order. Use that same order in paid-order deletion so concurrent
-- operations cannot form a QR->order / order->QR deadlock cycle.

set lock_timeout = '5s';

create or replace function private.app_delete_order_impl(p_order_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text := public.current_app_role();
  v_order_id uuid;
  v_sales_excluded boolean;
  v_deleted_id uuid;
  v_voided_at timestamp with time zone := now();
begin
  if (select auth.uid()) is null
     or v_role is null
     or v_role not in ('manager', 'admin') then
    raise exception using
      errcode = '42501',
      message = 'manager or admin role required';
  end if;
  if p_order_id is null then
    raise exception using errcode = '22023', message = 'order id is required';
  end if;

  -- Canonical lock order: QR children (UUID order), then the paid parent.
  perform qr_order.id
  from public.qr_orders as qr_order
  where qr_order.finalized_order_id = p_order_id
  order by qr_order.id
  for update;

  select paid_order.id, paid_order.sales_excluded
  into v_order_id, v_sales_excluded
  from public.orders as paid_order
  where paid_order.id = p_order_id
  for update;

  if not found then
    return false;
  end if;

  if v_role = 'manager' and v_sales_excluded is true then
    raise exception using
      errcode = '42501',
      message = 'manager cannot access a sales-excluded order';
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

-- Abort the migration if the function body drifts or the manager target guard
-- is lost. pg_get_functiondef retains the PL/pgSQL body text used above.
do $manager_delete_lock_order_assert$
declare
  v_definition text := pg_catalog.pg_get_functiondef(
    'private.app_delete_order_impl(uuid)'::regprocedure
  );
  v_qr_lock_position integer;
  v_order_lock_position integer;
begin
  v_qr_lock_position := pg_catalog.strpos(
    v_definition,
    'where qr_order.finalized_order_id = p_order_id'
  );
  v_order_lock_position := pg_catalog.strpos(
    v_definition,
    'select paid_order.id, paid_order.sales_excluded'
  );

  if v_qr_lock_position = 0
     or v_order_lock_position = 0
     or v_qr_lock_position > v_order_lock_position then
    raise exception 'manager delete follow-up: paid-order delete lock order is unsafe';
  end if;

  if pg_catalog.strpos(v_definition, 'v_role = ''manager''') = 0
     or pg_catalog.strpos(v_definition, 'v_sales_excluded is true') = 0 then
    raise exception 'manager delete follow-up: manager target guard is missing';
  end if;
end;
$manager_delete_lock_order_assert$;
