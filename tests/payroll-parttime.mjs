import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const context = { console };
context.globalThis = context;
for (const file of ["payroll-core.js", "payroll-rules.js"]) {
  vm.runInNewContext(await readFile(path.join(root, "assets", file), "utf8"), context);
}
const core = context.DGV_PAYROLL_CORE, rules = context.DGV_PAYROLL_RULES;
const employee = { id: "parttime-test", device_user_id: "synthetic-parttime", name: "Synthetic part-time employee", employment_type: "part_time", active: true };
const term = { employee_id: employee.id, effective_from: "2026-01-01", pay_type: "hourly", rate: 40000,
  shift_start: "10:00", shift_end: "20:00", break_start: "12:00", break_end: "14:00" };
const date = "2026-06-01";
const punch = (at, type, device = "synthetic-kiosk") => ({ employee_id: employee.id, occurred_at: at, punch_type: type, device_id: device, source: type ? "kiosk" : "excel" });
const pair = (from, to, workDate = date, outDate = workDate) => [punch(`${workDate}T${from}`, "in"), punch(`${outDate}T${to}`, "out")];
const day = (more = {}) => ({ employee_id: employee.id, work_date: date, day_type: "work", ...more });
const input = (more = {}) => ({ month: "2026-06", today: "2026-07-01", employees: [employee], terms: [term], records: [], days: [], rules: [], ...more });
const calculate = (more = {}) => rules.extendSummaries(input(more))[0];
const attendance = (more = {}) => core.summarizeMonth(input(more))[0];
const plain = (value) => JSON.parse(JSON.stringify(value));

// A short shift is paid at the ordinary hourly rate, including its lunchtime.
let report = calculate({ days: [day({ check_in: `${date}T08:00:00`, check_out: `${date}T13:30:00`, reason: "Synthetic attendance correction" })] });
assert.equal(report.settlementMode, "hourly_actual");
assert.equal(report.minutes, 330);
assert.equal(report.actualSeconds, 19800);
assert.equal(report.baseAmount, 220000);
assert.equal(report.statutoryAmount, 0);
assert.equal(report.monthlyExtraAmount, 0);
assert.equal(report.unresolved, 0, "starting before the full-time shift must not require overtime approval");
assert.equal(report.daily[0].workIntervals.length, 1);
assert.equal(report.daily[0].netWorkIntervals.length, 1);
assert.equal(report.daily[0].netWorkIntervals[0].end, `${date}T13:30:00`);
assert.equal(report.wageBreakdown.reduce((sum, item) => sum + item.amount, 0), 220000);

report = calculate({ records: pair("12:15:00", "13:45:00") });
assert.equal(report.minutes, 90, "part-time work entirely during the saved lunch break still counts");
assert.equal(report.baseAmount, 60000);
assert.equal(report.unresolved, 0);
report = calculate({ records: pair("18:00:00", "19:00:00") });
assert.equal(report.baseAmount, 40000, "one hour is paid even though it is below a daily or monthly quota");
assert.equal(report.unresolved, 0);
report = calculate({ records: pair("08:00:00", "13:30:00"), days: [day({ day_type: "rest" })] });
assert.equal(report.minutes, 330);
assert.equal(report.baseAmount, 220000);
assert.equal(report.unresolved, 0, "a saved rest-day label must not block the actual-hours part-time pay path");

// Previously configured premium rules must not pay the same part-time hours twice.
const premiumRule = { ...rules.DEFAULTS, id: "synthetic-rule", effective_from: "2026-01-01", ot_enabled: true };
report = calculate({ records: pair("08:00:00", "13:30:00"), rules: [premiumRule], days: [day({ overtime_approved: true,
  approval_reason: "Synthetic former approval", overtime_intervals: [{ start: `${date}T08:00:00`, end: `${date}T10:00:00` }] })] });
assert.equal(report.baseAmount, 220000);
assert.equal(report.statutoryAmount, 0);
assert.equal(report.unresolved, 0);

