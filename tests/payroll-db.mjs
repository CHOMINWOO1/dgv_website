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
  `);
  const migrations = process.env.PAYROLL_MIGRATION_FILE ? [process.env.PAYROLL_MIGRATION_FILE] : (await readdir(path.join(root, "supabase/migrations")))
    .filter(name => name.includes("payroll") && name.endsWith(".sql")).sort()
    .map(name => path.join(root, "supabase/migrations", name));
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
  }
  console.log(`Payroll ${process.argv.includes("--migration-only") ? "migration smoke" : "DB regression"} passed in isolated PostgreSQL (${tables.length} tables, ${migrations.length} migrations).`);
} finally {
  await db.close();
}
