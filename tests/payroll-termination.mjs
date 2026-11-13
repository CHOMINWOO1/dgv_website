import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

// Synthetic calculation and report fixtures only. No client, network or database.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const context={console,Date,Map,Set,Object,Array,Number,String,Boolean,Math,JSON};
context.globalThis=context;
for(const file of ['core','rules','conversions','tax'])vm.runInNewContext(await readFile(path.join(root,'assets',`payroll-${file}.js`),'utf8'),context);
const core=context.DGV_PAYROLL_CORE,rules=context.DGV_PAYROLL_RULES,conversions=context.DGV_PAYROLL_CONVERSIONS;
const employee={id:'exit-unit-employee',device_user_id:'exit-unit-device',name:'Synthetic departing employee',hire_date:'2026-01-01',employment_type:'full_time',employment_status:'active',active:true};
const term={id:'exit-unit-monthly',employee_id:employee.id,effective_from:'2026-01-01',pay_type:'monthly',rate:7000000,monthly_settlement:'monthly_net',weekly_rest_day:0,shift_start:'10:00',shift_end:'20:00',break_start:'12:00',break_end:'14:00'};
const next=date=>new Date(Date.parse(date+'T00:00:00Z')+86400000).toISOString().slice(0,10);
const override=(date,day_type)=>({employee_id:employee.id,work_date:date,day_type,reason:'Synthetic schedule override'});
const pair=(date,from='10:00',to='20:00',endDate=date)=>[{id:`${date}-in`,employee_id:employee.id,occurred_at:`${date}T${from}:00`,punch_type:'in'},{id:`${date}-out`,employee_id:employee.id,occurred_at:`${endDate}T${to}:00`,punch_type:'out'}];
function fullRecords({month='2026-10',employees=[employee],terms=[term],days=[]}={}){
 return rules.buildEffectiveDays({month,employees,terms,days}).filter(d=>d.work_date.startsWith(month)&&d.day_type==='work').flatMap(d=>{
  const current=terms.filter(t=>t.employee_id===d.employee_id&&t.effective_from<=d.work_date).sort((a,b)=>a.effective_from.localeCompare(b.effective_from)).at(-1);
  return pair(d.work_date,current.shift_start,current.shift_end,current.shift_end<current.shift_start?next(d.work_date):d.work_date);
 });
}
function calculate(more={}){
 const model={month:'2026-10',employees:[employee],terms:[term],days:[],conversions:[],rules:[],today:'2026-11-01',...more};
 if(!Object.hasOwn(more,'records'))model.records=fullRecords(model);
 const before=JSON.stringify(model),historical=conversions.historicalEmployees(model.employees,model.conversions,model.month);
 const days=rules.buildEffectiveDays({...model,employees:historical});
 const base=core.summarizeMonth({...model,employees:historical,days});
 const enhanced=rules.extendSummaries({...model,employees:historical,days,baseSummaries:base});
 const row=conversions.extendSummaries({...model,days,baseSummaries:enhanced})[0];
 assert.equal(JSON.stringify(model),before,'calculation never mutates employment, terms or attendance inputs');
 return row;
}
const departing=date=>({...employee,termination_date:date,employment_status:'terminated',active:false});
const expected=(workDays,fullDays,rate=7000000)=>Math.round(rate*workDays/fullDays);

// October 2026 has 27 scheduled weekdays. The 15th is included: 13 weekdays.
let row=calculate({employees:[departing('2026-10-15')]});
assert.equal(row.baseAmount,expected(13,27));
assert.equal(row.monthlyPlannedMinutes,13*480);
assert.equal(row.monthlyActualMinutes,13*480);
assert.equal(row.monthlyProration.fullPlannedMinutes,27*480);
assert.equal(row.monthlyProration.activePlannedMinutes,13*480);
assert.equal(row.monthlyExtraHourlyRate,7000000/(27*8),'extra pay retains full-calendar salary basis');
assert.equal(row.compensationUnresolved,0);
assert.equal(row.unresolved,0);
assert.equal(row.monthlyReadyToFinalize,true);
assert.equal(row.monthlyExpectedPayDate,'2026-11-05');
assert.equal(row.daily.find(d=>d.date==='2026-10-15').minutes,480,'termination day is payable');
assert.equal(row.monthlyPendingDays,0);

