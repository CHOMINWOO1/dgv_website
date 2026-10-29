import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const context={console};context.globalThis=context;
for(const file of ["payroll-core.js","payroll-rules.js"])vm.runInNewContext(await readFile(path.join(root,"assets",file),"utf8"),context);
const core=context.DGV_PAYROLL_CORE,rules=context.DGV_PAYROLL_RULES;
const employee={id:"typed-employee",device_user_id:"typed-test",name:"Synthetic typed employee",active:true};
const term={employee_id:employee.id,effective_from:"2026-01-01",pay_type:"hourly",rate:30000,
  shift_start:"08:00",shift_end:"18:00",break_start:"12:00",break_end:"14:00"};
const punch=(at,type,device="kiosk-test")=>({employee_id:employee.id,occurred_at:at,punch_type:type,device_id:device,source:type?"kiosk":"excel"});
const dayPunch=(time,type)=>punch("2026-06-01T"+time+":00",type);
const pair=(from,to)=>[dayPunch(from,"in"),dayPunch(to,"out")];
const input=(more={})=>({month:"2026-06",today:"2026-07-01",employees:[employee],terms:[term],records:[],days:[],...more});
const calculate=(more={})=>core.summarizeMonth(input(more))[0];
const plain=value=>JSON.parse(JSON.stringify(value));

let records=[...pair("08:00","10:00"),...pair("15:00","18:00")];
let report=calculate({records});
assert.equal(report.minutes,300,"time away from work between typed pairs is excluded");
assert.equal(report.baseAmount,150000);
assert.equal(report.unresolved,0);
assert.equal(report.daily[0].rawCount,4);
assert.equal(report.daily[0].workIntervals.length,2);
assert.equal(report.daily[0].checkIn,"2026-06-01T08:00:00");
assert.equal(report.daily[0].checkOut,"2026-06-01T18:00:00");
assert.equal(rules.extendSummaries({...input({records}),rules:[]})[0].baseAmount,150000,"statutory extension must not reconstruct a first-in/last-out span");
assert.equal(calculate({records:[...pair("08:00","13:00"),...pair("13:30","18:00")]}).minutes,480,"the fixed lunch break is subtracted only where actual intervals overlap it");

// Exact event retries and exact legacy copies are counted once, without mutating sources.
records=pair("08:00","18:00");
const duplicates=[...records,{...records[0]}, {...records[1],device_id:"other-kiosk"},...records.map(row=>({...row,punch_type:null,source:"excel",device_id:"legacy"}))];
const before=JSON.stringify(duplicates);
report=calculate({records:duplicates});
assert.equal(report.minutes,480);
assert.equal(report.daily[0].rawCount,2);
assert.equal(report.unresolved,0);
assert.equal(JSON.stringify(duplicates),before);
report=calculate({records:[...records,punch("2026-06-01T08:00:01",null,"legacy"),punch("2026-06-01T18:00:01",null,"legacy")]});
assert.equal(report.minutes,480,"proven typed pair remains counted; distinct mixed records add no guessed time");
assert.equal(report.daily[0].attendanceStatus,"ambiguous");
assert.equal(report.baseAmount,null);
assert.ok(report.daily[0].issueCodes.includes("mixed"));
report=calculate({records:[...pair("08:00","18:00"),dayPunch("12:00",null)]});
assert.ok(report.daily[0].issueCodes.includes("mixed"));

// Do not turn duplicate directions, reversed direction, or an unmatched event into wages.
for(const invalid of [
  [dayPunch("08:00","in")], [dayPunch("18:00","out")],
  [dayPunch("08:00","in"),dayPunch("09:00","in"),dayPunch("18:00","out")],
  [dayPunch("08:00","out"),dayPunch("18:00","in")],
  pair("08:00","08:00")
]){
  report=calculate({records:invalid});assert.equal(report.minutes,0);assert.equal(report.baseAmount,null);assert.ok(report.unresolved>0);
}
report=calculate({records:[dayPunch("18:00","out")]});
assert.equal(report.daily[0].checkIn,null,"an out-only event is never shown as an arrival");
assert.equal(report.daily[0].checkOut,"2026-06-01T18:00:00");
assert.equal(calculate({records:[dayPunch("08:00","bogus")]}).baseAmount,null);

