(function initOrderInbox(global) {
  "use strict";

  const sb = global.DGV.supabase;
  const ui = global.QRStaff;
  const CURRENT_STATUSES = Object.freeze(["submitted", "accepted"]);
  const BUSINESS_TIME_ZONE = "Asia/Ho_Chi_Minh";
  const BUSINESS_UTC_OFFSET_MINUTES = 7 * 60;
  const HISTORY_RANGES = Object.freeze(["today", "yesterday", "week", "date"]);
  const STATUS_META = Object.freeze({
    submitted: { label: "신규 주문", tone: "new" },
    accepted: { label: "주문 확인", tone: "ready" },
    cancelled: { label: "취소", tone: "cancelled" }
  });
  const NEXT_ACTION = Object.freeze({
    submitted: { status: "accepted", label: "주문 확인" }
  });

  let identity = null;
  let orders = [];
  let isLoading = false;
  let didInitialLoad = false;
  let pollTimer = null;
  let attentionTimer = null;
  let refreshTimer = null;
  let reconnectTimer = null;
  let historyDayTimer = null;
  let realtimeChannel = null;
  let realtimeStatus = "disconnected";
  let refreshAfterLoad = false;
  let refreshAfterLoadHistory = false;
  let scheduledRefreshIncludesHistory = false;
  let lastLoadFailed = false;
  let historyLoadFailed = false;
  let lastSyncedAt = null;
  let paymentTableId = null;
  let paymentTableLabel = "";
  let paymentOrders = [];
  let editOrderId = null;
  let editExpectedUpdatedAt = null;
  let editLines = [];
  let editOriginalSnapshots = new Map();
  let editableMenus = [];
  let editableMenusLoaded = false;
  let editableMenusPromise = null;
  let historyRange = "today";
  let historyCustomDate = "";
  const knownOrderIds = new Set();
  const alertedOrderIds = new Set();
  const highlightedOrderIds = new Set();

  function businessDateKey(value = new Date()) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return global.DGV.formatYmdInTimeZone(date, BUSINESS_TIME_ZONE);
  }

  function shiftBusinessDateKey(dateKey, days) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey || ""));
    if (!match) return "";
    const shifted = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days));
    return shifted.toISOString().slice(0, 10);
  }

  function businessDayStartIso(dateKey) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey || ""));
    if (!match) return "";
    const utcMidnight = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return new Date(utcMidnight - BUSINESS_UTC_OFFSET_MINUTES * 60 * 1000).toISOString();
  }

  function historyWindowFor(range, customDate, now = new Date()) {
    const todayKey = businessDateKey(now);
    let startKey = todayKey;
    let endKey = shiftBusinessDateKey(todayKey, 1);
    if (range === "yesterday") {
      startKey = shiftBusinessDateKey(todayKey, -1);
      endKey = todayKey;
    } else if (range === "week") {
      startKey = shiftBusinessDateKey(todayKey, -6);
    } else if (range === "date" && /^\d{4}-\d{2}-\d{2}$/.test(customDate || "")) {
      startKey = customDate;
      endKey = shiftBusinessDateKey(customDate, 1);
    }
    return {
      range,
      startKey,
      endKey,
      startIso: businessDayStartIso(startKey),
      endIso: businessDayStartIso(endKey)
    };
  }

  function millisecondsUntilBusinessTomorrow(now = new Date()) {
    const tomorrowKey = shiftBusinessDateKey(businessDateKey(now), 1);
    const tomorrowStart = new Date(businessDayStartIso(tomorrowKey)).getTime();
    return Math.max(1000, tomorrowStart - now.getTime() + 1000);
  }

  function selectedHistoryWindow() {
    return historyWindowFor(historyRange, historyCustomDate);
  }

  function historyWindowKey(window) {
    return `${window.startIso}|${window.endIso}`;
  }

  function historyTimestamp(order) {
    if (order.finalized_order_id) return order.finalized_at || order.updated_at || order.submitted_at;
    if (order.status === "cancelled") return order.cancelled_at || order.updated_at || order.submitted_at;
    return "";
  }

  function isHistoricalOrder(order) {
    return Boolean(order.finalized_order_id || order.status === "cancelled");
  }

  function isInSelectedHistoryWindow(order) {
    if (!isHistoricalOrder(order)) return true;
    const timestamp = new Date(historyTimestamp(order)).getTime();
    const window = selectedHistoryWindow();
    return Number.isFinite(timestamp)
      && timestamp >= new Date(window.startIso).getTime()
      && timestamp < new Date(window.endIso).getTime();
  }

  function historyDateLabel(dateKey) {
    const todayKey = businessDateKey();
    const yesterdayKey = shiftBusinessDateKey(todayKey, -1);
    const reference = new Date(new Date(businessDayStartIso(dateKey)).getTime() + 12 * 60 * 60 * 1000);
    const formatted = new Intl.DateTimeFormat("ko-KR", {
      timeZone: BUSINESS_TIME_ZONE,
      year: "numeric",
      month: "long",
      day: "numeric",
      weekday: "short"
    }).format(reference);
    if (dateKey === todayKey) return `오늘 · ${formatted}`;
    if (dateKey === yesterdayKey) return `어제 · ${formatted}`;
    return formatted;
  }

  function historyRangeLabel() {
    if (historyRange === "today") return "오늘 기록";
    if (historyRange === "yesterday") return "어제 기록";
    if (historyRange === "week") return "최근 7일 기록";
    return `${historyDateLabel(historyCustomDate).replace(/^(오늘|어제) · /, "")} 기록`;
  }

  function relationOne(value) {
    return Array.isArray(value) ? value[0] || null : value || null;
  }

  function relationMany(value) {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
  }

  async function mapWithConcurrency(items, concurrency, worker) {
    const results = new Array(items.length);
    let cursor = 0;
    const run = async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await worker(items[index], index);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
    return results;
  }

  function statusMeta(status) {
    return STATUS_META[status] || { label: status || "알 수 없음", tone: "done" };
  }

  function getPaymentMethod() {
    return global.document.querySelector('input[name="paymentMethod"]:checked')?.value || "cash";
  }

  function roundVndToThousand(value) {
    return Math.round((Number(value) || 0) / 1000) * 1000;
  }

  function cardAdjustedTotals(baseUsd, baseVnd) {
    return {
      totalUsd: Math.round((Number(baseUsd) || 0) * 1.07),
      totalVnd: roundVndToThousand((Number(baseVnd) || 0) * 1.07)
    };
  }

  function sumOrderTotals(orderRows) {
    return orderRows.reduce((total, order) => {
      total.usd += Number(order.total_usd) || 0;
      total.vnd += Number(order.total_vnd) || 0;
      return total;
    }, { usd: 0, vnd: 0 });
  }

  function openOrdersForTable(tableId) {
    return orders
      .filter((order) => order.table_id === tableId
        && CURRENT_STATUSES.includes(order.status)
        && !order.finalized_order_id)
      .sort((a, b) => new Date(a.submitted_at) - new Date(b.submitted_at));
  }

  function collapseFinalizedSales(orderRows) {
    const result = [];
    const sales = new Map();
    orderRows.forEach((order) => {
      if (!order.finalized_order_id) {
        result.push(order);
        return;
      }
      let sale = sales.get(order.finalized_order_id);
      if (!sale) {
        sale = { ...order, checkout_orders: [] };
        sales.set(order.finalized_order_id, sale);
        result.push(sale);
      }
      sale.checkout_orders.push(order);
    });
    sales.forEach((sale) => {
      sale.checkout_orders.sort((a, b) => new Date(a.submitted_at) - new Date(b.submitted_at));
      sale.items = sale.checkout_orders.flatMap((order) => order.items);
      sale.checkout_order_count = sale.checkout_orders.length;
    });
    return result;
  }

  function showBanner(message, tone = "error") {
    const banner = ui.byId("inboxBanner");
    banner.textContent = message;
    banner.dataset.tone = tone;
    banner.hidden = false;
  }

  function hideBanner() {
    ui.byId("inboxBanner").hidden = true;
  }

  function normalizeOrder(row) {
    const table = relationOne(row.qr_tables);
    const items = relationMany(row.qr_order_items)
      .slice()
      .sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
    return {
      ...row,
      table_label: table?.label || row.table_label || "미지정",
      items
    };
  }

  async function fetchWithRelations(statuses, options = {}) {
    const { finalized = null, dateColumn = "", historyWindow = null } = options;
    const orderColumn = dateColumn || "submitted_at";
    const rows = await global.DGV.collectSupabasePages(() => {
      let query = sb
        .from("qr_orders")
        .select("id,table_id,client_request_id,status,note,total_usd,total_vnd,submitted_at,updated_at,accepted_at,cancelled_at,finalized_at,finalized_order_id,qr_tables(label),qr_order_items(id,qr_order_id,menu_item_id,qty,menu_type,ko_name,vi_name,en_name,unit_usd,unit_vnd,line_usd,line_vnd,created_at)")
        .in("status", statuses);
      if (finalized === true) query = query.not("finalized_order_id", "is", null);
      if (finalized === false) query = query.is("finalized_order_id", null);
      if (dateColumn && historyWindow) {
        query = query.gte(dateColumn, historyWindow.startIso).lt(dateColumn, historyWindow.endIso);
      }
      return query;
    }, {
      order: [
        { column: orderColumn, ascending: false },
        { column: "id", ascending: false }
      ]
    });
    return rows.map(normalizeOrder);
  }

  async function fetchWithoutRelations(statuses, options = {}) {
    const { finalized = null, dateColumn = "", historyWindow = null } = options;
    const orderColumn = dateColumn || "submitted_at";
    const orderRows = await global.DGV.collectSupabasePages(() => {
      let orderQuery = sb
        .from("qr_orders")
        .select("id,table_id,client_request_id,status,note,total_usd,total_vnd,submitted_at,updated_at,accepted_at,cancelled_at,finalized_at,finalized_order_id")
        .in("status", statuses);
      if (finalized === true) orderQuery = orderQuery.not("finalized_order_id", "is", null);
      if (finalized === false) orderQuery = orderQuery.is("finalized_order_id", null);
      if (dateColumn && historyWindow) {
        orderQuery = orderQuery.gte(dateColumn, historyWindow.startIso).lt(dateColumn, historyWindow.endIso);
      }
      return orderQuery;
    }, {
      order: [
        { column: orderColumn, ascending: false },
        { column: "id", ascending: false }
      ]
    });

    const ids = orderRows.map((row) => row.id);
    const tableIds = [...new Set(orderRows.map((row) => row.table_id).filter(Boolean))];
    const itemChunks = Array.from({ length: Math.ceil(ids.length / 40) }, (_, index) => (
      ids.slice(index * 40, (index + 1) * 40)
    ));
    const [tableResult, itemResults] = await Promise.all([
      tableIds.length
        ? sb.from("qr_tables").select("id,label").in("id", tableIds)
        : Promise.resolve({ data: [], error: null }),
      mapWithConcurrency(itemChunks, 4, (chunk) => (
        sb
          .from("qr_order_items")
          .select("id,qr_order_id,menu_item_id,qty,menu_type,ko_name,vi_name,en_name,unit_usd,unit_vnd,line_usd,line_vnd,created_at")
          .in("qr_order_id", chunk)
          .order("created_at", { ascending: true })
      ))
    ]);
    if (tableResult.error) throw tableResult.error;
    const failedItems = itemResults.find((result) => result.error);
    if (failedItems?.error) throw failedItems.error;

    const tables = new Map((tableResult.data || []).map((row) => [row.id, row]));
    const itemsByOrder = new Map();
    itemResults.flatMap((result) => result.data || []).forEach((item) => {
      if (!itemsByOrder.has(item.qr_order_id)) itemsByOrder.set(item.qr_order_id, []);
      itemsByOrder.get(item.qr_order_id).push(item);
    });
    return orderRows.map((row) => normalizeOrder({
      ...row,
      qr_tables: tables.get(row.table_id) || null,
      qr_order_items: itemsByOrder.get(row.id) || []
    }));
  }

  async function attachPaidTotals(orderRows) {
    const finalizedIds = [...new Set(orderRows
      .filter((order) => order.finalized_order_id)
      .map((order) => order.id))];
    if (!finalizedIds.length) return { rows: orderRows, error: null };
    const batches = Array.from({ length: Math.ceil(finalizedIds.length / 200) }, (_, index) => (
      finalizedIds.slice(index * 200, (index + 1) * 200)
    ));
    const results = await mapWithConcurrency(batches, 4, (ids) => sb.rpc("app_get_qr_paid_totals", {
      p_qr_order_ids: ids
    }));
    const failed = results.find((result) => result.error);
    if (failed?.error) {
      console.warn("Final QR paid-total lookup failed; suppressing the potentially different base amount.", failed.error);
      return { rows: orderRows, error: failed.error };
    }
    const paidByQrOrder = new Map(results.flatMap((result) => result.data || []).map((row) => [row.qr_order_id, row]));
    return {
      rows: orderRows.map((order) => {
        const paid = paidByQrOrder.get(order.id);
        return paid ? {
          ...order,
          paid_total_usd: paid.total_usd,
          paid_total_vnd: paid.total_vnd,
          paid_payment_method: paid.payment_method
        } : order;
      }),
      error: null
    };
  }

  async function fetchActiveOrders() {
    try {
      return await Promise.all([
        fetchWithRelations(["submitted"]),
        fetchWithRelations(["accepted"], { finalized: false })
      ]);
    } catch (embeddedError) {
      console.warn("Embedded active QR order query failed; using relationship-cache fallback.", embeddedError);
      return Promise.all([
        fetchWithoutRelations(["submitted"]),
        fetchWithoutRelations(["accepted"], { finalized: false })
      ]);
    }
  }

  async function fetchHistoryOrders(historyWindow) {
    try {
      return await Promise.all([
        fetchWithRelations(["accepted"], { finalized: true, dateColumn: "finalized_at", historyWindow }),
        fetchWithRelations(["cancelled"], { dateColumn: "cancelled_at", historyWindow })
      ]);
    } catch (embeddedError) {
      console.warn("Embedded QR order history query failed; using relationship-cache fallback.", embeddedError);
      return Promise.all([
        fetchWithoutRelations(["accepted"], { finalized: true, dateColumn: "finalized_at", historyWindow }),
        fetchWithoutRelations(["cancelled"], { dateColumn: "cancelled_at", historyWindow })
      ]);
    }
  }

  async function fetchOrders(historyWindow = selectedHistoryWindow(), includeHistory = true) {
    const uniqueOrders = (groups) => [...new Map(groups.flat().map((order) => [order.id, order])).values()];
    if (!includeHistory) {
      const activeGroups = await fetchActiveOrders();
      const activeRows = uniqueOrders(activeGroups);
      const cachedHistoryRows = orders.filter(isHistoricalOrder);
      return { rows: [...activeRows, ...cachedHistoryRows], historyError: null, historySkipped: true };
    }
    const [activeResult, historyResult] = await Promise.allSettled([
      fetchActiveOrders(),
      fetchHistoryOrders(historyWindow)
    ]);
    if (activeResult.status === "rejected") throw activeResult.reason;
    const historyGroups = historyResult.status === "fulfilled" ? historyResult.value : [];
    const rows = uniqueOrders([...activeResult.value, ...historyGroups]);
    const paidTotals = await attachPaidTotals(rows);
    return {
      rows: paidTotals.rows,
      historyError: historyResult.status === "rejected" ? historyResult.reason : paidTotals.error,
      historySkipped: false
    };
  }

  function announceNewOrders(nextOrders) {
    const submitted = nextOrders.filter((order) => order.status === "submitted");
    if (!didInitialLoad) {
      nextOrders.forEach((order) => knownOrderIds.add(order.id));
      didInitialLoad = true;
      return;
    }
    const fresh = submitted.filter((order) => !knownOrderIds.has(order.id) && !alertedOrderIds.has(order.id));
    nextOrders.forEach((order) => knownOrderIds.add(order.id));
    if (!fresh.length) return;
    fresh.forEach((order) => {
      alertedOrderIds.add(order.id);
      highlightedOrderIds.add(order.id);
    });
    ui.playAlert();
    const tables = fresh.map((order) => order.table_label).join(", ");
    ui.toast(`새 주문 ${fresh.length}건이 들어왔습니다. (${tables})`, "ok", 6500);
  }

  function filteredOrders() {
    const filter = ui.byId("statusFilter").value;
    if (filter === "current") {
      return orders.filter((order) => order.status === "submitted" || (order.status === "accepted" && !order.finalized_order_id));
    }
    const statusRows = filter === "all" ? orders : orders.filter((order) => order.status === filter);
    return statusRows.filter(isInSelectedHistoryWindow);
  }

  function renderSummary() {
    const count = (status) => orders.filter((order) => order.status === status).length;
    ui.byId("submittedCount").textContent = count("submitted").toLocaleString("ko-KR");
    ui.byId("acceptedCount").textContent = orders.filter((order) => order.status === "accepted" && !order.finalized_order_id).length.toLocaleString("ko-KR");
    ui.byId("finalizedCount").textContent = new Set(orders.filter((order) => order.finalized_order_id).map((order) => order.finalized_order_id)).size.toLocaleString("ko-KR");
    ui.byId("visibleCount").textContent = collapseFinalizedSales(filteredOrders()).length.toLocaleString("ko-KR");
  }

  function renderItem(item) {
    const name = item.ko_name || item.en_name || item.vi_name || "메뉴";
    const sub = [item.en_name, item.vi_name].filter(Boolean).join(" · ");
    return `
      <div class="qr-line-item">
        <div>
          <div class="qr-line-name">${global.DGV.escapeHTML(name)} × ${Number(item.qty || 0).toLocaleString("ko-KR")}</div>
          ${sub ? `<div class="qr-line-sub">${global.DGV.escapeHTML(sub)}</div>` : ""}
        </div>
        <div class="qr-line-price">${ui.formatVnd(item.line_vnd)}</div>
      </div>`;
  }

  function actionButtons(order) {
    const next = NEXT_ACTION[order.status];
    const buttons = [];
    if (next) {
      buttons.push(`<button class="qr-btn qr-btn-primary" type="button" data-action="transition" data-order-id="${order.id}" data-status="${next.status}">${next.label}</button>`);
    }
    if (CURRENT_STATUSES.includes(order.status) && !order.finalized_order_id) {
      buttons.push(`<button class="qr-btn" type="button" data-action="edit" data-order-id="${order.id}">주문 수정</button>`);
      buttons.push(`<button class="qr-btn qr-btn-danger" type="button" data-action="transition" data-order-id="${order.id}" data-status="cancelled">주문 취소</button>`);
    }
    if (order.finalized_order_id) {
      buttons.push(`<span class="qr-status" data-tone="ready">매출 등록 완료</span>`);
    }
    return buttons.length ? `<div class="qr-order-actions">${buttons.join("")}</div>` : "";
  }

  function renderOrderCard(order) {
      const status = statusMeta(order.status);
      const isNew = order.status === "submitted"
        ? (highlightedOrderIds.has(order.id) ? " is-new needs-attention" : " needs-attention")
        : "";
      const checkoutOrders = order.checkout_orders || [order];
      const bundledSale = Boolean(order.finalized_order_id && checkoutOrders.length > 1);
      const note = String(order.note || "").trim();
      const items = bundledSale
        ? checkoutOrders.map((checkoutOrder, index) => {
            const checkoutItems = checkoutOrder.items.length
              ? checkoutOrder.items.map(renderItem).join("")
              : '<div class="qr-hint">주문 상세를 불러오지 못했습니다.</div>';
            const checkoutNote = String(checkoutOrder.note || "").trim();
            return `
              <section class="qr-sale-order-detail">
                <div class="qr-sale-order-title">주문 ${index + 1} · ${ui.formatTime(checkoutOrder.submitted_at, { timeZone: BUSINESS_TIME_ZONE })} · #${ui.shortId(checkoutOrder.id)}</div>
                ${checkoutItems}
                ${checkoutNote ? `<div class="qr-order-note"><strong>요청사항</strong><br>${global.DGV.escapeHTML(checkoutNote)}</div>` : ""}
              </section>`;
          }).join("")
        : (order.items.length
            ? order.items.map(renderItem).join("")
            : '<div class="qr-hint">주문 상세를 불러오지 못했습니다.</div>');
      const hasPaidTotal = order.finalized_order_id && order.paid_total_vnd != null;
      const displayTotalVnd = hasPaidTotal ? order.paid_total_vnd : order.total_vnd;
      const displayTotalUsd = hasPaidTotal ? order.paid_total_usd : order.total_usd;
      const totalLabel = hasPaidTotal
        ? `최종 결제금액${order.paid_payment_method === "card_fee7" ? " (카드 + 7%)" : ""}`
        : (order.finalized_order_id ? "최종 결제금액" : "합계");
      const totalValue = order.finalized_order_id && !hasPaidTotal
        ? '<span class="qr-muted">결제 금액을 불러오지 못했습니다.</span>'
        : `${ui.formatVnd(displayTotalVnd)}${Number(displayTotalUsd || 0) > 0 ? ` · ${ui.formatUsd(displayTotalUsd)}` : ""}`;
      const submittedTime = ui.formatTime(order.submitted_at, { timeZone: BUSINESS_TIME_ZONE });
      const orderTimeText = order.finalized_order_id
        ? `${bundledSale ? "통합 결제" : "결제"} ${ui.formatTime(order.finalized_at, { timeZone: BUSINESS_TIME_ZONE })} · 매출 #${ui.shortId(order.finalized_order_id)}`
        : order.status === "cancelled"
          ? `취소 ${ui.formatTime(order.cancelled_at, { timeZone: BUSINESS_TIME_ZONE })} · 주문 ${submittedTime} · #${ui.shortId(order.id)}`
          : `${submittedTime} · #${ui.shortId(order.id)}`;
      return `
        <article class="qr-card qr-order-card${isNew}" data-status="${global.DGV.escapeHTML(order.status)}">
          <div class="qr-order-head">
            <div>
              <div class="qr-table-no">${global.DGV.escapeHTML(order.table_label)}</div>
              <div class="qr-order-time">${orderTimeText}</div>
            </div>
            <span class="qr-status" data-tone="${status.tone}">${status.label}</span>
          </div>
          <div class="qr-order-body">
            ${items}
            ${!bundledSale && note ? `<div class="qr-order-note"><strong>요청사항</strong><br>${global.DGV.escapeHTML(note)}</div>` : ""}
            <div class="qr-order-total"><span>${totalLabel}</span><span>${totalValue}</span></div>
          </div>
          ${actionButtons(order)}
        </article>`;
  }

  function renderTableCheckout(group) {
    if (!group.tableId || ui.byId("statusFilter").value === "cancelled") return "";
    const openOrders = openOrdersForTable(group.tableId);
    if (!openOrders.length) return "";
    const submittedCount = openOrders.filter((order) => order.status === "submitted").length;
    const acceptedCount = openOrders.filter((order) => order.status === "accepted").length;
    const totals = sumOrderTotals(openOrders);
    const statusText = submittedCount
      ? `신규 ${submittedCount.toLocaleString("ko-KR")}건 · 확인 ${acceptedCount.toLocaleString("ko-KR")}건`
      : `확인 완료 ${acceptedCount.toLocaleString("ko-KR")}건`;
    return `
      <div class="qr-table-checkout">
        <div>
          <div class="qr-table-checkout-total">미결제 합계 ${ui.formatVnd(totals.vnd)}${totals.usd > 0 ? ` · ${ui.formatUsd(totals.usd)}` : ""}</div>
          <div class="qr-hint">${statusText} · 테이블의 모든 주문을 한 번에 결제합니다.</div>
        </div>
        <button class="qr-btn qr-btn-dark" type="button" data-action="table-payment" data-table-id="${global.DGV.escapeHTML(group.tableId)}">테이블 전체 결제</button>
      </div>`;
  }

  function renderTableGroups(rows, includeCheckout = true) {
    const groups = new Map();
    rows.forEach((order) => {
      const key = order.table_id || order.table_label;
      if (!groups.has(key)) groups.set(key, { tableId: order.table_id, label: order.table_label, orders: [] });
      groups.get(key).orders.push(order);
    });
    return [...groups.values()].map((group) => `
      <section class="qr-table-order-group">
        <div class="qr-table-order-group-title">
          <h3>${global.DGV.escapeHTML(group.label)}</h3>
          <span class="qr-pill">표시 ${group.orders.length.toLocaleString("ko-KR")}건</span>
        </div>
        ${includeCheckout ? renderTableCheckout(group) : ""}
        <div class="qr-table-order-cards">
          ${group.orders.map(renderOrderCard).join("")}
        </div>
      </section>`).join("");
  }

  function renderHistoryDays(rows) {
    const days = new Map();
    rows
      .slice()
      .sort((a, b) => new Date(historyTimestamp(b)) - new Date(historyTimestamp(a)))
      .forEach((order) => {
        const key = businessDateKey(historyTimestamp(order));
        if (!key) return;
        if (!days.has(key)) days.set(key, []);
        days.get(key).push(order);
      });
    return [...days.entries()]
      .sort(([left], [right]) => right.localeCompare(left))
      .map(([dateKey, dayRows]) => `
        <section class="qr-history-day" data-history-date="${dateKey}">
          <div class="qr-history-day-title">
            <h3>${historyDateLabel(dateKey)}</h3>
            <span class="qr-pill">${dayRows.length.toLocaleString("ko-KR")}건</span>
          </div>
          <div class="qr-history-day-orders">
            ${renderTableGroups(dayRows, false)}
          </div>
        </section>`).join("");
  }

  function renderOrders() {
    const grid = ui.byId("ordersGrid");
    const rows = collapseFinalizedSales(filteredOrders());
    const currentRows = rows.filter((order) => !isHistoricalOrder(order));
    const historyRows = rows.filter(isHistoricalOrder);
    const filter = ui.byId("statusFilter").value;
    const showHistory = ["accepted", "cancelled", "all"].includes(filter);
    renderSummary();
    if (!rows.length && !showHistory) {
      grid.innerHTML = '<div class="qr-empty">선택한 상태의 주문이 없습니다.</div>';
      return;
    }
    const sections = [];
    if (currentRows.length) {
      sections.push(`
        <section class="qr-order-section">
          <div class="qr-order-section-title">
            <h2>현재 주문</h2>
            <span class="qr-pill">${currentRows.length.toLocaleString("ko-KR")}건</span>
          </div>
          <div class="qr-order-section-grid">${renderTableGroups(currentRows)}</div>
        </section>`);
    }
    if (showHistory) {
      sections.push(`
        <section class="qr-order-section qr-history-section">
          <div class="qr-order-section-title">
            <h2>${historyRangeLabel()}</h2>
            <span class="qr-pill">${historyRows.length.toLocaleString("ko-KR")}건</span>
          </div>
          ${historyRows.length
            ? `<div class="qr-history-days">${renderHistoryDays(historyRows)}</div>`
            : `<div class="qr-empty qr-empty-compact">선택한 기간의 주문 기록이 없습니다.</div>`}
        </section>`);
    }
    grid.innerHTML = sections.join("") || '<div class="qr-empty">선택한 상태의 주문이 없습니다.</div>';
  }

  async function loadOrders(options = {}) {
    const includeHistory = options.includeHistory !== false;
    if (isLoading) {
      refreshAfterLoad = true;
      refreshAfterLoadHistory = refreshAfterLoadHistory || includeHistory;
      return;
    }
    const loadStartedWithRealtime = realtimeStatus === "connected";
    const requestedHistoryWindow = selectedHistoryWindow();
    isLoading = true;
    if (options.manual) ui.setBusy(ui.byId("refreshBtn"), true, "불러오는 중…");
    try {
      const result = await fetchOrders(requestedHistoryWindow, includeHistory);
      if (historyWindowKey(requestedHistoryWindow) !== historyWindowKey(selectedHistoryWindow())) {
        refreshAfterLoad = true;
        return;
      }
      const nextOrders = result.rows;
      nextOrders.sort((a, b) => new Date(b.submitted_at) - new Date(a.submitted_at));
      announceNewOrders(nextOrders);
      orders = nextOrders;
      renderOrders();
      lastSyncedAt = new Date();
      if (result.historyError) {
        console.warn("QR order history could not be refreshed; active orders remain available.", result.historyError);
        historyLoadFailed = true;
        lastLoadFailed = true;
        startFallbackPolling();
        showBanner("현재 주문은 정상적으로 불러왔지만 선택한 기간의 주문 기록을 불러오지 못했습니다. 잠시 후 다시 확인해 주세요.");
      } else if (!result.historySkipped || !historyLoadFailed) {
        if (!result.historySkipped) historyLoadFailed = false;
        hideBanner();
        lastLoadFailed = false;
        if (loadStartedWithRealtime && realtimeStatus === "connected") stopFallbackPolling();
      }
      updateLastSyncText();
    } catch (error) {
      console.error(error);
      lastLoadFailed = true;
      startFallbackPolling();
      updateLastSyncText();
      showBanner("QR 주문 데이터를 불러오지 못했습니다. DB 배포 상태와 네트워크를 확인해 주세요.");
      ui.connectionBadge(global.navigator.onLine ? "connecting" : "offline", global.navigator.onLine ? "재연결 중" : "오프라인");
    } finally {
      isLoading = false;
      if (options.manual) ui.setBusy(ui.byId("refreshBtn"), false);
      if (refreshAfterLoad) {
        const includeQueuedHistory = refreshAfterLoadHistory;
        refreshAfterLoad = false;
        refreshAfterLoadHistory = false;
        scheduleRefresh(0, { includeHistory: includeQueuedHistory });
      }
    }
  }

  function scheduleRefresh(delay = 250, options = {}) {
    if (document.visibilityState !== "visible" || !global.navigator.onLine) return;
    scheduledRefreshIncludesHistory = scheduledRefreshIncludesHistory || options.includeHistory === true;
    global.clearTimeout(refreshTimer);
    refreshTimer = global.setTimeout(() => {
      refreshTimer = null;
      const includeHistory = scheduledRefreshIncludesHistory;
      scheduledRefreshIncludesHistory = false;
      loadOrders({ includeHistory });
    }, delay);
  }

  function updateLastSyncText() {
    const synced = lastSyncedAt
      ? `${lastSyncedAt.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })} 동기화`
      : "아직 동기화되지 않았습니다.";
    let mode = "연결 복구 중 · 15초마다 자동 확인";
    if (!global.navigator.onLine || realtimeStatus === "offline") mode = "오프라인 · 연결되면 즉시 동기화";
    else if (realtimeStatus === "connected" && !lastLoadFailed && !pollTimer) mode = "실시간 연결";
    ui.byId("lastSyncText").textContent = `${synced} · ${mode}`;
  }

  function stopFallbackPolling() {
    global.clearInterval(pollTimer);
    pollTimer = null;
    updateLastSyncText();
  }

  function startFallbackPolling() {
    if (pollTimer) return;
    pollTimer = global.setInterval(() => {
      if (document.visibilityState === "visible" && global.navigator.onLine) loadOrders();
    }, 15000);
    updateLastSyncText();
  }

  function queueRealtimeReconnect(delay = 3000) {
    if (reconnectTimer || !global.navigator.onLine || document.visibilityState !== "visible") return;
    reconnectTimer = global.setTimeout(() => {
      reconnectTimer = null;
      if (realtimeStatus !== "connected" && global.navigator.onLine && document.visibilityState === "visible") {
        subscribeRealtime();
      }
    }, delay);
  }

  function menuName(menu) {
    return menu.ko_name || menu.en_name || menu.vi_name || "메뉴";
  }

  function lineAmounts(line) {
    const qty = Number(line.qty) || 0;
    return {
      usd: qty * (Number(line.unit_usd) || 0),
      vnd: qty * (Number(line.unit_vnd) || 0)
    };
  }

  async function loadEditableMenus(force = false) {
    if (!force && editableMenusLoaded) return editableMenus;
    if (editableMenusPromise) return editableMenusPromise;
    editableMenusPromise = (async () => {
      const { data, error } = await sb
        .from("menu_items")
        .select("id,type,ko_name,vi_name,en_name,price_usd,price_vnd,sort_order")
        .eq("is_active", true)
        .eq("is_orderable", true)
        .eq("is_sold_out", false)
        .eq("requires_preorder", false)
        .is("archived_at", null)
        .order("sort_order", { ascending: true, nullsFirst: false })
        .order("ko_name", { ascending: true });
      if (error) throw error;
      editableMenus = (data || []).map((menu) => ({
        ...menu,
        unit_usd: Number(menu.price_usd) || 0,
        unit_vnd: Number(menu.price_vnd) || 0
      }));
      editableMenusLoaded = true;
      return editableMenus;
    })();
    try {
      return await editableMenusPromise;
    } finally {
      editableMenusPromise = null;
    }
  }

  function renderEditMenuChoices() {
    const select = ui.byId("editMenuSelect");
    const previous = select.value;
    const term = ui.byId("editMenuSearch").value.trim().toLocaleLowerCase();
    const choices = editableMenus.filter((menu) => {
      if (!term) return true;
      return [menu.type, menu.ko_name, menu.vi_name, menu.en_name]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase()
        .includes(term);
    });
    select.replaceChildren();
    choices.forEach((menu) => {
      const option = global.document.createElement("option");
      option.value = menu.id;
      option.textContent = `${menuName(menu)} · ${ui.formatVnd(menu.unit_vnd)}${menu.unit_usd > 0 ? ` · ${ui.formatUsd(menu.unit_usd)}` : ""}`;
      select.appendChild(option);
    });
    if (choices.some((menu) => menu.id === previous)) select.value = previous;
    select.disabled = choices.length === 0;
    ui.byId("editMenuAdd").disabled = choices.length === 0;
  }

  function renderEditTotal() {
    const preview = ui.byId("editOrderTotal");
    const totalQty = editLines.reduce((sum, line) => sum + (Number(line.qty) || 0), 0);
    const totals = editLines.reduce((sum, line) => {
      const amounts = lineAmounts(line);
      sum.usd += amounts.usd;
      sum.vnd += amounts.vnd;
      return sum;
    }, { usd: 0, vnd: 0 });
    const valid = editLines.length >= 1
      && editLines.length <= 40
      && totalQty >= 1
      && totalQty <= 100
      && editLines.every((line) => Number.isInteger(Number(line.qty)) && Number(line.qty) >= 1 && Number(line.qty) <= 20);

    if (!editLines.length) {
      preview.textContent = "메뉴를 한 개 이상 남겨 주세요.";
    } else if (totalQty > 100) {
      preview.textContent = `전체 수량은 100개까지 가능합니다. (현재 ${totalQty.toLocaleString("ko-KR")}개)`;
    } else {
      preview.textContent = `수정 합계: ${ui.formatVnd(totals.vnd)}${totals.usd > 0 ? ` · ${ui.formatUsd(totals.usd)}` : ""} · 총 ${totalQty.toLocaleString("ko-KR")}개`;
    }
    preview.dataset.tone = valid ? "ok" : "error";
    ui.byId("editOrderSave").disabled = !valid;
    return valid;
  }

  function renderEditLines() {
    const container = ui.byId("editOrderLines");
    if (!editLines.length) {
      container.innerHTML = '<div class="qr-empty qr-edit-empty">남아 있는 메뉴가 없습니다. 아래에서 메뉴를 추가해 주세요.</div>';
      renderEditTotal();
      return;
    }
    container.innerHTML = editLines.map((line) => {
      const name = menuName(line);
      const sub = [line.en_name, line.vi_name].filter(Boolean).join(" · ");
      const amounts = lineAmounts(line);
      return `
        <div class="qr-edit-line" data-menu-id="${global.DGV.escapeHTML(line.menu_item_id)}">
          <div class="qr-edit-line-info">
            <div class="qr-line-name">${global.DGV.escapeHTML(name)}</div>
            ${sub ? `<div class="qr-line-sub">${global.DGV.escapeHTML(sub)}</div>` : ""}
            <div class="qr-line-sub">단가 ${ui.formatVnd(line.unit_vnd)}${Number(line.unit_usd || 0) > 0 ? ` · ${ui.formatUsd(line.unit_usd)}` : ""}</div>
          </div>
          <label class="qr-edit-qty">
            <span class="qr-label">수량</span>
            <input class="qr-input" type="number" min="1" max="20" step="1" inputmode="numeric" value="${Number(line.qty)}" data-edit-qty="${global.DGV.escapeHTML(line.menu_item_id)}" aria-label="${global.DGV.escapeHTML(name)} 수량" />
          </label>
          <div class="qr-edit-line-total">${ui.formatVnd(amounts.vnd)}</div>
          <button class="qr-btn qr-btn-small qr-btn-danger" type="button" data-edit-remove="${global.DGV.escapeHTML(line.menu_item_id)}">삭제</button>
        </div>`;
    }).join("");
    renderEditTotal();
  }

  async function openEditOrder(orderId, button) {
    const order = orders.find((row) => row.id === orderId);
    if (!order
       || !CURRENT_STATUSES.includes(order.status)
       || order.finalized_order_id
       || !["staff", "admin"].includes(identity?.role)) {
      ui.toast("현재 수정할 수 없는 주문입니다. 최신 상태를 다시 확인해 주세요.", "error");
      await loadOrders();
      return;
    }

    ui.setBusy(button, true, "불러오는 중…");
    try {
      await loadEditableMenus(true);
      const latest = orders.find((row) => row.id === orderId);
      if (!latest || !CURRENT_STATUSES.includes(latest.status) || latest.finalized_order_id) {
        throw new Error("현재 수정할 수 없는 주문입니다. 최신 상태를 다시 확인해 주세요.");
      }
      editOrderId = latest.id;
      editExpectedUpdatedAt = latest.updated_at;
      editLines = latest.items.map((line) => ({
        menu_item_id: line.menu_item_id,
        qty: Number(line.qty),
        menu_type: line.menu_type,
        ko_name: line.ko_name,
        vi_name: line.vi_name,
        en_name: line.en_name,
        unit_usd: Number(line.unit_usd) || 0,
        unit_vnd: Number(line.unit_vnd) || 0,
        snapshot: true
      }));
      editOriginalSnapshots = new Map(editLines.map((line) => [line.menu_item_id, { ...line }]));
      ui.byId("editOrderMeta").textContent = `${latest.table_label} · 주문 #${ui.shortId(latest.id)}`;
      ui.byId("editOrderNote").value = latest.note || "";
      ui.byId("editMenuSearch").value = "";
      ui.byId("editMenuQty").value = "1";
      renderEditMenuChoices();
      renderEditLines();
      ui.byId("editOrderModal").hidden = false;
      const firstQty = ui.byId("editOrderLines").querySelector("input[data-edit-qty]");
      (firstQty || ui.byId("editMenuSearch")).focus();
    } catch (error) {
      console.error(error);
      ui.toast(ui.messageOf(error, "주문 수정 화면을 준비하지 못했습니다."), "error");
    } finally {
      ui.setBusy(button, false);
    }
  }

  function closeEditOrder() {
    editOrderId = null;
    editExpectedUpdatedAt = null;
    editLines = [];
    editOriginalSnapshots = new Map();
    ui.byId("editOrderModal").hidden = true;
  }

  function addEditMenu() {
    const menuId = ui.byId("editMenuSelect").value;
    const qty = Number(ui.byId("editMenuQty").value);
    const menu = editableMenus.find((row) => row.id === menuId);
    if (!menu || !Number.isInteger(qty) || qty < 1 || qty > 20) {
      ui.toast("추가할 메뉴와 1~20 사이의 수량을 확인해 주세요.", "error");
      return;
    }
    const existing = editLines.find((line) => line.menu_item_id === menuId);
    if (existing) {
      if (Number(existing.qty) + qty > 20) {
        ui.toast("한 메뉴의 수량은 20개까지 가능합니다.", "error");
        return;
      }
      existing.qty = Number(existing.qty) + qty;
    } else {
      if (editLines.length >= 40) {
        ui.toast("한 주문에는 메뉴를 40종까지 담을 수 있습니다.", "error");
        return;
      }
      const original = editOriginalSnapshots.get(menu.id);
      editLines.push(original ? {
        ...original,
        qty
      } : {
        menu_item_id: menu.id,
        qty,
        menu_type: menu.type,
        ko_name: menu.ko_name,
        vi_name: menu.vi_name,
        en_name: menu.en_name,
        unit_usd: menu.unit_usd,
        unit_vnd: menu.unit_vnd,
        snapshot: false
      });
    }
    ui.byId("editMenuQty").value = "1";
    renderEditLines();
  }

  async function saveEditedOrder(event) {
    event.preventDefault();
    if (!editOrderId || !editExpectedUpdatedAt || !["staff", "admin"].includes(identity?.role) || !renderEditTotal()) return;
    const note = ui.byId("editOrderNote").value;
    if (note.length > 500 || /[\u0000-\u001f\u007f-\u009f]/.test(note)) {
      ui.toast("요청사항은 줄바꿈이나 제어 문자 없이 500자 이내로 입력해 주세요.", "error");
      return;
    }
    const orderId = editOrderId;
    const button = ui.byId("editOrderSave");
    ui.setBusy(button, true, "저장 중…");
    try {
      const { error } = await sb.rpc("app_update_qr_order", {
        p_order_id: orderId,
        p_expected_updated_at: editExpectedUpdatedAt,
        p_note: note.trim() || null,
        p_items: editLines.map((line) => ({
          menu_item_id: line.menu_item_id,
          qty: Number(line.qty)
        }))
      });
      if (error) throw error;
      closeEditOrder();
      ui.toast("주문 내용이 수정되었습니다.", "ok");
      await loadOrders();
    } catch (error) {
      console.error(error);
      ui.toast(ui.messageOf(error, "주문을 수정하지 못했습니다. 최신 상태를 다시 확인해 주세요."), "error");
      const staleOrClosed = error?.code === "55000";
      await loadOrders();
      const latest = orders.find((row) => row.id === orderId);
      if (staleOrClosed || !latest || !CURRENT_STATUSES.includes(latest.status) || latest.finalized_order_id) closeEditOrder();
    } finally {
      ui.setBusy(button, false);
    }
  }

  async function transitionOrder(orderId, nextStatus, button) {
    const meta = statusMeta(nextStatus);
    if (nextStatus === "cancelled" && !global.confirm("이 주문을 취소하시겠습니까?\n취소 후에는 주문 화면에서 되돌릴 수 없습니다.")) return;
    ui.setBusy(button, true, "처리 중…");
    try {
      const { error } = await sb.rpc("app_update_qr_order_status", {
        p_order_id: orderId,
        p_status: nextStatus
      });
      if (error) throw error;
      highlightedOrderIds.delete(orderId);
      ui.toast(`${meta.label} 상태로 변경되었습니다.`, "ok");
      await loadOrders();
    } catch (error) {
      console.error(error);
      ui.toast(ui.messageOf(error, "주문 상태를 변경하지 못했습니다. 최신 상태를 다시 확인해 주세요."), "error");
      await loadOrders();
    } finally {
      ui.setBusy(button, false);
    }
  }

  function renderPaymentOrderSummary() {
    const container = ui.byId("paymentOrderSummary");
    const totals = sumOrderTotals(paymentOrders);
    container.innerHTML = `
      <div class="qr-payment-summary-head">
        <strong>${global.DGV.escapeHTML(paymentTableLabel)} · 주문 ${paymentOrders.length.toLocaleString("ko-KR")}건</strong>
        <span>${ui.formatVnd(totals.vnd)}${totals.usd > 0 ? ` · ${ui.formatUsd(totals.usd)}` : ""}</span>
      </div>
      <div class="qr-payment-orders">
        ${paymentOrders.map((order, index) => `
          <section class="qr-payment-order">
            <div class="qr-payment-order-title">
              <strong>주문 ${index + 1}</strong>
              <span>${ui.formatTime(order.submitted_at, { timeZone: BUSINESS_TIME_ZONE })} · #${ui.shortId(order.id)} · ${ui.formatVnd(order.total_vnd)}${Number(order.total_usd || 0) > 0 ? ` · ${ui.formatUsd(order.total_usd)}` : ""}</span>
            </div>
            ${order.items.map(renderItem).join("") || '<div class="qr-hint">주문 상세를 불러오지 못했습니다.</div>'}
            ${String(order.note || "").trim() ? `<div class="qr-order-note"><strong>요청사항</strong><br>${global.DGV.escapeHTML(String(order.note).trim())}</div>` : ""}
          </section>`).join("")}
      </div>`;
  }

  function openPayment(tableId) {
    const tableOrders = openOrdersForTable(tableId);
    const submitted = tableOrders.filter((order) => order.status === "submitted");
    if (submitted.length) {
      ui.toast(`신규 주문 ${submitted.length.toLocaleString("ko-KR")}건을 먼저 주문 확인해 주세요. 미확인 주문이 있으면 테이블 전체 결제를 진행할 수 없습니다.`, "error", 6500);
      return;
    }
    const accepted = tableOrders.filter((order) => order.status === "accepted");
    if (!accepted.length || accepted.some((order) => !order.updated_at)) {
      ui.toast("결제할 테이블 주문의 최신 상태를 확인하지 못했습니다. 주문 목록을 새로고침해 주세요.", "error");
      return;
    }
    paymentTableId = tableId;
    paymentTableLabel = accepted[0].table_label;
    paymentOrders = accepted.map((order) => ({
      ...order,
      items: order.items.map((item) => ({ ...item }))
    }));
    ui.byId("paymentCash").checked = true;
    ui.byId("paymentGuide").value = "";
    ui.byId("paymentTeam").value = "";
    ui.byId("paymentTitle").textContent = `${paymentTableLabel} 테이블 전체 결제`;
    renderPaymentOrderSummary();
    updatePaymentPreview();
    ui.byId("paymentModal").hidden = false;
    ui.byId("paymentCash").focus();
  }

  function closePayment() {
    paymentTableId = null;
    paymentTableLabel = "";
    paymentOrders = [];
    ui.byId("paymentOrderSummary").replaceChildren();
    ui.byId("paymentModal").hidden = true;
  }

  function updatePaymentPreview() {
    const preview = ui.byId("paymentTotalPreview");
    if (!paymentOrders.length) {
      preview.textContent = "결제할 테이블 주문 금액을 확인하지 못했습니다.";
      preview.dataset.tone = "error";
      return;
    }

    const totals = sumOrderTotals(paymentOrders);
    const baseUsd = totals.usd;
    const baseVnd = totals.vnd;
    if (getPaymentMethod() === "card_fee7") {
      const adjusted = cardAdjustedTotals(baseUsd, baseVnd);
      const feeUsd = adjusted.totalUsd - baseUsd;
      const feeVnd = adjusted.totalVnd - baseVnd;
      preview.textContent = `기본 ${ui.formatVnd(baseVnd)}${baseUsd > 0 ? ` · ${ui.formatUsd(baseUsd)}` : ""} + 카드 수수료 7% (${ui.formatVnd(feeVnd)}${feeUsd > 0 ? ` · ${ui.formatUsd(feeUsd)}` : ""}) = ${ui.formatVnd(adjusted.totalVnd)}${adjusted.totalUsd > 0 ? ` · ${ui.formatUsd(adjusted.totalUsd)}` : ""}`;
    } else {
      preview.textContent = `최종 결제 금액: ${ui.formatVnd(baseVnd)}${baseUsd > 0 ? ` · ${ui.formatUsd(baseUsd)}` : ""}`;
    }
    preview.dataset.tone = "ok";
  }

  async function finalizeTableOrders({ tableId, expectedOrders, paymentMethod, guideName, teamNo }) {
    return sb.rpc("app_finalize_qr_table_orders_checked", {
      p_table_id: tableId,
      p_expected_orders: expectedOrders,
      p_payment_method: paymentMethod,
      p_guide_name: guideName,
      p_team_no: teamNo
    });
  }

  function markTableCheckoutComplete(paidOrderId, paymentMethod) {
    const finalizedIds = new Set(paymentOrders.map((order) => order.id));
    const finalizedAt = new Date().toISOString();
    const baseTotals = sumOrderTotals(paymentOrders);
    const paidTotals = paymentMethod === "card_fee7"
      ? cardAdjustedTotals(baseTotals.usd, baseTotals.vnd)
      : { totalUsd: baseTotals.usd, totalVnd: baseTotals.vnd };
    orders = orders.map((order) => finalizedIds.has(order.id) ? {
      ...order,
      finalized_at: finalizedAt,
      finalized_order_id: paidOrderId,
      finalized_payment_choice: paymentMethod,
      paid_total_usd: paidTotals.totalUsd,
      paid_total_vnd: paidTotals.totalVnd,
      paid_payment_method: paymentMethod,
      updated_at: finalizedAt
    } : order);
    renderOrders();
  }

  async function finalizePayment(event) {
    event.preventDefault();
    if (!paymentTableId || !paymentOrders.length || !["staff", "admin"].includes(identity?.role)) return;
    const latestSubmitted = openOrdersForTable(paymentTableId).filter((order) => order.status === "submitted");
    if (latestSubmitted.length) {
      ui.toast(`신규 주문 ${latestSubmitted.length.toLocaleString("ko-KR")}건을 먼저 주문 확인해 주세요. 미확인 주문이 있으면 테이블 전체 결제를 진행할 수 없습니다.`, "error", 6500);
      return;
    }
    const button = ui.byId("paymentConfirm");
    ui.setBusy(button, true, "등록 중…");
    try {
      const paymentMethod = getPaymentMethod();
      const { data, error } = await finalizeTableOrders({
        tableId: paymentTableId,
        expectedOrders: paymentOrders.map((order) => ({
          id: order.id,
          updated_at: order.updated_at
        })),
        paymentMethod,
        guideName: ui.byId("paymentGuide").value.trim() || null,
        teamNo: ui.byId("paymentTeam").value.trim() || null
      });
      if (error) throw error;
      markTableCheckoutComplete(data, paymentMethod);
      closePayment();
      ui.toast(`테이블 전체 결제가 완료되어 admin 매출에 한 건으로 등록되었습니다. (매출 주문 #${ui.shortId(data)})`, "ok", 5500);
      await loadOrders();
    } catch (error) {
      console.error(error);
      if (error?.code === "55000") {
        closePayment();
        ui.toast("새 주문이 들어왔거나 주문 정보가 다른 화면에서 변경되었습니다. 모든 신규 주문을 확인한 뒤 테이블 전체 결제를 다시 진행해 주세요.", "error", 6500);
        await loadOrders();
      } else {
        ui.toast(ui.messageOf(error, "최종 결제 및 매출 등록에 실패했습니다. 다시 확인해 주세요."), "error");
      }
    } finally {
      ui.setBusy(button, false);
    }
  }

  function subscribeRealtime() {
    global.clearTimeout(reconnectTimer);
    reconnectTimer = null;
    if (!global.navigator.onLine) {
      realtimeStatus = "offline";
      startFallbackPolling();
      updateLastSyncText();
      ui.connectionBadge("offline", "오프라인");
      return;
    }
    const previousChannel = realtimeChannel;
    realtimeChannel = null;
    if (previousChannel) sb.removeChannel(previousChannel);
    realtimeStatus = "connecting";
    startFallbackPolling();
    updateLastSyncText();
    ui.connectionBadge("connecting", "실시간 연결 중");
    let channel = sb
      .channel("qr-order-inbox")
      .on("postgres_changes", { event: "*", schema: "public", table: "qr_orders" }, (payload) => {
        if (realtimeChannel !== channel) return;
        if (payload.eventType === "INSERT" && payload.new?.status === "submitted" && !alertedOrderIds.has(payload.new.id)) {
          alertedOrderIds.add(payload.new.id);
          highlightedOrderIds.add(payload.new.id);
          ui.playAlert();
          ui.toast("새 테이블 주문이 들어왔습니다.", "ok", 6500);
        }
        const historyChanged = payload.eventType === "DELETE"
          || payload.new?.status === "cancelled"
          || Boolean(payload.new?.finalized_order_id)
          || payload.old?.status === "cancelled"
          || Boolean(payload.old?.finalized_order_id);
        scheduleRefresh(250, { includeHistory: historyChanged });
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "qr_order_items" }, () => {
        if (realtimeChannel === channel) scheduleRefresh(350, { includeHistory: false });
      });
    realtimeChannel = channel;
    channel.subscribe((status, error) => {
      if (realtimeChannel !== channel) return;
      if (status === "SUBSCRIBED") {
        realtimeStatus = "connected";
        global.clearTimeout(reconnectTimer);
        reconnectTimer = null;
        ui.connectionBadge("online", "실시간 연결됨");
        updateLastSyncText();
        scheduleRefresh(0, { includeHistory: true });
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        realtimeStatus = "reconnecting";
        startFallbackPolling();
        updateLastSyncText();
        ui.connectionBadge("connecting", "자동 재연결 중");
        if (error) console.error("QR 주문 실시간 연결 오류", error);
        queueRealtimeReconnect();
      } else if (status === "CLOSED") {
        realtimeChannel = null;
        realtimeStatus = global.navigator.onLine ? "disconnected" : "offline";
        startFallbackPolling();
        updateLastSyncText();
        ui.connectionBadge(global.navigator.onLine ? "connecting" : "offline", global.navigator.onLine ? "연결 끊김" : "오프라인");
        queueRealtimeReconnect(1000);
      }
    });
  }

  function startAttentionLoop() {
    global.clearInterval(attentionTimer);
    attentionTimer = global.setInterval(() => {
      if (document.visibilityState === "visible" && orders.some((order) => order.status === "submitted")) {
        ui.playAlert();
      }
    }, 9000);
  }

  function markSoundEnabled() {
    const button = ui.byId("soundBtn");
    button.textContent = "🔔 알림음 켜짐";
    button.classList.add("qr-btn-ok");
  }

  function armPreferredSound() {
    if (!ui.soundPreferred()) return;
    const resume = async () => {
      document.removeEventListener("pointerdown", resume, true);
      document.removeEventListener("keydown", resume, true);
      const enabled = await ui.enableSound();
      if (enabled) markSoundEnabled();
    };
    document.addEventListener("pointerdown", resume, { once: true, capture: true });
    document.addEventListener("keydown", resume, { once: true, capture: true });
    ui.byId("soundBtn").textContent = "🔔 알림음 준비됨";
  }

  function updateHistoryFilterControls() {
    global.document.querySelectorAll("[data-history-range]").forEach((button) => {
      const active = button.dataset.historyRange === historyRange;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    ui.byId("historyDate").value = historyCustomDate;
  }

  function initializeHistoryFilter() {
    const todayKey = businessDateKey();
    historyCustomDate = todayKey;
    const input = ui.byId("historyDate");
    input.value = todayKey;
    input.max = todayKey;
    updateHistoryFilterControls();
  }

  function scheduleBusinessDayRollover() {
    global.clearTimeout(historyDayTimer);
    historyDayTimer = global.setTimeout(() => {
      historyDayTimer = null;
      const todayKey = businessDateKey();
      const input = ui.byId("historyDate");
      input.max = todayKey;
      if (historyRange !== "date") {
        historyCustomDate = todayKey;
        input.value = todayKey;
      }
      if (document.visibilityState === "visible" && global.navigator.onLine) loadOrders();
      scheduleBusinessDayRollover();
    }, millisecondsUntilBusinessTomorrow());
  }

  function selectHistoryRange(range) {
    if (!HISTORY_RANGES.includes(range) || range === "date") return;
    historyRange = range;
    ui.byId("statusFilter").value = "all";
    updateHistoryFilterControls();
    loadOrders();
  }

  function searchHistoryDate(event) {
    event.preventDefault();
    const selectedDate = ui.byId("historyDate").value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(selectedDate)) {
      ui.toast("조회할 날짜를 선택해 주세요.", "error");
      return;
    }
    historyRange = "date";
    historyCustomDate = selectedDate;
    ui.byId("statusFilter").value = "all";
    updateHistoryFilterControls();
    loadOrders();
  }

  function bindEvents() {
    ui.byId("refreshBtn").addEventListener("click", () => loadOrders({ manual: true }));
    ui.byId("signOutBtn").addEventListener("click", () => ui.signOut());
    ui.byId("statusFilter").addEventListener("change", renderOrders);
    ui.byId("historyQuickFilters").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-history-range]");
      if (button) selectHistoryRange(button.dataset.historyRange);
    });
    ui.byId("historyDateForm").addEventListener("submit", searchHistoryDate);
    ui.byId("soundBtn").addEventListener("click", async (event) => {
      const enabled = await ui.enableSound();
      if (enabled) {
        markSoundEnabled();
        ui.toast("새 주문 알림음이 켜졌습니다.", "ok");
      }
    });
    ui.byId("ordersGrid").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button) return;
      if (button.dataset.action === "transition") transitionOrder(button.dataset.orderId, button.dataset.status, button);
      if (button.dataset.action === "table-payment") openPayment(button.dataset.tableId);
      if (button.dataset.action === "edit") openEditOrder(button.dataset.orderId, button);
    });
    ui.byId("editOrderCancel").addEventListener("click", closeEditOrder);
    ui.byId("editOrderForm").addEventListener("submit", saveEditedOrder);
    ui.byId("editMenuSearch").addEventListener("input", renderEditMenuChoices);
    ui.byId("editMenuAdd").addEventListener("click", addEditMenu);
    ui.byId("editOrderLines").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-edit-remove]");
      if (!button) return;
      editLines = editLines.filter((line) => line.menu_item_id !== button.dataset.editRemove);
      renderEditLines();
    });
    ui.byId("editOrderLines").addEventListener("change", (event) => {
      const input = event.target.closest("input[data-edit-qty]");
      if (!input) return;
      const line = editLines.find((row) => row.menu_item_id === input.dataset.editQty);
      const qty = Number(input.value);
      if (!line || !Number.isInteger(qty) || qty < 1 || qty > 20) {
        ui.toast("수량은 1~20 사이의 정수로 입력해 주세요.", "error");
        if (line) input.value = String(line.qty);
        renderEditTotal();
        return;
      }
      line.qty = qty;
      renderEditLines();
    });
    ui.byId("paymentCancel").addEventListener("click", closePayment);
    ui.byId("paymentForm").addEventListener("submit", finalizePayment);
    global.document.querySelectorAll('input[name="paymentMethod"]').forEach((input) => {
      input.addEventListener("change", updatePaymentPreview);
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        loadOrders();
        if (!realtimeChannel || realtimeStatus !== "connected") subscribeRealtime();
      } else {
        global.clearTimeout(refreshTimer);
        refreshTimer = null;
        scheduledRefreshIncludesHistory = false;
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !ui.byId("editOrderModal").hidden) closeEditOrder();
    });
    global.addEventListener("online", () => {
      realtimeStatus = "connecting";
      startFallbackPolling();
      ui.connectionBadge("connecting", "재연결 중");
      subscribeRealtime();
      loadOrders();
    });
    global.addEventListener("offline", () => {
      const offlineChannel = realtimeChannel;
      realtimeChannel = null;
      if (offlineChannel) sb.removeChannel(offlineChannel);
      realtimeStatus = "offline";
      global.clearTimeout(reconnectTimer);
      reconnectTimer = null;
      global.clearTimeout(refreshTimer);
      refreshTimer = null;
      scheduledRefreshIncludesHistory = false;
      startFallbackPolling();
      updateLastSyncText();
      ui.connectionBadge("offline", "오프라인");
    });
    global.addEventListener("beforeunload", () => {
      const closingChannel = realtimeChannel;
      realtimeChannel = null;
      if (closingChannel) sb.removeChannel(closingChannel);
      stopFallbackPolling();
      global.clearInterval(attentionTimer);
      global.clearTimeout(refreshTimer);
      scheduledRefreshIncludesHistory = false;
      global.clearTimeout(reconnectTimer);
      global.clearTimeout(historyDayTimer);
    });
  }

  async function boot() {
    try {
      identity = await ui.requireLogin({ roles: ["staff", "admin"], preferredRole: "staff" });
      if (identity.role === "admin") ui.byId("menuAdminLink").hidden = false;
      initializeHistoryFilter();
      scheduleBusinessDayRollover();
      bindEvents();
      armPreferredSound();
      subscribeRealtime();
      startAttentionLoop();
      await loadOrders();
    } catch (error) {
      console.error(error);
      showBanner("직원 인증을 완료하지 못했습니다.");
    }
  }

  boot();
})(window);
