import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [source, page] = await Promise.all([
  readFile(path.join(root, "assets/golf-reserv-list.js"), "utf8"),
  readFile(path.join(root, "golf_reserv_list.html"), "utf8")
]);
const escapeHTML = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[character]));
const elements = new Map([...page.matchAll(/\bid="([^"]+)"/g)].map((match) => [match[1], {
  value: match[1] === "statusFilter" ? "all" : "", innerHTML: "", textContent: "", hidden: false,
  dataset: {}, open: false, showModal() { this.open = true; }
}]));
const byId = (id) => { assert.ok(elements.has(id), `Missing DOM fixture: ${id}`); return elements.get(id); };
const window = {
  DGV: { supabase: new Proxy({}, { get() { throw new Error("Unexpected DB access"); } }), escapeHTML },
  QRStaff: {}
};
vm.runInNewContext(source.replace(/\n  init\(\);/, "\n  global.__test = { state, render, renderRow, renderSummary, reservationDetailMarkup, workbookOptions, openReservationDetail, filteredRows, orderedRows, renderTableRows };"),
  { window, document: { getElementById: byId }, console }, { filename: "golf-reserv-list.js" });
const api = window.__test;
const makeRound = (id, day, sales, cost) => ({
  id, booking_group_id: "booking-group-1", status: "completed", counterparty_name: "Agency",
  representative_name: "LEE JINHWAN", player_names_en: "LEE JINHWAN\nSECOND PERSON", pax: 2,
  golf_date: `2026-11-${day}`, golf_time: "09:00:00", golf_course: "SAM", holes: 18,
  guest_unit_price_vnd: sales / 2, guest_total_vnd: sales, course_unit_price_vnd: cost / 2, course_total_vnd: cost,
  cost_settlement_type: "golf_course", customer_type: "company", payments: [],
  smart_cart_note: "400,000 VND", created_at: "2026-10-25T01:00:00Z", updated_at: "2026-10-25T01:00:00Z"
});
const rounds = [makeRound("round-a", "27", 4000000, 3500000), makeRound("round-b", "28", 6000000, 5000000)];
const booking = {
  id: "booking-group-1", label: "이진환", version: 1, completed_at: "2026-11-01T00:00:00Z", completion_date: "2026-11-01",
  rounds, range_from: "2026-11-27", range_to: "2026-11-28",
  guest_total_vnd: 10000000, cost_total_vnd: 8500000, deposit_vnd: 2000000, receipt_vnd: 7000000,
  received_vnd: 9000000, balance_vnd: 1000000, profit_vnd: 500000,
  payments: [
    { id: "parent-deposit", payment_kind: "deposit", amount_vnd: 2000000, payment_date: "2026-10-25", payment_method: "bank" },
    { id: "parent-receipt", payment_kind: "receipt", amount_vnd: 7000000, payment_date: "2026-11-01", payment_method: "card" }
  ]
};
for (const row of rounds) row.booking = booking;
const standalone = { ...makeRound("standalone", "29", 1000000, 800000), booking: null, booking_group_id: null,
  payments: [{ payment_kind: "deposit", amount_vnd: 100000, payment_date: "2026-10-25", payment_method: "cash" },
    { payment_kind: "receipt", amount_vnd: 900000, payment_date: "2026-10-26", payment_method: "bank" }] };
