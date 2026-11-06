import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(path.join(root, "assets/admin-bank-report.js"), "utf8");
const admin = (await readFile(path.join(root, "admin.html"), "utf8")).replace(/\r\n/g, "\n");
new vm.Script(source, { filename: "assets/admin-bank-report.js" });
assert.doesNotMatch(source, /\b(?:fetch|XMLHttpRequest)\s*\(|\.(?:insert|update|upsert|delete|rpc)\s*\(/, "bank report generation must not perform network calls or DB writes");
const scope = { Date, Intl, Map, Set, Object, Array, Number, String, Boolean, Math, JSON };
vm.runInNewContext(source, scope);
const api = scope.DGV_BANK_REPORT;
assert.equal(typeof api?.buildReport, "function");
assert.equal(typeof api?.renderHtml, "function");

function fixture() {
  const order = (id, payment_method = "bank", status = "paid", total_vnd = 240_000) => ({
    id, payment_method, status, total_vnd, created_at: "2026-11-05T17:05:00Z", guide_name: "<손님>", team_no: "테이블 102",
  });
  const line = (ko_name, vi_name, qty, unit_vnd, line_vnd, extra = {}) => ({ ko_name, vi_name, qty, unit_vnd, line_vnd, ...extra });
  return {
    rangeText: "2026-11-06 ~ 2026-11-06", taxFromDate: "2026-11-06", taxToDate: "2026-11-06",
    rangeFrom: new Date("2026-11-06T00:00:00+07:00"), rangeTo: new Date("2026-11-06T23:59:59.999+07:00"),
    generatedAt: new Date("2026-11-07T01:02:00+07:00"),
    visibleOrders: [
      order("order-mixed"),
      order("order-custom", " BANK ", " PAID ", 200_000),
      order("order-zero", "bank", "paid", 0),
      order("order-no-lines", "bank", "paid", 55_000),
      order("order-bank-extra", "bank", "paid", 100_000),
      order("order-cash", "cash"), order("order-card", "card"),
      order("order-pending", "bank", "pending"), order("order-cancelled", "bank", "cancelled"),
      order("order-unknown-method", "voucher", "paid"),
      { ...order("order-excluded"), sales_excluded: true },
    ],
    linesByOrder: new Map([
      ["order-mixed", [
        line("돼지국밥", "Canh thịt heo & cơm", 1, 200_000, 200_000, { kind: "food", menu_items: { price_vnd: 999_999 } }),
        line("구아바 주스", "Nước ép ổi", 1, 40_000, 40_000, { kind: "drink" }),
      ]],
      ["order-custom", [line('<img src=x onerror="alert(1)">', "Món đặc biệt", 3, 70_000, 210_000, { is_custom: true, line_source: "order_custom_items", kind: "special" })]],
      ["order-zero", [line("서비스", "Miễn phí", 1, 99_000, 0)]],
      ["order-bank-extra", [line("맥주", "Bia", 2, 50_000, 100_000)]],
      ["order-cash", [line("현금 메뉴", "Món tiền mặt", 2, 120_000, 240_000)]],
      ["order-card", [line("카드 메뉴", "Món thẻ", 3, 80_000, 240_000)]],
    ]),
  };
}

const serialize = value => JSON.stringify(value, (_key, item) => item instanceof Map ? Array.from(item.entries()) : item);
const input = fixture();
const before = serialize(input);
const model = api.buildReport(input);
assert.equal(serialize(input), before, "building the print model must not mutate orders or item snapshots");
assert.equal(model.orderCount, 7, "all paid, non-excluded bank/cash/card orders belong in the report");
assert.equal(model.bankOrderCount, 5);
assert.equal(model.sectionCount, 6, "five bank orders plus the combined cash/card group need six sections");
assert.deepEqual(Array.from(model.orders, item => item.id).sort(), ["order-bank-extra", "order-custom", "order-mixed", "order-no-lines", "order-zero"]);
assert.deepEqual(Array.from(model.otherOrders, item => item.id).sort(), ["order-card", "order-cash"]);
assert.equal(model.bankGrossAmount, 595_000);
assert.equal(model.otherGrossAmount, 480_000);
assert.equal(model.grossAmount, 1_075_000);
assert.equal(model.grossAmount, model.bankGrossAmount + model.otherGrossAmount);
assert.equal(model.rangeText, input.rangeText);

const mixed = model.orders.find(item => item.id === "order-mixed");
assert.equal(mixed.lines.length, 2, "food and drinks must stay together under one order");
assert.equal(mixed.lines[0].unitAmount, 200_000, "historical order price must not come from the current menu price");
assert.equal(mixed.lines[0].grossAmount, 200_000);
assert.equal(mixed.lines[1].grossAmount, 40_000);
assert.equal(mixed.lineTotal, 240_000);
assert.equal(mixed.grossAmount, 240_000);
assert.equal(mixed.difference, 0);
const custom = model.orders.find(item => item.id === "order-custom");
assert.equal(custom.lines.length, 1);
assert.equal(custom.lines[0].qty, 3);
assert.equal(custom.lines[0].grossAmount, 210_000, "custom line snapshots must not be silently rescaled to match the order total");
assert.equal(custom.grossAmount, 200_000);
assert.equal(custom.difference, -10_000, "order-versus-detail differences must be explicit");
assert.equal(model.orders.find(item => item.id === "order-zero").lines[0].grossAmount, 0, "an explicit zero line total must not fall back to unit price");
const noLines = model.orders.find(item => item.id === "order-no-lines");
assert.equal(noLines.lines.length, 0);
assert.equal(noLines.grossAmount, 55_000, "a missing detail must not erase the recorded order total");
assert.ok(noLines.warnings.length > 0, "missing details must be visible as a warning");

const modelBefore = serialize(model);
const html = api.renderHtml(model);
assert.equal(serialize(model), modelBefore, "rendering must be read-only");
const sectionCount = (html.match(/<section\b(?=[^>]*class="[^"]*\bbankOrder\b)/g) || []).length;
assert.equal(sectionCount, 5, "each bank order needs an independent printable section");
assert.equal((html.match(/<section\b(?=[^>]*class="[^"]*\botherOrders\b)/g) || []).length, 1, "cash and card orders must share one printable group");
const otherSection = html.match(/<section\b(?=[^>]*class="[^"]*\botherOrders\b)[\s\S]*?<\/section>/)?.[0];
assert.ok(otherSection, "the combined non-bank report must be present");
assert.match(otherSection, /order-cash/);
assert.match(otherSection, /order-card/);
assert.match(otherSection, /현금 메뉴/);
assert.match(otherSection, /카드 메뉴/);
assert.match(otherSection, /480,000/);
assert.match(html, /break-before\s*:\s*page|page-break-before\s*:\s*always/, "orders must start on separate printed pages");
assert.match(html, /A4/);
assert.match(html, /VAT 포함|VAT\s*포함/);
assert.match(html, /VAT/);
assert.match(html, /240,000/);
assert.match(html, /40,000/);
assert.match(html, /200,000/);
assert.match(html, /210,000/);
assert.match(html, /-10,000|−10,000/);
assert.match(html, /돼지국밥/);
assert.match(html, /Nước ép ổi/);
assert.match(html, /&lt;손님&gt;/);
assert.match(html, /&lt;img/);
assert.doesNotMatch(html, /<img\b|<script\b|onerror="alert\(1\)"/, "untrusted menu names must never become active HTML");
assert.doesNotMatch(html, /order-pending|order-cancelled|order-excluded|order-unknown-method/);
assert.match(source, /Asia\/Ho_Chi_Minh/, "printed order timestamps must use Vietnam time, not the viewer's computer time");
assert.match(html, /00:05/, "an order at 17:05Z must print 00:05 Vietnam time on the next day");
assert.match(html, /입금|ngân hàng|chuyển khoản/i, "report must clarify the bank payment context");

