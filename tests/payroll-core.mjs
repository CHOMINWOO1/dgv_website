import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const context = { console, Date, Map, Set, Object, Array, Number, String, Boolean, Math, JSON };
context.globalThis = context;
vm.runInNewContext(await readFile(path.join(root, "assets/payroll-core.js"), "utf8"), context);
const core = context.DGV_PAYROLL_CORE;
assert.ok(core?.parseRows && core?.summarizeMonth);
const headers = ["User ID", "Name", "Dept", "IN/OUT Time", "Device ID"];
const row = (at, id = "0007", name = "Synthetic employee", device = 1) => [id, name, "Test", at, device];
const employee = { id: "e1", device_user_id: "0007", name: "Synthetic employee", active: true };
const term = { employee_id: "e1", effective_from: "2026-01-01", pay_type: "monthly", rate: 7000000,
  shift_start: "10:00", shift_end: "20:00", break_start: "13:00", break_end: "15:00" };
const punch = (at, device = "1") => ({ employee_id: "e1", occurred_at: at, device_id: device });
const summarize = (overrides = {}) => core.summarizeMonth({ month: "2026-06", today: "2026-07-01", employees: [employee], terms: [term], records: [], days: [], ...overrides })[0];

// A repeated/overlapping export keeps the same canonical employee/time/device key.
let parsed = core.parseRows([headers, row("2026-06-01 10:00"), row("2026-06-01T10:00:00"), row("2026-06-01 20:00")]);
assert.equal(parsed.records.length, 2);
assert.equal(parsed.duplicates, 1);
assert.equal(parsed.errors.length, 0);
assert.equal(parsed.records[0].device_user_id, "0007", "text IDs retain leading zeros");
assert.equal(parsed.firstDate, "2026-06-01");
assert.equal(parsed.lastDate, "2026-06-01");
assert.equal(core.parseRows([headers, row("2026-06-01 10:00", 7)]).records[0].device_user_id, "7");
assert.equal(core.parseRows([[" device ID ", " IN/OUT   Time ", "DEPT", "NAME", "USER ID"], [1, "2026-06-01 10:00", "T", "Test", "0007"]]).records.length, 1);
assert.equal(core.parseRows([["User ID", "Name", "IN/OUT Time"], [7, "Test", "2026-06-01 10:00"]]).records.length, 0);
assert.equal(core.parseRows([headers, row("2026-06-01 10:00"), row("2026-06-01 11:00", "0007", "Conflicting name")]).errors.length, 1);
assert.equal(core.parseRows(Array.from({ length: 10002 }, () => headers)).errors.length, 1);
assert.equal(core.parseRows([headers, row({ f: "NOW()", v: 1 })]).records.length, 0);
assert.equal(core.parseRows([headers, row("=NOW()")]).records.length, 0);

// Strict calendar validation prevents JavaScript Date rollover and timezone drift.
for (const invalid of ["2026-02-29 10:00", "2026-04-31 10:00", "2026-06-01 24:00", "2026-06-01 10:60", "2026-06-01T10:00:00Z", "06/01/2026 10:00", NaN, Infinity, 60]) assert.equal(core.parseTimestamp(invalid), null, String(invalid));
assert.equal(core.parseTimestamp("2028-02-29 10:00"), "2028-02-29T10:00:00");
assert.equal(core.parseTimestamp(1), "1900-01-01T00:00:00");
assert.equal(core.parseTimestamp(61), "1900-03-01T00:00:00");
assert.equal(core.parseTimestamp(0, { date1904: true }), "1904-01-01T00:00:00");
const excel2026 = (Date.UTC(2026, 5, 1, 10) - Date.UTC(1899, 11, 30)) / 86400000;
assert.equal(core.parseTimestamp(excel2026), "2026-06-01T10:00:00");
assert.equal(core.parseTimestamp(excel2026 - 1462, { date1904: true }), "2026-06-01T10:00:00");

let report = summarize({ records: [punch("2026-06-01T10:00:00"), punch("2026-06-01T20:00:00")] });
assert.equal(report.minutes, 480);
assert.equal(report.workedDays, 1);
assert.equal(report.baseAmount, 7000000);
assert.equal(report.unresolved, 0);
assert.equal(summarize({ records: [punch("2026-06-01T12:00:00"), punch("2026-06-01T20:00:00")] }).minutes, 360, "deduct only actual lunch overlap");
assert.equal(summarize({ records: [punch("2026-06-01T15:00:00"), punch("2026-06-01T20:00:00")] }).minutes, 300, "late shift loses no unworked lunch");
assert.equal(summarize({ records: [punch("2026-06-01T12:00:00"), punch("2026-06-01T14:00:00")] }).minutes, 60);
report = summarize({ records: [punch("2026-06-01T10:20:00"), punch("2026-06-01T19:30:00"), punch("2026-06-02T09:30:00"), punch("2026-06-02T21:00:00")] });
assert.equal(report.lateMinutes, 20);
assert.equal(report.earlyMinutes, 30);
assert.equal(report.extraMinutes, 90);
assert.equal(report.balanceMinutes, 40);
assert.equal(report.baseAmount, 7000000, "internal balance never docks or increases monthly salary");

