-- Add structured combo menus without rewriting any existing menu, QR-order,
-- or paid-order row. A combo remains one sellable menu_items row; its child
-- rows describe what is included and are never counted as separate sales.

set lock_timeout = '5s';

alter table public.menu_items
  drop constraint if exists menu_items_qr_category_check;

alter table public.menu_items
  add constraint menu_items_qr_category_check
  check (
    qr_category is null
    or qr_category in ('combo', 'single', 'shared', 'snack', 'preorder', 'drink', 'cafe')
  );

create table public.menu_combo_components (
  id uuid primary key default gen_random_uuid(),
  combo_item_id uuid not null
    references public.menu_items (id) on delete cascade,
  component_kind text not null,
  source_menu_item_id uuid
    references public.menu_items (id) on delete restrict,
  qty integer not null default 1,
  fallback_ko_name text not null,
  fallback_vi_name text,
  fallback_en_name text,
  fallback_description_ko text,
  fallback_description_vi text,
  fallback_description_en text,
  reference_unit_usd integer,
  reference_unit_vnd integer,
  sort_order integer not null default 0,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint menu_combo_components_kind_check
    check (component_kind in ('menu', 'service')),
  constraint menu_combo_components_source_pair_check
    check (
      (component_kind = 'menu' and source_menu_item_id is not null)
      or (component_kind = 'service' and source_menu_item_id is null)
    ),
  constraint menu_combo_components_not_self_check
    check (source_menu_item_id is null or source_menu_item_id <> combo_item_id),
  constraint menu_combo_components_qty_check
    check (qty between 1 and 20),
  constraint menu_combo_components_price_check
    check (
      (reference_unit_usd is null or reference_unit_usd >= 0)
      and (reference_unit_vnd is null or reference_unit_vnd >= 0)
    ),
  constraint menu_combo_components_sort_check
    check (sort_order between 0 and 99999),
  constraint menu_combo_components_text_check
    check (
      length(btrim(fallback_ko_name)) between 1 and 200
      and length(coalesce(fallback_vi_name, '')) <= 200
      and length(coalesce(fallback_en_name, '')) <= 200
      and length(coalesce(fallback_description_ko, '')) <= 2000
      and length(coalesce(fallback_description_vi, '')) <= 2000
      and length(coalesce(fallback_description_en, '')) <= 2000
    )
);

create index menu_combo_components_combo_sort_idx
  on public.menu_combo_components (combo_item_id, sort_order, id);

create index menu_combo_components_source_idx
  on public.menu_combo_components (source_menu_item_id)
  where source_menu_item_id is not null;

create unique index menu_combo_components_unique_source_idx
  on public.menu_combo_components (combo_item_id, source_menu_item_id)
  where source_menu_item_id is not null;

alter table public.menu_combo_components enable row level security;

-- Keep the definition table explicitly closed to browser roles. The service
-- role reads it only inside the trusted Edge/RPC boundary and bypasses RLS.
create policy menu_combo_components_no_direct_client_access
  on public.menu_combo_components
  for all
  to anon, authenticated
  using (false)
  with check (false);

-- Existing rows receive NULL, so this is metadata-only and preserves every
-- open and historical order exactly as it is today.
alter table public.qr_order_items
  add column if not exists combo_snapshot jsonb;

alter table public.order_custom_items
  add column if not exists combo_snapshot jsonb;

alter table public.qr_order_items
  add constraint qr_order_items_combo_snapshot_check
  check (
    combo_snapshot is null
    or (
      pg_catalog.jsonb_typeof(combo_snapshot) = 'object'
      and pg_catalog.octet_length(combo_snapshot::text) <= 1048576
    )
  );

alter table public.order_custom_items
  add constraint order_custom_items_combo_snapshot_check
  check (
    combo_snapshot is null
    or (
      pg_catalog.jsonb_typeof(combo_snapshot) = 'object'
      and pg_catalog.octet_length(combo_snapshot::text) <= 1048576
    )
  );

comment on table public.menu_combo_components is
  'Admin-managed combo composition. Existing-menu rows resolve live metadata with stored fallback; service rows use the stored metadata directly.';
comment on column public.qr_order_items.combo_snapshot is
  'Immutable combo composition and regular/discount price snapshot captured when the QR line is first created.';
comment on column public.order_custom_items.combo_snapshot is
  'Paid-order copy of the QR combo snapshot; NULL for legacy and non-combo rows.';

-- Return one normalized shape to the guest menu, admin editor, and order
-- snapshot code. Existing menu references use current names, descriptions,
-- and prices, while fallback values keep the definition readable if optional
-- source fields are later cleared.
create function private.menu_combo_summary(p_combo_item_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with resolved as (
    select
      component.id,
      component.sort_order,
      component.component_kind as kind,
      component.source_menu_item_id,
      component.qty,
      coalesce(source.ko_name, component.fallback_ko_name) as name_ko,
      coalesce(source.en_name, component.fallback_en_name) as name_en,
      coalesce(source.vi_name, component.fallback_vi_name) as name_vi,
      coalesce(source.description_ko, component.fallback_description_ko) as description_ko,
      coalesce(source.description_en, component.fallback_description_en) as description_en,
      coalesce(source.description_vi, component.fallback_description_vi) as description_vi,
      source.image_url as image_url,
      case
        when component.component_kind = 'menu'
          then coalesce(source.price_usd, component.reference_unit_usd, 0)
        else coalesce(component.reference_unit_usd, 0)
      end as unit_price_usd,
      case
        when component.component_kind = 'menu'
          then coalesce(source.price_vnd, component.reference_unit_vnd, 0)
        else coalesce(component.reference_unit_vnd, 0)
      end as unit_price_vnd,
      component.reference_unit_usd as reference_price_usd,
      component.reference_unit_vnd as reference_price_vnd,
      case
        when component.component_kind = 'service' then true
        else source.id is not null
          and source.archived_at is null
          and source.is_active is true
          and source.is_orderable is true
          and source.is_sold_out is false
          and source.requires_preorder is false
      end as component_available
    from public.menu_combo_components as component
    left join public.menu_items as source
      on source.id = component.source_menu_item_id
    where component.combo_item_id = p_combo_item_id
  ), normalized as (
    select
      resolved.*,
      resolved.qty::bigint * resolved.unit_price_usd::bigint as line_regular_usd,
      resolved.qty::bigint * resolved.unit_price_vnd::bigint as line_regular_vnd
    from resolved
  ), aggregate as (
    select
      coalesce(
        pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'kind', normalized.kind,
            'is_service', normalized.kind = 'service',
            'menu_item_id', normalized.source_menu_item_id,
            'source_menu_item_id', normalized.source_menu_item_id,
            'qty', normalized.qty,
            'name_ko', normalized.name_ko,
            'name_en', normalized.name_en,
            'name_vi', normalized.name_vi,
            'description_ko', normalized.description_ko,
            'description_en', normalized.description_en,
            'description_vi', normalized.description_vi,
            'image_url', normalized.image_url,
            'is_available', normalized.component_available,
            'unit_price_usd', normalized.unit_price_usd,
            'unit_price_vnd', normalized.unit_price_vnd,
            'reference_price_usd', normalized.reference_price_usd,
            'reference_price_vnd', normalized.reference_price_vnd,
            'line_regular_usd', normalized.line_regular_usd,
            'line_regular_vnd', normalized.line_regular_vnd
          ) order by normalized.sort_order, normalized.id
        ),
        '[]'::jsonb
      ) as combo_components,
      coalesce(pg_catalog.sum(normalized.line_regular_usd), 0) as regular_price_usd,
      coalesce(pg_catalog.sum(normalized.line_regular_vnd), 0) as regular_price_vnd,
      coalesce(pg_catalog.bool_and(normalized.component_available), false) as components_available
    from normalized
  )
  select pg_catalog.jsonb_build_object(
    'combo_item_id', combo.id,
    'combo_components', aggregate.combo_components,
    'regular_price_usd', aggregate.regular_price_usd,
    'regular_price_vnd', aggregate.regular_price_vnd,
    'combo_price_usd', coalesce(combo.price_usd, 0),
    'combo_price_vnd', coalesce(combo.price_vnd, 0),
    'discount_usd', greatest(aggregate.regular_price_usd - coalesce(combo.price_usd, 0), 0),
    'discount_vnd', greatest(aggregate.regular_price_vnd - coalesce(combo.price_vnd, 0), 0),
    'components_available', aggregate.components_available,
    'pricing_valid', aggregate.regular_price_usd >= coalesce(combo.price_usd, 0)
      and aggregate.regular_price_vnd >= coalesce(combo.price_vnd, 0),
    'is_available', aggregate.components_available
      and aggregate.regular_price_usd >= coalesce(combo.price_usd, 0)
      and aggregate.regular_price_vnd >= coalesce(combo.price_vnd, 0),
    'discount_percent', case
      when aggregate.regular_price_vnd > 0 then pg_catalog.round(
        greatest(aggregate.regular_price_vnd - coalesce(combo.price_vnd, 0), 0)
          * 100.0 / aggregate.regular_price_vnd,
        1
      )
      else 0
    end
  )
  from public.menu_items as combo
  cross join aggregate
  where combo.id = p_combo_item_id
    and combo.qr_category = 'combo'
