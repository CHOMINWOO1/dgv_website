-- Additive catalogue-only metadata and index. No business/room data changes.
set local lock_timeout = '3s';
alter table public.hana_karaoke_catalog
  add column view_count bigint check(view_count >= 0),
  add column channel_id text check(channel_id ~ '^UC[A-Za-z0-9_-]{22}$'),
  add column published_at timestamptz;
create function public.hana_karaoke_catalog_compact(p_text text)
returns text language sql immutable parallel safe set search_path = '' as $$
  select regexp_replace(public.hana_karaoke_catalog_normalize(p_text),
    '[[:space:]' || chr(160) || chr(8203) || chr(12288) || chr(65279) || ']+','','g')
$$;
revoke all on function public.hana_karaoke_catalog_compact(text) from public,anon,authenticated;
grant execute on function public.hana_karaoke_catalog_compact(text) to service_role;
create index hana_karaoke_catalog_compact_search on public.hana_karaoke_catalog
  using gin (public.hana_karaoke_catalog_compact(search_text) extensions.gin_trgm_ops);
comment on column public.hana_karaoke_catalog.view_count is 'YouTube-reported view count, refreshed with other metadata; not an independently computed popularity metric.';

create or replace function public.hana_karaoke_catalog_import(p_songs jsonb)
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
    insert into public.hana_karaoke_catalog(video_id,title,song_title,artist,channel_title,category,duration_seconds,checked_at,view_count,channel_id,published_at)
    values(s->>'videoId',s->>'title',coalesce(nullif(s->>'songTitle',''),s->>'title'),coalesce(s->>'artist',''),
      coalesce(s->>'channelTitle',''),coalesce(s->>'category','other'),(s->>'durationSeconds')::integer,(s->>'checkedAt')::timestamptz,(s->>'views')::bigint,s->>'channelId',(s->>'publishedAt')::timestamptz)
    on conflict (video_id) do nothing;
    get diagnostics changed = row_count;
    inserted := inserted + changed;
    if changed=0 then
      update public.hana_karaoke_catalog c set
        view_count=coalesce((s->>'views')::bigint,c.view_count),
        channel_id=coalesce(s->>'channelId',c.channel_id),
        published_at=coalesce((s->>'publishedAt')::timestamptz,c.published_at)
      where c.video_id=s->>'videoId' and
        (c.view_count,c.channel_id,c.published_at) is distinct from
        (coalesce((s->>'views')::bigint,c.view_count),coalesce(s->>'channelId',c.channel_id),coalesce((s->>'publishedAt')::timestamptz,c.published_at));
    end if;
  end loop;
  return jsonb_build_object('inserted',inserted);
end $$;

create or replace function public.hana_karaoke_catalog_search(p_room text,p_token_hash text,p_request_id uuid,p_query text,p_category text,p_offset integer)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare q text; found jsonb; has_more boolean;
begin
  if p_query is null or char_length(p_query) not between 1 and 100 or p_category is null
    or p_category not in ('all','ko','vi','pop','other') or p_offset is null or p_offset not between 0 and 20000 then
    raise exception 'KARAOKE_INVALID_REQUEST';
  end if;
  perform public.hana_karaoke_command('state',p_room,p_token_hash,p_request_id,'{}'::jsonb,null,false);
  q := public.hana_karaoke_catalog_compact(p_query);
  if q='' then return jsonb_build_object('items','[]'::jsonb,'source','catalog','nextPageToken',null); end if;
  q := '%' || replace(replace(replace(q,E'\\',E'\\\\'),'%',E'\\%'),'_',E'\\_') || '%';
  with candidates as (
    select c.* from public.hana_karaoke_catalog c
    where c.checked_at > now()-interval '30 days' and (p_category='all' or c.category=p_category)
      and public.hana_karaoke_catalog_compact(c.search_text) like q escape E'\\'
    order by c.view_count desc nulls last,c.song_title collate "C",c.video_id limit 11 offset p_offset
  ), numbered as (select *,row_number() over (order by view_count desc nulls last,song_title collate "C",video_id) n from candidates)
  select coalesce(jsonb_agg(jsonb_build_object('videoId',video_id,'title',title,'channelTitle',channel_title,
    'thumbnail','https://i.ytimg.com/vi/'||video_id||'/mqdefault.jpg','category',category,'viewCount',view_count) order by n) filter(where n<=10),'[]'::jsonb),
    coalesce(bool_or(n=11),false) into found,has_more from numbered;
  return jsonb_build_object('items',found,'source','catalog','nextPageToken',case when has_more and p_offset<20000 then (p_offset+10)::text else null end);
