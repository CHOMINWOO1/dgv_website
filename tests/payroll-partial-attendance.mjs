import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const context={console};context.globalThis=context;
for(const name of ['payroll-core.js','payroll-rules.js'])vm.runInNewContext(await readFile(new URL('../assets/'+name,import.meta.url),'utf8'),context);
const core=context.DGV_PAYROLL_CORE,rules=context.DGV_PAYROLL_RULES;
const employee={id:'partial-employee',name:'Synthetic partial employee',employment_type:'full_time'};
const term={employee_id:employee.id,effective_from:'2026-01-01',pay_type:'hourly',rate:30000,shift_start:'10:00',shift_end:'20:00',break_start:'12:00',break_end:'14:00'};
const at=(time,date='2026-06-01')=>date+'T'+time+':00';
const punch=(time,type,date='2026-06-01')=>({employee_id:employee.id,occurred_at:at(time,date),punch_type:type,device_id:'synthetic'});
const pair=(from,to,date='2026-06-01')=>[punch(from,'in',date),punch(to,'out',date)];
const edit=(from,to,date='2026-06-01')=>({employee_id:employee.id,work_date:date,day_type:'work',check_in:from?at(from,date):null,check_out:to?at(to,date):null,reason:'Synthetic endpoint correction'});
const input=more=>({month:'2026-06',today:'2026-07-01',employees:[employee],terms:[term],records:[],days:[],...more});
const calculate=more=>core.summarizeMonth(input(more))[0];
const plain=value=>JSON.parse(JSON.stringify(value));
let report=calculate({today:'2026-06-01',days:[edit('10:00',null)]});
assert.equal(report.minutes,0);assert.equal(report.daily[0].attendanceStatus,'in_progress');assert.equal(report.daily[0].checkIn,at('10:00'));assert.equal(report.daily[0].checkOut,null);assert.equal(report.daily[0].rawCount,0);
report=calculate({days:[edit('10:00',null)]});assert.equal(report.daily[0].attendanceStatus,'missing');assert.equal(report.minutes,0);
report=calculate({days:[edit(null,'20:00')]});assert.equal(report.daily[0].checkIn,null);assert.equal(report.daily[0].checkOut,at('20:00'));assert.equal(report.daily[0].attendanceStatus,'missing');assert.equal(report.minutes,0);
for(const [records,day] of [[[punch('20:00','out')],edit('10:00',null)],[[punch('10:00','in')],edit(null,'20:00')]]){
  const before=JSON.stringify({records,day});report=calculate({records,days:[day]});
  assert.equal(report.minutes,480);assert.equal(report.baseAmount,240000);assert.equal(report.unresolved,0);assert.equal(report.daily[0].rawCount,1);
  assert.equal(JSON.stringify({records,day}),before,'calculation never rewrites original events or saved edits');
}
for(const day of [edit('09:00',null),edit(null,'21:00')]){
  report=calculate({records:pair('10:00','20:00'),days:[day]});assert.equal(report.minutes,540);assert.equal(report.daily[0].rawCount,2);assert.equal(report.unresolved,0);
}
const split=[...pair('10:00','11:00'),...pair('15:00','20:00')];
for(const [day,expected] of [[edit('09:00',null),[{start:at('09:00'),end:at('11:00')},{start:at('15:00'),end:at('20:00')}]], [edit(null,'21:00'),[{start:at('10:00'),end:at('11:00')},{start:at('15:00'),end:at('21:00')}] ]]){
  report=calculate({records:split,days:[day]});assert.equal(report.minutes,420);assert.deepEqual(plain(report.daily[0].workIntervals),expected);assert.equal(report.unresolved,0);
  const enhanced=rules.extendSummaries({...input({records:split,days:[day]}),rules:[]})[0];assert.equal(enhanced.minutes,420,'pay rules do not recreate a first-to-last span through time away');
}
report=calculate({records:[...pair('10:00','11:00'),punch('15:00','in')],days:[edit(null,'20:00')]});
assert.equal(report.minutes,360);assert.equal(report.daily[0].workIntervals.length,2);assert.equal(report.daily[0].rawCount,3);
report=calculate({records:[punch('11:00','out'),...pair('15:00','20:00')],days:[edit('10:00',null)]});
assert.equal(report.minutes,360);assert.equal(report.daily[0].workIntervals.length,2);assert.equal(report.unresolved,0,'missing first arrival is supplied without replacing afternoon arrival');
for(const day of [edit('11:00',null),edit('11:01',null),edit(null,'15:00'),edit(null,'14:59'),{...edit('10:00',null),reason:''},{...edit('10:00',null),check_in:'not-a-date'},{...edit(null,'20:00'),check_out:'infinity'},{...edit('10:00',null),check_in:at('10:00','2026-06-02')},{...edit(null,'20:00'),check_out:at('20:00','2026-06-03')}]){
  report=calculate({records:split,days:[day]});assert.equal(report.minutes,0,'invalid edit cannot authorize raw pay');assert.ok(report.daily[0].issueCodes.includes('correction'));
}
report=calculate({records:split,days:[edit(null,null)]});assert.equal(report.minutes,360);assert.equal(report.daily[0].workIntervals.length,2,'both empty restores all original intervals');
report=calculate({records:split,days:[edit('10:00','20:00')]});assert.equal(report.minutes,480,'two explicit bounds retain whole-day correction semantics');

