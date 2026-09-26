import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFile(path.join(projectRoot, file), "utf8");
const migrationFiles = await readdir(path.join(projectRoot, "supabase/migrations"));
const inboxAccessMigrationFile = migrationFiles.find((file) => file.endsWith("_qr_inbox_staff_card_fee.sql"));
assert.ok(inboxAccessMigrationFile, "missing QR inbox staff/card-fee migration");
const guestOpenOrdersMigrationFile = migrationFiles.find((file) => file.endsWith("_qr_guest_open_orders.sql"));
assert.ok(guestOpenOrdersMigrationFile, "missing QR guest open-orders migration");
const finalizeCutoverMigrationFile = migrationFiles.find((file) => file.endsWith("_disable_legacy_qr_finalize_rpc.sql"));
assert.ok(finalizeCutoverMigrationFile, "missing legacy QR finalize cutover migration");

const [
  adminHtml,
  menuHtml,
  guestSource,
  inboxHtml,
  inboxSource,
  menuAdminHtml,
  menuAdminSource,
  edgeSource,
  config,
  migration,
  metadataMigration,
  storageMigration,
  archiveMigration,
  cafeMigration,
  inboxAccessMigration,
  guestOpenOrdersMigration,
  finalizeCutoverMigration,
] = await Promise.all([
  read("admin.html"),
  read("menu.html"),
  read("assets/qr-menu.js"),
  read("order_inbox.html"),
  read("assets/order-inbox.js"),
  read("menu_admin.html"),
  read("assets/menu-admin.js"),
  read("supabase/functions/qr-menu/index.ts"),
  read("supabase/config.toml"),
  read("supabase/migrations/20260926110000_qr_table_ordering.sql"),
  read("supabase/migrations/20260926120000_qr_menu_pdf_metadata.sql"),
  read("supabase/migrations/20260926140000_qr_menu_images_storage.sql"),
  read("supabase/migrations/20260926150000_qr_menu_archive.sql"),
  read("supabase/migrations/20260926160000_add_cafe_menu_items.sql"),
  read(`supabase/migrations/${inboxAccessMigrationFile}`),
  read(`supabase/migrations/${guestOpenOrdersMigrationFile}`),
  read(`supabase/migrations/${finalizeCutoverMigrationFile}`),
]);

assert.match(
  adminHtml,
  /\["reservation_confirm", "qr_table"\]\.includes\(orderMeta\.source\)[\s\S]*?data-act="editExpanded"/,
  "QR-ledger rows must not expose the incompatible calc edit action",
);

function functionSource(source, name) {
  const match = source.match(new RegExp(`^  (?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^  \\}$`, "m"));
  assert.ok(match, `missing function ${name}`);
  return match[0];
}

// Guest QR tokens stay out of request URLs/referrers and are only submitted to
// the custom-auth Edge Function. Browser clients must never receive service_role.
assert.match(menuHtml, /name="referrer" content="no-referrer"/i);
assert.match(menuHtml, /Content-Security-Policy/i);
assert.match(menuHtml, /connect-src 'self' https:\/\/\*\.supabase\.co/i);
assert.doesNotMatch(`${menuHtml}\n${guestSource}`, /service[_-]?role/i);
assert.match(guestSource, /global\.location\.hash/);
assert.match(guestSource, /history\.replaceState[\s\S]*?url\.hash/);
assert.match(guestSource, /body: \{ action: "get_menu", table_token: state\.token \}/);
assert.match(guestSource, /action: "submit_order"[\s\S]*?table_token: state\.token/);
assert.doesNotMatch(guestSource, /method: options\.method \|\| "GET"/);
assert.match(guestSource, /method: options\.method \|\| "POST"/);
assert.match(guestSource, /credentials: "omit"/);
assert.match(guestSource, /referrerPolicy: "no-referrer"/);

