\set ON_ERROR_STOP on

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_catalog;
set local time zone 'UTC';
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","app_metadata":{"role":"admin"}}';

select plan(22);

select has_function(
  'public',
  'app_finalize_qr_table_orders_checked',
  array['uuid', 'jsonb', 'text', 'text', 'text'],
  'table checkout RPC exists'
);

select ok(
  not exists (
    select 1
    from pg_catalog.pg_constraint as constraint_row
    where constraint_row.conrelid = 'public.qr_orders'::regclass
      and constraint_row.contype = 'u'
      and constraint_row.conname = 'qr_orders_finalized_order_id_key'
  ),
  'many QR orders may reference one finalized paid order'
);

select ok(
  exists (
    select 1
    from pg_catalog.pg_class as index_row
    join pg_catalog.pg_index as index_meta on index_meta.indexrelid = index_row.oid
    where index_row.oid = 'public.qr_orders_voided_order_id_idx'::regclass
      and index_meta.indisunique = false
  ),
  'multiple QR audit tombstones may retain the same deleted paid order id'
);

insert into public.menu_items (
  id, type, ko_name, vi_name, en_name, price_usd, price_vnd,
  is_active, is_orderable, is_sold_out, requires_preorder, sort_order, created_at
)
values
  (
    '81000000-0000-4000-8000-000000000001', 'test', '[TEST] first', '[TEST] first', '[TEST] first',
    101, 12345, true, true, false, false, 1, now()
  ),
  (
    '81000000-0000-4000-8000-000000000002', 'test', '[TEST] second', '[TEST] second', '[TEST] second',
    200, 20000, true, true, false, false, 2, now()
  ),
  (
    '81000000-0000-4000-8000-000000000003', 'test', '[TEST] pending', '[TEST] pending', '[TEST] pending',
    50, 50000, true, true, false, false, 3, now()
  );

insert into public.qr_tables (id, label, is_active, created_at, updated_at)
values (
  '82000000-0000-4000-8000-000000000001',
  '[TEST] table checkout',
  true,
  now(),
  now()
);

insert into private.qr_table_tokens (table_id, token_hash, rotated_at)
values (
  '82000000-0000-4000-8000-000000000001',
  'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  now()
);

insert into public.qr_orders (
  id, table_id, client_request_id, request_hash, status, note,
  total_usd, total_vnd, submitted_at, updated_at, accepted_at
)
values
  (
    '83000000-0000-4000-8000-000000000001',
    '82000000-0000-4000-8000-000000000001',
    '84000000-0000-4000-8000-000000000001',
    '1111111111111111111111111111111111111111111111111111111111111111',
    'accepted', null, 101, 12345,
    '2099-01-01 00:00:00+00', '2099-01-01 00:00:01+00', '2099-01-01 00:00:01+00'
  ),
  (
    '83000000-0000-4000-8000-000000000002',
    '82000000-0000-4000-8000-000000000001',
    '84000000-0000-4000-8000-000000000002',
    '2222222222222222222222222222222222222222222222222222222222222222',
    'accepted', null, 200, 20000,
    '2099-01-01 00:01:00+00', '2099-01-01 00:01:01+00', '2099-01-01 00:01:01+00'
  ),
  (
    '83000000-0000-4000-8000-000000000003',
    '82000000-0000-4000-8000-000000000001',
    '84000000-0000-4000-8000-000000000003',
    '3333333333333333333333333333333333333333333333333333333333333333',
    'submitted', null, 50, 50000,
    '2099-01-01 00:02:00+00', '2099-01-01 00:02:01+00', null
  );

insert into public.qr_order_items (
  id, qr_order_id, menu_item_id, qty, menu_type, ko_name, vi_name, en_name,
  unit_usd, unit_vnd, line_usd, line_vnd, created_at
)
values
  (
    '85000000-0000-4000-8000-000000000001',
    '83000000-0000-4000-8000-000000000001',
    '81000000-0000-4000-8000-000000000001',
    1, 'test', '[TEST] first', '[TEST] first', '[TEST] first',
    101, 12345, 101, 12345, '2099-01-01 00:00:02+00'
  ),
  (
    '85000000-0000-4000-8000-000000000002',
    '83000000-0000-4000-8000-000000000002',
    '81000000-0000-4000-8000-000000000002',
    1, 'test', '[TEST] second', '[TEST] second', '[TEST] second',
    200, 20000, 200, 20000, '2099-01-01 00:01:02+00'
  ),
  (
    '85000000-0000-4000-8000-000000000003',
    '83000000-0000-4000-8000-000000000003',
    '81000000-0000-4000-8000-000000000003',
    1, 'test', '[TEST] pending', '[TEST] pending', '[TEST] pending',
    50, 50000, 50, 50000, '2099-01-01 00:02:02+00'
  );

