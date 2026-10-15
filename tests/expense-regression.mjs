import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migration = await readFile(
  path.join(projectRoot, "supabase/migrations/20261015113201_restaurant_expenses.sql"),
  "utf8",
);
const publicAccessMigration = await readFile(
  path.join(projectRoot, "supabase/migrations/20261015115438_allow_public_restaurant_expense_entry.sql"),
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

// The original deployment was role-protected. A later, data-preserving policy
// migration intentionally allows passwordless reads and appends, while UPDATE
// and DELETE require an app_metadata-backed administrator session.
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
assert.match(
  publicAccessMigration,
  /drop policy if exists restaurant_expenses_admin_read[\s\S]*?drop policy if exists restaurant_expenses_staff_insert/i,
);
assert.match(
  publicAccessMigration,
  /create policy restaurant_expenses_public_read[\s\S]*?for select[\s\S]*?to anon, authenticated[\s\S]*?using \(true\)/i,
);
assert.match(
  publicAccessMigration,
  /create policy restaurant_expenses_anon_insert[\s\S]*?for insert[\s\S]*?to anon[\s\S]*?source = 'web'[\s\S]*?import_key is null[\s\S]*?created_by is null/i,
);
assert.match(
  publicAccessMigration,
  /create policy restaurant_expenses_authenticated_insert[\s\S]*?for insert[\s\S]*?to authenticated[\s\S]*?auth\.uid\(\)[\s\S]*?source = 'web'[\s\S]*?import_key is null[\s\S]*?created_by = \(select auth\.uid\(\)\)/i,
);
assert.doesNotMatch(
  publicAccessMigration,
  /^\s*(?:insert\s+into|update\s+public\.restaurant_expenses|delete\s+from|truncate\s)/im,
  "the passwordless-access migration must not mutate expense rows",
);
assert.match(
  publicAccessMigration,
  /create policy restaurant_expenses_admin_update[\s\S]*?for update[\s\S]*?to authenticated[\s\S]*?has_app_role\(array\['admin'\]::text\[\]\)[\s\S]*?with check[\s\S]*?has_app_role\(array\['admin'\]::text\[\]\)/i,
);
assert.match(
  publicAccessMigration,
  /create policy restaurant_expenses_admin_delete[\s\S]*?for delete[\s\S]*?to authenticated[\s\S]*?has_app_role\(array\['admin'\]::text\[\]\)/i,
);
assert.match(
  publicAccessMigration,
  /grant select \([\s\S]*?\) on table public\.restaurant_expenses\s+to anon/i,
);
assert.match(
  publicAccessMigration,
  /grant insert \([\s\S]*?\) on table public\.restaurant_expenses\s+to anon/i,
);
assert.match(
  publicAccessMigration,
  /revoke update, delete, truncate, references, trigger[\s\S]*?from anon, authenticated/i,
);
assert.match(
  publicAccessMigration,
  /grant update \([\s\S]*?\) on table public\.restaurant_expenses\s+to authenticated/i,
);
assert.match(
  publicAccessMigration,
  /grant delete on table public\.restaurant_expenses\s+to authenticated/i,
);
assert.doesNotMatch(
  publicAccessMigration,
  /grant\s+(?:update|delete)(?:\s*\([^;]*?\))?\s+on table public\.restaurant_expenses\s+to anon/i,
);

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
// reads, and opens without a password. Modification controls authenticate with
// the administrator password before UPDATE or DELETE.
assert.match(page, /<input[^>]+id="expenseDate"[^>]+type="date"/i);
assert.match(page, /name="expenseType" value="general"/i);
assert.match(page, /name="expenseType" value="invoice"/i);
assert.match(page, /id="amountVnd"[^>]+inputmode="numeric"/i);
assert.match(page, /\.from\("restaurant_expenses"\)\.insert\(\[payload\]\)/i);
for (const field of ["expense_date", "expense_type", "amount_vnd", "description", "note"]) {
  assert.match(page, new RegExp(`\\b${field}\\b`));
}
assert.match(page, /\.from\("restaurant_expenses"\)\.update\(payload\)/i);
assert.match(page, /\.from\("restaurant_expenses"\)[\s\S]*?\.delete\(\)/i);
assert.match(page, /DGV\.collectSupabasePages\(/i);
assert.match(page, /\.gte\("expense_date", bounds\.start\)/i);
assert.match(page, /\.lt\("expense_date", bounds\.end\)/i);
assert.match(page, /href="home_admin\.html"/i);
assert.match(page, /document\.body\.classList\.remove\("locked"\)/i);
assert.doesNotMatch(page, /QRStaff\.requireLogin\(/i);
assert.match(page, /DGV\.signInAs\("admin", password\)/i);
assert.match(page, /id="adminAuthPassword"[^>]*type="password"[^>]*autocomplete="current-password"/i);
assert.match(page, /requestAdminPassword\(\)/i);
assert.doesNotMatch(page, /id="login(?:Modal|Form|Password|Role|Confirm)"/i);
assert.doesNotMatch(page, /getElementById\("expenseHistory"\)\.hidden = true/i);
assert.match(page, /id="expenseSearch"[^>]*type="search"[^>]*placeholder="내역·비고·날짜·금액 검색"/i);
assert.match(page, /전체 기록 검색 \(이전 달 포함\)/i);
assert.match(page, /searchForm\.addEventListener\("submit", searchAllExpenses\)/i);
assert.match(page, /function searchableExpenseText\(row\)[\s\S]*?row\.expense_date[\s\S]*?typeLabel\(row\.expense_type\)[\s\S]*?row\.description[\s\S]*?row\.note[\s\S]*?amount\.toLocaleString/i);
assert.match(page, /terms\.every\(\(term\) => haystack\.includes\(term\)\)/i);
assert.match(page, /function searchAllExpenses\(event\)[\s\S]*?DGV\.collectSupabasePages\([\s\S]*?\.from\("restaurant_expenses"\)[\s\S]*?\.select\("id,expense_date,expense_type,description,amount_vnd,note,created_at"\)(?![\s\S]*?\.gte\("expense_date")/i);
assert.match(page, /전체 기록 \$\{allRows\.length[\s\S]*?검색 결과 \$\{rows\.length/i);
assert.match(page, /clearSearchBtn\.addEventListener\("click", clearSearch\)/i);
assert.match(page, /async function loadMonth\(\)\{\s*if \(refreshBtn\.disabled\) return;/i);
assert.match(page, /async function searchAllExpenses\(event\)\{[\s\S]*?if \(searchBtn\.disabled\) return;/i);
assert.match(page, /finally\{\s*QRStaff\.setBusy\(searchBtn, false\);\s*\}/i);

console.log("Restaurant expense schema, RLS, ACL, and import-safety contracts passed.");
