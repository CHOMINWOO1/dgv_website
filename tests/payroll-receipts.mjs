import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {deflateSync} from "node:zlib";
import vm from "node:vm";
const context={console,Date,Uint8Array,Uint32Array};vm.createContext(context);vm.runInContext(await readFile(new URL("../assets/payroll-receipts.js",import.meta.url),"utf8"),context);
const receipts=context.DGV_PAYROLL_RECEIPTS;
function crc(bytes){let value=0xffffffff;for(const byte of bytes){value^=byte;for(let i=0;i<8;i++)value=value&1?0xedb88320^(value>>>1):value>>>1;}return (value^0xffffffff)>>>0;}
function chunk(type,bytes){const name=Buffer.from(type),result=Buffer.alloc(bytes.length+12);result.writeUInt32BE(bytes.length);name.copy(result,4);bytes.copy(result,8);result.writeUInt32BE(crc(Buffer.concat([name,bytes])),8+bytes.length);return result;}
function png(seed=1){
  const width=32,height=12,header=Buffer.alloc(13);header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;
  const pixels=Buffer.alloc((1+width*4)*height,255);for(let y=0;y<height;y++){pixels[y*(width*4+1)]=0;for(let x=0;x<width;x++){const start=y*(width*4+1)+1+x*4;pixels[start]=pixels[start+1]=pixels[start+2]=(x+y+seed)%7===0?30:255;}}
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",header),chunk("IDAT",deflateSync(pixels)),chunk("IEND",Buffer.alloc(0))]);
}
const pngA=png(),pngB=png(3),dataUrl=bytes=>"data:image/png;base64,"+bytes.toString("base64"),imageA=dataUrl(pngA),imageB=dataUrl(pngB);
assert.equal(receipts.isPngDataUrl(imageA),true);
assert.equal(receipts.isPngDataUrl(imageB),true);
for(const input of ["https://bad.test/signature.png","blob:some-image","javascript:alert(1)","data:image/svg+xml;base64,"+Buffer.from('<svg onload="evil()"/>').toString("base64"),dataUrl(Buffer.from("<script>evil()</script>")),imageA+'" onerror="evil()',imageA+"AAAA",imageA.replace("base64,","base64, ")])assert.equal(receipts.isPngDataUrl(input),false,input.slice(0,50));
const corrupt=Buffer.from(pngA);corrupt[45]^=1;assert.equal(receipts.isPngDataUrl(dataUrl(corrupt)),false,"CRC-invalid bytes are never embedded");
const huge=Buffer.from(pngA);huge.writeUInt32BE(10000,16);huge.writeUInt32BE(crc(huge.subarray(12,29)),29);assert.equal(receipts.isPngDataUrl(dataUrl(huge)),false,"dimension bombs are rejected");
const key=(id,paymentId,pngValue=pngA)=>({id,payment_id:paymentId,evidence_type:"signature",signed_name:"Synthetic receiver",acknowledged_at:"2026-01-01T20:01:02Z",storage_path:`${paymentId}/${id}.png`,mime_type:"image/png",byte_size:pngValue.length});
const input={fromDate:"2026-01-01",toDate:"2026-12-31",employees:[
  {id:"a",name:"Current A",device_user_id:"001",phone:"090-001-0023",national_id:"NATIONAL-MUST-NOT-LEAK",bank_account:"BANK-MUST-NOT-LEAK"},
  {id:"b",name:"Current B",device_user_id:"002",phone:"000-002-0034"}
],runs:[
  {id:"previous",employee_id:"a",month:"2025-12-01",snapshot:{name:"Historical A",device_user_id:"0001",national_id:"SNAPSHOT-PRIVATE-MUST-NOT-LEAK"}},
  {id:"may",employee_id:"b",month:"2026-05-01",snapshot:{employee:{name:"Historical B",device_user_id:"0002",national_id:"NESTED-SNAPSHOT-PRIVATE-MUST-NOT-LEAK",phone:"SNAPSHOT-PHONE-MUST-NOT-LEAK"}}},
  {id:"november",employee_id:"a",month:"2026-11-01",snapshot:{name:"Historical A",device_user_id:"0001"}},
  {id:"retired",employee_id:"removed",month:"2026-06",snapshot:{name:"Former employee",device_user_id:"0003"}}
],payments:[
  {id:"before",run_id:"previous",paid_on:"2025-12-31",amount:50,method:"cash"},
  {id:"p1",run_id:"previous",paid_on:"2026-01-01",amount:100,method:"cash",reference:"PRIVATE-REFERENCE-NOT-IN-REPORT"},
  {id:"p2",run_id:"previous",paid_on:"2026-01-05",amount:"150",method:"bank"},
  {id:"p3",run_id:"may",paid_on:"2026-06-10",amount:200,method:"cash"},
  {id:"p4",run_id:"november",paid_on:"2026-12-31",amount:250,method:"cash"},
  {id:"after",run_id:"november",paid_on:"2027-01-01",amount:300,method:"bank"},
  {id:"p6",run_id:"retired",paid_on:"2026-07-05",amount:400,method:"cash"}
],reversals:[{id:"reversal4",payment_id:"p4",created_at:"2027-01-02T01:00:00Z",reason:"Cancelled later, remains in historical list"}],attachments:[
  key("a1","p1"),key("a3","p3"),key("a4","p4"),key("a6first","p6"),key("a6second","p6",pngB),
  {...key("invoice","p2"),evidence_type:"receipt"}
],signatureImages:{
  a1:{paymentId:"p1",storagePath:"p1/a1.png",dataUrl:imageA},
  a4:{paymentId:"p4",storagePath:"p4/a4.png",dataUrl:"https://bad.test/image.png"},
  a6first:{paymentId:"p6",storagePath:"p6/a6first.png",dataUrl:imageA},
  a6second:{paymentId:"p6",storagePath:"p6/a6second.png",dataUrl:imageB}
}};
const unchanged=JSON.stringify(input),model=receipts.buildModel(input);
assert.equal(JSON.stringify(input),unchanged,"report construction never edits live data");
assert.deepEqual(JSON.parse(JSON.stringify(model.totals)),{count:4,total:850,activeCount:4,activeTotal:850,unsignedCount:1,unavailableCount:1,signedCount:2});
assert.deepEqual(Array.from(model.rows,row=>row.paymentId),["p1","p2","p3","p6"]);
assert.equal(model.rows[0].name,"Historical A");assert.equal(model.rows[0].deviceUserId,"0001");assert.equal(model.rows[0].month,"2025-12","filter uses actual paid_on even for earlier payroll months");
assert.equal(model.rows[0].signatures[0].acknowledgedDisplay,"2026-01-02 03:01:02","signature timestamp is always Vietnamese wall-clock time");
assert.equal(model.rows.find(row=>row.paymentId==="p2").signatureStatus,"unsigned","a receipt image is not an individual signature");
assert.equal(model.rows.find(row=>row.paymentId==="p3").signatureStatus,"unavailable");
assert.equal(model.rows.find(row=>row.paymentId==="p6").signatures.length,2,"multiple signatures stay attached to the exact partial payment");
assert.equal(model.rows.some(row=>row.paymentId==="p4"),false,"later cancellation removes the entire payment from receipt output");
assert.equal(model.warnings.some(warning=>warning.paymentId==="p4"),false,"cancelled signatures do not contribute warning entries");
const cancelledImages={...input.signatureImages};Object.defineProperty(cancelledImages,"a4",{enumerable:true,get(){throw new Error("Cancelled signature image must not be read");}});
assert.equal(receipts.buildModel({...input,signatureImages:cancelledImages}).totals.total,850,"cancelled image data is skipped before resolving signatures");
assert.equal(receipts.buildModel({...input,payments:input.payments.map(payment=>payment.id==="p4"?{...payment,paid_on:"not-a-date",run_id:"missing-run",amount:-1}:payment)}).totals.total,850,"discarded cancelled data cannot block an otherwise valid receipt");
assert.equal(receipts.buildModel({...input,employeeId:"a"}).totals.activeTotal,250);
assert.equal(receipts.buildModel({...input,fromDate:"2026-01-01",toDate:"2026-01-01"}).rows.length,1,"both inclusive boundaries work even for a one-day report");
const onlyCancelled=receipts.buildModel({...input,fromDate:"2026-12-31",toDate:"2026-12-31"});assert.equal(onlyCancelled.rows.length,0);assert.equal(onlyCancelled.totals.total,0);assert.equal(onlyCancelled.totals.count,0);
assert.equal(receipts.buildModel({...input,fromDate:"2028-02-29",toDate:"2028-02-29"}).rows.length,0,"leap days are valid without guessing month length");
assert.throws(()=>receipts.buildModel({...input,fromDate:"2026-02-29"}),/유효하지/);
assert.throws(()=>receipts.buildModel({...input,fromDate:"2027-01-01"}),/시작일/);
assert.throws(()=>receipts.buildModel({...input,toDate:"2026-12-31T00:00:00Z"}),/날짜/);
assert.throws(()=>receipts.buildModel({...input,runs:[]}),/확정정보/);
assert.throws(()=>receipts.buildModel({...input,payments:[{...input.payments[1],amount:1.5}]}),/지급액/);
assert.throws(()=>receipts.buildModel({...input,payments:[{...input.payments[1],amount:0}]}),/0보다/);
const duplicate=receipts.buildModel({...input,payments:[...input.payments,structuredClone(input.payments[1])],reversals:[...input.reversals,structuredClone(input.reversals[0])]});assert.equal(duplicate.totals.activeTotal,850,"identical paginated duplicates do not duplicate money");
assert.throws(()=>receipts.buildModel({...input,payments:[...input.payments,{...input.payments[1],amount:123}]}),/중복/);
const mismatch=receipts.buildModel({...input,signatureImages:{...input.signatureImages,a1:{...input.signatureImages.a1,paymentId:"p2"}}});assert.equal(mismatch.rows[0].signatures[0].imageDataUrl,null,"a valid PNG from another payout must not be borrowed");
const wrongPath=receipts.buildModel({...input,signatureImages:{...input.signatureImages,a1:{...input.signatureImages.a1,storagePath:"p1/other.png"}}});assert.equal(wrongPath.rows[0].signatureStatus,"unavailable");
const wrongMeta=receipts.buildModel({...input,attachments:input.attachments.map(row=>row.id==="a1"?{...row,storage_path:"p2/a1.png"}:row),signatureImages:{...input.signatureImages,a1:{...input.signatureImages.a1,storagePath:"p2/a1.png"}}});assert.equal(wrongMeta.rows[0].signatureStatus,"unavailable","attachment metadata cannot redirect to another payment's storage path");
const byteMismatch=receipts.buildModel({...input,attachments:input.attachments.map(row=>row.id==="a1"?{...row,byte_size:row.byte_size+1}:row)});assert.equal(byteMismatch.rows[0].signatureStatus,"unavailable");
const badTime=receipts.buildModel({...input,attachments:input.attachments.map(row=>row.id==="a1"?{...row,acknowledged_at:"2026-02-30T00:00:00Z"}:row)});assert.equal(badTime.rows[0].signatures[0].acknowledgedAt,null);
const mapModel=receipts.buildModel({...input,signatureImages:new Map(Object.entries(input.signatureImages))});assert.equal(mapModel.rows[0].signatures[0].imageDataUrl,imageA);
const table=receipts.buildTableHtml(model),print=receipts.buildPrintHtml(input),printModel=receipts.buildPrintHtml(model);
assert.equal(print,printModel);assert.match(print,/class="receipt-table/);assert.match(print,/@page\{size:A4 landscape/);assert.match(print,/thead\{display:table-header-group/);
assert.doesNotMatch(table+print,/data-payment-id="p4"|receipt-cancelled|cancelledCount|cancelledTotal|취소|Đã hủy|đã hủy|순지급/);assert.equal((print.match(/<tr data-payment-id=/g)||[]).length,4);
assert.equal((print.match(/<img data-attachment-id=/g)||[]).length,3);assert.match(print,/img-src data:/);assert.doesNotMatch(print,/<script|https:\/\/bad|NATIONAL-MUST|BANK-MUST|SNAPSHOT-PRIVATE|PRIVATE-REFERENCE/);
assert.doesNotMatch(JSON.stringify(model),/NATIONAL-MUST|BANK-MUST|SNAPSHOT-PRIVATE|SNAPSHOT-PHONE|PRIVATE-REFERENCE|cancelledCount|cancelledTotal|Cancelled later/);
assert.deepEqual(Array.from(model.rows,row=>row.nationalId),["","","",""],"without an explicit identity list no employee or salary snapshot can supply an identity number");
assert.deepEqual(Array.from(model.rows,row=>row.phone),["090-001-0023","090-001-0023","000-002-0034",""],"phones come from the exact current employee, including historical payouts");
const identityInput=structuredClone(input);identityInput.identities=[
  {employee_id:"b",national_id:"000-555-666",phone:"IDENTITY-PHONE-MUST-NOT-LEAK",name:"IDENTITY-NAME-MUST-NOT-LEAK",bank_account:"IDENTITY-BANK-MUST-NOT-LEAK"},
  {employee_id:"a",national_id:"001-234-567"},
  {employee_id:"removed",national_id:"009-888-777"},
  {employee_id:"unrelated",national_id:"UNRELATED-IDENTITY-MUST-NOT-LEAK"}
];
identityInput.employees[1].name=identityInput.employees[0].name;identityInput.employees[1].device_user_id=identityInput.employees[0].device_user_id;
identityInput.runs[1].snapshot.employee.name=identityInput.runs[0].snapshot.name;identityInput.runs[1].snapshot.employee.device_user_id=identityInput.runs[0].snapshot.device_user_id;
const identityUnchanged=JSON.stringify(identityInput),identityModel=receipts.buildModel(identityInput);
assert.equal(JSON.stringify(identityInput),identityUnchanged,"report identity binding never writes private data into employees or salary snapshots");
assert.deepEqual(Array.from(identityModel.rows,row=>[row.paymentId,row.employeeId,row.nationalId,row.phone]),[
  ["p1","a","001-234-567","090-001-0023"],["p2","a","001-234-567","090-001-0023"],["p3","b","000-555-666","000-002-0034"],["p6","removed","009-888-777",""]
],"identity and phone bindings use employee IDs even when names and device IDs coincide");
assert.equal(identityModel.rows[0].name,"Historical A","current private information does not replace the historical employee name");
for(const row of identityModel.rows){assert.equal(typeof row.nationalId,"string");assert.equal(typeof row.phone,"string");}
const identityTable=receipts.buildTableHtml(identityModel),identityPrint=receipts.buildPrintHtml(identityModel);
for(const output of [identityTable,identityPrint]){
  for(const expected of ["001-234-567","000-555-666","009-888-777","090-001-0023","000-002-0034"])assert.ok(output.includes(expected),`receipt output preserves text ${expected}`);
  assert.doesNotMatch(output,/NATIONAL-MUST|BANK-MUST|SNAPSHOT-PRIVATE|SNAPSHOT-PHONE|IDENTITY-PHONE|IDENTITY-NAME|UNRELATED-IDENTITY|PRIVATE-REFERENCE/);
}
assert.doesNotMatch(JSON.stringify(identityModel),/NATIONAL-MUST|BANK-MUST|SNAPSHOT-PRIVATE|SNAPSHOT-PHONE|IDENTITY-PHONE|IDENTITY-NAME|UNRELATED-IDENTITY|PRIVATE-REFERENCE/);
const missingIdentity=receipts.buildModel({...identityInput,identities:identityInput.identities.filter(row=>row.employee_id!=="a")});assert.equal(missingIdentity.rows[0].nationalId,"");assert.equal(missingIdentity.rows[0].phone,"090-001-0023");
const selectedIdentity=receipts.buildModel({...identityInput,employeeId:"b"});assert.equal(selectedIdentity.rows.length,1);assert.equal(selectedIdentity.rows[0].nationalId,"000-555-666");assert.doesNotMatch(receipts.buildPrintHtml(selectedIdentity),/001-234-567|009-888-777|090-001-0023|UNRELATED-IDENTITY/);
const duplicateIdentity=receipts.buildModel({...identityInput,identities:[...identityInput.identities,structuredClone(identityInput.identities[1])]});assert.equal(receipts.buildPrintHtml(duplicateIdentity),identityPrint,"identical identity duplicates do not change output");
assert.throws(()=>receipts.buildModel({...identityInput,identities:[...identityInput.identities,{employee_id:"a",national_id:"CONFLICTING-PRIVATE-ID-000"}]}),error=>{
  assert.match(error.message,/중복/);assert.doesNotMatch(error.message,/001-234-567|CONFLICTING-PRIVATE-ID|Historical A|Current A/);return true;
},"conflicting identity records are rejected without disclosing private values");
assert.throws(()=>receipts.buildModel({...identityInput,identities:[{employee_id:"a",national_id:123456789}]}),error=>{
  assert.doesNotMatch(error.message,/123456789/);return true;
},"numeric identity values are rejected rather than silently losing leading zeros");
assert.throws(()=>receipts.buildModel({...identityInput,employees:identityInput.employees.map(employee=>employee.id==="a"?{...employee,phone:900010023}:employee)}),error=>{
  assert.doesNotMatch(error.message,/900010023/);return true;
},"numeric phone values are rejected rather than silently losing leading zeros");
identityInput.identities[1].national_id="MUTATED-PRIVATE-ID";identityInput.employees[0].phone="MUTATED-PHONE";
assert.equal(identityModel.rows[0].nationalId,"001-234-567");assert.equal(identityModel.rows[0].phone,"090-001-0023");assert.equal(receipts.buildPrintHtml(identityModel),identityPrint,"built receipts capture identity and phone strings rather than referencing mutable source records");
assert.match(receipts.buildTableHtml(receipts.buildModel({...input,employeeId:"unknown"})),/선택기간 지급 내역 없음/);
const hostile=structuredClone(input);hostile.runs[0].snapshot.name='<img src=x onerror="evil()">';hostile.attachments[0].signed_name='</figcaption><script>evil()</script>';hostile.reversals[0].reason='</td><script>evil()</script>';
const escaped=receipts.buildPrintHtml(hostile);assert.doesNotMatch(escaped,/<script|<img src=x/);assert.match(escaped,/&lt;img src=x onerror=&quot;evil\(\)&quot;&gt;/);assert.match(escaped,/&lt;script&gt;evil\(\)&lt;\/script&gt;/);
const forged=structuredClone(model);forged.rows[0].signatures[0].imageDataUrl='data:image/svg+xml,<svg onload="evil()"/>';assert.doesNotMatch(receipts.buildTableHtml(forged),/src="data:image\/svg/,'even directly supplied models cannot inject an unvalidated image URL');
const hostilePrivate=structuredClone(input);hostilePrivate.identities=[{employee_id:"a",national_id:'<script>privateIdAttack("001")</script>'}];hostilePrivate.employees[0].phone='<img src=x onerror="phoneAttack()">';
const hostilePrivateModel=receipts.buildModel(hostilePrivate);
for(const output of [receipts.buildTableHtml(hostilePrivateModel),receipts.buildPrintHtml(hostilePrivateModel)]){
  assert.doesNotMatch(output,/<script|<img src=x/);assert.match(output,/&lt;script&gt;privateIdAttack\(&quot;001&quot;\)&lt;\/script&gt;/);assert.match(output,/&lt;img src=x onerror=&quot;phoneAttack\(\)&quot;&gt;/);
}
const forgedCancellation=structuredClone(model),cancelledRow={...structuredClone(model.rows[0]),paymentId:"cancelled-injected",status:"cancelled",amount:987654,reversalReason:"CANCELLED-REASON-MUST-NOT-LEAK"};
Object.defineProperty(cancelledRow,"signatures",{get(){throw new Error("Injected cancelled signatures must not be read");}});forgedCancellation.rows.push(cancelledRow);
Object.assign(forgedCancellation.totals,{count:999,total:999999,activeCount:999,activeTotal:999999,cancelledCount:1,cancelledTotal:987654,unsignedCount:999,unavailableCount:999,signedCount:999});
assert.equal(receipts.buildTableHtml(forgedCancellation),table,"directly supplied legacy models are filtered and their visible totals recomputed");
assert.equal(receipts.buildPrintHtml(forgedCancellation),print,"printing a legacy model cannot restore cancelled rows, cancellation amounts, or stale totals");
// Runless advances and ad-hoc part-time payouts retain their own payment IDs,
// payroll month and signatures before and after the monthly salary is finalized.
const advancePayment={id:"advance-a",run_id:null,employee_id:"a",payroll_month:"2025-12-01",paid_on:"2026-01-01",amount:123,method:"cash"};
const advanceInput={fromDate:"2026-01-01",toDate:"2026-01-31",employees:input.employees,runs:[],
  payments:[advancePayment,{...advancePayment,id:"advance-b",employee_id:"b",payroll_month:"2026-01-01",paid_on:"2026-01-31",amount:200,method:"bank"},{...advancePayment,id:"advance-cancel",payroll_month:"2026-01-01",amount:300},structuredClone(advancePayment),{...advancePayment,id:"advance-outside",paid_on:"2026-02-01",amount:400}],
  reversals:[{id:"advance-reversal",payment_id:"advance-cancel",reason:"Cancelled advance",created_at:"2026-02-01T01:00:00Z"}],
  attachments:[key("advance-signature","advance-a")],signatureImages:{"advance-signature":{paymentId:"advance-a",storagePath:"advance-a/advance-signature.png",dataUrl:imageA}}};
const beforeFinal=receipts.buildModel(advanceInput),advanceRow=beforeFinal.rows.find(row=>row.paymentId==="advance-a");
assert.equal(beforeFinal.rows.length,2);assert.equal(beforeFinal.totals.activeTotal,323);assert.equal(beforeFinal.totals.total,323);assert.equal(beforeFinal.totals.count,2);assert.equal("cancelledTotal" in beforeFinal.totals,false);
assert.equal(advanceRow.employeeId,"a");assert.equal(advanceRow.month,"2025-12");assert.equal(advanceRow.name,"Current A");assert.equal(advanceRow.runId,null);assert.equal(advanceRow.matchedRunId,null);
assert.equal(advanceRow.isAdvance,true);assert.equal(advanceRow.payrollStatus,"unfinalized");assert.equal(advanceRow.signatureStatus,"signed");assert.equal(advanceRow.signatures[0].imageDataUrl,imageA);
assert.equal(receipts.buildModel({...advanceInput,employeeId:"b"}).totals.activeTotal,200);
assert.equal(receipts.buildModel({...advanceInput,fromDate:"2026-01-31",toDate:"2026-01-31"}).rows[0].paymentId,"advance-b");
const beforePrint=receipts.buildPrintHtml(beforeFinal);assert.match(beforePrint,/급여 미확정/);assert.match(beforePrint,/선지급·수시지급/);assert.match(beforePrint,/data-payment-id="advance-a"/);
assert.doesNotMatch(beforePrint,/advance-cancel|취소|Đã hủy|đã hủy|cancelledCount|cancelledTotal/);
assert.doesNotMatch(JSON.stringify(beforeFinal)+beforePrint,/NATIONAL-MUST|BANK-MUST|SNAPSHOT-PRIVATE/);
const finalAdvance=receipts.buildModel({...advanceInput,runs:[input.runs[0]]}).rows.find(row=>row.paymentId==="advance-a");
assert.equal(finalAdvance.payrollStatus,"finalized");assert.equal(finalAdvance.name,"Historical A");assert.equal(finalAdvance.deviceUserId,"0001");assert.equal(finalAdvance.isAdvance,true);
assert.equal(finalAdvance.runId,null,"finalization never pretends to rewrite the original payment link");assert.equal(finalAdvance.matchedRunId,"previous");
assert.equal(finalAdvance.signatures[0].imageDataUrl,imageA,"finalizing cannot replace the signature association");
const advanceIdentities=[{employee_id:"a",national_id:"001-234-567"},{employee_id:"b",national_id:"000-555-666"}];
for(const runs of [[],[input.runs[0]]]){
  const identifiedAdvance=receipts.buildModel({...advanceInput,runs,identities:advanceIdentities});
  assert.deepEqual(Array.from(identifiedAdvance.rows,row=>[row.employeeId,row.nationalId,row.phone]),[["a","001-234-567","090-001-0023"],["b","000-555-666","000-002-0034"]],"finalization does not change advance identity or phone bindings");
}
const mixed=receipts.buildModel({...advanceInput,runs:[input.runs[0]],payments:[...advanceInput.payments,input.payments[2]]});
assert.equal(mixed.totals.activeTotal,473,"legacy run-only payment and advances are counted exactly once");
assert.equal(mixed.rows.find(row=>row.paymentId==="p2").isAdvance,false);
const wrongEmployee={...input.payments[1],employee_id:"b",payroll_month:"2025-12-01"};
assert.throws(()=>receipts.buildModel({...input,payments:[wrongEmployee]}),/직원·급여월/);
assert.throws(()=>receipts.buildModel({...input,payments:[{...wrongEmployee,employee_id:"a",payroll_month:"2026-01-01"}]}),/직원·급여월/);
assert.throws(()=>receipts.buildModel({...advanceInput,payments:[{...advancePayment,payroll_month:"2025-12-02"}]}),/급여월/);
assert.throws(()=>receipts.buildModel({...advanceInput,payments:[{...advancePayment,employee_id:null}]}),/직원·급여월/);
assert.throws(()=>receipts.buildModel({...advanceInput,runs:[input.runs[0],{...input.runs[0],id:"duplicate-period"}]}),/중복/);
const hostileAdvance={...advanceInput,employees:input.employees.map(employee=>({...employee,name:'<script>advanceAttack()</script>'}))};
assert.doesNotMatch(receipts.buildPrintHtml(hostileAdvance),/<script>/);assert.match(receipts.buildPrintHtml(hostileAdvance),/&lt;script&gt;advanceAttack/);
// The print summary counts people by immutable employee ID, not identical names
// or device codes, and reconciles all payment methods without inventing a wage
// allocation for individual instalments.
const summaryInput={...identityInput,employees:input.employees,identities:[],payments:[...input.payments,{id:"other-method",run_id:"previous",paid_on:"2026-01-06",amount:75,method:"other"}]};
const summaryPrint=receipts.buildPrintHtml(summaryInput);
const totalText=(html,key)=>html.match(new RegExp(`data-receipt-total="${key}"[^>]*>([\\s\\S]*?)<\\/[^>]+>`))?.[1].replace(/<[^>]*>/g,"");
assert.match(totalText(summaryPrint,"activeCount"),/5/);
assert.match(totalText(summaryPrint,"employeeCount"),/3/,"split payments do not duplicate the employee count");
assert.match(totalText(summaryPrint,"activeTotal"),/925/);
assert.match(totalText(summaryPrint,"cashTotal"),/700/);
assert.match(totalText(summaryPrint,"bankTotal"),/150/);
assert.match(totalText(summaryPrint,"otherTotal"),/75/,"unrecognized methods still reconcile with actual paid total");
assert.match(totalText(summaryPrint,"unsignedCount"),/2/);
assert.match(totalText(summaryPrint,"unavailableCount"),/1/);
for(const label of ["근무일","실근무","시급","기본급","수당","공제"])assert.match(summaryPrint,new RegExp('<th[^>]*>'+label),"the 11-column print report includes "+label);
assert.match(summaryPrint,/해당 급여월 전체 자료/);assert.match(summaryPrint,/첫 지급 행에 한 번만 표시/);
assert.match(summaryPrint,/data-month-detail="continuation"/,"split payments preserve their separate rows while the monthly calculation appears once");
assert.doesNotMatch(receipts.buildPrintHtml(onlyCancelled),/data-payment-id=/);
context.Date=class extends Date{static now(){return Date.parse("2026-12-31T17:01:00Z");}};
assert.match(receipts.buildPrintHtml(onlyCancelled),/data-receipt-generated-on="2027-01-01"/,"statement issue date follows Vietnam across the UTC year boundary");
console.log("Payroll receipts passed: legacy and runless payments, finalization continuity, paid-date/year boundaries, split payouts, historical names, cancelled-payment exclusion, exact employee identity and phone binding, exact PNG/payment binding, private-field exclusion, safe A4 print escaping, unique employee counts and cash/bank/unknown-method reconciliation.");
