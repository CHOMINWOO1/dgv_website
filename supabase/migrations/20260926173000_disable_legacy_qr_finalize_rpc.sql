-- POST-FRONTEND-DEPLOY CUTOVER
--
-- Apply this migration only after the GitHub Pages build that calls
-- app_finalize_qr_order_checked has been deployed and verified. The preceding
-- migration intentionally leaves the legacy four-argument RPC callable so a
-- DB-first rollout does not interrupt the currently served JavaScript.

revoke execute on function public.app_finalize_qr_order(uuid, text, text, text)
  from public, anon, authenticated, service_role;

revoke execute on function private.app_finalize_qr_order_impl(uuid, text, text, text)
  from public, anon, authenticated, service_role;

comment on function public.app_finalize_qr_order(uuid, text, text, text) is
  'Disabled legacy QR checkout RPC. Use app_finalize_qr_order_checked with the modal-opened row version.';

comment on function private.app_finalize_qr_order_impl(uuid, text, text, text) is
  'Disabled legacy QR checkout implementation retained only for migration history compatibility.';
