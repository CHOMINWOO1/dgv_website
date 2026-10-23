import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// These hashes cover every byte that can affect the approved page structure or
// CSS, while deliberately excluding script tags. The calc baseline includes the
// approved admin-style password modal; all other user-visible structure remains
// locked against accidental redesign.
const expected = new Map([
  ["calc.html", "9a3617907d2b31200ce8e0512883f269c7cc0a23543347604c3e0833b66dd134"],
  ["admin.html", "8b142a1e5056070fa43e539aa1209be85daee2bbce6bd10fc128718d45842e45"],
  ["hana_admin_hidden.html", "6b00e8afc8654875d18303a3f5753b35d6e5e3e8ba56879acb341808fb65d4f6"],
  ["code_admin.html", "03e1f70082fd7c88756bc464a2eb6c5c205dfacc54e6d3359b7ce288af4d6d65"],
  ["notice.html", "958870fcedd4ddee38249825f3cf254352e6f31cb9733c0b6951f79547e2f348"],
  ["reservation.html", "a2f09f8977de795ff97b2fed10c983c1d4a52b7dfc3a1ac50f4e267cd0c37eaf"],
  ["reserv_check.html", "b09af6e5d747acc9829b1a917d54a32e70d1f410ec47b6d6c760856671e28a06"],
  ["hana_reserv_check_hidden.html", "cc2057fd898dbbaa0456fcbf6ece211f3f3f38d8d5172adf9467effc5dec4b51"],
  ["reserv_admin.html", "18b9a9d2266c7023d9e6db09a3be37b94359f53bd34e651d0adde5683178961d"],
  ["report.html", "9f285e2cf8bfb25470d3a6d07ab494952c51b2b23a813c18edc55e10f19e60aa"],
]);

function visibleStructure(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n[ \t]*\n+/g, "\n")
    .trim();
}

const hiddenAdminHtml = await readFile(path.join(projectRoot, "hana_admin_hidden.html"), "utf8");
assert.match(
  hiddenAdminHtml,
  /<a\b(?=[^>]*\bclass="btn")(?=[^>]*\bid="reservOriginalBtn")(?=[^>]*\bhref="hana_reserv_check_hidden\.html")[^>]*>예약 원본 조회<\/a>/,
  "hidden sales admin must link to the administrator reservation original view",
);

let failed = false;
for (const [file, expectedHash] of expected) {
  const html = await readFile(path.join(projectRoot, file), "utf8");
  const actualHash = createHash("sha256")
    .update(visibleStructure(html))
    .digest("hex");

  if (actualHash !== expectedHash) {
    failed = true;
    console.error(`${file}: visible HTML/CSS changed (${actualHash})`);
  }
}

if (failed) process.exitCode = 1;
else console.log(`UI structure unchanged across ${expected.size} protected pages.`);
