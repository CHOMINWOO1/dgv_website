import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFile(path.join(projectRoot, file), "utf8");

const [foundation, deletionMigration] = await Promise.all([
  read("supabase/migrations/20260926110000_qr_table_ordering.sql"),
  read("supabase/migrations/20260926170000_allow_qr_order_and_table_deletion.sql"),
]);

// The paid-order FK stays restrictive. Deletion must preserve the QR source,
// item snapshots, and idempotency key instead of cascading them away.
assert.match(
  foundation,
  /finalized_order_id uuid unique[\s\S]*?references public\.orders \(id\) on delete restrict/i,
);
assert.doesNotMatch(
  deletionMigration,
  /drop constraint qr_orders_finalized_order_id_fkey|finalized_order_id[\s\S]*?on delete cascade/i,
);
assert.match(deletionMigration, /add column if not exists voided_order_id uuid/i);
assert.match(deletionMigration, /add column if not exists voided_at timestamp with time zone/i);
assert.match(
  deletionMigration,
  /constraint qr_orders_voided_pair_check[\s\S]*?voided_at is null and voided_order_id is null[\s\S]*?voided_at is not null and voided_order_id is not null/i,
);
assert.match(
  deletionMigration,
  /constraint qr_orders_current_voided_disjoint_check[\s\S]*?finalized_at is not null or finalized_order_id is not null[\s\S]*?voided_at is not null or voided_order_id is not null/i,
);
assert.match(
  deletionMigration,
  /constraint qr_orders_voided_cancelled_check[\s\S]*?voided_order_id is null[\s\S]*?status = 'cancelled' and cancelled_at is not null/i,
);
assert.match(
  deletionMigration,
  /create unique index qr_orders_voided_order_id_key[\s\S]*?where voided_order_id is not null/i,
);

const deleteHelper = deletionMigration.match(
  /create function private\.app_delete_order_impl\(p_order_id uuid\)[\s\S]*?\n\$\$;/i,
)?.[0];
assert.ok(deleteHelper, "paid-order delete helper is missing");
assert.match(
  deleteHelper,
  /security definer[\s\S]*?set search_path = ''[\s\S]*?\(select auth\.uid\(\)\) is null[\s\S]*?has_app_role\(array\['admin'\]::text\[\]\)/i,
);
assert.match(
  deleteHelper,
  /from public\.orders as o[\s\S]*?where o\.id = p_order_id[\s\S]*?for update[\s\S]*?from public\.resv_groups as r[\s\S]*?confirmed_order_id = v_order_id/i,
);
assert.match(
  deleteHelper,
  /if not found then\s+return false;[\s\S]*?unconfirm the reservation before deleting its order/i,
  "ordinary missing-order and reservation-linked semantics must remain unchanged",
);
assert.match(
  deleteHelper,
  /from public\.qr_orders as q[\s\S]*?q\.finalized_order_id = v_order_id[\s\S]*?for update[\s\S]*?set_config\('app\.rpc_write', 'on', true\)/i,
);
assert.match(
  deleteHelper,
  /update public\.qr_orders[\s\S]*?status = 'cancelled'[\s\S]*?cancelled_at = v_voided_at[\s\S]*?voided_order_id = finalized_order_id[\s\S]*?voided_at = v_voided_at[\s\S]*?finalized_order_id = null[\s\S]*?finalized_at = null[\s\S]*?delete from public\.orders[\s\S]*?set_config\('app\.rpc_write', 'off', true\)/i,
);
assert.doesNotMatch(
  deleteHelper,
  /delete from public\.(?:qr_orders|qr_order_items)|(?:client_request_id|request_hash)\s*=/i,
  "paid-order deletion must retain the QR source, item snapshots, and idempotency fields",
);
assert.match(
  deletionMigration,
  /create or replace function public\.app_delete_order\(p_order_id uuid\)[\s\S]*?security invoker[\s\S]*?select private\.app_delete_order_impl\(p_order_id\)/i,
);

// Applying the migration itself is schema-only. Mutations appear only inside
// RPC bodies and therefore do not run against existing business rows at deploy.
const migrationWithoutFunctionBodies = deletionMigration.replace(/\$\$[\s\S]*?\$\$/g, "$$FUNCTION_BODY$$");
assert.doesNotMatch(
  migrationWithoutFunctionBodies,
  /(?:^|;)\s*(?:insert|update|delete|truncate|merge)\b/im,
);

