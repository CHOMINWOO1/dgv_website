-- Online kiosk capability: local face verification is asserted by an enrolled
-- device, not verified biometric identity on this server. No face data is stored.
-- Existing POS events, employee details and finalized payroll are preserved.
begin;

create schema payroll_kiosk;
revoke all on schema payroll_kiosk from public,anon,authenticated;
create role payroll_kiosk_writer nologin noinherit nobypassrls;
-- Only the migration owner may maintain the isolated function owner. API roles
-- and authenticator never receive membership or SET ROLE capability.
grant payroll_kiosk_writer to postgres;
grant usage on schema public,payroll_kiosk to payroll_kiosk_writer;
grant usage on schema payroll_kiosk to anon,authenticated;

create table payroll_kiosk.payroll_kiosk_devices (
  id uuid primary key,
  name text not null check(length(btrim(name)) between 1 and 100 and name=btrim(name) and name!~'[[:cntrl:]]'),
  token_hash text not null unique check(token_hash~'^[0-9a-f]{64}$'),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  revoked_by uuid,
  revoked_at timestamptz,
  revoke_reason text,
  check((revoked_at is null and revoked_by is null and revoke_reason is null) or
    (revoked_at is not null and revoked_by is not null and length(btrim(revoke_reason)) between 1 and 1000))
);
create table payroll_kiosk.payroll_kiosk_enrollments (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references payroll_kiosk.payroll_kiosk_devices(id),
  employee_id uuid not null references public.payroll_employees(id),
  consent_version text not null check(length(btrim(consent_version)) between 1 and 100 and consent_version!~'[[:cntrl:]]'),
  created_by uuid not null,
  consented_at timestamptz not null default now(),
  revoked_by uuid,
  revoked_at timestamptz,
  revoke_reason text,
  check((revoked_at is null and revoked_by is null and revoke_reason is null) or
    (revoked_at is not null and revoked_by is not null and length(btrim(revoke_reason)) between 1 and 1000))
);
create unique index payroll_kiosk_active_enrollment_idx on payroll_kiosk.payroll_kiosk_enrollments(device_id,employee_id) where revoked_at is null;
create index payroll_kiosk_enrollment_employee_idx on payroll_kiosk.payroll_kiosk_enrollments(employee_id);
create table payroll_kiosk.payroll_kiosk_admin_audit (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references payroll_kiosk.payroll_kiosk_devices(id),
  employee_id uuid references public.payroll_employees(id),
  action text not null check(action in ('register','revoke','enroll','unenroll')),
  detail jsonb not null check(jsonb_typeof(detail)='object'),
  created_by uuid not null,
  created_at timestamptz not null default now()
);
create index payroll_kiosk_admin_audit_device_idx on payroll_kiosk.payroll_kiosk_admin_audit(device_id,created_at);
create index payroll_kiosk_admin_audit_employee_idx on payroll_kiosk.payroll_kiosk_admin_audit(employee_id) where employee_id is not null;
alter table payroll_kiosk.payroll_kiosk_devices enable row level security;
alter table payroll_kiosk.payroll_kiosk_enrollments enable row level security;
alter table payroll_kiosk.payroll_kiosk_admin_audit enable row level security;
revoke all on payroll_kiosk.payroll_kiosk_devices,payroll_kiosk.payroll_kiosk_enrollments,payroll_kiosk.payroll_kiosk_admin_audit from public,anon,authenticated;
grant select on payroll_kiosk.payroll_kiosk_devices,payroll_kiosk.payroll_kiosk_enrollments to payroll_kiosk_writer;
create policy payroll_kiosk_device_capability_read on payroll_kiosk.payroll_kiosk_devices for select to payroll_kiosk_writer using(true);
create policy payroll_kiosk_enrollment_capability_read on payroll_kiosk.payroll_kiosk_enrollments for select to payroll_kiosk_writer using(true);

alter table public.payroll_attendance_raw
  alter column import_id drop not null,
  add column source text not null default 'excel',
  add column punch_type text,
  add column kiosk_device_id uuid,
  add column kiosk_request_id uuid,
  add constraint payroll_attendance_source_check check(
    (source='excel' and import_id is not null and punch_type is null and kiosk_device_id is null and kiosk_request_id is null) or
    (source='kiosk' and import_id is null and punch_type in ('in','out') and punch_type is not null
      and kiosk_device_id is not null and kiosk_request_id is not null and device_id='kiosk:'||kiosk_device_id::text)),
  add constraint payroll_attendance_kiosk_request_key unique(kiosk_request_id);
