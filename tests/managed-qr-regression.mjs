import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFile(path.join(projectRoot, file), "utf8");

const migrationFile = "supabase/migrations/20261004090249_managed_qr_storage_and_hotel.sql";
const [migration, menuAdminHtml, menuAdminSource] = await Promise.all([
  read(migrationFile),
  read("menu_admin.html"),
  read("assets/menu-admin.js"),
]);

function functionSource(source, name) {
  const marker = `function ${name}`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `${name} is missing`);
  const bodyStart = source.indexOf("{", start);
  assert.ok(bodyStart >= 0, `${name} body is missing`);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  assert.fail(`${name} body is incomplete`);
}

// Existing rows are classified as restaurant without a data rewrite. The
// migration itself must not mutate existing tables, token hashes, or orders.
assert.match(
  migration,
  /alter table public\.qr_tables[\s\S]*?add column if not exists qr_kind text not null default 'restaurant'/i,
);
assert.match(
  migration,
  /constraint qr_tables_qr_kind_check[\s\S]*?qr_kind in \('restaurant', 'hotel'\)[\s\S]*?not valid/i,
);
assert.match(migration, /validate constraint qr_tables_qr_kind_check/i);
const migrationWithoutFunctionBodies = migration.replace(/\$\$[\s\S]*?\$\$/g, "$$FUNCTION_BODY$$");
assert.doesNotMatch(
  migrationWithoutFunctionBodies,
  /(?:^|;)\s*(?:insert|update|delete|truncate|merge)\s+(?:into\s+|from\s+)?(?:public\.)?(?:qr_tables|qr_table_tokens|qr_orders|qr_order_items)\b/im,
  "deploying the migration must not rewrite any existing QR or order row",
);
assert.doesNotMatch(migration, /create\s+or\s+replace\s+function\s+public\.internal_qr_(?:get_menu|submit_order)/i);
assert.doesNotMatch(migrationWithoutFunctionBodies, /alter\s+table\s+private\.qr_table_tokens|drop\s+(?:column|constraint)\s+token_hash/i);

// Raw managed tokens live only in Vault. The private reference table stores
// secret ids, never a plaintext token, and cascades cleanup when a QR is archived.
assert.match(
  migration,
  /create table private\.qr_token_vault_refs[\s\S]*?table_id uuid primary key[\s\S]*?references private\.qr_table_tokens \(table_id\) on delete cascade[\s\S]*?vault_secret_id uuid not null unique/i,
);
assert.doesNotMatch(
  migration.match(/create table private\.qr_token_vault_refs[\s\S]*?\n\);/i)?.[0] || "",
  /(?:raw_?token|table_token|secret_value)\s+text/i,
);
assert.match(migration, /alter table private\.qr_token_vault_refs enable row level security/i);
assert.match(
  migration,
  /revoke all on table private\.qr_token_vault_refs[\s\S]*?from public, anon, authenticated, service_role/i,
);
assert.match(
  migration,
  /create trigger trg_delete_qr_token_vault_secret[\s\S]*?after delete on private\.qr_token_vault_refs/i,
);
assert.match(
  migration,
  /function private\.store_qr_token_in_vault[\s\S]*?vault\.create_secret[\s\S]*?vault\.update_secret[\s\S]*?vault\.decrypted_secrets[\s\S]*?v_decrypted_token <> p_table_token/i,
);

// New restaurant and hotel QR codes are managed, but the established public
// restaurant RPC contract and printed URL format remain unchanged.
assert.match(
  migration,
  /create or replace function private\.app_create_qr_table_impl\(p_label text\)[\s\S]*?insert into public\.qr_tables \(label, qr_kind\)[\s\S]*?'restaurant'[\s\S]*?store_qr_token_in_vault[\s\S]*?'table_token', v_token/i,
);
assert.match(
  migration,
  /create function private\.app_create_hotel_qr_impl\(p_label text\)[\s\S]*?insert into public\.qr_tables \(label, qr_kind\)[\s\S]*?'hotel'[\s\S]*?store_qr_token_in_vault/i,
);
assert.match(
  migration,
  /create function public\.app_create_hotel_qr\(p_label text\)[\s\S]*?security invoker[\s\S]*?private\.app_create_hotel_qr_impl\(p_label\)/i,
);
assert.match(menuAdminSource, /sb\.rpc\("app_create_qr_table", \{ p_label: label \}\)/);
assert.match(menuAdminSource, /sb\.rpc\("app_create_hotel_qr", \{ p_label: roomNumber \}\)/);
assert.match(menuAdminSource, /const TABLE_QR_CACHE_KEY = "dgv\.table-qr-cache\.v1"/);
assert.match(menuAdminSource, /url\.hash = `t=\$\{token\}`/);

