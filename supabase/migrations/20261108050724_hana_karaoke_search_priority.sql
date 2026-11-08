-- Add official YouTube search and play-next priority, without changing existing
-- room queues/current items/revisions/capabilities or any business object.
-- Existing applied migration is intentionally left unchanged.
-- Version aligned with the hosted migration history after successful application.

alter table public.hana_karaoke_rooms
  add column search_window_at timestamptz not null default clock_timestamp(),
  add column search_count integer not null default 0 check (search_count >= 0),
  add column search_last_at timestamptz,
  add column search_last_request uuid,
  add column search_last_key text;

create table public.hana_karaoke_search_quota (
  singleton boolean primary key default true check (singleton),
  quota_day date not null default ((clock_timestamp() at time zone 'America/Los_Angeles')::date),
  calls integer not null default 0 check (calls >= 0),
  daily_limit integer not null default 80 check (daily_limit between 1 and 100),
  provider_exhausted boolean not null default false
);
insert into public.hana_karaoke_search_quota(singleton) values (true);

create table public.hana_karaoke_search_cache (
  cache_key text primary key check (cache_key ~ '^[a-f0-9]{64}$'),
  lease_id uuid not null,
  lease_quota_day date not null,
  lease_until timestamptz not null,
  expires_at timestamptz not null,
  result jsonb check (result is null or (jsonb_typeof(result) = 'object' and octet_length(result::text) <= 32768)),
  error_code text check (error_code is null or error_code in ('SEARCH_QUOTA_EXCEEDED','SEARCH_RATE_LIMITED','SEARCH_NOT_CONFIGURED','SEARCH_UNAVAILABLE')),
  check (result is null or error_code is null)
);
create index hana_karaoke_search_cache_expiry_idx on public.hana_karaoke_search_cache(expires_at);
alter table public.hana_karaoke_search_quota enable row level security;
alter table public.hana_karaoke_search_cache enable row level security;
revoke all on table public.hana_karaoke_search_quota, public.hana_karaoke_search_cache from public, anon, authenticated;
grant select, update on public.hana_karaoke_search_quota to service_role;
grant select, insert, update, delete on public.hana_karaoke_search_cache to service_role;
create policy hana_karaoke_search_quota_service_only on public.hana_karaoke_search_quota
  for all to service_role using (true) with check (true);
create policy hana_karaoke_search_cache_service_only on public.hana_karaoke_search_cache
  for all to service_role using (true) with check (true);

-- Every caller is authorized before cache access or external-call reservation.
-- Locks are always room -> quota singleton -> cache; network I/O happens in Edge.
create function public.hana_karaoke_search_acquire(
  p_room text, p_token_hash text, p_request_id uuid, p_cache_key text,
  p_enabled boolean default true
) returns jsonb
language plpgsql security invoker set search_path = '' set statement_timeout = '5s'
as $$
declare
  v_room public.hana_karaoke_rooms%rowtype;
  v_quota public.hana_karaoke_search_quota%rowtype;
  v_cache public.hana_karaoke_search_cache%rowtype;
  v_now timestamptz := clock_timestamp();
  v_day date := (clock_timestamp() at time zone 'America/Los_Angeles')::date;
  v_lease uuid;
  v_duplicate boolean;
