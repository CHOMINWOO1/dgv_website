import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_NOTE_CHARACTERS = 500;
const MAX_ORDER_LINES = 40;
const MAX_LINE_QUANTITY = 20;
const MAX_TOTAL_QUANTITY = 100;

const ALLOWED_ORIGINS = new Set([
  "https://dalatgolfvoucher.com",
  "https://www.dalatgolfvoucher.com",
  "http://127.0.0.1:4173",
  "http://localhost:4173",
]);

const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type JsonRecord = Record<string, unknown>;
type DatabaseClient = SupabaseClient;

interface MenuRequest {
  action: "get_menu";
  tableToken: string;
}

interface OrderLine {
  menu_item_id: string;
  qty: number;
}

interface SubmitRequest {
  action: "submit_order";
  tableToken: string;
  clientRequestId: string;
  note: string | null;
  items: OrderLine[];
}

type ParsedRequest = MenuRequest | SubmitRequest;

interface DatabaseErrorLike {
  code?: string;
  message?: string;
}

class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RequestError";
  }
}

class DatabaseCallError extends Error {
  constructor(readonly databaseError: DatabaseErrorLike) {
    super(databaseError.message || "Database operation failed");
    this.name = "DatabaseCallError";
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-headers":
      "authorization, x-client-info, apikey, content-type",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-max-age": "600",
    "vary": "Origin",
  };
}

function jsonResponse(
  req: Request,
  status: number,
  body: Record<string, unknown>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      ...corsHeaders(req),
    },
  });
}

async function readBodyLimited(req: Request): Promise<string> {
  const declaredLength = req.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_REQUEST_BYTES)
  ) {
    throw new RequestError(413, "BODY_TOO_LARGE", "Request body is too large");
  }

  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REQUEST_BYTES) {
        await reader.cancel("request body exceeded limit");
        throw new RequestError(413, "BODY_TOO_LARGE", "Request body is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new RequestError(400, "INVALID_UTF8", "Request body must be valid UTF-8");
  }
}

function assertOnlyKeys(
  value: JsonRecord,
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) {
    throw new RequestError(400, "INVALID_REQUEST", "Unexpected request field");
  }
}

function parseTableToken(value: unknown): string {
  if (typeof value !== "string" || !TOKEN_PATTERN.test(value)) {
    throw new RequestError(404, "TABLE_NOT_FOUND", "Invalid table token");
  }
  return value;
}

function containsControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function parseOrderItems(value: unknown): OrderLine[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_ORDER_LINES
  ) {
    throw new RequestError(
      400,
      "INVALID_REQUEST",
      `items must contain 1 to ${MAX_ORDER_LINES} lines`,
    );
  }

  const quantities = new Map<string, number>();
  let totalQuantity = 0;
  value.forEach((item) => {
    if (!isRecord(item)) {
      throw new RequestError(400, "INVALID_REQUEST", "Invalid order line");
    }
    assertOnlyKeys(item, ["menu_item_id", "qty"]);
    if (
      typeof item.menu_item_id !== "string" ||
      !UUID_PATTERN.test(item.menu_item_id)
    ) {
      throw new RequestError(400, "INVALID_REQUEST", "Invalid menu item id");
    }
    if (
      typeof item.qty !== "number" ||
      !Number.isInteger(item.qty) ||
      Number(item.qty) < 1 ||
      Number(item.qty) > MAX_LINE_QUANTITY
    ) {
      throw new RequestError(400, "INVALID_REQUEST", "Invalid menu quantity");
    }
    const id = item.menu_item_id.toLowerCase();
    const quantity = (quantities.get(id) || 0) + item.qty;
    if (quantity > MAX_LINE_QUANTITY) {
      throw new RequestError(400, "INVALID_REQUEST", "Menu quantity is too large");
    }
    quantities.set(id, quantity);
    totalQuantity += item.qty;
  });

  if (totalQuantity > MAX_TOTAL_QUANTITY) {
    throw new RequestError(400, "INVALID_REQUEST", "Order quantity is too large");
  }
  return [...quantities.entries()].map(([menu_item_id, qty]) => ({
    menu_item_id,
    qty,
  }));
}

