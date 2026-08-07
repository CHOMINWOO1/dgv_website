\set ON_ERROR_STOP on

-- Read-only, value-redacted cutover manifest.
--
-- Run this unchanged against both source and target. It emits exactly one JSON
-- object containing only row counts, SHA-256 digests, sequence state, and
-- integrity-violation fingerprints. No business value, credential, URL, or key
-- is returned. The transaction itself is READ ONLY as a second guard in addition
-- to the validator script's default_transaction_read_only connection option.
begin transaction isolation level repeatable read read only;
set local time zone 'UTC';
set local datestyle = 'ISO, YMD';
set local extra_float_digits = 3;

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
    )::text as row_json
  from public.menu_items as m

  union all

  select
    'orders',
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
    )::text
  from public.orders as o

  union all

  select
    'order_items',
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
    )::text
  from public.order_items as oi

  union all

  select
    'order_custom_items',
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
    )::text
  from public.order_custom_items as ci

  union all

  select
    'resv_groups',
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
    )::text
  from public.resv_groups as r

  union all

  select
    'notices',
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
    )::text
  from public.notices as n
),
business_row_hashes as (
  select
    r.table_name,
    r.sort_key,
    pg_catalog.encode(
      extensions.digest(
        pg_catalog.convert_to(r.row_json, 'UTF8'),
        'sha256'
      ),
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
),
child_line_totals as (
  select
    lines.order_id,
    pg_catalog.sum(lines.line_usd)::bigint as total_usd,
    pg_catalog.sum(lines.line_vnd)::bigint as total_vnd
  from (
    select
      oi.order_id,
      oi.line_usd::bigint as line_usd,
      oi.line_vnd::bigint as line_vnd
    from public.order_items as oi

    union all

    select
      ci.order_id,
      ci.line_usd::bigint,
      ci.line_vnd::bigint
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
  select
    'order_items_order_orphan'::text as check_name,
    oi.id::text as row_key
  from public.order_items as oi
  left join public.orders as o on o.id = oi.order_id
  where o.id is null

  union all

  select
    'order_items_menu_orphan',
    oi.id::text
  from public.order_items as oi
  left join public.menu_items as m on m.id = oi.menu_item_id
  where oi.menu_item_id is not null
    and m.id is null

  union all

  select
    'order_custom_items_order_orphan',
    ci.id::text
  from public.order_custom_items as ci
  left join public.orders as o on o.id = ci.order_id
  where o.id is null

  union all

  select
    'reservation_confirmed_order_orphan',
    r.id::text
  from public.resv_groups as r
  left join public.orders as o on o.id = r.confirmed_order_id
  where r.confirmed_order_id is not null
    and o.id is null

  union all

  select
    'reservation_confirmation_state_invalid',
    r.id::text
  from public.resv_groups as r
  where (
    r.confirmed = true
    and (r.confirmed_at is null or r.confirmed_order_id is null)
  ) or (
    r.confirmed = false
    and (r.confirmed_at is not null or r.confirmed_order_id is not null)
  )

  union all

  select
    'reservation_link_wrong_order_source',
    r.id::text
  from public.resv_groups as r
  join public.orders as o on o.id = r.confirmed_order_id
  where r.confirmed = true
    and o.source is distinct from 'reservation_confirm'

  union all

  select
    'reservation_link_group_item_count_invalid',
    r.id::text
  from public.resv_groups as r
  where r.confirmed = true
    and r.confirmed_order_id is not null
    and (
      exists (
        select 1
        from public.order_items as oi
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

  select
    'reservation_link_amount_invalid',
    r.id::text
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

  select
    'reservation_order_link_reused',
    r.confirmed_order_id::text
  from public.resv_groups as r
  where r.confirmed_order_id is not null
  group by r.confirmed_order_id
  having pg_catalog.count(*) > 1

  union all

  select
    'order_item_line_amount_mismatch',
    oi.id::text
  from public.order_items as oi
  where oi.line_usd::bigint <> oi.qty::bigint * oi.unit_usd::bigint
     or oi.line_vnd::bigint <> oi.qty::bigint * oi.unit_vnd::bigint

  union all

  select
    'order_custom_item_line_amount_mismatch',
    ci.id::text
  from public.order_custom_items as ci
  where ci.line_usd::bigint <> ci.qty::bigint * ci.unit_usd::bigint
     or ci.line_vnd::bigint <> ci.qty::bigint * ci.unit_vnd::bigint

  union all

  select
    'order_total_amount_mismatch',
    o.id::text
  from public.orders as o
  left join child_line_totals as totals on totals.order_id = o.id
  where o.total_usd::bigint <> coalesce(totals.total_usd, 0)
     or o.total_vnd::bigint <> coalesce(totals.total_vnd, 0)

  union all

  select
    'menu_negative_amount',
    m.id::text
  from public.menu_items as m
  where m.price_usd < 0 or m.price_vnd < 0

  union all

  select
    'order_negative_amount',
    o.id::text
  from public.orders as o
  where o.total_usd < 0 or o.total_vnd < 0

  union all

  select
    'order_item_nonpositive_or_negative_amount',
    oi.id::text
  from public.order_items as oi
  where oi.qty <= 0
     or oi.unit_usd < 0
     or oi.unit_vnd < 0
     or oi.line_usd < 0
     or oi.line_vnd < 0

  union all

  select
    'order_custom_item_nonpositive_or_negative_amount',
    ci.id::text
  from public.order_custom_items as ci
  where ci.qty <= 0
     or ci.unit_usd < 0
     or ci.unit_vnd < 0
     or ci.line_usd < 0
     or ci.line_vnd < 0

  union all

  select
    'reservation_nonpositive_or_negative_amount',
    r.id::text
  from public.resv_groups as r
  where r.guests_count <= 0
     or r.price < 0
),
integrity_issue_hashes as (
  select
    i.check_name,
    i.row_key,
    pg_catalog.encode(
      extensions.digest(
        pg_catalog.convert_to(i.row_key, 'UTF8'),
        'sha256'
      ),
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
),
reservation_max_id as (
  select pg_catalog.max(r.id)::bigint as max_id
  from public.resv_groups as r
),
reservation_sequence_state as (
  select
    s.last_value::bigint as last_value,
    s.is_called,
    case
      when s.is_called then s.last_value::bigint + 1
      else s.last_value::bigint
    end as next_value,
    m.max_id,
    case
      when m.max_id is null then true
      when s.is_called then s.last_value::bigint + 1 > m.max_id
      else s.last_value::bigint > m.max_id
    end as next_value_safe
  from public.resv_groups_id_seq as s
  cross join reservation_max_id as m
),
table_manifest as (
  select pg_catalog.jsonb_object_agg(
    t.table_name,
    pg_catalog.jsonb_build_object(
      'row_count', t.row_count,
      'checksum', t.checksum
    )
    order by t.table_name
  ) as value
  from table_signatures as t
),
integrity_manifest as (
  select pg_catalog.jsonb_object_agg(
    i.check_name,
    pg_catalog.jsonb_build_object(
      'violation_count', i.violation_count,
      'checksum', i.checksum
    )
    order by i.check_name
  ) as value
  from integrity_signatures as i
),
database_contract as (
  select
    (pg_catalog.current_setting('server_version_num')::integer / 10000)
      as server_major,
    pg_catalog.current_setting('server_encoding') as server_encoding,
    d.datcollate as lc_collate,
    d.datctype as lc_ctype,
    d.datlocprovider::text as locale_provider,
    d.datlocale as locale
  from pg_catalog.pg_database as d
  where d.datname = pg_catalog.current_database()
)
select pg_catalog.jsonb_build_object(
  'contract_version', 1,
  'read_only', pg_catalog.current_setting('transaction_read_only') = 'on',
  'database_contract', (
    select pg_catalog.jsonb_build_object(
      'server_major', d.server_major,
      'server_encoding', d.server_encoding,
      'lc_collate', d.lc_collate,
      'lc_ctype', d.lc_ctype,
      'locale_provider', d.locale_provider,
      'locale', d.locale
    )
    from database_contract as d
  ),
  'tables', (select value from table_manifest),
  'sequence', (
    select pg_catalog.jsonb_build_object(
      'name', 'public.resv_groups_id_seq',
      'last_value', s.last_value,
      'is_called', s.is_called,
      'next_value', s.next_value,
      'max_id', s.max_id,
      'next_value_safe', s.next_value_safe
    )
    from reservation_sequence_state as s
  ),
  'integrity', (select value from integrity_manifest)
)::text;

commit;
