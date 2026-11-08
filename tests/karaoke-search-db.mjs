// Isolated in-memory PostgreSQL only; never connects to a hosted project.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const { PGlite } = await import(process.env.PGLITE_MODULE ? pathToFileURL(process.env.PGLITE_MODULE).href : '@electric-sql/pglite');
const db = new PGlite();
let checks = 0;
const ok = (condition, message) => { assert.ok(condition, message); checks++; };
const equal = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
const rejects = async (fn, pattern) => { await assert.rejects(fn, pattern); checks++; };
const host = 'a'.repeat(64), guest = 'b'.repeat(64), ip = 'c'.repeat(64), room = '765432';
const key = (value) => createHash('sha256').update(value).digest('hex');
const song = { videoId: 'dQw4w9WgXcQ', title: 'Original song' };
const found = { items: [{ ...song, channelTitle: 'Official channel', thumbnail: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/default.jpg' }], nextPageToken: null, source: 'youtube' };
async function query(sql, args = []) { return (await db.query(sql, args)).rows; }
async function call(action, data = {}, request = randomUUID(), token = host) {
  return (await query('select public.hana_karaoke_command($1,$2,$3,$4,$5::jsonb,$6,false) result',
    [action, room, token, request, JSON.stringify(data), ip]))[0].result;
}
async function acquire(cacheKey, request = randomUUID(), token = guest, enabled = true) {
  return (await query('select public.hana_karaoke_search_acquire($1,$2,$3,$4,$5) result', [room, token, request, cacheKey, enabled]))[0].result;
}
async function finish(cacheKey, lease, result = found, error = null) {
  return (await query('select public.hana_karaoke_search_finish($1,$2,$3::jsonb,$4) result', [cacheKey, lease, result === null ? null : JSON.stringify(result), error]))[0].result;
}
async function privileged(sql) { await db.exec('reset role'); await db.exec(sql); await db.exec('set role service_role'); }
async function cooldown() { await privileged(`update public.hana_karaoke_rooms set search_last_at=clock_timestamp()-interval '4 seconds',search_window_at=clock_timestamp()-interval '2 minutes',search_count=0 where room='${room}'`); }
async function quota() { return (await query('select * from public.hana_karaoke_search_quota'))[0]; }
try {
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    grant usage on schema public to anon,authenticated,service_role;
    create schema cron;create table cron.test_jobs(name text,schedule text,command text);
    create function cron.schedule(text,text,text) returns bigint language sql as 'insert into cron.test_jobs values($1,$2,$3) returning 1::bigint';
    create table public.business_fixture(id int,amount bigint);insert into public.business_fixture values(1,8150000);`);
  await db.exec(await readFile(new URL('../supabase/migrations/20261108044359_hana_karaoke_serverless.sql', import.meta.url), 'utf8'));
  await db.exec('set role service_role');
  await call('create', { hostHash: host, joinHash: guest, topic: 'hana-karaoke:' + 'd'.repeat(64) });
  const first = randomUUID(), second = randomUUID();
  await call('add', song, first, guest);
  await call('play');
  await call('add', { ...song, title: 'Second' }, second, guest);
  const before = (await query('select to_jsonb(r) row from public.hana_karaoke_rooms r'))[0].row;
  await db.exec('reset role');
  await db.exec(await readFile(new URL('../supabase/migrations/20261108050724_hana_karaoke_search_priority.sql', import.meta.url), 'utf8'));
  equal((await query('select * from public.business_fixture'))[0], { id: 1, amount: 8150000 }, 'Business data unchanged');
  const after = (await query("select to_jsonb(r)-array['search_window_at','search_count','search_last_at','search_last_request','search_last_key'] row from public.hana_karaoke_rooms r"))[0].row;
  equal(after, before, 'Migration preserves every existing room field');
  equal((await query('select * from cron.test_jobs'))[0], { name: 'hana_karaoke_retention', schedule: '17 * * * *', command: 'select public.hana_karaoke_cleanup()' }, 'Dedicated hourly cleanup job only');
  for (const role of ['anon', 'authenticated']) {
    await db.exec('set role ' + role);
    for (const table of ['hana_karaoke_search_cache', 'hana_karaoke_search_quota']) await rejects(() => query('select * from public.' + table), /permission denied/);
    await rejects(() => acquire(key('unauthorized')), /permission denied/);
    await rejects(() => finish(key('unauthorized'), randomUUID()), /permission denied/);
    await rejects(() => query('select public.hana_karaoke_cleanup()'), /permission denied/);
    await rejects(() => call('prioritize', { itemId: second }), /permission denied/);
    await db.exec('reset role');
  }
  await db.exec('set role service_role');
  let state = await call('add', { ...song, title: 'Second' }, second, guest);
  ok(!state.changed && state.state.revision === before.revision, 'Pre-upgrade add retry remains idempotent');
  const priority = randomUUID(), normal = randomUUID();
  state = await call('add', { ...song, title: 'Priority', priority: true }, priority, guest);
  equal(state.state.queue.map((item) => item.id), [priority, second], 'Priority add is next');
  ok(state.state.current.id === first && state.state.playing, 'Priority add does not interrupt current playback');
  state = await call('add', { ...song, title: 'Normal' }, normal, guest);
  equal(state.state.queue.map((item) => item.id), [priority, second, normal], 'Normal add stays FIFO');
  const moveId = randomUUID();
  state = await call('prioritize', { itemId: normal }, moveId, guest);
  equal(state.state.queue.map((item) => item.id), [normal, priority, second], 'Existing entry moves to front');
  ok(state.state.current.id === first && state.state.playing, 'Prioritize preserves current/play state');
  const revision = state.state.revision;
  state = await call('prioritize', { itemId: normal }, moveId, guest);
  ok(!state.changed && state.state.revision === revision, 'Prioritize retry no-op');
  await rejects(() => call('prioritize', { itemId: second }, moveId, guest), /KARAOKE_IDEMPOTENCY_CONFLICT/);
  await rejects(() => call('add', { ...song, priority: 'true' }), /KARAOKE_INVALID_REQUEST/);
  state = await call('prioritize', { itemId: first }, randomUUID(), guest);
  ok(!state.changed && state.state.current.id === first, 'Cannot prioritize current item into queue');
  await rejects(() => acquire(key('invalid'), randomUUID(), 'f'.repeat(64)), /KARAOKE_ROOM_NOT_FOUND/);
  ok((await quota()).calls === 0, 'Invalid capability spends no external quota');
  equal(await acquire(key('disabled'), randomUUID(), guest, false), { status: 'error', code: 'SEARCH_NOT_CONFIGURED' }, 'Missing key does not reserve quota');
  ok((await quota()).calls === 0, 'Disabled search spends no quota');
  await privileged(`update public.hana_karaoke_rooms set closed=true where room='${room}'`);
  await rejects(() => acquire(key('closed')), /KARAOKE_ROOM_CLOSED/);
  await privileged(`update public.hana_karaoke_rooms set closed=false where room='${room}'`);
  const searchKey = key('query ko first-page'), searchId = randomUUID();
  const lease = await acquire(searchKey, searchId);
  ok(lease.status === 'fetch' && typeof lease.leaseId === 'string', 'Cache miss reserves a lease');
  ok((await quota()).calls === 1, 'Exactly one reserved external call');
  equal(await acquire(searchKey, searchId), { status: 'error', code: 'SEARCH_RATE_LIMITED' }, 'Concurrent retry cannot acquire another active lease');
  ok((await quota()).calls === 1, 'Concurrent retry does not spend twice');
  await rejects(() => acquire(key('other'), searchId), /KARAOKE_IDEMPOTENCY_CONFLICT/);
  equal(await finish(searchKey, randomUUID()), { saved: false }, 'Incorrect lease cannot write cache');
  await rejects(() => finish(searchKey, lease.leaseId, { ...found, items: Array(11).fill(found.items[0]) }), /KARAOKE_INVALID_REQUEST/);
  await rejects(() => finish(searchKey, lease.leaseId, { ...found, extra: 'x'.repeat(33000) }), /KARAOKE_INVALID_REQUEST/);
  equal(await finish(searchKey, lease.leaseId), { saved: true }, 'Lease stores bounded results');
  equal(await finish(searchKey, lease.leaseId), { saved: false }, 'Lease completion is one-time');
  equal(await acquire(searchKey, searchId), { status: 'cached', result: found }, 'Same request retry returns cache');
  ok((await quota()).calls === 1, 'Cache hit does not spend external quota');
  const ttl = Number((await query('select extract(epoch from expires_at-clock_timestamp()) seconds from public.hana_karaoke_search_cache where cache_key=$1', [searchKey]))[0].seconds);
  ok(ttl <= 86400 && ttl > 86390, 'Successful cache TTL at most24h');
  await privileged(`update public.hana_karaoke_rooms set read_count=600 where room='${room}'`);
  await rejects(() => acquire(searchKey, searchId), /KARAOKE_SEARCH_RATE_LIMITED/);
  await privileged(`update public.hana_karaoke_rooms set read_count=0 where room='${room}'`);
  await rejects(() => acquire(key('too-fast')), /KARAOKE_SEARCH_RATE_LIMITED/);
  await privileged(`update public.hana_karaoke_rooms set search_count=12,search_last_at=clock_timestamp()-interval '4 seconds' where room='${room}'`);
  await rejects(() => acquire(key('over-room-count')), /KARAOKE_SEARCH_RATE_LIMITED/);
  await cooldown();
  await privileged(`update public.hana_karaoke_search_cache set expires_at=clock_timestamp()-interval '1 second' where cache_key='${searchKey}'`);
  const renewed = await acquire(searchKey, searchId);
  ok(renewed.status === 'fetch' && renewed.leaseId !== lease.leaseId, 'Expired cache requires a new reservation');
  ok((await quota()).calls === 2, 'Expired cache spends one new call');
  equal(await finish(searchKey, lease.leaseId), { saved: false }, 'Old worker cannot overwrite newer lease');
  await finish(searchKey, renewed.leaseId);
  await privileged('update public.hana_karaoke_search_quota set calls=80');
  await cooldown();
  equal(await acquire(key('over-global')), { status: 'error', code: 'SEARCH_QUOTA_EXCEEDED' }, 'Daily global cap cannot overshoot');
  await cooldown();
  equal((await acquire(searchKey)).status, 'cached', 'Cached search still works after daily external cap');
  await privileged('update public.hana_karaoke_search_quota set calls=0,provider_exhausted=false');
  await cooldown();
  const providerKey = key('provider-quota');
  const providerLease = await acquire(providerKey);
  await finish(providerKey, providerLease.leaseId, null, 'SEARCH_QUOTA_EXCEEDED');
  ok((await quota()).provider_exhausted, 'Google quota failure blocks further misses that day');
  await cooldown();
  equal(await acquire(key('provider-blocked')), { status: 'error', code: 'SEARCH_QUOTA_EXCEEDED' }, 'No request after upstream quota exhausted');
  await privileged("update public.hana_karaoke_search_quota set quota_day=quota_day-1,calls=80");
  await cooldown();
  const reset = await acquire(key('new-day'));
  ok(reset.status === 'fetch' && (await quota()).calls === 1 && !(await quota()).provider_exhausted, 'Pacific day rollover resets quota and provider block');
  const currentDay = (await query("select (clock_timestamp() at time zone 'America/Los_Angeles')::date::text as quota_day_string"))[0].quota_day_string;
  equal((await query('select quota_day::text as quota_day_string from public.hana_karaoke_search_quota'))[0].quota_day_string, currentDay, 'Quota uses Pacific calendar date');
  await privileged(`update public.hana_karaoke_search_cache set lease_quota_day=lease_quota_day-1 where cache_key='${key('new-day')}'`);
  await finish(key('new-day'), reset.leaseId, null, 'SEARCH_QUOTA_EXCEEDED');
  ok(!(await quota()).provider_exhausted, 'Prior-day late failure does not block new-day quota');
  await cooldown();
  const abandonedKey = key('abandoned');
  const abandoned = await acquire(abandonedKey);
  await privileged(`update public.hana_karaoke_search_cache set lease_until=clock_timestamp()-interval '1 second',expires_at=clock_timestamp()-interval '1 second' where cache_key='${abandonedKey}'`);
  equal(await finish(abandonedKey, abandoned.leaseId), { saved: false }, 'Expired lease cannot write');
  await cooldown();
  ok((await acquire(abandonedKey)).status === 'fetch', 'Abandoned lease can be recovered with new quota reservation');
  await privileged(`insert into public.hana_karaoke_search_cache(cache_key,lease_id,lease_quota_day,lease_until,expires_at,result)
    select md5('capacity'||i::text)||md5('capacity'||i::text),gen_random_uuid(),
      (clock_timestamp() at time zone 'America/Los_Angeles')::date,clock_timestamp()-interval '1 second',clock_timestamp()+interval '1 hour',
      '{"items":[],"nextPageToken":null,"source":"youtube"}'::jsonb
    from generate_series(1,200-(select count(*)::int from public.hana_karaoke_search_cache)) i;`);
  await cooldown();
  const beforeCapacityCalls = (await quota()).calls;
  equal(await acquire(key('over-capacity')), { status: 'error', code: 'SEARCH_RATE_LIMITED' }, 'Cache has a hard200-entry bound');
  equal((await quota()).calls, beforeCapacityCalls, 'Full cache does not waste external quota');
  equal((await query('select count(*)::int count from public.hana_karaoke_search_cache'))[0].count, 200, 'No cache row added beyond capacity');
  // Physically delete expired cache and only rooms >7days past expiry.
  const currentSnapshot = (await call('state')).state;
  await privileged(`update public.hana_karaoke_search_cache set expires_at=clock_timestamp()-interval '1 second';
    insert into public.hana_karaoke_rooms(room,create_request_id,creation_ip_hash,host_token_hash,join_token_hash,topic,created_at,expires_at)
      values('876543',gen_random_uuid(),'${ip}','${host}','${guest}','hana-karaoke:'||repeat('e',64),clock_timestamp()-interval '10 days',clock_timestamp()-interval '9 days');
    insert into public.hana_karaoke_rooms(room,create_request_id,creation_ip_hash,host_token_hash,join_token_hash,topic,created_at,expires_at,closed)
      values('987654',gen_random_uuid(),'${ip}','${host}','${guest}','hana-karaoke:'||repeat('f',64),clock_timestamp()-interval '7 days',clock_timestamp()-interval '6 days',true);`);
  await query('select public.hana_karaoke_cleanup()');
  ok((await query('select count(*)::int count from public.hana_karaoke_search_cache'))[0].count === 0, 'Expired cache physically purged without traffic');
  ok((await query('select count(*)::int count from public.hana_karaoke_rooms'))[0].count === 2, 'Old expired room purged; active and recent closed room retained');
  equal((await call('state')).state, currentSnapshot, 'Cleanup leaves active queue/current/revision untouched');
  await db.exec('reset role');
  equal((await query('select * from public.business_fixture'))[0], { id: 1, amount: 8150000 }, 'Business fixture still unchanged');
  console.log(`PASS: ${checks} isolated search/priority/upgrade/retention PostgreSQL assertions; no production data used.`);
} catch (error) {
  console.error('FAIL:', error.message, error.query || '');
  process.exitCode = 1;
} finally { await db.close(); }
