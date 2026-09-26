import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFile(path.join(projectRoot, file), "utf8");

const [foundation, checkoutMigration, migration, inboxHtml, inboxSource, staffCss] = await Promise.all([
  read("supabase/migrations/20260926110000_qr_table_ordering.sql"),
  read("supabase/migrations/20260926165000_qr_inbox_staff_card_fee.sql"),
  read("supabase/migrations/20260926172000_qr_inbox_order_edit.sql"),
  read("order_inbox.html"),
  read("assets/order-inbox.js"),
  read("assets/qr-staff.css"),
]);

assert.ok(
  "20260926172000_qr_inbox_order_edit.sql" > "20260926171000_qr_guest_open_orders.sql",
  "staff editing must be installed after the guest open-order polling contract",
);

const editHelper = migration.match(
  /create function private\.app_update_qr_order_impl\([\s\S]*?\n\$\$;/i,
)?.[0];
assert.ok(editHelper, "private QR order-edit helper is missing");
assert.match(
  editHelper,
  /security definer[\s\S]*?set search_path = ''[\s\S]*?\(select auth\.uid\(\)\) is null[\s\S]*?v_role not in \('staff', 'admin'\)/i,
);
assert.match(
  editHelper,
  /jsonb_typeof\(p_items\) <> 'array'[\s\S]*?jsonb_array_length\(p_items\) not between 1 and 40/i,
);
assert.match(
  editHelper,
  /entry\.item - 'menu_item_id' - 'qty' <> '\{\}'::jsonb[\s\S]*?jsonb_typeof\(entry\.item -> 'menu_item_id'\) <> 'string'[\s\S]*?jsonb_typeof\(entry\.item -> 'qty'\) <> 'number'/i,
);
assert.match(editHelper, /duplicate menu items are not allowed/i);
assert.match(editHelper, /v_total_qty > 100/i);
assert.match(editHelper, /length\(p_note\) > 500[\s\S]*?p_note ~ '\[\[:cntrl:\]\]'/i);

assert.match(
  editHelper,
  /from public\.qr_orders as qr_order[\s\S]*?where qr_order\.id = p_order_id[\s\S]*?for update[\s\S]*?v_order\.updated_at is distinct from p_expected_updated_at[\s\S]*?errcode = '55000'[\s\S]*?v_order\.status not in \('submitted', 'accepted'\)[\s\S]*?v_order\.finalized_order_id is not null/i,
  "the order row must be locked and revalidated before any replacement",
);
assert.match(
  editHelper,
  /from public\.menu_items as menu[\s\S]*?order by menu\.id[\s\S]*?for share of menu/i,
  "referenced menu prices must be locked for a stable server-authoritative snapshot",
);
assert.match(
  editHelper,
  /where old_line\.id is null[\s\S]*?menu\.archived_at is not null[\s\S]*?menu\.is_active is distinct from true[\s\S]*?menu\.is_orderable is distinct from true[\s\S]*?menu\.is_sold_out is distinct from false[\s\S]*?menu\.requires_preorder is distinct from false/i,
  "new lines must be available, while an existing captured line remains editable",
);
for (const field of ["menu_type", "ko_name", "vi_name", "en_name", "unit_usd", "unit_vnd"]) {
  assert.match(
    editHelper,
    new RegExp(`case when old_line\\.id is not null then old_line\\.${field} else menu\\.`, "i"),
    `existing ${field} snapshot must win over the live menu row`,
  );
}
assert.match(
  editHelper,
  /jsonb_agg[\s\S]*?'line_usd'[\s\S]*?'line_vnd'[\s\S]*?sum\(snapshots\.qty::bigint \* snapshots\.unit_usd::bigint\)[\s\S]*?sum\(snapshots\.qty::bigint \* snapshots\.unit_vnd::bigint\)/i,
);
assert.match(
  editHelper,
  /delete from public\.qr_order_items[\s\S]*?insert into public\.qr_order_items[\s\S]*?update public\.qr_orders[\s\S]*?note = v_note[\s\S]*?total_usd = v_total_usd::integer[\s\S]*?total_vnd = v_total_vnd::integer[\s\S]*?updated_at = now\(\)/i,
  "line replacement and authoritative total update must share one RPC transaction",
);
assert.doesNotMatch(
  editHelper,
  /set[\s\S]{0,180}(?:request_hash|client_request_id)\s*=/i,
  "editing must not rewrite the guest idempotency identity",
);

assert.match(
  migration,
  /create function public\.app_update_qr_order\([\s\S]*?p_expected_updated_at timestamp with time zone[\s\S]*?security invoker[\s\S]*?select private\.app_update_qr_order_impl\([\s\S]*?p_order_id,[\s\S]*?p_expected_updated_at,[\s\S]*?p_note,[\s\S]*?p_items/i,
);
for (const signature of [
  "private\\.app_update_qr_order_impl\\(uuid, timestamp with time zone, text, jsonb\\)",
  "public\\.app_update_qr_order\\(uuid, timestamp with time zone, text, jsonb\\)",
  "private\\.app_get_qr_paid_totals_impl\\(uuid\\[\\]\\)",
  "public\\.app_get_qr_paid_totals\\(uuid\\[\\]\\)",
]) {
  assert.match(
    migration,
    new RegExp(`revoke execute on function ${signature}[\\s\\S]*?from public, anon, authenticated, service_role`, "i"),
  );
  assert.match(
    migration,
    new RegExp(`grant execute on function ${signature}[\\s\\S]*?to authenticated`, "i"),
  );
}

const paidHelper = migration.match(
  /create function private\.app_get_qr_paid_totals_impl\([\s\S]*?\n\$\$;/i,
)?.[0];
assert.ok(paidHelper, "QR-only finalized-total helper is missing");
assert.match(
  checkoutMigration,
  /add column if not exists finalized_payment_choice text[\s\S]*?finalized_payment_choice in \('cash', 'card', 'card_fee7', 'bank'\)/i,
);
assert.match(
  checkoutMigration,
  /set finalized_at = now\(\),[\s\S]*?finalized_order_id = v_paid_order\.id,[\s\S]*?finalized_payment_choice = v_payment_choice/i,
);
assert.match(
  paidHelper,
  /security definer[\s\S]*?set search_path = ''[\s\S]*?auth\.uid\(\)[\s\S]*?has_app_role\(array\['staff', 'admin'\]::text\[\]\)/i,
);
assert.match(
  paidHelper,
  /join public\.qr_orders as qr_order[\s\S]*?join public\.orders as paid_order[\s\S]*?paid_order\.id = qr_order\.finalized_order_id/i,
  "paid-total lookup must expose only ledgers linked from requested QR orders",
);
assert.match(
  paidHelper,
  /when qr_order\.finalized_payment_choice is not null[\s\S]*?then qr_order\.finalized_payment_choice[\s\S]*?paid_line\.kind = 'fee7'[\s\S]*?paid_line\.ko_name = 'Service fee 7%'[\s\S]*?paid_line\.line_usd::bigint =[\s\S]*?paid_order\.total_usd::bigint - qr_order\.total_usd::bigint/i,
  "new rows use the recorded checkout choice; legacy NULL rows require the exact reconciled fee marker",
);

// Deploying this migration does not run business-row DML. The DELETE/INSERT/
// UPDATE statements above exist only inside the RPC body and execute on an
// explicitly selected open order.
const migrationWithoutFunctionBodies = migration.replace(/\$\$[\s\S]*?\$\$/g, "$$FUNCTION_BODY$$");
assert.doesNotMatch(
  migrationWithoutFunctionBodies,
  /(?:^|;)\s*(?:insert|update|delete|truncate|merge)\b/im,
);

// Existing grants remain read-only for authenticated clients. All writes in
// the inbox source must therefore go through the narrow RPCs.
assert.match(
  foundation,
  /grant select on table[\s\S]*?public\.qr_orders,[\s\S]*?public\.qr_order_items[\s\S]*?to authenticated/i,
);
assert.doesNotMatch(
  inboxSource,
  /\.from\(["'](?:qr_orders|qr_order_items)["']\)[\s\S]{0,120}?\.(?:insert|update|delete|upsert)\s*\(/i,
);

for (const id of [
  "editOrderModal",
  "editOrderForm",
  "editOrderLines",
  "editMenuSearch",
  "editMenuSelect",
  "editMenuQty",
  "editMenuAdd",
  "editOrderNote",
  "editOrderTotal",
  "editOrderSave",
]) {
  assert.match(inboxHtml, new RegExp(`id=["']${id}["']`));
}
assert.match(inboxSource, /CURRENT_STATUSES\.includes\(order\.status\) && !order\.finalized_order_id[\s\S]*?data-action="edit"[\s\S]*?>주문 수정</i);
assert.match(
  inboxSource,
  /\.from\("menu_items"\)[\s\S]*?\.eq\("is_active", true\)[\s\S]*?\.eq\("is_orderable", true\)[\s\S]*?\.eq\("is_sold_out", false\)[\s\S]*?\.eq\("requires_preorder", false\)[\s\S]*?\.is\("archived_at", null\)/i,
);
assert.match(
  inboxSource,
  /editExpectedUpdatedAt = latest\.updated_at[\s\S]*?sb\.rpc\("app_update_qr_order", \{[\s\S]*?p_order_id: orderId[\s\S]*?p_expected_updated_at: editExpectedUpdatedAt[\s\S]*?p_note: note\.trim\(\) \|\| null[\s\S]*?p_items: editLines\.map[\s\S]*?menu_item_id: line\.menu_item_id[\s\S]*?qty: Number\(line\.qty\)/i,
);
assert.match(inboxSource, /error\?\.code === "55000"[\s\S]*?closeEditOrder\(\)/i);
assert.match(inboxSource, /ui\.toast\("주문 내용이 수정되었습니다\."[\s\S]*?await loadOrders\(\)/i);
assert.match(inboxSource, /\.on\("postgres_changes", \{ event: "\*", schema: "public", table: "qr_order_items" \}/i);

assert.match(inboxSource, /sb\.rpc\("app_get_qr_paid_totals"/i);
assert.match(inboxSource, /paid_total_vnd[\s\S]*?최종 결제금액[\s\S]*?card_fee7[\s\S]*?카드 \+ 7%/i);
assert.match(inboxSource, /order\.finalized_order_id && !hasPaidTotal[\s\S]*?결제 금액을 불러오지 못했습니다/i);
assert.doesNotMatch(inboxSource, /기본 주문금액 \(수수료 별도\)/i);
assert.match(staffCss, /\.qr-modal-wide\s*\{[\s\S]*?max-height:[\s\S]*?overflow:\s*auto/i);
assert.match(staffCss, /\.qr-edit-line\s*\{/i);

new vm.Script(inboxSource, { filename: "assets/order-inbox.js" });

console.log("QR inbox order-edit, snapshot, ACL, and paid-total display contracts passed.");
