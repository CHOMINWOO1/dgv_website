import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const finalRef = "fbbecxtxsaplrmanjunw";
const productionRef = "qzuynzreamdkpmakvefm";
const protectedPages = [
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

async function staticChecks() {
  const config = await readFile(path.join(projectRoot, "assets/supabase-config.js"), "utf8");
  assert.match(config, new RegExp(finalRef), "local config must target final security project");
  assert.doesNotMatch(config, new RegExp(productionRef), "local config must not target production");

  const legacyRpcPattern = new RegExp([
    "admin_check_password",
    "check_page_access_code",
    "admin_create_order_with_date",
    "admin_update_order(?:_with_items)?",
    "admin_delete_order",
    "admin_insert_resv_group",
    "admin_update_resv_group",
    "admin_mark_resv_confirmed",
    "admin_unmark_resv_confirmed",
  ].join("|"));

  for (const file of protectedPages) {
    const html = await readFile(path.join(projectRoot, file), "utf8");
    assert.match(html, /@supabase\/supabase-js@2\.112\.2/, `${file} must pin supabase-js`);
    assert.match(html, /assets\/supabase-config\.js/, `${file} must use central config`);
    assert.match(html, /assets\/dgv-data\.js/, `${file} must use central data helpers`);
    assert.match(html, /assets\/supabase-client\.js/, `${file} must use central client`);
    assert.doesNotMatch(html, new RegExp(productionRef), `${file} contains production ref`);
    assert.doesNotMatch(html, legacyRpcPattern, `${file} still calls a legacy password RPC`);
    assert.doesNotMatch(
      html,
      /sessionStorage\.setItem\([^\n]*(?:pass|password|code)/i,
      `${file} stores a shared password/code`,
    );
  }

  const helper = await readFile(path.join(projectRoot, "assets/supabase-client.js"), "utf8");
  assert.match(helper, /storage:\s*global\.sessionStorage/, "Auth tokens must stay tab-scoped");
  assert.match(helper, /signOut\(\{\s*scope:\s*["']local["']\s*\}\)/, "shared-account sign-out must be local");
  assert.match(helper, /dgv-v2\/\$\{normalizedRole\}\/\$\{String\(password\)\}/, "Auth password derivation changed");

  const hardening = await readFile(
    path.join(projectRoot, "supabase/migrations/20260807140126_security_hardening.sql"),
    "utf8",
  );
  assert.doesNotMatch(hardening, /status\s+in\s*\([^)]*delivered/i, "outbox must use sent");
  assert.doesNotMatch(hardening, /'reservation\.created'/, "outbox event name drifted");
  assert.match(hardening, /'resv_insert'/, "reservation outbox event is missing");
  assert.match(hardening, /alter view public\.v_order_detail_all set \(security_invoker = true\)/i);
  assert.match(hardening, /alter table public\.orders enable row level security/i);
  assert.match(hardening, /revoke execute on all functions in schema public/i);
  assert.match(hardening, /revoke all on all tables in schema public from anon, authenticated, service_role/i);
  assert.match(hardening, /if not public\.has_app_role\(array\['admin'\]::text\[\]\)/g);

  const reservationIntegrity = await readFile(
    path.join(
      projectRoot,
      "supabase/migrations/20260807140215_reservation_order_integrity.sql",
    ),
    "utf8",
  );
  for (const policy of [
    "orders_admin_read",
    "order_items_admin_read",
    "order_custom_items_admin_read",
  ]) {
    assert.match(
      reservationIntegrity,
      new RegExp(`create policy ${policy}[\\s\\S]*?array\\['admin'\\]::text\\[\\]`, "i"),
      `${policy} must be admin-only`,
    );
  }
  assert.doesNotMatch(
    reservationIntegrity,
    /drop policy if exists (?:menu_items_staff_read|resv_groups_staff_read)/i,
    "staff menu/reservation read policies must remain intact",
  );
  assert.doesNotMatch(
    reservationIntegrity,
    /idx_resv_groups_confirmed_order_id/i,
    "the already-applied integrity migration must match its pre-index body",
  );
  const reservationLinkIndex = await readFile(
    path.join(
      projectRoot,
      "supabase/migrations/20260807140223_reservation_order_link_index.sql",
    ),
    "utf8",
  );
  assert.match(
    reservationLinkIndex,
    /create index if not exists idx_resv_groups_confirmed_order_id[\s\S]*?where confirmed_order_id is not null/i,
    "reservation-order link checks need a partial follow-up index",
  );
  assert.match(
    reservationIntegrity,
    /v_source\s*=\s*'reservation_confirm'[\s\S]*?confirmed_order_id\s*=\s*p_order_id/i,
    "ordinary order updates must reject reservation-linked orders",
  );
  assert.match(
    reservationIntegrity,
    /create or replace function public\.app_update_reservation[\s\S]*?from public\.resv_groups[\s\S]*?for update[\s\S]*?from public\.orders[\s\S]*?for update/i,
    "confirmed reservation synchronization must lock reservation and order rows",
  );
  assert.match(
    reservationIntegrity,
    /update public\.order_custom_items[\s\S]*?qty\s*=\s*p_guests_count[\s\S]*?unit_vnd\s*=\s*p_price/i,
    "confirmed reservation synchronization must update the generated order item",
  );
  assert.match(
    reservationIntegrity,
    /create function public\.app_update_and_confirm_reservation[\s\S]*?security invoker[\s\S]*?set search_path\s*=\s*''/i,
    "atomic update-and-confirm RPC is missing its invoker/search_path contract",
  );
  assert.match(
    reservationIntegrity,
    /grant execute on function public\.app_update_and_confirm_reservation\([\s\S]*?\) to authenticated/i,
    "atomic update-and-confirm RPC grant is missing",
  );

  console.log("Static security contracts passed.");
}

function browserlessClient(url, key) {
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

async function expectDenied(promise, label) {
  const { data, error } = await promise;
  assert.ok(error, `${label} unexpectedly succeeded: ${JSON.stringify(data)}`);
}

async function expectNoRows(promise, label) {
  const { data, error } = await promise;
  assert.ifError(error);
  assert.deepEqual(data, [], `${label} exposed rows: ${JSON.stringify(data)}`);
}

async function liveChecks() {
  const url = process.env.DGV_STAGING_URL;
  const key = process.env.DGV_STAGING_PUBLISHABLE_KEY;
  if (!url || !key) {
    console.log("Live staging checks skipped (DGV_STAGING_URL/key not set). ");
    return;
  }

  const parsedUrl = new URL(url);
  assert.equal(parsedUrl.hostname, `${finalRef}.supabase.co`, "refusing to test a non-final-security project");
  const anon = browserlessClient(url, key);

  const { data: notices, error: noticeError } = await anon
    .from("notices")
    .select("id,title")
    .limit(5);
  assert.ifError(noticeError);
  assert.ok(Array.isArray(notices), "anonymous notices read did not return an array");

  await expectDenied(
    anon.from("orders").select("id").limit(1),
    "anonymous orders read",
  );

  await expectDenied(
    anon.rpc("app_create_reservation", {
      p_res_date: "2099-12-30",
      p_res_time: "18:00",
      p_guests_count: 2,
      p_price: 100000,
      p_menu_ko: "[TEST] anon denied",
      p_menu_vi: "[TEST] anon denied",
      p_note: null,
      p_branch: "[TEST]",
      p_guide_name: "[TEST]",
    }),
    "anonymous reservation mutation",
  );

  const staffRaw = process.env.DGV_STAGING_STAFF_PASSWORD;
  const adminRaw = process.env.DGV_STAGING_ADMIN_PASSWORD;
  if (!staffRaw || !adminRaw) {
    console.log("Authenticated staging checks skipped (raw staging test passwords not set). ");
    return;
  }

  const staff = browserlessClient(url, key);
  const staffLogin = await staff.auth.signInWithPassword({
    email: "staff@dgv.local",
    password: `dgv-v2/staff/${staffRaw}`,
  });
  assert.ifError(staffLogin.error);
  assert.equal(staffLogin.data.user?.app_metadata?.role, "staff");
  const staffMenuRead = await staff.from("menu_items").select("id").limit(1);
  assert.ifError(staffMenuRead.error);
  const staffRead = await staff.from("resv_groups").select("id").limit(1);
  assert.ifError(staffRead.error);
  await expectDenied(
    staff.rpc("app_create_reservation", {
      p_res_date: "2099-12-30",
      p_res_time: "18:00",
      p_guests_count: 2,
      p_price: 100000,
      p_menu_ko: "[TEST] staff denied",
      p_menu_vi: "[TEST] staff denied",
      p_note: null,
      p_branch: "[TEST]",
      p_guide_name: "[TEST]",
    }),
    "staff reservation mutation",
  );
  await expectDenied(
    staff.rpc("app_set_sales_excluded", {
      p_order_id: "00000000-0000-0000-0000-000000000000",
      p_excluded: true,
    }),
    "staff sales exclusion mutation",
  );
  await expectDenied(
    staff.rpc("app_update_and_confirm_reservation", {
      p_id: 0,
      p_res_date: "2099-12-30",
      p_res_time: "18:00",
      p_guests_count: 2,
      p_price: 100000,
      p_menu_ko: "[TEST] staff denied",
      p_menu_vi: "[TEST] staff denied",
      p_note: null,
      p_branch: "[TEST]",
      p_guide_name: "[TEST]",
      p_payment_method: "cash",
      p_team_no: "[TEST]",
    }),
    "staff atomic reservation confirmation",
  );

  const admin = browserlessClient(url, key);
  const adminLogin = await admin.auth.signInWithPassword({
    email: "admin@dgv.local",
    password: `dgv-v2/admin/${adminRaw}`,
  });
  assert.ifError(adminLogin.error);
  assert.equal(adminLogin.data.user?.app_metadata?.role, "admin");

  const directWrite = await admin.from("orders").insert({
    total_usd: 0,
    total_vnd: 0,
    source: "[TEST] direct REST must fail",
    status: "paid",
    payment_method: "cash",
  });
  assert.ok(directWrite.error, "direct authenticated table write bypassed app_* RPC gate");

  const menuResult = await admin
    .from("menu_items")
    .select("id")
    .eq("is_active", true)
    .order("sort_order")
    .limit(1)
    .single();
  assert.ifError(menuResult.error);

  let orderId;
  let reservationId;
  let reservationOrderId;
  let noticeId;
  try {
    const createdOrder = await admin.rpc("app_create_order", {
      p_created_at: "2099-12-30T12:00:00+07:00",
      p_source: "calc_web",
      p_status: "paid",
      p_guide_name: "[TEST] Regression",
      p_team_no: "[TEST] 001",
      p_payment_method: "cash",
      p_items: [
        { item_type: "menu", menu_item_id: menuResult.data.id, qty: 2 },
        {
          item_type: "custom",
          kind: "special",
          ko_name: "[TEST] Custom",
          vi_name: "[TEST] Custom VI",
          qty: 1,
          unit_usd: 1,
          unit_vnd: 1000,
        },
      ],
    });
    assert.ifError(createdOrder.error);
    orderId = createdOrder.data;
    assert.match(orderId, /^[0-9a-f-]{36}$/i);

    const updatedOrder = await admin.rpc("app_update_order", {
      p_order_id: orderId,
      p_status: "paid",
      p_guide_name: "[TEST] Regression Updated",
      p_team_no: "[TEST] 001-U",
      p_payment_method: "cash",
      p_items: [
        { item_type: "menu", menu_item_id: menuResult.data.id, qty: 3 },
        {
          item_type: "custom",
          kind: "special",
          ko_name: "[TEST] Custom Updated",
          vi_name: "[TEST] Custom VI Updated",
          qty: 1,
          unit_usd: 2,
          unit_vnd: 2000,
        },
      ],
    });
    assert.ifError(updatedOrder.error);
    assert.equal(updatedOrder.data, true);

    const updatedOrderRow = await admin.from("orders")
      .select("guide_name,team_no,payment_method,total_usd,total_vnd,sales_excluded")
      .eq("id", orderId)
      .single();
    assert.ifError(updatedOrderRow.error);
    assert.equal(updatedOrderRow.data.guide_name, "[TEST] Regression Updated");
    assert.equal(updatedOrderRow.data.team_no, "[TEST] 001-U");
    assert.equal(updatedOrderRow.data.payment_method, "cash");
    assert.equal(updatedOrderRow.data.sales_excluded, false);
    assert.ok(Number(updatedOrderRow.data.total_usd) >= 0);
    assert.ok(Number(updatedOrderRow.data.total_vnd) >= 0);

    await expectNoRows(
      staff.from("orders").select("id").eq("id", orderId),
      "staff orders read",
    );
    await expectNoRows(
      staff.from("order_items").select("id").eq("order_id", orderId),
      "staff order_items read",
    );
    await expectNoRows(
      staff.from("order_custom_items").select("id").eq("order_id", orderId),
      "staff order_custom_items read",
    );
    for (const view of [
      "v_order_detail",
      "v_order_detail_all",
      "v_sales_daily",
      "v_sales_monthly",
    ]) {
      await expectNoRows(
        staff.from(view).select("*").limit(2),
        `staff ${view} read`,
      );
    }

    const excluded = await admin.rpc("app_set_sales_excluded", {
      p_order_id: orderId,
      p_excluded: true,
    });
    assert.ifError(excluded.error);
    assert.equal(excluded.data, true);
    const restored = await admin.rpc("app_set_sales_excluded", {
      p_order_id: orderId,
      p_excluded: false,
    });
    assert.ifError(restored.error);
    assert.equal(restored.data, true);

    for (const view of [
      "v_order_detail",
      "v_order_detail_all",
      "v_sales_daily",
      "v_sales_monthly",
    ]) {
      const viewRead = await admin.from(view).select("*").limit(2);
      assert.ifError(viewRead.error);
      assert.ok(Array.isArray(viewRead.data), `${view} did not return rows`);
    }

    const createdReservation = await admin.rpc("app_create_reservation", {
      p_res_date: "2099-12-30",
      p_res_time: "18:00",
      p_guests_count: 2,
      p_price: 100000,
      p_menu_ko: "[TEST] Regression Menu",
      p_menu_vi: "[TEST] Regression Menu VI",
      p_note: "[TEST] cleanup",
      p_branch: "[TEST] Branch",
      p_guide_name: "[TEST] Guide",
    });
    assert.ifError(createdReservation.error);
    reservationId = createdReservation.data;

    const updatedReservation = await admin.rpc("app_update_reservation", {
      p_id: reservationId,
      p_res_date: "2099-12-30",
      p_res_time: "19:30",
      p_guests_count: 3,
      p_price: 150000,
      p_menu_ko: "[TEST] Regression Menu Updated",
      p_menu_vi: "[TEST] Regression Menu VI Updated",
      p_note: "[TEST] updated then cleanup",
      p_branch: "[TEST] Branch Updated",
      p_guide_name: "[TEST] Guide Updated",
    });
    assert.ifError(updatedReservation.error);
    assert.equal(Number(updatedReservation.data), Number(reservationId));

    const reservationRow = await admin.from("resv_groups")
      .select("res_time,guests_count,price,menu_ko,branch,guide_name")
      .eq("id", reservationId)
      .single();
    assert.ifError(reservationRow.error);
    assert.match(String(reservationRow.data.res_time), /^19:30/);
    assert.equal(Number(reservationRow.data.guests_count), 3);
    assert.equal(Number(reservationRow.data.price), 150000);
    assert.equal(reservationRow.data.menu_ko, "[TEST] Regression Menu Updated");
    assert.equal(reservationRow.data.branch, "[TEST] Branch Updated");
    assert.equal(reservationRow.data.guide_name, "[TEST] Guide Updated");

    await expectDenied(
      admin.rpc("app_update_and_confirm_reservation", {
        p_id: reservationId,
        p_res_date: "2099-12-31",
        p_res_time: "20:15",
        p_guests_count: 4,
        p_price: 175000,
        p_menu_ko: "[TEST] Atomic Menu",
        p_menu_vi: "[TEST] Atomic Menu VI",
        p_note: "[TEST] atomic rollback",
        p_branch: "[TEST] Atomic Branch",
        p_guide_name: "[TEST] Atomic Guide",
        p_payment_method: "wire",
        p_team_no: "[TEST] 002",
      }),
      "atomic reservation update when confirmation validation fails",
    );

    const rolledBackReservation = await admin.from("resv_groups")
      .select("res_date,res_time,guests_count,price,menu_ko,branch,guide_name,confirmed,confirmed_order_id")
      .eq("id", reservationId)
      .single();
    assert.ifError(rolledBackReservation.error);
    assert.equal(rolledBackReservation.data.res_date, "2099-12-30");
    assert.match(String(rolledBackReservation.data.res_time), /^19:30/);
    assert.equal(Number(rolledBackReservation.data.guests_count), 3);
    assert.equal(Number(rolledBackReservation.data.price), 150000);
    assert.equal(rolledBackReservation.data.menu_ko, "[TEST] Regression Menu Updated");
    assert.equal(rolledBackReservation.data.branch, "[TEST] Branch Updated");
    assert.equal(rolledBackReservation.data.guide_name, "[TEST] Guide Updated");
    assert.equal(rolledBackReservation.data.confirmed, false);
    assert.equal(rolledBackReservation.data.confirmed_order_id, null);

    const atomicConfirmed = await admin.rpc("app_update_and_confirm_reservation", {
      p_id: reservationId,
      p_res_date: "2099-12-31",
      p_res_time: "20:15",
      p_guests_count: 4,
      p_price: 175000,
      p_menu_ko: "[TEST] Atomic Menu",
      p_menu_vi: "[TEST] Atomic Menu VI",
      p_note: "[TEST] atomic confirmation",
      p_branch: "[TEST] Atomic Branch",
      p_guide_name: "[TEST] Atomic Guide",
      p_payment_method: "bank",
      p_team_no: "[TEST] 002",
    });
    assert.ifError(atomicConfirmed.error);
    reservationOrderId = atomicConfirmed.data;
    assert.match(reservationOrderId, /^[0-9a-f-]{36}$/i);

    const atomicallyConfirmedReservation = await admin.from("resv_groups")
      .select("res_date,res_time,guests_count,price,menu_ko,menu_vi,branch,guide_name,confirmed,confirmed_at,confirmed_order_id")
      .eq("id", reservationId)
      .single();
    assert.ifError(atomicallyConfirmedReservation.error);
    assert.equal(atomicallyConfirmedReservation.data.res_date, "2099-12-31");
    assert.match(String(atomicallyConfirmedReservation.data.res_time), /^20:15/);
    assert.equal(Number(atomicallyConfirmedReservation.data.guests_count), 4);
    assert.equal(Number(atomicallyConfirmedReservation.data.price), 175000);
    assert.equal(atomicallyConfirmedReservation.data.menu_ko, "[TEST] Atomic Menu");
    assert.equal(atomicallyConfirmedReservation.data.menu_vi, "[TEST] Atomic Menu VI");
    assert.equal(atomicallyConfirmedReservation.data.branch, "[TEST] Atomic Branch");
    assert.equal(atomicallyConfirmedReservation.data.guide_name, "[TEST] Atomic Guide");
    assert.equal(atomicallyConfirmedReservation.data.confirmed, true);
    assert.ok(atomicallyConfirmedReservation.data.confirmed_at);
    assert.equal(atomicallyConfirmedReservation.data.confirmed_order_id, reservationOrderId);

    const atomicallyCreatedOrder = await admin.from("orders")
      .select("created_at,source,status,total_usd,total_vnd,guide_name,team_no,payment_method")
      .eq("id", reservationOrderId)
      .single();
    assert.ifError(atomicallyCreatedOrder.error);
    assert.equal(new Date(atomicallyCreatedOrder.data.created_at).toISOString(), "2099-12-31T13:15:00.000Z");
    assert.equal(atomicallyCreatedOrder.data.source, "reservation_confirm");
    assert.equal(atomicallyCreatedOrder.data.status, "paid");
    assert.equal(Number(atomicallyCreatedOrder.data.total_usd), 0);
    assert.equal(Number(atomicallyCreatedOrder.data.total_vnd), 700000);
    assert.equal(atomicallyCreatedOrder.data.guide_name, "[TEST] Atomic Guide");
    assert.equal(atomicallyCreatedOrder.data.team_no, "[TEST] 002");
    assert.equal(atomicallyCreatedOrder.data.payment_method, "bank");

    const atomicOrderItem = await admin.from("order_custom_items")
      .select("kind,ko_name,vi_name,qty,unit_usd,unit_vnd,line_usd,line_vnd")
      .eq("order_id", reservationOrderId)
      .single();
    assert.ifError(atomicOrderItem.error);
    assert.equal(atomicOrderItem.data.kind, "group_resv");
    assert.equal(atomicOrderItem.data.ko_name, "[TEST] Atomic Menu");
    assert.equal(atomicOrderItem.data.vi_name, "[TEST] Atomic Menu VI");
    assert.equal(Number(atomicOrderItem.data.qty), 4);
    assert.equal(Number(atomicOrderItem.data.unit_usd), 0);
    assert.equal(Number(atomicOrderItem.data.unit_vnd), 175000);
    assert.equal(Number(atomicOrderItem.data.line_usd), 0);
    assert.equal(Number(atomicOrderItem.data.line_vnd), 700000);

    const synchronizedReservation = await admin.rpc("app_update_reservation", {
      p_id: reservationId,
      p_res_date: "2100-01-01",
      p_res_time: "21:45",
      p_guests_count: 5,
      p_price: 200000,
      p_menu_ko: "[TEST] Synchronized Menu",
      p_menu_vi: "[TEST] Synchronized Menu VI",
      p_note: "[TEST] synchronized then cleanup",
      p_branch: "[TEST] Synchronized Branch",
      p_guide_name: "[TEST] Synchronized Guide",
    });
    assert.ifError(synchronizedReservation.error);
    assert.equal(Number(synchronizedReservation.data), Number(reservationId));

    const synchronizedReservationRow = await admin.from("resv_groups")
      .select("res_date,res_time,guests_count,price,menu_ko,menu_vi,branch,guide_name,confirmed,confirmed_order_id")
      .eq("id", reservationId)
      .single();
    assert.ifError(synchronizedReservationRow.error);
    assert.equal(synchronizedReservationRow.data.res_date, "2100-01-01");
    assert.match(String(synchronizedReservationRow.data.res_time), /^21:45/);
    assert.equal(Number(synchronizedReservationRow.data.guests_count), 5);
    assert.equal(Number(synchronizedReservationRow.data.price), 200000);
    assert.equal(synchronizedReservationRow.data.menu_ko, "[TEST] Synchronized Menu");
    assert.equal(synchronizedReservationRow.data.menu_vi, "[TEST] Synchronized Menu VI");
    assert.equal(synchronizedReservationRow.data.branch, "[TEST] Synchronized Branch");
    assert.equal(synchronizedReservationRow.data.guide_name, "[TEST] Synchronized Guide");
    assert.equal(synchronizedReservationRow.data.confirmed, true);
    assert.equal(synchronizedReservationRow.data.confirmed_order_id, reservationOrderId);

    const synchronizedOrder = await admin.from("orders")
      .select("created_at,source,total_usd,total_vnd,guide_name,team_no,payment_method")
      .eq("id", reservationOrderId)
      .single();
    assert.ifError(synchronizedOrder.error);
    assert.equal(new Date(synchronizedOrder.data.created_at).toISOString(), "2100-01-01T14:45:00.000Z");
    assert.equal(synchronizedOrder.data.source, "reservation_confirm");
    assert.equal(Number(synchronizedOrder.data.total_usd), 0);
    assert.equal(Number(synchronizedOrder.data.total_vnd), 1000000);
    assert.equal(synchronizedOrder.data.guide_name, "[TEST] Synchronized Guide");
    assert.equal(synchronizedOrder.data.team_no, "[TEST] 002");
    assert.equal(synchronizedOrder.data.payment_method, "bank");

    const synchronizedOrderItem = await admin.from("order_custom_items")
      .select("kind,ko_name,vi_name,qty,unit_usd,unit_vnd,line_usd,line_vnd")
      .eq("order_id", reservationOrderId)
      .single();
    assert.ifError(synchronizedOrderItem.error);
    assert.equal(synchronizedOrderItem.data.kind, "group_resv");
    assert.equal(synchronizedOrderItem.data.ko_name, "[TEST] Synchronized Menu");
    assert.equal(synchronizedOrderItem.data.vi_name, "[TEST] Synchronized Menu VI");
    assert.equal(Number(synchronizedOrderItem.data.qty), 5);
    assert.equal(Number(synchronizedOrderItem.data.unit_usd), 0);
    assert.equal(Number(synchronizedOrderItem.data.unit_vnd), 200000);
    assert.equal(Number(synchronizedOrderItem.data.line_usd), 0);
    assert.equal(Number(synchronizedOrderItem.data.line_vnd), 1000000);

    await expectDenied(
      admin.rpc("app_update_order", {
        p_order_id: reservationOrderId,
        p_status: "paid",
        p_guide_name: "[TEST] Must Not Replace",
        p_team_no: "[TEST] 003",
        p_payment_method: "cash",
        p_items: [{
          item_type: "custom",
          kind: "group_resv",
          ko_name: "[TEST] Must Not Replace",
          vi_name: "[TEST] Must Not Replace VI",
          qty: 1,
          unit_usd: 0,
          unit_vnd: 1,
        }],
      }),
      "ordinary update of a reservation-confirmed order",
    );

    const unconfirmed = await admin.rpc("app_unconfirm_reservation", { p_id: reservationId });
    assert.ifError(unconfirmed.error);
    assert.equal(unconfirmed.data, true);

    const removedReservationOrder = await admin.from("orders")
      .select("id")
      .eq("id", reservationOrderId);
    assert.ifError(removedReservationOrder.error);
    assert.deepEqual(removedReservationOrder.data, []);

    const notice = await admin.from("notices").insert({
      title: "[TEST] Security regression",
      body: "<script>must render as text</script>",
      author: "[TEST]",
    }).select("id").single();
    assert.ifError(notice.error);
    noticeId = notice.data.id;
  } finally {
    if (noticeId) await admin.from("notices").delete().eq("id", noticeId);
    if (reservationId) {
      await admin.rpc("app_unconfirm_reservation", { p_id: reservationId });
      await admin.rpc("app_delete_reservation", { p_id: reservationId });
    }
    if (orderId) await admin.rpc("app_delete_order", { p_order_id: orderId });
    await staff.auth.signOut({ scope: "local" });
    await admin.auth.signOut({ scope: "local" });
  }

  console.log("Live staging authorization and atomic workflow checks passed.");
}

await staticChecks();
await liveChecks();
