-- Add the manager application role without turning it into an administrator
-- alias. Managers may use the ordinary operating pages, but cannot read or
-- mutate sales-excluded ledger rows, reservations linked to those rows, the
-- three Hidden views, monthly KB reporting, or credential settings.
--
-- This migration changes authorization metadata only. It does not create the
-- technical Auth user and it does not insert, update, or delete business rows.

set lock_timeout = '5s';

-- Authorization continues to rely only on server-controlled app_metadata.
-- Do not map manager to admin in has_app_role(); each allowed operation below
-- opts in explicitly so future administrator-only endpoints stay closed.
create or replace function public.current_app_role()
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select case
    when (select auth.jwt()) -> 'app_metadata' ->> 'role'
      in ('staff', 'manager', 'admin')
      then (select auth.jwt()) -> 'app_metadata' ->> 'role'
    else null
  end
$$;

-- Keep the sales-exclusion bit strictly administrator-only, including at the
-- trigger boundary. The service roles retain the existing maintenance bypass.
create or replace function private.guard_orders_admin_fields()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if old.sales_excluded is distinct from new.sales_excluded
     and current_user::text not in ('postgres', 'supabase_admin', 'service_role')
     and public.current_app_role() is distinct from 'admin' then
    raise exception using
      errcode = '42501',
      message = 'admin role required to change sales_excluded';
  end if;

  return new;
end;
$$;

