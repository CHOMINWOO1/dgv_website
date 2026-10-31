import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import vm from "node:vm";

const context={console,Date,Uint8Array,Uint32Array};
vm.createContext(context);
vm.runInContext(await readFile(new URL("../assets/payroll-receipts.js",import.meta.url),"utf8"),context);
const receipts=context.DGV_PAYROLL_RECEIPTS;
const plain=value=>JSON.parse(JSON.stringify(value));
const payment=(id,employee,month,amount,paidOn="2026-11-05",extra={})=>({id,employee_id:employee,payroll_month:month+"-01",run_id:null,amount,paid_on:paidOn,method:"cash",...extra});
const input={fromDate:"2026-11-01",toDate:"2026-11-06",employees:[
  {id:"part",name:"Z part",device_user_id:"0001",phone:"00123",employment_type:"full_time",national_id:"NEVER-EMPLOYEE-ID"},
  {id:"regular",name:"A regular",device_user_id:"0002",phone:"00456",employment_type:"full_time"},
  {id:"draft",name:"B draft",device_user_id:"0003",employment_type:"part_time"},
  {id:"unknown",name:"A unknown",device_user_id:"0004"}
],identities:[{employee_id:"part",national_id:"000001"}],runs:[
  {id:"r-part",employee_id:"part",month:"2026-10-01",base_amount:220000,allowances:30000,deductions:10000,snapshot:{name:"Z part",employmentType:"part_time",employment_type:"full_time",minutes:330,workedDays:2,settlementMode:"hourly_actual",hourlyActualMinutes:330,hourlyRates:[40000,50000],daily:[{date:"2026-10-01",minutes:150,actualSeconds:9000},{date:"2026-10-31",minutes:180,actualSeconds:10800}],monthlyExtraAmount:999999,national_id:"NEVER-SNAPSHOT-ID"}},
  {id:"r-full",employee_id:"regular",month:"2026-10-01",base_amount:7000000,allowances:100000,deductions:0,snapshot:{name:"A regular",employmentType:"full_time",settlementMode:"monthly_net",minutes:123,monthlyActualMinutes:12481,workedDays:26,monthlyExtraHourlyRate:350000/10.4,daily:[]}}
],receiptSummaries:[
  {employee_id:"part",month:"2026-10",baseAmount:1,minutes:1,workedDays:1},
  {employee_id:"draft",month:"2026-10",employmentType:"part_time",baseAmount:180000,minutes:270,workedDays:1,settlementMode:"hourly_actual",hourlyRate:40000,hourlyActualMinutes:270,monthlyExtraAmount:0,statutoryAmount:10000,unresolved:1,daily:[{date:"2026-10-27",minutes:270,actualSeconds:16200}],privateNotes:"NEVER-SUMMARY-SECRET"},
  {employee_id:"draft",month:"2026-11",employmentType:"part_time",baseAmount:999,minutes:999,daily:[]}
],adjustments:[{id:"adj1",run_id:"r-part",amount:12000,reason:"NEVER-ADJUSTMENT-REASON"},{id:"adj2",run_id:"r-part",amount:-2000}],payments:[
  payment("full-pay","regular","2026-10",3000000,"2026-11-01",{run_id:"r-full",method:"bank"}),
  payment("part-second","part","2026-10",75000,"2026-11-06",{run_id:"r-part"}),
  payment("part-first","part","2026-10",125000,"2026-11-05"),
  payment("draft-pay","draft","2026-10",180000),
  payment("unknown-pay","unknown","2026-10",90000),
  payment("cancelled","part","2026-10",999999),
  payment("outside","part","2026-10",888888,"2026-11-07")
],reversals:[{id:"rev",payment_id:"cancelled"}],attachments:[]};

