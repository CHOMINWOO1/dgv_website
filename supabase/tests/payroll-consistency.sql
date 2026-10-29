-- Rollback-only report consistency and immutable review retry coverage.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
create function pg_temp.payroll_consistency_assert(p_ok boolean,p_message text) returns void language plpgsql as $$
begin if p_ok is distinct from true then raise exception 'FAIL: %',p_message;end if;end;$$;
do $$
declare employee uuid;v_run uuid;payment_id uuid;review_id uuid;new_review_id uuid;adjustment_id uuid;reversal_id uuid;
  rev bigint;before_rev bigint;request uuid:=gen_random_uuid();adjust_request uuid:=gen_random_uuid();reverse_request uuid:=gen_random_uuid();
  v_path text;rejected boolean;suffix text:=gen_random_uuid()::text;
begin
  perform set_config('request.jwt.claims',jsonb_build_object('sub','00000000-0000-4000-8000-000000000004','role','authenticated','app_metadata',jsonb_build_object('role','admin'))::text,true);
  execute 'set local role authenticated';
  insert into public.payroll_employees(device_user_id,name) values('CONSISTENT-'||suffix,'Read consistency test') returning id into employee;
  insert into public.payroll_terms(employee_id,effective_from,pay_type,rate,monthly_settlement) values(employee,'2097-01-01','monthly',1000,'statutory');
  select version into rev from public.payroll_revision where id=1;
  review_id:=public.payroll_review(employee,'2097-01-01','{"unresolved":0,"baseAmount":1000}','Initial review',rev);
  perform pg_temp.payroll_consistency_assert((select version=rev from public.payroll_revision where id=1),'review does not invalidate its own finalization revision');
  perform pg_temp.payroll_consistency_assert(public.payroll_review(employee,'2097-01-01','{"baseAmount":1000,"unresolved":0}','Initial review',rev)=review_id,
    'lost-response review retry returns the same immutable row');
  new_review_id:=public.payroll_review(employee,'2097-01-01','{"unresolved":0,"baseAmount":1200}','Corrected discretionary amount',rev);
  perform pg_temp.payroll_consistency_assert(new_review_id<>review_id and (select count(*)=2 from public.payroll_reviews where employee_id=employee),
    'revised manual review at the same source revision preserves both snapshots');
  perform pg_temp.payroll_consistency_assert((select version=rev from public.payroll_revision where id=1),'multiple immutable reviews leave calculation revision unchanged');
  v_run:=public.payroll_finalize(employee,'2097-01-01',1200,0,0,'{"unresolved":0,"baseAmount":1200}',rev);
  perform pg_temp.payroll_consistency_assert((select version=rev+1 from public.payroll_revision where id=1),'new finalized salary invalidates a mixed report read');

  select version into before_rev from public.payroll_revision where id=1;
  payment_id:=public.payroll_pay(v_run,500,'2097-02-01','cash','Receipt','Partial payment',request);
  perform pg_temp.payroll_consistency_assert((select version=before_rev+1 from public.payroll_revision where id=1),'new payment invalidates a mixed report read');
  perform pg_temp.payroll_consistency_assert(public.payroll_pay(v_run,500,'2097-02-01','cash','Receipt','Partial payment',request)=payment_id
    and (select version=before_rev+1 from public.payroll_revision where id=1),'identical payment retry neither adds money nor changes revision');
  rejected:=false;
  begin perform public.payroll_finalize(employee,'2097-02-01',1000,0,0,'{"unresolved":0}',before_rev);
  exception when others then rejected:=sqlerrm='PAYROLL_STALE_RELOAD_REQUIRED';end;
  perform pg_temp.payroll_consistency_assert(rejected,'a payment committed during a draft/report read requires fresh data');
  rejected:=false;
  begin perform public.payroll_review(employee,'2097-01-01','{"unresolved":0,"baseAmount":1000}','Initial review',rev);
  exception when others then rejected:=sqlerrm='PAYROLL_STALE_RELOAD_REQUIRED';end;
  perform pg_temp.payroll_consistency_assert(rejected,'historical exact review cannot bypass the current revision check');

  select version into before_rev from public.payroll_revision where id=1;
  adjustment_id:=public.payroll_adjust_run(v_run,100,'Approved extra amount',adjust_request);
  perform pg_temp.payroll_consistency_assert(public.payroll_adjust_run(v_run,100,'Approved extra amount',adjust_request)=adjustment_id
    and (select version=before_rev+1 from public.payroll_revision where id=1),'adjustment increments once, retry remains idempotent');
  select version into before_rev from public.payroll_revision where id=1;
  reversal_id:=public.payroll_reverse_payment(payment_id,'Cancelled entry',reverse_request);
  perform pg_temp.payroll_consistency_assert(public.payroll_reverse_payment(payment_id,'Cancelled entry',reverse_request)=reversal_id
    and (select version=before_rev+1 from public.payroll_revision where id=1),'reversal increments once, retry remains idempotent');

  select version into before_rev from public.payroll_revision where id=1;
  insert into public.payroll_payments(run_id,amount,paid_on,method,request_id)
    values(v_run,100,'2097-02-02','bank',gen_random_uuid());
  perform pg_temp.payroll_consistency_assert((select version=before_rev+1 from public.payroll_revision where id=1),'direct REST-style payment also participates in report serialization');
  v_path:=payment_id::text||'/'||gen_random_uuid()::text||'.pdf';
  insert into storage.objects(bucket_id,name,metadata) values('payroll-evidence',v_path,'{"size":64,"mimetype":"application/pdf"}');
  select version into before_rev from public.payroll_revision where id=1;
  insert into public.payroll_attachments(payment_id,storage_path,filename,mime_type,byte_size,evidence_type)
    values(payment_id,v_path,'cancelled-receipt.pdf','application/pdf',64,'receipt');
  perform pg_temp.payroll_consistency_assert((select version=before_rev+1 from public.payroll_revision where id=1),'new evidence metadata invalidates tax/report reads');
  rejected:=false;
  begin perform public.payroll_pay(v_run,2000,'2097-02-02','cash','','',gen_random_uuid());
  exception when others then rejected:=true;end;
  perform pg_temp.payroll_consistency_assert(rejected and (select version=before_rev+1 from public.payroll_revision where id=1),
    'rejected overpayment leaves the read revision and money unchanged');
  perform pg_temp.payroll_consistency_assert((select total=1300 and paid=100 and balance=1200 from public.payroll_run_balances where run_id=v_run),
    'serialization preserves corrected and reversed payment balances');
  raise notice 'Payroll report consistency passed: money/evidence invalidation, immutable review revisions, idempotent retries and stale draft protection.';
end;$$;
rollback;
