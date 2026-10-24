-- Run only after the counterparty-aware web client is live.
-- coordinator_name is unused in all imported rows and has been removed from the UI.

set lock_timeout = '5s';

alter table public.golf_reservations
  alter column counterparty_name drop default,
  drop column if exists coordinator_name;
