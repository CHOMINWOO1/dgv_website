(function(root){
  "use strict";
  const FORMAT="DGV_PAYROLL_RECEIPTS",MAX_IMAGES=1000,MAX_IMAGE_BYTES=40*1024*1024;
  const cell=(value,style)=>({value,style});
  const number=value=>{
    const parsed=typeof value==="string"&&/^\d+$/.test(value)?Number(value):value;
    if(!Number.isSafeInteger(parsed)||parsed<0)throw new Error("지급액을 확인한 뒤 다시 조회하세요. / Kiểm tra số tiền rồi tra cứu lại.");
    return parsed;
  };
  const add=(total,value)=>number(total+number(value));
  function text(value,required=false){
    if(value==null&&!required)return "";
    if(typeof value!=="string"||(required&&!value.trim()))throw new Error("지급 내역의 직원·서명 정보를 다시 확인하세요. / Kiểm tra thông tin nhân viên và chữ ký.");
    return value;
  }
  function date(value){
    if(typeof value!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(value))throw new Error("지급 조회기간·날짜를 확인하세요. / Kiểm tra ngày thanh toán.");
    const parsed=Date.parse(value+"T00:00:00Z");
    if(!Number.isFinite(parsed)||new Date(parsed).toISOString().slice(0,10)!==value)throw new Error("유효하지 않은 지급 날짜입니다. / Ngày thanh toán không hợp lệ.");
    return value;
  }
  function excelDate(value){
    // The writer receives a numeric date serial, so the exporting phone's
    // timezone cannot move a Vietnam payment date to the previous day.
    const day=date(value),serial=Date.parse(day+"T00:00:00Z")/86400000+25569-(day<"1900-03-01"?1:0);
    if(serial<1)throw new Error("Excel에 표시할 수 있는 지급 날짜인지 확인하세요. / Kiểm tra ngày có thể hiển thị trong Excel.");
    return serial;
  }
  function signedTime(value){
    const parts=typeof value==="string"&&/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
    if(!parts||+parts[2]>23||+parts[3]>59||+parts[4]>59)throw new Error("서명 시각을 확인한 뒤 다시 조회하세요. / Kiểm tra giờ ký rồi tra cứu lại.");
    date(parts[1]);const time=Date.parse(value);
    if(!Number.isFinite(time))throw new Error("유효하지 않은 서명 시각입니다. / Giờ ký không hợp lệ.");
    return new Date(time+7*3600000).toISOString().slice(0,19).replace("T"," ");
  }
  function imageSize(dataUrl){
    // Read only the already validated PNG IHDR dimensions; the native writer
    // embeds the original bytes unchanged and validates the full PNG again.
    const alphabet="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/",raw=dataUrl.slice(dataUrl.indexOf(",")+1),bytes=[];
    for(let i=0;i<32;i+=4){
      const value=(alphabet.indexOf(raw[i])<<18)|(alphabet.indexOf(raw[i+1])<<12)|(alphabet.indexOf(raw[i+2])<<6)|alphabet.indexOf(raw[i+3]);
      bytes.push((value>>>16)&255,(value>>>8)&255,value&255);
    }
    const u32=index=>bytes[index]*16777216+(bytes[index+1]<<16)+(bytes[index+2]<<8)+bytes[index+3];
    const width=u32(16),height=u32(20),scale=Math.min(100/width,25/height);
    return {width:width*scale,height:height*scale,bytes:raw.length/4*3-(raw.endsWith("==")?2:raw.endsWith("=")?1:0)};
  }
  function lineCount(value,width){
    return String(value).split("\n").reduce((count,line)=>count+Math.max(1,Math.ceil(Array.from(line).reduce((size,char)=>size+(char.charCodeAt(0)>255?2:1),0)/width)),0);
  }
  function workDates(detail){
    const dates=Array.isArray(detail.workDates)?[...new Set(detail.workDates.map(date))].sort():[];
    const days=detail.workedDays==null?null:number(detail.workedDays),lines=[];
    // Keep every actual date visible. Explicit two-date lines let the row-height
    // calculation reserve enough space even for all 31 days in the month.
    for(let index=0;index<dates.length;index+=2)lines.push(dates.slice(index,index+2).map(day=>day.slice(5).replace("-","/")).join(", "));
    const display=lines.join("\n");
    return display+(days==null?"":`${display?"\n":""}${days}일 / ngày`)+(dates.length||days===null?"":"\n일자 자료 없음 / Chưa có ngày chi tiết")||"—";
  }
  function workTime(value){
    if(value==null)return "—";
    if(typeof value!=="number"||!Number.isFinite(value)||value<0)throw new Error("근무시간을 확인하세요. / Kiểm tra giờ làm.");
    const remainder=Number((value%60).toFixed(2));return `${Math.floor(value/60)}시간 ${remainder}분\n${Math.floor(value/60)} giờ ${remainder} phút`;
  }
  const sourceLabel=source=>source==="finalized"?"확정 / Đã chốt":source==="calculated"?"계산† / Tạm tính†":"자료 없음 / Chưa có dữ liệu";
  const commonDetailNotes=new Set([
    "현재 월 계산값 · 지급 당시 확정액 아님 / Dự tính hiện tại, chưa chốt khi trả",
    "수기 수당·공제 미확정 / Phụ cấp, khấu trừ thủ công chưa chốt"
  ]);
  function specificDetailNote(value){
    const note=text(value);if(commonDetailNotes.has(note))return "";
    const extra=/^자동 계산 추가급여 ([0-9,]+) VND · 수기 수당·공제 미확정 \/ Phần tự tính; phụ cấp, khấu trừ thủ công chưa chốt$/.exec(note);
    return extra?`자동 계산 추가급여 / Phần tự tính: ${extra[1]} VND`:note;
  }
  function buildWorkbook(model,options={}){
    const receipts=root.DGV_PAYROLL_RECEIPTS;
    if(!receipts?.isPngDataUrl||!receipts.buildReportGroups||model?.format!==FORMAT||model.version!==1||model.kind==="service"||!Array.isArray(model.rows))throw new Error("급여 지급 내역을 다시 조회하세요. / Tra cứu lại thanh toán lương.");
    const from=date(model.fromDate),to=date(model.toDate);
    if(from>to)throw new Error("조회 시작일이 종료일보다 늦습니다. / Ngày bắt đầu sau ngày kết thúc.");
    const generatedOn=date(options.generatedOn||new Date(Date.now()+7*3600000).toISOString().slice(0,10));
    const records=[],paymentIds=new Set(),signatureIds=new Set(),employeeIds=new Set();
    let total=0,cash=0,bank=0,other=0,cashCount=0,bankCount=0,otherCount=0,signedCount=0,imageBytes=0;
    for(const source of model.rows){
      // Filter before reading private fields or image getters. The workbook
      // never restores a canceled row or trusts cached summary totals.
      if(source?.status!=="paid")continue;
      const paidOn=date(source.paidOn);
      if(paidOn<from||paidOn>to||(model.employeeId&&source.employeeId!==model.employeeId))continue;
      const paymentId=text(source.paymentId,true),employeeId=text(source.employeeId,true);
      if(paymentIds.has(paymentId))throw new Error("지급 내역이 중복됩니다. 다시 조회하세요. / Khoản trả bị trùng; tra cứu lại.");
      paymentIds.add(paymentId);employeeIds.add(employeeId);
      const amount=number(source.amount);if(!amount)throw new Error("지급액은 0보다 커야 합니다. / Khoản trả phải lớn hơn 0.");
      const month=text(source.month,true);if(!/^\d{4}-\d{2}$/.test(month))throw new Error("급여월을 확인하세요. / Kiểm tra kỳ lương.");date(month+"-01");
      if(!Array.isArray(source.signatures))throw new Error("서명 내역을 다시 조회하세요. / Tải lại danh sách chữ ký.");
      const signatures=source.signatures.map(signature=>{
        const attachmentId=text(signature.attachmentId,true);
        if(signatureIds.has(attachmentId)||signature.imageStatus!=="loaded"||!receipts.isPngDataUrl(signature.imageDataUrl))throw new Error("저장된 서명을 모두 불러온 뒤 다운로드하세요. / Tải đầy đủ chữ ký đã lưu trước khi tải Excel.");
        signatureIds.add(attachmentId);
        const size=imageSize(signature.imageDataUrl);imageBytes+=size.bytes;
        if(signatureIds.size>MAX_IMAGES||imageBytes>MAX_IMAGE_BYTES)throw new Error("서명 용량이 큽니다. 조회기간이나 직원을 나누어 다운로드하세요. / Chọn kỳ ngắn hơn hoặc ít nhân viên hơn.");
        return {attachmentId,dataUrl:signature.imageDataUrl,width:size.width,height:size.height,name:text(signature.signedName,true).replace(/\s+/g," ").trim(),time:signedTime(signature.acknowledgedAt)};
      });
      if(signatures.length)signedCount++;
      const method=text(source.method);total=add(total,amount);
      if(method==="cash"){cash=add(cash,amount);cashCount++;}else if(method==="bank"){bank=add(bank,amount);bankCount++;}else{other=add(other,amount);otherCount++;}
      records.push({paymentId,employeeId,paidOn,month,amount,method,signatures,status:"paid",name:text(source.name,true),deviceUserId:text(source.deviceUserId),nationalId:text(source.nationalId),phone:text(source.phone),isAdvance:Boolean(source.isAdvance),payrollStatus:source.payrollStatus,employmentType:source.employmentType,detail:source.detail,issues:Array.isArray(source.issues)?source.issues.map(value=>text(value)):[]});
    }

    const groups=receipts.buildReportGroups({format:FORMAT,version:1,fromDate:from,toDate:to,employeeId:model.employeeId,rows:records,totals:{}});
    const rows=[],rowHeights=[],merges=[],images=[],detailNotes=[];
    const append=(values,height=18,style="receiptText")=>{rows.push(Array.from({length:11},(_,index)=>values[index]?.style?values[index]:cell(values[index]??"",style)));rowHeights.push(height);return rows.length;};
    const merged=(start,end,row)=>merges.push(`${start}${row}:${end}${row}`);
    append(["HANA 직원 급여 지급대장"],23,"receiptTitle");merged("A","K",1);
    append(["BẢNG THANH TOÁN TIỀN LƯƠNG"],16,"receiptNote");merged("A","K",2);
    append(["법인 / Công ty\nDGV · HANA Restaurant","","","",`지급 조회기간 / Kỳ thanh toán\n${from} ~ ${to}`,"","","",model.employeeId?"대상 / Đối tượng\n선택 직원 / Nhân viên đã chọn":"대상 / Đối tượng\n전체 직원 / Tất cả nhân viên"],29,"receiptMeta");
    append([`작성일 / Ngày lập\n${generatedOn} (UTC+7)`,"","","",`지급 ${records.length}건 · 직원 ${employeeIds.size}명\n${records.length} khoản trả · ${employeeIds.size} nhân viên`,"","","",`서명 등록 ${signedCount}건 · 미등록 ${records.length-signedCount}건\nĐã ký ${signedCount} · Chưa ký ${records.length-signedCount}`],29,"receiptMeta");
    for(const row of[3,4]){merged("A","D",row);merged("E","H",row);merged("I","K",row);}
    append([],6,"normal");
    append(["번호\nSTT","직원 / 코드\nNhân viên / Mã","근무일\nNgày làm","실근무\nGiờ làm thực tế","시급 (VND)\nĐơn giá giờ","기본급 (VND)\nLương cơ bản","수당\nPhụ cấp","공제\nKhấu trừ","실지급액 (VND)\nSố tiền đã trả","지급수단\nHình thức","수령확인\nKý nhận"],28,"receiptHeader");
    let sequence=0,section;
    for(const group of groups){
      if(section!==group.employmentType){
        section=group.employmentType;
        const label=section==="part_time"?"파트타임 / Nhân viên bán thời gian":section==="full_time"?"정규직 / Nhân viên toàn thời gian":"고용유형 확인 필요 / Cần kiểm tra loại nhân viên";
        const row=append([label],20,"receiptTotal");merged("A","K",row);
      }
      const detail=group.detail,rates=Array.isArray(detail.hourlyRates)?detail.hourlyRates:[];
      if(rates.some(rate=>typeof rate!=="number"||!Number.isFinite(rate)||rate<0))throw new Error("시급 자료를 확인하세요. / Kiểm tra đơn giá giờ.");
      const rate=rates.length===1?rates[0]:rates.length?rates.map(value=>value.toLocaleString("en-US",{maximumFractionDigits:2})).join(" / "):"—";
      const monthly=[workDates(detail),workTime(detail.minutes),rate,...[detail.baseAmount,detail.allowances,detail.deductions].map(value=>value==null?"—":number(value))];
      const notes=Array.isArray(detail.issues)?detail.issues.map(specificDetailNote).filter(Boolean):[];
      if(detail.rateLabel)notes.push(text(detail.rateLabel));
      if(detail.adjustmentAmount){if(!Number.isSafeInteger(detail.adjustmentAmount))throw new Error("조정액을 확인하세요. / Kiểm tra khoản điều chỉnh.");notes.push(`별도 조정액 / Điều chỉnh riêng: ${detail.adjustmentAmount.toLocaleString("en-US")} VND`);}
      detailNotes.push(...notes.map(note=>`${group.name} · ${group.month}: ${note}`));
      group.rows.forEach((record,groupIndex)=>{
        const index=sequence++,suffix=index%2===1?"Alt":"",firstRow=rows.length+1,count=Math.max(1,record.signatures.length);
        const method=(record.method==="cash"?"현금 / Tiền mặt":record.method==="bank"?"계좌이체 / Chuyển khoản":"확인 필요 / Cần kiểm tra")+(record.isAdvance?" ‡":"")+"\n지급일 / Ngày trả";
        const employee=`${record.name}${record.deviceUserId?" ["+record.deviceUserId+"]":""}\nID / CCCD: ${record.nationalId||"—"}\n전화 / ĐT: ${record.phone||"—"}\n${record.month} · ${sourceLabel(detail.source)}`;
        const values=[String(index+1).padStart(2,"0"),employee,...(groupIndex===0?monthly:Array(6).fill("")),record.amount,method];
        const textWidths=[4,27,17,12,13,14,11,11,15,15];
        const bodyHeight=Math.max(38,...values.map((value,column)=>typeof value==="string"?Math.ceil((lineCount(value,textWidths[column])*11+6-(column<9?14:0))/count):0));
        for(let part=0;part<count;part++){
          const signature=record.signatures[part],signatureText=signature?`${signature.name}\n${signature.time}`:"서명 미등록 / Chưa ký";
          const height=Math.max(bodyHeight,signature?Math.ceil(23+lineCount(signatureText,25)*10+4-(part===count-1?14:0)):38);
          if(height>409)throw new Error("직원·서명 정보가 너무 깁니다. 내용을 확인하세요. / Thông tin nhân viên hoặc chữ ký quá dài.");
          const styled=Array.from({length:11},(_,column)=>cell(part===0?values[column]??"":"",column===4&&typeof values[column]==="number"?"receiptRate"+suffix:[5,6,7,8].includes(column)&&typeof values[column]==="number"?"receiptInteger"+suffix:[0,2,3,4,5,6,7,9].includes(column)?"receiptCenter"+suffix:"receiptText"+suffix));
          styled[10]=cell(signatureText,"receiptSignature"+suffix);
          const row=append(styled,height);
          if(signature)images.push({dataUrl:signature.dataUrl,row:row-1,column:10,offsetX:6,offsetY:4,width:signature.width,height:signature.height,description:`급여 수령 서명 / Chữ ký nhận lương · Payment ${record.paymentId} · Attachment ${signature.attachmentId}`});
        }
        const lastProof=rows.length;
        append(Array.from({length:11},(_,column)=>cell(column===9?excelDate(record.paidOn):"",column===9?"receiptDate"+suffix:column===10?"receiptSignature"+suffix:"receiptText"+suffix)),14);
        for(const column of"ABCDEFGHI")merges.push(`${column}${firstRow}:${column}${rows.length}`);
        if(count>1)merges.push(`J${firstRow}:J${lastProof}`);
        merges.push(`K${lastProof}:K${rows.length}`);
      });
    }
    if(!records.length){const row=append(["선택기간 지급 내역 없음 / Không có khoản trả trong kỳ"],32,"receiptCenter");merged("A","K",row);}
    let row=append([`합계 / Tổng cộng · ${records.length}건 / ${employeeIds.size}명`,...Array(7).fill(""),cell(total,"receiptTotalNumber"),`현금 ${cashCount}건 · 계좌 ${bankCount}건${otherCount?"\n수단 확인 필요 "+otherCount+"건":""}`,`서명 등록 ${signedCount}건\nĐã ký: ${signedCount}`],32,"receiptTotal");merged("A","H",row);
    append([],4,"normal");
    row=append([cell("지급 합계 (VND)\nTổng đã trả","receiptAccent"),"",cell(total,"receiptTotalNumber"),"현금 (VND)\nTiền mặt","",cell(cash,"receiptTotalNumber"),"계좌이체 (VND)\nChuyển khoản","","","",cell(bank,"receiptTotalNumber")],26,"receiptMeta");
    merged("A","B",row);merged("D","E",row);merged("G","J",row);
    if(otherCount){row=append(["지급수단 확인 필요 (VND) / Cần kiểm tra hình thức thanh toán",...Array(7).fill(""),cell(other,"receiptTotalNumber")],24,"receiptMeta");merged("A","H",row);merged("I","K",row);}
    append([],4,"normal");
    row=append(["작성자 / Người lập\n\n________________","","","관리자 확인 / Người duyệt\n\n________________","","","세무대리인 검토 / Kế toán\n\n________________","","첨부 / Hồ sơ kèm theo\n지급 건별 수령 서명\nChữ ký theo từng khoản trả"],36,"receiptText");
    merged("A","C",row);merged("D","F",row);merged("G","H",row);merged("I","K",row);
    const footers=["지급일 기준 (양끝 포함) · 서명시각: 베트남 / Theo ngày trả, gồm hai ngày biên; giờ ký: Việt Nam (UTC+7).","근무·급여 내역은 직원별 급여월 전체 기준 1회 표시하며, 실지급액은 지급 건별입니다. / Chi tiết lương tháng hiển thị một lần; số tiền đã trả theo từng khoản.","—: 자료 없음 (0원 아님) / Chưa có dữ liệu (không phải 0)."];
    if(groups.some(group=>group.detail.source==="calculated"))footers.push("† 현재 월 계산값 · 지급 당시 확정액 아님 · 수기 수당·공제 미확정 / Dự tính hiện tại, chưa chốt khi trả; phụ cấp, khấu trừ thủ công chưa chốt.");
    if(records.some(record=>record.isAdvance))footers.push("‡ 선지급·수시지급 / Tạm trả");
    for(const footer of footers){row=append([footer],Math.max(14,lineCount(footer,180)*10),"receiptNote");merged("A","K",row);}
    const issues=[...new Set([...detailNotes,...records.flatMap(record=>record.issues.map(issue=>`${record.name} · ${record.month}: ${issue}`))])];
    for(const issue of issues){const height=Math.max(18,lineCount(issue,180)*12);if(height>409)throw new Error("검토 내용이 너무 깁니다. 내용을 확인하세요. / Nội dung kiểm tra quá dài.");row=append([issue],height,"receiptNote");merged("A","K",row);}
    return {filename:`HANA_급여지급대장_${from}_${to}_작성${generatedOn}.xlsx`,sheets:[{name:"급여 지급대장",rows,rowHeights,merges,images,columnWidths:[5,30,20,14,15,16,13,13,17,17,27],showGridLines:false,freezeRows:6,printSettings:{paperSize:"A4",orientation:"landscape",fitToWidth:1,fitToHeight:0,printArea:`A1:K${rows.length}`,repeatRows:"6:6",margins:{left:.315,right:.315,top:.315,bottom:.315,header:.15,footer:.15}}}]};
  }
  root.DGV_PAYROLL_RECEIPTS_XLSX=Object.freeze({buildWorkbook});
})(typeof window!=="undefined"?window:globalThis);
