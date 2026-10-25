import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [page, source] = await Promise.all([
  readFile(path.join(root, "golf_reserv.html"), "utf8"),
  readFile(path.join(root, "assets/golf-reserv.js"), "utf8")
]);
const elements = new Map([...page.matchAll(/\bid="([^"]+)"/g)].map((match) => [match[1], {
  id: match[1], value: "", textContent: "", innerHTML: "", checked: false, hidden: false, disabled: false,
  options: Array.from({ length: 60 }, (_, value) => ({ value: String(value).padStart(2, "0") })),
  dataset: {}, setAttribute() {}, setCustomValidity() {}, focus() {}, scrollIntoView() {}, querySelector() { return null; },
  querySelectorAll() { return []; }, append() {}, add() {}, classList: { add() {}, remove() {} }
}]));
const byId = (id) => { assert.ok(elements.has(id), `Missing DOM fixture: ${id}`); return elements.get(id); };
byId("reservationForm").querySelectorAll = () => [...elements.values()];
byId("reservationForm").reset = () => { for (const element of elements.values()) { element.value = ""; element.checked = false; } };
let sequence = 0, rpcHandler = async () => ({ data: null, error: { code: "23514", message: "Expected validation rejection" } });
const calls = [], toasts = [];
const window = {
  DGV: { escapeHTML: String, formatYmdInTimeZone: () => "2026-10-25", collectSupabasePages: async () => [],
    supabase: { rpc: async (name, args) => { calls.push({ name, args: JSON.parse(JSON.stringify(args)) }); return rpcHandler(name, args); } } },
  QRStaff: { toast: (message) => toasts.push(message), connectionBadge() {}, messageOf: (error, fallback) => error?.message || fallback,
    setBusy: (button, value, label) => { button.disabled = value; if (value && label) button.textContent = label; } },
  GolfBookings: { loadAndAttach: async (rows) => rows }, confirm: () => true,
  crypto: { randomUUID: () => `70000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}` }
};
vm.runInNewContext(source.replace(/\n  init\(\);/, `
  global.__test={state,resetForm,changeBookingMode,addCreateRound,switchCreateRound,removeCreateRound,
    collectCreatePayload,save,canLeaveEditedBooking,updatePreview,fillForm,deleteBookingGroup,removeRow};
`), { window, document: { getElementById: byId, querySelectorAll: () => [] }, console, URL });
const api = window.__test, setValues = (values) => { for (const [id, value] of Object.entries(values)) byId(id).value = value; };
api.resetForm({ focus: false });
byId("bookingMode").value = "group"; api.changeBookingMode();
assert.equal(api.state.createGroupMode, true);
const requestId = api.state.createRequestId;
setValues({ counterpartyName: "QA AGENCY", customerType: "company", playerNamesEn: "A\nB\nC\nD\nE\nF\nG", pax: "7",
  golfDate: "2027-01-06", golfHour: "07", golfMinute: "00", golfCourse: "SAM", holes: "18",
  guestUnitPrice: "3000000", courseUnitPrice: "2500000", costSettlementType: "golf_course" });
api.addCreateRound();
assert.equal(api.state.createRounds.length, 2);
assert.equal(byId("golfDate").value, ""); assert.equal(byId("golfHour").value, "", "New dates/times must be selected, not silently copied");
setValues({ playerNamesEn: "A\nB\nC\nD\nE\nF\nG\nH", pax: "8", golfDate: "2027-01-09", golfHour: "09",
  golfCourse: "AT1200", guestUnitPrice: "3200000", courseUnitPrice: "2600000" });
