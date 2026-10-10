import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const normalHtml = await readFile(path.join(projectRoot, "reserv_admin.html"), "utf8");
const originalHtml = await readFile(
  path.join(projectRoot, "hana_reserv_admin_hidden.html"),
  "utf8",
);
const staffHtml = await readFile(path.join(projectRoot, "reserv_check.html"), "utf8");
const staffOriginalHtml = await readFile(
  path.join(projectRoot, "hana_reserv_check_hidden.html"),
  "utf8",
);
const helperSource = await readFile(
  path.join(projectRoot, "assets/reservation-visibility.js"),
  "utf8",
);
const staffLookupMigration = await readFile(
  path.join(
    projectRoot,
    "supabase/migrations/20261010035730_reserv_check_sales_exclusion_visibility.sql",
  ),
  "utf8",
);

const context = vm.createContext({});
new vm.Script(helperSource, {
  filename: "assets/reservation-visibility.js",
}).runInContext(context);

const visibility = context.DGV_RESERVATION_VISIBILITY;
assert.ok(visibility, "reservation visibility helper must be exported");

const excludedIds = visibility.buildExcludedOrderIdSet([
  { id: "order-hidden" },
  { id: null },
]);
const fixture = [
  { id: 1, confirmed_order_id: null },
  { id: 2, confirmed_order_id: "order-visible" },
  { id: 3, confirmed_order_id: "order-hidden" },
];

const visibleRows = visibility.applySalesExcludedVisibility(
  fixture,
  excludedIds,
  false,
);
assert.deepEqual(
  Array.from(visibleRows, (row) => row.id),
  [1, 2],
  "normal reservation admin must hide only linked sales-excluded reservations",
);
assert.equal(visibleRows[0].sales_excluded, false);
assert.equal(visibleRows[1].sales_excluded, false);

const originalRows = visibility.applySalesExcludedVisibility(
  fixture,
  excludedIds,
  true,
);
assert.deepEqual(Array.from(originalRows, (row) => row.id), [1, 2, 3]);
assert.equal(originalRows[2].sales_excluded, true);

