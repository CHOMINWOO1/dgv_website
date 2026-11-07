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
const scope = { Date, Intl, Map, Set, Object, Array, Number, String, Boolean, Math, JSON, TextEncoder, Uint8Array, Uint32Array, DataView };
vm.runInNewContext(source, scope);
vm.runInNewContext(await readFile(path.join(root, "assets/dgv-xlsx.js"), "utf8"), scope);
const api = scope.DGV_BANK_REPORT;
assert.equal(typeof api?.buildReport, "function");
assert.equal(typeof api?.renderHtml, "function");
assert.equal(typeof api?.workbookOptions, "function");

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
const sections = (html, className) => Array.from(html.matchAll(/<section\b[^>]*class="([^"]*)"[^>]*>[\s\S]*?<\/section>/g))
  .filter(match => match[1].split(/\s+/).includes(className)).map(match => match[0]);
const input = fixture();
const before = serialize(input);
const model = api.buildReport(input);
assert.equal(serialize(input), before, "building the print model must not mutate orders or item snapshots");
assert.equal(model.orderCount, 7, "all paid, non-excluded bank/cash/card orders belong in the report");
assert.equal(model.bankOrderCount, 5);
assert.equal(model.sectionCount, 7, "five bank orders plus separate cash and card groups need seven sections");
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
assert.equal(sections(html, "reportSection").length, 7);
assert.equal(sections(html, "otherOrders").length, 2, "cash and card need separate printable aggregate groups");
assert.equal(sections(html, "cashOrders").length, 1);
assert.equal(sections(html, "cardOrders").length, 1);
const cashSection = sections(html, "cashOrders")[0];
const cardSection = sections(html, "cardOrders")[0];
assert.match(cashSection, /order-cash/);
assert.match(cashSection, /현금 메뉴/);
assert.match(cashSection, /240,000/);
assert.doesNotMatch(cashSection, /order-card|카드 메뉴|480,000/);
assert.match(cardSection, /order-card/);
assert.match(cardSection, /카드 메뉴/);
assert.match(cardSection, /240,000/);
assert.doesNotMatch(cardSection, /order-cash|현금 메뉴|480,000/);
assert.ok(html.indexOf(cashSection) > html.lastIndexOf('class="reportSection bankOrder"'));
assert.ok(html.indexOf(cardSection) > html.indexOf(cashSection), "print order is bank orders, cash aggregate, then card aggregate");
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
assert.equal(cashCardOnly.sectionCount, 2);
assert.equal(cashCardOnly.grossAmount, 480_000);
assert.equal(sections(api.renderHtml(cashCardOnly), "reportSection").length, 2);
for (const method of ["cash", "card"]) {
  const singleMethodInput = fixture();
  singleMethodInput.visibleOrders = singleMethodInput.visibleOrders.filter(order => order.payment_method === method);
  const singleMethod = api.buildReport(singleMethodInput);
  const singleMethodHtml = api.renderHtml(singleMethod);
  assert.equal(singleMethod.orderCount, 1);
  assert.equal(singleMethod.sectionCount, 1, `${method}-only ranges need one aggregate section`);
  assert.equal(singleMethod.grossAmount, 240_000);
  assert.equal(sections(singleMethodHtml, "bankOrder").length, 0);
  assert.equal(sections(singleMethodHtml, "otherOrders").length, 1);
  assert.equal(sections(singleMethodHtml, method + "Orders").length, 1);
  assert.equal(sections(singleMethodHtml, (method === "cash" ? "card" : "cash") + "Orders").length, 0);
}
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
  { ...input.visibleOrders[0], id: "card-b", payment_method: " CARD ", total_vnd: 100_000 },
];
aggregateInput.linesByOrder = new Map([
  ["cash-a", [{ ko_name: "반복 메뉴", vi_name: "Cùng món", qty: 1, unit_vnd: 50_000, line_vnd: 50_000 }]],
  ["cash-b", [{ ko_name: "반복 메뉴", vi_name: "Cùng món", qty: 2, unit_vnd: 50_000, line_vnd: 100_000 }]],
  ["cash-c", [{ ko_name: "반복 메뉴", vi_name: "Cùng món", qty: 1, unit_vnd: 60_000, line_vnd: 60_000 }]],
  ["card-a", [{ ko_name: "반복 메뉴", vi_name: "Cùng món", qty: 1, unit_vnd: 50_000, line_vnd: 50_000 }]],
  ["card-b", [{ ko_name: "반복 메뉴", vi_name: "Cùng món", qty: 2, unit_vnd: 50_000, line_vnd: 100_000 }]],
]);
const aggregateBefore = serialize(aggregateInput);
const aggregateModel = api.buildReport(aggregateInput);
const aggregateHtml = api.renderHtml(aggregateModel);
assert.equal(serialize(aggregateInput), aggregateBefore);
assert.equal(aggregateModel.grossAmount, 360_000);
assert.equal(aggregateModel.orderCount, 5);
assert.equal(aggregateModel.sectionCount, 2, "multiple cash and card orders still produce only two aggregate sections");
const aggregateCash = sections(aggregateHtml, "cashOrders")[0];
const aggregateCard = sections(aggregateHtml, "cardOrders")[0];
const itemBody = section => section.match(/<table class="items">[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/)?.[1];
const aggregateCashBody = itemBody(aggregateCash);
const aggregateCardBody = itemBody(aggregateCard);
assert.ok(aggregateCashBody);
assert.ok(aggregateCardBody);
assert.equal((aggregateCashBody.match(/<tr>/g) || []).length, 2, "same-price cash lines merge but historical price differences remain distinct");
assert.equal((aggregateCardBody.match(/<tr>/g) || []).length, 1, "same-price card lines aggregate independently from matching cash menus");
for (const body of [aggregateCashBody, aggregateCardBody]) {
  assert.match(body, /<td class="number">3<\/td>\s*<td class="number">50,000<\/td>\s*<td class="number">150,000<\/td>/);
  assert.doesNotMatch(body, /<td class="number">6<\/td>/, "identical cash/card menus must never combine across payment methods");
}
assert.match(aggregateCash, /210,000 VND/);
assert.match(aggregateCard, /150,000 VND/);
assert.doesNotMatch(aggregateCash, /card-a|card-b/);
assert.doesNotMatch(aggregateCard, /cash-a|cash-b|cash-c|210,000/);
assert.equal(sections(aggregateHtml, "cashOrders").length, 1);
assert.equal(sections(aggregateHtml, "cardOrders").length, 1);

const differenceInput = fixture();
differenceInput.visibleOrders = [
  { ...input.visibleOrders[0], id: "cash-difference", payment_method: "cash", total_vnd: 90_000 },
  { ...input.visibleOrders[0], id: "card-difference", payment_method: "card", total_vnd: 210_000 },
];
differenceInput.linesByOrder = new Map([
  ["cash-difference", [{ ko_name: "현금 차액 메뉴", qty: 1, unit_vnd: 100_000, line_vnd: 100_000 }]],
  ["card-difference", [{ ko_name: "카드 차액 메뉴", qty: 1, unit_vnd: 200_000, line_vnd: 200_000 }]],
]);
const differenceBefore = serialize(differenceInput);
const differenceModel = api.buildReport(differenceInput);
const differenceHtml = api.renderHtml(differenceModel);
assert.equal(serialize(differenceInput), differenceBefore);
assert.equal(differenceModel.grossAmount, 300_000);
assert.match(sections(differenceHtml, "cashOrders")[0], /-10,000|−10,000/);
assert.match(sections(differenceHtml, "cardOrders")[0], /10,000/);
assert.match(sections(differenceHtml, "cashOrders")[0], /90,000 VND/);
assert.match(sections(differenceHtml, "cardOrders")[0], /210,000 VND/);
assert.match(sections(differenceHtml, "cashOrders")[0], /확인 필요/);
assert.match(sections(differenceHtml, "cardOrders")[0], /확인 필요/);

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

const partialInput = fixture();
partialInput.visibleOrders = [
  { ...input.visibleOrders[0], id: "cash-known", payment_method: "cash", total_vnd: 100_000 },
  { ...input.visibleOrders[0], id: "card-unknown", payment_method: "card", total_vnd: null },
];
partialInput.linesByOrder = new Map([["cash-known", [{ ko_name: "확인된 현금", qty: 1, unit_vnd: 100_000, line_vnd: 100_000 }]]]);
const partialModel = api.buildReport(partialInput);
const partialHtml = api.renderHtml(partialModel);
assert.equal(partialModel.grossAmount, null);
assert.equal(partialModel.otherGrossAmount, null);
assert.equal(partialModel.sectionCount, 2);
assert.match(sections(partialHtml, "cashOrders")[0], /100,000 VND/);
assert.match(sections(partialHtml, "cardOrders")[0], /확인 필요/);
assert.doesNotMatch(sections(partialHtml, "cardOrders")[0], /100,000/, "unknown card totals must not inherit the cash aggregate amount");

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
assert.equal(success.events.filter(event => event === "query").length, 1, "separating payment groups must not re-fetch the same range per group");
assert.equal(success.events.filter(event => event === "print").length, 1, "font readiness and fallback timers must not open duplicate print dialogs");
const otherOnlyPrint = printContext({ result: cashCardOnly });
await otherOnlyPrint.context.run();
await Promise.resolve();
assert.equal(otherOnlyPrint.events.filter(event => event === "print").length, 1, "cash/card-only periods must print both separate groups in one dialog");
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

// Exercise the production XLSX writer entirely in memory; never create files or contact a service.
const cellValue = cell => cell && typeof cell === "object" && "value" in cell ? cell.value : cell;
const valuesOf = sheet => Array.from(sheet.rows, row => Array.from(row, cellValue));
const sheetText = sheet => JSON.stringify(valuesOf(sheet));
const totalCell = (sheet, label) => sheet.rows.find(row => cellValue(row[0]) === label)?.[6];
const detailRows = sheet => {
  const rows = valuesOf(sheet), start = rows.findIndex(row => row[0] === "STT / No.") + 1;
  const selected = [];
  for (let index = start; index < rows.length && typeof rows[index][0] === "number"; index++) selected.push(rows[index]);
  return selected;
};
const workbook = api.workbookOptions(model);
assert.equal(serialize(model), modelBefore, "Excel generation must leave print model and original order snapshots unchanged");
assert.equal(workbook.sheets.length, 7);
assert.equal(new Set(Array.from(workbook.sheets, sheet => sheet.name.toLowerCase())).size, 7);
assert.deepEqual(Array.from(workbook.sheets.slice(-2), sheet => sheet.name), ["현금 Tiền mặt", "카드 Thẻ"]);
assert.match(workbook.filename, /^HANA_Payments_2026-11-06_2026-11-06\.xlsx$/);
for (const [index, order] of model.orders.entries()) {
  const sheet = workbook.sheets[index];
  assert.equal(sheet.name, `은행 ${String(index + 1).padStart(3, "0")}`);
  assert.ok(sheetText(sheet).includes(order.id));
  assert.equal(totalCell(sheet, "결제 총액 (VAT 포함) / Tổng thanh toán (có VAT)").value, order.grossAmount);
  assert.equal(totalCell(sheet, "주문-메뉴 차액 / Chênh lệch đơn hàng-chi tiết").value, order.difference);
  assert.equal(detailRows(sheet).length, order.lines.length);
  order.lines.forEach((line, lineIndex) => {
    const values = detailRows(sheet)[lineIndex];
    assert.equal(values[1], line.koName);
    assert.equal(values[2], line.viName);
    assert.equal(values[4], line.qty);
    assert.equal(values[5], line.unitAmount);
    assert.equal(values[6], line.grossAmount);
  });
}
for (const sheet of workbook.sheets) {
  assert.ok(sheet.name.length <= 31);
  assert.doesNotMatch(sheet.name, /[\\/:?*\[\]]/);
  assert.ok(sheetText(sheet).includes(input.rangeText));
  assert.match(sheetText(sheet), /실제 은행 입금 확인|xác nhận tiền thực nhận/);
  assert.match(sheetText(sheet), /전자세금계산서 원본|hóa đơn điện tử gốc/);
  for (const row of detailRows(sheet)) for (const index of [0, 4, 5, 6]) {
    assert.ok(row[index] === null || typeof row[index] === "number", "counts and VND amounts must be numeric cells, not localized strings");
  }
}
const cashSheet = workbook.sheets[5], cardSheet = workbook.sheets[6];
assert.match(sheetText(cashSheet), /order-cash/);
assert.doesNotMatch(sheetText(cashSheet), /order-card|카드 메뉴/);
assert.match(sheetText(cardSheet), /order-card/);
assert.doesNotMatch(sheetText(cardSheet), /order-cash|현금 메뉴/);
assert.equal(totalCell(cashSheet, "결제 총액 (VAT 포함) / Tổng thanh toán (có VAT)").value, 240_000);
assert.equal(totalCell(cardSheet, "결제 총액 (VAT 포함) / Tổng thanh toán (có VAT)").value, 240_000);
const zeroSheet = workbook.sheets[model.orders.findIndex(order => order.id === "order-zero")];
assert.equal(detailRows(zeroSheet)[0][6], 0, "explicit zero price remains numeric zero in Excel");
const unknownWorkbook = api.workbookOptions(unknownModel);
assert.equal(totalCell(unknownWorkbook.sheets[0], "결제 총액 (VAT 포함) / Tổng thanh toán (có VAT)").value, null, "unknown amounts must stay blank, not become zero");
assert.match(sheetText(unknownWorkbook.sheets[0]), /확인 필요/);
const aggregateWorkbook = api.workbookOptions(aggregateModel);
assert.equal(aggregateWorkbook.sheets.length, 2);
assert.equal(detailRows(aggregateWorkbook.sheets[0]).length, 2);
assert.equal(detailRows(aggregateWorkbook.sheets[1]).length, 1);
assert.deepEqual(detailRows(aggregateWorkbook.sheets[0])[0].slice(4), [3, 50_000, 150_000]);
assert.deepEqual(detailRows(aggregateWorkbook.sheets[1])[0].slice(4), [3, 50_000, 150_000]);
assert.equal(totalCell(aggregateWorkbook.sheets[0], "결제 총액 (VAT 포함) / Tổng thanh toán (có VAT)").value, 210_000);
assert.equal(totalCell(aggregateWorkbook.sheets[1], "결제 총액 (VAT 포함) / Tổng thanh toán (có VAT)").value, 150_000);
for (const method of ["cash", "card"]) {
  const selected = api.buildReport({ ...fixture(), visibleOrders: input.visibleOrders.filter(order => order.payment_method === method) });
  assert.equal(api.workbookOptions(selected).sheets.length, 1);
}
assert.equal(api.workbookOptions(bankOnly).sheets.length, 5);
assert.throws(() => api.workbookOptions(emptyModel), error => error.code === "PAYMENT_XLSX_EMPTY");
const many = { ...model, orders: Array.from({ length: 255 }, () => mixed), otherOrders: [] };
assert.equal(api.workbookOptions(many).sheets.length, 255);
assert.throws(() => api.workbookOptions({ ...many, orders: [...many.orders, mixed] }), error => error.code === "PAYMENT_XLSX_SHEET_LIMIT");

function storedZip(bytes) {
  const zip = Buffer.from(bytes), entries = new Map();
  for (let offset = 0; offset + 30 < zip.length && zip.readUInt32LE(offset) === 0x04034b50;) {
    const size = zip.readUInt32LE(offset + 18), nameLength = zip.readUInt16LE(offset + 26), extraLength = zip.readUInt16LE(offset + 28);
    assert.equal(zip.readUInt16LE(offset + 8), 0, "use the existing exporter's stored ZIP format");
    const dataStart = offset + 30 + nameLength + extraLength;
    entries.set(zip.subarray(offset + 30, offset + 30 + nameLength).toString("utf8"), zip.subarray(dataStart, dataStart + size).toString("utf8"));
    offset = dataStart + size;
  }
  return entries;
}
const archive = storedZip(scope.DGV_XLSX.buildWorkbookBytes(workbook));
assert.equal(Array.from(archive.keys()).filter(name => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).length, 7);
assert.equal((archive.get("xl/workbook.xml").match(/<sheet\s/g) || []).length, 7);
const mixedIndex = model.orders.findIndex(order => order.id === mixed.id);
const mixedSheet = workbook.sheets[mixedIndex], mixedXml = archive.get(`xl/worksheets/sheet${mixedIndex + 1}.xml`);
const firstLineNumber = mixedSheet.rows.findIndex(row => cellValue(row[0]) === "STT / No.") + 2;
assert.match(mixedXml, new RegExp(`<c r="G${firstLineNumber}" s="2"><v>200000<\\/v><\\/c>`));
assert.match(mixedXml, /Nước ép ổi/);
assert.match(mixedXml, /00:05/, "Excel uses Vietnam order date/time too");
const formulaInput = fixture();
formulaInput.visibleOrders = [{ ...input.visibleOrders[0], id: '=HYPERLINK("https://example.invalid")', total_vnd: 4_000, guide_name: '+SUM(1,2)', team_no: '@A1' }];
formulaInput.linesByOrder = new Map([[formulaInput.visibleOrders[0].id,
  ['=1+1', '+SUM(1,2)', '-2+1', '@SUM(A1)'].map(name => ({ ko_name: name, vi_name: '<img onerror="x"> & Tiếng Việt', qty: 1, unit_vnd: 1_000, line_vnd: 1_000 }))]]);
const formulaModel = api.buildReport(formulaInput), formulaBefore = serialize(formulaModel);
const formulaArchive = storedZip(scope.DGV_XLSX.buildWorkbookBytes(api.workbookOptions(formulaModel)));
const formulaXml = formulaArchive.get('xl/worksheets/sheet1.xml');
assert.equal(serialize(formulaModel), formulaBefore);
assert.doesNotMatch(formulaXml, /<f\b|<hyperlink\b|<img\b/);
assert.match(formulaXml, /t="inlineStr"[\s\S]*?=1\+1/);
assert.match(formulaXml, /HYPERLINK/);
assert.match(formulaXml, /&lt;img/);
assert.match(formulaXml, /Tiếng Việt/);
assert.equal(Array.from(formulaArchive.keys()).some(name => /externalLinks/.test(name)), false);

assert.match(admin, /id="bankExcelRangeBtn"/);
assert.match(admin, /getElementById\("bankExcelRangeBtn"\)\.addEventListener\("click",\s*exportPaymentExcel\)/);
assert.match(admin, /getElementById\("excelRangeBtn"\)\.addEventListener\("click",\s*exportRangeExcel\)/, "existing ordinary Excel output stays wired");
assert.match(admin, /getElementById\("taxExcelRangeBtn"\)\.addEventListener\("click",\s*exportTaxOfficeExcel\)/, "existing tax Excel output stays wired");
const exportStart = admin.indexOf("async function exportPaymentExcel(");
assert.ok(exportStart > 0);
const exportTail = admin.slice(exportStart), exportEnd = exportTail.indexOf("\n    }\n");
assert.ok(exportEnd > 0);
const exportSource = exportTail.slice(0, exportEnd + 6);
assert.doesNotMatch(exportSource, /\.(?:insert|update|upsert|delete|rpc)\s*\(/);
assert.match(exportSource, /loadTaxRangeReportData\(/);
function exportContext({ selectedModel = model, readError = null, downloadError = null, buildError = null,
  missingExporter = false, fromDate = "2026-11-06", toDate = "2026-11-06", disabled = false } = {}) {
  const events = [], alerts = [], downloads = [];
  const button = { disabled, textContent: "결제별 엑셀" };
  const inputs = { fromDate: { value: fromDate }, toDate: { value: toDate } };
  const context = {
    Date, String, Number, Error,
    document: { getElementById: id => id === "bankExcelRangeBtn" ? button : inputs[id] },
    window: {
      open: () => assert.fail("Excel must download without opening another window"),
      DGV_BANK_REPORT: { buildReport: () => selectedModel, workbookOptions: value => { if (buildError) throw buildError; return api.workbookOptions(value); } },
      DGV_XLSX: missingExporter ? null : { downloadWorkbook: options => { events.push("download"); if (downloadError) throw downloadError; downloads.push(options); } },
    },
    loadTaxRangeReportData: async () => { events.push(["query", inputs.fromDate.value, inputs.toDate.value]); if (readError) throw readError; return fixture(); },
    alert: message => alerts.push(message), console: { error() {} },
  };
  vm.runInNewContext(`${exportSource}\nthis.run=exportPaymentExcel;`, context);
  return { context, events, alerts, downloads, button };
}
const exported = exportContext();
await exported.context.run();
assert.equal(exported.downloads.length, 1);
assert.equal(exported.downloads[0].sheets.length, 7);
assert.deepEqual(exported.events.filter(event => Array.isArray(event)), [["query", "2026-11-06", "2026-11-06"]]);
assert.equal(exported.alerts.length, 0);
assert.equal(exported.button.disabled, false);
assert.equal(exported.button.textContent, "결제별 엑셀");
for (const options of [{ selectedModel: emptyModel }, { readError: new Error("read failure") }, { downloadError: new Error("download failure") },
  { missingExporter: true }, { buildError: Object.assign(new Error("limit"), { code: "PAYMENT_XLSX_SHEET_LIMIT" }) }]) {
  const check = exportContext(options); await check.context.run();
  assert.equal(check.downloads.length, 0);
  assert.ok(check.alerts.length > 0);
  assert.equal(check.button.disabled, false);
  assert.equal(check.button.textContent, "결제별 엑셀");
}
for (const options of [{ fromDate: "" }, { fromDate: "2026-02-30" }, { fromDate: "2026-11-08", toDate: "2026-11-06" }]) {
  const check = exportContext(options); await check.context.run();
  assert.equal(check.events.length, 0);
  assert.ok(check.alerts.length > 0);
}
const alreadyExporting = exportContext({ disabled: true }); await alreadyExporting.context.run();
assert.equal(alreadyExporting.events.length, 0);
assert.equal(alreadyExporting.downloads.length, 0);
console.log("Payment-group print/XLSX model, safe numeric workbook and single-download UI regression passed.");
