import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(path.join(projectRoot, "assets/admin-tax-report.js"), "utf8");
const context = { console, Map, Set, Object, Array, Number, String, Boolean, Math, JSON };
context.globalThis = context;
vm.runInNewContext(source, context);
const tax = context.DGV_TAX_REPORT;
assert.ok(tax?.buildReport, "tax report builder must be exposed in the browser global");

const orders = [
  { id: "food", status: "paid", total_vnd: 4_800_000, payment_method: "cash" },
  { id: "drink", status: "paid", total_vnd: 930_000, payment_method: "cash" },
  { id: "pending", status: "pending", total_vnd: 999_999, payment_method: "cash" },
  { id: "fee", status: "paid", total_vnd: 214_000, payment_method: "card" },
  { id: "legacy-fee", status: "paid", total_vnd: 108_000, payment_method: "card" },
  { id: "specials", status: "paid", total_vnd: 60_000, payment_method: "cash" }
];

const linesByOrder = new Map([
  ["food", [
    { order_id: "food", line_source: "order_items", kind: "food", ko_name: "무한삼겹", vi_name: "Thịt nướng buffet", qty: 24, unit_vnd: 200_000, line_vnd: 4_800_000 }
  ]],
  ["drink", [
    { order_id: "drink", line_source: "order_items", kind: "drink", qr_category: "drink", ko_name: "맥주", vi_name: "Bia", qty: 13, unit_vnd: 50_000, line_vnd: 650_000 },
    { order_id: "drink", line_source: "order_items", kind: "drink", qr_category: "drink", ko_name: "넵머이", vi_name: "Nếp mới", qty: 1, unit_vnd: 250_000, line_vnd: 250_000 },
    { order_id: "drink", line_source: "order_items", kind: "drink", qr_category: "drink", ko_name: "음료", vi_name: "Nước ngọt", qty: 1, unit_vnd: 30_000, line_vnd: 30_000 }
  ]],
  ["pending", [
    { order_id: "pending", line_source: "order_items", kind: "drink", ko_name: "제외", vi_name: "Loại trừ", qty: 1, unit_vnd: 999_999, line_vnd: 999_999 }
  ]],
  ["fee", [
    { order_id: "fee", line_source: "order_items", kind: "food", ko_name: "음식", vi_name: "Món ăn", qty: 1, unit_vnd: 100_000, line_vnd: 100_000 },
    { order_id: "fee", line_source: "order_items", kind: "drink", qr_category: "drink", ko_name: "콜라", vi_name: "Coca-Cola", qty: 1, unit_vnd: 100_000, line_vnd: 100_000 },
    { order_id: "fee", line_source: "order_custom_items", is_custom: true, kind: "fee7", ko_name: "카드 7%", vi_name: "Phụ phí thẻ", qty: 1, unit_vnd: 14_000, line_vnd: 14_000 }
  ]],
  ["legacy-fee", [
    { order_id: "legacy-fee", line_source: "order_items", kind: "food", ko_name: "구이", vi_name: "Món nướng", qty: 1, unit_vnd: 100_000, line_vnd: 100_000 }
  ]],
  ["specials", [
    { order_id: "specials", line_source: "order_custom_items", is_custom: true, kind: "special", ko_name: "와인", vi_name: "Rượu vang", qty: 1, unit_vnd: 50_000, line_vnd: 50_000 },
    { order_id: "specials", line_source: "order_custom_items", is_custom: true, kind: "special", ko_name: "임시 메뉴", vi_name: "Món tạm", qty: 1, unit_vnd: 10_000, line_vnd: 10_000 }
  ]]
]);

const report = tax.buildReport({ visibleOrders: orders, linesByOrder });
assert.equal(report.paidOrderCount, 5, "pending orders must not be included");
assert.equal(report.paidOrderGross, 6_112_000);
assert.equal(report.lineGross, 6_104_000, "raw paid line total must be retained for audit");
assert.equal(report.reconciliationDifference, 0, "tax groups must preserve paid order gross exactly");
assert.equal(report.groups.reduce((sum, group) => sum + group.grossAmount, 0), report.paidOrderGross);

const food = report.groups.find((group) => group.key === "food8");
const drink = report.groups.find((group) => group.key === "drink10");
assert.ok(food && drink);

const referenceReport = tax.buildReport({ visibleOrders: orders.slice(0, 2), linesByOrder });
const referenceFood = referenceReport.groups.find((group) => group.key === "food8");
const referenceDrink = referenceReport.groups.find((group) => group.key === "drink10");
assert.deepEqual(
  { net: referenceFood.netAmount, vat: referenceFood.vatAmount, gross: referenceFood.grossAmount },
  { net: 4_444_440, vat: 355_560, gross: 4_800_000 }
);
assert.deepEqual(
  { net: referenceDrink.netAmount, vat: referenceDrink.vatAmount, gross: referenceDrink.grossAmount },
  { net: 845_448, vat: 84_552, gross: 930_000 }
);

