-- POST-FRONTEND-DEPLOY CUTOVER
--
-- Apply only after the GitHub Pages build that calls
-- app_finalize_qr_table_orders_checked has been deployed and verified. Keeping
-- the single-order endpoint through the DB-first phase prevents an outage for
-- clients that loaded the preceding JavaScript bundle.

revoke execute on function public.app_finalize_qr_order_checked(uuid, timestamp with time zone, text, text, text)
  from public, anon, authenticated, service_role;

revoke execute on function private.app_finalize_qr_order_checked_impl(uuid, timestamp with time zone, text, text, text)
  from public, anon, authenticated, service_role;

comment on function public.app_finalize_qr_order_checked(uuid, timestamp with time zone, text, text, text) is
  'Disabled single-QR-order checkout RPC. Use app_finalize_qr_table_orders_checked so one table is paid as one sale.';

comment on function private.app_finalize_qr_order_checked_impl(uuid, timestamp with time zone, text, text, text) is
  'Disabled single-QR-order checkout implementation retained only for migration history compatibility.';