create or replace function public.app_set_sales_excluded(
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
  if public.current_app_role() is distinct from 'admin' then
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

-- Confirmation fields are used by the ordinary reservation-management page.
-- Row policies below still prevent a manager from reaching a reservation
-- linked to a sales-excluded order.
create or replace function private.guard_reservation_confirmation_fields()
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
     and not coalesce(
       public.current_app_role() in ('manager', 'admin'),
       false
     ) then
    raise exception using
      errcode = '42501',
      message = 'manager or admin role required to change reservation confirmation';
  end if;

  return new;
end;
$$;

-- -------------------------------------------------------------------------
-- Manager row policies
-- -------------------------------------------------------------------------

drop policy if exists menu_items_manager_read on public.menu_items;
create policy menu_items_manager_read
on public.menu_items
for select
to authenticated
using ((select public.current_app_role()) = 'manager');

-- A manager receives only the non-excluded sales ledger. Keeping this as a
-- separate policy preserves the existing unrestricted administrator policy.
drop policy if exists orders_manager_read on public.orders;
create policy orders_manager_read
on public.orders
for select
to authenticated
using (
  (select public.current_app_role()) = 'manager'
  and sales_excluded is false
);

drop policy if exists orders_manager_insert on public.orders;
create policy orders_manager_insert
on public.orders
for insert
to authenticated
with check (
  (select public.current_app_role()) = 'manager'
  and sales_excluded is false
);

drop policy if exists orders_manager_update on public.orders;
create policy orders_manager_update
on public.orders
for update
to authenticated
using (
  (select public.current_app_role()) = 'manager'
  and sales_excluded is false
)
with check (
  (select public.current_app_role()) = 'manager'
  and sales_excluded is false
);

drop policy if exists orders_manager_delete on public.orders;
create policy orders_manager_delete
on public.orders
for delete
to authenticated
using (
  (select public.current_app_role()) = 'manager'
  and sales_excluded is false
);

-- Order-line access follows the visible parent order. Primary/FK indexes make
-- these existence checks bounded and prevent a child-row API bypass.
drop policy if exists order_items_manager_read on public.order_items;
create policy order_items_manager_read
on public.order_items
for select
to authenticated
using (
  (select public.current_app_role()) = 'manager'
  and exists (
    select 1
    from public.orders as manager_order
    where manager_order.id = order_items.order_id
      and manager_order.sales_excluded is false
  )
);

drop policy if exists order_items_manager_insert on public.order_items;
create policy order_items_manager_insert
on public.order_items
for insert
to authenticated
with check (
  (select public.current_app_role()) = 'manager'
  and exists (
    select 1
    from public.orders as manager_order
    where manager_order.id = order_items.order_id
      and manager_order.sales_excluded is false
  )
);

drop policy if exists order_items_manager_update on public.order_items;
create policy order_items_manager_update
on public.order_items
for update
to authenticated
using (
  (select public.current_app_role()) = 'manager'
  and exists (
    select 1
    from public.orders as manager_order
    where manager_order.id = order_items.order_id
      and manager_order.sales_excluded is false
  )
)
with check (
  (select public.current_app_role()) = 'manager'
  and exists (
    select 1
    from public.orders as manager_order
    where manager_order.id = order_items.order_id
      and manager_order.sales_excluded is false
  )
);

drop policy if exists order_items_manager_delete on public.order_items;
create policy order_items_manager_delete
on public.order_items
for delete
to authenticated
using (
  (select public.current_app_role()) = 'manager'
  and exists (
    select 1
    from public.orders as manager_order
    where manager_order.id = order_items.order_id
      and manager_order.sales_excluded is false
  )
);

drop policy if exists order_custom_items_manager_read on public.order_custom_items;
create policy order_custom_items_manager_read
on public.order_custom_items
for select
to authenticated
using (
  (select public.current_app_role()) = 'manager'
  and exists (
    select 1
    from public.orders as manager_order
    where manager_order.id = order_custom_items.order_id
      and manager_order.sales_excluded is false
  )
);

drop policy if exists order_custom_items_manager_insert on public.order_custom_items;
create policy order_custom_items_manager_insert
on public.order_custom_items
for insert
to authenticated
with check (
  (select public.current_app_role()) = 'manager'
  and exists (
    select 1
    from public.orders as manager_order
    where manager_order.id = order_custom_items.order_id
      and manager_order.sales_excluded is false
  )
);

drop policy if exists order_custom_items_manager_update on public.order_custom_items;
create policy order_custom_items_manager_update
on public.order_custom_items
for update
to authenticated
using (
  (select public.current_app_role()) = 'manager'
  and exists (
    select 1
    from public.orders as manager_order
    where manager_order.id = order_custom_items.order_id
      and manager_order.sales_excluded is false
  )
)
with check (
  (select public.current_app_role()) = 'manager'
  and exists (
    select 1
    from public.orders as manager_order
    where manager_order.id = order_custom_items.order_id
      and manager_order.sales_excluded is false
  )
);

drop policy if exists order_custom_items_manager_delete on public.order_custom_items;
create policy order_custom_items_manager_delete
on public.order_custom_items
for delete
to authenticated
using (
  (select public.current_app_role()) = 'manager'
  and exists (
    select 1
    from public.orders as manager_order
    where manager_order.id = order_custom_items.order_id
      and manager_order.sales_excluded is false
  )
);

-- A linked reservation is visible to a manager only when its generated order
-- is also visible. Unconfirmed reservations have no linked order and remain
-- available on the ordinary reservation pages.
drop policy if exists resv_groups_manager_read on public.resv_groups;
create policy resv_groups_manager_read
on public.resv_groups
for select
to authenticated
using (
  (select public.current_app_role()) = 'manager'
  and (
    confirmed_order_id is null
    or exists (
      select 1
      from public.orders as manager_order
      where manager_order.id = resv_groups.confirmed_order_id
        and manager_order.sales_excluded is false
    )
  )
);

drop policy if exists resv_groups_manager_insert on public.resv_groups;
create policy resv_groups_manager_insert
on public.resv_groups
for insert
to authenticated
with check (
  (select public.current_app_role()) = 'manager'
  and confirmed is false
  and confirmed_at is null
  and confirmed_order_id is null
);

drop policy if exists resv_groups_manager_update on public.resv_groups;
create policy resv_groups_manager_update
on public.resv_groups
for update
to authenticated
using (
  (select public.current_app_role()) = 'manager'
  and (
    confirmed_order_id is null
    or exists (
      select 1
      from public.orders as manager_order
      where manager_order.id = resv_groups.confirmed_order_id
        and manager_order.sales_excluded is false
    )
  )
)
with check (
  (select public.current_app_role()) = 'manager'
  and (
    confirmed_order_id is null
    or exists (
      select 1
      from public.orders as manager_order
      where manager_order.id = resv_groups.confirmed_order_id
        and manager_order.sales_excluded is false
    )
  )
);

drop policy if exists resv_groups_manager_delete on public.resv_groups;
create policy resv_groups_manager_delete
on public.resv_groups
for delete
to authenticated
using (
  (select public.current_app_role()) = 'manager'
  and (
    confirmed_order_id is null
    or exists (
      select 1
      from public.orders as manager_order
      where manager_order.id = resv_groups.confirmed_order_id
        and manager_order.sales_excluded is false
    )
  )
);

drop policy if exists qr_tables_manager_read on public.qr_tables;
create policy qr_tables_manager_read
on public.qr_tables
for select
to authenticated
using ((select public.current_app_role()) = 'manager');

-- Finalized QR history follows the same non-excluded ledger boundary. Open and
-- cancelled QR orders do not expose a live paid-order ledger row.
drop policy if exists qr_orders_manager_read on public.qr_orders;
create policy qr_orders_manager_read
on public.qr_orders
for select
to authenticated
using (
  (select public.current_app_role()) = 'manager'
  and (
    (
      finalized_order_id is null
      and voided_order_id is null
    )
    or exists (
      select 1
      from public.orders as manager_order
      where manager_order.id = qr_orders.finalized_order_id
        and manager_order.sales_excluded is false
    )
  )
);

drop policy if exists qr_order_items_manager_read on public.qr_order_items;
create policy qr_order_items_manager_read
on public.qr_order_items
for select
to authenticated
using (
  (select public.current_app_role()) = 'manager'
  and exists (
    select 1
    from public.qr_orders as manager_qr_order
    where manager_qr_order.id = qr_order_items.qr_order_id
  )
);

drop policy if exists notices_manager_insert on public.notices;
create policy notices_manager_insert
on public.notices
for insert
to authenticated
with check ((select public.current_app_role()) = 'manager');

drop policy if exists notices_manager_update on public.notices;
create policy notices_manager_update
on public.notices
for update
to authenticated
using ((select public.current_app_role()) = 'manager')
with check ((select public.current_app_role()) = 'manager');

drop policy if exists notices_manager_delete on public.notices;
create policy notices_manager_delete
on public.notices
for delete
to authenticated
using ((select public.current_app_role()) = 'manager');

drop policy if exists restaurant_expenses_manager_update on public.restaurant_expenses;
create policy restaurant_expenses_manager_update
on public.restaurant_expenses
for update
to authenticated
using ((select public.current_app_role()) = 'manager')
with check ((select public.current_app_role()) = 'manager');

drop policy if exists restaurant_expenses_manager_delete on public.restaurant_expenses;
create policy restaurant_expenses_manager_delete
on public.restaurant_expenses
for delete
to authenticated
using ((select public.current_app_role()) = 'manager');

-- Menu images retain the administrator filename and bucket constraints.
drop policy if exists qr_menu_images_manager_select on storage.objects;
create policy qr_menu_images_manager_select
on storage.objects
for select
to authenticated
using (
  bucket_id = 'qr-menu-images'
  and (select public.current_app_role()) = 'manager'
);

drop policy if exists qr_menu_images_manager_insert on storage.objects;
create policy qr_menu_images_manager_insert
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'qr-menu-images'
  and (select public.current_app_role()) = 'manager'
  and name ~ '^menus/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpe?g|png|webp)$'
);

