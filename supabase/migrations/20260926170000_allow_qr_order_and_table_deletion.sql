-- Allow an admin's existing paid-order delete workflow to remove the paid
-- ledger row while retaining the originating QR order, item snapshots,
-- client_request_id, and request hash as an immutable audit/idempotency record.
--
-- Table deletion is intentionally a soft delete: historic QR orders keep their
-- table_id, while the raw QR credential is destroyed so the printed code stops
-- working immediately after this transaction commits.

set lock_timeout = '5s';

alter table public.qr_orders
  add column if not exists voided_order_id uuid,
  add column if not exists voided_at timestamp with time zone;

alter table public.qr_orders
  add constraint qr_orders_voided_pair_check
  check (
    (voided_at is null and voided_order_id is null)
    or (voided_at is not null and voided_order_id is not null)
  ),
  add constraint qr_orders_current_voided_disjoint_check
  check (
    not (
      (finalized_at is not null or finalized_order_id is not null)
      and (voided_at is not null or voided_order_id is not null)
    )
  ),
  add constraint qr_orders_voided_cancelled_check
  check (
    voided_order_id is null
    or (status = 'cancelled' and cancelled_at is not null)
  );

create unique index qr_orders_voided_order_id_key
  on public.qr_orders (voided_order_id)
  where voided_order_id is not null;

comment on column public.qr_orders.voided_order_id is
  'Audit tombstone for a deleted paid orders.id. Intentionally has no FK so the QR source and idempotency key survive ledger deletion.';
comment on column public.qr_orders.voided_at is
  'Timestamp when the finalized paid ledger row was deleted by an administrator.';

alter table public.qr_tables
  add column if not exists archived_at timestamp with time zone;

alter table public.qr_tables
  add constraint qr_tables_archived_inactive_check
  check (archived_at is null or is_active = false);

comment on column public.qr_tables.archived_at is
  'Soft-delete timestamp. Archived table rows and their historical QR orders are retained.';

-- Archived labels may be reused by a newly generated table without reviving
-- the old table id or its invalidated QR credential.
drop index if exists public.qr_tables_label_ci_key;

create unique index qr_tables_label_ci_key
  on public.qr_tables (lower(btrim(label)))
  where archived_at is null;

create function private.app_delete_order_impl(p_order_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order_id uuid;
  v_deleted_id uuid;
  v_qr_order_id uuid;
  v_voided_at timestamp with time zone := now();
begin
  if (select auth.uid()) is null
     or not public.has_app_role(array['admin']::text[]) then
    raise exception using errcode = '42501', message = 'admin role required';
  end if;
  if p_order_id is null then
    raise exception using errcode = '22023', message = 'order id is required';
  end if;

  select o.id into v_order_id
  from public.orders as o
  where o.id = p_order_id
  for update;

  if not found then
    return false;
  end if;

  if exists (
    select 1
    from public.resv_groups as r
    where r.confirmed_order_id = v_order_id
  ) then
    raise exception using
      errcode = '23503',
      message = 'unconfirm the reservation before deleting its order';
  end if;

  select q.id into v_qr_order_id
  from public.qr_orders as q
  where q.finalized_order_id = v_order_id
  for update;

  perform pg_catalog.set_config('app.rpc_write', 'on', true);

  if v_qr_order_id is not null then
    update public.qr_orders
    set status = 'cancelled',
        cancelled_at = v_voided_at,
        voided_order_id = finalized_order_id,
        voided_at = v_voided_at,
        finalized_order_id = null,
        finalized_at = null,
        updated_at = v_voided_at
    where id = v_qr_order_id;
  end if;

  delete from public.orders
  where id = v_order_id
  returning id into v_deleted_id;

  perform pg_catalog.set_config('app.rpc_write', 'off', true);
  return v_deleted_id is not null;
end;
$$;

create or replace function public.app_delete_order(p_order_id uuid)
returns boolean
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.app_delete_order_impl(p_order_id)
$$;

create or replace function private.app_rotate_qr_table_token_impl(p_table_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_table public.qr_tables%rowtype;
  v_token text;
begin
  if (select auth.uid()) is null
     or not public.has_app_role(array['admin']::text[]) then
    raise exception using errcode = '42501', message = 'admin role required';
  end if;

  select * into v_table
  from public.qr_tables
  where id = p_table_id
    and archived_at is null
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'QR table not found or archived';
  end if;

  v_token := pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '')
    || pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '');

  insert into private.qr_table_tokens (table_id, token_hash, rotated_at)
  values (v_table.id, private.qr_sha256(v_token), now())
  on conflict (table_id) do update
  set token_hash = excluded.token_hash,
      rotated_at = excluded.rotated_at;

  return pg_catalog.jsonb_build_object(
    'table_id', v_table.id,
    'label', v_table.label,
    'is_active', v_table.is_active,
    'table_token', v_token
  );
end;
$$;

create or replace function private.app_set_qr_table_active_impl(
  p_table_id uuid,
  p_is_active boolean
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null
     or not public.has_app_role(array['admin']::text[]) then
    raise exception using errcode = '42501', message = 'admin role required';
  end if;
  if p_table_id is null or p_is_active is null then
    raise exception using errcode = '22023', message = 'table id and active state are required';
  end if;

  update public.qr_tables
  set is_active = p_is_active,
      updated_at = now()
  where id = p_table_id
    and archived_at is null;

  if not found then
    raise exception using errcode = 'P0002', message = 'QR table not found or archived';
  end if;
  return true;
end;
$$;

create function private.app_archive_qr_table_impl(p_table_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_table_id uuid;
begin
  if (select auth.uid()) is null
     or not public.has_app_role(array['admin']::text[]) then
    raise exception using errcode = '42501', message = 'admin role required';
  end if;
  if p_table_id is null then
    raise exception using errcode = '22023', message = 'table id is required';
  end if;

  select id into v_table_id
  from public.qr_tables
  where id = p_table_id
    and archived_at is null
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'QR table not found or already archived';
  end if;

  update public.qr_tables
  set is_active = false,
      archived_at = now(),
      updated_at = now()
  where id = v_table_id;

  delete from private.qr_table_tokens
  where table_id = v_table_id;

  return true;
end;
$$;

create function public.app_archive_qr_table(p_table_id uuid)
returns boolean
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.app_archive_qr_table_impl(p_table_id)
$$;

-- internal_qr_get_menu and internal_qr_submit_order already require
-- qr_tables.is_active = true. This constraint makes that predicate mutually
-- exclusive with archived_at, while token deletion adds a second independent
-- rejection boundary for every archived table.

revoke execute on function private.app_archive_qr_table_impl(uuid)
  from public, anon, authenticated, service_role;
revoke execute on function public.app_archive_qr_table(uuid)
  from public, anon, authenticated, service_role;
revoke execute on function private.app_delete_order_impl(uuid)
  from public, anon, authenticated, service_role;
revoke execute on function public.app_delete_order(uuid)
  from public, anon, authenticated, service_role;

grant execute on function private.app_archive_qr_table_impl(uuid)
  to authenticated;
grant execute on function public.app_archive_qr_table(uuid)
  to authenticated;
grant execute on function private.app_delete_order_impl(uuid)
  to authenticated;
grant execute on function public.app_delete_order(uuid)
  to authenticated;

comment on function public.app_archive_qr_table(uuid) is
  'Admin-only QR table soft delete. Preserves orders, disables the table, and permanently invalidates its current token.';
comment on function public.app_delete_order(uuid) is
  'Admin-only paid-order deletion. Finalized QR source rows and item snapshots are retained as cancelled audit records.';