const buffet = food.rows.find((row) => row.koName === "무한삼겹");
assert.deepEqual(
  { unit: buffet.netUnit, net: buffet.netAmount, vat: buffet.vatAmount, gross: buffet.grossAmount, unitVi: buffet.unitVi },
  { unit: 185_185, net: 4_444_440, vat: 355_560, gross: 4_800_000, unitVi: "Phần" },
  "8% row must reproduce the supplied invoice example"
);

const beer = drink.rows.find((row) => row.koName === "맥주" && row.grossUnit === 50_000);
const liquor = drink.rows.find((row) => row.koName === "넵머이");
const softDrink = drink.rows.find((row) => row.koName === "음료");
assert.deepEqual(
  { unit: beer.netUnit, net: beer.netAmount, unitVi: beer.unitVi },
  { unit: 45_454, net: 590_902, unitVi: "Lon" }
);
assert.deepEqual(
  { unit: liquor.netUnit, net: liquor.netAmount, unitVi: liquor.unitVi },
  { unit: 227_273, net: 227_273, unitVi: "Chai" }
);
assert.deepEqual(
  { unit: softDrink.netUnit, net: softDrink.netAmount, unitVi: softDrink.unitVi },
  { unit: 27_273, net: 27_273, unitVi: "Lon" }
);
assert.equal(beer.netAmount + liquor.netAmount + softDrink.netAmount, 845_448);
assert.equal((beer.vatAmount + liquor.vatAmount + softDrink.vatAmount), 84_552);

const explicitFoodFee = food.rows.find((row) => row.koName === "카드 결제 수수료" && row.grossAmount === 7_000);
const explicitDrinkFee = drink.rows.find((row) => row.koName === "카드 결제 수수료" && row.grossAmount === 7_000);
assert.ok(explicitFoodFee && explicitDrinkFee, "explicit card fee must be allocated exactly across both tax groups");
assert.ok(food.rows.some((row) => row.koName === "카드 결제 수수료" && row.grossAmount === 8_000), "legacy card difference must also be retained");

assert.equal(tax.classifyLine({ line_source: "order_custom_items", is_custom: true, kind: "special", ko_name: "커피" }).rate, 10);
assert.equal(tax.classifyLine({ line_source: "order_custom_items", is_custom: true, kind: "special", ko_name: "차돌박이" }).rate, 8, "single-syllable drink keywords must not match food substrings");
assert.equal(tax.classifyLine({ line_source: "order_custom_items", is_custom: true, kind: "special", ko_name: "물냉면" }).rate, 8);
assert.equal(tax.classifyLine({ line_source: "order_items", kind: "cafe" }).rate, 10);
assert.equal(tax.classifyLine({ line_source: "order_items", kind: "food", qr_category: "cafe" }).rate, 10);
assert.equal(tax.classifyLine({ line_source: "order_items", kind: "food", qr_category: "drink" }).rate, 10);
assert.equal(tax.classifyLine({ line_source: "order_items", kind: "alcohol", ko_name: "주류" }).rate, 10);
assert.equal(tax.classifyLine({ line_source: "order_items", kind: "beer", ko_name: "맥주" }).rate, 10);
assert.equal(tax.classifyLine({ line_source: "order_items", kind: "food", ko_name: "하이볼" }).rate, 10);
assert.equal(tax.classifyLine({ line_source: "order_items", kind: "food", vi_name: "Rượu vang" }).rate, 10);
assert.equal(tax.classifyLine({ line_source: "order_items", kind: "other", qr_category: "combo", ko_name: "맥주와 치킨 콤보" }).rate, 8, "mixed combo rows must not be arbitrarily assigned wholly to 10%");
assert.equal(tax.classifyLine({ line_source: "order_custom_items", is_custom: true, kind: "drink" }).rate, 10);
assert.equal(tax.classifyLine({ line_source: "order_items", is_custom: true, kind: "custom", ko_name: "소주" }).rate, 10);
assert.equal(tax.classifyLine({ line_source: "order_items", is_custom: true, kind: "custom", vi_name: "Rượu vang" }).rate, 10);
assert.equal(tax.classifyLine({ line_source: "order_items", kind: "food" }).rate, 8);
const unknownSpecial = food.rows.find((row) => row.koName === "임시 메뉴");
assert.equal(unknownSpecial.reviewNeeded, true);
assert.ok(report.reviewRows.some((row) => row.koName === "임시 메뉴"));
assert.ok(report.warnings.some((warning) => warning.includes("legacy-fee")), "order/line differences must remain auditable");

const oddAllocation = tax.allocateInteger(5, { food8: 1, drink10: 1 });
assert.equal(oddAllocation.food8 + oddAllocation.drink10, 5, "proportional allocation must preserve every VND");

console.log("admin tax report unit regression passed");


