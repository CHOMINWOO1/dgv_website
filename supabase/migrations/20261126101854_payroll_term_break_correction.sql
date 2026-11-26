-- A normal, authenticated administrator correction of two term break fields.
-- The original term is retained in audit before_data. Conversion requests,
-- money, attendance and finalized snapshots stay intact.
set local lock_timeout = '3s';

-- Do not open the narrow UPDATE grant if serialization, row validation,
-- auditing or RLS is unexpectedly missing from the deployed table.
do $check_baseline$
begin
  if not exists (
    select 1 from pg_class where oid = 'public.payroll_terms'::regclass and relrowsecurity
  ) or (
    select count(*) from pg_trigger
    where tgrelid = 'public.payroll_terms'::regclass and not tgisinternal
      and tgenabled = 'O' and (
        (tgfoid = 'public.payroll_serialize_statement()'::regprocedure and tgtype = 30)
        or (tgfoid = 'public.payroll_guard_row()'::regprocedure and tgtype = 31)
        or (tgfoid = 'public.payroll_record_change()'::regprocedure and tgtype = 21)
      )
  ) <> 3 then
    raise exception 'PAYROLL_TERM_BREAK_BASELINE_UNRECOGNIZED';
  end if;
end;
$check_baseline$;

-- These settings carry workflow context, not authentication or a secret
-- capability. The validator independently enforces every permitted invariant.
create function public.payroll_check_term_break_correction(
  p_before public.payroll_terms,
  p_after public.payroll_terms
) returns void
language plpgsql security invoker set search_path = '' as $$
declare
  v_reason text := btrim(coalesce(current_setting('app.payroll_term_break_reason', true), ''));
  v_next_effective date;
begin
  perform public.payroll_assert_admin();
  if auth.uid() is null or public.has_app_role(array['admin']) is distinct from true then
    raise exception 'PAYROLL_ADMIN_REQUIRED' using errcode = '42501';
  end if;
  -- Match the statement serializer/finalization lock order, including when
  -- this validation is reached through an ordinary table UPDATE.
  perform version from public.payroll_revision where id = 1 for update;
  if not found then raise exception 'PAYROLL_REVISION_MISSING'; end if;
  if p_before.id is null or p_after.id is null
    or current_setting('app.payroll_term_break_target', true) is distinct from p_before.id::text
    or length(v_reason) not between 1 and 1000 then
    raise exception 'PAYROLL_TERM_BREAK_CONTEXT_REQUIRED';
  end if;
  if (to_jsonb(p_before) - array['break_start', 'break_end'])
      is distinct from (to_jsonb(p_after) - array['break_start', 'break_end']) then
    raise exception 'PAYROLL_TERM_BREAK_ONLY';
  end if;
  if p_before.pay_type is distinct from 'monthly'
    or p_before.monthly_settlement is distinct from 'monthly_net'
    or not exists (
      select 1 from public.payroll_employees e
      where e.id = p_before.employee_id and e.payee_type = 'employee'
        and e.employment_type = 'full_time'
    ) then
    raise exception 'PAYROLL_TERM_BREAK_FULL_TIME_REQUIRED';
  end if;
  if p_before.effective_from is null or not isfinite(p_before.effective_from)
    or p_after.shift_start is null or p_after.shift_end is null
    or p_after.shift_start >= p_after.shift_end
    or p_after.break_start is null or p_after.break_end is null
    or p_after.break_start >= p_after.break_end
    or p_after.break_start < p_after.shift_start
    or p_after.break_end > p_after.shift_end then
    raise exception 'PAYROLL_TERM_BREAK_INVALID';
  end if;
  select min(t.effective_from) into v_next_effective
  from public.payroll_terms t
  where t.employee_id = p_before.employee_id
    and t.effective_from > p_before.effective_from;
  -- Both term and month intervals are half-open. A later term beginning on
  -- the first of a month means that month's finalized run is unaffected.
  if exists (
    select 1 from public.payroll_runs r
    where r.employee_id = p_before.employee_id
      and r.month + interval '1 month' > p_before.effective_from
      and (v_next_effective is null or r.month < v_next_effective)
  ) then
    raise exception 'PAYROLL_TERM_BREAK_FINALIZED';
  end if;
