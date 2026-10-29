import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import vm from "node:vm";
const context=vm.createContext({console});
for(const file of ["payroll-core.js","payroll-rules.js","payroll-tax.js","payroll-receipts.js"])vm.runInContext(await readFile(new URL("../assets/"+file,import.meta.url),"utf8"),context);
const employee={id:"employee",name:"Employee",device_user_id:"1",active:true,employment_type:"full_time"};
const provider={id:"service",name:"Repair <worker>",device_user_id:"S-internal",active:true,payee_type:"service",employment_type:"part_time",phone:"090-001-001"};
const terms=[{id:"salary",employee_id:"employee",effective_from:"2026-10-01",pay_type:"monthly",rate:7000000,shift_start:"10:00",shift_end:"20:00",break_start:"12:00",break_end:"14:00",monthly_settlement:"monthly_net",weekly_rest_day:0},
{id:"legacy",employee_id:"service",effective_from:"2026-10-01",pay_type:"hourly",rate:40000,shift_start:"10:00",shift_end:"20:00",break_start:"00:00",break_end:"00:00"}];
const payments=[{id:"service-payment",employee_id:"service",payroll_month:"2026-10-01",run_id:null,paid_on:"2026-10-29",amount:1500000,method:"cash"},
{id:"employee-payment",employee_id:"employee",payroll_month:"2026-10-01",run_id:null,paid_on:"2026-10-29",amount:100000,method:"cash"}];
const input={month:"2026-10",employees:[employee,provider],terms,payments,records:[],days:[],today:"2026-10-31"};
const calculated=context.DGV_PAYROLL_CORE.summarizeMonth(input);
assert.deepEqual(Array.from(calculated,x=>x.employee_id),["employee"],"legacy hourly conditions never turn a service payment into wages");
const effective=context.DGV_PAYROLL_RULES.buildEffectiveDays(input);
assert.ok(effective.every(d=>d.employee_id!==provider.id));
const extended=context.DGV_PAYROLL_RULES.extendSummaries({...input,baseSummaries:[...calculated,{employee_id:provider.id,baseAmount:123}]});
assert.deepEqual(Array.from(extended,x=>x.employee_id),["employee"],"injected old summaries cannot reintroduce service payees");
const tax=context.DGV_PAYROLL_TAX.summarizePayroll({...input,summaries:extended});
assert.equal(tax.rows.length,1);assert.equal(tax.totals.paid,100000);assert.equal(tax.rows[0].employee_id,"employee");
const receiptInput={kind:"service",fromDate:"2026-10-01",toDate:"2026-10-31",employees:[provider],payments:[payments[0]],
serviceDetails:[{id:"service-payment",payment_id:"service-payment",work_from:"2026-10-27",work_to:"2026-10-29",description:"Electrical <repair>"}],
identities:[{employee_id:"service",national_id:"001234"}]};
const receipt=context.DGV_PAYROLL_RECEIPTS.buildModel(receiptInput);
assert.equal(receipt.kind,"service");assert.equal(receipt.rows[0].amount,1500000);assert.equal(receipt.rows[0].nationalId,"001234");
assert.equal(receipt.rows[0].workFrom,"2026-10-27");assert.equal(receipt.rows[0].workTo,"2026-10-29");
const print=context.DGV_PAYROLL_RECEIPTS.buildPrintHtml(receipt);
assert.match(print,/외주·수리 작업비/);assert.match(print,/Electrical &lt;repair&gt;/);assert.match(print,/2026-10-27/);
assert.doesNotMatch(print,/급여 미확정|미지급|잔액|급여월|S-internal/);
const cancelled=context.DGV_PAYROLL_RECEIPTS.buildModel({...receiptInput,reversals:[{id:"reverse",payment_id:"service-payment"}]});
assert.equal(cancelled.rows.length,0);assert.equal(cancelled.totals.activeTotal,0);
assert.throws(()=>context.DGV_PAYROLL_RECEIPTS.buildPrintHtml({...receiptInput,serviceDetails:[]}),/작업정보/);
assert.throws(()=>context.DGV_PAYROLL_RECEIPTS.buildModel({...receiptInput,serviceDetails:[{id:"x",payment_id:"service-payment",work_from:"2026-10-30",work_to:"2026-10-29",description:"Invalid"}]}),/작업기간/);
console.log("Service payments passed: fixed amount, no payroll/balance/attendance calculation, legacy term isolation, wage-report separation, exact job/payment/identity binding, cancellation and escaped service print.");
