-- Hosted migration version: 20261113091608. No historical payment rows are rewritten.
set local lock_timeout='3s';
create table public.payroll_employment_conversions(
 id uuid primary key default gen_random_uuid(),
 employee_id uuid not null references public.payroll_employees(id),
 effective_from date not null check(isfinite(effective_from)),
 original_hire_date date not null check(isfinite(original_hire_date) and original_hire_date<=effective_from),
 prior_employment_type text not null check(prior_employment_type in ('part_time','full_time')),
 employment_type text not null check(employment_type in ('part_time','full_time') and employment_type<>prior_employment_type),
 prior_salary_amount bigint check(prior_salary_amount between 0 and 1000000000),
 term_id uuid not null references public.payroll_terms(id),
 reason text not null check(length(btrim(reason)) between 1 and 1000),
 request_id uuid not null unique,
 request_payload jsonb not null,
 created_by uuid references auth.users(id),created_at timestamptz not null default now(),
 unique(employee_id,effective_from)
);
alter table public.payroll_employment_conversions enable row level security;
revoke all on public.payroll_employment_conversions from public,anon,authenticated;
grant select,insert on public.payroll_employment_conversions to authenticated;
create policy payroll_conversions_admin_read on public.payroll_employment_conversions for select to authenticated using(public.has_app_role(array['admin']));
create policy payroll_conversions_admin_insert on public.payroll_employment_conversions for insert to authenticated with check(public.has_app_role(array['admin']));
create function public.payroll_guard_conversion() returns trigger language plpgsql set search_path='' as $$
declare e public.payroll_employees;t public.payroll_terms;
begin
 perform public.payroll_assert_admin();
 if tg_op<>'INSERT' then raise exception 'PAYROLL_IMMUTABLE_RECORD';end if;
 perform version from public.payroll_revision where id=1 for update;
 select * into strict e from public.payroll_employees where id=new.employee_id;
 select * into strict t from public.payroll_terms where id=new.term_id;
 if e.payee_type<>'employee' or e.archived_at is not null or e.employment_status<>'active' or e.employment_type<>new.employment_type
  or t.employee_id<>e.id or t.effective_from<>new.effective_from or (new.employment_type='full_time' and (t.pay_type<>'monthly' or t.monthly_settlement<>'monthly_net')) or (new.employment_type='part_time' and t.pay_type<>'hourly')
  or e.hire_date is distinct from new.original_hire_date then raise exception 'PAYROLL_CONVERSION_INVALID';end if;
 if exists(select 1 from public.payroll_runs where employee_id=e.id and month>=date_trunc('month',new.effective_from)::date) then raise exception 'PAYROLL_CONVERSION_FINALIZED';end if;
 if new.effective_from=date_trunc('month',new.effective_from)::date and coalesce(new.prior_salary_amount,0)<>0 then raise exception 'PAYROLL_CONVERSION_NO_PRIOR_PERIOD';end if;
 new.created_by:=auth.uid();new.created_at:=now();return new;
end $$;
create trigger payroll_conversion_guard before insert or update or delete on public.payroll_employment_conversions for each row execute function public.payroll_guard_conversion();
create function public.payroll_audit_conversion() returns trigger language plpgsql set search_path='' as $$
begin
 insert into public.payroll_audit(table_name,record_id,action,after_data,created_by) values(tg_table_name,new.id,tg_op,to_jsonb(new),auth.uid());
 update public.payroll_revision set version=version+1 where id=1;return new;
end $$;
create trigger payroll_conversion_audit after insert on public.payroll_employment_conversions for each row execute function public.payroll_audit_conversion();
revoke all on function public.payroll_guard_conversion(),public.payroll_audit_conversion() from public,anon,authenticated;

