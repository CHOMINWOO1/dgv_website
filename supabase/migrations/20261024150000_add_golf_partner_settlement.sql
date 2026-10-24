-- Route each golf-reservation cost to either a managed golf-course wallet or
-- the currently supported settlement partner. Existing rows inherit the
-- direct golf-course route through the constant default; this migration does
-- not rewrite reservations or create partner offsets for historical rows.

set lock_timeout = '5s';

alter table public.golf_reservations
  add column cost_settlement_type text not null default 'golf_course',
  add column cost_partner_name text;

alter table public.golf_reservations
  add constraint golf_reservations_cost_settlement_type_check
    check (cost_settlement_type in ('golf_course', 'partner')) not valid,
  add constraint golf_reservations_cost_partner_route_check
    check (
      (cost_settlement_type = 'golf_course' and cost_partner_name is null)
      or
      (cost_settlement_type = 'partner' and cost_partner_name = 'Chị Oanh')
    ) not valid;

alter table public.golf_reservations
  validate constraint golf_reservations_cost_settlement_type_check;
alter table public.golf_reservations
  validate constraint golf_reservations_cost_partner_route_check;

create index golf_reservations_cost_settlement_date_idx
  on public.golf_reservations (cost_settlement_type, golf_date desc);

create index golf_reservations_cost_partner_date_idx
  on public.golf_reservations (cost_partner_name, golf_date desc)
  where cost_settlement_type = 'partner';

-- One durable current-state row is retained per reservation. Reopening or
-- rerouting a completed booking marks the row inactive instead of deleting it,
-- so applied/reversed timestamps remain available for reconciliation.
create table public.golf_partner_reservation_offsets (
  reservation_id uuid primary key
    references public.golf_reservations (id) on delete cascade,
  partner_name text not null,
  golf_date date not null,
  amount_vnd bigint not null,
  active boolean not null default true,
  applied_at timestamp with time zone not null default now(),
  reversed_at timestamp with time zone,
  updated_at timestamp with time zone not null default now(),

  constraint golf_partner_reservation_offsets_partner_check
    check (partner_name = 'Chị Oanh'),
  constraint golf_partner_reservation_offsets_amount_check
    check (amount_vnd between 0 and 9007199254740991),
  constraint golf_partner_reservation_offsets_state_check
    check (
      (active and reversed_at is null)
      or
      (not active and reversed_at is not null)
    )
);

create index golf_partner_reservation_offsets_partner_date_idx
  on public.golf_partner_reservation_offsets
    (partner_name, golf_date desc, applied_at desc);

alter table public.golf_partner_reservation_offsets enable row level security;

-- Explicit privileges are required when automatic grants for new Data API
-- tables are disabled. Clients may read through RLS; only trusted trigger code
-- and service-role maintenance may write offset rows.
revoke all on table public.golf_partner_reservation_offsets
from public, anon, authenticated, service_role;

grant usage on schema public to authenticated, service_role;
grant insert (cost_settlement_type, cost_partner_name)
  on table public.golf_reservations to authenticated;
grant update (cost_settlement_type, cost_partner_name)
  on table public.golf_reservations to authenticated;
grant select on table public.golf_partner_reservation_offsets to authenticated;
grant select, insert, update, delete
  on table public.golf_partner_reservation_offsets to service_role;

create policy golf_partner_reservation_offsets_manager_admin_read
on public.golf_partner_reservation_offsets
for select to authenticated
using ((select public.current_app_role()) in ('manager', 'admin'));

-- Direct golf-course deductions now apply only to reservations explicitly
-- routed to golf_course. The existing current-state charge row is reversed on
-- reopening or partner rerouting and can be reactivated later.
create or replace function private.sync_golf_course_budget_reservation_charge()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_has_charge boolean := false;
  v_direct_tracked_course boolean;
