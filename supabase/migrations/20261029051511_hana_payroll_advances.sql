-- Actual money can be paid before monthly approval. Keep one immutable payment
-- ledger and the existing payment-ID signatures; no paid-work-hour allocation.
begin;

-- Do not wait while holding a partially acquired DDL lock set against live
-- payments (whose statement trigger locks the revision). Retry the migration
-- if busy; NOWAIT fails before any schema/data/trigger state has changed.
lock table public.payroll_run_balances,public.payroll_revision,public.payroll_employees,
  public.payroll_runs,public.payroll_payments,public.payroll_run_adjustments,
  public.payroll_payment_reversals in access exclusive mode nowait;

alter table public.payroll_payments
  alter column run_id drop not null,
  add column employee_id uuid,
  add column payroll_month date;
-- ALTER TABLE holds an exclusive lock until commit. Only the newly added
-- binding columns are backfilled; original payment/audit/file values stay put.
alter table public.payroll_payments disable trigger user;
update public.payroll_payments p set employee_id=r.employee_id,payroll_month=r.month
  from public.payroll_runs r where r.id=p.run_id;
alter table public.payroll_payments enable trigger user;
alter table public.payroll_runs add constraint payroll_runs_id_employee_month_key unique(id,employee_id,month);
alter table public.payroll_payments
  alter column employee_id set not null,
  alter column payroll_month set not null,
  add constraint payroll_payments_employee_id_fkey foreign key(employee_id) references public.payroll_employees(id),
  add constraint payroll_payments_payroll_month_check check(isfinite(payroll_month) and extract(day from payroll_month)=1),
  add constraint payroll_payments_run_binding_fkey foreign key(run_id,employee_id,payroll_month) references public.payroll_runs(id,employee_id,month),
  add constraint payroll_payments_advance_integer_check check(run_id is not null or amount=trunc(amount));
create index payroll_payments_employee_month_idx on public.payroll_payments(employee_id,payroll_month,paid_on);

create or replace view public.payroll_run_balances with(security_invoker=true) as
select r.id as run_id,r.employee_id,r.month,r.total as original_total,
  coalesce(a.amount,0) as adjustment_total,r.total+coalesce(a.amount,0) as total,
  coalesce(p.amount,0) as paid,r.total+coalesce(a.amount,0)-coalesce(p.amount,0) as balance
from public.payroll_runs r
left join (select run_id,sum(amount) as amount from public.payroll_run_adjustments group by run_id) a on a.run_id=r.id
left join (select p.employee_id,p.payroll_month,sum(p.amount) as amount from public.payroll_payments p
  where not exists(select 1 from public.payroll_payment_reversals v where v.payment_id=p.id)
  group by p.employee_id,p.payroll_month) p on p.employee_id=r.employee_id and p.payroll_month=r.month;

