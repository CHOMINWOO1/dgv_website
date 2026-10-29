(function (root) {
  "use strict";
  const MIN = 60000, DAY = 86400000;
  const core = root.DGV_PAYROLL_CORE;
  const SOURCES = Object.freeze([
    { title: "Bộ luật Lao động 45/2019/QH14, Điều 98, 105–107", url: "https://datafiles.chinhphu.vn/cpp/files/vbpq/2019/12/45.signed.pdf" },
    { title: "Nghị định 145/2020/NĐ-CP, Điều 55–57, 67", url: "https://vanban.chinhphu.vn/?docid=201967&pageid=27160" },
    { title: "Cơ sở dữ liệu quốc gia: Nghị định 145/2020/NĐ-CP", url: "https://vbpl.moj.gov.vn/TW/Pages/vbpq-toanvan.aspx?ItemID=152668&dvid=13" },
  ]);
  const DEFAULTS = Object.freeze({ ot_enabled: false, regular_overtime_multiplier: 1.5, rest_overtime_multiplier: 2,
    holiday_overtime_multiplier: 3, night_premium_rate: 0.3, night_overtime_extra_rate: 0.2,
    night_start: "22:00", night_end: "06:00", monthly_proration: "none", monthly_hour_basis: "schedule",
    monthly_contract_hours: null, default_weekly_rest_days: [0], monthly_overtime_limit: 40, annual_overtime_limit: 200 });
  const textDate = (ms) => new Date(ms).toISOString().slice(0, 10);
  const textStamp = (ms) => new Date(ms).toISOString().slice(0, 19);
  const stamp = (value) => { const parsed = core.parseTimestamp(value); return parsed ? Date.parse(parsed + "Z") : NaN; };
  const dateMs = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? stamp(value + "T00:00:00") : NaN;
  const clock = (value) => { const m = typeof value === "string" && value.match(/^(\d{2}):(\d{2})(?::00)?$/); return m && +m[1] < 24 && +m[2] < 60 ? +m[1] * 60 + +m[2] : NaN; };
  const round = (value) => Math.round((value + Number.EPSILON) * 1000000) / 1000000;
  const duration = (intervals) => intervals.reduce((total, [a, b]) => total + (b - a) / MIN, 0);
  const hasNumber = (value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
  const withinEmployment = (employee, date) => (!employee.hire_date || date >= employee.hire_date) && (!employee.termination_date || date <= employee.termination_date);

  function monthDates(month) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month || "") || !Number.isFinite(dateMs(month + "-01"))) throw new Error("Invalid payroll month");
    const start = dateMs(month + "-01"), next = Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 1);
    const dates = [];
    for (let ms = start; ms < next; ms += DAY) dates.push(textDate(ms));
    return dates;
  }
  function latest(rows, date) {
    return rows.filter((row) => Number.isFinite(dateMs(row.effective_from)) && row.effective_from <= date)
      .sort((a, b) => a.effective_from.localeCompare(b.effective_from) || Number(a.version || 0) - Number(b.version || 0)).at(-1) || null;
  }
  function intersect(left, right) {
    const result = [];
    for (const [a, b] of left) for (const [c, d] of right) if (Math.min(b, d) > Math.max(a, c)) result.push([Math.max(a, c), Math.min(b, d)]);
    return result.sort((a, b) => a[0] - b[0]);
  }
  function subtract(intervals, excluded) {
    let result = intervals.map((v) => v.slice());
    for (const [c, d] of excluded) {
      const next = [];
      for (const [a, b] of result) {
        if (d <= a || c >= b) next.push([a, b]);
        else { if (a < c) next.push([a, c]); if (d < b) next.push([d, b]); }
      }
      result = next;
    }
    return result;
  }
  function calendarPieces(intervals) {
    const pieces = [];
    for (const [a, b] of intervals) {
      let cursor = a;
      while (cursor < b) {
        const date = textDate(cursor), end = Math.min(b, dateMs(date) + DAY);
        pieces.push({ date, interval: [cursor, end] }); cursor = end;
      }
    }
    return pieces;
  }
  function scheduleBounds(term, date) {
    if (!term || ![term.shift_start, term.shift_end, term.break_start, term.break_end].every((value) => Number.isFinite(clock(value)))) return null;
    const startClock = clock(term.shift_start), endClock = clock(term.shift_end), day = dateMs(date);
    if (startClock === endClock) return null;
    const start = day + startClock * MIN, end = day + (endClock + (endClock < startClock ? 1440 : 0)) * MIN;
    let a = day + clock(term.break_start) * MIN, b = day + clock(term.break_end) * MIN;
    if (b < a) b += DAY;
    if (endClock < startClock && b <= start) { a += DAY; b += DAY; }
    return { start, end, breaks: a === b ? [] : [[a, b]], normal: subtract([[start, end]], a === b ? [] : [[a, b]]) };
  }
  function nightWindows(date, rule) {
    const result = [], day = dateMs(date), start = clock(rule.night_start), end = clock(rule.night_end);
    for (let offset = -1; offset <= 1; offset += 1) result.push([day + offset * DAY + start * MIN, day + offset * DAY + (end + (end <= start ? 1440 : 0)) * MIN]);
    return result;
  }
  function normalizeRule(value) {
    if (!value) return null;
    const rule = { ...DEFAULTS, ...value };
    for (const field of ["regular_overtime_multiplier", "rest_overtime_multiplier", "holiday_overtime_multiplier", "night_premium_rate", "night_overtime_extra_rate", "monthly_overtime_limit", "annual_overtime_limit"]) rule[field] = Number(rule[field]);
    return rule;
  }
  function validateRule(value) {
    const r = normalizeRule(value), errors = [];
    if (!r) return ["적용할 급여 규칙을 등록하세요 / Thêm quy tắc lương có hiệu lực"];
    for (const [field, minimum] of [["regular_overtime_multiplier", 1.5], ["rest_overtime_multiplier", 2], ["holiday_overtime_multiplier", 3], ["night_premium_rate", 0.3], ["night_overtime_extra_rate", 0.2]]) {
      if (!Number.isFinite(r[field]) || r[field] < minimum || r[field] > 100) errors.push(field + ": 법정 최소율 이상을 입력하세요 / Không thấp hơn mức tối thiểu");
    }
    if (!Number.isFinite(clock(r.night_start)) || !Number.isFinite(clock(r.night_end)) || clock(r.night_start) > 1320 || clock(r.night_start) < 720 || clock(r.night_end) < 360 || clock(r.night_end) >= clock(r.night_start)) errors.push("야간 범위는 22:00–06:00을 포함해야 합니다 / Khung đêm phải gồm 22:00–06:00");
    if (!["none", "scheduled"].includes(r.monthly_proration) || !["contract", "schedule"].includes(r.monthly_hour_basis)) errors.push("월급 산정 방식 확인 / Kiểm tra cách tính lương tháng");
    if (r.monthly_hour_basis === "contract" && (!hasNumber(r.monthly_contract_hours) || Number(r.monthly_contract_hours) <= 0 || Number(r.monthly_contract_hours) > 744)) errors.push("계약상 월 기준시간을 입력하세요 / Nhập giờ chuẩn tháng theo hợp đồng");
    if (!(r.monthly_overtime_limit > 0 && r.monthly_overtime_limit <= 40) || !(r.annual_overtime_limit > 0 && r.annual_overtime_limit <= 300)) errors.push("연장근로 한도 설정 확인 / Kiểm tra giới hạn làm thêm");
    return errors;
  }
  function serialize(intervals) { return intervals.map(([a, b]) => ({ start: textStamp(a), end: textStamp(b) })); }
  function workedIntervals(daily) {
    const values = Array.isArray(daily.netWorkIntervals) ? daily.netWorkIntervals : Array.isArray(daily.workIntervals) ? daily.workIntervals : [{ start: daily.checkIn, end: daily.checkOut }];
    return values.map((item) => [stamp(item.start), stamp(item.end)]).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a);
  }
  function approvedIntervals(value, allowed, label) {
    if (!Array.isArray(value) || value.length > 16) return { intervals: [], errors: [label + ": 승인 구간 형식 확인 / Kiểm tra khoảng thời gian"] };
    const intervals = value.map((item) => [stamp(item && item.start), stamp(item && item.end)]).sort((a, b) => a[0] - b[0]);
    const invalid = intervals.some(([a, b], i) => !Number.isFinite(a) || !Number.isFinite(b) || b <= a || b - a > DAY || (i > 0 && a < intervals[i - 1][1]) || Math.abs(duration(intersect([[a, b]], allowed)) - (b - a) / MIN) > 0.000001);
    return invalid ? { intervals: [], errors: [label + ": 근무·후보 범위 밖이거나 중복된 구간입니다 / Khoảng ngoài giờ làm hoặc chồng lấn"] } : { intervals, errors: [] };
  }

  function createMonthSchedule({ month, employee, terms = [], weeklyRestDays = [0], existingDays = [] }) {
    if (!employee || !employee.id) throw new Error("Employee required");
    if (!Array.isArray(weeklyRestDays) || weeklyRestDays.length > 7 || weeklyRestDays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) throw new Error("Weekly rest days must be 0 (Sunday) to 6 (Saturday)");
    const existing = new Map(existingDays.filter((day) => day.employee_id === employee.id).map((day) => [day.work_date, day]));
    return monthDates(month).filter((date) => withinEmployment(employee, date)).map((date) => {
      if (existing.has(date)) return { ...existing.get(date) };
      const rest = weeklyRestDays.includes(new Date(dateMs(date)).getUTCDay());
      return { employee_id: employee.id, work_date: date, day_type: rest ? "rest" : "work", check_in: null, check_out: null,
        reason: "주간 휴무 패턴으로 근무표 작성 / Lập lịch theo ngày nghỉ hằng tuần" };
    });
  }

  const isMonthlyNet = (term) => Boolean(term && term.pay_type === "monthly" && term.monthly_settlement === "monthly_net");
  function effectiveMonthTerms(employee, employeeTerms, dates) {
    const relevant = [...new Set(dates.filter((date) => withinEmployment(employee, date)).map((date) => latest(employeeTerms, date)).filter(Boolean))];
    return relevant.length ? relevant : [latest(employeeTerms, dates[0])].filter(Boolean);
  }
  // Virtual schedules are calculation inputs only. The caller must not insert
  // these generated rows into payroll_days; explicit saved overrides always win.
  function buildEffectiveDays({ month, employees = [], terms = [], days = [] }) {
    const dates = monthDates(month), result = days.filter((day) => day._scheduleDefault !== true).map((day) => ({ ...day }));
    const known = new Set(result.map((day) => JSON.stringify([day.employee_id, day.work_date])));
    for (const employee of employees) {
      const employeeTerms = terms.filter((term) => term.employee_id === employee.id);
      for (const date of dates) {
        if (!withinEmployment(employee, date)) continue;
        const term = latest(employeeTerms, date), key = JSON.stringify([employee.id, date]);
        if (!isMonthlyNet(term) || known.has(key)) continue;
        const restDay = term.weekly_rest_day == null ? 0 : Number(term.weekly_rest_day);
        const rest = Number.isInteger(restDay) && restDay >= 0 && restDay <= 6 && new Date(dateMs(date)).getUTCDay() === restDay;
        result.push({ employee_id: employee.id, work_date: date, day_type: rest ? "rest" : "work", check_in: null, check_out: null,
          reason: "직원 주간 휴무일에서 계산 / Tính từ ngày nghỉ hằng tuần của nhân viên", _scheduleDefault: true });
        known.add(key);
      }
    }
    return result;
  }

  function calculateMonthlyExtra({ baseAmount, plannedMinutes, extraMinutes, salaryBasisAmount, salaryBasisMinutes }) {
    if (!hasNumber(baseAmount) || !Number.isSafeInteger(Number(baseAmount)) || Number(baseAmount) < 0 ||
      !Number.isSafeInteger(plannedMinutes) || plannedMinutes <= 0 || !Number.isSafeInteger(extraMinutes) || extraMinutes < 0) return { hourlyRate: null, amount: null };
    const explicitBasis = salaryBasisAmount !== undefined || salaryBasisMinutes !== undefined;
    const basisAmount = explicitBasis ? salaryBasisAmount : baseAmount, basisMinutes = explicitBasis ? salaryBasisMinutes : plannedMinutes;
    if (!hasNumber(basisAmount) || !Number.isSafeInteger(Number(basisAmount)) || Number(basisAmount) < 0 || !Number.isSafeInteger(basisMinutes) || basisMinutes <= 0) return { hourlyRate: null, amount: null };
    return { hourlyRate: Number(basisAmount) * 60 / basisMinutes, amount: Math.round(Number(basisAmount) * extraMinutes / basisMinutes) };
  }

  function monthlyNetSummary({ month, dates, employee, employeeTerms, days, base, today }) {
    const first = dates[0], last = dates.at(-1), dayMap = new Map(days.filter((day) => day.employee_id === employee.id).map((day) => [day.work_date, day]));
    const employedDates = dates.filter((date) => withinEmployment(employee, date));
    const relevantTerms = effectiveMonthTerms(employee, employeeTerms, dates);
    const ruleIssues = [], warnings = [...(base.warnings || [])], resolvedHireIssues = new Set();
    let compensationIssues = [...(base.compensationIssues || [])];
    const issue = (text) => { if (!ruleIssues.includes(text)) ruleIssues.push(text); };
    const warning = (text) => { if (!warnings.includes(text)) warnings.push(text); };
    const asOf = today || textDate(Date.now() + 7 * 60 * MIN);
    const scheduleDefaultUsed = employedDates.some((date) => dayMap.get(date)?._scheduleDefault === true);
    let monthlyPlannedMinutes = 0, paidLeaveDays = 0, unpaidLeaveDays = 0, holidayDays = 0, restDays = 0, paidScheduledMinutes = 0;
    for (const date of employedDates) {
      const day = dayMap.get(date), term = latest(employeeTerms, date), schedule = scheduleBounds(term, date);
      if (!isMonthlyNet(term)) { issue("월중 급여 정산방식이 다릅니다. 월 전체 조건을 확인하세요 / Hình thức quyết toán thay đổi trong tháng; kiểm tra điều kiện cả tháng"); continue; }
      const restDay = term.weekly_rest_day == null ? 0 : Number(term.weekly_rest_day);
      if (!Number.isInteger(restDay) || restDay < 0 || restDay > 6) issue("주간 휴무 요일을 확인하세요 / Kiểm tra ngày nghỉ hằng tuần");
      if (!day || !["work", "rest", "paid_leave", "unpaid_leave", "holiday"].includes(day.day_type) || !schedule || duration(schedule.normal) <= 0) {
        issue(date + ": 월 기준시간에 필요한 근무조건·근무표 확인 / Kiểm tra điều kiện và lịch để tính giờ chuẩn tháng"); continue;
      }
      if (day.day_type === "rest") restDays += 1;
      if (day.day_type === "paid_leave") paidLeaveDays += 1;
      if (day.day_type === "unpaid_leave") unpaidLeaveDays += 1;
      if (day.day_type === "holiday") holidayDays += 1;
      if (day.day_type !== "rest") {
        const minutes = Math.round(duration(schedule.normal)); monthlyPlannedMinutes += minutes;
        if (day.day_type !== "unpaid_leave") paidScheduledMinutes += minutes;
      }
    }
    const activeTerms = relevantTerms.filter(isMonthlyNet);
    let baseAmount = base.baseAmount, monthlyProration = null;
    const hireInMonth = Number.isFinite(dateMs(employee.hire_date)) && employee.hire_date > first && employee.hire_date <= last;
    const terminationReview = Number.isFinite(dateMs(employee.termination_date)) && employee.termination_date >= first && employee.termination_date < last;
    const salaries = [...new Set(activeTerms.map((term) => Number(term.rate)))];
    const stableSalary = activeTerms.length > 0 && relevantTerms.every(isMonthlyNet) && salaries.length === 1 && Number.isSafeInteger(salaries[0]) && salaries[0] >= 0;
    if (hireInMonth && !terminationReview && stableSalary) {
      const hireTerm = latest(employeeTerms, employee.hire_date);
      let fullPlannedMinutes = 0, completeBasis = true;
      for (const date of dates) {
        // Before employment began, use the contract effective on the hiring date
        // as a hypothetical full-month schedule, never as invented attendance.
        const term = date < employee.hire_date ? hireTerm : latest(employeeTerms, date);
        const schedule = scheduleBounds(term, date), savedDay = dayMap.get(date);
        const restDay = term?.weekly_rest_day == null ? 0 : Number(term.weekly_rest_day);
        const dayType = savedDay?.day_type || (new Date(dateMs(date)).getUTCDay() === restDay ? "rest" : "work");
        if (!term || !schedule || duration(schedule.normal) <= 0 || !Number.isInteger(restDay) || restDay < 0 || restDay > 6 || !["work", "rest", "paid_leave", "unpaid_leave", "holiday"].includes(dayType)) { completeBasis = false; continue; }
        if (dayType !== "rest") fullPlannedMinutes += Math.round(duration(schedule.normal));
      }
      if (!completeBasis || fullPlannedMinutes <= 0) issue("입사월 일할계산의 전체 달력월 기준시간을 확인하세요 / Kiểm tra giờ chuẩn cả tháng để tính lương tháng vào làm");
      else {
        const fullSalary = salaries[0], ratio = monthlyPlannedMinutes / fullPlannedMinutes, unroundedBase = fullSalary * monthlyPlannedMinutes / fullPlannedMinutes;
        baseAmount = Math.round(unroundedBase);
        monthlyProration = { applied: true, reason: "hire_date", hireDate: employee.hire_date, fullSalary, fullPlannedMinutes,
          activePlannedMinutes: monthlyPlannedMinutes, ratio, unroundedBase, baseAmount };
        if ((base.employmentProrationReasons || []).length === 1 && base.employmentProrationReasons[0] === "hire") {
          for (const [index, code] of (base.summaryIssueCodes || []).entries()) if (code === "employmentProration") resolvedHireIssues.add(base.issues[index]);
          compensationIssues = compensationIssues.filter((text) => !resolvedHireIssues.has(text));
        }
      }
    }
    if (employedDates.length && monthlyPlannedMinutes <= 0) issue("월 기준시간이 0입니다. 급여와 추가급여를 확정하기 전에 근무표를 확인하세요 / Giờ chuẩn tháng bằng 0; kiểm tra lịch trước khi chốt lương");
    if (relevantTerms.some((term) => !isMonthlyNet(term))) issue("월중 급여 정산방식이 다릅니다. 월 전체 조건을 확인하세요 / Hình thức quyết toán thay đổi trong tháng; kiểm tra điều kiện cả tháng");
    const scheduleKeys = new Set(activeTerms.map((term) => JSON.stringify([term.shift_start, term.shift_end, term.break_start, term.break_end, term.weekly_rest_day ?? 0])));
    if (scheduleKeys.size > 1) warning("월중 근무시간·휴무 요일 변경을 적용일별로 반영했습니다. 월 기준시간과 날짜별 근무표를 확인하세요 / Đã áp dụng thay đổi giờ và ngày nghỉ theo ngày hiệu lực; kiểm tra lịch và giờ chuẩn tháng");
    if (paidLeaveDays || unpaidLeaveDays || holidayDays) warning("휴가·공휴일의 예정시간은 월 기준시간에 포함합니다. 실제 출퇴근 없는 시간은 실근무에 더하지 않으며 부족시간으로 월급을 공제하지 않습니다 / Giờ lịch ngày nghỉ được tính vào chuẩn; không tạo giờ làm thực tế và không trừ lương tháng khi thiếu giờ");
    const pendingDates = [], reviewedDaily = base.daily.map((daily) => {
      const day = dayMap.get(daily.date), term = latest(employeeTerms, daily.date), schedule = scheduleBounds(term, daily.date);
      const hasCompletedWork = Boolean(daily.workIntervals?.length && !daily.isOpen && !daily.issues.length);
      const pending = withinEmployment(employee, daily.date) && day?.day_type === "work" && (daily.date > asOf || (daily.date === asOf && !hasCompletedWork));
      if (pending) pendingDates.push(daily.date);
      const futurePunch = [daily.checkIn, daily.checkOut].some((value) => value && value.slice(0, 10) > asOf);
      const futureIssue = "미래 출퇴근 시각 확인 필요 / Kiểm tra thời gian chấm công trong tương lai";
      if (futurePunch && !daily.issueCodes.includes("future")) issue(daily.date + ": " + futureIssue);
      if (daily.checkIn && daily.checkOut) {
        const actual = workedIntervals(daily);
        if (actual.every(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a)) {
          for (const part of calendarPieces(actual)) if (!withinEmployment(employee, part.date)) issue(daily.date + ": 재직기간 밖의 근무 시각 확인 / Kiểm tra giờ làm ngoài thời gian hợp đồng");
          if (daily.checkOut.slice(0, 7) !== month && stamp(daily.checkOut) > dateMs(daily.checkOut.slice(0, 10))) warning("월말 야간근무는 근무 시작일의 급여월에 한 번만 포함됩니다 / Ca qua tháng chỉ được tính một lần theo tháng bắt đầu");
        }
      }
      // Core excludes only the future/ambiguous interval; a later bad punch
      // must not erase an earlier independently completed interval.
      return { ...daily, ...(futurePunch ? { status: "review", attendanceStatus: "ambiguous", issues: [...new Set([...daily.issues, futureIssue])], issueCodes: [...new Set([...daily.issueCodes, "future"])] } : {}),
        settlementMode: "monthly_net", scheduledMinutes: day?.day_type === "rest" || !schedule ? 0 : Math.round(duration(schedule.normal)),
        scheduleDefaultUsed: day?._scheduleDefault === true, monthlyPending: pending,
        overtimeCandidates: [], nightCandidates: [], approvedOvertimeMinutes: 0, approvedNightMinutes: 0, statutoryAmount: 0 };
    });
    if (pendingDates.length) issue("월 집계 중: 아직 끝나지 않은 예정 근무일 " + pendingDates.length + "일. 월 전체 기록을 확인한 후 확정하세요 / Đang tổng hợp: còn " + pendingDates.length + " ngày làm theo lịch; chốt sau khi đủ dữ liệu tháng");
    const monthlyActualSeconds = reviewedDaily.reduce((sum, day) => sum + Number(day.actualSeconds || 0), 0);
    const monthlyActualMinutes = Math.floor(monthlyActualSeconds / 60);
    const monthlyRoundingMinutes = monthlyActualMinutes - reviewedDaily.reduce((sum, day) => sum + Number(day.minutes || 0), 0);
    const monthlyBalanceMinutes = monthlyActualMinutes - monthlyPlannedMinutes;
    const monthlyExtraMinutes = Math.max(0, monthlyBalanceMinutes);
    const wageBreakdown = [];
    // Legacy stored extra-price values intentionally do not participate. Derive
    // from the actual fixed/reviewed base and this month's real planned minutes.
    const monthlyExtraBasisAmount = monthlyProration?.fullSalary ?? baseAmount, monthlyExtraBasisMinutes = monthlyProration?.fullPlannedMinutes ?? monthlyPlannedMinutes;
    const extra = calculateMonthlyExtra({ baseAmount, plannedMinutes: monthlyPlannedMinutes, extraMinutes: monthlyExtraMinutes,
      ...(monthlyProration ? { salaryBasisAmount: monthlyExtraBasisAmount, salaryBasisMinutes: monthlyExtraBasisMinutes } : {}) });
    const monthlyExtraHourlyRate = extra.hourlyRate, monthlyExtraAmount = employedDates.length ? extra.amount : 0;
    if (Number.isFinite(baseAmount)) wageBreakdown.push({ code: "monthly_base", label: "약정 월급 (시간 부족 공제 없음) / Lương tháng (không trừ giờ thiếu)",
      category: "base", date: first, dayType: "work", minutes: monthlyPlannedMinutes, rate: 0, multiplier: 1, rawAmount: baseAmount, amount: baseAmount });
    if (Number.isFinite(monthlyExtraAmount)) wageBreakdown.push({ code: "monthly_net_extra", label: "월 순초과시간 추가급여 / Tiền giờ vượt ròng trong tháng",
      category: "monthly_extra", date: last, dayType: "work", minutes: monthlyExtraMinutes, rate: monthlyExtraHourlyRate || 0, multiplier: 1,
      rawAmount: monthlyExtraBasisMinutes > 0 && Number.isFinite(monthlyExtraBasisAmount) ? round(monthlyExtraBasisAmount * monthlyExtraMinutes / monthlyExtraBasisMinutes) : 0, amount: monthlyExtraAmount });
    const attendanceUnresolved = Number(base.attendanceUnresolved || 0) + ruleIssues.length, compensationUnresolved = compensationIssues.length;
    return { ...base, baseAmount, originalBaseAmount: base.baseAmount, settlementMode: "monthly_net", statutoryAmount: 0, wageBreakdown,
      monthlyPlannedMinutes, monthlyActualMinutes, monthlyBalanceMinutes, monthlyExtraMinutes, monthlyExtraAmount, monthlyExtraHourlyRate,
      monthlyProration, monthlyExpectedPayDate: textDate(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 5)),
      monthlyExtraBasisAmount, monthlyExtraBasisMinutes, monthlyExtraRateSource: monthlyProration ? "full_month_salary_divided_by_full_calendar_hours" : "base_salary_divided_by_planned_hours",
      minutes: monthlyActualMinutes, actualSeconds: monthlyActualSeconds, workedDays: reviewedDaily.filter((day) => day.actualSeconds > 0).length,
      monthlyActualSeconds, monthlyRoundingMinutes,
      monthlyCreditedMinutes: 0, monthlyPendingDays: pendingDates.length, monthlyReadyToFinalize: attendanceUnresolved + compensationUnresolved === 0,
      scheduleDefaultUsed, plannedMinutes: monthlyPlannedMinutes, fullMonthPlannedMinutes: monthlyProration?.fullPlannedMinutes ?? monthlyPlannedMinutes, paidScheduledMinutes,
      paidLeaveDays, unpaidLeaveDays, holidayDays, restDays, daily: reviewedDaily, ruleVersionIds: [], warnings,
      regularOvertimeMinutes: 0, restWorkMinutes: 0, holidayWorkMinutes: 0, nightMinutes: 0, nightOvertimeMinutes: 0,
      ruleUnresolved: ruleIssues.length, ruleIssues, attendanceUnresolved, compensationUnresolved, compensationIssues,
      unresolved: attendanceUnresolved + compensationUnresolved, issues: [...base.issues.filter((text) => !resolvedHireIssues.has(text)), ...ruleIssues], calculationVersion: 3,
      yearToDateOvertimeMinutes: null, annualCoverageComplete: false, sources: [] };
  }

  function hourlyActualSummary(base, employeeTerms, employee, dates) {
    const paidDays = base.daily.filter(day => day.actualSeconds > 0 && day.payType === "hourly" && Number(day.rate) > 0);
    const hourlyRates = [...new Set((paidDays.length ? paidDays.map(day => Number(day.rate))
      : effectiveMonthTerms(employee, employeeTerms, dates).map(term => Number(term.rate))).filter(rate => Number.isFinite(rate) && rate > 0))];
    const wageBreakdown = paidDays.map(day => ({ code: "hourly_actual", label: "실제 근무 시급 / Lương theo giờ thực làm", category: "base",
      date: day.date, dayType: day.dayType, minutes: day.minutes, rate: day.rate, multiplier: 1,
      rawAmount: day.minutes * day.rate / 60, amount: Math.round(day.minutes * day.rate / 60) }));
    if (base.baseAmount !== null) {
      const rounding = base.baseAmount - wageBreakdown.reduce((sum, line) => sum + line.amount, 0);
      if (rounding) wageBreakdown.push({ code: "base_rounding", label: "월 합계 VND 반올림 조정 / Điều chỉnh làm tròn tổng tháng VND", category: "base",
        date: dates.at(-1), dayType: "work", minutes: 0, rate: 0, multiplier: 1, rawAmount: rounding, amount: rounding });
    }
    return { ...base, settlementMode: "hourly_actual", originalBaseAmount: base.baseAmount, hourlyActualMinutes: base.minutes,
      hourlyAmount: base.baseAmount, hourlyRate: hourlyRates.length === 1 ? hourlyRates[0] : null, hourlyRates, wageBreakdown,
      statutoryAmount: 0, monthlyExtraAmount: 0, monthlyExtraMinutes: 0, monthlyExtraHourlyRate: null,
      monthlyPlannedMinutes: null, monthlyActualMinutes: null, monthlyBalanceMinutes: null, scheduleDefaultUsed: false,
      plannedMinutes: 0, fullMonthPlannedMinutes: 0, paidScheduledMinutes: 0, paidLeaveDays: 0, unpaidLeaveDays: 0, holidayDays: 0, restDays: 0,
      regularOvertimeMinutes: 0, restWorkMinutes: 0, holidayWorkMinutes: 0, nightMinutes: 0, nightOvertimeMinutes: 0,
      ruleVersionIds: [], ruleUnresolved: 0, ruleIssues: [], yearToDateOvertimeMinutes: 0, annualCoverageComplete: false, sources: [], calculationVersion: 4,
      daily: base.daily.map(day => ({ ...day, overtimeCandidates: [], nightCandidates: [], approvedOvertimeMinutes: 0, approvedNightMinutes: 0, statutoryAmount: 0 })) };
  }

  function extendSummaries({ month, employees = [], terms = [], records = [], days = [], rules = [], baseSummaries, yearToDateRuns, today }) {
    const dates = monthDates(month), first = dates[0], last = dates.at(-1);
    days = buildEffectiveDays({ month, employees, terms, days });
    const calculated = core.summarizeMonth({ month, employees, terms, records, days, today });
    const bases = baseSummaries || calculated;
    return bases.map((base) => {
      const employee = employees.find((item) => item.id === base.employee_id) || {};
      const employeeTerms = terms.filter((item) => item.employee_id === base.employee_id)
        .map(term => employee.employment_type === "part_time" ? { ...term, break_start: "00:00", break_end: "00:00" } : term);
      const effectiveTerms = effectiveMonthTerms(employee, employeeTerms, dates);
      if (employee.employment_type === "part_time" && effectiveTerms.length && effectiveTerms.every(term => term.pay_type === "hourly")) {
        const freshBase = calculated.find(row => row.employee_id === base.employee_id) || base;
        return hourlyActualSummary(freshBase, employeeTerms, employee, dates);
      }
      if (effectiveMonthTerms(employee, employeeTerms, dates).some(isMonthlyNet)) {
        const freshBase = calculated.find((row) => row.employee_id === base.employee_id) || base;
        return monthlyNetSummary({ month, dates, employee, employeeTerms, days, base: freshBase, today });
      }
      const dayMap = new Map(days.filter((day) => day.employee_id === base.employee_id).map((day) => [day.work_date, day]));
      const wageBreakdown = [], warnings = [...(base.warnings || [])], ruleIssues = [], ruleIds = new Set();
      const issue = (date, text) => { const value = (date ? date + ": " : "") + text; if (!ruleIssues.includes(value)) ruleIssues.push(value); };
      const warning = (text) => { if (!warnings.includes(text)) warnings.push(text); };
      const statutoryCodes = new Set(["ordinary_overtime", "rest_overtime", "holiday_overtime", "night_premium", "night_overtime_extra", "statutory_rounding"]);
      const add = (code, label, date, dayType, minutes, rate, multiplier, amount) => wageBreakdown.push({ code, label, date, dayType, minutes: round(minutes), rate: round(rate), multiplier,
        category: statutoryCodes.has(code) ? "statutory" : "base", rawAmount: round(amount), amount: Math.round(amount) });
      let plannedMinutes = 0, fullMonthPlannedMinutes = 0, fullSchedule = true, paidLeaveDays = 0, unpaidLeaveDays = 0, holidayDays = 0, restDays = 0;
      let paidScheduledMinutes = 0, normalBase = 0, paidLeaveBase = 0, holidayBase = 0, statutoryRaw = 0;
      let regularOvertimeMinutes = 0, restWorkMinutes = 0, holidayWorkMinutes = 0, nightMinutes = 0, nightOvertimeMinutes = 0;
      let crossesCalendarMonth = false;
      const originalBaseAmount = base.baseAmount;
      for (const date of dates) {
        const day = dayMap.get(date), term = latest(employeeTerms, date), schedule = scheduleBounds(term, date);
        if (!day || (day.day_type !== "rest" && !schedule)) fullSchedule = false;
        if (day && day.day_type !== "rest" && schedule) fullMonthPlannedMinutes += duration(schedule.normal);
        if (!withinEmployment(employee, date) || !day) continue;
        if (day.day_type === "paid_leave") paidLeaveDays += 1;
        if (day.day_type === "unpaid_leave") unpaidLeaveDays += 1;
        if (day.day_type === "holiday") holidayDays += 1;
        if (day.day_type === "rest") restDays += 1;
        if (day.day_type !== "rest" && schedule) {
          const value = duration(schedule.normal); plannedMinutes += value;
          if (day.day_type !== "unpaid_leave") paidScheduledMinutes += value;
        }
      }
      function denominator(rule) {
        if (rule && rule.monthly_hour_basis === "contract") return hasNumber(rule.monthly_contract_hours) && Number(rule.monthly_contract_hours) > 0 ? Number(rule.monthly_contract_hours) * 60 : null;
        return fullSchedule && fullMonthPlannedMinutes > 0 ? fullMonthPlannedMinutes : null;
      }
      function hourlyRate(term, rule, schedule, date) {
        if (term.overtime_hourly_rate !== null && term.overtime_hourly_rate !== undefined && term.overtime_hourly_rate !== "") {
          if (!hasNumber(term.overtime_hourly_rate) || Number(term.overtime_hourly_rate) < 0 || (Number(term.overtime_hourly_rate) === 0 && Number(term.rate) > 0)) {
            issue(date, "연장수당 기준 시급을 확인하세요 / Kiểm tra đơn giá lương làm thêm"); return null;
          }
          return Number(term.overtime_hourly_rate);
        }
        if (term.pay_type === "hourly") return Number(term.rate);
        if (term.pay_type === "daily") return duration(schedule.normal) > 0 ? Number(term.rate) * 60 / duration(schedule.normal) : null;
        if (date.slice(0, 7) !== month && (!rule || rule.monthly_hour_basis !== "contract")) {
          issue(date, "월 경계 야간근무의 기준 시급·계약시간을 등록하세요 / Nhập đơn giá hoặc giờ hợp đồng cho ca qua tháng"); return null;
        }
        const minutes = denominator(rule);
        if (minutes == null) { issue(date, "연장수당 기준 시급 또는 완전한 월 근무표·계약시간이 필요합니다 / Cần đơn giá làm thêm hoặc đủ giờ chuẩn tháng"); return null; }
        warning("월급에서 환산한 기준 시급은 계약상 임금 범위와 분모를 검토하세요 / Kiểm tra căn cứ lương giờ quy đổi từ lương tháng");
        return Number(term.rate) * 60 / minutes;
      }

      const enhancedDaily = base.daily.map((daily) => {
        const date = daily.date, day = dayMap.get(date) || {}, term = latest(employeeTerms, date), schedule = scheduleBounds(term, date);
        const dayType = day.day_type || daily.dayType || "work";
        const actual = schedule ? subtract(workedIntervals(daily), schedule.breaks) : [];
        const special = ["rest", "holiday", "paid_leave"].includes(dayType);
        const contextFor = (calendarDate) => ({ date: calendarDate, dayType: dayMap.get(calendarDate)?.day_type || dayType,
          term: latest(employeeTerms, calendarDate), rule: normalizeRule(latest(rules, calendarDate)) });
        const actualParts = calendarPieces(actual);
        for (const part of actualParts) {
          if (!withinEmployment(employee, part.date)) issue(date, "재직기간 밖의 근무 시각을 확인하세요 / Kiểm tra giờ làm ngoài thời gian làm việc theo hợp đồng");
          if (part.date.slice(0, 7) !== month) crossesCalendarMonth = true;
        }
        const candidateOt = schedule ? actualParts.flatMap((part) => ["rest", "holiday", "paid_leave"].includes(contextFor(part.date).dayType)
          ? [part.interval] : subtract([part.interval], [[schedule.start, schedule.end]])) : [];
        const candidateNight = actualParts.flatMap((part) => intersect([part.interval], nightWindows(part.date, contextFor(part.date).rule || DEFAULTS)));
        const extra = { overtimeCandidates: serialize(candidateOt), nightCandidates: serialize(candidateNight), approvedOvertimeMinutes: 0, approvedNightMinutes: 0, statutoryAmount: 0 };
        if (!term || !schedule || !withinEmployment(employee, date)) return { ...daily, ...extra };
        const termRate = Number(term.rate), regularMinutes = daily.minutes;
        const unresolvedCodes = daily.issueCodes || [];
        const validAttendance = (unresolvedCodes.length === 0 && daily.status !== "review") || (unresolvedCodes.length === 1 && unresolvedCodes[0] === "paidLeave");
        if (actual.length && dayType === "unpaid_leave") issue(date, "근무한 무급휴가일의 구분을 수정하세요 / Sửa loại ngày nghỉ không lương có làm việc");
        if (duration(schedule.normal) <= 0) { issue(date, "휴게시간을 제외한 기준 근무시간이 0입니다 / Giờ chuẩn sau giờ nghỉ bằng 0"); return { ...daily, ...extra }; }
        if (!validAttendance) return { ...daily, ...extra };
        const needsPremium = duration(candidateOt) > 0 || duration(candidateNight) > 0;
        let premiumReady = true;
        for (const premiumDate of new Set(calendarPieces([...candidateOt, ...candidateNight]).map((part) => part.date))) {
          const rule = contextFor(premiumDate).rule;
          if (rule) ruleIds.add(rule.id || String(rule.version || rule.effective_from));
          const ruleErrors = rule ? validateRule(rule) : [];
          for (const text of ruleErrors) issue(date, premiumDate + " · " + text);
          if (!rule || !rule.ot_enabled) issue(date, premiumDate + " · 연장·야간 급여 규칙을 활성화하세요 / Bật quy tắc lương làm thêm và ban đêm");
          if (!rule || !rule.ot_enabled || ruleErrors.length) premiumReady = false;
        }
        let ot = [], night = [];
        if (needsPremium && premiumReady) {
          const hasReason = String(day.approval_reason || "").trim().length > 0;
          if (candidateOt.length) {
            const reviewed = approvedIntervals(day.overtime_intervals || [], candidateOt, "연장 / Làm thêm");
            reviewed.errors.forEach((text) => issue(date, text));
            if (!day.overtime_approved || !hasReason || reviewed.errors.length || Math.abs(duration(reviewed.intervals) - duration(candidateOt)) > 0.000001) issue(date, "추가근무 후보 구간을 확인·승인하세요 / Duyệt đầy đủ khoảng làm thêm hoặc sửa chấm công");
            else ot = reviewed.intervals;
          } else if (day.overtime_approved && (day.overtime_intervals || []).length) issue(date, "추가근무 후보가 없는 승인 구간입니다 / Không có giờ làm thêm phù hợp");
          if (candidateNight.length) {
            const reviewed = approvedIntervals(day.night_intervals || [], candidateNight, "야간 / Ban đêm");
            reviewed.errors.forEach((text) => issue(date, text));
            if (!day.night_approved || !hasReason || reviewed.errors.length || Math.abs(duration(reviewed.intervals) - duration(candidateNight)) > 0.000001) issue(date, "야간근무 구간을 확인·승인하세요 / Duyệt đầy đủ khoảng làm ban đêm");
            else night = reviewed.intervals;
          } else if (day.night_approved && (day.night_intervals || []).length) issue(date, "야간 범위 밖의 승인 구간입니다 / Khoảng duyệt không thuộc ban đêm");
        }
        const otMinutes = duration(ot), nightMins = duration(night);
        const nonOtMinutes = Math.max(0, regularMinutes - otMinutes);
        if (term.pay_type === "hourly") {
          for (const part of calendarPieces(subtract(actual, ot))) {
            const partTerm = contextFor(part.date).term;
            if (!partTerm || partTerm.pay_type !== "hourly" || !hasNumber(partTerm.rate) || Number(partTerm.rate) < 0) issue(date, "자정에 변경된 급여방식을 검토하세요 / Kiểm tra hình thức lương đổi lúc nửa đêm");
            else {
              const minutes = duration([part.interval]), rate = Number(partTerm.rate), value = minutes * rate / 60;
              normalBase += value;
              add("regular_base", "일반 근무 기본급 / Lương làm việc thường", part.date, contextFor(part.date).dayType, minutes, rate, 1, value);
            }
          }
        }
        if (term.pay_type === "daily" && nonOtMinutes > 0 && !special) normalBase += termRate;
        // Paid holiday/leave pay is separate from pay for work on that day.
        if (["paid_leave", "holiday"].includes(dayType) && term.pay_type !== "monthly") {
          const paidAmount = term.pay_type === "daily" ? termRate : duration(schedule.normal) * termRate / 60;
          if (dayType === "paid_leave") paidLeaveBase += paidAmount; else holidayBase += paidAmount;
          add(dayType === "paid_leave" ? "paid_leave_base" : "holiday_base", "유급휴가·휴일 기본급 / Lương ngày nghỉ có lương", date, dayType, duration(schedule.normal), term.pay_type === "daily" ? termRate * 60 / duration(schedule.normal) : termRate, 1, paidAmount);
        }
        if (term.pay_type === "daily" && nonOtMinutes > 0 && !special) add("regular_base", "일반 근무 기본급 / Lương làm việc thường", date, dayType, nonOtMinutes, termRate * 60 / duration(schedule.normal), 1, termRate);
        let dailyStatutory = 0;
        const partContext = (part) => {
          const context = contextFor(part.date), partSchedule = scheduleBounds(context.term, part.date);
          if (!context.term || !["monthly", "hourly", "daily"].includes(context.term.pay_type) || !hasNumber(context.term.rate) || Number(context.term.rate) < 0 || !context.rule || !partSchedule || duration(partSchedule.normal) <= 0) { issue(date, "적용 시급·근무조건 확인 / Kiểm tra đơn giá và điều kiện áp dụng"); return null; }
          const rate = hourlyRate(context.term, context.rule, partSchedule, part.date);
          return rate === null || !Number.isFinite(rate) ? null : { ...context, rate, minutes: duration([part.interval]),
            multiplier: context.dayType === "rest" ? context.rule.rest_overtime_multiplier : ["holiday", "paid_leave"].includes(context.dayType) ? context.rule.holiday_overtime_multiplier : context.rule.regular_overtime_multiplier };
        };
        for (const part of calendarPieces(ot)) {
          const context = partContext(part); if (!context) continue;
          const { minutes, rate, multiplier } = context, amount = minutes * rate * multiplier / 60;
          const code = context.dayType === "rest" ? "rest_overtime" : ["holiday", "paid_leave"].includes(context.dayType) ? "holiday_overtime" : "ordinary_overtime";
          add(code, "승인 연장·휴일근로 / Làm thêm đã duyệt", part.date, context.dayType, minutes, rate, multiplier, amount); dailyStatutory += amount;
          if (context.dayType === "rest") restWorkMinutes += minutes; else if (["holiday", "paid_leave"].includes(context.dayType)) holidayWorkMinutes += minutes; else regularOvertimeMinutes += minutes;
        }
        for (const part of calendarPieces(night)) {
          const context = partContext(part); if (!context) continue;
          const factor = context.rule.night_premium_rate, amount = context.minutes * context.rate * factor / 60;
          add("night_premium", "야간 가산 / Phụ cấp ban đêm", part.date, context.dayType, context.minutes, context.rate, factor, amount); dailyStatutory += amount;
        }
        const nightOt = intersect(ot, night), dayOt = subtract(ot, candidateNight);
        for (const part of calendarPieces(nightOt)) {
          const context = partContext(part); if (!context) continue;
          const specialPart = ["rest", "holiday", "paid_leave"].includes(context.dayType);
          const daytimeFactor = specialPart ? context.multiplier : dayOt.some((value) => value[1] <= part.interval[0]) ? context.rule.regular_overtime_multiplier : 1;
          const factor = context.rule.night_overtime_extra_rate * daytimeFactor, amount = context.minutes * context.rate * factor / 60;
          add("night_overtime_extra", "야간 연장 추가가산 / Cộng thêm làm đêm ngoài giờ", part.date, context.dayType, context.minutes, context.rate, factor, amount); dailyStatutory += amount;
        }
        nightOvertimeMinutes += duration(nightOt);
        if (otMinutes > duration(schedule.normal) * 0.5 && !special) warning(date + ": 일 연장근로 50% 한도 검토 / Kiểm tra giới hạn làm thêm 50% trong ngày");
        if (regularMinutes > 720) warning(date + ": 하루 총 근무 12시간 초과 검토 / Tổng giờ làm vượt 12 giờ");
        nightMinutes += nightMins; statutoryRaw += dailyStatutory;
        const dailyRuleIssues = ruleIssues.filter((text) => text.startsWith(date + ": "));
        const remainingIssues = [...(daily.issues || []).filter((_, index) => unresolvedCodes[index] !== "paidLeave"), ...dailyRuleIssues];
        return { ...daily, ...extra, issues: remainingIssues, issueCodes: unresolvedCodes.filter((code) => code !== "paidLeave"),
          status: dailyRuleIssues.length ? "review" : daily.status === "review" && !remainingIssues.length ? dayType : daily.status,
          approvedOvertimeMinutes: round(otMinutes), approvedNightMinutes: round(nightMins), statutoryAmount: Math.round(dailyStatutory) };
      });

      const employmentFirst = employee.hire_date && employee.hire_date > first ? employee.hire_date : first;
      const startTerm = latest(employeeTerms, employmentFirst), monthRule = normalizeRule(latest(rules, first));
      const anyMonthly = employeeTerms.some((term) => term.pay_type === "monthly" && term.effective_from <= last && (term.effective_from >= first || term === latest(employeeTerms, first) || term === startTerm));
      let baseAmount = anyMonthly ? originalBaseAmount : Math.round(normalBase + paidLeaveBase + holidayBase);
      let compensationIssues = (base.compensationIssues || []).filter((issueText) => !issueText.includes("유급휴일 급여 별도 검토 필요"));
      const outsideEmployment = (employee.hire_date && employee.hire_date > last) || (employee.termination_date && employee.termination_date < first);
      if (outsideEmployment && !base.daily.some((day) => day.checkIn)) baseAmount = 0;
      else if (anyMonthly && monthRule && monthRule.monthly_proration === "scheduled") {
        const relevantRules = dates.filter((date) => withinEmployment(employee, date)).map((date) => normalizeRule(latest(rules, date)));
        if (relevantRules.some((rule) => !rule || rule.monthly_proration !== "scheduled" || validateRule(rule).length)) issue("", "월 전체 일할계산 규칙을 확인하세요 / Kiểm tra quy tắc tính theo lịch cho cả tháng");
        let prorated = 0, complete = true;
        for (const date of dates.filter((value) => withinEmployment(employee, value))) {
          const day = dayMap.get(date), term = latest(employeeTerms, date), schedule = scheduleBounds(term, date), rule = normalizeRule(latest(rules, date));
          if (!day || (day.day_type !== "rest" && (!term || !schedule || term.pay_type !== "monthly"))) { complete = false; continue; }
          if (["rest", "unpaid_leave"].includes(day.day_type)) continue;
          const denominatorMinutes = fullSchedule && fullMonthPlannedMinutes > 0 ? fullMonthPlannedMinutes : denominator(rule);
          if (!denominatorMinutes) { complete = false; continue; }
          const minutes = duration(schedule.normal), amount = Number(term.rate) * minutes / denominatorMinutes;
          prorated += amount; ruleIds.add(rule.id || String(rule.version || rule.effective_from));
          add("monthly_proration", "근무표 기준 월급 배분 / Lương tháng theo lịch", date, day.day_type, minutes, Number(term.rate) * 60 / denominatorMinutes, 1, amount);
        }
        if (!complete) { issue("", "일할계산에 필요한 근무표·기준시간이 부족합니다 / Thiếu lịch hoặc giờ chuẩn để tính theo tỷ lệ"); baseAmount = null; }
        else { baseAmount = Math.round(prorated); compensationIssues = compensationIssues.filter((text) => !text.includes("월중 급여조건 변경") && !text.includes("입·퇴사월 급여")); }
      } else if (anyMonthly && Number.isFinite(baseAmount)) add("monthly_base", "약정 월 기본급 / Lương tháng theo hợp đồng", first, "work", plannedMinutes, plannedMinutes ? baseAmount * 60 / plannedMinutes : 0, 1, baseAmount);
      if (base.attendanceUnresolved > 0) baseAmount = null;
      if (anyMonthly && compensationIssues.length) baseAmount = null;
      // Keep exported VND line amounts reconciled to the rounded monthly totals.
      // rawAmount retains the pre-rounding calculation for review.
      const statutoryAmount = Math.round(statutoryRaw);
      for (const [category, target] of [["base", baseAmount], ["statutory", statutoryAmount]]) {
        if (!Number.isFinite(target)) continue;
        const roundedLines = wageBreakdown.filter((row) => row.category === category).reduce((sum, row) => sum + row.amount, 0);
        if (roundedLines !== target) add(category + "_rounding", "월 합계 VND 반올림 조정 / Điều chỉnh làm tròn tổng tháng VND", last, "work", 0, 0, 0, target - roundedLines);
      }
      const totalOt = regularOvertimeMinutes + restWorkMinutes + holidayWorkMinutes;
      const activeRules = dates.map((date) => normalizeRule(latest(rules, date))).filter(Boolean);
      const monthlyLimit = activeRules.length ? Math.min(...activeRules.map((rule) => rule.monthly_overtime_limit)) : 40;
      const annualLimit = activeRules.length ? Math.min(...activeRules.map((rule) => rule.annual_overtime_limit)) : 200;
      if (totalOt > monthlyLimit * 60) warning("월 연장근로 한도 초과: " + round(totalOt / 60) + "h / Vượt giới hạn làm thêm trong tháng");
      if (annualLimit > 200) warning("연 200시간 초과 적용의 법적 근거·절차를 확인하세요 / Kiểm tra điều kiện áp dụng trên 200 giờ mỗi năm");
      let priorOt = 0, annualComplete = Array.isArray(yearToDateRuns) && !crossesCalendarMonth;
      const priorRunMonths = new Set();
      for (const run of yearToDateRuns || []) {
        if (run.employee_id !== base.employee_id || !String(run.month).startsWith(month.slice(0, 4)) || run.month >= first) continue;
        priorRunMonths.add(String(run.month).slice(0, 7));
        const snapshot = run.snapshot || {};
        if (!["regularOvertimeMinutes", "restWorkMinutes", "holidayWorkMinutes"].every((key) => Number.isFinite(Number(snapshot[key])))) annualComplete = false;
        else priorOt += Number(snapshot.regularOvertimeMinutes) + Number(snapshot.restWorkMinutes) + Number(snapshot.holidayWorkMinutes);
      }
      const annualStartMonth = employee.hire_date && employee.hire_date.slice(0, 4) === month.slice(0, 4) ? employee.hire_date.slice(0, 7) : month.slice(0, 4) + "-01";
      for (let priorMonth = Number(annualStartMonth.slice(5, 7)); priorMonth < Number(month.slice(5, 7)); priorMonth += 1) {
        const key = month.slice(0, 4) + "-" + String(priorMonth).padStart(2, "0");
        if (employee.termination_date && employee.termination_date.slice(0, 7) < key) continue;
        if (!priorRunMonths.has(key)) annualComplete = false;
      }
      if (crossesCalendarMonth) warning("월 경계 야간근무는 시작일 급여월에 한 번 지급됩니다. 법정 월·연 한도는 실제 날짜별로 확인하세요 / Ca qua tháng được trả một lần theo tháng bắt đầu; kiểm tra giới hạn theo ngày thực tế");
      if (priorOt + totalOt > annualLimit * 60) warning("연 누적 연장근로 한도 초과 / Vượt giới hạn làm thêm cả năm");
      if (totalOt && !annualComplete) warning("이전 월 승인자료가 부족하여 연간 한도를 완전히 검증하지 못했습니다 / Thiếu dữ liệu tháng trước để kiểm tra cả năm");
      const attendanceUnresolved = Number(base.attendanceUnresolved || 0) + ruleIssues.length;
      const compensationUnresolved = compensationIssues.length;
      const remainingBaseIssues = (base.issues || []).filter((issueText) => !(base.compensationIssues || []).includes(issueText));
      return { ...base, originalBaseAmount, baseAmount, statutoryAmount, wageBreakdown, settlementMode: "statutory",
        monthlyPlannedMinutes: null, monthlyActualMinutes: null, monthlyBalanceMinutes: null, monthlyExtraMinutes: 0, monthlyExtraAmount: 0, monthlyExtraHourlyRate: null, scheduleDefaultUsed: false,
        daily: enhancedDaily, plannedMinutes: round(plannedMinutes), fullMonthPlannedMinutes: round(fullMonthPlannedMinutes), paidScheduledMinutes: round(paidScheduledMinutes),
        paidLeaveDays, unpaidLeaveDays, holidayDays, restDays, regularOvertimeMinutes: round(regularOvertimeMinutes), restWorkMinutes: round(restWorkMinutes), holidayWorkMinutes: round(holidayWorkMinutes),
        nightMinutes: round(nightMinutes), nightOvertimeMinutes: round(nightOvertimeMinutes), ruleVersionIds: [...ruleIds], warnings,
        ruleUnresolved: ruleIssues.length, ruleIssues, attendanceUnresolved, compensationUnresolved, compensationIssues,
        unresolved: attendanceUnresolved + compensationUnresolved, issues: [...remainingBaseIssues, ...compensationIssues, ...ruleIssues], calculationVersion: 2,
        yearToDateOvertimeMinutes: round(priorOt + totalOt), annualCoverageComplete: annualComplete, sources: SOURCES };
    });
  }
  root.DGV_PAYROLL_RULES = Object.freeze({ DEFAULTS, SOURCES, validateRule, createMonthSchedule, buildEffectiveDays, calculateMonthlyExtra, extendSummaries });
})(typeof globalThis !== "undefined" ? globalThis : window);
