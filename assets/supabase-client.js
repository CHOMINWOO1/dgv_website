(function initDgvSupabase(global) {
  "use strict";

  const config = global.DGV_SUPABASE_CONFIG;
  if (!config?.url || !config?.publishableKey || !config?.authAccounts?.staff || !config?.authAccounts?.admin) {
    throw new Error("Supabase public configuration is missing.");
  }
  if (!global.supabase?.createClient) {
    throw new Error("The pinned Supabase JavaScript client failed to load.");
  }
  if (!global.DGV_DATA_UTILS) {
    throw new Error("DGV data utilities failed to load.");
  }

  const projectRef = new URL(config.url).hostname.split(".")[0];
  const client = global.supabase.createClient(config.url, config.publishableKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storage: global.sessionStorage,
      storageKey: `dgv-${projectRef}-auth`
    }
  });

  const VALID_ROLES = Object.freeze(["staff", "admin"]);

  function roleOf(user) {
    const role = String(user?.app_metadata?.role || "").toLowerCase();
    return VALID_ROLES.includes(role) ? role : null;
  }

  function normalizeRoles(roles) {
    const requested = Array.isArray(roles) ? roles : [roles];
    const normalized = requested.map((role) => String(role || "").toLowerCase());
    if (!normalized.length || normalized.some((role) => !VALID_ROLES.includes(role))) {
      throw new Error("Route guard contains an invalid role.");
    }
    return normalized;
  }

  function escapeHTML(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  async function getVerifiedUser() {
    const { data: sessionData, error: sessionError } = await client.auth.getSession();
    if (sessionError || !sessionData?.session) return null;

    // getUser performs an Auth-server request, so authorization is not based on
    // an unverified value read only from browser storage.
    const { data, error } = await client.auth.getUser();
    if (error || !data?.user) return null;
    return data.user;
  }

  async function signInAs(role, password) {
    const normalizedRole = String(role || "").toLowerCase();
    if (!VALID_ROLES.includes(normalizedRole)) throw new Error("Invalid authentication role.");
    if (!password) throw new Error("비밀번호를 입력하세요.");

    const { error } = await client.auth.signInWithPassword({
      email: config.authAccounts[normalizedRole],
      password: `dgv-v2/${normalizedRole}/${String(password)}`
    });
    if (error) throw error;

    const user = await getVerifiedUser();
    const actualRole = roleOf(user);
    if (!user || actualRole !== normalizedRole) {
      await client.auth.signOut({ scope: "local" });
      throw new Error("계정 역할 설정이 올바르지 않습니다.");
    }
    return { user, role: actualRole };
  }

  async function requireAuth(options = {}) {
    const roles = normalizeRoles(options.roles || VALID_ROLES);
    const user = await getVerifiedUser();
    const role = roleOf(user);
    if (user && role && roles.includes(role)) return { user, role };
    throw new Error("AUTH_REQUIRED");
  }

  async function getIdentity() {
    const user = await getVerifiedUser();
    return user ? { user, role: roleOf(user) } : { user: null, role: null };
  }

  async function authHeaders(extra = {}) {
    const { data } = await client.auth.getSession();
    const accessToken = data?.session?.access_token;
    const headers = {
      apikey: config.publishableKey,
      ...extra
    };
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    return headers;
  }

  async function signOut(options = {}) {
    // These are intentionally shared technical accounts. Clearing one browser
    // tab must never revoke staff/admin sessions on other devices.
    await client.auth.signOut({ scope: "local" });
    if (options.reload !== false) global.location.reload();
  }

  global.DGV = Object.freeze({
    config,
    supabase: client,
    validRoles: VALID_ROLES,
    roleOf,
    signInAs,
    getIdentity,
    requireAuth,
    authHeaders,
    signOut,
    escapeHTML,
    formatLocalYmd: global.DGV_DATA_UTILS.formatLocalYmd,
    formatYmdInTimeZone: global.DGV_DATA_UTILS.formatYmdInTimeZone,
    collectSupabasePages: global.DGV_DATA_UTILS.collectSupabasePages,
    collectRestPages: global.DGV_DATA_UTILS.collectRestPages
  });
})(window);
