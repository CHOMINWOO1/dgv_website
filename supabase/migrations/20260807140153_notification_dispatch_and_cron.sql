-- Notification v2 delivery wiring for the staging rehearsal.
--
-- Prerequisites:
--   * 20260807113713_security_hardening.sql has created the protected outbox.
--   * tg_notify_v2 is deployed with verify_jwt = true.
--   * Supabase Vault contains exactly one non-empty secret for each name below:
--       dgv_tg_notify_project_url
--       dgv_tg_notify_legacy_anon_jwt
--
-- This migration never embeds a project URL, API key, service-role key, Telegram
-- credential, or notification payload from production. pg_net starts requests
-- only after the surrounding transaction commits. Dispatch errors are fail-open:
-- the application row and durable pending outbox row remain committed for retry.
--
-- Activation rollback (run deliberately; it is not part of this migration):
--   select cron.unschedule('tg_notify_v2_dispatch_pending');
--   select cron.unschedule('tg_tomorrow_resv_20h_vn');
--   drop trigger if exists trg_notification_outbox_dispatch
--     on public.notification_outbox;
-- Keep notification_outbox rows during rollback for audit and recovery.

-- Keep extension metadata outside public to avoid extension_in_public advisor
-- findings. pg_net still exposes its callable API as net.*; pg_cron is a
-- fixed-schema extension in pg_catalog and exposes its API as cron.*.
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

-- Neither extension is a browser API. Internal SECURITY DEFINER functions owned
-- by the migration role retain the privileges required for dispatch and Cron.
revoke usage on schema net from public, anon, authenticated, service_role;
revoke execute on all functions in schema net
  from public, anon, authenticated, service_role;
revoke usage on schema cron from public, anon, authenticated, service_role;
revoke execute on all functions in schema cron
  from public, anon, authenticated, service_role;

grant usage on schema net to postgres;
grant execute on function net.http_post(text, jsonb, jsonb, jsonb, integer)
  to postgres;
grant execute on all functions in schema cron to postgres;

alter table public.notification_outbox force row level security;

revoke all on table public.notification_outbox
  from public, anon, authenticated, service_role;
grant select, insert, update on table public.notification_outbox to service_role;

create index if not exists notification_outbox_pending_created_idx
  on public.notification_outbox (created_at, id)
  where status = 'pending';

-- PostgreSQL length() counts Unicode code points while JavaScript String.length
-- (used by tg_notify_v2 validation) counts UTF-16 code units. Preserve the full
-- reservation text in resv_groups, but normalize Edge-rejected C0/DEL controls,
-- safely abbreviate notification copies, and append an explicit truncation marker.
create or replace function private.notification_text_for_edge(
  p_value text,
  p_max_utf16_units integer
)
returns text
language plpgsql
immutable
strict
security invoker
set search_path = ''
as $$
declare
  v_character text;
  v_codepoint integer;
  v_character_units integer;
  v_index integer;
  v_length integer := pg_catalog.char_length(p_value);
  v_normalized text := '';
  v_total_units integer := 0;
  v_result text := '';
begin
  if p_max_utf16_units < 4 then
    raise exception using
      errcode = '22023',
      message = 'notification text limit must be at least 4 UTF-16 units';
  end if;

  for v_index in 1..v_length loop
    v_character := pg_catalog.substr(p_value, v_index, 1);
    v_codepoint := pg_catalog.ascii(v_character);

    if v_codepoint <= 8
       or v_codepoint in (11, 12, 127)
       or v_codepoint between 14 and 31 then
      v_character := ' ';
      v_codepoint := 32;
    end if;

    v_normalized := v_normalized || v_character;
    v_total_units := v_total_units + case
      when v_codepoint > 65535 then 2
      else 1
    end;
  end loop;

  if v_total_units <= p_max_utf16_units then
    return v_normalized;
  end if;

  v_total_units := 0;
  for v_index in 1..v_length loop
    v_character := pg_catalog.substr(v_normalized, v_index, 1);
    v_character_units := case
      when pg_catalog.ascii(v_character) > 65535 then 2
      else 1
    end;

    exit when v_total_units + v_character_units > p_max_utf16_units - 3;
    v_result := v_result || v_character;
    v_total_units := v_total_units + v_character_units;
  end loop;

  return v_result || '...';
end;
$$;

revoke all on function private.notification_text_for_edge(text, integer)
  from public, anon, authenticated, service_role;

