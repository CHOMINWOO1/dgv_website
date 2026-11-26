(function(root){
  'use strict';
  const app=root.DGV_PAYROLL_APP;
  if(!app)return;
  const {state,db,$,esc,field}=app;
  const list=$('termsList');
  if(!list)return;
  const dialog=document.createElement('dialog');
  dialog.id='payrollBreakDialog';
  dialog.setAttribute('aria-labelledby','payrollBreakTitle');
  dialog.innerHTML='<form id="payrollBreakForm"><h2 id="payrollBreakTitle">휴게시간 설정 / Giờ nghỉ</h2><p id="payrollBreakContext" class="notice"></p><p class="muted">선택한 근무조건의 적용 시작일부터 반영합니다. 출퇴근 원본·약정급여·지급내역은 보존되며, 인정 근무시간과 추가급여는 다시 계산됩니다. 확정된 급여기간은 변경할 수 없습니다.<br>Áp dụng từ ngày hiệu lực của điều kiện đã chọn. Giữ chấm công gốc, mức lương và thanh toán; tính lại giờ làm và tiền giờ thêm. Không thay đổi kỳ lương đã chốt.</p><div class="form-grid"><label>휴게 시작 / Nghỉ từ<input name="break_start" type="time" required></label><label>휴게 종료 / Nghỉ đến<input name="break_end" type="time" required></label></div><label>설정 사유 / Lý do<textarea name="reason" required maxlength="500"></textarea></label><label class="check"><input name="confirmed" type="checkbox" required> 적용 시작일과 휴게시간을 확인했습니다. / Đã kiểm tra ngày hiệu lực và giờ nghỉ.</label><div class="actions"><button type="button" data-break-close>취소 / Hủy</button><button type="submit">저장 / Lưu</button></div></form>';
  document.body.append(dialog);
  const form=$('payrollBreakForm');
  let captured=null;
  let trigger=null;
  const eligible=(employee,term)=>Boolean(employee&&!employee.archived_at&&employee.payee_type!=='service'&&employee.employment_type==='full_time'&&term&&term.pay_type==='monthly'&&term.monthly_settlement==='monthly_net');
  const termsFor=id=>state.terms.filter(t=>t.employee_id===id).slice().sort((a,b)=>b.effective_from.localeCompare(a.effective_from)).slice(0,5);
  function message(error){
    const text=error?.message||String(error);
    if(/PAYROLL_(?:BREAK_)?FINALIZED|PAYROLL_BREAK_FINALIZED/.test(text))return '이미 확정한 급여기간의 휴게시간은 변경할 수 없습니다. / Không đổi giờ nghỉ trong kỳ lương đã chốt.';
    if(/STALE|STATE_CHANGED|CONFLICT|revision/i.test(text))return '근무자료가 변경되었습니다. 닫고 새로고침한 뒤 다시 확인해 주세요. / Dữ liệu đã đổi; đóng và tải lại.';
    if(/ADMIN_REQUIRED/.test(text))return '관리자 로그인 후 다시 시도해 주세요. / Vui lòng đăng nhập quản trị.';
    if(/REASON/.test(text))return '설정 사유를 1~500자로 입력해 주세요. / Nhập lý do từ 1 đến 500 ký tự.';
    if(/BREAK_|TERM_NOT_FOUND/.test(text))return '적용할 직원·근무조건과 휴게시간을 확인해 주세요. / Kiểm tra nhân viên, điều kiện và giờ nghỉ.';
    return text;
  }
  function open(termId,button){
    if(state.busy||!state.loaded)return;
    if(!Number.isSafeInteger(state.revision)||state.revision<0){app.notice('근무자료를 새로고침한 뒤 다시 시도해 주세요. / Tải lại dữ liệu rồi thử lại.',true);return;}
    const term=state.terms.find(t=>t.id===termId&&t.employee_id===state.selected);
    const employee=state.employees.find(e=>e.id===state.selected);
    if(!eligible(employee,term))return;
    captured={employeeId:employee.id,term:{...term},revision:state.revision};
    trigger=button||document.activeElement;
    app.openDialog('payrollBreakDialog');
    $('payrollBreakContext').textContent=employee.name+' · '+term.effective_from+'부터 / Từ · '+String(term.shift_start).slice(0,5)+'–'+String(term.shift_end).slice(0,5);
    field(form,'break_start').value=String(term.break_start).slice(0,5);
    field(form,'break_end').value=String(term.break_end).slice(0,5);
    field(form,'reason').value='';
    field(form,'confirmed').checked=false;
  }
  function attach(){
    const employee=state.employees.find(e=>e.id===state.selected),terms=termsFor(state.selected);
    for(const [index,row] of Array.from(list.querySelectorAll('.term-row')).entries()){
      const term=terms[index];
      if(!eligible(employee,term)||row.querySelector('[data-break-term]'))continue;
      const button=document.createElement('button');button.type='button';button.className='quiet';button.dataset.breakTerm=term.id;
      button.textContent='휴게시간 설정 / Giờ nghỉ';
      button.addEventListener('click',()=>open(term.id,button));row.append(button);
    }
  }
  dialog.querySelector('[data-break-close]').addEventListener('click',()=>dialog.close());
  dialog.addEventListener('close',()=>{captured=null;trigger?.focus?.();trigger=null;});
  form.addEventListener('submit',event=>{
    event.preventDefault();
    if(!form.reportValidity()||!captured||state.busy)return;
    const request=captured;
    const start=field(form,'break_start').value,end=field(form,'break_end').value,reason=field(form,'reason').value.trim();
    app.task(async()=>{
      if(!field(form,'confirmed').checked||!reason||reason.length>500)throw new Error('설정 사유와 확인 항목을 입력해 주세요. / Nhập lý do và xác nhận.');
      const term=state.terms.find(t=>t.id===request.term.id),employee=state.employees.find(e=>e.id===request.employeeId);
      if(!state.loaded||!Number.isSafeInteger(request.revision)||request.revision<0||state.selected!==request.employeeId||state.revision!==request.revision||!eligible(employee,term)||JSON.stringify(term)!==JSON.stringify(request.term))throw new Error(message(new Error('PAYROLL_STATE_CHANGED')));
      let response;
      try{response=await app.result(db.rpc('payroll_correct_term_break',{p_term_id:term.id,p_break_start:start,p_break_end:end,p_reason:reason,p_expected_revision:request.revision}));}
      catch(error){throw new Error(message(error));}
      if(!response?.term||response.term.id!==term.id)throw new Error('저장 결과를 확인하지 못했습니다. 닫고 새로고침해 주세요. / Chưa xác nhận kết quả; đóng và tải lại.');
      dialog.close();
      try{await app.load();}catch(_){throw new Error('휴게시간은 저장되었습니다. 조회 갱신에 실패했으므로 새로고침해 주세요. / Đã lưu giờ nghỉ; tải lại để xem kết quả.');}
      app.notice('휴게시간을 저장했습니다. / Đã lưu giờ nghỉ.');
    });
  });
  new MutationObserver(attach).observe(list,{childList:true,subtree:true});
  attach();
  root.DGV_PAYROLL_BREAK_SETTINGS=Object.freeze({attach,open});
})(typeof window==='object'?window:globalThis);
