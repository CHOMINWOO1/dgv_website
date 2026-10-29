import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ctx = { console, Date, Map, Set, Object, Array, Number, String, Boolean, Math, JSON };
ctx.globalThis = ctx;
for (const file of ["payroll-core.js", "payroll-rules.js"]) vm.runInNewContext(await readFile(path.join(root, "assets", file), "utf8"), ctx);
const rules = ctx.DGV_PAYROLL_RULES, core = ctx.DGV_PAYROLL_CORE;
const employee = { id: "employee-test", device_user_id: "test-1", name: "Synthetic employee", active: true };
const term = { employee_id: employee.id, effective_from: "2026-01-01", pay_type: "hourly", rate: 30000,
  shift_start: "10:00", shift_end: "20:00", break_start: "13:00", break_end: "15:00" };
const rule = { ...rules.DEFAULTS, id: "rule-v1", version: 1, effective_from: "2026-01-01", ot_enabled: true };
const stamp = (date, time) => date + "T" + time + (time.length === 5 ? ":00" : "");
const interval = (date, start, end, endDate = date) => ({ start: stamp(date, start), end: stamp(endDate, end) });
const punches = (date, a, b, endDate = date) => [{ employee_id: employee.id, device_id: "1", occurred_at: stamp(date, a) }, { employee_id: employee.id, device_id: "1", occurred_at: stamp(endDate, b) }];
const day = (date, type = "work", more = {}) => ({ employee_id: employee.id, work_date: date, day_type: type, reason: "Test schedule", ...more });
const approve = (date, ot = [], night = [], more = {}) => day(date, more.day_type || "work", { overtime_intervals: ot, night_intervals: night, overtime_approved: true, night_approved: true, approval_reason: "Verified work and employee consent", ...more });
const calc = (more = {}) => rules.extendSummaries({ month: "2026-06", employees: [employee], terms: [term], records: [], days: [], rules: [rule], today: "2026-07-01", yearToDateRuns: [], ...more })[0];
const amount = (row, code) => row.wageBreakdown.filter((item) => item.code === code).reduce((sum, item) => sum + item.amount, 0);
const plain = (value) => JSON.parse(JSON.stringify(value));
const date = "2026-06-01";

let report = calc({ records: punches(date, "10:00", "20:00") });
assert.equal(report.baseAmount, 240000);
assert.equal(report.statutoryAmount, 0);
assert.equal(report.unresolved, 0);

// Hourly pay removes the straight-time overtime component before adding full OT.
const otOne = [interval(date, "20:00", "21:00")];
report = calc({ records: punches(date, "10:00", "21:00"), days: [approve(date, otOne)] });
assert.equal(report.minutes, 540);
assert.equal(report.baseAmount, 240000);
assert.equal(report.statutoryAmount, 45000);
assert.equal(report.regularOvertimeMinutes, 60);
assert.equal(report.unresolved, 0);
assert.deepEqual(plain(report.daily[0].overtimeCandidates), otOne);
assert.equal(amount(report, "ordinary_overtime"), 45000);
assert.equal(report.baseAmount + report.statutoryAmount, 285000, "never add a full 150% to an already included 100%");
for (const pay_type of ["monthly", "daily"]) {
  report = calc({ terms: [{ ...term, pay_type, rate: pay_type === "monthly" ? 7000000 : 240000, overtime_hourly_rate: 30000 }], records: punches(date, "10:00", "21:00"), days: [approve(date, otOne)] });
  assert.equal(report.baseAmount, pay_type === "monthly" ? 7000000 : 240000);
  assert.equal(report.statutoryAmount, 45000);
  assert.equal(report.unresolved, 0);
}
report = calc({ records: punches(date, "10:00", "21:00"), days: [day(date)] });
assert.equal(report.minutes, 540, "pending legal approval must not erase actual work");
assert.ok(report.ruleUnresolved > 0);
assert.equal(report.attendanceUnresolved, report.ruleUnresolved);
assert.equal(report.statutoryAmount, 0);
report = calc({ rules: [{ ...rule, ot_enabled: false }], records: punches(date, "10:00", "21:00"), days: [approve(date, otOne)] });
assert.ok(report.ruleUnresolved > 0, "inactive rule requires explicit configuration");
assert.equal(report.minutes, 540);
report = calc({ rules: [], records: punches(date, "10:00", "21:00") });
assert.ok(report.ruleUnresolved > 0);
assert.equal(report.daily[0].overtimeCandidates.length, 1);
for (const ot of [
  [interval(date, "20:00", "21:30")],
  [interval(date, "20:00", "20:30")],
  [interval(date, "20:00", "21:00"), interval(date, "20:30", "21:00")],
  [interval(date, "13:00", "14:00")],
]) assert.ok(calc({ records: punches(date, "10:00", "21:00"), days: [approve(date, ot)] }).ruleUnresolved > 0, "approval must be complete, inside work, outside breaks, and nonoverlapping");
assert.ok(calc({ records: punches(date, "10:00", "21:00"), days: [approve(date, otOne, [], { approval_reason: "" })] }).ruleUnresolved > 0);