create function public.payroll_conversion_candidate(p_employee_id uuid,p_repair boolean default false) returns jsonb language plpgsql set search_path='' as $$
declare e public.payroll_employees;t public.payroll_terms;a jsonb;original_date date;prior_type text;
begin
 perform public.payroll_assert_admin();
 select * into strict e from public.payroll_employees where id=p_employee_id;
 if e.archived_at is not null or e.payee_type<>'employee' or e.employment_status<>'active' then raise exception 'PAYROLL_CONVERSION_INVALID';end if;
 
 original_date:=e.hire_date;prior_type:=e.employment_type;
 if p_repair then
  if e.employment_type<>'full_time' then raise exception 'PAYROLL_CONVERSION_REPAIR_UNAVAILABLE';end if;
  select before_data into a from public.payroll_audit where table_name='payroll_employees' and record_id=e.id
   and before_data->>'employment_type'='part_time' and after_data->>'employment_type'='full_time'
   and after_data->>'hire_date'=e.hire_date::text order by created_at desc limit 1;
  if a is null then raise exception 'PAYROLL_CONVERSION_PART_TIME_REQUIRED';end if;
  original_date:=(a->>'hire_date')::date;prior_type:='part_time';
 end if;
 if original_date is null then raise exception 'PAYROLL_CONVERSION_HIRE_DATE_REQUIRED';end if;
 select * into t from public.payroll_terms where employee_id=e.id order by effective_from desc limit 1;
 return jsonb_build_object('employee_id',e.id,'name',e.name,'original_hire_date',original_date,'prior_employment_type',prior_type,
  'repair',p_repair,'term',to_jsonb(t));
end $$;
revoke all on function public.payroll_conversion_candidate(uuid,boolean) from public,anon;
grant execute on function public.payroll_conversion_candidate(uuid,boolean) to authenticated;

create function public.payroll_convert_employment(p_employee_id uuid,p_employment_type text,p_terms jsonb,p_prior_salary_amount bigint,p_reason text,p_expected_revision bigint,p_request_id uuid,p_repair boolean default false)
returns uuid language plpgsql set search_path='' as $$
declare candidate jsonb;e public.payroll_employees;term public.payroll_terms;saved public.payroll_employment_conversions;
 v_revision bigint;start_date date;original_date date;payload jsonb;term_id uuid;conversion_id uuid;key text;
