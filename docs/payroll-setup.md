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
5. `supabase/migrations/20261029021538_hana_payroll_monthly_net.sql`
6. `supabase/migrations/20261029023034_hana_payroll_derived_monthly_rate.sql`
7. `supabase/migrations/20261029025813_hana_payroll_employee_identity.sql`
8. `supabase/migrations/20261029035509_hana_payroll_kiosk_attendance.sql`
9. `supabase/migrations/20261029051511_hana_payroll_advances.sql`

Run `supabase/tests/payroll.sql`, `payroll-complete.sql`, `payroll-backup.sql`,
`payroll-consistency.sql` and `payroll-monthly-net.sql`
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
  10:00–20:00 with a 12:00–14:00 break. Imported staff have no implicit salary.
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

### Automatic attendance recognition and separate wage approval

Valid completed in/out pairs contribute attendance immediately after import or
online kiosk recording. There is no separate daily confirmation click or DB
approval flag required to count an ordinary completed pair. A short positive
pair is still real recorded time: retain its seconds rather than discarding it
because it lasted less than five minutes. Whole-minute displays use completed
time only; they must not run a speculative timer from an unmatched open check-in.

Several valid pairs on one day are summed. A later unmatched check-in does not
erase the work from earlier completed pairs. Show the open check-in separately
as in progress, or a missing/ambiguous record as an exception. The unfinished or
ambiguous part contributes no invented time and may still prevent final wage
approval. Raw untyped POS records whose pairing is ambiguous are not converted
into guessed work periods. Explicit administrator corrections remain available
with a reason and do not edit the raw source.

A completed interval up to 24 hours can be recognized automatically, with the
applicable break windows deducted across every calendar date it crosses. An
overnight break is deducted once, not once per displayed day. A pair spanning
more than 24 hours remains ambiguous and contributes no automatic work time;
other valid completed pairs on the same day still count. The server retains
such long raw events as evidence instead of deleting them or guessing where a
missing earlier check-out should have occurred.

Daily attendance status is separate from monetary review:
`recognized`, `in_progress`, `missing`, `ambiguous`, or `no_record`. Informational
`warnings`/`warningCodes` explain unusual but accepted work, while actual
`issues`/`issueCodes` identify unresolved data or compensation. A past scheduled
workday with no source records is zero recorded work and `no_record`; it is not
an invented full workday or a requirement to acknowledge every empty date.
Future scheduled days do not add actual time. The monthly completion guard can
remain pending while the month or today's work is unfinished without hiding
the completed work already recorded.

Attendance can be displayed before a wage rate is known. Use the employee's
valid effective shift/break settings when available. Otherwise use the shop's
explicit attendance default, 10:00–20:00 with a 12:00–14:00 break, and expose
`attendanceDefaultUsed` with an explanatory warning. This fallback estimates
attendance under the displayed break rule; it does not create a wage agreement
or salary. Missing or invalid pay terms still leave calculated pay unavailable
and prevent monthly wage finalization until terms are supplied.

Automatic recognition updates live calculations only. It does not auto-finalize
a salary, rewrite a finalized snapshot, authorize a payment, change an advance
or remaining-money balance, or modify any saved receipt signature. Existing
administrator-only finalization, source-revision checks and immutable monetary
records remain unchanged. No database migration is required for this display
and calculation separation.

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
Each payment locks the global payroll revision and then its run before checking
the remaining balance, so two concurrent payments cannot both spend the same
remaining amount. The database also applies this check to direct table inserts.
Payments are append-only, including their employee and salary-month binding.

Record only money actually paid. Split cash/bank payments can be entered as
separate rows. The reference and note fields can record a receipt or bank
transaction identifier. `payroll_reverse_payment(payment_id, reason, request_id)`
adds one immutable reversal per payment instead of deleting it. The corrected
payable balance excludes reversed payments. Adjustment, reversal and payment
operations acquire the same global revision lock and then the run, when one
exists. Identical retry UUIDs return the original record rather than creating
duplicates. A payment recorded before approval can be reversed before or after
that approval without deleting its original payment or receipt signatures.

### Advances and ad-hoc part-time payments

Actual payment can be recorded before monthly payroll is finalized. This tracks
money paid and money remaining; it does not assign paid/unpaid work hours or mark
attendance as settled. Scheduled employees may receive an early or partial
payment before the usual next-month fifth, and short-term staff may be paid
as needed without inventing a finalized salary run.

