-- Synthetic staging fixtures only.
--
-- These rows are invented and contain no production customer, reservation,
-- credential, password hash, access code, API key, or notification destination.
-- Auth users are intentionally not seeded here; create test users through the
-- Supabase Auth Admin flow and set raw_app_meta_data.role to staff or admin.

insert into public.menu_items (
  id,
  type,
  ko_name,
  vi_name,
  price_usd,
  price_vnd,
  is_active,
  sort_order,
  created_at
)
values
  (
    '10000000-0000-4000-8000-000000000001',
    'drink',
    '[TEST] 생수',
    '[TEST] Nước suối',
    2,
    50000,
    true,
    10,
    '2026-01-01T00:00:00Z'
  ),
  (
    '10000000-0000-4000-8000-000000000002',
    'drink',
    '[TEST] 탄산음료',
    '[TEST] Nước ngọt',
    3,
    75000,
    true,
    20,
    '2026-01-01T00:00:00Z'
  ),
  (
    '10000000-0000-4000-8000-000000000003',
    'side',
    '[TEST] 사이드 메뉴',
    '[TEST] Món ăn kèm',
    5,
    125000,
    true,
    30,
    '2026-01-01T00:00:00Z'
  ),
  (
    '10000000-0000-4000-8000-000000000004',
    'other',
    '[TEST] 비활성 메뉴',
    '[TEST] Món không hoạt động',
    1,
    25000,
    false,
    40,
    '2026-01-01T00:00:00Z'
  )
on conflict (id) do nothing;

insert into public.orders (
  id,
  created_at,
  source,
  status,
  total_usd,
  total_vnd,
  guide_name,
  team_no,
  payment_method,
  sales_excluded
)
values
  (
    '20000000-0000-4000-8000-000000000001',
    '2026-01-15T12:00:00+07:00',
    'synthetic_seed',
    'paid',
    7,
    175000,
    '[TEST] Guide Alpha',
    '[TEST] Team 01',
    'cash',
    false
  ),
  (
    '20000000-0000-4000-8000-000000000002',
    '2026-01-16T18:30:00+07:00',
    'synthetic_seed',
    'paid',
    0,
    400000,
    '[TEST] Guide Beta',
    '[TEST] Team 02',
    'card',
    false
  )
on conflict (id) do nothing;

insert into public.order_items (
  id,
  order_id,
  menu_item_id,
  qty,
  unit_usd,
  unit_vnd,
  line_usd,
  line_vnd,
  is_custom,
  custom_ko_name,
  custom_vi_name
)
values
  (
    '21000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    2,
    2,
    50000,
    4,
    100000,
    false,
    null,
    null
  ),
  (
    '21000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002',
    1,
    3,
    75000,
    3,
    75000,
    false,
    null,
    null
  )
on conflict (id) do nothing;

insert into public.order_custom_items (
  id,
  order_id,
  kind,
  ko_name,
  vi_name,
  qty,
  unit_usd,
  unit_vnd,
  line_usd,
  line_vnd,
  created_at
)
values (
  '22000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002',
  'special',
  '[TEST] 맞춤 메뉴',
  '[TEST] Món tùy chỉnh',
  4,
  0,
  100000,
  0,
  400000,
  '2026-01-16T18:30:00+07:00'
)
on conflict (id) do nothing;

insert into public.resv_groups (
  id,
  res_date,
  res_time,
  guests_count,
  price,
  menu_ko,
  menu_vi,
  note,
  branch,
  guide_name,
  created_at,
  confirmed,
  confirmed_at,
  confirmed_order_id
)
values
  (
    900000001,
    '2099-01-15',
    '12:00',
    12,
    125000,
    '[TEST] 단체 메뉴 A',
    '[TEST] Thực đơn đoàn A',
    '[TEST] 창가 좌석 요청',
    '[TEST] Branch Alpha',
    '[TEST] Guide Gamma',
    '2026-01-10T09:00:00+07:00',
    false,
    null,
    null
  ),
  (
    900000002,
    '2099-01-16',
    '18:30',
    6,
    null,
    '[TEST] 메뉴 협의 중',
    '[TEST] Đang chọn thực đơn',
    '[TEST] 가격 미정 시나리오',
    '[TEST] Branch Beta',
    '[TEST] Guide Delta',
    '2026-01-10T09:05:00+07:00',
    false,
    null,
    null
  )
on conflict (id) do nothing;

insert into public.notices (
  id,
  title,
  body,
  author,
  created_at,
  updated_at
)
values
  (
    '30000000-0000-4000-8000-000000000001',
    '[TEST] 스테이징 공지',
    '합성 데이터로 만든 공개 공지 읽기 테스트입니다.',
    '[TEST] Admin',
    '2026-01-01T00:00:00Z',
    '2026-01-01T00:00:00Z'
  ),
  (
    '30000000-0000-4000-8000-000000000002',
    '[TEST] 권한 테스트 안내',
    '수정과 삭제는 admin 역할에서만 테스트하세요.',
    '[TEST] Admin',
    '2026-01-02T00:00:00Z',
    '2026-01-02T00:00:00Z'
  )
on conflict (id) do nothing;