end $$;

create or replace function public.hana_karaoke_catalog_refresh_finish(p_lease uuid,p_items jsonb,p_removed text[])
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare job karaoke_private.catalog_refresh_jobs; s jsonb; n integer:=0;
begin
  perform pg_advisory_xact_lock(58117,20261108);
  select * into job from karaoke_private.catalog_refresh_jobs where id=p_lease and claimed and expires_at > now() for update;
  if not found then raise exception 'Invalid catalogue refresh lease'; end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items)>200 or cardinality(p_removed)>200 then raise exception 'Invalid refresh batch'; end if;
  for s in select value from jsonb_array_elements(p_items) loop
    if not coalesce(s->>'videoId'=any(job.video_ids),false) then raise exception 'Unleased video'; end if;
    update public.hana_karaoke_catalog set title=s->>'title',song_title=s->>'title',artist='',channel_title=coalesce(s->>'channelTitle',''),
      duration_seconds=(s->>'durationSeconds')::integer,
      view_count=coalesce((s->>'views')::bigint,view_count),channel_id=coalesce(s->>'channelId',channel_id),
      published_at=coalesce((s->>'publishedAt')::timestamptz,published_at),checked_at=clock_timestamp() where video_id=s->>'videoId';
    n:=n+1;
  end loop;
  if not coalesce(p_removed <@ job.video_ids,true) then raise exception 'Unleased removal'; end if;
  if job.cycle_id is not null and (
    (select count(distinct id) from (
      select value->>'videoId' id from jsonb_array_elements(p_items)
      union all select unnest(p_removed)
    ) covered) <> cardinality(job.video_ids)
    or jsonb_array_length(p_items)+coalesce(cardinality(p_removed),0) <> cardinality(job.video_ids)
  ) then raise exception 'Incomplete refresh batch'; end if;
  delete from public.hana_karaoke_catalog where video_id=any(p_removed);
  if job.cycle_id is not null then
    update karaoke_private.catalog_refresh_cycles set refreshed_count=refreshed_count+n,
      removed_count=removed_count+coalesce(cardinality(p_removed),0) where id=job.cycle_id;
  end if;
  delete from karaoke_private.catalog_refresh_jobs where id=job.id;
  if job.cycle_id is not null then perform karaoke_private.enqueue_catalog_refresh(); end if;
  return jsonb_build_object('refreshed',n,'removed',coalesce(cardinality(p_removed),0));
end $$;


-- A complete refresh cycle is due every 28 days. One daily DB-only due check,
-- no provider requests between cycles. Each successful 200-video batch queues the next.
create table karaoke_private.catalog_refresh_cycles(
 id uuid primary key default gen_random_uuid(),started_at timestamptz not null default clock_timestamp(),
 completed_at timestamptz,refreshed_count integer not null default 0,removed_count integer not null default 0
);
create unique index karaoke_catalog_one_active_cycle on karaoke_private.catalog_refresh_cycles((true)) where completed_at is null;
alter table karaoke_private.catalog_refresh_cycles enable row level security;
revoke all on karaoke_private.catalog_refresh_cycles from public,anon,authenticated;
grant select,insert,update on karaoke_private.catalog_refresh_cycles to service_role;
create policy karaoke_catalog_cycles_service_only on karaoke_private.catalog_refresh_cycles for all to service_role using(true) with check(true);

create table karaoke_private.catalog_refresh_state(
 singleton boolean primary key default true check(singleton),initial_checked_at timestamptz not null
);
insert into karaoke_private.catalog_refresh_state(singleton,initial_checked_at)
 select true,coalesce(min(checked_at),clock_timestamp()) from public.hana_karaoke_catalog;
