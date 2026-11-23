// Isolated generated-print fixture: no live authentication, API or business data.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(path.join(root, "assets/admin-bank-report.js"), "utf8");
const scope = { Date, Intl, Map, Set, Object, Array, Number, String, Boolean, Math, JSON };
vm.runInNewContext(source, scope);
const api = scope.DGV_BANK_REPORT;
const order = (id, payment_method, total_vnd, extra = {}) => ({
  id, payment_method, total_vnd, status: "paid", created_at: "2026-11-05T17:05:00Z",
  guide_name: '<img src=x onerror="alert(1)">', team_no: "테이블 102", ...extra,
});
const line = (qty, unit_vnd = 50_000) => ({
  ko_name: "반복 메뉴", vi_name: "Cùng món & <script>", qty, unit_vnd, line_vnd: qty * unit_vnd,
  menu_items: { price_vnd: 999_999 },
});
const input = {
  rangeText: "2026-11-06 ~ 2026-11-06", generatedAt: new Date("2026-11-07T01:02:00+07:00"),
  visibleOrders: [
    order("card-b", " CARD ", 100_000), order("bank-a", "bank", 50_000),
    order("cash-c", "cash", 60_000), order("cash-a", "cash", 50_000),
    order("bank-zero", "bank", 0), order("card-a", "card", 50_000),
    order("cash-b", "cash", 100_000),
    order("cash-pending", "cash", 50_000, { status: "pending" }),
    order("card-cancelled", "card", 50_000, { status: "cancelled" }),
    order("cash-excluded", "cash", 50_000, { sales_excluded: true }),
    order("unsupported-method", "voucher", 50_000),
  ],
  linesByOrder: new Map([
    ["bank-a", [line(1)]], ["bank-zero", [{ ...line(1), line_vnd: 0 }]],
    ["cash-a", [line(1)]], ["cash-b", [line(2)]], ["cash-c", [line(1, 60_000)]],
    ["card-a", [line(1)]], ["card-b", [line(2)]],
  ]),
};
const serialize = value => JSON.stringify(value, (_key, item) => item instanceof Map ? Array.from(item.entries()) : item);
const inputBefore = serialize(input), model = api.buildReport(input), modelBefore = serialize(model);
const html = api.renderHtml(model);
assert.equal(serialize(input), inputBefore);
assert.equal(serialize(model), modelBefore);
const expectedOrders = [...model.orders, ...model.otherOrders.filter(item => item.paymentMethod === "cash"),
  ...model.otherOrders.filter(item => item.paymentMethod === "card")];
assert.equal(expectedOrders.length, 7);

const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE
  || "C:/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs").href);
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe" });
let checks = 0;
const check = (value, label) => { assert.ok(value, label); checks++; console.log("PASS", label); };
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, serviceWorkers: "block" });
  const page = await context.newPage(), errors = [], unexpectedRequests = [], dialogs = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("dialog", async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  const appUrl = "https://payment-print-fixture.test/report.html";
  await context.route("**/*", async route => {
    if (route.request().url() === appUrl && route.request().isNavigationRequest()) {
      await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html });
    } else {
      unexpectedRequests.push({ url: route.request().url(), method: route.request().method() });
      await route.abort("blockedbyclient");
    }
  });
  await page.goto(appUrl);
  await page.evaluate(() => document.fonts.ready);
  check(await page.locator(".reportSection").count() === 7, "seven paid orders generate seven browser sections");
  check(await page.locator(".bankOrder").count() === 2, "bank orders remain individual");
  check(await page.locator(".cashOrders").count() === 3, "three matching-menu cash orders remain individual");
  check(await page.locator(".cardOrders").count() === 2, "two matching-menu card orders remain individual");

  const sections = await page.locator(".reportSection").evaluateAll(elements => elements.map(element => ({
    text: element.innerText,
    title: element.querySelector("h1")?.textContent,
    vietnameseTitle: element.querySelector("h2")?.textContent,
    meta: element.querySelector(".orderMeta")?.innerText,
    rows: Array.from(element.querySelectorAll(".items tbody tr"), row => Array.from(row.cells, cell => cell.innerText)),
    grand: element.querySelector(".grand")?.innerText,
    ending: !!element.querySelector(".orderEnding"),
    overflow: element.scrollWidth > element.clientWidth + 1,
  })));
  for (const [index, item] of expectedOrders.entries()) {
    const section = sections[index], formatted = value => value.toLocaleString("en-US");
    const methodName = { bank: "은행", cash: "현금", card: "카드" }[item.paymentMethod];
    const vietnameseName = { bank: "CHUYỂN KHOẢN", cash: "TIỀN MẶT", card: "THẺ" }[item.paymentMethod];
    check(section.meta.includes(item.id), `${item.id}: bank/cash/card ordering and order metadata are preserved`);
    check(expectedOrders.filter(other => other.id !== item.id).every(other => !section.text.includes(other.id)), `${item.id}: no other order identity leaks into its section`);
    check(section.title === `${methodName} 결제 주문 내역` && section.vietnameseTitle === `CHI TIẾT ĐƠN HÀNG ${vietnameseName}`, `${item.id}: bilingual heading identifies its payment method`);
    check(section.rows.length === 1, `${item.id}: one original line is not merged with matching menus in other orders`);
    assert.deepEqual(section.rows[0].slice(-3), [formatted(item.lines[0].qty), formatted(item.lines[0].unitAmount), formatted(item.lines[0].grossAmount)]);
    check(section.grand.includes(`${formatted(item.grossAmount)} VND`) && section.grand.includes(`${methodName} 결제 총액 (VAT 포함)`), `${item.id}: saved VAT-inclusive order total remains local to the order`);
    check(section.text.includes(`출력 묶음 / Nhóm in: ${index + 1} / 7`) && section.text.includes("2026-11-06 00:05"), `${item.id}: continuous numbering and Vietnam order time are shown`);
    check(section.ending && !section.overflow, `${item.id}: totals/footer stay in the order ending with no horizontal overflow`);
  }
  check(await page.locator("img, script, .orderIndex, .sectionIntro").count() === 0, "untrusted labels remain text and no obsolete aggregate block is rendered");
  check(!sections.some(section => /합산 내역|TỔNG HỢP THANH TOÁN|360,000/.test(section.text)), "printed output never substitutes method or range aggregates");

  await page.emulateMedia({ media: "print" });
  const breaks = await page.locator(".reportSection").evaluateAll(elements => elements.map(element => getComputedStyle(element).breakBefore));
  check(breaks[0] !== "page" && breaks.slice(1).every(value => value === "page"), "every later order starts on a new printed page");
  const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
  const pdfPages = pdf.toString("latin1").match(/\/Type\s*\/Page\b/g) || [];
  check(pdfPages.length === 7, "one PDF job contains all seven short orders on separate A4 pages");
  check(errors.length === 0 && dialogs.length === 0, "generated HTML raises no browser errors or active-content dialogs");
  check(unexpectedRequests.length === 0, "the generated report performs no external network requests");
  console.log(`Individual payment print browser: ${checks} checks passed; all network intercepted; PDF generated only in memory.`);
  await context.close();
} finally {
  await browser.close();
}
