-- Run after hana_payroll_partial_day_times as database owner. All fixtures,
-- their audits, and revision changes are rolled back. No existing record is
-- updated or deleted and no trigger/RLS rule is disabled.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
create function pg_temp.partial_day_assert(p_ok boolean,p_message text) returns void language plpgsql as $$
begin if p_ok is distinct from true then raise exception 'FAIL: %',p_message;end if;end;$$;

do $$
declare
  actor uuid:='00000000-0000-4000-8000-000000000031';
  employee uuid;day_id uuid;revision_before bigint;t text;n bigint;rejected boolean;
  suffix text:=gen_random_uuid()::text;case_row record;
  tables constant text[]:=array['payroll_revision','payroll_employees','payroll_terms','payroll_imports',
    'payroll_attendance_raw','payroll_days','payroll_runs','payroll_payments','payroll_audit',
    'payroll_rule_versions','payroll_reviews','payroll_run_adjustments','payroll_payment_reversals','payroll_attachments'];
  before_counts jsonb:='{}';after_counts jsonb:='{}';
begin
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated','app_metadata',jsonb_build_object('role','admin'))::text,true);
  execute 'set local role authenticated';
  select version into revision_before from public.payroll_revision where id=1 for update;
  perform pg_temp.partial_day_assert(revision_before is not null,'revision row exists');
  foreach t in array tables loop
    execute format('select count(*) from public.%I',t) into n;
    before_counts:=before_counts||jsonb_build_object(t,n);
  end loop;
  begin
    insert into public.payroll_employees(device_user_id,name)
      values('ROLLBACK-PARTIAL-'||suffix,'Temporary independent attendance test') returning id into employee;
    insert into public.payroll_days(employee_id,work_date,check_in,reason)
      values(employee,'2099-10-01','2099-10-01 10:00','Temporary check-in only') returning id into day_id;
    perform pg_temp.partial_day_assert((select check_in='2099-10-01 10:00'::timestamp and check_out is null from public.payroll_days where id=day_id),'check-in only is saved');
    update public.payroll_days set check_in='2099-10-01 10:15',reason='Temporary edit check-in' where id=day_id;
    update public.payroll_days set check_out='2099-10-01 20:00',reason='Temporary add checkout' where id=day_id;
    perform pg_temp.partial_day_assert((select check_in='2099-10-01 10:15'::timestamp and check_out='2099-10-01 20:00'::timestamp from public.payroll_days where id=day_id),'individual edits retain the saved opposite endpoint');
    update public.payroll_days set check_in=null,reason='Temporary checkout-only correction' where id=day_id;
    perform pg_temp.partial_day_assert((select check_in is null and check_out='2099-10-01 20:00'::timestamp from public.payroll_days where id=day_id),'checkout alone is retained');
    update public.payroll_days set check_out='2099-10-02 04:00',reason='Temporary overnight checkout' where id=day_id;
    update public.payroll_days set check_in='2099-10-01 04:00',reason='Temporary exact 24-hour pair' where id=day_id;
    update public.payroll_days set check_in=null,check_out=null,reason='Temporary restore raw records' where id=day_id;
    perform pg_temp.partial_day_assert((select check_in is null and check_out is null from public.payroll_days where id=day_id),'both blank restores raw calculation');
    for case_row in select * from (values
      ('2099-09-30 10:00'::timestamp,null::timestamp,'check-in previous day'),
      ('2099-10-02 10:00'::timestamp,null::timestamp,'check-in next day'),
      ('infinity'::timestamp,null::timestamp,'infinite check-in'),
      (null::timestamp,'-infinity'::timestamp,'infinite checkout'),
      (null::timestamp,'2099-09-30 23:59'::timestamp,'checkout before work date'),
      (null::timestamp,'2099-10-03 00:00'::timestamp,'checkout two days later'),
      ('2099-10-01 10:00'::timestamp,'2099-10-01 10:00'::timestamp,'zero interval'),
      ('2099-10-01 10:00'::timestamp,'2099-10-01 09:59'::timestamp,'reverse interval'),
      ('2099-10-01 10:00'::timestamp,'2099-10-02 10:01'::timestamp,'more than 24 hours')
    ) as c(check_in,check_out,label) loop
      rejected:=false;
      begin
        update public.payroll_days d set check_in=case_row.check_in,check_out=case_row.check_out,reason='Invalid temporary case' where d.id=day_id;
      exception when check_violation then rejected:=true;end;
      perform pg_temp.partial_day_assert(rejected,case_row.label||' is rejected');
    end loop;
    rejected:=false;
    begin update public.payroll_days set reason='' where id=day_id;
    exception when check_violation then rejected:=true;end;
    perform pg_temp.partial_day_assert(rejected,'correction reason is still required');
    rejected:=false;
    begin update public.payroll_days set work_date='2099-10-02' where id=day_id;
    exception when others then rejected:=sqlerrm='PAYROLL_DAY_KEY_IMMUTABLE';end;
    perform pg_temp.partial_day_assert(rejected,'employee/date key remains immutable');
    perform pg_temp.partial_day_assert((select count(*)>=7 from public.payroll_audit where table_name='payroll_days' and record_id=day_id),'independent writes retain audit history');
    perform pg_temp.partial_day_assert((select version>revision_before from public.payroll_revision where id=1),'independent writes advance report revision');
    perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated','app_metadata',jsonb_build_object('role','manager'))::text,true);
    perform pg_temp.partial_day_assert((select count(*)=0 from public.payroll_days where id=day_id),'manager cannot read the fixture');
    rejected:=false;
    begin update public.payroll_days set check_in='2099-10-01 10:00' where id=day_id;
    exception when insufficient_privilege then rejected:=true;end;
    perform pg_temp.partial_day_assert(rejected,'manager cannot edit partial attendance');
    execute 'set local role anon';
    rejected:=false;
    begin perform id from public.payroll_days where id=day_id;
    exception when insufficient_privilege then rejected:=true;end;
    perform pg_temp.partial_day_assert(rejected,'anonymous access remains denied');
    raise exception using errcode='ZX031',message='ROLLBACK_PARTIAL_DAY_FIXTURE';
  exception when sqlstate 'ZX031' then null;
  end;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated','app_metadata',jsonb_build_object('role','admin'))::text,true);
  execute 'set local role authenticated';
  foreach t in array tables loop
    execute format('select count(*) from public.%I',t) into n;
    after_counts:=after_counts||jsonb_build_object(t,n);
  end loop;
  perform pg_temp.partial_day_assert(before_counts=after_counts,'all original payroll table counts are preserved');
  perform pg_temp.partial_day_assert((select version=revision_before from public.payroll_revision where id=1)
    and not exists(select 1 from public.payroll_employees where device_user_id='ROLLBACK-PARTIAL-'||suffix),'fixture and revision changes are rolled back');
end;$$;
rollback;
select 'PASS: partial attendance inserts/edits, date bounds, complete-pair limits, audit/revision and administrator-only access; all fixtures rolled back' as result;