`payroll_pay_advance(p_employee_id, p_payroll_month, p_amount, p_paid_on,
p_method, p_reference, p_note, p_request_id)` returns a payment UUID. The salary
month is its first date (`YYYY-MM-01`), and the amount is finite positive whole
VND within the existing payment amount limit. `paid_on` is the actual payment
date entered by the administrator. `created_at` is the server's record-entry
timestamp; label it as recorded time, not the actual time money changed hands.
There is no estimated-salary cap before approval because an estimate is not a
final wage. Every payment still requires the administrator role.

All payments remain in `payroll_payments`, with immutable `employee_id` and
`payroll_month` columns. An advance has `run_id:null` and keeps it null forever,
even after the salary month is finalized. Existing approved-run payments receive
the two binding fields from their original run during migration. A composite
foreign key prevents a run-linked payment from claiming another employee or
month. Original payment IDs, dates, amounts, audit events and signature files
are unchanged; no second payment ledger is introduced.

The retry UUID is global across normal and advance payments. Repeating identical
advance arguments returns the original ID, including after later finalization.
Conflicting arguments reject with `PAYROLL_PAYMENT_REQUEST_CONFLICT`. Once the
month has been finalized, new advance requests and direct runless inserts fail
with `PAYROLL_MONTH_ALREADY_FINALIZED`; use the existing `payroll_pay` RPC for
the remaining approved amount. Both paths share the source-revision lock, so
approval and an advance cannot race past one another's monthly state checks.

Final balances sum every unreversed payment for the same employee and salary
month exactly once, regardless of `run_id`. For example, a 7,000,000 VND approved
salary with a 2,000,000 VND advance leaves 5,000,000 VND to pay. If advances were
7,500,000 VND, the truthful 7,000,000 VND salary can still be finalized and the
balance is -500,000 VND. Show this as 500,000 VND overpaid, separately from amounts
still payable. Do not inflate the salary, silently zero the balance or move the
excess into another month. Further regular payments fail while the balance is
zero or negative. Existing protection against reducing an adjusted salary below
the amount already paid remains in force.

Before approval, any displayed remaining amount based on calculated salary is
an estimate. After approval, use the approved total plus adjustments minus all
unreversed employee/month payments. Group and export by `payroll_month` for wage
settlement and filter by `paid_on` for actual cash-flow dates. A January advance
paid in January and its February fifth settlement both belong to January wages,
but appear on their respective actual payment dates. Never infer salary month
from `paid_on`. A missing `run_id` must not hide an advance from employee history,
receipt signatures, tax/payment exports, period reports or cancellation actions.

The existing private receipt pipeline uses `payment_id`, so unsigned status,
phone-captured signatures, encrypted evidence backup and cancellation history
work for advances as well as approved-run payments. Finalization does not move
or copy a signature to a new payment. Legacy version-2 backups without the two
binding fields derive only missing keys from the restored run; explicit invalid
bindings are rejected. New backups preserve both unfinalized advances and
advances attached by employee/month to a later, possibly overpaid approval.

The migration obtains the affected payroll table/view locks with NOWAIT before
changing schema or backfilling derived keys. If the ledger is busy, retry later;
failure leaves original data and trigger state intact. The backfill suspends
payment USER triggers only inside the locked migration transaction, without
creating fake new payment/audit events or altering money values.

`payroll-advances.sql` and `payroll-advances-backup.sql` are isolated tests only.
For a nonempty live database, `payroll-advances-live.sql` uses random-ID fixtures
inside rollback, never suspends triggers or edits existing records, and verifies
that every payroll/private table count and the revision remain unchanged.

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

## Monthly net settlement term versions

`20261029021538_hana_payroll_monthly_net.sql` adds three versioned term fields.
`20261029023034_hana_payroll_derived_monthly_rate.sql` removes the separate-rate
requirement so the current calculation derives it automatically:

- `monthly_settlement`: `monthly_net` for new term versions, or `statutory` for
  the previous calculation behavior. Existing stored terms become `statutory`.
- `monthly_extra_hourly_rate`: an optional legacy field retained for old data and
  archives. New conditions omit it or send `null`; current calculations ignore
  it. Existing values retain their whole-VND 0–1,000,000,000 validity check.
- `weekly_rest_day`: one weekday, 0 (Sunday) through 6 (Saturday), default 0.
  Calendar exceptions remain explicit day records; creating a schedule preserves
  dates that an administrator already set.

