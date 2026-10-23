import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const edgeFunction = await readFile(
  path.join(
    projectRoot,
    "supabase/functions/admin-credential-settings/index.ts",
  ),
  "utf8",
);
const codeAdmin = await readFile(path.join(projectRoot, "code_admin.html"), "utf8");

assert.match(
  edgeFunction,
  /const MANAGER_ACCOUNT_EMAIL = ["']manager@dgv\.local["']/,
  "manager technical account email must remain fixed",
);
assert.match(
  edgeFunction,
  /type Action[\s\S]*?["']set_manager_password["']/,
  "credential function must accept the manager password action",
);
assert.match(
  edgeFunction,
  /role === ["']admin["'][\s\S]*?role === ["']manager["'][\s\S]*?role === ["']staff["']/,
  "verified Auth roles must recognize manager",
);
assert.match(
  edgeFunction,
  /derivedAuthPassword\([\s\S]*?["']staff["']\s*\|\s*["']manager["']\s*\|\s*["']admin["'][\s\S]*?`dgv-v2\/\$\{role\}\/\$\{raw\}`/,
  "manager passwords must use the same role-separated derivation contract",
);
assert.match(
  edgeFunction,
  /MANAGER_ACCOUNT_ROLE_MISMATCH/,
  "an existing manager email with the wrong role must be rejected",
);
assert.match(
  edgeFunction,
  /createUser\(\{[\s\S]*?email:\s*MANAGER_ACCOUNT_EMAIL,[\s\S]*?password:\s*authPassword,[\s\S]*?email_confirm:\s*true,[\s\S]*?app_metadata:\s*\{\s*role:\s*["']manager["']\s*\}/,
  "a missing manager account must be created confirmed with app_metadata authorization",
);
assert.match(
  edgeFunction,
  /updateUserById\(managerUser\.id,\s*\{[\s\S]*?password:\s*authPassword[\s\S]*?\}\)/,
  "an existing manager account must be updated in place",
);
assert.doesNotMatch(
  edgeFunction,
  /user_metadata\s*:\s*\{\s*role\s*:/,
  "authorization must never be stored in user-editable metadata",
);

const adminCheck = edgeFunction.indexOf("const adminUser = await requireAdmin(database, token)");
const managerMutation = edgeFunction.indexOf("managerCreated = await setManagerPassword");
assert.ok(adminCheck >= 0, "credential handler must verify the exact admin account");
assert.ok(
  managerMutation > adminCheck,
  "manager account changes must happen only after admin verification",
);

const managerSetterStart = edgeFunction.indexOf("async function setManagerPassword");
const managerSetterEnd = edgeFunction.indexOf("export async function handler", managerSetterStart);
const managerSetter = edgeFunction.slice(managerSetterStart, managerSetterEnd);
assert.doesNotMatch(
  managerSetter,
  /\.from\(["'](?:admin_settings|page_access_code)["']\)/,
  "the raw manager password must not be copied into legacy tables",
);

assert.match(codeAdmin, /id=["']newManagerPw["'][^>]*type=["']password["']/);
assert.match(codeAdmin, /id=["']saveManagerPwBtn["']/);
assert.match(
  codeAdmin,
  /body:\s*\{\s*action:\s*["']set_manager_password["'],\s*new_password:\s*np\s*\}/,
  "admin page must invoke only the trusted credential function",
);
assert.match(
  codeAdmin,
  /await DGV\.signInAs\(["']admin["'],\s*pass\)/,
  "credential page must remain admin-only",
);

const managerUiStart = codeAdmin.indexOf("async function updateManagerPassword");
const managerUiEnd = codeAdmin.indexOf(
  'document.getElementById("saveManagerPwBtn").addEventListener',
  managerUiStart,
);
const managerUi = codeAdmin.slice(managerUiStart, managerUiEnd);
assert.doesNotMatch(
  managerUi,
  /signInAs\(["']manager["']/,
  "setting the manager password must not replace the administrator session",
);
assert.doesNotMatch(
  managerUi,
  /(?:localStorage|sessionStorage)\.setItem/,
  "manager passwords must not be persisted in browser storage",
);

console.log("Manager credential security contracts passed.");