api.state.paymentDrafts.deposit = [{ id: null, payment_kind: "deposit", amount_vnd: 2000000, payment_date: "2026-10-25", payment_method: "bank", sort_order: 0 }];
const sharedPayment = api.state.paymentDrafts.deposit[0];
api.switchCreateRound(0); assert.equal(byId("pax").value, "7"); byId("guestUnitPrice").value = "3100000";
api.switchCreateRound(1); assert.equal(byId("pax").value, "8");
assert.equal(api.state.paymentDrafts.deposit[0], sharedPayment, "Switching schedules preserves the shared ledger");
api.addCreateRound(); assert.equal(api.state.createRounds.length, 3); api.removeCreateRound(); assert.equal(api.state.createRounds.length, 2);
let payload = api.collectCreatePayload();
assert.equal(payload.p_request_id, requestId);
assert.equal(payload.p_label, "A · 2027-01-06", "Default group label includes representative and first date");
assert.deepEqual(Array.from(payload.p_rounds, (r) => r.pax), [7, 8]);
assert.deepEqual(Array.from(payload.p_rounds, (r) => r.guest_unit_price_vnd), [3100000, 3200000]);
assert.deepEqual(Array.from(payload.p_rounds, (r) => r.course_unit_price_vnd), [2500000, 2600000]);
assert.equal(payload.p_rounds[0].player_names_en.split("\n").length, 7);
assert.equal(payload.p_rounds[1].player_names_en.split("\n").length, 8);
assert.equal(payload.p_payments.length, 1); assert.equal(payload.p_payments[0].amount_vnd, 2000000);
assert.ok(payload.p_rounds.every((r) => !Object.hasOwn(r, "expected_updated_at")), "Creation cannot accidentally use edit snapshots");
assert.equal(byId("pax").value, "8", "Validation restores the selected draft");
for (const field of ["golfDate", "golfHour"]) {
  const previous = api.state.createRounds[0].values[field]; api.state.createRounds[0].values[field] = "";
  assert.throws(() => api.collectCreatePayload(), /1번째 일정.*Lịch 1/);
  assert.equal(byId("pax").value, "8"); assert.equal(byId("golfDate").value, "2027-01-09");
  api.state.createRounds[0].values[field] = previous;
}
byId("createGroupLabel").value = "X".repeat(161); assert.throws(() => api.collectCreatePayload(), /160/); byId("createGroupLabel").value = "";
const savedFirstPrices = [api.state.createRounds[0].values.guestUnitPrice, api.state.createRounds[0].values.courseUnitPrice];
api.state.createRounds[0].values.guestUnitPrice = ""; api.state.createRounds[0].values.courseUnitPrice = "";
payload = api.collectCreatePayload(); assert.equal(payload.p_rounds[0].guest_unit_price_vnd, null); assert.equal(payload.p_rounds[0].course_unit_price_vnd, null);
assert.equal(byId("statusPreview").textContent, "진행중 / Đang xử lý"); assert.equal(byId("createGroupGuestTotal").textContent, "—");
byId("paymentCompleted").checked = true; assert.throws(() => api.collectCreatePayload(), /원가/); byId("paymentCompleted").checked = false;
[api.state.createRounds[0].values.guestUnitPrice, api.state.createRounds[0].values.courseUnitPrice] = savedFirstPrices;
const beforeFailure = JSON.stringify(api.collectCreatePayload());

// Repeated submit while in flight is ignored. A known rejection leaves all
// drafts editable and retains the same request identity for a safe retry.
let finish;
rpcHandler = () => new Promise((resolve) => { finish = resolve; });
const submit = api.save({ preventDefault() {} });
assert.equal(api.state.saving, true); assert.equal(calls.length, 1);
await api.save({ preventDefault() {} }); assert.equal(calls.length, 1);
finish({ data: null, error: { code: "23514", message: "Expected validation rejection" } }); await submit;
assert.equal(api.state.saving, false); assert.equal(api.state.createRequestId, requestId);
assert.equal(api.state.createRounds.length, 2); assert.equal(byId("playerNamesEn").disabled, false);
assert.equal(JSON.stringify(api.collectCreatePayload()), beforeFailure);
assert.equal(calls[0].name, "create_golf_booking_group");

