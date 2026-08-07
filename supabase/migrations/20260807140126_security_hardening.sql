-- Security hardening for the staging rehearsal.
--
-- Authorization source: auth.users.raw_app_meta_data -> JWT app_metadata.role.
-- Only the two application roles used by the existing UX are recognized:
--   staff: read-only employee access to menus, orders, reservations, and reports
--   admin: staff access plus every application mutation and notice management
--
-- This migration contains no production data and performs no row mutation on
-- existing application tables. External HTTP delivery and cron are deliberately
-- deferred; reservation inserts only enqueue a local outbox row.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated, service_role;

create table public.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  payload jsonb not null,
  status text not null default 'pending',
  attempts integer not null default 0,
  created_at timestamp with time zone not null default now(),
  locked_at timestamp with time zone,
  processed_at timestamp with time zone,
  last_error text,
  idempotency_key text not null,
  constraint notification_outbox_idempotency_key_key unique (idempotency_key),
  constraint notification_outbox_attempts_check check (attempts >= 0),
  constraint notification_outbox_event_type_check
    check (event_type in ('resv_insert', 'daily_summary', 'tomorrow_summary')),
  constraint notification_outbox_status_check
    check (status in ('pending', 'processing', 'sent', 'failed'))
);

create index idx_notification_outbox_dispatch
  on public.notification_outbox using btree (status, created_at);

create function public.current_app_role()
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select case
    when (select auth.jwt()) -> 'app_metadata' ->> 'role' in ('staff', 'admin')
      then (select auth.jwt()) -> 'app_metadata' ->> 'role'
    else null
  end
$$;

create function public.has_app_role(p_allowed_roles text[])
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(
    public.current_app_role() = any (p_allowed_roles),
    false
  )
$$;

-- Used only by the credential Edge path while legacy hashes are kept in sync
-- during rollout. The browser roles receive no EXECUTE privilege.
create function public.internal_hash_legacy_password(p_password text)
returns text
language sql
security invoker
set search_path = ''
as $$
  select extensions.crypt(p_password, extensions.gen_salt('bf', 12))
$$;

alter table public.menu_items enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.admin_settings enable row level security;
alter table public.order_custom_items enable row level security;
alter table public.resv_groups enable row level security;
alter table public.admin_kv enable row level security;
alter table public.notices enable row level security;
alter table public.page_access_code enable row level security;
alter table public.notification_outbox enable row level security;

create policy menu_items_staff_read
on public.menu_items
for select
to authenticated
using ((select public.has_app_role(array['staff', 'admin']::text[])));

create policy orders_staff_read
on public.orders
for select
to authenticated
using ((select public.has_app_role(array['staff', 'admin']::text[])));

create policy orders_admin_insert
on public.orders
for insert
to authenticated
with check (
  (select public.has_app_role(array['admin']::text[]))
  and sales_excluded = false
);

create policy orders_admin_update
on public.orders
for update
to authenticated
using ((select public.has_app_role(array['admin']::text[])))
with check ((select public.has_app_role(array['admin']::text[])));

create policy orders_admin_delete
on public.orders
for delete
to authenticated
using ((select public.has_app_role(array['admin']::text[])));

create policy order_items_staff_read
on public.order_items
for select
to authenticated
using ((select public.has_app_role(array['staff', 'admin']::text[])));

create policy order_items_admin_insert
on public.order_items
for insert
to authenticated
with check ((select public.has_app_role(array['admin']::text[])));

create policy order_items_admin_update
on public.order_items
for update
to authenticated
using ((select public.has_app_role(array['admin']::text[])))
with check ((select public.has_app_role(array['admin']::text[])));

create policy order_items_admin_delete
on public.order_items
for delete
to authenticated
using ((select public.has_app_role(array['admin']::text[])));

create policy order_custom_items_staff_read
on public.order_custom_items
for select
to authenticated
using ((select public.has_app_role(array['staff', 'admin']::text[])));

create policy order_custom_items_admin_insert
on public.order_custom_items
for insert
to authenticated
with check ((select public.has_app_role(array['admin']::text[])));

create policy order_custom_items_admin_update
on public.order_custom_items
for update
to authenticated
using ((select public.has_app_role(array['admin']::text[])))
with check ((select public.has_app_role(array['admin']::text[])));

create policy order_custom_items_admin_delete
on public.order_custom_items
for delete
to authenticated
using ((select public.has_app_role(array['admin']::text[])));

create policy resv_groups_staff_read
on public.resv_groups
for select
to authenticated
using ((select public.has_app_role(array['staff', 'admin']::text[])));

create policy resv_groups_admin_insert
on public.resv_groups
for insert
to authenticated
with check (
  (select public.has_app_role(array['admin']::text[]))
  and confirmed = false
  and confirmed_at is null
  and confirmed_order_id is null
);

create policy resv_groups_admin_update
on public.resv_groups
for update
to authenticated
using ((select public.has_app_role(array['admin']::text[])))
with check ((select public.has_app_role(array['admin']::text[])));

create policy resv_groups_admin_delete
on public.resv_groups
for delete
to authenticated
using ((select public.has_app_role(array['admin']::text[])));

create policy notices_public_read
on public.notices
for select
to anon, authenticated
using (true);

create policy notices_admin_insert
on public.notices
for insert
to authenticated
with check ((select public.has_app_role(array['admin']::text[])));

