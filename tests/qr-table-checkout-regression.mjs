import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFile(path.join(projectRoot, file), "utf8");
const [inboxSource, inboxHtml, guestSource, guestOpenOrdersMigration, guestTotalsMigration] = await Promise.all([
  read("assets/order-inbox.js"),
  read("order_inbox.html"),
  read("assets/qr-menu.js"),
  read("supabase/migrations/20260926171000_qr_guest_open_orders.sql"),
  read("supabase/migrations/20260926182000_qr_guest_table_total.sql"),
]);

function functionSource(source, name) {
  const match = source.match(new RegExp(`^  (?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^  \\}$`, "m"));
  assert.ok(match, `missing function ${name}`);
  return match[0];
}

const actions = functionSource(inboxSource, "actionButtons");
const groupCheckout = functionSource(inboxSource, "renderTableCheckout");
const openPayment = functionSource(inboxSource, "openPayment");
const finalizePayment = functionSource(inboxSource, "finalizePayment");
const finalizeRpc = functionSource(inboxSource, "finalizeTableOrders");
const renderOrders = functionSource(inboxSource, "renderOrders");

// Orders are still acknowledged, edited, and cancelled individually, but the
// paid ledger action only exists once at the table level.
assert.doesNotMatch(actions, /data-action="(?:payment|table-payment)"/);
assert.match(groupCheckout, /openOrdersForTable\(group\.tableId\)/);
assert.match(groupCheckout, /data-action="table-payment"/);
assert.match(groupCheckout, /테이블 전체 결제/);
assert.match(renderOrders, /collapseFinalizedSales\(filteredOrders\(\)\)/);
assert.match(inboxSource, /new Set\(orders\.filter\(\(order\) => order\.finalized_order_id\)\.map\(\(order\) => order\.finalized_order_id\)\)/);

