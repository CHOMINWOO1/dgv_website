-- Fixed, actually paid outside repair/service work. Existing payment IDs and
-- private signatures remain the source of truth; no receivable is created.
begin;
alter table public.payroll_employees add column payee_type text not null default 'employee'
  check(payee_type in ('employee','service'));
create table public.payroll_service_payment_details(
  id uuid primary key references public.payroll_payments(id),
  payment_id uuid not null unique references public.payroll_payments(id),
  work_from date not null check(isfinite(work_from)),
  work_to date not null check(isfinite(work_to) and work_to>=work_from),
  description text not null check(length(btrim(description)) between 1 and 1000),
  created_by uuid not null default auth.uid(),created_at timestamptz not null default now(),
  check(id=payment_id)
);
alter table public.payroll_service_payment_details enable row level security;
revoke all on public.payroll_service_payment_details from public,anon,authenticated;
grant select,insert on public.payroll_service_payment_details to authenticated;
create policy payroll_service_details_read on public.payroll_service_payment_details for select to authenticated
  using(public.has_app_role(array['admin']));
create policy payroll_service_details_insert on public.payroll_service_payment_details for insert to authenticated
  with check(public.has_app_role(array['admin']));

create function private.payroll_save_service_provider(p_employee_id uuid,p_name text,p_phone text,p_national_id text,p_expected_revision bigint,p_create boolean) returns uuid
language plpgsql security definer set search_path='' as $$
declare e public.payroll_employees%rowtype; payload jsonb;v_id uuid;
begin
  perform public.payroll_assert_admin();
  perform version from public.payroll_revision where id=1 for update;
  select * into e from public.payroll_employees where id=p_employee_id;
  if found and (e.payee_type<>'service' or e.archived_at is not null) then raise exception 'PAYROLL_SERVICE_PROVIDER_REQUIRED';end if;
  payload:=jsonb_build_object('name',btrim(p_name),'phone',btrim(coalesce(p_phone,'')));
  if p_create then payload:=payload||jsonb_build_object('device_user_id','S-'||p_employee_id::text,
    'active',true,'employment_status','active','employment_type','part_time','payment_method','cash');end if;
  v_id:=public.payroll_save_employee(p_employee_id,payload,p_national_id,p_expected_revision,p_create);
  update public.payroll_employees set payee_type='service' where id=v_id and payee_type<>'service';
  return v_id;
end;$$;
create function public.payroll_save_service_provider(p_employee_id uuid,p_name text,p_phone text,p_national_id text,p_expected_revision bigint,p_create boolean) returns uuid
language plpgsql security invoker set search_path='' as $$begin
  perform public.payroll_assert_admin();return private.payroll_save_service_provider(p_employee_id,p_name,p_phone,p_national_id,p_expected_revision,p_create);
end;$$;

create function private.payroll_reclassify_service_payment(p_payment_id uuid,p_description text,p_work_from date,p_work_to date,p_expected_revision bigint) returns uuid
language plpgsql security definer set search_path='' as $$
declare p public.payroll_payments%rowtype;e public.payroll_employees%rowtype;d public.payroll_service_payment_details%rowtype;v_revision bigint;
begin
  perform public.payroll_assert_admin();
  select version into v_revision from public.payroll_revision where id=1 for update;
  select * into p from public.payroll_payments where id=p_payment_id;
  if not found or p.run_id is not null then raise exception 'PAYROLL_SERVICE_RUNLESS_PAYMENT_REQUIRED';end if;
  select * into e from public.payroll_employees where id=p.employee_id;
  if e.archived_at is not null then raise exception 'PAYROLL_EMPLOYEE_ARCHIVED';end if;
  select * into d from public.payroll_service_payment_details where payment_id=p.id;
  if found then
    if e.payee_type='service' and d.description=btrim(p_description) and d.work_from=p_work_from and d.work_to=p_work_to then return p.id;end if;
    raise exception 'PAYROLL_SERVICE_DETAILS_CONFLICT';
  end if;
  if p_expected_revision is distinct from v_revision then raise exception 'PAYROLL_STALE_RELOAD_REQUIRED';end if;
  if e.payee_type='employee' and exists(select 1 from public.payroll_payments where employee_id=e.id and id<>p.id) then
    raise exception 'PAYROLL_SERVICE_OTHER_PAYMENTS_REQUIRE_REVIEW';end if;
  if exists(select 1 from public.payroll_runs where employee_id=e.id)
    or exists(select 1 from public.payroll_attendance_raw where employee_id=e.id)
    or exists(select 1 from public.payroll_days where employee_id=e.id)
    or exists(select 1 from public.payroll_reviews where employee_id=e.id)
    or exists(select 1 from payroll_kiosk.payroll_kiosk_enrollments where employee_id=e.id)
    or exists(select 1 from public.payroll_payments where employee_id=e.id and run_id is not null) then
    raise exception 'PAYROLL_SERVICE_HAS_EMPLOYMENT_HISTORY';
  end if;
  -- Changing the payee classification is audited. The original amount,
  -- payment date, reference, note, request ID and attachments are untouched.
  update public.payroll_employees set payee_type='service' where id=e.id and payee_type<>'service';
  insert into public.payroll_service_payment_details(id,payment_id,description,work_from,work_to)
    values(p.id,p.id,btrim(p_description),p_work_from,p_work_to);
  return p.id;
