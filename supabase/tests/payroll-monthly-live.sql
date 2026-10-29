-- Live-safe, rollback-only smoke test. Run the whole file as a database owner.
-- Reads aggregate counts only; never clears, restores, exports or changes an
-- existing employee. A global payroll lock prevents concurrent count drift.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
create function pg_temp.payroll_live_assert(p_ok boolean,p_message text) returns void language plpgsql as $$
begin if p_ok is distinct from true then raise exception 'FAIL: %',p_message;end if;end;$$;
do $$
declare actor uuid:='00000000-0000-4000-8000-000000000006';employee uuid;term_id uuid;t text;n bigint;
  tables constant text[]:=array['payroll_revision','payroll_employees','payroll_terms','payroll_imports','payroll_attendance_raw',
    'payroll_days','payroll_runs','payroll_payments','payroll_audit','payroll_rule_versions','payroll_reviews',
    'payroll_run_adjustments','payroll_payment_reversals','payroll_attachments'];
  before_counts jsonb:='{}';after_counts jsonb:='{}';before_revision bigint;invalid_rate numeric;rejected boolean;
  suffix text:=gen_random_uuid()::text;
begin
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated','app_metadata',jsonb_build_object('role','admin'))::text,true);
  execute 'set local role authenticated';
  select version into before_revision from public.payroll_revision where id=1 for update;
  perform pg_temp.payroll_live_assert(before_revision is not null,'payroll revision exists');
  foreach t in array tables loop
    execute format('select count(*) from public.%I',t) into n;
    before_counts:=before_counts||jsonb_build_object(t,n);
  end loop;
  begin
    insert into public.payroll_employees(device_user_id,name)
      values('ROLLBACK-SMOKE-'||suffix,'Temporary rollback-only payroll check') returning id into employee;
    foreach invalid_rate in array array[-1::numeric,0.5,1000000001,'NaN'::numeric,'Infinity'::numeric] loop
      rejected:=false;
      begin insert into public.payroll_terms(employee_id,effective_from,pay_type,rate,monthly_extra_hourly_rate)
        values(employee,'2099-01-01','monthly',7000000,invalid_rate);
      exception when check_violation then rejected:=true;end;
      perform pg_temp.payroll_live_assert(rejected,'optional legacy rate rejects negative, fractional, oversized or nonfinite values');
    end loop;
    insert into public.payroll_terms(employee_id,effective_from,pay_type,rate)
      values(employee,'2099-01-01','monthly',7000000) returning id into term_id;
    perform pg_temp.payroll_live_assert((select monthly_settlement='monthly_net' and monthly_extra_hourly_rate is null
      and weekly_rest_day=0 and break_start='12:00'::time and break_end='14:00'::time from public.payroll_terms where id=term_id),
      'admin can create monthly terms without a separate rate, with the intended rest day and break defaults');
    insert into public.payroll_terms(employee_id,effective_from,pay_type,rate,monthly_extra_hourly_rate)
      values(employee,'2099-01-02','monthly',7000000,null);
    perform pg_temp.payroll_live_assert((select monthly_extra_hourly_rate is null from public.payroll_terms where employee_id=employee and effective_from='2099-01-02'),
      'explicit NULL extra rate from the current UI is accepted');
    rejected:=false;
    begin insert into public.payroll_terms(employee_id,effective_from,pay_type,rate,monthly_extra_hourly_rate,weekly_rest_day)
      values(employee,'2099-02-01','monthly',7000000,30000,7);
    exception when check_violation then rejected:=true;end;
    perform pg_temp.payroll_live_assert(rejected,'weekly rest weekday must be in 0..6');
    rejected:=false;
    begin insert into public.payroll_terms(employee_id,effective_from,pay_type,rate,monthly_extra_hourly_rate,monthly_settlement)
      values(employee,'2099-02-01','monthly',7000000,30000,'unknown');
    exception when check_violation then rejected:=true;end;
    perform pg_temp.payroll_live_assert(rejected,'settlement mode is constrained');
    insert into public.payroll_terms(employee_id,effective_from,pay_type,rate,monthly_settlement,break_start,break_end,weekly_rest_day)
      values(employee,'2099-02-01','monthly',7000000,'statutory','13:00','15:00',6);
    perform pg_temp.payroll_live_assert((select monthly_extra_hourly_rate is null and break_start='13:00'::time
      and break_end='15:00'::time and weekly_rest_day=6 from public.payroll_terms where employee_id=employee and effective_from='2099-02-01'),
      'explicit previous mode, schedule and rest weekday remain available in a new immutable version');
    rejected:=false;
    begin update public.payroll_terms set monthly_extra_hourly_rate=50000 where id=term_id;
    exception when insufficient_privilege then rejected:=true;end;
    perform pg_temp.payroll_live_assert(rejected,'persisted term versions remain immutable');
    perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated','app_metadata',jsonb_build_object('role','manager'))::text,true);
    perform pg_temp.payroll_live_assert((select count(*)=0 from public.payroll_terms where id=term_id),'manager cannot read the payroll fixture');
    rejected:=false;
    begin insert into public.payroll_terms(employee_id,effective_from,pay_type,rate,monthly_extra_hourly_rate)
      values(employee,'2099-03-01','monthly',7000000,30000);
    exception when insufficient_privilege then rejected:=true;end;
    perform pg_temp.payroll_live_assert(rejected,'manager cannot write monthly payroll terms');
    -- A private sentinel rolls back the successful fixture writes, audit entries,
    -- revision changes and local role claims while preserving test variables.
    raise exception using errcode='ZX004',message='ROLLBACK_LIVE_SMOKE_FIXTURE';
  exception when sqlstate 'ZX004' then null;
  end;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated','app_metadata',jsonb_build_object('role','admin'))::text,true);
  foreach t in array tables loop
    execute format('select count(*) from public.%I',t) into n;
    after_counts:=after_counts||jsonb_build_object(t,n);
  end loop;
  perform pg_temp.payroll_live_assert(after_counts=before_counts,'every original payroll table count is unchanged after fixture rollback');
  perform pg_temp.payroll_live_assert((select version=before_revision from public.payroll_revision where id=1)
    and not exists(select 1 from public.payroll_employees where device_user_id='ROLLBACK-SMOKE-'||suffix),
    'the original revision is preserved and the temporary employee no longer exists');
  raise notice 'Live-safe monthly payroll smoke passed: defaults, rate constraints, immutable terms, admin/manager access, original counts and revision preserved.';
end;$$;
rollback;
