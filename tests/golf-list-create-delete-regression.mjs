import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// No network/database: real page logic executes against in-memory RPC fixtures.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [listSource, listPage, childSource, childPage, bookingSource] = await Promise.all([
  "assets/golf-reserv-list.js", "golf_reserv_list.html", "assets/golf-reserv.js", "golf_reserv.html", "assets/golf-bookings.js",
].map((file) => readFile(path.join(root, file), "utf8")));
const id = (n) => `50000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const token = id(900), origin = "https://golf-create.test";
const base = { id: id(1), counterparty_name: "QA AGENCY", representative_name: "A", player_names_en: "A\nB", pax: 2,
  golf_date: "2027-01-25", golf_time: "09:00:00", golf_course: "SAM", holes: 18, status: "in_progress",
  customer_type: "company", cost_settlement_type: "golf_course", guest_unit_price_vnd: null, guest_total_vnd: null,
  course_unit_price_vnd: null, course_total_vnd: null, deposit_amount_vnd: 0, final_received_amount_vnd: null,
  created_at: "2026-10-25T00:00:00Z", updated_at: "2026-10-25T00:00:00Z", note: "", payments: [] };
const groups = [{ id: id(100), label: "QA GROUP", version: 7, completed_at: null, completion_date: null }];
const groupPayments = [{ id: id(110), booking_group_id: id(100), payment_kind: "deposit", amount_vnd: 2000000,
  payment_date: "2026-10-25", payment_method: "bank", completes_booking: false, sort_order: 0 }];
const initialRows = [base, { ...base, id: id(2), booking_group_id: id(100), pax: 7 },
  { ...base, id: id(3), booking_group_id: id(100), golf_date: "2027-01-26", pax: 8 }];
function events(object = {}) {
  object.events = new Map(); object.addEventListener = function (type, fn) { this.events.set(type, [...(this.events.get(type) || []), fn]); }; return object;
}
function element(name) {
  const classes = new Set();
  return events({ id: name, value: "", hidden: false, checked: false, disabled: false, open: false, dataset: {}, attributes: {},
    innerHTML: "", textContent: "", scrollLeft: 0, scrollTop: 0, options: [],
    classList: { add: (...v) => v.forEach((x) => classes.add(x)), remove: (...v) => v.forEach((x) => classes.delete(x)), contains: (v) => classes.has(v) },
    setAttribute(n, v) { this.attributes[n] = String(v); }, getAttribute(n) { return this.attributes[n] ?? null; }, removeAttribute(n) { delete this.attributes[n]; },
    querySelectorAll() { return []; }, querySelector() { return null; }, setCustomValidity() {}, focus() {}, scrollIntoView() {},
    add(option) { this.options.push(option); }, append(option) { this.options.push(option); }, reset() {},
    showModal() { this.open = true; }, close() { this.open = false; }, getBoundingClientRect() { return { left: 1, top: 1, right: 500, bottom: 500 }; },
  });
}
function dom(page) {
  const elements = new Map([...page.matchAll(/\bid="([^"]+)"/g)].map((m) => [m[1], element(m[1])]));
  const get = (name) => { assert.ok(elements.has(name), `Missing DOM fixture ${name}`); return elements.get(name); };
  const sheet = element("sheet");
  return { get, elements, sheet, document: events({ body: element("body"), getElementById: get,
    querySelector: (selector) => selector === ".golf-sheet-wrap" ? sheet : null, querySelectorAll: () => [] }) };
}
async function dispatch(target, type, input = {}) { for (const fn of target.events.get(type) || []) await fn({ preventDefault() {}, stopPropagation() {}, ...input }); }
const quietConsole = { ...console, error() {} };
const escapeHTML = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function childHarness(search = `?embedded=1&create=1&editorToken=${token}`) {
  const view = dom(childPage), sent = [], calls = [], warnings = [], toasts = [];
  let confirmResult = false, sequence = 950, handler = async () => ({ data: [{ saved_id: id(50), saved_status: "in_progress" }], error: null });
  const parent = { postMessage: (data, targetOrigin) => sent.push({ data, targetOrigin }) };
  const window = events({ parent, location: { origin, search, pathname: "/golf_reserv.html", hash: "" }, history: { replaceState() {} },
    confirm: (text) => { warnings.push(text); return confirmResult; }, crypto: { randomUUID: () => id(++sequence) },
    DGV: { escapeHTML, formatYmdInTimeZone: () => "2026-10-25", supabase: { rpc: async (name, args) => { calls.push({ name, args: structuredClone(args) }); return handler(name, args); } } },
    QRStaff: { toast: (text) => toasts.push(text), connectionBadge() {}, messageOf: (error, fallback) => error?.message || fallback,
      setBusy: (button, busy, label) => { button.disabled = busy; if (label) button.textContent = label; } },
  });
  view.get("reservationForm").querySelectorAll = () => [...view.elements.values()];
  view.get("reservationForm").reset = () => { for (const input of view.elements.values()) { input.value = ""; input.checked = false; } };
  vm.runInNewContext(childSource.replace(/\n  init\(\);/, "\n  global.__test = {state,embeddedEditor,configureEmbeddedEditor,completeEmbeddedLoad,handleEditorMessage,requestEmbeddedClose,resetForm,fillForm,save,changeBookingMode,addCreateRound,switchCreateRound,collectCreatePayload,bindEvents};"),
    { window, document: view.document, console: quietConsole, URL, URLSearchParams, Option: function (text, value) { return { text, value }; } });
  return { ...view, api: window.__test, window, parent, sent, calls, warnings, toasts, rpc: (fn) => { handler = fn; }, confirm: (value) => { confirmResult = value; } };
}
const setFields = (child, values) => { for (const [name, value] of Object.entries(values)) child.get(name).value = value; };
const validFields = { counterpartyName: "QA AGENCY", customerType: "company", playerNamesEn: "A\nB", pax: "2", golfDate: "2027-01-25",
  golfHour: "09", golfMinute: "00", golfCourse: "SAM", holes: "18", costSettlementType: "golf_course" };
function readyCreate(child) { child.api.configureEmbeddedEditor(); child.api.bindEvents(); child.api.resetForm({ focus: false }); child.api.completeEmbeddedLoad(); }
function closeRequest(child, overrides = {}) { child.api.handleEditorMessage({ origin, source: child.parent, data: { type: "golf-editor-request-close", mode: "create", token }, ...overrides }); }

for (const search of [`?embedded=1&create=1&edit=${id(1)}&editorToken=${token}`, `?embedded=1&create=1&editorToken=invalid`, `?embedded=0&create=1&editorToken=${token}`]) {
  const malformed = childHarness(search); malformed.api.configureEmbeddedEditor();
  assert.equal(malformed.api.embeddedEditor, null); assert.equal(malformed.document.body.classList.contains("golf-embedded"), false);
}
let single = childHarness();
assert.equal(single.api.embeddedEditor.mode, "create");
await single.api.save({ preventDefault() {} }); assert.equal(single.calls.length, 0, "Create is disabled before auth/ready");
readyCreate(single);
assert.equal(single.api.embeddedEditor.ready, true); assert.equal(single.sent.at(-1).data.type, "golf-editor-ready");
assert.equal(single.sent.at(-1).data.mode, "create"); assert.equal(single.sent.at(-1).data.recordId, null);
assert.equal(single.document.body.classList.contains("golf-embedded-create"), true);
single.api.state.rows = [base]; single.api.fillForm(base);
assert.equal(single.get("recordId").value, "", "Create iframe cannot load an existing reservation into its form");
single.get("recordId").value = id(1); setFields(single, validFields);
await single.api.save({ preventDefault() {} }); assert.equal(single.calls.length, 0, "Forged record ID cannot turn create into update");
single.get("recordId").value = "";
for (const field of ["counterpartyName", "playerNamesEn", "golfDate", "golfHour", "golfCourse"]) {
  const original = single.get(field).value; single.get(field).value = "";
  await single.api.save({ preventDefault() {} }); assert.equal(single.calls.length, 0, `${field} is still required`); single.get(field).value = original;
}
single.get("pax").value = "0";
await single.api.save({ preventDefault() {} }); assert.equal(single.calls.length, 0, "Pax must be positive (blank may derive from named guests)");
single.get("pax").value = "2";
single.api.state.formDirty = true;
const beforeWrong = single.sent.length;
for (const override of [{ origin: "https://evil.test" }, { source: {} }, { data: { type: "golf-editor-request-close", mode: "edit", token } },
  { data: { type: "golf-editor-request-close", token } }, { data: { type: "golf-editor-request-close", mode: "create", token: "wrong" } }]) closeRequest(single, override);
assert.equal(single.sent.length, beforeWrong); assert.equal(single.warnings.length, 0);
closeRequest(single); assert.equal(single.sent.at(-1).data.type, "golf-editor-close-blocked"); assert.equal(single.api.state.formDirty, true);
single.confirm(true); closeRequest(single); assert.equal(single.sent.at(-1).data.type, "golf-editor-close"); assert.equal(single.sent.at(-1).data.recordId, null);
let unloadPrevented = false;
await dispatch(single.window, "beforeunload", { preventDefault() { unloadPrevented = true; } });
assert.equal(unloadPrevented, false, "Confirmed create cancel does not trigger a second unload warning");
await single.api.save({ preventDefault() {} }); assert.equal(single.calls.length, 0, "Confirmed close ends creation authority");
single = childHarness(); readyCreate(single); setFields(single, validFields);
let finishSingle;
single.rpc(() => new Promise((resolve) => { finishSingle = resolve; }));
const pendingSingle = single.api.save({ preventDefault() {} });
assert.equal(single.calls.length, 1); assert.equal(single.calls[0].name, "save_golf_reservation_with_payments");
assert.equal(single.calls[0].args.p_reservation_id, null); assert.equal(single.calls[0].args.p_reservation.guest_unit_price_vnd, null);
assert.equal(single.calls[0].args.p_reservation.course_unit_price_vnd, null, "Pending create permits unknown prices/costs");
assert.equal(single.get("playerNamesEn").disabled, true);
await single.api.save({ preventDefault() {} }); assert.equal(single.calls.length, 1);
closeRequest(single); assert.equal(single.sent.at(-1).data.type, "golf-editor-close-blocked");
finishSingle({ data: [{ saved_id: id(50), saved_status: "in_progress" }], error: null }); await pendingSingle;
assert.equal(single.sent.at(-1).data.type, "golf-editor-saved"); assert.equal(single.sent.at(-1).data.recordId, id(50));
assert.equal(single.sent.at(-1).data.mode, "create"); assert.equal(single.api.state.saving, true);
assert.ok(!Object.hasOwn(single.sent.at(-1).data, "payments") && !Object.hasOwn(single.sent.at(-1).data, "reservation"), "Messages never carry financial mutation payloads");

const rejected = childHarness(); readyCreate(rejected); setFields(rejected, validFields); rejected.api.state.formDirty = true;
rejected.rpc(async () => ({ data: null, error: { code: "23514", message: "Validation rejected" } }));
await rejected.api.save({ preventDefault() {} });
assert.equal(rejected.api.state.saving, false); assert.equal(rejected.get("playerNamesEn").disabled, false);
assert.equal(rejected.api.state.formDirty, true); assert.ok(!rejected.api.embeddedEditor.createUncertain);

const uncertain = childHarness(); readyCreate(uncertain); setFields(uncertain, validFields); uncertain.api.state.formDirty = true;
uncertain.rpc(async () => { throw new TypeError("Mock lost response after possible commit"); });
await uncertain.api.save({ preventDefault() {} });
assert.equal(uncertain.api.embeddedEditor.createUncertain, true); assert.equal(uncertain.get("playerNamesEn").disabled, true);
await uncertain.api.save({ preventDefault() {} }); assert.equal(uncertain.calls.length, 1, "Ambiguous single creation is never replayed without idempotency");
closeRequest(uncertain); assert.equal(uncertain.sent.at(-1).data.type, "golf-editor-close-blocked");
uncertain.confirm(true); closeRequest(uncertain);
assert.equal(uncertain.sent.at(-1).data.type, "golf-editor-close"); assert.equal(uncertain.sent.at(-1).data.refreshRequired, true);
assert.equal(uncertain.sent.at(-1).data.recordId, null);

const grouped = childHarness(); readyCreate(grouped); setFields(grouped, { ...validFields, playerNamesEn: "A\nB\nC\nD\nE\nF\nG", pax: "7" });
grouped.get("bookingMode").value = "group"; grouped.api.changeBookingMode();
assert.equal(grouped.api.state.createGroupMode, true);
await grouped.api.save({ preventDefault() {} }); assert.equal(grouped.calls.length, 0, "Grouped creation requires at least two schedules");
grouped.api.addCreateRound();
setFields(grouped, { ...validFields, playerNamesEn: "A\nB\nC\nD\nE\nF\nG\nH", pax: "8", golfDate: "2027-01-26" });
grouped.api.state.paymentDrafts.deposit = [{ id: null, payment_kind: "deposit", amount_vnd: 2000000, payment_date: "2026-10-25", payment_method: "bank", sort_order: 0 }];
const payload = JSON.stringify(grouped.api.collectCreatePayload());
assert.deepEqual(Array.from(grouped.api.collectCreatePayload().p_rounds, (round) => round.pax), [7, 8]);
assert.equal(grouped.api.collectCreatePayload().p_payments.length, 1);
grouped.get("paymentCompleted").checked = true;
await grouped.api.save({ preventDefault() {} }); assert.equal(grouped.calls.length, 0, "Completing a group still requires every round cost");
grouped.get("paymentCompleted").checked = false;
grouped.rpc(async () => { throw new TypeError("Mock ambiguous group create"); });
await grouped.api.save({ preventDefault() {} });
assert.equal(grouped.api.state.createAttempt.uncertain, true); assert.equal(grouped.get("playerNamesEn").disabled, true);
unloadPrevented = false;
await dispatch(grouped.window, "beforeunload", { preventDefault() { unloadPrevented = true; } });
assert.equal(unloadPrevented, true, "Ambiguous grouped creation remains protected against unload");
grouped.confirm(true); closeRequest(grouped); assert.equal(grouped.sent.at(-1).data.type, "golf-editor-close-blocked");
grouped.get("bookingMode").value = "single"; grouped.api.changeBookingMode(); assert.equal(grouped.api.state.createGroupMode, true);
grouped.rpc(async () => ({ data: [{ saved_id: id(51), saved_status: "in_progress", booking_group_id: id(101) }], error: null }));
await grouped.api.save({ preventDefault() {} });
assert.equal(grouped.calls.length, 2); assert.equal(grouped.calls[0].name, "create_golf_booking_group");
for (const call of grouped.calls) assert.equal(JSON.stringify(call.args), payload, "Ambiguous grouped retry reuses the exact idempotency key and immutable payload");
assert.equal(grouped.sent.at(-1).data.type, "golf-editor-saved"); assert.equal(grouped.sent.at(-1).data.recordId, id(51));
assert.equal(grouped.api.state.saving, true); assert.equal(grouped.get("playerNamesEn").disabled, true);
unloadPrevented = false;
await dispatch(grouped.window, "beforeunload", { preventDefault() { unloadPrevented = true; } });
assert.equal(unloadPrevented, false, "Successful embedded group creation must not show a false unsaved prompt during iframe teardown");
assert.match(childSource, /requireLogin\(\{ roles: \["manager", "admin"\]/);

// Host create and deletion assertions follow below; all mutation handlers are mocks.
function hostHarness() {
  const view = dom(listPage), calls = [], warnings = [], messages = [], navigations = [], scrolls = [], connections = [];
  const server = { rows: structuredClone(initialRows), groups: structuredClone(groups), payments: structuredClone(groupPayments),
    reads: 0, failRead: false, readGate: null };
  let confirmResult = false, mutate = async (_name, args) => ({ data: args?.p_group_id || args?.p_reservation_id, error: null });
  view.get("statusFilter").value = "all";
  view.get("inlineEditFrame").contentWindow = { postMessage: (data, targetOrigin) => messages.push({ data, targetOrigin }) };
  const supabase = {
    from(table) { return { table, filters: [], mutation: false, select(columns) { this.columns = columns; return this; }, in() { return this; },
      delete() { this.mutation = true; return this; }, eq(field, value) { this.filters.push([field, value]); return this; },
      async single() { assert.equal(this.mutation, true); const args = { table, filters: this.filters, columns: this.columns }; calls.push({ name: "delete", args }); return mutate("delete", args); } }; },
    async rpc(name, args) { calls.push({ name, args: structuredClone(args) }); return mutate(name, args); },
  };
  const window = events({ location: { origin, href: `${origin}/golf_reserv_list.html`, assign: (href) => navigations.push(href) },
    crypto: { randomUUID: () => token }, setTimeout: () => 1, clearTimeout() {}, scrollX: 4, scrollY: 60, scrollTo: (...args) => scrolls.push(args),
    confirm: (text) => { warnings.push(text); return confirmResult; }, print() {},
    DGV: { escapeHTML, supabase, async collectSupabasePages(build) { const query = build(); server.reads++;
      if (server.readOverride) return server.readOverride(query);
      if (server.readGate) await server.readGate; if (server.failRead) throw new Error("Mock read failure");
      return query.table === "golf_reservations" ? structuredClone(server.rows) : []; } },
    QRStaff: { toast() {}, connectionBadge: (...args) => connections.push(args), messageOf: (error, fallback) => error?.message || fallback },
  });
  const context = { window, document: view.document, console: quietConsole, URL, URLSearchParams };
  vm.runInNewContext(bookingSource, context);
  window.GolfBookings = { ...window.GolfBookings, async loadAndAttach(rows) {
    if (server.beforeAttach) await server.beforeAttach(rows);
    const present = new Set(rows.map((row) => row.booking_group_id).filter(Boolean));
    const attached = window.GolfBookings.attach(rows, server.groups.filter((group) => present.has(group.id)), server.payments.filter((payment) => present.has(payment.booking_group_id)));
    for (const row of rows) row.booking = attached.find((item) => item.id === row.id).booking;
  } };
  vm.runInNewContext(listSource.replace(/\n  init\(\);/, "\n  global.__test = {state,bindEvents,loadRows,openInlineCreate,openInlineEditor,onInlineEditorMessage,requestInlineEditorClose,openReservationDetail,closeReservationDetail,deleteReservation,deletionWarning};"), context);
  window.__test.bindEvents();
  return { ...view, window, api: window.__test, server, calls, warnings, messages, navigations, scrolls, connections,
    confirm: (value) => { confirmResult = value; }, mutation: (fn) => { mutate = fn; } };
}
const hostMessage = (host, type, extraData = {}, override = {}) => ({ origin, source: host.get("inlineEditFrame").contentWindow,
  data: { type, mode: "create", token, recordId: null, ...extraData }, ...override });
const createHost = hostHarness(); await createHost.api.loadRows();
const filters = { searchInput: "QA", statusFilter: "in_progress", filterFrom: "2027-01-25", filterTo: "2027-01-26" };
for (const [name, value] of Object.entries(filters)) createHost.get(name).value = value;
createHost.sheet.scrollLeft = 125; createHost.sheet.scrollTop = 35;
await dispatch(createHost.get("addReservationButton"), "click");
assert.equal(createHost.api.state.editor.mode, "create"); assert.equal(createHost.api.state.editor.recordId, null);
const createUrl = new URL(createHost.get("inlineEditFrame").src);
assert.equal(createUrl.origin, origin); assert.equal(createUrl.searchParams.get("create"), "1"); assert.equal(createUrl.searchParams.get("embedded"), "1");
assert.equal(createUrl.searchParams.get("editorToken"), token); assert.equal(createUrl.searchParams.has("edit"), false);
assert.equal(createHost.get("inlineEditFrame").hidden, false);
for (const [data, override] of [ [{ mode: "edit" }, {}], [{ mode: undefined }, {}], [{ recordId: id(1) }, {}], [{ token: "wrong" }, {}], [{}, { source: {} }], [{}, { origin: "https://evil.test" }] ]) {
  await createHost.api.onInlineEditorMessage(hostMessage(createHost, "golf-editor-ready", data, override));
  assert.equal(createHost.api.state.editor.ready, false);
}
await createHost.api.onInlineEditorMessage(hostMessage(createHost, "golf-editor-saved", { recordId: id(50) }));
assert.notEqual(createHost.api.state.editor, null, "Create saved before ready is ignored");
await createHost.api.onInlineEditorMessage(hostMessage(createHost, "golf-editor-ready"));
assert.equal(createHost.api.state.editor.ready, true);
createHost.api.requestInlineEditorClose();
assert.equal(createHost.messages.at(-1).data.mode, "create"); assert.equal(createHost.messages.at(-1).targetOrigin, origin);
await createHost.api.onInlineEditorMessage(hostMessage(createHost, "golf-editor-delete", { payments: [{ amount_vnd: 999 }], reservation: base }));
assert.equal(createHost.calls.length, 0, "Messages cannot cause arbitrary financial mutations");
await createHost.api.onInlineEditorMessage(hostMessage(createHost, "golf-editor-saved", { recordId: "invalid" }));
assert.notEqual(createHost.api.state.editor, null);
createHost.server.rows.push({ ...base, id: id(50), golf_date: "2027-02-01", note: "authoritative created record" });
await createHost.api.onInlineEditorMessage(hostMessage(createHost, "golf-editor-saved", { recordId: id(50) }));
assert.equal(createHost.api.state.editor, null); assert.equal(createHost.api.state.detailId, id(50));
assert.match(createHost.get("reservationDetailContent").innerHTML, /authoritative created record/);
assert.match(createHost.get("pageBanner").textContent, /조건 밖/);
for (const [name, value] of Object.entries(filters)) assert.equal(createHost.get(name).value, value);
assert.equal(createHost.sheet.scrollLeft, 125); assert.equal(createHost.sheet.scrollTop, 35); assert.deepEqual(createHost.scrolls.at(-1), [4, 60]);
assert.equal(createHost.calls.length, 0); assert.deepEqual(createHost.navigations, []);
createHost.api.openInlineCreate(); await createHost.api.onInlineEditorMessage(hostMessage(createHost, "golf-editor-ready"));
let releaseRefresh;
createHost.server.readGate = new Promise((resolve) => { releaseRefresh = resolve; });
const uncertainRefresh = createHost.api.onInlineEditorMessage(hostMessage(createHost, "golf-editor-close", { refreshRequired: true }));
assert.equal(createHost.api.state.refreshingEdit, true); assert.equal(createHost.get("addReservationButton").disabled, true);
createHost.api.openInlineCreate(); assert.equal(createHost.api.state.editor, null, "No second create while ambiguous result is being checked");
releaseRefresh(); await uncertainRefresh; createHost.server.readGate = null;
assert.match(createHost.get("pageBanner").textContent, /같은 예약을 다시 추가하지/);
assert.equal(createHost.api.state.refreshingEdit, false); assert.equal(createHost.calls.length, 0);
createHost.api.openInlineCreate(); await createHost.api.onInlineEditorMessage(hostMessage(createHost, "golf-editor-ready"));
createHost.server.failRead = true;
await createHost.api.onInlineEditorMessage(hostMessage(createHost, "golf-editor-saved", { recordId: id(60) }));
assert.equal(createHost.api.state.rows.length, 0); assert.equal(createHost.get("reservationDetailDialog").open, false);
assert.equal(createHost.get("pageBanner").dataset.tone, "error");

const deleting = hostHarness(); await deleting.api.loadRows();
const openDetail = (host, recordId) => host.api.openReservationDetail(host.api.state.rows.find((row) => row.id === recordId));
openDetail(deleting, id(1));
assert.equal(deleting.get("deleteDetailGroup").hidden, true); assert.equal(deleting.get("deleteDetailReservation").dataset.reservationId, id(1));
await dispatch(deleting.get("deleteDetailReservation"), "click", { currentTarget: deleting.get("deleteDetailReservation") });
assert.equal(deleting.calls.length, 0); assert.match(deleting.warnings.at(-1), /이 예약과 입금/); assert.match(deleting.warnings.at(-1), /실제 고객 환불은 처리되지/);
openDetail(deleting, id(2));
assert.equal(deleting.get("deleteDetailGroup").hidden, false);
assert.match(deleting.get("deleteDetailReservation").textContent, /이 일정 삭제/);
await deleting.api.deleteReservation(id(2)); assert.equal(deleting.calls.length, 0); assert.match(deleting.warnings.at(-1), /공통 입금 내역은 유지/);
await deleting.api.deleteReservation(id(2), true); assert.equal(deleting.calls.length, 0);
assert.match(deleting.warnings.at(-1), /전체 2일정/); assert.match(deleting.warnings.at(-1), /2,000,000 VND/); assert.match(deleting.warnings.at(-1), /복구할 수 없습니다/);
await deleting.api.deleteReservation(id(1), true); await deleting.api.deleteReservation(id(999)); await deleting.api.deleteReservation("invalid");
assert.equal(deleting.calls.length, 0, "Unknown scope/ID cannot issue mutation");
deleting.confirm(true); openDetail(deleting, id(1));
let finishDelete;
deleting.mutation(() => new Promise((resolve) => { finishDelete = resolve; }));
const pendingDelete = deleting.api.deleteReservation(id(1));
assert.equal(deleting.api.state.deleting, true); assert.equal(deleting.get("deleteDetailReservation").disabled, true);
assert.equal(deleting.get("addReservationButton").disabled, true); assert.equal(deleting.get("searchInput").disabled, true);
await deleting.api.deleteReservation(id(1)); await deleting.api.deleteReservation(id(2), true); deleting.api.openInlineCreate();
assert.equal(deleting.calls.length, 1); assert.equal(deleting.api.state.editor, null);
let blockedEscape = false;
await dispatch(deleting.get("reservationDetailDialog"), "cancel", { preventDefault() { blockedEscape = true; } }); assert.equal(blockedEscape, true);
assert.deepEqual(deleting.calls[0], { name: "delete", args: { table: "golf_reservations", columns: "id", filters: [["id", id(1)], ["updated_at", base.updated_at]] } });
deleting.server.rows = deleting.server.rows.filter((row) => row.id !== id(1));
finishDelete({ data: { id: id(1) }, error: null }); await pendingDelete;
assert.equal(deleting.api.state.deleting, false); assert.equal(deleting.api.state.rows.some((row) => row.id === id(1)), false);
assert.equal(deleting.get("pageBanner").dataset.tone, "ok"); assert.equal(deleting.get("reservationDetailDialog").open, false);
assert.equal(deleting.get("summaryDeposit").textContent, "2,000,000 VND", "Deleting standalone leaves grouped deposit untouched");
deleting.mutation(async (name, args) => { assert.equal(name, "delete_golf_booking_round");
  deleting.server.rows = deleting.server.rows.filter((row) => row.id !== args.p_reservation_id); return { data: args.p_reservation_id, error: null }; });
await deleting.api.deleteReservation(id(2));
assert.deepEqual(deleting.calls.at(-1), { name: "delete_golf_booking_round", args: { p_reservation_id: id(2), p_expected_version: 7 } });
assert.equal(deleting.api.state.rows.length, 1); assert.equal(deleting.api.state.rows[0].id, id(3));
assert.equal(deleting.get("summaryDeposit").textContent, "2,000,000 VND", "Selected-round delete keeps shared funds on the remaining booking");
deleting.mutation(async (_name, args) => { deleting.server.rows = []; return { data: args.p_group_id, error: null }; });
await deleting.api.deleteReservation(id(3), true);
assert.deepEqual(deleting.calls.at(-1), { name: "delete_golf_booking_group", args: { p_group_id: id(100), p_expected_version: 7 } });
assert.equal(deleting.api.state.rows.length, 0); assert.equal(deleting.get("summaryDeposit").textContent, "0 VND");

for (const response of [{ data: { id: id(999) }, error: null }, { data: null, error: null }, { data: null, error: { code: "40001", message: "Mock stale record" } }]) {
  const failed = hostHarness(); await failed.api.loadRows(); failed.confirm(true); openDetail(failed, id(1));
  failed.server.rows[0].note = "fresh after rejection"; failed.mutation(async () => response);
  const readsBefore = failed.server.reads; await failed.api.deleteReservation(id(1));
  assert.ok(failed.server.reads > readsBefore); assert.equal(failed.api.state.rows.length, 3);
  assert.equal(failed.get("pageBanner").dataset.tone, "error"); assert.equal(failed.get("reservationDetailDialog").open, true);
  assert.match(failed.get("reservationDetailContent").innerHTML, /fresh after rejection/);
  assert.equal(failed.api.state.deleting, false); assert.equal(failed.get("deleteDetailReservation").disabled, false);
}
const uncertainDelete = hostHarness(); await uncertainDelete.api.loadRows(); uncertainDelete.confirm(true);
uncertainDelete.mutation(async () => { uncertainDelete.server.rows = uncertainDelete.server.rows.filter((row) => row.id !== id(2)); throw new TypeError("Mock lost delete response"); });
await uncertainDelete.api.deleteReservation(id(2));
assert.equal(uncertainDelete.api.state.rows.some((row) => row.id === id(2)), false); assert.equal(uncertainDelete.get("pageBanner").dataset.tone, "info");
assert.equal(uncertainDelete.get("summaryDeposit").textContent, "2,000,000 VND");
const failedRefresh = hostHarness(); await failedRefresh.api.loadRows(); failedRefresh.confirm(true); openDetail(failedRefresh, id(2));
failedRefresh.mutation(async () => { failedRefresh.server.failRead = true; return { data: id(2), error: null }; });
await failedRefresh.api.deleteReservation(id(2));
assert.equal(failedRefresh.api.state.rows.length, 0); assert.equal(failedRefresh.get("reservationDetailDialog").open, false);
assert.equal(failedRefresh.get("summaryDeposit").textContent, "0 VND"); assert.equal(failedRefresh.get("pageBanner").dataset.tone, "error");

// A slow manual reload must not undo a later authoritative post-save reload.
// Exercise both await boundaries (base reads and grouped attachment), plus a
// stale rejected request that must not turn the newest success into an error.
for (const outcome of ["late-success", "late-failure"]) {
  const race = hostHarness(); await race.api.loadRows();
  const oldRows = structuredClone(initialRows).map((row) => ({ ...row, note: "obsolete manual reload" }));
  let finishOld;
  const oldGate = new Promise((resolve) => { finishOld = resolve; });
  race.server.readOverride = async (query) => {
    await oldGate;
    if (outcome === "late-failure") throw new Error("Obsolete network failure");
    return query.table === "golf_reservations" ? oldRows : [];
  };
  const oldLoad = race.api.loadRows();
  race.server.readOverride = null;
  race.server.rows = structuredClone(initialRows).map((row) => ({ ...row, note: "newest authoritative save" }));
  assert.equal(await race.api.loadRows(), true);
  const newestRows = race.api.state.rows, newestMarkup = race.get("reservationTableBody").innerHTML;
  const newestBanner = race.get("pageBanner").textContent, newestConnectionCount = race.connections.length;
  finishOld(); assert.equal(await oldLoad, false);
  assert.equal(race.api.state.rows, newestRows, `${outcome} cannot replace newest row graph`);
  assert.equal(race.get("reservationTableBody").innerHTML, newestMarkup);
  assert.equal(race.get("pageBanner").textContent, newestBanner); assert.equal(race.get("pageBanner").dataset.tone, "ok");
  assert.equal(race.connections.length, newestConnectionCount, "Stale failures do not publish offline/error state");
  assert.equal(race.connections.at(-1)[0], "online");
}
const attachRace = hostHarness();
attachRace.server.rows = structuredClone(initialRows).map((row) => ({ ...row, note: "slow group attachment" }));
let releaseAttach, enteredAttach;
const attached = new Promise((resolve) => { enteredAttach = resolve; });
const attachGate = new Promise((resolve) => { releaseAttach = resolve; });
attachRace.server.beforeAttach = async (rows) => {
  if (rows[0].note === "slow group attachment") { enteredAttach(); await attachGate; }
};
const oldAttachLoad = attachRace.api.loadRows(); await attached;
attachRace.server.rows = structuredClone(initialRows).map((row) => ({ ...row, note: "newest after group fetch" }));
assert.equal(await attachRace.api.loadRows(), true);
const authoritativeRows = attachRace.api.state.rows;
releaseAttach(); assert.equal(await oldAttachLoad, false);
assert.equal(attachRace.api.state.rows, authoritativeRows, "Generation is checked after async group attachment, not just after base reads");
assert.ok(attachRace.api.state.rows.every((row) => row.note === "newest after group fetch"));
assert.match(listPage, /id="addReservationButton"/); assert.match(listPage, /id="deleteDetailReservation"/); assert.match(listPage, /id="deleteDetailGroup"/);
assert.match(listSource, /requireLogin\(\{ roles: \["manager", "admin"\]/);
console.log("Same-page create/delete: mode/source/token boundaries, required fields, single/group RPC scope, lost-response duplicate protection, immutable group retry, explicit deletion scopes, cancellation, pending locks, exact responses, latest-generation-only reload and filter/scroll preservation verified offline.");
