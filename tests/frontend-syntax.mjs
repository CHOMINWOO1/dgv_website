import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = [
  "calc.html",
  "admin.html",
  "hana_admin_hidden.html",
  "code_admin.html",
  "notice.html",
  "reservation.html",
  "reserv_check.html",
  "reserv_admin.html",
  "report.html",
  "menu.html",
  "order_inbox.html",
  "menu_admin.html",
];

const externalScripts = [
  "assets/qr-menu.js",
  "assets/qr-staff.js",
  "assets/order-inbox.js",
  "assets/menu-admin.js",
  "assets/vendor/qrcode.min.js",
];

let scriptsChecked = 0;
for (const file of files) {
  const html = await readFile(path.join(projectRoot, file), "utf8");
  const pattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;
  let scriptIndex = 0;
  while ((match = pattern.exec(html)) !== null) {
    scriptIndex += 1;
    const attributes = match[1];
    const source = match[2];
    if (/\bsrc\s*=/i.test(attributes) || source.trim() === "") continue;
    if (/\btype\s*=\s*["'](?!text\/javascript|application\/javascript)/i.test(attributes)) continue;

    new vm.Script(source, { filename: `${file}:inline-script-${scriptIndex}` });
    scriptsChecked += 1;
  }
}

for (const file of externalScripts) {
  const source = await readFile(path.join(projectRoot, file), "utf8");
  new vm.Script(source, { filename: file });
  scriptsChecked += 1;
}

console.log(`Parsed ${scriptsChecked} browser scripts across ${files.length} pages.`);
