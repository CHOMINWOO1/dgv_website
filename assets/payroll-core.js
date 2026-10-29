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
    short: "5분 미만 기록 확인 필요 / Khoảng chấm công dưới 5 phút",
    long: "16시간 초과 근무 확인 필요 / Ca làm vượt 16 giờ",
    missing: "예정 근무일 기록 없음 / Thiếu chấm công ngày làm việc",
    rest: "휴무·휴가일 근무 확인 필요 / Kiểm tra làm việc ngày nghỉ",
    correction: "수정 시각과 사유 확인 필요 / Kiểm tra giờ sửa và lý do",
    monthly: "월중 급여조건 변경 확인 필요 / Kiểm tra thay đổi lương trong tháng",
    overlap: "수정 근무시간이 다른 날짜와 겹칩니다 / Ca đã sửa chồng lấn ngày khác",
    paidLeave: "유급휴일 급여 별도 검토 필요 / Cần duyệt tiền lương ngày nghỉ có lương",
    employment: "재직기간 밖의 근무기록 확인 필요 / Chấm công ngoài thời gian làm việc",
    employmentProration: "입·퇴사월 급여 일할 검토 필요 / Kiểm tra lương tháng vào hoặc nghỉ việc",
  };

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

  function validTerm(term) {
    return Boolean(term && ["monthly", "hourly", "daily"].includes(term.pay_type) &&
      term.rate !== null && term.rate !== "" && Number.isFinite(Number(term.rate)) && Number(term.rate) >= 0 &&
      Number.isFinite(clockMinutes(term.shift_start)) && Number.isFinite(clockMinutes(term.shift_end)) &&
      clockMinutes(term.shift_start) !== clockMinutes(term.shift_end) &&
      Number.isFinite(clockMinutes(term.break_start)) && Number.isFinite(clockMinutes(term.break_end)));
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
    return employees.map((employee) => {
      const id = employee.id;
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
      for (const record of records.filter((r) => r.employee_id === id)) {
        const ms = timestampMs(record.occurred_at);
        if (!Number.isFinite(ms)) { invalidRecord = true; continue; }
        const key = JSON.stringify([ms, record.device_id]);
        if (seen.has(key)) continue;
        seen.add(key);
        let date = dateText(ms);
        const corrected = corrections.find((d) => !overlappingCorrections.has(d) && ms >= timestampMs(d.check_in) && ms <= timestampMs(d.check_out));
        if (corrected) date = corrected.work_date;
        else {
          const previous = dateText(dayMs(date) - DAY);
          const priorTerm = activeTerm(employeeTerms, previous);
          if (validTerm(priorTerm) && clockMinutes(priorTerm.shift_end) < clockMinutes(priorTerm.shift_start) && ms <= shiftBounds(priorTerm, previous).end) date = previous;
        }
        if (date < start || date >= end) continue;
        if (!grouped.has(date)) grouped.set(date, []);
        grouped.get(date).push(ms);
      }
      if (invalidRecord) summaryIssues.push("저장된 출퇴근 시각 확인 필요 / Kiểm tra thời gian đã lưu");
      for (const day of employeeDays) if (day.work_date >= start && day.work_date < end && Number.isFinite(dayMs(day.work_date)) && !grouped.has(day.work_date)) grouped.set(day.work_date, []);
      const daily = [];
      let hourlyAmount = 0;
      let dailyAmount = 0;
      for (const [date, punches] of [...grouped].sort(([a], [b]) => a.localeCompare(b))) {
        punches.sort((a, b) => a - b);
        const day = dayMap.get(date);
        const term = activeTerm(employeeTerms, date);
        const dayType = day ? day.day_type : "work";
        const issues = [];
        const hasOverride = Boolean(day && (day.check_in || day.check_out));
        const manual = Boolean(hasOverride && corrections.includes(day));
        let a = manual ? timestampMs(day.check_in) : punches[0];
        let b = manual ? timestampMs(day.check_out) : punches[punches.length - 1];
        if (hasOverride && !manual) issues.push(message.correction);
        if (overlappingCorrections.has(day)) issues.push(message.overlap);
        if (manual && day.check_in.slice(0, 10) !== date) issues.push(message.correction);
        if (!manual && punches.length === 1) issues.push(message.single);
        if (!manual && punches.length > 2) issues.push(message.many);
        if (!manual && punches.length >= 2 && b - a < 5 * MINUTE) issues.push(message.short);
        if (!manual && punches.length >= 2 && b - a > 16 * 60 * MINUTE) issues.push(message.long);
        const approvedRestWork = day && day.overtime_approved === true && String(day.approval_reason || "").trim();
        const monthlyNet = term && term.pay_type === "monthly" && term.monthly_settlement === "monthly_net";
        // Monthly net settlement counts real work on every day. It does not use
        // individual statutory overtime approvals to accept a complete punch pair.
        if (!manual && punches.length && dayType !== "work" && !approvedRestWork && !monthlyNet) issues.push(message.rest);
        if (!manual && !punches.length && dayType === "work" && day && date < today && employedOn(date)) issues.push(message.missing);
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
        if (!issues.length && hasWork && validTerm(term)) {
          const shift = shiftBounds(term, date);
          actualSeconds = Math.max(0, (b - a - overlap(a, b, shift.breakStart, shift.breakEnd)) / 1000);
          minutes = monthlyNet ? Math.floor(actualSeconds / 60) : Math.round(actualSeconds / 60);
          lateMinutes = Math.round(Math.max(0, Math.min(a, shift.end) - shift.start) / MINUTE);
          earlyMinutes = Math.round(Math.max(0, shift.end - Math.max(b, shift.start)) / MINUTE);
          extraMinutes = Math.round((Math.max(0, Math.min(b, shift.start) - a) + Math.max(0, b - Math.max(a, shift.end))) / MINUTE);
          if (term.pay_type === "hourly") hourlyAmount += minutes * Number(term.rate) / 60;
          if (term.pay_type === "daily" && minutes > 0) dailyAmount += Number(term.rate);
        }
        daily.push({ date, checkIn: Number.isFinite(a) ? timestampText(a) : null,
          checkOut: Number.isFinite(b) && (manual || punches.length > 1) ? timestampText(b) : null,
          minutes, actualSeconds, lateMinutes, earlyMinutes, extraMinutes,
          status: issues.length ? "review" : manual ? "confirmed" : dayType === "work" ? "ok" : dayType,
          issues, issueCodes: issues.map((issue) => Object.keys(message).find((key) => message[key] === issue) || "unknown"),
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
      if (!hasMonthly && daily.some((d) => d.status === "review")) baseAmount = null;
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
        active: employee.active !== false,
        minutes: sum("minutes"), workedDays: daily.filter((d) => d.minutes > 0).length,
        lateMinutes, earlyMinutes, extraMinutes, balanceMinutes: extraMinutes - lateMinutes - earlyMinutes,
        baseAmount, unresolved: attendanceUnresolved + compensationUnresolved,
        attendanceUnresolved, compensationUnresolved, compensationIssues,
        summaryIssueCodes: summaryIssues.map((issue) => Object.keys(message).find((key) => message[key] === issue) || "unknown"), employmentProrationReasons,
        issues: [...summaryIssues, ...daily.flatMap((d) => d.issues.map((issue) => d.date + ": " + issue))],
        daily, payTypes, termsSummary: relevantTerms.map((t) => t.effective_from + " · " + t.pay_type + " · " + Number(t.rate).toLocaleString("en-US") + " VND").join(" / ") };
    });
  }

  root.DGV_PAYROLL_CORE = Object.freeze({ parseRows, summarizeMonth, parseTimestamp, minutesLabel });
})(typeof globalThis !== "undefined" ? globalThis : window);
