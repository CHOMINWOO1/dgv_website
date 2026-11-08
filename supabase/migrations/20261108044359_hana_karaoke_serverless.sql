-- CLI-generated migration version aligned to the hosted migration history.
-- Additive karaoke objects only.
-- No Supabase anonymous sign-in, business-table grants, or business RLS changes.
-- Clients use hana-karaoke; none of these objects are directly client-readable.

create table public.hana_karaoke_settings (
  singleton boolean primary key default true check (singleton),
  require_staff_to_create boolean not null default false
);
insert into public.hana_karaoke_settings (singleton) values (true);

create table public.hana_karaoke_rooms (
  room text primary key check (room ~ '^[1-9][0-9]{5}$'),
  create_request_id uuid not null unique,
  creation_ip_hash text not null check (creation_ip_hash ~ '^[a-f0-9]{64}$'),
  host_token_hash text not null check (host_token_hash ~ '^[a-f0-9]{64}$'),
  join_token_hash text not null check (join_token_hash ~ '^[a-f0-9]{64}$'),
  topic text not null unique check (topic ~ '^hana-karaoke:[a-f0-9]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null default (clock_timestamp() + interval '24 hours'),
  closed boolean not null default false,
  queue jsonb not null default '[]'::jsonb
    check (jsonb_typeof(queue) = 'array' and jsonb_array_length(queue) <= 50),
  current_item jsonb,
  playing boolean not null default false,
  revision bigint not null default 1 check (revision > 0),
  request_log jsonb not null default '[]'::jsonb
    check (jsonb_typeof(request_log) = 'array' and jsonb_array_length(request_log) <= 50),
  mutation_window_at timestamptz not null default clock_timestamp(),
  mutation_count integer not null default 0 check (mutation_count >= 0),
  read_window_at timestamptz not null default clock_timestamp(),
  read_count integer not null default 0 check (read_count >= 0),
  check (host_token_hash <> join_token_hash),
  check (current_item is null or jsonb_typeof(current_item) = 'object'),
  check (not playing or current_item is not null),
  check (expires_at > created_at)
);

create index hana_karaoke_rooms_created_idx on public.hana_karaoke_rooms (created_at);
create index hana_karaoke_rooms_ip_created_idx on public.hana_karaoke_rooms (creation_ip_hash, created_at);
create index hana_karaoke_rooms_active_idx on public.hana_karaoke_rooms (expires_at) where not closed;

alter table public.hana_karaoke_settings enable row level security;
alter table public.hana_karaoke_rooms enable row level security;
revoke all on table public.hana_karaoke_settings, public.hana_karaoke_rooms from public, anon, authenticated;
grant select, update on public.hana_karaoke_settings to service_role;
grant select, insert, update, delete on public.hana_karaoke_rooms to service_role;
create policy hana_karaoke_settings_service_only on public.hana_karaoke_settings
  for all to service_role using (true) with check (true);
create policy hana_karaoke_rooms_service_only on public.hana_karaoke_rooms
  for all to service_role using (true) with check (true);

-- Keep serialization separate and explicitly enumerate fields: capability hashes,
-- creation request IDs, IP hashes, and the request log must never leave the DB.
create function public.hana_karaoke_public_state(p_row public.hana_karaoke_rooms)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'room', p_row.room,
    'queue', p_row.queue,
    'current', p_row.current_item,
    'playing', p_row.playing,
    'revision', p_row.revision,
    'topic', p_row.topic,
    'expiresAt', p_row.expires_at,
    'closed', p_row.closed
  );
$$;
revoke all on function public.hana_karaoke_public_state(public.hana_karaoke_rooms) from public, anon, authenticated;
grant execute on function public.hana_karaoke_public_state(public.hana_karaoke_rooms) to service_role;

