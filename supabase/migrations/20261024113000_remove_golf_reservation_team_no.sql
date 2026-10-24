-- Remove the redundant team number from the isolated golf reservation ledger.
-- Existing reservations and all remaining column values are preserved.

set lock_timeout = '5s';

drop index if exists public.golf_reservations_status_golf_date_idx;

alter table public.golf_reservations
  drop column if exists team_no;

create index if not exists golf_reservations_status_golf_date_idx
  on public.golf_reservations (status, golf_date, golf_time);
