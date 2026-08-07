-- READ ONLY connector chunk template. Replace only the five __DGV_*__ tokens
-- with the validated values produced by scripts/connector-cutover-contract.mjs.
begin transaction isolation level repeatable read read only;
set local time zone 'UTC';
set local datestyle = 'ISO, YMD';
set local extra_float_digits = 3;

with
input as (
  select
    '__DGV_TRANSFER_ID__'::uuid as transfer_id,
    '__DGV_TABLE_NAME__'::text as table_name,
    __DGV_CHUNK_NO__::integer as chunk_no,
    __DGV_AFTER_KEY_SQL__ as after_key,
    __DGV_LIMIT__::integer as row_limit
),
business_rows as (
  select
    m.id::text as sort_key,
    pg_catalog.jsonb_build_array(
      m.type,
      m.id::text,
      m.ko_name,
      m.vi_name,
      m.price_usd,
      m.price_vnd,
      m.is_active,
      m.sort_order,
      case when m.created_at is null then null else pg_catalog.to_char(
        m.created_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ) end
    ) as row_value
  from public.menu_items as m
  cross join input as i
  where i.table_name = 'menu_items'
    and (i.after_key is null or m.id::text collate "C" > i.after_key collate "C")

  union all

  select
    o.id::text,
    pg_catalog.jsonb_build_array(
      o.sales_excluded,
      o.total_usd,
      o.total_vnd,
      o.id::text,
      pg_catalog.to_char(
        o.created_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ),
      o.source,
      o.status,
      o.guide_name,
      o.team_no,
      o.payment_method
    )
  from public.orders as o
  cross join input as i
  where i.table_name = 'orders'
    and (i.after_key is null or o.id::text collate "C" > i.after_key collate "C")

  union all

  select
    oi.id::text,
    pg_catalog.jsonb_build_array(
      oi.order_id::text,
      oi.qty,
      oi.unit_usd,
      oi.unit_vnd,
      oi.line_usd,
      oi.line_vnd,
      oi.id::text,
      oi.menu_item_id::text,
      oi.is_custom,
      oi.custom_ko_name,
      oi.custom_vi_name
    )
  from public.order_items as oi
  cross join input as i
  where i.table_name = 'order_items'
    and (i.after_key is null or oi.id::text collate "C" > i.after_key collate "C")

  union all

  select
    ci.id::text,
    pg_catalog.jsonb_build_array(
      ci.id::text,
      ci.kind,
      ci.order_id::text,
      ci.ko_name,
      ci.vi_name,
      ci.qty,
      ci.unit_usd,
      ci.unit_vnd,
      ci.line_usd,
      ci.line_vnd,
      pg_catalog.to_char(
        ci.created_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      )
    )
  from public.order_custom_items as ci
  cross join input as i
  where i.table_name = 'order_custom_items'
    and (i.after_key is null or ci.id::text collate "C" > i.after_key collate "C")

  union all

  select
    r.id::text,
    pg_catalog.jsonb_build_array(
      r.id,
      r.res_date::text,
      pg_catalog.to_char(r.res_time, 'HH24:MI:SS.US'),
      r.guests_count,
      r.price,
      r.menu_ko,
      r.menu_vi,
      r.note,
      r.branch,
      r.guide_name,
      pg_catalog.to_char(
        r.created_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ),
      r.confirmed,
      case when r.confirmed_at is null then null else pg_catalog.to_char(
        r.confirmed_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ) end,
      r.confirmed_order_id::text
    )
  from public.resv_groups as r
  cross join input as i
  where i.table_name = 'resv_groups'
    and (i.after_key is null or r.id::text collate "C" > i.after_key collate "C")

  union all

  select
    n.id::text,
    pg_catalog.jsonb_build_array(
      n.title,
      n.body,
      n.author,
      n.id::text,
      pg_catalog.to_char(
        n.created_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ),
      pg_catalog.to_char(
        n.updated_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      )
    )
  from public.notices as n
  cross join input as i
  where i.table_name = 'notices'
    and (i.after_key is null or n.id::text collate "C" > i.after_key collate "C")
),
lookahead as (
  select r.sort_key, r.row_value
  from business_rows as r
  order by r.sort_key collate "C"
  limit (select i.row_limit + 1 from input as i)
),
selected as (
  select r.sort_key, r.row_value
  from lookahead as r
  order by r.sort_key collate "C"
  limit (select i.row_limit from input as i)
),
envelope as (
  select pg_catalog.jsonb_build_object(
    'contract_version', 1,
    'transfer_id', i.transfer_id,
    'table_name', i.table_name,
    'chunk_no', i.chunk_no,
    'after_key', i.after_key,
    'complete', (select pg_catalog.count(*) from lookahead) <= i.row_limit,
    'rows', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'key', s.sort_key,
          'values', s.row_value
        ) order by s.sort_key collate "C"
      )
      from selected as s
    ), '[]'::jsonb)
  ) as value
  from input as i
),
payload as (
  select
    e.value,
    pg_catalog.convert_to(e.value::text, 'UTF8') as bytes
  from envelope as e
)
select pg_catalog.jsonb_build_object(
  'contract_version', 1,
  'read_only', pg_catalog.current_setting('transaction_read_only') = 'on',
  'transfer_id', p.value->>'transfer_id',
  'table_name', p.value->>'table_name',
  'chunk_no', (p.value->>'chunk_no')::integer,
  'after_key', p.value->>'after_key',
  'last_key', (
    select s.sort_key from selected as s order by s.sort_key collate "C" desc limit 1
  ),
  'complete', (p.value->>'complete')::boolean,
  'row_count', pg_catalog.jsonb_array_length(p.value->'rows'),
  'raw_bytes', pg_catalog.octet_length(p.bytes),
  'payload_sha256', pg_catalog.encode(extensions.digest(p.bytes, 'sha256'), 'hex'),
  'payload_base64', pg_catalog.encode(p.bytes, 'base64')
)::text
from payload as p;

commit;