// Explicit directions can prove an overnight pair even if the usual schedule is daytime.
records=[punch("2026-06-30T19:00:00","in"),punch("2026-07-01T01:00:00","out")];
report=calculate({records});
assert.equal(report.minutes,360);assert.equal(report.daily.length,1);assert.equal(report.daily[0].date,"2026-06-30");
assert.equal(calculate({month:"2026-07",today:"2026-08-01",records}).minutes,0,"next month must not count the same out again");
const nightTerm={...term,shift_start:"19:00",shift_end:"03:00",break_start:"00:30",break_end:"01:00"};
report=calculate({terms:[nightTerm],records:[punch("2026-06-30T19:00:00","in"),punch("2026-06-30T23:00:00","out"),punch("2026-07-01T00:00:00","in"),punch("2026-07-01T03:00:00","out")]});
assert.equal(report.daily.length,1,"after-midnight re-entry belongs to the explicitly scheduled overnight work date");
assert.equal(report.minutes,390,"nightly break and time away are each removed only from actual intervals");
assert.equal(report.unresolved,0);
report=calculate({records:[...records,punch("2026-07-01T00:30:00",null)]});
assert.equal(report.minutes,360);assert.ok(report.daily[0].issueCodes.includes("mixed"));
report=calculate({records:[punch("2026-06-01T08:00:00","in"),punch("2026-06-02T01:00:00","out")]});
assert.equal(report.minutes,900);assert.ok(report.daily[0].warningCodes.includes("long"));
assert.equal(report.unresolved,0);
const corrected={employee_id:employee.id,work_date:"2026-06-01",day_type:"work",check_in:"2026-06-01T08:00:00",check_out:"2026-06-01T18:00:00",reason:"Synthetic attendance review"};
report=calculate({records:[...pair("08:00","18:00"),dayPunch("08:01",null)],days:[corrected]});
assert.equal(report.minutes,480);assert.equal(report.unresolved,0);assert.equal(report.daily[0].status,"confirmed");

// Only real overtime intervals receive premiums; intervening time is never paid.
const rule={...rules.DEFAULTS,id:"rule-test",effective_from:"2026-01-01",ot_enabled:true};
records=[...pair("08:00","10:00"),...pair("19:00","21:00")];
const approved={employee_id:employee.id,work_date:"2026-06-01",day_type:"work",overtime_approved:true,approval_reason:"Synthetic approval",
  overtime_intervals:[{start:"2026-06-01T19:00:00",end:"2026-06-01T21:00:00"}],night_intervals:[]};
report=rules.extendSummaries({...input({records,days:[approved]}),rules:[rule]})[0];
assert.equal(report.minutes,240);assert.equal(report.baseAmount,60000);assert.equal(report.statutoryAmount,90000);assert.equal(report.unresolved,0);
assert.deepEqual(plain(report.daily[0].overtimeCandidates),approved.overtime_intervals);

// Monthly net rules retain the fixed salary, while actual time comes from the pairs.
const monthly={...term,pay_type:"monthly",monthly_settlement:"monthly_net",rate:7000000,weekly_rest_day:0};
report=rules.extendSummaries({...input({terms:[monthly],records:[...pair("08:00","10:00"),...pair("15:00","18:00")]}),rules:[]})[0];
assert.equal(report.baseAmount,7000000);assert.equal(report.monthlyActualMinutes,300);assert.equal(report.monthlyExtraAmount,0);
assert.equal(report.statutoryAmount,0);

