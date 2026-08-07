-- Follow-up for connector_cutover_transfer.
-- PostgreSQL sequence setval() is not transactional. This migration keeps the
-- already-applied helper immutable and replaces only the affected routines with
-- an observable-next-value contract plus transactional ALTER SEQUENCE RESTART.

create function private.connector_cutover_normalize_manifest(p_manifest jsonb)
returns jsonb
language plpgsql
immutable
strict
security invoker
set search_path = ''
as $$
declare
  v_sequence jsonb;
  v_max_id bigint;
  v_next_value bigint;
  v_next_value_safe boolean;
begin
  if pg_catalog.jsonb_typeof(p_manifest) <> 'object'
     or pg_catalog.jsonb_typeof(p_manifest->'sequence') <> 'object' then
    raise exception using
      errcode = '22023',
      message = 'cutover manifest sequence contract is missing';
  end if;

  v_sequence := p_manifest->'sequence';
  if not (v_sequence ?& array[
    'name', 'max_id', 'next_value', 'next_value_safe'
  ]::text[]) then
    raise exception using
      errcode = '22023',
      message = 'cutover manifest observable sequence keys are incomplete';
  end if;

  begin
    v_max_id := (v_sequence->>'max_id')::bigint;
    v_next_value := (v_sequence->>'next_value')::bigint;
    v_next_value_safe := (v_sequence->>'next_value_safe')::boolean;
  exception
    when invalid_text_representation or numeric_value_out_of_range then
      raise exception using
        errcode = '22023',
        message = 'cutover manifest observable sequence values are invalid';
  end;

  if v_sequence->>'name' is distinct from 'public.resv_groups_id_seq'
     or v_next_value is null
     or v_next_value < 1
     or v_next_value_safe is not true
     or (v_max_id is not null and (v_max_id < 1 or v_next_value <= v_max_id)) then
    raise exception using
      errcode = '22023',
      message = 'cutover manifest observable sequence state is unsafe';
  end if;

  return pg_catalog.jsonb_set(
    p_manifest - 'read_only',
    '{sequence}'::text[],
    pg_catalog.jsonb_build_object(
      'name', v_sequence->'name',
      'max_id', pg_catalog.to_jsonb(v_max_id),
      'next_value', pg_catalog.to_jsonb(v_next_value),
      'next_value_safe', pg_catalog.to_jsonb(v_next_value_safe)
    ),
    true
  );
end;
$$;

revoke execute on function private.connector_cutover_normalize_manifest(jsonb)
  from public, anon, authenticated, service_role;

