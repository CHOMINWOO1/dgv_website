-- Golf reservation ledger for manager/admin operations.
--
-- This migration is additive. It does not read, rewrite, or delete any
-- restaurant order, sales, expense, or group-reservation row.

set lock_timeout = '5s';

create table public.golf_reservations (
  id uuid primary key default gen_random_uuid(),
  representative_name text not null,
  player_names_en text not null,
  pax integer not null,
  coordinator_name text,
  booking_date date not null
    default ((now() at time zone 'Asia/Ho_Chi_Minh')::date),
  golf_date date not null,
  golf_time time without time zone not null,
  golf_course text not null,
  holes integer not null default 18,
  guest_unit_price_vnd bigint,
  smart_cart_note text,
  guest_total_vnd bigint generated always as (
    case
      when guest_unit_price_vnd is null then null
      else guest_unit_price_vnd * pax
    end
  ) stored,
  course_unit_price_vnd bigint,
  course_total_vnd bigint generated always as (
    case
      when course_unit_price_vnd is null then null
      else course_unit_price_vnd * pax
    end
  ) stored,
  deposit_amount_vnd bigint not null,
  deposit_received_date date not null,
  final_received_amount_vnd bigint,
  final_received_date date,
  withdrawal_amount_vnd bigint,
  withdrawal_date date,
  customer_type text not null default 'individual',
  note text,
  status text generated always as (
    case
      when final_received_amount_vnd is not null
       and final_received_date is not null
        then 'completed'
      else 'in_progress'
    end
  ) stored,
  created_by uuid default auth.uid()
    references auth.users (id) on delete set null,
  updated_by uuid default auth.uid()
    references auth.users (id) on delete set null,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),

  constraint golf_reservations_representative_name_check
    check (length(btrim(representative_name)) between 1 and 200),
  constraint golf_reservations_player_names_en_check
    check (length(btrim(player_names_en)) between 1 and 5000),
  constraint golf_reservations_pax_check
    check (pax between 1 and 100),
  constraint golf_reservations_coordinator_name_check
    check (coordinator_name is null or length(btrim(coordinator_name)) between 1 and 200),
  constraint golf_reservations_date_order_check
    check (booking_date <= golf_date),
  constraint golf_reservations_golf_course_check
    check (golf_course in ('AT1200', 'SAM', 'PALACE')),
  constraint golf_reservations_holes_check
    check (holes between 1 and 72),
  constraint golf_reservations_guest_unit_price_check
    check (guest_unit_price_vnd is null or guest_unit_price_vnd between 0 and 1000000000000),
  constraint golf_reservations_course_unit_price_check
    check (course_unit_price_vnd is null or course_unit_price_vnd between 0 and 1000000000000),
  constraint golf_reservations_smart_cart_note_check
    check (smart_cart_note is null or length(btrim(smart_cart_note)) between 1 and 300),
  constraint golf_reservations_deposit_amount_check
    check (deposit_amount_vnd between 1 and 9007199254740991),
  constraint golf_reservations_final_pair_check
    check (
      (final_received_amount_vnd is null and final_received_date is null)
      or
      (final_received_amount_vnd is not null and final_received_date is not null)
    ),
  constraint golf_reservations_final_amount_check
    check (
      final_received_amount_vnd is null
      or final_received_amount_vnd between deposit_amount_vnd and 9007199254740991
    ),
  constraint golf_reservations_final_date_check
    check (
      final_received_date is null
      or final_received_date >= deposit_received_date
    ),
  constraint golf_reservations_withdrawal_amount_check
    check (
      withdrawal_amount_vnd is null
      or withdrawal_amount_vnd between 0 and 9007199254740991
    ),
  constraint golf_reservations_withdrawal_pair_check
    check (
      (withdrawal_amount_vnd is null and withdrawal_date is null)
      or
      (withdrawal_amount_vnd is not null and withdrawal_date is not null)
    ),
  constraint golf_reservations_customer_type_check
    check (customer_type in ('individual', 'company')),
  constraint golf_reservations_note_check
    check (note is null or length(note) <= 5000)
);

create index golf_reservations_status_golf_date_idx
  on public.golf_reservations (status, golf_date, golf_time);

create index golf_reservations_booking_date_idx
  on public.golf_reservations (booking_date desc, created_at desc);

create index golf_reservations_created_by_idx
  on public.golf_reservations (created_by)
  where created_by is not null;