-- Replace the hardening migration's inert producer body without replacing its
-- trigger. Payload keys remain exact; only notification copies are abbreviated.
create or replace function private.enqueue_reservation_created()
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
      'branch', private.notification_text_for_edge(new.branch, 200),
      'guests_count', new.guests_count,
      'menu_ko', private.notification_text_for_edge(new.menu_ko, 500),
      'menu_vi', private.notification_text_for_edge(new.menu_vi, 500),
      'guide_name', private.notification_text_for_edge(new.guide_name, 200),
      'note', private.notification_text_for_edge(new.note, 1000)
    ),
    'resv_insert:' || new.id::text
  )
  on conflict (idempotency_key) do nothing;

  return new;
end;
$$;

revoke all on function private.enqueue_reservation_created()
  from public, anon, authenticated, service_role;

-- Queue exactly {"id":"<uuid>"}. tg_notify_v2 owns the atomic
-- pending -> processing claim, so duplicate HTTP requests cannot duplicate a
-- normal Telegram delivery. The legacy anon JWT is only a gateway credential;
-- the service-role key must never be stored in Vault or sent by this function.
create or replace function private.invoke_tg_notify_v2(p_outbox_id uuid)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project_url text;
  v_anon_jwt text;
begin
  if p_outbox_id is null then
    raise exception using
      errcode = '22004',
      message = 'outbox id is required';
  end if;

  if not exists (
    select 1
    from public.notification_outbox as o
    where o.id = p_outbox_id
      and o.status = 'pending'
  ) then
    return null;
  end if;

  select
    (
      select s.decrypted_secret
      from vault.decrypted_secrets as s
      where s.name = 'dgv_tg_notify_project_url'
    ),
    (
      select s.decrypted_secret
      from vault.decrypted_secrets as s
      where s.name = 'dgv_tg_notify_legacy_anon_jwt'
    )
  into v_project_url, v_anon_jwt;

  v_project_url := pg_catalog.rtrim(pg_catalog.btrim(v_project_url), '/');
  v_anon_jwt := pg_catalog.btrim(v_anon_jwt);

  if v_project_url is null or v_project_url = '' then
    raise exception using
      errcode = '22023',
      message = 'Vault project URL is missing';
  end if;

  if v_anon_jwt is null or v_anon_jwt = '' then
    raise exception using
      errcode = '22023',
      message = 'Vault legacy anon JWT is missing';
  end if;

  return net.http_post(
    url => v_project_url || '/functions/v1/tg_notify_v2',
    body => pg_catalog.jsonb_build_object('id', p_outbox_id::text),
    headers => pg_catalog.jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_anon_jwt
    ),
    timeout_milliseconds => 5000
  );
end;
$$;

revoke all on function private.invoke_tg_notify_v2(uuid)
  from public, anon, authenticated, service_role;

-- Dispatch new pending rows immediately. An explicit operator-controlled
-- failed/processing -> pending recovery also dispatches. The exception handler
-- deliberately preserves the application transaction and pending outbox row.
create or replace function private.dispatch_notification_outbox_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'pending' then
      perform private.invoke_tg_notify_v2(new.id);
    end if;
  elsif new.status = 'pending'
        and old.status is distinct from new.status then
    perform private.invoke_tg_notify_v2(new.id);
  end if;

  return new;
exception
  when others then
    raise warning
      'tg_notify_v2 queueing failed (outbox_id %, sqlstate %)',
      new.id,
      sqlstate;
    return new;
end;
$$;

revoke all on function private.dispatch_notification_outbox_trigger()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_notification_outbox_dispatch
  on public.notification_outbox;

create trigger trg_notification_outbox_dispatch
after insert or update of status on public.notification_outbox
for each row execute function private.dispatch_notification_outbox_trigger();