begin
 perform public.payroll_assert_admin();
 if p_employment_type is null or p_employment_type not in ('part_time','full_time') or p_request_id is null or p_expected_revision is null or p_repair is null or jsonb_typeof(p_terms) is distinct from 'object'
  or (p_prior_salary_amount is not null and p_prior_salary_amount not between 0 and 1000000000) or p_reason is null or length(btrim(p_reason)) not between 1 and 1000 then raise exception 'PAYROLL_CONVERSION_INVALID';end if;
 payload:=jsonb_build_object('employee_id',p_employee_id,'employment_type',p_employment_type,'terms',p_terms,'prior_salary_amount',p_prior_salary_amount,'reason',btrim(p_reason),'repair',p_repair);
 select version into v_revision from public.payroll_revision where id=1 for update;
 select * into saved from public.payroll_employment_conversions where request_id=p_request_id;
 if found then if saved.request_payload<>payload then raise exception 'PAYROLL_CONVERSION_REQUEST_CONFLICT';end if;return saved.id;end if;
 if p_expected_revision is distinct from v_revision then raise exception 'PAYROLL_STALE_RELOAD_REQUIRED';end if;
 for key in select jsonb_object_keys(p_terms) loop
  if key not in ('effective_from','rate','shift_start','shift_end','break_start','break_end','weekly_rest_day') then raise exception 'PAYROLL_CONVERSION_INVALID';end if;
 end loop;
 if jsonb_typeof(p_terms->'rate') is distinct from 'number' or (p_terms->>'rate') !~ '^[0-9]{1,10}$'
  or jsonb_typeof(p_terms->'weekly_rest_day') is distinct from 'number' then raise exception 'PAYROLL_CONVERSION_INVALID';end if;
 candidate:=public.payroll_conversion_candidate(p_employee_id,p_repair);
 if candidate->>'prior_employment_type'=p_employment_type then raise exception 'PAYROLL_CONVERSION_SAME_TYPE';end if;
 if (candidate->>'repair')::boolean is distinct from p_repair then raise exception 'PAYROLL_CONVERSION_STATE_CHANGED';end if;
 original_date:=(candidate->>'original_hire_date')::date;start_date:=(p_terms->>'effective_from')::date;
 if start_date is null or not isfinite(start_date) or start_date<original_date or start_date>(now() at time zone 'Asia/Ho_Chi_Minh')::date
  or (p_terms->>'rate')::bigint not between (case when p_employment_type='part_time' then 1 else 0 end) and 1000000000 or (p_terms->>'weekly_rest_day')::integer not between 0 and 6 then raise exception 'PAYROLL_CONVERSION_INVALID';end if;
 if exists(select 1 from public.payroll_employment_conversions where employee_id=p_employee_id and effective_from>=start_date) then raise exception 'PAYROLL_CONVERSION_LATER_CHANGE';end if;
 if start_date=greatest(original_date,date_trunc('month',start_date)::date) and coalesce(p_prior_salary_amount,0)<>0 then raise exception 'PAYROLL_CONVERSION_NO_PRIOR_PERIOD';end if;
 if exists(select 1 from public.payroll_runs where employee_id=p_employee_id and month>=date_trunc('month',start_date)::date) then raise exception 'PAYROLL_CONVERSION_FINALIZED';end if;
 select * into e from public.payroll_employees where id=p_employee_id for update;
 if exists(select 1 from public.payroll_terms where employee_id=e.id and effective_from>start_date) then raise exception 'PAYROLL_CONVERSION_LATER_TERMS';end if;
 select * into term from public.payroll_terms where employee_id=e.id and effective_from=start_date;
 if found then
  if not p_repair or term.pay_type<>'monthly' or term.monthly_settlement<>'monthly_net' or term.rate<>(p_terms->>'rate')::bigint
   or term.shift_start<>(p_terms->>'shift_start')::time or term.shift_end<>(p_terms->>'shift_end')::time
   or term.break_start<>(p_terms->>'break_start')::time or term.break_end<>(p_terms->>'break_end')::time
   or term.weekly_rest_day<>(p_terms->>'weekly_rest_day')::integer then raise exception 'PAYROLL_CONVERSION_TERMS_CONFLICT';end if;
  term_id:=term.id;
 else
  insert into public.payroll_terms(employee_id,effective_from,pay_type,rate,monthly_settlement,shift_start,shift_end,break_start,break_end,weekly_rest_day)
   values(e.id,start_date,case when p_employment_type='full_time' then 'monthly' else 'hourly' end,(p_terms->>'rate')::bigint,case when p_employment_type='full_time' then 'monthly_net' else 'statutory' end,(p_terms->>'shift_start')::time,(p_terms->>'shift_end')::time,(p_terms->>'break_start')::time,(p_terms->>'break_end')::time,(p_terms->>'weekly_rest_day')::integer) returning id into term_id;
 end if;
 update public.payroll_employees set employment_type=p_employment_type,hire_date=original_date where id=e.id;
 insert into public.payroll_employment_conversions(employee_id,effective_from,original_hire_date,prior_employment_type,employment_type,prior_salary_amount,term_id,reason,request_id,request_payload)
  values(e.id,start_date,original_date,candidate->>'prior_employment_type',p_employment_type,p_prior_salary_amount,term_id,btrim(p_reason),p_request_id,payload) returning id into conversion_id;
 return conversion_id;