create index golf_reservations_updated_by_idx
  on public.golf_reservations (updated_by)
  where updated_by is not null;

create or replace function private.touch_golf_reservation_audit()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  new.updated_by := (select auth.uid());
  return new;
end;
$$;

create trigger golf_reservations_touch_audit
before update on public.golf_reservations
for each row execute function private.touch_golf_reservation_audit();

alter table public.golf_reservations enable row level security;

revoke all on table public.golf_reservations
from public, anon, authenticated, service_role;

grant usage on schema public to authenticated, service_role;
grant select on table public.golf_reservations to authenticated;

grant insert (
  representative_name,
  player_names_en,
  pax,
  coordinator_name,
  booking_date,
  golf_date,
  golf_time,
  golf_course,
  holes,
  guest_unit_price_vnd,
  smart_cart_note,
  course_unit_price_vnd,
  deposit_amount_vnd,
  deposit_received_date,
  final_received_amount_vnd,
  final_received_date,
  withdrawal_amount_vnd,
  withdrawal_date,
  customer_type,
  note
) on table public.golf_reservations to authenticated;

grant update (
  representative_name,
  player_names_en,
  pax,
  coordinator_name,
  booking_date,
  golf_date,
  golf_time,
  golf_course,
  holes,
  guest_unit_price_vnd,
  smart_cart_note,
  course_unit_price_vnd,
  deposit_amount_vnd,
  deposit_received_date,
  final_received_amount_vnd,
  final_received_date,
  withdrawal_amount_vnd,
  withdrawal_date,
  customer_type,
  note
) on table public.golf_reservations to authenticated;

grant delete on table public.golf_reservations to authenticated;
grant select, insert, update, delete on table public.golf_reservations to service_role;

create policy golf_reservations_manager_admin_read
on public.golf_reservations
for select
to authenticated
using ((select public.current_app_role()) in ('manager', 'admin'));

create policy golf_reservations_manager_admin_insert
on public.golf_reservations
for insert
to authenticated
with check (
  (select public.current_app_role()) in ('manager', 'admin')
  and created_by = (select auth.uid())
  and updated_by = (select auth.uid())
);

create policy golf_reservations_manager_admin_update
on public.golf_reservations
for update
to authenticated
using ((select public.current_app_role()) in ('manager', 'admin'))
with check ((select public.current_app_role()) in ('manager', 'admin'));

create policy golf_reservations_manager_admin_delete
on public.golf_reservations
for delete
to authenticated
using ((select public.current_app_role()) in ('manager', 'admin'));

comment on table public.golf_reservations is
  'Manager/admin golf reservation ledger, separate from restaurant reservations and sales.';

comment on column public.golf_reservations.final_received_amount_vnd is
  'Final total amount received from the customer, including the deposit.';

comment on column public.golf_reservations.status is
  'Generated workflow state: completed only when final total amount and final received date are both present.';

-- User-requested examples. They are isolated in this new table and marked in
-- the note so managers can edit or delete them.
insert into public.golf_reservations (
  representative_name,
  player_names_en,
  pax,
  coordinator_name,
  booking_date,
  golf_date,
  golf_time,
  golf_course,
  holes,
  guest_unit_price_vnd,
  smart_cart_note,
  course_unit_price_vnd,
  deposit_amount_vnd,
  deposit_received_date,
  final_received_amount_vnd,
  final_received_date,
  withdrawal_amount_vnd,
  withdrawal_date,
  customer_type,
  note,
  created_by,
  updated_by
) values
(
  '조민우',
  E'CHO MINWOO\nCHO GISANG',
  2,
  'Chị Oanh',
  date '2026-10-24',
  date '2026-10-26',
  time '05:00',
  'SAM',
  18,
  500000,
  null,
  400000,
  100000,
  date '2026-10-24',
  1000000,
  date '2026-10-25',
  800000,
  date '2026-10-25',
  'individual',
  '완료 예시 / Ví dụ hoàn tất',
  null,
  null
),
(
  '홍길동',
  E'HONG GILDONG\nHONG GILSU',
  2,
  'Chị Oanh',
  date '2026-10-24',
  date '2026-10-28',
  time '07:00',
  'AT1200',
  36,
  600000,
  null,
  550000,
  200000,
  date '2026-10-24',
  null,
  null,
  null,
  null,
  'individual',
  '진행중 예시 / Ví dụ đang xử lý',
  null,
  null
);
