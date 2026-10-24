import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [source, page] = await Promise.all([readFile(path.join(root, "assets/golf-budget.js"), "utf8"), readFile(path.join(root, "golf_budget.html"), "utf8")]);
// Real page logic, local DOM/query fixtures only: no credentials or financial writes.
function classList() {
  const names = new Set();
  return {
    add: (...v) => v.forEach((n) => names.add(n)), remove: (...v) => v.forEach((n) => names.delete(n)), contains: (n) => names.has(n),
    toggle(n, on) { const active = on ?? !names.has(n); if (active) names.add(n); else names.delete(n); return active; },
  };
}
function element(id) {
  return {
    id, textContent: id, innerHTML: "", value: "", disabled: false, hidden: false, dataset: {}, attributes: {}, classList: classList(), listeners: new Map(),
    addEventListener(type, fn) { this.listeners.set(type, fn); }, setAttribute(n, v) { this.attributes[n] = v; },
    querySelectorAll() { return []; }, reset() {}, focus() {}, scrollIntoView() {},
  };
}
const elements = new Map();
for (const match of page.matchAll(/\bid="([^"]+)"/g)) {
  assert.ok(!elements.has(match[1]), `Duplicate HTML id: ${match[1]}`);
  elements.set(match[1], element(match[1]));
}
function byId(id) { assert.ok(elements.has(id), `Missing page element: ${id}`); return elements.get(id); }
for (const kind of ["charge", "pending"]) {
  const buttons = ["all", "AT1200", "SAM", "PALACE"].map((course) => {
    const button = element(`${kind}-${course}`); button.dataset[`${kind}Course`] = course; button.closest = () => button; return button;
  });
  byId(`${kind}Filters`).querySelectorAll = () => buttons;
}
const viewButtons = ["all", "completed", "pending"].map((view) => {
  const button = element(`view-${view}`); button.dataset.reservationView = view; button.closest = () => button; return button;
});
byId("reservationViewFilters").querySelectorAll = () => viewButtons;
const body = { classList: classList() };
const toasts = [], exported = [], printModes = [], printedSections = [], queries = [];
const globalEvents = new Map(), fixtureTables = new Map();
const supabase = {
  from(table) {
    const query = { table, columns: "", filters: [],
      select(columns) { this.columns = columns; return this; }, eq(column, value) { this.filters.push([column, value]); return this; },
      insert() { throw new Error("Unexpected DB insert"); }, update() { throw new Error("Unexpected DB update"); }, delete() { throw new Error("Unexpected DB delete"); },
    }; queries.push(query); return query;
  },
};
const window = {
  location: { href: "https://example.test/golf_budget.html" },
  DGV: { supabase,
    escapeHTML: (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
    formatYmdInTimeZone: () => "2026-10-24",
    async collectSupabasePages(factory, options) { const q = factory(); assert.ok(options.pageSize > 0); return fixtureTables.get(q.table) || []; },
  },
  QRStaff: { toast: (...args) => toasts.push(args), connectionBadge() {}, messageOf: (error) => error.message },
  DGV_XLSX: { downloadWorkbook: (options) => exported.push(options) }, requestAnimationFrame: (fn) => fn(),
  print: () => {
    printModes.push({ payments: body.classList.contains("print-budget-payments"), charges: body.classList.contains("print-budget-charges") });
    printedSections.push({ completed: !byId("chargeListSection").hidden, pending: !byId("pendingListSection").hidden });
  },
  addEventListener(type, fn) { const list = globalEvents.get(type) || []; list.push(fn); globalEvents.set(type, list); },
};
assert.match(source, /\n  init\(\);\s*}\)\(window\);/);
const hook = "global.__budgetTest = { state, render, bindEvents, loadData, courseBalance, filteredCharges, filteredPendingReservations, chargeWorkbookOptions };";
vm.runInNewContext(source.replace(/\n  init\(\);/, `\n  ${hook}`), { window, document: { getElementById: byId, body }, console, URL }, { filename: "golf-budget.js" });
const api = window.__budgetTest, state = api.state;
const plain = (v) => JSON.parse(JSON.stringify(v));
const click = (id, event = {}) => { const fn = byId(id).listeners.get("click"); assert.equal(typeof fn, "function", `Missing handler: ${id}`); return fn(event); };
const afterPrint = () => { for (const fn of globalEvents.get("afterprint") || []) fn(); globalEvents.delete("afterprint"); };
const courseClick = (kind, course) => click(`${kind}Filters`, { target: byId(`${kind}Filters`).querySelectorAll().find((b) => b.dataset[`${kind}Course`] === course) });
const viewClick = (view) => click("reservationViewFilters", { target: viewButtons.find((b) => b.dataset.reservationView === view) || { dataset: { reservationView: view }, closest() { return this; } } });

