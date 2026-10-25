-- Run the WHOLE file as postgres. Synthetic fixtures, the fault-injection
-- trigger and every change below are removed by the final ROLLBACK.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create function pg_temp.golf_delete_assert(p_ok boolean,p_message text)
returns void language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'FAIL: %',p_message; end if;
end;
$$;
create function pg_temp.golf_delete_wallets() returns jsonb language sql as $$
  select coalesce(jsonb_agg(jsonb_build_object('golf_course',a.golf_course,'balance_vnd',
    a.opening_balance_vnd+coalesce((select sum(d.amount_vnd) from public.golf_course_budget_deposits d where d.golf_course=a.golf_course),0)
    -coalesce((select sum(c.amount_vnd) from public.golf_course_budget_reservation_charges c where c.golf_course=a.golf_course and c.active),0)
  ) order by a.golf_course),'[]'::jsonb) from public.golf_course_budget_accounts a;
$$;
create function pg_temp.golf_delete_snapshot(p_group uuid) returns jsonb language sql as $$
  select jsonb_build_object(
    'parent',(select to_jsonb(g) from public.golf_booking_groups g where g.id=p_group),
    'rounds',(select jsonb_agg(to_jsonb(r) order by r.id) from public.golf_reservations r where r.booking_group_id=p_group),
    'shared',(select jsonb_agg(to_jsonb(p) order by p.id) from public.golf_booking_group_payments p where p.booking_group_id=p_group),
    'legacy',(select jsonb_agg(to_jsonb(p) order by p.id) from public.golf_reservation_payments p
      join public.golf_reservations r on r.id=p.reservation_id where r.booking_group_id=p_group),
    'charges',(select jsonb_agg(to_jsonb(c) order by c.reservation_id) from public.golf_course_budget_reservation_charges c
      join public.golf_reservations r on r.id=c.reservation_id where r.booking_group_id=p_group),
    'offsets',(select jsonb_agg(to_jsonb(o) order by o.reservation_id) from public.golf_partner_reservation_offsets o
      join public.golf_reservations r on r.id=o.reservation_id where r.booking_group_id=p_group));
$$;
-- Late failure proves that payment deletion, cost reversal, detachment and
-- child deletion all roll back if the final parent delete cannot finish.
create function pg_temp.golf_delete_fail_last() returns trigger language plpgsql as $$
begin
  if old.id::text=current_setting('test.golf_delete_fail_group',true) then
    raise exception 'Injected final-parent deletion failure' using errcode='23514';
  end if;
  return old;
end;
$$;
create trigger golf_booking_delete_rollback_test before delete on public.golf_booking_groups
for each row execute function pg_temp.golf_delete_fail_last();

do $$
declare
  actor uuid; target_request uuid:=gen_random_uuid(); control_request uuid:=gen_random_uuid();
  rounds jsonb; payments jsonb; legacy_payload jsonb;
  target record; control_group record; replayed record;
  legacy_id uuid; member_ids uuid[]; original_ids uuid[]; removed_id uuid;
  original_rows jsonb; original_payments jsonb; original_accounts jsonb; original_topups jsonb;
  original_charges jsonb; original_offsets jsonb; original_wallets jsonb;
  target_before jsonb; control_before jsonb; receipt_before jsonb; wallets_before_delete jsonb;
  revision bigint; rejected boolean;
  previous_claims text:=current_setting('request.jwt.claims',true);