create or replace function private.connector_cutover_commit(p_transfer_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_run private.connector_cutover_runs%rowtype;
  v_target_manifest jsonb;
  v_source_sequence jsonb;
  v_source_next_value bigint;
begin
  if current_user <> 'postgres' then
    raise exception using errcode = '42501', message = 'postgres maintenance role required';
  end if;
  perform pg_catalog.set_config('lock_timeout', '5s', true);
  perform pg_catalog.set_config('statement_timeout', '0', true);
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('dgv.connector-cutover:' || p_transfer_id::text, 0)
  );

  select *
  into v_run
  from private.connector_cutover_runs as r
  where r.transfer_id = p_transfer_id
  for update;
  if not found or v_run.state <> 'ready' then
    raise exception using errcode = '55000', message = 'transfer is not ready to commit';
  end if;
  if v_run.source_manifest_after_sha256 is distinct from v_run.source_manifest_sha256 then
    raise exception using errcode = '55000', message = 'source before/after manifest hashes differ';
  end if;

  -- Validate and freeze the observable next allocation before any public row
  -- is inserted. Raw last_value/is_called representation is intentionally not
  -- the cross-database contract; next_value is.
  perform private.connector_cutover_normalize_manifest(v_run.source_manifest);
  v_source_sequence := v_run.source_manifest->'sequence';
  v_source_next_value := (v_source_sequence->>'next_value')::bigint;
  if private.connector_cutover_table_manifest(p_transfer_id)
     <> v_run.source_manifest->'tables' then
    raise exception using errcode = '55000', message = 'staging checksum drifted after seal';
  end if;
  if private.connector_cutover_database_contract()
     <> v_run.source_manifest->'database_contract' then
    raise exception using errcode = '55000', message = 'target database contract differs from source';
  end if;
  if not private.connector_cutover_target_gate_closed() then
    raise exception using errcode = '55000', message = 'target Data API write gate is not closed';
  end if;
  if exists (
    select 1
    from cron.job as j
    where j.active
      and j.jobname in (
        'tg_notify_v2_dispatch_pending',
        'tg_tomorrow_resv_20h_vn'
      )
  ) or exists (
    select 1
    from cron.job_run_details as d
    where d.status in ('starting', 'running')
      and (
        pg_catalog.strpos(d.command, 'dispatch_pending_notification_outbox') > 0
        or pg_catalog.strpos(d.command, 'send_tomorrow_resv_summary') > 0
      )
  ) then
    raise exception using errcode = '55000', message = 'target notification jobs are not quiescent';
  end if;

  lock table
    public.menu_items,
    public.orders,
    public.order_items,
    public.order_custom_items,
    public.resv_groups,
    public.notices,
    public.notification_outbox
  in access exclusive mode;

  if exists (select 1 from public.menu_items)
     or exists (select 1 from public.orders)
     or exists (select 1 from public.order_items)
     or exists (select 1 from public.order_custom_items)
     or exists (select 1 from public.resv_groups)
     or exists (select 1 from public.notices)
     or exists (select 1 from public.notification_outbox) then
    raise exception using
      errcode = '55000',
      message = 'target changed after empty preflight; no rows were copied';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_class as c
    join pg_catalog.pg_namespace as n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname in (
        'menu_items',
        'orders',
        'order_items',
        'order_custom_items',
        'resv_groups',
        'notices'
      )
      and c.relowner <> (select oid from pg_catalog.pg_roles where rolname = current_user)
  ) then
    raise exception using errcode = '42501', message = 'maintenance role must own every business table';
  end if;
  if exists (
    select 1
    from pg_catalog.pg_trigger as t
    join pg_catalog.pg_class as c on c.oid = t.tgrelid
    join pg_catalog.pg_namespace as n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname in (
        'menu_items',
        'orders',
        'order_items',
        'order_custom_items',
        'resv_groups',
        'notices'
      )
      and not t.tgisinternal
      and t.tgenabled <> 'O'
  ) then
    raise exception using errcode = '55000', message = 'a business-table user trigger was not initially enabled';
  end if;

  -- DISABLE TRIGGER USER is transactional. FK/system constraint triggers stay
  -- enabled, and dependency-order inserts satisfy them. Any later exception
  -- rolls back both these catalog changes and every public-table insert.
  alter table public.menu_items disable trigger user;
  alter table public.orders disable trigger user;
  alter table public.order_items disable trigger user;
  alter table public.order_custom_items disable trigger user;
  alter table public.resv_groups disable trigger user;
  alter table public.notices disable trigger user;

  insert into public.menu_items (
    type, id, ko_name, vi_name, price_usd, price_vnd, is_active, sort_order, created_at
  )
  select
    type, id, ko_name, vi_name, price_usd, price_vnd, is_active, sort_order, created_at
  from private.connector_cutover_menu_items
  where transfer_id = p_transfer_id
  order by id::text collate "C";

  insert into public.orders (
    sales_excluded, total_usd, total_vnd, id, created_at, source, status,
    guide_name, team_no, payment_method
  )
  select
    sales_excluded, total_usd, total_vnd, id, created_at, source, status,
    guide_name, team_no, payment_method
  from private.connector_cutover_orders
  where transfer_id = p_transfer_id
  order by id::text collate "C";

  insert into public.order_items (
    order_id, qty, unit_usd, unit_vnd, line_usd, line_vnd, id,
    menu_item_id, is_custom, custom_ko_name, custom_vi_name
  )
  select
    order_id, qty, unit_usd, unit_vnd, line_usd, line_vnd, id,
    menu_item_id, is_custom, custom_ko_name, custom_vi_name
  from private.connector_cutover_order_items
  where transfer_id = p_transfer_id
  order by id::text collate "C";

  insert into public.order_custom_items (
    id, kind, order_id, ko_name, vi_name, qty, unit_usd, unit_vnd,
    line_usd, line_vnd, created_at
  )
  select
    id, kind, order_id, ko_name, vi_name, qty, unit_usd, unit_vnd,
    line_usd, line_vnd, created_at
  from private.connector_cutover_order_custom_items
  where transfer_id = p_transfer_id
  order by id::text collate "C";

  insert into public.resv_groups (
    id, res_date, res_time, guests_count, price, menu_ko, menu_vi, note,
    branch, guide_name, created_at, confirmed, confirmed_at, confirmed_order_id
  )
  select
    id, res_date, res_time, guests_count, price, menu_ko, menu_vi, note,
    branch, guide_name, created_at, confirmed, confirmed_at, confirmed_order_id
  from private.connector_cutover_resv_groups
  where transfer_id = p_transfer_id
  order by id::text collate "C";

  insert into public.notices (
    title, body, author, id, created_at, updated_at
  )
  select title, body, author, id, created_at, updated_at
  from private.connector_cutover_notices
  where transfer_id = p_transfer_id
  order by id::text collate "C";

  -- RESTART is transactional and takes the sequence lock. Unlike setval(),
  -- this catalog/state change rolls back together with every inserted row and
  -- trigger DDL if any validation below raises or the caller rolls back.
  execute pg_catalog.format(
    'alter sequence public.resv_groups_id_seq restart with %s',
    v_source_next_value
  );

  alter table public.menu_items enable trigger user;
  alter table public.orders enable trigger user;
  alter table public.order_items enable trigger user;
  alter table public.order_custom_items enable trigger user;
  alter table public.resv_groups enable trigger user;
  alter table public.notices enable trigger user;

  if exists (
    select 1
    from pg_catalog.pg_trigger as t
    join pg_catalog.pg_class as c on c.oid = t.tgrelid
    join pg_catalog.pg_namespace as n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname in (
        'menu_items',
        'orders',
        'order_items',
        'order_custom_items',
        'resv_groups',
        'notices'
      )
      and not t.tgisinternal
      and t.tgenabled <> 'O'
  ) then
    raise exception using errcode = '55000', message = 'user triggers did not return to enabled state';
  end if;

  v_target_manifest := pg_catalog.jsonb_build_object(
    'contract_version', 1,
    'read_only', false,
    'database_contract', private.connector_cutover_database_contract(),
    'tables', private.connector_cutover_table_manifest(null),
    'sequence', private.connector_cutover_sequence_manifest(),
    'integrity', private.connector_cutover_integrity_manifest()
  );

  if private.connector_cutover_normalize_manifest(v_target_manifest)
     <> private.connector_cutover_normalize_manifest(v_run.source_manifest)
     or (v_target_manifest->'sequence'->>'next_value')::bigint
        is distinct from v_source_next_value then
    raise exception using
      errcode = '55000',
      message = 'target manifest does not exactly match source observable state after atomic copy';
  end if;
  if not private.connector_cutover_target_gate_closed()
     or exists (select 1 from public.notification_outbox) then
    raise exception using errcode = '55000', message = 'target gate or outbox changed during atomic copy';
  end if;

  update private.connector_cutover_runs
  set state = 'committed',
      target_manifest = v_target_manifest,
      committed_at = pg_catalog.now()
  where transfer_id = p_transfer_id;

  return pg_catalog.jsonb_build_object(
    'transfer_id', p_transfer_id,
    'state', 'committed',
    'source_manifest_sha256', v_run.source_manifest_sha256,
    'chunk_plan_sha256', v_run.chunk_plan_sha256,
    'tables', v_target_manifest->'tables',
    'sequence', v_target_manifest->'sequence',
    'integrity', v_target_manifest->'integrity'
  );