// Proven intervals are recognized independently from missing records or wage setup.
for(const [from,to,minutes] of [["08:00","08:02",2],["08:00","08:04",4]]){
  report=calculate({records:pair(from,to)});assert.equal(report.minutes,minutes);assert.equal(report.unresolved,0);
  assert.equal(report.daily[0].attendanceStatus,"recognized");assert.ok(report.daily[0].warningCodes.includes("short"));
}
const secondsPair=[punch("2026-06-01T11:32:34","in"),punch("2026-06-01T11:34:18","out")];
report=calculate({today:"2026-06-01",terms:[],records:[...secondsPair,punch("2026-06-01T14:13:00","in")]});
assert.equal(report.minutes,1);assert.equal(report.actualSeconds,104);assert.equal(report.baseAmount,null);
assert.equal(report.daily[0].attendanceStatus,"in_progress");assert.equal(report.daily[0].openCheckIn,"2026-06-01T14:13:00");
assert.equal(report.daily[0].isOpen,true);assert.equal(report.daily[0].workIntervals.length,1);assert.equal(report.daily[0].attendanceDefaultUsed,true);
assert.ok(report.daily[0].issueCodes.includes("terms"));assert.ok(report.daily[0].issueCodes.includes("open"));
report=calculate({today:"2026-06-01",terms:[],records:[...secondsPair,punch("2026-06-01T14:13:00","in"),punch("2026-06-01T14:16:00","out")]});
assert.equal(report.actualSeconds,284);assert.equal(report.minutes,4);assert.equal(report.daily[0].attendanceStatus,"recognized");assert.equal(report.daily[0].isOpen,false);
assert.equal(report.baseAmount,null,"recognized attendance never invents missing salary conditions");
report=calculate({records:[...secondsPair,punch("2026-06-01T14:13:00","in")]});
assert.equal(report.actualSeconds,104);assert.equal(report.daily[0].attendanceStatus,"missing");assert.ok(report.unresolved>0);
assert.equal(report.daily[0].openCheckIn,null);
report=calculate({today:"2026-06-01",records:[punch("2026-06-01T14:13:00","in")]});
assert.equal(report.actualSeconds,0);assert.equal(report.minutes,0);assert.equal(report.daily[0].attendanceStatus,"in_progress");
report=calculate({records:[...pair("08:00","10:00"),dayPunch("15:00","in"),dayPunch("16:00","in"),dayPunch("18:00","out")]});
assert.equal(report.minutes,120);assert.equal(report.daily[0].attendanceStatus,"ambiguous");assert.equal(report.daily[0].workIntervals.length,1);
report=calculate({records:[...pair("08:00","18:00"),dayPunch("19:00","out")]});
assert.equal(report.minutes,480);assert.equal(report.daily[0].attendanceStatus,"missing");assert.ok(report.unresolved>0);
report=calculate({records:[punch("2026-06-01T08:00:00","in"),punch("2026-06-01T08:00:59","out")]});
assert.equal(report.minutes,0);assert.equal(report.actualSeconds,59);assert.equal(report.workedDays,1);assert.equal(report.daily[0].attendanceStatus,"recognized");assert.equal(report.unresolved,0);
report=calculate({terms:[],records:pair("10:00","20:00")});
assert.equal(report.minutes,480);assert.equal(report.baseAmount,null);assert.equal(report.daily[0].attendanceDefaultUsed,true);assert.equal(report.daily[0].attendanceStatus,"recognized");
report=calculate({terms:[{...term,rate:null,break_start:"12:00",break_end:"13:00"}],records:pair("08:00","18:00")});
assert.equal(report.minutes,540,"valid configured break survives missing pay rate");assert.equal(report.daily[0].attendanceDefaultUsed,false);assert.equal(report.baseAmount,null);
report=calculate({terms:[{...term,shift_start:"bad"}],records:pair("10:00","20:00")});
assert.equal(report.minutes,480);assert.equal(report.daily[0].attendanceDefaultUsed,true);assert.equal(report.baseAmount,null);
report=calculate({records:[punch("2026-06-01T11:59:30","in"),punch("2026-06-01T14:00:30","out")]});
assert.equal(report.actualSeconds,60);assert.equal(report.minutes,1,"only actual lunch intersection is deducted");
report=calculate({records:[punch("2026-06-01T22:00:00","in"),punch("2026-06-02T22:00:00","out")]});
assert.equal(report.minutes,1320,"24h pair deducts next calendar day's 2h lunch");assert.equal(report.unresolved,0);assert.ok(report.daily[0].warningCodes.includes("long"));
report=calculate({terms:[nightTerm],records:[punch("2026-06-01T19:00:00","in"),punch("2026-06-02T19:00:00","out")]});
assert.equal(report.minutes,1410,"overnight 00:30–01:00 break is deducted once across date boundaries");
report=calculate({records:[...pair("08:00","10:00"),dayPunch("11:00","in"),punch("2026-06-02T11:00:01","out")]});
assert.equal(report.minutes,120);assert.equal(report.daily[0].attendanceStatus,"ambiguous");assert.ok(report.daily[0].issueCodes.includes("duration"));
report=calculate({today:"2026-06-01",records:[...pair("08:00","10:00"),dayPunch("15:00","in"),punch("2026-06-02T15:00:00","out")]});
assert.equal(report.minutes,120,"future checkout only excludes its own interval");assert.ok(report.daily[0].issueCodes.includes("future"));
const restRecorded={employee_id:employee.id,work_date:"2026-06-01",day_type:"rest"};
report=calculate({days:[restRecorded],records:pair("08:00","08:02")});
assert.equal(report.minutes,2);assert.equal(report.unresolved,0);assert.equal(report.daily[0].attendanceStatus,"recognized");assert.ok(report.daily[0].warningCodes.includes("rest"));
const noRecord={employee_id:employee.id,work_date:"2026-06-01",day_type:"work"};
report=calculate({days:[noRecord]});assert.equal(report.minutes,0);assert.equal(report.unresolved,0);assert.equal(report.daily[0].attendanceStatus,"no_record");
report=rules.extendSummaries({...input({terms:[monthly],records:[...secondsPair,punch("2026-06-01T14:13:00","in")],today:"2026-06-01"}),rules:[]})[0];
assert.equal(report.monthlyActualSeconds,104);assert.equal(report.monthlyActualMinutes,1);assert.equal(report.baseAmount,7000000);assert.equal(report.monthlyReadyToFinalize,false);
assert.equal(report.daily.find(day=>day.date==="2026-06-01").attendanceStatus,"in_progress");
report=rules.extendSummaries({...input({terms:[],records:pair("10:00","20:00")}),rules:[]})[0];
assert.equal(report.minutes,480);assert.equal(report.baseAmount,null,"rules keep attendance but cannot invent wages");

console.log("Typed attendance passed: multiple pairs, exact-source dedupe, mixed-source review, invalid sequences, overnight boundaries and statutory/monthly pay.");
