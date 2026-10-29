(function () {
  "use strict";
  const app=window.DGV_PAYROLL_APP,{state,$,esc,money,hours}=app;
  const views={
    ledger:{title:"급여대장",eyebrow:"PAYROLL",description:"월별 급여와 실제 지급액을 한눈에 확인하세요. / Xem lương tháng và số tiền đã trả."},
    employees:{title:"직원관리",eyebrow:"EMPLOYEES",description:"직원 등록부터 월급·근무조건 변경까지 한 곳에서 관리하세요. / Quản lý nhân viên và điều kiện lương."},
    attendance:{title:"출퇴근 기록",eyebrow:"ATTENDANCE",description:"모든 직원의 근무일과 시간을 확인하세요. 출퇴근은 자동으로 합산됩니다. / Chấm công được cộng tự động."},
    payments:{title:"지급·서명·출력",eyebrow:"PAYMENTS",description:"지급한 금액을 기록하고 서명을 받으세요. 기간별 내역도 함께 출력할 수 있습니다. / Ghi thanh toán, ký nhận và in theo kỳ."}
  };
  const aliases={ledgerTitle:"ledger",employeeDetail:"ledger",importTitle:"attendance",rangePanel:"payments",taxCenter:"payments",comparisonPanel:"ledger",rulesPanel:"employees",archivePanel:"employees"};
  let currentView="ledger",teamDate="",teamMonth="",teamDays=new Map();
  $("comparisonMount").append($("comparisonPanel"));
  $("settingsMount").append($("rulesPanel"),$("archivePanel"));
  $("paymentReportsMount").append($("rangePanel"),$("taxCenter"));

  function syncDetail(){
    const mount=document.querySelector(`[data-detail-mount="${currentView}"]`);
    if($("employeeDetail").parentElement!==mount)mount.append($("employeeDetail"));
    document.querySelectorAll("[data-detail-views]").forEach(node=>{node.hidden=!node.dataset.detailViews.split(" ").includes(currentView);});
  }
  function showView(name,{historyMode="replace",focus=false}={}){
    if(!views[name])name="ledger";
    currentView=name;
    document.querySelectorAll("[data-payroll-tab]").forEach(button=>{
      const selected=button.dataset.payrollTab===name;
      button.setAttribute("aria-selected",String(selected));button.tabIndex=selected?0:-1;
    });
    for(const key of Object.keys(views))$("view-"+key).hidden=key!==name;
    $("workspaceTitle").textContent=views[name].title;
    $("workspaceEyebrow").textContent=views[name].eyebrow;
    $("workspaceDescription").textContent=views[name].description;
    $("employeeFilterLabel").hidden=name==="employees"||name==="attendance";
    document.querySelectorAll("[data-views]").forEach(node=>{node.hidden=!node.dataset.views.split(" ").includes(name);});
    syncDetail();
    if(historyMode)history[historyMode==="push"?"pushState":"replaceState"](null,"","#"+name);
    if(focus)$("workspaceTitle").focus({preventScroll:true});
  }
  function fromHash(){
    const hash=decodeURIComponent(location.hash.slice(1)),view=views[hash]?hash:aliases[hash]||"ledger";
    showView(view,{historyMode:false});
    if(hash==="comparisonPanel")$("comparisonDetails").open=true;
    if(hash==="rulesPanel"||hash==="archivePanel")$("advancedSettings").open=true;
  }
  function selectEmployee(id){
    if(!state.loaded||state.busy||!state.employees.some(employee=>employee.id===id))return false;
    const changed=state.selected!==id||$("employeeDetail").hidden;
    state.selected=id;if(changed){$("employeeFilter").value=id;app.render();}
    $("paymentEmployee").value=id;$("startPayment").disabled=false;
    return true;
  }
  function renderStaff(){
    if(!state.loaded){$("staffList").replaceChildren();$("staffCount").textContent="";return;}
    const query=$("staffSearch").value.trim().toLocaleLowerCase(),status=$("staffStatus").value;
    const employees=state.employees.filter(employee=>(!query||(employee.name+" "+employee.device_user_id).toLocaleLowerCase().includes(query))&&(!status||(employee.employment_status||(employee.active===false?"terminated":"active"))===status));
    $("staffCount").textContent=employees.length+"명 / "+state.employees.length;
    const end=app.bounds($("month").value).end;
    $("staffList").innerHTML=employees.map(employee=>{
      const term=state.terms.filter(item=>item.employee_id===employee.id&&item.effective_from<end).sort((a,b)=>b.effective_from.localeCompare(a.effective_from))[0];
      const payType={monthly:"월급 / Tháng",hourly:"시급 / Giờ",daily:"일급 / Ngày"}[term?.pay_type];
      const hourly=term?.pay_type==="hourly"||(!term&&employee.employment_type==="part_time");
      const salaryAction=hourly?(term?"시급·조건 변경 / Đổi lương giờ":"시급 설정 / Đơn giá giờ"):(term?"월급·조건 변경 / Đổi lương":"급여 설정 / Thiết lập lương");
      const employment=employee.employment_status||(employee.active===false?"terminated":"active");
      const statusText={active:"재직 / Đang làm",leave:"휴직 / Tạm nghỉ",terminated:"퇴사 / Đã nghỉ"}[employment]||employment;
      return `<article class="staff-card" data-staff-id="${esc(employee.id)}"><div class="staff-identity"><span class="staff-avatar" aria-hidden="true">${esc(employee.name.slice(0,1))}</span><div><h3>${esc(employee.name)}</h3><p class="muted">ID ${esc(employee.device_user_id)} · ${employee.employment_type==="part_time"?"파트타임 / Bán thời gian":"정규직 / Toàn thời gian"}${employee.hire_date?" · 입사 "+esc(employee.hire_date):""}</p></div><span class="badge ${employment==="active"?"":"neutral"}">${esc(statusText)}</span></div><div class="staff-salary">${term?`<span>${payType}</span><strong>${money(Number(term.rate))} <small>VND</small></strong><p class="muted">${esc(term.effective_from)}부터 적용 / Từ ngày</p>`:'<span class="badge warn">급여조건 미등록 / Chưa có điều kiện lương</span><p class="muted">월급이나 시급을 등록해 주세요.</p>'}</div><div class="staff-actions"><button class="quiet" data-staff-action="info" data-staff-id="${esc(employee.id)}">정보 수정 / Thông tin</button><button data-staff-action="salary" data-staff-id="${esc(employee.id)}">${salaryAction}</button><button class="quiet" data-staff-action="attendance" data-staff-id="${esc(employee.id)}">근무 보기 / Chấm công</button><button class="quiet" data-staff-action="pay" data-staff-id="${esc(employee.id)}">지급·서명 / Trả &amp; ký</button></div></article>`;
    }).join("")||`<div class="empty"><strong>${state.employees.length?"검색한 직원이 없습니다. / Không tìm thấy nhân viên.":"등록된 직원이 없습니다. / Chưa có nhân viên."}</strong><p>위의 직원 등록 버튼으로 시작하세요. / Dùng nút Thêm nhân viên ở trên.</p></div>`;
  }
  const attendanceLabel=day=>({recognized:"자동 반영 / Đã ghi nhận",in_progress:"퇴근 대기 / Chờ giờ ra",missing:"기록 누락 / Thiếu giờ",ambiguous:"기록 확인 / Kiểm tra"}[day.attendanceStatus]||"기록됨 / Đã ghi");
  function renderTeam(){
    const month=$("month").value,start=new Date(month+"-01T00:00:00Z"),count=new Date(Date.UTC(start.getUTCFullYear(),start.getUTCMonth()+1,0)).getUTCDate();
    teamDays=new Map();
    // The shared selected employee and ledger filter never narrow this calendar.
    for(const row of state.summaries)for(const day of row.daily||[]){
      if(!day.date.startsWith(month)||!(day.rawCount||day.checkIn||day.checkOut||day.actualSeconds||day.isOpen))continue;
      if(!teamDays.has(day.date))teamDays.set(day.date,[]);
      teamDays.get(day.date).push({employee_id:row.employee_id,name:row.name,device_user_id:row.device_user_id,day});
    }
    for(const entries of teamDays.values())entries.sort((a,b)=>a.name.localeCompare(b.name));
    if(teamMonth!==month||!teamDate.startsWith(month))teamDate=app.today().startsWith(month)?app.today():[...teamDays.keys()].sort()[0]||month+"-01";
    teamMonth=month;
    const employees=new Set([...teamDays.values()].flat().map(entry=>entry.employee_id));
    $("teamMonthSummary").textContent=`${month} · 기록 ${employees.size}명 / ${employees.size} nhân viên`;
    let html=["일 / CN","월 / T2","화 / T3","수 / T4","목 / T5","금 / T6","토 / T7"].map(label=>`<div class="team-weekday">${label}</div>`).join("")+ '<span class="team-spacer"></span>'.repeat(start.getUTCDay());
    for(let dayNumber=1;dayNumber<=count;dayNumber++){
      const date=month+"-"+String(dayNumber).padStart(2,"0"),entries=teamDays.get(date)||[],minutes=entries.reduce((sum,entry)=>sum+Number(entry.day.minutes||0),0);
      const description=entries.map(entry=>`${entry.name} ${hours(entry.day.minutes)}${entry.day.isOpen?" 퇴근 대기":""}`).join(", ");
      html+=`<button type="button" class="team-date ${date===teamDate?"selected":""} ${date===app.today()?"today":""}" data-team-date="${date}" aria-pressed="${date===teamDate}" aria-label="${esc(date+" · "+(description||"근무 기록 없음"))}"><span class="team-date-number">${dayNumber}</span>${entries.length?`<span class="team-day-total">${entries.length}명 · ${hours(minutes)}</span><span class="team-people">${entries.slice(0,3).map(entry=>`<span><b>${esc(entry.name)}</b><small>${hours(entry.day.minutes)}${entry.day.isOpen?" · 대기":""}</small></span>`).join("")}${entries.length>3?`<small class="team-more">+${entries.length-3}명 더 보기</small>`:""}</span>`:'<span class="team-day-empty">—</span>'}</button>`;
    }
    $("teamCalendar").innerHTML=html;renderTeamDay();
  }
  function renderTeamDay(){
    const entries=teamDays.get(teamDate)||[];
    $("teamDayTitle").textContent=teamDate+" · 직원별 근무 / Chấm công theo nhân viên";
    $("teamDayRows").innerHTML=entries.map(({employee_id,name,device_user_id,day})=>{
      const intervals=day.workIntervals||[],stamp=value=>value.slice(0,10)===teamDate?value.slice(11,19):value.slice(5,19).replace("T"," ");
      const pairs=intervals.map(interval=>`<span class="work-pair">${esc(stamp(interval.start))} → ${esc(stamp(interval.end))}</span>`).join("");
      const pending=day.openCheckIn?`<span class="muted">${esc(stamp(day.openCheckIn))} 출근 · 퇴근 대기 / Chờ giờ ra</span>`:"";
      return `<tr data-team-row="${esc(employee_id)}"><td><strong>${esc(name)}</strong><span class="muted">ID ${esc(device_user_id)}</span></td><td>${pairs||'<span class="muted">완료 구간 없음 / Chưa có cặp hoàn tất</span>'}${pending}</td><td><strong>${hours(day.minutes)}</strong></td><td><span class="badge ${["missing","ambiguous","in_progress"].includes(day.attendanceStatus)?"warn":""}">${esc(attendanceLabel(day))}</span></td><td><button class="quiet" data-team-employee="${esc(employee_id)}">직원 상세 / Chi tiết</button></td></tr>`;
    }).join("")||'<tr><td colspan="5" class="empty">이 날짜에 수신된 출퇴근 기록이 없습니다. / Chưa có chấm công ngày này.</td></tr>';
  }
  function renderDetail(){
    const employee=state.employees.find(e=>e.id===state.selected),end=app.bounds($("month").value).end;
    const term=state.terms.filter(t=>t.employee_id===state.selected&&t.effective_from<end).sort((a,b)=>b.effective_from.localeCompare(a.effective_from))[0];
    $("addTerms").textContent=term?.pay_type==="hourly"||(!term&&employee?.employment_type==="part_time")?"시급·근무조건 변경 / Đổi lương giờ & lịch làm":"월급·근무조건 변경 / Đổi điều kiện lương";
    const dynamic=$("detailTitle").parentElement.querySelector(".advanced-detail-actions");
    if(dynamic)$("employeeActionBar").append(dynamic);
    if($("sensitiveInfo"))$("sensitiveInfo").dataset.detailViews="employees";
    if($("viewAudit"))$("viewAudit").dataset.detailViews="employees";
    if($("monthSchedule"))$("monthSchedule").dataset.detailViews="attendance";
    if($("autoAttendanceSummary"))$("attendanceSummarySlot").append($("autoAttendanceSummary"));
    $("paymentEmployee").value=state.selected;$("startPayment").disabled=!state.selected;
    syncDetail();
  }
  function render(){
    if(!state.loaded)return;
    const selected=state.selected;
    $("paymentEmployee").innerHTML='<option value="">직원 선택 / Chọn nhân viên</option>'+state.employees.map(employee=>`<option value="${esc(employee.id)}">${esc(employee.name)} · ID ${esc(employee.device_user_id)}</option>`).join("");
    $("paymentEmployee").value=selected;$("startPayment").disabled=!selected;
    renderStaff();renderTeam();syncDetail();
  }
  function invalidate(){
    for(const id of ["staffList","teamCalendar","teamDayRows"])$(id).replaceChildren();
    for(const id of ["staffCount","teamMonthSummary","teamDayTitle"])$(id).textContent="";
    $("paymentEmployee").replaceChildren();$("startPayment").disabled=true;teamDays.clear();
  }
  document.querySelectorAll("[data-payroll-tab]").forEach(button=>{
    button.addEventListener("click",()=>showView(button.dataset.payrollTab,{historyMode:"push"}));
    button.addEventListener("keydown",event=>{
      const keys=Object.keys(views),index=keys.indexOf(currentView);
      let next;if(event.key==="ArrowRight"||event.key==="ArrowDown")next=keys[(index+1)%keys.length];
      else if(event.key==="ArrowLeft"||event.key==="ArrowUp")next=keys[(index+keys.length-1)%keys.length];
      else if(event.key==="Home")next=keys[0];else if(event.key==="End")next=keys.at(-1);
      if(next){event.preventDefault();showView(next,{historyMode:"push"});$("tab-"+next).focus();}
    });
  });
  document.addEventListener("click",event=>{
    const button=event.target.closest("button");if(!button||state.busy)return;
    if(button.dataset.openView)showView(button.dataset.openView,{historyMode:"push"});
    if(button.dataset.staffAction&&selectEmployee(button.dataset.staffId)){
      const action=button.dataset.staffAction;
      showView(action==="pay"?"payments":action==="attendance"?"attendance":"employees",{historyMode:"push"});
      if(action==="info")$("editEmployee").click();
      else if(action==="salary")$("addTerms").click();
      else if(action==="pay")$("addPayment")?.click();
      else $("employeeDetail").scrollIntoView({behavior:"smooth",block:"start"});
    }
    if(button.dataset.teamDate){
      teamDate=button.dataset.teamDate;
      document.querySelectorAll("[data-team-date]").forEach(node=>{const selected=node.dataset.teamDate===teamDate;node.classList.toggle("selected",selected);node.setAttribute("aria-pressed",String(selected));});
      renderTeamDay();
    }
    if(button.dataset.teamEmployee&&selectEmployee(button.dataset.teamEmployee))$("employeeDetail").scrollIntoView({behavior:"smooth",block:"start"});
  });
  $("staffSearch").addEventListener("input",renderStaff);$("staffStatus").addEventListener("change",renderStaff);
  $("paymentEmployee").addEventListener("change",()=>{
    const id=$("paymentEmployee").value;
    if(id)selectEmployee(id);else{state.selected="";$("employeeFilter").value="";app.render();}
  });
  $("startPayment").addEventListener("click",()=>{if(selectEmployee($("paymentEmployee").value))$("addPayment")?.click();});
  window.addEventListener("hashchange",fromHash);window.addEventListener("popstate",fromHash);
  window.DGV_PAYROLL_WORKSPACE={render,renderDetail,invalidate,showView};
  fromHash();
})();