end;
$$;
revoke all on function public.payroll_check_term_break_correction(public.payroll_terms, public.payroll_terms)
  from public, anon, authenticated;
grant execute on function public.payroll_check_term_break_correction(public.payroll_terms, public.payroll_terms)
  to authenticated;

-- Preserve the complete deployed guard and all of its unrelated branches.
-- Abort rather than guess if its exact, reviewed immutability anchor changed.
do $patch_guard$
declare
  v_source text := pg_get_functiondef('public.payroll_guard_row()'::regprocedure);
  v_anchor constant text := 'if tg_op=''DELETE'' or (tg_op=''UPDATE'' and tg_table_name not in (''payroll_employees'',''payroll_days'')) then raise exception ''PAYROLL_IMMUTABLE_RECORD''; end if;';
  v_replacement constant text := 'if tg_op=''UPDATE'' and tg_table_name=''payroll_terms'' then
    perform public.payroll_check_term_break_correction(old,new);
  elsif tg_op=''DELETE'' or (tg_op=''UPDATE'' and tg_table_name not in (''payroll_employees'',''payroll_days'')) then raise exception ''PAYROLL_IMMUTABLE_RECORD''; end if;';
begin
  if (length(v_source) - length(replace(v_source, v_anchor, ''))) / length(v_anchor) <> 1
    or exists (select 1 from pg_proc where oid = 'public.payroll_guard_row()'::regprocedure and prosecdef) then
    raise exception 'PAYROLL_TERM_BREAK_GUARD_SOURCE_UNRECOGNIZED';
  end if;
  execute replace(v_source, v_anchor, v_replacement);
end;
$patch_guard$;

-- Keep a single existing audit event and its existing single revision bump.
-- The row image stays complete; only correction metadata is appended.
do $patch_audit$
declare
  v_source text := pg_get_functiondef('public.payroll_record_change()'::regprocedure);
  v_anchor constant text := 'values(tg_table_name,new.id,tg_op,case when tg_op=''UPDATE'' then to_jsonb(old) else null end,to_jsonb(new),auth.uid());';
  v_replacement constant text := 'values(tg_table_name,new.id,tg_op,case when tg_op=''UPDATE'' then to_jsonb(old) else null end,
      case when tg_table_name=''payroll_terms'' and tg_op=''UPDATE'' then
        to_jsonb(new) || jsonb_build_object(
          ''correction_reason'', btrim(current_setting(''app.payroll_term_break_reason'', true)),
          ''operation'', ''term_break_correction'')
      else to_jsonb(new) end,auth.uid());';
begin
  if (length(v_source) - length(replace(v_source, v_anchor, ''))) / length(v_anchor) <> 1
    or exists (select 1 from pg_proc where oid = 'public.payroll_record_change()'::regprocedure and prosecdef) then
    raise exception 'PAYROLL_TERM_BREAK_AUDIT_SOURCE_UNRECOGNIZED';
  end if;
  execute replace(v_source, v_anchor, v_replacement);
end;
$patch_audit$;

-- No table-wide UPDATE permission. Existing SELECT and INSERT remain intact.
grant update (break_start, break_end) on public.payroll_terms to authenticated;
create policy payroll_terms_admin_correct_break on public.payroll_terms
for update to authenticated
using (
  (select auth.uid()) is not null
  and (select public.has_app_role(array['admin']))
  and id::text = current_setting('app.payroll_term_break_target', true)
)
with check (
  (select auth.uid()) is not null
  and (select public.has_app_role(array['admin']))
  and id::text = current_setting('app.payroll_term_break_target', true)
);

