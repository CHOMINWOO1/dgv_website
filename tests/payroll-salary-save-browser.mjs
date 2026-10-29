import { installMock } from "./helpers/payroll-browser-mock.mjs";
import { openPayrollView } from "./helpers/payroll-navigation.mjs";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// The real forms and calculations run against synthetic in-memory records.
// No production data, guessed employee salary, or remote writes are used.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const server = createServer(async (req, res) => {
  try {
    const file = path.resolve(root, decodeURIComponent(new URL(req.url, "http://localhost").pathname).replace(/^\/+/, "") || "payroll.html");
    if (!file.startsWith(root + path.sep)) throw new Error("Invalid path");
    res.writeHead(200, { "Content-Type": mime[path.extname(file)] || "application/octet-stream" });
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browserOptions = { headless: true };
const systemChrome = process.platform === "win32" ? path.join(process.env.ProgramFiles || "C:/Program Files", "Google/Chrome/Application/chrome.exe") : null;
if (process.env.PAYROLL_BROWSER_EXECUTABLE) browserOptions.executablePath = process.env.PAYROLL_BROWSER_EXECUTABLE;
else if (process.env.PAYROLL_BROWSER_CHANNEL) browserOptions.channel = process.env.PAYROLL_BROWSER_CHANNEL;
else if (systemChrome && existsSync(systemChrome)) browserOptions.executablePath = systemChrome;
else browserOptions.channel = "chrome";
const browser = await chromium.launch(browserOptions);
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage(), errors = [];
const parttime = "00000000-0000-4000-8000-000000000001";
const newcomerDevice = "SYNTHETIC-NEW-SALARY";
const newcomerName = "DEMO new monthly employee";
const monthlyAmount = 7200000;

function seedSalarySave() {
  const state = window.__payrollTest, db = state.db, previous = db.payroll_employees[0];
  Object.assign(previous, { name: "DEMO previous part-time", employment_type: "part_time", hire_date: "2026-06-01" });
  db.payroll_terms = [{ id: "synthetic-previous-hourly", employee_id: previous.id, effective_from: "2026-06-01",
    pay_type: "hourly", rate: 40000, overtime_hourly_rate: null, monthly_settlement: "statutory", weekly_rest_day: 0,
    shift_start: "10:00:00", shift_end: "20:00:00", break_start: "00:00:00", break_end: "00:00:00" }];
  db.payroll_attendance_raw = [];
  db.payroll_days = [{ id: "synthetic-previous-day", employee_id: previous.id, work_date: "2026-10-29", day_type: "work",
    check_in: "2026-10-29T08:00:00", check_out: "2026-10-29T13:30:00", reason: "Synthetic recorded shift" }];
  db.payroll_runs = [];
  db.payroll_payments = [{ id: "synthetic-previous-payment", run_id: null, employee_id: previous.id, payroll_month: "2026-10-01",
    paid_on: "2026-10-29", amount: 100000, method: "cash", reference: "Synthetic unchanged payment", created_at: "2026-10-29T07:00:00Z" }];
  db.payroll_payment_reversals = [];
  db.payroll_attachments = [];
}
await context.addInitScript(() => {
  const NativeDate = Date, now = NativeDate.parse("2026-10-29T10:00:00Z");
  globalThis.Date = class extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  };
});
await context.route("**/*", route => {
  const url = route.request().url();
  if (url.startsWith("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@")) return route.fulfill({ contentType: "text/javascript", body: `(${installMock.toString()})("admin");(${seedSalarySave.toString()})();` });
  if (!url.startsWith(origin)) return route.fulfill({ body: "" });
  return route.continue();
});
page.on("pageerror", error => errors.push(error.message));
page.setDefaultTimeout(10000);
const idle = () => page.waitForFunction(() => DGV_PAYROLL_APP.state.loaded && !DGV_PAYROLL_APP.state.busy);
const field = (form, name) => page.locator(`#${form} [name="${name}"]`);
const submit = async form => { await page.locator(`#${form} button[type="submit"]`).click(); await idle(); };
const summary = id => page.evaluate(id => structuredClone(DGV_PAYROLL_APP.state.summaries.find(row => row.employee_id === id)), id);
const closeTerms = () => page.locator("#termsForm [data-close]").click();
const ledgerRow = id => page.locator("#ledgerBody tr").filter({ has: page.locator(`[data-employee="${id}"]`) });