create policy notices_admin_update
on public.notices
for update
to authenticated
using ((select public.has_app_role(array['admin']::text[])))
with check ((select public.has_app_role(array['admin']::text[])));

create policy notices_admin_delete
on public.notices
for delete
to authenticated
using ((select public.has_app_role(array['admin']::text[])));

-- admin_settings, admin_kv, page_access_code, and notification_outbox receive no
-- anon/authenticated policies. Their rows are not part of the browser Data API.

alter view public.v_order_detail_all set (security_invoker = true);
alter view public.v_order_detail set (security_invoker = true);
alter view public.v_sales_daily set (security_invoker = true);
alter view public.v_sales_monthly set (security_invoker = true);

-- Preserve legacy functions for rollback compatibility, but remove Data API
-- execution and pin their lookup path. No function is deleted by this migration.
do $$
declare
  legacy_function regprocedure;
begin
  for legacy_function in
    select p.oid::regprocedure
    from pg_catalog.pg_proc as p
    join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = any (array[
        'admin_check_password',
        'admin_create_order_with_date',
        'admin_delete_order',
        'admin_get_page_access_code',
        'admin_get_page_access_code_status',
        'admin_insert_resv_group',
        'admin_mark_resv_confirmed',
        'admin_unmark_resv_confirmed',
        'admin_update_admin_password',
        'admin_update_order',
        'admin_update_order_with_items',
        'admin_update_page_access_code',
        'admin_update_password',
        'admin_update_resv_group',
        'check_page_access_code',
        'send_resv_summary_by_date',
        'send_tomorrow_resv_summary'
      ]::text[])
  loop
    execute pg_catalog.format(
      'alter function %s set search_path = pg_catalog, public, extensions',
      legacy_function
    );
  end loop;
end;
$$;

create function private.guard_orders_admin_fields()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if old.sales_excluded is distinct from new.sales_excluded
     and current_user::text not in ('postgres', 'supabase_admin', 'service_role')
     and not public.has_app_role(array['admin']::text[]) then
    raise exception using
      errcode = '42501',
      message = 'admin role required to change sales_excluded';
  end if;

  return new;
end;
$$;

create trigger trg_orders_guard_admin_fields
before update on public.orders
for each row execute function private.guard_orders_admin_fields();

create function private.guard_reservation_confirmation_fields()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if (
       old.confirmed is distinct from new.confirmed
       or old.confirmed_at is distinct from new.confirmed_at
       or old.confirmed_order_id is distinct from new.confirmed_order_id
     )
     and current_user::text not in ('postgres', 'supabase_admin', 'service_role')
     and not public.has_app_role(array['admin']::text[]) then
    raise exception using
      errcode = '42501',
      message = 'admin role required to change reservation confirmation';
  end if;

  return new;
end;
$$;

create trigger trg_resv_groups_guard_confirmation
before update on public.resv_groups
for each row execute function private.guard_reservation_confirmation_fields();

create function private.enqueue_reservation_created()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.notification_outbox (
    event_type,
    payload,
    idempotency_key
  )
  values (
    'resv_insert',
    pg_catalog.jsonb_build_object(
      'res_date', new.res_date,
      'res_time', new.res_time,
      'branch', new.branch,
      'guests_count', new.guests_count,
      'menu_ko', new.menu_ko,
      'menu_vi', new.menu_vi,
      'guide_name', new.guide_name,
      'note', new.note
    ),
    'resv_insert:' || new.id::text
  )
  on conflict (idempotency_key) do nothing;

  return new;
end;
$$;

drop trigger if exists trg_notify_resv_groups_insert on public.resv_groups;

create trigger trg_notify_resv_groups_insert
after insert on public.resv_groups
for each row execute function private.enqueue_reservation_created();

-- SECURITY INVOKER RPCs need base-table privileges. This trigger gate prevents
-- callers from using those grants through direct REST writes. Each approved RPC
-- enables a transaction-local marker immediately before its mutation. PostgREST
-- does not expose pg_catalog.set_config as an RPC endpoint.
create function private.require_app_rpc_write()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if current_user::text not in ('postgres', 'supabase_admin', 'service_role')
     and coalesce(pg_catalog.current_setting('app.rpc_write', true), 'off') <> 'on' then
    raise exception using
      errcode = '42501',
      message = 'direct table writes are disabled; use an app_* RPC';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger trg_orders_require_app_rpc
before insert or update or delete on public.orders
for each row execute function private.require_app_rpc_write();

create trigger trg_order_items_require_app_rpc
before insert or update or delete on public.order_items
for each row execute function private.require_app_rpc_write();

create trigger trg_order_custom_items_require_app_rpc
before insert or update or delete on public.order_custom_items
for each row execute function private.require_app_rpc_write();

create trigger trg_resv_groups_require_app_rpc
before insert or update or delete on public.resv_groups
for each row execute function private.require_app_rpc_write();

create function private.validate_menu_item()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if length(btrim(coalesce(new.type, ''))) = 0 then
    raise exception using errcode = '22023', message = 'menu type is required';
  end if;

  if new.price_usd is not null and new.price_usd < 0
     or new.price_vnd is not null and new.price_vnd < 0 then
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

  new.type := btrim(new.type);
  new.ko_name := nullif(btrim(new.ko_name), '');
  new.vi_name := nullif(btrim(new.vi_name), '');
  return new;
end;
$$;

