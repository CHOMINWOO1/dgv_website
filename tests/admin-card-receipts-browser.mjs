// Synthetic browser-only QA. Every request is intercepted; no real account, API or business photo is used.
import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appUrl = "https://card-receipt-ui.test/admin.html";
const admin = await readFile(path.join(root, "admin.html"), "utf8");
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE
  || "C:/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs").href);

function installSyntheticBackend(snapshot) {
  const id = value => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
  const makeOrder = (value, payment_method, extra = {}) => ({
    id: id(value), payment_method, status: "paid", sales_excluded: false, created_at: new Date().toISOString(),
    total_vnd: 150000, total_usd: 6, guide_name: "SYNTHETIC QA", team_no: `QA ${value}`, source: "calculator", ...extra,
  });
  const state = window.__receiptQa = {
    calls: [], downloads: [], uploads: [], removes: [], objects: {}, rows: {}, failRead: false,
    orders: [makeOrder(1, "card"), makeOrder(2, "cash"), makeOrder(3, "bank"), makeOrder(4, "card", { status: "pending" }), makeOrder(5, "card", { sales_excluded: true })],
  };
  state.originalOrders = JSON.stringify(state.orders);
  if (snapshot) {
    state.rows = snapshot.rows;
    for (const [storagePath, base64] of Object.entries(snapshot.objects)) state.objects[storagePath] = new Blob([Uint8Array.from(atob(base64), value => value.charCodeAt(0))], { type: "image/jpeg" });
  }
  class Query {
    constructor(table) { this.table = table; this.operation = "select"; this.filters = []; this.sorts = []; this.first = 0; this.last = Infinity; }
    select() { return this; }
    eq(key, value) { this.filters.push(row => row[key] === value); return this; }
    gte(key, value) { this.filters.push(row => row[key] >= value); return this; }
    lte(key, value) { this.filters.push(row => row[key] <= value); return this; }
    lt(key, value) { this.filters.push(row => row[key] < value); return this; }
    in(key, values) { this.filters.push(row => values.includes(row[key])); return this; }
    order(key, options = {}) { this.sorts.push({ key, ascending: options.ascending !== false }); return this; }
    range(first, last) { this.first = first; this.last = last; return this; }
    limit(limit) { this.last = limit - 1; return this; }
    single() { this.singleRow = true; return this; }
    insert(value) { this.operation = "insert"; this.value = value; return this; }
    update(value) { this.operation = "update"; this.value = value; return this; }
    delete() { this.operation = "delete"; return this; }
    then(resolve, reject) {
      const run = async () => {
        state.calls.push({ table: this.table, operation: this.operation, value: this.value ? structuredClone(this.value) : undefined });
        if (this.operation !== "select" && this.table !== "order_card_receipts") throw new Error("QA denies all business data writes");
        if (this.table === "order_card_receipts" && this.operation === "select" && state.failRead) return { data: null, error: { message: "Synthetic receipt read failure" } };
        let rows = this.table === "orders" ? state.orders : this.table === "order_card_receipts" ? Object.values(state.rows) : [];
        if (this.operation === "insert" || this.operation === "update") {
          if (this.operation === "insert" && state.rows[this.value.order_id]) return { data: null, error: { message: "Duplicate receipt" } };
          if (this.operation === "update" && !this.filters.every(filter => filter(state.rows[this.value.order_id] || {}))) return { data: null, error: { message: "Receipt CAS failed" } };
          state.rows[this.value.order_id] = structuredClone(this.value);
          rows = [state.rows[this.value.order_id]];
        } else {
          rows = rows.filter(row => this.filters.every(filter => filter(row)));
          if (this.operation === "delete") rows.forEach(row => delete state.rows[row.order_id]);
          for (const sort of this.sorts.toReversed()) rows = rows.toSorted((a, b) => String(a[sort.key]).localeCompare(String(b[sort.key])) * (sort.ascending ? 1 : -1));
          rows = rows.slice(this.first, this.last + 1);
        }
        return { data: this.singleRow ? rows[0] || null : structuredClone(rows), error: null };
      };
      return run().then(resolve, reject);
    }
  }
  const client = {
    from: table => new Query(table),
    storage: { from: bucket => {
      if (bucket !== "order-card-receipts") throw new Error("Unexpected storage bucket");
      return {
        async upload(storagePath, blob, options) {
          state.uploads.push({ path: storagePath, size: blob.size, type: blob.type, options });
          if (options.upsert !== false || state.objects[storagePath]) throw new Error("Unsafe object overwrite");
          state.objects[storagePath] = blob;
          return { data: { path: storagePath }, error: null };
        },
        async download(storagePath) {
          state.downloads.push(storagePath);
          return state.objects[storagePath] ? { data: state.objects[storagePath], error: null } : { data: null, error: { message: "Synthetic object missing" } };
        },
        async remove(paths) {
          state.removes.push(...paths);
          for (const storagePath of paths) if (!Object.values(state.rows).some(row => row.storage_path === storagePath)) delete state.objects[storagePath];
          return { data: [], error: null };
        },
      };
    } },
  };
  window.DGV = {
    supabase: client,
    getIdentity: async () => ({ role: "manager" }),
    collectSupabasePages: window.DGV_DATA_UTILS.collectSupabasePages,
    escapeHTML: value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]),
  };
}