// Neither early employment days nor days following termination are paid.
const hireAndExit={...departing('2026-10-25'),hire_date:'2026-10-15'};
row=calculate({employees:[hireAndExit],terms:[{...term,effective_from:'2026-10-15'}]});
assert.equal(row.baseAmount,expected(9,27));
assert.equal(row.monthlyPlannedMinutes,9*480);
assert.equal(row.compensationUnresolved,0);
assert.equal(row.monthlyActualMinutes,9*480);

row=calculate({employees:[departing('2026-10-01')]});
assert.equal(row.baseAmount,expected(1,27));
assert.equal(row.monthlyPlannedMinutes,480);
row=calculate({employees:[departing('2026-10-31')]});
assert.equal(row.baseAmount,7000000,'last-day termination keeps a full month');
assert.equal(row.compensationUnresolved,0);
row=calculate({month:'2026-11',employees:[departing('2026-11-01')],records:[],today:'2026-12-01'});
assert.equal(row.baseAmount,0,'a period containing only the weekly rest day has no scheduled payable basis');
assert.equal(row.monthlyPlannedMinutes,0);
assert.equal(row.monthlyActualMinutes,0);

// Use the selected month's real calendar, including February 29.
const leapTerm={...term,effective_from:'2028-01-01'};
row=calculate({month:'2028-02',employees:[{...departing('2028-02-15'),hire_date:'2028-01-01'}],terms:[leapTerm],today:'2028-03-01'});
assert.equal(row.baseAmount,expected(13,25));
assert.equal(row.monthlyProration.fullPlannedMinutes,25*480);
row=calculate({month:'2028-02',employees:[{...departing('2028-02-29'),hire_date:'2028-01-01'}],terms:[leapTerm],today:'2028-03-01'});
assert.equal(row.baseAmount,7000000);

// Explicit calendars affect both active and full-month bases, not actual punches.
row=calculate({employees:[departing('2026-10-15')],days:[override('2026-10-02','rest')]});
assert.equal(row.baseAmount,expected(12,26));
assert.equal(row.monthlyProration.fullPlannedMinutes,26*480);
row=calculate({employees:[departing('2026-10-15')],days:[override('2026-10-18','work')]});
assert.equal(row.baseAmount,expected(13,28));

// A stable wage with an effective-date schedule change uses the real scheduled
// minutes; this is not a hardcoded working-day or 26/208 divisor.
const shorter={...term,id:'exit-shorter',effective_from:'2026-10-10',shift_end:'18:00'};
row=calculate({employees:[departing('2026-10-15')],terms:[term,shorter]});
assert.equal(row.monthlyProration.fullPlannedMinutes,178*60);
assert.equal(row.monthlyPlannedMinutes,94*60);
assert.equal(row.baseAmount,Math.round(7000000*94/178));
assert.equal(row.compensationUnresolved,0);

// A later contract must not retroactively change a former employee's basis.
row=calculate({employees:[departing('2026-10-15')],terms:[term,{...term,id:'future-unrelated',effective_from:'2026-10-20',rate:9000000,shift_end:'18:00'}]});
assert.equal(row.baseAmount,expected(13,27));
assert.equal(row.compensationUnresolved,0);

// Fixed monthly wages are not generated attendance. Incomplete/current periods
// remain visibly pending; dates after the last employment date are never pending.
row=calculate({employees:[departing('2026-10-15')],records:[]});
assert.equal(row.baseAmount,expected(13,27));
assert.equal(row.monthlyActualMinutes,0);
assert.equal(row.workedDays,0);
assert.equal(row.monthlyExtraAmount,0);
row=calculate({employees:[departing('2026-10-15')],records:[],today:'2026-10-10'});
assert.equal(row.baseAmount,expected(13,27));
assert.equal(row.monthlyPendingDays,5);
assert.equal(row.monthlyReadyToFinalize,false);
assert.ok(row.daily.filter(d=>d.monthlyPending).every(d=>d.date<='2026-10-15'));

row=calculate({month:'2026-09',employees:[departing('2026-10-15')],today:'2026-10-01'});
assert.equal(row.baseAmount,7000000,'earlier salary months are unaffected by later termination');
row=calculate({month:'2026-11',employees:[departing('2026-10-15')],records:[],today:'2026-12-01'});
assert.equal(row.baseAmount,0,'after-employment months remain zero');
assert.equal(row.monthlyActualMinutes,0);

// Missing contracts and genuinely different salary rates cannot be silently
// cleared as a termination-date issue; they still need explicit review.
row=calculate({employees:[departing('2026-10-15')],terms:[],records:[]});
assert.ok(row.unresolved>0);
row=calculate({employees:[departing('2026-10-15')],terms:[term,{...term,id:'changed-rate',effective_from:'2026-10-10',rate:8000000}]});
assert.equal(row.baseAmount,null);
assert.ok(row.compensationUnresolved>0);
assert.equal(row.monthlyReadyToFinalize,false);

