import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [html, source, priceSource] = await Promise.all([
  "hotel_reserv_list.html", "assets/hotel-reserv-list.js", "assets/hotel-pricing.js"
].map(file => readFile(path.join(root, file), "utf8")));
new vm.Script(source);
const ids = Array.from(html.matchAll(/\bid="([^"]+)"/g), match => match[1]);
assert.equal(new Set(ids).size, ids.length, "HTML IDs must remain unique");
for (const id of ["roomTypeDialog", "roomTypeForm", "roomItemRows", "enableRoomTypesButton", "printHotelListButton", "excelHotelListButton", "hotelDetailDialog", "hotelDetailContent", "editHotelDetailButton", "deleteHotelDetailButton"]) assert.ok(ids.includes(id));
const propertyForm = html.slice(html.indexOf('<form id="propertyForm">'), html.indexOf('</form>', html.indexOf('<form id="propertyForm">')));
assert.doesNotMatch(propertyForm, /name="(?:weekday|weekend)_(?:purchase|sale)"/, "hotel registration must no longer ask hotel-wide rates");
const roomTypeForm = html.slice(html.indexOf('<form id="roomTypeForm">'), html.indexOf('</form>', html.indexOf('<form id="roomTypeForm">')));
for (const field of ["weekday_purchase", "weekday_sale", "weekend_purchase", "weekend_sale"]) assert.ok(roomTypeForm.includes(`name="${field}"`));
assert.match(html, /name="room_count"[^>]*readonly/);
assert.match(html, /name="note"[^>]*maxlength="5000"/);
assert.match(source, /roles:\s*\["manager",\s*"admin"\]/);
assert.match(source, /\.eq\("version", previous\.version\)/);
assert.match(source, /if \(!editingHotel\)[^\n]+data\[key\] = 0/, "only newly registered hotels should receive zero legacy-rate defaults");
assert.match(source, /persist\("hotel_room_types", \{ is_active: active \}, type, type.id\)/);
assert.match(source, /if \(!editingRoomType\) data\.hotel_id = managedHotel\.id/, "immutable hotel_id must not be sent in room-type UPDATE requests");
assert.match(source, /roomItems\.length >= 100/);
assert.doesNotMatch(source, /innerHTML\s*=/, "user data must be inserted as text, not executable markup");
const reservationRender = source.slice(source.indexOf('const body = renderRows("hotelRows"'), source.indexOf('byId("listCount").textContent'));
assert.doesNotMatch(reservationRender, /controls\.append|action\("수정|action\("삭제/, "reservation rows should no longer contain edit/delete buttons");
assert.match(reservationRender, /row\.tabIndex = 0/);
assert.match(reservationRender, /event\.key !== "Enter" && event\.key !== " "/);
assert.match(reservationRender, /window\.getSelection\(\)/, "selecting text must not unexpectedly open a dialog");
assert.match(source, /remove\("hotel_reservations", latest, "hotelDetailError"\)/);

const priceContext = { window: {}, Date, Number, String, JSON, Object, Array, Math };
vm.runInNewContext(priceSource, priceContext);
const pricing = priceContext.window.HotelPricing;
function functionText(name, nextName) {
  const start = source.indexOf(`  function ${name}(`);
  const asyncStart = source.indexOf(`  async function ${name}(`);
  const actualStart = start >= 0 ? start : asyncStart;
  const candidates = [`  function ${nextName}(`, `  async function ${nextName}(`].map(marker => source.indexOf(marker, actualStart + 1)).filter(index => index >= 0);
  assert.ok(actualStart >= 0 && candidates.length);
  return source.slice(actualStart, Math.min(...candidates));
}

function dataContext({ mixed = true, deposit = "", balance = "0" } = {}) {
  const values = {
    hotel_id: "h1", check_in: "2026-11-08", check_out: "2026-11-09", guest_names: " Guest A\nGuest B ", guest_count: "3", room_count: "1",
    pricing_mode: "standard", room_purchase_amount: "0", room_sale_amount: "0", meal_purchase_amount: "0", meal_sale_amount: "0",
    deposit_amount: deposit, balance_amount: balance, note: '<img src=x onerror="alert(1)">'
  };
  const context = {
    Object, Number, String, pricing, form: {},
    FormData: class { [Symbol.iterator]() { return Object.entries(values)[Symbol.iterator](); } },
    field: key => ({ value: values[key], checked: false }), useRoomTypes: mixed,
    roomItems: [{ room_type_id: "rt1", room_count: "2", room_grade: "STANDARD", room_type_version: 3 }, { room_type_id: "rt2", room_count: 1, room_grade: "VIP", room_type_version: 4 }]
  };
  vm.runInNewContext(`${functionText("reservationData", "preview")}\nthis.run=reservationData;`, context);
  return context;
}
const mixed = dataContext().run();
assert.equal(mixed.room_count, 3);
assert.equal(mixed.room_items.length, 2);
assert.equal(mixed.room_items[1].room_grade, "VIP");
assert.equal(mixed.deposit_amount, null, "blank deposit must not become zero");
assert.equal(mixed.balance_amount, 0, "explicit zero must be retained");
assert.equal(mixed.guest_names, "Guest A\nGuest B");
assert.equal(mixed.note, '<img src=x onerror="alert(1)">', "free text is preserved, then safely rendered as text");
assert.equal("room_items" in dataContext({ mixed: false }).run(), false, "legacy editing must not silently replace null room_items");
assert.throws(() => dataContext({ deposit: "1.5" }).run());

const hotel = { id: "h1", version: 3, weekend_days: [0, 6], weekday_purchase: 100, weekday_sale: 200, weekend_purchase: 300, weekend_sale: 400 };
const roomTypes = [
  { id: "rt1", hotel_id: "h1", version: 3, name: "Double", is_active: true, weekday_purchase: 500, weekday_sale: 600, weekend_purchase: 700, weekend_sale: 800 },
  { id: "rt2", hotel_id: "h1", version: 4, name: "Twin", is_active: true, weekday_purchase: 900, weekday_sale: 1000, weekend_purchase: 1100, weekend_sale: 1200 }
];
const previewContext = { hotels: [hotel], roomTypes, editing: null, pricing, Error };
vm.runInNewContext(`${functionText("preview", "updatePreview")}\nthis.run=preview;`, previewContext);
const preview = previewContext.run(mixed);
assert.equal(preview.roomCount, 3);
assert.equal(preview.roomPurchase, 2500);
assert.equal(preview.roomSale, 2800);
const previous = { ...mixed, room_items: preview.items, rate_snapshot: preview.rates, room_purchase_amount: 2500, room_sale_amount: 2800 };
previewContext.editing = previous;
previewContext.roomTypes = roomTypes.map(type => ({ ...type, weekend_purchase: 99999, weekend_sale: 99999, is_active: false }));
const preserved = previewContext.run({ ...mixed, note: "changed only note" });
assert.equal(preserved.roomPurchase, 2500, "unrelated edits must keep saved room snapshots after catalog price changes");
assert.equal(preserved.roomSale, 2800);

function printContext({ empty = false, failed = false, blocked = false, invalidPeriod = false } = {}) {
  const events = [];
  const period = { fromDate: "2026-11-08", toDate: "2026-11-09" };
  const popup = { closed: false, document: { write: text => events.push(["write", text]), close: () => {}, open: () => {}, fonts: { ready: Promise.resolve() } }, close() { this.closed = true; events.push("close"); }, focus: () => {}, print: () => events.push("print") };
  const context = {
    busy: false, ready: true, reservations: [], appliedPeriod: period, Promise, Error,
    applyPeriodDraft: () => { events.push("period"); return !invalidPeriod; },
    window: { open: () => { events.push("open"); return blocked ? null : popup; } },
    setBusy: value => { context.busy = value; },
    refresh: async () => { events.push("refresh"); context.ready = !failed; context.reservations = empty ? [] : [{ id: "latest-row" }]; },
    HotelReport: {
      filterRows: (rows, selectedPeriod) => { assert.equal(JSON.stringify(selectedPeriod), JSON.stringify(period)); events.push("filter"); return rows; },
      renderHtml: (rows, selectedPeriod) => { assert.equal(rows[0].id, "latest-row"); assert.equal(JSON.stringify(selectedPeriod), JSON.stringify(period)); events.push("render"); return "<html>latest</html>"; }
    },
    errorText: error => error.message, message: (_id, value) => events.push(["message", value]), alert: value => events.push(["alert", value]),
    setTimeout: callback => { callback(); return 1; }
  };
  vm.runInNewContext(`${functionText("printHotelList", "exportHotelList")}\nthis.run=printHotelList;`, context);
  return { context, events, popup };
}
const printed = printContext();
await printed.context.run();
assert.ok(printed.events.indexOf("period") < printed.events.indexOf("open"));
assert.ok(printed.events.indexOf("open") < printed.events.indexOf("refresh"));
assert.ok(printed.events.indexOf("refresh") < printed.events.indexOf("filter"));
assert.ok(printed.events.indexOf("filter") < printed.events.indexOf("render"));
assert.equal(printed.events.filter(event => event === "print").length, 1);
assert.equal(printed.context.busy, false);
for (const options of [{ empty: true }, { failed: true }]) {
  const check = printContext(options);
  await check.context.run();
  assert.equal(check.popup.closed, true);
  assert.equal(check.events.includes("print"), false);
  assert.equal(check.context.busy, false);
}
const blocked = printContext({ blocked: true });
await blocked.context.run();
assert.equal(blocked.events.includes("refresh"), false);
assert.ok(blocked.events.some(event => Array.isArray(event) && event[0] === "alert"));
const invalidPeriod = printContext({ invalidPeriod: true });
await invalidPeriod.context.run();
assert.deepEqual(invalidPeriod.events, ["period"], "invalid period must not open a popup or fetch data");

class Node {
  constructor(tag = "div") { this.tag = tag; this.children = []; this.textContent = ""; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  get allText() { return this.textContent + this.children.map(child => child.allText || String(child)).join(" "); }
}
const detailNodes = { hotelDetailContent: new Node(), hotelDetailSubtitle: new Node() };
const detailContext = {
  document: { createElement: tag => new Node(tag) }, byId: id => detailNodes[id], Date, Intl, Number, String,
  optionalMoney: value => value == null ? "—" : String(value) + " VND", moneyText: value => String(value) + " VND", roomTypeName: item => item.name
};
vm.runInNewContext(`${functionText("renderReservationDetail", "openReservationDetail")}\nthis.run=renderReservationDetail;`, detailContext);
detailContext.run({ ...previous, id: "detail-1", hotel_name: "Hotel A", guest_count: 3, guest_names: "A\nB\nC", deposit_amount: 0, balance_amount: 200, note: "<script>alert(1)</script>", purchase_amount: 2500, sale_amount: 2800 });
const detailText = detailNodes.hotelDetailContent.allText;
for (const value of ["Double", "Twin", "STANDARD", "VIP", "A\nB\nC", "2500 VND", "2800 VND", "200 VND", "0 VND", "<script>alert(1)</script>"]) assert.ok(detailText.includes(value), `detail missing ${value}`);
assert.equal(detailNodes.hotelDetailContent.children.length, 4);

function deleteContext({ confirmed = true, serverError = null } = {}) {
  const events = [];
  const query = { delete() { events.push("delete"); return this; }, eq(key, value) { events.push([key, value]); return this; }, select() { return this; }, single: async () => ({ error: serverError }) };
  const context = {
    busy: false, ready: true, confirm: () => confirmed, table: () => query,
    setBusy: value => { context.busy = value; }, refresh: async () => events.push("refresh"),
    errorText: error => error.message, message: (id, text) => events.push([id, text])
  };
  vm.runInNewContext(`${functionText("remove", "printHotelList")}\nthis.run=remove;`, context);
  return { context, events };
}
const cancelled = deleteContext({ confirmed: false });
assert.equal(await cancelled.context.run("hotel_reservations", { id: "detail-1", version: 4 }), false);
assert.equal(cancelled.events.length, 0);
const removed = deleteContext();
assert.equal(await removed.context.run("hotel_reservations", { id: "detail-1", version: 4 }), true);
assert.ok(removed.events.some(event => Array.isArray(event) && event[0] === "version" && event[1] === 4));
assert.ok(removed.events.includes("refresh"));
const failedDelete = deleteContext({ serverError: { message: "changed elsewhere" } });
assert.equal(await failedDelete.context.run("hotel_reservations", { id: "detail-1", version: 4 }, "hotelDetailError"), false);
assert.ok(failedDelete.events.some(event => Array.isArray(event) && event[0] === "hotelDetailError"));
console.log("Hotel room-type UI, snapshot preservation, detail dialog, deletion and print-action regression passed.");
