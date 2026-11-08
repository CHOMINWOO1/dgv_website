import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const admin = await readFile(path.join(projectRoot, "admin.html"), "utf8");

assert.match(
  admin,
  /<button class="btn" id="bankPrintRangeBtn"[^>]*>[\s\S]*?<\/button>\s*<button class="btn" id="bankExcelRangeBtn"[^>]*>/,
  "payment-group exports remain available in the range toolbar",
);
assert.match(admin, /<script src="assets\/admin-tax-report\.js"><\/script>/);
assert.doesNotMatch(admin, /id="tax(?:Print|Excel)RangeBtn"/);
assert.doesNotMatch(admin, /getElementById\("tax(?:Print|Excel)RangeBtn"\)\.addEventListener/);
assert.match(admin, /<button class="btn" id="printRangeBtn">전체 출력<\/button>\s*<button class="btn" id="excelRangeBtn">엑셀 출력<\/button>/, "ordinary print and Excel buttons must remain available");
assert.match(admin, /menu_items\(ko_name,vi_name,type,qr_category\)/);

const taxBlockStart = admin.indexOf("function buildTaxReportModel");
const deleteStart = admin.indexOf("function openDeleteModal", taxBlockStart);
assert.ok(taxBlockStart > 0 && deleteStart > taxBlockStart, "tax export block must be present");
const taxBlock = admin.slice(taxBlockStart, deleteStart);
assert.doesNotMatch(taxBlock, /\.(?:insert|update|upsert|delete|rpc)\s*\(/, "tax exports must remain read-only");
assert.match(taxBlock, /BẢNG KÊ DOANH THU GTGT/);
assert.match(taxBlock, /CÔNG TY TNHH DGV/);
assert.match(taxBlock, /5801416898/);
assert.match(taxBlock, /window\.open\([\s\S]*?await loadTaxRangeReportData\(\)/, "print window must open before the async read");
assert.match(admin, /T00:00:00\+07:00/);
assert.match(admin, /exclusiveTo:true/);
assert.match(admin, /rangeOverride\?\.exclusiveTo[\s\S]*?query\.lt\(column, toIso\)/, "tax range must use an exclusive Vietnam-time end boundary");
assert.match(taxBlock, /group\.labelKo[\s\S]*group\.labelVi/);
assert.match(taxBlock, /group\.netAmount[\s\S]*group\.vatAmount[\s\S]*group\.grossAmount/);

const taxRangeStart = admin.indexOf("function addDaysToIsoDate");
const taxRangeEnd = admin.indexOf("function buildTaxReportModel", taxRangeStart);
let capturedRange = null;
const rangeContext = {
  Date,
  currentRange: { from:new Date("2026-01-01"), to:new Date("2026-01-01") },
  toISODate: () => "2026-01-01",
  document: {
    getElementById(id) {
      return { value:id === "fromDate" ? "2026-10-22" : "2026-10-22" };
    },
  },
  loadRangeReportData: async (options) => {
    capturedRange = options;
    return { rangeText:options.rangeText };
  },
};
vm.runInNewContext(
  `${admin.slice(taxRangeStart, taxRangeEnd)}\nthis.loadTaxRangeReportDataForTest=loadTaxRangeReportData;`,
  rangeContext,
);
const boundedReport = await rangeContext.loadTaxRangeReportDataForTest();
assert.equal(capturedRange.rangeFrom.toISOString(), "2026-10-21T17:00:00.000Z");
assert.equal(capturedRange.rangeTo.toISOString(), "2026-10-22T17:00:00.000Z");
assert.equal(capturedRange.exclusiveTo, true);
assert.equal(boundedReport.rangeText, "2026-10-22 ~ 2026-10-22");
assert.equal(boundedReport.taxFromDate, "2026-10-22");
assert.equal(boundedReport.taxToDate, "2026-10-22");

const printStart = admin.indexOf("function taxReportPrintHtml");
const printEnd = admin.indexOf("async function printTaxOfficeReport", printStart);
const workbookStart = admin.indexOf("function taxWorkbookOptions");
const workbookEnd = admin.indexOf("async function exportTaxOfficeExcel", workbookStart);
assert.ok(printStart > 0 && printEnd > printStart && workbookStart > printEnd && workbookEnd > workbookStart);

const context = {
  DGV: {
    escapeHTML(value) {
      return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    },
  },
  fmtInt: (value) => Math.round(Number(value) || 0).toLocaleString("en-US"),
  toISODate: (value) => new Date(value).toISOString().slice(0, 10),
  Date,
  String,
  Number,
  Math,
};
vm.runInNewContext(
  `${admin.slice(printStart, printEnd)}\n${admin.slice(workbookStart, workbookEnd)}\n` +
    "this.taxReportPrintHtmlForTest=taxReportPrintHtml;this.taxWorkbookOptionsForTest=taxWorkbookOptions;",
  context,
);

const report = {
  rangeText: "2026-10-22 ~ 2026-10-22",
  taxFromDate: "2026-10-22",
  taxToDate: "2026-10-22",
  rangeFrom: new Date("2026-10-22T00:00:00+07:00"),
  rangeTo: new Date("2026-10-22T23:59:59+07:00"),
  generatedAt: new Date("2026-10-23T10:00:00+07:00"),
};
const model = {
  paidOrderCount: 2,
  paidOrderGross: 5_730_000,
  reconciliationDifference: 0,
  warnings: ["<확인> 항목"],
  groups: [
    {
      key: "food8", rate: 8, labelKo: "식당", labelVi: "Món ăn",
      netAmount: 4_444_440, vatAmount: 355_560, grossAmount: 4_800_000,
      rows: [{
        paymentLabel: "현금 / Tiền mặt", koName: "<무한삼겹>", viName: "Thịt nướng buffet", unitVi: "Phần",
        qty: 24, netUnit: 185_185, netAmount: 4_444_440,
        vatAmount: 355_560, grossAmount: 4_800_000,
        reviewNeeded: false, reviewReason: "",
      }],
    },
    {
      key: "drink10", rate: 10, labelKo: "음료·주류", labelVi: "Đồ uống / Rượu bia",
      netAmount: 845_448, vatAmount: 84_552, grossAmount: 930_000,
      rows: [
        {
          paymentLabel: "카드 / Thẻ", koName: "맥주", viName: "Bia", unitVi: "Lon",
          qty: 13, netUnit: 45_454, netAmount: 590_902,
          vatAmount: 59_098, grossAmount: 650_000,
          reviewNeeded: false, reviewReason: "",
        },
        {
          paymentLabel: "은행 / Chuyển khoản", koName: "임시", viName: "Món tạm", unitVi: "Chai",
          qty: 1, netUnit: 227_273, netAmount: 227_273,
          vatAmount: 22_727, grossAmount: 250_000,
          reviewNeeded: true, reviewReason: "확인 필요",
        },
        {
          koName: "음료", viName: "Nước ngọt", unitVi: "Lon",
          qty: 1, netUnit: 27_273, netAmount: 27_273,
          vatAmount: 2_727, grossAmount: 30_000,
          reviewNeeded: false, reviewReason: "",
        },
      ],
    },
  ],
};

const modelBeforePrint = JSON.stringify(model);
const workbookBeforePrint = context.taxWorkbookOptionsForTest(report, model);
const printHtml = context.taxReportPrintHtmlForTest(report, model);
assert.equal(JSON.stringify(model), modelBeforePrint, "printing must not mutate sales or VAT amounts");
assert.equal((printHtml.match(/class="taxPage"/g) || []).length, 2, "8% and 10% must print on separate pages");
assert.match(printHtml, /VAT 8%/);
assert.match(printHtml, /VAT 10%/);
assert.match(printHtml, /4,444,440/);
assert.match(printHtml, /355,560/);
assert.match(printHtml, /845,448/);
assert.match(printHtml, /84,552/);
assert.match(printHtml, /&lt;무한삼겹&gt;/);
assert.doesNotMatch(printHtml, /<무한삼겹>/, "menu names must be HTML escaped");
assert.match(printHtml, /&lt;확인&gt; 항목/);

function cellsFromRow(rowHtml) {
  return Array.from(rowHtml.matchAll(/<(th|td)\b([^>]*)>([\s\S]*?)<\/\1>/g), (match) => ({
    span: Number(match[2].match(/colspan="(\d+)"/)?.[1] || 1),
    text: match[3].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
  }));
}

function assertPrintedAmounts(html, reportModel) {
  const tables = Array.from(html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/g), (match) => match[1]);
  assert.equal(tables.length, reportModel.groups.length);
  tables.forEach((table, groupIndex) => {
    const group = reportModel.groups[groupIndex];
    assert.equal((table.match(/<col\b/g) || []).length, 8, "print layout must define all eight columns");
    const heading = cellsFromRow(table.match(/<thead>([\s\S]*?)<\/thead>/)[1]);
    assert.equal(heading.length, 8, "VAT-inclusive amount must have its own column");
    assert.match(heading[7].text, /VAT/);
    assert.match(heading[7].text, /VAT 포함 금액/);
    assert.match(heading[7].text, /Thành tiền có VAT/);
    const body = table.match(/<tbody>([\s\S]*?)<\/tbody>/)[1];
    const rows = Array.from(body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g), (match) => cellsFromRow(match[1]));
    if (group.rows.length) {
      assert.equal(rows.length, group.rows.length);
      rows.forEach((cells, rowIndex) => {
        const source = group.rows[rowIndex];
        assert.equal(cells.length, 8);
        assert.equal(cells[4].text, context.fmtInt(source.qty));
        assert.equal(cells[5].text, context.fmtInt(source.netUnit), "existing net unit price must be unchanged");
        assert.equal(cells[6].text, context.fmtInt(source.netAmount), "existing supply amount must be unchanged");
        assert.equal(cells[7].text, context.fmtInt(source.grossAmount), "gross must use the recorded sale, not rounded net multiplied by VAT");
      });
    } else {
      assert.equal(rows.length, 1);
      assert.equal(rows[0].length, 1);
      assert.equal(rows[0][0].span, 8, "empty-state message must span the added column too");
    }
    const footer = table.match(/<tfoot>([\s\S]*?)<\/tfoot>/)[1];
    const footerRows = Array.from(footer.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g), (match) => cellsFromRow(match[1]));
    assert.equal(footerRows.length, 3);
    footerRows.forEach((cells) => assert.equal(cells.reduce((count, cell) => count + cell.span, 0), 8, "footer colspan must match the eight-column table"));
    const footerColumns = footerRows.map((cells) => cells.flatMap((cell) => Array(cell.span).fill(cell.text)));
    assert.equal(footerColumns[0][6], context.fmtInt(group.netAmount), "net subtotal must stay under the supply-amount column");
    assert.equal(footerColumns[1][6], context.fmtInt(group.vatAmount), "VAT subtotal must retain its existing alignment");
    assert.equal(footerColumns[0][7], "");
    assert.equal(footerColumns[1][7], "");
    assert.equal(footerColumns[2][7], context.fmtInt(group.grossAmount), "gross total must align with the new gross-amount column");
    [group.netAmount, group.vatAmount, group.grossAmount].forEach((amount, index) => {
      assert.ok(footerRows[index].some((cell) => cell.text === context.fmtInt(amount)), "supply/VAT/payment totals must remain unchanged");
    });
  });
}

