-- Add separately managed hotel QR locations and make newly issued QR tokens
-- recoverable by an administrator on another browser.
--
-- Existing restaurant QR rows, token hashes, printed URLs, orders, and order
-- items are intentionally not rewritten. An existing raw token is copied into
-- Vault only after an administrator explicitly submits it and its SHA-256 hash
-- matches the already stored hash.

set lock_timeout = '5s';

alter table public.qr_tables
  add column if not exists qr_kind text not null default 'restaurant';

alter table public.qr_tables
  add constraint qr_tables_qr_kind_check
  check (qr_kind in ('restaurant', 'hotel')) not valid;

alter table public.qr_tables
  validate constraint qr_tables_qr_kind_check;

comment on column public.qr_tables.qr_kind is
  'QR management group. Existing rows remain restaurant; hotel rows are shown in a separate administrator section.';

create table private.qr_token_vault_refs (
  table_id uuid primary key
    references private.qr_table_tokens (table_id) on delete cascade,
  vault_secret_id uuid not null unique,
  source text not null,
  stored_by uuid not null,
  stored_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint qr_token_vault_refs_source_check
    check (source in ('created', 'rotated', 'registered'))
);

alter table private.qr_token_vault_refs enable row level security;

revoke all on table private.qr_token_vault_refs
  from public, anon, authenticated, service_role;

comment on table private.qr_token_vault_refs is
  'Private references to Supabase Vault secrets for managed restaurant and hotel QR tokens. Raw tokens are never stored in public tables.';

create function private.delete_qr_token_vault_secret()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from vault.secrets
  where id = old.vault_secret_id;
  return old;
end;
$$;

revoke all on function private.delete_qr_token_vault_secret()
  from public, anon, authenticated, service_role;

create trigger trg_delete_qr_token_vault_secret
after delete on private.qr_token_vault_refs
for each row execute function private.delete_qr_token_vault_secret();

create function private.store_qr_token_in_vault(
  p_table_id uuid,
  p_table_token text,
  p_source text,
  p_stored_by uuid
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_secret_id uuid;
  v_secret_name text := 'dgv_qr_' || p_table_id::text;
  v_decrypted_token text;
begin
  if p_table_id is null
     or p_table_token is null
     or p_table_token !~ '^[0-9a-f]{64}$'
     or p_source not in ('created', 'rotated', 'registered')
     or p_stored_by is null then
    raise exception using errcode = '22023', message = 'invalid managed QR token input';
  end if;

  select r.vault_secret_id
  into v_secret_id
  from private.qr_token_vault_refs as r
  where r.table_id = p_table_id
  for update;

  if v_secret_id is not null
     and exists (
       select 1
       from vault.decrypted_secrets as s
       where s.id = v_secret_id
     ) then
    perform vault.update_secret(
      secret_id => v_secret_id,
      new_secret => p_table_token,
      new_name => v_secret_name,
      new_description => 'HANA managed QR token'
    );
  else
    select s.id
    into v_secret_id
    from vault.decrypted_secrets as s
    where s.name = v_secret_name;

    if v_secret_id is null then
      select vault.create_secret(
        new_secret => p_table_token,
        new_name => v_secret_name,
        new_description => 'HANA managed QR token'
      )
      into v_secret_id;
    else
      perform vault.update_secret(
        secret_id => v_secret_id,
        new_secret => p_table_token,
        new_name => v_secret_name,
        new_description => 'HANA managed QR token'
      );
    end if;
  end if;

  insert into private.qr_token_vault_refs as refs (
    table_id,
    vault_secret_id,
    source,
    stored_by,
    stored_at,
    updated_at
  )
  values (
    p_table_id,
    v_secret_id,
    p_source,
    p_stored_by,
    now(),
    now()
  )
  on conflict (table_id) do update
  set vault_secret_id = excluded.vault_secret_id,
      source = excluded.source,
      stored_by = excluded.stored_by,
      updated_at = excluded.updated_at;

  select s.decrypted_secret
  into v_decrypted_token
  from vault.decrypted_secrets as s
  where s.id = v_secret_id;

  if v_decrypted_token is null
     or v_decrypted_token <> p_table_token
     or private.qr_sha256(v_decrypted_token) <> private.qr_sha256(p_table_token) then
    raise exception using errcode = '22000', message = 'managed QR token Vault verification failed';
  end if;

  return v_secret_id;
end;
$$;

revoke all on function private.store_qr_token_in_vault(uuid, text, text, uuid)
  from public, anon, authenticated, service_role;

-- Preserve the existing public RPC signature and response contract. Only QR
-- codes created after this migration gain a Vault copy automatically.
create or replace function private.app_create_qr_table_impl(p_label text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_table public.qr_tables%rowtype;
  v_token text;
  v_user_id uuid := (select auth.uid());
begin
  if v_user_id is null
     or not public.has_app_role(array['admin']::text[]) then
    raise exception using errcode = '42501', message = 'admin role required';
  end if;

  v_token := pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '')
    || pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '');

  insert into public.qr_tables (label, qr_kind)
  values (private.validate_qr_table_label(p_label), 'restaurant')
  returning * into v_table;

  insert into private.qr_table_tokens (table_id, token_hash)
  values (v_table.id, private.qr_sha256(v_token));

  perform private.store_qr_token_in_vault(
    v_table.id,
    v_token,
    'created',
    v_user_id
  );

  return pg_catalog.jsonb_build_object(
    'table_id', v_table.id,
    'label', v_table.label,
    'is_active', v_table.is_active,
    'table_token', v_token
  );
