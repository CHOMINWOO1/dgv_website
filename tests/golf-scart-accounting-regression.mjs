import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFile(path.join(root, file), "utf8");
const escapeHTML = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[c]));

// Run the real browser functions without initialization, network access, login,
// or financial writes. Assertions fail if a fixture uses an unknown DOM id.
async function loadPage(pageName, sourceName, exports) {
  const [page, source] = await Promise.all([read(pageName), read(sourceName)]);
  const elements = new Map([...page.matchAll(/\bid="([^"]+)"/g)].map((m) => [m[1], {
    value: "", textContent: "", innerHTML: "", hidden: false, checked: false,
    attributes: {}, validationMessage: "",
    setCustomValidity(value) { this.validationMessage = value; },
    setAttribute(name, value) { this.attributes[name] = value; },
  }]));
  const byId = (id) => { assert.ok(elements.has(id), `Unknown DOM fixture: ${id}`); return elements.get(id); };
  const printed = [];
  const window = {
    DGV: { supabase: new Proxy({}, { get() { throw new Error("Unexpected database access in unit test"); } }),
      escapeHTML, formatYmdInTimeZone: () => "2026-10-25" },
    QRStaff: { toast() {} },
    print: () => printed.push(byId("reservationTableBody").innerHTML),
  };
  assert.match(source, /\n  init\(\);\s*}\)\(window\);/);
  vm.runInNewContext(source.replace(/\n  init\(\);/, `\n  global.__test = { ${exports} };`),
    { window, document: { getElementById: byId }, console, URL }, { filename: sourceName });
  return { api: window.__test, byId, page, source, printed };
}
const editor = await loadPage("golf_reserv.html", "assets/golf-reserv.js",
  "state, smartCartAmount, updatePreview, payloadFromForm, paymentTotals, receivedAmountForBooking, receivableBalanceForBooking, receivableGroups, renderRow");
const { api, byId } = editor;
for (const [value, expected] of [
  [null, 0], [undefined, 0], ["", 0], ["   ", 0], ["0 VND", 0], ["400000", 400000],
  ["400,000 VND", 400000], [" 400,000 vnd ", 400000], ["400000VND", 400000],
  ["1,200,000 VND", 1200000], ["1,000,000,000", 1000000000],
]) assert.equal(api.smartCartAmount(value), expected, `S-CART parser: ${String(value)}`);
for (const value of ["-1", "1.5", "400,00 VND", "400 / 000", "4,000,00", "40 000", "1e6", "NaN", "Infinity",
  "1000000001", "9007199254740992", "400000 USD", "VND", "１２３", '<img src=x onerror="alert(1)">']) {
  assert.ok(Number.isNaN(api.smartCartAmount(value)), `Invalid S-CART must be rejected: ${value}`);
}
for (const [id, value] of Object.entries({
  recordId: "", counterpartyName: "Agency", playerNamesEn: "A\nB", pax: "2", golfDate: "2026-10-25",
  golfHour: "09", golfMinute: "00", golfCourse: "SAM", holes: "18", guestUnitPrice: "4,000,000",
  courseUnitPrice: "3,700,000", smartCartNote: "400,000 VND", costSettlementType: "golf_course", customerType: "company",
})) byId(id).value = value;
const payment = (kind, amount, id) => ({ id, payment_kind: kind, amount_vnd: amount, payment_date: "2026-10-25",
  payment_method: "bank", completes_booking: false, sort_order: 0, legacy_import: false });
