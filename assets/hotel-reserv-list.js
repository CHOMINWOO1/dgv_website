(function () {
  "use strict";
  const byId = (id) => document.getElementById(id);
  const form = byId("hotelForm");
  const propertyForm = byId("propertyForm");
  const roomTypeForm = byId("roomTypeForm");
  const pricing = HotelPricing;
  const amount = new Intl.NumberFormat("vi-VN");
  const weekdays = ["일/CN","월/T2","화/T3","수/T4","목/T5","금/T6","토/T7"];
  let hotels = [];
  let reservations = [];
  let roomTypes = [];
  let roomItems = [];
  let useRoomTypes = true;
  let managedHotel = null;
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
  const roomTypeName = item => item.name || roomTypes.find(type => type.id === item.room_type_id)?.name || "룸타입 / Loại phòng";
  const roomDescription = record => Array.isArray(record.room_items) && record.room_items.length
    ? record.room_items.map(item => roomTypeName(item) + " · " + (item.room_grade || "STANDARD") + " × " + item.room_count).join("\n")
    : "기존 요금 / Giá đã lưu";

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
      const types = roomTypes.filter(type => type.hotel_id === hotel.id);
      const values = [hotel.name, types.filter(type => type.is_active !== false).length + "개 사용 / đang dùng · 전체 / Tổng " + types.length,
        hotel.weekend_days.map(day => weekdays[day]).join(", ") || "없음 / Không có"];
      for (const value of values) row.insertCell().textContent = value;
      const controls = row.insertCell();
      controls.className = "hotel-actions";
      controls.append(action("룸타입 관리 / Loại phòng", () => openRoomTypes(hotel)), " ", action("수정 / Sửa", () => openHotel(hotel)), " ", action("삭제 / Xóa", () => remove("hotel_properties", hotel)));
    }
    byId("hotelCount").textContent = hotels.length + "개 / khách sạn";
    const body = renderRows("hotelRows", reservations, "등록된 예약이 없습니다. / Chưa có đặt phòng.", 16);
    for (const reservation of reservations) {
      const row = body.insertRow();
      const mode = reservation.pricing_mode === "standard"
        ? "일반 / Thường (" + reservation.weekday_nights + " 주중 + " + reservation.weekend_nights + " 주말)"
        : reservation.pricing_mode === "legacy" ? "기존 직접입력 / Giá cũ" : "서차지 / Phụ thu";
      const values = [reservation.hotel_name, reservation.check_in, reservation.check_out,
        reservation.guest_count + "명 · " + reservation.room_count + "룸\n" + roomDescription(reservation), reservation.guest_names, mode,
        moneyText(reservation.room_purchase_amount), moneyText(reservation.room_sale_amount),
        reservation.includes_meals ? moneyText(reservation.meal_purchase_amount) : "—",
        reservation.includes_meals ? moneyText(reservation.meal_sale_amount) : "—",
        moneyText(reservation.purchase_amount), moneyText(reservation.sale_amount),
        optionalMoney(reservation.deposit_amount), optionalMoney(reservation.balance_amount),
        reservation.deposit_amount == null && reservation.balance_amount == null ? "—" : moneyText(Number(reservation.deposit_amount || 0) + Number(reservation.balance_amount || 0)),
        reservation.note || ""];
      for (const value of values) row.insertCell().textContent = value;
      row.cells[4].className = "hotel-guests";
      row.cells[3].className = "hotel-guests";
      row.cells[15].className = "hotel-guests";
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
    byId("listCount").textContent = reservations.length + "건 / đặt phòng";
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
    detail(info, "체크인 / Nhận phòng", record.check_in);
    detail(info, "체크아웃 / Trả phòng", record.check_out);
    detail(info, "투숙객 인원 / Số khách", record.guest_count);
    detail(info, "객실 수 / Số phòng", record.room_count);
    detail(info, "전체 투숙객 명단 / Danh sách khách", record.guest_names);
    detail(info, "요금 방식 / Loại giá", record.pricing_mode === "standard" ? "일반 · 자동 계산 / Giá thường · tự động" : record.pricing_mode === "surcharge" ? "서차지 · 전체 직접입력 / Phụ thu · nhập tổng tiền" : "기존 직접입력 / Giá cũ");
    const totals = card("금액 및 입금 / Số tiền và khoản thu");
    for (const [label, key] of [
      ["객실 매입 / Tổng mua phòng", "room_purchase_amount"], ["객실 매출 / Tổng bán phòng", "room_sale_amount"],
      ["식사 매입 / Tổng mua bữa ăn", "meal_purchase_amount"], ["식사 매출 / Tổng bán bữa ăn", "meal_sale_amount"],
      ["총 매입 / Tổng mua", "purchase_amount"], ["총 매출 / Tổng bán", "sale_amount"],
      ["계약금 / Tiền cọc", "deposit_amount"], ["잔금 입금액 / Tiền còn lại đã thu", "balance_amount"]
    ]) detail(totals, label, optionalMoney(record[key]));
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
      detail(room, "룸타입 / Loại phòng", item.name || roomTypeName(item));
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
    detail(notes, "예약번호 / Mã đặt phòng", record.id);
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
          { order: [{ column: "hotel_id" }, { column: "name" }, { column: "id" }] })
      ]);
      [hotels, reservations, roomTypes] = result;
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

  function resetRoomType(type) {
    editingRoomType = type || null;
    roomTypeId = type?.id || crypto.randomUUID();
    roomTypeForm.reset();
    if (type) {
      for (const key of ["name", "weekday_purchase", "weekday_sale", "weekend_purchase", "weekend_sale"]) roomTypeForm.elements.namedItem(key).value = type[key];
    }
    byId("roomTypeFormTitle").textContent = type ? "룸타입 수정 / Sửa loại phòng" : "룸타입 추가 / Thêm loại phòng";
    message("roomTypeError", "");
  }

  function renderRoomTypes() {
    const container = byId("roomTypeRows");
    container.replaceChildren();
    const types = roomTypes.filter(type => type.hotel_id === managedHotel.id);
    if (!types.length) container.textContent = "등록된 룸타입이 없습니다. 아래에서 추가해 주세요. / Chưa có loại phòng. Hãy thêm bên dưới.";
    for (const type of types) {
      const card = document.createElement("div");
      card.className = "hotel-room-type" + (type.is_active === false ? " is-paused" : "");
      const title = document.createElement("div");
      title.className = "hotel-room-title";
      title.textContent = type.name + (type.is_active === false ? " · 사용 중지 / Ngừng dùng" : "");
      const rates = document.createElement("p");
      rates.className = "hotel-hint";
      rates.textContent = "주중 / Ngày thường — 매입 / Mua " + moneyText(type.weekday_purchase) + " · 매출 / Bán " + moneyText(type.weekday_sale)
        + "\n주말 / Cuối tuần — 매입 / Mua " + moneyText(type.weekend_purchase) + " · 매출 / Bán " + moneyText(type.weekend_sale);
      rates.style.whiteSpace = "pre-line";
      card.append(title, rates, action("수정 / Sửa", () => { if (!busy) resetRoomType(type); }), " ",
        action(type.is_active === false ? "다시 사용 / Dùng lại" : "사용 중지 / Ngừng dùng", () => toggleRoomType(type)));
      container.append(card);
    }
  }

  function openRoomTypes(hotel) {
    if (busy || !ready) return;
    managedHotel = hotel;
    byId("roomTypeTitle").textContent = hotel.name + " · 룸타입 관리 / Loại phòng";
    resetRoomType();
    renderRoomTypes();
    byId("roomTypeDialog").showModal();
  }

  async function toggleRoomType(type) {
    if (busy || !ready) return;
    const active = type.is_active === false;
    if (!confirm(type.name + "\n" + (active ? "다시 사용할까요? / Dùng lại loại phòng này?" : "사용을 중지할까요? 기존 예약은 유지됩니다. / Ngừng dùng? Đặt phòng cũ vẫn được giữ."))) return;
    setBusy(true);
    message("roomTypeError", "");
    try {
      await persist("hotel_room_types", { is_active: active }, type, type.id);
      await refresh();
      if (editingRoomType?.id === type.id) resetRoomType(roomTypes.find(item => item.id === type.id));
    } catch (error) {
      message("roomTypeError", errorText(error));
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
    const types = roomTypes.filter(type => type.hotel_id === hotelId && type.is_active !== false);
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
      const typeSelect = document.createElement("select");
      typeSelect.className = "qr-select";
      typeSelect.required = true;
      typeSelect.add(new Option(types.length ? "룸타입 선택 / Chọn loại phòng" : "호텔에 룸타입을 등록해 주세요 / Thêm loại phòng", ""));
      for (const type of types) typeSelect.add(new Option(type.name, type.id));
      const selectedType = roomTypes.find(type => type.id === item.room_type_id && type.hotel_id === hotelId);
      const savedType = editing?.room_items?.find(saved => saved.room_type_id === item.room_type_id);
      if (item.room_type_id && !types.some(type => type.id === item.room_type_id) && savedType) {
        typeSelect.add(new Option((selectedType?.name || savedType.name) + " (기존·중지 / cũ·ngừng dùng)", item.room_type_id));
      }
      typeSelect.value = item.room_type_id || "";
      typeSelect.addEventListener("change", () => {
        item.room_type_id = typeSelect.value;
        item.room_type_version = roomTypes.find(type => type.id === item.room_type_id)?.version;
        item.name = roomTypes.find(type => type.id === item.room_type_id)?.name || "";
        updatePreview();
      });
      addField("룸타입 / Loại phòng", typeSelect);
      const gradeSelect = document.createElement("select");
      gradeSelect.className = "qr-select";
      gradeSelect.add(new Option("STANDARD", "STANDARD"));
      gradeSelect.add(new Option("VIP", "VIP"));
      gradeSelect.value = item.room_grade || "STANDARD";
      gradeSelect.addEventListener("change", () => { item.room_grade = gradeSelect.value; updatePreview(); });
      addField("등급 / Hạng phòng", gradeSelect);
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
    byId("hotelDialog").showModal();
  }

  function reservationData() {
    const data = Object.fromEntries(new FormData(form));
    data.guest_names = data.guest_names.trim();
    data.includes_meals = field("includes_meals").checked;
    for (const key of ["room_count","guest_count","room_purchase_amount","room_sale_amount","meal_purchase_amount","meal_sale_amount"]) {
      data[key] = Number(data[key] ?? 0);
    }
    if (useRoomTypes) {
      data.room_items = roomItems.map(item => ({ room_type_id: item.room_type_id, room_count: Number(item.room_count), room_grade: item.room_grade || "STANDARD", room_type_version: item.room_type_version }));
      data.room_count = data.room_items.reduce((total, item) => total + item.room_count, 0);
    }
    for (const name of ["deposit_amount", "balance_amount"]) data[name] = field(name).value.trim() === "" ? null : pricing.money(field(name).value);
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
        for (const item of result.items) lines.push(roomTypeName(item) + " · " + (item.room_grade || "STANDARD") + " × " + item.room_count + "룸 — 매입 / Mua " + moneyText(item.room_purchase_amount) + " · 매출 / Bán " + moneyText(item.room_sale_amount));
      } else if (!manual) {
        lines.push("주중 / Ngày thường " + result.weekday + "박 · 주말 / Cuối tuần " + result.weekend + "박");
        lines.push("1룸·1박 매입 / Mua mỗi phòng: " + moneyText(result.rates.weekday_purchase) + " / " + moneyText(result.rates.weekend_purchase));
        lines.push("1룸·1박 매출 / Bán mỗi phòng: " + moneyText(result.rates.weekday_sale) + " / " + moneyText(result.rates.weekend_sale));
      }
      lines.push("객실 / Phòng — 매입 " + moneyText(result.roomPurchase) + " · 매출 " + moneyText(result.roomSale));
      lines.push("식사 / Bữa ăn — 매입 " + moneyText(result.mealPurchase) + " · 매출 " + moneyText(result.mealSale));
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
      if (!reservations.length) throw new Error("출력할 예약이 없습니다. / Chưa có đặt phòng để in.");
      if (popup.closed) return;
      popup.document.open();
      popup.document.write(HotelReport.renderHtml(reservations));
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
    setBusy(true);
    try {
      await refresh();
      if (!ready) throw new Error("최신 내역을 불러오지 못했습니다. / Không thể tải dữ liệu mới nhất.");
      if (!reservations.length) throw new Error("내보낼 예약이 없습니다. / Chưa có đặt phòng để xuất.");
      DGV_XLSX.downloadWorkbook(HotelReport.workbookOptions(reservations));
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
  start();
})();
