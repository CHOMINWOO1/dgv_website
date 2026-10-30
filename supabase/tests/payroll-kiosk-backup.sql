-- Isolated empty-database integration only. This never clears existing rows.
begin;
create function pg_temp.kiosk_backup_assert(p_ok boolean,p_message text) returns void language plpgsql as $$
begin if p_ok is distinct from true then raise exception 'FAIL: %',p_message;end if;end;$$;
do $$
declare actor uuid:='00000000-0000-4000-8000-000000000011';dev uuid:=gen_random_uuid();emp uuid:=gen_random_uuid();
  token text:=encode(sha256(convert_to(gen_random_uuid()::text,'UTF8')),'hex');request uuid:=gen_random_uuid();
  payload jsonb;old_payload jsonb;event jsonb;rejected boolean;face jsonb;sample jsonb;face_saved jsonb;
begin
  perform pg_temp.kiosk_backup_assert(not exists(select 1 from public.payroll_employees),'kiosk backup test requires empty payroll DB');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'app_metadata',jsonb_build_object('role','admin'))::text,true);
  execute 'set local role authenticated';
  begin
    insert into public.payroll_employees(id,device_user_id,name) values(emp,'BACKUP-KIOSK-'||emp,'Typed archive fixture');
    perform public.payroll_kiosk_register(dev,'Archive tablet',token);
    perform public.payroll_kiosk_enroll(dev,emp,'v1');
    select jsonb_agg(0.1 order by i) into sample from generate_series(1,128) i;
    face:=jsonb_build_object('version',1,'model','dlib-resnet128-faceapi-1.7.15-tiny68-v1','samples',jsonb_build_array(sample,sample,sample));
    face_saved:=public.payroll_kiosk_face_save(emp,face,'central-backup-fixture',0,gen_random_uuid());
    event:=public.payroll_kiosk_punch(token,emp,'in',request,(face_saved->>'face_revision')::bigint);
    payload:=public.payroll_backup();
    perform pg_temp.kiosk_backup_assert(payload->'tables'->'payroll_attendance_raw'->0->>'punch_type'='in'
      and payload->'tables'->'payroll_attendance_raw'->0->>'kiosk_request_id'=request::text,'backup preserves typed attendance and idempotency provenance');
    perform pg_temp.kiosk_backup_assert(not (payload->'tables' ? 'payroll_kiosk_devices') and position(token in payload::text)=0
      and position(encode(sha256(convert_to(token,'UTF8')),'hex') in payload::text)=0,'backup excludes device tokens and token hashes');
    perform pg_temp.kiosk_backup_assert(not(payload->'tables' ? 'payroll_kiosk_faces') and position('dlib-resnet128' in payload::text)=0,
      'payroll backup excludes central descriptor and Vault references');
    raise exception using errcode='ZX009',message='ROLLBACK_KIOSK_BACKUP_FIXTURE';
  exception when sqlstate 'ZX009' then null;end;
  begin
    perform public.payroll_restore(payload);
    perform pg_temp.kiosk_backup_assert((select source='kiosk' and punch_type='in' and import_id is null and kiosk_device_id=dev
      and occurred_at=(event->>'occurred_at')::timestamp from public.payroll_attendance_raw where kiosk_request_id=request),'typed source restored exactly without live device credential');
    rejected:=false;begin perform public.payroll_kiosk_roster(token);exception when insufficient_privilege then rejected:=true;end;
    perform pg_temp.kiosk_backup_assert(rejected,'restored history does not reactivate old tablet credential');
    execute 'set local role postgres';
    perform pg_temp.kiosk_backup_assert(not exists(select 1 from payroll_kiosk.payroll_kiosk_faces where employee_id=emp)
      and not exists(select 1 from payroll_kiosk.payroll_kiosk_face_requests where employee_id=emp),
      'restoring payroll employee/history does not create face authorization or dangling Vault references');
    execute 'set local role authenticated';
    raise exception using errcode='ZX010',message='ROLLBACK_KIOSK_RESTORE';
  exception when sqlstate 'ZX010' then null;end;
  begin
    perform public.payroll_import('legacy-archive.xlsx',jsonb_build_array(jsonb_build_object('device_user_id','LEGACY-KIOSK-'||emp,
      'name','Legacy POS fixture','device_id','1','occurred_at','2091-01-01T10:00:00')));
    old_payload:=public.payroll_backup();
    old_payload:=jsonb_set(old_payload,'{tables,payroll_attendance_raw}',(select jsonb_agg(value-array['source','punch_type','kiosk_device_id','kiosk_request_id'])
      from jsonb_array_elements(old_payload->'tables'->'payroll_attendance_raw')));
    raise exception using errcode='ZX011',message='ROLLBACK_LEGACY_KIOSK_FIXTURE';
  exception when sqlstate 'ZX011' then null;end;
  perform public.payroll_restore(old_payload);
  perform pg_temp.kiosk_backup_assert((select source='excel' and punch_type is null and kiosk_device_id is null and kiosk_request_id is null
    and import_id is not null from public.payroll_attendance_raw),'pre-kiosk v2 archives default only missing fields to Excel provenance');
end;$$;
rollback;
