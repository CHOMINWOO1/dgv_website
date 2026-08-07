import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// These hashes cover every byte that can affect the approved page structure or
// CSS, while deliberately excluding script tags. The calc baseline includes the
// approved admin-style password modal; all other user-visible structure remains
// locked against accidental redesign.
const expected = new Map([
  ["calc.html", "4dfa556c02b5bf9de602899fd1254d70cfa9a8b1bfda2d2ded0a4c35f24c19a7"],
  ["admin.html", "b0a6757e6e798c2822044faddfe8f7da52c469615f0bb5bbaac32f6ac936a003"],
  ["hana_admin_hidden.html", "c3249bd30e455feea2ad4240e8297bbacf331dc5e3d072a6721771756dd26a1b"],
  ["code_admin.html", "53374bb648ee17383abe97ac2fb148e38f298d32aaad3ae6be6d52b5939cd22a"],
  ["notice.html", "958870fcedd4ddee38249825f3cf254352e6f31cb9733c0b6951f79547e2f348"],
  ["reservation.html", "1d2914bef800450be5e80e17e9daf684825ae922b8d262139c7506ebb3e2f570"],
  ["reserv_check.html", "b09af6e5d747acc9829b1a917d54a32e70d1f410ec47b6d6c760856671e28a06"],
  ["reserv_admin.html", "fdc55c54449b4d338da5639fa637c752c63937f7e4acc8badf7fc0e4f8a4139b"],
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
