import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migration = await readFile(
  path.join(projectRoot, "supabase/migrations/20261005090000_add_combo_menus.sql"),
  "utf8",
);

const schemaPrefix = migration.split("create function private.menu_combo_summary", 1)[0];
assert.doesNotMatch(
  schemaPrefix,
  /\b(?:insert\s+into|update|delete\s+from|truncate)\s+public\.(?:menu_items|qr_orders|qr_order_items|orders|order_custom_items)\b/i,
  "the additive schema phase must not rewrite existing business rows",
);

assert.match(migration, /create table public\.menu_combo_components/);
assert.match(migration, /references public\.menu_items \(id\) on delete restrict/);
assert.match(migration, /alter table public\.menu_combo_components enable row level security/);
assert.match(migration, /create policy menu_combo_components_no_direct_client_access[\s\S]*?to anon, authenticated[\s\S]*?using \(false\)[\s\S]*?with check \(false\)/);
assert.match(migration, /revoke all on table public\.menu_combo_components[\s\S]*?from public, anon, authenticated, service_role/);
assert.match(migration, /grant select on table public\.menu_combo_components to service_role/);

assert.match(migration, /add column if not exists combo_snapshot jsonb/g);
assert.match(migration, /source\.image_url as image_url/);
assert.match(migration, /source\.is_active is true[\s\S]*?source\.is_orderable is true[\s\S]*?source\.is_sold_out is false[\s\S]*?source\.requires_preorder is false/);
assert.match(migration, /'components_available', aggregate\.components_available/);
assert.match(migration, /'pricing_valid',[\s\S]*?aggregate\.regular_price_vnd >= coalesce\(combo\.price_vnd, 0\)/);
assert.match(migration, /'is_available',[\s\S]*?aggregate\.components_available[\s\S]*?aggregate\.regular_price_vnd >= coalesce\(combo\.price_vnd, 0\)/);

assert.equal(
  (migration.match(/private\.menu_combo_summary\(menu\.id\) ->> 'is_available'/g) || []).length,
  2,
  "guest submit and newly-added staff lines must reject dynamically unavailable combos",
);
assert.match(migration, /when menu\.qr_category = 'combo' then[\s\S]*?private\.menu_combo_summary\(menu\.id\)/);
assert.match(migration, /when old_line\.id is not null then old_line\.combo_snapshot/);
assert.match(migration, /insert into public\.order_custom_items[\s\S]*?combo_snapshot[\s\S]*?item\.combo_snapshot/);

assert.match(migration, /revoke execute on function public\.internal_qr_get_menu\(text\)[\s\S]*?from public, anon, authenticated, service_role/);
assert.match(migration, /grant execute on function public\.internal_qr_get_menu\(text\) to service_role/);
assert.match(migration, /revoke execute on function public\.internal_qr_submit_order\(text, uuid, text, jsonb\)[\s\S]*?from public, anon, authenticated, service_role/);
assert.match(migration, /grant execute on function public\.internal_qr_submit_order\(text, uuid, text, jsonb\)[\s\S]*?to service_role/);

console.log("QR combo migration safety, availability, snapshot, and ACL contracts passed.");
