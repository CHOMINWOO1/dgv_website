import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

// Synthetic, isolated fixtures: no client, network, production data or writes.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const context={};
for(const name of ['core','rules','conversions'])vm.runInNewContext(await readFile(path.join(root,'assets',`payroll-${name}.js`),'utf8'),context);
const core=context.DGV_PAYROLL_CORE,rules=context.DGV_PAYROLL_RULES,conversions=context.DGV_PAYROLL_CONVERSIONS;
const employee={id:'period-employee',device_user_id:'period-device',name:'Synthetic conversion employee',hire_date:'2026-11-03',employment_type:'full_time',employment_status:'active',active:true};
const hourly={id:'period-hourly',employee_id:employee.id,effective_from:'2026-11-01',pay_type:'hourly',rate:25000,shift_start:'10:00',shift_end:'20:00',break_start:'12:00',break_end:'14:00',weekly_rest_day:0,monthly_settlement:'statutory'};
const monthly={...hourly,id:'period-monthly',effective_from:'2026-11-13',pay_type:'monthly',rate:7000000,monthly_settlement:'monthly_net'};
const conversion={employee_id:employee.id,effective_from:'2026-11-13',prior_employment_type:'part_time',employment_type:'full_time',prior_salary_amount:1700000};
const beforeDates=[3,4,5,6,7,9,10,11,12],afterDates=Array.from({length:11},(_,index)=>index+13);
function pair(day,minutes,fullTime){
  const date=`2026-11-${String(day).padStart(2,'0')}`,start=Date.parse(date+'T10:00:00Z');
  // 31 seconds per day deliberately exposes aggregate-rounding drift.
  const end=new Date(start+(minutes+(fullTime?120:0))*60000+31000).toISOString().slice(0,19);
  return [{employee_id:employee.id,occurred_at:date+'T10:00:00',punch_type:'in'},{employee_id:employee.id,occurred_at:end,punch_type:'out'}];
}
const records=[...beforeDates.flatMap((day,index)=>pair(day,index===8?583:584,false)),...afterDates.flatMap((day,index)=>pair(day,index===10?519:512,true))];
const fixture={month:'2026-11',today:'2026-12-01',employees:[employee],terms:[hourly,monthly],records,days:[],conversions:[conversion],rules:[]};
const checkedInputs=[];
function calculate(more={},engines={core,rules,conversions},track=true){
  const {core,rules,conversions}=engines;
  const input=structuredClone({...fixture,...more}),original=JSON.stringify(input);
  const employees=conversions.historicalEmployees(input.employees,input.conversions,input.month);
  const days=rules.buildEffectiveDays({...input,employees});
  const base=core.summarizeMonth({...input,employees,days});
  const enhanced=rules.extendSummaries({...input,employees,days,baseSummaries:base});
  const row=conversions.extendSummaries({...input,days,baseSummaries:enhanced})[0];
  assert.equal(JSON.stringify(input),original,'display calculation must not mutate input records, terms or conversions');
  if(track)checkedInputs.push(input);
  return row;
}
const sum=(daily,key)=>daily.reduce((total,day)=>total+Number(day[key]||0),0);
const plain=value=>JSON.parse(JSON.stringify(value));
const row=calculate(),period=row.currentEmploymentAttendance;
assert.equal(period.from,'2026-11-13');assert.equal(period.to,'2026-11-30');assert.equal(period.type,'full_time');
assert.equal(period.minutes,93*60+59);assert.equal(period.workedDays,11);
assert.equal(period.previous.length,1);assert.equal(period.previous[0].minutes,87*60+35);assert.equal(period.previous[0].workedDays,9);
assert.equal(period.previous[0].from,'2026-11-03');assert.equal(period.previous[0].to,'2026-11-12');
assert.equal(row.minutes,181*60+34);assert.equal(row.workedDays,20,'raw month totals remain available for snapshots and exports');
const after=row.daily.filter(day=>day.date>='2026-11-13');
assert.equal(period.minutes,sum(after,'minutes'));
assert.equal(Math.floor(sum(after,'actualSeconds')/60),period.minutes+5,'five minutes from aggregate rounding must not leak into the display');
assert.equal(row.monthlyActualMinutes,period.minutes+5,'existing financial segment precision is unchanged');
assert.equal(row.baseAmount,5900000);assert.equal(row.monthlyExtraAmount,0);assert.equal(row.statutoryAmount,0);
assert.equal(row.conversionSegments[0].baseAmount,1700000);assert.equal(row.conversionSegments[1].baseAmount,4200000);
assert.match(conversions.attendanceLabel(period),/11\/13 이후 정규직/);

