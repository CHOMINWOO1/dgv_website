-- Manual employee forms save public details and encrypted identity atomically.
-- Existing import behavior and Vault-only identity storage remain unchanged.
begin;
create function public.payroll_save_employee(p_employee_id uuid,p_employee jsonb,p_national_id text,
  p_expected_revision bigint,p_create boolean) returns uuid
language plpgsql security invoker set search_path='' as $$
declare allowed_fields constant text[]:=array['device_user_id','name','active','phone','employment_type',
    'hire_date','termination_date','employment_status','payment_method'];
  v_revision bigint;v_exists boolean;v_before jsonb;v_target jsonb;v_sensitive jsonb;v_national_id text;
  v_current public.payroll_employees%rowtype;v_desired public.payroll_employees%rowtype;item record;
begin
  perform public.payroll_assert_admin();
  if p_employee_id is null or p_create is null or p_expected_revision is null or p_expected_revision<0
    or jsonb_typeof(p_employee) is distinct from 'object' then raise exception 'PAYROLL_INVALID_EMPLOYEE_REQUEST';end if;
  v_national_id:=btrim(p_national_id);
  if v_national_id is null or length(v_national_id) not between 1 and 300
    or v_national_id~'[[:cntrl:]]' then raise exception 'PAYROLL_NATIONAL_ID_REQUIRED_OR_INVALID';end if;
  for item in select key,value from jsonb_each(p_employee) loop
    if not item.key=any(allowed_fields) then raise exception 'PAYROLL_INVALID_EMPLOYEE_FIELD';end if;
    if item.key='active' then
      if jsonb_typeof(item.value) is distinct from 'boolean' then raise exception 'PAYROLL_INVALID_EMPLOYEE_FIELD_TYPE';end if;
    elsif item.key in ('hire_date','termination_date') then
      if jsonb_typeof(item.value) not in ('string','null') then raise exception 'PAYROLL_INVALID_EMPLOYEE_FIELD_TYPE';end if;
    elsif jsonb_typeof(item.value) is distinct from 'string' then raise exception 'PAYROLL_INVALID_EMPLOYEE_FIELD_TYPE';end if;
  end loop;
  -- All public/sensitive payroll writes use this same revision-first lock order.
  select version into v_revision from public.payroll_revision where id=1 for update;
  if v_revision is null then raise exception 'PAYROLL_REVISION_MISSING';end if;
  select * into v_current from public.payroll_employees where id=p_employee_id;
  v_exists:=found;
  if not v_exists and not p_create then raise exception 'PAYROLL_EMPLOYEE_NOT_FOUND';end if;
  if v_exists then
    select jsonb_object_agg(key,value) into v_before from jsonb_each(to_jsonb(v_current)) where key=any(allowed_fields);
    v_sensitive:=public.payroll_get_sensitive(p_employee_id);
  else v_sensitive:='{}'::jsonb;end if;
  v_target:=case when p_create then jsonb_build_object('device_user_id',null,'name',null,'active',true,'phone','',
    'employment_type','full_time','hire_date',null,'termination_date',null,'employment_status','active','payment_method','cash')
    else v_before end||p_employee;
  -- Employment status is authoritative, matching the existing employee guard.
  if p_employee ? 'employment_status' then
    v_target:=v_target||jsonb_build_object('active',v_target->>'employment_status'='active');
  elsif p_employee ? 'active' then
    v_target:=v_target||jsonb_build_object('employment_status',case when (v_target->>'active')::boolean then 'active' else 'terminated' end);
  end if;
  v_target:=v_target||jsonb_build_object('device_user_id',btrim(v_target->>'device_user_id'),
    'name',btrim(v_target->>'name'),'phone',btrim(v_target->>'phone'));
  select * into v_desired from jsonb_populate_record(null::public.payroll_employees,v_target||jsonb_build_object('id',p_employee_id));
  -- Canonicalize typed dates before comparing a lost-response retry.
  select jsonb_object_agg(key,value) into v_target from jsonb_each(to_jsonb(v_desired)) where key=any(allowed_fields);
  if v_exists and v_before=v_target and v_sensitive->>'national_id'=v_national_id then return p_employee_id;end if;
  if v_exists and p_create then raise exception 'PAYROLL_EMPLOYEE_CREATE_CONFLICT';end if;
  if p_expected_revision is distinct from v_revision then raise exception 'PAYROLL_STALE_RELOAD_REQUIRED';end if;
  if v_exists and v_desired.device_user_id is distinct from v_current.device_user_id then raise exception 'PAYROLL_DEVICE_ID_IMMUTABLE';end if;
  if not v_exists then
    insert into public.payroll_employees(id,device_user_id,name,active,phone,employment_type,hire_date,termination_date,employment_status,payment_method)
      values(p_employee_id,v_desired.device_user_id,v_desired.name,v_desired.active,v_desired.phone,v_desired.employment_type,
        v_desired.hire_date,v_desired.termination_date,v_desired.employment_status,v_desired.payment_method);
  elsif v_before is distinct from v_target then
    update public.payroll_employees set name=v_desired.name,active=v_desired.active,phone=v_desired.phone,
      employment_type=v_desired.employment_type,hire_date=v_desired.hire_date,termination_date=v_desired.termination_date,
      employment_status=v_desired.employment_status,payment_method=v_desired.payment_method where id=p_employee_id;
  end if;
  if v_sensitive->>'national_id' is distinct from v_national_id then
    -- The existing narrow Vault helper writes an immutable encrypted version.
    -- Other bank/tax fields are merged under the same lock and never replaced.
    perform public.payroll_set_sensitive(p_employee_id,v_sensitive||jsonb_build_object('national_id',v_national_id),
      'National identity saved through administrator employee form');
  end if;
  return p_employee_id;
end; $$;
revoke all on function public.payroll_save_employee(uuid,jsonb,text,bigint,boolean) from public,anon,authenticated;
grant execute on function public.payroll_save_employee(uuid,jsonb,text,bigint,boolean) to authenticated;
comment on function public.payroll_save_employee(uuid,jsonb,text,bigint,boolean) is 'Admin-only atomic manual employee+encrypted national-ID save. Client UUID enables exact retry; revision protects changed updates. Public/audit rows never contain the identity value. Imports are unchanged.';

-- The bank/tax dialog submits a whole encrypted object. Guard its captured
-- revision so a stale dialog cannot replace a newer national-ID version.
create function public.payroll_set_sensitive(p_employee_id uuid,p_data jsonb,p_reason text,p_expected_revision bigint) returns uuid
language plpgsql security invoker set search_path='' as $$
declare v_revision bigint;
begin
  perform public.payroll_assert_admin();
  select version into v_revision from public.payroll_revision where id=1 for update;
  if v_revision is null then raise exception 'PAYROLL_REVISION_MISSING';end if;
  if p_expected_revision is distinct from v_revision then raise exception 'PAYROLL_STALE_RELOAD_REQUIRED';end if;
  return private.payroll_set_sensitive(p_employee_id,p_data,p_reason);
end; $$;
revoke all on function public.payroll_set_sensitive(uuid,jsonb,text,bigint) from public,anon,authenticated;
grant execute on function public.payroll_set_sensitive(uuid,jsonb,text,bigint) to authenticated;
comment on function public.payroll_set_sensitive(uuid,jsonb,text,bigint) is 'Admin-only full sensitive-object update with revision guard. Prevents stale bank/tax dialogs from replacing newer encrypted identity details. The original three-argument RPC remains for compatibility.';
commit;