create or replace function public.payroll_guard_row() returns trigger
language plpgsql security invoker set search_path='' as $$
declare current_revision bigint; approved_total numeric; already_paid numeric; v_run uuid;v_employee uuid;v_month date;v_object jsonb;
begin
  perform public.payroll_assert_admin();
  if tg_op='DELETE' or (tg_op='UPDATE' and tg_table_name not in ('payroll_employees','payroll_days')) then raise exception 'PAYROLL_IMMUTABLE_RECORD'; end if;
  if tg_op='INSERT' then new.created_by:=auth.uid();new.created_at:=now();
  else new.created_by:=old.created_by;new.created_at:=old.created_at;
    if new.id<>old.id then raise exception 'PAYROLL_ID_IMMUTABLE'; end if;
  end if;
  if tg_table_name in ('payroll_employees','payroll_terms','payroll_attendance_raw','payroll_days','payroll_runs','payroll_rule_versions','payroll_reviews') then
    select version into current_revision from public.payroll_revision where id=1 for update;
    if current_revision is null then raise exception 'PAYROLL_REVISION_MISSING'; end if;
  end if;
  if tg_table_name='payroll_employees' then
    if tg_op='UPDATE' and new.device_user_id<>old.device_user_id then raise exception 'PAYROLL_DEVICE_ID_IMMUTABLE'; end if;
    if tg_op='UPDATE' and new.active is distinct from old.active and new.employment_status is not distinct from old.employment_status then
      new.employment_status:=case when new.active then 'active' else 'terminated' end;
    else new.active:=new.employment_status='active'; end if;
  elsif tg_table_name='payroll_days' then
    new.updated_by:=auth.uid();new.updated_at:=now();
    if tg_op='UPDATE' and (new.employee_id<>old.employee_id or new.work_date<>old.work_date) then raise exception 'PAYROLL_DAY_KEY_IMMUTABLE'; end if;
    perform public.payroll_check_intervals(new.overtime_intervals,new.work_date);
    perform public.payroll_check_intervals(new.night_intervals,new.work_date);
    if (new.overtime_approved or new.night_approved) and length(btrim(new.approval_reason))=0 then raise exception 'PAYROLL_APPROVAL_REASON_REQUIRED'; end if;
  elsif tg_table_name='payroll_reviews' then
    if new.source_revision is distinct from current_revision then raise exception 'PAYROLL_STALE_RELOAD_REQUIRED'; end if;
  elsif tg_table_name='payroll_runs' then
    if new.expected_revision is distinct from current_revision then raise exception 'PAYROLL_STALE_RELOAD_REQUIRED'; end if;
    if jsonb_typeof(new.snapshot->'unresolved') is distinct from 'number' or (new.snapshot->>'unresolved')::numeric<>0 then raise exception 'PAYROLL_UNRESOLVED_ATTENDANCE'; end if;
    if not exists(select 1 from public.payroll_terms where employee_id=new.employee_id and effective_from<new.month+interval '1 month') then raise exception 'PAYROLL_TERMS_REQUIRED'; end if;
    -- Truthful approval is allowed even if advances exceed this amount. The
    -- balance view shows the excess; never inflate wages or carry another month.
  elsif tg_table_name='payroll_payments' then
    if new.run_id is not null then
      select employee_id,month into v_employee,v_month from public.payroll_runs where id=new.run_id for update;
      if not found then raise exception 'PAYROLL_RUN_NOT_FOUND';end if;
      if (new.employee_id is not null and new.employee_id<>v_employee)
        or (new.payroll_month is not null and new.payroll_month<>v_month) then raise exception 'PAYROLL_PAYMENT_BINDING_MISMATCH';end if;
      new.employee_id:=v_employee;new.payroll_month:=v_month;
      select total,paid into approved_total,already_paid from public.payroll_run_balances where run_id=new.run_id;
      if not (new.amount>0 and new.amount<=999999999999) or already_paid+new.amount>approved_total then
        raise exception 'PAYROLL_OVERPAYMENT_OR_INVALID_AMOUNT';end if;
    else
      if new.employee_id is null or new.payroll_month is null then raise exception 'PAYROLL_ADVANCE_EMPLOYEE_MONTH_REQUIRED';end if;
      perform id from public.payroll_runs where employee_id=new.employee_id and month=new.payroll_month for update;
      if found then raise exception 'PAYROLL_MONTH_ALREADY_FINALIZED';end if;
    end if;
  elsif tg_table_name in ('payroll_run_adjustments','payroll_payment_reversals') then
    if tg_table_name='payroll_payment_reversals' then
      select run_id,employee_id,payroll_month into v_run,v_employee,v_month from public.payroll_payments where id=new.payment_id;
      if not found then raise exception 'PAYROLL_PAYMENT_NOT_FOUND';end if;
      -- A runless payment remains runless forever. Lock its later approval, if
      -- any, by immutable employee/month instead of rewriting historical rows.
      if v_run is null then select id into v_run from public.payroll_runs where employee_id=v_employee and month=v_month;end if;
      if v_run is not null then perform id from public.payroll_runs where id=v_run for update;end if;
    else
      v_run:=new.run_id;
      perform id from public.payroll_runs where id=v_run for update;
      if not found then raise exception 'PAYROLL_RUN_NOT_FOUND';end if;
      select total,paid into approved_total,already_paid from public.payroll_run_balances where run_id=v_run;
      if approved_total+new.amount<already_paid or approved_total+new.amount<0 or approved_total+new.amount>999999999999 then
        raise exception 'PAYROLL_ADJUSTMENT_BELOW_PAID_OR_INVALID';end if;
    end if;
  elsif tg_table_name='payroll_attachments' then
    if split_part(new.storage_path,'/',1)<>new.payment_id::text then raise exception 'PAYROLL_EVIDENCE_PAYMENT_PATH_MISMATCH'; end if;
    select metadata into v_object from storage.objects where bucket_id='payroll-evidence' and name=new.storage_path;
    if v_object is null or (v_object->>'size')::bigint is distinct from new.byte_size::bigint
      or v_object->>'mimetype' is distinct from new.mime_type then raise exception 'PAYROLL_EVIDENCE_OBJECT_MISMATCH'; end if;
    if new.evidence_type='signature' and (new.mime_type<>'image/png' or new.acknowledged_at>now()+interval '5 minutes') then raise exception 'PAYROLL_INVALID_SIGNATURE_ACKNOWLEDGEMENT'; end if;
  end if;
  return new;