drop policy if exists qr_menu_images_manager_update on storage.objects;
create policy qr_menu_images_manager_update
on storage.objects
for update
to authenticated
using (
  bucket_id = 'qr-menu-images'
  and (select public.current_app_role()) = 'manager'
)
with check (
  bucket_id = 'qr-menu-images'
  and (select public.current_app_role()) = 'manager'
  and name ~ '^menus/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpe?g|png|webp)$'
);

drop policy if exists qr_menu_images_manager_delete on storage.objects;
create policy qr_menu_images_manager_delete
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'qr-menu-images'
  and (select public.current_app_role()) = 'manager'
);

-- -------------------------------------------------------------------------
-- RPC authorization gates
-- -------------------------------------------------------------------------
-- Several long functions have been hardened in later migrations. Rebuilding
-- them from an older source copy would silently regress those fixes. Transform
-- only one exact authorization expression in each exact signature, fail if the
-- live definition differs, and verify the old gate is gone afterwards.
do $manager_rpc_gates$
declare
  v_signature text;
  v_oid regprocedure;
  v_definition text;
  v_rewritten text;
  v_old text;
  v_new text;
  v_count integer;
begin
  v_old := 'array[''admin'']::text[]';
  v_new := 'array[''manager'', ''admin'']::text[]';

  foreach v_signature in array array[
    'public.app_create_order(timestamp with time zone,text,text,text,text,text,jsonb)',
    'public.app_update_order(uuid,text,text,text,text,jsonb)',
    'public.app_create_reservation(date,time without time zone,integer,integer,text,text,text,text,text)',
    'public.app_update_reservation(bigint,date,time without time zone,integer,integer,text,text,text,text,text)',
    'public.app_delete_reservation(bigint)',
    'public.app_confirm_reservation(bigint,text,text)',
    'public.app_update_and_confirm_reservation(bigint,date,time without time zone,integer,integer,text,text,text,text,text,text,text)',
    'public.app_unconfirm_reservation(bigint)',
    'private.app_archive_menu_item_impl(uuid)',
    'private.app_create_menu_item_impl(jsonb)',
    'private.app_update_menu_item_impl(uuid,jsonb)',
    'private.app_restore_menu_item_impl(uuid)',
    'private.app_get_menu_combo_components_impl(uuid)',
    'private.app_archive_qr_table_impl(uuid)',
    'private.app_create_hotel_qr_impl(text)',
    'private.app_create_qr_table_impl(text)',
    'private.app_get_qr_table_token_impl(uuid)',
    'private.app_register_existing_qr_token_impl(uuid,text)',
    'private.app_rotate_qr_table_token_impl(uuid)',
    'private.app_set_qr_table_active_impl(uuid,boolean)'
  ]
  loop
    v_oid := pg_catalog.to_regprocedure(v_signature);
    if v_oid is null then
      raise exception 'manager migration: required function is missing: %', v_signature;
    end if;

    v_definition := pg_catalog.pg_get_functiondef(v_oid);
    v_count := (
      pg_catalog.length(v_definition)
      - pg_catalog.length(pg_catalog.replace(v_definition, v_old, ''))
    ) / pg_catalog.length(v_old);
    if v_count <> 1 then
      raise exception
        'manager migration: expected one admin gate in %, found %',
        v_signature,
        v_count;
    end if;

    v_rewritten := pg_catalog.replace(v_definition, v_old, v_new);
    execute v_rewritten;

    v_definition := pg_catalog.pg_get_functiondef(
      pg_catalog.to_regprocedure(v_signature)
    );
    if pg_catalog.strpos(v_definition, v_old) > 0
       or pg_catalog.strpos(v_definition, v_new) = 0 then
      raise exception 'manager migration: failed to rewrite gate in %', v_signature;
    end if;
  end loop;

  v_old := 'array[''staff'', ''admin'']::text[]';
  v_new := 'array[''staff'', ''manager'', ''admin'']::text[]';
  foreach v_signature in array array[
    'private.app_finalize_qr_table_orders_checked_impl(uuid,jsonb,text,text,text)'
  ]
  loop
    v_oid := pg_catalog.to_regprocedure(v_signature);
    if v_oid is null then
      raise exception 'manager migration: required function is missing: %', v_signature;
    end if;
    v_definition := pg_catalog.pg_get_functiondef(v_oid);
    v_count := (
      pg_catalog.length(v_definition)
      - pg_catalog.length(pg_catalog.replace(v_definition, v_old, ''))
    ) / pg_catalog.length(v_old);
    if v_count <> 1 then
      raise exception
        'manager migration: expected one staff/admin gate in %, found %',
        v_signature,
        v_count;
    end if;
    execute pg_catalog.replace(v_definition, v_old, v_new);
    v_definition := pg_catalog.pg_get_functiondef(
      pg_catalog.to_regprocedure(v_signature)
    );
    if pg_catalog.strpos(v_definition, v_old) > 0
       or pg_catalog.strpos(v_definition, v_new) = 0 then
      raise exception 'manager migration: failed to rewrite gate in %', v_signature;
    end if;
  end loop;

  v_old := 'v_role not in (''staff'', ''admin'')';
  v_new := 'v_role not in (''staff'', ''manager'', ''admin'')';
  foreach v_signature in array array[
    'private.app_update_qr_order_impl(uuid,timestamp with time zone,text,jsonb)',
    'private.app_update_qr_order_status_impl(uuid,text)'
  ]
  loop
    v_oid := pg_catalog.to_regprocedure(v_signature);
    if v_oid is null then
      raise exception 'manager migration: required function is missing: %', v_signature;
    end if;
    v_definition := pg_catalog.pg_get_functiondef(v_oid);
    v_count := (
      pg_catalog.length(v_definition)
      - pg_catalog.length(pg_catalog.replace(v_definition, v_old, ''))
    ) / pg_catalog.length(v_old);
    if v_count <> 1 then
      raise exception
        'manager migration: expected one staff/admin role list in %, found %',
        v_signature,
        v_count;
    end if;
    execute pg_catalog.replace(v_definition, v_old, v_new);
    v_definition := pg_catalog.pg_get_functiondef(
      pg_catalog.to_regprocedure(v_signature)
    );
    if pg_catalog.strpos(v_definition, v_old) > 0
       or pg_catalog.strpos(v_definition, v_new) = 0 then
      raise exception 'manager migration: failed to rewrite role list in %', v_signature;
    end if;
  end loop;
