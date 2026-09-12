import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await import("../assets/dgv-data.js");
const dataUtils = globalThis.DGV_DATA_UTILS;

assert.equal(
  dataUtils.formatLocalYmd(new Date(2026, 7, 8, 0, 30, 0)),
  "2026-08-08",
);
const boundary = new Date("2026-08-07T16:30:00.000Z");
assert.equal(
  dataUtils.formatYmdInTimeZone(boundary, "Asia/Ho_Chi_Minh"),
  "2026-08-07",
);
assert.equal(
  dataUtils.formatYmdInTimeZone(boundary, "Asia/Seoul"),
  "2026-08-08",
);

const sourceRows = Array.from({ length: 1205 }, (_, index) => ({
  id: String(1205 - index).padStart(4, "0"),
  created_at: `2026-08-${String(1 + (index % 28)).padStart(2, "0")}T00:00:00Z`,
}));

function sortedRows(rows, order) {
  return [...rows].sort((left, right) => {
    for (const spec of order) {
      const comparison = String(left[spec.column]).localeCompare(String(right[spec.column]));
      if (comparison) return spec.ascending ? comparison : -comparison;
    }
    return 0;
  });
}

const supabaseRanges = [];
const supabaseOrders = [];
function queryFactory() {
  const order = [];
  return {
    order(column, options) {
      order.push({ column, ascending: options.ascending });
      supabaseOrders.push({ column, ascending: options.ascending });
      return this;
    },
    async range(from, to) {
      supabaseRanges.push([from, to]);
      const serverCap = 200;
      const ordered = sortedRows(sourceRows, order);
      return {
        data: ordered.slice(from, from + Math.min(serverCap, to - from + 1)),
        error: null,
        status: 206,
        count: ordered.length,
      };
    },
  };
}

const orderSpec = [
  { column: "created_at", ascending: true },
  { column: "id", ascending: true },
];
const supabaseRows = await dataUtils.collectSupabasePages(queryFactory, {
  pageSize: 1000,
  order: orderSpec,
});
assert.equal(supabaseRows.length, sourceRows.length);
assert.deepEqual(supabaseRows, sortedRows(sourceRows, orderSpec));
assert.deepEqual(supabaseRanges[0], [0, 999], "Supabase range must be 0-based inclusive");
assert.deepEqual(supabaseRanges[1], [200, 1199], "offset must follow actual capped row count");
assert.deepEqual(supabaseOrders.slice(0, 2), orderSpec);

const restRanges = [];
const restOrders = [];
async function rawRestFetcher(rawUrl, init) {
  const url = new URL(rawUrl);
  restOrders.push(url.searchParams.get("order"));
  const [from, to] = init.headers.Range.split("-").map(Number);
  restRanges.push([from, to]);
  const serverCap = 200;
  const ordered = sortedRows(sourceRows, orderSpec);
  const page = ordered.slice(from, from + Math.min(serverCap, to - from + 1));
  const end = page.length ? from + page.length - 1 : from;
  return {
    ok: true,
    status: 206,
    headers: { get: (name) => name.toLowerCase() === "content-range" ? `${from}-${end}/${ordered.length}` : null },
    text: async () => JSON.stringify(page),
  };
}

const restRows = await dataUtils.collectRestPages(
  "https://example.supabase.co/rest/v1/orders?select=id,created_at",
  { pageSize: 1000, order: orderSpec, headers: { apikey: "test" }, fetcher: rawRestFetcher },
);
assert.deepEqual(restRows, sortedRows(sourceRows, orderSpec));
assert.deepEqual(restRanges[0], [0, 999], "REST Range must be 0-based inclusive");
assert.deepEqual(restRanges[1], [200, 1199]);
assert.equal(restOrders[0], "created_at.asc,id.asc");
await assert.rejects(
  dataUtils.collectSupabasePages(queryFactory, { order: [] }),
  /stable order/i,
);

const clientSource = await readFile(path.join(projectRoot, "assets/supabase-client.js"), "utf8");
const browserGlobal = {
  DGV_SUPABASE_CONFIG: {
    url: "https://example.supabase.co",
    publishableKey: "public-test",
    authAccounts: { staff: "staff@example.test", admin: "admin@example.test" },
  },
  DGV_DATA_UTILS: dataUtils,
  supabase: { createClient: () => ({ auth: {} }) },
  sessionStorage: {},
};
browserGlobal.window = browserGlobal;
vm.runInNewContext(clientSource, { window: browserGlobal, URL });
const xss = `<img src=x onerror=alert(1)> & "quoted"`;
const safe = browserGlobal.DGV.escapeHTML(xss);
assert.equal(safe, "&lt;img src=x onerror=alert(1)&gt; &amp; &quot;quoted&quot;");
assert.doesNotMatch(safe, /<img/i);