const emptyModel = api.buildReport({ ...fixture(), visibleOrders: [] });
assert.equal(emptyModel.orderCount, 0);
assert.equal(emptyModel.grossAmount, 0);
assert.equal(emptyModel.bankOrderCount, 0);
assert.equal(emptyModel.bankGrossAmount, 0);
assert.equal(emptyModel.otherGrossAmount, 0);
assert.equal(emptyModel.sectionCount, 0);
assert.equal((api.renderHtml(emptyModel).match(/<section\b(?=[^>]*class="[^"]*\bbankOrder\b)/g) || []).length, 0);
assert.equal((api.renderHtml(emptyModel).match(/<section\b(?=[^>]*class="[^"]*\botherOrders\b)/g) || []).length, 0);

const cashCardInput = fixture();
cashCardInput.visibleOrders = cashCardInput.visibleOrders.filter(order => ["cash", "card"].includes(order.payment_method));
const cashCardOnly = api.buildReport(cashCardInput);
assert.equal(cashCardOnly.orderCount, 2);
assert.equal(cashCardOnly.bankOrderCount, 0);
assert.equal(cashCardOnly.sectionCount, 1);
assert.equal(cashCardOnly.grossAmount, 480_000);
const bankOnlyInput = fixture();
bankOnlyInput.visibleOrders = bankOnlyInput.visibleOrders.filter(order => order.payment_method.trim().toLowerCase() === "bank");
const bankOnly = api.buildReport(bankOnlyInput);
assert.equal(bankOnly.orderCount, 5);
assert.equal(bankOnly.sectionCount, 5);
assert.equal(bankOnly.otherOrders.length, 0);
assert.equal(bankOnly.otherGrossAmount, 0);
assert.equal((api.renderHtml(bankOnly).match(/<section\b(?=[^>]*class="[^"]*\botherOrders\b)/g) || []).length, 0);

