import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFile(path.join(projectRoot, file), "utf8");
const [page, source, editor, adminHome, managerHome] = await Promise.all([
  read("golf_reserv_list.html"),
  read("assets/golf-reserv-list.js"),
  read("golf_reserv.html"),
  read("home_admin.html"),
  read("home_manager.html"),
]);

assert.match(page, /<table class="golf-sheet">/);
assert.match(page, /assets\/golf-reserv-list\.js\?v=20261025-compact-1/);
assert.match(page, /티업 시작일 \/ Từ ngày chơi/);
assert.match(page, /티업 종료일 \/ Đến ngày chơi/);
assert.match(page, /id="reservationTableBody"/);
assert.match(page, /<script src="assets\/dgv-xlsx\.js"><\/script>/);
assert.match(page, /id="printListButton"[^>]*>출력 \/ In<\/button>/);
assert.match(page, /id="exportListButton"[^>]*>엑셀 생성 \/ Tạo Excel<\/button>/);
assert.match(page, /href="golf_reserv\.html"[^>]*>예약 입력·수정 \/ Quản lý<\/a>/);
assert.match(page, /href="golf_budget\.html"[^>]*>골프장 예산 \/ Ngân sách<\/a>/);
const headerMarkup = page.match(/<header class="qr-header">[\s\S]*?<\/header>/)?.[0] || "";
assert.doesNotMatch(headerMarkup, /id="printListButton"|id="exportListButton"/);
assert.ok(page.indexOf('id="listTitle"') < page.indexOf('id="printListButton"'));
assert.ok(page.indexOf('id="printListButton"') < page.indexOf('id="exportListButton"'));
assert.ok(page.indexOf('id="exportListButton"') < page.indexOf('class="golf-list-tools"'));
assert.match(page, /\.golf-list-title-actions\{display:flex;flex-wrap:wrap/);
assert.match(page, /id="golfPrintCriteria"/);
assert.match(page, /@page\{size:A3 landscape/);
assert.match(page, /body\s*>\s*\.golf-list-app\{display:block!important\}/);
assert.match(page, /colspan="25"/);
assert.match(page, /min-width:100%/);
assert.match(page, /overflow:auto/);
assert.match(page, /position:sticky;top:0/);
for (const label of [
  "상태", "골프 날짜", "티오프", "거래처", "예약자 대표", "전체 이름\\(영어\\)", "인원",
  "골프장", "홀", "S-CART", "1인 판매가", "고객 합계",
  "1인 원가", "골프장 합계", "원가 정산 방식", "정산 거래처",
  "계약금 합계", "계약금 수단", "고객 총입금", "입금 수단",
  "실제 수익", "비고", "최종 수정"
]) assert.match(page, new RegExp(label));
assert.doesNotMatch(page, /골프장 총출금|출금 수단|Tổng chi sân golf|Phương thức chi/);
assert.match(page, /<thead>[\s\S]*티오프[\s\S]*거래처[\s\S]*예약자 대표[\s\S]*전체 이름\(영어\)[\s\S]*<\/thead>/);
assert.match(page, /행 또는 상세보기 버튼을 누르면 예약 정보와 입금 내역을 별도 창에서 확인/);
assert.match(page, /<dialog[^>]+id="reservationDetailDialog"/);
assert.match(page, /\.golf-sheet \.golf-screen-hidden\{display:none\}/);
assert.match(page, /\.golf-sheet \.golf-screen-hidden\{display:table-cell!important\}/);
assert.match(page, /\.golf-roster-names\{display:flex;flex-wrap:wrap/);
assert.match(page, /\.golf-expanded-grid\{display:grid/);
assert.match(page, /\.golf-payment-detail-list\{display:flex;flex-wrap:wrap/);

assert.match(source, /QRStaff\.requireLogin\(\{ roles: \["manager", "admin"\]/);
assert.match(source, /DGV\.collectSupabasePages/);
assert.match(source, /sb\.from\("golf_reservations"\)\.select\(COLUMNS\)/);
assert.match(source, /"cost_settlement_type", "cost_partner_name"/);
assert.match(source, /sb\.from\("golf_reservation_payments"\)\.select\(PAYMENT_COLUMNS\)/);
assert.match(source, /paymentsByReservation/);
assert.match(source, /pageSize: 500/);
assert.match(source, /row\.counterparty_name[\s\S]*row\.representative_name[\s\S]*row\.player_names_en/);
assert.match(source, /status !== "all"/);
assert.match(source, /row\.golf_date < from/);
assert.match(source, /row\.golf_date > to/);
assert.match(source, /state\.rows = reservations\.map\([\s\S]*\.sort\(\(a, b\) =>[\s\S]*a\.golf_date[\s\S]*b\.golf_date/);
assert.match(source, /rows\.map\(renderRow\)/);
assert.match(source, /function printList\(\)[\s\S]*const rows = filteredRows\(\)[\s\S]*global\.print\(\)/);
assert.match(source, /function exportList\(\)[\s\S]*const rows = filteredRows\(\)[\s\S]*DGV_XLSX\.downloadWorkbook\(workbookOptions\(rows\)\)/);
assert.match(source, /HANA_Golf_Reservations_[\s\S]*\.xlsx/);
assert.match(source, /merges: \["A1:Y1"\]/);
assert.match(source, /autoFilterRange:[\s\S]*A5:Y/);
assert.match(source, /integerCell\(row\.guest_total_vnd\)/);
assert.match(source, /name: "입금 내역"/);
assert.match(source, /transactionHeaders/);
assert.match(source, /paymentMethodLabel\(payment\.payment_method\)/);
assert.match(source, /계약금 합계\(VND\) \/ Tổng tiền cọc/);
assert.match(source, /고객 총입금\(VND\) \/ Tổng tiền khách đã trả/);
assert.match(source, /원가 정산 방식 \/ Phương thức quyết toán/);
assert.match(source, /정산 거래처 \/ Đối tác quyết toán/);
assert.match(source, /거래처 보유분 \/ Suất của đối tác/);
assert.match(source, /골프장 직접 \/ Sân golf trực tiếp/);
assert.match(source, /textCell\(costSettlementTypeLabel\(row\)\), textCell\(costSettlementPartnerLabel\(row\)\)/);
assert.doesNotMatch(source, /골프장 총출금|출금 상세|withdrawal/);
assert.match(source, /row\.course_total_vnd == null/);
assert.match(source, /Number\(row\.final_received_amount_vnd \|\| 0\) - Number\(row\.course_total_vnd\)/);
assert.match(source, /textCell\(row\.player_names_en, "wrapped"\)/);
assert.match(source, /byId\("printListButton"\)\.addEventListener\("click", printList\)/);
assert.match(source, /byId\("exportListButton"\)\.addEventListener\("click", exportList\)/);
assert.match(source, /golfDateLabel\(row\.golf_date\)[\s\S]*timeLabel\(row\.golf_time\)[\s\S]*row\.counterparty_name[\s\S]*class="golf-edit-link"[\s\S]*escape\(representative\)[\s\S]*class="golf-cell-names"/);
assert.match(source, /event\.target\.closest\("tr\[data-reservation-id\]"\)/);
assert.match(source, /function reservationDetailMarkup\(row\)/);
assert.match(source, /class="golf-roster-name"/);
assert.match(source, /dialog\.showModal\(\)/);
assert.match(source, /byId\("reservationDetailContent"\)\.innerHTML = reservationDetailMarkup\(row\)/);
assert.doesNotMatch(source, /class="golf-roster-detail"|row\.nextElementSibling/);
assert.match(source, /Math\.abs\(deltaX\) <= 5/);
assert.match(source, /if \(!drag\.moved\) \{[\s\S]*sheet\.setPointerCapture\(event\.pointerId\)/);
assert.match(source, /sheet\.releasePointerCapture\(event\.pointerId\)/);
assert.match(source, /suppressRowClickUntil = Date\.now\(\) \+ 250/);
assert.ok(source.includes('const editHref = `golf_reserv.html?edit=${encodeURIComponent(String(row.id || ""))}`;'));
assert.ok(source.includes('<button class="golf-edit-link" type="button" data-edit-href="${escape(editHref)}"'));
assert.doesNotMatch(source, /<a class="golf-edit-link"/);
assert.match(source, /event\.target\.closest\("a, button, input, select, textarea"\)/);
assert.match(source, /tableBody\.addEventListener\("dblclick"/);
assert.match(source, /event\.detail === 0/);
assert.match(source, /이 예약을 수정하시겠습니까\?\\nBạn có muốn chỉnh sửa đặt sân này không\?/);
assert.match(source, /if \(!global\.confirm\([\s\S]*\)\) return;[\s\S]*global\.location\.assign\(href\)/);
assert.match(page, /예약자 대표 이름은 더블클릭하면 확인 후 수정 화면으로 이동/);
assert.match(page, /\.golf-list-app\{[^}]*font-size:16px;font-weight:750\}/);
assert.match(page, /\.golf-list-app \.qr-label\{font-size:13px;font-weight:1000\}/);
assert.match(page, /\.golf-sheet\{[^}]*font-size:14px\}/);
assert.match(page, /\.golf-sheet td\{font-weight:800\}/);
assert.match(page, /height:47px;padding:9px 11px/);
assert.doesNotMatch(page, /id="homeLink"/);
assert.doesNotMatch(source, /byId\("homeLink"\)/);
assert.match(source, /DGV\.escapeHTML/);
assert.match(source, /dateTimeLabel\(row\.created_at\)/);
assert.match(source, /golfDateLabel\(row\.golf_date\)/);
assert.match(source, /Date\.UTC\(Number\(match\[1\]\), Number\(match\[2\]\) - 1, Number\(match\[3\]\)\)/);
assert.match(source, /sheet\.scrollLeft = drag\.scrollLeft - deltaX/);
assert.match(source, /sheet\.setPointerCapture\(event\.pointerId\)/);
assert.doesNotMatch(source, /coordinator_name/);
assert.doesNotMatch(page, /담당자|Phụ trách/);
assert.match(page, /실제 수익[\s\S]*구분[\s\S]*등록 일시[\s\S]*비고[\s\S]*최종 수정/);
assert.match(source, /moneyLabel\(actualProfit\(row\)\)[\s\S]*customerType[\s\S]*dateTimeLabel\(row\.created_at\)[\s\S]*note/);
assert.match(source, /function paymentDetailText\(row, kinds\)/);
assert.match(source, /function paymentMethodSummary\(row, kinds\)/);
assert.match(source, /function paymentDetailMarkup\(row\)/);
assert.match(source, /입금 건별 내역 \/ Chi tiết từng khoản thu/);
assert.match(source, /은행 \/ Chuyển khoản/);
assert.match(source, /현금 \/ Tiền mặt/);
assert.match(source, /카드 \/ Thẻ/);
assert.match(page, /golf-cell-payments/);
assert.match(source, /\.in\("payment_kind", \["deposit", "receipt"\]\)/);
assert.doesNotMatch(source, /\.insert\(|\.update\(|\.delete\(/, "one-line page must remain read-only");
assert.match(editor, /href="golf_reserv_list\.html"/);
assert.match(adminHome, /href="golf_reserv_list\.html"/);
assert.doesNotMatch(managerHome, /href="golf_reserv_list\.html"/);

// Exercise real render/export functions without starting login or DB access.
const escapeHTML = (value) => String(value).replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[character]));
const testWindow = { DGV: { supabase: {}, escapeHTML }, QRStaff: {} };
const testDocument = { getElementById: (id) => ({ value: id === "statusFilter" ? "all" : "" }) };
assert.match(source, /\n  init\(\);\s*}\)\(window\);/);
vm.runInNewContext(source.replace(/\n  init\(\);/, "\n  global.__listTest = { renderRow, workbookOptions };"),
  { window: testWindow, document: testDocument, console }, { filename: "golf-reserv-list.js" });
const fixture = { id: "cart-test", status: "in_progress", golf_date: "2026-10-25", golf_time: "09:00:00",
  golf_course: "SAM", holes: 18, pax: 2, player_names_en: "A,B", payments: [] };
for (const value of ["400,000 VND", "1,200,000 VND", null, '<img src=x onerror="alert(1)">']) {
  const row = { ...fixture, smart_cart_note: value };
  const markup = testWindow.__listTest.renderRow(row);
  const cells = [...markup.slice(0, markup.indexOf("</tr>")).matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)];
  assert.equal(cells[9][1], escapeHTML(value ?? "—"), "S-CART must preserve commas and escape HTML");
  assert.ok(cells[9][0].includes(`title="${escapeHTML(value ?? "—")}"`), "S-CART tooltip must retain original text");
  assert.match(cells[5][1], /class="golf-screen-text">A \/ B<\/span>/, "Screen player-name separators must remain unchanged");
  assert.match(cells[5][1], /class="golf-print-text">A,B<\/span>/, "Printed roster retains full original text");
  assert.doesNotMatch(markup, /<img\b|<script\b/i);
  const workbook = testWindow.__listTest.workbookOptions([row]);
  assert.equal(workbook.sheets[0].rows[5][9].value, value ?? "", "Excel must retain the original S-CART text");
}

console.log("Golf reservation one-row list, S-CART rendering/export, filters, auth, read-only data access, and navigation verified.");