$$;

create function private.assert_menu_combo_summary(p_combo_item_id uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_summary jsonb := private.menu_combo_summary(p_combo_item_id);
  v_regular_usd numeric;
  v_regular_vnd numeric;
  v_combo_usd numeric;
  v_combo_vnd numeric;
begin
  if v_summary is null
     or pg_catalog.jsonb_array_length(v_summary -> 'combo_components') = 0 then
    raise exception using
      errcode = '22023',
      message = 'combo menu requires at least one component';
  end if;

  v_regular_usd := (v_summary ->> 'regular_price_usd')::numeric;
  v_regular_vnd := (v_summary ->> 'regular_price_vnd')::numeric;
  v_combo_usd := (v_summary ->> 'combo_price_usd')::numeric;
  v_combo_vnd := (v_summary ->> 'combo_price_vnd')::numeric;

  if v_regular_usd > 2147483647 or v_regular_vnd > 2147483647 then
    raise exception using errcode = '22003', message = 'combo regular total is out of range';
  end if;
  if v_combo_usd > v_regular_usd or v_combo_vnd > v_regular_vnd then
    raise exception using
      errcode = '22023',
      message = 'combo price must not exceed its regular component total';
  end if;
  return v_summary;
end;
$$;

-- Preserve the existing menu RPC signatures. combo_components is accepted as
-- an additional payload member and is written in the same transaction as the
-- parent menu row.
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
    'qr_subcategory', 'combo_components',
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
       'combo', 'single', 'shared', 'snack', 'preorder', 'drink', 'cafe'
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

  if p_payload ? 'combo_components'
     and (
       pg_catalog.jsonb_typeof(p_payload -> 'combo_components') <> 'array'
       or pg_catalog.jsonb_array_length(p_payload -> 'combo_components') not between 1 and 20
     ) then
    raise exception using
      errcode = '22023',
      message = 'combo_components must contain 1 to 20 rows';
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
  v_summary jsonb;
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

  if v_item.qr_category = 'combo' then
    if not (p_item ? 'combo_components') then
      raise exception using errcode = '22023', message = 'combo menu requires combo_components';
    end if;
    v_summary := private.replace_menu_combo_components(
      v_item.id,
      p_item -> 'combo_components'
    );
    return pg_catalog.to_jsonb(v_item) || v_summary;
  end if;

  if p_item ? 'combo_components' then
    raise exception using errcode = '22023', message = 'combo_components require the combo QR category';
  end if;
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
  v_before public.menu_items%rowtype;
  v_item public.menu_items%rowtype;
  v_summary jsonb;
begin
  if (select auth.uid()) is null
     or not public.has_app_role(array['admin']::text[]) then
    raise exception using errcode = '42501', message = 'admin role required';
  end if;
  if p_item_id is null then
    raise exception using errcode = '22023', message = 'menu item id is required';
  end if;
  perform private.assert_menu_payload(p_patch, false);

  select menu.*
  into v_before
  from public.menu_items as menu
  where menu.id = p_item_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'menu item not found';
  end if;

  update public.menu_items as menu
  set
    type = case when p_patch ? 'type' then p_patch ->> 'type' else menu.type end,
    ko_name = case when p_patch ? 'ko_name' then p_patch ->> 'ko_name' else menu.ko_name end,
    vi_name = case when p_patch ? 'vi_name' then p_patch ->> 'vi_name' else menu.vi_name end,
    en_name = case when p_patch ? 'en_name' then p_patch ->> 'en_name' else menu.en_name end,
    description_ko = case when p_patch ? 'description_ko' then p_patch ->> 'description_ko' else menu.description_ko end,
    description_vi = case when p_patch ? 'description_vi' then p_patch ->> 'description_vi' else menu.description_vi end,
    description_en = case when p_patch ? 'description_en' then p_patch ->> 'description_en' else menu.description_en end,
    price_usd = case when p_patch ? 'price_usd' then (p_patch ->> 'price_usd')::integer else menu.price_usd end,
    price_vnd = case when p_patch ? 'price_vnd' then (p_patch ->> 'price_vnd')::integer else menu.price_vnd end,
    image_url = case when p_patch ? 'image_url' then p_patch ->> 'image_url' else menu.image_url end,
    qr_category = case when p_patch ? 'qr_category' then p_patch ->> 'qr_category' else menu.qr_category end,
    qr_subcategory = case when p_patch ? 'qr_subcategory' then p_patch ->> 'qr_subcategory' else menu.qr_subcategory end,
    is_active = case when p_patch ? 'is_active' then (p_patch ->> 'is_active')::boolean else menu.is_active end,
    is_orderable = case when p_patch ? 'is_orderable' then (p_patch ->> 'is_orderable')::boolean else menu.is_orderable end,
    is_sold_out = case when p_patch ? 'is_sold_out' then (p_patch ->> 'is_sold_out')::boolean else menu.is_sold_out end,
    requires_preorder = case when p_patch ? 'requires_preorder' then (p_patch ->> 'requires_preorder')::boolean else menu.requires_preorder end,
    sort_order = case when p_patch ? 'sort_order' then (p_patch ->> 'sort_order')::integer else menu.sort_order end,
    updated_at = now()
  where menu.id = p_item_id
  returning menu.* into v_item;

  if v_item.qr_category = 'combo' then
    if exists (
      select 1
      from public.menu_combo_components as component
      where component.source_menu_item_id = v_item.id
    ) then
      raise exception using
        errcode = '22023',
        message = 'a menu used inside another combo cannot become a combo';
    end if;

    if p_patch ? 'combo_components' then
      v_summary := private.replace_menu_combo_components(
        v_item.id,
        p_patch -> 'combo_components'
      );
    elsif v_before.qr_category is distinct from 'combo' then
      raise exception using errcode = '22023', message = 'combo menu requires combo_components';
    else
      v_summary := private.assert_menu_combo_summary(v_item.id);
    end if;
    return pg_catalog.to_jsonb(v_item) || v_summary;
  end if;

  if p_patch ? 'combo_components' then
    raise exception using errcode = '22023', message = 'combo_components require the combo QR category';
  end if;

  -- Changing a combo back to a normal category removes only its current
  -- definition. Submitted and paid orders retain their JSON snapshots.
  if v_before.qr_category = 'combo' then
    delete from public.menu_combo_components as component
    where component.combo_item_id = v_item.id;
  end if;

  return pg_catalog.to_jsonb(v_item);
end;
$$;

create function private.app_get_menu_combo_components_impl(p_combo_item_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if (select auth.uid()) is null
     or not public.has_app_role(array['admin']::text[]) then
    raise exception using errcode = '42501', message = 'admin role required';
  end if;
  if p_combo_item_id is null then
    raise exception using errcode = '22023', message = 'combo menu id is required';
  end if;

  v_result := private.menu_combo_summary(p_combo_item_id);
  if v_result is null then
    raise exception using errcode = 'P0002', message = 'combo menu not found';
  end if;
  return v_result;
end;
$$;

create function public.app_get_menu_combo_components(p_combo_item_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select private.app_get_menu_combo_components_impl(p_combo_item_id)
$$;

create function private.replace_menu_combo_components(
  p_combo_item_id uuid,
  p_components jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_combo public.menu_items%rowtype;
  v_summary jsonb;
begin
  if p_combo_item_id is null then
    raise exception using errcode = '22023', message = 'combo menu id is required';
  end if;
  if p_components is null
     or pg_catalog.jsonb_typeof(p_components) <> 'array'
     or pg_catalog.jsonb_array_length(p_components) not between 1 and 20 then
    raise exception using
      errcode = '22023',
      message = 'combo_components must contain 1 to 20 rows';
  end if;

  select menu.*
  into v_combo
  from public.menu_items as menu
  where menu.id = p_combo_item_id
  for update;

  if not found or v_combo.qr_category is distinct from 'combo' then
    raise exception using errcode = '22023', message = 'combo parent menu is invalid';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_components) as entry(item)
    where pg_catalog.jsonb_typeof(entry.item) <> 'object'
       or pg_catalog.jsonb_typeof(entry.item -> 'kind') <> 'string'
       or entry.item ->> 'kind' not in ('menu', 'service')
       or not (entry.item ? 'qty')
       or pg_catalog.jsonb_typeof(entry.item -> 'qty') <> 'number'
       or coalesce(entry.item ->> 'qty', '') !~ '^[1-9][0-9]*$'
       or case
         when coalesce(entry.item ->> 'qty', '') ~ '^[1-9][0-9]*$'
           then (entry.item ->> 'qty')::numeric > 20
         else false
       end
       or (
         entry.item ->> 'kind' = 'menu'
         and (
           entry.item - array['kind', 'menu_item_id', 'qty']::text[] <> '{}'::jsonb
           or pg_catalog.jsonb_typeof(entry.item -> 'menu_item_id') <> 'string'
           or coalesce(entry.item ->> 'menu_item_id', '')
             !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         )
       )
       or (
         entry.item ->> 'kind' = 'service'
         and (
           entry.item - array[
             'kind', 'ko_name', 'vi_name', 'en_name',
             'description_ko', 'description_vi', 'description_en',
             'qty', 'original_price_usd', 'original_price_vnd'
           ]::text[] <> '{}'::jsonb
           or pg_catalog.jsonb_typeof(entry.item -> 'ko_name') <> 'string'
           or length(btrim(coalesce(entry.item ->> 'ko_name', ''))) not between 1 and 200
           or length(coalesce(entry.item ->> 'vi_name', '')) > 200
           or length(coalesce(entry.item ->> 'en_name', '')) > 200
           or length(coalesce(entry.item ->> 'description_ko', '')) > 2000
           or length(coalesce(entry.item ->> 'description_vi', '')) > 2000
           or length(coalesce(entry.item ->> 'description_en', '')) > 2000
           or exists (
             select 1
             from pg_catalog.jsonb_each(entry.item) as field(key, value)
             where field.key in (
               'vi_name', 'en_name', 'description_ko',
               'description_vi', 'description_en'
             )
               and pg_catalog.jsonb_typeof(field.value) not in ('string', 'null')
           )
           or exists (
             select 1
             from pg_catalog.jsonb_each(entry.item) as field(key, value)
             where field.key in ('original_price_usd', 'original_price_vnd')
               and (
                 pg_catalog.jsonb_typeof(field.value) not in ('number', 'null')
                 or case
                   when pg_catalog.jsonb_typeof(field.value) = 'number'
                     then field.value #>> '{}' !~ '^[0-9]+$'
                       or (field.value #>> '{}')::numeric > 2147483647
                   else false
                 end
               )
           )
         )
       )
  ) then
    raise exception using errcode = '22023', message = 'combo contains an invalid component';
  end if;

  if (
    select coalesce(pg_catalog.sum((entry.item ->> 'qty')::integer), 0)
    from pg_catalog.jsonb_array_elements(p_components) as entry(item)
  ) > 100 then
    raise exception using errcode = '22023', message = 'combo component quantity is too large';
  end if;

  if (
    select pg_catalog.count(*)
    from pg_catalog.jsonb_array_elements(p_components) as entry(item)
    where entry.item ->> 'kind' = 'menu'
  ) <> (
    select pg_catalog.count(distinct (entry.item ->> 'menu_item_id')::uuid)
    from pg_catalog.jsonb_array_elements(p_components) as entry(item)
    where entry.item ->> 'kind' = 'menu'
  ) then
    raise exception using errcode = '22023', message = 'duplicate combo menu components are not allowed';
  end if;

  -- Lock referenced menus in UUID order so their fallback snapshots are
  -- copied from one stable server-authoritative version.
  perform source.id
  from public.menu_items as source
  join pg_catalog.jsonb_array_elements(p_components) as entry(item)
    on entry.item ->> 'kind' = 'menu'
   and source.id = (entry.item ->> 'menu_item_id')::uuid
  order by source.id
  for share of source;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_components) as entry(item)
    left join public.menu_items as source
      on entry.item ->> 'kind' = 'menu'
     and source.id = (entry.item ->> 'menu_item_id')::uuid
    where entry.item ->> 'kind' = 'menu'
      and (
        source.id is null
        or source.id = p_combo_item_id
        or source.qr_category = 'combo'
        or source.archived_at is not null
        or source.price_usd is null
        or source.price_vnd is null
        or source.price_usd < 0
        or source.price_vnd < 0
        or length(btrim(coalesce(source.ko_name, ''))) = 0
      )
  ) then
    raise exception using errcode = '22023', message = 'combo references an unavailable menu item';
  end if;

  delete from public.menu_combo_components as component
  where component.combo_item_id = p_combo_item_id;

  insert into public.menu_combo_components (
    combo_item_id,
    component_kind,
    source_menu_item_id,
    qty,
    fallback_ko_name,
    fallback_vi_name,
    fallback_en_name,
    fallback_description_ko,
    fallback_description_vi,
    fallback_description_en,
    reference_unit_usd,
    reference_unit_vnd,
    sort_order,
    created_at,
    updated_at
  )
  select
    p_combo_item_id,
    entry.item ->> 'kind',
    case when entry.item ->> 'kind' = 'menu' then source.id else null end,
    (entry.item ->> 'qty')::integer,
    case
      when entry.item ->> 'kind' = 'menu' then source.ko_name
      else btrim(entry.item ->> 'ko_name')
    end,
    case
      when entry.item ->> 'kind' = 'menu' then source.vi_name
      else nullif(btrim(entry.item ->> 'vi_name'), '')
    end,
    case
      when entry.item ->> 'kind' = 'menu' then source.en_name
      else nullif(btrim(entry.item ->> 'en_name'), '')
    end,
    case
      when entry.item ->> 'kind' = 'menu' then source.description_ko
      else nullif(btrim(entry.item ->> 'description_ko'), '')
    end,
    case
      when entry.item ->> 'kind' = 'menu' then source.description_vi
      else nullif(btrim(entry.item ->> 'description_vi'), '')
    end,
    case
      when entry.item ->> 'kind' = 'menu' then source.description_en
      else nullif(btrim(entry.item ->> 'description_en'), '')
    end,
    case
      when entry.item ->> 'kind' = 'menu' then source.price_usd
      else (entry.item ->> 'original_price_usd')::integer
    end,
    case
      when entry.item ->> 'kind' = 'menu' then source.price_vnd
      else (entry.item ->> 'original_price_vnd')::integer
    end,
    ((entry.ordinality - 1) * 10)::integer,
    now(),
    now()
  from pg_catalog.jsonb_array_elements(p_components)
    with ordinality as entry(item, ordinality)
  left join public.menu_items as source
    on entry.item ->> 'kind' = 'menu'
   and source.id = (entry.item ->> 'menu_item_id')::uuid;

  v_summary := private.assert_menu_combo_summary(p_combo_item_id);
  return v_summary;
end;
$$;

-- Based on the latest guest-table-total/subcategory definition. The combo
-- category is first, and only combo rows receive the additive pricing/detail
-- fields. Legacy item and current-order keys stay unchanged.
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

  select table_row.*
  into v_table
  from public.qr_tables as table_row
  join private.qr_table_tokens as tokens on tokens.table_id = table_row.id
  where tokens.token_hash = p_token_hash
    and table_row.is_active = true;

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
        'id', menu.id,
        'type', menu.type,
        'ko_name', menu.ko_name,
        'vi_name', menu.vi_name,
        'en_name', menu.en_name,
        'description_ko', menu.description_ko,
        'description_vi', menu.description_vi,
        'description_en', menu.description_en,
        'price_usd', menu.price_usd,
        'price_vnd', menu.price_vnd,
        'image_url', menu.image_url,
        'qr_category', menu.qr_category,
        'qr_subcategory', menu.qr_subcategory,
        'is_active', menu.is_active,
        'is_orderable', menu.is_orderable,
        'is_sold_out', menu.is_sold_out,
        'requires_preorder', menu.requires_preorder,
        'sort_order', menu.sort_order
      ) || case
        when menu.qr_category = 'combo'
          then coalesce(combo.summary, '{}'::jsonb)
        else '{}'::jsonb
      end
      order by
        case menu.qr_category
          when 'combo' then 0
          when 'single' then 10
          when 'shared' then 20
          when 'snack' then 30
          when 'preorder' then 40
          when 'drink' then 50
          when 'cafe' then 60
          else 900
        end,
        coalesce(menu.price_vnd, 2147483647),
        coalesce(menu.sort_order, 2147483647),
        menu.type,
        menu.ko_name,
        menu.id
    ),
    '[]'::jsonb
  )
  into v_items
  from public.menu_items as menu
  left join lateral (
    select private.menu_combo_summary(menu.id) as summary
  ) as combo on menu.qr_category = 'combo'
  where menu.is_active = true;

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
              'line_vnd', line.line_vnd,
              'combo_snapshot', line.combo_snapshot
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
              item.combo_snapshot,
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
        'id', 'combo', 'name_ko', '콤보 메뉴',
        'name_en', 'Combo menu', 'name_vi', 'Combo', 'sort_order', 0
      ),
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

