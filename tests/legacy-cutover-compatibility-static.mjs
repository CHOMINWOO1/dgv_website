import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationRelative =
  "supabase/migrations/20260807151139_legacy_cutover_compatibility.sql";
const pgTapRelative = "supabase/tests/legacy_cutover_compatibility.sql";

const migration = await readFile(path.join(projectRoot, migrationRelative), "utf8");
const pgTap = await readFile(path.join(projectRoot, pgTapRelative), "utf8");

function stripFunctionBodies(sql) {
  return sql.replace(/\$\$[\s\S]*?\$\$/g, "'<function-body>'");
}

function stripComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--[^\r\n]*/g, "");
}

function assertBalancedSqlDelimiters(sql, label) {
  const openParentheses = [];

  const location = (index) => {
    const prefix = sql.slice(0, index);
    const lines = prefix.split(/\r?\n/);
    return `${lines.length}:${lines.at(-1).length + 1}`;
  };

  for (let index = 0; index < sql.length;) {
    if (sql.startsWith("--", index)) {
      const newline = sql.indexOf("\n", index + 2);
      index = newline < 0 ? sql.length : newline + 1;
      continue;
    }

    if (sql.startsWith("/*", index)) {
      const end = sql.indexOf("*/", index + 2);
      assert.ok(end >= 0, `${label} has an unterminated block comment at ${location(index)}`);
      index = end + 2;
      continue;
    }

    const character = sql[index];
    if (character === "'" || character === '"') {
      const quote = character;
      const start = index;
      index += 1;
      let closed = false;
      while (index < sql.length) {
        if (sql[index] !== quote) {
          index += 1;
          continue;
        }
        if (sql[index + 1] === quote) {
          index += 2;
          continue;
        }
        index += 1;
        closed = true;
        break;
      }
      assert.ok(closed, `${label} has an unterminated quoted value at ${location(start)}`);
      continue;
    }

    if (character === "$") {
      const tag = sql.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0];
      if (tag) {
        const contentStart = index + tag.length;
        const end = sql.indexOf(tag, contentStart);
        assert.ok(end >= 0, `${label} has an unterminated dollar quote at ${location(index)}`);
        const content = sql.slice(contentStart, end);
        if (content.trim()) {
          assertBalancedSqlDelimiters(content, `${label} dollar-quoted body at ${location(index)}`);
        }
        index = end + tag.length;
        continue;
      }
    }

    if (character === "(") {
      openParentheses.push(index);
    } else if (character === ")") {
      assert.ok(
        openParentheses.length > 0,
        `${label} has an unmatched closing parenthesis at ${location(index)}`,
      );
      openParentheses.pop();
    }
    index += 1;
  }

  assert.equal(
    openParentheses.length,
    0,
    `${label} has an unclosed parenthesis at ${location(openParentheses.at(-1) ?? 0)}`,
  );
}

function functionBody(name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = migration.match(new RegExp(
    `create or replace function public\\.${escapedName}\\([\\s\\S]*?as \\$\\$([\\s\\S]*?)\\$\\$;`,
    "i",
  ));
  assert.ok(match, `${name} definition is missing`);
  return match[1];
}

const outsideBodies = stripComments(stripFunctionBodies(migration));
assertBalancedSqlDelimiters(migration, migrationRelative);
assertBalancedSqlDelimiters(pgTap, pgTapRelative);

const snapshotStatements = pgTap.match(/insert into case_snapshots[\s\S]*?;/gi) ?? [];
assert.equal(snapshotStatements.length, 5, "all five case snapshot INSERT statements must be present");
for (const [index, statement] of snapshotStatements.entries()) {
  assertBalancedSqlDelimiters(statement, `case_snapshots INSERT ${index + 1}`);
}
const intentionallyUnclosedSnapshot = snapshotStatements[1].replace(/\)\s*;\s*$/, ";");
assert.notEqual(intentionallyUnclosedSnapshot, snapshotStatements[1], "delimiter checker self-test fixture must remove a closing parenthesis");
assert.throws(
  () => assertBalancedSqlDelimiters(intentionallyUnclosedSnapshot, "intentional malformed snapshot"),
  /unclosed parenthesis/,
  "static parser must catch the exact missing-jsonb_build_object-close regression",
);

