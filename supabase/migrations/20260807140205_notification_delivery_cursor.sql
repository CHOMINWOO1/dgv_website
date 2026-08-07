-- Persist summary row progress so an operator retry resumes from the first
-- unsent rows[] item instead of depending on a deploy-specific chunk ordinal.
-- Existing outbox rows start at chunk zero; payload, status, and application
-- business data are not changed.

alter table public.notification_outbox
  add column delivery_cursor integer not null default 0;

alter table public.notification_outbox
  add constraint notification_outbox_delivery_cursor_check
  check (delivery_cursor between 0 and 100);

comment on column public.notification_outbox.delivery_cursor is
  'Next unsent summary rows[] index; reservation/empty-summary delivery uses 0 then 1.';
