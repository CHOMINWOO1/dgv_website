-- CLI-created migration version aligned to the hosted migration history.
-- Separate metadata catalogue; never modify business tables or active rooms.
create extension if not exists pg_trgm with schema extensions;
create extension if not exists unaccent with schema extensions;
create schema karaoke_private;
revoke all on schema karaoke_private from public, anon, authenticated;
grant usage on schema karaoke_private, extensions to service_role;

create function public.hana_karaoke_catalog_normalize(p_text text)
returns text language sql immutable parallel safe set search_path = '' as $$
  select extensions.unaccent('extensions.unaccent'::regdictionary, lower(coalesce(p_text, '')))
$$;
revoke all on function public.hana_karaoke_catalog_normalize(text) from public, anon, authenticated;
grant execute on function public.hana_karaoke_catalog_normalize(text) to service_role;

create table public.hana_karaoke_catalog (
  video_id text primary key check (video_id ~ '^[A-Za-z0-9_-]{11}$'),
  title text not null check (char_length(title) between 1 and 500),
  song_title text not null check (char_length(song_title) between 1 and 500),
  artist text not null default '' check (char_length(artist) <= 300),
  channel_title text not null default '' check (char_length(channel_title) <= 300),
  category text not null check (category in ('ko','vi','pop','other')),
  duration_seconds integer check (duration_seconds between 0 and 86400),
  checked_at timestamptz not null,
  created_at timestamptz not null default now(),
  search_text text generated always as
    (public.hana_karaoke_catalog_normalize(song_title || ' ' || artist || ' ' || title)) stored
);
alter table public.hana_karaoke_catalog enable row level security;
revoke all on public.hana_karaoke_catalog from public, anon, authenticated;
grant select, insert, update, delete on public.hana_karaoke_catalog to service_role;
create policy hana_karaoke_catalog_service_only on public.hana_karaoke_catalog for all to service_role using(true) with check(true);
comment on table public.hana_karaoke_catalog is 'Service-only YouTube metadata. Capability-authorized Edge search only. Refreshed daily in bounded batches; stale metadata removed after 30 days.';
create index hana_karaoke_catalog_search on public.hana_karaoke_catalog using gin (search_text extensions.gin_trgm_ops);
create index hana_karaoke_catalog_checked on public.hana_karaoke_catalog(checked_at, video_id);
create index hana_karaoke_catalog_category on public.hana_karaoke_catalog(category, song_title, video_id);

