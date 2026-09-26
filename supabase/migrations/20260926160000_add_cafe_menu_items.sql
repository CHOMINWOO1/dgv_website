-- Insert the 47 cafe-menu choices published in the restaurant's cafe PDF.
--
-- This migration is intentionally INSERT-only for public.menu_items. It never
-- updates or deletes an existing menu row, including the pre-existing generic
-- soft-drink item. The 500ml and 700ml choices are separate rows because the
-- current order model stores one authoritative price per menu item.

create temporary table cafe_menu_items_stage (
  source_order integer primary key,
  size_ml integer,
  ko_name text not null unique,
  vi_name text not null,
  en_name text not null,
  description_ko text not null,
  description_vi text not null,
  description_en text not null,
  price_vnd integer not null,
  image_url text generated always as (
    case
      when source_order between 1 and 16 then 'image/restaurant/qr-menu/cafe/coffee.webp'
      when source_order between 17 and 26 then 'image/restaurant/qr-menu/cafe/juice.webp'
      when source_order between 27 and 30 then 'image/restaurant/qr-menu/cafe/milk-tea.webp'
      when source_order between 31 and 40 then 'image/restaurant/qr-menu/cafe/smoothies.webp'
      when source_order between 41 and 47 then 'image/restaurant/qr-menu/cafe/drinks-ice-cream.webp'
    end
  ) stored,
  sort_order integer not null unique
);

