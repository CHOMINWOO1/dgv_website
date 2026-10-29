-- Isolated regression only. The timestamp-adjustment fixture below temporarily
-- disables raw USER triggers inside this rolled-back transaction. Do not run
-- this file against production; use payroll-kiosk-live.sql there instead.
begin;
create function pg_temp.kiosk_assert(p_ok boolean,p_message text) returns void language plpgsql as $$
begin if p_ok is distinct from true then raise exception 'FAIL: %',p_message;end if;end;$$;
do $$
declare actor uuid:='00000000-0000-4000-8000-000000000009';dev uuid:=gen_random_uuid();dev2 uuid:=gen_random_uuid();
  emp uuid:=gen_random_uuid();other_emp uuid:=gen_random_uuid();future_emp uuid:=gen_random_uuid();ended_emp uuid:=gen_random_uuid();
  token text:=encode(sha256(convert_to(gen_random_uuid()::text,'UTF8')),'hex');token2 text:=encode(sha256(convert_to(gen_random_uuid()::text,'UTF8')),'hex');
  request uuid:=gen_random_uuid();request2 uuid:=gen_random_uuid();grant_id uuid;grant2 uuid;revision bigint;
  event jsonb;receipt jsonb;roster jsonb;rejected boolean;local_now timestamp;event_count bigint;audit_count bigint;