// Add completed pairs only, exclude gaps, then floor the day's accumulated seconds once.
report = calculate({ records: [...pair("08:00:00", "10:00:00"), ...pair("12:30:00", "14:00:00")] });
assert.equal(report.minutes, 210);
assert.equal(report.baseAmount, 140000);
assert.equal(report.daily[0].workIntervals.length, 2);
const secondsRecords = [...pair("08:00:00", "08:00:40"), ...pair("12:00:00", "12:00:40")];
report = calculate({ records: secondsRecords });
assert.equal(report.actualSeconds, 80);
assert.equal(report.minutes, 1);
assert.equal(report.baseAmount, 667, "one total minute is paid, rounded once to whole VND");
report = calculate({ records: pair("08:00:00", "08:00:59") });
assert.equal(report.actualSeconds, 59);
assert.equal(report.minutes, 0);
assert.equal(report.baseAmount, 0, "a sub-minute pair must not round up into a whole payable minute");
assert.equal(report.unresolved, 0);
report = calculate({ records: [...pair("08:00:00", "08:00:40"), ...pair("08:00:00", "08:00:40", "2026-06-02")] });
assert.equal(report.actualSeconds, 80);
assert.equal(report.minutes, 0, "hourly minute precision uses the same daily flooring as core attendance");
assert.equal(report.baseAmount, 0);
report = calculate({ records: [...pair("08:00:00", "08:01:00"), ...pair("08:00:00", "08:01:00", "2026-06-02")] });
assert.equal(report.minutes, 2);
assert.equal(report.baseAmount, 1333, "round VND only after summing minute-rate amounts for the month");
assert.equal(report.wageBreakdown.reduce((sum, item) => sum + item.amount, 0), 1333, "exported detail lines reconcile to the rounded total");

// Unfinished or contradictory records preserve proven time but cannot finalize an amount.
report = calculate({ today: date, records: [...pair("08:00:00", "10:00:00"), punch(`${date}T12:30:00`, "in")] });
assert.equal(report.minutes, 120);
assert.equal(report.daily[0].attendanceStatus, "in_progress");
assert.equal(report.daily[0].openCheckIn, `${date}T12:30:00`);
assert.equal(report.baseAmount, null);
assert.ok(report.unresolved > 0);
report = calculate({ records: [...pair("08:00:00", "10:00:00"), punch(`${date}T12:30:00`, "in")] });
assert.equal(report.minutes, 120);
assert.equal(report.daily[0].attendanceStatus, "missing");
assert.equal(report.baseAmount, null);
report = calculate({ records: [...pair("08:00:00", "10:00:00"), punch(`${date}T12:30:00`, "in"), ...pair("13:00:00", "14:00:00")] });
assert.equal(report.minutes, 120);
assert.equal(report.daily[0].attendanceStatus, "ambiguous");
assert.equal(report.baseAmount, null);
report = calculate({ records: [punch(`${date}T13:30:00`, "out")] });
assert.equal(report.minutes, 0);
assert.equal(report.baseAmount, null);

// Exact retries and an exact Excel copy add no duplicate duration and mutate no input.
const original = pair("08:00:00", "13:30:00");
const duplicates = [...original, ...original.map((record) => ({ ...record, device_id: "second-kiosk" })),
  ...original.map((record) => ({ ...record, punch_type: null, source: "excel", device_id: "legacy-device" }))];
const before = JSON.stringify(duplicates);
report = calculate({ records: duplicates });
assert.equal(report.minutes, 330);
assert.equal(report.baseAmount, 220000);
assert.equal(report.unresolved, 0);
assert.equal(JSON.stringify(duplicates), before);
report = calculate({ records: [...original, punch(`${date}T08:00:01`, null)] });
assert.equal(report.minutes, 330);
assert.equal(report.daily[0].attendanceStatus, "ambiguous");
assert.equal(report.baseAmount, null);

