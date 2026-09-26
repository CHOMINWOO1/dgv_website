import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const token = String(process.env.DGV_QR_TEST_TOKEN || "").trim();
assert.match(token, /^[0-9a-f]{64}$/, "DGV_QR_TEST_TOKEN must be 64 lowercase hex characters");

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configSource = await readFile(path.join(projectRoot, "assets/supabase-config.js"), "utf8");
const projectUrl = configSource.match(/url:\s*"([^"]+)"/)?.[1];
const publishableKey = configSource.match(/publishableKey:\s*"([^"]+)"/)?.[1];
assert.ok(projectUrl && publishableKey, "public Supabase configuration is missing");

const endpoint = `${projectUrl}/functions/v1/qr-menu`;
const headers = {
  apikey: publishableKey,
  authorization: `Bearer ${publishableKey}`,
  "content-type": "application/json",
  origin: "http://127.0.0.1:4173",
};

async function call(body) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  assert.equal(response.ok, true, `Edge request failed (${response.status}): ${JSON.stringify(payload)}`);
  return payload;
}

const menu = await call({ action: "get_menu", table_token: token });
assert.equal(menu.table?.label, "__codex_qr_smoke_20260926__");
assert.equal(menu.items?.length, 48);
assert.equal(menu.categories?.length, 6);

const orderable = menu.items.find((item) =>
  item.is_active === true &&
  item.is_orderable === true &&
  item.is_sold_out === false &&
  item.requires_preorder === false
);
assert.ok(orderable?.id, "no orderable menu item was returned");

const submitted = await call({
  action: "submit_order",
  table_token: token,
  client_request_id: "11111111-1111-4111-8111-111111111111",
  note: "Codex live smoke test",
  items: [{ menu_item_id: orderable.id, qty: 1 }],
});
assert.equal(submitted.order?.status, "submitted");
assert.equal(submitted.order?.table_label, "__codex_qr_smoke_20260926__");
assert.equal(Number(submitted.order?.total_vnd), Number(orderable.price_vnd));

console.log(JSON.stringify({
  table: menu.table.label,
  menuItems: menu.items.length,
  orderId: submitted.order.id,
  status: submitted.order.status,
  authoritativeVnd: submitted.order.total_vnd,
}));