// Rest/holiday work is paid separately from paid holiday entitlement.
const fullWork = [interval(date, "10:00", "13:00"), interval(date, "15:00", "20:00")];
report = calc({ records: punches(date, "10:00", "20:00"), days: [approve(date, fullWork, [], { day_type: "rest" })] });
assert.equal(report.baseAmount, 0);
assert.equal(report.statutoryAmount, 480000);
assert.equal(report.restWorkMinutes, 480);
assert.equal(report.restDays, 1);
assert.equal(report.unresolved, 0);
for (const pay_type of ["hourly", "daily"]) {
  report = calc({ terms: [{ ...term, pay_type, rate: pay_type === "daily" ? 240000 : 30000 }], records: punches(date, "10:00", "20:00"), days: [approve(date, fullWork, [], { day_type: "holiday" })] });
  assert.equal(report.baseAmount, 240000, "paid holiday base is distinct from holiday work");
  assert.equal(report.statutoryAmount, 720000);
  assert.equal(report.holidayWorkMinutes, 480);
  assert.equal(report.holidayDays, 1);
  assert.equal(report.unresolved, 0);
}
report = calc({ days: [day(date, "paid_leave")] });
assert.equal(report.baseAmount, 240000);
assert.equal(report.paidLeaveDays, 1);
assert.equal(report.compensationUnresolved, 0, "scheduled paid leave has a computable contractual base");
assert.equal(report.unresolved, 0);
report = calc({ days: [day(date, "unpaid_leave")] });
assert.equal(report.baseAmount, 0);
assert.equal(report.unpaidLeaveDays, 1);
assert.equal(report.plannedMinutes, 480);

// Ordinary night work: 30% extra. Night OT: full OT +30% +20% of day rate.
const nightTerm = { ...term, shift_start: "22:00", shift_end: "06:00", break_start: "00:00", break_end: "00:00" };
const nightSpan = [interval(date, "22:00", "06:00", "2026-06-02")];
report = calc({ terms: [nightTerm], records: punches(date, "22:00", "06:00", "2026-06-02"), days: [approve(date, [], nightSpan)] });
assert.equal(report.baseAmount, 240000);
assert.equal(report.statutoryAmount, 72000);
assert.equal(report.nightMinutes, 480);
assert.equal(report.nightOvertimeMinutes, 0);
assert.equal(report.unresolved, 0);
for (const [type, premium, paidBase] of [["rest", 648000, 0], ["holiday", 936000, 240000]]) {
  report = calc({ terms: [nightTerm], records: punches(date, "22:00", "06:00", "2026-06-02"), days: [approve(date, nightSpan, nightSpan, { day_type: type })] });
  assert.equal(report.baseAmount, paidBase);
  assert.equal(report.statutoryAmount, premium);
  assert.equal(report.nightOvertimeMinutes, 480);
  assert.equal(report.unresolved, 0);
}
const shortNight = [interval(date, "22:00", "00:00", "2026-06-02")];
report = calc({ terms: [{ ...term, shift_start: "14:00", shift_end: "22:00", break_start: "18:00", break_end: "19:00" }],
  records: punches(date, "14:00", "00:00", "2026-06-02"),
  days: [approve(date, shortNight, shortNight, { check_in: stamp(date, "14:00"), check_out: stamp("2026-06-02", "00:00") })] });
