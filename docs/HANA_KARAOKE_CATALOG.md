# HANA shared song catalogue

- TV receiver: `https://dalatgolfvoucher.com/tv` (`/hana_karaoke_tv` remains compatible).
- Guest QR invitations still open `/hana_karaoke`; only the guest capability is shared.
- The existing Excel catalogue provided 2,588 unique video IDs: Korean-source 1,876, Vietnamese-source 606, pop 106. Category is an editorial/channel classification, not a guarantee of lyric language. Alternate keys/versions have different video IDs and remain separate.
- Only metadata is stored. No video/audio/image binaries are downloaded or hosted.
- Expansion follows official-channel uploads and playlists, deduplicating by video ID only. Identical song names by different artists, and distinct keys/backing versions, remain separate. Metadata must be public, embeddable and playable in Vietnam at collection time. Catalogue size is not a count of unique musical compositions or a guarantee of commercial performance rights.

## Search and reservation

Catalogue search is the default. It supports title/artist text, ignores spaces (including common invisible/full-width spaces), case and Vietnamese accents, and retains category filters and explicit pagination (10 results). Matches are ordered by YouTube's reported view count, with title/ID tie-breakers, not an invented popularity score. It calls Supabase, not Google. Missing results never automatically spend YouTube search quota. Select **YouTube search** explicitly for missing songs; the existing search cap/cache/priority queue remain unchanged.

After a successful ordinary or priority reservation, the Edge function best-effort copies metadata for that video from the trusted, unexpired YouTube search cache. Client-supplied titles cannot populate the shared catalogue. Reservation success is never changed to failure if saving the catalogue fails; existing mutation fingerprints and current-song guards are unchanged.

## Access and maintenance

`hana_karaoke_catalog` is not directly accessible to anon/authenticated clients. RLS and explicit grants restrict it to service-role functions. Catalogue search uses the same room capability/read-rate gate as existing state reads. Neither Google nor service keys are exposed to clients.

A dedicated daily DB-only due check (03:43 UTC) starts a full metadata refresh cycle when 28 days have elapsed. No Google request is sent between cycles. A cycle sends a one-use, 15-minute capability to `hana-karaoke-catalog-refresh` for at most 200 IDs. Each successful batch queues the next, sequentially, until the full catalogue is checked. At 50,000 IDs the complete cycle uses about 1,000 `videos.list` requests, **no `search.list` requests**. Private cycle state prevents overlapping jobs; failed/expired batches are retried by the next daily due check without marking unchecked rows fresh.

The due check also considers the oldest `checked_at`, including newly remembered entries from an unexpired search cache. They cannot miss the next full refresh merely because they were saved after a cycle completed.

Unavailable, private, unembeddable or VN-blocked entries are removed from the catalogue only. A separate hourly job purges metadata from age 29 days 23 hours, keeping the maximum retention within 30 days even during a prolonged provider outage. This is metadata housekeeping, not room termination or deletion of business records. Monitor `cron.job_run_details`, refresh cycle counters/completion, the dedicated function's HTTP status, and the oldest `checked_at`. Google keys remain in Supabase secrets. This 28-day cycle is intentionally not an hourly or daily provider refresh.

## Verification / rollback

Isolated PGlite tests cover data preservation, capability checks, RLS/grants, Unicode matching, literal wildcards, pagination, idempotent imports, cache-only capture, retention and refresh leases. Isolated Edge/browser tests cover both search modes and unchanged ordinary/priority/play/pause/next/fullscreen behavior. Physical LG TV playback still depends on its browser, autoplay policy and the selected video's embed availability.

Run `node tests/karaoke-catalog-expansion-db.mjs` for the 28-day upgrade, sequential full-cycle batches, expiry/retry, same-title/different-artist preservation and space-insensitive search contract. Run `node --test tests/karaoke-edge.mjs tests/karaoke-catalog-edge.mjs` for the Edge contracts.

Rollback the frontend/Edge commit to restore YouTube-only search. Leaving the additive private catalogue tables in place does not alter business records or room queues. Disable only `hana_karaoke_catalog_refresh` if maintenance must stop; do not disable the existing room cleanup job. Do not drop old room or business tables.