const hourly = { ...term, pay_type: "hourly", rate: 30000 };
const dailyTerm = { ...term, pay_type: "daily", rate: 250000 };
report = summarize({ terms: [hourly], records: [punch("2026-06-01T15:00:00"), punch("2026-06-01T20:00:00")] });
assert.equal(report.baseAmount, 150000);
assert.equal(summarize({ terms: [dailyTerm], records: [punch("2026-06-01T10:00:00"), punch("2026-06-01T20:00:00")] }).baseAmount, 250000);
report = summarize({ terms: [hourly, { ...hourly, effective_from: "2026-06-02", rate: 60000 }], records: [punch("2026-06-01T15:00:00"), punch("2026-06-01T20:00:00"), punch("2026-06-02T15:00:00"), punch("2026-06-02T20:00:00")] });
assert.equal(report.baseAmount, 450000, "use the pay rate effective on each work date");
assert.equal(summarize({ terms: [term, { ...term, effective_from: "2026-06-15", rate: 8000000 }] }).baseAmount, null);
report = summarize({ terms: [term, { ...term, effective_from: "2026-06-15", rate: 8000000 }] });
assert.equal(report.attendanceUnresolved, 0);
assert.equal(report.compensationUnresolved, 1, "valid monthly rate changes allow explicit reviewed-base resolution");
assert.equal(report.compensationIssues.length, 1);
assert.equal(report.unresolved, report.attendanceUnresolved + report.compensationUnresolved);
assert.ok(summarize({ terms: [{ ...term, effective_from: "2026-06-15" }] }).unresolved > 0);
assert.ok(summarize({ terms: [{ ...term, effective_from: "2026-06-15" }] }).attendanceUnresolved > 0, "missing starting terms cannot be manually waived");
assert.equal(summarize({ terms: [] }).baseAmount, null);
assert.equal(summarize({ terms: [{ ...term, rate: null }] }).baseAmount, null);

for (const times of [["10:00"], ["10:00", "10:04"], ["01:00", "20:00"], ["10:00", "13:00", "20:00"]]) {
  report = summarize({ terms: [hourly], records: times.map((time) => punch("2026-06-01T" + time + ":00")) });
  assert.equal(report.minutes, 0);
  assert.equal(report.baseAmount, null);
  assert.equal(report.unresolved, 1);
}
const schedule = (date, type, extra = {}) => ({ employee_id: "e1", work_date: date, day_type: type, ...extra });
assert.equal(summarize().unresolved, 0, "missing schedule must not imply absence");
assert.equal(summarize({ days: [schedule("2026-06-01", "work")] }).unresolved, 1);
assert.equal(summarize({ today: "2026-06-01", days: [schedule("2026-06-01", "work"), schedule("2026-06-02", "work")] }).unresolved, 0, "today/future shifts are not marked absent");
assert.equal(summarize({ days: [schedule("2026-06-01", "rest")] }).unresolved, 0);
assert.equal(summarize({ terms: [hourly], days: [schedule("2026-06-01", "paid_leave")] }).baseAmount, null, "paid leave hourly entitlement requires review");
report = summarize({ terms: [hourly], days: [schedule("2026-06-01", "paid_leave")] });
assert.equal(report.attendanceUnresolved, 0);
assert.equal(report.compensationUnresolved, 1);
report = summarize({ terms: [hourly], days: [schedule("2026-06-01", "paid_leave")], records: [punch("2026-06-02T10:00:00")] });
assert.equal(report.attendanceUnresolved, 1, "paid-leave resolution must never waive actual missing punches");
assert.equal(report.compensationUnresolved, 1);
assert.equal(report.unresolved, 2);
report = summarize({ terms: [{ ...hourly, effective_from: "2026-06-15" }], days: [schedule("2026-06-01", "paid_leave")] });
assert.ok(report.attendanceUnresolved > 0, "paid leave without effective terms remains blocked");
assert.equal(report.compensationUnresolved, 0);
assert.equal(summarize({ employees: [{ ...employee, active: false }] }).active, false);
assert.equal(summarize().active, true);
assert.equal(summarize({ days: [schedule("2026-06-01", "paid_leave")] }).baseAmount, 7000000);
report = summarize({ days: [schedule("2026-06-01", "rest", { reason: "Scheduled weekly rest" })], records: [punch("2026-06-01T10:00:00"), punch("2026-06-01T20:00:00")] });
assert.equal(report.unresolved, 1, "a schedule note is not acknowledgement of unexpected rest-day work");

