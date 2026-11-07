-- Catalog deletion hides options; original reservations and amounts stay untouched.
set lock_timeout = '5s';
alter table public.hotel_room_grades add column archived_at timestamptz;
alter table public.hotel_room_types add column archived_at timestamptz;
alter table public.hotel_room_types add constraint hotel_room_types_archived_inactive
  check (archived_at is null or not is_active);
grant update(archived_at) on public.hotel_room_grades,public.hotel_room_types to authenticated;
drop index public.hotel_room_grades_hotel_name_idx;
create unique index hotel_room_grades_hotel_name_idx
  on public.hotel_room_grades(hotel_id,lower(btrim(name))) where archived_at is null;
create index hotel_room_grades_hotel_id_idx on public.hotel_room_grades(hotel_id);
drop index public.hotel_room_types_hotel_legacy_name_idx;
create unique index hotel_room_types_hotel_legacy_name_idx
  on public.hotel_room_types(hotel_id,lower(btrim(name))) where grade_id is null and archived_at is null;

create or replace function public.prepare_hotel_room_grade() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  new.name := btrim(new.name);
  if tg_op='UPDATE' then
    if old.archived_at is not null then
      raise exception using errcode='23514',message='삭제된 객실등급은 수정하거나 복원할 수 없습니다. / Không thể sửa hoặc khôi phục hạng phòng đã xóa.';
    end if;
    if new.hotel_id is distinct from old.hotel_id then
      raise exception using errcode='23503',message='객실등급의 호텔은 변경할 수 없습니다. / Không thể chuyển hạng phòng sang khách sạn khác.';
    end if;
    new.id := old.id;
    new.created_at := old.created_at;
    new.version := old.version+1;
    if new.archived_at is not null then new.archived_at := now(); end if;
  else
    new.version := 1;
    new.archived_at := null;
  end if;
  return new;
end $$;
revoke all on function public.prepare_hotel_room_grade() from public,anon,authenticated;

create or replace function public.prepare_hotel_room_type() returns trigger
language plpgsql security invoker set search_path='' as $$
declare parent_archived_at timestamptz;
begin
  if tg_op='DELETE' then
    raise exception using errcode='23503',message='객실 삭제 기능을 이용해 주세요. 기존 예약은 보존됩니다. / Vui lòng dùng chức năng xóa phòng để giữ nguyên đặt phòng cũ.';
  end if;
  if tg_op='UPDATE' then
    if old.archived_at is not null then
      raise exception using errcode='23514',message='삭제된 룸타입은 수정하거나 복원할 수 없습니다. / Không thể sửa hoặc khôi phục loại phòng đã xóa.';
    end if;
    if row(new.hotel_id,new.grade_id,new.room_kind) is distinct from row(old.hotel_id,old.grade_id,old.room_kind) then
      raise exception using errcode='23503',message='객실의 호텔·등급·룸타입은 변경할 수 없습니다. / Không thể thay đổi khách sạn, hạng hoặc loại của phòng.';
    end if;
    new.id := old.id;
    new.created_at := old.created_at;
    new.version := old.version+1;
    if new.archived_at is not null then new.archived_at := now(); end if;
  else
    new.version := 1;
    new.archived_at := null;
  end if;
  if new.grade_id is not null then
    if tg_op='INSERT' then
      -- Serialize new child insertion with whole-grade archival.
      select archived_at into parent_archived_at from public.hotel_room_grades where id=new.grade_id for share;
    else
      -- Existing child rows are locked by their UPDATE already. Do not acquire the parent
      -- lock in reverse order; whole-grade archive updates each existing child atomically.
      select archived_at into parent_archived_at from public.hotel_room_grades where id=new.grade_id;
    end if;
    if parent_archived_at is not null and new.archived_at is null then
      raise exception using errcode='23514',message='삭제된 객실등급에는 객실을 추가하거나 활성화할 수 없습니다. / Không thể thêm hoặc bật phòng thuộc hạng đã xóa.';
    end if;
  end if;
  if new.archived_at is not null then new.is_active := false; end if;
  new.name := case when new.grade_id is not null then new.room_kind else btrim(new.name) end;
  return new;
end $$;
revoke all on function public.prepare_hotel_room_type() from public,anon,authenticated;

-- Direct authorized grade updates also preserve the no-active-child invariant.
create function public.archive_hotel_grade_children() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  if old.archived_at is null and new.archived_at is not null then
    perform id from public.hotel_room_types where grade_id=new.id order by id for update;
    update public.hotel_room_types set archived_at=new.archived_at,is_active=false
      where grade_id=new.id and archived_at is null;
  end if;
  return new;
end $$;
revoke all on function public.archive_hotel_grade_children() from public,anon,authenticated;
create trigger archive_hotel_grade_children after update of archived_at on public.hotel_room_grades
  for each row execute function public.archive_hotel_grade_children();