for (const [file, html] of [
  ["reserv_admin.html", normalHtml],
  ["hana_reserv_admin_hidden.html", originalHtml],
]) {
  assert.match(html, /assets\/reservation-visibility\.js/);
  assert.match(
    html,
    /DGV\.collectSupabasePages\([\s\S]*?\.from\("orders"\)[\s\S]*?\.select\("id"\)[\s\S]*?\.eq\("sales_excluded", true\)[\s\S]*?order:\s*\[\{ column: "id", ascending: true \}\]/,
    `${file} must load every excluded order id with stable pagination`,
  );
  assert.match(html, /loadSalesExcludedOrderIds\(\)/);
  assert.match(html, /applySalesExcludedVisibility\([\s\S]*?excludedOrderIds[\s\S]*?ORIGINAL_VIEW/);
  assert.match(html, /const ORIGINAL_VIEW = document\.body\.dataset\.reservationView === "original"/);
  assert.match(html, /await Promise\.all\(\[/);
  assert.match(html, /const requestId = \+\+LOAD_REQUEST_ID/);
  assert.match(
    html,
    /if\(requestId !== LOAD_REQUEST_ID\) return;[\s\S]*?ROWS = DGV_RESERVATION_VISIBILITY/,
    `${file} must ignore stale list responses`,
  );
  assert.match(html, /document\.addEventListener\("visibilitychange", scheduleVisibleRefresh\)/);
  assert.match(html, /window\.addEventListener\("focus", scheduleVisibleRefresh\)/);
  assert.match(html, /let EDITOR_DIRTY = false/);
  assert.match(html, /let EDITOR_REVISION = 0/);
  assert.match(
    html,
    /if\(!APP_READY \|\| EDITOR_DIRTY \|\| document\.visibilityState !== "visible"\) return/,
    `${file} must not overwrite unsaved editor changes during automatic refresh`,
  );
  assert.match(html, /control\.addEventListener\("input", markDirty\)/);
  assert.match(html, /control\.addEventListener\("change", markDirty\)/);
  assert.match(html, /const automatic = !!\(opts && opts\.automatic\)/);
  assert.match(
    html,
    /if\(automatic && \(EDITOR_DIRTY \|\| editorRevision !== EDITOR_REVISION\)\) return;[\s\S]*?ROWS = DGV_RESERVATION_VISIBILITY/,
    `${file} must discard an automatic response when editing starts in flight`,
  );
  assert.match(
    html,
    /VISIBLE_REFRESH_TIMER = setTimeout\(\(\) => \{\s*if\(!APP_READY \|\| EDITOR_DIRTY \|\| document\.visibilityState !== "visible"\) return;\s*loadList\(\{ preserveSelected:true, automatic:true \}\)/,
    `${file} must recheck dirty state immediately before automatic refresh`,
  );
}

assert.doesNotMatch(normalHtml, /<body[^>]*data-reservation-view="original"/);
assert.match(originalHtml, /<body[^>]*data-reservation-view="original"/);
assert.match(originalHtml, /매출 제외 항목을 포함한 전체 예약입니다\./);
assert.match(originalHtml, /매출 제외됨/);
assert.match(originalHtml, /if\(editor\) editor\.hidden = true/);
assert.match(
  originalHtml,
  /\.forEach\(\(control\) => \{ control\.disabled = true; \}\)/,
  "original reservation page must expose no editable controls",
);
assert.match(
  originalHtml,
  /async function rpc\(fn, body\)\{[\s\S]*?if\(ORIGINAL_VIEW\)[\s\S]*?throw new Error\("원본 조회 화면에서는 예약 데이터를 변경할 수 없습니다\."\)/,
  "original reservation page must block every RPC mutation in code",
);
for (const mutation of [
  "confirmToOrders",
  "unconfirmReservation",
  "saveUpdate",
  "deleteSelected",
]) {
  assert.match(
    originalHtml,
    new RegExp(`async function ${mutation}\\(\\)\\{\\s*if\\(!canEditReservation\\(\\)\\) return;`),
    `${mutation} must stop immediately in original view`,
  );
}

for (const [file, html] of [
  ["reserv_check.html", staffHtml],
  ["hana_reserv_check_hidden.html", staffOriginalHtml],
]) {
  assert.match(html, /assets\/reservation-visibility\.js/);
  assert.match(html, /confirmed_order_id/);
  assert.match(html, /sb\.rpc\("app_get_reservation_sales_excluded_ids"/);
  assert.match(html, /p_order_ids:\s*chunk/);
  assert.match(html, /start \+= 500/);
  assert.match(html, /linkedOrderIds\.slice\(start, start \+ 500\)/);
  assert.match(html, /excludedOrders\.push\(\{ id: row\.order_id \}\)/);
  assert.doesNotMatch(
    html,
    /\.from\("orders"\)/,
    `${file} must not bypass the staff orders RLS boundary`,
  );
  assert.match(html, /const requestId = \+\+LOAD_REQUEST_ID/);
  assert.ok(
    (html.match(/if\(requestId !== LOAD_REQUEST_ID\) return;/g) || []).length >= 2,
    `${file} must reject stale reservation and exclusion responses`,
  );
  assert.match(
    html,
    /applySalesExcludedVisibility\([\s\S]*?sourceRows[\s\S]*?excludedOrderIds[\s\S]*?ORIGINAL_VIEW/,
  );
  const loadFunction = html.match(
    /async function load\(\)\{([\s\S]*?)\n\s{4}\}\s*\n\s*\n\s*function renderStats\(/,
  );
  assert.ok(loadFunction, `${file} must retain the reservation load function`);
  assert.match(
    loadFunction[1],
    /catch\(error\)\{[\s\S]*?renderLoadError\(\)/,
    `${file} must fail closed instead of showing unfiltered reservations`,
  );
  assert.match(html, /document\.addEventListener\("visibilitychange", scheduleVisibleRefresh\)/);
  assert.match(html, /window\.addEventListener\("focus", scheduleVisibleRefresh\)/);
}

assert.doesNotMatch(staffHtml, /<body[^>]*data-reservation-view="original"/);
assert.match(staffOriginalHtml, /<body[^>]*data-reservation-view="original"/);
assert.match(staffOriginalHtml, /매출 제외 항목을 포함한 전체 예약입니다\./);
assert.match(staffOriginalHtml, /매출 제외됨/);
assert.match(
  staffOriginalHtml,
  /const allowedRoles = ORIGINAL_VIEW \? \["admin"\] : \["staff", "admin"\]/,
  "the original staff-style page must require an administrator session",
);
assert.match(
  staffOriginalHtml,
  /if \(allowedRoles\.includes\(identity\.role\)\) return true/,
  "the original staff-style page must enforce the administrator-only role list",
);
assert.match(
  staffOriginalHtml,
  /DGV\.signInAs\(ORIGINAL_VIEW \? "admin" : "staff", code\.trim\(\)\)/,
);

const normalizedStaffOriginal = staffOriginalHtml
  .replace(/\r\n/g, "\n")
  .replace(
    "<title>HANA - Group Reservations Original</title>",
    "<title>Staff - Group Reservations</title>",
  )
  .replace('<body data-reservation-view="original">', "<body>")
  .replace(
    '<h1>Yêu cầu đặt phòng nhóm - Bản gốc</h1>\n          <div class="sub">매출 제외 항목을 포함한 전체 예약입니다.</div>',
    "<h1>Yêu cầu đặt phòng nhóm</h1>",
  )
  .replace(/[ \t]+$/gm, "")
  .trimEnd();
assert.equal(
  normalizedStaffOriginal,
  staffHtml.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trimEnd(),
  "normal and original staff reservation pages must differ only by the approved title, marker, and banner",
);

assert.match(
  staffLookupMigration,
  /create function private\.app_get_reservation_sales_excluded_ids_impl\([\s\S]*?security definer[\s\S]*?set search_path\s*=\s*''/i,
);
assert.match(
  staffLookupMigration,
  /returns table\s*\(order_id uuid\)/i,
  "the lookup return shape must match the frontend row.order_id mapping",
);
assert.match(
  staffLookupMigration,
  /\(select auth\.uid\(\)\) is null[\s\S]*?v_role not in \('staff', 'admin'\)/i,
);
assert.match(staffLookupMigration, /v_requested_count > 500/);
assert.match(
  staffLookupMigration,
  /join public\.resv_groups[\s\S]*?confirmed_order_id\s*=\s*requested\.order_id[\s\S]*?join public\.orders[\s\S]*?sales_excluded is true/i,
  "the privileged lookup must only reveal requested orders linked to reservations",
);
assert.match(
  staffLookupMigration,
  /create function public\.app_get_reservation_sales_excluded_ids\([\s\S]*?security invoker[\s\S]*?from private\.app_get_reservation_sales_excluded_ids_impl/i,
);
assert.match(
  staffLookupMigration,
  /revoke execute on function private\.app_get_reservation_sales_excluded_ids_impl\(uuid\[\]\)[\s\S]*?from public, anon, authenticated, service_role/i,
);
assert.match(
  staffLookupMigration,
  /revoke execute on function public\.app_get_reservation_sales_excluded_ids\(uuid\[\]\)[\s\S]*?from public, anon, authenticated, service_role/i,
);
assert.match(
  staffLookupMigration,
  /grant execute on function private\.app_get_reservation_sales_excluded_ids_impl\(uuid\[\]\)[\s\S]*?to authenticated/i,
);
assert.match(
  staffLookupMigration,
  /grant execute on function public\.app_get_reservation_sales_excluded_ids\(uuid\[\]\)[\s\S]*?to authenticated/i,
);
assert.doesNotMatch(
  staffLookupMigration,
  /\b(?:update|insert into|delete from)\s+public\./i,
  "the reservation visibility bridge must not mutate application rows",
);

console.log("Reservation sales-exclusion visibility contracts passed.");