New term versions default to a 12:00–14:00 break. Existing terms retain their
recorded break times. For a full employment month, monthly net settlement retains
the full agreed base when monthly net time is zero or negative. The hourly rate
is the agreed monthly salary divided by that month's planned working hours;
extra pay is positive net minutes multiplied by that rate divided by 60. Keep the
derived rate precise during calculation and round the resulting VND amount once.
A positive planned-time denominator is required for extra pay; unresolved time
or employment conditions must be reviewed before finalization. No separate extra
rate input is required. The database preserves the term settings; confirmed salary
snapshots retain their original amounts and are never recalculated by migration.
Changes require a new effective-date term; existing terms remain immutable.

The backup format remains version 2. An old archive lacking these three term
fields restores them as `statutory`, `null`, and `0`, respectively, while keeping
its recorded break times. Explicit fields in newer archives are preserved and
validated. An explicitly null/invalid required field is rejected rather than
treated as a legacy default. The restore fingerprint still uses the original
payload, preserving exact retry behavior. `payroll-monthly-net.sql` covers new
defaults, omitted/null legacy rates, invalid historical rate values, weekly rest
bounds, immutable records, manager denial,
both archive generations, failed-restore rollback and guard restoration.

`supabase/tests/payroll-monthly-live.sql` is a separate rollback-only smoke test
that can run with existing payroll data. It checks aggregate counts under the
payroll revision lock, creates only a uniquely named temporary employee and term
versions, tests admin/manager access and new constraints, rolls that fixture back,
then verifies every original table count and the revision are unchanged. It never
exports/restores a backup, clears a table or updates an existing employee. Run the
whole file as a database owner; a busy payroll operation causes a bounded timeout.
The sixth migration only drops the required-rate constraint and updates column
comments. It does not rewrite terms, attendance, audit entries or saved salary
snapshots. A legacy archive without the optional rate also remains restorable.

### First employment month and the following month's pay date

When a `monthly_net` employee joins during the selected month and has a stable
monthly salary, the first month's base is calculated automatically:

```text
first-month base = round(full monthly salary × active planned minutes / full calendar-month planned minutes)
derived hourly rate = full monthly salary × 60 / full calendar-month planned minutes
extra pay = round(full monthly salary × positive monthly net minutes / full calendar-month planned minutes)
```

Active planned minutes cover the employment period, inclusive of the hire date.
Full calendar-month planned minutes cover the whole selected month with its
weekly rest day and saved day overrides. For dates before employment begins,
the calculation uses the term effective on the hire date to build a virtual
schedule; it does not create attendance or database day records. Both totals
exclude rest days and scheduled breaks. Lateness or a shortage of actual hours
does not reduce the prorated base further. Net extra minutes compare actual work
against the active planned minutes, so pre-employment days are not treated as
missing attendance or overtime debt.

For example, a 7,000,000 VND monthly salary with 27 planned eight-hour days and
15 active planned days produces a first-month base of 3,888,889 VND. The derived
hourly rate still uses 7,000,000 VND divided by 216 hours. It does not divide the
already rounded prorated base by 120 active hours. This avoids introducing an
intermediate-rounding error into extra pay. A salary change during the month or
a termination during that month still requires an explicit reviewed calculation.

New snapshots preserve `monthlyProration` with `applied`, `reason: "hire_date"`,
`hireDate`, `fullSalary`, `fullPlannedMinutes`, `activePlannedMinutes`, `ratio`,
`unroundedBase` and `baseAmount`. `monthlyPlannedMinutes` remains the active
employment-period total. `monthlyExtraBasisAmount` and `monthlyExtraBasisMinutes`
preserve the full-salary/full-month basis for automatic first-month extra pay.
A separately reviewed manual base uses the reviewed base and active planned
minutes instead. Existing finalized snapshots are never rewritten.

`monthlyExpectedPayDate` is the fifth day of the following month, including
December-to-January rollover. Monthly-net due alerts use that frozen snapshot
date, with next-month 05 as the fallback for older snapshots; statutory-rule
`pay_day` settings do not change it. A payment is overdue after that date, rather
than on the fifth itself. `payroll_payments.paid_on` remains the actual date of
payment, and recording a scheduled due date does not create a payment. These
fields are stored in the existing snapshot JSON; no schema migration is needed.

## Encrypted bank and identity fields

Manual employee registration uses the atomic administrator RPC:

```text
payroll_save_employee(p_employee_id uuid, p_employee jsonb, p_national_id text,
                      p_expected_revision bigint, p_create boolean) -> uuid
```

