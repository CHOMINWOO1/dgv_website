# HANA administrator payroll

The first release adds a private payroll workspace reached from `home_admin.html`.
The manager home does not contain the payroll entry. The page uses the existing
administrator password and Supabase Auth session. No new password is stored by
the payroll feature. A hidden navigation link is not its security boundary:
every payroll table and mutation also requires the verified `admin` application
role in the database. Staff, manager and anonymous sessions cannot read payroll.

## Deployment

Apply `supabase/migrations/20261028055329_hana_payroll_admin.sql` to a local or
staging database with the existing `auth.uid()` and `public.has_app_role(text[])`
helpers. Run `supabase/tests/payroll.sql` as one transaction using a database
owner connection. It is a rollback-only test and requires no real employee or
auth-user fixtures. The repository's `tests/payroll-db.mjs` also runs this contract
in an isolated PostgreSQL-compatible PGlite instance with stubbed Auth helpers.

Before production promotion, run the same migration and rollback test against
staging Supabase, inspect security advisors, and verify signed-in administrator,
manager, staff and signed-out browser sessions. Production migration application
and website publication are separate actions from preparing this change.

This migration only adds `payroll_*` objects. It does not update restaurant
orders, expenses, reservations, role helpers, Auth accounts or storage buckets.
There is deliberately no automatic expense posting or balance movement.
An approved payroll calculation does not mean that money was paid.

## Import and deduplication

The N308 workbook is parsed in the browser. Only normalized punch records and
the import filename, date, actor and processing counts are saved. The workbook
binary, fingerprints and biometric data are never uploaded or retained.

`payroll_import(p_filename text, p_records jsonb)` accepts an array of:

```json
{
  "device_user_id": "9",
  "name": "Example employee",
  "occurred_at": "2026-10-01 10:00:00",
  "device_id": "1"
}
```

Times are Vietnamese device wall-clock timestamps (`timestamp without time
zone`). Both a space and `T` between the date and time are accepted; seconds are
optional. UTC offsets and `Z` are not accepted because the device export is
local time. The maximum payload is 20,000 records per transaction.

A unique constraint on `(employee_id, occurred_at, device_id)` is the final
deduplication authority. An identical file, a renamed copy, repeated rows within
one file, and a partially overlapping date range all keep existing punch rows
and insert only new events. Concurrent imports serialize against the source
revision lock and also retain this unique-constraint protection. Different
device IDs remain distinct events.

The import validates the whole payload and commits all records atomically.
Unknown device-user IDs create employees without invented pay terms. Existing
employee names are never overwritten by spreadsheet names. Import responses
contain `import_id`, `inserted_count`, `duplicate_count`, and `employee_count`
(the number of newly created employees).

## Source data and review

- `payroll_employees`: device user ID, name and active state. Device IDs are
  immutable so historical punch ownership cannot change accidentally.
- `payroll_terms`: effective-dated monthly, hourly or daily rates plus shift and
  break times. These rows are append-only; a new effective date changes future
  calculations while retaining prior terms. The default schedule is
  10:00–20:00 with a 13:00–15:00 break. Imported staff have no implicit salary.
- `payroll_attendance_raw`: immutable original punches and import provenance.
- `payroll_days`: explicit work, rest, paid leave, unpaid leave or holiday dates.
  An administrator can also save a reviewed in/out pair without changing raw
  events. A reason is required. Manual check-out may cross midnight, up to
  24 hours after check-in. Source changes are audited.
- `payroll_revision`: one global increasing source version. Read it before and
  after fetching the month; if the values differ, reload the data. Finalization
  takes the same row lock as source writes and rejects an old version.