insert into pg_temp.cafe_menu_items_stage (
  source_order,
  size_ml,
  ko_name,
  vi_name,
  en_name,
  description_ko,
  description_vi,
  description_en,
  price_vnd,
  sort_order
)
values
  (1, 500, '아메리카노 500ml', 'Americano 500ml', 'Americano 500ml',
    '500ml 아메리카노입니다.', 'Americano dung tích 500ml.', '500ml Americano.', 40000, 6001),
  (2, 700, '아메리카노 700ml', 'Americano 700ml', 'Americano 700ml',
    '700ml 아메리카노입니다.', 'Americano dung tích 700ml.', '700ml Americano.', 50000, 6002),
  (3, 500, '카페 라떼 500ml', 'Cafe latte 500ml', 'Latte coffee 500ml',
    '500ml 카페 라떼입니다.', 'Cafe latte dung tích 500ml.', '500ml latte coffee.', 40000, 6003),
  (4, 700, '카페 라떼 700ml', 'Cafe latte 700ml', 'Latte coffee 700ml',
    '700ml 카페 라떼입니다.', 'Cafe latte dung tích 700ml.', '700ml latte coffee.', 50000, 6004),
  (5, 500, '카카오 라떼 500ml', 'Cacao latte 500ml', 'Cacao latte 500ml',
    '500ml 카카오 라떼입니다.', 'Cacao latte dung tích 500ml.', '500ml cacao latte.', 35000, 6005),
  (6, 700, '카카오 라떼 700ml', 'Cacao latte 700ml', 'Cacao latte 700ml',
    '700ml 카카오 라떼입니다.', 'Cacao latte dung tích 700ml.', '700ml cacao latte.', 45000, 6006),
  (7, 500, '말차 라떼 500ml', 'Matcha latte 500ml', 'Matcha latte 500ml',
    '500ml 말차 라떼입니다.', 'Matcha latte dung tích 500ml.', '500ml matcha latte.', 35000, 6007),
  (8, 700, '말차 라떼 700ml', 'Matcha latte 700ml', 'Matcha latte 700ml',
    '700ml 말차 라떼입니다.', 'Matcha latte dung tích 700ml.', '700ml matcha latte.', 45000, 6008),
  (9, 500, '블랙커피 500ml', 'Đen đá 500ml', 'Black coffee 500ml',
    '500ml 블랙커피입니다.', 'Đen đá dung tích 500ml.', '500ml black coffee.', 30000, 6009),
  (10, 700, '블랙커피 700ml', 'Đen đá 700ml', 'Black coffee 700ml',
    '700ml 블랙커피입니다.', 'Đen đá dung tích 700ml.', '700ml black coffee.', 40000, 6010),
  (11, 500, '밀크 커피 500ml', 'Nâu 500ml', 'Coffee w/ condensed milk 500ml',
    '500ml 밀크 커피입니다.', 'Nâu dung tích 500ml.', '500ml coffee with condensed milk.', 35000, 6011),
  (12, 700, '밀크 커피 700ml', 'Nâu 700ml', 'Coffee w/ condensed milk 700ml',
    '700ml 밀크 커피입니다.', 'Nâu dung tích 700ml.', '700ml coffee with condensed milk.', 45000, 6012),
  (13, 500, '밀크+소금 크림 커피 500ml', 'Nâu kem muối 500ml',
    'Coffee w/ condensed milk & salted cream 500ml',
    '500ml 밀크+소금 크림 커피입니다.', 'Nâu kem muối dung tích 500ml.',
    '500ml coffee with condensed milk and salted cream.', 40000, 6013),
  (14, 700, '밀크+소금 크림 커피 700ml', 'Nâu kem muối 700ml',
    'Coffee w/ condensed milk & salted cream 700ml',
    '700ml 밀크+소금 크림 커피입니다.', 'Nâu kem muối dung tích 700ml.',
    '700ml coffee with condensed milk and salted cream.', 50000, 6014),
  (15, 500, '코코넛 커피 500ml', 'Cà phê dừa 500ml', 'Coconut coffee 500ml',
    '500ml 코코넛 커피입니다.', 'Cà phê dừa dung tích 500ml.', '500ml coconut coffee.', 55000, 6015),
  (16, 700, '코코넛 커피 700ml', 'Cà phê dừa 700ml', 'Coconut coffee 700ml',
    '700ml 코코넛 커피입니다.', 'Cà phê dừa dung tích 700ml.', '700ml coconut coffee.', 65000, 6016),
  (17, 500, '사과 주스 500ml', 'Nước ép táo 500ml', 'Apple juice 500ml',
    '500ml 사과 주스입니다.', 'Nước ép táo dung tích 500ml.', '500ml apple juice.', 40000, 6017),
  (18, 700, '사과 주스 700ml', 'Nước ép táo 700ml', 'Apple juice 700ml',
    '700ml 사과 주스입니다.', 'Nước ép táo dung tích 700ml.', '700ml apple juice.', 50000, 6018),
  (19, 500, '파인애플 주스 500ml', 'Nước ép thơm 500ml', 'Pineapple juice 500ml',
    '500ml 파인애플 주스입니다.', 'Nước ép thơm dung tích 500ml.', '500ml pineapple juice.', 35000, 6019),
  (20, 700, '파인애플 주스 700ml', 'Nước ép thơm 700ml', 'Pineapple juice 700ml',
    '700ml 파인애플 주스입니다.', 'Nước ép thơm dung tích 700ml.', '700ml pineapple juice.', 45000, 6020),
  (21, 500, '수박 주스 500ml', 'Nước ép dưa hấu 500ml', 'Watermelon juice 500ml',
    '500ml 수박 주스입니다.', 'Nước ép dưa hấu dung tích 500ml.', '500ml watermelon juice.', 30000, 6021),
  (22, 700, '수박 주스 700ml', 'Nước ép dưa hấu 700ml', 'Watermelon juice 700ml',
    '700ml 수박 주스입니다.', 'Nước ép dưa hấu dung tích 700ml.', '700ml watermelon juice.', 40000, 6022),
  (23, 500, '구아바 주스 500ml', 'Nước ép ổi 500ml', 'Guava juice 500ml',
    '500ml 구아바 주스입니다.', 'Nước ép ổi dung tích 500ml.', '500ml guava juice.', 30000, 6023),
  (24, 700, '구아바 주스 700ml', 'Nước ép ổi 700ml', 'Guava juice 700ml',
    '700ml 구아바 주스입니다.', 'Nước ép ổi dung tích 700ml.', '700ml guava juice.', 40000, 6024),
  (25, 500, '오렌지 주스 500ml', 'Nước ép cam 500ml', 'Orange juice 500ml',
    '500ml 오렌지 주스입니다.', 'Nước ép cam dung tích 500ml.', '500ml orange juice.', 30000, 6025),
  (26, 700, '오렌지 주스 700ml', 'Nước ép cam 700ml', 'Orange juice 700ml',
    '700ml 오렌지 주스입니다.', 'Nước ép cam dung tích 700ml.', '700ml orange juice.', 40000, 6026),
  (27, 500, '전통 밀크티 500ml', 'Trà sữa truyền thống 500ml', 'Traditional milk tea 500ml',
    '500ml 전통 밀크티입니다.', 'Trà sữa truyền thống dung tích 500ml.',
    '500ml traditional milk tea.', 30000, 6027),
  (28, 700, '전통 밀크티 700ml', 'Trà sữa truyền thống 700ml', 'Traditional milk tea 700ml',
    '700ml 전통 밀크티입니다.', 'Trà sữa truyền thống dung tích 700ml.',
    '700ml traditional milk tea.', 40000, 6028),
  (29, 500, '말차 밀크티 500ml', 'Trà sữa matcha 500ml', 'Matcha milk tea 500ml',
    '500ml 말차 밀크티입니다.', 'Trà sữa matcha dung tích 500ml.', '500ml matcha milk tea.', 35000, 6029),
  (30, 700, '말차 밀크티 700ml', 'Trà sữa matcha 700ml', 'Matcha milk tea 700ml',
    '700ml 말차 밀크티입니다.', 'Trà sữa matcha dung tích 700ml.', '700ml matcha milk tea.', 45000, 6030),
  (31, 500, '아보카도 스무디 500ml', 'Sinh tố bơ 500ml', 'Avocado smoothie 500ml',
    '500ml 아보카도 스무디입니다.', 'Sinh tố bơ dung tích 500ml.', '500ml avocado smoothie.', 40000, 6031),
  (32, 700, '아보카도 스무디 700ml', 'Sinh tố bơ 700ml', 'Avocado smoothie 700ml',
    '700ml 아보카도 스무디입니다.', 'Sinh tố bơ dung tích 700ml.', '700ml avocado smoothie.', 50000, 6032),
  (33, 500, '망고 스무디 500ml', 'Sinh tố xoài 500ml', 'Mango smoothie 500ml',
    '500ml 망고 스무디입니다.', 'Sinh tố xoài dung tích 500ml.', '500ml mango smoothie.', 40000, 6033),
  (34, 700, '망고 스무디 700ml', 'Sinh tố xoài 700ml', 'Mango smoothie 700ml',
    '700ml 망고 스무디입니다.', 'Sinh tố xoài dung tích 700ml.', '700ml mango smoothie.', 50000, 6034),
  (35, 500, '딸기 스무디 500ml', 'Sinh tố dâu 500ml', 'Strawberry smoothie 500ml',
    '500ml 딸기 스무디입니다.', 'Sinh tố dâu dung tích 500ml.', '500ml strawberry smoothie.', 40000, 6035),
  (36, 700, '딸기 스무디 700ml', 'Sinh tố dâu 700ml', 'Strawberry smoothie 700ml',
    '700ml 딸기 스무디입니다.', 'Sinh tố dâu dung tích 700ml.', '700ml strawberry smoothie.', 50000, 6036),
  (37, 500, '그라비올라 스무디 500ml', 'Sinh tố mãng cầu 500ml', 'Soursop smoothie 500ml',
    '500ml 그라비올라 스무디입니다.', 'Sinh tố mãng cầu dung tích 500ml.', '500ml soursop smoothie.', 40000, 6037),
  (38, 700, '그라비올라 스무디 700ml', 'Sinh tố mãng cầu 700ml', 'Soursop smoothie 700ml',
    '700ml 그라비올라 스무디입니다.', 'Sinh tố mãng cầu dung tích 700ml.', '700ml soursop smoothie.', 50000, 6038),
  (39, 500, '코코넛 스무디 500ml', 'Sinh tố dừa 500ml', 'Coconut smoothie 500ml',
    '500ml 코코넛 스무디입니다.', 'Sinh tố dừa dung tích 500ml.', '500ml coconut smoothie.', 40000, 6039),
  (40, 700, '코코넛 스무디 700ml', 'Sinh tố dừa 700ml', 'Coconut smoothie 700ml',
    '700ml 코코넛 스무디입니다.', 'Sinh tố dừa dung tích 700ml.', '700ml coconut smoothie.', 50000, 6040),
  (41, null, '콜라', 'Cola', 'Cola',
    '카페 메뉴의 탄산음료 콜라입니다.', 'Nước ngọt Cola trong thực đơn cà phê.',
    'Cola soft drink from the cafe menu.', 20000, 6041),
  (42, null, '스프라이트', 'Sprite', 'Sprite',
    '카페 메뉴의 탄산음료 스프라이트입니다.', 'Nước ngọt Sprite trong thực đơn cà phê.',
    'Sprite soft drink from the cafe menu.', 20000, 6042),
  (43, null, '스팅', 'Sting', 'Sting',
    '카페 메뉴의 탄산음료 스팅입니다.', 'Nước ngọt Sting trong thực đơn cà phê.',
    'Sting soft drink from the cafe menu.', 20000, 6043),
  (44, null, '레드불', 'Red Bull', 'Red Bull',
    '카페 메뉴의 에너지 음료 레드불입니다.', 'Nước tăng lực Red Bull trong thực đơn cà phê.',
    'Red Bull energy drink from the cafe menu.', 28000, 6044),
  (45, null, '생수', 'Nước suối', 'Purified water',
    '카페 메뉴의 생수입니다.', 'Nước tinh khiết trong thực đơn cà phê.',
    'Purified water from the cafe menu.', 10000, 6045),
  (46, null, '아보카도 코코넛 아이스크림', 'Kem bơ', 'Avocado coconut ice cream',
    '아보카도 코코넛 아이스크림입니다.', 'Kem bơ dừa.',
    'Avocado coconut ice cream.', 30000, 6046),
  (47, null, '얼음 컵', 'Ly đá', 'Ice cup',
    '카페 메뉴의 얼음 컵입니다.', 'Ly đá trong thực đơn cà phê.',
    'Ice cup from the cafe menu.', 10000, 6047);

