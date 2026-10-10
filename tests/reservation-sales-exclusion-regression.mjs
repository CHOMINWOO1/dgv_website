import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const normalHtml = await readFile(path.join(projectRoot, "reserv_admin.html"), "utf8");
const originalHtml = await readFile(
  path.join(projectRoot, "hana_reserv_admin_hidden.html"),
  "utf8",
);
const helperSource = await readFile(
  path.join(projectRoot, "assets/reservation-visibility.js"),
  "utf8",
);

const context = vm.createContext({});
new vm.Script(helperSource, {
  filename: "assets/reservation-visibility.js",
}).runInContext(context);

const visibility = context.DGV_RESERVATION_VISIBILITY;
assert.ok(visibility, "reservation visibility helper must be exported");

const excludedIds = visibility.buildExcludedOrderIdSet([
  { id: "order-hidden" },
  { id: null },
]);
const fixture = [
  { id: 1, confirmed_order_id: null },
  { id: 2, confirmed_order_id: "order-visible" },
  { id: 3, confirmed_order_id: "order-hidden" },
];

const visibleRows = visibility.applySalesExcludedVisibility(
  fixture,
  excludedIds,
  false,
);
assert.deepEqual(
  Array.from(visibleRows, (row) => row.id),
  [1, 2],
  "normal reservation admin must hide only linked sales-excluded reservations",
);
assert.equal(visibleRows[0].sales_excluded, false);
assert.equal(visibleRows[1].sales_excluded, false);

const originalRows = visibility.applySalesExcludedVisibility(
  fixture,
  excludedIds,
  true,
);
assert.deepEqual(Array.from(originalRows, (row) => row.id), [1, 2, 3]);
assert.equal(originalRows[2].sales_excluded, true);

for (const [file, html] of [
  ["reserv_admin.html", normalHtml],
  ["hana_reserv_admin_hidden.html", originalHtml],
]) {
  assert.match(html, /assets\/reservation-visibility\.js/);
  assert.match(
    html,
    /DGV\.collectSupabasePages\([\s\S]*?\.from\("orders"\)[\s\S]*?\.select\("id"\)[\s\S]*?\.eq\("sales_excluded", true\)[\s\S]*?order:\s*\[\{ column: "id", ascending: true \}\]/,
    `${file} must load every excluded order id with stable pagination`,
  );
  assert.match(html, /loadSalesExcludedOrderIds\(\)/);
  assert.match(html, /applySalesExcludedVisibility\([\s\S]*?excludedOrderIds[\s\S]*?ORIGINAL_VIEW/);
  assert.match(html, /const ORIGINAL_VIEW = document\.body\.dataset\.reservationView === "original"/);
  assert.match(html, /await Promise\.all\(\[/);
}

assert.doesNotMatch(normalHtml, /<body[^>]*data-reservation-view="original"/);
assert.match(originalHtml, /<body[^>]*data-reservation-view="original"/);
assert.match(originalHtml, /매출 제외 항목을 포함한 전체 예약입니다\./);
assert.match(originalHtml, /매출 제외됨/);
assert.match(originalHtml, /if\(editor\) editor\.hidden = true/);
assert.match(
  originalHtml,
  /\.forEach\(\(control\) => \{ control\.disabled = true; \}\)/,
  "original reservation page must expose no editable controls",
);

console.log("Reservation sales-exclusion visibility contracts passed.");
