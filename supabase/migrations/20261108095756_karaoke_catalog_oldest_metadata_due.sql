-- A just-booked song may come from a trusted cache up to 24 hours old.
-- Base the next full cycle on the oldest verified metadata as well as the last
-- completed cycle, so these entries are refreshed before the retention cutoff.
create or replace function karaoke_private.enqueue_catalog_refresh_if_due()
returns void language plpgsql security invoker set search_path = '' as $$
declare last_done timestamptz;
begin
 perform pg_advisory_xact_lock(58117,20261108);
 if exists(select 1 from karaoke_private.catalog_refresh_cycles where completed_at is null) then
   perform karaoke_private.enqueue_catalog_refresh(); return;
 end if;
 select coalesce((select max(completed_at) from karaoke_private.catalog_refresh_cycles),
   (select initial_checked_at from karaoke_private.catalog_refresh_state where singleton)) into last_done;
 last_done:=least(last_done,(select min(checked_at) from public.hana_karaoke_catalog));
 if last_done <= clock_timestamp()-interval '28 days' then perform karaoke_private.enqueue_catalog_refresh(); end if;
end $$;