Generate the employee UUID once before creating a record and reuse it on retry.
The national ID/CCCD value is required, trimmed, limited to 300 characters and
cannot contain control characters or newlines. Do not coerce it to a number or
reformat it. `p_employee` accepts only `device_user_id`, `name`, `active`, `phone`,
`employment_type`, `hire_date`, `termination_date`, `employment_status` and
`payment_method`; the identity belongs solely in `p_national_id`. Creation uses
normal employee defaults for optional fields. Updates may supply a field patch.
The existing immutable POS user ID and authoritative employment status remain
enforced.

The RPC uses SECURITY INVOKER, verified administrator checks and existing RLS.
It locks the source revision, saves employee changes and calls the existing
narrow Vault helpers in one transaction. It merges `national_id` into the latest
encrypted object, preserving bank and tax keys. Any encryption/version failure
rolls back the employee change, audit and revision as well. Public employee rows,
payroll snapshots and audit records must never contain the identity value.

An exact normalized create/update retry returns the same UUID without writing
another audit/version, even when the response to the previous successful save
was lost and its original revision is stale. A conflicting create UUID, changed
stale update or missing update target is rejected. Importing an unknown POS
employee continues to work without an identity value; an administrator completes
the field through the employee form. Decrypt only the employee records needed for
editing or an administrator-requested tax export, and keep those values in memory.

`payroll-employee-identity.sql` verifies create/update atomicity by injecting a
failure into a fixture's private version insert, plus exact retries, conflicts,
field merging, plaintext exclusion and role denial. Its temporary trigger and
all data are rolled back. `payroll-employee-live.sql` is a separate live-safe
smoke test without trigger changes: it creates UUID-named fixtures, checks the
RPC and unchanged import behavior, rolls the fixtures back, then compares every
original payroll table count, encrypted-version count and revision. Neither test
updates an existing employee or exports existing private identity values.

`payroll_set_sensitive(employee_id, data, reason)` accepts only `bank_name`,
`bank_account`, `account_holder`, `national_id` and `tax_id`, each a string of up
to 300 characters. Each save creates a new authenticated-encrypted Vault secret.
Private version rows preserve references and metadata; audit logs never contain
those plaintext field values. Do not put private account numbers in a reason or
other ordinary note. `payroll_get_sensitive(employee_id)` returns the latest
version only after an administrator check.

The current bank/tax form uses the four-argument overload
`payroll_set_sensitive(employee_id, data, reason, expected_revision)`. Capture the
revision when opening the form; the RPC locks and compares it before replacing
the encrypted object. A stale form cannot overwrite an identity changed through
employee registration. The older three-argument RPC remains for compatibility.

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

### Capturing a receipt signature on the administrator's phone

The existing attachment schema supports phone capture without another database
migration. The administrator remains signed in through the normal protected
payroll page. There is no anonymous signing link or attendance-kiosk capability
for accessing payments or signatures. Before the recipient signs on the phone,
show the employee, salary month, actual payment date, payment method and amount
for the selected `payroll_payments.id`. Several installments in one salary month
are separate receipts and need independent signature statuses.

Require a visible pen stroke, the recipient's name and deliberate receipt
acknowledgement in the capture UI. A blank canvas must not be submitted. The
database checks signer name, finite acknowledgement time, PNG type and actual
Storage size/MIME metadata; it cannot decide whether PNG pixels contain a real
signature. The stored acknowledgement time records signing time, not a change
to the original payment date or amount.

Upload the PNG under that payment UUID with `upsert:false`, then append one
`payroll_attachments` row with `evidence_type:'signature'`. Keep the draft's
attachment UUID, object path and exact bytes stable while retrying an uncertain
save. If upload succeeded but its response was lost, verify the existing object
bytes before proceeding; never overwrite it. If metadata already exists with
the same UUID/path, reuse that saved result rather than inserting a second row.
The unique storage path prevents accidental duplicate metadata. Report success
only once both the object and its per-payment metadata are confirmed.

An unsigned payment remains an actual payment with a visible unsigned status;
the application must not invent a signature or change the paid amount. A
signature is linked through `attachment.payment_id`, not just employee or month.
Show signer name and acknowledgement time with the corresponding receipt.
Additional signatures or corrected supporting evidence append new records;
saved signature rows and objects are not edited, reassigned or deleted.

