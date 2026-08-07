-- Target-only connector transfer staging and atomic commit support.
--
-- This migration must follow 20260807151139_legacy_cutover_compatibility.sql.
-- It never reads from or writes to the production project. Business rows enter
-- only private staging tables until connector_cutover_commit() succeeds.

create table private.connector_cutover_runs (
  transfer_id uuid primary key,
  state text not null default 'staging',
  source_manifest jsonb not null,
  source_manifest_sha256 text not null,
  source_manifest_after_sha256 text,
  chunk_plan_sha256 text,
  target_manifest jsonb,
  created_at timestamp with time zone not null default pg_catalog.now(),
  ready_at timestamp with time zone,
  committed_at timestamp with time zone,
  cleaned_at timestamp with time zone,
  constraint connector_cutover_runs_state_check
    check (state in ('staging', 'ready', 'committed', 'cleaned')),
  constraint connector_cutover_runs_source_hash_check
    check (source_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  constraint connector_cutover_runs_after_hash_check
    check (
      source_manifest_after_sha256 is null
      or source_manifest_after_sha256 ~ '^[0-9a-f]{64}$'
    ),
  constraint connector_cutover_runs_plan_hash_check
    check (
      chunk_plan_sha256 is null
      or chunk_plan_sha256 ~ '^[0-9a-f]{64}$'
    )
);

create unique index connector_cutover_one_active_run
  on private.connector_cutover_runs ((true))
  where state in ('staging', 'ready');

create table private.connector_cutover_chunks (
  transfer_id uuid not null references private.connector_cutover_runs (transfer_id)
    on delete cascade,
  table_name text not null,
  chunk_no integer not null,
  after_key text,
  last_key text,
  complete boolean not null,
  row_count integer not null,
  raw_bytes integer not null,
  payload_sha256 text not null,
  staged_at timestamp with time zone not null default pg_catalog.now(),
  primary key (transfer_id, table_name, chunk_no),
  constraint connector_cutover_chunks_table_check check (
    table_name in (
      'menu_items',
      'orders',
      'order_items',
      'order_custom_items',
      'resv_groups',
      'notices'
    )
  ),
  constraint connector_cutover_chunks_number_check check (chunk_no >= 0),
  constraint connector_cutover_chunks_count_check check (row_count >= 0),
  constraint connector_cutover_chunks_size_check
    check (raw_bytes > 0 and raw_bytes <= 262144),
  constraint connector_cutover_chunks_hash_check
    check (payload_sha256 ~ '^[0-9a-f]{64}$')
);

create table private.connector_cutover_menu_items (
  transfer_id uuid not null references private.connector_cutover_runs (transfer_id)
    on delete cascade,
  chunk_no integer not null,
  type text not null,
  id uuid not null,
  ko_name text,
  vi_name text,
  price_usd integer,
  price_vnd integer,
  is_active boolean,
  sort_order integer,
  created_at timestamp with time zone,
  primary key (transfer_id, id)
);

create index connector_cutover_menu_items_chunk
  on private.connector_cutover_menu_items (transfer_id, chunk_no);

create table private.connector_cutover_orders (
  transfer_id uuid not null references private.connector_cutover_runs (transfer_id)
    on delete cascade,
  chunk_no integer not null,
  sales_excluded boolean not null,
  total_usd integer not null,
  total_vnd integer not null,
  id uuid not null,
  created_at timestamp with time zone not null,
  source text not null,
  status text not null,
  guide_name text,
  team_no text,
  payment_method text not null,
  primary key (transfer_id, id)
);

create index connector_cutover_orders_chunk
  on private.connector_cutover_orders (transfer_id, chunk_no);

create table private.connector_cutover_order_items (
  transfer_id uuid not null references private.connector_cutover_runs (transfer_id)
    on delete cascade,
  chunk_no integer not null,
  order_id uuid not null,
  qty integer not null,
  unit_usd integer not null,
  unit_vnd integer not null,
  line_usd integer not null,
  line_vnd integer not null,
  id uuid not null,
  menu_item_id uuid,
  is_custom boolean not null,
  custom_ko_name text,
  custom_vi_name text,
  primary key (transfer_id, id)
);

create index connector_cutover_order_items_chunk
  on private.connector_cutover_order_items (transfer_id, chunk_no);

create table private.connector_cutover_order_custom_items (
  transfer_id uuid not null references private.connector_cutover_runs (transfer_id)
    on delete cascade,
  chunk_no integer not null,
  id uuid not null,
  kind text not null,
  order_id uuid not null,
  ko_name text not null,
  vi_name text,
  qty integer not null,
  unit_usd integer not null,
  unit_vnd integer not null,
  line_usd integer not null,
  line_vnd integer not null,
  created_at timestamp with time zone not null,
  primary key (transfer_id, id)
);

create index connector_cutover_order_custom_items_chunk
  on private.connector_cutover_order_custom_items (transfer_id, chunk_no);

create table private.connector_cutover_resv_groups (
  transfer_id uuid not null references private.connector_cutover_runs (transfer_id)
    on delete cascade,
  chunk_no integer not null,
  id bigint not null,
  res_date date not null,
  res_time time without time zone not null,
  guests_count integer not null,
  price integer,
  menu_ko text,
  menu_vi text,
  note text,
  branch text not null,
  guide_name text,
  created_at timestamp with time zone not null,
  confirmed boolean not null,
  confirmed_at timestamp with time zone,
  confirmed_order_id uuid,
  primary key (transfer_id, id)
);

create index connector_cutover_resv_groups_chunk
  on private.connector_cutover_resv_groups (transfer_id, chunk_no);

create table private.connector_cutover_notices (
  transfer_id uuid not null references private.connector_cutover_runs (transfer_id)
    on delete cascade,
  chunk_no integer not null,
  title text not null,
  body text not null,
  author text,
  id uuid not null,
  created_at timestamp with time zone not null,
  updated_at timestamp with time zone not null,
  primary key (transfer_id, id)
);

create index connector_cutover_notices_chunk
  on private.connector_cutover_notices (transfer_id, chunk_no);

revoke all on table
  private.connector_cutover_runs,
  private.connector_cutover_chunks,
  private.connector_cutover_menu_items,
  private.connector_cutover_orders,
  private.connector_cutover_order_items,
  private.connector_cutover_order_custom_items,
  private.connector_cutover_resv_groups,
  private.connector_cutover_notices
from public, anon, authenticated, service_role;

create function private.connector_cutover_assert_manifest(p_manifest jsonb)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_table_name text;
  v_table_keys text[];
begin
  if pg_catalog.jsonb_typeof(p_manifest) <> 'object'
     or p_manifest->>'contract_version' <> '1'
     or p_manifest->>'read_only' <> 'true'
     or pg_catalog.jsonb_typeof(p_manifest->'database_contract') <> 'object'
     or pg_catalog.jsonb_typeof(p_manifest->'tables') <> 'object'
     or pg_catalog.jsonb_typeof(p_manifest->'sequence') <> 'object'
     or pg_catalog.jsonb_typeof(p_manifest->'integrity') <> 'object' then
    raise exception using
      errcode = '22023',
      message = 'source manifest does not match contract version 1';
  end if;

  select pg_catalog.array_agg(k order by k)
  into v_table_keys
  from pg_catalog.jsonb_object_keys(p_manifest->'tables') as keys(k);

  if v_table_keys is distinct from array[
    'menu_items',
    'notices',
    'order_custom_items',
    'order_items',
    'orders',
    'resv_groups'
  ]::text[] then
    raise exception using
      errcode = '22023',
      message = 'source manifest business-table set is invalid';
  end if;

  foreach v_table_name in array array[
    'menu_items',
    'orders',
    'order_items',
    'order_custom_items',
    'resv_groups',
    'notices'
  ]::text[]
  loop
    if (p_manifest->'tables'->v_table_name->>'row_count')::bigint < 0
       or coalesce(p_manifest->'tables'->v_table_name->>'checksum', '')
          !~ '^[0-9a-f]{64}$' then
      raise exception using
        errcode = '22023',
        message = pg_catalog.format('invalid manifest entry for %s', v_table_name);
    end if;
  end loop;

  if p_manifest->'sequence'->>'name' <> 'public.resv_groups_id_seq'
     or (p_manifest->'sequence'->>'last_value')::bigint < 1
     or (p_manifest->'sequence'->>'next_value')::bigint < 1
     or (p_manifest->'sequence'->>'next_value_safe')::boolean is not true then
    raise exception using
      errcode = '22023',
      message = 'source sequence manifest is invalid or unsafe';
  end if;
end;
$$;

revoke execute on function private.connector_cutover_assert_manifest(jsonb)
  from public, anon, authenticated, service_role;

create function private.connector_cutover_table_manifest(p_transfer_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
with
business_table_names(table_name) as (
  values
    ('menu_items'::text),
    ('orders'::text),
    ('order_items'::text),
    ('order_custom_items'::text),
    ('resv_groups'::text),
    ('notices'::text)
),
business_rows as (
  select
    'menu_items'::text as table_name,
    m.id::text as sort_key,
    pg_catalog.jsonb_build_array(
      m.type, m.id::text, m.ko_name, m.vi_name, m.price_usd, m.price_vnd,
      m.is_active, m.sort_order,
      case when m.created_at is null then null else pg_catalog.to_char(
        m.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ) end
    )::text as row_json
  from private.connector_cutover_menu_items as m
  where p_transfer_id is not null and m.transfer_id = p_transfer_id

  union all

  select
    'menu_items', m.id::text,
    pg_catalog.jsonb_build_array(
      m.type, m.id::text, m.ko_name, m.vi_name, m.price_usd, m.price_vnd,
      m.is_active, m.sort_order,
      case when m.created_at is null then null else pg_catalog.to_char(
        m.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ) end
    )::text
  from public.menu_items as m
  where p_transfer_id is null

  union all

  select
    'orders', o.id::text,
    pg_catalog.jsonb_build_array(
      o.sales_excluded, o.total_usd, o.total_vnd, o.id::text,
      pg_catalog.to_char(
        o.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ),
      o.source, o.status, o.guide_name, o.team_no, o.payment_method
    )::text
  from private.connector_cutover_orders as o
  where p_transfer_id is not null and o.transfer_id = p_transfer_id

  union all

  select
    'orders', o.id::text,
    pg_catalog.jsonb_build_array(
      o.sales_excluded, o.total_usd, o.total_vnd, o.id::text,
      pg_catalog.to_char(
        o.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ),
      o.source, o.status, o.guide_name, o.team_no, o.payment_method
    )::text
  from public.orders as o
  where p_transfer_id is null

  union all

  select
    'order_items', oi.id::text,
    pg_catalog.jsonb_build_array(
      oi.order_id::text, oi.qty, oi.unit_usd, oi.unit_vnd, oi.line_usd,
      oi.line_vnd, oi.id::text, oi.menu_item_id::text, oi.is_custom,
      oi.custom_ko_name, oi.custom_vi_name
    )::text
  from private.connector_cutover_order_items as oi
  where p_transfer_id is not null and oi.transfer_id = p_transfer_id

  union all

  select
    'order_items', oi.id::text,
    pg_catalog.jsonb_build_array(
      oi.order_id::text, oi.qty, oi.unit_usd, oi.unit_vnd, oi.line_usd,
      oi.line_vnd, oi.id::text, oi.menu_item_id::text, oi.is_custom,
      oi.custom_ko_name, oi.custom_vi_name
    )::text
  from public.order_items as oi
  where p_transfer_id is null

  union all

  select
    'order_custom_items', ci.id::text,
    pg_catalog.jsonb_build_array(
      ci.id::text, ci.kind, ci.order_id::text, ci.ko_name, ci.vi_name,
      ci.qty, ci.unit_usd, ci.unit_vnd, ci.line_usd, ci.line_vnd,
      pg_catalog.to_char(
        ci.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      )
    )::text
  from private.connector_cutover_order_custom_items as ci
  where p_transfer_id is not null and ci.transfer_id = p_transfer_id

  union all

  select
    'order_custom_items', ci.id::text,
    pg_catalog.jsonb_build_array(
      ci.id::text, ci.kind, ci.order_id::text, ci.ko_name, ci.vi_name,
      ci.qty, ci.unit_usd, ci.unit_vnd, ci.line_usd, ci.line_vnd,
      pg_catalog.to_char(
        ci.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      )
    )::text
  from public.order_custom_items as ci
  where p_transfer_id is null

  union all

  select
    'resv_groups', r.id::text,
    pg_catalog.jsonb_build_array(
      r.id, r.res_date::text, pg_catalog.to_char(r.res_time, 'HH24:MI:SS.US'),
      r.guests_count, r.price, r.menu_ko, r.menu_vi, r.note, r.branch,
      r.guide_name,
      pg_catalog.to_char(
        r.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ),
      r.confirmed,
      case when r.confirmed_at is null then null else pg_catalog.to_char(
        r.confirmed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ) end,
      r.confirmed_order_id::text
    )::text
  from private.connector_cutover_resv_groups as r
  where p_transfer_id is not null and r.transfer_id = p_transfer_id

  union all

  select
    'resv_groups', r.id::text,
    pg_catalog.jsonb_build_array(
      r.id, r.res_date::text, pg_catalog.to_char(r.res_time, 'HH24:MI:SS.US'),
      r.guests_count, r.price, r.menu_ko, r.menu_vi, r.note, r.branch,
      r.guide_name,
      pg_catalog.to_char(
        r.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ),
      r.confirmed,
      case when r.confirmed_at is null then null else pg_catalog.to_char(
        r.confirmed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ) end,
      r.confirmed_order_id::text
    )::text
  from public.resv_groups as r
  where p_transfer_id is null

  union all

  select
    'notices', n.id::text,
    pg_catalog.jsonb_build_array(
      n.title, n.body, n.author, n.id::text,
      pg_catalog.to_char(
        n.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ),
      pg_catalog.to_char(
        n.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      )
    )::text
  from private.connector_cutover_notices as n
  where p_transfer_id is not null and n.transfer_id = p_transfer_id

  union all

  select
    'notices', n.id::text,
    pg_catalog.jsonb_build_array(
      n.title, n.body, n.author, n.id::text,
      pg_catalog.to_char(
        n.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ),
      pg_catalog.to_char(
        n.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      )
    )::text
  from public.notices as n
  where p_transfer_id is null
),
business_row_hashes as (
  select
    r.table_name,
    r.sort_key,
    pg_catalog.encode(
      extensions.digest(pg_catalog.convert_to(r.row_json, 'UTF8'), 'sha256'),
      'hex'
    ) as row_hash
  from business_rows as r
),
table_signatures as (
  select
    n.table_name,
    pg_catalog.count(h.sort_key)::bigint as row_count,
    pg_catalog.encode(
      extensions.digest(
        pg_catalog.convert_to(
          coalesce(
            pg_catalog.string_agg(
              h.row_hash,
              '' order by h.sort_key collate "C"
            ),
            ''
          ),
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    ) as checksum
  from business_table_names as n
  left join business_row_hashes as h using (table_name)
  group by n.table_name
)
select pg_catalog.jsonb_object_agg(
  t.table_name,
  pg_catalog.jsonb_build_object(
    'row_count', t.row_count,
    'checksum', t.checksum
  )
  order by t.table_name
)
from table_signatures as t;
$$;

revoke execute on function private.connector_cutover_table_manifest(uuid)
  from public, anon, authenticated, service_role;

create function private.connector_cutover_integrity_manifest()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
with
child_line_totals as (
  select
    lines.order_id,
    pg_catalog.sum(lines.line_usd)::bigint as total_usd,
    pg_catalog.sum(lines.line_vnd)::bigint as total_vnd
  from (
    select oi.order_id, oi.line_usd::bigint, oi.line_vnd::bigint
    from public.order_items as oi
    union all
    select ci.order_id, ci.line_usd::bigint, ci.line_vnd::bigint
    from public.order_custom_items as ci
  ) as lines
  group by lines.order_id
),
integrity_check_names(check_name) as (
  values
    ('order_items_order_orphan'::text),
    ('order_items_menu_orphan'::text),
    ('order_custom_items_order_orphan'::text),
    ('reservation_confirmed_order_orphan'::text),
    ('reservation_confirmation_state_invalid'::text),
    ('reservation_link_wrong_order_source'::text),
    ('reservation_link_group_item_count_invalid'::text),
    ('reservation_link_amount_invalid'::text),
    ('reservation_order_link_reused'::text),
    ('order_item_line_amount_mismatch'::text),
    ('order_custom_item_line_amount_mismatch'::text),
    ('order_total_amount_mismatch'::text),
    ('menu_negative_amount'::text),
    ('order_negative_amount'::text),
    ('order_item_nonpositive_or_negative_amount'::text),
    ('order_custom_item_nonpositive_or_negative_amount'::text),
    ('reservation_nonpositive_or_negative_amount'::text)
),
integrity_issues as (
  select 'order_items_order_orphan'::text as check_name, oi.id::text as row_key
  from public.order_items as oi
  left join public.orders as o on o.id = oi.order_id
  where o.id is null

  union all

  select 'order_items_menu_orphan', oi.id::text
  from public.order_items as oi
  left join public.menu_items as m on m.id = oi.menu_item_id
  where oi.menu_item_id is not null and m.id is null

  union all

  select 'order_custom_items_order_orphan', ci.id::text
  from public.order_custom_items as ci
  left join public.orders as o on o.id = ci.order_id
  where o.id is null

  union all

  select 'reservation_confirmed_order_orphan', r.id::text
  from public.resv_groups as r
  left join public.orders as o on o.id = r.confirmed_order_id
  where r.confirmed_order_id is not null and o.id is null

  union all

  select 'reservation_confirmation_state_invalid', r.id::text
  from public.resv_groups as r
  where (
    r.confirmed = true
    and (r.confirmed_at is null or r.confirmed_order_id is null)
  ) or (
    r.confirmed = false
    and (r.confirmed_at is not null or r.confirmed_order_id is not null)
  )

  union all

  select 'reservation_link_wrong_order_source', r.id::text
  from public.resv_groups as r
  join public.orders as o on o.id = r.confirmed_order_id
  where r.confirmed = true and o.source is distinct from 'reservation_confirm'

  union all

  select 'reservation_link_group_item_count_invalid', r.id::text
  from public.resv_groups as r
  where r.confirmed = true
    and r.confirmed_order_id is not null
    and (
      exists (
        select 1 from public.order_items as oi
        where oi.order_id = r.confirmed_order_id
      )
      or (
        select pg_catalog.count(*)
        from public.order_custom_items as all_ci
        where all_ci.order_id = r.confirmed_order_id
      ) <> 1
      or (
        select pg_catalog.count(*)
        from public.order_custom_items as ci
        where ci.order_id = r.confirmed_order_id
          and ci.kind = 'group_resv'
      ) <> 1
    )

  union all

  select 'reservation_link_amount_invalid', r.id::text
  from public.resv_groups as r
  join public.orders as o on o.id = r.confirmed_order_id
  where r.confirmed = true
    and exists (
      select 1
      from public.order_custom_items as ci
      where ci.order_id = r.confirmed_order_id
        and ci.kind = 'group_resv'
        and (
          r.price is null
          or r.price <= 0
          or ci.qty is distinct from r.guests_count
          or ci.unit_usd is distinct from 0
          or ci.unit_vnd is distinct from r.price
          or ci.line_usd is distinct from 0
          or ci.line_vnd::bigint is distinct from
            r.guests_count::bigint * r.price::bigint
          or o.total_usd is distinct from 0
          or o.total_vnd::bigint is distinct from
            r.guests_count::bigint * r.price::bigint
        )
    )

  union all

  select 'reservation_order_link_reused', r.confirmed_order_id::text
  from public.resv_groups as r
  where r.confirmed_order_id is not null
  group by r.confirmed_order_id
  having pg_catalog.count(*) > 1

  union all

  select 'order_item_line_amount_mismatch', oi.id::text
  from public.order_items as oi
  where oi.line_usd::bigint <> oi.qty::bigint * oi.unit_usd::bigint
     or oi.line_vnd::bigint <> oi.qty::bigint * oi.unit_vnd::bigint

  union all

  select 'order_custom_item_line_amount_mismatch', ci.id::text
  from public.order_custom_items as ci
  where ci.line_usd::bigint <> ci.qty::bigint * ci.unit_usd::bigint
     or ci.line_vnd::bigint <> ci.qty::bigint * ci.unit_vnd::bigint

  union all

  select 'order_total_amount_mismatch', o.id::text
  from public.orders as o
  left join child_line_totals as totals on totals.order_id = o.id
  where o.total_usd::bigint <> coalesce(totals.total_usd, 0)
     or o.total_vnd::bigint <> coalesce(totals.total_vnd, 0)

  union all

  select 'menu_negative_amount', m.id::text
  from public.menu_items as m
  where m.price_usd < 0 or m.price_vnd < 0

  union all

  select 'order_negative_amount', o.id::text
  from public.orders as o
  where o.total_usd < 0 or o.total_vnd < 0

  union all

  select 'order_item_nonpositive_or_negative_amount', oi.id::text
  from public.order_items as oi
  where oi.qty <= 0
     or oi.unit_usd < 0
     or oi.unit_vnd < 0
     or oi.line_usd < 0
     or oi.line_vnd < 0

  union all

  select 'order_custom_item_nonpositive_or_negative_amount', ci.id::text
  from public.order_custom_items as ci
  where ci.qty <= 0
     or ci.unit_usd < 0
     or ci.unit_vnd < 0
     or ci.line_usd < 0
     or ci.line_vnd < 0

  union all

  select 'reservation_nonpositive_or_negative_amount', r.id::text
  from public.resv_groups as r
  where r.guests_count <= 0 or r.price < 0
),
integrity_issue_hashes as (
  select
    i.check_name,
    i.row_key,
    pg_catalog.encode(
      extensions.digest(pg_catalog.convert_to(i.row_key, 'UTF8'), 'sha256'),
      'hex'
    ) as row_hash
  from integrity_issues as i
),
integrity_signatures as (
  select
    n.check_name,
    pg_catalog.count(i.row_key)::bigint as violation_count,
    pg_catalog.encode(
      extensions.digest(
        pg_catalog.convert_to(
          coalesce(
            pg_catalog.string_agg(
              i.row_hash,
              '' order by i.row_key collate "C"
            ),
            ''
          ),
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    ) as checksum
  from integrity_check_names as n
  left join integrity_issue_hashes as i using (check_name)
  group by n.check_name
)
select pg_catalog.jsonb_object_agg(
  i.check_name,
  pg_catalog.jsonb_build_object(
    'violation_count', i.violation_count,
    'checksum', i.checksum
  )
  order by i.check_name
)
from integrity_signatures as i;
$$;

revoke execute on function private.connector_cutover_integrity_manifest()
  from public, anon, authenticated, service_role;

create function private.connector_cutover_database_contract()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
select pg_catalog.jsonb_build_object(
  'server_major', pg_catalog.current_setting('server_version_num')::integer / 10000,
  'server_encoding', pg_catalog.current_setting('server_encoding'),
  'lc_collate', d.datcollate,
  'lc_ctype', d.datctype,
  'locale_provider', d.datlocprovider::text,
  'locale', d.datlocale
)
from pg_catalog.pg_database as d
where d.datname = pg_catalog.current_database();
$$;

revoke execute on function private.connector_cutover_database_contract()
  from public, anon, authenticated, service_role;

create function private.connector_cutover_sequence_manifest()
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
with reservation_max_id as (
  select pg_catalog.max(r.id)::bigint as max_id
  from public.resv_groups as r
),
state as (
  select
    s.last_value::bigint as last_value,
    s.is_called,
    case when s.is_called then s.last_value::bigint + 1 else s.last_value::bigint end
      as next_value,
    m.max_id,
    case
      when m.max_id is null then true
      when s.is_called then s.last_value::bigint + 1 > m.max_id
      else s.last_value::bigint > m.max_id
    end as next_value_safe
  from public.resv_groups_id_seq as s
  cross join reservation_max_id as m
)
select pg_catalog.jsonb_build_object(
  'name', 'public.resv_groups_id_seq',
  'last_value', s.last_value,
  'is_called', s.is_called,
  'next_value', s.next_value,
  'max_id', s.max_id,
  'next_value_safe', s.next_value_safe
)
from state as s;
$$;

revoke execute on function private.connector_cutover_sequence_manifest()
  from public, anon, authenticated, service_role;

create function private.connector_cutover_begin(
  p_transfer_id uuid,
  p_source_manifest jsonb,
  p_source_manifest_sha256 text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_actual_hash text;
begin
  if current_user <> 'postgres' then
    raise exception using errcode = '42501', message = 'postgres maintenance role required';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('dgv.connector-cutover', 0)
  );
  perform private.connector_cutover_assert_manifest(p_source_manifest);

  v_actual_hash := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(p_source_manifest::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );
  if lower(coalesce(p_source_manifest_sha256, '')) <> v_actual_hash then
    raise exception using errcode = '22023', message = 'source manifest SHA-256 mismatch';
  end if;

  if exists (select 1 from public.menu_items)
     or exists (select 1 from public.orders)
     or exists (select 1 from public.order_items)
     or exists (select 1 from public.order_custom_items)
     or exists (select 1 from public.resv_groups)
     or exists (select 1 from public.notices)
     or exists (select 1 from public.notification_outbox) then
    raise exception using
      errcode = '55000',
      message = 'target business tables and notification outbox must be empty';
  end if;

  insert into private.connector_cutover_runs (
    transfer_id,
    source_manifest,
    source_manifest_sha256
  ) values (
    p_transfer_id,
    p_source_manifest,
    v_actual_hash
  );

  return pg_catalog.jsonb_build_object(
    'transfer_id', p_transfer_id,
    'state', 'staging',
    'source_manifest_sha256', v_actual_hash
  );
end;
$$;

revoke execute on function private.connector_cutover_begin(uuid, jsonb, text)
  from public, anon, authenticated, service_role;

create function private.connector_cutover_stage_chunk(
  p_payload_base64 text,
  p_payload_sha256 text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_bytes bytea;
  v_payload jsonb;
  v_actual_hash text;
  v_transfer_id uuid;
  v_table_name text;
  v_chunk_no integer;
  v_after_key text;
  v_last_key text;
  v_complete boolean;
  v_row_count integer;
  v_expected_width integer;
  v_inserted integer;
  v_existing private.connector_cutover_chunks%rowtype;
  v_existing_rows integer;
  v_first_key text;
  v_keys_ordered boolean;
  v_rows_valid boolean;
begin
  if current_user <> 'postgres' then
    raise exception using errcode = '42501', message = 'postgres maintenance role required';
  end if;
  if length(coalesce(p_payload_base64, '')) > 400000 then
    raise exception using errcode = '22023', message = 'encoded chunk exceeds contract limit';
  end if;

  v_bytes := pg_catalog.decode(p_payload_base64, 'base64');
  if pg_catalog.octet_length(v_bytes) > 262144 then
    raise exception using errcode = '22023', message = 'decoded chunk exceeds contract limit';
  end if;
  v_actual_hash := pg_catalog.encode(
    extensions.digest(v_bytes, 'sha256'),
    'hex'
  );
  if lower(coalesce(p_payload_sha256, '')) <> v_actual_hash then
    raise exception using errcode = '22023', message = 'chunk SHA-256 mismatch';
  end if;

  v_payload := pg_catalog.convert_from(v_bytes, 'UTF8')::jsonb;
  if pg_catalog.jsonb_typeof(v_payload) <> 'object'
     or v_payload->>'contract_version' <> '1'
     or pg_catalog.jsonb_typeof(v_payload->'rows') <> 'array' then
    raise exception using errcode = '22023', message = 'chunk envelope is invalid';
  end if;

  v_transfer_id := (v_payload->>'transfer_id')::uuid;
  v_table_name := v_payload->>'table_name';
  v_chunk_no := (v_payload->>'chunk_no')::integer;
  v_after_key := v_payload->>'after_key';
  v_complete := (v_payload->>'complete')::boolean;
  v_row_count := pg_catalog.jsonb_array_length(v_payload->'rows');

  if v_table_name not in (
    'menu_items',
    'orders',
    'order_items',
    'order_custom_items',
    'resv_groups',
    'notices'
  ) or v_chunk_no < 0 then
    raise exception using errcode = '22023', message = 'chunk identity is invalid';
  end if;

  v_expected_width := case v_table_name
    when 'menu_items' then 9
    when 'orders' then 10
    when 'order_items' then 11
    when 'order_custom_items' then 11
    when 'resv_groups' then 14
    when 'notices' then 6
  end;

  select coalesce(pg_catalog.bool_and(
    pg_catalog.jsonb_typeof(e.row_data) = 'object'
    and pg_catalog.jsonb_typeof(e.row_data->'values') = 'array'
    and pg_catalog.jsonb_array_length(e.row_data->'values') = v_expected_width
    and e.row_data ? 'key'
    and e.row_data->>'key' is not null
  ), true)
  into v_rows_valid
  from pg_catalog.jsonb_array_elements(v_payload->'rows') as e(row_data);

  if not v_rows_valid then
    raise exception using errcode = '22023', message = 'chunk row shape is invalid';
  end if;

  select
    min(k.row_key) filter (where k.ordinality = 1),
    max(k.row_key) filter (where k.ordinality = v_row_count),
    coalesce(pg_catalog.bool_and(
      k.previous_key is null or k.previous_key collate "C" < k.row_key collate "C"
    ), true)
  into v_first_key, v_last_key, v_keys_ordered
  from (
    select
      e.ordinality,
      e.row_data->>'key' as row_key,
      pg_catalog.lag(e.row_data->>'key') over (order by e.ordinality) as previous_key
    from pg_catalog.jsonb_array_elements(v_payload->'rows')
      with ordinality as e(row_data, ordinality)
  ) as k;

  if not v_keys_ordered
     or (v_after_key is not null and v_first_key collate "C" <= v_after_key collate "C")
     or (v_row_count = 0 and (v_chunk_no <> 0 or v_after_key is not null or not v_complete))
     or (v_row_count > 0 and v_last_key is null) then
    raise exception using errcode = '22023', message = 'chunk key order is invalid';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('dgv.connector-cutover:' || v_transfer_id::text, 0)
  );
  perform 1
  from private.connector_cutover_runs as r
  where r.transfer_id = v_transfer_id and r.state = 'staging'
  for update;
  if not found then
    raise exception using errcode = '55000', message = 'transfer is not in staging state';
  end if;

  select *
  into v_existing
  from private.connector_cutover_chunks as c
  where c.transfer_id = v_transfer_id
    and c.table_name = v_table_name
    and c.chunk_no = v_chunk_no;

  if found then
    if v_existing.payload_sha256 <> v_actual_hash
       or v_existing.row_count <> v_row_count
       or v_existing.raw_bytes <> pg_catalog.octet_length(v_bytes)
       or v_existing.after_key is distinct from v_after_key
       or v_existing.last_key is distinct from v_last_key
       or v_existing.complete is distinct from v_complete then
      raise exception using errcode = '23505', message = 'chunk retry does not match staged chunk';
    end if;

    execute pg_catalog.format(
      'select pg_catalog.count(*)::integer from private.%I where transfer_id = $1 and chunk_no = $2',
      'connector_cutover_' || v_table_name
    ) into v_existing_rows using v_transfer_id, v_chunk_no;
    if v_existing_rows <> v_row_count then
      raise exception using errcode = '55000', message = 'staged chunk row count drifted';
    end if;
    return pg_catalog.jsonb_build_object(
      'transfer_id', v_transfer_id,
      'table_name', v_table_name,
      'chunk_no', v_chunk_no,
      'row_count', v_row_count,
      'payload_sha256', v_actual_hash,
      'already_staged', true
    );
  end if;

  if v_table_name = 'menu_items' then
    insert into private.connector_cutover_menu_items (
      transfer_id, chunk_no, type, id, ko_name, vi_name, price_usd,
      price_vnd, is_active, sort_order, created_at
    )
    select
      v_transfer_id,
      v_chunk_no,
      e.row_data->'values'->>0,
      (e.row_data->'values'->>1)::uuid,
      e.row_data->'values'->>2,
      e.row_data->'values'->>3,
      (e.row_data->'values'->>4)::integer,
      (e.row_data->'values'->>5)::integer,
      (e.row_data->'values'->>6)::boolean,
      (e.row_data->'values'->>7)::integer,
      (e.row_data->'values'->>8)::timestamp with time zone
    from pg_catalog.jsonb_array_elements(v_payload->'rows') as e(row_data)
    where e.row_data->>'key' = (e.row_data->'values'->>1)::uuid::text;
  elsif v_table_name = 'orders' then
    insert into private.connector_cutover_orders (
      transfer_id, chunk_no, sales_excluded, total_usd, total_vnd, id,
      created_at, source, status, guide_name, team_no, payment_method
    )
    select
      v_transfer_id,
      v_chunk_no,
      (e.row_data->'values'->>0)::boolean,
      (e.row_data->'values'->>1)::integer,
      (e.row_data->'values'->>2)::integer,
      (e.row_data->'values'->>3)::uuid,
      (e.row_data->'values'->>4)::timestamp with time zone,
      e.row_data->'values'->>5,
      e.row_data->'values'->>6,
      e.row_data->'values'->>7,
      e.row_data->'values'->>8,
      e.row_data->'values'->>9
    from pg_catalog.jsonb_array_elements(v_payload->'rows') as e(row_data)
    where e.row_data->>'key' = (e.row_data->'values'->>3)::uuid::text;
  elsif v_table_name = 'order_items' then
    insert into private.connector_cutover_order_items (
      transfer_id, chunk_no, order_id, qty, unit_usd, unit_vnd, line_usd,
      line_vnd, id, menu_item_id, is_custom, custom_ko_name, custom_vi_name
    )
    select
      v_transfer_id,
      v_chunk_no,
      (e.row_data->'values'->>0)::uuid,
      (e.row_data->'values'->>1)::integer,
      (e.row_data->'values'->>2)::integer,
      (e.row_data->'values'->>3)::integer,
      (e.row_data->'values'->>4)::integer,
      (e.row_data->'values'->>5)::integer,
      (e.row_data->'values'->>6)::uuid,
      (e.row_data->'values'->>7)::uuid,
      (e.row_data->'values'->>8)::boolean,
      e.row_data->'values'->>9,
      e.row_data->'values'->>10
    from pg_catalog.jsonb_array_elements(v_payload->'rows') as e(row_data)
    where e.row_data->>'key' = (e.row_data->'values'->>6)::uuid::text;
  elsif v_table_name = 'order_custom_items' then
    insert into private.connector_cutover_order_custom_items (
      transfer_id, chunk_no, id, kind, order_id, ko_name, vi_name, qty,
      unit_usd, unit_vnd, line_usd, line_vnd, created_at
    )
    select
      v_transfer_id,
      v_chunk_no,
      (e.row_data->'values'->>0)::uuid,
      e.row_data->'values'->>1,
      (e.row_data->'values'->>2)::uuid,
      e.row_data->'values'->>3,
      e.row_data->'values'->>4,
      (e.row_data->'values'->>5)::integer,
      (e.row_data->'values'->>6)::integer,
      (e.row_data->'values'->>7)::integer,
      (e.row_data->'values'->>8)::integer,
      (e.row_data->'values'->>9)::integer,
      (e.row_data->'values'->>10)::timestamp with time zone
    from pg_catalog.jsonb_array_elements(v_payload->'rows') as e(row_data)
    where e.row_data->>'key' = (e.row_data->'values'->>0)::uuid::text;
  elsif v_table_name = 'resv_groups' then
    insert into private.connector_cutover_resv_groups (
      transfer_id, chunk_no, id, res_date, res_time, guests_count, price,
      menu_ko, menu_vi, note, branch, guide_name, created_at, confirmed,
      confirmed_at, confirmed_order_id
    )
    select
      v_transfer_id,
      v_chunk_no,
      (e.row_data->'values'->>0)::bigint,
      (e.row_data->'values'->>1)::date,
      (e.row_data->'values'->>2)::time without time zone,
      (e.row_data->'values'->>3)::integer,
      (e.row_data->'values'->>4)::integer,
      e.row_data->'values'->>5,
      e.row_data->'values'->>6,
      e.row_data->'values'->>7,
      e.row_data->'values'->>8,
      e.row_data->'values'->>9,
      (e.row_data->'values'->>10)::timestamp with time zone,
      (e.row_data->'values'->>11)::boolean,
      (e.row_data->'values'->>12)::timestamp with time zone,
      (e.row_data->'values'->>13)::uuid
    from pg_catalog.jsonb_array_elements(v_payload->'rows') as e(row_data)
    where e.row_data->>'key' = (e.row_data->'values'->>0)::bigint::text;
  else
    insert into private.connector_cutover_notices (
      transfer_id, chunk_no, title, body, author, id, created_at, updated_at
    )
    select
      v_transfer_id,
      v_chunk_no,
      e.row_data->'values'->>0,
      e.row_data->'values'->>1,
      e.row_data->'values'->>2,
      (e.row_data->'values'->>3)::uuid,
      (e.row_data->'values'->>4)::timestamp with time zone,
      (e.row_data->'values'->>5)::timestamp with time zone
    from pg_catalog.jsonb_array_elements(v_payload->'rows') as e(row_data)
    where e.row_data->>'key' = (e.row_data->'values'->>3)::uuid::text;
  end if;

  get diagnostics v_inserted = row_count;
  if v_inserted <> v_row_count then
    raise exception using errcode = '22023', message = 'chunk row key does not match typed primary key';
  end if;

  insert into private.connector_cutover_chunks (
    transfer_id,
    table_name,
    chunk_no,
    after_key,
    last_key,
    complete,
    row_count,
    raw_bytes,
    payload_sha256
  ) values (
    v_transfer_id,
    v_table_name,
    v_chunk_no,
    v_after_key,
    v_last_key,
    v_complete,
    v_row_count,
    pg_catalog.octet_length(v_bytes),
    v_actual_hash
  );

  return pg_catalog.jsonb_build_object(
    'transfer_id', v_transfer_id,
    'table_name', v_table_name,
    'chunk_no', v_chunk_no,
    'row_count', v_row_count,
    'payload_sha256', v_actual_hash,
    'already_staged', false
  );
end;
$$;

revoke execute on function private.connector_cutover_stage_chunk(text, text)
  from public, anon, authenticated, service_role;

create function private.connector_cutover_seal(
  p_transfer_id uuid,
  p_source_manifest_after jsonb,
  p_source_manifest_after_sha256 text,
  p_chunk_plan jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_run private.connector_cutover_runs%rowtype;
  v_after_hash text;
  v_plan_hash text;
  v_actual_plan jsonb;
  v_table_name text;
  v_expected_count bigint;
  v_chunk_count integer;
  v_staged_count bigint;
  v_stage_manifest jsonb;
begin
  if current_user <> 'postgres' then
    raise exception using errcode = '42501', message = 'postgres maintenance role required';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('dgv.connector-cutover:' || p_transfer_id::text, 0)
  );

  select *
  into v_run
  from private.connector_cutover_runs as r
  where r.transfer_id = p_transfer_id
  for update;
  if not found or v_run.state <> 'staging' then
    raise exception using errcode = '55000', message = 'transfer is not in staging state';
  end if;

  perform private.connector_cutover_assert_manifest(p_source_manifest_after);
  v_after_hash := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(p_source_manifest_after::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );
  if lower(coalesce(p_source_manifest_after_sha256, '')) <> v_after_hash
     or p_source_manifest_after <> v_run.source_manifest then
    raise exception using
      errcode = '55000',
      message = 'source manifest changed while chunks were staged';
  end if;

  if pg_catalog.jsonb_typeof(p_chunk_plan) <> 'array' then
    raise exception using errcode = '22023', message = 'chunk plan must be a JSON array';
  end if;
  v_plan_hash := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(p_chunk_plan::text, 'UTF8'), 'sha256'),
    'hex'
  );

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'table_name', c.table_name,
        'chunk_no', c.chunk_no,
        'after_key', c.after_key,
        'last_key', c.last_key,
        'complete', c.complete,
        'row_count', c.row_count,
        'raw_bytes', c.raw_bytes,
        'payload_sha256', c.payload_sha256
      ) order by c.table_name, c.chunk_no
    ),
    '[]'::jsonb
  )
  into v_actual_plan
  from private.connector_cutover_chunks as c
  where c.transfer_id = p_transfer_id;

  if v_actual_plan <> p_chunk_plan then
    raise exception using errcode = '55000', message = 'target chunk ledger does not match source chunk plan';
  end if;

  foreach v_table_name in array array[
    'menu_items',
    'orders',
    'order_items',
    'order_custom_items',
    'resv_groups',
    'notices'
  ]::text[]
  loop
    select pg_catalog.count(*)::integer
    into v_chunk_count
    from private.connector_cutover_chunks as c
    where c.transfer_id = p_transfer_id and c.table_name = v_table_name;

    if v_chunk_count = 0 or exists (
      select 1
      from (
        select
          c.*,
          pg_catalog.lag(c.last_key) over (order by c.chunk_no) as previous_last_key,
          pg_catalog.max(c.chunk_no) over () as final_chunk_no
        from private.connector_cutover_chunks as c
        where c.transfer_id = p_transfer_id and c.table_name = v_table_name
      ) as chain
      where chain.chunk_no < 0
         or (chain.chunk_no = 0 and chain.after_key is not null)
         or (chain.chunk_no > 0 and chain.after_key is distinct from chain.previous_last_key)
         or chain.complete is distinct from (chain.chunk_no = chain.final_chunk_no)
    ) or (
      select pg_catalog.min(c.chunk_no) <> 0
          or pg_catalog.max(c.chunk_no) <> pg_catalog.count(*) - 1
      from private.connector_cutover_chunks as c
      where c.transfer_id = p_transfer_id and c.table_name = v_table_name
    ) then
      raise exception using
        errcode = '55000',
        message = pg_catalog.format('chunk chain is incomplete for %s', v_table_name);
    end if;

    v_expected_count := (v_run.source_manifest->'tables'->v_table_name->>'row_count')::bigint;
    execute pg_catalog.format(
      'select pg_catalog.count(*)::bigint from private.%I where transfer_id = $1',
      'connector_cutover_' || v_table_name
    ) into v_staged_count using p_transfer_id;

    if v_staged_count <> v_expected_count or v_staged_count <> (
      select coalesce(pg_catalog.sum(c.row_count), 0)::bigint
      from private.connector_cutover_chunks as c
      where c.transfer_id = p_transfer_id and c.table_name = v_table_name
    ) then
      raise exception using
        errcode = '55000',
        message = pg_catalog.format('staged row count mismatch for %s', v_table_name);
    end if;
  end loop;

  v_stage_manifest := private.connector_cutover_table_manifest(p_transfer_id);
  if v_stage_manifest <> v_run.source_manifest->'tables' then
    raise exception using errcode = '55000', message = 'typed staging checksum does not match source manifest';
  end if;

  update private.connector_cutover_runs
  set state = 'ready',
      source_manifest_after_sha256 = v_after_hash,
      chunk_plan_sha256 = v_plan_hash,
      ready_at = pg_catalog.now()
  where transfer_id = p_transfer_id;

  return pg_catalog.jsonb_build_object(
    'transfer_id', p_transfer_id,
    'state', 'ready',
    'source_manifest_sha256', v_after_hash,
    'chunk_plan_sha256', v_plan_hash,
    'tables', v_stage_manifest
  );
end;
$$;

revoke execute on function private.connector_cutover_seal(uuid, jsonb, text, jsonb)
  from public, anon, authenticated, service_role;

create function private.connector_cutover_target_gate_closed()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
with
api_roles(role_name) as (
  values ('anon'::name), ('authenticated'::name), ('service_role'::name)
),
public_relation_state as (
  select
    r.role_name,
    c.oid,
    (
      pg_catalog.has_table_privilege(
        r.role_name,
        c.oid,
        'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
      )
      or pg_catalog.has_any_column_privilege(
        r.role_name,
        c.oid,
        'INSERT,UPDATE,REFERENCES'
      )
    ) as has_any_mutation
  from pg_catalog.pg_class as c
  join pg_catalog.pg_namespace as n
    on n.oid = c.relnamespace and n.nspname = 'public'
  cross join api_roles as r
  where c.relkind in ('r', 'p', 'v', 'm', 'f')
),
callable_public_mutators as (
  select p.oid, p.proname
  from pg_catalog.pg_proc as p
  join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prokind in ('f', 'p')
    and p.provolatile = 'v'
    and p.prorettype <> 'pg_catalog.trigger'::pg_catalog.regtype
),
function_state as (
  select
    r.role_name,
    p.proname,
    pg_catalog.has_schema_privilege(r.role_name, 'public', 'USAGE')
      and pg_catalog.has_function_privilege(r.role_name, p.oid, 'EXECUTE')
      as can_execute
  from callable_public_mutators as p
  cross join api_roles as r
),
sequence_state as (
  select
    r.role_name,
    pg_catalog.has_sequence_privilege(r.role_name, c.oid, 'USAGE')
      or pg_catalog.has_sequence_privilege(r.role_name, c.oid, 'UPDATE')
      as can_advance
  from pg_catalog.pg_class as c
  join pg_catalog.pg_namespace as n
    on n.oid = c.relnamespace and n.nspname = 'public'
  cross join api_roles as r
  where c.relkind = 'S'
)
select
  not exists (select 1 from public_relation_state where has_any_mutation)
  and not exists (
    select 1
    from function_state
    where can_execute
      and not (
        role_name = 'service_role'
        and proname = 'internal_hash_legacy_password'
      )
  )
  and not exists (select 1 from sequence_state where can_advance);
$$;

revoke execute on function private.connector_cutover_target_gate_closed()
  from public, anon, authenticated, service_role;

create function private.connector_cutover_commit(p_transfer_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_run private.connector_cutover_runs%rowtype;
  v_target_manifest jsonb;
  v_source_sequence jsonb;
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

  v_source_sequence := v_run.source_manifest->'sequence';
  perform pg_catalog.setval(
    'public.resv_groups_id_seq'::pg_catalog.regclass,
    (v_source_sequence->>'last_value')::bigint,
    (v_source_sequence->>'is_called')::boolean
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

  if (v_target_manifest - 'read_only') <> (v_run.source_manifest - 'read_only') then
    raise exception using
      errcode = '55000',
      message = 'target manifest does not exactly match source after atomic copy';
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

create function private.connector_cutover_cleanup(
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
     or (v_run.target_manifest - 'read_only') <> (v_run.source_manifest - 'read_only') then
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
