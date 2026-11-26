import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// This suite uses synthetic records in isolated PostgreSQL only. It never opens
// a production connection, reads credentials, or modifies the hosted database.
// Install @electric-sql/pglite, or point PGLITE_MODULE at its dist/index.js.
const { PGlite } = process.env.PGLITE_MODULE
  ? await import(pathToFileURL(path.resolve(process.env.PGLITE_MODULE)).href)
  : await import('@electric-sql/pglite');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migration = await fs.readFile(path.join(root, 'supabase/migrations/20261126101854_payroll_term_break_correction.sql'), 'utf8');
const db = new PGlite();
let checks = 0;
let stage = 'bootstrap';
const q = async (sql, parameters = []) => (await db.query(sql, parameters)).rows;
const equal = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
const ok = (value, message) => { assert.ok(value, message); checks++; };
const rejects = async (operation, pattern, message) => { await assert.rejects(operation, pattern, message); checks++; };
const actor = crypto.randomUUID();
const ids = Object.fromEntries(['employee', 'prior', 'target', 'next', 'overlapEmployee', 'overlapTerm', 'overlapNext',
  'midmonthEmployee', 'midmonthTerm', 'midmonthNext', 'hourlyEmployee', 'hourlyTerm', 'grossEmployee', 'grossTerm',
  'parttimeEmployee', 'parttimeTerm', 'serviceEmployee', 'serviceTerm', 'run', 'priorRun', 'overlapRun', 'midmonthRun',
  'payment', 'punch', 'conversion', 'day'].map(name => [name, crypto.randomUUID()]));

