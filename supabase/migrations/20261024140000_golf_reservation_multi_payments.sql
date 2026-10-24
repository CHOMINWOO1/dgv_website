create table if not exists public.golf_reservation_payments (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.golf_reservations(id) on delete cascade,
  payment_kind text not null
    constraint golf_reservation_payments_kind_check
    check (payment_kind in ('deposit', 'receipt', 'withdrawal')),
  amount_vnd bigint not null
    constraint golf_reservation_payments_amount_check
    check (amount_vnd between 0 and 9007199254740991),
  payment_date date not null,
  payment_method text
    constraint golf_reservation_payments_method_check
    check (payment_method is null or payment_method in ('bank', 'cash', 'card')),
  completes_booking boolean not null default false,
  sort_order integer not null default 0
    constraint golf_reservation_payments_sort_order_check
    check (sort_order between 0 and 1000),
  legacy_import boolean not null default false,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  updated_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint golf_reservation_payments_completion_kind_check
    check (not completes_booking or payment_kind in ('deposit', 'receipt')),
  constraint golf_reservation_payments_method_required_check
    check (amount_vnd = 0 or payment_method is not null or legacy_import),
  constraint golf_reservation_payments_large_cash_check
    check (not (payment_method = 'cash' and amount_vnd >= 5000000))
);

comment on table public.golf_reservation_payments is
  'Multiple customer receipts and golf-course payments for each golf reservation.';
comment on column public.golf_reservation_payments.payment_kind is
  'deposit = customer deposit, receipt = additional customer receipt, withdrawal = golf-course payment.';
comment on column public.golf_reservation_payments.payment_method is
  'bank, cash, card; NULL is retained only for legacy imported transactions or 0 VND.';
comment on column public.golf_reservation_payments.legacy_import is
  'True only for transactions copied from pre-ledger golf reservation summary columns.';

create index if not exists golf_reservation_payments_reservation_date_idx
  on public.golf_reservation_payments(reservation_id, payment_kind, payment_date, sort_order, id);
create unique index if not exists golf_reservation_payments_one_completion_idx
  on public.golf_reservation_payments(reservation_id)
  where completes_booking;

alter table public.golf_reservation_payments enable row level security;

drop policy if exists golf_reservation_payments_manager_admin_read on public.golf_reservation_payments;
create policy golf_reservation_payments_manager_admin_read
  on public.golf_reservation_payments for select to authenticated
  using ((select public.current_app_role()) in ('manager', 'admin'));

drop policy if exists golf_reservation_payments_manager_admin_insert on public.golf_reservation_payments;
create policy golf_reservation_payments_manager_admin_insert
  on public.golf_reservation_payments for insert to authenticated
  with check (
    (select public.current_app_role()) in ('manager', 'admin')
    and created_by = (select auth.uid())
    and updated_by = (select auth.uid())
    and not legacy_import
  );

drop policy if exists golf_reservation_payments_manager_admin_update on public.golf_reservation_payments;
create policy golf_reservation_payments_manager_admin_update
  on public.golf_reservation_payments for update to authenticated
  using ((select public.current_app_role()) in ('manager', 'admin'))
  with check ((select public.current_app_role()) in ('manager', 'admin'));

drop policy if exists golf_reservation_payments_manager_admin_delete on public.golf_reservation_payments;
create policy golf_reservation_payments_manager_admin_delete
  on public.golf_reservation_payments for delete to authenticated
  using ((select public.current_app_role()) in ('manager', 'admin'));

revoke all on table public.golf_reservation_payments from public, anon, authenticated;
grant select on table public.golf_reservation_payments to authenticated;

create or replace function private.touch_golf_reservation_payment_audit()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  new.updated_by := (select auth.uid());
  return new;
end;
$$;

create index if not exists golf_reservation_payments_created_by_idx
  on public.golf_reservation_payments(created_by)
  where created_by is not null;
create index if not exists golf_reservation_payments_updated_by_idx
  on public.golf_reservation_payments(updated_by)
  where updated_by is not null;

create or replace function private.prevent_golf_payment_legacy_spoof()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' and new.legacy_import then
    raise exception 'Legacy payment rows cannot be created by clients' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and new.legacy_import is distinct from old.legacy_import then
    raise exception 'Legacy payment marker cannot be changed' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists golf_reservation_payments_touch_audit on public.golf_reservation_payments;
create trigger golf_reservation_payments_touch_audit
before update on public.golf_reservation_payments
for each row execute function private.touch_golf_reservation_payment_audit();

insert into public.golf_reservation_payments (
  reservation_id, payment_kind, amount_vnd, payment_date, payment_method,
  completes_booking, sort_order, legacy_import,
  created_by, updated_by, created_at, updated_at
)
select
  gr.id, 'deposit', gr.deposit_amount_vnd, gr.deposit_received_date, null,
  false, 0, true,
  gr.created_by, gr.updated_by, gr.created_at, gr.updated_at
