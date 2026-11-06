(function () {
  "use strict";

  const byId = (id) => document.getElementById(id);
  const dialog = byId("hotelDialog");
  const form = byId("hotelForm");
  const rows = byId("hotelRows");
  const status = byId("listStatus");
  const table = () => DGV.supabase.from("hotel_reservations");
  const amount = new Intl.NumberFormat("vi-VN");
  let editingId = null;
  let saving = false;
  let deleting = false;
  let loading = false;

  function action(label, handler) {
    const button = document.createElement("button");
    button.className = "qr-btn qr-btn-small";
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", handler);
    return button;
  }

  function render(reservations) {
    const fragment = document.createDocumentFragment();
    for (const reservation of reservations) {
      const row = fragment.appendChild(document.createElement("tr"));
      const values = [
        reservation.hotel_name, reservation.check_in, reservation.check_out,
        reservation.guest_count, reservation.guest_names,
        amount.format(reservation.purchase_amount), amount.format(reservation.sale_amount)
      ];
      for (const value of values) row.insertCell().textContent = value;
      row.cells[4].className = "hotel-guests";
      const controls = row.insertCell();
      controls.className = "hotel-actions";
      controls.append(
        action("수정 / Sửa", () => openEditor(reservation)),
        " ",
        action("삭제 / Xóa", () => removeReservation(reservation))
      );
    }
    rows.replaceChildren(fragment);
  }

  async function loadReservations() {
    loading = true;
    byId("reloadButton").disabled = true;
    status.textContent = "불러오는 중 / Đang tải";
    try {
      const reservations = await DGV.collectSupabasePages(() =>
        table().select("id,hotel_name,check_in,check_out,guest_count,guest_names,purchase_amount,sale_amount"),
        { order: [{ column: "check_in", ascending: false }, { column: "id" }] }
      );
      render(reservations);
      status.textContent = reservations.length
        ? reservations.length + "건 / " + reservations.length + " đặt phòng"
        : "등록된 예약이 없습니다. / Chưa có đặt phòng.";
    } catch (error) {
      console.error(error);
      rows.replaceChildren();
      status.textContent = "예약을 불러오지 못했습니다. 새로고침해 주세요. / Không thể tải danh sách.";
    } finally {
      loading = false;
      byId("reloadButton").disabled = false;
    }
  }

  function openEditor(reservation) {
    if (loading || deleting || saving) return;
    editingId = reservation?.id ?? null;
    form.reset();
    byId("formError").hidden = true;
    byId("dialogTitle").textContent = editingId ? "예약 수정 / Sửa đặt phòng" : "예약 추가 / Thêm đặt phòng";
    if (reservation) {
      for (const field of form.elements) {
        if (field.name) field.value = reservation[field.name];
      }
    }
    dialog.showModal();
  }

  function showFormError(message) {
    const error = byId("formError");
    error.textContent = message;
    error.hidden = false;
  }

  async function saveReservation(event) {
    event.preventDefault();
    if (saving) return;
    const data = Object.fromEntries(new FormData(form));
    data.hotel_name = data.hotel_name.trim();
    data.guest_names = data.guest_names.trim();
    if (!data.hotel_name || !data.guest_names) {
      showFormError("호텔명과 투숙객 명단을 입력해 주세요. / Nhập tên khách sạn và danh sách khách.");
      return;
    }
    if (data.check_out <= data.check_in) {
      showFormError("체크아웃은 체크인 다음 날 이후여야 합니다. / Ngày trả phòng phải sau ngày nhận phòng.");
      return;
    }
    saving = true;
    byId("formError").hidden = true;
    byId("saveButton").disabled = true;
    byId("cancelButton").disabled = true;
    try {
      const request = editingId ? table().update(data).eq("id", editingId) : table().insert(data);
      const { error } = await request.select("id").single();
      if (error) throw error;
      dialog.close();
      await loadReservations();
    } catch (error) {
      console.error(error);
      showFormError("저장하지 못했습니다. 목록을 새로고침해 예약 상태를 확인해 주세요. / Không thể lưu đặt phòng.");
    } finally {
      saving = false;
      byId("saveButton").disabled = false;
      byId("cancelButton").disabled = false;
    }
  }

  async function removeReservation(reservation) {
    if (loading || deleting || saving) return;
    if (!window.confirm(reservation.hotel_name + " · " + reservation.check_in + "\n예약을 삭제할까요? / Xóa đặt phòng này?")) return;
    deleting = true;
    byId("reloadButton").disabled = true;
    try {
      const { error } = await table().delete().eq("id", reservation.id).select("id").single();
      if (error) throw error;
      await loadReservations();
    } catch (error) {
      console.error(error);
      status.textContent = "삭제하지 못했습니다. 새로고침해 주세요. / Không thể xóa đặt phòng.";
    } finally {
      deleting = false;
      byId("reloadButton").disabled = false;
    }
  }

  byId("addButton").addEventListener("click", () => openEditor());
  byId("reloadButton").addEventListener("click", loadReservations);
  byId("cancelButton").addEventListener("click", () => dialog.close());
  dialog.addEventListener("cancel", (event) => {
    if (saving) event.preventDefault();
  });
  form.addEventListener("submit", saveReservation);

  async function start() {
    try {
      await QRStaff.requireLogin({ roles: ["manager", "admin"], preferredRole: "manager" });
      byId("hotelApp").hidden = false;
      await loadReservations();
    } catch (error) {
      console.error(error);
      const message = byId("startupError");
      message.textContent = "호텔 예약 화면을 열지 못했습니다. / Không thể mở trang đặt phòng.";
      message.hidden = false;
    }
  }

  start();
})();
