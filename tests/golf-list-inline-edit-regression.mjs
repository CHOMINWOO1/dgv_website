import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// Fully offline: database reads and RPC responses below are in-memory fixtures.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [listSource, listPage, childSource, childPage, bookingSource] = await Promise.all([
  "assets/golf-reserv-list.js", "golf_reserv_list.html", "assets/golf-reserv.js",
  "golf_reserv.html", "assets/golf-bookings.js",
].map((file) => readFile(path.join(root, file), "utf8")));
const ids = {
  first: "10000000-0000-4000-8000-000000000001", second: "10000000-0000-4000-8000-000000000002",
  single: "10000000-0000-4000-8000-000000000003", outside: "10000000-0000-4000-8000-000000000004",
  group: "20000000-0000-4000-8000-000000000001", token: "30000000-0000-4000-8000-000000000001",
};
const origin = "https://golf-inline.test";
const escapeHTML = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function eventTarget(target = {}) {
  target.events = new Map();
  target.addEventListener = function (type, fn) { this.events.set(type, [...(this.events.get(type) || []), fn]); };
  return target;
}
function element(id) {
  const classes = new Set();
  return eventTarget({ id, value: "", textContent: "", innerHTML: "", hidden: false, open: false,
    disabled: false, checked: false, readOnly: false, dataset: {}, attributes: {}, scrollLeft: 0, scrollTop: 0,
    options: [], classList: { add: (...v) => v.forEach((x) => classes.add(x)), remove: (...v) => v.forEach((x) => classes.delete(x)), contains: (v) => classes.has(v), toggle(v, force) { if (force ?? !classes.has(v)) classes.add(v); else classes.delete(v); } },
    setAttribute(name, value) { this.attributes[name] = String(value); }, getAttribute(name) { return this.attributes[name] ?? null; },
    removeAttribute(name) { delete this.attributes[name]; }, setCustomValidity() {}, querySelectorAll() { return []; }, querySelector() { return null; },
    add(option) { this.options.push(option); }, focus() {}, scrollIntoView() {}, reset() {},
    showModal() { this.open = true; }, close() { this.open = false; },
    getBoundingClientRect() { return { left: 10, top: 10, right: 400, bottom: 400 }; },
    setPointerCapture() {}, hasPointerCapture() { return false; }, releasePointerCapture() {},
  });
}
function dom(page) {
  const elements = new Map([...page.matchAll(/\bid="([^"]+)"/g)].map((m) => [m[1], element(m[1])]));
  const get = (id) => { assert.ok(elements.has(id), `Missing DOM fixture: ${id}`); return elements.get(id); };
  const sheet = element("sheet");
  const document = eventTarget({ getElementById: get, body: element("body"), querySelector: (s) => s === ".golf-sheet-wrap" ? sheet : null, querySelectorAll: () => [] });
  return { elements, get, sheet, document };
}
async function dispatch(target, type, event = {}) {
  for (const fn of target.events.get(type) || []) await fn({ preventDefault() {}, stopPropagation() {}, ...event });
}
const base = {
  counterparty_name: "Agency", representative_name: "FIRST", player_names_en: "FIRST\nSECOND", pax: 2,
  status: "in_progress", customer_type: "company", golf_time: "09:00:00", golf_course: "SAM", holes: 18,
  guest_unit_price_vnd: 1000000, guest_total_vnd: 2000000, course_unit_price_vnd: 800000, course_total_vnd: 1600000,
  cost_settlement_type: "golf_course", cost_partner_name: null, deposit_amount_vnd: 0, final_received_amount_vnd: null,
  smart_cart_note: "", note: "original", created_at: "2026-10-25T00:00:00Z", updated_at: "2026-10-25T00:00:00Z",
};
const rawRounds = [
  { ...base, id: ids.second, booking_group_id: ids.group, golf_date: "2027-01-27", pax: 8 },
  { ...base, id: ids.single, booking_group_id: null, golf_date: "2027-01-26" },
  { ...base, id: ids.first, booking_group_id: ids.group, golf_date: "2027-01-25", pax: 7 },
];
const groups = [{ id: ids.group, label: "Grouped <literal>", version: 1, completed_at: null, completion_date: null }];
const groupPayments = [{ id: "40000000-0000-4000-8000-000000000001", booking_group_id: ids.group,
  payment_kind: "deposit", amount_vnd: 500000, payment_date: "2026-10-25", payment_method: "bank", completes_booking: false, sort_order: 0 }];

const host = dom(listPage), navigations = [], outgoing = [], scrolls = [], reads = [], logs = [];
let serverRows = structuredClone(rawRounds), readFailure = false;
host.get("statusFilter").value = "all";
host.get("inlineEditFrame").contentWindow = { postMessage: (message, targetOrigin) => outgoing.push({ message, targetOrigin }) };
const window = eventTarget({ location: { href: `${origin}/golf_reserv_list.html`, origin, assign: (value) => navigations.push(value) },
  crypto: { randomUUID: () => ids.token }, scrollX: 3, scrollY: 50, scrollTo: (...args) => scrolls.push(args),
  setTimeout: () => 1, clearTimeout() {}, print() {},
  DGV: { escapeHTML, supabase: { from(table) { reads.push(table); return { table, select() { return this; }, in() { return this; } }; } },
    async collectSupabasePages(build) { const query = build(); if (readFailure) throw new Error("Mock refresh failure"); return query.table === "golf_reservations" ? structuredClone(serverRows) : []; } },
  QRStaff: { toast() {}, connectionBadge() {}, messageOf: (_error, fallback) => fallback },
});
const quietConsole = { ...console, error: (error) => logs.push(error) };
const hostContext = { window, document: host.document, console: quietConsole, URL, URLSearchParams, Date };
vm.runInNewContext(bookingSource, hostContext);
window.GolfBookings = { ...window.GolfBookings, loadAndAttach: async (rows) => {
  const attached = window.GolfBookings.attach(rows, groups, groupPayments);
  for (const row of rows) row.booking = attached.find((item) => item.id === row.id).booking;
} };
vm.runInNewContext(listSource.replace(/\n  init\(\);/, "\n  global.__test = { state, render, orderedRows, renderTableRows, bindEvents, loadRows, openReservationDetail, openInlineEditor, requestInlineEditorClose, onInlineEditorMessage, closeInlineEditor };"), hostContext);
const api = window.__test;
api.bindEvents();
assert.equal(await api.loadRows(), true);
assert.deepEqual([...api.state.rows.map((row) => row.id)], [ids.first, ids.single, ids.second]);
const markup = host.get("reservationTableBody").innerHTML;
assert.deepEqual([...markup.matchAll(/data-reservation-id="([^"]+)"/g)].map((m) => m[1]), [ids.first, ids.single, ids.second]);
assert.equal((markup.match(/<tr\b/g) || []).length, 3, "One flat row per round; no inserted group header");
assert.deepEqual([...api.orderedRows([
  { ...base, id: ids.second, golf_date: "2027-01-25", golf_time: "10:00:00" },
  { ...base, id: ids.single, golf_date: "2027-01-25", golf_time: "09:00:00" },
  { ...base, id: ids.first, golf_date: "2027-01-25", golf_time: "09:00:00" },
]).map((row) => row.id)], [ids.first, ids.single, ids.second], "Equal dates sort by time, then stable round ID");
assert.doesNotMatch(markup, /golf-group-heading|golf-group-badge|golf-booking-heading|golf-booking-badge|Grouped &lt;literal&gt;/);
assert.equal(host.get("summaryDeposit").textContent, "500,000 VND", "Flat display does not duplicate shared deposit");
assert.equal(api.state.rows[0].pax, 7); assert.equal(api.state.rows[2].pax, 8);
const rowTarget = (id) => ({ closest: (selector) => selector === "tr[data-reservation-id]" ? { dataset: { reservationId: id } } : null });
for (const detail of [1, 0]) {
  await dispatch(host.get("reservationTableBody"), "click", { detail, target: rowTarget(ids.single) });
  assert.equal(host.get("reservationDetailDialog").open, true);
  assert.equal(host.get("editDetailReservation").dataset.editRound, ids.single);
}
await dispatch(host.get("reservationTableBody"), "dblclick", { detail: 2, target: rowTarget(ids.single) });
assert.deepEqual(navigations, [], "Mouse and keyboard activation never navigate away");
api.openReservationDetail(api.state.rows[0]);
assert.match(host.get("reservationDetailContent").innerHTML, new RegExp(`data-edit-round="${ids.second}"`));
assert.equal(host.get("editDetailReservation").dataset.editRound, ids.first);
host.sheet.scrollLeft = 120; host.sheet.scrollTop = 45;
await dispatch(host.get("editDetailReservation"), "click", { currentTarget: host.get("editDetailReservation") });
assert.equal(host.get("inlineEditDialog").open, true);
assert.equal(host.get("reservationDetailDialog").open, false);
assert.equal(host.get("inlineEditFrame").hidden, false, "Expired-auth login stays visible/interactable before ready");
const iframeUrl = new URL(host.get("inlineEditFrame").src);
assert.equal(iframeUrl.origin, origin); assert.equal(iframeUrl.pathname, "/golf_reserv.html");
assert.equal(iframeUrl.searchParams.get("edit"), ids.first);
assert.equal(iframeUrl.searchParams.get("embedded"), "1"); assert.equal(iframeUrl.searchParams.get("editorToken"), ids.token);
const message = (type, overrides = {}) => ({ origin, source: host.get("inlineEditFrame").contentWindow, data: { type, token: ids.token, recordId: ids.first }, ...overrides });
for (const overrides of [
  { origin: "https://evil.test" }, { source: {} }, { data: { type: "golf-editor-ready", token: "wrong", recordId: ids.first } },
  { data: { type: "golf-editor-ready", token: ids.token, recordId: ids.outside } }, { data: null },
]) { await api.onInlineEditorMessage(message("golf-editor-ready", overrides)); assert.equal(api.state.editor.ready, false); }
await api.onInlineEditorMessage(message("golf-editor-saved"));
assert.equal(host.get("inlineEditDialog").open, true, "Saved cannot bypass target-ready handshake");
await api.onInlineEditorMessage(message("golf-editor-error"));
assert.equal(host.get("inlineEditStatus").dataset.tone, "error");
api.requestInlineEditorClose();
assert.equal(api.state.editor, null, "Loading/auth-error editor is safely closable before ready");
assert.equal(host.get("inlineEditFrame").src, "about:blank");
api.openInlineEditor(ids.first);
await api.onInlineEditorMessage(message("golf-editor-ready"));
assert.equal(api.state.editor.ready, true);
await dispatch(host.get("inlineEditDialog"), "cancel");
assert.equal(outgoing.at(-1).message.type, "golf-editor-request-close");
assert.equal(outgoing.at(-1).message.token, ids.token); assert.equal(outgoing.at(-1).targetOrigin, origin);
assert.equal(host.get("inlineEditDialog").open, true, "Host waits for child dirty/save guard");
await api.onInlineEditorMessage(message("golf-editor-close-blocked"));
assert.equal(host.get("inlineEditDialog").open, true);
await api.onInlineEditorMessage(message("golf-editor-close", { source: {} }));
assert.equal(host.get("inlineEditDialog").open, true);
await api.onInlineEditorMessage(message("golf-editor-close"));
assert.equal(host.get("inlineEditDialog").open, false);
assert.equal(host.get("reservationDetailDialog").open, true);
assert.deepEqual(scrolls.at(-1), [3, 50]); assert.equal(host.sheet.scrollLeft, 120);

const filters = { searchInput: "Agency", statusFilter: "in_progress", filterFrom: "2027-01-25", filterTo: "2027-01-27" };
for (const [id, value] of Object.entries(filters)) host.get(id).value = value;
api.openInlineEditor(ids.first); await api.onInlineEditorMessage(message("golf-editor-ready"));
serverRows = serverRows.map((row) => row.id === ids.second ? { ...row, note: "saved sibling", pax: 9 } : row);
await api.onInlineEditorMessage(message("golf-editor-saved", { data: { type: "golf-editor-saved", token: ids.token, recordId: ids.second } }));
assert.equal(api.state.editor, null); assert.equal(api.state.refreshingEdit, false);
assert.equal(api.state.rows.find((row) => row.id === ids.second).pax, 9);
assert.match(host.get("reservationDetailContent").innerHTML, /9명/);
for (const [id, value] of Object.entries(filters)) assert.equal(host.get(id).value, value, `${id} survives successful save refresh`);
assert.equal(host.sheet.scrollLeft, 120); assert.equal(host.sheet.scrollTop, 45);
assert.deepEqual(navigations, []); assert.ok(reads.every((table) => ["golf_reservations", "golf_reservation_payments"].includes(table)));
api.openInlineEditor(ids.first); await api.onInlineEditorMessage(message("golf-editor-ready"));
readFailure = true; await api.onInlineEditorMessage(message("golf-editor-saved"));
assert.equal(api.state.rows.length, 0, "Failed refresh must not present old financial amounts as fresh");
assert.equal(host.get("reservationDetailDialog").open, false);
assert.equal(host.get("pageBanner").dataset.tone, "error");
assert.doesNotMatch(listSource.replace(/\r/g, "").split("async function onInlineEditorMessage(event)")[1].split("\n  }\n")[0], /\.rpc\(|\.insert\(|\.update\(|\.delete\(/, "Editor messages never write financial data; explicit confirmed deletion is separately scoped");

function childHarness({ search = `?edit=${ids.first}&embedded=1&editorToken=${ids.token}`, framed = true } = {}) {
  const domState = dom(childPage), sent = [], confirmations = [], calls = [], notices = [];
  domState.get("reservationForm").querySelectorAll = () => ["recordId", "playerNamesEn", "pax", "customerType", "saveButton"].map(domState.get);
  let confirmResult = false, rpc = async () => ({ data: [{ saved_id: ids.first, saved_status: "in_progress" }], error: null });
  const parent = { postMessage: (message, targetOrigin) => sent.push({ message, targetOrigin }) };
  const childWindow = eventTarget({ location: { origin, search, pathname: "/golf_reserv.html", hash: "" },
    parent, history: { replaceState() {} }, confirm: (text) => { confirmations.push(text); return confirmResult; },
    DGV: { escapeHTML, formatYmdInTimeZone: () => "2026-10-25", supabase: { rpc: async (name, payload) => { calls.push({ name, payload }); return rpc(name, payload); } } },
    QRStaff: { toast: (...args) => notices.push(args), setBusy() {}, connectionBadge() {}, messageOf: (_error, fallback) => fallback },
  });
  if (!framed) childWindow.parent = childWindow;
  const context = { window: childWindow, document: domState.document, console: quietConsole, URL, URLSearchParams, Date,
    Option: function (text, value) { return { text, value }; } };
  vm.runInNewContext(childSource.replace(/\n  init\(\);/, "\n  global.__test = { state, embeddedEditor, readEmbeddedContext, configureEmbeddedEditor, completeEmbeddedLoad, requestEmbeddedClose, handleEditorMessage, sendEditorMessage, bindEvents, save, fillForm };"), context);
  const childApi = childWindow.__test;
  return { ...domState, api: childApi, window: childWindow, parent, sent, confirmations, calls, notices,
    confirm: (value) => { confirmResult = value; }, rpc: (fn) => { rpc = fn; } };
}
for (const options of [ { framed: false }, { search: `?edit=${ids.first}&embedded=true&editorToken=${ids.token}` },
  { search: `?edit=${ids.first}&embedded=1&editorToken=invalid` }, { search: `?edit=invalid&embedded=1&editorToken=${ids.token}` }, { search: "" } ]) {
  const ordinary = childHarness(options); ordinary.api.configureEmbeddedEditor();
  assert.equal(ordinary.api.embeddedEditor, null);
  assert.equal(ordinary.document.body.classList.contains("golf-embedded"), false, "Malformed embedded parameters never hide the normal page");
}
let child = childHarness(); child.api.configureEmbeddedEditor(); child.api.bindEvents();
assert.equal(child.document.body.classList.contains("golf-embedded"), true);
assert.equal(child.document.body.classList.contains("golf-embedded-ready"), false);
assert.equal(child.get("reservationForm").getAttribute("aria-busy"), "true");
child.api.completeEmbeddedLoad();
assert.equal(child.api.embeddedEditor.ready, false); assert.equal(child.sent.at(-1).message.type, "golf-editor-error");
assert.equal(child.sent.at(-1).message.recordId, ids.first);
await child.api.save({ preventDefault() {} }); assert.equal(child.calls.length, 0, "No save is possible before auth/target-ready handshake");
const standalone = { ...base, id: ids.first, golf_date: "2027-01-25", payments: [] };
child.api.state.rows = [standalone]; child.api.fillForm(standalone, { scroll: false }); child.api.completeEmbeddedLoad();
assert.equal(child.api.embeddedEditor.ready, true); assert.equal(child.document.body.classList.contains("golf-embedded-ready"), true);
assert.equal(child.sent.at(-1).message.type, "golf-editor-ready"); assert.equal(child.sent.at(-1).targetOrigin, origin);
const childMessage = (overrides = {}) => ({ origin, source: child.parent, data: { type: "golf-editor-request-close", mode: "edit", token: ids.token }, ...overrides });
child.api.state.formDirty = true;
const beforeInvalid = child.sent.length;
for (const override of [ { origin: "https://evil.test" }, { source: {} }, { data: { type: "golf-editor-request-close", mode: "edit", token: "wrong" } }, { data: { type: "request-close", mode: "edit", token: ids.token } }, { data: { type: "golf-editor-request-close", mode: "create", token: ids.token } }, { data: null } ]) child.api.handleEditorMessage(childMessage(override));
assert.equal(child.sent.length, beforeInvalid); assert.equal(child.confirmations.length, 0);
child.api.handleEditorMessage(childMessage());
assert.equal(child.sent.at(-1).message.type, "golf-editor-close-blocked"); assert.equal(child.api.state.formDirty, true);
assert.equal(child.confirmations.length, 1, "Standalone embedded dirty edits also require confirmation");
child.confirm(true); child.api.handleEditorMessage(childMessage());
assert.equal(child.sent.at(-1).message.type, "golf-editor-close"); assert.equal(child.api.state.formDirty, false);
const beforeLegacyClose = child.sent.length;
child.api.handleEditorMessage(childMessage({ data: { type: "golf-editor-request-close", token: ids.token } }));
assert.equal(child.sent.length, beforeLegacyClose + 1);
assert.equal(child.sent.at(-1).message.type, "golf-editor-close", "Already-open legacy edit host may omit mode; create mode never may");
await child.api.save({ preventDefault() {} }); assert.equal(child.calls.length, 0, "Confirmed closed session cannot submit later");
child = childHarness(); child.api.configureEmbeddedEditor(); child.api.bindEvents();
child.api.state.rows = [standalone]; child.api.fillForm(standalone, { scroll: false }); child.api.completeEmbeddedLoad();
child.api.state.saving = true; const confirmCount = child.confirmations.length;
child.api.handleEditorMessage(childMessage());
assert.equal(child.sent.at(-1).message.type, "golf-editor-close-blocked"); assert.equal(child.confirmations.length, confirmCount);
child.api.state.saving = false; child.api.state.formDirty = true; child.confirm(false);
await dispatch(child.document, "keydown", { key: "Escape" }); assert.equal(child.sent.at(-1).message.type, "golf-editor-close-blocked");
let prevented = false;
await dispatch(child.window, "beforeunload", { preventDefault() { prevented = true; } }); assert.equal(prevented, true);
child.api.state.formDirty = false;
let resolveSave;
child.rpc(() => new Promise((resolve) => { resolveSave = resolve; }));
const savePromise = child.api.save({ preventDefault() {} });
assert.equal(child.api.state.saving, true); assert.equal(child.calls.length, 1);
assert.equal(child.get("playerNamesEn").disabled, true, "In-flight save cannot lose additional form edits");
assert.equal(child.get("pax").disabled, true);
assert.equal(child.calls[0].name, "save_golf_reservation_with_payments"); assert.equal(child.calls[0].payload.p_reservation_id, ids.first);
child.api.handleEditorMessage(childMessage()); assert.equal(child.sent.at(-1).message.type, "golf-editor-close-blocked");
resolveSave({ data: [{ saved_id: ids.first, saved_status: "in_progress" }], error: null }); await savePromise;
assert.equal(child.sent.at(-1).message.type, "golf-editor-saved"); assert.equal(child.sent.at(-1).message.recordId, ids.first);
assert.equal(child.api.state.saving, true, "Successful child remains locked until parent removes iframe");
assert.equal(child.get("playerNamesEn").disabled, true);
assert.equal(child.get("recordId").value, ids.first, "Success never resets embedded form to create mode");
await child.api.save({ preventDefault() {} }); assert.equal(child.calls.length, 1, "No duplicate embedded save");
prevented = false; await dispatch(child.window, "beforeunload", { preventDefault() { prevented = true; } });
assert.equal(prevented, false, "Confirmed save does not cause an iframe removal unload prompt");

const groupedChild = childHarness();
const groupedRows = window.GolfBookings.attach(rawRounds.map((row) => ({ ...row, payments: [] })), groups, groupPayments);
groupedChild.api.state.rows = groupedRows;
groupedChild.api.fillForm(groupedRows.find((row) => row.id === ids.first), { scroll: false }); groupedChild.api.completeEmbeddedLoad();
groupedChild.api.fillForm(groupedRows.find((row) => row.id === ids.second), { scroll: false });
assert.equal(groupedChild.get("recordId").value, ids.second, "Known sibling stays independently editable");
groupedChild.api.fillForm({ ...standalone, id: ids.outside }, { scroll: false });
assert.equal(groupedChild.get("recordId").value, ids.second, "Embedded session cannot switch to an unrelated reservation");
groupedChild.rpc(async () => ({ data: [{ saved_id: ids.second, saved_status: "in_progress" }], error: null }));
await groupedChild.api.save({ preventDefault() {} });
assert.equal(groupedChild.calls[0].name, "save_golf_booking_group");
assert.equal(groupedChild.calls[0].payload.p_group_id, ids.group); assert.equal(groupedChild.calls[0].payload.p_round_id, ids.second);
assert.equal(groupedChild.calls[0].payload.p_expected_version, 1); assert.equal(groupedChild.calls[0].payload.p_payments.length, 1);
assert.equal(groupedChild.sent.at(-1).message.recordId, ids.second);
const failedChild = childHarness();
failedChild.api.state.rows = groupedRows;
failedChild.api.fillForm(groupedRows.find((row) => row.id === ids.first), { scroll: false }); failedChild.api.completeEmbeddedLoad();
failedChild.api.state.formDirty = true;
failedChild.rpc(async () => ({ data: null, error: { code: "40001", message: "Mock stale version" } }));
await failedChild.api.save({ preventDefault() {} });
assert.equal(failedChild.api.state.saving, false); assert.equal(failedChild.api.embeddedEditor.saved, false);
assert.equal(failedChild.get("playerNamesEn").disabled, false, "Save failure restores editable controls");
assert.equal(failedChild.get("customerType").disabled, true, "Failure preserves prior grouped-customer restriction");
assert.equal(failedChild.api.state.formDirty, true, "Failed save retains unsaved draft");
assert.equal(failedChild.get("recordId").value, ids.first);
assert.ok(!failedChild.sent.some((entry) => entry.message.type === "golf-editor-saved"));
assert.match(childSource, /requireLogin\(\{ roles: \["manager", "admin"\]/, "Embedded route retains manager/admin auth");
assert.match(childPage, /\.golf-embedded:not\(\.golf-embedded-ready\) \.golf-form-card\{visibility:hidden;pointer-events:none\}/);
assert.doesNotMatch(childPage, /\.golf-embedded:not\(\.golf-embedded-ready\)\s*\{[^}]*visibility:hidden/, "Only form, not login UI, is hidden before ready");
assert.match(listPage, /<iframe[^>]+id="inlineEditFrame"[^>]+title=/);
console.log("Inline golf editor: flat chronological rows, scoped two-way messages, no navigation, auth-ready visibility, dirty/save/unload guards, original single/group RPCs, sibling scope, preserved filters/scroll, and fail-closed refresh verified offline.");