api.state.paymentDrafts = {
  deposit: [payment("deposit", 2000000, "deposit")],
  receipt: [payment("receipt", 6400000, "receipt")],
  withdrawal: [payment("withdrawal", 300000, "legacy-withdrawal")],
};
const originalPayments = JSON.stringify(api.state.paymentDrafts);
api.updatePreview();
assert.equal(byId("guestTotalPreview").textContent, "8,400,000 VND", "Cart adds once per reservation, not once per guest");
assert.equal(byId("courseTotalPreview").textContent, "7,800,000 VND");
assert.equal(byId("marginPreview").textContent, "600,000 VND", "Cart is not a profit component");
assert.equal(byId("receivedTotalPreview").textContent, "8,400,000 VND", "Receipts are never recalculated from price fields");
assert.equal(byId("depositTotalPreview").textContent, "2,000,000 VND");
assert.equal(byId("customerBalancePreview").textContent, "0 VND");
assert.equal(byId("smartCartError").hidden, true);
assert.equal(byId("smartCartNote").attributes["aria-invalid"], "false");
byId("paymentCompleted").checked = true;
let payload = api.payloadFromForm();
assert.equal(payload.reservation.smart_cart_note, "400,000 VND");
assert.equal(payload.reservation.guest_unit_price_vnd, 4000000);
assert.equal(payload.reservation.course_unit_price_vnd, 3700000);
assert.equal(payload.reservation.guest_total_vnd, undefined, "The database remains authoritative for totals");
assert.equal(payload.reservation.course_total_vnd, undefined);
assert.deepEqual(Array.from(payload.payments, (p) => p.amount_vnd), [2000000, 6400000, 300000]);
assert.equal(payload.payments[1].completes_booking, true);
assert.equal(payload.payments[2].payment_kind, "withdrawal", "Retain historical withdrawal records in save payload");
assert.equal(JSON.stringify(api.state.paymentDrafts), originalPayments, "Preview/payload must not rewrite any receipt");

byId("costSettlementType").value = "partner";
api.updatePreview();
assert.equal(byId("courseTotalPreview").textContent, "7,800,000 VND");
assert.match(byId("courseTotalLabel").textContent, /거래처.*đối tác/);
payload = api.payloadFromForm();
assert.equal(payload.reservation.cost_partner_name, "Chị Oanh");
assert.equal(payload.reservation.cost_settlement_type, "partner");
for (const blank of ["", "0", "0 VND"]) {
  byId("smartCartNote").value = blank; api.updatePreview();
  assert.equal(byId("guestTotalPreview").textContent, "8,000,000 VND");
  assert.equal(byId("courseTotalPreview").textContent, "7,400,000 VND");
  assert.equal(byId("marginPreview").textContent, "600,000 VND");
}
byId("smartCartNote").value = "400 / 000 VND"; api.updatePreview();
for (const id of ["guestTotalPreview", "courseTotalPreview", "marginPreview", "customerBalancePreview"]) assert.equal(byId(id).textContent, "—");
assert.equal(byId("smartCartError").hidden, false);
assert.match(byId("smartCartError").textContent, /정수.*Vui lòng/);
assert.equal(byId("smartCartNote").attributes["aria-invalid"], "true");
assert.ok(byId("smartCartNote").validationMessage.length > 0);
assert.throws(() => api.payloadFromForm(), /S-CART/);
assert.equal(byId("smartCartNote").value, "400 / 000 VND", "Invalid input cannot be silently sanitized into another amount");
byId("smartCartNote").value = "400,000 VND";
byId("guestUnitPrice").value = ""; api.updatePreview();
assert.equal(byId("guestTotalPreview").textContent, "—");
assert.equal(byId("courseTotalPreview").textContent, "7,800,000 VND");
byId("courseUnitPrice").value = ""; api.updatePreview();
assert.equal(byId("courseTotalPreview").textContent, "—", "Unknown base cost must remain unknown");
assert.equal(byId("smartCartNote").validationMessage, "", "Correcting input clears validity error");

const fixture = { id: "scart-accounting", status: "completed", golf_date: "2026-10-25", golf_time: "09:00:00",
  counterparty_name: "Agency", representative_name: "A", player_names_en: "A\nB", golf_course: "SAM", holes: 18, pax: 2,
  smart_cart_note: "400,000 VND", guest_unit_price_vnd: 4000000, guest_total_vnd: 8400000,
  course_unit_price_vnd: 3700000, course_total_vnd: 7800000, customer_type: "company", cost_settlement_type: "golf_course",
  final_received_amount_vnd: 8400000, final_received_date: "2026-10-25", deposit_amount_vnd: 2000000,
  payments: [payment("deposit", 2000000, "deposit"), payment("receipt", 6400000, "receipt")] };