try {
  await page.goto(origin + "/payroll.html");
  await idle();
  await openPayrollView(page, "ledger");
  await page.locator("#employeeFilter").selectOption(parttime);
  await openPayrollView(page, "employees");
  const preserved = await page.evaluate(id => ({
    terms: structuredClone(__payrollTest.db.payroll_terms.filter(term => term.employee_id === id)),
    payments: structuredClone(__payrollTest.db.payroll_payments), days: structuredClone(__payrollTest.db.payroll_days)
  }), parttime);
  assert.equal((await summary(parttime)).baseAmount, 220000);

  // Registering a new employee must move the selected salary target away from
  // the previously selected hourly worker, even though that old record remains.
  await page.locator("#addEmployee").click();
  await field("employeeForm", "device_user_id").fill(newcomerDevice);
  await field("employeeForm", "name").fill(newcomerName);
  await field("employeeForm", "national_id").fill("000000-SYNTHETIC-ID");
  await field("employeeForm", "employment_type").selectOption("full_time");
  await field("employeeForm", "hire_date").fill("2026-10-01");
  await submit("employeeForm");
  const newcomer = await page.evaluate(device => __payrollTest.db.payroll_employees.find(employee => employee.device_user_id === device).id, newcomerDevice);
  assert.equal(await page.evaluate(() => DGV_PAYROLL_APP.state.selected), newcomer);
  assert.equal(await page.locator("#employeeFilter").inputValue(), newcomer);
  assert.match(await page.locator("#detailTitle").innerText(), new RegExp(newcomerName));
  assert.equal(await page.evaluate(id => __payrollTest.db.payroll_terms.filter(term => term.employee_id === id).length, newcomer), 0, "employee identity save does not invent a salary");
  assert.equal((await summary(newcomer)).baseAmount, null);

  // The shared detail action must now open this new employee's empty salary
  // form. An arbitrary displayed default must never masquerade as saved pay.
  await page.locator("#addTerms").click();
  assert.equal(await field("termsForm", "pay_type").inputValue(), "monthly");
  assert.equal(await field("termsForm", "rate").inputValue(), "");
  assert.equal(await page.locator("#termsForm").getAttribute("data-employee-id"), newcomer);
  const employeeContext = await page.locator("#termsEmployeeContext").innerText();
  assert.ok(employeeContext.includes(newcomerName));
  assert.ok(employeeContext.includes(newcomerDevice));
  assert.equal(await field("termsForm", "break_start").isEnabled(), true);
  assert.equal(await field("termsForm", "break_start").inputValue(), "12:00");
  assert.equal(await field("termsForm", "break_end").inputValue(), "14:00");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await submit("termsForm");
  assert.equal(await page.locator("#termsDialog").isVisible(), true, "empty monthly salary requires explicit input");
  assert.equal(await page.evaluate(id => __payrollTest.db.payroll_terms.filter(term => term.employee_id === id).length, newcomer), 0);

  // Simulate one remote insert rejection without altering the shared mock.
  // The dialog and user's amount must remain available for a deliberate retry.
  await page.evaluate(() => {
    window.__salarySaveAttempts = [];
    window.__failSalarySaveOnce = true;
    const originalFrom = DGV.supabase.from.bind(DGV.supabase);
    DGV.supabase.from = table => {
      const query = originalFrom(table), originalThen = query.then;
      if (table === "payroll_terms") query.then = function(resolve, reject) {
        if (this.operation === "insert") {
          __salarySaveAttempts.push(structuredClone(this.value));
          if (__failSalarySaveOnce) {
            __failSalarySaveOnce = false;
            return Promise.resolve({ data: null, error: { message: "Synthetic salary insert failure" } }).then(resolve, reject);
          }
        }
        return originalThen.call(this, resolve, reject);
      };
      return query;
    };
  });
  await field("termsForm", "rate").fill(String(monthlyAmount));
  await field("termsForm", "effective_from").fill("2026-10-01");
  await field("termsForm", "monthly_settlement").selectOption("monthly_net");
  await submit("termsForm");
  assert.equal(await page.locator("#termsDialog").isVisible(), true);
  assert.match(await page.locator("#termsDialog .dialog-error").innerText(), /Synthetic salary insert failure/);
  assert.equal(await field("termsForm", "rate").inputValue(), String(monthlyAmount));
  assert.equal(await page.locator("#termsForm button[type=submit]").isEnabled(), true);
  assert.equal(await page.evaluate(id => __payrollTest.db.payroll_terms.filter(term => term.employee_id === id).length, newcomer), 0);

  await submit("termsForm");
  assert.equal(await page.locator("#termsDialog").isVisible(), false);
  const attempts = await page.evaluate(() => structuredClone(__salarySaveAttempts));
  assert.equal(attempts.length, 2);
  for (const payload of attempts) {
    assert.equal(payload.employee_id, newcomer);
    assert.equal(payload.pay_type, "monthly");
    assert.equal(payload.rate, monthlyAmount);
    assert.equal(payload.monthly_settlement, "monthly_net");
    assert.equal(payload.monthly_extra_hourly_rate, null);
    assert.equal(payload.overtime_hourly_rate, null);
    assert.equal(payload.break_start, "12:00");
    assert.equal(payload.break_end, "14:00");
  }
  const notice = await page.locator("#notice").innerText();
  assert.ok(notice.includes(newcomerName));
  assert.match(notice, /7[.,]200[.,]000/);
  assert.ok(notice.includes("2026-10-01"));
  assert.equal(await page.evaluate(id => __payrollTest.db.payroll_terms.filter(term => term.employee_id === id).length, newcomer), 1);

  // Saving agreed monthly pay is enough to show an estimated unpaid amount;
  // it does not create a finalized payroll run or alter previous money records.
  assert.equal((await summary(newcomer)).baseAmount, monthlyAmount);
  assert.equal(await page.evaluate(() => __payrollTest.db.payroll_runs.length), 0);
  await openPayrollView(page, "ledger");
  const newRow = ledgerRow(newcomer);
  assert.match(await newRow.locator("td").nth(4).innerText(), /7[.,]200[.,]000/);
  assert.match(await newRow.locator("td").nth(4).innerText(), /예상/);
  await openPayrollView(page, "payments");
  assert.match(await page.locator('[data-testid="payment-expected"]').innerText(), /7[.,]200[.,]000/);
  assert.match(await page.locator('[data-testid="payment-remaining"]').innerText(), /7[.,]200[.,]000/);
  await openPayrollView(page, "employees");
  await page.locator(`[data-staff-action="salary"][data-staff-id="${newcomer}"]`).click();
  assert.equal(await field("termsForm", "rate").inputValue(), String(monthlyAmount), "reopening a saved salary shows its actual stored amount");
  await closeTerms();

  const after = await page.evaluate(id => ({
    terms: structuredClone(__payrollTest.db.payroll_terms.filter(term => term.employee_id === id)),
    payments: structuredClone(__payrollTest.db.payroll_payments), days: structuredClone(__payrollTest.db.payroll_days)
  }), parttime);
  assert.deepEqual(after, preserved, "new monthly setup preserves the previous part-time rate, shifts and payments");
  assert.equal((await summary(parttime)).baseAmount, 220000);
  assert.deepEqual(errors, []);
  console.log("Salary-save browser passed: new employee selection, blank unsaved salary, visible target, retryable failure, monthly estimated unpaid balance and unchanged part-time data.");
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
