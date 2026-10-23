import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const admin = await readFile(path.join(projectRoot, "admin.html"), "utf8");

assert.match(
  admin,
  /<button class="btn" id="printRangeBtn">전체 출력<\/button>\s*<button class="btn" id="excelRangeBtn">엑셀 출력<\/button>\s*<button class="btn" id="taxPrintRangeBtn">세무서 출력<\/button>\s*<button class="btn" id="taxExcelRangeBtn">세무서 엑셀 출력<\/button>/,
  "tax buttons must sit beside the existing range exports",
);
assert.match(admin, /<script src="assets\/admin-tax-report\.js"><\/script>/);
assert.match(admin, /getElementById\("taxPrintRangeBtn"\)\.addEventListener\("click", printTaxOfficeReport\)/);
assert.match(admin, /getElementById\("taxExcelRangeBtn"\)\.addEventListener\("click", exportTaxOfficeExcel\)/);
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
        koName: "<무한삼겹>", viName: "Thịt nướng buffet", unitVi: "Phần",
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
          koName: "맥주", viName: "Bia", unitVi: "Lon",
          qty: 13, netUnit: 45_454, netAmount: 590_902,
          vatAmount: 59_098, grossAmount: 650_000,
          reviewNeeded: false, reviewReason: "",
        },
        {
          koName: "임시", viName: "Món tạm", unitVi: "Chai",
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

const printHtml = context.taxReportPrintHtmlForTest(report, model);
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

const workbook = context.taxWorkbookOptionsForTest(report, model);
assert.equal(workbook.filename, "HANA_Tax_2026-10-22_2026-10-22.xlsx");
assert.deepEqual(Array.from(workbook.sheets, (sheet) => sheet.name), ["요약", "식당 8%", "음료·주류 10%"]);
assert.equal(workbook.sheets[1].rows[4][5].value, 185_185);
assert.equal(workbook.sheets[1].rows[4][6].value, 4_444_440);
assert.equal(workbook.sheets[2].rows[4][5].value, 45_454);
assert.equal(workbook.sheets[2].rows[4][6].value, 590_902);
assert.equal(workbook.sheets[0].rows[8][4].value, 5_730_000);

const xlsxSource = await readFile(path.join(projectRoot, "assets/dgv-xlsx.js"), "utf8");
const xlsxContext = {
  TextEncoder, Uint8Array, Uint32Array, DataView, Date,
  Object, Number, String, Math, Set, Error,
};
vm.runInNewContext(xlsxSource, xlsxContext);
const workbookBytes = xlsxContext.DGV_XLSX.buildWorkbookBytes(workbook);
assert.equal(workbookBytes[0], 0x50);
assert.equal(workbookBytes[1], 0x4b, "tax workbook must be a valid ZIP-based XLSX package");

console.log("Admin tax print and Excel integration regression passed.");


