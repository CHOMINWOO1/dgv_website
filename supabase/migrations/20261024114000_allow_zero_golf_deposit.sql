-- Allow a golf reservation to be tracked before any deposit is paid.
-- Existing rows, workflow status, RLS policies, and grants are unchanged.

set lock_timeout = '5s';

alter table public.golf_reservations
  drop constraint if exists golf_reservations_deposit_amount_check,
  add constraint golf_reservations_deposit_amount_check
    check (deposit_amount_vnd between 0 and 9007199254740991);