assertPrintedAmounts(printHtml, model);

// Reproduce the supplied November 6 food summary using the existing calculation engine.
// In particular, 1,814,806 * 1.08 rounds to 1,959,990, not the recorded 1,960,000.
const taxSource = await readFile(path.join(projectRoot, "assets/admin-tax-report.js"), "utf8");
const taxContext = { Map, Set, Object, Array, Number, String, Boolean, Math, JSON };
vm.runInNewContext(taxSource, taxContext);
const foodExamples = [
  { id: "noodles", ko_name: "냉면", vi_name: "Mì lạnh", qty: 1, unit_vnd: 200_000, line_vnd: 200_000, payment_method: "cash" },
  { id: "soup", ko_name: "돼지국밥", vi_name: "Canh thịt heo & cơm", qty: 1, unit_vnd: 200_000, line_vnd: 200_000, payment_method: "bank" },
  { id: "buffet", ko_name: "무한삼겹", vi_name: "Thịt nướng buffet", qty: 24, unit_vnd: 200_000, line_vnd: 4_800_000, payment_method: "cash" },
  { id: "pork", ko_name: "제육쌈밥", vi_name: "Heo xào", qty: 14, unit_vnd: 140_000, line_vnd: 1_960_000, payment_method: "bank" },
];
const exampleModel = taxContext.DGV_TAX_REPORT.buildReport({
  visibleOrders: foodExamples.map((item) => ({ id: item.id, status: "paid", total_vnd: item.line_vnd, payment_method: item.payment_method })),
  linesByOrder: new Map(foodExamples.map((item) => [item.id, [{ ...item, order_id: item.id, kind: "food", line_source: "order_items" }]])),
});
const exampleFood = exampleModel.groups.find((group) => group.key === "food8");
assert.deepEqual(
  { net: exampleFood.netAmount, vat: exampleFood.vatAmount, gross: exampleFood.grossAmount },
  { net: 6_629_616, vat: 530_384, gross: 7_160_000 },
  "adding a print column must preserve the supplied summary's original totals",
);
assert.deepEqual(Array.from(exampleFood.rows, (row) => row.grossAmount).sort((a, b) => a - b), [200_000, 200_000, 1_960_000, 4_800_000]);
assert.notEqual(Math.round(exampleFood.rows.find((row) => row.koName === "제육쌈밥").netAmount * 1.08), 1_960_000);
assertPrintedAmounts(context.taxReportPrintHtmlForTest(report, exampleModel), exampleModel);
const emptyModel = { ...model, groups: model.groups.map((group) => ({ ...group, rows: [], netAmount: 0, vatAmount: 0, grossAmount: 0 })) };
assertPrintedAmounts(context.taxReportPrintHtmlForTest(report, emptyModel), emptyModel);

