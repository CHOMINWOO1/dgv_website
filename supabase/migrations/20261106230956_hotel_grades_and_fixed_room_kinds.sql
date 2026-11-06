-- Add hotel-specific grades and fixed room kinds. Existing rows are not rewritten.
set lock_timeout = '5s';

create table public.hotel_room_grades (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotel_properties(id) on delete restrict,
  name text not null check (btrim(name)<>'' and length(name)<=200),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  unique(id,hotel_id)
);
create unique index hotel_room_grades_hotel_name_idx
  on public.hotel_room_grades(hotel_id,lower(btrim(name)));
alter table public.hotel_room_grades enable row level security;
revoke all on public.hotel_room_grades from public,anon,authenticated;
grant select on public.hotel_room_grades to authenticated;
grant insert(id,hotel_id,name),update(name) on public.hotel_room_grades to authenticated;
create policy hotel_room_grades_manager_admin on public.hotel_room_grades
  for all to authenticated
  using ((select public.current_app_role()) in ('manager','admin'))
  with check ((select public.current_app_role()) in ('manager','admin'));

alter table public.hotel_room_types
  add column grade_id uuid,
  add column room_kind text,
  add constraint hotel_room_types_grade_hotel_fkey
    foreign key (grade_id,hotel_id) references public.hotel_room_grades(id,hotel_id) on delete restrict,
  add constraint hotel_room_types_grade_kind_check check (
    (grade_id is null and room_kind is null)
    or (grade_id is not null and room_kind is not null and room_kind in ('SINGLE','DOUBLE','TRIPLE'))
  );
drop index public.hotel_room_types_hotel_name_idx;
create unique index hotel_room_types_hotel_legacy_name_idx
  on public.hotel_room_types(hotel_id,lower(btrim(name))) where grade_id is null;
create unique index hotel_room_types_grade_kind_idx
  on public.hotel_room_types(grade_id,room_kind) where grade_id is not null;
create index hotel_room_types_hotel_id_idx on public.hotel_room_types(hotel_id);
grant insert(grade_id,room_kind) on public.hotel_room_types to authenticated;

create function public.prepare_hotel_room_grade() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  new.name := btrim(new.name);
  if tg_op='UPDATE' then
    if new.hotel_id is distinct from old.hotel_id then
      raise exception using errcode='23503',message='객실등급의 호텔은 변경할 수 없습니다. / Không thể chuyển hạng phòng sang khách sạn khác.';
    end if;
    new.id := old.id;
    new.created_at := old.created_at;
    new.version := old.version+1;
  else
    new.version := 1;
  end if;
  return new;
end $$;
revoke all on function public.prepare_hotel_room_grade() from public,anon,authenticated;
create trigger prepare_hotel_room_grade before insert or update on public.hotel_room_grades
  for each row execute function public.prepare_hotel_room_grade();

create or replace function public.prepare_hotel_room_type() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  if tg_op='DELETE' then
    if exists(select 1 from public.hotel_reservations r
      where r.room_items @> jsonb_build_array(jsonb_build_object('room_type_id',old.id))) then
      raise exception using errcode='23503',message='예약에 사용 중인 객실은 삭제 대신 사용 중지해 주세요. / Hãy ngừng sử dụng loại phòng đã có đặt phòng.';
    end if;
    return old;
  end if;
  if tg_op='UPDATE' then
    if row(new.hotel_id,new.grade_id,new.room_kind) is distinct from row(old.hotel_id,old.grade_id,old.room_kind) then
      raise exception using errcode='23503',message='객실의 호텔·등급·룸타입은 변경할 수 없습니다. / Không thể thay đổi khách sạn, hạng hoặc loại của phòng.';
    end if;
    new.id := old.id;
    new.created_at := old.created_at;
    new.version := old.version+1;
  else
    new.version := 1;
  end if;
  new.name := case when new.grade_id is not null then new.room_kind else btrim(new.name) end;
  return new;
end $$;
revoke all on function public.prepare_hotel_room_type() from public,anon,authenticated;

