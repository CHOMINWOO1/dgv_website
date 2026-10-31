-- Rollback-only production-safe smoke. Only random-ID synthetic employee/device
-- fixtures are written; never clears data, disables triggers or backdates events.
begin;
set local lock_timeout='5s';set local statement_timeout='30s';
create function pg_temp.touch_live_assert(p_ok boolean,p_message text) returns void language plpgsql as $$
begin if p_ok is distinct from true then raise exception 'FAIL: %',p_message;end if;end;$$;
do $$
declare actor uuid:='00000000-0000-4000-8000-000000000063';emp uuid:=gen_random_uuid();other_emp uuid:=gen_random_uuid();
  dev uuid:=gen_random_uuid();dev2 uuid:=gen_random_uuid();token text:=encode(sha256(convert_to(gen_random_uuid()::text,'UTF8')),'hex');
  token2 text:=encode(sha256(convert_to(gen_random_uuid()::text,'UTF8')),'hex');request uuid:=gen_random_uuid();pending_request uuid:=gen_random_uuid();
  challenge jsonb;pending jsonb;answer jsonb;receipt jsonb;wrong_code text;counts_before jsonb:='{}';counts_after jsonb:='{}';revision bigint;t record;n bigint;rejected boolean;
begin
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'app_metadata',jsonb_build_object('role','admin'))::text,true);
  select version into revision from public.payroll_revision where id=1 for update;
  for t in select n.nspname,c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('public','private','payroll_kiosk') and c.relkind='r' and c.relname like 'payroll_%' order by 1,2 loop
    execute format('select count(*) from %I.%I',t.nspname,t.relname) into n;
    counts_before:=counts_before||jsonb_build_object(t.nspname||'.'||t.relname,n);
  end loop;
  begin
    execute 'set local role authenticated';
    insert into public.payroll_employees(id,device_user_id,name) values(emp,'TOUCH-SMOKE-'||emp,'Temporary touch smoke A'),(other_emp,'TOUCH-SMOKE-'||other_emp,'Temporary touch smoke B');
    perform public.payroll_kiosk_register(dev,'Rollback touch tablet',token);perform public.payroll_kiosk_register(dev2,'Rollback alternate tablet',token2);
    perform set_config('request.jwt.claims','{}',true);execute 'set local role anon';
    challenge:=public.payroll_kiosk_touch_challenge(token,emp,'in',request);
    perform pg_temp.touch_live_assert(challenge->>'status'='pending' and challenge->>'code'~'^[0-9]{4}$','active device receives visible four-digit code without a face enrollment');
    perform pg_temp.touch_live_assert(public.payroll_kiosk_touch_challenge(token,emp,'in',request)-'server_time'=challenge-'server_time','issuance retry is stable');
    rejected:=false;begin perform public.payroll_kiosk_touch_confirm(token2,(challenge->>'challenge_id')::uuid,challenge->>'code');exception when others then rejected:=sqlerrm='PAYROLL_KIOSK_TOUCH_CHALLENGE_NOT_FOUND';end;
    perform pg_temp.touch_live_assert(rejected,'another device cannot use the code');
    wrong_code:=case when challenge->>'code'='0000' then '0001' else '0000' end;
    answer:=public.payroll_kiosk_touch_confirm(token,(challenge->>'challenge_id')::uuid,wrong_code);
    perform pg_temp.touch_live_assert(answer->>'error'='code_mismatch' and answer->>'attempts_remaining'='4','incorrect entry persists without creating attendance');
    answer:=public.payroll_kiosk_touch_confirm(token,(challenge->>'challenge_id')::uuid,challenge->>'code');
    perform pg_temp.touch_live_assert(answer->'ok'='true'::jsonb and answer->'event'->>'verification'='visible_code_confirmation'
      and abs(extract(epoch from (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')-(answer->'event'->>'occurred_at')::timestamp))<5,'confirmation records server Vietnam time with honest manual method');
    receipt:=public.payroll_kiosk_touch_receipt(token,request);
    perform pg_temp.touch_live_assert(receipt->>'status'='saved' and (receipt->'event')-'replayed'=(answer->'event')-'replayed','recovery returns exact committed event');
    perform pg_temp.touch_live_assert((public.payroll_kiosk_touch_confirm(token,(challenge->>'challenge_id')::uuid,challenge->>'code')->'event')-'replayed'=(answer->'event')-'replayed','repeated confirmation cannot duplicate work');
    pending:=public.payroll_kiosk_touch_challenge(token,other_emp,'in',pending_request);
    perform pg_temp.touch_live_assert(public.payroll_kiosk_touch_receipt(token,pending_request)->>'status'='not_saved','recovery atomically cancels unsaved confirmation');
    perform pg_temp.touch_live_assert(public.payroll_kiosk_touch_confirm(token,(pending->>'challenge_id')::uuid,pending->>'code')->>'error'='cancelled','late confirmation after recovery cannot save');
    pending_request:=gen_random_uuid();pending:=public.payroll_kiosk_touch_challenge(token,other_emp,'in',pending_request);
    perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'app_metadata',jsonb_build_object('role','admin'))::text,true);execute 'set local role authenticated';
    perform public.payroll_kiosk_revoke(dev,'Rollback touch revoke smoke');
    perform pg_temp.touch_live_assert(public.payroll_kiosk_touch_admin_receipt(dev,pending_request)->>'status'='not_saved','admin recovers a cancelled device pending request');
    perform set_config('request.jwt.claims','{}',true);execute 'set local role anon';
    rejected:=false;begin perform public.payroll_kiosk_touch_challenge(token,other_emp,'in',gen_random_uuid());exception when insufficient_privilege then rejected:=true;end;
    perform pg_temp.touch_live_assert(rejected,'revoked device cannot issue another confirmation');
    execute 'set local role postgres';
    perform pg_temp.touch_live_assert((select count(*)=1 from public.payroll_attendance_raw where employee_id in (emp,other_emp))
      and (select verification_method='visible_code_confirmation' from public.payroll_attendance_raw where kiosk_request_id=request),'only deliberate successful confirmation created one row');
    raise exception using errcode='ZX063',message='ROLLBACK_TOUCH_LIVE_SMOKE';
  exception when sqlstate 'ZX063' then null;end;
  execute 'set local role postgres';
  for t in select n.nspname,c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('public','private','payroll_kiosk') and c.relkind='r' and c.relname like 'payroll_%' order by 1,2 loop
    execute format('select count(*) from %I.%I',t.nspname,t.relname) into n;
    counts_after:=counts_after||jsonb_build_object(t.nspname||'.'||t.relname,n);
  end loop;
  perform pg_temp.touch_live_assert(counts_before=counts_after and (select version=revision from public.payroll_revision where id=1),'all original payroll/device/face/challenge row counts and revision survive rollback');
end;$$;
rollback;
