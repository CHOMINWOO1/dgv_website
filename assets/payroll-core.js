(function (root) {
  "use strict";

  // All dates below represent restaurant wall time (Asia/Ho_Chi_Minh).
  // UTC arithmetic deliberately avoids the browser's timezone and DST rules.
  const MINUTE = 60000;
  const DAY = 86400000;
  const pad = (n) => String(n).padStart(2, "0");
  const dateText = (ms) => new Date(ms).toISOString().slice(0, 10);
  const timestampText = (ms) => new Date(ms).toISOString().slice(0, 19);
  const message = {
    terms: "급여·근무조건 확인 필요 / Kiểm tra điều kiện lương",
    single: "출근 또는 퇴근 기록 누락 / Thiếu giờ vào hoặc ra",
    many: "여러 출입기록 확인 필요 / Cần kiểm tra nhiều lần chấm công",
    short: "5분 미만 완료 근무도 반영됨 / Đã tính ca hoàn tất dưới 5 phút",
    long: "16시간 초과 완료 근무 반영 / Đã tính ca hoàn tất trên 16 giờ",
    missing: "출퇴근 기록 없음 (0분) / Không có chấm công (0 phút)",
    rest: "휴무·휴가일 실제 근무 반영 / Đã tính giờ thực làm ngày nghỉ",
    correction: "수정 시각과 사유 확인 필요 / Kiểm tra giờ sửa và lý do",
    monthly: "월중 급여조건 변경 확인 필요 / Kiểm tra thay đổi lương trong tháng",
    overlap: "수정 근무시간이 다른 날짜와 겹칩니다 / Ca đã sửa chồng lấn ngày khác",
    paidLeave: "유급휴일 급여 별도 검토 필요 / Cần duyệt tiền lương ngày nghỉ có lương",
    employment: "재직기간 밖의 근무기록 확인 필요 / Chấm công ngoài thời gian làm việc",
    employmentProration: "입·퇴사월 급여 일할 검토 필요 / Kiểm tra lương tháng vào hoặc nghỉ việc",
    sequence: "출퇴근 순서·중복 기록 확인 필요 / Kiểm tra thứ tự hoặc chấm công lặp",
    mixed: "웹·엑셀 출퇴근 기록이 겹칩니다. 원본을 확인하세요 / Chấm công web và Excel chồng lấn; kiểm tra bản gốc",
    open: "근무 중 · 퇴근 전 시간은 미집계 / Đang làm · chưa cộng ca chưa ra",
    duration: "24시간 초과 출퇴근 구간 확인 필요 / Kiểm tra khoảng chấm công trên 24 giờ",
    future: "미래 출퇴근 시각 확인 필요 / Kiểm tra thời gian chấm công trong tương lai",
    defaultSchedule: "근무시간은 기본 10–20시·휴게 12–14시 적용 / Giờ làm dùng mặc định 10–20h, nghỉ 12–14h",
  };
  const DEFAULT_ATTENDANCE = Object.freeze({ shift_start: "10:00", shift_end: "20:00", break_start: "12:00", break_end: "14:00" });

  function parseTimestamp(value, options) {
    const date1904 = Boolean(options && options.date1904);
    if (typeof value === "number") {
      if (!Number.isFinite(value) || value < (date1904 ? 0 : 1) || value >= 2958466) return null;
      const whole = Math.floor(value);
      // Excel's fictitious 1900-02-29 cannot be represented as a real date.
      if (!date1904 && whole === 60) return null;
      const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, whole < 60 ? 31 : 30);
      const ms = epoch + Math.round(value * DAY / 1000) * 1000;
      if (!Number.isFinite(ms) || new Date(ms).getUTCFullYear() > 9999) return null;
      return timestampText(ms);
    }
    if (typeof value !== "string") return null;
    const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,6})?)?$/);
    if (!match) return null;
    const parts = match.slice(1).map((v) => Number(v || 0));
    const [year, month, day, hour, minute, second] = parts;
    if (year < 100 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
    const ms = Date.UTC(year, month - 1, day, hour, minute, second);
    const d = new Date(ms);
    if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
    return timestampText(ms);
  }

  function dayMs(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
    const parsed = parseTimestamp(value + "T00:00:00");
    return parsed ? Date.parse(parsed + "Z") : NaN;
  }

  function timestampMs(value) {
    const parsed = parseTimestamp(value);
    return parsed ? Date.parse(parsed + "Z") : NaN;
  }

  function idText(value) {
    if (typeof value !== "string" && typeof value !== "number") return "";
    if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) return "";
    const text = String(value).trim();
    return text && text.length <= 100 && !/^[=+@-]/.test(text) ? text : "";
  }

  function parseRows(rows, options) {
    const result = { records: [], duplicates: 0, errors: [], employees: [], firstDate: null, lastDate: null };
    const fail = (row, text) => result.errors.push({ row, message: text });
    if (!Array.isArray(rows) || rows.length === 0) {
      fail(1, "빈 엑셀 파일입니다 / Tệp Excel trống");
      return result;
    }
    if (rows.length > 10001) {
      fail(1, "한 번에 10,000개 기록까지 가져올 수 있습니다 / Tối đa 10.000 bản ghi mỗi lần");
      return result;
    }
    const normalize = (value) => String(value == null ? "" : value).trim().toLowerCase().replace(/\s+/g, " ");
    const required = ["user id", "name", "dept", "in/out time", "device id"];
    const headerIndex = rows.findIndex((row, index) => index < 20 && Array.isArray(row) && required.every((key) => row.map(normalize).includes(key)));
    if (headerIndex < 0) {
      fail(1, "필수 열: User ID, Name, Dept, IN/OUT Time, Device ID / Thiếu cột bắt buộc");
      return result;
    }
    const headers = rows[headerIndex].map(normalize);
    if (required.some((key) => headers.filter((v) => v === key).length !== 1)) {
      fail(headerIndex + 1, "동일한 필수 열이 반복되었습니다 / Cột bắt buộc bị trùng");
      return result;
    }
    const columns = Object.fromEntries(required.map((key) => [key, headers.indexOf(key)]));
    const seen = new Set();
    const employees = new Map();
    for (let index = headerIndex + 1; index < rows.length; index += 1) {
      const row = rows[index];
      if (!Array.isArray(row) || row.every((value) => value == null || value === "")) continue;
      if (row.some((value) => value && typeof value === "object" && ("f" in value || "formula" in value))) {
        fail(index + 1, "수식이 포함된 기록은 허용하지 않습니다 / Không nhận ô công thức");
        continue;
      }
      const device_user_id = idText(row[columns["user id"]]);
      const device_id = idText(row[columns["device id"]]);
      const name = typeof row[columns.name] === "string" ? row[columns.name].trim() : "";
      const occurred_at = parseTimestamp(row[columns["in/out time"]], options);
      if (!device_user_id || !device_id || !name || name.length > 200 || !occurred_at) {
        fail(index + 1, "직원 ID·이름·기기 ID·날짜를 확인하세요 / Kiểm tra mã nhân viên, tên, thiết bị và thời gian");
        continue;
      }
      if (employees.has(device_user_id) && employees.get(device_user_id).name !== name) {
        fail(index + 1, "동일 직원 ID의 이름이 다릅니다 / Tên khác nhau cho cùng mã nhân viên");
        continue;
      }
      const key = JSON.stringify([device_user_id, occurred_at, device_id]);
      if (seen.has(key)) { result.duplicates += 1; continue; }
      seen.add(key);
      employees.set(device_user_id, { device_user_id, name });
      result.records.push({ device_user_id, name, occurred_at, device_id });
    }
    result.records.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at) || a.device_user_id.localeCompare(b.device_user_id));
    result.employees = [...employees.values()];
    if (result.records.length) {
      result.firstDate = result.records[0].occurred_at.slice(0, 10);
      result.lastDate = result.records[result.records.length - 1].occurred_at.slice(0, 10);
    } else if (!result.errors.length) fail(headerIndex + 2, "출퇴근 기록이 없습니다 / Không có bản ghi chấm công");
    return result;
  }

  function clockMinutes(value) {
    const match = typeof value === "string" && value.match(/^(\d{2}):(\d{2})(?::00)?$/);
    if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return NaN;
    return Number(match[1]) * 60 + Number(match[2]);
  }

  function validSchedule(term) {
    return Boolean(term && Number.isFinite(clockMinutes(term.shift_start)) && Number.isFinite(clockMinutes(term.shift_end)) &&
      clockMinutes(term.shift_start) !== clockMinutes(term.shift_end) &&
      Number.isFinite(clockMinutes(term.break_start)) && Number.isFinite(clockMinutes(term.break_end)));
  }
  function validTerm(term) {
    return Boolean(validSchedule(term) && ["monthly", "hourly", "daily"].includes(term.pay_type) &&
      term.rate !== null && term.rate !== "" && term.rate !== undefined && Number.isFinite(Number(term.rate)) && Number(term.rate) >= 0 &&
      (term.pay_type !== "hourly" || Number(term.rate) > 0));
  }

  function activeTerm(terms, date) {
    let found = null;
    for (const term of terms) if (term.effective_from <= date && Number.isFinite(dayMs(term.effective_from))) found = term;
    return found;
  }

  function shiftBounds(term, date) {
    const base = dayMs(date);
    const startMinute = clockMinutes(term.shift_start);
    const endMinute = clockMinutes(term.shift_end);
    const start = base + startMinute * MINUTE;
    const end = base + (endMinute + (endMinute < startMinute ? 1440 : 0)) * MINUTE;
    let breakStart = base + clockMinutes(term.break_start) * MINUTE;
    let breakEnd = base + clockMinutes(term.break_end) * MINUTE;
    if (breakEnd < breakStart) breakEnd += DAY;
    if (endMinute < startMinute && breakEnd <= start) { breakStart += DAY; breakEnd += DAY; }
    return { start, end, breakStart, breakEnd };
  }

  const overlap = (a, b, c, d) => Math.max(0, Math.min(b, d) - Math.max(a, c));
  const minutesLabel = (minutes) => {
    const value = Math.round(Number(minutes) || 0);
    return (value < 0 ? "−" : "") + Math.floor(Math.abs(value) / 60) + "h " + pad(Math.abs(value) % 60) + "m";
  };

  function summarizeMonth(input) {
    const { month, employees = [], terms = [], records = [], days = [] } = input || {};
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month || "") || !Number.isFinite(dayMs(month + "-01"))) throw new Error("올바른 월을 선택하세요 / Tháng không hợp lệ");
    const start = month + "-01";
    const endMs = Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1);
    const end = dateText(endMs);
    const today = input.today || dateText(Date.now() + 7 * 60 * MINUTE);
    if (!Number.isFinite(dayMs(today))) throw new Error("today must be YYYY-MM-DD");
    return employees.filter(employee=>employee.payee_type!=="service").map((employee) => {
      const id = employee.id;
      const partTime = employee.employment_type === "part_time";
      const hireDate = Number.isFinite(dayMs(employee.hire_date)) ? employee.hire_date : null;
      const terminationDate = Number.isFinite(dayMs(employee.termination_date)) ? employee.termination_date : null;
      const employedOn = (date) => (!hireDate || date >= hireDate) && (!terminationDate || date <= terminationDate);
      const employeeTerms = terms.filter((t) => t.employee_id === id).slice().sort((a, b) => String(a.effective_from).localeCompare(String(b.effective_from)));
      const employeeDays = days.filter((d) => d.employee_id === id);
      const dayMap = new Map(employeeDays.map((d) => [d.work_date, d]));
      const grouped = new Map();
      const seen = new Set();
      const summaryIssues = [];
      const corrections = employeeDays.filter((d) => String(d.reason || "").trim() &&
        Number.isFinite(timestampMs(d.check_in)) && Number.isFinite(timestampMs(d.check_out)) &&
        Number.isFinite(dayMs(d.work_date)) && d.check_in.slice(0, 10) === d.work_date &&
        timestampMs(d.check_out) > timestampMs(d.check_in) && timestampMs(d.check_out) - timestampMs(d.check_in) <= DAY);
      const overlappingCorrections = new Set();
      for (let i = 0; i < corrections.length; i += 1) {
        for (let j = i + 1; j < corrections.length; j += 1) {
          if (overlap(timestampMs(corrections[i].check_in), timestampMs(corrections[i].check_out), timestampMs(corrections[j].check_in), timestampMs(corrections[j].check_out)) > 0) {
            overlappingCorrections.add(corrections[i]);
            overlappingCorrections.add(corrections[j]);
          }
        }
      }
      let invalidRecord = false;
      const normalized = [];
      for (const record of records.filter((r) => r.employee_id === id)) {
        const ms = timestampMs(record.occurred_at);
        const type = record.punch_type == null ? null : record.punch_type;
        if (!Number.isFinite(ms) || (type !== null && type !== "in" && type !== "out")) { invalidRecord = true; continue; }
        // Replayed typed events at the identical instant cannot add another
        // worked interval. Keep the legacy import key unchanged.
        const key = JSON.stringify(type ? [ms, type] : [ms, null, record.device_id]);
        if (seen.has(key)) continue;
        seen.add(key);
        let date = dateText(ms);
        if (type) {
          // A re-entry after midnight can still be part of the explicitly
          // scheduled overnight shift, just as with legacy device punches.
          const previous = dateText(dayMs(date) - DAY), priorTerm = activeTerm(employeeTerms, previous);
          if (validSchedule(priorTerm) && clockMinutes(priorTerm.shift_end) < clockMinutes(priorTerm.shift_start) && ms <= shiftBounds(priorTerm, previous).end) date = previous;
        }
        normalized.push({ ms, type, date, issues: [] });
      }
      normalized.sort((a, b) => a.ms - b.ms || String(a.type).localeCompare(String(b.type)));
      const typed = normalized.filter((record) => record.type), typedTimes = new Set(typed.map((record) => record.ms));
      const pairs = [];
      let pending = null;
      for (const record of typed) {
        if (record.type === "in") {
          if (pending) { pending.issues.push(message.sequence, message.single); record.issues.push(message.sequence); record.ambiguous = true; }
          pending = record;
        } else if (pending) {
          // A declared out belongs to its in even after midnight. Legacy
          // punches still require an explicitly overnight schedule below.
          record.date = pending.date;
          if (!pending.ambiguous && record.ms > pending.ms) pairs.push({ first: pending, last: record });
          else record.issues.push(message.sequence);
          pending = null;
        } else {
          record.issues.push(message.single);
        }
      }
      if (pending) {
        const term = activeTerm(employeeTerms, pending.date);
        pending.open = !pending.ambiguous && (dateText(pending.ms) === today || validSchedule(term) && dateText(shiftBounds(term, pending.date).end) === today);
        pending.issues.push(pending.open ? message.open : message.single);
      }
      const groupFor = (date) => {
        if (!grouped.has(date)) grouped.set(date, { punches: [], intervals: [], typedIssues: [], typedCount: 0, legacyCount: 0 });
        return grouped.get(date);
      };
      for (const record of normalized) {
        const { ms, type } = record;
        // Exact cross-source copies are one event for calculation. Never use
        // a time tolerance to guess that two distinct records are duplicates.
        if (!type && typedTimes.has(ms)) continue;
        let date = record.date;
        const corrected = corrections.find((d) => !overlappingCorrections.has(d) && ms >= timestampMs(d.check_in) && ms <= timestampMs(d.check_out));
        if (corrected) date = corrected.work_date;
        else if (!type) {
          const enclosing = pairs.find((pair) => ms >= pair.first.ms && ms <= pair.last.ms);
          const previous = dateText(dayMs(date) - DAY);
          const priorTerm = activeTerm(employeeTerms, previous);
          if (enclosing) date = enclosing.first.date;
          else if (validSchedule(priorTerm) && clockMinutes(priorTerm.shift_end) < clockMinutes(priorTerm.shift_start) && ms <= shiftBounds(priorTerm, previous).end) date = previous;
        }
        record.date = date;
        if (date < start || date >= end) continue;
        const group = groupFor(date);
        group.punches.push(record);
        group[type ? "typedCount" : "legacyCount"] += 1;
        group.typedIssues.push(...record.issues);
      }
      for (const pair of pairs) {
        if (pair.first.date < start || pair.first.date >= end) continue;
        const group = groupFor(pair.first.date);
        if (pair.first.date !== pair.last.date) group.typedIssues.push(message.sequence);
        else group.intervals.push([pair.first.ms, pair.last.ms]);
      }
      if (invalidRecord) summaryIssues.push("저장된 출퇴근 시각 확인 필요 / Kiểm tra thời gian đã lưu");
      for (const day of employeeDays) if (day.work_date >= start && day.work_date < end && Number.isFinite(dayMs(day.work_date))) groupFor(day.work_date);
      const daily = [];
      let hourlyAmount = 0;
      let dailyAmount = 0;
      for (const [date, group] of [...grouped].sort(([a], [b]) => a.localeCompare(b))) {
        const punches = group.punches.sort((a, b) => a.ms - b.ms);
        const day = dayMap.get(date);
        const term = activeTerm(employeeTerms, date);
        const dayType = day ? day.day_type : "work";
        const issues = [], warnings = [];
        const hasOverride = Boolean(day && (day.check_in || day.check_out));
        const manual = Boolean(hasOverride && corrections.includes(day));
        const typedDay = group.typedCount > 0;
        let a = manual ? timestampMs(day.check_in) : typedDay ? punches.find((record) => record.type === "in")?.ms : punches[0]?.ms;
        let b = manual ? timestampMs(day.check_out) : typedDay ? punches.filter((record) => record.type === "out").at(-1)?.ms : punches[punches.length - 1]?.ms;
        let intervals = manual ? [[a, b]] : typedDay ? group.intervals : punches.length === 2 ? [[a, b]] : [];
        if (hasOverride && !manual) issues.push(message.correction);
        if (overlappingCorrections.has(day)) issues.push(message.overlap);
        if (manual && day.check_in.slice(0, 10) !== date) issues.push(message.correction);
        if (!manual && typedDay) {
          issues.push(...new Set(group.typedIssues));
          if (group.legacyCount) issues.push(message.mixed);
        }
        if (!manual && !typedDay && punches.length === 1) issues.push(message.single);
        if (!manual && !typedDay && punches.length > 2) issues.push(message.many);
        if (intervals.some(([from, to]) => to <= from)) issues.push(message.sequence);
        if (intervals.some(([from, to]) => to - from > DAY)) issues.push(message.duration);
        if (punches.some(record => dateText(record.ms) > today) || manual && dateText(b) > today) issues.push(message.future);
        // A broken or overlapping correction cannot authorize overlapping time.
        // Other issues concern unresolved records/pay, not the proven intervals.
        intervals = (hasOverride && !manual || overlappingCorrections.has(day) ? [] : intervals)
          .filter(([from, to]) => Number.isFinite(from) && Number.isFinite(to) && to > from && to - from <= DAY && dateText(to) <= today);
        if (intervals.some(([from, to]) => to - from < 5 * MINUTE)) warnings.push(message.short);
        if (intervals.some(([from, to]) => to - from > 16 * 60 * MINUTE)) warnings.push(message.long);
        const monthlyNet = term && term.pay_type === "monthly" && term.monthly_settlement === "monthly_net";
        // Monthly net settlement counts real work on every day. It does not use
        // individual statutory overtime approvals to accept a complete punch pair.
        if (intervals.length && dayType !== "work") warnings.push(message.rest);
        if (!manual && !punches.length && dayType === "work" && day && date < today && employedOn(date)) warnings.push(message.missing);
        const hasWork = manual || punches.length > 0;
        if (hasWork && !employedOn(date)) issues.push(message.employment);
        if (hasWork && !validTerm(term)) issues.push(message.terms);
        if (!hasWork && ["paid_leave", "holiday"].includes(dayType) && employedOn(date)) {
          if (!validTerm(term)) issues.push(message.terms);
          else if (term.pay_type !== "monthly") issues.push(message.paidLeave);
        }
        let minutes = 0;
        let actualSeconds = 0;
        let lateMinutes = 0;
        let earlyMinutes = 0;
        let extraMinutes = 0;
        const netIntervals = [];
        let attendanceDefaultUsed = false;
        if (intervals.length) {
          const attendanceTerm = validSchedule(term) ? term : DEFAULT_ATTENDANCE;
          attendanceDefaultUsed = !partTime && !validSchedule(term);
          const shift = shiftBounds(attendanceTerm, date);
          actualSeconds = intervals.reduce((total, [from, to]) => {
            const breaks = [];
            // Include the previous work date for a scheduled overnight break.
            // Merge overlaps so effective-term boundaries never deduct twice.
            for (let cursor = dayMs(dateText(from)) - DAY; !partTime && cursor <= dayMs(dateText(to)); cursor += DAY) {
              const breakDate = dateText(cursor), effective = activeTerm(employeeTerms, breakDate);
              const configured = validSchedule(effective) ? effective : DEFAULT_ATTENDANCE;
              const bounds = shiftBounds(configured, breakDate);
              const left = Math.max(from, bounds.breakStart), right = Math.min(to, bounds.breakEnd);
              if (right > left) { breaks.push([left, right]); if (!validSchedule(effective)) attendanceDefaultUsed = true; }
            }
            breaks.sort((x,y) => x[0]-y[0]);
            const merged = [];
            for (const current of breaks) { const previous = merged.at(-1); if (previous && current[0] <= previous[1]) previous[1] = Math.max(previous[1], current[1]); else merged.push(current.slice()); }
            let cursor = from;
            for (const [left,right] of merged) { if (left > cursor) netIntervals.push([cursor,left]); cursor = Math.max(cursor,right); }
            if (cursor < to) netIntervals.push([cursor,to]);
            return total + Math.max(0, (to-from-merged.reduce((n,[left,right])=>n+right-left,0))/1000);
          }, 0);
          minutes = Math.floor(actualSeconds / 60);
          const completedStart = intervals[0][0], completedEnd = intervals.at(-1)[1];
          lateMinutes = Math.round(Math.max(0, Math.min(completedStart, shift.end) - shift.start) / MINUTE);
          earlyMinutes = Math.round(Math.max(0, shift.end - Math.max(completedEnd, shift.start)) / MINUTE);
          extraMinutes = Math.round(intervals.reduce((total, [from, to]) => total + Math.max(0, Math.min(to, shift.start) - from) + Math.max(0, to - Math.max(from, shift.end)), 0) / MINUTE);
          // Part-time hourly work has no daily attendance quota or fixed-shift
          // comparison. Pay uses the completed intervals, with no lunch deduction.
          if (partTime && (!term || term.pay_type === "hourly")) lateMinutes = earlyMinutes = extraMinutes = 0;
          if (validTerm(term) && term.pay_type === "hourly") hourlyAmount += minutes * Number(term.rate) / 60;
          if (validTerm(term) && term.pay_type === "daily" && actualSeconds > 0) dailyAmount += Number(term.rate);
        }
        if (attendanceDefaultUsed) warnings.push(message.defaultSchedule);
        const openPunch = !manual && punches.find(record => record.open);
        const isOpen = Boolean(openPunch), openCheckIn = openPunch ? timestampText(openPunch.ms) : null;
        const attendanceStatus = issues.some(issue => [message.sequence,message.mixed,message.many,message.correction,message.overlap,message.duration,message.future].includes(issue)) ? "ambiguous"
          : isOpen ? "in_progress" : issues.includes(message.single) ? "missing" : intervals.length ? "recognized" : "no_record";
        daily.push({ date, checkIn: Number.isFinite(a) ? timestampText(a) : null,
          checkOut: Number.isFinite(b) && (manual || typedDay || punches.length > 1) ? timestampText(b) : null,
          workIntervals: intervals.filter(([from, to]) => Number.isFinite(from) && Number.isFinite(to) && to > from).map(([from, to]) => ({ start: timestampText(from), end: timestampText(to) })),
          netWorkIntervals: netIntervals.map(([from,to]) => ({start: timestampText(from), end: timestampText(to)})),
          minutes, actualSeconds, lateMinutes, earlyMinutes, extraMinutes, attendanceStatus, isOpen, openCheckIn, attendanceDefaultUsed,
          status: attendanceStatus === "in_progress" ? "in_progress" : issues.length ? "review" : manual ? "confirmed" : dayType === "work" ? "ok" : dayType,
          issues: [...new Set(issues)], issueCodes: [...new Set(issues)].map((issue) => Object.keys(message).find((key) => message[key] === issue) || "unknown"),
          warnings: [...new Set(warnings)], warningCodes: [...new Set(warnings)].map((issue) => Object.keys(message).find((key) => message[key] === issue) || "unknown"),
          rawCount: punches.length, dayType, payType: term && term.pay_type, rate: term ? Number(term.rate) : null });
      }
      const employmentStart = hireDate && hireDate > start ? hireDate : start;
      const employmentEnd = terminationDate && terminationDate < end ? dateText(dayMs(terminationDate) + DAY) : end;
      const relevantTerms = employeeTerms.filter((t) => t.effective_from < employmentEnd && (t.effective_from >= employmentStart || t === activeTerm(employeeTerms, employmentStart)));
      const payTypes = [...new Set(relevantTerms.map((t) => t.pay_type))];
      const startTerm = activeTerm(employeeTerms, employmentStart);
      const employmentProrationReasons = [];
      if (hireDate && hireDate > start && hireDate < end) employmentProrationReasons.push("hire");
      if (terminationDate && terminationDate >= start && terminationDate < dateText(endMs - DAY)) employmentProrationReasons.push("termination");
      const hasMonthly = payTypes.includes("monthly");
      let baseAmount = Math.round(hourlyAmount + dailyAmount);
      const outsideEmployment = (hireDate && hireDate >= end) || (terminationDate && terminationDate < start);
      if (outsideEmployment && !daily.some((d) => d.checkIn)) baseAmount = 0;
      else if (!relevantTerms.length || relevantTerms.some((t) => !validTerm(t))) {
        summaryIssues.push(message.terms);
        baseAmount = null;
      } else if (hasMonthly) {
        // Monthly salaries are agreed base amounts. Never divide by 26/208,
        // dock lateness, or turn the internal time balance into overtime pay.
        if (!validTerm(startTerm)) {
          summaryIssues.push(message.terms);
          baseAmount = null;
        } else if (startTerm.pay_type !== "monthly" || relevantTerms.some((t) => t.pay_type !== "monthly" || Number(t.rate) !== Number(startTerm.rate))) {
          summaryIssues.push(message.monthly);
          baseAmount = null;
        } else {
          baseAmount = Number(startTerm.rate);
          if (employmentProrationReasons.length) summaryIssues.push(message.employmentProration);
        }
      }
      if (!hasMonthly && daily.some((d) => d.issues.length)) baseAmount = null;
      if (daily.some((d) => d.issues.includes(message.terms)) || invalidRecord) baseAmount = null;
      const sum = (field) => daily.reduce((total, d) => total + d[field], 0);
      const lateMinutes = sum("lateMinutes");
      const earlyMinutes = sum("earlyMinutes");
      const extraMinutes = sum("extraMinutes");
      const compensationIssues = [
        ...summaryIssues.filter((issue) => issue === message.monthly || issue === message.employmentProration),
        ...daily.flatMap((d) => d.issues.filter((issue) => issue === message.paidLeave).map((issue) => d.date + ": " + issue)),
      ];
      const attendanceUnresolved = summaryIssues.filter((issue) => issue !== message.monthly && issue !== message.employmentProration).length + daily.filter((d) => d.issues.some((issue) => issue !== message.paidLeave)).length;
      const compensationUnresolved = compensationIssues.length;
      return { employee_id: id, name: employee.name, device_user_id: employee.device_user_id,
        employmentType: employee.employment_type || "full_time", breakPolicy: partTime ? "none" : "scheduled",
        active: employee.active !== false,
        minutes: sum("minutes"), actualSeconds: sum("actualSeconds"), workedDays: daily.filter((d) => d.actualSeconds > 0).length,
        lateMinutes, earlyMinutes, extraMinutes, balanceMinutes: extraMinutes - lateMinutes - earlyMinutes,
        baseAmount, unresolved: attendanceUnresolved + compensationUnresolved,
        attendanceUnresolved, compensationUnresolved, compensationIssues,
        summaryIssueCodes: summaryIssues.map((issue) => Object.keys(message).find((key) => message[key] === issue) || "unknown"), employmentProrationReasons,
        issues: [...summaryIssues, ...daily.flatMap((d) => d.issues.map((issue) => d.date + ": " + issue))],
        warnings: daily.flatMap((d) => d.warnings.map((warning) => d.date + ": " + warning)),
        daily, payTypes, termsSummary: relevantTerms.map((t) => t.effective_from + " · " + t.pay_type + " · " + Number(t.rate).toLocaleString("en-US") + " VND").join(" / ") };
    });
  }

  root.DGV_PAYROLL_CORE = Object.freeze({ parseRows, summarizeMonth, parseTimestamp, minutesLabel });
})(typeof globalThis !== "undefined" ? globalThis : window);
