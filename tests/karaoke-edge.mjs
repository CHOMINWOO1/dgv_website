// Run with Node 24: node --experimental-strip-types --test tests/karaoke-edge.mjs
// Every handler test replaces Deno.env and fetch. No production credentials,
// network requests, or database writes are used by this suite.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  allowedOrigin, handler, hmac, parseRequest, plainYoutubeText, RequestError, serviceHeaders, sha256, youtubeSearchResult,
} from "../supabase/functions/hana-karaoke/index.ts";

const REQUEST_ID = "2bda52d8-1c07-4a2e-b8cd-1af7915a40cd";
const OTHER_ID = "cde484a3-e625-47ba-b1b5-cda996e2136e";
const TOKEN = "a".repeat(64);
const VIDEO_ID = "dQw4w9WgXcQ";
const BASE_URL = "https://karaoke-unit.invalid";
const ORIGIN = "https://dalatgolfvoucher.com";
const createBody = () => ({ action: "create", requestId: REQUEST_ID });
const stateBody = () => ({ action: "state", requestId: REQUEST_ID, room: "123456", token: TOKEN });
const addBody = () => ({ ...stateBody(), action: "add", videoId: VIDEO_ID, title: "Song title" });
const searchBody = () => ({ ...stateBody(), action: "search", query: "봄날 karaoke", language: "ko" });
const youtubeFixture = () => ({ nextPageToken: "NEXT_page-2", items: [{
  id: { videoId: VIDEO_ID }, snippet: { title: "A &amp; B&#39;s &lt;Live&gt;", channelTitle: "Official &amp; Artist",
    thumbnails: { medium: { url: `https://i.ytimg.com/vi/${VIDEO_ID}/mqdefault.jpg?test=1` } } },
}] });

function request(body, headerOverrides = {}) {
  const headers = new Headers({
    "content-type": "application/json", apikey: "anon-unit", origin: ORIGIN,
    "x-real-ip": "192.0.2.1",
  });
  for (const [name, value] of Object.entries(headerOverrides)) {
    if (value === null) headers.delete(name);
    else headers.set(name, value);
  }
  return new Request(`${BASE_URL}/functions/v1/hana-karaoke`, {
    method: "POST", headers, body: JSON.stringify(body),
  });
}