async function parseRequest(req: Request): Promise<ParsedRequest> {
  const mediaType = req.headers.get("content-type")?.split(";", 1)[0].trim()
    .toLowerCase();
  if (mediaType !== "application/json") {
    throw new RequestError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "Content-Type must be application/json",
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(await readBodyLimited(req));
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError(400, "INVALID_JSON", "Request body must be valid JSON");
  }
  if (!isRecord(value) || typeof value.action !== "string") {
    throw new RequestError(400, "INVALID_REQUEST", "Request body is invalid");
  }

  const tableToken = parseTableToken(value.table_token);
  if (value.action === "get_menu") {
    assertOnlyKeys(value, ["action", "table_token"]);
    return { action: "get_menu", tableToken };
  }
  if (value.action !== "submit_order") {
    throw new RequestError(400, "INVALID_ACTION", "Unsupported action");
  }

  assertOnlyKeys(value, [
    "action",
    "table_token",
    "client_request_id",
    "note",
    "items",
  ]);
  if (
    typeof value.client_request_id !== "string" ||
    !UUID_PATTERN.test(value.client_request_id)
  ) {
    throw new RequestError(400, "INVALID_REQUEST", "Invalid client request id");
  }
  if (
    value.note !== undefined &&
    value.note !== null &&
    typeof value.note !== "string"
  ) {
    throw new RequestError(400, "INVALID_REQUEST", "note must be text or null");
  }
  const note = typeof value.note === "string" ? value.note.trim() : null;
  if (
    note &&
    ([...note].length > MAX_NOTE_CHARACTERS || containsControlCharacters(note))
  ) {
    throw new RequestError(400, "INVALID_REQUEST", "Order note is invalid");
  }

  return {
    action: "submit_order",
    tableToken,
    clientRequestId: value.client_request_id.toLowerCase(),
    note: note || null,
    items: parseOrderItems(value.items),
  };
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function clientAddress(req: Request): string {
  const cloudflare = req.headers.get("cf-connecting-ip")?.trim();
  if (cloudflare) return cloudflare.slice(0, 128);
  const realIp = req.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp.slice(0, 128);
  const forwarded = req.headers.get("x-forwarded-for")
    ?.split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return (forwarded?.[0] || "unknown").slice(0, 128);
}

async function takeRateLimit(
  database: DatabaseClient,
  req: Request,
  action: ParsedRequest["action"],
): Promise<boolean> {
  const address = clientAddress(req);
  const { data, error } = await database.rpc("internal_qr_take_rate_limit", {
    p_rate_key: await sha256(`${action}:ip:${address}`),
    p_limit: action === "submit_order" ? 30 : 180,
    p_window_seconds: 60,
  });
  if (error) throw new DatabaseCallError(error);
  return data === true;
}

function mapDatabaseFailure(
  req: Request,
  error: DatabaseErrorLike,
): Response {
  const message = String(error.message || "").toLowerCase();
  if (message.includes("invalid or inactive table token") ||
      message.includes("invalid table token")) {
    return jsonResponse(req, 404, { ok: false, code: "TABLE_NOT_FOUND" });
  }
  if (message.includes("unavailable menu item")) {
    return jsonResponse(req, 409, { ok: false, code: "MENU_UNAVAILABLE" });
  }
  if (message.includes("idempotency key")) {
    return jsonResponse(req, 409, { ok: false, code: "IDEMPOTENCY_CONFLICT" });
  }
  if (message.includes("qr rate limit exceeded")) {
    return jsonResponse(req, 429, { ok: false, code: "RATE_LIMITED" });
  }
  if (
    error.code === "22023" ||
    message.includes("order contains") ||
    message.includes("order quantity")
  ) {
    return jsonResponse(req, 400, { ok: false, code: "INVALID_REQUEST" });
  }

  // Never log request bodies, raw table tokens, guest notes, or order lines.
  console.error("qr-menu database operation failed", {
    database_code: error.code || "unknown",
  });
  return jsonResponse(req, 500, { ok: false, code: "INTERNAL_ERROR" });
}

export async function handler(req: Request): Promise<Response> {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") {
    if (!origin || !ALLOWED_ORIGINS.has(origin)) {
      return jsonResponse(req, 403, { ok: false, code: "ORIGIN_NOT_ALLOWED" });
    }
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }
  if (req.method !== "POST") {
    return jsonResponse(req, 405, { ok: false, code: "METHOD_NOT_ALLOWED" });
  }
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return jsonResponse(req, 403, { ok: false, code: "ORIGIN_NOT_ALLOWED" });
  }

  try {
    const parsed = await parseRequest(req);
    const tokenHash = await sha256(parsed.tableToken);
    const database = createClient(
      requiredEnv("SUPABASE_URL"),
      requiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
      {
        auth: { autoRefreshToken: false, persistSession: false },
        global: { headers: { "x-client-info": "dgv-qr-menu/1.0" } },
      },
    );

    // IP buckets are safe before token validation because they do not create a
    // unique database row for each attacker-controlled token. Per-table limits
    // run inside the validated database RPCs.
    if (!await takeRateLimit(database, req, parsed.action)) {
      return jsonResponse(req, 429, { ok: false, code: "RATE_LIMITED" });
    }

    if (parsed.action === "get_menu") {
      const { data, error } = await database.rpc("internal_qr_get_menu", {
        p_token_hash: tokenHash,
      });
      if (error) throw new DatabaseCallError(error);
      if (!isRecord(data)) throw new Error("Invalid menu response");
      return jsonResponse(req, 200, { ok: true, ...data });
    }

    const { data, error } = await database.rpc("internal_qr_submit_order", {
      p_token_hash: tokenHash,
      p_client_request_id: parsed.clientRequestId,
      p_note: parsed.note,
      p_items: parsed.items,
    });
    if (error) throw new DatabaseCallError(error);
    if (!isRecord(data)) throw new Error("Invalid order response");
    return jsonResponse(req, 200, { ok: true, order: data });
  } catch (error) {
    if (error instanceof RequestError) {
      return jsonResponse(req, error.status, { ok: false, code: error.code });
    }
    if (error instanceof DatabaseCallError) {
      return mapDatabaseFailure(req, error.databaseError);
    }
    console.error("qr-menu request failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return jsonResponse(req, 500, { ok: false, code: "INTERNAL_ERROR" });
  }
}

Deno.serve(handler);
