-- Run only in an isolated test database. All fixtures are rolled back.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
create or replace function pg_temp.archive_assert(p_ok boolean,p_message text)
returns void language plpgsql as $$
begin if p_ok is distinct from true then raise exception 'FAIL: %',p_message; end if; end $$;

do $$
declare
  h uuid := gen_random_uuid(); g uuid := gen_random_uuid(); g2 uuid := gen_random_uuid();
  book_id uuid := gen_random_uuid(); legacy_id uuid := gen_random_uuid(); new_legacy_id uuid := gen_random_uuid();
  single_id uuid; double_id uuid; grade_result jsonb; result jsonb; kinds jsonb; versions jsonb; request jsonb; saved_items jsonb;
  booking public.hotel_reservations; saved_type public.hotel_room_types; archive_time timestamptz;
  rejected boolean; affected bigint; role_name text; bad jsonb;
  original_hotels uuid[]; original_grades uuid[]; original_types uuid[]; original_bookings uuid[];
  before_hotels jsonb; before_grades jsonb; before_types jsonb; before_bookings jsonb;
begin
  perform pg_temp.archive_assert(current_user='postgres','run tests as postgres');
  select coalesce(array_agg(id),'{}'),coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') into original_hotels,before_hotels from public.hotel_properties t;
  select coalesce(array_agg(id),'{}'),coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') into original_grades,before_grades from public.hotel_room_grades t;
  select coalesce(array_agg(id),'{}'),coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') into original_types,before_types from public.hotel_room_types t;
  select coalesce(array_agg(id),'{}'),coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') into original_bookings,before_bookings from public.hotel_reservations t;
  perform pg_temp.archive_assert(not has_function_privilege('anon','public.archive_hotel_room_type(uuid,integer)','EXECUTE'),'anon cannot archive room type');
  perform pg_temp.archive_assert(not has_function_privilege('anon','public.archive_hotel_room_grade(uuid,integer,jsonb)','EXECUTE'),'anon cannot archive grade');
  perform pg_temp.archive_assert(not has_column_privilege('anon','public.hotel_room_types','archived_at','UPDATE'),'anon cannot set room archival timestamp');
  perform set_config('request.jwt.claims','{"role":"authenticated","app_metadata":{"role":"manager"}}',true);
  execute 'set local role authenticated';
  insert into public.hotel_properties(id,name,weekend_days) values(h,'[ROLLBACK] Archive hotel',array[5,6]);
  kinds := '[{"room_kind":"SINGLE","is_active":true,"weekday_purchase":100,"weekday_sale":200,"weekend_purchase":150,"weekend_sale":250},
    {"room_kind":"DOUBLE","is_active":true,"weekday_purchase":200,"weekday_sale":300,"weekend_purchase":250,"weekend_sale":350},
    {"room_kind":"TRIPLE","is_active":false,"weekday_purchase":0,"weekday_sale":0,"weekend_purchase":0,"weekend_sale":0}]'::jsonb;
  grade_result := public.save_hotel_room_grade(h,'VIP',kinds,g,null);
  select id into single_id from public.hotel_room_types where grade_id=g and room_kind='SINGLE';
  select id into double_id from public.hotel_room_types where grade_id=g and room_kind='DOUBLE';
  insert into public.hotel_room_types(id,hotel_id,name,weekday_purchase,weekday_sale,weekend_purchase,weekend_sale)
    values(legacy_id,h,'Doble legacy',20,30,40,50);
  insert into public.hotel_reservations(id,hotel_id,hotel_version,check_in,check_out,guest_count,guest_names,pricing_mode,room_items,deposit_amount,balance_amount,note)
    values(book_id,h,1,'2026-11-05','2026-11-06',3,'Archive historical guests','standard',
      jsonb_build_array(jsonb_build_object('room_type_id',single_id,'room_type_version',1,'room_count',1,'room_grade','VIP'),
        jsonb_build_object('room_type_id',double_id,'room_type_version',1,'room_count',1,'room_grade','VIP')),100,400,'Original') returning * into booking;
  saved_items := booking.room_items;
  perform pg_temp.archive_assert(booking.sale_amount=500 and booking.purchase_amount=300,'baseline booking amounts');

  rejected:=false;
  begin perform public.archive_hotel_room_type(single_id,999); exception when serialization_failure then rejected:=true; end;
  perform pg_temp.archive_assert(rejected and (select archived_at is null and is_active from public.hotel_room_types where id=single_id),'stale single archive makes no changes');
  result := public.archive_hotel_room_type(single_id,1);
  perform pg_temp.archive_assert(result->>'archived_at' is not null and result->>'is_active'='false' and result->>'version'='2','type archive records timestamp and disables selection');
  select * into saved_type from public.hotel_room_types where id=single_id;
  archive_time := saved_type.archived_at;
  select * into booking from public.hotel_reservations where id=book_id;
  perform pg_temp.archive_assert(booking.room_items=saved_items and booking.sale_amount=500 and booking.purchase_amount=300,'archiving does not touch reservation or money');
  update public.hotel_reservations set note='Payment-only edit',deposit_amount=200,balance_amount=300 where id=book_id returning * into booking;
  perform pg_temp.archive_assert(booking.room_items=saved_items and booking.sale_amount=500 and booking.deposit_amount=200,'historical payment/note edits still work');
  rejected:=false;
  begin update public.hotel_reservations set check_out='2026-11-07' where id=book_id; exception when check_violation then rejected:=true; end;
  perform pg_temp.archive_assert(rejected,'new pricing cannot select archived type');
  rejected:=false;
  begin update public.hotel_room_types set is_active=true where id=single_id; exception when check_violation then rejected:=true; end;
  perform pg_temp.archive_assert(rejected,'cached old client cannot reactivate archived type');
  rejected:=false;
  begin update public.hotel_room_types set archived_at=null,is_active=true where id=single_id; exception when check_violation then rejected:=true; end;
  perform pg_temp.archive_assert(rejected,'archive timestamp cannot be cleared');
  rejected:=false;
  begin update public.hotel_room_types set archived_at=now()+interval '1 day' where id=single_id; exception when check_violation then rejected:=true; end;
  perform pg_temp.archive_assert(rejected,'archive timestamp cannot be replaced');
  rejected:=false;
  begin delete from public.hotel_room_types where id=single_id; exception when foreign_key_violation then rejected:=true; end;
  perform pg_temp.archive_assert(rejected,'archive records cannot be physically removed');

  -- Grade edits retain the archived child instead of overwriting or resurrecting it.
  request := (select jsonb_agg(jsonb_build_object('room_kind',room_kind,'is_active',is_active,'version',version,
    'weekday_purchase',weekday_purchase+100,'weekday_sale',weekday_sale+100,'weekend_purchase',weekend_purchase+100,'weekend_sale',weekend_sale+100) order by room_kind)
    from public.hotel_room_types where grade_id=g);
  grade_result := public.save_hotel_room_grade(h,'VIP revised',request,g,1);
  perform pg_temp.archive_assert((select to_jsonb(t)=to_jsonb(saved_type) from public.hotel_room_types t where id=single_id),'grade edit skips every field of archived child');
  request := (select jsonb_agg(jsonb_build_object('room_kind',room_kind,'is_active',true,'version',version,
    'weekday_purchase',weekday_purchase,'weekday_sale',weekday_sale,'weekend_purchase',weekend_purchase,'weekend_sale',weekend_sale) order by room_kind)
    from public.hotel_room_types where grade_id=g);
  rejected:=false;
  begin perform public.save_hotel_room_grade(h,'Illegal revival',request,g,2); exception when check_violation then rejected:=true; end;
  perform pg_temp.archive_assert(rejected and (select name='VIP revised' and version=2 from public.hotel_room_grades where id=g),'grade save cannot revive archived variant or partly rename grade');

  versions := (select jsonb_agg(jsonb_build_object('id',id,'version',version) order by id) from public.hotel_room_types where grade_id=g);
  foreach bad in array array['{}'::jsonb,'null'::jsonb,'[]'::jsonb,jsonb_build_array(versions->0,versions->0,versions->2),
    jsonb_set(versions,'{0,version}','999'),jsonb_set(versions,'{0,id}','"not-a-uuid"')] loop
    rejected:=false;
    begin perform public.archive_hotel_room_grade(g,2,bad); exception when invalid_parameter_value or serialization_failure then rejected:=true; end;
    perform pg_temp.archive_assert(rejected,'malformed/stale child version set rejected atomically');
  end loop;
  perform pg_temp.archive_assert((select archived_at is null from public.hotel_room_grades where id=g)
    and (select archived_at is null and is_active from public.hotel_room_types where id=double_id),'failed grade archives leave live children alone');
  grade_result := public.archive_hotel_room_grade(g,2,versions);
  perform pg_temp.archive_assert(grade_result->>'archived_at' is not null and grade_result->>'version'='3','whole grade archived');
  perform pg_temp.archive_assert((select count(*)=3 and bool_and(archived_at is not null and not is_active) from public.hotel_room_types where grade_id=g),'all three original child records retained and archived');
  perform pg_temp.archive_assert((select archived_at=archive_time and version=2 from public.hotel_room_types where id=single_id),'previously archived child timestamp/version not rewritten');
  select * into booking from public.hotel_reservations where id=book_id;
  perform pg_temp.archive_assert(booking.room_items=saved_items and booking.sale_amount=500 and booking.purchase_amount=300,'whole-grade archive leaves stored snapshots and totals unchanged');
  update public.hotel_reservations set note='Still editable after whole grade archive' where id=book_id returning * into booking;
  perform pg_temp.archive_assert(booking.sale_amount=500 and booking.room_items=saved_items,'note edit still works after grade archive');
  rejected:=false;
  begin perform public.save_hotel_room_grade(h,'Reopened',request,g,3); exception when check_violation then rejected:=true; end;
  perform pg_temp.archive_assert(rejected,'save rejects archived grade');
  rejected:=false;
  begin update public.hotel_room_grades set archived_at=null where id=g; exception when check_violation then rejected:=true; end;
  perform pg_temp.archive_assert(rejected,'grade archive timestamp cannot be cleared');
  rejected:=false;
  begin insert into public.hotel_room_types(hotel_id,grade_id,room_kind,name,weekday_purchase,weekday_sale,weekend_purchase,weekend_sale)
    values(h,g,'SINGLE','Attempted new child',0,0,0,0); exception when check_violation then rejected:=true; end;
  perform pg_temp.archive_assert(rejected,'new children cannot be inserted into archived grades');
  -- Reusing a deleted display name creates new identities; historical IDs remain intact.
  grade_result := public.save_hotel_room_grade(h,'VIP revised',kinds,g2,null);
  perform pg_temp.archive_assert(grade_result->>'id'=g2::text and (select count(*)=2 from public.hotel_room_grades where hotel_id=h and name='VIP revised'),'archived grade display name may be reused safely');
  result := public.archive_hotel_room_type(legacy_id,1);
  insert into public.hotel_room_types(id,hotel_id,name,weekday_purchase,weekday_sale,weekend_purchase,weekend_sale)
    values(new_legacy_id,h,'Doble legacy',200,300,400,500);
  perform pg_temp.archive_assert((select count(*)=2 from public.hotel_room_types where hotel_id=h and name='Doble legacy'),'legacy archived names can be reused without deleting old identity');
  rejected:=false;
  begin delete from public.hotel_room_types where id=new_legacy_id; exception when foreign_key_violation then rejected:=true; end;
  perform pg_temp.archive_assert(rejected,'even unused type uses soft deletion, not hard delete');

  -- Direct authorized archival must not strand live children.
  update public.hotel_room_grades set archived_at=now()+interval '1 day' where id=g2;
  perform pg_temp.archive_assert((select bool_and(archived_at is not null and not is_active) from public.hotel_room_types where grade_id=g2),'direct grade archival also archives children');
  perform pg_temp.archive_assert((select archived_at=now() from public.hotel_room_grades where id=g2),'archival dates are server-stamped');
  execute 'set local role postgres';
  foreach role_name in array array['staff',''] loop
    perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','app_metadata',jsonb_build_object('role',role_name),'user_metadata',jsonb_build_object('role','admin'))::text,true);
    execute 'set local role authenticated';
    rejected:=false;
    begin perform public.archive_hotel_room_type(new_legacy_id,1); exception when insufficient_privilege then rejected:=true; end;
    perform pg_temp.archive_assert(rejected,'staff and editable metadata cannot call type archive');
    rejected:=false;
    begin perform public.archive_hotel_room_grade(g2,1,'[]'); exception when insufficient_privilege then rejected:=true; end;
    perform pg_temp.archive_assert(rejected,'staff and editable metadata cannot call grade archive');
    update public.hotel_room_types set archived_at=now() where id=new_legacy_id;
    get diagnostics affected=row_count;
    perform pg_temp.archive_assert(affected=0,'RLS prevents direct staff archive');
    execute 'set local role postgres';
  end loop;
  perform set_config('request.jwt.claims','{"role":"authenticated","app_metadata":{"role":"admin"}}',true);
  execute 'set local role authenticated';
  result:=public.archive_hotel_room_type(new_legacy_id,1);
  perform pg_temp.archive_assert(result->>'archived_at' is not null,'administrator can archive room type');
  execute 'set local role postgres';
  perform pg_temp.archive_assert(before_hotels=(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.hotel_properties t where id=any(original_hotels)),'all original hotels untouched');
  perform pg_temp.archive_assert(before_grades=(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.hotel_room_grades t where id=any(original_grades)),'all original grades untouched');
  perform pg_temp.archive_assert(before_types=(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.hotel_room_types t where id=any(original_types)),'all original room types untouched');
  perform pg_temp.archive_assert(before_bookings=(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.hotel_reservations t where id=any(original_bookings)),'all original reservations untouched');
  raise notice 'Hotel catalog soft-delete, historical amounts, version conflicts and authorization passed.';
end $$;
rollback;
