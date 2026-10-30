-- Share validated descriptors between explicitly registered attendance devices.
-- Photos are never accepted. Vault encrypts the current descriptor; only opaque
-- revision and request metadata remain after replacement or deletion.
begin;

create sequence payroll_kiosk.payroll_kiosk_face_revision_seq;
create table payroll_kiosk.payroll_kiosk_faces (
  employee_id uuid primary key references public.payroll_employees(id),
  revision bigint not null unique check(revision>0),
  secret_id uuid unique,
  consent_version text not null check(length(btrim(consent_version)) between 1 and 100),
  source_kind text not null check(source_kind in ('admin','legacy_migration','deleted')),
  source_device_id uuid references payroll_kiosk.payroll_kiosk_devices(id),
  source_enrollment_id uuid references payroll_kiosk.payroll_kiosk_enrollments(id),
  updated_by uuid not null,
  updated_at timestamptz not null default clock_timestamp(),
  deleted_at timestamptz,
  check((secret_id is not null and deleted_at is null and source_kind<>'deleted') or
    (secret_id is null and deleted_at is not null and source_kind='deleted'))
);
create table payroll_kiosk.payroll_kiosk_face_requests (
  request_id uuid primary key,
  employee_id uuid not null references public.payroll_employees(id),
  device_id uuid references payroll_kiosk.payroll_kiosk_devices(id),
  actor_id uuid not null,
  operation text not null check(operation in ('save','delete','migrate')),
  consent_version text,
  reason text,
  request_hash text not null check(request_hash~'^[0-9a-f]{64}$'),
  face_revision bigint not null check(face_revision>0),
  face_registered boolean not null,
  created_at timestamptz not null default clock_timestamp()
);
create index payroll_kiosk_face_requests_employee_idx on payroll_kiosk.payroll_kiosk_face_requests(employee_id,created_at);
create index payroll_kiosk_faces_source_device_idx on payroll_kiosk.payroll_kiosk_faces(source_device_id) where source_device_id is not null;
create index payroll_kiosk_faces_source_enrollment_idx on payroll_kiosk.payroll_kiosk_faces(source_enrollment_id) where source_enrollment_id is not null;
create index payroll_kiosk_face_requests_device_idx on payroll_kiosk.payroll_kiosk_face_requests(device_id) where device_id is not null;
alter table payroll_kiosk.payroll_kiosk_faces enable row level security;
alter table payroll_kiosk.payroll_kiosk_face_requests enable row level security;
revoke all on payroll_kiosk.payroll_kiosk_faces,payroll_kiosk.payroll_kiosk_face_requests from public,anon,authenticated,service_role,payroll_kiosk_writer;
revoke all on sequence payroll_kiosk.payroll_kiosk_face_revision_seq from public,anon,authenticated,service_role,payroll_kiosk_writer;
grant select(employee_id,revision,deleted_at) on payroll_kiosk.payroll_kiosk_faces to payroll_kiosk_writer;
create policy payroll_kiosk_face_metadata_read on payroll_kiosk.payroll_kiosk_faces for select to payroll_kiosk_writer using(true);
grant select(payee_type,archived_at) on public.payroll_employees to payroll_kiosk_writer;

create function payroll_kiosk.payroll_kiosk_employee_eligible(p_employee_id uuid) returns boolean
language sql stable security invoker set search_path='' as $$
  select exists(select 1 from public.payroll_employees e where e.id=p_employee_id
    and e.active and e.employment_status='active' and e.payee_type='employee' and e.archived_at is null
    and (e.hire_date is null or e.hire_date<=(now() at time zone 'Asia/Ho_Chi_Minh')::date)
    and (e.termination_date is null or e.termination_date>=(now() at time zone 'Asia/Ho_Chi_Minh')::date));
$$;