-- pg_net's queue is unlogged, so the durable outbox is also polled. Row locks
-- stop overlapping Cron runs from selecting the same rows in one transaction;
-- Edge still provides the authoritative atomic claim across HTTP requests.
create or replace function private.dispatch_pending_notification_outbox(
  p_limit integer default 25
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_request_id bigint;
  v_queued integer := 0;
begin
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception using
      errcode = '22023',
      message = 'dispatch limit must be between 1 and 100';
  end if;

  for v_id in
    select o.id
    from public.notification_outbox as o
    where o.status = 'pending'
    order by o.created_at, o.id
    limit p_limit
    for update skip locked
  loop
    begin
      select private.invoke_tg_notify_v2(v_id)
      into v_request_id;

      if v_request_id is not null then
        v_queued := v_queued + 1;
      end if;
    exception
      when others then
        raise warning
          'tg_notify_v2 retry queueing failed (outbox_id %, sqlstate %)',
          v_id,
          sqlstate;
    end;
  end loop;

  return v_queued;
end;
$$;

revoke all on function private.dispatch_pending_notification_outbox(integer)
  from public, anon, authenticated, service_role;

-- Build the exact tg_notify_v2 summary contract. Top-level keys are exactly
-- date/rows; each row has exactly the eight keys listed below. Selecting at most
-- 101 rows detects contract overflow without aggregating an unbounded result.
create or replace function private.enqueue_reservation_summary(
  p_event_type text,
  p_date date
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row_count bigint;
  v_rows jsonb;
  v_payload jsonb;
  v_outbox_id uuid;
  v_idempotency_key text;
begin
  if p_event_type is null
     or p_event_type not in ('daily_summary', 'tomorrow_summary') then
    raise exception using
      errcode = '22023',
      message = 'invalid summary event type';
  end if;

  if p_date is null then
    raise exception using
      errcode = '22004',
      message = 'summary date is required';
  end if;

  with selected_reservations as (
    select
      r.id,
      r.res_time,
      r.branch,
      r.guests_count,
      r.price,
      r.menu_ko,
      r.menu_vi,
      r.guide_name,
      r.note
    from public.resv_groups as r
    where r.res_date = p_date
    order by r.res_time, r.id
    limit 101
  )
  select
    pg_catalog.count(*),
    coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'res_time', r.res_time::text,
          'branch', private.notification_text_for_edge(r.branch, 200),
          'guests_count', r.guests_count,
          'price', r.price,
          'menu_ko', private.notification_text_for_edge(r.menu_ko, 500),
          'menu_vi', private.notification_text_for_edge(r.menu_vi, 500),
          'guide_name', private.notification_text_for_edge(r.guide_name, 200),
          'note', private.notification_text_for_edge(r.note, 1000)
        ) order by r.res_time, r.id
      ),
      '[]'::jsonb
    )
  into v_row_count, v_rows
  from selected_reservations as r;

  if v_row_count > 100 then
    raise exception using
      errcode = '54000',
      message = 'summary exceeds the 100-row tg_notify_v2 contract';
  end if;

  v_payload := pg_catalog.jsonb_build_object(
    'date', p_date::text,
    'rows', v_rows
  );

  if pg_catalog.octet_length(v_payload::text) > 32768 then
    raise exception using
      errcode = '54000',
      message = 'summary payload exceeds the 32 KiB tg_notify_v2 contract';
  end if;

  v_idempotency_key := p_event_type || ':' || p_date::text;

  insert into public.notification_outbox (
    event_type,
    payload,
    idempotency_key
  )
  values (
    p_event_type,
    v_payload,
    v_idempotency_key
  )
  on conflict (idempotency_key) do nothing
  returning id into v_outbox_id;

  if v_outbox_id is null then
    select o.id
    into v_outbox_id
    from public.notification_outbox as o
    where o.idempotency_key = v_idempotency_key;
  end if;

  return v_outbox_id;
end;
$$;

revoke all on function private.enqueue_reservation_summary(text, date)
  from public, anon, authenticated, service_role;

-- Preserve the two legacy database signatures for database-owner/Cron use while
-- keeping them completely outside the anon/authenticated/service-role API.
create or replace function public.send_resv_summary_by_date(p_date date)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.enqueue_reservation_summary('daily_summary', p_date);
end;
$$;

create or replace function public.send_tomorrow_resv_summary()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_local_today date;
begin
  v_local_today := (
    pg_catalog.clock_timestamp() at time zone 'Asia/Ho_Chi_Minh'
  )::date;

  perform private.enqueue_reservation_summary(
    'tomorrow_summary',
    v_local_today + 1
  );
end;
$$;

revoke all on function public.send_resv_summary_by_date(date)
  from public, anon, authenticated, service_role;
revoke all on function public.send_tomorrow_resv_summary()
  from public, anon, authenticated, service_role;

-- cron.schedule(job_name, ...) updates the named job on a rerun, so these are
-- idempotent without directly mutating cron.job. Supabase Cron uses UTC:
-- 13:00 UTC is 20:00 in Asia/Ho_Chi_Minh, which has no daylight-saving shift.
select cron.schedule(
  'tg_notify_v2_dispatch_pending',
  '* * * * *',
  $cron$select private.dispatch_pending_notification_outbox(25);$cron$
);

select cron.schedule(
  'tg_tomorrow_resv_20h_vn',
  '0 13 * * *',
  $cron$select public.send_tomorrow_resv_summary();$cron$
);
