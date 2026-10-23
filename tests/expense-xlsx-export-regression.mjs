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
assert.match(page, /<button[^>]+id="exportExpenseBtn"[^>]*>엑셀 생성<\/button>/);
assert.match(page, /let displayedRows = \[\];/);
assert.match(page, /function renderRows\(rows\)\{[\s\S]*?displayedRows = rows\.slice\(\)/);
assert.match(page, /exportExpenseBtn\.addEventListener\("click", exportExpenses\)/);

const exportBlock = extractNamedFunction(page, "exportExpenses");
const refreshBlock = extractNamedFunction(page, "refreshActiveView");
const rangeBlock = extractNamedFunction(page, "loadRange");
const searchBlock = extractNamedFunction(page, "loadSearchResults");
assert.match(exportBlock, /const rows = await refreshActiveView\(\)/, "export must refresh before taking its row snapshot");
assert.match(exportBlock, /DGV_XLSX\.downloadWorkbook\(/);
assert.match(refreshBlock, /loadSearchResults\(\)/);
assert.match(refreshBlock, /loadRange\(/);
assert.match(rangeBlock, /\.select\(EXPENSE_COLUMNS\)[\s\S]*?\.gte\("expense_date", range\.start\)[\s\S]*?\.lte\("expense_date", range\.end\)/);
assert.match(searchBlock, /\.select\(EXPENSE_COLUMNS\)/);
assert.match(page, /const EXPENSE_COLUMNS = "id,expense_date,expense_type,description,vendor,amount_vnd,note,created_at"/);
assert.doesNotMatch(
  `${exportBlock}\n${refreshBlock}\n${rangeBlock}\n${searchBlock}`,
  /\.(?:insert|update|upsert|delete|rpc)\s*\(/,
  "refresh and export path must remain read-only",
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
assert.match(exportBlock, /HANA_Expenses_Search_\$\{businessToday\(\)\}\.xlsx/);
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
const labels = { exportExpenseBtn: "엑셀 생성", refreshBtn: "조회", searchBtn: "전체 검색", saveBtn: "지출 저장" };

function element(id) {
  if (elements.has(id)) return elements.get(id);
  const value = {
    id,
    value: "",
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
];
const firstSearchRows = [
  { ...latestRangeRows[0], id: "search-old", note: "베트남 이전 결과" },
  { ...latestRangeRows[1], id: "search-hidden", note: "검색어 불일치" },
];
const latestSearchRows = [
  { ...latestRangeRows[1], id: "search-new", description: "베트남 최신 내역", note: "Việt Nam mới", amount_vnd: 333000 },
  { ...latestRangeRows[0], id: "search-nonmatch", description: "한국 전용", note: "불일치" },
];
const resultQueue = [staleRangeRows, latestRangeRows, firstSearchRows, latestSearchRows];
let queryCalls = 0;
const queryOperations = [];
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
      factory();
      const rows = resultQueue[queryCalls++];
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

const exportHandler = handlers.get("exportExpenseBtn:click");
assert.equal(typeof exportHandler, "function", "Excel button handler is not wired");
await exportHandler({ preventDefault() {} });
await settle();
assert.equal(queryCalls, 2, "range export must refresh the active view before export");
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
assert.equal(rangeSheetRows.length, 8, "only the two freshly displayed range rows plus fixed report rows should export");
assert.equal(rangeSheetRows[5][2].value, '=HYPERLINK("https://example.com")');
assert.equal(rangeSheetRows[5][3].value, "하나마트");
assert.equal(rangeSheetRows[5][4].value, "베트남 매입 Việt Nam");
assert.equal(rangeSheetRows[5][5].value, 125000);
assert.equal(rangeSheetRows[5][5].style, "integer");
assert.match(rangeSheetRows[5][1].value, /^일반 지출 \/ .*[ăâđêôơư]/iu);
assert.match(rangeSheetRows[6][1].value, /^계산서 지출 \/ .*[ăâđêôơư]/iu);
assert.equal(JSON.stringify(rangeWorkbook).includes("stale-row"), false);
assert.equal(JSON.stringify(rangeWorkbook).includes("이전 거래처"), false);

const rangeBytes = xlsx.buildWorkbookBytes(rangeWorkbook);
const rangeEntries = readStoredZip(rangeBytes);
const rangeXml = new TextDecoder().decode(rangeEntries.get("xl/worksheets/sheet1.xml"));
assert.match(rangeXml, /한글|하나마트/);
assert.match(rangeXml, /Việt Nam/);
assert.match(rangeXml, /Chợ Đà Lạt/);
assert.match(rangeXml, /=HYPERLINK\(&quot;https:\/\/example\.com&quot;\)/);
assert.doesNotMatch(rangeXml, /<f(?:\s|>)/, "formula-like expense text must remain an inline string");
assert.match(rangeXml, /<c r="F6" s="2"><v>125000<\/v><\/c>/, "VND must be a numeric integer-formatted cell");

element("expenseSearch").value = "베트남";
const searchHandler = handlers.get("searchForm:submit");
assert.equal(typeof searchHandler, "function", "search handler is not wired");
await searchHandler({ preventDefault() {} });
await settle();
assert.equal(queryCalls, 3);

await exportHandler({ preventDefault() {} });
await settle();
assert.equal(queryCalls, 4, "search export must refresh the full-history search before export");
assert.equal(downloads.length, 2);
const searchWorkbook = downloads[1];
assert.equal(searchWorkbook.filename, "HANA_Expenses_Search_2026-10-23.xlsx");
assert.equal(searchWorkbook.sheets[0].rows.length, 7, "only the one freshly displayed matching search row should export");
const searchJson = JSON.stringify(searchWorkbook);
assert.match(searchJson, /베트남 최신 내역/);
assert.match(searchJson, /Việt Nam mới/);
assert.doesNotMatch(searchJson, /search-old|베트남 이전 결과|search-nonmatch|한국 전용/);

assert.equal(element("exportExpenseBtn").disabled, false, "Excel button must recover after export");
assert.equal(element("exportExpenseBtn").textContent, "엑셀 생성");
assert.equal(toasts.filter((item) => item.tone === "error").length, 0);
assert.equal(
  queryOperations.some(([operation]) => ["insert", "update", "upsert", "delete", "rpc"].includes(operation)),
  false,
  "export refresh queries must never write to Supabase",
);

console.log("Expense current-view XLSX refresh, mapping, UTF-8, numeric, filename, and read-only contracts passed.");
