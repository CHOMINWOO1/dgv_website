-- Isolated regression with synthetic identities and payments. No production
-- employee is removed; all fixture creation and state changes roll back.
begin;
create function pg_temp.employee_archive_assert(p_ok boolean,p_message text) returns void language plpgsql as $$
begin if p_ok is distinct from true then raise exception 'FAIL: %',p_message;end if;end;$$;
create function pg_temp.employee_archive_history() returns jsonb language sql as $$
  select jsonb_build_object(
    'terms',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.payroll_terms t),
    'raw',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.payroll_attendance_raw t),
    'days',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.payroll_days t),
    'runs',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.payroll_runs t),
    'reviews',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.payroll_reviews t),
    'payments',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.payroll_payments t),
    'adjustments',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.payroll_run_adjustments t),
    'reversals',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.payroll_payment_reversals t),
    'attachments',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.payroll_attachments t),
    'objects',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from storage.objects t),
    'sensitive_versions',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from private.payroll_sensitive_versions t),
    'vault_hash',(select md5(coalesce(jsonb_agg(to_jsonb(t) order by id),'[]')::text) from vault.decrypted_secrets t),
    'kiosk_devices',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from payroll_kiosk.payroll_kiosk_devices t),
    'kiosk_enrollments',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from payroll_kiosk.payroll_kiosk_enrollments t),
    'kiosk_audit',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from payroll_kiosk.payroll_kiosk_admin_audit t));
$$;
do $$
declare actor uuid:='00000000-0000-4000-8000-000000000016';emp uuid:=gen_random_uuid();empty_emp uuid:=gen_random_uuid();
  leave_emp uuid:=gen_random_uuid();ended_emp uuid:=gen_random_uuid();device uuid:=gen_random_uuid();grant_id uuid;
  token text:=encode(sha256(convert_to(gen_random_uuid()::text,'UTF8')),'hex');revision bigint;after_revision bigint;
  before_employee jsonb;protected_history jsonb;before_audit jsonb;audit_count bigint;run uuid;payment uuid;other_payment uuid;
  signature uuid;object_path text;rejected boolean;role_name text;bad_reason text;payload jsonb;roster jsonb;first_archive_time timestamptz;
