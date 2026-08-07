import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  CONNECTOR_CUTOVER_TABLES,
  buildTargetBeginSql,
  buildTargetCleanupSql,
  buildTargetCommitSql,
  buildTargetSealSql,
  buildTargetStageSql,
  canonicalChunkPlan,
  renderSourceChunkSql,
} from "../scripts/connector-cutover-contract.mjs";
import {
  buildSourceGateCloseSql,
  buildSourceGateOpenSql,
  summarizeSourceGateSnapshot,
} from "../scripts/source-write-gate-contract.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const read = (relative) => readFile(path.join(root, relative), "utf8");
const migration = await read("supabase/migrations/20260807151833_connector_cutover_transfer.sql");
const sequenceFix = await read(
  "supabase/migrations/20260807153315_connector_cutover_transactional_sequence_restart.sql",
);
const sequenceRollback = await read(
  "supabase/tests/connector_cutover_transactional_sequence.sql",
);
const sourceChunk = await read("supabase/validation/connector_source_chunk.sql");
const aclSnapshot = await read("supabase/validation/source_write_gate_acl_snapshot.sql");

const uuid = "01234567-89ab-cdef-8123-456789abcdef";
const hash = "a".repeat(64);
const sourceManifest = {
  contract_version: 1,
  read_only: true,
  database_contract: {},
  tables: {},
  sequence: {},
  integrity: {},
};