create function public.hana_karaoke_catalog_import(p_songs jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare s jsonb; inserted integer := 0; changed integer;
begin
  if jsonb_typeof(p_songs) is distinct from 'array' or jsonb_array_length(p_songs) > 250 then
    raise exception 'Invalid catalogue batch';
  end if;
  for s in select value from jsonb_array_elements(p_songs) loop
    if s->>'videoId' is null or s->>'title' is null or s->>'checkedAt' is null
      or (s->>'checkedAt')::timestamptz < now()-interval '30 days'
      or (s->>'checkedAt')::timestamptz > now()+interval '1 minute' then
      raise exception 'Invalid catalogue metadata';
    end if;
    insert into public.hana_karaoke_catalog(video_id,title,song_title,artist,channel_title,category,duration_seconds,checked_at)
    values(s->>'videoId',s->>'title',coalesce(nullif(s->>'songTitle',''),s->>'title'),coalesce(s->>'artist',''),
      coalesce(s->>'channelTitle',''),coalesce(s->>'category','other'),(s->>'durationSeconds')::integer,(s->>'checkedAt')::timestamptz)
    on conflict (video_id) do nothing;
    get diagnostics changed = row_count;
    inserted := inserted + changed;
  end loop;
  return jsonb_build_object('inserted',inserted);
end $$;

create function public.hana_karaoke_catalog_search(p_room text,p_token_hash text,p_request_id uuid,p_query text,p_category text,p_offset integer)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare q text; found jsonb; has_more boolean;
begin
  if p_query is null or char_length(p_query) not between 1 and 100 or p_category is null
    or p_category not in ('all','ko','vi','pop','other') or p_offset is null or p_offset not between 0 and 20000 then
    raise exception 'KARAOKE:INVALID_REQUEST';
  end if;
  -- Reuse existing room capability and read-rate protection, not YouTube quota.
  perform public.hana_karaoke_command('state',p_room,p_token_hash,p_request_id,'{}'::jsonb,null,false);
  q := '%' || replace(replace(replace(public.hana_karaoke_catalog_normalize(btrim(p_query)),E'\\',E'\\\\'),'%',E'\\%'),'_',E'\\_') || '%';
  with candidates as (
    select c.* from public.hana_karaoke_catalog c
    where c.checked_at > now()-interval '30 days' and (p_category='all' or c.category=p_category)
      and c.search_text like q escape E'\\'
    order by c.song_title collate "C",c.video_id limit 11 offset p_offset
  ), numbered as (select *, row_number() over (order by song_title collate "C",video_id) n from candidates)
  select coalesce(jsonb_agg(jsonb_build_object('videoId',video_id,'title',title,'channelTitle',channel_title,
    'thumbnail','https://i.ytimg.com/vi/'||video_id||'/mqdefault.jpg','category',category) order by n) filter(where n<=10),'[]'::jsonb),
    coalesce(bool_or(n=11),false) into found,has_more from numbered;
  return jsonb_build_object('items',found,'source','catalog','nextPageToken',case when has_more then (p_offset+10)::text else null end);
end $$;

create function public.hana_karaoke_catalog_remember(p_video_id text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare s jsonb; checked timestamptz;
begin
  -- Only trusted, successfully fetched YouTube search-cache metadata. Never a client title.
  select item,c.expires_at-interval '24 hours' into s,checked
  from public.hana_karaoke_search_cache c
  cross join lateral jsonb_array_elements(c.result->'items') item
  where c.expires_at > now() and c.error_code is null and item->>'videoId'=p_video_id
  order by c.expires_at desc limit 1;
  if s is null then return jsonb_build_object('inserted',0); end if;
  return public.hana_karaoke_catalog_import(jsonb_build_array(jsonb_build_object(
    'videoId',p_video_id,'title',s->>'title','songTitle',s->>'title','channelTitle',s->>'channelTitle',
    'category','other','checkedAt',checked)));
end $$;

create table karaoke_private.catalog_refresh_jobs(
  id uuid primary key default gen_random_uuid(), token_hash text not null unique,
  expires_at timestamptz not null default now()+interval '15 minutes',
  claimed boolean not null default false, video_ids text[] not null default '{}'
);
alter table karaoke_private.catalog_refresh_jobs enable row level security;
revoke all on karaoke_private.catalog_refresh_jobs from public,anon,authenticated;
grant select,insert,update,delete on karaoke_private.catalog_refresh_jobs to service_role;
create policy karaoke_catalog_jobs_service_only on karaoke_private.catalog_refresh_jobs for all to service_role using(true) with check(true);

create function karaoke_private.enqueue_catalog_refresh()
returns void language plpgsql security invoker set search_path = '' as $$
declare token text := replace(gen_random_uuid()::text||gen_random_uuid()::text,'-','');
begin
  delete from karaoke_private.catalog_refresh_jobs where expires_at < now();
  delete from public.hana_karaoke_catalog where checked_at <= now()-interval '30 days';
  insert into karaoke_private.catalog_refresh_jobs(token_hash) values(encode(sha256(convert_to(token,'UTF8')),'hex'));
  perform net.http_post(url:='https://fbbecxtxsaplrmanjunw.supabase.co/functions/v1/hana-karaoke-catalog-refresh',
    body:=jsonb_build_object('token',token),headers:='{"Content-Type":"application/json"}'::jsonb,timeout_milliseconds:=60000);
end $$;

create function public.hana_karaoke_catalog_refresh_claim(p_token text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare job karaoke_private.catalog_refresh_jobs; ids text[];
begin
  if p_token is null or p_token !~ '^[a-f0-9]{64}$' then return null; end if;
  select * into job from karaoke_private.catalog_refresh_jobs
    where token_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex') and expires_at > now() and not claimed for update;
  if not found then return null; end if;
  select array_agg(video_id) into ids from (
    select video_id from public.hana_karaoke_catalog order by checked_at,video_id limit 200
  ) selected;
  update karaoke_private.catalog_refresh_jobs set claimed=true,video_ids=coalesce(ids,'{}') where id=job.id;
  return jsonb_build_object('leaseId',job.id,'videoIds',coalesce(ids,'{}'));
end $$;

create function public.hana_karaoke_catalog_refresh_finish(p_lease uuid,p_items jsonb,p_removed text[])
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare job karaoke_private.catalog_refresh_jobs; s jsonb; n integer:=0;
begin
  select * into job from karaoke_private.catalog_refresh_jobs where id=p_lease and claimed and expires_at > now() for update;
  if not found then raise exception 'Invalid catalogue refresh lease'; end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items)>200 or cardinality(p_removed)>200 then raise exception 'Invalid refresh batch'; end if;
  for s in select value from jsonb_array_elements(p_items) loop
    if not coalesce(s->>'videoId'=any(job.video_ids),false) then raise exception 'Unleased video'; end if;
    update public.hana_karaoke_catalog set title=s->>'title',song_title=s->>'title',artist='',channel_title=coalesce(s->>'channelTitle',''),
      duration_seconds=(s->>'durationSeconds')::integer,checked_at=clock_timestamp() where video_id=s->>'videoId';
    n:=n+1;
  end loop;
  if not coalesce(p_removed <@ job.video_ids,true) then raise exception 'Unleased removal'; end if;
  delete from public.hana_karaoke_catalog where video_id=any(p_removed);
  delete from karaoke_private.catalog_refresh_jobs where id=job.id;
  return jsonb_build_object('refreshed',n,'removed',coalesce(cardinality(p_removed),0));
end $$;

revoke all on function public.hana_karaoke_catalog_import(jsonb),
 public.hana_karaoke_catalog_search(text,text,uuid,text,text,integer),public.hana_karaoke_catalog_remember(text),
 public.hana_karaoke_catalog_refresh_claim(text),public.hana_karaoke_catalog_refresh_finish(uuid,jsonb,text[]),
 karaoke_private.enqueue_catalog_refresh() from public,anon,authenticated;
grant execute on function public.hana_karaoke_catalog_import(jsonb),
 public.hana_karaoke_catalog_search(text,text,uuid,text,text,integer),public.hana_karaoke_catalog_remember(text),
 public.hana_karaoke_catalog_refresh_claim(text),public.hana_karaoke_catalog_refresh_finish(uuid,jsonb,text[]),
 karaoke_private.enqueue_catalog_refresh() to service_role;
select cron.schedule('hana_karaoke_catalog_refresh','43 3 * * *','select karaoke_private.enqueue_catalog_refresh()');

