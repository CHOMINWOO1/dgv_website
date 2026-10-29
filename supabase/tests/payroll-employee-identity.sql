-- Rollback-only identity RPC regression. Uses only randomly named fixtures.
-- Run as database owner; the failure-injection trigger is transaction-local.
begin;
set local lock_timeout='5s';set local statement_timeout='60s';
create function pg_temp.identity_assert(p_ok boolean,p_message text) returns void language plpgsql as $$
begin if p_ok is distinct from true then raise exception 'FAIL: %',p_message;end if;end;$$;
create function pg_temp.identity_fail_fixture() returns trigger language plpgsql as $$
begin
  if new.employee_id::text=current_setting('payroll.test_fail_employee',true) then raise exception 'TEST_VAULT_VERSION_FAILURE';end if;
  return new;
end;$$;
create trigger payroll_identity_test_failure before insert on private.payroll_sensitive_versions
  for each row execute function pg_temp.identity_fail_fixture();
do $$
declare actor uuid:='00000000-0000-4000-8000-000000000007';employee uuid:=gen_random_uuid();failed_employee uuid:=gen_random_uuid();
  absent_employee uuid:=gen_random_uuid();v_payload jsonb;v_sensitive jsonb;v_id uuid;v_version bigint;revision bigint;
  before_revision bigint;before_count bigint;before_audit bigint;n bigint;rejected boolean;invalid_id text;role_name text;
  marker text:='IDENTITY-PRIVATE-'||gen_random_uuid()::text;device text:='IDENTITY-'||gen_random_uuid()::text;
