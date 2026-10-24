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
  const state = { identity: null, accounts: [], deposits: [], charges: [], chargeCourse: "all", saving: false };
  const byId = (id) => document.getElementById(id);
  const escape = (value) => DGV.escapeHTML(value ?? "");
  const clean = (value) => String(value ?? "").trim();
  const todayYmd = () => DGV.formatYmdInTimeZone(new Date(), TIME_ZONE);

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

  function courseBalance(course) {
    const opening = Number(accountFor(course)?.opening_balance_vnd || 0);
    return opening + depositTotal(course) - chargeTotal(course);
  }

  function renderSummary() {
    const opening = COURSES.reduce((total, course) => total + Number(accountFor(course)?.opening_balance_vnd || 0), 0);
    const deposits = COURSES.reduce((total, course) => total + depositTotal(course), 0);
    const charges = COURSES.reduce((total, course) => total + chargeTotal(course), 0);
    const balance = opening + deposits - charges;
    byId("summaryOpening").textContent = moneyLabel(opening);
    byId("summaryDeposits").textContent = moneyLabel(deposits);
    byId("summaryCharges").textContent = moneyLabel(charges);
    byId("summaryBalance").textContent = moneyLabel(balance);
  }

  function renderCourseCards() {
    byId("courseCards").innerHTML = COURSES.map((course) => {
      const account = accountFor(course);
      const opening = Number(account?.opening_balance_vnd || 0);
      const deposits = depositTotal(course);
      const charges = chargeTotal(course);
      const balance = opening + deposits - charges;
      return `<article class="budget-course-card${balance < 0 ? " is-negative" : ""}" data-course-card="${escape(course)}">
        <h3 class="budget-course-name">${escape(course)}</h3>
        <span class="budget-current-label">현재 잔액 / Số dư hiện tại</span>
        <strong class="budget-current${balance < 0 ? " is-negative" : ""}">${escape(moneyLabel(balance))}</strong>
        <div class="budget-breakdown">
          <div><span>기준 잔액 / Đầu kỳ</span><strong>${escape(moneyLabel(opening))}</strong></div>
          <div><span>직접 충전 / Nạp thêm</span><strong>+${escape(moneyLabel(deposits))}</strong></div>
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

  function renderDeposits() {
    byId("depositCount").textContent = `${state.deposits.length.toLocaleString("ko-KR")}건 / mục`;
    byId("depositTableBody").innerHTML = state.deposits.length
      ? state.deposits.map((deposit) => `<tr>
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
      : '<tr><td class="budget-empty" colspan="6">직접 등록한 골프장 충전 내역이 없습니다.<br />Chưa có khoản nạp sân golf.</td></tr>';
  }

  function reservationForCharge(charge) {
    const relation = charge?.golf_reservations;
    if (Array.isArray(relation)) return relation[0] || {};
    return relation || {};
  }

  function renderCharges() {
    const charges = state.chargeCourse === "all"
      ? state.charges
      : state.charges.filter((charge) => charge.golf_course === state.chargeCourse);
    const filterLabel = state.chargeCourse === "all" ? "전체 / Tất cả" : state.chargeCourse;
    const activeCount = charges.filter((charge) => charge.active !== false).length;
    byId("chargeCount").textContent = `${filterLabel} · 현재 차감 ${activeCount.toLocaleString("ko-KR")}건 / tổng ${charges.length.toLocaleString("ko-KR")}건`;
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
      : `<tr><td class="budget-empty" colspan="9">${escape(filterLabel)} 자동 차감 내역이 없습니다.<br />Không có lịch sử khấu trừ tự động.</td></tr>`;
  }

  function showChargeCourse(course, options = {}) {
    state.chargeCourse = COURSES.includes(course) ? course : "all";
    renderCharges();
    if (options.scroll) byId("chargeListTitle").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function render() {
    renderSummary();
    renderCourseCards();
    renderDeposits();
    renderCharges();
  }

  function resetDepositForm(options = {}) {
    byId("depositForm").reset();
    byId("depositId").value = "";
    byId("depositDate").value = todayYmd();
    byId("depositCourse").value = "";
    byId("depositMethod").value = "";
    byId("depositFormTitle").textContent = "골프장 충전 추가 / Thêm khoản nạp sân";
    byId("saveDepositButton").textContent = "충전 저장 / Lưu khoản nạp";
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
    byId("depositFormTitle").textContent = "골프장 충전 수정 / Sửa khoản nạp sân";
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
    if (!depositDate) throw new Error("입금 날짜를 선택해 주세요. / Vui lòng chọn ngày nạp.");
    if (!Number.isSafeInteger(amountVnd) || amountVnd < 1 || amountVnd > MAX_SAFE_MONEY) {
      throw new Error("충전 금액을 올바르게 입력해 주세요. / Vui lòng nhập đúng số tiền nạp.");
    }
    if (!PAYMENT_METHODS.has(paymentMethod)) {
      throw new Error("입금 수단을 선택해 주세요. / Vui lòng chọn phương thức nạp.");
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
      const [accounts, deposits, charges] = await Promise.all([
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
        )
      ]);
      state.accounts = accounts;
      state.deposits = deposits;
      state.charges = charges;
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
      QRStaff.toast(id ? "충전 내역을 수정했습니다." : "충전 내역을 추가했습니다.", "ok");
      resetDepositForm();
      await loadData({ quiet: true });
    } catch (error) {
      console.error(error);
      QRStaff.toast(QRStaff.messageOf(error, "골프장 충전 내역을 저장하지 못했습니다. 입력 내용을 확인해 주세요."), "error");
    } finally {
      state.saving = false;
      QRStaff.setBusy(byId("saveDepositButton"), false);
      byId("saveDepositButton").textContent = byId("depositId").value ? "변경 저장 / Lưu thay đổi" : "충전 저장 / Lưu khoản nạp";
    }
  }

  async function deleteDeposit(deposit) {
    if (!global.confirm(`${deposit.golf_course} ${moneyLabel(deposit.amount_vnd)} 충전 내역을 삭제하시겠습니까?\nBạn có muốn xóa khoản nạp ${moneyLabel(deposit.amount_vnd)} của ${deposit.golf_course} không?`)) return;
    try {
      const { data, error } = await sb.from("golf_course_budget_deposits")
        .delete().eq("id", deposit.id).select("id").single();
      if (error) throw error;
      if (!data?.id) throw new Error("Deleted deposit was not returned");
      if (byId("depositId").value === deposit.id) resetDepositForm();
      QRStaff.toast("충전 내역을 삭제했습니다. / Đã xóa khoản nạp.", "ok");
      await loadData({ quiet: true });
    } catch (error) {
      console.error(error);
      QRStaff.toast(QRStaff.messageOf(error, "충전 내역을 삭제하지 못했습니다. 다시 시도해 주세요."), "error");
    }
  }

  function bindEvents() {
    byId("reloadButton").addEventListener("click", () => loadData());
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
    bindEvents();
    resetDepositForm();
    try {
      state.identity = await QRStaff.requireLogin({ roles: ["admin"], preferredRole: "admin" });
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
