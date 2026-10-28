-- HANA payroll: additive, admin-only, independent of public expense ledgers.
-- Device times are Vietnamese local wall-clock timestamps, never browser-zone dates.
begin;

create table public.payroll_revision (
  id integer primary key check (id = 1),
  version bigint not null default 0 check (version >= 0)
);
insert into public.payroll_revision(id,version) values (1,0);

create table public.payroll_employees (
  id uuid primary key default gen_random_uuid(),
  device_user_id text not null unique check (length(btrim(device_user_id)) between 1 and 120 and device_user_id=btrim(device_user_id)),
  name text not null check (length(btrim(name)) between 1 and 200),
  active boolean not null default true,
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now()
);

create table public.payroll_terms (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.payroll_employees(id),
  effective_from date not null check (isfinite(effective_from)),
  pay_type text not null check (pay_type in ('monthly','hourly','daily')),
  rate numeric(14,2) not null check (rate between 0 and 999999999999),
  shift_start time not null default '10:00',
  shift_end time not null default '20:00',
  break_start time not null default '13:00',
  break_end time not null default '15:00',
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  unique(employee_id,effective_from),
  check (shift_start <> shift_end),
  check (shift_start < '24:00'::time and shift_end < '24:00'::time and break_start < '24:00'::time and break_end < '24:00'::time)
);

create table public.payroll_imports (
  id uuid primary key default gen_random_uuid(),
  filename text not null check (length(btrim(filename)) between 1 and 255),
  inserted_count integer not null check (inserted_count between 0 and 20000),
  duplicate_count integer not null check (duplicate_count between 0 and 20000),
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now()
);

create table public.payroll_attendance_raw (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.payroll_employees(id),
  occurred_at timestamp without time zone not null check (isfinite(occurred_at)),
  device_id text not null check (length(btrim(device_id)) between 1 and 120 and device_id=btrim(device_id)),
  import_id uuid not null references public.payroll_imports(id) deferrable initially deferred,
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  unique(employee_id,occurred_at,device_id)
);
create index payroll_attendance_month_idx on public.payroll_attendance_raw(occurred_at,employee_id);
create index payroll_attendance_import_idx on public.payroll_attendance_raw(import_id);

create table public.payroll_days (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.payroll_employees(id),
  work_date date not null check (isfinite(work_date)),
  day_type text not null default 'work' check (day_type in ('work','rest','paid_leave','unpaid_leave','holiday')),
  check_in timestamp without time zone,
  check_out timestamp without time zone,
  reason text not null check (length(btrim(reason)) between 1 and 1000),
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_by uuid not null default auth.uid(),
  updated_at timestamptz not null default now(),
  unique(employee_id,work_date),
  check ((check_in is null and check_out is null) or
    (check_in is not null and check_out is not null and isfinite(check_in) and isfinite(check_out)
      and check_in::date=work_date and check_out>check_in and check_out<=check_in+interval '24 hours'))
);
create index payroll_days_month_idx on public.payroll_days(work_date,employee_id);

create table public.payroll_runs (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.payroll_employees(id),
  month date not null check (isfinite(month) and extract(day from month)=1),
  base_amount numeric(14,2) not null check (base_amount between 0 and 999999999999),
  allowances numeric(14,2) not null default 0 check (allowances between 0 and 999999999999),
  deductions numeric(14,2) not null default 0 check (deductions between 0 and 999999999999),
  total numeric(14,2) not null check (total between 0 and 999999999999 and total=base_amount+allowances-deductions),
  snapshot jsonb not null check (jsonb_typeof(snapshot)='object' and octet_length(snapshot::text)<=2097152),
  expected_revision bigint not null check (expected_revision>=0),
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  unique(employee_id,month)
);
create index payroll_runs_month_idx on public.payroll_runs(month,employee_id);

create table public.payroll_payments (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.payroll_runs(id),
  amount numeric(14,2) not null check (amount>0 and amount<=999999999999),
  paid_on date not null check (isfinite(paid_on)),
  method text not null check (method in ('cash','bank')),
  reference text not null default '' check (length(reference)<=300),
  note text not null default '' check (length(note)<=1000),
  request_id uuid not null unique,
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now()
);
create index payroll_payments_run_idx on public.payroll_payments(run_id,paid_on);