const aggregateInput = fixture();
aggregateInput.visibleOrders = [
  { ...input.visibleOrders[0], id: "cash-a", payment_method: "cash", total_vnd: 50_000 },
  { ...input.visibleOrders[0], id: "cash-b", payment_method: "cash", total_vnd: 100_000 },
  { ...input.visibleOrders[0], id: "cash-c", payment_method: "cash", total_vnd: 60_000 },
  { ...input.visibleOrders[0], id: "card-a", payment_method: "card", total_vnd: 50_000 },
];
aggregateInput.linesByOrder = new Map([
  ["cash-a", [{ ko_name: "반복 메뉴", vi_name: "Cùng món", qty: 1, unit_vnd: 50_000, line_vnd: 50_000 }]],
  ["cash-b", [{ ko_name: "반복 메뉴", vi_name: "Cùng món", qty: 2, unit_vnd: 50_000, line_vnd: 100_000 }]],
  ["cash-c", [{ ko_name: "반복 메뉴", vi_name: "Cùng món", qty: 1, unit_vnd: 60_000, line_vnd: 60_000 }]],
  ["card-a", [{ ko_name: "반복 메뉴", vi_name: "Cùng món", qty: 1, unit_vnd: 50_000, line_vnd: 50_000 }]],
]);
const aggregateBefore = serialize(aggregateInput);
const aggregateModel = api.buildReport(aggregateInput);
const aggregateHtml = api.renderHtml(aggregateModel);
assert.equal(serialize(aggregateInput), aggregateBefore);
assert.equal(aggregateModel.grossAmount, 260_000);
const aggregateBody = aggregateHtml.match(/<table class="items">[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/)?.[1];
assert.ok(aggregateBody);
assert.equal((aggregateBody.match(/<tr>/g) || []).length, 3, "same-price cash lines may merge; different prices and card lines must stay separate");
assert.match(aggregateBody, /<td class="number">3<\/td>\s*<td class="number">50,000<\/td>\s*<td class="number">150,000<\/td>/);
assert.match(aggregateHtml, /210,000 VND/);

const missingInput = fixture();
missingInput.visibleOrders = [{ ...input.visibleOrders[0], id: "missing-total", total_vnd: null }];
missingInput.linesByOrder = new Map([["missing-total", [{ ko_name: "저장 단가", qty: 2, unit_vnd: 40_000, line_vnd: null }]]]);
const missingModel = api.buildReport(missingInput);
assert.equal(missingModel.orders[0].lines[0].grossAmount, 80_000);
assert.equal(missingModel.orders[0].grossAmount, 80_000);
assert.ok(missingModel.orders[0].warnings.length >= 2, "derived line and order totals must both be disclosed");
missingInput.linesByOrder = new Map();
const unknownModel = api.buildReport(missingInput);
assert.equal(unknownModel.orders[0].grossAmount, null, "missing order and detail prices must not be invented as a zero sale");
assert.equal(unknownModel.bankGrossAmount, null);
assert.equal(unknownModel.grossAmount, null);
assert.match(api.renderHtml(unknownModel), /확인 필요/);

assert.match(admin, /id="bankPrintRangeBtn"/);
assert.match(admin, /<script src="assets\/admin-bank-report\.js(?:\?[^\"]*)?"><\/script>/);
assert.match(admin, /getElementById\("bankPrintRangeBtn"\)\.addEventListener\("click",\s*printBankOrders\)/);
const handlerStart = admin.indexOf("async function printBankOrders(");
assert.ok(handlerStart > 0, "admin must define a separate bank print action");
const handlerTail = admin.slice(handlerStart);
const handlerEnd = handlerTail.indexOf("\n    }\n");
assert.ok(handlerEnd > 0);
const handlerSource = handlerTail.slice(0, handlerEnd + 6);
assert.doesNotMatch(handlerSource, /\.(?:insert|update|upsert|delete|rpc)\s*\(/);
assert.match(handlerSource, /loadTaxRangeReportData\(/, "bank printing must reuse the fully paginated Vietnam-day report query");

function printContext({ result = model, blocked = false, readError = null, fromDate = "2026-11-06", toDate = "2026-11-06", disabled = false } = {}) {
  const events = [];
  const alerts = [];
  const button = { disabled, textContent: "결제별 출력 (은행 개별)" };
  const popup = {
    closed: false,
    document: { open: () => events.push("document.open"), write: value => events.push(["write", value]), close: () => events.push("document.close"), fonts: { ready: Promise.resolve() } },
    close() { this.closed = true; events.push("close"); },
    focus: () => events.push("focus"), print: () => events.push("print"),
    addEventListener: () => {},
  };
  const context = {
    document: { getElementById: id => id === "bankPrintRangeBtn" ? button : { value: id === "fromDate" ? fromDate : toDate } },
    window: { open: () => { events.push("open"); return blocked ? null : popup; }, DGV_BANK_REPORT: { buildReport: () => result, renderHtml: () => "<html>bank report fixture</html>" } },
    DGV_BANK_REPORT: { buildReport: () => result, renderHtml: () => "<html>bank report fixture</html>" },
    loadTaxRangeReportData: async () => { events.push("query"); if (readError) throw readError; return fixture(); },
    alert: message => alerts.push(message), console: { error: () => {} },
    Date, String, Number, Math, Promise,
    setTimeout: callback => { callback(); return 1; },
    requestAnimationFrame: callback => { callback(); return 1; },
  };
  vm.runInNewContext(`${handlerSource}\nthis.run=printBankOrders;`, context);
  return { context, events, alerts, button, popup };
}

const success = printContext();
await success.context.run();
assert.ok(success.events.indexOf("open") < success.events.indexOf("query"), "popup must open synchronously before awaiting data to avoid popup blockers");
assert.equal(success.button.disabled, false);
assert.equal(success.button.textContent, "결제별 출력 (은행 개별)");
assert.ok(success.events.some(event => Array.isArray(event) && event[1].includes("bank report fixture")));
await Promise.resolve();
assert.equal(success.events.filter(event => event === "open").length, 1, "all payment groups must share one window");
assert.equal(success.events.filter(event => event === "print").length, 1, "font readiness and fallback timers must not open duplicate print dialogs");
const otherOnlyPrint = printContext({ result: cashCardOnly });
await otherOnlyPrint.context.run();
await Promise.resolve();
assert.equal(otherOnlyPrint.events.filter(event => event === "print").length, 1, "cash/card-only periods must still print the combined group");
assert.equal(otherOnlyPrint.alerts.length, 0);

for (const options of [{ result: emptyModel }, { readError: new Error("simulated read failure") }]) {
  const check = printContext(options);
  await check.context.run();
  assert.equal(check.popup.closed, true, "empty/error output must close the blank preparation popup");
  assert.ok(check.alerts.length > 0);
  assert.equal(check.button.disabled, false);
  assert.equal(check.button.textContent, "결제별 출력 (은행 개별)");
}
const blocked = printContext({ blocked: true });
await blocked.context.run();
assert.ok(blocked.alerts.length > 0);
assert.ok(!blocked.events.includes("query"));
assert.equal(blocked.button.disabled, false);
const doubleClick = printContext({ disabled: true });
await doubleClick.context.run();
assert.equal(doubleClick.events.length, 0, "an already-running action must not open another report");

for (const options of [{ fromDate: "" }, { fromDate: "2026-11-07", toDate: "2026-11-06" }, { fromDate: "2026-02-30" }]) {
  const invalid = printContext(options);
  await invalid.context.run();
  assert.ok(invalid.alerts.length > 0, "invalid date ranges must be rejected rather than printed");
  assert.ok(!invalid.events.includes("query"));
}

console.log("Payment-group print model and UI regression passed.");
