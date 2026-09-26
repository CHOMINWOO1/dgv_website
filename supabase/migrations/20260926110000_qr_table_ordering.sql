-- Additive QR table-ordering foundation.
--
-- This migration does not modify or delete existing menu prices, orders, or
-- order rows. Guest orders remain in a separate queue until an administrator
-- explicitly finalizes an accepted order into the existing paid-order ledger.

alter table public.menu_items
  add column if not exists en_name text,
  add column if not exists description_ko text,
  add column if not exists description_en text,
  add column if not exists description_vi text,
  add column if not exists image_url text,
  add column if not exists qr_category text,
  add column if not exists is_orderable boolean not null default true,
  add column if not exists is_sold_out boolean not null default false,
  add column if not exists requires_preorder boolean not null default false,
  add column if not exists updated_at timestamp with time zone not null default now();

alter table public.menu_items
  add constraint menu_items_qr_category_check
  check (
    qr_category is null
    or qr_category in ('single', 'shared', 'snack', 'preorder', 'drink', 'cafe')
  );

create table public.qr_tables (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  is_active boolean not null default true,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint qr_tables_label_length_check
    check (length(btrim(label)) between 1 and 80)
);

create unique index qr_tables_label_ci_key
  on public.qr_tables (lower(btrim(label)));

create table private.qr_table_tokens (
  table_id uuid primary key
    references public.qr_tables (id) on delete cascade,
  token_hash text not null unique,
  rotated_at timestamp with time zone not null default now(),
  constraint qr_table_tokens_hash_check
    check (token_hash ~ '^[0-9a-f]{64}$')
);

create table public.qr_orders (
  id uuid primary key default gen_random_uuid(),
  table_id uuid not null
    references public.qr_tables (id) on delete restrict,
  client_request_id uuid not null,
  request_hash text not null,
  status text not null default 'submitted',
  note text,
  total_usd integer not null,
  total_vnd integer not null,
  submitted_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  accepted_at timestamp with time zone,
  cancelled_at timestamp with time zone,
  finalized_at timestamp with time zone,
  finalized_order_id uuid unique
    references public.orders (id) on delete restrict,
  constraint qr_orders_table_request_key
    unique (table_id, client_request_id),
  constraint qr_orders_request_hash_check
    check (request_hash ~ '^[0-9a-f]{64}$'),
  constraint qr_orders_status_check
    check (status in ('submitted', 'accepted', 'cancelled')),
  constraint qr_orders_note_length_check
    check (note is null or length(note) <= 500),
  constraint qr_orders_totals_check
    check (total_usd >= 0 and total_vnd >= 0),
  constraint qr_orders_finalized_pair_check
    check (
      (finalized_at is null and finalized_order_id is null)
      or (finalized_at is not null and finalized_order_id is not null)
    )
);

create index qr_orders_status_submitted_at_idx
  on public.qr_orders (status, submitted_at desc);

create index qr_orders_table_submitted_at_idx
  on public.qr_orders (table_id, submitted_at desc);

create table public.qr_order_items (
  id uuid primary key default gen_random_uuid(),
  qr_order_id uuid not null
    references public.qr_orders (id) on delete cascade,
  menu_item_id uuid not null
    references public.menu_items (id) on delete restrict,
  qty integer not null,
  menu_type text not null,
  ko_name text not null,
  vi_name text,
  en_name text,
  unit_usd integer not null,
  unit_vnd integer not null,
  line_usd integer not null,
  line_vnd integer not null,
  created_at timestamp with time zone not null default now(),
  constraint qr_order_items_order_menu_key
    unique (qr_order_id, menu_item_id),
  constraint qr_order_items_qty_check
    check (qty between 1 and 20),
  constraint qr_order_items_prices_check
    check (
      unit_usd >= 0 and unit_vnd >= 0
      and line_usd = qty * unit_usd
      and line_vnd = qty * unit_vnd
    )
);

create index qr_order_items_order_id_idx
  on public.qr_order_items (qr_order_id);

