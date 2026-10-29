-- Live-safe rollback smoke. Random-ID fixtures only; no existing employee,
-- payment, signature, Storage object or audit is read in detail or changed.
-- No trigger suspension, table clearing, backup restoration or real file upload.
begin;
set local lock_timeout='5s';set local statement_timeout='30s';
create function pg_temp.advance_live_assert(p_ok boolean,p_message text) returns void language plpgsql as $$
begin if p_ok is distinct from true then raise exception 'FAIL: %',p_message;end if;end;$$;
do $$
declare actor uuid:='00000000-0000-4000-8000-000000000015';emp uuid:=gen_random_uuid();payment uuid;run uuid;overpaid_run uuid;
  request uuid:=gen_random_uuid();revision bigint;original_revision bigint;counts_before jsonb:='{}';counts_after jsonb:='{}';t record;n bigint;rejected boolean;
begin
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'app_metadata',jsonb_build_object('role','admin'))::text,true);
  execute 'set local role authenticated';
  select version into original_revision from public.payroll_revision where id=1 for update;
  execute 'set local role postgres';
  for t in select n.nspname,c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('public','private','payroll_kiosk') and c.relkind='r' and c.relname like 'payroll_%' order by 1,2 loop
    execute format('select count(*) from %I.%I',t.nspname,t.relname) into n;
    counts_before:=counts_before||jsonb_build_object(t.nspname||'.'||t.relname,n);
  end loop;
  execute 'set local role authenticated';
  begin
    insert into public.payroll_employees(id,device_user_id,name,employment_type) values(emp,'ROLLBACK-ADVANCE-'||emp,'Temporary money-ledger smoke','part_time');
    payment:=public.payroll_pay_advance(emp,'2094-01-01',100,'2094-01-10','cash','rollback fixture','',request);
    perform pg_temp.advance_live_assert(public.payroll_pay_advance(emp,'2094-01-01',100,'2094-01-10','cash','rollback fixture','',request)=payment
      and (select count(*)=1 from public.payroll_payments where employee_id=emp),'early ad-hoc payment is idempotent before salary approval');
    insert into public.payroll_terms(employee_id,effective_from,pay_type,rate,monthly_settlement) values(emp,'2094-01-01','monthly',200,'statutory');
    select version into revision from public.payroll_revision where id=1;
    run:=public.payroll_finalize(emp,'2094-01-01',200,0,0,'{"unresolved":0}',revision);
    perform pg_temp.advance_live_assert((select paid=100 and balance=100 from public.payroll_run_balances where run_id=run)
      and (select run_id is null from public.payroll_payments where id=payment),'approval credits advance without rewriting it');
    rejected:=false;begin perform public.payroll_pay(run,101,'2094-02-05','cash','','',gen_random_uuid());
    exception when others then rejected:=sqlerrm='PAYROLL_OVERPAYMENT_OR_INVALID_AMOUNT';end;
    perform pg_temp.advance_live_assert(rejected,'regular payment cannot exceed remaining money');
    perform public.payroll_pay(run,100,'2094-02-05','bank','','',gen_random_uuid());
    perform pg_temp.advance_live_assert((select paid=200 and balance=0 from public.payroll_run_balances where run_id=run),'normal and advance payments settle one month once');
    perform public.payroll_pay_advance(emp,'2094-02-01',300,'2094-02-10','cash','','',gen_random_uuid());
    select version into revision from public.payroll_revision where id=1;
    overpaid_run:=public.payroll_finalize(emp,'2094-02-01',200,0,0,'{"unresolved":0}',revision);
    perform pg_temp.advance_live_assert((select total=200 and paid=300 and balance=-100 from public.payroll_run_balances where run_id=overpaid_run),
      'overpaid advance preserves truthful monthly approval and explicit negative balance');
    perform public.payroll_reverse_payment(payment,'Rollback reversal fixture',gen_random_uuid());
    perform pg_temp.advance_live_assert((select paid=100 and balance=100 from public.payroll_run_balances where run_id=run),
      'reversing the original advance restores remaining money');
    perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'app_metadata',jsonb_build_object('role','manager'),'user_metadata',jsonb_build_object('role','admin'))::text,true);
    rejected:=false;begin perform public.payroll_pay_advance(emp,'2094-03-01',1,'2094-02-10','cash','','',gen_random_uuid());exception when insufficient_privilege then rejected:=true;end;
    perform pg_temp.advance_live_assert(rejected,'manager cannot create advances');
    raise exception using errcode='ZX015',message='ROLLBACK_ADVANCE_LIVE_FIXTURES';
  exception when sqlstate 'ZX015' then null;end;
  execute 'set local role postgres';
  for t in select n.nspname,c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('public','private','payroll_kiosk') and c.relkind='r' and c.relname like 'payroll_%' order by 1,2 loop
    execute format('select count(*) from %I.%I',t.nspname,t.relname) into n;
    counts_after:=counts_after||jsonb_build_object(t.nspname||'.'||t.relname,n);
  end loop;
  perform pg_temp.advance_live_assert(counts_after=counts_before and (select version=original_revision from public.payroll_revision where id=1)
    and not exists(select 1 from public.payroll_employees where id=emp),'all existing payroll counts and revision are preserved and every fixture is rolled back');
end;$$;
rollback;
