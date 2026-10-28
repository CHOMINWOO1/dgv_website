-- Complete payroll records without changing public sales/expense accounting.
begin;

alter table public.payroll_employees
  add column phone text not null default '' check(length(phone)<=80),
  add column employment_type text not null default 'full_time' check(employment_type in ('full_time','part_time')),
  add column hire_date date check(hire_date is null or isfinite(hire_date)),
  add column termination_date date check(termination_date is null or isfinite(termination_date)),
  add column employment_status text not null default 'active' check(employment_status in ('active','leave','terminated')),
  add column payment_method text not null default 'cash' check(payment_method in ('cash','bank','mixed')),
  add constraint payroll_employment_dates check(termination_date is null or hire_date is null or termination_date>=hire_date);
-- Backfill only the new status field from the prior active flag. Existing values
-- and audit history remain untouched; triggers are restored within this transaction.
alter table public.payroll_employees disable trigger payroll_guard;
alter table public.payroll_employees disable trigger payroll_audit;
update public.payroll_employees set employment_status='terminated' where not active;
alter table public.payroll_employees enable trigger payroll_guard;
alter table public.payroll_employees enable trigger payroll_audit;
alter table public.payroll_terms add column overtime_hourly_rate numeric(14,2)
  check(overtime_hourly_rate is null or overtime_hourly_rate between 0 and 999999999999);
alter table public.payroll_days
  add column overtime_intervals jsonb not null default '[]',
  add column night_intervals jsonb not null default '[]',
  add column overtime_approved boolean not null default false,
  add column night_approved boolean not null default false,
  add column approval_reason text not null default '' check(length(approval_reason)<=1000);

create table public.payroll_rule_versions(
  id uuid primary key default gen_random_uuid(),
  version bigint generated always as identity unique check(version>0),
  effective_from date not null unique check(isfinite(effective_from)),
  ot_enabled boolean not null default false,
  regular_overtime_multiplier numeric(8,4) not null default 1.5 check(regular_overtime_multiplier between 1.5 and 100),
  rest_overtime_multiplier numeric(8,4) not null default 2 check(rest_overtime_multiplier between 2 and 100),
  holiday_overtime_multiplier numeric(8,4) not null default 3 check(holiday_overtime_multiplier between 3 and 100),
  night_premium_rate numeric(8,4) not null default 0.3 check(night_premium_rate between 0.3 and 100),
  night_overtime_extra_rate numeric(8,4) not null default 0.2 check(night_overtime_extra_rate between 0.2 and 100),
  night_start time not null default '22:00',
  night_end time not null default '06:00',
  monthly_proration text not null default 'none' check(monthly_proration in ('none','scheduled')),
  monthly_hour_basis text not null default 'schedule' check(monthly_hour_basis in ('contract','schedule')),
  monthly_contract_hours numeric(8,2) check(monthly_contract_hours>0 and monthly_contract_hours<=744),
  default_weekly_rest_days integer[] not null default array[0] check(default_weekly_rest_days<@array[0,1,2,3,4,5,6] and cardinality(default_weekly_rest_days)<=7),
  monthly_overtime_limit integer not null default 40 check(monthly_overtime_limit between 0 and 744),
  annual_overtime_limit integer not null default 200 check(annual_overtime_limit between 0 and 8784),
  pay_day integer not null default 5 check(pay_day between 1 and 28),
  reason text not null check(length(btrim(reason)) between 1 and 1000),
  created_by uuid not null default auth.uid(),created_at timestamptz not null default now(),
  check(night_start<>'24:00'::time and night_end<>'24:00'::time and night_start<>night_end)
);

create table public.payroll_reviews(
  id uuid primary key default gen_random_uuid(),employee_id uuid not null references public.payroll_employees(id),
  month date not null check(isfinite(month) and extract(day from month)=1),
  source_revision bigint not null check(source_revision>=0),
  snapshot jsonb not null check(jsonb_typeof(snapshot)='object' and octet_length(snapshot::text)<=2097152),
  reason text not null check(length(btrim(reason)) between 1 and 1000),
  created_by uuid not null default auth.uid(),created_at timestamptz not null default now(),
  unique(employee_id,month,source_revision)
);
create index payroll_reviews_month_idx on public.payroll_reviews(month,employee_id);

