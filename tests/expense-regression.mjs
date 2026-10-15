import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migration = await readFile(
  path.join(projectRoot, "supabase/migrations/20261015113201_restaurant_expenses.sql"),
  "utf8",
);
const page = await readFile(path.join(projectRoot, "expense.html"), "utf8");

// The ledger is a new, isolated table and deployment itself never mutates any
// current business row.
assert.match(migration, /create table public\.restaurant_expenses\s*\(/i);
assert.doesNotMatch(
  migration,
  /^\s*(?:insert\s+into|update|delete\s+from|truncate)\s+(?!public\.restaurant_expenses\b)/im,
  "the additive migration must not mutate an existing table",
);

// Required business and immutable audit/import fields are present.
for (const column of [
  /expense_date date not null/i,
  /expense_type text not null/i,
  /amount_vnd bigint not null/i,
  /description text not null/i,
  /note text/i,
  /source text not null default 'web'/i,
  /import_key text/i,
  /created_by uuid default auth\.uid\(\)/i,
  /created_at timestamp with time zone not null default now\(\)/i,
]) {
  assert.match(migration, column);
}

assert.match(migration, /expense_type in \('invoice', 'general'\)/i);
assert.match(migration, /amount_vnd > 0/i);
assert.match(migration, /length\(btrim\(description\)\) between 1 and 500/i);
assert.match(migration, /source in \('web', 'xlsx_import'\)/i);
assert.match(
  migration,
  /source = 'web' and import_key is null[\s\S]*?source = 'xlsx_import'[\s\S]*?import_key is not null/i,
);

// Monthly reads have a range-friendly index, while a stable partial unique key
// makes future XLSX imports safely retryable without duplicating rows.
assert.match(
  migration,
  /create index restaurant_expenses_date_created_idx[\s\S]*?\(expense_date desc, created_at desc\)/i,
);
assert.match(
  migration,
  /create index restaurant_expenses_created_by_idx[\s\S]*?\(created_by\)[\s\S]*?where created_by is not null/i,
);
assert.match(
  migration,
  /create unique index restaurant_expenses_import_key_unique_idx[\s\S]*?\(import_key\)[\s\S]*?where import_key is not null/i,
);

// Exposed public-schema data is protected by app_metadata-backed RLS. Staff
// and admin may append; only admin may read; no browser update/delete exists.
assert.match(migration, /alter table public\.restaurant_expenses enable row level security/i);
assert.match(
  migration,
  /create policy restaurant_expenses_admin_read[\s\S]*?for select[\s\S]*?to authenticated[\s\S]*?has_app_role\(array\['admin'\]::text\[\]\)/i,
);
assert.match(
  migration,
  /create policy restaurant_expenses_staff_insert[\s\S]*?for insert[\s\S]*?to authenticated[\s\S]*?auth\.uid\(\)[\s\S]*?has_app_role\(array\['staff', 'admin'\]::text\[\]\)[\s\S]*?source = 'web'[\s\S]*?import_key is null[\s\S]*?created_by = \(select auth\.uid\(\)\)/i,
);
assert.doesNotMatch(
  migration,
  /create policy\s+\S+[\s\S]*?on public\.restaurant_expenses[\s\S]*?for (?:update|delete)\b/i,
);
assert.doesNotMatch(migration, /user_metadata/i);

// Grants are an independent security layer: the browser can read only fields
// required by the page and insert only the five business fields. Import/audit
// fields require service_role.
assert.match(
  migration,
  /revoke all on table public\.restaurant_expenses[\s\S]*?from public, anon, authenticated, service_role/i,
);
const authenticatedSelectGrant = migration.match(
  /grant select \([\s\S]*?\) on table public\.restaurant_expenses\s+to authenticated/i,
)?.[0];
assert.ok(authenticatedSelectGrant, "authenticated column-level SELECT grant is missing");
for (const readableColumn of [
  "id",
  "expense_date",
  "expense_type",
  "amount_vnd",
  "description",
  "note",
  "created_at",
]) {
  assert.match(authenticatedSelectGrant, new RegExp(`\\b${readableColumn}\\b`, "i"));
}
for (const protectedColumn of ["source", "import_key", "created_by"]) {
  assert.doesNotMatch(authenticatedSelectGrant, new RegExp(`\\b${protectedColumn}\\b`, "i"));
}
const authenticatedInsertGrant = migration.match(
  /grant insert \([\s\S]*?\) on table public\.restaurant_expenses\s+to authenticated/i,
)?.[0];
assert.ok(authenticatedInsertGrant, "authenticated column-level INSERT grant is missing");
for (const businessColumn of ["expense_date", "expense_type", "amount_vnd", "description", "note"]) {
  assert.match(authenticatedInsertGrant, new RegExp(`\\b${businessColumn}\\b`, "i"));
}
for (const protectedColumn of ["id", "source", "import_key", "created_by", "created_at"]) {
  assert.doesNotMatch(authenticatedInsertGrant, new RegExp(`\\b${protectedColumn}\\b`, "i"));
}
assert.doesNotMatch(
  migration,
  /grant\s+(?:[^;]*?\b(?:update|delete)\b[^;]*?)\s+on table public\.restaurant_expenses\s+to authenticated/i,
);
assert.doesNotMatch(
  migration,
  /grant\s+[^;]*?on table public\.restaurant_expenses\s+to anon/i,
);
assert.match(
  migration,
  /grant select, insert, update, delete on table public\.restaurant_expenses\s+to service_role/i,
);

// The page keeps input simple, writes only business fields, paginates monthly
// reads, and reveals the financial ledger only after an admin login.
assert.match(page, /<input[^>]+id="expenseDate"[^>]+type="date"/i);
assert.match(page, /name="expenseType" value="general"/i);
assert.match(page, /name="expenseType" value="invoice"/i);
assert.match(page, /id="amountVnd"[^>]+inputmode="numeric"/i);
assert.match(page, /\.from\("restaurant_expenses"\)\.insert\(\[\{/i);
for (const field of ["expense_date", "expense_type", "amount_vnd", "description", "note"]) {
  assert.match(page, new RegExp(`\\b${field}\\b`));
}
assert.doesNotMatch(page, /\.from\("restaurant_expenses"\)\.(?:update|delete)\(/i);
assert.match(page, /DGV\.collectSupabasePages\(/i);
assert.match(page, /\.gte\("expense_date", bounds\.start\)/i);
assert.match(page, /\.lt\("expense_date", bounds\.end\)/i);
assert.match(page, /identity\.role === "admin"/i);
assert.match(page, /getElementById\("expenseHistory"\)\.hidden = true/i);

console.log("Restaurant expense schema, RLS, ACL, and import-safety contracts passed.");