// Cross-browser retrieval is admin-only and verifies Vault plaintext against
// the existing private token hash before returning it.
assert.match(
  migration,
  /create function private\.app_get_qr_table_token_impl\(p_table_id uuid\)[\s\S]*?security definer[\s\S]*?auth\.uid\(\)[\s\S]*?has_app_role\(array\['admin'\]::text\[\]\)[\s\S]*?vault\.decrypted_secrets[\s\S]*?private\.qr_sha256\(v_token\) <> v_token_hash/i,
);
assert.match(
  migration,
  /create function public\.app_get_qr_table_token\(p_table_id uuid\)[\s\S]*?security invoker/i,
);
for (const fn of [
  "private\\.app_create_hotel_qr_impl",
  "public\\.app_create_hotel_qr",
  "private\\.app_get_qr_table_token_impl",
  "public\\.app_get_qr_table_token",
  "private\\.app_register_existing_qr_token_impl",
  "public\\.app_register_existing_qr_token",
]) {
  assert.match(
    migration,
    new RegExp(`revoke execute on function ${fn}\\([^)]*\\)[\\s\\S]*?from public, anon, authenticated, service_role`, "i"),
  );
  assert.match(
    migration,
    new RegExp(`grant execute on function ${fn}\\([^)]*\\)[\\s\\S]*?to authenticated`, "i"),
  );
  assert.doesNotMatch(
    migration,
    new RegExp(`grant execute on function ${fn}\\([^)]*\\)[\\s\\S]*?to (?:public|anon|service_role)`, "i"),
  );
}

// Existing QR registration is explicit, hash-checked, and does not rotate or
// overwrite the credential that printed QR codes already use.
const registerSql = migration.match(
  /create function private\.app_register_existing_qr_token_impl[\s\S]*?\n\$\$;/i,
)?.[0] || "";
assert.ok(registerSql, "existing QR registration helper is missing");
assert.match(registerSql, /for update of q, t/i);
assert.match(registerSql, /private\.qr_sha256\(p_table_token\) <> v_token_hash/i);
assert.match(registerSql, /store_qr_token_in_vault[\s\S]*?'registered'/i);
assert.doesNotMatch(registerSql, /update\s+private\.qr_table_tokens|token_hash\s*=|app_rotate_qr_table_token/i);

// Restaurant and hotel management are separate in the UI, both list every row
// through stable pagination, and active table summary remains restaurant-only.
assert.match(menuAdminHtml, /id="createTableForm"[\s\S]*?id="tableList"/);
assert.match(menuAdminHtml, /호텔 객실 QR 관리[\s\S]*?id="createHotelQrForm"[\s\S]*?id="hotelQrList"/);
assert.match(menuAdminHtml, /id="newHotelQrLabel"[^>]*inputmode="numeric"[^>]*pattern="\[0-9\]\+"/);
assert.match(menuAdminHtml, /id="storeTokenBtn"[^>]*hidden/);
assert.match(
  menuAdminSource,
  /async function collectQrTables\(queryFactory\)[\s\S]*?collectSupabasePages[\s\S]*?pageSize: 500[\s\S]*?column: "id"/,
);
assert.match(menuAdminSource, /async function fetchQrTables\(qrKind\)[\s\S]*?\.eq\("qr_kind", qrKind\)[\s\S]*?isManagedQrSchemaUnavailable\(error\)[\s\S]*?qrKind === "hotel"[\s\S]*?\.select\("id,label,is_active,archived_at,created_at,updated_at"\)/);
assert.match(menuAdminSource, /tables = await fetchQrTables\("restaurant"\)/);
assert.match(menuAdminSource, /hotelQrs = await fetchQrTables\("hotel"\)/);
assert.match(menuAdminSource, /activeTableCount[\s\S]*?tables\.filter/);
assert.doesNotMatch(functionSource(menuAdminSource, "renderSummary"), /hotelQrs/);