// The modal is built from every accepted/unfinalized order for the table. Any
// submitted order blocks checkout both when opening and immediately before RPC.
assert.match(openPayment, /openOrdersForTable\(tableId\)/);
assert.match(openPayment, /order\.status === "submitted"/);
assert.match(openPayment, /미확인 주문이 있으면 테이블 전체 결제를 진행할 수 없습니다/);
assert.match(openPayment, /order\.status === "accepted"/);
assert.match(openPayment, /paymentOrders = accepted\.map/);
assert.match(finalizePayment, /openOrdersForTable\(paymentTableId\)[\s\S]*?order\.status === "submitted"/);
assert.match(finalizePayment, /paymentOrders\.map\(\(order\) => \(\{[\s\S]*?id: order\.id,[\s\S]*?updated_at: order\.updated_at/);

// Keep the PostgREST contract in one adapter so a database signature adjustment
// cannot accidentally leave a second legacy per-order checkout path behind.
assert.match(finalizeRpc, /sb\.rpc\("app_finalize_qr_table_orders_checked", \{/);
assert.match(finalizeRpc, /p_table_id: tableId/);
assert.match(finalizeRpc, /p_expected_orders: expectedOrders/);
assert.doesNotMatch(inboxSource, /app_finalize_qr_order_checked/);
assert.equal((inboxSource.match(/app_finalize_qr_table_orders_checked/g) || []).length, 1);
assert.match(finalizePayment, /\["staff", "admin"\]\.includes\(identity\?\.role\)/);
assert.match(finalizePayment, /markTableCheckoutComplete\(data, paymentMethod\)[\s\S]*?closePayment\(\)[\s\S]*?await loadOrders\(\)/);
assert.match(functionSource(inboxSource, "markTableCheckoutComplete"), /finalizedIds\.has\(order\.id\)[\s\S]*?finalized_order_id: paidOrderId[\s\S]*?renderOrders\(\)/);

assert.match(inboxHtml, /id="paymentTitle">테이블 전체 결제/);
assert.match(inboxHtml, /id="paymentOrderSummary"/);
assert.match(inboxHtml, /신규 주문이 남아 있으면 결제할 수 없습니다/);
assert.match(inboxHtml, /assets\/order-inbox\.js\?v=20260927-history-filter/);

// Card +7% uses the same aggregate rounding helpers as calc: whole USD and
// nearest 1,000 VND, applied once to the table total rather than per QR order.
assert.match(functionSource(inboxSource, "cardAdjustedTotals"), /Math\.round\(\(Number\(baseUsd\)[\s\S]*?\* 1\.07\)/);
assert.match(functionSource(inboxSource, "cardAdjustedTotals"), /roundVndToThousand\(\(Number\(baseVnd\)[\s\S]*?\* 1\.07\)/);
assert.match(functionSource(inboxSource, "updatePaymentPreview"), /sumOrderTotals\(paymentOrders\)/);

// A paid table disappears from the guest's current-order payload because only
// submitted/accepted, non-finalized rows are returned and rendered.
assert.match(guestOpenOrdersMigration, /qr_order\.status in \('submitted', 'accepted'\)/i);
assert.match(guestOpenOrdersMigration, /qr_order\.finalized_order_id is null/i);
assert.match(functionSource(guestSource, "normalizeCurrentOrders"), /\["submitted", "accepted"\]\.includes\(order\.status\)/);
const guestHtml = await read("menu.html");
assert.match(guestHtml, /id="currentOrdersTotal"[^>]*hidden/);
assert.match(guestHtml, /assets\/qr-menu\.js\?v=20260926-table-total/);
const normalizeCurrentTotals = functionSource(guestSource, "normalizeCurrentTotals");
assert.match(functionSource(guestSource, "nonNegativeSafeInteger"), /Number\.isSafeInteger\(value\)[\s\S]*?value >= 0/);
assert.match(normalizeCurrentTotals, /payload\?\.current_total_usd/);
assert.match(normalizeCurrentTotals, /payload\?\.current_total_vnd/);
assert.match(normalizeCurrentTotals, /serverUsd !== null && serverVnd !== null/);
assert.match(normalizeCurrentTotals, /currentOrders\.reduce/);
assert.match(normalizeCurrentTotals, /total\.usd \+= nonNegativeInteger\(order\.total_usd\)/);
assert.match(normalizeCurrentTotals, /total\.vnd \+= nonNegativeInteger\(order\.total_vnd\)/);
const renderCurrentOrders = functionSource(guestSource, "renderCurrentOrders");
assert.match(renderCurrentOrders, /formatVnd\(state\.currentTotals\.vnd\)[\s\S]*?formatUsd\(state\.currentTotals\.usd\)/);
assert.match(renderCurrentOrders, /currentOrdersTotal\.replaceChildren\(\)[\s\S]*?currentOrdersTotal\.hidden = !hasCurrentOrders[\s\S]*?if \(!hasCurrentOrders\) return/);

const guestNormalizationContext = vm.createContext({ result: null });
vm.runInContext(`
  ${functionSource(guestSource, "nonNegativeInteger")}
  ${functionSource(guestSource, "nonNegativeSafeInteger")}
  ${normalizeCurrentTotals}
  const visibleOrders = [
    { total_vnd: 125000, total_usd: 5 },
    { total_vnd: 75000, total_usd: 3 }
  ];
  result = {
    server: normalizeCurrentTotals({ current_total_vnd: 425000, current_total_usd: 17 }, visibleOrders),
    legacy: normalizeCurrentTotals({}, visibleOrders),
    rejectedNegativePair: normalizeCurrentTotals({ current_total_vnd: -1, current_total_usd: 17 }, visibleOrders),
    rejectedUnsafePair: normalizeCurrentTotals({ current_total_vnd: Number.MAX_SAFE_INTEGER + 1, current_total_usd: 17 }, visibleOrders)
  };
`, guestNormalizationContext);
assert.deepEqual(JSON.parse(JSON.stringify(guestNormalizationContext.result)), {
  server: { usd: 17, vnd: 425000 },
  legacy: { usd: 8, vnd: 200000 },
  rejectedNegativePair: { usd: 8, vnd: 200000 },
  rejectedUnsafePair: { usd: 8, vnd: 200000 },
});

const guestMenuFunction = guestTotalsMigration.match(
  /create or replace function public\.internal_qr_get_menu\(p_token_hash text\)[\s\S]*?\n\$\$;/i,
)?.[0];
assert.ok(guestMenuFunction, "whole-table guest total menu replacement is missing");
assert.match(guestMenuFunction, /security invoker[\s\S]*?set search_path = ''/i);
assert.match(guestMenuFunction, /internal_qr_take_rate_limit\([\s\S]*?'get_menu:table:'[\s\S]*?300,[\s\S]*?60/i);
assert.match(guestMenuFunction, /current_orders[\s\S]*?order by qr_order\.submitted_at desc, qr_order\.id desc[\s\S]*?limit 20/i);
assert.match(
  guestMenuFunction,
  /sum\(qr_order\.total_usd::bigint\)[\s\S]*?sum\(qr_order\.total_vnd::bigint\)[\s\S]*?where qr_order\.table_id = v_table\.id[\s\S]*?status in \('submitted', 'accepted'\)[\s\S]*?finalized_order_id is null/i,
  "guest totals must aggregate every unpaid current order independently of the 20-row list cap",
);
assert.match(guestMenuFunction, /'current_total_usd', v_current_total_usd[\s\S]*?'current_total_vnd', v_current_total_vnd/i);
assert.match(
  guestTotalsMigration,
  /revoke execute on function public\.internal_qr_get_menu\(text\)[\s\S]*?from public, anon, authenticated, service_role[\s\S]*?grant execute on function public\.internal_qr_get_menu\(text\)[\s\S]*?to service_role/i,
);
const guestTotalsTopLevelDdl = guestTotalsMigration.replace(/\$\$[\s\S]*?\$\$/g, "$$FUNCTION_BODY$$");
assert.doesNotMatch(
  guestTotalsTopLevelDdl,
  /(?:^|;)\s*(?:insert|update|delete|truncate|merge)\b/im,
  "deploying the guest-total migration itself must not mutate business rows",
);

const guestTotalsContext = vm.createContext({ result: null });
vm.runInContext(`
  const node = () => ({ hidden: false, children: [], replaceChildren() { this.children = []; }, append(...children) { this.children.push(...children); } });
  const el = {
    currentOrdersList: node(),
    currentOrdersSection: node(),
    currentOrdersTotal: node(),
    currentOrdersLimit: node()
  };
  const state = {
    currentOrdersTruncated: false,
    currentTotals: { usd: 12, vnd: 300000 },
    currentOrders: [
      { order_number: "A1", status: "submitted", total_vnd: 125000, total_usd: 5, submitted_at: "", items: [] },
      { order_number: "A2", status: "accepted", total_vnd: 75000, total_usd: 3, submitted_at: "", items: [] }
    ]
  };
  const make = (_tag, className = "", textContent = "") => ({ className, textContent, dataset: {}, children: [], append(...children) { this.children.push(...children); } });
  const t = (key) => ({ currentOrdersTotal: "TABLE TOTAL", orderNumber: "ORDER", statusAccepted: "ACCEPTED", statusSubmitted: "SUBMITTED", total: "TOTAL" }[key] || key);
  const nonNegativeInteger = (value) => Math.max(0, Number(value) || 0);
  const formatVnd = (value) => value + " VND";
  const formatUsd = (value) => value + "$";
  const formatOrderTime = () => "";
  const nameOf = () => "MENU";
  ${renderCurrentOrders}
  renderCurrentOrders();
  const populated = {
    sectionHidden: el.currentOrdersSection.hidden,
    totalHidden: el.currentOrdersTotal.hidden,
    totalText: el.currentOrdersTotal.children.map((child) => child.textContent)
  };
  state.currentOrders = [];
  renderCurrentOrders();
  result = {
    populated,
    emptySectionHidden: el.currentOrdersSection.hidden,
    emptyTotalHidden: el.currentOrdersTotal.hidden,
    emptyTotalChildren: el.currentOrdersTotal.children.length
  };
`, guestTotalsContext);
assert.deepEqual(JSON.parse(JSON.stringify(guestTotalsContext.result.populated)), {
  sectionHidden: false,
  totalHidden: false,
  totalText: ["TABLE TOTAL", "300000 VND · 12$"],
});
assert.equal(guestTotalsContext.result.emptySectionHidden, true);
assert.equal(guestTotalsContext.result.emptyTotalHidden, true);
assert.equal(guestTotalsContext.result.emptyTotalChildren, 0);

console.log("QR table-wide checkout UI, stale-set, aggregate-fee, and guest-clear contracts passed.");
