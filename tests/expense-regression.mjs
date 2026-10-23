import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
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
const vendorMigration = await readFile(
  path.join(projectRoot, "supabase/migrations/20261023123000_restaurant_expense_vendor.sql"),
  "utf8",
);
const migrationDirectory = path.join(projectRoot, "supabase/migrations");
const migrationFiles = (await readdir(migrationDirectory))
  .filter((name) => name.endsWith(".sql"))
  .sort();
const migrationSources = await Promise.all(migrationFiles.map(async (name) => ({
  name,
  source: await readFile(path.join(migrationDirectory, name), "utf8"),
})));
const laborMigrationEntry = migrationSources.find(({ name, source }) =>
  name !== "20261015113201_restaurant_expenses.sql"
  && /restaurant_expenses_type_check/i.test(source)
  && /'labor'/i.test(source));
assert.ok(laborMigrationEntry, "a follow-up migration must add the labor expense type");
const laborMigration = laborMigrationEntry.source;
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

// Vendor support is a nullable, additive column. The follow-up migration must
// not rewrite any imported or web-created expense row.
const vendorColumn = vendorMigration.match(
  /alter table public\.restaurant_expenses\s+add column vendor text\s*;/i,
)?.[0];
assert.ok(vendorColumn, "the optional vendor column is missing");
assert.doesNotMatch(vendorColumn, /\b(?:not null|default)\b/i);
assert.match(
  vendorMigration,
  /constraint restaurant_expenses_vendor_check[\s\S]*?vendor is null[\s\S]*?length\(btrim\(vendor\)\)\s*<=\s*300/i,
);
assert.match(
  vendorMigration,
  /grant select\s*\(\s*vendor\s*\)\s+on table public\.restaurant_expenses\s+to anon, authenticated/i,
);
assert.match(
  vendorMigration,
  /grant insert\s*\(\s*vendor\s*\)\s+on table public\.restaurant_expenses\s+to anon, authenticated/i,
);
assert.match(
  vendorMigration,
  /grant update\s*\(\s*vendor\s*\)\s+on table public\.restaurant_expenses\s+to authenticated/i,
);
assert.doesNotMatch(
  vendorMigration,
  /^\s*(?:insert\s+into|update\s+(?:public\.)?restaurant_expenses|delete\s+from|truncate|merge\s+into)\b/im,
  "the vendor migration must not mutate existing expense rows",
);
assert.doesNotMatch(vendorMigration, /create\s+policy\b/i);
assert.doesNotMatch(
  vendorMigration,
  /grant\s+update\s*\([^)]*\bvendor\b[^)]*\)[\s\S]*?\bto\s+anon\b/i,
  "anonymous clients must not receive vendor UPDATE access",
);

