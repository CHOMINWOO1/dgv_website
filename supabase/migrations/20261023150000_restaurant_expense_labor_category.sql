-- Add a dedicated labor expense category and classify the existing October
-- part-time labor records. Only expense_type is changed; dates, amounts,
-- descriptions, vendors, notes, sources, and audit timestamps are preserved.

alter table public.restaurant_expenses
  drop constraint if exists restaurant_expenses_type_check;

alter table public.restaurant_expenses
  add constraint restaurant_expenses_type_check
  check (expense_type in ('invoice', 'general', 'labor'));

update public.restaurant_expenses
set expense_type = 'labor'
where expense_date >= date '2026-10-01'
  and expense_date < date '2026-11-01'
  and expense_type = 'general'
  and (
    coalesce(description, '') like '%파트타임%'
    or coalesce(description, '') like '%알바%'
    or coalesce(vendor, '') like '%파트타임%'
    or coalesce(vendor, '') like '%알바%'
    or coalesce(note, '') like '%파트타임%'
    or coalesce(note, '') like '%알바%'
  );

comment on column public.restaurant_expenses.expense_type is
  'Expense category: general, invoice, or labor.';

