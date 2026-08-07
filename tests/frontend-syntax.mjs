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

console.log(`Parsed ${scriptsChecked} inline scripts across ${files.length} pages.`);