// Original records remain immutable; only an explained correction resolves ambiguity.
const raw = [punch("2026-06-01T10:00:00"), punch("2026-06-01T13:00:00"), punch("2026-06-01T20:00:00")];
const before = JSON.stringify(raw);
report = summarize({ records: raw, days: [schedule("2026-06-01", "work", { check_in: "2026-06-01T10:00:00", check_out: "2026-06-01T20:00:00", reason: "Verified staff record" })] });
assert.equal(report.minutes, 480);
assert.equal(report.daily[0].status, "confirmed");
assert.equal(JSON.stringify(raw), before);
assert.equal(summarize({ terms: [hourly], records: raw, days: [schedule("2026-06-01", "work", { check_in: "2026-06-01T10:00:00", check_out: "2026-06-01T20:00:00" })] }).baseAmount, null);

// Two records on adjacent daytime dates must never become an invented overnight shift.
report = summarize({ records: [punch("2026-06-01T20:47:00"), punch("2026-06-02T09:03:00")] });
assert.equal(report.unresolved, 2);
assert.equal(report.minutes, 0);
const overnightRaw = [punch("2026-06-01T19:00:00"), punch("2026-06-02T01:00:00")];
report = summarize({ terms: [{ ...hourly, shift_start: "19:00", shift_end: "01:00", break_start: "00:00", break_end: "00:00" }], records: overnightRaw });
assert.equal(report.daily.length, 1);
assert.equal(report.minutes, 360);
assert.equal(report.baseAmount, 180000);
report = summarize({ terms: [hourly], records: overnightRaw, days: [schedule("2026-06-01", "work", { check_in: "2026-06-01T19:00:00", check_out: "2026-06-02T01:00:00", reason: "Verified overnight shift" })] });
assert.equal(report.daily.length, 1, "manual overnight correction consumes next-day original punch exactly once");
assert.equal(report.minutes, 360);
assert.equal(report.unresolved, 0);
report = summarize({ terms: [hourly], records: overnightRaw, days: [schedule("2026-06-01", "work", { check_in: "2026-06-01T19:00:00", check_out: "2026-06-02T02:00:00", reason: "A" }), schedule("2026-06-02", "work", { check_in: "2026-06-02T01:00:00", check_out: "2026-06-02T05:00:00", reason: "B" })] });
assert.equal(report.baseAmount, null, "overlapping manual shifts cannot double count wages");
assert.equal(report.minutes, 0);
assert.ok(report.unresolved >= 2);
report = summarize({ terms: [{ ...hourly, shift_start: "19:00", shift_end: "01:00", break_start: "00:00", break_end: "00:00" }], records: [punch("2026-06-30T19:00:00"), punch("2026-07-01T01:00:00")] });
assert.equal(report.minutes, 360, "month-end overnight shift belongs to its start date");
report = summarize({ records: [punch("2026-06-01T10:00:00"), punch("2026-06-01 10:00:00"), punch("2026-06-01T20:00:00")] });
assert.equal(report.minutes, 480);
assert.equal(report.daily[0].rawCount, 2);
assert.equal(core.minutesLabel(-65), "−1h 05m");
assert.throws(() => core.summarizeMonth({ month: "2026-13" }));

// Optional private fixture verification. Real employees/data are never committed.
// node tests/payroll-core.mjs <source-records.json> <expected.json>
if (process.argv[2] && process.argv[3]) {
  const samples = JSON.parse(await readFile(process.argv[2], "utf8"));
  const expected = JSON.parse(await readFile(process.argv[3], "utf8"));
  parsed = core.parseRows([headers, ...samples.map((r) => [r.id, r.name, r.dept, r.at, r.device])]);
  assert.equal(parsed.records.length, samples.length);
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.duplicates, 0);
  for (const [key, want] of Object.entries(expected)) {
    const [deviceId, month] = key.split("|");
    const actual = core.summarizeMonth({ month, today: "2026-11-01", employees: [{ ...employee, device_user_id: deviceId }], terms: [term], records: parsed.records.filter((r) => r.device_user_id === deviceId).map((r) => ({ ...r, employee_id: "e1" })) })[0];
    assert.equal(actual.minutes, want.workMinutes, key);
    assert.equal(actual.workedDays, want.completeDays, key);
    assert.equal(actual.unresolved, want.singleDays, key);
    assert.equal(actual.daily.reduce((total, day) => total + day.rawCount, 0), want.punches, key);
  }
  console.log("Private workbook fixture reconciled with independent monthly totals.");
}
console.log("Payroll parser, work-time, effective pay, exception, leave and overnight tests passed.");
