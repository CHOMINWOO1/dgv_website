-- Rollback-only integration test. Run the WHOLE file as postgres against a
-- disposable/local database after the booking-group migration. The final
-- ROLLBACK removes every synthetic fixture. No real reservation or auth user
-- is changed; one existing auth user is read for valid audit foreign keys.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create function pg_temp.golf_assert(p_ok boolean, p_message text)
returns void language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'FAIL: %', p_message; end if;
end;
$$;

create function pg_temp.golf_group_save(
  p_group uuid, p_round uuid, p_payments jsonb,
  p_changes jsonb default '{}'::jsonb, p_version bigint default null
)
returns void language plpgsql as $$
declare payload jsonb; revision bigint;
begin
  select to_jsonb(r) || jsonb_build_object('expected_updated_at', r.updated_at)
  into payload from public.golf_reservations r where r.id = p_round;
  select g.version into revision from public.golf_booking_groups g where g.id = p_group;
  perform * from public.save_golf_booking_group(
    p_group_id => p_group, p_round_id => p_round,
    p_reservation => payload || p_changes, p_payments => p_payments,
    p_expected_version => coalesce(p_version, revision));
end;
$$;

create function pg_temp.golf_group_payments(p_group uuid)
returns jsonb language sql as $$
  select coalesce(jsonb_agg(to_jsonb(p) order by p.payment_date, p.sort_order, p.id), '[]'::jsonb)
  from public.golf_booking_group_payments p where p.booking_group_id = p_group;
$$;

do $$
declare
  actor uuid;
  group_id uuid := gen_random_uuid(); other_group_id uuid := gen_random_uuid();
  first_round uuid := gen_random_uuid(); second_round uuid := gen_random_uuid();
  partner_round uuid := gen_random_uuid(); other_round uuid := gen_random_uuid();
  fixture_ids uuid[];
  payments jsonb; saved_payments jsonb; account_before jsonb; legacy_payments_before jsonb; authorized_payload jsonb;
  revision bigint; rejected boolean; count_rows bigint; total bigint;
  original_claims text := current_setting('request.jwt.claims', true);