// Viewing checks the server first but always preserves the old browser-cache
// fallback. Registration happens only through the explicit modal button.
const viewTableSource = functionSource(menuAdminSource, "viewTableQr");
assert.match(viewTableSource, /managedQrResult\(tableId\)/);
assert.match(viewTableSource, /isManagedQrMissing\(serverError\)/);
assert.match(viewTableSource, /cachedTableQrUrl\(tableId\)/);
assert.match(viewTableSource, /openTokenModal\(url, table\.label, \{ tableId, canStore: true, qrKind: "restaurant" \}\)/);
assert.doesNotMatch(viewTableSource, /app_register_existing_qr_token|rotateTable\(/);
assert.doesNotMatch(viewTableSource, /cacheTableQrUrl\(/);
const storeSource = functionSource(menuAdminSource, "storeCurrentToken");
assert.match(storeSource, /app_register_existing_qr_token/);
assert.match(storeSource, /const tableId = currentTokenTableId[\s\S]*?const tokenUrl = currentTokenUrl[\s\S]*?p_table_id: tableId[\s\S]*?p_table_token: token/);
assert.match(storeSource, /removeCachedTableQrUrl\(tableId\)[\s\S]*?currentTokenTableId === tableId && currentTokenUrl === tokenUrl/);
assert.doesNotMatch(storeSource, /app_rotate_qr_table_token/);
const viewHotelSource = functionSource(menuAdminSource, "viewHotelQr");
assert.match(viewHotelSource, /managedQrResult\(tableId\)/);
assert.match(viewHotelSource, /isManagedQrMissing\(serverError\)/);
assert.match(viewHotelSource, /openTokenModal\(managed\.url,[\s\S]*?qrKind: "hotel"/);
assert.match(viewHotelSource, /openTokenModal\(fallbackUrl,[\s\S]*?qrKind: "hotel"/);
assert.doesNotMatch(viewHotelSource, /cacheTableQrUrl\(/);
const showTokenSource = functionSource(menuAdminSource, "showToken");
assert.match(showTokenSource, /managedQrStorageAvailable === false[\s\S]*?cacheTableQrUrl\(tableId, url\)[\s\S]*?else[\s\S]*?removeCachedTableQrUrl\(tableId\)/);
assert.match(showTokenSource, /openTokenModal\(url, result\.label, \{ tableId, canStore: false, qrKind \}\)/);
assert.match(functionSource(menuAdminSource, "createHotelQr"), /const roomNumber = normalizedHotelRoomNumber\(input\.value\)[\s\S]*?app_create_hotel_qr", \{ p_label: roomNumber \}[\s\S]*?showToken\(data, "hotel"\)/);
assert.match(functionSource(menuAdminSource, "createHotelQr"), /hotelQrs\.find\(\(hotelQr\) => hotelRoomNumberFromLabel\(hotelQr\.label\) === roomNumber\)[\s\S]*?QR이 이미 등록되어 있습니다/);
assert.match(functionSource(menuAdminSource, "createHotelQr"), /tables\.find\(\(table\) => String\(table\.label \|\| ""\)\.trim\(\) === roomNumber\)[\s\S]*?같은 번호/);
assert.match(functionSource(menuAdminSource, "rotateHotelQr"), /app_rotate_qr_table_token[\s\S]*?showToken\(data, "hotel"\)/);
assert.doesNotMatch(functionSource(menuAdminSource, "createTable"), /"hotel"/);
assert.doesNotMatch(functionSource(menuAdminSource, "rotateTable"), /"hotel"/);

// New rotations acquire the same Vault protection, while archive keeps using
// the established soft-delete RPC that preserves historic order rows.
assert.match(
  migration,
  /create or replace function private\.app_rotate_qr_table_token_impl[\s\S]*?app_role\(array\['admin'\][\s\S]*?and archived_at is null[\s\S]*?token_hash = excluded\.token_hash[\s\S]*?store_qr_token_in_vault[\s\S]*?'rotated'/i,
);
assert.match(menuAdminSource, /async function archiveTable[\s\S]*?app_archive_qr_table/);
assert.match(menuAdminSource, /async function archiveHotelQr[\s\S]*?app_archive_qr_table/);
assert.doesNotMatch(
  migration,
  /(?:delete from|update)\s+public\.(?:qr_orders|qr_order_items|orders|order_items|order_custom_items)/i,
);

console.log("Managed restaurant and hotel QR compatibility, Vault, and UI contracts passed.");