begin
  if p_room is null or p_room !~ '^[1-9][0-9]{5}$' or p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$' then
    raise exception using errcode='P0001', message='KARAOKE_ROOM_NOT_FOUND';
  end if;
  if p_request_id is null or p_cache_key is null or p_cache_key !~ '^[a-f0-9]{64}$' then
    raise exception using errcode='P0001', message='KARAOKE_INVALID_REQUEST';
  end if;
  select * into v_room from public.hana_karaoke_rooms where room=p_room for update;
  if not found or (p_token_hash<>v_room.host_token_hash and p_token_hash<>v_room.join_token_hash) then
    raise exception using errcode='P0001', message='KARAOKE_ROOM_NOT_FOUND';
  end if;
  if v_room.expires_at<=v_now then
    raise exception using errcode='P0001', message='KARAOKE_ROOM_EXPIRED';
  end if;
  if v_room.closed then
    raise exception using errcode='P0001', message='KARAOKE_ROOM_CLOSED';
  end if;
  -- Every request, including a cached/duplicate search, shares the durable read
  -- budget. The separate search budget counts new search request IDs only.
  if v_room.read_window_at<=v_now-interval '1 minute' then
    v_room.read_window_at:=v_now; v_room.read_count:=0;
  end if;
  if v_room.read_count>=600 then
    raise exception using errcode='P0001', message='KARAOKE_SEARCH_RATE_LIMITED';
  end if;
  update public.hana_karaoke_rooms set read_window_at=v_room.read_window_at,
    read_count=v_room.read_count+1 where room=p_room;
  if not coalesce(p_enabled,false) then
    return jsonb_build_object('status','error','code','SEARCH_NOT_CONFIGURED');
  end if;
  v_duplicate := coalesce(v_room.search_last_request=p_request_id,false);
  if v_duplicate and v_room.search_last_key is distinct from p_cache_key then
    raise exception using errcode='P0001', message='KARAOKE_IDEMPOTENCY_CONFLICT';
  end if;
  if not v_duplicate then
    if v_room.search_window_at<=v_now-interval '1 minute' then
      v_room.search_window_at:=v_now; v_room.search_count:=0;
    end if;
    if v_room.search_count>=12 or v_room.search_last_at>v_now-interval '3 seconds' then
      raise exception using errcode='P0001', message='KARAOKE_SEARCH_RATE_LIMITED';
    end if;
    update public.hana_karaoke_rooms set search_window_at=v_room.search_window_at,
      search_count=v_room.search_count+1,search_last_at=v_now,
      search_last_request=p_request_id,search_last_key=p_cache_key where room=p_room;
  end if;
  select * into strict v_quota from public.hana_karaoke_search_quota where singleton for update;
  if v_quota.quota_day<>v_day then
    update public.hana_karaoke_search_quota set quota_day=v_day,calls=0,provider_exhausted=false where singleton;
    v_quota.calls:=0; v_quota.provider_exhausted:=false;
  end if;
  select * into v_cache from public.hana_karaoke_search_cache where cache_key=p_cache_key for update;
  if found and v_cache.expires_at>v_now then
    if v_cache.result is not null then
      return jsonb_build_object('status','cached','result',v_cache.result);
    elsif v_cache.error_code is not null then
      return jsonb_build_object('status','error','code',v_cache.error_code);
    elsif v_cache.lease_until>v_now then
      return jsonb_build_object('status','error','code','SEARCH_RATE_LIMITED');
    end if;
  end if;
  if v_quota.calls>=v_quota.daily_limit or v_quota.provider_exhausted then
    return jsonb_build_object('status','error','code','SEARCH_QUOTA_EXCEEDED');
  end if;
  delete from public.hana_karaoke_search_cache where expires_at<=v_now and lease_until<=v_now;
  if not exists(select 1 from public.hana_karaoke_search_cache where cache_key=p_cache_key)
    and (select count(*) from public.hana_karaoke_search_cache)>=200 then
    return jsonb_build_object('status','error','code','SEARCH_RATE_LIMITED');
  end if;
  v_lease:=gen_random_uuid();
  insert into public.hana_karaoke_search_cache(cache_key,lease_id,lease_quota_day,lease_until,expires_at)
    values(p_cache_key,v_lease,v_day,v_now+interval '20 seconds',v_now+interval '20 seconds')
    on conflict(cache_key) do update set lease_id=excluded.lease_id,lease_until=excluded.lease_until,
      lease_quota_day=excluded.lease_quota_day,expires_at=excluded.expires_at,result=null,error_code=null;
  -- Reserve before Edge fetches. Failed/aborted calls are deliberately not refunded.
  update public.hana_karaoke_search_quota set calls=calls+1 where singleton;
  return jsonb_build_object('status','fetch','leaseId',v_lease);
end;
$$;
revoke all on function public.hana_karaoke_search_acquire(text,text,uuid,text,boolean) from public,anon,authenticated;
grant execute on function public.hana_karaoke_search_acquire(text,text,uuid,text,boolean) to service_role;

-- A lease can be completed only once. An old worker cannot replace newer data.
create function public.hana_karaoke_search_finish(
  p_cache_key text, p_lease_id uuid, p_result jsonb default null, p_error text default null
) returns jsonb
language plpgsql security invoker set search_path = '' set statement_timeout = '5s'
as $$
declare
  v_cache public.hana_karaoke_search_cache%rowtype;
  v_now timestamptz:=clock_timestamp();
