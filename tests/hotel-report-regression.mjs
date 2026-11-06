import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(path.join(root, "assets/hotel-report.js"), "utf8");
assert.doesNotMatch(source, /\bfetch\s*\(|\.(?:insert|update|upsert|delete|rpc)\s*\(/, "report creation must never query or change a database");
const context = { Date, Intl, Map, Set, Object, Array, Number, String, Boolean, Math, JSON, TextEncoder, Uint8Array, Uint32Array, DataView };
vm.runInNewContext(source, context);
vm.runInNewContext(await readFile(path.join(root, "assets/dgv-xlsx.js"), "utf8"), context);
const report = context.HotelReport;
assert.equal(typeof report.renderHtml, "function");
assert.equal(typeof report.workbookOptions, "function");

const modern = {
  id: "hotel-booking-1", hotel_name: "Western Hill / 웨스턴힐", check_in: "2026-11-06", check_out: "2026-11-09",
  guest_count: 5, room_count: 3, guest_names: "NGUYỄN THỊ HỒNG\nKIM MIN SU\nLEE JI WON\nPARK MIN JI\nCHO MIN WOO", pricing_mode: "standard",
  weekday_nights: 1, weekend_nights: 2, includes_meals: true,
  room_purchase_amount: 3_500_000, room_sale_amount: 4_500_000, meal_purchase_amount: 500_000, meal_sale_amount: 650_000,
  purchase_amount: 4_000_000, sale_amount: 5_150_000, deposit_amount: 1_000_000, balance_amount: 4_150_000,
  note: "늦은 체크인 예정 / Nhận phòng muộn",
  room_items: [
    { room_type_id: "twin-id", name: "트윈 / Twin", room_grade: "STANDARD", room_count: 2, weekday_nights: 1, weekend_nights: 2,
      rate_snapshot: { weekday_purchase: 300_000, weekday_sale: 400_000, weekend_purchase: 400_000, weekend_sale: 500_000 },
      room_purchase_amount: 2_200_000, room_sale_amount: 2_800_000 },
    { room_type_id: "double-id", name: "더블 / Double", room_grade: "VIP", room_count: 1, weekday_nights: 1, weekend_nights: 2,
      rate_snapshot: { weekday_purchase: 300_000, weekday_sale: 500_000, weekend_purchase: 500_000, weekend_sale: 600_000 },
      room_purchase_amount: 1_300_000, room_sale_amount: 1_700_000 },
  ],
};
const legacy = { ...modern, id: "hotel-legacy", hotel_name: "Swiss-Bel / 스위스벨", room_items: null, room_count: 1,
  guest_count: 2, guest_names: "기존 예약 고객 / Khách cũ", pricing_mode: "legacy", rate_snapshot: null,
  deposit_amount: null, balance_amount: null, note: "기존 예약 금액 유지 / Giữ nguyên số tiền cũ" };
const input = [modern, legacy];
const before = JSON.stringify(input);
const html = report.renderHtml(input);
const workbook = report.workbookOptions(input);
assert.equal(JSON.stringify(input), before, "exports must preserve all original booking and room snapshots");
assert.equal(workbook.sheets.length, 2);
const main = workbook.sheets[0];
const details = workbook.sheets[1];
assert.equal(main.rows[4].length, 22);
assert.equal(details.rows[4].length, 14);
assert.equal(main.rows[4][16].value, 4_000_000);
assert.equal(main.rows[4][17].value, 5_150_000);
assert.equal(main.rows[4][18].value, 1_000_000);
assert.equal(main.rows[4][19].value, 4_150_000);
assert.equal(main.rows[4][20].value, 5_150_000);
assert.equal(main.rows[4][21].value, modern.note);
assert.equal(main.rows[4][2].value.getFullYear(), 2026);
assert.equal(main.rows[4][2].value.getMonth(), 10);
assert.equal(main.rows[4][2].value.getDate(), 6);
assert.equal(main.rows[5][18].value, null);
assert.equal(main.rows[5][19].value, null);
assert.equal(main.rows[5][20].value, null);
assert.equal(details.rows.length, 7, "two room type lines plus a legacy detail row must remain visible");
assert.equal(details.rows[4][8].value, 300_000);
assert.equal(details.rows[4][12].value, 2_200_000);
assert.equal(details.rows[5][4].value, "VIP");
assert.equal(details.rows[5][5].value, 1);
assert.equal(details.rows[6][8].value, null, "legacy bookings without rate snapshots must not invent current rates");
assert.match(main.rows[4][7].value, /트윈.*2 객실·phòng\n더블.*VIP.*1 객실·phòng/);
assert.match(html, /5,150,000/);
assert.match(html, /NGUYỄN THỊ HỒNG/);
assert.match(html, /CHO MIN WOO/);
assert.match(html, /늦은 체크인 예정/);
assert.match(html, /hotel-legacy/);
assert.equal((html.match(/class="reservation"/g) || []).length, 2);
assert.match(html, /A4 portrait/);

const graded = { ...modern, room_items: [
  { ...modern.room_items[0], name: 'SINGLE', grade_id: 'superior', room_kind: 'SINGLE', room_grade: '수페리어 / Superior' },
  { ...modern.room_items[1], name: 'DOUBLE', grade_id: 'garden', room_kind: 'DOUBLE', room_grade: '정원 전망 / Hướng vườn' },
  { ...modern.room_items[1], name: 'TRIPLE', grade_id: 'named-standard', room_kind: 'TRIPLE', room_grade: 'STANDARD' },
] };
const gradedBefore = JSON.stringify(graded);
const gradedHtml = report.renderHtml([graded]);
const gradedWorkbook = report.workbookOptions([graded]);
assert.equal(JSON.stringify(graded), gradedBefore);
for (const value of ['싱글 / Phòng đơn', '더블 / Phòng đôi', '트리플 / Phòng ba', '수페리어 / Superior', '정원 전망 / Hướng vườn']) {
  assert.ok(gradedHtml.includes(value), `PDF must display saved custom grade and fixed kind: ${value}`);
  assert.ok(gradedWorkbook.sheets[0].rows[4][7].value.includes(value), `Excel summary must display ${value}`);
}
assert.equal(gradedWorkbook.sheets[1].rows[4][3].value, '싱글 / Phòng đơn');
assert.equal(gradedWorkbook.sheets[1].rows[4][4].value, '수페리어 / Superior');
assert.equal(gradedWorkbook.sheets[1].rows[5][3].value, '더블 / Phòng đôi');
assert.equal(gradedWorkbook.sheets[1].rows[6][3].value, '트리플 / Phòng ba');
assert.equal(gradedWorkbook.sheets[1].rows[6][4].value, 'STANDARD', 'custom grade names must remain literal, even if they match a legacy grade token');
assert.equal(gradedWorkbook.sheets[0].rows[4][17].value, modern.sale_amount, 'exports never recompute historical totals');
assert.equal(gradedWorkbook.sheets[1].rows[4][8].value, modern.room_items[0].rate_snapshot.weekday_purchase);
assert.equal(details.rows[4][3].value, '트윈 / Twin', 'legacy room type names must remain unchanged');
assert.equal(details.rows[4][4].value, '일반 / Tiêu chuẩn', 'legacy STANDARD labels remain compatible');
assert.match(report.renderHtml([{ ...graded, room_items: [{ ...graded.room_items[0], room_grade: '<img src=x onerror=alert(1)>' }] }]), /&lt;img/);

for (const [deposit, balance, expected] of [[0, 0, 0], [null, 12, 12], [34, null, 34], [null, null, null], ["45", "55", 100]]) {
  const options = report.workbookOptions([{ ...modern, deposit_amount: deposit, balance_amount: balance }]);
  assert.equal(options.sheets[0].rows[4][20].value, expected, "received totals must distinguish zero, partial and absent payments");
}
const manual = report.workbookOptions([{ ...modern, pricing_mode: "surcharge", purchase_amount: 7_123_456,
  sale_amount: 9_876_543, room_purchase_amount: 123, room_sale_amount: 456 }]);
assert.equal(manual.sheets[0].rows[4][12].value, 123);
assert.equal(manual.sheets[0].rows[4][13].value, 456);
assert.equal(manual.sheets[0].rows[4][16].value, 7_123_456, "recorded totals must not be recalculated from room type prices");
assert.equal(manual.sheets[0].rows[4][17].value, 9_876_543);
const missing = report.workbookOptions([{ ...modern, includes_meals: false, meal_purchase_amount: null, meal_sale_amount: null }]);
assert.equal(missing.sheets[0].rows[4][14].value, null);
assert.equal(missing.sheets[0].rows[4][15].value, null);

const malicious = { ...modern, hotel_name: '<img src=x onerror="alert(1)">',
  note: '=HYPERLINK("https://example.invalid")', guest_names: modern.guest_names + '\n<script>alert(1)</script>' };
const safe = report.renderHtml([malicious]);
assert.match(safe, /&lt;img/);
assert.match(safe, /&lt;script&gt;/);
assert.doesNotMatch(safe, /<img|<script/, "print output must escape untrusted hotel, guest and note strings");

// The existing workbook writer uses stored ZIP entries. Inspect its in-memory
// output, without file creation, browser dependencies or any live service.
const bytes = context.DGV_XLSX.buildWorkbookBytes(report.workbookOptions([malicious]));
const zip = Buffer.from(bytes);
const entries = new Map();
for (let offset = 0; offset + 30 < zip.length && zip.readUInt32LE(offset) === 0x04034b50;) {
  const size = zip.readUInt32LE(offset + 18), nameLength = zip.readUInt16LE(offset + 26), extraLength = zip.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + nameLength + extraLength;
  entries.set(zip.subarray(offset + 30, offset + 30 + nameLength).toString("utf8"), zip.subarray(dataStart, dataStart + size).toString("utf8"));
  offset = dataStart + size;
}
const xml = entries.get("xl/worksheets/sheet1.xml");
assert.ok(entries.has("xl/worksheets/sheet2.xml"));
assert.match(xml, /<c r="U5" s="2"><v>5150000<\/v><\/c>/, "VND amounts must be numeric spreadsheet cells");
assert.match(xml, /<c r="C5" s="3"><v>\d+<\/v><\/c>/, "dates must remain typed and sortable");
assert.match(xml, /<c r="V5" s="7" t="inlineStr">/);
assert.doesNotMatch(xml, /<f>/, "strings beginning with = must remain literal text, never executable formulas");
assert.match(xml, /HYPERLINK/);
assert.match(xml, /NGUYỄN THỊ HỒNG/);
const gradedBytes = Buffer.from(context.DGV_XLSX.buildWorkbookBytes(gradedWorkbook));
assert.ok(gradedBytes.includes(Buffer.from('정원 전망 / Hướng vườn')), 'actual workbook XML must preserve Vietnamese/custom grade text');
assert.ok(gradedBytes.includes(Buffer.from('트리플 / Phòng ba')), 'actual workbook XML must include the fixed room kind');
assert.equal(report.workbookOptions([]).sheets[0].rows.length, 4);
assert.match(report.renderHtml([]), /등록된 예약이 없습니다/);
assert.match(report.renderHtml(null), /등록된 예약이 없습니다/);
console.log("Hotel read-only PDF/Excel model, room snapshots and safe workbook regression passed.");
