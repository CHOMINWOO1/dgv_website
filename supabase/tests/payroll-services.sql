-- Synthetic fixtures only, including exact preservation of a previously signed
-- payment. All writes roll back; this regression never targets production data.
begin;
create function pg_temp.service_assert(p_ok boolean,p_message text) returns void language plpgsql as $$
begin if p_ok is distinct from true then raise exception 'FAIL: %',p_message;end if;end;$$;
do $$
declare actor uuid:='00000000-0000-4000-8000-000000000017';provider uuid:=gen_random_uuid();legacy uuid:=gen_random_uuid();
  other uuid;v_payment uuid;legacy_payment uuid;second_payment uuid;v_run uuid;v_request uuid:=gen_random_uuid();
  device uuid:=gen_random_uuid();v_signature uuid;revision bigint;after_revision bigint;v_path text;
  token text:=encode(sha256(convert_to(gen_random_uuid()::text,'UTF8')),'hex');
  old_payment jsonb;old_signature jsonb;old_terms jsonb;old_employee jsonb;old_audit jsonb;payload jsonb;restored jsonb;
  rejected boolean;role_name text;history_kind text;v_count bigint;
begin
  perform pg_temp.service_assert(not exists(select 1 from public.payroll_employees),'service recovery test requires an empty isolated database');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated','app_metadata',jsonb_build_object('role','admin'))::text,true);
  execute 'set local role authenticated';
  -- Keep a complete generated backup in a variable while rolling back the
  -- fixture transaction, so recovery can be tested without deleting any rows.
  begin
    select version into revision from public.payroll_revision where id=1;
    rejected:=false;begin perform public.payroll_save_service_provider(provider,'Synthetic contractor','010-0000-0000','',revision,true);
      exception when others then rejected:=true;end;
    perform pg_temp.service_assert(rejected and not exists(select 1 from public.payroll_employees where id=provider)
      and (select version=revision from public.payroll_revision where id=1),'invalid identity rolls back provider creation and source revision');
    perform pg_temp.service_assert(public.payroll_save_service_provider(provider,'Synthetic contractor','010-0000-0000','000-SYNTHETIC-SERVICE',revision,true)=provider,'new provider retains client UUID');
    select version into after_revision from public.payroll_revision where id=1;
    perform pg_temp.service_assert((select payee_type='service' and active from public.payroll_employees where id=provider)
      and public.payroll_get_sensitive(provider)->>'national_id'='000-SYNTHETIC-SERVICE','provider classification and encrypted identifier saved atomically');
    perform pg_temp.service_assert(public.payroll_save_service_provider(provider,'Synthetic contractor','010-0000-0000','000-SYNTHETIC-SERVICE',revision,true)=provider
      and (select version=after_revision from public.payroll_revision where id=1),'lost-response provider creation retry is idempotent');
    rejected:=false;begin update public.payroll_employees set payee_type='employee' where id=provider;
      exception when others then rejected:=sqlerrm='PAYROLL_SERVICE_CLASSIFICATION_RPC_REQUIRED';end;
    perform pg_temp.service_assert(rejected,'direct client cannot reclassify the provider');

    foreach role_name in array array['manager','staff'] loop
      perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'app_metadata',jsonb_build_object('role',role_name),'user_metadata',jsonb_build_object('role','admin'))::text,true);
      rejected:=false;begin perform public.payroll_pay_service(provider,100,'2091-01-03','cash','','Repair','2091-01-01','2091-01-02',gen_random_uuid());
        exception when insufficient_privilege then rejected:=true;end;
      perform pg_temp.service_assert(rejected,'non-admin cannot create service payment despite spoofed user metadata');
      rejected:=false;begin perform private.payroll_save_service_provider(gen_random_uuid(),'Denied','','SYNTHETIC',after_revision,true);
        exception when insufficient_privilege then rejected:=true;end;
      perform pg_temp.service_assert(rejected,'private provider helper independently enforces administrator claims');
      perform pg_temp.service_assert(not exists(select 1 from public.payroll_service_payment_details),'RLS hides service details from non-admin');
    end loop;
    perform set_config('request.jwt.claims','{}',true);execute 'set local role anon';
    rejected:=false;begin perform public.payroll_pay_service(provider,100,'2091-01-03','cash','','Repair','2091-01-01','2091-01-02',gen_random_uuid());
      exception when insufficient_privilege then rejected:=true;end;
    perform pg_temp.service_assert(rejected,'anonymous caller lacks service RPC execution');
    execute 'set local role authenticated';
    perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated','app_metadata',jsonb_build_object('role','admin'))::text,true);

    select version into revision from public.payroll_revision where id=1;
    rejected:=false;begin perform public.payroll_pay_service(provider,100,'2091-01-03','cash','','','2091-01-01','2091-01-02',gen_random_uuid());
      exception when others then rejected:=sqlerrm='PAYROLL_SERVICE_DETAILS_INVALID';end;
    perform pg_temp.service_assert(rejected and not exists(select 1 from public.payroll_payments)
      and (select version=revision from public.payroll_revision where id=1),'invalid job details never leave a payment or revision behind');
    v_payment:=public.payroll_pay_service(provider,500000,'2091-01-03','cash','Synthetic receipt','Electrical repair','2091-01-01','2091-01-02',v_request);
    select version into after_revision from public.payroll_revision where id=1;
    perform pg_temp.service_assert((select amount=500000 and paid_on='2091-01-03' and run_id is null and employee_id=provider from public.payroll_payments where id=v_payment)
      and (select description='Electrical repair' and work_from='2091-01-01' and work_to='2091-01-02' from public.payroll_service_payment_details where payment_id=v_payment),'fixed payout and exact job metadata share one payment ID');
    perform pg_temp.service_assert(public.payroll_pay_service(provider,500000,'2091-01-03','cash','Synthetic receipt','Electrical repair','2091-01-01','2091-01-02',v_request)=v_payment
      and (select version=after_revision from public.payroll_revision where id=1),'same request retries do not duplicate payout or metadata');
    rejected:=false;begin perform public.payroll_pay_service(provider,500000,'2091-01-03','cash','Synthetic receipt','Different job','2091-01-01','2091-01-02',v_request);
      exception when others then rejected:=sqlerrm='PAYROLL_SERVICE_DETAILS_CONFLICT';end;
    perform pg_temp.service_assert(rejected and (select count(*)=1 from public.payroll_payments where employee_id=provider),'request reuse with different metadata rejects without duplicate payout');
    perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'app_metadata',jsonb_build_object('role','manager'))::text,true);
    perform pg_temp.service_assert(not exists(select 1 from public.payroll_service_payment_details),'RLS hides populated job details from a manager');
    perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated','app_metadata',jsonb_build_object('role','admin'))::text,true);
    rejected:=false;begin update public.payroll_service_payment_details set description='Changed' where payment_id=v_payment;
      exception when others then rejected:=true;end;
    perform pg_temp.service_assert(rejected,'service job details are immutable');
    rejected:=false;begin insert into public.payroll_terms(employee_id,effective_from,pay_type,rate) values(provider,'2091-01-01','hourly',40000);
      exception when others then rejected:=sqlerrm='PAYROLL_SERVICE_NOT_EMPLOYEE';end;
    perform pg_temp.service_assert(rejected,'service provider cannot gain new wage terms');
    rejected:=false;begin insert into public.payroll_days(employee_id,work_date,day_type,reason) values(provider,'2091-01-02','work','Synthetic service schedule');
      exception when others then rejected:=sqlerrm='PAYROLL_SERVICE_NOT_EMPLOYEE';end;
    perform pg_temp.service_assert(rejected,'service provider cannot gain employee scheduled attendance');
    rejected:=false;begin perform public.payroll_import('synthetic-service-punch.xlsx',jsonb_build_array(jsonb_build_object(
      'device_user_id','S-'||provider,'name','Synthetic contractor','occurred_at','2091-01-02T10:00:00','device_id','SYNTHETIC')));
      exception when others then rejected:=sqlerrm='PAYROLL_SERVICE_NOT_EMPLOYEE';end;
    perform pg_temp.service_assert(rejected and not exists(select 1 from public.payroll_attendance_raw where employee_id=provider),'Excel import cannot create raw employee attendance for service provider');
    select version into revision from public.payroll_revision where id=1;
    rejected:=false;begin perform public.payroll_finalize(provider,'2091-01-01',500000,0,0,'{"unresolved":0}',revision);
      exception when others then rejected:=sqlerrm in ('PAYROLL_SERVICE_NOT_EMPLOYEE','PAYROLL_TERMS_REQUIRED');end;
    perform pg_temp.service_assert(rejected,'service provider cannot be finalized into an employee wage ledger');
    perform public.payroll_kiosk_register(device,'Synthetic service regression tablet',token);
    rejected:=false;begin perform public.payroll_kiosk_enroll(device,provider,'synthetic-consent');
      exception when others then rejected:=sqlerrm='PAYROLL_KIOSK_EMPLOYEE_NOT_ACTIVE';end;
    perform pg_temp.service_assert(rejected,'service provider cannot register employee face attendance');

    -- Model a mistaken employee entry with one historical signed advance and
    -- unused terms. Reclassification may add metadata, never rewrite that ledger.
    select version into revision from public.payroll_revision where id=1;
    perform public.payroll_save_employee(legacy,jsonb_build_object('device_user_id','SERVICE-LEGACY-'||legacy,'name','Synthetic legacy repair worker','employment_type','part_time'),
      '000-SYNTHETIC-LEGACY',revision,true);
    insert into public.payroll_terms(employee_id,effective_from,pay_type,rate) values(legacy,'2091-01-01','hourly',40000);
    legacy_payment:=public.payroll_pay_advance(legacy,'2091-01-01',1500000,'2091-01-29','cash','','',gen_random_uuid());
    v_path:=legacy_payment::text||'/'||gen_random_uuid()::text||'.png';
    insert into storage.objects(bucket_id,name,metadata) values('payroll-evidence',v_path,'{"size":128,"mimetype":"image/png"}');
    insert into public.payroll_attachments(payment_id,storage_path,filename,mime_type,byte_size,evidence_type,signed_name,acknowledged_at)
      values(legacy_payment,v_path,'synthetic-service-signature.png','image/png',128,'signature','Synthetic recipient',now()) returning id into v_signature;
    select to_jsonb(p) into old_payment from public.payroll_payments p where id=legacy_payment;
    select to_jsonb(a) into old_signature from public.payroll_attachments a where id=v_signature;
    select jsonb_agg(to_jsonb(t) order by id) into old_terms from public.payroll_terms t where employee_id=legacy;
    select to_jsonb(e) into old_employee from public.payroll_employees e where id=legacy;
    select coalesce(jsonb_agg(to_jsonb(a) order by id),'[]') into old_audit from public.payroll_audit a;
    select version into revision from public.payroll_revision where id=1;
    rejected:=false;begin perform public.payroll_reclassify_service_payment(legacy_payment,'Repair','2091-01-27','2091-01-29',revision-1);
      exception when others then rejected:=sqlerrm='PAYROLL_STALE_RELOAD_REQUIRED';end;
    perform pg_temp.service_assert(rejected,'stale reclassification rejects before changing original employee');
    rejected:=false;begin perform public.payroll_reclassify_service_payment(legacy_payment,null,'2091-01-27','2091-01-29',revision);
      exception when others then rejected:=true;end;
    perform pg_temp.service_assert(rejected and (select payee_type='employee' from public.payroll_employees where id=legacy)
      and (select version=revision from public.payroll_revision where id=1),'invalid reclassification metadata rolls back classification and audit');
    perform pg_temp.service_assert(public.payroll_reclassify_service_payment(legacy_payment,'Electrical repair','2091-01-27','2091-01-29',revision)=legacy_payment,'reclassification preserves the exact payment UUID');
    select version into after_revision from public.payroll_revision where id=1;
    perform pg_temp.service_assert(public.payroll_reclassify_service_payment(legacy_payment,'Electrical repair','2091-01-27','2091-01-29',revision)=legacy_payment
      and (select version=after_revision from public.payroll_revision where id=1),'reclassification retry is idempotent');
    perform pg_temp.service_assert((select to_jsonb(p)=old_payment from public.payroll_payments p where id=legacy_payment)
      and (select to_jsonb(a)=old_signature from public.payroll_attachments a where id=v_signature)
      and (select jsonb_agg(to_jsonb(t) order by id)=old_terms from public.payroll_terms t where employee_id=legacy),
      'amount/date/reference/request/actor/timestamps, exact signature and legacy terms remain unchanged');
    perform pg_temp.service_assert((select to_jsonb(e)-'payee_type'=old_employee-'payee_type' and payee_type='service' from public.payroll_employees e where id=legacy),
      'classification is the only modified employee field');
    rejected:=false;begin perform public.payroll_finalize(legacy,'2091-01-01',1500000,0,0,'{"unresolved":0}',after_revision);
      exception when others then rejected:=sqlerrm='PAYROLL_SERVICE_NOT_EMPLOYEE';end;
    perform pg_temp.service_assert(rejected,'preserved legacy terms do not permit service wage finalization');
    perform pg_temp.service_assert(not exists(select 1 from jsonb_array_elements(old_audit) a where not exists(select 1 from public.payroll_audit p where to_jsonb(p)=a)),
      'all earlier immutable audit events survive reclassification');
    perform pg_temp.service_assert(not exists(select 1 from public.payroll_audit where to_jsonb(payroll_audit)::text like '%000-SYNTHETIC-%'),
      'public audit never contains the private identifier values');

    foreach history_kind in array array['second_payment','attendance','scheduled_day','run','kiosk','archived'] loop
      other:=gen_random_uuid();
      insert into public.payroll_employees(id,device_user_id,name) values(other,'SERVICE-HISTORY-'||other,'Synthetic protected history');
      second_payment:=public.payroll_pay_advance(other,'2091-01-01',100,'2091-01-03','cash','','',gen_random_uuid());
      if history_kind='second_payment' then perform public.payroll_pay_advance(other,'2091-01-01',200,'2091-01-04','cash','','',gen_random_uuid());
      elsif history_kind='attendance' then perform public.payroll_import('synthetic-protected-punch.xlsx',jsonb_build_array(jsonb_build_object(
        'device_user_id','SERVICE-HISTORY-'||other,'name','Synthetic protected history','occurred_at','2091-01-02T10:00:00','device_id','SYNTHETIC')));
      elsif history_kind='scheduled_day' then insert into public.payroll_days(employee_id,work_date,day_type,reason) values(other,'2091-01-02','work','Synthetic protected schedule');
      elsif history_kind='run' then insert into public.payroll_terms(employee_id,effective_from,pay_type,rate) values(other,'2091-01-01','hourly',40000);
        select version into revision from public.payroll_revision where id=1;v_run:=public.payroll_finalize(other,'2091-01-01',1000,0,0,'{"unresolved":0}',revision);
      elsif history_kind='kiosk' then perform public.payroll_kiosk_enroll(device,other,'synthetic-consent');
      elsif history_kind='archived' then select version into revision from public.payroll_revision where id=1;perform public.payroll_set_employee_archived(other,true,'Synthetic removed registration',revision);end if;
      select version into revision from public.payroll_revision where id=1;
      rejected:=false;begin perform public.payroll_reclassify_service_payment(second_payment,'Would relabel history','2091-01-01','2091-01-02',revision);
        exception when others then rejected:=sqlerrm in ('PAYROLL_SERVICE_OTHER_PAYMENTS_REQUIRE_REVIEW','PAYROLL_SERVICE_HAS_EMPLOYMENT_HISTORY','PAYROLL_EMPLOYEE_ARCHIVED');end;
      perform pg_temp.service_assert(rejected and (select payee_type='employee' from public.payroll_employees where id=other)
        and not exists(select 1 from public.payroll_service_payment_details where payment_id=second_payment),
        'reclassification preserves other payments, attendance, finalized wages, kiosk grants and archived entries: '||history_kind);
    end loop;
    payload:=public.payroll_backup();
    perform pg_temp.service_assert(jsonb_array_length(payload->'tables'->'payroll_service_payment_details')=2,'backup contains payment-linked service metadata');
    raise exception using errcode='ZX001',message='ROLLBACK_SERVICE_BACKUP_FIXTURE';
  exception when sqlstate 'ZX001' then null;
  end;
  perform pg_temp.service_assert(not exists(select 1 from public.payroll_employees),'synthetic fixtures rolled back before recovery');
  restored:=public.payroll_restore(payload);
  perform pg_temp.service_assert((restored->>'restored')::boolean,'service backup restores into an empty database');
  perform pg_temp.service_assert((select payee_type='service' from public.payroll_employees where id=legacy)
    and (select jsonb_agg(to_jsonb(t) order by id)=old_terms from public.payroll_terms t where employee_id=legacy),
    'recovery preserves service classification together with pre-classification wage terms');
  perform pg_temp.service_assert((select to_jsonb(p)=old_payment from public.payroll_payments p where id=legacy_payment)
    and (select to_jsonb(a)=old_signature from public.payroll_attachments a where id=v_signature)
    and (select count(*)=2 from public.payroll_service_payment_details),'service recovery preserves original payouts, signatures and job descriptions');
  perform pg_temp.service_assert(public.payroll_get_sensitive(legacy)->>'national_id'='000-SYNTHETIC-LEGACY','private identity survives encrypted backup recovery');
  rejected:=false;begin insert into public.payroll_terms(employee_id,effective_from,pay_type,rate) values(legacy,'2091-02-01','hourly',40000);
    exception when others then rejected:=sqlerrm='PAYROLL_SERVICE_NOT_EMPLOYEE';end;
  perform pg_temp.service_assert(rejected,'service wage guard is enabled after backup restore');
  restored:=public.payroll_restore(payload);
  perform pg_temp.service_assert((restored->>'replayed')::boolean and (select count(*)=2 from public.payroll_service_payment_details),'backup retry does not duplicate service detail rows');
end;$$;
rollback;