create trigger trg_menu_items_validate
before insert or update on public.menu_items
for each row execute function private.validate_menu_item();

create function private.normalize_order_item()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_price_usd integer;
  v_price_vnd integer;
  v_line_usd bigint;
  v_line_vnd bigint;
begin
  if new.menu_item_id is null or new.qty is null or new.qty <= 0 then
    raise exception using errcode = '22023', message = 'menu item and positive quantity are required';
  end if;

  select price_usd, price_vnd
  into v_price_usd, v_price_vnd
  from public.menu_items
  where id = new.menu_item_id;

  if not found
     or v_price_usd is null
     or v_price_vnd is null
     or v_price_usd < 0
     or v_price_vnd < 0 then
    raise exception using errcode = '22023', message = 'menu item has no valid price';
  end if;

  v_line_usd := new.qty::bigint * v_price_usd::bigint;
  v_line_vnd := new.qty::bigint * v_price_vnd::bigint;
  if v_line_usd > 2147483647 or v_line_vnd > 2147483647 then
    raise exception using errcode = '22003', message = 'order line is out of range';
  end if;

  new.unit_usd := v_price_usd;
  new.unit_vnd := v_price_vnd;
  new.line_usd := v_line_usd::integer;
  new.line_vnd := v_line_vnd::integer;
  new.is_custom := false;
  new.custom_ko_name := null;
  new.custom_vi_name := null;
  return new;
end;
$$;

create trigger trg_order_items_normalize
before insert or update on public.order_items
for each row execute function private.normalize_order_item();

create function private.normalize_order_custom_item()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_line_usd bigint;
  v_line_vnd bigint;
begin
  if new.qty is null
     or new.qty <= 0
     or new.unit_usd is null
     or new.unit_usd < 0
     or new.unit_vnd is null
     or new.unit_vnd < 0
     or length(btrim(coalesce(new.ko_name, ''))) = 0 then
    raise exception using errcode = '22023', message = 'custom order item is invalid';
  end if;

  v_line_usd := new.qty::bigint * new.unit_usd::bigint;
  v_line_vnd := new.qty::bigint * new.unit_vnd::bigint;
  if v_line_usd > 2147483647 or v_line_vnd > 2147483647 then
    raise exception using errcode = '22003', message = 'custom order line is out of range';
  end if;

  new.kind := coalesce(nullif(btrim(new.kind), ''), 'special');
  new.ko_name := btrim(new.ko_name);
  new.vi_name := nullif(btrim(new.vi_name), '');
  new.line_usd := v_line_usd::integer;
  new.line_vnd := v_line_vnd::integer;
  return new;
end;
$$;

create trigger trg_order_custom_items_normalize
before insert or update on public.order_custom_items
for each row execute function private.normalize_order_custom_item();

create function private.guard_order_derived_totals()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.total_usd := 0;
    new.total_vnd := 0;
  elsif (
      old.total_usd is distinct from new.total_usd
      or old.total_vnd is distinct from new.total_vnd
    )
    and current_user::text not in ('postgres', 'supabase_admin', 'service_role')
    and coalesce(pg_catalog.current_setting('app.total_recalc', true), 'off') <> 'on' then
    raise exception using
      errcode = '42501',
      message = 'order totals are derived from order items';
  end if;

  return new;
end;
$$;

create trigger trg_orders_guard_derived_totals
before insert or update on public.orders
for each row execute function private.guard_order_derived_totals();

create function private.recalculate_order_totals()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_order_ids uuid[];
  v_order_id uuid;
  v_total_usd bigint;
  v_total_vnd bigint;
begin
  if tg_op = 'DELETE' then
    v_order_ids := array[old.order_id];
  elsif tg_op = 'UPDATE' then
    v_order_ids := array[new.order_id, old.order_id];
  else
    v_order_ids := array[new.order_id];
  end if;

  perform pg_catalog.set_config('app.total_recalc', 'on', true);

  foreach v_order_id in array v_order_ids
  loop
    if v_order_id is null then
      continue;
    end if;

    if coalesce(pg_catalog.current_setting('app.deleting_order_id', true), '')
       = v_order_id::text then
      continue;
    end if;

    select
      coalesce(sum(lines.line_usd), 0),
      coalesce(sum(lines.line_vnd), 0)
    into v_total_usd, v_total_vnd
    from (
      select oi.line_usd::bigint as line_usd, oi.line_vnd::bigint as line_vnd
      from public.order_items as oi
      where oi.order_id = v_order_id
      union all
      select ci.line_usd::bigint, ci.line_vnd::bigint
      from public.order_custom_items as ci
      where ci.order_id = v_order_id
    ) as lines;

    if v_total_usd > 2147483647 or v_total_vnd > 2147483647 then
      raise exception using errcode = '22003', message = 'order total is out of range';
    end if;

    update public.orders
    set total_usd = v_total_usd::integer,
        total_vnd = v_total_vnd::integer
    where id = v_order_id;
  end loop;

  perform pg_catalog.set_config('app.total_recalc', 'off', true);
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger trg_order_items_recalculate_totals
after insert or update or delete on public.order_items
for each row execute function private.recalculate_order_totals();

create trigger trg_order_custom_items_recalculate_totals
after insert or update or delete on public.order_custom_items
for each row execute function private.recalculate_order_totals();

