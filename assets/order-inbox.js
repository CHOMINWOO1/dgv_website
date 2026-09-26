(function initOrderInbox(global) {
  "use strict";

  const sb = global.DGV.supabase;
  const ui = global.QRStaff;
  const CURRENT_STATUSES = Object.freeze(["submitted", "accepted"]);
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
  let realtimeChannel = null;
  let paymentOrderId = null;
  const knownOrderIds = new Set();
  const alertedOrderIds = new Set();
  const highlightedOrderIds = new Set();

  function relationOne(value) {
    return Array.isArray(value) ? value[0] || null : value || null;
  }

  function relationMany(value) {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
  }

  function statusMeta(status) {
    return STATUS_META[status] || { label: status || "알 수 없음", tone: "done" };
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

  async function fetchWithRelations(statuses, limit, finalized = null) {
    let query = sb
      .from("qr_orders")
      .select("id,table_id,client_request_id,status,note,total_usd,total_vnd,submitted_at,updated_at,accepted_at,cancelled_at,finalized_at,finalized_order_id,qr_tables(label),qr_order_items(id,qr_order_id,menu_item_id,qty,menu_type,ko_name,vi_name,en_name,unit_usd,unit_vnd,line_usd,line_vnd,created_at)")
      .in("status", statuses)
      .order("submitted_at", { ascending: false });
    if (finalized === true) query = query.not("finalized_order_id", "is", null);
    if (finalized === false) query = query.is("finalized_order_id", null);
    if (limit) query = query.limit(limit);
    const { data, error } = await query;
    if (error) throw error;
    return (data || []).map(normalizeOrder);
  }

  async function fetchWithoutRelations(statuses, limit, finalized = null) {
    let orderQuery = sb
      .from("qr_orders")
      .select("id,table_id,client_request_id,status,note,total_usd,total_vnd,submitted_at,updated_at,accepted_at,cancelled_at,finalized_at,finalized_order_id")
      .in("status", statuses)
      .order("submitted_at", { ascending: false });
    if (finalized === true) orderQuery = orderQuery.not("finalized_order_id", "is", null);
    if (finalized === false) orderQuery = orderQuery.is("finalized_order_id", null);
    if (limit) orderQuery = orderQuery.limit(limit);
    const { data: orderRows, error: orderError } = await orderQuery;
    if (orderError) throw orderError;

    const ids = (orderRows || []).map((row) => row.id);
    const tableIds = [...new Set((orderRows || []).map((row) => row.table_id).filter(Boolean))];
    const [tableResult, ...itemResults] = await Promise.all([
      tableIds.length
        ? sb.from("qr_tables").select("id,label").in("id", tableIds)
        : Promise.resolve({ data: [], error: null }),
      ...Array.from({ length: Math.ceil(ids.length / 40) }, (_, index) => {
        const chunk = ids.slice(index * 40, (index + 1) * 40);
        return sb
          .from("qr_order_items")
          .select("id,qr_order_id,menu_item_id,qty,menu_type,ko_name,vi_name,en_name,unit_usd,unit_vnd,line_usd,line_vnd,created_at")
          .in("qr_order_id", chunk)
          .order("created_at", { ascending: true });
      })
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
    return (orderRows || []).map((row) => normalizeOrder({
      ...row,
      qr_tables: tables.get(row.table_id) || null,
      qr_order_items: itemsByOrder.get(row.id) || []
    }));
  }

  async function fetchOrders() {
    const uniqueOrders = (groups) => [...new Map(groups.flat().map((order) => [order.id, order])).values()];
    try {
      const groups = await Promise.all([
        fetchWithRelations(["submitted"]),
        fetchWithRelations(["accepted"], null, false),
        fetchWithRelations(["accepted"], 80, true),
        fetchWithRelations(["cancelled"], 80)
      ]);
      return uniqueOrders(groups);
    } catch (embeddedError) {
      console.warn("Embedded QR order query failed; using relationship-cache fallback.", embeddedError);
      const groups = await Promise.all([
        fetchWithoutRelations(["submitted"]),
        fetchWithoutRelations(["accepted"], null, false),
        fetchWithoutRelations(["accepted"], 80, true),
        fetchWithoutRelations(["cancelled"], 80)
      ]);
      return uniqueOrders(groups);
    }
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
    if (filter === "all") return orders;
    return orders.filter((order) => order.status === filter);
  }

  function renderSummary() {
    const count = (status) => orders.filter((order) => order.status === status).length;
    ui.byId("submittedCount").textContent = count("submitted").toLocaleString("ko-KR");
    ui.byId("acceptedCount").textContent = orders.filter((order) => order.status === "accepted" && !order.finalized_order_id).length.toLocaleString("ko-KR");
    ui.byId("finalizedCount").textContent = orders.filter((order) => order.finalized_order_id).length.toLocaleString("ko-KR");
    ui.byId("visibleCount").textContent = filteredOrders().length.toLocaleString("ko-KR");
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
    if (identity?.role === "admin" && CURRENT_STATUSES.includes(order.status) && !order.finalized_order_id) {
      buttons.push(`<button class="qr-btn qr-btn-danger" type="button" data-action="transition" data-order-id="${order.id}" data-status="cancelled">주문 취소</button>`);
    }
    if (order.status === "accepted" && !order.finalized_order_id && identity?.role === "admin") {
      buttons.push(`<button class="qr-btn qr-btn-dark" type="button" data-action="payment" data-order-id="${order.id}">최종 결제</button>`);
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
      const note = String(order.note || "").trim();
      const items = order.items.length
        ? order.items.map(renderItem).join("")
        : '<div class="qr-hint">주문 상세를 불러오지 못했습니다.</div>';
      return `
        <article class="qr-card qr-order-card${isNew}" data-status="${global.DGV.escapeHTML(order.status)}">
          <div class="qr-order-head">
            <div>
              <div class="qr-table-no">${global.DGV.escapeHTML(order.table_label)}</div>
              <div class="qr-order-time">${ui.formatTime(order.submitted_at)} · #${ui.shortId(order.id)}</div>
            </div>
            <span class="qr-status" data-tone="${status.tone}">${status.label}</span>
          </div>
          <div class="qr-order-body">
            ${items}
            ${note ? `<div class="qr-order-note"><strong>요청사항</strong><br>${global.DGV.escapeHTML(note)}</div>` : ""}
            <div class="qr-order-total"><span>합계</span><span>${ui.formatVnd(order.total_vnd)}${Number(order.total_usd || 0) > 0 ? ` · ${ui.formatUsd(order.total_usd)}` : ""}</span></div>
          </div>
          ${actionButtons(order)}
        </article>`;
  }

  function renderOrders() {
    const grid = ui.byId("ordersGrid");
    const rows = filteredOrders();
    renderSummary();
    if (!rows.length) {
      grid.innerHTML = '<div class="qr-empty">선택한 상태의 주문이 없습니다.</div>';
      return;
    }
    const groups = new Map();
    rows.forEach((order) => {
      const key = order.table_id || order.table_label;
      if (!groups.has(key)) groups.set(key, { label: order.table_label, orders: [] });
      groups.get(key).orders.push(order);
    });
    grid.innerHTML = [...groups.values()].map((group) => `
      <section class="qr-table-order-group">
        <div class="qr-table-order-group-title">
          <h3>${global.DGV.escapeHTML(group.label)}</h3>
          <span class="qr-pill">주문 ${group.orders.length.toLocaleString("ko-KR")}건</span>
        </div>
        <div class="qr-table-order-cards">
          ${group.orders.map(renderOrderCard).join("")}
        </div>
      </section>`).join("");
  }

  async function loadOrders(options = {}) {
    if (isLoading) return;
    isLoading = true;
    if (options.manual) ui.setBusy(ui.byId("refreshBtn"), true, "불러오는 중…");
    try {
      const nextOrders = await fetchOrders();
      nextOrders.sort((a, b) => new Date(b.submitted_at) - new Date(a.submitted_at));
      announceNewOrders(nextOrders);
      orders = nextOrders;
      renderOrders();
      hideBanner();
      ui.byId("lastSyncText").textContent = `${new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })} 동기화 · 15초마다 자동 확인`;
    } catch (error) {
      console.error(error);
      showBanner("QR 주문 데이터를 불러오지 못했습니다. DB 배포 상태와 네트워크를 확인해 주세요.");
      ui.connectionBadge(global.navigator.onLine ? "connecting" : "offline", global.navigator.onLine ? "재연결 중" : "오프라인");
    } finally {
      isLoading = false;
      if (options.manual) ui.setBusy(ui.byId("refreshBtn"), false);
    }
  }

  function scheduleRefresh(delay = 250) {
    global.clearTimeout(refreshTimer);
    refreshTimer = global.setTimeout(() => loadOrders(), delay);
  }

  async function transitionOrder(orderId, nextStatus, button) {
    const meta = statusMeta(nextStatus);
    if (nextStatus === "cancelled" && !global.confirm("이 주문을 취소하시겠습니까?\n취소 후에는 직원 화면에서 되돌릴 수 없습니다.")) return;
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

  function openPayment(orderId) {
    paymentOrderId = orderId;
    ui.byId("paymentMethod").value = "cash";
    ui.byId("paymentGuide").value = "";
    ui.byId("paymentTeam").value = "";
    ui.byId("paymentModal").hidden = false;
    ui.byId("paymentMethod").focus();
  }

  function closePayment() {
    paymentOrderId = null;
    ui.byId("paymentModal").hidden = true;
  }

  async function finalizePayment(event) {
    event.preventDefault();
    if (!paymentOrderId || identity?.role !== "admin") return;
    const button = ui.byId("paymentConfirm");
    ui.setBusy(button, true, "등록 중…");
    try {
      const { data, error } = await sb.rpc("app_finalize_qr_order", {
        p_qr_order_id: paymentOrderId,
        p_payment_method: ui.byId("paymentMethod").value,
        p_guide_name: ui.byId("paymentGuide").value.trim() || null,
        p_team_no: ui.byId("paymentTeam").value.trim() || null
      });
      if (error) throw error;
      closePayment();
      ui.toast(`최종 결제가 완료되어 admin 매출에 등록되었습니다. (매출 주문 #${ui.shortId(data)})`, "ok", 5500);
      await loadOrders();
    } catch (error) {
      console.error(error);
      ui.toast(ui.messageOf(error, "최종 결제 및 매출 등록에 실패했습니다. 다시 확인해 주세요."), "error");
    } finally {
      ui.setBusy(button, false);
    }
  }

  function subscribeRealtime() {
    if (realtimeChannel) sb.removeChannel(realtimeChannel);
    ui.connectionBadge(global.navigator.onLine ? "connecting" : "offline", global.navigator.onLine ? "실시간 연결 중" : "오프라인");
    realtimeChannel = sb
      .channel("qr-order-inbox")
      .on("postgres_changes", { event: "*", schema: "public", table: "qr_orders" }, (payload) => {
        if (payload.eventType === "INSERT" && payload.new?.status === "submitted" && !alertedOrderIds.has(payload.new.id)) {
          alertedOrderIds.add(payload.new.id);
          highlightedOrderIds.add(payload.new.id);
          ui.playAlert();
          ui.toast("새 테이블 주문이 들어왔습니다.", "ok", 6500);
        }
        scheduleRefresh();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "qr_order_items" }, () => scheduleRefresh(350))
      .subscribe((status) => {
        if (status === "SUBSCRIBED") ui.connectionBadge("online", "실시간 연결됨");
        else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") ui.connectionBadge("connecting", "자동 재연결 중");
        else if (status === "CLOSED") ui.connectionBadge(global.navigator.onLine ? "connecting" : "offline", global.navigator.onLine ? "연결 끊김" : "오프라인");
      });
  }

  function startPolling() {
    global.clearInterval(pollTimer);
    pollTimer = global.setInterval(() => {
      if (document.visibilityState === "visible" && global.navigator.onLine) loadOrders();
    }, 15000);
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

  function bindEvents() {
    ui.byId("refreshBtn").addEventListener("click", () => loadOrders({ manual: true }));
    ui.byId("signOutBtn").addEventListener("click", () => ui.signOut());
    ui.byId("statusFilter").addEventListener("change", renderOrders);
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
      if (button.dataset.action === "payment") openPayment(button.dataset.orderId);
    });
    ui.byId("paymentCancel").addEventListener("click", closePayment);
    ui.byId("paymentForm").addEventListener("submit", finalizePayment);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        loadOrders();
        if (!realtimeChannel) subscribeRealtime();
      }
    });
    global.addEventListener("online", () => {
      ui.connectionBadge("connecting", "재연결 중");
      subscribeRealtime();
      loadOrders();
    });
    global.addEventListener("offline", () => ui.connectionBadge("offline", "오프라인"));
    global.addEventListener("beforeunload", () => {
      if (realtimeChannel) sb.removeChannel(realtimeChannel);
      global.clearInterval(pollTimer);
      global.clearInterval(attentionTimer);
    });
  }

  async function boot() {
    try {
      identity = await ui.requireLogin({ roles: ["staff", "admin"], preferredRole: "staff" });
      if (identity.role === "admin") ui.byId("menuAdminLink").hidden = false;
      bindEvents();
      armPreferredSound();
      subscribeRealtime();
      startPolling();
      startAttentionLoop();
      await loadOrders();
    } catch (error) {
      console.error(error);
      showBanner("직원 인증을 완료하지 못했습니다.");
    }
  }

  boot();
})(window);
