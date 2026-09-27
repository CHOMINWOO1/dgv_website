-- Add a QR-only subcategory for the existing single-serving menu and return
-- active menu items in ascending VND-price order. Legacy menu type,
-- qr_category, sort_order, prices, and order history remain unchanged.

alter table public.menu_items
  add column qr_subcategory text;

alter table public.menu_items
  add constraint menu_items_qr_subcategory_check
  check (
    qr_subcategory is null
    or (
      qr_category is not distinct from 'single'
      and qr_subcategory in ('noodle', 'stew_rice', 'soup', 'grill', 'other')
    )
  );

comment on column public.menu_items.qr_subcategory is
  'Optional QR submenu for single-serving items: noodle, stew_rice, soup, grill, or other.';

-- Keep direct writes consistent with the existing menu normalization trigger.
create or replace function private.validate_menu_item()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if length(btrim(coalesce(new.type, ''))) = 0
     or length(btrim(new.type)) > 80 then
    raise exception using errcode = '22023', message = 'menu type is required';
  end if;

  if (new.price_usd is not null and new.price_usd < 0)
     or (new.price_vnd is not null and new.price_vnd < 0) then
    raise exception using errcode = '22023', message = 'menu prices cannot be negative';
  end if;

  if new.is_active = true
     and (
       length(btrim(coalesce(new.ko_name, ''))) = 0
       or new.price_usd is null
       or new.price_vnd is null
     ) then
    raise exception using
      errcode = '22023',
      message = 'active menu items require a name and both prices';
  end if;

  if length(coalesce(new.ko_name, '')) > 200
     or length(coalesce(new.vi_name, '')) > 200
     or length(coalesce(new.en_name, '')) > 200
     or length(coalesce(new.description_ko, '')) > 2000
     or length(coalesce(new.description_vi, '')) > 2000
     or length(coalesce(new.description_en, '')) > 2000
     or length(coalesce(new.image_url, '')) > 1000
     or length(coalesce(new.qr_category, '')) > 40
     or length(coalesce(new.qr_subcategory, '')) > 40 then
    raise exception using errcode = '22023', message = 'menu text is too long';
  end if;

  if new.image_url is not null
     and btrim(new.image_url) <> ''
     and not (
       btrim(new.image_url) like 'https://%'
       or left(btrim(new.image_url), 1) = '/'
       or btrim(new.image_url) like 'image/%'
       or btrim(new.image_url) like './image/%'
     ) then
    raise exception using
      errcode = '22023',
      message = 'menu image URL must be HTTPS or a local image path';
  end if;

  new.type := btrim(new.type);
  new.ko_name := nullif(btrim(new.ko_name), '');
  new.vi_name := nullif(btrim(new.vi_name), '');
  new.en_name := nullif(btrim(new.en_name), '');
  new.description_ko := nullif(btrim(new.description_ko), '');
  new.description_vi := nullif(btrim(new.description_vi), '');
  new.description_en := nullif(btrim(new.description_en), '');
  new.image_url := nullif(btrim(new.image_url), '');
  new.qr_category := nullif(lower(btrim(new.qr_category)), '');
  new.qr_subcategory := nullif(lower(btrim(new.qr_subcategory)), '');
  new.updated_at := now();
  return new;
end;
$$;

-- Stage the complete, reviewed set before touching production menu rows. The
-- validation below requires every Korean name to resolve to exactly one
-- existing single-serving item, so a rename or duplicate aborts atomically.
create temporary table qr_menu_subcategory_stage (
  ko_name text primary key,
  qr_subcategory text not null
) on commit drop;