create table private.qr_rate_limits (
  rate_key text primary key,
  window_started_at timestamp with time zone not null,
  hit_count integer not null,
  updated_at timestamp with time zone not null,
  constraint qr_rate_limits_key_check
    check (rate_key ~ '^[0-9a-f]{64}$'),
  constraint qr_rate_limits_hit_count_check
    check (hit_count > 0)
);

create index qr_rate_limits_updated_at_idx
  on private.qr_rate_limits (updated_at);

alter table public.qr_tables enable row level security;
alter table public.qr_orders enable row level security;
alter table public.qr_order_items enable row level security;
alter table private.qr_table_tokens enable row level security;
alter table private.qr_rate_limits enable row level security;

create policy qr_tables_staff_read
on public.qr_tables
for select
to authenticated
using ((select public.has_app_role(array['staff', 'admin']::text[])));

create policy qr_orders_staff_read
on public.qr_orders
for select
to authenticated
using ((select public.has_app_role(array['staff', 'admin']::text[])));

create policy qr_order_items_staff_read
on public.qr_order_items
for select
to authenticated
using ((select public.has_app_role(array['staff', 'admin']::text[])));

create function private.qr_sha256(p_value text)
returns text
language sql
immutable
strict
security invoker
set search_path = ''
as $$
  select pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(p_value, 'UTF8'), 'sha256'),
    'hex'
  )
$$;

create function private.validate_qr_table_label(p_label text)
returns text
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  v_label text := btrim(p_label);
begin
  if length(coalesce(v_label, '')) not between 1 and 80
     or v_label ~ '[[:cntrl:]]' then
    raise exception using
      errcode = '22023',
      message = 'table label must contain 1 to 80 printable characters';
  end if;
  return v_label;
end;
$$;

-- Extend the existing validation trigger without changing any stored prices.
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
     or length(coalesce(new.qr_category, '')) > 40 then
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
  new.updated_at := now();
  return new;
end;
$$;

create function public.internal_qr_take_rate_limit(
  p_rate_key text,
  p_limit integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_allowed boolean;
begin
  if p_rate_key is null
     or p_rate_key !~ '^[0-9a-f]{64}$'
     or p_limit not between 1 and 1000
     or p_window_seconds not between 1 and 3600 then
    raise exception using errcode = '22023', message = 'invalid rate-limit input';
  end if;

  -- Rate-limit keys are untrusted request derivatives. Expire old buckets so
  -- spoofed client addresses cannot grow this private table permanently.
  delete from private.qr_rate_limits
  where updated_at <= now() - interval '1 day';

  insert into private.qr_rate_limits as limits (
    rate_key,
    window_started_at,
    hit_count,
    updated_at
  )
  values (p_rate_key, now(), 1, now())
  on conflict (rate_key) do update
  set
    window_started_at = case
      when limits.window_started_at
           <= now() - pg_catalog.make_interval(secs => p_window_seconds)
        then now()
      else limits.window_started_at
    end,
    hit_count = case
      when limits.window_started_at
           <= now() - pg_catalog.make_interval(secs => p_window_seconds)
        then 1
      else limits.hit_count + 1
    end,
    updated_at = now()
  returning hit_count <= p_limit into v_allowed;

  return v_allowed;
end;
$$;

create function public.internal_qr_get_menu(p_token_hash text)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_table public.qr_tables%rowtype;
  v_items jsonb;
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
    'items', v_items
  );
end;
$$;

