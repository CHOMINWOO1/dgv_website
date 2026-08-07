import { createClient } from "npm:@supabase/supabase-js@2.112.2";
import {
  renderReservationDelivery,
  renderSummaryDelivery,
  type RenderedDelivery,
} from "./message-rendering.ts";

const MAX_REQUEST_BYTES = 256;
const MAX_PAYLOAD_BYTES = 32 * 1024;
const MAX_SUMMARY_ROWS = 100;
const TELEGRAM_TIMEOUT_MS = 10_000;
const MAX_STORED_ERROR_LENGTH = 1_000;
const SECURITY_STAGING_PROJECT_REF = "evrinpdgmlkyfwamxqit";

const JSON_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
});

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RESERVATION_FIELDS = [
  "res_date",
  "res_time",
  "branch",
  "guests_count",
  "menu_ko",
  "menu_vi",
  "guide_name",
  "note",
] as const;

const SUMMARY_FIELDS = ["date", "rows"] as const;

const SUMMARY_ROW_FIELDS = [
  "res_time",
  "branch",
  "guests_count",
  "price",
  "menu_ko",
  "menu_vi",
  "guide_name",
  "note",
] as const;

type JsonRecord = Record<string, unknown>;
type EventType = "resv_insert" | "daily_summary" | "tomorrow_summary";

interface ReservationPayload {
  res_date?: string | null;
  res_time?: string | null;
  branch?: string | null;
  guests_count?: string | number | null;
  menu_ko?: string | null;
  menu_vi?: string | null;
  guide_name?: string | null;
  note?: string | null;
}

interface SummaryRow {
  res_time?: string | null;
  branch?: string | null;
  guests_count?: string | number | null;
  price?: string | number | null;
  menu_ko?: string | null;
  menu_vi?: string | null;
  guide_name?: string | null;
  note?: string | null;
}

interface SummaryPayload {
  date?: string | null;
  rows: SummaryRow[];
}

interface ClaimedOutboxRow {
  id: string;
  event_type: EventType;
  payload: ReservationPayload | SummaryPayload;
  attempts: number;
  delivery_cursor: number;
}

interface OutboxState {
  id: string;
  status: "pending" | "processing" | "sent" | "failed";
  attempts: number;
  delivery_cursor: number;
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

class PayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayloadError";
  }
}

class DeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryError";
  }
}

function jsonResponse(
  status: number,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function readBodyLimited(req: Request, limit: number): Promise<string> {
  const declaredLength = req.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength) || Number(declaredLength) > limit) {
      throw new RequestError(
        413,
        "BODY_TOO_LARGE",
        "Request body is too large",
      );
    }
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
      if (total > limit) {
        await reader.cancel("request body exceeded limit");
        throw new RequestError(
          413,
          "BODY_TOO_LARGE",
          "Request body is too large",
        );
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
    throw new RequestError(
      400,
      "INVALID_UTF8",
      "Request body must be valid UTF-8",
    );
  }
}

async function parseRequestId(req: Request): Promise<string> {
  const mediaType = req.headers.get("content-type")?.split(";", 1)[0].trim()
    .toLowerCase();
  if (mediaType !== "application/json") {
    throw new RequestError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "Content-Type must be application/json",
    );
  }

  const rawBody = await readBodyLimited(req, MAX_REQUEST_BYTES);
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    throw new RequestError(
      400,
      "INVALID_JSON",
      "Request body must be valid JSON",
    );
  }

  if (!isRecord(body)) {
    throw new RequestError(
      400,
      "INVALID_BODY",
      "Request body must be an object",
    );
  }

  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "id" || typeof body.id !== "string") {
    throw new RequestError(
      400,
      "INVALID_BODY",
      "Request body must contain only a string id",
    );
  }

  if (!UUID_PATTERN.test(body.id)) {
    throw new RequestError(400, "INVALID_ID", "id must be a canonical UUID");
  }

  return body.id.toLowerCase();
}

function assertOnlyKeys(
  record: JsonRecord,
  allowed: readonly string[],
  path: string,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedSet.has(key)) {
      throw new PayloadError(`${path}.${key} is not allowed`);
    }
  }
}

