import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";

const STAFF_ACCOUNT_EMAIL = "staff@dgv.local";
const ADMIN_ACCOUNT_EMAIL = "admin@dgv.local";
const ADMIN_SETTING_KEY = "delete_password";
const MAX_REQUEST_BYTES = 512;
const MIN_SHARED_PASSWORD_LENGTH = 4;
const MAX_SHARED_PASSWORD_LENGTH = 128;

const ALLOWED_ORIGINS = new Set([
  "https://dalatgolfvoucher.com",
  "https://www.dalatgolfvoucher.com",
  "http://127.0.0.1:4173",
  "http://localhost:4173",
]);

type Action = "get_staff_code" | "set_staff_code" | "set_admin_password";
type JsonRecord = Record<string, unknown>;
type DatabaseClient = SupabaseClient;

interface ParsedRequest {
  action: Action;
  newPassword?: string;
}

interface StaffCodeRow {
  code: string;
  updated_at: string;
}

interface AdminSettingRow {
  key: string;
  value_hash: string;
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

function normalizeSharedPassword(value: unknown): string {
  if (typeof value !== "string") {
    throw new RequestError(400, "INVALID_PASSWORD", "new_password must be a string");
  }
  const password = value.trim();
  if (
    password.length < MIN_SHARED_PASSWORD_LENGTH ||
    password.length > MAX_SHARED_PASSWORD_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(password)
  ) {
    throw new RequestError(
      400,
      "INVALID_PASSWORD",
      `new_password must contain ${MIN_SHARED_PASSWORD_LENGTH} to ${MAX_SHARED_PASSWORD_LENGTH} printable characters`,
    );
  }
  return password;
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
    throw new RequestError(400, "INVALID_BODY", "Request body is invalid");
  }

  if (value.action === "get_staff_code") {
    if (Object.keys(value).length !== 1) {
      throw new RequestError(400, "INVALID_BODY", "Unexpected request fields");
    }
    return { action: value.action };
  }
  if (
    value.action !== "set_staff_code" && value.action !== "set_admin_password"
  ) {
    throw new RequestError(400, "INVALID_ACTION", "Unsupported action");
  }
  if (
    Object.keys(value).length !== 2 ||
    !Object.prototype.hasOwnProperty.call(value, "new_password")
  ) {
    throw new RequestError(400, "INVALID_BODY", "Unexpected request fields");
  }
  return {
    action: value.action,
    newPassword: normalizeSharedPassword(value.new_password),
  };
}

function bearerToken(req: Request): string {
  const authorization = req.headers.get("authorization") || "";
  const match = authorization.match(/^Bearer\s+(\S+)$/i);
  if (!match) throw new RequestError(401, "UNAUTHORIZED", "Authorization is required");
  return match[1];
}

function appRole(user: User): string | null {
  const role = String(user.app_metadata?.role || "").toLowerCase();
  return role === "admin" || role === "staff" ? role : null;
}

function derivedAuthPassword(role: "staff" | "admin", raw: string): string {
  return `dgv-v2/${role}/${raw}`;
}

async function requireAdmin(
  database: DatabaseClient,
  token: string,
): Promise<User> {
  const { data, error } = await database.auth.getUser(token);
  if (error || !data.user) {
    throw new RequestError(401, "UNAUTHORIZED", "Session is invalid");
  }
  if (
    appRole(data.user) !== "admin" ||
    data.user.email?.toLowerCase() !== ADMIN_ACCOUNT_EMAIL
  ) {
    throw new RequestError(403, "ADMIN_REQUIRED", "Admin role is required");
  }
  return data.user;
}

async function getStaffCode(
  database: DatabaseClient,
): Promise<StaffCodeRow | null> {
  const { data, error } = await database
    .from("page_access_code")
    .select("code,updated_at")
    .eq("id", 1)
    .maybeSingle();
  if (error) throw new Error(`Unable to read staff code: ${error.code}`);
  return data as StaffCodeRow | null;
}

async function getAdminSetting(
  database: DatabaseClient,
): Promise<AdminSettingRow | null> {
  const { data, error } = await database
    .from("admin_settings")
    .select("key,value_hash")
    .eq("key", ADMIN_SETTING_KEY)
    .maybeSingle();
  if (error) throw new Error(`Unable to read admin setting: ${error.code}`);
  return data as AdminSettingRow | null;
}

