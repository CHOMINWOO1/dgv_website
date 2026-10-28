# HANA administrator payroll

The payroll workspace is reached from `home_admin.html`.
The manager home does not contain the payroll entry. The page uses the existing
administrator password and Supabase Auth session. No new password is stored by
the payroll feature. A hidden navigation link is not its security boundary:
every payroll table and mutation also requires the verified `admin` application
role in the database. Staff, manager and anonymous sessions cannot read payroll.

## Deployment

Apply these migrations in order to a local or staging database with the existing
`auth.uid()` and `public.has_app_role(text[])` helpers, Supabase Vault and Storage:

1. `supabase/migrations/20261028055329_hana_payroll_admin.sql`
2. `supabase/migrations/20261028062408_hana_payroll_complete.sql`
3. `supabase/migrations/20261028064044_hana_payroll_backup_restore.sql`
4. `supabase/migrations/20261028070047_hana_payroll_consistent_reads.sql`

Run `supabase/tests/payroll.sql`, `payroll-complete.sql`, `payroll-backup.sql` and `payroll-consistency.sql`
as whole files using a database owner connection. They roll back all fixtures.
The restore test requires initially empty payroll tables; do not clear existing
data merely to run it. `tests/payroll-db.mjs` also runs the contracts in an
isolated PGlite database with stubbed Auth, Storage and Vault interfaces.
This isolated test does not establish real Vault encryption or file uploads;
those must be checked on Supabase before production promotion.

Before production promotion, run the same migration and rollback test against
staging Supabase, inspect security advisors, and verify signed-in administrator,
manager, staff and signed-out browser sessions. Production migration application
and website publication are separate actions from preparing this change.

The migrations only change payroll objects and add the private
`payroll-evidence` Storage bucket. Existing restaurant orders, expenses,
reservations, role helpers and Auth accounts are preserved. There is no payment
fund-source selection, bank integration or automatic expense posting. An
approved payroll calculation does not mean that money was paid.

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
Corrections use append-only `payroll_run_adjustments`: `payroll_adjust_run`
requires the run ID, signed amount, reason and retry UUID. The original run is
never updated. A correction cannot reduce the adjusted total below the amount
actually paid. `payroll_run_balances` is a security-invoker view returning
`run_id`, `employee_id`, `month`, `original_total`, `adjustment_total`, `total`,
`paid` and `balance` under the caller's administrator RLS permissions.

`payroll_pay(p_run_id, p_amount, p_paid_on, p_method, p_reference, p_note,
p_request_id)` returns the payment UUID. The method is `cash` or `bank` and the
request ID is a fresh client UUID retained during retries. An identical retry
returns the original payment. Reusing the UUID with different values fails.
Each payment locks its run before checking the remaining balance, so two
concurrent payments cannot both spend the same remaining amount. The database
also applies this check to direct table inserts. Payments are append-only.

Record only money actually paid. Split cash/bank payments can be entered as
separate rows. The reference and note fields can record a receipt or bank
transaction identifier. `payroll_reverse_payment(payment_id, reason, request_id)`
adds one immutable reversal per payment instead of deleting it. The corrected
payable balance excludes reversed payments. Adjustment, reversal and payment
operations all lock the same run before checking balances, and identical retry
UUIDs return the original record rather than creating duplicates.

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

## Staff details, rules and review history

Employee details now include `phone`, `employment_type` (`full_time` or
`part_time`), `hire_date`, `termination_date`, `employment_status` (`active`,
`leave`, `terminated`) and preferred `payment_method` (`cash`, `bank`, `mixed`).
The legacy `active` flag stays synchronized with employment status.

`payroll_rule_versions` is append-only and has a generated version, unique
effective date, enable flag, explicit overtime multipliers, night premiums and
hours, monthly proration/basis, optional contractual monthly hours, weekly rest
days, overtime warning limits, next-month payment day and change reason.
Overtime starts disabled. No fixed 26-day/208-hour divisor is assumed. New rules
affect later calculations; finalized snapshots retain their original version.

`payroll_days` retains separately approved `overtime_intervals` and
`night_intervals` (arrays of `{start,end}` Vietnamese wall times), approval flags
and an approval reason. The database rejects malformed, overlapping or excessively
long intervals. The calculation layer also verifies the approved intervals are
inside actual working time and handles day boundaries and breaks.

