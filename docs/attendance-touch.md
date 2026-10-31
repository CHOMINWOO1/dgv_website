# Touch attendance

`attendance-touch.html` is a separate, camera-free attendance page. The existing
`attendance.html` face page remains available. Both write typed check-in/check-out
records to the same payroll attendance history and use server Vietnam time.

## Employee use

1. Select the employee name.
2. Tap check in or check out.
3. Copy the four digits shown on the screen using the large touch keypad.
4. Confirm and wait for the saved result.

The displayed code is a confirmation step, not a personal password or proof of
identity. No face data, camera permission, AI model, or employee PIN is required.
Each new attempt receives a new server-generated code, including possible leading
zeroes. Codes expire after two minutes and cannot be used to create a second event.

## Devices and recovery

The page reuses the existing encrypted attendance device registration in the same
browser. A new or revoked browser must be registered with the administrator
password. Shared employee faces are not changed by touch setup.

Uncertain confirmations are retained under a separate encrypted `touch-pending`
record. Result recovery atomically returns the saved event or cancels the pending
confirmation, so a delayed network request cannot later create an event after the
screen has reported it was not saved. Recovery never manufactures a later clock
time. Employee changes and fresh punches remain blocked until recovery completes.

The server applies the same employee eligibility, direction alternation, duplicate
request, and cooldown rules as the face page. A challenge also becomes stale if
another device or the face page changes that employee's last attendance event.

## Validation

- `npm run test:attendance:touch`: real page and encrypted browser storage with
  isolated synthetic API fixtures, keypad and recovery checks, payroll calculation.
- `npm run test:payroll:db`: isolated database authorization, challenge, duplicate,
  expiry, restore, and payroll regression checks.
- `npm run test:attendance:touch:live`: read-only deployment byte comparison,
  no-camera loading, and unregistered-device access rejection. Set
  `ATTENDANCE_TOUCH_LIVE_URL` to the production HTTPS page first.

Synthetic browser tests do not measure physical tablet touch responsiveness.