function installMocks(t, options = {}) {
  const originalDeno = Object.getOwnPropertyDescriptor(globalThis, "Deno");
  const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  const env = {
    SUPABASE_URL: BASE_URL,
    SUPABASE_SECRET_KEYS: JSON.stringify({ default: "sb_secret_unit" }),
    SUPABASE_SERVICE_ROLE_KEY: "legacy-service-unit",
    SUPABASE_ANON_KEY: "anon-unit",
    SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: "sb_publishable_unit", web: "sb_publishable_web" }),
    KARAOKE_TOKEN_SECRET: "unit-test-stable-secret-not-a-production-credential",
    ...options.env,
  };
  const calls = [];
  const createdRooms = new Map();
  let collisions = options.collisions || 0;
  globalThis.Deno = { env: { get: (name) => env[name] } };
  globalThis.fetch = async (url, init) => {
    // Unknown URLs fail closed; the original fetch is never called.
    if (new URL(url).origin === "https://www.googleapis.com") {
      assert.equal(new URL(url).pathname, "/youtube/v3/search");
      calls.push({ url, init });
      if (options.youtubeThrows) throw new Error("simulated provider timeout with secret details");
      return Response.json(options.youtubeResponse ?? youtubeFixture(), { status: options.youtubeStatus || 200 });
    }
    assert.equal(new URL(url).origin, BASE_URL, "unexpected outbound destination");
    calls.push({ url, init });
    if (url === `${BASE_URL}/rest/v1/rpc/hana_karaoke_search_acquire`) {
      if (options.searchDbError) return Response.json({ message: options.searchDbError }, { status: 400 });
      const args = JSON.parse(init.body);
      return Response.json(options.searchAcquire ?? (args.p_enabled
        ? { status: "fetch", leaseId: OTHER_ID }
        : { status: "error", code: "SEARCH_NOT_CONFIGURED" }));
    }
    if (url === `${BASE_URL}/rest/v1/rpc/hana_karaoke_search_finish`) {
      if (options.finishThrows) throw new Error("simulated cache finish failure");
      return Response.json({ saved: true });
    }
    if (url === `${BASE_URL}/auth/v1/user`) {
      return Response.json(options.user ?? { id: "verified-user", app_metadata: { role: "staff" } }, {
        status: options.authStatus || 200,
      });
    }
    if (url === `${BASE_URL}/realtime/v1/api/broadcast`) {
      if (options.broadcastThrows) throw new Error("simulated broadcast outage");
      return Response.json({}, { status: options.broadcastStatus || 200 });
    }
    assert.equal(url, `${BASE_URL}/rest/v1/rpc/hana_karaoke_command`);
    if (options.rpcThrows) throw new Error("simulated database outage with sensitive details");
    if (options.dbError) return Response.json({ message: options.dbError }, { status: 400 });
    if (options.invalidRpcResponse) return Response.json({ unexpected: true });
    const args = JSON.parse(init.body);
    const state = {
      room: args.p_room, queue: [], current: null, playing: false, revision: 1,
      topic: args.p_data?.topic || `hana-karaoke:${"b".repeat(64)}`,
      expiresAt: "2099-01-01T00:00:00.000Z", closed: false,
    };
    if (args.p_action === "create") {
      if (collisions > 0) {
        collisions -= 1;
        return Response.json({ message: "KARAOKE_ROOM_COLLISION" }, { status: 400 });
      }
      const previous = createdRooms.get(args.p_request_id);
      if (previous) {
        if (previous.ipHash !== args.p_ip_hash) {
          return Response.json({ message: "KARAOKE_IDEMPOTENCY_CONFLICT" }, { status: 400 });
        }
        return Response.json({ state: previous.state, changed: false });
      }
      createdRooms.set(args.p_request_id, { ipHash: args.p_ip_hash, state });
    }
    return Response.json({ state, changed: options.changed ?? args.p_action !== "state" });
  };
  t.after(() => {
    if (originalDeno) Object.defineProperty(globalThis, "Deno", originalDeno);
    else delete globalThis.Deno;
    Object.defineProperty(globalThis, "fetch", originalFetch);
  });
  return {
    env, calls,
    rpcCalls: () => calls.filter(({ url }) => url.endsWith("/rest/v1/rpc/hana_karaoke_command")),
    broadcasts: () => calls.filter(({ url }) => url.endsWith("/realtime/v1/api/broadcast")),
    authCalls: () => calls.filter(({ url }) => url.endsWith("/auth/v1/user")),
    youtubeCalls: () => calls.filter(({ url }) => new URL(url).origin === "https://www.googleapis.com"),
    searchAcquires: () => calls.filter(({ url }) => url.endsWith("/hana_karaoke_search_acquire")),
    searchFinishes: () => calls.filter(({ url }) => url.endsWith("/hana_karaoke_search_finish")),
  };
}

async function expectError(response, status, code) {
  assert.equal(response.status, status);
  const body = await response.json();
  assert.equal(body.code, code);
  assert.equal(typeof body.error, "string");
  return body;
}