end;
$manager_rpc_gates$;

-- Both QR edit helpers are SECURITY DEFINER. Their normal open-order checks
-- prevent mutation after checkout, but the status helper has an idempotent
-- return path and both helpers can otherwise distinguish a guessed finalized
-- QR id. Make a QR row backed by an excluded sale look absent to managers.
do $manager_qr_order_target_gates$
declare
  v_signature text;
  v_oid regprocedure;
  v_definition text;
  v_old_anchor constant text := E'  if not found then\n    raise exception using errcode = ''P0002'', message = ''QR order not found'';\n  end if;';
  v_new_anchor constant text := E'  if not found then\n    raise exception using errcode = ''P0002'', message = ''QR order not found'';\n  end if;\n\n  if v_role = ''manager'' and v_order.voided_order_id is not null then\n    raise exception using\n      errcode = ''P0002'',\n      message = ''QR order not found'';\n  end if;\n\n  if v_role = ''manager'' and v_order.finalized_order_id is not null then\n    perform paid_order.id\n    from public.orders as paid_order\n    where paid_order.id = v_order.finalized_order_id\n      and paid_order.sales_excluded is false\n    for share;\n\n    if not found then\n      raise exception using\n        errcode = ''P0002'',\n        message = ''QR order not found'';\n    end if;\n  end if;';
  v_count integer;