// Real attendance outside the employment window or across an overnight exit
// boundary must not become an automatically approvable payout.
row=calculate({employees:[departing('2026-10-15')],records:[...fullRecords({employees:[departing('2026-10-15')]}),...pair('2026-10-16')]});
assert.ok(row.attendanceUnresolved>0);
assert.equal(row.monthlyReadyToFinalize,false);
const night={...term,shift_start:'22:00',shift_end:'06:00',break_start:'01:00',break_end:'02:00'};
row=calculate({employees:[departing('2026-10-15')],terms:[night],records:pair('2026-10-15','22:00','06:00','2026-10-16')});
assert.ok(row.attendanceUnresolved>0);

// Existing conversion periods retain their agreed prior wage and stop the new
// monthly period at termination, without paying the rest of the calendar month.
const hourly={...term,id:'exit-hourly',pay_type:'hourly',monthly_settlement:'statutory',rate:25000,break_start:'00:00',break_end:'00:00'};
const convertedMonthly={...term,id:'exit-converted-monthly',effective_from:'2026-10-15'};
const conversion={employee_id:employee.id,effective_from:'2026-10-15',prior_employment_type:'part_time',employment_type:'full_time',prior_salary_amount:1000000};
row=calculate({employees:[{...hireAndExit,hire_date:'2026-10-01'}],terms:[hourly,convertedMonthly],conversions:[conversion],records:[]});
assert.equal(row.baseAmount,1000000+expected(9,27));
assert.equal(row.conversionSegments.length,2);
assert.equal(row.conversionSegments[1].to,'2026-10-25');
assert.equal(row.conversionSegments[1].baseAmount,expected(9,27));

// The actual report model must credit existing same-month advances exactly
// once, ignore reversed and other-month payments, and preserve finalized values.
const exitSummary=calculate({employees:[departing('2026-10-15')]});
const frozen={id:'exit-approved',employee_id:employee.id,month:'2026-10-01',base_amount:exitSummary.baseAmount,allowances:0,deductions:0,total:exitSummary.baseAmount,snapshot:JSON.parse(JSON.stringify(exitSummary))};
const payments=[
 {id:'exit-advance',run_id:null,employee_id:employee.id,payroll_month:'2026-10-01',amount:1000000,paid_on:'2026-10-10',method:'cash'},
 {id:'exit-linked',run_id:frozen.id,employee_id:employee.id,payroll_month:'2026-10-01',amount:500000,paid_on:'2026-10-20',method:'bank'},
 {id:'exit-reversed',run_id:null,employee_id:employee.id,payroll_month:'2026-10-01',amount:200000,paid_on:'2026-10-12',method:'cash'},
 {id:'other-salary-month',run_id:null,employee_id:employee.id,payroll_month:'2026-09-01',amount:900000,paid_on:'2026-10-05',method:'cash'}
];
const reportInput={month:'2026-10',employees:[departing('2026-10-15')],terms:[{...term,rate:9000000}],records:[],days:[],summaries:[{...exitSummary,baseAmount:1}],runs:[frozen],payments,previousPayments:[payments[0]],reversals:[{id:'exit-reversal',payment_id:'exit-reversed'}],attachments:[{id:'exit-signature',payment_id:'exit-advance',evidence_type:'signature',signed_name:'Synthetic departing employee'}]};
const original=JSON.stringify(reportInput),model=context.DGV_PAYROLL_TAX.summarizePayroll(reportInput);
assert.equal(model.rows[0].approved,frozen.total,'saved final salary wins over changed terms and recalculation');
assert.equal(model.rows[0].paid,1500000);
assert.equal(model.rows[0].outstanding,frozen.total-1500000);
assert.equal(model.rows[0].payments.length,3,'duplicate advance references are not added twice');
assert.equal(model.rows[0].payments.find(p=>p.payment.id==='exit-advance').evidence[0].id,'exit-signature');
assert.equal(JSON.stringify(reportInput),original,'report never rewrites wages, payments or signatures');
console.log('Termination payroll passed: inclusive exit/hire dates, real/leap calendars, schedule changes/overrides, frozen post-exit terms, pending/zero attendance safety, historical months, invalid/outside/overnight review, conversion periods, exact payment netting and immutable finalized records.');
