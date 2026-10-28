-- Rollback-only payroll contract tests. Execute the WHOLE file as postgres.
-- No auth account, existing payroll row, order, expense or reservation is changed.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

create function pg_temp.payroll_assert(p_ok boolean,p_message text) returns void
language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'FAIL: %',p_message; end if;
end;
$$;

do $$
declare actor uuid:='00000000-0000-4000-8000-000000000001';
  suffix text:=gen_random_uuid()::text; device_user text; employee uuid; imported jsonb; repeated jsonb; overlapping jsonb;
  punches jsonb; invalid_payload jsonb; before_imports bigint; before_employees bigint; n bigint; rev bigint;
  rejected boolean; role_name text; v_run_id uuid; pay_id uuid; retry_id uuid; request_key uuid:=gen_random_uuid();
  saved_snapshot jsonb; before_revision bigint; after_revision bigint; original_name text:='Payroll rollback employee';
begin
  device_user:='ROLLBACK-'||suffix;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated','app_metadata',jsonb_build_object('role','admin'))::text,true);
  execute 'set local role authenticated';
  punches:=jsonb_build_array(
    jsonb_build_object('device_user_id',device_user,'name',original_name,'occurred_at','2090-01-01 10:00','device_id','N308'),
    jsonb_build_object('device_user_id',device_user,'name',original_name,'occurred_at','2090-01-01 20:00','device_id','N308'),
    jsonb_build_object('device_user_id',device_user,'name',original_name,'occurred_at','2090-01-01 10:00','device_id','N308'));
  imported:=public.payroll_import('first.xlsx',punches);
  perform pg_temp.payroll_assert((imported->>'inserted_count')::int=2 and (imported->>'duplicate_count')::int=1 and (imported->>'employee_count')::int=1,
    'first import deduplicates within the file and creates one employee');
  select id into employee from public.payroll_employees where device_user_id=device_user;
  perform pg_temp.payroll_assert(employee is not null,'authenticated admin can read newly imported employee');
  repeated:=public.payroll_import('same-file-again.xlsx',punches);
  perform pg_temp.payroll_assert((repeated->>'inserted_count')::int=0 and (repeated->>'duplicate_count')::int=3,
    'repeated file imports zero additional punches');
  overlapping:=public.payroll_import('overlapping-range.xlsx',punches||jsonb_build_array(
    jsonb_build_object('device_user_id',device_user,'name','Changed spreadsheet name','occurred_at','2090-01-02T10:00:00','device_id','N308')));
  perform pg_temp.payroll_assert((overlapping->>'inserted_count')::int=1 and (overlapping->>'duplicate_count')::int=3,
    'partially overlapping range imports only the new punch');
  perform pg_temp.payroll_assert((select count(*)=3 from public.payroll_attendance_raw where employee_id=employee)
    and (select name=original_name from public.payroll_employees where id=employee),
    'overlap does not overwrite original employee or punch data');
  imported:=public.payroll_import('second-device.xlsx',jsonb_build_array(
    jsonb_build_object('device_user_id',device_user,'name',original_name,'occurred_at','2090-01-01 10:00','device_id','N309')));
  perform pg_temp.payroll_assert((imported->>'inserted_count')::int=1,'device ID participates in deduplication');

  select count(*) into before_imports from public.payroll_imports;
  select count(*) into before_employees from public.payroll_employees;
  invalid_payload:=jsonb_build_array(
    jsonb_build_object('device_user_id','INVALID-'||suffix,'name','Must roll back','occurred_at','2090-01-01 10:00','device_id','N308'),
    jsonb_build_object('device_user_id','INVALID-'||suffix,'name','Must roll back','occurred_at','2090-02-30 20:00','device_id','N308'));
  rejected:=false;
  begin perform public.payroll_import('invalid.xlsx',invalid_payload);
  exception when others then rejected:=true; end;
  perform pg_temp.payroll_assert(rejected and (select count(*)=before_imports from public.payroll_imports)
    and (select count(*)=before_employees from public.payroll_employees),'invalid payload is atomic, without partially created employees/imports');

  insert into public.payroll_terms(employee_id,effective_from,pay_type,rate) values(employee,'2090-01-01','hourly',30000);
  select version into before_revision from public.payroll_revision where id=1;
  insert into public.payroll_days(employee_id,work_date,day_type,reason)
    values(employee,'2090-01-03','rest','Scheduled weekly rest');
  select version into after_revision from public.payroll_revision where id=1;
  perform pg_temp.payroll_assert(after_revision=before_revision+1,'schedule change invalidates prior calculations');
  rejected:=false;
  begin insert into public.payroll_days(employee_id,work_date,day_type,check_in,check_out,reason)
    values(employee,'2090-01-04','work','2090-01-04 10:00','2090-01-05 11:00','Unsupported 25-hour override');
  exception when check_violation then rejected:=true; end;
  perform pg_temp.payroll_assert(rejected,'manual correction limit matches the 24-hour client calculation window');
  -- Same column set as PostgREST upsert: the generated insert ID must never
  -- replace the existing row ID during an employee/date conflict update.
  insert into public.payroll_days(employee_id,work_date,day_type,check_in,check_out,reason)
    values(employee,'2090-01-03','paid_leave',null,null,'Reviewed paid leave')
    on conflict(employee_id,work_date) do update set day_type=excluded.day_type,
      check_in=excluded.check_in,check_out=excluded.check_out,reason=excluded.reason;
  perform pg_temp.payroll_assert((select count(*)=1 from public.payroll_days where employee_id=employee and work_date='2090-01-03')
    and exists(select 1 from public.payroll_audit where table_name='payroll_days' and action='UPDATE'
      and after_data->>'employee_id'=employee::text and before_data->>'day_type'='rest' and after_data->>'day_type'='paid_leave'),
    'PostgREST-style calendar upsert preserves one row and records previous day type');
  rejected:=false;
  begin perform public.payroll_finalize(employee,'2090-01-01',1000,100,50,'{"unresolved":0}',before_revision);
  exception when others then rejected:=sqlerrm='PAYROLL_STALE_RELOAD_REQUIRED'; end;
  perform pg_temp.payroll_assert(rejected,'stale snapshot cannot finalize');
  select version into rev from public.payroll_revision where id=1;

  rejected:=false;
  begin perform public.payroll_finalize(employee,'2090-01-01',1000,100,50,'{}',rev);
  exception when others then rejected:=true; end;
  perform pg_temp.payroll_assert(rejected,'missing unresolved flag fails closed');
  rejected:=false;
  begin perform public.payroll_finalize(employee,'2090-01-01',1000,100,50,'{"unresolved":null}',rev);
  exception when others then rejected:=true; end;
  perform pg_temp.payroll_assert(rejected,'null unresolved flag fails closed');
  rejected:=false;
  begin perform public.payroll_finalize(employee,'2090-01-01',1000,100,50,'{"unresolved":"0"}',rev);
  exception when others then rejected:=true; end;
  perform pg_temp.payroll_assert(rejected,'string unresolved flag fails closed');
  rejected:=false;
  begin perform public.payroll_finalize(employee,'2090-01-01',1000,100,50,'{"unresolved":1}',rev);
  exception when others then rejected:=true; end;
  perform pg_temp.payroll_assert(rejected,'unresolved attendance blocks finalization');
  rejected:=false;
  begin insert into public.payroll_runs(employee_id,month,base_amount,allowances,deductions,total,snapshot,expected_revision)
    values(employee,'2090-01-01',1000,0,0,1000,'{"unresolved":1}',rev);
  exception when others then rejected:=true; end;
  perform pg_temp.payroll_assert(rejected,'direct REST run insertion also checks unresolved attendance');
  rejected:=false;
  begin perform public.payroll_finalize(employee,'2090-01-01','NaN'::numeric,0,0,'{"unresolved":0}',rev);
  exception when others then rejected:=true; end;
  perform pg_temp.payroll_assert(rejected,'NaN salary rejected');
  rejected:=false;
  begin perform public.payroll_finalize(employee,'2090-01-01',-1,0,0,'{"unresolved":0}',rev);
  exception when others then rejected:=true; end;
  perform pg_temp.payroll_assert(rejected,'negative salary rejected');

  saved_snapshot:='{"unresolved":0,"worked_minutes":480,"rule_version":1}';
  v_run_id:=public.payroll_finalize(employee,'2090-01-01',1000,100,50,saved_snapshot,rev);
  perform pg_temp.payroll_assert((select total=1050 and snapshot=saved_snapshot from public.payroll_runs where id=v_run_id),
    'approved salary is persisted with immutable calculation snapshot');
  rejected:=false;
  begin perform public.payroll_finalize(employee,'2090-01-01',1000,100,50,saved_snapshot,rev);
  exception when unique_violation then rejected:=true; end;
  perform pg_temp.payroll_assert(rejected,'employee/month may only be finalized once');

  pay_id:=public.payroll_pay(v_run_id,300,'2090-02-01','cash','cash receipt','partial payment',request_key);
  retry_id:=public.payroll_pay(v_run_id,300,'2090-02-01','cash','cash receipt','partial payment',request_key);
  perform pg_temp.payroll_assert(pay_id=retry_id and (select count(*)=1 from public.payroll_payments where run_id=v_run_id),
    'identical payment retry returns original payment without inserting again');
  rejected:=false;
  begin perform public.payroll_pay(v_run_id,301,'2090-02-01','cash','cash receipt','partial payment',request_key);
  exception when others then rejected:=sqlerrm='PAYROLL_PAYMENT_REQUEST_CONFLICT'; end;
  perform pg_temp.payroll_assert(rejected,'reused payment request cannot change amount');
  perform public.payroll_pay(v_run_id,500,'2090-02-02','bank','bank-transaction-1','second instalment',gen_random_uuid());
  perform pg_temp.payroll_assert((select 1050-sum(p.amount)=250 from public.payroll_payments p where p.run_id=v_run_id),
    'mixed cash and bank payments leave the correct balance');
  rejected:=false;
  begin perform public.payroll_pay(v_run_id,251,'2090-02-03','cash','','',gen_random_uuid());
  exception when others then rejected:=true; end;
  perform pg_temp.payroll_assert(rejected,'overpayment RPC rejected');
  rejected:=false;
  begin insert into public.payroll_payments(run_id,amount,paid_on,method,request_id)
    values(v_run_id,251,'2090-02-03','cash',gen_random_uuid());
  exception when others then rejected:=true; end;
  perform pg_temp.payroll_assert(rejected,'direct REST payment insert cannot bypass overpayment guard');
  perform public.payroll_pay(v_run_id,250,'2090-02-03','cash','','balance',gen_random_uuid());
  perform pg_temp.payroll_assert((select sum(p.amount)=1050 and count(*)=3 from public.payroll_payments p where p.run_id=v_run_id),
    'final payment exactly closes the balance');

  rejected:=false;
  begin update public.payroll_runs set base_amount=2,total=52 where id=v_run_id;
  exception when others then rejected:=true; end;
  perform pg_temp.payroll_assert(rejected,'finalized salary cannot be overwritten');
  rejected:=false;
  begin update public.payroll_attendance_raw set occurred_at=occurred_at+interval '1 minute' where employee_id=employee;
  exception when others then rejected:=true; end;
  perform pg_temp.payroll_assert(rejected,'raw punches cannot be overwritten');
  rejected:=false;
  begin delete from public.payroll_attendance_raw where employee_id=employee;
  exception when others then rejected:=true; end;
  perform pg_temp.payroll_assert(rejected,'raw punches cannot be deleted');
  rejected:=false;
  begin update public.payroll_terms set rate=1 where employee_id=employee;
  exception when others then rejected:=true; end;
  perform pg_temp.payroll_assert(rejected,'historical pay terms cannot be overwritten');
  rejected:=false;
  begin update public.payroll_revision set version=version+1 where id=1;
  exception when others then rejected:=true; end;
  perform pg_temp.payroll_assert(rejected,'client cannot forge source revision');
  rejected:=false;
  begin insert into public.payroll_audit(table_name,record_id,action,after_data,created_by)
    values('payroll_employees',employee,'UPDATE','{}',actor);
  exception when others then rejected:=true; end;
  perform pg_temp.payroll_assert(rejected,'client cannot forge audit entries');
  update public.payroll_employees set name='Reviewed employee name' where id=employee;
  perform pg_temp.payroll_assert(exists(select 1 from public.payroll_audit where record_id=employee
    and action='UPDATE' and before_data->>'name'=original_name and after_data->>'name'='Reviewed employee name'),
    'employee edits retain previous and new values in audit trail');
  perform pg_temp.payroll_assert((select snapshot=saved_snapshot and total=1050 from public.payroll_runs where id=v_run_id),
    'later source edits never mutate finalized salary');

  foreach role_name in array array['manager','staff'] loop
    perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated','app_metadata',jsonb_build_object('role',role_name))::text,true);
    perform pg_temp.payroll_assert((select count(*)=0 from public.payroll_employees)
      and (select count(*)=0 from public.payroll_runs) and (select count(*)=0 from public.payroll_payments)
      and (select count(*)=0 from public.payroll_attendance_raw) and (select count(*)=0 from public.payroll_audit),
      role_name||' cannot read any private payroll rows');
    rejected:=false;
    begin perform public.payroll_import('forbidden.xlsx',punches);
    exception when insufficient_privilege then rejected:=true; end;
    perform pg_temp.payroll_assert(rejected,role_name||' cannot call import RPC');
    rejected:=false;
    begin insert into public.payroll_employees(device_user_id,name) values('FORBIDDEN-'||suffix,'Forbidden');
    exception when insufficient_privilege then rejected:=true; end;
    perform pg_temp.payroll_assert(rejected,role_name||' cannot insert directly');
    rejected:=false;
    begin perform public.payroll_pay(v_run_id,1,'2090-02-04','cash','','',gen_random_uuid());
    exception when insufficient_privilege then rejected:=true; end;
    perform pg_temp.payroll_assert(rejected,role_name||' cannot record a payment');
  end loop;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated',
    'app_metadata',jsonb_build_object('role','staff'),'user_metadata',jsonb_build_object('role','admin'))::text,true);
  rejected:=false;
  begin perform public.payroll_import('forged-user-metadata.xlsx',punches);
  exception when insufficient_privilege then rejected:=true; end;
  perform pg_temp.payroll_assert(rejected,'editable user metadata cannot grant admin payroll access');

  execute 'set local role postgres';
  execute 'set local role anon';
  rejected:=false;
  begin select count(*) into n from public.payroll_employees;
  exception when insufficient_privilege then rejected:=true; end;
  perform pg_temp.payroll_assert(rejected,'anonymous visitor has no table read grant');
  rejected:=false;
  begin perform public.payroll_import('anonymous.xlsx',punches);
  exception when insufficient_privilege then rejected:=true; end;
  perform pg_temp.payroll_assert(rejected,'anonymous visitor has no RPC execution grant');
  execute 'set local role postgres';
  raise notice 'Payroll DB contract passed: import replay, overlap, atomic validation, admin-only RLS, immutable snapshots, audit and payment safety.';
end;
$$;
rollback;