begin
  foreach v_signature in array array[
    'private.app_update_qr_order_impl(uuid,timestamp with time zone,text,jsonb)',
    'private.app_update_qr_order_status_impl(uuid,text)'
  ]
  loop
    v_oid := pg_catalog.to_regprocedure(v_signature);
    if v_oid is null then
      raise exception 'manager migration: required function is missing: %', v_signature;
    end if;

    v_definition := pg_catalog.pg_get_functiondef(v_oid);
    v_count := (
      pg_catalog.length(v_definition)
      - pg_catalog.length(pg_catalog.replace(v_definition, v_old_anchor, ''))
    ) / pg_catalog.length(v_old_anchor);
    if v_count <> 1 then
      raise exception
        'manager migration: expected one QR order target anchor in %, found %',
        v_signature,
        v_count;
    end if;

    execute pg_catalog.replace(v_definition, v_old_anchor, v_new_anchor);

    v_definition := pg_catalog.pg_get_functiondef(
      pg_catalog.to_regprocedure(v_signature)
    );
    if pg_catalog.strpos(v_definition, v_new_anchor) = 0 then
      raise exception
        'manager migration: QR order target guard verification failed in %',
        v_signature;
    end if;
  end loop;
end;
$manager_qr_order_target_gates$;

-- A retried table checkout can return an already-created paid order from this
-- SECURITY DEFINER function. Keep that idempotency path for staff/admin, but
-- do not let a manager recover the identifier of an order later marked as
-- sales-excluded.
do $manager_qr_checkout_target_gate$
declare
  v_signature constant text :=
    'private.app_finalize_qr_table_orders_checked_impl(uuid,jsonb,text,text,text)';
  v_oid regprocedure := pg_catalog.to_regprocedure(v_signature);
  v_definition text;
  v_old_expected_anchor constant text := E'  where qr_order.table_id = v_table.id\n    and qr_order.id = any(v_expected_ids);\n\n  if v_expected_row_count <> v_expected_count then';
  v_new_expected_anchor constant text := E'  where qr_order.table_id = v_table.id\n    and qr_order.id = any(v_expected_ids);\n\n  if public.current_app_role() = ''manager''\n     and exists (\n       select 1\n       from public.qr_orders as manager_qr_order\n       join public.orders as paid_order\n         on paid_order.id = manager_qr_order.finalized_order_id\n       where manager_qr_order.table_id = v_table.id\n         and manager_qr_order.id = any(v_expected_ids)\n         and paid_order.sales_excluded is true\n     ) then\n    raise exception using\n      errcode = ''55000'',\n      message = ''QR table orders changed after checkout was opened; reload before payment'';\n  end if;\n\n  if v_expected_row_count <> v_expected_count then';
  v_old_anchor constant text :=
    '    v_existing_paid_id := v_existing_paid_ids[1];';
  v_new_anchor constant text := E'    v_existing_paid_id := v_existing_paid_ids[1];\n\n    if public.current_app_role() = ''manager'' then\n      perform paid_order.id\n      from public.orders as paid_order\n      where paid_order.id = v_existing_paid_id\n        and paid_order.sales_excluded is false\n      for share;\n\n      if not found then\n        raise exception using\n          errcode = ''42501'',\n          message = ''manager cannot access a sales-excluded paid order'';\n      end if;\n    end if;';
  v_count integer;
