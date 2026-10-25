import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [page, source] = await Promise.all([
  readFile(path.join(root, "golf_reserv.html"), "utf8"),
  readFile(path.join(root, "assets/golf-reserv.js"), "utf8"),
]);
const elements = new Map([...page.matchAll(/\bid="([^"]+)"/g)].map((match) => [match[1], {
  value: "", textContent: "", innerHTML: "", hidden: false, checked: false,
  setAttribute() {}, setCustomValidity() {},
}]));
const byId = (id) => { assert.ok(elements.has(id), `Unknown DOM id: ${id}`); return elements.get(id); };
const window = {
  DGV: {
    supabase: new Proxy({}, { get() { throw new Error("No database access is permitted"); } }),
    escapeHTML: String, formatYmdInTimeZone: () => "2026-10-25",
  },
  QRStaff: {}, confirm: () => false,
};
vm.runInNewContext(source.replace(/\n  init\(\);/, `
  global.__test = { state, payloadFromForm, updatePreview, receivableGroups,
    receivedAmountForBooking, syncBookingContext, canLeaveEditedBooking,
    managementEntries, renderBookingGroup, render };
`), { window, document: { getElementById: byId }, console, URL });
const api = window.__test;
const base = {
  counterparty_name: "Chị Oanh", representative_name: "JANG", player_names_en: "JANG",
  customer_type: "company", golf_time: "09:00:00", golf_course: "SAM", holes: 18,
  cost_settlement_type: "golf_course", guest_unit_price_vnd: 1000000,
  course_unit_price_vnd: 800000, status: "in_progress", payments: [],
};
const first = { ...base, id: "round1", golf_date: "2027-01-06", pax: 7, guest_total_vnd: 7000000, course_total_vnd: 5600000 };
const second = { ...base, id: "round2", golf_date: "2027-01-09", pax: 8, guest_total_vnd: 8000000, course_total_vnd: 6400000 };
const payments = [{
  id: "p1", payment_kind: "deposit", amount_vnd: 4000000, payment_date: "2026-10-25",
  payment_method: "bank", completes_booking: false, sort_order: 0,
}];
const booking = {
  id: "group1", label: "JANG", version: 1, rounds: [first, second], payments,
  guest_total_vnd: 15000000, cost_total_vnd: 12000000, completed_at: null,
  range_from: first.golf_date, range_to: second.golf_date,
};
first.booking = booking;
second.booking = booking;
api.state.rows = [first, second];
api.state.paymentDrafts = { deposit: payments.map((payment) => ({ ...payment })), receipt: [], withdrawal: [] };
for (const [id, value] of Object.entries({
  recordId: first.id, counterpartyName: first.counterparty_name, playerNamesEn: "JANG\nSECOND",
  pax: "7", customerType: "company", golfDate: first.golf_date, golfHour: "09", golfMinute: "00",
  golfCourse: "SAM", holes: "18", guestUnitPrice: "1000000", courseUnitPrice: "800000",
  costSettlementType: "golf_course",
})) byId(id).value = value;
api.syncBookingContext(first);
api.updatePreview();
assert.equal(byId("bookingGroupGuestTotal").textContent, "15,000,000 VND");
assert.equal(byId("customerBalancePreview").textContent, "11,000,000 VND");
assert.equal(byId("counterpartyName").readOnly, true);
assert.equal(byId("customerType").disabled, true);
assert.match(byId("bookingGroupSchedules").innerHTML, /7명[\s\S]*8명/);
const payload = api.payloadFromForm();
assert.equal(payload.reservation.pax, 7);
assert.equal(payload.payments.length, 1);
assert.equal(payload.payments[0].amount_vnd, 4000000);
assert.equal(second.pax, 8);
byId("pax").value = "9";
api.updatePreview();
assert.equal(byId("bookingGroupGuestTotal").textContent, "17,000,000 VND");
assert.equal(byId("bookingGroupCostTotal").textContent, "13,600,000 VND");
assert.equal(first.pax, 7, "Preview does not mutate stored rounds");
assert.equal(second.pax, 8, "Changing one round never changes another round's pax");

const cards = api.managementEntries([first, second]);
assert.equal(cards.length, 1, "Management shows one card per grouped booking");
assert.equal(cards[0].matchedRoundIds.size, 2);
let groupMarkup = api.renderBookingGroup(cards[0]);
assert.equal((groupMarkup.match(/<article /g) || []).length, 1);
assert.equal((groupMarkup.match(/data-group-round-id=/g) || []).length, 2);
assert.equal((groupMarkup.match(/data-action="delete"/g) || []).length, 2, "Only individual rounds have delete buttons");
assert.equal((groupMarkup.match(/공통 계약금·입금 내역/g) || []).length, 1);
assert.match(groupMarkup, /7명[\s\S]*8명/);
assert.match(groupMarkup, /이 일정만 삭제/);
assert.match(groupMarkup, /묶음 입금·완료 처리/);
const partialCards = api.managementEntries([second]);
groupMarkup = api.renderBookingGroup(partialCards[0]);
assert.match(groupMarkup, /조회 조건 일치 1 \/ 전체 2일정/);
assert.equal((groupMarkup.match(/data-group-round-id=/g) || []).length, 2, "A filter match must still show all linked schedules");
assert.match(groupMarkup, /is-outside-filter/);
assert.equal(api.managementEntries([first, { ...base, id: "single" }, second]).length, 2);
api.render();
assert.equal((byId("reservationList").innerHTML.match(/<article /g) || []).length, 1);
assert.match(byId("listCount").textContent, /1개 예약.*2일정/);

for (const [from, to] of [["", ""], ["2027-01-09", "2027-01-09"]]) {
  const [group] = api.receivableGroups([first, second], from, to);
  assert.equal(group.bookingCount, 1);
  assert.equal(group.expected, 15000000);
  assert.equal(group.received, 4000000);
  assert.equal(group.receivable, 11000000);
}
api.state.partnerOffsets = [{ reservation_id: second.id, partner_name: "Chị Oanh", golf_date: second.golf_date, amount_vnd: 6400000, active: true }];
const [net] = api.receivableGroups([first, second], "2027-01-09", "2027-01-09");
assert.equal(net.partnerOffset, 6400000);
assert.equal(net.receivable, 4600000, "Partner offsets remain per-round, not whole-group deductions");
api.state.formDirty = true;
assert.equal(api.canLeaveEditedBooking(), false);
booking.payments = [];
first.final_received_amount_vnd = 9999999;
assert.equal(api.receivedAmountForBooking(first), 0, "Never fall back to preserved child payment fields");
api.syncBookingContext();
assert.equal(byId("counterpartyName").readOnly, false);
assert.equal(byId("customerType").disabled, false);
assert.equal(byId("bookingGroupPanel").hidden, true);

assert.match(source, /"booking_group_id"/);
assert.match(source, /save_golf_booking_group[\s\S]*p_expected_version: booking\.version/);
assert.match(source, /delete_golf_booking_round[\s\S]*p_expected_version: row\.booking\.version/);
assert.match(source, /const loadedRows = reservations\.map/);
assert.match(source, /await global\.GolfBookings\.loadAndAttach\(loadedRows\)/);
assert.match(source, /row\.booking_group_id && row\.booking\?\.id !== row\.booking_group_id/);
assert.ok(source.indexOf("await global.GolfBookings.loadAndAttach(loadedRows)") < source.indexOf("state.rows = loadedRows"), "Only publish a fully attached snapshot");
console.log("Grouped management cards, all-round visibility under filters, per-round pax, shared payments, aggregate preview, receivables, optimistic version, load failure guard and standalone unlock verified (no database writes).");
