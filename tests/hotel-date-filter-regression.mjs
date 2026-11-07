import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const [source, html, reportSource] = await Promise.all([
  '../assets/hotel-reserv-list.js', '../hotel_reserv_list.html', '../assets/hotel-report.js',
].map(file => readFile(new URL(file, import.meta.url), 'utf8')));
const reportScope = { Date, Intl };
vm.runInNewContext(reportSource, reportScope);
const report = reportScope.HotelReport;
const period = { fromDate: '2026-11-06', toDate: '2026-11-08' };
const rows = [
  ['before', '2026-11-05', '2026-11-10'],
  ['start', '2026-11-06', '2026-11-07'],
  ['middle', '2026-11-07', '2026-11-10'],
  ['end', '2026-11-08', '2026-11-09'],
  ['after', '2026-11-09', '2026-11-10'],
].map(([id, check_in, check_out], index) => ({ id, check_in, check_out, hotel_name: '호텔 ' + id,
  guest_count: 2, guest_names: 'Khách ' + id, room_count: 1, room_items: null,
  pricing_mode: 'standard', weekday_nights: 1, weekend_nights: 0,
  room_purchase_amount: index * 100_000, room_sale_amount: index * 200_000,
  purchase_amount: index * 100_000, sale_amount: index * 200_000,
  deposit_amount: 0, balance_amount: null, includes_meals: false, note: 'note-' + id }));
const ids = values => Array.from(values, row => row.id);
const before = JSON.stringify(rows);
assert.deepEqual(ids(report.filterRows(rows, period)), ['start', 'middle', 'end'], 'both check-in endpoints are included, not checkout-overlapping bookings');
assert.deepEqual(ids(report.filterRows(rows)), ids(rows), 'omitted period remains backward-compatible');
assert.deepEqual(ids(report.filterRows(rows, { fromDate: '', toDate: '' })), ids(rows));
assert.deepEqual(ids(report.filterRows(rows, { fromDate: '2026-11-07', toDate: '2026-11-07' })), ['middle']);
assert.deepEqual(ids(report.filterRows(rows, { fromDate: '2027-01-01', toDate: '2027-01-31' })), []);
assert.deepEqual(ids(report.filterRows(null, period)), []);
assert.deepEqual(ids(report.filterRows([...rows].reverse(), period)), ['end', 'middle', 'start'], 'filtering must preserve existing ordering');
assert.equal(JSON.stringify(rows), before);
assert.equal(report.normalizePeriod({ fromDate: ' 2026-11-06 ', toDate: '2026-11-08 ' }).fromDate, period.fromDate);
assert.match(report.periodLabel(period), /체크인.*Theo ngày nhận phòng.*2026-11-06 ~ 2026-11-08/);
assert.match(report.periodLabel(), /전체 기간.*Toàn bộ/);
for (const invalid of [{ fromDate: '2026-11-09', toDate: '2026-11-06' },
  { fromDate: '', toDate: '2026-11-06' }, { fromDate: '2026-11-06', toDate: '' },
  { fromDate: '2026-02-30', toDate: '2026-03-01' }, { fromDate: '2026-11-6', toDate: '2026-11-08' },
  { fromDate: '<img src=x>', toDate: '2026-11-08' }]) {
  assert.throws(() => report.normalizePeriod(invalid), /Vui lòng|Ngày bắt đầu/);
  assert.throws(() => report.filterRows(rows, invalid));
  assert.throws(() => report.renderHtml(rows, invalid));
  assert.throws(() => report.workbookOptions(rows, invalid));
}
assert.equal(report.normalizePeriod({ fromDate: '2028-02-29', toDate: '2028-02-29' }).toDate, '2028-02-29');