begin
  if v_oid is null then
    raise exception 'manager migration: required function is missing: %', v_signature;
  end if;

  v_definition := pg_catalog.pg_get_functiondef(v_oid);
  v_count := (
    pg_catalog.length(v_definition)
    - pg_catalog.length(pg_catalog.replace(v_definition, v_old_expected_anchor, ''))
  ) / pg_catalog.length(v_old_expected_anchor);
  if v_count <> 1 then
    raise exception
      'manager migration: expected one QR checkout expected-set anchor, found %',
      v_count;
  end if;

  v_count := (
    pg_catalog.length(v_definition)
    - pg_catalog.length(pg_catalog.replace(v_definition, v_old_anchor, ''))
  ) / pg_catalog.length(v_old_anchor);
  if v_count <> 1 then
    raise exception
      'manager migration: expected one QR checkout retry anchor, found %',
      v_count;
  end if;

  v_definition := pg_catalog.replace(
    v_definition,
    v_old_expected_anchor,
    v_new_expected_anchor
  );
  v_definition := pg_catalog.replace(v_definition, v_old_anchor, v_new_anchor);
  execute v_definition;

  v_definition := pg_catalog.pg_get_functiondef(
    pg_catalog.to_regprocedure(v_signature)
  );
  if pg_catalog.strpos(v_definition, v_new_expected_anchor) = 0
     or pg_catalog.strpos(v_definition, v_new_anchor) = 0 then
    raise exception 'manager migration: QR checkout target guard verification failed';
  end if;
end;
$manager_qr_checkout_target_gate$;

-- Paid QR totals are available in the ordinary inbox, but a manager must not
-- use the SECURITY DEFINER helper to recover a sales-excluded paid order.
do $manager_paid_totals_gate$
declare
  v_signature constant text := 'private.app_get_qr_paid_totals_impl(uuid[])';
  v_oid regprocedure := pg_catalog.to_regprocedure(v_signature);
  v_definition text;
  v_old_gate constant text := 'array[''staff'', ''admin'']::text[]';
  v_new_gate constant text := 'array[''staff'', ''manager'', ''admin'']::text[]';
  v_old_join constant text := E'  join public.orders as paid_order\n    on paid_order.id = qr_order.finalized_order_id;';
  v_new_join constant text := E'  join public.orders as paid_order\n    on paid_order.id = qr_order.finalized_order_id\n   and (\n     public.current_app_role() is distinct from ''manager''\n     or paid_order.sales_excluded is false\n   );';
  v_count integer;
begin
  if v_oid is null then
    raise exception 'manager migration: required function is missing: %', v_signature;
  end if;
  v_definition := pg_catalog.pg_get_functiondef(v_oid);

  v_count := (
    pg_catalog.length(v_definition)
    - pg_catalog.length(pg_catalog.replace(v_definition, v_old_gate, ''))
  ) / pg_catalog.length(v_old_gate);
  if v_count <> 1 then
    raise exception
      'manager migration: expected one paid-total role gate, found %', v_count;
  end if;

  v_count := (
    pg_catalog.length(v_definition)
    - pg_catalog.length(pg_catalog.replace(v_definition, v_old_join, ''))
  ) / pg_catalog.length(v_old_join);
  if v_count <> 1 then
    raise exception
      'manager migration: expected one paid-order join, found %', v_count;
  end if;

  v_definition := pg_catalog.replace(v_definition, v_old_gate, v_new_gate);
  v_definition := pg_catalog.replace(v_definition, v_old_join, v_new_join);
  execute v_definition;

  v_definition := pg_catalog.pg_get_functiondef(
    pg_catalog.to_regprocedure(v_signature)
  );
  if pg_catalog.strpos(v_definition, v_new_gate) = 0
     or pg_catalog.strpos(v_definition, v_new_join) = 0
     or pg_catalog.strpos(v_definition, v_old_join) > 0 then
    raise exception 'manager migration: paid-total guard verification failed';
  end if;