select throws_ok(
  $query$
    select public.app_finalize_qr_table_orders_checked(
      '82000000-0000-4000-8000-000000000001',
      '[
        {"id":"83000000-0000-4000-8000-000000000001","updated_at":"2099-01-01T00:00:01Z"},
        {"id":"83000000-0000-4000-8000-000000000002","updated_at":"2099-01-01T00:01:01Z"}
      ]'::jsonb,
      'cash', null, null
    )
  $query$,
  '55000',
  'unconfirmed QR orders remain for this table',
  'a submitted order blocks whole-table payment'
);

update public.qr_orders
set status = 'cancelled',
    cancelled_at = '2099-01-01 00:03:00+00',
    updated_at = '2099-01-01 00:03:00+00'
where id = '83000000-0000-4000-8000-000000000003';

select throws_ok(
  $query$
    select public.app_finalize_qr_table_orders_checked(
      '82000000-0000-4000-8000-000000000001',
      '[{"id":"83000000-0000-4000-8000-000000000001","updated_at":"2099-01-01T00:00:01Z"}]'::jsonb,
      'cash', null, null
    )
  $query$,
  '55000',
  'QR table orders changed after checkout was opened; reload before payment',
  'a proper subset cannot be paid while another accepted order remains'
);

select throws_ok(
  $query$
    select public.app_finalize_qr_table_orders_checked(
      '82000000-0000-4000-8000-000000000001',
      '[
        {"id":"83000000-0000-4000-8000-000000000001","updated_at":"2099-01-01T00:00:01Z"},
        {"id":"83000000-0000-4000-8000-000000000002","updated_at":"2099-01-01T00:01:09Z"}
      ]'::jsonb,
      'cash', null, null
    )
  $query$,
  '55000',
  'QR table orders changed after checkout was opened; reload before payment',
  'a stale updated_at prevents payment'
);

create temporary table checkout_result (paid_order_id uuid primary key) on commit drop;

insert into checkout_result (paid_order_id)
select public.app_finalize_qr_table_orders_checked(
  '82000000-0000-4000-8000-000000000001',
  '[
    {"id":"83000000-0000-4000-8000-000000000001","updated_at":"2099-01-01T00:00:01Z"},
    {"id":"83000000-0000-4000-8000-000000000002","updated_at":"2099-01-01T00:01:01Z"}
  ]'::jsonb,
  'card_fee7',
  '[TEST] guide',
  '[TEST] team'
);

select is(
  (select pg_catalog.count(*)::integer from checkout_result),
  1,
  'whole-table payment creates one result id'
);

select is(
  (
    select pg_catalog.count(*)::integer
    from public.orders as paid_order
    where paid_order.id = (select paid_order_id from checkout_result)
  ),
  1,
  'whole-table payment creates exactly one paid ledger row'
);

select is(
  (
    select pg_catalog.jsonb_build_array(
      paid_order.source,
      paid_order.status,
      paid_order.payment_method,
      paid_order.total_usd,
      paid_order.total_vnd,
      paid_order.guide_name,
      paid_order.team_no
    )
    from public.orders as paid_order
    where paid_order.id = (select paid_order_id from checkout_result)
  ),
  '["qr_table", "paid", "card", 322, 35000, "[TEST] guide", "[TEST] team"]'::jsonb,
  'card fee is applied once to the combined subtotal using calc rounding'
);

select is(
  (
    select pg_catalog.jsonb_build_object(
      'line_count', pg_catalog.count(*),
      'fee', pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_array(line.kind, line.line_usd, line.line_vnd)
        order by line.kind
      ) filter (where line.kind = 'fee7')
    )
    from public.order_custom_items as line
    where line.order_id = (select paid_order_id from checkout_result)
  ),
  '{"line_count": 3, "fee": [["fee7", 21, 2655]]}'::jsonb,
  'both snapshots and one combined card fee line are retained'
);

select is(
  (
    select pg_catalog.jsonb_build_object(
      'count', pg_catalog.count(*),
      'paid_ids', pg_catalog.count(distinct qr_order.finalized_order_id),
      'choices', pg_catalog.count(distinct qr_order.finalized_payment_choice)
    )
    from public.qr_orders as qr_order
    where qr_order.id in (
      '83000000-0000-4000-8000-000000000001',
      '83000000-0000-4000-8000-000000000002'
    )
      and qr_order.finalized_order_id = (select paid_order_id from checkout_result)
      and qr_order.finalized_payment_choice = 'card_fee7'
  ),
  '{"count": 2, "choices": 1, "paid_ids": 1}'::jsonb,
  'all accepted QR orders point at the same paid order and payment choice'
);