describe("hana-karaoke Edge contract (isolated mocks)", { concurrency: false }, () => {
  test("allows only the public site and exact loopback origins", () => {
    for (const origin of [ORIGIN, "https://www.dalatgolfvoucher.com", "http://localhost:4173", "https://127.0.0.1:9443"]) {
      assert.equal(allowedOrigin(origin), true);
    }
    for (const origin of ["null", "https://evil.com", `${ORIGIN}.evil.com`, "http://localhost.evil.com", "https://user@localhost", "http://127.0.0.1/path"]) {
      assert.equal(allowedOrigin(origin), false);
    }
  });

  test("OPTIONS allows a recognized origin without database access", async (t) => {
    const mocks = installMocks(t);
    const result = await handler(new Request(BASE_URL, { method: "OPTIONS", headers: { origin: ORIGIN } }));
    assert.equal(result.status, 204);
    assert.equal(result.headers.get("access-control-allow-origin"), ORIGIN);
    assert.equal(result.headers.get("vary"), "Origin");
    assert.equal(mocks.calls.length, 0);
  });

  test("OPTIONS without an origin is denied", async (t) => {
    const mocks = installMocks(t);
    await expectError(await handler(new Request(BASE_URL, { method: "OPTIONS" })), 403, "ORIGIN_NOT_ALLOWED");
    assert.equal(mocks.calls.length, 0);
  });

  test("unsupported methods and origins are denied before fetch", async (t) => {
    const mocks = installMocks(t);
    await expectError(await handler(new Request(BASE_URL)), 405, "METHOD_NOT_ALLOWED");
    await expectError(await handler(request(createBody(), { origin: "https://evil.com" })), 403, "ORIGIN_NOT_ALLOWED");
    assert.equal(mocks.calls.length, 0);
  });

  test("requires UUID request IDs and rejects unknown or extra fields", () => {
    for (const value of [null, [], {}, { action: "unsupported", requestId: REQUEST_ID },
      { action: "create", requestId: "bad" }, { ...createBody(), requireStaffToCreate: false },
      { ...createBody(), token: TOKEN }]) {
      assert.throws(() => parseRequest(value), RequestError);
    }
    assert.equal(parseRequest({ action: "create", requestId: REQUEST_ID.toUpperCase() }).requestId, REQUEST_ID);
  });

  test("requires a six-digit room and 256-bit hexadecimal capability", () => {
    for (const changes of [{ room: "12345" }, { room: "012345" }, { token: "bad" }, { token: "A".repeat(64) }]) {
      assert.throws(() => parseRequest({ ...stateBody(), ...changes }), { code: "ROOM_NOT_FOUND" });
    }
  });

  test("validates video IDs and trims bounded Unicode song titles", () => {
    assert.equal(parseRequest({ ...addBody(), title: "  A song  " }).data.title, "A song");
    assert.equal([...parseRequest({ ...addBody(), title: "🎵".repeat(100) }).data.title].length, 100);
    for (const changes of [{ videoId: "invalid" }, { title: " " }, { title: "🎵".repeat(101) }, { title: "bad\u0000title" }]) {
      assert.throws(() => parseRequest({ ...addBody(), ...changes }), { code: "INVALID_REQUEST" });
    }
  });

  test("next and ended require an explicit current-item guard", () => {
    for (const action of ["next", "ended"]) {
      assert.throws(() => parseRequest({ ...stateBody(), action }), { code: "INVALID_REQUEST" });
      assert.equal(parseRequest({ ...stateBody(), action, expectedCurrentId: null }).data.expectedCurrentId, null);
      assert.equal(parseRequest({ ...stateBody(), action, expectedCurrentId: OTHER_ID.toUpperCase() }).data.expectedCurrentId, OTHER_ID);
    }
  });

  test("queue item actions require a UUID and normalize it", () => {
    for (const action of ["remove", "up", "down"]) {
      assert.throws(() => parseRequest({ ...stateBody(), action, itemId: "bad" }), RequestError);
      assert.equal(parseRequest({ ...stateBody(), action, itemId: OTHER_ID.toUpperCase() }).data.itemId, OTHER_ID);
    }
  });

  test("rejects unsupported content type before fetch", async (t) => {
    const mocks = installMocks(t);
    await expectError(await handler(request(createBody(), { "content-type": "text/plain" })), 415, "UNSUPPORTED_MEDIA_TYPE");
    assert.equal(mocks.calls.length, 0);
  });

  test("enforces both declared and actual 16 KiB body limits", async (t) => {
    const mocks = installMocks(t);
    await expectError(await handler(request(createBody(), { "content-length": "16385" })), 413, "BODY_TOO_LARGE");
    await expectError(await handler(request({ ...addBody(), title: "x".repeat(17000) })), 413, "BODY_TOO_LARGE");
    assert.equal(mocks.calls.length, 0);
  });

  test("rejects malformed JSON and invalid UTF-8", async (t) => {
    const mocks = installMocks(t);
    for (const body of ["{broken", new Uint8Array([0xff])]) {
      await expectError(await handler(new Request(BASE_URL, {
        method: "POST", headers: { "content-type": "application/json" }, body,
      })), 400, "INVALID_JSON");
    }
    assert.equal(mocks.calls.length, 0);
  });

  test("rejects missing, incorrect, and server API keys at the public boundary", async (t) => {
    const mocks = installMocks(t);
    for (const apikey of [null, "wrong", "sb_secret_unit", "legacy-service-unit"]) {
      await expectError(await handler(request(stateBody(), { apikey })), 401, "INVALID_API_KEY");
    }
    assert.equal(mocks.calls.length, 0);
  });

  test("accepts legacy anon and named publishable API keys", async (t) => {
    const mocks = installMocks(t);
    for (const apikey of ["anon-unit", "sb_publishable_unit", "sb_publishable_web"]) {
      assert.equal((await handler(request(stateBody(), { apikey }))).status, 200);
    }
    assert.equal(mocks.rpcCalls().length, 3);
  });

  test("prefers the new default secret and sends it only as apikey", async (t) => {
    const mocks = installMocks(t);
    assert.equal((await handler(request(createBody()))).status, 200);
    for (const { init } of [...mocks.rpcCalls(), ...mocks.broadcasts()]) {
      assert.equal(init.headers.apikey, "sb_secret_unit");
      assert.equal(init.headers.authorization, undefined);
    }
    assert.equal(serviceHeaders("sb_secret_example").authorization, undefined);
  });

  test("supports legacy service-role keys when the new key map is unavailable", async (t) => {
    const mocks = installMocks(t, { env: { SUPABASE_SECRET_KEYS: "malformed JSON" } });
    assert.equal((await handler(request(stateBody()))).status, 200);
    const headers = mocks.rpcCalls()[0].init.headers;
    assert.equal(headers.apikey, "legacy-service-unit");
    assert.equal(headers.authorization, "Bearer legacy-service-unit");
  });

  test("crypto helpers produce stable, domain-separated 256-bit values", async () => {
    assert.equal(await sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    const host = await hmac("test-key", "host:seed");
    assert.match(host, /^[0-9a-f]{64}$/);
    assert.equal(await hmac("test-key", "host:seed"), host);
    assert.notEqual(await hmac("test-key", "join:seed"), host);
  });

  test("public creation needs no Auth session and returns separate capabilities", async (t) => {
    const mocks = installMocks(t);
    const result = await handler(request(createBody()));
    assert.equal(result.status, 200);
    const data = await result.json();
    assert.match(data.room, /^[1-9][0-9]{5}$/);
    assert.match(data.hostToken, /^[0-9a-f]{64}$/);
    assert.match(data.joinToken, /^[0-9a-f]{64}$/);
    assert.notEqual(data.hostToken, data.joinToken);
    assert.equal(mocks.authCalls().length, 0);
    assert.equal(JSON.parse(mocks.rpcCalls()[0].init.body).p_is_staff, false);
    assert.deepEqual(Object.keys(data).sort(), ["hostToken", "joinToken", "room", "state"]);
  });

  test("creation sends only hashed capabilities and hashed IP to the database", async (t) => {
    const mocks = installMocks(t);
    const result = await (await handler(request(createBody()))).json();
    const args = JSON.parse(mocks.rpcCalls()[0].init.body);
    assert.equal(args.p_data.hostHash, await sha256(result.hostToken));
    assert.equal(args.p_data.joinHash, await sha256(result.joinToken));
    assert.match(args.p_ip_hash, /^[0-9a-f]{64}$/);
    assert.match(args.p_data.topic, /^hana-karaoke:[0-9a-f]{64}$/);
    assert.equal(args.p_request_id, REQUEST_ID);
    assert.equal(mocks.rpcCalls()[0].init.body.includes(result.hostToken), false);
    assert.equal(mocks.rpcCalls()[0].init.body.includes(result.joinToken), false);
    assert.equal(mocks.rpcCalls()[0].init.body.includes("192.0.2.1"), false);
    assert.notEqual(args.p_data.topic.slice("hana-karaoke:".length), result.hostToken);
    assert.notEqual(args.p_data.topic.slice("hana-karaoke:".length), result.joinToken);
  });

  test("a create retry recovers the same capabilities and room without rebroadcast", async (t) => {
    const mocks = installMocks(t);
    const first = await (await handler(request(createBody()))).json();
    const second = await (await handler(request(createBody()))).json();
    assert.deepEqual(second, first);
    assert.equal(mocks.rpcCalls().length, 2);
    assert.equal(mocks.broadcasts().length, 1);
  });

  test("creation retry derivation binds the request ID to hashed caller IP", async (t) => {
    const mocks = installMocks(t);
    assert.equal((await handler(request(createBody()))).status, 200);
    await expectError(await handler(request(createBody(), { "x-real-ip": "192.0.2.2" })), 409, "IDEMPOTENCY_CONFLICT");
    const [first, second] = mocks.rpcCalls().map(({ init }) => JSON.parse(init.body));
    assert.notEqual(first.p_ip_hash, second.p_ip_hash);
    assert.notEqual(first.p_data.hostHash, second.p_data.hostHash);
    assert.notEqual(first.p_data.joinHash, second.p_data.joinHash);
    assert.notEqual(first.p_data.topic, second.p_data.topic);
  });

  test("verified staff authorization uses Auth app_metadata, never client claims", async (t) => {
    const mocks = installMocks(t);
    assert.equal((await handler(request(createBody(), { authorization: "Bearer verified-user-token" }))).status, 200);
    assert.equal(mocks.authCalls().length, 1);
    assert.deepEqual(mocks.authCalls()[0].init.headers, {
      apikey: "sb_secret_unit", authorization: "Bearer verified-user-token",
    });
    assert.equal(JSON.parse(mocks.rpcCalls()[0].init.body).p_is_staff, true);
  });

  test("user_metadata cannot grant staff permission", async (t) => {
    const mocks = installMocks(t, { user: { id: "verified-user", user_metadata: { role: "admin" }, app_metadata: { role: "guest" } } });
    assert.equal((await handler(request(createBody(), { authorization: "Bearer verified-user-token" }))).status, 200);
    assert.equal(JSON.parse(mocks.rpcCalls()[0].init.body).p_is_staff, false);
  });

  test("failed optional Auth validation cannot grant staff permission", async (t) => {
    const mocks = installMocks(t, { authStatus: 401 });
    assert.equal((await handler(request(createBody(), { authorization: "Bearer invalid-user-token" }))).status, 200);
    assert.equal(JSON.parse(mocks.rpcCalls()[0].init.body).p_is_staff, false);
  });

  test("room actions hash their capability and preserve request/current-item IDs", async (t) => {
    const mocks = installMocks(t);
    const result = await handler(request({ ...stateBody(), action: "ended", expectedCurrentId: OTHER_ID }));
    assert.equal(result.status, 200);
    const args = JSON.parse(mocks.rpcCalls()[0].init.body);
    assert.equal(args.p_token_hash, await sha256(TOKEN));
    assert.equal(args.p_request_id, REQUEST_ID);
    assert.equal(args.p_data.expectedCurrentId, OTHER_ID);
    assert.equal(args.p_is_staff, undefined);
    assert.equal(args.token, undefined);
    assert.deepEqual(Object.keys(await result.json()), ["state"]);
  });

  test("broadcasts contain invalidation revision only on the opaque public topic", async (t) => {
    const mocks = installMocks(t);
    const response = await (await handler(request(createBody()))).json();
    const message = JSON.parse(mocks.broadcasts()[0].init.body).messages[0];
    assert.equal(message.topic, response.state.topic);
    assert.equal(message.event, "changed");
    assert.equal(message.private, false);
    assert.deepEqual(message.payload, { revision: response.state.revision });
  });

  test("state reads and unchanged RPC responses do not broadcast", async (t) => {
    const mocks = installMocks(t, { changed: false });
    assert.equal((await handler(request(stateBody()))).status, 200);
    assert.equal((await handler(request({ ...stateBody(), action: "pause" }))).status, 200);
    assert.equal(mocks.broadcasts().length, 0);
  });

  test("broadcast network failure does not turn a committed action into an error", async (t) => {
    const mocks = installMocks(t, { broadcastThrows: true });
    const result = await handler(request({ ...stateBody(), action: "pause" }));
    assert.equal(result.status, 200);
    assert.ok((await result.json()).state);
    assert.equal(mocks.broadcasts().length, 1);
  });

  test("broadcast HTTP failure also preserves the acknowledged action", async (t) => {
    installMocks(t, { broadcastStatus: 503 });
    assert.equal((await handler(request({ ...stateBody(), action: "pause" }))).status, 200);
  });

  test("room-code collisions retry without changing creation capability hashes", async (t) => {
    const mocks = installMocks(t, { collisions: 2 });
    assert.equal((await handler(request(createBody()))).status, 200);
    assert.equal(mocks.rpcCalls().length, 3);
    const args = mocks.rpcCalls().map(({ init }) => JSON.parse(init.body));
    for (const retry of args.slice(1)) {
      assert.deepEqual(retry.p_data, args[0].p_data);
      assert.equal(retry.p_request_id, args[0].p_request_id);
    }
  });

  test("room-code collision retries are capped at five attempts", async (t) => {
    const mocks = installMocks(t, { collisions: 10 });
    await expectError(await handler(request(createBody())), 409, "ROOM_COLLISION");
    assert.equal(mocks.rpcCalls().length, 5);
    assert.equal(mocks.broadcasts().length, 0);
  });

  for (const [dbError, status, code] of [
    ["KARAOKE_INVALID_REQUEST", 400, "INVALID_REQUEST"],
    ["KARAOKE_STAFF_REQUIRED", 403, "STAFF_REQUIRED"],
    ["KARAOKE_HOST_REQUIRED", 403, "HOST_REQUIRED"],
    ["KARAOKE_ROOM_NOT_FOUND", 404, "ROOM_NOT_FOUND"],
    ["KARAOKE_ROOM_EXPIRED", 410, "ROOM_EXPIRED"],
    ["KARAOKE_ROOM_CLOSED", 410, "ROOM_CLOSED"],
    ["KARAOKE_IDEMPOTENCY_CONFLICT", 409, "IDEMPOTENCY_CONFLICT"],
    ["KARAOKE_QUEUE_FULL", 409, "QUEUE_FULL"],
    ["KARAOKE_ROOM_LIMIT", 429, "ROOM_LIMIT"],
    ["KARAOKE_RATE_LIMITED", 429, "RATE_LIMITED"],
  ]) {
    test(`maps ${dbError} to a safe structured response`, async (t) => {
      const mocks = installMocks(t, { dbError });
      const result = await handler(request(stateBody()));
      await expectError(result, status, code);
      if (status === 429) assert.equal(result.headers.get("retry-after"), "10");
      assert.equal(mocks.broadcasts().length, 0);
    });
  }

  test("unknown database errors are hidden from callers", async (t) => {
    installMocks(t, { dbError: "private SQL details and credentials" });
    const result = await expectError(await handler(request(stateBody())), 503, "SERVICE_UNAVAILABLE");
    assert.equal(JSON.stringify(result).includes("private SQL"), false);
  });

  test("database transport failure is a generic retryable response", async (t) => {
    installMocks(t, { rpcThrows: true });
    const result = await expectError(await handler(request(stateBody())), 503, "SERVICE_UNAVAILABLE");
    assert.equal(JSON.stringify(result).includes("sensitive"), false);
  });

  test("invalid database response fails closed", async (t) => {
    installMocks(t, { invalidRpcResponse: true });
    await expectError(await handler(request(stateBody())), 503, "SERVICE_UNAVAILABLE");
  });

  test("successful responses are not cacheable and do not leak a referrer", async (t) => {
    installMocks(t);
    const result = await handler(request(stateBody()));
    assert.equal(result.status, 200);
    assert.equal(result.headers.get("cache-control"), "no-store");
    assert.equal(result.headers.get("referrer-policy"), "no-referrer");
    assert.equal(result.headers.get("x-content-type-options"), "nosniff");
    assert.equal(result.headers.get("access-control-allow-origin"), ORIGIN);
  });

  test("priority false or omitted preserves legacy add fingerprints", () => {
    {
      const legacy = parseRequest(addBody()).data;
      assert.deepEqual(parseRequest({ ...addBody(), priority: false }).data, legacy);
      assert.equal(Object.hasOwn(legacy, "priority"), false);
      assert.equal(parseRequest({ ...addBody(), priority: true }).data.priority, true);
    }
    for (const priority of ["true", 1, null]) assert.throws(() => parseRequest({ ...addBody(), priority }), RequestError);
  });

  test("prioritize is a validated item action", async (t) => {
    const mocks = installMocks(t);
    assert.throws(() => parseRequest({ ...stateBody(), action: "prioritize", itemId: "bad" }), RequestError);
    assert.equal((await handler(request({ ...stateBody(), action: "prioritize", itemId: OTHER_ID }))).status, 200);
    const body = JSON.parse(mocks.rpcCalls()[0].init.body);
    assert.equal(body.p_action, "prioritize");
    assert.deepEqual(body.p_data, { itemId: OTHER_ID });
  });

  test("search validates bounded Unicode query, supported language, and page token", () => {
    assert.equal(parseRequest({ ...searchBody(), query: "  봄날   karaoke  " }).data.query, "봄날 karaoke");
    assert.equal(parseRequest({ ...searchBody(), query: "🎵".repeat(100) }).data.query.length, 200);
    assert.equal(parseRequest({ ...searchBody(), pageToken: "CAUQAA==" }).data.pageToken, "CAUQAA==");
    for (const changes of [{ query: " " }, { query: "x".repeat(101) }, { query: "bad\u0000query" },
      { language: "ja" }, { pageToken: "" }, { pageToken: "x".repeat(259) }, { pageToken: "https://evil.com" }, { youtubeKey: "bad" }]) {
      assert.throws(() => parseRequest({ ...searchBody(), ...changes }), RequestError);
    }
  });

  test("unconfigured search still authenticates the room and reserves no external call", async (t) => {
    const mocks = installMocks(t);
    await expectError(await handler(request(searchBody())), 503, "SEARCH_NOT_CONFIGURED");
    assert.equal(mocks.searchAcquires().length, 1);
    assert.equal(JSON.parse(mocks.searchAcquires()[0].init.body).p_enabled, false);
    assert.equal(mocks.youtubeCalls().length, 0);
    assert.equal(mocks.searchFinishes().length, 0);
  });

  for (const [dbError, status, code] of [["KARAOKE_ROOM_NOT_FOUND", 404, "ROOM_NOT_FOUND"],
    ["KARAOKE_ROOM_CLOSED", 410, "ROOM_CLOSED"], ["KARAOKE_ROOM_EXPIRED", 410, "ROOM_EXPIRED"],
    ["KARAOKE_SEARCH_RATE_LIMITED", 429, "SEARCH_RATE_LIMITED"]]) {
    test(`search makes no YouTube call when room gate returns ${dbError}`, async (t) => {
      const mocks = installMocks(t, { env: { YOUTUBE_API_KEY: "youtube-unit-secret" }, searchDbError: dbError });
      await expectError(await handler(request(searchBody())), status, code);
      assert.equal(mocks.youtubeCalls().length, 0);
      assert.equal(mocks.searchFinishes().length, 0);
    });
  }

  test("search calls only the official API with required filters and secret header", async (t) => {
    const mocks = installMocks(t, { env: { YOUTUBE_API_KEY: "youtube-unit-secret" } });
    const result = await handler(request({ ...searchBody(), query: "A&B = love", pageToken: "NEXT_page-2" }));
    assert.equal(result.status, 200);
    assert.equal(mocks.youtubeCalls().length, 1);
    const google = mocks.youtubeCalls()[0];
    const url = new URL(google.url);
    assert.equal(url.origin + url.pathname, "https://www.googleapis.com/youtube/v3/search");
    for (const [name, value] of Object.entries({ part: "snippet", type: "video", videoEmbeddable: "true", videoSyndicated: "true", maxResults: "10", safeSearch: "moderate", q: "A&B = love", relevanceLanguage: "ko", pageToken: "NEXT_page-2" })) {
      assert.equal(url.searchParams.get(name), value);
    }
    assert.equal(url.searchParams.has("key"), false);
    assert.equal(google.url.includes("youtube-unit-secret"), false);
    assert.equal(google.init.headers["x-goog-api-key"], "youtube-unit-secret");
    assert.equal(google.init.headers.apikey, undefined);
    assert.equal(google.init.headers.authorization, undefined);
    assert.equal(google.init.redirect, "error");
    assert.ok(google.init.signal instanceof AbortSignal);
    const data = await result.json();
    assert.deepEqual(Object.keys(data).sort(), ["items", "nextPageToken", "source"]);
    assert.equal(data.source, "youtube");
    assert.equal(data.items[0].title, "A & B's <Live>");
    assert.equal(data.items[0].channelTitle, "Official & Artist");
    assert.equal(data.items[0].thumbnail, `https://i.ytimg.com/vi/${VIDEO_ID}/mqdefault.jpg?test=1`);
    assert.equal(JSON.stringify(data).includes("youtube-unit-secret"), false);
    assert.equal(mocks.broadcasts().length, 0);
  });

  test("search database requests contain only query hash and capability hash", async (t) => {
    const mocks = installMocks(t, { env: { YOUTUBE_API_KEY: "youtube-unit-secret" } });
    assert.equal((await handler(request(searchBody()))).status, 200);
    const acquired = JSON.parse(mocks.searchAcquires()[0].init.body);
    assert.equal(acquired.p_token_hash, await sha256(TOKEN));
    assert.match(acquired.p_cache_key, /^[0-9a-f]{64}$/);
    assert.equal(acquired.p_request_id, REQUEST_ID);
    assert.equal(mocks.searchAcquires()[0].init.body.includes(searchBody().query), false);
    assert.equal(mocks.searchAcquires()[0].init.body.includes(TOKEN), false);
    const finish = JSON.parse(mocks.searchFinishes()[0].init.body);
    assert.equal(finish.p_cache_key, acquired.p_cache_key);
    assert.equal(finish.p_lease_id, OTHER_ID);
    assert.equal(finish.p_error, null);
    assert.equal(finish.p_result.source, "youtube");
  });

  test("a cache hit uses no Google quota, completion call, or broadcast", async (t) => {
    const cached = youtubeSearchResult(youtubeFixture());
    const mocks = installMocks(t, { env: { YOUTUBE_API_KEY: "youtube-unit-secret" }, searchAcquire: { status: "cached", result: cached } });
    assert.deepEqual(await (await handler(request(searchBody()))).json(), cached);
    assert.equal(mocks.youtubeCalls().length, 0);
    assert.equal(mocks.searchFinishes().length, 0);
    assert.equal(mocks.broadcasts().length, 0);
  });

  for (const code of ["SEARCH_QUOTA_EXCEEDED", "SEARCH_RATE_LIMITED"]) {
    test(`${code} gate spends no upstream call`, async (t) => {
      const mocks = installMocks(t, { env: { YOUTUBE_API_KEY: "youtube-unit-secret" }, searchAcquire: { status: "error", code } });
      await expectError(await handler(request(searchBody())), 429, code);
      assert.equal(mocks.youtubeCalls().length, 0);
    });
  }

  test("Google quota failure is recorded without exposing upstream error details", async (t) => {
    const mocks = installMocks(t, { env: { YOUTUBE_API_KEY: "youtube-unit-secret" }, youtubeStatus: 403,
      youtubeResponse: { error: { message: "sensitive upstream details", errors: [{ reason: "quotaExceeded" }] } } });
    const result = await expectError(await handler(request(searchBody())), 429, "SEARCH_QUOTA_EXCEEDED");
    assert.equal(JSON.stringify(result).includes("sensitive"), false);
    assert.equal(mocks.youtubeCalls().length, 1);
    const finish = JSON.parse(mocks.searchFinishes()[0].init.body);
    assert.equal(finish.p_error, "SEARCH_QUOTA_EXCEEDED");
    assert.equal(finish.p_result, null);
  });

  test("upstream network errors are not automatically retried", async (t) => {
    const mocks = installMocks(t, { env: { YOUTUBE_API_KEY: "youtube-unit-secret" }, youtubeThrows: true });
    await expectError(await handler(request(searchBody())), 503, "SEARCH_UNAVAILABLE");
    assert.equal(mocks.youtubeCalls().length, 1);
    assert.equal(JSON.parse(mocks.searchFinishes()[0].init.body).p_error, "SEARCH_UNAVAILABLE");
  });

  test("a cache write failure does not retry Google or hide successful results", async (t) => {
    const mocks = installMocks(t, { env: { YOUTUBE_API_KEY: "youtube-unit-secret" }, finishThrows: true });
    assert.equal((await handler(request(searchBody()))).status, 200);
    assert.equal(mocks.youtubeCalls().length, 1);
    assert.equal(mocks.searchFinishes().length, 1);
  });

  test("malformed provider payload is a safe error and still spends only one call", async (t) => {
    const mocks = installMocks(t, { env: { YOUTUBE_API_KEY: "youtube-unit-secret" }, youtubeResponse: { secret: "do not return" } });
    await expectError(await handler(request(searchBody())), 503, "SEARCH_UNAVAILABLE");
    assert.equal(mocks.youtubeCalls().length, 1);
    assert.equal(JSON.parse(mocks.searchFinishes()[0].init.body).p_error, "SEARCH_UNAVAILABLE");
  });

  test("provider result sanitizer bounds text, video IDs, thumbnails, and result count", () => {
    assert.equal(plainYoutubeText("&#x1f3b5; &amp; &#39;\u0000"), "🎵 & '");
    assert.equal([...plainYoutubeText("🎵".repeat(101))].length, 100);
    const item = youtubeFixture().items[0];
    const duplicateAndInvalid = youtubeSearchResult({ items: [item, item, { ...item, id: { videoId: "bad" } }] });
    assert.equal(duplicateAndInvalid.items.length, 1);
    for (const url of ["http://i.ytimg.com/x.jpg", "https://evil.com/x.jpg", "https://i.ytimg.com.evil.com/x.jpg", "https://user@i.ytimg.com/x.jpg", "https://i.ytimg.com:444/x.jpg"]) {
      const result = youtubeSearchResult({ items: [{ ...item, snippet: { ...item.snippet, thumbnails: { medium: { url } } } }] });
      assert.equal(result.items[0].thumbnail, "");
    }
    const ten = Array.from({ length: 20 }, (_, i) => ({ ...item, id: { videoId: String(i).padStart(11, "0") } }));
    assert.equal(youtubeSearchResult({ items: ten }).items.length, 10);
    assert.equal(youtubeSearchResult({ items: [item], nextPageToken: "bad token" }).nextPageToken, null);
  });
});
