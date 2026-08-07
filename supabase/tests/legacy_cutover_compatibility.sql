\set ON_ERROR_STOP on

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_catalog;
set local time zone 'UTC';
set local request.jwt.claims = '{"app_metadata":{"role":"admin"}}';

select plan(28);

-- Reapply the DDL-only compatibility migration inside this rollback-only test
-- and prove that every business row plus the reservation identity sequence is
-- byte-for-byte equivalent in the same transaction snapshot.
create temporary table migration_business_before (
  object_name text primary key,
  value_snapshot jsonb not null
) on commit drop;

insert into migration_business_before (object_name, value_snapshot)
select 'menu_items', coalesce(
  pg_catalog.jsonb_agg(pg_catalog.to_jsonb(m) order by m.id::text collate "C"),
  '[]'::jsonb
)
from public.menu_items as m
union all
select 'orders', coalesce(
  pg_catalog.jsonb_agg(pg_catalog.to_jsonb(o) order by o.id::text collate "C"),
  '[]'::jsonb
)
from public.orders as o
union all
select 'order_items', coalesce(
  pg_catalog.jsonb_agg(pg_catalog.to_jsonb(oi) order by oi.id::text collate "C"),
  '[]'::jsonb
)
from public.order_items as oi
union all
select 'order_custom_items', coalesce(
  pg_catalog.jsonb_agg(pg_catalog.to_jsonb(ci) order by ci.id::text collate "C"),
  '[]'::jsonb
)
from public.order_custom_items as ci
union all
select 'resv_groups', coalesce(
  pg_catalog.jsonb_agg(pg_catalog.to_jsonb(r) order by r.id),
  '[]'::jsonb
)
from public.resv_groups as r
union all
select 'notices', coalesce(
  pg_catalog.jsonb_agg(pg_catalog.to_jsonb(n) order by n.id::text collate "C"),
  '[]'::jsonb
)
from public.notices as n
union all
select 'resv_groups_id_seq', pg_catalog.jsonb_build_object(
  'last_value', s.last_value,
  'is_called', s.is_called
)
from public.resv_groups_id_seq as s;

\ir ../migrations/20260807151139_legacy_cutover_compatibility.sql

create temporary table migration_business_after (
  object_name text primary key,
  value_snapshot jsonb not null
) on commit drop;

insert into migration_business_after (object_name, value_snapshot)
select 'menu_items', coalesce(
  pg_catalog.jsonb_agg(pg_catalog.to_jsonb(m) order by m.id::text collate "C"),
  '[]'::jsonb
)
from public.menu_items as m
union all
select 'orders', coalesce(
  pg_catalog.jsonb_agg(pg_catalog.to_jsonb(o) order by o.id::text collate "C"),
  '[]'::jsonb
)
from public.orders as o
union all
select 'order_items', coalesce(
  pg_catalog.jsonb_agg(pg_catalog.to_jsonb(oi) order by oi.id::text collate "C"),
  '[]'::jsonb
)
from public.order_items as oi
union all
select 'order_custom_items', coalesce(
  pg_catalog.jsonb_agg(pg_catalog.to_jsonb(ci) order by ci.id::text collate "C"),
  '[]'::jsonb
)
from public.order_custom_items as ci
union all
select 'resv_groups', coalesce(
  pg_catalog.jsonb_agg(pg_catalog.to_jsonb(r) order by r.id),
  '[]'::jsonb
)
from public.resv_groups as r
union all
select 'notices', coalesce(
  pg_catalog.jsonb_agg(pg_catalog.to_jsonb(n) order by n.id::text collate "C"),
  '[]'::jsonb
)
from public.notices as n
union all
select 'resv_groups_id_seq', pg_catalog.jsonb_build_object(
  'last_value', s.last_value,
  'is_called', s.is_called
)
from public.resv_groups_id_seq as s;

select is(
  (
    select pg_catalog.jsonb_object_agg(b.object_name, b.value_snapshot)
    from migration_business_before as b
  ),
  (
    select pg_catalog.jsonb_object_agg(a.object_name, a.value_snapshot)
    from migration_business_after as a
  ),
  'reapplying compatibility migration changes no business row or identity sequence'
);

