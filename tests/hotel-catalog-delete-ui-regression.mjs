import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [source, html] = await Promise.all(["assets/hotel-reserv-list.js", "hotel_reserv_list.html"].map(file => readFile(path.join(root, file), "utf8")));
new vm.Script(source);
assert.match(html, /id="catalogError"[^>]*role="alert"/);
assert.match(html, /hotel-reserv-list\.js\?v=20261108-status-1/);
assert.match(source, /table\("hotel_room_types"\)\.select\("\*"\)/);
assert.match(source, /table\("hotel_room_grades"\)\.select\("\*"\)/);
assert.doesNotMatch(source, /table\("hotel_room_(?:types|grades)"\)\.select\("\*"\)\.(?:is|eq)\("archived_at"/);
assert.doesNotMatch(source, /from\("hotel_room_(?:types|grades)"\)\.delete/);

function fn(name) {
  const start = source.search(new RegExp(`  (?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  const next = source.slice(start + 3).search(/\n  (?:async )?function \w+\(/);
  assert.ok(next >= 0, name + " next");
  return source.slice(start, start + 3 + next);
}
class Node {
  constructor(tag = "div") { this.tag = tag; this.children = []; this.dataset = {}; this.events = {}; this.options = []; this.style = {}; this.value = ""; this.textContent = ""; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; this.textContent = ""; }
  add(option) { this.options.push(option); }
  setAttribute(name, value) { this[name] = value; }
  addEventListener(name, handler) { this.events[name] = handler; }
  setCustomValidity(value) { this.validationMessage = value; }
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
}
const allNodes = node => [node, ...node.children.filter(item => item instanceof Node).flatMap(allNodes)];
const roomKinds = ["SINGLE", "DOUBLE", "TRIPLE"];
const rateKeys = ["weekday_purchase", "weekday_sale", "weekend_purchase", "weekend_sale"];
const grades = [{ id: "live", hotel_id: "hotel", name: "Deluxe", version: 8 }, { id: "gone", hotel_id: "hotel", name: "Old Suite", version: 9, archived_at: "2026-11-07" }];
const types = roomKinds.map((room_kind, index) => ({ id: "live-" + room_kind, hotel_id: "hotel", grade_id: "live", grade_name: "Deluxe", room_kind, name: room_kind, version: index + 2, is_active: index !== 1, archived_at: index === 1 ? "2026-11-07" : null, weekday_purchase: 100, weekday_sale: 200, weekend_purchase: 300, weekend_sale: 400 }));
types.push({ id: "gone-SINGLE", hotel_id: "hotel", grade_id: "gone", name: "SINGLE", room_kind: "SINGLE", is_active: true, version: 5 });
types.push({ id: "legacy-live", hotel_id: "hotel", name: "Doble", grade_id: null, is_active: true, version: 1 });
types.push({ id: "legacy-gone", hotel_id: "hotel", name: "Deleted Doble", grade_id: null, is_active: true, version: 2, archived_at: "2026-11-07" });

const nodes = Object.fromEntries(["roomTypeRows", "gradeTypeRows", "gradeFormTitle", "legacyRoomNotice", "roomItemsFields", "roomItemRows"].map(id => [id, new Node()]));
const action = (text, handler) => { const button = new Node("button"); button.textContent = text; button.events.click = handler; return button; };
const context = {
  byId: id => nodes[id], document: { createElement: tag => new Node(tag), createTextNode: text => text },
  roomTypes: structuredClone(types), roomGrades: structuredClone(grades), roomKinds, rateKeys, managedHotel: { id: "hotel" },
  moneyText: value => value + " VND", roomKindLabel: kind => kind, action, busy: false,
  archiveRoomType() {}, archiveRoomGrade() {}, resetRoomType() {}, toggleRoomType() {},
  gradeForm: { hidden: false, reset() {}, elements: { namedItem: () => context.gradeName } }, gradeName: { value: "Deluxe" },
  roomTypeForm: { hidden: true }, crypto: { randomUUID: () => "new-grade" }, message() {},
  editingGrade: null, gradeId: null, gradeDraft: [], pricing: { money: value => Number(value) },
  Option: class { constructor(text, value) { this.text = text; this.value = value; } }
};
vm.runInNewContext([fn("rawMoneyInput"), fn("formatMoneyInput"), fn("enableMoneyInput"), fn("renderRoomTypes"), fn("resetGrade"), fn("renderGradeTypes"), fn("gradePayload"), "this.renderCatalog=renderRoomTypes;this.reset=resetGrade;this.payload=gradePayload;"].join("\n"), context);
context.renderCatalog();
let rendered = allNodes(nodes.roomTypeRows);
assert.deepEqual(rendered.filter(node => node.dataset.catalogGradeId).map(node => node.dataset.catalogGradeId), ["live"]);
assert.deepEqual(rendered.filter(node => node.dataset.catalogTypeId).map(node => node.dataset.catalogTypeId), ["live-SINGLE", "live-TRIPLE", "legacy-live"]);
assert.equal(rendered.filter(node => node.tag === "button" && /타입 삭제/.test(node.textContent)).length, 2);
assert.equal(rendered.filter(node => node.tag === "button" && /등급 삭제/.test(node.textContent)).length, 1);
context.reset(context.roomGrades[0]);
assert.equal(context.gradeDraft.length, 3);
assert.equal(context.gradeDraft[1].archived_at, "2026-11-07");
assert.equal(context.gradeDraft[1].is_active, false);
assert.equal(context.gradeDraft[1].version, 3);
assert.deepEqual(nodes.gradeTypeRows.children.map(node => node.dataset.roomKind), ["SINGLE", "TRIPLE"]);
context.gradeDraft[1].is_active = true;
let payload = context.payload();
assert.equal(payload.p_types.length, 3, "archived members remain in the atomic CAS payload");
assert.equal(payload.p_types[1].is_active, false, "even an accidentally toggled draft must not restore an archived member");
assert.equal(payload.p_types[1].version, 3);
assert.equal(payload.p_types[1].weekend_sale, 400);

const saved = { room_type_id: "live-DOUBLE", room_type_version: 1, name: "Original Double", room_grade: "Original Deluxe", grade_id: "live", room_kind: "DOUBLE", room_count: 2 };
const rowContext = {
  ...context, useRoomTypes: true, field: name => name === "hotel_id" ? { value: "hotel" } : new Node(),
  roomItems: [{ room_type_id: "", room_count: 1 }], editing: null, updatePreview() {}
};
vm.runInNewContext(fn("renderRoomItems") + "\nthis.run=renderRoomItems;", rowContext);
const selectFor = (index, fieldIndex) => nodes.roomItemRows.children[index].children[fieldIndex].children[1];
rowContext.run();
assert.deepEqual(selectFor(0, 0).options.map(option => option.value), ["", "live", "legacy"]);
rowContext.roomItems[0].selected_grade_id = "live";
rowContext.run();
assert.deepEqual(selectFor(0, 1).options.map(option => option.value), ["", "live-SINGLE", "live-TRIPLE"]);
rowContext.roomItems = [structuredClone(saved)];
rowContext.editing = { room_items: [structuredClone(saved)] };
rowContext.run();
assert.equal(selectFor(0, 1).value, "live-DOUBLE");
assert.match(selectFor(0, 1).options.at(-1).text, /삭제됨.*đã xóa/);
assert.equal(rowContext.roomItems[0].room_grade, "Original Deluxe");
assert.equal(rowContext.roomItems[0].room_type_version, 1);
rowContext.roomItems = [{ room_type_id: "legacy-gone", room_count: 1, name: "Original Legacy", room_grade: "VIP" }];
rowContext.editing = { room_items: structuredClone(rowContext.roomItems) };
rowContext.run();
assert.equal(selectFor(0, 0).value, "legacy");
assert.match(selectFor(0, 1).options.at(-1).text, /Original Legacy.*삭제됨/);
assert.equal(rowContext.roomItems[0].room_grade, "VIP");
rowContext.roomItems = [{ room_type_id: "gone-SINGLE", room_count: 1, grade_id: "gone", room_kind: "SINGLE", room_grade: "Old Saved Grade" }];
rowContext.editing = { room_items: structuredClone(rowContext.roomItems) };
rowContext.run();
assert.match(selectFor(0, 0).options.at(-1).text, /Old Saved Grade.*삭제됨/);

const rpcCalls = [], messages = [], resets = [], confirms = [];
let accepted = false;
const handlerContext = {
  roomTypes: structuredClone(types), roomGrades: structuredClone(grades), busy: false, ready: true,
  gradeForm: { hidden: false }, roomTypeForm: { hidden: true }, editingGrade: { id: "unrelated-draft" }, editingRoomType: null,
  roomKindLabel: kind => kind, confirm: text => { confirms.push(text); return accepted; },
  setBusy: value => { handlerContext.busy = value; }, message: (...args) => messages.push(args), errorText: error => error.message,
  resetGrade: grade => resets.push(grade?.id || "new"), refresh: async () => { handlerContext.ready = true; },
  DGV: { supabase: { rpc: async (name, data) => { rpcCalls.push({ name, data }); return { data: {}, error: null }; } } }
};
vm.runInNewContext(fn("archiveRoomType") + "\n" + fn("archiveRoomGrade") + "\nthis.typeDelete=archiveRoomType;this.gradeDelete=archiveRoomGrade;", handlerContext);
await handlerContext.typeDelete(handlerContext.roomTypes[0]);
assert.equal(rpcCalls.length, 0, "cancel must not mutate the catalog");
assert.match(confirms[0], /기존 예약.*유지.*\n.*đặt phòng cũ.*giữ nguyên/);
accepted = true;
await handlerContext.typeDelete(handlerContext.roomTypes[0]);
assert.equal(rpcCalls[0].name, "archive_hotel_room_type");
assert.equal(rpcCalls[0].data.p_expected_version, 2);
assert.equal(resets.length, 0, "unrelated unsaved grade draft must be preserved");
handlerContext.editingGrade = { id: "live" };
await handlerContext.typeDelete(handlerContext.roomTypes[0]);
assert.deepEqual(resets, ["live"]);
await handlerContext.gradeDelete(handlerContext.roomGrades[0]);
payload = rpcCalls.at(-1);
assert.equal(payload.name, "archive_hotel_room_grade");
assert.equal(payload.data.p_expected_version, 8);
assert.deepEqual(Array.from(payload.data.p_type_versions, row => row.id), ["live-SINGLE", "live-DOUBLE", "live-TRIPLE"]);
assert.deepEqual(Array.from(payload.data.p_type_versions, row => row.version), [2, 3, 4]);
assert.equal(resets.at(-1), "new");
assert.match(confirms.at(-1), /포함된 모든 룸타입.*\n.*tất cả loại phòng/);
const callCount = rpcCalls.length;
await handlerContext.typeDelete(handlerContext.roomTypes[1]);
await handlerContext.gradeDelete(handlerContext.roomGrades[1]);
assert.equal(rpcCalls.length, callCount, "already archived targets are never restored or deleted again");
handlerContext.DGV.supabase.rpc = async () => ({ error: { message: "concurrent update" } });
await handlerContext.typeDelete(handlerContext.roomTypes[0]);
assert.deepEqual(messages.at(-1), ["catalogError", "concurrent update"]);
assert.equal(handlerContext.busy, false);

console.log("Hotel catalog delete UI: archive RPC/CAS, cancellation, editor isolation, archived selection and historical snapshot regression passed.");