// The base payroll schema predates the migrations in this checkout. Preserve
// representative existing behavior plus the exact immutable/audit anchors used
// by the narrow migration, including the BEFORE STATEMENT serializer. The
// private classification trigger is existing behavior, not a new correction
// privilege or a helper exposed by this migration.
const bootstrap = `
create role anon nologin;
create role authenticated nologin;
create schema auth;
create schema private;
create table auth.users(id uuid primary key);
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt()->>'sub', '')::uuid
$$;
create function public.has_app_role(allowed_roles text[]) returns boolean language sql stable security invoker set search_path='' as $$
  select coalesce((auth.jwt()->'app_metadata'->>'role') = any(allowed_roles), false)
$$;
create function public.payroll_assert_admin() returns void language plpgsql set search_path='' as $$
begin
  if auth.uid() is null or not public.has_app_role(array['admin']) then
    raise exception 'PAYROLL_ADMIN_REQUIRED' using errcode='42501';
  end if;
end;
$$;
grant usage on schema auth, public to anon, authenticated;
create table public.payroll_revision(id integer primary key, version bigint not null);
insert into public.payroll_revision values(1, 41);
create table public.payroll_employees(
  id uuid primary key, name text not null default 'Synthetic employee', device_user_id text,
  hire_date date, employment_type text not null default 'full_time', payee_type text not null default 'employee',
  employment_status text not null default 'active', archived_at timestamptz, active boolean not null default true,
  created_by uuid references auth.users, created_at timestamptz not null default now()
);
create table public.payroll_terms(
  id uuid primary key default gen_random_uuid(), employee_id uuid not null references public.payroll_employees,
  effective_from date not null, pay_type text not null, rate bigint not null, monthly_settlement text not null,
  shift_start time not null, shift_end time not null, break_start time not null, break_end time not null,
  weekly_rest_day integer, created_by uuid references auth.users, created_at timestamptz not null default now(),
  unique(employee_id, effective_from)
);
create table public.payroll_runs(
  id uuid primary key default gen_random_uuid(), employee_id uuid not null references public.payroll_employees,
  month date not null, expected_revision bigint not null default 41, total bigint not null default 7000000,
  snapshot jsonb not null default '{"unresolved":0}', created_by uuid references auth.users,
  created_at timestamptz not null default now(), unique(employee_id, month)
);
create table public.payroll_days(
  id uuid primary key, employee_id uuid not null references public.payroll_employees, work_date date not null,
  created_by uuid references auth.users, created_at timestamptz not null default now(),
  updated_by uuid references auth.users, updated_at timestamptz
);
create table public.payroll_payments(
  id uuid primary key, employee_id uuid not null references public.payroll_employees, amount bigint not null,
  payroll_month date, created_by uuid references auth.users, created_at timestamptz not null default now()
);
create table public.payroll_attendance_raw(
  id uuid primary key, employee_id uuid not null references public.payroll_employees, punched_at timestamptz not null,
  payload jsonb not null, created_by uuid references auth.users, created_at timestamptz not null default now()
);
create table public.payroll_employment_conversions(
  id uuid primary key, employee_id uuid not null references public.payroll_employees,
  term_id uuid not null references public.payroll_terms, prior_salary_amount bigint,
  request_payload jsonb not null, created_by uuid references auth.users, created_at timestamptz not null default now()
);
create table public.payroll_audit(
  id uuid primary key default gen_random_uuid(), table_name text not null, record_id uuid not null,
  action text not null check(action in ('INSERT','UPDATE','DELETE')), before_data jsonb, after_data jsonb,
  created_by uuid not null references auth.users, created_at timestamptz not null default now()
);
create function public.payroll_guard_row() returns trigger language plpgsql set search_path='' as $$
declare current_revision bigint;
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
  elsif tg_table_name='payroll_days' then
    new.updated_by:=auth.uid();new.updated_at:=now();
    if tg_op='UPDATE' and (new.employee_id<>old.employee_id or new.work_date<>old.work_date) then raise exception 'PAYROLL_DAY_KEY_IMMUTABLE'; end if;
  elsif tg_table_name='payroll_runs' then
    if new.expected_revision is distinct from current_revision then raise exception 'PAYROLL_STALE_RELOAD_REQUIRED'; end if;
    if jsonb_typeof(new.snapshot->'unresolved') is distinct from 'number' or (new.snapshot->>'unresolved')::numeric<>0 then raise exception 'PAYROLL_UNRESOLVED_ATTENDANCE'; end if;
  end if;
  return new;
end;
$$;
create function public.payroll_record_change() returns trigger language plpgsql set search_path='' as $$
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
create function public.payroll_serialize_statement() returns trigger language plpgsql set search_path='' as $$
begin
  perform public.payroll_assert_admin();
  perform version from public.payroll_revision where id=1 for update;
  if not found then raise exception 'PAYROLL_REVISION_MISSING'; end if;
  return null;
end; $$;
create function private.payroll_guard_service_work() returns trigger language plpgsql security definer set search_path='' as $$begin
  -- The kiosk writer deliberately cannot SELECT the employee directory.
  -- A trigger-only definer may read this one classification, never return it.
  if exists(select 1 from public.payroll_employees where id=new.employee_id and payee_type='service') then
    raise exception 'PAYROLL_SERVICE_NOT_EMPLOYEE';end if;
  return new;
end;$$;
do $$declare table_name text;begin
  foreach table_name in array array['payroll_revision','payroll_employees','payroll_terms','payroll_runs','payroll_days',
    'payroll_payments','payroll_attendance_raw','payroll_employment_conversions','payroll_audit'] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all on public.%I from public,anon,authenticated', table_name);
    execute format('grant select on public.%I to authenticated', table_name);
    execute format('create policy admin_read on public.%I for select to authenticated using(public.has_app_role(array[''admin'']))', table_name);
  end loop;
  foreach table_name in array array['payroll_employees','payroll_terms','payroll_runs','payroll_days',
    'payroll_payments','payroll_attendance_raw','payroll_employment_conversions','payroll_audit'] loop
    execute format('grant insert on public.%I to authenticated', table_name);
    execute format('create policy admin_insert on public.%I for insert to authenticated with check(public.has_app_role(array[''admin'']) and auth.uid() is not null)', table_name);
  end loop;
  foreach table_name in array array['payroll_revision','payroll_employees','payroll_days'] loop
    execute format('grant update on public.%I to authenticated', table_name);
    execute format('create policy admin_update on public.%I for update to authenticated using(public.has_app_role(array[''admin''])) with check(public.has_app_role(array[''admin'']))', table_name);
  end loop;
end;$$;
`;

const attachTriggers = `
do $$declare table_name text;begin
  foreach table_name in array array['payroll_employees','payroll_terms','payroll_runs','payroll_days',
    'payroll_payments','payroll_attendance_raw','payroll_employment_conversions'] loop
    execute format('create trigger payroll_guard before insert or update or delete on public.%I for each row execute function public.payroll_guard_row()', table_name);
    execute format('create trigger payroll_audit after insert or update on public.%I for each row execute function public.payroll_record_change()', table_name);
  end loop;
  foreach table_name in array array['payroll_terms','payroll_runs','payroll_employees','payroll_days'] loop
    execute format('create trigger payroll_serialize before insert or update or delete on public.%I for each statement execute function public.payroll_serialize_statement()', table_name);
  end loop;
  foreach table_name in array array['payroll_terms','payroll_runs'] loop
    execute format('create trigger payroll_z_service_guard before insert or update on public.%I for each row execute function private.payroll_guard_service_work()', table_name);
  end loop;
end;$$;
`;