-- Fail closed if the deployed ACL differs from the reviewed SELECT/INSERT-only
-- baseline; adding this workflow must not expose any other column to UPDATE.
do $check_grants$
begin
  if has_table_privilege('authenticated', 'public.payroll_terms', 'UPDATE')
    or exists (
      select 1 from pg_attribute a
      where a.attrelid = 'public.payroll_terms'::regclass
        and a.attnum > 0 and not a.attisdropped
        and a.attname not in ('break_start', 'break_end')
        and has_column_privilege('authenticated', 'public.payroll_terms', a.attname, 'UPDATE')
    ) then
    raise exception 'PAYROLL_TERM_BREAK_UPDATE_GRANTS_UNRECOGNIZED';
  end if;
end;
$check_grants$;

create function public.payroll_correct_term_break(
  p_term_id uuid,
  p_break_start time without time zone,
  p_break_end time without time zone,
  p_reason text,
  p_expected_revision bigint
) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_before public.payroll_terms;
  v_after public.payroll_terms;
  v_revision bigint;
  v_prior_target text := current_setting('app.payroll_term_break_target', true);
  v_prior_reason text := current_setting('app.payroll_term_break_reason', true);
  v_changed boolean;
begin
  perform public.payroll_assert_admin();
  if auth.uid() is null or public.has_app_role(array['admin']) is distinct from true then
    raise exception 'PAYROLL_ADMIN_REQUIRED' using errcode = '42501';
  end if;
  if p_term_id is null or p_break_start is null or p_break_end is null
    or p_expected_revision is null or p_reason is null
    or length(btrim(p_reason)) not between 1 and 1000 then
    raise exception 'PAYROLL_TERM_BREAK_INVALID';
  end if;
  -- Take the global source lock before reading or locking any target row.
  select version into v_revision from public.payroll_revision where id = 1 for update;
  if not found then raise exception 'PAYROLL_REVISION_MISSING'; end if;
  if p_expected_revision is distinct from v_revision then
    raise exception 'PAYROLL_STALE_RELOAD_REQUIRED';
  end if;
  -- SELECT FOR UPDATE also applies the UPDATE policy, so target context is set
  -- before that read. Identity is always the actual invoker's auth.uid().
  perform set_config('app.payroll_term_break_target', p_term_id::text, true);
  perform set_config('app.payroll_term_break_reason', btrim(p_reason), true);
  select * into v_before from public.payroll_terms where id = p_term_id for update;
  if not found then raise exception 'PAYROLL_TERM_NOT_FOUND'; end if;
  v_after := v_before;
  v_after.break_start := p_break_start;
  v_after.break_end := p_break_end;
  perform public.payroll_check_term_break_correction(v_before, v_after);
  v_changed := v_before.break_start is distinct from p_break_start
    or v_before.break_end is distinct from p_break_end;
  if v_changed then
    update public.payroll_terms
      set break_start = p_break_start, break_end = p_break_end
      where id = p_term_id returning * into v_after;
    if not found then raise exception 'PAYROLL_TERM_NOT_FOUND'; end if;
    select version into v_revision from public.payroll_revision where id = 1;
  end if;
  perform set_config('app.payroll_term_break_target', coalesce(v_prior_target, ''), true);
  perform set_config('app.payroll_term_break_reason', coalesce(v_prior_reason, ''), true);
  return jsonb_build_object('term', to_jsonb(v_after), 'revision', v_revision, 'changed', v_changed);
exception when others then
  perform set_config('app.payroll_term_break_target', coalesce(v_prior_target, ''), true);
  perform set_config('app.payroll_term_break_reason', coalesce(v_prior_reason, ''), true);
  raise;
end;
$$;
revoke all on function public.payroll_correct_term_break(uuid, time without time zone, time without time zone, text, bigint)
  from public, anon, authenticated;
grant execute on function public.payroll_correct_term_break(uuid, time without time zone, time without time zone, text, bigint)
  to authenticated;

comment on function public.payroll_correct_term_break(uuid, time without time zone, time without time zone, text, bigint)
  is 'Authenticated admin-only, audited break-only correction for full-time monthly-net terms; refuses finalized affected months.';
