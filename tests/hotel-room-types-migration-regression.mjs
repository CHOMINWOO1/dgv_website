import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migration = await readFile(new URL("../supabase/migrations/20261106213812_hotel_room_types_and_mixed_bookings.sql", import.meta.url), "utf8");
const oldMigration = await readFile(new URL("../supabase/migrations/20261106061629_hotel_properties_and_reservation_pricing.sql", import.meta.url), "utf8");
const rollback = await readFile(new URL("../supabase/tests/hotel_room_types.sql", import.meta.url), "utf8");

assert.match(migration, /create table public\.hotel_room_types/);
assert.match(migration, /hotel_id uuid not null references public\.hotel_properties\(id\) on delete restrict/);
assert.match(migration, /create unique index hotel_room_types_hotel_name_idx[\s\S]*?hotel_id,lower\(btrim\(name\)\)/);
assert.match(migration, /alter table public\.hotel_room_types enable row level security/);
assert.match(migration, /revoke all on public\.hotel_room_types from public,anon,authenticated/);
assert.match(migration, /for all to authenticated[\s\S]*?using \(\(select public\.current_app_role\(\)\) in \('manager','admin'\)\)[\s\S]*?with check \(\(select public\.current_app_role\(\)\) in \('manager','admin'\)\)/);
assert.doesNotMatch(migration, /security definer|user_metadata|grant[^;]*\bto anon\b/i);
assert.match(migration, /grant insert\(id,hotel_id,name,[^;]*update\(name,[^;]*is_active\)/);
assert.doesNotMatch(migration, /update\([^)]*\b(?:version|created_at|hotel_id)\b/i);
for (const key of ["weekday_purchase", "weekday_sale", "weekend_purchase", "weekend_sale"]) {
  assert.match(migration, new RegExp("alter column " + key + " set default 0"));
}
assert.doesNotMatch(migration, /\b(?:update|insert\s+into|delete\s+from|truncate)\s+public\.hotel_(?:properties|reservations|room_types)\b/i,
  "migration never rewrites, reprices, backfills or deletes existing business records");
assert.doesNotMatch(migration, /\bdrop\s+(?:table|column)\b/i);
assert.match(migration, /add column room_items jsonb,/);
assert.match(migration, /add column deposit_amount bigint check \(deposit_amount between 0 and 999999999999\)/);
assert.match(migration, /add column balance_amount bigint check \(balance_amount between 0 and 999999999999\)/);
assert.match(migration, /add column note text not null default ''/);
assert.match(migration, /using gin\(room_items jsonb_path_ops\)/);
assert.match(migration, /room_items @> jsonb_build_array\(jsonb_build_object\('room_type_id',old\.id\)\)/);
assert.match(migration, /old\.room_items is not null and new\.room_items is null[\s\S]*?errcode='23514'/);
assert.match(migration, /jsonb_array_length\(new\.room_items\) not between 1 and 100/);
assert.match(migration, /not in \('STANDARD','VIP'\)/);
assert.match(migration, /new\.room_count := count_total/);
assert.match(migration, /new\.hotel_version is distinct from hotel\.version[\s\S]*?errcode='40001'/);
assert.match(migration, /requested_version is distinct from room_type\.version[\s\S]*?errcode='40001'/);
assert.match(migration, /order by rt\.id for share/);
assert.match(migration, /room_type\.hotel_id<>new\.hotel_id[\s\S]*?errcode='23503'/);
assert.match(migration, /if not room_type\.is_active then[\s\S]*?errcode='23514'/);
assert.match(migration, /line_purchase := count_rooms::numeric/);
assert.match(migration, /room_snapshots[\s\S]*?'name',room_type\.name[\s\S]*?'rate_snapshot',jsonb_build_object/);
assert.match(migration, /'room_purchase_amount',case when new\.pricing_mode='standard' then line_purchase else null end/);
assert.match(migration, /new\.room_items := old\.room_items;[\s\S]*?new\.rate_snapshot := old\.rate_snapshot;[\s\S]*?if new\.pricing_mode='standard' then[\s\S]*?new\.room_purchase_amount := old\.room_purchase_amount/);

const oldBranchStart = "  if new.pricing_mode='legacy' then";
const oldBranch = oldMigration.slice(oldMigration.indexOf(oldBranchStart), oldMigration.indexOf("end $$;", oldMigration.indexOf(oldBranchStart)));
const marker = "-- Unchanged legacy branch:";
const newBranch = migration.slice(migration.indexOf(oldBranchStart, migration.indexOf(marker)), migration.indexOf("end $$;", migration.indexOf(marker)));
assert.ok(oldBranch && newBranch);
assert.equal(newBranch.replace(/\s+/g, ""), oldBranch.replace(/\s+/g, ""),
  "NULL room_items follow the original legacy/standard/surcharge implementation unchanged");
assert.match(rollback, /begin;[\s\S]*set local lock_timeout/);
assert.match(rollback, /rollback;\s*$/);
assert.doesNotMatch(rollback, /\bcommit\s*;/i);
assert.match(rollback, /all pre-test hotels are unchanged/);
assert.match(rollback, /all pre-test bookings are unchanged/);
assert.match(rollback, /set local role authenticated/);
console.log("Hotel room schema, least-privilege access, immutable snapshots and legacy compatibility contracts passed.");
