(function(root){
  "use strict";
  const FORMAT="DGV_PAYROLL_RECEIPTS",MAX_IMAGE_BYTES=5242880;
  const array=value=>Array.isArray(value)?value:[];
  const text=value=>value==null?"":String(value);
  const escape=value=>text(value).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  function date(value){
    if(typeof value!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(value))throw new Error("지급 조회기간·날짜를 확인하세요. / Kiểm tra ngày thanh toán.");
    const result=new Date(value+"T00:00:00Z");
    if(!Number.isFinite(result.getTime())||result.toISOString().slice(0,10)!==value)throw new Error("유효하지 않은 지급 날짜입니다. / Ngày thanh toán không hợp lệ.");
    return value;
  }
  function month(value){
    const result=text(value);
    if(/^\d{4}-\d{2}$/.test(result)){date(result+"-01");return result;}
    date(result);return result.slice(0,7);
  }
  function timestamp(value){
    if(typeof value!=="string")return null;
    const m=/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
    if(!m||+m[2]>23||+m[3]>59||+m[4]>59||(+m[6]||0)>23||(+m[7]||0)>59)return null;
    try{date(m[1]);}catch{return null;}
    const milliseconds=Date.parse(value);if(!Number.isFinite(milliseconds))return null;
    return new Date(milliseconds+7*3600000).toISOString().slice(0,19).replace("T"," ");
  }
  function amount(value){
    if(typeof value!=="number"&&!(typeof value==="string"&&/^\d+$/.test(value)))throw new Error("지급액을 확인하세요. / Kiểm tra số tiền.");
    const result=Number(value);if(!Number.isSafeInteger(result)||result<0)throw new Error("유효하지 않은 지급액입니다. / Số tiền không hợp lệ.");return result;
  }
  function sum(values){return values.reduce((total,value)=>{const result=total+value;if(!Number.isSafeInteger(result))throw new Error("지급 합계가 너무 큽니다. / Tổng tiền quá lớn.");return result;},0);}
  function canonical(value){if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==="object")return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));return value;}
  function unique(rows,label){
    const result=new Map();for(const row of array(rows)){
      if(!row||typeof row.id!=="string"||!row.id)throw new Error(`${label} ID를 확인하세요. / Kiểm tra mã dữ liệu.`);
      if(result.has(row.id)&&JSON.stringify(canonical(result.get(row.id)))!==JSON.stringify(canonical(row)))throw new Error(`${label} 중복 데이터가 다릅니다. 새로고침하세요. / Dữ liệu trùng không khớp. Tải lại.`);
      result.set(row.id,row);
    }return [...result.values()];
  }
  function personalText(value){
    if(value==null)return "";
    if(typeof value!=="string"||value.length>300||/[\u0000-\u001f\u007f]/.test(value))throw new Error("직원 식별·연락 정보를 확인하세요. / Kiểm tra thông tin định danh và liên hệ.");
    return value.trim();
  }
  function identityMap(values){
    if(values!=null&&!Array.isArray(values))throw new Error("직원 식별정보를 확인하세요. / Kiểm tra thông tin định danh.");
    const result=new Map();
    for(const value of array(values)){
      if(!value||typeof value.employee_id!=="string"||!value.employee_id)throw new Error("직원 식별정보를 확인하세요. / Kiểm tra thông tin định danh.");
      const nationalId=personalText(value.national_id);
      if(result.has(value.employee_id)&&result.get(value.employee_id)!==nationalId)throw new Error("직원 식별정보가 중복되어 일치하지 않습니다. / Thông tin định danh trùng không khớp.");
      result.set(value.employee_id,nationalId);
    }
    return result;
  }
  function activeTotals(rows){
    const total=sum(rows.map(row=>amount(row.amount)));
    return {count:rows.length,total,activeCount:rows.length,activeTotal:total,unsignedCount:rows.filter(row=>row.signatureStatus==="unsigned").length,
      unavailableCount:rows.filter(row=>row.signatureStatus==="unavailable").length,signedCount:rows.filter(row=>row.signatureStatus==="signed").length};
  }
  const crcTable=Uint32Array.from({length:256},(_,value)=>{let crc=value;for(let i=0;i<8;i++)crc=crc&1?0xedb88320^(crc>>>1):crc>>>1;return crc>>>0;});
  function crc32(bytes,start,end){let crc=0xffffffff;for(let i=start;i<end;i++)crc=crcTable[(crc^bytes[i])&255]^(crc>>>8);return (crc^0xffffffff)>>>0;}
  function pngBytes(value){
    const prefix="data:image/png;base64,";
    if(typeof value!=="string"||!value.startsWith(prefix)||value.length>prefix.length+Math.ceil(MAX_IMAGE_BYTES/3)*4)return null;
    const raw=value.slice(prefix.length);
    if(!raw||raw.length%4||!/^[A-Za-z0-9+/]+={0,2}$/.test(raw))return null;
    const alphabet="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/",length=raw.length/4*3-(raw.endsWith("==")?2:raw.endsWith("=")?1:0);
    if(length<57||length>MAX_IMAGE_BYTES)return null;
    const bytes=new Uint8Array(length);let output=0;
    for(let i=0;i<raw.length;i+=4){const a=alphabet.indexOf(raw[i]),b=alphabet.indexOf(raw[i+1]),c=raw[i+2]==="="?0:alphabet.indexOf(raw[i+2]),d=raw[i+3]==="="?0:alphabet.indexOf(raw[i+3]);
      if(i+4===raw.length&&((raw[i+2]==="="&&(b&15))||(raw[i+3]==="="&&raw[i+2]!=="="&&(c&3))))return null;
      const n=(a<<18)|(b<<12)|(c<<6)|d;if(output<length)bytes[output++]=n>>>16;if(output<length)bytes[output++]=n>>>8;if(output<length)bytes[output++]=n;
    }
    const magic=[137,80,78,71,13,10,26,10];if(!magic.every((value,index)=>bytes[index]===value))return null;
    const uint32=offset=>((bytes[offset]*16777216)+(bytes[offset+1]<<16)+(bytes[offset+2]<<8)+bytes[offset+3])>>>0;
    let offset=8,sawHeader=false,sawData=false;
    while(offset+12<=bytes.length){
      const size=uint32(offset),end=offset+12+size;if(end>bytes.length)return null;
      const type=String.fromCharCode(...bytes.subarray(offset+4,offset+8));if(!/^[A-Za-z]{4}$/.test(type)||crc32(bytes,offset+4,end-4)!==uint32(end-4))return null;
      if(!sawHeader){if(type!=="IHDR"||size!==13)return null;const width=uint32(offset+8),height=uint32(offset+12);if(!width||!height||width>4096||height>4096)return null;sawHeader=true;}
      else if(type==="IHDR")return null;
      if(type==="IDAT"&&size)sawData=true;
      if(type==="IEND")return size===0&&sawData&&end===bytes.length?bytes:null;
      offset=end;
    }return null;
  }
  function isPngDataUrl(value){return Boolean(pngBytes(value));}
  function imageEntry(images,id){if(images&&typeof images.get==="function")return images.get(id);return images&&Object.prototype.hasOwnProperty.call(images,id)?images[id]:null;}
  function buildModel(input={}){
    const kind=input.kind==='service'?'service':'payroll',serviceDetails=new Map(unique(input.serviceDetails,'작업').map(row=>[row.payment_id,row]));
    const fromDate=date(input.fromDate),toDate=date(input.toDate);if(fromDate>toDate)throw new Error("조회 시작일이 종료일보다 늦습니다. / Ngày bắt đầu sau ngày kết thúc.");
    const employeeId=text(input.employeeId)||null,employees=new Map(unique(input.employees,"직원").map(row=>[row.id,row]));
    const runs=new Map(unique(input.runs,"급여 확정").map(row=>[row.id,row]));
    const payments=unique(input.payments,"지급"),reversals=unique(input.reversals,"취소"),attachments=unique(input.attachments,"서명 첨부");
    const reversed=new Set(reversals.map(row=>row.payment_id)),identities=identityMap(input.identities);
    const warnings=[],rows=[];
    for(const payment of payments){
      // Omit reversals before resolving employees or signatures, so cancelled
      // payments cannot request an image or expose personal data in this report.
      if(reversed.has(payment.id))continue;
      const paidOn=date(payment.paid_on);if(paidOn<fromDate||paidOn>toDate)continue;
      const linked=payment.run_id?runs.get(payment.run_id):null;
      if(payment.run_id&&(!linked||!linked.employee_id))throw new Error("지급 건의 급여 확정정보가 없습니다. 새로고침하세요. / Thiếu kỳ lương của khoản trả. Tải lại dữ liệu.");
      if(payment.payroll_month&&!/^\d{4}-(0[1-9]|1[0-2])(?:-01)?$/.test(text(payment.payroll_month)))throw new Error("지급 급여월을 확인하세요. / Kiểm tra kỳ lương.");
      const paymentEmployeeId=payment.employee_id||linked?.employee_id,payrollMonth=month(payment.payroll_month||linked?.month);
      if(!paymentEmployeeId||linked&&(linked.employee_id!==paymentEmployeeId||month(linked.month)!==payrollMonth))throw new Error("지급 직원·급여월 정보가 일치하지 않습니다. / Nhân viên hoặc kỳ lương không khớp.");
      if(employeeId&&paymentEmployeeId!==employeeId)continue;
      const matchingRuns=[...runs.values()].filter(item=>item.employee_id===paymentEmployeeId&&month(item.month)===payrollMonth);
      if(matchingRuns.length>1)throw new Error("직원·급여월의 확정정보가 중복되었습니다. / Trùng kỳ lương đã chốt.");
      const run=linked||matchingRuns[0],employee=employees.get(paymentEmployeeId),snapshot=run?.snapshot||{},paid=amount(payment.amount);
      if(paid===0)throw new Error("지급액은 0보다 커야 합니다. / Khoản trả phải lớn hơn 0.");
      const issues=[];
      if(kind==='service'){const job=serviceDetails.get(payment.id);if(!job)issues.push('작업 정보 확인 필요 / Cần bổ sung công việc');else if(date(job.work_from)>date(job.work_to)||typeof job.description!=='string'||!job.description.trim()||job.description.length>1000)throw new Error('외주 작업기간·내용을 확인하세요. / Kiểm tra công việc và thời gian.');}
      if(!employee&&!snapshot.name&&!snapshot.employee?.name)issues.push("직원 이름 확인 필요 / Cần kiểm tra tên nhân viên");
      if(!["cash","bank"].includes(payment.method))issues.push("지급방법 확인 필요 / Cần kiểm tra cách trả");
      const signatures=attachments.filter(file=>file.payment_id===payment.id&&file.evidence_type==="signature").sort((a,b)=>text(a.acknowledged_at).localeCompare(text(b.acknowledged_at))||a.id.localeCompare(b.id)).map(file=>{
        const supplied=imageEntry(input.signatureImages,file.id),acknowledgedDisplay=timestamp(file.acknowledged_at);
        const signedName=text(file.signed_name).trim();let imageStatus="missing",imageDataUrl=null;
        const metadataValid=file.mime_type==="image/png"&&signedName.length>0&&signedName.length<=200&&acknowledgedDisplay&&typeof file.storage_path==="string"&&file.storage_path.startsWith(payment.id+"/")&&file.storage_path.split("/").length===2;
        if(!metadataValid)imageStatus="invalid";
        else if(supplied){
          if(supplied.paymentId===payment.id&&supplied.storagePath===file.storage_path&&typeof file.storage_path==="string"&&file.storage_path.length>0&&isPngDataUrl(supplied.dataUrl)){
            const bytes=pngBytes(supplied.dataUrl);
            if(file.byte_size!=null&&amount(file.byte_size)!==bytes.length)imageStatus="invalid";
            else{imageStatus="loaded";imageDataUrl=supplied.dataUrl;}
          }else imageStatus="invalid";
        }
        if(imageStatus!=="loaded")issues.push(imageStatus==="invalid"?"서명 파일·연결정보 확인 필요 / Cần kiểm tra tệp hoặc liên kết chữ ký":"서명 파일 불러오기 필요 / Cần tải tệp chữ ký");
        return {attachmentId:file.id,signedName,acknowledgedAt:acknowledgedDisplay?file.acknowledged_at:null,acknowledgedDisplay,imageStatus,imageDataUrl};
      });
      const signatureStatus=!signatures.length?"unsigned":signatures.every(signature=>signature.imageStatus==="loaded")?"signed":"unavailable";
      const row={paymentId:payment.id,runId:payment.run_id||null,matchedRunId:run?.id||null,employeeId:paymentEmployeeId,deviceUserId:text(snapshot.device_user_id||snapshot.employee?.device_user_id||employee?.device_user_id),
        name:text(snapshot.name||snapshot.employee?.name||employee?.name||"이름 확인 필요 / Cần kiểm tra tên"),nationalId:identities.get(paymentEmployeeId)||"",phone:personalText(employee?.phone),
        workFrom:kind==='service'?text(serviceDetails.get(payment.id)?.work_from):'',workTo:kind==='service'?text(serviceDetails.get(payment.id)?.work_to):'',description:kind==='service'?text(serviceDetails.get(payment.id)?.description):'',
        month:payrollMonth,paidOn,amount:paid,netAmount:paid,isAdvance:!payment.run_id,payrollStatus:run?"finalized":"unfinalized",
        method:text(payment.method),status:"paid",signatures,signatureStatus,issues:[...new Set(issues)]};
      rows.push(row);row.issues.forEach(message=>warnings.push({paymentId:row.paymentId,message}));
    }
    rows.sort((a,b)=>a.paidOn.localeCompare(b.paidOn)||a.name.localeCompare(b.name)||a.paymentId.localeCompare(b.paymentId));
    const totals=activeTotals(rows);
    return {format:FORMAT,version:1,kind,fromDate,toDate,employeeId,rows,totals,warnings};
  }
  const money=value=>amount(value).toLocaleString("en-US");
  function checkedModel(value){
    if(value?.format!==FORMAT||value.version!==1||!Array.isArray(value.rows)||!value.totals)throw new Error("지급 보고서를 다시 조회하세요. / Tải lại báo cáo thanh toán.");
    date(value.fromDate);date(value.toDate);
    const rows=value.rows.filter(row=>row.status==="paid"),ids=new Set(rows.map(row=>row.paymentId));
    return {...value,rows,totals:activeTotals(rows),warnings:array(value.warnings).filter(warning=>ids.has(warning.paymentId))};
  }
  function buildTableHtml(model){
    model=checkedModel(model);const totals=model.totals;
    const status=row=>model.kind==='service'?'지급 / Đã trả':"지급 / Đã trả"+(row.isAdvance?"<small>선지급·수시지급 / Tạm trả</small>":"")+(row.payrollStatus==="unfinalized"?"<small>급여 미확정 / Lương chưa chốt</small>":row.isAdvance?"<small>급여 확정 / Lương đã chốt</small>":"");
    function signatureHtml(row){
      if(!array(row.signatures).length)return '<span class="receipt-unsigned">서명 미등록 / Chưa ký</span>';
      return row.signatures.map(signature=>{
        const valid=signature.imageStatus==="loaded"&&isPngDataUrl(signature.imageDataUrl);
        return `<figure class="receipt-signature" data-attachment-id="${escape(signature.attachmentId)}">${valid?`<img data-attachment-id="${escape(signature.attachmentId)}" src="${signature.imageDataUrl}" alt="${model.kind==='service'?'작업비 수령 서명 / Ký nhận dịch vụ':'급여 수령 서명 / Chữ ký nhận lương'}" decoding="sync" />`:'<span class="receipt-unavailable">서명 이미지 확인 필요 / Cần kiểm tra ảnh chữ ký</span>'}<figcaption><strong>${escape(signature.signedName)}</strong><br /><time>${escape(signature.acknowledgedDisplay||"서명시각 확인 필요 / Kiểm tra giờ ký")}</time></figcaption></figure>`;
      }).join("");
    }
    return `<section class="payroll-receipts" aria-label="${model.kind==='service'?'외주 지급·서명 내역 / Thanh toán dịch vụ':'급여 지급·서명 내역 / Báo cáo trả lương và chữ ký'}"><div class="receipt-totals"><strong data-receipt-total="activeCount">지급 건수 / Số khoản trả: ${money(totals.activeCount)}건</strong><strong data-receipt-total="activeTotal">지급 합계 / Tổng đã trả: ${money(totals.activeTotal)} VND</strong><span data-receipt-total="unsignedCount">서명 미등록 / Chưa ký: ${money(totals.unsignedCount)}건</span><span data-receipt-total="unavailableCount">서명 파일 확인 필요 / Cần kiểm tra tệp chữ ký: ${money(totals.unavailableCount)}건</span></div><p class="receipt-note">지급일 기준 ${escape(model.fromDate)} ~ ${escape(model.toDate)} (양끝 포함)<br />Theo ngày trả, gồm cả hai ngày biên. · 서명시각 / Giờ ký: Việt Nam (UTC+7)</p><div class="receipt-table-scroll"><table class="receipt-table"><colgroup><col style="width:9%" /><col style="width:7%" /><col style="width:14%" /><col style="width:13%" /><col style="width:11%" /><col style="width:12%" /><col style="width:8%" /><col style="width:18%" /><col style="width:8%" /></colgroup><thead><tr><th>지급일<br />Ngày trả</th><th>${model.kind==='service'?'작업기간<br />Thời gian làm':'급여월<br />Kỳ lương'}</th><th>${model.kind==='service'?'작업자<br />Bên nhận':'직원<br />Nhân viên'}</th><th>신분증 번호<br />CCCD / CMND</th><th>전화번호<br />Điện thoại</th><th>지급액 / VND<br />Số tiền trả</th><th>방법<br />Cách trả</th><th>수령 서명 · 이름 · 시각<br />Chữ ký · Người nhận · Giờ ký</th><th>상태<br />Trạng thái</th></tr></thead><tbody>${model.rows.length?model.rows.map(row=>`<tr data-payment-id="${escape(row.paymentId)}" class="receipt-paid"><td>${escape(row.paidOn)}<small class="receipt-id">${escape(row.paymentId)}</small></td><td>${model.kind==='service'?`${escape(row.workFrom||'—')}<br />~ ${escape(row.workTo||'—')}`:escape(row.month)}</td><td><strong>${escape(row.name)}</strong>${model.kind==='service'?'':`<small>${escape(row.deviceUserId)}</small>`}${model.kind==='service'?`<small>${escape(row.description||'작업 정보 확인 필요 / Cần bổ sung công việc')}</small>`:''}</td><td class="receipt-personal" data-receipt-field="national-id">${escape(row.nationalId||"—")}</td><td class="receipt-personal" data-receipt-field="phone">${escape(row.phone||"—")}</td><td class="receipt-number">${money(row.amount)}</td><td>${row.method==="cash"?"현금 / Tiền mặt":row.method==="bank"?"이체 / Chuyển khoản":"확인 필요 / Kiểm tra"}</td><td class="receipt-signature-cell">${signatureHtml(row)}</td><td><strong>${status(row)}</strong>${array(row.issues).length?`<p class="receipt-issue">${row.issues.map(escape).join("<br />")}</p>`:""}</td></tr>`).join(""):'<tr class="receipt-empty"><td colspan="9">선택기간 지급 내역 없음 / Không có khoản trả trong kỳ</td></tr>'}</tbody></table></div></section>`;
  }
  function buildPrintHtml(input){
    const model=input?.format===FORMAT?checkedModel(input):buildModel(input);if(model.kind==='service'&&model.rows.some(row=>!row.workFrom||!row.workTo||!row.description))throw new Error('외주 작업정보를 등록한 뒤 출력하세요. / Bổ sung công việc trước khi in.');const table=buildTableHtml(model);
    return `<!doctype html><html lang="ko"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'" /><title>HANA 지급·서명 내역 ${escape(model.fromDate)} ~ ${escape(model.toDate)}</title><style>
      @page{size:A4 landscape;margin:12mm}*{box-sizing:border-box}body{font:11px Arial,"Malgun Gothic",sans-serif;color:#172626;margin:0;background:#fff}header{margin-bottom:14px}header p{margin:0 0 5px;font-size:10px}h1{font-size:20px;margin:0}.receipt-totals{display:flex;flex-wrap:wrap;gap:7px 20px;padding:10px;border:1px solid #9aaba8;margin-bottom:8px}.receipt-note{font-size:9px;line-height:1.5;margin:8px 0 12px}.receipt-table{width:100%;border-collapse:collapse;table-layout:fixed}.receipt-table th,.receipt-table td{border:1px solid #b3bfbc;padding:4px 6px;vertical-align:top;overflow-wrap:anywhere}.receipt-table th{background:#eaf0ed;text-align:left;font-size:10px}.receipt-table small{display:block;font-size:8px;line-height:1.25;margin-top:2px}.receipt-table td p{margin:3px 0 0}.receipt-id{font-size:8px!important;color:#52635c;word-break:break-all}.receipt-number{text-align:right;white-space:nowrap}.receipt-personal{font-variant-numeric:tabular-nums;overflow-wrap:anywhere}.receipt-signature{margin:0 0 5px;padding:0}.receipt-signature:last-child{margin:0}.receipt-signature img{display:block;width:36mm;height:14mm;max-width:100%;max-height:14mm;object-fit:contain;object-position:left center;background:white}.receipt-signature figcaption{font-size:8px;line-height:1.25;margin-top:2px}.receipt-signature time{white-space:nowrap}.receipt-unsigned,.receipt-unavailable,.receipt-issue{font-size:9px;color:#784c10}.receipt-empty td{text-align:center;padding:20px}thead{display:table-header-group}tr,.receipt-signature{break-inside:avoid;page-break-inside:avoid}footer{margin-top:12px;font-size:9px;color:#52635c}@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}.receipt-table-scroll{overflow:visible}}
    </style></head><body><header><p>CÔNG TY TNHH DGV · HANA</p><h1>${model.kind==='service'?'외주·수리 작업비 지급·서명 내역 / Thanh toán dịch vụ và chữ ký nhận':'급여 지급·수령 서명 내역 / Báo cáo trả lương và chữ ký nhận'}</h1></header>${table}<footer>선택기간의 지급 건별 수령 확인 내역입니다. / Xác nhận nhận tiền theo từng khoản trả trong kỳ đã chọn.</footer></body></html>`;
  }
  root.DGV_PAYROLL_RECEIPTS=Object.freeze({buildModel,buildTableHtml,buildPrintHtml,isPngDataUrl});
})(typeof window!=="undefined"?window:globalThis);
