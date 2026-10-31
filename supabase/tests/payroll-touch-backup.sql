-- ISOLATED ONLY: empty payroll database. Retains a synthetic consumed challenge
-- while restoring its payroll backup, to exercise historical-identifier safety.
begin;
create function pg_temp.touch_backup_assert(p_ok boolean,p_message text) returns void language plpgsql as $$
begin if p_ok is distinct from true then raise exception 'FAIL: %',p_message;end if;end;$$;
do $$
declare actor uuid:='00000000-0000-4000-8000-000000000062';emp uuid:=gen_random_uuid();dev uuid:=gen_random_uuid();
  token text:=repeat('e',64);request uuid:=gen_random_uuid();challenge jsonb;answer jsonb;payload jsonb;history jsonb;result jsonb;rejected boolean;
begin
  perform pg_temp.touch_backup_assert(not exists(select 1 from public.payroll_employees),'touch backup test requires isolated empty payroll database');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'app_metadata',jsonb_build_object('role','admin'))::text,true);
  begin
    execute 'set local role authenticated';
    insert into public.payroll_employees(id,device_user_id,name) values(emp,'TOUCH-BACKUP-'||emp,'Touch backup fixture');
    perform public.payroll_kiosk_register(dev,'Touch backup device',token);
    challenge:=public.payroll_kiosk_touch_challenge(token,emp,'in',request);
    answer:=public.payroll_kiosk_touch_confirm(token,(challenge->>'challenge_id')::uuid,challenge->>'code');
    payload:=public.payroll_backup();
    perform pg_temp.touch_backup_assert(payload->'tables'->'payroll_attendance_raw'->0->>'verification_method'='visible_code_confirmation','backup retains honest touch provenance');
    perform pg_temp.touch_backup_assert(not(payload->'tables' ? 'payroll_kiosk_touch_challenges') and position(token in payload::text)=0,'payroll backup excludes capability and private confirmation history');
    execute 'set local role postgres';
    select to_jsonb(c) into history from payroll_kiosk.payroll_kiosk_touch_challenges c where request_id=request;
    raise exception using errcode='ZX062',message='ROLLBACK_TOUCH_BACKUP_SOURCE';
  exception when sqlstate 'ZX062' then null;end;
  execute 'set local role postgres';
  -- A retained expired/consumed record must not require its old employee,
  -- device or raw event to exist while payroll is being restored.
  insert into payroll_kiosk.payroll_kiosk_touch_challenges select * from jsonb_populate_record(null::payroll_kiosk.payroll_kiosk_touch_challenges,history);
  execute 'set local role authenticated';
  result:=public.payroll_restore(payload);
  perform pg_temp.touch_backup_assert((result->>'restored')::boolean,'restore succeeds despite existing historical touch challenge');
  perform pg_temp.touch_backup_assert((select verification_method='visible_code_confirmation' and punch_type='in'
    and occurred_at=(answer->'event'->>'occurred_at')::timestamp from public.payroll_attendance_raw where kiosk_request_id=request),'restored raw row retains method/type/original server timestamp');
  rejected:=false;begin perform public.payroll_kiosk_touch_confirm(token,(challenge->>'challenge_id')::uuid,challenge->>'code');exception when insufficient_privilege then rejected:=true;end;
  perform pg_temp.touch_backup_assert(rejected,'payroll restore does not reactivate old device credential');
  perform pg_temp.touch_backup_assert(public.payroll_kiosk_touch_admin_receipt(dev,request)->>'status'='saved','administrator can resolve historical restored event without reauthorizing device');
  execute 'set local role postgres';
  perform pg_temp.touch_backup_assert((select to_jsonb(c)=history from payroll_kiosk.payroll_kiosk_touch_challenges c where request_id=request),'restore does not rewrite consumed challenge or permit reuse');
end;$$;
rollback;
