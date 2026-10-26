(function initGolfBudgetDetail(global) {
  "use strict";

  // Read-only detail viewer. Budget ledgers, balances and editor handlers are not involved.
  const DGV = global.DGV;
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

  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
    </article>`).join("");
    return `<div class="golf-booking-detail">${bookingReportMarkup(booking, booking.rounds)}
      <h3 class="golf-roster-title">묶음 전체 일정 / Tất cả lịch trong đặt chung</h3><div class="golf-booking-schedules">${schedules}</div>
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

  function actualProfit(row) {
    if (row.booking) return null;
    if (row.status !== "completed" || row.course_total_vnd == null) return null;
    const received = paymentTotal(row, ["deposit", "receipt"]);
    if (received == null) return Number(row.final_received_amount_vnd || 0) - Number(row.course_total_vnd);
    return received - Number(row.course_total_vnd);
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


  async function loadReservation(id) {
    const { data: row, error } = await sb.from("golf_reservations").select(COLUMNS).eq("id", id).maybeSingle();
    if (error) throw error;
    if (!row) throw new Error("Reservation unavailable");
    if (row.booking_group_id) {
      if (!UUID_PATTERN.test(row.booking_group_id)) throw new Error("Invalid booking group");
      // All schedules are required: shared incoming payments must never be compared
      // with only the clicked schedule's sale price or cost.
      const rounds = await DGV.collectSupabasePages(
        () => sb.from("golf_reservations").select(COLUMNS).eq("booking_group_id", row.booking_group_id),
        { pageSize: 500, order: [
          { column: "golf_date", ascending: true },
          { column: "golf_time", ascending: true },
          { column: "id", ascending: true }
        ] }
      );
      await global.GolfBookings.loadAndAttach(rounds);
      const selected = rounds.find((round) => round.id === id);
      if (!selected?.booking) throw new Error("Booking group changed or unavailable");
      return selected;
    }
    const payments = await DGV.collectSupabasePages(
      () => sb.from("golf_reservation_payments").select(PAYMENT_COLUMNS)
        .eq("reservation_id", id).in("payment_kind", ["deposit", "receipt"]),
      { pageSize: 500, order: [
        { column: "payment_date", ascending: true },
        { column: "sort_order", ascending: true },
        { column: "id", ascending: true }
      ] }
    );
    return { ...row, payments, booking: null };
  }

  function create({ canView }) {
    const byId = (id) => document.getElementById(id);
    const dialog = byId("budgetReservationDialog");
    const title = byId("budgetReservationTitle");
    const subtitle = byId("budgetReservationSubtitle");
    const content = byId("budgetReservationContent");
    let generation = 0;
    let opener = null;
    let previousOverflow = null;

    function cleanup() {
      generation += 1;
      content.innerHTML = "";
      content.setAttribute("aria-busy", "false");
      if (previousOverflow !== null) {
        document.body.style.overflow = previousOverflow;
        previousOverflow = null;
      }
      const target = opener;
      opener = null;
      if (target?.isConnected) target.focus({ preventScroll: true });
    }

    function close() {
      if (dialog.open) dialog.close();
      cleanup();
    }

    async function open(id, trigger) {
      if (!canView() || !UUID_PATTERN.test(String(id || ""))) return;
      const requestGeneration = ++generation;
      opener = trigger || document.activeElement;
      title.textContent = "예약 상세 / Chi tiết đặt sân";
      subtitle.textContent = "조회 전용 / Chỉ xem";
      content.textContent = "예약 내역을 불러오는 중입니다. / Đang tải chi tiết đặt sân.";
      content.setAttribute("aria-busy", "true");
      if (!dialog.open) {
        previousOverflow = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        dialog.showModal();
      }
      dialog.scrollTop = 0;
      byId("closeBudgetReservation").focus({ preventScroll: true });
      try {
        const row = await loadReservation(id);
        if (generation !== requestGeneration || !dialog.open) return;
        if (!canView()) throw new Error("Access expired");
        title.textContent = row.booking ? bookingLabel(row.booking) : "예약 상세 / Chi tiết đặt sân";
        subtitle.textContent = `${row.status === "completed" ? "완료 / Hoàn tất" : "진행중 / Đang xử lý"} · ${golfDateLabel(row.golf_date)} · ${row.counterparty_name || "—"}`;
        content.innerHTML = reservationDetailMarkup(row);
      } catch (error) {
        if (generation !== requestGeneration || !dialog.open) return;
        content.textContent = "예약 상세를 불러오지 못했습니다. 삭제되었거나 조회 권한·연결에 문제가 있을 수 있습니다. 창을 닫고 다시 시도해 주세요. / Không thể tải chi tiết. Đặt sân có thể đã bị xóa hoặc có lỗi quyền truy cập, kết nối. Vui lòng đóng rồi mở lại.";
      } finally {
        if (generation === requestGeneration && dialog.open) content.setAttribute("aria-busy", "false");
      }
    }

    byId("closeBudgetReservation").addEventListener("click", close);
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(); });
    dialog.addEventListener("close", () => { if (!dialog.open) cleanup(); });
    dialog.addEventListener("click", (event) => {
      if (event.target !== dialog) return;
      const bounds = dialog.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right
        || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
    });
    return Object.freeze({ open, close });
  }

  global.GolfBudgetDetail = Object.freeze({ create });
})(window);

