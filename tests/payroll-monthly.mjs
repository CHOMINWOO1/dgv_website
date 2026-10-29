import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const context = { console, Date, Map, Set, Object, Array, Number, String, Boolean, Math, JSON };
context.globalThis = context;
for (const file of ["payroll-core.js", "payroll-rules.js"]) vm.runInNewContext(await readFile(path.join(root, "assets", file), "utf8"), context);
const core = context.DGV_PAYROLL_CORE, rules = context.DGV_PAYROLL_RULES;
const employee = { id: "monthly-test", device_user_id: "test-monthly", name: "Synthetic monthly employee", active: true };
const term = { employee_id: employee.id, effective_from: "2026-01-01", pay_type: "monthly", rate: 7000000,
  monthly_settlement: "monthly_net", monthly_extra_hourly_rate: null, weekly_rest_day: 0,
  shift_start: "10:00", shift_end: "20:00", break_start: "12:00", break_end: "14:00" };
const day = (date, type, extra = {}) => ({ employee_id: employee.id, work_date: date, day_type: type, reason: "Synthetic explicit schedule", ...extra });
const timestamp = (date, clock) => date + "T" + clock + (clock.length === 5 ? ":00" : "");
const nextDate = (date) => new Date(Date.parse(date + "T00:00:00Z") + 86400000).toISOString().slice(0, 10);
const punch = (at) => ({ employee_id: employee.id, device_id: "device-test", occurred_at: at });
const pair = (date, from, to, endDate = date) => [punch(timestamp(date, from)), punch(timestamp(endDate, to))];
const plain = (value) => JSON.parse(JSON.stringify(value));
const virtual = (more = {}) => rules.buildEffectiveDays({ month: "2026-10", employees: [employee], terms: [term], days: [], ...more });
function fullRecords({ month = "2026-10", employees = [employee], terms = [term], days = [], changes = {} } = {}) {
  return rules.buildEffectiveDays({ month, employees, terms, days }).filter((day) => day.work_date.startsWith(month) && day.day_type === "work").flatMap((day) => {
    if (changes[day.work_date] === null) return [];
    const current = terms.filter((row) => row.employee_id === day.employee_id && row.effective_from <= day.work_date).sort((a, b) => a.effective_from.localeCompare(b.effective_from)).at(-1);
    const change = changes[day.work_date] || {}, start = change.start || current.shift_start, end = change.end || current.shift_end;
    return pair(day.work_date, start, end, end < start ? nextDate(day.work_date) : day.work_date);
  });
}
const calculate = (more = {}) => rules.extendSummaries({ month: "2026-10", employees: [employee], terms: [term], days: [], records: fullRecords(),
  rules: [], today: "2026-11-01", yearToDateRuns: [], ...more })[0];

// October has four Sundays, November has five: never a fixed 26-day/208-hour divisor.
let report = calculate();
assert.equal(report.settlementMode, "monthly_net");
assert.equal(report.monthlyPlannedMinutes, 216 * 60);
assert.equal(report.monthlyActualMinutes, 216 * 60);
assert.equal(report.monthlyBalanceMinutes, 0);
assert.equal(report.baseAmount, 7000000);
assert.equal(report.monthlyExtraAmount, 0);
assert.equal(report.statutoryAmount, 0);
assert.equal(report.unresolved, 0);
assert.equal(report.monthlyReadyToFinalize, true);
assert.equal(report.monthlyExpectedPayDate, "2026-11-05");
assert.equal(report.scheduleDefaultUsed, true);
assert.equal(report.daily.length, 31);
report = calculate({ month: "2026-11", records: fullRecords({ month: "2026-11" }), today: "2026-12-01" });
assert.equal(report.monthlyPlannedMinutes, 200 * 60);
assert.equal(report.monthlyActualMinutes, 200 * 60);
assert.equal(report.monthlyExtraHourlyRate, 35000);
assert.equal(report.unresolved, 0);
report = calculate({ month: "2026-11", records: fullRecords({ month: "2026-11", changes: { "2026-11-02": { end: "20:30" } } }), today: "2026-12-01" });
assert.equal(report.monthlyExtraAmount, 17500, "the same salary uses November's 200-hour basis for the actual selected month");

