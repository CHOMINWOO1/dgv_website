-- Live-safe rollback smoke for manual employee identity registration.
-- Creates only UUID-named fixtures; does not inspect existing private values,
-- suspend triggers, clear tables, restore backups or update existing employees.
begin;
set local lock_timeout='5s';set local statement_timeout='30s';
create function pg_temp.employee_live_assert(p_ok boolean,p_message text) returns void language plpgsql as $$
begin if p_ok is distinct from true then raise exception 'FAIL: %',p_message;end if;end;$$;
do $$
declare actor uuid:='00000000-0000-4000-8000-000000000008';employee uuid:=gen_random_uuid();imported uuid;t text;n bigint;
  tables constant text[]:=array['payroll_revision','payroll_employees','payroll_terms','payroll_imports','payroll_attendance_raw',
    'payroll_days','payroll_runs','payroll_payments','payroll_audit','payroll_rule_versions','payroll_reviews',
    'payroll_run_adjustments','payroll_payment_reversals','payroll_attachments'];
  before_counts jsonb:='{}';after_counts jsonb:='{}';before_revision bigint;revision bigint;after_create_revision bigint;
  before_private_count bigint;payload jsonb;rejected boolean;sensitive jsonb;
  marker text:='ROLLBACK-PRIVATE-ID-'||gen_random_uuid()::text;device text:='ROLLBACK-IDENTITY-'||gen_random_uuid()::text;
begin
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated','app_metadata',jsonb_build_object('role','admin'))::text,true);
  execute 'set local role authenticated';
  select version into before_revision from public.payroll_revision where id=1 for update;
  perform pg_temp.employee_live_assert(before_revision is not null,'payroll revision exists');
  foreach t in array tables loop
    execute format('select count(*) from public.%I',t) into n;
    before_counts:=before_counts||jsonb_build_object(t,n);
  end loop;
  execute 'set local role postgres';
  select count(*) into before_private_count from private.payroll_sensitive_versions;
  execute 'set local role authenticated';
  begin
    payload:=jsonb_build_object('device_user_id',device,'name','Temporary rollback employee','phone','123','employment_status','active','active',true);
    rejected:=false;
    begin perform public.payroll_save_employee(employee,payload,'',before_revision,true);
    exception when others then rejected:=sqlerrm='PAYROLL_NATIONAL_ID_REQUIRED_OR_INVALID';end;
    perform pg_temp.employee_live_assert(rejected and not exists(select 1 from public.payroll_employees where id=employee),
      'manual employee form requires identity and creates no partial row');
    perform pg_temp.employee_live_assert(public.payroll_save_employee(employee,payload,marker,before_revision,true)=employee,
      'administrator can atomically create employee and encrypted identity');
    perform pg_temp.employee_live_assert(public.payroll_get_sensitive(employee)->>'national_id'=marker,
      'identity is available only through the administrator encrypted-data helper');
    select version into after_create_revision from public.payroll_revision where id=1;
    perform pg_temp.employee_live_assert(public.payroll_save_employee(employee,payload,marker,before_revision,true)=employee
      and (select version=after_create_revision from public.payroll_revision where id=1),'same create retry neither duplicates rows nor increments revision');
    rejected:=false;
    begin perform public.payroll_save_employee(employee,payload||'{"name":"Conflict"}',marker,after_create_revision,true);
    exception when others then rejected:=sqlerrm='PAYROLL_EMPLOYEE_CREATE_CONFLICT';end;
    perform pg_temp.employee_live_assert(rejected,'conflicting stable UUID never overwrites an employee');
    perform public.payroll_set_sensitive(employee,jsonb_build_object('national_id',marker,'bank_name','Smoke bank','bank_account','SMOKE-ACCOUNT','tax_id','SMOKE-TAX'),'Rollback smoke metadata',after_create_revision);
    select version into revision from public.payroll_revision where id=1;
    perform public.payroll_save_employee(employee,'{"phone":"456"}',marker||'-UPDATED',revision,false);
    sensitive:=public.payroll_get_sensitive(employee);
    perform pg_temp.employee_live_assert(sensitive->>'national_id'=marker||'-UPDATED' and sensitive->>'bank_account'='SMOKE-ACCOUNT'
      and sensitive->>'bank_name'='Smoke bank' and sensitive->>'tax_id'='SMOKE-TAX'
      and (select phone='456' from public.payroll_employees where id=employee),'atomic identity update preserves other encrypted bank/tax fields');
    rejected:=false;
    begin perform public.payroll_save_employee(employee,'{"phone":"999"}',marker,revision,false);
    exception when others then rejected:=sqlerrm='PAYROLL_STALE_RELOAD_REQUIRED';end;
    perform pg_temp.employee_live_assert(rejected,'stale changed update is rejected');
    rejected:=false;
    begin perform public.payroll_set_sensitive(employee,jsonb_build_object('national_id',marker),'Stale bank form',revision);
    exception when others then rejected:=sqlerrm='PAYROLL_STALE_RELOAD_REQUIRED';end;
    perform pg_temp.employee_live_assert(rejected and public.payroll_get_sensitive(employee)->>'national_id'=marker||'-UPDATED',
      'stale bank/tax form cannot overwrite the newer identity');
    perform pg_temp.employee_live_assert(not exists(select 1 from public.payroll_audit
      where coalesce(before_data::text,'') like '%'||marker||'%' or after_data::text like '%'||marker||'%')
      and not exists(select 1 from public.payroll_employees e where to_jsonb(e)::text like '%'||marker||'%'),
      'identity plaintext is absent from public employee/audit rows');
    -- Importing an unknown POS employee still works without an identity value.
    perform public.payroll_import('identity-rollback-smoke.xlsx',jsonb_build_array(jsonb_build_object('device_user_id',device||'-IMPORT',
      'name','Temporary import fixture','occurred_at','2099-01-01T10:00:00','device_id','1')));
    select id into imported from public.payroll_employees where device_user_id=device||'-IMPORT';
    perform pg_temp.employee_live_assert(imported is not null and public.payroll_get_sensitive(imported)='{}'::jsonb,
      'POS imports remain supported before identity details are completed');
    perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated','app_metadata',jsonb_build_object('role','manager'))::text,true);
    rejected:=false;
    begin perform public.payroll_save_employee(employee,'{"phone":"777"}',marker,revision,false);
    exception when insufficient_privilege then rejected:=true;end;
    perform pg_temp.employee_live_assert(rejected,'manager cannot use employee identity registration');
    raise exception using errcode='ZX006',message='ROLLBACK_EMPLOYEE_IDENTITY_SMOKE';
  exception when sqlstate 'ZX006' then null;
  end;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated','app_metadata',jsonb_build_object('role','admin'))::text,true);
  foreach t in array tables loop
    execute format('select count(*) from public.%I',t) into n;
    after_counts:=after_counts||jsonb_build_object(t,n);
  end loop;
  perform pg_temp.employee_live_assert(after_counts=before_counts
    and (select version=before_revision from public.payroll_revision where id=1)
    and not exists(select 1 from public.payroll_employees where id=employee),'all original payroll counts and revision remain unchanged');
  execute 'set local role postgres';
  perform pg_temp.employee_live_assert((select count(*)=before_private_count from private.payroll_sensitive_versions),
    'private encrypted-version count also returns to its original value');
  raise notice 'Live employee identity smoke passed: atomic save, private field merge, exact replay, manager denial, unchanged imports and original counts preserved.';
end;$$;
rollback;
