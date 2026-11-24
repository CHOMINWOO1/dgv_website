// Isolated generated-print fixture: no live authentication, API or business data.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(path.join(root, "assets/admin-bank-report.js"), "utf8");
const scope = { Date, Intl, Map, Set, Object, Array, Number, String, Boolean, Math, JSON };
vm.runInNewContext(source, scope);
const api = scope.DGV_BANK_REPORT;
// Synthetic raster-only receipt fixtures, built in memory rather than from business photos.
function fixturePng(width, height) {
  const crc = buffer => {
    let value = 0xffffffff;
    for (const byte of buffer) {
      value ^= byte;
      for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (kind, data) => {
    const payload = Buffer.concat([Buffer.from(kind), data]);
    const size = Buffer.alloc(4), checksum = Buffer.alloc(4);
    size.writeUInt32BE(data.length); checksum.writeUInt32BE(crc(payload));
    return Buffer.concat([size, payload, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc((width * 3 + 1) * height, 255);
  for (let y = 0; y < height; y++) {
    pixels[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const offset = y * (width * 3 + 1) + 1 + x * 3;
      const ink = x < 4 || x >= width - 4 || y < 4 || y >= height - 4 || y % 70 < 3 && x > width * .12 && x < width * .88;
      pixels.fill(ink ? 35 : 248, offset, offset + 3);
    }
  }
  return "data:image/png;base64," + Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}
const order = (id, payment_method, total_vnd, extra = {}) => ({
  id, payment_method, total_vnd, status: "paid", created_at: "2026-11-05T17:05:00Z",
  guide_name: '<img src=x onerror="alert(1)">', team_no: "테이블 102", ...extra,
});
const line = (qty, unit_vnd = 50_000) => ({
  ko_name: "반복 메뉴", vi_name: "Cùng món & <script>", qty, unit_vnd, line_vnd: qty * unit_vnd,
  menu_items: { price_vnd: 999_999 },
});
const input = {
  rangeText: "2026-11-06 ~ 2026-11-06", generatedAt: new Date("2026-11-07T01:02:00+07:00"),
  visibleOrders: [
    order("card-b", " CARD ", 100_000), order("bank-a", "bank", 50_000),
    order("cash-c", "cash", 60_000), order("cash-a", "cash", 50_000),
    order("bank-zero", "bank", 0), order("card-a", "card", 50_000),
    order("cash-b", "cash", 100_000),
    order("cash-pending", "cash", 50_000, { status: "pending" }),
    order("card-cancelled", "card", 50_000, { status: "cancelled" }),
    order("cash-excluded", "cash", 50_000, { sales_excluded: true }),
    order("unsupported-method", "voucher", 50_000),
  ],
  linesByOrder: new Map([
    ["bank-a", [line(1)]], ["bank-zero", [{ ...line(1), line_vnd: 0 }]],
    ["cash-a", [line(1)]], ["cash-b", [line(2)]], ["cash-c", [line(1, 60_000)]],
    ["card-a", [line(1)]], ["card-b", [line(2)]],
  ]),
  cardReceiptsByOrder: new Map([
    ["card-b", { dataUrl: fixturePng(360, 2200) }], ["card-a", { dataUrl: fixturePng(2200, 360) }],
    ["bank-a", { dataUrl: fixturePng(100, 100) }], ["cash-a", { dataUrl: fixturePng(100, 100) }],
  ]),
};
const serialize = value => JSON.stringify(value, (_key, item) => item instanceof Map ? Array.from(item.entries()) : item);
const inputBefore = serialize(input), model = api.buildReport(input), modelBefore = serialize(model);
const html = api.renderHtml(model);
assert.equal(serialize(input), inputBefore);
assert.equal(serialize(model), modelBefore);
const expectedOrders = [...model.otherOrders.filter(item => item.paymentMethod === "card"), ...model.orders,
  ...model.otherOrders.filter(item => item.paymentMethod === "cash")];
assert.equal(expectedOrders.length, 7);

const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE
  || "C:/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs").href);
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe" });
let checks = 0;
const check = (value, label) => { assert.ok(value, label); checks++; console.log("PASS", label); };
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, serviceWorkers: "block" });
  const page = await context.newPage(), errors = [], unexpectedRequests = [], dialogs = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("dialog", async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  const appUrl = "https://payment-print-fixture.test/report.html";
  await context.route("**/*", async route => {
    if (route.request().url() === appUrl && route.request().isNavigationRequest()) {
      await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html });
    } else {
      unexpectedRequests.push({ url: route.request().url(), method: route.request().method() });
      await route.abort("blockedbyclient");
    }
  });
  await page.goto(appUrl);
  await page.evaluate(source);
  await page.evaluate(() => DGV_BANK_REPORT.waitForPrintAssets(window));
  check(await page.locator(".reportSection:not(.receiptPage)").count() === 7, "seven paid orders generate seven independent order sections");
  check(await page.locator(".reportSection").count() === 9, "two attached card receipts add exactly two separate pages");
  check(await page.locator(".bankOrder").count() === 2, "bank orders remain individual");
  check(await page.locator(".cashOrders").count() === 3, "three matching-menu cash orders remain individual");
  check(await page.locator(".cardOrders").count() === 2, "two matching-menu card orders remain individual");

  const sections = await page.locator(".reportSection:not(.receiptPage)").evaluateAll(elements => elements.map(element => ({
    text: element.innerText,
    title: element.querySelector("h1")?.textContent,
    vietnameseTitle: element.querySelector("h2")?.textContent,
    meta: element.querySelector(".orderMeta")?.innerText,
    rows: Array.from(element.querySelectorAll(".items tbody tr"), row => Array.from(row.cells, cell => cell.innerText)),
    grand: element.querySelector(".grand")?.innerText,
    ending: !!element.querySelector(".orderEnding"),
    overflow: element.scrollWidth > element.clientWidth + 1,
  })));
  for (const [index, item] of expectedOrders.entries()) {
    const section = sections[index], formatted = value => value.toLocaleString("en-US");
    const methodName = { bank: "은행", cash: "현금", card: "카드" }[item.paymentMethod];
    const vietnameseName = { bank: "CHUYỂN KHOẢN", cash: "TIỀN MẶT", card: "THẺ" }[item.paymentMethod];
    check(section.meta.includes(item.id), `${item.id}: card/bank/cash ordering and order metadata are preserved`);
    check(expectedOrders.filter(other => other.id !== item.id).every(other => !section.text.includes(other.id)), `${item.id}: no other order identity leaks into its section`);
    check(section.title === `${methodName} 결제 주문 내역` && section.vietnameseTitle === `CHI TIẾT ĐƠN HÀNG ${vietnameseName}`, `${item.id}: bilingual heading identifies its payment method`);
    check(section.rows.length === 1, `${item.id}: one original line is not merged with matching menus in other orders`);
    assert.deepEqual(section.rows[0].slice(-3), [formatted(item.lines[0].qty), formatted(item.lines[0].unitAmount), formatted(item.lines[0].grossAmount)]);
    check(section.grand.includes(`${formatted(item.grossAmount)} VND`) && section.grand.includes(`${methodName} 결제 총액 (VAT 포함)`), `${item.id}: saved VAT-inclusive order total remains local to the order`);
    check(section.text.includes(`출력 묶음 / Nhóm in: ${index + 1} / 7`) && section.text.includes("2026-11-06 00:05"), `${item.id}: continuous numbering and Vietnam order time are shown`);
    check(section.ending && !section.overflow, `${item.id}: totals/footer stay in the order ending with no horizontal overflow`);
  }
  check(await page.locator("script, .orderIndex, .sectionIntro, img:not(.receiptImage)").count() === 0, "untrusted labels remain text and only validated receipt images are rendered");
  const receipts = await page.locator(".receiptPage").evaluateAll(elements => elements.map(element => ({
    previousId: element.previousElementSibling.querySelector(".orderMeta")?.innerText,
    caption: element.querySelector("figcaption").innerText,
    imageCount: element.querySelectorAll("img").length,
    src: element.querySelector("img").getAttribute("src"),
    width: element.querySelector("img").naturalWidth,
    height: element.querySelector("img").naturalHeight,
  })));
  for (const [index, receipt] of receipts.entries()) {
    const item = expectedOrders[index];
    check(receipt.previousId.includes(item.id) && receipt.caption.includes(item.id), `${item.id}: its receipt page directly follows its complete order section`);
    check(receipt.caption.includes("카드 주문번호 / Mã đơn thanh toán thẻ") && receipt.caption.includes("2026-11-06 00:05")
      && receipt.caption.includes(`${item.grossAmount.toLocaleString("en-US")} VND`), `${item.id}: bilingual receipt caption retains card order id, date and total`);
    check(receipt.imageCount === 1 && /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(receipt.src) && receipt.width > 0 && receipt.height > 0,
      `${item.id}: exactly one local raster receipt finishes loading and decoding`);
  }
  check(!sections.some(section => /합산 내역|TỔNG HỢP THANH TOÁN|360,000/.test(section.text)), "printed output never substitutes method or range aggregates");

  await page.emulateMedia({ media: "print" });
  const breaks = await page.locator(".reportSection").evaluateAll(elements => elements.map(element => getComputedStyle(element).breakBefore));
  check(breaks[0] !== "page" && breaks.slice(1).every(value => value === "page"), "every later order and receipt starts on a new printed page");
  const receiptLayout = await page.locator(".receiptPage").evaluateAll(elements => elements.map(element => {
    const image = element.querySelector("img"), page = element.getBoundingClientRect(), photo = image.getBoundingClientRect();
    return { fit: getComputedStyle(image).objectFit, height: page.height, noOverflow: element.scrollHeight <= element.clientHeight + 1,
      contained: photo.top >= page.top && photo.bottom <= page.bottom + 1 && photo.left >= page.left && photo.right <= page.right + 1 };
  }));
  check(receiptLayout.every(item => item.fit === "contain" && item.contained && item.noOverflow && item.height <= 271 * 96 / 25.4),
    "both tall and wide receipt photos fit within one printable A4 page without cropping or overflow");
  const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
  const pdfPages = pdf.toString("latin1").match(/\/Type\s*\/Page\b/g) || [];
  check(pdfPages.length === 9, "one PDF job contains seven individual orders plus two immediately following receipt A4 pages");
  const brokenPage = await context.newPage();
  await brokenPage.setContent('<img src="data:image/png;base64,AAAA">');
  await brokenPage.evaluate(source);
  const brokenResult = await brokenPage.evaluate(() => DGV_BANK_REPORT.waitForPrintAssets(window).then(() => "ready", error => error.code));
  check(brokenResult === "PAYMENT_PRINT_IMAGE_ERROR", "a broken raster receipt rejects print readiness instead of allowing an incomplete job");
  await brokenPage.close();
  check(errors.length === 0 && dialogs.length === 0, "generated HTML raises no browser errors or active-content dialogs");
  check(unexpectedRequests.length === 0, "the generated report performs no external network requests");
  console.log(`Individual payment print browser: ${checks} checks passed; all network intercepted; PDF generated only in memory.`);
  await context.close();
} finally {
  await browser.close();
}
