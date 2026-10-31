import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {installMock} from './helpers/payroll-browser-mock.mjs';
import {openPayrollView} from './helpers/payroll-navigation.mjs';

// Exercise the real day editor with synthetic data. No production API calls.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),origin='https://payroll-partial.test';
const browser=await chromium.launch({channel:process.env.PAYROLL_BROWSER_CHANNEL||'chrome',headless:true});
const context=await browser.newContext({viewport:{width:1280,height:900},timezoneId:'Asia/Seoul'});
await context.route('**/*',async route=>{
  const url=route.request().url();
  if(url.startsWith('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@'))return route.fulfill({contentType:'text/javascript',body:`(${installMock.toString()})("admin");`});
  if(!url.startsWith(origin))return route.fulfill({body:''});
  try{
    const file=path.resolve(root,decodeURIComponent(new URL(url).pathname).slice(1));
    if(!file.startsWith(root+path.sep))throw Error('Invalid path');
    return route.fulfill({contentType:file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.js')?'text/javascript; charset=utf-8':'text/css',body:await readFile(file)});
  }catch{return route.fulfill({status:404,body:''});}
});
const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
const employee='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002';
const idle=()=>page.waitForFunction(()=>!document.getElementById('workspace').disabled);
const input=name=>page.locator(`#dayForm [name="${name}"]`);
async function open(day){await openPayrollView(page,'attendance');await page.locator(`[data-day="2026-10-${day}"]`).click();await page.locator('#dayDialog').waitFor({state:'visible'});}
async function save(reason='Synthetic independent correction'){
  await input('reason').fill(reason);await page.locator('#dayForm button[type="submit"]').click();
  await page.locator('#dayDialog').waitFor({state:'hidden'});await idle();
}
async function day(date){return page.evaluate(({employee,date})=>DGV_PAYROLL_APP.state.summaries.find(row=>row.employee_id===employee).daily.find(row=>row.date===date),{employee,date});}
const writes=()=>page.evaluate(()=>__payrollTest.calls.filter(call=>call.table==='payroll_days'&&call.operation==='upsert').length);
async function stored(date){return page.evaluate(({employee,date})=>__payrollTest.db.payroll_days.find(row=>row.employee_id===employee&&row.work_date===date),{employee,date});}
async function rejected(pattern){const count=await writes();await input('reason').fill('Synthetic invalid input');await page.locator('#dayForm button[type="submit"]').click();await idle();assert.equal(await page.locator('#dayDialog').isVisible(),true);assert.match(await page.locator('#dayDialog .dialog-error').innerText(),pattern);assert.equal(await writes(),count);await page.locator('#dayDialog [data-close]').click();}

try{
  await page.goto(origin+'/payroll.html');await page.waitForFunction(()=>window.DGV_PAYROLL_APP?.state.loaded);
  await page.evaluate(employee=>{
    const t=__payrollTest;t.db.payroll_days=[];t.db.payroll_runs=[];
    t.db.payroll_employees.forEach(row=>row.employment_type='part_time');
    t.db.payroll_terms.forEach(row=>Object.assign(row,{rate:40000,break_start:'12:00:00',break_end:'12:00:00'}));
    t.db.payroll_attendance_raw=[['02','10:00:00','in'],['03','20:00:00','out'],['04','10:00:00','in'],['04','20:00:00','out'],['05','23:00:00','in']].map(([day,time,punch_type],index)=>({id:'synthetic-'+index,employee_id:employee,occurred_at:`2026-10-${day}T${time}`,punch_type,device_id:'SYNTHETIC'}));
    t.db.payroll_revision[0].version++;
  },employee);
  await page.locator('#month').fill('2026-10');await page.locator('#month').dispatchEvent('change');await idle();
  await page.locator('#employeeFilter').selectOption(employee);
  const originalRaw=await page.evaluate(()=>JSON.stringify(__payrollTest.db.payroll_attendance_raw));

  await open('01');assert.match(await page.locator('#dayForm').innerText(),/출근만 또는 퇴근만/);
  await input('check_in').fill('2026-10-01T10:00');await save();
  assert.equal((await stored('2026-10-01')).check_in,'2026-10-01T10:00:00');assert.equal((await stored('2026-10-01')).check_out,null);
  assert.equal((await day('2026-10-01')).minutes,0,'unpaired check-in never invents work time');
  await open('01');assert.equal(await input('check_in').inputValue(),'2026-10-01T10:00');assert.equal(await input('check_out').inputValue(),'');
  await input('check_in').fill('2026-10-01T10:30');await save();
  await open('01');assert.equal(await input('check_in').inputValue(),'2026-10-01T10:30');await input('check_out').fill('2026-10-01T18:00');await save();
  assert.equal((await day('2026-10-01')).minutes,450,'adding the other endpoint completes the interval');
  await open('01');await input('check_in').fill('');await save();
  assert.equal((await stored('2026-10-01')).check_in,null);assert.equal((await stored('2026-10-01')).check_out,'2026-10-01T18:00:00');
  assert.equal((await day('2026-10-01')).minutes,0,'unpaired check-out never invents work time');
  await open('01');assert.equal(await input('check_in').inputValue(),'');assert.equal(await input('check_out').inputValue(),'2026-10-01T18:00');await input('check_out').fill('');await save();
  assert.equal((await stored('2026-10-01')).check_out,null);

  await open('02');await input('check_out').fill('2026-10-02T20:00');await save();
  assert.equal((await day('2026-10-02')).minutes,600,'checkout-only correction can pair with the original check-in');
  await open('03');await input('check_in').fill('2026-10-03T10:00');await save();
  assert.equal((await day('2026-10-03')).minutes,600,'checkin-only correction can pair with the original check-out');
  await open('04');await input('check_in').fill('2026-10-04T11:00');await save();assert.equal((await day('2026-10-04')).minutes,540);
  await open('04');await input('check_in').fill('');await save();assert.equal((await day('2026-10-04')).minutes,600,'clearing both corrections restores original punches');
  await open('05');await input('check_out').fill('2026-10-06T02:00');await save();assert.equal((await day('2026-10-05')).minutes,180,'checkout-only correction accepts a valid next-day endpoint');

  for(const [checkIn,checkOut,pattern] of [['2026-10-05T10:00','',/선택한 근무일/],['','2026-10-06T20:00',/다음 날/],['2026-10-04T10:00','2026-10-04T09:00',/출근 이후/],['2026-10-04T10:00','2026-10-05T10:01',/24시간/]]){
    await open('04');await input('check_in').fill(checkIn);await input('check_out').fill(checkOut);await rejected(pattern);
  }
  await open('04');await page.evaluate(other=>{DGV_PAYROLL_APP.state.selected=other;},other);await rejected(/직원과 날짜/);await page.evaluate(employee=>{DGV_PAYROLL_APP.state.selected=employee;},employee);

  const snapshot=await page.evaluate(employee=>{
    const row=DGV_PAYROLL_APP.state.summaries.find(item=>item.employee_id===employee),snapshot=structuredClone(row);
    __payrollTest.db.payroll_runs.push({id:'synthetic-finalized',employee_id:employee,month:'2026-10-01',base_amount:row.baseAmount,allowances:0,deductions:0,total:row.baseAmount,snapshot});__payrollTest.db.payroll_revision[0].version++;return JSON.stringify(snapshot);
  },employee);
  await page.locator('#refresh').click();await idle();await open('04');await input('check_out').fill('2026-10-04T18:00');await save();
  assert.equal((await day('2026-10-04')).minutes,480);
  assert.equal(await page.evaluate(()=>JSON.stringify(__payrollTest.db.payroll_runs[0].snapshot)),snapshot,'attendance edits preserve the finalized payroll snapshot');
  assert.equal(await page.evaluate(()=>JSON.stringify(__payrollTest.db.payroll_attendance_raw)),originalRaw,'every correction preserves source punches');
  assert.deepEqual(errors,[]);
  console.log('Partial attendance UI passed: independent input, reopen/edit, opposite raw endpoint, reset, date/order/24h validation, employee binding, original-record preservation and finalized-snapshot immutability.');
}finally{await context.close();await browser.close();}