// Same menu id may appear as separate cart rows because each row can carry a
// different note. Submission must merge those quantities into one DB line.
const buildItemsContext = {
  Map,
  state: {
    cart: [
      { menu_item_id: "item-a", qty: 2, line_note: "덜 맵게" },
      { menu_item_id: "item-a", qty: 3, line_note: "소스 따로" },
      { menu_item_id: "item-b", qty: 1, line_note: "" },
    ],
  },
};
vm.runInNewContext(
  `${functionSource(guestSource, "buildSubmissionItems")}\nresult = buildSubmissionItems();`,
  buildItemsContext,
);
assert.deepEqual(
  JSON.parse(JSON.stringify(buildItemsContext.result)),
  [
    { menu_item_id: "item-a", qty: 5 },
    { menu_item_id: "item-b", qty: 1 },
  ],
);
assert.match(guestSource, /function composedOrderNote\([\s\S]*?state\.cart\.forEach[\s\S]*?line\.line_note[\s\S]*?return notes\.join\(" \| "\)/);
assert.match(guestSource, /const MAX_QTY = 20/);
assert.match(guestSource, /const MAX_TOTAL_QTY = 100/);
assert.match(guestSource, /MAX_QTY - cartQuantityForItem\(item\.id\)/);
assert.match(guestSource, /MAX_TOTAL_QTY - cartQuantityTotal\(\)/);

// The fallback retry/idempotency key must pass the Edge Function UUID parser.
const uuidContext = {
  Uint8Array,
  Math,
  global: {
    crypto: {
      getRandomValues(bytes) {
        for (let index = 0; index < bytes.length; index += 1) bytes[index] = index * 13 + 7;
        return bytes;
      },
    },
  },
};
vm.runInNewContext(
  `${functionSource(guestSource, "createClientRequestId")}\nresult = createClientRequestId();`,
  uuidContext,
);
assert.match(
  uuidContext.result,
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
);

// Edge Function validates a strong opaque table token, hashes it before any DB
// lookup, accepts only bounded POST JSON, and never trusts browser-sent prices.
assert.match(config, /\[functions\.qr-menu\][\s\S]*?verify_jwt\s*=\s*false/);
assert.match(edgeSource, /const TOKEN_PATTERN = \/\^\[0-9a-f\]\{64\}\$\//);
assert.match(edgeSource, /crypto\.subtle\.digest\("SHA-256"/);
assert.match(edgeSource, /if \(req\.method !== "POST"\)/);
assert.match(edgeSource, /MAX_REQUEST_BYTES = 16 \* 1024/);
assert.match(edgeSource, /assertOnlyKeys\(item, \["menu_item_id", "qty"\]\)/);
assert.doesNotMatch(edgeSource, /price_(?:usd|vnd)/i);
assert.doesNotMatch(edgeSource, /console\.(?:log|debug|info)\s*\(/);
assert.match(edgeSource, /Never log request bodies, raw table tokens, guest notes, or order lines/);
assert.match(edgeSource, /const cloudflare = req\.headers\.get\("cf-connecting-ip"\)/);
assert.match(edgeSource, /forwarded\?\.\[0\]/, "rate limiting must use the first trusted forwarding hop");
assert.match(edgeSource, /sha256\(`\$\{action\}:ip:\$\{address\}`\)/);
assert.doesNotMatch(edgeSource, /sha256\(`\$\{action\}:table:/, "unvalidated tokens must not create rate-limit rows");
assert.match(edgeSource, /Per-table limits[\s\S]*?validated database RPCs/);

// Public tables are RLS-protected. Guests cannot call internal RPCs directly;
// staff can only read queue tables and mutate through role-checking RPCs.
for (const table of ["qr_tables", "qr_orders", "qr_order_items"]) {
  assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`, "i"));
}
for (const table of ["qr_table_tokens", "qr_rate_limits"]) {
  assert.match(migration, new RegExp(`alter table private\\.${table} enable row level security`, "i"));
}
assert.match(migration, /revoke all on table[\s\S]*?public\.qr_tables,[\s\S]*?public\.qr_orders,[\s\S]*?public\.qr_order_items[\s\S]*?from anon, authenticated, service_role/i);
assert.match(migration, /grant select on table[\s\S]*?public\.qr_tables,[\s\S]*?public\.qr_orders,[\s\S]*?public\.qr_order_items[\s\S]*?to authenticated/i);
assert.doesNotMatch(migration, /grant\s+(?:insert|update|delete|all)[^;]*public\.qr_(?:tables|orders|order_items)[^;]*to authenticated/i);
for (const rpc of ["internal_qr_take_rate_limit", "internal_qr_get_menu", "internal_qr_submit_order"]) {
  assert.match(migration, new RegExp(`revoke execute on function public\\.${rpc}\\([\\s\\S]*?from public, anon, authenticated, service_role`, "i"));
  assert.match(migration, new RegExp(`grant execute on function public\\.${rpc}\\([\\s\\S]*?to service_role`, "i"));
}
assert.match(migration, /revoke execute on function private\.qr_sha256\(text\)[\s\S]*?from public, anon, authenticated, service_role[\s\S]*?grant execute on function private\.qr_sha256\(text\) to service_role/i);
assert.match(migration, /if \(select auth\.uid\(\)\) is null[\s\S]*?or v_role is null[\s\S]*?or v_role not in \('staff', 'admin'\) then/i);
assert.match(migration, /or v_target is null[\s\S]*?or v_target not in \('accepted', 'cancelled'\)/i);
assert.match(migration, /check \(status in \('submitted', 'accepted', 'cancelled'\)\)/i);
assert.doesNotMatch(migration, /status in \([^)]*(?:preparing|ready|served)/i);

// Only validated table tokens receive a table-specific bucket, and stale
// untrusted request buckets are indexed and removed rather than kept forever.
assert.match(migration, /create index qr_rate_limits_updated_at_idx[\s\S]*?on private\.qr_rate_limits \(updated_at\)/i);
assert.match(migration, /delete from private\.qr_rate_limits[\s\S]*?updated_at <= now\(\) - interval '1 day'/i);
assert.match(migration, /invalid or inactive table token[\s\S]*?private\.qr_sha256\('get_menu:table:' \|\| p_token_hash\)/i);
assert.match(migration, /invalid or inactive table token[\s\S]*?private\.qr_sha256\('submit_order:table:' \|\| p_token_hash\)/i);

// Table identity and all prices are resolved on the server. Existing orders are
// separate until authenticated inbox staff explicitly finalize an accepted QR order.
assert.match(migration, /join private\.qr_table_tokens as tokens on tokens\.table_id = t\.id[\s\S]*?tokens\.token_hash = p_token_hash[\s\S]*?t\.is_active = true/i);
assert.match(migration, /left join public\.menu_items as m[\s\S]*?m\.is_orderable is distinct from true[\s\S]*?m\.is_sold_out is distinct from false/i);
assert.match(migration, /sum\(\(e\.item ->> 'qty'\)::bigint \* m\.price_vnd::bigint\)/i);
assert.match(migration, /insert into public\.qr_order_items[\s\S]*?m\.price_usd,[\s\S]*?m\.price_vnd/i);
assert.match(migration, /order by m\.id[\s\S]*?for share of m/i, "menu rows must stay stable through pricing and insert");
assert.match(migration, /v_qr_order\.status <> 'accepted'/i);
assert.match(migration, /v_paid_order_id := public\.app_create_order/i);
assert.doesNotMatch(migration, /(?:delete from|truncate table)\s+public\.(?:menu_items|orders|order_items|order_custom_items)/i);

// Realtime is only a wake-up signal. RLS-filtered refetch and polling provide a
// fallback, while submitted orders keep sounding until status becomes accepted.
assert.match(migration, /alter publication supabase_realtime add table public\.qr_orders/i);
assert.match(migration, /alter publication supabase_realtime add table public\.qr_order_items/i);
assert.match(inboxSource, /submitted: \{ status: "accepted", label: "주문 확인" \}/);
assert.match(inboxSource, /const CURRENT_STATUSES = Object\.freeze\(\["submitted", "accepted"\]\)/);
assert.doesNotMatch(inboxSource, /(?:status|value):?\s*["'](?:preparing|ready|served)["']/);
assert.doesNotMatch(inboxHtml, /<option value="(?:preparing|ready|served)"/);
assert.match(inboxSource, /fetchWithRelations\(\["submitted"\]\)/);
assert.match(inboxSource, /fetchWithRelations\(\["accepted"\], null, false\)/, "all unfinalized accepted orders must stay visible");
assert.match(inboxSource, /fetchWithRelations\(\["accepted"\], 80, true\)/, "finalized history must be bounded");
assert.match(inboxSource, /fetchWithRelations\(\["cancelled"\], 80\)/, "cancelled history must be bounded");
assert.match(inboxSource, /new Map\(groups\.flat\(\)\.map\(\(order\) => \[order\.id, order\]\)\)/, "overlapping order groups must be deduplicated");
assert.doesNotMatch(functionSource(inboxSource, "actionButtons"), /identity/, "staff and admin must receive the same inbox actions");
assert.match(functionSource(inboxSource, "finalizePayment"), /\["staff", "admin"\]\.includes\(identity\?\.role\)/);
assert.match(inboxHtml, /name="paymentMethod"[^>]*value="card"/);
assert.match(inboxHtml, /name="paymentMethod"[^>]*value="card_fee7"/);
assert.match(inboxHtml, /카드 결제 \+ 7%/);
assert.match(inboxSource, /getPaymentMethod\(\) === "card_fee7"/);
assert.match(functionSource(inboxSource, "openPayment"), /openOrdersForTable\(tableId\)[\s\S]*?order\.status === "submitted"[\s\S]*?먼저 주문 확인해 주세요[\s\S]*?order\.status === "accepted"[\s\S]*?paymentOrders = accepted\.map/);
assert.match(
  functionSource(inboxSource, "finalizeTableOrders"),
  /sb\.rpc\("app_finalize_qr_table_orders_checked", \{[\s\S]*?p_table_id: tableId,[\s\S]*?p_expected_orders: expectedOrders/,
);
assert.doesNotMatch(functionSource(inboxSource, "finalizePayment"), /app_finalize_qr_order/);
assert.match(inboxSource, /setInterval\(\(\) => \{[\s\S]*?orders\.some\(\(order\) => order\.status === "submitted"\)[\s\S]*?ui\.playAlert\(\)[\s\S]*?\}, 9000\)/);
assert.match(inboxSource, /postgres_changes[\s\S]*?table: "qr_orders"/);
assert.match(inboxSource, /postgres_changes[\s\S]*?table: "qr_order_items"/);
assert.match(inboxSource, /setInterval\([\s\S]*?loadOrders\(\)[\s\S]*?15000\)/);
assert.match(inboxSource, /qr_tables\(label\)/);
assert.match(inboxSource, /group\.label/);
const directTableWrite = /\.from\([^)]*\)[\s\S]{0,160}\.(?:insert|update|upsert|delete)\s*\(/;
assert.doesNotMatch(inboxSource, directTableWrite);
assert.doesNotMatch(menuAdminSource, directTableWrite);
assert.match(inboxHtml, /@supabase\/supabase-js@2\.112\.2/);
assert.match(menuAdminHtml, /@supabase\/supabase-js@2\.112\.2/);
assert.match(inboxSource, /requireLogin\(\{ roles: \["staff", "admin"\]/);
assert.match(menuAdminSource, /requireLogin\(\{ roles: \["admin"\]/);
assert.match(menuAdminHtml, /src="assets\/vendor\/qrcode\.min\.js"/);
assert.match(menuAdminHtml, /id="downloadQrBtn"/);
assert.match(menuAdminHtml, /id="printQrBtn"/);
assert.match(menuAdminSource, /new global\.QRCode\(target,/);
assert.match(menuAdminSource, /link\.download = `hana-\$\{safeFilePart\(currentTokenLabel\)\}-qr\.png`/);
assert.match(menuAdminSource, /const TABLE_QR_CACHE_KEY = "dgv\.table-qr-cache\.v1"/);
assert.match(menuAdminSource, /const MAX_TABLE_QR_CACHE_ENTRIES = 100/);
assert.match(menuAdminSource, /data-table-action="view"[^>]*>QR 보기</);
assert.match(menuAdminSource, /function showToken[\s\S]*?cacheTableQrUrl\(tableId, url\)[\s\S]*?openTokenModal\(url, result\.label\)/);
assert.match(menuAdminSource, /function viewTableQr[\s\S]*?cachedTableQrUrl\(tableId\)[\s\S]*?이 브라우저에 원본 QR이 없어 QR 교체가 필요합니다/);
assert.doesNotMatch(functionSource(menuAdminSource, "viewTableQr"), /\.rpc\(|rotateTable\(/, "viewing a missing cached QR must never rotate it automatically");
assert.match(menuAdminHtml, /같은 브라우저에서는 ‘QR 보기’로 다시 확인/);
assert.doesNotMatch(`${menuAdminHtml}\n${menuAdminSource}`, /api\.qrserver|chart\.googleapis|quickchart|qrcode\.monkey/i);
await access(path.join(projectRoot, "assets/vendor/qrcode.min.js"));
await access(path.join(projectRoot, "assets/vendor/qrcode.LICENSE.txt"));

// Raw table tokens remain hash-only in Supabase. The one recoverable copy is a
// bounded, versioned cache on the browser that generated/rotated the QR. Every
// cached URL must be the exact same-origin menu.html fragment form.
const cacheStorage = new Map();
const qrCacheContext = {
  URL,
  JSON,
  Object,
  Array,
  Set,
  String,
  TABLE_QR_CACHE_KEY: "dgv.table-qr-cache.v1",
  TABLE_QR_CACHE_VERSION: 1,
  MAX_TABLE_QR_CACHE_ENTRIES: 100,
  MAX_TABLE_QR_CACHE_BYTES: 100_000,
  TABLE_ID_PATTERN: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  TABLE_TOKEN_PATTERN: /^[0-9a-f]{64}$/,
  global: {
    location: { href: "https://dalatgolfvoucher.com/menu_admin.html" },
    localStorage: {
      getItem(key) { return cacheStorage.has(key) ? cacheStorage.get(key) : null; },
      setItem(key, value) { cacheStorage.set(key, value); },
    },
  },
};
const cacheFunctions = [
  "normalizedTableQrUrl",
  "readTableQrCache",
  "cacheTableQrUrl",
  "cachedTableQrUrl",
  "tokenToUrl",
].map((name) => functionSource(menuAdminSource, name)).join("\n");
vm.runInNewContext(
  `${cacheFunctions}
  const token = "a".repeat(64);
  const canonical = "https://dalatgolfvoucher.com/menu.html#t=" + token;
  normalizedResults = [
    canonical,
    "https://evil.example/menu.html#t=" + token,
    "https://dalatgolfvoucher.com/other.html#t=" + token,
    "https://dalatgolfvoucher.com/menu.html?x=1#t=" + token,
    "https://dalatgolfvoucher.com/menu.html#t=" + token + "&x=1",
    "https://dalatgolfvoucher.com/menu.html#t=" + token.toUpperCase(),
    " https://dalatgolfvoucher.com/menu.html#t=" + token,
  ].map(normalizedTableQrUrl);
  tokenUrls = [tokenToUrl(token), tokenToUrl(token.toUpperCase()), tokenToUrl({ toString: () => token })];
  for (let index = 0; index < 101; index += 1) {
    const tableId = index.toString(16).padStart(8, "0") + "-0000-4000-a000-000000000000";
    if (!cacheTableQrUrl(tableId, canonical)) throw new Error("valid QR cache insert failed");
  }
  cachedEntries = readTableQrCache();
  newestCachedUrl = cachedTableQrUrl("00000064-0000-4000-a000-000000000000");
  oldestCachedUrl = cachedTableQrUrl("00000000-0000-4000-a000-000000000000");`,
  qrCacheContext,
);
assert.deepEqual(
  JSON.parse(JSON.stringify(qrCacheContext.normalizedResults)),
  [`https://dalatgolfvoucher.com/menu.html#t=${"a".repeat(64)}`, null, null, null, null, null, null],
  "only an exact same-origin menu.html URL with a lowercase 64-hex fragment token is cacheable",
);
assert.deepEqual(
  JSON.parse(JSON.stringify(qrCacheContext.tokenUrls)),
  [`https://dalatgolfvoucher.com/menu.html#t=${"a".repeat(64)}`, null, null],
  "server token values must be lowercase 64-hex strings before entering the browser cache",
);
assert.equal(qrCacheContext.cachedEntries.length, 100, "the browser QR cache must stay bounded");
assert.equal(qrCacheContext.newestCachedUrl, `https://dalatgolfvoucher.com/menu.html#t=${"a".repeat(64)}`);
assert.equal(qrCacheContext.oldestCachedUrl, null, "the oldest cached table must be evicted at the limit");
assert.deepEqual([...cacheStorage.keys()], ["dgv.table-qr-cache.v1"], "table QR URLs must use one versioned storage key");

// Menu photo uploads are re-encoded in the browser and sent to a narrowly
// configured public asset bucket. Public URLs can be rendered on the guest menu,
// but Storage listing and every write remain authenticated-admin only.
assert.match(menuAdminHtml, /id="menuImageFile"[^>]*type="file"[^>]*accept="image\/jpeg,image\/png,image\/webp"/i);
assert.match(menuAdminHtml, /id="menuImagePreview"/i);
assert.doesNotMatch(menuAdminHtml, /id="uploadImageBtn"/i);
assert.match(menuAdminHtml, /사진을 선택한 뒤 메뉴 저장을 누르면[^<]*자동 업로드/i);
assert.match(menuAdminSource, /const IMAGE_BUCKET = "qr-menu-images"/);
assert.match(menuAdminSource, /MAX_SOURCE_IMAGE_BYTES = 20 \* 1024 \* 1024/);
assert.match(menuAdminSource, /MAX_UPLOAD_IMAGE_BYTES = 4_750_000/);
assert.match(menuAdminSource, /global\.createImageBitmap\(file, \{ imageOrientation: "from-image" \}\)/);
assert.match(menuAdminSource, /canvas\.toBlob\([\s\S]*?"image\/webp"/);
assert.match(menuAdminSource, /\.from\(IMAGE_BUCKET\)[\s\S]*?\.upload\(objectPath, prepared\.blob,[\s\S]*?contentType: "image\/webp"[\s\S]*?upsert: false/);
assert.match(menuAdminSource, /getPublicUrl\(storedPath\)/);
assert.match(menuAdminSource, /async function saveMenu[\s\S]*?if \(file\)[\s\S]*?await uploadMenuImage\(file,[\s\S]*?next\.image_url = uploaded\.publicUrl[\s\S]*?sb\.rpc\("app_(?:create|update)_menu_item"/);
assert.match(menuAdminSource, /menuSaved = true;[\s\S]*?ui\.byId\("imageUrl"\)\.value = next\.image_url/);
assert.match(menuAdminSource, /uploadedObjectPath && !menuSaved[\s\S]*?safeToCompensate = !dbWriteAttempted \|\| isConfirmedDatabaseRejection\(error\)[\s\S]*?if \(safeToCompensate\) await removeMenuImageObject\(uploadedObjectPath\)/);
assert.match(menuAdminSource, /function isConfirmedDatabaseRejection[\s\S]*?\^\[0-9A-Z\]\{5\}\$[\s\S]*?\^PGRST\\d\{3\}\$/);
assert.match(menuAdminSource, /renderImagePreview\(selectedImagePreviewUrl, \{ trustedBlob: true \}\)[\s\S]*?선택한 사진은 유지/);
assert.match(menuAdminSource, /previousImageUrl && previousImageUrl !== next\.image_url[\s\S]*?removePreviousImageIfUnreferenced\(previousImageUrl\)/);
assert.match(menuAdminSource, /async function removePreviousImageIfUnreferenced[\s\S]*?managedImageObjectPath\(imageUrl\)[\s\S]*?countManagedImageObjectReferences\(objectPath\)[\s\S]*?removeMenuImageObject\(objectPath\)/);
assert.match(menuAdminSource, /async function countManagedImageObjectReferences[\s\S]*?collectSupabasePages[\s\S]*?select\("id,image_url"\)[\s\S]*?referencedManagedImageObjectPath\(row\.image_url\) === objectPath/);
assert.match(menuAdminSource, /\.from\(IMAGE_BUCKET\)\.remove\(\[normalizedPath\]\)/);
assert.doesNotMatch(`${menuAdminHtml}\n${menuAdminSource}`, /service[_-]?role/i);

// Menu deletion is a reversible archive operation. The row, price, image path,
// and historical order references must remain intact, and only admins may call
// the narrowly scoped RPCs.
assert.match(menuAdminHtml, /id="archivedMenuToggleBtn"[^>]*>삭제 메뉴 보기</i);
assert.match(menuAdminHtml, /id="archiveMenuBtn"[^>]*hidden[^>]*>메뉴 삭제</i);
assert.match(menuAdminHtml, /id="restoreMenuBtn"[^>]*hidden[^>]*>메뉴 복구</i);
assert.match(menuAdminSource, /query = showArchivedMenus[\s\S]*?query\.not\("archived_at", "is", null\)[\s\S]*?query\.is\("archived_at", null\)/);
assert.match(menuAdminSource, /async function archiveMenu[\s\S]*?global\.confirm\([\s\S]*?가격, 사진, 기존 주문 기록은 삭제되지 않습니다[\s\S]*?sb\.rpc\("app_archive_menu_item"/);
assert.match(menuAdminSource, /async function restoreMenu[\s\S]*?global\.confirm\([\s\S]*?sb\.rpc\("app_restore_menu_item"[\s\S]*?showArchivedMenus = false/);
assert.doesNotMatch(functionSource(menuAdminSource, "archiveMenu"), /removeMenuImageObject|\.storage\b/);
assert.doesNotMatch(functionSource(menuAdminSource, "restoreMenu"), /removeMenuImageObject|\.storage\b/);

assert.match(archiveMigration, /add column if not exists archived_at timestamp with time zone\s*;/i);
assert.doesNotMatch(archiveMigration, /archived_at timestamp with time zone[^;]*default/i);
assert.match(archiveMigration, /menu_items_archived_state_check[\s\S]*?archived_at is null[\s\S]*?is_active is false[\s\S]*?is_orderable is false[\s\S]*?is_sold_out is true/i);
assert.match(archiveMigration, /create trigger trg_menu_items_archive_state[\s\S]*?before insert or update of archived_at, is_active, is_orderable, is_sold_out/i);
assert.match(archiveMigration, /create function private\.app_archive_menu_item_impl\(p_item_id uuid\)[\s\S]*?security definer[\s\S]*?auth\.uid\(\)[\s\S]*?has_app_role\(array\['admin'\]::text\[\]\)[\s\S]*?archived_at = coalesce\(menu\.archived_at, now\(\)\)[\s\S]*?is_active = false[\s\S]*?is_orderable = false[\s\S]*?is_sold_out = true/i);
assert.match(archiveMigration, /create function private\.app_restore_menu_item_impl\(p_item_id uuid\)[\s\S]*?security definer[\s\S]*?auth\.uid\(\)[\s\S]*?has_app_role\(array\['admin'\]::text\[\]\)[\s\S]*?archived_at = null[\s\S]*?menu\.archived_at is not null/i);
for (const rpc of ["app_archive_menu_item", "app_restore_menu_item"]) {
  assert.match(archiveMigration, new RegExp(`revoke execute on function public\\.${rpc}\\(uuid\\)[\\s\\S]*?from public, anon, authenticated, service_role`, "i"));
  assert.match(archiveMigration, new RegExp(`grant execute on function public\\.${rpc}\\(uuid\\)[\\s\\S]*?to authenticated`, "i"));
}
assert.doesNotMatch(archiveMigration, /(?:delete from|truncate table)\s+public\.(?:menu_items|orders|order_items|order_custom_items)/i);
assert.doesNotMatch(archiveMigration, /storage\.(?:objects|buckets)|image_url\s*=/i);

const rejectionContext = { String };
vm.runInNewContext(
  `${functionSource(menuAdminSource, "isConfirmedDatabaseRejection")}\nrejections = candidates.map(isConfirmedDatabaseRejection);`,
  Object.assign(rejectionContext, {
    candidates: [{ code: "23505" }, { code: "PGRST116" }, { code: "" }, { message: "TypeError: Failed to fetch" }],
  }),
);
assert.deepEqual(
  JSON.parse(JSON.stringify(rejectionContext.rejections)),
  [true, true, false, false],
  "only confirmed database/PostgREST rejections may trigger compensation deletion",
);

const managedImageContext = {
  URL,
  String,
  SUPABASE_ORIGIN: "https://project.supabase.co",
  IMAGE_PUBLIC_PATH_PREFIX: "/storage/v1/object/public/qr-menu-images/",
  MANAGED_IMAGE_OBJECT_PATH: /^menus\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:jpe?g|png|webp)$/,
};
const canonicalManagedImage = "https://project.supabase.co/storage/v1/object/public/qr-menu-images/menus/123e4567-e89b-42d3-a456-426614174000.webp";
vm.runInNewContext(
  `${functionSource(menuAdminSource, "managedImageObjectPath")}\nresults = candidates.map(managedImageObjectPath);`,
  Object.assign(managedImageContext, {
    candidates: [
      canonicalManagedImage,
      "image/restaurant/qr-menu/local.webp",
      "http://project.supabase.co/storage/v1/object/public/qr-menu-images/menus/123e4567-e89b-42d3-a456-426614174000.webp",
      "https://project.supabase.co.evil.example/storage/v1/object/public/qr-menu-images/menus/123e4567-e89b-42d3-a456-426614174000.webp",
      "https://other.supabase.co/storage/v1/object/public/qr-menu-images/menus/123e4567-e89b-42d3-a456-426614174000.webp",
      "https://project.supabase.co/storage/v1/object/sign/qr-menu-images/menus/123e4567-e89b-42d3-a456-426614174000.webp",
      `${canonicalManagedImage}?download=1`,
      `${canonicalManagedImage}#preview`,
      "https://project.supabase.co/storage/v1/object/public/qr-menu-images/menus%2F123e4567-e89b-42d3-a456-426614174000.webp",
      "https://project.supabase.co/storage/v1/object/public/qr-menu-images/menus/123E4567-E89B-42D3-A456-426614174000.webp",
    ],
  }),
);
assert.deepEqual(
  JSON.parse(JSON.stringify(managedImageContext.results)),
  ["menus/123e4567-e89b-42d3-a456-426614174000.webp", null, null, null, null, null, null, null, null, null],
  "only canonical images from this project's managed bucket may be deleted",
);

vm.runInNewContext(
  `${functionSource(menuAdminSource, "referencedManagedImageObjectPath")}\nreferenceResults = candidates.map(referencedManagedImageObjectPath);`,
  Object.assign(managedImageContext, {
    candidates: [
      canonicalManagedImage,
      `${canonicalManagedImage}?download=1`,
      "https://project.supabase.co/storage/v1/object/public/qr-menu-images/menus%2F123e4567-e89b-42d3-a456-426614174000.webp",
      "https://other.supabase.co/storage/v1/object/public/qr-menu-images/menus/123e4567-e89b-42d3-a456-426614174000.webp",
      "image/restaurant/qr-menu/local.webp",
    ],
  }),
);
assert.deepEqual(
  JSON.parse(JSON.stringify(managedImageContext.referenceResults)),
  [
    "menus/123e4567-e89b-42d3-a456-426614174000.webp",
    "menus/123e4567-e89b-42d3-a456-426614174000.webp",
    "menus/123e4567-e89b-42d3-a456-426614174000.webp",
    null,
    null,
  ],
  "alternate URLs that still reference the same managed object must block deletion",
);

assert.match(storageMigration, /insert into storage\.buckets[\s\S]*?'qr-menu-images'[\s\S]*?true,[\s\S]*?5242880,[\s\S]*?array\['image\/jpeg', 'image\/png', 'image\/webp'\]/i);
assert.doesNotMatch(storageMigration, /image\/svg|\.svg/i);
assert.doesNotMatch(storageMigration, /\bto\s+anon\b/i);
for (const operation of ["select", "insert", "update", "delete"]) {
  assert.match(
    storageMigration,
    new RegExp(`create policy qr_menu_images_admin_${operation}[\\s\\S]*?on storage\\.objects[\\s\\S]*?for ${operation}[\\s\\S]*?to authenticated[\\s\\S]*?bucket_id = 'qr-menu-images'[\\s\\S]*?has_app_role\\(array\\['admin'\\]::text\\[\\]\\)`, "i"),
  );
}
assert.match(storageMigration, /qr_menu_images_admin_update[\s\S]*?using \([\s\S]*?\)[\s\S]*?with check \(/i);
assert.match(storageMigration, /name ~ '\^menus\/[\s\S]*?\\\.\(jpe\?g\|png\|webp\)\$'/i);
assert.doesNotMatch(storageMigration, /(?:delete from|truncate table)\s+public\.menu_items/i);

// PDF metadata migration may enrich only descriptive/QR fields. It must not
// assign either price column, and every referenced image must exist locally.
const metadataUpdate = metadataMigration.slice(metadataMigration.indexOf("update public.menu_items"));
assert.ok(metadataUpdate.length > 0, "metadata UPDATE is missing");
assert.doesNotMatch(metadataUpdate, /price_(?:usd|vnd)\s*=/i);
assert.doesNotMatch(metadataMigration, /(?:delete from|truncate table)\s+public\.menu_items/i);
assert.match(metadataMigration, /v_stage_count <> 48 or v_bad_name_count <> 0/i);
assert.match(metadataMigration, /having count\(menu\.id\) <> 1/i);
assert.match(metadataMigration, /v_matched_rows <> 48 or v_distinct_images <> 48/i);
const metadataDefinition = metadataMigration.slice(0, metadataMigration.indexOf("update public.menu_items"));
const metadataImages = [...metadataDefinition.matchAll(/'(image\/restaurant\/qr-menu\/[^']+\.webp)'/g)]
  .map((match) => match[1]);
assert.equal(metadataImages.length, 48, "all 48 DB-backed menu rows need image metadata");
assert.equal(new Set(metadataImages).size, metadataImages.length, "metadata image paths must be unique");
await Promise.all(metadataImages.map((file) => access(path.join(projectRoot, file))));
const extractedImages = (await readdir(path.join(projectRoot, "image/restaurant/qr-menu")))
  .filter((file) => file.endsWith(".webp"));
assert.ok(extractedImages.length >= metadataImages.length);

// The final cafe PDF is added without changing any of the 48 pre-existing
// menu rows. Size variants are separate server-priced rows, and all five
// illustrations are local assets rather than remote tracking/image services.
assert.doesNotMatch(cafeMigration, /(?:update|delete from|truncate table)\s+public\.menu_items/i);
assert.match(cafeMigration, /insert into public\.menu_items\s*\(/i);
assert.match(cafeMigration, /v_total <> 47[\s\S]*?v_500ml <> 20[\s\S]*?v_700ml <> 20[\s\S]*?v_fixed <> 7/i);
assert.match(cafeMigration, /greatest\(1,\s*round\(staged\.price_vnd::numeric\s*\/\s*25000::numeric\)::integer\)/i);
assert.match(cafeMigration, /existing\.is_active is true[\s\S]*?existing\.is_orderable is true[\s\S]*?existing\.is_sold_out is false[\s\S]*?existing\.archived_at is null/i);
assert.match(cafeMigration, /inserted\.is_active is true[\s\S]*?inserted\.is_orderable is true[\s\S]*?inserted\.is_sold_out is false[\s\S]*?inserted\.archived_at is null/i);
for (const item of ["콜라", "스프라이트", "스팅", "레드불", "생수", "아보카도 코코넛 아이스크림", "얼음 컵"]) {
  assert.match(cafeMigration, new RegExp(`'${item}'`));
}
const cafeManifest = cafeMigration.slice(cafeMigration.indexOf("values"), cafeMigration.indexOf("-- Validate"));
const cafeStageRows = [...cafeManifest.matchAll(/^\s*\(\d+,\s*(?:500|700|null),/gm)];
assert.equal(cafeStageRows.length, 47, "the cafe migration must stage exactly 47 orderable choices");
const cafeImages = [...new Set([...cafeMigration.matchAll(/'(image\/restaurant\/qr-menu\/cafe\/[^']+\.webp)'/g)]
  .map((match) => match[1]))];
assert.deepEqual(cafeImages.sort(), [
  "image/restaurant/qr-menu/cafe/coffee.webp",
  "image/restaurant/qr-menu/cafe/drinks-ice-cream.webp",
  "image/restaurant/qr-menu/cafe/juice.webp",
  "image/restaurant/qr-menu/cafe/milk-tea.webp",
  "image/restaurant/qr-menu/cafe/smoothies.webp",
]);
await Promise.all(cafeImages.map((file) => access(path.join(projectRoot, file))));
assert.match(guestSource, /cafe:\s*\{\s*ko:\s*"카페",\s*en:\s*"Cafe",\s*vi:\s*"Cà phê & đồ uống"\s*\}/);

// The additive inbox migration keeps old `card` calls fee-free, introduces an
// explicit card_fee7 choice, and stores both choices as the existing `card`
// ledger value. Staff/admin authorization remains app_metadata + auth.uid based.
assert.match(inboxAccessMigration, /create or replace function private\.app_update_qr_order_status_impl[\s\S]*?security definer[\s\S]*?set search_path = ''/i);
assert.match(inboxAccessMigration, /create or replace function private\.app_finalize_qr_order_checked_impl[\s\S]*?security definer[\s\S]*?set search_path = ''/i);
assert.match(inboxAccessMigration, /create or replace function private\.app_finalize_qr_order_checked_impl[\s\S]*?\(select auth\.uid\(\)\) is null[\s\S]*?has_app_role\(array\['staff', 'admin'\]::text\[\]\)/i);
assert.match(inboxAccessMigration, /v_payment_choice not in \('cash', 'card', 'card_fee7', 'bank'\)/i);
assert.match(inboxAccessMigration, /when v_payment_choice = 'card_fee7' then 'card'[\s\S]*?else v_payment_choice/i);
assert.match(inboxAccessMigration, /add column if not exists finalized_payment_choice text/i);
assert.match(inboxAccessMigration, /finalized_payment_choice in \('cash', 'card', 'card_fee7', 'bank'\)/i);
assert.match(inboxAccessMigration, /if v_payment_choice = 'card_fee7' then[\s\S]*?round\(v_base_usd::numeric \* 1\.07\)[\s\S]*?round\(\(v_base_vnd::numeric \* 1\.07\) \/ 1000\) \* 1000/i);
assert.doesNotMatch(inboxAccessMigration, /if v_payment_(?:choice|method) = 'card' then/i, "legacy card must stay fee-free");
assert.match(inboxAccessMigration, /'fee7',[\s\S]*?'Service fee 7%',[\s\S]*?'Phí dịch vụ 7%'/i);
assert.match(
  inboxAccessMigration,
  /if v_qr_order\.finalized_order_id is not null then[\s\S]*?from public\.orders[\s\S]*?v_existing_choice := v_qr_order\.finalized_payment_choice[\s\S]*?if v_existing_choice is null then[\s\S]*?paid_item\.kind = 'fee7'[\s\S]*?paid_item\.ko_name = 'Service fee 7%'[\s\S]*?v_existing_choice is distinct from v_payment_choice[\s\S]*?v_paid_order\.guide_name is distinct from v_guide_name[\s\S]*?v_paid_order\.team_no is distinct from v_team_no[\s\S]*?errcode = '55000'[\s\S]*?return v_qr_order\.finalized_order_id/i,
  "finalization retry must return an existing UUID only for the same payment choice and metadata",
);
assert.match(
  inboxAccessMigration,
  /return v_qr_order\.finalized_order_id;[\s\S]*?end if;\s*if v_qr_order\.updated_at is distinct from p_expected_updated_at then[\s\S]*?errcode = '55000'/i,
  "same-request finalized retries must resolve before unfinished-row stale checks",
);
assert.match(inboxAccessMigration, /update public\.qr_orders[\s\S]*?finalized_order_id = v_paid_order\.id,[\s\S]*?finalized_payment_choice = v_payment_choice/i);
assert.match(inboxAccessMigration, /sum\(i\.line_usd::bigint\)[\s\S]*?sum\(i\.line_vnd::bigint\)[\s\S]*?v_base_usd <> v_qr_order\.total_usd::bigint[\s\S]*?v_base_vnd <> v_qr_order\.total_vnd::bigint/i);
assert.match(inboxAccessMigration, /v_paid_order\.total_usd::bigint <> v_paid_usd[\s\S]*?v_paid_order\.total_vnd::bigint <> v_paid_vnd/i);
assert.match(inboxAccessMigration, /v_order\.status in \('submitted', 'accepted'\)[\s\S]*?v_target = 'cancelled'/i);
assert.doesNotMatch(inboxAccessMigration, /v_role = 'admin'[\s\S]*?v_target = 'cancelled'/i);
assert.doesNotMatch(inboxAccessMigration, /public\.app_create_order\(/i, "staff finalization must not widen the admin order-creation RPC");
assert.doesNotMatch(inboxAccessMigration, /(?:delete from|truncate table|drop table)\s+/i);
assert.doesNotMatch(inboxAccessMigration, /grant execute[\s\S]*?\bto\s+anon\b/i);
for (const signature of [
  "private\\.app_update_qr_order_status_impl\\(uuid, text\\)",
  "private\\.app_finalize_qr_order_checked_impl\\(uuid, timestamp with time zone, text, text, text\\)",
  "private\\.app_finalize_qr_order_impl\\(uuid, text, text, text\\)",
  "public\\.app_update_qr_order_status\\(uuid, text\\)",
  "public\\.app_finalize_qr_order_checked\\(uuid, timestamp with time zone, text, text, text\\)",
  "public\\.app_finalize_qr_order\\(uuid, text, text, text\\)",
]) {
  assert.match(inboxAccessMigration, new RegExp(`revoke execute on function ${signature}[\\s\\S]*?from public, anon, service_role`, "i"));
  assert.match(inboxAccessMigration, new RegExp(`grant execute on function ${signature}[\\s\\S]*?to authenticated`, "i"));
}
assert.match(
  inboxAccessMigration,
  /create or replace function public\.app_finalize_qr_order_checked\([\s\S]*?p_expected_updated_at timestamp with time zone[\s\S]*?select private\.app_finalize_qr_order_checked_impl\([\s\S]*?p_expected_updated_at/i,
);
assert.match(
  inboxAccessMigration,
  /create or replace function private\.app_finalize_qr_order_impl\([\s\S]*?select qr_order\.updated_at[\s\S]*?return private\.app_finalize_qr_order_checked_impl\([\s\S]*?v_expected_updated_at/i,
  "legacy RPC must delegate into the checked core during the DB-first compatibility window",
);
assert.ok(
  finalizeCutoverMigrationFile > "20260926172000_qr_inbox_order_edit.sql",
  "legacy finalize revocation must remain a post-frontend-deploy migration",
);
for (const signature of [
  "public\\.app_finalize_qr_order\\(uuid, text, text, text\\)",
  "private\\.app_finalize_qr_order_impl\\(uuid, text, text, text\\)",
]) {
  assert.match(
    finalizeCutoverMigration,
    new RegExp(`revoke execute on function ${signature}[\\s\\S]*?from public, anon, authenticated, service_role`, "i"),
  );
}
assert.doesNotMatch(finalizeCutoverMigration, /grant execute/i);

// A raw table token still travels only through the existing Edge Function.
// The service-only hash RPC adds a bounded view of immutable snapshots for
// submitted/accepted orders and excludes finalized/cancelled orders.
assert.match(
  guestOpenOrdersMigration,
  /create or replace function public\.internal_qr_get_menu\(p_token_hash text\)[\s\S]*?security invoker[\s\S]*?set search_path = ''/i,
);
assert.match(
  guestOpenOrdersMigration,
  /join private\.qr_table_tokens as tokens on tokens\.table_id = t\.id[\s\S]*?tokens\.token_hash = p_token_hash[\s\S]*?t\.is_active = true/i,
);
assert.match(
  guestOpenOrdersMigration,
  /from public\.qr_orders as qr_order[\s\S]*?qr_order\.table_id = v_table\.id[\s\S]*?qr_order\.status in \('submitted', 'accepted'\)[\s\S]*?qr_order\.finalized_order_id is null[\s\S]*?limit 20/i,
);
assert.match(
  guestOpenOrdersMigration,
  /from public\.qr_order_items as item[\s\S]*?item\.qr_order_id = open_order\.id[\s\S]*?limit 40/i,
);
assert.match(guestOpenOrdersMigration, /'current_orders', v_current_orders[\s\S]*?'current_orders_truncated', v_current_orders_truncated/i);
for (const forbiddenKey of ["request_hash", "client_request_id", "note", "qr_order_id", "menu_item_id"]) {
  assert.doesNotMatch(
    guestOpenOrdersMigration,
    new RegExp(`'${forbiddenKey}'\\s*,`, "i"),
    `guest current-order JSON must not expose ${forbiddenKey}`,
  );
}
assert.match(
  guestOpenOrdersMigration,
  /revoke execute on function public\.internal_qr_get_menu\(text\)[\s\S]*?from public, anon, authenticated, service_role[\s\S]*?grant execute on function public\.internal_qr_get_menu\(text\)[\s\S]*?to service_role/i,
);
assert.doesNotMatch(guestOpenOrdersMigration, /grant execute[\s\S]*?\bto\s+(?:anon|authenticated)\b/i);
assert.doesNotMatch(guestOpenOrdersMigration, /(?:delete from|truncate table|drop table|update public\.qr_orders|insert into public\.qr_orders)\s+/i);

assert.match(menuHtml, /id="currentOrdersSection"[\s\S]*?id="currentOrdersList"[^>]*aria-live="polite"/i);
assert.match(guestSource, /const CURRENT_ORDER_POLL_MS = 15000/);
assert.match(functionSource(guestSource, "requestMenuPayload"), /apiRequest\([\s\S]*?action: "get_menu"[\s\S]*?table_token: state\.token/);
assert.doesNotMatch(guestSource, /\.from\(["']qr_orders["']\)/, "guest browser must not query QR order tables directly");
assert.match(functionSource(guestSource, "normalizeCurrentOrders"), /\["submitted", "accepted"\]\.includes\(order\.status\)/);
assert.match(functionSource(guestSource, "normalizeCurrentOrders"), /slice\(0, MAX_CURRENT_ORDERS\)[\s\S]*?slice\(0, MAX_CURRENT_ORDER_LINES\)/);
assert.match(functionSource(guestSource, "renderCurrentOrders"), /replaceChildren\(\)[\s\S]*?state\.currentOrders\.forEach/);
assert.doesNotMatch(functionSource(guestSource, "renderCurrentOrders"), /innerHTML|insertAdjacentHTML/);
assert.match(functionSource(guestSource, "startCurrentOrderPolling"), /setInterval\([\s\S]*?document\.visibilityState === "visible"[\s\S]*?CURRENT_ORDER_POLL_MS/);
assert.match(guestSource, /document\.addEventListener\("visibilitychange"[\s\S]*?refreshCurrentOrders\(\)/);
assert.match(functionSource(guestSource, "submitOrder"), /state\.cart = \[\][\s\S]*?sessionStorage\?\.removeItem[\s\S]*?setTimeout\(refreshCurrentOrders, 0\)/);

const currentOrderContext = {};
vm.runInNewContext(
  `const MAX_CURRENT_ORDERS = 20; const MAX_CURRENT_ORDER_LINES = 40; const MAX_QTY = 20;\n${functionSource(guestSource, "nonNegativeInteger")}\n${functionSource(guestSource, "normalizeCurrentOrders")}\nresult = normalizeCurrentOrders([{order_number:"A1",status:"accepted",total_vnd:107000,items:[{ko_name:"김밥",qty:1,line_vnd:107000}]},{order_number:"OLD",status:"cancelled",items:[{ko_name:"김밥",qty:1}]}]);`,
  currentOrderContext,
);
assert.deepEqual(
  JSON.parse(JSON.stringify(currentOrderContext.result)),
  [{
    order_number: "A1",
    status: "accepted",
    total_usd: 0,
    total_vnd: 107000,
    submitted_at: "",
    accepted_at: null,
    items: [{
      menu_type: "",
      ko_name: "김밥",
      vi_name: "",
      en_name: "",
      qty: 1,
      unit_usd: 0,
      unit_vnd: 0,
      line_usd: 0,
      line_vnd: 107000,
    }],
  }],
  "guest normalization must keep only bounded open-order snapshots",
);

const cardFeeContext = { Math, Number };
vm.runInNewContext(
  `${functionSource(inboxSource, "roundVndToThousand")}\n${functionSource(inboxSource, "cardAdjustedTotals")}\nresult = cardAdjustedTotals(100, 100000);`,
  cardFeeContext,
);
assert.deepEqual(
  JSON.parse(JSON.stringify(cardFeeContext.result)),
  { totalUsd: 107, totalVnd: 107000 },
  "inbox card fee must use calc-compatible USD integer and VND 1,000 rounding",
);

console.log("QR ordering security, pricing, table identity, realtime, and guest payload contracts passed.");

