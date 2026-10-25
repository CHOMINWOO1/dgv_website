import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFile(path.join(root, file), "utf8");
const [source, migration, integration] = await Promise.all([
  read("assets/golf-bookings.js"),
  read("supabase/migrations/20261025034641_golf_booking_groups.sql"),
  read("supabase/tests/golf_booking_groups.sql"),
]);
let unexpectedFetches = 0;
const window = { DGV: { supabase: { from() { unexpectedFetches += 1; throw new Error("Unexpected network access"); } } } };
vm.runInNewContext(source, { window, console }, { filename: "assets/golf-bookings.js" });
const { attach, loadAndAttach } = window.GolfBookings;
assert.equal(typeof attach, "function");
assert.equal(typeof loadAndAttach, "function");

const group = { id: "group-a", label: "Two dated rounds", version: 5,
  completed_at: "2027-01-24T00:00:00Z", completion_date: "2027-01-24" };
const roundOne = { id: "round-1", booking_group_id: group.id, status: "completed",
  golf_date: "2027-01-25", golf_time: "08:00:00", golf_course: "SAM", pax: 7,
  player_names_en: "A\nB\nC\nD\nE\nF\nG", guest_unit_price_vnd: 4000000, guest_total_vnd: 28400000,
  course_unit_price_vnd: 3000000, course_total_vnd: 21400000, smart_cart_note: "400,000 VND",
  payments: [{ id: "legacy-child", payment_kind: "deposit", amount_vnd: 999 }] };
const roundTwo = { id: "round-2", booking_group_id: group.id, status: "completed",
  golf_date: "2027-01-26", golf_time: "09:00:00", golf_course: "AT1200", pax: 8,
  player_names_en: "A\nB\nC\nD\nE\nF\nG\nH", guest_unit_price_vnd: 4000000, guest_total_vnd: 32000000,
  course_unit_price_vnd: 3000000, course_total_vnd: 24000000, payments: [] };
const standalone = { id: "standalone", booking_group_id: null, golf_date: "2027-01-25", pax: 1,
  guest_total_vnd: 3000000, course_total_vnd: 2000000, deposit_amount_vnd: 1000000,
  payments: [{ id: "old-payment", payment_kind: "deposit", amount_vnd: 1000000 }] };
const payment = (id, kind, amount, order = 0) => ({ id, booking_group_id: group.id,
  payment_kind: kind, amount_vnd: amount, payment_date: kind === "receipt" ? "2027-01-24" : "2027-01-20",
  payment_method: "bank", completes_booking: kind === "receipt", sort_order: order });
const payments = [payment("deposit-b", "deposit", 1000000, 1),
  payment("receipt", "receipt", 58400000), payment("deposit-a", "deposit", 1000000)];
const rows = [roundTwo, standalone, roundOne];
const original = JSON.stringify({ rows, group, payments });
const result = attach(rows, [group], payments);
assert.notEqual(result, rows);
assert.equal(result.length, 3, "grouping must retain all per-round list rows");
assert.notEqual(result[0], roundTwo);
assert.equal(result[0].booking, result[2].booking, "group members share exactly one booking object");
assert.equal(result[1].booking, null, "standalone reservations retain the old financial path");
assert.equal(result[1].payments, standalone.payments, "legacy ledger is not rewritten");
const booking = result[0].booking;
assert.deepEqual(Array.from(booking.rounds, (r) => r.id), ["round-1", "round-2"]);
assert.equal(booking.rounds[0], result[2]);
assert.deepEqual(Array.from(booking.rounds, (r) => r.pax), [7, 8]);
assert.equal(booking.rounds[0].player_names_en.split("\n").length, 7);
assert.equal(booking.rounds[1].player_names_en.split("\n").length, 8);
assert.equal(booking.guest_total_vnd, 60400000, "sum saved totals without multiplying by PAX again");
assert.equal(booking.cost_total_vnd, 45400000, "include S-CART once in the saved round cost");
assert.equal(booking.deposit_vnd, 2000000, "same-amount distinct transactions both count");
assert.equal(booking.receipt_vnd, 58400000);
assert.equal(booking.received_vnd, 60400000, "shared receipts do not multiply by the number of rounds");
assert.equal(booking.balance_vnd, 0);
assert.equal(booking.profit_vnd, 15000000);
assert.equal(booking.range_from, "2027-01-25");
assert.equal(booking.range_to, "2027-01-26");
assert.deepEqual(Array.from(booking.payments, (p) => p.id), ["deposit-a", "deposit-b", "receipt"]);
assert.equal(booking.payments.some((p) => p.id === "legacy-child"), false, "never append child payments to shared money");
assert.equal(JSON.stringify({ rows, group, payments }), original, "attach is pure for source rows and both ledgers");
assert.equal(unexpectedFetches, 0);