const before=JSON.stringify(input),model=receipts.buildModel(input),groups=receipts.buildReportGroups(model);
assert.equal(JSON.stringify(input),before,"monthly grouping must not mutate source or store private fields in employee snapshots");
assert.deepEqual(plain(groups.map(group=>[group.employmentType,group.employeeId])),[["part_time","draft"],["part_time","part"],["full_time","regular"],["unknown","unknown"]]);
assert.equal(model.totals.activeTotal,3470000,"only selected actual payments contribute to payment totals");
const part=groups.find(group=>group.employeeId==="part"),full=groups.find(group=>group.employeeId==="regular"),draft=groups.find(group=>group.employeeId==="draft"),unknown=groups.find(group=>group.employeeId==="unknown");
assert.deepEqual(plain(part.rows.map(row=>row.paymentId)),["part-first","part-second"]);
assert.equal(part.rows[0].isAdvance,true,"a pre-finalization payment remains an advance after its month gets finalized");
assert.equal(part.rows[0].matchedRunId,"r-part");
assert.strictEqual(part.rows[0].detail,part.rows[1].detail,"monthly context is shared, not independently allocated to instalments");
assert.deepEqual(plain(part.detail),{workDates:["2026-10-01","2026-10-31"],workedDays:2,minutes:330,hourlyRates:[40000,50000],rateLabel:"복수 단가 / Nhiều đơn giá",baseAmount:220000,allowances:30000,deductions:10000,adjustmentAmount:10000,source:"finalized",issues:[]});
assert.equal(part.nationalId,"000001");assert.equal(part.phone,"00123");
assert.equal(full.detail.minutes,12481,"use monthly actual minutes, not the legacy display-minute sum");
assert.equal(full.detail.allowances,100000,"stored final allowance already includes extra pay; never add it again");
assert.match(full.detail.rateLabel,/월 환산시급/);
assert.equal(draft.detail.source,"calculated");assert.equal(draft.detail.minutes,270,"paid November date must join the explicit October calculation");
assert.equal(draft.detail.baseAmount,180000);assert.equal(draft.detail.allowances,null);assert.equal(draft.detail.deductions,null);
assert.match(draft.detail.issues.join(" "),/10,000 VND/);assert.match(draft.detail.issues.join(" "),/미확정/);assert.match(draft.detail.issues.join(" "),/조건 확인/);
assert.equal(unknown.detail.source,"unavailable");assert.equal(unknown.detail.workedDays,null);assert.equal(unknown.detail.minutes,null);assert.equal(unknown.employmentType,"unknown");
assert.doesNotMatch(JSON.stringify(model)+JSON.stringify(groups),/NEVER-/,"private snapshot and adjustment metadata must not enter the report model");

const html=receipts.buildPrintHtml(model),rowHtml=id=>html.match(new RegExp(`<tr data-payment-id="${id}"[\\s\\S]*?<\\/tr>`))?.[0],cell=(row,field)=>row.match(new RegExp(`data-receipt-field="${field}"[^>]*>([\\s\\S]*?)<\\/td>`))?.[1];
assert.equal((html.match(/<th scope="col">/g)||[]).length,11);
for(const name of ["번호","직원 / 코드","근무일","실근무","시급 (VND)","기본급 (VND)","수당","공제","실지급액 (VND)","지급수단","수령확인"])assert.ok(html.includes(name),name);
assert.ok(html.indexOf('data-employment-type="part_time"')<html.indexOf('data-employment-type="full_time"'));
assert.ok(html.indexOf('data-employment-type="full_time"')<html.indexOf('data-employment-type="unknown"'));
assert.equal((html.match(/<tr data-payment-id=/g)||[]).length,5);
assert.equal(cell(rowHtml("part-first"),"base-amount"),"220,000");
assert.equal(cell(rowHtml("part-first"),"work-minutes"),"5h 30m");
for(const field of ["worked-days","work-minutes","hourly-rates","base-amount","allowances","deductions"])assert.equal(cell(rowHtml("part-second"),field),"",`monthly ${field} must appear once`);
assert.equal(cell(rowHtml("part-first"),"paid-amount"),"125,000");assert.equal(cell(rowHtml("part-second"),"paid-amount"),"75,000");
assert.match(rowHtml("part-second"),/2026-11-06/);assert.match(rowHtml("part-first"),/CCCD \/ CMND: 000001/);assert.match(rowHtml("part-first"),/TEL: 00123/);
assert.match(html,/월 급여 별도 정정[\s\S]*\+10,000 VND/);assert.match(html,/해당 급여월 전체 자료/);assert.match(html,/첫 지급 행에 한 번/);
assert.doesNotMatch(html,/data-payment-id="(?:cancelled|outside)"|NEVER-/);
assert.ok(receipts.buildTableHtml(model).indexOf('data-payment-id="part-first"')<receipts.buildTableHtml(model).indexOf('data-payment-id="full-pay"'),"onscreen flat table follows the same role ordering");

const selected=receipts.buildModel({...input,employeeId:"part",fromDate:"2026-11-06",toDate:"2026-11-06"});
assert.equal(selected.totals.activeTotal,75000);assert.equal(receipts.buildReportGroups(selected)[0].detail.baseAmount,220000,"narrow paid-date selection never prorates monthly salary");
assert.equal(cell(receipts.buildPrintHtml(selected).match(/<tr data-payment-id="part-second"[\s\S]*?<\/tr>/)[0],"base-amount"),"220,000","first selected payment carries context even if an earlier payment is outside range");