end;
$$;

revoke execute on function private.connector_cutover_commit(uuid)
  from public, anon, authenticated, service_role;

create or replace function private.connector_cutover_cleanup(
  p_transfer_id uuid,
  p_confirm_committed_sha256 text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_run private.connector_cutover_runs%rowtype;
begin
  if current_user <> 'postgres' then
    raise exception using errcode = '42501', message = 'postgres maintenance role required';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('dgv.connector-cutover:' || p_transfer_id::text, 0)
  );
  select *
  into v_run
  from private.connector_cutover_runs
  where transfer_id = p_transfer_id
  for update;
  if not found or v_run.state <> 'committed'
     or lower(coalesce(p_confirm_committed_sha256, '')) <> v_run.source_manifest_sha256
     or private.connector_cutover_normalize_manifest(v_run.target_manifest)
        <> private.connector_cutover_normalize_manifest(v_run.source_manifest) then
    raise exception using
      errcode = '55000',
      message = 'committed manifest confirmation is required before staging cleanup';
  end if;

  delete from private.connector_cutover_chunks where transfer_id = p_transfer_id;
  delete from private.connector_cutover_menu_items where transfer_id = p_transfer_id;
  delete from private.connector_cutover_orders where transfer_id = p_transfer_id;
  delete from private.connector_cutover_order_items where transfer_id = p_transfer_id;
  delete from private.connector_cutover_order_custom_items where transfer_id = p_transfer_id;
  delete from private.connector_cutover_resv_groups where transfer_id = p_transfer_id;
  delete from private.connector_cutover_notices where transfer_id = p_transfer_id;

  update private.connector_cutover_runs
  set state = 'cleaned', cleaned_at = pg_catalog.now()
  where transfer_id = p_transfer_id;

  return pg_catalog.jsonb_build_object(
    'transfer_id', p_transfer_id,
    'state', 'cleaned',
    'source_manifest_sha256', v_run.source_manifest_sha256,
    'chunk_plan_sha256', v_run.chunk_plan_sha256
  );
end;
$$;

revoke execute on function private.connector_cutover_cleanup(uuid, text)
  from public, anon, authenticated, service_role;