select is(
  (
    select pg_catalog.jsonb_build_object(
      'order_count', pg_catalog.jsonb_array_length(guest_menu.payload -> 'current_orders'),
      'total_usd', guest_menu.payload -> 'current_total_usd',
      'total_vnd', guest_menu.payload -> 'current_total_vnd'
    )
    from (
      select public.internal_qr_get_menu(
        'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
      ) as payload
    ) as guest_menu
  ),
  '{"order_count": 0, "total_usd": 0, "total_vnd": 0}'::jsonb,
  'guest current orders and whole-table totals clear immediately after payment'
);

select is(
  public.app_finalize_qr_table_orders_checked(
    '82000000-0000-4000-8000-000000000001',
    '[
      {"id":"83000000-0000-4000-8000-000000000001","updated_at":"2099-01-01T00:00:01Z"},
      {"id":"83000000-0000-4000-8000-000000000002","updated_at":"2099-01-01T00:01:01Z"}
    ]'::jsonb,
    'card_fee7',
    '[TEST] guide',
    '[TEST] team'
  ),
  (select paid_order_id from checkout_result),
  'an exact network retry returns the original paid order id'
);

select is(
  (
    select pg_catalog.count(*)::integer
    from public.orders as paid_order
    where paid_order.source = 'qr_table'
      and paid_order.guide_name = '[TEST] guide'
  ),
  1,
  'an idempotent retry does not create a duplicate sale'
);

select throws_ok(
  $query$
    select public.app_finalize_qr_table_orders_checked(
      '82000000-0000-4000-8000-000000000001',
      '[
        {"id":"83000000-0000-4000-8000-000000000001","updated_at":"2099-01-01T00:00:01Z"},
        {"id":"83000000-0000-4000-8000-000000000002","updated_at":"2099-01-01T00:01:01Z"}
      ]'::jsonb,
      'cash', '[TEST] guide', '[TEST] team'
    )
  $query$,
  '55000',
  'QR table was already finalized with different payment details',
  'a retry cannot change payment details'
);

select is(
  public.app_delete_order((select paid_order_id from checkout_result)),
  true,
  'admin safe-delete accepts a consolidated paid order'
);

select is(
  (
    select pg_catalog.count(*)::integer
    from public.orders as paid_order
    where paid_order.id = (select paid_order_id from checkout_result)
  ),
  0,
  'safe-delete removes the paid ledger row'
);

select is(
  (
    select pg_catalog.count(*)::integer
    from public.qr_orders as qr_order
    where qr_order.id in (
      '83000000-0000-4000-8000-000000000001',
      '83000000-0000-4000-8000-000000000002'
    )
      and qr_order.status = 'cancelled'
      and qr_order.finalized_order_id is null
      and qr_order.finalized_at is null
      and qr_order.voided_order_id = (select paid_order_id from checkout_result)
      and qr_order.voided_at is not null
  ),
  2,
  'safe-delete tombstones every contributing QR order'
);

select is(
  (
    select pg_catalog.count(*)::integer
    from public.qr_order_items as item
    where item.qr_order_id in (
      '83000000-0000-4000-8000-000000000001',
      '83000000-0000-4000-8000-000000000002'
    )
  ),
  2,
  'safe-delete preserves every QR item snapshot'
);

insert into public.qr_tables (id, label, is_active, created_at, updated_at)
values (
  '82000000-0000-4000-8000-000000000002',
  '[TEST] single order',
  true,
  now(),
  now()
);

insert into public.qr_orders (
  id, table_id, client_request_id, request_hash, status,
  total_usd, total_vnd, submitted_at, updated_at, accepted_at
)
values (
  '83000000-0000-4000-8000-000000000004',
  '82000000-0000-4000-8000-000000000002',
  '84000000-0000-4000-8000-000000000004',
  '4444444444444444444444444444444444444444444444444444444444444444',
  'accepted', 50, 50000,
  '2099-01-02 00:00:00+00', '2099-01-02 00:00:01+00', '2099-01-02 00:00:01+00'
);

insert into public.qr_order_items (
  id, qr_order_id, menu_item_id, qty, menu_type, ko_name, vi_name, en_name,
  unit_usd, unit_vnd, line_usd, line_vnd, created_at
)
values (
  '85000000-0000-4000-8000-000000000004',
  '83000000-0000-4000-8000-000000000004',
  '81000000-0000-4000-8000-000000000003',
  1, 'test', '[TEST] pending', '[TEST] pending', '[TEST] pending',
  50, 50000, 50, 50000, '2099-01-02 00:00:02+00'
);