// Today's +1 hour is offset against tomorrow's -2 hours across the entire month.
report = calculate({ records: fullRecords({ changes: { "2026-10-01": { end: "21:00" }, "2026-10-02": { end: "18:00" } } }) });
assert.equal(report.daily.find((row) => row.date === "2026-10-01").minutes, 9 * 60);
assert.equal(report.daily.find((row) => row.date === "2026-10-02").minutes, 6 * 60);
assert.equal(report.monthlyActualMinutes, 215 * 60);
assert.equal(report.monthlyBalanceMinutes, -60);
assert.equal(report.monthlyExtraMinutes, 0);
assert.equal(report.monthlyExtraAmount, 0);
assert.equal(report.baseAmount, 7000000);
assert.equal(report.statutoryAmount, 0);
assert.equal(report.unresolved, 0, "monthly net requires no individual overtime approvals");

// A positive half-hour derives the hourly price from salary / this month's plan.
report = calculate({ records: fullRecords({ changes: { "2026-10-01": { end: "20:30" } } }),
  rules: [{ ...rules.DEFAULTS, effective_from: "2026-01-01", ot_enabled: false, monthly_proration: "scheduled", monthly_hour_basis: "contract", monthly_contract_hours: 208 }] });
assert.equal(report.monthlyBalanceMinutes, 30);
assert.equal(report.monthlyExtraMinutes, 30);
assert.equal(report.monthlyExtraHourlyRate, 7000000 / 216);
assert.equal(report.monthlyExtraAmount, 16204);
assert.equal(report.baseAmount + report.monthlyExtraAmount + report.statutoryAmount, 7016204);
assert.equal(report.unresolved, 0);
assert.equal(report.wageBreakdown.find((row) => row.code === "monthly_net_extra").category, "monthly_extra");
assert.equal(report.wageBreakdown.reduce((sum, row) => sum + row.amount, 0), 7016204);
assert.ok(!report.wageBreakdown.some((row) => row.code.includes("overtime")), "the same time is never paid again as statutory overtime");
assert.equal(report.regularOvertimeMinutes, 0);
assert.equal(report.monthlyExtraBasisAmount, 7000000);
assert.equal(report.monthlyExtraRateSource, "base_salary_divided_by_planned_hours");
report = calculate({ terms: [{ ...term, rate: 6480000 }], records: fullRecords({ changes: { "2026-10-01": { end: "20:30" } } }) });
assert.equal(report.monthlyExtraHourlyRate, 30000);
assert.equal(report.monthlyExtraAmount, 15000, "a 6.48m salary / 216 hours yields 30k per hour and 15k for 30 minutes");

// All actual seconds are accumulated, then rounded down to whole minutes once.
report = calculate({ records: fullRecords({ changes: { "2026-10-01": { end: "20:00:30" } } }) });
assert.equal(report.monthlyActualSeconds, 216 * 3600 + 30);
assert.equal(report.monthlyExtraMinutes, 0);
assert.equal(report.monthlyExtraAmount, 0, "30 seconds must not become a paid full extra minute");
report = calculate({ records: fullRecords({ changes: { "2026-10-01": { end: "20:00:30" }, "2026-10-02": { end: "20:00:30" } } }) });
assert.equal(report.monthlyExtraMinutes, 1);
assert.equal(report.monthlyExtraAmount, 540);
assert.equal(report.monthlyRoundingMinutes, 1);
assert.equal(report.minutes, report.monthlyActualMinutes);
assert.equal(report.daily.find((row) => row.date === "2026-10-01").actualSeconds, 8 * 3600 + 30);
assert.equal(report.daily.find((row) => row.date === "2026-10-01").minutes, 480);
report = calculate({ terms: [{ ...term, monthly_extra_hourly_rate: 10001 }], records: fullRecords({ changes: { "2026-10-01": { end: "20:01" } } }) });
assert.equal(report.monthlyExtraAmount, 540, "ignore saved extra price and round salary * extra minutes / planned minutes once");