// Exact Excel copies of a corrected typed endpoint do not become new mixed records.
const typed=pair('10:00','20:00'),copies=[...typed,...typed.map(row=>({...row,punch_type:null,device_id:'excel'}))];
report=calculate({records:copies,days:[edit('09:00',null)]});assert.equal(report.minutes,540);assert.equal(report.unresolved,0);assert.equal(report.daily[0].rawCount,2);
for(const day of [edit('09:00',null),edit(null,'21:00')]){
  report=calculate({records:typed.map(row=>({...row,punch_type:null})),days:[day]});assert.equal(report.minutes,540);assert.equal(report.unresolved,0,'two legacy bounds keep their established direction');
}
report=calculate({records:[punch('20:00',null)],days:[edit('10:00',null)]});assert.equal(report.minutes,0);assert.ok(report.unresolved>0,'a single untyped record has no proven opposite direction');
report=calculate({records:[punch('10:00',null)],days:[edit('10:00',null)],today:'2026-06-01'});assert.equal(report.minutes,0);assert.equal(report.daily[0].rawCount,1);assert.equal(report.daily[0].attendanceStatus,'in_progress');
report=calculate({records:[punch('20:00',null),{...punch('20:00',null),device_id:'another'}],days:[edit('10:00',null)]});assert.equal(report.minutes,0,'duplicate undirected timestamps do not prove a checkout');

// Partial edits preserve cross-midnight work dates and do not close yesterday's open day.
report=calculate({records:[punch('19:00','in'),punch('01:00','out','2026-06-02')],days:[edit('20:00',null)]});
assert.equal(report.minutes,300);assert.equal(report.daily.length,1);assert.equal(report.daily[0].date,'2026-06-01');
report=calculate({records:[punch('19:00','in')],days:[{...edit(null,'20:00'),check_out:at('01:00','2026-06-02')}]});
assert.equal(report.minutes,360);assert.equal(report.daily[0].checkOut,at('01:00','2026-06-02'));
report=calculate({records:[punch('08:00','in'),punch('20:00','out','2026-06-02')],days:[edit('10:00',null,'2026-06-02')]});
assert.equal(report.daily[0].minutes,0);assert.equal(report.daily[0].attendanceStatus,'missing');assert.equal(report.daily[1].minutes,480);assert.equal(report.daily[1].attendanceStatus,'recognized');
report=calculate({records:[punch('08:00','in')],days:[edit(null,'20:00','2026-06-02')]});
assert.equal(report.minutes,0);assert.equal(report.daily[0].checkOut,null);assert.equal(report.daily[1].checkIn,null,'out-only edit cannot claim a prior work date');
const previousOvernight=[punch('22:00','in'),punch('02:00','out','2026-06-02')];
for(const currentCheckout of [true,false]){
  report=calculate({records:[...previousOvernight,...(currentCheckout?[punch('20:00','out','2026-06-02')]:[])],days:[edit('10:00',null,'2026-06-02')]});
  assert.equal(report.daily[0].minutes,240,'a previous overnight checkout stays with its original arrival');
  assert.equal(report.daily[1].checkIn,at('10:00','2026-06-02'));
  assert.equal(report.daily[1].minutes,currentCheckout?480:0);
  assert.equal(report.daily[1].attendanceStatus,currentCheckout?'recognized':'missing');
  assert.equal(report.daily[1].issueCodes.includes('correction'),false,'an earlier checkout owned by yesterday cannot invalidate today’s new arrival');
}
report=calculate({records:[...previousOvernight,punch('09:00','out','2026-06-02')],days:[edit('10:00',null,'2026-06-02')]});
assert.equal(report.daily[0].minutes,240);assert.equal(report.daily[1].minutes,0);
assert.ok(report.daily[1].issueCodes.includes('correction'),'an orphan checkout belonging to today still rejects a later arrival');
for(const outTime of ['08:00','20:00'])for(const reverse of [false,true]){
  const corrections=[edit(null,'20:00'),edit('06:00',null,'2026-06-02')];if(reverse)corrections.reverse();
  report=calculate({records:[punch('10:00','in'),punch(outTime,'out','2026-06-02')],days:corrections});
  assert.equal(report.daily[0].minutes,480);assert.equal(report.daily[1].minutes,outTime==='08:00'?120:720);
  assert.equal(report.daily[1].checkOut,at(outTime,'2026-06-02'),'repairing yesterday and today preserves today’s original checkout regardless of edit row order');
  assert.equal(report.unresolved,0);
}
for(const [clock,expected] of [['10:00',1320],['10:01',0]]){
  report=calculate({records:[punch('10:00','in')],days:[{...edit(null,'20:00'),check_out:at(clock,'2026-06-02')}]});assert.equal(report.minutes,expected,'raw counterpart plus edit must remain within24h');
}
report=calculate({today:'2026-06-01',records:[punch('19:00','in')],days:[{...edit(null,'20:00'),check_out:at('01:00','2026-06-02')}]});assert.equal(report.minutes,0);assert.ok(report.daily[0].issueCodes.includes('future'));
report=calculate({records:[punch('22:00','in')],days:[{...edit(null,'20:00'),check_out:at('03:00','2026-06-02')},edit('02:00','04:00','2026-06-02')]});assert.equal(report.minutes,0);assert.ok(report.daily.every(day=>day.issueCodes.includes('overlap')),'partial and complete corrections cannot both authorize overlapping time');
report=calculate({employees:[{...employee,employment_type:'part_time'}],records:[punch('10:00','in')],days:[edit(null,'20:00')]});assert.equal(report.minutes,600,'part-time partial completion has no lunch deduction');
console.log('Partial attendance passed: independent entry/edit/reset, typed and legacy boundaries, split shifts, no invented pay, overnight and day rollover, validation, original records, breaks and payroll rules.');
