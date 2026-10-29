-- Keep persisted terms and finalized snapshots on their previous semantics.
-- Only newly inserted term versions use the monthly net-settlement defaults.
begin;
alter table public.payroll_terms
  add column monthly_settlement text not null default 'statutory',
  add column monthly_extra_hourly_rate numeric,
  add column weekly_rest_day smallint not null default 0,
  add constraint payroll_terms_monthly_settlement_check check(monthly_settlement in ('monthly_net','statutory')),
  add constraint payroll_terms_monthly_extra_rate_check check(monthly_extra_hourly_rate is null or
    (monthly_extra_hourly_rate between 0 and 1000000000 and monthly_extra_hourly_rate=trunc(monthly_extra_hourly_rate))),
  add constraint payroll_terms_monthly_net_rate_required check(pay_type<>'monthly' or monthly_settlement<>'monthly_net' or
    (monthly_extra_hourly_rate is not null and monthly_extra_hourly_rate>0)),
  add constraint payroll_terms_weekly_rest_day_check check(weekly_rest_day between 0 and 6);
alter table public.payroll_terms
  alter column monthly_settlement set default 'monthly_net',
  alter column break_start set default '12:00',
  alter column break_end set default '14:00';

comment on column public.payroll_terms.monthly_settlement is 'Versioned monthly wage mode: monthly_net preserves full monthly base and pays only positive approved monthly net minutes at the explicit extra rate; statutory retains the previous calculation behavior.';
comment on column public.payroll_terms.monthly_extra_hourly_rate is 'Independent whole-VND hourly rate for monthly_net settlement, strictly positive for monthly wages. Never inferred by dividing monthly salary.';
comment on column public.payroll_terms.weekly_rest_day is 'Exactly one default weekly rest weekday for this term version: 0 Sunday through 6 Saturday. Explicit calendar day overrides remain preserved.';

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
  if exists(select 1 from public.payroll_run_balances where total<0 or total>999999999999 or paid>total)
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
