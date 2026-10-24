drop policy if exists golf_course_budget_accounts_admin_read
  on public.golf_course_budget_accounts;
drop policy if exists golf_course_budget_accounts_admin_update
  on public.golf_course_budget_accounts;
drop policy if exists golf_course_budget_deposits_admin_read
  on public.golf_course_budget_deposits;
drop policy if exists golf_course_budget_deposits_admin_insert
  on public.golf_course_budget_deposits;
drop policy if exists golf_course_budget_deposits_admin_update
  on public.golf_course_budget_deposits;
drop policy if exists golf_course_budget_deposits_admin_delete
  on public.golf_course_budget_deposits;
drop policy if exists golf_course_budget_reservation_charges_admin_read
  on public.golf_course_budget_reservation_charges;

create policy golf_course_budget_accounts_manager_admin_read
on public.golf_course_budget_accounts
for select to authenticated
using ((select public.current_app_role()) in ('manager', 'admin'));

create policy golf_course_budget_accounts_manager_admin_update
on public.golf_course_budget_accounts
for update to authenticated
using ((select public.current_app_role()) in ('manager', 'admin'))
with check ((select public.current_app_role()) in ('manager', 'admin'));

create policy golf_course_budget_deposits_manager_admin_read
on public.golf_course_budget_deposits
for select to authenticated
using ((select public.current_app_role()) in ('manager', 'admin'));

create policy golf_course_budget_deposits_manager_admin_insert
on public.golf_course_budget_deposits
for insert to authenticated
with check (
  (select public.current_app_role()) in ('manager', 'admin')
  and created_by = (select auth.uid())
  and updated_by = (select auth.uid())
);

create policy golf_course_budget_deposits_manager_admin_update
on public.golf_course_budget_deposits
for update to authenticated
using ((select public.current_app_role()) in ('manager', 'admin'))
with check ((select public.current_app_role()) in ('manager', 'admin'));

create policy golf_course_budget_deposits_manager_admin_delete
on public.golf_course_budget_deposits
for delete to authenticated
using ((select public.current_app_role()) in ('manager', 'admin'));

create policy golf_course_budget_reservation_charges_manager_admin_read
on public.golf_course_budget_reservation_charges
for select to authenticated
using ((select public.current_app_role()) in ('manager', 'admin'));

comment on table public.golf_course_budget_accounts is
  'Golf-course balance basis visible and editable to manager and admin roles.';
comment on table public.golf_course_budget_deposits is
  'Manual golf-course payments visible and editable to manager and admin roles.';
comment on table public.golf_course_budget_reservation_charges is
  'Reservation-backed golf-course deductions visible to manager and admin roles.';