// Saved overrides take precedence over the weekly pattern without mutating sources.
const overrides = [day("2026-10-04", "work"), day("2026-10-05", "rest")], savedOverrides = JSON.stringify(overrides);
report = calculate({ days: overrides, records: fullRecords({ days: overrides }) });
assert.equal(report.monthlyPlannedMinutes, 216 * 60);
assert.equal(report.daily.find((row) => row.date === "2026-10-04").scheduledMinutes, 480);
assert.equal(report.daily.find((row) => row.date === "2026-10-05").scheduledMinutes, 0);
assert.equal(report.daily.find((row) => row.date === "2026-10-04").scheduleDefaultUsed, false);
assert.equal(JSON.stringify(overrides), savedOverrides);
const explicitMonth = virtual().map(({ _scheduleDefault, ...saved }) => saved);
assert.equal(calculate({ days: explicitMonth }).scheduleDefaultUsed, false);
const mondayTerms = [{ ...term, weekly_rest_day: 1 }];
const regenerated = virtual({ terms: mondayTerms, days: virtual() });
assert.equal(regenerated.find((row) => row.work_date === "2026-10-04").day_type, "work", "virtual rows are regenerated after term changes");
assert.equal(regenerated.find((row) => row.work_date === "2026-10-05").day_type, "rest");

// Actual rest-day work increases actual time, without changing its zero planned basis.
report = calculate({ records: [...fullRecords(), ...pair("2026-10-04", "10:00", "20:00")] });
assert.equal(report.monthlyPlannedMinutes, 216 * 60);
assert.equal(report.monthlyActualMinutes, 224 * 60);
assert.equal(report.monthlyExtraAmount, 259259);
assert.equal(report.daily.find((row) => row.date === "2026-10-04").dayType, "rest");
assert.equal(report.unresolved, 0);

// Leave is labelled separately: it does not manufacture attendance or dock the base.
const leaveDays = [day("2026-10-01", "paid_leave"), day("2026-10-02", "unpaid_leave"), day("2026-10-03", "holiday")];
report = calculate({ days: leaveDays, records: fullRecords({ days: leaveDays }) });
assert.equal(report.monthlyPlannedMinutes, 216 * 60);
assert.equal(report.monthlyActualMinutes, 192 * 60);
assert.equal(report.monthlyCreditedMinutes, 0);
assert.equal(report.baseAmount, 7000000);
assert.equal(report.monthlyExtraAmount, 0);
assert.equal(report.paidLeaveDays, 1);
assert.equal(report.unpaidLeaveDays, 1);
assert.equal(report.holidayDays, 1);
assert.equal(report.unresolved, 0);

// Missing or ambiguous real attendance blocks finalization; no expected hours filled in.
report = calculate({ records: fullRecords({ changes: { "2026-10-01": null } }) });
assert.ok(report.attendanceUnresolved > 0);
assert.equal(report.monthlyActualMinutes, 208 * 60);
assert.equal(report.monthlyReadyToFinalize, false);
assert.ok(report.daily.find((row) => row.date === "2026-10-01").issueCodes.includes("missing"));
report = calculate({ records: [...fullRecords({ changes: { "2026-10-01": null } }), punch("2026-10-01T10:00:00")] });
assert.ok(report.daily.find((row) => row.date === "2026-10-01").issueCodes.includes("single"));
assert.equal(report.monthlyActualMinutes, 208 * 60);
const threePunches = [...fullRecords(), punch("2026-10-01T16:00:00")];
assert.ok(calculate({ records: threePunches }).attendanceUnresolved > 0);
report = calculate({ records: threePunches, days: [day("2026-10-01", "work", { check_in: "2026-10-01T10:00:00", check_out: "2026-10-01T20:00:00", reason: "Verified source correction" })] });
assert.equal(report.unresolved, 0);
assert.equal(report.monthlyActualMinutes, 216 * 60);