function assertOptionalText(
  record: JsonRecord,
  key: string,
  maxLength: number,
  path: string,
): void {
  const value = record[key];
  if (value === undefined || value === null) return;
  if (typeof value !== "string") {
    throw new PayloadError(`${path}.${key} must be a string or null`);
  }
  if (value.length > maxLength) {
    throw new PayloadError(`${path}.${key} exceeds ${maxLength} characters`);
  }
  if (hasUnsupportedPayloadControl(value)) {
    throw new PayloadError(
      `${path}.${key} contains unsupported control characters`,
    );
  }
}

function hasUnsupportedPayloadControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    const isRejectedC0 = codePoint <= 8 || codePoint === 11 ||
      codePoint === 12 || (codePoint >= 14 && codePoint <= 31);
    if (isRejectedC0 || codePoint === 127) return true;
  }
  return false;
}

function assertOptionalDisplayValue(
  record: JsonRecord,
  key: string,
  maxStringLength: number,
  path: string,
): void {
  const value = record[key];
  if (value === undefined || value === null) return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new PayloadError(`${path}.${key} must be a finite number`);
    }
    return;
  }
  assertOptionalText(record, key, maxStringLength, path);
}

function validateReservationPayload(payload: unknown): ReservationPayload {
  if (!isRecord(payload)) {
    throw new PayloadError("payload must be an object");
  }
  assertOnlyKeys(payload, RESERVATION_FIELDS, "payload");
  assertOptionalText(payload, "res_date", 64, "payload");
  assertOptionalText(payload, "res_time", 32, "payload");
  assertOptionalText(payload, "branch", 200, "payload");
  assertOptionalDisplayValue(payload, "guests_count", 32, "payload");
  assertOptionalText(payload, "menu_ko", 500, "payload");
  assertOptionalText(payload, "menu_vi", 500, "payload");
  assertOptionalText(payload, "guide_name", 200, "payload");
  assertOptionalText(payload, "note", 1_000, "payload");
  return payload as ReservationPayload;
}

function validateSummaryPayload(payload: unknown): SummaryPayload {
  if (!isRecord(payload)) {
    throw new PayloadError("payload must be an object");
  }
  assertOnlyKeys(payload, SUMMARY_FIELDS, "payload");
  assertOptionalText(payload, "date", 64, "payload");

  if (!Array.isArray(payload.rows)) {
    throw new PayloadError("payload.rows must be an array");
  }
  if (payload.rows.length > MAX_SUMMARY_ROWS) {
    throw new PayloadError(`payload.rows exceeds ${MAX_SUMMARY_ROWS} items`);
  }

  const rows = payload.rows.map((value, index) => {
    const path = `payload.rows[${index}]`;
    if (!isRecord(value)) {
      throw new PayloadError(`${path} must be an object`);
    }
    assertOnlyKeys(value, SUMMARY_ROW_FIELDS, path);
    assertOptionalText(value, "res_time", 32, path);
    assertOptionalText(value, "branch", 200, path);
    assertOptionalDisplayValue(value, "guests_count", 32, path);
    assertOptionalDisplayValue(value, "price", 64, path);
    assertOptionalText(value, "menu_ko", 500, path);
    assertOptionalText(value, "menu_vi", 500, path);
    assertOptionalText(value, "guide_name", 200, path);
    assertOptionalText(value, "note", 1_000, path);
    return value as SummaryRow;
  });

  return { date: payload.date as string | null | undefined, rows };
}