create temporary table single_checkout_result (paid_order_id uuid primary key) on commit drop;

insert into single_checkout_result (paid_order_id)
select public.app_finalize_qr_table_orders_checked(
  '82000000-0000-4000-8000-000000000002',
  '[{"id":"83000000-0000-4000-8000-000000000004","updated_at":"2099-01-02T00:00:01Z"}]'::jsonb,
  'cash', null, null
);

select is(
  (
    select pg_catalog.jsonb_build_array(
      paid_order.total_usd,
      paid_order.total_vnd,
      paid_order.payment_method
    )
    from public.orders as paid_order
    where paid_order.id = (select paid_order_id from single_checkout_result)
  ),
  '[50, 50000, "cash"]'::jsonb,
  'a table with one accepted QR order remains compatible'
);

select is(
  (
    select qr_order.finalized_order_id
    from public.qr_orders as qr_order
    where qr_order.id = '83000000-0000-4000-8000-000000000004'
  ),
  (select paid_order_id from single_checkout_result),
  'single-order compatibility still records its paid ledger link'
);

-- The response list is intentionally bounded, but its totals must cover every
-- current row and exclude cancelled or already-finalized rows.
insert into public.qr_tables (id, label, is_active, created_at, updated_at)
values (
  '82000000-0000-4000-8000-000000000003',
  '[TEST] guest whole-table total',
  true,
  now(),
  now()
);

insert into private.qr_table_tokens (table_id, token_hash, rotated_at)
values (
  '82000000-0000-4000-8000-000000000003',
  'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  now()
);

insert into public.qr_orders (
  id, table_id, client_request_id, request_hash, status,
  total_usd, total_vnd, submitted_at, updated_at, accepted_at
)
select
  ('86000000-0000-4000-8000-' || pg_catalog.lpad(series.value::text, 12, '0'))::uuid,
  '82000000-0000-4000-8000-000000000003'::uuid,
  ('87000000-0000-4000-8000-' || pg_catalog.lpad(series.value::text, 12, '0'))::uuid,
  pg_catalog.repeat(pg_catalog.lpad(pg_catalog.to_hex(series.value), 2, '0'), 32),
  case when series.value % 2 = 0 then 'submitted' else 'accepted' end,
  series.value,
  series.value * 1000,
  '2099-02-01 00:00:00+00'::timestamp with time zone
    + series.value * interval '1 minute',
  '2099-02-01 00:00:00+00'::timestamp with time zone
    + series.value * interval '1 minute',
  case when series.value % 2 = 1 then
    '2099-02-01 00:00:00+00'::timestamp with time zone
      + series.value * interval '1 minute'
  end
from pg_catalog.generate_series(1, 21) as series(value);

insert into public.qr_orders (
  id, table_id, client_request_id, request_hash, status,
  total_usd, total_vnd, submitted_at, updated_at, accepted_at,
  cancelled_at, finalized_at, finalized_order_id
)
values
  (
    '86000000-0000-4000-8000-000000000022',
    '82000000-0000-4000-8000-000000000003',
    '87000000-0000-4000-8000-000000000022',
    pg_catalog.repeat('16', 32),
    'cancelled', 999999, 999999000,
    '2099-02-01 00:22:00+00', '2099-02-01 00:22:00+00', null,
    '2099-02-01 00:22:00+00', null, null
  ),
  (
    '86000000-0000-4000-8000-000000000023',
    '82000000-0000-4000-8000-000000000003',
    '87000000-0000-4000-8000-000000000023',
    pg_catalog.repeat('17', 32),
    'accepted', 888888, 888888000,
    '2099-02-01 00:23:00+00', '2099-02-01 00:23:00+00',
    '2099-02-01 00:23:00+00', null,
    '2099-02-01 00:23:00+00',
    (select paid_order_id from single_checkout_result)
  );

select is(
  (
    select pg_catalog.jsonb_build_object(
      'order_count', pg_catalog.jsonb_array_length(guest_menu.payload -> 'current_orders'),
      'truncated', guest_menu.payload -> 'current_orders_truncated',
      'total_usd', guest_menu.payload -> 'current_total_usd',
      'total_vnd', guest_menu.payload -> 'current_total_vnd'
    )
    from (
      select public.internal_qr_get_menu(
        'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
      ) as payload
    ) as guest_menu
  ),
  '{"order_count": 20, "truncated": true, "total_usd": 231, "total_vnd": 231000}'::jsonb,
  'guest totals include all 21 unpaid rows while the list stays capped at 20'
);

select * from finish();
rollback;