// Future schedules complete the month's basis but aren't labelled missing attendance.
report = calculate({ records: fullRecords().filter((row) => row.occurred_at < "2026-10-30"), today: "2026-10-30" });
assert.equal(report.monthlyPlannedMinutes, 216 * 60);
assert.equal(report.monthlyPendingDays, 2);
assert.equal(report.monthlyReadyToFinalize, false);
assert.equal(report.daily.find((row) => row.date === "2026-10-30").issues.length, 0);
assert.equal(report.daily.find((row) => row.date === "2026-10-31").issues.length, 0);
assert.ok(report.ruleIssues.some((text) => text.includes("월 집계 중")));
report = calculate({ today: "2026-09-30" });
assert.equal(report.monthlyPendingDays, 27, "complete future punch pairs cannot close a future payroll month");
assert.equal(report.monthlyActualMinutes, 0, "future punches are preserved for review, not counted as actual work");
assert.equal(report.daily.find((row) => row.date === "2026-10-01").status, "review");
assert.ok(report.daily.find((row) => row.date === "2026-10-01").issueCodes.includes("future"));
report = calculate({ today: "2026-10-31" });
assert.equal(report.monthlyPendingDays, 0, "today's completed attendance can close the last working day");
assert.equal(report.unresolved, 0);
report = calculate({ records: [...fullRecords().filter((row) => row.occurred_at < "2026-10-04"), ...pair("2026-10-04", "10:00", "20:00")], today: "2026-10-03" });
assert.equal(report.daily.find((row) => row.date === "2026-10-04").dayType, "rest");
assert.equal(report.daily.find((row) => row.date === "2026-10-04").minutes, 0);
assert.ok(report.daily.find((row) => row.date === "2026-10-04").issueCodes.includes("future"));
assert.ok(report.attendanceUnresolved > 0);

// Legacy extra-price values are ignored; the fixed base and actual month basis govern.
for (const rate of [null, undefined, "", 0, -1, 0.5, "invalid", 90000]) {
  report = calculate({ terms: [{ ...term, monthly_extra_hourly_rate: rate }], records: fullRecords({ changes: { "2026-10-01": { end: "20:30" } } }) });
  assert.equal(report.monthlyExtraHourlyRate, 7000000 / 216);
  assert.equal(report.monthlyExtraAmount, 16204);
  assert.equal(report.ruleUnresolved, 0);
}
const changedPrice = [term, { ...term, effective_from: "2026-10-15", monthly_extra_hourly_rate: 40000 }];
report = calculate({ terms: changedPrice });
assert.equal(report.monthlyExtraAmount, 0);
assert.equal(report.monthlyExtraHourlyRate, 7000000 / 216);
assert.equal(report.unresolved, 0);
const zeroBasisDays = virtual().map(({ _scheduleDefault, ...saved }) => ({ ...saved, day_type: "rest" }));
report = calculate({ days: zeroBasisDays, records: [] });
assert.equal(report.monthlyPlannedMinutes, 0);
assert.equal(report.monthlyExtraAmount, null);
assert.equal(report.monthlyExtraHourlyRate, null);
assert.ok(report.ruleIssues.some((text) => text.includes("월 기준시간이 0")));
assert.equal(report.monthlyReadyToFinalize, false);
assert.deepEqual(plain(rules.calculateMonthlyExtra({ baseAmount: 8000000, plannedMinutes: 216 * 60, extraMinutes: 30 })), { hourlyRate: 8000000 / 216, amount: 18519 }, "reviewed salary must drive both final derived rate and extra amount");
for (const values of [{ baseAmount: null, plannedMinutes: 12960, extraMinutes: 30 }, { baseAmount: 7000000, plannedMinutes: 0, extraMinutes: 30 }, { baseAmount: 7000000, plannedMinutes: 12960, extraMinutes: -1 }]) {
  assert.deepEqual(plain(rules.calculateMonthlyExtra(values)), { hourlyRate: null, amount: null });
}
const changedSchedule = [term, { ...term, effective_from: "2026-10-15", weekly_rest_day: 1 }];
report = calculate({ terms: changedSchedule, records: fullRecords({ terms: changedSchedule }) });
assert.equal(report.unresolved, 0);
assert.ok(report.warnings.some((text) => text.includes("적용일별")));
const changedSalary = [term, { ...term, effective_from: "2026-10-15", rate: 8000000 }];
report = calculate({ terms: changedSalary });
assert.equal(report.baseAmount, null);
assert.ok(report.compensationUnresolved > 0, "an unchosen blended salary is never silently invented");
assert.equal(report.monthlyExtraHourlyRate, null);
assert.equal(report.monthlyExtraAmount, null);
const mixedSettlement = [{ ...term, monthly_settlement: "statutory" }, { ...term, effective_from: "2026-10-15" }];
report = calculate({ terms: mixedSettlement });
assert.ok(report.ruleIssues.some((text) => text.includes("정산방식")));
assert.equal(report.statutoryAmount, 0, "mixed month is blocked rather than paid by both modes");

