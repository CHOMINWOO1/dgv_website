import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const { PGlite } = await import(process.env.PGLITE_MODULE ? pathToFileURL(process.env.PGLITE_MODULE).href : '@electric-sql/pglite');
const db = new PGlite();
let checks = 0;
const ok = (condition, message) => { assert.ok(condition, message); checks++; };
const host = 'a'.repeat(64), guest = 'b'.repeat(64), ip = 'c'.repeat(64);
const room = '765432', creation = randomUUID();
const createData = { hostHash: host, joinHash: guest, topic: 'hana-karaoke:' + 'd'.repeat(64) };
async function call(action, data = {}, token = host, request = randomUUID(), roomCode = room, staff = false) {
  const { rows } = await db.query('select public.hana_karaoke_command($1,$2,$3,$4,$5::jsonb,$6,$7) result',
    [action, roomCode, token, request, JSON.stringify(data), ip, staff]);
  return rows[0].result;
}
async function rejects(fn, expected) { await assert.rejects(fn, expected); checks++; }
async function privileged(sql) { await db.exec('reset role'); await db.exec(sql); await db.exec('set role service_role'); }
try {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    grant usage on schema public to anon,authenticated,service_role;
    create table public.existing_business_fixture(id integer primary key, amount bigint, note text);
    insert into public.existing_business_fixture values(1,8150000,'MUST STAY UNCHANGED');`);
  const before = await db.query('select * from public.existing_business_fixture');
  const schema = await readFile(new URL('../supabase/migrations/20261108044359_hana_karaoke_serverless.sql', import.meta.url), 'utf8');
  ok(schema.length > 1000, 'Migration must not be empty');
  await db.exec(schema);
  const after = await db.query('select * from public.existing_business_fixture');
  assert.deepEqual(after.rows, before.rows); checks++;
  for (const role of ['anon','authenticated']) {
    await db.exec('set role ' + role);
    await rejects(() => db.query('select * from public.hana_karaoke_rooms'), /permission denied/);
    await rejects(() => db.query('select * from public.hana_karaoke_settings'), /permission denied/);
    await rejects(() => call('create',createData,host,creation), /permission denied/);
    await db.exec('reset role');
  }
  await db.exec('set role service_role');
  let result = await call('create',createData,host,creation);
  ok(result.state.room === room && result.state.queue.length === 0, 'Room creation');
  ok(!JSON.stringify(result).includes(host) && !JSON.stringify(result).includes(guest), 'No capability hash leakage');
  let retry = await call('create',createData,host,creation);
  ok(retry.state.room === room && retry.changed === false, 'Create idempotency');
  await rejects(() => call('state',{},'f'.repeat(64)), /KARAOKE_ROOM_NOT_FOUND/);
  await rejects(() => call('state',{},guest,randomUUID(),'987654'), /KARAOKE_ROOM_NOT_FOUND/);
  await rejects(() => call('close',{},guest), /KARAOKE_HOST_REQUIRED/);
  await rejects(() => call('ended',{expectedCurrentId:null},guest), /KARAOKE_HOST_REQUIRED/);
  await rejects(() => call('add',{videoId:'invalid',title:'Invalid'},guest), /KARAOKE_INVALID_REQUEST/);
  const first = randomUUID(), second = randomUUID();
  const song = {videoId:'dQw4w9WgXcQ',title:'동일 영상 / Cùng video'};
  result = await call('add',song,guest,first);
  ok(result.state.queue.length === 1, 'Guest can reserve song');
  retry = await call('add',song,guest,first);
  ok(retry.state.queue.length === 1 && !retry.changed, 'Add retry does not duplicate');
  await rejects(() => call('add',{...song,title:'Changed'},guest,first), /KARAOKE_IDEMPOTENCY_CONFLICT/);
  result = await call('add',song,guest,second);
  ok(result.state.queue.length === 2 && result.state.queue[0].id !== result.state.queue[1].id, 'Repeated videos have unique queue identities');
  result = await call('down',{itemId:first},guest);
  ok(result.state.queue[0].id === second, 'Queue move down');
  result = await call('up',{itemId:first},guest);
  ok(result.state.queue[0].id === first, 'Queue move up');
  result = await call('next',{expectedCurrentId:null},guest);
  ok(result.state.current.id === first && result.state.playing, 'First song starts');
  result = await call('next',{expectedCurrentId:null},guest);
  ok(result.state.current.id === first && !result.changed, 'Stale next cannot skip song');
  result = await call('pause',{},guest);
  ok(!result.state.playing, 'Pause');
  result = await call('play',{},guest);
  ok(result.state.playing, 'Play');
  result = await call('ended',{expectedCurrentId:first});
  ok(result.state.current.id === second && result.state.playing, 'Ended advances repeated video once');
  result = await call('ended',{expectedCurrentId:first});
  ok(result.state.current.id === second && !result.changed, 'Duplicate ended cannot skip twice');
  await privileged(`update public.hana_karaoke_rooms set request_log='[]' where room='${room}'`);
  result = await call('add',song,guest,second);
  ok(result.state.queue.length === 0 && result.state.current.id === second, 'Evicted retry does not duplicate current item');
  await rejects(() => call('add',{...song,title:'Wrong'},guest,second), /KARAOKE_IDEMPOTENCY_CONFLICT/);
  result = await call('ended',{expectedCurrentId:second});
  ok(result.state.current === null && !result.state.playing, 'Empty queue stops');
  await privileged(`update public.hana_karaoke_rooms set mutation_count=30,mutation_window_at=clock_timestamp() where room='${room}'`);
  await rejects(() => call('add',song,guest), /KARAOKE_RATE_LIMITED/);
  await privileged(`update public.hana_karaoke_rooms set mutation_count=0,read_count=600,read_window_at=clock_timestamp() where room='${room}'`);
  await rejects(() => call('state'), /KARAOKE_RATE_LIMITED/);
  await privileged(`update public.hana_karaoke_rooms set read_count=0 where room='${room}';update public.hana_karaoke_settings set require_staff_to_create=true`);
  await rejects(() => call('create',{...createData,topic:'hana-karaoke:'+'e'.repeat(64)},host,randomUUID(),'876543'), /KARAOKE_STAFF_REQUIRED/);
  result = await call('create',{...createData,topic:'hana-karaoke:'+'e'.repeat(64)},host,randomUUID(),'876543',true);
  ok(result.state.room === '876543', 'Future authenticated creation switch');
  await privileged('update public.hana_karaoke_settings set require_staff_to_create=false');
  result = await call('close');
  ok(result.state.closed && !result.state.playing, 'Owner closes room');
  result = await call('state',{},guest);
  ok(result.state.closed, 'Guest sees closure');
  await rejects(() => call('add',song,guest), /KARAOKE_ROOM_CLOSED/);
  await privileged(`update public.hana_karaoke_rooms set created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 day' where room='${room}'`);
  await rejects(() => call('state'), /KARAOKE_ROOM_EXPIRED/);
  await db.exec('reset role');
  assert.deepEqual((await db.query('select * from public.existing_business_fixture')).rows,before.rows); checks++;
  console.log(`PASS: ${checks} isolated PostgreSQL assertions; no production data used.`);
} finally { await db.close(); }