function parseClaimedRow(value: unknown): ClaimedOutboxRow {
  if (!isRecord(value)) throw new PayloadError("outbox row is not an object");
  if (typeof value.id !== "string" || !UUID_PATTERN.test(value.id)) {
    throw new PayloadError("outbox id is invalid");
  }
  if (
    value.event_type !== "resv_insert" &&
    value.event_type !== "daily_summary" &&
    value.event_type !== "tomorrow_summary"
  ) {
    throw new PayloadError("outbox event_type is unsupported");
  }
  if (!Number.isInteger(value.attempts) || Number(value.attempts) < 1) {
    throw new PayloadError("outbox attempts is invalid");
  }
  if (
    !Number.isInteger(value.delivery_cursor) ||
    Number(value.delivery_cursor) < 0 ||
    Number(value.delivery_cursor) > MAX_SUMMARY_ROWS
  ) {
    throw new PayloadError("outbox delivery cursor is invalid");
  }

  let encodedPayload: string;
  try {
    encodedPayload = JSON.stringify(value.payload);
  } catch {
    throw new PayloadError("outbox payload is not valid JSON");
  }
  if (new TextEncoder().encode(encodedPayload).byteLength > MAX_PAYLOAD_BYTES) {
    throw new PayloadError(`outbox payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
  }

  const payload = value.event_type === "resv_insert"
    ? validateReservationPayload(value.payload)
    : validateSummaryPayload(value.payload);

  return {
    id: value.id,
    event_type: value.event_type,
    payload,
    attempts: Number(value.attempts),
    delivery_cursor: Number(value.delivery_cursor),
  };
}

function renderDelivery(row: ClaimedOutboxRow): RenderedDelivery {
  try {
    if (row.event_type === "resv_insert") {
      if (row.delivery_cursor !== 0) {
        throw new RangeError("reservation delivery cursor must be zero");
      }
      return renderReservationDelivery(row.payload as ReservationPayload);
    }

    return renderSummaryDelivery(
      row.event_type,
      row.payload as SummaryPayload,
      row.delivery_cursor,
    );
  } catch (error) {
    if (error instanceof RangeError) {
      throw new PayloadError(error.message);
    }
    throw error;
  }
}

async function sendTelegram(message: string): Promise<{ simulated: boolean }> {
  const configuredSimulation = Deno.env.get("TG_NOTIFY_SIMULATION")?.trim()
    .toLowerCase();
  const projectRef = new URL(requiredEnv("SUPABASE_URL")).hostname.split(".")[0];
  // The dedicated security staging project never sends real Telegram messages.
  // Production still fails closed unless its Telegram secrets are configured.
  const simulation = configuredSimulation === "true" ||
    (configuredSimulation === undefined && projectRef === SECURITY_STAGING_PROJECT_REF);
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN")?.trim();
  const chatId = Deno.env.get("TELEGRAM_CHAT_ID")?.trim();

  if (simulation) return { simulated: true };
  if (!token) throw new DeliveryError("TELEGRAM_BOT_TOKEN is not configured");
  if (!chatId) throw new DeliveryError("TELEGRAM_CHAT_ID is not configured");
  if (token.length > 256 || chatId.length > 128) {
    throw new DeliveryError("Telegram configuration is invalid");
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
        redirect: "error",
        signal: controller.signal,
      },
    );

    const rawResponse = (await response.text()).slice(0, 8_192);
    let responseBody: unknown;
    try {
      responseBody = JSON.parse(rawResponse);
    } catch {
      responseBody = null;
    }

    if (!response.ok || !isRecord(responseBody) || responseBody.ok !== true) {
      const description = isRecord(responseBody) &&
          typeof responseBody.description === "string"
        ? responseBody.description.slice(0, 300)
        : "unexpected response";
      throw new DeliveryError(
        `Telegram rejected the message (HTTP ${response.status}): ${description}`,
      );
    }

    return { simulated: false };
  } catch (error) {
    if (error instanceof DeliveryError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new DeliveryError("Telegram request timed out");
    }
    throw new DeliveryError("Telegram request failed");
  } finally {
    clearTimeout(timeoutId);
  }
}

function parseOutboxState(value: unknown): OutboxState | null {
  if (value === null) return null;
  if (!isRecord(value)) {
    throw new Error("Invalid outbox state returned by database");
  }
  if (typeof value.id !== "string" || !UUID_PATTERN.test(value.id)) {
    throw new Error("Invalid outbox id returned by database");
  }
  if (
    value.status !== "pending" && value.status !== "processing" &&
    value.status !== "sent" && value.status !== "failed"
  ) {
    throw new Error("Invalid outbox status returned by database");
  }
  if (!Number.isInteger(value.attempts) || Number(value.attempts) < 0) {
    throw new Error("Invalid outbox attempts returned by database");
  }
  if (
    !Number.isInteger(value.delivery_cursor) ||
    Number(value.delivery_cursor) < 0 ||
    Number(value.delivery_cursor) > MAX_SUMMARY_ROWS
  ) {
    throw new Error("Invalid outbox delivery cursor returned by database");
  }
  return {
    id: value.id,
    status: value.status,
    attempts: Number(value.attempts),
    delivery_cursor: Number(value.delivery_cursor),
  };
}

type DatabaseClient = ReturnType<typeof createClient>;

async function getOutboxState(
  database: DatabaseClient,
  id: string,
): Promise<OutboxState | null> {
  const { data, error } = await database
    .from("notification_outbox")
    .select("id,status,attempts,delivery_cursor")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`Unable to read outbox state: ${error.code}`);
  return parseOutboxState(data as unknown);
}

async function claimOutbox(
  database: DatabaseClient,
  id: string,
  currentAttempts: number,
  currentCursor: number,
): Promise<unknown | null> {
  const now = new Date().toISOString();
  const { data, error } = await database
    .from("notification_outbox")
    .update({
      status: "processing",
      attempts: currentAttempts + 1,
      locked_at: now,
      processed_at: null,
      last_error: null,
    })
    .eq("id", id)
    .eq("status", "pending")
    .eq("attempts", currentAttempts)
    .eq("delivery_cursor", currentCursor)
    .select("id,event_type,payload,attempts,delivery_cursor")
    .maybeSingle();
  if (error) throw new Error(`Unable to claim outbox row: ${error.code}`);
  return data as unknown;
}

async function advanceDeliveryCursor(
  database: DatabaseClient,
  id: string,
  expectedCursor: number,
  expectedAttempts: number,
  nextCursor: number,
  completed: boolean,
): Promise<"pending" | "sent"> {
  if (nextCursor <= expectedCursor || nextCursor > MAX_SUMMARY_ROWS) {
    throw new Error("Invalid next outbox delivery cursor");
  }
  const nextStatus = completed ? "sent" : "pending";
  const { data, error } = await database
    .from("notification_outbox")
    .update({
      status: nextStatus,
      delivery_cursor: nextCursor,
      locked_at: null,
      processed_at: completed ? new Date().toISOString() : null,
      last_error: null,
    })
    .eq("id", id)
    .eq("status", "processing")
    .eq("attempts", expectedAttempts)
    .eq("delivery_cursor", expectedCursor)
    .select("id,status,delivery_cursor")
    .maybeSingle();
  if (error) {
    throw new Error(`Unable to advance outbox delivery: ${error.code}`);
  }
  if (!data) {
    throw new Error("Outbox delivery cursor changed before completion");
  }
  return nextStatus;
}

function storedError(error: unknown): string {
  const name = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error
    ? error.message
    : "Unknown processing error";
  let sanitized = "";
  for (const character of `${name}: ${message}`) {
    const codePoint = character.codePointAt(0) ?? 0;
    sanitized += codePoint <= 31 || codePoint === 127 ? " " : character;
  }
  return sanitized.slice(0, MAX_STORED_ERROR_LENGTH);
}

async function markFailed(
  database: DatabaseClient,
  id: string,
  expectedCursor: number,
  expectedAttempts: number,
  error: unknown,
): Promise<boolean> {
  const { data, error: updateError } = await database
    .from("notification_outbox")
    .update({
      status: "failed",
      processed_at: new Date().toISOString(),
      last_error: storedError(error),
    })
    .eq("id", id)
    .eq("status", "processing")
    .eq("attempts", expectedAttempts)
    .eq("delivery_cursor", expectedCursor)
    .select("id,attempts,delivery_cursor")
    .maybeSingle();
  if (updateError) {
    console.error("tg_notify_v2 failed to record outbox failure", {
      outbox_id: id,
      database_code: updateError.code,
    });
    return false;
  }
  return data !== null;
}

function responseForExistingState(state: OutboxState | null): Response {
  if (state === null) {
    return jsonResponse(404, { ok: false, code: "OUTBOX_NOT_FOUND" });
  }
  if (state.status === "sent") {
    return jsonResponse(200, {
      ok: true,
      status: "sent",
      idempotent: true,
      attempts: state.attempts,
      delivery_cursor: state.delivery_cursor,
    });
  }
  if (state.status === "processing") {
    return jsonResponse(409, {
      ok: false,
      code: "OUTBOX_ALREADY_PROCESSING",
      attempts: state.attempts,
      delivery_cursor: state.delivery_cursor,
    });
  }
  if (state.status === "failed") {
    return jsonResponse(409, {
      ok: false,
      code: "OUTBOX_FAILED",
      attempts: state.attempts,
      delivery_cursor: state.delivery_cursor,
    });
  }
  return jsonResponse(409, { ok: false, code: "OUTBOX_CLAIM_LOST" });
}

export async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return jsonResponse(
      405,
      { ok: false, code: "METHOD_NOT_ALLOWED" },
      { allow: "POST" },
    );
  }

  // verify_jwt=true is a required deployment control. This check also makes a
  // locally misconfigured invocation fail closed, but does not replace gateway
  // signature verification.
  const authorization = req.headers.get("authorization");
  if (!authorization || !/^Bearer\s+\S+$/.test(authorization)) {
    return jsonResponse(401, { ok: false, code: "UNAUTHORIZED" });
  }

  let id: string;
  try {
    id = await parseRequestId(req);
  } catch (error) {
    if (error instanceof RequestError) {
      return jsonResponse(error.status, { ok: false, code: error.code });
    }
    return jsonResponse(400, { ok: false, code: "INVALID_REQUEST" });
  }

  let database: DatabaseClient;
  try {
    const supabaseUrl = requiredEnv("SUPABASE_URL");
    const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
    database = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { "x-client-info": "dgv-tg-notify-v2/1.0" } },
    });
  } catch (error) {
    console.error("tg_notify_v2 configuration error", {
      error: storedError(error),
    });
    return jsonResponse(500, { ok: false, code: "SERVER_MISCONFIGURED" });
  }

  try {
    const initialState = await getOutboxState(database, id);
    if (initialState === null || initialState.status !== "pending") {
      return responseForExistingState(initialState);
    }

    const rawClaim = await claimOutbox(
      database,
      id,
      initialState.attempts,
      initialState.delivery_cursor,
    );
    if (rawClaim === null) {
      return responseForExistingState(await getOutboxState(database, id));
    }

    let failureCursor = initialState.delivery_cursor;
    let failureAttempts = initialState.attempts + 1;
    try {
      const claimed = parseClaimedRow(rawClaim);
      failureCursor = claimed.delivery_cursor;
      failureAttempts = claimed.attempts;
      if (
        claimed.delivery_cursor !== initialState.delivery_cursor ||
        claimed.attempts !== initialState.attempts + 1
      ) {
        throw new Error("Claimed outbox state differs from guarded claim");
      }

      // The summary cursor is the next unsent rows[] index, not a chunk number.
      // This invocation renders and sends only the largest complete-row group
      // beginning at that index, so a later packing deployment cannot skip rows.
      const rendered = renderDelivery(claimed);
      const telegram = await sendTelegram(rendered.message);
      const status = await advanceDeliveryCursor(
        database,
        claimed.id,
        claimed.delivery_cursor,
        claimed.attempts,
        rendered.nextCursor,
        rendered.completed,
      );

      if (telegram.simulated) {
        console.info("tg_notify_v2 staging simulation completed", {
          outbox_id: claimed.id,
          event_type: claimed.event_type,
          cursor_from: claimed.delivery_cursor,
          cursor_to: rendered.nextCursor,
          message_characters: rendered.message.length,
        });
      }

      return jsonResponse(200, {
        ok: true,
        status,
        simulated: telegram.simulated,
        attempts: claimed.attempts,
        delivery_cursor: rendered.nextCursor,
      });
    } catch (error) {
      await markFailed(
        database,
        id,
        failureCursor,
        failureAttempts,
        error,
      );
      console.error("tg_notify_v2 processing failed", {
        outbox_id: id,
        error: storedError(error),
      });
      if (error instanceof PayloadError) {
        return jsonResponse(422, { ok: false, code: "INVALID_OUTBOX_PAYLOAD" });
      }
      if (error instanceof DeliveryError) {
        return jsonResponse(502, {
          ok: false,
          code: "TELEGRAM_DELIVERY_FAILED",
        });
      }
      return jsonResponse(500, { ok: false, code: "OUTBOX_PROCESSING_FAILED" });
    }
  } catch (error) {
    console.error("tg_notify_v2 database operation failed", {
      outbox_id: id,
      error: storedError(error),
    });
    return jsonResponse(500, { ok: false, code: "DATABASE_OPERATION_FAILED" });
  }
}

Deno.serve(handler);
