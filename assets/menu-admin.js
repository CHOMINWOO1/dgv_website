(function initMenuAdmin(global) {
  "use strict";

  const sb = global.DGV.supabase;
  const ui = global.QRStaff;
  const MENU_KEYS = Object.freeze([
    "type", "qr_category", "ko_name", "vi_name", "en_name",
    "description_ko", "description_en", "description_vi",
    "price_usd", "price_vnd", "image_url",
    "is_active", "is_orderable", "is_sold_out", "requires_preorder", "sort_order"
  ]);
  const IMAGE_BUCKET = "qr-menu-images";
  const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
  const MAX_SOURCE_IMAGE_BYTES = 20 * 1024 * 1024;
  const MAX_UPLOAD_IMAGE_BYTES = 4_750_000;
  const MAX_SOURCE_IMAGE_PIXELS = 50_000_000;
  const MANAGED_IMAGE_OBJECT_PATH = /^menus\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:jpe?g|png|webp)$/;
  const SUPABASE_ORIGIN = new URL(global.DGV.config.url).origin;
  const IMAGE_PUBLIC_PATH_PREFIX = `/storage/v1/object/public/${IMAGE_BUCKET}/`;
  const IMAGE_COMPRESSION_PASSES = Object.freeze([
    { maxDimension: 1600, quality: 0.84 },
    { maxDimension: 1440, quality: 0.76 },
    { maxDimension: 1280, quality: 0.68 },
    { maxDimension: 1080, quality: 0.60 }
  ]);
  const TABLE_QR_CACHE_KEY = "dgv.table-qr-cache.v1";
  const TABLE_QR_CACHE_VERSION = 1;
  const MAX_TABLE_QR_CACHE_ENTRIES = 100;
  const MAX_TABLE_QR_CACHE_BYTES = 100_000;
  const TABLE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const TABLE_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

  let menus = [];
  let tables = [];
  let selectedId = null;
  let creatingMenu = false;
  let currentTokenUrl = null;
  let currentTokenLabel = null;
  let selectedImageFile = null;
  let selectedImagePreviewUrl = null;
  let menuSaveInProgress = false;
  let showArchivedMenus = false;
  let activeMenuSummary = { count: 0, orderable: 0, soldOut: 0 };

  function normalizedTableQrUrl(value) {
    if (typeof value !== "string" || !value || value !== value.trim()) return null;
    try {
      const url = new URL(value);
      const menuUrl = new URL("menu.html", global.location.href);
      if (url.origin !== menuUrl.origin || url.pathname !== menuUrl.pathname) return null;
      if (url.protocol !== menuUrl.protocol || url.username || url.password || url.search) return null;
      if (!/^#t=[0-9a-f]{64}$/.test(url.hash)) return null;
      return url.toString() === value ? value : null;
    } catch (_error) {
      return null;
    }
  }

  function readTableQrCache() {
    let parsed;
    try {
      const raw = global.localStorage.getItem(TABLE_QR_CACHE_KEY);
      if (!raw) return [];
      if (raw.length > MAX_TABLE_QR_CACHE_BYTES) return [];
      parsed = JSON.parse(raw);
    } catch (_error) {
      return [];
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    if (parsed.version !== TABLE_QR_CACHE_VERSION || !Array.isArray(parsed.entries)) return [];
    if (Object.keys(parsed).sort().join(",") !== "entries,version") return [];

    const entries = [];
    const seenTableIds = new Set();
    for (const candidate of parsed.entries) {
      if (entries.length >= MAX_TABLE_QR_CACHE_ENTRIES) break;
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
      if (Object.keys(candidate).sort().join(",") !== "table_id,url") continue;
      const tableId = candidate.table_id;
      const url = normalizedTableQrUrl(candidate.url);
      if (typeof tableId !== "string" || !TABLE_ID_PATTERN.test(tableId) || !url || seenTableIds.has(tableId)) continue;
      entries.push({ table_id: tableId, url });
      seenTableIds.add(tableId);
    }
    return entries;
  }

  function cacheTableQrUrl(tableId, url) {
    const normalizedUrl = normalizedTableQrUrl(url);
    if (typeof tableId !== "string" || !TABLE_ID_PATTERN.test(tableId) || !normalizedUrl) return false;
    const entries = readTableQrCache().filter((entry) => entry.table_id !== tableId);
    entries.unshift({ table_id: tableId, url: normalizedUrl });
    try {
      global.localStorage.setItem(TABLE_QR_CACHE_KEY, JSON.stringify({
        version: TABLE_QR_CACHE_VERSION,
        entries: entries.slice(0, MAX_TABLE_QR_CACHE_ENTRIES)
      }));
      return true;
    } catch (_error) {
      return false;
    }
  }

  function cachedTableQrUrl(tableId) {
    if (typeof tableId !== "string" || !TABLE_ID_PATTERN.test(tableId)) return null;
    return readTableQrCache().find((entry) => entry.table_id === tableId)?.url || null;
  }

  function removeCachedTableQrUrl(tableId) {
    if (typeof tableId !== "string" || !TABLE_ID_PATTERN.test(tableId)) return false;
    const entries = readTableQrCache().filter((entry) => entry.table_id !== tableId);
    try {
      global.localStorage.setItem(TABLE_QR_CACHE_KEY, JSON.stringify({
        version: TABLE_QR_CACHE_VERSION,
        entries
      }));
      return true;
    } catch (_error) {
      return false;
    }
  }

  function nullIfBlank(value) {
    const text = String(value ?? "").trim();
    return text || null;
  }

  function imageUploadError(message) {
    const error = new Error(message);
    error.userMessage = message;
    return error;
  }

  function isConfirmedDatabaseRejection(error) {
    const code = String(error?.code || "").trim().toUpperCase();
    return /^[0-9A-Z]{5}$/.test(code) || /^PGRST\d{3}$/.test(code);
  }

  function formatFileSize(bytes) {
    const numeric = Math.max(0, Number(bytes) || 0);
    if (numeric < 1024 * 1024) return `${Math.max(1, Math.round(numeric / 1024)).toLocaleString("ko-KR")}KB`;
    return `${(numeric / (1024 * 1024)).toFixed(1)}MB`;
  }

  function setImageUploadStatus(message, tone = "info") {
    const status = ui.byId("imageUploadStatus");
    status.textContent = message;
    status.dataset.tone = tone;
  }

  function safePreviewUrl(value) {
    const source = String(value || "").trim();
    if (!source) return "";
    try {
      const url = new URL(source, global.location.href);
      if (url.protocol === "https:") return url.href;
      if (url.protocol === "http:" && url.origin === global.location.origin) return url.href;
      return "";
    } catch (_error) {
      return "";
    }
  }

  function managedImageObjectPath(value) {
    const source = String(value || "").trim();
    if (!source) return null;
    try {
      const url = new URL(source);
      if (url.protocol !== "https:" || url.origin !== SUPABASE_ORIGIN || url.username || url.password || url.search || url.hash) return null;
      if (url.href !== source) return null;
      if (!url.pathname.startsWith(IMAGE_PUBLIC_PATH_PREFIX)) return null;
      const objectPath = url.pathname.slice(IMAGE_PUBLIC_PATH_PREFIX.length);
      if (objectPath.includes("%") || objectPath.includes("\\") || objectPath.includes("//")) return null;
      return MANAGED_IMAGE_OBJECT_PATH.test(objectPath) ? objectPath : null;
    } catch (_error) {
      return null;
    }
  }

  function referencedManagedImageObjectPath(value) {
    const source = String(value || "").trim();
    if (!source) return null;
    try {
      const url = new URL(source);
      if (url.protocol !== "https:" || url.origin !== SUPABASE_ORIGIN || url.username || url.password) return null;
      if (!url.pathname.startsWith(IMAGE_PUBLIC_PATH_PREFIX)) return null;
      const objectPath = decodeURIComponent(url.pathname.slice(IMAGE_PUBLIC_PATH_PREFIX.length));
      return MANAGED_IMAGE_OBJECT_PATH.test(objectPath) ? objectPath : null;
    } catch (_error) {
      return null;
    }
  }

  function renderImagePreview(source, options = {}) {
    const image = ui.byId("menuImagePreview");
    const empty = ui.byId("menuImageEmpty");
    const previewUrl = options.trustedBlob === true ? String(source || "") : safePreviewUrl(source);
    image.onload = null;
    image.onerror = null;

    if (!previewUrl) {
      image.hidden = true;
      image.removeAttribute("src");
      empty.hidden = false;
      empty.textContent = source ? "이 경로는 안전한 미리보기를 지원하지 않습니다." : "등록된 사진이 없습니다.";
      return;
    }

    image.hidden = true;
    empty.hidden = false;
    empty.textContent = "사진을 불러오는 중입니다…";
    image.onload = () => {
      image.hidden = false;
      empty.hidden = true;
    };
    image.onerror = () => {
      image.hidden = true;
      image.removeAttribute("src");
      empty.hidden = false;
      empty.textContent = "사진을 불러오지 못했습니다.";
    };
    image.src = previewUrl;
  }

  function clearSelectedImageFile() {
    if (selectedImagePreviewUrl) URL.revokeObjectURL(selectedImagePreviewUrl);
    selectedImagePreviewUrl = null;
    selectedImageFile = null;
    const input = ui.byId("menuImageFile");
    if (input) input.value = "";
  }

  function validateSelectedImage(file) {
    if (!file || file.size <= 0) return "내용이 있는 사진 파일을 선택해 주세요.";
    if (!ALLOWED_IMAGE_TYPES.has(String(file.type || "").toLowerCase())) {
      return "JPG, PNG 또는 WebP 사진만 선택할 수 있습니다.";
    }
    if (file.size > MAX_SOURCE_IMAGE_BYTES) {
      return "원본 사진은 20MB 이하여야 합니다.";
    }
    return null;
  }

  function chooseImage(event) {
    const file = event.target.files?.[0] || null;
    clearSelectedImageFile();
    if (!file) {
      renderImagePreview(ui.byId("imageUrl").value);
      setImageUploadStatus("사진을 선택하면 메뉴 저장 시 자동 업로드합니다.");
      return;
    }

    const validation = validateSelectedImage(file);
    if (validation) {
      renderImagePreview(ui.byId("imageUrl").value);
      setImageUploadStatus(validation, "error");
      ui.toast(validation, "error");
      return;
    }

    selectedImageFile = file;
    selectedImagePreviewUrl = URL.createObjectURL(file);
    renderImagePreview(selectedImagePreviewUrl, { trustedBlob: true });
    setImageUploadStatus(`${file.name} · ${formatFileSize(file.size)} · 메뉴 저장 시 WebP로 변환하여 자동 업로드합니다.`);
  }

  async function decodeImage(file) {
    if (typeof global.createImageBitmap === "function") {
      try {
        const bitmap = await global.createImageBitmap(file, { imageOrientation: "from-image" });
        return { source: bitmap, close: () => bitmap.close?.() };
      } catch (_error) {
        // Some older browsers do not support imageOrientation. The Image
        // element fallback still decodes only into a canvas before upload.
      }
    }

    const objectUrl = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.decoding = "async";
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(imageUploadError("사진 파일을 읽지 못했습니다."));
        image.src = objectUrl;
      });
      return { source: image, close: () => undefined };
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  function drawImageToCanvas(source, maxDimension) {
    const sourceWidth = Number(source.width || source.naturalWidth || 0);
    const sourceHeight = Number(source.height || source.naturalHeight || 0);
    if (!sourceWidth || !sourceHeight) throw imageUploadError("사진 크기를 확인하지 못했습니다.");
    if (sourceWidth * sourceHeight > MAX_SOURCE_IMAGE_PIXELS) {
      throw imageUploadError("사진 해상도가 너무 큽니다. 5천만 픽셀 이하 사진을 선택해 주세요.");
    }

    const scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw imageUploadError("이 브라우저에서는 사진을 변환할 수 없습니다.");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(source, 0, 0, width, height);
    return canvas;
  }

  function canvasToWebp(canvas, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob || blob.type !== "image/webp") {
          reject(imageUploadError("이 브라우저에서는 WebP 사진 변환을 지원하지 않습니다."));
          return;
        }
        resolve(blob);
      }, "image/webp", quality);
    });
  }

  async function prepareImageForUpload(file) {
    const decoded = await decodeImage(file);
    try {
      let latest = null;
      for (const pass of IMAGE_COMPRESSION_PASSES) {
        const canvas = drawImageToCanvas(decoded.source, pass.maxDimension);
        const blob = await canvasToWebp(canvas, pass.quality);
        latest = { blob, width: canvas.width, height: canvas.height };
        canvas.width = 1;
        canvas.height = 1;
        if (blob.size <= MAX_UPLOAD_IMAGE_BYTES) return latest;
      }
      throw imageUploadError(`사진을 5MB 이하로 줄이지 못했습니다. 더 작은 사진을 선택해 주세요. (${formatFileSize(latest?.blob?.size)})`);
    } finally {
      decoded.close();
    }
  }

  function randomUuidV4() {
    if (typeof global.crypto?.randomUUID === "function") return global.crypto.randomUUID().toLowerCase();
    if (typeof global.crypto?.getRandomValues !== "function") {
      throw imageUploadError("안전한 파일 이름을 만들 수 없는 브라우저입니다.");
    }
    const bytes = global.crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0"));
    return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
  }

  async function uploadMenuImage(file, onStored) {
    const validation = validateSelectedImage(file);
    if (validation) throw imageUploadError(validation);

    setImageUploadStatus("사진에서 불필요한 메타데이터를 제거하고 WebP로 변환하고 있습니다.");
    const prepared = await prepareImageForUpload(file);
    setImageUploadStatus(`${prepared.width}×${prepared.height} · ${formatFileSize(prepared.blob.size)} · Supabase에 업로드하고 있습니다.`);
    const objectPath = `menus/${randomUuidV4()}.webp`;
    const { data, error } = await sb.storage
      .from(IMAGE_BUCKET)
      .upload(objectPath, prepared.blob, {
        cacheControl: "31536000",
        contentType: "image/webp",
        upsert: false
      });
    if (error) throw error;

    const storedPath = String(data?.path || objectPath);
    if (!MANAGED_IMAGE_OBJECT_PATH.test(storedPath)) {
      onStored(objectPath);
      throw imageUploadError("업로드된 사진 경로를 안전하게 확인하지 못했습니다.");
    }
    onStored(storedPath);
    const { data: publicData } = sb.storage.from(IMAGE_BUCKET).getPublicUrl(storedPath);
    const publicUrl = safePreviewUrl(publicData?.publicUrl);
    if (!publicUrl || managedImageObjectPath(publicUrl) !== storedPath) {
      throw imageUploadError("업로드된 사진 주소를 확인하지 못했습니다.");
    }
    return { objectPath: storedPath, publicUrl, width: prepared.width, height: prepared.height };
  }

  async function removeMenuImageObject(objectPath) {
    const normalizedPath = String(objectPath || "");
    if (!MANAGED_IMAGE_OBJECT_PATH.test(normalizedPath)) {
      throw imageUploadError("관리형 메뉴 사진 경로가 아니므로 삭제하지 않았습니다.");
    }
    const { error } = await sb.storage.from(IMAGE_BUCKET).remove([normalizedPath]);
    if (error) throw error;
  }

  async function countManagedImageObjectReferences(objectPath) {
    const rows = await global.DGV.collectSupabasePages(
      () => sb.from("menu_items").select("id,image_url").not("image_url", "is", null),
      { pageSize: 500, order: [{ column: "id", ascending: true }] }
    );
    return rows.filter((row) => referencedManagedImageObjectPath(row.image_url) === objectPath).length;
  }

  async function removePreviousImageIfUnreferenced(imageUrl) {
    const objectPath = managedImageObjectPath(imageUrl);
    if (!objectPath) return false;
    if (await countManagedImageObjectReferences(objectPath) > 0) return false;

    await removeMenuImageObject(objectPath);
    return true;
  }

  function clearImageUrl() {
    clearSelectedImageFile();
    ui.byId("imageUrl").value = "";
    renderImagePreview("");
    setImageUploadStatus("이미지 경로를 비웠습니다. 메뉴 저장 버튼을 눌러 반영해 주세요.");
  }

  function normalizedItem(item) {
    return {
      type: String(item?.type || "other").trim(),
      qr_category: ["single", "shared", "snack", "preorder", "drink", "cafe"].includes(item?.qr_category)
        ? item.qr_category
        : (item?.type === "drink" ? "drink" : "single"),
      ko_name: nullIfBlank(item?.ko_name),
      vi_name: nullIfBlank(item?.vi_name),
      en_name: nullIfBlank(item?.en_name),
      description_ko: nullIfBlank(item?.description_ko),
      description_en: nullIfBlank(item?.description_en),
      description_vi: nullIfBlank(item?.description_vi),
      price_usd: Math.max(0, Math.round(Number(item?.price_usd) || 0)),
      price_vnd: Math.max(0, Math.round(Number(item?.price_vnd) || 0)),
      image_url: nullIfBlank(item?.image_url),
      is_active: item?.is_active !== false,
      is_orderable: item?.is_orderable !== false,
      is_sold_out: item?.is_sold_out === true,
      requires_preorder: item?.requires_preorder === true,
      sort_order: Math.max(0, Math.round(Number(item?.sort_order) || 0))
    };
  }

  function showBanner(message, tone = "error") {
    const banner = ui.byId("adminBanner");
    banner.textContent = message;
    banner.dataset.tone = tone;
    banner.hidden = false;
  }

  function hideBanner() {
    ui.byId("adminBanner").hidden = true;
  }

  function renderSummary() {
    ui.byId("menuCount").textContent = activeMenuSummary.count.toLocaleString("ko-KR");
    ui.byId("orderableCount").textContent = activeMenuSummary.orderable.toLocaleString("ko-KR");
    ui.byId("soldOutCount").textContent = activeMenuSummary.soldOut.toLocaleString("ko-KR");
    ui.byId("activeTableCount").textContent = tables.filter((table) => table.is_active !== false).length.toLocaleString("ko-KR");
  }

  function updateMenuListMode() {
    const toggle = ui.byId("archivedMenuToggleBtn");
    toggle.textContent = showArchivedMenus ? "현재 메뉴 보기" : "삭제 메뉴 보기";
    toggle.setAttribute("aria-pressed", String(showArchivedMenus));
    ui.byId("newMenuBtn").hidden = showArchivedMenus;
    ui.byId("menuListTitle").textContent = showArchivedMenus ? "삭제된 메뉴" : "메뉴 목록";
    ui.byId("menuListHint").textContent = showArchivedMenus
      ? "삭제된 메뉴도 가격, 사진, 기존 주문 기록은 그대로 보관됩니다."
      : "Supabase에 저장된 현재 가격입니다.";
  }

  function renderTypeFilter() {
    const select = ui.byId("menuTypeFilter");
    const previous = select.value;
    const types = [...new Set(menus.map((item) => String(item.type || "other")))].sort((a, b) => a.localeCompare(b));
    select.innerHTML = '<option value="">모든 분류</option>' + types
      .map((type) => `<option value="${global.DGV.escapeHTML(type)}">${global.DGV.escapeHTML(type)}</option>`)
      .join("");
    if (types.includes(previous)) select.value = previous;
  }

  function filteredMenus() {
    const keyword = ui.byId("menuSearch").value.trim().toLocaleLowerCase();
    const type = ui.byId("menuTypeFilter").value;
    return menus.filter((item) => {
      if (type && item.type !== type) return false;
      if (!keyword) return true;
      return [item.ko_name, item.en_name, item.vi_name, item.type]
        .some((value) => String(value || "").toLocaleLowerCase().includes(keyword));
    });
  }

  function renderMenuList() {
    const list = ui.byId("menuList");
    const rows = filteredMenus();
    if (!rows.length) {
      list.innerHTML = `<div class="qr-empty">${showArchivedMenus ? "삭제된 메뉴가 없습니다." : "조건에 맞는 메뉴가 없습니다."}</div>`;
      return;
    }
    list.innerHTML = rows.map((item) => {
      const selected = item.id === selectedId ? " is-selected" : "";
      const statuses = [];
      if (item.archived_at) statuses.push("삭제됨");
      if (item.is_active === false) statuses.push("직원 메뉴 숨김");
      if (item.is_orderable === false) statuses.push("QR 주문 불가");
      if (item.is_sold_out === true) statuses.push("품절");
      return `
        <button class="qr-menu-row${selected}" type="button" data-menu-id="${item.id}">
          <span>
            <span class="qr-menu-row-name">${global.DGV.escapeHTML(item.ko_name || item.en_name || item.vi_name || "이름 없음")}</span>
            <span class="qr-menu-row-sub">${global.DGV.escapeHTML([item.type, item.qr_category, item.en_name, item.vi_name, ...statuses].filter(Boolean).join(" · "))}</span>
          </span>
          <span class="qr-menu-row-price">${ui.formatVnd(item.price_vnd)}<br><span class="qr-hint">${ui.formatUsd(item.price_usd)}</span></span>
        </button>`;
    }).join("");
  }

  function setFormValues(item) {
    const value = normalizedItem(item);
    clearSelectedImageFile();
    ui.byId("menuType").value = value.type;
    ui.byId("qrCategory").value = value.qr_category;
    ui.byId("sortOrder").value = value.sort_order;
    ui.byId("koName").value = value.ko_name || "";
    ui.byId("viName").value = value.vi_name || "";
    ui.byId("enName").value = value.en_name || "";
    ui.byId("priceVnd").value = value.price_vnd;
    ui.byId("priceUsd").value = value.price_usd;
    ui.byId("imageUrl").value = value.image_url || "";
    ui.byId("descriptionKo").value = value.description_ko || "";
    ui.byId("descriptionVi").value = value.description_vi || "";
    ui.byId("descriptionEn").value = value.description_en || "";
    ui.byId("isActive").checked = value.is_active;
    ui.byId("isOrderable").checked = value.is_orderable;
    ui.byId("isSoldOut").checked = value.is_sold_out;
    ui.byId("requiresPreorder").checked = value.requires_preorder;
    renderImagePreview(value.image_url || "");
    setImageUploadStatus(value.image_url
      ? "현재 메뉴 사진입니다. 새 사진을 올리면 기존 경로는 메뉴 저장 후 교체됩니다."
      : "사진을 선택하면 메뉴 저장 시 자동 업로드합니다.");
  }

  function formValues() {
    return normalizedItem({
      type: ui.byId("menuType").value,
      qr_category: ui.byId("qrCategory").value,
      sort_order: ui.byId("sortOrder").value,
      ko_name: ui.byId("koName").value,
      vi_name: ui.byId("viName").value,
      en_name: ui.byId("enName").value,
      price_vnd: ui.byId("priceVnd").value,
      price_usd: ui.byId("priceUsd").value,
      image_url: ui.byId("imageUrl").value,
      description_ko: ui.byId("descriptionKo").value,
      description_vi: ui.byId("descriptionVi").value,
      description_en: ui.byId("descriptionEn").value,
      is_active: ui.byId("isActive").checked,
      is_orderable: ui.byId("isOrderable").checked,
      is_sold_out: ui.byId("isSoldOut").checked,
      requires_preorder: ui.byId("requiresPreorder").checked
    });
  }

  function validateMenu(item) {
    if (!item.type) return "분류를 입력해 주세요.";
    if (!item.ko_name) return "한국어 메뉴명을 입력해 주세요.";
    if (item.price_vnd < 0 || item.price_usd < 0) return "가격은 0 이상이어야 합니다.";
    if (item.is_sold_out && !item.is_orderable) return null;
    return null;
  }

  function selectMenu(id, options = {}) {
    if (menuSaveInProgress && options.force !== true) {
      ui.toast("메뉴 처리가 끝난 뒤 다른 메뉴를 선택해 주세요.");
      return;
    }
    const item = menus.find((row) => row.id === id);
    if (!item) return;
    const archived = Boolean(item.archived_at);
    creatingMenu = false;
    selectedId = item.id;
    setFormValues(item);
    ui.byId("editorTitle").textContent = item.ko_name || "메뉴 편집";
    ui.byId("editorHint").textContent = archived
      ? `ID ${ui.shortId(item.id)} · 복구 후 내용을 검토하고 다시 표시할 수 있습니다.`
      : `ID ${ui.shortId(item.id)} · 저장하면 QR 메뉴와 직원 계산 페이지에 반영됩니다.`;
    ui.byId("editorState").textContent = archived ? "삭제됨" : "편집 중";
    ui.byId("editorState").dataset.tone = archived ? "cancelled" : "working";
    ui.byId("saveMenuBtn").disabled = archived;
    ui.byId("archiveMenuBtn").hidden = archived;
    ui.byId("restoreMenuBtn").hidden = !archived;
    ui.byId("resetMenuBtn").disabled = false;
    renderMenuList();
  }

  function newMenu() {
    if (menuSaveInProgress) {
      ui.toast("메뉴 저장이 끝난 뒤 새 메뉴를 추가해 주세요.");
      return;
    }
    selectedId = null;
    creatingMenu = true;
    const maxSort = menus.reduce((max, item) => Math.max(max, Number(item.sort_order) || 0), 0);
    setFormValues({
      type: "other",
      qr_category: "single",
      sort_order: maxSort + 10,
      price_vnd: 0,
      price_usd: 0,
      is_active: true,
      is_orderable: true,
      is_sold_out: false,
      requires_preorder: false
    });
    ui.byId("editorTitle").textContent = "새 메뉴 추가";
    ui.byId("editorHint").textContent = "가격은 Supabase에 저장되며 고객 주문 시 서버가 다시 확인합니다.";
    ui.byId("editorState").textContent = "새 메뉴";
    ui.byId("editorState").dataset.tone = "new";
    ui.byId("saveMenuBtn").disabled = false;
    ui.byId("archiveMenuBtn").hidden = true;
    ui.byId("restoreMenuBtn").hidden = true;
    ui.byId("resetMenuBtn").disabled = false;
    renderMenuList();
    ui.byId("koName").focus();
  }

  function clearMenuEditor(title, hint) {
    selectedId = null;
    creatingMenu = false;
    clearSelectedImageFile();
    ui.byId("menuForm").reset();
    renderImagePreview("");
    setImageUploadStatus("메뉴를 선택하면 사진과 내용을 확인할 수 있습니다.");
    ui.byId("editorTitle").textContent = title;
    ui.byId("editorHint").textContent = hint;
    ui.byId("editorState").textContent = "선택 안 됨";
    ui.byId("editorState").dataset.tone = "done";
    ui.byId("saveMenuBtn").disabled = true;
    ui.byId("archiveMenuBtn").hidden = true;
    ui.byId("restoreMenuBtn").hidden = true;
    ui.byId("resetMenuBtn").disabled = true;
    renderMenuList();
  }

  function resetMenu() {
    if (creatingMenu) newMenu();
    else if (selectedId) selectMenu(selectedId);
  }

  function diffPatch(original, next) {
    const before = normalizedItem(original);
    if (original?.qr_category == null) before.qr_category = null;
    return Object.fromEntries(MENU_KEYS
      .filter((key) => before[key] !== next[key])
      .map((key) => [key, next[key]]));
  }

  async function saveMenu(event) {
    event.preventDefault();
    if (menuSaveInProgress) {
      ui.toast("메뉴를 저장하고 있습니다. 잠시만 기다려 주세요.");
      return;
    }
    const next = formValues();
    const validation = validateMenu(next);
    if (validation) {
      ui.toast(validation, "error");
      return;
    }
    const button = ui.byId("saveMenuBtn");
    const fileInput = ui.byId("menuImageFile");
    const clearButton = ui.byId("clearImageBtn");
    const file = selectedImageFile;
    const original = creatingMenu ? null : menus.find((item) => item.id === selectedId);
    const previousImageUrl = nullIfBlank(original?.image_url);
    let uploadedObjectPath = null;
    let menuSaved = false;
    let dbWriteAttempted = false;
    let savedId = selectedId;
    menuSaveInProgress = true;
    fileInput.disabled = true;
    clearButton.disabled = true;
    ui.setBusy(button, true, "저장 중…");
    try {
      if (file) {
        button.textContent = "사진 처리 중…";
        const uploaded = await uploadMenuImage(file, (objectPath) => {
          uploadedObjectPath = objectPath;
        });
        next.image_url = uploaded.publicUrl;
        button.textContent = "메뉴 저장 중…";
      }

      let result;
      if (creatingMenu) {
        dbWriteAttempted = true;
        const response = await sb.rpc("app_create_menu_item", { p_item: next });
        if (response.error) throw response.error;
        result = response.data;
      } else {
        const patch = diffPatch(original, next);
        if (!Object.keys(patch).length) {
          ui.toast("변경된 내용이 없습니다.");
          return;
        }
        dbWriteAttempted = true;
        const response = await sb.rpc("app_update_menu_item", {
          p_item_id: selectedId,
          p_patch: patch
        });
        if (response.error) throw response.error;
        result = response.data;
      }
      menuSaved = true;
      savedId = result?.id || selectedId;
      if (file) {
        ui.byId("imageUrl").value = next.image_url || "";
        clearSelectedImageFile();
        renderImagePreview(next.image_url);
        setImageUploadStatus("사진이 업로드되어 메뉴에 반영되었습니다.", "ok");
      }
      ui.toast(creatingMenu ? "새 메뉴가 추가되었습니다." : "메뉴가 저장되었습니다.", "ok");

      try {
        await loadMenus();
        if (savedId) selectMenu(savedId, { force: true });
      } catch (refreshError) {
        console.error("Menu saved, but the refreshed menu list could not be loaded.", refreshError);
        showBanner("메뉴는 저장되었지만 최신 목록을 불러오지 못했습니다. 새로고침해 주세요.");
      }

      if (previousImageUrl && previousImageUrl !== next.image_url) {
        try {
          await removePreviousImageIfUnreferenced(previousImageUrl);
        } catch (cleanupError) {
          console.error("Menu saved, but the previous managed image could not be cleaned up.", cleanupError);
          ui.toast("메뉴는 저장되었지만 이전 사진을 정리하지 못했습니다. 나중에 다시 확인해 주세요.", "error");
        }
      }
    } catch (error) {
      console.error(error);
      let cleanupDeferred = false;
      if (uploadedObjectPath && !menuSaved) {
        const safeToCompensate = !dbWriteAttempted || isConfirmedDatabaseRejection(error);
        try {
          if (safeToCompensate) await removeMenuImageObject(uploadedObjectPath);
          else cleanupDeferred = true;
        } catch (cleanupError) {
          cleanupDeferred = true;
          console.error("The failed menu save could not safely confirm image cleanup.", cleanupError);
        }
      }
      if (file && !menuSaved) {
        renderImagePreview(selectedImagePreviewUrl, { trustedBlob: true });
        setImageUploadStatus(cleanupDeferred
          ? "메뉴 저장 응답을 확인하지 못해 업로드 사진을 안전하게 보존했습니다. 새로고침으로 저장 여부를 확인해 주세요. 선택한 사진도 유지됩니다."
          : "메뉴 저장에 실패했습니다. 선택한 사진은 유지되므로 문제를 확인한 뒤 다시 저장해 주세요.", "error");
      }
      ui.toast(ui.messageOf(error, "메뉴를 저장하지 못했습니다. DB 배포 상태와 입력값을 확인해 주세요."), "error");
    } finally {
      menuSaveInProgress = false;
      fileInput.disabled = false;
      clearButton.disabled = false;
      ui.setBusy(button, false);
    }
  }

  async function archiveMenu() {
    if (menuSaveInProgress) {
      ui.toast("메뉴 처리가 끝날 때까지 잠시 기다려 주세요.");
      return;
    }
    const item = menus.find((row) => row.id === selectedId);
    if (!item || item.archived_at) return;
    const name = item.ko_name || item.en_name || item.vi_name || "선택한 메뉴";
    if (!global.confirm(`“${name}” 메뉴를 삭제하시겠습니까?\n\nQR 메뉴와 직원 메뉴에서는 숨겨지지만 가격, 사진, 기존 주문 기록은 삭제되지 않습니다.`)) return;

    const button = ui.byId("archiveMenuBtn");
    menuSaveInProgress = true;
    ui.setBusy(button, true, "삭제 중…");
    try {
      const { error } = await sb.rpc("app_archive_menu_item", { p_item_id: item.id });
      if (error) throw error;
      selectedId = null;
      creatingMenu = false;
      ui.toast("메뉴를 삭제 처리했습니다. 삭제 메뉴 보기에서 복구할 수 있습니다.", "ok");
      try {
        await loadMenus();
        if (menus[0]) selectMenu(menus[0].id, { force: true });
        else clearMenuEditor("등록된 메뉴가 없습니다", "새 메뉴 버튼으로 메뉴를 추가할 수 있습니다.");
      } catch (refreshError) {
        console.error("Menu archived, but the refreshed menu list could not be loaded.", refreshError);
        clearMenuEditor("목록을 새로고침해 주세요", "메뉴는 삭제 처리되었지만 최신 목록을 불러오지 못했습니다.");
        showBanner("메뉴는 삭제 처리되었지만 최신 목록을 불러오지 못했습니다. 새로고침해 주세요.");
      }
    } catch (error) {
      console.error(error);
      ui.toast(ui.messageOf(error, "메뉴 삭제 결과를 확인하지 못했습니다. 새로고침 후 상태를 확인해 주세요."), "error");
    } finally {
      menuSaveInProgress = false;
      ui.setBusy(button, false);
    }
  }

  async function restoreMenu() {
    if (menuSaveInProgress) {
      ui.toast("메뉴 처리가 끝날 때까지 잠시 기다려 주세요.");
      return;
    }
    const item = menus.find((row) => row.id === selectedId);
    if (!item?.archived_at) return;
    const name = item.ko_name || item.en_name || item.vi_name || "선택한 메뉴";
    if (!global.confirm(`“${name}” 메뉴를 복구하시겠습니까?\n\n복구 후 가격과 판매 상태를 확인하고 저장해 주세요.`)) return;

    const button = ui.byId("restoreMenuBtn");
    menuSaveInProgress = true;
    ui.setBusy(button, true, "복구 중…");
    try {
      const { data, error } = await sb.rpc("app_restore_menu_item", { p_item_id: item.id });
      if (error) throw error;
      showArchivedMenus = false;
      updateMenuListMode();
      ui.toast("메뉴를 복구했습니다. 판매 상태를 확인한 뒤 저장해 주세요.", "ok");
      try {
        await loadMenus();
        const restoredId = data?.id || item.id;
        if (menus.some((row) => row.id === restoredId)) selectMenu(restoredId, { force: true });
        else if (menus[0]) selectMenu(menus[0].id, { force: true });
        else clearMenuEditor("등록된 메뉴가 없습니다", "새 메뉴 버튼으로 메뉴를 추가할 수 있습니다.");
      } catch (refreshError) {
        console.error("Menu restored, but the refreshed menu list could not be loaded.", refreshError);
        clearMenuEditor("목록을 새로고침해 주세요", "메뉴는 복구되었지만 최신 목록을 불러오지 못했습니다.");
        showBanner("메뉴는 복구되었지만 최신 목록을 불러오지 못했습니다. 새로고침해 주세요.");
      }
    } catch (error) {
      console.error(error);
      ui.toast(ui.messageOf(error, "메뉴 복구 결과를 확인하지 못했습니다. 새로고침 후 상태를 확인해 주세요."), "error");
    } finally {
      menuSaveInProgress = false;
      ui.setBusy(button, false);
    }
  }

  async function toggleArchivedMenus() {
    if (menuSaveInProgress) {
      ui.toast("메뉴 처리가 끝날 때까지 잠시 기다려 주세요.");
      return;
    }
    const button = ui.byId("archivedMenuToggleBtn");
    showArchivedMenus = !showArchivedMenus;
    updateMenuListMode();
    ui.setBusy(button, true, "불러오는 중…");
    try {
      await loadMenus();
      if (menus[0]) selectMenu(menus[0].id, { force: true });
      else if (showArchivedMenus) clearMenuEditor("삭제된 메뉴가 없습니다", "삭제 처리된 메뉴가 생기면 이곳에서 복구할 수 있습니다.");
      else clearMenuEditor("등록된 메뉴가 없습니다", "새 메뉴 버튼으로 메뉴를 추가할 수 있습니다.");
    } catch (error) {
      console.error(error);
      clearMenuEditor("메뉴를 불러오지 못했습니다", "네트워크와 관리자 권한을 확인해 주세요.");
      showBanner("메뉴 데이터를 불러오지 못했습니다. 네트워크와 관리자 권한을 확인해 주세요.");
    } finally {
      ui.setBusy(button, false);
      updateMenuListMode();
    }
  }

  async function loadMenus() {
    let query = sb
      .from("menu_items")
      .select("*");
    query = showArchivedMenus
      ? query.not("archived_at", "is", null)
      : query.is("archived_at", null);
    const { data, error } = await query
      .order("sort_order", { ascending: true })
      .order("id", { ascending: true });
    if (error) throw error;
    menus = data || [];
    if (!showArchivedMenus) {
      activeMenuSummary = {
        count: menus.length,
        orderable: menus.filter((item) => item.is_active !== false && item.is_orderable !== false && item.is_sold_out !== true).length,
        soldOut: menus.filter((item) => item.is_sold_out === true).length
      };
    }
    updateMenuListMode();
    renderTypeFilter();
    renderMenuList();
    renderSummary();
  }

  function renderTables() {
    const list = ui.byId("tableList");
    if (!tables.length) {
      list.innerHTML = '<div class="qr-empty">등록된 테이블이 없습니다.</div>';
      return;
    }
    list.innerHTML = tables.map((table) => `
      <article class="qr-card qr-table-card">
        <div class="qr-table-card-head">
          <div>
            <div class="qr-table-card-name">${global.DGV.escapeHTML(table.label)}</div>
            <div class="qr-hint">#${ui.shortId(table.id)}</div>
          </div>
          <span class="qr-status" data-tone="${table.is_active === false ? "cancelled" : "ready"}">${table.is_active === false ? "사용 중지" : "사용 중"}</span>
        </div>
        <div class="qr-button-row" style="margin-top:12px">
          <button class="qr-btn qr-btn-small" type="button" data-table-action="view" data-table-id="${table.id}">QR 보기</button>
          <button class="qr-btn qr-btn-small" type="button" data-table-action="toggle" data-table-id="${table.id}" data-next-active="${table.is_active === false}">${table.is_active === false ? "다시 사용" : "사용 중지"}</button>
          <button class="qr-btn qr-btn-small qr-btn-danger" type="button" data-table-action="rotate" data-table-id="${table.id}">QR 교체</button>
          <button class="qr-btn qr-btn-small qr-btn-danger" type="button" data-table-action="archive" data-table-id="${table.id}">QR 삭제</button>
        </div>
      </article>`).join("");
  }

  async function loadTables() {
    const { data, error } = await sb
      .from("qr_tables")
      .select("id,label,is_active,archived_at,created_at,updated_at")
      .is("archived_at", null)
      .order("label", { ascending: true });
    if (error) throw error;
    tables = data || [];
    renderTables();
    renderSummary();
  }

  function tokenToUrl(token) {
    if (typeof token !== "string" || !TABLE_TOKEN_PATTERN.test(token)) return null;
    const url = new URL("menu.html", global.location.href);
    url.hash = `t=${token}`;
    return normalizedTableQrUrl(url.toString());
  }

  function openTokenModal(url, label) {
    const normalizedUrl = normalizedTableQrUrl(url);
    if (!normalizedUrl) {
      ui.toast("QR 주소가 올바르지 않습니다. QR을 교체해 주세요.", "error");
      return false;
    }
    currentTokenUrl = normalizedUrl;
    currentTokenLabel = String(label || "테이블").trim().slice(0, 80) || "테이블";
    ui.byId("tokenUrl").value = currentTokenUrl;
    ui.byId("tokenTitle").textContent = `${currentTokenLabel} QR 주소`;
    ui.byId("tokenTableTitle").textContent = currentTokenLabel;
    renderQrCode();
    ui.byId("tokenModal").hidden = false;
    ui.byId("tokenUrl").select();
    return true;
  }

  function showToken(result) {
    const token = result?.table_token;
    const tableId = result?.table_id;
    const url = tokenToUrl(token);
    if (!url || typeof tableId !== "string" || !TABLE_ID_PATTERN.test(tableId)) {
      ui.toast("새 QR 토큰을 받지 못했습니다. 다시 시도해 주세요.", "error");
      return false;
    }
    const cached = cacheTableQrUrl(tableId, url);
    if (!cached) {
      ui.toast("QR을 이 브라우저에 저장하지 못했습니다. 지금 다운로드하거나 인쇄해 주세요.", "error");
    }
    return openTokenModal(url, result.label);
  }

  function viewTableQr(tableId) {
    const table = tables.find((row) => row.id === tableId);
    if (!table) {
      ui.toast("테이블 정보를 찾지 못했습니다. 다시 불러와 주세요.", "error");
      return;
    }
    const url = cachedTableQrUrl(tableId);
    if (!url) {
      ui.toast("이 브라우저에 원본 QR이 없어 QR 교체가 필요합니다.", "error");
      return;
    }
    openTokenModal(url, table.label);
  }

  function renderQrCode() {
    const target = ui.byId("tokenQr");
    target.replaceChildren();
    target.removeAttribute("title");
    if (!currentTokenUrl || typeof global.QRCode !== "function") {
      target.textContent = "QR 이미지를 만들지 못했습니다. 주소 복사 기능을 사용해 주세요.";
      return;
    }
    new global.QRCode(target, {
      text: currentTokenUrl,
      width: 280,
      height: 280,
      colorDark: "#24170f",
      colorLight: "#ffffff",
      correctLevel: global.QRCode.CorrectLevel.M
    });
    const image = target.querySelector("img");
    if (image) image.alt = `${currentTokenLabel} 주문 QR 코드`;
  }

  async function qrGraphicSource() {
    const target = ui.byId("tokenQr");
    const canvas = target.querySelector("canvas");
    if (canvas) return canvas;
    const image = target.querySelector("img");
    if (!image) return null;
    if (image.complete) return image.naturalWidth > 0 ? image : null;
    return new Promise((resolve) => {
      image.addEventListener("load", () => resolve(image), { once: true });
      image.addEventListener("error", () => resolve(null), { once: true });
    });
  }

  function drawFittedCenteredText(context, text, options) {
    const value = String(text || "");
    let fontSize = options.fontSize;
    while (fontSize > options.minFontSize) {
      context.font = `${options.fontWeight} ${fontSize}px ${options.fontFamily}`;
      if (context.measureText(value).width <= options.maxWidth) break;
      fontSize -= 2;
    }
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillStyle = options.color;
    context.fillText(value, options.centerX, options.centerY, options.maxWidth);
  }

  async function qrCardDataUrl() {
    const qrSource = await qrGraphicSource();
    if (!qrSource) return null;

    const canvas = document.createElement("canvas");
    canvas.width = 1200;
    canvas.height = 1500;
    const context = canvas.getContext("2d");
    if (!context) return null;

    context.fillStyle = "#fffdf7";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = "#caa24c";
    context.lineWidth = 14;
    context.strokeRect(38, 38, canvas.width - 76, canvas.height - 76);
    context.strokeStyle = "#ead9b7";
    context.lineWidth = 3;
    context.strokeRect(62, 62, canvas.width - 124, canvas.height - 124);

    drawFittedCenteredText(context, "HANA RESTAURANT", {
      centerX: 600,
      centerY: 150,
      maxWidth: 980,
      fontSize: 66,
      minFontSize: 44,
      fontWeight: 800,
      fontFamily: 'Georgia, "Times New Roman", serif',
      color: "#3a2a1f"
    });
    drawFittedCenteredText(context, "ORDER HERE", {
      centerX: 600,
      centerY: 285,
      maxWidth: 980,
      fontSize: 104,
      minFontSize: 70,
      fontWeight: 900,
      fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
      color: "#7a4f11"
    });
    drawFittedCenteredText(context, currentTokenLabel || "테이블", {
      centerX: 600,
      centerY: 405,
      maxWidth: 930,
      fontSize: 62,
      minFontSize: 36,
      fontWeight: 900,
      fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
      color: "#3a2a1f"
    });

    context.fillStyle = "#ffffff";
    context.fillRect(150, 500, 900, 900);
    context.imageSmoothingEnabled = false;
    context.drawImage(qrSource, 190, 540, 820, 820);
    return canvas.toDataURL("image/png");
  }

  function waitForImageReady(image) {
    if (image.complete) {
      return image.naturalWidth > 0
        ? Promise.resolve()
        : Promise.reject(new Error("QR print image unavailable"));
    }
    return new Promise((resolve, reject) => {
      image.addEventListener("load", resolve, { once: true });
      image.addEventListener("error", () => reject(new Error("QR print image unavailable")), { once: true });
    });
  }

  function safeFilePart(value) {
    return String(value || "table")
      .normalize("NFKC")
      .replace(/[\\/:*?"<>|]+/g, "-")
      .replace(/\s+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "table";
  }

  async function downloadQr() {
    try {
      const dataUrl = await qrCardDataUrl();
      if (!dataUrl) throw new Error("QR card unavailable");
      const link = document.createElement("a");
      link.href = dataUrl;
      link.download = `hana-${safeFilePart(currentTokenLabel)}-qr.png`;
      link.click();
    } catch (error) {
      console.error(error);
      ui.toast("QR 이미지를 준비하지 못했습니다. 잠시 후 다시 시도해 주세요.", "error");
    }
  }

  async function printQr() {
    try {
      const dataUrl = await qrCardDataUrl();
      if (!dataUrl) throw new Error("QR card unavailable");
      const printImage = ui.byId("qrPrintImage");
      printImage.src = dataUrl;
      printImage.alt = `HANA RESTAURANT ORDER HERE ${currentTokenLabel || "테이블"} 주문 QR 카드`;
      await waitForImageReady(printImage);
      global.print();
    } catch (error) {
      console.error(error);
      ui.toast("QR 인쇄물을 준비하지 못했습니다. 잠시 후 다시 시도해 주세요.", "error");
    }
  }

  function closeToken() {
    ui.byId("tokenModal").hidden = true;
    ui.byId("tokenUrl").value = "";
    ui.byId("tokenQr").replaceChildren();
    ui.byId("tokenQr").removeAttribute("title");
    ui.byId("qrPrintImage").removeAttribute("src");
    currentTokenUrl = null;
    currentTokenLabel = null;
  }

  async function copyToken() {
    if (!currentTokenUrl) return;
    try {
      if (global.navigator.clipboard?.writeText) await global.navigator.clipboard.writeText(currentTokenUrl);
      else {
        ui.byId("tokenUrl").select();
        if (!document.execCommand("copy")) throw new Error("copy failed");
      }
      ui.toast("테이블 QR 주소를 복사했습니다.", "ok");
    } catch (error) {
      console.error(error);
      ui.toast("자동 복사에 실패했습니다. 주소를 길게 눌러 직접 복사해 주세요.", "error");
    }
  }

  async function createTable(event) {
    event.preventDefault();
    const label = ui.byId("newTableLabel").value.trim();
    if (!label) return;
    const button = ui.byId("createTableBtn");
    ui.setBusy(button, true, "추가 중…");
    try {
      const { data, error } = await sb.rpc("app_create_qr_table", { p_label: label });
      if (error) throw error;
      ui.byId("newTableLabel").value = "";
      await loadTables();
      showToken(data);
    } catch (error) {
      console.error(error);
      ui.toast(ui.messageOf(error, "테이블을 추가하지 못했습니다."), "error");
    } finally {
      ui.setBusy(button, false);
    }
  }

  async function toggleTable(tableId, nextActive, button) {
    const label = nextActive ? "다시 사용" : "사용 중지";
    if (!global.confirm(`이 테이블 QR을 ${label} 처리하시겠습니까?`)) return;
    ui.setBusy(button, true, "처리 중…");
    try {
      const { error } = await sb.rpc("app_set_qr_table_active", {
        p_table_id: tableId,
        p_is_active: nextActive
      });
      if (error) throw error;
      ui.toast(`테이블을 ${label} 처리했습니다.`, "ok");
      await loadTables();
    } catch (error) {
      console.error(error);
      ui.toast(ui.messageOf(error, "테이블 상태를 변경하지 못했습니다."), "error");
    } finally {
      ui.setBusy(button, false);
    }
  }

  async function rotateTable(tableId, button) {
    const table = tables.find((row) => row.id === tableId);
    if (!global.confirm(`${table?.label || "이 테이블"}의 QR 주소를 교체하시겠습니까?\n기존 QR은 즉시 사용할 수 없게 됩니다.`)) return;
    ui.setBusy(button, true, "교체 중…");
    try {
      const { data, error } = await sb.rpc("app_rotate_qr_table_token", { p_table_id: tableId });
      if (error) throw error;
      showToken(data);
      ui.toast("새 QR 주소가 발급되었습니다.", "ok");
    } catch (error) {
      console.error(error);
      ui.toast(ui.messageOf(error, "QR 주소를 교체하지 못했습니다."), "error");
    } finally {
      ui.setBusy(button, false);
    }
  }

  async function archiveTable(tableId, button) {
    const table = tables.find((row) => row.id === tableId);
    if (!table) {
      ui.toast("테이블 정보를 찾지 못했습니다. 다시 불러와 주세요.", "error");
      return;
    }
    const confirmed = global.confirm(
      `${table.label} 테이블 QR을 삭제하시겠습니까?\n` +
      "기존 주문 이력은 보존되며, 이 테이블의 기존 QR은 즉시 사용할 수 없게 됩니다."
    );
    if (!confirmed) return;

    ui.setBusy(button, true, "삭제 중…");
    try {
      const { data, error } = await sb.rpc("app_archive_qr_table", { p_table_id: tableId });
      if (error) throw error;
      if (data !== true) throw new Error("QR table archive was not confirmed");
      removeCachedTableQrUrl(tableId);
      ui.toast("테이블 QR을 삭제했습니다. 기존 주문 이력은 보존됩니다.", "ok");
      await loadTables();
    } catch (error) {
      console.error(error);
      ui.toast(ui.messageOf(error, "테이블 QR을 삭제하지 못했습니다."), "error");
    } finally {
      ui.setBusy(button, false);
    }
  }

  async function loadAll(options = {}) {
    const button = ui.byId("reloadBtn");
    if (options.manual) ui.setBusy(button, true, "불러오는 중…");
    try {
      const results = await Promise.allSettled([loadMenus(), loadTables()]);
      const menuFailed = results[0].status === "rejected";
      const tableFailed = results[1].status === "rejected";
      if (menuFailed) throw results[0].reason;
      if (tableFailed) {
        console.error(results[1].reason);
        showBanner("메뉴는 불러왔지만 테이블 QR 설정은 아직 사용할 수 없습니다. QR 주문 DB 배포 상태를 확인해 주세요.");
      } else hideBanner();
    } catch (error) {
      console.error(error);
      showBanner("메뉴 데이터를 불러오지 못했습니다. 네트워크와 관리자 권한을 확인해 주세요.");
    } finally {
      if (options.manual) ui.setBusy(button, false);
    }
  }

  function bindEvents() {
    ui.byId("menuSearch").addEventListener("input", renderMenuList);
    ui.byId("menuTypeFilter").addEventListener("change", renderMenuList);
    ui.byId("menuList").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-menu-id]");
      if (button) selectMenu(button.dataset.menuId);
    });
    ui.byId("newMenuBtn").addEventListener("click", newMenu);
    ui.byId("archivedMenuToggleBtn").addEventListener("click", toggleArchivedMenus);
    ui.byId("archiveMenuBtn").addEventListener("click", archiveMenu);
    ui.byId("restoreMenuBtn").addEventListener("click", restoreMenu);
    ui.byId("resetMenuBtn").addEventListener("click", resetMenu);
    ui.byId("menuForm").addEventListener("submit", saveMenu);
    ui.byId("menuImageFile").addEventListener("change", chooseImage);
    ui.byId("clearImageBtn").addEventListener("click", clearImageUrl);
    ui.byId("imageUrl").addEventListener("change", () => {
      if (!selectedImageFile) renderImagePreview(ui.byId("imageUrl").value);
    });
    ui.byId("createTableForm").addEventListener("submit", createTable);
    ui.byId("tableList").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-table-action]");
      if (!button) return;
      if (button.dataset.tableAction === "view") viewTableQr(button.dataset.tableId);
      if (button.dataset.tableAction === "toggle") toggleTable(button.dataset.tableId, button.dataset.nextActive === "true", button);
      if (button.dataset.tableAction === "rotate") rotateTable(button.dataset.tableId, button);
      if (button.dataset.tableAction === "archive") archiveTable(button.dataset.tableId, button);
    });
    ui.byId("copyTokenBtn").addEventListener("click", copyToken);
    ui.byId("downloadQrBtn").addEventListener("click", downloadQr);
    ui.byId("printQrBtn").addEventListener("click", printQr);
    ui.byId("closeTokenBtn").addEventListener("click", closeToken);
    ui.byId("openMenuBtn").addEventListener("click", () => {
      if (currentTokenUrl) global.open(currentTokenUrl, "_blank", "noopener");
    });
    ui.byId("reloadBtn").addEventListener("click", () => loadAll({ manual: true }));
    ui.byId("signOutBtn").addEventListener("click", () => ui.signOut());
    global.addEventListener("pagehide", () => {
      if (selectedImagePreviewUrl) URL.revokeObjectURL(selectedImagePreviewUrl);
    }, { once: true });
  }

  async function boot() {
    try {
      await ui.requireLogin({ roles: ["admin"], preferredRole: "admin" });
      bindEvents();
      updateMenuListMode();
      await loadAll();
      const first = menus[0];
      if (first) selectMenu(first.id);
      else newMenu();
    } catch (error) {
      console.error(error);
      showBanner("관리자 인증을 완료하지 못했습니다.");
    }
  }

  boot();
})(window);
