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
