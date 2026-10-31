-- ISOLATED POSTGRES/PGlite ONLY. Synthetic timestamps are shifted below with
-- USER triggers suspended, and everything is rolled back. Never run on live.
begin;
do $$begin
  if current_setting('app.payroll_test_vault_stub',true) is distinct from 'true' then
    raise exception 'ISOLATED_PAYROLL_TEST_REQUIRED';
  end if;
end;$$;
create function pg_temp.rollover_assert(p_ok boolean,p_message text) returns void language plpgsql as $$
begin if p_ok is distinct from true then raise exception 'FAIL: %',p_message;end if;end;$$;
create function pg_temp.rollover_punch(p_token text,p_employee uuid,p_kind text) returns jsonb language plpgsql as $$
declare c jsonb;r jsonb;begin
  c:=public.payroll_kiosk_touch_challenge(p_token,p_employee,p_kind,gen_random_uuid());
  r:=public.payroll_kiosk_touch_confirm(p_token,(c->>'challenge_id')::uuid,c->>'code');
  perform pg_temp.rollover_assert(r->'ok'='true'::jsonb,'synthetic punch succeeds');
  return r->'event';
end;$$;
create function pg_temp.rollover_set_time(p_id uuid,p_at timestamp) returns void language plpgsql as $$
begin
  if current_user<>'postgres' or current_setting('app.payroll_test_vault_stub',true) is distinct from 'true' then
    raise exception 'ISOLATED_PAYROLL_TEST_REQUIRED';
  end if;
  set constraints public.payroll_attendance_raw_import_id_fkey immediate;
  alter table public.payroll_attendance_raw disable trigger user;
  update public.payroll_attendance_raw set occurred_at=p_at where id=p_id;
  if not found then raise exception 'MISSING_SYNTHETIC_RECORD';end if;
  alter table public.payroll_attendance_raw enable trigger user;
end;$$;
do $$
declare
  actor uuid:='00000000-0000-4000-8000-000000000071';
  emp_oldin uuid:=gen_random_uuid();emp_oldout uuid:=gen_random_uuid();emp_future uuid:=gen_random_uuid();
  emp_stale uuid:=gen_random_uuid();emp_night uuid:=gen_random_uuid();emp_confirm uuid:=gen_random_uuid();
  dev uuid:=gen_random_uuid();dev2 uuid:=gen_random_uuid();
  token text:=repeat('7',64);token2 text:=repeat('8',64);
  local_now timestamp;old_time timestamp;old_event jsonb;event jsonb;other_event jsonb;
  challenge jsonb;second jsonb;answer jsonb;receipt jsonb;roster jsonb;request uuid;
  before_count bigint;before_revision bigint;rejected boolean;signature text;
