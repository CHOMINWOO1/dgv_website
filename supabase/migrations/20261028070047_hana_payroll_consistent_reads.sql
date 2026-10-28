-- A load brackets its separate REST queries with payroll_revision. Include
-- monetary/evidence rows so reports cannot combine different committed states.
-- A consistent revision -> run lock order also covers direct REST writes.
begin;

create function public.payroll_serialize_statement() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  perform public.payroll_assert_admin();
  perform version from public.payroll_revision where id=1 for update;
  if not found then raise exception 'PAYROLL_REVISION_MISSING'; end if;
  return null;
end; $$;

revoke all on function public.payroll_serialize_statement() from public,anon,authenticated;
grant execute on function public.payroll_serialize_statement() to authenticated;
do $$ declare t text;begin
  foreach t in array array['payroll_employees','payroll_terms','payroll_attendance_raw','payroll_days',
    'payroll_rule_versions','payroll_reviews','payroll_runs','payroll_payments',
    'payroll_run_adjustments','payroll_payment_reversals','payroll_attachments'] loop
    execute format('create trigger payroll_serialize before insert or update or delete on public.%I for each statement execute function public.payroll_serialize_statement()',t);
  end loop;
end; $$;

create or replace function public.payroll_record_change() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  insert into public.payroll_audit(table_name,record_id,action,before_data,after_data,created_by)
    values(tg_table_name,new.id,tg_op,case when tg_op='UPDATE' then to_jsonb(old) else null end,to_jsonb(new),auth.uid());
  if tg_table_name in ('payroll_employees','payroll_terms','payroll_attendance_raw','payroll_days',
    'payroll_rule_versions','payroll_sensitive_versions','payroll_runs','payroll_payments',
    'payroll_run_adjustments','payroll_payment_reversals','payroll_attachments') then
    update public.payroll_revision set version=version+1 where id=1;
  end if;
  -- Reviews intentionally do not advance the revision: review -> finalization
  -- must accept the same captured calculation revision.
  return new;
end; $$;

create or replace function public.payroll_pay(p_run_id uuid,p_amount numeric,p_paid_on date,p_method text,
  p_reference text,p_note text,p_request_id uuid) returns uuid
language plpgsql security invoker set search_path='' as $$
declare existing public.payroll_payments%rowtype; v_id uuid;
begin
  perform public.payroll_assert_admin();
  if p_request_id is null then raise exception 'PAYROLL_PAYMENT_REQUEST_REQUIRED'; end if;
  -- Always lock the global read revision before a run, including retry paths.
  perform version from public.payroll_revision where id=1 for update;
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

create or replace function public.payroll_adjust_run(p_run_id uuid,p_amount numeric,p_reason text,p_request_id uuid) returns uuid
language plpgsql security invoker set search_path='' as $$ declare existing public.payroll_run_adjustments%rowtype;v_id uuid;begin
  perform public.payroll_assert_admin();
  perform version from public.payroll_revision where id=1 for update;
  perform id from public.payroll_runs where id=p_run_id for update;
  if not found then raise exception 'PAYROLL_RUN_NOT_FOUND';end if;
  select * into existing from public.payroll_run_adjustments where request_id=p_request_id;
  if found then
    if existing.run_id is distinct from p_run_id or existing.amount is distinct from p_amount or existing.reason is distinct from p_reason then raise exception 'PAYROLL_ADJUSTMENT_REQUEST_CONFLICT';end if;
    return existing.id;
  end if;
  insert into public.payroll_run_adjustments(run_id,amount,reason,request_id) values(p_run_id,p_amount,p_reason,p_request_id) returning id into v_id;
  return v_id;
end; $$;

create or replace function public.payroll_reverse_payment(p_payment_id uuid,p_reason text,p_request_id uuid) returns uuid
language plpgsql security invoker set search_path='' as $$ declare v_run uuid;v_id uuid;existing public.payroll_payment_reversals%rowtype;begin
  perform public.payroll_assert_admin();
  perform version from public.payroll_revision where id=1 for update;
  select run_id into v_run from public.payroll_payments where id=p_payment_id;
  perform id from public.payroll_runs where id=v_run for update;if not found then raise exception 'PAYROLL_PAYMENT_NOT_FOUND';end if;
  select * into existing from public.payroll_payment_reversals where request_id=p_request_id;
  if found then
    if existing.payment_id is distinct from p_payment_id or existing.reason is distinct from p_reason then raise exception 'PAYROLL_REVERSAL_REQUEST_CONFLICT';end if;
    return existing.id;
  end if;
  insert into public.payroll_payment_reversals(payment_id,reason,request_id) values(p_payment_id,p_reason,p_request_id) returning id into v_id;
  return v_id;
end; $$;

-- A reviewed calculation may be revised without changing its attendance source.
-- Keep every different review immutable; exact RPC retries reuse the saved row.
alter table public.payroll_reviews drop constraint payroll_reviews_employee_id_month_source_revision_key;
create index payroll_reviews_employee_month_revision_idx on public.payroll_reviews(employee_id,month,source_revision);
create or replace function public.payroll_review(p_employee_id uuid,p_month date,p_snapshot jsonb,p_reason text,p_expected_revision bigint) returns uuid
language plpgsql security invoker set search_path='' as $$
declare v_id uuid;v_revision bigint;
begin
  perform public.payroll_assert_admin();
  select version into v_revision from public.payroll_revision where id=1 for update;
  if v_revision is null then raise exception 'PAYROLL_REVISION_MISSING'; end if;
  if p_expected_revision is distinct from v_revision then raise exception 'PAYROLL_STALE_RELOAD_REQUIRED'; end if;
  select id into v_id from public.payroll_reviews where employee_id=p_employee_id and month=p_month
    and source_revision=p_expected_revision and snapshot=p_snapshot and reason=p_reason order by created_at,id limit 1;
  if found then return v_id; end if;
  insert into public.payroll_reviews(employee_id,month,source_revision,snapshot,reason)
    values(p_employee_id,p_month,p_expected_revision,p_snapshot,p_reason) returning id into v_id;
  return v_id;
end; $$;

comment on table public.payroll_revision is 'Global payroll data revision serializes source, salary, payment, correction and evidence changes with finalization and consistent report reads. Reviews do not advance it.';

commit;
