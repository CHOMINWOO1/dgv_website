-- Shared customer receipts; the existing reservation remains the accounting unit
-- for each round's course/partner cost. No existing booking or money is migrated here.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table public.golf_booking_groups (
  id uuid primary key default gen_random_uuid(),
  label text not null check (length(btrim(label)) between 1 and 160),
  version bigint not null default 1 check (version > 0),
  completed_at timestamptz,
  completion_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((completed_at is null) = (completion_date is null))
);
create table public.golf_booking_group_payments (
  id uuid primary key default gen_random_uuid(),
  booking_group_id uuid not null references public.golf_booking_groups(id) on delete restrict,
  payment_kind text not null check (payment_kind in ('deposit','receipt')),
  amount_vnd bigint not null check (amount_vnd between 0 and 9007199254740991),
  payment_date date not null,
  payment_method text check (payment_method in ('bank','cash','card')),
  completes_booking boolean not null default false,
  sort_order integer not null default 0 check (sort_order between 0 and 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  check (amount_vnd = 0 or payment_method is not null),
  check (payment_method is distinct from 'cash' or amount_vnd < 5000000)
);
create index golf_booking_group_payments_group_idx on public.golf_booking_group_payments(booking_group_id,payment_date,id);
create index golf_booking_group_payments_created_by_idx on public.golf_booking_group_payments(created_by);
create index golf_booking_group_payments_updated_by_idx on public.golf_booking_group_payments(updated_by);
create unique index golf_booking_group_one_completion_idx on public.golf_booking_group_payments(booking_group_id) where completes_booking;
alter table public.golf_booking_groups enable row level security;
alter table public.golf_booking_group_payments enable row level security;
revoke all on public.golf_booking_groups, public.golf_booking_group_payments from public, anon, authenticated;
grant select on public.golf_booking_groups, public.golf_booking_group_payments to authenticated;
create policy golf_booking_groups_read on public.golf_booking_groups for select to authenticated
  using ((select public.has_app_role(array['manager','admin'])));
create policy golf_booking_group_payments_read on public.golf_booking_group_payments for select to authenticated
  using ((select public.has_app_role(array['manager','admin'])));

alter table public.golf_reservations
  add column booking_group_id uuid references public.golf_booking_groups(id) on delete restrict,
  add column group_completed boolean not null default false;
create index golf_reservations_booking_group_idx on public.golf_reservations(booking_group_id);
alter table public.golf_reservations alter column status set expression as (
  case when booking_group_id is not null then
    case when group_completed then 'completed'::text else 'in_progress'::text end
  when final_received_amount_vnd is not null and final_received_date is not null then 'completed'::text
  else 'in_progress'::text end
);

-- SECURITY INVOKER deliberately checks the effective SQL role, not a spoofable
-- transaction setting. Trusted definer RPCs can update; direct clients cannot.
create function private.guard_golf_booking_round_write() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if current_user in ('authenticated','anon') then
    if tg_op <> 'INSERT' and old.booking_group_id is not null then
      raise exception '묶음예약 전용 저장을 사용해 주세요. / Vui lòng lưu qua nhóm đặt sân.' using errcode='42501';
    end if;
    if tg_op <> 'DELETE' and new.booking_group_id is not null then
      raise exception '묶음예약 전용 저장을 사용해 주세요. / Vui lòng lưu qua nhóm đặt sân.' using errcode='42501';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
revoke all on function private.guard_golf_booking_round_write() from public,anon,authenticated;
create trigger golf_booking_round_write_guard before insert or update or delete on public.golf_reservations
for each row execute function private.guard_golf_booking_round_write();

create function private.guard_golf_booking_legacy_payment() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op <> 'INSERT' and exists(select 1 from public.golf_reservations r where r.id=old.reservation_id and r.booking_group_id is not null) then
    raise exception 'Grouped customer payments must use the shared ledger' using errcode='42501';
  end if;
  if tg_op <> 'DELETE' and exists(select 1 from public.golf_reservations r where r.id=new.reservation_id and r.booking_group_id is not null) then
    raise exception 'Grouped customer payments must use the shared ledger' using errcode='42501';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
revoke all on function private.guard_golf_booking_legacy_payment() from public,anon,authenticated;
create trigger golf_booking_legacy_payment_guard before insert or update or delete on public.golf_reservation_payments
for each row execute function private.guard_golf_booking_legacy_payment();

-- Keep the current standalone implementation intact, including legacy handling.
alter function private.save_golf_reservation_with_payments_impl(uuid,jsonb,jsonb)
  rename to save_golf_reservation_with_payments_single_impl;
revoke all on function private.save_golf_reservation_with_payments_single_impl(uuid,jsonb,jsonb) from public,anon,authenticated,service_role;
create function private.save_golf_reservation_with_payments_impl(p_reservation_id uuid,p_reservation jsonb,p_payments jsonb)
returns table(saved_id uuid,saved_status text)
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null or not public.has_app_role(array['manager','admin']) then
    raise exception 'Manager or administrator role required' using errcode='42501';
  end if;
  if exists(select 1 from public.golf_reservations where id=p_reservation_id and booking_group_id is not null) then
    raise exception '묶음예약 전용 저장을 사용해 주세요. / Vui lòng lưu qua nhóm đặt sân.' using errcode='42501';
  end if;
  return query select * from private.save_golf_reservation_with_payments_single_impl(p_reservation_id,p_reservation,p_payments);
end $$;
create or replace function public.save_golf_reservation_with_payments(p_reservation_id uuid,p_reservation jsonb,p_payments jsonb)
returns table(saved_id uuid,saved_status text)
language sql security invoker set search_path = '' as $$
  select * from private.save_golf_reservation_with_payments_impl(p_reservation_id,p_reservation,p_payments)
$$;
revoke all on function private.save_golf_reservation_with_payments_impl(uuid,jsonb,jsonb) from public,anon;
grant execute on function private.save_golf_reservation_with_payments_impl(uuid,jsonb,jsonb) to authenticated;

create function private.save_golf_booking_group_impl(
  p_group_id uuid,p_round_id uuid,p_reservation jsonb,p_payments jsonb,p_expected_version bigint
) returns table(saved_id uuid,saved_status text)
language plpgsql security definer set search_path = '' as $$
declare
  v_group public.golf_booking_groups%rowtype;
  v_round public.golf_reservations%rowtype;
  v_completion_count integer;
  v_completion_date date;
  v_save_payload jsonb;
begin
  if (select auth.uid()) is null or not public.has_app_role(array['manager','admin']) then
    raise exception 'Manager or administrator role required' using errcode='42501';
  end if;
  if jsonb_typeof(p_reservation) is distinct from 'object' or jsonb_typeof(p_payments) is distinct from 'array' then
    raise exception 'Invalid booking group payload' using errcode='22023';
  end if;
  if jsonb_array_length(p_payments)>100 then raise exception 'Too many payments' using errcode='22023'; end if;
  select * into v_group from public.golf_booking_groups where id=p_group_id for update;
  if not found then raise exception 'Booking group not found' using errcode='P0002'; end if;
  if p_expected_version is distinct from v_group.version then
    raise exception '다른 기기에서 예약이 변경되었습니다. 새로고침해 주세요. / Dữ liệu đã thay đổi. Vui lòng tải lại.' using errcode='40001';
  end if;
  perform id from public.golf_reservations where booking_group_id=p_group_id order by id for update;
  select * into v_round from public.golf_reservations where id=p_round_id and booking_group_id=p_group_id;
  if not found then raise exception 'Round does not belong to this booking' using errcode='42501'; end if;
  if nullif(p_reservation->>'expected_updated_at','')::timestamptz is distinct from v_round.updated_at then
    raise exception '다른 기기에서 일정이 변경되었습니다. / Lịch đã thay đổi. Vui lòng tải lại.' using errcode='40001';
  end if;
  if btrim(p_reservation->>'counterparty_name') is distinct from v_round.counterparty_name
    or btrim(p_reservation->>'customer_type') is distinct from v_round.customer_type then
    raise exception '묶음 거래처와 구분은 변경할 수 없습니다. / Không thể đổi đối tác hoặc loại khách của nhóm.' using errcode='23514';
  end if;
  if exists(select 1 from public.golf_reservations r where r.booking_group_id=p_group_id
    and (r.deposit_amount_vnd<>0 or r.final_received_amount_vnd is not null or r.withdrawal_amount_vnd is not null
      or exists(select 1 from public.golf_reservation_payments p where p.reservation_id=r.id))) then
    raise exception 'Legacy round payments require reconciliation before grouped editing' using errcode='23514';
  end if;
  perform id from public.golf_booking_group_payments where booking_group_id=p_group_id order by id for update;
  if exists(select 1 from jsonb_to_recordset(p_payments) as p(payment_method text,amount_vnd bigint)
    where p.payment_method='cash' and p.amount_vnd>=5000000) then
    raise exception '5,000,000 VND 이상은 은행 거래가 필요합니다. / Giao dịch từ 5.000.000 VND cần thanh toán qua ngân hàng.' using errcode='23514';
  end if;
  if exists(select 1 from jsonb_to_recordset(p_payments) as p(id uuid,payment_kind text,amount_vnd bigint,payment_date date,payment_method text,completes_booking boolean,sort_order integer)
    where p.payment_kind is null or p.payment_kind not in ('deposit','receipt')
    or p.amount_vnd is null or p.amount_vnd not between 0 and 9007199254740991 or p.payment_date is null
    or (p.payment_method is not null and p.payment_method not in ('bank','cash','card'))
    or (p.amount_vnd>0 and p.payment_method is null) or coalesce(p.sort_order,0) not between 0 and 1000) then
    raise exception 'Invalid booking payment' using errcode='23514';
  end if;
  if exists(select 1 from jsonb_to_recordset(p_payments) as p(id uuid) where p.id is not null and not exists(
    select 1 from public.golf_booking_group_payments e where e.id=p.id and e.booking_group_id=p_group_id)) then
    raise exception 'Payment does not belong to this booking' using errcode='42501';
  end if;
  if exists(select p.id from jsonb_to_recordset(p_payments) as p(id uuid) where p.id is not null group by p.id having count(*)>1) then
    raise exception 'Duplicate booking payment' using errcode='23505';
  end if;
  select count(*) filter(where completes_booking),max(payment_date) filter(where completes_booking)
    into v_completion_count,v_completion_date
    from jsonb_to_recordset(p_payments) as p(completes_booking boolean,payment_date date);
  if v_completion_count>1 then raise exception 'Only one payment may complete the booking' using errcode='23505'; end if;
  if v_completion_date < (select min(payment_date) from jsonb_to_recordset(p_payments) as p(payment_kind text,payment_date date) where payment_kind='deposit') then
    raise exception '완료일은 계약금 입금일 이후여야 합니다. / Ngày hoàn tất không được trước ngày đặt cọc.' using errcode='23514';
  end if;
  if (select coalesce(sum(p.amount_vnd),0) from jsonb_to_recordset(p_payments) as p(amount_vnd bigint))>9007199254740991 then
    raise exception 'Payment total is too large' using errcode='23514';
  end if;
  -- Validate and edit only the selected round. Empty legacy payment input does
  -- not allocate or duplicate the group's money into any child reservation.
  v_save_payload := p_reservation;
  if v_completion_count=0 and v_group.completed_at is not null then
    -- Reverse completion first so a single atomic save can also clear a cost.
    -- The original optimistic timestamp was checked above, before this update.
    update public.golf_reservations set group_completed=false where booking_group_id=p_group_id and group_completed;
    select p_reservation || jsonb_build_object('expected_updated_at',updated_at) into v_save_payload
      from public.golf_reservations where id=p_round_id;
  end if;
  perform * from private.save_golf_reservation_with_payments_single_impl(p_round_id,v_save_payload,'[]'::jsonb);
  if v_completion_count=1 and exists(select 1 from public.golf_reservations where booking_group_id=p_group_id and course_total_vnd is null) then
    raise exception '모든 일정의 원가를 입력한 뒤 완료해 주세요. / Vui lòng nhập giá vốn cho tất cả lịch trước khi hoàn tất.' using errcode='23514';
  end if;
  update public.golf_booking_group_payments set completes_booking=false where booking_group_id=p_group_id and completes_booking;
  update public.golf_booking_group_payments e set payment_kind=p.payment_kind,amount_vnd=p.amount_vnd,
    payment_date=p.payment_date,payment_method=p.payment_method,completes_booking=coalesce(p.completes_booking,false),
    sort_order=coalesce(p.sort_order,0),updated_at=now(),updated_by=auth.uid()
  from jsonb_to_recordset(p_payments) as p(id uuid,payment_kind text,amount_vnd bigint,payment_date date,payment_method text,completes_booking boolean,sort_order integer)
  where e.id=p.id and e.booking_group_id=p_group_id;
  delete from public.golf_booking_group_payments e where e.booking_group_id=p_group_id
    and not exists(select 1 from jsonb_to_recordset(p_payments) as p(id uuid) where p.id=e.id);
  insert into public.golf_booking_group_payments(booking_group_id,payment_kind,amount_vnd,payment_date,payment_method,completes_booking,sort_order,created_by,updated_by)
    select p_group_id,p.payment_kind,p.amount_vnd,p.payment_date,p.payment_method,coalesce(p.completes_booking,false),coalesce(p.sort_order,0),auth.uid(),auth.uid()
    from jsonb_to_recordset(p_payments) as p(id uuid,payment_kind text,amount_vnd bigint,payment_date date,payment_method text,completes_booking boolean,sort_order integer) where p.id is null;
  update public.golf_booking_groups set version=version+1,updated_at=now(),
    completed_at=case when v_completion_count=1 then coalesce(completed_at,now()) else null end,
    completion_date=v_completion_date where id=p_group_id;
  -- Existing per-round triggers keep course debits and partner offsets idempotent.
  update public.golf_reservations set group_completed=(v_completion_count=1)
    where booking_group_id=p_group_id and group_completed is distinct from (v_completion_count=1);
  return query select r.id,r.status from public.golf_reservations r where r.id=p_round_id;
end $$;

create function private.delete_golf_booking_round_impl(p_reservation_id uuid,p_expected_version bigint) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_group_id uuid; v_version bigint; v_count integer;
begin
  if (select auth.uid()) is null or not public.has_app_role(array['manager','admin']) then
    raise exception 'Manager or administrator role required' using errcode='42501';
  end if;
  select booking_group_id into v_group_id from public.golf_reservations where id=p_reservation_id;
  if v_group_id is null then raise exception 'Grouped round not found' using errcode='P0002'; end if;
  select version into v_version from public.golf_booking_groups where id=v_group_id for update;
  if v_version is distinct from p_expected_version then raise exception '다른 기기에서 예약이 변경되었습니다. / Dữ liệu đã thay đổi. Vui lòng tải lại.' using errcode='40001'; end if;
  perform id from public.golf_reservations where booking_group_id=v_group_id order by id for update;
  if not exists(select 1 from public.golf_reservations where id=p_reservation_id and booking_group_id=v_group_id) then
    raise exception 'Grouped round not found' using errcode='P0002';
  end if;
  select count(*) into v_count from public.golf_reservations where booking_group_id=v_group_id;
  if v_count=1 and exists(select 1 from public.golf_booking_group_payments where booking_group_id=v_group_id) then
    raise exception '공통 입금이 있는 마지막 일정은 삭제할 수 없습니다. / Không thể xóa lịch cuối khi còn khoản thu chung.' using errcode='23514';
  end if;
  delete from public.golf_reservations where id=p_reservation_id;
  if v_count=1 then delete from public.golf_booking_groups where id=v_group_id;
  else update public.golf_booking_groups set version=version+1,updated_at=now() where id=v_group_id; end if;
  return p_reservation_id;
end $$;

create function public.save_golf_booking_group(p_group_id uuid,p_round_id uuid,p_reservation jsonb,p_payments jsonb,p_expected_version bigint)
returns table(saved_id uuid,saved_status text) language sql security invoker set search_path = '' as $$
  select * from private.save_golf_booking_group_impl(p_group_id,p_round_id,p_reservation,p_payments,p_expected_version)
$$;
create function public.delete_golf_booking_round(p_reservation_id uuid,p_expected_version bigint)
returns uuid language sql security invoker set search_path = '' as $$
  select private.delete_golf_booking_round_impl(p_reservation_id,p_expected_version)
$$;
revoke all on function private.save_golf_booking_group_impl(uuid,uuid,jsonb,jsonb,bigint),private.delete_golf_booking_round_impl(uuid,bigint),
  public.save_golf_booking_group(uuid,uuid,jsonb,jsonb,bigint),public.delete_golf_booking_round(uuid,bigint) from public,anon,authenticated;
grant execute on function private.save_golf_booking_group_impl(uuid,uuid,jsonb,jsonb,bigint),private.delete_golf_booking_round_impl(uuid,bigint),
  public.save_golf_booking_group(uuid,uuid,jsonb,jsonb,bigint),public.delete_golf_booking_round(uuid,bigint) to authenticated;
notify pgrst,'reload schema';
commit;