// Always attach the complete dataset BEFORE filtering. A visible subset must
// retain parent-wide money/cost context, not subtract full money from one round.
const filtered = result.filter((r) => r.golf_date === "2027-01-26");
assert.equal(filtered.length, 1);
assert.equal(filtered[0].booking.rounds.length, 2);
assert.equal(filtered[0].booking.received_vnd, 60400000);
assert.equal(filtered[0].booking.cost_total_vnd, 45400000);
assert.equal(new Map(result.filter((r) => r.booking).map((r) => [r.booking.id, r.booking])).size, 1);

const pendingRounds = [roundOne, roundTwo].map((r) => ({ ...r, status: "in_progress" }));
const pendingPayments = payments.map((p) => ({ ...p, completes_booking: false }));
const pending = attach(pendingRounds, [{ ...group, completed_at: null, completion_date: null }], pendingPayments)[0].booking;
assert.equal(pending.profit_vnd, null, "pending bookings do not claim settled profit");
assert.equal(pending.received_vnd, 60400000, "reopening preserves recorded money");
const unknownGuest = attach([{ ...roundOne, guest_total_vnd: null }, roundTwo], [group], payments)[0].booking;
assert.equal(unknownGuest.guest_total_vnd, null);
assert.equal(unknownGuest.balance_vnd, null);
assert.equal(unknownGuest.cost_total_vnd, 45400000);
const unknownCost = attach([roundOne, { ...roundTwo, course_total_vnd: null }], [group], payments)[0].booking;
assert.equal(unknownCost.cost_total_vnd, null);
assert.equal(unknownCost.profit_vnd, null);
assert.equal(unknownCost.guest_total_vnd, 60400000);
const empty = attach([{ ...roundOne, status: "in_progress", guest_total_vnd: null, course_total_vnd: null },
  { ...roundTwo, status: "in_progress", guest_total_vnd: null, course_total_vnd: null }],
[{ ...group, completed_at: null, completion_date: null }], [])[0].booking;
assert.equal(empty.received_vnd, 0);
assert.equal(empty.guest_total_vnd, null);
assert.equal(empty.cost_total_vnd, null);
assert.equal(empty.profit_vnd, null, "unpriced 7/8-person sample has no invented financial effect");
for (const [amount, expectedBalance, expectedProfit] of [[50000000, 8400000, 6600000], [70000000, -11600000, 26600000]]) {
  const adjusted = attach([roundOne, roundTwo], [group], payments.map((p) =>
    p.payment_kind === "receipt" ? { ...p, amount_vnd: amount } : p))[0].booking;
  assert.equal(adjusted.balance_vnd, expectedBalance);
  assert.equal(adjusted.profit_vnd, expectedProfit, "discount and overpayment are actual amounts, not auto-balanced");
}
const sameDate = attach([{ ...roundTwo, golf_date: roundOne.golf_date, golf_time: roundOne.golf_time }, roundOne], [group], payments);
assert.deepEqual(Array.from(sameDate[0].booking.rounds, (r) => r.id), ["round-1", "round-2"], "date/time ties use stable IDs");