// Labor is an additive category. The migration widens only the type check and
// reclassifies the explicitly requested October rows without touching their
// date, amount, description, vendor, note, or audit fields.
assert.match(
  laborMigration,
  /alter table public\.restaurant_expenses[\s\S]*?drop constraint(?: if exists)? restaurant_expenses_type_check/i,
);
const laborTypeCheck = laborMigration.match(
  /constraint restaurant_expenses_type_check[\s\S]*?check\s*\(\s*expense_type\s+in\s*\(([^)]+)\)\s*\)/i,
);
assert.ok(laborTypeCheck, "the labor migration must recreate the expense type check");
for (const allowedType of ["general", "invoice", "labor"]) {
  assert.match(laborTypeCheck[1], new RegExp(`'${allowedType}'`, "i"));
}
const laborBackfill = laborMigration.match(
  /update\s+public\.restaurant_expenses\s+set\s+([\s\S]*?)\s+where\s+([\s\S]*?);/i,
);
assert.ok(laborBackfill, "the labor migration must reclassify the approved October rows");
assert.match(laborBackfill[1].trim(), /^expense_type\s*=\s*'labor'$/i);
assert.match(laborBackfill[2], /expense_date\s*>=\s*(?:date\s*)?'2026-10-01'/i);
assert.match(laborBackfill[2], /expense_date\s*<\s*(?:date\s*)?'2026-11-01'/i);
assert.match(
  laborBackfill[2],
  /(?:\bid\s+in\s*\(|\b(?:description|vendor|note)\b[\s\S]*(?:파트타임|알바))/i,
  "the October backfill must be limited to audited row ids or the requested labor keywords",
);
assert.doesNotMatch(laborMigration, /^\s*(?:insert\s+into|delete\s+from|truncate|merge\s+into)\b/im);
assert.doesNotMatch(laborMigration, /create\s+policy|grant\s+|revoke\s+/i);

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

// The page keeps input simple, shows an inclusive date range or a search result
// constrained to the currently selected range, and opens without a password. Modification controls still
// authenticate with the administrator password before UPDATE or DELETE.
assert.match(page, /<input[^>]+id="expenseDate"[^>]+type="date"/i);
assert.match(page, /name="expenseType" value="general"/i);
assert.match(page, /name="expenseType" value="invoice"/i);
assert.match(page, /name="expenseType" value="labor"/i);
assert.match(page, /id="amountVnd"[^>]+inputmode="numeric"/i);
assert.match(page, /id="vendor"[^>]+maxlength="300"/i);
assert.match(page, /\.from\("restaurant_expenses"\)\.insert\(\[payload\]\)/i);
for (const field of ["expense_date", "expense_type", "amount_vnd", "description", "vendor", "note"]) {
  assert.match(page, new RegExp(`\\b${field}\\b`));
}
assert.match(page, /\.from\("restaurant_expenses"\)\.update\(payload\)/i);
assert.match(page, /\.from\("restaurant_expenses"\)[\s\S]*?\.delete\(\)/i);
assert.match(page, /DGV\.collectSupabasePages\(/i);
assert.match(page, /id="rangeForm"/i);
assert.match(page, /id="rangeStart"[^>]*type="date"/i);
assert.match(page, /id="rangeEnd"[^>]*type="date"/i);
assert.match(page, /id="exportExpenseBtn"[^>]*type="button"/i);
assert.match(page, /\.gte\("expense_date",\s*[^)]+\)/i);
assert.match(page, /\.lte\("expense_date",\s*[^)]+\)/i);
assert.doesNotMatch(page, /\.lt\("expense_date",\s*bounds\.end\)/i);
assert.match(page, /let displayedRows = \[\];/i);
assert.match(
  page,
  /function renderRows\(rows\)[\s\S]*?displayedRows\s*=\s*(?:rows\.slice\(\)|\[\.\.\.rows\])/i,
);
assert.match(page, /function refreshActiveView\s*\(/i);
assert.match(page, /rangeForm\.addEventListener\("submit"/i);
assert.doesNotMatch(page, />관리자 홈<\/a>/i);
assert.match(page, /document\.body\.classList\.remove\("locked"\)/i);
assert.doesNotMatch(page, /QRStaff\.requireLogin\(/i);
assert.match(page, /DGV\.signInAs\("admin", password\)/i);
assert.match(page, /id="adminAuthPassword"[^>]*type="password"[^>]*autocomplete="current-password"/i);
assert.match(page, /requestAdminPassword\(\)/i);
assert.doesNotMatch(page, /id="login(?:Modal|Form|Password|Role|Confirm)"/i);
assert.doesNotMatch(page, /getElementById\("expenseHistory"\)\.hidden = true/i);
assert.match(page, /id="expenseSearch"[^>]*type="search"[^>]*placeholder="내역·거래처·비고·날짜·금액 검색"/i);
assert.match(page, /<select[^>]+id="expenseCategoryFilter"[^>]*>[\s\S]*?value="all"[\s\S]*?전체 카테고리[\s\S]*?value="general"[\s\S]*?일반 지출[\s\S]*?value="invoice"[\s\S]*?계산서 지출[\s\S]*?value="labor"[\s\S]*?인건비 지출[\s\S]*?<\/select>/i);
assert.match(page, /searchForm\.addEventListener\("submit", searchAllExpenses\)/i);
assert.match(page, /function searchableExpenseText\(row\)[\s\S]*?row\.expense_date[\s\S]*?typeLabel\(row\.expense_type\)[\s\S]*?row\.description[\s\S]*?row\.vendor[\s\S]*?row\.note[\s\S]*?amount\.toLocaleString/i);
assert.match(page, /terms\.every\(\(term\) => haystack\.includes\(term\)\)/i);
assert.match(page, /function selectedSearchType\(\)[\s\S]*?expenseCategoryFilter\.value[\s\S]*?(?:all|general|invoice|labor)/i);
assert.match(page, /function normalizeExpenseType\(value\)[\s\S]*?\["general",\s*"invoice",\s*"labor"\]\.includes\(value\)/i);
assert.match(page, /function selectedType\(\)[\s\S]*?normalizeExpenseType\(form\.elements\.expenseType\.value\)/i);
assert.match(page, /function typeLabel\(value\)[\s\S]*?labor[\s\S]*?인건비 지출/i);
assert.match(page, /function typeBilingualLabel\(value\)[\s\S]*?labor[\s\S]*?인건비 지출 \/ Chi phí nhân công/i);
assert.match(page, /function beginEdit\(row\)[\s\S]*?normalizeExpenseType\(row\.expense_type\)/i);
assert.match(
  page,
  /function updateSummary\(rows\)[\s\S]*?normalizeExpenseType\(row\.expense_type\)[\s\S]*?\{\s*general\s*:\s*0\s*,\s*invoice\s*:\s*0\s*,\s*labor\s*:\s*0\s*\}[\s\S]*?laborSubtotal[\s\S]*?totals\.labor/i,
);
assert.match(page, /function renderRows\(rows\)[\s\S]*?normalizeExpenseType\(row\.expense_type\)[\s\S]*?data-type="\$\{type\}"[\s\S]*?typeBilingualLabel\(type\)/i);
assert.match(page, /id="laborSubtotal"/i);
assert.match(page, /인건비 지출 \/ Chi phí nhân công/i);
assert.match(page, /const EXPENSE_COLUMNS\s*=\s*"[^"\n]*\bvendor\b[^"\n]*"/i);
assert.match(page, /\.select\(EXPENSE_COLUMNS\)/i);
assert.match(
  page,
  /async function loadSearchResults\(\)[\s\S]*?const range\s*=\s*requestedRange\(\)[\s\S]*?DGV\.collectSupabasePages\([\s\S]*?\.from\("restaurant_expenses"\)[\s\S]*?\.select\(EXPENSE_COLUMNS\)[\s\S]*?\.gte\("expense_date",\s*range\.start\)[\s\S]*?\.lte\("expense_date",\s*range\.end\)/i,
  "search must read the current date inputs and constrain its Supabase query to that inclusive range",
);
assert.match(
  page,
  /\.eq\("expense_type",\s*(?:category|searchType|selectedCategory)\)/i,
  "a selected expense category must constrain the Supabase search query",
);
assert.match(
  page,
  /if\s*\(\s*!terms\.length\s*&&\s*(?:category|searchType|selectedCategory)\s*===\s*"all"\s*\)/i,
  "category-only searches must be accepted while a fully empty search is rejected",
);
assert.match(page, /async function searchAllExpenses\(event\)[\s\S]*?await loadSearchResults\(\)/i);
assert.match(
  page,
  /function renderSearchResults\(\)[\s\S]*?const category\s*=\s*selectedSearchType\(\)[\s\S]*?loadStatus\.textContent\s*=\s*`[^`]*검색 결과 \$\{rows\.length/i,
);
assert.match(page, /clearSearchBtn\.addEventListener\("click", clearSearch\)/i);
assert.match(page, /async function searchAllExpenses\(event\)\{[\s\S]*?if \(searchBtn\.disabled\) return;/i);
assert.match(page, /finally\{\s*QRStaff\.setBusy\(searchBtn, false\);\s*\}/i);

// XLSX generation uses the same in-memory row set currently rendered on the
// page. It is a client-side download and does not mutate Supabase data.
assert.match(page, /<script src="assets\/dgv-xlsx\.js"><\/script>/i);
assert.match(page, /window\.DGV_XLSX\?\.downloadWorkbook/i);
assert.match(page, /window\.DGV_XLSX\.downloadWorkbook\(/i);
assert.match(page, /displayedRows\s*\.\s*slice\(\)/i);
assert.match(page, /["']거래처 \/ Đối tác["']/i);
assert.match(page, /["']금액\(VND\) \/ Số tiền \(VND\)["']/i);
assert.match(page, /const rows = await refreshActiveView\(\)/i);
assert.match(page, /exportExpenseBtn\.addEventListener\("click"/i);
assert.match(page, /async function deleteExpense\(row\)[\s\S]*?await refreshActiveView\(\)/i);
assert.match(page, /async function saveExpense\(event\)[\s\S]*?await refreshActiveView\(\)/i);

console.log("Restaurant expense schema, RLS, ACL, and import-safety contracts passed.");