-- One atomic save covers the grade name and all three price variants.
-- Expected grade/type versions prevent stale forms from overwriting newer prices.
create function public.save_hotel_room_grade(
  p_hotel_id uuid,p_name text,p_types jsonb,p_id uuid default null,p_expected_version integer default null
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  v_grade public.hotel_room_grades;
  v_existing public.hotel_room_types;
  v_type jsonb;
  v_kind text;
  v_key text;
  v_id uuid := coalesce(p_id,gen_random_uuid());
  v_active_count integer := 0;
  v_type_version integer;
begin
  if coalesce(public.current_app_role(),'') not in ('manager','admin') then
    raise exception using errcode='42501',message='매니저·관리자 권한이 필요합니다. / Cần quyền quản lý hoặc quản trị viên.';
  end if;
  if p_name is null or btrim(p_name)='' or length(btrim(p_name))>200 then
    raise exception using errcode='22023',message='객실등급명을 입력해 주세요. / Vui lòng nhập tên hạng phòng.';
  end if;
  if jsonb_typeof(p_types) is distinct from 'array' or jsonb_array_length(p_types)<>3 then
    raise exception using errcode='22023',message='싱글·더블·트리플 설정을 확인해 주세요. / Kiểm tra cài đặt phòng đơn, đôi và ba.';
  end if;
  if (select count(distinct e->>'room_kind') from jsonb_array_elements(p_types) e)<>3 then
    raise exception using errcode='22023',message='룸타입이 중복되었습니다. / Loại phòng bị trùng.';
  end if;
  for v_type in select value from jsonb_array_elements(p_types) loop
    if jsonb_typeof(v_type)<>'object' or coalesce(v_type->>'room_kind','') not in ('SINGLE','DOUBLE','TRIPLE')
      or jsonb_typeof(v_type->'is_active') is distinct from 'boolean' then
      raise exception using errcode='22023',message='룸타입과 사용 여부를 확인해 주세요. / Kiểm tra loại phòng và trạng thái sử dụng.';
    end if;
    foreach v_key in array array['weekday_purchase','weekday_sale','weekend_purchase','weekend_sale'] loop
      if jsonb_typeof(v_type->v_key) is distinct from 'number' or coalesce(v_type->>v_key,'') !~ '^[0-9]{1,12}$' then
        raise exception using errcode='22023',message='요금은 0 이상 999,999,999,999 이하의 정수로 입력해 주세요. / Giá phải là số nguyên từ 0 đến 999.999.999.999.';
      end if;
    end loop;
    if (v_type->>'is_active')::boolean then v_active_count := v_active_count+1; end if;
  end loop;
  perform id from public.hotel_properties where id=p_hotel_id for share;
  if not found then
    raise exception using errcode='23503',message='등록된 호텔을 선택해 주세요. / Chọn khách sạn đã đăng ký.';
  end if;
  select * into v_grade from public.hotel_room_grades where id=v_id for update;
  if found then
    if v_grade.hotel_id<>p_hotel_id then
      raise exception using errcode='23503',message='객실등급의 호텔이 다릅니다. / Hạng phòng thuộc khách sạn khác.';
    end if;
    if p_expected_version is distinct from v_grade.version then
      raise exception using errcode='40001',message='객실등급이 변경되었습니다. 새로고침 후 다시 확인해 주세요. / Hạng phòng đã thay đổi, hãy tải lại.';
    end if;
    -- Stable lock order matches reservation pricing: hotel, grade, room types.
    perform id from public.hotel_room_types where grade_id=v_id order by id for update;
    for v_type in select value from jsonb_array_elements(p_types) loop
      select * into v_existing from public.hotel_room_types where grade_id=v_id and room_kind=v_type->>'room_kind';
      if found then
        begin v_type_version := (v_type->>'version')::integer;
        exception when invalid_text_representation or numeric_value_out_of_range then
          raise exception using errcode='22023',message='객실 요금을 다시 불러와 주세요. / Hãy tải lại giá phòng.';
        end;
        if v_type_version is distinct from v_existing.version then
          raise exception using errcode='40001',message='객실 요금이 변경되었습니다. 새로고침 후 다시 확인해 주세요. / Giá phòng đã thay đổi, hãy tải lại.';
        end if;
      elsif v_type->>'version' is not null then
        raise exception using errcode='40001',message='객실 구성이 변경되었습니다. 새로고침해 주세요. / Danh sách phòng đã thay đổi, hãy tải lại.';
      end if;
    end loop;
    update public.hotel_room_grades set name=btrim(p_name) where id=v_id returning * into v_grade;
  else
    if p_expected_version is not null then
      raise exception using errcode='40001',message='객실등급을 찾을 수 없습니다. 새로고침해 주세요. / Không tìm thấy hạng phòng, hãy tải lại.';
    end if;
    if v_active_count=0 then
      raise exception using errcode='22023',message='판매할 룸타입을 하나 이상 선택해 주세요. / Chọn ít nhất một loại phòng để bán.';
    end if;
    insert into public.hotel_room_grades(id,hotel_id,name) values(v_id,p_hotel_id,btrim(p_name)) returning * into v_grade;
  end if;
  for v_type in select value from jsonb_array_elements(p_types) order by value->>'room_kind' loop
    v_kind := v_type->>'room_kind';
    update public.hotel_room_types
      set weekday_purchase=(v_type->>'weekday_purchase')::bigint,weekday_sale=(v_type->>'weekday_sale')::bigint,
        weekend_purchase=(v_type->>'weekend_purchase')::bigint,weekend_sale=(v_type->>'weekend_sale')::bigint,
        is_active=(v_type->>'is_active')::boolean
      where grade_id=v_id and room_kind=v_kind;
    if not found then
      insert into public.hotel_room_types(hotel_id,grade_id,room_kind,name,
        weekday_purchase,weekday_sale,weekend_purchase,weekend_sale,is_active)
      values(p_hotel_id,v_id,v_kind,v_kind,(v_type->>'weekday_purchase')::bigint,(v_type->>'weekday_sale')::bigint,
        (v_type->>'weekend_purchase')::bigint,(v_type->>'weekend_sale')::bigint,(v_type->>'is_active')::boolean);
    end if;
  end loop;
  return to_jsonb(v_grade);
end $$;
revoke all on function public.save_hotel_room_grade(uuid,text,jsonb,uuid,integer) from public,anon,authenticated;
grant execute on function public.save_hotel_room_grade(uuid,text,jsonb,uuid,integer) to authenticated;

create or replace function public.prepare_hotel_reservation() returns trigger
language plpgsql security invoker set search_path='' as $$
declare
  hotel public.hotel_properties;
  room_type public.hotel_room_types;
  catalog_grade public.hotel_room_grades;
  request_grade_id uuid;
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
        or coalesce(room_input->>'room_count','') !~ '^[0-9]{1,5}$' then
        raise exception using errcode='22023', message='룸타입, 객실 수, 등급을 확인해 주세요. / Kiểm tra loại phòng, số phòng và hạng phòng.';
      end if;
      begin room_id := (room_input->>'room_type_id')::uuid;
      exception when invalid_text_representation then
        raise exception using errcode='22023', message='올바른 룸타입을 선택해 주세요. / Chọn loại phòng hợp lệ.';
      end;
      count_rooms := (room_input->>'room_count')::integer;
      select grade_id into request_grade_id from public.hotel_room_types where id=room_id;
      if request_grade_id is null and coalesce(room_input->>'room_grade','') not in ('STANDARD','VIP') then
        raise exception using errcode='22023',message='기존 객실 등급을 확인해 주세요. / Kiểm tra hạng phòng cũ.';
      end if;
      -- A catalog grade name is display text, not a pricing choice.
      room_grade := case when request_grade_id is not null then null else room_input->>'room_grade' end;
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
        'room_grade',case when e->>'grade_id' is not null then null else e->>'room_grade' end)
        order by e->>'room_type_id',case when e->>'grade_id' is not null then null else e->>'room_grade' end,e->>'room_count')
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
      -- Match catalog-save lock order to keep grade names and prices consistent.
      perform g.id from public.hotel_room_grades g
        where g.id in (select rt.grade_id from public.hotel_room_types rt
          where rt.id in (select (e->>'room_type_id')::uuid from jsonb_array_elements(room_requests) e))
        order by g.id for share;
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
        if room_type.grade_id is not null then
          select * into strict catalog_grade from public.hotel_room_grades where id=room_type.grade_id;
          room_grade := catalog_grade.name;
        else
          room_grade := room_input->>'room_grade';
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
          'room_grade',room_grade,'room_type_version',room_type.version,
          'rate_snapshot',jsonb_build_object('weekday_purchase',room_type.weekday_purchase,'weekday_sale',room_type.weekday_sale,
            'weekend_purchase',room_type.weekend_purchase,'weekend_sale',room_type.weekend_sale,'weekend_days',hotel.weekend_days),
          'weekday_nights',new.weekday_nights,'weekend_nights',new.weekend_nights,
          'room_purchase_amount',case when new.pricing_mode='standard' then line_purchase else null end,
          'room_sale_amount',case when new.pricing_mode='standard' then line_sale else null end)
          || case when room_type.grade_id is not null then
            jsonb_build_object('grade_id',room_type.grade_id,'room_kind',room_type.room_kind)
            else '{}'::jsonb end);
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

comment on column public.hotel_room_types.grade_id is 'NULL is an unchanged legacy catalog entry. Non-NULL is one fixed room kind within a hotel-specific grade.';
comment on column public.hotel_room_types.room_kind is 'Fixed SINGLE, DOUBLE or TRIPLE; nullable only for unchanged legacy entries.';
comment on table public.hotel_room_grades is 'Hotel-specific grade names. Price variants live in hotel_room_types. Historical booking snapshots are never rewritten.';

