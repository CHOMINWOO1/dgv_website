import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(path.join(root, "assets/admin-card-receipts.js"), "utf8");
const admin = (await readFile(path.join(root, "admin.html"), "utf8")).replace(/\r\n/g, "\n");
const scope = { Uint8Array, Blob, Date, Map, Set, Object, Array, String, Number, Math, Promise, Error, TypeError };
vm.runInNewContext(source, scope, { filename: "assets/admin-card-receipts.js" });
const api = scope.DGV_CARD_RECEIPTS;
assert.equal(typeof api.create, "function");
assert.doesNotMatch(source, /getPublicUrl|createSignedUrl|service_role|localStorage|\.from\(["']orders["']\)/, "receipts must not create URLs, store secrets or mutate orders");
assert.doesNotMatch(source, /Math\.random\(/, "object paths require secure randomness");
assert.match(admin, /admin-card-receipts\.js\?v=20261124-card-receipts-1/);
assert.match(admin, /admin-card-receipts\.css\?v=20261124-card-receipts-1/);
assert.match(admin, /receiptManager\.loadStatuses\(data\)\.catch/);
assert.match(admin, /DGV_CARD_RECEIPTS\.isEligible\(o\)/);

const id = value => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const order = value => ({ id: id(value), payment_method: "card", status: "paid", sales_excluded: false });
const jpeg = new Blob([new Uint8Array([255, 216, 255, 224, 0, 4, 255, 217])], { type: "image/jpeg" });
const row = (value, photo = 9000 + value) => ({ order_id: id(value), storage_path: `${id(value)}/${id(photo)}.jpg`, mime_type: "image/jpeg", byte_size: jpeg.size, updated_at: "2026-11-24T00:00:00Z" });

class Element {
  constructor(tag, document) {
    this.tagName = tag.toUpperCase(); this.document = document; this.children = []; this.listeners = new Map();
    this.attributes = {}; this.style = {}; this.dataset = {}; this.disabled = false; this.hidden = false; this.textContent = "";
    this.classList = { add: name => { this.className = `${this.className || ""} ${name}`.trim(); } };
  }
  get isConnected() { return this === this.document.body || Boolean(this.parent?.isConnected); }
  append(...children) { for (const child of children) { this.children.push(child); child.parent = this; } }
  appendChild(child) { this.append(child); return child; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  setAttribute(key, value) { this.attributes[key] = value; }
  contains(node) { return this === node || this.children.some(child => child.contains(node)); }
  addEventListener(event, callback) { if (!this.listeners.has(event)) this.listeners.set(event, []); this.listeners.get(event).push(callback); }
  removeEventListener(event, callback) { this.listeners.set(event, (this.listeners.get(event) || []).filter(item => item !== callback)); }
  async emit(event, details = {}) {
    if (event === "click" && this.disabled) return;
    await Promise.all((this.listeners.get(event) || []).map(callback => callback({ target: this, preventDefault() {}, stopPropagation() {}, ...details })));
  }
  click() { this.clicked = (this.clicked || 0) + 1; return this.emit("click"); }
  focus() { this.document.activeElement = this; }
}

function environment() {
  const document = { activeElement: null, listeners: new Map(), canvases: [] };
  document.body = new Element("body", document);
  document.body.style.overflow = "auto";
  document.createElement = tag => {
    const element = new Element(tag, document);
    if (tag === "canvas") {
      const operations = [];
      element.operations = operations;
      element.getContext = () => ({ set fillStyle(value) { operations.push(["color", value]); }, fillRect: (...args) => operations.push(["fill", ...args]), drawImage: (...args) => operations.push(["draw", ...args]) });
      element.toBlob = (callback, mime, quality) => { operations.push(["jpeg", mime, quality]); callback(jpeg); };
      document.canvases.push(element);
    }
    return element;
  };
  document.addEventListener = Element.prototype.addEventListener.bind(document);
  document.removeEventListener = Element.prototype.removeEventListener.bind(document);
  document.emit = Element.prototype.emit.bind(document);
  const urls = new Set(), revoked = [], confirms = [];
  let random = 100000;
  return {
    document, urls, revoked, confirms, crypto: { randomUUID: () => id(random++) },
    URL: { createObjectURL: () => { const value = `blob:test-${urls.size}-${random++}`; urls.add(value); return value; }, revokeObjectURL: value => { revoked.push(value); urls.delete(value); } },
    createImageBitmap: async () => ({ width: 4400, height: 3300, close() {} }),
    btoa: value => Buffer.from(value, "binary").toString("base64"),
    confirm: message => { confirms.push(message); return true; },
  };
}

function backend(initial = []) {
  const rows = new Map(initial.map(item => [item.order_id, { ...item }]));
  const objects = new Map(initial.map(item => [item.storage_path, jpeg]));
  const calls = [];
  const state = { role: "manager", readError: null, upsertError: null, ambiguousCommit: false, downloadError: null, activeDownloads: 0, peakDownloads: 0, deleteError: null, removeError: null };
  class Query {
    constructor() { this.action = "select"; this.predicates = []; }
    select() { return this; }
    in(column, values) { assert.equal(column, "order_id"); assert.ok(values.length <= 100); this.ids = values; return this; }
    order(column) { assert.equal(column, "order_id"); return this; }
    eq(column, value) { this.predicates.push([column, value]); return this; }
    insert(value) { this.action = "insert"; this.value = value; return this; }
    update(value) { this.action = "update"; this.value = value; return this; }
    delete() { this.action = "delete"; return this; }
    async range(start, end) {
      calls.push({ action: "select", ids: this.ids, start, end });
      if (state.readError) return { error: state.readError };
      return { data: Array.from(rows.values()).filter(item => this.ids.includes(item.order_id)).sort((a, b) => a.order_id.localeCompare(b.order_id)).slice(start, end + 1) };
    }
    async single() {
      assert.ok(["insert", "update"].includes(this.action)); calls.push({ action: this.action, value: this.value, predicates: this.predicates });
      if (state.beforeWrite) { const run = state.beforeWrite; state.beforeWrite = null; run(rows, objects); }
      if (this.action === "insert" && rows.has(this.value.order_id)) return { error: new Error("duplicate receipt order_id") };
      if (this.action === "update" && !this.predicates.every(([key, value]) => rows.get(this.value.order_id)?.[key] === value)) return { error: new Error("compare-and-set mismatch") };
      if (state.upsertError) { if (state.ambiguousCommit) rows.set(this.value.order_id, { ...this.value }); return { error: state.upsertError }; }
      rows.set(this.value.order_id, { ...this.value }); return { data: { ...this.value } };
    }
    then(resolve, reject) {
      const run = async () => {
        assert.equal(this.action, "delete"); calls.push({ action: "delete", predicates: this.predicates });
        if (state.deleteError) return { error: state.deleteError };
        const matching = Array.from(rows.values()).filter(item => this.predicates.every(([key, value]) => item[key] === value));
        matching.forEach(item => rows.delete(item.order_id));
        return { data: matching.map(item => ({ order_id: item.order_id })) };
      };
      return run().then(resolve, reject);
    }
  }
  const sb = {
    from(table) { assert.equal(table, "order_card_receipts", "module must never write/read orders or other tables"); return new Query(); },
    storage: { from(bucket) {
      assert.equal(bucket, "order-card-receipts");
      return {
        async download(storagePath) {
          calls.push({ action: "download", path: storagePath });
          state.activeDownloads += 1; state.peakDownloads = Math.max(state.peakDownloads, state.activeDownloads);
          await new Promise(resolve => setTimeout(resolve, 1)); state.activeDownloads -= 1;
          if (state.downloadError) return { error: state.downloadError };
          return { data: objects.get(storagePath) || null };
        },
        async upload(storagePath, blob, options) {
          calls.push({ action: "upload", path: storagePath, options });
          assert.equal(options.upsert, false); assert.equal(options.contentType, "image/jpeg");
          assert.ok(!objects.has(storagePath), "replacement must use a new path"); objects.set(storagePath, blob); return { data: { path: storagePath } };
        },
        async remove(paths) {
          calls.push({ action: "remove", paths });
          if (state.removeError) return { error: state.removeError };
          // Model the server's critical active-reference protection.
          for (const storagePath of paths) if (!Array.from(rows.values()).some(item => item.storage_path === storagePath)) objects.delete(storagePath);
          return { data: [] };
        },
      };
    } },
  };
  const env = environment();
  const manager = api.create({ supabase: sb, environment: env, getIdentity: async () => ({ role: state.role }) });
  return { manager, rows, objects, calls, state, env, sb };
}

assert.ok(api.isEligible(order(1)));
for (const invalid of [null, { ...order(1), id: "bad" }, { ...order(1), payment_method: "cash" }, { ...order(1), payment_method: "bank" }, { ...order(1), status: "pending" }, { ...order(1), sales_excluded: true }, { ...order(1), sales_excluded: undefined }]) assert.equal(api.isEligible(invalid), false);
await api.validateJpeg(jpeg);
for (const bad of [new Blob(["not jpeg"], { type: "image/jpeg" }), new Blob([new Uint8Array([255, 216, 255, 217])], { type: "image/png" }), new Blob([new Uint8Array(api.MAX_JPEG_BYTES + 1)], { type: "image/jpeg" })]) await assert.rejects(api.validateJpeg(bad));
assert.throws(() => api.validateMetadata({ ...row(1), storage_path: `${id(2)}/${id(8)}.jpg` }, id(1)));
assert.throws(() => api.validateMetadata({ ...row(1), storage_path: `${id(1)}/../photo.jpg` }, id(1)));
assert.throws(() => api.validateMetadata({ ...row(1), mime_type: "image/svg+xml" }, id(1)));

const env = environment();
const normalized = await api.normalizeImage(new Blob(["original png metadata"], { type: "image/png" }), env);
assert.equal(normalized, jpeg);
assert.equal(env.document.canvases[0].width, 2200);
assert.equal(env.document.canvases[0].height, 1650);
assert.deepEqual(env.document.canvases[0].operations[0], ["color", "#fff"]);
assert.equal(env.document.canvases[0].operations[1][0], "fill");
assert.equal(env.document.canvases[0].operations[2][0], "draw");
await assert.rejects(api.normalizeImage(new Blob(["text"], { type: "text/plain" }), env));
await assert.rejects(api.normalizeImage({ type: "image/jpeg", size: api.MAX_INPUT_BYTES + 1 }, env));

const compressedEnv = environment();
const makeCanvas = compressedEnv.document.createElement;
let attempts = 0;
compressedEnv.document.createElement = tag => {
  const element = makeCanvas(tag);
  if (tag === "canvas") element.toBlob = callback => { attempts += 1; callback(attempts < 7 ? new Blob([new Uint8Array(api.MAX_JPEG_BYTES + 1)], { type: "image/jpeg" }) : jpeg); };
  return element;
};
await api.normalizeImage(new Blob(["large camera image"], { type: "image/png" }), compressedEnv);
assert.equal(attempts, 7, "oversized JPEG must retry quality and then reduce dimensions");
assert.equal(compressedEnv.document.canvases[0].width, 1650);

const fallbackEnv = environment();
delete fallbackEnv.createImageBitmap;
fallbackEnv.Image = class {
  constructor() { this.naturalWidth = 800; this.naturalHeight = 600; }
  set src(_value) { queueMicrotask(() => this.onload()); }
};
await api.normalizeImage(new Blob(["fallback image"], { type: "image/jpeg" }), fallbackEnv);
assert.equal(fallbackEnv.urls.size, 0, "decode fallback must revoke its input object URL");

const manyOrders = Array.from({ length: 1205 }, (_, index) => order(index + 1));
const many = backend(manyOrders.map((_, index) => row(index + 1)));
await many.manager.loadStatuses([...manyOrders, { ...order(2000), payment_method: "cash" }]);
assert.equal(many.calls.filter(call => call.action === "download").length, 0, "list badges must not download photos");
assert.ok(many.calls.filter(call => call.action === "select").length >= 25, "metadata must page even at exactly 100 rows and chunk long ID lists");
assert.ok(many.calls.filter(call => call.action === "select").every(call => !call.ids.includes(id(2000))));

const printing = backend(Array.from({ length: 8 }, (_, index) => row(index + 1)));
const attachments = await printing.manager.loadForPrint(Array.from({ length: 8 }, (_, index) => order(index + 1)));
assert.equal(Object.keys(attachments).length, 8);
assert.equal(printing.state.peakDownloads, 3);
assert.equal(attachments[id(1)].dataUrl, `data:image/jpeg;base64,${Buffer.from(await jpeg.arrayBuffer()).toString("base64")}`);
assert.equal(printing.calls.filter(call => call.action === "upload").length, 0);
assert.equal(Object.keys(await printing.manager.loadForPrint([{ ...order(1), payment_method: "cash" }])).length, 0);
printing.state.downloadError = new Error("offline");
await assert.rejects(printing.manager.loadForPrint([order(1)]), error => error.code === "CARD_RECEIPT_PRINT_FAILED");
printing.state.downloadError = null;
printing.objects.set(row(1).storage_path, new Blob(["bad image"], { type: "image/jpeg" }));
await assert.rejects(printing.manager.loadForPrint([order(1)]), error => error.code === "CARD_RECEIPT_PRINT_FAILED");
printing.state.readError = new Error("table unavailable");
await assert.rejects(printing.manager.loadForPrint([order(1)]), error => error.code === "CARD_RECEIPT_PRINT_FAILED");

const saving = backend();
const saved = await saving.manager.saveReceipt(order(1), jpeg);
assert.equal(saving.rows.get(id(1)).storage_path, saved.storage_path);
assert.match(saved.storage_path, new RegExp(`^${id(1)}/[0-9a-f-]+\\.jpg$`));
assert.equal(saved.byte_size, jpeg.size);
assert.ok(saved.updated_at);
const replaced = await saving.manager.saveReceipt(order(1), jpeg, saved.storage_path);
assert.notEqual(replaced.storage_path, saved.storage_path);
assert.equal(saving.objects.has(saved.storage_path), false, "old photo may be removed only after replacement metadata committed");
assert.equal(saving.objects.has(replaced.storage_path), true);
await assert.rejects(saving.manager.saveReceipt(order(1), jpeg, saved.storage_path));
await assert.rejects(saving.manager.deleteReceipt(order(1), saved.storage_path));
assert.equal(saving.rows.get(id(1)).storage_path, replaced.storage_path);
await saving.manager.deleteReceipt(order(1), replaced.storage_path);
assert.equal(saving.rows.has(id(1)), false);
assert.equal(saving.objects.has(replaced.storage_path), false);
const deleteCall = saving.calls.find(call => call.action === "delete");
assert.ok(deleteCall.predicates.some(([key, value]) => key === "storage_path" && value === replaced.storage_path));
for (const invalid of [{ ...order(1), payment_method: "cash" }, { ...order(1), status: "pending" }, { ...order(1), sales_excluded: true }]) await assert.rejects(saving.manager.saveReceipt(invalid, jpeg));
saving.state.role = "staff";
await assert.rejects(saving.manager.saveReceipt(order(1), jpeg));

const failedSave = backend([row(1)]);
failedSave.state.upsertError = new Error("metadata failure");
await assert.rejects(failedSave.manager.saveReceipt(order(1), jpeg, row(1).storage_path));
assert.equal(failedSave.rows.get(id(1)).storage_path, row(1).storage_path);
assert.equal(failedSave.objects.size, 1, "failed save must preserve old photo and clean up only orphan upload");
failedSave.state.ambiguousCommit = true;
await assert.rejects(failedSave.manager.saveReceipt(order(1), jpeg, row(1).storage_path));
const committedPath = failedSave.rows.get(id(1)).storage_path;
assert.notEqual(committedPath, row(1).storage_path);
assert.equal(failedSave.objects.has(committedPath), true, "an ambiguous successful metadata write must never lose its active photo during cleanup");

const replacementRace = backend([row(1)]);
const competingRow = row(1, 7777);
replacementRace.state.beforeWrite = (rows, objects) => { rows.set(id(1), competingRow); objects.set(competingRow.storage_path, jpeg); };
await assert.rejects(replacementRace.manager.saveReceipt(order(1), jpeg, row(1).storage_path));
assert.equal(replacementRace.rows.get(id(1)).storage_path, competingRow.storage_path, "conditional replacement must preserve the other device's new metadata");
assert.equal(replacementRace.objects.has(competingRow.storage_path), true, "failed compare-and-set cleanup must preserve the active competing photo");
assert.equal(replacementRace.calls.filter(call => call.action === "update").length, 1);
const registrationRace = backend();
registrationRace.state.beforeWrite = (rows, objects) => { rows.set(id(1), competingRow); objects.set(competingRow.storage_path, jpeg); };
await assert.rejects(registrationRace.manager.saveReceipt(order(1), jpeg));
assert.equal(registrationRace.rows.get(id(1)).storage_path, competingRow.storage_path, "INSERT uniqueness must preserve the other device's first registration");
assert.equal(registrationRace.objects.has(competingRow.storage_path), true);

const devices = backend();
const secondEnvironment = environment();
const secondManager = api.create({ supabase: devices.sb, environment: secondEnvironment, getIdentity: async () => ({ role: "manager" }) });
const secondButton = secondEnvironment.document.createElement("button");
secondEnvironment.document.body.append(secondButton);
secondManager.attachButton(secondButton, order(1));
await secondManager.loadStatuses([order(1)]);
assert.equal(secondButton.dataset.receiptRegistered, "false");
const deviceSaved = await devices.manager.saveReceipt(order(1), jpeg);
await secondManager.loadStatuses([order(1)]);
assert.equal(secondButton.dataset.receiptRegistered, "true", "a fresh metadata read on another client sees the registered photo");
assert.equal(secondButton.textContent, "전표");
assert.equal(secondButton.attributes["aria-label"], "전표 사진 보기·수정");
await devices.manager.deleteReceipt(order(1), deviceSaved.storage_path);
await secondManager.loadStatuses([order(1)]);
assert.equal(secondButton.dataset.receiptRegistered, "false", "the other client refresh also sees deletion without trusting its prior cache");

function descendants(node) { return [node, ...node.children.flatMap(descendants)]; }
function findText(document, value) { return descendants(document.body).find(node => node.tagName === "BUTTON" && node.textContent.includes(value)); }
const modal = backend();
const trigger = modal.env.document.createElement("button");
modal.env.document.body.append(trigger);
modal.manager.attachButton(trigger, order(1));
assert.equal(trigger.textContent, "전표");
assert.equal(trigger.dataset.receiptRegistered, "unknown");
assert.equal(trigger.attributes["aria-label"], "전표 사진 확인");
await modal.manager.loadStatuses([order(1)]);
assert.equal(trigger.textContent, "전표");
assert.equal(trigger.dataset.receiptRegistered, "false");
assert.equal(trigger.attributes["aria-label"], "전표 사진 등록");
await modal.manager.open(order(1), trigger);
const modalElements = descendants(modal.env.document.body);
const dialog = modalElements.find(node => node.attributes.role === "dialog");
assert.equal(dialog.attributes["aria-modal"], "true");
const inputs = modalElements.filter(node => node.tagName === "INPUT");
assert.equal(inputs.length, 2);
assert.equal(inputs[0].accept, "image/*");
assert.equal(inputs[0].attributes.capture, "environment");
assert.equal(inputs[1].attributes.capture, undefined, "album picker must not force the camera");
await findText(modal.env.document, "촬영").click();
assert.equal(inputs[0].clicked, 1, "camera picker opens directly from the click handler");
inputs[0].files = [new Blob(["camera original metadata"], { type: "image/jpeg" })];
await inputs[0].emit("change");
assert.equal(modal.calls.filter(call => call.action === "upload").length, 0, "preview/capture must not upload before Save");
assert.equal(findText(modal.env.document, "저장").disabled, false);
assert.equal(modal.env.urls.size, 1);
await findText(modal.env.document, "취소").click();
assert.equal(modal.calls.filter(call => call.action === "upload").length, 0, "Cancel must never upload");
assert.equal(modal.env.urls.size, 0, "closing must revoke the preview object URL");
assert.equal(modal.env.document.activeElement, trigger);
assert.equal(modal.env.document.body.style.overflow, "auto");

await modal.manager.open(order(1), trigger);
await modal.env.document.emit("keydown", { key: "Escape" });
assert.equal(descendants(modal.env.document.body).some(node => node.attributes.role === "dialog"), false);
assert.equal(modal.env.document.activeElement, trigger);
await modal.manager.open(order(1), trigger);
const photoInput = descendants(modal.env.document.body).find(node => node.tagName === "INPUT");
photoInput.files = [new Blob(["new photo"], { type: "image/jpeg" })];
await photoInput.emit("change");
await findText(modal.env.document, "저장").click();
assert.equal(modal.rows.has(id(1)), true);
assert.equal(trigger.textContent, "전표");
assert.equal(trigger.dataset.receiptRegistered, "true");
assert.equal(trigger.attributes["aria-label"], "전표 사진 보기·수정");
assert.equal(modal.env.urls.size, 0);
await modal.manager.open(order(1), trigger);
const replacementInput = descendants(modal.env.document.body).find(node => node.tagName === "INPUT");
replacementInput.files = [new Blob(["replacement"], { type: "image/jpeg" })];
await replacementInput.emit("change");
const uploadsBeforeDeniedReplacement = modal.calls.filter(call => call.action === "upload").length;
modal.env.confirm = message => { modal.env.confirms.push(message); return false; };
await findText(modal.env.document, "저장").click();
assert.equal(modal.calls.filter(call => call.action === "upload").length, uploadsBeforeDeniedReplacement, "declining replacement must not upload");
modal.env.confirm = message => { modal.env.confirms.push(message); return true; };
await findText(modal.env.document, "저장").click();
assert.equal(modal.env.confirms.length, 2, "replacement needs confirmation on every attempt");
assert.match(modal.env.confirms[0], /교체/);
await modal.manager.open(order(1), trigger);
await findText(modal.env.document, "사진 삭제").click();
assert.equal(modal.env.confirms.length, 3, "delete needs confirmation");
assert.equal(modal.rows.has(id(1)), false);
assert.equal(modal.env.urls.size, 0);

// Execute the actual print handler with controlled promises: no database or network calls.
const start = admin.indexOf("async function printBankOrders(");
const tail = admin.slice(start);
const handler = tail.slice(0, tail.indexOf("\n    }\n") + 6);
assert.doesNotMatch(handler, /setTimeout|\.fonts\.ready\.then/, "printing must await the image/font readiness helper, without timer races");
assert.ok(handler.indexOf("loadForPrint") < handler.indexOf("buildReport(report)"));
assert.ok(handler.indexOf("waitForPrintAssets(printWindow)") < handler.lastIndexOf("triggerPrint()"));
async function runPrint(failure) {
  const events = [], alerts = [];
  const button = { disabled: false, textContent: "Print" };
  const popup = { closed: false, document: { open() {}, write() {}, close() {} }, close() { this.closed = true; }, focus() {}, print() { events.push("print"); } };
  const report = { visibleOrders: [order(1)] };
  const context = {
    document: { getElementById: name => name === "bankPrintRangeBtn" ? button : { value: "2026-11-24" } },
    window: { open: () => { events.push("open"); return popup; }, DGV_BANK_REPORT: {
      buildReport: value => { events.push("build"); assert.ok(value.cardReceiptsByOrder); return { orderCount: 1 }; }, renderHtml: () => "report",
      waitForPrintAssets: async () => { events.push("assets"); if (failure === "assets") throw new Error("image decode failure"); },
    } },
    receiptManager: { loadForPrint: async () => { events.push("photos"); if (failure === "photos") throw Object.assign(new Error("receipt failure"), { code: "CARD_RECEIPT_PRINT_FAILED" }); return { [id(1)]: { dataUrl: "test" } }; } },
    loadTaxRangeReportData: async () => { events.push("query"); return report; },
    alert: value => alerts.push(value), console: { error() {} }, Date, Number,
  };
  vm.runInNewContext(`${handler}\nthis.run = printBankOrders;`, context);
  await context.run();
  assert.equal(button.disabled, false); assert.equal(button.textContent, "Print");
  return { events, popup, alerts };
}
const printSuccess = await runPrint();
assert.deepEqual(printSuccess.events, ["open", "query", "photos", "build", "assets", "print"]);
for (const failure of ["photos", "assets"]) {
  const result = await runPrint(failure);
  assert.equal(result.events.includes("print"), false, "failed attachments/assets must stop printing");
  assert.equal(result.popup.closed, true);
  assert.ok(result.alerts.length);
}

console.log("Card receipt regression passed: strict eligibility, private storage, safe replacement/deletion, 1205-order metadata paging, JPEG normalization, mobile capture, cancel, dialog focus and print readiness.");