const financialSnapshot = JSON.stringify(rounds.map(({ booking: ignored, ...row }) => row));
const paymentSnapshot = JSON.stringify(booking.payments);
api.state.rows = rounds;
api.render();
assert.equal((byId("reservationTableBody").innerHTML.match(/<tr data-status=/g) || []).length, 2, "Grouping never collapses schedule rows");
assert.doesNotMatch(byId("reservationTableBody").innerHTML, /golf-booking-heading|golf-booking-badge|golf-standalone-label/, "The visible table remains plain per-round rows");
assert.equal((byId("golfBookingPrintSummary").innerHTML.match(/class="golf-booking-report"/g) || []).length, 1, "One whole-group print summary");
assert.equal((byId("golfBookingPrintSummary").innerHTML.match(/class="golf-payment-detail-item"/g) || []).length, 2, "Each parent payment printed once");
assert.equal(byId("summaryCompleted").textContent, "2", "Counts still count rounds");
assert.equal(byId("summaryDeposit").textContent, "2,000,000 VND");
assert.equal(byId("summaryProfit").textContent, "500,000 VND");
assert.equal(byId("summaryScopeNote").hidden, false);
for (const row of rounds) {
  const markup = api.renderRow(row);
  assert.doesNotMatch(markup, /golf-group-member-row|golf-standalone-row/);
  assert.doesNotMatch(markup, /golf-standalone-label/);
  const cells = [...markup.matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/g)];
  assert.equal(cells.length, 25, "Original full-report field order remains intact");
  assert.deepEqual(cells.map((m, i) => m[1].includes("golf-screen-hidden") ? null : i).filter((i) => i !== null), Array.from({ length: 12 }, (_, i) => i));
  assert.match(cells[4][2], /golf-edit-link/); assert.doesNotMatch(cells[4][2], /golf-booking-badge/, "Group title is not repeated on each schedule");
  assert.match(cells[4][2], /aria-controls="reservationDetailDialog"/);
  assert.doesNotMatch(cells[4][2], /data-edit-href|href=/);
  assert.doesNotMatch(cells[1][2], /golf-edit-link|button/);
  assert.equal(cells[11][2], `${row.guest_total_vnd.toLocaleString("ko-KR")} VND`);
  assert.equal(cells[13][2], `${row.course_total_vnd.toLocaleString("ko-KR")} VND`);
  for (const index of [16, 18, 20]) assert.equal(cells[index][2], "묶음 정산 / Thu chung");
}
const detail = api.reservationDetailMarkup(rounds[0]);
assert.equal((detail.match(/class="golf-booking-schedule(?: is-selected)?"/g) || []).length, 2);
assert.equal((detail.match(/class="golf-payment-detail-item"/g) || []).length, 2);
for (const row of rounds) assert.ok(detail.includes(`data-edit-round="${row.id}"`));
assert.match(detail, /선택한 일정 상세 \/ Chi tiết lịch đã chọn/);
assert.match(detail, /SECOND PERSON/);
assert.match(detail, /선택 일정 금액 \/ Số tiền lịch đã chọn/);
assert.match(detail, /묶음 미수금·초과입금[^]*?<dd>1,000,000 VND<\/dd>/);
assert.doesNotMatch(detail, /미수금·초과입금 \/ Còn phải thu · Thu dư/, "Never derive round receivable from whole-group receipts");
api.openReservationDetail(rounds[1]);
assert.match(byId("reservationDetailTitle").textContent, /묶음예약 · 이진환/);
assert.equal(byId("reservationDetailDialog").open, true);

const workbook = api.workbookOptions(rounds);
assert.deepEqual(Array.from(workbook.sheets, (sheet) => sheet.name), ["골프 예약", "입금 내역", "묶음 정산"]);
assert.equal(workbook.sheets[0].rows.length, 7);
for (const row of workbook.sheets[0].rows.slice(5)) {
  assert.equal(row.length, 25);
  for (const index of [16, 18, 20]) assert.equal(row[index].value, "묶음 정산 / Thu chung");
}
assert.equal(workbook.sheets[1].rows.length, 7, "Two parent transactions, not four duplicated child transactions");
assert.deepEqual(Array.from(workbook.sheets[1].rows.slice(5), (row) => row[6].value), [2000000, 7000000]);
assert.equal(workbook.sheets[2].rows.length, 6, "One summary per booking");
const summary = workbook.sheets[2].rows[5];
assert.deepEqual(Array.from(summary.slice(4, 15), (cell) => cell.value), [2, 2, 10000000, 8500000, 10000000, 8500000, 2000000, 7000000, 9000000, 1000000, 500000]);

byId("filterFrom").value = "2026-11-27";
byId("filterTo").value = "2026-11-27";
api.render();
assert.equal((byId("reservationTableBody").innerHTML.match(/<tr data-status=/g) || []).length, 1);
assert.doesNotMatch(byId("reservationTableBody").innerHTML, /golf-booking-heading/);
assert.equal(byId("summaryDeposit").textContent, "2,000,000 VND", "Subset explicitly reports booking-wide deposit once");
const filteredWorkbook = api.workbookOptions(api.filteredRows());
const filteredSummary = filteredWorkbook.sheets[2].rows[5];
assert.deepEqual(Array.from(filteredSummary.slice(4, 15), (cell) => cell.value), [1, 2, 4000000, 3500000, 10000000, 8500000, 2000000, 7000000, 9000000, 1000000, 500000]);
assert.equal(filteredWorkbook.sheets[1].rows.length, 7);
assert.match(byId("golfBookingPrintSummary").innerHTML, /조회 일정 1\/2/);
assert.match(byId("golfBookingPrintSummary").innerHTML, /조회 일정 판매 소계[^]*?<dd>4,000,000 VND<\/dd>/);
assert.match(byId("golfBookingPrintSummary").innerHTML, /묶음 전체 판매 합계[^]*?<dd>10,000,000 VND<\/dd>/);