assert.equal(api.receivedAmountForBooking(fixture), 8400000);
assert.equal(api.receivableBalanceForBooking(fixture), 0);
assert.match(api.renderRow(fixture), /실제 수익[^]*?<strong>600,000 VND<\/strong>/);
assert.equal(api.receivableBalanceForBooking({ ...fixture, guest_total_vnd: null }), null);
const partner = { ...fixture, id: "partner-scart", customer_type: "individual", cost_settlement_type: "partner", cost_partner_name: "Chị Oanh" };
api.state.partnerOffsets = [{ reservation_id: partner.id, partner_name: "Chị Oanh", golf_date: partner.golf_date, amount_vnd: 7800000, active: true }];
const group = api.receivableGroups([partner])[0];
assert.equal(group.name, "Chị Oanh"); assert.equal(group.partnerOffset, 7800000); assert.equal(group.receivable, -7800000);

const list = await loadPage("golf_reserv_list.html", "assets/golf-reserv-list.js", "state, actualProfit, render, renderRow, printList, workbookOptions");
list.byId("statusFilter").value = "all"; list.api.state.rows = [fixture, partner];
assert.equal(list.api.actualProfit(fixture), 600000);
assert.equal(list.api.actualProfit({ ...fixture, payments: [] }), 600000, "Legacy receipt fallback uses corrected cost");
assert.equal(list.api.actualProfit({ ...fixture, status: "in_progress" }), null);
list.api.render(); list.api.printList();
assert.equal(list.printed.length, 1);
assert.match(list.printed[0], /8,400,000 VND/); assert.match(list.printed[0], /7,800,000 VND/); assert.match(list.printed[0], /600,000 VND/);
const workbook = list.api.workbookOptions([fixture, partner]);
const row = workbook.sheets[0].rows[5];
assert.equal(row[9].value, "400,000 VND"); assert.equal(row[10].value, 4000000);
assert.equal(row[11].value, 8400000); assert.equal(row[13].value, 7800000);
assert.equal(row[18].value, 8400000); assert.equal(row[20].value, 600000);
assert.equal(workbook.sheets[0].rows[6][15].value, "Chị Oanh");
assert.deepEqual(Array.from(workbook.sheets[1].rows.slice(5), (r) => r[6].value), [2000000, 6400000, 2000000, 6400000]);

const budget = await loadPage("golf_budget.html", "assets/golf-budget.js", "state, courseBalance, expectedPaymentStats, filteredPendingReservations, pendingTotalOf");
budget.api.state.accounts = [{ golf_course: "SAM", opening_balance_vnd: 100000000 }];
budget.api.state.deposits = [];
budget.api.state.charges = [{ golf_course: "SAM", amount_vnd: 7400000, active: true }];
const beforeBalance = budget.api.courseBalance("SAM");
budget.api.state.accounts[0].opening_balance_vnd += 400000;
budget.api.state.charges[0].amount_vnd += 400000;
assert.equal(budget.api.courseBalance("SAM"), beforeBalance, "Historical basis adjustment prevents a second deduction");
budget.api.state.pendingReservations = [{ ...fixture, status: "in_progress" }, { ...partner, status: "in_progress" }];
assert.equal(budget.api.expectedPaymentStats("SAM").amount, 7800000, "Partner S-CART must not hit the course budget");
const pending = budget.api.filteredPendingReservations();
assert.equal(pending.length, 1); assert.equal(pending[0].id, fixture.id);
assert.equal(budget.api.pendingTotalOf(pending), 7800000);
assert.equal(budget.api.courseBalance("SAM"), beforeBalance, "Pending bookings do not deduct current balance");
assert.equal(JSON.stringify(api.state.paymentDrafts), originalPayments);

console.log("S-CART parser, equal pass-through totals, validation, payment preservation, profit, partner offsets, print/XLSX, and course-budget routing verified.");
