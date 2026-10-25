import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [source, page] = await Promise.all([
  readFile(path.join(root, "assets/golf-reserv-list.js"), "utf8"),
  readFile(path.join(root, "golf_reserv_list.html"), "utf8"),
]);
const escapeHTML = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function classList() {
  const values = new Set();
  return { add: (v) => values.add(v), remove: (v) => values.delete(v), contains: (v) => values.has(v) };
}
function element(id) {
  return { id, value: "", textContent: "", innerHTML: "", hidden: false, open: false, disabled: false,
    dataset: {}, attributes: {}, events: new Map(), classList: classList(), scrollLeft: 0,
    addEventListener(type, fn) { this.events.set(type, [...(this.events.get(type) || []), fn]); },
    setAttribute(name, value) { this.attributes[name] = value; },
    showModal() { this.open = true; this.showCount = (this.showCount || 0) + 1; },
    close() { this.open = false; },
    getBoundingClientRect() { return { left: 10, top: 10, right: 200, bottom: 200 }; },
    setPointerCapture(id) { this.pointer = id; }, hasPointerCapture(id) { return this.pointer === id; },
    releasePointerCapture() { this.pointer = null; },
  };
}
const elements = new Map([...page.matchAll(/\bid="([^"]+)"/g)].map((m) => [m[1], element(m[1])]));
const byId = (id) => { assert.ok(elements.has(id), `Missing DOM fixture: ${id}`); return elements.get(id); };
const sheet = element("sheet"), confirms = [], navigations = [], printed = [], downloads = [];
let confirmResult = true, clock = 1000;
class TestDate extends Date { static now() { return clock; } }
const window = {
  DGV: { escapeHTML, supabase: new Proxy({}, { get() { throw new Error("Unexpected database access"); } }) },
  QRStaff: { toast() {} }, DGV_XLSX: { downloadWorkbook: (value) => downloads.push(value) },
  confirm(message) { confirms.push(message); return confirmResult; }, location: { assign: (href) => navigations.push(href) },
  print() { printed.push(byId("reservationTableBody").innerHTML); },
};
vm.runInNewContext(source.replace(/\n  init\(\);/, "\n  global.__test = { state, render, renderRow, workbookOptions, bindEvents, openReservationDetail, closeReservationDetail, reservationDetailMarkup };"),
  { window, document: { getElementById: byId, querySelector: (s) => s === ".golf-sheet-wrap" ? sheet : null }, console, Date: TestDate },
  { filename: "golf-reserv-list.js" });
const api = window.__test;
const dispatch = (target, type, event = {}) => { for (const fn of target.events.get(type) || []) fn({ preventDefault() {}, ...event }); };
const payment = (kind, amount, method, day) => ({ payment_kind: kind, amount_vnd: amount, payment_method: method, payment_date: `2026-10-${day}` });
const fixture = {
  id: 'booking"<1>', status: "completed", counterparty_name: "Agency <b>literal</b>", representative_name: "FIRST PERSON",
  player_names_en: 'FIRST PERSON\nSECOND PERSON\n<img src=x onerror="alert(1)">', pax: 3,
  golf_date: "2026-10-26", golf_time: "09:35:00", golf_course: "SAM", holes: 18,
  guest_unit_price_vnd: 300000, guest_total_vnd: 1000000, course_unit_price_vnd: 250000, course_total_vnd: 850000,
  smart_cart_note: "100,000 VND", deposit_amount_vnd: 100000, final_received_amount_vnd: 900000,
  customer_type: "company", cost_settlement_type: "partner", cost_partner_name: "Chị Oanh",
  note: "line 1\n<script>alert(1)</script>\nline 3", created_at: "2026-10-25T00:00:00Z", updated_at: "2026-10-25T01:00:00Z",
  payments: [payment("deposit", 100000, "bank", "21"), payment("receipt", 300000, "cash", "22"), payment("receipt", 500000, "card", "23")],
};
const original = JSON.stringify(fixture);
byId("statusFilter").value = "all"; api.state.rows = [fixture];
api.bindEvents(); api.render();
const markup = api.renderRow(fixture), cells = [...markup.matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/g)];
const headers = [...page.match(/<thead>([\s\S]*?)<\/thead>/)[1].matchAll(/<th\b([^>]*)>([\s\S]*?)<\/th>/g)];
assert.equal(cells.length, 25); assert.equal(headers.length, 25, "Printed table header/data column counts must match");
const visible = cells.map((m, i) => m[1].includes("golf-screen-hidden") ? null : i).filter((i) => i != null);
assert.deepEqual(visible, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], "Compact screen ends at customer total and preserves representative");
assert.deepEqual(headers.map((m, i) => m[1].includes("golf-screen-hidden") ? null : i).filter((i) => i != null), visible);
assert.match(cells[4][2], /golf-edit-link/); assert.doesNotMatch(cells[1][2], /button|golf-edit-link/);
assert.match(cells[5][2], /golf-print-text/); assert.match(cells[5][2], /FIRST PERSON\nSECOND PERSON/);
assert.equal(cells[23][2], escapeHTML(fixture.note), "Full multiline notes remain in print cells");
assert.match(page, /<h1 class="qr-brand-title">골프 예약 현황<\/h1>/);
assert.match(page, /\.golf-screen-hidden\{display:table-cell!important\}/);
assert.match(page, /\.golf-detail-dialog\{display:none!important\}/);
assert.match(page, /<dialog[^>]+id="reservationDetailDialog"[^>]+aria-labelledby="reservationDetailTitle"/);
assert.doesNotMatch(source, /addEventListener\("cancel"/, "Native Escape dismissal must not be cancelled");
assert.match(page, /id="closeReservationDetail"[^>]+autofocus/);
assert.doesNotMatch(markup, /<img\b|<script\b/);

const tableBody = byId("reservationTableBody"), dialog = byId("reservationDetailDialog");
const row = { dataset: { reservationId: fixture.id } };
const representativeButton = { dataset: { editHref: `golf_reserv.html?edit=${encodeURIComponent(fixture.id)}` } };
const target = (kind) => ({ closest(selector) {
  if (selector === "button.golf-edit-link[data-edit-href]") return kind === "representative" ? representativeButton : null;
  if (selector === "tr[data-reservation-id]") return row;
  if (selector === "a, button, input, select, textarea") return kind === "cell" ? null : {};
  return null;
} });
dispatch(tableBody, "click", { target: target("representative"), detail: 1 });
dispatch(tableBody, "click", { target: target("representative"), detail: 2 });
assert.equal(dialog.open, false); assert.equal(confirms.length, 0, "Representative clicks must not preempt native double-click");
dispatch(tableBody, "dblclick", { target: target("representative"), detail: 2 });
assert.equal(confirms.length, 1); assert.equal(navigations.length, 1, "One double-click asks and navigates exactly once");
assert.match(confirms[0], /수정하시겠습니까\?[\s\S]*Bạn có muốn chỉnh sửa đặt sân này không\?/);
assert.equal(navigations[0], representativeButton.dataset.editHref);
confirmResult = false;
dispatch(tableBody, "dblclick", { target: target("representative"), detail: 2 });
assert.equal(navigations.length, 1, "Cancel must never navigate");
confirmResult = true;
dispatch(tableBody, "click", { target: target("representative"), detail: 0 });
assert.equal(navigations.length, 2, "Keyboard activation retains accessible edit confirmation");

dispatch(tableBody, "click", { target: target("cell"), detail: 1 });
assert.equal(dialog.open, true); assert.equal(dialog.showCount, 1);
const detail = byId("reservationDetailContent").innerHTML;
const fields = new Map([...detail.matchAll(/<dt>([\s\S]*?)<\/dt><dd>([\s\S]*?)<\/dd>/g)].map((m) => [m[1], m[2]]));
for (const [label, value] of [
  ["인원 / Số khách", "3명 / khách"], ["계약금 합계 / Tổng tiền cọc", "100,000 VND"],
  ["추가 입금 합계 / Tổng khoản thu thêm", "800,000 VND"], ["고객 총입금 / Tổng tiền khách đã trả", "900,000 VND"],
  ["고객 합계 / Tổng tiền khách", "1,000,000 VND"], ["골프장·거래처 원가 합계 / Tổng giá vốn", "850,000 VND"],
  ["미수금·초과입금 / Còn phải thu · Thu dư", "100,000 VND"], ["실제 수익 / Lợi nhuận", "50,000 VND"],
  ["정산 거래처 / Đối tác quyết toán", "Chị Oanh"],
]) assert.equal(fields.get(label), value, label);
assert.equal(fields.get("비고 / Ghi chú"), escapeHTML(fixture.note));
for (const text of ["FIRST PERSON", "SECOND PERSON", "2026.10.21", "2026.10.22", "2026.10.23", "은행 / Chuyển khoản", "현금 / Tiền mặt", "카드 / Thẻ"]) assert.ok(detail.includes(text), `Missing detail ${text}`);
assert.match(detail, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/); assert.doesNotMatch(detail, /<img\b|<script\b/);
const legacy = api.reservationDetailMarkup({ ...fixture, payments: [], deposit_received_date: "2026-10-21", final_received_date: "2026-10-23" });
assert.match(legacy, /추가 입금 합계 \/ Tổng khoản thu thêm<\/dt><dd>800,000 VND<\/dd>/, "Legacy no-ledger fallback remains consistent with received minus deposit");
assert.match(legacy, /예약금 최초 입금일[^]*?<dd>2026\.10\.21<\/dd>/);
assert.match(legacy, /완료 기준일[^]*?<dd>2026\.10\.23<\/dd>/);
dispatch(byId("closeReservationDetail"), "click"); assert.equal(dialog.open, false);
dispatch(tableBody, "click", { target: target("detail"), detail: 0 }); assert.equal(dialog.open, true, "Details button works by keyboard");
dispatch(dialog, "click", { target: dialog, clientX: 20, clientY: 20 }); assert.equal(dialog.open, true, "Interior clicks must not dismiss the popup");
dispatch(dialog, "click", { target: dialog, clientX: 0, clientY: 0 }); assert.equal(dialog.open, false, "Backdrop click dismisses the popup");
dispatch(tableBody, "click", { target: target("detail"), detail: 1 }); assert.equal(dialog.open, true, "Touch/physical detail button works");
api.closeReservationDetail();
dispatch(sheet, "pointerdown", { target: target("cell"), pointerType: "mouse", button: 0, pointerId: 1, clientX: 100 });
dispatch(sheet, "pointermove", { pointerId: 1, clientX: 120 }); dispatch(sheet, "pointerup", { pointerId: 1 });
dispatch(tableBody, "click", { target: target("cell"), detail: 1 }); assert.equal(dialog.open, false, "Horizontal dragging cannot accidentally open details");
clock += 300; dispatch(tableBody, "click", { target: target("cell"), detail: 1 }); assert.equal(dialog.open, true);
api.closeReservationDetail();

dispatch(byId("printListButton"), "click"); assert.equal(printed.length, 1); assert.match(printed[0], /850,000 VND/); assert.match(printed[0], /50,000 VND/);
dispatch(byId("exportListButton"), "click"); assert.equal(downloads.length, 1);
const workbook = downloads[0], exportRow = workbook.sheets[0].rows[5];
assert.equal(exportRow.length, 25); assert.equal(exportRow[4].value, fixture.representative_name);
assert.equal(exportRow[5].value, fixture.player_names_en); assert.equal(exportRow[23].value, fixture.note);
assert.equal(exportRow[11].value, 1000000); assert.equal(exportRow[13].value, 850000);
assert.equal(exportRow[16].value, 100000); assert.equal(exportRow[18].value, 900000); assert.equal(exportRow[20].value, 50000);
assert.equal(workbook.sheets.length, 2); assert.equal(workbook.sheets[1].rows.length, 8);
assert.equal(workbook.sheets[1].rows[5][6].value, 100000); assert.equal(workbook.sheets[1].rows[6][6].value, 300000); assert.equal(workbook.sheets[1].rows[7][6].value, 500000);
assert.equal(JSON.stringify(fixture), original, "Rendering, detail, print and export remain read-only");
assert.doesNotMatch(source, /\.insert\(|\.update\(|\.delete\(/);
console.log("Compact 12-column screen/full 25-column reports, representative retained, native details popup, payment summaries, XSS, edit confirmation, keyboard/touch, and drag suppression verified (no database writes).");
