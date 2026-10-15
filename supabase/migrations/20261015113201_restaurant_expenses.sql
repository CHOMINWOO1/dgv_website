-- Restaurant expense ledger.
--
-- This migration is additive: it creates a dedicated table and does not read,
-- rewrite, or delete any existing application row. Browser users may append
-- ledger rows and read the ledger, but may not update or delete history.
-- Future XLSX imports use service_role and an idempotent import_key.

create table public.restaurant_expenses (
  id uuid primary key default gen_random_uuid(),
  expense_date date not null
    default ((now() at time zone 'Asia/Ho_Chi_Minh')::date),
  expense_type text not null,
  amount_vnd bigint not null,
  description text not null,
  note text,
  source text not null default 'web',
  import_key text,
  created_by uuid default auth.uid()
    references auth.users (id) on delete set null,
  created_at timestamp with time zone not null default now(),
  constraint restaurant_expenses_type_check
    check (expense_type in ('invoice', 'general')),
  constraint restaurant_expenses_amount_check
    check (amount_vnd > 0 and amount_vnd <= 9007199254740991),
  constraint restaurant_expenses_description_check
    check (length(btrim(description)) between 1 and 500),
  constraint restaurant_expenses_note_check
    check (note is null or length(note) <= 2000),
  constraint restaurant_expenses_source_check
    check (source in ('web', 'xlsx_import')),
  constraint restaurant_expenses_import_key_check
    check (
      (source = 'web' and import_key is null)
      or (
        source = 'xlsx_import'
        and import_key is not null
        and length(btrim(import_key)) between 1 and 300
      )
    )
);

-- Supports monthly range reads ordered newest-first.
create index restaurant_expenses_date_created_idx
  on public.restaurant_expenses (expense_date desc, created_at desc);

-- Keeps auth.users deletion / audit lookups from scanning the full ledger.
create index restaurant_expenses_created_by_idx
  on public.restaurant_expenses (created_by)
  where created_by is not null;

-- An import can be retried safely: each workbook row has one stable key.
create unique index restaurant_expenses_import_key_unique_idx
  on public.restaurant_expenses (import_key)
  where import_key is not null;

alter table public.restaurant_expenses enable row level security;

create policy restaurant_expenses_admin_read
on public.restaurant_expenses
for select
to authenticated
using (
  (select public.has_app_role(array['admin']::text[]))
);

create policy restaurant_expenses_staff_insert
on public.restaurant_expenses
for insert
to authenticated
with check (
  (select auth.uid()) is not null
  and (select public.has_app_role(array['staff', 'admin']::text[]))
  and source = 'web'
  and import_key is null
  and created_by = (select auth.uid())
);

-- Explicit object privileges are required for Data API access. The browser may
-- supply business fields only; id/source/import/audit fields keep DB defaults.
revoke all on table public.restaurant_expenses
from public, anon, authenticated, service_role;

grant usage on schema public to authenticated, service_role;

grant select (
  id,
  expense_date,
  expense_type,
  amount_vnd,
  description,
  note,
  created_at
) on table public.restaurant_expenses
to authenticated;

grant insert (
  expense_date,
  expense_type,
  amount_vnd,
  description,
  note
) on table public.restaurant_expenses
to authenticated;

grant select, insert, update, delete on table public.restaurant_expenses
to service_role;

comment on table public.restaurant_expenses is
  'Append-only restaurant expense ledger. Staff/admin may add web entries; only admin may read the ledger; service_role may perform idempotent XLSX imports.';

comment on column public.restaurant_expenses.import_key is
  'Stable unique key for one source workbook row; null for browser-created entries.';