begin
  perform pg_temp.golf_delete_assert(current_user='postgres','run the rollback test as postgres');
  select id into actor from auth.users order by id limit 1;
  perform pg_temp.golf_delete_assert(actor is not null,'an existing auth user is required for audit FKs');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated',
    'app_metadata',jsonb_build_object('role','manager'))::text,true);
  select array_agg(r.id),coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]'::jsonb)
    into original_ids,original_rows from public.golf_reservations r;
  select coalesce(jsonb_agg(to_jsonb(p) order by p.id),'[]'::jsonb) into original_payments from public.golf_reservation_payments p;
  select coalesce(jsonb_agg(to_jsonb(a) order by a.golf_course),'[]'::jsonb) into original_accounts from public.golf_course_budget_accounts a;
  select coalesce(jsonb_agg(to_jsonb(d) order by d.id),'[]'::jsonb) into original_topups from public.golf_course_budget_deposits d;
  select coalesce(jsonb_agg(to_jsonb(c) order by c.reservation_id),'[]'::jsonb) into original_charges from public.golf_course_budget_reservation_charges c;
  select coalesce(jsonb_agg(to_jsonb(o) order by o.reservation_id),'[]'::jsonb) into original_offsets from public.golf_partner_reservation_offsets o;
  original_wallets:=pg_temp.golf_delete_wallets();
  rounds:=jsonb_build_array(
    jsonb_build_object('counterparty_name','DELETE TEST','representative_name','A','player_names_en',E'A\nB\nC\nD\nE\nF\nG',
      'pax',7,'golf_date','2099-01-25','golf_time','08:00','golf_course','SAM','holes',18,
      'guest_unit_price_vnd',4000000,'course_unit_price_vnd',3000000,'smart_cart_note','400,000 VND',
      'cost_settlement_type','golf_course','cost_partner_name',null,'customer_type','company','note','Delete target round one'),
    jsonb_build_object('counterparty_name','DELETE TEST','representative_name','A','player_names_en',E'A\nB\nC\nD\nE\nF\nG\nH',
      'pax',8,'golf_date','2099-01-26','golf_time','09:30','golf_course','AT1200','holes',27,
      'guest_unit_price_vnd',4000000,'course_unit_price_vnd',3000000,'smart_cart_note',null,
      'cost_settlement_type','partner','cost_partner_name','Chị Oanh','customer_type','company','note','Delete target round two'));
  payments:='[{"payment_kind":"deposit","amount_vnd":2000000,"payment_date":"2099-01-01","payment_method":"bank","completes_booking":false},
    {"payment_kind":"receipt","amount_vnd":58400000,"payment_date":"2099-01-02","payment_method":"bank","completes_booking":true}]';
  select * into target from public.create_golf_booking_group(target_request,'[ROLLBACK DELETE] completed',rounds,payments);
  select * into control_group from public.create_golf_booking_group(control_request,'[ROLLBACK DELETE] unrelated control',rounds,
    '[{"payment_kind":"deposit","amount_vnd":1234,"payment_date":"2099-01-01","payment_method":"bank","completes_booking":false}]');

  -- Construct a legacy anomaly WITHOUT disabling any production trigger:
  -- create a standalone round/payment first, then attach it as trusted setup.
  -- The delete RPC must clean it up despite the grouped legacy-payment guard.
  legacy_payload:=(rounds->0)||'{"representative_name":"LEGACY","player_names_en":"LEGACY","pax":1,
    "golf_date":"2099-02-01","guest_unit_price_vnd":2000000,"course_unit_price_vnd":1000000,"smart_cart_note":null}'::jsonb;
  select s.saved_id into legacy_id from private.save_golf_reservation_with_payments_single_impl(null,legacy_payload,'[]'::jsonb) s;
  insert into public.golf_reservation_payments(reservation_id,payment_kind,amount_vnd,payment_date,payment_method)
    values(legacy_id,'deposit',50000,'2099-01-01','bank'),(legacy_id,'withdrawal',20000,'2099-01-02','bank');
  update public.golf_reservations set booking_group_id=target.booking_group_id,group_completed=true,
    final_received_amount_vnd=50000,final_received_date='2099-01-02' where id=legacy_id;
  select array_agg(id order by id) into member_ids from public.golf_reservations where booking_group_id=target.booking_group_id;
  select version into revision from public.golf_booking_groups where id=target.booking_group_id;
  select to_jsonb(q) into receipt_before from private.golf_booking_create_requests q where actor_id=actor and request_id=target_request;
  target_before:=pg_temp.golf_delete_snapshot(target.booking_group_id);
  control_before:=pg_temp.golf_delete_snapshot(control_group.booking_group_id);
  wallets_before_delete:=pg_temp.golf_delete_wallets();
  perform pg_temp.golf_delete_assert(cardinality(member_ids)=3 and wallets_before_delete<>original_wallets,
    'completed course/partner plus legacy fixtures exist before deletion');

  rejected:=false;
  begin perform public.delete_golf_booking_group(target.booking_group_id,revision-1);
  exception when serialization_failure then rejected:=true; end;
  perform pg_temp.golf_delete_assert(rejected,'stale group version cannot delete');
  rejected:=false;
  begin perform public.delete_golf_booking_group(target.booking_group_id,null);
  exception when serialization_failure then rejected:=true; end;
  perform pg_temp.golf_delete_assert(rejected,'expected version is mandatory');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated',
    'app_metadata',jsonb_build_object('role','staff'))::text,true);
  rejected:=false;
  begin
    execute 'set local role authenticated';
    perform public.delete_golf_booking_group(target.booking_group_id,revision);
  exception when insufficient_privilege then rejected:=true; end;
  execute 'set local role postgres';
  perform pg_temp.golf_delete_assert(rejected,'staff cannot delete the whole group');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated',
    'app_metadata',jsonb_build_object('role','manager'))::text,true);
  perform pg_temp.golf_delete_assert(target_before=pg_temp.golf_delete_snapshot(target.booking_group_id)
    and wallets_before_delete=pg_temp.golf_delete_wallets(),'rejected deletes leave all rows, payments and balances unchanged');

  perform set_config('test.golf_delete_fail_group',target.booking_group_id::text,true);
  rejected:=false;
  begin perform public.delete_golf_booking_group(target.booking_group_id,revision);
  exception when check_violation then rejected:=true; end;
  perform set_config('test.golf_delete_fail_group','',true);
  perform pg_temp.golf_delete_assert(rejected and target_before=pg_temp.golf_delete_snapshot(target.booking_group_id)
    and wallets_before_delete=pg_temp.golf_delete_wallets(),'late parent failure rolls back all payment removal, detachment, cost reversal and child deletion');

  execute 'set local role authenticated';
  removed_id:=public.delete_golf_booking_group(target.booking_group_id,revision);
  execute 'set local role postgres';
  perform pg_temp.golf_delete_assert(removed_id=target.booking_group_id
    and not exists(select 1 from public.golf_booking_groups where id=removed_id)
    and not exists(select 1 from public.golf_reservations where id=any(member_ids))
    and not exists(select 1 from public.golf_booking_group_payments where booking_group_id=removed_id)
    and not exists(select 1 from public.golf_reservation_payments where reservation_id=any(member_ids)),
    'authenticated manager deletes parent, all rounds, shared and legacy payment records atomically');
  perform pg_temp.golf_delete_assert(
    not exists(select 1 from public.golf_course_budget_reservation_charges where reservation_id=any(member_ids))
    and not exists(select 1 from public.golf_partner_reservation_offsets where reservation_id=any(member_ids))
    and pg_temp.golf_delete_wallets()=original_wallets,'per-round course deductions and partner offsets are removed and wallets restored');
  perform pg_temp.golf_delete_assert(control_before=pg_temp.golf_delete_snapshot(control_group.booking_group_id),
    'another group and its shared deposit remain byte-for-byte unchanged');
  perform pg_temp.golf_delete_assert(receipt_before=(select to_jsonb(q) from private.golf_booking_create_requests q
    where actor_id=actor and request_id=target_request),'whole-group deletion retains the original creation receipt');
  select * into replayed from public.create_golf_booking_group(target_request,'[ROLLBACK DELETE] completed',rounds,payments);
  perform pg_temp.golf_delete_assert(to_jsonb(replayed)=to_jsonb(target)
    and not exists(select 1 from public.golf_booking_groups where id=target.booking_group_id)
    and not exists(select 1 from public.golf_reservations where id=any(member_ids)),
    'old create retry returns its tombstoned result without recreating a deleted booking');
  rejected:=false;
  begin perform public.delete_golf_booking_group(target.booking_group_id,revision);
  exception when no_data_found then rejected:=true; end;
  perform pg_temp.golf_delete_assert(rejected,'already-deleted group fails cleanly without touching another group');
  perform pg_temp.golf_delete_assert(not has_function_privilege('anon','public.delete_golf_booking_group(uuid,bigint)','EXECUTE')
    and not has_table_privilege('authenticated','public.golf_booking_groups','DELETE'),
    'anonymous execution and direct parent deletion remain denied');
  perform pg_temp.golf_delete_assert(original_rows=(select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]'::jsonb)
    from public.golf_reservations r where r.id=any(original_ids)),'preexisting reservations remain unchanged');
  perform pg_temp.golf_delete_assert(original_payments=(select coalesce(jsonb_agg(to_jsonb(p) order by p.id),'[]'::jsonb)
    from public.golf_reservation_payments p),'preexisting standalone payment records remain unchanged');
  perform pg_temp.golf_delete_assert(original_accounts=(select coalesce(jsonb_agg(to_jsonb(a) order by a.golf_course),'[]'::jsonb)
    from public.golf_course_budget_accounts a)
    and original_topups=(select coalesce(jsonb_agg(to_jsonb(d) order by d.id),'[]'::jsonb) from public.golf_course_budget_deposits d),
    'opening balances and course top-ups are not rewritten');
  perform pg_temp.golf_delete_assert(original_charges=(select coalesce(jsonb_agg(to_jsonb(c) order by c.reservation_id),'[]'::jsonb)
    from public.golf_course_budget_reservation_charges c)
    and original_offsets=(select coalesce(jsonb_agg(to_jsonb(o) order by o.reservation_id),'[]'::jsonb) from public.golf_partner_reservation_offsets o),
    'only target cost ledgers are removed; preexisting ledgers remain unchanged');
  perform set_config('request.jwt.claims',coalesce(previous_claims,''),true);
end;
$$;
rollback;
select 'PASS: atomic whole-group deletion, version/role guards, shared and legacy money removal, course/partner reversal, fault rollback and retained creation tombstones' as status;
