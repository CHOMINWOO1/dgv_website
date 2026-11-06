(function () {
  "use strict";
  const byId = (id) => document.getElementById(id);
  const form = byId("hotelForm");
  const propertyForm = byId("propertyForm");
  const pricing = HotelPricing;
  const amount = new Intl.NumberFormat("vi-VN");
  const weekdays = ["일/CN","월/T2","화/T3","수/T4","목/T5","금/T6","토/T7"];
  let hotels = [];
  let reservations = [];
  let editing = null;
  let editingHotel = null;
  let reservationId;
  let propertyId;
  let busy = false;
  let ready = false;
  const table = (name) => DGV.supabase.from(name);
  const field = (name) => form.elements.namedItem(name);
  const moneyText = (value) => amount.format(value) + " VND";

  function errorText(error) {
    if (error.code === "23503") return "예약에 사용 중인 호텔은 삭제할 수 없습니다. / Khách sạn đang có đặt phòng.";
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
    const properties = renderRows("propertyRows", hotels, "호텔을 먼저 등록해 주세요. / Thêm khách sạn trước.", 7);
    for (const hotel of hotels) {
      const row = properties.insertRow();
      const values = [hotel.name, ...["weekday_purchase","weekday_sale","weekend_purchase","weekend_sale"].map(key => moneyText(hotel[key])),
        hotel.weekend_days.map(day => weekdays[day]).join(", ") || "없음 / Không có"];
      for (const value of values) row.insertCell().textContent = value;
      const controls = row.insertCell();
      controls.className = "hotel-actions";
      controls.append(action("수정 / Sửa", () => openHotel(hotel)), " ", action("삭제 / Xóa", () => remove("hotel_properties", hotel)));
    }
    byId("hotelCount").textContent = hotels.length + "개 / khách sạn";
    const body = renderRows("hotelRows", reservations, "등록된 예약이 없습니다. / Chưa có đặt phòng.", 13);
    for (const reservation of reservations) {
      const row = body.insertRow();
      const mode = reservation.pricing_mode === "standard"
        ? "일반 / Thường (" + reservation.weekday_nights + " 주중 + " + reservation.weekend_nights + " 주말)"
        : reservation.pricing_mode === "legacy" ? "기존 직접입력 / Giá cũ" : "서차지 / Phụ thu";
      const values = [reservation.hotel_name, reservation.check_in, reservation.check_out,
        reservation.guest_count + "명 · " + reservation.room_count + "룸", reservation.guest_names, mode,
        moneyText(reservation.room_purchase_amount), moneyText(reservation.room_sale_amount),
        reservation.includes_meals ? moneyText(reservation.meal_purchase_amount) : "—",
        reservation.includes_meals ? moneyText(reservation.meal_sale_amount) : "—",
        moneyText(reservation.purchase_amount), moneyText(reservation.sale_amount)];
      for (const value of values) row.insertCell().textContent = value;
      row.cells[4].className = "hotel-guests";
      const controls = row.insertCell();
      controls.className = "hotel-actions";
      controls.append(action("수정 / Sửa", () => openReservation(reservation)), " ", action("삭제 / Xóa", () => remove("hotel_reservations", reservation)));
    }
    byId("listCount").textContent = reservations.length + "건 / đặt phòng";
  }

  async function refresh() {
    ready = false;
    message("pageStatus", "불러오는 중 / Đang tải");
    try {
      const result = await Promise.all([
        DGV.collectSupabasePages(() => table("hotel_properties").select("*"),
          { order: [{ column: "name" }, { column: "id" }] }),
        DGV.collectSupabasePages(() => table("hotel_reservations").select("*"),
          { order: [{ column: "check_in", ascending: false }, { column: "id" }] })
      ]);
      [hotels, reservations] = result;
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
      for (const name of ["name","weekday_purchase","weekday_sale","weekend_purchase","weekend_sale"]) {
        propertyForm.elements.namedItem(name).value = hotel[name];
      }
      for (const checkbox of propertyForm.querySelectorAll('[name="weekend_days"]')) {
        checkbox.checked = hotel.weekend_days.includes(Number(checkbox.value));
      }
    }
    message("propertyError", "");
    byId("propertyTitle").textContent = hotel ? "호텔 수정 / Sửa khách sạn" : "호텔 등록 / Thêm khách sạn";
    byId("propertyDialog").showModal();
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
    return data;
  }

  function preview(data) {
    const hotel = hotels.find(item => item.id === data.hotel_id);
    if (!hotel && data.hotel_id !== "legacy") throw new Error("호텔을 선택해 주세요. / Chọn khách sạn.");
    if (data.hotel_id === "legacy" && data.pricing_mode === "standard") {
      throw new Error("자동 계산하려면 등록된 호텔을 선택해 주세요. / Chọn khách sạn để tính tự động.");
    }
    return pricing.price(data, hotel, editing);
  }

  function updatePreview() {
    const manual = field("pricing_mode").value === "surcharge";
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
      if (!manual) {
        lines.push("주중 / Ngày thường " + result.weekday + "박 · 주말 / Cuối tuần " + result.weekend + "박");
        lines.push("1룸·1박 매입 / Mua mỗi phòng: " + moneyText(result.rates.weekday_purchase) + " / " + moneyText(result.rates.weekend_purchase));
        lines.push("1룸·1박 매출 / Bán mỗi phòng: " + moneyText(result.rates.weekday_sale) + " / " + moneyText(result.rates.weekend_sale));
      }
      lines.push("객실 / Phòng — 매입 " + moneyText(result.roomPurchase) + " · 매출 " + moneyText(result.roomSale));
      lines.push("식사 / Bữa ăn — 매입 " + moneyText(result.mealPurchase) + " · 매출 " + moneyText(result.mealSale));
      lines.push("총액 / Tổng — 매입 " + moneyText(result.purchase) + " · 매출 " + moneyText(result.sale));
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
      for (const key of ["weekday_purchase","weekday_sale","weekend_purchase","weekend_sale"]) data[key] = pricing.money(data[key]);
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

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    message("formError", "");
    try {
      const data = reservationData();
      if (!data.guest_names) throw new Error("투숙객 명단을 입력해 주세요. / Nhập danh sách khách.");
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

  async function remove(name, record) {
    if (busy || !ready) return;
    const label = record.name || record.hotel_name + " · " + record.check_in;
    if (!confirm(label + "\n삭제할까요? / Xóa mục này?")) return;
    setBusy(true);
    try {
      const { error } = await table(name).delete().eq("id", record.id).eq("version", record.version).select("id").single();
      if (error) throw error;
      await refresh();
    } catch (error) {
      message("pageStatus", errorText(error));
    } finally {
      setBusy(false);
    }
  }

  for (const button of document.querySelectorAll("[data-close]")) {
    button.addEventListener("click", () => { if (!busy) byId(button.dataset.close).close(); });
  }
  for (const dialog of document.querySelectorAll(".hotel-dialog")) {
    dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
  }
  form.addEventListener("input", updatePreview);
  form.addEventListener("change", updatePreview);
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
