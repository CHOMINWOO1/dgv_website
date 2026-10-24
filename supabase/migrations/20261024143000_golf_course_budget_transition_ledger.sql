-- Golf-course budget ledger.
--
-- Existing completed reservations are backfilled as already deducted so their
-- details remain visible. Opening balances are increased by the same known costs,
-- keeping the user-provided current balances unchanged at cutover.

set lock_timeout = '5s';

create table public.golf_course_budget_accounts (
  golf_course text primary key,
  opening_balance_vnd bigint not null,
  balance_as_of date not null,
  created_by uuid default auth.uid()
    references auth.users (id) on delete set null,
  updated_by uuid default auth.uid()
    references auth.users (id) on delete set null,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),

  constraint golf_course_budget_accounts_course_check
    check (golf_course in ('AT1200', 'SAM', 'PALACE')),
  constraint golf_course_budget_accounts_opening_balance_check
    check (opening_balance_vnd between 0 and 9007199254740991)
);

create table public.golf_course_budget_deposits (
  id uuid primary key default gen_random_uuid(),
  golf_course text not null
    references public.golf_course_budget_accounts (golf_course)
    on update cascade on delete restrict,
  deposit_date date not null,
  amount_vnd bigint not null,
  payment_method text not null,
  note text,
  created_by uuid default auth.uid()
    references auth.users (id) on delete set null,
  updated_by uuid default auth.uid()
    references auth.users (id) on delete set null,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),

  constraint golf_course_budget_deposits_course_check
    check (golf_course in ('AT1200', 'SAM', 'PALACE')),
  constraint golf_course_budget_deposits_amount_check
    check (amount_vnd between 1 and 9007199254740991),
  constraint golf_course_budget_deposits_method_check
    check (payment_method in ('bank', 'cash', 'card')),
  constraint golf_course_budget_deposits_note_check
    check (note is null or length(note) <= 1000),
  constraint golf_course_budget_deposits_large_cash_check
    check (not (payment_method = 'cash' and amount_vnd >= 5000000))
);

create table public.golf_course_budget_reservation_charges (
  reservation_id uuid primary key
    references public.golf_reservations (id) on delete cascade,
  golf_course text not null
    references public.golf_course_budget_accounts (golf_course)
    on update cascade on delete restrict,
  golf_date date not null,
  amount_vnd bigint,
  active boolean not null default true,
  historical boolean not null default false,
  charged_at timestamp with time zone not null default now(),
  reversed_at timestamp with time zone,
  updated_at timestamp with time zone not null default now(),

  constraint golf_course_budget_reservation_charges_course_check
    check (golf_course in ('AT1200', 'SAM', 'PALACE')),
  constraint golf_course_budget_reservation_charges_amount_check
    check (amount_vnd is null or amount_vnd between 0 and 9007199254740991),
  constraint golf_course_budget_reservation_charges_state_check
    check ((active and reversed_at is null) or (not active and reversed_at is not null))
);

create index golf_course_budget_accounts_created_by_idx
  on public.golf_course_budget_accounts (created_by)
  where created_by is not null;
create index golf_course_budget_accounts_updated_by_idx
  on public.golf_course_budget_accounts (updated_by)
  where updated_by is not null;
create index golf_course_budget_deposits_course_date_idx
  on public.golf_course_budget_deposits (golf_course, deposit_date desc, created_at desc);
create index golf_course_budget_deposits_created_by_idx
  on public.golf_course_budget_deposits (created_by)
  where created_by is not null;
create index golf_course_budget_deposits_updated_by_idx
  on public.golf_course_budget_deposits (updated_by)
  where updated_by is not null;
create index golf_course_budget_reservation_charges_course_date_idx
  on public.golf_course_budget_reservation_charges (golf_course, golf_date desc, charged_at desc);

create or replace function private.touch_golf_course_budget_audit()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_balance_as_of date;
begin
  if tg_table_name = 'golf_course_budget_deposits' then
    select account.balance_as_of
    into v_balance_as_of
    from public.golf_course_budget_accounts account
    where account.golf_course = new.golf_course;

    if v_balance_as_of is null or new.deposit_date < v_balance_as_of then
      raise exception
        '기준일 이전의 충전은 등록할 수 없습니다. / Không thể nhập khoản nạp trước ngày chốt.'
        using errcode = '23514';
    end if;
  end if;

  if tg_op = 'INSERT' then
    new.created_by := (select auth.uid());
  end if;
  new.updated_by := (select auth.uid());
  new.updated_at := now();
  return new;