-- Validate the source manifest before touching public.menu_items. In
-- particular, this ensures that the 20 drinks have exactly two size variants
-- and that the seven fixed-size choices are present once each.
do $migration$
declare
  v_total integer;
  v_500ml integer;
  v_700ml integer;
  v_fixed integer;
  v_normalized_ko integer;
  v_normalized_vi integer;
  v_normalized_en integer;
  v_invalid_images integer;
  v_conflicts text;
begin
  select
    count(*),
    count(*) filter (where size_ml = 500),
    count(*) filter (where size_ml = 700),
    count(*) filter (where size_ml is null),
    count(distinct lower(btrim(ko_name))),
    count(distinct lower(btrim(vi_name))),
    count(distinct lower(btrim(en_name))),
    count(*) filter (
      where image_url is null
        or image_url not in (
          'image/restaurant/qr-menu/cafe/coffee.webp',
          'image/restaurant/qr-menu/cafe/juice.webp',
          'image/restaurant/qr-menu/cafe/milk-tea.webp',
          'image/restaurant/qr-menu/cafe/smoothies.webp',
          'image/restaurant/qr-menu/cafe/drinks-ice-cream.webp'
        )
    )
  into
    v_total,
    v_500ml,
    v_700ml,
    v_fixed,
    v_normalized_ko,
    v_normalized_vi,
    v_normalized_en,
    v_invalid_images
  from pg_temp.cafe_menu_items_stage;

  if v_total <> 47
     or v_500ml <> 20
     or v_700ml <> 20
     or v_fixed <> 7
     or v_normalized_ko <> 47
     or v_normalized_vi <> 47
     or v_normalized_en <> 47
     or v_invalid_images <> 0 then
    raise exception using
      errcode = '23514',
      message = 'cafe menu manifest must contain 47 unique items (20 x 500ml, 20 x 700ml, 7 fixed-size)';
  end if;

  -- A matching name is safe only when all PDF-controlled data agrees. Abort
  -- instead of overwriting or silently accepting a conflicting existing row.
  select string_agg(conflict.ko_name, ', ' order by conflict.ko_name)
  into v_conflicts
  from (
    select distinct staged.ko_name
    from pg_temp.cafe_menu_items_stage as staged
    join public.menu_items as existing
      on lower(btrim(coalesce(existing.ko_name, ''))) = lower(btrim(staged.ko_name))
      or lower(btrim(coalesce(existing.vi_name, ''))) = lower(btrim(staged.vi_name))
      or lower(btrim(coalesce(existing.en_name, ''))) = lower(btrim(staged.en_name))
    where not (
      existing.type = 'cafe'
      and lower(btrim(coalesce(existing.ko_name, ''))) = lower(btrim(staged.ko_name))
      and lower(btrim(coalesce(existing.vi_name, ''))) = lower(btrim(staged.vi_name))
      and lower(btrim(coalesce(existing.en_name, ''))) = lower(btrim(staged.en_name))
      and existing.description_ko is not distinct from staged.description_ko
      and existing.description_vi is not distinct from staged.description_vi
      and existing.description_en is not distinct from staged.description_en
      and existing.price_vnd = staged.price_vnd
      and existing.price_usd = greatest(
        1,
        round(staged.price_vnd::numeric / 25000::numeric)::integer
      )
      and existing.image_url is not distinct from staged.image_url
      and existing.qr_category = 'cafe'
      and existing.is_active is true
      and existing.is_orderable is true
      and existing.is_sold_out is false
      and existing.requires_preorder is false
      and existing.archived_at is null
      and existing.sort_order = staged.sort_order
    )
    order by staged.ko_name
    limit 10
  ) as conflict;

  if v_conflicts is not null then
    raise exception using
      errcode = '23505',
      message = 'cafe menu name conflicts with existing menu data',
      detail = v_conflicts,
      hint = 'Resolve the conflicting row manually; this migration never updates or deletes existing menu_items.';
  end if;
