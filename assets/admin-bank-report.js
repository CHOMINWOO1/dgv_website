(function (root, factory) {
  const api = factory();
  root.DGV_BANK_REPORT = api;
  if (typeof module === "object" && module && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const text = value => String(value == null ? "" : value).trim();
  const normalize = value => text(value).toLowerCase();
  const escape = value => text(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
  function number(value) {
    if (value === null || value === undefined || typeof value === "boolean" || text(value) === "") return null;
    const result = Number(value);
    return Number.isFinite(result) ? result : null;
  }
  const amount = value => {
    const result = number(value);
    return result === null ? null : Math.round(result);
  };
  const sum = values => values.some(value => value === null) ? null : values.reduce((total, value) => total + value, 0);
  const money = value => value === null || value === undefined ? "-" : Number(value).toLocaleString("en-US");
  const paymentLabel = method => ({ bank: "은행 / Chuyển khoản", card: "카드 / Thẻ", cash: "현금 / Tiền mặt" })[method] || "-";

  function vietnamTime(value) {
    if (!value) return "-";
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "-";
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    }).formatToParts(date);
    const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `${fields.year}-${fields.month}-${fields.day} ${fields.hour}:${fields.minute}`;
  }

  function sourceLines(source, id) {
    const key = String(id == null ? "" : id);
    const index = source.linesByOrder;
    if (index && typeof index.get === "function") return index.get(key) || index.get(id) || [];
    if (index && typeof index === "object") return index[key] || [];
    return (Array.isArray(source.visibleLines) ? source.visibleLines : [])
      .filter(line => String(line.order_id) === key);
  }

  // Only local raster data URLs belong in printable HTML. Never accept an arbitrary URL or markup.
  function safeReceiptDataUrl(value) {
    if (typeof value !== "string") return "";
    const prefix = /^data:image\/(?:jpeg|png|webp);base64,/.exec(value);
    if (!prefix) return "";
    const encoded = value.slice(prefix[0].length);
    return encoded.length && encoded.length % 4 === 0 && !/[^A-Za-z0-9+/=]/.test(encoded)
      && /^[A-Za-z0-9+/]+={0,2}$/.test(encoded) ? value : "";
  }

  function sourceReceipt(source, id) {
    const index = source.cardReceiptsByOrder;
    const key = String(id == null ? "" : id);
    const entry = index && typeof index.get === "function" ? index.get(key) || index.get(id)
      : index && typeof index === "object" && Object.prototype.hasOwnProperty.call(index, key) ? index[key] : null;
    return entry && !Array.isArray(entry) ? safeReceiptDataUrl(entry.dataUrl) : "";
  }

  function buildOrder(order, source) {
    const warnings = [];
    const rawLines = sourceLines(source, order.id);
    const lines = (Array.isArray(rawLines) ? rawLines : []).map((line, index) => {
      const qty = number(line.qty);
      const unitAmount = amount(line.unit_vnd);
      let grossAmount = amount(line.line_vnd);
      if (grossAmount === null && unitAmount !== null && qty !== null) {
        grossAmount = Math.round(unitAmount * qty);
        warnings.push(`${index + 1}번 품목: 저장 단가와 수량으로 금액을 계산했습니다. / Mục ${index + 1}: thành tiền được tính từ đơn giá và số lượng đã lưu.`);
      }
      if (grossAmount === null || qty === null || unitAmount === null) {
        warnings.push(`${index + 1}번 품목: 누락된 금액 또는 수량을 확인해 주세요. / Mục ${index + 1}: vui lòng kiểm tra số tiền hoặc số lượng còn thiếu.`);
      }
      return {
        koName: text(line.ko_name) || text(line.custom_ko_name) || "메뉴명 없음",
        viName: text(line.vi_name) || text(line.custom_vi_name),
        qty, unitAmount, grossAmount
      };
    });
    if (!lines.length) warnings.push("저장된 상세 메뉴가 없습니다. 주문 원본을 확인해 주세요. / Chưa có chi tiết món ăn. Vui lòng kiểm tra đơn hàng gốc.");
    const lineTotal = sum(lines.map(line => line.grossAmount));
    let grossAmount = amount(order.total_vnd);
    if (grossAmount === null) {
      grossAmount = lines.length ? lineTotal : null;
      warnings.push("저장된 주문 총액이 없습니다. 표시 금액은 확인 가능한 상세 합계입니다. / Thiếu tổng tiền đơn hàng đã lưu. Số tiền hiển thị là tổng chi tiết có thể xác định.");
    }
    const difference = grossAmount !== null && lineTotal !== null ? grossAmount - lineTotal : null;
    if (difference !== null && difference !== 0) {
      warnings.push("주문 총액과 메뉴 합계에 차이가 있습니다. 할인·수수료 등 원인을 확인해 주세요. / Tổng tiền đơn hàng khác tổng chi tiết. Vui lòng kiểm tra giảm giá, phụ phí hoặc nguyên nhân khác.");
    }
    const paymentMethod = normalize(order.payment_method);
    const receiptDataUrl = paymentMethod === "card" ? sourceReceipt(source, order.id) : "";
    return {
      id: text(order.id), createdAt: order.created_at || null,
      guideName: text(order.guide_name), teamNo: text(order.team_no),
      paymentMethod,
      ...(receiptDataUrl ? { receiptDataUrl } : {}),
      lines, lineTotal, grossAmount, difference, warnings
    };
  }

  /** Read-only print model; dates and excluded rows are filtered by the existing admin query. */
  function buildReport(sourceReport) {
    const source = sourceReport || {};
    const raw = Array.isArray(source.visibleOrders) ? source.visibleOrders : [];
    const selected = raw.filter(order => order && normalize(order.status) === "paid" && order.sales_excluded !== true
      && ["bank", "cash", "card"].includes(normalize(order.payment_method)))
      .map(order => buildOrder(order, source));
    const orders = selected.filter(order => order.paymentMethod === "bank");
    const otherOrders = selected.filter(order => order.paymentMethod !== "bank");
    return {
      orders, otherOrders,
      rangeText: text(source.rangeText), generatedAt: source.generatedAt || new Date(),
      orderCount: selected.length, bankOrderCount: orders.length,
      sectionCount: selected.length,
      grossAmount: sum(selected.map(order => order.grossAmount)),
      bankGrossAmount: sum(orders.map(order => order.grossAmount)),
      otherGrossAmount: sum(otherOrders.map(order => order.grossAmount))
    };
  }

  function reportHeader(model, titleKo, titleVi, index) {
    return `<header><div class="brand">HANA RESTAURANT</div><h1>${escape(titleKo)}</h1><h2>${escape(titleVi)}</h2>
      <div class="reportMeta"><span>조회 기간 / Kỳ báo cáo: ${escape(model.rangeText)}</span><span>출력 묶음 / Nhóm in: ${index} / ${model.sectionCount}</span></div>
      <div class="reportMeta"><span>주문 일시 기준 / Theo thời điểm đặt hàng (Việt Nam, UTC+07:00)</span><span>생성 / Tạo lúc: ${escape(vietnamTime(model.generatedAt))}</span></div></header>`;
  }

  function warningHtml(warnings) {
    return warnings.length ? `<aside class="warnings"><strong>확인 필요 / Cần kiểm tra</strong><ul>${warnings.map(warning => `<li>${escape(warning)}</li>`).join("")}</ul></aside>` : "";
  }

  function itemsTable(lines, showPayment) {
    const rows = lines.map((line, index) => `<tr><td class="center">${index + 1}</td><td class="menuName"><strong>${escape(line.koName)}</strong>${line.viName ? `<span>${escape(line.viName)}</span>` : ""}</td>
      ${showPayment ? `<td class="payment">${escape(paymentLabel(line.paymentMethod))}</td>` : ""}
      <td class="number">${money(line.qty)}</td><td class="number">${money(line.unitAmount)}</td><td class="number">${money(line.grossAmount)}</td></tr>`).join("");
    return `<table class="items"><colgroup><col style="width:5%"><col style="width:${showPayment ? "29" : "43"}%">${showPayment ? '<col style="width:14%">' : ""}<col style="width:9%"><col style="width:20%"><col style="width:23%"></colgroup>
      <thead><tr><th>STT<br>No.</th><th>메뉴명 / Tên món</th>${showPayment ? "<th>결제수단<br>Thanh toán</th>" : ""}<th>수량<br>Số lượng</th><th>VAT 포함 단가<br>Đơn giá có VAT</th><th>VAT 포함 금액<br>Thành tiền có VAT</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="${showPayment ? 6 : 5}" class="center">상세 내역 없음 / Chưa có chi tiết</td></tr>`}</tbody></table>`;
  }

  function footer() {
    return `<footer>모든 금액은 VND이며 저장된 주문 금액 기준입니다. / Đơn vị: VND. Số tiền theo dữ liệu đơn hàng đã lưu.<br>
      실제 은행 입금 확인 내역이 아니며 전자세금계산서 원본이 아닙니다.<br>
      Đây không phải xác nhận tiền thực nhận vào ngân hàng hoặc hóa đơn điện tử gốc.</footer>`;
  }

  function orderSection(order, model, index) {
    const [methodKo, methodVi, className] = {
      bank: ["은행", "chuyển khoản", "bankOrder"],
      cash: ["현금", "tiền mặt", "cashOrders"],
      card: ["카드", "thẻ", "cardOrders"]
    }[order.paymentMethod];
    return `<section class="reportSection ${className}">${reportHeader(model, `${methodKo} 결제 주문 내역`, `CHI TIẾT ĐƠN HÀNG ${methodVi.toUpperCase()}`, index)}
      <div class="orderMeta"><div><b>주문번호 / Mã đơn:</b> ${escape(order.id)}</div><div><b>주문 일시 / Thời điểm đặt:</b> ${escape(vietnamTime(order.createdAt))}</div>
      ${order.guideName ? `<div><b>고객·가이드 / Khách·Hướng dẫn viên:</b> ${escape(order.guideName)}</div>` : ""}
      ${order.teamNo ? `<div><b>팀·테이블 / Nhóm·Bàn:</b> ${escape(order.teamNo)}</div>` : ""}
      <div><b>결제수단 / Thanh toán:</b> ${escape(paymentLabel(order.paymentMethod))}</div><div><b>주문 결제 상태 / Trạng thái:</b> 결제 완료 / Đã thanh toán</div></div>
      ${itemsTable(order.lines, false)}
      <div class="orderEnding"><div class="totals"><div><span>메뉴 합계 / Tổng chi tiết</span><b>${money(order.lineTotal)} VND</b></div>
      ${order.difference ? `<div class="difference"><span>주문-메뉴 차액 / Chênh lệch đơn hàng-chi tiết</span><b>${money(order.difference)} VND</b></div>` : ""}
      <div class="grand"><span>${methodKo} 결제 총액 (VAT 포함)<br>Tổng thanh toán ${methodVi} (có VAT)</span><b>${money(order.grossAmount)} VND</b></div></div>
      ${warningHtml(order.warnings)}${footer()}</div></section>`;
  }

  function receiptSection(order, model, index) {
    const dataUrl = order.paymentMethod === "card" ? safeReceiptDataUrl(order.receiptDataUrl) : "";
    if (!dataUrl) return "";
    return `<section class="reportSection receiptPage">${reportHeader(model, "카드 매출전표 사진", "ẢNH BIÊN LAI THẺ", index)}
      <figure class="receiptFigure"><figcaption class="receiptCaption">
      <div><b>카드 주문번호 / Mã đơn thanh toán thẻ:</b> ${escape(order.id)}</div>
      <div><b>주문 일시 / Thời điểm đặt:</b> ${escape(vietnamTime(order.createdAt))}</div>
      <div><b>카드 결제 총액 (VAT 포함) / Tổng thanh toán thẻ (có VAT):</b> ${money(order.grossAmount)} VND</div>
      </figcaption><div class="receiptImageBox"><img class="receiptImage" src="${escape(dataUrl)}" alt="${escape(`카드 영수증 / Biên lai thẻ: ${order.id}`)}"></div></figure></section>`;
  }

  /** One print job must wait for every local receipt, including delayed decoding. */
  async function waitForPrintAssets(printWindow, timeoutMs = 10000) {
    if (!printWindow || printWindow.closed || !printWindow.document) throw new Error("Print window is not available");
    const document = printWindow.document;
    const cleanups = [];
    const setTimer = typeof printWindow.setTimeout === "function" ? printWindow.setTimeout.bind(printWindow) : setTimeout;
    const clearTimer = typeof printWindow.clearTimeout === "function" ? printWindow.clearTimeout.bind(printWindow) : clearTimeout;
    let timer;
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimer(() => {
        const error = new Error("Print assets did not become ready in time");
        error.code = "PAYMENT_PRINT_ASSET_TIMEOUT";
        reject(error);
      }, Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10000);
    });
    const imageReady = image => new Promise((resolve, reject) => {
      let settled = false;
      const remove = () => {
        image.removeEventListener("load", loaded);
        image.removeEventListener("error", failed);
      };
      const failed = () => {
        if (settled) return;
        settled = true;
        remove();
        const error = new Error("A card receipt image could not be loaded");
        error.code = "PAYMENT_PRINT_IMAGE_ERROR";
        reject(error);
      };
      const loaded = () => {
        if (settled) return;
        if (!(image.naturalWidth > 0 && image.naturalHeight > 0)) return failed();
        settled = true;
        remove();
        Promise.resolve().then(() => typeof image.decode === "function" ? image.decode() : undefined).then(resolve, reject);
      };
      cleanups.push(remove);
      image.addEventListener("load", loaded);
      image.addEventListener("error", failed);
      if (image.complete) loaded();
    });
    try {
      await Promise.race([Promise.all([
        document.fonts && document.fonts.ready,
        ...Array.from(document.images || [], imageReady)
      ]), timeout]);
      if (printWindow.closed) throw new Error("Print window was closed before its assets were ready");
    } finally {
      clearTimer(timer);
      cleanups.forEach(cleanup => cleanup());
    }
  }

  function aggregateOtherLines(orders) {
    const grouped = new Map();
    orders.forEach(order => order.lines.forEach(line => {
      const key = JSON.stringify([order.paymentMethod, line.koName, line.viName, line.unitAmount]);
      const current = grouped.get(key);
      if (current) {
        current.qty = sum([current.qty, line.qty]);
        current.grossAmount = sum([current.grossAmount, line.grossAmount]);
      } else grouped.set(key, { ...line, paymentMethod: order.paymentMethod });
    }));
    return Array.from(grouped.values());
  }

  /** Excel cells remain numbers or literal strings; the existing XLSX writer never creates formulas. */
  function workbookOptions(model) {
    const textCell = (value, style = "normal") => ({ value: String(value == null ? "" : value), style });
    const numberCell = (value, style = "integer") => ({ value: number(value), style });
    const headerRow = labels => labels.map(label => textCell(label, "header"));
    const sheets = [];
    const addSheet = (name, method, orders, lines, title) => {
      const rows = [];
      const merges = [];
      const fullRow = (value, style = "wrapped") => {
        // Short physical lines stay readable in merged cells without relying on Excel auto-height.
        const words = String(value).split(/\s+/);
        let current = "";
        for (const word of words) {
          if (current && current.length + word.length + 1 > 120) {
            rows.push([textCell(current, style)]);
            merges.push(`A${rows.length}:G${rows.length}`);
            current = "";
          }
          current += (current ? " " : "") + word;
        }
        rows.push([textCell(current, style)]);
        merges.push(`A${rows.length}:G${rows.length}`);
      };
      const metadata = (label, value) => {
        rows.push([textCell(label, "totalLabel"), "", "", "", textCell(value, "wrapped")]);
        merges.push(`A${rows.length}:D${rows.length}`, `E${rows.length}:G${rows.length}`);
      };
      const totalRow = (label, value) => {
        rows.push([textCell(label, "totalLabel"), "", "", "", "", "", numberCell(value, "totalNumber")]);
        merges.push(`A${rows.length}:F${rows.length}`);
      };
      fullRow("HANA RESTAURANT · " + title, "title");
      metadata("조회 기간 / Kỳ báo cáo", model.rangeText);
      metadata("생성 (베트남) / Tạo lúc (Việt Nam)", vietnamTime(model.generatedAt));
      metadata("결제수단 / Thanh toán", paymentLabel(method));
      metadata("결제 완료 주문 / Đơn đã thanh toán", orders.length + "건 / đơn");
      fullRow("주문 일시는 베트남 시간(UTC+07:00)이며 모든 금액은 VND입니다. / Thời điểm đặt theo giờ Việt Nam (UTC+07:00). Đơn vị tiền: VND.");
      if (method === "bank") {
        const order = orders[0];
        metadata("주문번호 / Mã đơn", order.id);
        metadata("주문 일시 / Thời điểm đặt", vietnamTime(order.createdAt));
        if (order.guideName) metadata("고객·가이드 / Khách·Hướng dẫn viên", order.guideName);
        if (order.teamNo) metadata("팀·테이블 / Nhóm·Bàn", order.teamNo);
      } else {
        fullRow("같은 결제수단·메뉴·단가별로 합산합니다. / Gộp theo phương thức thanh toán, món ăn và đơn giá.");
      }
      rows.push([]);
      rows.push(headerRow(["STT / No.", "메뉴명 (KO)", "Tên món (VI)", "결제수단 / Thanh toán", "수량 / Số lượng", "VAT 포함 단가 / Đơn giá có VAT", "VAT 포함 금액 / Thành tiền có VAT"]));
      const headerIndex = rows.length;
      for (const [index, line] of lines.entries()) {
        rows.push([numberCell(index + 1), textCell(line.koName, "wrapped"), textCell(line.viName, "wrapped"),
          textCell(paymentLabel(method), "wrapped"), numberCell(line.qty), numberCell(line.unitAmount), numberCell(line.grossAmount)]);
      }
      if (!lines.length) fullRow("상세 내역 없음 / Chưa có chi tiết");
      const lastDetailRow = rows.length;
      rows.push([]);
      const lineTotal = sum(orders.map(order => order.lineTotal));
      const grossAmount = sum(orders.map(order => order.grossAmount));
      const difference = grossAmount !== null && lineTotal !== null ? grossAmount - lineTotal : null;
      totalRow("메뉴 합계 / Tổng chi tiết", lineTotal);
      totalRow("주문-메뉴 차액 / Chênh lệch đơn hàng-chi tiết", difference);
      totalRow("결제 총액 (VAT 포함) / Tổng thanh toán (có VAT)", grossAmount);
      if (method !== "bank") {
        rows.push([]);
        fullRow("포함 주문 / Các đơn hàng được tổng hợp", "totalLabel");
        rows.push(headerRow(["주문번호 / Mã đơn", "주문 일시 / Thời điểm đặt", "고객·가이드 / Khách·Hướng dẫn viên", "팀·테이블 / Nhóm·Bàn", "결제수단 / Thanh toán", "메뉴 합계 / Tổng chi tiết", "VAT 포함 총액 / Tổng có VAT"]));
        for (const order of orders) {
          rows.push([textCell(order.id, "wrapped"), textCell(vietnamTime(order.createdAt)), textCell(order.guideName, "wrapped"),
            textCell(order.teamNo, "wrapped"), textCell(paymentLabel(method), "wrapped"), numberCell(order.lineTotal), numberCell(order.grossAmount)]);
        }
      }
      const warnings = orders.flatMap(order => order.warnings.map(warning => `${order.id}: ${warning}`));
      if (warnings.length) {
        rows.push([]);
        fullRow("확인 필요 / Cần kiểm tra", "totalLabel");
        warnings.forEach(warning => fullRow(warning));
      }
      rows.push([]);
      fullRow("빈 금액 셀은 미확인 값이며 0은 저장된 0원입니다. / Ô số tiền trống là chưa xác định; số 0 là giá trị đã lưu.");
      fullRow("저장된 주문 금액 기준입니다. 실제 은행 입금 확인 내역이나 전자세금계산서 원본이 아닙니다.");
      fullRow("Số tiền theo dữ liệu đơn hàng đã lưu. Đây không phải xác nhận tiền thực nhận vào ngân hàng hoặc hóa đơn điện tử gốc.");
      if (rows.length > 1048576) {
        const error = new Error("Selected payment details exceed the Excel row limit");
        error.code = "PAYMENT_XLSX_ROW_LIMIT";
        throw error;
      }
      sheets.push({ name, rows, merges, columnWidths: [16, 30, 34, 25, 19, 27, 29], freezeRows: headerIndex,
        autoFilterRange: `A${headerIndex}:G${lastDetailRow}` });
    };
    const sectionCount = model.orders.length + (model.otherOrders.some(order => order.paymentMethod === "cash") ? 1 : 0)
      + (model.otherOrders.some(order => order.paymentMethod === "card") ? 1 : 0);
    if (!sectionCount || sectionCount > 255) {
      const error = new Error(sectionCount ? "Selected payment groups exceed the exporter sheet limit" : "No paid orders to export");
      error.code = sectionCount ? "PAYMENT_XLSX_SHEET_LIMIT" : "PAYMENT_XLSX_EMPTY";
      throw error;
    }
    model.orders.forEach((order, index) => addSheet(`은행 ${String(index + 1).padStart(3, "0")}`, "bank", [order], order.lines,
      "은행 결제 주문 내역 / CHI TIẾT ĐƠN HÀNG CHUYỂN KHOẢN"));
    for (const method of ["cash", "card"]) {
      const orders = model.otherOrders.filter(order => order.paymentMethod === method);
      if (!orders.length) continue;
      addSheet(method === "cash" ? "현금 Tiền mặt" : "카드 Thẻ", method, orders, aggregateOtherLines(orders), method === "cash"
        ? "현금 결제 합산 내역 / TỔNG HỢP THANH TOÁN TIỀN MẶT" : "카드 결제 합산 내역 / TỔNG HỢP THANH TOÁN THẺ");
    }
    const dateLabel = text(model.rangeText).replace(/[^0-9-]+/g, "_").replace(/^_+|_+$/g, "") || "export";
    return { filename: `HANA_Payments_${dateLabel}.xlsx`, sheets };
  }

  function renderHtml(model) {
    const orders = [...model.otherOrders.filter(order => order.paymentMethod === "card"),
      ...model.orders, ...model.otherOrders.filter(order => order.paymentMethod === "cash")];
    const sections = orders.map((order, index) => orderSection(order, model, index + 1) + receiptSection(order, model, index + 1));
    return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>HANA 결제 내역 / Chi tiết thanh toán</title><style>
      @page{size:A4 portrait;margin:13mm 12mm}
      *{box-sizing:border-box}body{margin:0;color:#1c1917;background:#fff;font-family:Arial,"Malgun Gothic",sans-serif;font-size:11px;line-height:1.45}
      .reportSection + .reportSection{break-before:page;page-break-before:always}.reportSection{width:100%}
      header{border-bottom:2px solid #3e2b20;padding-bottom:10px;margin-bottom:12px;break-inside:avoid;page-break-inside:avoid}.brand{font-size:11px;letter-spacing:2px;font-weight:bold;color:#6f4b32}
      h1{margin:6px 0 2px;font-size:23px;line-height:1.3}h2{margin:0 0 11px;font-size:14px}h3{font-size:12px;margin:18px 0 6px}
      .reportMeta{display:flex;justify-content:space-between;gap:10px;font-size:9px;margin-top:3px}.orderMeta{display:grid;grid-template-columns:1fr 1fr;gap:6px 15px;margin:12px 0 16px;overflow-wrap:anywhere}
      table{border-collapse:collapse;width:100%;table-layout:fixed}th,td{border:1px solid #aaa;padding:7px 6px;vertical-align:middle}th{background:#f3eee7;font-weight:bold;font-size:10px;text-align:center}
      thead{display:table-header-group}tr{break-inside:avoid;page-break-inside:avoid}.menuName{overflow-wrap:anywhere}.menuName strong{font-weight:600}.menuName span{display:block;font-size:10px;margin-top:2px;color:#51473e}
      .number{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}.center{text-align:center}.payment{font-size:10px;overflow-wrap:anywhere}
      .totals{margin-top:10px;break-inside:avoid;page-break-inside:avoid;border:1px solid #aaa}.totals>div{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:7px 10px}.totals b{white-space:nowrap}.totals .grand{border-top:2px solid #3e2b20;font-size:13px;background:#f8f3ed}.difference{color:#8b3f22}
      .orderEnding{break-inside:avoid;page-break-inside:avoid}
      .receiptPage{height:270mm;display:flex;flex-direction:column;break-inside:avoid;page-break-inside:avoid}.receiptPage header{flex:none}
      .receiptFigure{margin:0;flex:1;min-height:0;display:flex;flex-direction:column;gap:12px}.receiptCaption{flex:none;overflow-wrap:anywhere;font-size:11px;border-bottom:1px solid #aaa;padding-bottom:10px}
      .receiptImageBox{flex:1;min-height:0}.receiptImage{display:block;width:100%;height:100%;object-fit:contain}
      .sectionIntro{margin:12px 0}.orderIndex{font-size:9px}.orderIndex td:first-child{overflow-wrap:anywhere}.warnings{border:1px solid #b9874c;background:#fffaf0;margin-top:12px;padding:8px 10px;font-size:10px}.warnings ul{padding-left:16px;margin:4px 0}.warnings li{overflow-wrap:anywhere;margin-top:4px}
      footer{margin-top:16px;border-top:1px dashed #999;padding-top:7px;font-size:9px;color:#555;break-inside:avoid;page-break-inside:avoid}
      @media screen{body{max-width:794px;margin:24px auto;padding:24px}.reportSection{margin-bottom:40px}}
      @media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
      </style></head><body>${sections.join("")}</body></html>`;
  }

  return Object.freeze({ buildReport, renderHtml, workbookOptions, waitForPrintAssets });
});
