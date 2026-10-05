import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFile(path.join(projectRoot, file), "utf8");
const [adminHtml, adminSource, staffCss] = await Promise.all([
  read("menu_admin.html"),
  read("assets/menu-admin.js"),
  read("assets/qr-staff.css"),
]);

function functionSource(source, name) {
  const match = source.match(new RegExp(`^  (?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^  \\}$`, "m"));
  assert.ok(match, `missing function ${name}`);
  return match[0];
}

const categorySelect = adminHtml.match(/<select class="qr-select" id="qrCategory"[^>]*>([\s\S]*?)<\/select>/)?.[1] || "";
assert.ok(categorySelect.indexOf('value="combo"') >= 0, "combo category option is missing");
assert.ok(
  categorySelect.indexOf('value="combo"') < categorySelect.indexOf('value="single"'),
  "combo category must be displayed first",
);

for (const id of [
  "comboEditor", "comboMenuSearch", "comboMenuSelect", "comboExistingQty", "addComboMenuBtn",
  "comboServiceKoName", "comboServiceViName", "comboServiceEnName", "comboServiceQty",
  "comboServicePriceVnd", "comboServicePriceUsd", "comboServiceDescriptionKo",
  "comboServiceDescriptionVi", "comboServiceDescriptionEn", "addComboServiceBtn",
  "comboComponentList", "comboRegularVnd", "comboSaleVnd", "comboSavingVnd", "comboEditorStatus",
]) assert.match(adminHtml, new RegExp(`id="${id}"`), `missing combo admin control ${id}`);

assert.match(adminSource, /QR_CATEGORY_ORDER = Object\.freeze\(\{ combo: 0, single: 10/);
assert.match(adminSource, /qrCategory === "combo" \? "other"/);
assert.match(adminSource, /app_get_menu_combo_components"[\s\S]*?p_combo_item_id/);
assert.match(adminSource, /app_create_menu_item"[\s\S]*?createMenuPayload\(next\)/);
assert.match(adminSource, /app_update_menu_item"[\s\S]*?p_patch: patch/);
assert.match(adminSource, /if \(item\.qr_category === "combo"\)[\s\S]*?payload\.combo_components/);
assert.match(adminSource, /if \(next\.qr_category === "combo"[\s\S]*?patch\.combo_components/);
assert.match(adminSource, /menu\.id === selectedId \|\| menu\.qr_category === "combo"/);
assert.match(adminSource, /MAX_COMBO_COMPONENTS = 20/);
assert.match(adminSource, /MAX_COMBO_COMPONENT_QTY = 20/);
assert.match(adminSource, /MAX_COMBO_TOTAL_QTY = 100/);
assert.match(adminSource, /comboFeatureAvailable === false[\s\S]*?DB 배포/);
assert.match(functionSource(adminSource, "comboComponentImageUrl"), /comboSourceMenu\(component\)[\s\S]*?safePreviewUrl/);
assert.match(functionSource(adminSource, "renderExistingComboComponent"), /comboComponentImageUrl\(component\)[\s\S]*?qr-combo-component-thumb[\s\S]*?escapeHTML\(imageUrl\)/);

const payloadContext = {
  Date,
  JSON,
  Math,
  Number,
  String,
  MAX_COMBO_COMPONENTS: 20,
  MAX_COMBO_COMPONENT_QTY: 20,
  global: { crypto: { randomUUID: () => "11111111-1111-4111-8111-111111111111" } },
};
vm.runInNewContext(
  `${functionSource(adminSource, "nullIfBlank")}
  ${functionSource(adminSource, "comboClientId")}
  ${functionSource(adminSource, "optionalNonNegativeInteger")}
  ${functionSource(adminSource, "comboMenuItemId")}
  ${functionSource(adminSource, "normalizedComboComponent")}
  ${functionSource(adminSource, "normalizedComboComponents")}
  ${functionSource(adminSource, "comboComponentForPayload")}
  ${functionSource(adminSource, "comboComponentsForPayload")}
  result = comboComponentsForPayload([
    {kind:"menu",source_menu_item_id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",qty:2,name_ko:"서버명",unit_price_vnd:50000},
    {kind:"service",name_ko:"계란찜",name_en:"Steamed egg",description_ko:"서비스",qty:1,reference_price_vnd:10000,reference_price_usd:null}
  ]);`,
  payloadContext,
);
assert.deepEqual(JSON.parse(JSON.stringify(payloadContext.result)), [
  { kind: "menu", menu_item_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", qty: 2 },
  {
    kind: "service",
    ko_name: "계란찜",
    vi_name: null,
    en_name: "Steamed egg",
    description_ko: "서비스",
    description_vi: null,
    description_en: null,
    qty: 1,
    original_price_usd: null,
    original_price_vnd: 10000,
  },
], "admin payload must omit client-derived names/prices for existing menu components");

const totalContext = {
  Math,
  Number,
  MAX_COMBO_COMPONENT_QTY: 20,
  draftComboComponents: [],
  ui: { byId: () => ({ value: "0" }) },
  comboComponentUnitPrices: (component) => ({ vnd: component.vnd, usd: component.usd }),
};
vm.runInNewContext(
  `${functionSource(adminSource, "nonNegativeInteger")}
  ${functionSource(adminSource, "calculateComboTotals")}
  result = calculateComboTotals([{qty:2,vnd:50000,usd:2},{qty:1,vnd:10000,usd:1}], 90000, 4);`,
  totalContext,
);
assert.deepEqual(JSON.parse(JSON.stringify(totalContext.result)), {
  regular: { vnd: 110000, usd: 5 },
  combo: { vnd: 90000, usd: 4 },
  saving: { vnd: 20000, usd: 1 },
  percent: 18.2,
});

for (const selector of [
  ".qr-combo-editor", ".qr-combo-component", ".qr-combo-summary", ".qr-combo-service-grid",
  ".qr-combo-component-overview.has-image", ".qr-combo-component-thumb",
]) assert.match(staffCss, new RegExp(selector.replaceAll(".", "\\.")), `missing combo CSS ${selector}`);

console.log("Menu-admin combo editor contracts passed.");
