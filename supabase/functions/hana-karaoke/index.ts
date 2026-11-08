// No npm dependencies or always-on application server. Deploy with verify_jwt=false:
// this endpoint uses its own room capabilities, not Supabase anonymous sign-ins.
const MAX_REQUEST_BYTES = 16 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^[a-f0-9]{64}$/;
const ACTIONS = new Set(["create", "state", "add", "remove", "up", "down", "next", "play", "pause", "ended", "close"]);
type JsonObject = Record<string, unknown>;
export interface KaraokeRequest {
  action: string;
  requestId: string;
  room?: string;
  token?: string;
  data: JsonObject;
}
export class RequestError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function allowedOrigin(origin: string): boolean {
  if (origin === "https://dalatgolfvoucher.com" || origin === "https://www.dalatgolfvoucher.com") return true;
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1") &&
      url.origin === origin;
  } catch { return false; }
}
function cors(req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  return origin && allowedOrigin(origin) ? {
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "authorization, apikey, content-type, x-client-info",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-max-age": "600",
    "vary": "Origin",
  } : {};
}
function response(req: Request, status: number, body: JsonObject): Response {
  return new Response(JSON.stringify(body), { status, headers: {
    ...cors(req), "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
    "referrer-policy": "no-referrer", "x-content-type-options": "nosniff",
    ...(status === 429 ? { "retry-after": "10" } : {}),
  } });
}
export async function readBodyLimited(req: Request): Promise<unknown> {
  const type = req.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (type !== "application/json") throw new RequestError(415, "UNSUPPORTED_MEDIA_TYPE", "Send application/json.");
  const length = req.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_REQUEST_BYTES)) {
    throw new RequestError(413, "BODY_TOO_LARGE", "Request body is too large.");
  }
  if (!req.body) throw new RequestError(400, "INVALID_JSON", "Send a JSON object.");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new RequestError(413, "BODY_TOO_LARGE", "Request body is too large.");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new RequestError(400, "INVALID_JSON", "Send valid UTF-8 JSON."); }
}
export function parseRequest(value: unknown): KaraokeRequest {
  const invalid = () => new RequestError(400, "INVALID_REQUEST", "Invalid karaoke request.");
  if (!isObject(value) || typeof value.action !== "string" || !ACTIONS.has(value.action) ||
    typeof value.requestId !== "string" || !UUID.test(value.requestId)) throw invalid();
  const action = value.action;
  const data: JsonObject = {};
  const keys = ["action", "requestId"];
  if (action !== "create") keys.push("room", "token");
  if (action === "add") {
    keys.push("videoId", "title");
    if (typeof value.videoId !== "string" || !/^[A-Za-z0-9_-]{11}$/.test(value.videoId) ||
      typeof value.title !== "string") throw invalid();
    const title = value.title.trim();
    if ([...title].length < 1 || [...title].length > 100 || /[\u0000-\u001f\u007f-\u009f]/u.test(title)) throw invalid();
    data.videoId = value.videoId;
    data.title = title;
  }
  if (["remove", "up", "down"].includes(action)) {
    keys.push("itemId");
    if (typeof value.itemId !== "string" || !UUID.test(value.itemId)) throw invalid();
    data.itemId = value.itemId.toLowerCase();
  }
  if (action === "next" || action === "ended") {
    keys.push("expectedCurrentId");
    if (value.expectedCurrentId !== null && (typeof value.expectedCurrentId !== "string" || !UUID.test(value.expectedCurrentId))) throw invalid();
    data.expectedCurrentId = typeof value.expectedCurrentId === "string" ? value.expectedCurrentId.toLowerCase() : null;
  }
  if (Object.keys(value).some((key) => !keys.includes(key))) throw invalid();
  const parsed: KaraokeRequest = { action, requestId: value.requestId.toLowerCase(), data };
  if (action !== "create") {
    if (typeof value.room !== "string" || !/^[1-9][0-9]{5}$/.test(value.room) ||
      typeof value.token !== "string" || !TOKEN.test(value.token)) {
      throw new RequestError(404, "ROOM_NOT_FOUND", "Room or invitation is invalid.");
    }
    parsed.room = value.room;
    parsed.token = value.token;
  }
  return parsed;
}
function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
export async function sha256(value: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}
export async function hmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}
function env(name: string): string {
  return Deno.env.get(name)?.trim() || "";
}
function namedKeys(name: string): string[] {
  try {
    const parsed: unknown = JSON.parse(env(name) || "{}");
    return isObject(parsed) ? Object.values(parsed).filter((value): value is string => typeof value === "string") : [];
  } catch { return []; }
}
function serverKey(): string {
  try {
    const keys: unknown = JSON.parse(env("SUPABASE_SECRET_KEYS") || "{}");
    if (isObject(keys) && typeof keys.default === "string" && keys.default) return keys.default;
  } catch { /* Legacy project keys remain supported. */ }
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!key) throw new Error("Server configuration unavailable");
  return key;
}
export function serviceHeaders(key: string): Record<string, string> {
  return { "content-type": "application/json", "apikey": key,
    ...(!key.startsWith("sb_secret_") ? { "authorization": `Bearer ${key}` } : {}) };
}
// Proxy-provided IP is a secondary abuse control, not identity. The global quota
// remains effective even if an upstream proxy ever passes a spoofed IP header.
function clientAddress(req: Request): string {
  return (req.headers.get("cf-connecting-ip")?.trim() || req.headers.get("x-real-ip")?.trim() ||
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown").slice(0, 128);
}
async function verifiedStaff(req: Request, url: string, key: string): Promise<boolean> {
  const authorization = req.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ") || authorization.length > 8192) return false;
  const result = await fetch(`${url}/auth/v1/user`, {
    headers: { apikey: key, authorization }, signal: AbortSignal.timeout(5000),
  });
  if (!result.ok) return false;
  const user: unknown = await result.json();
  return isObject(user) && typeof user.id === "string" && isObject(user.app_metadata) &&
    ["staff", "manager", "admin"].includes(String(user.app_metadata.role));
}
const DB_ERRORS: Record<string, [number, string, string]> = {
  KARAOKE_INVALID_REQUEST: [400, "INVALID_REQUEST", "Invalid karaoke request."],
  KARAOKE_STAFF_REQUIRED: [403, "STAFF_REQUIRED", "Staff sign-in is required to create a room."],
  KARAOKE_HOST_REQUIRED: [403, "HOST_REQUIRED", "This action requires the host invitation."],
  KARAOKE_ROOM_NOT_FOUND: [404, "ROOM_NOT_FOUND", "Room or invitation is invalid."],
  KARAOKE_ROOM_EXPIRED: [410, "ROOM_EXPIRED", "This room has expired."],
  KARAOKE_ROOM_CLOSED: [410, "ROOM_CLOSED", "This room is closed."],
  KARAOKE_IDEMPOTENCY_CONFLICT: [409, "IDEMPOTENCY_CONFLICT", "This request ID has already been used."],
  KARAOKE_QUEUE_FULL: [409, "QUEUE_FULL", "The queue is full (50 songs)."],
  KARAOKE_ROOM_LIMIT: [429, "ROOM_LIMIT", "Too many active rooms. Please try later."],
  KARAOKE_RATE_LIMITED: [429, "RATE_LIMITED", "Please wait before trying again."],
};
async function rpc(url: string, key: string, body: JsonObject): Promise<JsonObject> {
  const result = await fetch(`${url}/rest/v1/rpc/hana_karaoke_command`, {
    method: "POST", headers: serviceHeaders(key), body: JSON.stringify(body), signal: AbortSignal.timeout(8000),
  });
  const data: unknown = await result.json();
  if (!result.ok) {
    const message = isObject(data) && typeof data.message === "string" ? data.message : "";
    if (message === "KARAOKE_ROOM_COLLISION") throw new RequestError(409, "ROOM_COLLISION", "Please retry room creation.");
    const known = DB_ERRORS[message];
    if (known) throw new RequestError(...known);
    throw new Error("Database unavailable");
  }
  if (!isObject(data) || !isObject(data.state)) throw new Error("Invalid database response");
  return data;
}
async function broadcast(url: string, key: string, state: JsonObject): Promise<void> {
  // Public, random topic; invalidations are advisory. Clients always refetch the
  // capability-authorized state and never treat a broadcast payload as state.
  try {
    await fetch(`${url}/realtime/v1/api/broadcast`, {
      method: "POST", headers: serviceHeaders(key), signal: AbortSignal.timeout(2000),
      body: JSON.stringify({ messages: [{ topic: state.topic, event: "changed", payload: { revision: state.revision }, private: false }] }),
    });
  } catch { /* The DB transaction is already committed. Polling is the fallback. */ }
}
export async function handler(req: Request): Promise<Response> {
  const origin = req.headers.get("origin");
  if (origin && !allowedOrigin(origin)) return response(req, 403, { error: "Origin is not allowed.", code: "ORIGIN_NOT_ALLOWED" });
  if (req.method === "OPTIONS") {
    if (!origin) return response(req, 403, { error: "Origin is required.", code: "ORIGIN_NOT_ALLOWED" });
    return new Response(null, { status: 204, headers: cors(req) });
  }
  if (req.method !== "POST") return response(req, 405, { error: "Use POST.", code: "METHOD_NOT_ALLOWED" });
  try {
    const parsed = parseRequest(await readBodyLimited(req));
    const key = serverKey();
    const url = env("SUPABASE_URL").replace(/\/$/, "");
    if (!url) throw new Error("Server configuration unavailable");
    const publicKeys = [env("SUPABASE_ANON_KEY"), ...namedKeys("SUPABASE_PUBLISHABLE_KEYS")].filter(Boolean);
    if (!publicKeys.includes(req.headers.get("apikey") || "")) {
      throw new RequestError(401, "INVALID_API_KEY", "A valid public API key is required.");
    }
    let result: JsonObject;
    let hostToken: string | undefined;
    let joinToken: string | undefined;
    if (parsed.action === "create") {
      // A dedicated stable secret is recommended. Fallback keeps deployment
      // usable without provisioning another secret; rotating it ends retries.
      const secret = env("KARAOKE_TOKEN_SECRET") || key;
      const ipHash = await hmac(secret, `karaoke:ip:v1:${clientAddress(req)}`);
      const seed = `${parsed.requestId}:${ipHash}`;
      hostToken = await hmac(secret, `karaoke:host:v1:${seed}`);
      joinToken = await hmac(secret, `karaoke:join:v1:${seed}`);
      const topic = `hana-karaoke:${await hmac(secret, `karaoke:topic:v1:${seed}`)}`;
      const data = { hostHash: await sha256(hostToken), joinHash: await sha256(joinToken), topic };
      const staff = await verifiedStaff(req, url, key);
      let created: JsonObject | undefined;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const room = String(100000 + crypto.getRandomValues(new Uint32Array(1))[0] % 900000);
        try {
          created = await rpc(url, key, { p_action: "create", p_room: room, p_request_id: parsed.requestId, p_data: data, p_ip_hash: ipHash, p_is_staff: staff });
          break;
        } catch (error) {
          if (!(error instanceof RequestError) || error.code !== "ROOM_COLLISION" || attempt === 4) throw error;
        }
      }
      if (!created) throw new Error("Creation unavailable");
      result = created;
    } else {
      result = await rpc(url, key, { p_action: parsed.action, p_room: parsed.room, p_request_id: parsed.requestId,
        p_token_hash: await sha256(parsed.token!), p_data: parsed.data });
    }
    const state = result.state as JsonObject;
    if (result.changed === true) await broadcast(url, key, state);
    return response(req, 200, parsed.action === "create" ? { room: state.room, hostToken, joinToken, state } : { state });
  } catch (error) {
    if (error instanceof RequestError) return response(req, error.status, { error: error.message, code: error.code });
    // Never log a request, token, IP, title, database payload, or credential.
    return response(req, 503, { error: "Karaoke is temporarily unavailable. Please retry.", code: "SERVICE_UNAVAILABLE" });
  }
}
if (import.meta.main) Deno.serve(handler);