assert.equal(report.baseAmount, 210000);
assert.equal(report.statutoryAmount, 120000, "night-only OT uses20% of 100% day rate");
assert.equal(amount(report, "night_overtime_extra"), 12000);
report = calc({ records: punches(date, "10:00", "00:00", "2026-06-02"),
  days: [approve(date, [interval(date, "20:00", "00:00", "2026-06-02")], shortNight, { check_in: stamp(date, "10:00"), check_out: stamp("2026-06-02", "00:00") })] });
assert.equal(report.baseAmount, 240000);
assert.equal(report.statutoryAmount, 216000, "prior daytime OT uses20% of150% day rate for night OT");
assert.equal(amount(report, "night_overtime_extra"), 18000);

// Midnight uses the actual calendar day's explicit holiday and effective rates.
report = calc({ terms: [nightTerm], records: punches(date, "22:00", "06:00", "2026-06-02"),
  days: [approve(date, [interval("2026-06-02", "00:00", "06:00")], nightSpan), day("2026-06-02", "holiday")] });
assert.equal(report.baseAmount, 300000, "2 normal hours plus the next day's 8-hour paid holiday entitlement");
assert.equal(report.statutoryAmount, 720000, "6 holiday work hours plus night components on their calendar day");
assert.equal(report.holidayWorkMinutes, 360);
assert.equal(report.regularOvertimeMinutes, 0);
assert.equal(report.unresolved, 0);
assert.deepEqual(plain(report.daily[0].overtimeCandidates), [interval("2026-06-02", "00:00", "06:00")]);
report = calc({ terms: [nightTerm, { ...nightTerm, effective_from: "2026-06-02", rate: 60000 }],
  records: punches(date, "22:00", "06:00", "2026-06-02"), days: [approve(date, [], nightSpan)] });
assert.equal(report.baseAmount, 420000);
assert.equal(report.statutoryAmount, 126000);
assert.equal(report.unresolved, 0);
report = calc({ terms: [nightTerm], records: punches(date, "22:00", "06:00", "2026-06-02"), days: [approve(date, [], nightSpan)],
  rules: [rule, { ...rule, id: "rule-midnight", version: 2, effective_from: "2026-06-02", night_premium_rate: 0.5 }] });
assert.equal(report.statutoryAmount, 108000);
assert.deepEqual(plain(report.ruleVersionIds).sort(), ["rule-midnight", "rule-v1"]);
assert.equal(report.unresolved, 0);
report = calc({ terms: [nightTerm, { ...nightTerm, effective_from: "2026-06-02", rate: "invalid" }],
  records: punches(date, "22:00", "06:00", "2026-06-02"), days: [approve(date, [], nightSpan)] });
assert.ok(report.unresolved > 0, "bad effective terms cannot pass through a midnight component");
assert.ok(report.baseAmount === null || Number.isFinite(report.baseAmount));

// Versions and effective employee rates apply on their work date.
const second = "2026-06-16";
report = calc({ records: [...punches(date, "10:00", "21:00"), ...punches(second, "10:00", "21:00")],
  days: [approve(date, otOne), approve(second, [interval(second, "20:00", "21:00")])],
  rules: [rule, { ...rule, id: "rule-v2", version: 2, effective_from: "2026-06-15", regular_overtime_multiplier: 2 }] });