const login = async (role = 'admin', { uid = actor, userMetadata = {}, databaseRole = 'authenticated' } = {}) => {
  await db.exec('reset role');
  await q("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ ...(uid ? { sub: uid } : {}), app_metadata: { role }, user_metadata: userMetadata })]);
  await db.exec(`set role ${databaseRole}`);
};
const revision = async () => Number((await q('select version from public.payroll_revision where id=1'))[0].version);
const correction = async ({ id = ids.target, start = '12:00', end = '14:00', reason = 'Synthetic scheduled-break correction', expected } = {}) =>
  (await q('select public.payroll_correct_term_break($1,$2::time,$3::time,$4,$5::bigint) result',
    [id, start, end, reason, expected === undefined ? await revision() : expected]))[0].result;
const term = async (id = ids.target) => (await q('select to_jsonb(t) data from public.payroll_terms t where id=$1', [id]))[0]?.data;
const context = async () => (await q("select coalesce(current_setting('app.payroll_term_break_target',true),'') target,coalesce(current_setting('app.payroll_term_break_reason',true),'') reason"))[0];
const setContext = async (target = '', reason = '') => q("select set_config('app.payroll_term_break_target',$1,false),set_config('app.payroll_term_break_reason',$2,false)", [target, reason]);
const immutableSnapshot = async () => (await q(`select jsonb_build_object(
  'payments',(select jsonb_agg(to_jsonb(t) order by id) from public.payroll_payments t),
  'punches',(select jsonb_agg(to_jsonb(t) order by id) from public.payroll_attendance_raw t),
  'conversions',(select jsonb_agg(to_jsonb(t) order by id) from public.payroll_employment_conversions t),
  'runs',(select jsonb_agg(to_jsonb(t) order by id) from public.payroll_runs t)
) data`))[0].data;

try {
  await db.exec(bootstrap);
  await q('insert into auth.users values($1)', [actor]);
  for (const [employeeId, employmentType, payeeType] of [
    [ids.employee, 'full_time', 'employee'], [ids.overlapEmployee, 'full_time', 'employee'],
    [ids.midmonthEmployee, 'full_time', 'employee'], [ids.hourlyEmployee, 'full_time', 'employee'],
    [ids.grossEmployee, 'full_time', 'employee'], [ids.parttimeEmployee, 'part_time', 'employee'],
    [ids.serviceEmployee, 'full_time', 'service']
  ]) await q("insert into public.payroll_employees(id,device_user_id,hire_date,employment_type,payee_type,created_by) values($1::uuid,$1::text,'2026-11-01',$2,$3,$4)", [employeeId, employmentType, payeeType, actor]);
  for (const [id, employeeId, effectiveFrom, payType, settlement] of [
    [ids.prior, ids.employee, '2026-11-01', 'hourly', 'statutory'],
    [ids.target, ids.employee, '2026-11-13', 'monthly', 'monthly_net'],
    [ids.next, ids.employee, '2026-12-01', 'monthly', 'monthly_net'],
    [ids.overlapTerm, ids.overlapEmployee, '2026-11-13', 'monthly', 'monthly_net'],
    [ids.overlapNext, ids.overlapEmployee, '2026-12-01', 'monthly', 'monthly_net'],
    [ids.midmonthTerm, ids.midmonthEmployee, '2026-11-13', 'monthly', 'monthly_net'],
    [ids.midmonthNext, ids.midmonthEmployee, '2026-11-20', 'monthly', 'monthly_net'],
    [ids.hourlyTerm, ids.hourlyEmployee, '2026-11-13', 'hourly', 'statutory'],
    [ids.grossTerm, ids.grossEmployee, '2026-11-13', 'monthly', 'statutory'],
    [ids.parttimeTerm, ids.parttimeEmployee, '2026-11-13', 'monthly', 'monthly_net'],
    [ids.serviceTerm, ids.serviceEmployee, '2026-11-13', 'monthly', 'monthly_net']
  ]) await q("insert into public.payroll_terms(id,employee_id,effective_from,pay_type,rate,monthly_settlement,shift_start,shift_end,break_start,break_end,weekly_rest_day,created_by) values($1,$2,$3,$4,7000000,$5,'10:00','20:00','00:00','00:00',0,$6)", [id, employeeId, effectiveFrom, payType, settlement, actor]);
  for (const [id, employeeId, month] of [[ids.run, ids.employee, '2026-12-01'], [ids.priorRun, ids.employee, '2026-10-01'],
    [ids.overlapRun, ids.overlapEmployee, '2026-11-01'], [ids.midmonthRun, ids.midmonthEmployee, '2026-11-01']])
    await q("insert into public.payroll_runs(id,employee_id,month,snapshot,created_by) values($1,$2,$3,'{\"unresolved\":0,\"fixture\":\"immutable finalized snapshot\"}',$4)", [id, employeeId, month, actor]);
  await q("insert into public.payroll_payments(id,employee_id,amount,payroll_month,created_by) values($1,$2,1700000,'2026-11-01',$3)", [ids.payment, ids.employee, actor]);
  await q("insert into public.payroll_attendance_raw(id,employee_id,punched_at,payload,created_by) values($1,$2,'2026-11-14T03:04:05Z','{\"fixture\":\"untouched raw punch\"}',$3)", [ids.punch, ids.employee, actor]);
  await q("insert into public.payroll_employment_conversions(id,employee_id,term_id,prior_salary_amount,request_payload,created_by) values($1,$2,$3,1700000,'{\"terms\":{\"break_start\":\"00:00\",\"break_end\":\"00:00\"},\"reason\":\"original synthetic conversion\"}',$4)", [ids.conversion, ids.employee, ids.target, actor]);
  await q("insert into public.payroll_days(id,employee_id,work_date,created_by) values($1,$2,'2026-11-14',$3)", [ids.day, ids.employee, actor]);
  await db.exec(attachTriggers);
  const protectedFunctionsBefore = await q("select p.oid::regprocedure::text name,pg_get_functiondef(p.oid) definition from pg_proc p where p.oid in ('public.payroll_serialize_statement()'::regprocedure,'private.payroll_guard_service_work()'::regprocedure) order by 1");
  const tableCount = Number((await q("select count(*) n from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r' and n.nspname in ('public','private')"))[0].n);

  stage = 'migration';
  await db.exec(`begin;${migration}\ncommit;`);
  equal(await q("select p.oid::regprocedure::text name,pg_get_functiondef(p.oid) definition from pg_proc p where p.oid in ('public.payroll_serialize_statement()'::regprocedure,'private.payroll_guard_service_work()'::regprocedure) order by 1"), protectedFunctionsBefore, 'existing serializer and service classification guards are unchanged');
  equal(Number((await q("select count(*) n from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r' and n.nspname in ('public','private')"))[0].n), tableCount, 'correction adds no tables');
  ok((await q("select bool_and(not prosecdef) invoker from pg_proc where pronamespace='public'::regnamespace and proname in ('payroll_correct_term_break','payroll_check_term_break_correction','payroll_guard_row','payroll_record_change')"))[0].invoker, 'correction and shared trigger functions retain invoker security');
  equal((await q("select has_table_privilege('authenticated','public.payroll_terms','UPDATE') table_update,has_column_privilege('authenticated','public.payroll_terms','break_start','UPDATE') break_start,has_column_privilege('authenticated','public.payroll_terms','break_end','UPDATE') break_end,has_column_privilege('authenticated','public.payroll_terms','rate','UPDATE') rate"))[0], { table_update: false, break_start: true, break_end: true, rate: false });
  equal((await q("select has_function_privilege('anon','public.payroll_correct_term_break(uuid,time without time zone,time without time zone,text,bigint)','EXECUTE') allowed"))[0].allowed, false, 'anonymous RPC execution is revoked');

  stage = 'authorization';
  for (const role of ['staff', 'manager']) {
    await login(role);
    await rejects(() => correction({ expected: 41 }), /PAYROLL_ADMIN_REQUIRED/, `${role} cannot invoke correction`);
    await rejects(() => q('update public.payroll_terms set break_start=$1 where id=$2', ['12:00', ids.target]), /PAYROLL_ADMIN_REQUIRED|permission denied/, `${role} cannot directly update a term`);
  }
  await login('staff', { userMetadata: { role: 'admin', roles: ['admin'] } });
  await rejects(() => correction({ expected: 41 }), /PAYROLL_ADMIN_REQUIRED/, 'user-controlled metadata cannot authorize an admin correction');
  await login('admin', { uid: null });
  await rejects(() => correction({ expected: 41 }), /PAYROLL_ADMIN_REQUIRED/, 'admin claim without an authenticated actor is rejected');
  await login('admin', { databaseRole: 'anon' });
  await rejects(() => correction({ expected: 41 }), /permission denied/, 'anonymous database role cannot execute the RPC');
  await login();
  const original = await term();
  const prior = await term(ids.prior);
  const next = await term(ids.next);
  const immutableBefore = await immutableSnapshot();
  equal((await q('update public.payroll_terms set break_start=$1,break_end=$2 where id=$3 returning id', ['12:00', '14:00', ids.target])).length, 0, 'direct UPDATE without workflow context sees no updatable row');
  equal(await term(), original);
  equal(await revision(), 41, 'rejected updates do not advance revision');
  await rejects(() => q('update public.payroll_terms set rate=rate+1 where id=$1', [ids.target]), /permission denied/, 'only two break columns receive UPDATE grants');

  stage = 'validation';
  for (const inputs of [{ reason: '' }, { reason: '   ' }, { reason: null }, { reason: 'x'.repeat(1001) },
    { id: null }, { expected: null }, { start: null }, { end: null }, { start: '14:00', end: '12:00' },
    { start: '12:00', end: '12:00' }, { start: '09:59', end: '14:00' }, { start: '12:00', end: '20:01' }])
    await rejects(() => correction(inputs), /PAYROLL_TERM_BREAK_INVALID/, `invalid correction is rejected: ${JSON.stringify(inputs)}`);
  await rejects(() => correction({ expected: 40 }), /PAYROLL_STALE_RELOAD_REQUIRED/, 'stale source revisions cannot mutate a term');
  await rejects(() => correction({ id: crypto.randomUUID() }), /PAYROLL_TERM_NOT_FOUND/, 'missing target is rejected');
  for (const id of [ids.hourlyTerm, ids.grossTerm, ids.parttimeTerm, ids.serviceTerm])
    await rejects(() => correction({ id }), /PAYROLL_TERM_BREAK_FULL_TIME_REQUIRED|PAYROLL_SERVICE_NOT_EMPLOYEE/, 'only full-time employee monthly-net terms can be corrected');
  await rejects(() => correction({ id: ids.overlapTerm }), /PAYROLL_TERM_BREAK_FINALIZED/, 'a finalized month intersecting the effective interval blocks correction');
  await rejects(() => correction({ id: ids.midmonthTerm }), /PAYROLL_TERM_BREAK_FINALIZED/, 'a next term later in the same month does not exclude that finalized month');
  equal(await revision(), 41);
  equal(await context(), { target: '', reason: '' }, 'failed corrections leave no active context');

  stage = 'successful correction';
  await setContext(ids.hourlyTerm, 'Preexisting outer workflow context');
  await rejects(() => correction({ id: ids.overlapTerm }), /PAYROLL_TERM_BREAK_FINALIZED/);
  equal(await context(), { target: ids.hourlyTerm, reason: 'Preexisting outer workflow context' }, 'failed RPC restores caller context as well');
  const result = await correction({ reason: '  Correct the scheduled unpaid break  ' });
  equal(result.changed, true);
  equal(Number(result.revision), 42, 'one correction advances the source revision exactly once');
  equal(await context(), { target: ids.hourlyTerm, reason: 'Preexisting outer workflow context' }, 'successful RPC restores caller context');
  await setContext();
  const corrected = await term();
  equal(corrected.break_start, '12:00:00');
  equal(corrected.break_end, '14:00:00');
  equal(result.term, corrected, 'RPC returns the saved term');
  const withoutBreak = row => Object.fromEntries(Object.entries(row).filter(([key]) => !['break_start', 'break_end'].includes(key)));
  equal(withoutBreak(corrected), withoutBreak(original), 'rate, identity, effective date, shifts and all other fields remain unchanged');
  equal(await term(ids.prior), prior, 'preconversion terms remain untouched');
  equal(await term(ids.next), next, 'later terms remain untouched');
  equal(await immutableSnapshot(), immutableBefore, 'settlement, conversion payload, payments, punches and finalized snapshots remain unchanged');
  const audit = await q("select table_name,record_id,action,before_data,after_data,created_by from public.payroll_audit order by created_at,id");
  equal(audit.length, 1, 'correction creates one audit event, not a duplicate change');
  equal(audit[0].table_name, 'payroll_terms');
  equal(audit[0].record_id, ids.target);
  equal(audit[0].action, 'UPDATE');
  equal(audit[0].created_by, actor, 'the real authenticated actor is recorded');
  equal(audit[0].before_data, original, 'audit retains the full before row');
  equal(audit[0].after_data, { ...corrected, correction_reason: 'Correct the scheduled unpaid break', operation: 'term_break_correction' }, 'single audit retains full after row, reason and operation');
  equal(await revision(), 42);

  stage = 'idempotence and scope';
  equal((await correction()).changed, false, 'already desired break is an audited-safe no-op');
  equal(await revision(), 42, 'no-op does not advance revision');
  equal(Number((await q('select count(*) n from public.payroll_audit'))[0].n), 1, 'no-op adds no audit event');
  await rejects(() => correction({ expected: 41 }), /PAYROLL_STALE_RELOAD_REQUIRED/, 'stale no-op still requires reload');
  await rejects(() => correction({ id: ids.overlapTerm, start: '00:00', end: '00:00' }), /PAYROLL_TERM_BREAK_INVALID|PAYROLL_TERM_BREAK_FINALIZED/, 'unchanged values cannot evade finalized or valid-bound checks');
  equal(await context(), { target: '', reason: '' });

  stage = 'guard defense in depth';
  await setContext(ids.target, 'Direct SQL invariant test');
  await db.exec('reset role');
  // Owner privilege bypasses column grants/RLS in this isolated fixture only;
  // the unchanged guard must still reject forbidden row differences.
  for (const [sql, parameters] of [
    ['update public.payroll_terms set rate=rate+1 where id=$1', [ids.target]],
    ['update public.payroll_terms set weekly_rest_day=null where id=$1', [ids.target]],
    ['update public.payroll_terms set effective_from=effective_from+1 where id=$1', [ids.target]],
    ['update public.payroll_terms set created_by=null where id=$1', [ids.target]]
  ]) await rejects(() => q(sql, parameters), /PAYROLL_TERM_BREAK_ONLY/, 'trigger independently forbids every non-break change, including NULL transitions');
  await rejects(() => q("update public.payroll_terms set break_start='09:00',break_end='14:00' where id=$1", [ids.target]), /PAYROLL_TERM_BREAK_INVALID/, 'forged workflow context cannot evade bounds');
  await setContext(ids.overlapTerm, 'Direct SQL finalized invariant test');
  await rejects(() => q("update public.payroll_terms set break_start='12:00',break_end='14:00' where id=$1", [ids.overlapTerm]), /PAYROLL_TERM_BREAK_FINALIZED/, 'forged workflow context cannot evade finalized protection');
  await setContext(ids.target, '');
  await rejects(() => q("update public.payroll_terms set break_start='12:01' where id=$1", [ids.target]), /PAYROLL_TERM_BREAK_CONTEXT_REQUIRED|PAYROLL_TERM_BREAK_INVALID/, 'guard requires a nonempty correction reason');
  await setContext(ids.hourlyTerm, 'Wrong target');
  await rejects(() => q("update public.payroll_terms set break_start='12:01' where id=$1", [ids.target]), /PAYROLL_TERM_BREAK_CONTEXT_REQUIRED/, 'guard requires matching target even when RLS is not the boundary');
  await setContext();
  await login('manager');
  await setContext(ids.target, 'Forged administrator workflow context');
  await rejects(() => q("update public.payroll_terms set break_start='12:01' where id=$1", [ids.target]), /PAYROLL_ADMIN_REQUIRED|permission denied/, 'context alone never authorizes correction');
  await login();
  await setContext();
  equal(await term(), corrected);
  equal(await immutableSnapshot(), immutableBefore);
  equal(await revision(), 42, 'all rejected bypass attempts remain atomic');

  stage = 'preserved existing behavior';
  await db.exec('reset role');
  await rejects(() => q('update public.payroll_runs set total=total+1 where id=$1', [ids.run]), /PAYROLL_IMMUTABLE_RECORD/);
  await rejects(() => q('delete from public.payroll_terms where id=$1', [ids.target]), /PAYROLL_IMMUTABLE_RECORD/);
  await rejects(() => q('update public.payroll_payments set amount=amount+1 where id=$1', [ids.payment]), /PAYROLL_IMMUTABLE_RECORD/);
  await rejects(() => q('update public.payroll_employment_conversions set prior_salary_amount=0 where id=$1', [ids.conversion]), /PAYROLL_IMMUTABLE_RECORD/);
  await rejects(() => q("insert into public.payroll_terms(employee_id,effective_from,pay_type,rate,monthly_settlement,shift_start,shift_end,break_start,break_end,weekly_rest_day) values($1,'2026-12-01','monthly',7000000,'monthly_net','10:00','20:00','12:00','14:00',0)", [ids.serviceEmployee]), /PAYROLL_SERVICE_NOT_EMPLOYEE/, 'existing private service guard remains active');
  await rejects(() => q("update public.payroll_employees set device_user_id='forbidden-device-change' where id=$1", [ids.employee]), /PAYROLL_DEVICE_ID_IMMUTABLE/, 'unrelated shared guard branches retain their original behavior');
  await login();
  equal(await immutableSnapshot(), immutableBefore);
  equal(await revision(), 42);
  equal(await q("select tgname,tgenabled from pg_trigger where not tgisinternal and tgrelid='public.payroll_terms'::regclass order by tgname"), [
    { tgname: 'payroll_audit', tgenabled: 'O' }, { tgname: 'payroll_guard', tgenabled: 'O' },
    { tgname: 'payroll_serialize', tgenabled: 'O' }, { tgname: 'payroll_z_service_guard', tgenabled: 'O' }
  ], 'all preexisting term triggers remain enabled');

  stage = 'unrecognized baseline fails closed';
  // Independently exercise each deployment preflight in a fresh database. A
  // rejected migration is transactional: no correction RPC/helper or new break
  // UPDATE grant survives an unknown deployment state.
  for (const [name, change, expectedError] of [
    ['missing RLS', 'alter table public.payroll_terms disable row level security', /PAYROLL_TERM_BREAK_BASELINE_UNRECOGNIZED/],
    ['missing serializer', 'drop trigger payroll_serialize on public.payroll_terms', /PAYROLL_TERM_BREAK_BASELINE_UNRECOGNIZED/],
    ['unknown row guard', "create or replace function public.payroll_guard_row() returns trigger language plpgsql as $$begin raise exception 'UNRECOGNIZED_EXISTING_GUARD'; end;$$", /PAYROLL_TERM_BREAK_GUARD_SOURCE_UNRECOGNIZED/],
    ['unknown audit', "create or replace function public.payroll_record_change() returns trigger language plpgsql as $$begin raise exception 'UNRECOGNIZED_EXISTING_AUDIT'; end;$$", /PAYROLL_TERM_BREAK_AUDIT_SOURCE_UNRECOGNIZED/],
    ['unexpected existing UPDATE grant', 'grant update(rate) on public.payroll_terms to authenticated', /PAYROLL_TERM_BREAK_UPDATE_GRANTS_UNRECOGNIZED/]
  ]) {
    const isolated = new PGlite();
    try {
      await isolated.exec(bootstrap + attachTriggers + change + ';');
      await rejects(() => isolated.exec(`begin;${migration}\ncommit;`), expectedError, name);
      await isolated.exec('rollback');
      const restored = (await isolated.query(`select
        to_regprocedure('public.payroll_correct_term_break(uuid,time without time zone,time without time zone,text,bigint)') is null no_rpc,
        to_regprocedure('public.payroll_check_term_break_correction(public.payroll_terms,public.payroll_terms)') is null no_helper,
        has_column_privilege('authenticated','public.payroll_terms','break_start','UPDATE') break_update`)).rows[0];
      equal(restored, { no_rpc: true, no_helper: true, break_update: false }, `${name}: aborted migration does not open a write path`);
    } finally {
      await isolated.close();
    }
  }

  console.log(`Payroll break correction SQL: ${checks} checks passed; all data isolated.`);
} catch (error) {
  console.error({ stage, message: error.message, code: error.code, where: error.where, position: error.position,
    internalQuery: error.internalQuery, stack: error.code ? undefined : error.stack });
  process.exitCode = 1;
} finally {
  await db.close();
}