const reverse={...conversion,effective_from:'2026-11-20',prior_employment_type:'full_time',employment_type:'part_time',prior_salary_amount:null};
const reversedTerms=[hourly,monthly,{...hourly,id:'period-hourly-again',effective_from:'2026-11-20',rate:30000}];
const repeated=calculate({employees:[{...employee,employment_type:'part_time'}],terms:reversedTerms,conversions:[reverse,conversion]});
assert.equal(repeated.currentEmploymentAttendance.from,'2026-11-20');assert.equal(repeated.currentEmploymentAttendance.type,'part_time');
assert.equal(repeated.currentEmploymentAttendance.workedDays,4);assert.equal(repeated.currentEmploymentAttendance.previous.length,2);
assert.equal(repeated.currentEmploymentAttendance.minutes,sum(repeated.daily.filter(day=>day.date>='2026-11-20'),'minutes'));
assert.equal(repeated.currentEmploymentAttendance.previous[1].from,'2026-11-13');assert.equal(repeated.currentEmploymentAttendance.previous[1].to,'2026-11-19');
assert.match(conversions.attendanceLabel(repeated.currentEmploymentAttendance),/11\/20 이후 파트타임/);

const upcoming=calculate({today:'2026-11-19',employees:[{...employee,employment_type:'part_time'}],terms:reversedTerms,conversions:[reverse,conversion]});
assert.equal(upcoming.currentEmploymentAttendance.from,'2026-11-13','a future conversion cannot become the current displayed period');
assert.equal(upcoming.currentEmploymentAttendance.to,'2026-11-19');assert.equal(upcoming.currentEmploymentAttendance.type,'full_time');
assert.equal(upcoming.currentEmploymentAttendance.workedDays,7);
const onlyFuture=calculate({today:'2026-11-12'});
assert.equal(Object.hasOwn(onlyFuture,'currentEmploymentAttendance'),false,'no current-period override before the first conversion');
assert.equal(Object.hasOwn(calculate({month:'2026-10'}),'currentEmploymentAttendance'),false);
assert.equal(Object.hasOwn(calculate({month:'2026-12',today:'2027-01-01'}),'currentEmploymentAttendance'),false,'later whole months keep their original display');
assert.equal(Object.hasOwn(calculate({conversions:[]}), 'currentEmploymentAttendance'),false);
assert.equal(conversions.currentAttendance({minutes:99}),null);

const sameDay=calculate({employees:[{...employee,hire_date:'2026-11-01'}],terms:[{...monthly,effective_from:'2026-11-01'}],conversions:[{...conversion,effective_from:'2026-11-01'}]});
assert.equal(sameDay.currentEmploymentAttendance.from,'2026-11-01');assert.equal(sameDay.currentEmploymentAttendance.previous.length,0);
const terminated=calculate({employees:[{...employee,termination_date:'2026-11-21',employment_status:'terminated',active:false}]});
assert.equal(terminated.currentEmploymentAttendance.to,'2026-11-21');assert.equal(terminated.currentEmploymentAttendance.workedDays,9);
assert.equal(terminated.currentEmploymentAttendance.minutes,sum(terminated.daily.filter(day=>day.date>='2026-11-13'&&day.date<='2026-11-21'),'minutes'));
assert.equal(Object.hasOwn(calculate({employees:[{...employee,termination_date:'2026-11-10',employment_status:'terminated',active:false}]}),'currentEmploymentAttendance'),false,'a conversion after termination cannot create an active display period');

// Saving/displaying the period must leave every existing monetary/attendance
// calculation intact. Existing snapshot and payment objects are read-only.
const snapshot=plain(row),legacySnapshot=plain(row);delete legacySnapshot.currentEmploymentAttendance;
const run={id:'preserved-run',employee_id:employee.id,base_amount:5900000,allowances:150000,deductions:25000,total:6025000,snapshot};
const payments=[{id:'preserved-payment',employee_id:employee.id,run_id:run.id,amount:1700000,paid_on:'2026-11-13'}];
const runBefore=JSON.stringify(run),paymentsBefore=JSON.stringify(payments),rowBefore=JSON.stringify(row);
assert.equal(conversions.currentAttendance(run.snapshot).minutes,5639);
assert.equal(conversions.currentAttendance(legacySnapshot),null,'legacy snapshots must never borrow live period fields');
conversions.summarizeCurrentAttendance({month:'2026-11',today:'2026-12-01',employee,changes:[conversion],daily:row.daily});
assert.equal(JSON.stringify(row),rowBefore);assert.equal(JSON.stringify(run),runBefore);assert.equal(JSON.stringify(payments),paymentsBefore);
assert.equal(run.base_amount+run.allowances-run.deductions,6025000);assert.equal(run.total-payments[0].amount,4325000);

