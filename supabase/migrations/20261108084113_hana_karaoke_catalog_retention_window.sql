-- CLI-created migration version aligned to hosted history.
-- Independent hourly retention, even if the daily provider refresh fails.
-- Delete slightly before 30 days so the hourly boundary cannot retain API metadata beyond 30 days.
select cron.schedule('hana_karaoke_catalog_retention','7 * * * *',$job$
  delete from public.hana_karaoke_catalog where checked_at <= now()-interval '29 days 23 hours';
  delete from karaoke_private.catalog_refresh_jobs where expires_at <= now();
$job$);