const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe" });
let checks = 0;
const check = (value, label) => { assert.ok(value, label); checks += 1; console.log("PASS", label); };
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1, serviceWorkers: "block" });
  const page = await context.newPage(), errors = [], unexpected = [], dialogs = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("dialog", async dialog => { dialogs.push(dialog.message()); await dialog.accept(); });
  const routeFixture = async (targetContext, snapshot = null) => targetContext.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.href === appUrl) return route.fulfill({ contentType: "text/html; charset=utf-8", body: admin });
    if (url.origin === new URL(appUrl).origin && url.pathname === "/assets/supabase-client.js") return route.fulfill({ contentType: "text/javascript", body: `(${installSyntheticBackend.toString()})(${JSON.stringify(snapshot)});` });
    if (url.origin === new URL(appUrl).origin && /^\/assets\/[a-z0-9-]+\.(js|css)$/.test(url.pathname)) {
      return route.fulfill({ contentType: url.pathname.endsWith(".css") ? "text/css" : "text/javascript", body: await readFile(path.join(root, url.pathname.slice(1)), "utf8") });
    }
    // The real SDK is intentionally not loaded. All fixture reads/writes stay in memory.
    if (url.hostname === "cdn.jsdelivr.net" && url.pathname.includes("@supabase/supabase-js")) return route.fulfill({ contentType: "text/javascript", body: "/* Intercepted synthetic QA: no Supabase SDK or external request. */" });
    unexpected.push({ url: url.href, method: route.request().method() });
    return route.abort("blockedbyclient");
  });
  await routeFixture(context);
  await page.goto(appUrl);
  const button = page.locator(".cardReceiptButton");
  await page.waitForFunction(() => document.querySelector(".cardReceiptButton")?.dataset.receiptRegistered === "false");
  check(await button.count() === 1, "only paid, non-excluded card order shows a receipt control");
  check(await page.locator("#ordersBody tr[data-order-id]").count() === 4, "cash, bank and pending orders remain visible without receipt controls");
  check(await button.getAttribute("data-receipt-registered") === "false", "initial receipt button visibly offers registration");
  check(await button.textContent() === "전표" && await button.getAttribute("aria-label") === "전표 사진 등록", "compact list label is exactly 전표 with a full Korean accessible name");
  const missingColor = await button.evaluate(element => getComputedStyle(element).color);
  check(missingColor === "rgb(180, 35, 24)", "missing receipt control is red");
  check(await page.evaluate(() => __receiptQa.downloads.length) === 0, "list load does not download photos");

  const imageDataUrl = await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 2400; canvas.height = 1800;
    const context = canvas.getContext("2d"); context.fillStyle = "#fff"; context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#222"; context.font = "64px sans-serif"; context.fillText("SYNTHETIC CARD RECEIPT", 100, 150);
    for (let y = 300; y < 1600; y += 120) context.fillRect(100, y, 2000, 5);
    return canvas.toDataURL("image/png");
  });
  const fixture = { name: "synthetic-card-receipt.png", mimeType: "image/png", buffer: Buffer.from(imageDataUrl.split(",")[1], "base64") };
  const title = "카드 매출전표 사진 / Ảnh biên lai thẻ";
  const dialog = page.getByRole("dialog", { name: title, exact: true });
  const save = page.getByRole("button", { name: "저장 / Lưu", exact: true });
  await button.click();
  await dialog.waitFor();
  const cameraInput = dialog.locator('input[type="file"][capture="environment"]');
  check(await cameraInput.getAttribute("accept") === "image/*", "camera input accepts images and requests the back-facing native camera");
  check(await dialog.locator('input[type="file"]:not([capture])').count() === 1, "album fallback does not force camera capture");
  const chooserPromise = page.waitForEvent("filechooser");
  await dialog.getByRole("button", { name: "촬영 / Chụp ảnh", exact: true }).click();
  const chooser = await chooserPromise;
  check(await chooser.element().getAttribute("capture") === "environment", "real user click opens the correct native file/camera control");
  await chooser.setFiles(fixture);
  await page.waitForFunction(() => !Array.from(document.querySelectorAll("button")).find(button => button.textContent === "저장 / Lưu")?.disabled);
  await dialog.locator("img").evaluate(image => image.decode());
  check(await page.evaluate(() => __receiptQa.uploads.length) === 0, "capture creates only a preview until Save");
  const preview = await dialog.locator("img").evaluate(image => ({ width: image.naturalWidth, height: image.naturalHeight }));
  check(preview.width === 2200 && preview.height === 1650, "real browser normalizes the raster to JPEG at max edge 2200");
  check(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1 && element.getBoundingClientRect().width <= innerWidth), "mobile receipt dialog has no horizontal overflow");
  const screenshotDir = path.join(root, "tmp", "card-receipts-qa");
  await mkdir(screenshotDir, { recursive: true });
  await page.screenshot({ path: path.join(screenshotDir, "mobile-preview.png"), fullPage: false });
  await save.click();
  await dialog.waitFor({ state: "detached" });
  check(await button.textContent() === "전표" && await button.getAttribute("aria-label") === "전표 사진 보기·수정", "registration keeps compact 전표 text and changes the action to View/Edit");
  check(await button.getAttribute("data-receipt-registered") === "true", "registered state is also reflected in the button attribute/style hook");
  check(await button.evaluate(element => getComputedStyle(element).color) === "rgb(24, 92, 163)", "registered receipt control changes from red to blue");
  check(await page.evaluate(() => __receiptQa.uploads.length === 1 && __receiptQa.uploads[0].type === "image/jpeg" && __receiptQa.uploads[0].size <= 2097152 && __receiptQa.uploads[0].options.upsert === false), "save uploads one bounded JPEG without overwriting an object");
  await page.screenshot({ path: path.join(screenshotDir, "mobile-registered.png"), fullPage: false });
  const originalPath = await page.evaluate(() => Object.values(__receiptQa.rows)[0].storage_path);

  const snapshot = await page.evaluate(async () => {
    const objects = {};
    for (const [storagePath, blob] of Object.entries(__receiptQa.objects)) {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (let index = 0; index < bytes.length; index += 32768) binary += String.fromCharCode(...bytes.subarray(index, index + 32768));
      objects[storagePath] = btoa(binary);
    }
    return { rows: __receiptQa.rows, objects };
  });
  const freshContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: "block" });
  await routeFixture(freshContext, snapshot);
  const freshPage = await freshContext.newPage();
  await freshPage.goto(appUrl);
  await freshPage.waitForFunction(() => document.querySelector(".cardReceiptButton")?.dataset.receiptRegistered === "true");
  const freshButton = freshPage.locator(".cardReceiptButton");
  check(await freshButton.textContent() === "전표" && await freshButton.evaluate(element => getComputedStyle(element).color) === "rgb(24, 92, 163)", "a fresh isolated device context reads persisted metadata and shows the blue receipt button");
  await freshButton.click();
  const freshDialog = freshPage.getByRole("dialog", { name: title, exact: true });
  await freshDialog.locator("img").waitFor({ state: "visible" });
  await freshDialog.locator("img").evaluate(image => image.decode());
  check(await freshPage.evaluate(() => __receiptQa.downloads.length === 1 && __receiptQa.uploads.length === 0), "a fresh device downloads the persisted photo without reuploading or depending on the first device's cache");
  await freshContext.close();

  await button.click();
  await dialog.waitFor();
  await dialog.locator("img").waitFor({ state: "visible" });
  await dialog.locator("img").evaluate(image => image.decode());
  check(await page.evaluate(() => __receiptQa.downloads.length) === 1, "reopening retrieves the persisted private photo rather than only a local preview");
  check(await save.isDisabled(), "viewing an existing photo does not enable accidental resaving");
  await cameraInput.setInputFiles(fixture);
  await page.waitForFunction(() => !Array.from(document.querySelectorAll("button")).find(button => button.textContent === "저장 / Lưu")?.disabled);
  await save.click();
  await dialog.waitFor({ state: "detached" });
  check(dialogs.length === 1 && dialogs[0].includes("교체"), "replacing the persisted photo requires confirmation");
  check(await page.evaluate(oldPath => { const current = Object.values(__receiptQa.rows)[0].storage_path; return current !== oldPath && !__receiptQa.objects[oldPath] && !!__receiptQa.objects[current]; }, originalPath), "replacement commits a new private path and removes only the previous unreferenced photo");

  await button.click();
  await dialog.waitFor();
  await dialog.locator("img").waitFor({ state: "visible" });
  await dialog.locator("img").evaluate(image => image.decode());
  await dialog.getByRole("button", { name: "사진 삭제 / Xóa ảnh", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  check(dialogs.length === 2 && dialogs[1].includes("삭제"), "deletion requires a separate confirmation");
  check(await button.textContent() === "전표" && await button.getAttribute("aria-label") === "전표 사진 등록" && await button.evaluate(element => getComputedStyle(element).color) === missingColor, "deletion returns the compact 전표 control to red/Register");
  check(await page.evaluate(() => !Object.keys(__receiptQa.rows).length && !Object.keys(__receiptQa.objects).length), "delete removes receipt metadata and the now-unreferenced object");

  await button.click();
  await dialog.waitFor();
  await cameraInput.setInputFiles(fixture);
  await page.waitForFunction(() => !Array.from(document.querySelectorAll("button")).find(button => button.textContent === "저장 / Lưu")?.disabled);
  const beforeCancel = await page.evaluate(() => __receiptQa.uploads.length);
  await dialog.getByRole("button", { name: "취소 / Hủy", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  check(await page.evaluate(() => __receiptQa.uploads.length) === beforeCancel, "Cancel after capture never uploads a photo");
  check(await button.evaluate(element => document.activeElement === element), "closing the modal restores focus to its list button");
  await button.click();
  await dialog.waitFor();
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  check(await button.evaluate(element => document.activeElement === element), "Escape closes the idle modal and restores focus");
  check(await page.evaluate(() => __receiptQa.originalOrders === JSON.stringify(__receiptQa.orders)), "register/view/replace/delete never change order or payment data");
  check(await page.evaluate(() => __receiptQa.calls.filter(call => call.operation !== "select").every(call => call.table === "order_card_receipts")), "all synthetic metadata writes are confined to the receipt table");
  check(errors.length === 0, `actual admin page has no uncaught browser errors: ${errors.join(", ")}`);
  check(unexpected.length === 0, "no external request escaped the synthetic interception");
  console.log(`Card receipt browser: ${checks} checks passed. QA screenshots: ${screenshotDir}`);
  await context.close();
} finally {
  await browser.close();
}