create function public.internal_qr_submit_order(
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
    from pg_catalog.jsonb_array_elements(p_items) as e(item)
    where pg_catalog.jsonb_typeof(e.item) <> 'object'
       or e.item - 'menu_item_id' - 'qty' <> '{}'::jsonb
       or coalesce(e.item ->> 'menu_item_id', '')
          !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or coalesce(e.item ->> 'qty', '') !~ '^[1-9][0-9]*$'
       or case
         when coalesce(e.item ->> 'qty', '') ~ '^[1-9][0-9]*$'
           then (e.item ->> 'qty')::numeric > 20
         else false
       end
  ) then
    raise exception using errcode = '22023', message = 'order contains an invalid line';
  end if;

  if (
    select count(distinct e.item ->> 'menu_item_id')
    from pg_catalog.jsonb_array_elements(p_items) as e(item)
  ) <> pg_catalog.jsonb_array_length(p_items) then
    raise exception using errcode = '22023', message = 'duplicate menu items are not allowed';
  end if;

  select t.*
  into v_table
  from public.qr_tables as t
  join private.qr_table_tokens as tokens on tokens.table_id = t.id
  where tokens.token_hash = p_token_hash
    and t.is_active = true
  for share of t, tokens;

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

  -- Hold a stable server-authoritative menu snapshot through total calculation
  -- and line insertion. Concurrent menu edits wait until this order commits.
  perform m.id
  from public.menu_items as m
  join pg_catalog.jsonb_array_elements(p_items) as e(item)
    on m.id = (e.item ->> 'menu_item_id')::uuid
  order by m.id
  for share of m;

  v_request_hash := private.qr_sha256(
    p_token_hash || ':' || p_client_request_id::text || ':'
    || coalesce(v_note, '') || ':' || p_items::text
  );

  select o.*
  into v_existing
  from public.qr_orders as o
  where o.table_id = v_table.id
    and o.client_request_id = p_client_request_id;

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
    from pg_catalog.jsonb_array_elements(p_items) as e(item)
    left join public.menu_items as m
      on m.id = (e.item ->> 'menu_item_id')::uuid
    where m.id is null
       or m.is_active is distinct from true
       or m.is_orderable is distinct from true
       or m.is_sold_out is distinct from false
       or m.requires_preorder is distinct from false
       or m.price_usd is null
       or m.price_vnd is null
       or m.price_usd < 0
       or m.price_vnd < 0
  ) then
    raise exception using errcode = '22023', message = 'order contains an unavailable menu item';
  end if;

  select
    count(*)::integer,
    coalesce(sum((e.item ->> 'qty')::bigint), 0),
    coalesce(sum((e.item ->> 'qty')::bigint * m.price_usd::bigint), 0),
    coalesce(sum((e.item ->> 'qty')::bigint * m.price_vnd::bigint), 0)
  into v_line_count, v_total_qty, v_total_usd, v_total_vnd
  from pg_catalog.jsonb_array_elements(p_items) as e(item)
  join public.menu_items as m
    on m.id = (e.item ->> 'menu_item_id')::uuid;

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
    select o.*
    into strict v_existing
    from public.qr_orders as o
    where o.table_id = v_table.id
      and o.client_request_id = p_client_request_id;

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
    line_vnd
  )
  select
    v_order.id,
    m.id,
    (e.item ->> 'qty')::integer,
    m.type,
    m.ko_name,
    m.vi_name,
    m.en_name,
    m.price_usd,
    m.price_vnd,
    ((e.item ->> 'qty')::bigint * m.price_usd::bigint)::integer,
    ((e.item ->> 'qty')::bigint * m.price_vnd::bigint)::integer
  from pg_catalog.jsonb_array_elements(p_items) as e(item)
  join public.menu_items as m
    on m.id = (e.item ->> 'menu_item_id')::uuid;

  return (pg_catalog.to_jsonb(v_order) - 'request_hash')
    || pg_catalog.jsonb_build_object(
      'table_label', v_table.label,
      'idempotent', false
    );
end;
$$;

create function private.app_create_qr_table_impl(p_label text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_table public.qr_tables%rowtype;
  v_token text;
begin
  if (select auth.uid()) is null
     or not public.has_app_role(array['admin']::text[]) then
    raise exception using errcode = '42501', message = 'admin role required';
  end if;

  v_token := pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '')
    || pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '');

  insert into public.qr_tables (label)
  values (private.validate_qr_table_label(p_label))
  returning * into v_table;

  insert into private.qr_table_tokens (table_id, token_hash)
  values (v_table.id, private.qr_sha256(v_token));

  return pg_catalog.jsonb_build_object(
    'table_id', v_table.id,
    'label', v_table.label,
    'is_active', v_table.is_active,
    'table_token', v_token
  );
end;
$$;

create function public.app_create_qr_table(p_label text)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.app_create_qr_table_impl(p_label)
$$;

