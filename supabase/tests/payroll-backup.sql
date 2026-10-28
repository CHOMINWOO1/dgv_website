-- Rollback-only backup/restore integration. Run on an empty payroll database
-- (the isolated harness provides one); never clear existing records to run this.
begin;
set local lock_timeout='5s';set local statement_timeout='60s';
create function pg_temp.payroll_backup_assert(p_ok boolean,p_message text) returns void language plpgsql as $$
begin if p_ok is distinct from true then raise exception 'FAIL: %',p_message;end if;end;$$;
do $$
declare actor uuid:='00000000-0000-4000-8000-000000000003';v_employee uuid;v_run uuid;v_pay uuid;v_import jsonb;
  v_payload jsonb;v_bad jsonb;v_result jsonb;v_after jsonb;v_path text;v_revision bigint;v_rules_version bigint;
  rejected boolean;v_count bigint;v_sensitive uuid;suffix text:=gen_random_uuid()::text;
begin
  perform pg_temp.payroll_backup_assert(not exists(select 1 from public.payroll_employees)
    and not exists(select 1 from public.payroll_audit),'restore integration requires an initially empty payroll database');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated','app_metadata',jsonb_build_object('role','admin'))::text,true);
  execute 'set local role authenticated';
  -- Generate a real valid archive, then roll back fixture writes in an inner
  -- subtransaction. PL/pgSQL retains the variable containing the archive.
  begin
    v_import:=public.payroll_import('backup-fixture.xlsx',jsonb_build_array(
      jsonb_build_object('device_user_id','BACKUP-'||suffix,'name','Backup fixture','occurred_at','2096-01-01T10:00:00','device_id','1'),
      jsonb_build_object('device_user_id','BACKUP-'||suffix,'name','Backup fixture','occurred_at','2096-01-01T20:00:00','device_id','1')));
    select id into v_employee from public.payroll_employees where device_user_id='BACKUP-'||suffix;
    insert into public.payroll_terms(employee_id,effective_from,pay_type,rate) values(v_employee,'2096-01-01','monthly',1000);
    insert into public.payroll_rule_versions(effective_from,reason) values('2096-01-01','Backup rule') returning version into v_rules_version;
    v_sensitive:=public.payroll_set_sensitive(v_employee,'{"bank_account":"BACKUP-PRIVATE-ACCOUNT"}','Backup encrypted test');
    select version into v_revision from public.payroll_revision where id=1;
    v_run:=public.payroll_finalize(v_employee,'2096-01-01',1000,0,0,'{"unresolved":0}',v_revision);
    perform public.payroll_adjust_run(v_run,100,'Restorable adjustment',gen_random_uuid());
    v_pay:=public.payroll_pay(v_run,500,'2096-02-01','cash','old receipt','Restorable reversal',gen_random_uuid());
    perform public.payroll_reverse_payment(v_pay,'Wrong payment entry',gen_random_uuid());
    v_pay:=public.payroll_pay(v_run,1100,'2096-02-02','bank','new receipt','Restorable payment',gen_random_uuid());
    v_path:=v_pay::text||'/'||gen_random_uuid()::text||'.pdf';
    insert into storage.objects(bucket_id,name,metadata) values('payroll-evidence',v_path,'{"size":256,"mimetype":"application/pdf"}');
    insert into public.payroll_attachments(payment_id,storage_path,filename,mime_type,byte_size,evidence_type)
      values(v_pay,v_path,'tax-invoice.pdf','application/pdf',256,'tax_invoice');
    v_payload:=public.payroll_backup();
    perform pg_temp.payroll_backup_assert(v_payload->>'format'='DGV_PAYROLL_BACKUP'
      and jsonb_array_length(v_payload->'sensitive')=1 and v_payload->'sensitive'->0->'data'->>'bank_account'='BACKUP-PRIVATE-ACCOUNT',
      'admin backup includes all encrypted detail versions for immediate client encryption');
    rejected:=false;
    begin perform public.payroll_restore(v_payload);exception when others then rejected:=sqlerrm='PAYROLL_RESTORE_REQUIRES_EMPTY_DATABASE';end;
    perform pg_temp.payroll_backup_assert(rejected,'restore never overwrites existing payroll');
    raise exception using errcode='ZX001',message='ROLLBACK_BACKUP_FIXTURE';
  exception when sqlstate 'ZX001' then null;
  end;
  perform pg_temp.payroll_backup_assert(v_payload is not null and not exists(select 1 from public.payroll_employees),
    'fixture transaction rolled back while valid archive remains in memory');

  v_bad:=jsonb_set(jsonb_set(v_payload,'{tables,payroll_runs,0,base_amount}','500'),'{tables,payroll_runs,0,total}','500');
  rejected:=false;
  begin perform public.payroll_restore(v_bad);exception when others then rejected:=sqlerrm='PAYROLL_BACKUP_INCONSISTENT_BALANCES_OR_SNAPSHOT';end;
  perform pg_temp.payroll_backup_assert(rejected and not exists(select 1 from public.payroll_employees)
    and not exists(select 1 from public.payroll_audit),'invalid balance rejects the entire restore without partial rows');
  execute 'set local role postgres';
  perform pg_temp.payroll_backup_assert(not exists(select 1 from pg_trigger g join pg_class c on c.oid=g.tgrelid
    join pg_namespace n on n.oid=c.relnamespace where not g.tgisinternal and c.relname like 'payroll_%'
      and n.nspname in ('public','private') and g.tgenabled<>'O'),'failed restore rolls back every trigger-state change');
  execute 'set local role authenticated';

  v_result:=public.payroll_restore(v_payload);
  perform pg_temp.payroll_backup_assert((v_result->>'restored')::boolean and not (v_result->>'replayed')::boolean
    and jsonb_array_length(v_result->'missing_evidence')=1,'restore reports missing evidence bytes without claiming complete files');
  perform pg_temp.payroll_backup_assert((select version>v_revision from public.payroll_revision where id=1),
    'restoration advances the live source revision so pre-restore drafts are stale');
  rejected:=false;
  begin perform public.payroll_finalize(v_employee,'2096-02-01',1000,0,0,'{"unresolved":0}',v_revision);
  exception when others then rejected:=sqlerrm='PAYROLL_STALE_RELOAD_REQUIRED';end;
  perform pg_temp.payroll_backup_assert(rejected,'a pre-restore calculation cannot finalize after recovery');
  perform pg_temp.payroll_backup_assert((select total=1000 from public.payroll_runs where id=v_run)
    and (select total=1100 and paid=1100 and balance=0 from public.payroll_run_balances where run_id=v_run)
    and (select count(*)=2 from public.payroll_payments where run_id=v_run),
    'restored immutable salary, correction, original payments and reversal produce the same balance');
  perform pg_temp.payroll_backup_assert(public.payroll_get_sensitive(v_employee)->>'bank_account'='BACKUP-PRIVATE-ACCOUNT',
    'restored sensitive details are newly encrypted and readable through admin RPC');
  v_after:=public.payroll_backup();
  perform pg_temp.payroll_backup_assert(v_after->'tables'->'payroll_employees'=v_payload->'tables'->'payroll_employees'
    and v_after->'tables'->'payroll_runs'=v_payload->'tables'->'payroll_runs'
    and v_after->'sensitive'=v_payload->'sensitive','restore preserves record IDs, original actors/timestamps and sensitive version metadata');
  perform pg_temp.payroll_backup_assert(jsonb_array_length(v_after->'tables'->'payroll_audit')=
    jsonb_array_length(v_payload->'tables'->'payroll_audit')+1,'restoration appends one audit receipt while retaining original history');

  insert into storage.objects(bucket_id,name,metadata) values('payroll-evidence',v_path,'{"size":256,"mimetype":"application/pdf"}');
  v_result:=public.payroll_restore(v_payload);
  perform pg_temp.payroll_backup_assert(not (v_result->>'restored')::boolean and (v_result->>'replayed')::boolean
    and jsonb_array_length(v_result->'missing_evidence')=0,'identical retry resumes evidence checking without inserting database rows again');
  perform pg_temp.payroll_backup_assert((select count(*)=1 from public.payroll_employees)
    and (select count(*)=2 from public.payroll_payments),'restore replay leaves original counts unchanged');
  insert into public.payroll_rule_versions(effective_from,reason) values('2096-02-01','Rule after restore') returning version into v_count;
  perform pg_temp.payroll_backup_assert(v_count>v_rules_version,'generated rule versions continue above the restored sequence');
  rejected:=false;
  begin update public.payroll_runs set total=1,base_amount=1 where id=v_run;exception when others then rejected:=true;end;
  perform pg_temp.payroll_backup_assert(rejected,'immutable guard is enabled after successful restore');

  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated','app_metadata',jsonb_build_object('role','manager'))::text,true);
  rejected:=false;
  begin perform public.payroll_backup();exception when insufficient_privilege then rejected:=true;end;
  perform pg_temp.payroll_backup_assert(rejected,'manager cannot export decrypted payroll backup');
  rejected:=false;
  begin perform private.payroll_restore(v_payload);exception when insufficient_privilege then rejected:=true;end;
  perform pg_temp.payroll_backup_assert(rejected,'manager cannot bypass restore public wrapper');
  execute 'set local role postgres';
  raise notice 'Payroll backup passed: empty-only restore, rollback-safe triggers, preserved history, encrypted-data handling, evidence resume and idempotent retry.';
end; $$;
rollback;
