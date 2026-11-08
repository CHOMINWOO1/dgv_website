import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const {PGlite}=await import(pathToFileURL(process.env.PGLITE_MODULE || 'C:/Users/user/Documents/Codex/2026-08-07/c/tmp/hotel-test-tools/pglite/package/dist/index.js').href);
const db=new PGlite();
try{
 await db.exec(`create role anon;create role authenticated;create schema auth;create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;grant usage on schema public,auth to authenticated,anon;create function public.current_app_role() returns text language sql stable set search_path='' as $$select (select auth.jwt())->'app_metadata'->>'role'$$;`);
 for(const name of ['20261106055039_create_hotel_reservations.sql','20261106061629_hotel_properties_and_reservation_pricing.sql','20261106213812_hotel_room_types_and_mixed_bookings.sql','20261106230956_hotel_grades_and_fixed_room_kinds.sql','20261106232554_hotel_catalog_soft_delete.sql'])await db.exec(await readFile('supabase/migrations/'+name,'utf8'));
 await db.exec(`insert into public.hotel_reservations(hotel_name,check_in,check_out,guest_count,guest_names,purchase_amount,sale_amount) values('Historic hotel','2026-11-08','2026-11-09',2,'Historic Guest',1234567,2345678);`);
 const before=await db.query(`select to_jsonb(r) as record from public.hotel_reservations r`);
 await db.exec('begin;'+await readFile('supabase/migrations/20261108080539_hotel_booking_reference.sql','utf8')+'commit;');
 assert.deepEqual((await db.query(`select to_jsonb(r)-'booking_reference' as record from public.hotel_reservations r`)).rows,before.rows);
 assert.equal((await db.query('select booking_reference from public.hotel_reservations')).rows[0].booking_reference,null);
 for(const role of ['manager','admin']){
  await db.exec(`set role authenticated;set request.jwt.claims='{"app_metadata":{"role":"${role}"}}';update public.hotel_reservations set booking_reference='WH-0099';reset role;`);
  const row=(await db.query('select booking_reference,purchase_amount,sale_amount from public.hotel_reservations')).rows[0];
  assert.equal(row.booking_reference,'WH-0099');assert.equal(row.purchase_amount,1234567);assert.equal(row.sale_amount,2345678);
 }
 await db.exec(`set role authenticated;set request.jwt.claims='{"app_metadata":{"role":"staff"}}';update public.hotel_reservations set booking_reference='NOT-ALLOWED';reset role;`);
 assert.equal((await db.query('select booking_reference from public.hotel_reservations')).rows[0].booking_reference,'WH-0099');
 await assert.rejects(()=>db.exec(`update public.hotel_reservations set booking_reference=''`));
 await assert.rejects(()=>db.exec(`update public.hotel_reservations set booking_reference=repeat('x',121)`));
 await assert.rejects(()=>db.exec(`update public.hotel_reservations set booking_reference=E'bad\nref'`));
 await db.exec('set role anon;');await assert.rejects(()=>db.query('select * from public.hotel_reservations'));await db.exec('reset role;');
 console.log('Hotel booking-reference migration preserves old data, snapshots, manager/admin permissions and validation.');
}finally{await db.close();}