-- Fixed negative reservation IDs and reserved UUIDs make the fixtures
-- deterministic while avoiding any normal application identifier range.
select is(
  (
    select pg_catalog.count(*)
    from public.orders as o
    where o.id in (
      'f1474300-0000-4000-8000-000000000001'::uuid,
      'f1474300-0000-4000-8000-000000000002'::uuid,
      'f1474300-0000-4000-8000-000000000003'::uuid,
      'f1474300-0000-4000-8000-000000000004'::uuid,
      'f1474300-0000-4000-8000-000000000005'::uuid,
      'f1474300-0000-4000-8000-000000000006'::uuid
    )
  ) + (
    select pg_catalog.count(*)
    from public.resv_groups as r
    where r.id in (-91001, -91002, -91003, -91004, -91007)
  ) + (
    select pg_catalog.count(*)
    from public.order_custom_items as ci
    where ci.id in (
      'e1474300-0000-4000-8000-000000000002'::uuid,
      'e1474300-0000-4000-8000-000000000003'::uuid,
      'e1474300-0000-4000-8000-000000000004'::uuid,
      'e1474300-0000-4000-8000-000000000006'::uuid
    )
  ),
  0::bigint,
  'synthetic fixture identifiers are unused'
);

set local session_replication_role = replica;

insert into public.orders (
  id, created_at, source, status, total_usd, total_vnd,
  guide_name, team_no, payment_method, sales_excluded
)
values
  (
    'f1474300-0000-4000-8000-000000000002', '2099-01-02 01:00:00+00',
    'reservation_confirm', 'paid', 40, 1000000,
    '[TEST] safe special', 'S-2', 'cash', false
  ),
  (
    'f1474300-0000-4000-8000-000000000003', '2099-01-03 01:00:00+00',
    'reservation_confirm', 'paid', 40, 999999,
    '[TEST] near miss', 'S-3', 'cash', false
  ),
  (
    'f1474300-0000-4000-8000-000000000004', '2099-01-04 01:00:00+00',
    'reservation_confirm', 'paid', 0, 1250000,
    '[TEST] amount mismatch', 'S-4', 'bank', false
  ),
  (
    'f1474300-0000-4000-8000-000000000005', '2099-01-05 01:00:00+00',
    'calc_web', 'paid', 8, 200000,
    '[TEST] zero child old', 'Z-5', 'cash', true
  ),
  (
    'f1474300-0000-4000-8000-000000000006', '2099-01-06 01:00:00+00',
    'calc_web', 'paid', 1, 1000,
    '[TEST] nonempty old', 'N-6', 'cash', false
  );

insert into public.order_custom_items (
  id, order_id, kind, ko_name, vi_name, qty,
  unit_usd, unit_vnd, line_usd, line_vnd, created_at
)
values
  (
    'e1474300-0000-4000-8000-000000000002',
    'f1474300-0000-4000-8000-000000000002',
    'special', '[TEST] safe special', '[TEST] safe special vi', 5,
    8, 200000, 40, 1000000, '2099-01-02 01:00:00+00'
  ),
  (
    'e1474300-0000-4000-8000-000000000003',
    'f1474300-0000-4000-8000-000000000003',
    'special', '[TEST] near miss', '[TEST] near miss vi', 5,
    8, 200000, 40, 999999, '2099-01-03 01:00:00+00'
  ),
  (
    'e1474300-0000-4000-8000-000000000004',
    'f1474300-0000-4000-8000-000000000004',
    'group_resv', '[TEST] mismatched group', '[TEST] mismatched group vi', 5,
    0, 250000, 0, 1250000, '2099-01-04 01:00:00+00'
  ),
  (
    'e1474300-0000-4000-8000-000000000006',
    'f1474300-0000-4000-8000-000000000006',
    'special', '[TEST] existing child', '[TEST] existing child vi', 1,
    1, 1000, 1, 1000, '2099-01-06 01:00:00+00'
  );

