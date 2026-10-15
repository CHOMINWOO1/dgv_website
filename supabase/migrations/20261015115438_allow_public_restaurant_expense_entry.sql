-- The expense page is intentionally passwordless for fast data entry.
-- Existing ledger rows are not modified. Public clients may read and append,
-- while UPDATE and DELETE require an authenticated administrator.

drop policy if exists restaurant_expenses_admin_read
on public.restaurant_expenses;

drop policy if exists restaurant_expenses_staff_insert
on public.restaurant_expenses;

drop policy if exists restaurant_expenses_public_read
on public.restaurant_expenses;

drop policy if exists restaurant_expenses_anon_insert
on public.restaurant_expenses;

drop policy if exists restaurant_expenses_authenticated_insert
on public.restaurant_expenses;

drop policy if exists restaurant_expenses_admin_update
on public.restaurant_expenses;

drop policy if exists restaurant_expenses_admin_delete
on public.restaurant_expenses;

create policy restaurant_expenses_public_read
on public.restaurant_expenses
for select
to anon, authenticated
using (true);

create policy restaurant_expenses_anon_insert
on public.restaurant_expenses
for insert
to anon
with check (
  source = 'web'
  and import_key is null
  and created_by is null
);

create policy restaurant_expenses_authenticated_insert
on public.restaurant_expenses
for insert
to authenticated
with check (
  (select auth.uid()) is not null
  and source = 'web'
  and import_key is null
  and created_by = (select auth.uid())
);

create policy restaurant_expenses_admin_update
on public.restaurant_expenses
for update
to authenticated
using (
  (select public.has_app_role(array['admin']::text[]))
)
with check (
  (select public.has_app_role(array['admin']::text[]))
);

create policy restaurant_expenses_admin_delete
on public.restaurant_expenses
for delete
to authenticated
using (
  (select public.has_app_role(array['admin']::text[]))
);

grant usage on schema public to anon, authenticated;

revoke update, delete, truncate, references, trigger
on table public.restaurant_expenses
from anon, authenticated;

grant select (
  id,
  expense_date,
  expense_type,
  amount_vnd,
  description,
  note,
  created_at
) on table public.restaurant_expenses
to anon;

grant insert (
  expense_date,
  expense_type,
  amount_vnd,
  description,
  note
) on table public.restaurant_expenses
to anon;

grant update (
  expense_date,
  expense_type,
  amount_vnd,
  description,
  note
) on table public.restaurant_expenses
to authenticated;

grant delete on table public.restaurant_expenses
to authenticated;

comment on table public.restaurant_expenses is
  'Restaurant expense ledger. Public clients may read and add web entries; only admin may update or delete; service_role may perform idempotent XLSX imports.';
