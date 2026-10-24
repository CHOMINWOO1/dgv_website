-- Correct the transaction ordering used by the multi-payment RPC.
-- Existing child rows are updated/deleted first; new rows are inserted last,
-- so generated UUIDs cannot be removed by the stale-row cleanup.
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


