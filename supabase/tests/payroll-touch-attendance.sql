-- ISOLATED ONLY. Cooldown fixtures backdate only synthetic attendance, with
-- USER triggers briefly disabled in this rolled-back test. Never run on live.
begin;
create function pg_temp.touch_assert(p_ok boolean,p_message text) returns void language plpgsql as $$
begin if p_ok is distinct from true then raise exception 'FAIL: %',p_message;end if;end;$$;
do $$
declare actor uuid:='00000000-0000-4000-8000-000000000061';emp uuid:=gen_random_uuid();other_emp uuid:=gen_random_uuid();
  dev uuid:=gen_random_uuid();dev2 uuid:=gen_random_uuid();token text:=repeat('c',64);token2 text:=repeat('d',64);
  request uuid;first_request uuid;challenge jsonb;second jsonb;answer jsonb;first_event jsonb;receipt jsonb;directions text[]:=array['in','out','in','out'];
  rejected boolean;revision bigint;audit_before bigint;i integer;wrong_code text;old_id uuid;old_code text;role_name text;
begin
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'app_metadata',jsonb_build_object('role','admin'))::text,true);
  execute 'set local role authenticated';
  insert into public.payroll_employees(id,device_user_id,name) values(emp,'TOUCH-'||emp,'Touch fixture A'),(other_emp,'TOUCH-'||other_emp,'Touch fixture B');
  perform public.payroll_kiosk_register(dev,'Touch fixture device',token);perform public.payroll_kiosk_register(dev2,'Other touch device',token2);
  perform public.payroll_kiosk_enroll(dev2,emp,'legacy-face-mixed-test');
  execute 'set local role postgres';
  perform pg_temp.touch_assert(not has_table_privilege('anon','payroll_kiosk.payroll_kiosk_touch_challenges','SELECT')
    and not has_table_privilege('authenticated','payroll_kiosk.payroll_kiosk_touch_challenges','INSERT')
    and not has_table_privilege('payroll_kiosk_writer','payroll_kiosk.payroll_kiosk_touch_challenges','DELETE'),'no direct API challenge access or writer deletion');
  perform pg_temp.touch_assert(not has_function_privilege('anon','payroll_kiosk.payroll_kiosk_touch_resolve(uuid,uuid)','EXECUTE')
    and not has_function_privilege('authenticated','payroll_kiosk.payroll_kiosk_touch_resolve(uuid,uuid)','EXECUTE'),'internal resolver cannot bypass token/admin check');
  foreach role_name in array array['manager','staff'] loop
    perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'app_metadata',jsonb_build_object('role',role_name),'user_metadata',jsonb_build_object('role','admin'))::text,true);
    execute 'set local role authenticated';
    rejected:=false;begin perform public.payroll_kiosk_touch_admin_receipt(dev,gen_random_uuid());exception when insufficient_privilege then rejected:=true;end;
    perform pg_temp.touch_assert(rejected,'manager/staff/spoofed claim cannot resolve another device as administrator');
  end loop;
  perform set_config('request.jwt.claims','{}',true);execute 'set local role anon';
  rejected:=false;begin perform public.payroll_kiosk_touch_challenge(repeat('0',64),emp,'in',gen_random_uuid());exception when insufficient_privilege then rejected:=true;end;
  perform pg_temp.touch_assert(rejected,'unknown device cannot request codes');
  rejected:=false;begin perform public.payroll_kiosk_touch_challenge(token,emp,'out',gen_random_uuid());exception when others then rejected:=sqlerrm='PAYROLL_KIOSK_CHECK_IN_REQUIRED';end;
  perform pg_temp.touch_assert(rejected,'first out remains invalid');
  request:=gen_random_uuid();challenge:=public.payroll_kiosk_touch_challenge(token,emp,'in',request);
  perform pg_temp.touch_assert(challenge->>'status'='pending' and challenge->>'code'~'^[0-9]{4}$'
    and (challenge->>'expires_at')::timestamptz-(challenge->>'server_time')::timestamptz between interval '115 seconds' and interval '120 seconds','server returns four visible digits and bounded two-minute expiry');
  second:=public.payroll_kiosk_touch_challenge(token,emp,'in',request);
  perform pg_temp.touch_assert(second-'server_time'=challenge-'server_time','lost issuance response replays the exact challenge and expiry');
  rejected:=false;begin perform public.payroll_kiosk_touch_challenge(token2,emp,'in',request);exception when others then rejected:=sqlerrm='PAYROLL_KIOSK_REQUEST_CONFLICT';end;
  perform pg_temp.touch_assert(rejected,'challenge request UUID is bound to its issuing device');
  rejected:=false;begin perform public.payroll_kiosk_touch_confirm(token2,(challenge->>'challenge_id')::uuid,challenge->>'code');exception when others then rejected:=sqlerrm='PAYROLL_KIOSK_TOUCH_CHALLENGE_NOT_FOUND';end;
  perform pg_temp.touch_assert(rejected,'another valid device cannot consume a challenge');
  wrong_code:=case when challenge->>'code'='0000' then '0001' else '0000' end;
  for i in 1..5 loop
    answer:=public.payroll_kiosk_touch_confirm(token,(challenge->>'challenge_id')::uuid,wrong_code);
    perform pg_temp.touch_assert(answer->'ok'='false'::jsonb and (answer->>'attempts_remaining')::integer=5-i,'wrong code persists one failed attempt without a transaction exception');
  end loop;
  perform pg_temp.touch_assert(answer->>'error'='locked' and public.payroll_kiosk_touch_confirm(token,(challenge->>'challenge_id')::uuid,challenge->>'code')->>'error'='locked','five wrong entries lock even a later correct code');
  execute 'set local role postgres';
  perform pg_temp.touch_assert((select attempts=5 from payroll_kiosk.payroll_kiosk_touch_challenges where request_id=request)
    and not exists(select 1 from public.payroll_attendance_raw where employee_id=emp),'wrong inputs do not create work time');
  execute 'set local role anon';
  old_code:=challenge->>'code';request:=gen_random_uuid();challenge:=public.payroll_kiosk_touch_challenge(token,emp,'in',request);
  perform pg_temp.touch_assert(challenge->>'code'<>old_code,'new request differs from previous visible code');
  execute 'set local role postgres';
  update payroll_kiosk.payroll_kiosk_touch_challenges set created_at=created_at-interval '121 seconds',expires_at=expires_at-interval '121 seconds' where request_id=request;
  execute 'set local role anon';
  perform pg_temp.touch_assert(public.payroll_kiosk_touch_confirm(token,(challenge->>'challenge_id')::uuid,challenge->>'code')->>'error'='expired','expired correct code does not create late work');
  perform pg_temp.touch_assert(public.payroll_kiosk_touch_challenge(token,emp,'in',request)->>'status'='expired','repeated issuance never extends expiry');
  request:=gen_random_uuid();challenge:=public.payroll_kiosk_touch_challenge(token,emp,'in',request);old_id:=(challenge->>'challenge_id')::uuid;
  second:=public.payroll_kiosk_touch_challenge(token,other_emp,'in',gen_random_uuid());
  perform pg_temp.touch_assert(public.payroll_kiosk_touch_confirm(token,old_id,challenge->>'code')->>'error'='cancelled','choosing another employee replaces prior active confirmation');
  perform pg_temp.touch_assert(public.payroll_kiosk_touch_receipt(token,(second->>'request_id')::uuid)->>'status'='not_saved','receipt closes an uncommitted confirmation');
  perform pg_temp.touch_assert(public.payroll_kiosk_touch_confirm(token,(second->>'challenge_id')::uuid,second->>'code')->>'error'='cancelled','confirm arriving after definitive not_saved cannot save');
  execute 'set local role postgres';select version into revision from public.payroll_revision where id=1;
  select count(*) into audit_before from public.payroll_audit where table_name='payroll_attendance_raw';execute 'set local role anon';
  for i in 1..4 loop
    request:=gen_random_uuid();challenge:=public.payroll_kiosk_touch_challenge(token,emp,directions[i],request);
    answer:=public.payroll_kiosk_touch_confirm(token,(challenge->>'challenge_id')::uuid,challenge->>'code');
    perform pg_temp.touch_assert(answer->'ok'='true'::jsonb and answer->'event'->>'punch_type'=directions[i]
      and answer->'event'->>'verification'='visible_code_confirmation','two complete in/out cycles use honest manual-confirmation provenance');
    perform pg_temp.touch_assert(abs(extract(epoch from (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')-(answer->'event'->>'occurred_at')::timestamp))<5,'server confirmation time is authoritative');
    if i=1 then first_event:=answer->'event';first_request:=request;end if;
    receipt:=public.payroll_kiosk_touch_receipt(token,request);
    perform pg_temp.touch_assert(receipt->>'status'='saved' and (receipt->'event')-'replayed'=(answer->'event')-'replayed','confirm-before-receipt returns original committed event');
    perform pg_temp.touch_assert((public.payroll_kiosk_touch_confirm(token,(challenge->>'challenge_id')::uuid,challenge->>'code')->'event')-'replayed'=(answer->'event')-'replayed','repeated successful confirmation is idempotent');
    rejected:=false;begin perform public.payroll_kiosk_touch_challenge(token,emp,directions[i],gen_random_uuid());exception when others then rejected:=sqlerrm='PAYROLL_KIOSK_SAME_DIRECTION';end;
    perform pg_temp.touch_assert(rejected,'repeated direction remains blocked');
    rejected:=false;begin perform public.payroll_kiosk_touch_challenge(token,emp,case directions[i] when 'in' then 'out' else 'in' end,gen_random_uuid());exception when others then rejected:=sqlerrm='PAYROLL_KIOSK_COOLDOWN';end;
    perform pg_temp.touch_assert(rejected,'thirty-second direction-switch cooldown remains enforced');
    execute 'set local role postgres';
    set constraints public.payroll_attendance_raw_import_id_fkey immediate;
    alter table public.payroll_attendance_raw disable trigger user;
    update public.payroll_attendance_raw set occurred_at=occurred_at-interval '60 seconds' where id=(answer->'event'->>'event_id')::uuid;
    alter table public.payroll_attendance_raw enable trigger user;
    execute 'set local role anon';
  end loop;
  execute 'set local role postgres';
  perform pg_temp.touch_assert((select count(*)=4 from public.payroll_attendance_raw where employee_id=emp)
    and (select version=revision+4 from public.payroll_revision where id=1)
    and (select count(*)=audit_before+4 from public.payroll_audit where table_name='payroll_attendance_raw'),'four confirmations produce exactly four raw rows/revisions/audit events');
  perform pg_temp.touch_assert((select bool_and(source='kiosk' and verification_method='visible_code_confirmation' and created_by=actor) from public.payroll_attendance_raw where employee_id=emp),'typed touch records use existing payroll input and audit attribution');
  execute 'set local role anon';
  request:=gen_random_uuid();challenge:=public.payroll_kiosk_touch_challenge(token,emp,'in',request);
  perform public.payroll_kiosk_punch(token2,emp,'in',gen_random_uuid());
  perform pg_temp.touch_assert(public.payroll_kiosk_touch_confirm(token,(challenge->>'challenge_id')::uuid,challenge->>'code')->>'error'='stale_state','existing face page changing state invalidates an outstanding touch code');
  perform pg_temp.touch_assert(public.payroll_kiosk_touch_challenge(token,emp,'in',request)->>'status'='stale_state','issuance retry cannot hide a changed attendance state');
  rejected:=false;begin perform public.payroll_kiosk_touch_challenge(token,other_emp,'in',first_request);exception when others then rejected:=sqlerrm='PAYROLL_KIOSK_REQUEST_CONFLICT';end;
  perform pg_temp.touch_assert(rejected,'completed request cannot be rebound to another employee');
  request:=gen_random_uuid();challenge:=public.payroll_kiosk_touch_challenge(token,other_emp,'in',request);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'app_metadata',jsonb_build_object('role','admin'))::text,true);execute 'set local role authenticated';
  update public.payroll_employees set employment_status='leave' where id=other_emp;
  perform set_config('request.jwt.claims','{}',true);execute 'set local role anon';
  perform pg_temp.touch_assert(public.payroll_kiosk_touch_confirm(token,(challenge->>'challenge_id')::uuid,challenge->>'code')->>'error'='employee_not_active','employee eligibility is rechecked at confirmation');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'app_metadata',jsonb_build_object('role','admin'))::text,true);execute 'set local role authenticated';
  update public.payroll_employees set employment_status='active' where id=other_emp;
  request:=gen_random_uuid();challenge:=public.payroll_kiosk_touch_challenge(token,other_emp,'in',request);
  perform public.payroll_kiosk_revoke(dev,'Synthetic revoked confirmation');
  perform set_config('request.jwt.claims','{}',true);execute 'set local role anon';
  rejected:=false;begin perform public.payroll_kiosk_touch_confirm(token,(challenge->>'challenge_id')::uuid,challenge->>'code');exception when insufficient_privilege then rejected:=true;end;
  perform pg_temp.touch_assert(rejected,'revoked device cannot complete an already issued code');
  rejected:=false;begin perform public.payroll_kiosk_touch_receipt(token,request);exception when insufficient_privilege then rejected:=true;end;
  perform pg_temp.touch_assert(rejected,'revoked device cannot resolve private results');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'app_metadata',jsonb_build_object('role','admin'))::text,true);execute 'set local role authenticated';
  perform pg_temp.touch_assert(public.payroll_kiosk_touch_admin_receipt(dev,request)->>'status'='not_saved','admin can close uncertain request from a revoked device');
  perform pg_temp.touch_assert(public.payroll_kiosk_touch_admin_receipt(dev,first_request)->>'status'='saved','admin can recover a saved result from a revoked device');
  rejected:=false;begin perform public.payroll_kiosk_touch_admin_receipt(dev,gen_random_uuid());exception when others then rejected:=sqlerrm='PAYROLL_KIOSK_TOUCH_CHALLENGE_NOT_FOUND';end;
  perform pg_temp.touch_assert(rejected,'unknown issuance is not falsely declared definitive not_saved');
end;$$;
rollback;
