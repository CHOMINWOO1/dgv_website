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
    "id", "representative_name", "player_names_en", "pax",
    "coordinator_name", "booking_date", "golf_date", "golf_time",
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

  function setBanner(message, tone = "info") {
    const banner = byId("pageBanner");
    banner.textContent = message;
    banner.dataset.tone = tone;
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
    byId("customerType").value = "individual";
    byId("formTitle").textContent = "새 골프 예약 / Đặt sân mới";
    byId("editingHint").textContent = "예약금(0 VND 가능)과 날짜를 입력해 진행중 예약을 등록합니다. / Có thể nhập tiền cọc 0 VND.";
    byId("saveButton").textContent = "예약 저장 / Lưu đặt chỗ";
    byId("cancelEditButton").hidden = true;
    updatePreview();
    if (options.focus !== false) byId("representativeName").focus();
  }

  function fillForm(row, options = {}) {
    byId("recordId").value = row.id;
    byId("representativeName").value = row.representative_name || "";
    byId("playerNamesEn").value = row.player_names_en || "";
    byId("pax").value = row.pax || "";
    byId("customerType").value = row.customer_type || "individual";
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
    const representativeName = clean(byId("representativeName").value);
    const playerNamesEn = clean(byId("playerNamesEn").value)
      .split(/[\n,;]+/).map((name) => name.trim()).filter(Boolean).join("\n");
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

    if (!representativeName) throw new Error("예약자 대표를 입력해 주세요.");
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
    if (!new Set(["individual", "company"]).has(byId("customerType").value)) throw new Error("개인 또는 회사를 선택해 주세요.");

    return {
      representative_name: representativeName, player_names_en: playerNamesEn, pax,
      golf_date: golfDate, golf_time: golfTime, golf_course: golfCourse, holes,
      guest_unit_price_vnd: guestUnit, smart_cart_note: nullableText(byId("smartCartNote").value),
      course_unit_price_vnd: courseUnit, deposit_amount_vnd: depositAmount,
      deposit_received_date: depositDate, final_received_amount_vnd: finalAmount,
      final_received_date: finalDate, withdrawal_amount_vnd: withdrawalAmount,
      withdrawal_date: withdrawalDate, customer_type: byId("customerType").value,
      note: nullableText(byId("note").value)
    };
  }

  function summary() {
    const progress = state.rows.filter((row) => row.status === "in_progress").length;
    const completed = state.rows.filter((row) => row.status === "completed").length;
    const deposit = state.rows.reduce((total, row) => total + Number(row.deposit_amount_vnd || 0), 0);
    const profit = state.rows.reduce((total, row) => row.final_received_amount_vnd == null
      ? total
      : total + Number(row.final_received_amount_vnd || 0) - Number(row.withdrawal_amount_vnd || 0), 0);
    byId("summaryProgress").textContent = progress.toLocaleString("ko-KR");
    byId("summaryCompleted").textContent = completed.toLocaleString("ko-KR");
    byId("summaryDeposit").textContent = moneyLabel(deposit);
    byId("summaryProfit").textContent = moneyLabel(profit);
  }

  function filteredRows() {
    const query = clean(byId("searchInput").value).toLocaleLowerCase();
    const from = byId("filterFrom").value;
    const to = byId("filterTo").value;
    return state.rows.filter((row) => {
      if (state.statusFilter !== "all" && row.status !== state.statusFilter) return false;
      if (from && row.golf_date < from) return false;
      if (to && row.golf_date > to) return false;
      if (!query) return true;
      return [row.representative_name, row.player_names_en, row.golf_course, row.coordinator_name, row.note]
        .some((value) => String(value || "").toLocaleLowerCase().includes(query));
    });
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
          <div class="golf-row-sub">${escape(row.golf_course)} · ${escape(row.holes)}H · ${escape(row.pax)}명 · ${escape(customerLabel)}</div></div>
          <span class="qr-status" data-tone="${completed ? "ready" : "working"}">${escape(statusLabel)}</span>
        </div>
        <div class="golf-row-body">
          <div class="golf-detail-grid">
            <div class="golf-detail"><span>등록 일시 / Thời gian tạo</span><strong>${escape(dateTimeLabel(row.created_at))}</strong></div>
            <div class="golf-detail"><span>골프 / Ngày chơi</span><strong>${escape(dateLabel(row.golf_date))} ${escape(timeLabel(row.golf_time))}</strong></div>
            <div class="golf-detail"><span>담당자 / Phụ trách</span><strong>${escape(row.coordinator_name || "—")}</strong></div>
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
    summary();
    const rows = filteredRows();
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
    } catch (error) {
      console.error(error);
      QRStaff.connectionBadge("offline", "연결 오류");
      setBanner(QRStaff.messageOf(error, "골프 예약을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요."), "error");
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

  function bindEvents() {
    byId("reservationForm").addEventListener("submit", save);
    byId("resetButton").addEventListener("click", () => resetForm());
    byId("cancelEditButton").addEventListener("click", () => resetForm());
    byId("reloadButton").addEventListener("click", () => loadRows());
    byId("clearFiltersButton").addEventListener("click", () => {
      byId("searchInput").value = ""; byId("filterFrom").value = ""; byId("filterTo").value = ""; render();
    });
    for (const input of document.querySelectorAll(".golf-money-input")) {
      input.addEventListener("input", () => { formatMoneyInput(input); updatePreview(); });
      input.addEventListener("blur", () => formatMoneyInput(input));
    }
    byId("pax").addEventListener("input", updatePreview);
    byId("playerNamesEn").addEventListener("input", () => {
      const count = namesCount(byId("playerNamesEn").value);
      if (count) byId("pax").value = String(count);
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