create table public.payroll_run_adjustments(
  id uuid primary key default gen_random_uuid(),run_id uuid not null references public.payroll_runs(id),
  amount numeric(14,2) not null check(amount between -999999999999 and 999999999999 and amount<>0),
  reason text not null check(length(btrim(reason)) between 1 and 1000),request_id uuid not null unique,
  created_by uuid not null default auth.uid(),created_at timestamptz not null default now()
);
create index payroll_adjustment_run_idx on public.payroll_run_adjustments(run_id);
create table public.payroll_payment_reversals(
  id uuid primary key default gen_random_uuid(),payment_id uuid not null unique references public.payroll_payments(id),
  reason text not null check(length(btrim(reason)) between 1 and 1000),request_id uuid not null unique,
  reversed_on date not null default ((now() at time zone 'Asia/Ho_Chi_Minh')::date) check(isfinite(reversed_on)),
  created_by uuid not null default auth.uid(),created_at timestamptz not null default now()
);

create table public.payroll_attachments(
  id uuid primary key default gen_random_uuid(),payment_id uuid not null references public.payroll_payments(id),
  storage_path text not null unique check(length(storage_path)<=200),
  filename text not null check(length(btrim(filename)) between 1 and 255),
  mime_type text not null check(mime_type in ('application/pdf','image/png','image/jpeg','image/webp')),
  byte_size integer not null check(byte_size between 1 and 5242880),
  evidence_type text not null check(evidence_type in ('receipt','bank_transfer','signature','tax_invoice')),
  signed_name text check(length(signed_name)<=200),acknowledged_at timestamptz,
  created_by uuid not null default auth.uid(),created_at timestamptz not null default now(),
  check(evidence_type<>'signature' or (signed_name is not null and length(btrim(signed_name))>0 and acknowledged_at is not null and isfinite(acknowledged_at)))
);
create index payroll_attachments_payment_idx on public.payroll_attachments(payment_id);

create schema if not exists private;
create table private.payroll_sensitive_versions(
  id uuid primary key default gen_random_uuid(),version bigint generated always as identity unique check(version>0),
  employee_id uuid not null references public.payroll_employees(id),secret_id uuid not null unique,
  reason text not null check(length(btrim(reason)) between 1 and 1000),
  created_by uuid not null,created_at timestamptz not null default now()
);
create index payroll_sensitive_employee_idx on private.payroll_sensitive_versions(employee_id,version desc);
alter table private.payroll_sensitive_versions enable row level security;
revoke all on private.payroll_sensitive_versions from public,anon,authenticated,service_role;