insert into public.resv_groups (
  id, res_date, res_time, guests_count, price, menu_ko, menu_vi,
  note, branch, guide_name, created_at,
  confirmed, confirmed_at, confirmed_order_id
)
values
  (
    -91001, '2099-01-01', '18:00', 2, 100000,
    '[TEST] orphan', '[TEST] orphan vi', null, '[TEST] branch', '[TEST] guide',
    '2099-01-01 01:00:00+00', true, '2099-01-01 02:00:00+00',
    'f1474300-0000-4000-8000-000000000001'
  ),
  (
    -91002, '2099-01-02', '18:00', 5, 200000,
    '[TEST] safe special', '[TEST] safe special vi', null, '[TEST] branch', '[TEST] guide',
    '2099-01-02 01:00:00+00', true, '2099-01-02 02:00:00+00',
    'f1474300-0000-4000-8000-000000000002'
  ),
  (
    -91003, '2099-01-03', '18:00', 5, 200000,
    '[TEST] near miss', '[TEST] near miss vi', null, '[TEST] branch', '[TEST] guide',
    '2099-01-03 01:00:00+00', true, '2099-01-03 02:00:00+00',
    'f1474300-0000-4000-8000-000000000003'
  ),
  (
    -91004, '2099-01-04', '18:00', 5, 230000,
    '[TEST] mismatched group', '[TEST] mismatched group vi', null, '[TEST] branch', '[TEST] guide',
    '2099-01-04 01:00:00+00', true, '2099-01-04 02:00:00+00',
    'f1474300-0000-4000-8000-000000000004'
  ),
  (
    -91007, '2099-01-07', '18:00', 2, 100000,
    '[TEST] canonical', '[TEST] canonical vi', null, '[TEST] branch', '[TEST] guide',
    '2099-01-07 01:00:00+00', false, null, null
  );

set local session_replication_role = origin;

create temporary table case_snapshots (
  case_name text primary key,
  value_snapshot jsonb not null
) on commit drop;

insert into case_snapshots (case_name, value_snapshot)
select 'orphan-order-tables', pg_catalog.jsonb_build_object(
  'orders', coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(o) order by o.id::text collate "C")
    from public.orders as o
  ), '[]'::jsonb),
  'order_items', coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(oi) order by oi.id::text collate "C")
    from public.order_items as oi
  ), '[]'::jsonb),
  'order_custom_items', coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(ci) order by ci.id::text collate "C")
    from public.order_custom_items as ci
  ), '[]'::jsonb)
);

select throws_ok(
  $$select public.app_confirm_reservation(-91001, 'cash', '[TEST]')$$,
  '23514',
  'confirmed reservation references a missing or invalid order',
  'already-confirmed orphan never returns a bogus order UUID'
);

select is(
  public.app_unconfirm_reservation(-91001),
  true,
  'explicit unconfirm recovers an orphan reservation'
);

select is(
  (
    select pg_catalog.jsonb_build_array(r.confirmed, r.confirmed_at, r.confirmed_order_id)
    from public.resv_groups as r
    where r.id = -91001
  ),
  '[false, null, null]'::jsonb,
  'orphan recovery clears only confirmation state'
);

select is(
  (
    select value_snapshot
    from case_snapshots
    where case_name = 'orphan-order-tables'
  ),
  pg_catalog.jsonb_build_object(
    'orders', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(o) order by o.id::text collate "C")
      from public.orders as o
    ), '[]'::jsonb),
    'order_items', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(oi) order by oi.id::text collate "C")
      from public.order_items as oi
    ), '[]'::jsonb),
    'order_custom_items', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(ci) order by ci.id::text collate "C")
      from public.order_custom_items as ci
    ), '[]'::jsonb)
  ),
  'orphan recovery performs zero order and item DML'
);

select is(
  public.app_unconfirm_reservation(-91002),
  true,
  'exact single special legacy reservation order can be unconfirmed'
);