end;
$manager_paid_totals_gate$;

-- The paid-order delete helper is SECURITY DEFINER because it must atomically
-- detach QR source rows. Recheck the target under the definer boundary before
-- allowing a manager to delete it.
create or replace function private.app_delete_order_impl(p_order_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text := public.current_app_role();
  v_order_id uuid;
  v_sales_excluded boolean;
  v_deleted_id uuid;
  v_voided_at timestamp with time zone := now();
begin
  if (select auth.uid()) is null
     or v_role is null
     or v_role not in ('manager', 'admin') then
    raise exception using
      errcode = '42501',
      message = 'manager or admin role required';
  end if;
  if p_order_id is null then
    raise exception using errcode = '22023', message = 'order id is required';
  end if;

  select paid_order.id, paid_order.sales_excluded
  into v_order_id, v_sales_excluded
  from public.orders as paid_order
  where paid_order.id = p_order_id
  for update;

  if not found then
    return false;
  end if;

  if v_role = 'manager' and v_sales_excluded is true then
    raise exception using
      errcode = '42501',
      message = 'manager cannot access a sales-excluded order';
  end if;

  if exists (
    select 1
    from public.resv_groups as reservation
    where reservation.confirmed_order_id = v_order_id
  ) then
    raise exception using
      errcode = '23503',
      message = 'unconfirm the reservation before deleting its order';
  end if;

  perform qr_order.id
  from public.qr_orders as qr_order
  where qr_order.finalized_order_id = v_order_id
  order by qr_order.id
  for update;

  perform pg_catalog.set_config('app.rpc_write', 'on', true);

  update public.qr_orders as qr_order
  set status = 'cancelled',
      cancelled_at = v_voided_at,
      voided_order_id = v_order_id,
      voided_at = v_voided_at,
      finalized_order_id = null,
      finalized_at = null,
      updated_at = v_voided_at
  where qr_order.finalized_order_id = v_order_id;

  delete from public.orders as paid_order
  where paid_order.id = v_order_id
  returning paid_order.id into v_deleted_id;

  perform pg_catalog.set_config('app.rpc_write', 'off', true);
  return v_deleted_id is not null;
end;
$$;

-- The ordinary reservation page calls this lookup to hide excluded rows. A
-- manager's RLS already omits those reservations, so return no identifiers and
-- prevent guessed UUIDs from becoming an exclusion oracle.
create or replace function private.app_get_reservation_sales_excluded_ids_impl(
  p_order_ids uuid[]
)
returns table (order_id uuid)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_role text := public.current_app_role();
  v_requested_count integer := coalesce(pg_catalog.cardinality(p_order_ids), 0);
begin
  if (select auth.uid()) is null
     or v_role is null
     or v_role not in ('staff', 'manager', 'admin') then
    raise exception using
      errcode = '42501',
      message = 'staff, manager, or admin role required';
  end if;

  if p_order_ids is null then
    raise exception using
      errcode = '22023',
      message = 'reservation order ids are required';
  end if;

  if v_requested_count > 500 then
    raise exception using
      errcode = '22023',
      message = 'at most 500 reservation order ids may be checked at once';
  end if;

  if v_requested_count = 0 or v_role = 'manager' then
    return;
  end if;

  return query
  select distinct requested.order_id
  from pg_catalog.unnest(p_order_ids) as requested(order_id)
  join public.resv_groups as reservation
    on reservation.confirmed_order_id = requested.order_id
  join public.orders as app_order
    on app_order.id = requested.order_id
  where requested.order_id is not null
    and app_order.sales_excluded is true
  order by requested.order_id;
end;
$$;

-- Final migration-time assertions: fail the transaction if a privileged gate
-- was accidentally widened or a manager policy was not created.
do $manager_authorization_assertions$
declare
  v_definition text;
  v_expected_policies constant text[] := array[
    'menu_items_manager_read',
    'orders_manager_read',
    'orders_manager_insert',
    'orders_manager_update',
    'orders_manager_delete',
    'order_items_manager_read',
    'order_items_manager_insert',
    'order_items_manager_update',
    'order_items_manager_delete',
    'order_custom_items_manager_read',
    'order_custom_items_manager_insert',
    'order_custom_items_manager_update',
    'order_custom_items_manager_delete',
    'resv_groups_manager_read',
    'resv_groups_manager_insert',
    'resv_groups_manager_update',
    'resv_groups_manager_delete',
    'qr_tables_manager_read',
    'qr_orders_manager_read',
    'qr_order_items_manager_read',
    'notices_manager_insert',
    'notices_manager_update',
    'notices_manager_delete',
    'restaurant_expenses_manager_update',
    'restaurant_expenses_manager_delete',
    'qr_menu_images_manager_select',
    'qr_menu_images_manager_insert',
    'qr_menu_images_manager_update',
    'qr_menu_images_manager_delete'
  ];
  v_policy text;
begin
  v_definition := pg_catalog.pg_get_functiondef(
    'public.current_app_role()'::regprocedure
  );
  if pg_catalog.strpos(v_definition, '''manager''') = 0 then
    raise exception 'manager migration: current_app_role does not recognize manager';
  end if;

  v_definition := pg_catalog.pg_get_functiondef(
    'public.app_set_sales_excluded(uuid,boolean)'::regprocedure
  );
  if pg_catalog.strpos(v_definition, '''manager''') > 0
     or pg_catalog.strpos(
       pg_catalog.lower(v_definition),
       'public.current_app_role() is distinct from ''admin'''
     ) = 0 then
    raise exception 'manager migration: sales exclusion is not exact-admin';
  end if;

  v_definition := pg_catalog.pg_get_functiondef(
    'private.guard_orders_admin_fields()'::regprocedure
  );
  if pg_catalog.strpos(v_definition, '''manager''') > 0
     or pg_catalog.strpos(
       pg_catalog.lower(v_definition),
       'public.current_app_role() is distinct from ''admin'''
     ) = 0 then
    raise exception 'manager migration: sales-exclusion trigger is not exact-admin';
  end if;

  v_definition := pg_catalog.pg_get_functiondef(
    'private.app_delete_order_impl(uuid)'::regprocedure
  );
  if pg_catalog.strpos(v_definition, 'v_sales_excluded') = 0
     or pg_catalog.strpos(v_definition, 'v_role = ''manager''') = 0 then
    raise exception 'manager migration: paid-order delete target guard is missing';
  end if;

  v_definition := pg_catalog.pg_get_functiondef(
    'private.app_get_reservation_sales_excluded_ids_impl(uuid[])'::regprocedure
  );
  if pg_catalog.strpos(v_definition, 'v_role = ''manager''') = 0 then
    raise exception 'manager migration: reservation exclusion oracle guard is missing';
  end if;

  v_definition := pg_catalog.pg_get_functiondef(
    'private.app_finalize_qr_table_orders_checked_impl(uuid,jsonb,text,text,text)'::regprocedure
  );
  if pg_catalog.strpos(
       v_definition,
       'manager cannot access a sales-excluded paid order'
     ) = 0 then
    raise exception 'manager migration: QR checkout target guard is missing';
  end if;

  foreach v_policy in array array[
    'private.app_update_qr_order_impl(uuid,timestamp with time zone,text,jsonb)',
    'private.app_update_qr_order_status_impl(uuid,text)'
  ]
  loop
    v_definition := pg_catalog.pg_get_functiondef(v_policy::regprocedure);
    if pg_catalog.strpos(v_definition, 'v_role = ''manager''') = 0
       or pg_catalog.strpos(v_definition, 'paid_order.sales_excluded is false') = 0
       or pg_catalog.strpos(v_definition, 'for share') = 0
       or pg_catalog.strpos(v_definition, 'v_order.voided_order_id is not null') = 0 then
      raise exception 'manager migration: QR order target guard is missing in %', v_policy;
    end if;
  end loop;

  select pg_catalog.pg_get_expr(policy_row.polqual, policy_row.polrelid)
  into v_definition
  from pg_catalog.pg_policy as policy_row
  where policy_row.polrelid = 'public.qr_orders'::regclass
    and policy_row.polname = 'qr_orders_manager_read';
  if v_definition is null
     or pg_catalog.strpos(
       pg_catalog.lower(v_definition),
       'voided_order_id is null'
     ) = 0 then
    raise exception 'manager migration: voided QR tombstones are manager-visible';
  end if;

  foreach v_policy in array v_expected_policies
  loop
    if not exists (
      select 1
      from pg_catalog.pg_policy as policy_row
      where policy_row.polname = v_policy
    ) then
      raise exception 'manager migration: required policy is missing: %', v_policy;
    end if;
  end loop;
end;
$manager_authorization_assertions$;

