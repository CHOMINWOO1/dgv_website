import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// No credentials, Docker, network or persistent database. This exercises actual
// PostgreSQL RLS and constraints, but not the separate Supabase Storage HTTP API.
// Optional external test dependency: install @electric-sql/pglite, or point
// PGLITE_MODULE at its local ESM entry. No repository dependency changes needed.
let PGlite;
try {
  ({ PGlite } = await import(process.env.PGLITE_MODULE
    ? pathToFileURL(process.env.PGLITE_MODULE).href
    : '@electric-sql/pglite'));
} catch (cause) {
  throw new Error('Database regression needs optional @electric-sql/pglite. Install it in a test environment or set PGLITE_MODULE to its local package/dist/index.js.', { cause });
}
const migration = await readFile(new URL('../supabase/migrations/20261124102337_order_card_receipt_photos.sql', import.meta.url), 'utf8');
assert.doesNotMatch(migration, /security\s+definer|create\s+(?:or\s+replace\s+)?(?:function|view|materialized\s+view)\b/i);
assert.doesNotMatch(migration, /(?:sb_secret_|sb_publishable_|eyJ[a-zA-Z0-9_-]{15,}\.)/);

const db = new PGlite();
let checks = 0;
const id = value => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const receiptPath = (order, file = order + 1000) => `${id(order)}/${id(file)}.jpg`;
const bucket = 'order-card-receipts';
const userId = id(9000);
const check = (condition, message) => { assert.ok(condition, message); checks += 1; };
const equal = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks += 1; };
const one = async (sql, parameters = []) => (await db.query(sql, parameters)).rows[0];
const snapshotOrders = async () => (await db.query('select to_jsonb(o) as row from public.orders o order by id')).rows;

async function asRole(appRole, run, { postgresRole = 'authenticated', uid = userId, userMetadata = {} } = {}) {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({
    ...(uid ? { sub: uid } : {}),
    app_metadata: appRole ? { role: appRole } : {},
    user_metadata: userMetadata,
  })]);
  await db.exec(`set role ${postgresRole}`);
  try { return await run(); } finally { await db.exec('reset role'); }
}

async function denied(run, label, code = '42501') {
  await assert.rejects(run, error => error.code === code, label);
  checks += 1;
}

const upload = (order, file = order + 1000, metadata = { mimetype: 'image/jpeg', size: 100 }, objectPath = receiptPath(order, file), objectBucket = bucket) =>
  db.query('insert into storage.objects(bucket_id, name, metadata) values ($1, $2, $3::jsonb) returning name', [objectBucket, objectPath, JSON.stringify(metadata)]);
const attach = (order, file = order + 1000, bytes = 100, mime = 'image/jpeg', objectPath = receiptPath(order, file)) =>
  db.query('insert into public.order_card_receipts(order_id, storage_path, byte_size, mime_type) values ($1, $2, $3, $4) returning *', [id(order), objectPath, bytes, mime]);
const count = async (table, where = '', parameters = []) => Number((await one(`select count(*) as count from ${table} ${where}`, parameters)).count);
const deleteObject = objectPath => db.query('delete from storage.objects where bucket_id = $1 and name = $2 returning name', [bucket, objectPath]);

