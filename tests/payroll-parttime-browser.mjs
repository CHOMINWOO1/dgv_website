import { installMock } from "./helpers/payroll-browser-mock.mjs";
import { openPayrollView } from "./helpers/payroll-navigation.mjs";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// Exercise the real page, form and payroll calculations. Only the remote data
// boundary and clock are synthetic; no production records or wage guesses.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const server = createServer(async (req, res) => {
  try {
    const file = path.resolve(root, decodeURIComponent(new URL(req.url, "http://localhost").pathname).replace(/^\/+/, "") || "payroll.html");
    if (!file.startsWith(root + path.sep)) throw new Error("Invalid path");
    res.writeHead(200, { "Content-Type": mime[path.extname(file)] || "application/octet-stream" });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, channel: process.env.PAYROLL_BROWSER_CHANNEL || "chrome" });
const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
const page = await context.newPage(), errors = [];
const parttime = "00000000-0000-4000-8000-000000000001";
const hourly = "00000000-0000-4000-8000-000000000002";
const monthly = "00000000-0000-4000-8000-000000000003";
const fresh = "00000000-0000-4000-8000-000000000004";
const historical = "00000000-0000-4000-8000-000000000005";
const advance = "00000000-0000-4000-8000-000000000006";

function seedPartTime() {
  const db = window.__payrollTest.db;
  const [a, b] = db.payroll_employees;
  Object.assign(a, { name: "DEMO · Part-time A", employment_type: "part_time" });
  Object.assign(b, { name: "DEMO · Full-time hourly B", employment_type: "full_time" });
  const c = { id: "00000000-0000-4000-8000-000000000003", device_user_id: "MONTHLY", name: "DEMO · Monthly C", active: true, employment_type: "full_time" };
  const d = { id: "00000000-0000-4000-8000-000000000004", device_user_id: "NEW-PARTTIME", name: "DEMO · New part-time D", active: true, employment_type: "part_time" };
  const e = { id: "00000000-0000-4000-8000-000000000005", device_user_id: "HISTORICAL", name: "DEMO · Historical part-time E", active: true, employment_type: "part_time" };
  const f = { id: "00000000-0000-4000-8000-000000000006", device_user_id: "ADVANCE", name: "DEMO · Part-time advance F", active: true, employment_type: "part_time" };
  db.payroll_employees.push(c, d, e, f);
  const standard = { effective_from: "2026-06-01", shift_start: "10:00:00", shift_end: "20:00:00", break_start: "12:00:00", break_end: "14:00:00", weekly_rest_day: 0 };
  db.payroll_terms = [
    { ...standard, id: "legacy-parttime-zero", employee_id: a.id, pay_type: "hourly", rate: 0, overtime_hourly_rate: 40000, monthly_settlement: "statutory" },
    { ...standard, id: "existing-fulltime-hourly", employee_id: b.id, pay_type: "hourly", rate: 27500, overtime_hourly_rate: 95000, monthly_settlement: "statutory" },
    { ...standard, id: "existing-monthly", employee_id: c.id, pay_type: "monthly", rate: 7000000, monthly_settlement: "monthly_net" },
    { ...standard, id: "historical-parttime", employee_id: e.id, pay_type: "hourly", rate: 40000, monthly_settlement: "statutory" },
    { ...standard, id: "advance-parttime", employee_id: f.id, pay_type: "hourly", rate: 40000, monthly_settlement: "statutory" }
  ];
  let next = 0;
  const pair = (employee_id, date, start, end) => [[start, "in"], [end, "out"]].map(([time, punch_type]) => ({
    id: `parttime-${++next}`, employee_id, occurred_at: `${date}T${time}`, punch_type, source: "kiosk", device_id: "SYNTHETIC-TABLET"
  }));
  db.payroll_attendance_raw = [
    ...pair(a.id, "2026-10-01", "08:00:00", "13:30:00"),
    ...pair(b.id, "2026-10-01", "10:00:00", "20:00:00"),
    ...pair(c.id, "2026-10-01", "10:00:00", "20:00:00"),
    ...pair(e.id, "2026-10-01", "08:00:00", "13:30:00"),
    ...pair(f.id, "2026-10-01", "08:00:00", "13:30:00")
  ];
  // A known historical saved amount used the former scheduled-break policy.
  // It is fixture data to preserve, not a replacement for current calculation.
  db.payroll_runs = [{
    id: "historical-final-run", employee_id: e.id, month: "2026-10-01", base_amount: 160000, allowances: 0, deductions: 0, total: 160000,
    snapshot: { employee_id: e.id, name: e.name, settlementMode: "statutory", minutes: 240, baseAmount: 160000, statutoryAmount: 0, unresolved: 0,
      daily: [{ date: "2026-10-01", checkIn: "2026-10-01T08:00:00", checkOut: "2026-10-01T13:30:00", minutes: 240, actualSeconds: 14400, issues: [] }] }
  }];
}