const noInference=receipts.buildModel({...input,runs:[],employees:[{id:"unknown",name:"Hourly unknown"}],payments:[payment("no-inference","unknown","2026-10",1)],receiptSummaries:[{employee_id:"unknown",month:"2026-10",payTypes:["hourly"],hourlyRate:40000,minutes:1}],adjustments:[]});
assert.equal(noInference.rows[0].employmentType,"unknown","hourly wages do not establish employment type");
assert.equal(receipts.buildModel({...input,runs:[],employees:[{id:"unknown",name:"Unclassified",employment_type:null}],payments:[payment("default-type","unknown","2026-10",1)],receiptSummaries:[{employee_id:"unknown",month:"2026-10",employmentType:"full_time",minutes:0}],adjustments:[]}).rows[0].employmentType,"unknown","calculation default full_time is not evidence of an explicit employee classification");
assert.equal(receipts.buildModel({...input,runs:input.runs.map(run=>run.id==="r-part"?{...run,snapshot:{...run.snapshot,employmentType:undefined,employment_type:undefined,employee:{employment_type:"part_time"}}}:run)}).rows.find(row=>row.employeeId==="part").employmentType,"part_time","legacy nested explicit type is retained");

assert.throws(()=>receipts.buildModel({...input,receiptSummaries:[{employee_id:"draft",minutes:1}]}),/직원·월/);
assert.throws(()=>receipts.buildModel({...input,receiptSummaries:[...input.receiptSummaries,{...input.receiptSummaries[1],minutes:1}]}),/중복/);
assert.throws(()=>receipts.buildModel({...input,runs:input.runs.map(run=>run.id==="r-part"?{...run,snapshot:{...run.snapshot,daily:[{date:"2026-11-01",minutes:1}]}}:run)}),/급여월/);
assert.throws(()=>receipts.buildModel({...input,runs:input.runs.map(run=>run.id==="r-part"?{...run,base_amount:-1}:run)}),/수치/);
for(const field of ["base_amount","allowances","deductions"])assert.throws(()=>receipts.buildModel({...input,runs:input.runs.map(run=>run.id==="r-part"?{...run,[field]:true}:run)}),/수치/,`boolean ${field} must not turn into 1 VND`);
for(const field of ["workedDays","hourlyActualMinutes"])assert.throws(()=>receipts.buildModel({...input,runs:input.runs.map(run=>run.id==="r-part"?{...run,snapshot:{...run.snapshot,[field]:false}}:run)}),/수치/,`boolean ${field} must not turn into zero`);
assert.throws(()=>receipts.buildModel({...input,runs:input.runs.map(run=>run.id==="r-part"?{...run,snapshot:{...run.snapshot,daily:[{date:"2026-10-01",actualSeconds:true}]}}:run)}),/수치/);
assert.throws(()=>receipts.buildModel({...input,runs:input.runs.map(run=>run.id==="r-part"?{...run,snapshot:{...run.snapshot,hourlyRates:[true]}}:run)}),/수치/);
assert.throws(()=>receipts.buildModel({...input,adjustments:[{id:"bad",run_id:"r-part",amount:"NaN"}]}),/수치/);
assert.equal(receipts.buildModel({...input,adjustments:[...input.adjustments,structuredClone(input.adjustments[0])]}).rows.find(row=>row.employeeId==="part").detail.adjustmentAmount,10000,"repeated fetch rows cannot repeat corrections");

const direct=structuredClone(model);
const poison={...structuredClone(direct.rows[0]),paymentId:"direct-cancel",status:"cancelled"};
Object.defineProperty(poison,"detail",{get(){throw new Error("Cancelled detail must never be read");}});direct.rows.push(poison);
assert.equal(receipts.buildPrintHtml(direct),html);
const outside={...structuredClone(direct.rows[0]),paymentId:"direct-outside",paidOn:"2026-12-01"};
Object.defineProperty(outside,"detail",{get(){throw new Error("Out-of-range detail must never be read");}});direct.rows.push(outside);
assert.equal(receipts.buildPrintHtml(direct),html);
const conflict=structuredClone(model);conflict.rows.find(row=>row.paymentId==="part-second").detail=structuredClone(conflict.rows.find(row=>row.paymentId==="part-second").detail);conflict.rows.find(row=>row.paymentId==="part-second").detail.baseAmount++;
assert.throws(()=>receipts.buildReportGroups(conflict),/일치하지/);
const hostile=structuredClone(model);hostile.rows.filter(row=>row.employeeId==="part").forEach(row=>{row.detail.issues=['<script>detailAttack()</script>'];row.detail.rateLabel='<img src=x onerror="rateAttack()">';});
const safe=receipts.buildPrintHtml(hostile);assert.doesNotMatch(safe,/<script|<img src=x/);assert.match(safe,/&lt;script&gt;detailAttack/);assert.match(safe,/&lt;img src=x/);
const empty=receipts.buildModel({...input,payments:[]});assert.equal(receipts.buildReportGroups(empty).length,0);assert.match(receipts.buildPrintHtml(empty),/colspan="11">선택기간 지급 내역 없음/);

console.log("Payroll receipt monthly detail tests passed: explicit role order, full payroll-month context, first-payment-only values, immutable finalized amounts, no invented allocation, advance continuity, draft/unknown data, corrections, filter/privacy guards, XSS, and 11-column print.");