-- Guest input still contains only {menu_item_id, qty}. The database prices the
-- combo parent as one sale line and captures its resolved composition once.
create or replace function public.internal_qr_submit_order(
  p_token_hash text,
  p_client_request_id uuid,
  p_note text,
  p_items jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_table public.qr_tables%rowtype;
  v_existing public.qr_orders%rowtype;
  v_order public.qr_orders%rowtype;
  v_line_count integer;
  v_total_qty bigint;
  v_total_usd bigint;
  v_total_vnd bigint;
  v_note text := nullif(btrim(p_note), '');
  v_request_hash text;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'invalid table token';
  end if;
  if p_client_request_id is null then
    raise exception using errcode = '22023', message = 'client request id is required';
  end if;
  if p_note is not null
     and (length(p_note) > 500 or p_note ~ '[[:cntrl:]]') then
    raise exception using errcode = '22023', message = 'order note is invalid';
  end if;
  if p_items is null
     or pg_catalog.jsonb_typeof(p_items) <> 'array'
     or pg_catalog.jsonb_array_length(p_items) not between 1 and 40 then
    raise exception using errcode = '22023', message = 'order must contain 1 to 40 lines';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_items) as entry(item)
    where pg_catalog.jsonb_typeof(entry.item) <> 'object'
       or entry.item - 'menu_item_id' - 'qty' <> '{}'::jsonb
       or coalesce(entry.item ->> 'menu_item_id', '')
          !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or coalesce(entry.item ->> 'qty', '') !~ '^[1-9][0-9]*$'
       or case
         when coalesce(entry.item ->> 'qty', '') ~ '^[1-9][0-9]*$'
           then (entry.item ->> 'qty')::numeric > 20
         else false
       end
  ) then
    raise exception using errcode = '22023', message = 'order contains an invalid line';
  end if;

  if (
    select pg_catalog.count(distinct entry.item ->> 'menu_item_id')
    from pg_catalog.jsonb_array_elements(p_items) as entry(item)
  ) <> pg_catalog.jsonb_array_length(p_items) then
    raise exception using errcode = '22023', message = 'duplicate menu items are not allowed';
  end if;

  select table_row.*
  into v_table
  from public.qr_tables as table_row
  join private.qr_table_tokens as tokens on tokens.table_id = table_row.id
  where tokens.token_hash = p_token_hash
    and table_row.is_active = true
  for share of table_row, tokens;

  if not found then
    raise exception using errcode = '22023', message = 'invalid or inactive table token';
  end if;

  if not public.internal_qr_take_rate_limit(
    private.qr_sha256('submit_order:table:' || p_token_hash),
    60,
    60
  ) then
    raise exception using errcode = 'P0001', message = 'QR rate limit exceeded';
  end if;

  -- Lock requested parents first, then their component/source rows in a fixed
  -- order. Admin combo edits update the same parent row, so the snapshot and
  -- authoritative combo price always come from one committed definition.
  perform menu.id
  from public.menu_items as menu
  join pg_catalog.jsonb_array_elements(p_items) as entry(item)
    on menu.id = (entry.item ->> 'menu_item_id')::uuid
  order by menu.id
  for share of menu;

  perform component.id
  from public.menu_combo_components as component
  join pg_catalog.jsonb_array_elements(p_items) as entry(item)
    on component.combo_item_id = (entry.item ->> 'menu_item_id')::uuid
  order by component.combo_item_id, component.sort_order, component.id
  for share of component;

  perform source.id
  from public.menu_items as source
  join public.menu_combo_components as component
    on component.source_menu_item_id = source.id
  join pg_catalog.jsonb_array_elements(p_items) as entry(item)
    on component.combo_item_id = (entry.item ->> 'menu_item_id')::uuid
  order by source.id
  for share of source;

  v_request_hash := private.qr_sha256(
    p_token_hash || ':' || p_client_request_id::text || ':'
    || coalesce(v_note, '') || ':' || p_items::text
  );

  select qr_order.*
  into v_existing
  from public.qr_orders as qr_order
  where qr_order.table_id = v_table.id
    and qr_order.client_request_id = p_client_request_id;

  if found then
    if v_existing.request_hash <> v_request_hash then
      raise exception using
        errcode = '23505',
        message = 'idempotency key was reused with a different order';
    end if;
    return (pg_catalog.to_jsonb(v_existing) - 'request_hash')
      || pg_catalog.jsonb_build_object(
        'table_label', v_table.label,
        'idempotent', true
      );
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_items) as entry(item)
    left join public.menu_items as menu
      on menu.id = (entry.item ->> 'menu_item_id')::uuid
    where menu.id is null
       or menu.archived_at is not null
       or menu.is_active is distinct from true
       or menu.is_orderable is distinct from true
       or menu.is_sold_out is distinct from false
       or menu.requires_preorder is distinct from false
       or menu.price_usd is null
       or menu.price_vnd is null
       or menu.price_usd < 0
       or menu.price_vnd < 0
       or (
         menu.qr_category = 'combo'
         and (
           private.menu_combo_summary(menu.id) is null
           or pg_catalog.jsonb_array_length(
             private.menu_combo_summary(menu.id) -> 'combo_components'
           ) = 0
           or coalesce(
             (private.menu_combo_summary(menu.id) ->> 'is_available')::boolean,
             false
           ) is not true
         )
       )
  ) then
    raise exception using errcode = '22023', message = 'order contains an unavailable menu item';
  end if;

  select
    pg_catalog.count(*)::integer,
    coalesce(pg_catalog.sum((entry.item ->> 'qty')::bigint), 0),
    coalesce(pg_catalog.sum((entry.item ->> 'qty')::bigint * menu.price_usd::bigint), 0),
    coalesce(pg_catalog.sum((entry.item ->> 'qty')::bigint * menu.price_vnd::bigint), 0)
  into v_line_count, v_total_qty, v_total_usd, v_total_vnd
  from pg_catalog.jsonb_array_elements(p_items) as entry(item)
  join public.menu_items as menu
    on menu.id = (entry.item ->> 'menu_item_id')::uuid;

  if v_line_count <> pg_catalog.jsonb_array_length(p_items)
     or v_total_qty > 100
     or v_total_usd > 2147483647
     or v_total_vnd > 2147483647 then
    raise exception using errcode = '22023', message = 'order quantity or total is too large';
  end if;

  insert into public.qr_orders (
    table_id,
    client_request_id,
    request_hash,
    status,
    note,
    total_usd,
    total_vnd
  )
  values (
    v_table.id,
    p_client_request_id,
    v_request_hash,
    'submitted',
    v_note,
    v_total_usd::integer,
    v_total_vnd::integer
  )
  on conflict (table_id, client_request_id) do nothing
  returning * into v_order;

  if not found then
    select qr_order.*
    into strict v_existing
    from public.qr_orders as qr_order
    where qr_order.table_id = v_table.id
      and qr_order.client_request_id = p_client_request_id;

    if v_existing.request_hash <> v_request_hash then
      raise exception using
        errcode = '23505',
        message = 'idempotency key was reused with a different order';
    end if;
    return (pg_catalog.to_jsonb(v_existing) - 'request_hash')
      || pg_catalog.jsonb_build_object(
        'table_label', v_table.label,
        'idempotent', true
      );
  end if;

  insert into public.qr_order_items (
    qr_order_id,
    menu_item_id,
    qty,
    menu_type,
    ko_name,
    vi_name,
    en_name,
    unit_usd,
    unit_vnd,
    line_usd,
    line_vnd,
    combo_snapshot
  )
  select
    v_order.id,
    menu.id,
    (entry.item ->> 'qty')::integer,
    menu.type,
    menu.ko_name,
    menu.vi_name,
    menu.en_name,
    menu.price_usd,
    menu.price_vnd,
    ((entry.item ->> 'qty')::bigint * menu.price_usd::bigint)::integer,
    ((entry.item ->> 'qty')::bigint * menu.price_vnd::bigint)::integer,
    case
      when menu.qr_category = 'combo' then
        pg_catalog.jsonb_build_object('version', 1)
          || private.menu_combo_summary(menu.id)
      else null
    end
  from pg_catalog.jsonb_array_elements(p_items) as entry(item)
  join public.menu_items as menu
    on menu.id = (entry.item ->> 'menu_item_id')::uuid;

  return (pg_catalog.to_jsonb(v_order) - 'request_hash')
    || pg_catalog.jsonb_build_object(
      'table_label', v_table.label,
      'idempotent', false
    );
