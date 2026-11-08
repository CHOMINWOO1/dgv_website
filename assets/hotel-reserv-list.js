(function () {
  "use strict";
  const byId = (id) => document.getElementById(id);
  const form = byId("hotelForm");
  const propertyForm = byId("propertyForm");
  const roomTypeForm = byId("roomTypeForm");
  const gradeForm = byId("gradeForm");
  const extraBedForm = byId("extraBedForm");
  const pricing = HotelPricing;
  const amount = new Intl.NumberFormat("en-US");
  const weekdays = ["일/CN","월/T2","화/T3","수/T4","목/T5","금/T6","토/T7"];
  const roomKinds = ["TWIN", "DOUBLE", "TRIPLE"];
  const rateKeys = ["weekday_purchase", "weekday_sale", "weekend_purchase", "weekend_sale"];
  const roomKindLabel = kind => ({ DOUBLE: "더블 / Giường đôi", TWIN: "트윈 / Hai giường đơn", TRIPLE: "트리플 / Phòng ba" })[kind] || kind;
  let hotels = [];
  let reservations = [];
  let appliedPeriod = { fromDate: "", toDate: "", status: "in_progress" };
  let roomTypes = [];
  let roomGrades = [];
  let gradeDraft = [];
  let editingGrade = null;
  let gradeId;
  let roomItems = [];
  let useRoomTypes = true;
  let managedHotel = null;
  let editingExtraBedHotel = null;
  let editingRoomType = null;
  let roomTypeId;
  let detailReservationId = null;
  let editing = null;
  let editingHotel = null;
  let reservationId;
  let propertyId;
  let busy = false;
  let ready = false;
  const table = (name) => DGV.supabase.from(name);
  const field = (name) => form.elements.namedItem(name);
  const moneyText = (value) => amount.format(value) + " VND";
  const optionalMoney = value => value == null ? "—" : moneyText(value);
  function rawMoneyInput(value) {
    const text = String(value ?? "").trim();
    if (/^[0-9,]+$/.test(text)) return text.replace(/,/g, "");
    return /^\d{1,3}(?:\.\d{3})+$/.test(text) ? text.replace(/\./g, "") : text;
  }
  function formatMoneyInput(input) {
    const raw = rawMoneyInput(input.value);
    const position = input.selectionStart;
    const trailing = position == null ? 0 : input.value.slice(position).replace(/\D/g, "").length;
    const valid = /^\d*$/.test(raw) && (!raw || Number(raw) <= 999999999999);
    input.setCustomValidity(valid ? "" : "금액은 0 이상 999,999,999,999 이하의 정수로 입력해 주세요. / Vui lòng nhập số tiền nguyên từ 0 đến 999,999,999,999 VND.");
    if (!/^\d*$/.test(raw)) return;
    input.value = raw.replace(/^0+(?=\d)/, "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    if (position != null && document.activeElement === input) {
      let caret = input.value.length, remaining = trailing;
      while (caret > 0 && remaining > 0) { caret--; if (/\d/.test(input.value[caret])) remaining--; }
    while (caret > 0 && input.value[caret - 1] === ",") caret--;
    input.setSelectionRange(caret, caret);
    }
  }
  function enableMoneyInput(input) {
    if (input.dataset.hotelMoney) { formatMoneyInput(input); return; }
    input.dataset.hotelMoney = "true";
    input.type = "text";
    input.inputMode = "numeric";
    input.autocomplete = "off";
    input.pattern = "[0-9]+|[0-9]{1,3}(,[0-9]{3})+";
    input.addEventListener("input", () => formatMoneyInput(input));
    input.addEventListener("blur", () => formatMoneyInput(input));
    formatMoneyInput(input);
  }
  function formatMoneyFields(container) {
    container.querySelectorAll('input[data-hotel-money], input[type="number"][max="999999999999"]').forEach(enableMoneyInput);
  }
  for (const moneyForm of [form, roomTypeForm, extraBedForm]) {
    moneyForm.addEventListener("formdata", event => {
      moneyForm.querySelectorAll('input[data-hotel-money][name]:not(:disabled)').forEach(input => event.formData.set(input.name, rawMoneyInput(input.value)));
    });
  }
  const roomTypeName = item => item.name || roomTypes.find(type => type.id === item.room_type_id)?.name || "룸타입 / Loại phòng";
  const roomLineLabel = item => item.grade_id && item.room_kind
    ? (item.room_grade || item.grade_name || "등급 / Hạng") + " · " + roomKindLabel(item.room_kind)
    : roomTypeName(item) + " · " + (item.room_grade || "STANDARD") + " (기존 / cũ)";
  const roomDescription = record => (Array.isArray(record.room_items) && record.room_items.length
    ? record.room_items.map(item => roomLineLabel(item) + " × " + item.room_count).join("\n")
    : "기존 요금 / Giá đã lưu") + (record.extra_bed_count ? "\n추가 침대 / Giường phụ × " + record.extra_bed_count : "");

  function errorText(error) {
    if (error.code === "23503") return "예약에 사용 중인 호텔·룸타입은 삭제할 수 없습니다. / Không thể xóa khách sạn hoặc loại phòng đang có đặt phòng.";
    if (error.code === "23505") return "같은 이름의 항목이 이미 있습니다. 이름을 확인해 주세요. / Tên này đã tồn tại, vui lòng kiểm tra lại.";
    if (error.code === "40001" || error.code === "PGRST116") {
      return "다른 곳에서 정보가 변경되었습니다. 닫고 새로고침한 뒤 다시 확인해 주세요. / Dữ liệu đã thay đổi, hãy tải lại.";
    }
    return error.message || "처리하지 못했습니다. 새로고침해 주세요. / Không thể xử lý, hãy tải lại.";
  }

  function message(id, text) {
    byId(id).textContent = text;
    byId(id).hidden = !text;
  }

  function setBusy(value) {
    busy = value;
    for (const button of document.querySelectorAll("#hotelApp button, .hotel-dialog button")) button.disabled = value;
    byId("propertyFields").disabled = value;
    byId("reservationFields").disabled = value;
    byId("roomTypeFields").disabled = value;
    byId("gradeFields").disabled = value;
    byId("extraBedFields").disabled = value;
    byId("hotelPeriodFields").disabled = value;
  }

  function periodDraft() {
    return { fromDate: byId("hotelFromDate").value, toDate: byId("hotelToDate").value };
  }

  function updatePeriodStatus() {
    const draft = periodDraft();
    const changed = draft.fromDate !== appliedPeriod.fromDate || draft.toDate !== appliedPeriod.toDate;
    byId("hotelPeriodStatus").textContent = HotelReport.periodLabel(appliedPeriod)
      + (changed ? " · 변경한 기간은 조회·출력 시 적용됩니다. / Khoảng ngày mới được áp dụng khi tra cứu, in hoặc xuất Excel." : "");
  }

  function applyPeriodDraft() {
    try {
      if (["hotelFromDate", "hotelToDate"].some(id => byId(id).validity && !byId(id).validity.valid)) {
        throw new Error("시작일과 종료일을 올바르게 선택해 주세요. / Vui lòng chọn ngày bắt đầu và ngày kết thúc hợp lệ.");
      }
      appliedPeriod = HotelReport.normalizePeriod(periodDraft());
      const query = byId("hotelQuery")?.value?.trim() || "";
      if (query) appliedPeriod.query = query;
      const status = byId("hotelStatus").value;
      if (["in_progress", "completed"].includes(status)) appliedPeriod.status = status;
      message("hotelPeriodError", "");
      render();
      return true;
    } catch (error) {
      message("hotelPeriodError", errorText(error));
      return false;
    }
  }

  function action(label, handler) {
    const button = document.createElement("button");
    button.className = "qr-btn qr-btn-small";
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", handler);
    return button;
  }

  function renderRows(id, values, emptyText, columns) {
    const body = byId(id);
    body.replaceChildren();
    if (!values.length) {
      const cell = body.insertRow().insertCell();
      cell.colSpan = columns;
      cell.textContent = emptyText;
    }
    return body;
  }

  function render() {
    const properties = renderRows("propertyRows", hotels, "호텔을 먼저 등록해 주세요. / Thêm khách sạn trước.", 4);
    for (const hotel of hotels) {
      const row = properties.insertRow();
      const types = roomTypes.filter(type => type.hotel_id === hotel.id && !type.archived_at && !roomGrades.some(grade => grade.id === type.grade_id && grade.archived_at));
      const values = [hotel.name, roomGrades.filter(grade => grade.hotel_id === hotel.id && !grade.archived_at).length + "등급 / hạng · " + types.filter(type => type.is_active !== false).length + "타입 사용 / loại đang dùng",
        hotel.weekend_days.map(day => weekdays[day]).join(", ") || "없음 / Không có"];
      for (const value of values) row.insertCell().textContent = value;
      const controls = row.insertCell();
      controls.className = "hotel-actions";
      controls.append(action("등급·룸타입 / Hạng·loại phòng", () => openRoomTypes(hotel)), " ", action("수정 / Sửa", () => openHotel(hotel)), " ", action("삭제 / Xóa", () => remove("hotel_properties", hotel)));
    }
    byId("hotelCount").textContent = hotels.length + "개 / khách sạn";
    const visibleReservations = HotelReport.filterRows(reservations, appliedPeriod);
    const body = renderRows("hotelRows", visibleReservations, "조회 조건에 해당하는 예약이 없습니다. / Không có đặt phòng theo điều kiện đã chọn.", 20);
    for (const reservation of visibleReservations) {
      const row = body.insertRow();
      const mode = reservation.pricing_mode === "standard"
        ? "일반 / Thường (" + reservation.weekday_nights + " 주중 + " + reservation.weekend_nights + " 주말)"
        : reservation.pricing_mode === "legacy" ? "기존 직접입력 / Giá cũ" : "서차지 / Phụ thu";
      const values = [reservation.hotel_name, reservation.check_in, reservation.check_out,
        reservation.guest_count + "명 · " + reservation.room_count + "룸\n" + roomDescription(reservation), reservation.guest_names, mode,
        moneyText(reservation.room_purchase_amount), moneyText(reservation.room_sale_amount),
        reservation.includes_meals ? moneyText(reservation.meal_purchase_amount) : "—",
        reservation.includes_meals ? moneyText(reservation.meal_sale_amount) : "—",
        moneyText(reservation.extra_bed_purchase_amount || 0), moneyText(reservation.extra_bed_sale_amount || 0),
        moneyText(reservation.purchase_amount), moneyText(reservation.sale_amount),
        optionalMoney(reservation.deposit_amount), optionalMoney(reservation.balance_amount),
        reservation.deposit_amount == null && reservation.balance_amount == null ? "—" : moneyText(Number(reservation.deposit_amount || 0) + Number(reservation.balance_amount || 0)),
        reservation.booking_reference || "—", reservation.note || "", HotelReport.statusLabel(reservation)];
      for (const value of values) row.insertCell().textContent = value;
      row.cells[4].className = "hotel-guests";
      row.cells[3].className = "hotel-guests";
      row.cells[17].className = "hotel-guests";
      row.cells[18].className = "hotel-guests";
      row.dataset.reservationId = reservation.id;
      row.tabIndex = 0;
      row.setAttribute("aria-haspopup", "dialog");
      row.setAttribute("aria-label", reservation.hotel_name + " · " + reservation.check_in + " · 예약 상세 / Chi tiết đặt phòng");
      row.addEventListener("click", event => {
        if (event.target.closest("button,a,input,select,textarea") || window.getSelection()?.toString().trim()) return;
        openReservationDetail(reservation.id);
      });
      row.addEventListener("keydown", event => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        openReservationDetail(reservation.id);
      });
    }
    byId("listCount").textContent = visibleReservations.length + "건 / đặt phòng";
    updatePeriodStatus();
    if (managedHotel && byId("roomTypeDialog").open) renderRoomTypes();
    if (detailReservationId && byId("hotelDetailDialog").open) {
      const latest = reservations.find(record => record.id === detailReservationId);
      if (latest) renderReservationDetail(latest);
    }
  }

  function renderReservationDetail(record) {
    const container = byId("hotelDetailContent");
    container.replaceChildren();
    byId("hotelDetailSubtitle").textContent = record.hotel_name + " · " + record.check_in + " ~ " + record.check_out;
    const card = title => {
      const section = document.createElement("section");
      section.className = "hotel-detail-card";
      const heading = document.createElement("h3");
      heading.textContent = title;
      section.append(heading);
      container.append(section);
      return section;
    };
    const detail = (section, label, value) => {
      const pair = document.createElement("dl");
      pair.className = "hotel-detail-field";
      const term = document.createElement("dt");
      const description = document.createElement("dd");
      term.textContent = label;
      description.textContent = value == null || value === "" ? "—" : String(value);
      pair.append(term, description);
      section.append(pair);
    };
    const info = card("예약 정보 / Thông tin đặt phòng");
    detail(info, "호텔 / Khách sạn", record.hotel_name);
    detail(info, "예약번호 / Mã đặt phòng", record.booking_reference);
    detail(info, "상태 / Trạng thái", HotelReport.statusLabel(record));
    detail(info, "체크인 / Nhận phòng", record.check_in);
    detail(info, "체크아웃 / Trả phòng", record.check_out);
    detail(info, "투숙객 인원 / Số khách", record.guest_count);
    detail(info, "객실 수 / Số phòng", record.room_count);
    detail(info, "추가 침대 수 / Số giường phụ", record.extra_bed_count || 0);
    detail(info, "전체 투숙객 명단 / Danh sách khách", record.guest_names);
    detail(info, "요금 방식 / Loại giá", record.pricing_mode === "standard" ? "일반 · 자동 계산 / Giá thường · tự động" : record.pricing_mode === "surcharge" ? "서차지 · 전체 직접입력 / Phụ thu · nhập tổng tiền" : "기존 직접입력 / Giá cũ");
    const totals = card("금액 및 입금 / Số tiền và khoản thu");
    for (const [label, key] of [
      ["객실 매입 / Tổng mua phòng", "room_purchase_amount"], ["객실 매출 / Tổng bán phòng", "room_sale_amount"],
      ["식사 매입 / Tổng mua bữa ăn", "meal_purchase_amount"], ["식사 매출 / Tổng bán bữa ăn", "meal_sale_amount"],
      ["추가 침대 매입 / Tổng mua giường phụ", "extra_bed_purchase_amount"], ["추가 침대 매출 / Tổng bán giường phụ", "extra_bed_sale_amount"],
      ["총 매입 / Tổng mua", "purchase_amount"], ["총 매출 / Tổng bán", "sale_amount"],
      ["계약금 / Tiền cọc", "deposit_amount"], ["잔금 입금액 / Tiền còn lại đã thu", "balance_amount"]
    ]) detail(totals, label, optionalMoney(record[key]));
    if (record.extra_bed_count) detail(totals, "추가 침대 1개·1박 매입 / 판매 · Giá mua / bán mỗi giường mỗi đêm", moneyText(record.extra_bed_rate_snapshot?.purchase || 0) + " / " + moneyText(record.extra_bed_rate_snapshot?.sale || 0));
    detail(totals, "입금 합계 / Tổng đã thu", record.deposit_amount == null && record.balance_amount == null ? "—" : moneyText(Number(record.deposit_amount || 0) + Number(record.balance_amount || 0)));
    const rooms = card("객실 상세 / Chi tiết phòng");
    const items = Array.isArray(record.room_items) && record.room_items.length ? record.room_items : [{
      name: "기존 요금 / Giá đã lưu", room_count: record.room_count, rate_snapshot: record.rate_snapshot,
      weekday_nights: record.weekday_nights, weekend_nights: record.weekend_nights,
      room_purchase_amount: record.room_purchase_amount, room_sale_amount: record.room_sale_amount
    }];
    for (const item of items) {
      const room = document.createElement("div");
      room.className = "hotel-detail-room";
      rooms.append(room);
      detail(room, "룸타입 / Loại phòng", item.grade_id && item.room_kind ? roomKindLabel(item.room_kind) : item.name || roomTypeName(item));
      if (item.room_grade) detail(room, "등급 / Hạng phòng", item.room_grade);
      detail(room, "객실 수 / Số phòng", item.room_count);
      detail(room, "주중·주말 숙박 / Đêm thường·cuối tuần", (item.weekday_nights ?? "—") + " / " + (item.weekend_nights ?? "—"));
      const rates = item.rate_snapshot || {};
      for (const [label, key] of [["주중 매입 단가 / Giá mua ngày thường", "weekday_purchase"], ["주중 매출 단가 / Giá bán ngày thường", "weekday_sale"], ["주말 매입 단가 / Giá mua cuối tuần", "weekend_purchase"], ["주말 매출 단가 / Giá bán cuối tuần", "weekend_sale"]]) detail(room, label, optionalMoney(rates[key]));
      detail(room, "객실 매입 / Mua phòng", optionalMoney(item.room_purchase_amount));
      detail(room, "객실 매출 / Bán phòng", optionalMoney(item.room_sale_amount));
    }
    const notes = card("기타 정보 / Thông tin khác");
    detail(notes, "비고 / Ghi chú", record.note);
    detail(notes, "내부 예약 ID / ID đặt phòng nội bộ", record.id);
    const timeText = value => {
      if (!value || !Number.isFinite(new Date(value).getTime())) return "—";
      return new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Ho_Chi_Minh", dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
    };
    if (record.created_at) detail(notes, "등록 일시 (베트남) / Tạo lúc (Việt Nam)", timeText(record.created_at));
    if (record.updated_at) detail(notes, "최근 수정 (베트남) / Cập nhật (Việt Nam)", timeText(record.updated_at));
  }

  function openReservationDetail(id) {
    if (busy || !ready) return;
    const latest = reservations.find(record => record.id === id);
    if (!latest) {
      message("pageStatus", "예약이 목록에 없습니다. 새로고침해 주세요. / Không tìm thấy đặt phòng, hãy tải lại.");
      return;
    }
    detailReservationId = id;
    message("hotelDetailError", "");
    renderReservationDetail(latest);
    if (!byId("hotelDetailDialog").open) byId("hotelDetailDialog").showModal();
  }

  async function refresh() {
    ready = false;
    message("pageStatus", "불러오는 중 / Đang tải");
    try {
      const result = await Promise.all([
        DGV.collectSupabasePages(() => table("hotel_properties").select("*"),
          { order: [{ column: "name" }, { column: "id" }] }),
        DGV.collectSupabasePages(() => table("hotel_reservations").select("*"),
          { order: [{ column: "check_in", ascending: false }, { column: "id" }] }),
        DGV.collectSupabasePages(() => table("hotel_room_types").select("*"),
          { order: [{ column: "hotel_id" }, { column: "name" }, { column: "id" }] }),
        DGV.collectSupabasePages(() => table("hotel_room_grades").select("*"),
          { order: [{ column: "hotel_id" }, { column: "name" }, { column: "id" }] })
      ]);
      [hotels, reservations, roomTypes, roomGrades] = result;
      roomTypes = roomTypes.map(type => ({ ...type, grade_name: type.grade_id ? roomGrades.find(grade => grade.id === type.grade_id)?.name || "" : null }));
      ready = true;
      render();
      message("pageStatus", "");
    } catch (error) {
      message("pageStatus", "목록을 불러오지 못했습니다. / Không thể tải danh sách. " + errorText(error));
    }
  }

  function openHotel(hotel) {
    if (busy || !ready) return;
    editingHotel = hotel || null;
    propertyId = hotel?.id || crypto.randomUUID();
    propertyForm.reset();
    if (hotel) {
      propertyForm.elements.namedItem("name").value = hotel.name;
      for (const checkbox of propertyForm.querySelectorAll('[name="weekend_days"]')) {
        checkbox.checked = hotel.weekend_days.includes(Number(checkbox.value));
      }
    }
    message("propertyError", "");
    byId("propertyTitle").textContent = hotel ? "호텔 수정 / Sửa khách sạn" : "호텔 등록 / Thêm khách sạn";
    byId("propertyDialog").showModal();
  }

  function resetGrade(grade) {
    if (grade?.archived_at) { resetGrade(); return; }
    editingGrade = grade || null;
    gradeId = grade?.id || crypto.randomUUID();
    gradeForm.reset();
    gradeForm.elements.namedItem("name").value = grade?.name || "";
    gradeDraft = roomKinds.map(kind => {
      const existing = grade && roomTypes.find(type => type.grade_id === grade.id && type.room_kind === kind);
      const draft = { room_kind: kind, is_active: existing ? !existing.archived_at && existing.is_active !== false : kind === "DOUBLE", version: existing?.version ?? null, archived_at: existing?.archived_at || null };
      for (const key of rateKeys) draft[key] = String(existing?.[key] ?? 0);
      draft.sameWeekend = draft.weekday_purchase === draft.weekend_purchase && draft.weekday_sale === draft.weekend_sale;
      return draft;
    });
    byId("gradeFormTitle").textContent = grade ? "객실 등급 수정 / Sửa hạng phòng" : "객실 등급 추가 / Thêm hạng phòng";
    gradeForm.hidden = false;
    roomTypeForm.hidden = true;
    message("gradeError", "");
    renderGradeTypes();
  }

  function renderGradeTypes() {
    const container = byId("gradeTypeRows");
    container.replaceChildren();
    if (gradeDraft.every(draft => draft.archived_at)) {
      container.textContent = "이 등급의 룸타입이 모두 삭제되었습니다. 등급을 삭제한 뒤 새로 등록할 수 있습니다. / Tất cả loại phòng của hạng này đã bị xóa. Có thể xóa hạng rồi tạo lại.";
    }
    gradeDraft.forEach(draft => {
      if (draft.archived_at) return;
      const section = document.createElement("div");
      section.className = "hotel-grade-type" + (draft.is_active ? "" : " is-disabled");
      section.dataset.roomKind = draft.room_kind;
      const head = document.createElement("div");
      head.className = "hotel-grade-type-head";
      const enabledLabel = document.createElement("label");
      enabledLabel.className = "hotel-toggle";
      const enabled = document.createElement("input");
      enabled.type = "checkbox";
      enabled.checked = draft.is_active;
      enabled.setAttribute("aria-label", roomKindLabel(draft.room_kind) + " 사용 / Dùng");
      enabled.dataset.enabled = draft.room_kind;
      enabled.addEventListener("change", () => { draft.is_active = enabled.checked; renderGradeTypes(); });
      enabledLabel.append(enabled, document.createTextNode(roomKindLabel(draft.room_kind) + " · " + draft.room_kind));
      head.append(enabledLabel);
      const copy = document.createElement("div");
      copy.className = "hotel-grade-copy";
      const source = document.createElement("select");
      source.className = "qr-select";
      source.setAttribute("aria-label", "가격 복사할 타입 / Loại phòng để sao chép giá");
      source.add(new Option("가격 복사 / Sao chép giá", ""));
      for (const other of gradeDraft.filter(item => item.room_kind !== draft.room_kind && item.is_active && !item.archived_at)) source.add(new Option(roomKindLabel(other.room_kind), other.room_kind));
      const copyButton = action("복사 / Chép", () => {
        if (busy || !draft.is_active) return;
        const previous = gradeDraft.find(item => item.room_kind === source.value && item.is_active && !item.archived_at);
        if (!previous) return message("gradeError", "가격을 복사할 사용 중인 타입을 선택해 주세요. / Chọn loại phòng đang dùng để sao chép giá.");
        for (const key of rateKeys) draft[key] = previous[key];
        draft.sameWeekend = previous.sameWeekend;
        message("gradeError", "");
        renderGradeTypes();
      });
      source.disabled = !draft.is_active;
      copyButton.disabled = !draft.is_active;
      copy.append(source, copyButton);
      head.append(copy);
      const fields = document.createElement("div");
      fields.className = "hotel-fields";
      const inputs = {};
      for (const [key, title] of [["weekday_purchase", "주중 매입 / Mua ngày thường"], ["weekday_sale", "주중 매출 / Bán ngày thường"], ["weekend_purchase", "주말 매입 / Mua cuối tuần"], ["weekend_sale", "주말 매출 / Bán cuối tuần"]]) {
        const label = document.createElement("label");
        const caption = document.createElement("span");
        caption.className = "qr-label";
        caption.textContent = title + " (VND)";
        const input = document.createElement("input");
        input.className = "qr-input";
        input.type = "number";
        input.min = "0";
        input.max = "999999999999";
        input.step = "1";
        input.value = draft[key];
        enableMoneyInput(input);
        input.dataset.rate = key;
        input.required = draft.is_active;
        input.disabled = !draft.is_active || (draft.sameWeekend && key.startsWith("weekend_"));
        input.addEventListener("input", () => {
          draft[key] = rawMoneyInput(input.value);
          if (draft.sameWeekend && key.startsWith("weekday_")) {
            const weekend = key.replace("weekday_", "weekend_");
            draft[weekend] = rawMoneyInput(input.value);
            inputs[weekend].value = input.value;
          }
        });
        inputs[key] = input;
        label.append(caption, input);
        fields.append(label);
      }
      const sameLabel = document.createElement("label");
      sameLabel.className = "hotel-toggle";
      const same = document.createElement("input");
      same.type = "checkbox";
      same.checked = draft.sameWeekend;
      same.disabled = !draft.is_active;
      same.dataset.sameWeekend = draft.room_kind;
      same.addEventListener("change", () => {
        draft.sameWeekend = same.checked;
        if (same.checked) {
          draft.weekend_purchase = draft.weekday_purchase;
          draft.weekend_sale = draft.weekday_sale;
        }
        renderGradeTypes();
      });
      sameLabel.append(same, document.createTextNode("주말 요금도 주중과 동일 / Giá cuối tuần giống ngày thường"));
      section.append(head, fields, sameLabel);
      container.append(section);
    });
  }

  function gradePayload() {
    const name = gradeForm.elements.namedItem("name").value.trim();
    if (!name) throw new Error("객실 등급명을 입력해 주세요. / Nhập tên hạng phòng.");
    if (!editingGrade && !gradeDraft.some(type => type.is_active)) throw new Error("한 가지 이상의 타입을 사용하도록 선택해 주세요. / Chọn ít nhất một loại phòng đang dùng.");
    return {
      p_hotel_id: managedHotel.id, p_name: name, p_id: gradeId, p_expected_version: editingGrade?.version ?? null,
      p_types: gradeDraft.map(draft => {
        const result = { room_kind: draft.room_kind, is_active: !draft.archived_at && draft.is_active, version: draft.version };
        for (const key of rateKeys) result[key] = pricing.money(draft[key] === "" && !draft.is_active ? 0 : draft[key]);
        return result;
      })
    };
  }

  function resetRoomType(type) {
    if (!type) { resetGrade(); return; }
    if (type.archived_at) { resetGrade(); return; }
    if (type.grade_id) { resetGrade(roomGrades.find(grade => grade.id === type.grade_id)); return; }
    editingRoomType = type || null;
    roomTypeId = type?.id || crypto.randomUUID();
    roomTypeForm.reset();
    if (type) {
      for (const key of ["name", "weekday_purchase", "weekday_sale", "weekend_purchase", "weekend_sale"]) roomTypeForm.elements.namedItem(key).value = type[key];
    }
    byId("roomTypeFormTitle").textContent = "기존 룸타입 수정 / Sửa loại phòng cũ";
    roomTypeForm.hidden = false;
    gradeForm.hidden = true;
    message("roomTypeError", "");
    formatMoneyFields(roomTypeForm);
  }

  function renderRoomTypes() {
    const container = byId("roomTypeRows");
    container.replaceChildren();
    const types = roomTypes.filter(type => type.hotel_id === managedHotel.id && !type.archived_at && !roomGrades.some(grade => grade.id === type.grade_id && grade.archived_at));
    const grades = roomGrades.filter(grade => grade.hotel_id === managedHotel.id && !grade.archived_at);
    if (!types.length && !grades.length) container.textContent = "등록된 객실 등급이 없습니다. 아래에서 추가해 주세요. / Chưa có hạng phòng. Hãy thêm bên dưới.";
    for (const grade of grades) {
      const card = document.createElement("div");
      const members = types.filter(type => type.grade_id === grade.id);
      card.className = "hotel-room-type" + (members.some(type => type.is_active !== false) ? "" : " is-paused");
      const title = document.createElement("div");
      title.className = "hotel-room-title";
      title.textContent = grade.name;
      card.append(title);
      for (const kind of roomKinds) {
        const type = members.find(type => type.room_kind === kind);
        if (!type) continue;
        const typeRow = document.createElement("div");
        typeRow.className = "hotel-catalog-type";
        typeRow.dataset.catalogTypeId = type.id;
        const line = document.createElement("p");
        line.className = "hotel-hint";
        line.textContent = roomKindLabel(kind) + (type?.is_active !== false && type
          ? " — 주중 / Thường " + moneyText(type.weekday_purchase) + " / " + moneyText(type.weekday_sale) + " · 주말 / Cuối tuần " + moneyText(type.weekend_purchase) + " / " + moneyText(type.weekend_sale) + " (매입 / 매출 · Mua / Bán)"
          : " — 사용 안 함 / Không dùng");
        typeRow.append(line, action("타입 삭제 / Xóa loại", () => archiveRoomType(type)));
        card.append(typeRow);
      }
      card.dataset.catalogGradeId = grade.id;
      card.append(action("등급·요금 수정 / Sửa hạng·giá", () => { if (!busy) resetGrade(grade); }), " ",
        action("등급 삭제 / Xóa hạng", () => archiveRoomGrade(grade)));
      container.append(card);
    }
    const legacyTypes = types.filter(type => !type.grade_id);
    if (legacyTypes.length) {
      const heading = document.createElement("h3");
      heading.textContent = "기존 룸타입 / Loại phòng cũ";
      container.append(heading);
    }
    for (const type of legacyTypes) {
      const card = document.createElement("div");
      card.className = "hotel-room-type" + (type.is_active === false ? " is-paused" : "");
      card.dataset.catalogTypeId = type.id;
      const title = document.createElement("div");
      title.className = "hotel-room-title";
      title.textContent = type.name + (type.is_active === false ? " · 사용 중지 / Ngừng dùng" : "");
      const rates = document.createElement("p");
      rates.className = "hotel-hint";
      rates.textContent = "주중 / Ngày thường — 매입 / Mua " + moneyText(type.weekday_purchase) + " · 매출 / Bán " + moneyText(type.weekday_sale)
        + "\n주말 / Cuối tuần — 매입 / Mua " + moneyText(type.weekend_purchase) + " · 매출 / Bán " + moneyText(type.weekend_sale);
      rates.style.whiteSpace = "pre-line";
      card.append(title, rates, action("수정 / Sửa", () => { if (!busy) resetRoomType(type); }), " ",
        action(type.is_active === false ? "다시 사용 / Dùng lại" : "사용 중지 / Ngừng dùng", () => toggleRoomType(type)), " ",
        action("삭제 / Xóa", () => archiveRoomType(type)));
      container.append(card);
    }
  }

  function openRoomTypes(hotel) {
    if (busy || !ready) return;
    managedHotel = hotel;
    resetExtraBedPrices(hotel);
    message("catalogError", "");
    byId("roomTypeTitle").textContent = hotel.name + " · 등급·룸타입 / Hạng·loại phòng";
    resetGrade();
    renderRoomTypes();
    byId("roomTypeDialog").showModal();
  }

  function resetExtraBedPrices(hotel) {
    editingExtraBedHotel = {...hotel};
    for (const key of ["extra_bed_purchase", "extra_bed_sale"]) extraBedForm.elements.namedItem(key).value = hotel[key] ?? 0;
    message("extraBedError", "");
    formatMoneyFields(extraBedForm);
  }

  async function toggleRoomType(type) {
    if (busy || !ready || type.archived_at) return;
    if (type.grade_id) { resetGrade(roomGrades.find(grade => grade.id === type.grade_id)); return; }
    const active = type.is_active === false;
    if (!confirm(type.name + "\n" + (active ? "다시 사용할까요? / Dùng lại loại phòng này?" : "사용을 중지할까요? 기존 예약은 유지됩니다. / Ngừng dùng? Đặt phòng cũ vẫn được giữ."))) return;
    setBusy(true);
    const errorTarget = roomTypeForm.hidden ? "gradeError" : "roomTypeError";
    message(errorTarget, "");
    try {
      await persist("hotel_room_types", { is_active: active }, type, type.id);
      await refresh();
      if (editingRoomType?.id === type.id) resetRoomType(roomTypes.find(item => item.id === type.id));
    } catch (error) {
      message(errorTarget, errorText(error));
    } finally { setBusy(false); }
  }

  async function archiveRoomType(type) {
    if (busy || !ready) return;
    const current = roomTypes.find(item => item.id === type.id);
    if (!current || current.archived_at) return;
    const affectsGrade = current.grade_id && !gradeForm.hidden && editingGrade?.id === current.grade_id;
    const affectsLegacy = !roomTypeForm.hidden && editingRoomType?.id === current.id;
    const label = current.grade_id ? (current.grade_name || "") + " · " + roomKindLabel(current.room_kind) : current.name;
    const resetNotice = affectsGrade || affectsLegacy ? "\n현재 수정 중인 이 항목의 미저장 입력은 초기화됩니다. / Các thay đổi chưa lưu của mục này sẽ được đặt lại." : "";
    if (!confirm(label + "\n이 룸타입을 삭제할까요? 새 예약에서는 선택할 수 없지만 기존 예약의 이름·금액·내역은 그대로 유지됩니다.\nXóa loại phòng này? Không thể chọn cho đặt phòng mới; tên, số tiền và chi tiết đặt phòng cũ vẫn được giữ nguyên." + resetNotice)) return;
    setBusy(true);
    message("catalogError", "");
    try {
      const result = await DGV.supabase.rpc("archive_hotel_room_type", { p_id: current.id, p_expected_version: current.version });
      if (result.error) throw result.error;
      await refresh();
      if (!ready) throw new Error("삭제 후 목록을 불러오지 못했습니다. 새로고침해 주세요. / Đã xóa nhưng không tải lại được danh sách. Vui lòng tải lại.");
      if (affectsGrade) resetGrade(roomGrades.find(grade => grade.id === current.grade_id));
      else if (affectsLegacy) resetGrade();
    } catch (error) {
      message("catalogError", errorText(error));
    } finally { setBusy(false); }
  }

  async function archiveRoomGrade(grade) {
    if (busy || !ready) return;
    const current = roomGrades.find(item => item.id === grade.id);
    if (!current || current.archived_at) return;
    const affectsEditor = !gradeForm.hidden && editingGrade?.id === current.id;
    const resetNotice = affectsEditor ? "\n현재 수정 중인 이 등급의 미저장 입력은 초기화됩니다. / Các thay đổi chưa lưu của hạng này sẽ được đặt lại." : "";
    if (!confirm(current.name + "\n이 등급과 포함된 모든 룸타입을 삭제할까요? 기존 예약의 이름·금액·내역은 그대로 유지됩니다.\nXóa hạng này cùng tất cả loại phòng thuộc hạng? Tên, số tiền và chi tiết đặt phòng cũ vẫn được giữ nguyên." + resetNotice)) return;
    const versions = roomTypes.filter(type => type.grade_id === current.id).map(type => ({ id: type.id, version: type.version }));
    setBusy(true);
    message("catalogError", "");
    try {
      const result = await DGV.supabase.rpc("archive_hotel_room_grade", { p_id: current.id, p_expected_version: current.version, p_type_versions: versions });
      if (result.error) throw result.error;
      await refresh();
      if (!ready) throw new Error("삭제 후 목록을 불러오지 못했습니다. 새로고침해 주세요. / Đã xóa nhưng không tải lại được danh sách. Vui lòng tải lại.");
      if (affectsEditor) resetGrade();
    } catch (error) {
      message("catalogError", errorText(error));
    } finally { setBusy(false); }
  }

  function renderRoomItems() {
    byId("legacyRoomNotice").hidden = useRoomTypes;
    byId("roomItemsFields").hidden = !useRoomTypes;
    field("room_count").readOnly = useRoomTypes;
    const container = byId("roomItemRows");
    container.replaceChildren();
    if (!useRoomTypes) return;
    const hotelId = field("hotel_id").value;
    const allTypes = roomTypes.filter(type => type.hotel_id === hotelId);
    const types = allTypes.filter(type => type.is_active !== false && !type.archived_at && !roomGrades.some(grade => grade.id === type.grade_id && grade.archived_at));
    const grades = roomGrades.filter(grade => grade.hotel_id === hotelId && !grade.archived_at && types.some(type => type.grade_id === grade.id));
    roomItems.forEach((item, index) => {
      const line = document.createElement("div");
      line.className = "hotel-room-line";
      const addField = (title, input) => {
        const label = document.createElement("label");
        const caption = document.createElement("span");
        caption.className = "qr-label";
        caption.textContent = title;
        label.append(caption, input);
        line.append(label);
      };
      const selectedType = allTypes.find(type => type.id === item.room_type_id);
      const savedType = editing?.room_items?.find(saved => saved.room_type_id === item.room_type_id);
      const selectedGrade = item.selected_grade_id !== undefined ? item.selected_grade_id : selectedType?.grade_id || item.grade_id || (item.room_type_id ? "legacy" : "");
      const gradeSelect = document.createElement("select");
      gradeSelect.className = "qr-select";
      gradeSelect.required = true;
      gradeSelect.dataset.roomGrade = String(index);
      gradeSelect.add(new Option("객실 등급 선택 / Chọn hạng phòng", ""));
      for (const grade of grades) gradeSelect.add(new Option(grade.name, grade.id));
      if (types.some(type => !type.grade_id) || (savedType && !savedType.grade_id)) gradeSelect.add(new Option("기존 룸타입 / Loại phòng cũ", "legacy"));
      if (selectedGrade && selectedGrade !== "legacy" && !grades.some(grade => grade.id === selectedGrade) && savedType) {
        const archived = roomGrades.find(grade => grade.id === selectedGrade)?.archived_at;
        gradeSelect.add(new Option((savedType.room_grade || roomGrades.find(grade => grade.id === selectedGrade)?.name || "기존 등급 / Hạng cũ") + (archived ? " (기존·삭제됨 / cũ·đã xóa)" : " (기존·중지 / cũ·ngừng dùng)"), selectedGrade));
      }
      gradeSelect.value = selectedGrade;
      gradeSelect.addEventListener("change", () => {
        item.selected_grade_id = gradeSelect.value;
        item.room_type_id = "";
        item.room_type_version = null;
        item.name = "";
        item.grade_id = gradeSelect.value === "legacy" ? null : gradeSelect.value;
        item.room_kind = null;
        item.room_grade = gradeSelect.value === "legacy" ? "STANDARD" : roomGrades.find(grade => grade.id === gradeSelect.value)?.name || "";
        renderRoomItems();
        updatePreview();
      });
      addField("객실 등급 / Hạng phòng", gradeSelect);
      const typeSelect = document.createElement("select");
      typeSelect.className = "qr-select";
      typeSelect.required = true;
      typeSelect.dataset.roomType = String(index);
      typeSelect.add(new Option(selectedGrade ? "룸타입 선택 / Chọn loại phòng" : "등급을 먼저 선택해 주세요 / Chọn hạng trước", ""));
      const availableTypes = types.filter(type => selectedGrade === "legacy" ? !type.grade_id : type.grade_id === selectedGrade)
        .sort((a, b) => roomKinds.indexOf(a.room_kind) - roomKinds.indexOf(b.room_kind));
      for (const type of availableTypes) typeSelect.add(new Option(type.grade_id ? roomKindLabel(type.room_kind) : type.name, type.id));
      if (item.room_type_id && !availableTypes.some(type => type.id === item.room_type_id) && savedType) {
        const archived = selectedType?.archived_at || roomGrades.find(grade => grade.id === selectedType?.grade_id)?.archived_at;
        typeSelect.add(new Option((savedType.grade_id && savedType.room_kind ? roomKindLabel(savedType.room_kind) : savedType.name || selectedType?.name) + (archived ? " (기존·삭제됨 / cũ·đã xóa)" : " (기존·중지 / cũ·ngừng dùng)"), item.room_type_id));
      }
      typeSelect.value = item.room_type_id || "";
      typeSelect.addEventListener("change", () => {
        item.room_type_id = typeSelect.value;
        const type = allTypes.find(type => type.id === item.room_type_id);
        item.room_type_version = type?.version;
        item.name = type?.name || "";
        item.grade_id = type?.grade_id || null;
        item.room_kind = type?.room_kind || null;
        item.room_grade = type?.grade_id ? type.grade_name : "STANDARD";
        updatePreview();
      });
      addField("룸타입 / Loại phòng", typeSelect);
      const count = document.createElement("input");
      count.className = "qr-input";
      count.type = "number";
      count.min = "1";
      count.max = "10000";
      count.step = "1";
      count.required = true;
      count.value = item.room_count;
      count.addEventListener("input", () => { item.room_count = count.value; updatePreview(); });
      addField("객실 수 / Số phòng", count);
      line.append(action("제거 / Bỏ", () => {
        if (busy) return;
        roomItems.splice(index, 1);
        renderRoomItems();
        updatePreview();
      }));
      container.append(line);
      if (selectedGrade === "legacy" && savedType?.room_grade) {
        const hint = document.createElement("p");
        hint.className = "hotel-hint";
        hint.textContent = "기존 저장 등급 / Hạng đã lưu: " + savedType.room_grade;
        container.append(hint);
      }
    });
  }

  function openReservation(reservation) {
    if (busy || !ready) return;
    if (!hotels.length && !reservation) {
      message("pageStatus", "호텔 등록 후 예약을 추가해 주세요. / Thêm khách sạn trước khi đặt phòng.");
      openHotel();
      return;
    }
    editing = reservation || null;
    reservationId = reservation?.id || crypto.randomUUID();
    form.reset();
    const select = byId("hotelSelect");
    select.replaceChildren(new Option("호텔 선택 / Chọn khách sạn", ""));
    for (const hotel of hotels) select.add(new Option(hotel.name, hotel.id));
    // Existing manual bookings can retain their original hotel until explicitly linked.
    if (reservation?.pricing_mode === "legacy") {
      select.add(new Option(reservation.hotel_name + " (기존 / cũ)", "legacy"));
    }
    if (reservation) {
      for (const input of form.elements) {
        if (input.name && input.type !== "checkbox" && reservation[input.name] != null) input.value = reservation[input.name];
      }
      field("hotel_id").value = reservation.hotel_id || "legacy";
      field("pricing_mode").value = reservation.pricing_mode === "legacy" ? "surcharge" : reservation.pricing_mode;
      field("includes_meals").checked = reservation.includes_meals;
    }
    useRoomTypes = !reservation || Array.isArray(reservation.room_items);
    roomItems = reservation?.room_items ? reservation.room_items.map(item => ({ ...item })) : [{ room_type_id: "", room_count: 1, room_grade: "STANDARD" }];
    renderRoomItems();
    byId("dialogTitle").textContent = reservation ? "예약 수정 / Sửa đặt phòng" : "예약 등록 / Thêm đặt phòng";
    message("formError", "");
    updatePreview();
    formatMoneyFields(form);
    byId("hotelDialog").showModal();
  }

  function reservationData() {
    const data = Object.fromEntries(new FormData(form));
    data.guest_names = data.guest_names.trim();
    data.booking_reference = String(data.booking_reference ?? "").trim() || null;
    data.includes_meals = field("includes_meals").checked;
    for (const key of ["room_count","guest_count","room_purchase_amount","room_sale_amount","meal_purchase_amount","meal_sale_amount","extra_bed_count"]) {
      data[key] = Number(data[key] ?? 0);
    }
    if (useRoomTypes) {
      data.room_items = roomItems.map(item => ({ room_type_id: item.room_type_id, room_count: Number(item.room_count), room_grade: item.room_grade || "STANDARD", room_type_version: item.room_type_version }));
      data.room_count = data.room_items.reduce((total, item) => total + item.room_count, 0);
    }
    for (const name of ["deposit_amount", "balance_amount"]) data[name] = String(data[name] ?? "").trim() === "" ? null : pricing.money(data[name]);
    data.note = field("note").value;
    return data;
  }

  function preview(data) {
    const hotel = hotels.find(item => item.id === data.hotel_id);
    if (!hotel && data.hotel_id !== "legacy") throw new Error("호텔을 선택해 주세요. / Chọn khách sạn.");
    if (data.hotel_id === "legacy" && data.pricing_mode === "standard") {
      throw new Error("자동 계산하려면 등록된 호텔을 선택해 주세요. / Chọn khách sạn để tính tự động.");
    }
    return pricing.price(data, hotel, editing, roomTypes);
  }

  function updatePreview() {
    const manual = field("pricing_mode").value === "surcharge";
    if (useRoomTypes) field("room_count").value = roomItems.reduce((total, item) => total + Number(item.room_count || 0), 0);
    byId("manualRoomFields").hidden = !manual;
    byId("mealFields").hidden = !field("includes_meals").checked;
    // Hidden optional inputs must not participate in native form validation.
    for (const name of ["room_purchase_amount","room_sale_amount"]) {
      field(name).required = manual;
      field(name).disabled = !manual;
    }
    for (const name of ["meal_purchase_amount","meal_sale_amount"]) {
      field(name).required = field("includes_meals").checked;
      field(name).disabled = !field("includes_meals").checked;
    }
    try {
      const data = reservationData();
      const result = preview(data);
      const lines = [result.nights + "박 × " + data.room_count + "룸 / đêm × phòng"];
      if (!manual && result.items?.length) {
        for (const item of result.items) lines.push(roomLineLabel(item) + " × " + item.room_count + "룸 — 매입 / Mua " + moneyText(item.room_purchase_amount) + " · 매출 / Bán " + moneyText(item.room_sale_amount));
      } else if (!manual) {
        lines.push("주중 / Ngày thường " + result.weekday + "박 · 주말 / Cuối tuần " + result.weekend + "박");
        lines.push("1룸·1박 매입 / Mua mỗi phòng: " + moneyText(result.rates.weekday_purchase) + " / " + moneyText(result.rates.weekend_purchase));
        lines.push("1룸·1박 매출 / Bán mỗi phòng: " + moneyText(result.rates.weekday_sale) + " / " + moneyText(result.rates.weekend_sale));
      }
      lines.push("객실 / Phòng — 매입 " + moneyText(result.roomPurchase) + " · 매출 " + moneyText(result.roomSale));
      lines.push("식사 / Bữa ăn — 매입 " + moneyText(result.mealPurchase) + " · 매출 " + moneyText(result.mealSale));
      lines.push("추가 침대 / Giường phụ — " + result.extraBedCount + "개 × " + result.nights + "박 · 매입 " + moneyText(result.extraBedPurchase) + " · 매출 " + moneyText(result.extraBedSale));
      if (result.extraBedCount) lines.push("추가 침대 1개·1박 / Mỗi giường mỗi đêm — 매입 " + moneyText(result.extraBedRates.purchase) + " · 매출 " + moneyText(result.extraBedRates.sale));
      lines.push("총액 / Tổng — 매입 " + moneyText(result.purchase) + " · 매출 " + moneyText(result.sale));
      lines.push("계약금 / Tiền cọc " + optionalMoney(data.deposit_amount) + " · 잔금 / Tiền còn lại đã thu " + optionalMoney(data.balance_amount));
      lines.push("입금 합계 / Tổng đã thu " + (data.deposit_amount == null && data.balance_amount == null ? "—" : moneyText(Number(data.deposit_amount || 0) + Number(data.balance_amount || 0))));
      byId("pricePreview").textContent = lines.join("\n");
    } catch (error) {
      byId("pricePreview").textContent = error.message;
    }
  }

  async function persist(name, data, previous, id) {
    const request = previous
      ? table(name).update(data).eq("id", id).eq("version", previous.version)
      : table(name).insert({ ...data, id });
    const { data: saved, error } = await request.select("*").single();
    if (!error) return saved;
    // A lost insert response may be retried with the same draft UUID.
    if (!previous && error.code === "23505") {
      const existing = await table(name).select("*").eq("id", id).single();
      if (!existing.error) {
        QRStaff.toast("이전 저장이 완료되어 저장된 내용을 불러옵니다. / Đã lưu trước đó.", "success");
        return existing.data;
      }
    }
    throw error;
  }

  propertyForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    message("propertyError", "");
    try {
      const data = Object.fromEntries(new FormData(propertyForm));
      data.name = data.name.trim();
      if (!data.name) throw new Error("호텔명을 입력해 주세요. / Nhập tên khách sạn.");
      // Existing hotel-level prices remain untouched for legacy reservation snapshots.
      if (!editingHotel) for (const key of ["weekday_purchase","weekday_sale","weekend_purchase","weekend_sale"]) data[key] = 0;
      data.weekend_days = [...propertyForm.querySelectorAll('[name="weekend_days"]:checked')].map(input => Number(input.value));
      setBusy(true);
      await persist("hotel_properties", data, editingHotel, propertyId);
      byId("propertyDialog").close();
      await refresh();
    } catch (error) {
      message("propertyError", errorText(error));
    } finally {
      setBusy(false);
    }
  });

  roomTypeForm.addEventListener("submit", async event => {
    event.preventDefault();
    if (busy || !managedHotel) return;
    message("roomTypeError", "");
    try {
      const data = Object.fromEntries(new FormData(roomTypeForm));
      data.name = data.name.trim();
      if (!data.name) throw new Error("룸타입명을 입력해 주세요. / Nhập tên loại phòng.");
      if (!editingRoomType) data.hotel_id = managedHotel.id;
      for (const key of ["weekday_purchase", "weekday_sale", "weekend_purchase", "weekend_sale"]) data[key] = pricing.money(data[key]);
      if (!editingRoomType) data.is_active = true;
      setBusy(true);
      await persist("hotel_room_types", data, editingRoomType, roomTypeId);
      await refresh();
      resetRoomType();
    } catch (error) {
      message("roomTypeError", errorText(error));
    } finally { setBusy(false); }
  });

  extraBedForm.addEventListener("submit", async event => {
    event.preventDefault();
    if (busy || !ready || !editingExtraBedHotel) return;
    message("extraBedError", "");
    try {
      const draft = Object.fromEntries(new FormData(extraBedForm));
      const data = {extra_bed_purchase:pricing.money(draft.extra_bed_purchase),extra_bed_sale:pricing.money(draft.extra_bed_sale)};
      setBusy(true);
      const saved = await persist("hotel_properties", data, editingExtraBedHotel, editingExtraBedHotel.id);
      await refresh();
      managedHotel = hotels.find(hotel => hotel.id === saved.id) || saved;
      resetExtraBedPrices(managedHotel);
      QRStaff.toast("추가 침대 요금이 저장되었습니다. / Đã lưu giá giường phụ.", "success");
    } catch (error) { message("extraBedError", errorText(error)); }
    finally { setBusy(false); }
  });

  gradeForm.addEventListener("submit", async event => {
    event.preventDefault();
    if (busy || !managedHotel) return;
    message("gradeError", "");
    try {
      const data = gradePayload();
      setBusy(true);
      const { error } = await DGV.supabase.rpc("save_hotel_room_grade", data);
      if (error) throw error;
      await refresh();
      if (!ready) throw new Error("저장은 완료되었지만 목록을 불러오지 못했습니다. 새로고침해 주세요. / Đã lưu nhưng chưa tải lại được danh sách.");
      resetGrade();
    } catch (error) {
      message("gradeError", errorText(error));
    } finally { setBusy(false); }
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    message("formError", "");
    try {
      const data = reservationData();
      if (!data.guest_names) throw new Error("투숙객 명단을 입력해 주세요. / Nhập danh sách khách.");
      if (useRoomTypes && (!data.room_items.length || data.room_items.some(item => !item.room_type_id))) throw new Error("각 행의 룸타입을 선택해 주세요. / Chọn loại phòng cho từng dòng.");
      if (useRoomTypes && pricing.needsRates(editing, data)) {
        for (const item of data.room_items) item.room_type_version = roomTypes.find(type => type.id === item.room_type_id)?.version;
      }
      const result = preview(data);
      data.room_purchase_amount = result.roomPurchase;
      data.room_sale_amount = result.roomSale;
      data.meal_purchase_amount = result.mealPurchase;
      data.meal_sale_amount = result.mealSale;
      data.extra_bed_hotel_version = result.extraBedVersion;
      if (data.hotel_id === "legacy") {
        if (data.includes_meals) throw new Error("식사비를 추가하려면 등록된 호텔을 선택해 주세요. / Chọn khách sạn để thêm tiền ăn.");
        data.hotel_id = null;
        data.pricing_mode = "legacy";
        data.purchase_amount = result.purchase;
        data.sale_amount = result.sale;
      } else {
        const hotel = hotels.find(item => item.id === data.hotel_id);
        data.hotel_version = pricing.needsRates(editing, data) ? hotel.version : editing.hotel_version;
      }
      setBusy(true);
      await persist("hotel_reservations", data, editing, reservationId);
      byId("hotelDialog").close();
      await refresh();
    } catch (error) {
      message("formError", errorText(error));
    } finally {
      setBusy(false);
    }
  });

  async function remove(name, record, errorId = "pageStatus") {
    if (busy || !ready) return false;
    const label = record.name || record.hotel_name + " · " + record.check_in;
    if (!confirm(label + "\n삭제할까요? / Xóa mục này?")) return false;
    setBusy(true);
    try {
      const { error } = await table(name).delete().eq("id", record.id).eq("version", record.version).select("id").single();
      if (error) throw error;
      await refresh();
      return true;
    } catch (error) {
      message(errorId, errorText(error));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function printHotelList() {
    if (busy || !ready) return;
    if (!applyPeriodDraft()) return;
    const period = { ...appliedPeriod };
    const popup = window.open("", "_blank");
    if (!popup) {
      alert("인쇄 창을 열 수 없습니다. 팝업을 허용해 주세요. / Cho phép cửa sổ bật lên để in.");
      return;
    }
    popup.document.write('<!doctype html><html><head><meta charset="utf-8"><title>HANA</title></head><body>최신 내역을 불러오는 중 / Đang tải dữ liệu mới nhất...</body></html>');
    popup.document.close();
    setBusy(true);
    try {
      await refresh();
      if (!ready) throw new Error("최신 내역을 불러오지 못했습니다. / Không thể tải dữ liệu mới nhất.");
      const rows = HotelReport.filterRows(reservations, period);
      if (!rows.length) throw new Error("조회 기간에 출력할 예약이 없습니다. / Chưa có đặt phòng để in trong khoảng ngày đã chọn.");
      if (popup.closed) return;
      popup.document.open();
      popup.document.write(HotelReport.renderHtml(rows, period));
      popup.document.close();
      if (popup.document.fonts?.ready) await popup.document.fonts.ready;
      await new Promise(resolve => setTimeout(resolve, 150));
      if (!popup.closed) { popup.focus(); popup.print(); }
    } catch (error) {
      if (!popup.closed) popup.close();
      message("pageStatus", errorText(error));
    } finally { setBusy(false); }
  }

  async function exportHotelList() {
    if (busy || !ready) return;
    if (!applyPeriodDraft()) return;
    const period = { ...appliedPeriod };
    setBusy(true);
    try {
      await refresh();
      if (!ready) throw new Error("최신 내역을 불러오지 못했습니다. / Không thể tải dữ liệu mới nhất.");
      const rows = HotelReport.filterRows(reservations, period);
      if (!rows.length) throw new Error("조회 기간에 내보낼 예약이 없습니다. / Chưa có đặt phòng để xuất trong khoảng ngày đã chọn.");
      DGV_XLSX.downloadWorkbook(HotelReport.workbookOptions(rows, period));
    } catch (error) {
      message("pageStatus", errorText(error));
    } finally { setBusy(false); }
  }

  for (const button of document.querySelectorAll("[data-close]")) {
    button.addEventListener("click", () => { if (!busy) byId(button.dataset.close).close(); });
  }
  for (const dialog of document.querySelectorAll(".hotel-dialog")) {
    dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
  }
  form.addEventListener("input", updatePreview);
  form.addEventListener("change", updatePreview);
  byId("hotelSelect").addEventListener("change", () => {
    if (field("hotel_id").value === "legacy") {
      useRoomTypes = false;
      field("room_count").value = editing?.room_count || 1;
    } else {
      useRoomTypes = true;
      roomItems = [{ room_type_id: "", room_count: 1, room_grade: "STANDARD" }];
    }
    renderRoomItems();
    updatePreview();
  });
  byId("enableRoomTypesButton").addEventListener("click", () => {
    if (busy) return;
    if (field("hotel_id").value === "legacy" || !field("hotel_id").value) {
      message("formError", "등록된 호텔을 먼저 선택해 주세요. / Chọn khách sạn đã đăng ký trước.");
      return;
    }
    useRoomTypes = true;
    roomItems = [{ room_type_id: "", room_count: Number(field("room_count").value) || 1, room_grade: "STANDARD" }];
    renderRoomItems();
    updatePreview();
  });
  byId("addRoomItemButton").addEventListener("click", () => {
    if (busy) return;
    if (roomItems.length >= 100) {
      message("formError", "룸타입 행은 최대 100개까지 추가할 수 있습니다. / Tối đa 100 dòng loại phòng.");
      return;
    }
    roomItems.push({ room_type_id: "", room_count: 1, room_grade: "STANDARD" });
    renderRoomItems();
    updatePreview();
  });
  byId("newRoomTypeButton").addEventListener("click", () => { if (!busy) resetRoomType(); });
  byId("newGradeButton").addEventListener("click", () => { if (!busy) resetGrade(); });
  byId("editHotelDetailButton").addEventListener("click", () => {
    if (busy || !ready) return;
    const latest = reservations.find(record => record.id === detailReservationId);
    if (!latest) return message("hotelDetailError", "예약이 목록에 없습니다. 새로고침해 주세요. / Không tìm thấy đặt phòng, hãy tải lại.");
    byId("hotelDetailDialog").close();
    openReservation(latest);
  });
  byId("deleteHotelDetailButton").addEventListener("click", async () => {
    if (busy || !ready) return;
    const latest = reservations.find(record => record.id === detailReservationId);
    if (!latest) return message("hotelDetailError", "예약이 목록에 없습니다. 새로고침해 주세요. / Không tìm thấy đặt phòng, hãy tải lại.");
    message("hotelDetailError", "");
    if (await remove("hotel_reservations", latest, "hotelDetailError")) {
      byId("hotelDetailDialog").close();
      detailReservationId = null;
    }
  });
  byId("hotelPeriodForm").addEventListener("submit", event => {
    event.preventDefault();
    if (!busy && ready) applyPeriodDraft();
  });
  byId("hotelStatus").addEventListener("change", () => { if (!busy && ready) applyPeriodDraft(); });
  byId("allHotelDatesButton").addEventListener("click", () => {
    if (busy || !ready) return;
    byId("hotelFromDate").value = "";
    byId("hotelToDate").value = "";
    applyPeriodDraft();
  });
  for (const id of ["hotelFromDate", "hotelToDate", "hotelQuery"]) {
    byId(id).addEventListener("input", () => { message("hotelPeriodError", ""); updatePeriodStatus(); });
  }
  byId("printHotelListButton").addEventListener("click", printHotelList);
  byId("excelHotelListButton").addEventListener("click", exportHotelList);
  byId("addHotelButton").addEventListener("click", () => openHotel());
  byId("addButton").addEventListener("click", () => openReservation());
  byId("reloadButton").addEventListener("click", async () => {
    if (busy) return;
    setBusy(true);
    await refresh();
    setBusy(false);
  });
  async function start() {
    try {
      await QRStaff.requireLogin({ roles: ["manager", "admin"], preferredRole: "manager" });
      byId("hotelApp").hidden = false;
      setBusy(true);
      await refresh();
    } catch (error) {
      message("startupError", errorText(error));
    } finally {
      setBusy(false);
    }
  }
  formatMoneyFields(form);
  formatMoneyFields(roomTypeForm);
  formatMoneyFields(extraBedForm);
  start();
})();