begin
  v_direct_tracked_course :=
    new.cost_settlement_type = 'golf_course'
    and new.golf_course in ('AT1200', 'SAM', 'PALACE');

  if tg_op = 'INSERT' then
    if new.status = 'completed' and v_direct_tracked_course then
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
    if v_direct_tracked_course then
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
    else
      update public.golf_course_budget_reservation_charges charge
      set active = false,
          reversed_at = coalesce(charge.reversed_at, now()),
          updated_at = now()
      where charge.reservation_id = new.id
        and charge.active;
    end if;
  elsif old.status = 'completed' and new.status <> 'completed' then
    update public.golf_course_budget_reservation_charges charge
    set active = false,
        reversed_at = now(),
        updated_at = now()
    where charge.reservation_id = new.id
      and charge.active;
  elsif new.status = 'completed' then
    if not v_direct_tracked_course then
      update public.golf_course_budget_reservation_charges charge
      set active = false,
          reversed_at = coalesce(charge.reversed_at, now()),
          updated_at = now()
      where charge.reservation_id = new.id
        and charge.active;
    else
      -- Keep the earlier migration's allowance for untouched legacy completed
      -- rows whose original course cost was NULL. New completions, reroutes and
      -- course changes still require a cost.
      if new.course_total_vnd is null
         and (
           old.course_total_vnd is not null
           or old.golf_course is distinct from new.golf_course
           or old.cost_settlement_type is distinct from 'golf_course'
           or not v_has_charge
         ) then
        raise exception
          '골프장 원가는 비울 수 없습니다. / Không thể để trống giá sân.'
          using errcode = '23514';
      end if;

      if v_has_charge then
        update public.golf_course_budget_reservation_charges charge
        set golf_course = new.golf_course,
            golf_date = new.golf_date,
            amount_vnd = new.course_total_vnd,
            active = true,
            historical = case when charge.active then charge.historical else false end,
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
      else
        insert into public.golf_course_budget_reservation_charges (
          reservation_id, golf_course, golf_date, amount_vnd
        ) values (
          new.id, new.golf_course, new.golf_date, new.course_total_vnd
        );
      end if;
    end if;
  end if;

  return new;
end;
$$;

-- Partner offsets mirror the direct-course ledger's transition behavior, but
-- remain a separate current-state audit trail used for partner receivables.
create or replace function private.sync_golf_partner_reservation_offset()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'completed' and new.cost_settlement_type = 'partner' then
      if new.course_total_vnd is null then
        raise exception
          '정산 거래처 원가를 입력한 후 완료 처리해 주세요. / Vui lòng nhập giá đối tác trước khi hoàn tất.'
          using errcode = '23514';
      end if;

      insert into public.golf_partner_reservation_offsets (
        reservation_id, partner_name, golf_date, amount_vnd
      ) values (
        new.id, new.cost_partner_name, new.golf_date, new.course_total_vnd
      );
    end if;
    return new;
  end if;

  if old.status <> 'completed' and new.status = 'completed' then
    if new.cost_settlement_type = 'partner' then
      if new.course_total_vnd is null then
        raise exception
          '정산 거래처 원가를 입력한 후 완료 처리해 주세요. / Vui lòng nhập giá đối tác trước khi hoàn tất.'
          using errcode = '23514';
      end if;

      insert into public.golf_partner_reservation_offsets (
        reservation_id, partner_name, golf_date, amount_vnd
      ) values (
        new.id, new.cost_partner_name, new.golf_date, new.course_total_vnd
      )
      on conflict (reservation_id) do update
      set partner_name = excluded.partner_name,
          golf_date = excluded.golf_date,
          amount_vnd = excluded.amount_vnd,
          active = true,
          applied_at = now(),
          reversed_at = null,
          updated_at = now();
    else
      update public.golf_partner_reservation_offsets partner_offset
      set active = false,
          reversed_at = coalesce(partner_offset.reversed_at, now()),
          updated_at = now()
      where partner_offset.reservation_id = new.id
        and partner_offset.active;
    end if;
  elsif old.status = 'completed' and new.status <> 'completed' then
    update public.golf_partner_reservation_offsets partner_offset
    set active = false,
        reversed_at = now(),
        updated_at = now()
    where partner_offset.reservation_id = new.id
      and partner_offset.active;
  elsif new.status = 'completed' then
    if new.cost_settlement_type = 'partner' then
      if new.course_total_vnd is null then
        raise exception
          '정산 거래처 원가는 비울 수 없습니다. / Không thể để trống giá đối tác.'
          using errcode = '23514';
      end if;

      insert into public.golf_partner_reservation_offsets (
        reservation_id, partner_name, golf_date, amount_vnd
      ) values (
        new.id, new.cost_partner_name, new.golf_date, new.course_total_vnd
      )
      on conflict (reservation_id) do update
      set partner_name = excluded.partner_name,
          golf_date = excluded.golf_date,
          amount_vnd = excluded.amount_vnd,
          active = true,
          applied_at = case
            when golf_partner_reservation_offsets.active
              then golf_partner_reservation_offsets.applied_at
            else now()
          end,
          reversed_at = null,
          updated_at = now()
      where golf_partner_reservation_offsets.partner_name
              is distinct from excluded.partner_name
         or golf_partner_reservation_offsets.golf_date
              is distinct from excluded.golf_date
         or golf_partner_reservation_offsets.amount_vnd
              is distinct from excluded.amount_vnd
         or not golf_partner_reservation_offsets.active;
    else
      update public.golf_partner_reservation_offsets partner_offset
      set active = false,
          reversed_at = coalesce(partner_offset.reversed_at, now()),
          updated_at = now()
      where partner_offset.reservation_id = new.id
        and partner_offset.active;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists golf_reservations_sync_partner_offset
  on public.golf_reservations;