end
$migration$;

insert into public.menu_items (
  type,
  ko_name,
  vi_name,
  en_name,
  description_ko,
  description_vi,
  description_en,
  price_usd,
  price_vnd,
  image_url,
  is_active,
  sort_order,
  created_at,
  qr_category,
  is_orderable,
  is_sold_out,
  requires_preorder,
  updated_at,
  archived_at
)
select
  'cafe',
  staged.ko_name,
  staged.vi_name,
  staged.en_name,
  staged.description_ko,
  staged.description_vi,
  staged.description_en,
  greatest(1, round(staged.price_vnd::numeric / 25000::numeric)::integer),
  staged.price_vnd,
  staged.image_url,
  true,
  staged.sort_order,
  now(),
  'cafe',
  true,
  false,
  false,
  now(),
  null
from pg_temp.cafe_menu_items_stage as staged
where not exists (
  select 1
  from public.menu_items as existing
  where lower(btrim(coalesce(existing.ko_name, ''))) = lower(btrim(staged.ko_name))
)
order by staged.source_order;

-- A clean first run and an unchanged rerun must both resolve to exactly one
-- matching menu row for every staged choice. Any missing or duplicate match
-- aborts the migration transaction without altering pre-existing rows.
do $migration$
declare
  v_verified integer;
  v_name_cardinality_violations integer;
