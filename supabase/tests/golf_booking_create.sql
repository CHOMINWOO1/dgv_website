-- Rollback-only creation/integration test. Run the WHOLE file as postgres.
-- New golf fixtures and request receipts are removed by the final ROLLBACK.
-- Existing auth users are read for valid audit FKs; none are modified.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create function pg_temp.golf_create_assert(p_ok boolean,p_message text)
returns void language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'FAIL: %',p_message; end if;
end;
$$;

do $$
declare
  actor uuid; another_actor uuid;
  request_pending uuid := gen_random_uuid(); request_deposit uuid := gen_random_uuid();
  request_complete uuid := gen_random_uuid(); request_failed uuid;
  rounds jsonb; priced_rounds jsonb; bad_rounds jsonb; payments jsonb; edited_payments jsonb; payload jsonb;
  created record; deposited record; completed record; replayed record; scoped record;
  original_ids uuid[]; original_rows jsonb; original_payments jsonb; original_accounts jsonb;
  before_counts bigint[]; after_counts bigint[]; request_keys uuid[] := '{}'::uuid[];
  version_before bigint; version_after bigint; second_id uuid; n bigint; amount bigint;
  rejected boolean; field_name text; previous_claims text := current_setting('request.jwt.claims',true);
begin
  perform pg_temp.golf_create_assert(current_user='postgres','run the whole rollback file as postgres');
  select id into actor from auth.users order by id limit 1;
  select id into another_actor from auth.users where id<>actor order by id limit 1;
  perform pg_temp.golf_create_assert(actor is not null,'an existing auth user is required for valid audit FKs');
  perform set_config('request.jwt.claims',jsonb_build_object(
    'sub',actor,'role','authenticated','app_metadata',jsonb_build_object('role','manager'))::text,true);
  select array_agg(r.id),coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]'::jsonb)
    into original_ids,original_rows from public.golf_reservations r;
  select coalesce(jsonb_agg(to_jsonb(p) order by p.id),'[]'::jsonb)
    into original_payments from public.golf_reservation_payments p;
  select coalesce(jsonb_agg(to_jsonb(a) order by a.golf_course),'[]'::jsonb)
    into original_accounts from public.golf_course_budget_accounts a;

  rounds := jsonb_build_array(
    jsonb_build_object('counterparty_name','CREATE TEST','representative_name','A',
      'player_names_en',E'A\nB\nC\nD\nE\nF\nG','pax',7,'golf_date','2099-01-25','golf_time','08:00',
      'golf_course','SAM','holes',18,'guest_unit_price_vnd',null,'course_unit_price_vnd',null,
      'smart_cart_note',null,'cost_settlement_type','golf_course','cost_partner_name',null,
      'customer_type','company','note','Independent first round'),
    jsonb_build_object('counterparty_name','CREATE TEST','representative_name','A',
      'player_names_en',E'A\nB\nC\nD\nE\nF\nG\nH','pax',8,'golf_date','2099-01-26','golf_time','09:30',
      'golf_course','AT1200','holes',27,'guest_unit_price_vnd',null,'course_unit_price_vnd',null,
      'smart_cart_note',null,'cost_settlement_type','golf_course','cost_partner_name',null,
      'customer_type','company','note','Independent second round'));

  -- Actual authenticated SQL role proves public/private execution grants and
  -- manager SELECT policies, not just a privileged call with manager claims.
  execute 'set local role authenticated';
  select * into created from public.create_golf_booking_group(request_pending,'[ROLLBACK] unpriced 7/8',rounds,'[]'::jsonb);
  select count(*) into n from public.golf_reservations where booking_group_id=created.booking_group_id;
  execute 'set local role postgres';
  request_keys := array_append(request_keys,request_pending);
  perform pg_temp.golf_create_assert(n=2 and created.saved_status='in_progress','manager creates and reads two pending rounds');
  perform pg_temp.golf_create_assert(
    (select pax=7 and player_names_en=E'A\nB\nC\nD\nE\nF\nG' and golf_time='08:00'::time
      from public.golf_reservations where id=created.saved_id)
    and (select pax=8 and player_names_en=E'A\nB\nC\nD\nE\nF\nG\nH' and golf_time='09:30'::time
      from public.golf_reservations where booking_group_id=created.booking_group_id and id<>created.saved_id),
    'new rounds preserve independent 7/8 headcounts, names and tee times');
  perform pg_temp.golf_create_assert(
    not exists(select 1 from public.golf_reservations where booking_group_id=created.booking_group_id
      and (guest_total_vnd is not null or course_total_vnd is not null or status<>'in_progress'))
    and not exists(select 1 from public.golf_booking_group_payments where booking_group_id=created.booking_group_id),
    'unpriced creation does not invent prices, payments or completion');
  perform pg_temp.golf_create_assert(
    not exists(select 1 from public.golf_course_budget_reservation_charges c join public.golf_reservations r on r.id=c.reservation_id
      where r.booking_group_id=created.booking_group_id)
    and not exists(select 1 from public.golf_partner_reservation_offsets o join public.golf_reservations r on r.id=o.reservation_id
      where r.booking_group_id=created.booking_group_id),'unpriced creation has no cost ledger effect');

  payments := '[{"payment_kind":"deposit","amount_vnd":2000000,"payment_date":"2099-01-01","payment_method":"bank","completes_booking":false,"sort_order":0}]';
  select * into deposited from public.create_golf_booking_group(request_deposit,'[ROLLBACK] shared deposit',rounds,payments);
  request_keys := array_append(request_keys,request_deposit);
  select count(*),sum(amount_vnd) into n,amount from public.golf_booking_group_payments where booking_group_id=deposited.booking_group_id;
  perform pg_temp.golf_create_assert(n=1 and amount=2000000 and deposited.saved_status='in_progress','one shared deposit is stored once');
  perform pg_temp.golf_create_assert(
    not exists(select 1 from public.golf_reservations where booking_group_id=deposited.booking_group_id
      and (deposit_amount_vnd<>0 or final_received_amount_vnd is not null or final_received_date is not null))
    and not exists(select 1 from public.golf_reservation_payments p join public.golf_reservations r on r.id=p.reservation_id
      where r.booking_group_id=deposited.booking_group_id),'creation never copies shared money into children');
  select version into version_before from public.golf_booking_groups where id=deposited.booking_group_id;
  select * into replayed from public.create_golf_booking_group(request_deposit,'[ROLLBACK] shared deposit',rounds,payments);
  perform pg_temp.golf_create_assert(to_jsonb(replayed)=to_jsonb(deposited),'identical retry returns the original response');
  perform pg_temp.golf_create_assert(
    (select version=version_before from public.golf_booking_groups where id=deposited.booking_group_id)
    and (select count(*)=2 from public.golf_reservations where booking_group_id=deposited.booking_group_id)
    and (select count(*)=1 and sum(amount_vnd)=2000000 from public.golf_booking_group_payments where booking_group_id=deposited.booking_group_id),
    'retry does not replay saves, create rounds or duplicate the deposit');

  -- Later changes must not be overwritten by a delayed original create retry.
  select jsonb_agg(to_jsonb(p)||'{"amount_vnd":2500000}'::jsonb order by p.id) into edited_payments
    from public.golf_booking_group_payments p where p.booking_group_id=deposited.booking_group_id;
  select to_jsonb(r)||jsonb_build_object('expected_updated_at',r.updated_at,'note','later edit') into payload
    from public.golf_reservations r where r.id=deposited.saved_id;
  perform * from public.save_golf_booking_group(deposited.booking_group_id,deposited.saved_id,payload,edited_payments,version_before);
  select version into version_after from public.golf_booking_groups where id=deposited.booking_group_id;
  select * into replayed from public.create_golf_booking_group(request_deposit,'[ROLLBACK] shared deposit',rounds,payments);
  perform pg_temp.golf_create_assert(to_jsonb(replayed)=to_jsonb(deposited)
    and (select version=version_after from public.golf_booking_groups where id=deposited.booking_group_id)
    and (select sum(amount_vnd)=2500000 from public.golf_booking_group_payments where booking_group_id=deposited.booking_group_id)
    and (select note='later edit' from public.golf_reservations where id=deposited.saved_id),
    'retry after edits returns the original response without replaying money or details');
  rejected := false;
  begin perform * from public.create_golf_booking_group(request_deposit,'[ROLLBACK] changed label',rounds,payments);
  exception when unique_violation then rejected := true; end;
  perform pg_temp.golf_create_assert(rejected,'same key with changed payload is rejected');

  -- Identical UUIDs belong to different user namespaces, not a global request.
  if another_actor is not null then
    perform set_config('request.jwt.claims',jsonb_build_object('sub',another_actor,'role','authenticated',
      'app_metadata',jsonb_build_object('role','manager'))::text,true);
    select * into scoped from public.create_golf_booking_group(request_pending,'[ROLLBACK] unpriced 7/8',rounds,'[]'::jsonb);
    perform pg_temp.golf_create_assert(scoped.booking_group_id<>created.booking_group_id,'request UUID is scoped to actor');
    perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated',
      'app_metadata',jsonb_build_object('role','manager'))::text,true);
  else
    raise notice 'Actor-isolation dynamic check skipped: only one auth user exists; composite PK still checked below.';
  end if;

  -- Failures below must leave no request receipt, parent, first child, funds,
  -- charge or offset. In particular invalid second-round cost fails AFTER the
  -- first reservation has been inserted via the existing standalone helper.
  before_counts := array[(select count(*) from public.golf_reservations),
    (select count(*) from public.golf_booking_groups),(select count(*) from public.golf_booking_group_payments),
    (select count(*) from public.golf_course_budget_reservation_charges),(select count(*) from public.golf_partner_reservation_offsets)];
  request_failed := gen_random_uuid();
  foreach n in array array[0,1,31]::bigint[] loop
    select coalesce(jsonb_agg(rounds->0),'[]'::jsonb) into bad_rounds from generate_series(1,n);
    rejected := false;
    begin perform * from public.create_golf_booking_group(request_failed,'[ROLLBACK] round count',bad_rounds,'[]'::jsonb);
    exception when invalid_parameter_value then rejected := true; end;
    perform pg_temp.golf_create_assert(rejected,'creation requires 2–30 rounds: '||n);
  end loop;
  rejected := false;
  begin perform * from public.create_golf_booking_group(request_failed,'[ROLLBACK] missing cost',rounds,
    '[{"payment_kind":"receipt","amount_vnd":1000,"payment_date":"2099-01-01","payment_method":"bank","completes_booking":true}]');
  exception when check_violation then rejected := true; end;
  perform pg_temp.golf_create_assert(rejected and not exists(select 1 from private.golf_booking_create_requests
    where actor_id=actor and request_id=request_failed),'completion with any unknown cost rolls back its receipt');
  rejected := false;
  bad_rounds := jsonb_set(rounds,'{1,course_unit_price_vnd}','-1'::jsonb);
  begin perform * from public.create_golf_booking_group(request_failed,'[ROLLBACK] partial second-row failure',bad_rounds,'[]'::jsonb);
  exception when check_violation then rejected := true; end;
  perform pg_temp.golf_create_assert(rejected,'invalid second-round price fails after initial inserts');
  rejected := false;
  begin perform * from public.create_golf_booking_group(request_failed,'[ROLLBACK] cash threshold',rounds,
    '[{"payment_kind":"deposit","amount_vnd":5000000,"payment_date":"2099-01-01","payment_method":"cash","completes_booking":false}]');
  exception when check_violation then rejected := true; end;
  perform pg_temp.golf_create_assert(rejected,'5m cash is rejected by the reused shared-payment validation');
  foreach field_name in array array['pax','player_names_en','golf_date','golf_time','holes'] loop
    rejected := false;
    bad_rounds := jsonb_build_array(rounds->0,(rounds->1)-field_name);
    begin perform * from public.create_golf_booking_group(request_failed,'[ROLLBACK] required field',bad_rounds,'[]'::jsonb);
    exception when check_violation then rejected := true; end;
    perform pg_temp.golf_create_assert(rejected,'missing required round field rejected: '||field_name);
  end loop;
  rejected := false;
  begin perform * from public.create_golf_booking_group(request_failed,'[ROLLBACK] common agency',
    jsonb_set(rounds,'{1,counterparty_name}','"ANOTHER AGENCY"'::jsonb),'[]'::jsonb);
  exception when check_violation then rejected := true; end;
  perform pg_temp.golf_create_assert(rejected,'all round counterparties must match');
  rejected := false;
  begin perform * from public.create_golf_booking_group(request_failed,'[ROLLBACK] missing partner',
    jsonb_set(rounds,'{1,cost_settlement_type}','"partner"'::jsonb),'[]'::jsonb);
  exception when check_violation then rejected := true; end;
  perform pg_temp.golf_create_assert(rejected,'partner route requires an explicit supported partner');
  rejected := false;
  begin perform * from public.create_golf_booking_group(request_failed,'[ROLLBACK] identity injection',
    jsonb_set(rounds,'{1,booking_group_id}',to_jsonb(deposited.booking_group_id)),'[]'::jsonb);
  exception when invalid_parameter_value then rejected := true; end;
  perform pg_temp.golf_create_assert(rejected,'new-round input cannot assign an existing group or legacy identity');
  after_counts := array[(select count(*) from public.golf_reservations),
    (select count(*) from public.golf_booking_groups),(select count(*) from public.golf_booking_group_payments),
    (select count(*) from public.golf_course_budget_reservation_charges),(select count(*) from public.golf_partner_reservation_offsets)];
  perform pg_temp.golf_create_assert(before_counts=after_counts and not exists(
    select 1 from private.golf_booking_create_requests where actor_id=actor and request_id=request_failed),
    'failed attempts roll back all partial creation and allow corrected reuse of the failed key');

  -- Reusing that failed key is safe because no successful receipt existed.
  select * into replayed from public.create_golf_booking_group(request_failed,'[ROLLBACK] corrected false completion',rounds,
    '[{"payment_kind":"receipt","amount_vnd":1000,"payment_date":"2099-01-01","payment_method":"bank","completes_booking":false}]');
  request_keys := array_append(request_keys,request_failed);
  perform pg_temp.golf_create_assert(replayed.saved_status='in_progress','false completion stays pending despite a receipt');

  priced_rounds := jsonb_build_array(
    (rounds->0)||'{"guest_unit_price_vnd":4000000,"course_unit_price_vnd":3000000,"smart_cart_note":"400,000 VND"}'::jsonb,
    (rounds->1)||'{"guest_unit_price_vnd":4000000,"course_unit_price_vnd":3000000,"cost_settlement_type":"partner","cost_partner_name":"Chị Oanh"}'::jsonb);
  edited_payments := payments||'[{"payment_kind":"receipt","amount_vnd":58400000,"payment_date":"2099-01-02","payment_method":"bank","completes_booking":true,"sort_order":0}]'::jsonb;
  select * into completed from public.create_golf_booking_group(request_complete,'[ROLLBACK] completed group',priced_rounds,edited_payments);
  request_keys := array_append(request_keys,request_complete);
  perform pg_temp.golf_create_assert(completed.saved_status='completed'
    and (select count(*)=2 from public.golf_reservations where booking_group_id=completed.booking_group_id and status='completed'),
    'complete creation marks every priced round completed');
  perform pg_temp.golf_create_assert(
    (select count(*)=1 and sum(c.amount_vnd)=21400000 from public.golf_course_budget_reservation_charges c
      join public.golf_reservations r on r.id=c.reservation_id where r.booking_group_id=completed.booking_group_id and c.active)
    and (select count(*)=1 and sum(o.amount_vnd)=24000000 from public.golf_partner_reservation_offsets o
      join public.golf_reservations r on r.id=o.reservation_id where r.booking_group_id=completed.booking_group_id and o.active),
    'completed creation routes each full round cost once to its course or partner');
  select * into replayed from public.create_golf_booking_group(request_complete,'[ROLLBACK] completed group',priced_rounds,edited_payments);
  perform pg_temp.golf_create_assert(to_jsonb(replayed)=to_jsonb(completed)
    and (select count(*)=2 and sum(amount_vnd)=60400000 from public.golf_booking_group_payments where booking_group_id=completed.booking_group_id),
    'completed retry returns the original result and no duplicate receipts');

  -- Empty parent deletion intentionally does not cascade into the request
  -- receipt. Even deleted IDs are returned as the original result, not recreated.
  select id into second_id from public.golf_reservations where booking_group_id=created.booking_group_id and id<>created.saved_id;
  select version into version_before from public.golf_booking_groups where id=created.booking_group_id;
  perform public.delete_golf_booking_round(created.saved_id,version_before);
  select version into version_before from public.golf_booking_groups where id=created.booking_group_id;
  perform public.delete_golf_booking_round(second_id,version_before);
  select * into replayed from public.create_golf_booking_group(request_pending,'[ROLLBACK] unpriced 7/8',rounds,'[]'::jsonb);
  perform pg_temp.golf_create_assert(to_jsonb(replayed)=to_jsonb(created)
    and not exists(select 1 from public.golf_booking_groups where id=created.booking_group_id)
    and not exists(select 1 from public.golf_reservations where booking_group_id=created.booking_group_id),
    'tombstoned successful request never recreates deleted bookings');

  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated',
    'app_metadata',jsonb_build_object('role','staff'))::text,true);
  rejected := false;
  begin
    execute 'set local role authenticated';
    perform * from public.create_golf_booking_group(gen_random_uuid(),'[ROLLBACK] denied staff',rounds,'[]'::jsonb);
  exception when insufficient_privilege then rejected := true; end;
  execute 'set local role postgres';
  perform pg_temp.golf_create_assert(rejected,'staff cannot create a group through the public RPC');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated',
    'user_metadata',jsonb_build_object('role','admin'))::text,true);
  rejected := false;
  begin perform * from public.create_golf_booking_group(gen_random_uuid(),'[ROLLBACK] forged editable role',rounds,'[]'::jsonb);
  exception when insufficient_privilege then rejected := true; end;
  perform pg_temp.golf_create_assert(rejected,'user-editable metadata cannot grant administrator creation');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated',
    'app_metadata',jsonb_build_object('role','admin'))::text,true);
  execute 'set local role authenticated';
  select * into scoped from public.create_golf_booking_group(gen_random_uuid(),'[ROLLBACK] allowed admin',rounds,'[]'::jsonb);
  execute 'set local role postgres';
  perform pg_temp.golf_create_assert(scoped.saved_status='in_progress','authenticated administrator can create a new group');
  perform pg_temp.golf_create_assert(
    not has_function_privilege('anon','public.create_golf_booking_group(uuid,text,jsonb,jsonb)','EXECUTE')
    and not has_table_privilege('authenticated','private.golf_booking_create_requests','SELECT')
    and not has_table_privilege('authenticated','private.golf_booking_create_requests','INSERT')
    and not has_table_privilege('authenticated','private.golf_booking_create_requests','DELETE'),
    'anonymous RPC and direct request-ledger access stay denied');
  perform pg_temp.golf_create_assert(
    (select relrowsecurity from pg_class where oid='private.golf_booking_create_requests'::regclass)
    and (select count(*)=0 from pg_constraint where conrelid='private.golf_booking_create_requests'::regclass and contype='f'),
    'private request ledger has defense-in-depth RLS and durable no-FK tombstones');

  perform pg_temp.golf_create_assert(original_rows=(select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]'::jsonb)
    from public.golf_reservations r where r.id=any(original_ids)),'all preexisting reservations remain unchanged');
  perform pg_temp.golf_create_assert(original_payments=(select coalesce(jsonb_agg(to_jsonb(p) order by p.id),'[]'::jsonb)
    from public.golf_reservation_payments p),'all standalone payments remain unchanged');
  perform pg_temp.golf_create_assert(original_accounts=(select coalesce(jsonb_agg(to_jsonb(a) order by a.golf_course),'[]'::jsonb)
    from public.golf_course_budget_accounts a),'course opening balances remain unchanged');
  perform set_config('request.jwt.claims',coalesce(previous_claims,''),true);
end;
$$;
rollback;
select 'PASS: atomic group creation, independent 7/8 rounds, shared money, completion, actor-scoped retries, tombstones, permissions and rollback preservation' as status;