end;
$$;

-- Existing QR lines keep their first captured price/name/composition. Staff
-- quantity changes therefore cannot silently adopt a later combo definition;
-- only a newly added combo line receives a new server snapshot.
create or replace function private.app_update_qr_order_impl(
  p_order_id uuid,
  p_expected_updated_at timestamp with time zone,
  p_note text,
  p_items jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_role text := public.current_app_role();
  v_order public.qr_orders%rowtype;
  v_note text := nullif(pg_catalog.btrim(p_note), '');
  v_lines jsonb;
  v_line_count integer;
  v_total_qty bigint;
  v_total_usd bigint;
  v_total_vnd bigint;
begin
  if (select auth.uid()) is null
     or v_role is null
     or v_role not in ('staff', 'admin') then
    raise exception using
      errcode = '42501',
      message = 'staff or admin role required';
  end if;

  if p_order_id is null then
    raise exception using errcode = '22023', message = 'QR order id is required';
  end if;
  if p_expected_updated_at is null then
    raise exception using
      errcode = '22023',
      message = 'expected QR order version is required';
  end if;
  if p_note is not null
     and (
       pg_catalog.length(p_note) > 500
       or p_note ~ '[[:cntrl:]]'
     ) then
    raise exception using errcode = '22023', message = 'order note is invalid';
  end if;
  if p_items is null
     or pg_catalog.jsonb_typeof(p_items) <> 'array'
     or pg_catalog.jsonb_array_length(p_items) not between 1 and 40 then
    raise exception using
      errcode = '22023',
      message = 'order must contain 1 to 40 lines';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_items) as entry(item)
    where pg_catalog.jsonb_typeof(entry.item) <> 'object'
       or entry.item - 'menu_item_id' - 'qty' <> '{}'::jsonb
       or pg_catalog.jsonb_typeof(entry.item -> 'menu_item_id') <> 'string'
       or pg_catalog.jsonb_typeof(entry.item -> 'qty') <> 'number'
       or coalesce(entry.item ->> 'menu_item_id', '')
          !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or coalesce(entry.item ->> 'qty', '') !~ '^[1-9][0-9]*$'
       or case
         when coalesce(entry.item ->> 'qty', '') ~ '^[1-9][0-9]*$'
           then (entry.item ->> 'qty')::numeric > 20
         else false
       end
  ) then
    raise exception using errcode = '22023', message = 'order contains an invalid line';
  end if;

  if (
    select pg_catalog.count(distinct (entry.item ->> 'menu_item_id')::uuid)
    from pg_catalog.jsonb_array_elements(p_items) as entry(item)
  ) <> pg_catalog.jsonb_array_length(p_items) then
    raise exception using
      errcode = '22023',
      message = 'duplicate menu items are not allowed';
  end if;

  select qr_order.*
  into v_order
  from public.qr_orders as qr_order
  where qr_order.id = p_order_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'QR order not found';
  end if;
  if v_order.updated_at is distinct from p_expected_updated_at then
    raise exception using
      errcode = '55000',
      message = 'QR order changed after this edit screen was opened';
  end if;
  if v_order.status not in ('submitted', 'accepted')
     or v_order.finalized_order_id is not null then
    raise exception using
      errcode = '55000',
      message = 'only open, unfinalized QR orders can be edited';
  end if;

  select coalesce(pg_catalog.sum((entry.item ->> 'qty')::bigint), 0)
  into v_total_qty
  from pg_catalog.jsonb_array_elements(p_items) as entry(item);

  if v_total_qty > 100 then
    raise exception using
      errcode = '22023',
      message = 'order quantity is too large';
  end if;

  perform menu.id
  from public.menu_items as menu
  join pg_catalog.jsonb_array_elements(p_items) as entry(item)
    on menu.id = (entry.item ->> 'menu_item_id')::uuid
  order by menu.id
  for share of menu;

  perform component.id
  from public.menu_combo_components as component
  join pg_catalog.jsonb_array_elements(p_items) as entry(item)
    on component.combo_item_id = (entry.item ->> 'menu_item_id')::uuid
  left join public.qr_order_items as old_line
    on old_line.qr_order_id = v_order.id
   and old_line.menu_item_id = component.combo_item_id
  where old_line.id is null
  order by component.combo_item_id, component.sort_order, component.id
  for share of component;

  perform source.id
  from public.menu_items as source
  join public.menu_combo_components as component
    on component.source_menu_item_id = source.id
  join pg_catalog.jsonb_array_elements(p_items) as entry(item)
    on component.combo_item_id = (entry.item ->> 'menu_item_id')::uuid
  left join public.qr_order_items as old_line
    on old_line.qr_order_id = v_order.id
   and old_line.menu_item_id = component.combo_item_id
  where old_line.id is null
  order by source.id
  for share of source;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_items) as entry(item)
    left join public.qr_order_items as old_line
      on old_line.qr_order_id = v_order.id
     and old_line.menu_item_id = (entry.item ->> 'menu_item_id')::uuid
    left join public.menu_items as menu
      on menu.id = (entry.item ->> 'menu_item_id')::uuid
    where old_line.id is null
      and (
        menu.id is null
        or menu.archived_at is not null
        or menu.is_active is distinct from true
        or menu.is_orderable is distinct from true
        or menu.is_sold_out is distinct from false
        or menu.requires_preorder is distinct from false
        or menu.price_usd is null
        or menu.price_vnd is null
        or menu.price_usd < 0
        or menu.price_vnd < 0
        or pg_catalog.length(pg_catalog.btrim(coalesce(menu.type, ''))) = 0
        or pg_catalog.length(pg_catalog.btrim(coalesce(menu.ko_name, ''))) = 0
        or (
          menu.qr_category = 'combo'
          and (
            private.menu_combo_summary(menu.id) is null
            or pg_catalog.jsonb_array_length(
              private.menu_combo_summary(menu.id) -> 'combo_components'
            ) = 0
            or coalesce(
              (private.menu_combo_summary(menu.id) ->> 'is_available')::boolean,
              false
            ) is not true
          )
        )
      )
  ) then
    raise exception using
      errcode = '22023',
      message = 'order contains an unavailable menu item';
  end if;

  with requested as (
    select
      (entry.item ->> 'menu_item_id')::uuid as menu_item_id,
      (entry.item ->> 'qty')::integer as qty,
      entry.ordinality
    from pg_catalog.jsonb_array_elements(p_items)
      with ordinality as entry(item, ordinality)
  ), snapshots as (
    select
      requested.menu_item_id,
      requested.qty,
      case when old_line.id is not null then old_line.menu_type else menu.type end as menu_type,
      case when old_line.id is not null then old_line.ko_name else menu.ko_name end as ko_name,
      case when old_line.id is not null then old_line.vi_name else menu.vi_name end as vi_name,
      case when old_line.id is not null then old_line.en_name else menu.en_name end as en_name,
      case when old_line.id is not null then old_line.unit_usd else menu.price_usd end as unit_usd,
      case when old_line.id is not null then old_line.unit_vnd else menu.price_vnd end as unit_vnd,
      case
        when old_line.id is not null then old_line.combo_snapshot
        when menu.qr_category = 'combo' then
          pg_catalog.jsonb_build_object('version', 1)
            || private.menu_combo_summary(menu.id)
        else null
      end as combo_snapshot,
      case when old_line.id is not null then old_line.created_at else now() end as created_at,
      requested.ordinality
    from requested
    left join public.qr_order_items as old_line
      on old_line.qr_order_id = v_order.id
     and old_line.menu_item_id = requested.menu_item_id
    left join public.menu_items as menu
      on menu.id = requested.menu_item_id
  )
  select
    coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'menu_item_id', snapshots.menu_item_id,
          'qty', snapshots.qty,
          'menu_type', snapshots.menu_type,
          'ko_name', snapshots.ko_name,
          'vi_name', snapshots.vi_name,
          'en_name', snapshots.en_name,
          'unit_usd', snapshots.unit_usd,
          'unit_vnd', snapshots.unit_vnd,
          'line_usd', snapshots.qty::bigint * snapshots.unit_usd::bigint,
          'line_vnd', snapshots.qty::bigint * snapshots.unit_vnd::bigint,
          'combo_snapshot', snapshots.combo_snapshot,
          'created_at', snapshots.created_at
        ) order by snapshots.ordinality
      ),
      '[]'::jsonb
    ),
    pg_catalog.count(*)::integer,
    coalesce(pg_catalog.sum(snapshots.qty::bigint * snapshots.unit_usd::bigint), 0),
    coalesce(pg_catalog.sum(snapshots.qty::bigint * snapshots.unit_vnd::bigint), 0)
  into v_lines, v_line_count, v_total_usd, v_total_vnd
  from snapshots;

  if v_line_count <> pg_catalog.jsonb_array_length(p_items)
     or v_total_usd > 2147483647
     or v_total_vnd > 2147483647 then
    raise exception using
      errcode = '22023',
      message = 'order total is too large';
  end if;

  delete from public.qr_order_items as old_line
  where old_line.qr_order_id = v_order.id;

  insert into public.qr_order_items (
    qr_order_id,
    menu_item_id,
    qty,
    menu_type,
    ko_name,
    vi_name,
    en_name,
    unit_usd,
    unit_vnd,
    line_usd,
    line_vnd,
    combo_snapshot,
    created_at
  )
  select
    v_order.id,
    line.menu_item_id,
    line.qty,
    line.menu_type,
    line.ko_name,
    line.vi_name,
    line.en_name,
    line.unit_usd,
    line.unit_vnd,
    line.line_usd,
    line.line_vnd,
    line.combo_snapshot,
    line.created_at
  from pg_catalog.jsonb_to_recordset(v_lines) as line(
    menu_item_id uuid,
    qty integer,
    menu_type text,
    ko_name text,
    vi_name text,
    en_name text,
    unit_usd integer,
    unit_vnd integer,
    line_usd integer,
    line_vnd integer,
    combo_snapshot jsonb,
    created_at timestamp with time zone
  );

  update public.qr_orders as qr_order
  set
    note = v_note,
    total_usd = v_total_usd::integer,
    total_vnd = v_total_vnd::integer,
    updated_at = now()
  where qr_order.id = v_order.id
  returning qr_order.* into v_order;

  return (pg_catalog.to_jsonb(v_order) - 'request_hash')
    || pg_catalog.jsonb_build_object('line_count', v_line_count);
