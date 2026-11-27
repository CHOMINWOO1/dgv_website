(function(root){
  'use strict';
  const dayMs=86400000, date=value=>new Date(value).toISOString().slice(0,10);
  const priorDay=value=>date(Date.parse(value+'T00:00:00Z')-dayMs);
  const latest=(rows,value)=>rows.filter(row=>row.effective_from<=value).sort((a,b)=>a.effective_from.localeCompare(b.effective_from)).at(-1);
  function typeAt(employee,changes,value){return latest(changes,value)?.employment_type||changes.find(change=>change.effective_from>value)?.prior_employment_type||employee.employment_type;}
  function historicalEmployees(employees,changes,month){return employees.map(employee=>({...employee,employment_type:typeAt(employee,changes.filter(c=>c.employee_id===employee.id).sort((a,b)=>a.effective_from.localeCompare(b.effective_from)),month+'-01')}));}
  // Display only: the original month totals remain the source for payroll,
  // saved calculations and exports. Sum the already-rounded daily minutes so
  // the displayed period agrees exactly with its attendance rows.
  function summarizeCurrentAttendance({month,today,employee,changes,daily}){
    const first=month+'-01',end=date(Date.UTC(+month.slice(0,4),+month.slice(5,7),1)),last=priorDay(end),asOf=today<last?today:last;
    const current=latest(changes,asOf);
    if(!current||current.effective_from<first||current.effective_from>=end)return null;
    const start=employee.hire_date&&employee.hire_date>first?employee.hire_date:first;
    const from=current.effective_from>start?current.effective_from:start,next=changes.find(change=>change.effective_from>asOf);
    let to=employee.termination_date&&employee.termination_date<last?employee.termination_date:last;
    if(next&&next.effective_from<=to)to=priorDay(next.effective_from);
    if(from>to)return null;
    const attendance=(periodFrom,periodTo,type)=>{
      const days=daily.filter(day=>day.date>=periodFrom&&day.date<=periodTo);
      return {from:periodFrom,to:periodTo,type,minutes:days.reduce((sum,day)=>sum+Number(day.minutes||0),0),workedDays:days.filter(day=>day.actualSeconds>0).length};
    };
    const boundaries=[...new Set([start,...changes.filter(change=>change.effective_from>start&&change.effective_from<from).map(change=>change.effective_from),from])].sort();
    const previous=boundaries.slice(0,-1).map((value,index)=>attendance(value,priorDay(boundaries[index+1]),typeAt(employee,changes,value)));
    return {...attendance(from,to,current.employment_type),previous,asOf};
  }
  const currentAttendance=row=>row?.currentEmploymentAttendance||null;
  function attendanceLabel(period){const from=period.from.slice(5).replace('-','/');return from+' 이후 '+(period.type==='part_time'?'파트타임 / Bán thời gian từ ':'정규직 / Toàn thời gian từ ')+from;}
  function extendSummaries(input){
    const {month,employees,terms,records,conversions=[],baseSummaries}=input,core=root.DGV_PAYROLL_CORE,rules=root.DGV_PAYROLL_RULES;
    const first=month+'-01',end=date(Date.UTC(+month.slice(0,4),+month.slice(5,7),1)),today=input.today||date(Date.now()+7*3600000);
    return baseSummaries.map(base=>{
      const employee=employees.find(e=>e.id===base.employee_id),changes=conversions.filter(c=>c.employee_id===base.employee_id).sort((a,b)=>a.effective_from.localeCompare(b.effective_from));
      if(!changes.some(c=>c.effective_from>=first&&c.effective_from<end))return base;
      const contractTerms=terms.filter(t=>t.employee_id===employee.id),explicitDays=(input.days||[]).filter(d=>!d._scheduleDefault),basisCache=new Map();
      const typed={};for(const employment_type of ['part_time','full_time'])typed[employment_type]=core.summarizeMonth({...input,employees:[{...employee,employment_type}]} )[0];
      const daily=typed.full_time.daily.map(d=>(typed[typeAt(employee,changes,d.date)].daily.find(x=>x.date===d.date)||d));
      const active=daily.filter(d=>(!employee.hire_date||d.date>=employee.hire_date)&&(!employee.termination_date||d.date<=employee.termination_date));
      const boundaries=[...new Set([first,...changes.filter(c=>c.effective_from>=first&&c.effective_from<end).map(c=>c.effective_from),end])].sort();
      const segments=[],issues=[],warnings=[],issueDays=new Set();let pending=0;
      function monthlyBasis(term){
        if(basisCache.has(term.id))return basisCache.get(term.id);
        const virtual={...employee,hire_date:first,termination_date:null,employment_type:'full_time'};
        const model={...input,employees:[virtual],terms:[{...term,effective_from:first}],records:[],days:explicitDays};
        model.days=rules.buildEffectiveDays(model);const b=core.summarizeMonth(model);
        const summary=rules.extendSummaries({...model,baseSummaries:b})[0];basisCache.set(term.id,summary);return summary;
      }
      for(let index=0;index<boundaries.length-1;index++){
        const from=boundaries[index],to=boundaries[index+1],days=active.filter(d=>d.date>=from&&d.date<to);
        const periodFrom=employee.hire_date&&employee.hire_date>from?employee.hire_date:from,periodTo=employee.termination_date&&employee.termination_date<priorDay(to)?employee.termination_date:priorDay(to);
        const closing=changes.find(c=>c.effective_from===to),type=typeAt(employee,changes,periodFrom);
        if(closing&&closing.prior_salary_amount!=null&&periodFrom<=periodTo){segments.push({from:periodFrom,to:periodTo,type,kind:'agreed',baseAmount:Number(closing.prior_salary_amount),extraAmount:0,minutes:days.reduce((n,d)=>n+d.minutes,0)});continue;}
        if(!days.length)continue;
        const groups=new Map();for(const d of days){const term=latest(contractTerms,d.date);if(!term){issues.push(d.date+': 급여조건 없음 / Chưa có điều kiện lương');continue;}const key=term.id||term.effective_from;if(!groups.has(key))groups.set(key,{term,days:[]});groups.get(key).days.push(d);}
        for(const {term,days:groupDays} of groups.values()){
          let amount=0,planned=0;const seconds=groupDays.reduce((n,d)=>n+(d.actualSeconds||0),0),minutes=Math.floor(seconds/60);
          if(type==='part_time'&&term.pay_type==='hourly')amount=seconds*Number(term.rate)/3600;
          else if(type==='full_time'&&term.pay_type==='monthly'&&term.monthly_settlement==='monthly_net'){
            const basis=monthlyBasis(term),denominator=basis.monthlyPlannedMinutes;
            if(!(denominator>0)){issues.push('월 기준시간을 확인해 주세요 / Kiểm tra giờ chuẩn tháng');continue;}
            for(const d of groupDays){const plan=basis.daily.find(row=>row.date===d.date)?.scheduledMinutes||0;planned+=plan;amount+=Number(term.rate)*plan/denominator;if(plan>0&&(d.date>today||(d.date===today&&(!d.checkOut||d.isOpen))))pending++;}
          }else{issues.push('전환 구간의 급여방식을 확인해 주세요 / Kiểm tra cách tính lương theo giai đoạn');continue;}
          for(const d of groupDays)if(d.issues?.length){issueDays.add(d.date);issues.push(...d.issues.map(text=>d.date+': '+text));}
          const basis=planned?monthlyBasis(term):null,extraAmount=basis?Math.round(Number(term.rate)*Math.max(0,minutes-planned)/basis.monthlyPlannedMinutes):0;
          segments.push({from:groupDays[0].date,to:groupDays.at(-1).date,type,kind:type==='part_time'?'hourly':'monthly',rate:Number(term.rate),baseAmount:Math.round(amount),extraAmount,minutes,plannedMinutes:planned,fullMonthPlannedMinutes:basis?.monthlyPlannedMinutes||0});
        }
      }
      if(pending)issues.push('월 집계 중: 아직 끝나지 않은 예정 근무일 '+pending+'일 / Còn '+pending+' ngày làm việc chưa kết thúc');
      warnings.push('전환 전·후 급여를 합산하며 실제 지급액은 같은 급여월에서 한 번만 차감합니다. / Cộng lương từng giai đoạn; trừ khoản đã trả cùng kỳ một lần.');
      const baseAmount=segments.reduce((n,s)=>n+s.baseAmount,0),monthlyExtraAmount=segments.reduce((n,s)=>n+s.extraAmount,0);
      if(!Number.isSafeInteger(baseAmount)||baseAmount<0||baseAmount>1e9)issues.push('급여 금액 범위를 확인해 주세요 / Kiểm tra giới hạn số tiền');
      const missing=issues.filter(text=>!text.includes('월 집계 중')&&!Array.from(issueDays).some(value=>text.startsWith(value))).length;
      const unresolved=issueDays.size+missing+(pending?1:0);
      const invalidAmount=missing>0;
      const attendance=summarizeCurrentAttendance({month,today,employee,changes,daily});
      return {...base,settlementMode:'employment_segments',baseAmount:invalidAmount?null:baseAmount,statutoryAmount:0,monthlyExtraAmount,
        conversionSegments:segments,conversionHistory:changes,calculationVersion:4,daily,minutes:active.reduce((n,d)=>n+d.minutes,0),actualSeconds:active.reduce((n,d)=>n+(d.actualSeconds||0),0),workedDays:active.filter(d=>d.actualSeconds>0).length,
        ...(attendance?{currentEmploymentAttendance:attendance}:{}),
        monthlyPendingDays:pending,monthlyPlannedMinutes:segments.reduce((n,s)=>n+(s.plannedMinutes||0),0),monthlyActualMinutes:segments.filter(s=>s.type==='full_time').reduce((n,s)=>n+s.minutes,0),
        unresolved,attendanceUnresolved:unresolved,compensationUnresolved:0,compensationIssues:[],issues:[...new Set(issues)],warnings,
        wageBreakdown:segments.flatMap(s=>[{code:'employment_segment',label:s.from+' ~ '+s.to+' · '+(s.kind==='agreed'?'전환 전 확정급여 / Lương trước chuyển đổi đã chốt':s.type==='part_time'?'시급 / Lương giờ':'전환기간 월급 / Lương tháng theo giai đoạn'),date:s.from,category:'base',amount:s.baseAmount,minutes:s.minutes,rate:s.rate||0,multiplier:1,rawAmount:s.baseAmount},...(s.extraAmount?[{code:'employment_segment_extra',label:'구간 추가급여 / Tiền giờ thêm',date:s.to,category:'monthly_extra',amount:s.extraAmount,minutes:Math.max(0,s.minutes-s.plannedMinutes),rate:0,multiplier:1,rawAmount:s.extraAmount}]:[])])};
    });
  }
  // Display saved segment results only. Never reuse whole-month fields here:
  // a conversion can contain different contracts or a prior agreed settlement.
  function monthlySegmentSummary(shown,run,app){
    const {esc,money,hours}=app,segments=(shown.conversionSegments||[]).filter(s=>s.type==='full_time');
    if(!segments.length)return '';
    const hourlyMoney=value=>new Intl.NumberFormat('vi-VN',{maximumFractionDigits:2}).format(value);
    const cards=segments.map(s=>{
      const heading='<h4>'+esc(s.from)+' ~ '+esc(s.to)+' · 정규직 / Toàn thời gian</h4>';
      if(s.kind==='agreed')return '<section>'+heading+'<p>합의한 확정급여 / Lương đã chốt theo thỏa thuận: <strong>'+money(s.baseAmount)+' VND</strong></p><p class="muted">일괄 확정금액으로 정산한 구간은 시간별 비교를 표시하지 않습니다. / Giai đoạn chốt theo số tiền thỏa thuận không đối chiếu theo giờ.</p></section>';
      const valid=s.kind==='monthly'&&[s.minutes,s.plannedMinutes,s.fullMonthPlannedMinutes,s.rate,s.baseAmount,s.extraAmount].every(v=>typeof v==='number'&&Number.isFinite(v)&&v>=0)&&s.fullMonthPlannedMinutes>0;
      if(!valid)return '<section>'+heading+'<p class="muted">이 구간의 저장된 시간 계산 내역이 없어 비교를 표시하지 않습니다. / Không có chi tiết giờ đã lưu cho giai đoạn này.</p></section>';
      const balance=s.minutes-s.plannedMinutes,sign=balance<0?'−':balance>0?'+':'',extra=Math.max(0,balance),hourly=s.rate*60/s.fullMonthPlannedMinutes;
      const days=(shown.daily||[]).filter(d=>d.date>=s.from&&d.date<=s.to),dailyMinutes=days.reduce((sum,d)=>sum+Number(d.minutes||0),0);
      return '<section>'+heading+'<div class="monthly-time-grid"><div><small>기간 기준시간 / Giờ chuẩn giai đoạn</small><strong data-testid="conversion-period-plan">'+hours(s.plannedMinutes)+'</strong></div><div><small>실제 근무 / Giờ thực tế</small><strong data-testid="conversion-period-actual">'+hours(s.minutes)+'</strong></div><div><small>초과·부족 / Chênh lệch</small><strong data-testid="conversion-period-balance">'+sign+hours(Math.abs(balance))+'</strong></div><div><small>추가 지급 대상 / Phút được trả thêm</small><strong data-testid="conversion-period-extra">'+hours(extra)+'</strong></div></div><p>자동 계산 시급 / Đơn giá giờ tự tính <strong data-testid="conversion-period-hourly-rate">'+hourlyMoney(hourly)+' VND</strong> · 구간 초과수당 / Tiền vượt giai đoạn <strong data-testid="conversion-period-extra-amount">'+money(s.extraAmount)+' VND</strong></p><p class="muted">약정 월급 / Lương cả tháng '+money(s.rate)+' VND ÷ 월 전체 기준시간 / Giờ chuẩn cả tháng '+hours(s.fullMonthPlannedMinutes)+' · 기간 기본급 / Lương cơ bản giai đoạn '+money(s.baseAmount)+' VND<br>정규직 구간의 기준시간과 비교합니다. 부족해도 해당 구간 기본급은 유지하며, 순초과분만 추가 지급합니다. / Đối chiếu trong giai đoạn toàn thời gian; giữ lương cơ bản khi thiếu giờ, chỉ trả phần vượt.'+(days.length&&dailyMinutes!==s.minutes?'<br>일별 근무표 합계 / Tổng giờ theo từng ngày: '+hours(dailyMinutes)+' · 위 정산시간은 초 단위 근무를 합산한 값입니다. / Giờ đối chiếu ở trên được cộng từ số giây làm việc.':'')+'</p></section>';
    }).join('');
    const month=segments[0].from?.slice(0,7),payDate=/^\d{4}-\d{2}$/.test(month||'')?date(Date.UTC(+month.slice(0,4),+month.slice(5,7),5)):null;
    return '<div id="conversionMonthlyTimeSummary">'+cards+(run?'<p class="muted">확정 당시 구간별 계산 내역입니다. / Chi tiết từng giai đoạn tại thời điểm chốt.</p>':'<p class="muted">현재까지 기록된 근무시간과 해당 구간 전체 기준시간을 비교한 예상값입니다. / Dự kiến theo giờ đã ghi và giờ chuẩn của cả giai đoạn.</p>')+(payDate?'<p class="notice" data-testid="conversion-pay-date">지급 예정일 / Ngày trả dự kiến: <strong>'+payDate+'</strong> · 해당 월 근무분을 다음 달 5일 지급 / Trả lương tháng vào ngày 5 tháng sau</p>':'')+'</div>';
  }
  function renderDetail(row,run){
    const app=root.DGV_PAYROLL_APP,{state,$,esc,money,hours}=app,employee=state.employees.find(e=>e.id===row.employee_id),shown=run?.snapshot||row,attendance=currentAttendance(shown);
    $('employmentConversionAction')?.remove();$('employmentConversionSummary')?.remove();$('currentEmploymentAttendanceSummary')?.remove();
    if(shown.settlementMode==='employment_segments'){
      const summary=monthlySegmentSummary(shown,run,app);
      if(summary)$('detailSummary').innerHTML=summary;
    }
    if(employee&&!employee.archived_at&&employee.employment_status==='active'){
      const wrap=document.createElement('div');wrap.id='employmentConversionAction';wrap.className='actions';
      const button=document.createElement('button');button.type='button';button.className='quiet';button.dataset.convertEmployee=employee.id;
      button.textContent=employee.employment_type==='part_time'?'정규직 전환 / Chuyển chính thức':'파트타임 전환 / Chuyển bán thời gian';wrap.append(button);
      const terms=state.terms.filter(t=>t.employee_id===employee.id);if(employee.employment_type==='full_time'&&!state.conversions?.some(c=>c.employee_id===employee.id)&&terms.some(t=>t.pay_type==='hourly'&&t.effective_from<employee.hire_date)&&terms.some(t=>t.pay_type==='monthly'&&t.effective_from===employee.hire_date)){const repair=document.createElement('button');repair.type='button';repair.className='quiet';repair.dataset.convertEmployee=employee.id;repair.dataset.repairConversion='true';repair.textContent='기존 전환 정산 보완 / Bổ sung quyết toán trước chuyển đổi';wrap.append(repair);}
      $('employeeActionBar').append(wrap);
    }
    if(shown.conversionSegments){const section=document.createElement('section');section.id='employmentConversionSummary';section.className='notice';section.innerHTML='<h3>근무형태 전환 정산 / Quyết toán chuyển loại lao động</h3>'+shown.conversionSegments.map(s=>'<p>'+esc(s.from)+' ~ '+esc(s.to)+' · '+(s.type==='part_time'?'파트타임':'정규직')+' · '+money(s.baseAmount)+' VND'+(s.kind==='agreed'?' (확정금액 / Đã chốt)':'')+(s.extraAmount?' + '+money(s.extraAmount)+' VND':'')+'</p>').join('')+'<p>기지급 / Đã trả '+money(app.paidForEmployee(row.employee_id))+' VND · 월 총급여에서 한 번만 차감합니다. / Trừ một lần từ tổng lương tháng.</p>';$('detailSummary').after(section);}
    if(attendance){
      const section=document.createElement('section');section.id='currentEmploymentAttendanceSummary';section.className='notice';
      section.innerHTML='<h3>'+(run?'확정 당시 고용기간 근무 / Chấm công giai đoạn tại lúc chốt':'현재 고용기간 근무 / Chấm công giai đoạn hiện tại')+'</h3><p data-testid="current-employment-period">'+esc(attendanceLabel(attendance))+' · '+esc(attendance.from)+' ~ '+esc(attendance.to)+'</p><p><strong data-testid="current-employment-minutes">'+hours(attendance.minutes)+'</strong> · <strong data-testid="current-employment-days">'+attendance.workedDays+'일 / ngày</strong></p>'+(attendance.previous.length?'<details id="previousEmploymentAttendance"><summary>전환 전 근무기록 / Chấm công trước chuyển đổi</summary>'+attendance.previous.map(period=>'<p>'+esc(period.from)+' ~ '+esc(period.to)+' · '+(period.type==='part_time'?'파트타임 / Bán thời gian':'정규직 / Toàn thời gian')+' · '+hours(period.minutes)+' · '+period.workedDays+'일 / ngày</p>').join('')+'<p class="muted">이전 근무기록은 보존되며, 실제 지급 여부는 지급내역에서 확인합니다. / Giữ chấm công trước đây; xem thanh toán để kiểm tra số đã trả.</p></details>':'');
      const attendanceMount=$('attendanceSummarySlot');
      if(attendanceMount)attendanceMount.append(section);else $('detailSummary').after(section);
    }
  }
  function bind(){
    const app=root.DGV_PAYROLL_APP;if(!app)return;
    const {$,state,field}=app,dialog=document.createElement('dialog');dialog.id='employmentConversionDialog';
    dialog.innerHTML='<form id="employmentConversionForm"><h2 id="employmentConversionTitle"></h2><p id="employmentConversionContext" class="notice"></p><p class="muted">원래 입사일·근무·지급·서명 내역은 보존합니다. 전환일부터 새 조건으로 구간별 계산합니다. / Giữ ngày vào làm và lịch sử; áp dụng điều kiện mới từ ngày chuyển.</p><div class="form-grid"><label>원래 입사일 / Ngày vào làm ban đầu<input name="original_hire_date" type="date" required></label><label>전환일 / Ngày chuyển<input name="effective_from" type="date" required></label><label id="conversionRateLabel">새 월급·시급 VND / Mức lương mới<input name="rate" type="number" min="1" max="1000000000" step="1" required></label><label>근무 시작 / Bắt đầu<input name="shift_start" type="time" required></label><label>근무 종료 / Kết thúc<input name="shift_end" type="time" required></label><label>휴게 시작 / Nghỉ từ<input name="break_start" type="time" required></label><label>휴게 종료 / Nghỉ đến<input name="break_end" type="time" required></label><label>주간 휴무 요일 / Ngày nghỉ tuần<select name="weekly_rest_day">'+['일 / CN','월 / T2','화 / T3','수 / T4','목 / T5','금 / T6','토 / T7'].map((v,i)=>'<option value="'+i+'">'+v+'</option>').join('')+'</select></label></div><label>이달 전환 전 확정급여 VND (선택) / Lương đã chốt trước chuyển trong tháng (tùy chọn)<input name="prior_salary_amount" type="number" min="0" max="1000000000" step="1" placeholder="비우면 근무기록으로 자동 계산 / Để trống để tự tính"></label><p class="muted">실제 지급액이 아니라 합의한 급여 총액입니다. 이전 달 급여는 포함하지 마세요. / Đây là tổng lương đã chốt, không phải số đã trả; không gồm tháng trước.</p><label>전환 사유 / Lý do<input name="reason" required maxlength="1000"></label><label class="check"><input name="confirmed" type="checkbox" required> 전환일과 금액을 확인했습니다. 실제 지급은 별도입니다. / Đã kiểm tra; ghi thanh toán riêng.</label><div class="actions"><button type="button" data-close>취소 / Hủy</button><button type="submit">전환 저장 / Lưu chuyển đổi</button></div></form>';
    document.body.append(dialog);let candidate=null,requestId=null,revision=null;
    async function open(employeeId,repair=false){
      if(state.busy||!state.loaded)return;
      const employee=state.employees.find(e=>e.id===employeeId);if(!employee)return;
      const form=$('employmentConversionForm'),target=repair?'full_time':employee.employment_type==='part_time'?'full_time':'part_time';
      candidate=null;requestId=null;revision=null;form.reset();form.dataset.employeeId=employeeId;form.dataset.repair=String(repair);form.dataset.target=target;
      $('employmentConversionTitle').textContent=repair?'기존 전환 정산 보완 / Bổ sung quyết toán trước chuyển đổi':target==='full_time'?'정규직 전환 / Chuyển chính thức':'파트타임 전환 / Chuyển bán thời gian';
      $('employmentConversionContext').textContent='직원 정보를 확인하고 있습니다. / Đang kiểm tra thông tin nhân viên.';
      form.querySelectorAll('input,select').forEach(input=>input.disabled=true);app.openDialog(dialog.id);
      await app.task(async()=>{const capturedRevision=state.revision;
        try{candidate=await app.result(app.db.rpc('payroll_conversion_candidate',{p_employee_id:employeeId,p_repair:repair}));}catch(error){$('employmentConversionContext').textContent='정보를 불러오지 못했습니다. 안내를 확인한 후 다시 열어 주세요. / Chưa tải được thông tin; xem thông báo và mở lại.';throw error;}
        if(!state.loaded||state.revision!==capturedRevision){dialog.close();return;}revision=capturedRevision;requestId=crypto.randomUUID();
        form.querySelectorAll('input,select').forEach(input=>input.disabled=false);
        $('employmentConversionContext').textContent=candidate.name+' · '+(candidate.original_hire_date?candidate.original_hire_date+' · 등록된 입사일은 유지됩니다. / Giữ ngày vào làm đã lưu.':'입사일이 없습니다. 실제 입사일을 먼저 입력해 주세요. / Chưa có ngày vào làm; nhập ngày thực tế.')+' · '+$('month').value+' 근무분 → '+date(Date.UTC(+$('month').value.slice(0,4),+$('month').value.slice(5,7),5))+' 지급 예정';
        field(form,'original_hire_date').value=candidate.original_hire_date||'';field(form,'original_hire_date').readOnly=!!candidate.original_hire_date;field(form,'original_hire_date').max=app.today();
        const term=candidate.term||{};field(form,'effective_from').value=repair?term.effective_from:app.today();field(form,'effective_from').max=app.today();field(form,'effective_from').min=candidate.original_hire_date||'';
        field(form,'rate').value=repair?term.rate:'';if(repair)field(form,'reason').value='기존 정규직 전환 기간 정산 보완 / Bổ sung quyết toán khi chuyển chính thức';
        for(const key of ['shift_start','shift_end','break_start','break_end'])field(form,key).value=String(term[key]||({shift_start:'10:00',shift_end:'20:00',break_start:'12:00',break_end:'14:00'}[key])).slice(0,5);
        field(form,'weekly_rest_day').value=term.weekly_rest_day??0;if(target==='part_time')for(const key of ['break_start','break_end']){field(form,key).value='00:00';field(form,key).readOnly=true;}else{for(const key of ['break_start','break_end'])field(form,key).readOnly=false;if(!repair&&candidate.prior_employment_type==='part_time'){field(form,'break_start').value='12:00';field(form,'break_end').value='14:00';}}
      });
      if(!candidate||!requestId)form.querySelector('button[type="submit"]').disabled=true;
    }
    document.addEventListener('click',event=>{const button=event.target.closest('[data-convert-employee]');if(button&&!state.busy)void open(button.dataset.convertEmployee,button.dataset.repairConversion==='true');});
    $('employmentConversionForm').addEventListener('submit',event=>{event.preventDefault();void app.task(async()=>{const form=event.target;if(!candidate||!field(form,'confirmed').checked)throw Error('전환 내용을 확인해 주세요 / Kiểm tra thông tin chuyển đổi');
      const terms={};for(const key of ['effective_from','rate','shift_start','shift_end','break_start','break_end','weekly_rest_day'])terms[key]=['rate','weekly_rest_day'].includes(key)?Number(field(form,key).value):field(form,key).value;
      if(!candidate.original_hire_date){const original=field(form,'original_hire_date').value;if(!original||original>terms.effective_from)throw Error('입사일은 전환일 이전 또는 같은 날짜로 입력해 주세요. / Ngày vào làm phải trước hoặc bằng ngày chuyển.');terms.original_hire_date=original;}
      const raw=field(form,'prior_salary_amount').value;
      await app.result(app.db.rpc('payroll_convert_employment',{p_employee_id:form.dataset.employeeId,p_employment_type:form.dataset.target,p_terms:terms,p_prior_salary_amount:raw===''?null:Number(raw),p_reason:field(form,'reason').value.trim(),p_expected_revision:revision,p_request_id:requestId,p_repair:form.dataset.repair==='true'}));dialog.close();await app.load();app.notice('근무형태를 전환했습니다. 입사일과 기존 지급 내역은 보존했습니다. / Đã chuyển loại lao động; giữ ngày vào làm và lịch sử thanh toán.');
    });});
    root.DGV_PAYROLL_CONVERSIONS.open=open;
  }
  root.DGV_PAYROLL_CONVERSIONS={historicalEmployees,extendSummaries,summarizeCurrentAttendance,currentAttendance,attendanceLabel,renderDetail,bind};
  if(root.DGV_PAYROLL_APP)bind();
})(typeof window==='object'?window:globalThis);
