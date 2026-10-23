import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFile(path.join(projectRoot, file), "utf8");

const [config, client, staffUi, home, managerHome, adminHome, calc, admin,
  menuAdminHtml, menuAdminSource, inboxHtml, inboxSource, reservCheck,
  reservation, reservAdmin, notice, expense, hiddenSales, hiddenReservCheck,
  hiddenReservAdmin, report, codeAdmin] = await Promise.all([
  read("assets/supabase-config.js"),
  read("assets/supabase-client.js"),
  read("assets/qr-staff.js"),
  read("home.html"),
  read("home_manager.html"),
  read("home_admin.html"),
  read("calc.html"),
  read("admin.html"),
  read("menu_admin.html"),
  read("assets/menu-admin.js"),
  read("order_inbox.html"),
  read("assets/order-inbox.js"),
  read("reserv_check.html"),
  read("reservation.html"),
  read("reserv_admin.html"),
  read("notice.html"),
  read("expense.html"),
  read("hana_admin_hidden.html"),
  read("hana_reserv_check_hidden.html"),
  read("hana_reserv_admin_hidden.html"),
  read("report.html"),
  read("code_admin.html"),
]);

assert.match(config, /manager:\s*"manager@dgv\.local"/);
assert.match(client, /const VALID_ROLES = Object\.freeze\(\["staff", "manager", "admin"\]\)/);
assert.match(client, /user\?\.app_metadata\?\.role/);
assert.doesNotMatch(client, /user_metadata/);
assert.match(
  client,
  /async function signInAsAny\(roles, password\)[\s\S]*?normalizeRoles\(roles\)[\s\S]*?for \(const role of normalizedRoles\)[\s\S]*?signInAs\(role, password\)/,
  "shared password fields must authenticate against each explicitly allowed technical account",
);
assert.match(client, /signInAsAny,/);
assert.match(
  staffUi,
  /const loginRoles = roleSelect[\s\S]*?\[preferredRole, \.\.\.roles\.filter[\s\S]*?DGV\.signInAsAny\(loginRoles, password\)/,
);

let signedInUser = null;
const loginAttempts = [];
const fakeAuth = {
  async signInWithPassword(credentials) {
    loginAttempts.push(credentials);
    const expected = {
      "manager@example.test": "dgv-v2/manager/manager-secret",
      "admin@example.test": "dgv-v2/admin/admin-secret",
    };
    if (expected[credentials.email] !== credentials.password) {
      return { data: { user: null }, error: new Error("invalid credentials") };
    }
    const role = credentials.email.startsWith("manager") ? "manager" : "admin";
    signedInUser = { email: credentials.email, app_metadata: { role } };
    return { data: { user: signedInUser }, error: null };
  },
  async getSession() {
    return { data: { session: signedInUser ? { access_token: "test" } : null }, error: null };
  },
  async getUser() {
    return { data: { user: signedInUser }, error: signedInUser ? null : new Error("no user") };
  },
  async signOut() {
    signedInUser = null;
    return { error: null };
  },
};
const browserGlobal = {
  DGV_SUPABASE_CONFIG: {
    url: "https://example.supabase.co",
    publishableKey: "public-test",
    authAccounts: {
      staff: "staff@example.test",
      manager: "manager@example.test",
      admin: "admin@example.test",
    },
  },
  DGV_DATA_UTILS: {
    formatLocalYmd() {},
    formatYmdInTimeZone() {},
    collectSupabasePages() {},
    collectRestPages() {},
  },
  supabase: { createClient: () => ({ auth: fakeAuth }) },
  sessionStorage: {},
};
browserGlobal.window = browserGlobal;
vm.runInNewContext(client, { window: browserGlobal, URL });

loginAttempts.length = 0;
const managerIdentity = await browserGlobal.DGV.signInAsAny(["manager", "admin"], "manager-secret");
assert.equal(managerIdentity.role, "manager");
assert.deepEqual(loginAttempts.map(({ email }) => email), ["manager@example.test"]);

signedInUser = null;
loginAttempts.length = 0;
const adminIdentity = await browserGlobal.DGV.signInAsAny(["manager", "admin"], "admin-secret");
assert.equal(adminIdentity.role, "admin");
assert.deepEqual(
  loginAttempts.map(({ email }) => email),
  ["manager@example.test", "admin@example.test"],
  "an administrator password entered in a shared field must fall through the manager account",
);

signedInUser = null;
loginAttempts.length = 0;
await assert.rejects(
  browserGlobal.DGV.signInAsAny(["manager", "admin"], "wrong-secret"),
  /invalid credentials/,
);
assert.deepEqual(loginAttempts.map(({ email }) => email), ["manager@example.test", "admin@example.test"]);

assert.match(home, /roles:\["staff", "manager", "admin"\],\s*preferredRole:"staff"/);
assert.match(managerHome, /roles:\["manager", "admin"\],\s*preferredRole:"manager"/);
assert.match(adminHome, /roles:\["admin"\],\s*preferredRole:"admin"/);

for (const blockedHref of [
  "hana_admin_hidden.html",
  "hana_reserv_check_hidden.html",
  "hana_reserv_admin_hidden.html",
  "report.html",
  "code_admin.html",
]) {
  assert.doesNotMatch(managerHome, new RegExp(`href="${blockedHref.replace(".", "\\.")}"`));
}

assert.match(calc, /\["manager", "admin"\]\.includes\(identity\.role\)/);
assert.match(calc, /DGV\.signInAsAny\(\["manager", "admin"\], pass\)/);
assert.match(admin, /return \["manager", "admin"\]\.includes\(identity\.role\)/);
assert.ok((admin.match(/DGV\.signInAsAny\(\["manager", "admin"\], pass\)/g) || []).length >= 2);
assert.match(menuAdminHtml, /매니저 또는 관리자 비밀번호/);
assert.match(menuAdminSource, /requireLogin\(\{ roles: \["manager", "admin"\], preferredRole: "manager" \}\)/);
assert.match(inboxHtml, /<option value="manager">매니저<\/option>/);
assert.match(inboxSource, /roles: \["staff", "manager", "admin"\]/);
assert.match(inboxSource, /\["manager", "admin"\]\.includes\(identity\.role\)/);
assert.match(reservCheck, /ORIGINAL_VIEW \? \["admin"\] : \["staff", "manager", "admin"\]/);
assert.match(reservCheck, /DGV\.signInAsAny\(loginRoles, code\.trim\(\)\)/);
assert.match(reservation, /DGV\.signInAsAny\(\["manager", "admin"\], pass\)/);
assert.match(reservAdmin, /DGV\.signInAsAny\(\["manager", "admin"\], pw\)/);
assert.match(notice, /DGV\.signInAsAny\(\["manager", "admin"\], password\)/);
assert.match(expense, /DGV\.signInAsAny\(\["manager", "admin"\], password\)/);

assert.doesNotMatch(hiddenSales, /signInAsAny|"manager"/);
assert.match(hiddenSales, /return identity\.role === "admin"/);
assert.doesNotMatch(hiddenReservCheck, /signInAsAny|"manager"/);
assert.match(hiddenReservCheck, /ORIGINAL_VIEW \? \["admin"\] : \["staff", "admin"\]/);
assert.doesNotMatch(hiddenReservAdmin, /signInAsAny|"manager"/);
assert.match(hiddenReservAdmin, /identity\.role === "admin"/);
assert.doesNotMatch(report, /"manager"/);
assert.match(report, /\["staff", "admin"\]\.includes\(identity\.role\)/);
assert.match(codeAdmin, /if \(identity\.role === "admin"\) return true/);
assert.match(codeAdmin, /DGV\.signInAs\("admin", pass\)/);

console.log("Manager frontend role boundaries and password-entry contracts verified.");