select is(
  (
    select pg_catalog.jsonb_build_array(r.confirmed, r.confirmed_at, r.confirmed_order_id)
    from public.resv_groups as r
    where r.id = -91002
  ),
  '[false, null, null]'::jsonb,
  'safe special unconfirm clears reservation link'
);

select is(
  (
    select (
      select pg_catalog.count(*) from public.orders
      where id = 'f1474300-0000-4000-8000-000000000002'
    ) + (
      select pg_catalog.count(*) from public.order_custom_items
      where order_id = 'f1474300-0000-4000-8000-000000000002'
    )
  ),
  0::bigint,
  'safe special unconfirm removes the linked order and its sole child'
);

insert into case_snapshots (case_name, value_snapshot)
select 'special-near-miss', pg_catalog.jsonb_build_object(
  'reservation', (
    select pg_catalog.to_jsonb(r) from public.resv_groups as r where r.id = -91003
  ),
  'order', (
    select pg_catalog.to_jsonb(o) from public.orders as o
    where o.id = 'f1474300-0000-4000-8000-000000000003'
  ),
  'items', coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(ci) order by ci.id::text collate "C")
    from public.order_custom_items as ci
    where ci.order_id = 'f1474300-0000-4000-8000-000000000003'
  ), '[]'::jsonb)
);

select throws_ok(
  $$select public.app_unconfirm_reservation(-91003)$$,
  '23514',
  'linked order contains an unsafe legacy reservation item',
  'a one-unit special line near-miss is rejected'
);

select is(
  (
    select value_snapshot from case_snapshots where case_name = 'special-near-miss'
  ),
  pg_catalog.jsonb_build_object(
    'reservation', (
      select pg_catalog.to_jsonb(r) from public.resv_groups as r where r.id = -91003
    ),
    'order', (
      select pg_catalog.to_jsonb(o) from public.orders as o
      where o.id = 'f1474300-0000-4000-8000-000000000003'
    ),
    'items', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(ci) order by ci.id::text collate "C")
      from public.order_custom_items as ci
      where ci.order_id = 'f1474300-0000-4000-8000-000000000003'
    ), '[]'::jsonb)
  ),
  'rejected special near-miss leaves reservation, order, and child unchanged'
);

insert into case_snapshots (case_name, value_snapshot)
select 'group-amount-mismatch', pg_catalog.jsonb_build_object(
  'reservation', (
    select pg_catalog.to_jsonb(r) from public.resv_groups as r where r.id = -91004
  ),
  'order', (
    select pg_catalog.to_jsonb(o) from public.orders as o
    where o.id = 'f1474300-0000-4000-8000-000000000004'
  ),
  'items', coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(ci) order by ci.id::text collate "C")
    from public.order_custom_items as ci
    where ci.order_id = 'f1474300-0000-4000-8000-000000000004'
  ), '[]'::jsonb)
);

select throws_ok(
  $$
    select public.app_update_reservation(
      -91004, '2099-02-04', '19:00', 6, 240000,
      '[TEST] must not normalize', '[TEST] must not normalize vi',
      '[TEST] must not write', '[TEST] changed branch', '[TEST] changed guide'
    )
  $$,
  '23514',
  'legacy reservation/order mismatch; unconfirm and reconfirm before editing',
  'confirmed amount mismatch is fail-closed before synchronization'
);

select is(
  (
    select value_snapshot from case_snapshots where case_name = 'group-amount-mismatch'
  ),
  pg_catalog.jsonb_build_object(
    'reservation', (
      select pg_catalog.to_jsonb(r) from public.resv_groups as r where r.id = -91004
    ),
    'order', (
      select pg_catalog.to_jsonb(o) from public.orders as o
      where o.id = 'f1474300-0000-4000-8000-000000000004'
    ),
    'items', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(ci) order by ci.id::text collate "C")
      from public.order_custom_items as ci
      where ci.order_id = 'f1474300-0000-4000-8000-000000000004'
    ), '[]'::jsonb)
  ),
  'denied confirmed update preserves the complete reservation/order/item snapshot'
);

