import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
assert.match(page, /assets\/golf-reserv-list\.js\?v=20261024-budget-1/);
assert.match(page, /id="reservationTableBody"/);
assert.match(page, /<script src="assets\/dgv-xlsx\.js"><\/script>/);
assert.match(page, /id="printListButton"[^>]*>출력 \/ In<\/button>/);
assert.match(page, /id="exportListButton"[^>]*>엑셀 생성 \/ Tạo Excel<\/button>/);
assert.match(page, /id="golfPrintCriteria"/);
assert.match(page, /@page\{size:A3 landscape/);
assert.match(page, /body\s*>\s*\.golf-list-app\{display:block!important\}/);
assert.match(page, /colspan="23"/);
assert.match(page, /min-width:2500px/);
assert.match(page, /overflow:auto/);
assert.match(page, /position:sticky;top:0/);
for (const label of [
  "상태", "골프 날짜", "티오프", "거래처", "예약자 대표", "전체 이름\\(영어\\)", "인원",
  "골프장", "홀", "S-CART", "1인 판매가", "고객 합계",
  "1인 원가", "골프장 합계", "계약금 합계", "계약금 수단", "고객 총입금", "입금 수단",
  "실제 수익", "비고", "최종 수정"
]) assert.match(page, new RegExp(label));
assert.doesNotMatch(page, /골프장 총출금|출금 수단|Tổng chi sân golf|Phương thức chi/);
assert.match(page, /<thead>[\s\S]*티오프[\s\S]*거래처[\s\S]*예약자 대표[\s\S]*전체 이름\(영어\)[\s\S]*<\/thead>/);
assert.match(page, /행을 한 번 클릭하면 전체 예약자 명단과 고객 입금 상세가 펼쳐집니다/);
assert.match(page, /\.golf-sheet \.golf-roster-detail td\{height:auto;padding:0/);
assert.match(page, /\.golf-roster-names\{display:flex;flex-wrap:wrap/);
assert.match(page, /\.golf-expanded-grid\{display:grid/);
assert.match(page, /\.golf-payment-detail-list\{display:flex;flex-wrap:wrap/);

assert.match(source, /QRStaff\.requireLogin\(\{ roles: \["manager", "admin"\]/);
assert.match(source, /DGV\.collectSupabasePages/);
assert.match(source, /sb\.from\("golf_reservations"\)\.select\(COLUMNS\)/);
assert.match(source, /sb\.from\("golf_reservation_payments"\)\.select\(PAYMENT_COLUMNS\)/);
assert.match(source, /paymentsByReservation/);
assert.match(source, /pageSize: 500/);
assert.match(source, /row\.counterparty_name[\s\S]*row\.representative_name[\s\S]*row\.player_names_en/);
assert.match(source, /status !== "all"/);
assert.match(source, /row\.golf_date < from/);
assert.match(source, /row\.golf_date > to/);
assert.match(source, /rows\.map\(renderRow\)/);
assert.match(source, /function printList\(\)[\s\S]*const rows = filteredRows\(\)[\s\S]*global\.print\(\)/);
assert.match(source, /function exportList\(\)[\s\S]*const rows = filteredRows\(\)[\s\S]*DGV_XLSX\.downloadWorkbook\(workbookOptions\(rows\)\)/);
assert.match(source, /HANA_Golf_Reservations_[\s\S]*\.xlsx/);
assert.match(source, /merges: \["A1:W1"\]/);
assert.match(source, /autoFilterRange:[\s\S]*A5:W/);
assert.match(source, /integerCell\(row\.guest_total_vnd\)/);
assert.match(source, /name: "입금 내역"/);
assert.match(source, /transactionHeaders/);
assert.match(source, /paymentMethodLabel\(payment\.payment_method\)/);
assert.match(source, /계약금 합계\(VND\) \/ Tổng tiền cọc/);
assert.match(source, /고객 총입금\(VND\) \/ Tổng tiền khách đã trả/);
assert.doesNotMatch(source, /골프장 총출금|출금 상세|withdrawal/);
assert.match(source, /row\.course_total_vnd == null/);
assert.match(source, /Number\(row\.final_received_amount_vnd \|\| 0\) - Number\(row\.course_total_vnd\)/);
assert.match(source, /textCell\(row\.player_names_en, "wrapped"\)/);
assert.match(source, /byId\("printListButton"\)\.addEventListener\("click", printList\)/);
assert.match(source, /byId\("exportListButton"\)\.addEventListener\("click", exportList\)/);
assert.match(source, /timeLabel\(row\.golf_time\)[\s\S]*row\.counterparty_name[\s\S]*class="golf-edit-link"[\s\S]*class="golf-cell-names"/);
assert.match(source, /event\.target\.closest\("tr\[data-status\]"\)/);
assert.match(source, /class="golf-roster-detail"[\s\S]*colspan="23"/);
assert.match(source, /class="golf-roster-name"/);
assert.match(source, /row\.nextElementSibling/);
assert.match(source, /detailRow\?\.classList\.contains\("golf-roster-detail"\)/);
assert.match(source, /detailRow\.hidden = !expanded/);
assert.match(source, /detailRow\.setAttribute\("aria-hidden", String\(!expanded\)\)/);
assert.match(source, /classList\.toggle\("is-names-expanded", expanded\)/);
assert.match(source, /row\.setAttribute\("aria-expanded", String\(expanded\)\)/);
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
assert.match(page, /예약자 대표를 더블클릭하면 수정할 수 있습니다/);
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
assert.match(source, /고객 입금 상세 \/ Chi tiết khoản thu/);
assert.match(source, /은행 \/ Chuyển khoản/);
assert.match(source, /현금 \/ Tiền mặt/);
assert.match(source, /카드 \/ Thẻ/);
assert.match(page, /golf-cell-payments/);
assert.match(source, /\.in\("payment_kind", \["deposit", "receipt"\]\)/);
assert.doesNotMatch(source, /\.insert\(|\.update\(|\.delete\(/, "one-line page must remain read-only");
assert.match(editor, /href="golf_reserv_list\.html"/);
assert.match(adminHome, /href="golf_reserv_list\.html"/);
assert.doesNotMatch(managerHome, /href="golf_reserv_list\.html"/);

console.log("Golf reservation one-row list, filters, auth, read-only data access, and navigation verified.");
