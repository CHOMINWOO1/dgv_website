-- Isolated PostgreSQL regression for phone-captured payment signatures.
-- Storage object metadata is a test fixture, not a real uploaded PNG. Run via
-- tests/payroll-db.mjs, never by directly writing production storage.objects.
begin;
set local lock_timeout='5s';set local statement_timeout='60s';
create function pg_temp.signature_assert(p_ok boolean,p_message text) returns void language plpgsql as $$
begin if p_ok is distinct from true then raise exception 'FAIL: %',p_message;end if;end;$$;
do $$
declare actor uuid:='00000000-0000-4000-8000-000000000012';emp uuid;run uuid;cash_pay uuid;bank_pay uuid;unsigned_pay uuid;
  attachment uuid;cash_path text;bank_path text;bad_path text;revision bigint;rejected boolean;role_name text;
begin
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'app_metadata',jsonb_build_object('role','admin'))::text,true);
  execute 'set local role authenticated';
  insert into public.payroll_employees(device_user_id,name) values('SIGNATURE-'||gen_random_uuid(),'Phone signature fixture') returning id into emp;
  insert into public.payroll_terms(employee_id,effective_from,pay_type,rate,monthly_settlement) values(emp,'2093-01-01','monthly',1000,'statutory');
  select version into revision from public.payroll_revision where id=1;
  run:=public.payroll_finalize(emp,'2093-01-01',1000,0,0,'{"unresolved":0}',revision);
  cash_pay:=public.payroll_pay(run,400,'2093-02-05','cash','First installment','',gen_random_uuid());
  bank_pay:=public.payroll_pay(run,300,'2093-02-06','bank','Second installment','',gen_random_uuid());
  unsigned_pay:=public.payroll_pay(run,300,'2093-02-07','cash','No signature yet','',gen_random_uuid());
  perform pg_temp.signature_assert((select count(*)=0 from public.payroll_attachments where payment_id in (cash_pay,bank_pay,unsigned_pay))
    and (select paid=1000 from public.payroll_run_balances where run_id=run),'unsigned payments remain real payments without invented signatures');
  cash_path:=cash_pay::text||'/'||gen_random_uuid()::text||'.png';
  bank_path:=bank_pay::text||'/'||gen_random_uuid()::text||'.png';
  insert into storage.objects(bucket_id,name,metadata) values('payroll-evidence',cash_path,'{"size":512,"mimetype":"image/png"}'),
    ('payroll-evidence',bank_path,'{"size":768,"mimetype":"image/png"}');
  rejected:=false;
  begin insert into public.payroll_attachments(payment_id,storage_path,filename,mime_type,byte_size,evidence_type,acknowledged_at)
    values(cash_pay,cash_path,'signature.png','image/png',512,'signature',now());exception when check_violation then rejected:=true;end;
  perform pg_temp.signature_assert(rejected,'signature must name its recipient');
  rejected:=false;
  begin insert into public.payroll_attachments(payment_id,storage_path,filename,mime_type,byte_size,evidence_type,signed_name,acknowledged_at)
    values(cash_pay,cash_path,'signature.png','image/png',512,'signature','   ',now());exception when check_violation then rejected:=true;end;
  perform pg_temp.signature_assert(rejected,'blank signer name is rejected');
  rejected:=false;
  begin insert into public.payroll_attachments(payment_id,storage_path,filename,mime_type,byte_size,evidence_type,signed_name)
    values(cash_pay,cash_path,'signature.png','image/png',512,'signature','Phone recipient');exception when check_violation then rejected:=true;end;
  perform pg_temp.signature_assert(rejected,'signature must record explicit acknowledgement time');
  rejected:=false;
  begin insert into public.payroll_attachments(payment_id,storage_path,filename,mime_type,byte_size,evidence_type,signed_name,acknowledged_at)
    values(cash_pay,cash_path,'signature.png','image/png',512,'signature','Phone recipient',now()+interval '1 hour');
  exception when others then rejected:=sqlerrm='PAYROLL_INVALID_SIGNATURE_ACKNOWLEDGEMENT';end;
  perform pg_temp.signature_assert(rejected,'far-future acknowledgement is rejected');
  rejected:=false;
  begin insert into public.payroll_attachments(payment_id,storage_path,filename,mime_type,byte_size,evidence_type,signed_name,acknowledged_at)
    values(cash_pay,cash_path,'signature.png','image/png',513,'signature','Phone recipient',now());
  exception when others then rejected:=sqlerrm='PAYROLL_EVIDENCE_OBJECT_MISMATCH';end;
  perform pg_temp.signature_assert(rejected,'stored signature size must match the object');
  rejected:=false;
  begin insert into public.payroll_attachments(payment_id,storage_path,filename,mime_type,byte_size,evidence_type,signed_name,acknowledged_at)
    values(cash_pay,cash_pay::text||'/'||gen_random_uuid()::text||'.png','missing.png','image/png',512,'signature','Phone recipient',now());
  exception when others then rejected:=sqlerrm='PAYROLL_EVIDENCE_OBJECT_MISMATCH';end;
  perform pg_temp.signature_assert(rejected,'metadata alone cannot claim a nonexistent signature image');
  rejected:=false;
  begin insert into public.payroll_attachments(payment_id,storage_path,filename,mime_type,byte_size,evidence_type,signed_name,acknowledged_at)
    values(bank_pay,cash_path,'signature.png','image/png',512,'signature','Phone recipient',now());
  exception when others then rejected:=sqlerrm='PAYROLL_EVIDENCE_PAYMENT_PATH_MISMATCH';end;
  perform pg_temp.signature_assert(rejected,'one installment cannot reuse another installment signature path');
  bad_path:=cash_pay::text||'/'||gen_random_uuid()::text||'.jpg';
  insert into storage.objects(bucket_id,name,metadata) values('payroll-evidence',bad_path,'{"size":512,"mimetype":"image/jpeg"}');
  rejected:=false;
  begin insert into public.payroll_attachments(payment_id,storage_path,filename,mime_type,byte_size,evidence_type,signed_name,acknowledged_at)
    values(cash_pay,bad_path,'signature.jpg','image/jpeg',512,'signature','Phone recipient',now());
  exception when others then rejected:=sqlerrm='PAYROLL_INVALID_SIGNATURE_ACKNOWLEDGEMENT';end;
  perform pg_temp.signature_assert(rejected,'signature capture must be PNG even though other evidence accepts JPEG');
  rejected:=false;
  begin insert into storage.objects(bucket_id,name,metadata) values('payroll-evidence',gen_random_uuid()::text||'/'||gen_random_uuid()::text||'.png','{"size":1,"mimetype":"image/png"}');
  exception when insufficient_privilege then rejected:=true;end;
  perform pg_temp.signature_assert(rejected,'signature storage path must belong to an actual payment');

  select version into revision from public.payroll_revision where id=1;
  insert into public.payroll_attachments(payment_id,storage_path,filename,mime_type,byte_size,evidence_type,signed_name,acknowledged_at)
    values(cash_pay,cash_path,'signature.png','image/png',512,'signature','Phone recipient',now()) returning id into attachment;
  perform pg_temp.signature_assert((select version=revision+1 from public.payroll_revision where id=1)
    and (select count(*)=1 from public.payroll_audit where table_name='payroll_attachments' and record_id=attachment),
    'signature insertion is audited and invalidates stale report snapshots');
  insert into public.payroll_attachments(payment_id,storage_path,filename,mime_type,byte_size,evidence_type,signed_name,acknowledged_at)
    values(bank_pay,bank_path,'signature.png','image/png',768,'signature','Second receipt name',now());
  perform pg_temp.signature_assert((select count(*)=1 from public.payroll_attachments where payment_id=cash_pay)
    and (select count(*)=1 from public.payroll_attachments where payment_id=bank_pay)
    and (select count(*)=0 from public.payroll_attachments where payment_id=unsigned_pay),'signature status is per payment, not per employee or salary month');
  rejected:=false;
  begin insert into public.payroll_attachments(payment_id,storage_path,filename,mime_type,byte_size,evidence_type,signed_name,acknowledged_at)
    values(cash_pay,cash_path,'retry.png','image/png',512,'signature','Phone recipient',now());exception when unique_violation then rejected:=true;end;
  perform pg_temp.signature_assert(rejected and (select count(*)=1 from public.payroll_attachments where payment_id=cash_pay),
    'an already saved path cannot create duplicate metadata on retry');
  rejected:=false;begin update public.payroll_attachments set payment_id=bank_pay where id=attachment;exception when others then rejected:=true;end;
  perform pg_temp.signature_assert(rejected,'saved signature cannot be reassigned to another payment');
  rejected:=false;begin delete from public.payroll_attachments where id=attachment;exception when others then rejected:=true;end;
  perform pg_temp.signature_assert(rejected,'saved signature metadata cannot be deleted');
  begin update storage.objects set metadata='{"size":1,"mimetype":"image/png"}' where bucket_id='payroll-evidence' and name=cash_path;
  exception when insufficient_privilege then null;end;
  begin delete from storage.objects where bucket_id='payroll-evidence' and name=cash_path;
  exception when insufficient_privilege then null;end;
  perform pg_temp.signature_assert((select metadata->>'size'='512' from storage.objects where bucket_id='payroll-evidence' and name=cash_path),
    'administrator upload flow cannot overwrite or remove an existing signature object');

  perform public.payroll_reverse_payment(cash_pay,'Receipt retained but payment entry cancelled',gen_random_uuid());
  perform pg_temp.signature_assert((select count(*)=1 from public.payroll_attachments where id=attachment and payment_id=cash_pay)
    and (select count(*)=1 from storage.objects where bucket_id='payroll-evidence' and name=cash_path),
    'cancelling a payment preserves its original signature evidence');
  perform pg_temp.signature_assert((select paid=600 and balance=400 from public.payroll_run_balances where run_id=run)
    and (select count(*)=1 from public.payroll_attachments a join public.payroll_payments p on p.id=a.payment_id
      where p.run_id=run and a.evidence_type='signature' and not exists(select 1 from public.payroll_payment_reversals v where v.payment_id=p.id)),
    'reversed signature remains history and does not count as an active paid receipt');

  foreach role_name in array array['manager','staff'] loop
    perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'app_metadata',jsonb_build_object('role',role_name),
      'user_metadata',jsonb_build_object('role','admin'))::text,true);
    perform pg_temp.signature_assert((select count(*)=0 from public.payroll_attachments where payment_id in (cash_pay,bank_pay))
      and (select count(*)=0 from storage.objects where bucket_id='payroll-evidence'),role_name||' cannot read signature metadata or private files');
    rejected:=false;
    begin insert into public.payroll_attachments(payment_id,storage_path,filename,mime_type,byte_size,evidence_type,signed_name,acknowledged_at)
      values(unsigned_pay,unsigned_pay::text||'/'||gen_random_uuid()::text||'.png','unauthorized.png','image/png',1,'signature','Forged',now());
    exception when insufficient_privilege then rejected:=true;end;
    perform pg_temp.signature_assert(rejected,role_name||' cannot append signature metadata despite user_metadata spoof');
    rejected:=false;
    begin insert into storage.objects(bucket_id,name,metadata) values('payroll-evidence',unsigned_pay::text||'/'||gen_random_uuid()::text||'.png','{"size":1,"mimetype":"image/png"}');
    exception when insufficient_privilege then rejected:=true;end;
    perform pg_temp.signature_assert(rejected,role_name||' cannot upload a signature object');
  end loop;
  perform set_config('request.jwt.claims','{}',true);execute 'set local role anon';
  rejected:=false;begin perform 1 from public.payroll_attachments;exception when insufficient_privilege then rejected:=true;end;
  perform pg_temp.signature_assert(rejected,'anonymous phone visitors have no payroll signature access');
  execute 'set local role postgres';
  perform pg_temp.signature_assert(not has_table_privilege('payroll_kiosk_writer','public.payroll_attachments','SELECT')
    and not has_schema_privilege('payroll_kiosk_writer','storage','USAGE'),'attendance device capability cannot read or submit payroll signatures');
end;$$;
rollback;
