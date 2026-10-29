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

// Monthly net settlement details are already included in run.allowances. The
// report exposes the basis without adding the same premium a second time.
const monthlyData=structuredClone(data);
monthlyData.runs=monthlyData.runs.slice(0,1);monthlyData.employees=monthlyData.employees.slice(0,1);
monthlyData.adjustments=[];monthlyData.payments=[];monthlyData.previousRuns=[];monthlyData.previousPayments=[];
const monthlyRun=monthlyData.runs[0];
monthlyRun.allowances=16927;monthlyRun.total=7016927;
Object.assign(monthlyRun.snapshot,{settlementMode:"monthly_net",monthlyPlannedMinutes:12480,monthlyActualMinutes:12510,monthlyBalanceMinutes:30,monthlyExtraMinutes:30,monthlyExtraHourlyRate:7000000/208,monthlyExtraAmount:16827,scheduleDefaultUsed:true,statutoryAmount:0,
  wageBreakdown:[{code:"monthly_net_extra",category:"monthly_extra",label:"Phần vượt tháng / 월 초과수당",minutes:30,rate:7000000/208,multiplier:1,amount:16827}]});
// Deliberately different current terms/calculation must never rewrite final history.
monthlyData.terms=[{employee_id:"a",effective_from:"2026-01-01",pay_type:"monthly",monthly_settlement:"monthly_net",rate:9000000,weekly_rest_day:1}];
monthlyData.summaries=[{...monthlyRun.snapshot,employee_id:"a",monthlyPlannedMinutes:12000,monthlyActualMinutes:13000,monthlyExtraMinutes:1000,monthlyExtraAmount:750000,monthlyExtraHourlyRate:45000}];
const monthlyBook=tax.buildPayrollWorkbook({...monthlyData,kind:"ledger"});
const monthlyLedger=body(monthlyBook.sheets[0])[0];
assert.equal(monthlyLedger[5],16927);assert.equal(monthlyLedger[9],7016927,"monthly extra is not added twice to approved payroll");
assert.deepEqual(Array.from(monthlyLedger.slice(16,22)),[12480,12510,30,30,33653.85,16827]);
assert.equal(monthlyLedger[22],"Có / 사용");
const monthlyAttendance=tax.buildPayrollWorkbook({...monthlyData,kind:"attendance"});
assert.equal(monthlyAttendance.sheets.length,2);
assert.deepEqual(Array.from(body(lookup(monthlyAttendance,"Đối chiếu tháng"))[0].slice(4,10)),[12480,12510,30,30,33653.85,16827]);
const monthlyTax=tax.buildPayrollWorkbook({...monthlyData,kind:"tax"});
assert.equal(monthlyTax.sheets.length,12);assert.equal(body(lookup(monthlyTax,"Khoản lương"))[0][8],16827);
assert.equal(tax.summarizePayroll(monthlyData).totals.approved,7016927);
const monthlyPrint=tax.buildPayrollPrintHtml({...monthlyData,kind:"ledger"});
assert.match(monthlyPrint,/월 기준분/);assert.match(monthlyPrint,/자동 계산 시급/);assert.match(monthlyPrint,/월 초과수당/);assert.match(monthlyPrint,/12\.480/);assert.match(monthlyPrint,/33\.653,85/);assert.match(monthlyPrint,/16\.827/);
assert.equal((monthlyPrint.match(/<table /g)||[]).length,2,"wide ledger prints readable parts with repeated employee identifiers");

const firstMonth=structuredClone(monthlyData);firstMonth.month="2026-09";firstMonth.summaries=[];
const firstRun=firstMonth.runs[0];Object.assign(firstRun,{month:"2026-09-01",base_amount:3640000,allowances:583,total:3640583});
Object.assign(firstRun.snapshot,{baseAmount:3640000,monthlyPlannedMinutes:6240,monthlyActualMinutes:6241,monthlyBalanceMinutes:1,monthlyExtraMinutes:1,monthlyExtraHourlyRate:35000,monthlyExtraAmount:583,monthlyExpectedPayDate:"2026-10-05",monthlyExtraBasisAmount:7000000,monthlyExtraBasisMinutes:12000,
  monthlyProration:{applied:true,reason:"hire_date",hireDate:"2026-09-15",fullSalary:7000000,fullPlannedMinutes:12000,activePlannedMinutes:6240,ratio:0.52,unroundedBase:3640000,baseAmount:3640000}});
for(const kind of ["ledger","attendance","tax"]){
  const firstBook=tax.buildPayrollWorkbook({...firstMonth,kind});
  const firstRow=body(lookup(firstBook,"Lương tháng đầu"))[0];
  assert.equal(firstRow[2].getDate(),15);assert.deepEqual(Array.from(firstRow.slice(3,9)),[7000000,12000,6240,52,3640000,35000]);assert.equal(firstRow[9].getDate(),5);assert.equal(firstRow[9].getMonth(),9);
  const firstPrint=tax.buildPayrollPrintHtml({...firstMonth,kind});assert.match(firstPrint,/입사 첫 달 급여/);assert.match(firstPrint,/2026-10-05/);assert.match(firstPrint,/3\.640\.000/);
}
assert.equal(tax.summarizePayroll(firstMonth).totals.approved,3640583,"first-month report uses stored prorated base and premium without recalculation from current terms");

// A nonpositive balance does not reduce the agreed monthly base in exported totals.
Object.assign(monthlyRun.snapshot,{monthlyActualMinutes:12420,monthlyBalanceMinutes:-60,monthlyExtraMinutes:0,monthlyExtraAmount:0});monthlyRun.allowances=0;monthlyRun.total=7000000;
const under=body(tax.buildPayrollWorkbook({...monthlyData,kind:"ledger"}).sheets[0])[0];
assert.equal(under[4],7000000);assert.equal(under[9],7000000);assert.equal(under[18],-60);assert.equal(under[19],0);assert.equal(under[21],0);
const legacyLedger=body(tax.buildPayrollWorkbook({...data,kind:"ledger"}).sheets[0]);
assert.ok(legacyLedger.every(row=>row.length===15),"legacy monthly/hourly reports retain their original columns without invented net-settlement amounts");

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
