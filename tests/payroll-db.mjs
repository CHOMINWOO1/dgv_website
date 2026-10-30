import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// No production credentials or external database are used by this test.
// Install @electric-sql/pglite@0.3.14 in the repo or set PAYROLL_TEST_MODULES
// to a node_modules folder containing that package.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const moduleRoot = process.env.PAYROLL_TEST_MODULES || path.resolve(root, "node_modules");
const { PGlite } = await import(pathToFileURL(path.join(moduleRoot, "@electric-sql/pglite/dist/index.js")));
const db = new PGlite();

try {
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema auth;
    grant usage on schema public, auth to anon, authenticated, service_role;
    create function auth.jwt() returns jsonb language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
    $$;
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(auth.jwt()->>'sub', '')::uuid
    $$;
    create function public.has_app_role(allowed_roles text[]) returns boolean
      language sql stable security invoker set search_path = '' as $$
      select coalesce((auth.jwt()->'app_metadata'->>'role') = any(allowed_roles), false)
    $$;
    create schema storage;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,metadata jsonb);
    alter table storage.objects enable row level security;
    grant usage on schema storage to authenticated;
    grant select,insert on storage.objects to authenticated;
    -- Vault is stubbed only to test the app's access checks and immutable version
    -- references. This harness does not verify Supabase Vault's encryption.
    create schema vault;
    select set_config('app.payroll_test_vault_stub','true',false);
    create table vault.test_secrets(id uuid primary key default gen_random_uuid(),secret text,name text,description text);
    create view vault.secrets as select * from vault.test_secrets;
    create view vault.decrypted_secrets as select id,secret as decrypted_secret from vault.test_secrets;
    create function vault.create_secret(new_secret text,new_name text default null,new_description text default null,new_key_id uuid default null)
      returns uuid language plpgsql as $$
      declare result uuid;
      begin insert into vault.test_secrets(secret,name,description) values(new_secret,new_name,new_description) returning id into result;return result;end;
    $$;
  `);
  const migrations = process.env.PAYROLL_MIGRATION_FILE ? [process.env.PAYROLL_MIGRATION_FILE] : (await readdir(path.join(root, "supabase/migrations")))
    .filter(name => name.includes("payroll") && name.endsWith(".sql")).sort()
    .map(name => path.join(root, "supabase/migrations", name));
  if (process.env.PAYROLL_EXTRA_MIGRATION_FILE) migrations.push(process.env.PAYROLL_EXTRA_MIGRATION_FILE);
  assert.ok(migrations.length, "payroll migration is required");
  for (const file of migrations) {
    await db.exec(await readFile(file, "utf8"));
  }
  const { rows: tables } = await db.query(`
    select relname, relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and relkind='r' and relname like 'payroll_%'
  `);
  assert.ok(tables.length >= 8, "payroll storage must be created");
  assert.ok(tables.every(table => table.relrowsecurity), "every payroll table needs RLS");
  if (!process.argv.includes("--migration-only")) {
    await db.exec(await readFile(path.join(root, "supabase/tests/payroll.sql"), "utf8"));
    const additionalTests=(await readdir(path.join(root,"supabase/tests"))).filter(name=>name.startsWith("payroll-")&&name.endsWith(".sql")).sort();
    for(const file of additionalTests)await db.exec(await readFile(path.join(root,"supabase/tests",file),"utf8"));
  }
  console.log(`Payroll ${process.argv.includes("--migration-only") ? "migration smoke" : "DB regression"} passed in isolated PostgreSQL (${tables.length} tables, ${migrations.length} migrations).`);
} finally {
  await db.close();
}
