-- Production schema baseline for a fresh staging project.
--
-- This migration intentionally contains schema only. It does not copy production
-- rows, password hashes, access codes, project URLs, API keys, cron jobs, or HTTP
-- notification destinations.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create table public.menu_items (
  type text not null,
  id uuid primary key default gen_random_uuid(),
  ko_name text,
  vi_name text,
  price_usd integer,
  price_vnd integer,
  is_active boolean,
  sort_order integer,
  created_at timestamp with time zone
);

create table public.orders (
  sales_excluded boolean not null default false,
  total_usd integer not null,
  total_vnd integer not null,
  id uuid primary key default gen_random_uuid(),
  created_at timestamp with time zone not null default now(),
  source text not null default 'calc_web',
  status text not null default 'paid',
  guide_name text,
  team_no text,
  payment_method text not null default 'cash'
);

create table public.order_items (
  order_id uuid not null,
  qty integer not null,
  unit_usd integer not null,
  unit_vnd integer not null,
  line_usd integer not null,
  line_vnd integer not null,
  id uuid primary key default gen_random_uuid(),
  menu_item_id uuid,
  is_custom boolean not null default false,
  custom_ko_name text,
  custom_vi_name text,
  constraint order_items_order_id_fkey
    foreign key (order_id) references public.orders (id) on delete cascade,
  constraint order_items_menu_item_id_fkey
    foreign key (menu_item_id) references public.menu_items (id)
);

create table public.admin_settings (
  key text primary key,
  value_hash text not null
);

create table public.order_custom_items (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'special',
  order_id uuid not null,
  ko_name text not null,
  vi_name text,
  qty integer not null default 1,
  unit_usd integer not null default 0,
  unit_vnd integer not null default 0,
  line_usd integer not null default 0,
  line_vnd integer not null default 0,
  created_at timestamp with time zone not null default now(),
  constraint order_custom_items_order_id_fkey
    foreign key (order_id) references public.orders (id) on delete cascade
);

create table public.resv_groups (
  id bigserial primary key,
  res_date date not null,
  res_time time without time zone not null,
  guests_count integer not null,
  price integer,
  menu_ko text,
  menu_vi text,
  note text,
  branch text not null,
  guide_name text,
  created_at timestamp with time zone not null default now(),
  confirmed boolean not null default false,
  confirmed_at timestamp with time zone,
  confirmed_order_id uuid,
  constraint resv_groups_guests_count_check check (guests_count > 0)
);

create table public.admin_kv (
  key text primary key,
  val text not null
);

create table public.notices (
  title text not null,
  body text not null,
  author text,
  id uuid primary key default gen_random_uuid(),
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create table public.page_access_code (
  code text not null,
  id integer primary key default 1,
  updated_at timestamp with time zone not null default now(),
  constraint code_not_empty check (length(btrim(code)) > 0),
  constraint only_one_row check (id = 1)
);

create index idx_order_custom_items_order_id
  on public.order_custom_items using btree (order_id);

create index idx_order_items_menu_item_id
  on public.order_items using btree (menu_item_id);

create index idx_order_items_order_id
  on public.order_items using btree (order_id);

create index idx_orders_created_at
  on public.orders using btree (created_at);

create index idx_orders_status_created_at
  on public.orders using btree (status, created_at);

create index idx_resv_groups_branch
  on public.resv_groups using btree (branch);

create index idx_resv_groups_date_time
  on public.resv_groups using btree (res_date, res_time);

create view public.v_order_detail_all as
select
  o.id as order_id,
  o.created_at,
  o.status,
  o.total_usd,
  o.total_vnd,
  o.sales_excluded,
  oi.id as order_item_id,
  oi.qty,
  oi.unit_usd,
  oi.unit_vnd,
  oi.line_usd,
  oi.line_vnd,
  m.type as menu_type,
  m.ko_name,
  m.vi_name
from public.orders as o
join public.order_items as oi on oi.order_id = o.id
join public.menu_items as m on m.id = oi.menu_item_id
union all
select
  o.id as order_id,
  o.created_at,
  o.status,
  o.total_usd,
  o.total_vnd,
  o.sales_excluded,
  c.id as order_item_id,
  c.qty,
  c.unit_usd,
  c.unit_vnd,
  c.line_usd,
  c.line_vnd,
  c.kind as menu_type,
  c.ko_name,
  c.vi_name
from public.orders as o
join public.order_custom_items as c on c.order_id = o.id;

create view public.v_order_detail as
select
  order_id,
  created_at,
  status,
  total_usd,
  total_vnd,
  order_item_id,
  qty,
  unit_usd,
  unit_vnd,
  line_usd,
  line_vnd,
  menu_type,
  ko_name,
  vi_name
from public.v_order_detail_all
where sales_excluded = false;

create view public.v_sales_daily as
select
  (o.created_at at time zone 'Asia/Ho_Chi_Minh')::date as day,
  count(*) as order_count,
  sum(o.total_usd)::integer as total_usd,
  sum(o.total_vnd)::integer as total_vnd
from public.orders as o
where o.status = 'paid'
group by ((o.created_at at time zone 'Asia/Ho_Chi_Minh')::date)
order by ((o.created_at at time zone 'Asia/Ho_Chi_Minh')::date) desc;

create view public.v_sales_monthly as
select
  to_char(
    date_trunc('month', o.created_at at time zone 'Asia/Ho_Chi_Minh'),
    'YYYY-MM'
  ) as month,
  count(*) as order_count,
  sum(o.total_usd)::integer as total_usd,
  sum(o.total_vnd)::integer as total_vnd
from public.orders as o
where o.status = 'paid'
group by to_char(
  date_trunc('month', o.created_at at time zone 'Asia/Ho_Chi_Minh'),
  'YYYY-MM'
)
order by to_char(
  date_trunc('month', o.created_at at time zone 'Asia/Ho_Chi_Minh'),
  'YYYY-MM'
) desc;

create function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger trg_notices_updated_at
before update on public.notices
for each row execute function public.set_updated_at();

create function public.fill_vi_if_empty()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.vi_name is null or length(btrim(new.vi_name)) = 0 then
    new.vi_name := new.ko_name;
  end if;
  return new;
end;
$$;

create trigger trg_order_custom_items_fill_vi
before insert or update on public.order_custom_items
for each row execute function public.fill_vi_if_empty();

-- Keep the production trigger shape without performing any network operation.
-- A later, separately reviewed migration may replace this with an outbox writer.
create function public.notify_resv_groups_insert()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  return new;
end;
$$;

create trigger trg_notify_resv_groups_insert
after insert on public.resv_groups
for each row execute function public.notify_resv_groups_insert();
