-- Isolated test database only. Fixtures and all modifications roll back.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
create or replace function pg_temp.grade_assert(p_ok boolean,p_message text)
returns void language plpgsql as $$
begin if p_ok is distinct from true then raise exception 'FAIL: %',p_message; end if; end $$;

do $$
declare
  h uuid := gen_random_uuid(); h2 uuid := gen_random_uuid(); g uuid := gen_random_uuid(); g2 uuid := gen_random_uuid();
  book_id uuid := gen_random_uuid(); manual_id uuid := gen_random_uuid();
  standard_double uuid; vip_single uuid; vip_double uuid; triple_id uuid;
  types jsonb; saved_types jsonb; new_types jsonb; bad jsonb; grade_result jsonb; items jsonb; saved_items jsonb;
  current_grade_version integer; current_type_version integer;
  booking public.hotel_reservations; rejected boolean; count_rows bigint; role_name text;
  before_hotels jsonb; before_types jsonb; before_bookings jsonb;
  original_hotels uuid[]; original_types uuid[]; original_bookings uuid[];
begin
  perform pg_temp.grade_assert(current_user='postgres','run test as postgres');
  select coalesce(array_agg(id),'{}'),coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') into original_hotels,before_hotels from public.hotel_properties t;
  select coalesce(array_agg(id),'{}'),coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') into original_types,before_types from public.hotel_room_types t;
  select coalesce(array_agg(id),'{}'),coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') into original_bookings,before_bookings from public.hotel_reservations t;
  perform pg_temp.grade_assert(not has_table_privilege('anon','public.hotel_room_grades','SELECT'),'anon cannot read grades');
  perform pg_temp.grade_assert(not has_function_privilege('anon','public.save_hotel_room_grade(uuid,text,jsonb,uuid,integer)','EXECUTE'),'anon cannot call grade save');
  perform pg_temp.grade_assert(not has_column_privilege('authenticated','public.hotel_room_grades','version','UPDATE'),'grade version immutable to clients');
  perform pg_temp.grade_assert(not has_column_privilege('authenticated','public.hotel_room_types','grade_id','UPDATE'),'room grade identity immutable to clients');
  perform pg_temp.grade_assert(not has_column_privilege('authenticated','public.hotel_room_types','room_kind','UPDATE'),'fixed room kind immutable to clients');
  perform set_config('request.jwt.claims','{"role":"authenticated","app_metadata":{"role":"manager"}}',true);
  execute 'set local role authenticated';
  insert into public.hotel_properties(id,name,weekend_days) values(h,'[ROLLBACK] Grade hotel',array[5,6]),(h2,'[ROLLBACK] Other grade hotel',array[5,6]);
  types := '[{"room_kind":"SINGLE","is_active":true,"weekday_purchase":100,"weekday_sale":150,"weekend_purchase":200,"weekend_sale":300},
    {"room_kind":"DOUBLE","is_active":true,"weekday_purchase":200,"weekday_sale":300,"weekend_purchase":400,"weekend_sale":600},
    {"room_kind":"TRIPLE","is_active":false,"weekday_purchase":0,"weekday_sale":0,"weekend_purchase":0,"weekend_sale":0}]'::jsonb;
  grade_result := public.save_hotel_room_grade(h,' STANDARD ',types,g,null);
  perform pg_temp.grade_assert(grade_result->>'id'=g::text and grade_result->>'name'='STANDARD' and grade_result->>'version'='1','client UUID and trimmed grade name accepted');
  grade_result := public.save_hotel_room_grade(h,'VIP',types,g2,null);
  select count(*) into count_rows from public.hotel_room_types where hotel_id=h;
  perform pg_temp.grade_assert(count_rows=6,'two grades each own three fixed variants');
  select id into standard_double from public.hotel_room_types where grade_id=g and room_kind='DOUBLE';
  select id into vip_single from public.hotel_room_types where grade_id=g2 and room_kind='SINGLE';
  select id into vip_double from public.hotel_room_types where grade_id=g2 and room_kind='DOUBLE';
  select id into triple_id from public.hotel_room_types where grade_id=g and room_kind='TRIPLE';
  -- Each grade/type price is independent, not a label-only selection.
  update public.hotel_room_types set weekday_purchase=500,weekday_sale=700,weekend_purchase=600,weekend_sale=800 where id=vip_single;
  items := jsonb_build_array(
    jsonb_build_object('room_type_id',standard_double,'room_type_version',1,'room_count',2,'room_grade','FORGED LABEL','grade_id',g2),
    jsonb_build_object('room_type_id',vip_single,'room_type_version',2,'room_count',1,'room_grade','STANDARD'));
  insert into public.hotel_reservations(id,hotel_id,hotel_version,check_in,check_out,guest_count,guest_names,pricing_mode,
    room_items,includes_meals,meal_purchase_amount,meal_sale_amount,deposit_amount,balance_amount,note)
  values(book_id,h,1,'2026-11-05','2026-11-09',6,'A, B, C, D, E, F','standard',items,true,80,120,1000,5720,'Original') returning * into booking;
  perform pg_temp.grade_assert(booking.room_count=3 and booking.room_purchase_amount=4600 and booking.room_sale_amount=6600
    and booking.purchase_amount=4680 and booking.sale_amount=6720,'mixed grades use their own nightly rates and meal totals');
  perform pg_temp.grade_assert(booking.room_items->0->>'room_grade'='STANDARD' and booking.room_items->0->>'grade_id'=g::text
    and booking.room_items->0->>'room_kind'='DOUBLE' and booking.room_items->1->>'room_grade'='VIP','grade and kind snapshots are server-authoritative');
  saved_items := booking.room_items;
  -- Stale direct per-type edits are detected even if grade version has not changed.
  saved_types := (select jsonb_agg(jsonb_build_object('room_kind',room_kind,'is_active',is_active,'version',version,
    'weekday_purchase',weekday_purchase,'weekday_sale',weekday_sale,'weekend_purchase',weekend_purchase,'weekend_sale',weekend_sale) order by room_kind)
    from public.hotel_room_types where grade_id=g);
  update public.hotel_room_types set weekday_sale=999 where id=standard_double;
  rejected := false;
  begin perform public.save_hotel_room_grade(h,'Unexpected overwrite',saved_types,g,1);
  exception when serialization_failure then rejected:=true; end;
  perform pg_temp.grade_assert(rejected and (select name='STANDARD' from public.hotel_room_grades where id=g),'stale type CAS rejects entire grade save');
  new_types := (select jsonb_agg(jsonb_build_object('room_kind',room_kind,'is_active',false,'version',version,
    'weekday_purchase',weekday_purchase,'weekday_sale',weekday_sale,'weekend_purchase',weekend_purchase,'weekend_sale',weekend_sale) order by room_kind)
    from public.hotel_room_types where grade_id=g);
  grade_result := public.save_hotel_room_grade(h,'DELUXE 새 이름',new_types,g,1);
  perform pg_temp.grade_assert(grade_result->>'version'='2' and not exists(select 1 from public.hotel_room_types where grade_id=g and is_active),'existing grade may retire all variants');
  -- Renamed/retired catalogs, reordered lines, forged metadata, and payment-only changes never reprice history.
  items := jsonb_build_array(jsonb_set(saved_items->1,'{room_grade}','"Current name ignored"'),jsonb_set(saved_items->0,'{room_grade}','"DELUXE 새 이름"'));
  update public.hotel_reservations set room_items=items,note='Payment amendment',deposit_amount=2000,balance_amount=4720,
    room_purchase_amount=1,room_sale_amount=1 where id=book_id returning * into booking;
  perform pg_temp.grade_assert(booking.room_items=saved_items and booking.purchase_amount=4680 and booking.sale_amount=6720,'snapshot names/prices/totals preserved after rename and retirement');
  perform pg_temp.grade_assert(booking.deposit_amount=2000 and booking.balance_amount=4720,'payment-only update works on retired grade');
  rejected := false;
  begin update public.hotel_reservations set check_out='2026-11-10' where id=book_id;
  exception when check_violation then rejected:=true; end;
  perform pg_temp.grade_assert(rejected,'changed stay cannot use disabled room variant');
  rejected := false;
  begin delete from public.hotel_room_types where id=standard_double;
  exception when foreign_key_violation then rejected:=true; end;
  perform pg_temp.grade_assert(rejected,'referenced fixed room type cannot be deleted');
  -- Activate the grade with fresh versions; an explicit stay change adopts current prices/names.
  new_types := (select jsonb_agg(jsonb_build_object('room_kind',room_kind,'is_active',true,'version',version,
    'weekday_purchase',weekday_purchase,'weekday_sale',weekday_sale,'weekend_purchase',weekend_purchase,'weekend_sale',weekend_sale) order by room_kind)
    from public.hotel_room_types where grade_id=g);
  grade_result := public.save_hotel_room_grade(h,'DELUXE 새 이름',new_types,g,2);
  select version into current_type_version from public.hotel_room_types where id=standard_double;
  items := jsonb_set(saved_items,'{0,room_type_version}',to_jsonb(current_type_version));
  update public.hotel_reservations set check_out='2026-11-10',room_items=items where id=book_id returning * into booking;
  perform pg_temp.grade_assert(booking.room_items->0->>'room_grade'='DELUXE 새 이름' and booking.room_sale_amount=12094,'explicit stay change uses reviewed current variant rates');
  -- Surcharge mode still takes the explicit whole-stay amount, without grade multipliers.
  insert into public.hotel_reservations(id,hotel_id,hotel_version,check_in,check_out,guest_count,guest_names,pricing_mode,room_items,room_purchase_amount,room_sale_amount)
  values(manual_id,h,1,'2026-11-05','2026-11-06',2,'Manual','surcharge',
    jsonb_build_array(jsonb_build_object('room_type_id',vip_double,'room_type_version',1,'room_count',1)),12000,15000) returning * into booking;
  perform pg_temp.grade_assert(booking.purchase_amount=12000 and booking.sale_amount=15000 and booking.room_items->0->>'room_grade'='VIP','surcharge and authoritative grade work together');
  -- Validation and atomicity: no partial grade rows or rates on invalid saves.
  foreach bad in array array['{}'::jsonb,'[]'::jsonb,'null'::jsonb,
    jsonb_set(types,'{0,room_kind}','"QUAD"'),jsonb_set(types,'{0,room_kind}','"DOUBLE"'),
    jsonb_set(types,'{0,weekday_sale}','-1'),jsonb_set(types,'{0,weekday_sale}','1.5'),
    jsonb_set(types,'{0,weekday_sale}','1000000000000'),jsonb_set(types,'{0,is_active}','"true"')] loop
    rejected := false;
    begin perform public.save_hotel_room_grade(h,'Invalid grade',bad,gen_random_uuid(),null);
    exception when invalid_parameter_value or check_violation then rejected:=true; end;
    perform pg_temp.grade_assert(rejected,'invalid grade variants rejected: '||bad::text);
  end loop;
  perform pg_temp.grade_assert(not exists(select 1 from public.hotel_room_grades where name='Invalid grade'),'invalid save leaves no partial grade');
  rejected := false;
  begin perform public.save_hotel_room_grade(h,'Duplicate id',types,g,null);
  exception when serialization_failure then rejected:=true; end;
  perform pg_temp.grade_assert(rejected,'repeated create UUID cannot duplicate or overwrite');
  rejected := false;
  begin perform public.save_hotel_room_grade(h,'VIP',types,gen_random_uuid(),null);
  exception when unique_violation then rejected:=true; end;
  perform pg_temp.grade_assert(rejected,'grade names unique per hotel');
  perform public.save_hotel_room_grade(h2,'VIP',types,gen_random_uuid(),null);
  rejected := false;
  begin perform public.save_hotel_room_grade(h2,'Wrong hotel',new_types,g,3);
  exception when foreign_key_violation then rejected:=true; end;
  perform pg_temp.grade_assert(rejected,'cannot move grade between hotels');
  rejected := false;
  begin insert into public.hotel_room_types(hotel_id,grade_id,room_kind,name,weekday_purchase,weekday_sale,weekend_purchase,weekend_sale)
    values(h2,g,'SINGLE','Forged cross-hotel',0,0,0,0);
  exception when foreign_key_violation or unique_violation then rejected:=true; end;
  perform pg_temp.grade_assert(rejected,'composite FK enforces grade hotel ownership');
  execute 'set local role postgres';
  foreach role_name in array array['staff',''] loop
    perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','app_metadata',jsonb_build_object('role',role_name),'user_metadata',jsonb_build_object('role','admin'))::text,true);
    execute 'set local role authenticated';
    select count(*) into count_rows from public.hotel_room_grades;
    perform pg_temp.grade_assert(count_rows=0,'staff and editable metadata cannot read grades');
    rejected:=false;
    begin perform public.save_hotel_room_grade(h,'Unauthorized',types,gen_random_uuid(),null);
    exception when insufficient_privilege then rejected:=true; end;
    perform pg_temp.grade_assert(rejected,'staff cannot call save RPC successfully');
    execute 'set local role postgres';
  end loop;
  perform set_config('request.jwt.claims','{"role":"authenticated","app_metadata":{"role":"admin"}}',true);
  execute 'set local role authenticated';
  perform public.save_hotel_room_grade(h,'Administrator grade',types,gen_random_uuid(),null);
  execute 'set local role postgres';
  perform pg_temp.grade_assert(before_hotels=(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.hotel_properties t where id=any(original_hotels)),'all original hotel rows untouched');
  perform pg_temp.grade_assert(before_types=(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.hotel_room_types t where id=any(original_types)),'all original legacy room type rows untouched');
  perform pg_temp.grade_assert(before_bookings=(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.hotel_reservations t where id=any(original_bookings)),'all original reservations untouched');
  raise notice 'Hotel grade pricing, catalog atomicity, concurrency checks, history and authorization passed.';
end $$;
rollback;
