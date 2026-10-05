import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFile(path.join(projectRoot, file), "utf8");
const [guestSource, guestHtml, guestCss, inboxSource, inboxHtml] = await Promise.all([
  read("assets/qr-menu.js"),
  read("menu.html"),
  read("assets/qr-menu.css"),
  read("assets/order-inbox.js"),
  read("order_inbox.html"),
]);

function functionSource(source, name) {
  const match = source.match(new RegExp(`^  (?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^  \\}`, "m"));
  assert.ok(match, `missing function ${name}`);
  return match[0];
}

assert.match(functionSource(guestSource, "categorySortOrder"), /combo:\s*0[\s\S]*?single:\s*10/);
assert.match(functionSource(guestSource, "categoryLabel"), /combo:\s*\{\s*ko:\s*"콤보 메뉴"/);
assert.match(functionSource(guestSource, "renderMenu"), /const hasSearchTerm = Boolean\(normalizeSearchText\(state\.searchTerm\)\)[\s\S]*?const visibleItems = hasSearchTerm[\s\S]*?matchesMenuSearch[\s\S]*?usableCategories\.forEach[\s\S]*?appendCategoryItems\([^\n]*visibleItems\.filter/);
assert.doesNotMatch(functionSource(guestSource, "renderMenu"), /usableCategories\.find\(\(row\)[\s\S]*?appendCategoryItems/);
assert.match(functionSource(guestSource, "renderMenu"), /section\.dataset\.category = categoryId[\s\S]*?observeCategories\(\)/);
assert.match(functionSource(guestSource, "appendCategoryItems"), /String\(category\?\.id\) === "single"[\s\S]*?state\.subcategories\.forEach/);
assert.doesNotMatch(guestHtml, /id="(?:category|subcategory)[^"]*"[^>]*<select/i);

for (const id of ["menuSearch", "menuSearchClear", "detailComboPricing", "detailComboSection", "detailComboComponents"]) {
  assert.match(guestHtml, new RegExp(`id=["']${id}["']`));
}
assert.match(guestHtml, /id="menuToolbar"[\s\S]*?id="menuSearch"[\s\S]*?id="categoryNav"/);
assert.match(guestHtml, /assets\/qr-menu\.css\?v=20261005-all-menu/);
assert.match(guestHtml, /assets\/qr-menu\.js\?v=20261005-all-menu/);
assert.match(guestCss, /\.menu-toolbar\s*\{[\s\S]*?position:\s*sticky[\s\S]*?top:\s*0/);
assert.match(guestCss, /\.menu-section\s*\{[\s\S]*?scroll-margin-top:\s*calc\(var\(--menu-toolbar-height\) \+ 10px\)/);
assert.match(functionSource(guestSource, "scrollToCategory"), /setActiveCategory\(normalized,[^\n]*\)[\s\S]*?scrollIntoView\(\{ behavior: preferredScrollBehavior\(\), block: "start" \}\)/);
assert.doesNotMatch(functionSource(guestSource, "scrollToCategory"), /renderMenu\(/);
assert.match(functionSource(guestSource, "setActiveCategory"), /aria-current[\s\S]*?categoryNav\.scrollTo/);
assert.match(functionSource(guestSource, "preferredScrollBehavior"), /prefers-reduced-motion: reduce[\s\S]*?"auto" : "smooth"/);
assert.match(functionSource(guestSource, "observeCategories"), /menu-section\[data-category\][\s\S]*?IntersectionObserver\(scheduleCategoryUpdate[\s\S]*?scheduleCategoryUpdate\(\)/);
assert.match(functionSource(guestSource, "updateActiveCategoryFromScroll"), /stickyOffset[\s\S]*?active = section[\s\S]*?sections\[sections\.length - 1\][\s\S]*?setActiveCategory/);
assert.match(functionSource(guestSource, "bindEvents"), /state\.searchTerm = el\.menuSearch\.value;[\s\S]*?renderMenu\(\)/);
assert.doesNotMatch(functionSource(guestSource, "bindEvents"), /menuSearch\.value\.trim\(/);
assert.match(guestCss, /\.combo-regular-price[\s\S]*?text-decoration:\s*line-through/);
assert.match(guestCss, /\.combo-saving-badge/);
assert.match(guestCss, /\.combo-service-badge/);
assert.match(guestCss, /\.combo-component\.has-image[\s\S]*?grid-template-columns:\s*72px/);
assert.match(guestCss, /\.combo-component-media img[\s\S]*?object-fit:\s*contain/);

assert.match(functionSource(guestSource, "menuCard"), /comboPricingOf[\s\S]*?combo-regular-price[\s\S]*?combo-saving-badge/);
assert.match(functionSource(guestSource, "openDetail"), /renderComboDetail\(item\)/);
assert.match(functionSource(guestSource, "renderComboDetail"), /combo_components|comboComponentsOf[\s\S]*?component\.is_service[\s\S]*?descriptionOf\(component\)[\s\S]*?safeImageUrl\(component\.image_url\)[\s\S]*?appendImage\(media, component\)/);
assert.match(functionSource(guestSource, "updateDetailAdd"), /requires_preorder === true[\s\S]*?detailAdd\.disabled = true/);

const comboContext = vm.createContext({ result: null, Number, String, Math, Array });
vm.runInContext(`
  const MAX_QTY = 20;
  ${functionSource(guestSource, "nonNegativeInteger")}
  ${functionSource(guestSource, "optionalMoney")}
  ${functionSource(guestSource, "normalizeComboComponent")}
  ${functionSource(guestSource, "comboComponentsOf")}
  ${functionSource(guestSource, "comboPricingOf")}
  ${functionSource(guestSource, "normalizeComboSnapshot")}
  ${functionSource(guestSource, "normalizeSearchText")}
  ${functionSource(guestSource, "itemSearchText")}
  ${functionSource(guestSource, "matchesMenuSearch")}
  ${functionSource(guestSource, "categorySortOrder")}
  const combo = {
    category_id: "combo",
    price_vnd: 240000,
    regular_price_vnd: 300000,
    discount_vnd: 60000,
    discount_percent: 20,
    combo_components: [
      {kind:"menu", qty:2, name_ko:"불고기", description_en:"Marinated beef", image_url:"https://images.example/menu.jpg", unit_price_vnd:120000, line_regular_vnd:240000},
      {kind:"service", qty:1, name_ko:"서비스 디저트", description_vi:"Tráng miệng tặng kèm", reference_price_vnd:60000, line_regular_vnd:60000}
    ]
  };
  const components = comboComponentsOf(combo);
  result = {
    categoryOrder: categorySortOrder("combo"),
    components,
    pricing: comboPricingOf(combo, components),
    findsEnglishDescription: matchesMenuSearch(combo, "marinated beef"),
    findsVietnameseService: matchesMenuSearch(combo, "trang mieng tang kem"),
    oldRow: normalizeComboSnapshot(null),
    snapshot: normalizeComboSnapshot({combo_components: combo.combo_components, regular_price_vnd:300000, combo_price_vnd:240000, discount_vnd:60000, discount_percent:20})
  };
`, comboContext);
const comboResult = JSON.parse(JSON.stringify(comboContext.result));
assert.equal(comboResult.categoryOrder, 0);
assert.equal(comboResult.components.length, 2);
assert.equal(comboResult.components[1].is_service, true);
assert.equal(comboResult.components[0].image_url, "https://images.example/menu.jpg");
assert.deepEqual(comboResult.pricing, {
  regularVnd: 300000,
  regularUsd: 0,
  comboVnd: 240000,
  comboUsd: 0,
  discountVnd: 60000,
  discountUsd: 0,
  discountPercent: 20,
});
assert.equal(comboResult.findsEnglishDescription, true);
assert.equal(comboResult.findsVietnameseService, true);
assert.equal(comboResult.oldRow, null);
assert.equal(comboResult.snapshot.combo_components.length, 2);

assert.match(functionSource(guestSource, "normalizeCurrentOrders"), /normalizeComboSnapshot\(item\.combo_snapshot\)[\s\S]*?normalizedItem\.combo_snapshot = comboSnapshot/);
assert.match(functionSource(guestSource, "renderCurrentOrders"), /appendCurrentComboSnapshot\(line, item\)/);
assert.match(functionSource(guestSource, "appendCurrentComboSnapshot"), /comboComponentsOf\(item\)[\s\S]*?component\.is_service[\s\S]*?descriptionOf\(component\)/);

assert.match(inboxSource, /const QR_ORDER_ITEM_COLUMNS = "[^"]*combo_snapshot[^"]*"/);
assert.match(inboxSource, /const QR_ORDER_ITEM_LEGACY_COLUMNS = "(?![^"]*combo_snapshot)[^"]*"/);
assert.match(functionSource(inboxSource, "isMissingComboSnapshotColumn"), /42703[\s\S]*?PGRST204[\s\S]*?combo_snapshot/);
assert.match(functionSource(inboxSource, "fetchWithRelations"), /collectRows\(QR_ORDER_ITEM_COLUMNS\)[\s\S]*?isMissingComboSnapshotColumn\(error\)[\s\S]*?collectRows\(QR_ORDER_ITEM_LEGACY_COLUMNS\)/);
assert.match(functionSource(inboxSource, "fetchWithoutRelations"), /collectItemResults\(QR_ORDER_ITEM_COLUMNS\)[\s\S]*?isMissingComboSnapshotColumn\(result\.error\)[\s\S]*?collectItemResults\(QR_ORDER_ITEM_LEGACY_COLUMNS\)/);
assert.match(functionSource(inboxSource, "comboSnapshotOf"), /if \(!snapshot[\s\S]*?return null[\s\S]*?snapshot\.combo_components/);
assert.match(functionSource(inboxSource, "renderComboSnapshot"), /서비스[\s\S]*?description/);
assert.match(functionSource(inboxSource, "renderItem"), /renderComboSnapshot\(item\)/);
assert.match(functionSource(inboxSource, "renderEditLines"), /renderComboSnapshot\(line\)/);
assert.match(functionSource(inboxSource, "openEditOrder"), /combo_snapshot:\s*line\.combo_snapshot \|\| null/);
assert.match(inboxHtml, /assets\/order-inbox\.js\?v=20261005-combo-menu/);

const inboxFallbackContext = vm.createContext({ result: null, String });
vm.runInContext(`
  ${functionSource(inboxSource, "isMissingComboSnapshotColumn")}
  result = {
    postgresMissing: isMissingComboSnapshotColumn({code:"42703", message:'column "combo_snapshot" does not exist'}),
    postgrestMissing: isMissingComboSnapshotColumn({code:"PGRST204", details:"combo_snapshot is absent from the schema cache"}),
    unrelatedMissing: isMissingComboSnapshotColumn({code:"42703", message:'column "other_column" does not exist'}),
    permissionDenied: isMissingComboSnapshotColumn({code:"42501", message:"combo_snapshot permission denied"})
  };
`, inboxFallbackContext);
assert.deepEqual(JSON.parse(JSON.stringify(inboxFallbackContext.result)), {
  postgresMissing: true,
  postgrestMissing: true,
  unrelatedMissing: false,
  permissionDenied: false,
});

// Components and browser-calculated discounts remain display-only. Ordering
// still sends IDs and quantities so the server owns prices and snapshots.
assert.match(functionSource(guestSource, "buildSubmissionItems"), /\{ menu_item_id, qty \}/);
assert.doesNotMatch(functionSource(guestSource, "buildSubmissionItems"), /combo_|price_|discount_/);

new vm.Script(guestSource, { filename: "assets/qr-menu.js" });
new vm.Script(inboxSource, { filename: "assets/order-inbox.js" });

console.log("QR combo guest search, pricing, detail, snapshot, and compatibility contracts passed.");
