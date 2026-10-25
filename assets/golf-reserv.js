(function initGolfReservationPage(global) {
  "use strict";

  if (!global.DGV || !global.QRStaff) throw new Error("Golf reservation dependencies are missing.");

  const DGV = global.DGV;
  const QRStaff = global.QRStaff;
  const sb = DGV.supabase;
  const TIME_ZONE = "Asia/Ho_Chi_Minh";
  const MAX_SAFE_MONEY = 9007199254740991;
  const MAX_SMART_CART_AMOUNT = 1000000000;
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const GOLF_COURSES = new Set(["AT1200", "SAM", "PALACE"]);
  const STANDARD_HOLES = new Set([9, 18, 27, 26]);
  const PAYMENT_KINDS = new Set(["deposit", "receipt", "withdrawal"]);
  const VISIBLE_PAYMENT_KINDS = ["deposit", "receipt"];
  const PAYMENT_METHODS = new Set(["bank", "cash", "card"]);
  const COST_SETTLEMENT_TYPES = new Set(["golf_course", "partner"]);
  const PARTNER_NAMES = new Set(["Chị Oanh"]);
  const CASH_BANK_THRESHOLD = 5000000;
  const PAYMENT_COLUMNS = "id,reservation_id,payment_kind,amount_vnd,payment_date,payment_method,completes_booking,sort_order,legacy_import";
  const PARTNER_OFFSET_COLUMNS = "reservation_id,partner_name,golf_date,amount_vnd,active,applied_at,reversed_at,updated_at";
  const COLUMNS = [
    "id", "booking_group_id", "counterparty_name", "representative_name", "player_names_en", "pax",
    "booking_date", "golf_date", "golf_time",
    "golf_course", "holes", "guest_unit_price_vnd", "smart_cart_note",
    "guest_total_vnd", "course_unit_price_vnd", "course_total_vnd",
    "cost_settlement_type", "cost_partner_name",
    "deposit_amount_vnd", "deposit_received_date",
    "final_received_amount_vnd", "final_received_date",
    "withdrawal_amount_vnd", "withdrawal_date", "customer_type", "note",
    "status", "created_at", "updated_at"
  ].join(",");

  const state = {
    identity: null, rows: [], partnerOffsets: [], statusFilter: "in_progress", saving: false,
    paymentDrafts: { deposit: [], receipt: [], withdrawal: [] }, paymentSequence: 0, formDirty: false,
    createGroupMode: false, createRounds: [], createRoundIndex: 0,
    createRequestId: null, createAttempt: null, createLockedControls: [], editingGroupVersion: null
  };
  const CREATE_ROUND_FIELDS = ["playerNamesEn", "pax", "golfDate", "golfHour", "golfMinute", "golfCourse", "holes", "smartCartNote", "guestUnitPrice", "courseUnitPrice", "costSettlementType", "costPartnerName", "note"];
  const byId = (id) => document.getElementById(id);
  const escape = (value) => DGV.escapeHTML(value ?? "");
  const clean = (value) => String(value ?? "").trim();
  const nullableText = (value) => clean(value) || null;
  const todayYmd = () => DGV.formatYmdInTimeZone(new Date(), TIME_ZONE);
  const embeddedEditor = readEmbeddedContext();

  function readEmbeddedContext() {
    if (!global.parent || global.parent === global || !global.location) return null;
    const params = new URLSearchParams(global.location.search);
    const requestedRecordId = clean(params.get("edit"));
    const token = clean(params.get("editorToken"));
    if (params.get("embedded") !== "1" || !UUID_PATTERN.test(token)) return null;
    const createMode = params.get("create") === "1";
    if (createMode ? params.has("edit") : !UUID_PATTERN.test(requestedRecordId)) return null;
    return { mode: createMode ? "create" : "edit", token, requestedRecordId: createMode ? null : requestedRecordId,
      ready: false, saved: false, closing: false, createUncertain: false, allowedRoundIds: new Set(createMode ? [] : [requestedRecordId]) };
  }

  function sendEditorMessage(type, recordId, bookingGroupId) {
    if (!embeddedEditor) return;
    const payload = { type, mode: embeddedEditor.mode, token: embeddedEditor.token,
      recordId: embeddedEditor.mode === "create" ? (type === "golf-editor-saved" ? recordId : null)
        : recordId || byId("recordId").value || embeddedEditor.requestedRecordId };
    if (type === "golf-editor-saved" && UUID_PATTERN.test(bookingGroupId || "")) payload.bookingGroupId = bookingGroupId;
    if (type === "golf-editor-close" && embeddedEditor.mode === "create" && embeddedEditor.createUncertain) payload.refreshRequired = true;
    if (type === "golf-editor-error") payload.message = "예약 화면을 불러오지 못했습니다. 다시 열어 주세요. / Không mở được màn hình đặt sân. Vui lòng mở lại.";
    global.parent.postMessage(payload, global.location.origin);
  }

  function requestEmbeddedClose() {
    if (!embeddedEditor) return;
    if (embeddedEditor.createUncertain) {
      if (state.saving || !global.confirm("저장 결과가 불확실합니다. 중복 등록을 피하려면 창을 닫고 목록에서 저장 여부를 먼저 확인해 주세요. 닫으시겠습니까?\nChưa rõ kết quả lưu. Hãy đóng cửa sổ và kiểm tra danh sách trước để tránh tạo trùng. Bạn có muốn đóng?")) {
        sendEditorMessage("golf-editor-close-blocked"); return;
      }
      state.formDirty = false;
      embeddedEditor.closing = true;
      sendEditorMessage("golf-editor-close");
      return;
    }
    if (!canLeaveEditedBooking()) { sendEditorMessage("golf-editor-close-blocked"); return; }
    state.formDirty = false;
    embeddedEditor.closing = true;
    sendEditorMessage("golf-editor-close");
  }

  function handleEditorMessage(event) {
    if (!embeddedEditor || event.origin !== global.location.origin || event.source !== global.parent) return;
    const message = event.data;
    const modeMatches = message?.mode === embeddedEditor.mode || (embeddedEditor.mode === "edit" && message?.mode == null);
    if (!message || message.token !== embeddedEditor.token || !modeMatches || message.type !== "golf-editor-request-close") return;
    requestEmbeddedClose();
  }

  function configureEmbeddedEditor() {
    if (!embeddedEditor) return;
    document.body.classList.add("golf-embedded");
    document.body.classList.add(`golf-embedded-${embeddedEditor.mode}`);
    byId("reservationForm").setAttribute("aria-busy", "true");
  }

  function completeEmbeddedLoad() {
    if (!embeddedEditor) return;
    const row = rowById(byId("recordId").value);
    if (embeddedEditor.mode === "create" ? Boolean(byId("recordId").value) : !row || row.id !== embeddedEditor.requestedRecordId) {
      setCreateLocked(true);
      sendEditorMessage("golf-editor-error");
      return;
    }
    embeddedEditor.allowedRoundIds = new Set(row ? (row.booking ? row.booking.rounds.map((round) => round.id) : [row.id]) : []);
    embeddedEditor.ready = true;
    setCreateLocked(false);
    byId("reservationForm").setAttribute("aria-busy", "false");
    document.body.classList.add("golf-embedded-ready");
    sendEditorMessage("golf-editor-ready", row?.id);
  }

  function finishEmbeddedSave(saved) {
    if (!embeddedEditor) return;
    if (!UUID_PATTERN.test(saved?.saved_id || "")) throw new Error("저장 응답을 확인하지 못했습니다. / Chưa xác nhận được kết quả lưu.");
    embeddedEditor.saved = true;
    embeddedEditor.createUncertain = false;
    state.formDirty = false;
    setCreateLocked(true);
    sendEditorMessage("golf-editor-saved", saved.saved_id, saved.booking_group_id);
  }

  function embeddedCreationBlocked() {
    return Boolean(embeddedEditor && (embeddedEditor.mode !== "create" || !embeddedEditor.ready || embeddedEditor.saved || embeddedEditor.closing || embeddedEditor.createUncertain || byId("recordId").value));
  }

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

  function smartCartAmount(value) {
    const text = clean(value);
    if (!text) return 0;
    if (!/^(?:[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+)(?:\s*VND)?$/i.test(text)) return NaN;
    const amount = Number(text.replace(/\s*VND$/i, "").replace(/,/g, ""));
    return Number.isSafeInteger(amount) && amount >= 0 && amount <= MAX_SMART_CART_AMOUNT ? amount : NaN;
  }

  function smartCartErrorMessage() {
    return "S-CART 금액은 0~1,000,000,000 VND의 정수로 입력해 주세요. 예: 400,000 VND / Vui lòng nhập số tiền S-CART nguyên từ 0 đến 1.000.000.000 VND. Ví dụ: 400,000 VND.";
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

  function paxFromForm() {
    const entered = clean(byId("pax").value);
    return entered ? Number(entered) : namesCount(byId("playerNamesEn").value);
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

  function paymentMethodLabel(value) {
    return value === "bank" ? "은행 / Chuyển khoản"
      : value === "cash" ? "현금 / Tiền mặt"
      : value === "card" ? "카드 / Thẻ"
      : "—";
  }

  function newPaymentDraft(kind, values = {}) {
    state.paymentSequence += 1;
    return {
      draft_key: `payment-${state.paymentSequence}`,
      id: values.id || null,
      payment_kind: kind,
      amount_vnd: values.amount_vnd == null ? null : Number(values.amount_vnd),
      payment_date: values.payment_date || todayYmd(),
      payment_method: PAYMENT_METHODS.has(values.payment_method) ? values.payment_method : null,
      completes_booking: Boolean(values.completes_booking),
      sort_order: Number.isInteger(Number(values.sort_order)) ? Number(values.sort_order) : 0,
      legacy_import: Boolean(values.legacy_import)
    };
  }

  function legacyPaymentsForRow(row) {
    const payments = [];
    const deposit = Number(row.deposit_amount_vnd || 0);
    const completed = row.final_received_amount_vnd != null && row.final_received_date;
    const finalTotal = row.final_received_amount_vnd == null ? null : Number(row.final_received_amount_vnd);
    if (deposit > 0) {
      payments.push(newPaymentDraft("deposit", {
        amount_vnd: deposit,
        payment_date: row.deposit_received_date || row.booking_date || todayYmd(),
        legacy_import: true,
        sort_order: 0
      }));
    }
    if (completed) {
      payments.push(newPaymentDraft("receipt", {
        amount_vnd: Math.max(0, finalTotal - deposit),
        payment_date: row.final_received_date,
        completes_booking: true,
        legacy_import: true,
        sort_order: 0
      }));
    }
    if (row.withdrawal_amount_vnd != null && row.withdrawal_date) {
      payments.push(newPaymentDraft("withdrawal", {
        amount_vnd: Number(row.withdrawal_amount_vnd),
        payment_date: row.withdrawal_date,
        legacy_import: true,
        sort_order: 0
      }));
    }
    return payments;
  }

  function paymentRowsFor(row) {
    if (row?.booking) return row.booking.payments;
    return Array.isArray(row?.payments) && row.payments.length
      ? row.payments
      : legacyPaymentsForRow(row || {});
  }

  function paymentTotals(payments) {
    const totals = { deposit: 0, receipt: 0, withdrawal: 0, received: 0 };
    for (const payment of payments || []) {
      const amount = Number(payment.amount_vnd);
      if (!PAYMENT_KINDS.has(payment.payment_kind) || !Number.isFinite(amount)) continue;
      totals[payment.payment_kind] += amount;
    }
    totals.received = totals.deposit + totals.receipt;
    return totals;
  }

  function paymentContainerId(kind) {
    return kind === "deposit" ? "depositPayments"
      : kind === "receipt" ? "receiptPayments"
      : "withdrawalPayments";
  }

  function paymentKindName(kind) {
    return kind === "deposit" ? "계약금 / Tiền cọc"
      : kind === "receipt" ? "추가 입금 / Khoản thu thêm"
      : "골프장 출금 / Chi sân golf";
  }

  function paymentRowMarkup(payment, index) {
    const amount = payment.amount_vnd == null ? "" : Number(payment.amount_vnd).toLocaleString("ko-KR");
    const selected = (method) => payment.payment_method === method ? " selected" : "";
    return `<div class="golf-payment-row" data-payment-kind="${escape(payment.payment_kind)}" data-payment-index="${index}">
      <label class="qr-field"><span class="qr-label">금액 (VND) / Số tiền</span><input class="qr-input golf-payment-amount" type="text" inputmode="numeric" autocomplete="off" data-payment-field="amount_vnd" value="${escape(amount)}" /></label>
      <label class="qr-field"><span class="qr-label">날짜 / Ngày</span><input class="qr-input" type="date" data-payment-field="payment_date" value="${escape(payment.payment_date || "")}" /></label>
      <label class="qr-field"><span class="qr-label">수단 / Phương thức</span><select class="qr-select" data-payment-field="payment_method">
        <option value="">선택 / Chọn</option>
        <option value="bank"${selected("bank")}>은행 / Chuyển khoản</option>
        <option value="cash"${selected("cash")}>현금 / Tiền mặt</option>
        <option value="card"${selected("card")}>카드 / Thẻ</option>
      </select></label>
      <button class="qr-btn qr-btn-small qr-btn-danger golf-payment-delete" type="button" data-delete-payment>삭제 / Xóa</button>
    </div>`;
  }

  function renderPaymentKind(kind) {
    const rows = state.paymentDrafts[kind];
    byId(paymentContainerId(kind)).innerHTML = rows.length
      ? rows.map(paymentRowMarkup).join("")
      : `<div class="golf-payment-empty">${paymentKindName(kind)} 내역이 없습니다. / Chưa có giao dịch.</div>`;
  }

  function renderPaymentDrafts() {
    for (const kind of VISIBLE_PAYMENT_KINDS) renderPaymentKind(kind);
    updatePreview();
  }

  function setPaymentDrafts(payments) {
    state.paymentDrafts = { deposit: [], receipt: [], withdrawal: [] };
    for (const raw of payments || []) {
      if (!PAYMENT_KINDS.has(raw.payment_kind)) continue;
      state.paymentDrafts[raw.payment_kind].push(newPaymentDraft(raw.payment_kind, raw));
    }
    for (const kind of PAYMENT_KINDS) {
      state.paymentDrafts[kind].sort((a, b) =>
        String(a.payment_date).localeCompare(String(b.payment_date)) ||
        Number(a.sort_order || 0) - Number(b.sort_order || 0)
      );
    }
    renderPaymentDrafts();
  }

  function allPaymentDrafts() {
    const payments = [];
    for (const kind of ["deposit", "receipt", "withdrawal"]) {
      state.paymentDrafts[kind].forEach((payment, index) => payments.push({
        ...payment,
        payment_kind: kind,
        sort_order: index,
        completes_booking: false
      }));
    }
    if (byId("paymentCompleted").checked) {
      const incoming = payments.filter((payment) => payment.payment_kind !== "withdrawal");
      incoming.sort((a, b) =>
        String(a.payment_date).localeCompare(String(b.payment_date)) ||
        Number(a.sort_order) - Number(b.sort_order)
      );
      if (incoming.length) incoming[incoming.length - 1].completes_booking = true;
    }
    return payments;
  }

  function validatePayments(payments) {
    let completedCount = 0;
    for (const payment of payments) {
      const label = paymentKindName(payment.payment_kind);
      if (!PAYMENT_KINDS.has(payment.payment_kind)) throw new Error("입출금 종류를 확인해 주세요. / Vui lòng kiểm tra loại giao dịch.");
      if (!Number.isSafeInteger(payment.amount_vnd) || payment.amount_vnd < 0 || payment.amount_vnd > MAX_SAFE_MONEY) {
        throw new Error(`${label} 금액을 올바르게 입력해 주세요. / Vui lòng nhập đúng số tiền.`);
      }
      if (!payment.payment_date) throw new Error(`${label} 날짜를 입력해 주세요. / Vui lòng chọn ngày giao dịch.`);
      if (payment.payment_method && !PAYMENT_METHODS.has(payment.payment_method)) {
        throw new Error("결제수단은 은행, 현금, 카드 중에서 선택해 주세요. / Chọn chuyển khoản, tiền mặt hoặc thẻ.");
      }
      if (payment.amount_vnd > 0 && !payment.payment_method && !payment.legacy_import) {
        throw new Error(`${label}의 결제수단을 선택해 주세요. / Vui lòng chọn phương thức thanh toán.`);
      }
      if (payment.payment_method === "cash" && payment.amount_vnd >= CASH_BANK_THRESHOLD) {
        throw new Error("5,000,000 VND 이상은 은행 거래가 필요합니다. / Giao dịch từ 5.000.000 VND phải chuyển khoản ngân hàng.");
      }
      if (payment.completes_booking) {
        completedCount += 1;
        if (payment.payment_kind === "withdrawal") throw new Error("고객 입금 내역으로만 완료 처리할 수 있습니다. / Chỉ khoản khách thanh toán mới có thể hoàn tất.");
      }
    }
    if (byId("paymentCompleted").checked && completedCount !== 1) {
      throw new Error("완료 처리할 고객 입금 내역을 확인해 주세요. / Vui lòng kiểm tra khoản thu hoàn tất.");
    }
    return payments;
  }

  function paymentDetailText(row, kind) {
    const payments = paymentRowsFor(row).filter((payment) => payment.payment_kind === kind);
    if (!payments.length) return "—";
    return payments.map((payment) =>
      `${dateLabel(payment.payment_date)} · ${paymentMethodLabel(payment.payment_method)} · ${moneyLabel(payment.amount_vnd)}`
    ).join("\n");
  }

  function syncCostSettlementFields() {
    const partnerSettlement = byId("costSettlementType").value === "partner";
    byId("costPartnerField").hidden = !partnerSettlement;
    byId("costPartnerName").required = partnerSettlement;
    if (partnerSettlement && !PARTNER_NAMES.has(byId("costPartnerName").value)) {
      byId("costPartnerName").value = "Chị Oanh";
    }
    if (!partnerSettlement) byId("costPartnerName").value = "";
    byId("courseTotalLabel").textContent = partnerSettlement
      ? "거래처 정산 예정 합계 / Tổng tiền quyết toán đối tác"
      : "골프장 지급 예정 합계 / Tổng tiền sân";
  }

  function editingBooking() {
    return rowById(byId("recordId").value)?.booking || null;
  }

  function readCreateRoundValues() {
    return Object.fromEntries(CREATE_ROUND_FIELDS.map((id) => [id, byId(id).value]));
  }

  function captureCreateRound() {
    if (state.createGroupMode && state.createRounds[state.createRoundIndex]) {
      state.createRounds[state.createRoundIndex].values = readCreateRoundValues();
    }
  }

  function applyCreateRound(values) {
    for (const id of CREATE_ROUND_FIELDS) byId(id).value = values[id] ?? "";
    byId("representativeName").value = firstPlayerName(values.playerNamesEn);
  }

  function createRoundTotal(values, priceField) {
    const pax = Number(values.pax || namesCount(values.playerNamesEn));
    const price = moneyNumber(values[priceField]);
    const cart = smartCartAmount(values.smartCartNote);
    return Number.isInteger(pax) && pax > 0 && price != null && Number.isFinite(price) && Number.isFinite(cart)
      ? pax * price + cart : null;
  }

  function createGroupTotal(priceField) {
    const totals = state.createRounds.map((round, index) => createRoundTotal(index === state.createRoundIndex ? readCreateRoundValues() : round.values, priceField));
    return !totals.length || totals.some((total) => total == null) ? null : totals.reduce((sum, total) => sum + total, 0);
  }

  function createRoundLabel(values, index) {
    const pax = values.pax || namesCount(values.playerNamesEn) || "—";
    return `${index + 1}. ${values.golfDate ? dateLabel(values.golfDate) : "날짜 선택 / Chọn ngày"} · ${values.golfCourse || "—"} · ${pax}명 / khách`;
  }

  function refreshCreateRoundLabel() {
    if (!state.createGroupMode || state.createAttempt?.uncertain) return;
    const button = byId("createGroupSchedules").querySelector(`[data-create-round-index="${state.createRoundIndex}"]`);
    if (button) button.textContent = createRoundLabel(readCreateRoundValues(), state.createRoundIndex);
  }

  function renderCreateSchedules() {
    if (!state.createGroupMode) return;
    byId("createGroupSchedules").innerHTML = state.createRounds.map((round, index) => {
      const values = index === state.createRoundIndex ? readCreateRoundValues() : round.values;
      return `<button class="qr-btn qr-btn-small golf-booking-round${index === state.createRoundIndex ? " is-current" : ""}" type="button" data-create-round-index="${index}" aria-pressed="${index === state.createRoundIndex}"${state.saving || state.createAttempt?.uncertain ? " disabled" : ""}>${escape(createRoundLabel(values, index))}</button>`;
    }).join("");
    byId("addCreateRoundButton").disabled = state.createRounds.length >= 30 || Boolean(state.createAttempt?.uncertain);
    byId("removeCreateRoundButton").disabled = state.createRounds.length <= 1 || Boolean(state.createAttempt?.uncertain);
    byId("createGroupStatus").textContent = state.createAttempt?.uncertain
      ? "저장 결과를 확인하지 못했습니다. 입력은 잠겼으며, 아래 동일 내용 재시도를 눌러 결과를 확인해 주세요. / Chưa xác nhận kết quả lưu. Dữ liệu đã khóa; vui lòng thử lại cùng nội dung bên dưới."
      : `${state.createRounds.length}개 일정 · ${state.createRoundIndex + 1}번째 일정 입력 중 / ${state.createRounds.length} lịch · Đang nhập lịch ${state.createRoundIndex + 1}`;
  }

  function syncCreateContext() {
    byId("bookingModeField").hidden = Boolean(byId("recordId").value);
    byId("bookingMode").value = state.createGroupMode ? "group" : "single";
    byId("createGroupPanel").hidden = !state.createGroupMode;
    if (state.createGroupMode) {
      byId("customerPaymentsTitle").textContent = "묶음 전체 입금 및 상태 / Khoản thu và trạng thái của cả nhóm";
      byId("paymentScopeHint").hidden = false;
      byId("completionLabel").textContent = "묶음 전체 입금 완료 처리 / Hoàn tất thanh toán cả nhóm";
      byId("completionHelp").textContent = "저장하면 모든 일정이 함께 완료됩니다. 모든 일정의 원가와 공통 입금내역을 먼저 입력해 주세요. / Khi lưu, tất cả lịch cùng hoàn tất. Hãy nhập giá vốn từng lịch và khoản thu chung trước.";
      renderCreateSchedules();
      if (!state.saving) byId("saveButton").textContent = "묶음예약 저장 / Lưu nhóm đặt sân";
    } else if (!byId("recordId").value && !state.saving) byId("saveButton").textContent = "예약 저장 / Lưu đặt chỗ";
  }

  function clearCreateState() {
    setCreateLocked(false);
    state.createGroupMode = false;
    state.createRounds = [];
    state.createRoundIndex = 0;
    state.createRequestId = null;
    state.createAttempt = null;
  }

  function changeBookingMode() {
    if (embeddedCreationBlocked()) return;
    const groupMode = byId("bookingMode").value === "group";
    if (groupMode === state.createGroupMode) return;
    if (state.saving || state.createAttempt?.uncertain) { byId("bookingMode").value = state.createGroupMode ? "group" : "single"; return; }
    if (!groupMode && !global.confirm("묶음 작성을 취소하고 현재 일정만 단일 예약으로 남기시겠습니까? 다른 임시 일정은 삭제됩니다.\nHủy nhóm và chỉ giữ lịch đang nhập làm đặt sân đơn? Các lịch nháp khác sẽ bị bỏ.")) {
      byId("bookingMode").value = "group"; return;
    }
    if (groupMode) {
      state.createGroupMode = true;
      state.createRounds = [{ values: readCreateRoundValues() }];
      state.createRoundIndex = 0;
      state.createRequestId = global.crypto.randomUUID();
      state.createAttempt = null;
    } else clearCreateState();
    state.formDirty = true;
    syncBookingContext();
    syncCreateContext();
    updatePreview();
  }

  function addCreateRound() {
    if (embeddedCreationBlocked()) return;
    if (!state.createGroupMode || state.saving || state.createAttempt?.uncertain) return;
    if (state.createRounds.length >= 30) { QRStaff.toast("최대 30개 일정까지 추가할 수 있습니다. / Tối đa 30 lịch.", "error"); return; }
    captureCreateRound();
    const previous = state.createRounds[state.createRoundIndex].values;
    const values = Object.fromEntries(CREATE_ROUND_FIELDS.map((id) => [id, ""]));
    Object.assign(values, { playerNamesEn: previous.playerNamesEn, pax: previous.pax, golfMinute: "00", holes: "18", costSettlementType: "golf_course" });
    state.createRounds.push({ values });
    state.createRoundIndex = state.createRounds.length - 1;
    applyCreateRound(values);
    state.formDirty = true;
    renderCreateSchedules();
    updatePreview();
    byId("golfDate").focus();
  }

  function switchCreateRound(index) {
    if (embeddedCreationBlocked()) return;
    if (!state.createGroupMode || state.saving || state.createAttempt?.uncertain || !state.createRounds[index] || index === state.createRoundIndex) return;
    captureCreateRound();
    state.createRoundIndex = index;
    applyCreateRound(state.createRounds[index].values);
    renderCreateSchedules();
    updatePreview();
  }

  function removeCreateRound() {
    if (embeddedCreationBlocked()) return;
    if (!state.createGroupMode || state.saving || state.createAttempt?.uncertain || state.createRounds.length <= 1) return;
    if (!global.confirm(`${state.createRoundIndex + 1}번째 임시 일정을 삭제하시겠습니까? 공통 입금은 유지됩니다.\nXóa lịch nháp ${state.createRoundIndex + 1}? Khoản thu chung vẫn được giữ.`)) return;
    state.createRounds.splice(state.createRoundIndex, 1);
    state.createRoundIndex = Math.min(state.createRoundIndex, state.createRounds.length - 1);
    applyCreateRound(state.createRounds[state.createRoundIndex].values);
    state.formDirty = true;
    renderCreateSchedules();
    updatePreview();
  }

  function collectCreatePayload() {
    if (state.createRounds.length < 2 || state.createRounds.length > 30) throw new Error("묶음예약은 2~30개 일정이 필요합니다. / Đặt sân gộp cần từ 2 đến 30 lịch.");
    captureCreateRound();
    const activeIndex = state.createRoundIndex;
    const rounds = [];
    let payments;
    try {
      for (let index = 0; index < state.createRounds.length; index += 1) {
        applyCreateRound(state.createRounds[index].values);
        try {
          const payload = payloadFromForm();
          const { expected_updated_at, ...reservation } = payload.reservation;
          rounds.push(reservation);
          payments = payload.payments;
        } catch (error) { throw new Error(`${index + 1}번째 일정 / Lịch ${index + 1}: ${error.message}`); }
      }
    } finally {
      applyCreateRound(state.createRounds[activeIndex].values);
      updatePreview();
    }
    const label = clean(byId("createGroupLabel").value) || `${rounds[0].representative_name.slice(0, 140)} · ${rounds[0].golf_date}`;
    if (label.length > 160) throw new Error("묶음 이름은 160자 이내로 입력해 주세요. / Tên nhóm tối đa 160 ký tự.");
    return { p_request_id: state.createRequestId, p_label: label, p_rounds: rounds, p_payments: payments };
  }

  function setCreateLocked(locked) {
    if (locked) {
      if (state.createLockedControls.length) return;
      const controls = [...byId("reservationForm").querySelectorAll("input,select,textarea,button"), byId("resetButton")];
      state.createLockedControls = controls.filter((element) => element.id !== "saveButton").map((element) => ({ element, disabled: element.disabled }));
      for (const { element } of state.createLockedControls) element.disabled = true;
    } else {
      for (const { element, disabled } of state.createLockedControls) element.disabled = disabled;
      state.createLockedControls = [];
    }
  }

  function isDefiniteCreateRejection(error) {
    return /^(?:22|23|40|42|P0)[A-Z0-9]{3}$/.test(String(error?.code || "")) || /^PGRST(?:202|301|302)$/.test(String(error?.code || ""));
  }

  async function saveCreatedGroup() {
    if (embeddedCreationBlocked() || state.saving) return;
    let payload;
    const retryingUncertain = Boolean(state.createAttempt?.uncertain);
    let confirmed = false;
    try { payload = state.createAttempt?.uncertain ? state.createAttempt.payload : collectCreatePayload(); }
    catch (error) { QRStaff.toast(error.message, "error"); return; }
    if (!state.createAttempt?.uncertain && byId("paymentCompleted").checked
      && !global.confirm(`${payload.p_rounds.length}개 일정 전체를 함께 완료하고 골프장별 원가를 차감하거나 정산 거래처에 반영하시겠습니까?\nHoàn tất toàn bộ ${payload.p_rounds.length} lịch, khấu trừ giá vốn theo từng sân hoặc ghi nhận cho đối tác quyết toán?`)) return;
    state.createAttempt = { payload: JSON.parse(JSON.stringify(payload)), uncertain: false };
    state.saving = true;
    setCreateLocked(true);
    QRStaff.setBusy(byId("saveButton"), true, "저장 중… / Đang lưu…");
    try {
      const { data, error } = await sb.rpc("create_golf_booking_group", state.createAttempt.payload);
      if (error) throw error;
      if (!Array.isArray(data) || !data[0]?.saved_id || !data[0]?.booking_group_id) throw new Error("저장 응답을 확인하지 못했습니다. / Chưa xác nhận được kết quả lưu.");
      if (embeddedEditor && (!UUID_PATTERN.test(data[0].saved_id) || !UUID_PATTERN.test(data[0].booking_group_id))) throw new Error("저장 응답을 확인하지 못했습니다. / Chưa xác nhận được kết quả lưu.");
      confirmed = true;
      QRStaff.toast("묶음예약과 모든 일정을 함께 저장했습니다. / Đã lưu nhóm đặt sân cùng toàn bộ lịch.", "ok");
      if (embeddedEditor) { finishEmbeddedSave(data[0]); return; }
      setCreateLocked(false);
      resetForm({ focus: false });
      await loadRows({ quiet: true });
    } catch (error) {
      if (confirmed) {
        if (!embeddedEditor?.saved) setCreateLocked(false);
        QRStaff.toast("예약은 저장되었지만 화면을 갱신하지 못했습니다. 새로고침해 주세요. / Đã lưu đặt sân nhưng chưa cập nhật màn hình. Vui lòng tải lại.", "error");
      } else if (!retryingUncertain && isDefiniteCreateRejection(error)) {
        state.createAttempt = null;
        setCreateLocked(false);
        QRStaff.toast(QRStaff.messageOf(error, "묶음예약을 저장하지 못했습니다. / Không lưu được nhóm đặt sân."), "error");
      } else {
        state.createAttempt.uncertain = true;
        QRStaff.toast("저장 결과가 불확실합니다. 내용을 변경하지 않고 동일 내용 재시도를 눌러 확인해 주세요. / Chưa rõ kết quả lưu; vui lòng thử lại đúng nội dung để xác nhận.", "error");
      }
      renderCreateSchedules();
    } finally {
      state.saving = Boolean(embeddedEditor?.saved);
      QRStaff.setBusy(byId("saveButton"), state.saving, state.saving ? "저장 완료 / Đã lưu" : undefined);
      if (!state.saving) {
        renderCreateSchedules();
        byId("saveButton").textContent = state.createAttempt?.uncertain ? "동일 내용 재시도 / Thử lại cùng nội dung" : state.createGroupMode ? "묶음예약 저장 / Lưu nhóm đặt sân" : "예약 저장 / Lưu đặt chỗ";
      }
    }
  }

  function bookingDraftTotal(booking, field, currentTotal) {
    if (!booking) return currentTotal;
    const id = byId("recordId").value;
    const values = booking.rounds.map((row) => row.id === id ? currentTotal : row[field]);
    return values.some((value) => value == null) ? null : values.reduce((sum, value) => sum + Number(value), 0);
  }

  function bookingBadge(row) {
    if (!row.booking) return "";
    const booking = row.booking;
    return `<span class="golf-booking-badge">묶음예약 · ${escape(booking.label)} · ${booking.rounds.length}일정 / Đặt sân gộp · ${booking.rounds.length} lịch</span>`;
  }

  function syncBookingContext(row = null) {
    const booking = row?.booking || null;
    byId("bookingGroupPanel").hidden = !booking;
    byId("counterpartyName").readOnly = Boolean(booking);
    byId("customerType").disabled = Boolean(booking);
    byId("paymentScopeHint").hidden = !booking;
    byId("customerPaymentsTitle").textContent = booking
      ? "묶음 전체 입금 및 상태 / Khoản thu và trạng thái của cả nhóm"
      : "고객 입금 및 상태 / Thu tiền khách và trạng thái";
    byId("completionLabel").textContent = booking
      ? "묶음 전체 입금 완료 처리 / Hoàn tất thanh toán cả nhóm"
      : "입금 완료 처리 / Đánh dấu đã nhận đủ tiền";
    byId("completionHelp").textContent = booking
      ? "체크 후 저장하면 연결된 모든 일정이 함께 완료됩니다. 일정별 원가는 설정된 골프장 또는 정산 거래처에 반영됩니다. / Khi lưu, tất cả lịch trong nhóm cùng hoàn tất; giá vốn từng lịch được ghi nhận cho sân hoặc đối tác quyết toán đã chọn."
      : "체크하면 현재 고객 총입금액과 마지막 입금일로 완료 처리됩니다. / Khi chọn, tổng tiền đã nhận và ngày thu cuối sẽ được dùng để hoàn tất.";
    if (!booking) {
      byId("bookingGroupSchedules").innerHTML = "";
      return;
    }
    byId("bookingGroupTitle").textContent = `묶음예약 · ${booking.label} / Đặt sân gộp`;
    byId("bookingGroupSchedules").innerHTML = booking.rounds.map((round, index) =>
      `<button class="qr-btn qr-btn-small golf-booking-round${round.id === row.id ? " is-current" : ""}" type="button" data-edit-group-round="${escape(round.id)}" aria-pressed="${round.id === row.id}">${index + 1}. ${escape(dateLabel(round.golf_date))} ${escape(timeLabel(round.golf_time))} · ${escape(round.golf_course)} · ${escape(round.pax)}명 / khách${round.id === row.id ? " · 수정 중 / Đang sửa" : ""}</button>`
    ).join("");
  }

  function updatePreview() {
    syncCostSettlementFields();
    const pax = paxFromForm();
    const guestUnit = moneyNumber(byId("guestUnitPrice").value);
    const courseUnit = moneyNumber(byId("courseUnitPrice").value);
    const cartAmount = smartCartAmount(byId("smartCartNote").value);
    const cartValid = Number.isFinite(cartAmount);
    const cartError = cartValid ? "" : smartCartErrorMessage();
    byId("smartCartNote").setCustomValidity(cartError);
    byId("smartCartNote").setAttribute("aria-invalid", String(!cartValid));
    byId("smartCartError").textContent = cartError;
    byId("smartCartError").hidden = cartValid;
    const guestTotal = cartValid && pax > 0 && Number.isFinite(guestUnit) ? pax * guestUnit + cartAmount : null;
    const courseTotal = cartValid && pax > 0 && Number.isFinite(courseUnit) ? pax * courseUnit + cartAmount : null;
    const margin = guestTotal != null && courseTotal != null ? guestTotal - courseTotal : null;
    byId("guestTotalPreview").textContent = moneyLabel(guestTotal);
    byId("courseTotalPreview").textContent = moneyLabel(courseTotal);
    byId("marginPreview").textContent = moneyLabel(margin);
    const totals = paymentTotals(allPaymentDrafts());
    const booking = editingBooking();
    const bookingGuestTotal = state.createGroupMode ? createGroupTotal("guestUnitPrice") : bookingDraftTotal(booking, "guest_total_vnd", guestTotal);
    const bookingCostTotal = state.createGroupMode ? createGroupTotal("courseUnitPrice") : bookingDraftTotal(booking, "course_total_vnd", courseTotal);
    if (state.createGroupMode) {
      byId("createGroupGuestTotal").textContent = moneyLabel(bookingGuestTotal);
      byId("createGroupCostTotal").textContent = moneyLabel(bookingCostTotal);
      byId("createGroupReceivedTotal").textContent = moneyLabel(totals.received);
      byId("createGroupBalance").textContent = moneyLabel(bookingGuestTotal == null ? null : bookingGuestTotal - totals.received);
    }
    if (booking) {
      byId("bookingGroupGuestTotal").textContent = moneyLabel(bookingGuestTotal);
      byId("bookingGroupCostTotal").textContent = moneyLabel(bookingCostTotal);
      byId("bookingGroupReceivedTotal").textContent = moneyLabel(totals.received);
      byId("bookingGroupBalance").textContent = moneyLabel(bookingGuestTotal == null ? null : bookingGuestTotal - totals.received);
    }
    byId("depositTotalPreview").textContent = moneyLabel(totals.deposit);
    byId("receivedTotalPreview").textContent = moneyLabel(totals.received);
    byId("customerBalancePreview").textContent = moneyLabel(
      bookingGuestTotal == null ? null : bookingGuestTotal - totals.received
    );
    byId("statusPreview").textContent = byId("paymentCompleted").checked
      ? "완료 / Hoàn tất"
      : "진행중 / Đang xử lý";
  }

  function resetForm(options = {}) {
    if (embeddedEditor?.ready) return;
    clearCreateState();
    state.editingGroupVersion = null;
    byId("reservationForm").reset();
    byId("recordId").value = "";
    syncBookingContext();
    syncCreateContext();
    clearLegacyCourseOption();
    byId("golfCourse").value = "";
    clearLegacyHoleOption();
    byId("holes").value = "18";
    byId("customerType").value = "company";
    byId("costSettlementType").value = "golf_course";
    byId("costPartnerName").value = "";
    byId("golfDate").value = "";
    byId("golfHour").value = "";
    byId("golfMinute").value = "00";
    byId("paymentCompleted").checked = false;
    setPaymentDrafts([]);
    byId("formTitle").textContent = "새 골프 예약 / Đặt sân mới";
    byId("editingHint").textContent = "고객과 일정을 먼저 등록하고 가격·입금 내역은 나중에 추가할 수 있습니다. / Có thể đăng ký khách và lịch chơi trước, bổ sung giá và các khoản thu sau.";
    byId("saveButton").textContent = "예약 저장 / Lưu đặt chỗ";
    byId("cancelEditButton").hidden = true;
    updatePreview();
    state.formDirty = false;
    if (options.focus !== false) byId("counterpartyName").focus();
  }

  function fillForm(row, options = {}) {
    if (embeddedEditor?.mode === "create" || embeddedEditor?.saved || (embeddedEditor?.ready && !embeddedEditor.allowedRoundIds.has(row.id))) return;
    clearCreateState();
    state.editingGroupVersion = row.booking?.version ?? null;
    byId("recordId").value = row.id;
    syncBookingContext(row);
    syncCreateContext();
    byId("counterpartyName").value = row.counterparty_name || "";
    byId("representativeName").value = row.representative_name || "";
    byId("playerNamesEn").value = row.player_names_en || "";
    byId("pax").value = row.pax || "";
    byId("customerType").value = row.customer_type === "individual" ? "individual" : "company";
    const teeOffMatch = String(row.golf_time || "").match(/^(\d{2}):(\d{2})/);
    byId("golfDate").value = row.golf_date || "";
    byId("golfHour").value = teeOffMatch?.[1] || "";
    const savedMinute = teeOffMatch?.[2] || "00";
    const minuteSelect = byId("golfMinute");
    if (![...minuteSelect.options].some((option) => option.value === savedMinute)) {
      minuteSelect.add(new Option(savedMinute, savedMinute));
    }
    minuteSelect.value = savedMinute;
    setCourseValue(row.golf_course);
    setHoleValue(row.holes);
    byId("smartCartNote").value = row.smart_cart_note || "";
    setMoneyInput("guestUnitPrice", row.guest_unit_price_vnd);
    setMoneyInput("courseUnitPrice", row.course_unit_price_vnd);
    byId("costSettlementType").value = row.cost_settlement_type === "partner" ? "partner" : "golf_course";
    byId("costPartnerName").value = row.cost_settlement_type === "partner"
      ? (row.cost_partner_name || "Chị Oanh")
      : "";
    byId("paymentCompleted").checked = row.booking ? Boolean(row.booking.completed_at) : row.status === "completed";
    setPaymentDrafts(paymentRowsFor(row));
    byId("note").value = row.note || "";
    byId("formTitle").textContent = `${row.representative_name} 수정 / Chỉnh sửa ${row.representative_name}`;
    byId("editingHint").textContent = row.status === "completed"
      ? "완료 기록과 고객 입금 내역을 수정할 수 있습니다. 완료 체크를 해제하면 입금내역은 유지되고 진행중으로 바뀝니다. / Có thể sửa khoản thu; bỏ chọn hoàn tất để chuyển về đang xử lý."
      : "진행중 예약의 고객 입금 내역을 추가하고 완료 처리할 수 있습니다. / Có thể thêm khoản thu và hoàn tất đặt sân.";
    if (row.booking) byId("editingHint").textContent = "고객·일정·가격은 선택한 일정만 수정합니다. 계약금·입금과 완료 여부는 묶음 전체에 적용됩니다. / Khách, lịch và giá chỉ sửa cho lịch đã chọn; khoản thu và trạng thái áp dụng cho cả nhóm.";
    byId("saveButton").textContent = "변경 저장 / Lưu thay đổi";
    byId("cancelEditButton").hidden = false;
    updatePreview();
    state.formDirty = false;
    if (options.scroll !== false) byId("formTitle").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function payloadFromForm() {
    const playerNamesEn = clean(byId("playerNamesEn").value)
      .split(/[\n,;]+/).map((name) => name.trim()).filter(Boolean).join("\n");
    const counterpartyName = clean(byId("counterpartyName").value);
    const representativeName = firstPlayerName(playerNamesEn);
    const pax = paxFromForm();
    const golfDate = byId("golfDate").value;
    const golfHour = byId("golfHour").value;
    const golfMinute = byId("golfMinute").value || "00";
    const golfTime = golfHour && /^\d{2}$/.test(golfMinute) ? `${golfHour}:${golfMinute}` : "";
    const golfCourse = clean(byId("golfCourse").value);
    const holes = Number(byId("holes").value);
    const guestUnit = moneyNumber(byId("guestUnitPrice").value);
    const courseUnit = moneyNumber(byId("courseUnitPrice").value);
    const existingRow = state.rows.find((row) => row.id === byId("recordId").value);
    const customerType = clean(byId("customerType").value);
    const costSettlementType = clean(byId("costSettlementType").value);
    const costPartnerName = nullableText(byId("costPartnerName").value);
    if (!Number.isFinite(smartCartAmount(byId("smartCartNote").value))) throw new Error(smartCartErrorMessage());
    const payments = validatePayments(allPaymentDrafts());

    if (!counterpartyName) throw new Error("거래처를 입력해 주세요. / Vui lòng nhập đối tác.");
    if (!playerNamesEn) throw new Error("고객명을 영어로 입력해 주세요. / Vui lòng nhập họ tên khách bằng tiếng Anh.");
    if (!representativeName) throw new Error("첫 번째 예약자 이름을 확인해 주세요. / Vui lòng kiểm tra tên người đại diện.");
    if (!Number.isInteger(pax) || pax < 1 || pax > 100) throw new Error("인원을 1명 이상 100명 이하로 입력해 주세요. / Nhập từ 1 đến 100 khách.");
    if (!golfDate || !golfTime) throw new Error("골프 날짜와 티오프 시간을 선택해 주세요. / Chọn ngày chơi và giờ phát bóng.");
    const unchangedLegacyCourse = existingRow && existingRow.golf_course === golfCourse;
    if (!GOLF_COURSES.has(golfCourse) && !unchangedLegacyCourse) {
      throw new Error("골프장을 AT1200, SAM, PALACE 중에서 선택해 주세요. / Chọn sân AT1200, SAM hoặc PALACE.");
    }
    const unchangedLegacyHoles = existingRow && Number(existingRow.holes) === holes;
    if (!STANDARD_HOLES.has(holes) && !unchangedLegacyHoles) throw new Error("홀 수를 9, 18, 27, 26 중에서 선택해 주세요. / Chọn số hố 9, 18, 27 hoặc 26.");
    for (const [label, value] of [["1인 판매가", guestUnit], ["1인 원가", courseUnit]]) {
      if (Number.isNaN(value) || (value != null && (value < 0 || value > 1000000000000))) throw new Error(`${label}을 올바르게 입력해 주세요.`);
    }
    if (byId("paymentCompleted").checked && courseUnit == null) {
      throw new Error("원가를 입력한 후 완료 처리해 주세요. / Vui lòng nhập giá vốn trước khi hoàn tất.");
    }
    if (existingRow?.booking && byId("paymentCompleted").checked
      && existingRow.booking.rounds.some((round) => round.id !== existingRow.id && round.course_total_vnd == null)) {
      throw new Error("묶음의 모든 일정에 원가를 입력한 후 완료 처리해 주세요. / Vui lòng nhập giá vốn cho tất cả lịch trong nhóm trước khi hoàn tất.");
    }
    if (!new Set(["individual", "company"]).has(customerType)) throw new Error("개인 또는 회사를 선택해 주세요. / Chọn cá nhân hoặc công ty.");
    if (!COST_SETTLEMENT_TYPES.has(costSettlementType)) {
      throw new Error("원가 정산 방식을 선택해 주세요. / Vui lòng chọn cách quyết toán giá vốn.");
    }
    if (costSettlementType === "partner" && !PARTNER_NAMES.has(costPartnerName)) {
      throw new Error("정산 거래처로 Chị Oanh을 선택해 주세요. / Vui lòng chọn Chị Oanh làm đối tác quyết toán.");
    }

    return {
      reservation: {
        counterparty_name: counterpartyName,
        representative_name: representativeName,
        player_names_en: playerNamesEn,
        pax,
        golf_date: golfDate,
        golf_time: golfTime,
        golf_course: golfCourse,
        holes,
        guest_unit_price_vnd: guestUnit,
        smart_cart_note: nullableText(byId("smartCartNote").value),
        course_unit_price_vnd: courseUnit,
        cost_settlement_type: costSettlementType,
        cost_partner_name: costSettlementType === "partner" ? costPartnerName : null,
        customer_type: customerType,
        note: nullableText(byId("note").value),
        expected_updated_at: existingRow?.updated_at || null
      },
      payments: payments.map((payment) => ({
        id: payment.id,
        payment_kind: payment.payment_kind,
        amount_vnd: payment.amount_vnd,
        payment_date: payment.payment_date,
        payment_method: payment.payment_method,
        completes_booking: payment.completes_booking,
        sort_order: payment.sort_order
      }))
    };
  }


  function filteredRows() {
    const query = clean(byId("searchInput").value).toLocaleLowerCase();
    const from = byId("filterFrom").value;
    const to = byId("filterTo").value;
    return state.rows.filter((row) => {
      const rowInRange = dateInRange(row.golf_date, from, to);
      const partnerOffsets = activePartnerOffsetsFor(row, from, to);
      if (state.statusFilter === "receivable") {
        const salesInRange = row.customer_type === "company" && rowInRange;
        if (!salesInRange && !partnerOffsets.length) return false;
      } else if (state.statusFilter !== "all" && row.status !== state.statusFilter) return false;
      if (state.statusFilter !== "receivable" && !rowInRange) return false;
      if (!query) return true;
      return [
        row.counterparty_name, row.representative_name, row.player_names_en, row.golf_course,
        row.cost_partner_name, ...partnerOffsets.map((offset) => offset.partner_name), row.note, row.booking?.label
      ]
        .some((value) => String(value || "").toLocaleLowerCase().includes(query));
    });
  }

  function dateInRange(value, from, to) {
    const date = clean(value);
    return Boolean(date) && (!from || date >= from) && (!to || date <= to);
  }

  function activePartnerOffsetsFor(row, from = "", to = "") {
    return state.partnerOffsets.filter((offset) =>
      offset.reservation_id === row.id && offset.active !== false &&
      dateInRange(offset.golf_date, from, to)
    );
  }

  function receivedAmountForBooking(row) {
    const payments = paymentRowsFor(row);
    if (row.booking) return paymentTotals(payments).received;
    if (payments.length) return paymentTotals(payments).received;
    const value = row.final_received_amount_vnd == null
      ? row.deposit_amount_vnd
      : row.final_received_amount_vnd;
    return Number(value) || 0;
  }

  function receivableBalanceForBooking(row) {
    const expected = row.booking ? row.booking.guest_total_vnd : row.guest_total_vnd;
    if (expected == null) return null;
    return Number(expected) - receivedAmountForBooking(row);
  }

  function receivableGroups(rows, from = "", to = "") {
    const groups = new Map();
    const countedBookings = new Set();
    const getGroup = (rawName) => {
      const name = clean(rawName) || "거래처 미입력";
      const key = name.normalize("NFC").toLocaleLowerCase("vi-VN");
      if (!groups.has(key)) {
        groups.set(key, {
          name, bookingCount: 0, partnerBookingCount: 0, expected: 0, received: 0,
          partnerOffset: 0, receivable: 0, unsetExpected: 0, unpricedReceived: 0,
          bookings: [], partnerBookings: []
        });
      }
      return groups.get(key);
    };
    for (const row of rows) {
      const bookingKey = row.booking ? `group:${row.booking.id}` : `round:${row.id}`;
      if (row.customer_type === "company" && dateInRange(row.golf_date, from, to) && !countedBookings.has(bookingKey)) {
        countedBookings.add(bookingKey);
        const group = getGroup(row.counterparty_name);
        const received = receivedAmountForBooking(row);
        const balance = receivableBalanceForBooking(row);
        const expected = row.booking ? row.booking.guest_total_vnd : row.guest_total_vnd;
        group.bookingCount += 1;
        group.bookings.push({ row, received, balance, expected });
        if (balance == null) {
          group.unsetExpected += 1;
          group.unpricedReceived += received;
        } else {
          group.expected += Number(expected) || 0;
          group.received += received;
          group.receivable += balance;
        }
      }
      for (const offset of activePartnerOffsetsFor(row, from, to)) {
        const group = getGroup(offset.partner_name);
        const amount = Number(offset.amount_vnd) || 0;
        group.partnerBookingCount += 1;
        group.partnerOffset += amount;
        group.receivable -= amount;
        group.partnerBookings.push({ row, offset, amount });
      }
    }
    for (const group of groups.values()) {
      group.bookings.sort((a, b) =>
        `${a.row.golf_date} ${a.row.golf_time} ${a.row.id}`
          .localeCompare(`${b.row.golf_date} ${b.row.golf_time} ${b.row.id}`)
      );
      group.partnerBookings.sort((a, b) =>
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
      <td>${row.booking ? `${escape(dateLabel(row.booking.range_from))} ~ ${escape(dateLabel(row.booking.range_to))}<span class="golf-receivable-warning">묶음 전체 / Toàn bộ nhóm</span>` : `${escape(golfDateLabel(row.golf_date))} ${escape(timeLabel(row.golf_time))}`}</td>
      <td><strong>${escape(row.representative_name || "—")}</strong>${bookingBadge(row)}<span class="golf-receivable-warning">${escape(statusLabel)}</span></td>
      <td>${escape(moneyLabel(item.expected))}</td>
      <td>${escape(moneyLabel(item.received))}</td>
      <td>${balanceLabel}</td>
    </tr>`;
  }

  function settlementBalanceMarkup(value) {
    const amount = Number(value) || 0;
    if (amount < 0) {
      return `<strong>우리가 지급할 금액 / Số tiền phải trả: ${escape(moneyLabel(Math.abs(amount)))}</strong>`;
    }
    if (amount > 0) {
      return `<strong>받을 금액 / Số tiền phải thu: ${escape(moneyLabel(amount))}</strong>`;
    }
    return '<strong>정산 잔액 / Số dư quyết toán: 0 VND</strong>';
  }

  function renderPartnerOffsetBooking(item) {
    const row = item.row;
    return `<tr>
      <td>${escape(golfDateLabel(row.golf_date))} ${escape(timeLabel(row.golf_time))}</td>
      <td><strong>${escape(row.representative_name || "—")}</strong><span class="golf-receivable-warning">${escape(row.golf_course || "—")} · ${escape(row.holes || "—")}H · ${escape(row.pax || "—")}명</span></td>
      <td>${escape(item.offset.partner_name || row.cost_partner_name || "—")}</td>
      <td><strong>${escape(moneyLabel(item.amount))}</strong></td>
      <td>${escape(dateTimeLabel(item.offset.applied_at))}</td>
    </tr>`;
  }

  function renderReceivables(rows, from = "", to = "") {
    const groups = receivableGroups(rows, from, to);
    const totals = groups.reduce((sum, group) => ({
      expected: sum.expected + group.expected,
      received: sum.received + group.received,
      partnerOffset: sum.partnerOffset + group.partnerOffset,
      receivable: sum.receivable + group.receivable,
      unsetExpected: sum.unsetExpected + group.unsetExpected,
      unpricedReceived: sum.unpricedReceived + group.unpricedReceived,
      bookingCount: sum.bookingCount + group.bookingCount,
      partnerBookingCount: sum.partnerBookingCount + group.partnerBookingCount
    }), { expected: 0, received: 0, partnerOffset: 0, receivable: 0, unsetExpected: 0, unpricedReceived: 0, bookingCount: 0, partnerBookingCount: 0 });
    byId("listCount").textContent =
      `${groups.length.toLocaleString("ko-KR")}개 거래처 · 매출 ${totals.bookingCount.toLocaleString("ko-KR")}건 · 보유분 ${totals.partnerBookingCount.toLocaleString("ko-KR")}건`;
    byId("receivablePanel").innerHTML = groups.length ? `
      <div class="golf-receivable-total">
        <div><span>원래 받을 금액 / Phải thu</span><strong>${escape(moneyLabel(totals.expected))}</strong></div>
        <div><span>현재 받은 금액 / Đã nhận</span><strong>${escape(moneyLabel(totals.received))}</strong></div>
        <div><span>거래처 보유 티타임 차감 / Khấu trừ suất tee</span><strong>−${escape(moneyLabel(totals.partnerOffset))}</strong></div>
        <div><span>순 정산 잔액 / Số dư quyết toán ròng</span>${settlementBalanceMarkup(totals.receivable)}
          ${totals.unsetExpected ? `<span class="golf-receivable-warning">금액 미설정 ${escape(totals.unsetExpected)}건 · 별도 수령 ${escape(moneyLabel(totals.unpricedReceived))}</span>` : ""}</div>
      </div>
      <div class="golf-receivable-note">순 정산 잔액은 판매 미수금에서 거래처 보유 티타임 원가를 차감해 계산합니다. 음수이면 우리가 거래처에 지급할 금액입니다. / Số dư ròng bằng công nợ bán hàng trừ giá vốn suất tee của đối tác; số âm là khoản chúng ta phải trả.<br />묶음예약은 조회 기간에 일정이 포함되면 예약 전체 판매·입금·미수금을 한 번만 표시합니다. 거래처 보유분 차감은 조회 기간의 일정 기준입니다. / Nhóm có lịch trong kỳ được tính toàn bộ giá bán, khoản thu và công nợ một lần; khấu trừ suất đối tác theo lịch trong kỳ.</div>
      <div class="golf-receivable-table-wrap"><table class="golf-receivable-table">
        <thead><tr><th>거래처 / Đối tác</th><th>예약 / Đặt sân</th><th>원래 받을 금액 / Phải thu</th><th>받은 금액 / Đã nhận</th><th>보유분 차감 / Khấu trừ</th><th>순 정산 / Quyết toán ròng</th></tr></thead>
        <tbody>${groups.map((group) => `
          <tr><td><strong>${escape(group.name)}</strong>
            ${group.unsetExpected ? `<span class="golf-receivable-warning">금액 미설정 ${escape(group.unsetExpected)}건 · 별도 수령 ${escape(moneyLabel(group.unpricedReceived))}</span>` : ""}</td>
            <td>매출 ${escape(group.bookingCount)}건 · 보유분 ${escape(group.partnerBookingCount)}건</td><td>${escape(moneyLabel(group.expected))}</td>
            <td>${escape(moneyLabel(group.received))}</td><td>−${escape(moneyLabel(group.partnerOffset))}</td><td>${settlementBalanceMarkup(group.receivable)}</td></tr>
          <tr class="golf-receivable-detail-row"><td colspan="6">
            ${group.bookings.length ? `<details class="golf-receivable-detail">
              <summary>${escape(group.bookingCount)}건 건당 미수금 보기 / Xem công nợ từng đặt sân</summary>
              <div class="golf-receivable-table-wrap"><table class="golf-receivable-table">
                <thead><tr><th>골프 날짜 / Ngày chơi</th><th>예약자 / Khách</th><th>원래 받을 금액 / Phải thu</th><th>받은 금액 / Đã nhận</th><th>건당 미수금 / Công nợ</th></tr></thead>
                <tbody>${group.bookings.map(renderReceivableBooking).join("")}</tbody>
              </table></div>
            </details>` : ""}
            ${group.partnerBookings.length ? `<details class="golf-receivable-detail">
              <summary>${escape(group.partnerBookingCount)}건 거래처 보유 티타임 차감 보기 / Xem khấu trừ suất tee của đối tác</summary>
              <div class="golf-receivable-table-wrap"><table class="golf-receivable-table">
                <thead><tr><th>골프 날짜 / Ngày chơi</th><th>예약자 / Khách</th><th>정산 거래처 / Đối tác</th><th>차감액 / Khấu trừ</th><th>반영 일시 / Thời điểm</th></tr></thead>
                <tbody>${group.partnerBookings.map(renderPartnerOffsetBooking).join("")}</tbody>
              </table></div>
            </details>` : ""}
          </td></tr>`).join("")}</tbody>
      </table></div>` : '<div class="qr-empty">선택한 기간에 미수금 또는 거래처 보유 티타임 정산 내역이 없습니다.<br />Không có công nợ hoặc khoản quyết toán suất tee trong khoảng thời gian đã chọn.</div>';
  }

  function renderRow(row) {
    const completed = row.status === "completed";
    const statusLabel = completed ? "완료 / Hoàn tất" : "진행중 / Đang xử lý";
    const customerLabel = row.customer_type === "company" ? "회사 / Công ty" : "개인 / Cá nhân";
    const partnerSettlement = row.cost_settlement_type === "partner";
    const costSettlementLabel = partnerSettlement
      ? `거래처 보유분 / Suất của đối tác · ${row.cost_partner_name || "Chị Oanh"}`
      : "골프장 직접 / Sân golf trực tiếp";
    const rowPayments = paymentRowsFor(row);
    const rowTotals = paymentTotals(rowPayments);
    const actualProfit = !row.booking && completed && row.course_total_vnd != null
      ? (rowPayments.length ? rowTotals.received : Number(row.final_received_amount_vnd || 0))
        - Number(row.course_total_vnd)
      : null;
    return `
      <article class="golf-row" data-status="${escape(row.status)}">
        <div class="golf-row-head">
          <div><div class="golf-row-title">${escape(row.representative_name)}</div>${bookingBadge(row)}
          <div class="golf-row-sub">거래처 ${escape(row.counterparty_name || "—")} · ${escape(row.golf_course)} · ${escape(row.holes)}H · ${escape(row.pax)}명 · ${escape(customerLabel)}</div></div>
          <span class="qr-status" data-tone="${completed ? "ready" : "working"}">${escape(statusLabel)}</span>
        </div>
        <div class="golf-row-body">
          <div class="golf-detail-grid">
            <div class="golf-detail"><span>등록 일시 / Thời gian tạo</span><strong>${escape(dateTimeLabel(row.created_at))}</strong></div>
            <div class="golf-detail"><span>골프 / Ngày chơi</span><strong>${escape(golfDateLabel(row.golf_date))} ${escape(timeLabel(row.golf_time))}</strong></div>

            <div class="golf-detail"><span>1인 판매가 / Giá khách mỗi người</span><strong>${escape(moneyLabel(row.guest_unit_price_vnd))}</strong></div>
            <div class="golf-detail"><span>고객 합계 / Tổng tiền khách</span><strong>${escape(moneyLabel(row.guest_total_vnd))}</strong></div>
            <div class="golf-detail"><span>원가 정산 방식 / Cách quyết toán</span><strong>${escape(costSettlementLabel)}</strong></div>
            <div class="golf-detail"><span>1인 원가 / Giá vốn mỗi người</span><strong>${escape(moneyLabel(row.course_unit_price_vnd))}</strong></div>
            <div class="golf-detail"><span>${partnerSettlement ? "거래처 정산 합계 / Tổng quyết toán đối tác" : "골프장 합계 / Tổng tiền sân"}</span><strong>${escape(moneyLabel(row.course_total_vnd))}</strong></div>
            <div class="golf-detail"><span>S-CART</span><strong>${escape(row.smart_cart_note || "—")}</strong></div>
            <div class="golf-detail"><span>계약금 내역 / Chi tiết tiền cọc</span><strong>${row.booking ? "묶음 공통 / Chung cho cả nhóm" : escape(paymentDetailText(row, "deposit"))}</strong></div>
            <div class="golf-detail"><span>고객 총입금 / Tổng tiền khách đã trả</span><strong>${row.booking ? "묶음 공통 / Chung cho cả nhóm" : `${escape(moneyLabel(rowTotals.received))}\n${escape(paymentDetailText(row, "receipt"))}`}</strong></div>
            <div class="golf-detail"><span>실제 수익 / Lợi nhuận</span><strong>${row.booking ? "묶음 전체에서 확인 / Xem tổng nhóm" : escape(moneyLabel(actualProfit))}</strong></div>
          </div>
          <div class="golf-row-names"><strong>영문 명단 / Danh sách tên tiếng Anh</strong>\n${escape(row.player_names_en)}</div>
          ${row.note ? `<div class="golf-row-note"><strong>비고 / Ghi chú:</strong> ${escape(row.note)}</div>` : ""}
        </div>
        <div class="golf-row-actions">
          <button class="qr-btn qr-btn-small" type="button" data-action="edit" data-id="${escape(row.id)}">${row.booking ? "일정 수정·묶음 입금 / Sửa lịch · Thu tiền nhóm" : completed ? "수정 / Chỉnh sửa" : "수정·입금 / Sửa khoản thu"}</button>
          <button class="qr-btn qr-btn-small qr-btn-danger" type="button" data-action="delete" data-id="${escape(row.id)}">삭제 / Xóa</button>
        </div>
      </article>`;
  }

  function managementEntries(rows) {
    const entries = [];
    const groups = new Map();
    for (const row of rows) {
      if (!row.booking) { entries.push({ row, booking: null }); continue; }
      let entry = groups.get(row.booking.id);
      if (!entry) {
        entry = { row, booking: row.booking, matchedRoundIds: new Set() };
        groups.set(row.booking.id, entry);
        entries.push(entry);
      }
      entry.matchedRoundIds.add(row.id);
    }
    return entries;
  }

  function renderGroupedRound(row, matched) {
    const route = row.cost_settlement_type === "partner"
      ? `거래처 보유분 / Suất của đối tác · ${row.cost_partner_name || "Chị Oanh"}`
      : "골프장 직접 / Sân golf trực tiếp";
    return `<section class="golf-group-round${matched ? "" : " is-outside-filter"}" data-group-round-id="${escape(row.id)}">
      <div class="golf-group-round-heading"><strong>${escape(golfDateLabel(row.golf_date))} ${escape(timeLabel(row.golf_time))} · ${escape(row.golf_course)} · ${escape(row.holes)}H · ${escape(row.pax)}명 / khách</strong>
        <span>${matched ? "조회 조건 일치 / Trong bộ lọc" : "조회 조건 밖 일정 / Ngoài bộ lọc"}</span></div>
      <div class="golf-detail-grid">
        <div class="golf-detail"><span>이 일정 판매 합계 / Tiền khách của lịch này</span><strong>${escape(moneyLabel(row.guest_total_vnd))}</strong></div>
        <div class="golf-detail"><span>이 일정 원가 합계 / Giá vốn của lịch này</span><strong>${escape(moneyLabel(row.course_total_vnd))}</strong></div>
        <div class="golf-detail"><span>S-CART · ${escape(route)}</span><strong>${escape(row.smart_cart_note || "—")}</strong></div>
      </div>
      <div class="golf-row-names"><strong>영문 명단 · ${escape(row.pax)}명 / Danh sách · ${escape(row.pax)} khách</strong>\n${escape(row.player_names_en)}</div>
      ${row.note ? `<div class="golf-row-note"><strong>비고 / Ghi chú:</strong> ${escape(row.note)}</div>` : ""}
      <div class="golf-group-round-actions">
        <button class="qr-btn qr-btn-small" type="button" data-action="edit" data-id="${escape(row.id)}">이 일정 수정 / Sửa lịch này</button>
        <button class="qr-btn qr-btn-small qr-btn-danger" type="button" data-action="delete" data-id="${escape(row.id)}">이 일정만 삭제 / Chỉ xóa lịch này</button>
      </div>
    </section>`;
  }

  function renderBookingGroup(entry) {
    const { row, booking, matchedRoundIds } = entry;
    const completed = Boolean(booking.completed_at);
    const totals = paymentTotals(booking.payments);
    const remaining = booking.guest_total_vnd == null ? null : booking.guest_total_vnd - totals.received;
    const profit = completed && booking.cost_total_vnd != null ? totals.received - booking.cost_total_vnd : null;
    const rounds = booking.rounds.slice().sort((a, b) => `${a.golf_date} ${a.golf_time} ${a.id}`.localeCompare(`${b.golf_date} ${b.golf_time} ${b.id}`));
    return `<article class="golf-row golf-group-card" data-booking-group-id="${escape(booking.id)}" data-status="${completed ? "completed" : "in_progress"}">
      <div class="golf-row-head">
        <div><div class="golf-row-title">${escape(booking.label)}</div>${bookingBadge(row)}
          <div class="golf-row-sub">거래처 / Đối tác: ${escape(row.counterparty_name || "—")} · ${row.customer_type === "company" ? "회사 / Công ty" : "개인 / Cá nhân"}</div>
          <div class="golf-row-sub">${escape(dateLabel(booking.range_from))} ~ ${escape(dateLabel(booking.range_to))}</div>
        </div>
        <span class="qr-status" data-tone="${completed ? "ready" : "working"}">${completed ? "묶음 완료 / Nhóm hoàn tất" : "묶음 진행중 / Nhóm đang xử lý"}</span>
      </div>
      <div class="golf-row-body">
        <p class="golf-group-filter-scope">조회 조건 일치 ${matchedRoundIds.size} / 전체 ${rounds.length}일정 · 아래에는 묶음의 모든 일정을 표시합니다.<br />${matchedRoundIds.size} / ${rounds.length} lịch khớp bộ lọc · Hiển thị toàn bộ lịch của nhóm bên dưới.</p>
        <div class="golf-detail-grid">
          <div class="golf-detail"><span>묶음 판매 합계 / Tổng tiền khách cả nhóm</span><strong>${escape(moneyLabel(booking.guest_total_vnd))}</strong></div>
          <div class="golf-detail"><span>묶음 원가 합계 / Tổng giá vốn cả nhóm</span><strong>${escape(moneyLabel(booking.cost_total_vnd))}</strong></div>
          <div class="golf-detail"><span>묶음 계약금 합계 / Tiền cọc chung</span><strong>${escape(moneyLabel(totals.deposit))}</strong></div>
          <div class="golf-detail"><span>묶음 총입금 / Tổng đã thu cả nhóm</span><strong>${escape(moneyLabel(totals.received))}</strong></div>
          <div class="golf-detail"><span>묶음 미수금 / Công nợ cả nhóm</span><strong>${escape(moneyLabel(remaining))}</strong></div>
          <div class="golf-detail"><span>묶음 실제 수익 / Lợi nhuận cả nhóm</span><strong>${escape(moneyLabel(profit))}</strong></div>
        </div>
        <details class="golf-group-payments"><summary>공통 계약금·입금 내역 / Chi tiết tiền cọc và khoản thu chung</summary>
          <div class="golf-row-names"><strong>계약금 / Tiền cọc</strong>\n${escape(paymentDetailText(row, "deposit"))}\n\n<strong>추가 입금·잔금 / Khoản thu thêm</strong>\n${escape(paymentDetailText(row, "receipt"))}</div>
        </details>
        <div class="golf-group-rounds">${rounds.map((round) => renderGroupedRound(round, matchedRoundIds.has(round.id))).join("")}</div>
      </div>
      <div class="golf-row-actions"><button class="qr-btn qr-btn-small qr-btn-primary" type="button" data-action="edit" data-id="${escape(row.id)}">묶음 입금·완료 처리 / Thu tiền · Hoàn tất cả nhóm</button><button class="qr-btn qr-btn-small qr-btn-danger" type="button" data-action="delete-group" data-id="${escape(row.id)}">묶음 전체 삭제 / Xóa toàn bộ nhóm</button></div>
    </article>`;
  }

  function render() {
    const rows = filteredRows();
    const receivableMode = state.statusFilter === "receivable";
    byId("receivablePanel").hidden = !receivableMode;
    byId("reservationList").hidden = receivableMode;
    if (receivableMode) {
      renderReceivables(rows, byId("filterFrom").value, byId("filterTo").value);
      return;
    }
    const entries = managementEntries(rows);
    const hasGroups = entries.some((entry) => entry.booking);
    byId("listCount").textContent = hasGroups
      ? `${entries.length.toLocaleString("ko-KR")}개 예약 · 조회 조건 일치 ${rows.length.toLocaleString("ko-KR")}일정 / ${entries.length} đặt sân · ${rows.length} lịch khớp bộ lọc`
      : `${rows.length.toLocaleString("ko-KR")}건 / mục`;
    byId("reservationList").innerHTML = entries.length ? entries.map((entry) => entry.booking ? renderBookingGroup(entry) : renderRow(entry.row)).join("")
      : '<div class="qr-empty">조건에 맞는 골프 예약이 없습니다.<br />Không có đặt sân phù hợp.</div>';
  }

  async function loadRows(options = {}) {
    QRStaff.connectionBadge("connecting", "불러오는 중");
    try {
      const [reservations, payments, partnerOffsets] = await Promise.all([
        DGV.collectSupabasePages(
          () => sb.from("golf_reservations").select(COLUMNS),
          { pageSize: 500, order: [
            { column: "golf_date", ascending: true }, { column: "golf_time", ascending: true },
            { column: "id", ascending: true }
          ] }
        ),
        DGV.collectSupabasePages(
          () => sb.from("golf_reservation_payments").select(PAYMENT_COLUMNS),
          { pageSize: 500, order: [
            { column: "payment_date", ascending: true }, { column: "sort_order", ascending: true },
            { column: "id", ascending: true }
          ] }
        ),
        DGV.collectSupabasePages(
          () => sb.from("golf_partner_reservation_offsets").select(PARTNER_OFFSET_COLUMNS).eq("active", true),
          { pageSize: 500, order: [
            { column: "golf_date", ascending: true }, { column: "reservation_id", ascending: true }
          ] }
        )
      ]);
      const paymentsByReservation = new Map();
      for (const payment of payments) {
        if (!paymentsByReservation.has(payment.reservation_id)) paymentsByReservation.set(payment.reservation_id, []);
        paymentsByReservation.get(payment.reservation_id).push(payment);
      }
      const loadedRows = reservations.map((row) => ({
        ...row,
        payments: paymentsByReservation.get(row.id) || []
      }));
      if (global.GolfBookings) await global.GolfBookings.loadAndAttach(loadedRows);
      if (loadedRows.some((row) => row.booking_group_id && row.booking?.id !== row.booking_group_id)) {
        throw new Error("묶음예약 정보를 불러오지 못했습니다. 새로고침해 주세요. / Không tải được thông tin nhóm; vui lòng tải lại.");
      }
      state.rows = loadedRows;
      state.partnerOffsets = partnerOffsets;
      state.rows.sort((a, b) => {
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
    if (embeddedEditor && (!embeddedEditor.ready || embeddedEditor.saved || embeddedEditor.closing || embeddedEditor.createUncertain
      || (embeddedEditor.mode === "create" ? Boolean(byId("recordId").value) : !embeddedEditor.allowedRoundIds.has(byId("recordId").value)))) return;
    if (state.createGroupMode) { await saveCreatedGroup(); return; }
    let payload;
    try { payload = payloadFromForm(); }
    catch (error) { QRStaff.toast(error.message, "error"); return; }
    const id = byId("recordId").value;
    const loadedBooking = rowById(id)?.booking || null;
    const booking = loadedBooking ? { ...loadedBooking, version: state.editingGroupVersion ?? loadedBooking.version } : null;
    if (booking && Boolean(booking.completed_at) !== byId("paymentCompleted").checked) {
      const verb = byId("paymentCompleted").checked
        ? "모든 일정을 완료하고 일정별 원가를 정산합니다. / Hoàn tất tất cả lịch và ghi nhận giá vốn."
        : "모든 일정을 진행중으로 바꾸고 원가 차감을 복원합니다. / Chuyển tất cả lịch về đang xử lý và hoàn lại khấu trừ.";
      if (!global.confirm(`${booking.label} · ${booking.rounds.length}일정 / lịch\n${verb}\n계속하시겠습니까? / Bạn có muốn tiếp tục?`)) return;
    }
    state.saving = true;
    if (embeddedEditor) setCreateLocked(true);
    QRStaff.setBusy(byId("saveButton"), true, "저장 중…");
    try {
      const { data, error } = booking
        ? await sb.rpc("save_golf_booking_group", {
          p_group_id: booking.id, p_round_id: id,
          p_reservation: payload.reservation, p_payments: payload.payments,
          p_expected_version: booking.version
        })
        : await sb.rpc("save_golf_reservation_with_payments", {
          p_reservation_id: id || null,
          p_reservation: payload.reservation,
          p_payments: payload.payments
        });
      if (error) throw error;
      if (!Array.isArray(data) || !data[0]?.saved_id || (embeddedEditor && !UUID_PATTERN.test(data[0].saved_id))) throw new Error("저장된 예약을 확인하지 못했습니다.");
      QRStaff.toast(booking ? "일정과 묶음 전체 입금·상태를 저장했습니다. / Đã lưu lịch và khoản thu, trạng thái của cả nhóm." : id ? "골프 예약을 수정했습니다." : "골프 예약을 등록했습니다.", "ok");
      if (embeddedEditor) {
        finishEmbeddedSave(data[0]);
        return;
      }
      resetForm({ focus: false });
      await loadRows({ quiet: true });
    } catch (error) {
      console.error(error);
      if (embeddedEditor?.mode === "create" && !embeddedEditor.saved && !isDefiniteCreateRejection(error)) {
        embeddedEditor.createUncertain = true;
        const warning = "저장 결과를 확인하지 못했습니다. 중복 등록 방지를 위해 재저장을 막았습니다. 창을 닫고 목록에서 저장 여부를 먼저 확인해 주세요. / Chưa xác nhận kết quả lưu. Đã khóa lưu lại để tránh trùng; hãy đóng cửa sổ và kiểm tra danh sách trước.";
        setBanner(warning, "error");
        QRStaff.toast(warning, "error");
      } else QRStaff.toast(QRStaff.messageOf(error, "골프 예약을 저장하지 못했습니다. 입력 내용을 확인해 주세요."), "error");
    } finally {
      state.saving = Boolean(embeddedEditor?.saved);
      if (embeddedEditor && !embeddedEditor.saved && !embeddedEditor.createUncertain) setCreateLocked(false);
      QRStaff.setBusy(byId("saveButton"), state.saving || Boolean(embeddedEditor?.createUncertain), state.saving ? "저장 완료 / Đã lưu" : embeddedEditor?.createUncertain ? "목록에서 저장 여부 확인 / Kiểm tra danh sách" : undefined);
      if (!state.saving && !embeddedEditor?.createUncertain) byId("saveButton").textContent = byId("recordId").value ? "변경 저장 / Lưu thay đổi" : "예약 저장 / Lưu đặt chỗ";
    }
  }

  async function removeRow(row) {
    if (embeddedEditor) return;
    const warning = row.booking
      ? `${row.representative_name}의 ${dateLabel(row.golf_date)} ${row.golf_course} 일정만 삭제합니다. 묶음 입금내역은 유지됩니다. 삭제한 일정은 복구할 수 없습니다.\nChỉ xóa lịch này, giữ nguyên khoản thu của nhóm. Không thể khôi phục lịch đã xóa.`
      : `${row.representative_name} 예약을 삭제합니다. 삭제한 기록은 복구할 수 없습니다.\n\nBạn có chắc muốn xóa đặt sân này không?`;
    if (!global.confirm(warning)) return;
    try {
      const { data, error } = row.booking
        ? await sb.rpc("delete_golf_booking_round", { p_reservation_id: row.id, p_expected_version: row.booking.version })
        : await sb.from("golf_reservations").delete().eq("id", row.id).select("id").single();
      if (error) throw error;
      if (!row.booking && !data?.id) throw new Error("삭제할 예약을 찾지 못했습니다.");
      if (byId("recordId").value === row.id || (row.booking && editingBooking()?.id === row.booking.id)) resetForm({ focus: false });
      QRStaff.toast("골프 예약을 삭제했습니다.", "ok");
      await loadRows({ quiet: true });
    } catch (error) {
      console.error(error);
      QRStaff.toast(QRStaff.messageOf(error, "골프 예약을 삭제하지 못했습니다. 다시 시도해 주세요."), "error");
    }
  }

  async function deleteBookingGroup(booking) {
    if (embeddedEditor) return;
    if (!booking || !canLeaveEditedBooking()) return;
    const totals = paymentTotals(booking.payments);
    const warning = `${booking.label}\n전체 ${booking.rounds.length}개 일정 / Toàn bộ ${booking.rounds.length} lịch\n계약금 / Tiền cọc: ${moneyLabel(totals.deposit)}\n추가 입금·잔금 / Khoản thu thêm: ${moneyLabel(totals.receipt)}\n\n묶음의 모든 일정과 공통 입금 내역이 삭제되며 복구할 수 없습니다. 활성 골프장 차감과 거래처 정산 차감은 복원됩니다.\nXóa toàn bộ lịch và sổ thu chung của nhóm, không thể khôi phục. Các khoản khấu trừ đang hiệu lực của sân và đối tác sẽ được hoàn lại.\n\n입금 기록만 삭제되며 실제 고객 환불은 처리되지 않습니다.\nChỉ xóa bản ghi khoản thu, không thực hiện hoàn tiền thực tế cho khách.\n\n정말 묶음 전체를 삭제하시겠습니까? / Bạn có chắc muốn xóa toàn bộ nhóm?`;
    if (!global.confirm(warning)) return;
    const editingThisGroup = editingBooking()?.id === booking.id;
    state.saving = true;
    setCreateLocked(true);
    try {
      const { data, error } = await sb.rpc("delete_golf_booking_group", {
        p_group_id: booking.id, p_expected_version: booking.version
      });
      if (error) throw error;
      if (data !== booking.id) throw new Error("삭제 응답을 확인하지 못했습니다. / Chưa xác nhận kết quả xóa.");
      if (editingThisGroup) resetForm({ focus: false });
      QRStaff.toast("묶음 전체와 공통 입금 내역을 삭제했습니다. / Đã xóa toàn bộ nhóm và sổ thu chung.", "ok");
      await loadRows({ quiet: true });
    } catch (error) {
      QRStaff.toast(QRStaff.messageOf(error, "묶음 삭제 결과를 확인하지 못했습니다. 새로고침 후 확인해 주세요. / Chưa xác nhận kết quả xóa nhóm; vui lòng tải lại để kiểm tra."), "error");
      const loaded = await loadRows({ quiet: true });
      if (loaded && editingThisGroup && !state.rows.some((row) => row.booking?.id === booking.id)) resetForm({ focus: false });
    } finally {
      state.saving = false;
      setCreateLocked(false);
    }
  }

  function rowById(id) { return state.rows.find((row) => row.id === id) || null; }

  function canLeaveEditedBooking() {
    if (state.saving) return false;
    if (state.createAttempt?.uncertain) {
      QRStaff.toast("먼저 동일 내용 재시도로 저장 결과를 확인해 주세요. / Vui lòng thử lại cùng nội dung để xác nhận kết quả trước.", "error");
      return false;
    }
    if ((!editingBooking() && !state.createGroupMode && !embeddedEditor) || !state.formDirty) return true;
    return global.confirm("저장하지 않은 일정·묶음 입금 변경사항을 버리고 이동하시겠습니까?\nBạn có muốn bỏ các thay đổi chưa lưu của lịch và khoản thu chung để chuyển mục?");
  }

  function openRequestedEdit() {
    if (embeddedEditor?.mode === "create") return;
    const params = new URLSearchParams(global.location.search);
    if (!params.has("edit")) return;
    const rawId = clean(params.get("edit"));
    if (!embeddedEditor) {
      params.delete("edit");
      const query = params.toString();
      const nextUrl = `${global.location.pathname}${query ? `?${query}` : ""}${global.location.hash}`;
      global.history.replaceState(null, "", nextUrl);
    }
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

  function cashLimitMessage() {
    return "5,000,000 VND 이상은 은행 거래가 필요합니다. / Giao dịch từ 5.000.000 VND phải chuyển khoản ngân hàng.";
  }

  function handlePaymentFieldEvent(event) {
    const field = event.target.closest("[data-payment-field]");
    if (!field) return;
    const rowElement = field.closest("[data-payment-kind][data-payment-index]");
    if (!rowElement) return;
    const kind = rowElement.dataset.paymentKind;
    const index = Number(rowElement.dataset.paymentIndex);
    const payment = state.paymentDrafts[kind]?.[index];
    if (!payment) return;
    const fieldName = field.dataset.paymentField;
    if (fieldName === "amount_vnd") {
      formatMoneyInput(field);
      payment.amount_vnd = moneyNumber(field.value);
    } else if (fieldName === "payment_date") {
      payment.payment_date = field.value;
    } else if (fieldName === "payment_method") {
      payment.payment_method = PAYMENT_METHODS.has(field.value) ? field.value : null;
    }
    if (payment.payment_method === "cash" && Number(payment.amount_vnd) >= CASH_BANK_THRESHOLD) {
      payment.payment_method = null;
      const select = rowElement.querySelector('[data-payment-field="payment_method"]');
      if (select) select.value = "";
      QRStaff.toast(cashLimitMessage(), "error");
    }
    updatePreview();
  }

  function handlePaymentClick(event) {
    const addButton = event.target.closest("[data-add-payment]");
    if (addButton) {
      const kind = addButton.dataset.addPayment;
      if (!VISIBLE_PAYMENT_KINDS.includes(kind)) return;
      state.formDirty = true;
      state.paymentDrafts[kind].push(newPaymentDraft(kind, { payment_date: todayYmd() }));
      renderPaymentKind(kind);
      updatePreview();
      const rows = byId(paymentContainerId(kind)).querySelectorAll(".golf-payment-row");
      rows[rows.length - 1]?.querySelector(".golf-payment-amount")?.focus();
      return;
    }
    const deleteButton = event.target.closest("[data-delete-payment]");
    if (!deleteButton) return;
    const rowElement = deleteButton.closest("[data-payment-kind][data-payment-index]");
    if (!rowElement) return;
    const kind = rowElement.dataset.paymentKind;
    const index = Number(rowElement.dataset.paymentIndex);
    state.formDirty = true;
    state.paymentDrafts[kind]?.splice(index, 1);
    renderPaymentKind(kind);
    updatePreview();
  }

  function bindEvents() {
    global.addEventListener("message", handleEditorMessage);
    if (embeddedEditor) {
      document.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        requestEmbeddedClose();
      });
      document.addEventListener("click", (event) => {
        if (event.target.closest?.("a[href]")) event.preventDefault();
      }, true);
    }
    global.addEventListener("beforeunload", (event) => {
      if (embeddedEditor?.saved || embeddedEditor?.closing) return;
      if (state.createAttempt?.uncertain || (state.createGroupMode && (state.formDirty || state.saving))
        || (embeddedEditor?.ready && !embeddedEditor.saved && !embeddedEditor.closing && (state.formDirty || state.saving || embeddedEditor.createUncertain))) {
        event.preventDefault();
        event.returnValue = "";
      }
    });
    byId("bookingMode").addEventListener("change", changeBookingMode);
    byId("addCreateRoundButton").addEventListener("click", addCreateRound);
    byId("removeCreateRoundButton").addEventListener("click", removeCreateRound);
    byId("createGroupSchedules").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-create-round-index]");
      if (button) switchCreateRound(Number(button.dataset.createRoundIndex));
    });
    byId("reservationForm").addEventListener("input", refreshCreateRoundLabel);
    byId("reservationForm").addEventListener("change", refreshCreateRoundLabel);
    byId("reservationForm").addEventListener("submit", save);
    byId("reservationForm").addEventListener("click", handlePaymentClick);
    byId("reservationForm").addEventListener("input", handlePaymentFieldEvent);
    byId("reservationForm").addEventListener("change", handlePaymentFieldEvent);
    byId("reservationForm").addEventListener("input", () => { state.formDirty = true; });
    byId("reservationForm").addEventListener("change", () => { state.formDirty = true; });
    byId("resetButton").addEventListener("click", () => { if (canLeaveEditedBooking()) resetForm(); });
    byId("cancelEditButton").addEventListener("click", () => { if (canLeaveEditedBooking()) resetForm(); });
    byId("bookingGroupSchedules").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-edit-group-round]");
      if (!button || button.dataset.editGroupRound === byId("recordId").value) return;
      const row = rowById(button.dataset.editGroupRound);
      if (row && canLeaveEditedBooking()) fillForm(row, { focusFinal: false });
    });
    byId("clearFiltersButton").addEventListener("click", () => {
      byId("searchInput").value = ""; byId("filterFrom").value = ""; byId("filterTo").value = ""; render();
    });
    for (const input of document.querySelectorAll(".golf-money-input")) {
      input.addEventListener("input", () => { formatMoneyInput(input); updatePreview(); });
      input.addEventListener("blur", () => formatMoneyInput(input));
    }
    byId("pax").addEventListener("input", updatePreview);
    byId("smartCartNote").addEventListener("input", updatePreview);
    byId("smartCartNote").addEventListener("blur", updatePreview);
    byId("costSettlementType").addEventListener("change", updatePreview);
    byId("playerNamesEn").addEventListener("input", () => {
      const count = namesCount(byId("playerNamesEn").value);
      if (count) byId("pax").value = String(count);
      byId("representativeName").value = firstPlayerName(byId("playerNamesEn").value);
      updatePreview();
    });
    byId("paymentCompleted").addEventListener("change", updatePreview);
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
      if (button.dataset.action === "edit" && canLeaveEditedBooking()) fillForm(row, { focusFinal: row.status === "in_progress" });
      if (button.dataset.action === "delete" && canLeaveEditedBooking()) removeRow(row);
      if (button.dataset.action === "delete-group") deleteBookingGroup(row.booking);
    });
  }

  async function init() {
    configureEmbeddedEditor();
    bindEvents();
    resetForm({ focus: false });
    if (embeddedEditor) setCreateLocked(true);
    try {
      state.identity = await QRStaff.requireLogin({ roles: ["manager", "admin"], preferredRole: "manager" });
      document.body.classList.remove("locked");
      const loaded = await loadRows({ quiet: true });
      if (loaded) openRequestedEdit();
      if (embeddedEditor) {
        if (loaded) completeEmbeddedLoad();
        else sendEditorMessage("golf-editor-error");
      }
    } catch (error) {
      console.error(error);
      QRStaff.connectionBadge("offline", "로그인 오류");
      setBanner("로그인 화면을 불러오지 못했습니다. 페이지를 새로고침해 주세요.", "error");
      sendEditorMessage("golf-editor-error");
    }
  }

  init();
})(window);