end;$$;
create function public.payroll_reclassify_service_payment(p_payment_id uuid,p_description text,p_work_from date,p_work_to date,p_expected_revision bigint) returns uuid
language plpgsql security invoker set search_path='' as $$begin
  perform public.payroll_assert_admin();return private.payroll_reclassify_service_payment(p_payment_id,p_description,p_work_from,p_work_to,p_expected_revision);
end;$$;

create function public.payroll_pay_service(p_employee_id uuid,p_amount numeric,p_paid_on date,p_method text,p_reference text,
  p_description text,p_work_from date,p_work_to date,p_request_id uuid) returns uuid
language plpgsql security invoker set search_path='' as $$
declare v_id uuid;d public.payroll_service_payment_details%rowtype;
begin
  perform public.payroll_assert_admin();
  perform version from public.payroll_revision where id=1 for update;
  if not exists(select 1 from public.payroll_employees where id=p_employee_id and payee_type='service' and archived_at is null) then
    raise exception 'PAYROLL_SERVICE_PROVIDER_REQUIRED';end if;
  if p_description is null or length(btrim(p_description)) not between 1 and 1000 or p_work_from is null or p_work_to is null
    or not isfinite(p_work_from) or not isfinite(p_work_to) or p_work_to<p_work_from then raise exception 'PAYROLL_SERVICE_DETAILS_INVALID';end if;
  v_id:=public.payroll_pay_advance(p_employee_id,date_trunc('month',p_paid_on)::date,p_amount,p_paid_on,p_method,p_reference,'',p_request_id);
  select * into d from public.payroll_service_payment_details where payment_id=v_id;
  if found then
    if d.description is distinct from btrim(p_description) or d.work_from is distinct from p_work_from or d.work_to is distinct from p_work_to then
      raise exception 'PAYROLL_SERVICE_DETAILS_CONFLICT';end if;
  else insert into public.payroll_service_payment_details(id,payment_id,description,work_from,work_to)
    values(v_id,v_id,btrim(p_description),p_work_from,p_work_to);end if;
  return v_id;
end;$$;

create function public.payroll_guard_service_payee() returns trigger
language plpgsql security invoker set search_path='' as $$
declare helper_owner oid;
begin
  if tg_table_name='payroll_employees' then
    if (tg_op='INSERT' and new.payee_type<>'employee') or (tg_op='UPDATE' and new.payee_type is distinct from old.payee_type) then
      select proowner into helper_owner from pg_catalog.pg_proc where oid='private.payroll_save_service_provider(uuid,text,text,text,bigint,boolean)'::regprocedure;
      if current_user::regrole::oid is distinct from helper_owner then raise exception 'PAYROLL_SERVICE_CLASSIFICATION_RPC_REQUIRED';end if;
    end if;
  end if;
  return new;
end;$$;
create trigger payroll_z_service_guard before insert or update on public.payroll_employees for each row execute function public.payroll_guard_service_payee();
create function private.payroll_guard_service_work() returns trigger
language plpgsql security definer set search_path='' as $$begin
  -- The kiosk writer deliberately cannot SELECT the employee directory.
  -- A trigger-only definer may read this one classification, never return it.
  if exists(select 1 from public.payroll_employees where id=new.employee_id and payee_type='service') then
    raise exception 'PAYROLL_SERVICE_NOT_EMPLOYEE';end if;
  return new;
end;$$;
revoke all on function private.payroll_guard_service_work() from public,anon,authenticated,service_role;
create trigger payroll_z_service_guard before insert or update on payroll_kiosk.payroll_kiosk_enrollments for each row execute function private.payroll_guard_service_work();
do $$declare t text;begin
  foreach t in array array['payroll_terms','payroll_attendance_raw','payroll_days','payroll_reviews','payroll_runs'] loop
    execute format('create trigger payroll_z_service_guard before insert or update on public.%I for each row execute function private.payroll_guard_service_work()',t);
  end loop;
