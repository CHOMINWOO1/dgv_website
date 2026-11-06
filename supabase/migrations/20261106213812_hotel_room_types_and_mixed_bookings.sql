-- Add room-type catalogs and mixed-room reservations without rewriting old rows.
-- Existing hotel-wide rates and nullable room_items preserve the previous API.
set lock_timeout = '5s';

alter table public.hotel_properties
  alter column weekday_purchase set default 0,
  alter column weekday_sale set default 0,
  alter column weekend_purchase set default 0,
  alter column weekend_sale set default 0;

create table public.hotel_room_types (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotel_properties(id) on delete restrict,
  name text not null check (btrim(name) <> '' and length(name) <= 200),
  weekday_purchase bigint not null check (weekday_purchase between 0 and 999999999999),
  weekday_sale bigint not null check (weekday_sale between 0 and 999999999999),
  weekend_purchase bigint not null check (weekend_purchase between 0 and 999999999999),
  weekend_sale bigint not null check (weekend_sale between 0 and 999999999999),
  is_active boolean not null default true,
  version integer not null default 1,
  created_at timestamptz not null default now()
);
create unique index hotel_room_types_hotel_name_idx
  on public.hotel_room_types(hotel_id,lower(btrim(name)));
alter table public.hotel_room_types enable row level security;
revoke all on public.hotel_room_types from public,anon,authenticated;
grant select,delete on public.hotel_room_types to authenticated;
grant insert(id,hotel_id,name,weekday_purchase,weekday_sale,weekend_purchase,weekend_sale,is_active),
      update(name,weekday_purchase,weekday_sale,weekend_purchase,weekend_sale,is_active)
  on public.hotel_room_types to authenticated;
create policy hotel_room_types_manager_admin on public.hotel_room_types
  for all to authenticated
  using ((select public.current_app_role()) in ('manager','admin'))
  with check ((select public.current_app_role()) in ('manager','admin'));

alter table public.hotel_reservations
  add column room_items jsonb,
  add column deposit_amount bigint check (deposit_amount between 0 and 999999999999),
  add column balance_amount bigint check (balance_amount between 0 and 999999999999),
  add column note text not null default '' check (length(note) <= 5000);
grant insert(room_items,deposit_amount,balance_amount,note),
      update(room_items,deposit_amount,balance_amount,note)
  on public.hotel_reservations to authenticated;
create index hotel_reservations_room_items_idx on public.hotel_reservations using gin(room_items jsonb_path_ops);

create function public.prepare_hotel_room_type() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  if tg_op='DELETE' then
    if exists(select 1 from public.hotel_reservations r
      where r.room_items @> jsonb_build_array(jsonb_build_object('room_type_id',old.id))) then
      raise exception using errcode='23503', message='예약에 사용 중인 룸타입은 삭제 대신 사용 중지해 주세요. / Hãy ngừng sử dụng loại phòng đã có đặt phòng.';
    end if;
    return old;
  end if;
  new.name := btrim(new.name);
  if tg_op='UPDATE' then
    if new.hotel_id is distinct from old.hotel_id then
      raise exception using errcode='23503', message='룸타입의 소속 호텔은 변경할 수 없습니다. / Không thể chuyển loại phòng sang khách sạn khác.';
    end if;
    new.id := old.id;
    new.created_at := old.created_at;
    new.version := old.version+1;
  else
    new.version := 1;
  end if;
  return new;
end $$;
revoke all on function public.prepare_hotel_room_type() from public,anon,authenticated;
create trigger prepare_hotel_room_type before insert or update or delete on public.hotel_room_types
  for each row execute function public.prepare_hotel_room_type();

create or replace function public.prepare_hotel_reservation() returns trigger
language plpgsql security invoker set search_path='' as $$
declare
  hotel public.hotel_properties;
  room_type public.hotel_room_types;
  reprice boolean;
  stay_date date;
  room_input jsonb;
  room_requests jsonb := '[]'::jsonb;
  old_requests jsonb;
  room_snapshots jsonb := '[]'::jsonb;
  room_id uuid;
  count_rooms integer;
  count_total integer := 0;
  room_grade text;
  requested_version integer;
  line_purchase numeric;
  line_sale numeric;
  total_purchase numeric := 0;
  total_sale numeric := 0;
