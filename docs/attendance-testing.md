# Web attendance trial

Open `attendance.html` in Chrome on the Galaxy Tab A SM-T515 or on a laptop
with a webcam. The public page only offers device setup until an administrator
registers that browser. Existing administrator payroll access is unchanged.

## First use

1. Open **기기 설정 / Thiết lập** and enter the existing administrator password.
2. Give this device a name and register it.
3. Choose an existing payroll employee. Explain encrypted server storage and sharing
   between administrator-registered attendance devices, and
   obtain their agreement before checking the enrollment consent box.
4. Press **정면 보고 등록**. Look straight at the camera; three samples are
   collected automatically. There is no head-turn, blink or challenge sequence.
5. Close settings. Choose the employee and press **얼굴인식만 테스트**. This
   compares the face locally and does not insert any attendance event.
6. Press **출근** or **퇴근** only when an actual attendance record is intended.
   The completion message shows the server's Vietnam local time.

Keep the page visible and permit camera access. Each tablet, laptop or browser
needs one administrator device registration, then downloads the same employee
roster and shared face templates. A face registered on one device can be used on
the others without taking another photograph. Original camera images are never
stored or uploaded; only validated numeric templates are encrypted in Supabase
Vault and cached in encrypted browser storage for local comparison. Model files
are downloaded on the first use, about 9.3 MB including the runtime and WASM
variants. Actual downloads depend on the selected backend and browser cache.

The payroll page checks source changes every 30 seconds while visible and on
returning to the page. It preserves open forms, salary drafts and report previews
and asks the administrator to refresh those deliberately. Finalized payroll
snapshots remain immutable. Existing salary/hour rules continue to apply.

## Connection failures and missed punches

Camera startup and model preparation have bounded waits. If camera permission or
model loading stalls, use **취소 / Hủy**; the employee selector is released without
recording attendance. Late camera responses are closed rather than reopening the
camera after cancellation. Timeout messages distinguish camera setup from model
loading. An operation in progress is shown beside the employee selector.

New punches require an online connection. An uncertain response is kept in
encrypted local storage. **저장 여부 확인** reads that request's server receipt;
it never inserts a delayed event. If absent, the user must make a fresh face
check and punch. Browser-data deletion can remove this local recovery reference.

The database rejects repeated same-direction punches and opposite directions
within 30 seconds. If a checkout was missed, the next check-in is rejected. Record
the checkout, then check in after the cooldown; an administrator must review and
correct the affected day in payroll. A long raw interval is preserved as evidence
and flagged for review rather than silently treated as valid working time.

Device access or a shared employee face can be revoked in administrator settings.
Deleting a shared face applies to every device. Clearing
this browser's device data revokes its server capability and deletes only its
local credentials/templates, never the shared server face or historical attendance.
Register the browser again to download the server's current templates. Browser
storage is AES-GCM encrypted with a non-extractable local CryptoKey, which protects
stored bytes, not against malicious scripts running on the same origin or a
compromised/unlocked device.

## Moving existing face registrations

After this update, open the attendance page in each browser that previously
registered employee faces. Its encrypted local templates are uploaded only when
the device token and original enrollment ID match an active server enrollment.
An existing shared template is never automatically replaced, and a deleted shared
face cannot be resurrected by an old browser. The first valid upload for each
employee becomes the shared template; subsequent devices use that server version.

Do not clear the old browser's site data before transfer completes. If its local
template has already been lost and no other device holds a copy, the employee must
be registered once again. Server enrollment metadata alone cannot reconstruct a
face template. The UI distinguishes unregistered faces, registrations that need
transfer from an older device, and connection/storage errors. It does not hide
employees just because their face is absent from this browser.

## Validation boundaries

`test:attendance:face` checks face-matching and quality logic on synthetic
descriptors. `test:attendance:models` initializes the actual local models in
desktop Chrome and checks backend fallback and synthetic-frame rejection.
`test:attendance:browser` covers the real UI and encrypted IndexedDB with mocked
camera/face and API boundaries. SQL tests cover actual authorization, timestamps,
idempotency and payroll integration; use only the documented rollback-safe smoke
on production, never the isolated fixture/restore tests.

These tests do not establish matching accuracy or performance on the physical
SM-T515. Use the no-write test button there before recording actual attendance.
This requested simple face comparison does not include anti-spoofing/liveness.

See [model provenance](../assets/vendor/attendance-face/README.md) and
[database contracts](payroll-setup.md#online-tablet-attendance).