// The ordinary rate follows each work date; the premium-rate field is never a fallback.
const changedRate = { ...term, effective_from: "2026-06-02", rate: 50000 };
report = calculate({ terms: [changedRate, term], records: [...pair("08:00:00", "09:00:00"), ...pair("08:00:00", "09:30:00", "2026-06-02")] });
assert.equal(report.minutes, 150);
assert.equal(report.baseAmount, 115000);
assert.equal(report.unresolved, 0);
report = calculate({ terms: [{ ...term, rate: 0, overtime_hourly_rate: 40000 }], records: original });
assert.equal(report.baseAmount, null, "an unset ordinary hourly rate requires review; the premium rate is not a fallback");
assert.ok(report.unresolved > 0);
for (const terms of [[], [{ ...term, rate: null }], [{ ...term, effective_from: "2026-06-02" }]]) {
  report = calculate({ terms, records: original });
  assert.equal(report.minutes, 330, "missing salary conditions must not invent a part-time lunch deduction");
  assert.equal(report.actualSeconds, 19800);
  assert.equal(report.baseAmount, null);
  assert.ok(report.unresolved > 0);
}

// Explicit overnight pairs retain core's work-date/month attribution and count once.
const overnight = pair("23:00:00", "01:00:00", "2026-06-30", "2026-07-01");
report = calculate({ records: overnight });
assert.equal(report.minutes, 120);
assert.equal(report.baseAmount, 80000);
assert.equal(report.unresolved, 0);
assert.equal(report.daily[0].date, "2026-06-30");
report = calculate({ month: "2026-07", today: "2026-08-01", records: overnight });
assert.equal(report.minutes, 0);
assert.equal(report.baseAmount, 0);
report = calculate({ records: pair("13:00:00", "13:00:00", date, "2026-06-02") });
assert.equal(report.minutes, 1440, "an exactly 24-hour valid pair has no part-time lunch deduction on either day");
assert.equal(report.baseAmount, 960000);
report = calculate({ records: [...pair("08:00:00", "10:00:00"), ...pair("12:00:00", "12:00:01", date, "2026-06-02")] });
assert.equal(report.minutes, 120, "a greater-than-24-hour ambiguous pair cannot erase a separate completed pair");
assert.equal(report.baseAmount, null);

// No actual work remains zero; planned dates do not create a minimum-hours hurdle.
report = calculate({ days: [day(), day({ work_date: "2026-06-02" })] });
assert.equal(report.minutes, 0);
assert.equal(report.baseAmount, 0);
assert.equal(report.unresolved, 0);
report = calculate({ employees: [{ ...employee, hire_date: "2026-06-02" }], records: original });
assert.equal(report.minutes, 330);
assert.equal(report.baseAmount, null, "work outside employment dates still requires review");

// Employment type controls lunch policy; pay type alone must not change full-time staff.
for (const pay_type of ["hourly", "daily", "monthly"]) {
  report = attendance({ terms: [{ ...term, pay_type, rate: pay_type === "monthly" ? 7000000 : 40000 }], records: original });
  assert.equal(report.minutes, 330, `part-time ${pay_type} attendance excludes no automatic lunch`);
}
const fullTime = { ...employee, employment_type: "full_time" };
report = calculate({ employees: [fullTime], records: pair("10:00:00", "13:30:00") });
assert.equal(report.minutes, 120);
assert.equal(report.baseAmount, 80000);
assert.equal(report.settlementMode, "statutory");
assert.equal(report.unresolved, 0);
const monthly = { ...term, pay_type: "monthly", monthly_settlement: "monthly_net", weekly_rest_day: 0, rate: 7000000 };
report = calculate({ employees: [fullTime], terms: [monthly], records: pair("10:00:00", "13:30:00") });
assert.equal(report.minutes, 120);
assert.equal(report.monthlyActualMinutes, 120);
assert.equal(report.baseAmount, 7000000);
assert.equal(report.monthlyExtraAmount, 0);
assert.equal(report.settlementMode, "monthly_net");
assert.equal(report.unresolved, 0);
assert.deepEqual(plain(original), plain(pair("08:00:00", "13:30:00")), "calculations leave raw records unchanged");

console.log("Part-time payroll passed: no automatic lunch, actual hourly wages, partial shifts, minute precision, effective rates, open/ambiguous safety, dedupe, overnight boundaries and full-time regression.");
