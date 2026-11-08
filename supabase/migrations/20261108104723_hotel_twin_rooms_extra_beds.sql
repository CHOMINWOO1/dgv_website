set local lock_timeout='3s';
-- One atomic label conversion. Stable IDs and all historical amounts survive.
lock table public.hotel_properties,public.hotel_room_grades,public.hotel_room_types,public.hotel_reservations in share row exclusive mode;
create temporary table hotel_rooms_before on commit drop as select id,to_jsonb(t) data from public.hotel_room_types t;
create temporary table hotel_bookings_before on commit drop as select id,to_jsonb(r) data from public.hotel_reservations r;
alter table public.hotel_room_types disable trigger prepare_hotel_room_type;
alter table public.hotel_reservations disable trigger prepare_hotel_reservation;
alter table public.hotel_room_types drop constraint hotel_room_types_grade_kind_check;
drop index public.hotel_room_types_grade_kind_idx;
update public.hotel_room_types set room_kind=case room_kind when 'SINGLE' then 'DOUBLE' when 'DOUBLE' then 'TWIN' else room_kind end,
 name=case when grade_id is not null then case room_kind when 'SINGLE' then 'DOUBLE' when 'DOUBLE' then 'TWIN' else room_kind end else name end,
 version=version+1 where room_kind in ('SINGLE','DOUBLE');
alter table public.hotel_room_types add constraint hotel_room_types_grade_kind_check check(
 (grade_id is null and room_kind is null) or (grade_id is not null and room_kind is not null and room_kind in ('DOUBLE','TWIN','TRIPLE')));
create unique index hotel_room_types_grade_kind_idx on public.hotel_room_types(grade_id,room_kind) where grade_id is not null;
update public.hotel_reservations r set room_items=(select jsonb_agg(
 case when e->>'room_kind' in ('SINGLE','DOUBLE') then e||jsonb_build_object(
  'room_kind',case e->>'room_kind' when 'SINGLE' then 'DOUBLE' else 'TWIN' end,
  'name',case e->>'room_kind' when 'SINGLE' then 'DOUBLE' else 'TWIN' end) else e end order by ord)
 from jsonb_array_elements(r.room_items) with ordinality as item(e,ord)),version=r.version+1
 where exists(select 1 from jsonb_array_elements(r.room_items) e where e->>'room_kind' in ('SINGLE','DOUBLE'));
alter table public.hotel_room_types enable trigger prepare_hotel_room_type;
alter table public.hotel_reservations enable trigger prepare_hotel_reservation;
do $$ begin
 if exists(select 1 from public.hotel_reservations r join hotel_bookings_before b using(id)
  where to_jsonb(r)-array['room_items','version'] is distinct from b.data-array['room_items','version'])
 or exists(select 1 from public.hotel_room_types t join hotel_rooms_before b using(id)
  where to_jsonb(t)-array['name','room_kind','version'] is distinct from b.data-array['name','room_kind','version'])
 then raise exception 'Hotel classification migration changed protected data'; end if;
end $$;

alter table public.hotel_properties
 add column extra_bed_purchase bigint not null default 0 check(extra_bed_purchase between 0 and 999999999999),
 add column extra_bed_sale bigint not null default 0 check(extra_bed_sale between 0 and 999999999999);
grant insert(extra_bed_purchase,extra_bed_sale),update(extra_bed_purchase,extra_bed_sale) on public.hotel_properties to authenticated;
alter table public.hotel_reservations
 add column extra_bed_count integer not null default 0 check(extra_bed_count between 0 and 10000),
 add column extra_bed_purchase_amount bigint not null default 0 check(extra_bed_purchase_amount between 0 and 999999999999),
 add column extra_bed_sale_amount bigint not null default 0 check(extra_bed_sale_amount between 0 and 999999999999),
 add column extra_bed_rate_snapshot jsonb,
 add column extra_bed_hotel_version integer;
grant insert(extra_bed_count,extra_bed_hotel_version),update(extra_bed_count,extra_bed_hotel_version) on public.hotel_reservations to authenticated;

