import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const context={console,Date,TextEncoder,TextDecoder,Uint8Array,DataView};context.globalThis=context;
for(const file of ["assets/payroll-core.js","assets/payroll-tax.js","assets/dgv-xlsx.js"])vm.runInNewContext(await readFile(path.join(root,file),"utf8"),context,{filename:file});
const tax=context.DGV_PAYROLL_TAX;
const values=sheet=>sheet.rows.map(row=>row.map(cell=>cell&&typeof cell==="object"&&"value" in cell?cell.value:cell));
const body=sheet=>values(sheet).slice(sheet.freezeRows);
const lookup=(book,name)=>{const sheet=book.sheets.find(sheet=>sheet.name===name);assert.ok(sheet,`missing ${name}`);return sheet;};
const day={date:"2026-10-01",checkIn:"2026-10-01T10:00:00",checkOut:"2026-10-01T20:00:00",minutes:480,lateMinutes:0,earlyMinutes:0,extraMinutes:0,dayType:"work",status:"ok",issues:[]};
const snapshot=(name,types=["monthly"])=>({name,device_user_id:name==="Historic A"?"001":"002",minutes:480,workedDays:1,daily:[day],payTypes:types,unresolved:0,issues:[],calculationVersion:2});
const data={month:"2026-10",today:"2026-11-10",employees:[
  {id:"a",device_user_id:"001",name:"Renamed A",employment_type:"full_time",phone:"000-test",hire_date:"2026-01-02",active:true,private_national_id:"MUST-NOT-EXPORT"},
  {id:"b",device_user_id:"002",name:"=HYPERLINK(\"bad\")",employment_type:"part_time",active:true},
  {id:"inactive",device_user_id:"003",name:"Inactive empty",employment_type:"full_time",active:false}
],terms:[],records:[],days:[],runs:[
  {id:"r1",employee_id:"a",month:"2026-10-01",base_amount:7000000,allowances:0,deductions:0,total:7000000,snapshot:{...snapshot("Historic A"),statutoryAmount:15000,wageBreakdown:[{code:"regular_ot",label:"Tăng ca thường / 일반 연장",date:"2026-10-01",dayType:"work",minutes:30,rate:20000,multiplier:1.5,amount:15000}]}},
  {id:"r2",employee_id:"b",month:"2026-10-01",base_amount:200000,allowances:0,deductions:0,total:200000,snapshot:snapshot("=HYPERLINK(\"bad\")",["hourly"])}
],previousRuns:[{id:"r0",employee_id:"a",month:"2026-09-01",base_amount:6000000,allowances:0,deductions:0,total:6000000,snapshot:{...snapshot("Historic A"),daily:[{...day,date:"2026-09-30",checkIn:"2026-09-30T10:00:00",checkOut:"2026-09-30T20:00:00"}]}}],
payments:[
  {id:"p1",run_id:"r1",paid_on:"2026-10-30",method:"cash",amount:3000000,reference:"receipt-test"},
  {id:"p2",run_id:"r1",paid_on:"2026-11-05",method:"bank",amount:2000000,reference:"bank-test"},
  {id:"p3",run_id:"r2",paid_on:"2026-10-31",method:"bank",amount:200000,reference:""}
],previousPayments:[{id:"p0",run_id:"r0",paid_on:"2026-10-05",method:"cash",amount:6000000}],
adjustments:[{id:"ad1",run_id:"r1",amount:500000,reason:"Approved correction",created_at:"2026-10-28T03:00:00Z"},{id:"ad0",run_id:"r0",amount:10000,reason:"Previous correction"}],
reversals:[{id:"rv1",payment_id:"p2",reason:"Wrong transfer record",created_at:"2026-11-06T00:00:00Z"}],
attachments:[{id:"ev1",payment_id:"p1",evidence_type:"signature",signed_name:"Test receiver",acknowledged_at:"2026-10-30T03:00:00Z",created_at:"2026-10-30T03:01:00Z",filename:"signature.png",storage_path:"p1/signature.png",mime_type:"image/png",byte_size:100}]
};
const untouched=JSON.stringify(data);
const model=tax.summarizePayroll(data);
assert.equal(model.rows.length,2,"inactive without activity is omitted");
const a=model.rows.find(row=>row.employee_id==="a");
assert.equal(a.name,"Historic A","approved employee name is immutable in historical report");
assert.equal(a.approved,7500000);
assert.equal(a.paid,3000000,"reversed payment is excluded once from net payments");
assert.equal(a.outstanding,4500000);
assert.equal(model.totals.approved,7700000);
assert.equal(model.totals.paid,3200000);
assert.equal(model.totals.outstanding,4500000);
const comparison=model.comparison.find(row=>row.employee_id==="a");
assert.equal(comparison.previousApproved,6010000);
assert.equal(comparison.difference,1490000);
assert.ok(model.warnings.some(warning=>warning.code==="MISSING_EVIDENCE"&&warning.reference==="p3"));
assert.ok(model.warnings.some(warning=>warning.code==="BANK_REFERENCE"&&warning.reference==="p3"));
assert.ok(!model.warnings.some(warning=>warning.code==="MISSING_EVIDENCE"&&warning.reference==="p1"));
assert.ok(!model.warnings.some(warning=>warning.reference==="p2"),"voided payment does not demand new evidence");
assert.ok(!model.warnings.some(warning=>warning.code==="FUND_SOURCE"),"fund-source requirement was excluded by user");

