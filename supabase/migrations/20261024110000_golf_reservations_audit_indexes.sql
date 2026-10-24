-- Follow-up for the production migration applied before the covering audit
-- index was added to the canonical golf reservation schema.
create index if not exists golf_reservations_updated_by_idx
  on public.golf_reservations (updated_by)
  where updated_by is not null;

