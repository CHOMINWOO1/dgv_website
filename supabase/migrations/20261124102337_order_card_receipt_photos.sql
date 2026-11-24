-- Additive receipt attachments only. No order, payment or sales snapshot is changed.
-- One current photo per order; replacements use new immutable object paths.
create table public.order_card_receipts (
  order_id uuid primary key references public.orders(id) on delete cascade,
  storage_path text not null unique,
  byte_size integer not null check (byte_size between 1 and 2097152),
  mime_type text not null default 'image/jpeg' check (mime_type = 'image/jpeg'),
  updated_at timestamptz not null default now(),
  constraint order_card_receipts_path_check check (
    storage_path ~ ('^' || order_id::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.]jpg$')
  )
);
comment on table public.order_card_receipts is
  'Private card slip photo metadata. Existing sales snapshots are never updated by attachments.';
alter table public.order_card_receipts enable row level security;
revoke all on public.order_card_receipts from public, anon, authenticated;
grant select, insert, update, delete on public.order_card_receipts to authenticated;

create policy order_card_receipts_read on public.order_card_receipts
for select to authenticated using (
  (select auth.uid()) is not null
  and (select public.current_app_role()) in ('manager', 'admin')
  and exists (select 1 from public.orders o where o.id = order_id
    and o.payment_method = 'card' and o.status = 'paid' and o.sales_excluded is false)
);
create policy order_card_receipts_insert on public.order_card_receipts
for insert to authenticated with check (
  (select auth.uid()) is not null
  and (select public.current_app_role()) in ('manager', 'admin')
  and exists (select 1 from public.orders o where o.id = order_id
    and o.payment_method = 'card' and o.status = 'paid' and o.sales_excluded is false)
  and exists (select 1 from storage.objects s where s.bucket_id = 'order-card-receipts'
    and s.name = storage_path and s.metadata->>'mimetype' = mime_type
    and s.metadata->>'size' = byte_size::text)
);
create policy order_card_receipts_update on public.order_card_receipts
for update to authenticated using (
  (select auth.uid()) is not null
  and (select public.current_app_role()) in ('manager', 'admin')
  and exists (select 1 from public.orders o where o.id = order_id
    and o.payment_method = 'card' and o.status = 'paid' and o.sales_excluded is false)
) with check (
  (select auth.uid()) is not null
  and (select public.current_app_role()) in ('manager', 'admin')
  and exists (select 1 from public.orders o where o.id = order_id
    and o.payment_method = 'card' and o.status = 'paid' and o.sales_excluded is false)
  and exists (select 1 from storage.objects s where s.bucket_id = 'order-card-receipts'
    and s.name = storage_path and s.metadata->>'mimetype' = mime_type
    and s.metadata->>'size' = byte_size::text)
);
create policy order_card_receipts_delete on public.order_card_receipts
for delete to authenticated using (
  (select auth.uid()) is not null
  and (select public.current_app_role()) in ('manager', 'admin')
  and exists (select 1 from public.orders o where o.id = order_id
    and o.payment_method = 'card' and o.status = 'paid' and o.sales_excluded is false)
);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('order-card-receipts', 'order-card-receipts', false, 2097152, array['image/jpeg']);

-- Order visibility is checked independently of metadata, avoiding policy recursion.
-- Cast the folder, not the indexed order ID. CASE keeps malformed object names
-- (including names in unrelated buckets) from ever reaching the UUID cast.
create policy order_card_receipt_objects_read on storage.objects
for select to authenticated using (
  bucket_id = 'order-card-receipts'
  and (select auth.uid()) is not null
  and (select public.current_app_role()) in ('manager', 'admin')
  and exists (select 1 from public.orders o where o.id = case
    when split_part(name, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then split_part(name, '/', 1)::uuid else null end
    and o.payment_method = 'card' and o.status = 'paid' and o.sales_excluded is false)
);
create policy order_card_receipt_objects_insert on storage.objects
for insert to authenticated with check (
  bucket_id = 'order-card-receipts'
  and (select auth.uid()) is not null
  and (select public.current_app_role()) in ('manager', 'admin')
  and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.]jpg$'
  and exists (select 1 from public.orders o where o.id = case
    when split_part(name, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then split_part(name, '/', 1)::uuid else null end
    and o.payment_method = 'card' and o.status = 'paid' and o.sales_excluded is false)
);
-- No UPDATE/upsert: a photo already referenced by an order cannot be overwritten.
-- Failed/ambiguous saves may remove only unreferenced objects, never an active photo.
create policy order_card_receipt_objects_delete on storage.objects
for delete to authenticated using (
  bucket_id = 'order-card-receipts'
  and (select auth.uid()) is not null
  and (select public.current_app_role()) in ('manager', 'admin')
  and exists (select 1 from public.orders o where o.id = case
    when split_part(name, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then split_part(name, '/', 1)::uuid else null end
    and o.payment_method = 'card' and o.status = 'paid' and o.sales_excluded is false)
  and not exists (select 1 from public.order_card_receipts r where r.storage_path = name)
);
