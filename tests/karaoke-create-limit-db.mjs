// In-memory PostgreSQL only. No network or hosted database is used.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const { PGlite } = await import(process.env.PGLITE_MODULE ? pathToFileURL(process.env.PGLITE_MODULE).href : '@electric-sql/pglite');
const db = new PGlite();
let checks = 0;
const ok = (value, message) => { assert.ok(value, message); checks++; };
const equal = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
const rejects = async (fn, pattern) => { await assert.rejects(fn, pattern); checks++; };
const query = async (sql, values = []) => (await db.query(sql, values)).rows;
const hash = (text) => createHash('sha256').update(text).digest('hex');
const ip = 'c'.repeat(64), host = 'a'.repeat(64), guest = 'b'.repeat(64);
const room = (n) => String(800000 + n);
const ids = Array.from({ length: 33 }, () => randomUUID());
const song = { videoId: 'dQw4w9WgXcQ', title: 'Preserve current song' };
const signature = 'public.hana_karaoke_command(text,text,text,uuid,jsonb,text,boolean)';
const oldGuard = "creation_ip_hash = p_ip_hash and created_at > v_now - interval '1 hour') >= 10";
const newGuard = oldGuard.replace('>= 10', '>= 30');
async function command(action, data = {}, requestId = randomUUID(), code = room(1), address = ip) {
  return (await query('select public.hana_karaoke_command($1,$2,$3,$4,$5::jsonb,$6,false) result',
    [action, code, host, requestId, JSON.stringify(data), address]))[0].result;
}
const create = (n, address = ip) => command('create', {
  hostHash: host, joinHash: guest, topic: 'hana-karaoke:' + hash('room-topic-' + n),
}, ids[n], room(n), address);
async function rowsSnapshot() {
  const snapshot = {};
  for (const table of ['hana_karaoke_rooms', 'hana_karaoke_settings', 'hana_karaoke_search_quota', 'hana_karaoke_search_cache', 'business_fixture']) {
    snapshot[table] = await query(`select to_jsonb(t) value from public.${table} t order by to_jsonb(t)::text`);
  }
  snapshot.cron = await query('select * from cron.test_jobs order by name');
  return snapshot;
}
const functionInfo = () => query(`select proacl::text,prosecdef,proconfig,provolatile,proparallel,prokind,
  proowner::regrole::text as owner from pg_proc where oid='${signature}'::regprocedure`);
const tableSecurity = () => query(`select c.relname,c.relacl::text,c.relrowsecurity,c.relforcerowsecurity
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relkind='r' order by c.relname`);
const policies = () => query(`select schemaname,tablename,policyname,roles,cmd,qual,with_check
  from pg_policies where schemaname='public' order by tablename,policyname`);
