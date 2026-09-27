import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFile(path.join(projectRoot, file), "utf8");
const migrationFiles = await readdir(path.join(projectRoot, "supabase/migrations"));
const migrationFile = migrationFiles.find((file) => file.endsWith("_qr_menu_subcategories_and_price_sort.sql"));
assert.ok(migrationFile, "missing QR-menu subcategory migration");

const [guestSource, adminSource, guestCss, staffCss, menuHtml, adminHtml, migration] = await Promise.all([
  read("assets/qr-menu.js"),
  read("assets/menu-admin.js"),
  read("assets/qr-menu.css"),
  read("assets/qr-staff.css"),
  read("menu.html"),
  read("menu_admin.html"),
  read(`supabase/migrations/${migrationFile}`),
]);

function functionSource(source, name) {
  const match = source.match(new RegExp(`^  function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^  \\}$`, "m"));
  assert.ok(match, `missing function ${name}`);
  return match[0];
}

const expectedOptions = ["noodle", "stew_rice", "soup", "grill"];
const subcategorySelect = adminHtml.match(/<select class="qr-select" id="qrSubcategory">([\s\S]*?)<\/select>/)?.[1] || "";
const optionPositions = expectedOptions.map((value) => subcategorySelect.indexOf(`<option value="${value}">`));
assert.ok(optionPositions.every((position) => position >= 0), "menu admin must expose every single-menu subcategory");
assert.deepEqual([...optionPositions].sort((a, b) => a - b), optionPositions, "menu admin subcategories must keep the approved order");
assert.doesNotMatch(subcategorySelect, /<option value="other">/, "the fallback bucket must not be offered as a normal admin category");
assert.match(adminHtml, /id="qrSubcategoryField"[\s\S]*?id="qrSubcategory"/);
assert.match(adminSource, /"type", "qr_category", "qr_subcategory"/);
assert.match(adminSource, /function nextSortOrder[\s\S]*?item\.qr_category !== qrCategory[\s\S]*?item\.qr_subcategory/);
assert.match(adminSource, /menus = \(data \|\| \[\]\)\.sort\(compareMenus\)/);
assert.match(adminSource, /orderable: menus\.filter\([\s\S]*?item\.requires_preorder !== true/);
assert.match(adminSource, /statuses\.push\("사전예약 · 상세만 표시"\)/);

const adminSortContext = {
  Number,
  String,
  QR_CATEGORY_ORDER: { single: 10, shared: 20, snack: 30, preorder: 40, drink: 50, cafe: 60 },
  SINGLE_SUBCATEGORIES: {
    noodle: { label: "면", sortOrder: 10 },
    stew_rice: { label: "찌개·덮밥", sortOrder: 20 },
    soup: { label: "국밥", sortOrder: 30 },
    grill: { label: "구이", sortOrder: 40 },
    other: { label: "기타", sortOrder: 90 },
  },
};
vm.runInNewContext(
  `${functionSource(adminSource, "compareMenus")}
  result = [
    {id:"grill", qr_category:"single", qr_subcategory:"grill", price_vnd:10000, sort_order:1, ko_name:"구이"},
    {id:"noodle-high", qr_category:"single", qr_subcategory:"noodle", price_vnd:80000, sort_order:1, ko_name:"비싼 면"},
    {id:"noodle-low", qr_category:"single", qr_subcategory:"noodle", price_vnd:30000, sort_order:99, ko_name:"저렴한 면"},
    {id:"stew", qr_category:"single", qr_subcategory:"stew_rice", price_vnd:20000, sort_order:1, ko_name:"찌개"},
    {id:"soup", qr_category:"single", qr_subcategory:"soup", price_vnd:15000, sort_order:1, ko_name:"국밥"}
  ].sort(compareMenus).map((item) => item.id);`,
  adminSortContext,
);
assert.deepEqual(
  JSON.parse(JSON.stringify(adminSortContext.result)),
  ["noodle-low", "noodle-high", "stew", "soup", "grill"],
  "admin ordering must use approved subcategory order, then ascending VND price",
);

assert.match(guestSource, /item\.is_orderable !== false \|\| item\.requires_preorder === true/);
assert.match(functionSource(guestSource, "menuCard"), /card\.disabled = !available && !preorderOnly/);
assert.match(functionSource(guestSource, "menuCard"), /if \(available \|\| preorderOnly\) card\.addEventListener/);
assert.match(functionSource(guestSource, "updateDetailAdd"), /item\.requires_preorder === true[\s\S]*?detailAdd\.disabled = true[\s\S]*?preorderDetailsOnly/);
assert.match(functionSource(guestSource, "addSelectedToCart"), /!item \|\| !isAvailable\(item\)/);
assert.match(functionSource(guestSource, "renderMenu"), /state\.subcategories\.forEach[\s\S]*?item\.subcategory_id[\s\S]*?menu-subsection/);
assert.match(menuHtml, /id="detailNoteLabel"/);
assert.match(menuHtml, /id="detailQuantityControl"/);

const guestSortContext = {
  Number,
  String,
  Math,
  DEFAULT_SINGLE_SUBCATEGORIES: [
    { id: "noodle", sort_order: 10 },
    { id: "stew_rice", sort_order: 20 },
    { id: "soup", sort_order: 30 },
    { id: "grill", sort_order: 40 },
    { id: "other", sort_order: 90 },
  ],
};
vm.runInNewContext(
  `${functionSource(guestSource, "numericPrice")}
  ${functionSource(guestSource, "isAvailable")}
  ${functionSource(guestSource, "minPrice")}
  ${functionSource(guestSource, "categorySortOrder")}
  ${functionSource(guestSource, "subcategorySortOrder")}
  ${functionSource(guestSource, "compareMenuItems")}
  result = [
    {id:"soup", category_id:"single", subcategory_id:"soup", price_vnd:20000, sort_order:1, variants:[]},
    {id:"noodle-high", category_id:"single", subcategory_id:"noodle", price_vnd:90000, sort_order:1, variants:[]},
    {id:"noodle-low", category_id:"single", subcategory_id:"noodle", price_vnd:30000, sort_order:50, variants:[]},
    {id:"stew", category_id:"single", subcategory_id:"stew_rice", price_vnd:10000, sort_order:1, variants:[]}
  ].sort((left, right) => compareMenuItems(left, right, DEFAULT_SINGLE_SUBCATEGORIES)).map((item) => item.id);`,
  guestSortContext,
);
assert.deepEqual(
  JSON.parse(JSON.stringify(guestSortContext.result)),
  ["noodle-low", "noodle-high", "stew", "soup"],
  "guest ordering must keep subcategory order and sort prices low-to-high within each group",
);

for (const selector of [".menu-photo img", ".detail-media img"]) {
  assert.match(guestCss, new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{[\\s\\S]*?object-fit: contain;`));
}
assert.match(staffCss, /\.qr-image-preview img \{[\s\S]*?object-fit: contain;/);
assert.doesNotMatch(guestCss, /\.(?:menu-photo|detail-media) img \{[\s\S]*?object-fit: cover;/);

assert.match(migration, /add column qr_subcategory text/i);
assert.match(migration, /qr_subcategory in \('noodle', 'stew_rice', 'soup', 'grill', 'other'\)/i);
assert.match(migration, /v_stage_count <> 19 or v_invalid_match_count <> 0/i);
assert.match(migration, /set qr_subcategory = staged\.qr_subcategory/i);
assert.doesNotMatch(migration, /set[\s\S]{0,120}price_(?:usd|vnd)\s*=/i);
for (const name of [
  "신라면", "냉면", "짜파게티", "불닭볶음면", "비빔국수", "명동칼국수",
  "순두부찌개", "찌개(김치/된장)", "돌솥 알밥", "제육덮밥", "다금바리 회덮밥",
  "설렁탕", "육개장", "얼큰 사골 우거지탕", "떡만두국", "돼지국밥", "도가니탕",
  "부채살 스테이크", "연어 스테이크",
]) assert.ok(migration.includes(`'${name}'`), `migration mapping is missing ${name}`);
assert.match(migration, /'qr_subcategory', m\.qr_subcategory/i);
assert.match(migration, /'subcategories', pg_catalog\.jsonb_build_array/i);
assert.match(migration, /'id', 'noodle'[\s\S]*?'id', 'stew_rice'[\s\S]*?'id', 'soup'[\s\S]*?'id', 'grill'/i);
assert.match(migration, /'current_orders', v_current_orders[\s\S]*?'current_total_usd', v_current_total_usd[\s\S]*?'current_total_vnd', v_current_total_vnd/i);
assert.match(migration, /revoke execute on function public\.internal_qr_get_menu\(text\)[\s\S]*?from public, anon, authenticated, service_role[\s\S]*?grant execute[\s\S]*?to service_role/i);
assert.doesNotMatch(migration, /(?:delete from|truncate table|drop table)\s+public\.(?:menu_items|orders|order_items|qr_orders|qr_order_items)/i);

console.log("QR menu subcategories, price ordering, preorder details, and no-crop image contracts passed.");