create table public.payroll_audit (
  id uuid primary key default gen_random_uuid(),
  table_name text not null,
  record_id uuid not null,
  action text not null check (action in ('INSERT','UPDATE')),
  before_data jsonb,
  after_data jsonb not null,
  created_by uuid not null,
  created_at timestamptz not null default now()
);
create index payroll_audit_record_idx on public.payroll_audit(table_name,record_id,created_at);

-- Remove Supabase's default grants before explicitly granting the least required operations.
do $$
declare t text;
begin
  foreach t in array array['payroll_revision','payroll_employees','payroll_terms','payroll_imports',
    'payroll_attendance_raw','payroll_days','payroll_runs','payroll_payments','payroll_audit'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public,anon,authenticated',t);
    execute format('grant select on public.%I to authenticated',t);
    execute format('create policy %I on public.%I for select to authenticated using ((select auth.uid()) is not null and (select public.has_app_role(array[''admin''])))',t||'_admin_read',t);
  end loop;
  foreach t in array array['payroll_employees','payroll_terms','payroll_imports','payroll_attendance_raw','payroll_days','payroll_runs','payroll_payments','payroll_audit'] loop
    execute format('grant insert on public.%I to authenticated',t);
    execute format('create policy %I on public.%I for insert to authenticated with check ((select auth.uid()) is not null and (select public.has_app_role(array[''admin''])))',t||'_admin_insert',t);
  end loop;
  -- UPDATE on runs is required by SELECT FOR UPDATE. The immutable-row trigger
  -- rejects every actual update; these grants do not make finalized rows editable.
  foreach t in array array['payroll_revision','payroll_employees','payroll_days','payroll_runs'] loop
    execute format('grant update on public.%I to authenticated',t);
    execute format('create policy %I on public.%I for update to authenticated using ((select auth.uid()) is not null and (select public.has_app_role(array[''admin'']))) with check ((select auth.uid()) is not null and (select public.has_app_role(array[''admin''])))',t||'_admin_update',t);
  end loop;
end;
$$;

create function public.payroll_assert_admin() returns void
language plpgsql security invoker set search_path='' as $$
begin
  if auth.uid() is null or not public.has_app_role(array['admin']) then
    raise exception 'PAYROLL_ADMIN_REQUIRED' using errcode='42501';
  end if;
end;
$$;

create function public.payroll_guard_row() returns trigger
language plpgsql security invoker set search_path='' as $$
declare current_revision bigint; approved_total numeric; already_paid numeric;
begin
  perform public.payroll_assert_admin();
  if tg_op='DELETE' or (tg_op='UPDATE' and tg_table_name not in ('payroll_employees','payroll_days')) then
    raise exception 'PAYROLL_IMMUTABLE_RECORD';
  end if;
  if tg_op='INSERT' then
    new.created_by:=auth.uid(); new.created_at:=now();
  else
    new.created_by:=old.created_by; new.created_at:=old.created_at;
    if new.id<>old.id then raise exception 'PAYROLL_ID_IMMUTABLE'; end if;
  end if;
  if tg_table_name in ('payroll_employees','payroll_terms','payroll_attendance_raw','payroll_days','payroll_runs') then
    -- Acquire the same lock before source changes and before finalization.
    -- A reviewed client snapshot becomes invalid as soon as any source row changes.
    select version into current_revision from public.payroll_revision where id=1 for update;
    if current_revision is null then raise exception 'PAYROLL_REVISION_MISSING'; end if;
  end if;
  if tg_table_name='payroll_employees' and tg_op='UPDATE' then
    if new.device_user_id<>old.device_user_id then raise exception 'PAYROLL_DEVICE_ID_IMMUTABLE'; end if;
  elsif tg_table_name='payroll_days' then
    new.updated_by:=auth.uid(); new.updated_at:=now();
    if tg_op='UPDATE' and (new.employee_id<>old.employee_id or new.work_date<>old.work_date) then
      raise exception 'PAYROLL_DAY_KEY_IMMUTABLE';
    end if;
  elsif tg_table_name='payroll_runs' then
    if new.expected_revision is distinct from current_revision then raise exception 'PAYROLL_STALE_RELOAD_REQUIRED'; end if;
    if jsonb_typeof(new.snapshot->'unresolved') is distinct from 'number' or
      (new.snapshot->>'unresolved')::numeric<>0 then
      raise exception 'PAYROLL_UNRESOLVED_ATTENDANCE';
    end if;
    if not exists(select 1 from public.payroll_terms where employee_id=new.employee_id and effective_from<new.month+interval '1 month') then
      raise exception 'PAYROLL_TERMS_REQUIRED';
    end if;
  elsif tg_table_name='payroll_payments' then
    select total into approved_total from public.payroll_runs where id=new.run_id for update;
    if approved_total is null then raise exception 'PAYROLL_RUN_NOT_FOUND'; end if;
    select coalesce(sum(amount),0) into already_paid from public.payroll_payments where run_id=new.run_id;
    if not (new.amount>0 and new.amount<=999999999999) or already_paid+new.amount>approved_total then
      raise exception 'PAYROLL_OVERPAYMENT_OR_INVALID_AMOUNT';
    end if;
  end if;
  return new;
end;
$$;

create function public.payroll_guard_internal() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  perform public.payroll_assert_admin();
  if pg_trigger_depth()<2 then raise exception 'PAYROLL_INTERNAL_RECORD'; end if;
  if tg_table_name='payroll_revision' then
    if tg_op<>'UPDATE' or new.id<>old.id or new.version<>old.version+1 then raise exception 'PAYROLL_INVALID_REVISION'; end if;
  elsif tg_op<>'INSERT' then
    raise exception 'PAYROLL_IMMUTABLE_AUDIT';
  end if;
  return new;
end;
$$;
create trigger payroll_revision_guard before insert or update or delete on public.payroll_revision
  for each row execute function public.payroll_guard_internal();
create trigger payroll_audit_guard before insert or update or delete on public.payroll_audit
  for each row execute function public.payroll_guard_internal();

create function public.payroll_record_change() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  insert into public.payroll_audit(table_name,record_id,action,before_data,after_data,created_by)
  values(tg_table_name,new.id,tg_op,case when tg_op='UPDATE' then to_jsonb(old) else null end,to_jsonb(new),auth.uid());
  if tg_table_name in ('payroll_employees','payroll_terms','payroll_attendance_raw','payroll_days') then
    update public.payroll_revision set version=version+1 where id=1;
  end if;
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['payroll_employees','payroll_terms','payroll_imports','payroll_attendance_raw','payroll_days','payroll_runs','payroll_payments'] loop
    execute format('create trigger payroll_guard before insert or update or delete on public.%I for each row execute function public.payroll_guard_row()',t);
    execute format('create trigger payroll_audit after insert or update on public.%I for each row execute function public.payroll_record_change()',t);
  end loop;
end;
$$;

create function public.payroll_import(p_filename text,p_records jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare rec jsonb; v_employee uuid; v_import uuid:=gen_random_uuid(); v_time timestamp;
  v_inserted integer:=0; v_employees integer:=0; v_affected integer; v_count integer;
begin
  perform public.payroll_assert_admin();
  if p_filename is null or length(btrim(p_filename)) not between 1 and 255 then raise exception 'PAYROLL_INVALID_FILENAME'; end if;
  if jsonb_typeof(p_records) is distinct from 'array' then raise exception 'PAYROLL_INVALID_RECORDS'; end if;
  v_count:=jsonb_array_length(p_records);
  if v_count not between 1 and 20000 then raise exception 'PAYROLL_IMPORT_SIZE_LIMIT'; end if;
  -- Validate every row before writing. The transaction rolls back even a late invalid date.
  for rec in select value from jsonb_array_elements(p_records) loop
    if jsonb_typeof(rec) is distinct from 'object'
      or jsonb_typeof(rec->'device_user_id') is distinct from 'string'
      or jsonb_typeof(rec->'name') is distinct from 'string'
      or jsonb_typeof(rec->'device_id') is distinct from 'string'
      or jsonb_typeof(rec->'occurred_at') is distinct from 'string'
      or length(btrim(rec->>'device_user_id')) not between 1 and 120
      or length(btrim(rec->>'name')) not between 1 and 200
      or length(btrim(rec->>'device_id')) not between 1 and 120
      or (rec->>'occurred_at') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}(:[0-9]{2})?$' then
      raise exception 'PAYROLL_INVALID_IMPORT_ROW';
    end if;
    v_time:=(rec->>'occurred_at')::timestamp;
    if not isfinite(v_time) then raise exception 'PAYROLL_INVALID_TIMESTAMP'; end if;
  end loop;
  perform version from public.payroll_revision where id=1 for update;
  for rec in select value from jsonb_array_elements(p_records) loop
    insert into public.payroll_employees(device_user_id,name)
      values(btrim(rec->>'device_user_id'),btrim(rec->>'name')) on conflict(device_user_id) do nothing;
    get diagnostics v_affected=row_count; v_employees:=v_employees+v_affected;
    select id into v_employee from public.payroll_employees where device_user_id=btrim(rec->>'device_user_id');
    insert into public.payroll_attendance_raw(employee_id,occurred_at,device_id,import_id)
      values(v_employee,(rec->>'occurred_at')::timestamp,btrim(rec->>'device_id'),v_import)
      on conflict(employee_id,occurred_at,device_id) do nothing;
    get diagnostics v_affected=row_count; v_inserted:=v_inserted+v_affected;
  end loop;
  insert into public.payroll_imports(id,filename,inserted_count,duplicate_count)
    values(v_import,btrim(p_filename),v_inserted,v_count-v_inserted);
  return jsonb_build_object('import_id',v_import,'inserted_count',v_inserted,
    'duplicate_count',v_count-v_inserted,'employee_count',v_employees);
end;
$$;

create function public.payroll_finalize(p_employee_id uuid,p_month date,p_base_amount numeric,
  p_allowances numeric,p_deductions numeric,p_snapshot jsonb,p_expected_revision bigint) returns uuid
language plpgsql security invoker set search_path='' as $$
declare v_id uuid;
begin
  perform public.payroll_assert_admin();
  insert into public.payroll_runs(employee_id,month,base_amount,allowances,deductions,total,snapshot,expected_revision)
    values(p_employee_id,p_month,p_base_amount,p_allowances,p_deductions,
      p_base_amount+p_allowances-p_deductions,p_snapshot,p_expected_revision) returning id into v_id;
  return v_id;
end;
$$;

create function public.payroll_pay(p_run_id uuid,p_amount numeric,p_paid_on date,p_method text,
  p_reference text,p_note text,p_request_id uuid) returns uuid
language plpgsql security invoker set search_path='' as $$
declare existing public.payroll_payments%rowtype; v_id uuid;
begin
  perform public.payroll_assert_admin();
  if p_request_id is null then raise exception 'PAYROLL_PAYMENT_REQUEST_REQUIRED'; end if;
  -- One run lock serializes payment sums and identical retries.
  perform id from public.payroll_runs where id=p_run_id for update;
  if not found then raise exception 'PAYROLL_RUN_NOT_FOUND'; end if;
  select * into existing from public.payroll_payments where request_id=p_request_id;
  if found then
    if existing.run_id is distinct from p_run_id or existing.amount is distinct from p_amount
      or existing.paid_on is distinct from p_paid_on or existing.method is distinct from p_method
      or existing.reference is distinct from coalesce(p_reference,'') or existing.note is distinct from coalesce(p_note,'') then
      raise exception 'PAYROLL_PAYMENT_REQUEST_CONFLICT';
    end if;
    return existing.id;
  end if;
  insert into public.payroll_payments(run_id,amount,paid_on,method,reference,note,request_id)
    values(p_run_id,p_amount,p_paid_on,p_method,coalesce(p_reference,''),coalesce(p_note,''),p_request_id)
    returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.payroll_assert_admin(),public.payroll_guard_row(),public.payroll_guard_internal(),
  public.payroll_record_change(),public.payroll_import(text,jsonb),
  public.payroll_finalize(uuid,date,numeric,numeric,numeric,jsonb,bigint),
  public.payroll_pay(uuid,numeric,date,text,text,text,uuid) from public,anon,authenticated;
grant execute on function public.payroll_assert_admin(),public.payroll_guard_row(),public.payroll_guard_internal(),
  public.payroll_record_change(),public.payroll_import(text,jsonb),
  public.payroll_finalize(uuid,date,numeric,numeric,numeric,jsonb,bigint),
  public.payroll_pay(uuid,numeric,date,text,text,text,uuid) to authenticated;

comment on table public.payroll_attendance_raw is 'Immutable N308 punch events in Asia/Ho_Chi_Minh wall-clock time; duplicate employee/time/device events are ignored. No workbook or biometric data is stored.';
comment on table public.payroll_runs is 'Administrator-confirmed immutable payroll snapshots; estimates and internal time offsets do not authorize legal deductions or cash movements.';
comment on table public.payroll_payments is 'Actual payroll payments only. Independent of the public restaurant expense ledger; no automatic double posting.';
comment on table public.payroll_revision is 'Global source revision serializes payroll source changes with finalization; only payroll row triggers may increment it.';

commit;