// Hiring month is prorated from full-calendar scheduled hours, without rounding its hourly basis.
const hired = { ...employee, hire_date: "2026-10-15" }, hireTerms = [{ ...term, effective_from: "2026-10-15" }];
report = calculate({ employees: [hired], terms: hireTerms, records: fullRecords({ employees: [hired], terms: hireTerms }) });
assert.equal(report.monthlyPlannedMinutes, 15 * 480);
assert.equal(report.monthlyActualMinutes, 15 * 480);
assert.equal(report.attendanceUnresolved, 0);
assert.equal(report.compensationUnresolved, 0, "only the resolved hiring-month salary issue is cleared automatically");
assert.equal(report.baseAmount, 3888889);
assert.equal(report.monthlyProration.fullSalary, 7000000);
assert.equal(report.monthlyProration.fullPlannedMinutes, 27 * 480);
assert.equal(report.monthlyProration.activePlannedMinutes, 15 * 480);
assert.equal(report.monthlyProration.ratio, 15 / 27);
assert.equal(report.monthlyExtraHourlyRate, 7000000 / 216);
assert.equal(report.monthlyExtraBasisAmount, 7000000);
assert.equal(report.monthlyExtraBasisMinutes, 27 * 480);
assert.equal(report.monthlyExpectedPayDate, "2026-11-05");
assert.ok(report.daily.every((row) => row.date >= hired.hire_date));
report = calculate({ employees: [hired], terms: hireTerms, records: fullRecords({ employees: [hired], terms: hireTerms, changes: { "2026-10-15": { end: "20:30" } } }) });
assert.equal(report.monthlyExtraAmount, 16204);
assert.equal(report.baseAmount + report.monthlyExtraAmount, 3905093);
assert.deepEqual(plain(rules.calculateMonthlyExtra({ baseAmount: report.baseAmount, plannedMinutes: report.monthlyPlannedMinutes, extraMinutes: 30,
  salaryBasisAmount: report.monthlyProration.fullSalary, salaryBasisMinutes: report.monthlyProration.fullPlannedMinutes })), { hourlyRate: 7000000 / 216, amount: 16204 });