for(const kind of tax.KINDS) {
  const book=tax.buildPayrollWorkbook({...data,kind});
  assert.match(book.filename,/^HANA_.*_2026-10\.xlsx$/);
  assert.ok(book.sheets.length>0);
  for(const sheet of book.sheets) {
    assert.ok(sheet.freezeRows>=2);
    assert.ok(sheet.columnWidths.every(width=>width>=14));
    assert.ok(values(sheet)[sheet.freezeRows-1].some(value=>String(value).includes("/")),"headers are Vietnamese/Korean");
  }
  const bytes=context.DGV_XLSX.buildWorkbookBytes(book);
  assert.equal(bytes[0],0x50);assert.equal(bytes[1],0x4b);
  const xml=new TextDecoder().decode(bytes);
  assert.doesNotMatch(xml,/<f(?:\s|>)/,"formula-like employee names remain string cells");
  assert.doesNotMatch(xml,/MUST-NOT-EXPORT/);
  assert.doesNotMatch(xml,/자금 출처|Nguồn tiền/);
}
const cash=tax.buildPayrollWorkbook({...data,kind:"cash"});
assert.equal(body(cash.sheets[0]).length,1,"month-based cash file scopes payroll month, not paid month");
assert.equal(body(cash.sheets[0])[0][0],"p1");
const bank=tax.buildPayrollWorkbook({...data,kind:"bank"});
assert.equal(body(bank.sheets[0]).length,2);
assert.equal(body(bank.sheets[0]).find(row=>row[0]==="p2")[8],0,"bank reversal is shown separately, net zero");
const parttime=tax.buildPayrollWorkbook({...data,kind:"parttime"});
assert.equal(body(parttime.sheets[0]).length,1);
assert.equal(body(parttime.sheets[0])[0][0],"p3");
const outstanding=tax.buildPayrollWorkbook({...data,kind:"outstanding"});
assert.equal(body(outstanding.sheets[0]).length,1);
assert.equal(body(outstanding.sheets[0])[0][5],4500000);

const range=tax.buildPayrollWorkbook({...data,kind:"cash",fromDate:"2026-10-01",toDate:"2026-10-10"});
assert.equal(body(range.sheets[0]).length,1);
assert.equal(body(range.sheets[0])[0][0],"p0","paid-on range includes prior payroll settled this month");
const attendance=tax.buildPayrollWorkbook({...data,kind:"attendance",fromDate:"2026-09-30",toDate:"2026-10-01",employeeId:"a"});
assert.equal(body(attendance.sheets[0]).length,2,"cross-month attendance combines supplied finalized snapshots");
assert.ok(body(attendance.sheets[0]).every(row=>row[2] instanceof Date));
const taxBook=tax.buildPayrollWorkbook({...data,kind:"tax"});
assert.equal(taxBook.sheets.length,11);
const evidence=body(lookup(taxBook,"Chứng từ"));
assert.equal(evidence[0][4],"Test receiver");
assert.equal(evidence[0][5].getHours(),10,"UTC evidence acknowledgement displayed in Vietnam time");
assert.equal(evidence[0][8],"p1/signature.png");
assert.equal(body(lookup(taxBook,"Khoản lương"))[0][8],15000);
assert.equal(body(lookup(taxBook,"Điều chỉnh")).length,2);
assert.equal(body(lookup(taxBook,"Điều chỉnh"))[1][4],-2000000);
assert.equal(body(lookup(taxBook,"Nhân viên"))[0][4].getDate(),2);
assert.equal(JSON.stringify(data),untouched,"export builders never mutate source records");

for(const kind of tax.KINDS) {
  const print=tax.buildPayrollPrintHtml({...data,kind});
  assert.match(print,/<!doctype html>/i);
  assert.match(print,/@page\{size:A4 landscape/);
  assert.match(print,/thead\{display:table-header-group\}/);
  assert.match(print,/Content-Security-Policy/);
  assert.doesNotMatch(print,/<script|\sonerror\s*=|\sonload\s*=/i);
  assert.doesNotMatch(print,/href=["'](?:admin|expense)\.html/);
  assert.match(print,/CÔNG TY TNHH DGV · HANA/);
}
const malicious=structuredClone(data);
malicious.runs[0].snapshot.name='<img src=x onerror="alert(1)"><script>evil()</script>&';
const safePrint=tax.buildPayrollPrintHtml({...malicious,kind:"tax"});
assert.doesNotMatch(safePrint,/<img|<script/);
assert.match(safePrint,/&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
assert.match(safePrint,/1,5/,'fractional statutory multipliers remain visible in print');
assert.equal(tax.buildCombinedWorkbook,undefined,"payroll reporting does not mix sales or expense exports");

assert.throws(()=>tax.buildPayrollWorkbook({...data,month:"2026-13"}));
assert.throws(()=>tax.buildPayrollWorkbook({...data,kind:"unknown"}));
assert.throws(()=>tax.buildPayrollWorkbook({...data,fromDate:"2026-02-30",toDate:"2026-03-01"}));
assert.throws(()=>tax.buildPayrollWorkbook({...data,fromDate:"2026-10-01"}));
assert.throws(()=>tax.buildPayrollWorkbook({...data,runs:[{...data.runs[0],total:NaN}]}));
for(const file of ["admin.html","expense.html"]) {
  const html=await readFile(path.join(root,file),"utf8");
  assert.doesNotMatch(html,/id="payrollTaxLink"/,"existing admin/expense are reference layouts only");
  assert.doesNotMatch(html,/\.from\(["']payroll_/i,"sales and expenses pages must not read private payroll");
}
console.log("Payroll tax passed: seven direct XLSX/print variants, immutable snapshots, adjustments/reversals, evidence/signatures, paid-date ranges, comparison, bilingual typed XLSX, safe escaped printing, unchanged admin/expense pages.");