-- Runs AFTER the existing BEFORE trigger, which still validates and prices rooms.
-- Bed charges are separate from room/meal amounts, so repeated edits never add twice.
create function public.prepare_hotel_extra_beds() returns trigger
language plpgsql security invoker set search_path='' as $$
declare hotel public.hotel_properties; bed_purchase numeric:=0; bed_sale numeric:=0; nights integer;
begin
 if new.extra_bed_count is null or new.extra_bed_count not between 0 and 10000 then
  raise exception using errcode='22023',message='추가 침대 수는 0~10,000개로 입력해 주세요. / Số giường phụ phải từ 0 đến 10.000.';
 end if;
 nights:=new.check_out-new.check_in;
 if new.extra_bed_count>0 then
  if new.hotel_id is null or new.pricing_mode='legacy' then
   raise exception using errcode='22023',message='엑스트라베드를 추가하려면 등록된 호텔을 선택해 주세요. / Chọn khách sạn đã đăng ký để thêm giường phụ.';
  end if;
  if nights not between 1 and 3660 then raise exception 'Invalid extra-bed stay'; end if;
  if tg_op='UPDATE' and old.extra_bed_count>0 and old.extra_bed_rate_snapshot is not null
   and row(new.hotel_id,new.check_in,new.check_out) is not distinct from row(old.hotel_id,old.check_in,old.check_out) then
   new.extra_bed_rate_snapshot:=old.extra_bed_rate_snapshot;
   new.extra_bed_hotel_version:=old.extra_bed_hotel_version;
  else
   select * into strict hotel from public.hotel_properties where id=new.hotel_id for share;
   if new.extra_bed_hotel_version is distinct from hotel.version then
    raise exception using errcode='40001',message='엑스트라베드 요금이 변경되었습니다. 새로고침 후 확인해 주세요. / Giá giường phụ đã thay đổi, hãy tải lại và kiểm tra.';
   end if;
   new.extra_bed_rate_snapshot:=jsonb_build_object('purchase',hotel.extra_bed_purchase,'sale',hotel.extra_bed_sale,'basis','per_bed_per_night');
  end if;
  bed_purchase:=new.extra_bed_count::numeric*nights*(new.extra_bed_rate_snapshot->>'purchase')::numeric;
  bed_sale:=new.extra_bed_count::numeric*nights*(new.extra_bed_rate_snapshot->>'sale')::numeric;
 else
  new.extra_bed_rate_snapshot:=null;
  new.extra_bed_hotel_version:=null;
 end if;
 if bed_purchase+new.room_purchase_amount+new.meal_purchase_amount>999999999999
  or bed_sale+new.room_sale_amount+new.meal_sale_amount>999999999999 then
  raise exception using errcode='22023',message='엑스트라베드를 포함한 총액이 허용 범위를 초과했습니다. / Tổng tiền gồm giường phụ vượt giới hạn.';
 end if;
 new.extra_bed_purchase_amount:=bed_purchase; new.extra_bed_sale_amount:=bed_sale;
 new.purchase_amount:=new.room_purchase_amount+new.meal_purchase_amount+bed_purchase;
 new.sale_amount:=new.room_sale_amount+new.meal_sale_amount+bed_sale;
 return new;
end $$;
revoke all on function public.prepare_hotel_extra_beds() from public,anon,authenticated;
create trigger zz_prepare_hotel_extra_beds before insert or update on public.hotel_reservations
 for each row execute function public.prepare_hotel_extra_beds();

CREATE OR REPLACE FUNCTION public.save_hotel_room_grade(p_hotel_id uuid, p_name text, p_types jsonb, p_id uuid DEFAULT NULL::uuid, p_expected_version integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
    raise exception using errcode='22023',message='더블·트윈·트리플 설정을 확인해 주세요. / Kiểm tra cài đặt phòng giường đôi, hai giường đơn và ba.';
  end if;
  if (select count(distinct e->>'room_kind') from jsonb_array_elements(p_types) e)<>3 then
    raise exception using errcode='22023',message='룸타입이 중복되었습니다. / Loại phòng bị trùng.';
  end if;
  for v_type in select value from jsonb_array_elements(p_types) loop
    if jsonb_typeof(v_type)<>'object' or coalesce(v_type->>'room_kind','') not in ('DOUBLE','TWIN','TRIPLE')
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
    if v_grade.archived_at is not null then
      raise exception using errcode='23514',message='삭제된 객실등급은 수정할 수 없습니다. / Không thể sửa hạng phòng đã xóa.';
    end if;
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
        if v_existing.archived_at is not null and (v_type->>'is_active')::boolean then
          raise exception using errcode='23514',message='삭제된 룸타입은 다시 사용할 수 없습니다. / Không thể bật lại loại phòng đã xóa.';
        end if;
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
    select * into v_existing from public.hotel_room_types where grade_id=v_id and room_kind=v_kind;
    if found and v_existing.archived_at is not null then
      -- All three fixed rows remain in the request, but archived records are immutable.
      continue;
    end if;
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
end $function$;