begin
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'app_metadata',jsonb_build_object('role','admin'))::text,true);
  execute 'set local role authenticated';
  select version into revision from public.payroll_revision where id=1;
  perform public.payroll_save_employee(emp,jsonb_build_object('name','Archive history fixture','device_user_id','ARCHIVE-'||emp,
    'employment_type','full_time','employment_status','active'),'NATIONAL-SYNTHETIC-ARCHIVE-0001',revision,true);
  select version into revision from public.payroll_revision where id=1;
  perform public.payroll_save_employee(empty_emp,jsonb_build_object('name','Unused registration fixture','device_user_id','ARCHIVE-EMPTY-'||empty_emp),
    'NATIONAL-SYNTHETIC-ARCHIVE-0002',revision,true);
  insert into public.payroll_employees(id,device_user_id,name,employment_status)
    values(leave_emp,'ARCHIVE-LEAVE-'||leave_emp,'Leave fixture','leave'),(ended_emp,'ARCHIVE-ENDED-'||ended_emp,'Terminated fixture','terminated');
  insert into public.payroll_terms(employee_id,effective_from,pay_type,rate,monthly_settlement)
    values(emp,'2093-01-01','monthly',1000,'statutory');
  insert into public.payroll_days(employee_id,work_date,day_type,check_in,check_out,reason)
    values(emp,'2093-01-02','work','2093-01-02 10:00','2093-01-02 20:00','Synthetic historical shift');
  payment:=public.payroll_pay_advance(emp,'2093-01-01',200,'2093-01-03','cash','Archive fixture payment','Preserve exact payment',gen_random_uuid());
  other_payment:=public.payroll_pay_advance(emp,'2093-01-01',300,'2093-01-04','bank','','',gen_random_uuid());
  object_path:=payment::text||'/'||gen_random_uuid()::text||'.png';
  insert into storage.objects(bucket_id,name,metadata) values('payroll-evidence',object_path,'{"size":128,"mimetype":"image/png"}');
  insert into public.payroll_attachments(payment_id,storage_path,filename,mime_type,byte_size,evidence_type,signed_name,acknowledged_at)
    values(payment,object_path,'synthetic-archive-signature.png','image/png',128,'signature','Synthetic recipient',now()) returning id into signature;
  select version into revision from public.payroll_revision where id=1;
  run:=public.payroll_finalize(emp,'2093-01-01',1000,0,0,'{"unresolved":0,"fixture":"archive"}',revision);
  perform public.payroll_kiosk_register(device,'Synthetic archive tablet',token);
  grant_id:=public.payroll_kiosk_enroll(device,emp,'synthetic-consent-v1');
  perform public.payroll_kiosk_punch(token,emp,'in',gen_random_uuid());

  -- Authorization, request validation and stale optimistic concurrency.
  select version into revision from public.payroll_revision where id=1;
  foreach role_name in array array['manager','staff'] loop
    perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'app_metadata',jsonb_build_object('role',role_name),
      'user_metadata',jsonb_build_object('role','admin'))::text,true);
    rejected:=false;begin perform public.payroll_set_employee_archived(emp,true,'Not authorized',revision);
      exception when insufficient_privilege then rejected:=true;end;
    perform pg_temp.employee_archive_assert(rejected,'non-admin app role cannot archive despite user_metadata spoof');
    rejected:=false;begin perform private.payroll_set_employee_archived(emp,true,'Not authorized',revision);
      exception when insufficient_privilege then rejected:=true;end;
    perform pg_temp.employee_archive_assert(rejected,'direct private helper also verifies administrator claims');
  end loop;
  perform set_config('request.jwt.claims','{}',true);execute 'set local role anon';
  rejected:=false;begin perform public.payroll_set_employee_archived(emp,true,'Anonymous request',revision);
    exception when insufficient_privilege then rejected:=true;end;
  perform pg_temp.employee_archive_assert(rejected,'anonymous caller cannot execute lifecycle RPC');
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'app_metadata',jsonb_build_object('role','admin'))::text,true);
  foreach bad_reason in array array[null,'','  ',repeat('x',501),E'bad\nreason'] loop
    rejected:=false;begin perform public.payroll_set_employee_archived(emp,true,bad_reason,revision);
      exception when others then rejected:=sqlerrm='PAYROLL_ARCHIVE_REASON_REQUIRED';end;
    perform pg_temp.employee_archive_assert(rejected,'empty, overlong or control-character reasons are rejected');
  end loop;
  rejected:=false;begin perform public.payroll_set_employee_archived(emp,null,'Invalid request',revision);
    exception when others then rejected:=sqlerrm='PAYROLL_INVALID_EMPLOYEE_ARCHIVE_REQUEST';end;
  perform pg_temp.employee_archive_assert(rejected,'null target state is invalid');
  rejected:=false;begin perform public.payroll_set_employee_archived(emp,true,'Stale request',revision-1);
    exception when others then rejected:=sqlerrm='PAYROLL_STALE_RELOAD_REQUIRED';end;
  perform pg_temp.employee_archive_assert(rejected,'stale revision cannot archive');
  rejected:=false;begin perform public.payroll_set_employee_archived(gen_random_uuid(),true,'Unknown employee',revision);
    exception when others then rejected:=sqlerrm='PAYROLL_EMPLOYEE_NOT_FOUND';end;
  perform pg_temp.employee_archive_assert(rejected,'unknown employee does not create a marker');

  execute 'set local role postgres';
  select to_jsonb(e) into before_employee from public.payroll_employees e where id=emp;
  protected_history:=pg_temp.employee_archive_history();
  select coalesce(jsonb_agg(to_jsonb(a) order by id),'[]'),count(*) into before_audit,audit_count from public.payroll_audit a;
  execute 'set local role authenticated';
  perform pg_temp.employee_archive_assert(public.payroll_set_employee_archived(emp,true,'Remove from active employee list',revision)=emp,'archive returns the original employee UUID');
  select version into after_revision from public.payroll_revision where id=1;
  perform pg_temp.employee_archive_assert(after_revision=revision+1,'archive produces exactly one source revision increment');
  perform pg_temp.employee_archive_assert((select archived_at is not null and archived_by=actor and archived_reason='Remove from active employee list'
    and archived_previous_active and archived_previous_employment_status='active' and not active and employment_status='terminated'
    and termination_date is null from public.payroll_employees where id=emp),'archive stores original state and disables attendance without inventing a termination date');
  select archived_at into first_archive_time from public.payroll_employees where id=emp;
  perform pg_temp.employee_archive_assert(public.payroll_set_employee_archived(emp,true,'Remove from active employee list',revision)=emp
    and (select version=after_revision from public.payroll_revision where id=1),'lost-response retry is idempotent at the old revision');
  perform pg_temp.employee_archive_assert((select archived_at=first_archive_time from public.payroll_employees where id=emp),'retry preserves archive time');
  rejected:=false;begin perform public.payroll_set_employee_archived(emp,true,'Different repeated reason',after_revision);
    exception when others then rejected:=sqlerrm='PAYROLL_EMPLOYEE_ARCHIVE_STATE_CONFLICT';end;
  perform pg_temp.employee_archive_assert(rejected,'already archived conflict does not rewrite provenance');
  execute 'set local role postgres';
  perform pg_temp.employee_archive_assert(pg_temp.employee_archive_history()=protected_history,'all payroll, money, signatures, Vault and kiosk history survives archive unchanged');
  perform pg_temp.employee_archive_assert((select count(*)=audit_count+1 from public.payroll_audit),'only one lifecycle audit row is appended');
  perform pg_temp.employee_archive_assert((select coalesce(jsonb_agg(to_jsonb(a) order by id),'[]')=before_audit from public.payroll_audit a
    where not (table_name='payroll_employees' and record_id=emp and action='UPDATE' and after_data->>'archived_reason'='Remove from active employee list')),'prior audit entries remain unchanged');
  perform pg_temp.employee_archive_assert(exists(select 1 from public.payroll_audit where table_name='payroll_employees' and record_id=emp and action='UPDATE'
    and before_data->>'archived_at' is null and after_data->>'archived_reason'='Remove from active employee list' and created_by=actor),'archive reason and actor are auditable');
  perform pg_temp.employee_archive_assert(not exists(select 1 from public.payroll_audit where to_jsonb(payroll_audit)::text like '%NATIONAL-SYNTHETIC-ARCHIVE%'),'identity plaintext never enters public audit');

  -- Existing UI and direct REST employee updates cannot reactivate an archived
  -- employee or forge lifecycle markers. Physical deletion remains forbidden.
  execute 'set local role authenticated';
  rejected:=false;begin update public.payroll_employees set active=true where id=emp;
    exception when others then rejected:=sqlerrm='PAYROLL_ARCHIVED_EMPLOYEE_INACTIVE';end;
  perform pg_temp.employee_archive_assert(rejected,'direct active flag cannot bypass explicit restoration');
  rejected:=false;begin update public.payroll_employees set employment_status='active' where id=emp;
    exception when others then rejected:=sqlerrm='PAYROLL_ARCHIVED_EMPLOYEE_INACTIVE';end;
  perform pg_temp.employee_archive_assert(rejected,'employment status cannot bypass explicit restoration');
  rejected:=false;begin update public.payroll_employees set archived_at=null,archived_by=null,archived_previous_active=null,
    archived_previous_employment_status=null where id=emp;
    exception when others then rejected:=sqlerrm='PAYROLL_EMPLOYEE_ARCHIVE_RPC_REQUIRED';end;
  perform pg_temp.employee_archive_assert(rejected,'API clients cannot directly clear lifecycle markers');
  rejected:=false;begin update public.payroll_employees set archived_reason='Forged reason' where id=emp;
    exception when others then rejected:=sqlerrm='PAYROLL_EMPLOYEE_ARCHIVE_RPC_REQUIRED';end;
  perform pg_temp.employee_archive_assert(rejected,'API clients cannot replace lifecycle reason');
  rejected:=false;begin perform public.payroll_save_employee(emp,'{"employment_status":"active"}',
    'NATIONAL-SYNTHETIC-ARCHIVE-0001',after_revision,false);
    exception when others then rejected:=sqlerrm='PAYROLL_ARCHIVED_EMPLOYEE_INACTIVE';end;
  perform pg_temp.employee_archive_assert(rejected,'ordinary employee-save RPC cannot reactivate archived staff');
  rejected:=false;begin delete from public.payroll_employees where id=empty_emp;
    exception when others then rejected:=true;end;
  perform pg_temp.employee_archive_assert(rejected,'immutable physical DELETE remains blocked');
  perform pg_temp.employee_archive_assert((select version=after_revision from public.payroll_revision where id=1),'all rejected bypass attempts leave revision unchanged');
  perform pg_temp.employee_archive_assert((select paid=500 and balance=500 from public.payroll_run_balances where run_id=run),'historical payroll balance still includes the preserved payments');
  perform pg_temp.employee_archive_assert(public.payroll_get_sensitive(emp)->>'national_id'='NATIONAL-SYNTHETIC-ARCHIVE-0001','authorized identity retrieval retains the original encrypted value');
  rejected:=false;begin perform public.payroll_kiosk_enroll(device,emp,'synthetic-consent-v1');
    exception when others then rejected:=sqlerrm='PAYROLL_KIOSK_EMPLOYEE_NOT_ACTIVE';end;
  perform pg_temp.employee_archive_assert(rejected,'archived staff cannot be enrolled again');
  perform set_config('request.jwt.claims','{}',true);execute 'set local role anon';
  roster:=public.payroll_kiosk_roster(token);
  perform pg_temp.employee_archive_assert(not exists(select 1 from jsonb_array_elements(roster->'employees') where value->>'id'=emp::text),'archived employee disappears from device roster');
  rejected:=false;begin perform public.payroll_kiosk_punch(token,emp,'out',gen_random_uuid());
    exception when others then rejected:=sqlerrm='PAYROLL_KIOSK_EMPLOYEE_NOT_ACTIVE';end;
  perform pg_temp.employee_archive_assert(rejected,'archived staff cannot punch using a retained device grant');

  -- Restore recovers exactly the former state. Existing grants and records are
  -- reused, rather than recreating the employee, enrollment or payment identities.
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'app_metadata',jsonb_build_object('role','admin'))::text,true);
  rejected:=false;begin perform public.payroll_set_employee_archived(emp,false,'Restore original employee',revision);
    exception when others then rejected:=sqlerrm='PAYROLL_STALE_RELOAD_REQUIRED';end;
  perform pg_temp.employee_archive_assert(rejected,'stale restoration is blocked');
  perform pg_temp.employee_archive_assert(public.payroll_set_employee_archived(emp,false,'Restore original employee',after_revision)=emp,'restore returns unchanged employee UUID');
  perform pg_temp.employee_archive_assert((select version=after_revision+1 from public.payroll_revision where id=1),'restore increments source revision once');
  perform pg_temp.employee_archive_assert((select to_jsonb(e)-'archived_reason'=before_employee-'archived_reason'
    and archived_reason='Restore original employee' from public.payroll_employees e where id=emp),'restore returns all original employee fields and records its reason');
  perform pg_temp.employee_archive_assert(public.payroll_set_employee_archived(emp,false,'Restore original employee',after_revision)=emp
    and (select version=after_revision+1 from public.payroll_revision where id=1),'restore lost-response retry is idempotent');
  execute 'set local role postgres';
  perform pg_temp.employee_archive_assert(pg_temp.employee_archive_history()=protected_history,'archive and restore never modify protected historical records');
  perform pg_temp.employee_archive_assert(exists(select 1 from public.payroll_audit where record_id=emp and action='UPDATE'
    and before_data->>'archived_at' is not null and after_data->>'archived_at' is null and after_data->>'archived_reason'='Restore original employee'),'restoration reason remains in immutable audit');
  perform set_config('request.jwt.claims','{}',true);execute 'set local role anon';
  roster:=public.payroll_kiosk_roster(token);
  perform pg_temp.employee_archive_assert((select value->>'enrollment_id'=grant_id::text from jsonb_array_elements(roster->'employees') where value->>'id'=emp::text),'restored active employee reuses original enrollment');

  execute 'set local role authenticated';
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'app_metadata',jsonb_build_object('role','admin'))::text,true);
  foreach emp in array array[empty_emp,leave_emp,ended_emp] loop
    select to_jsonb(e) into before_employee from public.payroll_employees e where id=emp;
    select version into revision from public.payroll_revision where id=1;
    perform public.payroll_set_employee_archived(emp,true,'Archive alternate state',revision);
    select version into revision from public.payroll_revision where id=1;
    perform public.payroll_set_employee_archived(emp,false,'Restore alternate state',revision);
    perform pg_temp.employee_archive_assert((select to_jsonb(e)-'archived_reason'=before_employee-'archived_reason' from public.payroll_employees e where id=emp),
      'empty registration, leave and terminated employees preserve their original status after restoration');
  end loop;