create function public.archive_hotel_room_type(p_id uuid,p_expected_version integer)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare room public.hotel_room_types;
begin
  if coalesce(public.current_app_role(),'') not in ('manager','admin') then
    raise exception using errcode='42501',message='매니저·관리자 권한이 필요합니다. / Cần quyền quản lý hoặc quản trị viên.';
  end if;
  select * into room from public.hotel_room_types where id=p_id;
  if not found then raise exception using errcode='40001',message='객실을 찾을 수 없습니다. 새로고침해 주세요. / Không tìm thấy phòng, hãy tải lại.'; end if;
  perform id from public.hotel_properties where id=room.hotel_id for share;
  if room.grade_id is not null then
    perform id from public.hotel_room_grades where id=room.grade_id for update;
  end if;
  select * into room from public.hotel_room_types where id=p_id for update;
  if not found or p_expected_version is distinct from room.version then
    raise exception using errcode='40001',message='객실 정보가 변경되었습니다. 새로고침해 주세요. / Thông tin phòng đã thay đổi, hãy tải lại.';
  end if;
  if room.archived_at is not null then
    raise exception using errcode='23514',message='이미 삭제된 룸타입입니다. / Loại phòng này đã được xóa.';
  end if;
  update public.hotel_room_types set archived_at=now(),is_active=false where id=p_id returning * into room;
  return to_jsonb(room);
end $$;
revoke all on function public.archive_hotel_room_type(uuid,integer) from public,anon,authenticated;
grant execute on function public.archive_hotel_room_type(uuid,integer) to authenticated;

create function public.archive_hotel_room_grade(p_id uuid,p_expected_version integer,p_type_versions jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare grade public.hotel_room_grades; request jsonb; ids uuid[] := '{}'; type_id uuid; type_version integer; actual_version integer;
begin
  if coalesce(public.current_app_role(),'') not in ('manager','admin') then
    raise exception using errcode='42501',message='매니저·관리자 권한이 필요합니다. / Cần quyền quản lý hoặc quản trị viên.';
  end if;
  if jsonb_typeof(p_type_versions) is distinct from 'array' then
    raise exception using errcode='22023',message='객실 목록을 다시 불러와 주세요. / Hãy tải lại danh sách phòng.';
  end if;
  select * into grade from public.hotel_room_grades where id=p_id;
  if not found then raise exception using errcode='40001',message='객실등급을 찾을 수 없습니다. 새로고침해 주세요. / Không tìm thấy hạng phòng, hãy tải lại.'; end if;
  perform id from public.hotel_properties where id=grade.hotel_id for share;
  select * into grade from public.hotel_room_grades where id=p_id for update;
  if not found or p_expected_version is distinct from grade.version then
    raise exception using errcode='40001',message='객실등급이 변경되었습니다. 새로고침해 주세요. / Hạng phòng đã thay đổi, hãy tải lại.';
  end if;
  if grade.archived_at is not null then
    raise exception using errcode='23514',message='이미 삭제된 객실등급입니다. / Hạng phòng này đã được xóa.';
  end if;
  perform id from public.hotel_room_types where grade_id=p_id order by id for update;
  if jsonb_array_length(p_type_versions)<>(select count(*) from public.hotel_room_types where grade_id=p_id) then
    raise exception using errcode='40001',message='객실 구성이 변경되었습니다. 새로고침해 주세요. / Danh sách phòng đã thay đổi, hãy tải lại.';
  end if;
  for request in select value from jsonb_array_elements(p_type_versions) loop
    begin
      type_id := (request->>'id')::uuid;
      type_version := (request->>'version')::integer;
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception using errcode='22023',message='객실 목록을 다시 불러와 주세요. / Hãy tải lại danh sách phòng.';
    end;
    if type_id is null or type_id=any(ids) or type_version is null then
      raise exception using errcode='22023',message='객실 목록이 올바르지 않습니다. / Danh sách phòng không hợp lệ.';
    end if;
    ids := array_append(ids,type_id);
    select version into actual_version from public.hotel_room_types where id=type_id and grade_id=p_id;
    if not found or actual_version is distinct from type_version then
      raise exception using errcode='40001',message='객실 요금이 변경되었습니다. 새로고침해 주세요. / Giá phòng đã thay đổi, hãy tải lại.';
    end if;
  end loop;
  update public.hotel_room_grades set archived_at=now() where id=p_id returning * into grade;
  return to_jsonb(grade);
end $$;
revoke all on function public.archive_hotel_room_grade(uuid,integer,jsonb) from public,anon,authenticated;
grant execute on function public.archive_hotel_room_grade(uuid,integer,jsonb) to authenticated;

create or replace function public.save_hotel_room_grade(
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
end $$;
revoke all on function public.save_hotel_room_grade(uuid,text,jsonb,uuid,integer) from public,anon,authenticated;
grant execute on function public.save_hotel_room_grade(uuid,text,jsonb,uuid,integer) to authenticated;

comment on column public.hotel_room_grades.archived_at is 'Soft deletion: hidden from new selections, retained for historical booking snapshots. No automatic restoration.';
comment on column public.hotel_room_types.archived_at is 'Soft deletion: disables new booking selections without deleting historical catalog IDs or changing reservations.';

