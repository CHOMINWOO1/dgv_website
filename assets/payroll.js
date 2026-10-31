(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const core = window.DGV_PAYROLL_CORE;
  const db = DGV.supabase;
  const esc = DGV.escapeHTML;
  const money = (value) => value == null ? "—" : new Intl.NumberFormat("vi-VN", {maximumFractionDigits:0}).format(value);
  const hours = (minutes) => `${Math.floor(Math.abs(minutes || 0) / 60)}h ${Math.abs(minutes || 0) % 60}m`;
  const today = () => DGV.formatYmdInTimeZone(new Date(), "Asia/Ho_Chi_Minh");
  const state = {busy:false, loaded:false, employees:[], terms:[], records:[], days:[], runs:[], payments:[], imports:[], summaries:[], selected:"", preview:null, revision:null, paymentRequest:null, confirmation:null};
  const typeLabels = {work:"근무 / Làm",rest:"휴무 / Nghỉ",paid_leave:"유급휴가 / Nghỉ có lương",unpaid_leave:"무급휴가 / Nghỉ không lương",holiday:"공휴일 / Lễ"};
  const attendanceLabels={recognized:"자동 반영 / Tự động ghi nhận",in_progress:"근무 중 · 퇴근 대기 / Đang làm · Chờ giờ ra",missing:"출퇴근 누락 / Thiếu giờ chấm công",ambiguous:"기록 불일치 / Dữ liệu không khớp",no_record:"기록 없음 / Chưa có chấm công"};
  function attendanceText(day){return attendanceLabels[day?.attendanceStatus]||(day?.status==="confirmed"?"수정 기록 적용 / Đã áp dụng điều chỉnh":day?.minutes?attendanceLabels.recognized:typeLabels[day?.dayType]||attendanceLabels.no_record);}
  const payLabels = {monthly:"월급 / Tháng",hourly:"시급 / Giờ",daily:"일급 / Ngày"};
  let employeeDialogGeneration=0,loadGeneration=0,polling=false,reviewDirty=false,refreshFailed=false;
  const refreshStatus=document.createElement("div");
  refreshStatus.id="payrollRefreshStatus";refreshStatus.className="notice";refreshStatus.hidden=true;
  refreshStatus.setAttribute("role","status");refreshStatus.setAttribute("aria-live","polite");$("notice").after(refreshStatus);
  const selected = () => state.summaries.find((row) => row.employee_id === state.selected);
  const runFor = (id) => state.runs.find((run) => run.employee_id === id);
  const paymentMatches=(payment,employeeId,month=$("month").value)=>{const run=state.runs.find(r=>r.id===payment.run_id);return (payment.employee_id||run?.employee_id)===employeeId&&String(payment.payroll_month||run?.month||"").slice(0,7)===month.slice(0,7);};
  const paymentsFor=(employeeId,month=$("month").value)=>state.payments.filter(payment=>paymentMatches(payment,employeeId,month));
  const paidForEmployee=(employeeId,month=$("month").value)=>paymentsFor(employeeId,month).filter(payment=>!(state.reversals||[]).some(item=>item.payment_id===payment.id)).reduce((sum,payment)=>sum+Number(payment.amount),0);
  const paidFor = (run) => run ? paidForEmployee(run.employee_id,run.month) : 0;
  const totalFor = (run) => run ? Number(run.total)+(state.adjustments||[]).filter((item)=>item.run_id===run.id).reduce((sum,item)=>sum+Number(item.amount),0) : 0;
  const filtered = () => state.summaries.filter((row) => $("employeeFilter").value ? row.employee_id === $("employeeFilter").value : row.active !== false || row.daily.some((day)=>day.checkIn) || runFor(row.employee_id) || paymentsFor(row.employee_id).length);
  function notice(message, error = false) { $("notice").textContent = message; $("notice").className = `notice${error ? " error" : ""}`; $("notice").hidden = !message; }
  function refreshNotice(message) {refreshStatus.textContent=message;refreshStatus.hidden=!message;refreshFailed=false;}
  function clearAuthenticatedState() {
    employeeDialogGeneration++;loadGeneration++;reviewDirty=false;state.loaded=false;
    $("payrollApp").hidden=true;state.records=[];state.payments=[];state.preview=null;refreshNotice("");
    window.DGV_PAYROLL_WORKSPACE?.invalidate();window.DGV_PAYROLL_ADVANCED?.invalidate();window.DGV_PAYROLL_SERVICES?.invalidate();$("employeeForm").reset();$("sensitiveForm")?.reset();
    document.querySelectorAll("dialog[open]").forEach((dialog)=>dialog.close());
  }
  function hasActiveWork() {
    return reviewDirty||Boolean(window.DGV_PAYROLL_SERVICES?.hasActiveWork())||Boolean(document.querySelector("dialog[open]"))||Boolean(state.preview)||Boolean($("importFile").files.length)
      ||Boolean($("taxPreview")&&!$("taxPreview").hidden)||$("rangeExport")?.disabled===false
      ||Boolean(document.activeElement?.matches("input,textarea,select"));
  }
  async function checkForUpdates() {
    if(document.hidden||$("payrollApp").hidden||!state.loaded||state.busy||polling)return;
    polling=true;const generation=loadGeneration;
    try {
      await DGV.requireAuth({roles:["admin"]});
      if(generation!==loadGeneration||!state.loaded||$("payrollApp").hidden)return;
      const current=await revision();
      if(generation!==loadGeneration||!state.loaded||$("payrollApp").hidden||document.hidden||state.busy)return;
      if(current===state.revision){if(refreshFailed)refreshNotice("");return;}
      if(hasActiveWork()){
        refreshNotice("새 출퇴근·급여 기록이 있습니다. 입력·미리보기는 유지했습니다. 작업을 마친 뒤 새로고침하세요. / Có dữ liệu mới. Đã giữ nội dung đang nhập hoặc xem; tải lại sau khi hoàn tất.");
        return;
      }
      await task(async()=>{
        // Authentication can yield while a dialog opens; check again before
        // replacing any editable fields or a report's reviewed snapshot.
        if(hasActiveWork())return;
        await load();
        if(state.loaded)refreshNotice("새 출퇴근·급여 기록을 반영했습니다. / Đã cập nhật chấm công và lương mới.");
      });
    } catch(error) {
      if(generation!==loadGeneration||$("payrollApp").hidden)return;
      if(error.message==="AUTH_REQUIRED"){clearAuthenticatedState();location.reload();return;}
      refreshNotice("자동 갱신을 확인하지 못했습니다. 연결 후 다시 확인합니다. / Chưa kiểm tra được cập nhật; sẽ thử lại khi có kết nối.");
      refreshFailed=true;
    } finally {polling=false;}
  }
  function messageOf(error) {
    const message = error?.message || String(error);
    if(/PAYROLL_SERVICE_PROVIDER_REQUIRED/.test(message))return '외주 작업자를 다시 선택해 주세요. / Chọn lại bên nhận dịch vụ.';
    if(/PAYROLL_SERVICE_DETAILS_INVALID|PAYROLL_SERVICE_DETAILS_CONFLICT/.test(message))return '외주 작업기간·내용을 확인해 주세요. 이미 저장된 건이면 새로 조회하세요. / Kiểm tra công việc, thời gian; tra cứu lại khoản đã lưu.';
    if(/PAYROLL_SERVICE_NOT_EMPLOYEE/.test(message))return '외주 작업자는 직원 근무·급여 계산에 등록할 수 없습니다. 외주·수리비 메뉴를 이용해 주세요. / Dùng mục dịch vụ cho bên nhận ngoài.';
    if(/PAYROLL_ARCHIVE_REASON_REQUIRED/.test(message))return '삭제·복원 사유는 1~500자 한 줄로 입력해 주세요. / Nhập lý do từ 1 đến 500 ký tự, một dòng.';
    if(/PAYROLL_(?:EMPLOYEE_)?ARCHIVE_STATE_CONFLICT/.test(message))return '직원 상태가 변경되었습니다. 새로고침 후 다시 확인해 주세요. / Trạng thái đã đổi; tải lại.';
    if(/PAYROLL_(?:EMPLOYEE_)?ARCHIVE_RPC_REQUIRED|PAYROLL_ARCHIVED_EMPLOYEE_INACTIVE|PAYROLL_EMPLOYEE_ARCHIVED/.test(message))return '삭제된 직원은 먼저 복원해 주세요. / Khôi phục nhân viên trước.';
    if (/relation.*does not exist|schema cache|PGRST20[25]/i.test(message)) return "급여 DB 설정이 필요합니다. 관리자에게 문의해 주세요. / Cần thiết lập dữ liệu lương.";
    if (/stale|revision/i.test(message)) return "근무자료가 변경되었습니다. 새로고침 후 다시 검토해 주세요. / Dữ liệu đã đổi, vui lòng tải lại.";
    return message;
  }
  async function task(action) {
    if (state.busy) return;
    state.busy = true; $("workspace").disabled = true; $("payrollApp").setAttribute("aria-busy","true");
    document.querySelectorAll("dialog button[type=submit]").forEach((button) => button.disabled = true);
    try { await DGV.requireAuth({roles:["admin"]}); await action(); }
    catch (error) {
      if (error.message === "AUTH_REQUIRED") { clearAuthenticatedState(); location.reload(); return; }
      notice(messageOf(error), true);
      const dialog = document.querySelector("dialog[open]");
      if (dialog) { let alert = dialog.querySelector(".dialog-error"); if (!alert) { alert = document.createElement("p"); alert.className = "dialog-error notice error"; alert.setAttribute("role","alert"); dialog.querySelector("form").prepend(alert); } alert.textContent = messageOf(error); }
    } finally {
      state.busy = false; $("workspace").disabled = false; $("payrollApp").removeAttribute("aria-busy");
      document.querySelectorAll("dialog button[type=submit]").forEach((button) => button.disabled = false);
    }
  }
  async function result(query) { const response = await query; if (response.error) throw response.error; return response.data; }
  const rows = (table, query = (q) => q, order = [{column:"id"}]) => DGV.collectSupabasePages(() => query(db.from(table).select("*")), {order});
  const revision = async () => Number((await result(db.from("payroll_revision").select("version").eq("id",1).single())).version);
  function bounds(month) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("조회 월을 선택해 주세요. / Chọn tháng.");
    const start = `${month}-01`, next = new Date(`${start}T00:00:00Z`); next.setUTCMonth(next.getUTCMonth()+1);
    const before = new Date(`${start}T00:00:00Z`); before.setUTCDate(before.getUTCDate()-1);
    const after = new Date(next); after.setUTCDate(after.getUTCDate()+1);
    return {start,end:next.toISOString().slice(0,10),before:before.toISOString().slice(0,10),after:after.toISOString().slice(0,10)};
  }
  async function load() {
    const generation=++loadGeneration;
    state.loaded = false; $("export").disabled = true; $("employeeDetail").hidden = true;
    window.DGV_PAYROLL_WORKSPACE?.invalidate();
    window.DGV_PAYROLL_ADVANCED?.invalidate();window.DGV_PAYROLL_SERVICES?.invalidate();
    $("ledgerBody").innerHTML = '<tr><td colspan="7" class="empty">불러오는 중 / Đang tải…</td></tr>'; $("metrics").innerHTML = "";
    const month = $("month").value, dates = bounds(month);
    for (let attempt=0; attempt<3; attempt++) {
      const before = await revision();
      const [employees,terms,records,days,runs,imports] = await Promise.all([
        rows("payroll_employees"), rows("payroll_terms", (q) => q.lt("effective_from", dates.after)),
        rows("payroll_attendance_raw", (q) => q.gte("occurred_at", dates.before).lt("occurred_at", dates.after)),
        rows("payroll_days", (q) => q.gte("work_date", dates.before).lt("work_date", dates.after)),
        rows("payroll_runs", (q) => q.eq("month", dates.start)),
        result(db.from("payroll_imports").select("*").order("created_at",{ascending:false}).limit(20))
      ]);
      const paymentGroups=await Promise.all([rows("payroll_payments",q=>q.eq("payroll_month",dates.start)),runs.length?rows("payroll_payments",q=>q.in("run_id",runs.map(run=>run.id))):[]]);
      const payments=Array.from(new Map(paymentGroups.flat().map(payment=>[payment.id,payment])).values());
      const extra = window.DGV_PAYROLL_ADVANCED ? await DGV_PAYROLL_ADVANCED.load({month,dates,employees,runs,payments}) : {};
      const after=await revision();
      if(generation!==loadGeneration||$("payrollApp").hidden)return;
      if (before !== after) continue;
      const effectiveDays=window.DGV_PAYROLL_RULES?.buildEffectiveDays({month,employees,terms,days})||days;
      Object.assign(state,{employees,terms,records,days,effectiveDays,runs,payments,imports,...extra,revision:before,loaded:true});
      let summaries = core.summarizeMonth({month,employees,terms,records,days:effectiveDays,today:today()});
      if(window.DGV_PAYROLL_RULES) summaries=DGV_PAYROLL_RULES.extendSummaries({month,employees,terms,records,days:effectiveDays,rules:state.rules||[],baseSummaries:summaries,yearToDateRuns:state.historyRuns||[],today:today()});
      state.summaries = summaries.map((row) => {
        if(row.active===false && !row.daily.some((day)=>day.checkIn) && !runs.some((run)=>run.employee_id===row.employee_id)) return {...row,baseAmount:null,unresolved:row.unresolved+1,attendanceUnresolved:row.attendanceUnresolved+1,issues:[...row.issues,"비활성 직원입니다. 직원 정보에서 재직 상태를 확인하세요. / Nhân viên ngừng làm việc, kiểm tra trạng thái."]};
        return row;
      });
      const filter = $("employeeFilter").value;
      $("employeeFilter").innerHTML = '<option value="">전체 직원 / Tất cả</option>' + employees.filter(employee=>employee.payee_type!=='service').map((employee) => `<option value="${esc(employee.id)}">${esc(employee.name)} · #${esc(employee.device_user_id)}</option>`).join("");
      if (employees.some((employee) => employee.id === filter)) $("employeeFilter").value = filter;
      if (!employees.some((employee) => employee.id === state.selected&&employee.payee_type!=='service')) state.selected = "";
      reviewDirty=false;refreshNotice("");$("export").disabled = !state.summaries.length; render(); return;
    }
    throw new Error("다른 작업으로 자료가 변경되고 있습니다. 잠시 후 새로고침해 주세요. / Dữ liệu đang thay đổi, vui lòng tải lại.");
  }
  function render() {
    if (!state.loaded) return;
    const visible = filtered();
    const calculatedTotal=row=>{const run=runFor(row.employee_id);return run?totalFor(run):row.baseAmount==null?null:row.baseAmount+(row.statutoryAmount||0)+(row.monthlyExtraAmount||0);};
    const calculated = visible.reduce((sum,row) => sum + (calculatedTotal(row)??0),0);
    const paid = visible.reduce((sum,row) => sum + paidForEmployee(row.employee_id),0);
    const outstanding=visible.reduce((sum,row)=>{const total=calculatedTotal(row);return sum+(total==null?0:Math.max(0,total-paidForEmployee(row.employee_id)));},0);
    const reviews = visible.filter((row) => !runFor(row.employee_id) && (row.unresolved || row.baseAmount == null)).length;
    $("metrics").innerHTML = [["계산·확정 급여 / Lương dự kiến & đã chốt",money(calculated),"VND"],["실제 지급 (선지급 포함) / Đã trả",money(paid),"VND"],["미지급 (예상 포함) / Còn phải trả dự kiến",money(outstanding),"VND"],["정산 확인 필요 / Cần kiểm tra lương",reviews,`${visible.length} 직원 / nhân viên`]].map(([label,value,unit],index) => `<div class="metric ${index===1?"highlight":""}"><small>${label}</small><strong>${value}</strong><small>${unit}</small></div>`).join("");
    $("ledgerBody").innerHTML = visible.length ? visible.map((row) => {
      const run = runFor(row.employee_id), paid = paidForEmployee(row.employee_id), review = row.unresolved || row.baseAmount == null;
      const received=state.records.filter(record=>record.employee_id===row.employee_id&&record.occurred_at.startsWith($("month").value)).length;
      const reviewed=(state.reviews||[]).some((item)=>item.employee_id===row.employee_id&&Number(item.source_revision)===state.revision);
      const shown=row;
      const estimatedTotal=row.baseAmount==null?null:row.baseAmount+(row.statutoryAmount||0)+(row.monthlyExtraAmount||0);
      const balanceCell=run?money(totalFor(run)-paid):estimatedTotal!=null?`${money(estimatedTotal-paid)}<span class="muted">예상 잔액 / Còn lại dự kiến</span>`:"—";
      const timeCell=(shown.settlementMode==="monthly_net"?`<strong>${hours(shown.monthlyActualMinutes)}</strong><span class="muted">월 기준 / Chuẩn ${hours(shown.monthlyPlannedMinutes)}<br />${Number(shown.monthlyBalanceMinutes)<0?"−":"+"}${hours(shown.monthlyBalanceMinutes)} · 추가 / Thêm ${money(shown.monthlyExtraAmount)} VND</span>`:`${hours(shown.minutes)}<span class="muted">${shown.workedDays}일 / ngày</span>`)+(received?`<span class="badge ${row.attendanceUnresolved?"warn":"neutral"}">출퇴근 원본 ${received}건 / ${received} lần chấm công</span>`:"");
      const status = run ? (paid>totalFor(run)?"초과 지급 / Trả dư":paid === totalFor(run) ? "지급 완료 / Đã trả" : paid ? "일부 지급 / Trả một phần" : "급여 확정 / Đã chốt") : paid?"선지급 · 미확정 / Tạm ứng, chưa chốt":review ? (row.monthlyPendingDays>0&&row.unresolved===1?"월 집계 중 / Đang tổng hợp tháng":"정산 확인 필요 / Cần kiểm tra lương") : reviewed?"검토 완료 / Đã duyệt":"계산 완료 / Đã tính";
      return `<tr><td><strong>${esc(row.name)}</strong><span class="muted">ID ${esc(row.device_user_id)}</span></td><td>${timeCell}</td><td>${money(run?totalFor(run):estimatedTotal)}<span class="muted">${run?"확정 / Đã chốt":"계산 급여 / Lương dự kiến"}</span></td><td>${money(paid)}</td><td>${balanceCell}</td><td><span class="badge ${!run&&review?"warn":!run?"neutral":""}">${status}</span></td><td><button class="quiet" data-employee="${esc(row.employee_id)}">급여 상세 / Chi tiết</button><button class="quiet" data-staff-id="${esc(row.employee_id)}" data-staff-action="pay">지급·서명 / Trả &amp; ký</button></td></tr>`;
    }).join("") : '<tr><td colspan="7" class="empty">엑셀을 가져오거나 직원을 등록해 주세요.<br />Nhập tệp Excel hoặc thêm nhân viên để bắt đầu.</td></tr>';
    $("importHistory").innerHTML = state.imports.length ? state.imports.map((entry) => `<p class="term-row"><strong>${esc(entry.filename)}</strong> · 신규 / Mới ${entry.inserted_count} · 중복 / Trùng ${entry.duplicate_count}<br /><span class="muted">${esc(new Date(entry.created_at).toLocaleString("ko-KR",{timeZone:"Asia/Ho_Chi_Minh"}))} (VN)</span></p>`).join("") : '<p class="muted">가져오기 이력이 없습니다. / Chưa nhập dữ liệu.</p>';
    renderDetail();
    window.DGV_PAYROLL_ADVANCED?.render();
    window.DGV_PAYROLL_WORKSPACE?.render();window.DGV_PAYROLL_SERVICES?.render();
  }
  function renderDetail() {
    reviewDirty=false;
    const row = selected(); $("employeeDetail").hidden = !row; if (!row) return;
    const run = runFor(row.employee_id), shown = run?.snapshot?.daily ? run.snapshot : row;
    $("detailTitle").textContent = `${row.name} · ID ${row.device_user_id}`;
    $("detailSummary").innerHTML = `지각 / Muộn <strong>${hours(shown.lateMinutes)}</strong> · 조퇴 / Về sớm <strong>${hours(shown.earlyMinutes)}</strong> · 추가 / Thêm <strong>${hours(shown.extraMinutes)}</strong><br /><span class="muted">내부 시간 비교 / Đối chiếu nội bộ: ${(shown.balanceMinutes||0)<0?"−":"+"}${hours(shown.balanceMinutes)} · 급여에 자동 반영하지 않음 / Không tự áp dụng vào lương${run?"<br />확정 당시 계산 내역입니다. / Hiển thị bản tính tại thời điểm chốt.":""}</span>`;
    const month = $("month").value, start = new Date(`${month}-01T00:00:00Z`), count = new Date(Date.UTC(start.getUTCFullYear(),start.getUTCMonth()+1,0)).getUTCDate();
    let calendar = ["일 / CN","월 / T2","화 / T3","수 / T4","목 / T5","금 / T6","토 / T7"].map((day)=>`<div class="weekday">${day}</div>`).join("") + '<span></span>'.repeat(start.getUTCDay());
    for (let day=1;day<=count;day++) {
      const date = `${month}-${String(day).padStart(2,"0")}`, daily = row.daily.find((item)=>item.date===date), schedule = (state.effectiveDays||state.days).find((item)=>item.employee_id===row.employee_id&&item.work_date===date);
      const label = daily?.attendanceStatus==="in_progress"?"근무 중 / Đang làm":daily?.attendanceStatus==="missing"?"출퇴근 누락 / Thiếu giờ":daily?.attendanceStatus==="ambiguous"?"기록 불일치 / Không khớp":daily?.minutes?hours(daily.minutes):schedule?.day_type&&schedule.day_type!=="work"?typeLabels[schedule.day_type]:daily?.attendanceStatus==="no_record"?"기록 없음 / Chưa có":"";
      calendar += `<button class="${daily?.issues?.length?"review":schedule?.day_type&&schedule.day_type!=="work"?"rest":""}" data-day="${date}" title="${date}">${day}<small>${esc(label)}</small></button>`;
    }
    $("calendar").innerHTML = calendar;
    $("dailyBody").innerHTML = row.daily?.length ? row.daily.map((item)=>`<tr data-work-date="${esc(item.date)}"><td>${esc(item.date)}</td><td>${esc(item.checkIn?.slice(11,16)||"—")}</td><td>${esc(item.checkOut ? (item.checkOut.slice(0,10)!==item.date?item.checkOut.slice(5,10)+" ":"")+item.checkOut.slice(11,16) : "—")}${item.openCheckIn?`<span class="muted">${esc(item.openCheckIn.slice(11,16))} 출근 · ${item.attendanceStatus==="in_progress"?"퇴근 대기 / Chờ giờ ra":"퇴근 누락 / Thiếu giờ ra"}</span>`:""}</td><td>${hours(item.minutes)}</td><td>${hours(item.lateMinutes)}</td><td>${hours(item.earlyMinutes)}</td><td>${hours(item.extraMinutes)}</td><td style="white-space:normal;min-width:190px"><strong>${esc(attendanceText(item))}</strong>${[...(item.issues||[]),...(item.warnings||[])].length?`<span class="muted">${esc([...new Set([...(item.issues||[]),...(item.warnings||[])])].join(" · "))}</span>`:""}</td></tr>`).join("") : '<tr><td colspan="8" class="empty">이 달의 근무기록이 없습니다. / Chưa có chấm công tháng này.</td></tr>';
    const terms = state.terms.filter((term)=>term.employee_id===row.employee_id).sort((a,b)=>b.effective_from.localeCompare(a.effective_from));
    const partTime=state.employees.find(employee=>employee.id===row.employee_id)?.employment_type==="part_time";
    $("termsList").innerHTML = terms.length ? terms.slice(0,5).map((term)=>`<div class="term-row"><strong>${payLabels[term.pay_type]} · ${money(term.rate)} VND</strong><div class="muted">${esc(term.effective_from)}부터 / Từ${partTime&&term.pay_type==="hourly"?" · 실제 근무시간 기준 / Theo giờ thực làm":" · "+esc(term.shift_start.slice(0,5))+"–"+esc(term.shift_end.slice(0,5))}<br />${partTime?"휴게 자동 차감 없음 / Không tự trừ giờ nghỉ":"휴게 / Nghỉ "+esc(term.break_start.slice(0,5))+"–"+esc(term.break_end.slice(0,5))}</div></div>`).join("") : '<p class="notice error">급여조건을 먼저 등록해 주세요. / Thêm điều kiện lương trước.</p>';
    if (run) $("reviewArea").innerHTML = `<p><span class="badge">확정 / Đã chốt</span> <strong>${money(totalFor(run))} VND</strong></p><p class="muted">기본급 / Cơ bản ${money(run.base_amount)} + 수당 / Phụ cấp ${money(run.allowances)} − 공제 / Khấu trừ ${money(run.deductions)} + 정정 / Điều chỉnh ${money(totalFor(run)-Number(run.total))}</p>`;
    else $("reviewArea").innerHTML = `<p class="muted">${esc(row.termsSummary || "")}</p>${row.issues.length?`<ul class="issue-list">${row.issues.map((issue)=>`<li>${esc(issue)}</li>`).join("")}</ul>`:""}<div class="review-grid"><label>추가수당 VND / Phụ cấp<input id="allowances" type="number" min="0" max="1000000000" step="1" value="0" /></label><label>검토한 공제 VND / Khấu trừ<input id="deductions" type="number" min="0" max="1000000000" step="1" value="0" /></label></div><label>수당·공제 근거 / Căn cứ<textarea id="adjustmentNote" maxlength="500"></textarea></label><div class="review-total">예상 지급 / Dự kiến <span id="draftTotal">${money(row.baseAmount)} VND</span></div><button id="finalize" ${row.unresolved||row.baseAmount==null?"disabled":""}>월 급여 총액 확정 / Chốt tổng lương tháng</button>`;
    if (!run && row.attendanceUnresolved === 0 && row.compensationUnresolved > 0) {
      $("reviewArea").insertAdjacentHTML("afterbegin", '<p class="muted">월중 급여 변경·유급휴가 금액을 검토한 뒤 기본급을 직접 입력하세요. / Xác nhận mức lương khi thay đổi giữa tháng hoặc nghỉ có lương.</p><label>검토한 기본급 VND / Lương đã kiểm tra<input id="reviewedBase" type="number" min="0" max="1000000000" step="1" required /></label><label>계산 근거 / Căn cứ tính<textarea id="reviewedBaseReason" maxlength="500" required></textarea></label>');
      $("finalize").disabled = false;
    }
    if (run?.snapshot?.reviewedBase) $("reviewArea").insertAdjacentHTML("beforeend", `<p class="muted">기본급 검토 근거 / Căn cứ: ${esc(run.snapshot.reviewedBase.reason)}</p>`);
    if (run?.snapshot?.adjustmentNote) $("reviewArea").insertAdjacentHTML("beforeend", `<p class="muted">수당·공제 근거 / Căn cứ phụ cấp: ${esc(run.snapshot.adjustmentNote)}</p>`);
    const payments = run ? state.payments.filter((payment)=>payment.run_id===run.id).sort((a,b)=>a.paid_on.localeCompare(b.paid_on)) : [];
    $("paymentArea").innerHTML = run ? `<p>확정 / Đã chốt <strong>${money(run.total)}</strong> · 지급 / Đã trả <strong>${money(paidFor(run))}</strong> · 잔액 / Còn lại <strong>${money(Number(run.total)-paidFor(run))} VND</strong></p><button class="quiet" id="addPayment" ${paidFor(run)>=Number(run.total)?"disabled":""}>+ 지급내역 / Thêm thanh toán</button><div class="table-scroll"><table><thead><tr><th>날짜 / Ngày</th><th>방법 / Cách trả</th><th>금액 / Số tiền</th><th>확인·비고 / Ghi chú</th></tr></thead><tbody>${payments.map((payment)=>`<tr><td>${esc(payment.paid_on)}</td><td>${payment.method==="cash"?"현금 / Tiền mặt":"이체 / Chuyển khoản"}</td><td>${money(payment.amount)}</td><td>${esc(payment.reference||"")}<span class="muted">${esc(payment.note||"")}</span></td></tr>`).join("")||'<tr><td colspan="4">지급내역 없음 / Chưa thanh toán</td></tr>'}</tbody></table></div>` : '<p class="muted">급여를 확정한 다음 지급내역을 기록할 수 있습니다. / Chốt lương trước khi ghi nhận thanh toán.</p>';
    window.DGV_PAYROLL_ADVANCED?.renderDetail(row,run);
    window.DGV_PAYROLL_WORKSPACE?.renderDetail(row,run);
  }
  function openDialog(id) { const dialog = $(id); dialog.querySelector(".dialog-error")?.remove(); dialog.showModal(); }
  function field(form, name) { return form.elements.namedItem(name); }
  async function employeeDialog(edit) {
    const generation=++employeeDialogGeneration;
    const form = $("employeeForm"), employee = edit ? state.employees.find((item)=>item.id===state.selected) : null;
    if(edit&&employee?.archived_at)throw new Error('삭제된 직원은 먼저 복원해 주세요. / Khôi phục nhân viên trước.');
    if(edit&&employee?.payee_type==='service')throw new Error('외주 작업자 정보는 외주·수리비 메뉴에서 변경하세요. / Sửa bên nhận dịch vụ trong mục dịch vụ.');
    if(edit&&!employee)throw new Error("직원을 선택해 주세요. / Chọn nhân viên.");
    form.reset(); form.dataset.employeeId = employee?.id || crypto.randomUUID();form.dataset.create=String(!employee);form.dataset.revision=String(state.revision);field(form,"device_user_id").value=employee?.device_user_id||""; field(form,"device_user_id").readOnly=!!employee;
    field(form,"name").value=employee?.name||""; field(form,"active").checked=employee?.active??true; window.DGV_PAYROLL_ADVANCED?.employeeEdit(employee,form);
    if(employee){const data=await result(db.rpc("payroll_get_sensitive",{p_employee_id:employee.id}));if(!state.loaded||generation!==employeeDialogGeneration)return;field(form,"national_id").value=data?.national_id||"";}
    openDialog("employeeDialog");
  }
  function dayDialog(date) {
    const form=$("dayForm"), day=(state.effectiveDays||state.days).find((item)=>item.employee_id===state.selected&&item.work_date===date);
    if(!state.loaded||!state.selected||!state.employees.some(employee=>employee.id===state.selected))throw new Error("직원을 다시 선택해 주세요. / Chọn lại nhân viên.");
    form.dataset.employeeId=state.selected;form.dataset.workDate=date;
    form.reset(); field(form,"work_date").value=date; field(form,"day_type").value=day?.day_type||"work";
    field(form,"check_in").value=day?.check_in?.slice(0,16)||""; field(form,"check_out").value=day?.check_out?.slice(0,16)||""; field(form,"reason").value=day?.reason||"";
    const punches=state.records.filter((item)=>item.employee_id===state.selected&&item.occurred_at.startsWith(date));
    $("dayRaw").textContent=`원본 기록 / Bản gốc: ${punches.map((item)=>item.occurred_at.slice(11,16)).join(", ")||"—"}`;window.DGV_PAYROLL_ADVANCED?.dayEdit(day,date,form); openDialog("dayDialog");
  }
  async function previewImport() {
    state.preview=null; $("importPreview").hidden=true;
    const file=$("importFile").files[0];
    if (!file || !/\.xlsx$/i.test(file.name)) throw new Error("N308 .xlsx 파일을 선택해 주세요. / Chọn tệp N308 .xlsx.");
    if (file.size>5*1024*1024 || !file.size) throw new Error("파일은 5 MB 이하이어야 합니다. / Tệp phải nhỏ hơn 5 MB.");
    const bytes=await file.arrayBuffer();
    if (new Uint8Array(bytes)[0]!==0x50 || new Uint8Array(bytes)[1]!==0x4b) throw new Error("올바른 XLSX 파일이 아닙니다. / Tệp XLSX không hợp lệ.");
    const parsed=await new Promise((resolve,reject)=>{
      const worker=new Worker("assets/payroll-import-worker.js");
      const timer=setTimeout(()=>{worker.terminate();reject(new Error("파일 분석 시간이 초과되었습니다. 더 작은 파일을 선택하세요. / Tệp quá lớn để xử lý."));},15000);
      const finish=()=>{clearTimeout(timer);worker.terminate();};
      worker.onmessage=({data})=>{finish();data.error?reject(new Error(data.error)):resolve(data.result);};
      worker.onerror=()=>{finish();reject(new Error("엑셀 분석에 실패했습니다. 파일 형식을 확인해 주세요. / Không đọc được tệp Excel."));};
      worker.postMessage(bytes,[bytes]);
    });
    if (parsed.errors.length) throw new Error(parsed.errors.slice(0,5).map((error)=>`${error.row}행 / dòng: ${error.message}`).join("\n"));
    if (!parsed.records.length) throw new Error("가져올 근무기록이 없습니다. / Không có bản ghi.");
    const employees=await rows("payroll_employees");
    const ids=employees.filter((employee)=>parsed.employees.some((item)=>item.device_user_id===employee.device_user_id)).map((employee)=>employee.id);
    const end=new Date(`${parsed.lastDate}T00:00:00Z`);end.setUTCDate(end.getUTCDate()+1);
    const existing=ids.length?await rows("payroll_attendance_raw",(query)=>query.in("employee_id",ids).gte("occurred_at",parsed.firstDate).lt("occurred_at",end.toISOString().slice(0,10))):[];
    const employeeIds=new Map(employees.map((employee)=>[employee.id,employee.device_user_id]));
    const keys=new Set(existing.map((record)=>`${employeeIds.get(record.employee_id)}|${record.occurred_at.replace(" ","T").slice(0,19)}|${record.device_id}`));
    const duplicates=parsed.records.filter((record)=>keys.has(`${record.device_user_id}|${record.occurred_at}|${record.device_id}`)).length;
    const unknown=parsed.employees.filter((employee)=>!employees.some((item)=>item.device_user_id===employee.device_user_id));
    state.preview={...parsed,filename:file.name};
    $("importPreview").innerHTML=`<p><strong>${parsed.firstDate} ~ ${parsed.lastDate}</strong> · ${parsed.employees.length}명 / nhân viên · ${parsed.records.length}건 / bản ghi</p><p>신규 예상 / Dự kiến mới <strong>${parsed.records.length-duplicates}</strong> · DB 중복 / Trùng DB <strong>${duplicates}</strong> · 파일 내 중복 / Trùng trong tệp <strong>${parsed.duplicates}</strong></p><p class="muted">${unknown.length?`새 직원 / Nhân viên mới: ${unknown.map((employee)=>esc(employee.name)+" (#"+esc(employee.device_user_id)+")").join(", ")} · 급여조건은 별도 등록 / Thêm điều kiện lương sau.<br />`:""}원본 엑셀은 저장하지 않습니다. 기존 기록은 유지하고 신규 기록만 추가합니다.<br />Không lưu tệp Excel. Giữ bản ghi cũ và chỉ thêm bản ghi mới.</p><div class="actions"><button id="cancelImport" class="quiet">취소 / Hủy</button><button id="saveImport">확인 후 DB 저장 / Xác nhận và lưu</button></div>`;
    $("importPreview").hidden=false;
  }
  async function saveImport() {
    if (!state.preview) return;
    const preview=state.preview;
    const saved=await result(db.rpc("payroll_import",{p_filename:preview.filename,p_records:preview.records}));
    state.preview=null;$("importPreview").hidden=true;$("importFile").value="";
    $("month").value=preview.lastDate.slice(0,7);
    await load();
    notice(`저장 완료: 신규 ${saved.inserted_count}건, 중복 ${Number(saved.duplicate_count)+preview.duplicates}건 건너뜀. / Đã lưu ${saved.inserted_count} mới, bỏ qua ${Number(saved.duplicate_count)+preview.duplicates} trùng.`);
  }
  function draft() {
    const row=selected();
    const allowances=Number($("allowances")?.value), deductions=Number($("deductions")?.value);
    const manual = !!row && row.attendanceUnresolved === 0 && row.compensationUnresolved > 0;
    const reviewedReason = $("reviewedBaseReason")?.value.trim() || "";
    const baseAmount = manual ? Number($("reviewedBase")?.value) : row?.baseAmount;
    if (!row || (row.unresolved && !manual) || baseAmount==null) throw new Error("확인 필요 항목을 먼저 해결해 주세요. / Xử lý các mục cần kiểm tra trước.");
    if (manual && (!$("reviewedBase")?.value || !Number.isSafeInteger(baseAmount) || baseAmount < 0 || baseAmount > 1e9 || !reviewedReason)) throw new Error("검토한 기본급과 계산 근거를 입력해 주세요. / Nhập lương đã kiểm tra và căn cứ.");
    if (![allowances,deductions].every((amount)=>Number.isSafeInteger(amount)&&amount>=0&&amount<=1e9)) throw new Error("수당·공제는 0 이상의 정수 VND로 입력하세요. / Nhập số tiền nguyên không âm.");
    const statutoryAmount=Number(row.statutoryAmount||0);
    const monthlySalaryBasis=!manual&&row?.monthlyProration?.applied?{salaryBasisAmount:row.monthlyProration.fullSalary,salaryBasisMinutes:row.monthlyProration.fullPlannedMinutes}:{};
    const monthlyExtra=row.settlementMode==="monthly_net"?DGV_PAYROLL_RULES.calculateMonthlyExtra({baseAmount,plannedMinutes:row.monthlyPlannedMinutes,extraMinutes:row.monthlyExtraMinutes,...monthlySalaryBasis}):null;
    if(row.settlementMode==="monthly_net"&&(monthlyExtra?.amount==null||monthlyExtra?.hourlyRate==null))throw new Error("월 기준시간과 기본급을 확인해 주세요. / Kiểm tra giờ chuẩn tháng và lương cơ bản.");
    const monthlyExtraAmount=monthlyExtra?.amount??Number(row.monthlyExtraAmount||0);
    const monthlyExtraHourlyRate=monthlyExtra?.hourlyRate??row.monthlyExtraHourlyRate;
    const total=baseAmount+statutoryAmount+monthlyExtraAmount+allowances-deductions;
    if (total<0) throw new Error("공제가 급여보다 클 수 없습니다. / Khấu trừ vượt quá lương.");
    const note=$("adjustmentNote").value.trim();
    if ((allowances||deductions)&&!note) throw new Error("수당·공제 근거를 입력해 주세요. / Nhập căn cứ phụ cấp và khấu trừ.");
    return {row,allowances,deductions,total,note,baseAmount,manual,reviewedReason,statutoryAmount,monthlyExtraAmount,monthlyExtraHourlyRate,monthlyExtraBasisAmount:monthlySalaryBasis.salaryBasisAmount??baseAmount,monthlyExtraBasisMinutes:monthlySalaryBasis.salaryBasisMinutes??row.monthlyPlannedMinutes};
  }
  function exportLedger() {
    if (!state.loaded) return;
    if(window.DGV_PAYROLL_ADVANCED)return DGV_PAYROLL_ADVANCED.exportWorkbook("ledger");
    const visible=filtered();
    const numeric=(value)=>value==null?"":Number(value);
    const ledger=visible.map((row)=>{const run=runFor(row.employee_id);return [row.device_user_id,row.name,run?"Đã chốt / 확정":"Dự kiến / 예상",numeric(run?.base_amount??row.baseAmount),numeric(run?.allowances),numeric(run?.deductions),numeric(run?.total),paidFor(run),run?Number(run.total)-paidFor(run):"",run?.snapshot?.minutes??row.minutes,run?.snapshot?.workedDays??row.workedDays,run?0:row.unresolved];});
    const attendance=visible.flatMap((row)=>(runFor(row.employee_id)?.snapshot?.daily||row.daily).map((day)=>[row.device_user_id,row.name,day.date,day.checkIn||"",day.checkOut||"",day.minutes,day.lateMinutes,day.earlyMinutes,day.extraMinutes,day.issues.join("; ")]));
    const visibleRuns=state.runs.filter((run)=>visible.some((row)=>row.employee_id===run.employee_id));
    const payments=state.payments.filter((payment)=>visibleRuns.some((run)=>run.id===payment.run_id)).map((payment)=>{const run=visibleRuns.find((item)=>item.id===payment.run_id),row=visible.find((item)=>item.employee_id===run.employee_id);return[row.name,payment.paid_on,payment.method,payment.amount,payment.reference||"",payment.note||""];});
    const sheets=[
      {name:"Bảng lương",columnWidths:[14,24,22,22,22,22,22,22,22,22,22,24],freezeRows:2,rows:[["HANA · Bảng lương / 급여대장",$("month").value],["ID","Nhân viên / 직원","Trạng thái / 상태","Cơ bản / 기본급","Phụ cấp / 수당","Khấu trừ / 공제","Đã chốt / 확정액","Đã trả / 지급액","Còn lại / 미지급","Phút làm / 근무분","Ngày làm / 근무일","Cần kiểm tra / 검토"],...ledger]},
      {name:"Chấm công",columnWidths:[14,24,16,24,24,22,22,22,22,60],freezeRows:1,rows:[["ID","Nhân viên / 직원","Ngày / 날짜","Vào / 출근","Ra / 퇴근","Phút làm / 근무분","Muộn / 지각분","Về sớm / 조퇴분","Thêm / 추가분","Kiểm tra / 확인"],...attendance]},
      {name:"Thanh toán",columnWidths:[24,22,22,20,36,50],freezeRows:1,rows:[["Nhân viên / 직원","Ngày trả / 지급일","Phương thức / 방법","VND","Tham chiếu / 확인","Ghi chú / 비고"],...payments]}
    ];
    for(const sheet of sheets) sheet.rows=sheet.rows.map((row,index)=>row.map((value)=>({value,style:index===sheet.freezeRows-1?"header":index<sheet.freezeRows-1?"title":typeof value==="number"?"integer":"normal"})));
    DGV_XLSX.downloadWorkbook({filename:`HANA_payroll_${$("month").value}.xlsx`,sheets});
  }
  $("month").value=today().slice(0,7);
  $("refresh").addEventListener("click",()=>task(load));
  $("month").addEventListener("change",()=>task(load));
  $("employeeFilter").addEventListener("change",()=>{state.selected=$("employeeFilter").value;render();});
  $("previewImport").addEventListener("click",()=>task(previewImport));
  $("importFile").addEventListener("change",()=>{state.preview=null;$("importPreview").hidden=true;});
  $("export").addEventListener("click",()=>task(exportLedger));
  $("addEmployee").addEventListener("click",()=>task(()=>employeeDialog(false)));
  $("editEmployee").addEventListener("click",()=>task(()=>employeeDialog(true)));
  $("addTerms").addEventListener("click",()=>{
    const employee=state.employees.find(item=>item.id===state.selected);if(!state.loaded||!employee||employee.archived_at||employee.payee_type==='service')return;
    const form=$("termsForm");form.reset();form.dataset.employeeId=employee.id;
    $("termsEmployeeContext").textContent=`${employee.name} · ID ${employee.device_user_id}`;
    field(form,"effective_from").value=`${$("month").value}-01`;window.DGV_PAYROLL_ADVANCED?.termsEdit(form);openDialog("termsDialog");
  });
  $("logout").addEventListener("click",()=>DGV.signOut());
  document.addEventListener("click",(event)=>{
    const button=event.target.closest("button");if(!button||state.busy)return;
    if(button.hasAttribute("data-close"))button.closest("dialog").close();
    if(button.dataset.employee){state.selected=button.dataset.employee;renderDetail();$("employeeDetail").scrollIntoView({behavior:"smooth",block:"start"});}
    if(button.dataset.day)dayDialog(button.dataset.day);
    if(button.id==="saveImport")task(saveImport);
    if(button.id==="cancelImport"){state.preview=null;$("importPreview").hidden=true;}
    if(button.id==="finalize")task(()=>{const values=draft();state.confirmation={...values,revision:state.revision,month:$("month").value};$("confirmForm").reset();$("confirmText").textContent=`${values.row.name} · ${$("month").value} · ${money(values.total)} VND`;openDialog("confirmDialog");});
    if(button.id==="addPayment"){
      const run=runFor(state.selected),form=$("paymentForm"),employee=state.employees.find(e=>e.id===state.selected);form.reset();form.dataset.employeeId=employee.id;form.dataset.month=$("month").value;form.dataset.runId=run?.id||"";field(form,"paid_on").value=today();field(form,"paid_on").max=today();field(form,"amount").max=String(run?Math.max(0,totalFor(run)-paidFor(run)):999999999999);field(form,"method").value=employee.payment_method==="bank"?"bank":"cash";$("paymentContext").textContent=employee.name+" · "+$("month").value+" · "+(run?"확정 급여 지급 / Trả lương đã chốt":"조기·수시 지급 · 월말 정산에 반영 / Tạm ứng, trả linh hoạt; trừ khi chốt tháng");state.paymentRequest=crypto.randomUUID();openDialog("paymentDialog");
    }
  });
  $("reviewArea").addEventListener("input",()=>{reviewDirty=true;try{const values=draft();$("draftTotal").textContent=money(values.total)+" VND";window.DGV_PAYROLL_ADVANCED?.renderMonthlyDraft(values);}catch{$("draftTotal").textContent="입력 확인 / Kiểm tra";}});
  $("employeeForm").addEventListener("submit",(event)=>{event.preventDefault();task(async()=>{
    const form=event.currentTarget||$("employeeForm"); // event.currentTarget can be cleared after await in task.
    const values={name:field(form,"name").value.trim(),device_user_id:field(form,"device_user_id").value.trim(),active:field(form,"active").checked,...window.DGV_PAYROLL_ADVANCED?.employeeValues(form)};
    if(!values.name)throw new Error("이름을 입력해 주세요. / Nhập tên.");
    const nationalId=field(form,"national_id").value.trim();
    if(!nationalId||nationalId.length>300||/[\u0000-\u001f\u007f]/.test(nationalId))throw new Error("신분증 번호를 입력해 주세요. / Nhập số định danh.");
    const employeeId=form.dataset.employeeId;
    await result(db.rpc("payroll_save_employee",{p_employee_id:employeeId,p_employee:values,p_national_id:nationalId,p_expected_revision:Number(form.dataset.revision),p_create:form.dataset.create==="true"}));
    state.selected=employeeId;$("employeeDialog").close();await load();
    if(state.loaded){$("employeeFilter").value=employeeId;render();}
    notice(`${values.name} · 직원 정보와 신분증 번호를 저장했습니다. 급여는 이 직원의 급여 설정에서 저장하세요. / Đã lưu thông tin nhân viên; thiết lập lương riêng cho nhân viên này.`);
  });});
  $("employeeDialog").addEventListener("close",()=>{employeeDialogGeneration++;const form=$("employeeForm");form.reset();delete form.dataset.employeeId;delete form.dataset.create;delete form.dataset.revision;});
  $("termsForm").addEventListener("submit",(event)=>{event.preventDefault();task(async()=>{
    const form=$("termsForm"),employee=state.employees.find(item=>item.id===form.dataset.employeeId);
    if(!state.loaded||!employee||employee.id!==state.selected)throw new Error("직원을 다시 선택한 뒤 급여 설정을 열어 주세요. / Chọn lại nhân viên rồi mở thiết lập lương.");
    const values=Object.fromEntries(new FormData(form));values.employee_id=employee.id;values.rate=Number(values.rate);
    if("overtime_hourly_rate" in values)values.overtime_hourly_rate=values.overtime_hourly_rate===""?null:Number(values.overtime_hourly_rate);
    window.DGV_PAYROLL_ADVANCED?.termsValues(values,form);
    if(!Number.isSafeInteger(values.rate)||values.rate<0)throw new Error("급여 단가를 확인해 주세요. / Kiểm tra mức lương.");
    const saved=await db.from("payroll_terms").insert(values);
    if(saved.error?.code==="23505")throw new Error(`${employee.name} · ${values.effective_from}에 이미 급여조건이 있습니다. 변경할 적용 시작일을 선택해 주세요. / Đã có điều kiện lương vào ngày này; chọn ngày hiệu lực mới.`);
    if(saved.error)throw saved.error;
    $("termsDialog").close();await load();notice(`${employee.name} · ${payLabels[values.pay_type]} ${money(values.rate)} VND · ${values.effective_from}부터 저장 완료 / Đã lưu, áp dụng từ ngày này.`);
  });});
  $("termsDialog").addEventListener("close",()=>{delete $("termsForm").dataset.employeeId;$("termsEmployeeContext").textContent="";});
  $("dayForm").addEventListener("submit",(event)=>{event.preventDefault();task(async()=>{
    const form=$("dayForm"),values=Object.fromEntries(new FormData(form));
    if(!state.loaded||!form.dataset.employeeId||form.dataset.employeeId!==state.selected||!state.employees.some(employee=>employee.id===form.dataset.employeeId)||values.work_date!==form.dataset.workDate)throw new Error("직원과 날짜를 다시 선택한 뒤 근무기록을 열어 주세요. / Chọn lại nhân viên và ngày chấm công.");
    values.employee_id=form.dataset.employeeId;values.reason=values.reason.trim();
    if(!values.reason)throw new Error("변경 사유를 입력해 주세요. / Nhập lý do.");
    const workStart=Date.parse(values.work_date+"T00:00:00Z"),dayMs=86400000;
    if(!Number.isFinite(workStart)||new Date(workStart).toISOString().slice(0,10)!==values.work_date)throw new Error("근무 날짜를 확인해 주세요. / Kiểm tra ngày làm.");
    for(const key of ["check_in","check_out"]){
      if(!values[key]){values[key]=null;continue;}
      const parsed=Date.parse(values[key]+":00Z");
      if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(values[key])||!Number.isFinite(parsed)||new Date(parsed).toISOString().slice(0,16)!==values[key])throw new Error("출퇴근 날짜와 시각을 확인해 주세요. / Kiểm tra ngày giờ vào và ra.");
      if(parsed<workStart||parsed>=workStart+(key==="check_in"?dayMs:2*dayMs))throw new Error(key==="check_in"?"출근은 선택한 근무일에 입력해 주세요. / Giờ vào phải thuộc ngày làm đã chọn.":"퇴근은 선택한 근무일 또는 다음 날에 입력해 주세요. / Giờ ra phải thuộc ngày làm hoặc ngày kế tiếp.");
      values[key]+=":00";
    }
    if(values.check_in&&values.check_out){
      const duration=Date.parse(values.check_out+"Z")-Date.parse(values.check_in+"Z");
      if(duration<=0||duration>dayMs)throw new Error("퇴근은 출근 이후 24시간 이내로 입력해 주세요. / Giờ ra phải sau giờ vào và trong vòng 24 giờ.");
    }
    window.DGV_PAYROLL_ADVANCED?.dayValues(values,form);
    await result(db.from("payroll_days").upsert(values,{onConflict:"employee_id,work_date"}));$("dayDialog").close();await load();notice("근무일을 저장했습니다. 원본 기록은 보존됩니다. / Đã lưu, giữ nguyên bản gốc.");
  });});
  $("confirmForm").addEventListener("submit",(event)=>{event.preventDefault();task(async()=>{
    const values=state.confirmation;if(!values)throw new Error("검토 내용을 다시 확인해 주세요. / Vui lòng kiểm tra lại.");
    const snapshot=window.DGV_PAYROLL_ADVANCED?.reviewSnapshot(values)||{...values.row,adjustmentNote:values.note,calculationVersion:2};
    if(values.manual){snapshot.originalUnresolved=values.row.unresolved;snapshot.unresolved=0;snapshot.reviewedBase={amount:values.baseAmount,reason:values.reviewedReason};}
    if(window.DGV_PAYROLL_ADVANCED)await DGV_PAYROLL_ADVANCED.recordReview(values,snapshot);
    await result(db.rpc("payroll_finalize",{p_employee_id:values.row.employee_id,p_month:values.month+"-01",p_base_amount:values.baseAmount,p_allowances:values.allowances+values.statutoryAmount+values.monthlyExtraAmount,p_deductions:values.deductions,p_snapshot:snapshot,p_expected_revision:values.revision}));
    state.confirmation=null;$("confirmDialog").close();await load();notice("급여를 확정했습니다. 실제 지급은 별도로 기록해 주세요. / Đã chốt lương. Ghi thanh toán riêng.");
  });});
  $("paymentForm").addEventListener("submit",(event)=>{event.preventDefault();task(async()=>{
    const values=Object.fromEntries(new FormData($("paymentForm")));values.amount=Number(values.amount);
    if(!Number.isSafeInteger(values.amount)||values.amount<=0)throw new Error("지급액을 확인해 주세요. / Kiểm tra số tiền.");
    const form=$("paymentForm"),employee=state.employees.find(e=>e.id===form.dataset.employeeId),run=state.runs.find(r=>r.id===form.dataset.runId),payrollMonth=form.dataset.month+"-01";
    const args={p_amount:values.amount,p_paid_on:values.paid_on,p_method:values.method,p_reference:values.reference.trim(),p_note:values.note.trim(),p_request_id:state.paymentRequest};
    const paymentId=await result(run?db.rpc("payroll_pay",{...args,p_run_id:run.id}):db.rpc("payroll_pay_advance",{...args,p_employee_id:employee.id,p_payroll_month:payrollMonth}));
    $("paymentDialog").close();
    // The payment is committed once. A signature retry must never pay again,
    // including when the subsequent ledger refresh fails.
    window.DGV_PAYROLL_ADVANCED?.openEvidence(paymentId,"signature",{payment:{id:paymentId,run_id:run?.id||null,employee_id:employee.id,payroll_month:payrollMonth,...values},run,employee});
    try{await load();}catch(error){if(error.message==="AUTH_REQUIRED")throw error;throw new Error("지급은 이미 저장되었습니다. 조회 갱신에 실패했지만 아래에서 서명을 저장할 수 있습니다. / Đã lưu thanh toán; tải lại thất bại nhưng vẫn có thể ký nhận.");}
    notice("지급을 기록했습니다. 직원의 수령 서명을 받아 주세요. / Đã ghi thanh toán. Vui lòng lấy chữ ký nhận lương.");
  });});
  db.auth.onAuthStateChange((event,session)=>{if(event==="SIGNED_OUT"||(session&&DGV.roleOf(session.user)!=="admin"))clearAuthenticatedState();});
  setInterval(checkForUpdates,30000);
  document.addEventListener("visibilitychange",()=>{if(!document.hidden)void checkForUpdates();});
  window.addEventListener("focus",()=>void checkForUpdates());
  window.DGV_PAYROLL_APP={state,db,$,esc,money,hours,today,rows,result,task,load,render,renderDetail,selected,runFor,paidFor,totalFor,openDialog,field,bounds,notice,draft,paymentMatches,paymentsFor,paidForEmployee};
  const startPayroll=async()=>{try{await QRStaff.requireLogin({roles:["admin"],preferredRole:"admin"});await DGV.requireAuth({roles:["admin"]});$("payrollApp").hidden=false;await task(load);}catch(error){$("pageError").textContent=messageOf(error);$("pageError").hidden=false;}};
  // Register advanced UI/report modules before even a cached session can load
  // the ledger; otherwise fast responses can skip their data and rendering.
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",startPayroll,{once:true});
  else void startPayroll();
})();
