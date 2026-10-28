(function (root) {
  "use strict";
  const KINDS = Object.freeze(["ledger", "attendance", "parttime", "cash", "bank", "outstanding", "tax"]);
  const names = { ledger:"Bang_luong", attendance:"Cham_cong", parttime:"Ban_thoi_gian", cash:"Tien_mat", bank:"Chuyen_khoan", outstanding:"Con_phai_tra", tax:"Ho_so_luong" };
  const headings = {
    ledger:["ID", "Nhân viên / 직원", "Kỳ lương / 급여월", "Trạng thái / 상태", "Cơ bản / 기본급", "Phụ cấp / 추가수당", "Khấu trừ / 공제", "Đã chốt ban đầu / 최초 확정", "Điều chỉnh / 정정", "Phải trả / 확정급여", "Đã trả ròng / 순지급", "Còn phải trả / 미지급", "Phút làm / 근무분", "Ngày làm / 근무일", "Cần kiểm tra / 확인 필요"],
    attendance:["ID", "Nhân viên / 직원", "Ngày làm / 근무일", "Vào / 출근", "Ra / 퇴근", "Phút làm / 근무분", "Đi muộn / 지각분", "Về sớm / 조퇴분", "Thêm giờ ứng viên / 추가근무 후보분", "Loại ngày / 근무일 구분", "Tình trạng / 상태", "Ghi chú kiểm tra / 검토 사항", "Nguồn / 기준"],
    payment:["Mã trả / 지급 ID", "ID nhân viên", "Nhân viên / 직원", "Kỳ lương / 급여월", "Ngày trả / 지급일", "Cách trả / 지급방법", "Đã ghi nhận / 원지급액", "Hoàn tác / 취소액", "Trả ròng / 순지급액", "Tham chiếu / 거래·수령확인", "Ghi chú / 비고", "Chứng từ / 증빙 수", "Người ký / 서명자", "Lý do hoàn tác / 취소사유"],
    outstanding:["ID", "Nhân viên / 직원", "Kỳ lương / 급여월", "Phải trả / 확정급여", "Đã trả ròng / 순지급", "Còn phải trả / 미지급", "Tình trạng / 상태"]
  };
  const list = (value) => Array.isArray(value) ? value : [];
  const text = (value) => value == null ? "" : String(value);
  const number = (value, label, fallback) => {
    if (value == null || value === "") {
      if (fallback !== undefined) return fallback;
      throw new Error(`Missing amount: ${label}`);
    }
    const result = Number(value);
    if (!Number.isFinite(result)) throw new Error(`Invalid amount: ${label}`);
    return result;
  };
  const amount = (value, label) => number(value, label, 0);
  const sum = (rows, getter) => rows.reduce((total,row)=>total+getter(row),0);
  function validateDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text(value))) throw new Error("Invalid report date");
    const date = new Date(value + "T00:00:00Z");
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0,10) !== value) throw new Error("Invalid report date");
    return value;
  }
  function monthOf(value) { return text(value).slice(0,7); }
  function previousMonth(month) { const date=new Date(`${month}-01T00:00:00Z`);date.setUTCMonth(date.getUTCMonth()-1);return date.toISOString().slice(0,7); }
  function dateCell(value) {
    if (!value) return "";
    if (/[T ]\d{2}:\d{2}.*(?:Z|[+-]\d{2}:?\d{2})$/.test(text(value))) {
      const vietnam=new Date(new Date(value).getTime()+7*60*60*1000);
      if (!Number.isFinite(vietnam.getTime())) throw new Error("Invalid timestamp in report");
      return new Date(vietnam.getUTCFullYear(),vietnam.getUTCMonth(),vietnam.getUTCDate(),vietnam.getUTCHours(),vietnam.getUTCMinutes(),vietnam.getUTCSeconds());
    }
    const match=/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(text(value));
    if (!match) return text(value);
    // Construct a local Date solely for the existing XLSX helper's local serial
    // conversion. This preserves Vietnamese wall-clock fields in every timezone.
    return new Date(+match[1],+match[2]-1,+match[3],+(match[4]||0),+(match[5]||0),+(match[6]||0));
  }
  function inputs(options) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(text(options.month))) throw new Error("Choose a payroll month");
    const fromDate=options.fromDate ? validateDate(options.fromDate) : null;
    const toDate=options.toDate ? validateDate(options.toDate) : null;
    if (!!fromDate !== !!toDate || (fromDate && fromDate>toDate)) throw new Error("Choose a valid inclusive date range");
    const unique=(rows,key)=>Array.from(new Map(rows.map(row=>[row[key],row])).values());
    return {...options,fromDate,toDate,employees:list(options.employees),terms:list(options.terms),records:list(options.records),days:list(options.days),
      runs:unique([...list(options.previousRuns),...list(options.runs)],"id"),
      payments:unique([...list(options.previousPayments),...list(options.payments)],"id"),
      adjustments:unique([...list(options.previousAdjustments),...list(options.adjustments)].map((row,index)=>({...row,id:row.id||`adjustment-${index}`})),"id"),
      reversals:list(options.reversals),attachments:list(options.attachments),summaries:list(options.summaries)};
  }
  function effectiveTerms(data,employeeId,month) {
    const end=new Date(`${month}-01T00:00:00Z`);end.setUTCMonth(end.getUTCMonth()+1);
    return data.terms.filter(term=>term.employee_id===employeeId && term.effective_from<end.toISOString().slice(0,10));
  }
  function partTime(data,employee,run) {
    const employeeType = run?.snapshot?.employee?.employment_type || run?.snapshot?.employment_type || employee?.employment_type || employee?.employee_type;
    if (["part_time","parttime","part-time"].includes(employeeType)) return true;
    if (["full_time","fulltime","regular"].includes(employeeType)) return false;
    const types=list(run?.snapshot?.payTypes);
    const terms=effectiveTerms(data,employee?.id||run?.employee_id,monthOf(run?.month)||data.month);
    const last=terms.sort((a,b)=>b.effective_from.localeCompare(a.effective_from))[0];
    return types.some(type=>type==="hourly"||type==="daily") || (!types.length && ["hourly","daily"].includes(last?.pay_type));
  }
  function paymentDetails(data,payment) {
    const reversals=data.reversals.filter(row=>row.payment_id===payment.id);
    const paid=number(payment.amount,"payment amount");
    const evidence=data.attachments.filter(row=>row.payment_id===payment.id);
    return {payment,paid,net:reversals.length?0:paid,reversed:reversals.length?paid:0,reversals,evidence};
  }
  function buildRows(data,month) {
    const monthRuns=data.runs.filter(run=>monthOf(run.month)===month);
    let summaries=data.summaries.filter(summary=>!summary.month || summary.month===month);
    if (!summaries.length && root.DGV_PAYROLL_CORE?.summarizeMonth) summaries=root.DGV_PAYROLL_CORE.summarizeMonth({month,employees:data.employees,terms:data.terms,records:data.records,days:data.days,today:data.today});
    const employees=new Map(data.employees.map(employee=>[employee.id,employee]));
    monthRuns.forEach(run=>{if(!employees.has(run.employee_id))employees.set(run.employee_id,{id:run.employee_id,name:run.snapshot?.name,device_user_id:run.snapshot?.device_user_id,active:false});});
    return [...employees.values()].filter(employee=>!data.employeeId||employee.id===data.employeeId).map(employee=>{
      const run=monthRuns.find(item=>item.employee_id===employee.id);
      const calculated=summaries.find(summary=>summary.employee_id===employee.id);
      const snapshot=run?.snapshot||calculated||{};
      const adjustments=run?data.adjustments.filter(row=>row.run_id===run.id):[];
      const correction=sum(adjustments,row=>number(row.amount,"adjustment amount"));
      const payments=run?data.payments.filter(payment=>payment.run_id===run.id).map(payment=>paymentDetails(data,payment)):[];
      const paid=sum(payments,row=>row.net);
      const approved=run?number(run.total,"approved payroll")+correction:null;
      const name=text(snapshot.name||snapshot.employee?.name||employee.name||employee.id);
      const base=run?number(run.base_amount,"base amount"):(snapshot.baseAmount==null?null:number(snapshot.baseAmount,"estimated base amount"));
      return {employee,employee_id:employee.id,name,device_user_id:text(snapshot.device_user_id||employee.device_user_id),month,run,snapshot,calculated,adjustments,correction,payments,paid,approved,
        outstanding:approved==null?null:approved-paid,base,parttime:partTime(data,employee,run),
        status:!run?"Chưa chốt / 미확정":approved-paid<0?"Kiểm tra số dư / 잔액 검토":approved-paid===0?"Đã trả / 지급 완료":paid>0?"Trả một phần / 일부 지급":"Chưa trả / 미지급"};
    }).filter(row=>row.run || row.employee.active!==false || list(row.snapshot.daily).length);
  }
  function warningsFor(data,rows) {
    const warnings=[];
    const warn=(row,code,message,reference="")=>warnings.push({employee_id:row.employee_id,name:row.name,code,message,reference});
    for(const row of rows) {
      if(!row.run) warn(row,"UNFINALIZED","Kiểm tra và chốt lương trước khi nộp / 급여 검토·확정 필요");
      for(const issue of list(row.snapshot.issues)) warn(row,"ATTENDANCE_OR_TERMS",text(issue));
      if(row.snapshot.reviewedBase) warn(row,"REVIEWED_BASE",`Lương đã xét: ${row.snapshot.reviewedBase.amount}; ${text(row.snapshot.reviewedBase.reason)} / 기본급 수동 검토`);
      if(row.outstanding<0) warn(row,"OVERPAYMENT","Số trả vượt lương được duyệt / 확정급여 초과 지급");
      if(row.snapshot.statutoryAmount==null && !list(row.snapshot.wageBreakdown).length) warn(row,"STATUTORY_REVIEW","Kiểm tra tăng ca, ngày nghỉ, ban đêm, thuế và bảo hiểm / 연장·휴일·야간·세금·보험 검토 필요");
      if(!row.employee.tax_reference && !row.employee.tax_id_masked) warn(row,"TAX_INFORMATION","Xác minh thông tin khai thuế với kế toán / 세무대리인에게 신고 인적사항 확인");
      for(const item of row.payments.filter(item=>item.net>0)) {
        if(!item.evidence.length) warn(row,"MISSING_EVIDENCE","Thiếu chứng từ thanh toán / 지급 증빙 누락",item.payment.id);
        if(item.payment.method==="cash" && !item.evidence.some(file=>file.evidence_type==="signature"||file.evidence_type==="receipt") && !item.payment.reference) warn(row,"CASH_ACKNOWLEDGEMENT","Thiếu xác nhận nhận tiền mặt / 현금 수령 확인 누락",item.payment.id);
        if(item.payment.method==="bank" && !item.payment.reference) warn(row,"BANK_REFERENCE","Thiếu mã giao dịch ngân hàng / 은행 거래번호 누락",item.payment.id);
      }
    }
    return warnings;
  }
  function summarizePayroll(options) {
    const data=inputs(options),rows=buildRows(data,data.month),previous=buildRows({...data,summaries:[]},previousMonth(data.month));
    const comparison=[...new Set([...rows.map(row=>row.employee_id),...previous.map(row=>row.employee_id)])].map(id=>{
      const current=rows.find(row=>row.employee_id===id),before=previous.find(row=>row.employee_id===id);
      return {employee_id:id,name:current?.name||before?.name,previousMonth:previousMonth(data.month),previousApproved:before?.approved??null,currentApproved:current?.approved??null,
        difference:current?.approved!=null&&before?.approved!=null?current.approved-before.approved:null,previousPaid:before?.paid||0,currentPaid:current?.paid||0};
    });
    return {month:data.month,rows,warnings:warningsFor(data,rows),comparison,totals:{approved:sum(rows,row=>row.approved||0),paid:sum(rows,row=>row.paid),outstanding:sum(rows,row=>row.outstanding||0),unfinalized:rows.filter(row=>!row.run).length}};
  }
  const cell=(value,style)=>({value,style:style||(value instanceof Date?"dateTime":typeof value==="number"&&Number.isInteger(value)?"integer":"normal")});
  function sheet(name,title,headers,body,widths,extraNotes=[]) {
    const raw=[[title],...extraNotes.map(note=>[note]),headers,...body];
    const headerIndex=extraNotes.length+1;
    return {name,columnWidths:widths||headers.map(()=>24),freezeRows:headerIndex+1,autoFilterRange:`A${headerIndex+1}:${column(headers.length)}${Math.max(headerIndex+1,raw.length)}`,
      rows:raw.map((row,index)=>row.map(value=>cell(value,index===0?"title":index===headerIndex?"header":index<headerIndex?"wrapped":undefined)))};
  }
  function column(count) {let result="";for(let n=count;n>0;n=Math.floor((n-1)/26))result=String.fromCharCode(65+(n-1)%26)+result;return result;}
  function ledgerBody(rows) {return rows.map(row=>[row.device_user_id,row.name,row.month,row.status,row.base,amount(row.run?.allowances,"allowances"),amount(row.run?.deductions,"deductions"),row.run?number(row.run.total,"total"):null,row.correction,row.approved,row.paid,row.outstanding,amount(row.snapshot.minutes,"minutes"),amount(row.snapshot.workedDays,"worked days"),row.run?0:amount(row.snapshot.unresolved,"unresolved")]);}
  function paymentBody(data,rows) {
    return rows.flatMap(row=>row.payments.map(item=>[item.payment.id,row.device_user_id,row.name,row.month,dateCell(item.payment.paid_on),item.payment.method==="cash"?"Tiền mặt / 현금":"Chuyển khoản / 이체",item.paid,item.reversed,item.net,text(item.payment.reference),text(item.payment.note),item.evidence.length,item.evidence.filter(file=>file.evidence_type==="signature").map(file=>text(file.signed_name)).join("; "),item.reversals.map(reversal=>text(reversal.reason)).join("; ")]));
  }
  function rangeRows(data) {
    if(!data.fromDate)return buildRows(data,data.month);
    const months=new Set(data.runs.map(run=>monthOf(run.month)));
    for(let date=new Date(data.fromDate+"T00:00:00Z");date.toISOString().slice(0,7)<=monthOf(data.toDate);date.setUTCMonth(date.getUTCMonth()+1,1)) {
      months.add(date.toISOString().slice(0,7));
      if(months.size>1200)throw new Error("Report range is too large");
    }
    return [...months].sort().flatMap(month=>buildRows({...data,summaries:[]},month));
  }
  function buildPayrollWorkbook(options) {
    const kind=options.kind||"tax";
    if(!KINDS.includes(kind))throw new Error("Unknown payroll export kind");
    const data=inputs(options),model=summarizePayroll(data),rows=model.rows;
    const scope=data.fromDate&&["attendance","cash","bank","parttime"].includes(kind)?`${data.fromDate}_${data.toDate}`:data.month;
    const title=`HANA · ${scope} · VND`;
    const ledger=()=>sheet("Bảng lương",title+" · Bảng lương / 급여대장",headings.ledger,ledgerBody(rows),[14,26,15,25,20,20,20,22,20,22,22,22,20,20,24]);
    const selectedRows=["attendance","cash","bank","parttime"].includes(kind)?rangeRows(data):rows;
    const inRange=(date)=>!data.fromDate||(text(date).slice(0,10)>=data.fromDate&&text(date).slice(0,10)<=data.toDate);
    const attendance=()=>sheet("Chấm công",title+" · Chấm công / 출퇴근",headings.attendance,selectedRows.flatMap(row=>list(row.snapshot.daily).filter(day=>inRange(day.date)).map(day=>[row.device_user_id,row.name,dateCell(day.date),dateCell(day.checkIn),dateCell(day.checkOut),amount(day.minutes,"minutes"),amount(day.lateMinutes,"late"),amount(day.earlyMinutes,"early"),amount(day.extraMinutes,"extra"),text(day.dayType),text(day.status),list(day.issues).join("; "),row.run?"Bản đã chốt / 확정 당시":"Hiện tại / 현재"])),[14,26,23,23,23,20,20,20,27,22,22,65,24]);
    const selectedPayments=selectedRows.filter(row=>kind!=="parttime"||row.parttime).map(row=>({...row,payments:row.payments.filter(item=>inRange(item.payment.paid_on)&&(!["cash","bank"].includes(kind)||item.payment.method===kind))}));
    const payments=()=>sheet(kind==="cash"?"Tiền mặt":kind==="bank"?"Chuyển khoản":kind==="parttime"?"Bán thời gian":"Thanh toán",title+" · Thanh toán / 지급내역",headings.payment,paymentBody(data,selectedPayments),[40,14,26,16,23,23,22,20,22,40,55,18,30,55],[data.fromDate?"Theo ngày trả thực tế / 실제 지급일 기준":"Theo kỳ lương; ngày trả có thể khác tháng / 급여 대상월 기준, 실제 지급일 별도"]);
    const outstanding=()=>sheet("Còn phải trả",title+" · Còn phải trả / 미지급",headings.outstanding,rows.filter(row=>row.run&&row.outstanding!==0).map(row=>[row.device_user_id,row.name,row.month,row.approved,row.paid,row.outstanding,row.status]),[14,26,16,22,22,22,30]);
    let sheets;
    if(kind==="ledger")sheets=[ledger()];
    else if(kind==="attendance")sheets=[attendance()];
    else if(["cash","bank","parttime"].includes(kind))sheets=[payments()];
    else if(kind==="outstanding")sheets=[outstanding()];
    else {
      const employees=sheet("Nhân viên",title+" · Nhân viên / 직원정보",["ID","Nhân viên / 직원","Loại / 고용형태","Điện thoại / 연락처","Ngày vào / 입사일","Ngày nghỉ / 퇴사일","Tình trạng / 재직상태","Cách trả / 지급방법","Hồ sơ thuế / 세무정보"],rows.map(row=>[row.device_user_id,row.name,row.parttime?"Bán thời gian / 파트타임":"Toàn thời gian / 정규직",text(row.employee.phone),dateCell(row.employee.hire_date),dateCell(row.employee.termination_date),text(row.employee.employment_status||(row.employee.active!==false?"Đang làm / 재직":"Ngừng làm / 비활성")),text(row.employee.payment_method),text(row.employee.tax_reference||row.employee.tax_id_masked||"Xác minh riêng / 별도 확인")]),[14,26,30,25,23,23,27,24,50]);
      const legal=sheet("Khoản lương",title+" · Chi tiết tiền lương / 급여 세부항목",["Nhân viên / 직원","Ngày / 일자","Loại ngày / 구분","Mã / 항목코드","Khoản / 항목","Phút / 분","Đơn giá / 단가","Hệ số / 배율","VND","Phiên bản / 계산 버전"],rows.flatMap(row=>list(row.snapshot.wageBreakdown).map(item=>[row.name,dateCell(item.date),text(item.dayType),text(item.code),text(item.label),item.minutes==null?null:number(item.minutes,"item minutes"),item.rate==null?null:number(item.rate,"item rate"),item.multiplier==null?null:number(item.multiplier,"item multiplier"),number(item.amount,"item amount"),text(row.snapshot.calculationVersion)])),[26,23,22,24,45,18,20,18,22,23],["Các khoản theo bản đã duyệt; kế toán kiểm tra nghĩa vụ pháp lý / 승인된 계산 내역, 법정·신고 판단은 세무 검토"]);
      const corrections=sheet("Điều chỉnh",title+" · Điều chỉnh và hoàn tác / 정정·취소",["Nhân viên / 직원","Loại / 구분","Mã gốc / 원기록 ID","Ngày ghi / 기록일","VND (+/-)","Lý do / 사유","Người ghi / 담당자"],rows.flatMap(row=>[
        ...row.adjustments.map(item=>[row.name,"Điều chỉnh lương / 급여 정정",row.run.id,dateCell(item.created_at),number(item.amount,"adjustment"),text(item.reason),text(item.created_by)]),
        ...row.payments.flatMap(item=>item.reversals.map(reversal=>[row.name,"Hoàn tác trả / 지급 취소",item.payment.id,dateCell(reversal.created_at),-item.paid,text(reversal.reason),text(reversal.created_by)]))]),[26,30,40,24,22,65,40]);
      const evidence=sheet("Chứng từ",title+" · Chứng từ và xác nhận / 증빙·수령확인",["Nhân viên / 직원","Mã trả / 지급 ID","Loại / 증빙종류","Tên tệp / 파일명","Người ký / 서명자","Đã nhận lúc / 수령확인 시각","Thời gian / 저장시각","Bytes","Vị trí nội bộ / 내부 저장위치","Tình trạng trả / 지급상태"],rows.flatMap(row=>row.payments.flatMap(item=>item.evidence.map(file=>[row.name,item.payment.id,text(file.evidence_type),text(file.filename),text(file.signed_name),dateCell(file.acknowledged_at),dateCell(file.created_at),amount(file.byte_size,"attachment bytes"),text(file.storage_path),item.reversed?"Đã hoàn tác / 지급 취소":"Có hiệu lực / 유효"]))),[26,40,25,45,30,24,24,18,70,27],["Tệp riêng tư: tải từ trang quản trị, không công khai URL / 비공개 파일은 관리자 페이지에서 내려받기"]);
      const reviews=sheet("Cần kiểm tra",title+" · Kế toán kiểm tra / 세무 검토",["Nhân viên / 직원","Mã / 코드","Nội dung / 확인 사항","Tham chiếu / 관련 ID"],model.warnings.map(warning=>[warning.name,warning.code,warning.message,warning.reference]),[26,30,95,40]);
      const comparison=sheet("So sánh tháng",title+" · So sánh kỳ trước / 전월 비교",["Nhân viên / 직원","Kỳ trước / 전월","Lương kỳ trước / 전월 확정","Kỳ này / 당월","Lương kỳ này / 당월 확정","Chênh lệch / 차이","Đã trả kỳ trước / 전월 순지급","Đã trả kỳ này / 당월 순지급"],model.comparison.map(row=>[row.name,row.previousMonth,row.previousApproved,data.month,row.currentApproved,row.difference,row.previousPaid,row.currentPaid]),[26,18,25,18,25,22,29,29]);
      const cover=sheet("Hồ sơ lương",title+" · Hồ sơ gửi kế toán / 세무대리인 전달자료",["Chỉ tiêu / 항목","Giá trị / 값"],[["Kỳ lương / 급여 대상월",data.month],["Lương đã duyệt, gồm điều chỉnh / 정정 포함 확정급여",model.totals.approved],["Đã thanh toán ròng / 취소 반영 순지급",model.totals.paid],["Còn phải trả / 미지급",model.totals.outstanding],["Nhân viên chưa chốt / 미확정 직원",model.totals.unfinalized],["Mục cần kiểm tra / 검토 사항",model.warnings.length],["Cơ sở / 기준","Kỳ lương; ngày trả thực tế được ghi riêng / 급여 대상월, 실제 지급일 별도"],["Tránh ghi trùng / 중복 계상 방지","Không cộng lương và tiền đã trả thành chi phí. Không tự ghi vào chi phí nhà hàng. / 급여와 지급액을 비용으로 합산하지 않으며 식당 지출에 자동 전기하지 않습니다."],["Kế toán xác nhận / 세무 검토","Xác minh thuế TNCN, bảo hiểm, hợp đồng và chứng từ trước khi khai / 신고 전 개인소득세·보험·계약·증빙 확인"]],[75,105]);
      sheets=[cover,ledger(),employees,attendance(),payments(),outstanding(),legal,corrections,evidence,reviews,comparison];
    }
    return {filename:`HANA_${names[kind]}_${scope}${data.employeeId?"_Nhan_vien":""}.xlsx`,sheets};
  }
  const htmlEscape=(value)=>text(value).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;");
  function printValue(value) {
    if(value instanceof Date) {
      const pad=part=>String(part).padStart(2,"0");
      return `${value.getFullYear()}-${pad(value.getMonth()+1)}-${pad(value.getDate())}${value.getHours()||value.getMinutes()?` ${pad(value.getHours())}:${pad(value.getMinutes())}`:""}`;
    }
    if(typeof value==="number")return new Intl.NumberFormat("vi-VN",{maximumFractionDigits:4}).format(value);
    return text(value);
  }
  function buildPayrollPrintHtml(options) {
    const workbook=buildPayrollWorkbook(options);
    const sections=workbook.sheets.map(sheet=>{
      const raw=sheet.rows.map(row=>row.map(item=>item&&typeof item==="object"&&"value"in item?item.value:item));
      const headerIndex=sheet.freezeRows-1;
      const headers=raw[headerIndex]||[];
      const notes=raw.slice(1,headerIndex).map(row=>`<p class="note">${row.map(value=>htmlEscape(printValue(value))).join(" · ")}</p>`).join("");
      const body=raw.slice(sheet.freezeRows);
      return `<section class="report"><header><p class="brand">CÔNG TY TNHH DGV · HANA</p><h1>${htmlEscape(raw[0]?.[0]||sheet.name)}</h1>${notes}</header><table class="${headers.length>10?"wide":""}"><thead><tr>${headers.map(value=>`<th scope="col">${htmlEscape(printValue(value))}</th>`).join("")}</tr></thead><tbody>${body.length?body.map(row=>`<tr>${headers.map((_,index)=>`<td${typeof row[index]==="number"?' class="number"':""}>${htmlEscape(printValue(row[index]))}</td>`).join("")}</tr>`).join(""):`<tr><td colspan="${headers.length}">Không có dữ liệu / 해당 자료 없음</td></tr>`}</tbody></table><footer>Hồ sơ lương nội bộ — kế toán xác nhận trước khi khai / 급여 내부자료 · 신고 전 세무대리인 확인</footer></section>`;
    }).join("");
    return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'"><title>${htmlEscape(workbook.filename.replace(/\.xlsx$/,""))}</title><style>
      @page{size:A4 landscape;margin:10mm}*{box-sizing:border-box}body{margin:0;color:#171717;background:#eaeaea;font-family:Arial,"Malgun Gothic",sans-serif;font-size:10pt}.report{background:white;max-width:277mm;margin:8mm auto;padding:8mm;border:1px solid #333;break-after:page}.report:last-child{break-after:auto}.brand{font-size:10pt;font-weight:bold;margin:0 0 4mm}h1{font-size:15pt;margin:0 0 5mm;overflow-wrap:anywhere}.note{font-size:9pt;line-height:1.45;margin:2mm 0}table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:9pt;margin-top:4mm}table.wide{font-size:8pt}th,td{border:1px solid #555;padding:2mm 1.5mm;text-align:left;vertical-align:top;overflow-wrap:anywhere}th{background:#eee;font-weight:bold}td.number{text-align:right;font-variant-numeric:tabular-nums;overflow-wrap:normal}thead{display:table-header-group}tr{break-inside:avoid}footer{font-size:8pt;margin-top:4mm;line-height:1.5}@media print{body{background:white}.report{max-width:none;margin:0;padding:0;border:0}.report+ .report{break-before:page}th{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
    </style></head><body>${sections}</body></html>`;
  }
  root.DGV_PAYROLL_TAX=Object.freeze({KINDS,buildPayrollWorkbook,buildPayrollPrintHtml,summarizePayroll});
})(typeof globalThis!=="undefined"?globalThis:window);