// A table archive keeps its identity and historic orders, makes it inactive,
// and deletes only the credential hash that powers the printed QR code.
assert.match(
  deletionMigration,
  /alter table public\.qr_tables[\s\S]*?add column if not exists archived_at timestamp with time zone/i,
);
assert.match(
  deletionMigration,
  /constraint qr_tables_archived_inactive_check[\s\S]*?archived_at is null or is_active = false/i,
);
assert.match(
  deletionMigration,
  /create unique index qr_tables_label_ci_key[\s\S]*?where archived_at is null/i,
);
assert.match(
  deletionMigration,
  /create function private\.app_archive_qr_table_impl\(p_table_id uuid\)[\s\S]*?security definer[\s\S]*?\(select auth\.uid\(\)\) is null[\s\S]*?has_app_role\(array\['admin'\]::text\[\]\)[\s\S]*?where id = p_table_id[\s\S]*?and archived_at is null[\s\S]*?for update[\s\S]*?set is_active = false,[\s\S]*?archived_at = now\(\)[\s\S]*?delete from private\.qr_table_tokens[\s\S]*?where table_id = v_table_id[\s\S]*?return true/i,
);

const archiveFunction = deletionMigration.match(
  /create function private\.app_archive_qr_table_impl\(p_table_id uuid\)[\s\S]*?\n\$\$;/i,
)?.[0];
assert.ok(archiveFunction, "archive helper is missing");
assert.doesNotMatch(
  archiveFunction,
  /(?:delete from|update)\s+public\.(?:qr_orders|qr_order_items|orders|order_items|order_custom_items)/i,
  "archiving a table must preserve every historic order row",
);

// The exposed RPC remains an invoker wrapper. Both functions have default
// PUBLIC execution revoked, and only authenticated callers can reach them;
// the private helper then checks auth.uid plus the admin app_metadata role.
assert.match(
  deletionMigration,
  /create function public\.app_archive_qr_table\(p_table_id uuid\)[\s\S]*?security invoker[\s\S]*?select private\.app_archive_qr_table_impl\(p_table_id\)/i,
);
for (const fn of [
  "private\\.app_archive_qr_table_impl",
  "public\\.app_archive_qr_table",
  "private\\.app_delete_order_impl",
  "public\\.app_delete_order",
]) {
  assert.match(
    deletionMigration,
    new RegExp(`revoke execute on function ${fn}\\(uuid\\)[\\s\\S]*?from public, anon, authenticated, service_role`, "i"),
  );
  assert.match(
    deletionMigration,
    new RegExp(`grant execute on function ${fn}\\(uuid\\)[\\s\\S]*?to authenticated`, "i"),
  );
  assert.doesNotMatch(
    deletionMigration,
    new RegExp(`grant execute on function ${fn}\\(uuid\\)[\\s\\S]*?to (?:public|anon|service_role)`, "i"),
  );
}

// Archived rows cannot be reactivated or receive a new token. Creation always
// inserts a new table row, so reusing an archived label does not revive it.
assert.match(
  deletionMigration,
  /create or replace function private\.app_rotate_qr_table_token_impl[\s\S]*?where id = p_table_id[\s\S]*?and archived_at is null[\s\S]*?for update/i,
);
assert.match(
  deletionMigration,
  /create or replace function private\.app_set_qr_table_active_impl[\s\S]*?where id = p_table_id[\s\S]*?and archived_at is null/i,
);
assert.match(
  foundation,
  /create function private\.app_create_qr_table_impl[\s\S]*?insert into public\.qr_tables \(label\)/i,
);

// Both guest entry points already require an active table. The new check
// constraint makes `is_active = true` impossible whenever archived_at is set,
// while archive also removes the only stored token hash.
for (const name of ["internal_qr_get_menu", "internal_qr_submit_order"]) {
  assert.match(
    foundation,
    new RegExp(`create function public\\.${name}[\\s\\S]*?tokens\\.token_hash = p_token_hash[\\s\\S]*?and t\\.is_active = true`, "i"),
  );
}

console.log("QR paid-order audit preservation and recoverable table-archive contracts passed.");