end;$$;
create function public.payroll_guard_service_details() returns trigger
language plpgsql security invoker set search_path='' as $$begin
  perform public.payroll_assert_admin();
  if tg_op<>'INSERT' then raise exception 'PAYROLL_IMMUTABLE_RECORD';end if;
  if not exists(select 1 from public.payroll_payments p join public.payroll_employees e on e.id=p.employee_id where p.id=new.payment_id and p.run_id is null and e.payee_type='service') then
    raise exception 'PAYROLL_SERVICE_PAYMENT_REQUIRED';end if;
  new.created_by:=auth.uid();new.created_at:=now();return new;
end;$$;
create function public.payroll_record_service_details() returns trigger
language plpgsql security invoker set search_path='' as $$begin
  insert into public.payroll_audit(table_name,record_id,action,after_data,created_by)
    values(tg_table_name,new.id,tg_op,to_jsonb(new),auth.uid());
  update public.payroll_revision set version=version+1 where id=1;return new;
end;$$;
create trigger payroll_serialize before insert or update or delete on public.payroll_service_payment_details for each statement execute function public.payroll_serialize_statement();
create trigger payroll_guard before insert or update or delete on public.payroll_service_payment_details for each row execute function public.payroll_guard_service_details();
create trigger payroll_audit after insert on public.payroll_service_payment_details for each row execute function public.payroll_record_service_details();
revoke all on function private.payroll_save_service_provider(uuid,text,text,text,bigint,boolean),private.payroll_reclassify_service_payment(uuid,text,date,date,bigint),
  public.payroll_save_service_provider(uuid,text,text,text,bigint,boolean),public.payroll_reclassify_service_payment(uuid,text,date,date,bigint),
  public.payroll_pay_service(uuid,numeric,date,text,text,text,date,date,uuid) from public,anon,authenticated;
grant execute on function private.payroll_save_service_provider(uuid,text,text,text,bigint,boolean),private.payroll_reclassify_service_payment(uuid,text,date,date,bigint),
  public.payroll_save_service_provider(uuid,text,text,text,bigint,boolean),public.payroll_reclassify_service_payment(uuid,text,date,date,bigint),
  public.payroll_pay_service(uuid,numeric,date,text,text,text,date,date,uuid) to authenticated;

-- Extend the existing encrypted archive with the payment-linked service rows.
-- Old backup formats receive an empty sidecar array and employee payee defaults.
do $$declare source text;begin
  source:=pg_get_functiondef('private.payroll_backup()'::regprocedure);
  source:=replace(source,'''payroll_attachments'',(select',
    '''payroll_service_payment_details'',(select coalesce(jsonb_agg(to_jsonb(t) order by id),''[]'') from public.payroll_service_payment_details t),''payroll_attachments'',(select');
  execute source;
  source:=pg_get_functiondef('private.payroll_restore(jsonb)'::regprocedure);
  source:=replace(source,'''payroll_attendance_raw'',''payroll_attachments'',''payroll_audit'']',
    '''payroll_attendance_raw'',''payroll_attachments'',''payroll_service_payment_details'',''payroll_audit'']');
  source:=replace(source,'public.payroll_attendance_raw,public.payroll_attachments,public.payroll_audit,',
    'public.payroll_attendance_raw,public.payroll_attachments,public.payroll_service_payment_details,public.payroll_audit,');
  source:=replace(source,'  foreach t in array allowed_tables loop',
    '  if not (p_payload->''tables'' ? ''payroll_service_payment_details'') then p_payload:=jsonb_set(p_payload,''{tables,payroll_service_payment_details}'',''[]''::jsonb);end if;'||chr(10)||'  foreach t in array allowed_tables loop');
  source:=replace(source,'    if t=''payroll_terms'' then',
    '    if t=''payroll_employees'' then select coalesce(jsonb_agg(jsonb_build_object(''payee_type'',''employee'')||value),''[]''::jsonb) into v_rows from jsonb_array_elements(v_rows);'||chr(10)||'    elsif t=''payroll_terms'' then');
  execute source;
end;$$;
comment on column public.payroll_employees.payee_type is 'Service payees are outside-work recipients, excluded from employee payroll calculation and wage reports.';
comment on table public.payroll_service_payment_details is 'One fixed actual service payment with job description/dates. No expected wage, contract receivable or outstanding balance.';
commit;