Pay calculations must distinguish internal time balances from actual pay.
The interface may display estimated hours, lateness and additional work, but
does not automatically convert internal offsets into legal wage deductions or
overtime allowances. The administrator must review rates, exceptions, allowances
and deductions according to contracts and the applicable payroll rules.
For a mid-month monthly-rate change or paid leave requiring a separate hourly
pay decision, the administrator may enter a reviewed base amount with a reason.
The snapshot retains the original calculation and the reviewed monetary override.
This only resolves compensation review; missing pay terms or unresolved punch
records still block finalization. The system does not decide statutory overtime,
tax withholding, leave entitlement or legal wage deductions automatically.

## Finalization and payment contracts

`payroll_finalize(p_employee_id, p_month, p_base_amount, p_allowances,
p_deductions, p_snapshot, p_expected_revision)` returns the finalized run UUID.
`p_month` is the first calendar day of the payroll month. `p_snapshot` is an
object containing the reviewed calculation, rule/version details and a numeric
`unresolved: 0`. Missing, null, string or positive unresolved counts are rejected.
Pay terms must exist, the source revision must still match, and there can be
only one finalized run for an employee/month. The total equals base plus
allowances minus deductions and must be nonnegative.

Finalized `payroll_runs` preserve their snapshot and amounts permanently.
Later imports, employee edits and term changes do not recalculate them.
This first release does not amend or delete finalized payroll; a correction
workflow should add a separately audited adjustment before supporting changes
to an already approved period.

`payroll_pay(p_run_id, p_amount, p_paid_on, p_method, p_reference, p_note,
p_request_id)` returns the payment UUID. The method is `cash` or `bank` and the
request ID is a fresh client UUID retained during retries. An identical retry
returns the original payment. Reusing the UUID with different values fails.
Each payment locks its run before checking the remaining balance, so two
concurrent payments cannot both spend the same remaining amount. The database
also applies this check to direct table inserts. Payments are append-only.

Record only money actually paid. Split cash/bank payments can be entered as
separate rows. The reference and note fields can record a receipt or bank
transaction identifier; receipt uploads and electronic signatures are outside
this first release. No sensitive bank-account or national-identity fields are
collected here.

`payroll_audit` records actor, time and before/after values for saved payroll
changes. Clients cannot directly manufacture audit rows or source revisions.
The existing site uses shared technical role accounts; the actor identifies
the administrator account, not a separate individual employee login.

## Verification coverage

Install the pinned development dependencies with `pnpm install --frozen-lockfile`.
Run `pnpm test:payroll`, `pnpm test:payroll:db`, and `pnpm test:payroll:browser`.
The browser test uses installed Chrome by default. Set `PAYROLL_BROWSER_CHANNEL`
for another installed Playwright channel, or `PAYROLL_BROWSER_MODULES` to an
existing Playwright package directory. `PAYROLL_SCREENSHOTS` controls the output
directory for clearly labelled synthetic-data screenshots. Optionally set
`PAYROLL_SAMPLE_FILE` to a local N308 XLSX to exercise the real browser parser and
repeat import; it remains local and is never included in the repository.

The import worker vendors SheetJS CE 0.20.3 from its official distribution:
https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.mini.min.js.
The included Apache 2.0 license is `assets/vendor/xlsx.LICENSE.txt`.
SHA-256: `0cb353f830d7288385492c83d277b058ddeac664ca51cf1393aa1fd3e2b70939`.
The UI accepts one-sheet `.xlsx` files up to 5 MB and 10,000 records, rejects
formulas/invalid rows, and parses in a worker with a 15-second timeout.

The SQL contract tests cover repeated and overlapping imports, in-file
duplicates, distinct devices, transaction rollback for an invalid row, required
admin claims, forged `user_metadata`, anonymous grants, stale snapshots,
unresolved attendance, finite/nonnegative amounts, immutable originals and
approvals, audited edits, partial cash/bank payments, identical retry handling,
and overpayment rejection through both RPC and direct table access.

PGlite verifies SQL execution and role policies in isolation. Actual Supabase
Auth, API grants, concurrent network requests and production infrastructure
still require staging/browser verification before release.
