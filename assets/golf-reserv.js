(function initGolfReservationPage(global) {
  "use strict";

  if (!global.DGV || !global.QRStaff) throw new Error("Golf reservation dependencies are missing.");

  const DGV = global.DGV;
  const QRStaff = global.QRStaff;
  const sb = DGV.supabase;
  const TIME_ZONE = "Asia/Ho_Chi_Minh";
  const MAX_SAFE_MONEY = 9007199254740991;
  const GOLF_COURSES = new Set(["AT1200", "SAM", "PALACE"]);
  const STANDARD_HOLES = new Set([9, 18, 27, 26]);
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

  const state = { identity: null, rows: [], statusFilter: "in_progress", saving: false };
  const byId = (id) => document.getElementById(id);
  const escape = (value) => DGV.escapeHTML(value ?? "");
  const clean = (value) => String(value ?? "").trim();
  const nullableText = (value) => clean(value) || null;
  const todayYmd = () => DGV.formatYmdInTimeZone(new Date(), TIME_ZONE);

  function dateLabel(value) {
    const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return match ? `${match[1]}. ${match[2]}. ${match[3]}` : "—";
  }

  function golfDateLabel(value) {
    const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return "—";
    const weekday = ["일/CN", "월/T2", "화/T3", "수/T4", "목/T5", "금/T6", "토/T7"][
      new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay()
    ];
    return match[1] + ". " + match[2] + ". " + match[3] + " (" + weekday + ")";
  }

  function dateTimeLabel(value) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat("ko-KR", {
      timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false
    }).format(date);
  }

  function timeLabel(value) {
    const match = String(value || "").match(/^(\d{2}):(\d{2})/);
    return match ? `${match[1]}:${match[2]}` : "—";
  }

  function moneyNumber(value) {
    const digits = String(value ?? "").replace(/[^0-9]/g, "");
    if (!digits) return null;
    const number = Number(digits);
    return Number.isSafeInteger(number) ? number : NaN;
  }

  function moneyLabel(value) {
    if (value == null || value === "") return "—";
    const number = Number(value);
    return Number.isFinite(number) ? `${Math.round(number).toLocaleString("ko-KR")} VND` : "—";
  }

  function formatMoneyInput(input) {
    const value = moneyNumber(input.value);
    input.value = Number.isFinite(value) ? value.toLocaleString("ko-KR") : "";
  }

  function setMoneyInput(id, value) {
    byId(id).value = value == null ? "" : Number(value).toLocaleString("ko-KR");
  }

  function namesCount(value) {
    return String(value || "").split(/[\n,;]+/).map((name) => name.trim()).filter(Boolean).length;
  }

  function firstPlayerName(value) {
    const first = String(value || "").replace(/\r/g, "").split(/[\n,;]+/)
      .map((name) => name.trim()).find(Boolean) || "";
    return first
      .replace(/^["'-]*\s*(?:\d+\s*[.)/-]?\s*)?/, "")
      .split("\t", 1)[0]
      .replace(/\s+(?:남|여)\s*\([MF]\)\s*$/i, "")
      .replace(/\s+(?:MR|MS|MRS)(?:\s+\d{4}-\d{2}-\d{2})?\s*$/i, "")
      .replace(/["']+\s*$/, "")
      .trim();
  }

  function customerTypeForCounterparty(value) {
    const normalized = clean(value).normalize("NFC").toLocaleLowerCase("vi-VN");
    return normalized === "sếp" || normalized === "sep" ? "individual" : "company";
  }

  function syncCustomerType() {
    byId("customerType").value = customerTypeForCounterparty(byId("counterpartyName").value);
  }

  function setBanner(message, tone = "info") {
    if (tone === "error") QRStaff.toast(message, "error");
  }

  function clearLegacyCourseOption() {
    const option = byId("golfCourse").querySelector("option[data-legacy-course]");
    if (option) option.remove();
  }

  function setCourseValue(value) {
    clearLegacyCourseOption();
    const course = clean(value);
    if (course && !GOLF_COURSES.has(course)) {
      const option = document.createElement("option");
      option.value = course;
      option.textContent = `${course} (기존값 / Dữ liệu cũ)`;
      option.dataset.legacyCourse = "true";
      byId("golfCourse").append(option);
    }
    byId("golfCourse").value = course;
  }

  function clearLegacyHoleOption() {
    const option = byId("holes").querySelector("option[data-legacy-hole]");
    if (option) option.remove();
  }

  function setHoleValue(value) {
    clearLegacyHoleOption();
    const holes = Number(value || 18);
    if (!STANDARD_HOLES.has(holes)) {
      const option = document.createElement("option");
      option.value = String(holes);
      option.textContent = `${holes} (기존값 / Dữ liệu cũ)`;
      option.dataset.legacyHole = "true";
      byId("holes").append(option);
    }
    byId("holes").value = String(holes);
  }

  function updatePreview() {
    const pax = Number(byId("pax").value || 0);
    const guestUnit = moneyNumber(byId("guestUnitPrice").value);
    const courseUnit = moneyNumber(byId("courseUnitPrice").value);
    const guestTotal = pax > 0 && Number.isFinite(guestUnit) ? pax * guestUnit : null;
    const courseTotal = pax > 0 && Number.isFinite(courseUnit) ? pax * courseUnit : null;
    const margin = guestTotal != null && courseTotal != null ? guestTotal - courseTotal : null;
    byId("guestTotalPreview").textContent = moneyLabel(guestTotal);
    byId("courseTotalPreview").textContent = moneyLabel(courseTotal);
    byId("marginPreview").textContent = moneyLabel(margin);
    const finalAmount = moneyNumber(byId("finalAmount").value);
    const completed = Number.isFinite(finalAmount) && Boolean(byId("finalDate").value);
    byId("statusPreview").textContent = completed ? "완료 / Hoàn tất" : "진행중 / Đang xử lý";
  }

  function resetForm(options = {}) {
    byId("reservationForm").reset();
    byId("recordId").value = "";
    byId("depositDate").value = todayYmd();
    clearLegacyCourseOption();
    byId("golfCourse").value = "";
    clearLegacyHoleOption();
    byId("holes").value = "18";
    syncCustomerType();
    byId("formTitle").textContent = "새 골프 예약 / Đặt sân mới";
    byId("editingHint").textContent = "예약금(0 VND 가능)과 날짜를 입력해 진행중 예약을 등록합니다. / Có thể nhập tiền cọc 0 VND.";
    byId("saveButton").textContent = "예약 저장 / Lưu đặt chỗ";
    byId("cancelEditButton").hidden = true;
    updatePreview();
    if (options.focus !== false) byId("counterpartyName").focus();
  }

  function fillForm(row, options = {}) {
    byId("recordId").value = row.id;
    byId("counterpartyName").value = row.counterparty_name || "";
    byId("representativeName").value = row.representative_name || "";
    byId("playerNamesEn").value = row.player_names_en || "";
    byId("pax").value = row.pax || "";
    syncCustomerType();
    byId("golfDateTime").value = row.golf_date && row.golf_time
      ? `${row.golf_date}T${String(row.golf_time).slice(0, 5)}`
      : "";
    setCourseValue(row.golf_course);
    setHoleValue(row.holes);
    byId("smartCartNote").value = row.smart_cart_note || "";
    setMoneyInput("guestUnitPrice", row.guest_unit_price_vnd);
    setMoneyInput("courseUnitPrice", row.course_unit_price_vnd);
    setMoneyInput("depositAmount", row.deposit_amount_vnd);
    byId("depositDate").value = row.deposit_received_date || "";
    setMoneyInput("finalAmount", row.final_received_amount_vnd);
    byId("finalDate").value = row.final_received_date || "";
    setMoneyInput("withdrawalAmount", row.withdrawal_amount_vnd);
    byId("withdrawalDate").value = row.withdrawal_date || "";
    byId("note").value = row.note || "";
    byId("formTitle").textContent = `${row.representative_name} 수정 / Chỉnh sửa ${row.representative_name}`;
    byId("editingHint").textContent = row.status === "completed"
      ? "완료 기록을 수정합니다. 최종 금액과 날짜를 모두 지우면 진행중으로 돌아갑니다."
      : "진행중 예약을 수정하거나 최종 입금 정보를 입력해 완료할 수 있습니다.";
    byId("saveButton").textContent = "변경 저장 / Lưu thay đổi";
    byId("cancelEditButton").hidden = false;
    updatePreview();
    if (options.scroll !== false) {
      byId("formTitle").scrollIntoView({ behavior: "smooth", block: "start" });
      if (options.focusFinal) global.setTimeout(() => byId("finalAmount").focus(), 320);
    }
  }

  function payloadFromForm() {
    const playerNamesEn = clean(byId("playerNamesEn").value)
      .split(/[\n,;]+/).map((name) => name.trim()).filter(Boolean).join("\n");
    const counterpartyName = clean(byId("counterpartyName").value);
    const representativeName = firstPlayerName(playerNamesEn);
    const pax = Number(byId("pax").value);
    const golfDateTime = byId("golfDateTime").value;
    const golfDateTimeMatch = golfDateTime.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/);
    const golfDate = golfDateTimeMatch?.[1] || "";
    const golfTime = golfDateTimeMatch?.[2] || "";
    const golfCourse = clean(byId("golfCourse").value);
    const holes = Number(byId("holes").value);
    const guestUnit = moneyNumber(byId("guestUnitPrice").value);
    const courseUnit = moneyNumber(byId("courseUnitPrice").value);
    const depositAmount = moneyNumber(byId("depositAmount").value);
    const depositDate = byId("depositDate").value;
    const finalAmount = moneyNumber(byId("finalAmount").value);
    const finalDate = byId("finalDate").value || null;
    const withdrawalAmount = moneyNumber(byId("withdrawalAmount").value);
    const withdrawalDate = byId("withdrawalDate").value || null;
    const existingRow = state.rows.find((row) => row.id === byId("recordId").value);
    const customerType = customerTypeForCounterparty(counterpartyName);
    byId("customerType").value = customerType;

    if (!counterpartyName) throw new Error("거래처를 입력해 주세요.");
    if (!representativeName) throw new Error("첫 번째 예약자 이름을 확인해 주세요.");
    if (!playerNamesEn) throw new Error("전체 영문 이름을 입력해 주세요.");
    if (!Number.isInteger(pax) || pax < 1 || pax > 100) throw new Error("인원을 1명 이상 100명 이하로 입력해 주세요.");
    if (!golfDate || !golfTime) throw new Error("골프 날짜와 티오프 시간을 선택해 주세요.");
    const unchangedLegacyCourse = existingRow && existingRow.golf_course === golfCourse;
    if (!GOLF_COURSES.has(golfCourse) && !unchangedLegacyCourse) {
      throw new Error("골프장을 AT1200, SAM, PALACE 중에서 선택해 주세요.");
    }
    const unchangedLegacyHoles = existingRow && Number(existingRow.holes) === holes;
    if (!STANDARD_HOLES.has(holes) && !unchangedLegacyHoles) throw new Error("홀 수를 9, 18, 27, 26 중에서 선택해 주세요.");
    for (const [label, value, max] of [
      ["1인 판매가", guestUnit, 1000000000000], ["1인 골프장 원가", courseUnit, 1000000000000],
      ["예약금", depositAmount, MAX_SAFE_MONEY], ["최종 총입금액", finalAmount, MAX_SAFE_MONEY],
      ["출금액", withdrawalAmount, MAX_SAFE_MONEY]
    ]) {
      if (Number.isNaN(value) || (value != null && (value < 0 || value > max))) throw new Error(`${label}을 올바르게 입력해 주세요.`);
    }
    if (depositAmount == null) throw new Error("예약금을 입력해 주세요. 0 VND도 입력할 수 있습니다.");
    if (!depositDate) throw new Error("예약금 입금일을 입력해 주세요.");
    if ((finalAmount == null) !== (finalDate == null)) throw new Error("최종 총입금액과 최종 입금일은 함께 입력하거나 함께 비워 주세요.");
    if (finalAmount != null && finalAmount < depositAmount) throw new Error("최종 총입금액은 예약금보다 작을 수 없습니다.");
    if (finalDate && finalDate < depositDate) throw new Error("최종 입금일은 예약금 입금일보다 빠를 수 없습니다.");
    if ((withdrawalAmount == null) !== (withdrawalDate == null)) throw new Error("출금액과 출금일은 함께 입력하거나 함께 비워 주세요.");
    if (!new Set(["individual", "company"]).has(customerType)) throw new Error("개인 또는 회사를 선택해 주세요.");

    return {
      counterparty_name: counterpartyName, representative_name: representativeName, player_names_en: playerNamesEn, pax,
      golf_date: golfDate, golf_time: golfTime, golf_course: golfCourse, holes,
      guest_unit_price_vnd: guestUnit, smart_cart_note: nullableText(byId("smartCartNote").value),
      course_unit_price_vnd: courseUnit, deposit_amount_vnd: depositAmount,
      deposit_received_date: depositDate, final_received_amount_vnd: finalAmount,
      final_received_date: finalDate, withdrawal_amount_vnd: withdrawalAmount,
      withdrawal_date: withdrawalDate, customer_type: customerType,
      note: nullableText(byId("note").value)
    };
  }


  function filteredRows() {
    const query = clean(byId("searchInput").value).toLocaleLowerCase();
    const from = byId("filterFrom").value;
    const to = byId("filterTo").value;
    return state.rows.filter((row) => {
      if (state.statusFilter === "receivable") {
        if (row.customer_type !== "company") return false;
      } else if (state.statusFilter !== "all" && row.status !== state.statusFilter) return false;
      if (from && row.golf_date < from) return false;
      if (to && row.golf_date > to) return false;
      if (!query) return true;
      return [row.counterparty_name, row.representative_name, row.player_names_en, row.golf_course, row.note]
        .some((value) => String(value || "").toLocaleLowerCase().includes(query));
    });
  }

  function receivedAmountForBooking(row) {
    const value = row.final_received_amount_vnd == null
      ? row.deposit_amount_vnd
      : row.final_received_amount_vnd;
    return Number(value) || 0;
  }

  function receivableBalanceForBooking(row) {
    if (row.guest_total_vnd == null) return null;
    return Number(row.guest_total_vnd) - receivedAmountForBooking(row);
  }

  function receivableGroups(rows) {
    const groups = new Map();
    for (const row of rows) {
      const name = clean(row.counterparty_name) || "거래처 미입력";
      const key = name.normalize("NFC").toLocaleLowerCase("vi-VN");
      if (!groups.has(key)) {
        groups.set(key, {
          name, bookingCount: 0, expected: 0, received: 0,
          receivable: 0, unsetExpected: 0, unpricedReceived: 0, bookings: []
        });
      }
      const group = groups.get(key);
      const received = receivedAmountForBooking(row);
      const balance = receivableBalanceForBooking(row);
      group.bookingCount += 1;
      group.bookings.push({ row, received, balance });
      if (balance == null) {
        group.unsetExpected += 1;
        group.unpricedReceived += received;
      } else {
        group.expected += Number(row.guest_total_vnd) || 0;
        group.received += received;
        group.receivable += balance;
      }
    }
    for (const group of groups.values()) {
      group.bookings.sort((a, b) =>
        `${a.row.golf_date} ${a.row.golf_time} ${a.row.id}`
          .localeCompare(`${b.row.golf_date} ${b.row.golf_time} ${b.row.id}`)
      );
    }
    return [...groups.values()]
      .sort((a, b) => b.receivable - a.receivable || a.name.localeCompare(b.name));
  }

  function renderReceivableBooking(item) {
    const row = item.row;
    const statusLabel = row.status === "completed" ? "완료 / Hoàn tất" : "진행중 / Đang xử lý";
    const balanceLabel = item.balance == null
      ? '<span class="golf-receivable-warning">금액 미설정 / Chưa đặt giá</span>'
      : `<strong>${escape(moneyLabel(item.balance))}</strong>`;
    return `<tr>
      <td>${escape(golfDateLabel(row.golf_date))} ${escape(timeLabel(row.golf_time))}</td>
      <td><strong>${escape(row.representative_name || "—")}</strong><span class="golf-receivable-warning">${escape(statusLabel)}</span></td>
      <td>${escape(moneyLabel(row.guest_total_vnd))}</td>
      <td>${escape(moneyLabel(item.received))}</td>
      <td>${balanceLabel}</td>
    </tr>`;
  }

  function renderReceivables(rows) {
    const groups = receivableGroups(rows);
    const totals = groups.reduce((sum, group) => ({
      expected: sum.expected + group.expected,
      received: sum.received + group.received,
      receivable: sum.receivable + group.receivable,
      unsetExpected: sum.unsetExpected + group.unsetExpected,
      unpricedReceived: sum.unpricedReceived + group.unpricedReceived
    }), { expected: 0, received: 0, receivable: 0, unsetExpected: 0, unpricedReceived: 0 });
    byId("listCount").textContent =
      `${groups.length.toLocaleString("ko-KR")}개 거래처 · ${rows.length.toLocaleString("ko-KR")}건`;
    byId("receivablePanel").innerHTML = groups.length ? `
      <div class="golf-receivable-total">
        <div><span>원래 받을 금액 / Phải thu</span><strong>${escape(moneyLabel(totals.expected))}</strong></div>
        <div><span>현재 받은 금액 / Đã nhận</span><strong>${escape(moneyLabel(totals.received))}</strong></div>
        <div><span>미수금 잔액 / Công nợ ròng</span><strong>${escape(moneyLabel(totals.receivable))}</strong>
          ${totals.unsetExpected ? `<span class="golf-receivable-warning">금액 미설정 ${escape(totals.unsetExpected)}건 · 별도 수령 ${escape(moneyLabel(totals.unpricedReceived))}</span>` : ""}</div>
      </div>
      <div class="golf-receivable-note">음수 금액은 초과 수령입니다. 업체별·전체 금액은 자동으로 상계됩니다. / Số âm là khoản thu vượt và được tự động bù trừ.</div>
      <div class="golf-receivable-table-wrap"><table class="golf-receivable-table">
        <thead><tr><th>거래처 / Đối tác</th><th>예약 / Đặt sân</th><th>원래 받을 금액 / Phải thu</th><th>받은 금액 / Đã nhận</th><th>미수금 잔액 / Công nợ ròng</th></tr></thead>
        <tbody>${groups.map((group) => `
          <tr><td><strong>${escape(group.name)}</strong>
            ${group.unsetExpected ? `<span class="golf-receivable-warning">금액 미설정 ${escape(group.unsetExpected)}건 · 별도 수령 ${escape(moneyLabel(group.unpricedReceived))}</span>` : ""}</td>
            <td>${escape(group.bookingCount)}건</td><td>${escape(moneyLabel(group.expected))}</td>
            <td>${escape(moneyLabel(group.received))}</td><td><strong>${escape(moneyLabel(group.receivable))}</strong></td></tr>
          <tr class="golf-receivable-detail-row"><td colspan="5">
            <details class="golf-receivable-detail">
              <summary>${escape(group.bookingCount)}건 건당 미수금 보기 / Xem công nợ từng đặt sân</summary>
              <div class="golf-receivable-table-wrap"><table class="golf-receivable-table">
                <thead><tr><th>골프 날짜 / Ngày chơi</th><th>예약자 / Khách</th><th>원래 받을 금액 / Phải thu</th><th>받은 금액 / Đã nhận</th><th>건당 미수금 / Công nợ</th></tr></thead>
                <tbody>${group.bookings.map(renderReceivableBooking).join("")}</tbody>
              </table></div>
            </details>
          </td></tr>`).join("")}</tbody>
      </table></div>` : '<div class="qr-empty">선택한 기간에 회사 거래처의 미수금 내역이 없습니다.<br />Không có công nợ công ty trong khoảng thời gian đã chọn.</div>';
  }

  function renderRow(row) {
    const completed = row.status === "completed";
    const statusLabel = completed ? "완료 / Hoàn tất" : "진행중 / Đang xử lý";
    const customerLabel = row.customer_type === "company" ? "회사 / Công ty" : "개인 / Cá nhân";
    const actualProfit = row.final_received_amount_vnd == null ? null
      : Number(row.final_received_amount_vnd) - Number(row.withdrawal_amount_vnd || 0);
    return `
      <article class="golf-row" data-status="${escape(row.status)}">
        <div class="golf-row-head">
          <div><div class="golf-row-title">${escape(row.representative_name)}</div>
          <div class="golf-row-sub">거래처 ${escape(row.counterparty_name || "—")} · ${escape(row.golf_course)} · ${escape(row.holes)}H · ${escape(row.pax)}명 · ${escape(customerLabel)}</div></div>
          <span class="qr-status" data-tone="${completed ? "ready" : "working"}">${escape(statusLabel)}</span>
        </div>
        <div class="golf-row-body">
          <div class="golf-detail-grid">
            <div class="golf-detail"><span>등록 일시 / Thời gian tạo</span><strong>${escape(dateTimeLabel(row.created_at))}</strong></div>
            <div class="golf-detail"><span>골프 / Ngày chơi</span><strong>${escape(golfDateLabel(row.golf_date))} ${escape(timeLabel(row.golf_time))}</strong></div>

            <div class="golf-detail"><span>1인 판매가 / Giá khách mỗi người</span><strong>${escape(moneyLabel(row.guest_unit_price_vnd))}</strong></div>
            <div class="golf-detail"><span>고객 합계 / Tổng tiền khách</span><strong>${escape(moneyLabel(row.guest_total_vnd))}</strong></div>
            <div class="golf-detail"><span>1인 골프장 원가 / Giá sân mỗi người</span><strong>${escape(moneyLabel(row.course_unit_price_vnd))}</strong></div>
            <div class="golf-detail"><span>골프장 합계 / Tổng tiền sân</span><strong>${escape(moneyLabel(row.course_total_vnd))}</strong></div>
            <div class="golf-detail"><span>S-CART</span><strong>${escape(row.smart_cart_note || "—")}</strong></div>
            <div class="golf-detail"><span>예약금 / Tiền cọc</span><strong>${escape(moneyLabel(row.deposit_amount_vnd))}\n${escape(dateLabel(row.deposit_received_date))}</strong></div>
            <div class="golf-detail"><span>최종 총입금 / Tổng đã nhận</span><strong>${escape(moneyLabel(row.final_received_amount_vnd))}\n${escape(dateLabel(row.final_received_date))}</strong></div>
            <div class="golf-detail"><span>출금 / Tiền chi</span><strong>${escape(moneyLabel(row.withdrawal_amount_vnd))}\n${escape(dateLabel(row.withdrawal_date))}</strong></div>
            <div class="golf-detail"><span>실제 수익 / Lợi nhuận</span><strong>${escape(moneyLabel(actualProfit))}</strong></div>
          </div>
          <div class="golf-row-names"><strong>영문 명단 / Danh sách tên tiếng Anh</strong>\n${escape(row.player_names_en)}</div>
          ${row.note ? `<div class="golf-row-note"><strong>비고 / Ghi chú:</strong> ${escape(row.note)}</div>` : ""}
        </div>
        <div class="golf-row-actions">
          <button class="qr-btn qr-btn-small" type="button" data-action="edit" data-id="${escape(row.id)}">${completed ? "수정 / Chỉnh sửa" : "수정·잔금 입력 / Sửa·nhập số dư"}</button>
          <button class="qr-btn qr-btn-small qr-btn-danger" type="button" data-action="delete" data-id="${escape(row.id)}">삭제 / Xóa</button>
        </div>
      </article>`;
  }

  function render() {
    const rows = filteredRows();
    const receivableMode = state.statusFilter === "receivable";
    byId("receivablePanel").hidden = !receivableMode;
    byId("reservationList").hidden = receivableMode;
    if (receivableMode) {
      renderReceivables(rows);
      return;
    }
    byId("listCount").textContent = `${rows.length.toLocaleString("ko-KR")}건 / mục`;
    byId("reservationList").innerHTML = rows.length ? rows.map(renderRow).join("")
      : '<div class="qr-empty">조건에 맞는 골프 예약이 없습니다.<br />Không có đặt sân phù hợp.</div>';
  }

  async function loadRows(options = {}) {
    QRStaff.connectionBadge("connecting", "불러오는 중");
    try {
      state.rows = await DGV.collectSupabasePages(
        () => sb.from("golf_reservations").select(COLUMNS),
        { pageSize: 500, order: [
          { column: "golf_date", ascending: true }, { column: "golf_time", ascending: true },
          { column: "id", ascending: true }
        ] }
      );
      state.rows.sort((a, b) => {
        const statusOrder = Number(a.status === "completed") - Number(b.status === "completed");
        if (statusOrder) return statusOrder;
        return `${a.golf_date} ${a.golf_time} ${a.id}`
          .localeCompare(`${b.golf_date} ${b.golf_time} ${b.id}`);
      });
      render();
      QRStaff.connectionBadge("online", "연결됨");
      if (!options.quiet) setBanner("골프 예약 정보를 불러왔습니다.", "ok");
      return true;
    } catch (error) {
      console.error(error);
      QRStaff.connectionBadge("offline", "연결 오류");
      setBanner(QRStaff.messageOf(error, "골프 예약을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요."), "error");
      return false;
    }
  }

  async function save(event) {
    event.preventDefault();
    if (state.saving) return;
    let payload;
    try { payload = payloadFromForm(); }
    catch (error) { QRStaff.toast(error.message, "error"); return; }
    const id = byId("recordId").value;
    state.saving = true;
    QRStaff.setBusy(byId("saveButton"), true, "저장 중…");
    try {
      const request = id
        ? sb.from("golf_reservations").update(payload).eq("id", id).select("id,status").single()
        : sb.from("golf_reservations").insert([payload]).select("id,status").single();
      const { error } = await request;
      if (error) throw error;
      QRStaff.toast(id ? "골프 예약을 수정했습니다." : "골프 예약을 등록했습니다.", "ok");
      resetForm({ focus: false });
      await loadRows({ quiet: true });
    } catch (error) {
      console.error(error);
      QRStaff.toast(QRStaff.messageOf(error, "골프 예약을 저장하지 못했습니다. 입력 내용을 확인해 주세요."), "error");
    } finally {
      state.saving = false;
      QRStaff.setBusy(byId("saveButton"), false);
      byId("saveButton").textContent = byId("recordId").value ? "변경 저장 / Lưu thay đổi" : "예약 저장 / Lưu đặt chỗ";
    }
  }

  async function removeRow(row) {
    if (!global.confirm(`${row.representative_name} 예약을 삭제합니다. 삭제한 기록은 복구할 수 없습니다.\n\nBạn có chắc muốn xóa đặt sân này không?`)) return;
    try {
      const { data, error } = await sb.from("golf_reservations").delete().eq("id", row.id).select("id").single();
      if (error) throw error;
      if (!data?.id) throw new Error("삭제할 예약을 찾지 못했습니다.");
      if (byId("recordId").value === row.id) resetForm({ focus: false });
      QRStaff.toast("골프 예약을 삭제했습니다.", "ok");
      await loadRows({ quiet: true });
    } catch (error) {
      console.error(error);
      QRStaff.toast(QRStaff.messageOf(error, "골프 예약을 삭제하지 못했습니다. 다시 시도해 주세요."), "error");
    }
  }

  function rowById(id) { return state.rows.find((row) => row.id === id) || null; }

  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  function openRequestedEdit() {
    const params = new URLSearchParams(global.location.search);
    if (!params.has("edit")) return;
    const rawId = clean(params.get("edit"));
    params.delete("edit");
    const query = params.toString();
    const nextUrl = `${global.location.pathname}${query ? `?${query}` : ""}${global.location.hash}`;
    global.history.replaceState(null, "", nextUrl);
    if (!UUID_PATTERN.test(rawId)) {
      QRStaff.toast("선택한 예약을 찾지 못했습니다. 목록에서 다시 선택해 주세요.", "error");
      return;
    }
    const row = rowById(rawId);
    if (!row) {
      QRStaff.toast("선택한 예약을 찾지 못했습니다. 목록에서 다시 선택해 주세요.", "error");
      return;
    }
    fillForm(row, { focusFinal: false });
  }

  function bindEvents() {
    byId("reservationForm").addEventListener("submit", save);
    byId("resetButton").addEventListener("click", () => resetForm());
    byId("cancelEditButton").addEventListener("click", () => resetForm());
    byId("clearFiltersButton").addEventListener("click", () => {
      byId("searchInput").value = ""; byId("filterFrom").value = ""; byId("filterTo").value = ""; render();
    });
    for (const input of document.querySelectorAll(".golf-money-input")) {
      input.addEventListener("input", () => { formatMoneyInput(input); updatePreview(); });
      input.addEventListener("blur", () => formatMoneyInput(input));
    }
    byId("pax").addEventListener("input", updatePreview);
    byId("counterpartyName").addEventListener("input", syncCustomerType);
    byId("playerNamesEn").addEventListener("input", () => {
      const count = namesCount(byId("playerNamesEn").value);
      if (count) byId("pax").value = String(count);
      byId("representativeName").value = firstPlayerName(byId("playerNamesEn").value);
      updatePreview();
    });
    byId("finalDate").addEventListener("change", updatePreview);
    for (const button of document.querySelectorAll("[data-status-filter]")) {
      button.addEventListener("click", () => {
        state.statusFilter = button.dataset.statusFilter;
        for (const candidate of document.querySelectorAll("[data-status-filter]")) candidate.setAttribute("aria-pressed", String(candidate === button));
        render();
      });
    }
    for (const id of ["searchInput", "filterFrom", "filterTo"]) byId(id).addEventListener(id === "searchInput" ? "input" : "change", render);
    byId("reservationList").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action][data-id]");
      if (!button) return;
      const row = rowById(button.dataset.id);
      if (!row) { QRStaff.toast("선택한 예약을 찾지 못했습니다. 목록을 새로고침해 주세요.", "error"); return; }
      if (button.dataset.action === "edit") fillForm(row, { focusFinal: row.status === "in_progress" });
      if (button.dataset.action === "delete") removeRow(row);
    });
  }

  async function init() {
    bindEvents();
    resetForm({ focus: false });
    try {
      state.identity = await QRStaff.requireLogin({ roles: ["manager", "admin"], preferredRole: "manager" });
      document.body.classList.remove("locked");
      const loaded = await loadRows({ quiet: true });
      if (loaded) openRequestedEdit();
    } catch (error) {
      console.error(error);
      QRStaff.connectionBadge("offline", "로그인 오류");
      setBanner("로그인 화면을 불러오지 못했습니다. 페이지를 새로고침해 주세요.", "error");
    }
  }

  init();
})(window);