function functionText(name) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`).exec(source);
  assert.ok(match, 'missing ' + name);
  let depth = 0, quote = '', escaped = false, lineComment = false, blockComment = false;
  for (let index = match.index + match[0].length - 1; index < source.length; index++) {
    const char = source[index], next = source[index + 1];
    if (lineComment) { if (char === '\n') lineComment = false; continue; }
    if (blockComment) { if (char === '*' && next === '/') { blockComment = false; index++; } continue; }
    if (quote) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === quote) quote = ''; continue; }
    if (char === '/' && next === '/') { lineComment = true; index++; continue; }
    if (char === '/' && next === '*') { blockComment = true; index++; continue; }
    if ('\'"`'.includes(char)) { quote = char; continue; }
    if (char === '{') depth++;
    if (char === '}' && --depth === 0) return source.slice(match.index, index + 1);
  }
  assert.fail('unclosed function ' + name);
}
for (const id of ['hotelPeriodForm', 'hotelPeriodFields', 'hotelFromDate', 'hotelToDate', 'allHotelDatesButton', 'hotelPeriodStatus', 'hotelPeriodError']) {
  assert.ok(html.includes(`id="${id}"`), 'missing period control ' + id);
}
for (const name of ['printHotelList', 'exportHotelList', 'refresh']) {
  assert.doesNotMatch(functionText(name), /\.(?:insert|update|upsert|delete|rpc)\s*\(/, name + ' must remain read-only');
}

class Element {
  constructor(id = '') { this.id = id; this.value = ''; this.textContent = ''; this.children = []; this.cells = []; this.dataset = {}; this.handlers = {}; }
  replaceChildren(...children) { this.children = children; this.cells = []; }
  append(...children) { this.children.push(...children); }
  insertRow() { const row = new Element(); this.children.push(row); return row; }
  insertCell() { const cell = new Element(); this.cells.push(cell); return cell; }
  setAttribute() {}
  addEventListener(name, handler) { this.handlers[name] = handler; }
}
function setup({ latest = rows, failed = false, blocked = false, duringRefresh = null } = {}) {
  const elements = new Map(), events = [], prints = [], workbooks = [];
  const byId = id => { if (!elements.has(id)) elements.set(id, new Element(id)); return elements.get(id); };
  const popup = { closed: false, document: { write: text => events.push(['write', text]), open() {}, close() {}, fonts: { ready: Promise.resolve() } },
    close() { this.closed = true; events.push('close'); }, focus() {}, print: () => events.push('print') };
  const context = { Date, Intl, Number, String, Object, Array, Promise, Error,
    busy: false, ready: true, hotels: [], reservations: rows, roomTypes: [], roomGrades: [],
    appliedPeriod: { fromDate: '', toDate: '' }, managedHotel: null, detailReservationId: null,
    moneyText: value => String(value), optionalMoney: value => value == null ? '—' : String(value), roomDescription: () => 'Snapshot', weekdays: [],
    byId, document: { createElement: () => new Element(), querySelectorAll: () => [] },
    window: { open: () => { events.push('open'); return blocked ? null : popup; }, getSelection: () => null },
    alert: text => events.push(['alert', text]),
    table: name => ({ name, select() { return this; } }),
    DGV: { collectSupabasePages: async factory => {
      const name = factory().name;
      events.push(['query', name]);
      if (name === 'hotel_reservations') {
        if (duringRefresh) duringRefresh(context, byId);
        if (failed) throw new Error('simulated read failure');
        return latest;
      }
      return [];
    } },
    HotelReport: { ...report,
      renderHtml: (values, selectedPeriod) => { prints.push({ ids: ids(values), period: JSON.stringify(selectedPeriod) }); return report.renderHtml(values, selectedPeriod); },
      workbookOptions: (values, selectedPeriod) => { workbooks.push({ ids: ids(values), period: JSON.stringify(selectedPeriod) }); return report.workbookOptions(values, selectedPeriod); } },
    DGV_XLSX: { downloadWorkbook: options => events.push(['download', options]) },
    setTimeout: callback => { callback(); return 1; },
  };
  const names = ['errorText', 'message', 'setBusy', 'periodDraft', 'updatePeriodStatus', 'applyPeriodDraft', 'action', 'renderRows', 'render', 'refresh', 'printHotelList', 'exportHotelList'];
  vm.createContext(context);
  vm.runInContext(names.map(functionText).join('\n'), context);
  const bindings = source.slice(source.indexOf('  byId("hotelPeriodForm").addEventListener'), source.indexOf('  byId("printHotelListButton").addEventListener'));
  assert.ok(bindings.length > 0);
  vm.runInContext(bindings, context);
  const setPeriod = value => { byId('hotelFromDate').value = value.fromDate; byId('hotelToDate').value = value.toDate; };
  const displayedIds = () => byId('hotelRows').children.map(row => row.dataset.reservationId).filter(Boolean);
  return { context, byId, events, prints, workbooks, popup, setPeriod, displayedIds };
}
const screen = setup();
screen.context.render();
assert.deepEqual(screen.displayedIds(), ids(rows));
screen.setPeriod(period);
screen.byId('hotelFromDate').handlers.input();
assert.match(screen.byId('hotelPeriodStatus').textContent, /변경한 기간/);
assert.deepEqual(screen.displayedIds(), ids(rows), 'draft dates do not silently alter the applied list');
screen.byId('hotelPeriodForm').handlers.submit({ preventDefault() {} });
assert.deepEqual(screen.displayedIds(), ['start', 'middle', 'end']);
assert.match(screen.byId('listCount').textContent, /^3건/);
assert.equal(screen.events.filter(event => Array.isArray(event) && event[0] === 'query').length, 0, 'filter application is read-only over loaded reservations');
await screen.context.refresh();
assert.deepEqual(screen.displayedIds(), ['start', 'middle', 'end'], 'refresh must retain the applied filter');
screen.setPeriod({ fromDate: period.toDate, toDate: period.fromDate });
assert.equal(screen.context.applyPeriodDraft(), false);
assert.deepEqual(screen.displayedIds(), ['start', 'middle', 'end'], 'invalid range must preserve the prior valid list');
assert.equal(screen.byId('hotelPeriodError').hidden, false);
screen.byId('allHotelDatesButton').handlers.click();
assert.equal(screen.byId('hotelFromDate').value, '');
assert.equal(screen.byId('hotelToDate').value, '');
assert.deepEqual(screen.displayedIds(), ids(rows));
assert.match(screen.byId('hotelPeriodStatus').textContent, /전체 기간/);

// Both actions must refresh the same date snapshot and export exactly the displayed IDs.
const freshRows = rows.filter(row => row.id !== 'middle').map(row => ({ ...row, sale_amount: 987_654 }));
const output = setup({ latest: freshRows });
output.setPeriod(period);
await output.context.printHotelList();
await output.context.exportHotelList();
assert.deepEqual(output.prints[0], output.workbooks[0]);
assert.deepEqual(output.prints[0].ids, ['start', 'end']);
assert.deepEqual(output.displayedIds(), output.prints[0].ids);
assert.equal(output.prints[0].period, JSON.stringify(period));
assert.equal(output.events.filter(event => event === 'open').length, 1);
assert.equal(output.events.filter(event => event === 'print').length, 1);
const downloads = output.events.filter(event => Array.isArray(event) && event[0] === 'download');
assert.equal(downloads.length, 1);
assert.match(downloads[0][1].filename, /2026-11-06_2026-11-08\.xlsx$/);
assert.equal(downloads[0][1].sheets[0].rows[4][17].value, 987_654, 'export must use fresh data, not pre-refresh totals');
assert.match(downloads[0][1].sheets[0].rows[1][0].value, /2026-11-06 ~ 2026-11-08/);
assert.equal(output.context.busy, false);
assert.ok(output.events.indexOf('open') < output.events.findIndex(event => Array.isArray(event) && event[0] === 'query'));
const frozen = setup({ duringRefresh: (_context, byId) => { byId('hotelFromDate').value = '2027-01-01'; byId('hotelToDate').value = '2027-01-02'; } });
frozen.setPeriod(period);
await frozen.context.exportHotelList();
assert.equal(frozen.workbooks[0].period, JSON.stringify(period), 'in-flight export keeps its captured date range');
assert.deepEqual(frozen.workbooks[0].ids, ['start', 'middle', 'end']);

for (const action of ['printHotelList', 'exportHotelList']) {
  for (const invalid of [{ fromDate: '2026-11-10', toDate: '2026-11-01' }, { fromDate: '2026-02-30', toDate: '2026-03-01' }, { fromDate: period.fromDate, toDate: '' }]) {
    const check = setup(); check.setPeriod(invalid); await check.context[action]();
    assert.equal(check.events.length, 0, 'invalid dates must not query, open a popup or download');
    assert.equal(check.byId('hotelPeriodError').hidden, false);
  }
  for (const options of [{ latest: [] }, { failed: true }]) {
    const check = setup(options); check.setPeriod(period); await check.context[action]();
    assert.equal(check.events.includes('print'), false);
    assert.equal(check.events.filter(event => Array.isArray(event) && event[0] === 'download').length, 0);
    assert.equal(check.byId('pageStatus').hidden, false);
    assert.equal(check.context.busy, false);
    if (action === 'printHotelList') assert.equal(check.popup.closed, true);
  }
  const locked = setup(); locked.context.busy = true; await locked.context[action](); assert.equal(locked.events.length, 0);
  const unready = setup(); unready.context.ready = false; await unready.context[action](); assert.equal(unready.events.length, 0);
}
const blocked = setup({ blocked: true }); blocked.setPeriod(period); await blocked.context.printHotelList();
assert.equal(blocked.events.filter(event => Array.isArray(event) && event[0] === 'query').length, 0);
assert.ok(blocked.events.some(event => Array.isArray(event) && event[0] === 'alert'));
assert.equal(JSON.stringify(rows), before, 'all filter and export actions preserve the source reservations');
console.log('Hotel inclusive check-in period, list refresh, captured print/XLSX rows, metadata and failure guards passed offline.');