create function private.guard_order_delete_reference()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.resv_groups
    where confirmed_order_id = old.id
  ) then
    raise exception using
      errcode = '23503',
      message = 'unconfirm the reservation before deleting its order';
  end if;

  perform pg_catalog.set_config('app.deleting_order_id', old.id::text, true);
  return old;
end;
$$;

create trigger trg_orders_guard_reservation_reference
before delete on public.orders
for each row execute function private.guard_order_delete_reference();

create function private.guard_reservation_integrity()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.confirmed or old.confirmed_order_id is not null then
      raise exception using
        errcode = '23503',
        message = 'unconfirm the reservation before deleting it';
    end if;
    return old;
  end if;

  if new.confirmed then
    if new.confirmed_at is null
       or new.confirmed_order_id is null
       or not exists (
         select 1 from public.orders where id = new.confirmed_order_id
       ) then
      raise exception using errcode = '23514', message = 'confirmed reservation requires a valid order';
    end if;
  elsif new.confirmed_at is not null or new.confirmed_order_id is not null then
    raise exception using errcode = '23514', message = 'unconfirmed reservation cannot reference an order';
  end if;

  return new;
end;
$$;

create trigger trg_resv_groups_guard_integrity
before insert or update or delete on public.resv_groups
for each row execute function private.guard_reservation_integrity();