end;$$;
rollback;

-- New archive markers must survive backup/recovery; backups from before this
-- feature omit them and must still restore as ordinary active employees.
begin;
create function pg_temp.archive_backup_assert(p_ok boolean,p_message text) returns void language plpgsql as $$
begin if p_ok is distinct from true then raise exception 'FAIL: %',p_message;end if;end;$$;
do $$
declare actor uuid:='00000000-0000-4000-8000-000000000016';emp uuid;revision bigint;payload jsonb;result jsonb;
  variant integer;rejected boolean;
begin
  perform pg_temp.archive_backup_assert(not exists(select 1 from public.payroll_employees),'archive backup test requires an empty isolated database');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated','app_metadata',jsonb_build_object('role','admin'))::text,true);
  execute 'set local role authenticated';
  for variant in 1..2 loop
    begin
      emp:=gen_random_uuid();
      select version into revision from public.payroll_revision where id=1;
      perform public.payroll_save_employee(emp,jsonb_build_object('name','Archive recovery fixture','device_user_id','ARCHIVE-BACKUP-'||emp),
        'SYNTHETIC-ARCHIVE-RECOVERY-001',revision,true);
      if variant=1 then
        select version into revision from public.payroll_revision where id=1;
        perform public.payroll_set_employee_archived(emp,true,'Preserve list removal during recovery',revision);
      end if;
      payload:=public.payroll_backup();
      if variant=2 then
        payload:=jsonb_set(payload,'{tables,payroll_employees,0}',(payload#>'{tables,payroll_employees,0}')
          -array['archived_at','archived_by','archived_reason','archived_previous_active','archived_previous_employment_status']);
      end if;
      raise exception using errcode='ZX001',message='ROLLBACK_ARCHIVE_BACKUP_FIXTURE';
    exception when sqlstate 'ZX001' then null;
    end;
    begin
      result:=public.payroll_restore(payload);
      perform pg_temp.archive_backup_assert((result->>'restored')::boolean,'employee backup restores without physical deletion');
      perform pg_temp.archive_backup_assert(public.payroll_get_sensitive(emp)->>'national_id'='SYNTHETIC-ARCHIVE-RECOVERY-001',
        'backup recovery preserves the encrypted identity separately from public employee metadata');
      if variant=1 then
        perform pg_temp.archive_backup_assert((select archived_at is not null and archived_previous_active and not active
          and archived_reason='Preserve list removal during recovery' from public.payroll_employees where id=emp),'recovery preserves the archived state and original status');
        rejected:=false;begin update public.payroll_employees set active=true,employment_status='active' where id=emp;
          exception when others then rejected:=sqlerrm='PAYROLL_ARCHIVED_EMPLOYEE_INACTIVE';end;
        perform pg_temp.archive_backup_assert(rejected,'archive guard remains enabled after database restore');
        select version into revision from public.payroll_revision where id=1;
        perform public.payroll_set_employee_archived(emp,false,'Restore recovered registration',revision);
        perform pg_temp.archive_backup_assert((select archived_at is null and active and employment_status='active' from public.payroll_employees where id=emp),
          'recovered archived employee can be explicitly restored');
      else
        perform pg_temp.archive_backup_assert((select archived_at is null and archived_reason is null and active from public.payroll_employees where id=emp),
          'legacy backup missing all archive fields restores normally');
      end if;
      raise exception using errcode='ZX002',message='ROLLBACK_ARCHIVE_RECOVERY';
    exception when sqlstate 'ZX002' then null;
    end;
  end loop;
end;$$;
rollback;
