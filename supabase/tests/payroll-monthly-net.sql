-- Rollback-only terms, immutable history and old/new archive compatibility.
-- Requires an empty isolated payroll database, as does payroll-backup.sql.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
create function pg_temp.payroll_net_assert(p_ok boolean,p_message text) returns void language plpgsql as $$
begin if p_ok is distinct from true then raise exception 'FAIL: %',p_message;end if;end;$$;
do $$
declare actor uuid:='00000000-0000-4000-8000-000000000005';employee uuid;old_term uuid;new_term uuid;v_run uuid;
  invalid_rate numeric;invalid_day smallint;v_revision bigint;rejected boolean;old_terms jsonb;old_punches jsonb;
  legacy_payload jsonb;current_payload jsonb;bad_payload jsonb;v_result jsonb;v_import jsonb;suffix text:=gen_random_uuid()::text;
begin
  perform pg_temp.payroll_net_assert(not exists(select 1 from public.payroll_employees)
    and not exists(select 1 from public.payroll_audit),'archive compatibility test requires empty payroll tables');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated','app_metadata',jsonb_build_object('role','admin'))::text,true);
  execute 'set local role authenticated';
  begin
    v_import:=public.payroll_import('net-fixture.xlsx',jsonb_build_array(
      jsonb_build_object('device_user_id','NET-'||suffix,'name','Monthly settlement fixture','occurred_at','2098-01-03T10:00:00','device_id','1'),
      jsonb_build_object('device_user_id','NET-'||suffix,'name','Monthly settlement fixture','occurred_at','2098-01-03T20:00:00','device_id','1')));
    select id into employee from public.payroll_employees where device_user_id='NET-'||suffix;
    -- A historical version retains its original mode and explicit break times.
    insert into public.payroll_terms(employee_id,effective_from,pay_type,rate,monthly_settlement,break_start,break_end)
      values(employee,'2098-01-01','monthly',8000000,'statutory','13:00','15:00') returning id into old_term;
    select to_jsonb(t) into old_terms from public.payroll_terms t where id=old_term;
    select jsonb_agg(to_jsonb(r) order by id) into old_punches from public.payroll_attendance_raw r where employee_id=employee;
    select version into v_revision from public.payroll_revision where id=1;
    v_run:=public.payroll_finalize(employee,'2098-01-01',8000000,0,0,'{"unresolved":0,"calculationVersion":2,"preserved":"historical salary"}',v_revision);
    legacy_payload:=public.payroll_backup();
    -- Simulate a genuine pre-upgrade version-2 archive, omitting only the keys
    -- that were not present before this migration. Break times stay explicit.
    legacy_payload:=jsonb_set(legacy_payload,'{tables,payroll_terms}',
      (select jsonb_agg(value-'monthly_settlement'-'monthly_extra_hourly_rate'-'weekly_rest_day')
        from jsonb_array_elements(legacy_payload->'tables'->'payroll_terms')));

    foreach invalid_rate in array array[-1::numeric,0.5,1000000001,'NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric] loop
      rejected:=false;
      begin
        insert into public.payroll_terms(employee_id,effective_from,pay_type,rate,monthly_extra_hourly_rate)
          values(employee,'2098-02-01','monthly',8000000,invalid_rate);
      exception when check_violation then rejected:=true;end;
      perform pg_temp.payroll_net_assert(rejected,'legacy optional rate still rejects invalid historical values: '||invalid_rate::text);
    end loop;
    foreach invalid_day in array array[-1,7]::smallint[] loop
      rejected:=false;
      begin insert into public.payroll_terms(employee_id,effective_from,pay_type,rate,monthly_extra_hourly_rate,weekly_rest_day)
        values(employee,'2098-02-01','monthly',8000000,30000,invalid_day);
      exception when check_violation then rejected:=true;end;
      perform pg_temp.payroll_net_assert(rejected,'weekly rest must be exactly one weekday 0..6');
    end loop;
    rejected:=false;
    begin insert into public.payroll_terms(employee_id,effective_from,pay_type,rate,monthly_settlement,monthly_extra_hourly_rate)
      values(employee,'2098-02-01','monthly',8000000,'unknown',30000);
    exception when check_violation then rejected:=true;end;
    perform pg_temp.payroll_net_assert(rejected,'unknown settlement mode is rejected');
    insert into public.payroll_terms(employee_id,effective_from,pay_type,rate)
      values(employee,'2098-02-01','monthly',8000000) returning id into new_term;
    perform pg_temp.payroll_net_assert((select monthly_settlement='monthly_net' and monthly_extra_hourly_rate is null
      and weekly_rest_day=0 and break_start='12:00'::time and break_end='14:00'::time from public.payroll_terms where id=new_term),
      'new monthly terms need no separate extra rate and retain one weekly rest day and noon break defaults');
    insert into public.payroll_terms(employee_id,effective_from,pay_type,rate,monthly_extra_hourly_rate)
      values(employee,'2098-02-02','monthly',8000000,null);
    insert into public.payroll_terms(employee_id,effective_from,pay_type,rate,monthly_extra_hourly_rate)
      values(employee,'2098-02-03','monthly',8000000,30000);
    insert into public.payroll_terms(employee_id,effective_from,pay_type,rate,monthly_extra_hourly_rate)
      values(employee,'2098-02-04','monthly',8000000,0);
    perform pg_temp.payroll_net_assert((select monthly_extra_hourly_rate is null from public.payroll_terms where employee_id=employee and effective_from='2098-02-02')
      and (select monthly_extra_hourly_rate=30000 from public.payroll_terms where employee_id=employee and effective_from='2098-02-03')
      and (select monthly_extra_hourly_rate=0 from public.payroll_terms where employee_id=employee and effective_from='2098-02-04'),
      'explicit NULL is accepted and old optional rate values remain restorable without a required-rate constraint');
    insert into public.payroll_terms(employee_id,effective_from,pay_type,rate,weekly_rest_day)
      values(employee,'2098-03-01','hourly',30000,6);
    perform pg_temp.payroll_net_assert((select monthly_extra_hourly_rate is null and weekly_rest_day=6
      from public.payroll_terms where employee_id=employee and effective_from='2098-03-01'),
      'hourly terms do not require an unrelated monthly extra rate and can choose another rest weekday');
    perform pg_temp.payroll_net_assert((select to_jsonb(t)=old_terms from public.payroll_terms t where id=old_term)
      and (select jsonb_agg(to_jsonb(r) order by id)=old_punches from public.payroll_attendance_raw r where employee_id=employee)
      and (select total=8000000 and snapshot='{"unresolved":0,"calculationVersion":2,"preserved":"historical salary"}'::jsonb from public.payroll_runs where id=v_run),
      'new effective term versions never overwrite historical terms, raw punches or finalized salary');
    rejected:=false;
    begin update public.payroll_terms set monthly_extra_hourly_rate=50000 where id=new_term;
    exception when insufficient_privilege then rejected:=true;end;
    perform pg_temp.payroll_net_assert(rejected,'monthly settlement changes require a new immutable effective term');
    current_payload:=public.payroll_backup();
    perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated','app_metadata',jsonb_build_object('role','manager'))::text,true);
    perform pg_temp.payroll_net_assert((select count(*)=0 from public.payroll_terms),'manager cannot read monthly pay conditions');
    rejected:=false;
    begin insert into public.payroll_terms(employee_id,effective_from,pay_type,rate,monthly_extra_hourly_rate)
      values(employee,'2098-04-01','monthly',8000000,30000);
    exception when insufficient_privilege then rejected:=true;end;
    perform pg_temp.payroll_net_assert(rejected,'manager cannot insert monthly settlement terms');
    raise exception using errcode='ZX002',message='ROLLBACK_NET_FIXTURE';
  exception when sqlstate 'ZX002' then null;
  end;
  -- Subtransaction rollback restores the original administrator claims as well.
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated','app_metadata',jsonb_build_object('role','admin'))::text,true);
  perform pg_temp.payroll_net_assert(not exists(select 1 from public.payroll_employees),'fixture rows rolled back before restore tests');
  bad_payload:=jsonb_set(legacy_payload,'{tables,payroll_terms,0,monthly_settlement}','null');
  rejected:=false;
  begin perform public.payroll_restore(bad_payload);exception when not_null_violation then rejected:=true;end;
  perform pg_temp.payroll_net_assert(rejected and not exists(select 1 from public.payroll_employees),
    'legacy defaults never silently replace a present invalid settlement value; failed restore is atomic');
  bad_payload:=jsonb_set(current_payload,'{tables,payroll_terms}',
    (select jsonb_agg(case when value->>'id'=new_term::text then value-'monthly_extra_hourly_rate' else value end)
      from jsonb_array_elements(current_payload->'tables'->'payroll_terms')));
  begin
    v_result:=public.payroll_restore(bad_payload);
    perform pg_temp.payroll_net_assert((v_result->>'restored')::boolean
      and (select monthly_settlement='monthly_net' and monthly_extra_hourly_rate is null from public.payroll_terms where id=new_term),
      'a current monthly_net archive with no separate rate restores successfully');
    raise exception using errcode='ZX005',message='ROLLBACK_OPTIONAL_RATE_RESTORE';
  exception when sqlstate 'ZX005' then null;
  end;
  begin
    v_result:=public.payroll_restore(legacy_payload);
    perform pg_temp.payroll_net_assert((v_result->>'restored')::boolean
      and (select monthly_settlement='statutory' and monthly_extra_hourly_rate is null and weekly_rest_day=0
        and break_start='13:00'::time and break_end='15:00'::time from public.payroll_terms where id=old_term),
      'old version-2 backup defaults to statutory and retains historical break times');
    perform pg_temp.payroll_net_assert((select total=8000000 and snapshot='{"unresolved":0,"calculationVersion":2,"preserved":"historical salary"}'::jsonb from public.payroll_runs where id=v_run),
      'old archive restoration never recalculates finalized salary');
    v_result:=public.payroll_restore(legacy_payload);
    perform pg_temp.payroll_net_assert((v_result->>'replayed')::boolean,'legacy compatibility preserves the original payload retry fingerprint');
    raise exception using errcode='ZX003',message='ROLLBACK_LEGACY_RESTORE';
  exception when sqlstate 'ZX003' then null;
  end;
  v_result:=public.payroll_restore(current_payload);
  perform pg_temp.payroll_net_assert((v_result->>'restored')::boolean
    and (select monthly_settlement='monthly_net' and monthly_extra_hourly_rate is null and weekly_rest_day=0
      and break_start='12:00'::time and break_end='14:00'::time from public.payroll_terms where id=new_term),
    'current archive retains explicit monthly settlement fields rather than legacy compatibility defaults');
  perform pg_temp.payroll_net_assert((select monthly_extra_hourly_rate=30000 from public.payroll_terms where employee_id=employee and effective_from='2098-02-03'),
    'old stored extra-rate values survive backup restoration for historical compatibility');
  execute 'set local role postgres';
  perform pg_temp.payroll_net_assert(not exists(select 1 from pg_trigger g join pg_class c on c.oid=g.tgrelid
    join pg_namespace n on n.oid=c.relnamespace where not g.tgisinternal and c.relname like 'payroll_%'
      and n.nspname in ('public','private') and g.tgenabled<>'O'),'all payroll guards remain enabled after compatibility restores');
  raise notice 'Monthly settlement DB passed: optional legacy rates, new defaults, immutable history, manager denial, old/new archive restore and idempotence.';
end;$$;
rollback;