begin
  perform pg_temp.golf_assert(current_user = 'postgres', 'run this rollback-only file as postgres');
  select id into actor from auth.users order by id limit 1;
  perform pg_temp.golf_assert(actor is not null, 'an existing auth user is required for valid audit foreign keys');
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', actor, 'role', 'authenticated', 'app_metadata', jsonb_build_object('role', 'manager'))::text, true);
  perform pg_temp.golf_assert(public.current_app_role() = 'manager', 'manager fixture claims');
  fixture_ids := array[first_round, second_round, partner_round, other_round];
  select coalesce(jsonb_agg(to_jsonb(a) order by a.golf_course), '[]'::jsonb)
  into account_before from public.golf_course_budget_accounts a;
  perform pg_temp.golf_assert(
    (select count(*) = 3 from public.golf_course_budget_accounts where golf_course in ('SAM', 'AT1200', 'PALACE')),
    'three managed course accounts must exist');
  select coalesce(jsonb_agg(to_jsonb(p) order by p.id), '[]'::jsonb)
  into legacy_payments_before from public.golf_reservation_payments p;

  insert into public.golf_booking_groups(id, label)
  values (group_id, '[ROLLBACK TEST] three rounds'), (other_group_id, '[ROLLBACK TEST] foreign group');
  insert into public.golf_reservations (
    id, booking_group_id, counterparty_name, representative_name, player_names_en,
    pax, booking_date, golf_date, golf_time, golf_course, holes,
    guest_unit_price_vnd, course_unit_price_vnd, smart_cart_note,
    deposit_amount_vnd, deposit_received_date, customer_type, cost_settlement_type, cost_partner_name
  ) values
    (first_round, group_id, 'TEST AGENCY', 'TEST A', E'TEST A\nTEST B', 2,
      '2099-01-01', '2099-01-03', '08:00', 'SAM', 18, 4000000, 3000000, '400,000 VND',
      0, '2099-01-01', 'company', 'golf_course', null),
    (second_round, group_id, 'TEST AGENCY', 'TEST A', E'TEST A\nTEST B', 2,
      '2099-01-01', '2099-01-04', '09:00', 'AT1200', 18, 5000000, 3500000, null,
      0, '2099-01-01', 'company', 'golf_course', null),
    (partner_round, group_id, 'TEST AGENCY', 'TEST A', E'TEST A\nTEST B', 2,
      '2099-01-01', '2099-01-05', '10:00', 'PALACE', 18, 3000000, 2000000, null,
      0, '2099-01-01', 'company', 'partner', 'Chị Oanh'),
    (other_round, other_group_id, 'TEST AGENCY', 'TEST C', 'TEST C', 1,
      '2099-01-01', '2099-01-06', '11:00', 'SAM', 18, 4000000, 3000000, null,
      0, '2099-01-01', 'company', 'golf_course', null);

  payments := jsonb_build_array(jsonb_build_object(
    'payment_kind', 'deposit', 'amount_vnd', 2000000, 'payment_date', '2099-01-01',
    'payment_method', 'bank', 'completes_booking', false, 'sort_order', 0));
  select version into revision from public.golf_booking_groups where id = group_id;
  perform pg_temp.golf_group_save(group_id, first_round, payments);
  perform pg_temp.golf_assert(
    (select version = revision + 1 from public.golf_booking_groups where id = group_id),
    'every successful save increments the shared version');
  perform pg_temp.golf_assert(
    not exists (select 1 from public.golf_reservations where booking_group_id = group_id and status <> 'in_progress')
      and not exists (select 1 from public.golf_course_budget_reservation_charges where reservation_id = any(fixture_ids))
      and not exists (select 1 from public.golf_partner_reservation_offsets where reservation_id = any(fixture_ids)),
    'deposit-only booking remains pending without cost effects');
  payments := pg_temp.golf_group_payments(group_id); saved_payments := payments;
  rejected := false;
  begin perform pg_temp.golf_group_save(group_id, first_round, payments, '{}'::jsonb, revision);
  exception when serialization_failure then rejected := true; end;
  perform pg_temp.golf_assert(rejected, 'stale shared version rejects the entire save');
  perform pg_temp.golf_assert(pg_temp.golf_group_payments(group_id) = saved_payments, 'stale save preserves payments');

  -- Exercise the real authenticated SQL role, not only manager JWT claims under
  -- postgres. This checks public RPC EXECUTE, private implementation/schema
  -- access, and manager SELECT policies on both new tables end-to-end.
  select to_jsonb(r) || jsonb_build_object('expected_updated_at', r.updated_at)
    into authorized_payload from public.golf_reservations r where r.id = first_round;
  select version into revision from public.golf_booking_groups where id = group_id;
  execute 'set local role authenticated';
  select count(*) into count_rows from public.golf_booking_groups where id = group_id;
  select sum(amount_vnd) into total from public.golf_booking_group_payments where booking_group_id = group_id;
  perform * from public.save_golf_booking_group(group_id, first_round, authorized_payload, payments, revision);
  execute 'set local role postgres';
  perform pg_temp.golf_assert(count_rows = 1 and total = 2000000,
    'authenticated manager can read the parent and shared payment rows');
  perform pg_temp.golf_assert(
    (select version = revision + 1 from public.golf_booking_groups where id = group_id),
    'authenticated manager can successfully call the public save RPC');

  -- A real payment belonging to another parent is as invalid as an unknown ID.
  perform pg_temp.golf_group_save(other_group_id, other_round,
    '[{"payment_kind":"deposit","amount_vnd":1000,"payment_date":"2099-01-01","payment_method":"bank","completes_booking":false}]');
  rejected := false;
  begin perform pg_temp.golf_group_save(group_id, first_round, pg_temp.golf_group_payments(other_group_id));
  exception when insufficient_privilege or check_violation then rejected := true; end;
  perform pg_temp.golf_assert(rejected, 'payment IDs owned by another group cannot be adopted');

  -- Discounted settlement is deliberate: 20m received against 24.4m quoted.
  payments := payments || jsonb_build_array(jsonb_build_object(
    'payment_kind', 'receipt', 'amount_vnd', 18000000, 'payment_date', '2099-01-02',
    'payment_method', 'bank', 'completes_booking', true, 'sort_order', 0));
  perform pg_temp.golf_group_save(group_id, first_round, payments);
  payments := pg_temp.golf_group_payments(group_id);
  perform pg_temp.golf_assert(
    (select count(*) = 3 from public.golf_reservations where booking_group_id = group_id and status = 'completed'),
    'shared settlement completes all and only group members');
  select count(*), sum(amount_vnd) into count_rows, total
  from public.golf_course_budget_reservation_charges where reservation_id = any(fixture_ids) and active;
  perform pg_temp.golf_assert(count_rows = 2 and total = 13400000, 'direct rounds each deduct their own cost exactly once');
  select count(*), sum(amount_vnd) into count_rows, total
  from public.golf_partner_reservation_offsets where reservation_id = any(fixture_ids) and active;
  perform pg_temp.golf_assert(count_rows = 1 and total = 4000000, 'partner round creates one offset and no course debit');
  perform pg_temp.golf_assert(
    not exists (select 1 from public.golf_reservations where booking_group_id = group_id
      and (deposit_amount_vnd <> 0 or final_received_amount_vnd is not null or final_received_date is not null))
      and not exists (select 1 from public.golf_reservation_payments where reservation_id = any(fixture_ids)),
    'shared money is never copied to round-level amounts or payments');
  saved_payments := payments;
  perform pg_temp.golf_group_save(group_id, second_round, payments);
  perform pg_temp.golf_assert(
    (select array_agg(p.id order by p.id) from public.golf_booking_group_payments p where p.booking_group_id = group_id)
      = (select array_agg((p->>'id')::uuid order by (p->>'id')::uuid) from jsonb_array_elements(saved_payments) p),
    'editing another round preserves shared payment IDs');
  perform pg_temp.golf_assert(
    (select count(*) = 2 and sum(amount_vnd) = 13400000 from public.golf_course_budget_reservation_charges
      where reservation_id = any(fixture_ids) and active), 'repeated completion is idempotent');

  perform pg_temp.golf_group_save(group_id, first_round, payments,
    '{"course_unit_price_vnd":3200000,"smart_cart_note":"500,000 VND"}');
  perform pg_temp.golf_assert(
    (select amount_vnd = 6900000 from public.golf_course_budget_reservation_charges where reservation_id = first_round and active),
    'completed cost edit includes base price plus S-CART exactly once');
  perform pg_temp.golf_group_save(group_id, first_round, payments,
    '{"cost_settlement_type":"partner","cost_partner_name":"Chị Oanh"}');
  perform pg_temp.golf_assert(
    not exists (select 1 from public.golf_course_budget_reservation_charges where reservation_id = first_round and active)
      and (select amount_vnd = 6900000 from public.golf_partner_reservation_offsets where reservation_id = first_round and active),
    'partner reroute reverses the course charge and applies one offset');
  perform pg_temp.golf_group_save(group_id, first_round, payments,
    '{"cost_settlement_type":"golf_course","cost_partner_name":null,"golf_course":"PALACE"}');
  perform pg_temp.golf_assert(
    (select amount_vnd = 6900000 and golf_course = 'PALACE' from public.golf_course_budget_reservation_charges
      where reservation_id = first_round and active)
      and not exists (select 1 from public.golf_partner_reservation_offsets where reservation_id = first_round and active),
    'rerouting back moves the cost to its new course without duplicate deductions');

  select jsonb_agg(case when p->>'payment_kind' = 'receipt'
    then p || '{"amount_vnd":30000000}'::jsonb else p end) into payments
  from jsonb_array_elements(pg_temp.golf_group_payments(group_id)) p;
  perform pg_temp.golf_group_save(group_id, second_round, payments);
  perform pg_temp.golf_assert(
    (select sum(amount_vnd) = 32000000 from public.golf_booking_group_payments where booking_group_id = group_id),
    'overpayment is preserved without allocating money to rounds');
  payments := pg_temp.golf_group_payments(group_id); saved_payments := payments;
  rejected := false;
  begin perform pg_temp.golf_group_save(group_id, other_round, payments);
  exception when insufficient_privilege or check_violation or no_data_found then rejected := true; end;
  perform pg_temp.golf_assert(rejected, 'foreign round cannot be edited through this group');
  rejected := false;
  begin perform pg_temp.golf_group_save(group_id, first_round, jsonb_set(payments, '{0,id}', to_jsonb(gen_random_uuid())));
  exception when insufficient_privilege or check_violation then rejected := true; end;
  perform pg_temp.golf_assert(rejected, 'unknown payment IDs cannot be adopted');
  rejected := false;
  begin perform pg_temp.golf_group_save(group_id, first_round,
    jsonb_build_array(jsonb_build_object('payment_kind', 'deposit', 'amount_vnd', 5000000,
      'payment_date', '2099-01-01', 'payment_method', 'cash', 'completes_booking', false)));
  exception when check_violation then rejected := true; end;
  perform pg_temp.golf_assert(rejected, 'cash at the 5m threshold is rejected');
  rejected := false;
  begin perform pg_temp.golf_group_save(group_id, first_round, jsonb_set(payments, '{0,completes_booking}', 'true'::jsonb));
  exception when unique_violation or check_violation then rejected := true; end;
  perform pg_temp.golf_assert(rejected, 'only one shared payment may mark completion');
  rejected := false;
  begin perform pg_temp.golf_group_save(group_id, first_round,
    jsonb_set(payments, '{1,payment_date}', '"2098-12-31"'::jsonb));
  exception when check_violation then rejected := true; end;
  perform pg_temp.golf_assert(rejected, 'completion cannot precede the earliest deposit');
  rejected := false;
  begin perform pg_temp.golf_group_save(group_id, first_round, payments || jsonb_build_array(payments->0));
  exception when unique_violation then rejected := true; end;
  perform pg_temp.golf_assert(rejected, 'duplicate payment IDs are rejected');
  rejected := false;
  begin perform pg_temp.golf_group_save(group_id, first_round, jsonb_set(payments, '{0,payment_method}', 'null'::jsonb));
  exception when check_violation then rejected := true; end;
  perform pg_temp.golf_assert(rejected, 'positive shared payments require a method');
  rejected := false;
  begin perform pg_temp.golf_group_save(group_id, first_round,
    '[{"payment_kind":"deposit","amount_vnd":9007199254740991,"payment_date":"2099-01-01","payment_method":"bank"},{"payment_kind":"receipt","amount_vnd":1,"payment_date":"2099-01-02","payment_method":"bank"}]');
  exception when check_violation then rejected := true; end;
  perform pg_temp.golf_assert(rejected, 'the sum of individually valid payments remains a safe integer');
  rejected := false;
  begin perform pg_temp.golf_group_save(group_id, first_round, payments, '{"expected_updated_at":"2000-01-01T00:00:00Z"}');
  exception when serialization_failure then rejected := true; end;
  perform pg_temp.golf_assert(rejected, 'stale child timestamp is rejected');
  rejected := false;
  begin perform pg_temp.golf_group_save(group_id, first_round, payments, '{"course_unit_price_vnd":null}');
  exception when check_violation then rejected := true; end;
  perform pg_temp.golf_assert(rejected, 'completed cost cannot become unknown');
  perform pg_temp.golf_assert(pg_temp.golf_group_payments(group_id) = saved_payments, 'failed saves preserve every payment');
  rejected := false;
  begin perform * from public.save_golf_reservation_with_payments(first_round,
    (select to_jsonb(r) || jsonb_build_object('expected_updated_at', r.updated_at)
      from public.golf_reservations r where r.id = first_round), '[]'::jsonb);
  exception when insufficient_privilege or check_violation then rejected := true; end;
  perform pg_temp.golf_assert(rejected, 'legacy save RPC cannot modify a grouped round');

  select jsonb_agg(p || '{"completes_booking":false}'::jsonb) into payments from jsonb_array_elements(payments) p;
  perform pg_temp.golf_group_save(group_id, second_round, payments, '{"course_unit_price_vnd":null}');
  perform pg_temp.golf_assert(
    (select count(*) = 3 from public.golf_reservations where booking_group_id = group_id and status = 'in_progress')
      and not exists (select 1 from public.golf_course_budget_reservation_charges where reservation_id = any(fixture_ids) and active)
      and not exists (select 1 from public.golf_partner_reservation_offsets where reservation_id = any(fixture_ids) and active)
      and (select sum(amount_vnd) = 32000000 from public.golf_booking_group_payments where booking_group_id = group_id),
    'reopening reverses costs but retains received money');
  perform pg_temp.golf_assert(
    (select course_total_vnd is null from public.golf_reservations where id = second_round),
    'reopening and clearing a cost work in a single atomic save');
  rejected := false;
  begin perform pg_temp.golf_group_save(group_id, first_round,
    jsonb_set(payments, '{1,completes_booking}', 'true'::jsonb));
  exception when check_violation then rejected := true; end;
  perform pg_temp.golf_assert(rejected, 'completion checks missing costs on every sibling, not just the selected round');
  perform pg_temp.golf_group_save(group_id, second_round, payments, '{"course_unit_price_vnd":3500000}');

  -- Members may have different headcounts/rosters (the real target has 7/8).
  perform pg_temp.golf_group_save(group_id, first_round, payments,
    '{"representative_name":"A","pax":7,"player_names_en":"A\nB\nC\nD\nE\nF\nG"}');
  perform pg_temp.golf_group_save(group_id, second_round, payments,
    '{"representative_name":"A","pax":8,"player_names_en":"A\nB\nC\nD\nE\nF\nG\nH"}');
  perform pg_temp.golf_assert(
    (select pax = 7 and player_names_en = E'A\nB\nC\nD\nE\nF\nG' from public.golf_reservations where id = first_round)
      and (select pax = 8 and player_names_en = E'A\nB\nC\nD\nE\nF\nG\nH' from public.golf_reservations where id = second_round)
      and (select pax = 2 from public.golf_reservations where id = partner_round),
    'each round preserves independently editable PAX and full roster');

  perform pg_temp.golf_assert(
    not has_table_privilege('authenticated', 'public.golf_booking_group_payments', 'INSERT')
      and not has_table_privilege('authenticated', 'public.golf_booking_group_payments', 'UPDATE')
      and not has_table_privilege('authenticated', 'public.golf_booking_group_payments', 'DELETE'),
    'authenticated clients cannot write shared payments directly');
  rejected := false;
  begin
    execute 'set local role authenticated';
    update public.golf_reservations set note = 'unauthorized direct edit' where id = first_round;
  exception when insufficient_privilege then rejected := true; end;
  execute 'set local role postgres';
  perform pg_temp.golf_assert(rejected, 'direct grouped-round updates cannot bypass shared version locking');
  rejected := false;
  begin
    execute 'set local role authenticated';
    delete from public.golf_reservations where id = first_round;
  exception when insufficient_privilege then rejected := true; end;
  execute 'set local role postgres';
  perform pg_temp.golf_assert(rejected, 'direct grouped-round deletion cannot bypass the guarded RPC');
  rejected := false;
  begin
    execute 'set local role authenticated';
    insert into public.golf_reservation_payments(reservation_id, payment_kind, amount_vnd, payment_date, payment_method)
    values (first_round, 'deposit', 1000, '2099-01-01', 'bank');
  exception when insufficient_privilege or check_violation then rejected := true; end;
  execute 'set local role postgres';
  perform pg_temp.golf_assert(rejected, 'group members cannot acquire a second legacy payment ledger');
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', actor, 'role', 'authenticated', 'app_metadata', jsonb_build_object('role', 'staff'))::text, true);
  rejected := false;
  begin perform pg_temp.golf_group_save(group_id, first_round, payments);
  exception when insufficient_privilege then rejected := true; end;
  perform pg_temp.golf_assert(rejected, 'staff cannot save shared payments');
  perform pg_temp.golf_assert(
    not has_function_privilege('anon', 'public.save_golf_booking_group(uuid,uuid,jsonb,jsonb,bigint)', 'EXECUTE')
      and not has_function_privilege('anon', 'public.delete_golf_booking_round(uuid,bigint)', 'EXECUTE'),
    'anonymous callers have no grouped save or delete execution grant');
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', actor, 'role', 'authenticated', 'app_metadata', jsonb_build_object('role', 'admin'))::text, true);
  perform pg_temp.golf_group_save(group_id, first_round, pg_temp.golf_group_payments(group_id));

  saved_payments := pg_temp.golf_group_payments(group_id);
  select version into revision from public.golf_booking_groups where id = group_id;
  perform public.delete_golf_booking_round(second_round, revision);
  perform pg_temp.golf_assert(pg_temp.golf_group_payments(group_id) = saved_payments, 'child deletion preserves parent payments');
  perform pg_temp.golf_assert(
    (select version = revision + 1 from public.golf_booking_groups where id = group_id),
    'child deletion increments the shared version');
  rejected := false;
  begin perform public.delete_golf_booking_round(partner_round, revision);
  exception when serialization_failure then rejected := true; end;
  perform pg_temp.golf_assert(rejected, 'stale deletion cannot remove another child');
  select version into revision from public.golf_booking_groups where id = group_id;
  perform public.delete_golf_booking_round(partner_round, revision);
  select version into revision from public.golf_booking_groups where id = group_id;
  rejected := false;
  begin perform public.delete_golf_booking_round(first_round, revision);
  exception when check_violation or foreign_key_violation then rejected := true; end;
  perform pg_temp.golf_assert(rejected, 'last round cannot delete a group containing payments');
  perform pg_temp.golf_assert(account_before = (
    select coalesce(jsonb_agg(to_jsonb(a) order by a.golf_course), '[]'::jsonb)
    from public.golf_course_budget_accounts a), 'opening balances are never rewritten');
  perform pg_temp.golf_assert(legacy_payments_before = (
    select coalesce(jsonb_agg(to_jsonb(p) order by p.id), '[]'::jsonb)
    from public.golf_reservation_payments p), 'standalone payments remain byte-for-byte unchanged');
  perform set_config('request.jwt.claims', coalesce(original_claims, ''), true);
end;
$$;
rollback;
select 'PASS: shared payments, completion, round ledgers, independent PAX, conflicts, permissions and deletion; all changes rolled back' as status;
