# Frontend/Supabase contract

This document is the compatibility boundary between the static pages and the
staging database. Do not point `assets/supabase-config.js` at production until
every item below passes staging regression tests.

## Authentication and roles

- All staff workflows use Supabase Auth email/password sessions. The existing
  password-only UI is preserved by mapping each prompt to a fixed technical
  account in `assets/supabase-config.js`: `staff@dgv.local` for the staff
  access code and `admin@dgv.local` for the administrator password. The
  technical emails are not requested from or shown to operators.
- Authorization reads only `auth.users.raw_app_meta_data.role`, exposed to the
  client as `user.app_metadata.role` and to RLS/RPC code as
  `auth.jwt() -> 'app_metadata' ->> 'role'`.
- Supported roles are exactly `staff` and `admin`.
- `staff`: calculator/reservation/report read access and local order/reservation
  draft entry. Committing any order or reservation mutation still requires an
  admin session through the existing administrator-password modal.
- `admin`: every staff capability plus all database writes, order
  administration, hidden sales, notice writes/deletes, `sales_excluded`, and
  destructive operations.
- Browser route guards are user experience only. RLS and each `app_*` RPC must
  repeat the authorization checks on the database side.
- Passwords are sent only to `signInWithPassword`; they are never written to
  `sessionStorage`, `localStorage`, application tables, or RPC arguments.
- To preserve the existing minimum-four-character UI while satisfying Auth
  password length rules, the browser deterministically derives the technical
  Auth password as `dgv-v2/{role}/{entered value}` immediately before sign-in.
  The entered value itself is not persisted. `admin-credential-settings` must
  apply the identical transformation when updating either Auth technical
  account; the legacy `page_access_code` keeps the operator-entered value.
- Entering the administrator password for a privileged action while signed in
  as staff replaces the staff session with the admin session. Admin sessions
  satisfy staff route guards.

## Atomic RPCs

All mutations use these RPCs. No page may directly insert/update/delete order,
order item, custom item, or reservation rows.

### Orders

- `app_create_order(p_created_at, p_source, p_status, p_guide_name,
  p_team_no, p_payment_method, p_items) -> uuid`
- `app_update_order(p_order_id, p_status, p_guide_name, p_team_no,
  p_payment_method, p_items) -> boolean`
- `app_delete_order(p_order_id) -> boolean`
- `app_set_sales_excluded(p_order_id, p_excluded) -> boolean`

`p_items` is a JSON array. Each object has:

```json
{
  "item_type": "menu | custom",
  "menu_item_id": "uuid | null",
  "kind": "string | null",
  "ko_name": "string",
  "vi_name": "string",
  "qty": 1,
  "unit_usd": 0,
  "unit_vnd": 0
}
```

The database computes line and order totals. Creation/update of the order and
all child items is one transaction.

### Reservations

- `app_create_reservation(<existing reservation columns as explicit args>) -> bigint`
- `app_update_reservation(p_id, <existing reservation columns as explicit args>) -> bigint`
- `app_delete_reservation(p_id) -> boolean`
- `app_confirm_reservation(p_id, p_payment_method, p_team_no) -> uuid`
- `app_unconfirm_reservation(p_id) -> boolean`

The explicit reservation column arguments are `p_res_date`, `p_res_time`,
`p_branch`, `p_guests_count`, `p_price`, `p_menu_ko`, `p_menu_vi`,
`p_guide_name`, and `p_note`. `app_confirm_reservation` atomically creates its
order/custom item rows and marks the reservation confirmed.

### Notices

- Anonymous users receive `SELECT` access to published notice rows only.
- Authenticated `admin` users may insert, update, and delete notice rows.
- Notice writes use the Supabase table client under RLS; they do not use an
  elevated browser key or a password-bearing RPC.

### Access-code administration

- `code_admin.html` calls the authenticated `admin-credential-settings` Edge
  Function. The function accepts an admin JWT only and supports these bodies:
  `{ "action": "get_staff_code" }`,
  `{ "action": "set_staff_code", "new_password": "..." }`, and
  `{ "action": "set_admin_password", "new_password": "..." }`.
- `get_staff_code` returns
  `{ "ok": true, "staff_code": "...", "updated_at": "ISO timestamp" }`.
  The code is displayed in the existing status area but is never copied to
  browser storage.
- Both setter actions return `{ "ok": true }` only after the legacy database
  value and the corresponding Auth technical-account password are updated.
  The function updates the legacy value first and Auth second. This ordering is
  required because the previous Auth password, particularly for the admin
  account, cannot be read back for compensation.
- Auth and Postgres are separate services, so this is not a cross-service
  transaction. If the Auth update fails, the function attempts to restore the
  previous legacy value and returns a failure. A process crash between the two
  writes, or a failed compensation write, can still leave the values out of
  sync; the function must log a recovery-required condition, and operators
  must reconcile or retry the credential update before promotion.

## Promotion rule

The production URL/key must never be embedded in an HTML page. Promotion is a
single reviewed replacement of `assets/supabase-config.js`, performed only
after Auth accounts, `app_metadata.role`, grants, RLS, views, and all RPCs have
passed staging tests.
