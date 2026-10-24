import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFile(path.join(projectRoot, file), "utf8");
const [page, source, migration, editorPage, editorSource, listPage, listSource, adminHome, managerHome] = await Promise.all([
  read("golf_budget.html"),
  read("assets/golf-budget.js"),
  read("supabase/migrations/20261024143000_golf_course_budget_transition_ledger.sql"),
  read("golf_reserv.html"),
  read("assets/golf-reserv.js"),
  read("golf_reserv_list.html"),
  read("assets/golf-reserv-list.js"),
  read("home_admin.html"),
  read("home_manager.html"),
]);

// Administrator-only budget UI and course-specific deduction detail.
assert.match(page, /assets\/golf-budget\.js\?v=20261024-2/);
assert.match(page, /골프장별 현재 잔액 \/ Số dư theo sân/);
assert.match(page, /id="chargeFilters"/);
for (const course of ["AT1200", "SAM", "PALACE"]) {
  assert.match(page, new RegExp(`data-charge-course="${course}"`));
}
assert.match(page, /상태[\s\S]*예산 차감 일시[\s\S]*복원 일시[\s\S]*골프 날짜[\s\S]*거래처[\s\S]*예약자 대표[\s\S]*골프장 원가·차감액/);
assert.match(source, /QRStaff\.requireLogin\(\{ roles: \["admin"\]/);
assert.match(source, /data-show-charge-course/);
assert.match(source, /state\.chargeCourse === "all"[\s\S]*charge\.golf_course === state\.chargeCourse/);
assert.match(source, /dateTimeLabel\(charge\.charged_at\)/);
assert.match(source, /dateTimeLabel\(charge\.reversed_at\)/);
assert.match(source, /dateLabel\(charge\.golf_date\)/);
assert.match(source, /reservation\.counterparty_name/);
assert.match(source, /reservation\.representative_name/);
assert.match(source, /moneyLabel\(charge\.amount_vnd\)/);
assert.match(source, /charge\.historical[\s\S]*기존 완료·차감/);

// Balance only uses opening snapshot + manual course top-ups - active reservation charges.
assert.match(source, /return opening \+ depositTotal\(course\) - chargeTotal\(course\)/);
assert.match(source, /from\("golf_course_budget_accounts"\)/);
assert.match(source, /from\("golf_course_budget_deposits"\)/);
assert.match(source, /from\("golf_course_budget_reservation_charges"\)/);
assert.doesNotMatch(source, /golf_reservation_payments/);
assert.doesNotMatch(source, /from\("golf_reservations"\)[\s\S]*status[\s\S]*completed/);
assert.doesNotMatch(source, /from\("golf_course_budget_reservation_charges"\)\s*\.(?:insert|update|delete)/);
assert.match(source, /paymentMethod === "cash" && amountVnd >= CASH_BANK_THRESHOLD/);
assert.match(source, /5,000,000 VND 이상은 은행 거래가 필요합니다[\s\S]*Giao dịch từ 5\.000\.000 VND/);
assert.match(source, /\.update\(\{ opening_balance_vnd: amount \}\)/);
assert.doesNotMatch(source, /\.update\(\{[^}]*balance_as_of/);

// Original golf-course cost remains visible and is used for receivables/profit and exports.
assert.match(editorPage, /1인 골프장 원가/);
assert.match(editorSource, /course_total_vnd/);
assert.match(editorSource, /rowTotals\.received[\s\S]*Number\(row\.course_total_vnd\)/);
assert.match(listPage, /1인 원가[\s\S]*골프장 합계/);
assert.match(listSource, /integerCell\(row\.course_unit_price_vnd\), integerCell\(row\.course_total_vnd\)/);
assert.match(listSource, /Number\(row\.final_received_amount_vnd \|\| 0\) - Number\(row\.course_total_vnd\)/);
assert.doesNotMatch(editorPage, /data-add-payment="withdrawal"|id="withdrawalPayments"|출금 추가/);
assert.doesNotMatch(listPage, /골프장 총출금|출금 수단/);

// Existing legacy withdrawal rows stay in the save payload although the UI no longer exposes them.
assert.match(editorSource, /for \(const kind of \["deposit", "receipt", "withdrawal"\]\)/);
assert.match(editorSource, /state\.paymentDrafts = \{ deposit: \[\], receipt: \[\], withdrawal: \[\] \}/);

// Database tables, transition-only ledger behavior, security and seed snapshots.
assert.match(migration, /create table public\.golf_course_budget_accounts/);
assert.match(migration, /create table public\.golf_course_budget_deposits/);
assert.match(migration, /create table public\.golf_course_budget_reservation_charges/);
assert.match(migration, /reservation_id uuid primary key[\s\S]*references public\.golf_reservations \(id\) on delete cascade/);
assert.match(migration, /charged_at timestamp with time zone not null default now\(\)/);
assert.match(migration, /active boolean not null default true/);
assert.match(migration, /historical boolean not null default false/);
assert.match(migration, /reversed_at timestamp with time zone/);
assert.match(migration, /old\.status <> 'completed' and new\.status = 'completed'[\s\S]*insert into public\.golf_course_budget_reservation_charges/);
assert.match(migration, /old\.status = 'completed' and new\.status <> 'completed'[\s\S]*active = false[\s\S]*reversed_at = now\(\)/);
assert.match(migration, /new\.status = 'completed' and v_has_charge[\s\S]*update public\.golf_course_budget_reservation_charges/);
assert.match(migration, /active = true[\s\S]*reversed_at = null/);
assert.match(migration, /desired\.current_balance_vnd \+ coalesce\(historical\.amount_vnd, 0\)/);
assert.match(migration, /insert into public\.golf_course_budget_reservation_charges[\s\S]*reservation\.course_total_vnd[\s\S]*reservation\.final_received_date::timestamp at time zone 'Asia\/Ho_Chi_Minh'[\s\S]*where reservation\.status = 'completed'/i);
assert.match(migration, /amount_vnd is null or amount_vnd between 0 and 9007199254740991/);
assert.doesNotMatch(migration, /golf_reservation_payments/);
assert.match(migration, /new\.deposit_date < v_balance_as_of/);
assert.match(migration, /grant update \(opening_balance_vnd\)[\s\S]*golf_course_budget_accounts to authenticated/);
assert.doesNotMatch(migration, /grant update \([^)]*balance_as_of/);
assert.match(migration, /alter table public\.golf_course_budget_accounts enable row level security/);
assert.match(migration, /alter table public\.golf_course_budget_deposits enable row level security/);
assert.match(migration, /alter table public\.golf_course_budget_reservation_charges enable row level security/);
assert.match(migration, /golf_course_budget_reservation_charges_admin_read/);
assert.match(migration, /security definer[\s\S]*set search_path = ''/);
assert.match(migration, /revoke all on function private\.sync_golf_course_budget_reservation_charge\(\)[\s\S]*from public, anon, authenticated, service_role/);
assert.match(migration, /\('AT1200'::text, 77500000::bigint\)/);
assert.match(migration, /\('SAM'::text, 220000000::bigint\)/);
assert.match(migration, /\('PALACE'::text, 0::bigint\)/);

assert.match(adminHome, /href="golf_budget\.html"/);
assert.doesNotMatch(managerHome, /href="golf_budget\.html"/);

console.log("Golf-course budget balance, transition ledger, course detail, security, and legacy preservation verified.");
