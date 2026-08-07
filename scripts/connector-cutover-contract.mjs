const TABLES = Object.freeze([
  "menu_items",
  "orders",
  "order_items",
  "order_custom_items",
  "resv_groups",
  "notices",
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_CURSOR_TABLES = new Set(TABLES.filter((table) => table !== "resv_groups"));

function assertUuid(value, label) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a canonical UUID`);
  }
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 hex digest`);
  }
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function jsonText(value, label) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new TypeError(`${label} must be valid JSON: ${error.message}`);
  }
  return { text, parsed };
}

function replaceExactlyOnce(source, token, replacement) {
  const first = source.indexOf(token);
  if (first < 0 || source.indexOf(token, first + token.length) >= 0) {
    throw new Error(`template must contain exactly one ${token} token`);
  }
  return source.replace(token, replacement);
}

export function renderSourceChunkSql(template, {
  transferId,
  tableName,
  chunkNo,
  afterKey = null,
  rowLimit = 100,
}) {
  assertUuid(transferId, "transferId");
  if (!TABLES.includes(tableName)) throw new TypeError("tableName is not allowed");
  if (!Number.isSafeInteger(chunkNo) || chunkNo < 0) {
    throw new TypeError("chunkNo must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(rowLimit) || rowLimit < 1 || rowLimit > 200) {
    throw new TypeError("rowLimit must be an integer from 1 through 200");
  }
  if (afterKey !== null) {
    if (UUID_CURSOR_TABLES.has(tableName)) {
      assertUuid(afterKey, "afterKey");
    } else if (typeof afterKey !== "string" || !/^[1-9][0-9]*$/.test(afterKey)) {
      throw new TypeError("resv_groups afterKey must be a positive bigint string");
    }
  }
  if (chunkNo === 0 && afterKey !== null) {
    throw new TypeError("chunk zero cannot have an afterKey");
  }
  if (chunkNo > 0 && afterKey === null) {
    throw new TypeError("nonzero chunks require an afterKey");
  }

  let sql = template;
  sql = replaceExactlyOnce(sql, "__DGV_TRANSFER_ID__", transferId);
  sql = replaceExactlyOnce(sql, "__DGV_TABLE_NAME__", tableName);
  sql = replaceExactlyOnce(sql, "__DGV_CHUNK_NO__", String(chunkNo));
  sql = replaceExactlyOnce(
    sql,
    "__DGV_AFTER_KEY_SQL__",
    afterKey === null ? "null::text" : `${sqlLiteral(afterKey)}::text`,
  );
  sql = replaceExactlyOnce(sql, "__DGV_LIMIT__", String(rowLimit));
  if (/__DGV_[A-Z_]+__/.test(sql)) throw new Error("unresolved source chunk token");
  return sql;
}

export function buildTargetBeginSql({ transferId, sourceManifest, sourceManifestSha256 }) {
  assertUuid(transferId, "transferId");
  assertSha256(sourceManifestSha256, "sourceManifestSha256");
  const manifest = jsonText(sourceManifest, "sourceManifest");
  if (manifest.parsed?.contract_version !== 1 || manifest.parsed?.read_only !== true) {
    throw new TypeError("sourceManifest must be the read-only version 1 contract");
  }
  return `select private.connector_cutover_begin(${sqlLiteral(transferId)}::uuid, ${sqlLiteral(manifest.text)}::jsonb, ${sqlLiteral(sourceManifestSha256)});`;
}

export function buildTargetStageSql({ payloadBase64, payloadSha256 }) {
  assertSha256(payloadSha256, "payloadSha256");
  if (typeof payloadBase64 !== "string") throw new TypeError("payloadBase64 must be text");
  const compact = payloadBase64.replaceAll(/\s/g, "");
  if (compact.length === 0 || compact.length > 400000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw new TypeError("payloadBase64 is malformed or exceeds the contract limit");
  }
  return `select private.connector_cutover_stage_chunk(${sqlLiteral(compact)}, ${sqlLiteral(payloadSha256)});`;
}

export function canonicalChunkPlan(chunks) {
  if (!Array.isArray(chunks)) throw new TypeError("chunks must be an array");
  const allowed = new Set([
    "table_name",
    "chunk_no",
    "after_key",
    "last_key",
    "complete",
    "row_count",
    "raw_bytes",
    "payload_sha256",
  ]);
  const plan = chunks.map((chunk) => {
    if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) {
      throw new TypeError("each chunk must be an object");
    }
    for (const key of Object.keys(chunk)) {
      if (!allowed.has(key) && key !== "payload_base64") {
        throw new TypeError(`unexpected chunk field: ${key}`);
      }
    }
    if (!TABLES.includes(chunk.table_name)) throw new TypeError("chunk table_name is invalid");
    if (!Number.isSafeInteger(chunk.chunk_no) || chunk.chunk_no < 0) {
      throw new TypeError("chunk_no must be non-negative");
    }
    if (!Number.isSafeInteger(chunk.row_count) || chunk.row_count < 0) {
      throw new TypeError("row_count must be non-negative");
    }
    if (!Number.isSafeInteger(chunk.raw_bytes) || chunk.raw_bytes < 1 || chunk.raw_bytes > 262144) {
      throw new TypeError("raw_bytes is outside the contract limit");
    }
    if (typeof chunk.complete !== "boolean") throw new TypeError("complete must be boolean");
    assertSha256(chunk.payload_sha256, "payload_sha256");
    return {
      table_name: chunk.table_name,
      chunk_no: chunk.chunk_no,
      after_key: chunk.after_key ?? null,
      last_key: chunk.last_key ?? null,
      complete: chunk.complete,
      row_count: chunk.row_count,
      raw_bytes: chunk.raw_bytes,
      payload_sha256: chunk.payload_sha256,
    };
  });
  return plan.sort((left, right) =>
    left.table_name.localeCompare(right.table_name, "en") || left.chunk_no - right.chunk_no
  );
}

export function buildTargetSealSql({
  transferId,
  sourceManifestAfter,
  sourceManifestAfterSha256,
  chunks,
}) {
  assertUuid(transferId, "transferId");
  assertSha256(sourceManifestAfterSha256, "sourceManifestAfterSha256");
  const manifest = jsonText(sourceManifestAfter, "sourceManifestAfter");
  const plan = canonicalChunkPlan(chunks);
  return `select private.connector_cutover_seal(${sqlLiteral(transferId)}::uuid, ${sqlLiteral(manifest.text)}::jsonb, ${sqlLiteral(sourceManifestAfterSha256)}, ${sqlLiteral(JSON.stringify(plan))}::jsonb);`;
}

export function buildTargetCommitSql({ transferId }) {
  assertUuid(transferId, "transferId");
  return `select private.connector_cutover_commit(${sqlLiteral(transferId)}::uuid);`;
}

export function buildTargetCleanupSql({ transferId, committedSourceManifestSha256 }) {
  assertUuid(transferId, "transferId");
  assertSha256(committedSourceManifestSha256, "committedSourceManifestSha256");
  return `select private.connector_cutover_cleanup(${sqlLiteral(transferId)}::uuid, ${sqlLiteral(committedSourceManifestSha256)});`;
}

export const CONNECTOR_CUTOVER_TABLES = TABLES;