// Exercise the real conversion-detail renderer with a minimal local DOM.
const elements=new Map();
function element(){return {id:'',innerHTML:'',className:'',dataset:{},append(){},after(node){elements.set(node.id,node);},remove(){elements.delete(this.id);}};}
for(const id of ['detailSummary','employeeActionBar']){const node=element();node.id=id;elements.set(id,node);}
context.document={createElement:element};
context.DGV_PAYROLL_APP={state:{employees:[{...employee,employment_status:'terminated'}],terms:[],conversions:[conversion]},$:id=>elements.get(id),esc:value=>String(value),money:value=>String(value),hours:minutes=>`${Math.floor(minutes/60)}h ${minutes%60}m`,paidForEmployee:()=>payments[0].amount};
conversions.renderDetail(row);
assert.match(elements.get('currentEmploymentAttendanceSummary').innerHTML,/93h 59m/);
assert.match(elements.get('currentEmploymentAttendanceSummary').innerHTML,/87h 35m/);
assert.match(elements.get('currentEmploymentAttendanceSummary').innerHTML,/previousEmploymentAttendance/);
assert.doesNotMatch(elements.get('currentEmploymentAttendanceSummary').innerHTML,/정정됨|지급 완료/);
assert.match(elements.get('employmentConversionSummary').innerHTML,/1700000.*4200000/s);
const live=plain(row);live.currentEmploymentAttendance.minutes=9999;
conversions.renderDetail(live,run);
assert.match(elements.get('currentEmploymentAttendanceSummary').innerHTML,/93h 59m/);
assert.doesNotMatch(elements.get('currentEmploymentAttendanceSummary').innerHTML,/166h 39m/);
assert.match(elements.get('currentEmploymentAttendanceSummary').innerHTML,/확정 당시 고용기간/);
conversions.renderDetail(live,{...run,snapshot:legacySnapshot});
assert.equal(elements.has('currentEmploymentAttendanceSummary'),false,'legacy financial detail must not be merged with live attendance');
assert.equal(JSON.stringify(run),runBefore);assert.equal(JSON.stringify(payments),paymentsBefore);assert.equal(JSON.stringify(row),rowBefore);

const appSource=await readFile(path.join(root,'assets','payroll.js'),'utf8');
assert.match(appSource,/run\?\.snapshot\?\.minutes\?\?row\.minutes/,'ledger export retains original full-month snapshot minutes');
assert.match(appSource,/run\?\.snapshot\?\.workedDays\?\?row\.workedDays/,'ledger export retains original full-month snapshot days');
// Optional pre-change source comparison for local reviews. The normal test has
// no dependency on an untracked baseline directory.
const baselineArg=process.argv.find(value=>value.startsWith('--baseline='));
if(baselineArg){
  const baselineContext={},directory=path.resolve(root,baselineArg.slice('--baseline='.length));
  for(const name of ['core','rules','conversions'])vm.runInNewContext(await readFile(path.join(directory,`payroll-${name}.js`),'utf8'),baselineContext);
  const baselineEngines={core:baselineContext.DGV_PAYROLL_CORE,rules:baselineContext.DGV_PAYROLL_RULES,conversions:baselineContext.DGV_PAYROLL_CONVERSIONS};
  for(const input of checkedInputs){
    const current=plain(calculate(input,undefined,false));delete current.currentEmploymentAttendance;
    const original=plain(calculate(input,baselineEngines,false));
    assert.deepEqual(current,original,'all existing calculation, amount, issue, segment and daily fields must exactly match pre-change source');
  }
  console.log(`Pre-change source comparison passed for ${checkedInputs.length} complete calculation outputs.`);
}
console.log('Payroll current employment period: 87h35/9 previous + 93h59/11 current, per-day rounding, repeated/future/reverse/first-day conversions, other months, no conversion, termination, snapshot/payment preservation and detail history passed.');
