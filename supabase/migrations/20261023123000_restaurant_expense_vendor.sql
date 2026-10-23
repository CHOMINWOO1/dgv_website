-- Add an optional vendor/counterparty field to restaurant expenses.
--
-- This migration is additive only. Existing expense rows are intentionally
-- left unchanged, so historical records keep their current values and the new
-- field is null until a user supplies it.

alter table public.restaurant_expenses
  add column vendor text;

alter table public.restaurant_expenses
  add constraint restaurant_expenses_vendor_check
  check (
    vendor is null
    or length(btrim(vendor)) <= 300
  );

-- Match the existing passwordless read/create model. UPDATE still requires
-- both an authenticated role and the existing admin-only RLS policy.
grant select (vendor) on table public.restaurant_expenses
to anon, authenticated;

grant insert (vendor) on table public.restaurant_expenses
to anon, authenticated;

grant update (vendor) on table public.restaurant_expenses
to authenticated;

comment on column public.restaurant_expenses.vendor is
  'Optional vendor or counterparty name supplied for an expense.';
