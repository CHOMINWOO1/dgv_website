-- Preserve menu history while allowing administrators to remove an item from
-- every active menu. Archiving never deletes the menu row, its image, or any
-- order rows that reference it.

alter table public.menu_items
  add column if not exists archived_at timestamp with time zone;

do $migration$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.menu_items'::pg_catalog.regclass
      and conname = 'menu_items_archived_state_check'
  ) then
    alter table public.menu_items
      add constraint menu_items_archived_state_check
      check (
        archived_at is null
        or (
          is_active is false
          and is_orderable is false
          and is_sold_out is true
        )
      );
  end if;
end
$migration$;

comment on column public.menu_items.archived_at is
  'Soft-delete timestamp. Archived rows, prices, images, and historical order references are retained.';

-- Keep archived rows unavailable even if an older client tries to change the
-- three visibility flags through the existing menu-update RPC.
create function private.enforce_menu_archive_state()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.archived_at is not null then
    new.is_active := false;
    new.is_orderable := false;
    new.is_sold_out := true;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_menu_items_archive_state on public.menu_items;
create trigger trg_menu_items_archive_state
before insert or update of archived_at, is_active, is_orderable, is_sold_out
on public.menu_items
for each row execute function private.enforce_menu_archive_state();

create function private.app_archive_menu_item_impl(p_item_id uuid)
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

  update public.menu_items as menu
  set
    archived_at = coalesce(menu.archived_at, now()),
    is_active = false,
    is_orderable = false,
    is_sold_out = true,
    updated_at = now()
  where menu.id = p_item_id
  returning menu.* into v_item;

  if not found then
    raise exception using errcode = 'P0002', message = 'menu item not found';
  end if;
  return pg_catalog.to_jsonb(v_item);
end;
$$;

create function public.app_archive_menu_item(p_item_id uuid)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.app_archive_menu_item_impl(p_item_id)
$$;

create function private.app_restore_menu_item_impl(p_item_id uuid)
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

  -- Restoration only returns the row to the editor. It deliberately keeps the
  -- item inactive, non-orderable, and sold out until an administrator reviews
  -- and saves its current price and availability.
  update public.menu_items as menu
  set
    archived_at = null,
    updated_at = now()
  where menu.id = p_item_id
    and menu.archived_at is not null
  returning menu.* into v_item;

  if not found then
    raise exception using errcode = 'P0002', message = 'archived menu item not found';
  end if;
  return pg_catalog.to_jsonb(v_item);
end;
$$;

create function public.app_restore_menu_item(p_item_id uuid)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.app_restore_menu_item_impl(p_item_id)
$$;

revoke execute on function private.enforce_menu_archive_state()
  from public, anon, authenticated, service_role;
revoke execute on function private.app_archive_menu_item_impl(uuid)
  from public, anon, authenticated, service_role;
revoke execute on function private.app_restore_menu_item_impl(uuid)
  from public, anon, authenticated, service_role;

grant execute on function private.app_archive_menu_item_impl(uuid)
  to authenticated;
grant execute on function private.app_restore_menu_item_impl(uuid)
  to authenticated;

revoke execute on function public.app_archive_menu_item(uuid)
  from public, anon, authenticated, service_role;
revoke execute on function public.app_restore_menu_item(uuid)
  from public, anon, authenticated, service_role;

grant execute on function public.app_archive_menu_item(uuid)
  to authenticated;
grant execute on function public.app_restore_menu_item(uuid)
  to authenticated;

comment on function public.app_archive_menu_item(uuid) is
  'Admin-only soft delete. Preserves menu metadata, image path, prices, and historical order references.';
comment on function public.app_restore_menu_item(uuid) is
  'Admin-only restore to the editor. Availability remains disabled until reviewed and saved.';
