import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFile(path.join(projectRoot, file), "utf8");
const [staffHome, adminHome] = await Promise.all([
  read("home.html"),
  read("home_admin.html"),
]);

function hrefs(html) {
  return [...html.matchAll(/<a\b[^>]*\bhref="([^"]+)"/g)].map((match) => match[1]);
}

assert.match(staffHome, /<body class="locked">/);
assert.match(
  staffHome,
  /QRStaff\.requireLogin\(\{\s*roles:\["staff", "admin"\],\s*preferredRole:"staff"\s*\}\)/,
  "staff home must reuse the staff password while allowing an already verified admin session",
);
assert.deepEqual(
  hrefs(staffHome),
  ["calc.html", "order_inbox.html", "reserv_check.html"],
  "staff home must expose only the three approved staff destinations",
);
assert.doesNotMatch(staffHome, /href="(?:admin|menu_admin|hana_[^"]+|reservation|reserv_admin|report|code_admin)\.html"/);

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
  "reserv_check.html",
  "hana_reserv_check_hidden.html",
  "reservation.html",
  "reserv_admin.html",
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
assert.doesNotMatch(adminHome, /href="menu\.html"/, "tokenized customer menu must not be linked without a QR token");

for (const html of [staffHome, adminHome]) {
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

console.log("Staff and administrator home navigation/auth contracts verified.");

