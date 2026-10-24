(function initGolfBudgetPage(global) {
  "use strict";

  if (!global.DGV || !global.QRStaff) throw new Error("Golf budget dependencies are missing.");

  const DGV = global.DGV;
  const QRStaff = global.QRStaff;
  const sb = DGV.supabase;
  const TIME_ZONE = "Asia/Ho_Chi_Minh";
  const COURSES = ["AT1200", "SAM", "PALACE"];
  const PAYMENT_METHODS = new Set(["bank", "cash", "card"]);
  const CASH_BANK_THRESHOLD = 5000000;
  const MAX_SAFE_MONEY = 9007199254740991;
  const state = { identity: null, accounts: [], deposits: [], charges: [], pendingReservations: [], chargeCourse: "all", selectedMonth: null, saving: false };
  const byId = (id) => document.getElementById(id);
  const escape = (value) => DGV.escapeHTML(value ?? "");
  const clean = (value) => String(value ?? "").trim();
  const todayYmd = () => DGV.formatYmdInTimeZone(new Date(), TIME_ZONE);
  const currentMonthKey = () => todayYmd().slice(0, 7);

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

  function dateLabel(value) {
    const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return match ? `${match[1]}. ${match[2]}. ${match[3]}` : "—";
  }

  function dateTimeLabel(value) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat("ko-KR", {
      timeZone: TIME_ZONE,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false
    }).format(date);
  }

  function dateTimeMonthKey(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: TIME_ZONE,
      year: "numeric",
      month: "2-digit"
    }).formatToParts(date);
    const year = parts.find((part) => part.type === "year")?.value;
    const month = parts.find((part) => part.type === "month")?.value;
    return year && month ? `${year}-${month}` : "";
  }

  function periodLabel() {
    if (state.selectedMonth === "all") return "전체 기간 / Toàn bộ";
    const match = String(state.selectedMonth || "").match(/^(\d{4})-(\d{2})$/);
    return match ? `${match[1]}년 ${Number(match[2])}월 / Tháng ${Number(match[2])}/${match[1]}` : "—";
  }

  function depositInSelectedPeriod(deposit) {
    return state.selectedMonth === "all" || String(deposit?.deposit_date || "").slice(0, 7) === state.selectedMonth;
  }

  function chargePostedInSelectedPeriod(charge) {
    return state.selectedMonth === "all" || dateTimeMonthKey(charge?.charged_at) === state.selectedMonth;
  }

  function chargeRestoredInSelectedPeriod(charge) {
    return Boolean(charge?.reversed_at)
      && (state.selectedMonth === "all" || dateTimeMonthKey(charge.reversed_at) === state.selectedMonth);
  }

  function chargeTouchesSelectedPeriod(charge) {
    return chargePostedInSelectedPeriod(charge) || chargeRestoredInSelectedPeriod(charge);
  }

  function paymentMethodLabel(value) {
    return value === "bank" ? "은행 / Chuyển khoản"
      : value === "cash" ? "현금 / Tiền mặt"
      : value === "card" ? "카드 / Thẻ"
      : "—";
  }

  function setBanner(message, tone = "info") {
    const banner = byId("pageBanner");
    banner.textContent = message;
    banner.dataset.tone = tone;
  }

  function cashLimitMessage() {
    return "5,000,000 VND 이상은 은행 거래가 필요합니다. / Giao dịch từ 5.000.000 VND phải chuyển khoản ngân hàng.";
  }

  function accountFor(course) {
    return state.accounts.find((account) => account.golf_course === course) || null;
  }

  function depositTotal(course) {
    return state.deposits
      .filter((deposit) => deposit.golf_course === course)
      .reduce((total, deposit) => total + Number(deposit.amount_vnd || 0), 0);
  }

  function chargeTotal(course) {
    return state.charges
      .filter((charge) => charge.golf_course === course && charge.active !== false)
      .reduce((total, charge) => total + Number(charge.amount_vnd || 0), 0);
  }

  function expectedPaymentStats(course = null) {
    const rows = state.pendingReservations.filter((row) => !course || row.golf_course === course);
    return {
      count: rows.length,
      missing: rows.filter((row) => row.course_total_vnd == null).length,
      amount: rows.reduce((total, row) => total + Number(row.course_total_vnd || 0), 0)
    };
  }

  function courseBalance(course) {
    const opening = Number(accountFor(course)?.opening_balance_vnd || 0);
    return opening + depositTotal(course) - chargeTotal(course);
  }

  function renderSummary() {
    const opening = COURSES.reduce((total, course) => total + Number(accountFor(course)?.opening_balance_vnd || 0), 0);
    const deposits = COURSES.reduce((total, course) => total + depositTotal(course), 0);
    const charges = COURSES.reduce((total, course) => total + chargeTotal(course), 0);
    const balance = opening + deposits - charges;
    const expected = expectedPaymentStats();
    byId("summaryOpening").textContent = moneyLabel(opening);
    byId("summaryDeposits").textContent = moneyLabel(deposits);
    byId("summaryCharges").textContent = moneyLabel(charges);
    byId("summaryBalance").textContent = moneyLabel(balance);
    byId("summaryExpectedCharges").textContent = moneyLabel(expected.amount);
    byId("summaryExpectedMeta").textContent = `진행중 ${expected.count.toLocaleString("ko-KR")}건${expected.missing ? ` · 원가 미입력 ${expected.missing.toLocaleString("ko-KR")}건` : ""}`;
  }

  function renderPeriodSummary() {
    const deposits = state.deposits
      .filter(depositInSelectedPeriod)
      .reduce((total, deposit) => total + Number(deposit.amount_vnd || 0), 0);
    const charges = state.charges
      .filter(chargePostedInSelectedPeriod)
      .reduce((total, charge) => total + Number(charge.amount_vnd || 0), 0);
    const restorations = state.charges
      .filter(chargeRestoredInSelectedPeriod)
      .reduce((total, charge) => total + Number(charge.amount_vnd || 0), 0);
    byId("periodDeposits").textContent = moneyLabel(deposits);
    byId("periodCharges").textContent = moneyLabel(charges);
    byId("periodRestorations").textContent = moneyLabel(restorations);
    byId("periodNet").textContent = moneyLabel(deposits - charges + restorations);
    byId("monthStatus").textContent = `현재 조회: ${periodLabel()}`;
    byId("allMonthsButton").classList.toggle("is-active", state.selectedMonth === "all");
    byId("allMonthsButton").setAttribute("aria-pressed", String(state.selectedMonth === "all"));
  }

  function renderCourseCards() {
    byId("courseCards").innerHTML = COURSES.map((course) => {
      const account = accountFor(course);
      const opening = Number(account?.opening_balance_vnd || 0);
      const deposits = depositTotal(course);
      const charges = chargeTotal(course);
      const balance = opening + deposits - charges;
      const expected = expectedPaymentStats(course);
      return `<article class="budget-course-card${balance < 0 ? " is-negative" : ""}" data-course-card="${escape(course)}">
        <h3 class="budget-course-name">${escape(course)}</h3>
        <div class="budget-balance-pair">
          <div class="budget-balance-box">
            <span class="budget-current-label">완료 반영 현재 잔액 / Số dư sau hoàn tất</span>
            <strong class="budget-current${balance < 0 ? " is-negative" : ""}">${escape(moneyLabel(balance))}</strong>
          </div>
          <div class="budget-balance-box">
            <span class="budget-current-label">추가 예상 결제금액 / Thanh toán dự kiến thêm</span>
            <strong class="budget-expected">${escape(moneyLabel(expected.amount))}</strong>
            <div class="budget-expected-meta">진행중 ${escape(expected.count.toLocaleString("ko-KR"))}건${expected.missing ? ` · 원가 미입력 ${escape(expected.missing.toLocaleString("ko-KR"))}건` : ""}</div>
          </div>
        </div>
        <div class="budget-breakdown">
          <div><span>기준 잔액 / Đầu kỳ</span><strong>${escape(moneyLabel(opening))}</strong></div>
          <div><span>골프장 결제 / Thanh toán sân</span><strong>+${escape(moneyLabel(deposits))}</strong></div>
          <div><span>완료 예약 차감 / Đã trừ</span><strong>−${escape(moneyLabel(charges))}</strong></div>
        </div>
        <div class="budget-opening-edit">
          <label class="qr-field"><span class="qr-label">기준 잔액 (VND) / Số dư đầu kỳ</span><input class="qr-input budget-opening-amount" type="text" inputmode="numeric" autocomplete="off" value="${escape(opening.toLocaleString("ko-KR"))}" /></label>
          <div class="qr-field"><span class="qr-label">고정 기준일 / Ngày chốt cố định</span><div class="budget-basis-date">${escape(dateLabel(account?.balance_as_of))}</div></div>
          <button class="qr-btn qr-btn-small" type="button" data-save-account="${escape(course)}">기준 잔액 저장<br />Lưu số dư</button>
        </div>
        <button class="qr-btn qr-btn-small budget-detail-button" type="button" data-show-charge-course="${escape(course)}">차감 상세보기 / Xem chi tiết khấu trừ</button>
      </article>`;
    }).join("");
  }

  function filteredDeposits() {
    return state.deposits.filter(depositInSelectedPeriod);
  }

  function renderDeposits() {
    const deposits = filteredDeposits();
    byId("depositCount").textContent = `${periodLabel()} · ${deposits.length.toLocaleString("ko-KR")}건 / mục`;
    byId("depositTableBody").innerHTML = deposits.length
      ? deposits.map((deposit) => `<tr>
        <td>${escape(dateLabel(deposit.deposit_date))}</td>
        <td><strong>${escape(deposit.golf_course)}</strong></td>
        <td>${escape(paymentMethodLabel(deposit.payment_method))}</td>
        <td class="budget-money"><strong>${escape(moneyLabel(deposit.amount_vnd))}</strong></td>
        <td class="budget-note">${escape(deposit.note || "—")}</td>
        <td><div class="budget-actions">
          <button class="qr-btn qr-btn-small" type="button" data-edit-deposit="${escape(deposit.id)}">수정 / Sửa</button>
          <button class="qr-btn qr-btn-small qr-btn-danger" type="button" data-delete-deposit="${escape(deposit.id)}">삭제 / Xóa</button>
        </div></td>
      </tr>`).join("")
      : `<tr><td class="budget-empty" colspan="6">${escape(periodLabel())} 골프장 결제 내역이 없습니다.<br />Không có lịch sử thanh toán sân golf trong kỳ này.</td></tr>`;
  }

  function depositTotalOf(rows) {
    return rows.reduce((total, row) => total + Number(row.amount_vnd || 0), 0);
  }

  function printDeposits() {
    const rows = filteredDeposits();
    if (!rows.length) {
      QRStaff.toast("출력할 골프장 결제 내역이 없습니다. / Không có thanh toán sân golf để in.", "error");
      return;
    }
    byId("printDepositCriteria").textContent = `조회 기간 / Kỳ tra cứu: ${periodLabel()}`;
    byId("printDepositGeneratedAt").textContent = `출력 일시 / Thời gian in: ${new Date().toLocaleString("ko-KR", { timeZone: TIME_ZONE })}`;
    byId("printDepositTotal").textContent = `합계 / Tổng cộng: ${moneyLabel(depositTotalOf(rows))}`;
    document.body.classList.add("print-budget-payments");
    const cleanup = () => document.body.classList.remove("print-budget-payments");
    global.addEventListener("afterprint", cleanup, { once: true });
    const startPrint = () => global.print();
    if (typeof global.requestAnimationFrame === "function") global.requestAnimationFrame(startPrint);
    else startPrint();
  }

  function depositWorkbookOptions(rows) {
    const textCell = (value, style = "normal") => ({ value: String(value ?? ""), style });
    const integerCell = (value, style = "integer") => {
      const number = Number(value ?? 0);
      if (!Number.isFinite(number)) throw new Error("Invalid golf-course payment amount");
      return { value: number, style };
    };
    const generatedAt = new Date().toLocaleString("ko-KR", { timeZone: TIME_ZONE });
    const headers = [
      "결제 날짜 / Ngày thanh toán",
      "골프장 / Sân golf",
      "결제 수단 / Phương thức",
      "결제 금액(VND) / Số tiền",
      "비고 / Ghi chú"
    ];
    const dataRows = rows.map((row) => [
      textCell(row.deposit_date),
      textCell(row.golf_course),
      textCell(paymentMethodLabel(row.payment_method)),
      integerCell(row.amount_vnd),
      textCell(row.note, "wrapped")
    ]);
    const total = depositTotalOf(rows);
    const filePeriod = state.selectedMonth === "all" ? "ALL" : state.selectedMonth;
    return {
      filename: `HANA_Golf_Course_Payments_${filePeriod}.xlsx`,
      sheets: [{
        name: "골프장 결제",
        rows: [
          [textCell("HANA 골프장 결제 내역 / Lịch sử thanh toán sân golf", "title"), "", "", "", ""],
          [textCell("조회 기간 / Kỳ tra cứu"), textCell(periodLabel()), "", "", ""],
          [textCell("생성 일시 / Thời gian xuất"), textCell(generatedAt), "", "", ""],
          [],
          headers.map((label) => textCell(label, "header")),
          ...dataRows,
          ["", "", textCell("합계 / Tổng cộng", "totalLabel"), integerCell(total, "totalNumber"), ""]
        ],
        columnWidths: [18,16,26,23,42],
        merges: ["A1:E1"],
        freezeRows: 5,
        autoFilterRange: `A5:E${Math.max(5, 5 + dataRows.length)}`
      }]
    };
  }

  function exportDeposits() {
    const button = byId("exportDepositButton");
    if (button.disabled) return;
    const originalLabel = button.textContent;
    button.disabled = true;
    button.textContent = "생성 중…";
    try {
      const rows = filteredDeposits();
      if (!rows.length) {
        QRStaff.toast("엑셀로 생성할 골프장 결제 내역이 없습니다. / Không có thanh toán sân golf để xuất Excel.", "error");
        return;
      }
      if (!global.DGV_XLSX?.downloadWorkbook) throw new Error("XLSX exporter is unavailable");
      global.DGV_XLSX.downloadWorkbook(depositWorkbookOptions(rows));
    } catch (error) {
      console.error(error);
      QRStaff.toast("엑셀 파일을 생성하지 못했습니다. 잠시 후 다시 시도해 주세요.", "error");
    } finally {
      button.disabled = false;
      button.textContent = originalLabel;
    }
  }

  function reservationForCharge(charge) {
    const relation = charge?.golf_reservations;
    if (Array.isArray(relation)) return relation[0] || {};
    return relation || {};
  }

  function renderCharges() {
    const periodCharges = state.charges.filter(chargeTouchesSelectedPeriod);
    const charges = state.chargeCourse === "all"
      ? periodCharges
      : periodCharges.filter((charge) => charge.golf_course === state.chargeCourse);
    const filterLabel = state.chargeCourse === "all" ? "전체 / Tất cả" : state.chargeCourse;
    const activeCount = charges.filter((charge) => charge.active !== false).length;
    byId("chargeCount").textContent = `${periodLabel()} · ${filterLabel} · 현재 차감 ${activeCount.toLocaleString("ko-KR")}건 / tổng ${charges.length.toLocaleString("ko-KR")}건`;
    byId("chargeFilters").querySelectorAll("[data-charge-course]").forEach((button) => {
      const active = button.dataset.chargeCourse === state.chargeCourse;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    byId("chargeTableBody").innerHTML = charges.length
      ? charges.map((charge) => {
        const reservation = reservationForCharge(charge);
        const href = `golf_reserv.html?edit=${encodeURIComponent(charge.reservation_id)}`;
        const active = charge.active !== false;
        const statusLabel = !active
          ? "복원됨 / Đã hoàn"
          : charge.historical
            ? "기존 완료·차감 / Đã trừ trước"
            : "차감 중 / Đang trừ";
        return `<tr>
          <td><strong>${statusLabel}</strong></td>
          <td>${escape(dateTimeLabel(charge.charged_at))}</td>
          <td>${escape(dateTimeLabel(charge.reversed_at))}</td>
          <td><strong>${escape(charge.golf_course)}</strong></td>
          <td>${escape(dateLabel(charge.golf_date))}</td>
          <td>${escape(reservation.counterparty_name || "—")}</td>
          <td>${escape(reservation.representative_name || "—")}</td>
          <td class="budget-money"><strong>−${escape(moneyLabel(charge.amount_vnd))}</strong></td>
          <td><a class="budget-edit-link" href="${escape(href)}">예약 보기 / Xem</a></td>
        </tr>`;
      }).join("")
      : `<tr><td class="budget-empty" colspan="9">${escape(periodLabel())} ${escape(filterLabel)} 자동 차감 내역이 없습니다.<br />Không có lịch sử khấu trừ tự động trong kỳ này.</td></tr>`;
  }

  function showChargeCourse(course, options = {}) {
    state.chargeCourse = COURSES.includes(course) ? course : "all";
    renderCharges();
    if (options.scroll) byId("chargeListTitle").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function render() {
    renderSummary();
    renderCourseCards();
    renderPeriodSummary();
    renderDeposits();
    renderCharges();
  }

  function setSelectedMonth(value) {
    state.selectedMonth = /^\d{4}-\d{2}$/.test(String(value || "")) ? value : "all";
    byId("monthFilter").value = state.selectedMonth === "all" ? "" : state.selectedMonth;
    renderPeriodSummary();
    renderDeposits();
    renderCharges();
  }

  function resetDepositForm(options = {}) {
    byId("depositForm").reset();
    byId("depositId").value = "";
    byId("depositDate").value = todayYmd();
    byId("depositCourse").value = "";
    byId("depositMethod").value = "";
    byId("depositFormTitle").textContent = "골프장 결제 / Thanh toán sân golf";
    byId("saveDepositButton").textContent = "결제 저장 / Lưu thanh toán";
    byId("cancelDepositEditButton").hidden = true;
    if (options.focus) byId("depositCourse").focus();
  }

  function fillDepositForm(deposit) {
    byId("depositId").value = deposit.id;
    byId("depositDate").value = deposit.deposit_date || "";
    byId("depositCourse").value = deposit.golf_course || "";
    byId("depositAmount").value = Number(deposit.amount_vnd || 0).toLocaleString("ko-KR");
    byId("depositMethod").value = deposit.payment_method || "";
    byId("depositNote").value = deposit.note || "";
    byId("depositFormTitle").textContent = "골프장 결제 수정 / Sửa thanh toán sân golf";
    byId("saveDepositButton").textContent = "변경 저장 / Lưu thay đổi";
    byId("cancelDepositEditButton").hidden = false;
    byId("depositFormTitle").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function depositPayload() {
    const golfCourse = clean(byId("depositCourse").value);
    const depositDate = byId("depositDate").value;
    const amountVnd = moneyNumber(byId("depositAmount").value);
    const paymentMethod = clean(byId("depositMethod").value);
    const note = clean(byId("depositNote").value);
    if (!COURSES.includes(golfCourse)) throw new Error("골프장을 선택해 주세요. / Vui lòng chọn sân golf.");
    if (!depositDate) throw new Error("결제 날짜를 선택해 주세요. / Vui lòng chọn ngày thanh toán.");
    if (!Number.isSafeInteger(amountVnd) || amountVnd < 1 || amountVnd > MAX_SAFE_MONEY) {
      throw new Error("결제 금액을 올바르게 입력해 주세요. / Vui lòng nhập đúng số tiền thanh toán.");
    }
    if (!PAYMENT_METHODS.has(paymentMethod)) {
      throw new Error("결제 수단을 선택해 주세요. / Vui lòng chọn phương thức thanh toán.");
    }
    if (paymentMethod === "cash" && amountVnd >= CASH_BANK_THRESHOLD) throw new Error(cashLimitMessage());
    return {
      golf_course: golfCourse,
      deposit_date: depositDate,
      amount_vnd: amountVnd,
      payment_method: paymentMethod,
      note: note || null
    };
  }

  async function loadData(options = {}) {
    QRStaff.connectionBadge("connecting", "불러오는 중");
    try {
      const [accounts, deposits, charges, pendingReservations] = await Promise.all([
        DGV.collectSupabasePages(
          () => sb.from("golf_course_budget_accounts").select("golf_course,opening_balance_vnd,balance_as_of,updated_at"),
          { pageSize: 100, order: [{ column: "golf_course", ascending: true }] }
        ),
        DGV.collectSupabasePages(
          () => sb.from("golf_course_budget_deposits").select("id,golf_course,deposit_date,amount_vnd,payment_method,note,created_at,updated_at"),
          { pageSize: 500, order: [
            { column: "deposit_date", ascending: false },
            { column: "created_at", ascending: false },
            { column: "id", ascending: false }
          ] }
        ),
        DGV.collectSupabasePages(
          () => sb.from("golf_course_budget_reservation_charges")
            .select("reservation_id,golf_course,golf_date,amount_vnd,active,historical,charged_at,reversed_at,updated_at,golf_reservations(counterparty_name,representative_name)"),
          { pageSize: 500, order: [
            { column: "charged_at", ascending: false },
            { column: "reservation_id", ascending: false }
          ] }
        ),
        DGV.collectSupabasePages(
          () => sb.from("golf_reservations")
            .select("id,golf_course,status,course_total_vnd")
            .eq("status", "in_progress"),
          { pageSize: 500, order: [
            { column: "golf_course", ascending: true },
            { column: "id", ascending: true }
          ] }
        )
      ]);
      state.accounts = accounts;
      state.deposits = deposits;
      state.charges = charges;
      state.pendingReservations = pendingReservations;
      render();
      QRStaff.connectionBadge("online", "연결됨");
      if (!options.quiet) QRStaff.toast("골프장 예산을 새로 불러왔습니다.", "ok");
      return true;
    } catch (error) {
      console.error(error);
      QRStaff.connectionBadge("offline", "연결 오류");
      setBanner(QRStaff.messageOf(error, "골프장 예산을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요."), "error");
      return false;
    }
  }

  async function saveAccount(course, button) {
    const card = button.closest("[data-course-card]");
    const amount = moneyNumber(card?.querySelector(".budget-opening-amount")?.value);
    if (!Number.isSafeInteger(amount) || amount < 0 || amount > MAX_SAFE_MONEY) {
      QRStaff.toast("기준 잔액을 올바르게 입력해 주세요. / Vui lòng nhập đúng số dư đầu kỳ.", "error");
      return;
    }
    if (!global.confirm(`${course} 기준 잔액을 ${moneyLabel(amount)}으로 변경하시겠습니까?\nBạn có muốn đổi số dư đầu kỳ của ${course} thành ${moneyLabel(amount)} không?`)) return;
    QRStaff.setBusy(button, true, "저장 중…");
    try {
      const { data, error } = await sb.from("golf_course_budget_accounts")
        .update({ opening_balance_vnd: amount })
        .eq("golf_course", course)
        .select("golf_course")
        .single();
      if (error) throw error;
      if (!data?.golf_course) throw new Error("Opening balance was not updated");
      QRStaff.toast("기준 잔액을 수정했습니다. / Đã cập nhật số dư đầu kỳ.", "ok");
      await loadData({ quiet: true });
    } catch (error) {
      console.error(error);
      QRStaff.toast(QRStaff.messageOf(error, "기준 잔액을 수정하지 못했습니다. 다시 시도해 주세요."), "error");
    } finally {
      QRStaff.setBusy(button, false);
    }
  }

  async function saveDeposit(event) {
    event.preventDefault();
    if (state.saving) return;
    let payload;
    try { payload = depositPayload(); }
    catch (error) { QRStaff.toast(error.message, "error"); return; }
    const id = byId("depositId").value;
    state.saving = true;
    QRStaff.setBusy(byId("saveDepositButton"), true, "저장 중…");
    try {
      const request = id
        ? sb.from("golf_course_budget_deposits").update(payload).eq("id", id)
        : sb.from("golf_course_budget_deposits").insert(payload);
      const { data, error } = await request.select("id").single();
      if (error) throw error;
      if (!data?.id) throw new Error("Saved deposit was not returned");
      state.selectedMonth = payload.deposit_date.slice(0, 7);
      byId("monthFilter").value = state.selectedMonth;
      QRStaff.toast(id
        ? "결제 내역을 수정했습니다. / Đã sửa lịch sử thanh toán."
        : "결제 내역을 추가했습니다. / Đã thêm lịch sử thanh toán.", "ok");
      resetDepositForm();
      await loadData({ quiet: true });
    } catch (error) {
      console.error(error);
      QRStaff.toast(QRStaff.messageOf(error, "골프장 결제 내역을 저장하지 못했습니다. 입력 내용을 확인해 주세요."), "error");
    } finally {
      state.saving = false;
      QRStaff.setBusy(byId("saveDepositButton"), false);
      byId("saveDepositButton").textContent = byId("depositId").value ? "변경 저장 / Lưu thay đổi" : "결제 저장 / Lưu thanh toán";
    }
  }

  async function deleteDeposit(deposit) {
    if (!global.confirm(`${deposit.golf_course} ${moneyLabel(deposit.amount_vnd)} 결제 내역을 삭제하시겠습니까?\nBạn có muốn xóa khoản thanh toán ${moneyLabel(deposit.amount_vnd)} của ${deposit.golf_course} không?`)) return;
    try {
      const { data, error } = await sb.from("golf_course_budget_deposits")
        .delete().eq("id", deposit.id).select("id").single();
      if (error) throw error;
      if (!data?.id) throw new Error("Deleted deposit was not returned");
      if (byId("depositId").value === deposit.id) resetDepositForm();
      QRStaff.toast("결제 내역을 삭제했습니다. / Đã xóa khoản thanh toán.", "ok");
      await loadData({ quiet: true });
    } catch (error) {
      console.error(error);
      QRStaff.toast(QRStaff.messageOf(error, "결제 내역을 삭제하지 못했습니다. 다시 시도해 주세요."), "error");
    }
  }

  function bindEvents() {
    byId("reloadButton").addEventListener("click", () => loadData());
    byId("monthFilter").addEventListener("change", (event) => {
      if (event.target.value) setSelectedMonth(event.target.value);
    });
    byId("allMonthsButton").addEventListener("click", () => setSelectedMonth("all"));
    byId("printDepositButton").addEventListener("click", printDeposits);
    byId("exportDepositButton").addEventListener("click", exportDeposits);
    byId("depositForm").addEventListener("submit", saveDeposit);
    byId("cancelDepositEditButton").addEventListener("click", () => resetDepositForm({ focus: true }));
    byId("depositAmount").addEventListener("input", () => formatMoneyInput(byId("depositAmount")));
    byId("depositAmount").addEventListener("blur", () => formatMoneyInput(byId("depositAmount")));
    byId("depositMethod").addEventListener("change", () => {
      if (byId("depositMethod").value === "cash" && Number(moneyNumber(byId("depositAmount").value)) >= CASH_BANK_THRESHOLD) {
        byId("depositMethod").value = "";
        QRStaff.toast(cashLimitMessage(), "error");
      }
    });
    byId("courseCards").addEventListener("input", (event) => {
      if (event.target.matches(".budget-opening-amount")) formatMoneyInput(event.target);
    });
    byId("courseCards").addEventListener("click", (event) => {
      const saveButton = event.target.closest("[data-save-account]");
      if (saveButton) {
        saveAccount(saveButton.dataset.saveAccount, saveButton);
        return;
      }
      const detailButton = event.target.closest("[data-show-charge-course]");
      if (detailButton) showChargeCourse(detailButton.dataset.showChargeCourse, { scroll: true });
    });
    byId("chargeFilters").addEventListener("click", (event) => {
      const button = event.target.closest("[data-charge-course]");
      if (button) showChargeCourse(button.dataset.chargeCourse);
    });
    byId("depositTableBody").addEventListener("click", (event) => {
      const editButton = event.target.closest("[data-edit-deposit]");
      const deleteButton = event.target.closest("[data-delete-deposit]");
      const id = editButton?.dataset.editDeposit || deleteButton?.dataset.deleteDeposit;
      const deposit = state.deposits.find((item) => item.id === id);
      if (!deposit) return;
      if (editButton) fillDepositForm(deposit);
      if (deleteButton) deleteDeposit(deposit);
    });
  }

  async function init() {
    state.selectedMonth = currentMonthKey();
    byId("monthFilter").value = state.selectedMonth;
    bindEvents();
    resetDepositForm();
    try {
      state.identity = await QRStaff.requireLogin({ roles: ["manager", "admin"], preferredRole: "manager" });
      document.body.classList.remove("locked");
      await loadData({ quiet: true });
    } catch (error) {
      console.error(error);
      QRStaff.connectionBadge("offline", "로그인 오류");
      setBanner("관리자 로그인을 불러오지 못했습니다. 페이지를 새로고침해 주세요.", "error");
    }
  }

  init();
})(window);
