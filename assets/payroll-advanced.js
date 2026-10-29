(function () {
  "use strict";
  const app=window.DGV_PAYROLL_APP;
  if(!app)throw new Error("Payroll application failed to initialize.");
  const {state,db,$,esc,money,hours,today,rows,result,task,load,openDialog,field,notice}=app;
  const isoDate=(date)=>date.toISOString().slice(0,10);
  const plusDay=(date,n)=>{const d=new Date(date+"T00:00:00Z");d.setUTCDate(d.getUTCDate()+n);return isoDate(d);};
  const amount=(input)=>{const n=Number(input);if(!Number.isSafeInteger(n))throw new Error("정수 VND를 입력하세요. / Nhập số tiền nguyên.");return n;};
  const hourlyMoney=(value)=>value==null?"—":Number(value).toLocaleString("ko-KR",{maximumFractionDigits:2});
  let rangeData=null,actionRequest=null,evidencePayment=null,signatureDrawn=false,taxIdentityPreview=null,taxPreviewGeneration=0,sensitiveGeneration=0;
  const employeeFields=["phone","employment_type","hire_date","termination_date","employment_status","payment_method"];
  const initialRules={ot_enabled:false,regular_overtime_multiplier:1.5,rest_overtime_multiplier:2,holiday_overtime_multiplier:3,night_premium_rate:0.3,night_overtime_extra_rate:0.2,night_start:"22:00",night_end:"06:00",monthly_proration:"none",monthly_hour_basis:"schedule",monthly_contract_hours:null,default_weekly_rest_days:[0],monthly_overtime_limit:40,annual_overtime_limit:200,pay_day:5};
  const ruleLabels={regular_overtime_multiplier:"일반일 연장 배율 / Hệ số ngày thường",rest_overtime_multiplier:"휴무일 배율 / Hệ số ngày nghỉ",holiday_overtime_multiplier:"공휴일 배율 / Hệ số ngày lễ",night_premium_rate:"야간 가산율 / Phụ trội ban đêm",night_overtime_extra_rate:"야간 연장 추가율 / Phụ trội làm thêm đêm",monthly_contract_hours:"월 계약시간 / Giờ theo hợp đồng",monthly_overtime_limit:"월 연장 한도(시간) / Giới hạn tháng",annual_overtime_limit:"연 연장 한도(시간) / Giới hạn năm",pay_day:"다음 달 지급일 / Ngày trả tháng sau"};
  const legalNames={receipt:"수령증 / Biên nhận",bank_transfer:"이체증빙 / Chuyển khoản",signature:"전자서명 / Chữ ký",tax_invoice:"세무 증빙 / Chứng từ thuế"};
  const weekdays=["일요일 / Chủ nhật","월요일 / Thứ hai","화요일 / Thứ ba","수요일 / Thứ tư","목요일 / Thứ năm","금요일 / Thứ sáu","토요일 / Thứ bảy"];
  const termAt=(employeeId,date)=>state.terms.filter(t=>t.employee_id===employeeId&&t.effective_from<=date).sort((a,b)=>b.effective_from.localeCompare(a.effective_from))[0];
  const termForMonth=(employeeId)=>{const month=$("month").value,start=month+"-01",hire=state.employees.find(e=>e.id===employeeId)?.hire_date;return termAt(employeeId,hire&&hire>start&&hire.startsWith(month)?hire:start)||state.terms.filter(t=>t.employee_id===employeeId&&t.effective_from.startsWith(month)).sort((a,b)=>a.effective_from.localeCompare(b.effective_from))[0];};
  const dialog=(id,body)=>document.body.insertAdjacentHTML("beforeend",`<dialog id="${id}">${body}</dialog>`);
  const actions='<div class="actions"><button type="button" data-close>취소 / Hủy</button><button type="submit">저장 / Lưu</button></div>';
  $("workspace").insertAdjacentHTML("afterbegin",'<nav class="payroll-nav" aria-label="급여 관리 메뉴"><a href="#importTitle">엑셀 / Nhập Excel</a><a href="#ledgerTitle">직원·급여 / Bảng lương</a><a href="#rangePanel">기간 조회 / Theo kỳ</a><a href="#employeeDetail">근무·지급 / Chấm công</a><a href="#taxCenter">세무자료 / Hồ sơ thuế</a><a href="#comparisonPanel">월별 비교 / So sánh</a><a href="#rulesPanel">급여 설정 / Thiết lập</a><a href="#archivePanel">백업·복구 / Sao lưu</a></nav><div id="payrollAlerts" role="status" aria-live="polite"></div>');
  $("workspace").insertAdjacentHTML("beforeend",`
    <section class="panel" id="rangePanel"><h2>기간별 근무·지급 조회 / Tra cứu theo ngày</h2><p class="muted">선택기간의 근무와 실제 지급일 기준 조회입니다. 월별 확정급여는 변경되지 않습니다. / Tra cứu chấm công và ngày thực trả; không thay đổi lương tháng.</p><div class="toolbar range-toolbar"><label>시작일 / Từ ngày<input id="rangeFrom" type="date" /></label><label>종료일 / Đến ngày<input id="rangeTo" type="date" /></label><label>직원 / Nhân viên<select id="rangeEmployee"><option value="">전체 / Tất cả</option></select></label><button id="rangeSearch">조회 / Xem</button><button id="rangeExport" class="quiet" disabled>Excel</button></div><div id="rangeReceipts" aria-live="polite"></div><div class="actions"><button id="rangeReceiptPrint" class="quiet" disabled>서명 포함 인쇄 · PDF / In kèm chữ ký</button></div><div id="rangeResult"></div></section>
    <section class="panel" id="taxCenter"><div class="section-head"><div><h2>세무자료 / Hồ sơ kế toán &amp; thuế</h2><p class="muted">베트남어 항목명·한국어 설명 / Tiếng Việt kèm tiếng Hàn · 세무 검토 후 제출 / Kế toán kiểm tra trước khi nộp</p></div></div><div class="toolbar"><label>자료 선택 / Chọn báo cáo<select id="exportKind"><option value="ledger">① 월별 급여대장 / Bảng lương</option><option value="attendance">② 직원별 출퇴근 / Chấm công</option><option value="parttime">③ 파트타임 지급 / Bán thời gian</option><option value="cash">④ 현금 지급 / Tiền mặt</option><option value="bank">⑤ 이체 지급 / Chuyển khoản</option><option value="outstanding">⑥ 미지급 현황 / Chưa trả</option><option value="tax">⑦ 세무대리인 제출용 / Hồ sơ kế toán</option></select></label><button id="previewTax">자료 확인 / Kiểm tra</button></div><div id="taxPreview" hidden></div></section>
    <section class="panel" id="comparisonPanel"><h2>월별 급여 비교 / So sánh lương tháng</h2><div id="comparisonResult"></div></section>
    <section class="panel" id="rulesPanel"><div class="section-head"><h2>급여 계산 설정 / Quy tắc tính lương</h2><button id="newRule" class="quiet">새 적용일 설정 / Thêm phiên bản</button></div><p class="muted">법정 수당은 승인된 실제 근무구간만 계산합니다. 계약·근무표를 확인하고 활성화하세요. 지각시간은 벌금성 공제로 전환하지 않습니다.<br />Chỉ tính phụ cấp cho giờ đã duyệt. Kiểm tra hợp đồng và lịch làm trước khi bật. Không phạt lương do đi muộn.</p><div id="ruleHistory"></div></section>
    <section class="panel" id="archivePanel"><h2>급여자료 백업·복구 / Sao lưu &amp; khôi phục</h2><p class="muted">비밀번호로 암호화한 백업을 내려받습니다. 복구는 기존 급여 데이터가 없는 경우에만 가능합니다. / Tải bản sao lưu mã hóa; chỉ khôi phục vào dữ liệu lương trống.</p><button id="openBackup" class="quiet">백업 / Sao lưu</button> <button id="openRestore" class="quiet">복구 / Khôi phục</button></section>`);
  const form=$("employeeForm");
  form.querySelector(".check").hidden=true;
  form.querySelector(".actions").insertAdjacentHTML("beforebegin",'<div class="form-grid"><label>연락처 / Điện thoại<input name="phone" maxlength="50" /></label><label>직원 유형 / Loại nhân viên<select name="employment_type"><option value="full_time">정규직 / Toàn thời gian</option><option value="part_time">파트타임 / Bán thời gian</option></select></label><label>입사일 / Ngày vào làm<input name="hire_date" type="date" /></label><label>퇴사일 / Ngày nghỉ việc<input name="termination_date" type="date" /></label><label>고용상태 / Trạng thái<select name="employment_status"><option value="active">재직 / Đang làm</option><option value="leave">휴직 / Tạm nghỉ</option><option value="terminated">퇴사 / Đã nghỉ</option></select></label><label>기본 지급방법 / Cách trả<select name="payment_method"><option value="cash">현금 / Tiền mặt</option><option value="bank">이체 / Chuyển khoản</option><option value="mixed">혼합 / Kết hợp</option></select></label></div>');
  $("termsForm").querySelector(".form-grid").insertAdjacentHTML("beforeend",`<label id="monthlySettlementLabel">월급 정산방식 / Cách tính lương tháng<select name="monthly_settlement"><option value="monthly_net">월 전체 시간 합산 / Bù trừ giờ cả tháng</option><option value="statutory">일별 승인수당 / Phụ cấp từng ngày đã duyệt</option></select></label><label id="weeklyRestLabel">주 1회 기본 휴무 / Ngày nghỉ hằng tuần<select name="weekly_rest_day">${weekdays.map((label,day)=>`<option value="${day}">${label}</option>`).join("")}</select><span class="muted">날짜별 휴무는 달력에서 변경 / Đổi từng ngày trên lịch</span></label><label id="statutoryHourlyLabel">일별 승인수당 기준 시급 VND / Đơn giá phụ cấp ngày<input name="overtime_hourly_rate" type="number" min="0" max="1000000000" step="1" /><span class="muted">비워두면 설정된 월 소정시간·계약시간으로 산정 / Để trống để tính theo giờ đã thiết lập</span></label>`);
  $("termsForm").querySelector(".actions").insertAdjacentHTML("beforebegin",'<p id="monthlyNetHelp" class="notice">월 기준시간 이하도 기본 월급을 유지합니다. 시급은 기본 월급 ÷ 해당 월 기준시간으로 자동 계산합니다. 월 전체 순초과분만 추가 지급합니다.<br />Giữ lương cơ bản khi thiếu giờ. Đơn giá giờ = lương cơ bản ÷ giờ chuẩn tháng; chỉ trả phần vượt sau bù trừ cả tháng.</p>');
  function syncTermsForm(){const form=$("termsForm"),monthly=field(form,"pay_type").value==="monthly",net=monthly&&field(form,"monthly_settlement").value==="monthly_net";$("monthlySettlementLabel").hidden=!monthly;$("weeklyRestLabel").hidden=!net;$("monthlyNetHelp").hidden=!net;$("statutoryHourlyLabel").hidden=net;}
  function termsEdit(form){const current=termForMonth(state.selected);if(current){field(form,"pay_type").value=current.pay_type;field(form,"rate").value=current.rate;field(form,"weekly_rest_day").value=current.weekly_rest_day??0;field(form,"overtime_hourly_rate").value=current.overtime_hourly_rate??"";}syncTermsForm();}
  function termsValues(values,form){const monthly=values.pay_type==="monthly";values.monthly_settlement=monthly?field(form,"monthly_settlement").value:"statutory";values.weekly_rest_day=Number(field(form,"weekly_rest_day").value);values.monthly_extra_hourly_rate=null;if(values.monthly_settlement==="monthly_net")values.overtime_hourly_rate=null;}
  for(const name of ["pay_type","monthly_settlement"])field($("termsForm"),name).addEventListener("change",syncTermsForm);
  syncTermsForm();
  $("dayForm").querySelector(".actions").insertAdjacentHTML("beforebegin",'<fieldset class="approval-box"><legend>추가·야간근무 승인 / Duyệt làm thêm &amp; ban đêm</legend><button id="fillCandidates" type="button" class="quiet">실제 후보 구간 채우기 / Điền giờ thực tế</button><label>연장 구간 / Khoảng làm thêm<textarea name="overtime_intervals" placeholder="2026-10-01 20:00 / 2026-10-01 21:00"></textarea></label><label class="check"><input name="overtime_approved" type="checkbox" /> 연장근무 승인 / Duyệt làm thêm</label><label>야간 구간 / Khoảng ban đêm<textarea name="night_intervals" placeholder="2026-10-01 22:00 / 2026-10-02 01:00"></textarea></label><label class="check"><input name="night_approved" type="checkbox" /> 야간근무 승인 / Duyệt ban đêm</label><label>승인 근거 / Lý do duyệt<input name="approval_reason" maxlength="500" /></label><p class="muted">구간은 한 줄에 시작 / 종료 형식으로 입력합니다. / Mỗi dòng: bắt đầu / kết thúc.</p></fieldset>');
  dialog("sensitiveDialog",`<form id="sensitiveForm"><h2>은행·세무 정보 / Thông tin ngân hàng &amp; thuế</h2><p class="muted">암호화하여 보관하며 관리자만 열람할 수 있습니다. 필요한 정보만 입력하세요. / Lưu mã hóa, chỉ quản trị được xem.</p>${[["bank_name","은행 / Ngân hàng"],["bank_account","계좌번호 / Số tài khoản"],["account_holder","예금주 / Chủ tài khoản"],["national_id","신분증 번호 (주민등록번호·CCCD) / Số định danh (CCCD/CMND)"],["tax_id","세금코드 / Mã số thuế"]].map(([name,label])=>`<label>${label}<input name="${name}" maxlength="300" autocomplete="off" /></label>`).join("")}<label>변경 사유 / Lý do<input name="reason" required maxlength="500" /></label>${actions}</form>`);
  dialog("scheduleDialog",`<form id="scheduleForm"><h2>월 근무표 생성 / Tạo lịch tháng</h2><p>기존에 지정한 날짜는 보존하고 빈 날짜만 채웁니다. / Giữ nguyên ngày đã đặt.</p><div class="weekday-options">${["일 / CN","월 / T2","화 / T3","수 / T4","목 / T5","금 / T6","토 / T7"].map((label,index)=>`<label class="check"><input type="checkbox" name="rest" value="${index}" ${index===0?"checked":""} />${label}</label>`).join("")}</div><label>생성 사유 / Lý do<input name="reason" required maxlength="500" value="월 근무표 등록 / Lập lịch tháng" /></label>${actions}</form>`);
  dialog("ruleDialog",`<form id="ruleForm"><h2>급여 규칙 버전 / Phiên bản quy tắc</h2><label>적용 시작일 / Hiệu lực từ<input name="effective_from" type="date" required /></label><label class="check"><input name="ot_enabled" type="checkbox" /> 계약·법정 기준을 검토했고 수당 계산을 활성화합니다. / Đã kiểm tra và bật tính phụ cấp.</label><div class="form-grid">${Object.entries(ruleLabels).map(([name,label])=>`<label>${label}<input name="${name}" type="number" min="0" step="${name.includes("rate")||name.includes("multiplier")?"0.01":"1"}" required /></label>`).join("")}<label>야간 시작 / Ban đêm từ<input name="night_start" type="time" required /></label><label>야간 종료 / Đến<input name="night_end" type="time" required /></label><label>월급 산정 / Tính lương tháng<select name="monthly_proration"><option value="none">약정 기본급 / Lương thỏa thuận</option><option value="scheduled">소정시간 기준 비례 / Theo giờ lịch</option></select></label><label>월급 시급 환산 / Cơ sở đơn giá giờ<select name="monthly_hour_basis"><option value="schedule">해당 월 근무표 / Lịch tháng</option><option value="contract">입력한 계약시간 / Giờ hợp đồng</option></select></label></div><label>변경 사유 / Lý do<textarea name="reason" required maxlength="1000"></textarea></label>${actions}</form>`);
  dialog("amendDialog",`<form id="amendForm"><h2 id="amendTitle"></h2><label id="amendAmountLabel">정정액 VND (+추가 / −감액) / Điều chỉnh<input name="amount" type="number" step="1" /></label><label>변경 사유 / Lý do<textarea name="reason" required maxlength="1000"></textarea></label><p class="muted">원래 확정·지급 기록은 유지하고 정정 이력을 남깁니다. / Giữ bản gốc và ghi lịch sử điều chỉnh.</p>${actions}</form>`);
  dialog("evidenceDialog",`<form id="evidenceForm"><h2 id="evidenceTitle">지급 증빙 / Chứng từ thanh toán</h2><div id="evidencePaymentSummary" class="receipt-payment-summary"></div><label>종류 / Loại<select name="evidence_type"><option value="receipt">현금 수령증 / Biên nhận</option><option value="bank_transfer">이체확인증 / Chuyển khoản</option><option value="tax_invoice">세무 증빙 / Chứng từ thuế</option><option value="signature">전자서명 / Chữ ký</option></select></label><label id="evidenceFileLabel">파일 / Tệp (PDF·PNG·JPEG·WebP, 5 MB)<input name="file" type="file" accept=".pdf,.png,.jpg,.jpeg,.webp" /></label><div id="signatureArea" hidden><label>수령인 이름 / Người nhận<input name="signed_name" maxlength="200" /></label><p class="muted">아래 칸에 손가락으로 서명해 주세요. / Ký bằng ngón tay vào ô dưới đây.</p><canvas id="signatureCanvas" width="1000" height="600" aria-label="급여 수령 서명 / Chữ ký nhận lương"></canvas><button type="button" id="clearSignature" class="quiet">다시 서명 / Ký lại</button><label class="check"><input name="acknowledged" type="checkbox" /> 급여 수령을 확인합니다. / Xác nhận đã nhận lương.</label></div><p class="muted">전자서명 외에 세무대리인이 요청하는 증빙도 함께 보관하세요. / Lưu thêm chứng từ theo yêu cầu kế toán.</p>${actions}</form>`);
  dialog("archiveDialog",`<form id="archiveForm"><h2 id="archiveTitle"></h2><label id="archiveFileLabel" hidden>암호화 백업 / Bản sao lưu mã hóa<input name="archive_file" type="file" accept=".payroll" /></label><label>백업 비밀번호 (12자 이상) / Mật khẩu (ít nhất 12 ký tự)<input name="password" type="password" required minlength="12" autocomplete="new-password" /></label><label class="check"><input name="confirmed" type="checkbox" required /> 백업 파일과 비밀번호를 안전하게 보관하며 복구 범위를 확인했습니다. / Đã kiểm tra phạm vi và bảo quản mật khẩu.</label><p id="archiveInfo" class="muted"></p>${actions}</form>`);

  async function loadExtra({month,dates,runs,payments}) {
    const [rules,reviews,historyRuns,adjustments,reversals,attachments]=await Promise.all([
      rows("payroll_rule_versions",q=>q.lt("effective_from",dates.after)),
      rows("payroll_reviews",q=>q.eq("month",dates.start)),
      rows("payroll_runs",q=>q.lte("month",dates.start)),
      rows("payroll_run_adjustments"),rows("payroll_payment_reversals"),rows("payroll_attachments")
    ]);
    const historyPaymentGroups=await Promise.all([rows("payroll_payments",q=>q.lte("payroll_month",dates.start)),historyRuns.length?rows("payroll_payments",q=>q.in("run_id",historyRuns.map(r=>r.id))):[]]);
    const historyPayments=Array.from(new Map(historyPaymentGroups.flat().map(p=>[p.id,p])).values());
    return {rules,reviews,historyRuns,historyPayments,adjustments,reversals,attachments};
  }
  function employeeEdit(employee,form) {
    for(const name of employeeFields)field(form,name).value=employee?.[name]||({employment_type:"full_time",employment_status:employee?.active===false?"terminated":"active",payment_method:"cash"}[name]||"");
  }
  function employeeValues(form) {
    const values=Object.fromEntries(employeeFields.map(name=>[name,field(form,name).value.trim()]));
    values.hire_date ||= null;values.termination_date ||= null;values.active=values.employment_status!=="terminated";
    if(values.hire_date&&values.termination_date&&values.termination_date<values.hire_date)throw new Error("퇴사일은 입사일 이후여야 합니다. / Ngày nghỉ phải sau ngày vào làm.");
    return values;
  }
  function formatIntervals(intervals) {return (intervals||[]).map(i=>`${i.start.replace("T"," ").slice(0,19)} / ${i.end.replace("T"," ").slice(0,19)}`).join("\n");}
  function parseIntervals(text) {
    if(!text.trim())return [];
    return text.trim().split(/\r?\n/).map(line=>{const parts=line.split("/").map(x=>x.trim());if(parts.length!==2)throw new Error("구간은 시작 / 종료 형식으로 입력하세요. / Nhập bắt đầu / kết thúc.");const start=DGV_PAYROLL_CORE.parseTimestamp(parts[0]),end=DGV_PAYROLL_CORE.parseTimestamp(parts[1]);if(!start||!end||start>=end)throw new Error("시작·종료 시각을 확인하세요. / Kiểm tra giờ bắt đầu và kết thúc.");return {start,end};});
  }
  function dayEdit(day,date,form) {
    const term=termAt(state.selected,date);form.querySelector(".approval-box").hidden=term?.pay_type==="monthly"&&term?.monthly_settlement==="monthly_net";
    field(form,"overtime_intervals").value=formatIntervals(day?.overtime_intervals);field(form,"night_intervals").value=formatIntervals(day?.night_intervals);
    field(form,"overtime_approved").checked=!!day?.overtime_approved;field(form,"night_approved").checked=!!day?.night_approved;field(form,"approval_reason").value=day?.approval_reason||"";
  }
  function dayValues(values,form) {
    values.overtime_intervals=parseIntervals(field(form,"overtime_intervals").value);values.night_intervals=parseIntervals(field(form,"night_intervals").value);
    values.overtime_approved=field(form,"overtime_approved").checked;values.night_approved=field(form,"night_approved").checked;values.approval_reason=field(form,"approval_reason").value.trim();
    if((values.overtime_approved||values.night_approved)&&!values.approval_reason)throw new Error("승인 근거를 입력하세요. / Nhập lý do duyệt.");
  }
  function requireLoaded(){if(!state.loaded)throw new Error("새로고침 후 다시 확인하세요. / Tải lại dữ liệu trước.");}
  function clearTaxPreview(){taxIdentityPreview=null;taxPreviewGeneration++;$("taxPreview").hidden=true;$("taxPreview").innerHTML="";}
  const taxScope=()=>JSON.stringify([$("month").value,$("employeeFilter").value,state.revision]);
  function invalidate(){clearReceiptPreview();sensitiveGeneration++;$("sensitiveForm").reset();clearTaxPreview();rangeData=null;$("rangeExport").disabled=true;$("rangeResult").textContent="";$("taxPreview").hidden=true;$("taxPreview").innerHTML="";$("previewTax").disabled=true;$("rangeSearch").disabled=true;$("payrollAlerts").innerHTML="";$("comparisonResult").textContent="";$("ruleHistory").textContent="";}
  function taxInput(overrides={}) {requireLoaded();return {month:$("month").value,employees:state.employees,terms:state.terms,records:state.records,days:state.effectiveDays||state.days,runs:state.runs,payments:state.payments,adjustments:state.adjustments||[],reversals:state.reversals||[],attachments:state.attachments||[],summaries:state.summaries,previousRuns:state.historyRuns||[],previousPayments:state.historyPayments||[],...overrides};}
  async function verifiedReportInput(kind,overrides={}) {
    requireLoaded();
    const scope=taxScope(),preview=taxIdentityPreview,generation=taxPreviewGeneration;
    if(kind!=="tax")return taxInput({kind,employeeId:$("employeeFilter").value||undefined,...overrides});
    if(!preview||preview.scope!==scope||!$("taxReviewed")?.checked)throw new Error("세무자료를 다시 확인해 주세요. / Kiểm tra lại hồ sơ thuế.");
    const current=Number((await result(db.from("payroll_revision").select("version").eq("id",1).single())).version);
    if(!state.loaded||generation!==taxPreviewGeneration||taxScope()!==scope||current!==state.revision){clearTaxPreview();throw new Error("자료가 변경되었습니다. 새로고침 후 세무자료를 다시 확인하세요. / Dữ liệu đã đổi; tải và kiểm tra lại.");}
    return taxInput({kind,employeeId:$("employeeFilter").value||undefined,...overrides,identities:preview.identities});
  }
  async function exportWorkbook(kind,overrides={}) {DGV_XLSX.downloadWorkbook(DGV_PAYROLL_TAX.buildPayrollWorkbook(await verifiedReportInput(kind,overrides)));}
  // Existing sales/expense pages were references for presentation only.
  $("taxCenter").querySelector(".section-head .actions")?.remove();
  field($("ruleForm"),"monthly_contract_hours").required=false;
  function render() {
    $("previewTax").disabled=false;$("rangeSearch").disabled=false;
    $("rulesPanel").querySelector(".muted").innerHTML="월 합산 방식은 기본 월급과 주 1회 휴무를 반영한 월 기준시간으로 시급을 자동 계산합니다. 아래 설정은 일별 승인수당 방식에 사용합니다.<br />Bù trừ tháng tự tính đơn giá từ lương cơ bản và giờ chuẩn với một ngày nghỉ mỗi tuần. Thiết lập dưới đây dành cho phụ cấp từng ngày.";
    const old=$("rangeEmployee").value;
    $("rangeEmployee").innerHTML='<option value="">전체 / Tất cả</option>'+state.employees.map(e=>`<option value="${esc(e.id)}">${esc(e.name)} · ${esc(e.device_user_id)}</option>`).join("");
    if(state.employees.some(e=>e.id===old))$("rangeEmployee").value=old;
    if(!$("rangeFrom").value){$("rangeFrom").value=$("month").value+"-01";$("rangeTo").value=plusDay(app.bounds($("month").value).end,-1);}
    const rule=(state.rules||[]).slice().sort((a,b)=>b.effective_from.localeCompare(a.effective_from))[0];
    $("ruleHistory").innerHTML=rule?`<p><strong>${esc(rule.effective_from)}부터 / Từ · ${rule.ot_enabled?"수당 계산 활성 / Đã bật":"검토 후 활성화 필요 / Chờ kích hoạt"}</strong></p><p class="muted">일반 / Thường ×${rule.regular_overtime_multiplier} · 휴무 / Nghỉ ×${rule.rest_overtime_multiplier} · 공휴일 / Lễ ×${rule.holiday_overtime_multiplier} · 야간 / Đêm +${Math.round(rule.night_premium_rate*100)}%</p>`:'<p class="notice error">급여 계산 규칙을 등록하고 계약조건을 확인해 주세요. / Thêm quy tắc và kiểm tra hợp đồng.</p>';
    if(state.rules?.length)$("ruleHistory").insertAdjacentHTML("beforeend",'<details><summary>적용 이력 / Lịch sử</summary>'+state.rules.slice().sort((a,b)=>b.effective_from.localeCompare(a.effective_from)).map(r=>`<p class="muted">${esc(r.effective_from)} · v${esc(r.version??r.id)} · ${esc(r.reason)}</p>`).join("")+'</details>');
    const reversed=new Set((state.reversals||[]).map(r=>r.payment_id));
    const overdue=(state.historyRuns||[]).map(run=>{
      const adjusted=(state.adjustments||[]).filter(a=>a.run_id===run.id).reduce((n,a)=>n+Number(a.amount),0);
      const paid=(state.historyPayments||[]).filter(p=>(p.run_id===run.id||p.employee_id===run.employee_id&&p.payroll_month===run.month)&&!reversed.has(p.id)).reduce((n,p)=>n+Number(p.amount),0);
      const payRule=(state.rules||[]).filter(r=>r.effective_from<=run.month).sort((a,b)=>b.effective_from.localeCompare(a.effective_from))[0]||rule||initialRules;
      const next=app.bounds(run.month.slice(0,7)).end.slice(0,7),due=run.snapshot?.settlementMode==="monthly_net"?(run.snapshot.monthlyExpectedPayDate||next+"-05"):`${next}-${String(payRule.pay_day||5).padStart(2,"0")}`;
      return {run,due,balance:Number(run.total)+adjusted-paid};
    }).filter(item=>item.balance>0&&item.due<today());
    const missing=state.payments.filter(p=>!reversed.has(p.id)&&!(state.attachments||[]).some(a=>a.payment_id===p.id));
    $("payrollAlerts").innerHTML=(overdue.length?`<div class="notice error">지급기한 경과 / Quá hạn: ${overdue.length}건 · ${money(overdue.reduce((n,r)=>n+r.balance,0))} VND</div>`:"")+(missing.length?`<div class="notice warning">지급 증빙 미등록 / Thiếu chứng từ: ${missing.length}건. 직원 상세에서 증빙을 첨부해 주세요. / Thêm chứng từ trong chi tiết nhân viên.</div>`:"");
    const month=$("month").value,previous=new Date(month+"-01T00:00:00Z");previous.setUTCMonth(previous.getUTCMonth()-1);const previousMonth=isoDate(previous).slice(0,7);
    const totals=(period)=>{const runs=(state.historyRuns||[]).filter(r=>r.month.startsWith(period));const ids=new Set(runs.map(r=>r.id));return {total:runs.reduce((n,r)=>n+Number(r.total),0)+(state.adjustments||[]).filter(a=>ids.has(a.run_id)).reduce((n,a)=>n+Number(a.amount),0),paid:(state.historyPayments||[]).filter(p=>ids.has(p.run_id)&&!reversed.has(p.id)).reduce((n,p)=>n+Number(p.amount),0),count:runs.length};};
    const prior=totals(previousMonth),current=totals(month);
    $("comparisonResult").innerHTML=`<div class="table-scroll"><table><thead><tr><th>급여 대상월 / Tháng lương</th><th>확정 직원 / Nhân viên</th><th>정정 포함 급여 / Lương</th><th>실제 지급 / Đã trả</th><th>미지급 / Còn lại</th></tr></thead><tbody>${[[previousMonth,prior],[month,current]].map(([m,t])=>`<tr><td>${m}</td><td>${t.count}</td><td>${money(t.total)}</td><td>${money(t.paid)}</td><td>${money(t.total-t.paid)}</td></tr>`).join("")}</tbody></table></div><p class="muted">전월 대비 확정급여 / Chênh lệch: ${money(current.total-prior.total)} VND. 미확정 직원은 포함하지 않습니다. / Không gồm lương chưa chốt.</p>`;
    clearTaxPreview();
    if(!state.rules?.length)$("ruleHistory").innerHTML='<p class="muted">월 합산 방식은 직원의 급여·근무조건을 등록하면 계산됩니다. / Nhập điều kiện nhân viên để tính bù trừ tháng.</p>';
  }
  function renderDetail(row,run) {
    const employee=state.employees.find(e=>e.id===row.employee_id),shown=run?.snapshot||row;
    const monthly=shown.settlementMode==="monthly_net";
    $("monthlyTimeSummary")?.remove();
    if(monthly){
      const balance=Number(shown.monthlyBalanceMinutes||0),sign=balance<0?"−":balance>0?"+":"";
      $("detailSummary").innerHTML=`<div class="monthly-time-grid" id="monthlyTimeSummary"><div><small>월 기준시간 / Giờ chuẩn tháng</small><strong data-testid="month-plan">${hours(shown.monthlyPlannedMinutes)}</strong></div><div><small>실제 근무 / Giờ thực tế</small><strong data-testid="month-actual">${hours(shown.monthlyActualMinutes)}</strong></div><div><small>초과·부족 / Chênh lệch</small><strong data-testid="month-balance">${sign}${hours(balance)}</strong></div><div><small>추가 지급 대상 / Phút được trả thêm</small><strong data-testid="month-extra">${hours(shown.monthlyExtraMinutes)}</strong></div></div><p>자동 계산 시급 / Đơn giá giờ tự tính <strong data-testid="month-hourly-rate">${hourlyMoney(shown.monthlyExtraHourlyRate)} VND</strong> · 월 초과수당 / Tiền vượt tháng <strong data-testid="month-extra-amount">${money(shown.monthlyExtraAmount)} VND</strong></p><p class="muted">기본 월급 ÷ 월 기준시간으로 시급 자동 계산 · 부족해도 기본급 유지 · 월 순초과분만 추가 지급 / Đơn giá = lương cơ bản ÷ giờ chuẩn tháng; giữ lương khi thiếu giờ, chỉ trả phần vượt. 금액은 시급을 반올림하지 않고 계산한 뒤 정수 VND로 반올림합니다. / Chỉ làm tròn số tiền cuối cùng.${shown.scheduleDefaultUsed?"<br />주 1회 기본 휴무 적용 · 휴무일은 달력에서 변경 / Lịch nghỉ một ngày mỗi tuần; đổi trên lịch.":""}${!run&&$("month").value>=today().slice(0,7)?"<br />현재까지 기록된 근무시간과 월 전체 기준시간을 비교한 예상값입니다. / Dự kiến theo giờ đã ghi và chuẩn cả tháng.":""}${run?"<br />확정 당시 월 정산 내역입니다. / Bản đối chiếu khi chốt lương.":""}</p>`;
    }
    if(shown.settlementMode==="monthly_net"){
      const payDate=shown.monthlyExpectedPayDate||app.bounds($("month").value).end.slice(0,7)+"-05";
      $("detailSummary").insertAdjacentHTML("beforeend",`<p class="notice" data-testid="month-pay-date">지급 예정일 / Ngày trả dự kiến: <strong>${esc(payDate)}</strong> · 해당 월 근무분을 다음 달 5일 지급 / Trả lương tháng vào ngày 5 tháng sau</p>`);
      const prorated=shown.monthlyProration;
      if(prorated?.applied)$("detailSummary").insertAdjacentHTML("beforeend",`<p class="notice" data-testid="month-proration">입사월 비례 기본급 / Lương tháng đầu: <strong>${money(shown.baseAmount)} VND</strong><br />입사일 / Ngày vào: ${esc(prorated.hireDate)} · 약정 월급 / Lương cả tháng ${money(prorated.fullSalary)} × 입사 후 기준 / Giờ từ ngày vào ${hours(prorated.activePlannedMinutes)} ÷ 월 전체 기준 / Giờ chuẩn cả tháng ${hours(prorated.fullPlannedMinutes)}<br />입사 전 기간은 제외하며, 입사 후 시간 부족으로 이 기본급을 줄이지 않습니다. 시급은 약정 월급 ÷ 월 전체 기준시간입니다. / Loại thời gian trước khi vào; không trừ lương này do thiếu giờ. Đơn giá = lương cả tháng ÷ giờ chuẩn cả tháng.</p>`);
    }
    const employeeTerms=state.terms.filter(t=>t.employee_id===row.employee_id&&t.pay_type==="monthly"&&t.monthly_settlement==="monthly_net").sort((a,b)=>b.effective_from.localeCompare(a.effective_from));
    if(employeeTerms.length){const term=employeeTerms[0];$("termsList").insertAdjacentHTML("beforeend",`<p class="muted">월 합산 정산 / Bù trừ cả tháng · 시급 자동 계산: 기본 월급 ÷ 월 기준시간 / Đơn giá tự tính: lương cơ bản ÷ giờ chuẩn tháng<br />주 1회 휴무 / Nghỉ mỗi tuần: ${esc(weekdays[term.weekly_rest_day??0])} · 달력 지정 우선 / Ưu tiên ngày trên lịch</p>`);}
    $("detailTitle").insertAdjacentHTML("afterend",'<div class="actions advanced-detail-actions"><button class="quiet" id="sensitiveInfo">은행·세무 정보 / Thông tin bảo mật</button><button class="quiet" id="monthSchedule">월 근무표 / Lịch tháng</button><button class="quiet" id="viewAudit">변경 이력 / Lịch sử</button></div>');
    // renderDetail can run repeatedly without rebuilding its surrounding heading.
    document.querySelectorAll(".advanced-detail-actions").forEach((node,index)=>{if(index)node.remove();});
    $("detailSummary").insertAdjacentHTML("beforeend",`<p class="muted">${employee?.employment_type==="part_time"?"파트타임 / Bán thời gian":"정규직 / Toàn thời gian"} · 소정시간 / Giờ kế hoạch ${hours(shown.plannedMinutes||0)} · 유급휴가 / Nghỉ có lương ${shown.paidLeaveDays||0}일 · 무급 / Không lương ${shown.unpaidLeaveDays||0}일 · 공휴일 / Lễ ${shown.holidayDays||0}일</p>`);
    if(shown.wageBreakdown?.length)$("reviewArea").insertAdjacentHTML("afterbegin",`<details open><summary>급여 계산 내역 / Chi tiết tính lương</summary><div class="table-scroll"><table class="wage-breakdown"><thead><tr><th>항목 / Khoản</th><th>근무 / Giờ</th><th>금액 / VND</th></tr></thead><tbody>${shown.wageBreakdown.map(item=>`<tr><td>${esc(item.date||"")} ${esc(item.label||item.code)}</td><td>${hours(item.minutes)}</td><td>${money(item.amount)}</td></tr>`).join("")}</tbody></table></div></details>`);
    if(shown.warnings?.length)$("reviewArea").insertAdjacentHTML("afterbegin",`<ul class="notice warning">${shown.warnings.map(warning=>`<li>${esc(warning)}</li>`).join("")}</ul>`);
    if(!run){
      $("reviewArea").insertAdjacentHTML("beforeend",'<button id="saveReview" class="quiet">검토내용 저장 / Lưu duyệt</button>');
      $("saveReview").disabled=!!row.attendanceUnresolved;
      if(row.baseAmount!=null)$("draftTotal").textContent=money(row.baseAmount+(row.statutoryAmount||0)+(row.monthlyExtraAmount||0))+" VND";
      const reviewed=(state.reviews||[]).filter(r=>r.employee_id===row.employee_id&&r.month===$("month").value+"-01"&&Number(r.source_revision)===state.revision).sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)))[0]?.snapshot;
      if(reviewed?.reviewedAmounts){
        $("allowances").value=reviewed.reviewedAmounts.allowances;$("deductions").value=reviewed.reviewedAmounts.deductions;$("adjustmentNote").value=reviewed.adjustmentNote||"";
        if($("reviewedBase")&&reviewed.reviewedBase){$("reviewedBase").value=reviewed.reviewedBase.amount;$("reviewedBaseReason").value=reviewed.reviewedBase.reason;}
        try{const values=app.draft();$("draftTotal").textContent=money(values.total)+" VND";renderMonthlyDraft(values);}catch{ /* Incomplete drafts remain blocked by normal validation. */ }
      }
    }else{
      $("reviewArea").insertAdjacentHTML("beforeend",'<button id="adjustRun" class="quiet">확정급여 정정 / Điều chỉnh lương</button>');
      const changes=(state.adjustments||[]).filter(a=>a.run_id===run.id);
      if(changes.length)$("reviewArea").insertAdjacentHTML("beforeend",changes.map(a=>`<p class="muted">정정 / Điều chỉnh ${money(a.amount)} VND · ${esc(a.reason)}</p>`).join(""));
      const normalized=days=>(days||[]).map(d=>[d.date,d.checkIn,d.checkOut,d.minutes]);
      if(JSON.stringify(normalized(run.snapshot?.daily))!==JSON.stringify(normalized(row.daily)))$("reviewArea").insertAdjacentHTML("beforeend",'<p class="notice warning">확정 이후 근무자료가 변경되었습니다. 확정 금액은 유지되며 필요한 차액은 정정으로 기록하세요. / Chấm công đã đổi; ghi điều chỉnh nếu cần.</p>');


    }
    renderPaymentDetail(row,run);
    renderRawAttendance(row);
  }
  function estimatedPay(row){return row.baseAmount==null?null:Number(row.baseAmount)+Number(row.statutoryAmount||0)+Number(row.monthlyExtraAmount||0);}
  function paymentBalanceHtml(total,paid,confirmed){
    const remaining=total==null?null:total-paid;
    return `<div class="payment-totals"><div><small>${confirmed?"확정 급여 / Lương đã chốt":"예상 급여 / Lương dự kiến"}</small><strong data-testid="payment-expected">${total==null?"미산정 / Chưa tính":money(total)+" VND"}</strong></div><div><small>실제 지급 / Đã trả</small><strong data-testid="payment-paid">${money(paid)} VND</strong></div><div><small>${remaining<0?"초과 지급 / Trả dư":confirmed?"남은 금액 / Còn lại":"예상 남은 금액 / Còn lại dự kiến"}</small><strong data-testid="payment-remaining">${remaining==null?"급여 확정 후 계산 / Tính sau khi chốt":money(Math.abs(remaining))+" VND"}</strong></div></div>`;
  }
  function renderPaymentDetail(row,run){
    const payments=app.paymentsFor(row.employee_id).slice().sort((a,b)=>b.paid_on.localeCompare(a.paid_on)||String(b.created_at||"").localeCompare(String(a.created_at||""))),reversals=state.reversals||[];
    const paid=app.paidForEmployee(row.employee_id),total=run?app.totalFor(run):estimatedPay(row);
    $("paymentArea").innerHTML=`<div id="paymentTotals">${paymentBalanceHtml(total,paid,!!run)}</div>${run?"":'<p class="muted">월급날 전 선지급·단기 알바 수시 지급을 기록할 수 있습니다. 같은 급여월의 이미 지급한 금액은 최종 정산에서 차감됩니다. 예상 잔액은 근무·급여 검토 후 달라질 수 있습니다.<br />Có thể tạm ứng hoặc trả linh hoạt trước khi chốt. Khoản đã trả cùng kỳ được trừ khi quyết toán; số dư dự kiến có thể thay đổi.</p>'}<button id="addPayment" ${run&&paid>=total?"disabled":""}>${run?"+ 지급하고 서명 받기 / Trả và ký nhận":"+ 조기·수시 지급 후 서명 / Tạm ứng, trả và ký"}</button><div class="payment-cards">${payments.map(p=>{const reversal=reversals.find(r=>r.payment_id===p.id),files=(state.attachments||[]).filter(a=>a.payment_id===p.id),signed=files.some(f=>f.evidence_type==="signature");return `<article class="payment-card ${reversal?"reversed":""}" data-payment-card="${esc(p.id)}"><strong>지급일 / Ngày trả ${esc(p.paid_on)} · ${p.method==="cash"?"현금 / Tiền mặt":"이체 / Chuyển khoản"} · ${money(p.amount)} VND</strong>${p.created_at?`<p class="muted">입력 시각 / Ghi nhận ${esc(new Date(p.created_at).toLocaleString("ko-KR",{timeZone:"Asia/Ho_Chi_Minh",hour12:false}))} (VN)</p>`:""}<p class="muted">${!p.run_id?"조기·수시 지급 / Tạm ứng, trả linh hoạt · ":""}${esc(p.reference||"")} ${esc(p.note||"")}</p>${reversal?`<p class="badge warn">취소 / Đã hủy · ${esc(reversal.reason)}</p>`:`<p class="badge ${signed?"":"warn"}" data-signature-status="${esc(p.id)}">${signed?"서명 저장됨 / Đã lưu chữ ký":"서명 대기 / Chờ ký"}</p><div class="actions"><button data-signature="${esc(p.id)}">${signed?"서명 추가 / Thêm chữ ký":"서명 받기 / Nhận chữ ký"}</button><button class="quiet" data-evidence="${esc(p.id)}">증빙 첨부 / Chứng từ</button><button class="quiet" data-reverse="${esc(p.id)}">지급 취소 / Hủy ghi nhận</button></div>`}${files.map(f=>`<p class="muted">${esc(legalNames[f.evidence_type]||f.evidence_type)} · ${esc(f.signed_name||f.filename)} <button class="quiet" data-file="${esc(f.id)}">보기 / Xem</button></p>`).join("")}</article>`;}).join("")||'<p class="muted">지급내역 없음 / Chưa thanh toán</p>'}</div>`;
  }
  function renderRawAttendance(row){
    if(!$("rawAttendancePanel"))$("dailyBody").closest(".table-scroll").insertAdjacentHTML("afterend",'<section id="rawAttendancePanel"><h3>수신된 출퇴근 원본 / Lần chấm công đã nhận</h3><p id="rawAttendanceSummary" class="muted"></p><div class="table-scroll raw-attendance-scroll"><table><thead><tr><th>기록 시각 (VN) / Thời gian</th><th>출퇴근 / Vào · Ra</th><th>입력 / Nguồn</th></tr></thead><tbody id="rawAttendanceRows"></tbody></table></div></section>');
    const records=state.records.filter(record=>record.employee_id===row.employee_id&&record.occurred_at.startsWith($("month").value)).slice().sort((a,b)=>b.occurred_at.localeCompare(a.occurred_at));
    $("rawAttendanceSummary").textContent=`원본 ${records.length}건 / ${records.length} lần chấm công · 저장된 원본과 급여에 합산된 시간은 다를 수 있습니다. 퇴근 누락·5분 미만 근무·급여조건 미등록은 위 근무내역에서 확인하세요. / Giờ tính lương có thể khác bản gốc; kiểm tra thiếu giờ ra, ca dưới 5 phút hoặc thiếu điều kiện lương.`;
    $("rawAttendanceRows").innerHTML=records.map(record=>`<tr><td>${esc(record.occurred_at.replace("T"," ").slice(0,19))}</td><td>${record.punch_type==="in"?"출근 / Vào":record.punch_type==="out"?"퇴근 / Ra":"출퇴근 기록 / Chấm công"}</td><td>${record.source==="kiosk"?"얼굴 출퇴근 / Chấm công khuôn mặt":"엑셀 / Excel"}</td></tr>`).join("")||'<tr><td colspan="3">수신된 원본 없음 / Chưa có bản gốc</td></tr>';
  }
  async function recordReview(values,snapshot) {
    return result(db.rpc("payroll_review",{p_employee_id:values.row.employee_id,p_month:(values.month||$("month").value)+"-01",p_snapshot:snapshot,p_reason:values.note||values.reviewedReason||"근무기록 및 급여 검토 / Đã kiểm tra chấm công và lương",p_expected_revision:values.revision??state.revision}));
  }
  async function searchRange() {
    requireLoaded();
    rangeData=null;clearReceiptPreview();$("rangeExport").disabled=true;$("rangeResult").textContent="불러오는 중 / Đang tải…";
    const searchGeneration=receiptGeneration,searchScope=receiptScope();
    const fromDate=$("rangeFrom").value,toDate=$("rangeTo").value,employeeId=$("rangeEmployee").value;
    if(!/^\d{4}-\d{2}-\d{2}$/.test(fromDate)||!/^\d{4}-\d{2}-\d{2}$/.test(toDate)||fromDate>toDate)throw new Error("시작일·종료일을 확인하세요. / Kiểm tra khoảng ngày.");
    if((new Date(toDate)-new Date(fromDate))/86400000>366)throw new Error("한 번에 최대 1년을 조회하세요. / Chọn tối đa một năm.");
    let consistent=null,rangeRevision=null;
    for(let attempt=0;attempt<3;attempt++){
      const before=Number((await result(db.from("payroll_revision").select("version").eq("id",1).single())).version);
      const fetched=await Promise.all([
        rows("payroll_attendance_raw",q=>{q=q.gte("occurred_at",plusDay(fromDate,-1)).lt("occurred_at",plusDay(toDate,2));return employeeId?q.eq("employee_id",employeeId):q;}),
        rows("payroll_days",q=>{q=q.gte("work_date",plusDay(fromDate,-1)).lte("work_date",plusDay(toDate,1));return employeeId?q.eq("employee_id",employeeId):q;}),
        rows("payroll_terms",q=>q.lte("effective_from",plusDay(toDate,1))),rows("payroll_payments",q=>q.gte("paid_on",fromDate).lte("paid_on",toDate)),rows("payroll_runs"),
        rows("payroll_employees",q=>employeeId?q.eq("id",employeeId):q),rows("payroll_run_adjustments"),rows("payroll_payment_reversals"),rows("payroll_attachments")]);
      const after=Number((await result(db.from("payroll_revision").select("version").eq("id",1).single())).version);
      if(before===after){consistent=fetched;rangeRevision=before;break;}
    }
    if(!state.loaded||$("payrollApp").hidden||searchGeneration!==receiptGeneration||searchScope!==receiptScope())return;
    if(!consistent)throw new Error("자료가 변경 중입니다. 잠시 후 다시 조회하세요. / Dữ liệu đang thay đổi; thử lại.");
    const [records,days,terms,payments,runs,employees,adjustments,reversals,attachments]=consistent;
    const summaries=[];let cursor=fromDate.slice(0,7);
    while(cursor<=toDate.slice(0,7)){
      const effectiveDays=DGV_PAYROLL_RULES.buildEffectiveDays({month:cursor,employees,terms,days}),base=DGV_PAYROLL_CORE.summarizeMonth({month:cursor,employees,terms,records,days:effectiveDays,today:today()});
      const checked=DGV_PAYROLL_RULES.extendSummaries({month:cursor,employees,terms,records,days:effectiveDays,baseSummaries:base,rules:[],today:today()});
      for(const row of base){const enhanced=checked.find(r=>r.employee_id===row.employee_id),net=enhanced?.settlementMode==="monthly_net";row.daily=(net?enhanced.daily:row.daily).filter(d=>d.date>=fromDate&&d.date<=toDate);const displayed=row.daily.reduce((n,d)=>n+d.minutes,0);row.minutes=net?Math.floor(row.daily.reduce((n,d)=>n+Number(d.actualSeconds||0),0)/60):displayed;row.rangeRoundingMinutes=row.minutes-displayed;summaries.push(row);}
      cursor=app.bounds(cursor).end.slice(0,7);
    }
    const matchingRuns=new Set(runs.filter(r=>!employeeId||r.employee_id===employeeId).map(r=>r.id));
    const selectedPayments=payments.filter(p=>p.employee_id?(!employeeId||p.employee_id===employeeId):matchingRuns.has(p.run_id));
    rangeData={revision:rangeRevision,month:fromDate.slice(0,7),fromDate,toDate,employeeId:employeeId||undefined,employees,terms,records,days,runs,payments:selectedPayments,summaries,adjustments,reversals,attachments};
    const reversed=new Set(reversals.map(r=>r.payment_id)),daily=summaries.flatMap(r=>r.daily.map(d=>({...d,name:r.name})));
    $("rangeResult").innerHTML=`<p class="range-summary">${fromDate} ~ ${toDate} · 근무 / Làm <strong>${hours(summaries.reduce((n,r)=>n+r.minutes,0))}</strong> · 실제 지급 / Thực trả <strong>${money(selectedPayments.filter(p=>!reversed.has(p.id)).reduce((n,p)=>n+Number(p.amount),0))} VND</strong></p><div class="table-scroll"><table><thead><tr><th>직원 / Nhân viên</th><th>근무일 / Ngày</th><th>출근 / Vào</th><th>퇴근 / Ra</th><th>근무 / Giờ</th><th>확인 / Kiểm tra</th></tr></thead><tbody>${daily.map(d=>`<tr><td>${esc(d.name)}</td><td>${esc(d.date)}</td><td>${esc(d.checkIn?.slice(11,16)||"—")}</td><td>${esc(d.checkOut?.slice(5,16)||"—")}</td><td>${hours(d.minutes)}</td><td>${esc(d.issues.join(" · "))}</td></tr>`).join("")||'<tr><td colspan="6">기록 없음 / Không có dữ liệu</td></tr>'}</tbody></table></div>`;
    $("rangeExport").disabled=false;
    await renderReceiptRange(rangeData);
    if(summaries.some(r=>r.rangeRoundingMinutes))$("rangeResult").insertAdjacentHTML("beforeend",'<p class="muted">월 합산 직원은 조회기간 내 실제 초를 직원·월별로 합친 후 분으로 환산합니다. 일별 표시분 합계와 차이가 날 수 있습니다. / Cộng giây thực tế theo nhân viên và tháng rồi lấy phút; tổng có thể khác phút từng ngày.</p>');
  }
  function renderMonthlyDraft(values) {
    if($("paymentTotals"))$("paymentTotals").innerHTML=paymentBalanceHtml(values.total,app.paidForEmployee(values.row.employee_id),false);
    if(values.row.settlementMode!=="monthly_net")return;
    const rate=document.querySelector('[data-testid="month-hourly-rate"]'),extra=document.querySelector('[data-testid="month-extra-amount"]');
    if(rate)rate.textContent=hourlyMoney(values.monthlyExtraHourlyRate)+" VND";
    if(extra)extra.textContent=money(values.monthlyExtraAmount)+" VND";
  }
  function reviewSnapshot(values) {
    const snapshot={...values.row,adjustmentNote:values.note,calculationVersion:3,reviewedAmounts:{baseAmount:values.baseAmount,statutoryAmount:values.statutoryAmount,monthlyExtraAmount:values.monthlyExtraAmount,allowances:values.allowances,deductions:values.deductions,total:values.total}};
    if(values.row.settlementMode==="monthly_net"){snapshot.baseAmount=values.baseAmount;snapshot.monthlyExtraAmount=values.monthlyExtraAmount;snapshot.monthlyExtraHourlyRate=values.monthlyExtraHourlyRate;snapshot.monthlyExtraBasisAmount=values.monthlyExtraBasisAmount;snapshot.monthlyExtraBasisMinutes=values.monthlyExtraBasisMinutes;snapshot.monthlyExtraRateSource=!values.manual&&snapshot.monthlyProration?.applied?"full_month_salary_divided_by_full_calendar_hours":"base_salary_divided_by_planned_hours";snapshot.wageBreakdown=[{code:"monthly_base",label:snapshot.monthlyProration?.applied?"입사월 비례 기본급 (시간 부족 공제 없음) / Lương tháng đầu theo tỷ lệ (không trừ giờ thiếu)":"약정 월급 (시간 부족 공제 없음) / Lương tháng (không trừ giờ thiếu)",category:"base",minutes:snapshot.monthlyPlannedMinutes,rate:0,multiplier:1,rawAmount:values.baseAmount,amount:values.baseAmount},{code:"monthly_net_extra",label:"월 순초과시간 추가급여 / Tiền giờ vượt ròng trong tháng",category:"monthly_extra",minutes:snapshot.monthlyExtraMinutes,rate:values.monthlyExtraHourlyRate,multiplier:1,rawAmount:values.monthlyExtraBasisAmount*snapshot.monthlyExtraMinutes/values.monthlyExtraBasisMinutes,amount:values.monthlyExtraAmount}];}
    if(values.manual){snapshot.originalUnresolved=values.row.unresolved;snapshot.unresolved=0;snapshot.reviewedBase={amount:values.baseAmount,reason:values.reviewedReason};}
    return snapshot;
  }
  async function previewTax() {
    clearTaxPreview();
    const generation=taxPreviewGeneration,scope=taxScope(),kind=$("exportKind").value,input=taxInput({kind,employeeId:$("employeeFilter").value||undefined});
    if(kind==="tax"){
      const employees=DGV_PAYROLL_TAX.summarizePayroll(input).rows;
      const before=Number((await result(db.from("payroll_revision").select("version").eq("id",1).single())).version);
      if(before!==state.revision)throw new Error("자료가 변경되었습니다. 새로고침해 주세요. / Dữ liệu đã đổi; tải lại.");
      const identities=await Promise.all(employees.map(async row=>{
        const data=await result(db.rpc("payroll_get_sensitive",{p_employee_id:row.employee_id}));
        return {employee_id:row.employee_id,national_id:data?.national_id||"",tax_id:data?.tax_id||""};
      }));
      const after=Number((await result(db.from("payroll_revision").select("version").eq("id",1).single())).version);
      if(!state.loaded||generation!==taxPreviewGeneration||scope!==taxScope())return;
      if(before!==after)throw new Error("자료가 변경되었습니다. 새로고침해 주세요. / Dữ liệu đã đổi; tải lại.");
      input.identities=identities;taxIdentityPreview={scope,identities};
    }
    if(!state.loaded||generation!==taxPreviewGeneration||scope!==taxScope())return;
    const model=DGV_PAYROLL_TAX.summarizePayroll(input),missing=kind==="tax"?model.warnings.filter(w=>w.code==="MISSING_NATIONAL_ID"):[];
    $("taxPreview").hidden=false;
    $("taxPreview").innerHTML=`<p><strong>${esc($("month").value)} · ${esc($("exportKind").selectedOptions[0].textContent)}</strong></p><p>직원 / Nhân viên ${model.rows.length} · 확정급여 / Lương ${money(model.totals.approved)} · 지급 / Đã trả ${money(model.totals.paid)} · 미지급 / Còn lại ${money(model.totals.outstanding)} VND</p>${kind==="tax"?`<p class="notice ${missing.length?"error":""}">신분증 번호 / Số định danh: ${model.rows.length-missing.length}/${model.rows.length}명 등록. ${missing.length?"직원 정보에서 미등록 번호를 입력한 뒤 다시 확인하세요. / Bổ sung số định danh trong thông tin nhân viên.":"세무 제출용 파일·인쇄에는 신분증 번호 전체가 포함됩니다. / Tệp và bản in thuế có đầy đủ số định danh."}</p>`:""}${model.warnings.length?`<details open><summary>검토 사항 / Cần kiểm tra (${model.warnings.length})</summary><ul class="issue-list">${model.warnings.map(w=>`<li>${esc(w.name)}: ${esc(w.message)}</li>`).join("")}</ul></details>`:'<p class="muted">기록된 검토 경고 없음 / Không có cảnh báo.</p>'}<label class="check"><input id="taxReviewed" type="checkbox" ${missing.length?"disabled":""} /> 대상 월·직원·검토 사항${kind==="tax"?"과 신분증 번호 포함":""}을 확인했습니다. / Đã kiểm tra kỳ, nhân viên${kind==="tax"?" và việc đưa số định danh vào báo cáo":""}.</label><div class="actions"><button id="downloadTax" disabled>Excel 다운로드 / Tải Excel</button><button id="printTax" class="quiet" disabled>인쇄 · PDF / In · PDF</button><button id="closeTaxPreview" class="quiet">닫기 / Đóng</button></div>`;
  }
  let receiptPreview=null,receiptGeneration=0,receiptPrintWindow=null;
  const receiptScope=()=>JSON.stringify([$("rangeFrom").value,$("rangeTo").value,$("rangeEmployee").value]);
  function clearReceiptPreview(){receiptPreview=null;receiptGeneration++;receiptPrintWindow?.close();receiptPrintWindow=null;$("rangeReceiptPrint").disabled=true;$("rangeReceipts").replaceChildren();}
  async function signatureImage(file) {
    if(file.mime_type!=="image/png"||file.storage_path.split("/")[0]!==file.payment_id)throw new Error("Invalid signature reference");
    const blob=await result(db.storage.from("payroll-evidence").download(file.storage_path));
    if(!blob||blob.size!==Number(file.byte_size)||blob.size>5242880)throw new Error("Invalid signature size");
    const bytes=new Uint8Array(await blob.arrayBuffer());
    if(Array.from(bytes.slice(0,8)).join()!=="137,80,78,71,13,10,26,10")throw new Error("Invalid signature PNG");
    const dataUrl=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error("Signature read failed"));reader.readAsDataURL(new Blob([bytes],{type:"image/png"}));});
    const image=new Image();image.src=dataUrl;await image.decode();
    if(!image.naturalWidth||!image.naturalHeight)throw new Error("Invalid signature image");
    return {paymentId:file.payment_id,storagePath:file.storage_path,dataUrl};
  }
  async function renderReceiptRange(input) {
    const generation=receiptGeneration,scope=receiptScope(),images=Object.create(null);
    const model=DGV_PAYROLL_RECEIPTS.buildModel(input),paymentIds=new Set(model.rows.map(row=>row.paymentId));
    const files=input.attachments.filter(file=>file.evidence_type==="signature"&&paymentIds.has(file.payment_id));
    $("rangeReceipts").textContent="지급내역·서명을 불러오는 중 / Đang tải thanh toán và chữ ký…";
    // Bound memory and network concurrency on older tablets. Images remain in
    // memory only, and authenticated Storage downloads never expose public URLs.
    let next=0,totalBytes=0;
    await Promise.all(Array.from({length:Math.min(3,files.length)},async()=>{
      while(next<files.length){
        const file=files[next++];totalBytes+=Number(file.byte_size)||0;
        if(totalBytes>40*1024*1024)continue;
        try{images[file.id]=await signatureImage(file);}catch{ /* Missing images block printing below. */ }
        if(generation!==receiptGeneration)return;
      }
    }));
    if(!state.loaded||generation!==receiptGeneration||scope!==receiptScope())return;
    const finalModel=DGV_PAYROLL_RECEIPTS.buildModel({...input,signatureImages:images});
    receiptPreview={model:finalModel,scope,revision:input.revision,generation};
    $("rangeReceipts").innerHTML=DGV_PAYROLL_RECEIPTS.buildTableHtml(finalModel);
    for(const row of finalModel.rows.filter(row=>row.status==="paid"&&row.signatureStatus==="unsigned")){
      const cell=Array.from($("rangeReceipts").querySelectorAll("tr[data-payment-id]")).find(tr=>tr.dataset.paymentId===row.paymentId)?.lastElementChild;
      if(cell)cell.insertAdjacentHTML("beforeend",`<button class="quiet" data-signature="${esc(row.paymentId)}">서명 받기 / Nhận chữ ký</button>`);
    }
    const missing=finalModel.rows.some(row=>row.signatures.some(signature=>signature.imageStatus!=="loaded"));
    if(missing)$("rangeReceipts").insertAdjacentHTML("afterbegin",'<p class="notice error">저장된 서명을 일부 불러오지 못했습니다. 연결을 확인하고 다시 조회하거나 기간을 줄여 주세요. 서명이 누락된 상태에서는 출력할 수 없습니다. / Không tải đủ chữ ký. Kiểm tra kết nối, tra cứu lại hoặc chọn kỳ ngắn hơn trước khi in.</p>');
    $("rangeReceiptPrint").disabled=missing||!finalModel.rows.length;
  }
  $("rangeReceiptPrint").addEventListener("click",()=>{
    if(state.busy||!receiptPreview)return;
    const captured=receiptPreview,popup=window.open("about:blank","_blank");
    receiptPrintWindow=popup;
    task(async()=>{try{
      if(!popup)throw new Error("팝업을 허용해 주세요. / Cho phép cửa sổ bật lên.");
      const current=Number((await result(db.from("payroll_revision").select("version").eq("id",1).single())).version);
      if(!state.loaded||captured!==receiptPreview||captured.scope!==receiptScope()||current!==captured.revision){clearReceiptPreview();throw new Error("지급내역이 변경되었습니다. 기간 조회를 다시 해 주세요. / Thanh toán đã đổi; tra cứu lại trước khi in.");}
      popup.document.open();popup.document.write(DGV_PAYROLL_RECEIPTS.buildPrintHtml(captured.model));popup.document.close();popup.opener=null;
      await Promise.all(Array.from(popup.document.images,image=>image.decode()));
      await popup.document.fonts?.ready;
      if(!state.loaded||$("payrollApp").hidden||captured!==receiptPreview||captured.scope!==receiptScope())throw new Error("조회 상태가 변경되었습니다. 다시 조회해 주세요. / Phiên xem đã thay đổi; tra cứu lại.");
      if(!popup.closed){popup.focus();popup.print();}
    }catch(error){popup?.close();throw error;}finally{if(receiptPrintWindow===popup)receiptPrintWindow=null;}});
  });
  let evidenceDraft=null;
  function openEvidence(paymentId,kind,fallback) {
    requireLoaded();
    const payment=state.payments.find(p=>p.id===paymentId)||rangeData?.payments.find(p=>p.id===paymentId)||fallback?.payment;
    const run=[...state.runs,...(rangeData?.runs||[])].find(r=>r.id===payment?.run_id||(payment?.employee_id===r.employee_id&&payment?.payroll_month===r.month))||fallback?.run;
    const employee=state.employees.find(e=>e.id===(payment?.employee_id||run?.employee_id))||fallback?.employee;
    if(!payment||!employee||!(payment.payroll_month||run?.month))throw new Error("지급내역을 다시 조회해 주세요. / Tra cứu lại thanh toán.");
    if((state.reversals||[]).some(r=>r.payment_id===paymentId)||(rangeData?.reversals||[]).some(r=>r.payment_id===paymentId))throw new Error("취소된 지급에는 서명할 수 없습니다. / Không ký thanh toán đã hủy.");
    evidencePayment=paymentId;evidenceDraft=null;
    const form=$("evidenceForm");form.reset();
    field(form,"evidence_type").value=kind||(payment.method==="bank"?"bank_transfer":"receipt");
    field(form,"signed_name").value=employee.name;
    const signature=kind==="signature";
    $("evidenceTitle").textContent=signature?"급여 수령 서명 / Ký nhận lương":"지급 증빙 / Chứng từ thanh toán";
    $("evidencePaymentSummary").dataset.paymentId=paymentId;
    $("evidencePaymentSummary").innerHTML=`<strong>${esc(employee.name)}</strong><p>${esc(payment.paid_on)} · ${payment.method==="cash"?"현금 / Tiền mặt":"이체 / Chuyển khoản"}<br /><strong>${money(payment.amount)} VND</strong><br />급여월 / Tháng lương ${esc((payment.payroll_month||run.month).slice(0,7))}</p>`;
    $("signatureArea").hidden=!signature;$("evidenceFileLabel").hidden=signature;
    clearSignature();openDialog("evidenceDialog");
  }
  async function uploadImmutable(path,bytes,mime){
    try{return await result(db.storage.from("payroll-evidence").upload(path,new Blob([bytes],{type:mime}),{contentType:mime,upsert:false}));}
    catch(error){
      // A lost successful upload response is safe to retry only if the immutable object is identical.
      const existing=await db.storage.from("payroll-evidence").download(path);
      if(existing.error||!existing.data||existing.data.size!==bytes.length)throw error;
      const old=new Uint8Array(await existing.data.arrayBuffer());
      if(!old.every((value,index)=>value===bytes[index]))throw error;
      return {path};
    }
  }
  async function submitEvidence() {
    const form=$("evidenceForm"),kind=field(form,"evidence_type").value,isSignature=kind==="signature";
    const paymentId=evidencePayment;
    if(!paymentId)throw new Error("지급내역을 다시 선택해 주세요. / Chọn lại thanh toán.");
    const reversals=await rows("payroll_payment_reversals",q=>q.eq("payment_id",paymentId));
    if(reversals.length)throw new Error("취소된 지급에는 서명할 수 없습니다. / Không ký thanh toán đã hủy.");
    let file=field(form,"file").files[0],signedName=null,ack=null;
    if(isSignature){
      signedName=field(form,"signed_name").value.trim();
      if(!signatureDrawn||!signedName||!field(form,"acknowledged").checked)throw new Error("수령인·서명·수령확인을 입력하세요. / Nhập tên, ký và xác nhận nhận lương.");
      const blob=await new Promise(resolve=>$("signatureCanvas").toBlob(resolve,"image/png"));
      if(!blob)throw new Error("서명 이미지를 만들지 못했습니다. 다시 시도해 주세요. / Không tạo được ảnh chữ ký; thử lại.");
      file=new File([blob],"signature.png",{type:"image/png"});ack=new Date().toISOString();
    }
    if(!file||file.size<1||file.size>5242880)throw new Error("5 MB 이하 증빙을 선택하세요. / Chọn chứng từ tối đa 5 MB.");
    const bytes=new Uint8Array(await file.arrayBuffer()),prefix=Array.from(bytes.slice(0,12));
    const mime=prefix.slice(0,4).join()==="37,80,68,70"?"application/pdf":prefix.slice(0,8).join()==="137,80,78,71,13,10,26,10"?"image/png":prefix[0]===255&&prefix[1]===216&&prefix[2]===255?"image/jpeg":String.fromCharCode(...bytes.slice(0,4))==="RIFF"&&String.fromCharCode(...bytes.slice(8,12))==="WEBP"?"image/webp":null;
    if(!mime||isSignature&&mime!=="image/png")throw new Error("PDF·PNG·JPEG·WebP 파일만 가능합니다. / Chỉ PDF, PNG, JPEG, WebP.");
    const digest=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))).map(x=>x.toString(16).padStart(2,"0")).join("");
    const fingerprint=[paymentId,kind,digest,signedName].join("|");
    if(evidenceDraft?.fingerprint!==fingerprint)evidenceDraft={fingerprint,id:crypto.randomUUID(),path:`${paymentId}/${crypto.randomUUID()}.${{"application/pdf":"pdf","image/png":"png","image/jpeg":"jpg","image/webp":"webp"}[mime]}`,uploaded:false,ack};
    const draft=evidenceDraft;
    if(!draft.uploaded){await uploadImmutable(draft.path,bytes,mime);draft.uploaded=true;}
    const existing=await result(db.from("payroll_attachments").select("id").eq("id",draft.id));
    if(!existing.length)await result(db.from("payroll_attachments").insert({id:draft.id,payment_id:paymentId,storage_path:draft.path,filename:file.name.slice(0,200),mime_type:mime,byte_size:file.size,evidence_type:kind,signed_name:signedName,acknowledged_at:draft.ack}));
    evidenceDraft=null;$("evidenceDialog").close();
    try{await load();}catch(error){if(error.message==="AUTH_REQUIRED")throw error;throw new Error("증빙·서명은 저장되었습니다. 목록은 새로고침해 주세요. / Đã lưu chứng từ, chữ ký. Vui lòng tải lại danh sách.");}
    notice(isSignature?"이 지급 건의 수령 서명을 저장했습니다. / Đã lưu chữ ký cho lần thanh toán này.":"지급 증빙을 저장했습니다. / Đã lưu chứng từ.");
  }
  function clearSignature(){const canvas=$("signatureCanvas"),ctx=canvas.getContext("2d");ctx.fillStyle="white";ctx.fillRect(0,0,canvas.width,canvas.height);signatureDrawn=false;drawing=null;strokeLength=0;}
  const canvas=$("signatureCanvas"),ctx=canvas.getContext("2d");let drawing=null,lastPoint=null,strokeLength=0;
  const point=event=>{const r=canvas.getBoundingClientRect();return [Math.max(0,Math.min(canvas.width,(event.clientX-r.left)*canvas.width/r.width)),Math.max(0,Math.min(canvas.height,(event.clientY-r.top)*canvas.height/r.height))];};
  canvas.addEventListener("pointerdown",event=>{if(state.busy||drawing!==null||event.button>0)return;drawing=event.pointerId;canvas.setPointerCapture(event.pointerId);lastPoint=point(event);ctx.beginPath();ctx.moveTo(...lastPoint);ctx.strokeStyle="#20392c";ctx.lineWidth=5;ctx.lineCap="round";ctx.lineJoin="round";event.preventDefault();});
  canvas.addEventListener("pointermove",event=>{if(state.busy||drawing!==event.pointerId)return;const next=point(event);strokeLength+=Math.hypot(next[0]-lastPoint[0],next[1]-lastPoint[1]);ctx.lineTo(...next);ctx.stroke();lastPoint=next;signatureDrawn=strokeLength>10;event.preventDefault();});
  for(const event of ["pointerup","pointercancel","lostpointercapture"])canvas.addEventListener(event,()=>{drawing=null;});
  $("clearSignature").addEventListener("click",()=>{if(!state.busy)clearSignature();});
  $("evidenceDialog").addEventListener("cancel",event=>{if(state.busy)event.preventDefault();});
  $("evidenceDialog").addEventListener("close",()=>{evidencePayment=null;evidenceDraft=null;$("evidenceForm").reset();$("evidencePaymentSummary").replaceChildren();clearSignature();});
  field($("evidenceForm"),"evidence_type").addEventListener("change",()=>{const signature=field($("evidenceForm"),"evidence_type").value==="signature";$("signatureArea").hidden=!signature;$("evidenceFileLabel").hidden=signature;});
  dialog("auditDialog",'<h2>변경 이력 / Lịch sử thay đổi</h2><div id="auditRows"></div><button type="button" data-close>닫기 / Đóng</button>');
  async function showAudit(){
    const entries=await rows("payroll_audit"),employee=state.selected;
    const employeeRuns=(state.historyRuns||[]).filter(d=>d.employee_id===employee).map(d=>d.id),employeePayments=(state.historyPayments||[]).filter(d=>d.employee_id===employee||employeeRuns.includes(d.run_id)).map(d=>d.id);
    const related=new Set([employee,...state.days.filter(d=>d.employee_id===employee).map(d=>d.id),...state.terms.filter(d=>d.employee_id===employee).map(d=>d.id),...employeeRuns,...employeePayments,...(state.adjustments||[]).filter(d=>employeeRuns.includes(d.run_id)).map(d=>d.id),...(state.reversals||[]).filter(d=>employeePayments.includes(d.payment_id)).map(d=>d.id),...(state.attachments||[]).filter(d=>employeePayments.includes(d.payment_id)).map(d=>d.id)]);
    const all=entries.filter(e=>related.has(String(e.record_id))||e.before_data?.employee_id===employee||e.after_data?.employee_id===employee||e.new_data?.employee_id===employee||e.old_data?.employee_id===employee).sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)));
    $("auditRows").innerHTML=all.map(e=>`<article class="payment-card"><strong>${esc(e.table_name)} · ${esc(e.action||e.operation||"")}</strong><p>${esc(e.created_at)} · ${esc(e.created_by||e.actor_id||"")}</p><p>${esc(e.reason||e.after_data?.reason||e.new_data?.reason||"")}</p><details><summary>변경 전·후 / Trước &amp; sau</summary><pre>${esc(JSON.stringify({before:e.before_data||e.old_data,after:e.after_data||e.new_data},null,2))}</pre></details></article>`).join("")||'<p>이력 없음 / Chưa có lịch sử</p>';openDialog("auditDialog");
  }
  function downloadBlob(blob,filename){const url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  async function archiveSubmit(){
    const form=$("archiveForm"),password=field(form,"password").value;
    if(form.dataset.mode==="backup"){
      const database=await result(db.rpc("payroll_backup")),evidence=[];let size=0;
      for(const attachment of database.tables.payroll_attachments||[]){
        const blob=await result(db.storage.from("payroll-evidence").download(attachment.storage_path));size+=blob.size;
        if(size>50*1024*1024)throw new Error("첨부가 50 MB를 초과합니다. 관리자에게 분할 백업을 요청하세요. / Chứng từ vượt 50 MB; cần chia bản sao lưu.");
        evidence.push({path:attachment.storage_path,mime:attachment.mime_type,dataBase64:DGV_PAYROLL_ARCHIVE.base64(new Uint8Array(await blob.arrayBuffer()))});
      }
      const encrypted=await DGV_PAYROLL_ARCHIVE.encrypt({database,evidence},password);
      downloadBlob(new Blob([JSON.stringify(encrypted)],{type:"application/octet-stream"}),`HANA_payroll_${today()}.payroll`);
      $("archiveDialog").close();notice("암호화 백업을 내려받았습니다. 비밀번호를 별도로 보관하세요. / Đã tải sao lưu mã hóa; giữ mật khẩu riêng.");
    }else{
      const file=field(form,"archive_file").files[0];if(!file||file.size>115*1024*1024)throw new Error("유효한 .payroll 파일을 선택하세요. / Chọn bản sao lưu hợp lệ.");
      const payload=await DGV_PAYROLL_ARCHIVE.decrypt(JSON.parse(await file.text()),password);
      if(!payload.database||!Array.isArray(payload.evidence))throw new Error("백업 내용이 올바르지 않습니다. / Nội dung sao lưu không hợp lệ.");
      const attachments=payload.database.tables?.payroll_attachments||[],byPath=new Map(payload.evidence.map(e=>[e.path,e]));
      if(byPath.size!==payload.evidence.length||attachments.length!==payload.evidence.length)throw new Error("증빙 목록이 일치하지 않습니다. / Chứng từ không khớp.");
      // Validate every attachment before committing database rows. AES-GCM authenticates the envelope.
      for(const meta of attachments){const file=byPath.get(meta.storage_path);if(!file||file.mime!==meta.mime_type||DGV_PAYROLL_ARCHIVE.unbase64(file.dataBase64).length!==meta.byte_size)throw new Error("증빙이 손상되었습니다. / Chứng từ bị hỏng.");}
      const restored=await result(db.rpc("payroll_restore",{p_payload:payload.database})),failed=[];
      for(const meta of restored.missing_evidence||[]){try{const file=byPath.get(meta.storage_path);await uploadImmutable(meta.storage_path,DGV_PAYROLL_ARCHIVE.unbase64(file.dataBase64),file.mime);}catch{failed.push(meta.storage_path);}}
      await load();
      if(failed.length)throw new Error(`급여 기록은 복구되었고 증빙 ${failed.length}개가 남았습니다. 같은 백업으로 다시 복구하면 누락된 첨부만 재시도합니다. / Đã khôi phục dữ liệu; còn ${failed.length} tệp. Thử lại cùng bản sao lưu.`);
      $("archiveDialog").close();notice("급여자료와 증빙을 복구했습니다. / Đã khôi phục dữ liệu lương và chứng từ.");
    }
    form.reset();
  }
  $("rangeSearch").addEventListener("click",()=>task(searchRange));
  $("rangeExport").addEventListener("click",()=>task(()=>{if(!rangeData)throw new Error("먼저 조회하세요. / Tra cứu trước.");const sheets=[...DGV_PAYROLL_TAX.buildPayrollWorkbook({...rangeData,kind:"attendance"}).sheets,...DGV_PAYROLL_TAX.buildPayrollWorkbook({...rangeData,kind:"cash"}).sheets,...DGV_PAYROLL_TAX.buildPayrollWorkbook({...rangeData,kind:"bank"}).sheets];DGV_XLSX.downloadWorkbook({filename:`HANA_payroll_${rangeData.fromDate}_${rangeData.toDate}.xlsx`,sheets});}));
  for(const id of ["rangeFrom","rangeTo","rangeEmployee"])$(id).addEventListener("change",()=>{rangeData=null;clearReceiptPreview();$("rangeExport").disabled=true;$("rangeResult").textContent="기간·직원이 변경되었습니다. 다시 조회하세요. / Hãy tra cứu lại.";});
  $("previewTax").addEventListener("click",()=>task(previewTax));
  $("exportKind").addEventListener("change",clearTaxPreview);
  $("taxPreview").addEventListener("change",()=>{const checked=$("taxReviewed").checked;$("downloadTax").disabled=!checked;$("printTax").disabled=!checked;});
  document.addEventListener("click",event=>{
    const button=event.target.closest("button");if(!button||state.busy)return;
    if(button.id==="sensitiveInfo")task(async()=>{const generation=++sensitiveGeneration,employeeId=state.selected;const data=await result(db.rpc("payroll_get_sensitive",{p_employee_id:employeeId}));if(!state.loaded||generation!==sensitiveGeneration||employeeId!==state.selected)return;$("sensitiveForm").reset();$("sensitiveForm").dataset.employeeId=employeeId;$("sensitiveForm").dataset.revision=String(state.revision);for(const name of ["bank_name","bank_account","account_holder","national_id","tax_id"])field($("sensitiveForm"),name).value=data?.[name]||"";openDialog("sensitiveDialog");});
    if(button.id==="monthSchedule"){const term=termForMonth(state.selected),net=term?.pay_type==="monthly"&&term?.monthly_settlement==="monthly_net",rule=(state.rules||[]).filter(r=>r.effective_from<=$("month").value+"-01").sort((a,b)=>a.effective_from.localeCompare(b.effective_from)).at(-1)||initialRules;document.querySelectorAll('#scheduleForm input[name="rest"]').forEach(input=>{input.type=net?"radio":"checkbox";input.checked=net?Number(input.value)===Number(term.weekly_rest_day??0):rule.default_weekly_rest_days.includes(Number(input.value));});$("scheduleForm").dataset.monthlyNet=String(net);$("scheduleForm").querySelector("p").textContent=net?"주 1회 휴무를 선택하세요. 이 달의 기존 날짜별 지정은 보존합니다. / Chọn một ngày nghỉ mỗi tuần; giữ nguyên ngày đã đặt trong tháng.":"기존에 지정한 날짜는 보존하고 빈 날짜만 채웁니다. / Giữ nguyên ngày đã đặt.";openDialog("scheduleDialog");}
    if(button.id==="viewAudit")task(showAudit);
    if(button.id==="saveReview")task(async()=>{const values={...app.draft(),revision:state.revision,month:$("month").value};await recordReview(values,reviewSnapshot(values));await load();notice("관리자 검토를 기록했습니다. / Đã lưu duyệt của quản trị.");});
    if(button.id==="newRule"){const form=$("ruleForm"),rule=(state.rules||[]).slice().sort((a,b)=>b.effective_from.localeCompare(a.effective_from))[0]||initialRules;form.reset();for(const name of [...Object.keys(ruleLabels),"night_start","night_end","monthly_proration","monthly_hour_basis"])field(form,name).value=rule[name]??"";field(form,"ot_enabled").checked=!!rule.ot_enabled;field(form,"effective_from").value=today();openDialog("ruleDialog");}
    if(button.id==="fillCandidates"){const form=$("dayForm"),day=app.selected()?.daily.find(d=>d.date===field(form,"work_date").value);if(!day)return;field(form,"overtime_intervals").value=formatIntervals(day.overtimeCandidates);field(form,"night_intervals").value=formatIntervals(day.nightCandidates);field(form,"overtime_approved").checked=!!day.overtimeCandidates?.length;field(form,"night_approved").checked=!!day.nightCandidates?.length;}
    if(button.id==="adjustRun"||button.dataset.reverse){const form=$("amendForm");form.reset();form.dataset.action=button.dataset.reverse?"reverse":"adjust";form.dataset.target=button.dataset.reverse||app.runFor(state.selected).id;$("amendTitle").textContent=button.dataset.reverse?"지급 기록 취소 / Hoàn tác thanh toán":"확정급여 정정 / Điều chỉnh lương";$("amendAmountLabel").hidden=!!button.dataset.reverse;field(form,"amount").required=!button.dataset.reverse;actionRequest=crypto.randomUUID();openDialog("amendDialog");}
    if(button.dataset.evidence)openEvidence(button.dataset.evidence);
    if(button.dataset.signature)openEvidence(button.dataset.signature,"signature");
    if(button.dataset.file){const popup=window.open("about:blank","_blank");task(async()=>{try{const file=state.attachments.find(f=>f.id===button.dataset.file),signed=await result(db.storage.from("payroll-evidence").createSignedUrl(file.storage_path,60));if(popup){popup.opener=null;popup.location.replace(signed.signedUrl);}else throw new Error("팝업을 허용하고 다시 여세요. / Cho phép cửa sổ bật lên.");}catch(error){popup?.close();throw error;}});}
    if(button.id==="closeTaxPreview")clearTaxPreview();
    if(button.id==="downloadTax")task(()=>{if(!$("taxReviewed").checked)throw new Error("자료 확인이 필요합니다. / Xác nhận kiểm tra.");return exportWorkbook($("exportKind").value);});
    if(button.id==="printTax"){
      if(!$("taxReviewed").checked)return;const popup=window.open("about:blank","_blank");
      task(async()=>{try{if(!popup)throw new Error("팝업을 허용해 주세요. / Cho phép cửa sổ bật lên.");const html=DGV_PAYROLL_TAX.buildPayrollPrintHtml(await verifiedReportInput($("exportKind").value));popup.document.open();popup.document.write(html);popup.document.close();popup.opener=null;popup.focus();setTimeout(()=>{if(!popup.closed)popup.print();},250);}catch(error){popup?.close();throw error;}});
    }
    if(button.id==="openBackup"||button.id==="openRestore"){const form=$("archiveForm"),restore=button.id==="openRestore";form.reset();form.dataset.mode=restore?"restore":"backup";$("archiveTitle").textContent=restore?"암호화 백업 복구 / Khôi phục":"암호화 백업 / Sao lưu";$("archiveFileLabel").hidden=!restore;field(form,"archive_file").required=restore;$("archiveInfo").textContent=restore?"빈 급여 DB에만 복구하며 다른 업무자료는 변경하지 않습니다. / Chỉ khôi phục vào dữ liệu lương trống.":"직원·근무·급여·민감정보·증빙을 암호화합니다. 비밀번호 분실 시 복구할 수 없습니다. / Mã hóa nhân viên, lương, thông tin riêng và chứng từ. Không thể mở khi mất mật khẩu.";openDialog("archiveDialog");}
  });
  $("sensitiveForm").addEventListener("submit",event=>{event.preventDefault();task(async()=>{const form=$("sensitiveForm"),data=Object.fromEntries(["bank_name","bank_account","account_holder","national_id","tax_id"].map(name=>[name,field(form,name).value.trim()]));await result(db.rpc("payroll_set_sensitive",{p_employee_id:form.dataset.employeeId,p_data:data,p_reason:field(form,"reason").value.trim(),p_expected_revision:Number(form.dataset.revision)}));$("sensitiveDialog").close();await load();notice("민감정보를 암호화하여 저장했습니다. / Đã lưu thông tin mã hóa.");});});
  $("sensitiveDialog").addEventListener("close",()=>{sensitiveGeneration++;$("sensitiveForm").reset();delete $("sensitiveForm").dataset.employeeId;delete $("sensitiveForm").dataset.revision;});
  $("archiveDialog").addEventListener("close",()=>$("archiveForm").reset());
  $("scheduleForm").addEventListener("submit",event=>{event.preventDefault();task(async()=>{const restDays=[...document.querySelectorAll('#scheduleForm input[name="rest"]:checked')].map(i=>Number(i.value));if($("scheduleForm").dataset.monthlyNet==="true"&&restDays.length!==1)throw new Error("주 1회 휴무 요일을 선택하세요. / Chọn một ngày nghỉ mỗi tuần.");const existing=new Set(state.days.filter(d=>d.employee_id===state.selected).map(d=>d.work_date));const created=DGV_PAYROLL_RULES.createMonthSchedule({month:$("month").value,employee:state.employees.find(e=>e.id===state.selected),terms:state.terms,weeklyRestDays:restDays,existingDays:state.days}).filter(d=>!existing.has(d.work_date)).map(d=>({...d,reason:field($("scheduleForm"),"reason").value.trim()}));if(created.length)await result(db.from("payroll_days").upsert(created,{onConflict:"employee_id,work_date",ignoreDuplicates:true}));$("scheduleDialog").close();await load();notice(`근무표 ${created.length}일 추가 / Đã thêm ${created.length} ngày.`);});});
  $("ruleForm").addEventListener("submit",event=>{event.preventDefault();task(async()=>{const form=$("ruleForm"),values=Object.fromEntries(new FormData(form));values.ot_enabled=field(form,"ot_enabled").checked;for(const name of Object.keys(ruleLabels))values[name]=values[name]===""?null:Number(values[name]);values.default_weekly_rest_days=[0];const errors=DGV_PAYROLL_RULES.validateRule(values);if(errors.length)throw new Error(errors.join("\n"));await result(db.from("payroll_rule_versions").insert(values));$("ruleDialog").close();await load();notice("새 적용일의 급여 규칙을 저장했습니다. / Đã lưu phiên bản quy tắc.");});});
  $("amendForm").addEventListener("submit",event=>{event.preventDefault();task(async()=>{const form=$("amendForm"),reason=field(form,"reason").value.trim();if(form.dataset.action==="reverse")await result(db.rpc("payroll_reverse_payment",{p_payment_id:form.dataset.target,p_reason:reason,p_request_id:actionRequest}));else await result(db.rpc("payroll_adjust_run",{p_run_id:form.dataset.target,p_amount:amount(field(form,"amount").value),p_reason:reason,p_request_id:actionRequest}));$("amendDialog").close();await load();notice("정정 이력을 저장했습니다. / Đã lưu lịch sử điều chỉnh.");});});
  $("evidenceForm").addEventListener("submit",event=>{event.preventDefault();task(async()=>{const controls=Array.from($("evidenceForm").querySelectorAll("input,select,button"));controls.forEach(control=>control.disabled=true);try{await submitEvidence();}finally{controls.forEach(control=>control.disabled=false);}});});
  $("archiveForm").addEventListener("submit",event=>{event.preventDefault();task(archiveSubmit);});
  window.DGV_PAYROLL_ADVANCED={load:loadExtra,render,renderDetail,employeeEdit,employeeValues,termsEdit,termsValues,dayEdit,dayValues,recordReview,reviewSnapshot,renderMonthlyDraft,exportWorkbook,invalidate,openEvidence};
})();
