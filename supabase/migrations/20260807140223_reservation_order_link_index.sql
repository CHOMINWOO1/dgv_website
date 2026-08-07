-- Keep reservation-to-order invariant lookups short while the linked order is
-- locked. This follow-up is idempotent because the integrity migration may have
-- been applied manually before its index was split into a separate migration.

create index if not exists idx_resv_groups_confirmed_order_id
  on public.resv_groups using btree (confirmed_order_id)
  where confirmed_order_id is not null;