select is(
  public.app_unconfirm_reservation(-91004),
  true,
  'explicit unconfirm remains available for a mismatched canonical group item'
);

select is(
  pg_catalog.jsonb_build_object(
    'reservation_state', (
      select pg_catalog.jsonb_build_array(r.confirmed, r.confirmed_at, r.confirmed_order_id)
      from public.resv_groups as r where r.id = -91004
    ),
    'order_count', (
      select pg_catalog.count(*) from public.orders
      where id = 'f1474300-0000-4000-8000-000000000004'
    ),
    'item_count', (
      select pg_catalog.count(*) from public.order_custom_items
      where order_id = 'f1474300-0000-4000-8000-000000000004'
    )
  ),
  '{"item_count": 0, "order_count": 0, "reservation_state": [false, null, null]}'::jsonb,
  'mismatched canonical group recovery unlinks then deletes atomically'
);

insert into case_snapshots (case_name, value_snapshot)
select 'zero-child-immutable', pg_catalog.jsonb_build_object(
  'id', o.id,
  'created_at', o.created_at,
  'source', o.source,
  'sales_excluded', o.sales_excluded,
  'total_usd', o.total_usd,
  'total_vnd', o.total_vnd
)
from public.orders as o
where o.id = 'f1474300-0000-4000-8000-000000000005';

select is(
  public.app_update_order(
    'f1474300-0000-4000-8000-000000000005',
    'pending', '[TEST] zero child updated', 'Z-5-U', 'card', '[]'::jsonb
  ),
  true,
  'zero-child legacy order accepts metadata-only edit'
);

select is(
  (
    select pg_catalog.jsonb_build_object(
      'status', o.status,
      'guide_name', o.guide_name,
      'team_no', o.team_no,
      'payment_method', o.payment_method
    )
    from public.orders as o
    where o.id = 'f1474300-0000-4000-8000-000000000005'
  ),
  '{"guide_name": "[TEST] zero child updated", "payment_method": "card", "status": "pending", "team_no": "Z-5-U"}'::jsonb,
  'zero-child branch updates exactly the editable metadata'
);

select is(
  (
    select value_snapshot from case_snapshots where case_name = 'zero-child-immutable'
  ),
  (
    select pg_catalog.jsonb_build_object(
      'id', o.id,
      'created_at', o.created_at,
      'source', o.source,
      'sales_excluded', o.sales_excluded,
      'total_usd', o.total_usd,
      'total_vnd', o.total_vnd
    )
    from public.orders as o
    where o.id = 'f1474300-0000-4000-8000-000000000005'
  ),
  'zero-child metadata edit preserves timestamps, source, exclusion, and totals'
);

select is(
  (
    select (
      select pg_catalog.count(*) from public.order_items
      where order_id = 'f1474300-0000-4000-8000-000000000005'
    ) + (
      select pg_catalog.count(*) from public.order_custom_items
      where order_id = 'f1474300-0000-4000-8000-000000000005'
    )
  ),
  0::bigint,
  'zero-child metadata edit performs no child DML'
);

insert into case_snapshots (case_name, value_snapshot)
select 'nonempty-order', pg_catalog.jsonb_build_object(
  'order', (
    select pg_catalog.to_jsonb(o) from public.orders as o
    where o.id = 'f1474300-0000-4000-8000-000000000006'
  ),
  'regular_items', coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(oi) order by oi.id::text collate "C")
    from public.order_items as oi
    where oi.order_id = 'f1474300-0000-4000-8000-000000000006'
  ), '[]'::jsonb),
  'custom_items', coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(ci) order by ci.id::text collate "C")
    from public.order_custom_items as ci
    where ci.order_id = 'f1474300-0000-4000-8000-000000000006'
  ), '[]'::jsonb)
);

select throws_ok(
  $$
    select public.app_update_order(
      'f1474300-0000-4000-8000-000000000006',
      'pending', '[TEST] must not write', 'N-6-U', 'card', '[]'::jsonb
    )
  $$,
  '23514',
  'empty items are allowed only for an order that already has no child items',
  'empty payload cannot erase an existing child set'
);