end;
$$;

create function private.app_create_hotel_qr_impl(p_label text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_table public.qr_tables%rowtype;
  v_token text;
  v_user_id uuid := (select auth.uid());
begin
  if v_user_id is null
     or not public.has_app_role(array['admin']::text[]) then
    raise exception using errcode = '42501', message = 'admin role required';
  end if;

  v_token := pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '')
    || pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '');

  insert into public.qr_tables (label, qr_kind)
  values (private.validate_qr_table_label(p_label), 'hotel')
  returning * into v_table;

  insert into private.qr_table_tokens (table_id, token_hash)
  values (v_table.id, private.qr_sha256(v_token));

  perform private.store_qr_token_in_vault(
    v_table.id,
    v_token,
    'created',
    v_user_id
  );

  return pg_catalog.jsonb_build_object(
    'table_id', v_table.id,
    'label', v_table.label,
    'is_active', v_table.is_active,
    'table_token', v_token
  );
end;
$$;

create function public.app_create_hotel_qr(p_label text)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.app_create_hotel_qr_impl(p_label)
$$;

-- A rotation remains an explicit destructive action. Existing hashes are not
-- changed by this migration; this replacement runs only when an administrator
-- later presses the existing QR replacement button.
create or replace function private.app_rotate_qr_table_token_impl(p_table_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_table public.qr_tables%rowtype;
  v_token text;
  v_user_id uuid := (select auth.uid());
begin
  if v_user_id is null
     or not public.has_app_role(array['admin']::text[]) then
    raise exception using errcode = '42501', message = 'admin role required';
  end if;

  select * into v_table
  from public.qr_tables
  where id = p_table_id
    and archived_at is null
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'QR table not found or archived';
  end if;

  perform 1
  from private.qr_table_tokens
  where table_id = v_table.id
  for update;

  v_token := pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '')
    || pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '');

  insert into private.qr_table_tokens (table_id, token_hash, rotated_at)
  values (v_table.id, private.qr_sha256(v_token), now())
  on conflict (table_id) do update
  set token_hash = excluded.token_hash,
      rotated_at = excluded.rotated_at;

  perform private.store_qr_token_in_vault(
    v_table.id,
    v_token,
    'rotated',
    v_user_id
  );

  return pg_catalog.jsonb_build_object(
    'table_id', v_table.id,
    'label', v_table.label,
    'is_active', v_table.is_active,
    'table_token', v_token
  );
end;
$$;

