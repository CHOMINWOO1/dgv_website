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
    return {
      id: text(order.id), createdAt: order.created_at || null,
      guideName: text(order.guide_name), teamNo: text(order.team_no),
      paymentMethod: normalize(order.payment_method),
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
      sectionCount: orders.length + (otherOrders.length ? 1 : 0),
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

  function bankSection(order, model, index) {
    return `<section class="reportSection bankOrder">${reportHeader(model, "은행 결제 주문 내역", "CHI TIẾT ĐƠN HÀNG CHUYỂN KHOẢN", index)}
      <div class="orderMeta"><div><b>주문번호 / Mã đơn:</b> ${escape(order.id)}</div><div><b>주문 일시 / Thời điểm đặt:</b> ${escape(vietnamTime(order.createdAt))}</div>
      ${order.guideName ? `<div><b>고객·가이드 / Khách·Hướng dẫn viên:</b> ${escape(order.guideName)}</div>` : ""}
      ${order.teamNo ? `<div><b>팀·테이블 / Nhóm·Bàn:</b> ${escape(order.teamNo)}</div>` : ""}
      <div><b>결제수단 / Thanh toán:</b> ${escape(paymentLabel(order.paymentMethod))}</div><div><b>주문 결제 상태 / Trạng thái:</b> 결제 완료 / Đã thanh toán</div></div>
      ${itemsTable(order.lines, false)}
      <div class="orderEnding"><div class="totals"><div><span>메뉴 합계 / Tổng chi tiết</span><b>${money(order.lineTotal)} VND</b></div>
      ${order.difference ? `<div class="difference"><span>주문-메뉴 차액 / Chênh lệch đơn hàng-chi tiết</span><b>${money(order.difference)} VND</b></div>` : ""}
      <div class="grand"><span>은행 결제 총액 (VAT 포함)<br>Tổng thanh toán chuyển khoản (có VAT)</span><b>${money(order.grossAmount)} VND</b></div></div>
      ${warningHtml(order.warnings)}${footer()}</div></section>`;
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

  function otherSection(model) {
    const orders = model.otherOrders;
    const cash = orders.filter(order => order.paymentMethod === "cash");
    const card = orders.filter(order => order.paymentMethod === "card");
    const lineTotal = sum(orders.map(order => order.lineTotal));
    const difference = model.otherGrossAmount !== null && lineTotal !== null ? model.otherGrossAmount - lineTotal : null;
    const warnings = orders.flatMap(order => order.warnings.map(warning => `${order.id}: ${warning}`));
    return `<section class="reportSection otherOrders">${reportHeader(model, "카드·현금 결제 합산 내역", "TỔNG HỢP THANH TOÁN THẺ VÀ TIỀN MẶT", model.sectionCount)}
      <p class="sectionIntro">주문 ${orders.length}건 / ${orders.length} đơn hàng. 같은 결제수단·메뉴·단가별로 합산합니다. / Gộp theo phương thức thanh toán, món ăn và đơn giá.</p>
      ${itemsTable(aggregateOtherLines(orders), true)}
      <div class="totals"><div><span>메뉴 합계 / Tổng chi tiết</span><b>${money(lineTotal)} VND</b></div>
      ${difference ? `<div class="difference"><span>주문-메뉴 차액 / Chênh lệch đơn hàng-chi tiết</span><b>${money(difference)} VND</b></div>` : ""}
      <div><span>현금 ${cash.length}건 / Tiền mặt: ${cash.length} đơn</span><b>${money(sum(cash.map(order => order.grossAmount)))} VND</b></div>
      <div><span>카드 ${card.length}건 / Thẻ: ${card.length} đơn</span><b>${money(sum(card.map(order => order.grossAmount)))} VND</b></div>
      <div class="grand"><span>카드·현금 총액 (VAT 포함)<br>Tổng thanh toán thẻ và tiền mặt (có VAT)</span><b>${money(model.otherGrossAmount)} VND</b></div></div>
      <h3>포함 주문 / Các đơn hàng được tổng hợp</h3><table class="orderIndex"><thead><tr><th>주문번호 / Mã đơn</th><th>주문 일시 / Thời điểm đặt</th><th>결제수단 / Thanh toán</th><th>VAT 포함 총액 / Tổng có VAT</th></tr></thead><tbody>
      ${orders.map(order => `<tr><td>${escape(order.id)}</td><td>${escape(vietnamTime(order.createdAt))}</td><td>${escape(paymentLabel(order.paymentMethod))}</td><td class="number">${money(order.grossAmount)}</td></tr>`).join("")}</tbody></table>
      ${warningHtml(warnings)}${footer()}</section>`;
  }

  function renderHtml(model) {
    const sections = model.orders.map((order, index) => bankSection(order, model, index + 1));
    if (model.otherOrders.length) sections.push(otherSection(model));
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
      .sectionIntro{margin:12px 0}.orderIndex{font-size:9px}.orderIndex td:first-child{overflow-wrap:anywhere}.warnings{border:1px solid #b9874c;background:#fffaf0;margin-top:12px;padding:8px 10px;font-size:10px}.warnings ul{padding-left:16px;margin:4px 0}.warnings li{overflow-wrap:anywhere;margin-top:4px}
      footer{margin-top:16px;border-top:1px dashed #999;padding-top:7px;font-size:9px;color:#555;break-inside:avoid;page-break-inside:avoid}
      @media screen{body{max-width:794px;margin:24px auto;padding:24px}.reportSection{margin-bottom:40px}}
      @media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
      </style></head><body>${sections.join("")}</body></html>`;
  }

  return Object.freeze({ buildReport, renderHtml });
});