assert.equal(report.statutoryAmount, 105000);
assert.deepEqual(plain(report.ruleVersionIds).sort(), ["rule-v1", "rule-v2"]);
report = calc({ records: [...punches(date, "10:00", "21:00"), ...punches(second, "10:00", "21:00")],
  days: [approve(date, otOne), approve(second, [interval(second, "20:00", "21:00")])],
  terms: [term, { ...term, effective_from: "2026-06-15", rate: 60000 }] });
assert.equal(report.baseAmount, 720000);
assert.equal(report.statutoryAmount, 135000);
assert.ok(rules.validateRule({ ...rule, regular_overtime_multiplier: 1.49 }).length > 0);
assert.ok(rules.validateRule({ ...rule, night_start: "23:00" }).length > 0);
assert.ok(rules.validateRule({ ...rule, monthly_hour_basis: "contract", monthly_contract_hours: null }).length > 0);
assert.equal(rules.validateRule(rule).length, 0);

// Calendar generation keeps explicit leave/holiday/corrections, including zero data.
const existing = day("2026-06-07", "holiday", { reason: "Existing holiday override" });
let generated = rules.createMonthSchedule({ month: "2026-06", employee, terms: [term], weeklyRestDays: [0], existingDays: [existing] });
assert.equal(generated.length, 30);
assert.equal(generated.filter((value) => value.day_type === "rest").length, 3);
assert.deepEqual(plain(generated.find((value) => value.work_date === existing.work_date)), existing);
const partialEmployee = { ...employee, hire_date: "2026-06-15", termination_date: "2026-06-25" };
generated = rules.createMonthSchedule({ month: "2026-06", employee: partialEmployee, weeklyRestDays: [0] });
assert.equal(generated.length, 11);
assert.equal(generated[0].work_date, "2026-06-15");
assert.equal(generated.at(-1).work_date, "2026-06-25");
assert.throws(() => rules.createMonthSchedule({ month: "2026-06", employee, weeklyRestDays: [7] }));

// Scheduled monthly proration uses real month hours, with no fixed26/208.
const monthly = { ...term, pay_type: "monthly", rate: 7000000 };
const schedule = rules.createMonthSchedule({ month: "2026-06", employee, weeklyRestDays: [0] });
const withLeave = schedule.map((value) => value.work_date === "2026-06-01" ? { ...value, day_type: "unpaid_leave" } :
  value.work_date === "2026-06-02" ? { ...value, day_type: "paid_leave" } : value.work_date === "2026-06-03" ? { ...value, day_type: "holiday" } : value);
report = calc({ terms: [monthly], days: withLeave, today: "2026-06-01", rules: [{ ...rule, monthly_proration: "scheduled" }] });
assert.equal(report.plannedMinutes, 26 * 480);
assert.equal(report.paidScheduledMinutes, 25 * 480);
assert.equal(report.baseAmount, Math.round(7000000 * 25 / 26));
assert.equal(report.paidLeaveDays, 1);
assert.equal(report.unpaidLeaveDays, 1);
assert.equal(report.holidayDays, 1);
assert.equal(report.unresolved, 0);
report = calc({ terms: [monthly], days: withLeave, today: "2026-06-01" });
assert.equal(report.baseAmount, 7000000, "no proration option never silently docks unpaid time");
report = calc({ terms: [monthly], days: schedule, today: "2026-06-01",
  rules: [{ ...rule, monthly_proration: "scheduled", monthly_hour_basis: "contract", monthly_contract_hours: 200 }] });
assert.equal(report.baseAmount, 7000000, "a full actual month schedule earns the full salary even when OT contractual-hour basis differs");
assert.equal(report.wageBreakdown.reduce((total, row) => total + row.amount, 0), report.baseAmount);
assert.ok(report.wageBreakdown.every((row) => Number.isInteger(row.amount)), "VND export lines are whole amounts with explicit rounding reconciliation");
report = calc({ terms: [monthly, { ...monthly, effective_from: "2026-06-16", rate: 8000000 }], days: schedule, today: "2026-06-01",
  rules: [{ ...rule, monthly_proration: "scheduled" }] });