end;
$$;

-- Consolidated table checkout still creates one paid line per QR line. Copy
-- the immutable combo metadata with that line; it never affects sale totals.
create or replace function private.app_finalize_qr_table_orders_checked_impl(
  p_table_id uuid,
  p_expected_orders jsonb,
  p_payment_method text,
  p_guide_name text,
  p_team_no text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_table public.qr_tables%rowtype;
  v_paid_order public.orders%rowtype;
  v_payment_choice text := pg_catalog.lower(
    coalesce(nullif(pg_catalog.btrim(p_payment_method), ''), 'cash')
  );
  v_payment_method text;
  v_guide_name text := nullif(pg_catalog.btrim(p_guide_name), '');
  v_team_no text := nullif(pg_catalog.btrim(p_team_no), '');
  v_expected_ids uuid[];
  v_expected_versions timestamp with time zone[];
  v_expected_count integer;
  v_distinct_expected_count integer;
  v_expected_row_count integer;
  v_finalized_count integer;
  v_existing_paid_ids uuid[];
  v_existing_paid_id uuid;
  v_linked_ids uuid[];
  v_choice_matches boolean;
  v_actual_ids uuid[];
  v_actual_versions timestamp with time zone[];
  v_base_usd bigint;
  v_base_vnd bigint;
  v_paid_usd bigint;
  v_paid_vnd bigint;
  v_fee_usd bigint := 0;
  v_fee_vnd bigint := 0;
  v_updated_count integer;
  v_finalized_at timestamp with time zone := now();
begin
  if (select auth.uid()) is null
     or not public.has_app_role(array['staff', 'admin']::text[]) then
    raise exception using errcode = '42501', message = 'staff or admin role required';
  end if;
  if p_table_id is null then
    raise exception using errcode = '22023', message = 'QR table id is required';
  end if;
  if v_payment_choice not in ('cash', 'card', 'card_fee7', 'bank') then
    raise exception using errcode = '22023', message = 'invalid payment method';
  end if;
  v_payment_method := case
    when v_payment_choice = 'card_fee7' then 'card'
    else v_payment_choice
  end;
  if pg_catalog.length(coalesce(p_guide_name, '')) > 200
     or pg_catalog.length(coalesce(p_team_no, '')) > 200 then
    raise exception using errcode = '22023', message = 'order metadata is too long';
  end if;
  if p_expected_orders is null
     or pg_catalog.jsonb_typeof(p_expected_orders) <> 'array'
     or pg_catalog.jsonb_array_length(p_expected_orders) not between 1 and 200 then
    raise exception using
      errcode = '22023',
      message = 'expected QR orders must contain 1 to 200 rows';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_expected_orders) as expected(item)
    where pg_catalog.jsonb_typeof(expected.item) <> 'object'
       or not (expected.item ? 'id')
       or not (expected.item ? 'updated_at')
       or expected.item - 'id' - 'updated_at' <> '{}'::jsonb
       or pg_catalog.jsonb_typeof(expected.item -> 'id') <> 'string'
       or pg_catalog.jsonb_typeof(expected.item -> 'updated_at') <> 'string'
       or coalesce(expected.item ->> 'id', '')
          !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or pg_catalog.length(coalesce(expected.item ->> 'updated_at', '')) not between 20 and 40
  ) then
    raise exception using errcode = '22023', message = 'expected QR order row is invalid';
  end if;

  begin
    select
      pg_catalog.array_agg(
        (expected.item ->> 'id')::uuid
        order by (expected.item ->> 'id')::uuid
      ),
      pg_catalog.array_agg(
        (expected.item ->> 'updated_at')::timestamp with time zone
        order by (expected.item ->> 'id')::uuid
      )
    into v_expected_ids, v_expected_versions
    from pg_catalog.jsonb_array_elements(p_expected_orders) as expected(item);
  exception
    when sqlstate '22P02' or sqlstate '22007' or sqlstate '22008' then
      raise exception using errcode = '22023', message = 'expected QR order row is invalid';
  end;

  select pg_catalog.count(*)::integer,
         pg_catalog.count(distinct expected_id)::integer
  into v_expected_count, v_distinct_expected_count
  from pg_catalog.unnest(v_expected_ids) as expected_id;

  if v_expected_count <> v_distinct_expected_count then
    raise exception using errcode = '22023', message = 'duplicate expected QR orders are not allowed';
  end if;

  -- The table lock conflicts with the guest submit path's FOR SHARE lock. Once
  -- acquired, no new order can slip between the exact-set check and checkout.
  select table_row.*
  into v_table
  from public.qr_tables as table_row
  where table_row.id = p_table_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'QR table not found';
  end if;

  -- Lock every row that can affect this attempt in UUID order. Staff status
  -- changes and edits that already started finish first; later ones wait.
  perform qr_order.id
  from public.qr_orders as qr_order
  where qr_order.table_id = v_table.id
    and (
      qr_order.id = any(v_expected_ids)
      or (
        qr_order.finalized_order_id is null
        and qr_order.status in ('submitted', 'accepted')
      )
    )
  order by qr_order.id
  for update;

  select
    pg_catalog.count(*)::integer,
    pg_catalog.count(*) filter (
      where qr_order.finalized_order_id is not null
    )::integer,
    pg_catalog.array_agg(distinct qr_order.finalized_order_id) filter (
      where qr_order.finalized_order_id is not null
    )
  into v_expected_row_count, v_finalized_count, v_existing_paid_ids
  from public.qr_orders as qr_order
  where qr_order.table_id = v_table.id
    and qr_order.id = any(v_expected_ids);

  if v_expected_row_count <> v_expected_count then
    raise exception using
      errcode = '55000',
      message = 'QR table orders changed after checkout was opened; reload before payment';
  end if;

  -- A network retry carries the pre-checkout timestamps. If the exact same QR
  -- set already points at one live paid sale with identical details, return it
  -- rather than creating a duplicate. New orders placed after that sale do not
  -- change the meaning of this already-completed request.
  if v_finalized_count = v_expected_count then
    if pg_catalog.cardinality(v_existing_paid_ids) <> 1 then
      raise exception using
        errcode = '55000',
        message = 'expected QR orders were finalized into different paid orders';
    end if;

    v_existing_paid_id := v_existing_paid_ids[1];

    perform qr_order.id
    from public.qr_orders as qr_order
    where qr_order.finalized_order_id = v_existing_paid_id
    order by qr_order.id
    for update;

    select pg_catalog.array_agg(qr_order.id order by qr_order.id)
    into v_linked_ids
    from public.qr_orders as qr_order
    where qr_order.finalized_order_id = v_existing_paid_id;

    if v_linked_ids is distinct from v_expected_ids then
      raise exception using
        errcode = '55000',
        message = 'paid order QR set does not match this checkout request';
    end if;

    select pg_catalog.bool_and(
      qr_order.finalized_payment_choice is not distinct from v_payment_choice
    )
    into v_choice_matches
    from public.qr_orders as qr_order
    where qr_order.id = any(v_expected_ids);

    select paid_order.*
    into v_paid_order
    from public.orders as paid_order
    where paid_order.id = v_existing_paid_id;

    if not found then
      raise exception using
        errcode = '55000',
        message = 'finalized QR orders reference a missing paid order';
    end if;
    if v_choice_matches is distinct from true
       or pg_catalog.lower(v_paid_order.payment_method) is distinct from v_payment_method
       or v_paid_order.guide_name is distinct from v_guide_name
       or v_paid_order.team_no is distinct from v_team_no then
      raise exception using
        errcode = '55000',
        message = 'QR table was already finalized with different payment details';
    end if;

    return v_existing_paid_id;
  elsif v_finalized_count <> 0 then
    raise exception using
      errcode = '55000',
      message = 'some QR table orders were already finalized; reload before payment';
  end if;

  if exists (
    select 1
    from public.qr_orders as qr_order
    where qr_order.table_id = v_table.id
      and qr_order.status = 'submitted'
      and qr_order.finalized_order_id is null
  ) then
    raise exception using
      errcode = '55000',
      message = 'unconfirmed QR orders remain for this table';
  end if;

  select
    pg_catalog.array_agg(qr_order.id order by qr_order.id),
    pg_catalog.array_agg(qr_order.updated_at order by qr_order.id)
  into v_actual_ids, v_actual_versions
  from public.qr_orders as qr_order
  where qr_order.table_id = v_table.id
    and qr_order.status = 'accepted'
    and qr_order.finalized_order_id is null;

  if v_actual_ids is distinct from v_expected_ids
     or v_actual_versions is distinct from v_expected_versions then
    raise exception using
      errcode = '55000',
      message = 'QR table orders changed after checkout was opened; reload before payment';
  end if;

  -- Validate every order total against its immutable item snapshots before
  -- using the stored order totals as the table subtotal.
  if exists (
    select 1
    from public.qr_orders as qr_order
    cross join lateral (
      select
        pg_catalog.count(*)::integer as line_count,
        coalesce(pg_catalog.sum(item.line_usd::bigint), 0) as total_usd,
        coalesce(pg_catalog.sum(item.line_vnd::bigint), 0) as total_vnd
      from public.qr_order_items as item
      where item.qr_order_id = qr_order.id
    ) as snapshot
    where qr_order.id = any(v_expected_ids)
      and (
        snapshot.line_count = 0
        or snapshot.total_usd <> qr_order.total_usd::bigint
        or snapshot.total_vnd <> qr_order.total_vnd::bigint
      )
  ) then
    raise exception using
      errcode = '55000',
      message = 'QR order total does not match its item snapshots';
  end if;

  select
    coalesce(pg_catalog.sum(qr_order.total_usd::bigint), 0),
    coalesce(pg_catalog.sum(qr_order.total_vnd::bigint), 0)
  into v_base_usd, v_base_vnd
  from public.qr_orders as qr_order
  where qr_order.id = any(v_expected_ids);

  v_paid_usd := v_base_usd;
  v_paid_vnd := v_base_vnd;
  if v_payment_choice = 'card_fee7' then
    -- Match calc.html on the combined table subtotal: USD rounds to one dollar
    -- and VND rounds to the nearest 1,000 after applying 7% once.
    v_paid_usd := pg_catalog.round(v_base_usd::numeric * 1.07)::bigint;
    v_paid_vnd := (
      pg_catalog.round((v_base_vnd::numeric * 1.07) / 1000) * 1000
    )::bigint;
    v_fee_usd := v_paid_usd - v_base_usd;
    v_fee_vnd := v_paid_vnd - v_base_vnd;
  end if;

  if v_paid_usd > 2147483647 or v_paid_vnd > 2147483647 then
    raise exception using errcode = '22003', message = 'paid order total is out of range';
  end if;

  perform pg_catalog.set_config('app.rpc_write', 'on', true);

  insert into public.orders (
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
  values (
    v_finalized_at,
    'qr_table',
    'paid',
    0,
    0,
    v_guide_name,
    v_team_no,
    v_payment_method,
    false
  )
  returning * into v_paid_order;

  -- Keep each guest-facing name and unit price as ordered. A later menu edit
  -- cannot rewrite a paid sale, and line order remains deterministic.
  insert into public.order_custom_items (
    order_id,
    kind,
    ko_name,
    vi_name,
    qty,
    unit_usd,
    unit_vnd,
    line_usd,
    line_vnd,
    combo_snapshot
  )
  select
    v_paid_order.id,
    item.menu_type,
    item.ko_name,
    item.vi_name,
    item.qty,
    item.unit_usd,
    item.unit_vnd,
    item.line_usd,
    item.line_vnd,
    item.combo_snapshot
  from public.qr_orders as qr_order
  join public.qr_order_items as item on item.qr_order_id = qr_order.id
  where qr_order.id = any(v_expected_ids)
  order by qr_order.submitted_at, qr_order.id, item.created_at, item.id;

  if v_payment_choice = 'card_fee7' then
    insert into public.order_custom_items (
      order_id,
      kind,
      ko_name,
      vi_name,
      qty,
      unit_usd,
      unit_vnd,
      line_usd,
      line_vnd
    )
    values (
      v_paid_order.id,
      'fee7',
      'Service fee 7%',
      'Phí dịch vụ 7%',
      1,
      v_fee_usd::integer,
      v_fee_vnd::integer,
      v_fee_usd::integer,
      v_fee_vnd::integer
    );
  end if;

  select paid_order.*
  into v_paid_order
  from public.orders as paid_order
  where paid_order.id = v_paid_order.id;

  if v_paid_order.total_usd::bigint <> v_paid_usd
     or v_paid_order.total_vnd::bigint <> v_paid_vnd then
    raise exception using errcode = '55000', message = 'paid order total verification failed';
  end if;

  update public.qr_orders as qr_order
  set finalized_at = v_finalized_at,
      finalized_order_id = v_paid_order.id,
      finalized_payment_choice = v_payment_choice,
      updated_at = v_finalized_at
  where qr_order.id = any(v_expected_ids)
    and qr_order.table_id = v_table.id
    and qr_order.status = 'accepted'
    and qr_order.finalized_order_id is null;

  get diagnostics v_updated_count = row_count;
  if v_updated_count <> v_expected_count then
    raise exception using
      errcode = '55000',
      message = 'QR table orders changed while payment was being finalized';
  end if;

  perform pg_catalog.set_config('app.rpc_write', 'off', true);
  return v_paid_order.id;
end;
$$;

-- The definition table is not a browser write surface. Guests receive only
-- normalized data from the Edge Function; administrators mutate definitions
-- atomically through the existing menu RPCs.
revoke all on table public.menu_combo_components
  from public, anon, authenticated, service_role;
grant select on table public.menu_combo_components to service_role;

revoke execute on function private.menu_combo_summary(uuid)
  from public, anon, authenticated, service_role;
revoke execute on function private.assert_menu_combo_summary(uuid)
  from public, anon, authenticated, service_role;
revoke execute on function private.replace_menu_combo_components(uuid, jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function private.app_get_menu_combo_components_impl(uuid)
  from public, anon, authenticated, service_role;
revoke execute on function public.app_get_menu_combo_components(uuid)
  from public, anon, authenticated, service_role;

grant execute on function private.menu_combo_summary(uuid) to service_role;
grant execute on function private.app_get_menu_combo_components_impl(uuid)
  to authenticated;
grant execute on function public.app_get_menu_combo_components(uuid)
  to authenticated;

-- CREATE OR REPLACE retains ACLs, but reassert every intended caller so a
-- drifted environment cannot accidentally expose a privileged implementation.
revoke execute on function private.assert_menu_payload(jsonb, boolean)
  from public, anon, authenticated, service_role;
revoke execute on function private.app_create_menu_item_impl(jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function private.app_update_menu_item_impl(uuid, jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function private.app_update_qr_order_impl(uuid, timestamp with time zone, text, jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function private.app_finalize_qr_table_orders_checked_impl(uuid, jsonb, text, text, text)
  from public, anon, authenticated, service_role;

grant execute on function private.app_create_menu_item_impl(jsonb)
  to authenticated;
grant execute on function private.app_update_menu_item_impl(uuid, jsonb)
  to authenticated;
grant execute on function private.app_update_qr_order_impl(uuid, timestamp with time zone, text, jsonb)
  to authenticated;
grant execute on function private.app_finalize_qr_table_orders_checked_impl(uuid, jsonb, text, text, text)
  to authenticated;

revoke execute on function public.internal_qr_get_menu(text)
  from public, anon, authenticated, service_role;
revoke execute on function public.internal_qr_submit_order(text, uuid, text, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.internal_qr_get_menu(text) to service_role;
grant execute on function public.internal_qr_submit_order(text, uuid, text, jsonb)
  to service_role;

comment on function public.app_get_menu_combo_components(uuid) is
  'Admin-only normalized combo definition lookup using live referenced menu metadata and stored fallbacks.';
comment on function public.internal_qr_get_menu(text) is
  'Service-only hash-token menu lookup with combo details first, translated single-menu subcategories, current table orders, and exact unpaid totals.';
comment on function public.internal_qr_submit_order(text, uuid, text, jsonb) is
  'Service-only QR order creation with server-authoritative menu prices and immutable combo snapshots.';