`payroll_review(employee_id, month, snapshot, reason, expected_revision)` saves
an immutable review for one employee/month/source version, independently of
finalization. An identical snapshot/reason retry reuses its saved review. A changed
snapshot or reason creates another immutable review at the same source version.
Reviewing an unresolved month is allowed; finalizing it is not.

The fourth migration, `20261028070047_hana_payroll_consistent_reads.sql`, extends
the read revision to finalized salaries, payments, adjustments, reversals and
evidence metadata. A report brackets its reads with this revision and retries if
it changed. All source and money writes take the revision lock before row/run
locks, including direct REST writes and retry RPC paths. Reviews intentionally
do not increment it so saving a review and finalizing its calculation can use
the same captured revision. Failed writes and identical retries do not increment
it. `payroll-consistency.sql` covers these behaviors; real multi-session lock
contention is outside the isolated PGlite test runtime.

## Encrypted bank and identity fields

`payroll_set_sensitive(employee_id, data, reason)` accepts only `bank_name`,
`bank_account`, `account_holder`, `national_id` and `tax_id`, each a string of up
to 300 characters. Each save creates a new authenticated-encrypted Vault secret.
Private version rows preserve references and metadata; audit logs never contain
those plaintext field values. Do not put private account numbers in a reason or
other ordinary note. `payroll_get_sensitive(employee_id)` returns the latest
version only after an administrator check.

Public RPC wrappers use SECURITY INVOKER. The two private Vault helpers use
SECURITY DEFINER solely to access the non-exposed Vault objects, set an empty
search path, and repeat the `auth.uid()` plus admin-role checks. Browser roles
have no grants to Vault or the private version table. Shared technical accounts
remain the existing site's audit identity limitation.

## Private evidence and signatures

Upload evidence to `payroll-evidence` at
`<payment UUID>/<new file UUID>.<pdf|png|jpg|jpeg|webp>`, with upsert disabled.
Only administrators can upload or read. Maximum size is 5 MiB and MIME types are
PDF, PNG, JPEG and WebP. No public URL, manager policy, overwrite policy or delete
policy is provided.

After upload, insert `payroll_attachments` metadata with the payment ID, path,
original filename, MIME type, byte size and evidence type (`receipt`,
`bank_transfer`, `signature`, `tax_invoice`). The insert verifies actual Storage
metadata, so a nonexistent object or mismatched size/type cannot be presented
as a receipt. Signature evidence must be a PNG with `signed_name` and
`acknowledged_at`. A stored signature documents receipt acknowledgement; it does
not replace every document an accountant may require. Tax-invoice files are
attachments, not an electronic invoice issuing or tax-filing service.

## Encrypted backup and safe restoration

`payroll_backup()` returns one consistent database snapshot:

```text
{format:"DGV_PAYROLL_BACKUP", version:2, exported_at, revision,
 tables:{payroll_employees:[...], ...13 payroll tables...},
 sensitive:[{id,version,employee_id,reason,created_by,created_at,data}]}
```

The snapshot includes all sensitive historical versions decrypted for the
administrator. It is limited to 10 MiB. The client must immediately encrypt the
whole envelope with a user password before writing a file; never save plaintext
or put it in localStorage. Optional receipt bytes belong alongside `database`
inside the encrypted client envelope, not inside the database RPC payload.

`payroll_restore(payload)` accepts only this versioned format and a fixed payroll
table allowlist. It refuses any nonempty payroll database and never truncates,
overwrites or touches unrelated business tables. It acquires exclusive payroll
table locks with NOWAIT, restores original IDs/actors/timestamps/audit records,
validates balances and approval invariants, re-encrypts each sensitive version
into a new Vault secret, and records a restore receipt. Trigger suspension is
transactional and lock-protected; errors restore the original trigger state and
roll back every row. A busy database should be retried after other work finishes.

The result contains `restored`, `replayed`, `receipt_id`, `counts` and
`missing_evidence`. Receipt metadata is restored even when binary files have not
yet been uploaded. After database restoration, upload saved evidence bytes to
their original paths. Retrying the exact same payload uses the private restore
fingerprint to report missing files without reinserting or overwriting rows.
If evidence was not backed up or an upload fails, show an incomplete-file status
until the missing files are supplied; do not report complete recovery.

Additional tests verify disabled/enabled trigger state after failed/successful
restore, immutable history, regenerated secret references, restored sequence
continuity, missing-file reporting and identical restore retry behavior.