const statements = outsideBodies
  .split(";")
  .map((statement) => statement.trim())
  .filter(Boolean);

assert.equal(statements.length, 12, "migration must contain exactly 4 function replacements and 8 ACL statements");
for (const statement of statements) {
  assert.match(
    statement,
    /^(?:create or replace function public\.(?:app_update_order|app_update_reservation|app_confirm_reservation|app_unconfirm_reservation)\b|revoke all on function public\.(?:app_update_order|app_update_reservation|app_confirm_reservation|app_unconfirm_reservation)\b|grant execute on function public\.(?:app_update_order|app_update_reservation|app_confirm_reservation|app_unconfirm_reservation)\b)/i,
    `unexpected apply-time statement: ${statement.slice(0, 100)}`,
  );
}

assert.doesNotMatch(
  outsideBodies,
  /(?:^|;)\s*(?:insert|update|delete|truncate|merge|copy|call|do|alter\s+table|drop\s+(?:table|column))\b/im,
  "migration application must not mutate business data",
);

for (const name of [
  "app_update_order",
  "app_update_reservation",
  "app_confirm_reservation",
  "app_unconfirm_reservation",
]) {
  const definition = migration.match(new RegExp(
    `create or replace function public\\.${name}\\([\\s\\S]*?\\$\\$;`,
    "i",
  ))?.[0];
  assert.ok(definition, `${name} definition missing`);
  assert.match(definition, /security invoker\s+set search_path\s*=\s*''/i, `${name} must be SECURITY INVOKER with an empty search_path`);
  assert.match(definition, /if not public\.has_app_role\(array\['admin'\]::text\[\]\)/i, `${name} must remain admin-only`);
}

const updateOrder = functionBody("app_update_order");
const emptyBranchStart = updateOrder.indexOf("if pg_catalog.jsonb_array_length(p_items) = 0 then");
const emptyBranchEnd = updateOrder.indexOf("\n  if exists (", emptyBranchStart);
assert.ok(emptyBranchStart >= 0 && emptyBranchEnd > emptyBranchStart, "zero-child metadata branch is missing");
const emptyBranch = updateOrder.slice(emptyBranchStart, emptyBranchEnd);
assert.match(emptyBranch, /v_regular_count <> 0 or v_custom_count <> 0/i);
assert.match(emptyBranch, /update public\.orders[\s\S]*?set status[\s\S]*?guide_name[\s\S]*?team_no[\s\S]*?payment_method/i);
assert.doesNotMatch(emptyBranch, /\b(?:delete|insert)\b|total_usd\s*=|total_vnd\s*=|created_at\s*=|source\s*=|sales_excluded\s*=/i, "zero-child branch may update metadata only");
assert.ok(
  updateOrder.indexOf("from public.orders as o") < updateOrder.indexOf("from public.order_items as oi"),
  "order update must lock its parent before child rows",
);

const updateReservation = functionBody("app_update_reservation");
const firstReservationWrite = updateReservation.indexOf("update public.resv_groups");
assert.ok(firstReservationWrite > 0, "reservation update write is missing");
for (const requiredPrewriteCheck of [
  "v_reservation.price <= 0",
  "v_regular_count <> 0",
  "v_custom_count <> 1",
  "v_custom_item_kind is distinct from 'group_resv'",
  "v_custom_qty is distinct from v_reservation.guests_count",
  "v_custom_unit_usd is distinct from 0",
  "v_custom_unit_vnd is distinct from v_reservation.price",
  "v_custom_line_usd is distinct from 0",
  "v_custom_line_vnd::bigint is distinct from v_existing_line_vnd",
  "v_order_total_usd is distinct from 0",
  "v_order_total_vnd::bigint is distinct from v_existing_line_vnd",
  "legacy reservation/order mismatch; unconfirm and reconfirm before editing",
]) {
  const index = updateReservation.indexOf(requiredPrewriteCheck);
  assert.ok(index >= 0 && index < firstReservationWrite, `pre-write legacy check missing: ${requiredPrewriteCheck}`);
}
assert.ok(
  updateReservation.indexOf("from public.resv_groups as r")
    < updateReservation.indexOf("from public.orders as o"),
  "confirmed update must lock reservation before order",
);
assert.ok(
  updateReservation.indexOf("from public.orders as o")
    < updateReservation.indexOf("from public.order_custom_items as ci"),
  "confirmed update must lock order before children",
);

