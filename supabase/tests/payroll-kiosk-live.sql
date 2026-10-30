-- Live-safe, rollback-only kiosk smoke. Creates random-ID fixtures, never reads
-- private field values of existing employees, and never changes existing rows,
-- disables triggers, clears tables, restores backups or sleeps for cooldowns.
begin;
set local lock_timeout='5s';set local statement_timeout='30s';
create function pg_temp.kiosk_live_assert(p_ok boolean,p_message text) returns void language plpgsql as $$
begin if p_ok is distinct from true then raise exception 'FAIL: %',p_message;end if;end;$$;
do $$
declare actor uuid:='00000000-0000-4000-8000-000000000010';dev uuid:=gen_random_uuid();emp uuid:=gen_random_uuid();
  token text:=encode(sha256(convert_to(gen_random_uuid()::text,'UTF8')),'hex');request uuid:=gen_random_uuid();
  grant_id uuid;event jsonb;revision bigint;counts_before jsonb:='{}';counts_after jsonb:='{}';t record;n bigint;rejected boolean;
begin
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'app_metadata',jsonb_build_object('role','admin'))::text,true);
  execute 'set local role authenticated';
  select version into revision from public.payroll_revision where id=1 for update;
  execute 'set local role postgres';
  for t in select n.nspname,c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('public','private','payroll_kiosk') and c.relkind='r' and c.relname like 'payroll_%' order by 1,2 loop
    execute format('select count(*) from %I.%I',t.nspname,t.relname) into n;
    counts_before:=counts_before||jsonb_build_object(t.nspname||'.'||t.relname,n);
  end loop;
  execute 'set local role authenticated';
  begin
    insert into public.payroll_employees(id,device_user_id,name) values(emp,'ROLLBACK-KIOSK-'||emp,'Temporary kiosk smoke');
    perform public.payroll_kiosk_register(dev,'Rollback-only tablet',token);
    grant_id:=public.payroll_kiosk_enroll(dev,emp,'rollback-smoke-consent');
    perform pg_temp.kiosk_live_assert(grant_id is not null,'administrator can register and enroll test fixture');
    perform set_config('request.jwt.claims','{}',true);execute 'set local role anon';
    perform pg_temp.kiosk_live_assert((select value->>'enrollment_id'=grant_id::text from jsonb_array_elements(public.payroll_kiosk_roster(token)->'employees') where value->>'id'=emp::text),'capability exposes matching enrollment for fixture employee');
    event:=public.payroll_kiosk_punch(token,emp,'in',request);
    perform pg_temp.kiosk_live_assert(event->>'punch_type'='in' and event->>'verification'='trusted_kiosk_verification'
      and abs(extract(epoch from (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')-(event->>'occurred_at')::timestamp))<5,'anonymous device punch uses server Vietnamese time');
    perform pg_temp.kiosk_live_assert(public.payroll_kiosk_punch(token,emp,'in',request)-'replayed'=event-'replayed','retry returns identical stored event');
    perform pg_temp.kiosk_live_assert(public.payroll_kiosk_receipt(token,request)-'replayed'=event-'replayed'
      and public.payroll_kiosk_receipt(token,gen_random_uuid()) is null,'receipt reads completion without creating unknown requests');
    rejected:=false;begin perform 1 from public.payroll_employees;exception when insufficient_privilege then rejected:=true;end;
    perform pg_temp.kiosk_live_assert(rejected,'device cannot directly read employee details');
    rejected:=false;begin perform 1 from payroll_kiosk.payroll_kiosk_devices;exception when insufficient_privilege then rejected:=true;end;
    perform pg_temp.kiosk_live_assert(rejected,'device cannot read credential hashes');
    perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'app_metadata',jsonb_build_object('role','manager'),'user_metadata',jsonb_build_object('role','admin'))::text,true);
    execute 'set local role authenticated';
    rejected:=false;begin perform public.payroll_kiosk_devices();exception when insufficient_privilege then rejected:=true;end;
    perform pg_temp.kiosk_live_assert(rejected,'manager cannot administer devices even with spoofed user metadata');
    perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'app_metadata',jsonb_build_object('role','admin'))::text,true);
    perform pg_temp.kiosk_live_assert((select count(*)=1 from public.payroll_attendance_raw where employee_id=emp),'repeated upload leaves one raw event');
    perform public.payroll_kiosk_unenroll(dev,emp,'Rollback consent withdrawal');
    rejected:=false;begin perform public.payroll_kiosk_punch(token,emp,'out',gen_random_uuid());exception when others then rejected:=sqlerrm='PAYROLL_KIOSK_EMPLOYEE_NOT_ENROLLED';end;
    perform pg_temp.kiosk_live_assert(rejected,'consent withdrawal blocks new events');
    perform public.payroll_kiosk_revoke(dev,'Rollback smoke complete');
    rejected:=false;begin perform public.payroll_kiosk_roster(token);exception when insufficient_privilege then rejected:=true;end;
    perform pg_temp.kiosk_live_assert(rejected,'revoked device cannot read roster');
    raise exception using errcode='ZX008',message='ROLLBACK_KIOSK_SMOKE_FIXTURES';
  exception when sqlstate 'ZX008' then null;
  end;
  execute 'set local role postgres';
  for t in select n.nspname,c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('public','private','payroll_kiosk') and c.relkind='r' and c.relname like 'payroll_%' order by 1,2 loop
    execute format('select count(*) from %I.%I',t.nspname,t.relname) into n;
    counts_after:=counts_after||jsonb_build_object(t.nspname||'.'||t.relname,n);
  end loop;
  perform pg_temp.kiosk_live_assert(counts_after=counts_before and (select version=revision from public.payroll_revision where id=1),
    'every original payroll/private table count and revision remains unchanged');
  perform pg_temp.kiosk_live_assert(not exists(select 1 from public.payroll_employees where id=emp)
    and not exists(select 1 from payroll_kiosk.payroll_kiosk_devices where id=dev),'all temporary fixture records are gone');
end;$$;
rollback;
