(function initGolfBookings(global) {
  "use strict";

  const GROUP_COLUMNS = "id,label,version,completed_at,completion_date";
  const PAYMENT_COLUMNS = "id,booking_group_id,payment_kind,amount_vnd,payment_date,payment_method,completes_booking,sort_order";
  const clean = (value) => String(value ?? "").trim();
  const compareText = (a, b) => String(a ?? "") < String(b ?? "") ? -1 : String(a ?? "") > String(b ?? "") ? 1 : 0;
  const groupIdOf = (row) => clean(row.booking_group_id);

  function dataError(message) {
    return new Error(`묶음 예약 데이터를 확인할 수 없습니다. 새로고침 후 다시 시도해 주세요. / Không thể xác minh dữ liệu đặt chung. Vui lòng tải lại trang rồi thử lại. (${message})`);
  }

  function finiteAmount(value, field) {
    const number = Number(value);
    if (value == null || clean(value) === "" || !Number.isSafeInteger(number)) throw dataError(`Invalid ${field}`);
    return number;
  }

  function sumAmounts(a, b, field) {
    const total = a + b;
    if (!Number.isSafeInteger(total)) throw dataError(`Unsafe ${field} total`);
    return total;
  }

  function savedRoundTotal(rounds, field) {
    if (rounds.some((round) => round[field] == null || round[field] === "")) return null;
    return rounds.reduce((total, round) => sumAmounts(total, finiteAmount(round[field], field), field), 0);
  }

  function compareRounds(a, b) {
    return compareText(a.golf_date, b.golf_date) || compareText(a.golf_time, b.golf_time) || compareText(a.id, b.id);
  }

  function comparePayments(a, b) {
    return compareText(a.payment_date, b.payment_date) || Number(a.sort_order || 0) - Number(b.sort_order || 0) || compareText(a.id, b.id);
  }

  // Returns a new row graph. Neither source rows nor either payment ledger is changed.
  function attach(rows, groups = [], payments = []) {
    if (!Array.isArray(rows) || !Array.isArray(groups) || !Array.isArray(payments)) throw dataError("Invalid input");
    const result = rows.map((row) => ({ ...row, booking: null }));
    const rowsById = new Map();
    const roundsByGroup = new Map();
    for (const row of result) {
      const rowId = clean(row.id);
      if (!rowId || rowsById.has(rowId)) throw dataError("Duplicate or missing reservation ID");
      rowsById.set(rowId, row);
      const groupId = groupIdOf(row);
      if (!groupId) continue;
      if (!roundsByGroup.has(groupId)) roundsByGroup.set(groupId, []);
      roundsByGroup.get(groupId).push(row);
    }
    const groupsById = new Map();
    for (const group of groups) {
      const id = clean(group.id);
      if (!id || groupsById.has(id)) throw dataError("Duplicate or missing booking group ID");
      groupsById.set(id, group);
    }
    for (const id of roundsByGroup.keys()) {
      if (!groupsById.has(id)) throw dataError("Booking group is missing or inaccessible");
    }
    const paymentsByGroup = new Map();
    const paymentIds = new Set();
    for (const sourcePayment of payments) {
      const id = clean(sourcePayment.id);
      const groupId = groupIdOf(sourcePayment);
      if (!id || paymentIds.has(id)) throw dataError("Duplicate or missing group payment ID");
      if (!groupsById.has(groupId) || !roundsByGroup.has(groupId)) throw dataError("Orphan group payment");
      if (!["deposit", "receipt"].includes(sourcePayment.payment_kind)) throw dataError("Invalid group payment kind");
      const amount = finiteAmount(sourcePayment.amount_vnd, "payment amount");
      if (amount < 0) throw dataError("Negative group payment amount");
      paymentIds.add(id);
      if (!paymentsByGroup.has(groupId)) paymentsByGroup.set(groupId, []);
      paymentsByGroup.get(groupId).push({ ...sourcePayment });
    }
    for (const [id, rounds] of roundsByGroup) {
      const sourceGroup = groupsById.get(id);
      const sortedRounds = rounds.slice().sort(compareRounds);
      const groupPayments = (paymentsByGroup.get(id) || []).slice().sort(comparePayments);
      const version = Number(sourceGroup.version);
      if (!Number.isSafeInteger(version) || version <= 0) throw dataError("Invalid booking group version");
      const completedAt = clean(sourceGroup.completed_at) || null;
      const completionDate = clean(sourceGroup.completion_date) || null;
      if (Boolean(completedAt) !== Boolean(completionDate)) throw dataError("Inconsistent parent completion metadata");
      const completingPayments = groupPayments.filter((payment) => payment.completes_booking === true);
      if (completingPayments.length !== (completedAt ? 1 : 0)) throw dataError("Inconsistent completion payment count");
      if (completedAt && clean(completingPayments[0].payment_date) !== completionDate) throw dataError("Inconsistent completion payment date");
      const expectedStatus = completedAt ? "completed" : "in_progress";
      if (sortedRounds.some((round) => round.status !== undefined && round.status !== expectedStatus)) {
        throw dataError("Inconsistent parent and round status");
      }
      const guestTotal = savedRoundTotal(sortedRounds, "guest_total_vnd");
      const costTotal = savedRoundTotal(sortedRounds, "course_total_vnd");
      const sumPayments = (kind) => groupPayments.filter((payment) => payment.payment_kind === kind)
        .reduce((sum, payment) => sumAmounts(sum, finiteAmount(payment.amount_vnd, "payment amount"), "payment amount"), 0);
      const deposit = sumPayments("deposit");
      const receipt = sumPayments("receipt");
      const received = sumAmounts(deposit, receipt, "received amount");
      const booking = {
        id, label: clean(sourceGroup.label) || "묶음예약", version,
        completed_at: completedAt, completion_date: completionDate,
        rounds: sortedRounds, payments: groupPayments,
        guest_total_vnd: guestTotal, cost_total_vnd: costTotal,
        deposit_vnd: deposit, receipt_vnd: receipt, received_vnd: received,
        balance_vnd: guestTotal == null ? null : guestTotal - received,
        profit_vnd: completedAt && costTotal != null ? received - costTotal : null,
        range_from: sortedRounds[0].golf_date, range_to: sortedRounds[sortedRounds.length - 1].golf_date
      };
      for (const row of sortedRounds) row.booking = booking;
    }
    return result;
  }

  async function loadAndAttach(rows) {
    if (!Array.isArray(rows)) throw dataError("Invalid reservation rows");
    const ids = [...new Set(rows.map(groupIdOf).filter(Boolean))].sort(compareText);
    const groups = [];
    const payments = [];
    if (ids.length) {
      const DGV = global.DGV;
      if (!DGV?.supabase || typeof DGV.collectSupabasePages !== "function") throw dataError("Supabase dependencies are missing");
      // Bound filter length while preserving stable pagination within each batch.
      for (let index = 0; index < ids.length; index += 100) {
        const batch = ids.slice(index, index + 100);
        const [groupRows, paymentRows] = await Promise.all([
          DGV.collectSupabasePages(
            () => DGV.supabase.from("golf_booking_groups").select(GROUP_COLUMNS).in("id", batch),
            { pageSize: 500, order: [{ column: "id", ascending: true }] }
          ),
          DGV.collectSupabasePages(
            () => DGV.supabase.from("golf_booking_group_payments").select(PAYMENT_COLUMNS).in("booking_group_id", batch),
            { pageSize: 500, order: [
              { column: "booking_group_id", ascending: true },
              { column: "payment_date", ascending: true },
              { column: "sort_order", ascending: true },
              { column: "id", ascending: true }
            ] }
          )
        ]);
        groups.push(...groupRows);
        payments.push(...paymentRows);
      }
    }
    const attached = attach(rows, groups, payments);
    const originals = new Map(rows.map((row) => [clean(row.id), row]));
    const remappedGroups = new Set();
    for (const row of attached) {
      if (!row.booking || remappedGroups.has(row.booking.id)) continue;
      row.booking.rounds = row.booking.rounds.map((round) => originals.get(clean(round.id)));
      remappedGroups.add(row.booking.id);
    }
    for (const row of attached) originals.get(clean(row.id)).booking = row.booking;
    return rows;
  }

  global.GolfBookings = Object.freeze({ attach, loadAndAttach });
})(window);