const maliciousStatus = `paid</div><img src=x onerror=alert(1)>`;
const safeStatusPrint = `<div>${browserGlobal.DGV.escapeHTML(maliciousStatus.toUpperCase())}</div>`;
assert.doesNotMatch(safeStatusPrint, /<img/i, "printed order status must render as text");
assert.match(safeStatusPrint, /&lt;IMG/i);

const calc = await readFile(path.join(projectRoot, "calc.html"), "utf8");
assert.match(calc, /DGV\.escapeHTML\(p\.ko \|\| "-"\)/);
assert.match(calc, /DGV\.escapeHTML\(p\.vi \|\| ""\)/);
assert.match(calc, /let loadedEditOrderState = null;/);
assert.match(
  calc,
  /loadedEditOrderState = Object\.freeze\(\{[\s\S]*?orderId: String\(meta\.id\),[\s\S]*?source: String\(meta\.source \|\| ""\),[\s\S]*?childCount: \(items \|\| \[\]\)\.length \+ \(cItems \|\| \[\]\)\.length,[\s\S]*?totalUsd: Number\(meta\.total_usd\) \|\| 0,[\s\S]*?totalVnd: Number\(meta\.total_vnd\) \|\| 0[\s\S]*?\}\);/,
  "edit mode must freeze the loaded source, persisted children, and original totals",
);
assert.match(calc, /\.select\("id,guide_name,team_no,payment_method,total_usd,total_vnd,source"\)/);
assert.match(
  calc,
  /function isLoadedLegacyEmptyOrder\(pickedCount\)\{[\s\S]*?loadedEditOrderState\?\.orderId === editOrderId[\s\S]*?loadedEditOrderState\.childCount === 0[\s\S]*?loadedEditOrderState\.source !== "reservation_confirm"[\s\S]*?pickedCount === 0;/,
  "the empty-order compatibility predicate must be tied to the exact loaded order",
);
const updateAllBlock = calc.slice(
  calc.indexOf("function updateAll"),
  calc.indexOf("function resetAll"),
);
assert.match(
  updateAllBlock,
  /isLoadedLegacyEmptyOrder\(picked\.length\)[\s\S]*?usd: loadedEditOrderState\.totalUsd,[\s\S]*?vnd: loadedEditOrderState\.totalVnd,[\s\S]*?: applyCardFeeIfNeeded\(baseUsd, baseVnd\)/,
  "a loaded zero-child order must display its preserved legacy totals until an item is added",
);
const saveNewOrderBlock = calc.slice(
  calc.indexOf("async function saveNewOrder"),
  calc.indexOf("async function saveEditOrder"),
);
assert.match(
  saveNewOrderBlock,
  /if \(picked\.length === 0\)\{[\s\S]*?return;/,
  "new orders must still reject an empty item list",
);
const saveEditOrderBlock = calc.slice(
  calc.indexOf("async function saveEditOrder"),
  calc.indexOf("async function loadOrderForEdit"),
);
assert.match(
  saveEditOrderBlock,
  /const isLegacyEmptyMetadataSave = isLoadedLegacyEmptyOrder\(picked\.length\);/,
  "only a persisted zero-child order may enter the metadata-only save path",
);
assert.match(
  saveEditOrderBlock,
  /if \(picked\.length === 0 && !isLegacyEmptyMetadataSave\)\{[\s\S]*?return;/,
  "clearing the items of a previously non-empty order must remain blocked",
);
assert.match(
  saveEditOrderBlock,
  /p_items: isLegacyEmptyMetadataSave \? \[\] : buildRpcItems\(picked, adj\)/,
  "the compatibility path must send an explicit empty JSON array",
);

const admin = await readFile(path.join(projectRoot, "admin.html"), "utf8");
const reportLoaderBlock = admin.slice(
  admin.indexOf("async function loadRangeReportData"),
  admin.indexOf("async function printRangeSummary"),
);
const rangePrintBlock = admin.slice(
  admin.indexOf("async function printRangeSummary"),
  admin.indexOf("async function exportRangeExcel"),
);
assert.match(reportLoaderBlock, /Promise\.all\(\[/, "range exports must load orders and both line sources in bulk");
assert.match(reportLoaderBlock, /\.from\("orders"\)[\s\S]*?\.select\("id,created_at,total_usd,total_vnd,guide_name,team_no,status,payment_method,source"\)[\s\S]*?\.eq\("sales_excluded", false\)/);
assert.match(reportLoaderBlock, /column: "created_at", ascending: false[\s\S]*?column: "id", ascending: false/, "all printable orders need stable pagination");
assert.match(reportLoaderBlock, /\.from\("order_items"\)[\s\S]*?menu_items\(ko_name,vi_name,type\)[\s\S]*?column: "order_id", ascending: false[\s\S]*?column: "id", ascending: true/, "regular lines need their own unique stable pagination");
assert.match(reportLoaderBlock, /\.from\("order_custom_items"\)[\s\S]*?unit_usd,unit_vnd,line_usd,line_vnd[\s\S]*?column: "order_id", ascending: false[\s\S]*?column: "id", ascending: true/, "custom lines need their own unique stable pagination");
assert.doesNotMatch(reportLoaderBlock, /\.eq\("status", "paid"\)/, "printable orders must match the unfiltered admin order list");
assert.doesNotMatch(`${reportLoaderBlock}\n${rangePrintBlock}`, /\.(?:insert|update|upsert|delete|rpc)\s*\(/, "printing must remain read-only");
assert.match(reportLoaderBlock, /String\(order\?\.status \|\| ""\)\.toLowerCase\(\) !== "paid"/, "Items Sold must retain the screen's paid-only rule");
assert.match(reportLoaderBlock, /visibleOrderIds\.has\(String\(r\.order_id\)\)/, "lines from excluded orders must not leak into print");
assert.match(rangePrintBlock, /await loadRangeReportData\(\)/, "print and Excel must share one report model");
assert.match(rangePrintBlock, /formatTimeLocal\(o\.created_at\)/);
assert.match(rangePrintBlock, /DGV\.escapeHTML\(guideText\)/);
assert.match(rangePrintBlock, /payLabel\(o\.payment_method\)/);
assert.match(rangePrintBlock, /DGV\.escapeHTML\(String\(o\.status \|\| "—"\)\.toUpperCase\(\)\)/);
assert.match(rangePrintBlock, /DGV\.escapeHTML\(String\(r\.ko_name \|\| "—"\)\)/);
assert.match(rangePrintBlock, /DGV\.escapeHTML\(String\(r\.vi_name \|\| ""\)\)/);
assert.match(rangePrintBlock, /fmtInt\(r\.qty\)/);
assert.match(rangePrintBlock, /fmtInt\(r\.line_vnd\)/);
assert.match(rangePrintBlock, /fmtInt\(r\.line_usd\)/);
assert.match(rangePrintBlock, /상세 라인이 없습니다\./, "legacy zero-child orders must remain visible in print");
assert.match(rangePrintBlock, /해당 기간 주문이 없습니다\./);
for (const heading of [
  "Sales Summary",
  "Orders · 주문 상세",
  "Items Sold",
]) {
  assert.ok(rangePrintBlock.includes(heading), `range print must contain ${heading}`);
}
for (const removedMetric of ["Today Sales", "This Month", "Range Orders", "Range Sales"]) {
  assert.ok(!rangePrintBlock.includes(removedMetric), `range print must omit ${removedMetric}`);
}
assert.doesNotMatch(rangePrintBlock, /<section class="metrics"/, "range print must omit the dashboard KPI cards");
assert.doesNotMatch(rangePrintBlock, /visibleOrders\.slice\(/, "range print must not truncate the order list");
assert.match(rangePrintBlock, /report\.itemsSold\.slice\(0,50\)/, "Items Sold must match the admin screen's Top 50 limit");
assert.doesNotMatch(rangePrintBlock, /data-act=/, "print output must not expose admin action controls");
assert.match(rangePrintBlock, /@media print\{[\s\S]*?\.orderBlock\{box-shadow:none;overflow:visible;\}/, "long orders must not be clipped when printed");

const printFixtureOrders = [
  { id: "order-a", created_at: "2026-09-12T01:02:00Z", total_usd: 100, total_vnd: 2500000, guide_name: `<img src=x onerror=alert(1)>`, team_no: "A-1", status: "paid", payment_method: "cash", source: "calc_web" },
  { id: "order-b", created_at: "2026-09-11T03:04:00Z", total_usd: 50, total_vnd: 1250000, guide_name: "Guide B", team_no: "B-2", status: `paid</span><script>alert(2)</script>`, payment_method: "card", source: "reservation_confirm" },
];
const printFixtureRegularLines = [
  { id: "shared-line-id", order_id: "order-a", menu_item_id: "menu-a", qty: 2, unit_usd: 40, unit_vnd: 1000000, line_usd: 80, line_vnd: 2000000, is_custom: false, custom_ko_name: null, custom_vi_name: null, menu_items: { ko_name: `<img src=x onerror=alert(3)>`, vi_name: "Món & đồ uống", type: "drink" } },
];
const printFixtureCustomLines = [
  { id: "shared-line-id", kind: "food", order_id: "order-a", ko_name: "Custom item", vi_name: "Món riêng", qty: 1, unit_usd: 20, unit_vnd: 500000, line_usd: 20, line_vnd: 500000 },
  { id: "excluded-line-id", kind: "food", order_id: "excluded-order", ko_name: "SHOULD_NOT_PRINT", vi_name: "excluded", qty: 99, unit_usd: 999, unit_vnd: 9999999, line_usd: 999, line_vnd: 9999999 },
];
let printFixtureQueryCalls = 0;
let printFixtureHtml = "";
const printFixtureContext = {
  console,
  DGV: {
    collectSupabasePages: async () => [printFixtureOrders, printFixtureRegularLines, printFixtureCustomLines][printFixtureQueryCalls++] || [],
    escapeHTML: browserGlobal.DGV.escapeHTML,
  },
  currentRange: { from: new Date("2026-09-01T00:00:00Z"), to: new Date("2026-09-12T23:59:59Z") },
  toISODate: (value) => new Date(value).toISOString().slice(0, 10),
  formatTimeLocal: (value) => `TIME:${value}`,
  fmtInt: (value) => Math.round(Number(value) || 0).toLocaleString("en-US"),
  payLabel: (value) => ({ cash: "CASH", card: "CARD", bank: "BANK" }[String(value || "cash").toLowerCase()] || "CASH"),
  sb: {},
  openPrintWindow: (html) => { printFixtureHtml = html; },
  alert: (message) => { throw new Error(message); },
};
vm.runInNewContext(`${reportLoaderBlock}\n${rangePrintBlock}\nthis.printRangeSummaryForTest = printRangeSummary;`, printFixtureContext);
await printFixtureContext.printRangeSummaryForTest();
assert.equal(printFixtureQueryCalls, 3, "range print must use one order read and one stable read per line source");
assert.doesNotMatch(printFixtureHtml, /<section class="metrics"/);
assert.equal((printFixtureHtml.match(/<section class="orderBlock">/g) || []).length, 2);
assert.equal((printFixtureHtml.match(/shared-line-id/g) || []).length, 0, "internal line ids must not be exposed");
assert.match(printFixtureHtml, /Orders · 주문 상세 \(2\)/);
assert.match(printFixtureHtml, /TIME:2026-09-12T01:02:00Z/);
assert.match(printFixtureHtml, /2,500,000₫ <span>· 100\$<\/span>/);
assert.match(printFixtureHtml, /Cash<\/td><td>2,500,000₫<\/td><td>100\$<\/td><td>1<\/td>/);
assert.match(printFixtureHtml, /Card<\/td><td>1,250,000₫<\/td><td>50\$<\/td><td>1<\/td>/);
assert.match(printFixtureHtml, /상세 라인이 없습니다\./, "zero-child orders must remain printable");
assert.match(printFixtureHtml, /Custom item/, "regular and custom rows with the same UUID must both survive pagination");
assert.doesNotMatch(printFixtureHtml, /SHOULD_NOT_PRINT/, "lines outside the printable order set must be excluded");
assert.doesNotMatch(printFixtureHtml, /<img src=x/i);
assert.doesNotMatch(printFixtureHtml, /<script>alert/i);
assert.match(printFixtureHtml, /&lt;img src=x onerror=alert\(1\)&gt;/i);
assert.match(printFixtureHtml, /&lt;img src=x onerror=alert\(3\)&gt;/i);
function normalizedCssRule(html, selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(new RegExp(`${escapedSelector}\\s*\\{([^}]+)\\}`));
  assert.ok(match, `missing CSS rule: ${selector}`);
  return match[1].replace(/\s+/g, "");
}
for (const selector of [
  ".modalBack",
  ".modal",
  ".modalTitle",
  ".modalDesc",
  ".modalRow",
  ".modalRow input",
  ".modalBtns",
  ".hint",
  ".btn",
  ".btnPrimary",
]) {
  assert.equal(
    normalizedCssRule(calc, selector),
    normalizedCssRule(admin, selector),
    `calc admin password modal must match admin ${selector}`,
  );
}
const calcModal = calc.slice(
  calc.indexOf('<div class="modalBack" id="adminPassModal">'),
  calc.indexOf('<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js'),
);
assert.match(calcModal, /<div class="modalTitle" id="adminPassTitle">직원 로그인<\/div>/);
assert.match(calcModal, /id="adminPassInput" type="password" placeholder="보안코드" autocomplete="off"/);
assert.equal((calcModal.match(/<button\b/g) || []).length, 1, "calc modal must have one primary button");
assert.match(calcModal, /<button class="btn btnPrimary" id="adminPassConfirmBtn">입장<\/button>/);
assert.match(calcModal, /<p class="hint" style="margin-top:10px;">※ 브라우저 탭\(session\)에서만 유지됩니다\.<\/p>/);
assert.doesNotMatch(calcModal, /adminPassCancelBtn/);
assert.doesNotMatch(calc, /\bprompt\s*\(/, "calc authentication must not use a native prompt");
const entryGateBlock = calc.slice(
  calc.indexOf("async function requireAccessGate"),
  calc.indexOf("let drinkMenu"),
);
assert.match(entryGateBlock, /title: "직원 로그인"/);
assert.match(entryGateBlock, /placeholder: "보안코드"/);
assert.match(entryGateBlock, /confirmLabel: "입장"/);
assert.match(entryGateBlock, /DGV\.signInAs\("staff", code\)/, "entry role must remain staff");
assert.match(entryGateBlock, /entered === null[\s\S]*?return false/);
assert.match(calc, /DGV\.signInAs\("admin", pass\)/, "save role must remain admin");
assert.match(calc, /desc: `\$\{actionLabel\}하려면 관리자 비밀번호를 입력하세요\.`,/);
assert.match(calc, /placeholder: "관리자 비밀번호"/);
assert.match(calc, /confirmLabel: "확인"/);
assert.match(calc, /e\.target\.id === "adminPassModal"[\s\S]*?closePassModal\(null\)/);
assert.match(calc, /e\.key === "Escape"[\s\S]*?closePassModal\(null\)/);
const initBlock = calc.slice(calc.indexOf("(async function init"));
assert.ok(
  initBlock.indexOf("await requireAccessGate()") < initBlock.indexOf("await loadMenuFromDB()"),
  "entry authentication must complete before app data loads",
);
assert.match(initBlock, /if \(!ok\) \{[\s\S]*?location\.href = "\/";[\s\S]*?return;/);

for (const page of ["reserv_check.html", "reserv_admin.html"]) {
  const html = await readFile(path.join(projectRoot, page), "utf8");
  assert.match(html, /function ymd\(d\)\{ return DGV\.formatLocalYmd\(d\); \}/);
  assert.doesNotMatch(html, /function ymd\(d\)\{ return d\.toISOString\(\)\.slice\(0,10\); \}/);
  assert.match(html, /DGV\.collectRestPages\(/);
}

for (const page of ["admin.html", "hana_admin_hidden.html"]) {
  const html = await readFile(path.join(projectRoot, page), "utf8");
  assert.doesNotMatch(html, /\.limit\(200\)/);
  assert.match(html, /DGV\.collectSupabasePages\(/);
  assert.match(html, /payment_method(?:,sales_excluded)?,source/);
  assert.match(html, /orderMeta\.source === "reservation_confirm"/);
  assert.match(html, /querySelector\('button\[data-act="editExpanded"\]'\)\?\.addEventListener/);
  assert.match(
    html,
    /DGV\.escapeHTML\(\(meta\.status\|\|""\)\.toUpperCase\(\)\)/,
    `${page} must escape stored order status in its print document`,
  );
}

for (const page of ["notice.html", "calc.html"]) {
  const html = await readFile(path.join(projectRoot, page), "utf8");
  assert.match(html, /DGV\.collectSupabasePages\(/);
}
for (const page of ["report.html", "reserv_check.html", "reserv_admin.html"]) {
  const html = await readFile(path.join(projectRoot, page), "utf8");
  assert.match(html, /DGV\.collectRestPages\(/);
  assert.match(html, /column: "id", ascending: true/);
  assert.doesNotMatch(html, /await fetch\(/, `${page} list reads must use ranged collection`);
}

const reservAdmin = await readFile(path.join(projectRoot, "reserv_admin.html"), "utf8");
const confirmBlock = reservAdmin.slice(
  reservAdmin.indexOf("async function confirmToOrders"),
  reservAdmin.indexOf("async function unconfirmReservation"),
);
assert.match(confirmBlock, /app_update_and_confirm_reservation/);
assert.doesNotMatch(confirmBlock, /app_update_reservation/);
assert.doesNotMatch(confirmBlock, /app_confirm_reservation/);

console.log("Frontend pagination, local-date, XSS, workflow, and calc modal contracts passed.");
