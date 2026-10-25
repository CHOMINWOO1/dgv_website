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
    "status", "created_at", "updated_at", "booking_group_id"
  ].join(",");
  const state = { identity: null, rows: [], detailId: null, editor: null, refreshingEdit: false, deleting: false, loadGeneration: 0 };
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
    if (row?.booking) return [];
    return Array.isArray(row?.payments) ? row.payments : [];
  }

  function bookingLabel(booking) {
    return `묶음예약 · ${booking.label} · ${booking.rounds.length}일정 / Đặt chung · ${booking.rounds.length} lịch`;
  }

  function distinctBookings(rows) {
    const bookings = new Map();
    for (const row of rows) if (row.booking) bookings.set(row.booking.id, row.booking);
    return [...bookings.values()];
  }

  function completeTotal(rows, field) {
    return rows.some((row) => row[field] == null) ? null : rows.reduce((sum, row) => sum + Number(row[field]), 0);
  }

  function bookingReportMarkup(booking, rows, includePayments = true) {
    const selected = rows.filter((row) => row.booking?.id === booking.id);
    const field = (label, amount) => `<div><dt>${escape(label)}</dt><dd>${escape(moneyLabel(amount))}</dd></div>`;
    return `<section class="golf-booking-report"><h3>${escape(bookingLabel(booking))}</h3>
      <p>${escape(dateLabel(booking.range_from))} ~ ${escape(dateLabel(booking.range_to))} · 조회 일정 ${selected.length}/${booking.rounds.length} / Lịch đang lọc
      <br />입금·미수금·수익은 묶음 전체 기준이며 일정별로 배분하지 않습니다. / Khoản thu, công nợ và lợi nhuận tính cho toàn bộ đặt chung, không phân bổ từng lịch.</p>
      <dl class="golf-detail-values">${[
        field("조회 일정 판매 소계 / Tiền khách của lịch đang lọc", completeTotal(selected, "guest_total_vnd")),
        field("조회 일정 원가 소계 / Giá vốn của lịch đang lọc", completeTotal(selected, "course_total_vnd")),
        field("묶음 전체 판매 합계 / Tổng tiền khách đặt chung", booking.guest_total_vnd),
        field("묶음 전체 원가 합계 / Tổng giá vốn đặt chung", booking.cost_total_vnd),
        field("계약금 합계 / Tổng tiền cọc", booking.deposit_vnd),
        field("추가 입금 합계 / Tổng khoản thu thêm", booking.receipt_vnd),
        field("고객 총입금 / Tổng tiền khách đã trả", booking.received_vnd),
        field("묶음 미수금·초과입금 / Công nợ · Thu dư đặt chung", booking.balance_vnd),
        field("묶음 실제 수익 / Lợi nhuận đặt chung", booking.completed_at ? booking.profit_vnd : null)
      ].join("")}</dl>
      ${includePayments ? `<div class="golf-payment-detail-groups">${paymentDetailMarkup({ payments: booking.payments })}</div>` : ""}
    </section>`;
  }

  function bookingDetailMarkup(row) {
    const booking = row.booking;
    if (!booking) return "";
    const schedules = booking.rounds.map((round, index) => `<article class="golf-booking-schedule${round.id === row.id ? " is-selected" : ""}">
      <div><strong>${index + 1}. ${escape(golfDateLabel(round.golf_date))} ${escape(timeLabel(round.golf_time))} · ${escape(round.golf_course)}</strong>
      <span>${escape(round.holes)}H · ${escape(round.pax)}명 / khách · ${escape(round.representative_name || "—")}</span>
      <span>판매 / Tiền khách: ${escape(moneyLabel(round.guest_total_vnd))} · 원가 / Giá vốn: ${escape(moneyLabel(round.course_total_vnd))}</span></div>
      <button class="qr-btn qr-btn-small" type="button" data-edit-round="${escape(round.id)}">일정 수정 / Sửa lịch</button>
    </article>`).join("");
    return `<div class="golf-booking-detail">${bookingReportMarkup(booking, booking.rounds)}
      <h3 class="golf-roster-title">묶음 전체 일정 / Tất cả lịch trong đặt chung</h3><div class="golf-booking-schedules">${schedules}</div>
      <button class="qr-btn qr-btn-primary" type="button" data-edit-round="${escape(row.id)}">묶음 입금·완료 처리 / Thu tiền · Hoàn tất đặt chung</button>
      <h3 class="golf-roster-title golf-selected-round-title">선택한 일정 상세 / Chi tiết lịch đã chọn</h3></div>`;
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
    if (row.booking) return null;
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
        row.cost_partner_name, costSettlementTypeLabel(row), row.note, row.booking?.label
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
    byId("golfBookingPrintSummary").innerHTML = distinctBookings(rows).map((booking) => bookingReportMarkup(booking, rows)).join("");
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
        textCell(row.booking ? `${row.representative_name}\n${bookingLabel(row.booking)}` : row.representative_name, "wrapped"), textCell(row.player_names_en, "wrapped"), integerCell(row.pax),
        textCell(row.golf_course), integerCell(row.holes), textCell(row.smart_cart_note, "wrapped"),
        integerCell(row.guest_unit_price_vnd), integerCell(row.guest_total_vnd),
        integerCell(row.course_unit_price_vnd), integerCell(row.course_total_vnd),
        textCell(costSettlementTypeLabel(row)), textCell(costSettlementPartnerLabel(row)),
        row.booking ? textCell("묶음 정산 / Thu chung") : integerCell(depositTotal), textCell(depositTotal == null ? "" : paymentDetailText(row, "deposit"), "wrapped"),
        row.booking ? textCell("묶음 정산 / Thu chung") : integerCell(receivedTotal), textCell(receivedTotal == null ? "" : paymentDetailText(row, ["deposit", "receipt"]), "wrapped"),
        row.booking ? textCell("묶음 정산 / Thu chung") : integerCell(actualProfit(row)),
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
    const bookings = distinctBookings(rows);
    for (const booking of bookings) {
      for (const payment of booking.payments) transactionRows.push([
        textCell(`묶음 / Nhóm: ${booking.id}`),
        textCell(`${booking.range_from} ~ ${booking.range_to}`),
        textCell(booking.rounds[0]?.counterparty_name), textCell(booking.label),
        textCell(paymentKindLabel(payment.payment_kind)), textCell(payment.payment_date), integerCell(payment.amount_vnd),
        textCell(paymentMethodLabel(payment.payment_method)),
        textCell(booking.completed_at ? "완료 / Hoàn tất" : "진행중 / Đang xử lý"), textCell("")
      ]);
    }
    const bookingHeaders = [
      "묶음 ID / ID đặt chung", "묶음 이름 / Tên đặt chung", "전체 일정 시작 / Từ ngày", "전체 일정 종료 / Đến ngày",
      "조회 일정 수 / Số lịch đang lọc", "전체 일정 수 / Tổng số lịch",
      "조회 일정 판매 소계 / Tiền khách lịch đang lọc", "조회 일정 원가 소계 / Giá vốn lịch đang lọc",
      "묶음 전체 판매 / Tổng tiền khách đặt chung", "묶음 전체 원가 / Tổng giá vốn đặt chung",
      "계약금 / Tiền cọc", "추가 입금 / Khoản thu thêm", "총입금 / Tổng đã thu",
      "미수금·초과입금 / Công nợ · Thu dư", "묶음 실제 수익 / Lợi nhuận đặt chung", "상태 / Trạng thái"
    ];
    const bookingRows = bookings.map((booking) => {
      const selected = rows.filter((row) => row.booking?.id === booking.id);
      return [textCell(booking.id), textCell(booking.label), textCell(booking.range_from), textCell(booking.range_to),
        integerCell(selected.length), integerCell(booking.rounds.length),
        integerCell(completeTotal(selected, "guest_total_vnd")), integerCell(completeTotal(selected, "course_total_vnd")),
        integerCell(booking.guest_total_vnd), integerCell(booking.cost_total_vnd),
        integerCell(booking.deposit_vnd), integerCell(booking.receipt_vnd), integerCell(booking.received_vnd),
        integerCell(booking.balance_vnd), integerCell(booking.completed_at ? booking.profit_vnd : null),
        textCell(booking.completed_at ? "완료 / Hoàn tất" : "진행중 / Đang xử lý")];
    });
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
      }, ...(bookings.length ? [{
        name: "묶음 정산",
        rows: [
          [textCell("묶음 예약 정산 / Quyết toán đặt chung", "title"), ...Array(15).fill("")],
          [textCell("조회 기준 / Điều kiện lọc"), textCell(filterDescription()), ...Array(14).fill("")],
          [textCell("입금·미수금·수익은 묶음 전체 기준입니다. / Khoản thu, công nợ và lợi nhuận tính cho toàn bộ đặt chung."), ...Array(15).fill("")],
          [],
          bookingHeaders.map((label) => textCell(label, "header")), ...bookingRows
        ],
        columnWidths: [38,26,18,18,16,16,24,24,24,24,22,22,22,24,24,20],
        merges: ["A1:P1", "A3:P3"], freezeRows: 5, autoFilterRange: `A5:P${5 + bookingRows.length}`
      }] : [])]
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
    const bookings = distinctBookings(rows);
    const deposits = rows.reduce((total, row) => total + Number(paymentTotal(row, "deposit") || 0), 0)
      + bookings.reduce((total, booking) => total + Number(booking.deposit_vnd || 0), 0);
    const profit = rows.reduce((total, row) => total + Number(actualProfit(row) || 0), 0)
      + bookings.reduce((total, booking) => total + Number(booking.completed_at ? booking.profit_vnd || 0 : 0), 0);
    byId("summaryProgress").textContent = progress.toLocaleString("ko-KR");
    byId("summaryCompleted").textContent = completed.toLocaleString("ko-KR");
    byId("summaryDeposit").textContent = moneyLabel(deposits);
    byId("summaryProfit").textContent = moneyLabel(profit);
    byId("summaryScopeNote").hidden = !bookings.length;
  }

  function renderRow(row) {
    const completed = row.status === "completed";
    const customerType = row.customer_type === "company" ? "회사 / Công ty" : "개인 / Cá nhân";
    const statusLabel = completed ? "완료 / Hoàn tất" : "진행중 / Đang xử lý";
    const names = oneLine(row.player_names_en);
    const note = clean(row.note) || "—";
    const cart = clean(row.smart_cart_note) || "—";
    const representative = row.representative_name || "—";
    const depositTotal = paymentTotal(row, "deposit");
    const receivedTotal = paymentTotal(row, ["deposit", "receipt"]);
    return `<tr data-status="${escape(row.status)}" data-reservation-id="${escape(row.id)}">
      <td><button class="golf-detail-toggle" type="button" aria-haspopup="dialog" aria-controls="reservationDetailDialog" aria-label="${escape(`${representative} 예약 상세 보기 / Xem chi tiết đặt sân`)}" title="상세 보기 / Xem chi tiết">ⓘ</button><span class="golf-status-chip${completed ? " is-completed" : ""}">${escape(statusLabel)}</span></td>
      <td>${escape(golfDateLabel(row.golf_date))}</td>
      <td>${escape(timeLabel(row.golf_time))}</td>
      <td class="golf-cell-text" title="${escape(row.counterparty_name || "—")}">${escape(row.counterparty_name || "—")}</td>
      <td class="golf-cell-text" title="${escape(representative)}"><button class="golf-edit-link" type="button" aria-haspopup="dialog" aria-controls="reservationDetailDialog" title="상세 보기 / Xem chi tiết" aria-label="${escape(`${representative} 예약 상세 보기 / Xem chi tiết đặt sân`)}">${escape(representative)}</button></td>
      <td class="golf-cell-names" title="${escape(names)}"><span class="golf-screen-text">${escape(names)}</span><span class="golf-print-text">${escape(clean(row.player_names_en) || "—")}</span></td>
      <td>${escape(row.pax)}</td>
      <td>${escape(row.golf_course)}</td>
      <td>${escape(row.holes)}</td>
      <td class="golf-cell-text" title="${escape(cart)}">${escape(cart)}</td>
      <td class="golf-cell-money">${escape(moneyLabel(row.guest_unit_price_vnd))}</td>
      <td class="golf-cell-money">${escape(moneyLabel(row.guest_total_vnd))}</td>
      <td class="golf-cell-money golf-screen-hidden">${escape(moneyLabel(row.course_unit_price_vnd))}</td>
      <td class="golf-cell-money golf-screen-hidden">${escape(moneyLabel(row.course_total_vnd))}</td>
      <td class="golf-cell-text golf-screen-hidden" title="${escape(costSettlementTypeLabel(row))}">${escape(costSettlementTypeLabel(row))}</td>
      <td class="golf-cell-text golf-screen-hidden" title="${escape(costSettlementPartnerLabel(row))}">${escape(costSettlementPartnerLabel(row))}</td>
      <td class="golf-cell-money golf-screen-hidden">${escape(row.booking ? "묶음 정산 / Thu chung" : moneyLabel(depositTotal))}</td>
      <td class="golf-cell-text golf-cell-payments golf-screen-hidden" title="${escape(paymentDetailText(row, "deposit"))}"><span class="golf-payment-screen-summary">${escape(paymentMethodSummary(row, "deposit"))}</span><span class="golf-payment-print-detail">${escape(paymentDetailText(row, "deposit"))}</span></td>
      <td class="golf-cell-money golf-screen-hidden">${escape(row.booking ? "묶음 정산 / Thu chung" : moneyLabel(receivedTotal))}</td>
      <td class="golf-cell-text golf-cell-payments golf-screen-hidden" title="${escape(paymentDetailText(row, ["deposit", "receipt"]))}"><span class="golf-payment-screen-summary">${escape(paymentMethodSummary(row, ["deposit", "receipt"]))}</span><span class="golf-payment-print-detail">${escape(paymentDetailText(row, ["deposit", "receipt"]))}</span></td>
      <td class="golf-cell-money golf-screen-hidden">${escape(row.booking ? "묶음 정산 / Thu chung" : moneyLabel(actualProfit(row)))}</td>
      <td class="golf-screen-hidden">${escape(customerType)}</td>
      <td class="golf-screen-hidden">${escape(dateTimeLabel(row.created_at))}</td>
      <td class="golf-cell-text golf-cell-note golf-screen-hidden" title="${escape(note)}">${escape(note)}</td>
      <td class="golf-screen-hidden">${escape(dateTimeLabel(row.updated_at))}</td>
    </tr>`;
  }

  function reservationDetailMarkup(row) {
    const field = (label, value, wide = false) => `<div${wide ? ' class="golf-detail-wide"' : ""}><dt>${escape(label)}</dt><dd>${escape(value ?? "—")}</dd></div>`;
    const section = (title, content, wide = false) => `<section class="golf-expanded-section${wide ? " golf-detail-wide" : ""}"><h3 class="golf-roster-title">${escape(title)}</h3>${content}</section>`;
    const names = String(row.player_names_en || "").split(/[\n,;]+/).map((name) => name.trim()).filter(Boolean);
    const roster = names.length
      ? names.map((name, index) => `<span class="golf-roster-name"><b>${index + 1}</b>${escape(name)}</span>`).join("")
      : '<span class="golf-roster-name">예약자 명단이 없습니다. / Không có danh sách khách.</span>';
    const hasIncomingPayments = paymentsOfKinds(row, ["deposit", "receipt"]).length > 0;
    const deposit = hasIncomingPayments ? paymentTotal(row, "deposit") ?? 0 : row.deposit_amount_vnd ?? 0;
    const received = paymentTotal(row, ["deposit", "receipt"]) ?? row.final_received_amount_vnd ?? row.deposit_amount_vnd ?? 0;
    const receipt = hasIncomingPayments ? paymentTotal(row, "receipt") ?? 0 : Math.max(0, Number(received) - Number(deposit));
    const receivable = row.guest_total_vnd == null ? null : Number(row.guest_total_vnd) - Number(received);
    const reservation = `<dl class="golf-detail-values">${[
      field("거래처 / Đối tác", row.counterparty_name || "—"),
      field("예약자 대표 / Người đại diện", row.representative_name || "—"),
      field("인원 / Số khách", `${row.pax ?? 0}명 / khách`),
      field("골프 날짜·티오프 / Ngày chơi · Giờ", `${golfDateLabel(row.golf_date)} ${timeLabel(row.golf_time)}`),
      field("골프장 / Sân golf", row.golf_course || "—"),
      field("홀 / Số hố", row.holes ?? "—")
    ].join("")}</dl><h3 class="golf-roster-title" style="margin-top:14px">전체 예약자 명단 / Danh sách khách</h3><div class="golf-roster-names">${roster}</div>`;
    const financial = `<dl class="golf-detail-values">${[
      field("1인 판매가 / Giá khách", moneyLabel(row.guest_unit_price_vnd)),
      field("고객 합계 / Tổng tiền khách", moneyLabel(row.guest_total_vnd)),
      field("S-CART", clean(row.smart_cart_note) || "—"),
      field("1인 원가 / Giá vốn mỗi khách", moneyLabel(row.course_unit_price_vnd)),
      field("골프장·거래처 원가 합계 / Tổng giá vốn", moneyLabel(row.course_total_vnd)),
      ...(!row.booking ? [field("계약금 합계 / Tổng tiền cọc", moneyLabel(deposit)),
      field("추가 입금 합계 / Tổng khoản thu thêm", moneyLabel(receipt)),
      field("고객 총입금 / Tổng tiền khách đã trả", moneyLabel(received)),
      field("미수금·초과입금 / Còn phải thu · Thu dư", moneyLabel(receivable)),
      field("실제 수익 / Lợi nhuận", moneyLabel(actualProfit(row)))] : [])
    ].join("")}</dl>`;
    const other = `<dl class="golf-detail-values">${[
      field("원가 정산 방식 / Phương thức quyết toán", costSettlementTypeLabel(row)),
      field("정산 거래처 / Đối tác quyết toán", costSettlementPartnerLabel(row)),
      field("구분 / Loại khách", row.customer_type === "company" ? "회사 / Công ty" : "개인 / Cá nhân"),
      ...(!row.booking ? [field("예약금 최초 입금일 / Ngày nhận cọc đầu tiên", dateLabel(row.deposit_received_date)),
      field("완료 기준일 / Ngày hoàn tất", dateLabel(row.final_received_date))] : [
        field("묶음 완료 기준일 / Ngày hoàn tất đặt chung", dateLabel(row.booking.completion_date))
      ]),
      field("등록 일시 / Thời gian tạo", dateTimeLabel(row.created_at)),
      field("최종 수정 / Cập nhật", dateTimeLabel(row.updated_at)),
      field("비고 / Ghi chú", clean(row.note) || "—", true)
    ].join("")}</dl>`;
    return `${bookingDetailMarkup(row)}<div class="golf-expanded-grid">${section("예약 정보 / Thông tin đặt sân", reservation)}${section(row.booking ? "선택 일정 금액 / Số tiền lịch đã chọn" : "금액 요약 / Tổng hợp số tiền", financial)}${row.booking ? "" : section("입금 건별 내역 / Chi tiết từng khoản thu", `<div class="golf-payment-detail-groups">${paymentDetailMarkup(row)}</div>`)}${section("정산 및 기타 정보 / Quyết toán và thông tin khác", other)}</div>`;
  }

  function openReservationDetail(row) {
    if (!row) return;
    state.detailId = row.id;
    const dialog = byId("reservationDetailDialog");
    byId("reservationDetailTitle").textContent = row.booking ? bookingLabel(row.booking) : "예약 상세 / Chi tiết đặt sân";
    byId("reservationDetailSubtitle").textContent = `${row.status === "completed" ? "완료 / Hoàn tất" : "진행중 / Đang xử lý"} · ${golfDateLabel(row.golf_date)} · ${row.counterparty_name || "—"}`;
    byId("reservationDetailContent").innerHTML = reservationDetailMarkup(row);
    byId("editDetailReservation").dataset.editRound = row.id;
    byId("deleteDetailReservation").textContent = row.booking ? "이 일정 삭제 / Xóa lịch này" : "삭제 / Xóa";
    byId("deleteDetailReservation").dataset.reservationId = row.id;
    byId("deleteDetailGroup").hidden = !row.booking;
    byId("deleteDetailGroup").dataset.reservationId = row.id;
    byId("detailActionStatus").textContent = "";
    syncActionLocks();
    if (!dialog.open) dialog.showModal();
    dialog.scrollTop = 0;
  }

  function closeReservationDetail() {
    if (state.deleting) return;
    byId("reservationDetailDialog").close();
    state.detailId = null;
  }

  function orderedRows(rows) {
    return rows.slice().sort((a, b) =>
      `${a.golf_date} ${a.golf_time} ${a.id}`.localeCompare(`${b.golf_date} ${b.golf_time} ${b.id}`)
    );
  }

  function renderTableRows(rows) {
    return orderedRows(rows).map(renderRow).join("");
  }

  function render() {
    const rows = filteredRows();
    renderSummary(rows);
    byId("listCount").textContent = `${rows.length.toLocaleString("ko-KR")}건 / mục`;
    byId("reservationTableBody").innerHTML = rows.length
      ? renderTableRows(rows)
      : '<tr><td class="golf-cell-empty" colspan="25">조건에 맞는 골프 예약이 없습니다. / Không có đặt sân phù hợp.</td></tr>';
    byId("golfBookingPrintSummary").innerHTML = distinctBookings(rows).map((booking) => bookingReportMarkup(booking, rows)).join("");
  }

  async function loadRows(options = {}) {
    const generation = ++state.loadGeneration;
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
      if (generation !== state.loadGeneration) return false;
      const paymentsByReservation = new Map();
      for (const payment of payments) {
        if (!paymentsByReservation.has(payment.reservation_id)) paymentsByReservation.set(payment.reservation_id, []);
        paymentsByReservation.get(payment.reservation_id).push(payment);
      }
      const loadedRows = reservations.map((row) => ({
        ...row,
        payments: paymentsByReservation.get(row.id) || []
      })).sort((a, b) =>
        `${a.golf_date} ${a.golf_time} ${a.id}`
          .localeCompare(`${b.golf_date} ${b.golf_time} ${b.id}`)
      );
      if (!global.GolfBookings?.loadAndAttach) throw new Error("묶음 예약 모듈을 불러오지 못했습니다. 페이지를 새로고침해 주세요. / Vui lòng tải lại trang.");
      await global.GolfBookings.loadAndAttach(loadedRows);
      if (generation !== state.loadGeneration) return false;
      state.rows = loadedRows;
      render();
      QRStaff.connectionBadge("online", "연결됨");
      if (!options.quiet) setBanner("골프 예약 목록을 불러왔습니다. / Đã tải danh sách đặt sân.", "ok");
      return true;
    } catch (error) {
      if (generation !== state.loadGeneration) return false;
      console.error(error);
      QRStaff.connectionBadge("offline", "연결 오류");
      setBanner(QRStaff.messageOf(error, "골프 예약 목록을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요."), "error");
      return false;
    }
  }

  function inlineEditStatus(message, tone = "info") {
    const status = byId("inlineEditStatus");
    status.textContent = message;
    status.dataset.tone = tone;
  }

  function syncActionLocks() {
    const busy = Boolean(state.editor || state.refreshingEdit || state.deleting);
    for (const id of ["addReservationButton", "editDetailReservation", "deleteDetailReservation", "deleteDetailGroup", "reloadButton", "printListButton", "exportListButton", "searchInput", "statusFilter", "filterFrom", "filterTo", "clearFiltersButton"]) byId(id).disabled = busy;
    byId("closeReservationDetail").disabled = state.deleting;
    for (const button of byId("reservationDetailContent").querySelectorAll?.("button[data-edit-round]") || []) button.disabled = busy;
  }

  function openInlineCreate() { openInlineEditor(null, "create"); }

  function openInlineEditor(recordId, mode = "edit") {
    if (state.editor || state.refreshingEdit || state.deleting || !["edit", "create"].includes(mode)) return;
    if (mode === "edit" && !UUID_PATTERN.test(String(recordId))) return;
    const row = mode === "edit" ? state.rows.find((item) => item.id === recordId) : null;
    if (mode === "edit" && !row) return;
    if (!global.crypto?.randomUUID) {
      QRStaff.toast("안전한 수정 창을 열지 못했습니다. HTTPS 주소에서 다시 시도해 주세요. / Vui lòng mở trang HTTPS để chỉnh sửa.", "error");
      return;
    }
    const sheet = document.querySelector(".golf-sheet-wrap");
    const editor = {
      token: global.crypto.randomUUID(), recordId: row?.id || null, mode,
      allowedIds: new Set((row?.booking?.rounds || (row ? [row] : [])).map((item) => item.id)),
      returnDetailId: state.detailId || row?.id || null, ready: false, savingResult: false,
      scroll: { x: global.scrollX || 0, y: global.scrollY || 0, left: sheet.scrollLeft, top: sheet.scrollTop },
      timer: null
    };
    state.editor = editor;
    closeReservationDetail();
    syncActionLocks();
    byId("inlineEditTitle").textContent = mode === "create" ? "새 예약 추가 / Thêm đặt sân mới" : `예약 수정 / Chỉnh sửa · ${row.representative_name || "—"}`;
    inlineEditStatus("예약 입력 화면을 불러오는 중입니다. / Đang tải màn hình đặt sân.");
    const url = new URL("golf_reserv.html", global.location.href);
    if (mode === "create") url.searchParams.set("create", "1");
    else url.searchParams.set("edit", row.id);
    url.searchParams.set("embedded", "1");
    url.searchParams.set("editorToken", editor.token);
    byId("inlineEditFrame").src = url.href;
    byId("inlineEditDialog").showModal();
    editor.timer = global.setTimeout(() => {
      if (state.editor === editor && !editor.ready) inlineEditStatus("화면 로딩이 지연되고 있습니다. 로그인 화면 또는 네트워크 연결을 확인해 주세요. / Tải chậm. Vui lòng kiểm tra đăng nhập hoặc kết nối mạng.", "error");
    }, 20000);
  }

  function removeInlineEditor() {
    const editor = state.editor;
    if (!editor) return null;
    if (editor.timer != null) global.clearTimeout(editor.timer);
    state.editor = null;
    byId("inlineEditDialog").close();
    byId("inlineEditFrame").src = "about:blank";
    syncActionLocks();
    return editor;
  }

  function restoreListPosition(editor) {
    const sheet = document.querySelector(".golf-sheet-wrap");
    sheet.scrollLeft = editor.scroll.left;
    sheet.scrollTop = editor.scroll.top;
    global.scrollTo(editor.scroll.x, editor.scroll.y);
  }

  function closeInlineEditor() {
    const editor = removeInlineEditor();
    if (!editor) return;
    const row = state.rows.find((item) => item.id === editor.returnDetailId);
    if (row) openReservationDetail(row);
    restoreListPosition(editor);
  }

  function requestInlineEditorClose() {
    const editor = state.editor;
    if (!editor || editor.savingResult) return;
    // The embedded child keeps its reservation form hidden/locked until ready.
    if (!editor.ready) { closeInlineEditor(); return; }
    byId("inlineEditFrame").contentWindow.postMessage({ type: "golf-editor-request-close", token: editor.token, mode: editor.mode }, global.location.origin);
  }

  async function onInlineEditorMessage(event) {
    const editor = state.editor;
    const message = event.data;
    if (!editor || event.origin !== global.location.origin || event.source !== byId("inlineEditFrame").contentWindow
      || !message || typeof message !== "object" || message.token !== editor.token) return;
    if (editor.mode === "create") {
      if (message.mode !== "create") return;
      if (message.type === "golf-editor-saved" ? !UUID_PATTERN.test(String(message.recordId)) : message.recordId !== null) return;
    } else if ((message.mode != null && message.mode !== "edit") || !UUID_PATTERN.test(String(message.recordId)) || !editor.allowedIds.has(message.recordId)) return;
    if (message.type === "golf-editor-ready") {
      editor.ready = true;
      if (editor.timer != null) global.clearTimeout(editor.timer);
      inlineEditStatus(editor.mode === "create" ? "새 예약을 입력한 후 저장해 주세요. / Nhập đặt sân mới rồi lưu." : "같은 페이지에서 수정한 후 저장해 주세요. / Chỉnh sửa rồi lưu ngay tại đây.");
    } else if (message.type === "golf-editor-close") {
      if (!editor.savingResult) {
        if (editor.mode === "create" && message.refreshRequired === true && editor.ready) await refreshAfterEditor(editor, null, true);
        else closeInlineEditor();
      }
    } else if (message.type === "golf-editor-close-blocked") {
      inlineEditStatus("저장 중이거나 저장하지 않은 변경사항이 있습니다. 수정 화면을 확인해 주세요. / Đang lưu hoặc có thay đổi chưa lưu. Vui lòng kiểm tra.");
    } else if (message.type === "golf-editor-error") {
      inlineEditStatus("수정 화면을 준비하지 못했습니다. 화면의 안내를 확인하거나 닫고 다시 시도해 주세요. / Không thể mở chỉnh sửa. Vui lòng kiểm tra hoặc đóng rồi thử lại.", "error");
    } else if (message.type === "golf-editor-saved" && editor.ready && !editor.savingResult) {
      await refreshAfterEditor(editor, message.recordId);
    }
  }

  async function refreshAfterEditor(editor, savedId, uncertain = false) {
    editor.savingResult = true;
    state.refreshingEdit = true;
    removeInlineEditor();
    closeReservationDetail();
    setBanner("저장된 내용을 다시 불러오는 중입니다. / Đang tải lại dữ liệu đã lưu.");
    try {
      const loaded = await loadRows({ quiet: true });
      if (loaded) {
        const detailId = editor.mode === "create" && savedId ? savedId : editor.returnDetailId;
        const freshRow = state.rows.find((item) => item.id === detailId);
        if (freshRow) openReservationDetail(freshRow);
        if (uncertain) setBanner("저장 여부를 목록에서 확인해 주세요. 현재 검색·날짜 조건 밖의 예약도 있을 수 있습니다. 확인 전에는 같은 예약을 다시 추가하지 마세요. / Kiểm tra đã lưu hay chưa, kể cả ngoài bộ lọc, trước khi tạo lại.", "error");
        else if (editor.mode === "create" && !freshRow) setBanner("저장 응답은 받았지만 최신 목록에서 새 예약을 확인하지 못했습니다. 새로고침 후 확인해 주세요. / Đã nhận phản hồi lưu nhưng chưa tìm thấy đặt sân mới. Vui lòng tải lại để kiểm tra.", "error");
        else if (editor.mode === "create" && !filteredRows().some((item) => item.id === savedId)) setBanner("새 예약을 저장했습니다. 현재 검색·기간 조건 밖이므로 상세만 표시합니다. / Đã lưu đặt sân mới ngoài bộ lọc hiện tại; đang hiển thị chi tiết.", "ok");
        else setBanner("저장한 내용이 목록과 상세에 반영되었습니다. / Đã cập nhật danh sách và chi tiết.", "ok");
      } else {
        state.rows = [];
        render();
        setBanner("저장 후 최신 목록을 확인하지 못했습니다. 다시 추가하지 말고 새로고침해 주세요. / Chưa xác nhận danh sách mới. Không tạo lại, hãy tải lại trang.", "error");
      }
    } finally {
      state.refreshingEdit = false;
      syncActionLocks();
      restoreListPosition(editor);
    }
  }

  function deletionWarning(row, wholeGroup) {
    const identity = `${golfDateLabel(row.golf_date)} ${timeLabel(row.golf_time)} · ${row.golf_course} · ${row.representative_name || "—"}`;
    const irreversible = "삭제한 기록은 복구할 수 없습니다. / Không thể khôi phục bản ghi đã xóa.";
    const refund = "실제 고객 환불은 처리되지 않습니다. / Không thực hiện hoàn tiền thực tế cho khách.";
    if (wholeGroup) {
      const booking = row.booking;
      const schedules = booking.rounds.map((round) => `${golfDateLabel(round.golf_date)} ${timeLabel(round.golf_time)} · ${round.golf_course} · ${round.representative_name || "—"}`).join("\n");
      return `${booking.label} · 전체 ${booking.rounds.length}일정 / Toàn bộ ${booking.rounds.length} lịch\n${schedules}\n\n계약금 / Tiền cọc: ${moneyLabel(booking.deposit_vnd)}\n추가 입금 / Khoản thu thêm: ${moneyLabel(booking.receipt_vnd)}\n\n묶음 전체 일정과 공통 입금 기록을 모두 삭제합니다. 활성 골프장·거래처 차감은 복원됩니다.\nXóa tất cả lịch và sổ thu chung; hoàn lại các khoản khấu trừ sân và đối tác đang hiệu lực.\n${irreversible}\n${refund}\n\n정말 묶음 전체를 삭제하시겠습니까? / Bạn có chắc muốn xóa toàn bộ nhóm?`;
    }
    if (row.booking) return `${identity}\n\n이 일정만 삭제하며 다른 일정과 공통 입금 내역은 유지합니다. 이 일정의 골프장·거래처 차감은 복원됩니다.\nChỉ xóa lịch này, giữ các lịch khác và khoản thu chung. Hoàn lại khấu trừ sân hoặc đối tác của lịch này.\n${irreversible}\n${refund}\n\n이 일정만 삭제하시겠습니까? / Xóa riêng lịch này?`;
    return `${identity}\n\n이 예약과 입금 내역을 삭제하며 골프장·거래처 차감은 복원됩니다.\nXóa đặt sân và các khoản thu; hoàn lại khấu trừ sân hoặc đối tác.\n${irreversible}\n${refund}\n\n이 예약을 삭제하시겠습니까? / Bạn có muốn xóa đặt sân này?`;
  }

  async function deleteReservation(recordId, wholeGroup = false) {
    if (state.deleting || state.refreshingEdit || state.editor || !UUID_PATTERN.test(String(recordId))) return;
    const row = state.rows.find((item) => item.id === recordId);
    if (!row || (wholeGroup && !row.booking)) return;
    if (!global.confirm(deletionWarning(row, wholeGroup))) return;
    const target = { id: row.id, updatedAt: row.updated_at, groupId: row.booking?.id || null, version: row.booking?.version };
    const sheet = document.querySelector(".golf-sheet-wrap");
    const position = { scroll: { x: global.scrollX || 0, y: global.scrollY || 0, left: sheet.scrollLeft, top: sheet.scrollTop } };
    state.deleting = true;
    syncActionLocks();
    byId("detailActionStatus").textContent = "삭제 결과를 확인하는 중입니다. / Đang xác nhận kết quả xóa.";
    let confirmed = false, mutationError = null, loaded = false;
    try {
      let result;
      if (wholeGroup) result = await sb.rpc("delete_golf_booking_group", { p_group_id: target.groupId, p_expected_version: target.version });
      else if (target.groupId) result = await sb.rpc("delete_golf_booking_round", { p_reservation_id: target.id, p_expected_version: target.version });
      else {
        let query = sb.from("golf_reservations").delete().eq("id", target.id);
        if (target.updatedAt) query = query.eq("updated_at", target.updatedAt);
        result = await query.select("id").single();
      }
      if (result.error) throw result.error;
      const returnedId = target.groupId ? result.data : result.data?.id;
      if (returnedId !== (wholeGroup ? target.groupId : target.id)) throw new Error("삭제 응답을 확인하지 못했습니다. / Chưa xác nhận phản hồi xóa.");
      confirmed = true;
    } catch (error) {
      mutationError = error;
    }
    try {
      // A transport error can happen after commit. Read back before allowing a retry.
      loaded = await loadRows({ quiet: true });
      if (!loaded) { state.rows = []; render(); }
    } finally {
      state.deleting = false;
      syncActionLocks();
      closeReservationDetail();
      restoreListPosition(position);
    }
    const remains = wholeGroup ? state.rows.some((item) => item.booking_group_id === target.groupId) : state.rows.some((item) => item.id === target.id);
    let message, tone = "error";
    if (!loaded) message = "삭제 결과와 최신 목록을 확인하지 못했습니다. 추가 삭제 전에 새로고침해 주세요. / Chưa xác nhận kết quả xóa. Hãy tải lại trước khi xóa tiếp.";
    else if (!remains) {
      message = confirmed ? "삭제가 완료되어 최신 목록에 반영되었습니다. / Đã xóa và cập nhật danh sách." : "응답 확인 중 오류가 있었지만 최신 목록에서 해당 예약이 없는 것을 확인했습니다. / Phản hồi gặp lỗi; danh sách mới xác nhận không còn đặt sân này.";
      tone = confirmed ? "ok" : "info";
    } else {
      message = QRStaff.messageOf(mutationError, "예약이 변경되었거나 삭제되지 않았습니다. 최신 내용을 확인한 후 다시 시도해 주세요. / Đặt sân đã thay đổi hoặc chưa bị xóa. Kiểm tra dữ liệu mới rồi thử lại.");
      const freshRow = state.rows.find((item) => item.id === target.id);
      if (freshRow) { openReservationDetail(freshRow); byId("detailActionStatus").textContent = message; }
    }
    setBanner(message, tone);
    QRStaff.toast(message, tone);
  }

  function bindEvents() {
    byId("reloadButton").addEventListener("click", () => { if (!state.deleting && !state.editor && !state.refreshingEdit) loadRows(); });
    byId("addReservationButton").addEventListener("click", openInlineCreate);
    byId("printListButton").addEventListener("click", printList);
    byId("exportListButton").addEventListener("click", exportList);
    const detailDialog = byId("reservationDetailDialog");
    byId("closeReservationDetail").addEventListener("click", closeReservationDetail);
    byId("deleteDetailReservation").addEventListener("click", (event) => deleteReservation(event.currentTarget.dataset.reservationId));
    byId("deleteDetailGroup").addEventListener("click", (event) => deleteReservation(event.currentTarget.dataset.reservationId, true));
    byId("editDetailReservation").addEventListener("click", (event) => openInlineEditor(event.currentTarget.dataset.editRound));
    byId("reservationDetailContent").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-edit-round]");
      if (button) openInlineEditor(button.dataset.editRound);
    });
    detailDialog.addEventListener("click", (event) => {
      if (event.target !== detailDialog) return;
      const bounds = detailDialog.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeReservationDetail();
    });
    detailDialog.addEventListener("cancel", (event) => { if (state.deleting) event.preventDefault(); });
    const editDialog = byId("inlineEditDialog");
    byId("closeInlineEdit").addEventListener("click", requestInlineEditorClose);
    editDialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      requestInlineEditorClose();
    });
    editDialog.addEventListener("click", (event) => {
      if (event.target !== editDialog) return;
      const bounds = editDialog.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) requestInlineEditorClose();
    });
    byId("inlineEditFrame").addEventListener("error", () => {
      if (state.editor) inlineEditStatus("수정 화면을 불러오지 못했습니다. 연결 상태를 확인해 주세요. / Không tải được chỉnh sửa. Vui lòng kiểm tra kết nối.", "error");
    });
    global.addEventListener("message", onInlineEditorMessage);
    global.addEventListener("beforeunload", (event) => {
      if (state.deleting) { event.preventDefault(); event.returnValue = ""; }
    });
    const tableBody = byId("reservationTableBody");
    let suppressRowClickUntil = 0;
    tableBody.addEventListener("click", (event) => {
      if (state.deleting || state.editor || state.refreshingEdit || event.detail > 1 || Date.now() < suppressRowClickUntil) return;
      const row = event.target.closest("tr[data-reservation-id]");
      if (!row) return;
      openReservationDetail(state.rows.find((item) => String(item.id) === row.dataset.reservationId));
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