// A transport failure may follow a committed transaction. Keep the exact
// snapshot locked, even if a subsequent retry receives a definite rejection.
rpcHandler = async () => { throw new TypeError("Failed to fetch"); };
await api.save({ preventDefault() {} });
assert.equal(api.state.createAttempt.uncertain, true); assert.equal(byId("playerNamesEn").disabled, true);
assert.equal(api.canLeaveEditedBooking(), false); assert.equal(api.state.createRequestId, requestId);
const uncertainPayload = JSON.stringify(api.state.createAttempt.payload);
rpcHandler = async () => ({ data: null, error: { code: "23514", message: "Retry rejection" } });
await api.save({ preventDefault() {} });
assert.equal(api.state.createAttempt.uncertain, true); assert.equal(JSON.stringify(api.state.createAttempt.payload), uncertainPayload);
assert.equal(byId("playerNamesEn").disabled, true);
byId("bookingMode").value = "single"; api.changeBookingMode(); assert.equal(api.state.createGroupMode, true); assert.equal(byId("bookingMode").value, "group");
rpcHandler = async () => ({ data: [{ saved_id: "saved-round", saved_status: "in_progress", booking_group_id: "saved-group" }], error: null });
await api.save({ preventDefault() {} });
assert.equal(api.state.createGroupMode, false); assert.equal(api.state.createRequestId, null); assert.equal(api.state.createAttempt, null);
assert.equal(byId("playerNamesEn").disabled, false);
assert.ok(calls.every((call) => call.name === "create_golf_booking_group"));
for (const call of calls) assert.equal(JSON.stringify(call.args), beforeFailure, "Every retry must submit the same request ID and payload");
assert.ok(toasts.some((text) => /저장 결과가 불확실/.test(text)));
assert.ok(toasts.some((text) => /함께 저장/.test(text)));

// Whole-group deletion is a separately confirmed single RPC. Cancellation and
// a second click while the first request is pending cannot issue more writes.
const deleteRound = { id: "70000000-0000-4000-8000-000000000071", representative_name: "DELETE QA", golf_date: "2027-01-06", golf_course: "SAM" };
const deleteGroup = { id: "70000000-0000-4000-8000-000000000070", label: "DELETE QA", version: 9, rounds: [deleteRound], payments: [sharedPayment] };
deleteRound.booking = deleteGroup;
api.state.rows = [deleteRound];
const callsBeforeDelete = calls.length;
const warnings = [];
window.confirm = (message) => { warnings.push(message); return false; };
await api.deleteBookingGroup(deleteGroup);
assert.equal(calls.length, callsBeforeDelete, "Cancel causes zero deletion RPCs");
assert.match(warnings[0], /계약금.*Tiền cọc[^]*2,000,000 VND/);
assert.match(warnings[0], /복구할 수 없습니다[^]*không thể khôi phục/);
assert.match(warnings[0], /복원됩니다[^]*hoàn lại/);
window.confirm = () => true;
let finishDelete;
rpcHandler = () => new Promise((resolve) => { finishDelete = resolve; });
const deleting = api.deleteBookingGroup(deleteGroup);
assert.equal(api.state.saving, true);
await api.deleteBookingGroup(deleteGroup);
assert.equal(calls.length, callsBeforeDelete + 1, "Duplicate click during delete is ignored");
assert.equal(calls.at(-1).name, "delete_golf_booking_group");
assert.deepEqual(calls.at(-1).args, { p_group_id: deleteGroup.id, p_expected_version: 9 });
finishDelete({ data: deleteGroup.id, error: null }); await deleting;
assert.equal(api.state.saving, false);
rpcHandler = async () => ({ data: deleteRound.id, error: null });
await api.removeRow(deleteRound);
assert.equal(calls.at(-1).name, "delete_golf_booking_round", "Existing one-round deletion remains independent");
assert.deepEqual(calls.at(-1).args, { p_reservation_id: deleteRound.id, p_expected_version: 9 });
assert.match(page, /id="bookingMode"/); assert.match(page, /value="single" selected/); assert.match(page, /value="group"/);
assert.match(page, /id="createGroupLabel"[^>]*maxlength="160"/);
assert.match(source, /const \{ expected_updated_at, \.\.\.reservation \} = payload\.reservation/);
assert.match(source, /if \(state\.createGroupMode\) \{ await saveCreatedGroup\(\); return; \}/);
assert.match(source, /sb\.rpc\("create_golf_booking_group", state\.createAttempt\.payload\)/);
assert.match(source, /save_golf_booking_group/); assert.match(source, /save_golf_reservation_with_payments/);
assert.match(source, /data-action="delete-group"/);
console.log("Golf booking creation and group deletion: independent schedules, shared payments, required date/time, unknown-price pending, one create RPC, double-submit guard, immutable retry, success reset, cancel/no-write, UUID+version group delete, duplicate-delete guard and unchanged one-round deletion verified without network or DB writes.");