end;$$;

create function public.payroll_pay_advance(p_employee_id uuid,p_payroll_month date,p_amount numeric,p_paid_on date,p_method text,
  p_reference text,p_note text,p_request_id uuid) returns uuid
language plpgsql security invoker set search_path='' as $$
declare existing public.payroll_payments%rowtype;v_id uuid;
begin
  perform public.payroll_assert_admin();
  if p_request_id is null then raise exception 'PAYROLL_PAYMENT_REQUEST_REQUIRED';end if;
  perform version from public.payroll_revision where id=1 for update;
  select * into existing from public.payroll_payments where request_id=p_request_id;
  if found then
    if existing.run_id is not null or existing.employee_id is distinct from p_employee_id or existing.payroll_month is distinct from p_payroll_month
      or existing.amount is distinct from p_amount or existing.paid_on is distinct from p_paid_on or existing.method is distinct from p_method
      or existing.reference is distinct from coalesce(p_reference,'') or existing.note is distinct from coalesce(p_note,'') then
      raise exception 'PAYROLL_PAYMENT_REQUEST_CONFLICT';end if;
    return existing.id;
  end if;
  insert into public.payroll_payments(run_id,employee_id,payroll_month,amount,paid_on,method,reference,note,request_id)
    values(null,p_employee_id,p_payroll_month,p_amount,p_paid_on,p_method,coalesce(p_reference,''),coalesce(p_note,''),p_request_id) returning id into v_id;
  return v_id;
end;$$;
revoke all on function public.payroll_pay_advance(uuid,date,numeric,date,text,text,text,uuid) from public,anon,authenticated;
grant execute on function public.payroll_pay_advance(uuid,date,numeric,date,text,text,text,uuid) to authenticated;

create or replace function public.payroll_reverse_payment(p_payment_id uuid,p_reason text,p_request_id uuid) returns uuid
language plpgsql security invoker set search_path='' as $$
declare v_run uuid;v_id uuid;payment public.payroll_payments%rowtype;existing public.payroll_payment_reversals%rowtype;
begin
  perform public.payroll_assert_admin();
  perform version from public.payroll_revision where id=1 for update;
  select * into payment from public.payroll_payments where id=p_payment_id;
  if not found then raise exception 'PAYROLL_PAYMENT_NOT_FOUND';end if;
  v_run:=payment.run_id;
  if v_run is null then select id into v_run from public.payroll_runs where employee_id=payment.employee_id and month=payment.payroll_month;end if;
  if v_run is not null then perform id from public.payroll_runs where id=v_run for update;end if;
  select * into existing from public.payroll_payment_reversals where request_id=p_request_id;
  if found then
    if existing.payment_id is distinct from p_payment_id or existing.reason is distinct from p_reason then raise exception 'PAYROLL_REVERSAL_REQUEST_CONFLICT';end if;
    return existing.id;
  end if;
  insert into public.payroll_payment_reversals(payment_id,reason,request_id) values(p_payment_id,p_reason,p_request_id) returning id into v_id;
  return v_id;
end;$$;

comment on column public.payroll_payments.employee_id is 'Immutable employee binding for every actual payment. Legacy run-linked rows derive it from their approval.';
comment on column public.payroll_payments.payroll_month is 'First date of the salary month this payment settles, independent of actual paid_on date. Never automatically moved to another month.';
comment on column public.payroll_payments.run_id is 'NULL means an advance recorded before monthly approval. It remains NULL after approval; balances join by employee_id/payroll_month.';
comment on column public.payroll_payments.paid_on is 'Administrator-recorded actual payment calendar date. created_at is server entry time, not a fabricated actual payment clock time.';
comment on view public.payroll_run_balances is 'Approved total less all unreversed employee/month payments, including immutable runless advances. Negative balance truthfully reports an overpayment; no automatic carry-forward.';