assert.notEqual(report.monthlyExtraHourlyRate, report.baseAmount * 60 / report.monthlyPlannedMinutes, "do not derive the hourly rate from an already rounded prorated base");
const priorContract = { ...term, rate: 9000000, weekly_rest_day: 3 };
report = calculate({ employees: [hired], terms: [priorContract, ...hireTerms], records: fullRecords({ employees: [hired], terms: hireTerms }) });
assert.equal(report.baseAmount, 3888889, "the contract effective at hire, not a pre-employment condition, defines the hypothetical full month");
assert.equal(report.unresolved, 0);
const preHireOverride = [day("2026-10-04", "holiday")];
report = calculate({ employees: [hired], terms: hireTerms, days: preHireOverride, records: fullRecords({ employees: [hired], terms: hireTerms, days: preHireOverride }) });
assert.equal(report.monthlyProration.fullPlannedMinutes, 28 * 480, "saved date overrides before hire still inform the full-calendar salary divisor");
assert.equal(report.monthlyPlannedMinutes, 15 * 480);
assert.equal(report.baseAmount, 3750000);
assert.equal(report.monthlyActualMinutes, 15 * 480, "hypothetical prehire schedule never creates worked minutes");
assert.equal(report.unresolved, 0);
const sundayHire = { ...employee, hire_date: "2026-10-04" }, sundayHireTerms = [{ ...term, effective_from: "2026-10-04" }];
report = calculate({ employees: [sundayHire], terms: sundayHireTerms, records: fullRecords({ employees: [sundayHire], terms: sundayHireTerms }) });
assert.equal(report.monthlyPlannedMinutes, 24 * 480);
assert.equal(report.baseAmount, 6222222);
assert.equal(report.unresolved, 0, "hiring on a rest day starts employment but adds no planned work that day");
const firstDayHire = { ...employee, hire_date: "2026-10-01" };
report = calculate({ employees: [firstDayHire] });
assert.equal(report.monthlyProration, null);
assert.equal(report.baseAmount, 7000000);
const onlyRestHire = { ...employee, hire_date: "2026-05-31" }, onlyRestTerms = [{ ...term, effective_from: "2026-05-31" }];
report = calculate({ month: "2026-05", employees: [onlyRestHire], terms: onlyRestTerms, records: [], today: "2026-06-01" });
assert.equal(report.monthlyProration.fullPlannedMinutes, 26 * 480);
assert.equal(report.monthlyPlannedMinutes, 0);
assert.equal(report.baseAmount, 0);
assert.equal(report.monthlyExtraAmount, null);
assert.ok(report.attendanceUnresolved > 0, "zero active scheduled basis remains an explicit review blocker");
assert.equal(report.monthlyReadyToFinalize, false);
const hireAndExit = { ...hired, termination_date: "2026-10-25" };
report = calculate({ employees: [hireAndExit], terms: hireTerms, records: fullRecords({ employees: [hireAndExit], terms: hireTerms }) });
assert.equal(report.monthlyProration, null, "termination-month salary still needs review even if it was also the hiring month");
assert.ok(report.compensationUnresolved > 0);
assert.equal(report.attendanceUnresolved, 0);
const hireChangedSalary = [...hireTerms, { ...term, effective_from: "2026-10-22", rate: 8000000 }];
report = calculate({ employees: [hired], terms: hireChangedSalary, records: fullRecords({ employees: [hired], terms: hireChangedSalary }) });
assert.equal(report.monthlyProration, null);
assert.equal(report.baseAmount, null);
assert.ok(report.compensationUnresolved > 0, "a salary change during active employment is not cleared as a hiring issue");
report = calculate({ employees: [hired], terms: hireTerms, records: fullRecords({ employees: [hired], terms: hireTerms, changes: { "2026-10-15": null } }) });
assert.equal(report.baseAmount, 3888889);
assert.equal(report.compensationUnresolved, 0);
assert.ok(report.attendanceUnresolved > 0, "automatic prorating never waives missing actual attendance");
report = calculate({ month: "2026-12", records: fullRecords({ month: "2026-12" }), today: "2027-01-01" });
assert.equal(report.monthlyExpectedPayDate, "2027-01-05");
report = calculate({ employees: [{ ...employee, termination_date: "2026-09-30" }], records: [] });
assert.equal(report.baseAmount, 0);
assert.equal(report.monthlyPlannedMinutes, 0);
assert.equal(report.monthlyActualMinutes, 0);