create function public.app_create_order(
  p_created_at timestamp with time zone,
  p_source text,
  p_status text,
  p_guide_name text,
  p_team_no text,
  p_payment_method text,
  p_items jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_order_id uuid;
  v_total_usd bigint := 0;
  v_total_vnd bigint := 0;
  v_payment_method text;
begin
  if not public.has_app_role(array['admin']::text[]) then
    raise exception using errcode = '42501', message = 'admin role required';
  end if;

  if p_items is null
     or pg_catalog.jsonb_typeof(p_items) <> 'array'
     or pg_catalog.jsonb_array_length(p_items) = 0
     or pg_catalog.jsonb_array_length(p_items) > 250 then
    raise exception using errcode = '22023', message = 'p_items must contain 1 to 250 items';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_items) as e(item)
    where pg_catalog.jsonb_typeof(e.item) <> 'object'
       or coalesce(e.item ->> 'item_type', '') not in ('menu', 'custom')
       or coalesce(e.item ->> 'qty', '') !~ '^[1-9][0-9]*$'
       or (
         e.item ->> 'item_type' = 'menu'
         and coalesce(e.item ->> 'menu_item_id', '')
           !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       )
       or (
         e.item ->> 'item_type' = 'custom'
         and (
           length(btrim(coalesce(e.item ->> 'ko_name', ''))) = 0
           or coalesce(e.item ->> 'unit_usd', '') !~ '^[0-9]+$'
           or coalesce(e.item ->> 'unit_vnd', '') !~ '^[0-9]+$'
         )
       )
  ) then
    raise exception using errcode = '22023', message = 'p_items contains an invalid item';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_items) as e(item)
    where (e.item ->> 'qty')::numeric > 100000
       or case when e.item ->> 'item_type' = 'custom' then
         (e.item ->> 'unit_usd')::numeric > 2147483647
         or (e.item ->> 'unit_vnd')::numeric > 2147483647
       else false end
       or case when e.item ->> 'item_type' = 'menu' then
         not exists (
           select 1
           from public.menu_items as m
           where m.id = (e.item ->> 'menu_item_id')::uuid
             and m.is_active = true
             and m.price_usd is not null
             and m.price_vnd is not null
             and m.price_usd >= 0
             and m.price_vnd >= 0
         )
       else false end
  ) then
    raise exception using errcode = '22023', message = 'p_items contains unavailable menu data or an out-of-range value';
  end if;

  v_payment_method := lower(coalesce(nullif(btrim(p_payment_method), ''), 'cash'));
  if v_payment_method not in ('cash', 'card', 'bank') then
    raise exception using errcode = '22023', message = 'invalid payment method';
  end if;

  if length(coalesce(p_source, '')) > 80
     or length(coalesce(p_status, '')) > 40
     or length(coalesce(p_guide_name, '')) > 200
     or length(coalesce(p_team_no, '')) > 200 then
    raise exception using errcode = '22023', message = 'order metadata is too long';
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
    coalesce(p_created_at, now()),
    coalesce(nullif(btrim(p_source), ''), 'calc_web'),
    coalesce(nullif(lower(btrim(p_status)), ''), 'paid'),
    0,
    0,
    nullif(btrim(p_guide_name), ''),
    nullif(btrim(p_team_no), ''),
    v_payment_method,
    false
  )
  returning id into v_order_id;

  insert into public.order_items (
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
  select
    v_order_id,
    m.id,
    (e.item ->> 'qty')::integer,
    m.price_usd,
    m.price_vnd,
    ((e.item ->> 'qty')::bigint * m.price_usd::bigint)::integer,
    ((e.item ->> 'qty')::bigint * m.price_vnd::bigint)::integer,
    false,
    null,
    null
  from pg_catalog.jsonb_array_elements(p_items) as e(item)
  join public.menu_items as m
    on m.id = case
      when e.item ->> 'item_type' = 'menu'
        then (e.item ->> 'menu_item_id')::uuid
      else null
    end
  where e.item ->> 'item_type' = 'menu';

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
  select
    v_order_id,
    coalesce(nullif(btrim(e.item ->> 'kind'), ''), 'special'),
    btrim(e.item ->> 'ko_name'),
    nullif(btrim(e.item ->> 'vi_name'), ''),
    (e.item ->> 'qty')::integer,
    (e.item ->> 'unit_usd')::integer,
    (e.item ->> 'unit_vnd')::integer,
    (
      (e.item ->> 'qty')::bigint
      * (e.item ->> 'unit_usd')::bigint
    )::integer,
    (
      (e.item ->> 'qty')::bigint
      * (e.item ->> 'unit_vnd')::bigint
    )::integer
  from pg_catalog.jsonb_array_elements(p_items) as e(item)
  where e.item ->> 'item_type' = 'custom';

  select
    coalesce(sum(lines.line_usd), 0),
    coalesce(sum(lines.line_vnd), 0)
  into v_total_usd, v_total_vnd
  from (
    select oi.line_usd::bigint as line_usd, oi.line_vnd::bigint as line_vnd
    from public.order_items as oi
    where oi.order_id = v_order_id
    union all
    select ci.line_usd::bigint, ci.line_vnd::bigint
    from public.order_custom_items as ci
    where ci.order_id = v_order_id
  ) as lines;

  if v_total_usd > 2147483647 or v_total_vnd > 2147483647 then
    raise exception using errcode = '22003', message = 'order total is out of range';
  end if;

  update public.orders
  set total_usd = v_total_usd::integer,
      total_vnd = v_total_vnd::integer
  where id = v_order_id;

  perform pg_catalog.set_config('app.rpc_write', 'off', true);
  return v_order_id;
end;
$$;

create function public.app_update_order(
  p_order_id uuid,
  p_status text,
  p_guide_name text,
  p_team_no text,
  p_payment_method text,
  p_items jsonb
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_total_usd bigint := 0;
  v_total_vnd bigint := 0;
  v_payment_method text;
begin
  if not public.has_app_role(array['admin']::text[]) then
    raise exception using errcode = '42501', message = 'admin role required';
  end if;

  if p_order_id is null then
    raise exception using errcode = '22023', message = 'p_order_id is required';
  end if;

  perform 1
  from public.orders
  where id = p_order_id
  for update;

  if not found then
    return false;
  end if;

  if p_items is null
     or pg_catalog.jsonb_typeof(p_items) <> 'array'
     or pg_catalog.jsonb_array_length(p_items) = 0
     or pg_catalog.jsonb_array_length(p_items) > 250 then
    raise exception using errcode = '22023', message = 'p_items must contain 1 to 250 items';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_items) as e(item)
    where pg_catalog.jsonb_typeof(e.item) <> 'object'
       or coalesce(e.item ->> 'item_type', '') not in ('menu', 'custom')
       or coalesce(e.item ->> 'qty', '') !~ '^[1-9][0-9]*$'
       or (
         e.item ->> 'item_type' = 'menu'
         and coalesce(e.item ->> 'menu_item_id', '')
           !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       )
       or (
         e.item ->> 'item_type' = 'custom'
         and (
           length(btrim(coalesce(e.item ->> 'ko_name', ''))) = 0
           or coalesce(e.item ->> 'unit_usd', '') !~ '^[0-9]+$'
           or coalesce(e.item ->> 'unit_vnd', '') !~ '^[0-9]+$'
         )
       )
  ) then
    raise exception using errcode = '22023', message = 'p_items contains an invalid item';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_items) as e(item)
    where (e.item ->> 'qty')::numeric > 100000
       or case when e.item ->> 'item_type' = 'custom' then
         (e.item ->> 'unit_usd')::numeric > 2147483647
         or (e.item ->> 'unit_vnd')::numeric > 2147483647
       else false end
       or case when e.item ->> 'item_type' = 'menu' then
         not exists (
           select 1
           from public.menu_items as m
           where m.id = (e.item ->> 'menu_item_id')::uuid
             and m.is_active = true
             and m.price_usd is not null
             and m.price_vnd is not null
             and m.price_usd >= 0
             and m.price_vnd >= 0
         )
       else false end
  ) then
    raise exception using errcode = '22023', message = 'p_items contains unavailable menu data or an out-of-range value';
  end if;

  v_payment_method := lower(coalesce(nullif(btrim(p_payment_method), ''), 'cash'));
  if v_payment_method not in ('cash', 'card', 'bank') then
    raise exception using errcode = '22023', message = 'invalid payment method';
  end if;

  if length(coalesce(p_status, '')) > 40
     or length(coalesce(p_guide_name, '')) > 200
     or length(coalesce(p_team_no, '')) > 200 then
    raise exception using errcode = '22023', message = 'order metadata is too long';
  end if;

  perform pg_catalog.set_config('app.rpc_write', 'on', true);

  delete from public.order_items where order_id = p_order_id;
  delete from public.order_custom_items where order_id = p_order_id;

  insert into public.order_items (
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
  select
    p_order_id,
    m.id,
    (e.item ->> 'qty')::integer,
    m.price_usd,
    m.price_vnd,
    ((e.item ->> 'qty')::bigint * m.price_usd::bigint)::integer,
    ((e.item ->> 'qty')::bigint * m.price_vnd::bigint)::integer,
    false,
    null,
    null
  from pg_catalog.jsonb_array_elements(p_items) as e(item)
  join public.menu_items as m
    on m.id = case
      when e.item ->> 'item_type' = 'menu'
        then (e.item ->> 'menu_item_id')::uuid
      else null
    end
  where e.item ->> 'item_type' = 'menu';

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
  select
    p_order_id,
    coalesce(nullif(btrim(e.item ->> 'kind'), ''), 'special'),
    btrim(e.item ->> 'ko_name'),
    nullif(btrim(e.item ->> 'vi_name'), ''),
    (e.item ->> 'qty')::integer,
    (e.item ->> 'unit_usd')::integer,
    (e.item ->> 'unit_vnd')::integer,
    (
      (e.item ->> 'qty')::bigint
      * (e.item ->> 'unit_usd')::bigint
    )::integer,
    (
      (e.item ->> 'qty')::bigint
      * (e.item ->> 'unit_vnd')::bigint
    )::integer
  from pg_catalog.jsonb_array_elements(p_items) as e(item)
  where e.item ->> 'item_type' = 'custom';

  select
    coalesce(sum(lines.line_usd), 0),
    coalesce(sum(lines.line_vnd), 0)
  into v_total_usd, v_total_vnd
  from (
    select oi.line_usd::bigint as line_usd, oi.line_vnd::bigint as line_vnd
    from public.order_items as oi
    where oi.order_id = p_order_id
    union all
    select ci.line_usd::bigint, ci.line_vnd::bigint
    from public.order_custom_items as ci
    where ci.order_id = p_order_id
  ) as lines;

  if v_total_usd > 2147483647 or v_total_vnd > 2147483647 then
    raise exception using errcode = '22003', message = 'order total is out of range';
  end if;

  update public.orders
  set status = coalesce(nullif(lower(btrim(p_status)), ''), status),
      guide_name = nullif(btrim(p_guide_name), ''),
      team_no = nullif(btrim(p_team_no), ''),
      payment_method = v_payment_method,
      total_usd = v_total_usd::integer,
      total_vnd = v_total_vnd::integer
  where id = p_order_id;

  perform pg_catalog.set_config('app.rpc_write', 'off', true);
  return true;
end;
$$;

create function public.app_delete_order(p_order_id uuid)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_deleted_id uuid;
begin
  if not public.has_app_role(array['admin']::text[]) then
    raise exception using errcode = '42501', message = 'admin role required';
  end if;

  if exists (
    select 1
    from public.resv_groups
    where confirmed_order_id = p_order_id
  ) then
    raise exception using
      errcode = '23503',
      message = 'unconfirm the reservation before deleting its order';
  end if;

  perform pg_catalog.set_config('app.rpc_write', 'on', true);

  delete from public.orders
  where id = p_order_id
  returning id into v_deleted_id;

  perform pg_catalog.set_config('app.rpc_write', 'off', true);
  return v_deleted_id is not null;
end;
$$;

create function public.app_set_sales_excluded(
  p_order_id uuid,
  p_excluded boolean
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_updated_id uuid;
begin
  if not public.has_app_role(array['admin']::text[]) then
    raise exception using errcode = '42501', message = 'admin role required';
  end if;

  if p_excluded is null then
    raise exception using errcode = '22023', message = 'p_excluded is required';
  end if;

  perform pg_catalog.set_config('app.rpc_write', 'on', true);

  update public.orders
  set sales_excluded = p_excluded
  where id = p_order_id
    and payment_method = 'cash'
  returning id into v_updated_id;

  perform pg_catalog.set_config('app.rpc_write', 'off', true);
  return v_updated_id is not null;
end;
$$;

create function public.app_create_reservation(
  p_res_date date,
  p_res_time time without time zone,
  p_guests_count integer,
  p_price integer,
  p_menu_ko text,
  p_menu_vi text,
  p_note text,
  p_branch text,
  p_guide_name text
)
returns bigint
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_reservation_id bigint;
begin
  if not public.has_app_role(array['admin']::text[]) then
    raise exception using errcode = '42501', message = 'admin role required';
  end if;

  if p_res_date is null or p_res_time is null then
    raise exception using errcode = '22023', message = 'reservation date and time are required';
  end if;

  if p_guests_count is null or p_guests_count <= 0 or p_guests_count > 100000 then
    raise exception using errcode = '22023', message = 'guest count must be between 1 and 100000';
  end if;

  if p_price is not null and p_price < 0 then
    raise exception using errcode = '22023', message = 'price must be zero or greater';
  end if;

  if length(btrim(coalesce(p_branch, ''))) = 0
     or length(p_branch) > 200
     or length(coalesce(p_menu_ko, '')) > 500
     or length(coalesce(p_menu_vi, '')) > 500
     or length(coalesce(p_guide_name, '')) > 200
     or length(coalesce(p_note, '')) > 4000 then
    raise exception using errcode = '22023', message = 'reservation text is missing or too long';
  end if;

  perform pg_catalog.set_config('app.rpc_write', 'on', true);

  insert into public.resv_groups (
    res_date,
    res_time,
    guests_count,
    price,
    menu_ko,
    menu_vi,
    note,
    branch,
    guide_name,
    confirmed,
    confirmed_at,
    confirmed_order_id
  )
  values (
    p_res_date,
    p_res_time,
    p_guests_count,
    p_price,
    nullif(btrim(p_menu_ko), ''),
    nullif(btrim(p_menu_vi), ''),
    nullif(btrim(p_note), ''),
    btrim(p_branch),
    nullif(btrim(p_guide_name), ''),
    false,
    null,
    null
  )
  returning id into v_reservation_id;

  perform pg_catalog.set_config('app.rpc_write', 'off', true);
  return v_reservation_id;
end;
$$;

create function public.app_update_reservation(
  p_id bigint,
  p_res_date date,
  p_res_time time without time zone,
  p_guests_count integer,
  p_price integer,
  p_menu_ko text,
  p_menu_vi text,
  p_note text,
  p_branch text,
  p_guide_name text
)
returns bigint
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not public.has_app_role(array['admin']::text[]) then
    raise exception using errcode = '42501', message = 'admin role required';
  end if;

  if p_id is null or p_res_date is null or p_res_time is null then
    raise exception using errcode = '22023', message = 'reservation id, date, and time are required';
  end if;

  if p_guests_count is null or p_guests_count <= 0 or p_guests_count > 100000 then
    raise exception using errcode = '22023', message = 'guest count must be between 1 and 100000';
  end if;

  if p_price is not null and p_price < 0 then
    raise exception using errcode = '22023', message = 'price must be zero or greater';
  end if;

  if length(btrim(coalesce(p_branch, ''))) = 0
     or length(p_branch) > 200
     or length(coalesce(p_menu_ko, '')) > 500
     or length(coalesce(p_menu_vi, '')) > 500
     or length(coalesce(p_guide_name, '')) > 200
     or length(coalesce(p_note, '')) > 4000 then
    raise exception using errcode = '22023', message = 'reservation text is missing or too long';
  end if;

  perform 1
  from public.resv_groups
  where id = p_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'reservation not found';
  end if;

  perform pg_catalog.set_config('app.rpc_write', 'on', true);

  update public.resv_groups
  set res_date = p_res_date,
      res_time = p_res_time,
      guests_count = p_guests_count,
      price = p_price,
      menu_ko = nullif(btrim(p_menu_ko), ''),
      menu_vi = nullif(btrim(p_menu_vi), ''),
      note = nullif(btrim(p_note), ''),
      branch = btrim(p_branch),
      guide_name = nullif(btrim(p_guide_name), '')
  where id = p_id;

  perform pg_catalog.set_config('app.rpc_write', 'off', true);
  return p_id;
end;
$$;

create function public.app_delete_reservation(p_id bigint)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_deleted_id bigint;
begin
  if not public.has_app_role(array['admin']::text[]) then
    raise exception using errcode = '42501', message = 'admin role required';
  end if;

  if exists (
    select 1
    from public.resv_groups
    where id = p_id
      and (confirmed = true or confirmed_order_id is not null)
  ) then
    raise exception using
      errcode = '23503',
      message = 'unconfirm the reservation before deleting it';
  end if;

  perform pg_catalog.set_config('app.rpc_write', 'on', true);

  delete from public.resv_groups
  where id = p_id
  returning id into v_deleted_id;

  perform pg_catalog.set_config('app.rpc_write', 'off', true);
  return v_deleted_id is not null;
end;
$$;

create function public.app_confirm_reservation(
  p_id bigint,
  p_payment_method text,
  p_team_no text
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_reservation public.resv_groups%rowtype;
  v_order_id uuid;
  v_line_vnd bigint;
  v_payment_method text;
begin
  if not public.has_app_role(array['admin']::text[]) then
    raise exception using errcode = '42501', message = 'admin role required';
  end if;

  select *
  into v_reservation
  from public.resv_groups
  where id = p_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'reservation not found';
  end if;

  if v_reservation.confirmed then
    if v_reservation.confirmed_order_id is not null then
      return v_reservation.confirmed_order_id;
    end if;
    raise exception using errcode = '23514', message = 'confirmed reservation has no order id';
  end if;

  if v_reservation.price is null or v_reservation.price <= 0 then
    raise exception using errcode = '22023', message = 'a positive reservation price is required';
  end if;

  if length(btrim(coalesce(v_reservation.menu_ko, ''))) = 0 then
    raise exception using errcode = '22023', message = 'a reservation menu is required';
  end if;

  v_payment_method := lower(coalesce(nullif(btrim(p_payment_method), ''), 'cash'));
  if v_payment_method not in ('cash', 'card', 'bank') then
    raise exception using errcode = '22023', message = 'invalid payment method';
  end if;

  if length(coalesce(p_team_no, '')) > 200 then
    raise exception using errcode = '22023', message = 'team number is too long';
  end if;

  v_line_vnd := v_reservation.price::bigint * v_reservation.guests_count::bigint;
  if v_line_vnd > 2147483647 then
    raise exception using errcode = '22003', message = 'reservation total is out of range';
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
    (v_reservation.res_date + v_reservation.res_time)
      at time zone 'Asia/Ho_Chi_Minh',
    'reservation_confirm',
    'paid',
    0,
    v_line_vnd::integer,
    v_reservation.guide_name,
    nullif(btrim(p_team_no), ''),
    v_payment_method,
    false
  )
  returning id into v_order_id;

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
    v_order_id,
    'group_resv',
    btrim(v_reservation.menu_ko),
    nullif(btrim(v_reservation.menu_vi), ''),
    v_reservation.guests_count,
    0,
    v_reservation.price,
    0,
    v_line_vnd::integer
  );

  update public.resv_groups
  set confirmed = true,
      confirmed_at = now(),
      confirmed_order_id = v_order_id
  where id = p_id;

  perform pg_catalog.set_config('app.rpc_write', 'off', true);
  return v_order_id;
end;
$$;

create function public.app_unconfirm_reservation(p_id bigint)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_reservation public.resv_groups%rowtype;
  v_source text;
begin
  if not public.has_app_role(array['admin']::text[]) then
    raise exception using errcode = '42501', message = 'admin role required';
  end if;

  select *
  into v_reservation
  from public.resv_groups
  where id = p_id
  for update;

  if not found then
    return false;
  end if;

  if not v_reservation.confirmed and v_reservation.confirmed_order_id is null then
    return true;
  end if;

  if v_reservation.confirmed_order_id is null then
    perform pg_catalog.set_config('app.rpc_write', 'on', true);
    update public.resv_groups
    set confirmed = false,
        confirmed_at = null,
        confirmed_order_id = null
    where id = p_id;
    perform pg_catalog.set_config('app.rpc_write', 'off', true);
    return true;
  end if;

  select source
  into v_source
  from public.orders
  where id = v_reservation.confirmed_order_id
  for update;

  if not found or v_source is distinct from 'reservation_confirm' then
    raise exception using
      errcode = '23514',
      message = 'linked order is missing or was not created from a reservation';
  end if;

  if exists (
    select 1
    from public.order_items
    where order_id = v_reservation.confirmed_order_id
  ) or exists (
    select 1
    from public.order_custom_items
    where order_id = v_reservation.confirmed_order_id
      and coalesce(kind, '') <> 'group_resv'
  ) then
    raise exception using
      errcode = '23514',
      message = 'linked order contains non-reservation items';
  end if;

  perform pg_catalog.set_config('app.rpc_write', 'on', true);

  update public.resv_groups
  set confirmed = false,
      confirmed_at = null,
      confirmed_order_id = null
  where id = p_id;

  delete from public.orders
  where id = v_reservation.confirmed_order_id;

  perform pg_catalog.set_config('app.rpc_write', 'off', true);
  return true;
end;
$$;

-- Remove implicit Data API reachability, then add only the grants used by the
-- application. RLS remains the row-level authorization layer for authenticated
-- users; grants are the independent object-level layer.
revoke all on all tables in schema public from anon, authenticated, service_role;
revoke all on all sequences in schema public from anon, authenticated, service_role;
revoke execute on all functions in schema public from public, anon, authenticated, service_role;
revoke execute on all functions in schema private from public, anon, authenticated, service_role;

revoke create on schema public from public, anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;

grant select on table public.notices to anon;

grant select on table public.menu_items to authenticated;

grant select, insert, update, delete on table
  public.orders,
  public.order_items,
  public.order_custom_items,
  public.resv_groups,
  public.notices
to authenticated;

grant usage, select on sequence public.resv_groups_id_seq to authenticated;

grant select on table
  public.v_order_detail_all,
  public.v_order_detail,
  public.v_sales_daily,
  public.v_sales_monthly
to authenticated;

grant select, insert, update, delete on table
  public.menu_items,
  public.orders,
  public.order_items,
  public.order_custom_items,
  public.resv_groups,
  public.notices,
  public.notification_outbox
to service_role;

grant select, insert, update, delete on table
  public.admin_settings,
  public.page_access_code
to service_role;

grant usage, select on sequence public.resv_groups_id_seq to service_role;

grant select on table
  public.v_order_detail_all,
  public.v_order_detail,
  public.v_sales_daily,
  public.v_sales_monthly
to service_role;

-- Sensitive configuration has no anon/authenticated grants. The credential Edge
-- path receives only the controlled CRUD object privileges it needs through
-- service_role; admin_kv remains fully private and unused.

grant execute on function public.current_app_role() to authenticated;
grant execute on function public.has_app_role(text[]) to authenticated;

grant usage on schema extensions to service_role;
grant execute on function extensions.crypt(text, text) to service_role;
grant execute on function extensions.gen_salt(text, integer) to service_role;
grant execute on function public.internal_hash_legacy_password(text) to service_role;

grant execute on function public.app_create_order(
  timestamp with time zone,
  text,
  text,
  text,
  text,
  text,
  jsonb
) to authenticated;

grant execute on function public.app_update_order(
  uuid,
  text,
  text,
  text,
  text,
  jsonb
) to authenticated;

grant execute on function public.app_delete_order(uuid) to authenticated;
grant execute on function public.app_set_sales_excluded(uuid, boolean) to authenticated;

grant execute on function public.app_create_reservation(
  date,
  time without time zone,
  integer,
  integer,
  text,
  text,
  text,
  text,
  text
) to authenticated;

grant execute on function public.app_update_reservation(
  bigint,
  date,
  time without time zone,
  integer,
  integer,
  text,
  text,
  text,
  text,
  text
) to authenticated;

grant execute on function public.app_delete_reservation(bigint) to authenticated;
grant execute on function public.app_confirm_reservation(bigint, text, text) to authenticated;
grant execute on function public.app_unconfirm_reservation(bigint) to authenticated;

-- New objects are private until a future migration deliberately grants access.
alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated, service_role;

alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated, service_role;

alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated, service_role;

alter default privileges for role postgres in schema private
  revoke all on tables from anon, authenticated, service_role;

alter default privileges for role postgres in schema private
  revoke all on sequences from anon, authenticated, service_role;

alter default privileges for role postgres in schema private
  revoke execute on functions from public, anon, authenticated, service_role;
