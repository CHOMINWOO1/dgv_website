begin;
set local role authenticated;
select set_config('request.jwt.claims','{"role":"authenticated","app_metadata":{"role":"manager"}}',true);
do $$
declare h public.hotel_properties; r public.hotel_reservations; n integer;
begin
 insert into public.hotel_properties(name,weekday_purchase,weekday_sale,weekend_purchase,weekend_sale,weekend_days)
 values ('__hotel_pricing_test__',100,150,200,300,array[5,6]) returning * into h;
 insert into public.hotel_reservations(hotel_id,check_in,check_out,guest_count,guest_names,room_count,pricing_mode,hotel_version,includes_meals,meal_purchase_amount,meal_sale_amount)
 values (h.id,'2026-11-05','2026-11-09',8,'Test guests',4,'standard',h.version,true,80,120) returning * into r;
 if r.weekday_nights<>2 or r.weekend_nights<>2 or r.purchase_amount<>2480 or r.sale_amount<>3720 then raise exception 'Incorrect room/meal price'; end if;
 update public.hotel_properties set weekday_purchase=1000 where id=h.id returning * into h;
 update public.hotel_reservations set guest_count=7 where id=r.id returning * into r;
 if r.purchase_amount<>2480 or r.version<>2 then raise exception 'Historical price changed'; end if;
 update public.hotel_reservations set room_count=2,hotel_version=h.version where id=r.id and version=r.version returning * into r;
 if r.purchase_amount<>4880 then raise exception 'Room change did not reprice'; end if;
 update public.hotel_reservations set guest_count=9 where id=r.id and version=1;
 get diagnostics n=row_count;
 if n<>0 then raise exception 'Stale version overwrite'; end if;
 begin
  update public.hotel_reservations set room_count=3,hotel_version=1 where id=r.id;
  raise exception 'Stale hotel rates accepted';
 exception when serialization_failure then null; end;
 update public.hotel_reservations set pricing_mode='surcharge',room_purchase_amount=500,room_sale_amount=900 where id=r.id returning * into r;
 if r.purchase_amount<>580 or r.sale_amount<>1020 then raise exception 'Surcharge total multiplied or meals missing'; end if;
 update public.hotel_reservations set includes_meals=false where id=r.id returning * into r;
 if r.purchase_amount<>500 or r.meal_purchase_amount<>0 then raise exception 'Meal removal failed'; end if;
 begin
  delete from public.hotel_properties where id=h.id;
  raise exception 'Referenced hotel deleted';
 exception when foreign_key_violation then null; end;
 begin
  update public.hotel_reservations set room_purchase_amount=-1 where id=r.id;
  raise exception 'Negative amount accepted';
 exception when check_violation then null; end;
 delete from public.hotel_reservations where id=r.id;
 delete from public.hotel_properties where id=h.id;
 insert into public.hotel_reservations(hotel_name,check_in,check_out,guest_count,guest_names,purchase_amount,sale_amount)
 values ('legacy test','2026-01-01','2026-01-02',2,'Guests',50,80) returning * into r;
 if r.room_purchase_amount<>50 or r.pricing_mode<>'legacy' then raise exception 'Legacy compatibility failed'; end if;
 delete from public.hotel_reservations where id=r.id;
 perform set_config('request.jwt.claims','{"role":"authenticated","app_metadata":{"role":"staff"}}',true);
 begin
  insert into public.hotel_properties(name,weekday_purchase,weekday_sale,weekend_purchase,weekend_sale) values ('denied',0,0,0,0);
  raise exception 'Staff insert permitted';
 exception when insufficient_privilege then null; end;
end $$;
rollback;