begin
  if new.check_out <= new.check_in then raise exception 'Check-out must follow check-in'; end if;
  if tg_op='UPDATE' then
    new.version := old.version+1;
    new.id := old.id;
    new.created_at := old.created_at;
    if old.room_items is not null and new.room_items is null then
      raise exception using errcode='23514', message='저장된 룸타입 구성을 유지하거나 수정해 주세요. / Hãy giữ hoặc sửa các loại phòng đã lưu.';
    end if;
  else
    new.version := 1;
  end if;

  if new.room_items is not null then
    if jsonb_typeof(new.room_items)<>'array' then
      raise exception using errcode='22023', message='룸타입 목록을 확인해 주세요. / Kiểm tra danh sách loại phòng.';
    end if;
    if jsonb_array_length(new.room_items) not between 1 and 100 then
      raise exception using errcode='22023', message='룸타입은 1개 이상 등록해 주세요. / Thêm ít nhất một loại phòng.';
    end if;
    if new.pricing_mode not in ('standard','surcharge') then
      raise exception using errcode='23514', message='룸타입 예약의 요금 방식을 선택해 주세요. / Chọn cách tính giá cho đặt phòng.';
    end if;
    if new.check_out-new.check_in > 3660 then raise exception 'Stay exceeds 3660 nights'; end if;
    if new.hotel_id is null then raise exception 'Select a registered hotel'; end if;

    -- Only the four user-editable keys participate in change detection.
    -- Client-supplied names, rates and totals never overwrite server snapshots.
    for room_input in select value from jsonb_array_elements(new.room_items) loop
      if jsonb_typeof(room_input)<>'object'
        or coalesce(room_input->>'room_type_id','')=''
        or coalesce(room_input->>'room_count','') !~ '^[0-9]{1,5}$'
        or coalesce(room_input->>'room_grade','') not in ('STANDARD','VIP') then
        raise exception using errcode='22023', message='룸타입, 객실 수, 등급을 확인해 주세요. / Kiểm tra loại phòng, số phòng và hạng phòng.';
      end if;
      begin room_id := (room_input->>'room_type_id')::uuid;
      exception when invalid_text_representation then
        raise exception using errcode='22023', message='올바른 룸타입을 선택해 주세요. / Chọn loại phòng hợp lệ.';
      end;
      count_rooms := (room_input->>'room_count')::integer;
      room_grade := room_input->>'room_grade';
      if count_rooms not between 1 and 10000 then
        raise exception using errcode='22023', message='객실 수는 1~10,000개로 입력해 주세요. / Số phòng phải từ 1 đến 10.000.';
      end if;
      count_total := count_total+count_rooms;
      if count_total>10000 then
        raise exception using errcode='22023', message='총 객실 수는 10,000개 이하여야 합니다. / Tổng số phòng không được quá 10.000.';
      end if;
      room_requests := room_requests || jsonb_build_array(jsonb_build_object(
        'room_type_id',room_id,'room_count',count_rooms,'room_grade',room_grade));
    end loop;
    new.room_count := count_total;
    select jsonb_agg(e order by e->>'room_type_id',e->>'room_grade',e->>'room_count') into room_requests
      from jsonb_array_elements(room_requests) e;
    if tg_op='UPDATE' and old.room_items is not null then
      select jsonb_agg(jsonb_build_object('room_type_id',e->>'room_type_id','room_count',(e->>'room_count')::integer,
        'room_grade',e->>'room_grade') order by e->>'room_type_id',e->>'room_grade',e->>'room_count')
        into old_requests from jsonb_array_elements(old.room_items) e;
    end if;
    reprice := tg_op='INSERT' or old.room_items is null
      or row(new.hotel_id,new.check_in,new.check_out,new.pricing_mode,room_requests)
      is distinct from row(old.hotel_id,old.check_in,old.check_out,old.pricing_mode,old_requests);

    select * into strict hotel from public.hotel_properties where id=new.hotel_id for share;
    if tg_op='INSERT' or new.hotel_id is distinct from old.hotel_id then new.hotel_name := hotel.name;
    else new.hotel_name := old.hotel_name; end if;
    if reprice then
      if new.hotel_version is distinct from hotel.version then
        raise exception using errcode='40001', message='호텔 정보가 변경되었습니다. 다시 확인해 주세요. / Khách sạn đã thay đổi, hãy tải lại.';
      end if;
      -- Keep catalog locks in UUID order, regardless of the user's row order.
      perform rt.id from public.hotel_room_types rt
        where rt.id in (select (e->>'room_type_id')::uuid from jsonb_array_elements(room_requests) e)
        order by rt.id for share;
      new.weekday_nights := 0;
      new.weekend_nights := 0;
      for stay_date in select new.check_in+d from generate_series(0,new.check_out-new.check_in-1) as d loop
        if extract(dow from stay_date)::integer=any(hotel.weekend_days) then new.weekend_nights := new.weekend_nights+1;
        else new.weekday_nights := new.weekday_nights+1; end if;
      end loop;
      for room_input in select value from jsonb_array_elements(new.room_items) loop
        room_id := (room_input->>'room_type_id')::uuid;
        count_rooms := (room_input->>'room_count')::integer;
        select * into room_type from public.hotel_room_types where id=room_id;
        if not found or room_type.hotel_id<>new.hotel_id then
          raise exception using errcode='23503', message='선택한 호텔의 룸타입을 사용해 주세요. / Chọn loại phòng thuộc khách sạn đã chọn.';
        end if;
        if not room_type.is_active then
          raise exception using errcode='23514', message='사용 중지된 룸타입입니다. / Loại phòng đã ngừng sử dụng.';
        end if;
        begin requested_version := (room_input->>'room_type_version')::integer;
        exception when invalid_text_representation or numeric_value_out_of_range then
          raise exception using errcode='22023', message='룸타입 요금을 다시 불러와 주세요. / Hãy tải lại giá loại phòng.';
        end;
        if requested_version is distinct from room_type.version then
          raise exception using errcode='40001', message='룸타입 요금이 변경되었습니다. 다시 확인해 주세요. / Giá loại phòng đã thay đổi, hãy tải lại.';
        end if;
        line_purchase := count_rooms::numeric*(new.weekday_nights::numeric*room_type.weekday_purchase+new.weekend_nights::numeric*room_type.weekend_purchase);
        line_sale := count_rooms::numeric*(new.weekday_nights::numeric*room_type.weekday_sale+new.weekend_nights::numeric*room_type.weekend_sale);
        total_purchase := total_purchase+line_purchase;
        total_sale := total_sale+line_sale;
        if new.pricing_mode='standard' and (total_purchase>999999999999 or total_sale>999999999999) then
          raise exception using errcode='23514', message='객실 총액이 허용 범위를 초과했습니다. / Tổng tiền phòng vượt giới hạn.';
        end if;
        room_snapshots := room_snapshots || jsonb_build_array(jsonb_build_object(
          'room_type_id',room_type.id,'name',room_type.name,'room_count',count_rooms,
          'room_grade',room_input->>'room_grade','room_type_version',room_type.version,
          'rate_snapshot',jsonb_build_object('weekday_purchase',room_type.weekday_purchase,'weekday_sale',room_type.weekday_sale,
            'weekend_purchase',room_type.weekend_purchase,'weekend_sale',room_type.weekend_sale,'weekend_days',hotel.weekend_days),
          'weekday_nights',new.weekday_nights,'weekend_nights',new.weekend_nights,
          'room_purchase_amount',case when new.pricing_mode='standard' then line_purchase else null end,
          'room_sale_amount',case when new.pricing_mode='standard' then line_sale else null end));
      end loop;
      new.room_items := room_snapshots;
      new.rate_snapshot := jsonb_build_object('source','room_types','weekend_days',hotel.weekend_days);
      if new.pricing_mode='standard' then
        new.room_purchase_amount := total_purchase;
        new.room_sale_amount := total_sale;
      end if;
    else
      new.room_items := old.room_items;
      new.hotel_version := old.hotel_version;
      new.rate_snapshot := old.rate_snapshot;
      new.weekday_nights := old.weekday_nights;
      new.weekend_nights := old.weekend_nights;
      if new.pricing_mode='standard' then
        new.room_purchase_amount := old.room_purchase_amount;
        new.room_sale_amount := old.room_sale_amount;
      end if;
    end if;
    if not new.includes_meals then new.meal_purchase_amount := 0; new.meal_sale_amount := 0; end if;
    new.purchase_amount := new.room_purchase_amount+new.meal_purchase_amount;
    new.sale_amount := new.room_sale_amount+new.meal_sale_amount;
    return new;
  end if;

  -- Unchanged legacy branch: reservations with NULL room_items keep their API.
  if new.pricing_mode='legacy' then
    if tg_op='UPDATE' and old.pricing_mode<>'legacy' then
      raise exception 'Cannot convert a priced reservation to legacy';
    end if;
    new.room_purchase_amount := new.purchase_amount;
    new.room_sale_amount := new.sale_amount;
    new.includes_meals := false;
    new.meal_purchase_amount := 0;
    new.meal_sale_amount := 0;
    return new;
  end if;
  if new.check_out-new.check_in > 3660 then raise exception 'Stay exceeds 3660 nights'; end if;
  if new.hotel_id is null then raise exception 'Select a registered hotel'; end if;
  select * into strict hotel from public.hotel_properties where id=new.hotel_id for share;
  if tg_op='INSERT' or new.hotel_id is distinct from old.hotel_id then
    new.hotel_name := hotel.name;
  else
    new.hotel_name := old.hotel_name;
  end if;
  if tg_op='INSERT' then
    reprice := true;
  else
    reprice := row(new.hotel_id,new.check_in,new.check_out,new.room_count,new.pricing_mode)
      is distinct from row(old.hotel_id,old.check_in,old.check_out,old.room_count,old.pricing_mode);
  end if;
  if new.pricing_mode='standard' then
    if reprice then
      if new.hotel_version is distinct from hotel.version then
        raise exception using errcode='40001', message='Hotel rates changed. Reload and review the price.';
      end if;
      new.rate_snapshot := jsonb_build_object(
        'weekday_purchase',hotel.weekday_purchase,'weekday_sale',hotel.weekday_sale,
        'weekend_purchase',hotel.weekend_purchase,'weekend_sale',hotel.weekend_sale,
        'weekend_days',hotel.weekend_days);
      new.weekday_nights := 0;
      new.weekend_nights := 0;
      for stay_date in select new.check_in + d from generate_series(0,new.check_out-new.check_in-1) as d loop
        if extract(dow from stay_date)::integer=any(hotel.weekend_days) then
          new.weekend_nights := new.weekend_nights+1;
        else
          new.weekday_nights := new.weekday_nights+1;
        end if;
      end loop;
      new.room_purchase_amount := new.room_count::bigint*(new.weekday_nights::bigint*hotel.weekday_purchase+new.weekend_nights::bigint*hotel.weekend_purchase);
      new.room_sale_amount := new.room_count::bigint*(new.weekday_nights::bigint*hotel.weekday_sale+new.weekend_nights::bigint*hotel.weekend_sale);
    else
      new.hotel_version := old.hotel_version;
      new.rate_snapshot := old.rate_snapshot;
      new.weekday_nights := old.weekday_nights;
      new.weekend_nights := old.weekend_nights;
      new.room_purchase_amount := old.room_purchase_amount;
      new.room_sale_amount := old.room_sale_amount;
    end if;
  else
    new.rate_snapshot := null;
    new.hotel_version := null;
    new.weekday_nights := 0;
    new.weekend_nights := 0;
  end if;
  if not new.includes_meals then
    new.meal_purchase_amount := 0;
    new.meal_sale_amount := 0;
  end if;
  new.purchase_amount := new.room_purchase_amount+new.meal_purchase_amount;
  new.sale_amount := new.room_sale_amount+new.meal_sale_amount;
  return new;
end $$;
revoke all on function public.prepare_hotel_reservation() from public,anon,authenticated;

comment on column public.hotel_reservations.room_items is
  'NULL retains the existing hotel-wide price API. Otherwise server-authoritative snapshots of each selected room type/count/grade, including historical rates.';
comment on column public.hotel_reservations.deposit_amount is 'Optional deposit received, in VND. NULL means not entered; no historical receipt is inferred.';
comment on column public.hotel_reservations.balance_amount is 'Optional balance received, in VND. NULL means not entered; this does not alter the sale amount.';
