import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const context = {};
vm.runInNewContext(await readFile(new URL('../assets/hotel-pricing.js', import.meta.url), 'utf8'), context);
const pricing = context.HotelPricing;
const hotel = { id: 'hotel', weekend_days: [5, 6], version: 1 };
const types = [
  { id: 'superior-single', hotel_id: 'hotel', grade_id: 'superior', grade_name: '수페리어 / Superior', room_kind: 'DOUBLE', name: 'DOUBLE', version: 1, is_active: true,
    weekday_purchase: 100, weekday_sale: 150, weekend_purchase: 200, weekend_sale: 300 },
  { id: 'superior-double', hotel_id: 'hotel', grade_id: 'superior', grade_name: '수페리어 / Superior', room_kind: 'TWIN', name: 'TWIN', version: 1, is_active: true,
    weekday_purchase: 250, weekday_sale: 400, weekend_purchase: 350, weekend_sale: 550 },
  { id: 'garden-triple', hotel_id: 'hotel', grade_id: 'garden', grade_name: '정원 전망 / Hướng vườn', room_kind: 'TRIPLE', name: 'TRIPLE', version: 1, is_active: true,
    weekday_purchase: 400, weekday_sale: 600, weekend_purchase: 600, weekend_sale: 900 },
];
const data = { hotel_id: 'hotel', check_in: '2026-11-05', check_out: '2026-11-09', room_count: 6, pricing_mode: 'standard',
  room_items: [
    { room_type_id: 'superior-single', room_count: 2, room_grade: 'CLIENT OVERRIDE', grade_id: 'wrong', room_kind: 'TRIPLE' },
    { room_type_id: 'superior-double', room_count: 1, room_grade: 'VIP' },
    { room_type_id: 'garden-triple', room_count: 3 },
  ], includes_meals: true, meal_purchase_amount: 80, meal_sale_amount: 120 };
const before = JSON.stringify({ data, types, hotel });
const result = pricing.price(data, hotel, null, types);
assert.equal(JSON.stringify({ data, types, hotel }), before, 'catalog and inputs must not be changed');
assert.equal(result.weekday, 2);
assert.equal(result.weekend, 2);
assert.equal(result.roomCount, 6);
assert.equal(result.roomPurchase, 8_400);
assert.equal(result.roomSale, 12_700);
assert.equal(result.purchase, 8_480);
assert.equal(result.sale, 12_820);
assert.equal(result.items[0].grade_id, 'superior');
assert.equal(result.items[0].room_kind, 'DOUBLE');
assert.equal(result.items[0].room_grade, '수페리어 / Superior');
assert.equal(result.items[1].room_kind, 'TWIN');
assert.equal(result.items[2].room_grade, '정원 전망 / Hướng vườn');
assert.equal(result.items[2].room_kind, 'TRIPLE');
assert.equal(result.items[2].rate_snapshot.weekend_sale, 900);

const previous = { ...data, room_items: result.items, rate_snapshot: result.rates,
  room_purchase_amount: result.roomPurchase, room_sale_amount: result.roomSale };
const savedBefore = JSON.stringify(previous);
const renamed = types.map(type => ({ ...type, grade_name: '변경된 등급 / Hạng mới', version: 2,
  weekday_purchase: 5000, weekday_sale: 7000, weekend_purchase: 5000, weekend_sale: 7000 }));
const updatedData = { ...data, note: '메모 수정', deposit_amount: 200,
  room_items: data.room_items.map(item => ({ room_type_id: item.room_type_id, room_count: item.room_count, room_grade: '변경된 등급 / Hạng mới' })) };
assert.equal(pricing.needsRates(previous, updatedData), false, 'catalog grade renames must not trigger repricing');
const preserved = pricing.price(updatedData, hotel, previous, renamed.map(type => ({ ...type, is_active: false, grade_is_active: false })));
assert.equal(preserved.roomPurchase, 8_400);
assert.equal(preserved.sale, 12_820);
assert.equal(preserved.items[0].room_grade, '수페리어 / Superior');
assert.equal(preserved.items[2].rate_snapshot.weekend_sale, 900);
assert.equal(JSON.stringify(preserved.items), JSON.stringify(previous.room_items), 'unchanged selection must preserve all snapshots');
assert.equal(JSON.stringify(previous), savedBefore);
assert.equal(pricing.needsRates(previous, { ...updatedData, room_items: [...updatedData.room_items].reverse() }), false);
assert.equal(pricing.price(updatedData, hotel, previous, []).sale, 12_820, 'historical notes must not require a current catalog entry');

const next = pricing.price(updatedData, hotel, null, renamed);
assert.equal(next.items[0].room_grade, '변경된 등급 / Hạng mới');
assert.equal(next.roomPurchase, 120_000, 'new bookings must use current grade/type rates');
assert.equal(next.roomSale, 168_000);
assert.equal(pricing.needsRates(previous, { ...updatedData, check_out: '2026-11-10' }), true);
const changedCount = { ...updatedData, room_items: updatedData.room_items.map((item, index) => ({ ...item, room_count: index ? item.room_count : 3 })) };
assert.equal(pricing.price(changedCount, hotel, previous, renamed).roomCount, 7);
assert.equal(pricing.price(changedCount, hotel, previous, renamed).roomSale, 196_000);

for (const patch of [{ grade_name: '' }, { grade_name: '   ' }, { grade_name: null }, { room_kind: 'SINGLE' }, { grade_is_active: false }]) {
  assert.throws(() => pricing.price(data, hotel, null, types.map((type, index) => index ? type : { ...type, ...patch })), /등급|종류/);
}
assert.throws(() => pricing.price({ ...data, room_items: [null] }, hotel, null, types));
assert.throws(() => pricing.price(data, hotel, null, types.map(type => ({ ...type, hotel_id: 'another-hotel' }))));

const legacyType = { ...types[0], id: 'old-twin', name: 'Legacy Twin', grade_id: null, room_kind: null, grade_name: undefined };
const legacyData = { ...data, room_count: 1, room_items: [{ room_type_id: 'old-twin', room_count: 1, room_grade: 'VIP' }] };
const legacy = pricing.price(legacyData, hotel, null, [legacyType]);
assert.equal(legacy.items[0].name, 'Legacy Twin');
assert.equal(legacy.items[0].room_grade, 'VIP');
assert.equal(legacy.items[0].grade_id, undefined);
assert.equal(legacy.items[0].room_kind, undefined);
assert.throws(() => pricing.price({ ...legacyData, room_items: [{ ...legacyData.room_items[0], room_grade: 'CUSTOM' }] }, hotel, null, [legacyType]));
const legacyPrevious = { ...legacyData, room_items: legacy.items, rate_snapshot: legacy.rates,
  room_purchase_amount: legacy.roomPurchase, room_sale_amount: legacy.roomSale };
assert.equal(pricing.needsRates(legacyPrevious, { ...legacyData, room_items: [{ ...legacyData.room_items[0], room_grade: 'STANDARD' }] }), true);

const manual = pricing.price({ ...data, pricing_mode: 'surcharge', room_purchase_amount: 12_345, room_sale_amount: 23_456 }, hotel, null, types);
assert.equal(manual.roomPurchase, 12_345);
assert.equal(manual.roomSale, 23_456);
assert.equal(manual.items[0].room_sale_amount, null);
assert.equal(manual.items[2].room_grade, '정원 전망 / Hướng vườn');
console.log('Hotel custom grades, fixed kinds, mixed rates and historical snapshot preservation passed.');