assert.ok(20260807151833 > 20260807151139, "helper must follow applied compatibility migration");
assert.ok(20260807153315 > 20260807151833, "sequence fix must follow the applied helper");
assert.doesNotMatch(sequenceFix, /session_replication_role/i);
assert.doesNotMatch(sequenceFix, /disable\s+trigger\s+all/i);
assert.doesNotMatch(sequenceFix, /pg_catalog\.setval\s*\(/i);
assert.match(sequenceFix, /alter sequence public\.resv_groups_id_seq restart with %s/i);
assert.match(sequenceFix, /create or replace function private\.connector_cutover_commit/);
assert.match(sequenceFix, /create or replace function private\.connector_cutover_cleanup/);
assert.match(sequenceFix, /'name', v_sequence->'name'/);
assert.match(sequenceFix, /'max_id', pg_catalog\.to_jsonb\(v_max_id\)/);
assert.match(sequenceFix, /'next_value', pg_catalog\.to_jsonb\(v_next_value\)/);
assert.match(sequenceFix, /'next_value_safe', pg_catalog\.to_jsonb\(v_next_value_safe\)/);
assert.match(sequenceFix, /v_next_value is null\s+or v_next_value < 1/);

const commitStart = sequenceFix.indexOf("create or replace function private.connector_cutover_commit");
const commitEnd = sequenceFix.indexOf(
  "revoke execute on function private.connector_cutover_commit(uuid)",
  commitStart,
);
assert.ok(commitStart >= 0 && commitEnd > commitStart, "commit function must be bounded");
const commit = sequenceFix.slice(commitStart, commitEnd);
assert.equal((commit.match(/alter table public\.[a-z_]+ disable trigger user;/g) ?? []).length, 6);
assert.equal((commit.match(/alter table public\.[a-z_]+ enable trigger user;/g) ?? []).length, 6);
assert.doesNotMatch(commit, /^\s*exception\b/im, "commit must not swallow an error and partially commit");

const emptyProof = commit.indexOf("target changed after empty preflight; no rows were copied");
const firstDisable = commit.indexOf("alter table public.menu_items disable trigger user;");
const firstPublicInsert = commit.indexOf("insert into public.menu_items");
const lastEnable = commit.indexOf("alter table public.notices enable trigger user;");
const targetManifest = commit.indexOf("v_target_manifest :=");
assert.ok(emptyProof > 0 && emptyProof < firstDisable && firstDisable < firstPublicInsert);
assert.ok(lastEnable > firstPublicInsert && targetManifest > lastEnable);

const dependencyOrder = [
  "menu_items", "orders", "order_items", "order_custom_items", "resv_groups", "notices",
];
let cursor = 0;
for (const table of dependencyOrder) {
  const next = commit.indexOf(`insert into public.${table}`, cursor);
  assert.ok(next >= cursor, `${table} must be copied in dependency order`);
  cursor = next + 1;
}
assert.match(commit, /update private\.connector_cutover_runs\s+set state = 'committed'/);
assert.match(commit, /connector_cutover_normalize_manifest\(v_target_manifest\)/);
assert.match(commit, /is distinct from v_source_next_value/);

assert.match(sequenceRollback, /begin;/);
assert.match(sequenceRollback, /alter sequence public\.resv_groups_id_seq restart with %s/i);
assert.match(sequenceRollback, /dgv_forced_failure_after_sequence_restart/);
assert.match(sequenceRollback, /v_after_last is distinct from v_before_last/);
assert.match(sequenceRollback, /v_after_called is distinct from v_before_called/);
assert.match(sequenceRollback, /select \* from finish\(\);\s*rollback;/i);
assert.doesNotMatch(sequenceRollback, /\b(nextval|setval)\s*\(/i);

for (const table of CONNECTOR_CUTOVER_TABLES) {
  assert.match(migration, new RegExp(`create table private\\.connector_cutover_${table}`));
  assert.match(sourceChunk, new RegExp(`from public\\.${table}`));
}
assert.match(migration, /revoke all on table[\s\S]+from public, anon, authenticated, service_role;/);
assert.match(sourceChunk, /begin transaction isolation level repeatable read read only;/i);
assert.doesNotMatch(sourceChunk, /\boffset\b/i);
assert.match(sourceChunk, /limit \(select i\.row_limit \+ 1 from input as i\)/);
assert.match(sourceChunk, /payload_sha256/);
assert.match(sourceChunk, /payload_base64/);
for (const token of [
  "__DGV_TRANSFER_ID__", "__DGV_TABLE_NAME__", "__DGV_CHUNK_NO__",
  "__DGV_AFTER_KEY_SQL__", "__DGV_LIMIT__",
]) {
  assert.equal(sourceChunk.split(token).length - 1, 1, `${token} must occur exactly once`);
}

const rendered = renderSourceChunkSql(sourceChunk, {
  transferId: uuid,
  tableName: "orders",
  chunkNo: 0,
  rowLimit: 123,
});
assert.doesNotMatch(rendered, /__DGV_[A-Z_]+__/);
assert.match(rendered, /'orders'::text/);
assert.throws(() => renderSourceChunkSql(sourceChunk, {
  transferId: uuid,
  tableName: "orders; drop table public.orders",
  chunkNo: 0,
}), /not allowed/);
assert.throws(() => renderSourceChunkSql(sourceChunk, {
  transferId: uuid,
  tableName: "orders",
  chunkNo: 1,
}), /require an afterKey/);

assert.match(buildTargetBeginSql({
  transferId: uuid,
  sourceManifest,
  sourceManifestSha256: hash,
}), /connector_cutover_begin/);
assert.match(buildTargetStageSql({
  payloadBase64: "YQ==\r\n",
  payloadSha256: hash,
}), /'YQ=='/);
assert.match(buildTargetCommitSql({ transferId: uuid }), /connector_cutover_commit/);
assert.match(buildTargetCleanupSql({
  transferId: uuid,
  committedSourceManifestSha256: hash,
}), /connector_cutover_cleanup/);

const chunk = {
  table_name: "orders",
  chunk_no: 0,
  after_key: null,
  last_key: uuid,
  complete: true,
  row_count: 1,
  raw_bytes: 10,
  payload_sha256: hash,
  payload_base64: "must-not-enter-plan",
};
const plan = canonicalChunkPlan([chunk]);
assert.equal(plan[0].payload_base64, undefined, "seal plan must never duplicate payload bytes");
assert.match(buildTargetSealSql({
  transferId: uuid,
  sourceManifestAfter: sourceManifest,
  sourceManifestAfterSha256: hash,
  chunks: [chunk],
}), /connector_cutover_seal/);

assert.match(aclSnapshot, /repeatable read read only/i);
assert.match(aclSnapshot, /coalesce\(p\.proacl, pg_catalog\.acldefault\('f', p\.proowner\)\)/);
assert.match(aclSnapshot, /case when x\.grantee = 0 then 'PUBLIC'/);
assert.match(aclSnapshot, /effective_acl_fingerprint/);
assert.match(aclSnapshot, /restorable_by_captured_role/);
assert.doesNotMatch(
  aclSnapshot,
  /^\s*(revoke|alter|drop|truncate|delete|update|insert|grant)\b/im,
);

const aclContract = {
  contract_version: 1,
  read_only: true,
  captured_by: "postgres",
  database: "postgres",
  effective_acl_fingerprint: hash,
  restorable_by_captured_role: true,
  affected_entry_count: 4,
  entries: [
    {
      object_kind: "routine", schema_name: "public", object_name: "legacy_write",
      object_subkind: "f", column_name: null, identity_arguments: "jsonb",
      grantor: "postgres", grantee: "PUBLIC", privilege_type: "EXECUTE",
      is_grantable: false, affected: true,
    },
    {
      object_kind: "relation", schema_name: "public", object_name: "orders",
      object_subkind: "r", column_name: null, identity_arguments: null,
      grantor: "postgres", grantee: "service_role", privilege_type: "INSERT",
      is_grantable: false, affected: true,
    },
    {
      object_kind: "sequence", schema_name: "public", object_name: "resv_groups_id_seq",
      object_subkind: "S", column_name: null, identity_arguments: null,
      grantor: "postgres", grantee: "authenticated", privilege_type: "USAGE",
      is_grantable: false, affected: true,
    },
    {
      object_kind: "column", schema_name: "public", object_name: "orders",
      object_subkind: "r", column_name: "status", identity_arguments: null,
      grantor: "postgres", grantee: "anon", privilege_type: "UPDATE",
      is_grantable: false, affected: true,
    },
  ],
};

assert.deepEqual(summarizeSourceGateSnapshot(aclContract), {
  capturedBy: "postgres",
  database: "postgres",
  effectiveAclFingerprint: hash,
  affectedEntryCount: 4,
});

const closeSql = buildSourceGateCloseSql(aclContract);
const openSql = buildSourceGateOpenSql(aclContract);
for (const sql of [closeSql, openSql]) {
  assert.match(sql, /^begin isolation level serializable;/);
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /current_user <> 'postgres'/);
  assert.match(sql, /current_database\(\) <> 'postgres'/);
  assert.match(sql, /PUBLIC/);
  assert.match(sql, /effective_acl_fingerprint|v_expected_fingerprint/);
  assert.match(sql, /commit;$/);
  assert.doesNotMatch(sql, /create\s+(table|function)|alter\s+table|drop\s+|truncate\s+/i);
}
assert.ok(closeSql.indexOf("source ACL changed after snapshot") < closeSql.indexOf("for v_entry in"));
assert.ok(closeSql.indexOf("for v_entry in") < closeSql.indexOf("source_api_write_gate_status is not closed"));
assert.match(closeSql, /revoke execute on routine %s from %s%s/);
assert.match(closeSql, /'closed', true/);
assert.ok(openSql.indexOf("source_api_write_gate_status is not closed") < openSql.indexOf("for v_entry in"));
assert.ok(openSql.indexOf("for v_entry in") < openSql.indexOf("source ACL fingerprint was not restored exactly"));
assert.match(openSql, /grant execute on routine %s to %s%s/);
assert.match(openSql, /v_grant_option_sql/);
assert.match(openSql, /reopen grants rolled back/);

assert.throws(() => buildSourceGateCloseSql({ ...aclContract, effective_acl_fingerprint: "bad" }), /SHA-256/);
assert.throws(() => buildSourceGateCloseSql({
  ...aclContract,
  entries: aclContract.entries.map((entry, index) => index === 0
    ? { ...entry, grantor: "another_role" }
    : entry),
}), /different grantor/);
assert.throws(() => buildSourceGateOpenSql({
  ...aclContract,
  entries: aclContract.entries.map((entry, index) => index === 0
    ? { ...entry, grantee: "postgres" }
    : entry),
}), /unexpected affected grantee/);

console.log("connector cutover contract: ok");
