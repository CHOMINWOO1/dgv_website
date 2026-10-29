-- Empty, isolated database only. Never clear a real ledger to run this test.
begin;
create function pg_temp.advance_backup_assert(p_ok boolean,p_message text) returns void language plpgsql as $$
begin if p_ok is distinct from true then raise exception 'FAIL: %',p_message;end if;end;$$;
do $$
declare actor uuid:='00000000-0000-4000-8000-000000000014';emp uuid;run uuid;payment uuid;advance uuid;open_advance uuid;
  revision bigint;legacy jsonb;payload jsonb;bad jsonb;restored jsonb;rejected boolean;path text;
begin
  perform pg_temp.advance_backup_assert(not exists(select 1 from public.payroll_employees),'advance backup test requires initially empty payroll');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'app_metadata',jsonb_build_object('role','admin'))::text,true);
  execute 'set local role authenticated';
  begin
    insert into public.payroll_employees(device_user_id,name) values('ADV-BACKUP-'||gen_random_uuid(),'Legacy payment fixture') returning id into emp;
    insert into public.payroll_terms(employee_id,effective_from,pay_type,rate,monthly_settlement) values(emp,'2090-01-01','monthly',1000,'statutory');
    select version into revision from public.payroll_revision where id=1;
    run:=public.payroll_finalize(emp,'2090-01-01',1000,0,0,'{"unresolved":0}',revision);
    payment:=public.payroll_pay(run,300,'2090-02-05','cash','','',gen_random_uuid());
    legacy:=public.payroll_backup();
    legacy:=jsonb_set(legacy,'{tables,payroll_payments}',(select jsonb_agg(value-array['employee_id','payroll_month'])
      from jsonb_array_elements(legacy->'tables'->'payroll_payments')));
    raise exception using errcode='ZX012',message='ROLLBACK_LEGACY_ADVANCE_FIXTURE';
  exception when sqlstate 'ZX012' then null;end;
  bad:=jsonb_set(legacy,'{tables,payroll_payments,0,employee_id}',to_jsonb(gen_random_uuid()));
  rejected:=false;begin perform public.payroll_restore(bad);exception when foreign_key_violation then rejected:=true;end;
  perform pg_temp.advance_backup_assert(rejected and not exists(select 1 from public.payroll_employees),
    'explicit mismatched backup binding fails atomically instead of being silently replaced');
  execute 'set local role postgres';
  perform pg_temp.advance_backup_assert(not exists(select 1 from pg_trigger g join pg_class c on c.oid=g.tgrelid
    join pg_namespace n on n.oid=c.relnamespace where not g.tgisinternal and c.relname like 'payroll_%'
      and n.nspname in ('public','private','payroll_kiosk') and g.tgenabled<>'O'),'failed restore leaves all payroll guards enabled');
  execute 'set local role authenticated';
  begin
    perform public.payroll_restore(legacy);
    perform pg_temp.advance_backup_assert((select run_id=run and employee_id=emp and payroll_month='2090-01-01' and amount=300
      and paid_on='2090-02-05' from public.payroll_payments where id=payment)
      and (select paid=300 and balance=700 from public.payroll_run_balances where run_id=run),
      'legacy version-2 archive derives only missing employee/month fields from its original run');
    raise exception using errcode='ZX013',message='ROLLBACK_LEGACY_ADVANCE_RESTORE';
  exception when sqlstate 'ZX013' then null;end;
  begin
    insert into public.payroll_employees(device_user_id,name) values('NEW-ADV-BACKUP-'||gen_random_uuid(),'Advance archive fixture') returning id into emp;
    advance:=public.payroll_pay_advance(emp,'2090-01-01',500,'2090-01-15','cash','','',gen_random_uuid());
    open_advance:=public.payroll_pay_advance(emp,'2090-02-01',100,'2090-01-25','bank','','',gen_random_uuid());
    path:=advance::text||'/'||gen_random_uuid()::text||'.png';
    insert into storage.objects(bucket_id,name,metadata) values('payroll-evidence',path,'{"size":64,"mimetype":"image/png"}');
    insert into public.payroll_attachments(payment_id,storage_path,filename,mime_type,byte_size,evidence_type,signed_name,acknowledged_at)
      values(advance,path,'signed-advance.png','image/png',64,'signature','Archive recipient',now());
    insert into public.payroll_terms(employee_id,effective_from,pay_type,rate,monthly_settlement) values(emp,'2090-01-01','monthly',300,'statutory');
    select version into revision from public.payroll_revision where id=1;
    run:=public.payroll_finalize(emp,'2090-01-01',300,0,0,'{"unresolved":0}',revision);
    payload:=public.payroll_backup();
    raise exception using errcode='ZX014',message='ROLLBACK_ADVANCE_ARCHIVE_FIXTURE';
  exception when sqlstate 'ZX014' then null;end;
  restored:=public.payroll_restore(payload);
  perform pg_temp.advance_backup_assert((restored->>'restored')::boolean
    and (select run_id is null and employee_id=emp and payroll_month='2090-01-01' from public.payroll_payments where id=advance)
    and (select total=300 and paid=500 and balance=-200 from public.payroll_run_balances where run_id=run),
    'new archive retains advance identity and truthful overpayment after finalization');
  perform pg_temp.advance_backup_assert((select run_id is null and payroll_month='2090-02-01' and amount=100 from public.payroll_payments where id=open_advance)
    and not exists(select 1 from public.payroll_runs where employee_id=emp and month='2090-02-01'),
    'unfinalized monthly advance restores without an invented run');
  perform pg_temp.advance_backup_assert((select count(*)=1 from public.payroll_attachments where payment_id=advance and storage_path=path)
    and jsonb_array_length(restored->'missing_evidence')=1,'advance signature metadata survives and missing binary recovery remains explicit');
  perform pg_temp.advance_backup_assert((public.payroll_restore(payload)->>'replayed')::boolean,'same advance archive restore is idempotent');
end;$$;
rollback;
