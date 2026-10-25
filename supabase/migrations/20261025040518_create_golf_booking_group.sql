-- Additive creation endpoint only. No existing reservation, payment, balance,
-- group membership, role policy or existing save/delete function is changed.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Durable idempotency receipts deliberately have NO foreign keys to the actor,
-- group or first round. They survive deletion and retain the original result;
-- a retry can never recreate a deleted booking. Payload bodies are not stored.
create table private.golf_booking_create_requests (
  actor_id uuid not null,
  request_id uuid not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  saved_id uuid,
  saved_status text,
  booking_group_id uuid,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  primary key (actor_id, request_id),
  check (
    (saved_id is null and saved_status is null and booking_group_id is null and finished_at is null)
    or
    (saved_id is not null and saved_status is not null and saved_status in ('in_progress','completed')
      and booking_group_id is not null and finished_at is not null)
  )
);
alter table private.golf_booking_create_requests enable row level security;
revoke all on table private.golf_booking_create_requests from public,anon,authenticated,service_role;
comment on table private.golf_booking_create_requests is
  'Actor-scoped immutable creation receipts. Returned IDs/status are original snapshots, including after edits/deletion. No customer payload retained.';

create function private.create_golf_booking_group_impl(
  p_request_id uuid, p_label text, p_rounds jsonb, p_payments jsonb
) returns table(saved_id uuid, saved_status text, booking_group_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_label text := btrim(p_label);
  v_hash text;
  v_request private.golf_booking_create_requests%rowtype;
  v_round jsonb;
  v_field text;
  v_counterparty text;
  v_customer_type text;
  v_route text;
  v_group_id uuid;
  v_round_id uuid;
  v_first_id uuid;
  v_first_payload jsonb;
  v_status text;
begin
  if v_actor is null or not public.has_app_role(array['manager','admin']) then
    raise exception 'Manager or administrator role required' using errcode='42501';
  end if;
  if p_request_id is null then
    raise exception '새 예약 요청 ID가 필요합니다. / Cần mã yêu cầu đặt sân mới.' using errcode='22023';
  end if;
  if v_label is null or length(v_label) not between 1 and 160
    or jsonb_typeof(p_rounds) is distinct from 'array'
    or jsonb_typeof(p_payments) is distinct from 'array' then
    raise exception '묶음예약 입력을 확인해 주세요. / Vui lòng kiểm tra dữ liệu nhóm đặt sân.' using errcode='22023';
  end if;
  if jsonb_array_length(p_rounds) not between 2 and 30 or jsonb_array_length(p_payments)>100 then
    raise exception '일정은 2~30개, 입금은 최대 100개입니다. / Cần 2–30 lịch, tối đa 100 khoản thu.' using errcode='22023';
  end if;

  -- JSONB canonicalizes object keys. Array order remains intentional: it
  -- determines the first saved/editable round and the submitted payment order.
  v_hash := pg_catalog.encode(extensions.digest(pg_catalog.convert_to(
    jsonb_build_object('label',v_label,'rounds',p_rounds,'payments',p_payments)::text,
    'UTF8'), 'sha256'), 'hex');
  insert into private.golf_booking_create_requests(actor_id,request_id,request_hash)
    values (v_actor,p_request_id,v_hash)
    on conflict (actor_id,request_id) do nothing;
  -- The unique insert serializes simultaneous first submissions. A retry
  -- waits for the same actor/request row, then returns its committed receipt.
  select q.* into v_request from private.golf_booking_create_requests q
    where q.actor_id=v_actor and q.request_id=p_request_id for update;
  if v_request.request_hash is distinct from v_hash then
    raise exception '같은 요청 ID로 입력을 변경할 수 없습니다. 새 요청으로 저장해 주세요. / Mã yêu cầu đã dùng với dữ liệu khác. Vui lòng tạo yêu cầu mới.' using errcode='23505';
  end if;
  if v_request.saved_id is not null then
    return query select v_request.saved_id,v_request.saved_status,v_request.booking_group_id;
    return;
  end if;

  v_counterparty := btrim(p_rounds->0->>'counterparty_name');
  v_customer_type := btrim(p_rounds->0->>'customer_type');
  for v_round in select item.value from jsonb_array_elements(p_rounds) with ordinality as item(value,position) order by item.position loop
    if jsonb_typeof(v_round) is distinct from 'object' then
      raise exception '각 일정은 예약 항목이어야 합니다. / Mỗi lịch phải là một mục đặt sân.' using errcode='22023';
    end if;
    if exists(select 1 from jsonb_object_keys(v_round) as field(name) where field.name <> all(array[
      'counterparty_name','representative_name','player_names_en','pax','golf_date','golf_time','golf_course','holes',
      'guest_unit_price_vnd','smart_cart_note','course_unit_price_vnd','cost_settlement_type','cost_partner_name','customer_type','note'
    ]::text[])) then
      raise exception '새 일정에 허용되지 않는 필드가 있습니다. / Lịch mới có trường không được phép.' using errcode='22023';
    end if;
    foreach v_field in array array['counterparty_name','representative_name','player_names_en','golf_date','golf_time','golf_course','customer_type'] loop
      if jsonb_typeof(v_round->v_field) is distinct from 'string' or nullif(btrim(v_round->>v_field),'') is null then
        raise exception '일정 필수 항목을 입력해 주세요: % / Vui lòng nhập trường bắt buộc.',v_field using errcode='23514';
      end if;
    end loop;
    if btrim(v_round->>'counterparty_name') is distinct from v_counterparty
      or btrim(v_round->>'customer_type') is distinct from v_customer_type
      or v_customer_type not in ('individual','company') then
      raise exception '모든 일정의 거래처와 구분이 같아야 합니다. / Các lịch phải cùng đối tác và loại khách.' using errcode='23514';
    end if;
    if coalesce(v_round->>'pax','') !~ '^[0-9]{1,3}$'
      or coalesce(v_round->>'holes','') !~ '^[0-9]{1,2}$' then
      raise exception '인원과 홀 수를 정수로 입력해 주세요. / Vui lòng nhập số khách và số hố hợp lệ.' using errcode='23514';
    end if;
    if (v_round->>'pax')::integer not between 1 and 100 or (v_round->>'holes')::integer not between 1 and 72 then
      raise exception '인원 또는 홀 수가 범위를 벗어났습니다. / Số khách hoặc số hố vượt phạm vi.' using errcode='23514';
    end if;
    if (v_round->>'golf_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      or (v_round->>'golf_time') !~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$'
      or btrim(v_round->>'golf_course') not in ('AT1200','SAM','PALACE') then
      raise exception '골프 날짜, 시간과 골프장을 확인해 주세요. / Vui lòng kiểm tra ngày, giờ và sân golf.' using errcode='23514';
    end if;
    begin
      perform (v_round->>'golf_date')::date;
    exception when invalid_datetime_format or datetime_field_overflow then
      raise exception '올바른 골프 날짜를 입력해 주세요. / Vui lòng nhập ngày chơi hợp lệ.' using errcode='23514';
    end;
    v_route := coalesce(nullif(btrim(v_round->>'cost_settlement_type'),''),'golf_course');
    if v_route not in ('golf_course','partner')
      or (v_route='partner' and nullif(btrim(v_round->>'cost_partner_name'),'') is distinct from 'Chị Oanh')
      or (v_route='golf_course' and nullif(btrim(v_round->>'cost_partner_name'),'') is not null) then
      raise exception '원가 정산 방식을 확인해 주세요. / Vui lòng kiểm tra nơi quyết toán giá vốn.' using errcode='23514';
    end if;
  end loop;
  if exists(select 1 from jsonb_array_elements(p_payments) as item(value)
    where jsonb_typeof(item.value) is distinct from 'object' or item.value->>'id' is not null) then
    raise exception '새 예약에는 새 공통 입금만 등록할 수 있습니다. / Chỉ được thêm khoản thu mới cho nhóm mới.' using errcode='23514';
  end if;

  insert into public.golf_booking_groups(label) values(v_label) returning id into v_group_id;
  for v_round in select item.value from jsonb_array_elements(p_rounds) with ordinality as item(value,position) order by item.position loop
    select s.saved_id into v_round_id
      from private.save_golf_reservation_with_payments_single_impl(null,v_round,'[]'::jsonb) s;
    update public.golf_reservations r set booking_group_id=v_group_id where r.id=v_round_id;
    if v_first_id is null then v_first_id := v_round_id; end if;
  end loop;
  select (p_rounds->0) || jsonb_build_object('expected_updated_at',r.updated_at)
    into v_first_payload from public.golf_reservations r where r.id=v_first_id;
  -- Reuse the audited shared-payment path for payment validation, safe totals,
  -- completion of ALL rounds, and existing course/partner charge triggers.
  select s.saved_status into v_status from private.save_golf_booking_group_impl(
    v_group_id,v_first_id,v_first_payload,p_payments,1
  ) s;
  update private.golf_booking_create_requests q set saved_id=v_first_id,saved_status=v_status,
    booking_group_id=v_group_id,finished_at=now()
    where q.actor_id=v_actor and q.request_id=p_request_id;
  return query select v_first_id,v_status,v_group_id;
end;
$$;

create function public.create_golf_booking_group(
  p_request_id uuid,p_label text,p_rounds jsonb,p_payments jsonb
) returns table(saved_id uuid,saved_status text,booking_group_id uuid)
language sql security invoker set search_path = '' as $$
  select * from private.create_golf_booking_group_impl(p_request_id,p_label,p_rounds,p_payments)
$$;
revoke all on function private.create_golf_booking_group_impl(uuid,text,jsonb,jsonb),
  public.create_golf_booking_group(uuid,text,jsonb,jsonb) from public,anon,authenticated,service_role;
grant execute on function private.create_golf_booking_group_impl(uuid,text,jsonb,jsonb),
  public.create_golf_booking_group(uuid,text,jsonb,jsonb) to authenticated;
comment on function public.create_golf_booking_group(uuid,text,jsonb,jsonb) is
  'Atomically creates 2–30 rounds and shared payments. Reuse an actor-scoped request UUID only for an identical retry; response is the immutable original result even after edits/deletion.';
notify pgrst,'reload schema';
commit;