for (const call of [
  () => attach(null), () => attach([roundOne], [], []),
  () => attach([roundOne, roundOne], [group], []), () => attach([roundOne], [group, group], []),
  () => attach([roundOne], [group], [payments[0], payments[0]]),
  () => attach([roundOne], [group], [{ ...payments[0], booking_group_id: "missing" }]),
  () => attach([roundOne], [group], [{ ...payments[0], payment_kind: "withdrawal" }]),
  ...[-1, null, "", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map((amount) =>
    () => attach([roundOne], [group], [{ ...payments[0], amount_vnd: amount }])),
  () => attach([{ ...roundOne, guest_total_vnd: NaN }], [group], []),
  () => attach([{ ...roundOne, guest_total_vnd: Number.MAX_SAFE_INTEGER }, { ...roundTwo, guest_total_vnd: 1 }], [group], []),
  () => attach([roundOne], [group], [payment("huge-a", "deposit", Number.MAX_SAFE_INTEGER), payment("huge-b", "receipt", 1)]),
]) assert.throws(call, /묶음|Invalid|Unsafe|Duplicate|missing|Orphan|Negative/);

// Independent API reads can straddle a concurrent save. Refuse mixed versions
// of completion state instead of displaying an invented financial result.
for (const invalidGroup of [
  { ...group, version: 0 }, { ...group, version: -1 },
  { ...group, version: Number.MAX_SAFE_INTEGER + 1 },
  { ...group, completed_at: null }, { ...group, completion_date: null },
  { ...group, completion_date: "2027-01-23" },
]) assert.throws(() => attach([roundOne, roundTwo], [invalidGroup], payments), /묶음|Invalid|completion|version/i);
assert.throws(() => attach([roundOne, roundTwo], [group], pendingPayments), /묶음|completion/i);
assert.throws(() => attach(pendingRounds, [{ ...group, completed_at: null, completion_date: null }], payments), /묶음|completion/i);
assert.throws(() => attach([roundOne, { ...roundTwo, status: "in_progress" }], [group], payments), /묶음|completion|status/i);
assert.throws(() => attach([roundOne, roundTwo], [group], payments.map((p) => ({ ...p, completes_booking: true }))), /묶음|completion/i);

// No group => no database request. Group loading only attaches metadata to the
// existing array; it never replaces row identity or edits a legacy payment.
const standaloneLoad = [{ ...standalone }];
assert.equal(await loadAndAttach(standaloneLoad), standaloneLoad);
assert.equal(standaloneLoad[0].booking, null);
assert.equal(unexpectedFetches, 0);
const requests = [];
window.DGV.supabase.from = (table) => ({ select(columns) {
  return { in(column, ids) { return { table, columns, column, ids }; } };
} });
window.DGV.collectSupabasePages = async (build, options) => {
  const request = build(); requests.push({ ...request, options });
  return request.table === "golf_booking_groups" ? [group] : payments;
};
const mutableRows = rows.map((r) => ({ ...r }));
assert.equal(await loadAndAttach(mutableRows), mutableRows);
assert.equal(mutableRows[0].booking.rounds[0], mutableRows[2]);
assert.equal(mutableRows[2].payments, roundOne.payments);
assert.equal(requests.length, 2);
assert.deepEqual(Array.from(requests[0].ids), [group.id]);
assert.ok(requests.every((r) => r.options.pageSize === 500));
assert.ok(requests.every((r) => r.options.order.at(-1).column === "id"));
const attachedBeforeRace = mutableRows.map((r) => r.booking);
window.DGV.collectSupabasePages = async (build) =>
  build().table === "golf_booking_groups" ? [group] : pendingPayments;
await assert.rejects(loadAndAttach(mutableRows), /묶음|completion/i);
for (let index = 0; index < mutableRows.length; index += 1) {
  assert.equal(mutableRows[index].booking, attachedBeforeRace[index], "inconsistent fetch cannot partially replace attached rows");
}
const manyRows = Array.from({ length: 101 }, (_, index) => ({
  id: `round-${index}`, booking_group_id: `group-${String(index).padStart(3, "0")}`,
  status: "in_progress", golf_date: "2027-01-25", golf_time: "08:00:00",
  guest_total_vnd: null, course_total_vnd: null,
}));
const batchRequests = [];
window.DGV.collectSupabasePages = async (build) => {
  const request = build(); batchRequests.push(request);
  return request.table === "golf_booking_groups" ? request.ids.map((id) => ({
    id, label: id, version: "1", completed_at: null, completion_date: null,
  })) : [];
};
await loadAndAttach(manyRows);
assert.deepEqual(batchRequests.map((r) => r.ids.length), [100, 100, 1, 1]);
assert.equal(manyRows[100].booking.version, 1, "safe string database versions normalize to numbers");
assert.equal(manyRows[100].booking.rounds[0], manyRows[100]);

// Static DB boundaries supplement, but do not replace, the rollback integration
// file. This script intentionally performs no DB writes and no remote calls.
for (const table of ["golf_booking_groups", "golf_booking_group_payments"]) {
  assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`, "i"));
}
assert.match(migration, /booking_group_id uuid[^;]*references public\.golf_booking_groups\(id\) on delete restrict/i);
assert.match(migration, /alter column status set expression as[\s\S]*when booking_group_id is not null[\s\S]*group_completed/i);
assert.match(migration, /rename to save_golf_reservation_with_payments_single_impl/i);
assert.match(migration, /revoke all on function private\.save_golf_reservation_with_payments_single_impl\([^;]*from public,anon,authenticated,service_role/i);
assert.match(migration, /golf_booking_round_write_guard before insert or update or delete/i);
assert.match(migration, /golf_booking_legacy_payment_guard before insert or update or delete/i);
assert.match(migration, /p_expected_version is distinct from v_group\.version/);
assert.match(migration, /version=version\+1/);
assert.match(migration, /booking_group_id=p_group_id order by id for update/);
assert.match(migration, /single_impl\(p_round_id,(?:p_reservation|v_save_payload),'\[\]'::jsonb\)/);
assert.match(migration, /v_completion_count=1 and exists\([^;]*course_total_vnd is null/);
assert.match(migration, /sum\(p\.amount_vnd\)[^;]*>9007199254740991/);
assert.match(migration, /v_count=1 and exists\(select 1 from public\.golf_booking_group_payments/);
assert.doesNotMatch(migration, /(?:insert into|update|delete from)\s+public\.golf_course_budget_accounts/i);
assert.match(integration, /^begin;/m);
assert.match(integration, /^rollback;/m);
assert.doesNotMatch(integration, /^commit;/mi);
assert.match(integration, /"pax":7/);
assert.match(integration, /"pax":8/);

console.log("Golf booking groups: shared totals, immutable attachment, independent 7/8-person rounds, filters, unknown pricing, discount/overpayment, loading and static DB guards verified. DB integration file prepared, not executed.");