byId("filterFrom").value = ""; byId("filterTo").value = "";
api.state.rows = [...rounds, standalone]; api.render();
assert.equal(byId("summaryDeposit").textContent, "2,100,000 VND");
assert.equal(byId("summaryProfit").textContent, "700,000 VND");
assert.equal(api.workbookOptions(api.state.rows).sheets[1].rows.length, 9, "Mixed reports include four distinct transactions");
api.state.rows = [standalone]; api.render();
assert.equal(byId("summaryScopeNote").hidden, true);
assert.equal(byId("golfBookingPrintSummary").innerHTML, "");
assert.equal(api.workbookOptions([standalone]).sheets.length, 2, "Standalone report remains two sheets");
assert.doesNotMatch(api.renderRow(standalone), /golf-booking-badge|묶음 정산/);
assert.doesNotMatch(api.renderRow(standalone), /golf-standalone-row|개별 예약 \/ Đặt riêng/);
assert.doesNotMatch(page, /golf-group-member-row|golf-booking-heading/);
assert.doesNotMatch(api.renderTableRows([standalone]), /golf-booking-heading/);

// All rows follow global teeoff order, even if a standalone booking falls
// between two rounds belonging to the same shared-payment booking.
const interleaved = { ...standalone, id: "interleaved", golf_date: "2026-11-27", golf_time: "12:00:00" };
assert.deepEqual(Array.from(api.orderedRows([rounds[1], interleaved, rounds[0]]), (row) => row.id), ["round-a", "interleaved", "round-b"]);
assert.deepEqual(Array.from(api.orderedRows([rounds[1], interleaved]), (row) => row.id), ["interleaved", "round-b"]);
const anotherRound = { ...standalone, id: "group2-round", golf_date: "2026-11-26", booking: null };
const anotherBooking = { ...booking, id: "group-2", label: "장효조", rounds: [anotherRound], range_from: "2026-11-26", range_to: "2026-11-26" };
anotherRound.booking = anotherBooking;
assert.deepEqual(Array.from(api.orderedRows([rounds[1], interleaved, anotherRound, rounds[0]]), (row) => row.id), ["group2-round", "round-a", "interleaved", "round-b"]);

const originalLabel = booking.label;
booking.label = '<img src=x onerror="alert(1)">';
assert.match(api.reservationDetailMarkup(rounds[0]), /&lt;img/);
assert.doesNotMatch(api.renderTableRows(rounds), /<img\b|<script\b/);
assert.doesNotMatch(api.reservationDetailMarkup(rounds[0]), /<img\b|<script\b/);
booking.label = originalLabel;
assert.equal(JSON.stringify(rounds.map(({ booking: ignored, ...row }) => row)), financialSnapshot, "List/report render never mutates per-round amounts");
assert.equal(JSON.stringify(booking.payments), paymentSnapshot, "List/report render never mutates parent payments");
assert.match(source, /"booking_group_id"/);
assert.match(source, /await global\.GolfBookings\.loadAndAttach\(loadedRows\)/);
assert.ok(page.indexOf('src="assets/golf-bookings.js') < page.indexOf('src="assets/golf-reserv-list.js'));
assert.doesNotMatch(source, /\.insert\(|\.update\(/, "List does not duplicate financial save logic");
assert.match(source, /sb\.from\("golf_reservations"\)\.delete\(\)\.eq\("id", target\.id\)/, "Deletion is an explicit exact-row action");
assert.doesNotMatch(source, /tableBody\.addEventListener\("dblclick"|global\.location\.assign/);
assert.match(source, /function openInlineEditor\(recordId, mode = "edit"\)/);
console.log("Grouped booking list keeps each round, preserves edit and amounts, exposes shared detail, deduplicates parent payments and profit in summaries/print/XLSX, labels filtered subtotal vs whole booking, escapes HTML, and remains read-only.");