async function findStaffUser(database: DatabaseClient): Promise<User> {
  for (let page = 1; page <= 10; page += 1) {
    const { data, error } = await database.auth.admin.listUsers({
      page,
      perPage: 100,
    });
    if (error) throw new Error("Unable to read technical Auth users");
    const user = data.users.find((candidate) =>
      candidate.email?.toLowerCase() === STAFF_ACCOUNT_EMAIL &&
      appRole(candidate) === "staff"
    );
    if (user) return user;
    if (data.users.length < 100) break;
  }
  throw new RequestError(
    409,
    "STAFF_ACCOUNT_MISSING",
    "The staff technical Auth account is not configured",
  );
}

async function restoreStaffCode(
  database: DatabaseClient,
  previous: StaffCodeRow | null,
): Promise<void> {
  if (previous) {
    const { error } = await database.from("page_access_code").upsert({
      id: 1,
      code: previous.code,
      updated_at: previous.updated_at,
    }, { onConflict: "id" });
    if (error) throw error;
  } else {
    const { error } = await database.from("page_access_code").delete().eq("id", 1);
    if (error) throw error;
  }
}

async function setStaffCode(
  database: DatabaseClient,
  password: string,
): Promise<void> {
  const staffUser = await findStaffUser(database);
  const previous = await getStaffCode(database);
  const { error: settingError } = await database.from("page_access_code").upsert({
    id: 1,
    code: password,
    updated_at: new Date().toISOString(),
  }, { onConflict: "id" });
  if (settingError) throw new Error(`Unable to store staff code: ${settingError.code}`);

  const { error: authError } = await database.auth.admin.updateUserById(
    staffUser.id,
    { password: derivedAuthPassword("staff", password) },
  );
  if (!authError) return;

  try {
    await restoreStaffCode(database, previous);
  } catch (rollbackError) {
    console.error("staff credential rollback failed", {
      error: rollbackError instanceof Error ? rollbackError.message : "unknown",
    });
  }
  throw new Error("Unable to update the staff Auth account");
}

async function hashLegacyPassword(
  database: DatabaseClient,
  password: string,
): Promise<string> {
  const { data, error } = await database.rpc("internal_hash_legacy_password", {
    p_password: password,
  });
  if (error || typeof data !== "string" || !data.startsWith("$2")) {
    throw new Error("Unable to hash the legacy admin password");
  }
  return data;
}

async function restoreAdminSetting(
  database: DatabaseClient,
  previous: AdminSettingRow | null,
): Promise<void> {
  if (previous) {
    const { error } = await database.from("admin_settings").upsert(previous, {
      onConflict: "key",
    });
    if (error) throw error;
  } else {
    const { error } = await database.from("admin_settings").delete().eq(
      "key",
      ADMIN_SETTING_KEY,
    );
    if (error) throw error;
  }
}

async function setAdminPassword(
  database: DatabaseClient,
  adminUser: User,
  password: string,
): Promise<void> {
  const previous = await getAdminSetting(database);
  const valueHash = await hashLegacyPassword(database, password);
  const { error: settingError } = await database.from("admin_settings").upsert({
    key: ADMIN_SETTING_KEY,
    value_hash: valueHash,
  }, { onConflict: "key" });
  if (settingError) {
    throw new Error(`Unable to store admin password hash: ${settingError.code}`);
  }

  const { error: authError } = await database.auth.admin.updateUserById(
    adminUser.id,
    { password: derivedAuthPassword("admin", password) },
  );
  if (!authError) return;

  try {
    await restoreAdminSetting(database, previous);
  } catch (rollbackError) {
    console.error("admin credential rollback failed", {
      error: rollbackError instanceof Error ? rollbackError.message : "unknown",
    });
  }
  throw new Error("Unable to update the admin Auth account");
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
    const token = bearerToken(req);
    const parsed = await parseRequest(req);
    const database = createClient(
      requiredEnv("SUPABASE_URL"),
      requiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const adminUser = await requireAdmin(database, token);

    if (parsed.action === "get_staff_code") {
      const row = await getStaffCode(database);
      return jsonResponse(req, 200, {
        ok: true,
        staff_code: row?.code || "",
        updated_at: row?.updated_at || null,
      });
    }

    if (parsed.action === "set_staff_code") {
      await setStaffCode(database, parsed.newPassword!);
    } else {
      await setAdminPassword(database, adminUser, parsed.newPassword!);
    }
    return jsonResponse(req, 200, { ok: true });
  } catch (error) {
    if (error instanceof RequestError) {
      return jsonResponse(req, error.status, { ok: false, code: error.code });
    }
    console.error("admin credential settings failed", {
      error: error instanceof Error ? error.message : "unknown",
    });
    return jsonResponse(req, 500, { ok: false, code: "INTERNAL_ERROR" });
  }
}

Deno.serve(handler);
