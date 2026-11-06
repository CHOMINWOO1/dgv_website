-- Run this entire file against a separately prepared test database as postgres.
-- All fixtures are transaction-local and the final ROLLBACK removes them.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create function pg_temp.hotel_assert(p_ok boolean, p_message text)
returns void language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'FAIL: %', p_message; end if;
end $$;

do $$
declare
  hotel_id uuid := gen_random_uuid(); other_hotel_id uuid := gen_random_uuid();
  twin_id uuid := gen_random_uuid(); suite_id uuid := gen_random_uuid(); other_type_id uuid := gen_random_uuid();
  booking_id uuid := gen_random_uuid(); old_booking_id uuid := gen_random_uuid(); manual_id uuid := gen_random_uuid();
  original_properties jsonb; original_reservations jsonb;
  property_ids uuid[]; reservation_ids uuid[];
  items jsonb; changed_items jsonb; saved_items jsonb; old_snapshot jsonb;
  booking public.hotel_reservations; previous public.hotel_reservations;
  rejected boolean; affected bigint; test_role text; bad jsonb;
begin
  perform pg_temp.hotel_assert(current_user='postgres','run the whole test as postgres');
  select coalesce(array_agg(id),'{}'::uuid[]),coalesce(jsonb_agg(to_jsonb(p) order by id),'[]'::jsonb)
    into property_ids,original_properties from public.hotel_properties p;
  select coalesce(array_agg(id),'{}'::uuid[]),coalesce(jsonb_agg(to_jsonb(r) order by id),'[]'::jsonb)
    into reservation_ids,original_reservations from public.hotel_reservations r;

  perform pg_temp.hotel_assert(not has_table_privilege('anon','public.hotel_room_types','SELECT'), 'anonymous room rates are not exposed');
  perform pg_temp.hotel_assert(not has_column_privilege('authenticated','public.hotel_room_types','version','UPDATE'), 'clients cannot change room type versions');
  perform pg_temp.hotel_assert(not has_column_privilege('authenticated','public.hotel_room_types','hotel_id','UPDATE'), 'clients cannot move a room type to another hotel');
  perform set_config('request.jwt.claims', '{"role":"authenticated","app_metadata":{"role":"manager"}}', true);
  execute 'set local role authenticated';
  insert into public.hotel_properties(id,name,weekend_days) values(hotel_id,'[ROLLBACK] Hotel rooms',array[5,6]),(other_hotel_id,'[ROLLBACK] Other hotel',array[0,6]);
  insert into public.hotel_room_types(id,hotel_id,name,weekday_purchase,weekday_sale,weekend_purchase,weekend_sale)
    values(twin_id,hotel_id,'Twin',100,150,200,300), (suite_id,hotel_id,'Suite',300,500,400,600),
      (other_type_id,other_hotel_id,'Other',10,20,30,40);
  items := jsonb_build_array(
    jsonb_build_object('room_type_id',twin_id,'room_count',2,'room_grade','STANDARD','room_type_version',1),
    jsonb_build_object('room_type_id',suite_id,'room_count',1,'room_grade','VIP','room_type_version',1));
  insert into public.hotel_reservations(id,hotel_id,hotel_version,check_in,check_out,guest_count,guest_names,
    room_count,pricing_mode,room_items,includes_meals,meal_purchase_amount,meal_sale_amount,deposit_amount,balance_amount,note)
  values(booking_id,hotel_id,1,'2026-11-05','2026-11-09',6,E'A\nB\nC\nD\nE\nF',999,'standard',items,true,80,120,1000,3120,'Mixed rooms')
  returning * into booking;
  execute 'set local role postgres';
  perform pg_temp.hotel_assert(booking.room_count=3 and booking.weekday_nights=2 and booking.weekend_nights=2,'room counts and nightly split are authoritative');
  perform pg_temp.hotel_assert(booking.room_purchase_amount=2600 and booking.room_sale_amount=4000
    and booking.purchase_amount=2680 and booking.sale_amount=4120,'mixed rooms and meal totals are exact');
  perform pg_temp.hotel_assert(booking.deposit_amount=1000 and booking.balance_amount=3120 and booking.note='Mixed rooms','payment inputs and note are retained');
  perform pg_temp.hotel_assert(booking.room_items->0->>'name'='Twin' and booking.room_items->1->>'room_grade'='VIP'
    and (booking.room_items->0->>'room_purchase_amount')::bigint=1200,'server snapshots preserve both room lines');
  saved_items := booking.room_items;

  -- Hotel and room rate changes must not reprice an otherwise unchanged booking.
  update public.hotel_room_types set weekday_purchase=999,name='Twin revised' where id=twin_id;
  update public.hotel_properties set weekday_purchase=777,weekday_sale=888 where id=hotel_id;
  update public.hotel_reservations set note='Names and payments only',guest_names=E'A2\nB\nC\nD\nE\nF',
    deposit_amount=null,balance_amount=0,room_items=items,room_purchase_amount=1,room_sale_amount=1
    where id=booking_id returning * into booking;
  perform pg_temp.hotel_assert(booking.room_items=saved_items and booking.purchase_amount=2680 and booking.sale_amount=4120,
    'unchanged room inputs retain names, rate snapshots and totals after catalog changes');
  perform pg_temp.hotel_assert(booking.deposit_amount is null and booking.balance_amount=0,'blank and legitimate zero payment are distinct');

  -- Reordering identical inputs is display-only and must not apply new prices.
  update public.hotel_reservations set room_items=jsonb_build_array(items->1,items->0)
    where id=booking_id returning * into booking;
  perform pg_temp.hotel_assert(booking.room_items=saved_items and booking.sale_amount=4120,'reordered rows retain stored prices');

  changed_items := jsonb_set(items,'{0,room_count}','3'::jsonb);
  rejected := false;
  begin update public.hotel_reservations set room_items=changed_items where id=booking_id;
  exception when serialization_failure then rejected := true; end;
  perform pg_temp.hotel_assert(rejected,'stale hotel version is rejected when repricing');
  rejected := false;
  begin update public.hotel_reservations set room_items=changed_items,hotel_version=2 where id=booking_id;
  exception when serialization_failure then rejected := true; end;
  perform pg_temp.hotel_assert(rejected,'stale room version is rejected when repricing');
  changed_items := jsonb_set(changed_items,'{0,room_type_version}','2'::jsonb);
  update public.hotel_reservations set room_items=changed_items,hotel_version=2 where id=booking_id returning * into booking;
  perform pg_temp.hotel_assert(booking.room_count=4 and booking.room_purchase_amount=8594 and booking.sale_amount=5020,
    'explicit changed room count uses the reviewed current room rates');

  -- Invalid room input and cross-hotel membership must fail atomically.
  foreach bad in array array['[]'::jsonb,'{}'::jsonb,'null'::jsonb,
    jsonb_set(changed_items,'{0,room_count}','0'::jsonb),
    jsonb_set(changed_items,'{0,room_count}','1.5'::jsonb),
    jsonb_set(changed_items,'{0,room_grade}','"GOLD"'::jsonb),
    jsonb_set(changed_items,'{0,room_type_id}',to_jsonb(other_type_id))] loop
    rejected := false;
    begin update public.hotel_reservations set room_items=bad where id=booking_id;
    exception when invalid_parameter_value or check_violation or foreign_key_violation then rejected := true; end;
    perform pg_temp.hotel_assert(rejected,'invalid room structure/identity/count/grade is rejected: '||bad::text);
  end loop;
  rejected := false;
  begin update public.hotel_reservations set room_items=null where id=booking_id;
  exception when check_violation then rejected := true; end;
  perform pg_temp.hotel_assert(rejected,'mixed room bookings cannot fall back silently to old hotel-wide prices');
  rejected := false;
  begin update public.hotel_reservations set deposit_amount=-1 where id=booking_id;
  exception when check_violation then rejected := true; end;
  perform pg_temp.hotel_assert(rejected,'negative deposits are rejected');
  rejected := false;
  begin update public.hotel_reservations set balance_amount=1000000000000 where id=booking_id;
  exception when check_violation then rejected := true; end;
  perform pg_temp.hotel_assert(rejected,'over-range balance amounts are rejected');

  -- Referenced catalogs can be retired, but history cannot be orphaned.
  rejected := false;
  begin delete from public.hotel_room_types where id=twin_id;
  exception when foreign_key_violation then rejected := true; end;
  perform pg_temp.hotel_assert(rejected,'a room type used by bookings cannot be deleted');
  update public.hotel_room_types set is_active=false where id=suite_id;
  update public.hotel_reservations set note='Retired type still preserved' where id=booking_id returning * into booking;
  perform pg_temp.hotel_assert(booking.sale_amount=5020,'unchanged bookings retain a retired room type');
  rejected := false;
  begin update public.hotel_reservations set check_out='2026-11-10' where id=booking_id;
  exception when check_violation then rejected := true; end;
  perform pg_temp.hotel_assert(rejected,'retired room types cannot be used for newly repriced stays');

  -- Surcharge keeps its explicit whole-stay amounts; grade does not invent a multiplier.
  insert into public.hotel_reservations(id,hotel_id,hotel_version,check_in,check_out,guest_count,guest_names,
    pricing_mode,room_items,room_purchase_amount,room_sale_amount,deposit_amount,balance_amount)
    values(manual_id,hotel_id,2,'2026-11-05','2026-11-09',2,'Manual', 'surcharge',
      jsonb_build_array(jsonb_build_object('room_type_id',twin_id,'room_count',1,'room_grade','VIP','room_type_version',2)),
      12000,15000,null,null) returning * into booking;
  perform pg_temp.hotel_assert(booking.room_count=1 and booking.purchase_amount=12000 and booking.sale_amount=15000,
    'surcharge manual room totals are preserved with a room-type selection');
  update public.hotel_reservations set room_sale_amount=16000,note='Manual amendment' where id=manual_id returning * into booking;
  perform pg_temp.hotel_assert(booking.sale_amount=16000,'manual surcharge total remains editable without changing catalog selections');

  -- Existing standard reservations without room types keep their old API and snapshots.
  insert into public.hotel_reservations(id,hotel_id,hotel_version,check_in,check_out,guest_count,guest_names,
    room_count,pricing_mode) values(old_booking_id,hotel_id,2,'2026-11-05','2026-11-06',1,'Old hotel-rate booking',2,'standard')
    returning * into previous;
  old_snapshot := previous.rate_snapshot;
  update public.hotel_properties set weekday_purchase=9999,weekday_sale=9999 where id=hotel_id;
  update public.hotel_reservations set note='Old row edited',deposit_amount=0 where id=old_booking_id returning * into booking;
  perform pg_temp.hotel_assert(booking.room_items is null and booking.rate_snapshot=old_snapshot
    and booking.purchase_amount=previous.purchase_amount and booking.sale_amount=previous.sale_amount,
    'old standard bookings are not repriced by adding note or payment information');

  -- RLS is enforced by the real authenticated role, not only JWT labels.
  foreach test_role in array array['staff',''] loop
    perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','app_metadata',jsonb_build_object('role',test_role),
      'user_metadata',jsonb_build_object('role','admin'))::text,true);
    execute 'set local role authenticated';
    select count(*) into affected from public.hotel_room_types;
    perform pg_temp.hotel_assert(affected=0,'staff and forged editable metadata cannot read catalog rates');
    rejected := false;
    begin insert into public.hotel_room_types(hotel_id,name,weekday_purchase,weekday_sale,weekend_purchase,weekend_sale)
      values(hotel_id,'Unauthorized',0,0,0,0);
    exception when insufficient_privilege then rejected := true; end;
    perform pg_temp.hotel_assert(rejected,'staff and forged editable metadata cannot insert room types');
    execute 'set local role postgres';
  end loop;
  perform set_config('request.jwt.claims','{"role":"authenticated","app_metadata":{"role":"admin"}}',true);
  execute 'set local role authenticated';
  select count(*) into affected from public.hotel_room_types where id in (twin_id,suite_id,other_type_id);
  perform pg_temp.hotel_assert(affected=3,'administrator can read all hotel room types');
  update public.hotel_room_types set name='Other admin edit' where id=other_type_id;
  execute 'set local role postgres';
  perform pg_temp.hotel_assert((select name='Other admin edit' from public.hotel_room_types where id=other_type_id),
    'administrator can edit room types');
  perform pg_temp.hotel_assert(original_properties=(select coalesce(jsonb_agg(to_jsonb(p) order by id),'[]'::jsonb)
    from public.hotel_properties p where id=any(property_ids)), 'all pre-test hotels are unchanged');
  perform pg_temp.hotel_assert(original_reservations=(select coalesce(jsonb_agg(to_jsonb(r) order by id),'[]'::jsonb)
    from public.hotel_reservations r where id=any(reservation_ids)), 'all pre-test bookings are unchanged');
  raise notice 'Hotel mixed room pricing, snapshots, payments, retirement and role isolation passed.';
end $$;
rollback;
