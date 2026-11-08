# HANA shared song catalogue

- TV receiver: `https://dalatgolfvoucher.com/tv` (`/hana_karaoke_tv` remains compatible).
- Guest QR invitations still open `/hana_karaoke`; only the guest capability is shared.
- The existing Excel catalogue provided 2,588 unique video IDs: Korean-source 1,876, Vietnamese-source 606, pop 106. Category is an editorial/channel classification, not a guarantee of lyric language. Alternate keys/versions have different video IDs and remain separate.
- Only metadata is stored. No video/audio/image binaries are downloaded or hosted.

## Search and reservation

Catalogue search is the default. It supports title/artist text, case/accent-insensitive Vietnamese, category filters and explicit pagination (10 results). It calls Supabase, not Google. Missing results never automatically spend YouTube search quota. Select **YouTube search** explicitly for missing songs; the existing search cap/cache/priority queue remain unchanged.

After a successful ordinary or priority reservation, the Edge function best-effort copies metadata for that video from the trusted, unexpired YouTube search cache. Client-supplied titles cannot populate the shared catalogue. Reservation success is never changed to failure if saving the catalogue fails; existing mutation fingerprints and current-song guards are unchanged.

## Access and maintenance

`hana_karaoke_catalog` is not directly accessible to anon/authenticated clients. RLS and explicit grants restrict it to service-role functions. Catalogue search uses the same room capability/read-rate gate as existing state reads. Neither Google nor service keys are exposed to clients.

A dedicated daily cron job (03:43 UTC) sends a one-use, 15-minute capability to `hana-karaoke-catalog-refresh`. It refreshes at most 200 oldest records per run using at most four `videos.list` requests, **no `search.list` requests**. At the initial size, a complete pass takes about 13 days. Unavailable, private, unembeddable or VN-blocked entries are removed from the catalogue only. A separate hourly job purges metadata from age 29 days 23 hours, keeping the maximum retention within 30 days even if the daily provider refresh fails. Provider errors do not mark records as refreshed or remove a batch.

Monitor `cron.job_run_details`, the dedicated function's HTTP status, and the catalogue's oldest `checked_at`. If catalogue size grows beyond the daily maintenance capacity, increase the bounded maintenance batch/frequency after checking quotas; do not let it silently outgrow the 30-day refresh window. Google keys remain in Supabase secrets.

## Verification / rollback

Isolated PGlite tests cover data preservation, capability checks, RLS/grants, Unicode matching, literal wildcards, pagination, idempotent imports, cache-only capture, retention and refresh leases. Isolated Edge/browser tests cover both search modes and unchanged ordinary/priority/play/pause/next/fullscreen behavior. Physical LG TV playback still depends on its browser, autoplay policy and the selected video's embed availability.

Rollback the frontend/Edge commit to restore YouTube-only search. Leaving the additive private catalogue tables in place does not alter business records or room queues. Disable only `hana_karaoke_catalog_refresh` if maintenance must stop; do not disable the existing room cleanup job. Do not drop old room or business tables.

