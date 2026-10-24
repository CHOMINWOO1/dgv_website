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
assert.match(page, /assets\/golf-reserv-list\.js\?v=20261024-edit-link-1/);
assert.match(page, /id="reservationTableBody"/);
assert.match(page, /colspan="25"/);
assert.match(page, /min-width:2860px/);
assert.match(page, /overflow:auto/);
assert.match(page, /position:sticky;top:0/);
for (const label of [
  "상태", "골프 날짜", "티오프", "예약자 대표", "거래처", "전체 이름\\(영어\\)", "인원",
  "골프장", "홀", "S-CART", "1인 판매가", "고객 합계",
  "1인 원가", "골프장 합계", "예약금", "예약금 일자", "최종 입금", "최종 입금일",
  "출금액", "출금일", "실제 수익", "비고", "최종 수정"
]) assert.match(page, new RegExp(label));

assert.match(source, /QRStaff\.requireLogin\(\{ roles: \["manager", "admin"\]/);
assert.match(source, /DGV\.collectSupabasePages/);
assert.match(source, /sb\.from\("golf_reservations"\)\.select\(COLUMNS\)/);
assert.match(source, /pageSize: 500/);
assert.match(source, /row\.counterparty_name[\s\S]*row\.representative_name[\s\S]*row\.player_names_en/);
assert.match(source, /status !== "all"/);
assert.match(source, /row\.golf_date < from/);
assert.match(source, /row\.golf_date > to/);
assert.match(source, /rows\.map\(renderRow\)/);
assert.ok(source.includes('const editHref = `golf_reserv.html?edit=${encodeURIComponent(String(row.id || ""))}`;'));
assert.ok(source.includes('<a class="golf-edit-link" href="${escape(editHref)}">'));
assert.match(source, /event\.target\.closest\("a, button, input, select, textarea"\)/);
assert.doesNotMatch(page, /id="homeLink"/);
assert.doesNotMatch(source, /byId\("homeLink"\)/);
assert.match(source, /DGV\.escapeHTML/);
assert.match(source, /dateTimeLabel\(row\.created_at\)/);
assert.match(source, /golfDateLabel\(row\.golf_date\)/);
assert.match(source, /Date\.UTC\(Number\(match\[1\]\), Number\(match\[2\]\) - 1, Number\(match\[3\]\)\)/);
assert.match(source, /sheet\.scrollLeft = drag\.scrollLeft - \(event\.clientX - drag\.x\)/);
assert.match(source, /sheet\.setPointerCapture\(event\.pointerId\)/);
assert.doesNotMatch(source, /coordinator_name/);
assert.doesNotMatch(page, /담당자|Phụ trách/);
assert.match(page, /실제 수익[\s\S]*구분[\s\S]*등록 일시[\s\S]*비고[\s\S]*최종 수정/);
assert.match(source, /moneyLabel\(actualProfit\(row\)\)[\s\S]*customerType[\s\S]*dateTimeLabel\(row\.created_at\)[\s\S]*note/);
assert.doesNotMatch(source, /\.insert\(|\.update\(|\.delete\(/, "one-line page must remain read-only");
assert.match(editor, /href="golf_reserv_list\.html"/);
assert.match(adminHome, /href="golf_reserv_list\.html"/);
assert.doesNotMatch(managerHome, /href="golf_reserv_list\.html"/);

console.log("Golf reservation one-row list, filters, auth, read-only data access, and navigation verified.");