create trigger golf_reservations_sync_partner_offset
after insert or update on public.golf_reservations
for each row execute function private.sync_golf_partner_reservation_offset();

revoke all on function private.sync_golf_course_budget_reservation_charge()
from public, anon, authenticated, service_role;
revoke all on function private.sync_golf_partner_reservation_offset()
from public, anon, authenticated, service_role;

comment on column public.golf_reservations.cost_settlement_type is
  'Cost destination: golf_course for a managed course wallet, or partner for partner receivables.';
comment on column public.golf_reservations.cost_partner_name is
  'Settlement partner when cost_settlement_type is partner; currently only exact value Chị Oanh is supported.';
comment on table public.golf_partner_reservation_offsets is
  'Current partner-cost offset per reservation; reversed rows are retained for reconciliation.';
comment on function private.sync_golf_course_budget_reservation_charge() is
  'Tracks only direct golf-course costs across completion, reopening, rerouting, course and cost edits.';
comment on function private.sync_golf_partner_reservation_offset() is
  'Tracks partner offsets across completion, reopening, rerouting, date and cost edits.';

-- Keep the established transactional save path and all of its payment
-- validation/locking order. Only the two new routing fields are added. Updates
-- from an older cached client that omits cost_settlement_type retain the
-- reservation's current route; new reservations still default to golf_course.
create or replace function private.save_golf_reservation_with_payments_impl(
  p_reservation_id uuid,
  p_reservation jsonb,
  p_payments jsonb
)
returns table(saved_id uuid, saved_status text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_deposit_count integer;
  v_withdrawal_count integer;
  v_completion_count integer;
  v_deposit_total bigint;
  v_received_total bigint;
  v_withdrawal_total bigint;
  v_deposit_date date;
  v_completion_date date;
  v_withdrawal_date date;
  v_expected_updated_at timestamptz;
  v_current_updated_at timestamptz;
begin
  if (select auth.uid()) is null or not public.has_app_role(array['manager', 'admin']) then
    raise exception 'Manager or administrator role required' using errcode = '42501';
  end if;
  if jsonb_typeof(p_reservation) is distinct from 'object'
     or jsonb_typeof(coalesce(p_payments, '[]'::jsonb)) is distinct from 'array' then
    raise exception 'Invalid golf reservation payload' using errcode = '22023';
  end if;
  if jsonb_array_length(coalesce(p_payments, '[]'::jsonb)) > 100 then
    raise exception 'Too many golf payment rows' using errcode = '22023';
  end if;

  if p_reservation_id is not null then
    v_expected_updated_at := nullif(p_reservation ->> 'expected_updated_at', '')::timestamptz;
    select gr.updated_at into v_current_updated_at
    from public.golf_reservations gr
    where gr.id = p_reservation_id
    for update;
    if not found then
      raise exception 'Golf reservation not found' using errcode = 'P0002';
    end if;
    if v_expected_updated_at is null or v_expected_updated_at is distinct from v_current_updated_at then
      raise exception '다른 기기에서 예약이 변경되었습니다. 새로고침 후 다시 시도해 주세요. / Dữ liệu đã được thay đổi trên thiết bị khác. Vui lòng tải lại.'
        using errcode = '40001';
    end if;
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(coalesce(p_payments, '[]'::jsonb)) as p(
      id uuid, payment_kind text, amount_vnd bigint, payment_date date, payment_method text,
      completes_booking boolean, sort_order integer
    )
    where p.payment_kind not in ('deposit', 'receipt', 'withdrawal')
       or p.amount_vnd is null
       or p.amount_vnd < 0
       or p.amount_vnd > 9007199254740991
       or p.payment_date is null
       or (p.payment_method is not null and p.payment_method not in ('bank', 'cash', 'card'))
       or (
         p.amount_vnd > 0
         and p.payment_method is null
         and not exists (
           select 1
           from public.golf_reservation_payments existing
           where existing.id = p.id
             and existing.reservation_id = p_reservation_id
             and existing.legacy_import
             and existing.payment_kind = p.payment_kind
             and existing.amount_vnd = p.amount_vnd
             and existing.payment_date = p.payment_date
         )
       )
       or (p.payment_method = 'cash' and p.amount_vnd >= 5000000)
       or coalesce(p.sort_order, 0) not between 0 and 1000
       or (coalesce(p.completes_booking, false) and p.payment_kind = 'withdrawal')
  ) then
    raise exception 'Invalid golf payment row' using errcode = '23514';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(coalesce(p_payments, '[]'::jsonb)) as p(id uuid)
    where p.id is not null
      and not exists (
        select 1
        from public.golf_reservation_payments existing
        where existing.id = p.id
          and existing.reservation_id = p_reservation_id
      )
  ) then
    raise exception 'Golf payment row does not belong to this reservation' using errcode = '42501';
  end if;

  if exists (
    select p.id
    from jsonb_to_recordset(coalesce(p_payments, '[]'::jsonb)) as p(id uuid)
    where p.id is not null
    group by p.id
    having count(*) > 1
  ) then
    raise exception 'Duplicate golf payment row' using errcode = '23505';
  end if;

  select
    count(*) filter (where payment_kind = 'deposit'),
    count(*) filter (where payment_kind = 'withdrawal'),
    count(*) filter (where coalesce(completes_booking, false)),
    coalesce(sum(amount_vnd) filter (where payment_kind = 'deposit'), 0),
    coalesce(sum(amount_vnd) filter (where payment_kind in ('deposit', 'receipt')), 0),
    coalesce(sum(amount_vnd) filter (where payment_kind = 'withdrawal'), 0),
    min(payment_date) filter (where payment_kind = 'deposit'),
    max(payment_date) filter (where coalesce(completes_booking, false)),
    max(payment_date) filter (where payment_kind = 'withdrawal')
  into
    v_deposit_count, v_withdrawal_count, v_completion_count,
    v_deposit_total, v_received_total, v_withdrawal_total,
    v_deposit_date, v_completion_date, v_withdrawal_date
  from jsonb_to_recordset(coalesce(p_payments, '[]'::jsonb)) as p(
    id uuid, payment_kind text, amount_vnd bigint, payment_date date, payment_method text,
    completes_booking boolean, sort_order integer
  );

  if v_completion_count > 1 then
    raise exception 'Only one payment may complete a booking' using errcode = '23505';
  end if;

  if v_deposit_count = 0 then
    if p_reservation_id is null then
      v_deposit_date := ((now() at time zone 'Asia/Ho_Chi_Minh'))::date;
    else
      select gr.deposit_received_date into v_deposit_date
      from public.golf_reservations gr
      where gr.id = p_reservation_id
      for update;
    end if;
  end if;

  if p_reservation_id is null then
    insert into public.golf_reservations (
      counterparty_name, representative_name, player_names_en, pax,
      golf_date, golf_time, golf_course, holes,
      guest_unit_price_vnd, smart_cart_note, course_unit_price_vnd,
      deposit_amount_vnd, deposit_received_date,
      final_received_amount_vnd, final_received_date,
      withdrawal_amount_vnd, withdrawal_date,
      cost_settlement_type, cost_partner_name,
      customer_type, note
    ) values (
      btrim(p_reservation ->> 'counterparty_name'),
      btrim(p_reservation ->> 'representative_name'),
      p_reservation ->> 'player_names_en',
      (p_reservation ->> 'pax')::integer,
      (p_reservation ->> 'golf_date')::date,
      (p_reservation ->> 'golf_time')::time,
      btrim(p_reservation ->> 'golf_course'),
      (p_reservation ->> 'holes')::integer,
      nullif(p_reservation ->> 'guest_unit_price_vnd', '')::bigint,
      nullif(btrim(p_reservation ->> 'smart_cart_note'), ''),
      nullif(p_reservation ->> 'course_unit_price_vnd', '')::bigint,
      v_deposit_total,
      v_deposit_date,
      case when v_completion_count = 1 then v_received_total else null end,
      case when v_completion_count = 1 then v_completion_date else null end,
      case when v_withdrawal_count > 0 then v_withdrawal_total else null end,
      case when v_withdrawal_count > 0 then v_withdrawal_date else null end,
      coalesce(
        nullif(btrim(p_reservation ->> 'cost_settlement_type'), ''),
        'golf_course'
      ),
      case
        when coalesce(
          nullif(btrim(p_reservation ->> 'cost_settlement_type'), ''),
          'golf_course'
        ) = 'partner'
          then nullif(btrim(p_reservation ->> 'cost_partner_name'), '')
        else null
      end,
      btrim(p_reservation ->> 'customer_type'),
      nullif(btrim(p_reservation ->> 'note'), '')
    )
    returning id into v_id;
  else
    update public.golf_reservations gr
    set counterparty_name = btrim(p_reservation ->> 'counterparty_name'),
        representative_name = btrim(p_reservation ->> 'representative_name'),
        player_names_en = p_reservation ->> 'player_names_en',
        pax = (p_reservation ->> 'pax')::integer,
        golf_date = (p_reservation ->> 'golf_date')::date,
        golf_time = (p_reservation ->> 'golf_time')::time,
        golf_course = btrim(p_reservation ->> 'golf_course'),
        holes = (p_reservation ->> 'holes')::integer,
        guest_unit_price_vnd = nullif(p_reservation ->> 'guest_unit_price_vnd', '')::bigint,
        smart_cart_note = nullif(btrim(p_reservation ->> 'smart_cart_note'), ''),
        course_unit_price_vnd = nullif(p_reservation ->> 'course_unit_price_vnd', '')::bigint,
        deposit_amount_vnd = v_deposit_total,
        deposit_received_date = v_deposit_date,
        final_received_amount_vnd = case when v_completion_count = 1 then v_received_total else null end,
        final_received_date = case when v_completion_count = 1 then v_completion_date else null end,
        withdrawal_amount_vnd = case when v_withdrawal_count > 0 then v_withdrawal_total else null end,
        withdrawal_date = case when v_withdrawal_count > 0 then v_withdrawal_date else null end,
        cost_settlement_type = case
          when p_reservation ? 'cost_settlement_type'
            then coalesce(
              nullif(btrim(p_reservation ->> 'cost_settlement_type'), ''),
              'golf_course'
            )
          else gr.cost_settlement_type
        end,
        cost_partner_name = case
          when p_reservation ? 'cost_settlement_type' then
            case
              when coalesce(
                nullif(btrim(p_reservation ->> 'cost_settlement_type'), ''),
                'golf_course'
              ) = 'partner'
                then nullif(btrim(p_reservation ->> 'cost_partner_name'), '')
              else null
            end
          else gr.cost_partner_name
        end,
        customer_type = btrim(p_reservation ->> 'customer_type'),
        note = nullif(btrim(p_reservation ->> 'note'), '')
    where gr.id = p_reservation_id
    returning gr.id into v_id;
    if v_id is null then
      raise exception 'Golf reservation not found' using errcode = 'P0002';
    end if;
  end if;

  update public.golf_reservation_payments
  set completes_booking = false
  where reservation_id = v_id and completes_booking;

  update public.golf_reservation_payments existing
  set payment_kind = incoming.payment_kind,
      amount_vnd = incoming.amount_vnd,
      payment_date = incoming.payment_date,
      payment_method = incoming.payment_method,
      completes_booking = coalesce(incoming.completes_booking, false),
      sort_order = coalesce(incoming.sort_order, 0)
  from jsonb_to_recordset(coalesce(p_payments, '[]'::jsonb)) as incoming(
    id uuid, payment_kind text, amount_vnd bigint, payment_date date, payment_method text,
    completes_booking boolean, sort_order integer
  )
  where incoming.id is not null
    and existing.id = incoming.id
    and existing.reservation_id = v_id;

  delete from public.golf_reservation_payments existing
  where existing.reservation_id = v_id
    and not exists (
      select 1
      from jsonb_to_recordset(coalesce(p_payments, '[]'::jsonb)) as incoming(id uuid)
      where incoming.id = existing.id
    );

  insert into public.golf_reservation_payments (
    reservation_id, payment_kind, amount_vnd, payment_date, payment_method,
    completes_booking, sort_order, legacy_import, created_by, updated_by
  )
  select
    v_id, p.payment_kind, p.amount_vnd, p.payment_date, p.payment_method,
    coalesce(p.completes_booking, false), coalesce(p.sort_order, 0),
    false, (select auth.uid()), (select auth.uid())
  from jsonb_to_recordset(coalesce(p_payments, '[]'::jsonb)) as p(
    id uuid, payment_kind text, amount_vnd bigint, payment_date date, payment_method text,
    completes_booking boolean, sort_order integer
  )
  where p.id is null;

  return query
  select gr.id, gr.status
  from public.golf_reservations gr
  where gr.id = v_id;
end;
$$;

revoke all on function private.save_golf_reservation_with_payments_impl(uuid, jsonb, jsonb)
from public, anon, authenticated, service_role;
grant execute on function private.save_golf_reservation_with_payments_impl(uuid, jsonb, jsonb)
to authenticated;

comment on function private.save_golf_reservation_with_payments_impl(uuid, jsonb, jsonb) is
  'Atomically saves a golf reservation, its cost route and ordered payment rows with optimistic locking.';

