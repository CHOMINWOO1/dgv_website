import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFile(path.join(projectRoot, file), "utf8");

const [checkoutMigration, cutoverMigration, guestOrdersMigration] = await Promise.all([
  read("supabase/migrations/20260926180000_qr_table_checkout.sql"),
  read("supabase/migrations/20260926181000_disable_single_qr_checkout_rpc.sql"),
  read("supabase/migrations/20260926171000_qr_guest_open_orders.sql"),
]);

assert.match(
  checkoutMigration,
  /drop constraint if exists qr_orders_finalized_order_id_key[\s\S]*?create index if not exists qr_orders_finalized_order_id_idx[\s\S]*?where finalized_order_id is not null/i,
  "consolidated checkout must replace the historical one-to-one finalized link",
);
assert.match(
  checkoutMigration,
  /drop index if exists public\.qr_orders_voided_order_id_key[\s\S]*?create index if not exists qr_orders_voided_order_id_idx[\s\S]*?where voided_order_id is not null/i,
  "safe-delete tombstones must permit many QR rows for one deleted sale",
);

const checkoutHelper = checkoutMigration.match(
  /create or replace function private\.app_finalize_qr_table_orders_checked_impl\([\s\S]*?\n\$\$;/i,
)?.[0];
assert.ok(checkoutHelper, "table checkout implementation is missing");
assert.match(
  checkoutHelper,
  /security definer[\s\S]*?set search_path = ''[\s\S]*?\(select auth\.uid\(\)\) is null[\s\S]*?has_app_role\(array\['staff', 'admin'\]::text\[\]\)/i,
);
assert.match(
  checkoutHelper,
  /jsonb_array_length\(p_expected_orders\) not between 1 and 200[\s\S]*?expected\.item - 'id' - 'updated_at'[\s\S]*?duplicate expected QR orders are not allowed/i,
  "the browser snapshot must be strictly shaped, bounded, and duplicate-free",
);
assert.match(
  checkoutHelper,
  /from public\.qr_tables as table_row[\s\S]*?where table_row\.id = p_table_id[\s\S]*?for update[\s\S]*?from public\.qr_orders as qr_order[\s\S]*?order by qr_order\.id[\s\S]*?for update/i,
  "table and QR rows must be locked in deterministic order",
);
assert.match(
  checkoutHelper,
  /v_finalized_count = v_expected_count[\s\S]*?cardinality\(v_existing_paid_ids\) <> 1[\s\S]*?v_linked_ids is distinct from v_expected_ids[\s\S]*?return v_existing_paid_id/i,
  "an exact completed retry must return the original sale without accepting a subset",
);
assert.match(
  checkoutHelper,
  /status = 'submitted'[\s\S]*?unconfirmed QR orders remain for this table[\s\S]*?status = 'accepted'[\s\S]*?v_actual_ids is distinct from v_expected_ids[\s\S]*?v_actual_versions is distinct from v_expected_versions/i,
  "submitted rows must block checkout and accepted rows must match the modal snapshot exactly",
);
assert.match(
  checkoutHelper,
  /snapshot\.line_count = 0[\s\S]*?snapshot\.total_usd <> qr_order\.total_usd[\s\S]*?snapshot\.total_vnd <> qr_order\.total_vnd/i,
  "every stored total must reconcile to immutable item snapshots",
);
assert.match(
  checkoutHelper,
  /if v_payment_choice = 'card_fee7' then[\s\S]*?round\(v_base_usd::numeric \* 1\.07\)[\s\S]*?round\(\(v_base_vnd::numeric \* 1\.07\) \/ 1000\) \* 1000/i,
  "7% must use calc-compatible rounding once on the combined subtotal",
);
assert.match(
  checkoutHelper,
  /insert into public\.orders[\s\S]*?'qr_table'[\s\S]*?insert into public\.order_custom_items[\s\S]*?join public\.qr_order_items[\s\S]*?update public\.qr_orders[\s\S]*?finalized_order_id = v_paid_order\.id[\s\S]*?get diagnostics v_updated_count = row_count/i,
  "one paid ledger row must contain every snapshot and link every expected QR order",
);

assert.match(
  checkoutMigration,
  /create or replace function public\.app_finalize_qr_table_orders_checked\([\s\S]*?p_expected_orders jsonb[\s\S]*?returns uuid[\s\S]*?security invoker[\s\S]*?select private\.app_finalize_qr_table_orders_checked_impl/i,
);
for (const fn of [
  "private\\.app_finalize_qr_table_orders_checked_impl",
  "public\\.app_finalize_qr_table_orders_checked",
]) {
  assert.match(
    checkoutMigration,
    new RegExp(`revoke execute on function ${fn}\\(uuid, jsonb, text, text, text\\)[\\s\\S]*?from public, anon, authenticated, service_role`, "i"),
  );
  assert.match(
    checkoutMigration,
    new RegExp(`grant execute on function ${fn}\\(uuid, jsonb, text, text, text\\)[\\s\\S]*?to authenticated`, "i"),
  );
}

const deleteHelper = checkoutMigration.match(
  /create or replace function private\.app_delete_order_impl\(p_order_id uuid\)[\s\S]*?\n\$\$;/i,
)?.[0];
assert.ok(deleteHelper, "consolidated safe-delete replacement is missing");
assert.match(
  deleteHelper,
  /from public\.qr_orders as qr_order[\s\S]*?where qr_order\.finalized_order_id = v_order_id[\s\S]*?order by qr_order\.id[\s\S]*?for update[\s\S]*?update public\.qr_orders as qr_order[\s\S]*?where qr_order\.finalized_order_id = v_order_id[\s\S]*?delete from public\.orders/i,
  "safe-delete must lock and tombstone every contributing QR row before deleting the sale",
);
assert.doesNotMatch(
  deleteHelper,
  /delete from public\.(?:qr_orders|qr_order_items)/i,
  "safe-delete must preserve QR source and item snapshots",
);

assert.match(
  guestOrdersMigration,
  /qr_order\.status in \('submitted', 'accepted'\)[\s\S]*?qr_order\.finalized_order_id is null/i,
  "successful finalization must naturally remove all paid rows from guest current_orders",
);

for (const fn of [
  "public\\.app_finalize_qr_order_checked",
  "private\\.app_finalize_qr_order_checked_impl",
]) {
  assert.match(
    cutoverMigration,
    new RegExp(`revoke execute on function ${fn}\\(uuid, timestamp with time zone, text, text, text\\)[\\s\\S]*?from public, anon, authenticated, service_role`, "i"),
    "post-frontend cutover must disable partial single-order checkout",
  );
}

const topLevelDdl = checkoutMigration.replace(/\$\$[\s\S]*?\$\$/g, "$$FUNCTION_BODY$$");
assert.doesNotMatch(
  topLevelDdl,
  /(?:^|;)\s*(?:insert|update|delete|truncate|merge)\b/im,
  "deploying the migration itself must not mutate existing business rows",
);

console.log("QR whole-table checkout database contracts passed.");