assert.equal(report.baseAmount, 7500000);
assert.equal(report.compensationUnresolved, 0, "complete effective schedule calculation resolves a monthly rate change");
assert.equal(report.unresolved, 0);
const hire = { ...employee, hire_date: "2026-06-15" };
const hireSchedule = rules.createMonthSchedule({ month: "2026-06", employee: hire, weeklyRestDays: [0] });
report = calc({ employees: [hire], terms: [{ ...monthly, effective_from: "2026-06-15" }], days: hireSchedule, today: "2026-06-01",
  rules: [{ ...rule, monthly_proration: "scheduled", monthly_hour_basis: "contract", monthly_contract_hours: 208 }] });
assert.equal(report.baseAmount, Math.round(7000000 * 14 * 8 / 208));
assert.equal(report.unresolved, 0, "valid hiring-date terms do not require prehire employment terms");
report = calc({ employees: [hire], terms: [{ ...monthly, effective_from: "2026-06-15" }], days: hireSchedule, today: "2026-06-01",
  rules: [{ ...rule, monthly_proration: "scheduled" }] });
assert.ok(report.ruleUnresolved > 0, "partial monthly schedule cannot invent a divisor");
assert.equal(report.baseAmount, null);
report = calc({ employees: [{ ...employee, hire_date: "2026-07-01" }], terms: [monthly] });
assert.equal(report.baseAmount, 0);
report = calc({ employees: [{ ...employee, hire_date: "2026-06-15" }], terms: [term], records: punches(date, "10:00", "20:00") });
assert.ok(report.attendanceUnresolved > 0, "outside employment punches require review");

// Cross-month monthly night pay needs a known next-month hourly basis.
const lastDate = "2026-06-30", nextDate = "2026-07-01";
const monthEndNight = [interval(lastDate, "22:00", "06:00", nextDate)];
const monthlyNight = { ...nightTerm, pay_type: "monthly", rate: 7000000 };
const monthEndDays = schedule.map((value) => value.work_date === lastDate ? approve(lastDate, [], monthEndNight) : value);
report = calc({ terms: [monthlyNight], days: monthEndDays, records: punches(lastDate, "22:00", "06:00", nextDate), today: "2026-07-01" });
assert.ok(report.ruleUnresolved > 0, "June schedule cannot silently become July's hourly divisor");
report = calc({ terms: [{ ...monthlyNight, overtime_hourly_rate: 30000 }], days: monthEndDays,
  records: punches(lastDate, "22:00", "06:00", nextDate), today: "2026-07-01" });
assert.equal(report.unresolved, 0);
assert.equal(report.statutoryAmount, 72000);
assert.equal(report.minutes, 480, "cross-month check-out is paid once on its original shift");
assert.equal(report.annualCoverageComplete, false);
assert.ok(report.warnings.some((text) => text.includes("월 경계")));
const nextReport = rules.extendSummaries({ month: "2026-07", employees: [employee], terms: [{ ...monthlyNight, overtime_hourly_rate: 30000 }],
  days: monthEndDays, records: punches(lastDate, "22:00", "06:00", nextDate), rules: [rule], today: "2026-06-01" })[0];
assert.equal(nextReport.minutes, 0);
assert.equal(nextReport.statutoryAmount, 0);
report = calc({ employees: [{ ...employee, termination_date: date }], terms: [nightTerm],
  records: punches(date, "22:00", "06:00", "2026-06-02"), days: [approve(date, [], nightSpan)] });
assert.ok(report.ruleUnresolved > 0, "overnight work after the inclusive termination date needs review");

