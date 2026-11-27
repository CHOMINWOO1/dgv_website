import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {installMock} from './helpers/payroll-browser-mock.mjs';

// Every request is fulfilled from this checkout or synthetic data. No real
// payroll, Supabase project, session, employee or payment is accessed.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const origin='http://payroll-conversion-summary.test';
const browser=await chromium.launch({headless:true,channel:process.env.PAYROLL_BROWSER_CHANNEL||'chrome'});
const context=await browser.newContext({viewport:{width:1440,height:1000}});
const unexpectedRequests=[];
function seed(){
  const test=window.__payrollTest,[converted,normal]=test.db.payroll_employees;
  Object.assign(converted,{name:'Synthetic converted employee',employment_type:'full_time',employment_status:'active',payee_type:'employee',hire_date:'2026-11-03'});
  Object.assign(normal,{name:'Synthetic whole-month employee',employment_type:'full_time',employment_status:'active',payee_type:'employee',hire_date:'2026-01-01'});
  const shared={shift_start:'10:00:00',shift_end:'20:00:00',weekly_rest_day:0};
  test.db.payroll_terms=[
    {id:'synthetic-hourly',employee_id:converted.id,effective_from:'2026-11-01',pay_type:'hourly',monthly_settlement:'statutory',rate:25000,break_start:'00:00:00',break_end:'00:00:00',...shared},
    {id:'synthetic-converted-monthly',employee_id:converted.id,effective_from:'2026-11-13',pay_type:'monthly',monthly_settlement:'monthly_net',rate:7000000,break_start:'12:00:00',break_end:'14:00:00',...shared},
    {id:'synthetic-normal-monthly',employee_id:normal.id,effective_from:'2026-01-01',pay_type:'monthly',monthly_settlement:'monthly_net',rate:7500000,break_start:'12:00:00',break_end:'14:00:00',...shared}
  ];
  test.db.payroll_employment_conversions=[{id:'synthetic-conversion',employee_id:converted.id,original_hire_date:'2026-11-03',effective_from:'2026-11-13',prior_employment_type:'part_time',employment_type:'full_time',prior_salary_amount:1700000}];
  test.db.payroll_attendance_raw=[converted,normal].flatMap((employee,index)=>['10:00:00','20:00:00'].map((time,i)=>({id:`synthetic-punch-${index}-${i}`,employee_id:employee.id,occurred_at:'2026-11-13T'+time,punch_type:i?'out':'in'})));
  test.db.payroll_payments=[{id:'synthetic-preserved-probation-payment',employee_id:converted.id,payroll_month:'2026-11-01',run_id:null,amount:1700000,paid_on:'2026-11-13',method:'cash'}];
}
await context.route('**/*',async route=>{
  const url=route.request().url();
  if(url.startsWith('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@'))return route.fulfill({contentType:'text/javascript',body:`(${installMock.toString()})('admin');(${seed.toString()})();`});
  if(url.startsWith(origin+'/')){
    const file=path.resolve(root,decodeURIComponent(new URL(url).pathname).replace(/^\/+/,''));
    if(file.startsWith(root+path.sep)){
      try{return route.fulfill({contentType:({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'})[path.extname(file)]||'application/octet-stream',body:await readFile(file)});}catch{}
    }
    return route.fulfill({status:404,body:''});
  }
  unexpectedRequests.push({url,method:route.request().method()});
  return route.fulfill({status:403,body:''});
});
const page=await context.newPage(),errors=[];
page.on('pageerror',error=>errors.push(error.message));
page.setDefaultTimeout(5000);
const idle=()=>page.waitForFunction(()=>window.DGV_PAYROLL_APP?.state.loaded&&!DGV_PAYROLL_APP.state.busy);
const field=(name,index=0)=>page.getByTestId(`conversion-period-${name}`).nth(index);
const text=(name,index=0)=>field(name,index).innerText();
const numeric=async(name,index=0)=>Number((await text(name,index)).replace(/[^\d-]/g,''));
async function render(row,run=null){
  const result=await page.evaluate(({row,run})=>{
    const app=DGV_PAYROLL_APP;
    app.state.summaries=[structuredClone(row)];app.state.selected=row.employee_id;
    app.state.runs=run?[structuredClone(run)]:[];
    const before=JSON.stringify({row:app.state.summaries[0],run:app.state.runs[0]});
    app.renderDetail();
    return {before,after:JSON.stringify({row:app.state.summaries[0],run:app.state.runs[0]})};
  },{row,run});
  assert.equal(result.after,result.before,'rendering must not change monetary, attendance or snapshot inputs');
}
try{
  await page.goto(origin+'/payroll.html#ledger');await idle();
  await page.locator('#month').fill('2026-11');await page.locator('#month').dispatchEvent('change');await idle();
  const fixtures=await page.evaluate(()=>{
    const app=DGV_PAYROLL_APP,[converted,normal]=__payrollTest.db.payroll_employees;
    return {converted:structuredClone(app.state.summaries.find(row=>row.employee_id===converted.id)),normal:structuredClone(app.state.summaries.find(row=>row.employee_id===normal.id)),db:JSON.stringify(__payrollTest.db)};
  });
  assert.equal(fixtures.converted.settlementMode,'employment_segments');
  assert.equal(fixtures.normal.settlementMode,'monthly_net');
  assert.equal(fixtures.converted.conversionSegments.find(segment=>segment.kind==='monthly').plannedMinutes,7200,'real November conversion pipeline has a 120-hour full-time period');
  assert.equal(fixtures.converted.conversionSegments.find(segment=>segment.kind==='monthly').fullMonthPlannedMinutes,12000,'the hourly rate denominator remains the 200-hour whole month');
  const monthly={from:'2026-11-13',to:'2026-11-30',type:'full_time',kind:'monthly',rate:7000000,baseAmount:4200000,extraAmount:0,minutes:5639,plannedMinutes:7200,fullMonthPlannedMinutes:12000};
  const agreed={from:'2026-11-03',to:'2026-11-12',type:'part_time',kind:'agreed',baseAmount:1700000,extraAmount:0,minutes:5255};
  const forward={...fixtures.converted,baseAmount:5900000,monthlyExtraAmount:0,monthlyPlannedMinutes:7200,monthlyActualMinutes:5639,conversionSegments:[agreed,monthly],daily:[],currentEmploymentAttendance:{from:'2026-11-13',to:'2026-11-30',type:'full_time',minutes:5639,workedDays:11,previous:[{from:'2026-11-03',to:'2026-11-12',type:'part_time',minutes:5255,workedDays:9}]}};
  await render(forward);
  assert.equal(await page.locator('#conversionMonthlyTimeSummary').count(),1);
  assert.equal(await page.getByTestId('conversion-period-plan').count(),1,'probation agreement is not an invented monthly comparison');
  assert.equal(await text('plan'),'120h 0m');assert.equal(await text('actual'),'93h 59m');
  assert.match(await text('balance'),/[−-]26h 1m/);assert.equal(await text('extra'),'0h 0m');
  assert.equal(await numeric('hourly-rate'),35000);assert.equal(await numeric('extra-amount'),0);
  assert.match(await page.locator('#conversionMonthlyTimeSummary').innerText(),/2026-11-13.*2026-11-30/s);
  assert.match(await page.locator('#employmentConversionSummary').innerText(),/1\.700\.000.*4\.200\.000/s,'prior settlement and current base salary remain visible');
  assert.match(await page.locator('#currentEmploymentAttendanceSummary').innerText(),/93h 59m.*11일/s);
  assert.match(await page.locator('#previousEmploymentAttendance').textContent(),/87h 35m.*9일/s,'earlier work history remains available in the attendance view');
  await render(forward);await render(forward);
  assert.equal(await page.locator('#conversionMonthlyTimeSummary').count(),1,'repeated rendering does not duplicate summary containers');
  assert.equal(await page.getByTestId('conversion-period-plan').count(),1);
  assert.match(await page.getByTestId('conversion-pay-date').innerText(),/2026-12-05/);

  const roundedDaily=Array.from({length:11},(_,index)=>({date:`2026-11-${String(index+13).padStart(2,'0')}`,minutes:index===10?519:512}));
  await render({...forward,daily:roundedDaily,conversionSegments:[agreed,{...monthly,minutes:5644}]});
  assert.equal(await text('actual'),'94h 4m','card keeps the original second-precision settlement result');
  assert.match(await text('balance'),/[−-]25h 56m/);assert.equal(await text('extra'),'0h 0m');assert.equal(await numeric('extra-amount'),0);
  const roundingText=await page.locator('#conversionMonthlyTimeSummary').innerText();
  assert.match(roundingText,/일별 근무표 합계[^\n]*93h 59m/);
  assert.match(roundingText,/초 단위 근무를 합산/,'rounding difference is explained without changing any financial result');
  assert.match(await page.locator('#currentEmploymentAttendanceSummary').innerText(),/93h 59m/,'current attendance stays consistent with per-day displayed minutes');
  await render({...forward,daily:[{date:'2026-11-13',minutes:7199}],conversionSegments:[{...monthly,minutes:7204,extraAmount:2333}]});
  assert.equal(await text('extra'),'0h 4m');assert.equal(await numeric('extra-amount'),2333,'extra minutes and amount continue using the same saved settlement basis');
  assert.match(await page.locator('#conversionMonthlyTimeSummary').innerText(),/119h 59m.*초 단위/s);

  const priorMonthly={...monthly,from:'2026-11-01',to:'2026-11-12',baseAmount:2800000,minutes:5100,plannedMinutes:4800,extraAmount:175000};
  const reverse={...forward,conversionSegments:[priorMonthly,{from:'2026-11-13',to:'2026-11-30',type:'part_time',kind:'hourly',rate:30000,baseAmount:300000,extraAmount:0,minutes:600}],currentEmploymentAttendance:{from:'2026-11-13',to:'2026-11-30',type:'part_time',minutes:600,workedDays:2,previous:[{from:'2026-11-01',to:'2026-11-12',type:'full_time',minutes:5100,workedDays:10}]}};
  await render(reverse);
  assert.equal(await text('plan'),'80h 0m');assert.equal(await text('actual'),'85h 0m');assert.match(await text('balance'),/\+?5h 0m/);
  assert.equal(await text('extra'),'5h 0m');assert.equal(await numeric('extra-amount'),175000);
  const reverseText=await page.locator('#conversionMonthlyTimeSummary').innerText();
  assert.match(reverseText,/2026-11-01.*2026-11-12/s);assert.doesNotMatch(reverseText,/현재 고용기간|11\/13 이후 정규직/,'the old monthly period is not labelled as the current part-time period');
  assert.match(await page.locator('#currentEmploymentAttendanceSummary').innerText(),/11\/13 이후 파트타임/);

  const secondMonthly={...monthly,rate:9000000,baseAmount:5400000,minutes:7500,extraAmount:225000};
  const multiple={...forward,baseAmount:8200000,monthlyExtraAmount:400000,conversionSegments:[priorMonthly,secondMonthly]};
  await render(multiple);
  assert.equal(await page.getByTestId('conversion-period-plan').count(),2,'each term/rate gets a separate comparison');
  assert.deepEqual(await page.getByTestId('conversion-period-plan').allTextContents(),['80h 0m','120h 0m']);
  assert.deepEqual(await page.getByTestId('conversion-period-actual').allTextContents(),['85h 0m','125h 0m']);
  assert.equal(await numeric('hourly-rate',0),35000);assert.equal(await numeric('hourly-rate',1),45000);
  assert.equal(await numeric('extra-amount',0),175000);assert.equal(await numeric('extra-amount',1),225000);

  const snapshot={...forward,conversionSegments:[agreed,{...monthly,minutes:6000}],monthlyActualMinutes:6000,currentEmploymentAttendance:{...forward.currentEmploymentAttendance,minutes:6000}};
  const run={id:'synthetic-finalized-run',employee_id:forward.employee_id,month:'2026-11-01',base_amount:5900000,allowances:100000,deductions:0,total:6000000,snapshot};
  const changedLive={...multiple,currentEmploymentAttendance:{...forward.currentEmploymentAttendance,minutes:9999},conversionSegments:[{...monthly,minutes:9999,rate:14000000}]};
  await render(changedLive,run);
  assert.equal(await page.getByTestId('conversion-period-plan').count(),1);assert.equal(await text('actual'),'100h 0m');assert.equal(await numeric('hourly-rate'),35000,'snapshot rates never borrow newer live terms');
  assert.doesNotMatch(await page.locator('#conversionMonthlyTimeSummary').innerText(),/166h 39m|70[.,]000/);
  assert.match(await page.locator('#currentEmploymentAttendanceSummary').innerText(),/확정 당시 고용기간.*100h 0m/s);
  const legacySnapshot={...fixtures.normal,employee_id:forward.employee_id};
  await render(changedLive,{...run,snapshot:legacySnapshot});
  assert.equal(await page.locator('#conversionMonthlyTimeSummary').count(),0,'legacy snapshot with no conversion data must not borrow live segments');
  assert.equal(await page.locator('#currentEmploymentAttendanceSummary').count(),0);
  assert.equal(await page.locator('#monthlyTimeSummary').count(),1,'ordinary monthly snapshot retains its existing cards');

  await render({...forward,conversionSegments:[{...priorMonthly,kind:'agreed',plannedMinutes:undefined,fullMonthPlannedMinutes:undefined,rate:undefined}]});
  assert.equal(await page.getByTestId('conversion-period-plan').count(),0,'agreed full-time lump sum has no fabricated time/rate values');
  assert.match(await page.locator('#conversionMonthlyTimeSummary').innerText(),/확정|합의/);
  assert.match(await page.locator('#conversionMonthlyTimeSummary').innerText(),/일괄|시간.*비교|비교.*없/);
  for(const invalid of [{plannedMinutes:null},{fullMonthPlannedMinutes:0},{rate:null}]){
    await render({...forward,conversionSegments:[{...monthly,...invalid}]});
    assert.equal(await page.getByTestId('conversion-period-plan').count(),0,'incomplete monthly basis must not produce misleading cards');
  }

  await render(fixtures.normal);
  assert.equal(await page.locator('#conversionMonthlyTimeSummary').count(),0);
  assert.equal(await page.locator('#monthlyTimeSummary').count(),1);
  assert.equal(await page.getByTestId('month-plan').innerText(),'200h 0m');
  assert.equal(Number((await page.getByTestId('month-hourly-rate').innerText()).replace(/[^\d]/g,'')),37500);
  assert.match(await page.getByTestId('month-pay-date').innerText(),/2026-12-05/);

  if(process.env.PAYROLL_CONVERSION_SCREENSHOT){
    await render({...forward,daily:roundedDaily,conversionSegments:[agreed,{...monthly,minutes:5644}]});
    await page.locator('#detailSummary').screenshot({path:process.env.PAYROLL_CONVERSION_SCREENSHOT});
  }

  await page.setViewportSize({width:390,height:844});await render(multiple);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'mobile page has no horizontal overflow');
  assert.equal(await page.locator('#conversionMonthlyTimeSummary').evaluate(element=>element.getBoundingClientRect().right<=innerWidth+1),true,'conversion summaries fit inside mobile viewport');
  assert.equal(await page.evaluate(()=>JSON.stringify(__payrollTest.db)),fixtures.db,'rendering preserves all original terms, payments, raw punches and finalized records');
  assert.deepEqual(await page.evaluate(()=>__payrollTest.calls.filter(call=>call.operation&&call.operation!=='select')),[],'no table writes occur');
  assert.deepEqual(await page.evaluate(()=>__payrollTest.rpcs),[],'read-only summaries trigger no RPC or payment action');
  assert.deepEqual(unexpectedRequests,[]);assert.deepEqual(errors,[]);
  console.log('Payroll conversion monthly summary passed: forward/reverse periods, full-month rate denominator, extra pay, multiple rates, finalized/legacy snapshot isolation, agreed/invalid basis, ordinary monthly cards, history, repeated rendering, mobile layout and zero data/network writes.');
}finally{await context.close();await browser.close();}