assert.equal(state.pendingFrom, ""); assert.equal(state.pendingTo, ""); assert.equal(state.pendingCourse, "all");
assert.equal(state.reservationView, "all");
assert.ok(page.indexOf('id="chargeListSection"') < page.indexOf('id="pendingListSection"'));
assert.ok(page.indexOf('id="printChargeButton"') < page.indexOf('id="chargeListSection"'), "Shared report actions must stay available in pending-only view");
assert.match(page, /body\.print-budget-charges[\s\S]*#chargeListSection/);
assert.match(page, /body\.print-budget-charges[\s\S]*#pendingListSection/);
assert.match(page, /body\.print-budget-charges #chargeListSection\[hidden\],body\.print-budget-charges #pendingListSection\[hidden\]\{display:none!important\}/);
assert.match(page, /#chargeListSection\[hidden\]\+#pendingListSection\{break-before:auto;page-break-before:auto\}/);
assert.match(page, /body\.print-budget-payments>main\.budget-app[\s\S]*body\.print-budget-charges>main\.budget-app\{display:block!important/);
state.accounts = [{ golf_course: "SAM", opening_balance_vnd: 1000 }, { golf_course: "AT1200", opening_balance_vnd: 2000 }];
state.deposits = [{ id: "deposit", golf_course: "SAM", amount_vnd: 200, deposit_date: "2026-10-01", payment_method: "bank" }];
state.charges = [
  { reservation_id: "active", golf_course: "SAM", golf_date: "2026-10-10", charged_at: "2026-10-15T00:00:00+07:00", amount_vnd: 300, active: true, golf_reservations: { representative_name: "Active guest", counterparty_name: "Agency" } },
  { reservation_id: "restored", golf_course: "SAM", golf_date: "2026-10-20", charged_at: "2026-10-05T00:00:00+07:00", reversed_at: "2026-10-06T00:00:00+07:00", amount_vnd: 100, active: false, golf_reservations: { representative_name: "Restored guest" } },
  { reservation_id: "at", golf_course: "AT1200", golf_date: "2026-09-30", charged_at: "2026-09-30T00:00:00+07:00", amount_vnd: 100, active: true, historical: true },
];
const base = { status: "in_progress", cost_settlement_type: "golf_course", golf_course: "SAM", pax: 2 };
state.pendingReservations = [
  { ...base, id: "future", golf_date: "2026-11-02", golf_time: "10:05:00", course_total_vnd: 400, representative_name: '<img src=x onerror="alert(1)">', counterparty_name: "=1+1" },
  { ...base, id: "october", golf_date: "2026-10-20", golf_time: "08:00:00", course_total_vnd: 200, representative_name: "October guest" },
  { ...base, id: "missing", golf_date: "2026-10-20", golf_time: "09:00:00", course_total_vnd: null, representative_name: "Missing cost guest" },
  { ...base, id: "other", golf_course: "AT1200", golf_date: "2026-10-10", golf_time: "07:00:00", course_total_vnd: 300 },
  { ...base, id: "partner", golf_date: "2026-12-01", cost_settlement_type: "partner", course_total_vnd: 9000 },
  { ...base, id: "completed", golf_date: "2026-12-01", status: "completed", course_total_vnd: 9000 },
];
api.bindEvents(); api.render();
assert.equal(byId("chargeListSection").hidden, false); assert.equal(byId("pendingListSection").hidden, false);
assert.deepEqual(plain(api.filteredPendingReservations().map((r) => r.id)), ["future", "missing", "october", "other"]);
assert.match(byId("pendingTableBody").innerHTML, /2026\. 11\. 02/);
assert.match(byId("pendingTableBody").innerHTML, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
assert.doesNotMatch(byId("pendingTableBody").innerHTML, /<img|edit=partner|edit=completed/);
assert.equal(byId("pendingTableTotal").textContent, "900 VND");
assert.equal(byId("summaryExpectedCharges").textContent, "900 VND");
assert.equal(api.courseBalance("SAM"), 900); assert.equal(api.courseBalance("AT1200"), 1900);
assert.equal(byId("summaryBalance").textContent, "2,800 VND");

byId("pendingRangeFrom").value = "2026-10-01"; byId("pendingRangeTo").value = "2026-10-31";
click("pendingRangeApplyButton"); courseClick("pending", "SAM");
assert.deepEqual(plain(api.filteredPendingReservations().map((r) => r.id)), ["missing", "october"]);
assert.equal(byId("pendingTableTotal").textContent, "200 VND");
assert.equal(byId("summaryBalance").textContent, "2,800 VND");
assert.equal(state.chargeFrom, ""); assert.equal(state.paymentFrom, "");
byId("pendingRangeFrom").value = "2026-11-01"; byId("pendingRangeTo").value = "2026-10-01";
click("pendingRangeApplyButton");
assert.equal(state.pendingFrom, "2026-10-01", "Invalid range must not change applied filters");
assert.ok(toasts.at(-1)[0].includes("Ngày bắt đầu"));
byId("chargeRangeFrom").value = "2026-10-01"; byId("chargeRangeTo").value = "2026-10-31";
click("chargeRangeApplyButton"); courseClick("charge", "SAM");
assert.deepEqual(plain(api.filteredCharges().map((r) => r.reservation_id)), ["restored", "active"]);
assert.equal(byId("chargeTableTotal").textContent, "300 VND", "Exclude restored amounts from active total");

click("exportChargeButton"); assert.equal(exported.length, 1);
const workbook = exported[0]; assert.match(workbook.filename, /\.xlsx$/); assert.equal(workbook.sheets.length, 2);
const cellValue = (c) => c && typeof c === "object" ? c.value : c;
const completeRows = workbook.sheets[0].rows.map((r) => r.map(cellValue));
const pendingRows = workbook.sheets[1].rows.map((r) => r.map(cellValue));
const completeData = completeRows.filter((r) => String(r[7] || "").includes("?edit="));
const pendingData = pendingRows.filter((r) => String(r[7] || "").includes("?edit="));
assert.equal(completeData.length, 2); assert.equal(pendingData.length, 2);
assert.equal(completeData[0][6], -100); assert.equal(completeData[1][6], -300);
assert.equal(completeData[1][8], 900, "Historical balance uses all events, not filtered subset");
assert.equal(pendingData[0][6], "", "Unknown cost must stay blank, not zero");
assert.equal(pendingData[1][6], 200);
assert.ok(completeRows.flat().some((v) => typeof v === "string" && v.includes("2026. 10. 01")));
assert.ok(pendingRows.flat().some((v) => typeof v === "string" && v.includes("2026. 10. 31")));
assert.equal(completeRows.at(-1)[6], 300); assert.equal(pendingRows.at(-1)[6], 200);
assert.equal(byId("exportChargeButton").disabled, false);
assert.ok(completeData[0][9], "Restoration timestamp stays in last completed column");

body.classList.add("print-budget-payments"); click("printChargeButton");
assert.deepEqual(printModes.at(-1), { payments: false, charges: true });
assert.match(byId("printChargeCriteria").textContent, /2026\. 10\. 01/);
assert.match(byId("printPendingCriteria").textContent, /SAM/);
afterPrint(); assert.equal(body.classList.contains("print-budget-charges"), false);
body.classList.add("print-budget-charges"); click("printDepositButton");
assert.deepEqual(printModes.at(-1), { payments: true, charges: false });
afterPrint(); assert.equal(body.classList.contains("print-budget-payments"), false);
click("pendingRangeAllButton"); assert.equal(state.pendingFrom, ""); assert.equal(state.pendingTo, "");
assert.ok(api.filteredPendingReservations().some((r) => r.id === "future"));
const before = JSON.stringify(state); click("exportChargeButton");
assert.equal(JSON.stringify(state), before, "Export must not mutate data or filters");
const formulaLikeRow = exported.at(-1).sheets[1].rows.find((r) => String(cellValue(r[7]) || "").includes("edit=future"));
assert.equal(formulaLikeRow[4].value, "=1+1");
assert.equal(typeof formulaLikeRow[4].value, "string", "Counterparty text must not become an Excel formula");
assert.equal(formulaLikeRow[4].formula, undefined);

fixtureTables.set("golf_course_budget_accounts", state.accounts); fixtureTables.set("golf_course_budget_deposits", state.deposits);
fixtureTables.set("golf_course_budget_reservation_charges", state.charges); fixtureTables.set("golf_reservations", state.pendingReservations);
assert.equal(await api.loadData({ quiet: true }), true);
const query = queries.find((q) => q.table === "golf_reservations");
for (const c of ["id", "golf_course", "status", "course_total_vnd", "cost_settlement_type", "golf_date", "golf_time", "counterparty_name", "representative_name"]) assert.ok(query.columns.split(",").includes(c), `Missing query column ${c}`);
assert.deepEqual(plain(query.filters), [["status", "in_progress"], ["cost_settlement_type", "golf_course"]]);
assert.equal(api.courseBalance("SAM"), 900);
// View selection only changes visibility and report scope, never filters or balances.
const selectedFilters = () => [state.chargeFrom, state.chargeTo, state.chargeCourse, state.pendingFrom, state.pendingTo, state.pendingCourse];
const filtersBeforeViews = selectedFilters();
for (const view of ["completed", "pending", "all"]) {
  viewClick(view);
  assert.equal(state.reservationView, view);
  assert.equal(byId("chargeListSection").hidden, view === "pending");
  assert.equal(byId("pendingListSection").hidden, view === "completed");
  assert.deepEqual(selectedFilters(), filtersBeforeViews);
  assert.equal(byId("chargeTableTotal").textContent, "300 VND");
  assert.equal(byId("pendingTableTotal").textContent, "600 VND");
  assert.equal(api.courseBalance("SAM"), 900);
  assert.equal(byId("summaryBalance").textContent, "2,800 VND");
  for (const button of viewButtons) {
    assert.equal(button.attributes["aria-pressed"], String(button.dataset.reservationView === view));
  }
  click("exportChargeButton");
  const sheets = exported.at(-1).sheets;
  assert.equal(sheets.length, view === "all" ? 2 : 1);
  assert.deepEqual(plain(sheets.map((sheet) => sheet.name)), view === "completed" ? ["완료 차감 내역"] : view === "pending" ? ["차감 예정 내역"] : ["완료 차감 내역", "차감 예정 내역"]);
  click("printChargeButton");
  assert.deepEqual(printedSections.at(-1), { completed: view !== "pending", pending: view !== "completed" });
  afterPrint();
}
viewClick("invalid");
assert.equal(state.reservationView, "all", "Invalid view falls back to all");
assert.equal(byId("chargeListSection").hidden, false); assert.equal(byId("pendingListSection").hidden, false);
assert.deepEqual(selectedFilters(), filtersBeforeViews);

viewClick("pending");
const detailButton = { dataset: { showChargeCourse: "SAM" } };
click("courseCards", { target: { closest: (selector) => selector === "[data-show-charge-course]" ? detailButton : null } });
assert.equal(state.reservationView, "completed", "Course detail link must reveal completed history when it was hidden");
assert.equal(byId("chargeListSection").hidden, false);
viewClick("all");

// A hidden list with data must not bypass the empty selected-view guard.
for (const view of ["completed", "pending"]) {
  viewClick(view);
  const kind = view === "completed" ? "charge" : "pending";
  const savedFrom = byId(`${kind}RangeFrom`).value, savedTo = byId(`${kind}RangeTo`).value;
  byId(`${kind}RangeFrom`).value = "2099-01-01"; byId(`${kind}RangeTo`).value = "2099-01-02";
  click(`${kind}RangeApplyButton`);
  const exportsBefore = exported.length, printsBefore = printModes.length;
  click("exportChargeButton"); click("printChargeButton");
  assert.equal(exported.length, exportsBefore, `Empty ${view} view must not export hidden other rows`);
  assert.equal(printModes.length, printsBefore, `Empty ${view} view must not print hidden other rows`);
  assert.equal(byId("exportChargeButton").disabled, false);
  byId(`${kind}RangeFrom`).value = savedFrom; byId(`${kind}RangeTo`).value = savedTo;
  click(`${kind}RangeApplyButton`);
}
viewClick("all");
for (const kind of ["pending", "charge"]) {
  byId(`${kind}RangeFrom`).value = "2099-01-01"; byId(`${kind}RangeTo`).value = "2099-01-02";
  click(`${kind}RangeApplyButton`);
}
const exportsBeforeEmpty = exported.length, printsBeforeEmpty = printModes.length;
click("exportChargeButton"); click("printChargeButton");
assert.equal(exported.length, exportsBeforeEmpty, "Do not create empty workbooks");
assert.equal(printModes.length, printsBeforeEmpty, "Do not open an empty print dialog");
assert.equal(byId("exportChargeButton").disabled, false);
assert.equal(body.classList.contains("print-budget-charges"), false);
assert.equal(api.courseBalance("SAM"), 900, "Filtering never affects current balance");
console.log("Golf budget pending lists, filters, balances, print isolation, XLSX values and read-only query verified.");
