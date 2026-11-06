(function (root) {
  "use strict";

  const text = value => value == null ? "" : String(value);
  const escape = value => text(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
  const number = value => {
    if (value == null || value === "" || typeof value === "boolean" || (typeof value === "string" && !value.trim())) return null;
    const result = Number(value);
    return Number.isFinite(result) ? result : null;
  };
  const money = value => value === null ? "-" : value.toLocaleString("en-US");
  const display = value => text(value).trim() || "-";
  const numericCell = value => ({ value: number(value), style: "integer" });
  const textCell = value => ({ value: text(value), style: "wrapped" });
  const header = labels => labels.map(value => ({ value, style: "header" }));
  const pricingLabels = {
    standard: "일반 / Thường", surcharge: "서차지 / Phụ thu", legacy: "기존 직접입력 / Giá cũ"
  };
  const gradeLabels = { STANDARD: "일반 / Tiêu chuẩn", VIP: "VIP" };
  const roomKindLabels = { SINGLE: "싱글 / Phòng đơn", DOUBLE: "더블 / Phòng đôi", TRIPLE: "트리플 / Phòng ba" };
  const mode = value => pricingLabels[value] || display(value);
  const grade = value => gradeLabels[value] || display(value);
  const rates = value => value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const roomItems = row => Array.isArray(row.room_items) ? row.room_items.filter(item => item && typeof item === "object") : [];
  const guests = value => Array.isArray(value) ? value.map(text).join("\n") : text(value);
  const received = row => {
    const deposit = number(row.deposit_amount);
    const balance = number(row.balance_amount);
    return deposit === null && balance === null ? null : (deposit ?? 0) + (balance ?? 0);
  };
  const roomName = item => roomKindLabels[item.room_kind] || text(item.name) || text(rates(item.rate_snapshot).name) || "룸타입명 없음 / Chưa có tên loại phòng";
  const roomGrade = item => item.grade_id ? display(item.room_grade) : grade(item.room_grade);
  const rowsOf = values => Array.isArray(values) ? values.filter(value => value && typeof value === "object") : [];
  function dateCell(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text(value));
    if (!match) return textCell(value);
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    if (date.getFullYear() !== Number(match[1]) || date.getMonth() + 1 !== Number(match[2]) || date.getDate() !== Number(match[3])) return textCell(value);
    return { value: date, style: "dateTime" };
  }
  function roomDescription(row) {
    const items = roomItems(row);
    return items.length ? items.map(item => `${roomName(item)} / ${roomGrade(item)} / ${money(number(item.room_count))} 객실·phòng`).join("\n")
      : "기존 요금 / Giá đã lưu";
  }

  function roomTable(row) {
    const items = roomItems(row);
    if (!items.length) {
      const saved = rates(row.rate_snapshot);
      return `<p class="legacy">기존 예약 저장 요금 / Giá đã lưu của đặt phòng cũ<br>
        주중 매입·매출 / Mua·bán ngày thường: ${money(number(saved.weekday_purchase))} / ${money(number(saved.weekday_sale))} VND<br>
        주말 매입·매출 / Mua·bán cuối tuần: ${money(number(saved.weekend_purchase))} / ${money(number(saved.weekend_sale))} VND</p>`;
    }
    return `<table class="rooms"><colgroup><col style="width:18%"><col style="width:11%"><col style="width:7%"><col style="width:10%"><col style="width:14%"><col style="width:14%"><col style="width:13%"><col style="width:13%"></colgroup>
      <thead><tr><th>룸타입<br>Loại phòng</th><th>등급<br>Hạng</th><th>객실<br>Phòng</th><th>주중·주말 박수<br>Đêm thường·cuối tuần</th><th>주중 매입·매출 단가<br>Giá mua·bán ngày thường</th><th>주말 매입·매출 단가<br>Giá mua·bán cuối tuần</th><th>객실 매입<br>Mua phòng</th><th>객실 매출<br>Bán phòng</th></tr></thead>
      <tbody>${items.map(item => {
        const saved = rates(item.rate_snapshot);
        return `<tr><td>${escape(roomName(item))}</td><td>${escape(roomGrade(item))}</td><td class="number">${money(number(item.room_count))}</td>
          <td class="number">${money(number(item.weekday_nights))} / ${money(number(item.weekend_nights))}</td>
          <td class="number">${money(number(saved.weekday_purchase))}<br>${money(number(saved.weekday_sale))}</td>
          <td class="number">${money(number(saved.weekend_purchase))}<br>${money(number(saved.weekend_sale))}</td>
          <td class="number">${money(number(item.room_purchase_amount))}</td><td class="number">${money(number(item.room_sale_amount))}</td></tr>`;
      }).join("")}</tbody></table><p class="hint">단가는 1객실·1박 기준이며, 저장된 예약 요금입니다. / Đơn giá mỗi phòng mỗi đêm theo dữ liệu đặt phòng đã lưu.</p>`;
  }

  function renderHtml(values) {
    const rows = rowsOf(values);
    const labelValue = (label, value) => `<div><dt>${label}</dt><dd>${escape(display(value))}</dd></div>`;
    const amountRow = (label, purchase, sale) => `<tr><th>${label}</th><td class="number">${money(number(purchase))}</td><td class="number">${money(number(sale))}</td></tr>`;
    const bookings = rows.map((row, index) => `<section class="reservation">
      <header class="bookingHeading"><h2>${index + 1}. ${escape(display(row.hotel_name))}</h2><p>예약번호 / Mã đặt phòng: ${escape(display(row.id))}</p></header>
      <dl class="info">${labelValue("체크인 / Nhận phòng", row.check_in)}${labelValue("체크아웃 / Trả phòng", row.check_out)}
      ${labelValue("인원·객실 / Khách·phòng", `${money(number(row.guest_count))}명 / khách · ${money(number(row.room_count))}객실 / phòng`)}
      ${labelValue("요금 방식 / Loại giá", mode(row.pricing_mode))}
      ${labelValue("주중·주말 박수 / Đêm thường·cuối tuần", `${money(number(row.weekday_nights))} / ${money(number(row.weekend_nights))}`)}
      ${labelValue("식사 / Bữa ăn", row.includes_meals === true ? "포함 / Có" : row.includes_meals === false ? "미포함 / Không" : "-")}</dl>
      <div class="guestBlock"><h3>투숙객 명단 / Danh sách khách</h3><p>${escape(display(guests(row.guest_names)))}</p></div>
      <h3>객실 상세 / Chi tiết phòng (VND)</h3>${roomTable(row)}
      <div class="bookingEnding"><div class="financial"><table><thead><tr><th>금액 / Số tiền (VND)</th><th>매입 / Mua</th><th>매출 / Bán</th></tr></thead><tbody>
      ${amountRow("객실 / Phòng", row.room_purchase_amount, row.room_sale_amount)}${amountRow("식사 / Bữa ăn", row.meal_purchase_amount, row.meal_sale_amount)}
      ${amountRow("총액 / Tổng cộng", row.purchase_amount, row.sale_amount)}</tbody></table>
      <table><tbody><tr><th>계약금 / Tiền cọc</th><td class="number">${money(number(row.deposit_amount))}</td></tr><tr><th>잔금 / Tiền còn lại đã thu</th><td class="number">${money(number(row.balance_amount))}</td></tr><tr class="received"><th>입금 합계 / Tổng đã thu</th><td class="number">${money(received(row))}</td></tr></tbody></table></div>
      <div class="note"><h3>비고 / Ghi chú</h3><p>${escape(display(row.note))}</p></div></div></section>`).join("");
    return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>호텔 예약 현황 / Danh sách đặt phòng</title><style>
      @page{size:A4 portrait;margin:12mm}*{box-sizing:border-box}body{margin:0;color:#261e17;background:#fff;font:11px/1.45 Arial,"Malgun Gothic",sans-serif}
      h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:0 0 5px}h3{font-size:11px;margin:10px 0 5px}.pageHeading{border-bottom:2px solid #684329;margin-bottom:18px;padding-bottom:10px}.pageHeading p{margin:4px 0}
      .reservation{padding-bottom:18px;margin-bottom:20px;border-bottom:1px dashed #a78c72}.reservation+.reservation{break-before:page;page-break-before:always}.bookingHeading{break-inside:avoid;page-break-inside:avoid}.bookingHeading p{margin:0;font-size:9px;overflow-wrap:anywhere}
      .info{display:grid;grid-template-columns:1fr 1fr;gap:9px 18px;margin:12px 0}.info div{break-inside:avoid;page-break-inside:avoid}dt{font-size:10px;color:#755a44}dd{margin:2px 0 0;font-weight:bold;white-space:pre-wrap;overflow-wrap:anywhere}
      .guestBlock p,.note p{white-space:pre-wrap;overflow-wrap:anywhere;margin:4px 0}.guestBlock{border:1px solid #dac9b9;padding:8px}.guestBlock h3{margin-top:0}
      table{border-collapse:collapse;width:100%;table-layout:fixed}th,td{border:1px solid #bfac99;padding:6px 5px;vertical-align:middle;overflow-wrap:anywhere}th{background:#f2e9dd;font-size:9px;font-weight:bold;text-align:left}thead{display:table-header-group}tr{break-inside:avoid;page-break-inside:avoid}.rooms{font-size:9px}.rooms th{font-size:8px}.number{text-align:right;font-variant-numeric:tabular-nums}
      .financial{display:grid;grid-template-columns:1.15fr 1fr;gap:12px;margin-top:14px}.financial th:first-child{width:45%}.financial td{font-weight:bold}.received{background:#fcf4e8}.bookingEnding{break-inside:avoid;page-break-inside:avoid}.note{border-top:1px solid #dac9b9;margin-top:12px;padding-top:2px}.hint,.legacy{font-size:9px;color:#655546}.hint{margin:5px 0}.empty{padding:24px;border:1px solid #dac9b9}
      @media screen{body{max-width:794px;margin:24px auto;padding:24px}}@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
      </style></head><body><header class="pageHeading"><h1>호텔 예약 현황</h1><p>Danh sách đặt phòng</p><p>전체 ${rows.length}건 / Tổng ${rows.length} đặt phòng · 금액 단위 / Đơn vị: VND</p>
      <p class="hint">저장된 예약 금액 기준입니다. 빈 금액은 '-'로 표시합니다. / Theo số tiền đã lưu; giá trị chưa nhập hiển thị '-'.</p></header>
      ${bookings || '<p class="empty">등록된 예약이 없습니다. / Chưa có đặt phòng.</p>'}</body></html>`;
  }

  function workbookOptions(values) {
    const rows = rowsOf(values);
    const labels = ["예약번호 / Mã đặt phòng", "호텔명 / Khách sạn", "체크인 / Nhận phòng", "체크아웃 / Trả phòng", "인원 / Số khách", "객실 수 / Số phòng", "투숙객 명단 / Danh sách khách", "룸타입·등급·객실 / Loại·hạng·số phòng", "요금 방식 / Loại giá", "주중 박수 / Đêm ngày thường", "주말 박수 / Đêm cuối tuần", "식사 포함 / Có bữa ăn", "객실 매입 / Mua phòng", "객실 매출 / Bán phòng", "식사 매입 / Mua bữa ăn", "식사 매출 / Bán bữa ăn", "총 매입 / Tổng mua", "총 매출 / Tổng bán", "계약금 / Tiền cọc", "잔금 / Tiền còn lại đã thu", "입금 합계 / Tổng đã thu", "비고 / Ghi chú"];
    const reservationRows = rows.map(row => [textCell(row.id), textCell(row.hotel_name), dateCell(row.check_in), dateCell(row.check_out), numericCell(row.guest_count), numericCell(row.room_count), textCell(guests(row.guest_names)), textCell(roomDescription(row)), textCell(mode(row.pricing_mode)), numericCell(row.weekday_nights), numericCell(row.weekend_nights), textCell(row.includes_meals === true ? "포함 / Có" : row.includes_meals === false ? "미포함 / Không" : ""),
      ...["room_purchase_amount", "room_sale_amount", "meal_purchase_amount", "meal_sale_amount", "purchase_amount", "sale_amount", "deposit_amount", "balance_amount"].map(key => numericCell(row[key])), numericCell(received(row)), textCell(row.note)]);
    const roomLabels = ["예약번호 / Mã đặt phòng", "호텔명 / Khách sạn", "룸타입 ID / Mã loại phòng", "룸타입명 / Tên loại phòng", "등급 / Hạng", "객실 수 / Số phòng", "주중 박수 / Đêm ngày thường", "주말 박수 / Đêm cuối tuần", "주중 매입 단가 / Giá mua ngày thường", "주중 매출 단가 / Giá bán ngày thường", "주말 매입 단가 / Giá mua cuối tuần", "주말 매출 단가 / Giá bán cuối tuần", "객실 매입 / Mua phòng", "객실 매출 / Bán phòng"];
    const detailRows = rows.flatMap(row => {
      const savedItems = roomItems(row);
      const items = savedItems.length ? savedItems : [{ ...row, name: "기존 요금 / Giá đã lưu", room_type_id: null, room_grade: null }];
      return items.map(item => {
        const saved = rates(item.rate_snapshot);
        return [textCell(row.id), textCell(row.hotel_name), textCell(item.room_type_id), textCell(roomName(item)), textCell(item.room_grade ? roomGrade(item) : ""), numericCell(item.room_count), numericCell(item.weekday_nights), numericCell(item.weekend_nights),
          ...["weekday_purchase", "weekday_sale", "weekend_purchase", "weekend_sale"].map(key => numericCell(saved[key])), numericCell(item.room_purchase_amount), numericCell(item.room_sale_amount)];
      });
    });
    return {
      filename: "hotel-reservations.xlsx",
      sheets: [
        { name: "호텔 예약", freezeRows: 4, columnWidths: [38, 24, 21, 21, 12, 12, 36, 48, 24, 17, 17, 18, 22, 22, 22, 22, 22, 22, 22, 22, 22, 40],
          rows: [[{ value: "호텔 예약 현황 / Danh sách đặt phòng", style: "title" }], [textCell(`전체 ${rows.length}건 / Tổng ${rows.length} đặt phòng · VND`)], [textCell("저장된 예약 금액 기준 / Theo số tiền đã lưu. 빈 금액은 미입력 / Ô trống: chưa nhập.")], header(labels), ...reservationRows],
          merges: ["A1:V1", "A2:V2", "A3:V3"], autoFilterRange: `A4:V${Math.max(4, reservationRows.length + 4)}` },
        { name: "룸타입 저장 요금", freezeRows: 4, columnWidths: [38, 24, 38, 25, 20, 12, 18, 18, 24, 24, 24, 24, 22, 22],
          rows: [[{ value: "룸타입 저장 요금 / Giá loại phòng đã lưu", style: "title" }], [textCell("단가: VND / 1객실·1박 / Giá VND mỗi phòng mỗi đêm")], [textCell("예약에 저장된 스냅샷 기준. 현재 호텔 요금으로 다시 계산하지 않습니다. / Theo giá đã lưu, không tính lại theo giá hiện tại.")], header(roomLabels), ...detailRows],
          merges: ["A1:N1", "A2:N2", "A3:N3"], autoFilterRange: `A4:N${Math.max(4, detailRows.length + 4)}` }
      ]
    };
  }

  root.HotelReport = Object.freeze({ renderHtml, workbookOptions });
})(typeof window === "object" ? window : globalThis);