// Invalid and zero-hour wage bases are review blockers, never NaN or free OT.
for (const basis of ["broken", -1, 0]) {
  report = calc({ terms: [{ ...term, overtime_hourly_rate: basis }], records: punches(date, "10:00", "21:00"), days: [approve(date, otOne)] });
  assert.ok(report.ruleUnresolved > 0);
  assert.equal(report.statutoryAmount, 0);
}
report = calc({ terms: [{ ...term, break_start: "10:00", break_end: "20:00" }], records: punches(date, "10:00", "20:00"), days: [day(date)] });
assert.ok(report.ruleUnresolved > 0);
assert.ok(Number.isFinite(report.statutoryAmount));

// Fractional components reconcile exactly after monthly VND rounding.
report = calc({ terms: [{ ...term, rate: 10001 }], records: [...punches(date, "10:00", "20:01"), ...punches("2026-06-02", "10:00", "20:01")],
  days: [approve(date, [interval(date, "20:00", "20:01")]), approve("2026-06-02", [interval("2026-06-02", "20:00", "20:01")])] });
assert.equal(report.statutoryAmount, 500);
assert.equal(report.wageBreakdown.filter((row) => row.category === "statutory").reduce((sum, row) => sum + row.amount, 0), report.statutoryAmount);
assert.equal(report.wageBreakdown.filter((row) => row.category === "base").reduce((sum, row) => sum + row.amount, 0), report.baseAmount);
assert.equal(report.unresolved, 0);

// Year/month limits warn about worked wages; do not erase earned money.
report = calc({ records: punches(date, "10:00", "21:00"), days: [approve(date, otOne)],
  yearToDateRuns: [{ employee_id: employee.id, month: "2026-05-01", snapshot: { regularOvertimeMinutes: 200 * 60, restWorkMinutes: 0, holidayWorkMinutes: 0 } }] });
assert.ok(report.warnings.some((value) => value.includes("연 누적")));
assert.equal(report.statutoryAmount, 45000);
assert.equal(report.yearToDateOvertimeMinutes, 201 * 60);
report = calc({ records: punches(date, "10:00", "21:00"), days: [approve(date, otOne)], yearToDateRuns: [] });
assert.equal(report.annualCoverageComplete, false, "an empty response does not verify all earlier months");
report = calc({ employees: [{ ...employee, hire_date: date }], records: punches(date, "10:00", "21:00"), days: [approve(date, otOne)], yearToDateRuns: [] });
assert.equal(report.annualCoverageComplete, true, "no earlier payroll is required before a known hiring date");
report = calc({ records: punches(date, "10:00", "21:00"), days: [approve(date, otOne)], yearToDateRuns: [1, 2, 3, 4, 5].map((value) => ({
  employee_id: employee.id, month: "2026-" + String(value).padStart(2, "0") + "-01", snapshot: { regularOvertimeMinutes: 0, restWorkMinutes: 0, holidayWorkMinutes: 0 },
})) });
assert.equal(report.annualCoverageComplete, true);
assert.equal(report.yearToDateOvertimeMinutes, 60);
report = calc({ records: punches(date, "10:00", "21:00"), days: [approve(date, otOne)], yearToDateRuns: undefined });
assert.equal(report.annualCoverageComplete, false);
assert.ok(report.warnings.some((value) => value.includes("이전 월")));
assert.equal(report.statutoryAmount, 45000);

// No accidental mutation of approved source or original calculation snapshots.
const inputDays = [approve(date, otOne)], inputRecords = punches(date, "10:00", "21:00");
const originals = JSON.stringify({ inputDays, inputRecords });
const baseline = core.summarizeMonth({ month: "2026-06", employees: [employee], terms: [term], records: inputRecords, days: inputDays, today: "2026-07-01" });
const beforeBaseline = JSON.stringify(baseline);
calc({ records: inputRecords, days: inputDays, baseSummaries: baseline });
assert.equal(JSON.stringify({ inputDays, inputRecords }), originals);
assert.equal(JSON.stringify(baseline), beforeBaseline);
console.log("Payroll rules passed: legal components, night/day factors, no double pay, approvals, versioned rates, leave, real schedule proration, employment and limit warnings.");