create function private.app_get_qr_table_token_impl(p_table_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_label text;
  v_kind text;
  v_token_hash text;
  v_secret_id uuid;
  v_token text;
begin
  if (select auth.uid()) is null
     or not public.has_app_role(array['admin']::text[]) then
    raise exception using errcode = '42501', message = 'admin role required';
  end if;
  if p_table_id is null then
    raise exception using errcode = '22023', message = 'table id is required';
  end if;

  select q.label, q.qr_kind, t.token_hash, r.vault_secret_id
  into v_label, v_kind, v_token_hash, v_secret_id
  from public.qr_tables as q
  join private.qr_table_tokens as t on t.table_id = q.id
  join private.qr_token_vault_refs as r on r.table_id = q.id
  where q.id = p_table_id
    and q.archived_at is null;

  if not found then
    raise exception using errcode = 'P0002', message = 'managed QR token not found';
  end if;

  select s.decrypted_secret
  into v_token
  from vault.decrypted_secrets as s
  where s.id = v_secret_id;

  if v_token is null
     or v_token !~ '^[0-9a-f]{64}$'
     or private.qr_sha256(v_token) <> v_token_hash then
    raise exception using errcode = '22000', message = 'managed QR token integrity check failed';
  end if;

  return pg_catalog.jsonb_build_object(
    'table_id', p_table_id,
    'label', v_label,
    'qr_kind', v_kind,
    'table_token', v_token
  );
end;
$$;

create function public.app_get_qr_table_token(p_table_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select private.app_get_qr_table_token_impl(p_table_id)
$$;

create function private.app_register_existing_qr_token_impl(
  p_table_id uuid,
  p_table_token text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token_hash text;
  v_user_id uuid := (select auth.uid());
begin
  if v_user_id is null
     or not public.has_app_role(array['admin']::text[]) then
    raise exception using errcode = '42501', message = 'admin role required';
  end if;
  if p_table_id is null
     or p_table_token is null
     or p_table_token !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'invalid QR token registration input';
  end if;

  select t.token_hash
  into v_token_hash
  from public.qr_tables as q
  join private.qr_table_tokens as t on t.table_id = q.id
  where q.id = p_table_id
    and q.archived_at is null
  for update of q, t;

  if not found then
    raise exception using errcode = 'P0002', message = 'QR table not found or archived';
  end if;

  if private.qr_sha256(p_table_token) <> v_token_hash then
    raise exception using errcode = '22023', message = 'QR token does not match the current table token';
  end if;

  perform private.store_qr_token_in_vault(
    p_table_id,
    p_table_token,
    'registered',
    v_user_id
  );

  return true;
end;
$$;

create function public.app_register_existing_qr_token(
  p_table_id uuid,
  p_table_token text
)
returns boolean
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.app_register_existing_qr_token_impl(p_table_id, p_table_token)
$$;

revoke execute on function private.app_create_hotel_qr_impl(text)
  from public, anon, authenticated, service_role;
revoke execute on function public.app_create_hotel_qr(text)
  from public, anon, authenticated, service_role;
revoke execute on function private.app_get_qr_table_token_impl(uuid)
  from public, anon, authenticated, service_role;
revoke execute on function public.app_get_qr_table_token(uuid)
  from public, anon, authenticated, service_role;
revoke execute on function private.app_register_existing_qr_token_impl(uuid, text)
  from public, anon, authenticated, service_role;
revoke execute on function public.app_register_existing_qr_token(uuid, text)
  from public, anon, authenticated, service_role;
revoke execute on function private.app_create_qr_table_impl(text)
  from public, anon, authenticated, service_role;
revoke execute on function private.app_rotate_qr_table_token_impl(uuid)
  from public, anon, authenticated, service_role;

grant execute on function private.app_create_hotel_qr_impl(text)
  to authenticated;
grant execute on function public.app_create_hotel_qr(text)
  to authenticated;
grant execute on function private.app_get_qr_table_token_impl(uuid)
  to authenticated;
grant execute on function public.app_get_qr_table_token(uuid)
  to authenticated;
grant execute on function private.app_register_existing_qr_token_impl(uuid, text)
  to authenticated;
grant execute on function public.app_register_existing_qr_token(uuid, text)
  to authenticated;
grant execute on function private.app_create_qr_table_impl(text)
  to authenticated;
grant execute on function private.app_rotate_qr_table_token_impl(uuid)
  to authenticated;

comment on function public.app_create_hotel_qr(text) is
  'Admin-only hotel QR creation. The returned token hash drives guest ordering while the raw token is encrypted in Vault for cross-browser reprinting.';
comment on function public.app_get_qr_table_token(uuid) is
  'Admin-only managed QR token retrieval. The decrypted Vault value must match the current private token hash.';
comment on function public.app_register_existing_qr_token(uuid, text) is
  'Admin-only opt-in registration of an existing browser-cached QR token. Never rotates or rewrites the current token hash.';
