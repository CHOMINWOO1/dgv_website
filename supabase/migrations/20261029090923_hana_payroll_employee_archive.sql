-- Remove an employee from the working list without deleting wage, payment,
-- signature, attendance, encrypted identity or kiosk-enrollment history.
begin;
lock table public.payroll_revision,public.payroll_employees in access exclusive mode nowait;

alter table public.payroll_employees
  add column archived_at timestamptz,
  add column archived_by uuid,
  add column archived_reason text,
  add column archived_previous_active boolean,
  add column archived_previous_employment_status text,
  add constraint payroll_employee_archive_reason_check check(archived_reason is null or
    (length(btrim(archived_reason)) between 1 and 500 and archived_reason!~'[[:cntrl:]]')),
  add constraint payroll_employee_archive_state_check check(
    (archived_at is null and archived_by is null and archived_previous_active is null and archived_previous_employment_status is null)
    or (archived_at is not null and isfinite(archived_at) and archived_by is not null and archived_reason is not null
      and archived_previous_active is not null and archived_previous_employment_status is not null
      and archived_previous_employment_status in ('active','leave','terminated')
      and archived_previous_active=(archived_previous_employment_status='active')
      and active=false and employment_status='terminated'));

create function private.payroll_set_employee_archived(p_employee_id uuid,p_archived boolean,p_reason text,p_expected_revision bigint)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_employee public.payroll_employees%rowtype;v_revision bigint;v_reason text;
begin
  perform public.payroll_assert_admin();
  if p_employee_id is null or p_archived is null or p_expected_revision is null or p_expected_revision<0 then
    raise exception 'PAYROLL_INVALID_EMPLOYEE_ARCHIVE_REQUEST';
  end if;
  v_reason:=btrim(p_reason);
  if v_reason is null or length(v_reason) not between 1 and 500 or v_reason~'[[:cntrl:]]' then
    raise exception 'PAYROLL_ARCHIVE_REASON_REQUIRED';
  end if;
  -- Match every other payroll mutation's revision-first lock order.
  select version into v_revision from public.payroll_revision where id=1 for update;
  if v_revision is null then raise exception 'PAYROLL_REVISION_MISSING';end if;
  select * into v_employee from public.payroll_employees where id=p_employee_id for update;
  if not found then raise exception 'PAYROLL_EMPLOYEE_NOT_FOUND';end if;
  if (v_employee.archived_at is not null)=p_archived then
    -- An exact lost-response retry performs no update, even with its old revision.
    if v_employee.archived_reason=v_reason then return p_employee_id;end if;
    raise exception 'PAYROLL_EMPLOYEE_ARCHIVE_STATE_CONFLICT';
  end if;
  if p_expected_revision is distinct from v_revision then raise exception 'PAYROLL_STALE_RELOAD_REQUIRED';end if;
  if p_archived then
    update public.payroll_employees set archived_at=clock_timestamp(),archived_by=auth.uid(),archived_reason=v_reason,
      archived_previous_active=v_employee.active,archived_previous_employment_status=v_employee.employment_status,
      active=false,employment_status='terminated'
      where id=p_employee_id;
  else
    update public.payroll_employees set active=v_employee.archived_previous_active,
      employment_status=v_employee.archived_previous_employment_status,
      archived_at=null,archived_by=null,archived_previous_active=null,archived_previous_employment_status=null,
      archived_reason=v_reason where id=p_employee_id;
  end if;
  -- Existing UPDATE triggers preserve the original owner/time, append the public
  -- before/after audit (including the reason), and increment revision exactly once.
  return p_employee_id;
end;$$;
revoke all on function private.payroll_set_employee_archived(uuid,boolean,text,bigint) from public,anon,authenticated,service_role;
grant execute on function private.payroll_set_employee_archived(uuid,boolean,text,bigint) to authenticated;

create function public.payroll_set_employee_archived(p_employee_id uuid,p_archived boolean,p_reason text,p_expected_revision bigint)
returns uuid language plpgsql security invoker set search_path='' as $$
begin
  perform public.payroll_assert_admin();
  return private.payroll_set_employee_archived(p_employee_id,p_archived,p_reason,p_expected_revision);
end;$$;
revoke all on function public.payroll_set_employee_archived(uuid,boolean,text,bigint) from public,anon,authenticated,service_role;
grant execute on function public.payroll_set_employee_archived(uuid,boolean,text,bigint) to authenticated;

create function public.payroll_guard_employee_archive() returns trigger
language plpgsql security invoker set search_path='' as $$
declare v_changed boolean;v_owner oid;
begin
  if tg_op='INSERT' then
    v_changed:=new.archived_at is not null or new.archived_by is not null or new.archived_reason is not null
      or new.archived_previous_active is not null or new.archived_previous_employment_status is not null;
  else
    v_changed:=row(new.archived_at,new.archived_by,new.archived_reason,new.archived_previous_active,new.archived_previous_employment_status)
      is distinct from row(old.archived_at,old.archived_by,old.archived_reason,old.archived_previous_active,old.archived_previous_employment_status);
  end if;
  if v_changed then
    -- A client-controlled setting cannot authorize lifecycle changes. Only the
    -- tightly scoped private helper (or the database owner doing maintenance)
    -- runs as this owner. Normal employee_save and direct API UPDATE run as the
    -- authenticated role and cannot alter archive markers or bypass restoration.
    select proowner into v_owner from pg_proc
      where oid='private.payroll_set_employee_archived(uuid,boolean,text,bigint)'::regprocedure;
    if current_user::regrole::oid is distinct from v_owner then raise exception 'PAYROLL_EMPLOYEE_ARCHIVE_RPC_REQUIRED';end if;
  end if;
  if new.archived_at is not null and (new.active or new.employment_status<>'terminated') then
    raise exception 'PAYROLL_ARCHIVED_EMPLOYEE_INACTIVE';
  end if;
  return new;
end;$$;
-- Alphabetically after payroll_guard, so the established employment-status
-- normalization runs first. The original immutable DELETE guard is unchanged.
create trigger payroll_z_archive_guard before insert or update on public.payroll_employees
  for each row execute function public.payroll_guard_employee_archive();
revoke all on function public.payroll_guard_employee_archive() from public,anon,authenticated,service_role;
grant execute on function public.payroll_guard_employee_archive() to authenticated;

comment on function public.payroll_set_employee_archived(uuid,boolean,text,bigint) is
  'Admin-only revision-checked employee list removal/restoration. Returns the unchanged employee UUID; no physical deletion. Historical payroll, payments, signatures, identity versions and kiosk grants remain unchanged.';
comment on column public.payroll_employees.archived_at is 'Non-null means hidden from the working employee list. The employee remains available in historical reports and cannot clock in while archived.';
comment on column public.payroll_employees.archived_reason is 'Most recent archive or restore reason. Retained after restore so the existing UPDATE audit records the restoration reason without new plaintext identity data.';
comment on column public.payroll_employees.archived_previous_employment_status is 'Exact pre-archive status, restored with archived_previous_active; termination_date is never fabricated or changed by archive.';
commit;
