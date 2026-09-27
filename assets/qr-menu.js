(function initQrMenu(global) {
  "use strict";

  const config = global.DGV_SUPABASE_CONFIG;
  const endpoint = config?.url ? `${String(config.url).replace(/\/$/, "")}/functions/v1/qr-menu` : "";
  const MAX_QTY = 20;
  const MAX_TOTAL_QTY = 100;
  const MAX_CURRENT_ORDERS = 20;
  const MAX_CURRENT_ORDER_LINES = 40;
  const CURRENT_ORDER_POLL_MS = 15000;
  const DEFAULT_SINGLE_SUBCATEGORIES = Object.freeze([
    { id: "noodle", name_ko: "면", name_en: "Noodles", name_vi: "Mì", sort_order: 10 },
    { id: "stew_rice", name_ko: "찌개·덮밥", name_en: "Stews & rice bowls", name_vi: "Món hầm & cơm", sort_order: 20 },
    { id: "soup", name_ko: "국밥", name_en: "Soups with rice", name_vi: "Canh ăn với cơm", sort_order: 30 },
    { id: "grill", name_ko: "구이", name_en: "Grilled dishes", name_vi: "Món nướng", sort_order: 40 },
    { id: "other", name_ko: "기타", name_en: "Other", name_vi: "Khác", sort_order: 90 }
  ]);
  const COPY = Object.freeze({
    ko: {
      welcomeEyebrow: "WELCOME TO HANA",
      welcomeTitle: "정성으로 준비한 하나식당 메뉴",
      welcomeBody: "메뉴를 골라 테이블에서 바로 주문해 주세요.",
      payAtCounter: "결제는 직원에게 해주세요.",
      noOnlinePayment: "이 페이지에서는 온라인 결제가 진행되지 않습니다.",
      currentOrdersEyebrow: "CURRENT TABLE ORDERS",
      currentOrdersTitle: "현재 주문 내역",
      currentOrdersHelp: "결제 또는 취소 전 주문이 표시됩니다.",
      currentOrdersTotal: "테이블 미결제 합계",
      currentOrdersLimited: "최근 주문 일부만 표시됩니다. 전체 내역은 직원에게 문의해 주세요.",
      statusSubmitted: "주문 확인 대기",
      statusAccepted: "주문 확인",
      loadingTitle: "메뉴를 준비하고 있습니다",
      loadingBody: "잠시만 기다려 주세요.",
      retry: "다시 시도",
      priceNotice: "표시된 가격은 부가세 포함 가격이며, 주문 시점의 매장 가격이 적용됩니다.",
      viewCart: "주문서 보기",
      chooseOption: "옵션을 선택해 주세요",
      itemRequest: "메뉴 요청사항",
      itemRequestPlaceholder: "예: 덜 맵게 해주세요.",
      addToCart: "담기",
      yourOrder: "YOUR ORDER",
      cartTitle: "주문서",
      emptyCart: "담긴 메뉴가 없습니다.",
      orderRequest: "전체 요청사항",
      orderRequestPlaceholder: "직원에게 전달할 요청사항을 입력해 주세요.",
      total: "합계",
      paymentNote: "주문 접수 후 직원에게 현금 또는 카드로 결제해 주세요.",
      reviewOrder: "주문 확인",
      confirmTitle: "주문을 접수할까요?",
      confirmNotice: "접수 후 변경이 필요하면 직원에게 말씀해 주세요.",
      goBack: "돌아가기",
      submitOrder: "주문하기",
      orderComplete: "ORDER RECEIVED",
      successTitle: "주문이 접수되었습니다",
      successBody: "직원이 주문을 확인한 뒤 준비해 드리겠습니다.",
      newOrder: "메뉴 더 보기",
      table: "테이블",
      menuLoadError: "메뉴를 불러오지 못했습니다",
      askStaff: "QR 코드를 다시 확인하거나 직원에게 문의해 주세요.",
      invalidQr: "유효한 테이블 QR 코드가 아닙니다.",
      emptyMenu: "현재 주문 가능한 메뉴가 없습니다.",
      soldOut: "품절",
      preorder: "사전 예약 메뉴",
      preorderDetailsOnly: "사전 예약이 필요한 메뉴입니다",
      from: "부터",
      remove: "삭제",
      quantity: "수량",
      orderFailed: "주문을 접수하지 못했습니다. 잠시 후 다시 시도해 주세요.",
      menuChanged: "일부 메뉴의 가격 또는 주문 가능 여부가 변경되었습니다. 메뉴를 새로 확인해 주세요.",
      rateLimited: "주문 요청이 많습니다. 잠시 후 다시 시도해 주세요.",
      noteTooLong: "요청사항을 500자 이내로 줄여주세요.",
      quantityLimit: "한 메뉴는 최대 20개, 전체 주문은 최대 100개까지 담을 수 있습니다.",
      added: "주문서에 담았습니다.",
      tableOrder: "테이블 주문",
      orderNumber: "주문번호",
      items: "개 메뉴",
      submitting: "접수 중…"
    },
    en: {
      welcomeEyebrow: "WELCOME TO HANA",
      welcomeTitle: "A table full of Korean comfort",
      welcomeBody: "Choose your dishes and order directly from your table.",
      payAtCounter: "Please pay a member of staff.",
      noOnlinePayment: "No online payment is processed on this page.",
      currentOrdersEyebrow: "CURRENT TABLE ORDERS",
      currentOrdersTitle: "Current orders",
      currentOrdersHelp: "Orders stay here until payment or cancellation.",
      currentOrdersTotal: "Table unpaid total",
      currentOrdersLimited: "Only the most recent orders are shown. Please ask our staff for the full list.",
      statusSubmitted: "Awaiting confirmation",
      statusAccepted: "Order confirmed",
      loadingTitle: "Preparing the menu",
      loadingBody: "Please wait a moment.",
      retry: "Try again",
      priceNotice: "Prices shown include tax. The current restaurant price is applied when you order.",
      viewCart: "View order",
      chooseOption: "Choose an option",
      itemRequest: "Item request",
      itemRequestPlaceholder: "e.g. Less spicy, please.",
      addToCart: "Add",
      yourOrder: "YOUR ORDER",
      cartTitle: "Your order",
      emptyCart: "Your order is empty.",
      orderRequest: "Request for the whole order",
      orderRequestPlaceholder: "Add a note for our staff.",
      total: "Total",
      paymentNote: "Please pay our staff by cash or card after your order is accepted.",
      reviewOrder: "Review order",
      confirmTitle: "Send this order?",
      confirmNotice: "Please ask our staff if you need to change an accepted order.",
      goBack: "Go back",
      submitOrder: "Place order",
      orderComplete: "ORDER RECEIVED",
      successTitle: "Your order has been received",
      successBody: "Our staff will confirm and prepare your order.",
      newOrder: "Back to menu",
      table: "Table",
      menuLoadError: "We could not load the menu",
      askStaff: "Please scan the QR code again or ask a member of staff.",
      invalidQr: "This table QR code is not valid.",
      emptyMenu: "There are no items available to order right now.",
      soldOut: "Sold out",
      preorder: "Pre-order item",
      preorderDetailsOnly: "Pre-order required",
      from: "from",
      remove: "Remove",
      quantity: "Quantity",
      orderFailed: "We could not place your order. Please try again shortly.",
      menuChanged: "Some prices or menu availability have changed. Please review the refreshed menu.",
      rateLimited: "There are too many requests. Please wait a moment and try again.",
      noteTooLong: "Please shorten all requests to 500 characters or fewer.",
      quantityLimit: "You can order up to 20 of one item and 100 items in total.",
      added: "Added to your order.",
      tableOrder: "Table order",
      orderNumber: "Order",
      items: "items",
      submitting: "Sending…"
    },
    vi: {
      welcomeEyebrow: "CHÀO MỪNG ĐẾN HANA",
      welcomeTitle: "Món Hàn được chuẩn bị tận tâm",
      welcomeBody: "Chọn món và gọi món ngay tại bàn.",
      payAtCounter: "Vui lòng thanh toán với nhân viên.",
      noOnlinePayment: "Trang này không thực hiện thanh toán trực tuyến.",
      currentOrdersEyebrow: "ĐƠN HIỆN TẠI CỦA BÀN",
      currentOrdersTitle: "Đơn hiện tại",
      currentOrdersHelp: "Đơn sẽ hiển thị đến khi thanh toán hoặc hủy.",
      currentOrdersTotal: "Tổng chưa thanh toán của bàn",
      currentOrdersLimited: "Chỉ hiển thị các đơn gần đây. Vui lòng hỏi nhân viên để xem toàn bộ.",
      statusSubmitted: "Chờ xác nhận",
      statusAccepted: "Đã xác nhận",
      loadingTitle: "Đang chuẩn bị thực đơn",
      loadingBody: "Vui lòng chờ trong giây lát.",
      retry: "Thử lại",
      priceNotice: "Giá đã bao gồm thuế. Giá hiện tại của nhà hàng được áp dụng khi gọi món.",
      viewCart: "Xem đơn",
      chooseOption: "Chọn tùy chọn",
      itemRequest: "Yêu cầu cho món",
      itemRequestPlaceholder: "Ví dụ: Vui lòng làm ít cay.",
      addToCart: "Thêm",
      yourOrder: "ĐƠN CỦA BẠN",
      cartTitle: "Đơn gọi món",
      emptyCart: "Chưa có món nào trong đơn.",
      orderRequest: "Yêu cầu chung",
      orderRequestPlaceholder: "Nhập ghi chú cho nhân viên.",
      total: "Tổng cộng",
      paymentNote: "Vui lòng thanh toán bằng tiền mặt hoặc thẻ với nhân viên sau khi đơn được nhận.",
      reviewOrder: "Kiểm tra đơn",
      confirmTitle: "Gửi đơn gọi món?",
      confirmNotice: "Vui lòng báo nhân viên nếu bạn cần thay đổi đơn sau khi gửi.",
      goBack: "Quay lại",
      submitOrder: "Gọi món",
      orderComplete: "ĐÃ NHẬN ĐƠN",
      successTitle: "Đơn của bạn đã được gửi",
      successBody: "Nhân viên sẽ xác nhận và chuẩn bị món.",
      newOrder: "Xem thêm món",
      table: "Bàn",
      menuLoadError: "Không thể tải thực đơn",
      askStaff: "Vui lòng quét lại mã QR hoặc liên hệ nhân viên.",
      invalidQr: "Mã QR của bàn không hợp lệ.",
      emptyMenu: "Hiện không có món nào để gọi.",
      soldOut: "Hết món",
      preorder: "Món cần đặt trước",
      preorderDetailsOnly: "Món này cần đặt trước",
      from: "từ",
      remove: "Xóa",
      quantity: "Số lượng",
      orderFailed: "Không thể gửi đơn. Vui lòng thử lại sau ít phút.",
      menuChanged: "Giá hoặc tình trạng của một số món đã thay đổi. Vui lòng xem lại thực đơn mới.",
      rateLimited: "Có quá nhiều yêu cầu. Vui lòng chờ một lát rồi thử lại.",
      noteTooLong: "Vui lòng rút gọn tất cả yêu cầu còn tối đa 500 ký tự.",
      quantityLimit: "Mỗi món tối đa 20 phần và toàn bộ đơn tối đa 100 phần.",
      added: "Đã thêm vào đơn.",
      tableOrder: "Gọi món tại bàn",
      orderNumber: "Mã đơn",
      items: "món",
      submitting: "Đang gửi…"
    }
  });

  const state = {
    token: "",
    language: normalizeLanguage(global.localStorage?.getItem("hana-menu-language")),
    table: null,
    categories: [],
    subcategories: [],
    items: [],
    currentOrders: [],
    currentOrdersTruncated: false,
    currentTotals: { usd: 0, vnd: 0 },
    cart: [],
    selectedItem: null,
    detailQuantity: 1,
    pendingRequestId: null,
    loading: false,
    refreshingCurrentOrders: false,
    currentOrderPollTimer: null,
    toastTimer: null
  };

  const el = {};
  const ids = [
    "tableChip", "tableLabel", "currentOrdersSection", "currentOrdersTotal", "currentOrdersList", "currentOrdersLimit",
    "loadingPanel", "errorPanel", "errorTitle", "errorMessage", "retryButton",
    "menuApp", "categoryNav", "menuList", "cartButton", "cartCount", "cartTotal", "detailBackdrop",
    "detailSheet", "detailClose", "detailMedia", "detailCategory", "detailName", "detailTranslation",
    "detailDescription", "variantList", "detailNoteLabel", "detailNote", "detailQuantityControl", "detailMinus", "detailPlus", "detailQuantity",
    "detailAdd", "cartBackdrop", "cartSheet", "cartClose", "cartLines", "emptyCart", "orderNote",
    "sheetTotal", "noteError", "noteCounter", "reviewButton", "confirmBackdrop", "confirmTable", "confirmLines", "confirmTotal",
    "confirmCancel", "submitOrder", "successBackdrop", "successNumber", "successSummary", "newOrderButton", "toast"
  ];

  function normalizeLanguage(value) {
    const normalized = String(value || "").toLowerCase().split("-")[0];
    return ["ko", "en", "vi"].includes(normalized) ? normalized : "ko";
  }

  function t(key) {
    return COPY[state.language]?.[key] || COPY.ko[key] || key;
  }

  function readToken() {
    const hash = new URLSearchParams(global.location.hash.replace(/^#/, ""));
    const url = new URL(global.location.href);
    const hashToken = hash.get("t") || hash.get("table");
    const queryToken = url.searchParams.get("t") || url.searchParams.get("table");
    const token = String(hashToken || queryToken || "").trim();

    if (!hashToken && queryToken && global.history?.replaceState) {
      url.searchParams.delete("t");
      url.searchParams.delete("table");
      url.hash = `t=${encodeURIComponent(queryToken)}`;
      global.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    }
    return token;
  }

  function nameOf(entity, language = state.language) {
    if (!entity) return "";
    return String(
      entity[`name_${language}`] ||
      entity[`${language}_name`] ||
      entity.name ||
      entity.name_ko ||
      entity.ko_name ||
      entity.name_en ||
      entity.name_vi ||
      ""
    ).trim();
  }

  function descriptionOf(entity, language = state.language) {
    if (!entity) return "";
    return String(
      entity[`description_${language}`] ||
      entity[`${language}_description`] ||
      entity.description ||
      entity.description_ko ||
      entity.description_en ||
      entity.description_vi ||
      ""
    ).trim();
  }

  function translationsOf(entity) {
    const values = ["ko", "en", "vi"]
      .filter((language) => language !== state.language)
      .map((language) => nameOf(entity, language))
      .filter(Boolean);
    return [...new Set(values)].join(" · ");
  }

  function formatVnd(value) {
    const numeric = Number(value);
    return `${new Intl.NumberFormat(state.language === "vi" ? "vi-VN" : state.language === "en" ? "en-US" : "ko-KR").format(Number.isFinite(numeric) ? numeric : 0)} VND`;
  }

  function formatUsd(value) {
    const numeric = Number(value);
    return `${new Intl.NumberFormat(state.language === "vi" ? "vi-VN" : state.language === "en" ? "en-US" : "ko-KR").format(Number.isFinite(numeric) ? numeric : 0)}$`;
  }

  function numericPrice(entity) {
    return Math.max(0, Number(entity?.price_vnd ?? entity?.price ?? 0) || 0);
  }

  function isAvailable(entity) {
    return entity?.is_available !== false
      && entity?.is_active !== false
      && entity?.is_orderable !== false
      && entity?.sold_out !== true
      && entity?.is_sold_out !== true
      && entity?.requires_preorder !== true;
  }

  function safeImageUrl(value) {
    const source = String(value || "").trim();
    if (!source) return "";
    try {
      const url = new URL(source, global.location.href);
      return ["http:", "https:"].includes(url.protocol) && (url.origin !== "null") ? url.href : "";
    } catch (_error) {
      return "";
    }
  }

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function copyUi() {
    document.documentElement.lang = state.language;
    document.querySelectorAll("[data-copy]").forEach((node) => {
      node.textContent = t(node.dataset.copy);
    });
    document.querySelectorAll("[data-placeholder]").forEach((node) => {
      node.placeholder = t(node.dataset.placeholder);
    });
    document.querySelectorAll("[data-language]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.language === state.language));
    });
  }

  function nonNegativeInteger(value) {
    const number = Number(value);
    return Number.isInteger(number) && number >= 0 && number <= 2147483647 ? number : 0;
  }

  function nonNegativeSafeInteger(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  }

  function normalizeCurrentOrders(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, MAX_CURRENT_ORDERS).flatMap((order) => {
      if (!order || typeof order !== "object" || !["submitted", "accepted"].includes(order.status)) return [];
      const orderNumber = String(order.order_number || "").trim().slice(0, 32);
      const items = (Array.isArray(order.items) ? order.items : [])
        .slice(0, MAX_CURRENT_ORDER_LINES)
        .flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const qty = nonNegativeInteger(item.qty);
          const koName = String(item.ko_name || "").trim().slice(0, 200);
          if (qty < 1 || qty > MAX_QTY || !koName) return [];
          return [{
            menu_type: String(item.menu_type || "").trim().slice(0, 80),
            ko_name: koName,
            vi_name: String(item.vi_name || "").trim().slice(0, 200),
            en_name: String(item.en_name || "").trim().slice(0, 200),
            qty,
            unit_usd: nonNegativeInteger(item.unit_usd),
            unit_vnd: nonNegativeInteger(item.unit_vnd),
            line_usd: nonNegativeInteger(item.line_usd),
            line_vnd: nonNegativeInteger(item.line_vnd)
          }];
        });
      if (!orderNumber || !items.length) return [];
      return [{
        order_number: orderNumber,
        status: order.status,
        total_usd: nonNegativeInteger(order.total_usd),
        total_vnd: nonNegativeInteger(order.total_vnd),
        submitted_at: String(order.submitted_at || "").slice(0, 40),
        accepted_at: order.accepted_at ? String(order.accepted_at).slice(0, 40) : null,
        items
      }];
    });
  }

  function normalizeCurrentTotals(payload, currentOrders) {
    const serverUsd = nonNegativeSafeInteger(payload?.current_total_usd);
    const serverVnd = nonNegativeSafeInteger(payload?.current_total_vnd);
    if (serverUsd !== null && serverVnd !== null) {
      return { usd: serverUsd, vnd: serverVnd };
    }

    // Compatibility with a cached/older Edge payload that predates the exact
    // server totals. This preserves the former visible-list sum until every
    // environment serves current_total_usd/current_total_vnd.
    return currentOrders.reduce((total, order) => {
      total.usd += nonNegativeInteger(order.total_usd);
      total.vnd += nonNegativeInteger(order.total_vnd);
      return total;
    }, { usd: 0, vnd: 0 });
  }

  function subcategorySortOrder(value, subcategories = DEFAULT_SINGLE_SUBCATEGORIES) {
    const id = String(value || "other");
    const match = subcategories.find((subcategory) => String(subcategory.id) === id);
    return Number(match?.sort_order ?? (id === "other" ? 90 : 80));
  }

  function normalizedSubcategories(payload) {
    const supplied = Array.isArray(payload?.subcategories) ? payload.subcategories : [];
    const source = supplied.length ? supplied : DEFAULT_SINGLE_SUBCATEGORIES;
    const seen = new Set();
    const result = source.reduce((rows, subcategory) => {
      const id = String(subcategory?.id || "").trim();
      if (!id || seen.has(id)) return rows;
      seen.add(id);
      rows.push({
        id,
        name_ko: subcategory.name_ko || DEFAULT_SINGLE_SUBCATEGORIES.find((row) => row.id === id)?.name_ko || id,
        name_en: subcategory.name_en || DEFAULT_SINGLE_SUBCATEGORIES.find((row) => row.id === id)?.name_en || id,
        name_vi: subcategory.name_vi || DEFAULT_SINGLE_SUBCATEGORIES.find((row) => row.id === id)?.name_vi || id,
        sort_order: Number(subcategory.sort_order ?? subcategorySortOrder(id))
      });
      return rows;
    }, []);
    if (!seen.has("other")) result.push({ ...DEFAULT_SINGLE_SUBCATEGORIES.find((row) => row.id === "other") });
    return result.sort((left, right) => Number(left.sort_order) - Number(right.sort_order));
  }

  function compareMenuItems(left, right, subcategories) {
    const categoryDifference = categorySortOrder(left.category_id) - categorySortOrder(right.category_id);
    if (categoryDifference) return categoryDifference;
    if (left.category_id === "single") {
      const subcategoryDifference = subcategorySortOrder(left.subcategory_id, subcategories)
        - subcategorySortOrder(right.subcategory_id, subcategories);
      if (subcategoryDifference) return subcategoryDifference;
    }
    const priceDifference = minPrice(left) - minPrice(right);
    if (priceDifference) return priceDifference;
    const sortDifference = Number(left.sort_order || 0) - Number(right.sort_order || 0);
    if (sortDifference) return sortDifference;
    const nameDifference = String(left.ko_name || left.en_name || left.vi_name || "")
      .localeCompare(String(right.ko_name || right.en_name || right.vi_name || ""), "ko");
    return nameDifference || String(left.id || "").localeCompare(String(right.id || ""));
  }

  function normalizePayload(payload) {
    const rawItems = Array.isArray(payload?.items) ? payload.items : Array.isArray(payload?.menu_items) ? payload.menu_items : [];
    let categories = Array.isArray(payload?.categories) ? payload.categories.slice() : [];
    const subcategories = normalizedSubcategories(payload);
    const currentOrders = normalizeCurrentOrders(payload?.current_orders);

    if (!categories.length) {
      const seen = new Map();
      rawItems.forEach((item) => {
        const categoryId = String(item.category_id || item.qr_category || item.type || "menu");
        if (!seen.has(categoryId)) {
          seen.set(categoryId, {
            id: categoryId,
            name_ko: item.category_name_ko || categoryLabel(categoryId, "ko"),
            name_en: item.category_name_en || categoryLabel(categoryId, "en"),
            name_vi: item.category_name_vi || categoryLabel(categoryId, "vi"),
            sort_order: Number(item.category_sort_order ?? categorySortOrder(categoryId))
          });
        }
      });
      categories = [...seen.values()];
    }

    categories.sort((a, b) => {
      const left = Number(a.sort_order ?? categorySortOrder(a.id));
      const right = Number(b.sort_order ?? categorySortOrder(b.id));
      return left - right;
    });
    const categoryIds = new Set(categories.map((category) => String(category.id)));
    const items = rawItems
      .map((item) => ({
        ...item,
        category_id: String(item.category_id || item.qr_category || item.type || categories[0]?.id || "menu"),
        subcategory_id: String(item.qr_subcategory || item.subcategory_id || "other"),
        variants: Array.isArray(item.variants) ? item.variants.filter((variant) => variant?.is_available !== false && variant?.is_active !== false) : []
      }))
      .filter((item) => item.is_active !== false && (item.is_orderable !== false || item.requires_preorder === true))
      .sort((left, right) => compareMenuItems(left, right, subcategories));

    items.forEach((item) => {
      if (!categoryIds.has(item.category_id)) {
        categories.push({ id: item.category_id, name_ko: categoryLabel(item.category_id, "ko"), name_en: categoryLabel(item.category_id, "en"), name_vi: categoryLabel(item.category_id, "vi"), sort_order: 999 });
        categoryIds.add(item.category_id);
      }
    });

    return {
      table: payload?.table || (payload?.table_label ? { label: payload.table_label } : null),
      categories,
      subcategories,
      items,
      currentOrders,
      currentOrdersTruncated: payload?.current_orders_truncated === true,
      currentTotals: normalizeCurrentTotals(payload, currentOrders)
    };
  }

  function categoryLabel(value, language) {
    const key = String(value || "menu").toLowerCase();
    const labels = {
      single: { ko: "1인 메뉴", en: "Single serving", vi: "Món 1 người" },
      shared: { ko: "2인 이상 메뉴", en: "For two or more", vi: "Món cho 2 người trở lên" },
      snack: { ko: "술안주", en: "Dishes for drinks", vi: "Món nhắm" },
      preorder: { ko: "사전 예약 메뉴", en: "Pre-order dishes", vi: "Món đặt trước" },
      drink: { ko: "음료", en: "Drinks", vi: "Đồ uống" },
      cafe: { ko: "카페", en: "Cafe", vi: "Cà phê & đồ uống" },
      side: { ko: "안주", en: "Side dishes", vi: "Món nhắm" },
      other: { ko: "기타 메뉴", en: "Other dishes", vi: "Món khác" },
      food: { ko: "식사", en: "Food", vi: "Món ăn" },
      menu: { ko: "메뉴", en: "Menu", vi: "Thực đơn" }
    };
    return labels[key]?.[language] || String(value || labels.menu[language]);
  }

  function categorySortOrder(value) {
    return ({ single: 10, shared: 20, snack: 30, preorder: 40, drink: 50, cafe: 60 })[
      String(value || "").toLowerCase()
    ] ?? 900;
  }

  async function apiRequest(options = {}) {
    if (!endpoint || !config?.publishableKey) throw new Error("CONFIG_MISSING");
    const headers = {
      apikey: config.publishableKey,
      Authorization: `Bearer ${config.publishableKey}`,
      Accept: "application/json"
    };
    if (options.body) headers["Content-Type"] = "application/json";

    const controller = new AbortController();
    const timer = global.setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(options.url || endpoint, {
        method: options.method || "POST",
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer"
      });
      let data = null;
      try { data = await response.json(); } catch (_error) { /* handled below */ }
      if (!response.ok || data?.ok === false) {
        const error = new Error(data?.message || data?.error || `HTTP_${response.status}`);
        error.status = response.status;
        error.code = data?.code;
        throw error;
      }
      return data || {};
    } finally {
      global.clearTimeout(timer);
    }
  }

  async function requestMenuPayload() {
    // The raw QR token stays in the page fragment and POST body. Only the Edge
    // Function receives it; browser roles never query qr_orders directly.
    return normalizePayload(await apiRequest({
      method: "POST",
      body: { action: "get_menu", table_token: state.token }
    }));
  }

  async function loadMenu() {
    state.loading = true;
    el.loadingPanel.hidden = false;
    el.errorPanel.hidden = true;
    el.menuApp.hidden = true;
    el.cartButton.hidden = true;

    if (!state.token) {
      showLoadError(t("invalidQr"));
      return;
    }

    try {
      const normalized = await requestMenuPayload();
      state.table = normalized.table;
      state.categories = normalized.categories;
      state.subcategories = normalized.subcategories;
      state.items = normalized.items;
      state.currentOrders = normalized.currentOrders;
      state.currentOrdersTruncated = normalized.currentOrdersTruncated;
      state.currentTotals = normalized.currentTotals;
      if (!state.table || !state.items.length) throw new Error(state.items.length ? "INVALID_TABLE" : "EMPTY_MENU");
      restoreCart();
      el.tableLabel.textContent = tableLabel();
      el.tableChip.hidden = false;
      el.loadingPanel.hidden = true;
      el.menuApp.hidden = false;
      renderMenu();
      renderCart();
      renderCurrentOrders();
      startCurrentOrderPolling();
    } catch (error) {
      const message = error?.message === "EMPTY_MENU" ? t("emptyMenu") : error?.status === 401 || error?.status === 403 || error?.status === 404 ? t("invalidQr") : t("askStaff");
      showLoadError(message);
    } finally {
      state.loading = false;
    }
  }

  function showLoadError(message) {
    state.loading = false;
    el.loadingPanel.hidden = true;
    el.menuApp.hidden = true;
    el.cartButton.hidden = true;
    state.currentOrders = [];
    state.currentOrdersTruncated = false;
    state.currentTotals = { usd: 0, vnd: 0 };
    renderCurrentOrders();
    el.errorTitle.textContent = t("menuLoadError");
    el.errorMessage.textContent = message;
    el.errorPanel.hidden = false;
  }

  function tableLabel() {
    const label = nameOf(state.table) || state.table?.label || state.table?.table_label || state.table?.number;
    return label ? `${t("table")} ${label}` : t("tableOrder");
  }

  function formatOrderTime(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "";
    const locale = state.language === "vi" ? "vi-VN" : state.language === "en" ? "en-US" : "ko-KR";
    return new Intl.DateTimeFormat(locale, {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    }).format(date);
  }

  function renderCurrentOrders() {
    el.currentOrdersList.replaceChildren();
    el.currentOrdersTotal.replaceChildren();
    const hasCurrentOrders = state.currentOrders.length > 0;
    el.currentOrdersSection.hidden = !hasCurrentOrders;
    el.currentOrdersTotal.hidden = !hasCurrentOrders;
    el.currentOrdersLimit.hidden = !state.currentOrdersTruncated;
    if (!hasCurrentOrders) return;

    el.currentOrdersTotal.append(
      make("span", "", t("currentOrdersTotal")),
      make("strong", "", `${formatVnd(state.currentTotals.vnd)} · ${formatUsd(state.currentTotals.usd)}`)
    );

    state.currentOrders.forEach((order) => {
      const card = make("article", "current-order-card");
      const head = make("div", "current-order-head");
      const identity = make("div");
      identity.append(
        make("div", "current-order-number", `${t("orderNumber")} ${order.order_number}`),
        make("div", "current-order-time", formatOrderTime(order.submitted_at))
      );
      const status = make("span", "current-order-status", t(order.status === "accepted" ? "statusAccepted" : "statusSubmitted"));
      status.dataset.status = order.status;
      head.append(identity, status);
      card.append(head);

      order.items.forEach((item) => {
        const line = make("div", "current-order-line");
        line.append(
          make("span", "current-order-line-name", `${nameOf(item)} × ${item.qty}`),
          make("span", "current-order-line-price", formatVnd(item.line_vnd))
        );
        card.append(line);
      });

      const total = make("div", "current-order-total");
      total.append(make("span", "", t("total")), make("strong", "", formatVnd(order.total_vnd)));
      card.append(total);
      el.currentOrdersList.append(card);
    });
  }

  async function refreshCurrentOrders() {
    if (!state.token || state.loading || state.refreshingCurrentOrders) return;
    state.refreshingCurrentOrders = true;
    try {
      const normalized = await requestMenuPayload();
      if (!normalized.table) return;
      state.currentOrders = normalized.currentOrders;
      state.currentOrdersTruncated = normalized.currentOrdersTruncated;
      state.currentTotals = normalized.currentTotals;
      renderCurrentOrders();
    } catch (_error) {
      // Keep the last server-confirmed list through a transient reconnect. The
      // next poll or visibility refresh will reconcile it.
    } finally {
      state.refreshingCurrentOrders = false;
    }
  }

  function startCurrentOrderPolling() {
    global.clearInterval(state.currentOrderPollTimer);
    state.currentOrderPollTimer = global.setInterval(() => {
      if (document.visibilityState === "visible") refreshCurrentOrders();
    }, CURRENT_ORDER_POLL_MS);
  }

  function renderMenu() {
    el.categoryNav.replaceChildren();
    el.menuList.replaceChildren();
    const usableCategories = state.categories.filter((category) => state.items.some((item) => item.category_id === String(category.id)));

    usableCategories.forEach((category, index) => {
      const categoryId = `category-${slug(String(category.id))}`;
      const button = make("button", `category-button${index === 0 ? " is-active" : ""}`, nameOf(category));
      button.type = "button";
      button.dataset.target = categoryId;
      button.addEventListener("click", () => {
        document.getElementById(categoryId)?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
      el.categoryNav.append(button);

      const section = make("section", "menu-section");
      section.id = categoryId;
      section.dataset.category = String(category.id);
      const heading = make("div", "section-heading");
      const title = make("h2", "", nameOf(category));
      const subtitle = make("p", "", translationsOf(category));
      heading.append(title, subtitle);
      section.append(heading);
      const categoryItems = state.items.filter((item) => item.category_id === String(category.id));
      if (String(category.id) === "single") {
        state.subcategories.forEach((subcategory) => {
          const rows = categoryItems.filter((item) => item.subcategory_id === String(subcategory.id));
          if (!rows.length) return;
          const subsection = make("div", "menu-subsection");
          const subheading = make("div", "menu-subheading");
          subheading.append(make("h3", "", nameOf(subcategory)), make("p", "", translationsOf(subcategory)));
          const grid = make("div", "menu-grid");
          rows.forEach((item) => grid.append(menuCard(item)));
          subsection.append(subheading, grid);
          section.append(subsection);
        });
      } else {
        const grid = make("div", "menu-grid");
        categoryItems.forEach((item) => grid.append(menuCard(item)));
        section.append(grid);
      }
      el.menuList.append(section);
    });
    observeCategories();
  }

  function menuCard(item) {
    const available = isAvailable(item);
    const preorderOnly = item.requires_preorder === true;
    const card = make("button", "menu-card");
    card.type = "button";
    card.disabled = !available && !preorderOnly;
    card.setAttribute(
      "aria-label",
      `${nameOf(item)}, ${formatVnd(minPrice(item))}${available ? "" : `, ${t(preorderOnly ? "preorder" : "soldOut")}`}`
    );
    if (available || preorderOnly) card.addEventListener("click", () => openDetail(item));

    const media = make("div", "menu-photo");
    appendImage(media, item);
    if (!available && !preorderOnly) media.append(make("span", "sold-out-badge", t("soldOut")));

    const body = make("div", "menu-card-body");
    body.append(make("h3", "", nameOf(item)));
    const translations = translationsOf(item);
    if (translations) body.append(make("p", "item-translation", translations));
    const description = descriptionOf(item);
    if (description) body.append(make("p", "item-description", description));
    if (item.requires_preorder) body.append(make("span", "preorder-badge", t("preorder")));

    const price = make("div", "item-price");
    const priceText = item.variants.length > 1 ? `${t("from")} ${formatVnd(minPrice(item))}` : formatVnd(minPrice(item));
    price.append(make("strong", "", priceText), make("span", "add-circle", available ? "+" : "–"));
    body.append(price);
    card.append(media, body);
    return card;
  }

  function appendImage(container, item) {
    const source = safeImageUrl(item.image_url || item.photo_url || item.image);
    const fallback = make("div", "photo-fallback");
    fallback.append(make("strong", "", "HANA"), make("span", "", "KOREAN FOOD"));
    container.append(fallback);
    if (!source) return;
    const image = new Image();
    image.alt = nameOf(item);
    image.loading = "lazy";
    image.decoding = "async";
    image.addEventListener("load", () => fallback.remove(), { once: true });
    image.addEventListener("error", () => image.remove(), { once: true });
    image.src = source;
    container.append(image);
  }

  function minPrice(item) {
    const prices = item?.variants?.filter(isAvailable).map(numericPrice).filter((price) => price >= 0) || [];
    return prices.length ? Math.min(...prices) : numericPrice(item);
  }

  function slug(value) {
    return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "menu";
  }

  function observeCategories() {
    if (!("IntersectionObserver" in global)) return;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (!visible) return;
      el.categoryNav.querySelectorAll(".category-button").forEach((button) => {
        button.classList.toggle("is-active", button.dataset.target === visible.target.id);
      });
    }, { rootMargin: "-70px 0px -65% 0px", threshold: 0 });
    document.querySelectorAll(".menu-section").forEach((section) => observer.observe(section));
  }

  function openDetail(item) {
    const preorderOnly = item.requires_preorder === true;
    state.selectedItem = item;
    state.detailQuantity = 1;
    el.detailMedia.replaceChildren();
    appendImage(el.detailMedia, item);
    const category = state.categories.find((candidate) => String(candidate.id) === item.category_id);
    const subcategory = item.category_id === "single"
      ? state.subcategories.find((candidate) => String(candidate.id) === item.subcategory_id)
      : null;
    el.detailCategory.textContent = [nameOf(category), subcategory ? nameOf(subcategory) : null].filter(Boolean).join(" · ");
    el.detailName.textContent = nameOf(item);
    el.detailTranslation.textContent = translationsOf(item);
    el.detailTranslation.hidden = !el.detailTranslation.textContent;
    el.detailDescription.textContent = descriptionOf(item);
    el.detailDescription.hidden = !el.detailDescription.textContent;
    el.detailNote.value = "";
    el.detailNote.disabled = preorderOnly;
    el.detailNote.hidden = preorderOnly;
    el.detailNoteLabel.hidden = preorderOnly;
    el.detailQuantityControl.hidden = preorderOnly;
    el.detailQuantity.textContent = "1";
    renderVariants(item);
    updateDetailAdd();
    openOverlay(el.detailBackdrop, el.detailSheet, el.detailClose);
  }

  function renderVariants(item) {
    el.variantList.querySelectorAll(".variant-option").forEach((node) => node.remove());
    const variants = item.variants.filter(isAvailable);
    el.variantList.hidden = variants.length < 1;
    variants.forEach((variant, index) => {
      const label = make("label", "variant-option");
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "detailVariant";
      input.value = String(variant.id);
      input.checked = index === 0;
      input.addEventListener("change", updateDetailAdd);
      label.append(input, make("span", "", nameOf(variant)), make("strong", "", formatVnd(numericPrice(variant))));
      el.variantList.append(label);
    });
  }

  function selectedVariant() {
    const selectedId = el.variantList.querySelector("input:checked")?.value;
    return state.selectedItem?.variants?.find((variant) => String(variant.id) === selectedId) || null;
  }

  function updateDetailAdd() {
    const item = state.selectedItem;
    if (!item) return;
    if (item.requires_preorder === true) {
      el.detailAdd.disabled = true;
      el.detailAdd.textContent = t("preorderDetailsOnly");
      return;
    }
    const price = numericPrice(selectedVariant() || item);
    el.detailAdd.disabled = !isAvailable(item);
    el.detailAdd.textContent = `${t("addToCart")} · ${formatVnd(price * state.detailQuantity)}`;
  }

  function addSelectedToCart() {
    const item = state.selectedItem;
    if (!item || !isAvailable(item)) return;
    const variant = selectedVariant();
    if (item.variants.length && !variant) return;
    const key = `${item.id}:${variant?.id || "default"}:${el.detailNote.value.trim()}`;
    const existing = state.cart.find((line) => line.key === key);
    const available = Math.min(
      MAX_QTY - cartQuantityForItem(item.id),
      MAX_TOTAL_QTY - cartQuantityTotal()
    );
    if (available < 1) {
      toast(t("quantityLimit"));
      return;
    }
    const quantityToAdd = Math.min(state.detailQuantity, available);
    if (existing) existing.qty += quantityToAdd;
    else {
      state.cart.push({
        key,
        menu_item_id: String(item.id),
        variant_id: variant?.id == null ? null : String(variant.id),
        qty: quantityToAdd,
        line_note: el.detailNote.value.trim(),
        item,
        variant
      });
    }
    markCartChanged();
    closeOverlay(el.detailBackdrop, el.detailSheet);
    renderCart();
    toast(t("added"));
  }

  function renderCart() {
    el.cartLines.replaceChildren();
    state.cart.forEach((line) => el.cartLines.append(cartLine(line)));
    const count = state.cart.reduce((sum, line) => sum + line.qty, 0);
    const total = cartTotal();
    el.cartCount.textContent = String(count);
    el.cartTotal.textContent = formatVnd(total);
    el.sheetTotal.textContent = formatVnd(total);
    el.emptyCart.hidden = state.cart.length > 0;
    el.reviewButton.disabled = state.cart.length === 0 || state.loading;
    el.cartButton.hidden = state.cart.length === 0 || el.menuApp.hidden;
    saveCart();
    updateNoteStatus();
  }

  function cartLine(line) {
    const wrapper = make("article", "cart-line");
    const info = make("div", "");
    info.append(make("h3", "", nameOf(line.item)));
    const optionText = line.variant ? nameOf(line.variant) : translationsOf(line.item);
    if (optionText) info.append(make("p", "item-translation", optionText));
    info.append(make("p", "line-price", formatVnd(linePrice(line) * line.qty)));

    const controls = make("div", "line-controls");
    const minus = make("button", "", "−");
    minus.type = "button";
    minus.setAttribute("aria-label", `${nameOf(line.item)} ${t("quantity")} -`);
    minus.addEventListener("click", () => changeLineQty(line.key, -1));
    const quantity = make("output", "", line.qty);
    const plus = make("button", "", "+");
    plus.type = "button";
    plus.setAttribute("aria-label", `${nameOf(line.item)} ${t("quantity")} +`);
    plus.addEventListener("click", () => changeLineQty(line.key, 1));
    controls.append(minus, quantity, plus);

    const note = document.createElement("input");
    note.className = "line-note";
    note.type = "text";
    note.maxLength = 120;
    note.placeholder = t("itemRequestPlaceholder");
    note.value = line.line_note;
    note.addEventListener("input", () => {
      line.line_note = note.value.trim();
      markCartChanged();
      updateNoteStatus();
    });
    note.addEventListener("change", () => {
      saveCart();
    });
    const remove = make("button", "remove-line", t("remove"));
    remove.type = "button";
    remove.addEventListener("click", () => removeLine(line.key));
    wrapper.append(info, controls, note, remove);
    return wrapper;
  }

  function linePrice(line) {
    return numericPrice(line.variant || line.item);
  }

  function cartTotal() {
    return state.cart.reduce((sum, line) => sum + linePrice(line) * line.qty, 0);
  }

  function cartQuantityTotal() {
    return state.cart.reduce((sum, line) => sum + line.qty, 0);
  }

  function cartQuantityForItem(menuItemId) {
    return state.cart.reduce(
      (sum, line) => sum + (String(line.menu_item_id) === String(menuItemId) ? line.qty : 0),
      0
    );
  }

  function cleanNote(value) {
    return String(value || "")
      .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function composedOrderNote() {
    const notes = [];
    const overall = cleanNote(el.orderNote.value);
    if (overall) notes.push(overall);
    state.cart.forEach((line) => {
      const note = cleanNote(line.line_note);
      if (!note) return;
      const option = line.variant ? ` / ${nameOf(line.variant)}` : "";
      notes.push(`[${nameOf(line.item)}${option} × ${line.qty}] ${note}`);
    });
    return notes.join(" | ");
  }

  function unicodeLength(value) {
    return [...String(value || "")].length;
  }

  function buildSubmissionItems() {
    const quantities = new Map();
    state.cart.forEach((line) => {
      const menuItemId = String(line.menu_item_id);
      quantities.set(menuItemId, (quantities.get(menuItemId) || 0) + line.qty);
    });
    return [...quantities].map(([menu_item_id, qty]) => ({ menu_item_id, qty }));
  }

  function createClientRequestId() {
    if (global.crypto?.randomUUID) return global.crypto.randomUUID();
    const bytes = new Uint8Array(16);
    if (global.crypto?.getRandomValues) global.crypto.getRandomValues(bytes);
    else bytes.forEach((_value, index) => { bytes[index] = Math.floor(Math.random() * 256); });
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function updateNoteStatus() {
    const length = unicodeLength(composedOrderNote());
    const tooLong = length > 500;
    el.noteCounter.textContent = `${length} / 500`;
    el.noteCounter.style.color = tooLong ? "var(--danger)" : "";
    el.noteError.textContent = tooLong ? t("noteTooLong") : "";
    el.noteError.hidden = !tooLong;
    el.reviewButton.disabled = state.cart.length === 0 || state.loading || tooLong;
    return !tooLong;
  }

  function changeLineQty(key, delta) {
    const line = state.cart.find((candidate) => candidate.key === key);
    if (!line) return;
    if (delta > 0) {
      if (cartQuantityForItem(line.menu_item_id) >= MAX_QTY || cartQuantityTotal() >= MAX_TOTAL_QTY) return;
      line.qty += 1;
    } else {
      line.qty = Math.max(0, line.qty - 1);
    }
    if (!line.qty) state.cart = state.cart.filter((candidate) => candidate.key !== key);
    markCartChanged();
    renderCart();
  }

  function removeLine(key) {
    state.cart = state.cart.filter((line) => line.key !== key);
    markCartChanged();
    renderCart();
  }

  function markCartChanged() {
    state.pendingRequestId = null;
  }

  function cartStorageKey() {
    const tableId = state.table?.id || state.table?.label || "table";
    return `hana-qr-cart:${tableId}`;
  }

  function saveCart() {
    if (!state.table || !global.sessionStorage) return;
    const serializable = state.cart.map(({ menu_item_id, variant_id, qty, line_note }) => ({ menu_item_id, variant_id, qty, line_note }));
    global.sessionStorage.setItem(cartStorageKey(), JSON.stringify({ cart: serializable, note: el.orderNote?.value || "" }));
  }

  function restoreCart() {
    state.cart = [];
    if (!state.table || !global.sessionStorage) return;
    try {
      const saved = JSON.parse(global.sessionStorage.getItem(cartStorageKey()) || "null");
      if (!saved || !Array.isArray(saved.cart)) return;
      const restoredQuantities = new Map();
      let restoredTotal = 0;
      state.cart = saved.cart.flatMap((line) => {
        const item = state.items.find((candidate) => String(candidate.id) === String(line.menu_item_id));
        if (!item || !isAvailable(item)) return [];
        const variant = line.variant_id == null ? null : item.variants.find((candidate) => String(candidate.id) === String(line.variant_id));
        if (line.variant_id != null && (!variant || !isAvailable(variant))) return [];
        const itemId = String(item.id);
        const itemRemaining = MAX_QTY - (restoredQuantities.get(itemId) || 0);
        const orderRemaining = MAX_TOTAL_QTY - restoredTotal;
        const qty = Math.min(
          Math.max(1, Math.min(MAX_QTY, Number(line.qty) || 1)),
          itemRemaining,
          orderRemaining
        );
        if (qty < 1) return [];
        restoredQuantities.set(itemId, (restoredQuantities.get(itemId) || 0) + qty);
        restoredTotal += qty;
        const note = String(line.line_note || "").slice(0, 120);
        return [{ key: `${item.id}:${variant?.id || "default"}:${note}`, menu_item_id: String(item.id), variant_id: variant?.id == null ? null : String(variant.id), qty, line_note: note, item, variant }];
      });
      el.orderNote.value = String(saved.note || "").slice(0, 300);
    } catch (_error) {
      global.sessionStorage.removeItem(cartStorageKey());
    }
  }

  function showConfirmation() {
    if (!state.cart.length) return;
    if (!updateNoteStatus()) {
      toast(t("noteTooLong"));
      el.orderNote.focus();
      return;
    }
    el.confirmTable.textContent = tableLabel();
    el.confirmLines.replaceChildren();
    state.cart.forEach((line) => {
      const row = make("div", "confirm-line");
      const label = make("span", "", `${nameOf(line.item)} × ${line.qty}`);
      if (line.variant) label.append(make("small", "", nameOf(line.variant)));
      row.append(label, make("strong", "", formatVnd(linePrice(line) * line.qty)));
      el.confirmLines.append(row);
    });
    el.confirmTotal.textContent = formatVnd(cartTotal());
    closeOverlay(el.cartBackdrop, el.cartSheet, false);
    openOverlay(el.confirmBackdrop, null, el.confirmCancel);
  }

  async function submitOrder() {
    if (state.loading || !state.cart.length) return;
    if (!updateNoteStatus()) {
      toast(t("noteTooLong"));
      return;
    }
    state.loading = true;
    el.submitOrder.disabled = true;
    el.submitOrder.textContent = t("submitting");
    state.pendingRequestId ||= createClientRequestId();
    try {
      const result = await apiRequest({
        method: "POST",
        body: {
          action: "submit_order",
          table_token: state.token,
          client_request_id: state.pendingRequestId,
          note: composedOrderNote() || null,
          // Item-specific requests are consolidated into the bounded order note;
          // the database contract accepts one authoritative-price line per menu id.
          items: buildSubmissionItems()
        }
      });
      const order = result?.order || result;
      const authoritativeTotal = Number(order?.total_vnd);
      closeOverlay(el.confirmBackdrop, null, false);
      showSuccess(order, Number.isFinite(authoritativeTotal) ? authoritativeTotal : cartTotal());
      state.cart = [];
      state.pendingRequestId = null;
      el.orderNote.value = "";
      global.sessionStorage?.removeItem(cartStorageKey());
      renderCart();
      global.setTimeout(refreshCurrentOrders, 0);
    } catch (error) {
      const message = error?.code === "TABLE_NOT_FOUND" || error?.status === 401 || error?.status === 403 || error?.status === 404
        ? t("invalidQr")
        : error?.code === "MENU_UNAVAILABLE"
          ? t("menuChanged")
          : error?.code === "RATE_LIMITED"
            ? t("rateLimited")
            : t("orderFailed");
      toast(message);
      if (error?.code === "MENU_UNAVAILABLE") global.setTimeout(loadMenu, 900);
    } finally {
      state.loading = false;
      el.submitOrder.disabled = false;
      el.submitOrder.textContent = t("submitOrder");
    }
  }

  function showSuccess(order, total) {
    const displayNumber = order?.display_number || order?.order_number || (order?.id ? String(order.id).slice(-8).toUpperCase() : "");
    el.successNumber.textContent = displayNumber ? `${t("orderNumber")} ${displayNumber}` : tableLabel();
    const itemCount = state.cart.reduce((sum, line) => sum + line.qty, 0);
    el.successSummary.replaceChildren(make("span", "", `${itemCount} ${t("items")}`), make("strong", "", formatVnd(total)));
    openOverlay(el.successBackdrop, null, el.newOrderButton);
  }

  function openOverlay(backdrop, sheet, focusTarget) {
    backdrop.hidden = false;
    if (sheet) sheet.hidden = false;
    document.body.classList.add("has-overlay");
    global.setTimeout(() => focusTarget?.focus(), 0);
  }

  function closeOverlay(backdrop, sheet, updateBody = true) {
    backdrop.hidden = true;
    if (sheet) sheet.hidden = true;
    if (updateBody && !document.querySelector(".sheet-backdrop:not([hidden]), .modal-backdrop:not([hidden])")) document.body.classList.remove("has-overlay");
  }

  function toast(message) {
    global.clearTimeout(state.toastTimer);
    el.toast.textContent = message;
    el.toast.hidden = false;
    state.toastTimer = global.setTimeout(() => { el.toast.hidden = true; }, 2800);
  }

  function setLanguage(language) {
    state.language = normalizeLanguage(language);
    global.localStorage?.setItem("hana-menu-language", state.language);
    copyUi();
    if (state.table) {
      el.tableLabel.textContent = tableLabel();
      renderMenu();
      renderCart();
      renderCurrentOrders();
    }
    if (!el.detailSheet.hidden && state.selectedItem) openDetail(state.selectedItem);
  }

  function bindEvents() {
    document.querySelectorAll("[data-language]").forEach((button) => button.addEventListener("click", () => setLanguage(button.dataset.language)));
    el.retryButton.addEventListener("click", loadMenu);
    el.detailClose.addEventListener("click", () => closeOverlay(el.detailBackdrop, el.detailSheet));
    el.detailBackdrop.addEventListener("click", () => closeOverlay(el.detailBackdrop, el.detailSheet));
    el.detailMinus.addEventListener("click", () => {
      state.detailQuantity = Math.max(1, state.detailQuantity - 1);
      el.detailQuantity.textContent = String(state.detailQuantity);
      updateDetailAdd();
    });
    el.detailPlus.addEventListener("click", () => {
      state.detailQuantity = Math.min(MAX_QTY, state.detailQuantity + 1);
      el.detailQuantity.textContent = String(state.detailQuantity);
      updateDetailAdd();
    });
    el.detailAdd.addEventListener("click", addSelectedToCart);
    el.cartButton.addEventListener("click", () => { renderCart(); openOverlay(el.cartBackdrop, el.cartSheet, el.cartClose); });
    el.cartClose.addEventListener("click", () => { saveCart(); closeOverlay(el.cartBackdrop, el.cartSheet); });
    el.cartBackdrop.addEventListener("click", () => { saveCart(); closeOverlay(el.cartBackdrop, el.cartSheet); });
    el.orderNote.addEventListener("input", () => { markCartChanged(); updateNoteStatus(); });
    el.orderNote.addEventListener("change", saveCart);
    el.reviewButton.addEventListener("click", showConfirmation);
    el.confirmCancel.addEventListener("click", () => { closeOverlay(el.confirmBackdrop, null); openOverlay(el.cartBackdrop, el.cartSheet, el.cartClose); });
    el.submitOrder.addEventListener("click", submitOrder);
    el.newOrderButton.addEventListener("click", () => closeOverlay(el.successBackdrop, null));
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && state.table) refreshCurrentOrders();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || state.loading) return;
      if (!el.detailSheet.hidden) closeOverlay(el.detailBackdrop, el.detailSheet);
      else if (!el.cartSheet.hidden) closeOverlay(el.cartBackdrop, el.cartSheet);
      else if (!el.confirmBackdrop.hidden) closeOverlay(el.confirmBackdrop, null);
    });
  }

  function init() {
    ids.forEach((id) => { el[id] = document.getElementById(id); });
    state.token = readToken();
    copyUi();
    bindEvents();
    loadMenu();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
})(window);