await context.addInitScript(() => {
  const NativeDate = Date, fixed = NativeDate.parse("2026-10-29T10:00:00Z");
  globalThis.Date = class extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [fixed])); }
    static now() { return fixed; }
  };
});
await context.route("**/*", route => {
  const url = route.request().url();
  if (url.startsWith("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@")) {
    return route.fulfill({ contentType: "text/javascript", body: `(${installMock.toString()})("admin");(${seedPartTime.toString()})();` });
  }
  if (!url.startsWith(origin)) return route.fulfill({ body: "" });
  return route.continue();
});
page.on("pageerror", error => errors.push(error.message));
page.setDefaultTimeout(10000);
const idle = () => page.waitForFunction(() => DGV_PAYROLL_APP.state.loaded && !DGV_PAYROLL_APP.state.busy);
const field = (form, name) => page.locator(`#${form} [name="${name}"]`);
const submit = async form => { await page.locator(`#${form} button[type="submit"]`).click(); await idle(); };
const summary = id => page.evaluate(id => structuredClone(DGV_PAYROLL_APP.state.summaries.find(row => row.employee_id === id)), id);
const refresh = async () => { await page.locator("#refresh").click(); await idle(); };
const select = async (id, view = "employees") => {
  await openPayrollView(page, "ledger");
  await page.locator("#employeeFilter").selectOption(id);
  await openPayrollView(page, view);
};
const closeTerms = () => page.locator("#termsForm [data-close]").click();
const termWrites = () => page.evaluate(() => __payrollTest.calls.filter(call => call.table === "payroll_terms" && call.operation !== "select").length);
const ledgerRow = id => page.locator("#ledgerBody tr").filter({ has: page.locator(`[data-employee="${id}"]`) });
async function recordAdvance(id, amount) {
  await select(id, "payments");
  await page.locator("#addPayment").click();
  await field("paymentForm", "paid_on").fill("2026-10-29");
  await field("paymentForm", "amount").fill(String(amount));
  await field("paymentForm", "method").selectOption("cash");
  await field("paymentForm", "note").fill("Synthetic payment before monthly finalization");
  await submit("paymentForm");
  await page.locator("#evidenceDialog").waitFor({ state: "visible" });
  await page.locator("#evidenceForm [data-close]").click();
  assert.equal(await page.evaluate(id => __payrollTest.db.payroll_runs.some(run => run.employee_id === id), id), false, "payment does not finalize the monthly wage");
  return page.evaluate(id => structuredClone(__payrollTest.db.payroll_payments.find(payment => payment.employee_id === id)), id);
}
async function screenshot(name, selector) {
  if (!process.env.PAYROLL_SCREENSHOTS) return;
  await mkdir(process.env.PAYROLL_SCREENSHOTS, { recursive: true });
  await page.setViewportSize({ width: 390, height: selector === "#termsDialog" ? 1000 : 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "mobile page has no horizontal overflow");
  await page.evaluate(async () => { await document.fonts.ready; });
  await page.locator(selector).screenshot({ path: path.join(process.env.PAYROLL_SCREENSHOTS, name), animations: "disabled" });
  await page.setViewportSize({ width: 1280, height: 1000 });
}

try {
  await page.goto(origin + "/payroll.html");
  await idle();
  assert.equal(await page.locator("#month").inputValue(), "2026-10");

  // A legacy overtime rate must never become the employee's base hourly wage.
  await select(parttime);
  const originalTerms = await page.evaluate(() => structuredClone(__payrollTest.db.payroll_terms));
  let row = await summary(parttime);
  assert.equal(row.minutes, 330, "part-time attendance includes the entire 08:00–13:30 interval");
  assert.equal(row.baseAmount, null, "a zero base rate remains unresolved despite an overtime rate");
  await page.locator("#addTerms").click();
  assert.equal(await field("termsForm", "pay_type").inputValue(), "hourly");
  assert.equal(await field("termsForm", "rate").inputValue(), "0", "editing preserves the legacy zero instead of guessing 40,000");
  assert.match(await page.locator("#termsRateLabel").innerText(), /시급|giờ/i);
  assert.equal(await page.locator("#statutoryHourlyLabel").isVisible(), false);
  for (const [name, value] of [["shift_start", "10:00"], ["shift_end", "20:00"]]) {
    assert.equal(await field("termsForm", name).isVisible(), false, "actual hourly pay does not ask for a planned shift");
    assert.equal(await field("termsForm", name).isEnabled(), true, "hidden legacy schedule values remain serializable");
    assert.equal(await field("termsForm", name).inputValue(), value);
  }
  assert.equal(await field("termsForm", "break_start").isVisible(), false);
  assert.equal(await field("termsForm", "break_end").isVisible(), false);
  assert.equal(await page.locator("#termsBreakHelp").isVisible(), false);
  assert.equal(await page.locator("#partTimeHelp").isVisible(), true);
  assert.match(await page.locator("#partTimeHelp").innerText(), /차감하지|차감 없음|공제하지|공제 없음|không.*trừ|không nghỉ/i);
  const writesBefore = await termWrites();
  await submit("termsForm");
  assert.equal(await page.locator("#termsDialog").isVisible(), true, "zero hourly rate cannot be saved");
  assert.equal(await termWrites(), writesBefore);
  assert.deepEqual(await page.evaluate(() => __payrollTest.db.payroll_terms), originalTerms);

  // An explicit administrator edit appends a new effective-date version.
  await field("termsForm", "effective_from").fill("2026-10-01");
  await field("termsForm", "rate").fill("40000");
  await screenshot("payroll-parttime-form.png", "#termsDialog");
  await submit("termsForm");
  assert.equal(await page.locator("#termsDialog").isVisible(), false);
  const savedTerms = await page.evaluate(() => structuredClone(__payrollTest.db.payroll_terms));
  assert.equal(savedTerms.length, originalTerms.length + 1);
  assert.deepEqual(savedTerms.filter(term => originalTerms.some(old => old.id === term.id)), originalTerms, "all old salary versions remain unchanged");
  const newTerm = savedTerms.find(term => !originalTerms.some(old => old.id === term.id));
  assert.equal(newTerm.employee_id, parttime);
  assert.equal(newTerm.effective_from, "2026-10-01");
  assert.equal(newTerm.pay_type, "hourly");
  assert.equal(newTerm.rate, 40000);
  assert.equal(newTerm.break_start, newTerm.break_end, "part-time conditions persist an explicit no-break interval");

  await openPayrollView(page, "ledger");
  row = await summary(parttime);
  assert.equal(row.settlementMode, "hourly_actual");
  assert.equal(row.hourlyActualMinutes, 330);
  assert.equal(row.hourlyRate, 40000);
  assert.equal(row.hourlyAmount, 220000);
  assert.equal(row.baseAmount, 220000, "5.5 actual hours earn pay even far below a full month's planned hours");
  assert.equal(row.statutoryAmount, 0);
  assert.equal(row.unresolved, 0, "early arrival and early departure do not require extra approvals");
  assert.equal(row.lateMinutes, 0);
  assert.equal(row.earlyMinutes, 0);
  assert.equal(row.daily.find(day => day.date === "2026-10-01").actualSeconds, 19800);
  assert.equal(row.breakPolicy, "none");
  assert.equal(await page.locator("#monthlyTimeSummary").count(), 0);
  assert.equal(await page.locator("#hourlyTimeSummary").isVisible(), true);
  assert.match(await page.locator('[data-testid="hourly-actual-minutes"]').innerText(), /5h 30m/);
  assert.match(await page.locator('[data-testid="hourly-base-rate"]').innerText(), /40[.,]000/);
  assert.match(await page.locator('[data-testid="hourly-earned-amount"]').innerText(), /220[.,]000/);
  assert.doesNotMatch(await page.locator("#detailSummary").innerText(), /월 기준시간|초과·부족|월 초과수당/);
  assert.equal(await page.locator("#finalize").isEnabled(), true);
  assert.equal(await page.evaluate(() => __payrollTest.db.payroll_days.length), 0, "no manual work confirmation is required");
  await screenshot("payroll-parttime-summary.png", "#employeeDetail");
  await openPayrollView(page, "attendance");
  await page.locator('#calendar [data-day="2026-10-01"]').click();
  assert.equal(await page.locator("#dayDialog .approval-box").isVisible(), false, "hourly part-time attendance has no daily overtime approval requirement");
  await page.locator("#dayForm [data-close]").click();
  await openPayrollView(page, "ledger");

  // Finalization freezes pay; newer raw attendance is displayed separately.
  await page.locator("#finalize").click();
  await page.locator('#confirmForm input[type="checkbox"]').check();
  await submit("confirmForm");
  const frozen = await page.evaluate(id => structuredClone(__payrollTest.db.payroll_runs.find(run => run.employee_id === id)), parttime);
  assert.equal(frozen.total, 220000);
  assert.equal(frozen.snapshot.settlementMode, "hourly_actual");
  assert.equal(frozen.snapshot.hourlyActualMinutes, 330);
  await page.evaluate(id => {
    __payrollTest.db.payroll_attendance_raw.push(
      { id: "late-parttime-in", employee_id: id, occurred_at: "2026-10-02T12:00:00", punch_type: "in", source: "kiosk", device_id: "SYNTHETIC-TABLET" },
      { id: "late-parttime-out", employee_id: id, occurred_at: "2026-10-02T13:00:00", punch_type: "out", source: "kiosk", device_id: "SYNTHETIC-TABLET" }
    );
    __payrollTest.db.payroll_revision[0].version++;
  }, parttime);
  await refresh();
  assert.equal((await summary(parttime)).hourlyActualMinutes, 390);
  assert.equal((await summary(parttime)).baseAmount, 260000);
  assert.deepEqual(await page.evaluate(id => __payrollTest.db.payroll_runs.find(run => run.employee_id === id), parttime), frozen, "later attendance cannot mutate the final run or its snapshot");
  assert.match(await page.locator('[data-testid="hourly-actual-minutes"]').innerText(), /5h 30m/, "the saved payroll summary retains the finalized hours");
  assert.match(await page.locator('[data-testid="hourly-earned-amount"]').innerText(), /220[.,]000/);
  await openPayrollView(page, "attendance");
  assert.match(await page.locator('[data-testid="auto-attendance-minutes"]').innerText(), /6h 30m/, "current attendance is visible independently from saved wages");
  assert.match(await page.locator("#autoAttendanceSummary").innerText(), /확정 급여.*유지/);

  // Old finalized statutory snapshots also retain their historical meaning,
  // even though the employee's current calculation now uses actual hourly pay.
  const oldRun = await page.evaluate(() => structuredClone(__payrollTest.db.payroll_runs.find(run => run.id === "historical-final-run")));
  await select(historical, "ledger");
  row = await summary(historical);
  assert.equal(row.settlementMode, "hourly_actual");
  assert.equal(row.hourlyActualMinutes, 330);
  assert.equal(row.baseAmount, 220000);
  assert.equal(await page.locator("#hourlyTimeSummary").count(), 0, "a historic statutory snapshot is not relabeled as actual hourly settlement");
  assert.match(await page.locator("#reviewArea").innerText(), /160[.,]000/);
  await openPayrollView(page, "attendance");
  assert.match(await page.locator('[data-testid="auto-attendance-minutes"]').innerText(), /5h 30m/);
  assert.deepEqual(await page.evaluate(() => __payrollTest.db.payroll_runs.find(run => run.id === "historical-final-run")), oldRun);

  // New part-time workers require an explicit rate, including after reopening.
  await select(fresh);
  await page.locator("#addTerms").click();
  assert.equal(await field("termsForm", "pay_type").inputValue(), "hourly");
  assert.equal(await field("termsForm", "rate").inputValue(), "");
  assert.equal(await page.locator("#partTimeHelp").isVisible(), true);
  assert.equal(await field("termsForm", "break_start").isVisible(), false);
  assert.equal(await page.locator("#statutoryHourlyLabel").isVisible(), false);
  assert.equal(await field("termsForm", "shift_start").isVisible(), false);
  await field("termsForm", "pay_type").selectOption("monthly");
  assert.equal(await field("termsForm", "shift_start").isVisible(), true, "other pay types restore the schedule controls");
  assert.equal(await field("termsForm", "shift_end").isVisible(), true);
  await field("termsForm", "pay_type").selectOption("hourly");
  assert.equal(await field("termsForm", "shift_start").isVisible(), false);
  assert.equal(await field("termsForm", "shift_end").isVisible(), false);
  assert.equal(await field("termsForm", "rate").inputValue(), "");
  const writesAfterCorrection = await termWrites();
  await submit("termsForm");
  assert.equal(await page.locator("#termsDialog").isVisible(), true);
  assert.equal(await termWrites(), writesAfterCorrection, "a missing wage cannot insert a guessed default");
  await closeTerms();
  await page.locator("#addTerms").click();
  assert.equal(await field("termsForm", "rate").inputValue(), "");
  await closeTerms();

  // Existing full-time monthly and hourly terms retain their distinct policies.
  await select(monthly);
  await page.locator("#addTerms").click();
  assert.equal(await field("termsForm", "pay_type").inputValue(), "monthly");
  assert.equal(await field("termsForm", "rate").inputValue(), "7000000");
  assert.equal(await field("termsForm", "shift_start").isVisible(), true);
  assert.equal(await field("termsForm", "shift_end").isVisible(), true);
  assert.equal(await field("termsForm", "break_start").inputValue(), "12:00");
  assert.equal(await field("termsForm", "break_end").inputValue(), "14:00");
  assert.equal(await field("termsForm", "break_start").isVisible(), true);
  assert.equal(await field("termsForm", "break_end").isVisible(), true);
  assert.equal(await page.locator("#monthlyNetHelp").isVisible(), true);
  assert.equal(await page.locator("#partTimeHelp").isVisible(), false);
  await closeTerms();
  await openPayrollView(page, "ledger");
  row = await summary(monthly);
  assert.equal(row.settlementMode, "monthly_net");
  assert.equal(row.monthlyActualMinutes, 480, "full-time monthly work still deducts the scheduled 12–14 break");
  assert.ok(row.monthlyPlannedMinutes > row.monthlyActualMinutes);
  assert.equal(row.baseAmount, 7000000, "a monthly salary keeps its existing below-plan floor");
  assert.equal(row.monthlyExtraAmount, 0);
  assert.equal(await page.locator("#monthlyTimeSummary").isVisible(), true);
  assert.equal(await page.locator("#hourlyTimeSummary").count(), 0);
  await select(hourly);
  await page.locator("#addTerms").click();
  assert.equal(await field("termsForm", "pay_type").inputValue(), "hourly");
  assert.equal(await field("termsForm", "rate").inputValue(), "27500", "existing full-time hourly wage is not replaced by an overtime rate or new default");
  assert.equal(await page.locator("#statutoryHourlyLabel").isVisible(), true, "full-time hourly workers retain their existing overtime-rate control");
  assert.equal(await field("termsForm", "overtime_hourly_rate").isEnabled(), true);
  assert.equal(await field("termsForm", "overtime_hourly_rate").inputValue(), "95000");
  assert.equal(await field("termsForm", "shift_start").isVisible(), true);
  assert.equal(await field("termsForm", "shift_end").isVisible(), true);
  assert.equal(await field("termsForm", "break_start").isVisible(), true);
  assert.equal(await field("termsForm", "break_start").inputValue(), "12:00");
  assert.equal(await field("termsForm", "break_end").inputValue(), "14:00");
  assert.equal(await termWrites(), writesAfterCorrection, "inspection of unrelated employee terms makes no writes");
  await field("termsForm", "effective_from").fill("2026-10-01");
  await submit("termsForm");
  const fullTimeTerms = await page.evaluate(id => structuredClone(__payrollTest.db.payroll_terms.filter(term => term.employee_id === id)), hourly);
  assert.equal(fullTimeTerms.length, 2);
  assert.deepEqual(fullTimeTerms.find(term => term.id === "existing-fulltime-hourly"), originalTerms.find(term => term.id === "existing-fulltime-hourly"));
  const savedFullTime = fullTimeTerms.find(term => term.id !== "existing-fulltime-hourly");
  assert.equal(savedFullTime.effective_from, "2026-10-01");
  assert.equal(savedFullTime.rate, 27500);
  assert.equal(savedFullTime.overtime_hourly_rate, 95000, "saving a new full-time hourly version preserves the separate overtime rate");
  assert.equal(await termWrites(), writesAfterCorrection + 1);

  // Flexible payment reduces the live balance before finalization. Additional
  // work then increases only the unpaid estimate, preserving the payment.
  const hourlyAdvance = await recordAdvance(advance, 220000);
  assert.equal(hourlyAdvance.amount, 220000);
  assert.equal(hourlyAdvance.run_id, null);
  assert.equal(hourlyAdvance.payroll_month, "2026-10-01");
  assert.match(await page.locator('[data-testid="payment-remaining"]').innerText(), /^0\s*VND/);
  await openPayrollView(page, "ledger");
  assert.match(await ledgerRow(advance).locator("td").nth(2).innerText(), /220[.,]000/);
  assert.match(await ledgerRow(advance).locator("td").nth(3).innerText(), /220[.,]000/);
  assert.match(await ledgerRow(advance).locator("td").nth(4).innerText(), /^0\s*예상 잔액/);
  assert.equal(await page.locator("#metrics .metric").nth(2).locator("strong").innerText(), "0");
  await page.evaluate(id => {
    __payrollTest.db.payroll_attendance_raw.push(
      { id: "after-advance-in", employee_id: id, occurred_at: "2026-10-02T12:00:00", punch_type: "in", source: "kiosk", device_id: "SYNTHETIC-TABLET" },
      { id: "after-advance-out", employee_id: id, occurred_at: "2026-10-02T13:00:00", punch_type: "out", source: "kiosk", device_id: "SYNTHETIC-TABLET" }
    );
    __payrollTest.db.payroll_revision[0].version++;
  }, advance);
  await refresh();
  assert.equal((await summary(advance)).hourlyActualMinutes, 390);
  assert.equal((await summary(advance)).baseAmount, 260000);
  assert.match(await ledgerRow(advance).locator("td").nth(2).innerText(), /260[.,]000/);
  assert.match(await ledgerRow(advance).locator("td").nth(3).innerText(), /220[.,]000/);
  assert.match(await ledgerRow(advance).locator("td").nth(4).innerText(), /^40[.,]000\s*예상 잔액/, "260,000 earned minus 220,000 paid leaves 40,000 unpaid");
  assert.match(await page.locator("#metrics .metric").nth(2).locator("strong").innerText(), /40[.,]000/);
  await openPayrollView(page, "payments");
  assert.match(await page.locator('[data-testid="payment-remaining"]').innerText(), /40[.,]000\s*VND/);
  assert.deepEqual(await page.evaluate(id => __payrollTest.db.payroll_payments.find(payment => payment.id === id), hourlyAdvance.id), hourlyAdvance);
  assert.equal(await page.evaluate(id => __payrollTest.db.payroll_runs.some(run => run.employee_id === id), advance), false);

  // The same estimated ledger balance applies to full-time monthly pay.
  await select(monthly, "ledger");
  assert.match(await ledgerRow(monthly).locator("td").nth(4).innerText(), /^7[.,]000[.,]000\s*예상 잔액/);
  assert.match(await page.locator("#metrics .metric").nth(2).locator("strong").innerText(), /7[.,]000[.,]000/);
  const monthlyAdvance = await recordAdvance(monthly, 2000000);
  assert.equal(monthlyAdvance.run_id, null);
  await openPayrollView(page, "ledger");
  assert.match(await ledgerRow(monthly).locator("td").nth(2).innerText(), /7[.,]000[.,]000/);
  assert.match(await ledgerRow(monthly).locator("td").nth(3).innerText(), /2[.,]000[.,]000/);
  assert.match(await ledgerRow(monthly).locator("td").nth(4).innerText(), /^5[.,]000[.,]000\s*예상 잔액/, "monthly salary minus actual advance is shown before finalization");
  assert.match(await page.locator("#metrics .metric").nth(2).locator("strong").innerText(), /5[.,]000[.,]000/);
  assert.deepEqual(await page.evaluate(id => __payrollTest.db.payroll_runs.find(run => run.employee_id === id), parttime), frozen);
  assert.deepEqual(await page.evaluate(() => __payrollTest.db.payroll_runs.find(run => run.id === "historical-final-run")), oldRun);
  assert.deepEqual(errors, []);
  console.log("Part-time payroll browser passed: explicit wage correction, blank new-worker rate, no lunch deduction, actual-hours pay, separate monthly policy, mobile form/summary, immutable finalized payroll, and live hourly/monthly balances after flexible payments.");
} finally {
  await context.close();
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