-- No device FK on historical raw rows: encrypted payroll restoration preserves
-- attendance even when credentials are intentionally not restored.
create index payroll_attendance_typed_employee_idx on public.payroll_attendance_raw(employee_id,occurred_at desc,id desc) where punch_type is not null;
create index payroll_attendance_kiosk_idx on public.payroll_attendance_raw(kiosk_device_id) where kiosk_device_id is not null;

grant select(id,device_user_id,name,active,employment_status,hire_date,termination_date) on public.payroll_employees to payroll_kiosk_writer;
create policy payroll_employee_kiosk_minimal_read on public.payroll_employees for select to payroll_kiosk_writer using(true);
grant select,insert on public.payroll_attendance_raw to payroll_kiosk_writer;
create policy payroll_attendance_kiosk_read on public.payroll_attendance_raw for select to payroll_kiosk_writer using(punch_type is not null);
create policy payroll_attendance_kiosk_insert on public.payroll_attendance_raw for insert to payroll_kiosk_writer with check(source='kiosk');
grant select,update on public.payroll_revision to payroll_kiosk_writer;
create policy payroll_revision_kiosk_read on public.payroll_revision for select to payroll_kiosk_writer using(id=1);
create policy payroll_revision_kiosk_update on public.payroll_revision for update to payroll_kiosk_writer using(id=1) with check(id=1);
grant insert on public.payroll_audit to payroll_kiosk_writer;
create policy payroll_audit_kiosk_insert on public.payroll_audit for insert to payroll_kiosk_writer with check(table_name='payroll_attendance_raw' and action='INSERT' and after_data->>'source'='kiosk');

-- A dedicated raw trigger admits this one NOLOGIN function owner. It does not
-- widen the administrator gate used by any employee, salary or payment table.
create function payroll_kiosk.payroll_kiosk_raw_serialize() returns trigger
language plpgsql security invoker set search_path='' as $$begin
  if current_user<>'payroll_kiosk_writer' then perform public.payroll_assert_admin();
  elsif tg_op<>'INSERT' then raise exception 'PAYROLL_IMMUTABLE_RECORD';end if;
  perform version from public.payroll_revision where id=1 for update;
  if not found then raise exception 'PAYROLL_REVISION_MISSING';end if;
  return null;
