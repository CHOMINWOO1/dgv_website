import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { TextDecoder, TextEncoder } from "node:util";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const page = await readFile(path.join(projectRoot, "expense.html"), "utf8");
const exporterSource = await readFile(path.join(projectRoot, "assets/dgv-xlsx.js"), "utf8");

function extractNamedFunction(source, name) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`).exec(source);
  assert.ok(match, `missing ${name}()`);
  const open = match.index + match[0].length - 1;
  let depth = 0;
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = "";
      }
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(match.index, index + 1);
    }
  }
  assert.fail(`unterminated ${name}()`);
}

function readStoredZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const entries = new Map();
  let offset = 0;
  while (offset + 30 <= bytes.length && view.getUint32(offset, true) === 0x04034b50) {
    const method = view.getUint16(offset + 8, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    assert.equal(method, 0, "expense XLSX must use the tested stored ZIP method");
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = decoder.decode(bytes.slice(nameStart, nameStart + nameLength));
    entries.set(name, bytes.slice(dataStart, dataStart + compressedSize));
    offset = dataStart + compressedSize;
  }
  return entries;
}

// Static wiring and safety contracts.
assert.match(page, /<script src="assets\/dgv-xlsx\.js"><\/script>/);
assert.match(page, /<button[^>]+id="printExpenseBtn"[^>]*>출력<\/button>/);
assert.match(page, /<button[^>]+id="exportExpenseBtn"[^>]*>엑셀 생성<\/button>/);
assert.match(page, /id="expensePrintArea"/);
assert.match(page, /id="printCriteria"/);
assert.match(page, /id="printGeneratedAt"/);
assert.match(page, /@media print\{[\s\S]*?body\s*>\s*main\.qr-shell\{display:block!important;\}/, "expense print must override the shared QR-only print rule");
assert.match(page, /@media print\{[\s\S]*?\.screen-only\{display:none!important;\}[\s\S]*?\.print-only\{display:inline!important;\}/);
assert.match(page, /@media print\{[\s\S]*?\.expense-table th:last-child,\.expense-table td:last-child\{display:none!important;\}/, "print must hide edit/delete controls");
for (const printLabel of [
  "HANA 식당 지출 내역 / Chi phí nhà hàng HANA",
  "일반 지출 / Chi thường",
  "계산서 지출 / Chi có hóa đơn",
  "인건비 지출 / Chi phí nhân công",
  "전체 지출 / Tổng chi phí",
  "입력 건수 / Số mục",
  "날짜 / Ngày",
  "구분 / Phân loại",
  "내역 / Nội dung",
  "거래처 / Đối tác",
  "비고 / Ghi chú",
  "금액 / Số tiền",
]) {
  assert.ok(page.includes(printLabel), `missing bilingual print label: ${printLabel}`);
}
assert.match(page, /let displayedRows = \[\];/);
assert.match(page, /function renderRows\(rows\)\{[\s\S]*?displayedRows = rows\.slice\(\)/);
assert.match(page, /printExpenseBtn\.addEventListener\("click", printExpenses\)/);
assert.match(page, /exportExpenseBtn\.addEventListener\("click", exportExpenses\)/);

const printBlock = extractNamedFunction(page, "printExpenses");
const exportBlock = extractNamedFunction(page, "exportExpenses");
const refreshBlock = extractNamedFunction(page, "refreshActiveView");
const rangeBlock = extractNamedFunction(page, "loadRange");
const searchBlock = extractNamedFunction(page, "loadSearchResults");
assert.match(printBlock, /const rows = await refreshActiveView\(\)/, "print must refresh before taking its row snapshot");
assert.match(printBlock, /window\.print\(\)/);
assert.match(printBlock, /printCriteria\.textContent\s*=/, "print must expose the active date range or search criteria");
assert.match(printBlock, /printGeneratedAt\.textContent\s*=/, "print must expose its generated time");
assert.match(exportBlock, /const rows = await refreshActiveView\(\)/, "export must refresh before taking its row snapshot");
assert.match(exportBlock, /DGV_XLSX\.downloadWorkbook\(/);
assert.match(refreshBlock, /loadSearchResults\(\)/);
assert.match(refreshBlock, /loadRange\(/);
assert.match(rangeBlock, /\.select\(EXPENSE_COLUMNS\)[\s\S]*?\.gte\("expense_date", range\.start\)[\s\S]*?\.lte\("expense_date", range\.end\)/);
assert.match(searchBlock, /const range = requestedRange\(\)/, "search must read the currently selected date inputs");
assert.match(
  searchBlock,
  /\.select\(EXPENSE_COLUMNS\)[\s\S]*?\.gte\("expense_date", range\.start\)[\s\S]*?\.lte\("expense_date", range\.end\)/,
  "search must constrain the Supabase read to the current inclusive date range",
);
assert.match(page, /id="expenseCategoryFilter"/, "expense search needs a category selector");
assert.match(
  page,
  /\.eq\("expense_type",\s*(?:category|searchType|selectedCategory)\)/,
  "a category search must be constrained on the server",
);
assert.match(page, /const EXPENSE_COLUMNS = "id,expense_date,expense_type,description,vendor,amount_vnd,note,created_at"/);
assert.doesNotMatch(
  `${printBlock}\n${exportBlock}\n${refreshBlock}\n${rangeBlock}\n${searchBlock}`,
  /\.(?:insert|update|upsert|delete|rpc)\s*\(/,
  "print/export refresh path must remain read-only",
);
for (const label of [
  "날짜 / Ngày",
  "구분 / Phân loại",
  "내역 / Nội dung",
  "거래처 / Đối tác",
  "비고 / Ghi chú",
  "금액(VND) / Số tiền (VND)",
]) {
  assert.ok(exportBlock.includes(label), `missing bilingual XLSX header: ${label}`);
}
for (const field of ["row.expense_date", "row.expense_type", "row.description", "row.vendor", "row.note", "row.amount_vnd"]) {
  assert.ok(exportBlock.includes(field), `expense XLSX is missing ${field}`);
}
assert.match(exportBlock, /numberCell\(row\.amount_vnd\)/, "VND must be emitted through a numeric cell helper");
assert.match(exportBlock, /style="integer"/);
assert.match(exportBlock, /HANA_Expenses_Search_\$\{loadedRange\.start \|\| rangeStart\.value\}_\$\{loadedRange\.end \|\| rangeEnd\.value\}\.xlsx/);
assert.match(exportBlock, /HANA_Expenses_\$\{loadedRange\.start \|\| rangeStart\.value\}_\$\{loadedRange\.end \|\| rangeEnd\.value\}\.xlsx/);

const helperContext = {
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
vm.runInNewContext(exporterSource, helperContext);
const xlsx = helperContext.DGV_XLSX;
assert.ok(xlsx?.buildWorkbookBytes, "local DGV_XLSX helper must be usable");

const handlers = new Map();
const elements = new Map();
const labels = { printExpenseBtn: "출력", exportExpenseBtn: "엑셀 생성", refreshBtn: "조회", searchBtn: "검색", saveBtn: "지출 저장" };

function element(id) {
  if (elements.has(id)) return elements.get(id);
  const value = {
    id,
    value: id === "expenseCategoryFilter" ? "all" : "",
    hidden: false,
    disabled: false,
    textContent: labels[id] || "",
    innerHTML: "",
    dataset: {},
    style: {},
    classList: { add() {}, remove() {} },
    elements: id === "expenseForm" ? { expenseType: { value: "general" } } : {},
    addEventListener(type, handler) { handlers.set(`${id}:${type}`, handler); },
    focus() {},
    select() {},
    scrollIntoView() {},
    closest() { return null; },
  };
  elements.set(id, value);
  return value;
}

const staleRangeRows = [{
  id: "stale-row",
  expense_date: "2026-10-01",
  expense_type: "general",
  description: "내보내면 안 되는 이전 값",
  vendor: "이전 거래처",
  note: "stale",
  amount_vnd: 1,
  created_at: "2026-10-01T00:00:00Z",
}];
const latestRangeRows = [
  {
    id: "range-general",
    expense_date: "2026-10-20",
    expense_type: "general",
    description: '=HYPERLINK("https://example.com")',
    vendor: "하나마트",
    note: "베트남 매입 Việt Nam",
    amount_vnd: "125000",
    created_at: "2026-10-20T01:00:00Z",
  },
  {
    id: "range-invoice",
    expense_date: "2026-10-21",
    expense_type: "invoice",
    description: "식재료 구입",
    vendor: "Chợ Đà Lạt",
    note: "Hóa đơn đỏ",
    amount_vnd: 250000,
    created_at: "2026-10-21T01:00:00Z",
  },
  {
    id: "range-labor",
    expense_date: "2026-10-20",
    expense_type: "labor",
    description: "파트타임 급여",
    vendor: "직원",
    note: "Nhân công",
    amount_vnd: 180000,
    created_at: "2026-10-20T02:00:00Z",
  },
];
const firstSearchRows = [
  { ...latestRangeRows[0], id: "search-first-20", description: "베트남 20일 내역", note: "Việt Nam 20", amount_vnd: 220000 },
  { ...latestRangeRows[1], id: "search-first-21", description: "베트남 21일 내역", note: "Việt Nam 21", amount_vnd: 221000 },
  { ...latestRangeRows[2], id: "search-first-labor-20", description: "베트남 인건비 20일", note: "Việt Nam nhân công 20", amount_vnd: 230000 },
  { ...latestRangeRows[2], id: "search-first-labor-21", expense_date: "2026-10-21", description: "베트남 인건비 21일", note: "Việt Nam nhân công 21", amount_vnd: 231000 },
  { ...latestRangeRows[2], id: "search-first-before", expense_date: "2026-10-19", description: "베트남 인건비 범위 이전", note: "OUTSIDE BEFORE" },
  { ...latestRangeRows[2], id: "search-first-after", expense_date: "2026-10-22", description: "베트남 인건비 범위 이후", note: "OUTSIDE AFTER" },
  { ...latestRangeRows[2], id: "search-first-nonmatch", description: "한국 인건비", note: "불일치" },
];
const latestSearchRows = [
  { ...latestRangeRows[0], id: "search-latest-20", description: "베트남 최신 20일", note: "Việt Nam mới 20", amount_vnd: 320000 },
  { ...latestRangeRows[1], id: "search-latest-21", description: "베트남 최신 21일", note: "Việt Nam mới 21", amount_vnd: 333000 },
  { ...latestRangeRows[2], id: "search-latest-labor-20", description: "베트남 최신 인건비 20일", note: "Việt Nam nhân công mới 20", amount_vnd: 330000 },
  { ...latestRangeRows[2], id: "search-latest-labor-21", expense_date: "2026-10-21", description: "베트남 최신 인건비 21일", note: "Việt Nam nhân công mới 21", amount_vnd: 331000 },
  { ...latestRangeRows[2], id: "search-latest-before", expense_date: "2026-10-19", description: "베트남 최신 인건비 범위 이전", note: "OUTSIDE BEFORE" },
  { ...latestRangeRows[2], id: "search-latest-after", expense_date: "2026-10-22", description: "베트남 최신 인건비 범위 이후", note: "OUTSIDE AFTER" },
  { ...latestRangeRows[2], id: "search-latest-nonmatch", description: "한국 인건비", note: "불일치" },
];
const categoryOnlyRows = [
  { ...latestRangeRows[0], id: "category-general", description: "일반 지출 전용" },
  { ...latestRangeRows[1], id: "category-invoice", description: "계산서 카테고리 전용", amount_vnd: 444000 },
  { ...latestRangeRows[2], id: "category-labor", description: "인건비 카테고리 전용" },
];
const resultQueue = [
  staleRangeRows,
  latestRangeRows,
  latestRangeRows,
  firstSearchRows,
  latestSearchRows,
  latestSearchRows,
  categoryOnlyRows,
];
let queryCalls = 0;
const queryOperations = [];
const queryBatches = [];
let queryProxy;
queryProxy = new Proxy({}, {
  get(_target, property) {
    if (property === "then") return undefined;
    return (...args) => {
      queryOperations.push([String(property), ...args]);
      return queryProxy;
    };
  },
});
const sb = {
  from(table) {
    queryOperations.push(["from", table]);
    return queryProxy;
  },
};
const downloads = [];
const toasts = [];
let printCalls = 0;
const pageContext = {
  console: { error() {} },
  document: {
    body: element("body"),
    getElementById: element,
  },
  DGV: {
    supabase: sb,
    formatYmdInTimeZone: () => "2026-10-23",
    escapeHTML: (value) => String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;"),
    collectSupabasePages: async (factory) => {
      const operationStart = queryOperations.length;
      factory();
      const sourceRows = resultQueue[queryCalls++];
      const operations = queryOperations.slice(operationStart);
      queryBatches.push(operations);
      const lowerBound = operations.find(([operation, column]) => operation === "gte" && column === "expense_date")?.[2];
      const upperBound = operations.find(([operation, column]) => operation === "lte" && column === "expense_date")?.[2];
      const expenseType = operations.find(([operation, column]) => operation === "eq" && column === "expense_type")?.[2];
      const rows = sourceRows?.filter((row) =>
        (!lowerBound || row.expense_date >= lowerBound)
        && (!upperBound || row.expense_date <= upperBound)
        && (!expenseType || row.expense_type === expenseType));
      assert.ok(rows, `unexpected expense query ${queryCalls}`);
      return rows;
    },
    getIdentity: async () => ({ user: null, role: null }),
    signInAs: async () => ({ user: {}, role: "admin" }),
  },
  QRStaff: {
    setBusy(target, busy, label) {
      target.disabled = Boolean(busy);
      if (busy && label) target.textContent = label;
    },
    toast(message, tone) { toasts.push({ message, tone }); },
  },
  Intl,
  Date,
  Map,
  Set,
  Object,
  Number,
  String,
  Array,
  Promise,
  Math,
  Error,
  TypeError,
  RegExp,
  setTimeout,
  clearTimeout,
  confirm: () => true,
  print: () => { printCalls += 1; },
};
pageContext.window = pageContext;
pageContext.globalThis = pageContext;
pageContext.DGV_XLSX = {
  buildWorkbookBytes: xlsx.buildWorkbookBytes,
  downloadWorkbook(options) {
    downloads.push(options);
    return { filename: options.filename, byteLength: xlsx.buildWorkbookBytes(options).length };
  },
};

const inlineScript = Array.from(page.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g), (match) => match[1])
  .find((source) => source.includes("function initExpensePage"));
assert.ok(inlineScript, "expense page inline controller is missing");
vm.runInNewContext(inlineScript, pageContext, { filename: "expense.html" });

async function settle() {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

await settle();
assert.equal(queryCalls, 1, "page start must load the default date range once");
assert.equal(element("rangeStart").value, "2026-10-01");
assert.equal(element("rangeEnd").value, "2026-10-23");

const printHandler = handlers.get("printExpenseBtn:click");
assert.equal(typeof printHandler, "function", "print button handler is not wired");
await printHandler({ preventDefault() {} });
await settle();
assert.equal(queryCalls, 2, "range print must refresh the active view before printing");
assert.equal(printCalls, 1);
assert.equal(element("printCriteria").textContent, "조회 기간 / Thời gian tra cứu: 2026-10-01 ~ 2026-10-23");
assert.match(element("printGeneratedAt").textContent, /^출력 일시 \/ Thời gian in:/);
assert.match(element("expenseRows").innerHTML, /=HYPERLINK\(&quot;https:\/\/example\.com&quot;\)/);
assert.match(element("expenseRows").innerHTML, /베트남 매입 Việt Nam/);
assert.match(element("expenseRows").innerHTML, /Chợ Đà Lạt/);
assert.match(element("expenseRows").innerHTML, /파트타임 급여/);
assert.match(element("expenseRows").innerHTML, /인건비 지출/);
assert.equal(element("laborSubtotal").textContent, "180,000 VND");
assert.equal(element("totalAmount").textContent, "555,000 VND");
assert.doesNotMatch(element("expenseRows").innerHTML, /내보내면 안 되는 이전 값|이전 거래처/);

const exportHandler = handlers.get("exportExpenseBtn:click");
assert.equal(typeof exportHandler, "function", "Excel button handler is not wired");
await exportHandler({ preventDefault() {} });
await settle();
assert.equal(queryCalls, 3, "range export must refresh the active view before export");
assert.equal(downloads.length, 1);

const rangeWorkbook = downloads[0];
assert.equal(rangeWorkbook.filename, "HANA_Expenses_2026-10-01_2026-10-23.xlsx");
assert.equal(rangeWorkbook.sheets.length, 1);
assert.equal(rangeWorkbook.sheets[0].name, "지출 내역");
const rangeSheetRows = rangeWorkbook.sheets[0].rows;
assert.deepEqual(
  Array.from(rangeSheetRows[4], (cell) => cell.value),
  ["날짜 / Ngày", "구분 / Phân loại", "내역 / Nội dung", "거래처 / Đối tác", "비고 / Ghi chú", "금액(VND) / Số tiền (VND)"],
);
assert.equal(rangeSheetRows.length, 9, "only the three freshly displayed range rows plus fixed report rows should export");
assert.equal(rangeSheetRows[5][2].value, '=HYPERLINK("https://example.com")');
assert.equal(rangeSheetRows[5][3].value, "하나마트");
assert.equal(rangeSheetRows[5][4].value, "베트남 매입 Việt Nam");
assert.equal(rangeSheetRows[5][5].value, 125000);
assert.equal(rangeSheetRows[5][5].style, "integer");
assert.match(rangeSheetRows[5][1].value, /^일반 지출 \/ .*[ăâđêôơư]/iu);
assert.match(rangeSheetRows[6][1].value, /^계산서 지출 \/ .*[ăâđêôơư]/iu);
assert.equal(rangeSheetRows[7][1].value, "인건비 지출 / Chi phí nhân công");
assert.equal(rangeSheetRows[7][5].value, 180000);
assert.equal(JSON.stringify(rangeWorkbook).includes("stale-row"), false);
assert.equal(JSON.stringify(rangeWorkbook).includes("이전 거래처"), false);

const rangeBytes = xlsx.buildWorkbookBytes(rangeWorkbook);
const rangeEntries = readStoredZip(rangeBytes);
const rangeXml = new TextDecoder().decode(rangeEntries.get("xl/worksheets/sheet1.xml"));
assert.match(rangeXml, /한글|하나마트/);
assert.match(rangeXml, /Việt Nam/);
assert.match(rangeXml, /Chợ Đà Lạt/);
assert.match(rangeXml, /인건비 지출 \/ Chi phí nhân công/);
assert.match(rangeXml, /=HYPERLINK\(&quot;https:\/\/example\.com&quot;\)/);
assert.doesNotMatch(rangeXml, /<f(?:\s|>)/, "formula-like expense text must remain an inline string");
assert.match(rangeXml, /<c r="F6" s="2"><v>125000<\/v><\/c>/, "VND must be a numeric integer-formatted cell");

// Change the inputs without submitting the range form. Search must use these
// current values rather than the previously loaded 2026-10-01..23 range.
element("rangeStart").value = "2026-10-20";
element("rangeEnd").value = "2026-10-21";
element("expenseSearch").value = "베트남";
element("expenseCategoryFilter").value = "labor";
const searchHandler = handlers.get("searchForm:submit");
assert.equal(typeof searchHandler, "function", "search handler is not wired");
await searchHandler({ preventDefault() {} });
await settle();
assert.equal(queryCalls, 4);
assert.deepEqual(
  queryBatches[3].filter(([operation]) => operation === "gte" || operation === "lte"),
  [["gte", "expense_date", "2026-10-20"], ["lte", "expense_date", "2026-10-21"]],
  "search must query the date inputs immediately, without requiring a separate 조회 click",
);
assert.deepEqual(
  queryBatches[3].filter(([operation, column]) => operation === "eq" && column === "expense_type"),
  [["eq", "expense_type", "labor"]],
  "category search must be pushed into the Supabase query",
);
assert.match(element("expenseRows").innerHTML, /베트남 인건비 20일/);
assert.match(element("expenseRows").innerHTML, /베트남 인건비 21일/);
assert.doesNotMatch(element("expenseRows").innerHTML, /베트남 20일 내역|베트남 21일 내역|OUTSIDE BEFORE|OUTSIDE AFTER|한국 인건비/);

// Print must refresh the search with date inputs changed since the search.
element("rangeStart").value = "2026-10-21";
element("rangeEnd").value = "2026-10-21";
await printHandler({ preventDefault() {} });
await settle();
assert.equal(queryCalls, 5, "search print must refresh the range-constrained search before printing");
assert.equal(printCalls, 2);
assert.deepEqual(
  queryBatches[4].filter(([operation]) => operation === "gte" || operation === "lte"),
  [["gte", "expense_date", "2026-10-21"], ["lte", "expense_date", "2026-10-21"]],
  "print must refresh using the current date inputs",
);
assert.match(element("printCriteria").textContent, /2026-10-21\s*~\s*2026-10-21/);
assert.match(element("printCriteria").textContent, /베트남/);
assert.match(element("printCriteria").textContent, /카테고리 \/ Phân loại:\s*인건비 지출 \/ Chi phí nhân công/);
assert.match(element("expenseRows").innerHTML, /베트남 최신 인건비 21일/);
assert.match(element("expenseRows").innerHTML, /Việt Nam nhân công mới 21/);
assert.doesNotMatch(element("expenseRows").innerHTML, /최신 인건비 20일|베트남 최신 21일|OUTSIDE BEFORE|OUTSIDE AFTER|한국 인건비/);

// XLSX must independently refresh with the date inputs changed again.
element("rangeStart").value = "2026-10-20";
element("rangeEnd").value = "2026-10-20";
await exportHandler({ preventDefault() {} });
await settle();
assert.equal(queryCalls, 6, "search export must refresh the range-constrained search before export");
assert.deepEqual(
  queryBatches[5].filter(([operation]) => operation === "gte" || operation === "lte"),
  [["gte", "expense_date", "2026-10-20"], ["lte", "expense_date", "2026-10-20"]],
  "XLSX export must refresh using the current date inputs",
);
assert.equal(downloads.length, 2);
const searchWorkbook = downloads[1];
assert.equal(searchWorkbook.filename, "HANA_Expenses_Search_2026-10-20_2026-10-20.xlsx");
assert.equal(searchWorkbook.sheets[0].rows.length, 7, "only the one freshly displayed matching search row should export");
assert.match(searchWorkbook.sheets[0].rows[1][1].value, /2026-10-20\s*~\s*2026-10-20/);
assert.match(searchWorkbook.sheets[0].rows[1][1].value, /베트남/);
assert.match(searchWorkbook.sheets[0].rows[1][1].value, /카테고리 \/ Phân loại:\s*인건비 지출 \/ Chi phí nhân công/);
const searchJson = JSON.stringify(searchWorkbook);
assert.match(searchJson, /베트남 최신 인건비 20일/);
assert.match(searchJson, /Việt Nam nhân công mới 20/);
assert.match(searchJson, /인건비 지출 \/ Chi phí nhân công/);
assert.doesNotMatch(searchJson, /최신 인건비 21일|베트남 최신 20일|OUTSIDE BEFORE|OUTSIDE AFTER|한국 인건비/);

// A category alone is a valid selected-range search; text is optional when a
// category other than "all" is chosen.
element("rangeStart").value = "2026-10-20";
element("rangeEnd").value = "2026-10-21";
element("expenseSearch").value = "";
element("expenseCategoryFilter").value = "invoice";
await searchHandler({ preventDefault() {} });
await settle();
assert.equal(queryCalls, 7, "category-only search must issue a range-constrained read");
assert.deepEqual(
  queryBatches[6].filter(([operation]) => operation === "gte" || operation === "lte"),
  [["gte", "expense_date", "2026-10-20"], ["lte", "expense_date", "2026-10-21"]],
);
assert.deepEqual(
  queryBatches[6].filter(([operation, column]) => operation === "eq" && column === "expense_type"),
  [["eq", "expense_type", "invoice"]],
);
assert.match(element("expenseRows").innerHTML, /계산서 카테고리 전용/);
assert.doesNotMatch(element("expenseRows").innerHTML, /일반 지출 전용|인건비 카테고리 전용/);

assert.equal(element("exportExpenseBtn").disabled, false, "Excel button must recover after export");
assert.equal(element("exportExpenseBtn").textContent, "엑셀 생성");
assert.equal(element("printExpenseBtn").disabled, false, "print button must recover after printing");
assert.equal(element("printExpenseBtn").textContent, "출력");
assert.equal(toasts.filter((item) => item.tone === "error").length, 0);
assert.equal(
  queryOperations.some(([operation]) => ["insert", "update", "upsert", "delete", "rpc"].includes(operation)),
  false,
  "print/export refresh queries must never write to Supabase",
);
for (const [index, operations] of queryBatches.slice(3).entries()) {
  assert.equal(
    operations.some(([operation]) => ["insert", "update", "upsert", "delete", "rpc"].includes(operation)),
    false,
    `range-constrained search path ${index + 1} must remain read-only`,
  );
}

console.log("Expense current-view print/XLSX refresh, mapping, UTF-8, numeric, filename, and read-only contracts passed.");