Cancelling a payment preserves its previous signatures for audit. Receipt and
payroll reports must visibly mark that payment as cancelled and exclude it from
active paid totals, even though its image remains available to administrators.
The phone capture UI should offer new signing only for a current, uncancelled
payment and recheck that status before saving. The general evidence backend
also permits historical evidence on a cancelled payment; that does not restore
the payment or authorize counting it as an active receipt.

Load signature images through authenticated Storage downloads or short-lived
signed URLs, never public bucket URLs. A report must wait for its intended
images to load before printing and identify any missing file instead of silently
printing an unsigned receipt as signed. Optional encrypted evidence backup
includes these PNG bytes alongside attachment metadata; metadata alone does not
restore the image. Unsaved canvas strokes should stay in memory only.

`supabase/tests/payroll-signatures.sql` runs only in the isolated PostgreSQL
harness. It covers unsigned installments, path binding to individual payments,
missing signer/acknowledgement, wrong MIME/size, missing objects, duplicate paths,
immutable metadata and files, cancelled-payment history, stale report revision
invalidation, and denial for manager/staff/anonymous/kiosk callers. Its Storage
metadata fixtures do not verify actual PNG encoding, mobile touch events,
Storage HTTP uploads or printing; those are separate browser checks.

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

## Online tablet attendance

Migration `20261029035509_hana_payroll_kiosk_attendance.sql` adds an online-only
tablet capability without modifying existing staff, POS punches or finalized
payroll values. Apply it after the seven earlier payroll migrations. Face
templates were initially local to each browser. Migration
`20261030020322_hana_payroll_shared_faces.sql` stores
validated numeric templates in Supabase Vault, with one current version per
employee, and makes them available only to active registered devices. Original
images and camera video are never stored or uploaded. The recorded verification
label is `trusted_kiosk_verification`: it means the enrolled device asserted a
successful local comparison. This is not server-verified biometric identity or
a guarantee against a modified browser, stolen device token or presentation
attack. Register a supervised tablet and revoke its capability when it is lost.

Administrators authenticate through the existing password login in an isolated,
nonpersistent Supabase client. Device setup must not retain an administrator
session. Generate a 256-bit random token with Web Crypto, encode it as 64
lowercase hexadecimal characters, and store it only in encrypted tablet-local
storage. The server stores its SHA-256 hash, never the raw token. Never put the
token in a URL, analytics, audit details, screenshots or exported payroll files.

Administrator RPCs:

| RPC | Arguments | Result |
| --- | --- | --- |
| `payroll_kiosk_register` | `p_device_id` stable UUID, `p_name`, `p_token` | `{device_id,name,status}`; an exact retry is safe |
| `payroll_kiosk_devices` | none | Array of device ID/name/status, creation/revocation times and active enrollment count |
| `payroll_kiosk_revoke` | `p_device_id`, `p_reason` | Device UUID; capability is immediately unusable |
| `payroll_kiosk_face_save` | `p_employee_id`, `p_template`, `p_consent_version`, `p_expected_revision`, `p_request_id` | Shared face metadata; exact retries are safe, stale edits fail |
| `payroll_kiosk_face_delete` | `p_employee_id`, `p_expected_revision`, `p_reason`, `p_request_id` | Shared face removed for every device; tombstone prevents old uploads restoring it |

Employee enrollment requires a deliberate administrator confirmation of the
selected employee and consent to shared storage. Face writes use a per-employee
revision (initially 0), plus a stable request UUID, to reject concurrent stale
edits without creating duplicate versions on retry. Replacement/deletion removes
the previous Vault secret. Audit/request records contain metadata and hashes,
never numeric face samples. Existing managers cannot manage devices or faces.
The old per-device enroll/unenroll RPCs remain for compatibility with old pages;
they cannot override a shared face or its deletion tombstone.

Runtime RPCs accept the publishable/anonymous client plus a valid device token;
they do not require or return an administrator session:

| RPC | Arguments | Result |
| --- | --- | --- |
| `payroll_kiosk_roster` | `p_token` | Device identity and active employees with `face_registered`, `face_revision`, `has_legacy_enrollment`, current-device `enrollment_id`, and `last_punch` |
| `payroll_kiosk_face_get` | `p_token`, `p_employee_id` | Current shared template and revision, or null when absent |
| `payroll_kiosk_face_migrate` | `p_token`, `p_employee_id`, `p_enrollment_id`, `p_template`, `p_request_id` | Create-only transfer of a matching legacy enrollment; never replaces shared history |
| `payroll_kiosk_punch` | `p_token`, `p_employee_id`, `p_kind` (`in`/`out`), `p_request_id` UUID, `p_face_revision` | `{event_id,employee_id,punch_type,occurred_at,server_received_at,replayed,verification}` |
| `payroll_kiosk_receipt` | `p_token`, `p_request_id` | The stored event with `replayed:true`, or null if absent/owned by another device |

