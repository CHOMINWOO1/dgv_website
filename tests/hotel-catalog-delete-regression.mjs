import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Entirely offline: model and export regression only. No database or network calls.
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : ['2026-11-07T00:00:00Z'])); }
  static now() { return new Date('2026-11-07T00:00:00Z').getTime(); }
}
const context = { Date: FixedDate, Intl };
for (const file of ['hotel-pricing.js', 'hotel-report.js']) {
  vm.runInNewContext(await readFile(new URL('../assets/' + file, import.meta.url), 'utf8'), context);
}
const { HotelPricing: pricing, HotelReport: report } = context;
const hotel = { id: 'hotel', name: 'Western Hill', weekend_days: [5, 6], version: 1 };
const common = { hotel_id: hotel.id, version: 1, is_active: true, archived_at: null,
  weekday_purchase: 300_000, weekday_sale: 400_000, weekend_purchase: 350_000, weekend_sale: 450_000 };
const types = [
  { ...common, id: 'double', name: 'DOUBLE', grade_id: 'garden', grade_name: '정원 전망 / Hướng vườn', room_kind: 'DOUBLE' },
  { ...common, id: 'legacy', name: '기존 트윈 / Twin cũ', grade_id: null, room_kind: null },
];
const data = { hotel_id: hotel.id, hotel_name: hotel.name, check_in: '2026-11-05', check_out: '2026-11-09',
  pricing_mode: 'standard', room_count: 3, guest_count: 6, guest_names: 'NGUYỄN THỊ HỒNG\nKIM MIN SU',
  includes_meals: false, deposit_amount: 200_000, balance_amount: 100_000, note: '기존 예약 / Đặt phòng cũ',
  room_items: [{ room_type_id: 'double', room_count: 2, room_grade: '정원 전망 / Hướng vườn' },
    { room_type_id: 'legacy', room_count: 1, room_grade: 'VIP' }] };
const initial = pricing.price(data, hotel, null, types);
const saved = { ...data, id: 'reservation', room_items: initial.items, rate_snapshot: initial.rates,
  weekday_nights: initial.weekday, weekend_nights: initial.weekend,
  room_purchase_amount: initial.roomPurchase, room_sale_amount: initial.roomSale,
  purchase_amount: initial.purchase, sale_amount: initial.sale };
const before = JSON.stringify(saved);
const beforeHtml = report.renderHtml([saved]);
const beforeWorkbook = JSON.stringify(report.workbookOptions([saved]));
const archived = types.map(type => ({ ...type, archived_at: '2026-11-07T00:00:00Z', is_active: false,
  grade_is_active: false, version: 2, grade_name: '등급 이름 변경', weekday_sale: 99_999_999 }));

// Catalog archival must not affect saved quotes, rates, grades, counts or exports.
const edit = { ...data, note: '메모만 변경', deposit_amount: 500_000,
  room_items: data.room_items.map(item => ({ ...item })) };
assert.equal(pricing.needsRates(saved, edit), false);
for (const catalog of [archived, []]) {
  const preserved = pricing.price(edit, hotel, saved, catalog);
  assert.equal(JSON.stringify(preserved.items), JSON.stringify(saved.room_items));
  assert.equal(preserved.roomPurchase, saved.room_purchase_amount);
  assert.equal(preserved.roomSale, saved.room_sale_amount);
  assert.equal(preserved.purchase, saved.purchase_amount);
  assert.equal(preserved.sale, saved.sale_amount);
}
assert.equal(JSON.stringify(saved), before, 'archive-related rendering must never mutate the reservation');
assert.equal(report.renderHtml([saved]), beforeHtml);
assert.equal(JSON.stringify(report.workbookOptions([saved])), beforeWorkbook);
assert.ok(beforeHtml.includes('정원 전망 / Hướng vườn'));
assert.ok(beforeHtml.includes('더블 / Phòng đôi'));
assert.ok(beforeHtml.includes('기존 트윈 / Twin cũ'));
assert.ok(beforeHtml.includes('VIP'));

// DB guarantees archived types are inactive. Both new and repriced bookings must reject them.
assert.throws(() => pricing.price(data, hotel, null, archived), /사용 가능한 룸타입/);
for (const patch of [{ check_out: '2026-11-10' },
  { room_items: data.room_items.map((item, index) => ({ ...item, room_count: index ? 1 : 3 })) }]) {
  const changed = { ...edit, ...patch };
  assert.equal(pricing.needsRates(saved, changed), true);
  assert.throws(() => pricing.price(changed, hotel, saved, archived), /사용 가능한 룸타입/);
}
const noLegacy = [types[0], archived[1]];
assert.throws(() => pricing.price(data, hotel, null, noLegacy), /사용 가능한 룸타입/,
  'legacy types must be unavailable for new reservations after archival too');

// Other active types remain bookable; archival is not a blanket hotel disable.
const activeOnly = { ...data, room_count: 2, room_items: [data.room_items[0]] };
assert.equal(pricing.price(activeOnly, hotel, null, noLegacy).roomSale, 3_400_000);

// Stored manual/surcharge amounts also survive unrelated edits after archival.
const manualData = { ...data, pricing_mode: 'surcharge', room_purchase_amount: 1_234_567, room_sale_amount: 2_345_678 };
const manualInitial = pricing.price(manualData, hotel, null, types);
const manualSaved = { ...saved, ...manualData, room_items: manualInitial.items,
  room_purchase_amount: manualInitial.roomPurchase, room_sale_amount: manualInitial.roomSale };
const manual = pricing.price({ ...manualData, note: '수동 요금 예약 메모' }, hotel, manualSaved, archived);
assert.equal(manual.roomPurchase, 1_234_567);
assert.equal(manual.roomSale, 2_345_678);
assert.equal(JSON.stringify(manual.items), JSON.stringify(manualSaved.room_items));
console.log('Hotel catalog archival: historical pricing, snapshots, legacy types and exports preserved; new/repriced selections rejected.');