from public.golf_reservations gr
where gr.deposit_amount_vnd > 0
  and not exists (
    select 1 from public.golf_reservation_payments p
    where p.reservation_id = gr.id and p.payment_kind = 'deposit' and p.legacy_import
  );

insert into public.golf_reservation_payments (
  reservation_id, payment_kind, amount_vnd, payment_date, payment_method,
  completes_booking, sort_order, legacy_import,
  created_by, updated_by, created_at, updated_at
)
select
  gr.id, 'receipt', gr.final_received_amount_vnd - gr.deposit_amount_vnd,
  gr.final_received_date, null,
  true, 0, true,
  gr.created_by, gr.updated_by, gr.created_at, gr.updated_at
from public.golf_reservations gr
where gr.final_received_amount_vnd is not null
  and gr.final_received_date is not null
  and not exists (
    select 1 from public.golf_reservation_payments p
    where p.reservation_id = gr.id and p.completes_booking
  );

insert into public.golf_reservation_payments (
  reservation_id, payment_kind, amount_vnd, payment_date, payment_method,
  completes_booking, sort_order, legacy_import,
  created_by, updated_by, created_at, updated_at
)
select
  gr.id, 'withdrawal', gr.withdrawal_amount_vnd, gr.withdrawal_date, null,
  false, 0, true,
  gr.created_by, gr.updated_by, gr.created_at, gr.updated_at
from public.golf_reservations gr
where gr.withdrawal_amount_vnd is not null
  and gr.withdrawal_date is not null
  and not exists (
    select 1 from public.golf_reservation_payments p
    where p.reservation_id = gr.id and p.payment_kind = 'withdrawal' and p.legacy_import
  );

do $$
begin
  if exists (
    select 1
    from public.golf_reservations gr
    left join (
      select reservation_id,
        coalesce(sum(amount_vnd) filter (where payment_kind = 'deposit'), 0) as deposit_total,
        coalesce(sum(amount_vnd) filter (where payment_kind in ('deposit', 'receipt')), 0) as received_total,
        count(*) filter (where payment_kind = 'withdrawal') as withdrawal_count,
        coalesce(sum(amount_vnd) filter (where payment_kind = 'withdrawal'), 0) as withdrawal_total,
        max(payment_date) filter (where completes_booking) as completed_date
      from public.golf_reservation_payments
      group by reservation_id
    ) p on p.reservation_id = gr.id
    where coalesce(p.deposit_total, 0) <> gr.deposit_amount_vnd
       or coalesce(p.received_total, 0) <> coalesce(gr.final_received_amount_vnd, gr.deposit_amount_vnd)
       or (
         gr.withdrawal_amount_vnd is null and coalesce(p.withdrawal_count, 0) <> 0
       )
       or (
         gr.withdrawal_amount_vnd is not null
         and coalesce(p.withdrawal_total, 0) <> gr.withdrawal_amount_vnd
       )
       or (
         gr.final_received_date is not null
         and p.completed_date is distinct from gr.final_received_date
       )
  ) then
    raise exception 'Golf payment ledger backfill does not match reservation summaries';
  end if;
  if exists (select 1 from public.golf_reservation_payments where payment_method is not null and legacy_import) then
    raise exception 'Legacy golf payment methods must remain NULL';
  end if;
end;
$$;

drop trigger if exists golf_reservation_payments_prevent_legacy_spoof on public.golf_reservation_payments;
create trigger golf_reservation_payments_prevent_legacy_spoof
before insert or update on public.golf_reservation_payments
for each row execute function private.prevent_golf_payment_legacy_spoof();

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

  delete from public.golf_reservation_payments existing
  where existing.reservation_id = v_id
    and not exists (
      select 1
      from jsonb_to_recordset(coalesce(p_payments, '[]'::jsonb)) as incoming(id uuid)
      where incoming.id = existing.id
    );

  return query
  select gr.id, gr.status
  from public.golf_reservations gr
  where gr.id = v_id;
end;
$$;

create or replace function public.save_golf_reservation_with_payments(
  p_reservation_id uuid,
  p_reservation jsonb,
  p_payments jsonb
)
returns table(saved_id uuid, saved_status text)
language sql
security invoker
set search_path = ''
as $$
  select *
  from private.save_golf_reservation_with_payments_impl(
    p_reservation_id,
    p_reservation,
    p_payments
  )
$$;

revoke all on function private.save_golf_reservation_with_payments_impl(uuid, jsonb, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.save_golf_reservation_with_payments(uuid, jsonb, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function private.save_golf_reservation_with_payments_impl(uuid, jsonb, jsonb)
  to authenticated;
grant execute on function public.save_golf_reservation_with_payments(uuid, jsonb, jsonb)
  to authenticated;

