-- Add exact whole-table unpaid totals to the existing guest menu response.
-- The detailed current_orders list remains capped at 20 rows; these totals are
-- calculated independently across every submitted/accepted, unfinalized order.
-- This is a response-only change and does not mutate existing business rows.

create or replace function public.internal_qr_get_menu(p_token_hash text)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_table public.qr_tables%rowtype;
  v_items jsonb;
  v_current_orders jsonb;
  v_current_orders_truncated boolean;
  v_current_total_usd numeric;
  v_current_total_vnd numeric;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'invalid table token';
  end if;

  select t.*
  into v_table
  from public.qr_tables as t
  join private.qr_table_tokens as tokens on tokens.table_id = t.id
  where tokens.token_hash = p_token_hash
    and t.is_active = true;

  if not found then
    raise exception using errcode = '22023', message = 'invalid or inactive table token';
  end if;

  if not public.internal_qr_take_rate_limit(
    private.qr_sha256('get_menu:table:' || p_token_hash),
    300,
    60
  ) then
    raise exception using errcode = 'P0001', message = 'QR rate limit exceeded';
  end if;

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', m.id,
        'type', m.type,
        'ko_name', m.ko_name,
        'vi_name', m.vi_name,
        'en_name', m.en_name,
        'description_ko', m.description_ko,
        'description_vi', m.description_vi,
        'description_en', m.description_en,
        'price_usd', m.price_usd,
        'price_vnd', m.price_vnd,
        'image_url', m.image_url,
        'qr_category', m.qr_category,
        'is_active', m.is_active,
        'is_orderable', m.is_orderable,
        'is_sold_out', m.is_sold_out,
        'requires_preorder', m.requires_preorder,
        'sort_order', m.sort_order
      ) order by coalesce(m.sort_order, 2147483647), m.type, m.ko_name
    ),
    '[]'::jsonb
  )
  into v_items
  from public.menu_items as m
  where m.is_active = true;

  -- Keep the response-size bounds from the previous definition. Totals below
  -- deliberately do not reuse this limited result set.
  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'order_number', pg_catalog.upper(pg_catalog.right(open_order.id::text, 8)),
        'status', open_order.status,
        'total_usd', open_order.total_usd,
        'total_vnd', open_order.total_vnd,
        'submitted_at', open_order.submitted_at,
        'accepted_at', open_order.accepted_at,
        'items', coalesce((
          select pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'menu_type', line.menu_type,
              'ko_name', line.ko_name,
              'vi_name', line.vi_name,
              'en_name', line.en_name,
              'qty', line.qty,
              'unit_usd', line.unit_usd,
              'unit_vnd', line.unit_vnd,
              'line_usd', line.line_usd,
              'line_vnd', line.line_vnd
            ) order by line.created_at, line.id
          )
          from (
            select
              item.id,
              item.menu_type,
              item.ko_name,
              item.vi_name,
              item.en_name,
              item.qty,
              item.unit_usd,
              item.unit_vnd,
              item.line_usd,
              item.line_vnd,
              item.created_at
            from public.qr_order_items as item
            where item.qr_order_id = open_order.id
            order by item.created_at, item.id
            limit 40
          ) as line
        ), '[]'::jsonb)
      ) order by open_order.submitted_at, open_order.id
    ),
    '[]'::jsonb
  )
  into v_current_orders
  from (
    select
      qr_order.id,
      qr_order.status,
      qr_order.total_usd,
      qr_order.total_vnd,
      qr_order.submitted_at,
      qr_order.accepted_at
    from public.qr_orders as qr_order
    where qr_order.table_id = v_table.id
      and qr_order.status in ('submitted', 'accepted')
      and qr_order.finalized_order_id is null
    order by qr_order.submitted_at desc, qr_order.id desc
    limit 20
  ) as open_order;

  select exists (
    select 1
    from public.qr_orders as extra_order
    where extra_order.table_id = v_table.id
      and extra_order.status in ('submitted', 'accepted')
      and extra_order.finalized_order_id is null
    order by extra_order.submitted_at desc, extra_order.id desc
    offset 20
    limit 1
  )
  into v_current_orders_truncated;

  -- Cast before SUM so the aggregate cannot overflow a per-order integer.
  -- PostgreSQL sums bigint inputs as exact numeric values, and COALESCE keeps
  -- an empty table's wire value numeric zero rather than JSON null.
  select
    coalesce(pg_catalog.sum(qr_order.total_usd::bigint), 0),
    coalesce(pg_catalog.sum(qr_order.total_vnd::bigint), 0)
  into v_current_total_usd, v_current_total_vnd
  from public.qr_orders as qr_order
  where qr_order.table_id = v_table.id
    and qr_order.status in ('submitted', 'accepted')
    and qr_order.finalized_order_id is null;

  return pg_catalog.jsonb_build_object(
    'table', pg_catalog.jsonb_build_object(
      'id', v_table.id,
      'label', v_table.label
    ),
    'categories', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'id', 'single', 'name_ko', '1인 메뉴',
        'name_en', 'Single serving', 'name_vi', 'Món 1 người', 'sort_order', 10
      ),
      pg_catalog.jsonb_build_object(
        'id', 'shared', 'name_ko', '2인 이상 메뉴',
        'name_en', 'For two or more', 'name_vi', 'Món cho 2 người trở lên', 'sort_order', 20
      ),
      pg_catalog.jsonb_build_object(
        'id', 'snack', 'name_ko', '술안주',
        'name_en', 'Dishes for drinks', 'name_vi', 'Món nhắm', 'sort_order', 30
      ),
      pg_catalog.jsonb_build_object(
        'id', 'preorder', 'name_ko', '사전 예약 메뉴',
        'name_en', 'Pre-order dishes', 'name_vi', 'Món đặt trước', 'sort_order', 40
      ),
      pg_catalog.jsonb_build_object(
        'id', 'drink', 'name_ko', '음료',
        'name_en', 'Drinks', 'name_vi', 'Đồ uống', 'sort_order', 50
      ),
      pg_catalog.jsonb_build_object(
        'id', 'cafe', 'name_ko', '커피 · 카페',
        'name_en', 'Coffee & cafe', 'name_vi', 'Cà phê & đồ uống', 'sort_order', 60
      )
    ),
    'items', v_items,
    'current_orders', v_current_orders,
    'current_orders_truncated', v_current_orders_truncated,
    'current_total_usd', v_current_total_usd,
    'current_total_vnd', v_current_total_vnd
  );
end;
$$;

-- Preserve the internal-only contract: the token hash RPC is reachable only
-- from the service-role Edge Function, never directly from browser roles.
revoke execute on function public.internal_qr_get_menu(text)
  from public, anon, authenticated, service_role;
grant execute on function public.internal_qr_get_menu(text)
  to service_role;

comment on function public.internal_qr_get_menu(text) is
  'Service-only hash-token menu lookup with exact whole-table unpaid totals, at most 20 unfinalized current orders, and at most 40 snapshot lines per returned order.';