end;$$;
create function payroll_kiosk.payroll_kiosk_raw_guard() returns trigger
language plpgsql security invoker set search_path='' as $$begin
  if tg_op<>'INSERT' then raise exception 'PAYROLL_IMMUTABLE_RECORD';end if;
  if current_user='payroll_kiosk_writer' then
    if new.source is distinct from 'kiosk' or new.import_id is not null
      or not exists(select 1 from payroll_kiosk.payroll_kiosk_devices d where d.id=new.kiosk_device_id
        and d.revoked_at is null and d.created_by=new.created_by)
      or new.occurred_at<(clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')-interval '5 seconds'
      or new.occurred_at>(clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')+interval '1 second' then
      raise exception 'PAYROLL_KIOSK_INVALID_SERVER_EVENT';end if;
    new.created_at:=clock_timestamp();
  else
    perform public.payroll_assert_admin();
    if new.source is distinct from 'excel' then raise exception 'PAYROLL_KIOSK_RPC_REQUIRED';end if;
    new.created_by:=auth.uid();new.created_at:=now();
  end if;
  return new;
end;$$;
create function payroll_kiosk.payroll_kiosk_raw_audit() returns trigger
language plpgsql security invoker set search_path='' as $$begin
  insert into public.payroll_audit(table_name,record_id,action,before_data,after_data,created_by)
    values('payroll_attendance_raw',new.id,'INSERT',null,to_jsonb(new),new.created_by);
  update public.payroll_revision set version=version+1 where id=1;
  return new;
end;$$;
drop trigger payroll_serialize on public.payroll_attendance_raw;
drop trigger payroll_guard on public.payroll_attendance_raw;
drop trigger payroll_audit on public.payroll_attendance_raw;
create trigger payroll_serialize before insert or update or delete on public.payroll_attendance_raw for each statement execute function payroll_kiosk.payroll_kiosk_raw_serialize();
create trigger payroll_guard before insert or update or delete on public.payroll_attendance_raw for each row execute function payroll_kiosk.payroll_kiosk_raw_guard();
create trigger payroll_audit after insert on public.payroll_attendance_raw for each row execute function payroll_kiosk.payroll_kiosk_raw_audit();
create or replace function public.payroll_guard_internal() returns trigger
language plpgsql security invoker set search_path='' as $$begin
  if current_user<>'payroll_kiosk_writer' then perform public.payroll_assert_admin();end if;
  if pg_trigger_depth()<2 then raise exception 'PAYROLL_INTERNAL_RECORD';end if;
  if tg_table_name='payroll_revision' then
    if tg_op<>'UPDATE' or new.id<>old.id or new.version<>old.version+1 then raise exception 'PAYROLL_INVALID_REVISION';end if;
  elsif tg_op<>'INSERT' then raise exception 'PAYROLL_IMMUTABLE_AUDIT';
  elsif current_user='payroll_kiosk_writer' and (new.table_name is distinct from 'payroll_attendance_raw'
    or new.action is distinct from 'INSERT' or new.after_data->>'source' is distinct from 'kiosk'
    or new.created_by::text is distinct from new.after_data->>'created_by') then
    raise exception 'PAYROLL_KIOSK_INVALID_AUDIT';
  end if;
  return new;
end;$$;

-- Administrator management functions keep credentials and their hashes private.
create function payroll_kiosk.payroll_kiosk_register(p_device_id uuid,p_name text,p_token text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare d payroll_kiosk.payroll_kiosk_devices%rowtype;v_hash text;
begin
  perform public.payroll_assert_admin();
  if p_device_id is null or p_name is null or length(btrim(p_name)) not between 1 and 100 or p_name~'[[:cntrl:]]'
    or p_token is null or p_token!~'^[0-9a-f]{64}$' then raise exception 'PAYROLL_KIOSK_INVALID_DEVICE';end if;
  v_hash:=encode(sha256(convert_to(p_token,'UTF8')),'hex');
  perform version from public.payroll_revision where id=1 for update;
  select * into d from payroll_kiosk.payroll_kiosk_devices where id=p_device_id;
  if found then
    if d.name<>btrim(p_name) or d.token_hash<>v_hash or d.revoked_at is not null then raise exception 'PAYROLL_KIOSK_DEVICE_CONFLICT';end if;
  else
    insert into payroll_kiosk.payroll_kiosk_devices(id,name,token_hash,created_by) values(p_device_id,btrim(p_name),v_hash,auth.uid()) returning * into d;
    insert into payroll_kiosk.payroll_kiosk_admin_audit(device_id,action,detail,created_by) values(d.id,'register',jsonb_build_object('name',d.name),auth.uid());
  end if;
  return jsonb_build_object('device_id',d.id,'name',d.name,'status','active');
end;$$;
create function payroll_kiosk.payroll_kiosk_devices() returns jsonb
language plpgsql security definer set search_path='' as $$begin
  perform public.payroll_assert_admin();
  return coalesce((select jsonb_agg(jsonb_build_object('device_id',d.id,'name',d.name,
    'status',case when d.revoked_at is null then 'active' else 'revoked' end,'created_at',d.created_at,'revoked_at',d.revoked_at,
    'enrollment_count',(select count(*) from payroll_kiosk.payroll_kiosk_enrollments e where e.device_id=d.id and e.revoked_at is null)) order by d.created_at,d.id)
    from payroll_kiosk.payroll_kiosk_devices d),'[]'::jsonb);
end;$$;
create function payroll_kiosk.payroll_kiosk_revoke(p_device_id uuid,p_reason text) returns uuid
language plpgsql security definer set search_path='' as $$declare d payroll_kiosk.payroll_kiosk_devices%rowtype;begin
  perform public.payroll_assert_admin();
  if p_reason is null or length(btrim(p_reason)) not between 1 and 1000 then raise exception 'PAYROLL_KIOSK_REASON_REQUIRED';end if;
  perform version from public.payroll_revision where id=1 for update;
  select * into d from payroll_kiosk.payroll_kiosk_devices where id=p_device_id;
  if not found then raise exception 'PAYROLL_KIOSK_DEVICE_NOT_FOUND';end if;
  if d.revoked_at is null then
    update payroll_kiosk.payroll_kiosk_devices set revoked_at=clock_timestamp(),revoked_by=auth.uid(),revoke_reason=btrim(p_reason) where id=d.id;
    insert into payroll_kiosk.payroll_kiosk_admin_audit(device_id,action,detail,created_by) values(d.id,'revoke',jsonb_build_object('reason',btrim(p_reason)),auth.uid());
  end if;
  return d.id;
end;$$;
create function payroll_kiosk.payroll_kiosk_enroll(p_device_id uuid,p_employee_id uuid,p_consent_version text) returns uuid
language plpgsql security definer set search_path='' as $$declare v_id uuid;v_day date:=(clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;begin
  perform public.payroll_assert_admin();
  if p_consent_version is null or length(btrim(p_consent_version)) not between 1 and 100 or p_consent_version~'[[:cntrl:]]' then raise exception 'PAYROLL_KIOSK_CONSENT_REQUIRED';end if;
  perform version from public.payroll_revision where id=1 for update;
  if not exists(select 1 from payroll_kiosk.payroll_kiosk_devices where id=p_device_id and revoked_at is null) then raise exception 'PAYROLL_KIOSK_DEVICE_NOT_ACTIVE';end if;
  if not exists(select 1 from public.payroll_employees where id=p_employee_id and active and employment_status='active'
    and (hire_date is null or hire_date<=v_day) and (termination_date is null or termination_date>=v_day)) then raise exception 'PAYROLL_KIOSK_EMPLOYEE_NOT_ACTIVE';end if;
  select id into v_id from payroll_kiosk.payroll_kiosk_enrollments where device_id=p_device_id and employee_id=p_employee_id and revoked_at is null;
  if found then return v_id;end if;
  insert into payroll_kiosk.payroll_kiosk_enrollments(device_id,employee_id,consent_version,created_by) values(p_device_id,p_employee_id,btrim(p_consent_version),auth.uid()) returning id into v_id;
  insert into payroll_kiosk.payroll_kiosk_admin_audit(device_id,employee_id,action,detail,created_by)
    values(p_device_id,p_employee_id,'enroll',jsonb_build_object('grant_id',v_id,'consent_version',btrim(p_consent_version)),auth.uid());
  return v_id;
end;$$;
create function payroll_kiosk.payroll_kiosk_unenroll(p_device_id uuid,p_employee_id uuid,p_reason text) returns uuid
language plpgsql security definer set search_path='' as $$declare v_id uuid;begin
  perform public.payroll_assert_admin();
  if p_reason is null or length(btrim(p_reason)) not between 1 and 1000 then raise exception 'PAYROLL_KIOSK_REASON_REQUIRED';end if;
  perform version from public.payroll_revision where id=1 for update;
  select id into v_id from payroll_kiosk.payroll_kiosk_enrollments where device_id=p_device_id and employee_id=p_employee_id and revoked_at is null;
  if found then
    update payroll_kiosk.payroll_kiosk_enrollments set revoked_at=clock_timestamp(),revoked_by=auth.uid(),revoke_reason=btrim(p_reason) where id=v_id;
    insert into payroll_kiosk.payroll_kiosk_admin_audit(device_id,employee_id,action,detail,created_by)
      values(p_device_id,p_employee_id,'unenroll',jsonb_build_object('grant_id',v_id,'reason',btrim(p_reason)),auth.uid());
  end if;
  return p_employee_id;
end;$$;

-- Runtime helper is not executable by API roles. Only the narrowly scoped
-- capability functions below use it; a hash never appears in their responses.
create function payroll_kiosk.payroll_kiosk_require(p_token text) returns payroll_kiosk.payroll_kiosk_devices
language plpgsql security invoker set search_path='' as $$declare d payroll_kiosk.payroll_kiosk_devices%rowtype;begin
  if p_token is null or p_token!~'^[0-9a-f]{64}$' then raise exception 'PAYROLL_KIOSK_INVALID_TOKEN' using errcode='42501';end if;
  select * into d from payroll_kiosk.payroll_kiosk_devices where token_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex') and revoked_at is null;
  if not found then raise exception 'PAYROLL_KIOSK_INVALID_TOKEN' using errcode='42501';end if;
  return d;
end;$$;
create function payroll_kiosk.payroll_kiosk_event_json(p_row public.payroll_attendance_raw,p_replayed boolean) returns jsonb
language sql immutable security invoker set search_path='' as $$
  select jsonb_build_object('event_id',p_row.id,'employee_id',p_row.employee_id,'punch_type',p_row.punch_type,
    'occurred_at',p_row.occurred_at,'server_received_at',p_row.created_at,'replayed',p_replayed,'verification','trusted_kiosk_verification');
$$;
create function payroll_kiosk.payroll_kiosk_roster(p_token text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare d payroll_kiosk.payroll_kiosk_devices%rowtype;v_day date:=(clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;v_employees jsonb;
begin
  d:=payroll_kiosk.payroll_kiosk_require(p_token);
  select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'device_user_id',e.device_user_id,'name',e.name,'enrollment_id',g.id,
    'last_punch',(select jsonb_build_object('punch_type',r.punch_type,'occurred_at',r.occurred_at) from public.payroll_attendance_raw r
      where r.employee_id=e.id and r.punch_type is not null order by r.occurred_at desc,r.id desc limit 1)) order by e.name,e.id),'[]'::jsonb)
    into v_employees from public.payroll_employees e join payroll_kiosk.payroll_kiosk_enrollments g on g.employee_id=e.id
    where g.device_id=d.id and g.revoked_at is null and e.active and e.employment_status='active'
      and (e.hire_date is null or e.hire_date<=v_day) and (e.termination_date is null or e.termination_date>=v_day);
  return jsonb_build_object('device_id',d.id,'name',d.name,'employees',v_employees);
end;$$;
create function payroll_kiosk.payroll_kiosk_receipt(p_token text,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$declare d payroll_kiosk.payroll_kiosk_devices%rowtype;r public.payroll_attendance_raw%rowtype;begin
  d:=payroll_kiosk.payroll_kiosk_require(p_token);
  if p_request_id is null then raise exception 'PAYROLL_KIOSK_REQUEST_REQUIRED';end if;
  perform version from public.payroll_revision where id=1 for update;
  d:=payroll_kiosk.payroll_kiosk_require(p_token);
  select * into r from public.payroll_attendance_raw where kiosk_request_id=p_request_id and kiosk_device_id=d.id;
  if not found then return null;end if;
  return payroll_kiosk.payroll_kiosk_event_json(r,true);
end;$$;
create function payroll_kiosk.payroll_kiosk_punch(p_token text,p_employee_id uuid,p_kind text,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare d payroll_kiosk.payroll_kiosk_devices%rowtype;r public.payroll_attendance_raw%rowtype;prior public.payroll_attendance_raw%rowtype;
  v_now timestamptz;v_local timestamp;v_day date;
begin
  d:=payroll_kiosk.payroll_kiosk_require(p_token);
  if p_request_id is null or p_employee_id is null or p_kind is null or p_kind not in ('in','out') then raise exception 'PAYROLL_KIOSK_INVALID_PUNCH';end if;
  -- Global revision is always first. It serializes devices, administrator
  -- revocation, employee status changes, typed pairs and finalized snapshots.
  perform version from public.payroll_revision where id=1 for update;
  d:=payroll_kiosk.payroll_kiosk_require(p_token);
  select * into r from public.payroll_attendance_raw where kiosk_request_id=p_request_id;
  if found then
    if r.kiosk_device_id<>d.id or r.employee_id<>p_employee_id or r.punch_type<>p_kind then raise exception 'PAYROLL_KIOSK_REQUEST_CONFLICT';end if;
    return payroll_kiosk.payroll_kiosk_event_json(r,true);
  end if;
  v_now:=clock_timestamp();v_local:=v_now at time zone 'Asia/Ho_Chi_Minh';v_day:=v_local::date;
  if not exists(select 1 from public.payroll_employees where id=p_employee_id and active and employment_status='active'
    and (hire_date is null or hire_date<=v_day) and (termination_date is null or termination_date>=v_day)) then raise exception 'PAYROLL_KIOSK_EMPLOYEE_NOT_ACTIVE';end if;
  if not exists(select 1 from payroll_kiosk.payroll_kiosk_enrollments where device_id=d.id and employee_id=p_employee_id and revoked_at is null) then raise exception 'PAYROLL_KIOSK_EMPLOYEE_NOT_ENROLLED';end if;
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

-- Transfer ONLY three capability entrypoints to the restricted role. Helpers
-- remain invoker functions and cannot independently elevate an API caller.
grant create on schema payroll_kiosk to payroll_kiosk_writer;
alter function payroll_kiosk.payroll_kiosk_roster(text) owner to payroll_kiosk_writer;
alter function payroll_kiosk.payroll_kiosk_receipt(text,uuid) owner to payroll_kiosk_writer;
alter function payroll_kiosk.payroll_kiosk_punch(text,uuid,text,uuid) owner to payroll_kiosk_writer;
revoke create on schema payroll_kiosk from payroll_kiosk_writer;

create function public.payroll_kiosk_register(p_device_id uuid,p_name text,p_token text) returns jsonb language sql security invoker set search_path='' as $$select payroll_kiosk.payroll_kiosk_register(p_device_id,p_name,p_token);$$;
create function public.payroll_kiosk_devices() returns jsonb language sql security invoker set search_path='' as $$select payroll_kiosk.payroll_kiosk_devices();$$;
create function public.payroll_kiosk_revoke(p_device_id uuid,p_reason text) returns uuid language sql security invoker set search_path='' as $$select payroll_kiosk.payroll_kiosk_revoke(p_device_id,p_reason);$$;
create function public.payroll_kiosk_enroll(p_device_id uuid,p_employee_id uuid,p_consent_version text) returns uuid language sql security invoker set search_path='' as $$select payroll_kiosk.payroll_kiosk_enroll(p_device_id,p_employee_id,p_consent_version);$$;
create function public.payroll_kiosk_unenroll(p_device_id uuid,p_employee_id uuid,p_reason text) returns uuid language sql security invoker set search_path='' as $$select payroll_kiosk.payroll_kiosk_unenroll(p_device_id,p_employee_id,p_reason);$$;
create function public.payroll_kiosk_roster(p_token text) returns jsonb language sql security invoker set search_path='' as $$select payroll_kiosk.payroll_kiosk_roster(p_token);$$;
create function public.payroll_kiosk_receipt(p_token text,p_request_id uuid) returns jsonb language sql security invoker set search_path='' as $$select payroll_kiosk.payroll_kiosk_receipt(p_token,p_request_id);$$;
create function public.payroll_kiosk_punch(p_token text,p_employee_id uuid,p_kind text,p_request_id uuid) returns jsonb language sql security invoker set search_path='' as $$select payroll_kiosk.payroll_kiosk_punch(p_token,p_employee_id,p_kind,p_request_id);$$;

do $$declare f record;begin
  for f in select p.oid::regprocedure signature,n.nspname,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','payroll_kiosk') and p.proname like 'payroll_kiosk_%' loop
    execute format('revoke all on function %s from public,anon,authenticated',f.signature);
    if f.proname in ('payroll_kiosk_roster','payroll_kiosk_receipt','payroll_kiosk_punch') then
      execute format('grant execute on function %s to anon,authenticated',f.signature);
    elsif f.proname in ('payroll_kiosk_register','payroll_kiosk_devices','payroll_kiosk_revoke','payroll_kiosk_enroll','payroll_kiosk_unenroll') then
      execute format('grant execute on function %s to authenticated',f.signature);
    elsif f.proname in ('payroll_kiosk_raw_serialize','payroll_kiosk_raw_guard','payroll_kiosk_raw_audit') then
      execute format('grant execute on function %s to authenticated,payroll_kiosk_writer',f.signature);
    else execute format('grant execute on function %s to payroll_kiosk_writer',f.signature);
    end if;
  end loop;
end;$$;
grant execute on function public.payroll_guard_internal() to payroll_kiosk_writer;

comment on column public.payroll_attendance_raw.source is 'excel: immutable POS import; kiosk: server-timed event from an admin-enrolled device asserting trusted local face verification. No server biometric proof is claimed.';
comment on column public.payroll_attendance_raw.kiosk_request_id is 'Global idempotency key for a deliberate online punch. Receipt lookup never creates a delayed event.';
comment on table payroll_kiosk.payroll_kiosk_devices is 'SHA-256 of 256-bit random device capability only; no raw token or biometric data. No API table access. Credentials intentionally excluded from payroll backups.';

create or replace function private.payroll_restore(p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare allowed_tables constant text[]:=array['payroll_employees','payroll_imports','payroll_terms','payroll_rule_versions',
  'payroll_days','payroll_reviews','payroll_runs','payroll_run_adjustments','payroll_payments','payroll_payment_reversals',
  'payroll_attendance_raw','payroll_attachments','payroll_audit'];
  t text;row_data jsonb;v_rows jsonb;pair record;v_count bigint;v_counts jsonb:='{}';v_fingerprint text;v_secret uuid;v_receipt uuid;v_revision bigint;
begin
  perform public.payroll_assert_admin();
  if jsonb_typeof(p_payload) is distinct from 'object' or p_payload->>'format' is distinct from 'DGV_PAYROLL_BACKUP'
    or p_payload->>'version' is distinct from '2' or octet_length(p_payload::text)>10485760
    or jsonb_typeof(p_payload->'tables') is distinct from 'object' or jsonb_typeof(p_payload->'sensitive') is distinct from 'array'
    or jsonb_typeof(p_payload->'revision') is distinct from 'number' then raise exception 'PAYROLL_INVALID_BACKUP';end if;
  v_revision:=(p_payload->>'revision')::bigint;
  if v_revision<0 or v_revision::numeric<>(p_payload->>'revision')::numeric then raise exception 'PAYROLL_INVALID_BACKUP_REVISION';end if;
  if exists(select 1 from jsonb_object_keys(p_payload->'tables') k where not k=any(allowed_tables)) then raise exception 'PAYROLL_UNKNOWN_BACKUP_TABLE';end if;
  foreach t in array allowed_tables loop
    if jsonb_typeof(p_payload->'tables'->t) is distinct from 'array' or jsonb_array_length(p_payload->'tables'->t)>50000 then raise exception 'PAYROLL_INVALID_BACKUP_TABLE: %',t;end if;
    for row_data in select value from jsonb_array_elements(p_payload->'tables'->t) loop
      if jsonb_typeof(row_data) is distinct from 'object' or not coalesce(isfinite((row_data->>'created_at')::timestamptz),false)
        or (row_data ? 'updated_at' and not coalesce(isfinite((row_data->>'updated_at')::timestamptz),false)) then
        raise exception 'PAYROLL_INVALID_BACKUP_ROW_TIMESTAMP: %',t;
      end if;
    end loop;
    v_counts:=v_counts||jsonb_build_object(t,jsonb_array_length(p_payload->'tables'->t));
  end loop;
  if jsonb_array_length(p_payload->'sensitive')>10000 then raise exception 'PAYROLL_INVALID_SENSITIVE_BACKUP';end if;
  if p_payload ? 'sensitive_count' and (p_payload->>'sensitive_count')::bigint<>jsonb_array_length(p_payload->'sensitive') then raise exception 'PAYROLL_INVALID_SENSITIVE_BACKUP_COUNT';end if;
  -- This is an idempotence fingerprint, not encryption or authentication.
  -- The client envelope supplies AES-GCM authentication and password encryption.
  v_fingerprint:=md5(p_payload::text)||':'||octet_length(p_payload::text)::text;
  select id into v_receipt from private.payroll_restore_receipts where fingerprint=v_fingerprint;
  if found then return jsonb_build_object('restored',false,'replayed',true,'receipt_id',v_receipt,'counts',v_counts,
    'missing_evidence',private.payroll_missing_evidence());end if;

  -- NOWAIT avoids a lock-order deadlock with active imports. A busy restore is
  -- safely retried; it never waits while holding a globally disabled trigger.
  lock table public.payroll_employees,public.payroll_imports,public.payroll_terms,public.payroll_rule_versions,
    public.payroll_days,public.payroll_reviews,public.payroll_runs,public.payroll_run_adjustments,public.payroll_payments,
    public.payroll_payment_reversals,public.payroll_attendance_raw,public.payroll_attachments,public.payroll_audit,
    public.payroll_revision,private.payroll_sensitive_versions,private.payroll_restore_receipts in access exclusive mode nowait;
  -- Recheck after locking to serialize two identical concurrent requests.
  select id into v_receipt from private.payroll_restore_receipts where fingerprint=v_fingerprint;
  if found then return jsonb_build_object('restored',false,'replayed',true,'receipt_id',v_receipt,'counts',v_counts,
    'missing_evidence',private.payroll_missing_evidence());end if;
  foreach t in array allowed_tables loop
    execute format('select count(*) from public.%I',t) into v_count;
    if v_count<>0 then raise exception 'PAYROLL_RESTORE_REQUIRES_EMPTY_DATABASE';end if;
  end loop;
  if exists(select 1 from private.payroll_sensitive_versions) then raise exception 'PAYROLL_RESTORE_REQUIRES_EMPTY_DATABASE';end if;

  -- All changes, including trigger state, are transactional and covered by the
  -- exclusive table locks. Any validation error rolls the entire operation back.
  foreach t in array allowed_tables loop execute format('alter table public.%I disable trigger user',t);end loop;
  alter table public.payroll_revision disable trigger user;
  alter table private.payroll_sensitive_versions disable trigger user;
  foreach t in array allowed_tables loop
    v_rows:=p_payload->'tables'->t;
    if t='payroll_terms' then
      -- Version 2 archives created before monthly settlement have no new keys.
      -- Preserve their prior statutory behavior and recorded break times. A
      -- present null/invalid key is never replaced by a compatibility default.
      select coalesce(jsonb_agg(jsonb_build_object('monthly_settlement','statutory',
        'monthly_extra_hourly_rate',null,'weekly_rest_day',0)||value),'[]'::jsonb)
        into v_rows from jsonb_array_elements(v_rows);
    elsif t='payroll_attendance_raw' then
      -- Pre-kiosk archives have only POS/import rows. Explicit null or invalid
      -- fields still fail constraints; typed kiosk history is preserved exactly.
      select coalesce(jsonb_agg(jsonb_build_object('source','excel','punch_type',null,
        'kiosk_device_id',null,'kiosk_request_id',null)||value),'[]'::jsonb)
        into v_rows from jsonb_array_elements(v_rows);
    end if;
    execute format('insert into public.%I overriding system value select * from jsonb_populate_recordset(null::public.%I,$1)',t,t)
      using v_rows;
  end loop;
  for row_data in select value from jsonb_array_elements(p_payload->'sensitive') loop
    if jsonb_typeof(row_data->'data') is distinct from 'object' or not coalesce(isfinite((row_data->>'created_at')::timestamptz),false) then raise exception 'PAYROLL_INVALID_SENSITIVE_BACKUP';end if;
    for pair in select key,value from jsonb_each(row_data->'data') loop
      if pair.key not in ('bank_name','bank_account','account_holder','national_id','tax_id')
        or jsonb_typeof(pair.value)<>'string' or length(pair.value#>>'{}')>300 then raise exception 'PAYROLL_INVALID_SENSITIVE_FIELD';end if;
    end loop;
    -- Never trust or reuse a Vault secret ID supplied by a backup.
    v_secret:=vault.create_secret((row_data->'data')::text,'payroll:'||(row_data->>'employee_id')||':'||gen_random_uuid()::text,'Restored encrypted payroll details');
    insert into private.payroll_sensitive_versions(id,version,employee_id,secret_id,reason,created_by,created_at) overriding system value
      values((row_data->>'id')::uuid,(row_data->>'version')::bigint,(row_data->>'employee_id')::uuid,v_secret,
        row_data->>'reason',(row_data->>'created_by')::uuid,(row_data->>'created_at')::timestamptz);
  end loop;
  -- Validate invariants that normally live in row triggers as well as the
  -- always-active table CHECK, UNIQUE and foreign-key constraints.
  if exists(select 1 from public.payroll_run_balances where total<0 or total>999999999999 or paid>total)
    or exists(select 1 from public.payroll_runs where jsonb_typeof(snapshot->'unresolved') is distinct from 'number'
      or (snapshot->>'unresolved')::numeric<>0 or expected_revision>v_revision)
    or exists(select 1 from public.payroll_reviews where source_revision>v_revision)
    or exists(select 1 from public.payroll_employees where active is distinct from (employment_status='active')) then
    raise exception 'PAYROLL_BACKUP_INCONSISTENT_BALANCES_OR_SNAPSHOT';
  end if;
  for row_data in select to_jsonb(d) from public.payroll_days d loop
    perform public.payroll_check_intervals(row_data->'overtime_intervals',(row_data->>'work_date')::date);
    perform public.payroll_check_intervals(row_data->'night_intervals',(row_data->>'work_date')::date);
    if ((row_data->>'overtime_approved')::boolean or (row_data->>'night_approved')::boolean) and length(btrim(row_data->>'approval_reason'))=0 then raise exception 'PAYROLL_APPROVAL_REASON_REQUIRED';end if;
  end loop;
  if exists(select 1 from public.payroll_attachments a where split_part(a.storage_path,'/',1)<>a.payment_id::text
    or a.storage_path!~'^[0-9a-f-]{36}/[0-9a-f-]{36}\.(pdf|png|jpg|jpeg|webp)$'
    or (a.evidence_type='signature' and (a.mime_type<>'image/png' or a.acknowledged_at>now()+interval '5 minutes')))
    or exists(select 1 from public.payroll_attachments a join storage.objects o on o.bucket_id='payroll-evidence' and o.name=a.storage_path
      where o.metadata->>'mimetype' is distinct from a.mime_type or (o.metadata->>'size')::bigint is distinct from a.byte_size::bigint) then
    raise exception 'PAYROLL_BACKUP_INVALID_EVIDENCE';
  end if;
  -- Never reuse an old live revision: a browser holding a pre-restore draft
  -- must reload even if the restored archive came from this same database.
  update public.payroll_revision set version=greatest(version,v_revision)+1 where id=1;
  perform setval('public.payroll_rule_versions_version_seq',greatest((select last_value from public.payroll_rule_versions_version_seq),
    coalesce((select max(version) from public.payroll_rule_versions),1)),true);
  perform setval('private.payroll_sensitive_versions_version_seq',greatest((select last_value from private.payroll_sensitive_versions_version_seq),
    coalesce((select max(version) from private.payroll_sensitive_versions),1)),true);
  -- Flush this table's deferred provenance FK before ALTER TRIGGER. Otherwise
  -- PostgreSQL correctly refuses to alter a table with pending trigger events.
  set constraints public.payroll_attendance_raw_import_id_fkey immediate;
  foreach t in array allowed_tables loop execute format('alter table public.%I enable trigger user',t);end loop;
  set constraints public.payroll_attendance_raw_import_id_fkey deferred;
  alter table public.payroll_revision enable trigger user;
  alter table private.payroll_sensitive_versions enable trigger user;
  insert into private.payroll_restore_receipts(fingerprint,table_counts,created_by)
    values(v_fingerprint,v_counts,auth.uid()) returning id into v_receipt;
  return jsonb_build_object('restored',true,'replayed',false,'receipt_id',v_receipt,'counts',v_counts,
    'missing_evidence',private.payroll_missing_evidence());
end; $$;

commit;
