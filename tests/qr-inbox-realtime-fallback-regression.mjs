import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFile(path.join(projectRoot, file), "utf8");
const [source, html] = await Promise.all([
  read("assets/order-inbox.js"),
  read("order_inbox.html"),
]);

function functionSource(name) {
  const match = source.match(new RegExp(`^  (?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^  \\}$`, "m"));
  assert.ok(match, `missing function ${name}`);
  return match[0];
}

const loadOrders = functionSource("loadOrders");
const scheduleRefresh = functionSource("scheduleRefresh");
const startFallbackPolling = functionSource("startFallbackPolling");
const stopFallbackPolling = functionSource("stopFallbackPolling");
const subscribeRealtime = functionSource("subscribeRealtime");
const bindEvents = functionSource("bindEvents");
const boot = functionSource("boot");

// There is exactly one 15-second data timer, and it exists only as a guarded
// fallback while Realtime or REST reconciliation is unhealthy.
assert.equal((source.match(/15000/g) || []).length, 1);
assert.match(startFallbackPolling, /if \(pollTimer\) return/);
assert.match(startFallbackPolling, /setInterval\([\s\S]*?visibilityState === "visible"[\s\S]*?navigator\.onLine[\s\S]*?loadOrders\(\)[\s\S]*?15000/);
assert.match(stopFallbackPolling, /clearInterval\(pollTimer\)[\s\S]*?pollTimer = null/);
assert.doesNotMatch(boot, /startPolling|startFallbackPolling/);
assert.doesNotMatch(source, /function startPolling/);

// A successful reconciliation that started on the live channel disables the
// fallback. Failures enable it, and events received during a load queue one
// follow-up refresh instead of being silently discarded.
assert.match(loadOrders, /if \(isLoading\) \{[\s\S]*?refreshAfterLoad = true/);
assert.match(loadOrders, /loadStartedWithRealtime = realtimeStatus === "connected"/);
assert.match(loadOrders, /loadStartedWithRealtime && realtimeStatus === "connected"[\s\S]*?stopFallbackPolling\(\)/);
assert.match(loadOrders, /catch \(error\) \{[\s\S]*?lastLoadFailed = true[\s\S]*?startFallbackPolling\(\)/);
assert.match(loadOrders, /if \(refreshAfterLoad\) \{[\s\S]*?refreshAfterLoad = false[\s\S]*?scheduleRefresh\(0, \{ includeHistory: includeQueuedHistory \}\)/);

// Realtime events are wake-up signals only while the page is visible and
// online. A fresh subscription always reconciles once before polling stops.
assert.match(scheduleRefresh, /visibilityState !== "visible" \|\| !global\.navigator\.onLine[\s\S]*?return/);
assert.match(subscribeRealtime, /const previousChannel = realtimeChannel;[\s\S]*?realtimeChannel = null;[\s\S]*?removeChannel\(previousChannel\)/);
assert.match(subscribeRealtime, /if \(realtimeChannel !== channel\) return/);
assert.match(subscribeRealtime, /status === "SUBSCRIBED"[\s\S]*?realtimeStatus = "connected"[\s\S]*?scheduleRefresh\(0, \{ includeHistory: true \}\)/);
assert.doesNotMatch(subscribeRealtime.match(/status === "SUBSCRIBED"[\s\S]*?else if/)[0], /stopFallbackPolling/);
assert.match(subscribeRealtime, /status === "CHANNEL_ERROR" \|\| status === "TIMED_OUT"[\s\S]*?startFallbackPolling\(\)[\s\S]*?queueRealtimeReconnect\(\)/);
assert.match(subscribeRealtime, /status === "CLOSED"[\s\S]*?realtimeChannel = null[\s\S]*?startFallbackPolling\(\)[\s\S]*?queueRealtimeReconnect\(1000\)/);

// Returning to the tab or network performs an immediate load and repairs the
// channel. Leaving the network or page cannot let an old callback revive work.
assert.match(bindEvents, /visibilitychange[\s\S]*?visibilityState === "visible"[\s\S]*?loadOrders\(\)[\s\S]*?realtimeStatus !== "connected"[\s\S]*?subscribeRealtime\(\)/);
assert.match(bindEvents, /addEventListener\("online"[\s\S]*?subscribeRealtime\(\)[\s\S]*?loadOrders\(\)/);
assert.match(bindEvents, /addEventListener\("offline"[\s\S]*?realtimeChannel = null[\s\S]*?removeChannel\(offlineChannel\)[\s\S]*?startFallbackPolling\(\)/);
assert.match(bindEvents, /addEventListener\("beforeunload"[\s\S]*?realtimeChannel = null[\s\S]*?removeChannel\(closingChannel\)/);

assert.match(source, /실시간 연결/);
assert.match(source, /연결 복구 중 · 15초마다 자동 확인/);
assert.match(source, /오프라인 · 연결되면 즉시 동기화/);
assert.match(html, /assets\/order-inbox\.js\?v=20260927-history-filter/);

console.log("QR inbox Realtime fallback regression checks passed.");
