import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFile(path.join(root, file), "utf8");
const [page, source, schema, rpc] = await Promise.all([
  read("golf_reserv.html"), read("assets/golf-reserv.js"),
  read("supabase/migrations/20261024103000_golf_reservations.sql"),
  read("supabase/migrations/20261024150000_add_golf_partner_settlement.sql"),
]);
const form = page.match(/<form id="reservationForm"[^>]*>([\s\S]*?)<\/form>/)[1];
const labels = [...form.matchAll(/<(?:span|legend) class="qr-label">([\s\S]*?)<\/(?:span|legend)>/g)];
assert.equal(labels.filter((m) => m[1].includes('class="golf-required-mark"')).length, 6,
  "Exactly the six manual field groups receive required markers; pax/price/payments do not");
const controls = new Map([...form.matchAll(/<(input|textarea|select)\b([^>]+)>/g)].map((m) => {
  const id = m[2].match(/\bid="([^"]+)"/)?.[1]; return [id, m[2]];
}).filter(([id]) => id));
for (const id of ["counterpartyName", "playerNamesEn", "customerType", "golfDate", "golfHour", "golfMinute", "golfCourse", "holes"]) {
  assert.match(controls.get(id), /\brequired\b/, `${id} must retain semantic required status`);
}
for (const id of ["pax", "guestUnitPrice", "courseUnitPrice", "smartCartNote", "costSettlementType", "note"]) {
  assert.doesNotMatch(controls.get(id), /\brequired\b/, `${id} must not add an obligatory manual step`);
}
assert.match(page, /필수입니다[\s\S]*Các mục có dấu \* là bắt buộc/);
assert.match(page, /가격·S-CART·계약금·입금은 비워두고 진행 중으로 저장/);
assert.match(source, /function paxFromForm\(\)/);
const elements = new Map([...page.matchAll(/\bid="([^"]+)"/g)].map((m) => [m[1], {
  value: "", textContent: "", hidden: false, checked: false,
  setAttribute() {}, setCustomValidity() {},
}]));
const byId = (id) => { assert.ok(elements.has(id), `Unknown DOM id: ${id}`); return elements.get(id); };
const window = { DGV: { supabase: new Proxy({}, { get() { throw new Error("No database access is permitted in this test"); } }),
  escapeHTML: String, formatYmdInTimeZone: () => "2026-10-25" }, QRStaff: {} };
vm.runInNewContext(source.replace(/\n  init\(\);/, "\n  global.__test = { state, paxFromForm, payloadFromForm, updatePreview };"),
  { window, document: { getElementById: byId }, console, URL });
const api = window.__test;
const minimal = {
  counterpartyName: "Agency", playerNamesEn: " FIRST PERSON \n SECOND PERSON ", customerType: "company",
  golfDate: "2026-10-26", golfHour: "09", golfMinute: "00", golfCourse: "SAM", holes: "18",
  costSettlementType: "golf_course",
};
for (const [id, value] of Object.entries(minimal)) byId(id).value = value;
assert.equal(api.paxFromForm(), 2, "Blank pax is derived from names even without the input event");
let payload = api.payloadFromForm();
assert.equal(payload.reservation.pax, 2);
assert.equal(payload.reservation.representative_name, "FIRST PERSON");
assert.equal(payload.reservation.player_names_en, "FIRST PERSON\nSECOND PERSON");
for (const field of ["guest_unit_price_vnd", "course_unit_price_vnd", "smart_cart_note", "note", "cost_partner_name"]) {
  assert.equal(payload.reservation[field], null, `Optional ${field} must stay null, not invented zero`);
}
assert.equal(payload.payments.length, 0, "Saving a minimal booking creates no artificial payment rows");
assert.equal(payload.reservation.final_received_amount_vnd, undefined, "Completion remains server-derived");
assert.equal(payload.reservation.final_received_date, undefined);
api.updatePreview();
assert.equal(byId("statusPreview").textContent, "진행중 / Đang xử lý");
assert.equal(byId("guestTotalPreview").textContent, "—");
assert.equal(byId("courseTotalPreview").textContent, "—");
for (const id of ["counterpartyName", "playerNamesEn", "customerType", "golfDate", "golfHour", "golfCourse", "holes"]) {
  const before = byId(id).value; byId(id).value = "";
  assert.throws(() => api.payloadFromForm(), undefined, `${id} must not be optional`);
  byId(id).value = before;
}
byId("pax").value = "4"; assert.equal(api.payloadFromForm().reservation.pax, 4, "Explicit pax override remains available");
byId("pax").value = "0"; assert.throws(() => api.payloadFromForm(), /인원/);
byId("pax").value = "101"; assert.throws(() => api.payloadFromForm(), /인원/);
byId("pax").value = " "; assert.equal(api.payloadFromForm().reservation.pax, 2);
byId("playerNamesEn").value = Array(101).fill("A").join("\n"); assert.throws(() => api.payloadFromForm(), /인원/);
byId("playerNamesEn").value = minimal.playerNamesEn;
byId("paymentCompleted").checked = true; assert.throws(() => api.payloadFromForm(), /완료/);
byId("paymentCompleted").checked = false;
byId("costSettlementType").value = "partner"; api.updatePreview();
payload = api.payloadFromForm();
assert.equal(payload.reservation.cost_partner_name, "Chị Oanh");
assert.equal(payload.payments.length, 0);

// These are static server contracts, not a live DB integration test. With no
// payment rows, the existing RPC writes NULL final fields and generated status
// stays in_progress; this UI change needs no schema/accounting mutation.
assert.match(rpc, /coalesce\(sum\(amount_vnd\) filter \(where payment_kind = 'deposit'\), 0\)/);
assert.match(rpc, /if v_deposit_count = 0 then[\s\S]*?v_deposit_date := \(\(now\(\) at time zone 'Asia\/Ho_Chi_Minh'\)\)::date/);
assert.match(rpc, /case when v_completion_count = 1 then v_received_total else null end/);
assert.match(rpc, /case when v_completion_count = 1 then v_completion_date else null end/);
assert.match(schema, /when final_received_amount_vnd is not null[\s\S]*?and final_received_date is not null[\s\S]*?then 'completed'[\s\S]*?else 'in_progress'/);
console.log("Six required field groups, optional financial fields, automatic pax, minimal pending payload, and unchanged RPC status contracts verified (no database writes).");
