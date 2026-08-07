# Telegram notification v2 contract

This document is a contract for the staging migration. It is not an executable
migration and must not be applied to the production project without a reviewed
rollout.

## Database object

`public.notification_outbox` must expose the following columns to the Edge
Function's service-role client:

```sql
create table public.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  event_type text not null check (
    event_type in ('resv_insert', 'daily_summary', 'tomorrow_summary')
  ),
  payload jsonb not null,
  status text not null default 'pending' check (
    status in ('pending', 'processing', 'sent', 'failed')
  ),
  attempts integer not null default 0 check (attempts >= 0),
  delivery_cursor integer not null default 0 check (
    delivery_cursor between 0 and 100
  ),
  created_at timestamptz not null default now(),
  locked_at timestamptz,
  processed_at timestamptz,
  last_error text,
  idempotency_key text not null unique
);

alter table public.notification_outbox enable row level security;
alter table public.notification_outbox force row level security;

revoke all on table public.notification_outbox from public, anon, authenticated;
grant select, insert, update on table public.notification_outbox to service_role;

create index notification_outbox_pending_created_idx
  on public.notification_outbox (created_at)
  where status = 'pending';
```

Do not create `anon` or `authenticated` RLS policies. Producers should insert
through trusted database code, and duplicate events should use a deterministic
`idempotency_key` with `on conflict (idempotency_key) do nothing`. A suggested
key shape is `resv_insert:<reservation-id>` for reservation inserts and
`daily_summary:<yyyy-mm-dd>` / `tomorrow_summary:<yyyy-mm-dd>` for scheduled
summaries.

The Edge Function claims one row with a status-guarded update equivalent to:

```sql
update public.notification_outbox
set status = 'processing',
    attempts = attempts + 1,
    locked_at = now(),
    processed_at = null,
    last_error = null
where id = $1
  and status = 'pending'
  and attempts = $2
  and delivery_cursor = $3
returning id, event_type, payload, attempts, delivery_cursor;
```

The implementation reads the current attempt count first because PostgREST's
normal update representation cannot express `attempts + 1`; ownership still
comes only from the atomic status/attempt/cursor guards. Concurrent or delayed
calls cannot both claim the same next-row position.

For summaries, `delivery_cursor` is the zero-based index of the next unsent
`rows[]` item, never a chunk ordinal. Each invocation takes `rows.slice(cursor)`,
renders the largest 4,096-character group of complete rows, and on success jumps
the cursor to the next unsent row. This remains safe if message packing changes
between deployments. If rows remain, the row changes `processing -> pending`,
which queues the next invocation; otherwise it changes `processing -> sent` and
sets `processed_at`. A `resv_insert` or empty summary uses `0 -> 1 -> sent`.
Validation and Telegram failures change `processing -> failed`, leave the cursor
unchanged, set `processed_at`, and store a bounded diagnostic in `last_error`.
Advance and failure transitions are guarded by status, claimed attempt number,
and expected cursor so a late worker cannot poison a newer attempt.

## Event payloads

Payload objects are exact-key schemas. Producers must omit unused keys or use
JSON `null`; they must not put a full `row_to_json(NEW)` record in the outbox.

`resv_insert`:

```json
{
  "res_date": "2026-08-07",
  "res_time": "18:30:00",
  "branch": "DGV",
  "guests_count": 12,
  "menu_ko": "메뉴",
  "menu_vi": "Thực đơn",
  "guide_name": "Guide",
  "note": "Optional note"
}
```

`daily_summary` and `tomorrow_summary`:

```json
{
  "date": "2026-08-08",
  "rows": [
    {
      "res_time": "18:30:00",
      "branch": "DGV",
      "guests_count": 12,
      "price": 1000000,
      "menu_ko": "메뉴",
      "menu_vi": "Thực đơn",
      "guide_name": "Guide",
      "note": "Optional note"
    }
  ]
}
```

The v7 wording and line layout are retained for all three event types. Every
dynamic value is escaped before being placed in Telegram HTML. Payloads are
limited to 32 KiB and summaries to 100 rows. Messages already within 4,096 raw
HTML characters retain their exact rendered body. Only when a single reservation
or summary row would exceed that limit are fields adaptively abbreviated in this
order: note, Vietnamese menu, Korean menu, guide, then branch. Abbreviation only
affects the notification copy and never splits HTML entities or Unicode surrogate
pairs. Complete rows are packed into one or more messages; rows are never split
and the summary header is repeated in every chunk.

## Invocation contract

The deployed function name is `tg_notify_v2` and it must be deployed with JWT
verification enabled:

```toml
[functions.tg_notify_v2]
verify_jwt = true
```

The only accepted request is:

```http
POST /functions/v1/tg_notify_v2
Authorization: Bearer <project legacy anon JWT>
Content-Type: application/json

{"id":"00000000-0000-0000-0000-000000000000"}
```

The JSON object must contain exactly one property named `id`, and its value
must be a canonical UUID. `OPTIONS`, `GET`, and every other method return 405.
The function sends no `Access-Control-Allow-Origin` header, so it is not a
browser CORS endpoint.

The trigger or Cron caller may use the project's legacy anon JWT only as the
gateway credential. It must never include `SUPABASE_SERVICE_ROLE_KEY` in SQL,
Vault, or the HTTP request. Inside the Edge runtime, the automatically provided
`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` create the private database
client. The service-role key must never be returned or logged.

### Threat model

The legacy anon JWT is public. It proves only that the request belongs to this
Supabase project; it does not authorize access to outbox rows. The authorization
boundary is therefore the combination of:

1. an RLS-protected outbox with no `anon`/`authenticated` policies or grants;
2. an unguessable UUID generated inside trusted database code;
3. a request body that cannot provide an event type or Telegram payload; and
4. an atomic `pending -> processing` transition that permits one processing
   attempt for one durable delivery cursor.

A later hardening step can add a dedicated invocation secret in an HTTP header
and compare it in the Edge Function. Keep `verify_jwt = true`; do not replace
the JWT control with a browser-visible secret.

## Staging simulation

For a staging project with no Telegram token, set:

```text
TG_NOTIFY_SIMULATION=true
```

Leave `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` unset. The function still
validates, claims, renders, and advances the row to `pending` or `sent`, but it
does not call Telegram and does not log the message or payload. Multi-chunk
summaries advance through the same next-row indexes as real delivery. Never
enable simulation in production.

If simulation is false, both Telegram secrets are required. A missing secret
marks the claimed row `failed` rather than silently pretending delivery.

## Idempotency and recovery limits

Repeated or concurrent invocation of a `sent` row does not send again. A
`processing` or `failed` row is not automatically reclaimed. Operators must
inspect the Edge Function and Telegram outcome before resetting a row to
`pending`. Successfully recorded summary rows are not replayed after that reset
because retry resumes at the next unsent `rows[]` index in `delivery_cursor`.

Telegram does not accept an application idempotency key. If Telegram accepts a
message but the network response is lost, the system cannot prove whether the
external side effect occurred. A crash after Telegram accepts one message but
before its row-index update can therefore duplicate that one message on an
operator retry. Persisting the next unsent row after every message prevents
replay of earlier rows, but exactly-once delivery across that final
network/database ambiguity is not possible without storing and reconciling a
Telegram message identifier.