select is(
  (
    select value_snapshot from case_snapshots where case_name = 'nonempty-order'
  ),
  pg_catalog.jsonb_build_object(
    'order', (
      select pg_catalog.to_jsonb(o) from public.orders as o
      where o.id = 'f1474300-0000-4000-8000-000000000006'
    ),
    'regular_items', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(oi) order by oi.id::text collate "C")
      from public.order_items as oi
      where oi.order_id = 'f1474300-0000-4000-8000-000000000006'
    ), '[]'::jsonb),
    'custom_items', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(ci) order by ci.id::text collate "C")
      from public.order_custom_items as ci
      where ci.order_id = 'f1474300-0000-4000-8000-000000000006'
    ), '[]'::jsonb)
  ),
  'rejected empty payload preserves nonempty order and all children'
);

create temporary table canonical_result (
  order_id uuid primary key
) on commit drop;

insert into canonical_result (order_id)
select public.app_confirm_reservation(-91007, 'bank', 'C-7');

select ok(
  (select order_id is not null from canonical_result),
  'canonical reservation confirmation still creates an order'
);

select is(
  public.app_confirm_reservation(-91007, 'cash', 'ignored'),
  (select order_id from canonical_result),
  'valid already-confirmed reservation remains idempotent'
);

select is(
  public.app_update_reservation(
    -91007, '2099-01-08', '19:30', 3, 150000,
    '[TEST] canonical updated', '[TEST] canonical updated vi',
    '[TEST] canonical note', '[TEST] branch updated', '[TEST] guide updated'
  ),
  -91007::bigint,
  'canonical confirmed reservation update still succeeds'
);

select is(
  (
    select pg_catalog.jsonb_build_object(
      'reservation', pg_catalog.jsonb_build_array(
        r.res_date, r.res_time, r.guests_count, r.price,
        r.confirmed, r.confirmed_order_id
      ),
      'order', pg_catalog.jsonb_build_array(
        o.source, o.total_usd, o.total_vnd, o.guide_name
      ),
      'item', pg_catalog.jsonb_build_array(
        ci.kind, ci.qty, ci.unit_usd, ci.unit_vnd, ci.line_usd, ci.line_vnd
      )
    )
    from public.resv_groups as r
    join public.orders as o on o.id = r.confirmed_order_id
    join public.order_custom_items as ci on ci.order_id = o.id
    where r.id = -91007
  ),
  pg_catalog.jsonb_build_object(
    'reservation', pg_catalog.jsonb_build_array(
      '2099-01-08'::date, '19:30'::time, 3, 150000,
      true, (select order_id from canonical_result)
    ),
    'order', pg_catalog.jsonb_build_array(
      'reservation_confirm', 0, 450000, '[TEST] guide updated'
    ),
    'item', pg_catalog.jsonb_build_array(
      'group_resv', 3, 0, 150000, 0, 450000
    )
  ),
  'canonical confirmed update keeps reservation, order, and item synchronized'
);

select is(
  public.app_unconfirm_reservation(-91007),
  true,
  'canonical reservation unconfirm still succeeds'
);

select is(
  pg_catalog.jsonb_build_object(
    'reservation_state', (
      select pg_catalog.jsonb_build_array(r.confirmed, r.confirmed_at, r.confirmed_order_id)
      from public.resv_groups as r where r.id = -91007
    ),
    'order_count', (
      select pg_catalog.count(*)
      from public.orders as o
      where o.id = (select order_id from canonical_result)
    )
  ),
  '{"order_count": 0, "reservation_state": [false, null, null]}'::jsonb,
  'canonical unconfirm clears the link and deletes its generated order'
);

set local request.jwt.claims = '{"app_metadata":{"role":"staff"}}';

select throws_ok(
  $$
    select public.app_update_order(
      'f1474300-0000-4000-8000-000000000005',
      'paid', '[TEST] denied', 'denied', 'cash', '[]'::jsonb
    )
  $$,
  '42501',
  'admin role required',
  'compatibility paths remain admin-only'
);

select * from finish();
rollback;
