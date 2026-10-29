-- Isolated money-ledger regression; Storage metadata below is a fixture, not
-- an uploaded production object. All payment and signature records roll back.
begin;
create function pg_temp.advance_assert(p_ok boolean,p_message text) returns void language plpgsql as $$
begin if p_ok is distinct from true then raise exception 'FAIL: %',p_message;end if;end;$$;
do $$
declare actor uuid:='00000000-0000-4000-8000-000000000013';emp uuid;other_emp uuid;advance uuid;cancelled_advance uuid;other_month uuid;
  overpaid_advance uuid;run uuid;other_run uuid;regular uuid;revision bigint;after_revision bigint;request uuid:=gen_random_uuid();reverse_request uuid:=gen_random_uuid();
  path text;attachment uuid;rejected boolean;bad_amount numeric;role_name text;reverse_id uuid;
begin
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'app_metadata',jsonb_build_object('role','admin'))::text,true);
  execute 'set local role authenticated';
  insert into public.payroll_employees(device_user_id,name,employment_type) values('ADVANCE-'||gen_random_uuid(),'Advance fixture','part_time') returning id into emp;
  insert into public.payroll_employees(device_user_id,name) values('OVERPAID-'||gen_random_uuid(),'Overpayment fixture') returning id into other_emp;
  select version into revision from public.payroll_revision where id=1;
  advance:=public.payroll_pay_advance(emp,'2092-01-01',500,'2092-01-12','cash','Early payment','Actual money, no paid-hour allocation',request);
  perform pg_temp.advance_assert((select run_id is null and employee_id=emp and payroll_month='2092-01-01' and amount=500
    and paid_on='2092-01-12' and created_by=actor from public.payroll_payments where id=advance),'part-time money can be recorded before terms or monthly approval');
  select version into after_revision from public.payroll_revision where id=1;
  perform pg_temp.advance_assert(after_revision=revision+1 and public.payroll_pay_advance(emp,'2092-01-01',500,'2092-01-12','cash','Early payment','Actual money, no paid-hour allocation',request)=advance
    and (select version=after_revision from public.payroll_revision where id=1),'exact request retry preserves one row and one revision');
  rejected:=false;begin perform public.payroll_pay_advance(emp,'2092-01-01',501,'2092-01-12','cash','Early payment','Actual money, no paid-hour allocation',request);
  exception when others then rejected:=sqlerrm='PAYROLL_PAYMENT_REQUEST_CONFLICT';end;
  perform pg_temp.advance_assert(rejected,'request UUID cannot change an amount');
  rejected:=false;begin perform public.payroll_pay_advance(other_emp,'2092-01-01',500,'2092-01-12','cash','Early payment','Actual money, no paid-hour allocation',request);
  exception when others then rejected:=sqlerrm='PAYROLL_PAYMENT_REQUEST_CONFLICT';end;
  perform pg_temp.advance_assert(rejected,'request UUID cannot change employee');
  rejected:=false;begin perform public.payroll_pay_advance(emp,'2092-02-01',500,'2092-01-12','cash','Early payment','Actual money, no paid-hour allocation',request);
  exception when others then rejected:=sqlerrm='PAYROLL_PAYMENT_REQUEST_CONFLICT';end;
  perform pg_temp.advance_assert(rejected,'request UUID cannot change salary month');
  foreach bad_amount in array array[0::numeric,-1::numeric,1.5::numeric,'NaN'::numeric,'Infinity'::numeric] loop
    rejected:=false;begin perform public.payroll_pay_advance(emp,'2092-01-01',bad_amount,'2092-01-12','cash','','',gen_random_uuid());
    exception when others then rejected:=true;end;
    perform pg_temp.advance_assert(rejected,'advance amount must be a finite positive whole VND value');
  end loop;
  rejected:=false;begin perform public.payroll_pay_advance(emp,'2092-01-02',1,'2092-01-12','cash','','',gen_random_uuid());
  exception when check_violation then rejected:=true;end;
  perform pg_temp.advance_assert(rejected,'payroll month must be its first calendar day');
  rejected:=false;begin perform public.payroll_pay_advance(gen_random_uuid(),'2092-01-01',1,'2092-01-12','cash','','',gen_random_uuid());
  exception when foreign_key_violation then rejected:=true;end;
  perform pg_temp.advance_assert(rejected,'advance requires an actual employee');
  cancelled_advance:=public.payroll_pay_advance(emp,'2092-01-01',200,'2092-01-20','bank','','',gen_random_uuid());
  other_month:=public.payroll_pay_advance(emp,'2092-02-01',100,'2092-01-22','cash','','',gen_random_uuid());
  overpaid_advance:=public.payroll_pay_advance(other_emp,'2092-01-01',300,'2092-01-23','cash','','',gen_random_uuid());
  reverse_id:=public.payroll_reverse_payment(cancelled_advance,'Wrong payment entry',reverse_request);
  perform pg_temp.advance_assert(public.payroll_reverse_payment(cancelled_advance,'Wrong payment entry',reverse_request)=reverse_id
    and (select amount=200 and run_id is null from public.payroll_payments where id=cancelled_advance),'runless reversal is idempotent and preserves the original payment');
  path:=advance::text||'/'||gen_random_uuid()::text||'.png';
  insert into storage.objects(bucket_id,name,metadata) values('payroll-evidence',path,'{"size":128,"mimetype":"image/png"}');
  insert into public.payroll_attachments(payment_id,storage_path,filename,mime_type,byte_size,evidence_type,signed_name,acknowledged_at)
    values(advance,path,'advance-signature.png','image/png',128,'signature','Advance recipient',now()) returning id into attachment;
  perform pg_temp.advance_assert((select payment_id=advance from public.payroll_attachments where id=attachment),'advance uses the existing per-payment private signature pipeline');

  insert into public.payroll_terms(employee_id,effective_from,pay_type,rate,monthly_settlement) values(emp,'2092-01-01','monthly',1000,'statutory'),(other_emp,'2092-01-01','monthly',200,'statutory');
  select version into revision from public.payroll_revision where id=1;
  run:=public.payroll_finalize(emp,'2092-01-01',1000,0,0,'{"unresolved":0}',revision);
  perform pg_temp.advance_assert((select paid=500 and balance=500 from public.payroll_run_balances where run_id=run),
    'finalization credits this employee/month advance once, excludes reversal and other employee/month money');
  perform pg_temp.advance_assert((select run_id is null and employee_id=emp and payroll_month='2092-01-01' from public.payroll_payments where id=advance)
    and (select payment_id=advance from public.payroll_attachments where id=attachment),'finalization does not rewrite advance or signature identity');
  perform pg_temp.advance_assert(public.payroll_pay_advance(emp,'2092-01-01',500,'2092-01-12','cash','Early payment','Actual money, no paid-hour allocation',request)=advance,
    'an advance retry remains idempotent even after finalization');
  rejected:=false;begin perform public.payroll_pay_advance(emp,'2092-01-01',1,'2092-02-05','cash','','',gen_random_uuid());
  exception when others then rejected:=sqlerrm='PAYROLL_MONTH_ALREADY_FINALIZED';end;
  perform pg_temp.advance_assert(rejected,'a new advance cannot bypass a finalized monthly balance');
  rejected:=false;begin insert into public.payroll_payments(employee_id,payroll_month,amount,paid_on,method,request_id)
    values(emp,'2092-01-01',1,'2092-02-05','cash',gen_random_uuid());exception when others then rejected:=sqlerrm='PAYROLL_MONTH_ALREADY_FINALIZED';end;
  perform pg_temp.advance_assert(rejected,'direct REST inserts have the same finalized-month gate');
  regular:=public.payroll_pay(run,400,'2092-02-05','bank','','',gen_random_uuid());
  perform pg_temp.advance_assert((select employee_id=emp and payroll_month='2092-01-01' and run_id=run from public.payroll_payments where id=regular)
    and (select paid=900 and balance=100 from public.payroll_run_balances where run_id=run),'legacy pay RPC derives immutable month binding and includes advance in remaining money');
  rejected:=false;begin perform public.payroll_pay(run,101,'2092-02-05','cash','','',gen_random_uuid());
  exception when others then rejected:=sqlerrm='PAYROLL_OVERPAYMENT_OR_INVALID_AMOUNT';end;
  perform pg_temp.advance_assert(rejected,'regular payment cannot exceed remaining money after advances');
  rejected:=false;begin insert into public.payroll_payments(run_id,employee_id,payroll_month,amount,paid_on,method,request_id)
    values(run,other_emp,'2092-01-01',1,'2092-02-05','cash',gen_random_uuid());exception when others then rejected:=sqlerrm='PAYROLL_PAYMENT_BINDING_MISMATCH';end;
  perform pg_temp.advance_assert(rejected,'direct inserts cannot bind a run to another employee');
  rejected:=false;begin perform public.payroll_pay(run,500,'2092-01-12','cash','Early payment','Actual money, no paid-hour allocation',request);
  exception when others then rejected:=sqlerrm='PAYROLL_PAYMENT_REQUEST_CONFLICT';end;
  perform pg_temp.advance_assert(rejected,'normal pay cannot reuse an advance request ID as another payment');
  perform public.payroll_reverse_payment(advance,'Advance recorded incorrectly',gen_random_uuid());
  perform pg_temp.advance_assert((select paid=400 and balance=600 from public.payroll_run_balances where run_id=run)
    and (select payment_id=advance from public.payroll_attachments where id=attachment),'reversing an advance after approval restores remaining money and preserves signature history');

  select version into revision from public.payroll_revision where id=1;
  other_run:=public.payroll_finalize(other_emp,'2092-01-01',200,0,0,'{"unresolved":0}',revision);
  perform pg_temp.advance_assert((select total=200 and paid=300 and balance=-100 from public.payroll_run_balances where run_id=other_run),
    'truthful salary finalization preserves and exposes an overpaid advance');
  rejected:=false;begin perform public.payroll_pay(other_run,1,'2092-02-05','cash','','',gen_random_uuid());
  exception when others then rejected:=sqlerrm='PAYROLL_OVERPAYMENT_OR_INVALID_AMOUNT';end;
  perform pg_temp.advance_assert(rejected,'overpaid salary cannot receive another regular payment');
  rejected:=false;begin perform public.payroll_adjust_run(other_run,-1,'Unsafe reduction',gen_random_uuid());
  exception when others then rejected:=sqlerrm='PAYROLL_ADJUSTMENT_BELOW_PAID_OR_INVALID';end;
  perform pg_temp.advance_assert(rejected,'existing adjustment-below-paid protection remains');
  perform pg_temp.advance_assert((select amount=100 and payroll_month='2092-02-01' from public.payroll_payments where id=other_month),
    'overpayment never moves another salary-month payment');
  foreach role_name in array array['manager','staff'] loop
    perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'app_metadata',jsonb_build_object('role',role_name),'user_metadata',jsonb_build_object('role','admin'))::text,true);
    rejected:=false;begin perform public.payroll_pay_advance(emp,'2092-03-01',1,'2092-02-05','cash','','',gen_random_uuid());exception when insufficient_privilege then rejected:=true;end;
    perform pg_temp.advance_assert(rejected and (select count(*)=0 from public.payroll_payments),role_name||' cannot read or record advances');
  end loop;
  perform set_config('request.jwt.claims','{}',true);execute 'set local role anon';
  rejected:=false;begin perform public.payroll_pay_advance(emp,'2092-03-01',1,'2092-02-05','cash','','',gen_random_uuid());exception when insufficient_privilege then rejected:=true;end;
  perform pg_temp.advance_assert(rejected,'anonymous caller cannot use advance RPC');
end;$$;
rollback;
