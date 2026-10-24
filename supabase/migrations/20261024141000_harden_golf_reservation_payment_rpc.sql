-- Keep the public PostgREST endpoint SECURITY INVOKER while the write-capable
-- implementation remains in the non-exposed private schema. The explicit
-- app_metadata role check inside the implementation is retained.
do $$
begin
  if to_regprocedure('private.save_golf_reservation_with_payments_impl(uuid,jsonb,jsonb)') is null then
    alter function public.save_golf_reservation_with_payments(uuid, jsonb, jsonb)
      set schema private;
    alter function private.save_golf_reservation_with_payments(uuid, jsonb, jsonb)
      rename to save_golf_reservation_with_payments_impl;
  end if;
end;
$$;

create or replace function public.save_golf_reservation_with_payments(
  p_reservation_id uuid,
  p_reservation jsonb,
  p_payments jsonb
)
returns table(saved_id uuid, saved_status text)
language sql
security invoker
set search_path = ''
as $$
  select *
  from private.save_golf_reservation_with_payments_impl(
    p_reservation_id,
    p_reservation,
    p_payments
  )
$$;

revoke all on function private.save_golf_reservation_with_payments_impl(uuid, jsonb, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.save_golf_reservation_with_payments(uuid, jsonb, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function private.save_golf_reservation_with_payments_impl(uuid, jsonb, jsonb)
  to authenticated;
grant execute on function public.save_golf_reservation_with_payments(uuid, jsonb, jsonb)
  to authenticated;

