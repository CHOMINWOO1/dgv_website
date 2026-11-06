import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [html, source, pricingSource] = await Promise.all(["hotel_reserv_list.html", "assets/hotel-reserv-list.js", "assets/hotel-pricing.js"].map(file => readFile(path.join(root, file), "utf8")));
new vm.Script(source);
assert.match(html, /id="gradeForm"/);
assert.match(html, /id="gradeTypeRows"/);
assert.match(source, /rpc\("save_hotel_room_grade", data\)/);
assert.match(source, /table\("hotel_room_grades"\)\.select\("\*"\)/);
assert.match(source, /const legacyTypes = types\.filter\(type => !type\.grade_id\)/);
assert.match(source, /기존 룸타입 \/ Loại phòng cũ/);
assert.doesNotMatch(source, /gradeSelect\.add\(new Option\("VIP"/);
assert.doesNotMatch(source, /innerHTML\s*=/);
assert.match(source, /room_type_version: item\.room_type_version/);

const pricingContext = { window: {}, Date, Number, String, Object, Array, Math, JSON };
vm.runInNewContext(pricingSource, pricingContext);
const pricing = pricingContext.window.HotelPricing;
function fn(name, next) {
  const start = source.indexOf(`  function ${name}(`);
  const end = source.indexOf(`  function ${next}(`, start + 1);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}
const roomKinds = ["SINGLE", "DOUBLE", "TRIPLE"];
const rateKeys = ["weekday_purchase", "weekday_sale", "weekend_purchase", "weekend_sale"];
const draft = roomKinds.map((room_kind, index) => ({ room_kind, is_active: index < 2, version: index + 2, weekday_purchase: "100", weekday_sale: "200", weekend_purchase: "300", weekend_sale: "400", sameWeekend: false }));
const payloadContext = {
  gradeForm: { elements: { namedItem: () => ({ value: "  Deluxe  " }) } },
  managedHotel: { id: "hotel-1" }, gradeId: "grade-1", editingGrade: { version: 7 }, gradeDraft: draft, rateKeys, pricing
};
vm.runInNewContext(`${fn("gradePayload", "resetRoomType")}\nthis.run=gradePayload;`, payloadContext);
const payload = payloadContext.run();
assert.equal(payload.p_name, "Deluxe");
assert.equal(payload.p_hotel_id, "hotel-1");
assert.equal(payload.p_id, "grade-1");
assert.equal(payload.p_expected_version, 7);
assert.equal(payload.p_types.length, 3);
assert.deepEqual(Array.from(payload.p_types, item => item.room_kind), roomKinds);
assert.deepEqual(Array.from(payload.p_types, item => item.version), [2, 3, 4]);
assert.equal(payload.p_types[2].is_active, false);
assert.equal(payload.p_types[1].weekend_sale, 400);
assert.equal("sameWeekend" in payload.p_types[0], false, "UI-only settings must not enter the RPC payload");
payloadContext.gradeDraft = draft.map(item => ({ ...item, is_active: false }));
assert.equal(payloadContext.run().p_types.length, 3, "existing grades may retire all types atomically");
payloadContext.editingGrade = null;
assert.throws(() => payloadContext.run(), /한 가지/);
payloadContext.gradeDraft[0].is_active = true;
assert.equal(payloadContext.run().p_expected_version, null);
payloadContext.gradeDraft[0].weekday_purchase = "1.5";
assert.throws(() => payloadContext.run());

class Node {
  constructor(tag = "div") { this.tag = tag; this.children = []; this.dataset = {}; this.events = {}; this.options = []; this.value = ""; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  add(option) { this.options.push(option); }
  setAttribute(name, value) { this[name] = value; }
  addEventListener(name, handler) { this.events[name] = handler; }
}
const nodes = { legacyRoomNotice: new Node(), roomItemsFields: new Node(), roomItemRows: new Node() };
const fields = { room_count: new Node(), hotel_id: { value: "hotel-1" } };
const grades = [{ id: "g1", hotel_id: "hotel-1", name: "Deluxe" }, { id: "g2", hotel_id: "hotel-1", name: "Suite" }];
const types = [
  { id: "single", hotel_id: "hotel-1", grade_id: "g1", grade_name: "Deluxe", room_kind: "SINGLE", name: "Single", version: 3, is_active: true },
  { id: "double", hotel_id: "hotel-1", grade_id: "g1", grade_name: "Deluxe", room_kind: "DOUBLE", name: "Double", version: 4, is_active: true },
  { id: "triple", hotel_id: "hotel-1", grade_id: "g1", grade_name: "Deluxe", room_kind: "TRIPLE", name: "Triple", version: 5, is_active: false },
  { id: "suite", hotel_id: "hotel-1", grade_id: "g2", grade_name: "Suite", room_kind: "DOUBLE", name: "Double", version: 6, is_active: true },
  { id: "legacy", hotel_id: "hotel-1", grade_id: null, room_kind: null, name: "Doble", version: 1, is_active: true }
];
const rowContext = {
  byId: id => nodes[id], field: name => fields[name], useRoomTypes: true, roomTypes: types, roomGrades: grades, roomKinds,
  roomItems: [{ room_type_id: "double", room_count: 2, room_grade: "Old Deluxe", grade_id: "g1", room_kind: "DOUBLE" }],
  editing: { room_items: [{ room_type_id: "double", room_count: 2, room_grade: "Old Deluxe", grade_id: "g1", room_kind: "DOUBLE" }] },
  roomKindLabel: value => value, document: { createElement: tag => new Node(tag) }, Option: class { constructor(text, value) { this.text = text; this.value = value; } },
  action: (label, handler) => { const button = new Node("button"); button.textContent = label; button.events.click = handler; return button; }, updatePreview: () => {}, busy: false
};
vm.runInNewContext(`${fn("renderRoomItems", "openReservation")}\nthis.run=renderRoomItems;`, rowContext);
rowContext.run();
const selectFor = (line, index) => line.children[index].children[1];
let line = nodes.roomItemRows.children[0];
assert.equal(selectFor(line, 0).value, "g1");
assert.deepEqual(selectFor(line, 1).options.map(option => option.value), ["", "single", "double"]);
assert.equal(rowContext.roomItems[0].room_grade, "Old Deluxe", "rendering catalog names must not mutate saved grade snapshots");
selectFor(line, 0).value = "g2";
selectFor(line, 0).events.change();
line = nodes.roomItemRows.children[0];
assert.deepEqual(selectFor(line, 1).options.map(option => option.value), ["", "suite"]);
assert.equal(rowContext.roomItems[0].room_type_id, "", "changing a grade requires an explicit type selection");
selectFor(line, 1).value = "suite";
selectFor(line, 1).events.change();
assert.equal(rowContext.roomItems[0].room_grade, "Suite");
assert.equal(rowContext.roomItems[0].room_type_version, 6);
rowContext.roomItems = [{ room_type_id: "legacy", room_count: 1, room_grade: "VIP" }];
rowContext.editing = { room_items: [{ room_type_id: "legacy", room_count: 1, room_grade: "VIP" }] };
rowContext.run();
line = nodes.roomItemRows.children[0];
assert.equal(selectFor(line, 0).value, "legacy");
assert.equal(selectFor(line, 1).options[1].text, "Doble");
assert.equal(rowContext.roomItems[0].room_grade, "VIP", "legacy grades must never be invented or reclassified");

console.log("Hotel grade UI, atomic payload, fixed-type selection and legacy preservation regression passed.");