insert into qr_menu_subcategory_stage (ko_name, qr_subcategory)
values
  ('신라면', 'noodle'),
  ('냉면', 'noodle'),
  ('짜파게티', 'noodle'),
  ('불닭볶음면', 'noodle'),
  ('비빔국수', 'noodle'),
  ('명동칼국수', 'noodle'),
  ('순두부찌개', 'stew_rice'),
  ('찌개(김치/된장)', 'stew_rice'),
  ('돌솥 알밥', 'stew_rice'),
  ('제육덮밥', 'stew_rice'),
  ('다금바리 회덮밥', 'stew_rice'),
  ('설렁탕', 'soup'),
  ('육개장', 'soup'),
  ('얼큰 사골 우거지탕', 'soup'),
  ('떡만두국', 'soup'),
  ('돼지국밥', 'soup'),
  ('도가니탕', 'soup'),
  ('부채살 스테이크', 'grill'),
  ('연어 스테이크', 'grill');

do $$
declare
  v_stage_count integer;
  v_invalid_match_count integer;
  v_updated_count integer;
begin
  select pg_catalog.count(*)::integer
  into v_stage_count
  from pg_temp.qr_menu_subcategory_stage;

  select pg_catalog.count(*)::integer
  into v_invalid_match_count
  from (
    select staged.ko_name
    from pg_temp.qr_menu_subcategory_stage as staged
    left join public.menu_items as menu on menu.ko_name = staged.ko_name
    group by staged.ko_name
    having pg_catalog.count(menu.id) <> 1
       or pg_catalog.count(menu.id) filter (
         where menu.qr_category = 'single'
       ) <> 1
  ) as invalid_matches;

  if v_stage_count <> 19 or v_invalid_match_count <> 0 then
    raise exception using
      errcode = 'P0001',
      message = pg_catalog.format(
        'QR menu subcategory backfill requires 19 unique single-serving matches; staged=%s invalid_matches=%s',
        v_stage_count,
        v_invalid_match_count
      );
  end if;

  update public.menu_items as menu
  set qr_subcategory = staged.qr_subcategory
  from pg_temp.qr_menu_subcategory_stage as staged
  where menu.ko_name = staged.ko_name
    and menu.qr_category = 'single';

  get diagnostics v_updated_count = row_count;
  if v_updated_count <> 19 then
    raise exception using
      errcode = 'P0001',
      message = pg_catalog.format(
        'QR menu subcategory backfill updated an unexpected number of rows; expected=19 actual=%s',
        v_updated_count
      );
  end if;

  if exists (
    select 1
    from pg_temp.qr_menu_subcategory_stage as staged
    join public.menu_items as menu on menu.ko_name = staged.ko_name
    where menu.qr_category is distinct from 'single'
       or menu.qr_subcategory is distinct from staged.qr_subcategory
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'QR menu subcategory backfill verification failed';
  end if;
end;
$$;

-- This definition is based on the latest guest-table-total version. It adds
-- qr_subcategory, price-first item ordering, and the fixed translated submenu
-- metadata while retaining its current-order limits and exact whole-table
-- unpaid totals unchanged.
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
        'qr_subcategory', m.qr_subcategory,
        'is_active', m.is_active,
        'is_orderable', m.is_orderable,
        'is_sold_out', m.is_sold_out,
        'requires_preorder', m.requires_preorder,
        'sort_order', m.sort_order
      ) order by
        coalesce(m.price_vnd, 2147483647),
        coalesce(m.sort_order, 2147483647),
        m.type,
        m.ko_name,
        m.id
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
    'subcategories', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'id', 'noodle', 'name_ko', '면',
        'name_en', 'Noodles', 'name_vi', 'Mì', 'sort_order', 10
      ),
      pg_catalog.jsonb_build_object(
        'id', 'stew_rice', 'name_ko', '찌개·덮밥',
        'name_en', 'Stews & rice bowls', 'name_vi', 'Món hầm & cơm tô', 'sort_order', 20
      ),
      pg_catalog.jsonb_build_object(
        'id', 'soup', 'name_ko', '국밥',
        'name_en', 'Soups with rice', 'name_vi', 'Canh ăn cùng cơm', 'sort_order', 30
      ),
      pg_catalog.jsonb_build_object(
        'id', 'grill', 'name_ko', '구이',
        'name_en', 'Grilled dishes', 'name_vi', 'Món nướng', 'sort_order', 40
      ),
      pg_catalog.jsonb_build_object(
        'id', 'other', 'name_ko', '기타',
        'name_en', 'Other', 'name_vi', 'Khác', 'sort_order', 90
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

create or replace function private.assert_menu_payload(
  p_payload jsonb,
  p_require_type boolean
)
returns void
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  v_key text;
  v_value text;
  v_qr_category text;
  v_qr_subcategory text;
begin
  if p_payload is null or pg_catalog.jsonb_typeof(p_payload) <> 'object' then
    raise exception using errcode = '22023', message = 'menu payload must be an object';
  end if;
  if p_payload = '{}'::jsonb then
    raise exception using errcode = '22023', message = 'menu payload must not be empty';
  end if;
  if p_payload - array[
    'type', 'ko_name', 'vi_name', 'en_name',
    'description_ko', 'description_vi', 'description_en',
    'price_usd', 'price_vnd', 'image_url', 'qr_category',
    'qr_subcategory',
    'is_active', 'is_orderable', 'is_sold_out', 'requires_preorder',
    'sort_order'
  ]::text[] <> '{}'::jsonb then
    raise exception using errcode = '22023', message = 'menu payload contains unsupported fields';
  end if;

  if p_require_type
     and (
       not (p_payload ? 'type')
       or pg_catalog.jsonb_typeof(p_payload -> 'type') <> 'string'
       or length(btrim(p_payload ->> 'type')) = 0
     ) then
    raise exception using errcode = '22023', message = 'menu type is required';
  end if;

  foreach v_key in array array[
    'type', 'ko_name', 'vi_name', 'en_name',
    'description_ko', 'description_vi', 'description_en',
    'image_url', 'qr_category', 'qr_subcategory'
  ]::text[] loop
    if p_payload ? v_key
       and pg_catalog.jsonb_typeof(p_payload -> v_key) not in ('string', 'null') then
      raise exception using errcode = '22023', message = v_key || ' must be text or null';
    end if;
  end loop;

  foreach v_key in array array[
    'is_active', 'is_orderable', 'is_sold_out', 'requires_preorder'
  ]::text[] loop
    if p_payload ? v_key
       and pg_catalog.jsonb_typeof(p_payload -> v_key) <> 'boolean' then
      raise exception using errcode = '22023', message = v_key || ' must be boolean';
    end if;
  end loop;

  foreach v_key in array array['price_usd', 'price_vnd', 'sort_order']::text[] loop
    if p_payload ? v_key
       and pg_catalog.jsonb_typeof(p_payload -> v_key) <> 'null' then
      if pg_catalog.jsonb_typeof(p_payload -> v_key) <> 'number'
         or coalesce(p_payload ->> v_key, '') !~ '^-?[0-9]+$' then
        raise exception using errcode = '22023', message = v_key || ' must be a 32-bit integer or null';
      end if;
      if (p_payload ->> v_key)::numeric not between -2147483648 and 2147483647 then
        raise exception using errcode = '22023', message = v_key || ' must be a 32-bit integer or null';
      end if;
    end if;
  end loop;

  if (p_payload ? 'price_usd' and (p_payload ->> 'price_usd')::numeric < 0)
     or (p_payload ? 'price_vnd' and (p_payload ->> 'price_vnd')::numeric < 0) then
    raise exception using errcode = '22023', message = 'menu prices cannot be negative';
  end if;

  foreach v_key in array array['ko_name', 'vi_name', 'en_name']::text[] loop
    if length(coalesce(p_payload ->> v_key, '')) > 200 then
      raise exception using errcode = '22023', message = v_key || ' is too long';
    end if;
  end loop;
  foreach v_key in array array[
    'description_ko', 'description_vi', 'description_en'
  ]::text[] loop
    if length(coalesce(p_payload ->> v_key, '')) > 2000 then
      raise exception using errcode = '22023', message = v_key || ' is too long';
    end if;
  end loop;
  if length(coalesce(p_payload ->> 'type', '')) > 80
     or length(coalesce(p_payload ->> 'image_url', '')) > 1000
     or length(coalesce(p_payload ->> 'qr_subcategory', '')) > 40 then
    raise exception using errcode = '22023', message = 'menu type, image URL, or QR subcategory is too long';
  end if;

  if p_payload ? 'qr_category'
     and pg_catalog.jsonb_typeof(p_payload -> 'qr_category') <> 'null'
     and lower(btrim(p_payload ->> 'qr_category')) not in (
       'single', 'shared', 'snack', 'preorder', 'drink', 'cafe'
     ) then
    raise exception using errcode = '22023', message = 'invalid QR menu category';
  end if;

  if p_payload ? 'qr_subcategory'
     and pg_catalog.jsonb_typeof(p_payload -> 'qr_subcategory') <> 'null' then
    v_qr_subcategory := nullif(lower(btrim(p_payload ->> 'qr_subcategory')), '');
    if v_qr_subcategory is not null
       and v_qr_subcategory not in ('noodle', 'stew_rice', 'soup', 'grill', 'other') then
      raise exception using errcode = '22023', message = 'invalid QR menu subcategory';
    end if;
  end if;

  if v_qr_subcategory is not null
     and (p_require_type or p_payload ? 'qr_category') then
    v_qr_category := nullif(lower(btrim(p_payload ->> 'qr_category')), '');
    if v_qr_category is distinct from 'single' then
      raise exception using
        errcode = '22023',
        message = 'QR menu subcategory requires the single QR category';
    end if;
  end if;

  if p_payload ? 'image_url'
     and pg_catalog.jsonb_typeof(p_payload -> 'image_url') <> 'null' then
    v_value := btrim(p_payload ->> 'image_url');
    if v_value <> ''
       and not (
         v_value like 'https://%'
         or left(v_value, 1) = '/'
         or v_value like 'image/%'
         or v_value like './image/%'
       ) then
      raise exception using
        errcode = '22023',
        message = 'menu image URL must be HTTPS or a local image path';
    end if;
  end if;
end;
$$;

create or replace function private.app_create_menu_item_impl(p_item jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item public.menu_items%rowtype;
begin
  if (select auth.uid()) is null
     or not public.has_app_role(array['admin']::text[]) then
    raise exception using errcode = '42501', message = 'admin role required';
  end if;
  perform private.assert_menu_payload(p_item, true);

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
    qr_category,
    qr_subcategory,
    is_active,
    is_orderable,
    is_sold_out,
    requires_preorder,
    sort_order,
    created_at,
    updated_at
  )
  values (
    p_item ->> 'type',
    p_item ->> 'ko_name',
    p_item ->> 'vi_name',
    p_item ->> 'en_name',
    p_item ->> 'description_ko',
    p_item ->> 'description_vi',
    p_item ->> 'description_en',
    (p_item ->> 'price_usd')::integer,
    (p_item ->> 'price_vnd')::integer,
    p_item ->> 'image_url',
    p_item ->> 'qr_category',
    p_item ->> 'qr_subcategory',
    coalesce((p_item ->> 'is_active')::boolean, false),
    coalesce((p_item ->> 'is_orderable')::boolean, true),
    coalesce((p_item ->> 'is_sold_out')::boolean, false),
    coalesce((p_item ->> 'requires_preorder')::boolean, false),
    (p_item ->> 'sort_order')::integer,
    now(),
    now()
  )
  returning * into v_item;

  return pg_catalog.to_jsonb(v_item);
end;
$$;

create or replace function private.app_update_menu_item_impl(
  p_item_id uuid,
  p_patch jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item public.menu_items%rowtype;
begin
  if (select auth.uid()) is null
     or not public.has_app_role(array['admin']::text[]) then
    raise exception using errcode = '42501', message = 'admin role required';
  end if;
  if p_item_id is null then
    raise exception using errcode = '22023', message = 'menu item id is required';
  end if;
  perform private.assert_menu_payload(p_patch, false);

  update public.menu_items as m
  set
    type = case when p_patch ? 'type' then p_patch ->> 'type' else m.type end,
    ko_name = case when p_patch ? 'ko_name' then p_patch ->> 'ko_name' else m.ko_name end,
    vi_name = case when p_patch ? 'vi_name' then p_patch ->> 'vi_name' else m.vi_name end,
    en_name = case when p_patch ? 'en_name' then p_patch ->> 'en_name' else m.en_name end,
    description_ko = case when p_patch ? 'description_ko' then p_patch ->> 'description_ko' else m.description_ko end,
    description_vi = case when p_patch ? 'description_vi' then p_patch ->> 'description_vi' else m.description_vi end,
    description_en = case when p_patch ? 'description_en' then p_patch ->> 'description_en' else m.description_en end,
    price_usd = case when p_patch ? 'price_usd' then (p_patch ->> 'price_usd')::integer else m.price_usd end,
    price_vnd = case when p_patch ? 'price_vnd' then (p_patch ->> 'price_vnd')::integer else m.price_vnd end,
    image_url = case when p_patch ? 'image_url' then p_patch ->> 'image_url' else m.image_url end,
    qr_category = case when p_patch ? 'qr_category' then p_patch ->> 'qr_category' else m.qr_category end,
    qr_subcategory = case when p_patch ? 'qr_subcategory' then p_patch ->> 'qr_subcategory' else m.qr_subcategory end,
    is_active = case when p_patch ? 'is_active' then (p_patch ->> 'is_active')::boolean else m.is_active end,
    is_orderable = case when p_patch ? 'is_orderable' then (p_patch ->> 'is_orderable')::boolean else m.is_orderable end,
    is_sold_out = case when p_patch ? 'is_sold_out' then (p_patch ->> 'is_sold_out')::boolean else m.is_sold_out end,
    requires_preorder = case when p_patch ? 'requires_preorder' then (p_patch ->> 'requires_preorder')::boolean else m.requires_preorder end,
    sort_order = case when p_patch ? 'sort_order' then (p_patch ->> 'sort_order')::integer else m.sort_order end,
    updated_at = now()
  where m.id = p_item_id
  returning m.* into v_item;

  if not found then
    raise exception using errcode = 'P0002', message = 'menu item not found';
  end if;
  return pg_catalog.to_jsonb(v_item);
end;
$$;

-- CREATE OR REPLACE preserves ACLs, and these statements reassert the intended
-- callers explicitly: browsers cannot call the token-hash lookup, while the
-- public admin wrappers continue to invoke their private helpers as an
-- authenticated user.
revoke execute on function private.validate_menu_item()
  from public, anon, authenticated, service_role;
revoke execute on function private.assert_menu_payload(jsonb, boolean)
  from public, anon, authenticated, service_role;
revoke execute on function private.app_create_menu_item_impl(jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function private.app_update_menu_item_impl(uuid, jsonb)
  from public, anon, authenticated, service_role;

grant execute on function private.app_create_menu_item_impl(jsonb)
  to authenticated;
grant execute on function private.app_update_menu_item_impl(uuid, jsonb)
  to authenticated;

revoke execute on function public.internal_qr_get_menu(text)
  from public, anon, authenticated, service_role;
grant execute on function public.internal_qr_get_menu(text)
  to service_role;

comment on function public.internal_qr_get_menu(text) is
  'Service-only hash-token menu lookup with translated single-menu subcategories, VND-price item ordering, exact whole-table unpaid totals, at most 20 unfinalized current orders, and at most 40 snapshot lines per returned order.';
