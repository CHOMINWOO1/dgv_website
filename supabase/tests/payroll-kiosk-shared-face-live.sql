-- Rollback-only smoke: synthetic descriptors/employee/devices only. No existing
-- row is modified, no trigger is disabled, and no descriptor/secret is printed.
-- The isolated test harness explicitly skips real Vault cipher verification;
-- running on Supabase additionally checks encrypted-at-rest ciphertext.
begin;
set local lock_timeout='5s';set local statement_timeout='30s';
create function pg_temp.shared_face_assert(p_ok boolean,p_message text) returns void language plpgsql as $$
begin if p_ok is distinct from true then raise exception 'FAIL: %',p_message;end if;end;$$;
do $$
declare actor uuid:='00000000-0000-4000-8000-000000000051';emp uuid:=gen_random_uuid();dev uuid:=gen_random_uuid();dev2 uuid:=gen_random_uuid();
  token text:=encode(sha256(convert_to(gen_random_uuid()::text,'UTF8')),'hex');token2 text:=encode(sha256(convert_to(gen_random_uuid()::text,'UTF8')),'hex');
  request uuid:=gen_random_uuid();punch_request uuid:=gen_random_uuid();face jsonb;face2 jsonb;sample jsonb;saved jsonb;replaced jsonb;fetched jsonb;event jsonb;
  old_secret uuid;revision bigint;counts_before jsonb:='{}';counts_after jsonb:='{}';t record;n bigint;vault_before bigint;rejected boolean;
begin
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'app_metadata',jsonb_build_object('role','admin'))::text,true);
  select version into revision from public.payroll_revision where id=1 for update;
  select count(*) into vault_before from vault.secrets;
  for t in select n.nspname,c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('public','private','payroll_kiosk') and c.relkind='r' and c.relname like 'payroll_%' order by 1,2 loop
    execute format('select count(*) from %I.%I',t.nspname,t.relname) into n;
    counts_before:=counts_before||jsonb_build_object(t.nspname||'.'||t.relname,n);
  end loop;
  select jsonb_agg(0.1 order by i) into sample from generate_series(1,128) i;
  face:=jsonb_build_object('version',1,'model','dlib-resnet128-faceapi-1.7.15-tiny68-v1','samples',jsonb_build_array(sample,sample,sample));
  select jsonb_agg(0.11 order by i) into sample from generate_series(1,128) i;
  face2:=face||jsonb_build_object('samples',jsonb_build_array(sample,sample,sample));
  begin
    execute 'set local role authenticated';
    insert into public.payroll_employees(id,device_user_id,name) values(emp,'SHARED-SMOKE-'||emp,'Temporary shared face smoke');
    perform public.payroll_kiosk_register(dev,'Shared-face smoke A',token);
    perform public.payroll_kiosk_register(dev2,'Shared-face smoke B',token2);
    saved:=public.payroll_kiosk_face_save(emp,face,'shared-face-smoke-v1',0,request);
    perform pg_temp.shared_face_assert((saved->>'face_registered')::boolean and (saved->>'face_revision')::bigint>0,'admin stores synthetic central face');
    perform pg_temp.shared_face_assert(public.payroll_kiosk_face_save(emp,face,'shared-face-smoke-v1',0,request)-'replayed'=saved-'replayed','exact stale retry returns same face revision');
    execute 'set local role postgres';
    select secret_id into old_secret from payroll_kiosk.payroll_kiosk_faces where employee_id=emp;
    if current_setting('app.payroll_test_vault_stub',true) is distinct from 'true' then
      perform pg_temp.shared_face_assert((select secret<>face::text and length(secret)>0 from vault.secrets where id=old_secret),'Supabase Vault stores ciphertext, not descriptor JSON');
    end if;
    perform pg_temp.shared_face_assert(not exists(select 1 from public.payroll_audit where after_data::text like '%dlib-resnet128%'),'no descriptor plaintext enters public audit');
    perform set_config('request.jwt.claims','{}',true);execute 'set local role anon';
    fetched:=public.payroll_kiosk_face_get(token2,emp);
    perform pg_temp.shared_face_assert(fetched->'template'=face and fetched->>'face_revision'=saved->>'face_revision','different active device can retrieve same central face without per-device enrollment');
    event:=public.payroll_kiosk_punch(token2,emp,'in',punch_request,(saved->>'face_revision')::bigint);
    perform pg_temp.shared_face_assert(event->>'punch_type'='in' and event->>'verification'='trusted_kiosk_verification','five-argument punch uses central revision');
    rejected:=false;begin perform public.payroll_kiosk_punch(token,emp,'out',gen_random_uuid());exception when others then rejected:=sqlerrm='PAYROLL_KIOSK_FACE_REFRESH_REQUIRED';end;
    perform pg_temp.shared_face_assert(rejected,'old page cannot bypass central revision');
    perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'app_metadata',jsonb_build_object('role','admin'))::text,true);execute 'set local role authenticated';
    replaced:=public.payroll_kiosk_face_save(emp,face2,'shared-face-smoke-v1',(saved->>'face_revision')::bigint,gen_random_uuid());
    execute 'set local role postgres';
    perform pg_temp.shared_face_assert(not exists(select 1 from vault.secrets where id=old_secret),'replacement deletes previous encrypted descriptor');
    select secret_id into old_secret from payroll_kiosk.payroll_kiosk_faces where employee_id=emp;
    execute 'set local role authenticated';
    perform public.payroll_kiosk_revoke(dev2,'Rollback smoke revoked device');
    perform set_config('request.jwt.claims','{}',true);execute 'set local role anon';
    rejected:=false;begin perform public.payroll_kiosk_face_get(token2,emp);exception when insufficient_privilege then rejected:=true;end;
    perform pg_temp.shared_face_assert(rejected,'revoked device cannot decrypt central face');
    rejected:=false;begin perform public.payroll_kiosk_punch(token,emp,'out',gen_random_uuid(),(saved->>'face_revision')::bigint);exception when others then rejected:=sqlerrm='PAYROLL_KIOSK_FACE_REVISION_CHANGED';end;
    perform pg_temp.shared_face_assert(rejected,'stale face cannot create event after replacement');
    perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'app_metadata',jsonb_build_object('role','admin'))::text,true);execute 'set local role authenticated';
    perform public.payroll_kiosk_face_delete(emp,(replaced->>'face_revision')::bigint,'Rollback smoke removal',gen_random_uuid());
    execute 'set local role postgres';
    perform pg_temp.shared_face_assert(not exists(select 1 from vault.secrets where id=old_secret),'deletion removes current encrypted descriptor');
    perform pg_temp.shared_face_assert((select secret_id is null and deleted_at is not null from payroll_kiosk.payroll_kiosk_faces where employee_id=emp),'deletion retains nonbiometric tombstone');
    raise exception using errcode='ZX051',message='ROLLBACK_SHARED_FACE_SMOKE';
  exception when sqlstate 'ZX051' then null;end;
  execute 'set local role postgres';
  for t in select n.nspname,c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('public','private','payroll_kiosk') and c.relkind='r' and c.relname like 'payroll_%' order by 1,2 loop
    execute format('select count(*) from %I.%I',t.nspname,t.relname) into n;
    counts_after:=counts_after||jsonb_build_object(t.nspname||'.'||t.relname,n);
  end loop;
  perform pg_temp.shared_face_assert(counts_before=counts_after and (select count(*)=vault_before from vault.secrets)
    and (select version=revision from public.payroll_revision where id=1),'all original row counts and payroll revision survive rollback');
end;$$;
rollback;