create function private.app_rotate_qr_table_token_impl(p_table_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_table public.qr_tables%rowtype;
  v_token text;
begin
  if (select auth.uid()) is null
     or not public.has_app_role(array['admin']::text[]) then
    raise exception using errcode = '42501', message = 'admin role required';
  end if;

  select * into v_table
  from public.qr_tables
  where id = p_table_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'QR table not found';
  end if;

  v_token := pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '')
    || pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '');

  insert into private.qr_table_tokens (table_id, token_hash, rotated_at)
  values (v_table.id, private.qr_sha256(v_token), now())
  on conflict (table_id) do update
  set token_hash = excluded.token_hash,
      rotated_at = excluded.rotated_at;

  return pg_catalog.jsonb_build_object(
    'table_id', v_table.id,
    'label', v_table.label,
    'is_active', v_table.is_active,
    'table_token', v_token
  );
end;
$$;

create function public.app_rotate_qr_table_token(p_table_id uuid)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.app_rotate_qr_table_token_impl(p_table_id)
$$;

create function private.app_set_qr_table_active_impl(
  p_table_id uuid,
  p_is_active boolean
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null
     or not public.has_app_role(array['admin']::text[]) then
    raise exception using errcode = '42501', message = 'admin role required';
  end if;
  if p_table_id is null or p_is_active is null then
    raise exception using errcode = '22023', message = 'table id and active state are required';
  end if;

  update public.qr_tables
  set is_active = p_is_active,
      updated_at = now()
  where id = p_table_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'QR table not found';
  end if;
  return true;
end;
$$;

create function public.app_set_qr_table_active(
  p_table_id uuid,
  p_is_active boolean
)
returns boolean
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.app_set_qr_table_active_impl(p_table_id, p_is_active)
$$;

create function private.app_update_qr_order_status_impl(
  p_order_id uuid,
  p_status text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text := public.current_app_role();
  v_target text := lower(btrim(p_status));
  v_order public.qr_orders%rowtype;
  v_allowed boolean := false;
begin
  if (select auth.uid()) is null
     or v_role is null
     or v_role not in ('staff', 'admin') then
    raise exception using errcode = '42501', message = 'staff or admin role required';
  end if;
  if p_order_id is null
     or v_target is null
     or v_target not in ('accepted', 'cancelled') then
    raise exception using errcode = '22023', message = 'invalid order status';
  end if;

  select * into v_order
  from public.qr_orders
  where id = p_order_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'QR order not found';
  end if;

  if v_order.status = v_target then
    return (pg_catalog.to_jsonb(v_order) - 'request_hash')
      || pg_catalog.jsonb_build_object('idempotent', true);
  end if;
  if v_order.finalized_order_id is not null then
    raise exception using errcode = '55000', message = 'finalized QR order cannot change status';
  end if;

  v_allowed := v_order.status = 'submitted' and v_target = 'accepted';

  if v_role = 'admin'
     and v_target = 'cancelled'
     and v_order.status in ('submitted', 'accepted') then
    v_allowed := true;
  end if;

  if not v_allowed then
    raise exception using errcode = '22023', message = 'invalid QR order status transition';
  end if;

  update public.qr_orders
  set status = v_target,
      updated_at = now(),
      accepted_at = case when v_target = 'accepted' then now() else accepted_at end,
      cancelled_at = case when v_target = 'cancelled' then now() else cancelled_at end
  where id = p_order_id
  returning * into v_order;

  return (pg_catalog.to_jsonb(v_order) - 'request_hash')
    || pg_catalog.jsonb_build_object('idempotent', false);
end;
$$;

create function public.app_update_qr_order_status(
  p_order_id uuid,
  p_status text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.app_update_qr_order_status_impl(p_order_id, p_status)
$$;

create function private.app_finalize_qr_order_impl(
  p_qr_order_id uuid,
  p_payment_method text,
  p_guide_name text,
  p_team_no text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_qr_order public.qr_orders%rowtype;
  v_items jsonb;
  v_paid_order_id uuid;
begin
  if (select auth.uid()) is null
     or not public.has_app_role(array['admin']::text[]) then
    raise exception using errcode = '42501', message = 'admin role required';
  end if;

  select * into v_qr_order
  from public.qr_orders
  where id = p_qr_order_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'QR order not found';
  end if;
  if v_qr_order.finalized_order_id is not null then
    return v_qr_order.finalized_order_id;
  end if;
  if v_qr_order.status <> 'accepted' then
    raise exception using errcode = '22023', message = 'only accepted QR orders can be finalized';
  end if;

  -- Use the server-captured submission prices. They came from menu_items when
  -- the guest ordered and must not change if a menu price is edited meanwhile.
  select pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'item_type', 'custom',
      'kind', i.menu_type,
      'ko_name', i.ko_name,
      'vi_name', i.vi_name,
      'qty', i.qty,
      'unit_usd', i.unit_usd,
      'unit_vnd', i.unit_vnd
    ) order by i.created_at, i.id
  )
  into v_items
  from public.qr_order_items as i
  where i.qr_order_id = v_qr_order.id;

  if v_items is null or pg_catalog.jsonb_array_length(v_items) = 0 then
    raise exception using errcode = '22023', message = 'QR order has no items';
  end if;

  v_paid_order_id := public.app_create_order(
    now(),
    'qr_table',
    'paid',
    p_guide_name,
    p_team_no,
    p_payment_method,
    v_items
  );

  update public.qr_orders
  set finalized_at = now(),
      finalized_order_id = v_paid_order_id,
      updated_at = now()
  where id = v_qr_order.id;

  return v_paid_order_id;
end;
$$;

create function public.app_finalize_qr_order(
  p_qr_order_id uuid,
  p_payment_method text,
  p_guide_name text default null,
  p_team_no text default null
)
returns uuid
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.app_finalize_qr_order_impl(
    p_qr_order_id,
    p_payment_method,
    p_guide_name,
    p_team_no
  )
$$;

create function private.assert_menu_payload(
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
    'image_url', 'qr_category'
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
     or length(coalesce(p_payload ->> 'image_url', '')) > 1000 then
    raise exception using errcode = '22023', message = 'menu type or image URL is too long';
  end if;

  if p_payload ? 'qr_category'
     and pg_catalog.jsonb_typeof(p_payload -> 'qr_category') <> 'null'
     and lower(btrim(p_payload ->> 'qr_category')) not in (
       'single', 'shared', 'snack', 'preorder', 'drink', 'cafe'
     ) then
    raise exception using errcode = '22023', message = 'invalid QR menu category';
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

create function private.app_create_menu_item_impl(p_item jsonb)
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

create function public.app_create_menu_item(p_item jsonb)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.app_create_menu_item_impl(p_item)
$$;

create function private.app_update_menu_item_impl(
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

create function public.app_update_menu_item(
  p_item_id uuid,
  p_patch jsonb
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.app_update_menu_item_impl(p_item_id, p_patch)
$$;

-- Postgres Changes is only a wake-up signal. The staff client refetches the
-- RLS-filtered rows on every event and also polls as a reconnect fallback.
do $$
begin
  if exists (
    select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime'
  ) then
    if not exists (
      select 1
      from pg_catalog.pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'qr_orders'
    ) then
      alter publication supabase_realtime add table public.qr_orders;
    end if;
    if not exists (
      select 1
      from pg_catalog.pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'qr_order_items'
    ) then
      alter publication supabase_realtime add table public.qr_order_items;
    end if;
  end if;
end;
$$;

-- New Data API objects are private by default in current Supabase projects.
-- Revoke defensively, then grant only the operations used by each caller.
revoke all on table
  public.qr_tables,
  public.qr_orders,
  public.qr_order_items
from anon, authenticated, service_role;

revoke all on table
  private.qr_table_tokens,
  private.qr_rate_limits
from public, anon, authenticated, service_role;

grant select on table
  public.qr_tables,
  public.qr_orders,
  public.qr_order_items
to authenticated;

grant select, insert, update, delete on table
  public.qr_tables,
  public.qr_orders,
  public.qr_order_items
to service_role;

grant usage on schema private to authenticated, service_role;

grant select, insert, update, delete on table
  private.qr_table_tokens,
  private.qr_rate_limits
to service_role;

grant usage on schema extensions to service_role;
grant execute on function extensions.digest(bytea, text) to service_role;

revoke execute on function private.qr_sha256(text)
  from public, anon, authenticated, service_role;
revoke execute on function private.validate_qr_table_label(text)
  from public, anon, authenticated, service_role;
revoke execute on function private.assert_menu_payload(jsonb, boolean)
  from public, anon, authenticated, service_role;

-- internal_qr_submit_order is SECURITY INVOKER under service_role and calls
-- this exact helper. No browser role receives private-schema EXECUTE.
grant execute on function private.qr_sha256(text) to service_role;

revoke execute on function public.internal_qr_take_rate_limit(text, integer, integer)
  from public, anon, authenticated, service_role;
revoke execute on function public.internal_qr_get_menu(text)
  from public, anon, authenticated, service_role;
revoke execute on function public.internal_qr_submit_order(text, uuid, text, jsonb)
  from public, anon, authenticated, service_role;

grant execute on function public.internal_qr_take_rate_limit(text, integer, integer)
  to service_role;
grant execute on function public.internal_qr_get_menu(text)
  to service_role;
grant execute on function public.internal_qr_submit_order(text, uuid, text, jsonb)
  to service_role;

revoke execute on function private.app_create_qr_table_impl(text)
  from public, anon, authenticated, service_role;
revoke execute on function private.app_rotate_qr_table_token_impl(uuid)
  from public, anon, authenticated, service_role;
revoke execute on function private.app_set_qr_table_active_impl(uuid, boolean)
  from public, anon, authenticated, service_role;
revoke execute on function private.app_update_qr_order_status_impl(uuid, text)
  from public, anon, authenticated, service_role;
revoke execute on function private.app_finalize_qr_order_impl(uuid, text, text, text)
  from public, anon, authenticated, service_role;
revoke execute on function private.app_create_menu_item_impl(jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function private.app_update_menu_item_impl(uuid, jsonb)
  from public, anon, authenticated, service_role;

grant execute on function private.app_create_qr_table_impl(text)
  to authenticated;
grant execute on function private.app_rotate_qr_table_token_impl(uuid)
  to authenticated;
grant execute on function private.app_set_qr_table_active_impl(uuid, boolean)
  to authenticated;
grant execute on function private.app_update_qr_order_status_impl(uuid, text)
  to authenticated;
grant execute on function private.app_finalize_qr_order_impl(uuid, text, text, text)
  to authenticated;
grant execute on function private.app_create_menu_item_impl(jsonb)
  to authenticated;
grant execute on function private.app_update_menu_item_impl(uuid, jsonb)
  to authenticated;

revoke execute on function public.app_create_qr_table(text)
  from public, anon, authenticated, service_role;
revoke execute on function public.app_rotate_qr_table_token(uuid)
  from public, anon, authenticated, service_role;
revoke execute on function public.app_set_qr_table_active(uuid, boolean)
  from public, anon, authenticated, service_role;
revoke execute on function public.app_update_qr_order_status(uuid, text)
  from public, anon, authenticated, service_role;
revoke execute on function public.app_finalize_qr_order(uuid, text, text, text)
  from public, anon, authenticated, service_role;
revoke execute on function public.app_create_menu_item(jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function public.app_update_menu_item(uuid, jsonb)
  from public, anon, authenticated, service_role;

grant execute on function public.app_create_qr_table(text)
  to authenticated;
grant execute on function public.app_rotate_qr_table_token(uuid)
  to authenticated;
grant execute on function public.app_set_qr_table_active(uuid, boolean)
  to authenticated;
grant execute on function public.app_update_qr_order_status(uuid, text)
  to authenticated;
grant execute on function public.app_finalize_qr_order(uuid, text, text, text)
  to authenticated;
grant execute on function public.app_create_menu_item(jsonb)
  to authenticated;
grant execute on function public.app_update_menu_item(uuid, jsonb)
  to authenticated;

comment on table public.qr_orders is
  'Guest QR order queue; rows enter the paid orders ledger only through app_finalize_qr_order.';
comment on table private.qr_table_tokens is
  'SHA-256 table-token hashes only. Raw QR tokens are returned once and never stored.';
comment on function public.internal_qr_submit_order(text, uuid, text, jsonb) is
  'Server-only QR submit RPC. Validates active menu rows and snapshots authoritative prices.';
