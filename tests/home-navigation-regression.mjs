import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFile(path.join(projectRoot, file), "utf8");
const [staffHome, managerHome, adminHome] = await Promise.all([
  read("home.html"),
  read("home_manager.html"),
  read("home_admin.html"),
]);

function hrefs(html) {
  return [...html.matchAll(/<a\b[^>]*\bhref="([^"]+)"/g)].map((match) => match[1]);
}

function sectionHtml(html, titleId, nextTitleId) {
  const start = html.indexOf(`aria-labelledby="${titleId}"`);
  assert.notEqual(start, -1, `missing ${titleId} section`);
  const end = nextTitleId ? html.indexOf(`aria-labelledby="${nextTitleId}"`, start + 1) : html.length;
  assert.notEqual(end, -1, `missing section after ${titleId}`);
  return html.slice(start, end);
}

assert.match(staffHome, /<body class="locked">/);
assert.match(
  staffHome,
  /QRStaff\.requireLogin\(\{\s*roles:\["staff", "manager", "admin"\],\s*preferredRole:"staff"\s*\}\)/,
  "staff home must reuse the staff password while allowing verified manager and admin sessions",
);
assert.deepEqual(
  hrefs(staffHome),
  ["calc.html", "order_inbox.html", "reserv_check.html", "notice.html", "expense.html"],
  "staff home must expose only the five approved staff destinations",
);
assert.doesNotMatch(staffHome, /href="(?:admin|menu_admin|hana_[^"]+|reservation|reserv_admin|golf_reserv|report|code_admin)\.html"/);

assert.match(managerHome, /<body class="locked">/);
assert.match(
  managerHome,
  /QRStaff\.requireLogin\(\{\s*roles:\["manager", "admin"\],\s*preferredRole:"manager"\s*\}\)/,
  "manager home must accept the manager password and an already verified administrator session",
);
assert.deepEqual(
  hrefs(managerHome),
  [
    "home.html",
    "calc.html",
    "order_inbox.html",
    "menu_admin.html",
    "admin.html",
    "reserv_check.html",
    "expense.html",
    "reservation.html",
    "reserv_admin.html",
    "notice.html",
    "index.html",
    "restaurant.html",
    "golf.html",
    "hotel.html",
    "car.html",
    "package.html",
  ],
  "manager home must expose the approved administrator destinations in their existing section order",
);
assert.doesNotMatch(
  managerHome,
  /href="(?:hana_reserv_check_hidden|hana_admin_hidden|hana_reserv_admin_hidden|report|code_admin)\.html"/,
  "manager home must not expose Hidden, monthly KB settlement, or password-management pages",
);
assert.doesNotMatch(managerHome, /hiddenView|· Hidden|월간 정산 · KB|접근 비밀번호 관리/);

assert.match(adminHome, /<body class="locked">/);
assert.match(
  adminHome,
  /QRStaff\.requireLogin\(\{\s*roles:\["admin"\],\s*preferredRole:"admin"\s*\}\)/,
  "administrator home must require the administrator role",
);

const requiredAdminDestinations = [
  "home.html",
  "calc.html",
  "order_inbox.html",
  "menu_admin.html",
  "admin.html",
  "hana_admin_hidden.html",
  "report.html",
  "expense.html",
  "reserv_check.html",
  "hana_reserv_check_hidden.html",
  "reservation.html",
  "reserv_admin.html",
  "golf_reserv.html",
  "golf_reserv_list.html",
  "hana_reserv_admin_hidden.html",
  "notice.html",
  "code_admin.html",
  "index.html",
  "restaurant.html",
  "golf.html",
  "hotel.html",
  "car.html",
  "package.html",
];
const adminDestinations = hrefs(adminHome);
for (const destination of requiredAdminDestinations) {
  assert.ok(adminDestinations.includes(destination), `administrator home is missing ${destination}`);
}
assert.deepEqual(
  hrefs(sectionHtml(adminHome, "salesTitle", "reservationTitle")),
  ["admin.html", "reserv_check.html", "expense.html"],
  "sales section must keep the requested manager, staff reservation, and expense order",
);
assert.deepEqual(
  hrefs(sectionHtml(adminHome, "reservationTitle", "settingsTitle")),
  [
    "hana_reserv_check_hidden.html",
    "hana_admin_hidden.html",
    "reservation.html",
    "reserv_admin.html",
    "golf_reserv.html",
    "golf_reserv_list.html",
    "hana_reserv_admin_hidden.html",
    "report.html",
  ],
  "reservation section must keep the requested original views and monthly KB settlement order",
);
assert.match(adminHome, /href="hana_admin_hidden\.html"[\s\S]*?<span class="name">매출 원본 조회 · Hidden<\/span>/);
assert.match(adminHome, /href="report\.html"[\s\S]*?<span class="name">월간 정산 · KB<\/span>/);
assert.match(adminHome, /href="golf_reserv\.html"[\s\S]*?<span class="name">골프 예약 관리<\/span>/);
assert.match(adminHome, /href="golf_reserv_list\.html"[\s\S]*?<span class="name">골프 예약 한 줄 목록<\/span>/);
assert.doesNotMatch(managerHome, /href="golf_reserv\.html"/, "manager home must not expose golf reservation management");
assert.doesNotMatch(managerHome, /href="golf_reserv_list\.html"/, "manager home must not expose golf reservation one-row list");
assert.doesNotMatch(adminHome, /href="menu\.html"/, "tokenized customer menu must not be linked without a QR token");

for (const html of [staffHome, managerHome, adminHome]) {
  assert.match(html, /@supabase\/supabase-js@2\.112\.2/);
  assert.match(html, /assets\/supabase-config\.js/);
  assert.match(html, /assets\/dgv-data\.js/);
  assert.match(html, /assets\/supabase-client\.js/);
  assert.match(html, /assets\/qr-staff\.js/);
  assert.match(html, /id="loginForm"/);
  assert.match(html, /id="loginPassword"[^>]*autocomplete="current-password"/);
  assert.match(html, /document\.body\.classList\.remove\("locked"\)/);
  assert.doesNotMatch(html, /sessionStorage\.setItem\([^\n]*(?:pass|password|code)/i);
}

console.log("Staff, manager, and administrator home navigation/auth contracts verified.");

