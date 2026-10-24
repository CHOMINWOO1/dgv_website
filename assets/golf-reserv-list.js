(function initGolfReservationList(global) {
  "use strict";

  if (!global.DGV || !global.QRStaff) throw new Error("Golf reservation list dependencies are missing.");

  const DGV = global.DGV;
  const QRStaff = global.QRStaff;
  const sb = DGV.supabase;
  const COLUMNS = [
    "id", "counterparty_name", "representative_name", "player_names_en", "pax",
    "booking_date", "golf_date", "golf_time",
    "golf_course", "holes", "guest_unit_price_vnd", "smart_cart_note",
    "guest_total_vnd", "course_unit_price_vnd", "course_total_vnd",
    "deposit_amount_vnd", "deposit_received_date",
    "final_received_amount_vnd", "final_received_date",
    "withdrawal_amount_vnd", "withdrawal_date", "customer_type", "note",
    "status", "created_at", "updated_at"
  ].join(",");
  const state = { identity: null, rows: [] };
  const byId = (id) => document.getElementById(id);
  const escape = (value) => DGV.escapeHTML(value ?? "");
  const clean = (value) => String(value ?? "").trim();

  function dateLabel(value) {
    const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
    return match ? `${match[1]}.${match[2]}.${match[3]}` : "—";
  }

  function golfDateLabel(value) {
    const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!match) return "—";
    const weekday = ["일/CN", "월/T2", "화/T3", "수/T4", "목/T5", "금/T6", "토/T7"][
      new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay()
    ];
    return match[1] + "." + match[2] + "." + match[3] + " (" + weekday + ")";
  }

  function dateTimeLabel(value) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat("ko-KR", {
      timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false
    }).format(date);
  }

  function timeLabel(value) {
    const match = String(value || "").match(/^(\d{2}):(\d{2})/);
    return match ? `${match[1]}:${match[2]}` : "—";
  }

  function moneyLabel(value) {
    if (value == null || value === "") return "—";
    const number = Number(value);
    return Number.isFinite(number) ? `${Math.round(number).toLocaleString("ko-KR")} VND` : "—";
  }

  function oneLine(value) {
    return clean(value).split(/[\n,;]+/).map((part) => part.trim()).filter(Boolean).join(" / ") || "—";
  }

  function setBanner(message, tone = "info") {
    const banner = byId("pageBanner");
    banner.textContent = message;
    banner.dataset.tone = tone;
  }

  function actualProfit(row) {
    if (row.final_received_amount_vnd == null) return null;
    return Number(row.final_received_amount_vnd || 0) - Number(row.withdrawal_amount_vnd || 0);
  }

  function filteredRows() {
    const query = clean(byId("searchInput").value).toLocaleLowerCase();
    const status = byId("statusFilter").value;
    const from = byId("filterFrom").value;
    const to = byId("filterTo").value;
    return state.rows.filter((row) => {
      if (status !== "all" && row.status !== status) return false;
      if (from && row.golf_date < from) return false;
      if (to && row.golf_date > to) return false;
      if (!query) return true;
      return [
        row.counterparty_name, row.representative_name, row.player_names_en,
        row.golf_course, row.smart_cart_note, row.note
      ].some((value) => String(value || "").toLocaleLowerCase().includes(query));
    });
  }

  function renderSummary(rows) {
    const progress = rows.filter((row) => row.status === "in_progress").length;
    const completed = rows.filter((row) => row.status === "completed").length;
    const deposits = rows.reduce((total, row) => total + Number(row.deposit_amount_vnd || 0), 0);
    const profit = rows.reduce((total, row) => total + Number(actualProfit(row) || 0), 0);
    byId("summaryProgress").textContent = progress.toLocaleString("ko-KR");
    byId("summaryCompleted").textContent = completed.toLocaleString("ko-KR");
    byId("summaryDeposit").textContent = moneyLabel(deposits);
    byId("summaryProfit").textContent = moneyLabel(profit);
  }

  function renderRow(row) {
    const completed = row.status === "completed";
    const customerType = row.customer_type === "company" ? "회사 / Công ty" : "개인 / Cá nhân";
    const statusLabel = completed ? "완료 / Hoàn tất" : "진행중 / Đang xử lý";
    const names = oneLine(row.player_names_en);
    const note = oneLine(row.note);
    const cart = oneLine(row.smart_cart_note);
    return `<tr data-status="${escape(row.status)}">
      <td><span class="golf-status-chip${completed ? " is-completed" : ""}">${escape(statusLabel)}</span></td>
      <td>${escape(golfDateLabel(row.golf_date))}</td>
      <td>${escape(timeLabel(row.golf_time))}</td>
      <td class="golf-cell-text" title="${escape(row.representative_name)}">${escape(row.representative_name)}</td>
      <td class="golf-cell-text" title="${escape(row.counterparty_name || "—")}">${escape(row.counterparty_name || "—")}</td>
      <td class="golf-cell-names" title="${escape(names)}">${escape(names)}</td>
      <td>${escape(row.pax)}</td>
      <td>${escape(row.golf_course)}</td>
      <td>${escape(row.holes)}</td>
      <td class="golf-cell-text" title="${escape(cart)}">${escape(cart)}</td>
      <td class="golf-cell-money">${escape(moneyLabel(row.guest_unit_price_vnd))}</td>
      <td class="golf-cell-money">${escape(moneyLabel(row.guest_total_vnd))}</td>
      <td class="golf-cell-money">${escape(moneyLabel(row.course_unit_price_vnd))}</td>
      <td class="golf-cell-money">${escape(moneyLabel(row.course_total_vnd))}</td>
      <td class="golf-cell-money">${escape(moneyLabel(row.deposit_amount_vnd))}</td>
      <td>${escape(dateLabel(row.deposit_received_date))}</td>
      <td class="golf-cell-money">${escape(moneyLabel(row.final_received_amount_vnd))}</td>
      <td>${escape(dateLabel(row.final_received_date))}</td>
      <td class="golf-cell-money">${escape(moneyLabel(row.withdrawal_amount_vnd))}</td>
      <td>${escape(dateLabel(row.withdrawal_date))}</td>
      <td class="golf-cell-money">${escape(moneyLabel(actualProfit(row)))}</td>
      <td>${escape(customerType)}</td>
      <td>${escape(dateTimeLabel(row.created_at))}</td>
      <td class="golf-cell-text" title="${escape(note)}">${escape(note)}</td>
      <td>${escape(dateTimeLabel(row.updated_at))}</td>
    </tr>`;
  }

  function render() {
    const rows = filteredRows();
    renderSummary(rows);
    byId("listCount").textContent = `${rows.length.toLocaleString("ko-KR")}건 / mục`;
    byId("reservationTableBody").innerHTML = rows.length
      ? rows.map(renderRow).join("")
      : '<tr><td class="golf-cell-empty" colspan="25">조건에 맞는 골프 예약이 없습니다. / Không có đặt sân phù hợp.</td></tr>';
  }

  async function loadRows(options = {}) {
    QRStaff.connectionBadge("connecting", "불러오는 중");
    try {
      state.rows = await DGV.collectSupabasePages(
        () => sb.from("golf_reservations").select(COLUMNS),
        { pageSize: 500, order: [
          { column: "golf_date", ascending: true },
          { column: "golf_time", ascending: true },
          { column: "id", ascending: true }
        ] }
      );
      render();
      QRStaff.connectionBadge("online", "연결됨");
      if (!options.quiet) setBanner("골프 예약 목록을 불러왔습니다. / Đã tải danh sách đặt sân.", "ok");
    } catch (error) {
      console.error(error);
      QRStaff.connectionBadge("offline", "연결 오류");
      setBanner(QRStaff.messageOf(error, "골프 예약 목록을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요."), "error");
    }
  }

  function bindEvents() {
    byId("reloadButton").addEventListener("click", () => loadRows());
    byId("clearFiltersButton").addEventListener("click", () => {
      byId("searchInput").value = "";
      byId("statusFilter").value = "all";
      byId("filterFrom").value = "";
      byId("filterTo").value = "";
      render();
    });
    byId("searchInput").addEventListener("input", render);
    for (const id of ["statusFilter", "filterFrom", "filterTo"]) byId(id).addEventListener("change", render);

    const sheet = document.querySelector(".golf-sheet-wrap");
    let drag = null;
    sheet.addEventListener("pointerdown", (event) => {
      if (event.pointerType === "touch" || event.button !== 0) return;
      if (event.target.closest("a, button, input, select, textarea")) return;
      drag = { pointerId: event.pointerId, x: event.clientX, scrollLeft: sheet.scrollLeft };
      sheet.setPointerCapture(event.pointerId);
      sheet.classList.add("is-dragging");
    });
    sheet.addEventListener("pointermove", (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      sheet.scrollLeft = drag.scrollLeft - (event.clientX - drag.x);
      event.preventDefault();
    });
    const stopDrag = (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      drag = null;
      sheet.classList.remove("is-dragging");
    };
    sheet.addEventListener("pointerup", stopDrag);
    sheet.addEventListener("pointercancel", stopDrag);
  }

  async function init() {
    bindEvents();
    try {
      state.identity = await QRStaff.requireLogin({ roles: ["manager", "admin"], preferredRole: "manager" });
      byId("homeLink").href = state.identity.role === "admin" ? "home_admin.html" : "home_manager.html";
      document.body.classList.remove("locked");
      await loadRows({ quiet: true });
    } catch (error) {
      console.error(error);
      QRStaff.connectionBadge("offline", "로그인 오류");
      setBanner("로그인 화면을 불러오지 못했습니다. 페이지를 새로고침해 주세요.", "error");
    }
  }

  init();
})(window);
