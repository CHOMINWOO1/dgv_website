-- Rollback-only v2 coverage. Vault encryption itself is verified on Supabase;
-- isolated test runtimes may stub Vault but must still exercise access controls.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
create function pg_temp.payroll_v2_assert(p_ok boolean,p_message text) returns void language plpgsql as $$
begin if p_ok is distinct from true then raise exception 'FAIL: %',p_message;end if;end;$$;
do $$
declare actor uuid:='00000000-0000-4000-8000-000000000002';employee uuid;v_rule uuid;v_run uuid;v_pay uuid;v_second_pay uuid;
  v_adjust uuid;v_reverse uuid;v_review uuid;v_sensitive uuid;v_attachment uuid;v_version bigint;rev bigint;n bigint;
  v_request uuid:=gen_random_uuid();v_reverse_request uuid:=gen_random_uuid();v_adjust_request uuid:=gen_random_uuid();
  v_path text;role_name text;rejected boolean;data jsonb;suffix text:=gen_random_uuid()::text;
begin
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated','app_metadata',jsonb_build_object('role','admin'))::text,true);
  execute 'set local role authenticated';
  insert into public.payroll_employees(device_user_id,name,phone,employment_type,hire_date,payment_method)
    values('V2-'||suffix,'V2 rollback employee','0123456789','part_time','2095-01-01','mixed') returning id into employee;
  insert into public.payroll_rule_versions(effective_from,reason) values('2095-01-01','Rollback rule') returning id,version into v_rule,v_version;
  perform pg_temp.payroll_v2_assert((select not ot_enabled and regular_overtime_multiplier=1.5 and monthly_hour_basis='schedule' and pay_day=5 from public.payroll_rule_versions where id=v_rule),
    'rules have versioned explicit defaults but overtime starts disabled');
  rejected:=false;
  begin insert into public.payroll_rule_versions(effective_from,regular_overtime_multiplier,reason) values('2095-02-01',1.4,'Below minimum');
  exception when check_violation then rejected:=true;end;
  perform pg_temp.payroll_v2_assert(rejected,'overtime multipliers cannot be set below configured legal minima');
  rejected:=false;
  begin update public.payroll_rule_versions set regular_overtime_multiplier=2 where id=v_rule;
  exception when insufficient_privilege then rejected:=true;end;
  perform pg_temp.payroll_v2_assert(rejected,'rule versions are append-only');
  insert into public.payroll_terms(employee_id,effective_from,pay_type,rate,overtime_hourly_rate)
    values(employee,'2095-01-01','hourly',30000,30000);
  update public.payroll_employees set employment_status='leave' where id=employee;
  perform pg_temp.payroll_v2_assert((select not active from public.payroll_employees where id=employee),'leave status updates the legacy active flag');
  update public.payroll_employees set employment_status='active' where id=employee;
  perform pg_temp.payroll_v2_assert((select active from public.payroll_employees where id=employee),'active status updates the legacy active flag');

  rejected:=false;
  begin insert into public.payroll_days(employee_id,work_date,reason,overtime_approved,overtime_intervals)
    values(employee,'2095-01-02','Schedule','true','[{"start":"2095-01-02T20:00:00","end":"2095-01-02T21:00:00"}]');
  exception when others then rejected:=sqlerrm='PAYROLL_APPROVAL_REASON_REQUIRED';end;
  perform pg_temp.payroll_v2_assert(rejected,'overtime approval requires a separate reason');
  rejected:=false;
  begin insert into public.payroll_days(employee_id,work_date,reason,overtime_intervals)
    values(employee,'2095-01-02','Overlapping approval','[{"start":"2095-01-02T20:00:00","end":"2095-01-02T22:00:00"},{"start":"2095-01-02T21:00:00","end":"2095-01-02T23:00:00"}]');
  exception when others then rejected:=true;end;
  perform pg_temp.payroll_v2_assert(rejected,'overlapping approved intervals cannot double count time');
  perform public.payroll_check_intervals('[{"start":"2095-01-02T20:00:00","end":"2095-01-02T21:00:00"},{"start":"2095-01-02 21:00:00","end":"2095-01-02 22:00:00"}]','2095-01-02');
  insert into public.payroll_days(employee_id,work_date,reason,check_in,check_out,overtime_approved,night_approved,approval_reason,overtime_intervals,night_intervals)
    values(employee,'2095-01-02','Reviewed overnight shift','2095-01-02 10:00','2095-01-03 01:00',true,true,'Approved by administrator',
      '[{"start":"2095-01-02T20:00:00","end":"2095-01-03T01:00:00"}]',
      '[{"start":"2095-01-02T22:00:00","end":"2095-01-03T01:00:00"}]');

  v_sensitive:=public.payroll_set_sensitive(employee,'{"bank_name":"Test Bank","bank_account":"PRIVATE-TEST-ACCOUNT","account_holder":"Test Name","national_id":"PRIVATE-TEST-ID","tax_id":"TEST-TAX"}','Initial encrypted details');
  data:=public.payroll_get_sensitive(employee);
  perform pg_temp.payroll_v2_assert(data->>'bank_account'='PRIVATE-TEST-ACCOUNT','admin can decrypt the selected employee record');
  perform public.payroll_set_sensitive(employee,'{"bank_account":"PRIVATE-TEST-ACCOUNT-NEW"}','Corrected encrypted details');
  perform pg_temp.payroll_v2_assert(public.payroll_get_sensitive(employee)->>'bank_account'='PRIVATE-TEST-ACCOUNT-NEW','sensitive getter returns the latest encrypted version');
  perform pg_temp.payroll_v2_assert(not exists(select 1 from public.payroll_audit
    where coalesce(before_data::text,'') like '%PRIVATE-TEST%' or after_data::text like '%PRIVATE-TEST%'),
    'bank and national identity plaintext never appears in payroll audit JSON');
  rejected:=false;
  begin perform public.payroll_set_sensitive(employee,'{"password":"not-allowed"}','Bad field');
  exception when others then rejected:=true;end;
  perform pg_temp.payroll_v2_assert(rejected,'sensitive RPC accepts only the explicit bank/identity field allowlist');
  rejected:=false;
  begin select count(*) into n from private.payroll_sensitive_versions;
  exception when insufficient_privilege then rejected:=true;end;
  perform pg_temp.payroll_v2_assert(rejected,'browser admin cannot read the private Vault-reference table directly');

  select version into rev from public.payroll_revision where id=1;
  v_review:=public.payroll_review(employee,'2095-01-01','{"unresolved":0,"baseAmount":1000}','Reviewed hours and contract',rev);
  v_run:=public.payroll_finalize(employee,'2095-01-01',1000,0,0,'{"unresolved":0,"rule_version":1}',rev);
  v_adjust:=public.payroll_adjust_run(v_run,200,'Missed allowance',v_adjust_request);
  perform pg_temp.payroll_v2_assert(public.payroll_adjust_run(v_run,200,'Missed allowance',v_adjust_request)=v_adjust,'identical salary-adjustment retry is idempotent');
  perform pg_temp.payroll_v2_assert((select total=1000 from public.payroll_runs where id=v_run)
    and (select total=1200 and adjustment_total=200 from public.payroll_run_balances where run_id=v_run),'adjustment changes payable balance and preserves the original salary');
  v_pay:=public.payroll_pay(v_run,800,'2095-02-01','cash','Cash confirmation','Initial instalment',v_request);
  rejected:=false;
  begin perform public.payroll_adjust_run(v_run,-401,'Would reduce salary below amount already paid',gen_random_uuid());
  exception when others then rejected:=true;end;
  perform pg_temp.payroll_v2_assert(rejected,'salary correction cannot reduce total below non-reversed payments');
  perform public.payroll_adjust_run(v_run,-200,'Remove allowance',gen_random_uuid());
  perform pg_temp.payroll_v2_assert((select total=1000 and paid=800 and balance=200 from public.payroll_run_balances where run_id=v_run),'net payable accounts for both positive and negative corrections');
  v_reverse:=public.payroll_reverse_payment(v_pay,'Incorrect payment entry; receipt returned',v_reverse_request);
  perform pg_temp.payroll_v2_assert(public.payroll_reverse_payment(v_pay,'Incorrect payment entry; receipt returned',v_reverse_request)=v_reverse,
    'identical payment-reversal retry is idempotent');
  perform pg_temp.payroll_v2_assert((select amount=800 from public.payroll_payments where id=v_pay)
    and (select paid=0 and balance=1000 from public.payroll_run_balances where run_id=v_run),'reversal preserves original payment and restores unpaid balance');
  rejected:=false;
  begin perform public.payroll_reverse_payment(v_pay,'Attempt double reversal',gen_random_uuid());
  exception when unique_violation then rejected:=true;end;
  perform pg_temp.payroll_v2_assert(rejected,'one payment can be reversed only once');
  v_second_pay:=public.payroll_pay(v_run,1000,'2095-02-02','bank','Bank reference','Correct payment',gen_random_uuid());
  perform pg_temp.payroll_v2_assert((select paid=1000 and balance=0 from public.payroll_run_balances where run_id=v_run),'payment guard uses the corrected balance after reversal');
  rejected:=false;
  begin perform public.payroll_pay(v_run,1,'2095-02-02','cash','','',gen_random_uuid());
  exception when others then rejected:=true;end;
  perform pg_temp.payroll_v2_assert(rejected,'corrected/reversed history cannot bypass overpayment protection');

  v_path:=v_second_pay::text||'/'||gen_random_uuid()::text||'.png';
  insert into storage.objects(bucket_id,name,metadata) values('payroll-evidence',v_path,'{"size":128,"mimetype":"image/png"}');
  rejected:=false;
  begin insert into public.payroll_attachments(payment_id,storage_path,filename,mime_type,byte_size,evidence_type)
    values(v_second_pay,v_path,'signature.png','image/png',129,'receipt');
  exception when others then rejected:=true;end;
  perform pg_temp.payroll_v2_assert(rejected,'attachment metadata must match the stored object');
  rejected:=false;
  begin insert into public.payroll_attachments(payment_id,storage_path,filename,mime_type,byte_size,evidence_type)
    values(v_second_pay,v_path,'signature.png','image/png',128,'signature');
  exception when check_violation then rejected:=true;end;
  perform pg_temp.payroll_v2_assert(rejected,'signature evidence requires signer and receipt acknowledgement');
  insert into public.payroll_attachments(payment_id,storage_path,filename,mime_type,byte_size,evidence_type,signed_name,acknowledged_at)
    values(v_second_pay,v_path,'signature.png','image/png',128,'signature','Test recipient',now()) returning id into v_attachment;
  rejected:=false;
  begin update public.payroll_attachments set filename='changed.png' where id=v_attachment;
  exception when insufficient_privilege then rejected:=true;end;
  perform pg_temp.payroll_v2_assert(rejected,'saved receipt metadata is immutable');

  foreach role_name in array array['manager','staff'] loop
    perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated','app_metadata',jsonb_build_object('role',role_name))::text,true);
    perform pg_temp.payroll_v2_assert((select count(*)=0 from public.payroll_run_balances)
      and (select count(*)=0 from public.payroll_rule_versions) and (select count(*)=0 from public.payroll_reviews)
      and (select count(*)=0 from public.payroll_attachments) and (select count(*)=0 from storage.objects where bucket_id='payroll-evidence'),
      role_name||' cannot read rules, reviews, money, receipt metadata or stored evidence');
    rejected:=false;
    begin perform public.payroll_get_sensitive(employee);exception when insufficient_privilege then rejected:=true;end;
    perform pg_temp.payroll_v2_assert(rejected,role_name||' cannot decrypt bank/identity data');
    rejected:=false;
    begin perform private.payroll_get_sensitive(employee);exception when insufficient_privilege then rejected:=true;end;
    perform pg_temp.payroll_v2_assert(rejected,role_name||' cannot bypass public wrapper via private helper');
    rejected:=false;
    begin perform public.payroll_reverse_payment(v_second_pay,'Forbidden',gen_random_uuid());exception when insufficient_privilege then rejected:=true;end;
    perform pg_temp.payroll_v2_assert(rejected,role_name||' cannot reverse payment');
    rejected:=false;
    begin insert into storage.objects(bucket_id,name,metadata) values('payroll-evidence',v_second_pay::text||'/'||gen_random_uuid()::text||'.pdf','{"size":1,"mimetype":"application/pdf"}');
    exception when insufficient_privilege then rejected:=true;end;
    perform pg_temp.payroll_v2_assert(rejected,role_name||' cannot upload payroll evidence');
  end loop;
  execute 'set local role postgres';
  perform pg_temp.payroll_v2_assert((select not public and file_size_limit=5242880 from storage.buckets where id='payroll-evidence'),
    'payroll evidence bucket is private and size bounded');
  perform pg_temp.payroll_v2_assert((select count(*)=2 from private.payroll_sensitive_versions where employee_id=employee),
    'sensitive edits preserve two encrypted historical versions');
  perform pg_temp.payroll_v2_assert(not exists(select 1 from information_schema.columns where table_schema='public'
    and table_name like 'payroll_%' and column_name in ('bank_account','national_id','tax_id')),'sensitive fields have no public plaintext columns');
  raise notice 'Payroll v2 passed: versioned rules, approval intervals, encrypted-data access, immutable corrections/reversals, private receipt policy and acknowledgement.';
end; $$;
rollback;
