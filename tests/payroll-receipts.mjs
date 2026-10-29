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
  {id:"a",name:"Current A",device_user_id:"001",national_id:"NATIONAL-MUST-NOT-LEAK",bank_account:"BANK-MUST-NOT-LEAK"},
  {id:"b",name:"Current B",device_user_id:"002"}
],runs:[
  {id:"previous",employee_id:"a",month:"2025-12-01",snapshot:{name:"Historical A",device_user_id:"0001",national_id:"SNAPSHOT-PRIVATE-MUST-NOT-LEAK"}},
  {id:"may",employee_id:"b",month:"2026-05-01",snapshot:{employee:{name:"Historical B",device_user_id:"0002"}}},
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
assert.deepEqual(JSON.parse(JSON.stringify(model.totals)),{count:5,total:1100,activeCount:4,activeTotal:850,cancelledCount:1,cancelledTotal:250,unsignedCount:1,unavailableCount:1,signedCount:2});
assert.deepEqual(Array.from(model.rows,row=>row.paymentId),["p1","p2","p3","p6","p4"]);
assert.equal(model.rows[0].name,"Historical A");assert.equal(model.rows[0].deviceUserId,"0001");assert.equal(model.rows[0].month,"2025-12","filter uses actual paid_on even for earlier payroll months");
assert.equal(model.rows[0].signatures[0].acknowledgedDisplay,"2026-01-02 03:01:02","signature timestamp is always Vietnamese wall-clock time");
assert.equal(model.rows.find(row=>row.paymentId==="p2").signatureStatus,"unsigned","a receipt image is not an individual signature");
assert.equal(model.rows.find(row=>row.paymentId==="p3").signatureStatus,"unavailable");
assert.equal(model.rows.find(row=>row.paymentId==="p6").signatures.length,2,"multiple signatures stay attached to the exact partial payment");
assert.equal(model.rows.find(row=>row.paymentId==="p4").netAmount,0,"later cancellation is current state; do not present it as still paid");
assert.equal(receipts.buildModel({...input,employeeId:"a"}).totals.activeTotal,250);
assert.equal(receipts.buildModel({...input,fromDate:"2026-01-01",toDate:"2026-01-01"}).rows.length,1,"both inclusive boundaries work even for a one-day report");
assert.equal(receipts.buildModel({...input,fromDate:"2026-12-31",toDate:"2026-12-31"}).totals.cancelledTotal,250);
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
assert.equal(print,printModel);assert.ok(print.includes(table));assert.match(print,/@page\{size:A4 landscape/);assert.match(print,/thead\{display:table-header-group/);
assert.match(print,/data-payment-id="p4" class="receipt-cancelled"/);assert.match(print,/순지급 0/);assert.equal((print.match(/<tr data-payment-id=/g)||[]).length,5);
assert.equal((print.match(/<img data-attachment-id=/g)||[]).length,3);assert.match(print,/img-src data:/);assert.doesNotMatch(print,/<script|https:\/\/bad|NATIONAL-MUST|BANK-MUST|SNAPSHOT-PRIVATE|PRIVATE-REFERENCE/);
assert.doesNotMatch(JSON.stringify(model),/NATIONAL-MUST|BANK-MUST|SNAPSHOT-PRIVATE|PRIVATE-REFERENCE/);
assert.match(receipts.buildTableHtml(receipts.buildModel({...input,employeeId:"unknown"})),/선택기간 지급 내역 없음/);
const hostile=structuredClone(input);hostile.runs[0].snapshot.name='<img src=x onerror="evil()">';hostile.attachments[0].signed_name='</figcaption><script>evil()</script>';hostile.reversals[0].reason='</td><script>evil()</script>';
const escaped=receipts.buildPrintHtml(hostile);assert.doesNotMatch(escaped,/<script|<img src=x/);assert.match(escaped,/&lt;img src=x onerror=&quot;evil\(\)&quot;&gt;/);assert.match(escaped,/&lt;script&gt;evil\(\)&lt;\/script&gt;/);
const forged=structuredClone(model);forged.rows[0].signatures[0].imageDataUrl='data:image/svg+xml,<svg onload="evil()"/>';assert.doesNotMatch(receipts.buildTableHtml(forged),/src="data:image\/svg/,'even directly supplied models cannot inject an unvalidated image URL');
console.log("Payroll receipts passed: paid-date/year boundaries, split payouts, historical names, current cancellations once, exact PNG/payment binding, signature completeness, private-field exclusion, safe A4 table/print escaping.");