do $$ declare t text; begin
  foreach t in array array['payroll_rule_versions','payroll_reviews','payroll_run_adjustments','payroll_payment_reversals',
    'payroll_attachments'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public,anon,authenticated',t);
    execute format('grant select,insert on public.%I to authenticated',t);
    execute format('create policy %I on public.%I for select to authenticated using ((select auth.uid()) is not null and (select public.has_app_role(array[''admin''])))',t||'_admin_read',t);
    execute format('create policy %I on public.%I for insert to authenticated with check ((select auth.uid()) is not null and (select public.has_app_role(array[''admin''])))',t||'_admin_insert',t);
  end loop;
end; $$;
grant usage on sequence public.payroll_rule_versions_version_seq to authenticated;
create view public.payroll_run_balances with(security_invoker=true) as
select r.id as run_id,r.employee_id,r.month,r.total as original_total,
  coalesce(a.amount,0) as adjustment_total,r.total+coalesce(a.amount,0) as total,
  coalesce(p.amount,0) as paid,r.total+coalesce(a.amount,0)-coalesce(p.amount,0) as balance
from public.payroll_runs r
left join (select run_id,sum(amount) as amount from public.payroll_run_adjustments group by run_id) a on a.run_id=r.id
left join (select p.run_id,sum(p.amount) as amount from public.payroll_payments p
  where not exists(select 1 from public.payroll_payment_reversals v where v.payment_id=p.id) group by p.run_id) p on p.run_id=r.id;
revoke all on public.payroll_run_balances from public,anon,authenticated;
grant select on public.payroll_run_balances to authenticated;

create function public.payroll_check_intervals(p_intervals jsonb,p_date date) returns void
language plpgsql security invoker set search_path='' as $$
declare item jsonb; starts timestamp; ends timestamp; previous_end timestamp;
begin
  if jsonb_typeof(p_intervals) is distinct from 'array' or jsonb_array_length(p_intervals)>16 then raise exception 'PAYROLL_INVALID_APPROVAL_INTERVALS'; end if;
  for item in select value from jsonb_array_elements(p_intervals) order by (value->>'start')::timestamp loop
    if jsonb_typeof(item) is distinct from 'object' or jsonb_typeof(item->'start') is distinct from 'string'
      or jsonb_typeof(item->'end') is distinct from 'string'
      or item->>'start' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}(:[0-9]{2})?$'
      or item->>'end' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}(:[0-9]{2})?$' then raise exception 'PAYROLL_INVALID_APPROVAL_INTERVAL'; end if;
    starts:=(item->>'start')::timestamp; ends:=(item->>'end')::timestamp;
    if not isfinite(starts) or not isfinite(ends) or starts<p_date::timestamp or ends>p_date::timestamp+interval '2 days'
      or ends<=starts or ends>starts+interval '24 hours' or (previous_end is not null and starts<previous_end) then
      raise exception 'PAYROLL_OVERLAPPING_OR_INVALID_INTERVAL';
    end if;
    previous_end:=ends;
  end loop;
end; $$;

create or replace function public.payroll_guard_row() returns trigger
language plpgsql security invoker set search_path='' as $$
declare current_revision bigint; approved_total numeric; already_paid numeric; v_run uuid; v_object jsonb;
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
  elsif tg_table_name in ('payroll_payments','payroll_run_adjustments','payroll_payment_reversals') then
    if tg_table_name='payroll_payment_reversals' then
      select run_id into v_run from public.payroll_payments where id=new.payment_id;
    else v_run:=new.run_id; end if;
    perform id from public.payroll_runs where id=v_run for update;
    if not found then raise exception 'PAYROLL_RUN_NOT_FOUND'; end if;
    select total,paid into approved_total,already_paid from public.payroll_run_balances where run_id=v_run;
    if tg_table_name='payroll_payments' then
      if not (new.amount>0 and new.amount<=999999999999) or already_paid+new.amount>approved_total then raise exception 'PAYROLL_OVERPAYMENT_OR_INVALID_AMOUNT'; end if;
    elsif tg_table_name='payroll_run_adjustments' then
      if approved_total+new.amount<already_paid or approved_total+new.amount<0 or approved_total+new.amount>999999999999 then raise exception 'PAYROLL_ADJUSTMENT_BELOW_PAID_OR_INVALID'; end if;
    end if;
  elsif tg_table_name='payroll_attachments' then
    if split_part(new.storage_path,'/',1)<>new.payment_id::text then raise exception 'PAYROLL_EVIDENCE_PAYMENT_PATH_MISMATCH'; end if;
    select metadata into v_object from storage.objects where bucket_id='payroll-evidence' and name=new.storage_path;
    if v_object is null or (v_object->>'size')::bigint is distinct from new.byte_size::bigint
      or v_object->>'mimetype' is distinct from new.mime_type then raise exception 'PAYROLL_EVIDENCE_OBJECT_MISMATCH'; end if;
    if new.evidence_type='signature' and (new.mime_type<>'image/png' or new.acknowledged_at>now()+interval '5 minutes') then raise exception 'PAYROLL_INVALID_SIGNATURE_ACKNOWLEDGEMENT'; end if;
  end if;
  return new;
end; $$;

