(function initCardReceipts(global) {
  "use strict";

  const BUCKET = "order-card-receipts";
  const TABLE = "order_card_receipts";
  const MAX_INPUT_BYTES = 20 * 1024 * 1024;
  const MAX_JPEG_BYTES = 2 * 1024 * 1024;
  const MAX_EDGE = 2200;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const text = Object.freeze({
    title: "카드 매출전표 사진 / Ảnh biên lai thẻ",
    registered: "전표 사진 보기·수정 / Xem · sửa ảnh",
    register: "전표 사진 등록 / Thêm ảnh biên lai",
    unknown: "전표 사진 확인 / Kiểm tra ảnh",
    camera: "촬영 / Chụp ảnh",
    album: "앨범 / Chọn ảnh",
    save: "저장 / Lưu",
    remove: "사진 삭제 / Xóa ảnh",
    cancel: "취소 / Hủy",
    close: "닫기 / Đóng",
    loading: "불러오는 중… / Đang tải…",
    processing: "사진 처리 중… / Đang xử lý ảnh…",
    saving: "저장 중… / Đang lưu…",
    empty: "등록된 사진이 없습니다. / Chưa có ảnh biên lai.",
    ready: "미리보기를 확인하고 저장하세요. / Kiểm tra ảnh rồi chọn Lưu.",
    hint: "카드 결제 영수증만 촬영하세요. 민감한 카드 정보는 가려 주세요. 저장 전에는 업로드되지 않습니다. / Chỉ chụp biên lai thẻ, che thông tin thẻ nhạy cảm. Ảnh chỉ được tải lên khi chọn Lưu.",
    failure: "사진을 불러오거나 저장하지 못했습니다. 연결·권한을 확인하고 다시 시도하세요. / Không thể tải hoặc lưu ảnh. Kiểm tra kết nối và quyền truy cập rồi thử lại.",
    input: "20MB 이하 이미지 파일을 선택하세요. / Chọn tệp ảnh không quá 20MB.",
    image: "사진을 처리할 수 없습니다. JPG 또는 PNG 사진으로 다시 시도하세요. / Không xử lý được ảnh. Thử lại bằng ảnh JPG hoặc PNG.",
    jpeg: "저장된 사진 형식 또는 크기가 올바르지 않습니다. / Định dạng hoặc kích thước ảnh đã lưu không hợp lệ.",
    role: "매니저·관리자 로그인 후 이용하세요. / Vui lòng đăng nhập quản lý hoặc quản trị viên.",
    eligible: "매출에 포함된 결제 완료 카드 주문만 등록할 수 있습니다. / Chỉ áp dụng cho đơn thẻ đã thanh toán, không bị loại khỏi doanh thu.",
    replaceConfirm: "기존 영수증 사진을 교체할까요? / Thay ảnh biên lai hiện tại?",
    deleteConfirm: "영수증 사진을 삭제할까요? 복구할 수 없습니다. / Xóa ảnh biên lai? Không thể khôi phục.",
    changed: "다른 화면에서 사진이 변경되었습니다. 닫고 다시 확인하세요. / Ảnh đã thay đổi ở màn hình khác. Đóng rồi mở lại.",
    printFailure: "카드 영수증 사진을 모두 불러오지 못해 출력을 중단했습니다. 연결·권한을 확인한 후 다시 시도하세요. / Đã dừng in vì không tải đủ ảnh biên lai thẻ. Kiểm tra kết nối và quyền truy cập rồi thử lại."
  });

  function isEligible(order) {
    return Boolean(order && UUID.test(String(order.id || ""))
      && String(order.payment_method || "").trim().toLowerCase() === "card"
      && String(order.status || "").trim().toLowerCase() === "paid"
      && order.sales_excluded === false);
  }

  function validateMetadata(row, orderId) {
    if (!row || String(row.order_id) !== String(orderId) || !UUID.test(String(orderId))) throw new Error(text.jpeg);
    const parts = String(row.storage_path || "").split("/");
    if (parts.length !== 2 || parts[0] !== String(orderId) || !/\.jpg$/.test(parts[1]) || !UUID.test(parts[1].slice(0, -4))) throw new Error(text.jpeg);
    if (row.mime_type !== "image/jpeg" || !Number.isInteger(row.byte_size) || row.byte_size < 1 || row.byte_size > MAX_JPEG_BYTES) throw new Error(text.jpeg);
    return row;
  }

  async function validateJpeg(blob, expectedSize) {
    if (!blob || blob.type !== "image/jpeg" || !Number.isInteger(blob.size) || blob.size < 4 || blob.size > MAX_JPEG_BYTES
      || (expectedSize != null && blob.size !== expectedSize)) throw new Error(text.jpeg);
    const header = new Uint8Array(await blob.slice(0, 3).arrayBuffer());
    if (header[0] !== 255 || header[1] !== 216 || header[2] !== 255) throw new Error(text.jpeg);
    return blob;
  }

  function secureUuid(crypto) {
    if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
    if (typeof crypto?.getRandomValues !== "function") throw new Error("Secure random generation is unavailable.");
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  // Rasterizing onto a fresh opaque canvas removes the original EXIF/GPS metadata.
  async function normalizeImage(file, environment = global) {
    if (!file || !/^image\//i.test(file.type || "") || !file.size || file.size > MAX_INPUT_BYTES) throw new Error(text.input);
    let source;
    let inputUrl;
    try {
      if (typeof environment.createImageBitmap === "function") {
        try { source = await environment.createImageBitmap(file, { imageOrientation: "from-image" }); } catch (_) { /* Native image fallback (including Safari). */ }
      }
      if (!source) {
        inputUrl = environment.URL.createObjectURL(file);
        source = new environment.Image();
        await new Promise((resolve, reject) => {
          source.onload = resolve;
          source.onerror = () => reject(new Error(text.image));
          source.src = inputUrl;
        });
      }
      const width = source.naturalWidth || source.width;
      const height = source.naturalHeight || source.height;
      if (!(width > 0 && height > 0) || width * height > 100000000) throw new Error(text.image);
      let scale = Math.min(1, MAX_EDGE / Math.max(width, height));
      const canvas = environment.document.createElement("canvas");
      for (let pass = 0; pass < 4; pass += 1) {
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) throw new Error(text.image);
        context.fillStyle = "#fff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(source, 0, 0, canvas.width, canvas.height);
        for (const quality of [0.9, 0.8, 0.68, 0.52, 0.36]) {
          const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", quality));
          if (blob && blob.size <= MAX_JPEG_BYTES) return await validateJpeg(blob);
        }
        scale *= 0.75;
      }
      throw new Error(text.image);
    } catch (error) {
      if (error.message === text.input || error.message === text.jpeg) throw error;
      throw new Error(text.image);
    } finally {
      source?.close?.();
      if (inputUrl) environment.URL.revokeObjectURL(inputUrl);
    }
  }

  async function jpegDataUrl(blob, environment) {
    await validateJpeg(blob);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let index = 0; index < bytes.length; index += 32768) binary += String.fromCharCode(...bytes.subarray(index, index + 32768));
    const value = `data:image/jpeg;base64,${environment.btoa(binary)}`;
    if (!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error(text.jpeg);
    return value;
  }

  function create(options) {
    const sb = options?.supabase;
    if (!sb?.from || !sb?.storage?.from) throw new TypeError("Supabase client is required.");
    const environment = options.environment || global;
    const document = environment.document;
    const getIdentity = options.getIdentity || (() => global.DGV.getIdentity());
    const confirm = options.confirm || (message => environment.confirm(message));
    const cache = new Map();
    const revisions = new Map();
    const buttons = new Map();
    let active = null;

    async function authorize() {
      const identity = await getIdentity();
      if (!["manager", "admin"].includes(identity?.role)) throw new Error(text.role);
    }

    function updateButtons(id) {
      const row = cache.get(id);
      const set = buttons.get(id);
      if (!set) return;
      for (const button of set) {
        if (button.isConnected === false) { set.delete(button); continue; }
        const label = row === undefined ? "전표 사진 확인" : row ? "전표 사진 보기·수정" : "전표 사진 등록";
        button.textContent = "전표";
        button.setAttribute("aria-label", label);
        button.setAttribute("title", label);
        button.dataset.receiptRegistered = row === undefined ? "unknown" : row ? "true" : "false";
      }
      if (!set.size) buttons.delete(id);
    }

    function remember(id, row) {
      cache.set(id, row);
      revisions.set(id, (revisions.get(id) || 0) + 1);
      updateButtons(id);
    }

    async function metadataFor(orders) {
      const ids = Array.from(new Set(orders.filter(isEligible).map(order => String(order.id))));
      const found = new Map();
      for (let index = 0; index < ids.length; index += 100) {
        const chunk = ids.slice(index, index + 100);
        let offset = 0;
        while (true) {
          const result = await sb.from(TABLE).select("order_id,storage_path,byte_size,mime_type,updated_at")
            .in("order_id", chunk).order("order_id", { ascending: true }).range(offset, offset + 99);
          if (result.error) throw result.error;
          const rows = result.data || [];
          for (const row of rows) {
            if (!chunk.includes(String(row.order_id))) throw new Error(text.jpeg);
            found.set(String(row.order_id), validateMetadata(row, row.order_id));
          }
          if (rows.length < 100) break;
          offset += rows.length;
        }
      }
      return { ids, found };
    }

    async function loadStatuses(orders) {
      const started = new Map(revisions);
      const { ids, found } = await metadataFor(orders || []);
      for (const id of ids) {
        if ((revisions.get(id) || 0) !== (started.get(id) || 0)) continue;
        cache.set(id, found.get(id) || null);
        updateButtons(id);
      }
      return found;
    }

    async function download(row) {
      const { data, error } = await sb.storage.from(BUCKET).download(row.storage_path);
      if (error) throw error;
      return validateJpeg(data, row.byte_size);
    }

    async function loadForPrint(orders) {
      const eligible = (orders || []).filter(isEligible);
      if (!eligible.length) return {};
      try {
        await authorize();
        const { found } = await metadataFor(eligible);
        const rows = Array.from(found.values());
        const result = {};
        let cursor = 0;
        await Promise.all(Array.from({ length: Math.min(3, rows.length) }, async () => {
          while (cursor < rows.length) {
            const row = rows[cursor++];
            result[row.order_id] = { dataUrl: await jpegDataUrl(await download(row), environment) };
          }
        }));
        return result;
      } catch (cause) {
        const error = new Error(text.printFailure);
        error.code = "CARD_RECEIPT_PRINT_FAILED";
        error.cause = cause;
        throw error;
      }
    }

    async function currentMetadata(order) {
      const { found } = await metadataFor([order]);
      return found.get(String(order.id)) || null;
    }

    async function cleanup(path) {
      // The storage DELETE policy rejects referenced objects, including ambiguous commits.
      try { await sb.storage.from(BUCKET).remove([path]); } catch (_) { /* Harmless orphan; never retry by overwriting. */ }
    }

    // These operations only affect receipt metadata and storage, never orders or payments.
    async function saveReceipt(order, blob, expectedPath = null) {
      if (!isEligible(order)) throw new Error(text.eligible);
      await authorize();
      await validateJpeg(blob);
      const previous = await currentMetadata(order);
      if ((previous?.storage_path || null) !== expectedPath) throw new Error(text.changed);
      const path = `${order.id}/${secureUuid(environment.crypto)}.jpg`;
      const uploaded = await sb.storage.from(BUCKET).upload(path, blob, { contentType: "image/jpeg", upsert: false, cacheControl: "0" });
      if (uploaded.error) throw uploaded.error;
      const row = { order_id: String(order.id), storage_path: path, byte_size: blob.size, mime_type: "image/jpeg", updated_at: new Date().toISOString() };
      try {
        // Compare-and-set prevents another device's newer photo being overwritten.
        // A new slot uses INSERT so a concurrent first registration conflicts safely.
        const write = previous
          ? sb.from(TABLE).update(row).eq("order_id", order.id).eq("storage_path", expectedPath)
          : sb.from(TABLE).insert(row);
        const persisted = await write.select("order_id,storage_path,byte_size,mime_type,updated_at").single();
        if (persisted.error) throw persisted.error;
        validateMetadata(persisted.data, order.id);
        if (persisted.data.storage_path !== path) throw new Error(text.changed);
        remember(String(order.id), persisted.data);
      } catch (error) {
        await cleanup(path);
        throw error;
      }
      if (previous?.storage_path && previous.storage_path !== path) await cleanup(previous.storage_path);
      return row;
    }

    async function deleteReceipt(order, expectedPath) {
      if (!isEligible(order)) throw new Error(text.eligible);
      await authorize();
      const current = await currentMetadata(order);
      if (!current || current.storage_path !== expectedPath) throw new Error(text.changed);
      // Path predicate prevents deleting a concurrent replacement's metadata.
      const result = await sb.from(TABLE).delete().eq("order_id", order.id).eq("storage_path", expectedPath).select("order_id");
      if (result.error) throw result.error;
      if (!result.data?.length) throw new Error(text.changed);
      remember(String(order.id), null);
      await cleanup(expectedPath);
    }

    function attachButton(button, order) {
      if (!button || !isEligible(order)) return false;
      const id = String(order.id);
      if (!buttons.has(id)) buttons.set(id, new Set());
      buttons.get(id).add(button);
      button.type = "button";
      button.classList.add("cardReceiptButton");
      updateButtons(id);
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        open(order, button);
      });
      return true;
    }

    function close() {
      if (!active || active.busy) return;
      const state = active;
      active = null;
      if (state.url) environment.URL.revokeObjectURL(state.url);
      state.back.remove();
      document.removeEventListener("keydown", state.keydown, true);
      document.body.style.overflow = state.oldOverflow;
      state.trigger?.focus?.();
    }

    async function open(order, trigger) {
      if (!isEligible(order) || active) return;
      const back = document.createElement("div");
      back.className = "cardReceiptBack";
      const dialog = document.createElement("div");
      dialog.className = "cardReceiptDialog";
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "true");
      dialog.setAttribute("aria-labelledby", "cardReceiptTitle");
      dialog.setAttribute("aria-describedby", "cardReceiptHint");
      const element = (tag, content, className) => {
        const node = document.createElement(tag);
        if (content) node.textContent = content;
        if (className) node.className = className;
        return node;
      };
      const heading = element("h2", text.title);
      heading.id = "cardReceiptTitle";
      const hint = element("p", text.hint, "cardReceiptHint");
      hint.id = "cardReceiptHint";
      const status = element("p", text.loading, "cardReceiptStatus");
      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "polite");
      const preview = element("img", "", "cardReceiptPreview");
      preview.alt = text.title;
      preview.hidden = true;
      const actions = element("div", "", "cardReceiptActions");
      const camera = element("button", text.camera, "btn");
      const album = element("button", text.album, "btn");
      const save = element("button", text.save, "btn btnPrimary");
      const remove = element("button", text.remove, "btn btnDanger");
      const cancel = element("button", text.cancel, "btn");
      const dismiss = element("button", "×", "cardReceiptClose btn");
      dismiss.setAttribute("aria-label", text.close);
      for (const button of [camera, album, save, remove, cancel, dismiss]) button.type = "button";
      const cameraInput = element("input");
      const albumInput = element("input");
      for (const input of [cameraInput, albumInput]) {
        input.type = "file";
        input.accept = "image/*";
        input.hidden = true;
        input.tabIndex = -1;
      }
      cameraInput.setAttribute("capture", "environment");
      actions.append(camera, album, save, remove, cancel);
      dialog.append(dismiss, heading, hint, status, preview, cameraInput, albumInput, actions);
      back.append(dialog);
      document.body.append(back);
      const state = { order, trigger: trigger || document.activeElement, back, busy: false, loading: true, existing: null, blob: null, url: null, oldOverflow: document.body.style.overflow };
      active = state;
      document.body.style.overflow = "hidden";
      function render() {
        const disabled = state.busy || state.loading;
        camera.disabled = album.disabled = disabled;
        save.disabled = disabled || !state.blob;
        remove.disabled = disabled || !state.existing;
        remove.hidden = !state.existing;
        cancel.disabled = dismiss.disabled = state.busy;
        dialog.setAttribute("aria-busy", disabled ? "true" : "false");
      }
      function showBlob(blob) {
        if (state.url) environment.URL.revokeObjectURL(state.url);
        state.url = environment.URL.createObjectURL(blob);
        preview.src = state.url;
        preview.hidden = false;
      }
      function fail(error) {
        status.textContent = [text.input, text.image, text.jpeg, text.role, text.changed].includes(error?.message) ? error.message : text.failure;
        status.setAttribute("role", "alert");
      }
      async function selected(input) {
        const file = input.files?.[0];
        input.value = "";
        if (!file || active !== state || state.busy || state.loading) return;
        state.busy = true;
        status.textContent = text.processing;
        render();
        try {
          const blob = await normalizeImage(file, environment);
          if (active !== state) return;
          state.blob = blob;
          showBlob(blob);
          status.textContent = text.ready;
        } catch (error) { fail(error); }
        finally { state.busy = false; if (active === state) render(); }
      }
      // Keep file-picker activation directly in the user's click (especially iOS).
      camera.addEventListener("click", () => cameraInput.click());
      album.addEventListener("click", () => albumInput.click());
      cameraInput.addEventListener("change", () => selected(cameraInput));
      albumInput.addEventListener("change", () => selected(albumInput));
      cancel.addEventListener("click", close);
      dismiss.addEventListener("click", close);
      back.addEventListener("click", event => { if (event.target === back) close(); });
      state.keydown = event => {
        if (active !== state) return;
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
        if (event.key === "Tab") {
          const focusable = [dismiss, camera, album, save, remove, cancel].filter(button => !button.disabled && !button.hidden);
          if (!focusable.length) { event.preventDefault(); return; }
          const first = focusable[0], last = focusable[focusable.length - 1];
          if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
        }
      };
      document.addEventListener("keydown", state.keydown, true);
      save.addEventListener("click", async () => {
        if (state.busy || state.loading || !state.blob) return;
        if (state.existing && !confirm(text.replaceConfirm)) return;
        state.busy = true;
        status.textContent = text.saving;
        render();
        try {
          await saveReceipt(order, state.blob, state.existing?.storage_path || null);
          state.busy = false;
          close();
        } catch (error) { fail(error); }
        finally { state.busy = false; if (active === state) render(); }
      });
      remove.addEventListener("click", async () => {
        if (state.busy || state.loading || !state.existing || !confirm(text.deleteConfirm)) return;
        state.busy = true;
        status.textContent = text.saving;
        render();
        try {
          await deleteReceipt(order, state.existing.storage_path);
          state.busy = false;
          close();
        } catch (error) { fail(error); }
        finally { state.busy = false; if (active === state) render(); }
      });
      render();
      dismiss.focus();
      try {
        await authorize();
        const row = await currentMetadata(order);
        if (active !== state) return;
        state.existing = row;
        remember(String(order.id), row);
        if (row) {
          const blob = await download(row);
          if (active !== state) return;
          showBlob(blob);
        }
        status.textContent = row ? text.registered : text.empty;
        state.loading = false;
      } catch (error) {
        if (active !== state) return;
        fail(error);
        // A failed read must never be mistaken for an empty receipt slot.
      }
      if (active === state) render();
    }

    return Object.freeze({ attachButton, loadStatuses, loadForPrint, open, close, saveReceipt, deleteReceipt });
  }

  global.DGV_CARD_RECEIPTS = Object.freeze({ create, isEligible, normalizeImage, validateMetadata, validateJpeg, MAX_INPUT_BYTES, MAX_JPEG_BYTES, MAX_EDGE });
})(typeof window === "object" ? window : globalThis);