const definition = async () => (await query(`select pg_get_functiondef('${signature}'::regprocedure) definition`))[0].definition;
try {
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    grant usage on schema public to anon,authenticated,service_role;
    create schema cron;create table cron.test_jobs(name text,schedule text,command text);
    create function cron.schedule(text,text,text) returns bigint language sql as 'insert into cron.test_jobs values($1,$2,$3) returning 1::bigint';
    create table public.business_fixture(id int primary key,amount bigint,note text);
    insert into public.business_fixture values(1,8150000,'UNCHANGED');`);
  const migrationsUrl = new URL('../supabase/migrations/', import.meta.url);
  const files = await readdir(migrationsUrl);
  const searchMigration = files.find((name) => name.endsWith('_hana_karaoke_search_priority.sql'));
  ok(Boolean(searchMigration), 'Search/priority migration exists');
  await db.exec(await readFile(new URL('20261108044359_hana_karaoke_serverless.sql', migrationsUrl), 'utf8'));
  await db.exec(await readFile(new URL(searchMigration, migrationsUrl), 'utf8'));
  await db.exec('set role service_role');
  for (let n = 1; n <= 10; n++) equal((await create(n)).state.room, room(n), `Old limit allows room ${n}`);
  await rejects(() => create(11), /KARAOKE_RATE_LIMITED/);
  equal((await query('select count(*)::int count from public.hana_karaoke_rooms'))[0].count, 10, 'Rejected eleventh room is not inserted');
  const current = randomUUID(), queued = randomUUID(), priority = randomUUID();
  await command('add', song, current);
  await command('play');
  await command('add', { ...song, title: 'Normal queued song' }, queued);
  await command('add', { ...song, title: 'Priority queued song', priority: true }, priority);
  await db.exec('reset role');
  const beforeRows = await rowsSnapshot();
  const beforeFunction = await functionInfo(), beforeTables = await tableSecurity(), beforePolicies = await policies();
  const beforeDefinition = await definition();
  equal(beforeDefinition.split(oldGuard).length - 1, 1, 'Exactly one old per-IP guard exists');
  const migration = await readFile(new URL('20261108051658_hana_karaoke_create_limit_30.sql', migrationsUrl), 'utf8');
  await db.exec(migration);
  equal(await rowsSnapshot(), beforeRows, 'Migration changes no room, configuration, quota, cache, cron, or business rows');
  equal(await functionInfo(), beforeFunction, 'Function ACL, owner, invoker security and settings unchanged');
  equal(await tableSecurity(), beforeTables, 'All table grants and RLS unchanged');
  equal(await policies(), beforePolicies, 'All policies unchanged');
  equal(await definition(), beforeDefinition.replace(oldGuard, newGuard), 'Function source changes only the expected per-IP guard');
  ok((await definition()).includes("where created_at > v_now - interval '1 hour') >= 30"), 'Global30/hour guard remains');
  ok((await definition()).includes('where not closed and expires_at > v_now) >= 50'), 'Active50-room guard remains');
  await db.exec('set role service_role');
  for (let n = 11; n <= 30; n++) equal((await create(n)).state.room, room(n), `New limit allows same-IP room ${n}`);
  equal((await query('select count(*)::int count from public.hana_karaoke_rooms'))[0].count, 30, 'Thirty same-IP rooms created');
  await rejects(() => create(31), /KARAOKE_RATE_LIMITED/);
  await rejects(() => create(32, 'f'.repeat(64)), /KARAOKE_RATE_LIMITED/);
  equal((await query('select count(*)::int count from public.hana_karaoke_rooms'))[0].count, 30, 'Same-IP and other-IP attempts cannot exceed global cap');
  const retry = await create(1);
  ok(!retry.changed && retry.state.room === room(1), 'Existing create retry succeeds at quota without creating another room');
  equal(retry.state.queue.map((item) => item.id), [priority, queued], 'Existing priority order preserved');
  ok(retry.state.current.id === current && retry.state.playing, 'Existing current song remains playing');
  const moveId = randomUUID();
  const moved = await command('prioritize', { itemId: queued }, moveId);
  equal(moved.state.queue.map((item) => item.id), [queued, priority], 'Prioritize action still works');
  ok(moved.state.current.id === current && moved.state.playing, 'Prioritize still does not interrupt current song');
  const repeated = await command('prioritize', { itemId: queued }, moveId);
  ok(!repeated.changed && repeated.state.revision === moved.state.revision, 'Priority retry remains idempotent');
  for (const role of ['anon', 'authenticated']) {
    await db.exec('reset role');
    await db.exec('set role ' + role);
    await rejects(() => query('select * from public.hana_karaoke_rooms'), /permission denied/);
    await rejects(() => create(31), /permission denied/);
  }
  await db.exec('reset role');
  const appliedDefinition = await definition();
  await rejects(() => db.exec(migration), /Expected exactly one karaoke per-IP creation limit of 10/);
  equal(await definition(), appliedDefinition, 'Fail-fast second application cannot rewrite unrelated function logic');
  equal((await query('select * from public.business_fixture'))[0], { id: 1, amount: 8150000, note: 'UNCHANGED' }, 'Business fixture untouched');
  console.log(`PASS: ${checks} isolated create-limit boundary/security/preservation assertions; no production data used.`);
} catch (error) {
  console.error('FAIL:', error.message, error.query || '');
  process.exitCode = 1;
} finally { await db.close(); }