begin
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'app_metadata',jsonb_build_object('role','admin'))::text,true);
  execute 'set local role authenticated';
  insert into public.payroll_employees(id,device_user_id,name) values
    (emp_oldin,'ROLLOVER-'||emp_oldin,'Synthetic older unclosed in'),
    (emp_oldout,'ROLLOVER-'||emp_oldout,'Synthetic previous departure'),
    (emp_future,'ROLLOVER-'||emp_future,'Synthetic future event'),
    (emp_stale,'ROLLOVER-'||emp_stale,'Synthetic simultaneous tablets'),
    (emp_night,'ROLLOVER-'||emp_night,'Synthetic overnight departure'),
    (emp_confirm,'ROLLOVER-'||emp_confirm,'Synthetic confirmation recheck');
  perform public.payroll_kiosk_register(dev,'Synthetic rollover tablet',token);
  perform public.payroll_kiosk_register(dev2,'Synthetic other rollover tablet',token2);
  perform set_config('request.jwt.claims','{}',true);
  -- Session and device clock settings must not define the business day.
  perform set_config('TimeZone','Pacific/Honolulu',true);
  execute 'set local role anon';
  local_now:=clock_timestamp() at time zone 'Asia/Ho_Chi_Minh';
  old_time:=date_trunc('day',local_now)-interval '14 hours';
  roster:=public.payroll_kiosk_roster(token);
  perform pg_temp.rollover_assert((roster->>'server_date')::date=local_now::date
    and ((roster->>'server_time')::timestamptz at time zone 'Asia/Ho_Chi_Minh')::date=local_now::date,
    'roster carries the authoritative Vietnam calendar day and timestamp');

  old_event:=pg_temp.rollover_punch(token,emp_oldin,'in');
  execute 'set local role postgres';
  perform pg_temp.rollover_set_time((old_event->>'event_id')::uuid,old_time);
  select count(*) into before_count from public.payroll_attendance_raw where employee_id=emp_oldin;
  select version into before_revision from public.payroll_revision where id=1;
  execute 'set local role anon';
  roster:=public.payroll_kiosk_roster(token);
  perform pg_temp.rollover_assert(exists(select 1 from jsonb_array_elements(roster->'employees') e
    where e->>'id'=emp_oldin::text and (e->'last_punch'->>'occurred_at')::timestamp=old_time),
    'all-time last punch remains visible rather than being silently cleared');
  request:=gen_random_uuid();challenge:=public.payroll_kiosk_touch_challenge(token,emp_oldin,'in',request);
  second:=public.payroll_kiosk_touch_challenge(token,emp_oldin,'in',request);
  perform pg_temp.rollover_assert(second-'server_time'=challenge-'server_time','new-day issuance retry retains exact code and expiry');
  answer:=public.payroll_kiosk_touch_confirm(token,(challenge->>'challenge_id')::uuid,challenge->>'code');
  event:=answer->'event';
  perform pg_temp.rollover_assert(answer->'ok'='true'::jsonb and (event->>'occurred_at')::timestamp::date=local_now::date
    and event->>'punch_type'='in','an old unclosed IN allows a fresh IN at server confirmation time');
  receipt:=public.payroll_kiosk_touch_receipt(token,request);
  perform pg_temp.rollover_assert(receipt->>'status'='saved' and (receipt->'event')-'replayed'=event-'replayed',
    'new-day receipt returns exactly the saved arrival');
  perform pg_temp.rollover_assert((public.payroll_kiosk_touch_confirm(token,(challenge->>'challenge_id')::uuid,challenge->>'code')->'event')-'replayed'=event-'replayed',
    'a repeated confirmation never creates a second new-day arrival');
  rejected:=false;
  begin perform public.payroll_kiosk_touch_challenge(token,emp_oldin,'in',gen_random_uuid());exception when others then rejected:=sqlerrm='PAYROLL_KIOSK_SAME_DIRECTION';end;
  perform pg_temp.rollover_assert(rejected,'a second arrival on the current Vietnam day remains rejected');
  rejected:=false;
  begin perform public.payroll_kiosk_touch_challenge(token,emp_oldin,'out',gen_random_uuid());exception when others then rejected:=sqlerrm='PAYROLL_KIOSK_COOLDOWN';end;
  perform pg_temp.rollover_assert(rejected,'new-day recovery preserves the thirty-second cooldown');
  execute 'set local role postgres';
  perform pg_temp.rollover_assert((select count(*)=before_count+1 from public.payroll_attendance_raw where employee_id=emp_oldin)
    and (select version=before_revision+1 from public.payroll_revision where id=1)
    and (select occurred_at=old_time and punch_type='in' from public.payroll_attendance_raw where id=(old_event->>'event_id')::uuid),
    'only one new IN is inserted; old orphan remains untouched and no OUT is invented');
  perform pg_temp.rollover_set_time((event->>'event_id')::uuid,(clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')-interval '60 seconds');
  execute 'set local role anon';
  other_event:=pg_temp.rollover_punch(token,emp_oldin,'out');
  perform pg_temp.rollover_assert(other_event->>'punch_type'='out','today can finish its own new arrival normally');

  old_event:=pg_temp.rollover_punch(token,emp_oldout,'in');
  execute 'set local role postgres';
  perform pg_temp.rollover_set_time((old_event->>'event_id')::uuid,old_time-interval '1 day');
  execute 'set local role anon';
  old_event:=pg_temp.rollover_punch(token,emp_oldout,'out');
  execute 'set local role postgres';
  perform pg_temp.rollover_set_time((old_event->>'event_id')::uuid,old_time);
  execute 'set local role anon';
  rejected:=false;
  begin perform public.payroll_kiosk_touch_challenge(token,emp_oldout,'out',gen_random_uuid());exception when others then rejected:=sqlerrm='PAYROLL_KIOSK_SAME_DIRECTION';end;
  perform pg_temp.rollover_assert(rejected,'an older OUT never permits another unmatched OUT');
  event:=pg_temp.rollover_punch(token,emp_oldout,'in');
  perform pg_temp.rollover_assert(event->>'punch_type'='in','previous-day OUT still permits the usual new arrival');

  old_event:=pg_temp.rollover_punch(token,emp_future,'in');
  execute 'set local role postgres';
  perform pg_temp.rollover_set_time((old_event->>'event_id')::uuid,local_now+interval '1 day');
  execute 'set local role anon';
  rejected:=false;
  begin perform public.payroll_kiosk_touch_challenge(token,emp_future,'in',gen_random_uuid());exception when others then rejected:=sqlerrm='PAYROLL_KIOSK_SAME_DIRECTION';end;
  perform pg_temp.rollover_assert(rejected,'a future-day IN must not be mistaken for an older arrival');
  rejected:=false;
  begin perform public.payroll_kiosk_touch_challenge(token,emp_future,'out',gen_random_uuid());exception when others then rejected:=sqlerrm='PAYROLL_KIOSK_COOLDOWN';end;
  perform pg_temp.rollover_assert(rejected,'future records cannot bypass the existing time-order guard');

  old_event:=pg_temp.rollover_punch(token,emp_confirm,'in');
  execute 'set local role postgres';
  perform pg_temp.rollover_set_time((old_event->>'event_id')::uuid,old_time);
  execute 'set local role anon';
  challenge:=public.payroll_kiosk_touch_challenge(token,emp_confirm,'in',gen_random_uuid());
  execute 'set local role postgres';
  -- Keep the same prior ID to prove confirm checks the calendar predicate too,
  -- independently of the existing all-time prior-ID stale-state comparison.
  perform pg_temp.rollover_set_time((old_event->>'event_id')::uuid,local_now);
  execute 'set local role anon';
  answer:=public.payroll_kiosk_touch_confirm(token,(challenge->>'challenge_id')::uuid,challenge->>'code');
  perform pg_temp.rollover_assert(answer->>'error'='same_direction','confirmation independently rejects a current-day duplicate');
  execute 'set local role postgres';
  perform pg_temp.rollover_set_time((old_event->>'event_id')::uuid,local_now+interval '1 day');
  execute 'set local role anon';
  answer:=public.payroll_kiosk_touch_confirm(token,(challenge->>'challenge_id')::uuid,challenge->>'code');
  perform pg_temp.rollover_assert(answer->>'error'='same_direction','confirmation independently rejects a future-day duplicate');

  old_event:=pg_temp.rollover_punch(token,emp_stale,'in');
  execute 'set local role postgres';
  perform pg_temp.rollover_set_time((old_event->>'event_id')::uuid,old_time);
  execute 'set local role anon';
  request:=gen_random_uuid();challenge:=public.payroll_kiosk_touch_challenge(token,emp_stale,'in',request);
  second:=public.payroll_kiosk_touch_challenge(token2,emp_stale,'in',gen_random_uuid());
  answer:=public.payroll_kiosk_touch_confirm(token2,(second->>'challenge_id')::uuid,second->>'code');
  perform pg_temp.rollover_assert(answer->'ok'='true'::jsonb,'one of two devices completes the new-day arrival');
  answer:=public.payroll_kiosk_touch_confirm(token,(challenge->>'challenge_id')::uuid,challenge->>'code');
  perform pg_temp.rollover_assert(answer->>'error'='stale_state'
    and public.payroll_kiosk_touch_challenge(token,emp_stale,'in',request)->>'status'='stale_state',
    'the second device cannot consume an old snapshot or retry it into a duplicate');
  execute 'set local role postgres';
  perform pg_temp.rollover_assert((select count(*)=2 from public.payroll_attendance_raw where employee_id=emp_stale),
    'two devices leave precisely the old orphan and one fresh arrival');
  execute 'set local role anon';

  old_event:=pg_temp.rollover_punch(token,emp_night,'in');
  execute 'set local role postgres';
  perform pg_temp.rollover_set_time((old_event->>'event_id')::uuid,date_trunc('day',local_now)-interval '1 hour');
  execute 'set local role anon';
  event:=pg_temp.rollover_punch(token,emp_night,'out');
  perform pg_temp.rollover_assert(event->>'punch_type'='out','an actual overnight departure remains possible');

  execute 'set local role postgres';
  foreach signature in array array[
    'payroll_kiosk.payroll_kiosk_touch_challenge(text,uuid,text,uuid)',
    'payroll_kiosk.payroll_kiosk_touch_confirm(text,uuid,text)',
    'payroll_kiosk.payroll_kiosk_roster(text)'
  ] loop
    perform pg_temp.rollover_assert((select pg_get_userbyid(proowner)='payroll_kiosk_writer' and prosecdef
      and proconfig @> array['search_path=""'] from pg_proc where oid=signature::regprocedure),
      'function replacement retains the existing restricted owner and empty search path');
  end loop;
  perform pg_temp.rollover_assert(not has_table_privilege('anon','payroll_kiosk.payroll_kiosk_touch_challenges','SELECT')
    and not has_table_privilege('authenticated','payroll_kiosk.payroll_kiosk_touch_challenges','INSERT'),
    'day rollover does not widen private challenge-table access');
end;$$;
rollback;
