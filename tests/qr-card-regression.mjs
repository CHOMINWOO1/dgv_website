import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFile(path.join(projectRoot, file), "utf8");

const [homeHtml, menuAdminHtml, menuAdminSource, staffCss] = await Promise.all([
  read("home.html"),
  read("menu_admin.html"),
  read("assets/menu-admin.js"),
  read("assets/qr-staff.css"),
]);

assert.match(homeHtml, /data-href="menu_admin\.html"[\s\S]*?<div class="name">메뉴 어드민<\/div>/);
assert.match(homeHtml, /data-href="order_inbox\.html"[\s\S]*?<div class="name">인박스 오더<\/div>/);

const brandIndex = menuAdminHtml.indexOf("HANA RESTAURANT");
const calloutIndex = menuAdminHtml.indexOf("ORDER HERE", brandIndex);
const tableIndex = menuAdminHtml.indexOf('id="tokenTableTitle"', calloutIndex);
const qrIndex = menuAdminHtml.indexOf('id="tokenQr"', tableIndex);
assert.ok(brandIndex >= 0 && brandIndex < calloutIndex, "QR preview must place the restaurant name first");
assert.ok(calloutIndex < tableIndex, "QR preview must place ORDER HERE above the table title");
assert.ok(tableIndex < qrIndex, "QR preview must place the table title above the QR code");

assert.match(menuAdminSource, /byId\("tokenTableTitle"\)\.textContent = currentTokenLabel/);
assert.match(menuAdminSource, /async function qrCardDataUrl\(\)[\s\S]*?"HANA RESTAURANT"[\s\S]*?"ORDER HERE"[\s\S]*?currentTokenLabel \|\| "테이블"[\s\S]*?context\.drawImage\(qrSource,/);
assert.match(menuAdminSource, /async function downloadQr\(\)[\s\S]*?await qrCardDataUrl\(\)[\s\S]*?link\.href = dataUrl/);
assert.match(menuAdminSource, /async function printQr\(\)[\s\S]*?await qrCardDataUrl\(\)[\s\S]*?printImage\.src = dataUrl[\s\S]*?global\.print\(\)/);
assert.match(menuAdminSource, /if \(image\.complete\) return image\.naturalWidth > 0 \? image : null/);
assert.match(menuAdminSource, /function waitForImageReady\(image\)[\s\S]*?image\.addEventListener\("load"[\s\S]*?image\.addEventListener\("error"/);
assert.match(menuAdminSource, /function waitForImageReady\(image\)[\s\S]*?if \(image\.complete\)[\s\S]*?image\.naturalWidth > 0[\s\S]*?Promise\.reject/);
assert.match(menuAdminSource, /printImage\.src = dataUrl[\s\S]*?await waitForImageReady\(printImage\)[\s\S]*?global\.print\(\)/);
assert.doesNotMatch(menuAdminSource, /qrPrintTitle/);

assert.match(menuAdminSource, /data-table-action="archive"[^>]*>QR 삭제<\/button>/);
assert.match(menuAdminSource, /\.select\("id,label,qr_kind,is_active,archived_at,created_at,updated_at"\)[\s\S]*?\.is\("archived_at", null\)/);
assert.match(menuAdminSource, /async function archiveTable\(tableId, button\)[\s\S]*?테이블 QR을 삭제하시겠습니까[\s\S]*?기존 주문 이력은 보존되며[\s\S]*?기존 QR은 즉시 사용할 수 없게 됩니다/);
assert.match(menuAdminSource, /sb\.rpc\("app_archive_qr_table", \{ p_table_id: tableId \}\)/);
assert.match(menuAdminSource, /function removeCachedTableQrUrl[\s\S]*?const entries = readTableQrCache\(\)\.filter/);
assert.match(menuAdminSource, /async function archiveTable[\s\S]*?removeCachedTableQrUrl\(tableId\)[\s\S]*?await loadTables\(\)/);

assert.match(staffCss, /\.qr-order-card-preview\s*\{/);
assert.match(staffCss, /@media print[\s\S]*?\.qr-print-sheet img\s*\{[\s\S]*?height:\s*auto/);

console.log("Home QR links and shared preview/download/print QR card contract verified.");