const confirmReservation = functionBody("app_confirm_reservation");
assert.match(
  confirmReservation,
  /if v_reservation\.confirmed then[\s\S]*?from public\.orders as o[\s\S]*?for update;[\s\S]*?if not found or v_order_source is distinct from 'reservation_confirm'[\s\S]*?confirmed order is referenced by more than one reservation[\s\S]*?return v_reservation\.confirmed_order_id;/i,
  "already-confirmed path must validate and lock its linked order before returning",
);

const unconfirmReservation = functionBody("app_unconfirm_reservation");
assert.match(
  unconfirmReservation,
  /from public\.orders as o[\s\S]*?for update;[\s\S]*?if not found then[\s\S]*?update public\.resv_groups[\s\S]*?confirmed = false[\s\S]*?return true;/i,
  "orphan recovery must be an explicit unlink-only branch",
);
assert.match(
  unconfirmReservation,
  /v_custom_kind is distinct from 'special'[\s\S]*?v_custom_qty is distinct from v_reservation\.guests_count[\s\S]*?v_custom_unit_vnd is distinct from v_reservation\.price[\s\S]*?v_custom_line_usd::bigint is distinct from[\s\S]*?v_custom_line_vnd::bigint is distinct from[\s\S]*?v_order_total_usd is distinct from v_custom_line_usd[\s\S]*?v_order_total_vnd is distinct from v_custom_line_vnd/i,
  "special legacy exception must prove exact quantities, lines, and totals",
);
const unlinkIndex = unconfirmReservation.lastIndexOf("update public.resv_groups");
const deleteIndex = unconfirmReservation.lastIndexOf("delete from public.orders");
assert.ok(unlinkIndex >= 0 && deleteIndex > unlinkIndex, "unconfirm must unlink before deleting the order");

for (const name of [
  "app_update_order",
  "app_update_reservation",
  "app_confirm_reservation",
  "app_unconfirm_reservation",
]) {
  assert.match(
    migration,
    new RegExp(`revoke all on function public\\.${name}\\([\\s\\S]*?from public, anon, authenticated, service_role;`, "i"),
    `${name} must revoke implicit execution from every API role`,
  );
  assert.match(
    migration,
    new RegExp(`grant execute on function public\\.${name}\\([\\s\\S]*?to authenticated;`, "i"),
    `${name} must grant only the authenticated RPC entry point`,
  );
}

assert.match(pgTap, /\\ir \.\.\/migrations\/20260807151139_legacy_cutover_compatibility\.sql/i, "pgTAP must reapply the exact migration under test");
for (const relation of [
  "menu_items",
  "orders",
  "order_items",
  "order_custom_items",
  "resv_groups",
  "notices",
  "resv_groups_id_seq",
]) {
  const occurrences = pgTap.match(new RegExp(`'${relation}'`, "g"))?.length ?? 0;
  assert.ok(occurrences >= 2, `${relation} must be captured before and after migration reapply`);
}
assert.match(pgTap, /select plan\(28\)/i);
assert.equal(
  (pgTap.match(/^select (?:is|ok|throws_ok)\(/gim) ?? []).length,
  28,
  "pgTAP plan must match its assertions",
);
assert.match(pgTap, /set local session_replication_role = replica;[\s\S]*?set local session_replication_role = origin;/i, "synthetic anomalies must be isolated to test fixture setup");
assert.match(pgTap, /select \* from finish\(\);\s*rollback;/i, "pgTAP must roll back every synthetic row and DDL reapply");
assert.doesNotMatch(migration + pgTap, /https?:\/\/|[a-z0-9-]+\.supabase\.co/i, "compatibility artifacts must not embed a project URL or remote endpoint");

console.log("Legacy cutover compatibility static contracts passed.");
