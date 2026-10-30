-- Isolated regression only. Synthetic descriptors are generated in memory and
-- all fixture rows are rolled back. Never prints biometrics or credentials.
begin;
create function pg_temp.shared_faces_assert(p_ok boolean,p_message text) returns void language plpgsql as $$
begin if p_ok is distinct from true then raise exception 'FAIL: %',p_message;end if;end;$$;
do $$
declare actor uuid:='00000000-0000-4000-8000-000000000052';emp uuid:=gen_random_uuid();legacy_emp uuid:=gen_random_uuid();deleted_emp uuid:=gen_random_uuid();
  inactive_emp uuid:=gen_random_uuid();service_emp uuid:=gen_random_uuid();archived_emp uuid:=gen_random_uuid();
  dev uuid:=gen_random_uuid();dev2 uuid:=gen_random_uuid();token text:=repeat('a',64);token2 text:=repeat('b',64);
  grant_id uuid;deleted_grant uuid;request uuid:=gen_random_uuid();delete_request uuid:=gen_random_uuid();unrelated_secret uuid;
  sample jsonb;face jsonb;bad jsonb;result jsonb;removed jsonb;roster jsonb;payload jsonb;revision bigint;n bigint;rejected boolean;role_name text;
begin
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'app_metadata',jsonb_build_object('role','admin'))::text,true);
  execute 'set local role authenticated';
  insert into public.payroll_employees(id,device_user_id,name) values(emp,'FACE-'||emp,'Shared A'),(legacy_emp,'FACE-'||legacy_emp,'Shared legacy'),
    (deleted_emp,'FACE-'||deleted_emp,'Shared removed'),(service_emp,'FACE-'||service_emp,'Shared service'),(archived_emp,'FACE-'||archived_emp,'Shared archived');
  insert into public.payroll_employees(id,device_user_id,name,active,employment_status) values(inactive_emp,'FACE-'||inactive_emp,'Shared inactive',false,'leave');
  execute 'set local role postgres';
  update public.payroll_employees set payee_type='service' where id=service_emp;
  execute 'set local role authenticated';
  select version into revision from public.payroll_revision where id=1;
  perform public.payroll_set_employee_archived(archived_emp,true,'Synthetic archive exclusion',revision);
  perform public.payroll_kiosk_register(dev,'Shared fixture A',token);perform public.payroll_kiosk_register(dev2,'Shared fixture B',token2);
  grant_id:=public.payroll_kiosk_enroll(dev,legacy_emp,'legacy-consent-v1');deleted_grant:=public.payroll_kiosk_enroll(dev,deleted_emp,'legacy-consent-v1');
  select jsonb_agg(0.1 order by i) into sample from generate_series(1,128) i;
  face:=jsonb_build_object('version',1,'model','dlib-resnet128-faceapi-1.7.15-tiny68-v1','samples',jsonb_build_array(sample,sample,sample),'createdAt','2026-10-30T00:00:00.000Z');
  execute 'set local role postgres';
  unrelated_secret:=vault.create_secret('Not an attendance descriptor','shared-face-unrelated-'||gen_random_uuid()::text);
  perform pg_temp.shared_faces_assert(not has_table_privilege('anon','payroll_kiosk.payroll_kiosk_faces','SELECT')
    and not has_table_privilege('authenticated','payroll_kiosk.payroll_kiosk_face_requests','SELECT')
    and not has_column_privilege('payroll_kiosk_writer','payroll_kiosk.payroll_kiosk_faces','secret_id','SELECT')
    and not has_table_privilege('payroll_kiosk_writer','vault.decrypted_secrets','SELECT'),'API and event writer have no Vault or private face access');
  perform pg_temp.shared_faces_assert(not has_function_privilege('anon','payroll_kiosk.payroll_kiosk_face_write(text,uuid,jsonb,text,bigint,uuid,uuid,uuid,uuid,text)','EXECUTE')
    and not has_function_privilege('authenticated','payroll_kiosk.payroll_kiosk_punch_checked(text,uuid,text,uuid,bigint,boolean)','EXECUTE'),'internal mutation helpers cannot be directly invoked');
  foreach role_name in array array['manager','staff'] loop
    perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'app_metadata',jsonb_build_object('role',role_name),'user_metadata',jsonb_build_object('role','admin'))::text,true);
    execute 'set local role authenticated';
    rejected:=false;begin perform public.payroll_kiosk_face_save(emp,face,'central-v1',0,gen_random_uuid());exception when insufficient_privilege then rejected:=true;end;
    perform pg_temp.shared_faces_assert(rejected,'non-admin/spoof user_metadata cannot register shared face');
    rejected:=false;begin perform public.payroll_kiosk_face_delete(emp,0,'Denied delete',gen_random_uuid());exception when insufficient_privilege then rejected:=true;end;
    perform pg_temp.shared_faces_assert(rejected,'non-admin cannot create deletion tombstone');
  end loop;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'app_metadata',jsonb_build_object('role','admin'))::text,true);execute 'set local role authenticated';
  for bad in select value from jsonb_array_elements(jsonb_build_array(
    'null'::jsonb,face||'{"version":2}'::jsonb,face||'{"model":"unknown"}'::jsonb,face||'{"photo":"not accepted"}'::jsonb,
    face||'{"samples":[]}'::jsonb,jsonb_set(face,'{samples,0}','[]'),jsonb_set(face,'{samples,0,0}','null'),
    jsonb_set(face,'{samples,0,0}','"NaN"'),jsonb_set(face,'{samples,0,0}','6'),
    face||'{"createdAt":"infinity"}',jsonb_set(face,'{samples,0,0}','1'))) loop
    rejected:=false;begin perform public.payroll_kiosk_face_save(emp,bad,'central-v1',0,gen_random_uuid());exception when others then rejected:=sqlerrm='PAYROLL_KIOSK_INVALID_FACE_TEMPLATE';end;
    perform pg_temp.shared_faces_assert(rejected,'malformed, nonfinite, unknown model, picture keys or inconsistent samples rejected atomically');
  end loop;
  rejected:=false;begin perform public.payroll_kiosk_face_save(emp,face,'central-v1',null,gen_random_uuid());exception when others then rejected:=sqlerrm='PAYROLL_KIOSK_INVALID_FACE_REQUEST';end;
  perform pg_temp.shared_faces_assert(rejected,'null expected revision is not an unconditional overwrite');
  rejected:=false;begin perform public.payroll_kiosk_face_save(inactive_emp,face,'central-v1',0,gen_random_uuid());exception when others then
    if sqlerrm<>'PAYROLL_KIOSK_EMPLOYEE_NOT_ACTIVE' then raise;end if;rejected:=true;end;
  perform pg_temp.shared_faces_assert(rejected,'inactive employee cannot acquire central face');
  rejected:=false;begin perform public.payroll_kiosk_enroll(dev,service_emp,'legacy-v1');exception when others then rejected:=sqlerrm='PAYROLL_KIOSK_EMPLOYEE_NOT_ACTIVE';end;
  perform pg_temp.shared_faces_assert(rejected,'service provider cannot receive legacy attendance grant');
  execute 'set local role postgres';
  perform pg_temp.shared_faces_assert(not exists(select 1 from payroll_kiosk.payroll_kiosk_faces) and (select count(*)=1 from vault.secrets),'rejected requests leave no face or orphan Vault secrets');
  perform set_config('request.jwt.claims','{}',true);execute 'set local role anon';
  roster:=public.payroll_kiosk_roster(token2);
  perform pg_temp.shared_faces_assert(jsonb_array_length(roster->'employees')=3,'device without enrollments sees every eligible normal employee');
  perform pg_temp.shared_faces_assert((select bool_and(value->'enrollment_id'='null'::jsonb and value->>'face_revision'='0' and value->'face_registered'='false'::jsonb)
    from jsonb_array_elements(roster->'employees')),'unregistered central faces are explicitly marked without leaking other device grant IDs');
  perform pg_temp.shared_faces_assert((select (value->>'has_legacy_enrollment')::boolean from jsonb_array_elements(roster->'employees') where value->>'id'=legacy_emp::text),'device can show prior-device migration requirement');
  perform pg_temp.shared_faces_assert(public.payroll_kiosk_face_get(token2,emp) is null,'no template returns null');
  rejected:=false;begin perform public.payroll_kiosk_face_migrate(token2,legacy_emp,grant_id,face,request);exception when others then rejected:=sqlerrm='PAYROLL_KIOSK_EMPLOYEE_NOT_ENROLLED';end;
  perform pg_temp.shared_faces_assert(rejected,'different valid device cannot use another device legacy grant');
  result:=public.payroll_kiosk_face_migrate(token,legacy_emp,grant_id,face,request);
  perform pg_temp.shared_faces_assert((result->>'face_registered')::boolean and public.payroll_kiosk_face_get(token2,legacy_emp)->'template'=face,'verified legacy device shares face to another registered device');
  perform pg_temp.shared_faces_assert((public.payroll_kiosk_face_migrate(token,legacy_emp,grant_id,face,request)->>'replayed')::boolean,'lost migration response is an exact idempotent replay');
  rejected:=false;begin perform public.payroll_kiosk_face_migrate(token,legacy_emp,grant_id,face||'{"createdAt":"2026-10-30T00:00:01.000Z"}',request);exception when others then rejected:=sqlerrm='PAYROLL_KIOSK_FACE_REQUEST_CONFLICT';end;
  perform pg_temp.shared_faces_assert(rejected,'same request cannot replace payload');
  rejected:=false;begin perform public.payroll_kiosk_face_migrate(token,legacy_emp,grant_id,face,gen_random_uuid());exception when others then rejected:=sqlerrm='PAYROLL_KIOSK_FACE_EXISTS';end;
  perform pg_temp.shared_faces_assert(rejected,'fresh migration cannot overwrite current central face');
  rejected:=false;begin perform public.payroll_kiosk_face_get(repeat('0',64),legacy_emp);exception when insufficient_privilege then rejected:=true;end;
  perform pg_temp.shared_faces_assert(rejected,'invalid device token cannot retrieve descriptors');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'app_metadata',jsonb_build_object('role','admin'))::text,true);execute 'set local role authenticated';
  rejected:=false;begin perform public.payroll_kiosk_face_save(legacy_emp,face,'central-v1',0,gen_random_uuid());exception when others then rejected:=sqlerrm='PAYROLL_KIOSK_FACE_REVISION_CHANGED';end;
  perform pg_temp.shared_faces_assert(rejected,'stale administrator registration cannot overwrite migrated face');
  removed:=public.payroll_kiosk_face_delete(legacy_emp,(result->>'face_revision')::bigint,'Withdraw shared consent',delete_request);
  perform pg_temp.shared_faces_assert((public.payroll_kiosk_face_delete(legacy_emp,(result->>'face_revision')::bigint,'Withdraw shared consent',delete_request)->>'replayed')::boolean,'delete lost-response replay is idempotent');
  perform public.payroll_kiosk_face_delete(deleted_emp,0,'Remove legacy registration centrally',gen_random_uuid());
  perform set_config('request.jwt.claims','{}',true);execute 'set local role anon';
  perform pg_temp.shared_faces_assert(public.payroll_kiosk_face_get(token,legacy_emp) is null,'deleted template is no longer retrievable');
  rejected:=false;begin perform public.payroll_kiosk_face_migrate(token,legacy_emp,grant_id,face,gen_random_uuid());exception when others then rejected:=sqlerrm='PAYROLL_KIOSK_FACE_EXISTS';end;
  perform pg_temp.shared_faces_assert(rejected,'deletion tombstone prevents stale device reimport');
  rejected:=false;begin perform public.payroll_kiosk_face_migrate(token,deleted_emp,deleted_grant,face,gen_random_uuid());exception when others then rejected:=sqlerrm='PAYROLL_KIOSK_FACE_EXISTS';end;
  perform pg_temp.shared_faces_assert(rejected,'delete-before-first-migration also prevents automatic resurrection');
  rejected:=false;begin perform public.payroll_kiosk_punch(token,legacy_emp,'in',gen_random_uuid(),(result->>'face_revision')::bigint);exception when others then rejected:=sqlerrm='PAYROLL_KIOSK_FACE_NOT_REGISTERED';end;
  perform pg_temp.shared_faces_assert(rejected,'deleted central face blocks new events');
  rejected:=false;begin perform public.payroll_kiosk_punch(token,legacy_emp,'in',gen_random_uuid());exception when others then rejected:=sqlerrm='PAYROLL_KIOSK_FACE_REFRESH_REQUIRED';end;
  perform pg_temp.shared_faces_assert(rejected,'deleted central face cannot fall back to legacy grant');
  perform pg_temp.shared_faces_assert((public.payroll_kiosk_face_migrate(token,legacy_emp,grant_id,face,request)->>'replayed')::boolean
    and public.payroll_kiosk_face_get(token,legacy_emp) is null,'an exact old migration retry does not resurrect deleted data');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'app_metadata',jsonb_build_object('role','admin'))::text,true);execute 'set local role authenticated';
  result:=public.payroll_kiosk_face_save(legacy_emp,face,'new-explicit-consent',(removed->>'face_revision')::bigint,gen_random_uuid());
  perform pg_temp.shared_faces_assert((result->>'face_registered')::boolean,'explicit administrator action may replace a tombstone at current revision');
  payload:=public.payroll_backup();
  perform pg_temp.shared_faces_assert(not(payload->'tables' ? 'payroll_kiosk_faces') and position('dlib-resnet128' in payload::text)=0
    and position('new-explicit-consent' in payload::text)=0,'ordinary payroll backup excludes all central biometric values and metadata');
  rejected:=false;begin perform public.payroll_restore(payload);exception when others then rejected:=sqlerrm='PAYROLL_RESTORE_REQUIRES_EMPTY_DATABASE';end;
  perform pg_temp.shared_faces_assert(rejected,'backup restore cannot overwrite active employees or face references');
  execute 'set local role postgres';
  perform pg_temp.shared_faces_assert(exists(select 1 from vault.secrets where id=unrelated_secret),'unrelated Vault secrets survive replacement and deletion');
  perform pg_temp.shared_faces_assert((select count(*)=2 from vault.secrets),'only unrelated secret and one current descriptor remain');
  perform pg_temp.shared_faces_assert(not exists(select 1 from payroll_kiosk.payroll_kiosk_face_requests r where to_jsonb(r)::text like '%samples%' or to_jsonb(r)::text like '%dlib-resnet128%'),'request audit stores no descriptor plaintext');
end;$$;
rollback;