begin
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated','app_metadata',jsonb_build_object('role','admin'))::text,true);
  execute 'set local role authenticated';
  select version into revision from public.payroll_revision where id=1 for update;
  v_payload:=jsonb_build_object('device_user_id',device,'name','Identity fixture','active',true,'phone','123',
    'employment_type','full_time','hire_date','2099-01-01','termination_date',null,'employment_status','active','payment_method','bank');
  foreach invalid_id in array array[null::text,'','   ',E'ID\nLINE',E'ID\tTAB',repeat('x',301)] loop
    rejected:=false;
    begin perform public.payroll_save_employee(employee,v_payload,invalid_id,revision,true);
    exception when others then rejected:=sqlerrm='PAYROLL_NATIONAL_ID_REQUIRED_OR_INVALID';end;
    perform pg_temp.identity_assert(rejected,'blank, oversized or control-character identity is rejected before creating employee');
  end loop;
  perform pg_temp.identity_assert(not exists(select 1 from public.payroll_employees where id=employee),'invalid identity leaves no partial employee');
  v_id:=public.payroll_save_employee(employee,v_payload,'  '||marker||'  ',revision,true);
  perform pg_temp.identity_assert(v_id=employee and public.payroll_get_sensitive(employee)->>'national_id'=marker,
    'manual creation atomically saves trimmed encrypted identity and chosen stable employee UUID');
  select version into before_revision from public.payroll_revision where id=1;
  select count(*) into before_audit from public.payroll_audit;
  v_id:=public.payroll_save_employee(employee,v_payload,marker,revision,true);
  perform pg_temp.identity_assert(v_id=employee and (select version=before_revision from public.payroll_revision where id=1)
    and (select count(*)=before_audit from public.payroll_audit),'identical lost-response create retry uses the original revision without new audit or data writes');
  rejected:=false;
  begin perform public.payroll_save_employee(employee,v_payload||'{"name":"Conflicting name"}',marker,before_revision,true);
  exception when others then rejected:=sqlerrm='PAYROLL_EMPLOYEE_CREATE_CONFLICT';end;
  perform pg_temp.identity_assert(rejected,'create retry never overwrites an existing UUID with different details');
  rejected:=false;
  begin perform public.payroll_save_employee(employee,v_payload,marker||'-OTHER',before_revision,true);
  exception when others then rejected:=sqlerrm='PAYROLL_EMPLOYEE_CREATE_CONFLICT';end;
  perform pg_temp.identity_assert(rejected,'create retry with different identity is a conflict');
  rejected:=false;
  begin perform public.payroll_save_employee(absent_employee,v_payload,marker,before_revision,false);
  exception when others then rejected:=sqlerrm='PAYROLL_EMPLOYEE_NOT_FOUND';end;
  perform pg_temp.identity_assert(rejected,'update never accidentally creates a missing employee');

  select version into revision from public.payroll_revision where id=1;
  perform public.payroll_set_sensitive(employee,jsonb_build_object('national_id',marker,'bank_name','Example bank','bank_account','SAFE-ACCOUNT',
    'account_holder','Fixture','tax_id','SAFE-TAX'),'Fixture banking details',revision);
  select version into revision from public.payroll_revision where id=1;
  v_id:=public.payroll_save_employee(employee,'{"name":"Updated fixture","employment_status":"leave","active":true}',marker||'-NEW',revision,false);
  v_sensitive:=public.payroll_get_sensitive(employee);
  perform pg_temp.identity_assert(v_sensitive->>'national_id'=marker||'-NEW' and v_sensitive->>'bank_name'='Example bank'
    and v_sensitive->>'bank_account'='SAFE-ACCOUNT' and v_sensitive->>'account_holder'='Fixture' and v_sensitive->>'tax_id'='SAFE-TAX',
    'identity changes merge rather than erase existing encrypted bank and tax fields');
  perform pg_temp.identity_assert((select name='Updated fixture' and not active and employment_status='leave' from public.payroll_employees where id=employee),
    'employment status remains authoritative over the legacy active flag');
  select version into before_revision from public.payroll_revision where id=1;
  perform pg_temp.identity_assert(public.payroll_save_employee(employee,'{"name":"Updated fixture","employment_status":"leave","active":true}',marker||'-NEW',revision,false)=employee
    and (select version=before_revision from public.payroll_revision where id=1),'identical update retry is a no-op after normalization');
  rejected:=false;
  begin perform public.payroll_save_employee(employee,'{"name":"Stale overwrite"}',marker,revision,false);
  exception when others then rejected:=sqlerrm='PAYROLL_STALE_RELOAD_REQUIRED';end;
  perform pg_temp.identity_assert(rejected and public.payroll_get_sensitive(employee)->>'national_id'=marker||'-NEW',
    'stale changed update cannot overwrite newer public or encrypted details');
  rejected:=false;
  begin perform public.payroll_set_sensitive(employee,jsonb_build_object('national_id',marker,'bank_account','STALE-ACCOUNT'),'Stale bank dialog',revision);
  exception when others then rejected:=sqlerrm='PAYROLL_STALE_RELOAD_REQUIRED';end;
  perform pg_temp.identity_assert(rejected and public.payroll_get_sensitive(employee)->>'national_id'=marker||'-NEW'
    and public.payroll_get_sensitive(employee)->>'bank_account'='SAFE-ACCOUNT',
    'stale full bank/tax form cannot replace a newer national-ID version');
  rejected:=false;
  begin perform public.payroll_save_employee(employee,'{"device_user_id":"CHANGED"}',marker||'-NEW',before_revision,false);
  exception when others then rejected:=sqlerrm='PAYROLL_DEVICE_ID_IMMUTABLE';end;
  perform pg_temp.identity_assert(rejected,'device user ID remains immutable');
  rejected:=false;
  begin perform public.payroll_save_employee(employee,'{"national_id":"PLAINTEXT-FIELD"}',marker||'-NEW',before_revision,false);
  exception when others then rejected:=sqlerrm='PAYROLL_INVALID_EMPLOYEE_FIELD';end;
  perform pg_temp.identity_assert(rejected,'identity cannot be smuggled into the public employee object');
  rejected:=false;
  begin perform public.payroll_save_employee(employee,'{"name":123}',marker||'-NEW',before_revision,false);
  exception when others then rejected:=sqlerrm='PAYROLL_INVALID_EMPLOYEE_FIELD_TYPE';end;
  perform pg_temp.identity_assert(rejected,'employee JSON requires correct field types');
  perform pg_temp.identity_assert(not exists(select 1 from public.payroll_audit where
    coalesce(before_data::text,'') like '%'||marker||'%' or after_data::text like '%'||marker||'%')
    and not exists(select 1 from public.payroll_employees e where to_jsonb(e)::text like '%'||marker||'%'),
    'national identity plaintext is absent from public employees and audit JSON');

  -- Deliberately fail the encrypted-version insert after the public employee
  -- write. PostgreSQL must roll back the employee, audit, revision and secret.
  select version into before_revision from public.payroll_revision where id=1;
  select count(*) into before_count from public.payroll_employees;
  select count(*) into before_audit from public.payroll_audit;
  perform set_config('payroll.test_fail_employee',failed_employee::text,true);
  rejected:=false;
  begin perform public.payroll_save_employee(failed_employee,jsonb_build_object('device_user_id',device||'-FAIL','name','Atomic failure fixture'),marker,before_revision,true);
  exception when others then rejected:=sqlerrm='TEST_VAULT_VERSION_FAILURE';end;
  perform pg_temp.identity_assert(rejected and not exists(select 1 from public.payroll_employees where id=failed_employee)
    and (select count(*)=before_count from public.payroll_employees) and (select count(*)=before_audit from public.payroll_audit)
    and (select version=before_revision from public.payroll_revision where id=1),'encryption/version failure rolls back every public creation side effect');
  perform set_config('payroll.test_fail_employee',employee::text,true);
  rejected:=false;
  begin perform public.payroll_save_employee(employee,'{"name":"Must roll back"}',marker||'-FAIL',before_revision,false);
  exception when others then rejected:=sqlerrm='TEST_VAULT_VERSION_FAILURE';end;
  perform pg_temp.identity_assert(rejected and (select name='Updated fixture' from public.payroll_employees where id=employee)
    and public.payroll_get_sensitive(employee)->>'national_id'=marker||'-NEW'
    and (select version=before_revision from public.payroll_revision where id=1),'encrypted update failure also rolls back the public employee update');
  perform set_config('payroll.test_fail_employee','',true);

  foreach role_name in array array['manager','staff'] loop
    perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated','app_metadata',jsonb_build_object('role',role_name),
      'user_metadata',jsonb_build_object('role','admin'))::text,true);
    rejected:=false;
    begin perform public.payroll_save_employee(employee,'{"name":"Unauthorized"}',marker,before_revision,false);
    exception when insufficient_privilege then rejected:=true;end;
    perform pg_temp.identity_assert(rejected,role_name||' cannot use the employee identity RPC or forge admin via user_metadata');
    rejected:=false;
    begin perform public.payroll_set_sensitive(employee,'{}','Unauthorized',before_revision);
    exception when insufficient_privilege then rejected:=true;end;
    perform pg_temp.identity_assert(rejected,role_name||' cannot use the revision-guarded sensitive overload');
  end loop;
  execute 'set local role anon';
  rejected:=false;
  begin perform public.payroll_save_employee(employee,'{}',marker,before_revision,false);
  exception when insufficient_privilege then rejected:=true;end;
  perform pg_temp.identity_assert(rejected,'anonymous role has no RPC execute privilege');
  execute 'set local role postgres';
  perform pg_temp.identity_assert((select count(*)=3 from private.payroll_sensitive_versions where employee_id=employee),
    'only successful initial, bank and identity edits produce encrypted history versions');
  perform pg_temp.identity_assert(not exists(select 1 from private.payroll_sensitive_versions where employee_id=failed_employee),
    'failed create leaves no encrypted version reference');
  raise notice 'Employee identity RPC passed: atomic create/update, encrypted merge, stale-write protection, replay, metadata privacy and admin-only access.';
end;$$;
rollback;