create function payroll_kiosk.payroll_kiosk_validate_template(p_template jsonb) returns void
language plpgsql immutable security invoker set search_path='' as $$
declare sample jsonb;component jsonb;norm numeric;distance numeric;i integer;j integer;capture_time timestamptz;
begin
  if p_template is null or jsonb_typeof(p_template) is distinct from 'object' or octet_length(p_template::text)>32768
    or p_template->'version' is distinct from '1'::jsonb
    or p_template->>'model' is distinct from 'dlib-resnet128-faceapi-1.7.15-tiny68-v1'
    or jsonb_typeof(p_template->'samples') is distinct from 'array' then raise exception 'PAYROLL_KIOSK_INVALID_FACE_TEMPLATE';end if;
  if exists(select 1 from jsonb_object_keys(p_template) k where k not in ('version','model','samples','createdAt'))
    or jsonb_array_length(p_template->'samples')<>3 then raise exception 'PAYROLL_KIOSK_INVALID_FACE_TEMPLATE';end if;
  if p_template ? 'createdAt' then
    if jsonb_typeof(p_template->'createdAt') is distinct from 'string' or length(p_template->>'createdAt') not between 20 and 40
      or p_template->>'createdAt'!~'^\d{4}-\d{2}-\d{2}T' then raise exception 'PAYROLL_KIOSK_INVALID_FACE_TEMPLATE';end if;
    begin capture_time:=(p_template->>'createdAt')::timestamptz;
    exception when others then raise exception 'PAYROLL_KIOSK_INVALID_FACE_TEMPLATE';end;
    if not isfinite(capture_time) then raise exception 'PAYROLL_KIOSK_INVALID_FACE_TEMPLATE';end if;
  end if;
  for sample in select value from jsonb_array_elements(p_template->'samples') loop
    if jsonb_typeof(sample) is distinct from 'array' then raise exception 'PAYROLL_KIOSK_INVALID_FACE_TEMPLATE';end if;
    if jsonb_array_length(sample)<>128 then raise exception 'PAYROLL_KIOSK_INVALID_FACE_TEMPLATE';end if;
    norm:=0;
    for component in select value from jsonb_array_elements(sample) loop
      if jsonb_typeof(component) is distinct from 'number' then raise exception 'PAYROLL_KIOSK_INVALID_FACE_TEMPLATE';end if;
      if abs((component#>>'{}')::numeric)>5 then raise exception 'PAYROLL_KIOSK_INVALID_FACE_TEMPLATE';end if;
      norm:=norm+((component#>>'{}')::numeric)^2;
    end loop;
    if norm<0.01 or norm>25 then raise exception 'PAYROLL_KIOSK_INVALID_FACE_TEMPLATE';end if;
  end loop;
  for i in 0..1 loop for j in i+1..2 loop
    select sum(((p_template->'samples'->i->>k)::numeric-(p_template->'samples'->j->>k)::numeric)^2)
      into distance from generate_series(0,127) k;
    if distance>0.25 then raise exception 'PAYROLL_KIOSK_INVALID_FACE_TEMPLATE';end if;
  end loop;end loop;
end;$$;

-- Internal helper, never granted to API roles or the kiosk writer. Its callers
-- establish administrator authority or a matching legacy device enrollment.
create function payroll_kiosk.payroll_kiosk_face_write(p_operation text,p_employee_id uuid,p_template jsonb,
  p_consent_version text,p_expected_revision bigint,p_request_id uuid,p_actor_id uuid,
  p_device_id uuid,p_enrollment_id uuid,p_reason text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare current_face payroll_kiosk.payroll_kiosk_faces%rowtype;prior_request payroll_kiosk.payroll_kiosk_face_requests%rowtype;
  fingerprint text;new_secret uuid;new_revision bigint;v_consent text;v_registered boolean;
begin
  if p_request_id is null or p_employee_id is null or p_actor_id is null or p_expected_revision is null or p_expected_revision<0
    or p_operation not in ('save','delete','migrate') then raise exception 'PAYROLL_KIOSK_INVALID_FACE_REQUEST';end if;
  if p_operation<>'delete' then
    perform payroll_kiosk.payroll_kiosk_validate_template(p_template);
    if p_consent_version is null or length(btrim(p_consent_version)) not between 1 and 100 or p_consent_version~'[[:cntrl:]]' then raise exception 'PAYROLL_KIOSK_CONSENT_REQUIRED';end if;
  elsif p_reason is null or length(btrim(p_reason)) not between 1 and 1000 then raise exception 'PAYROLL_KIOSK_REASON_REQUIRED';end if;
  fingerprint:=encode(sha256(convert_to(jsonb_build_object('operation',p_operation,'employee',p_employee_id,'template',p_template,
    'consent',p_consent_version,'expected_revision',p_expected_revision,'actor',p_actor_id,'device',p_device_id,
    'enrollment',p_enrollment_id,'reason',p_reason)::text,'UTF8')),'hex');
  perform version from public.payroll_revision where id=1 for update;
  if not found then raise exception 'PAYROLL_REVISION_MISSING';end if;
  select * into prior_request from payroll_kiosk.payroll_kiosk_face_requests where request_id=p_request_id;
  if found then
    if prior_request.request_hash is distinct from fingerprint then raise exception 'PAYROLL_KIOSK_FACE_REQUEST_CONFLICT';end if;
    return jsonb_build_object('employee_id',prior_request.employee_id,'face_revision',prior_request.face_revision,
      'face_registered',prior_request.face_registered,'replayed',true);
  end if;
  select * into current_face from payroll_kiosk.payroll_kiosk_faces where employee_id=p_employee_id;
  if p_operation='migrate' and found then raise exception 'PAYROLL_KIOSK_FACE_EXISTS';end if;
  if coalesce(current_face.revision,0)<>p_expected_revision then raise exception 'PAYROLL_KIOSK_FACE_REVISION_CHANGED';end if;
  v_registered:=p_operation<>'delete';
  if v_registered and not payroll_kiosk.payroll_kiosk_employee_eligible(p_employee_id) then raise exception 'PAYROLL_KIOSK_EMPLOYEE_NOT_ACTIVE';end if;
  if not exists(select 1 from public.payroll_employees where id=p_employee_id and payee_type='employee') then raise exception 'PAYROLL_EMPLOYEE_NOT_FOUND';end if;
  if v_registered then
    new_secret:=vault.create_secret(p_template::text,'payroll-face:'||p_employee_id::text||':'||gen_random_uuid()::text,'Encrypted current attendance descriptor; no photograph');
    v_consent:=btrim(p_consent_version);
  else v_consent:=coalesce(current_face.consent_version,'central-face-deletion');end if;
  new_revision:=nextval('payroll_kiosk.payroll_kiosk_face_revision_seq');
  insert into payroll_kiosk.payroll_kiosk_faces(employee_id,revision,secret_id,consent_version,source_kind,
    source_device_id,source_enrollment_id,updated_by,deleted_at)
    values(p_employee_id,new_revision,new_secret,v_consent,case p_operation when 'delete' then 'deleted' when 'migrate' then 'legacy_migration' else 'admin' end,
      p_device_id,p_enrollment_id,p_actor_id,case when v_registered then null else clock_timestamp() end)
    on conflict(employee_id) do update set revision=excluded.revision,secret_id=excluded.secret_id,consent_version=excluded.consent_version,
      source_kind=excluded.source_kind,source_device_id=excluded.source_device_id,source_enrollment_id=excluded.source_enrollment_id,
      updated_by=excluded.updated_by,updated_at=clock_timestamp(),deleted_at=excluded.deleted_at;
  -- Keep one current encrypted descriptor, not a history of biometric values.
  if current_face.secret_id is not null then delete from vault.secrets where id=current_face.secret_id;end if;
  insert into payroll_kiosk.payroll_kiosk_face_requests(request_id,employee_id,device_id,actor_id,operation,consent_version,reason,request_hash,face_revision,face_registered)
    values(p_request_id,p_employee_id,p_device_id,p_actor_id,p_operation,v_consent,case when p_operation='delete' then btrim(p_reason) else null end,fingerprint,new_revision,v_registered);
  return jsonb_build_object('employee_id',p_employee_id,'face_revision',new_revision,'face_registered',v_registered,'replayed',false);
end;$$;

create function payroll_kiosk.payroll_kiosk_face_save(p_employee_id uuid,p_template jsonb,p_consent_version text,
  p_expected_revision bigint,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$begin
  perform public.payroll_assert_admin();
  return payroll_kiosk.payroll_kiosk_face_write('save',p_employee_id,p_template,p_consent_version,p_expected_revision,p_request_id,auth.uid(),null,null,null);
end;$$;
create function payroll_kiosk.payroll_kiosk_face_delete(p_employee_id uuid,p_expected_revision bigint,p_reason text,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$begin
  perform public.payroll_assert_admin();
  return payroll_kiosk.payroll_kiosk_face_write('delete',p_employee_id,null,null,p_expected_revision,p_request_id,auth.uid(),null,null,p_reason);
end;$$;
create function payroll_kiosk.payroll_kiosk_face_migrate(p_token text,p_employee_id uuid,p_enrollment_id uuid,p_template jsonb,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare d payroll_kiosk.payroll_kiosk_devices%rowtype;g payroll_kiosk.payroll_kiosk_enrollments%rowtype;
begin
  d:=payroll_kiosk.payroll_kiosk_require(p_token);
  perform version from public.payroll_revision where id=1 for update;
  d:=payroll_kiosk.payroll_kiosk_require(p_token);
  select * into g from payroll_kiosk.payroll_kiosk_enrollments where id=p_enrollment_id
    and device_id=d.id and employee_id=p_employee_id and revoked_at is null;
  if not found then raise exception 'PAYROLL_KIOSK_EMPLOYEE_NOT_ENROLLED';end if;
  if not payroll_kiosk.payroll_kiosk_employee_eligible(p_employee_id) then raise exception 'PAYROLL_KIOSK_EMPLOYEE_NOT_ACTIVE';end if;
  return payroll_kiosk.payroll_kiosk_face_write('migrate',p_employee_id,p_template,g.consent_version,0,p_request_id,d.created_by,d.id,g.id,null);
end;$$;
create function payroll_kiosk.payroll_kiosk_face_get(p_token text,p_employee_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare d payroll_kiosk.payroll_kiosk_devices%rowtype;f payroll_kiosk.payroll_kiosk_faces%rowtype;v_template jsonb;
begin
  d:=payroll_kiosk.payroll_kiosk_require(p_token);
  perform version from public.payroll_revision where id=1 for share;
  d:=payroll_kiosk.payroll_kiosk_require(p_token);
  if p_employee_id is null or not payroll_kiosk.payroll_kiosk_employee_eligible(p_employee_id) then raise exception 'PAYROLL_KIOSK_EMPLOYEE_NOT_ACTIVE';end if;
  select * into f from payroll_kiosk.payroll_kiosk_faces where employee_id=p_employee_id and deleted_at is null;
  if not found then return null;end if;
  select decrypted_secret::jsonb into v_template from vault.decrypted_secrets where id=f.secret_id;
  if v_template is null then raise exception 'PAYROLL_KIOSK_FACE_DATA_UNAVAILABLE';end if;
  return jsonb_build_object('employee_id',p_employee_id,'face_revision',f.revision,'template',v_template);
end;$$;

create or replace function payroll_kiosk.payroll_kiosk_roster(p_token text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare d payroll_kiosk.payroll_kiosk_devices%rowtype;v_employees jsonb;
begin
  d:=payroll_kiosk.payroll_kiosk_require(p_token);
  select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'device_user_id',e.device_user_id,'name',e.name,'enrollment_id',g.id,
    'has_legacy_enrollment',exists(select 1 from payroll_kiosk.payroll_kiosk_enrollments l where l.employee_id=e.id and l.revoked_at is null),
    'face_registered',f.revision is not null and f.deleted_at is null,'face_revision',coalesce(f.revision,0),
    'last_punch',(select jsonb_build_object('punch_type',r.punch_type,'occurred_at',r.occurred_at) from public.payroll_attendance_raw r
      where r.employee_id=e.id and r.punch_type is not null order by r.occurred_at desc,r.id desc limit 1)) order by e.name,e.id),'[]'::jsonb)
    into v_employees from public.payroll_employees e
    left join payroll_kiosk.payroll_kiosk_enrollments g on g.employee_id=e.id and g.device_id=d.id and g.revoked_at is null
    left join payroll_kiosk.payroll_kiosk_faces f on f.employee_id=e.id
    where payroll_kiosk.payroll_kiosk_employee_eligible(e.id);
  return jsonb_build_object('device_id',d.id,'name',d.name,'employees',v_employees);
end;$$;

create or replace function payroll_kiosk.payroll_kiosk_enroll(p_device_id uuid,p_employee_id uuid,p_consent_version text) returns uuid
language plpgsql security definer set search_path='' as $$declare v_id uuid;begin
  perform public.payroll_assert_admin();
  if p_consent_version is null or length(btrim(p_consent_version)) not between 1 and 100 or p_consent_version~'[[:cntrl:]]' then raise exception 'PAYROLL_KIOSK_CONSENT_REQUIRED';end if;
  perform version from public.payroll_revision where id=1 for update;
  if not exists(select 1 from payroll_kiosk.payroll_kiosk_devices where id=p_device_id and revoked_at is null) then raise exception 'PAYROLL_KIOSK_DEVICE_NOT_ACTIVE';end if;
  if not payroll_kiosk.payroll_kiosk_employee_eligible(p_employee_id) then raise exception 'PAYROLL_KIOSK_EMPLOYEE_NOT_ACTIVE';end if;
  select id into v_id from payroll_kiosk.payroll_kiosk_enrollments where device_id=p_device_id and employee_id=p_employee_id and revoked_at is null;
  if found then return v_id;end if;
  insert into payroll_kiosk.payroll_kiosk_enrollments(device_id,employee_id,consent_version,created_by)
    values(p_device_id,p_employee_id,btrim(p_consent_version),auth.uid()) returning id into v_id;
  insert into payroll_kiosk.payroll_kiosk_admin_audit(device_id,employee_id,action,detail,created_by)
    values(p_device_id,p_employee_id,'enroll',jsonb_build_object('grant_id',v_id,'consent_version',btrim(p_consent_version)),auth.uid());
  return v_id;
end;$$;

-- Both entrypoints share one serialized event path. Old pages work only until a
-- central record first exists; thereafter they must refresh into revision checks.
create function payroll_kiosk.payroll_kiosk_punch_checked(p_token text,p_employee_id uuid,p_kind text,p_request_id uuid,
  p_face_revision bigint,p_central boolean) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare d payroll_kiosk.payroll_kiosk_devices%rowtype;r public.payroll_attendance_raw%rowtype;prior public.payroll_attendance_raw%rowtype;
  v_now timestamptz;v_local timestamp;v_face_revision bigint;v_deleted_at timestamptz;
begin
  d:=payroll_kiosk.payroll_kiosk_require(p_token);
  if p_request_id is null or p_employee_id is null or p_kind is null or p_kind not in ('in','out') then raise exception 'PAYROLL_KIOSK_INVALID_PUNCH';end if;
  perform version from public.payroll_revision where id=1 for update;
  d:=payroll_kiosk.payroll_kiosk_require(p_token);
  select * into r from public.payroll_attendance_raw where kiosk_request_id=p_request_id;
  if found then
    if r.kiosk_device_id<>d.id or r.employee_id<>p_employee_id or r.punch_type<>p_kind then raise exception 'PAYROLL_KIOSK_REQUEST_CONFLICT';end if;
    return payroll_kiosk.payroll_kiosk_event_json(r,true);
  end if;
  if not payroll_kiosk.payroll_kiosk_employee_eligible(p_employee_id) then raise exception 'PAYROLL_KIOSK_EMPLOYEE_NOT_ACTIVE';end if;
  select revision,deleted_at into v_face_revision,v_deleted_at from payroll_kiosk.payroll_kiosk_faces where employee_id=p_employee_id;
  if p_central then
    if v_face_revision is null or v_deleted_at is not null then raise exception 'PAYROLL_KIOSK_FACE_NOT_REGISTERED';end if;
    if p_face_revision is null or p_face_revision<>v_face_revision then raise exception 'PAYROLL_KIOSK_FACE_REVISION_CHANGED';end if;
  else
    if v_face_revision is not null then raise exception 'PAYROLL_KIOSK_FACE_REFRESH_REQUIRED';end if;
    if not exists(select 1 from payroll_kiosk.payroll_kiosk_enrollments where device_id=d.id and employee_id=p_employee_id and revoked_at is null) then raise exception 'PAYROLL_KIOSK_EMPLOYEE_NOT_ENROLLED';end if;
  end if;
  v_now:=clock_timestamp();v_local:=v_now at time zone 'Asia/Ho_Chi_Minh';
  select * into prior from public.payroll_attendance_raw where employee_id=p_employee_id and punch_type is not null order by occurred_at desc,id desc limit 1;
  if not found then
    if p_kind='out' then raise exception 'PAYROLL_KIOSK_CHECK_IN_REQUIRED';end if;
  else
    if prior.punch_type=p_kind then raise exception 'PAYROLL_KIOSK_SAME_DIRECTION';end if;
    if prior.occurred_at>v_local-interval '30 seconds' then raise exception 'PAYROLL_KIOSK_COOLDOWN';end if;
  end if;
  insert into public.payroll_attendance_raw(employee_id,occurred_at,device_id,import_id,source,punch_type,kiosk_device_id,kiosk_request_id,created_by,created_at)
    values(p_employee_id,v_local,'kiosk:'||d.id::text,null,'kiosk',p_kind,d.id,p_request_id,d.created_by,v_now) returning * into r;
  return payroll_kiosk.payroll_kiosk_event_json(r,false);
end;$$;
create or replace function payroll_kiosk.payroll_kiosk_punch(p_token text,p_employee_id uuid,p_kind text,p_request_id uuid) returns jsonb
language sql security definer set search_path='' as $$
  select payroll_kiosk.payroll_kiosk_punch_checked(p_token,p_employee_id,p_kind,p_request_id,null,false);
$$;
create function payroll_kiosk.payroll_kiosk_punch(p_token text,p_employee_id uuid,p_kind text,p_request_id uuid,p_face_revision bigint) returns jsonb
language sql security definer set search_path='' as $$
  select payroll_kiosk.payroll_kiosk_punch_checked(p_token,p_employee_id,p_kind,p_request_id,p_face_revision,true);
$$;
grant create on schema payroll_kiosk to payroll_kiosk_writer;
alter function payroll_kiosk.payroll_kiosk_punch(text,uuid,text,uuid,bigint) owner to payroll_kiosk_writer;
revoke create on schema payroll_kiosk from payroll_kiosk_writer;

create function public.payroll_kiosk_face_save(p_employee_id uuid,p_template jsonb,p_consent_version text,p_expected_revision bigint,p_request_id uuid) returns jsonb
language sql security invoker set search_path='' as $$select payroll_kiosk.payroll_kiosk_face_save(p_employee_id,p_template,p_consent_version,p_expected_revision,p_request_id);$$;
create function public.payroll_kiosk_face_delete(p_employee_id uuid,p_expected_revision bigint,p_reason text,p_request_id uuid) returns jsonb
language sql security invoker set search_path='' as $$select payroll_kiosk.payroll_kiosk_face_delete(p_employee_id,p_expected_revision,p_reason,p_request_id);$$;
create function public.payroll_kiosk_face_migrate(p_token text,p_employee_id uuid,p_enrollment_id uuid,p_template jsonb,p_request_id uuid) returns jsonb
language sql security invoker set search_path='' as $$select payroll_kiosk.payroll_kiosk_face_migrate(p_token,p_employee_id,p_enrollment_id,p_template,p_request_id);$$;
create function public.payroll_kiosk_face_get(p_token text,p_employee_id uuid) returns jsonb
language sql security invoker set search_path='' as $$select payroll_kiosk.payroll_kiosk_face_get(p_token,p_employee_id);$$;
create function public.payroll_kiosk_punch(p_token text,p_employee_id uuid,p_kind text,p_request_id uuid,p_face_revision bigint) returns jsonb
language sql security invoker set search_path='' as $$select payroll_kiosk.payroll_kiosk_punch(p_token,p_employee_id,p_kind,p_request_id,p_face_revision);$$;

do $$declare f record;begin
  for f in select p.oid::regprocedure as signature,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','payroll_kiosk') and (p.proname like 'payroll_kiosk_face_%'
      or p.proname in ('payroll_kiosk_employee_eligible','payroll_kiosk_validate_template','payroll_kiosk_punch_checked')
      or (p.proname='payroll_kiosk_punch' and p.pronargs=5)) loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role,payroll_kiosk_writer',f.signature);
    if f.proname in ('payroll_kiosk_face_save','payroll_kiosk_face_delete') then
      execute format('grant execute on function %s to authenticated',f.signature);
    elsif f.proname in ('payroll_kiosk_face_get','payroll_kiosk_face_migrate','payroll_kiosk_punch') then
      execute format('grant execute on function %s to anon,authenticated',f.signature);
    elsif f.proname in ('payroll_kiosk_employee_eligible','payroll_kiosk_punch_checked') then
      execute format('grant execute on function %s to payroll_kiosk_writer',f.signature);
    end if;
  end loop;
end;$$;
comment on table payroll_kiosk.payroll_kiosk_faces is 'One current Vault-encrypted face descriptor per employee. No photos. Tombstones prevent legacy automatic reimport after deletion. Excluded from payroll backup/export.';
comment on table payroll_kiosk.payroll_kiosk_face_requests is 'Mutation retry receipts only: no descriptors, photographs or decrypted Vault values. Device migration is a trusted legacy-device assertion, not server biometric proof.';
notify pgrst,'reload schema';
commit;