end $$;
revoke all on function public.payroll_convert_employment(uuid,text,jsonb,bigint,text,bigint,uuid,boolean) from public,anon;
grant execute on function public.payroll_convert_employment(uuid,text,jsonb,bigint,text,bigint,uuid,boolean) to authenticated;
-- Preserve backup and backward-compatible restore behavior.
CREATE OR REPLACE FUNCTION private.payroll_backup()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare payload jsonb;
begin
  perform public.payroll_assert_admin();
  -- Every source is read by one SELECT and therefore one MVCC snapshot. No
  -- sequential client pagination can mix pre-payment and post-reversal state.
  select jsonb_build_object('format','DGV_PAYROLL_BACKUP','version',2,'exported_at',now(),
    'revision',(select version from public.payroll_revision where id=1),
    'tables',jsonb_build_object(
      'payroll_employment_conversions',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.payroll_employment_conversions t),
      'payroll_employees',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.payroll_employees t),
      'payroll_terms',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.payroll_terms t),
      'payroll_imports',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.payroll_imports t),
      'payroll_attendance_raw',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.payroll_attendance_raw t),
      'payroll_days',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.payroll_days t),
      'payroll_runs',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.payroll_runs t),
      'payroll_payments',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.payroll_payments t),
      'payroll_audit',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.payroll_audit t),
      'payroll_rule_versions',(select coalesce(jsonb_agg(to_jsonb(t) order by version),'[]') from public.payroll_rule_versions t),
      'payroll_reviews',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.payroll_reviews t),
      'payroll_run_adjustments',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.payroll_run_adjustments t),
      'payroll_payment_reversals',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.payroll_payment_reversals t),
      'payroll_service_payment_details',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.payroll_service_payment_details t),'payroll_attachments',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.payroll_attachments t)),
    'sensitive_count',(select count(*) from private.payroll_sensitive_versions),
    'sensitive',(select coalesce(jsonb_agg(jsonb_build_object('id',v.id,'version',v.version,'employee_id',v.employee_id,
      'reason',v.reason,'created_by',v.created_by,'created_at',v.created_at,'data',s.decrypted_secret::jsonb) order by v.version),'[]')
      from private.payroll_sensitive_versions v join vault.decrypted_secrets s on s.id=v.secret_id)) into payload;
  if jsonb_array_length(payload->'sensitive')<>(payload->>'sensitive_count')::bigint then raise exception 'PAYROLL_VAULT_VERSION_MISSING';end if;
  if octet_length(payload::text)>10485760 then raise exception 'PAYROLL_BACKUP_EXCEEDS_10_MIB';end if;
  return payload;