const workbook = context.taxWorkbookOptionsForTest(report, model);
assert.equal(JSON.stringify(workbook), JSON.stringify(workbookBeforePrint), "print rendering must leave Excel options unchanged");
assert.equal(workbook.filename, "HANA_Tax_2026-10-22_2026-10-22.xlsx");
assert.deepEqual(Array.from(workbook.sheets, (sheet) => sheet.name), ["요약", "식당 8%", "음료·주류 10%"]);
assert.equal(workbook.sheets[1].rows[4][5].value, 185_185);
assert.equal(workbook.sheets[1].rows[4][6].value, 4_444_440);
assert.equal(workbook.sheets[1].rows[4][8].value, 4_800_000, "Excel's existing gross column must stay in place");
assert.equal(workbook.sheets[2].rows[4][5].value, 45_454);
assert.equal(workbook.sheets[2].rows[4][6].value, 590_902);
assert.equal(workbook.sheets[2].rows[4][8].value, 650_000);
assert.equal(workbook.sheets[0].rows[8][4].value, 5_730_000);

const xlsxSource = await readFile(path.join(projectRoot, "assets/dgv-xlsx.js"), "utf8");
class FixedZipDate extends Date {
  constructor(...args) {
    super(...(args.length ? args : ["2026-11-06T12:00:00Z"]));
  }
}
const xlsxContext = {
  TextEncoder, Uint8Array, Uint32Array, DataView, Date: FixedZipDate,
  Object, Number, String, Math, Set, Error,
};
vm.runInNewContext(xlsxSource, xlsxContext);
const workbookBytes = xlsxContext.DGV_XLSX.buildWorkbookBytes(workbook);
assert.equal(workbookBytes[0], 0x50);
assert.equal(workbookBytes[1], 0x4b, "tax workbook must be a valid ZIP-based XLSX package");
assert.deepEqual(workbookBytes, xlsxContext.DGV_XLSX.buildWorkbookBytes(workbookBeforePrint), "Excel bytes must remain identical before and after print rendering");
assert.match(printHtml,/현금 \/ Tiền mặt/);
assert.match(printHtml,/카드 \/ Thẻ/);
assert.match(printHtml,/은행 \/ Chuyển khoản/);
assert.doesNotMatch(printHtml,/TM\/CK/);
assert.equal(workbook.sheets[1].rows[4][10].value,"현금 / Tiền mặt");
assert.equal(workbook.sheets[2].rows[4][10].value,"카드 / Thẻ");
assert.equal(workbook.sheets[2].rows[5][10].value,"은행 / Chuyển khoản");
assert.equal(workbook.sheets[1].autoFilterRange,"A4:K5");

console.log("Admin tax print and Excel integration regression passed.");