`last_punch` is null or `{punch_type,occurred_at}`. The roster exposes only
active employees within their hire/termination dates, including those whose face
has not yet been registered. Archived employees and outside-service payees are
excluded. Selection does not depend on a local browser cache. Recording still
requires a matching current shared face revision and successful local comparison.
It contains no contact details, identity numbers, wages or bank information.
Anonymous callers receive no direct table privileges. Kiosk implementation
objects live in the dedicated, non-exposed `payroll_kiosk` schema. The migration
does not grant anonymous access to the existing `private` or Vault schemas.
A private, NOLOGIN
`payroll_kiosk_writer` role owns only the three capability RPC implementations;
its grants are limited to minimum employee columns, private registration reads,
raw event insertion and trigger-controlled audit/revision writes. API roles
cannot assume this role. Vault reads use separate narrow, capability-checked
private functions; the writer role receives no general Vault access. Other
payroll administrator gates remain in place.

Legacy transfer runs only for an active token with the same active device/employee
enrollment UUID as the saved local template. It is permitted only before any
shared-face history exists. Opening the updated page in each original browser
transfers those existing templates; metadata on the server cannot recreate a
template erased from every browser. The original four-argument punch RPC works
only for employees with no shared-face history. Once a shared face or deletion
exists, old pages must refresh; they cannot use stale local faces to bypass a
replacement or deletion. New punches check the face revision under the same lock
as employee status and device revocation.

The server sets `occurred_at` using `clock_timestamp()` in
`Asia/Ho_Chi_Minh` wall time; no punch RPC accepts a client timestamp. UTC receipt
time remains in `server_received_at`. Only an explicit online user action may
send a new punch. A face test must only compare locally and must not call punch.
Do not queue new offline attendance for later submission. If a response is
uncertain, persist the request UUID and resolve it through the receipt RPC.
A null receipt means no event was found; require a fresh face check before any
new action. Never submit a delayed request as if it happened at the earlier time.

An identical request UUID returns the original event and time without another
raw row or revision increment. Reusing it for a different employee, direction
or device fails. A first `out`, consecutive same-direction events and a direction
switch within 30 seconds fail. Device revocation is checked before retries.
All devices share the payroll revision lock so concurrent punches, revocation,
employee status changes and salary finalization cannot interleave unchecked.
Missing terms, off-schedule work, rest/leave-day work and a long open shift do
not discard genuine punch evidence; the payroll calculation flags cases for
administrator review. Employment-inactive, pre-hire and post-termination
employees and withdrawn enrollments cannot create new events.

New raw columns are `source` (`excel` or `kiosk`), nullable `punch_type`,
`kiosk_device_id` and globally unique `kiosk_request_id`. Existing records gain
only the `excel` provenance default; original timestamps and values stay intact.
Only kiosk rows may have a null `import_id`; they do not create fake workbook
import rows. Typed attendance uses explicit in/out pairs, supports several
separate work periods and assigns an overnight pair to the in date. Mixed POS
and typed evidence that cannot be safely deduplicated requires review.
Raw audit `created_by` attributes the device to its registering administrator;
the `source` and device UUID identify that this is a kiosk assertion, not a
fresh administrator verification of the employee's face.

Encrypted payroll archives preserve typed raw attendance. Device credentials,
enrollment grants, shared face templates and their private setup audit are intentionally excluded;
after restoration, register the tablet and enroll employees again. Old version-2
archives missing the new raw fields restore as Excel records. Explicit invalid
or null provenance is rejected rather than silently changed.

Run `tests/payroll-db.mjs` for isolated regression, including
`supabase/tests/payroll-kiosk.sql` and `payroll-kiosk-backup.sql`. Those two files
are for the isolated database only. For a live nonempty database, use only
`supabase/tests/payroll-kiosk-live.sql`: it runs random-ID fixture writes inside
a rollback, never disables triggers or changes existing rows, and asserts all
payroll/private row counts and the source revision return to their original
values. The local harness also verifies that applying this migration preserves
preexisting terms, POS timestamps and finalized salary snapshots.