end;
$$;

create trigger golf_course_budget_accounts_touch_audit
before insert or update on public.golf_course_budget_accounts
for each row execute function private.touch_golf_course_budget_audit();

create trigger golf_course_budget_deposits_touch_audit
before insert or update on public.golf_course_budget_deposits
for each row execute function private.touch_golf_course_budget_audit();

create or replace function private.sync_golf_course_budget_reservation_charge()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_has_charge boolean := false;
  v_tracked_course boolean;
begin
  v_tracked_course := new.golf_course in ('AT1200', 'SAM', 'PALACE');

  if tg_op = 'INSERT' then
    if new.status = 'completed' and v_tracked_course then
      if new.course_total_vnd is null then
        raise exception
          '골프장 원가를 입력한 후 완료 처리해 주세요. / Vui lòng nhập giá sân trước khi hoàn tất.'
          using errcode = '23514';
      end if;

      insert into public.golf_course_budget_reservation_charges (
        reservation_id, golf_course, golf_date, amount_vnd
      ) values (
        new.id, new.golf_course, new.golf_date, new.course_total_vnd
      );
    end if;
    return new;
  end if;

  select exists (
    select 1
    from public.golf_course_budget_reservation_charges charge
    where charge.reservation_id = new.id
  ) into v_has_charge;

  if old.status <> 'completed' and new.status = 'completed' then
    if v_tracked_course then
      if new.course_total_vnd is null then
        raise exception
          '골프장 원가를 입력한 후 완료 처리해 주세요. / Vui lòng nhập giá sân trước khi hoàn tất.'
          using errcode = '23514';
      end if;

      insert into public.golf_course_budget_reservation_charges (
        reservation_id, golf_course, golf_date, amount_vnd
      ) values (
        new.id, new.golf_course, new.golf_date, new.course_total_vnd
      )
      on conflict (reservation_id) do update
      set golf_course = excluded.golf_course,
          golf_date = excluded.golf_date,
          amount_vnd = excluded.amount_vnd,
          active = true,
          historical = false,
          charged_at = now(),
          reversed_at = null,
          updated_at = now();
    end if;
  elsif old.status = 'completed' and new.status <> 'completed' then
    update public.golf_course_budget_reservation_charges charge
    set active = false,
        reversed_at = now(),
        updated_at = now()
    where charge.reservation_id = new.id
      and charge.active;
  elsif new.status = 'completed' and v_has_charge then
    if not v_tracked_course then
      update public.golf_course_budget_reservation_charges charge
      set active = false,
          reversed_at = coalesce(charge.reversed_at, now()),
          updated_at = now()
      where charge.reservation_id = new.id
        and charge.active;
    else
      if new.course_total_vnd is null
         and (old.course_total_vnd is not null or old.golf_course is distinct from new.golf_course) then
        raise exception
          '골프장 원가는 비울 수 없습니다. / Không thể để trống giá sân.'
          using errcode = '23514';
      end if;

      update public.golf_course_budget_reservation_charges charge
      set golf_course = new.golf_course,
          golf_date = new.golf_date,
          amount_vnd = new.course_total_vnd,
          active = true,
          charged_at = case when charge.active then charge.charged_at else now() end,
          reversed_at = null,
          updated_at = now()
      where charge.reservation_id = new.id
        and (
          charge.golf_course is distinct from new.golf_course
          or charge.golf_date is distinct from new.golf_date
          or charge.amount_vnd is distinct from new.course_total_vnd
          or not charge.active
        );
    end if;
  end if;

  return new;
end;
$$;

create trigger golf_reservations_sync_budget_charge
after insert or update on public.golf_reservations
for each row execute function private.sync_golf_course_budget_reservation_charge();

alter table public.golf_course_budget_accounts enable row level security;
alter table public.golf_course_budget_deposits enable row level security;
alter table public.golf_course_budget_reservation_charges enable row level security;

revoke all on table public.golf_course_budget_accounts
from public, anon, authenticated, service_role;
revoke all on table public.golf_course_budget_deposits
from public, anon, authenticated, service_role;
revoke all on table public.golf_course_budget_reservation_charges
from public, anon, authenticated, service_role;

grant select on table public.golf_course_budget_accounts to authenticated;
grant update (opening_balance_vnd)
  on table public.golf_course_budget_accounts to authenticated;