begin
  select count(*)
  into v_name_cardinality_violations
  from pg_temp.cafe_menu_items_stage as staged
  where (
    select count(*)
    from public.menu_items as existing
    where lower(btrim(coalesce(existing.ko_name, ''))) = lower(btrim(staged.ko_name))
  ) <> 1
  or (
    select count(*)
    from public.menu_items as existing
    where lower(btrim(coalesce(existing.vi_name, ''))) = lower(btrim(staged.vi_name))
  ) <> 1
  or (
    select count(*)
    from public.menu_items as existing
    where lower(btrim(coalesce(existing.en_name, ''))) = lower(btrim(staged.en_name))
  ) <> 1;

  if v_name_cardinality_violations <> 0 then
    raise exception using
      errcode = '23505',
      message = 'cafe menu verification failed: every staged localized name must match exactly one row',
      detail = format('name cardinality violations: %s', v_name_cardinality_violations);
  end if;

  select count(*)
  into v_verified
  from pg_temp.cafe_menu_items_stage as staged
  join public.menu_items as inserted
    on lower(btrim(coalesce(inserted.ko_name, ''))) = lower(btrim(staged.ko_name))
  where inserted.type = 'cafe'
    and lower(btrim(coalesce(inserted.vi_name, ''))) = lower(btrim(staged.vi_name))
    and lower(btrim(coalesce(inserted.en_name, ''))) = lower(btrim(staged.en_name))
    and inserted.description_ko is not distinct from staged.description_ko
    and inserted.description_vi is not distinct from staged.description_vi
    and inserted.description_en is not distinct from staged.description_en
    and inserted.price_vnd = staged.price_vnd
    and inserted.price_usd = greatest(
      1,
      round(staged.price_vnd::numeric / 25000::numeric)::integer
    )
    and inserted.image_url is not distinct from staged.image_url
    and inserted.qr_category = 'cafe'
    and inserted.is_active is true
    and inserted.is_orderable is true
    and inserted.is_sold_out is false
    and inserted.requires_preorder is false
    and inserted.archived_at is null
    and inserted.sort_order = staged.sort_order;

  if v_verified <> 47 then
    raise exception using
      errcode = '23514',
      message = 'cafe menu verification failed: expected exactly 47 matching rows',
      detail = format('matching rows: %s', v_verified);
  end if;
end
$migration$;

drop table pg_temp.cafe_menu_items_stage;