create or replace function public.payroll_record_change() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  insert into public.payroll_audit(table_name,record_id,action,before_data,after_data,created_by)
    values(tg_table_name,new.id,tg_op,case when tg_op='UPDATE' then to_jsonb(old) else null end,to_jsonb(new),auth.uid());
  if tg_table_name in ('payroll_employees','payroll_terms','payroll_attendance_raw','payroll_days','payroll_rule_versions','payroll_sensitive_versions') then
    update public.payroll_revision set version=version+1 where id=1;
  end if;
  return new;
end; $$;
do $$ declare t text; begin
  foreach t in array array['payroll_rule_versions','payroll_reviews','payroll_run_adjustments','payroll_payment_reversals',
    'payroll_attachments'] loop
    execute format('create trigger payroll_guard before insert or update or delete on public.%I for each row execute function public.payroll_guard_row()',t);
    execute format('create trigger payroll_audit after insert or update on public.%I for each row execute function public.payroll_record_change()',t);
  end loop;
end; $$;
create trigger payroll_sensitive_audit after insert on private.payroll_sensitive_versions for each row execute function public.payroll_record_change();

-- Encrypted fields have a separate, tightly scoped privilege boundary. Browser
-- roles receive no Vault/table access. Both public and private calls check admin.
create function private.payroll_set_sensitive(p_employee_id uuid,p_data jsonb,p_reason text) returns uuid
language plpgsql security definer set search_path='' as $$
declare v_secret uuid;v_id uuid;v_pair record;
begin
  perform public.payroll_assert_admin();
  if jsonb_typeof(p_data) is distinct from 'object' or p_reason is null or length(btrim(p_reason)) not between 1 and 1000 then raise exception 'PAYROLL_INVALID_SENSITIVE_DATA'; end if;
  for v_pair in select key,value from jsonb_each(p_data) loop
    if v_pair.key not in ('bank_name','bank_account','account_holder','national_id','tax_id')
      or jsonb_typeof(v_pair.value)<>'string' or length(v_pair.value#>>'{}')>300 then raise exception 'PAYROLL_INVALID_SENSITIVE_FIELD'; end if;
  end loop;
  perform version from public.payroll_revision where id=1 for update;
  if not exists(select 1 from public.payroll_employees where id=p_employee_id) then raise exception 'PAYROLL_EMPLOYEE_NOT_FOUND'; end if;
  v_secret:=vault.create_secret(p_data::text,'payroll:'||p_employee_id::text||':'||gen_random_uuid()::text,'Encrypted payroll employee details');
  insert into private.payroll_sensitive_versions(employee_id,secret_id,reason,created_by)
    values(p_employee_id,v_secret,btrim(p_reason),auth.uid()) returning id into v_id;
  return v_id;
end; $$;
create function private.payroll_get_sensitive(p_employee_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_result jsonb;
begin
  perform public.payroll_assert_admin();
  select s.decrypted_secret::jsonb into v_result from private.payroll_sensitive_versions v
    join vault.decrypted_secrets s on s.id=v.secret_id where v.employee_id=p_employee_id order by v.version desc limit 1;
  return coalesce(v_result,'{}'::jsonb);
end; $$;
create function public.payroll_set_sensitive(p_employee_id uuid,p_data jsonb,p_reason text) returns uuid
language plpgsql security invoker set search_path='' as $$ begin
  perform public.payroll_assert_admin(); return private.payroll_set_sensitive(p_employee_id,p_data,p_reason);
end; $$;
create function public.payroll_get_sensitive(p_employee_id uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$ begin
  perform public.payroll_assert_admin(); return private.payroll_get_sensitive(p_employee_id);
end; $$;

create function public.payroll_review(p_employee_id uuid,p_month date,p_snapshot jsonb,p_reason text,p_expected_revision bigint) returns uuid
language plpgsql security invoker set search_path='' as $$ declare v_id uuid;begin
  perform public.payroll_assert_admin();
  insert into public.payroll_reviews(employee_id,month,source_revision,snapshot,reason)
    values(p_employee_id,p_month,p_expected_revision,p_snapshot,p_reason) returning id into v_id;
  return v_id;
end; $$;
create function public.payroll_adjust_run(p_run_id uuid,p_amount numeric,p_reason text,p_request_id uuid) returns uuid
language plpgsql security invoker set search_path='' as $$ declare existing public.payroll_run_adjustments%rowtype;v_id uuid;begin
  perform public.payroll_assert_admin();perform id from public.payroll_runs where id=p_run_id for update;
  if not found then raise exception 'PAYROLL_RUN_NOT_FOUND';end if;
  select * into existing from public.payroll_run_adjustments where request_id=p_request_id;
  if found then
    if existing.run_id is distinct from p_run_id or existing.amount is distinct from p_amount or existing.reason is distinct from p_reason then raise exception 'PAYROLL_ADJUSTMENT_REQUEST_CONFLICT';end if;
    return existing.id;
  end if;
  insert into public.payroll_run_adjustments(run_id,amount,reason,request_id) values(p_run_id,p_amount,p_reason,p_request_id) returning id into v_id;
  return v_id;
end; $$;
create function public.payroll_reverse_payment(p_payment_id uuid,p_reason text,p_request_id uuid) returns uuid
language plpgsql security invoker set search_path='' as $$ declare v_run uuid;v_id uuid;existing public.payroll_payment_reversals%rowtype;begin
  perform public.payroll_assert_admin();select run_id into v_run from public.payroll_payments where id=p_payment_id;
  perform id from public.payroll_runs where id=v_run for update;if not found then raise exception 'PAYROLL_PAYMENT_NOT_FOUND';end if;
  select * into existing from public.payroll_payment_reversals where request_id=p_request_id;
  if found then
    if existing.payment_id is distinct from p_payment_id or existing.reason is distinct from p_reason then raise exception 'PAYROLL_REVERSAL_REQUEST_CONFLICT';end if;
    return existing.id;
  end if;
  insert into public.payroll_payment_reversals(payment_id,reason,request_id) values(p_payment_id,p_reason,p_request_id) returning id into v_id;
  return v_id;
end; $$;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
  values('payroll-evidence','payroll-evidence',false,5242880,array['application/pdf','image/png','image/jpeg','image/webp'])
  on conflict(id) do update set public=false,file_size_limit=5242880,allowed_mime_types=excluded.allowed_mime_types;
create policy payroll_evidence_admin_read on storage.objects for select to authenticated
  using(bucket_id='payroll-evidence' and (select auth.uid()) is not null and (select public.has_app_role(array['admin'])));
create policy payroll_evidence_admin_insert on storage.objects for insert to authenticated
  with check(bucket_id='payroll-evidence' and (select auth.uid()) is not null and (select public.has_app_role(array['admin']))
    and name~'^[0-9a-f-]{36}/[0-9a-f-]{36}\.(pdf|png|jpg|jpeg|webp)$'
    and exists(select 1 from public.payroll_payments p where p.id::text=split_part(name,'/',1)));

revoke all on function private.payroll_set_sensitive(uuid,jsonb,text),private.payroll_get_sensitive(uuid) from public,anon,authenticated,service_role;
grant usage on schema private to authenticated;
grant execute on function private.payroll_set_sensitive(uuid,jsonb,text),private.payroll_get_sensitive(uuid) to authenticated;
revoke all on function public.payroll_check_intervals(jsonb,date),public.payroll_set_sensitive(uuid,jsonb,text),public.payroll_get_sensitive(uuid),
  public.payroll_review(uuid,date,jsonb,text,bigint),public.payroll_adjust_run(uuid,numeric,text,uuid),
  public.payroll_reverse_payment(uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.payroll_check_intervals(jsonb,date),public.payroll_set_sensitive(uuid,jsonb,text),public.payroll_get_sensitive(uuid),
  public.payroll_review(uuid,date,jsonb,text,bigint),public.payroll_adjust_run(uuid,numeric,text,uuid),
  public.payroll_reverse_payment(uuid,text,uuid) to authenticated;

comment on table private.payroll_sensitive_versions is 'Append-only references to Vault encrypted employee JSON. Audit logs contain reference metadata only, never bank or identity plaintext.';
comment on table public.payroll_rule_versions is 'Versioned administrator-reviewed payroll assumptions. OT remains disabled until explicitly enabled; monthly hourly basis is never guessed as 208 hours.';
commit;