begin
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'app_metadata',jsonb_build_object('role','admin'))::text,true);
  execute 'set local role authenticated';
  insert into public.payroll_employees(id,device_user_id,name) values(emp,'KIOSK-'||emp,'Kiosk fixture'),(other_emp,'KIOSK-'||other_emp,'Not enrolled');
  insert into public.payroll_employees(id,device_user_id,name,hire_date) values(future_emp,'KIOSK-'||future_emp,'Future hire',(clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date+1);
  insert into public.payroll_employees(id,device_user_id,name,termination_date) values(ended_emp,'KIOSK-'||ended_emp,'Past termination',(clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date-1);
  perform pg_temp.kiosk_assert(public.payroll_kiosk_register(dev,'Tablet fixture',token)->>'device_id'=dev::text,'admin registers stable device UUID');
  perform public.payroll_kiosk_register(dev,'Tablet fixture',token);
  rejected:=false;
  begin perform public.payroll_kiosk_register(dev,'Changed name',token);exception when others then rejected:=sqlerrm='PAYROLL_KIOSK_DEVICE_CONFLICT';end;
  perform pg_temp.kiosk_assert(rejected,'conflicting registration cannot overwrite credentials');
  perform public.payroll_kiosk_register(dev2,'Second tablet',token2);
  grant_id:=public.payroll_kiosk_enroll(dev,emp,'local-face-consent-v1');
  perform pg_temp.kiosk_assert(public.payroll_kiosk_enroll(dev,emp,'local-face-consent-v1')=grant_id,'enrollment retry is idempotent');
  rejected:=false;
  begin perform public.payroll_kiosk_enroll(dev,future_emp,'v1');exception when others then rejected:=sqlerrm='PAYROLL_KIOSK_EMPLOYEE_NOT_ACTIVE';end;
  perform pg_temp.kiosk_assert(rejected,'pre-hire enrollment blocked');
  rejected:=false;
  begin perform public.payroll_kiosk_enroll(dev,ended_emp,'v1');exception when others then rejected:=sqlerrm='PAYROLL_KIOSK_EMPLOYEE_NOT_ACTIVE';end;
  perform pg_temp.kiosk_assert(rejected,'post-termination enrollment blocked');
  select version into revision from public.payroll_revision where id=1;
  execute 'set local role postgres';
  perform pg_temp.kiosk_assert((select count(*)=2 from payroll_kiosk.payroll_kiosk_admin_audit where device_id=dev),'registration and enrollment exact retries add no history');
  perform pg_temp.kiosk_assert((select token_hash=encode(sha256(convert_to(token,'UTF8')),'hex') and token_hash<>token from payroll_kiosk.payroll_kiosk_devices where id=dev),'only SHA256 of random token is persisted');
  perform pg_temp.kiosk_assert(not exists(select 1 from payroll_kiosk.payroll_kiosk_admin_audit where detail::text like '%'||token||'%'),'admin audit contains no token');
  perform pg_temp.kiosk_assert(not pg_has_role('anon','payroll_kiosk_writer','MEMBER') and not pg_has_role('authenticated','payroll_kiosk_writer','MEMBER'),'API roles cannot SET ROLE to writer');
  perform pg_temp.kiosk_assert(not has_schema_privilege('anon','private','USAGE') and not has_schema_privilege('payroll_kiosk_writer','private','USAGE'),
    'kiosk capability does not widen access to existing private/Vault helpers');
  perform pg_temp.kiosk_assert(not has_function_privilege('anon','payroll_kiosk.payroll_kiosk_require(text)','EXECUTE')
    and not has_function_privilege('authenticated','payroll_kiosk.payroll_kiosk_require(text)','EXECUTE'),'hash-returning internal helper is inaccessible');
  perform pg_temp.kiosk_assert(not has_table_privilege('payroll_kiosk_writer','public.payroll_terms','SELECT')
    and not has_column_privilege('payroll_kiosk_writer','public.payroll_employees','phone','SELECT')
    and not has_table_privilege('payroll_kiosk_writer','private.payroll_sensitive_versions','SELECT'),'writer has no wage or private employee access');
  perform set_config('request.jwt.claims','{}',true);
  execute 'set local role anon';
  rejected:=false;begin perform public.payroll_kiosk_register(gen_random_uuid(),'No admin',token);exception when insufficient_privilege then rejected:=true;end;
  perform pg_temp.kiosk_assert(rejected,'anonymous caller cannot register devices');
  rejected:=false;begin perform public.payroll_kiosk_roster(repeat('0',64));exception when insufficient_privilege then rejected:=true;end;
  perform pg_temp.kiosk_assert(rejected,'invalid capability cannot read roster');
  rejected:=false;begin perform 1 from public.payroll_employees;exception when insufficient_privilege then rejected:=true;end;
  perform pg_temp.kiosk_assert(rejected,'device has no direct employee table access');
  rejected:=false;begin perform 1 from public.payroll_attendance_raw;exception when insufficient_privilege then rejected:=true;end;
  perform pg_temp.kiosk_assert(rejected,'device has no direct attendance table access');
  rejected:=false;begin perform 1 from payroll_kiosk.payroll_kiosk_devices;exception when insufficient_privilege then rejected:=true;end;
  perform pg_temp.kiosk_assert(rejected,'device has no direct credential table access');
  roster:=public.payroll_kiosk_roster(token);
  perform pg_temp.kiosk_assert(jsonb_array_length(roster->'employees')=1 and roster->'employees'->0->>'enrollment_id'=grant_id::text
    and roster->'employees'->0->'last_punch'='null'::jsonb,'roster contains only enrolled employee and grant UUID');
  perform pg_temp.kiosk_assert((roster->'employees'->0)-array['id','device_user_id','name','enrollment_id','last_punch']='{}'::jsonb,'roster excludes sensitive and salary fields');
  rejected:=false;begin perform public.payroll_kiosk_punch(token,other_emp,'in',gen_random_uuid());exception when others then rejected:=sqlerrm='PAYROLL_KIOSK_EMPLOYEE_NOT_ENROLLED';end;
  perform pg_temp.kiosk_assert(rejected,'valid device cannot punch arbitrary existing employee');
  rejected:=false;begin perform public.payroll_kiosk_punch(token,emp,'out',gen_random_uuid());exception when others then rejected:=sqlerrm='PAYROLL_KIOSK_CHECK_IN_REQUIRED';end;
  perform pg_temp.kiosk_assert(rejected,'first out without in rejected');
  rejected:=false;begin perform public.payroll_kiosk_punch(token,emp,'future',gen_random_uuid());exception when others then rejected:=sqlerrm='PAYROLL_KIOSK_INVALID_PUNCH';end;
  perform pg_temp.kiosk_assert(rejected,'invalid typed direction rejected');
  event:=public.payroll_kiosk_punch(token,emp,'in',request);
  local_now:=clock_timestamp() at time zone 'Asia/Ho_Chi_Minh';
  perform pg_temp.kiosk_assert(event->>'punch_type'='in' and event->>'verification'='trusted_kiosk_verification'
    and (event->>'replayed')::boolean=false and abs(extract(epoch from local_now-(event->>'occurred_at')::timestamp))<5,'server creates honest Vietnamese wall-clock event');
  receipt:=public.payroll_kiosk_punch(token,emp,'in',request);
  perform pg_temp.kiosk_assert(receipt-'replayed'=event-'replayed' and (receipt->>'replayed')::boolean,'lost-response retry returns original time/event');
  perform pg_temp.kiosk_assert(public.payroll_kiosk_receipt(token,request)=receipt,'receipt-only lookup returns original event');
  perform pg_temp.kiosk_assert(public.payroll_kiosk_receipt(token,gen_random_uuid()) is null,'unknown receipt does not create a delayed attendance event');
  perform pg_temp.kiosk_assert(public.payroll_kiosk_receipt(token2,request) is null,'another device cannot retrieve receipt');
  rejected:=false;begin perform public.payroll_kiosk_punch(token,emp,'out',request);exception when others then rejected:=sqlerrm='PAYROLL_KIOSK_REQUEST_CONFLICT';end;
  perform pg_temp.kiosk_assert(rejected,'request UUID cannot be reused for another direction');
  rejected:=false;begin perform public.payroll_kiosk_punch(token2,emp,'in',request);exception when others then rejected:=sqlerrm='PAYROLL_KIOSK_REQUEST_CONFLICT';end;
  perform pg_temp.kiosk_assert(rejected,'global request UUID cannot be reused by another device');
  rejected:=false;begin perform public.payroll_kiosk_punch(token,emp,'in',gen_random_uuid());exception when others then rejected:=sqlerrm='PAYROLL_KIOSK_SAME_DIRECTION';end;
  perform pg_temp.kiosk_assert(rejected,'consecutive in on new request rejected');
  rejected:=false;begin perform public.payroll_kiosk_punch(token,emp,'out',request2);exception when others then rejected:=sqlerrm='PAYROLL_KIOSK_COOLDOWN';end;
  perform pg_temp.kiosk_assert(rejected,'accidental rapid direction switch blocked');
  perform pg_temp.kiosk_assert(public.payroll_kiosk_roster(token)->'employees'->0->'last_punch'->>'punch_type'='in','roster shows active in state');
  execute 'set local role postgres';
  perform pg_temp.kiosk_assert((select count(*)=1 from public.payroll_attendance_raw where employee_id=emp)
    and (select version=revision+1 from public.payroll_revision where id=1),'all repeats/rejections leave exactly one row and one revision increment');
  perform pg_temp.kiosk_assert((select source='kiosk' and import_id is null and created_by=actor from public.payroll_attendance_raw where id=(event->>'event_id')::uuid),'kiosk provenance does not invent an Excel import');
  perform pg_temp.kiosk_assert((select count(*)=1 from public.payroll_audit where record_id=(event->>'event_id')::uuid
    and after_data->>'source'='kiosk' and after_data->>'kiosk_device_id'=dev::text),'kiosk insert has immutable public audit attribution');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'app_metadata',jsonb_build_object('role','admin'))::text,true);
  execute 'set local role authenticated';
  rejected:=false;
  begin perform public.payroll_finalize(emp,date_trunc('month',local_now)::date,0,0,0,'{"unresolved":0}',revision);
  exception when others then rejected:=sqlerrm='PAYROLL_STALE_RELOAD_REQUIRED';end;
  perform pg_temp.kiosk_assert(rejected,'kiosk punch invalidates an already reviewed payroll snapshot');
  execute 'set local role postgres';
  -- Only the isolated test fixture is moved back in time. No client RPC accepts
  -- a clock argument and production callers cannot suspend these triggers.
  set constraints public.payroll_attendance_raw_import_id_fkey immediate;
  alter table public.payroll_attendance_raw disable trigger user;
  update public.payroll_attendance_raw set occurred_at=occurred_at-interval '25 hours' where id=(event->>'event_id')::uuid;
  alter table public.payroll_attendance_raw enable trigger user;
  execute 'set local role anon';
  event:=public.payroll_kiosk_punch(token,emp,'out',request2);
  perform pg_temp.kiosk_assert(event->>'punch_type'='out','long-shift out is saved for calculation review instead of losing evidence');
  execute 'set local role postgres';
  alter table public.payroll_attendance_raw disable trigger user;
  update public.payroll_attendance_raw set occurred_at=occurred_at-interval '1 minute' where id=(event->>'event_id')::uuid;
  alter table public.payroll_attendance_raw enable trigger user;
  execute 'set local role anon';
  perform public.payroll_kiosk_punch(token,emp,'in',gen_random_uuid());
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'app_metadata',jsonb_build_object('role','manager'),'user_metadata',jsonb_build_object('role','admin'))::text,true);
  execute 'set local role authenticated';
  rejected:=false;begin perform public.payroll_kiosk_enroll(dev,other_emp,'v1');exception when insufficient_privilege then rejected:=true;end;
  perform pg_temp.kiosk_assert(rejected,'manager and spoofed user_metadata cannot approve enrollment');
  rejected:=false;begin perform public.payroll_kiosk_devices();exception when insufficient_privilege then rejected:=true;end;
  perform pg_temp.kiosk_assert(rejected,'manager cannot administer devices');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'app_metadata',jsonb_build_object('role','admin'))::text,true);
  rejected:=false;begin insert into public.payroll_attendance_raw(employee_id,occurred_at,device_id,source,punch_type,kiosk_device_id,kiosk_request_id)
    values(emp,local_now,'kiosk:'||dev,'kiosk','out',dev,gen_random_uuid());exception when others then rejected:=sqlerrm='PAYROLL_KIOSK_RPC_REQUIRED';end;
  perform pg_temp.kiosk_assert(rejected,'direct administrator raw insert cannot claim kiosk-verification provenance');
  perform public.payroll_kiosk_unenroll(dev,emp,'Consent withdrawn');
  perform pg_temp.kiosk_assert(jsonb_array_length(public.payroll_kiosk_roster(token)->'employees')=0,'consent withdrawal immediately removes roster access');
  rejected:=false;begin perform public.payroll_kiosk_punch(token,emp,'out',gen_random_uuid());exception when others then rejected:=sqlerrm='PAYROLL_KIOSK_EMPLOYEE_NOT_ENROLLED';end;
  perform pg_temp.kiosk_assert(rejected,'withdrawn grant cannot create new punches');
  grant2:=public.payroll_kiosk_enroll(dev,emp,'local-face-consent-v2');
  perform pg_temp.kiosk_assert(grant2<>grant_id and public.payroll_kiosk_roster(token)->'employees'->0->>'enrollment_id'=grant2::text,'reenrollment creates distinct grant UUID so old local templates are invalid');
  update public.payroll_employees set employment_status='terminated' where id=emp;
  rejected:=false;begin perform public.payroll_kiosk_punch(token,emp,'out',gen_random_uuid());exception when others then rejected:=sqlerrm='PAYROLL_KIOSK_EMPLOYEE_NOT_ACTIVE';end;
  perform pg_temp.kiosk_assert(rejected,'terminated employee cannot make new punches');
  perform public.payroll_kiosk_revoke(dev,'Lost tablet');
  rejected:=false;begin perform public.payroll_kiosk_roster(token);exception when insufficient_privilege then rejected:=true;end;
  perform pg_temp.kiosk_assert(rejected,'revoked device cannot read roster');
  rejected:=false;begin perform public.payroll_kiosk_receipt(token,request);exception when insufficient_privilege then rejected:=true;end;
  perform pg_temp.kiosk_assert(rejected,'revoked capability cannot read prior receipts');
  rejected:=false;begin perform public.payroll_kiosk_punch(token,emp,'in',request);exception when insufficient_privilege then rejected:=true;end;
  perform pg_temp.kiosk_assert(rejected,'revoked capability cannot punch or replay');
end;$$;
rollback;
