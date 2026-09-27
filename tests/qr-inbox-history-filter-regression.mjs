import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFile(path.join(projectRoot, file), "utf8");
const [source, html, css] = await Promise.all([
  read("assets/order-inbox.js"),
  read("order_inbox.html"),
  read("assets/qr-staff.css"),
]);

function functionSource(name) {
  const match = source.match(new RegExp(`^  (?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^  \\}$`, "m"));
  assert.ok(match, `missing function ${name}`);
  return match[0];
}

assert.match(html, /data-history-range="today"[^>]*>오늘</);
assert.match(html, /data-history-range="yesterday"[^>]*>어제</);
assert.match(html, /data-history-range="week"[^>]*>최근 7일</);
assert.match(html, /id="historyDate"[^>]*type="date"/);
assert.match(html, /option value="all" selected>현재 \+ 주문 기록/);
assert.match(html, /assets\/qr-staff\.css\?v=20260927-history-filter/);
assert.match(html, /assets\/order-inbox\.js\?v=20260927-history-filter/);
assert.match(css, /\.qr-history-toolbar/);
assert.match(css, /\.qr-history-day/);

const dateContext = vm.createContext({
  result: null,
  Date,
  Number,
  String,
  RegExp,
  Object,
  Intl,
  global: {
    DGV: {
      formatYmdInTimeZone(value, timeZone) {
        const parts = new Intl.DateTimeFormat("en-US", {
          timeZone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).formatToParts(new Date(value));
        const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
        return `${values.year}-${values.month}-${values.day}`;
      },
    },
  },
});

vm.runInContext(`
  const BUSINESS_TIME_ZONE = "Asia/Ho_Chi_Minh";
  const BUSINESS_UTC_OFFSET_MINUTES = 7 * 60;
  ${functionSource("businessDateKey")}
  ${functionSource("shiftBusinessDateKey")}
  ${functionSource("businessDayStartIso")}
  ${functionSource("historyWindowFor")}
  ${functionSource("millisecondsUntilBusinessTomorrow")}
  const now = new Date("2026-09-27T18:30:00.000Z");
  result = {
    today: historyWindowFor("today", "", now),
    yesterday: historyWindowFor("yesterday", "", now),
    week: historyWindowFor("week", "", now),
    date: historyWindowFor("date", "2026-09-15", now),
    untilTomorrow: millisecondsUntilBusinessTomorrow(now)
  };
`, dateContext);

assert.deepEqual(JSON.parse(JSON.stringify(dateContext.result)), {
  today: {
    range: "today",
    startKey: "2026-09-28",
    endKey: "2026-09-29",
    startIso: "2026-09-27T17:00:00.000Z",
    endIso: "2026-09-28T17:00:00.000Z",
  },
  yesterday: {
    range: "yesterday",
    startKey: "2026-09-27",
    endKey: "2026-09-28",
    startIso: "2026-09-26T17:00:00.000Z",
    endIso: "2026-09-27T17:00:00.000Z",
  },
  week: {
    range: "week",
    startKey: "2026-09-22",
    endKey: "2026-09-29",
    startIso: "2026-09-21T17:00:00.000Z",
    endIso: "2026-09-28T17:00:00.000Z",
  },
  date: {
    range: "date",
    startKey: "2026-09-15",
    endKey: "2026-09-16",
    startIso: "2026-09-14T17:00:00.000Z",
    endIso: "2026-09-15T17:00:00.000Z",
  },
  untilTomorrow: 81001000,
});

const fetchWithRelations = functionSource("fetchWithRelations");
const fetchWithoutRelations = functionSource("fetchWithoutRelations");
const fetchOrders = functionSource("fetchOrders");
const fetchHistoryOrders = functionSource("fetchHistoryOrders");
assert.match(fetchWithRelations, /collectSupabasePages/);
assert.match(fetchWithoutRelations, /collectSupabasePages/);
assert.match(fetchWithRelations, /gte\(dateColumn, historyWindow\.startIso\)\.lt\(dateColumn, historyWindow\.endIso\)/);
assert.match(fetchHistoryOrders, /dateColumn: "finalized_at"/);
assert.match(fetchHistoryOrders, /dateColumn: "cancelled_at"/);
assert.doesNotMatch(fetchHistoryOrders, /\b80\b/);
assert.match(fetchWithRelations, /column: orderColumn, ascending: false[\s\S]*?column: "id", ascending: false/);
assert.match(fetchOrders, /Promise\.allSettled/);
assert.match(fetchOrders, /activeResult\.status === "rejected"[\s\S]*?throw activeResult\.reason/);
assert.match(fetchOrders, /historyError: historyResult\.status === "rejected"/);
assert.match(fetchOrders, /if \(!includeHistory\)[\s\S]*?cachedHistoryRows = orders\.filter\(isHistoricalOrder\)/);

const paidTotals = functionSource("attachPaidTotals");
const boundedMap = functionSource("mapWithConcurrency");
assert.match(paidTotals, /Math\.ceil\(finalizedIds\.length \/ 200\)/);
assert.match(paidTotals, /slice\(index \* 200, \(index \+ 1\) \* 200\)/);
assert.doesNotMatch(paidTotals, /slice\(0, 200\)/);
assert.match(paidTotals, /mapWithConcurrency\(batches, 4/);
assert.match(fetchWithoutRelations, /mapWithConcurrency\(itemChunks, 4/);

const paidContext = vm.createContext({
  result: null,
  calls: [],
  Promise,
  Array,
  Set,
  Map,
  console,
  sb: {
    async rpc(_name, payload) {
      paidContext.calls.push(payload.p_qr_order_ids.length);
      return {
        data: payload.p_qr_order_ids.map((id) => ({
          qr_order_id: id,
          total_usd: 1,
          total_vnd: 25000,
          payment_method: "cash",
        })),
        error: null,
      };
    },
  },
});
await vm.runInContext(`
  ${boundedMap}
  ${paidTotals}
  const rows = Array.from({ length: 401 }, (_, index) => ({
    id: "qr-" + index,
    finalized_order_id: "sale-" + index
  }));
  attachPaidTotals(rows).then((value) => { result = value; });
`, paidContext);
while (!paidContext.result) await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(paidContext.calls, [200, 200, 1]);
assert.equal(paidContext.result.error, null);
assert.equal(paidContext.result.rows.filter((row) => row.paid_total_vnd === 25000).length, 401);

const partialFailureContext = vm.createContext({ result: null, Promise, Map });
await vm.runInContext(`
  async function fetchActiveOrders() { return [[{ id: "active", status: "submitted" }]]; }
  async function fetchHistoryOrders() { throw new Error("history unavailable"); }
  async function attachPaidTotals(rows) { return { rows, error: null }; }
  function selectedHistoryWindow() { return {}; }
  ${fetchOrders}
  fetchOrders({}).then((value) => { result = value; });
`, partialFailureContext);
while (!partialFailureContext.result) await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(partialFailureContext.result.rows.length, 1);
assert.equal(partialFailureContext.result.rows[0].id, "active");
assert.match(partialFailureContext.result.historyError.message, /history unavailable/);

const collapseContext = vm.createContext({ result: null, Map, Date });
vm.runInContext(`
  ${functionSource("collapseFinalizedSales")}
  const rows = Array.from({ length: 81 }, (_, index) => ({
    id: "qr-" + index,
    finalized_order_id: "sale-one",
    submitted_at: new Date(Date.UTC(2026, 8, 27, 0, index)).toISOString(),
    items: [{ id: "item-" + index }]
  }));
  result = collapseFinalizedSales(rows);
`, collapseContext);
assert.equal(collapseContext.result.length, 1);
assert.equal(collapseContext.result[0].checkout_orders.length, 81);
assert.equal(collapseContext.result[0].items.length, 81);

const renderOrders = functionSource("renderOrders");
assert.match(renderOrders, /currentRows = rows\.filter\(\(order\) => !isHistoricalOrder\(order\)\)/);
assert.match(renderOrders, /historyRows = rows\.filter\(isHistoricalOrder\)/);
assert.match(functionSource("renderHistoryDays"), /renderTableGroups\(dayRows, false\)/, "history must never duplicate a table checkout action");
assert.match(functionSource("historyTimestamp"), /finalized_at[\s\S]*?cancelled_at/);
assert.match(source, /formatTime\(order\.finalized_at, \{ timeZone: BUSINESS_TIME_ZONE \}\)/);
assert.match(functionSource("renderOrderCard"), /order\.status === "cancelled"[\s\S]*?order\.cancelled_at/, "cancelled history must display its cancellation time");
assert.match(functionSource("loadOrders"), /historyWindowKey\(requestedHistoryWindow\) !== historyWindowKey\(selectedHistoryWindow\(\)\)[\s\S]*?refreshAfterLoad = true/);
const realtimeSource = functionSource("subscribeRealtime");
assert.match(realtimeSource, /historyChanged = payload\.eventType === "DELETE"[\s\S]*?scheduleRefresh\(250, \{ includeHistory: historyChanged \}\)/);
assert.match(realtimeSource, /table: "qr_order_items"[\s\S]*?scheduleRefresh\(350, \{ includeHistory: false \}\)/);
assert.match(realtimeSource, /status === "SUBSCRIBED"[\s\S]*?scheduleRefresh\(0, \{ includeHistory: true \}\)/);
assert.match(functionSource("scheduleBusinessDayRollover"), /historyDate[\s\S]*?\.max = todayKey[\s\S]*?loadOrders\(\)[\s\S]*?scheduleBusinessDayRollover\(\)/);
assert.match(functionSource("boot"), /scheduleBusinessDayRollover\(\)/);
assert.match(functionSource("selectHistoryRange"), /statusFilter"\)\.value = "all"/);
assert.match(functionSource("searchHistoryDate"), /statusFilter"\)\.value = "all"/);

console.log("QR inbox Vietnam-date history filters, pagination, batching, and active/history separation passed.");