end; $function$;
CREATE OR REPLACE FUNCTION private.payroll_restore(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare allowed_tables constant text[]:=array['payroll_employees','payroll_imports','payroll_terms','payroll_rule_versions',
  'payroll_days','payroll_reviews','payroll_runs','payroll_run_adjustments','payroll_payments','payroll_payment_reversals',
  'payroll_attendance_raw','payroll_attachments','payroll_service_payment_details','payroll_audit','payroll_employment_conversions'];
  t text;row_data jsonb;v_rows jsonb;pair record;v_count bigint;v_counts jsonb:='{}';v_fingerprint text;v_secret uuid;v_receipt uuid;v_revision bigint;
begin
  perform public.payroll_assert_admin();
  if jsonb_typeof(p_payload) is distinct from 'object' or p_payload->>'format' is distinct from 'DGV_PAYROLL_BACKUP'
    or p_payload->>'version' is distinct from '2' or octet_length(p_payload::text)>10485760
    or jsonb_typeof(p_payload->'tables') is distinct from 'object' or jsonb_typeof(p_payload->'sensitive') is distinct from 'array'
    or jsonb_typeof(p_payload->'revision') is distinct from 'number' then raise exception 'PAYROLL_INVALID_BACKUP';end if;
  v_revision:=(p_payload->>'revision')::bigint;
  if v_revision<0 or v_revision::numeric<>(p_payload->>'revision')::numeric then raise exception 'PAYROLL_INVALID_BACKUP_REVISION';end if;
  if not (p_payload->'tables' ? 'payroll_employment_conversions') then p_payload:=jsonb_set(p_payload,'{tables,payroll_employment_conversions}','[]'::jsonb);end if;
  if exists(select 1 from jsonb_object_keys(p_payload->'tables') k where not k=any(allowed_tables)) then raise exception 'PAYROLL_UNKNOWN_BACKUP_TABLE';end if;
  if not (p_payload->'tables' ? 'payroll_service_payment_details') then p_payload:=jsonb_set(p_payload,'{tables,payroll_service_payment_details}','[]'::jsonb);end if;
  foreach t in array allowed_tables loop
    if jsonb_typeof(p_payload->'tables'->t) is distinct from 'array' or jsonb_array_length(p_payload->'tables'->t)>50000 then raise exception 'PAYROLL_INVALID_BACKUP_TABLE: %',t;end if;
    for row_data in select value from jsonb_array_elements(p_payload->'tables'->t) loop
      if jsonb_typeof(row_data) is distinct from 'object' or not coalesce(isfinite((row_data->>'created_at')::timestamptz),false)
        or (row_data ? 'updated_at' and not coalesce(isfinite((row_data->>'updated_at')::timestamptz),false)) then
        raise exception 'PAYROLL_INVALID_BACKUP_ROW_TIMESTAMP: %',t;
      end if;
    end loop;
    v_counts:=v_counts||jsonb_build_object(t,jsonb_array_length(p_payload->'tables'->t));
  end loop;
  if jsonb_array_length(p_payload->'sensitive')>10000 then raise exception 'PAYROLL_INVALID_SENSITIVE_BACKUP';end if;
  if p_payload ? 'sensitive_count' and (p_payload->>'sensitive_count')::bigint<>jsonb_array_length(p_payload->'sensitive') then raise exception 'PAYROLL_INVALID_SENSITIVE_BACKUP_COUNT';end if;
  -- This is an idempotence fingerprint, not encryption or authentication.
  -- The client envelope supplies AES-GCM authentication and password encryption.
  v_fingerprint:=md5(p_payload::text)||':'||octet_length(p_payload::text)::text;
  select id into v_receipt from private.payroll_restore_receipts where fingerprint=v_fingerprint;
  if found then return jsonb_build_object('restored',false,'replayed',true,'receipt_id',v_receipt,'counts',v_counts,
    'missing_evidence',private.payroll_missing_evidence());end if;

  -- NOWAIT avoids a lock-order deadlock with active imports. A busy restore is
  -- safely retried; it never waits while holding a globally disabled trigger.
  lock table public.payroll_employment_conversions,public.payroll_employees,public.payroll_imports,public.payroll_terms,public.payroll_rule_versions,
    public.payroll_days,public.payroll_reviews,public.payroll_runs,public.payroll_run_adjustments,public.payroll_payments,
    public.payroll_payment_reversals,public.payroll_attendance_raw,public.payroll_attachments,public.payroll_service_payment_details,public.payroll_audit,
    public.payroll_revision,private.payroll_sensitive_versions,private.payroll_restore_receipts in access exclusive mode nowait;
  -- Recheck after locking to serialize two identical concurrent requests.
  select id into v_receipt from private.payroll_restore_receipts where fingerprint=v_fingerprint;
  if found then return jsonb_build_object('restored',false,'replayed',true,'receipt_id',v_receipt,'counts',v_counts,
    'missing_evidence',private.payroll_missing_evidence());end if;
  if not (p_payload->'tables' ? 'payroll_service_payment_details') then p_payload:=jsonb_set(p_payload,'{tables,payroll_service_payment_details}','[]'::jsonb);end if;
  foreach t in array allowed_tables loop
    execute format('select count(*) from public.%I',t) into v_count;
    if v_count<>0 then raise exception 'PAYROLL_RESTORE_REQUIRES_EMPTY_DATABASE';end if;
  end loop;
  if exists(select 1 from private.payroll_sensitive_versions) then raise exception 'PAYROLL_RESTORE_REQUIRES_EMPTY_DATABASE';end if;

  -- All changes, including trigger state, are transactional and covered by the
  -- exclusive table locks. Any validation error rolls the entire operation back.
  if not (p_payload->'tables' ? 'payroll_service_payment_details') then p_payload:=jsonb_set(p_payload,'{tables,payroll_service_payment_details}','[]'::jsonb);end if;
  foreach t in array allowed_tables loop execute format('alter table public.%I disable trigger user',t);end loop;
  alter table public.payroll_revision disable trigger user;
  alter table private.payroll_sensitive_versions disable trigger user;
  if not (p_payload->'tables' ? 'payroll_service_payment_details') then p_payload:=jsonb_set(p_payload,'{tables,payroll_service_payment_details}','[]'::jsonb);end if;
  foreach t in array allowed_tables loop
    v_rows:=p_payload->'tables'->t;
    if t='payroll_employees' then select coalesce(jsonb_agg(jsonb_build_object('payee_type','employee')||value),'[]'::jsonb) into v_rows from jsonb_array_elements(v_rows);
    elsif t='payroll_terms' then
      -- Version 2 archives created before monthly settlement have no new keys.
      -- Preserve their prior statutory behavior and recorded break times. A
      -- present null/invalid key is never replaced by a compatibility default.
      select coalesce(jsonb_agg(jsonb_build_object('monthly_settlement','statutory',
        'monthly_extra_hourly_rate',null,'weekly_rest_day',0)||value),'[]'::jsonb)
        into v_rows from jsonb_array_elements(v_rows);
    elsif t='payroll_payments' then
      -- Old archives have no employee/month keys. Derive only absent keys from
      -- the already restored run. Explicit NULL or conflicting keys fail the
      -- NOT NULL/composite FK constraints. New runless advance keys stay intact.
      select coalesce(jsonb_agg(jsonb_build_object('employee_id',r.employee_id,'payroll_month',r.month)||item.value),'[]'::jsonb)
        into v_rows from jsonb_array_elements(v_rows) item
        left join public.payroll_runs r on r.id=(item.value->>'run_id')::uuid;
    elsif t='payroll_attendance_raw' then
      -- Pre-kiosk archives have only POS/import rows. Explicit null or invalid
      -- fields still fail constraints; typed kiosk history is preserved exactly.
      select coalesce(jsonb_agg(jsonb_build_object('source','excel','punch_type',null,
        'kiosk_device_id',null,'kiosk_request_id',null)||value),'[]'::jsonb)
        into v_rows from jsonb_array_elements(v_rows);
    end if;
    execute format('insert into public.%I overriding system value select * from jsonb_populate_recordset(null::public.%I,$1)',t,t)
      using v_rows;
  end loop;
  for row_data in select value from jsonb_array_elements(p_payload->'sensitive') loop
    if jsonb_typeof(row_data->'data') is distinct from 'object' or not coalesce(isfinite((row_data->>'created_at')::timestamptz),false) then raise exception 'PAYROLL_INVALID_SENSITIVE_BACKUP';end if;
    for pair in select key,value from jsonb_each(row_data->'data') loop
      if pair.key not in ('bank_name','bank_account','account_holder','national_id','tax_id')
        or jsonb_typeof(pair.value)<>'string' or length(pair.value#>>'{}')>300 then raise exception 'PAYROLL_INVALID_SENSITIVE_FIELD';end if;
    end loop;
    -- Never trust or reuse a Vault secret ID supplied by a backup.
    v_secret:=vault.create_secret((row_data->'data')::text,'payroll:'||(row_data->>'employee_id')||':'||gen_random_uuid()::text,'Restored encrypted payroll details');
    insert into private.payroll_sensitive_versions(id,version,employee_id,secret_id,reason,created_by,created_at) overriding system value
      values((row_data->>'id')::uuid,(row_data->>'version')::bigint,(row_data->>'employee_id')::uuid,v_secret,
        row_data->>'reason',(row_data->>'created_by')::uuid,(row_data->>'created_at')::timestamptz);
  end loop;
  -- Validate invariants that normally live in row triggers as well as the
  -- always-active table CHECK, UNIQUE and foreign-key constraints.
  if exists(select 1 from public.payroll_run_balances b where total<0 or total>999999999999
      or (paid>total and exists(select 1 from public.payroll_payments p where p.employee_id=b.employee_id and p.payroll_month=b.month
        and p.run_id is not null and not exists(select 1 from public.payroll_payment_reversals v where v.payment_id=p.id))))
    or exists(select 1 from public.payroll_runs where jsonb_typeof(snapshot->'unresolved') is distinct from 'number'
      or (snapshot->>'unresolved')::numeric<>0 or expected_revision>v_revision)
    or exists(select 1 from public.payroll_reviews where source_revision>v_revision)
    or exists(select 1 from public.payroll_employees where active is distinct from (employment_status='active')) then
    raise exception 'PAYROLL_BACKUP_INCONSISTENT_BALANCES_OR_SNAPSHOT';
  end if;
  for row_data in select to_jsonb(d) from public.payroll_days d loop
    perform public.payroll_check_intervals(row_data->'overtime_intervals',(row_data->>'work_date')::date);
    perform public.payroll_check_intervals(row_data->'night_intervals',(row_data->>'work_date')::date);
    if ((row_data->>'overtime_approved')::boolean or (row_data->>'night_approved')::boolean) and length(btrim(row_data->>'approval_reason'))=0 then raise exception 'PAYROLL_APPROVAL_REASON_REQUIRED';end if;
  end loop;
  if exists(select 1 from public.payroll_attachments a where split_part(a.storage_path,'/',1)<>a.payment_id::text
    or a.storage_path!~'^[0-9a-f-]{36}/[0-9a-f-]{36}\.(pdf|png|jpg|jpeg|webp)$'
    or (a.evidence_type='signature' and (a.mime_type<>'image/png' or a.acknowledged_at>now()+interval '5 minutes')))
    or exists(select 1 from public.payroll_attachments a join storage.objects o on o.bucket_id='payroll-evidence' and o.name=a.storage_path
      where o.metadata->>'mimetype' is distinct from a.mime_type or (o.metadata->>'size')::bigint is distinct from a.byte_size::bigint) then
    raise exception 'PAYROLL_BACKUP_INVALID_EVIDENCE';
  end if;
  -- Never reuse an old live revision: a browser holding a pre-restore draft
  -- must reload even if the restored archive came from this same database.
  if exists(select 1 from public.payroll_employment_conversions c join public.payroll_terms t on t.id=c.term_id join public.payroll_employees e on e.id=c.employee_id where t.employee_id<>e.id or t.effective_from<>c.effective_from or (c.employment_type='full_time' and (t.pay_type<>'monthly' or t.monthly_settlement<>'monthly_net')) or (c.employment_type='part_time' and t.pay_type<>'hourly') or e.hire_date is distinct from c.original_hire_date) then raise exception 'PAYROLL_CONVERSION_INVALID';end if;
  update public.payroll_revision set version=greatest(version,v_revision)+1 where id=1;
  perform setval('public.payroll_rule_versions_version_seq',greatest((select last_value from public.payroll_rule_versions_version_seq),
    coalesce((select max(version) from public.payroll_rule_versions),1)),true);
  perform setval('private.payroll_sensitive_versions_version_seq',greatest((select last_value from private.payroll_sensitive_versions_version_seq),
    coalesce((select max(version) from private.payroll_sensitive_versions),1)),true);
  -- Flush this table's deferred provenance FK before ALTER TRIGGER. Otherwise
  -- PostgreSQL correctly refuses to alter a table with pending trigger events.
  set constraints public.payroll_attendance_raw_import_id_fkey immediate;
  if not (p_payload->'tables' ? 'payroll_service_payment_details') then p_payload:=jsonb_set(p_payload,'{tables,payroll_service_payment_details}','[]'::jsonb);end if;
  foreach t in array allowed_tables loop execute format('alter table public.%I enable trigger user',t);end loop;
  set constraints public.payroll_attendance_raw_import_id_fkey deferred;
  alter table public.payroll_revision enable trigger user;
  alter table private.payroll_sensitive_versions enable trigger user;
  insert into private.payroll_restore_receipts(fingerprint,table_counts,created_by)
    values(v_fingerprint,v_counts,auth.uid()) returning id into v_receipt;
  return jsonb_build_object('restored',true,'replayed',false,'receipt_id',v_receipt,'counts',v_counts,
    'missing_evidence',private.payroll_missing_evidence());
end; $function$;