// Overnight raw and corrected shifts are counted once, including across month end.
const nightTerms = [{ ...term, shift_start: "22:00", shift_end: "06:00", break_start: "00:00", break_end: "00:00" }];
const nightRecords = fullRecords({ terms: nightTerms });
report = calculate({ terms: nightTerms, records: nightRecords });
assert.equal(report.monthlyActualMinutes, 216 * 60);
assert.equal(report.unresolved, 0);
assert.equal(report.daily.find((row) => row.date === "2026-10-04").minutes, 0, "Saturday night checkout belongs to Saturday; default Sunday stays rest without a fake extra shift");
report = calculate({ terms: nightTerms, records: nightRecords, today: "2026-10-31" });
assert.ok(report.daily.find((row) => row.date === "2026-10-31").issueCodes.includes("future"), "a future next-day checkout needs review even when the shift started today");
assert.equal(report.monthlyReadyToFinalize, false);
const november = calculate({ month: "2026-11", terms: nightTerms, records: [...nightRecords, ...fullRecords({ month: "2026-11", terms: nightTerms })], today: "2026-12-01" });
assert.equal(november.monthlyActualMinutes, 200 * 60, "October checkout isn't paid again in November");
const correctedDays = [day("2026-10-31", "work", { check_in: "2026-10-31T19:00:00", check_out: "2026-11-01T03:00:00", reason: "Verified overnight correction" })];
const correctedRecords = [...fullRecords({ changes: { "2026-10-31": null } }), ...pair("2026-10-31", "19:00", "03:00", "2026-11-01")];
report = calculate({ records: correctedRecords, days: correctedDays });
assert.equal(report.monthlyActualMinutes, 216 * 60);
assert.equal(report.unresolved, 0);
report = calculate({ employees: [{ ...employee, termination_date: "2026-10-31" }], terms: nightTerms, records: nightRecords });
assert.ok(report.ruleIssues.some((text) => text.includes("재직기간 밖")));

// Old rows keep statutory mode; old saved snapshots and inputs remain immutable.
const { monthly_settlement, monthly_extra_hourly_rate, weekly_rest_day, ...legacyTerm } = term;
const legacy = rules.extendSummaries({ month: "2026-10", employees: [employee], terms: [legacyTerm], days: [], records: pair("2026-10-01", "10:00", "20:00"), rules: [], today: "2026-11-01" })[0];
assert.equal(legacy.settlementMode, "statutory");
assert.equal(legacy.monthlyExtraAmount, 0);
assert.equal(legacy.baseAmount, 7000000);
assert.equal(legacy.unresolved, 0);
const originals = { employees: [employee], terms: [term], records: fullRecords(), days: overrides };
const before = JSON.stringify(originals);
const oldBase = core.summarizeMonth({ month: "2026-10", ...originals, today: "2026-11-01" });
const beforeBase = JSON.stringify(oldBase);
report = calculate({ ...originals, baseSummaries: oldBase });
assert.equal(JSON.stringify(originals), before);
assert.equal(JSON.stringify(oldBase), beforeBase);
const frozenSnapshot = plain(calculate({ records: fullRecords({ changes: { "2026-10-01": { end: "20:30" } } }) }));
const saved = JSON.stringify(frozenSnapshot);
calculate({ terms: [{ ...term, monthly_extra_hourly_rate: 90000 }] });
assert.equal(JSON.stringify(frozenSnapshot), saved);
assert.equal(frozenSnapshot.monthlyExtraAmount, 16204);
assert.equal(frozenSnapshot.monthlyExtraHourlyRate, 7000000 / 216);
assert.equal(frozenSnapshot.calculationVersion, 3);
console.log("Monthly net settlement passed: real calendar, signed offsets, salary-derived extra rate, whole minutes, overrides, missing data, employment, overnight and immutable snapshots.");
