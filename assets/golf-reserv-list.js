(function initGolfReservationList(global) {
  "use strict";

  if (!global.DGV || !global.QRStaff) throw new Error("Golf reservation list dependencies are missing.");

  const DGV = global.DGV;
  const QRStaff = global.QRStaff;
  const sb = DGV.supabase;
  const PAYMENT_COLUMNS = "id,reservation_id,payment_kind,amount_vnd,payment_date,payment_method,completes_booking,sort_order,legacy_import";
  const COLUMNS = [
    "id", "counterparty_name", "representative_name", "player_names_en", "pax",
    "booking_date", "golf_date", "golf_time",
    "golf_course", "holes", "guest_unit_price_vnd", "smart_cart_note",
    "guest_total_vnd", "course_unit_price_vnd", "course_total_vnd",
    "cost_settlement_type", "cost_partner_name",
    "deposit_amount_vnd", "deposit_received_date",
    "final_received_amount_vnd", "final_received_date", "customer_type", "note",
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

  function paymentMethodLabel(value) {
    return value === "bank" ? "은행 / Chuyển khoản"
      : value === "cash" ? "현금 / Tiền mặt"
      : value === "card" ? "카드 / Thẻ"
      : "";
  }

  function paymentKindLabel(value) {
    return value === "deposit" ? "계약금 / Tiền cọc"
      : value === "receipt" ? "추가 입금 / Khoản thu thêm"
      : "";
  }

  function costSettlementTypeLabel(row) {
    return row?.cost_settlement_type === "partner"
      ? "거래처 보유분 / Suất của đối tác"
      : "골프장 직접 / Sân golf trực tiếp";
  }

  function costSettlementPartnerLabel(row) {
    return row?.cost_settlement_type === "partner" ? clean(row.cost_partner_name) || "—" : "—";
  }

  function paymentRowsFor(row) {
    return Array.isArray(row?.payments) ? row.payments : [];
  }

  function paymentsOfKinds(row, kinds) {
    const allowed = new Set(Array.isArray(kinds) ? kinds : [kinds]);
    return paymentRowsFor(row).filter((payment) => allowed.has(payment.payment_kind));
  }

  function paymentTotal(row, kinds) {
    const payments = paymentsOfKinds(row, kinds);
    if (!payments.length) return null;
    return payments.reduce((total, payment) => total + Number(payment.amount_vnd || 0), 0);
  }

  function paymentDetailText(row, kinds) {
    const payments = paymentsOfKinds(row, kinds);
    if (!payments.length) return "—";
    return payments.map((payment) => {
      const method = paymentMethodLabel(payment.payment_method);
      return `${dateLabel(payment.payment_date)} · ${method ? `${method} · ` : ""}${moneyLabel(payment.amount_vnd)}`;
    }).join("\n");
  }

  function paymentMethodSummary(row, kinds) {
    const methods = [...new Set(paymentsOfKinds(row, kinds)
      .map((payment) => paymentMethodLabel(payment.payment_method))
      .filter(Boolean))];
    return methods.length ? methods.join(" + ") : "—";
  }

  function paymentDetailMarkup(row) {
    const groups = [
      ["deposit", "계약금 / Tiền cọc"],
      ["receipt", "추가 입금 / Khoản thu thêm"]
    ];
    return groups.map(([kind, label]) => {
      const payments = paymentsOfKinds(row, kind);
      const items = payments.length
        ? payments.map((payment) => {
          const method = paymentMethodLabel(payment.payment_method);
          const text = `${dateLabel(payment.payment_date)} · ${method ? `${method} · ` : ""}${moneyLabel(payment.amount_vnd)}`;
          return `<span class="golf-payment-detail-item">${escape(text)}</span>`;
        }).join("")
        : '<span class="golf-payment-detail-item">—</span>';
      return `<div class="golf-payment-detail-group"><strong>${escape(label)}</strong><div class="golf-payment-detail-list">${items}</div></div>`;
    }).join("");
  }

  function setBanner(message, tone = "info") {
    const banner = byId("pageBanner");
    banner.textContent = message;
    banner.dataset.tone = tone;
  }

  function actualProfit(row) {
    if (row.status !== "completed" || row.course_total_vnd == null) return null;
    const received = paymentTotal(row, ["deposit", "receipt"]);
    if (received == null) return Number(row.final_received_amount_vnd || 0) - Number(row.course_total_vnd);
    return received - Number(row.course_total_vnd);
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
        row.golf_course, row.smart_cart_note, row.cost_settlement_type,
        row.cost_partner_name, costSettlementTypeLabel(row), row.note
      ].some((value) => String(value || "").toLocaleLowerCase().includes(query));
    });
  }

  function filterDescription() {
    const status = byId("statusFilter").value;
    const statusLabel = status === "completed"
      ? "완료 / Hoàn tất"
      : status === "in_progress"
        ? "진행중 / Đang xử lý"
        : "전체 / Tất cả";
    const from = byId("filterFrom").value || "전체 / Tất cả";
    const to = byId("filterTo").value || "전체 / Tất cả";
    const parts = [`상태 / Trạng thái: ${statusLabel}`, `골프 날짜 / Ngày chơi: ${from} ~ ${to}`];
    const query = clean(byId("searchInput").value);
    if (query) parts.push(`검색 / Tìm kiếm: ${query}`);
    return parts.join(" · ");
  }

  function printList() {
    const rows = filteredRows();
    if (!rows.length) {
      QRStaff.toast("출력할 골프 예약이 없습니다. / Không có đặt sân để in.", "error");
      return;
    }
    byId("golfPrintCriteria").textContent = filterDescription();
    byId("golfPrintGeneratedAt").textContent = `출력 일시 / Thời gian in: ${new Date().toLocaleString("ko-KR", { timeZone: "Asia/Ho_Chi_Minh" })}`;
    global.print();
  }

  function workbookOptions(rows) {
    const textCell = (value, style = "normal") => ({ value: String(value ?? ""), style });
    const integerCell = (value) => {
      if (value == null || value === "") return "";
      const number = Number(value);
      if (!Number.isFinite(number)) throw new Error("Invalid golf reservation number");
      return { value: number, style: "integer" };
    };
    const headers = [
      "상태 / Trạng thái", "골프 날짜 / Ngày chơi", "티오프 / Giờ", "거래처 / Đối tác",
      "예약자 대표 / Người đại diện", "전체 이름(영어) / Họ tên tiếng Anh", "인원 / Số khách",
      "골프장 / Sân golf", "홀 / Số hố", "S-CART", "1인 판매가(VND) / Giá khách",
      "고객 합계(VND) / Tổng tiền khách", "1인 원가(VND) / Giá sân",
      "골프장 합계(VND) / Tổng tiền sân", "원가 정산 방식 / Phương thức quyết toán",
      "정산 거래처 / Đối tác quyết toán", "계약금 합계(VND) / Tổng tiền cọc", "계약금 상세 / Chi tiết tiền cọc",
      "고객 총입금(VND) / Tổng tiền khách đã trả", "입금 상세 / Chi tiết khoản thu",
      "실제 수익(VND) / Lợi nhuận", "구분 / Loại khách",
      "등록 일시 / Thời gian tạo", "비고 / Ghi chú", "최종 수정 / Cập nhật"
    ];
    const dataRows = rows.map((row) => {
      const depositTotal = paymentTotal(row, "deposit");
      const receivedTotal = paymentTotal(row, ["deposit", "receipt"]);
      return [
        textCell(row.status === "completed" ? "완료 / Hoàn tất" : "진행중 / Đang xử lý"),
        textCell(row.golf_date), textCell(timeLabel(row.golf_time)), textCell(row.counterparty_name),
        textCell(row.representative_name), textCell(row.player_names_en, "wrapped"), integerCell(row.pax),
        textCell(row.golf_course), integerCell(row.holes), textCell(row.smart_cart_note, "wrapped"),
        integerCell(row.guest_unit_price_vnd), integerCell(row.guest_total_vnd),
        integerCell(row.course_unit_price_vnd), integerCell(row.course_total_vnd),
        textCell(costSettlementTypeLabel(row)), textCell(costSettlementPartnerLabel(row)),
        integerCell(depositTotal), textCell(depositTotal == null ? "" : paymentDetailText(row, "deposit"), "wrapped"),
        integerCell(receivedTotal), textCell(receivedTotal == null ? "" : paymentDetailText(row, ["deposit", "receipt"]), "wrapped"),
        integerCell(actualProfit(row)),
        textCell(row.customer_type === "company" ? "회사 / Công ty" : "개인 / Cá nhân"),
        textCell(dateTimeLabel(row.created_at)), textCell(row.note, "wrapped"), textCell(dateTimeLabel(row.updated_at))
      ];
    });
    const transactionHeaders = [
      "예약 ID / ID đặt sân", "골프 날짜 / Ngày chơi", "거래처 / Đối tác", "예약자 대표 / Người đại diện",
      "거래 종류 / Loại giao dịch", "거래 날짜 / Ngày giao dịch", "금액(VND) / Số tiền",
      "수단 / Phương thức", "상태 / Trạng thái", "기존 이관 / Dữ liệu cũ"
    ];
    const transactionRows = rows.flatMap((row) => paymentsOfKinds(row, ["deposit", "receipt"]).map((payment) => [
      textCell(row.id), textCell(row.golf_date), textCell(row.counterparty_name), textCell(row.representative_name),
      textCell(paymentKindLabel(payment.payment_kind)), textCell(payment.payment_date), integerCell(payment.amount_vnd),
      textCell(paymentMethodLabel(payment.payment_method)),
      textCell(row.status === "completed" ? "완료 / Hoàn tất" : "진행중 / Đang xử lý"),
      textCell(payment.legacy_import ? "기존 / Dữ liệu cũ" : "")
    ]));
    const from = byId("filterFrom").value || "ALL";
    const to = byId("filterTo").value || "ALL";
    const generatedAt = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Ho_Chi_Minh" });
    return {
      filename: `HANA_Golf_Reservations_${from}_${to}.xlsx`,
      sheets: [{
        name: "골프 예약",
        rows: [
          [textCell("HANA 골프 예약 목록 / Danh sách đặt sân golf", "title"), ...Array(24).fill("")],
          [textCell("조회 기준 / Điều kiện lọc"), textCell(filterDescription()), ...Array(23).fill("")],
          [textCell("생성 일시 / Thời gian xuất"), textCell(generatedAt), ...Array(23).fill("")],
          [],
          headers.map((label) => textCell(label, "header")),
          ...dataRows
        ],
        columnWidths: [17,16,10,20,22,34,9,13,8,18,18,20,18,20,25,20,18,34,20,38,20,16,20,30,20],
        merges: ["A1:Y1"],
        freezeRows: 5,
        autoFilterRange: `A5:Y${Math.max(5, 5 + dataRows.length)}`
      }, {
        name: "입금 내역",
        rows: [
          [textCell("골프 예약 고객 입금 내역 / Khoản thu đặt sân golf", "title"), ...Array(9).fill("")],
          [textCell("조회 기준 / Điều kiện lọc"), textCell(filterDescription()), ...Array(8).fill("")],
          [textCell("생성 일시 / Thời gian xuất"), textCell(generatedAt), ...Array(8).fill("")],
          [],
          transactionHeaders.map((label) => textCell(label, "header")),
          ...transactionRows
        ],
        columnWidths: [38,16,22,24,22,17,20,24,18,18],
        merges: ["A1:J1"],
        freezeRows: 5,
        autoFilterRange: `A5:J${Math.max(5, 5 + transactionRows.length)}`
      }]
    };
  }

  function exportList() {
    const button = byId("exportListButton");
    if (button.disabled) return;
    const originalLabel = button.textContent;
    button.disabled = true;
    button.textContent = "생성 중…";
    try {
      const rows = filteredRows();
      if (!rows.length) {
        QRStaff.toast("엑셀로 생성할 골프 예약이 없습니다. / Không có đặt sân để xuất Excel.", "error");
        return;
      }
      if (!global.DGV_XLSX?.downloadWorkbook) throw new Error("XLSX exporter is unavailable");
      global.DGV_XLSX.downloadWorkbook(workbookOptions(rows));
    } catch (error) {
      console.error(error);
      QRStaff.toast("엑셀 파일을 생성하지 못했습니다. 잠시 후 다시 시도해 주세요.", "error");
    } finally {
      button.disabled = false;
      button.textContent = originalLabel;
    }
  }

  function renderSummary(rows) {
    const progress = rows.filter((row) => row.status === "in_progress").length;
    const completed = rows.filter((row) => row.status === "completed").length;
    const deposits = rows.reduce((total, row) => total + Number(paymentTotal(row, "deposit") || 0), 0);
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
    const rosterNames = String(row.player_names_en || "").split(/[\n,;]+/).map((name) => name.trim()).filter(Boolean);
    const rosterMarkup = rosterNames.length
      ? rosterNames.map((name, index) => `<span class="golf-roster-name"><b>${index + 1}</b>${escape(name)}</span>`).join("")
      : '<span class="golf-roster-name">예약자 명단이 없습니다. / Không có danh sách khách.</span>';
    const note = oneLine(row.note);
    const cart = clean(row.smart_cart_note) || "—";
    const representative = row.representative_name || "—";
    const editHref = `golf_reserv.html?edit=${encodeURIComponent(String(row.id || ""))}`;
    const depositTotal = paymentTotal(row, "deposit");
    const receivedTotal = paymentTotal(row, ["deposit", "receipt"]);
    return `<tr data-status="${escape(row.status)}" aria-expanded="false">
      <td><span class="golf-status-chip${completed ? " is-completed" : ""}">${escape(statusLabel)}</span></td>
      <td>${escape(golfDateLabel(row.golf_date))}</td>
      <td>${escape(timeLabel(row.golf_time))}</td>
      <td class="golf-cell-text" title="${escape(row.counterparty_name || "—")}">${escape(row.counterparty_name || "—")}</td>
      <td class="golf-cell-text" title="${escape(representative)}"><button class="golf-edit-link" type="button" data-edit-href="${escape(editHref)}" title="더블클릭하여 수정 / Nhấp đúp để chỉnh sửa" aria-label="${escape(`${representative} 예약 수정, 더블클릭 / Chỉnh sửa đặt sân, nhấp đúp`)}">${escape(representative)}</button></td>
      <td class="golf-cell-names" title="${escape(names)}">${escape(names)}</td>
      <td>${escape(row.pax)}</td>
      <td>${escape(row.golf_course)}</td>
      <td>${escape(row.holes)}</td>
      <td class="golf-cell-text" title="${escape(cart)}">${escape(cart)}</td>
      <td class="golf-cell-money">${escape(moneyLabel(row.guest_unit_price_vnd))}</td>
      <td class="golf-cell-money">${escape(moneyLabel(row.guest_total_vnd))}</td>
      <td class="golf-cell-money">${escape(moneyLabel(row.course_unit_price_vnd))}</td>
      <td class="golf-cell-money">${escape(moneyLabel(row.course_total_vnd))}</td>
      <td class="golf-cell-text" title="${escape(costSettlementTypeLabel(row))}">${escape(costSettlementTypeLabel(row))}</td>
      <td class="golf-cell-text" title="${escape(costSettlementPartnerLabel(row))}">${escape(costSettlementPartnerLabel(row))}</td>
      <td class="golf-cell-money">${escape(moneyLabel(depositTotal))}</td>
      <td class="golf-cell-text golf-cell-payments" title="${escape(paymentDetailText(row, "deposit"))}"><span class="golf-payment-screen-summary">${escape(paymentMethodSummary(row, "deposit"))}</span><span class="golf-payment-print-detail">${escape(paymentDetailText(row, "deposit"))}</span></td>
      <td class="golf-cell-money">${escape(moneyLabel(receivedTotal))}</td>
      <td class="golf-cell-text golf-cell-payments" title="${escape(paymentDetailText(row, ["deposit", "receipt"]))}"><span class="golf-payment-screen-summary">${escape(paymentMethodSummary(row, ["deposit", "receipt"]))}</span><span class="golf-payment-print-detail">${escape(paymentDetailText(row, ["deposit", "receipt"]))}</span></td>
      <td class="golf-cell-money">${escape(moneyLabel(actualProfit(row)))}</td>
      <td>${escape(customerType)}</td>
      <td>${escape(dateTimeLabel(row.created_at))}</td>
      <td class="golf-cell-text" title="${escape(note)}">${escape(note)}</td>
      <td>${escape(dateTimeLabel(row.updated_at))}</td>
    </tr>
    <tr class="golf-roster-detail" data-roster-for="${escape(String(row.id || ""))}" hidden aria-hidden="true">
      <td colspan="25"><div class="golf-roster-panel"><div class="golf-expanded-grid">
        <section class="golf-expanded-section"><strong class="golf-roster-title">예약자 명단 ${rosterNames.length.toLocaleString("ko-KR")}명 / Danh sách khách</strong><div class="golf-roster-names">${rosterMarkup}</div></section>
        <section class="golf-expanded-section"><strong class="golf-roster-title">고객 입금 상세 / Chi tiết khoản thu</strong><div class="golf-payment-detail-groups">${paymentDetailMarkup(row)}</div></section>
      </div></div></td>
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
      const [reservations, payments] = await Promise.all([
        DGV.collectSupabasePages(
          () => sb.from("golf_reservations").select(COLUMNS),
          { pageSize: 500, order: [
            { column: "golf_date", ascending: true },
            { column: "golf_time", ascending: true },
            { column: "id", ascending: true }
          ] }
        ),
        DGV.collectSupabasePages(
          () => sb.from("golf_reservation_payments").select(PAYMENT_COLUMNS).in("payment_kind", ["deposit", "receipt"]),
          { pageSize: 500, order: [
            { column: "payment_date", ascending: true },
            { column: "sort_order", ascending: true },
            { column: "id", ascending: true }
          ] }
        )
      ]);
      const paymentsByReservation = new Map();
      for (const payment of payments) {
        if (!paymentsByReservation.has(payment.reservation_id)) paymentsByReservation.set(payment.reservation_id, []);
        paymentsByReservation.get(payment.reservation_id).push(payment);
      }
      state.rows = reservations.map((row) => ({
        ...row,
        payments: paymentsByReservation.get(row.id) || []
      })).sort((a, b) =>
        `${a.golf_date} ${a.golf_time} ${a.id}`
          .localeCompare(`${b.golf_date} ${b.golf_time} ${b.id}`)
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

  function confirmAndOpenEdit(button) {
    const href = clean(button?.dataset.editHref);
    if (!href) return;
    if (!global.confirm("이 예약을 수정하시겠습니까?\nBạn có muốn chỉnh sửa đặt sân này không?")) return;
    global.location.assign(href);
  }

  function bindEvents() {
    byId("reloadButton").addEventListener("click", () => loadRows());
    byId("printListButton").addEventListener("click", printList);
    byId("exportListButton").addEventListener("click", exportList);
    const tableBody = byId("reservationTableBody");
    tableBody.addEventListener("dblclick", (event) => {
      const button = event.target.closest("button.golf-edit-link[data-edit-href]");
      if (!button) return;
      event.preventDefault();
      confirmAndOpenEdit(button);
    });
    let suppressRowClickUntil = 0;
    tableBody.addEventListener("click", (event) => {
      const button = event.target.closest("button.golf-edit-link[data-edit-href]");
      if (button) {
        if (event.detail === 0) {
          confirmAndOpenEdit(button);
          return;
        }
      }
      if (event.detail !== 1 || Date.now() < suppressRowClickUntil) return;
      const row = event.target.closest("tr[data-status]");
      if (!row) return;
      const detailRow = row.nextElementSibling;
      if (!detailRow?.classList.contains("golf-roster-detail")) return;
      const expanded = detailRow.hidden;
      detailRow.hidden = !expanded;
      detailRow.setAttribute("aria-hidden", String(!expanded));
      row.classList.toggle("is-names-expanded", expanded);
      row.setAttribute("aria-expanded", String(expanded));
    });
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
      drag = { pointerId: event.pointerId, x: event.clientX, scrollLeft: sheet.scrollLeft, moved: false };
    });
    sheet.addEventListener("pointermove", (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      const deltaX = event.clientX - drag.x;
      if (!drag.moved && Math.abs(deltaX) <= 5) return;
      if (!drag.moved) {
        drag.moved = true;
        sheet.setPointerCapture(event.pointerId);
        sheet.classList.add("is-dragging");
      }
      sheet.scrollLeft = drag.scrollLeft - deltaX;
      event.preventDefault();
    });
    const stopDrag = (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (drag.moved) {
        suppressRowClickUntil = Date.now() + 250;
        if (sheet.hasPointerCapture?.(event.pointerId)) sheet.releasePointerCapture(event.pointerId);
      }
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