-- p_is_staff is supplied only by the Edge service after GET /auth/v1/user verifies
-- an existing user and its app_metadata.role. It is not a client-supplied claim.
create function public.hana_karaoke_command(
  p_action text,
  p_room text default null,
  p_token_hash text default null,
  p_request_id uuid default null,
  p_data jsonb default '{}'::jsonb,
  p_ip_hash text default null,
  p_is_staff boolean default false
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
set statement_timeout = '5s'
as $$
declare
  v_room public.hana_karaoke_rooms%rowtype;
  v_requires_staff boolean;
  v_now timestamptz := clock_timestamp();
  v_host boolean;
  v_old_queue jsonb;
  v_old_current jsonb;
  v_old_playing boolean;
  v_old_closed boolean;
  v_log jsonb;
  v_result jsonb;
  v_fingerprint text;
  v_item jsonb;
  v_index integer;
  v_other integer;
  v_size integer;
  v_changed boolean;
begin
  if p_action is null or p_action not in ('create', 'state', 'add', 'remove', 'up', 'down', 'next', 'play', 'pause', 'ended', 'close')
    or p_request_id is null or p_data is null or jsonb_typeof(p_data) <> 'object'
    or octet_length(p_data::text) > 16384 then
    raise exception using errcode = 'P0001', message = 'KARAOKE_INVALID_REQUEST';
  end if;

  if p_action = 'create' then
    -- This single row is the creation mutex: quota counts and inserts are atomic.
    select require_staff_to_create into strict v_requires_staff
      from public.hana_karaoke_settings where singleton for update;
    if v_requires_staff and not coalesce(p_is_staff, false) then
      raise exception using errcode = 'P0001', message = 'KARAOKE_STAFF_REQUIRED';
    end if;
    if p_room is null or p_room !~ '^[1-9][0-9]{5}$'
      or p_ip_hash is null or p_ip_hash !~ '^[a-f0-9]{64}$'
      or coalesce(p_data->>'hostHash', '') !~ '^[a-f0-9]{64}$'
      or coalesce(p_data->>'joinHash', '') !~ '^[a-f0-9]{64}$'
      or coalesce(p_data->>'topic', '') !~ '^hana-karaoke:[a-f0-9]{64}$'
      or p_data->>'hostHash' = p_data->>'joinHash' then
      raise exception using errcode = 'P0001', message = 'KARAOKE_INVALID_REQUEST';
    end if;

    select * into v_room from public.hana_karaoke_rooms
      where create_request_id = p_request_id for update;
    if found then
      if v_room.creation_ip_hash <> p_ip_hash
        or v_room.host_token_hash <> p_data->>'hostHash'
        or v_room.join_token_hash <> p_data->>'joinHash' then
        raise exception using errcode = 'P0001', message = 'KARAOKE_IDEMPOTENCY_CONFLICT';
      end if;
      if v_room.expires_at <= v_now then
        raise exception using errcode = 'P0001', message = 'KARAOKE_ROOM_EXPIRED';
      end if;
      if v_room.read_window_at <= v_now - interval '1 minute' then
        v_room.read_window_at := v_now;
        v_room.read_count := 0;
      end if;
      if v_room.read_count >= 600 then
        raise exception using errcode = 'P0001', message = 'KARAOKE_RATE_LIMITED';
      end if;
      update public.hana_karaoke_rooms set read_window_at = v_room.read_window_at,
        read_count = v_room.read_count + 1 where room = v_room.room;
      return jsonb_build_object('state', public.hana_karaoke_public_state(v_room), 'changed', false);
    end if;

    -- Seven-day retention only for this feature; expired rows are never usable.
    delete from public.hana_karaoke_rooms where expires_at < v_now - interval '7 days';
    if (select count(*) from public.hana_karaoke_rooms where not closed and expires_at > v_now) >= 50 then
      raise exception using errcode = 'P0001', message = 'KARAOKE_ROOM_LIMIT';
    end if;
    if (select count(*) from public.hana_karaoke_rooms where created_at > v_now - interval '1 hour') >= 30
      or (select count(*) from public.hana_karaoke_rooms where creation_ip_hash = p_ip_hash and created_at > v_now - interval '1 hour') >= 10 then
      raise exception using errcode = 'P0001', message = 'KARAOKE_RATE_LIMITED';
    end if;
    if exists (select 1 from public.hana_karaoke_rooms where room = p_room) then
      raise exception using errcode = 'P0001', message = 'KARAOKE_ROOM_COLLISION';
    end if;
    insert into public.hana_karaoke_rooms (
      room, create_request_id, creation_ip_hash, host_token_hash, join_token_hash, topic, created_at, expires_at
    ) values (
      p_room, p_request_id, p_ip_hash, p_data->>'hostHash', p_data->>'joinHash', p_data->>'topic', v_now, v_now + interval '24 hours'
    ) returning * into v_room;
    return jsonb_build_object('state', public.hana_karaoke_public_state(v_room), 'changed', true);
  end if;

  if p_room is null or p_room !~ '^[1-9][0-9]{5}$'
    or p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = 'P0001', message = 'KARAOKE_ROOM_NOT_FOUND';
  end if;
  -- All room operations serialize through the same lock. No network I/O in SQL.
  select * into v_room from public.hana_karaoke_rooms where room = p_room for update;
  if not found or (p_token_hash <> v_room.host_token_hash and p_token_hash <> v_room.join_token_hash) then
    raise exception using errcode = 'P0001', message = 'KARAOKE_ROOM_NOT_FOUND';
  end if;
  if v_room.expires_at <= v_now then
    raise exception using errcode = 'P0001', message = 'KARAOKE_ROOM_EXPIRED';
  end if;
  v_host := p_token_hash = v_room.host_token_hash;
  if p_action in ('ended', 'close') and not v_host then
    raise exception using errcode = 'P0001', message = 'KARAOKE_HOST_REQUIRED';
  end if;

  -- Durable read/total-request budget, including retries and no-op actions.
  -- The invite capability is shared by guests, so this is a room-wide budget.
  if v_room.read_window_at <= v_now - interval '1 minute' then
    v_room.read_window_at := v_now;
    v_room.read_count := 0;
  end if;
  if v_room.read_count >= 600 then
    raise exception using errcode = 'P0001', message = 'KARAOKE_RATE_LIMITED';
  end if;
  v_room.read_count := v_room.read_count + 1;

  if p_action = 'state' then
    update public.hana_karaoke_rooms set read_window_at = v_room.read_window_at, read_count = v_room.read_count where room = p_room;
    return jsonb_build_object('state', public.hana_karaoke_public_state(v_room), 'changed', false);
  end if;

  -- Fingerprint binds a request UUID to its action, arguments, and capability.
  -- md5 is only an equality checksum here, never a capability/token hash.
  v_fingerprint := md5(jsonb_build_object('action', p_action, 'data', p_data, 'tokenHash', p_token_hash)::text);
  select entry into v_log from jsonb_array_elements(v_room.request_log) entry
    where entry->>'id' = p_request_id::text limit 1;
  if found then
    if v_log->>'fingerprint' <> v_fingerprint then
      raise exception using errcode = 'P0001', message = 'KARAOKE_IDEMPOTENCY_CONFLICT';
    end if;
    update public.hana_karaoke_rooms set read_window_at = v_room.read_window_at, read_count = v_room.read_count where room = p_room;
    -- Return the latest state without replaying the mutation. Keeping only the
    -- request ID/fingerprint avoids storing 50 copies of a full song queue.
    return jsonb_build_object('state', public.hana_karaoke_public_state(v_room), 'changed', false);
  end if;
  if v_room.closed then
    raise exception using errcode = 'P0001', message = 'KARAOKE_ROOM_CLOSED';
  end if;

  v_old_queue := v_room.queue;
  v_old_current := v_room.current_item;
  v_old_playing := v_room.playing;
  v_old_closed := v_room.closed;
  v_size := jsonb_array_length(v_room.queue);

  if p_action = 'add' then
    if coalesce(p_data->>'videoId', '') !~ '^[A-Za-z0-9_-]{11}$'
      or jsonb_typeof(p_data->'title') is distinct from 'string'
      or char_length(btrim(p_data->>'title')) not between 1 and 100
      or p_data->>'title' ~ '[[:cntrl:]]' then
      raise exception using errcode = 'P0001', message = 'KARAOKE_INVALID_REQUEST';
    end if;
    -- Even after the bounded result cache rolls over, the same request ID must
    -- never give two live queue/current items the same identity.
    if v_room.current_item->>'id' = p_request_id::text then
      v_item := v_room.current_item;
    else
      select item into v_item from jsonb_array_elements(v_room.queue) item
        where item->>'id' = p_request_id::text limit 1;
    end if;
    if v_item is not null then
      if v_item->>'videoId' <> p_data->>'videoId' or v_item->>'title' <> btrim(p_data->>'title') then
        raise exception using errcode = 'P0001', message = 'KARAOKE_IDEMPOTENCY_CONFLICT';
      end if;
    else
      if v_size >= 50 then
        raise exception using errcode = 'P0001', message = 'KARAOKE_QUEUE_FULL';
      end if;
      v_room.queue := v_room.queue || jsonb_build_array(jsonb_build_object('id', p_request_id::text, 'videoId', p_data->>'videoId', 'title', btrim(p_data->>'title')));
    end if;
  elsif p_action in ('remove', 'up', 'down') then
    if coalesce(p_data->>'itemId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      raise exception using errcode = 'P0001', message = 'KARAOKE_INVALID_REQUEST';
    end if;
    select (ordinality - 1)::integer into v_index
      from jsonb_array_elements(v_room.queue) with ordinality as items(item, ordinality)
      where item->>'id' = p_data->>'itemId' limit 1;
    if found then
      if p_action = 'remove' then
        v_room.queue := v_room.queue - v_index;
      else
        v_other := v_index + case when p_action = 'up' then -1 else 1 end;
        if v_other >= 0 and v_other < v_size then
          v_item := v_room.queue->v_index;
          v_room.queue := jsonb_set(v_room.queue, array[v_index::text], v_room.queue->v_other);
          v_room.queue := jsonb_set(v_room.queue, array[v_other::text], v_item);
        end if;
      end if;
    end if;
  elsif p_action in ('next', 'ended') then
    if not (p_data ? 'expectedCurrentId') or (
      p_data->'expectedCurrentId' <> 'null'::jsonb
      and coalesce(p_data->>'expectedCurrentId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    ) then
      raise exception using errcode = 'P0001', message = 'KARAOKE_INVALID_REQUEST';
    end if;
    -- A second TV's ended event for the previous item must not skip another song.
    if (v_room.current_item->>'id') is not distinct from (p_data->>'expectedCurrentId')
      and (p_action <> 'ended' or v_room.current_item is not null) then
      v_room.current_item := v_room.queue->0;
      v_room.queue := v_room.queue - 0;
      v_room.playing := v_room.current_item is not null;
    end if;
  elsif p_action = 'play' then
    if v_room.current_item is null then
      v_room.current_item := v_room.queue->0;
      v_room.queue := v_room.queue - 0;
    end if;
    v_room.playing := v_room.current_item is not null;
  elsif p_action = 'pause' then
    v_room.playing := false;
  elsif p_action = 'close' then
    v_room.closed := true;
    v_room.playing := false;
  end if;

  v_changed := v_room.queue is distinct from v_old_queue
    or v_room.current_item is distinct from v_old_current
    or v_room.playing is distinct from v_old_playing
    or v_room.closed is distinct from v_old_closed;
  if v_changed then
    if v_room.mutation_window_at <= v_now - interval '10 seconds' then
      v_room.mutation_window_at := v_now;
      v_room.mutation_count := 0;
    end if;
    if v_room.mutation_count >= 30 then
      raise exception using errcode = 'P0001', message = 'KARAOKE_RATE_LIMITED';
    end if;
    v_room.mutation_count := v_room.mutation_count + 1;
    v_room.revision := v_room.revision + 1;
  end if;
  v_result := public.hana_karaoke_public_state(v_room);
  v_room.request_log := v_room.request_log || jsonb_build_array(jsonb_build_object('id', p_request_id::text, 'fingerprint', v_fingerprint));
  if jsonb_array_length(v_room.request_log) > 50 then
    v_room.request_log := v_room.request_log - 0;
  end if;
  update public.hana_karaoke_rooms set
    queue = v_room.queue, current_item = v_room.current_item, playing = v_room.playing,
    closed = v_room.closed, revision = v_room.revision, request_log = v_room.request_log,
    mutation_window_at = v_room.mutation_window_at, mutation_count = v_room.mutation_count,
    read_window_at = v_room.read_window_at, read_count = v_room.read_count
    where room = p_room;
  return jsonb_build_object('state', v_result, 'changed', v_changed);
end;
$$;
revoke all on function public.hana_karaoke_command(text, text, text, uuid, jsonb, text, boolean) from public, anon, authenticated;
grant execute on function public.hana_karaoke_command(text, text, text, uuid, jsonb, text, boolean) to service_role;

comment on table public.hana_karaoke_settings is 'Karaoke only. Set require_staff_to_create=true later; no Auth configuration or existing RLS changes are needed.';
comment on function public.hana_karaoke_command(text, text, text, uuid, jsonb, text, boolean) is 'Service-only capability API. Call only from hana-karaoke Edge Function; no client access.';
