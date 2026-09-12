import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { TextDecoder, TextEncoder } from "node:util";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exporterSource = await readFile(path.join(projectRoot, "assets/dgv-xlsx.js"), "utf8");

const exporterContext = {
  TextEncoder,
  Uint8Array,
  Uint32Array,
  DataView,
  Date,
  Object,
  Number,
  String,
  Math,
  Set,
  Error,
};
vm.runInNewContext(exporterSource, exporterContext);
const xlsx = exporterContext.DGV_XLSX;
assert.ok(xlsx?.buildWorkbookBytes, "XLSX builder must be exposed");

function independentCrc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

function readStoredZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const entries = new Map();
  let offset = 0;
  while (offset + 30 <= bytes.length && view.getUint32(offset, true) === 0x04034b50) {
    const flags = view.getUint16(offset + 6, true);
    const method = view.getUint16(offset + 8, true);
    const checksum = view.getUint32(offset + 14, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const uncompressedSize = view.getUint32(offset + 22, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    assert.equal(flags & 0x0800, 0x0800, "ZIP filenames must be UTF-8");
    assert.equal(method, 0, "XLSX package must use the tested stored ZIP method");
    assert.equal(compressedSize, uncompressedSize);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = decoder.decode(bytes.slice(nameStart, nameStart + nameLength));
    const data = bytes.slice(dataStart, dataStart + compressedSize);
    assert.equal(independentCrc32(data), checksum, `CRC mismatch for ${name}`);
    entries.set(name, data);
    offset = dataStart + compressedSize;
  }
  assert.equal(new DataView(bytes.buffer, bytes.byteOffset + bytes.length - 22, 22).getUint32(0, true), 0x06054b50);
  return entries;
}

const fixtureBytes = xlsx.buildWorkbookBytes({
  sheets: [
    {
      name: "요약",
      rows: [
        [{ value: "테스트", style: "title" }, "", "", ""],
        ["문자", "=HYPERLINK(\"https://example.com\")", 0, false],
        ["특수문자", "한글 Việt &<>\"' _x000A_\r다음", new Date("2026-09-12T01:02:03Z"), -5],
      ],
      columnWidths: [14, 32, 20, 12],
      merges: ["A1:D1"],
    },
    { name: "주문", rows: [[{ value: "Order ID", style: "header" }]], freezeRows: 1 },
    { name: "주문 상세", rows: [[{ value: "Line ID", style: "header" }]], freezeRows: 1 },
    { name: "판매 수량", rows: [[{ value: "수량", style: "header" }]], freezeRows: 1 },
  ],
});
assert.equal(fixtureBytes[0], 0x50);
assert.equal(fixtureBytes[1], 0x4b);
const fixtureEntries = readStoredZip(fixtureBytes);
for (const required of [
  "[Content_Types].xml",
  "_rels/.rels",
  "xl/workbook.xml",
  "xl/_rels/workbook.xml.rels",
  "xl/styles.xml",
  "xl/worksheets/sheet1.xml",
  "xl/worksheets/sheet4.xml",
]) {
  assert.ok(fixtureEntries.has(required), `missing ${required}`);
}
const decoder = new TextDecoder();
const workbookXml = decoder.decode(fixtureEntries.get("xl/workbook.xml"));
const summaryXml = decoder.decode(fixtureEntries.get("xl/worksheets/sheet1.xml"));
assert.match(workbookXml, /sheet name="요약"[\s\S]*sheet name="주문"[\s\S]*sheet name="주문 상세"[\s\S]*sheet name="판매 수량"/);
assert.match(summaryXml, /t="inlineStr"[\s\S]*=HYPERLINK/);
assert.doesNotMatch(summaryXml, /<f(?:\s|>)/, "text that looks like a formula must never become a formula");
assert.match(summaryXml, /<v>0<\/v>/, "numeric zero must remain a numeric cell");
assert.match(summaryXml, /한글 Việt &amp;&lt;&gt;&quot;&apos; _x005F_x000A__x000D_다음/);
assert.match(summaryXml, /s="3"><v>\d+(?:\.\d+)?<\/v>/, "dates must be numeric and sortable");
assert.throws(
  () => xlsx.buildWorkbookBytes({ sheets: [{ name: "Invalid", rows: [[Number.POSITIVE_INFINITY]] }] }),
  /Invalid numeric value/,
);
assert.throws(
  () => xlsx.buildWorkbookBytes({ sheets: [{ name: "Invalid", rows: [[new Date("invalid")]] }] }),
  /Invalid date value/,
);

const admin = await readFile(path.join(projectRoot, "admin.html"), "utf8");
assert.match(admin, /<button class="btn" id="printRangeBtn">전체 출력<\/button>\s*<button class="btn" id="excelRangeBtn">엑셀 출력<\/button>/);
assert.match(admin, /<script src="assets\/dgv-xlsx\.js"><\/script>/);
assert.match(admin, /getElementById\("excelRangeBtn"\)\.addEventListener\("click", exportRangeExcel\)/);

const loaderStart = admin.indexOf("async function loadRangeReportData");
const printStart = admin.indexOf("async function printRangeSummary");
const exportStart = admin.indexOf("async function exportRangeExcel");
const exportEnd = admin.indexOf("/*************************************************", exportStart);
assert.ok(loaderStart > 0 && printStart > loaderStart && exportStart > printStart && exportEnd > exportStart);
const loaderBlock = admin.slice(loaderStart, printStart);
const printBlock = admin.slice(printStart, exportStart);
const exportBlock = admin.slice(exportStart, exportEnd);
assert.doesNotMatch(`${loaderBlock}\n${printBlock}\n${exportBlock}`, /\.(?:insert|update|upsert|delete|rpc)\s*\(/);
assert.match(loaderBlock, /\.from\("orders"\)[\s\S]*?\.eq\("sales_excluded", false\)/);
assert.match(loaderBlock, /\.from\("order_items"\)[\s\S]*?column: "order_id", ascending: false[\s\S]*?column: "id", ascending: true/);
assert.match(loaderBlock, /\.from\("order_custom_items"\)[\s\S]*?column: "order_id", ascending: false[\s\S]*?column: "id", ascending: true/);
assert.match(loaderBlock, /String\(order\?\.status \|\| ""\)\.toLowerCase\(\) !== "paid"/);
assert.match(printBlock, /report\.itemsSold\.slice\(0,50\)/, "print must keep the screen's Top 50 summary");
assert.doesNotMatch(exportBlock, /itemsSold\.slice\(/, "Excel must export the complete paid-item aggregation");

const fixtureOrders = [
  { id: "order-a", created_at: "2026-09-12T01:02:00Z", total_usd: 100, total_vnd: 2500000, guide_name: "=1+1", team_no: "A-1", status: "paid", payment_method: "cash", source: "calc_web" },
  { id: "order-b", created_at: "2026-09-11T03:04:00Z", total_usd: 50, total_vnd: 1250000, guide_name: "Guide B", team_no: "B-2", status: "pending", payment_method: "card", source: "reservation_confirm" },
];
const fixtureRegularLines = [
  { id: "line-a", order_id: "order-a", menu_item_id: "menu-a", qty: 2, unit_usd: 40, unit_vnd: 1000000, line_usd: 80, line_vnd: 2000000, is_custom: false, custom_ko_name: null, custom_vi_name: null, menu_items: { ko_name: "맥주", vi_name: "Bia", type: "drink" } },
];
const fixtureCustomLines = [
  { id: "line-b", kind: "food", order_id: "order-a", ko_name: "+Custom", vi_name: "Món riêng", qty: 1, unit_usd: 20, unit_vnd: 500000, line_usd: 20, line_vnd: 500000 },
];
let queryCalls = 0;
let downloadedWorkbook = null;
const alerts = [];
const button = { disabled: false, textContent: "엑셀 출력" };
const integrationContext = {
  console: { error: () => {} },
  DGV: {
    collectSupabasePages: async () => [fixtureOrders, fixtureRegularLines, fixtureCustomLines][queryCalls++] || [],
  },
  currentRange: { from: new Date("2026-09-01T00:00:00Z"), to: new Date("2026-09-12T23:59:59Z") },
  toISODate: (value) => new Date(value).toISOString().slice(0, 10),
  payLabel: (value) => ({ cash: "CASH", card: "CARD", bank: "BANK" }[String(value || "cash").toLowerCase()] || "CASH"),
  sb: {},
  window: { DGV_XLSX: { downloadWorkbook: (options) => { downloadedWorkbook = options; } } },
  document: { getElementById: (id) => id === "excelRangeBtn" ? button : null },
  alert: (message) => alerts.push(message),
  Intl,
  Date,
  Map,
  Set,
};
vm.runInNewContext(
  `${loaderBlock}\n${exportBlock}\nthis.exportRangeExcelForTest = exportRangeExcel;`,
  integrationContext,
);
await integrationContext.exportRangeExcelForTest();
assert.equal(queryCalls, 3);
assert.equal(alerts.length, 0);
assert.equal(button.disabled, false);
assert.equal(button.textContent, "엑셀 출력");
assert.equal(downloadedWorkbook.filename, "HANA_Admin_2026-09-01_2026-09-12.xlsx");
assert.deepEqual(
  Array.from(downloadedWorkbook.sheets, sheet => sheet.name),
  ["요약", "주문", "주문 상세", "판매 수량"],
);
assert.equal(downloadedWorkbook.sheets[1].rows.length, 3, "Orders must include every order");
assert.equal(downloadedWorkbook.sheets[2].rows.length, 4, "Lines must include both line sources and the zero-child order");
assert.equal(downloadedWorkbook.sheets[3].rows.length, 3, "Items Sold must contain all paid items");
const summaryTotal = downloadedWorkbook.sheets[0].rows[9];
assert.equal(summaryTotal[1].value, 2);
assert.equal(summaryTotal[2].value, 3750000);
assert.equal(summaryTotal[3].value, 150);
assert.equal(downloadedWorkbook.sheets[1].rows[1][1].value, "=1+1");
assert.equal(downloadedWorkbook.sheets[2].rows[3][3].value, "상세 라인이 없습니다.");

const integratedBytes = xlsx.buildWorkbookBytes(downloadedWorkbook);
const integratedEntries = readStoredZip(integratedBytes);
const integratedWorkbookXml = decoder.decode(integratedEntries.get("xl/workbook.xml"));
const integratedOrdersXml = decoder.decode(integratedEntries.get("xl/worksheets/sheet2.xml"));
assert.match(integratedWorkbookXml, /sheet name="요약"[\s\S]*sheet name="판매 수량"/);
assert.match(integratedOrdersXml, /=1\+1/);
assert.doesNotMatch(integratedOrdersXml, /<f(?:\s|>)/);

integrationContext.DGV.collectSupabasePages = async () => { throw new Error("read failed"); };
await integrationContext.exportRangeExcelForTest();
assert.equal(button.disabled, false, "button must recover after a failed read");
assert.equal(button.textContent, "엑셀 출력");
assert.equal(alerts.at(-1), "엑셀 파일 생성에 실패했습니다. 잠시 후 다시 시도해 주세요.");

console.log("Admin XLSX package, data model, safety, and download contracts passed.");