create or replace function private.payroll_restore(p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare allowed_tables constant text[]:=array['payroll_employees','payroll_imports','payroll_terms','payroll_rule_versions',
  'payroll_days','payroll_reviews','payroll_runs','payroll_run_adjustments','payroll_payments','payroll_payment_reversals',
  'payroll_attendance_raw','payroll_attachments','payroll_audit'];
  t text;row_data jsonb;v_rows jsonb;pair record;v_count bigint;v_counts jsonb:='{}';v_fingerprint text;v_secret uuid;v_receipt uuid;v_revision bigint;
begin
  perform public.payroll_assert_admin();
  if jsonb_typeof(p_payload) is distinct from 'object' or p_payload->>'format' is distinct from 'DGV_PAYROLL_BACKUP'
    or p_payload->>'version' is distinct from '2' or octet_length(p_payload::text)>10485760
    or jsonb_typeof(p_payload->'tables') is distinct from 'object' or jsonb_typeof(p_payload->'sensitive') is distinct from 'array'
    or jsonb_typeof(p_payload->'revision') is distinct from 'number' then raise exception 'PAYROLL_INVALID_BACKUP';end if;
  v_revision:=(p_payload->>'revision')::bigint;
  if v_revision<0 or v_revision::numeric<>(p_payload->>'revision')::numeric then raise exception 'PAYROLL_INVALID_BACKUP_REVISION';end if;
  if exists(select 1 from jsonb_object_keys(p_payload->'tables') k where not k=any(allowed_tables)) then raise exception 'PAYROLL_UNKNOWN_BACKUP_TABLE';end if;
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
  lock table public.payroll_employees,public.payroll_imports,public.payroll_terms,public.payroll_rule_versions,
    public.payroll_days,public.payroll_reviews,public.payroll_runs,public.payroll_run_adjustments,public.payroll_payments,
    public.payroll_payment_reversals,public.payroll_attendance_raw,public.payroll_attachments,public.payroll_audit,
    public.payroll_revision,private.payroll_sensitive_versions,private.payroll_restore_receipts in access exclusive mode nowait;
  -- Recheck after locking to serialize two identical concurrent requests.
  select id into v_receipt from private.payroll_restore_receipts where fingerprint=v_fingerprint;
  if found then return jsonb_build_object('restored',false,'replayed',true,'receipt_id',v_receipt,'counts',v_counts,
    'missing_evidence',private.payroll_missing_evidence());end if;
  foreach t in array allowed_tables loop
    execute format('select count(*) from public.%I',t) into v_count;
    if v_count<>0 then raise exception 'PAYROLL_RESTORE_REQUIRES_EMPTY_DATABASE';end if;
  end loop;
  if exists(select 1 from private.payroll_sensitive_versions) then raise exception 'PAYROLL_RESTORE_REQUIRES_EMPTY_DATABASE';end if;

  -- All changes, including trigger state, are transactional and covered by the
  -- exclusive table locks. Any validation error rolls the entire operation back.
  foreach t in array allowed_tables loop execute format('alter table public.%I disable trigger user',t);end loop;
  alter table public.payroll_revision disable trigger user;
  alter table private.payroll_sensitive_versions disable trigger user;
  foreach t in array allowed_tables loop
    v_rows:=p_payload->'tables'->t;
    if t='payroll_terms' then
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
  update public.payroll_revision set version=greatest(version,v_revision)+1 where id=1;
  perform setval('public.payroll_rule_versions_version_seq',greatest((select last_value from public.payroll_rule_versions_version_seq),
    coalesce((select max(version) from public.payroll_rule_versions),1)),true);
  perform setval('private.payroll_sensitive_versions_version_seq',greatest((select last_value from private.payroll_sensitive_versions_version_seq),
    coalesce((select max(version) from private.payroll_sensitive_versions),1)),true);
  -- Flush this table's deferred provenance FK before ALTER TRIGGER. Otherwise
  -- PostgreSQL correctly refuses to alter a table with pending trigger events.
  set constraints public.payroll_attendance_raw_import_id_fkey immediate;
  foreach t in array allowed_tables loop execute format('alter table public.%I enable trigger user',t);end loop;
  set constraints public.payroll_attendance_raw_import_id_fkey deferred;
  alter table public.payroll_revision enable trigger user;
  alter table private.payroll_sensitive_versions enable trigger user;
  insert into private.payroll_restore_receipts(fingerprint,table_counts,created_by)
    values(v_fingerprint,v_counts,auth.uid()) returning id into v_receipt;
  return jsonb_build_object('restored',true,'replayed',false,'receipt_id',v_receipt,'counts',v_counts,
    'missing_evidence',private.payroll_missing_evidence());
end; $$;

commit;