try {
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create schema auth;
    create schema storage;
    create function auth.jwt() returns jsonb language sql stable security invoker set search_path = '' as $$
      select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
    $$;
    create function auth.uid() returns uuid language sql stable security invoker set search_path = '' as $$
      select nullif((select auth.jwt())->>'sub', '')::uuid
    $$;
    create function public.current_app_role() returns text language sql stable security invoker set search_path = '' as $$
      select case when (select auth.jwt())->'app_metadata'->>'role' in ('staff','manager','admin')
        then (select auth.jwt())->'app_metadata'->>'role' else null end
    $$;
    grant usage on schema public, auth, storage to anon, authenticated;
    grant execute on function auth.jwt(), auth.uid(), public.current_app_role() to anon, authenticated;
    create table public.orders (
      id uuid primary key,
      payment_method text not null,
      status text not null,
      sales_excluded boolean not null default false,
      total_usd integer not null,
      total_vnd integer not null,
      created_at timestamptz not null default '2026-11-24T00:00:00Z'
    );
    grant select, insert, update, delete on public.orders to authenticated;
    alter table public.orders enable row level security;
    create policy orders_admin on public.orders for all to authenticated
      using ((select public.current_app_role()) = 'admin')
      with check ((select public.current_app_role()) = 'admin');
    create policy orders_manager on public.orders for all to authenticated
      using ((select public.current_app_role()) = 'manager' and sales_excluded is false)
      with check ((select public.current_app_role()) = 'manager' and sales_excluded is false);
    create table storage.buckets (
      id text primary key, name text not null, public boolean not null default false,
      file_size_limit bigint, allowed_mime_types text[]
    );
    create table storage.objects (
      id uuid primary key default gen_random_uuid(),
      bucket_id text not null references storage.buckets(id),
      name text not null, metadata jsonb, unique(bucket_id, name)
    );
    alter table storage.objects enable row level security;
    alter table storage.buckets enable row level security;
    -- Stock Storage grants are broad table privileges; RLS restricts rows.
    -- https://github.com/supabase/storage/blob/master/migrations/tenant/0002-storage-schema.sql
    grant all on storage.objects, storage.buckets to anon, authenticated;
    insert into storage.buckets(id, name) values ('unrelated-private', 'unrelated-private');
    -- Some Supabase creators still have broad historical default ACLs. The
    -- receipt migration must revoke inherited privileges before its CRUD grant.
    alter default privileges in schema public grant all on tables to anon, authenticated;
  `);
  for (const [order, method, status, excluded] of [
    [1, 'card', 'paid', false], [2, 'cash', 'paid', false],
    [3, 'bank', 'paid', false], [4, 'card', 'pending', false],
    [5, 'card', 'paid', true], [6, 'card', 'paid', false],
    [7, 'card', 'paid', false], [8, 'card', 'paid', false],
    [9, 'card', 'paid', false], [10, 'card', 'paid', false],
    [11, 'card', 'paid', false], [12, 'card', 'paid', false],
  ]) await db.query('insert into public.orders(id, payment_method, status, sales_excluded, total_usd, total_vnd) values ($1,$2,$3,$4,$5,$6)', [id(order), method, status, excluded, order * 7, order * 7000]);

  const beforeMigration = await snapshotOrders();
  const functionsBefore = (await db.query("select oid from pg_proc where pronamespace in ('public'::regnamespace, 'auth'::regnamespace, 'storage'::regnamespace) order by oid")).rows;
  await db.exec(migration);
  equal(await snapshotOrders(), beforeMigration, 'migration must not modify existing orders, totals, timestamps or exclusion bits');
  equal((await db.query("select oid from pg_proc where pronamespace in ('public'::regnamespace, 'auth'::regnamespace, 'storage'::regnamespace) order by oid")).rows, functionsBefore, 'migration must not add or replace functions');
  equal(await count('pg_views', "where schemaname in ('public','auth','storage')"), 0, 'migration must not add views');
  equal(await one('select public, file_size_limit::int, allowed_mime_types from storage.buckets where id = $1', [bucket]), { public: false, file_size_limit: 2097152, allowed_mime_types: ['image/jpeg'] }, 'private bucket must enforce JPEG and 2 MiB at the Storage API boundary');
  equal(await one("select has_table_privilege('authenticated','storage.objects','select') as can_select"), { can_select: true }, 'metadata policy subquery has the standard authenticated storage SELECT grant');
  equal(await one("select relrowsecurity as enabled from pg_class where oid = 'public.order_card_receipts'::regclass"), { enabled: true }, 'receipt metadata RLS must be enabled');
  for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
    equal((await one('select has_table_privilege($1, $2, $3) as granted', ['anon', 'public.order_card_receipts', privilege])).granted, false, `anon must not inherit ${privilege} on metadata`);
    equal((await one('select has_table_privilege($1, $2, $3) as granted', ['authenticated', 'public.order_card_receipts', privilege])).granted, ['SELECT', 'INSERT', 'UPDATE', 'DELETE'].includes(privilege), `authenticated metadata ${privilege} must match explicit CRUD-only grant`);
  }
  if (Number((await one("select current_setting('server_version_num') as version")).version) >= 170000) {
    for (const role of ['anon', 'authenticated']) equal((await one('select has_table_privilege($1, $2, $3) as granted', [role, 'public.order_card_receipts', 'MAINTAIN'])).granted, false, `${role} must not inherit MAINTAIN`);
  }
  await db.exec('set enable_seqscan = off');
  const lookupPlan = await db.query(`explain (format json) select 1 from public.orders o where o.id = case
    when split_part($1, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then split_part($1, '/', 1)::uuid else null end`, [receiptPath(1)]);
  check(JSON.stringify(lookupPlan.rows).includes('orders_pkey'), 'storage folder order lookup must be able to use the existing UUID primary-key index');
  await db.exec('reset enable_seqscan');
  assert.doesNotMatch(migration, /o\.id::text/);
  await denied(() => attach(11, 1011, 0), 'zero byte size is constrained even for table owner', '23514');
  await denied(() => attach(11, 1011, 2097153), 'over 2 MiB is constrained even for table owner', '23514');
  await denied(() => attach(11, 1011, 100, 'image/png'), 'non-JPEG MIME is constrained even for table owner', '23514');

  await asRole('manager', async () => {
    equal((await upload(1)).rows.length, 1, 'manager can upload for an eligible paid card order');
    equal((await attach(1)).rows.length, 1, 'manager can attach matching uploaded JPEG');
    equal(await count('public.order_card_receipts'), 1, 'manager can read attachment metadata');
    equal(await count('storage.objects'), 1, 'manager can read private receipt object');
  });
  await asRole('admin', async () => {
    equal((await upload(6)).rows.length, 1, 'admin can upload for eligible order');
    equal((await attach(6)).rows.length, 1, 'admin can attach for eligible order');
    equal(await count('public.order_card_receipts'), 2, 'admin can read eligible receipt metadata');
  });

  await asRole(null, async () => {
    await denied(() => db.query('select * from public.order_card_receipts'), 'anon cannot read receipt metadata');
    await denied(() => attach(7), 'anon cannot insert receipt metadata');
    await denied(() => db.query('update public.order_card_receipts set byte_size = 100'), 'anon cannot update receipt metadata');
    await denied(() => db.query('delete from public.order_card_receipts'), 'anon cannot delete receipt metadata');
    equal(await count('storage.objects'), 0, 'anon cannot read private photos');
    await denied(() => upload(7), 'anon cannot upload');
    equal((await deleteObject(receiptPath(1))).rows.length, 0, 'anon cannot delete photos');
  }, { postgresRole: 'anon', uid: null });

  for (const [role, options] of [
    ['staff', {}], [null, { userMetadata: { role: 'admin' } }],
    ['manager', { uid: null }], ['admin', { uid: null }],
  ]) await asRole(role, async () => {
    equal(await count('public.order_card_receipts'), 0, `${role || 'user_metadata admin'} cannot read receipt metadata without authorized app role and uid`);
    equal(await count('storage.objects'), 0, `${role || 'user_metadata admin'} cannot read private photos without authorized app role and uid`);
    await denied(() => attach(7), 'unauthorized user cannot insert metadata');
    await denied(() => upload(7), 'unauthorized user cannot upload photos');
    equal((await db.query('update public.order_card_receipts set byte_size = 100 returning order_id')).rows.length, 0, 'unauthorized user cannot update metadata');
    equal((await db.query('delete from public.order_card_receipts returning order_id')).rows.length, 0, 'unauthorized user cannot delete metadata');
    equal((await deleteObject(receiptPath(1))).rows.length, 0, 'unauthorized user cannot delete photos');
  }, options);

  // Owner-only fixtures show row visibility independently from upload denial.
  for (const order of [2, 3, 4, 5]) {
    await upload(order);
    await attach(order);
  }
  await upload(99); // missing order, no FK on the object folder
  await upload(1, 1099, { mimetype: 'image/jpeg', size: 100 }, receiptPath(1, 1099), 'unrelated-private');
  await upload(7, 777, {}, 'invalid-uuid/photo.jpg');
  await upload(7, 778, {}, 'also-invalid/photo.jpg', 'unrelated-private');
  for (const role of ['manager', 'admin']) await asRole(role, async () => {
    for (const order of [2, 3, 4, 5, 99]) {
      await denied(() => upload(order, order + 2000), `${role} cannot upload for ineligible or missing order ${order}`);
      await denied(() => attach(order, order + 2000), `${role} cannot attach for ineligible or missing order ${order}`);
      equal(await count('storage.objects', 'where name = $1', [receiptPath(order)]), 0, 'ineligible photos remain private even to an administrator');
      equal((await deleteObject(receiptPath(order))).rows.length, 0, 'ineligible photo cannot be deleted through manager/admin receipt policy');
      equal((await db.query('update public.order_card_receipts set byte_size = 100 where order_id = $1 returning order_id', [id(order)])).rows.length, 0, 'ineligible receipt cannot be updated');
      equal((await db.query('delete from public.order_card_receipts where order_id = $1 returning order_id', [id(order)])).rows.length, 0, 'ineligible receipt cannot be deleted');
    }
    equal(await count('public.order_card_receipts'), 2, 'only eligible receipt metadata is visible');
    equal(await count('storage.objects'), 2, 'only eligible receipt objects are visible, not unrelated buckets');
    equal((await deleteObject('invalid-uuid/photo.jpg')).rows.length, 0, 'malformed pre-existing folder must fail closed without UUID cast errors');
    for (const badPath of ['not-a-uuid/photo.jpg', `${id(7)}/../${id(777)}.jpg`, `${id(7)}/${id(777)}.png`, `${id(7)}/${id(777)}.jpg/extra`]) {
      await denied(() => upload(7, 777, { mimetype: 'image/jpeg', size: 100 }, badPath), 'malformed or non-JPEG object path is rejected');
    }
    await denied(() => upload(7, 777, { mimetype: 'image/jpeg', size: 100 }, receiptPath(7, 777), 'unrelated-private'), 'receipt policy cannot write unrelated bucket');
  });

  await asRole('manager', async () => {
    await denied(() => attach(7), 'metadata cannot precede uploaded object');
    await upload(7);
    await denied(() => attach(7, 1007, 99), 'metadata byte size must equal actual stored object metadata');
    await denied(() => attach(7, 1007, 100, 'image/png'), 'metadata MIME type cannot be PNG');
    await denied(() => attach(7, 1007, 0), 'zero-byte metadata is rejected');
    await denied(() => attach(7, 1007, 2097153), 'oversize metadata is rejected');
    await denied(() => attach(7, 1007, 100, 'image/jpeg', receiptPath(1)), 'metadata path must correspond to the same order', '23514');
    await upload(8, 1008, { mimetype: 'image/png', size: 100 });
    await denied(() => attach(8), 'metadata cannot claim JPEG when uploaded object has PNG MIME');
    await upload(9, 1009, { mimetype: 'image/jpeg', size: 101 });
    await denied(() => attach(9), 'metadata cannot claim a different uploaded size');
    await upload(10, 1010, {});
    await denied(() => attach(10), 'missing uploaded object metadata must fail closed');
    equal((await attach(7)).rows.length, 1, 'valid uploaded JPEG metadata succeeds');
    await denied(() => attach(7), 'one photo row per order is enforced', '23505');

    equal((await db.query('update storage.objects set metadata = $1::jsonb where name = $2 returning name', [JSON.stringify({ mimetype: 'image/jpeg', size: 101 }), receiptPath(7)])).rows.length, 0, 'storage UPDATE is denied despite broad standard table grants');
    await denied(() => db.query('insert into storage.objects(bucket_id,name,metadata) values ($1,$2,$3::jsonb) on conflict(bucket_id,name) do update set metadata = excluded.metadata', [bucket, receiptPath(7), JSON.stringify({ mimetype: 'image/jpeg', size: 101 })]), 'storage upsert cannot overwrite an active photo');
    equal((await deleteObject(receiptPath(7))).rows.length, 0, 'active photo cannot be removed');

    const replacement = receiptPath(7, 7007);
    await upload(7, 7007);
    equal((await deleteObject(replacement)).rows.length, 1, 'failed upload cleanup may remove an unreferenced object');
    await upload(7, 7007);
    await denied(() => db.query('update public.order_card_receipts set storage_path = $1, byte_size = 99 where order_id = $2', [replacement, id(7)]), 'replacement metadata must still match new uploaded bytes');
    equal((await deleteObject(receiptPath(7))).rows.length, 0, 'failed replacement preserves active old photo');
    equal((await db.query('update public.order_card_receipts set storage_path = $1, byte_size = 100, updated_at = now() where order_id = $2 returning storage_path', [replacement, id(7)])).rows, [{ storage_path: replacement }], 'replacement swaps metadata to a new immutable path');
    equal((await db.query('update public.order_card_receipts set storage_path = $1 where order_id = $2 and storage_path = $3 returning storage_path', [receiptPath(7), id(7), receiptPath(7)])).rows.length, 0, 'stale compare-and-swap replacement cannot overwrite the current attachment');
    equal((await db.query('delete from public.order_card_receipts where order_id = $1 and storage_path = $2 returning order_id', [id(7), receiptPath(7)])).rows.length, 0, 'stale conditional deletion cannot remove the current attachment');
    equal((await deleteObject(replacement)).rows.length, 0, 'ambiguous-success cleanup cannot remove active replacement');
    equal((await deleteObject(receiptPath(7))).rows.length, 1, 'old file can be cleaned up after metadata replacement');
    equal((await db.query('delete from public.order_card_receipts where order_id = $1 returning order_id', [id(7)])).rows.length, 1, 'authorized user can remove attachment metadata');
    equal((await deleteObject(replacement)).rows.length, 1, 'photo can be removed only after its metadata is deleted');
  });
  equal(await snapshotOrders(), beforeMigration, 'all attachment operations must leave every order field and total untouched');

  for (const [role, order] of [['manager', 11], ['admin', 12]]) await asRole(role, async () => {
    await upload(order); await attach(order);
    equal((await db.query('delete from public.orders where id = $1 returning id', [id(order)])).rows.length, 1, 'receipt FK must not prevent authorized order deletion');
  });
  equal(await count('public.order_card_receipts', 'where order_id = any($1::uuid[])', [[id(11), id(12)]]), 0, 'ON DELETE CASCADE removes receipt metadata');
  equal(await count('storage.objects', 'where name = any($1::text[])', [[receiptPath(11), receiptPath(12)]]), 2, 'order deletion does not mutate Storage object rows; physical orphan cleanup is separate');
  check(!migration.toLowerCase().includes('alter table public.orders'), 'migration must not alter existing order schema');
  console.log(`Card receipt database regression passed: ${checks} checks (actual PostgreSQL migration/RLS, anon/staff deny, manager/admin eligibility, object-match validation, private reads, immutable storage, safe replacement/cleanup, order preservation and FK cascade).`);
} finally {
  await db.close();
}