alter table karaoke_private.catalog_refresh_state enable row level security;
revoke all on karaoke_private.catalog_refresh_state from public,anon,authenticated;
grant select on karaoke_private.catalog_refresh_state to service_role;
create policy karaoke_catalog_state_service_only on karaoke_private.catalog_refresh_state for select to service_role using(true);
alter table karaoke_private.catalog_refresh_jobs add column cycle_id uuid;

create or replace function karaoke_private.enqueue_catalog_refresh()
returns void language plpgsql security invoker set search_path = '' as $$
declare token text; cycle uuid; started timestamptz; ids text[];
begin
 perform pg_advisory_xact_lock(58117,20261108);
 delete from karaoke_private.catalog_refresh_jobs where expires_at < now();
 delete from public.hana_karaoke_catalog where checked_at <= now()-interval '30 days';
 -- If a pre-upgrade batch is still running, let it finish before starting a cycle.
 if exists(select 1 from karaoke_private.catalog_refresh_jobs where expires_at>now()) then return; end if;
 select id,started_at into cycle,started from karaoke_private.catalog_refresh_cycles where completed_at is null for update;
 if cycle is null then
   insert into karaoke_private.catalog_refresh_cycles default values returning id,started_at into cycle,started;
 end if;
 select array_agg(video_id) into ids from (
   select video_id from public.hana_karaoke_catalog where checked_at < started order by checked_at,video_id limit 200
 ) selected;
 if coalesce(cardinality(ids),0)=0 then
   update karaoke_private.catalog_refresh_cycles set completed_at=clock_timestamp() where id=cycle;
   return;
 end if;
 token:=replace(gen_random_uuid()::text||gen_random_uuid()::text,'-','');
 insert into karaoke_private.catalog_refresh_jobs(token_hash,video_ids,cycle_id)
 values(encode(sha256(convert_to(token,'UTF8')),'hex'),ids,cycle);
 perform net.http_post(url:='https://fbbecxtxsaplrmanjunw.supabase.co/functions/v1/hana-karaoke-catalog-refresh',
   body:=jsonb_build_object('token',token),headers:='{"Content-Type":"application/json"}'::jsonb,timeout_milliseconds:=60000);
end $$;

create or replace function public.hana_karaoke_catalog_refresh_claim(p_token text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare job karaoke_private.catalog_refresh_jobs;
begin
 if p_token is null or p_token !~ '^[a-f0-9]{64}$' then return null; end if;
 select * into job from karaoke_private.catalog_refresh_jobs
 where token_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex') and expires_at>now() and not claimed for update;
 if not found then return null; end if;
 if job.cycle_id is null then
   -- Only a short-lived pre-upgrade lease can reach this branch.
   select array_agg(video_id) into job.video_ids from (
     select video_id from public.hana_karaoke_catalog order by checked_at,video_id limit 200
   ) selected;
 end if;
 update karaoke_private.catalog_refresh_jobs set claimed=true,video_ids=coalesce(job.video_ids,'{}') where id=job.id;
 return jsonb_build_object('leaseId',job.id,'videoIds',coalesce(job.video_ids,'{}'));
end $$;

create function karaoke_private.enqueue_catalog_refresh_if_due()
returns void language plpgsql security invoker set search_path = '' as $$
declare last_done timestamptz;
begin
 perform pg_advisory_xact_lock(58117,20261108);
 if exists(select 1 from karaoke_private.catalog_refresh_cycles where completed_at is null) then
   perform karaoke_private.enqueue_catalog_refresh(); return;
 end if;
 select coalesce((select max(completed_at) from karaoke_private.catalog_refresh_cycles),
   (select initial_checked_at from karaoke_private.catalog_refresh_state where singleton)) into last_done;
 if last_done <= clock_timestamp()-interval '28 days' then perform karaoke_private.enqueue_catalog_refresh(); end if;
end $$;
revoke all on function karaoke_private.enqueue_catalog_refresh_if_due() from public,anon,authenticated;
grant execute on function karaoke_private.enqueue_catalog_refresh_if_due() to service_role;
select cron.schedule('hana_karaoke_catalog_refresh','43 3 * * *','select karaoke_private.enqueue_catalog_refresh_if_due()');