grant select on table public.golf_course_budget_deposits to authenticated;
grant insert (golf_course, deposit_date, amount_vnd, payment_method, note)
  on table public.golf_course_budget_deposits to authenticated;
grant update (golf_course, deposit_date, amount_vnd, payment_method, note)
  on table public.golf_course_budget_deposits to authenticated;
grant delete on table public.golf_course_budget_deposits to authenticated;

grant select on table public.golf_course_budget_reservation_charges to authenticated;

grant select, insert, update, delete on table public.golf_course_budget_accounts to service_role;
grant select, insert, update, delete on table public.golf_course_budget_deposits to service_role;
grant select, insert, update, delete on table public.golf_course_budget_reservation_charges to service_role;

create policy golf_course_budget_accounts_admin_read
on public.golf_course_budget_accounts
for select to authenticated
using ((select public.current_app_role()) = 'admin');

create policy golf_course_budget_accounts_admin_update
on public.golf_course_budget_accounts
for update to authenticated
using ((select public.current_app_role()) = 'admin')
with check ((select public.current_app_role()) = 'admin');

create policy golf_course_budget_deposits_admin_read
on public.golf_course_budget_deposits
for select to authenticated
using ((select public.current_app_role()) = 'admin');

create policy golf_course_budget_deposits_admin_insert
on public.golf_course_budget_deposits
for insert to authenticated
with check (
  (select public.current_app_role()) = 'admin'
  and created_by = (select auth.uid())
  and updated_by = (select auth.uid())
);

create policy golf_course_budget_deposits_admin_update
on public.golf_course_budget_deposits
for update to authenticated
using ((select public.current_app_role()) = 'admin')
with check ((select public.current_app_role()) = 'admin');

create policy golf_course_budget_deposits_admin_delete
on public.golf_course_budget_deposits
for delete to authenticated
using ((select public.current_app_role()) = 'admin');

create policy golf_course_budget_reservation_charges_admin_read
on public.golf_course_budget_reservation_charges
for select to authenticated
using ((select public.current_app_role()) = 'admin');

revoke all on function private.touch_golf_course_budget_audit()
from public, anon, authenticated, service_role;
revoke all on function private.sync_golf_course_budget_reservation_charge()
from public, anon, authenticated, service_role;

with desired_current_balance (golf_course, current_balance_vnd) as (
  values
    ('AT1200'::text, 77500000::bigint),
    ('SAM'::text, 220000000::bigint),
    ('PALACE'::text, 0::bigint)
), historical_cost as (
  select reservation.golf_course,
         coalesce(sum(reservation.course_total_vnd), 0)::bigint as amount_vnd
  from public.golf_reservations reservation
  where reservation.status = 'completed'
    and reservation.golf_course in ('AT1200', 'SAM', 'PALACE')
  group by reservation.golf_course
)
insert into public.golf_course_budget_accounts (
  golf_course, opening_balance_vnd, balance_as_of, created_by, updated_by
)
select desired.golf_course,
       desired.current_balance_vnd + coalesce(historical.amount_vnd, 0),
       date '2026-10-24',
       null,
       null
from desired_current_balance desired
left join historical_cost historical using (golf_course)
on conflict (golf_course) do nothing;

insert into public.golf_course_budget_reservation_charges (
  reservation_id,
  golf_course,
  golf_date,
  amount_vnd,
  active,
  historical,
  charged_at,
  reversed_at,
  updated_at
)
select reservation.id,
       reservation.golf_course,
       reservation.golf_date,
       reservation.course_total_vnd,
       true,
       true,
       reservation.final_received_date::timestamp at time zone 'Asia/Ho_Chi_Minh',
       null,
       now()
from public.golf_reservations reservation
where reservation.status = 'completed'
  and reservation.golf_course in ('AT1200', 'SAM', 'PALACE')
on conflict (reservation_id) do nothing;

comment on table public.golf_course_budget_accounts is
  'Editable opening balance snapshots for the three managed golf courses.';
comment on table public.golf_course_budget_deposits is
  'Administrator-entered golf-course wallet top-ups only; customer receipts are never included.';
comment on table public.golf_course_budget_reservation_charges is
  'Active and restored reservation-cost deductions. Existing completed managed-course reservations are backfilled without changing the supplied current balance.';
comment on function private.sync_golf_course_budget_reservation_charge() is
  'Tracks reservation completion, reopening, course and cost changes after the initial completed-reservation backfill.';
