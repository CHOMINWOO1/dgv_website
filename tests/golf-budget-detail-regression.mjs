import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// Real detail logic, entirely in memory. No network or live database.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [source, page, budgetSource, bookingSource, styles] = await Promise.all([
  "assets/golf-budget-detail.js", "golf_budget.html", "assets/golf-budget.js", "assets/golf-bookings.js", "assets/golf-budget-detail.css",
].map((file) => readFile(path.join(root, file), "utf8")));
const id = (n) => "70000000-0000-4000-8000-" + String(n).padStart(12, "0");
const escapeHTML = (value) => String(value ?? "").replace(/[&<>"']/g,
  (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const standalone = {
  id: id(1), booking_group_id: null, status: "completed", counterparty_name: "Agency <b>literal</b>",
  representative_name: "FIRST PERSON", player_names_en: 'FIRST PERSON\nSECOND PERSON\n<img src=x onerror="alert(1)">', pax: 3,
  golf_date: "2027-01-25", golf_time: "09:35:00", golf_course: "SAM", holes: 18,
  guest_unit_price_vnd: 300000, guest_total_vnd: 1000000, course_unit_price_vnd: 250000, course_total_vnd: 850000,
  smart_cart_note: "100,000 VND", deposit_amount_vnd: 100000, final_received_amount_vnd: 900000,
  deposit_received_date: "2026-10-21", final_received_date: "2026-10-23", customer_type: "company",
  cost_settlement_type: "partner", cost_partner_name: "Chị Oanh", note: "line 1\n<script>alert(1)</script>\nline 3",
  created_at: "2026-10-25T00:00:00Z", updated_at: "2026-10-25T01:00:00Z",
};
const payment = (n, kind, amount, method, day) => ({ id: id(n), reservation_id: id(1), payment_kind: kind,
  amount_vnd: amount, payment_date: "2026-10-" + day, payment_method: method, completes_booking: false, sort_order: n });
const group = { id: id(100), label: "QA GROUP", version: 5, completed_at: null, completion_date: null };
const pending = { ...standalone, id: id(4), representative_name: "PENDING PERSON", player_names_en: "PENDING PERSON", pax: 1,
  status: "in_progress", guest_unit_price_vnd: null, guest_total_vnd: null, course_unit_price_vnd: null, course_total_vnd: null,
  deposit_amount_vnd: 0, final_received_amount_vnd: null, note: "", booking_group_id: null };
const fixtures = {
  golf_reservations: [standalone,
    { ...pending, id: id(2), booking_group_id: group.id, pax: 7, guest_total_vnd: 3000000, course_total_vnd: 2000000 },
    { ...pending, id: id(3), booking_group_id: group.id, pax: 8, golf_date: "2027-01-26", guest_total_vnd: 4000000, course_total_vnd: 3000000 },
    pending],
  golf_reservation_payments: [payment(11, "deposit", 100000, "bank", "21"), payment(12, "receipt", 300000, "cash", "22"), payment(13, "receipt", 500000, "card", "23")],
  golf_booking_groups: [group],
  golf_booking_group_payments: [{ ...payment(21, "deposit", 987654, "bank", "24"), booking_group_id: group.id },
    { ...payment(22, "receipt", 123456, "card", "25"), booking_group_id: group.id }],
};
function element(name) {
  const events = new Map();
  let html = "";
  const result = { id: name, open: false, hidden: false, isConnected: true, scrollTop: 0, style: { overflow: "" }, attributes: {}, events,
    addEventListener(type, fn) { events.set(type, [...(events.get(type) || []), fn]); },
    setAttribute(name, value) { this.attributes[name] = String(value); }, getAttribute(name) { return this.attributes[name] ?? null; },
    removeAttribute(name) { delete this.attributes[name]; }, focus() { this.focused = (this.focused || 0) + 1; },
    showModal() { this.open = true; },
    close() { this.open = false; for (const fn of events.get("close") || []) fn({ target: this }); },
    getBoundingClientRect() { return { left: 10, top: 10, right: 900, bottom: 700 }; },
  };
  Object.defineProperties(result, {
    innerHTML: { get: () => html, set: (value) => { html = String(value); } },
    textContent: { get: () => html.replace(/<[^>]*>/g, ""), set: (value) => { html = escapeHTML(value); } },
  });
  return result;
}
function harness(options = {}) {
  const elements = new Map([...page.matchAll(/\bid="([^"]+)"/g)].map((match) => [match[1], element(match[1])]));
  const get = (name) => { assert.ok(elements.has(name), "Missing detail DOM fixture: " + name); return elements.get(name); };
  const data = structuredClone(fixtures), initial = JSON.stringify(data), calls = [];
  let allowed = options.allowed ?? true, intercept = null;
  const body = element("body"), trigger = element("trigger");
  async function execute(query) {
    calls.push(structuredClone(query));
    const rows = (data[query.table] || []).filter((row) => query.filters.every(([kind, field, value]) =>
      kind === "eq" ? row[field] === value : value.includes(row[field])));
    const result = { data: structuredClone(query.single ? rows[0] ?? null : rows), error: null };
    return intercept ? intercept(query, result) : result;
  }
  const sb = { from(table) {
    const query = { table, filters: [], single: false, columns: "" };
    return {
      select(columns) { query.columns = columns; return this; },
      eq(field, value) { query.filters.push(["eq", field, value]); return this; },
      in(field, value) { query.filters.push(["in", field, [...value]]); return this; },
      order() { return this; }, range() { return this; },
      maybeSingle() { query.single = true; return execute(query); },
      then(resolve, reject) { return execute(query).then(resolve, reject); },
      insert() { throw new Error("Unexpected INSERT"); }, update() { throw new Error("Unexpected UPDATE"); },
      delete() { throw new Error("Unexpected DELETE"); }, upsert() { throw new Error("Unexpected UPSERT"); },
    };
  }, rpc() { throw new Error("Unexpected RPC"); } };
  const window = { DGV: { escapeHTML, supabase: sb, async collectSupabasePages(factory) {
    const result = await factory(); if (result.error) throw result.error; return result.data;
  } }, QRStaff: { toast() {} } };
  const context = { window, document: { getElementById: get, body, activeElement: trigger }, console: { ...console, error() {} } };
  vm.runInNewContext(bookingSource, context, { filename: "golf-bookings.js" });
  vm.runInNewContext(source, context, { filename: "golf-budget-detail.js" });
  const viewer = window.GolfBudgetDetail.create({ canView: () => allowed });
  return { viewer, get, data, initial, calls, trigger, body, allow(value) { allowed = value; }, intercept(fn) { intercept = fn; },
    content: () => get("budgetReservationContent").innerHTML,
    fields: () => new Map([...get("budgetReservationContent").innerHTML.matchAll(/<dt>([\s\S]*?)<\/dt><dd>([\s\S]*?)<\/dd>/g)].map((m) => [m[1], m[2]])) };
}
async function dispatch(element, type, event = {}) {
  for (const fn of element.events.get(type) || []) await fn({ target: element, preventDefault() {}, ...event });
}
const tick = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };

assert.doesNotMatch(source, /\.(?:insert|update|delete|upsert|rpc)\s*\(/, "Detail must never mutate data");
assert.doesNotMatch(source, /data-edit-round|data-delete|golf_reserv\.html\?edit|location\.(?:href|assign|replace)/);
assert.match(page, /<dialog[^>]+id="budgetReservationDialog"[^>]+aria-labelledby="budgetReservationTitle"/);
assert.match(page, /id="closeBudgetReservation"[^>]+autofocus/);
assert.match(page, /golf-budget-detail\.js/);
assert.match(styles, /@media print\{\.golf-detail-dialog[^}]*display:none!important/);
assert.match(styles, /@media\(max-width:650px\)/);
assert.match(styles, /max-height:calc\(100dvh - 32px\)/);
assert.ok(page.indexOf("golf-bookings.js") < page.indexOf("golf-budget-detail.js"));
assert.ok(page.indexOf("golf-budget-detail.js") < page.indexOf('src="assets/golf-budget.js'));
assert.doesNotMatch(budgetSource, /href="(?:\$\{escape\(href\)\}|golf_reserv\.html\?edit)[^"]*">예약 보기/);

let test = harness();
await test.viewer.open(id(1), test.trigger);
assert.equal(test.get("budgetReservationDialog").open, true);
for (const [label, value] of [
  ["인원 / Số khách", "3명 / khách"], ["계약금 합계 / Tổng tiền cọc", "100,000 VND"],
  ["추가 입금 합계 / Tổng khoản thu thêm", "800,000 VND"], ["고객 총입금 / Tổng tiền khách đã trả", "900,000 VND"],
  ["고객 합계 / Tổng tiền khách", "1,000,000 VND"], ["골프장·거래처 원가 합계 / Tổng giá vốn", "850,000 VND"],
  ["미수금·초과입금 / Còn phải thu · Thu dư", "100,000 VND"], ["실제 수익 / Lợi nhuận", "50,000 VND"],
  ["정산 거래처 / Đối tác quyết toán", "Chị Oanh"],
]) assert.equal(test.fields().get(label), value, label);
assert.equal(test.fields().get("비고 / Ghi chú"), escapeHTML(standalone.note));
for (const text of ["FIRST PERSON", "SECOND PERSON", "2026.10.21", "2026.10.22", "2026.10.23", "은행 / Chuyển khoản", "현금 / Tiền mặt", "카드 / Thẻ"]) assert.ok(test.content().includes(text), "Missing detail " + text);
assert.match(test.content(), /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
assert.doesNotMatch(test.content(), /<img\b|<script\b|data-edit|data-delete|<input\b|<select\b|<textarea\b|<button\b|<form\b|<iframe\b/);
assert.ok(test.calls.some((q) => q.table === "golf_reservation_payments" && q.filters.some(([kind, field, value]) => kind === "eq" && field === "reservation_id" && value === id(1))));
assert.equal(JSON.stringify(test.data), test.initial, "Source records are immutable");
await dispatch(test.get("closeBudgetReservation"), "click");
assert.equal(test.get("budgetReservationDialog").open, false);
assert.ok(test.trigger.focused, "Close restores opener focus");
assert.equal(test.body.style.overflow, "", "Close restores page scrolling");

test = harness();
await test.viewer.open(id(2), test.trigger);
assert.equal(test.fields().get("묶음 전체 판매 합계 / Tổng tiền khách đặt chung"), "7,000,000 VND");
assert.equal(test.fields().get("묶음 전체 원가 합계 / Tổng giá vốn đặt chung"), "5,000,000 VND");
assert.equal(test.fields().get("고객 총입금 / Tổng tiền khách đã trả"), "1,111,110 VND");
assert.equal(test.fields().get("묶음 미수금·초과입금 / Công nợ · Thu dư đặt chung"), "5,888,890 VND");
assert.ok(test.content().includes("2027.01.25") && test.content().includes("2027.01.26"), "All sibling schedules appear");
assert.ok(test.content().includes("7명") && test.content().includes("8명"), "Varying pax remains per schedule");
assert.ok(test.calls.some((q) => q.table === "golf_reservations" && q.filters.some(([kind, field, value]) => kind === "eq" && field === "booking_group_id" && value === group.id)));
assert.equal(test.calls.filter((q) => q.table === "golf_reservation_payments").length, 0, "Never mix legacy per-round receipts with shared group payments");
assert.equal((test.content().match(/2026\.10\.24[^<]*987,654 VND/g) || []).length, 1, "Shared payment detail appears once");
assert.doesNotMatch(test.content(), /data-edit|data-delete|일정 수정|묶음 입금·완료 처리/);
assert.equal(JSON.stringify(test.data), test.initial);

test = harness();
Object.assign(test.data.golf_booking_groups[0], { completed_at: "2026-10-25T02:00:00Z", completion_date: "2026-10-25" });
for (const round of test.data.golf_reservations) if (round.booking_group_id === group.id) round.status = "completed";
test.data.golf_booking_group_payments[1].completes_booking = true;
await test.viewer.open(id(3), test.trigger);
assert.equal(test.fields().get("묶음 실제 수익 / Lợi nhuận đặt chung"), "-3,888,890 VND", "Completed shared profit uses all-round cost once");
assert.match(test.get("budgetReservationSubtitle").textContent, /완료 \/ Hoàn tất/);
assert.equal(test.fields().get("묶음 완료 기준일 / Ngày hoàn tất đặt chung"), "2026.10.25");

test = harness();
await test.viewer.open(id(4), test.trigger);
for (const label of ["고객 합계 / Tổng tiền khách", "골프장·거래처 원가 합계 / Tổng giá vốn", "실제 수익 / Lợi nhuận"]) assert.equal(test.fields().get(label), "—", "Unknown/pending value is not fabricated: " + label);
test = harness(); test.data.golf_reservation_payments = [];
await test.viewer.open(id(1), test.trigger);
assert.equal(test.fields().get("고객 총입금 / Tổng tiền khách đã trả"), "900,000 VND", "Legacy fallback preserved");
assert.equal(test.fields().get("추가 입금 합계 / Tổng khoản thu thêm"), "800,000 VND");
test = harness({ allowed: false });
await test.viewer.open(id(1), test.trigger);
assert.equal(test.calls.length, 0, "Login gate prevents data reads");
test.allow(true); await test.viewer.open("not-a-uuid", test.trigger);
assert.equal(test.calls.length, 0, "Invalid IDs do not query");

test = harness();
await test.viewer.open(id(999), test.trigger);
assert.doesNotMatch(test.content(), /FIRST PERSON|<dt>/);
assert.ok(test.content(), "Missing record has a notice");
test.intercept(async () => ({ data: null, error: { message: "PRIVATE SERVER DETAIL <script>secret</script>", code: "42501" } }));
await test.viewer.open(id(1), test.trigger);
assert.doesNotMatch(test.content(), /PRIVATE SERVER DETAIL|<script>|FIRST PERSON/);
assert.equal(test.get("budgetReservationContent").getAttribute("aria-busy"), "false");

test = harness(); let finish;
test.intercept((q, result) => q.single && q.filters.some(([, field, value]) => field === "id" && value === id(1))
  ? new Promise((resolve) => { finish = () => resolve(result); }) : result);
const delayed = test.viewer.open(id(1), test.trigger); await tick();
assert.equal(typeof finish, "function");
test.viewer.close(); finish(); await delayed;
assert.equal(test.get("budgetReservationDialog").open, false, "Late response cannot reopen closed dialog");
assert.doesNotMatch(test.content(), /FIRST PERSON/, "Late response cannot repopulate closed dialog");
test = harness();
test.intercept((q, result) => q.single
  ? new Promise((resolve) => { finish = () => resolve(result); }) : result);
const expired = test.viewer.open(id(1), test.trigger); await tick();
test.allow(false); finish(); await expired;
assert.doesNotMatch(test.content(), /FIRST PERSON|<dt>/, "Access loss while reading cannot expose loaded data");
test = harness();
test.intercept((q, result) => q.single && q.filters.some(([, field, value]) => field === "id" && value === id(1))
  ? new Promise((resolve) => { finish = () => resolve(result); }) : result);
const older = test.viewer.open(id(1), test.trigger); await tick();
await test.viewer.open(id(4), test.trigger); finish(); await older;
assert.match(test.content(), /PENDING PERSON/);
assert.doesNotMatch(test.content(), /FIRST PERSON/, "Older request cannot replace a newer reservation");
await dispatch(test.get("budgetReservationDialog"), "click", { clientX: 20, clientY: 20 });
assert.equal(test.get("budgetReservationDialog").open, true);
await dispatch(test.get("budgetReservationDialog"), "click", { clientX: 0, clientY: 0 });
assert.equal(test.get("budgetReservationDialog").open, false);
await test.viewer.open(id(4), test.trigger);
await dispatch(test.get("budgetReservationDialog"), "cancel");
assert.equal(test.get("budgetReservationDialog").open, false, "Escape dismisses read-only detail");

console.log("Golf budget read-only detail: standalone/group/legacy totals, roster, receipts, no mutations, auth/error, escaping, focus and stale-response protection verified (offline).");