begin
  if p_cache_key is null or p_cache_key!~'^[a-f0-9]{64}$' or p_lease_id is null
    or (p_result is null)=(p_error is null)
    or (p_error is not null and p_error not in ('SEARCH_QUOTA_EXCEEDED','SEARCH_RATE_LIMITED','SEARCH_NOT_CONFIGURED','SEARCH_UNAVAILABLE')) then
    raise exception using errcode='P0001', message='KARAOKE_INVALID_REQUEST';
  end if;
  if p_result is not null and (
    jsonb_typeof(p_result) is distinct from 'object' or octet_length(p_result::text)>32768
    or p_result->>'source' is distinct from 'youtube'
    or jsonb_typeof(p_result->'items') is distinct from 'array'
    or jsonb_array_length(p_result->'items')>10
  ) then
    raise exception using errcode='P0001', message='KARAOKE_INVALID_REQUEST';
  end if;
  perform 1 from public.hana_karaoke_search_quota where singleton for update;
  select * into v_cache from public.hana_karaoke_search_cache where cache_key=p_cache_key for update;
  if not found or v_cache.lease_id<>p_lease_id or v_cache.lease_until<=v_now
    or v_cache.result is not null or v_cache.error_code is not null then
    return jsonb_build_object('saved',false);
  end if;
  update public.hana_karaoke_search_cache set result=p_result,error_code=p_error,
    lease_until=v_now,expires_at=v_now+case when p_error is null then interval '24 hours' else interval '1 minute' end
    where cache_key=p_cache_key;
  if p_error='SEARCH_QUOTA_EXCEEDED' then
    update public.hana_karaoke_search_quota set provider_exhausted=true
      where singleton and quota_day=v_cache.lease_quota_day
        and quota_day=(v_now at time zone 'America/Los_Angeles')::date;
  end if;
  return jsonb_build_object('saved',true);
end;
$$;
revoke all on function public.hana_karaoke_search_finish(text,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.hana_karaoke_search_finish(text,uuid,jsonb,text) to service_role;

-- Hourly retention also enforces the existing 7-days-after-expiry room policy
-- even when nobody creates another room. Active/recent rooms are untouched.
create function public.hana_karaoke_cleanup() returns void
language plpgsql security invoker set search_path='' set statement_timeout='5s'
as $$
begin
  delete from public.hana_karaoke_search_cache where expires_at<clock_timestamp();
  delete from public.hana_karaoke_rooms where expires_at<clock_timestamp()-interval '7 days';
end;
$$;
revoke all on function public.hana_karaoke_cleanup() from public,anon,authenticated;
grant execute on function public.hana_karaoke_cleanup() to service_role;
select cron.schedule('hana_karaoke_retention','17 * * * *','select public.hana_karaoke_cleanup()');

create or replace function public.hana_karaoke_command(
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
  if p_action is null or p_action not in ('create', 'state', 'add', 'remove', 'up', 'down', 'prioritize', 'next', 'play', 'pause', 'ended', 'close')
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
    if p_data ? 'priority' and jsonb_typeof(p_data->'priority') <> 'boolean' then
      raise exception using errcode = 'P0001', message = 'KARAOKE_INVALID_REQUEST';
    end if;
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
      v_item := jsonb_build_object('id', p_request_id::text, 'videoId', p_data->>'videoId', 'title', btrim(p_data->>'title'));
      if coalesce((p_data->>'priority')::boolean, false) then
        v_room.queue := jsonb_build_array(v_item) || v_room.queue;
      else
        v_room.queue := v_room.queue || jsonb_build_array(v_item);
      end if;
    end if;
  elsif p_action in ('remove', 'up', 'down', 'prioritize') then
    if coalesce(p_data->>'itemId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      raise exception using errcode = 'P0001', message = 'KARAOKE_INVALID_REQUEST';
    end if;
    select (ordinality - 1)::integer into v_index
      from jsonb_array_elements(v_room.queue) with ordinality as items(item, ordinality)
      where item->>'id' = p_data->>'itemId' limit 1;
    if found then
      if p_action = 'remove' then
        v_room.queue := v_room.queue - v_index;
      elsif p_action = 'prioritize' then
        v_room.queue := jsonb_build_array(v_room.queue->v_index) || (v_room.queue - v_index);
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
