import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {installMock} from './helpers/payroll-browser-mock.mjs';
import {openPayrollView} from './helpers/payroll-navigation.mjs';

// The actual period-query and print-popup flow, using synthetic employees,
// private identities and PNG signatures. No production reads or writes.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const folder=path.join(root,'test-results','payroll-receipts-print');
// Fulfill local application bytes through Playwright so this isolated test also
// runs in environments that prohibit loopback network connections.
const origin='https://payroll-print.test';
const browser=await chromium.launch({channel:process.env.PAYROLL_BROWSER_CHANNEL||'chrome',headless:true});
const context=await browser.newContext({viewport:{width:1280,height:900},timezoneId:'Asia/Seoul'});
await context.addInitScript(()=>{window.print=()=>{window.__printedImages=[...document.images].map(image=>image.complete&&image.naturalWidth>0);window.__printed=true;};});
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
const idle=()=>page.waitForFunction(()=>!document.getElementById('workspace').disabled);

async function seed(size=6){
  await page.evaluate(count=>{
    const t=__payrollTest;
    for(const key of ['payroll_employees','payroll_terms','payroll_attendance_raw','payroll_days','payroll_runs','payroll_payments','payroll_attachments','payroll_payment_reversals','payroll_run_adjustments'])t.db[key]=[];
    t.storageObjects={};t.sensitive={};
    const people=count===6?5:12;
    const names=['합성 직원 A · Nguyễn An','합성 직원 B · Trần Bình','합성 직원 C · Lê Chi','합성 직원 D · Đặng Dũng','합성 직원 E · Phạm Hà'];
    for(let i=0;i<people;i++){
      const id=`synthetic-employee-${i}`;
      const employment_type=i%5<2?'part_time':i%5<4?'full_time':null;
      t.db.payroll_employees.push({id,name:names[i]||`합성 직원 ${i} · Nguyễn Thị`,device_user_id:`DEMO-${String(i+1).padStart(3,'0')}`,active:true,payee_type:'employee',employment_type,phone:`090-000-${String(i+1).padStart(4,'0')}`});
      t.sensitive[id]={national_id:`000-DEMO-ID-${String(i+1).padStart(3,'0')}`,bank_account:'PRIVATE-BANK-NEVER-PRINT'};
      if(employment_type)t.db.payroll_terms.push({id:`terms-${i}`,employee_id:id,effective_from:'2026-09-01',pay_type:employment_type==='part_time'?'hourly':'monthly',rate:employment_type==='part_time'?40000:7000000,monthly_settlement:employment_type==='part_time'?'statutory':'monthly_net',weekly_rest_day:0,shift_start:'10:00:00',shift_end:'20:00:00',break_start:'12:00:00',break_end:'14:00:00'});
      for(const [date,start,end] of [['2026-09-28','10:00:00','12:00:00'],['2026-09-29','14:00:00','17:30:00'],['2026-10-01','09:00:00','11:30:00'],['2026-10-25','14:00:00','18:00:00']]){
        for(const [time,punch_type] of [[start,'in'],[end,'out']])t.db.payroll_attendance_raw.push({id:`punch-${i}-${date}-${punch_type}`,employee_id:id,occurred_at:`${date}T${time}`,punch_type,source:'kiosk',device_id:'SYNTHETIC-TABLET'});
      }
    }
    const amounts=[240000,220000,280000,200000,160000,250000],dates=['03','05','08','11','15','18'],person=[0,1,2,0,3,4];
    for(let i=0;i<count;i++){
      const employee=t.db.payroll_employees[count===6?person[i]:i%people],id=`synthetic-pay-${String(i).padStart(3,'0')}`;
      const paid_on=`2026-10-${count===6?dates[i]:String(i%28+1).padStart(2,'0')}`;
      t.db.payroll_payments.push({id,run_id:null,employee_id:employee.id,payroll_month:i===0||(count===6&&i===3)?'2026-09-01':'2026-10-01',paid_on,amount:count===6?amounts[i]:100000+i*1000,method:count===6?(i===5?'bank':'cash'):(i%3?'cash':'bank'),note:'Synthetic payout only'});
      const canvas=document.createElement('canvas');canvas.width=240;canvas.height=80;
      const c=canvas.getContext('2d');c.fillStyle='white';c.fillRect(0,0,240,80);c.strokeStyle='#19364f';c.lineWidth=2.5;c.beginPath();c.moveTo(12,58);c.lineTo(48+i%8,17);c.lineTo(83,61);c.lineTo(132+i%12,22);c.lineTo(204,54);c.stroke();
      const dataUrl=canvas.toDataURL('image/png'),bytes=Array.from(atob(dataUrl.split(',')[1]),char=>char.charCodeAt(0)),storage_path=`${id}/signature.png`;
      t.storageObjects[storage_path]={bytes,mime:'image/png'};
      t.db.payroll_attachments.push({id:`signature-${i}`,payment_id:id,storage_path,mime_type:'image/png',byte_size:bytes.length,evidence_type:'signature',signed_name:`합성 서명 ${i+1}`,acknowledged_at:`${paid_on}T01:02:03Z`});
    }
    t.db.payroll_runs.push({id:'synthetic-finalized-c',employee_id:'synthetic-employee-2',month:'2026-10-01',base_amount:7000000,allowances:120000,deductions:30000,total:7090000,snapshot:{employee_id:'synthetic-employee-2',name:names[2],device_user_id:'DEMO-003',employmentType:'full_time',settlementMode:'monthly_net',minutes:960,monthlyActualMinutes:960,monthlyExtraHourlyRate:7000000/216,baseAmount:7000000,daily:[{date:'2026-10-01',minutes:480},{date:'2026-10-02',minutes:480}],unresolved:0}});
    for(const payment of t.db.payroll_payments)if(payment.employee_id==='synthetic-employee-2'&&payment.payroll_month==='2026-10-01')payment.run_id='synthetic-finalized-c';
    const sample=t.db.payroll_payments[0];
    t.db.payroll_payments.push({...sample,id:'cancelled-do-not-print',amount:987654},{...sample,id:'before-range',paid_on:'2026-09-30',amount:11111},{...sample,id:'after-range',paid_on:'2026-11-01',amount:22222});
    t.db.payroll_payment_reversals.push({id:'synthetic-reversal',payment_id:'cancelled-do-not-print',reason:'Synthetic cancellation',created_at:'2026-11-03T01:00:00Z'});
    if(count>6){t.db.payroll_employees[0].name='합성 긴 이름 Nguyễn Thị Thanh Hương Long Name';t.db.payroll_employees[0].phone='000-0000-0000-EXT-LONG';t.sensitive[t.db.payroll_employees[0].id].national_id='000-SYNTHETIC-LONG-ID-NUMBER';}
    t.db.payroll_revision[0].version++;
  },size);
  await page.locator('#refresh').click();await idle();
}
async function query(from='2026-10-01',to='2026-10-31',employee=''){
  await openPayrollView(page,'payments');
  for(const [selector,value] of [['#rangeFrom',from],['#rangeTo',to]]){await page.locator(selector).fill(value);await page.locator(selector).dispatchEvent('change');}
  await page.locator('#rangeEmployee').selectOption(employee);await page.locator('#rangeSearch').click();await idle();
  assert.equal(await page.locator('#rangeReceiptPrint').isDisabled(),false);
}
async function popup(){const pending=page.waitForEvent('popup');await page.locator('#rangeReceiptPrint').click();const result=await pending;result.on('pageerror',error=>errors.push(error.message));await result.waitForFunction(()=>window.__printed===true);return result;}
async function assertWorkDates(row,dates){
  const cell=row.locator('[data-receipt-field="worked-days"]');
  assert.deepEqual(await cell.locator('.receipt-work-date').evaluateAll(spans=>spans.map(span=>[span.dataset.workDate,span.textContent.trim()])),dates.map(date=>[date,date.slice(5).replace('-','/')]),'every worked date is separately printed in full MM/DD form');
  assert.match(await cell.locator('small').innerText(),new RegExp(`${dates.length}일`),'the date list retains its total day count');
  assert.equal(await cell.evaluate(element=>{const box=element.getBoundingClientRect();return element.scrollHeight<=element.clientHeight+1&&[...element.querySelectorAll('.receipt-work-date')].every(span=>{const date=span.getBoundingClientRect();return date.height>0&&date.width>0&&date.top>=box.top-1&&date.bottom<=box.bottom+1&&date.left>=box.left-1&&date.right<=box.right+1&&getComputedStyle(span).visibility!=='hidden';});}),true,'all dates are visible inside the cell without clipped overflow');
}
async function assertFits(result){
  assert.deepEqual(await result.evaluate(()=>[...document.querySelectorAll('.receipt-table th,.receipt-table td')].filter(cell=>cell.scrollWidth>cell.clientWidth+1).map(cell=>({text:cell.innerText,field:cell.dataset.receiptField,width:cell.clientWidth,overflow:cell.scrollWidth}))),[],'all printed table content fits its cells');
  assert.equal(await result.locator('.receipt-table').evaluate(table=>getComputedStyle(table.querySelector('thead')).display),'table-header-group','long reports repeat their column headings');
  const images=await result.locator('.receipt-table img').evaluateAll(images=>images.map(image=>({height:image.getBoundingClientRect().height,width:image.getBoundingClientRect().width,loaded:image.complete&&image.naturalWidth>0})));
  assert.ok(images.every(image=>image.loaded&&image.height<=53&&image.width<=137),'every payment signature is decoded and remains compact');
}
async function capture(result,name,expectedPages){
  // Match the A4 landscape content box after the template's 8mm margins.
  await result.setViewportSize({width:1062,height:734});await result.emulateMedia({media:'print'});await result.screenshot({path:path.join(folder,name+'.png'),fullPage:true});await assertFits(result);
  // Label test artifacts within an existing line so the marker itself does not
  // introduce a page break absent from the actual application's printout.
  await result.evaluate(()=>{document.querySelector('footer p').append(' · 합성 직원·지급·서명 / DỮ LIỆU MẪU');});
  await writeFile(path.join(folder,name+'.html'),await result.content());
  const bytes=await result.pdf({path:path.join(folder,name+'.pdf'),preferCSSPageSize:true,printBackground:true});
  const pages=(bytes.toString('latin1').match(/\/Type\s*\/Page\b/g)||[]).length;
  if(expectedPages===1&&pages!==1)console.log(JSON.stringify({name,pages,layout:await result.evaluate(()=>Object.fromEntries(['header','.receipt-table','.receipt-closing'].map(selector=>{const box=document.querySelector(selector).getBoundingClientRect();return [selector,{top:box.top,height:box.height,bottom:box.bottom}];})))}));
  assert.ok(pages>0,'PDF page tree is present');
  if(expectedPages!==1)assert.ok(pages>=2,'35 payments paginate across A4 pages');
  const media=bytes.toString('latin1').match(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/);
  assert.ok(media&&Math.abs(Number(media[1])-841.89)<2&&Math.abs(Number(media[2])-595.28)<2,'printed PDF uses A4 landscape dimensions');
  await result.screenshot({path:path.join(folder,name+'.png'),fullPage:true});return pages;
}

try{
  await mkdir(folder,{recursive:true});
  await page.goto(origin+'/payroll.html');await page.waitForFunction(()=>window.DGV_PAYROLL_APP?.state.loaded);
  await seed();await query();const storedBefore=await page.evaluate(()=>JSON.stringify(__payrollTest.db)),report=await popup();
  assert.equal(await report.locator('.receipt-table tbody tr[data-payment-id]').count(),6);
  assert.equal(await report.locator('.receipt-table thead th').count(),11);
  assert.deepEqual(await report.locator('[data-employment-type]').evaluateAll(rows=>rows.map(row=>row.dataset.employmentType)),['part_time','full_time','unknown']);
  assert.deepEqual(await report.locator('[data-payment-id]').evaluateAll(rows=>rows.map(row=>row.dataset.paymentId)),['synthetic-pay-000','synthetic-pay-003','synthetic-pay-001','synthetic-pay-002','synthetic-pay-004','synthetic-pay-005'],'part-time groups precede regular and unknown staff, with instalments adjacent');
  assert.equal(await report.locator('.receipt-table img').count(),6);
  assert.deepEqual(await report.evaluate(()=>__printedImages),[true,true,true,true,true,true]);
  const expected={activeCount:'6',employeeCount:'5',activeTotal:'1,350,000',cashTotal:'1,100,000',bankTotal:'250,000',unsignedCount:'0',unavailableCount:'0'};
  for(const [key,value] of Object.entries(expected))assert.ok((await report.locator(`[data-receipt-total="${key}"]`).first().innerText()).includes(value),`${key} is ${value}`);
  const body=await report.locator('body').innerText();
  assert.doesNotMatch(body,/cancelled-do-not-print|987,654|before-range|after-range|PRIVATE-BANK/);
  assert.match(body,/2026-09/,'a September salary actually paid in October remains in the selected report');
  assert.match(body,/작성자/);assert.match(body,/관리자/);assert.match(body,/세무대리인/);
  for(let i=0;i<6;i++){
    const row=report.locator(`[data-payment-id="synthetic-pay-${String(i).padStart(3,'0')}"]`);
    assert.equal(await row.locator('.receipt-date').innerText(),`2026-10-${['03','05','08','11','15','18'][i]}`,'every payment keeps its own actual paid date');
    assert.equal(await row.locator('[data-receipt-field="paid-amount"]').innerText(),[240000,220000,280000,200000,160000,250000][i].toLocaleString('en-US'),'every payment keeps its own actual amount');
    assert.match(await row.innerText(),new RegExp(`합성 서명 ${i+1}`));
    assert.equal(await row.locator('img').getAttribute('src'),await page.evaluate(index=>`data:image/png;base64,${btoa(String.fromCharCode(...__payrollTest.storageObjects[`synthetic-pay-${String(index).padStart(3,'0')}/signature.png`].bytes))}`,i),'signature is bound to that exact instalment');
    assert.match(await row.innerText(),/08:02:03/,'signature wall time stays Vietnamese in a Korean browser timezone');
    if(await row.getAttribute('data-month-detail')==='first'){
      assert.match(await row.locator('[data-receipt-field="national-id"]').innerText(),/000-DEMO-ID-/);
      assert.match(await row.locator('[data-receipt-field="phone"]').innerText(),/090-000-/);
    }
  }
  const first=report.locator('[data-payment-id="synthetic-pay-000"]'),continuation=report.locator('[data-payment-id="synthetic-pay-003"]');
  await assertWorkDates(first,['2026-09-28','2026-09-29']);
  for(const [field,value] of [['work-minutes','5h 30m'],['hourly-rates','40,000'],['base-amount','220,000'],['allowances','—'],['deductions','—']])assert.equal(await first.locator(`[data-receipt-field="${field}"]`).innerText(),value,'full September calculation '+field);
  for(const field of ['worked-days','work-minutes','hourly-rates','base-amount','allowances','deductions'])assert.equal(await continuation.locator(`[data-receipt-field="${field}"]`).innerText(),'','monthly values are not repeated or allocated across instalments');
  const finalized=report.locator('[data-payment-id="synthetic-pay-002"]');for(const [field,value] of [['work-minutes','16h 0m'],['base-amount','7,000,000'],['allowances','120,000'],['deductions','30,000']])assert.equal(await finalized.locator(`[data-receipt-field="${field}"]`).innerText(),value,'saved monthly component '+field);
  assert.equal(await report.locator('[data-payment-id="synthetic-pay-005"] [data-receipt-field="base-amount"]').innerText(),'—','unknown salary conditions never become zero salary');
  assert.equal(await report.locator('script').count(),0);assert.equal(await report.evaluate(()=>opener===null),true);
  const samplePages=await capture(report,'sample-six-payments',1);
  assert.equal(await page.evaluate(()=>JSON.stringify(__payrollTest.db)),storedBefore,'printing does not change payment, work or salary records');
  await report.emulateMedia({media:'screen'});await report.setViewportSize({width:390,height:844});
  assert.equal(await report.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'phone popup contains any wide table within its own scroll area');
  await report.screenshot({path:path.join(folder,'sample-phone.png'),fullPage:true});await report.close();
  await page.evaluate(()=>{for(const [index,day] of [[0,'05'],[3,'06']]){const id=`synthetic-pay-${String(index).padStart(3,'0')}`,payment=__payrollTest.db.payroll_payments.find(item=>item.id===id);Object.assign(payment,{paid_on:`2026-11-${day}`,payroll_month:'2026-10-01'});__payrollTest.db.payroll_attachments.find(item=>item.payment_id===id).acknowledged_at=`2026-11-${day}T01:02:03Z`;}__payrollTest.db.payroll_revision[0].version++;});
  await page.locator('#refresh').click();await idle();await query('2026-11-05','2026-11-06','synthetic-employee-0');const nextMonth=await popup();
  assert.equal(await nextMonth.locator('[data-payment-id]').count(),2);
  assert.equal(await nextMonth.locator('[data-payment-id="synthetic-pay-000"] [data-receipt-field="work-minutes"]').innerText(),'6h 30m');
  assert.equal(await nextMonth.locator('[data-payment-id="synthetic-pay-000"] [data-receipt-field="base-amount"]').innerText(),'260,000','November payments include all October work, including Oct 25');
  await assertWorkDates(nextMonth.locator('[data-payment-id="synthetic-pay-000"]'),['2026-10-01','2026-10-25']);
  assert.equal(await nextMonth.locator('[data-payment-id="synthetic-pay-003"] [data-receipt-field="base-amount"]').innerText(),'');
  await capture(nextMonth,'cross-month-instalments',1);await nextMonth.close();
  await seed();await page.evaluate(()=>{
    const state=__payrollTest,id='synthetic-employee-0',payment=state.db.payroll_payments.find(item=>item.id==='synthetic-pay-000');
    state.db.payroll_attendance_raw=Array.from({length:31},(_,index)=>{const date=`2026-10-${String(index+1).padStart(2,'0')}`;return [['10:00:00','in'],['20:00:00','out']].map(([time,punch_type])=>({id:`all-dates-${index}-${punch_type}`,employee_id:id,occurred_at:`${date}T${time}`,punch_type,source:'kiosk',device_id:'SYNTHETIC-TABLET'}));}).flat();
    state.db.payroll_payments=[{...payment,paid_on:'2026-10-31',payroll_month:'2026-10-01',amount:12400000}];
    state.db.payroll_attachments=state.db.payroll_attachments.filter(item=>item.payment_id===payment.id);state.db.payroll_attachments[0].acknowledged_at='2026-10-31T13:02:03Z';state.db.payroll_revision[0].version++;
  });
  await page.locator('#refresh').click();await idle();await query('2026-10-31','2026-10-31','synthetic-employee-0');const datesStoredBefore=await page.evaluate(()=>JSON.stringify(__payrollTest.db)),allDates=await popup(),allDatesRow=allDates.locator('[data-payment-id="synthetic-pay-000"]');
  assert.equal(await allDates.locator('[data-payment-id]').count(),1);await assertWorkDates(allDatesRow,Array.from({length:31},(_,index)=>`2026-10-${String(index+1).padStart(2,'0')}`));
  assert.equal(await allDatesRow.locator('[data-receipt-field="work-minutes"]').innerText(),'310h 0m');assert.equal(await allDatesRow.locator('[data-receipt-field="paid-amount"]').innerText(),'12,400,000');assert.equal(await allDatesRow.locator('img').count(),1);
  const allDatesPages=await capture(allDates,'all-31-work-dates',1);assert.equal(allDatesPages,1,'all 31 individual work dates fit one A4 landscape page');
  await assertWorkDates(allDatesRow,Array.from({length:31},(_,index)=>`2026-10-${String(index+1).padStart(2,'0')}`));assert.equal(await page.evaluate(()=>JSON.stringify(__payrollTest.db)),datesStoredBefore,'printing all work dates remains read-only');await allDates.close();
  await seed(35);await query();const long=await popup();
  assert.equal(await long.locator('.receipt-table tbody tr[data-payment-id]').count(),35);
  assert.deepEqual((await long.locator('[data-payment-id]').evaluateAll(rows=>rows.map(row=>row.dataset.paymentId))).sort(),Array.from({length:35},(_,index)=>`synthetic-pay-${String(index).padStart(3,'0')}`),'all qualifying payments survive grouping and pagination');
  for(const [month,amount] of [['2026-09','220,000'],['2026-10','260,000']]){
    const group=long.locator(`[data-receipt-group="synthetic-employee-0:${month}"]`);
    assert.equal(await group.locator('[data-receipt-field="base-amount"]').evaluateAll(cells=>cells.filter(cell=>cell.textContent.trim()).length),1,'one monthly calculation for each employee-month');
    assert.equal(await long.locator(`[data-receipt-group="synthetic-employee-0:${month}"][data-month-detail="first"] [data-receipt-field="base-amount"]`).innerText(),amount);
  }
  assert.equal(await long.locator('.receipt-table img').count(),35);
  const longPages=await capture(long,'many-payments',2);await long.close();
  assert.equal(await page.evaluate(()=>__payrollTest.calls.some(call=>call.operation!=='select')),false,'printing does not mutate data');
  assert.equal(await page.evaluate(()=>__payrollTest.storageReads.some(read=>read.path?.startsWith('cancelled'))),false);
  assert.deepEqual(errors,[]);
  assert.equal(samplePages,1,'six payments fit one A4 landscape page');
  console.log(JSON.stringify({result:'passed',samplePayments:6,uniqueEmployees:5,paid:1350000,cash:1100000,bank:250000,samplePages,allWorkDates:31,allDatesPages,longPayments:35,longPages,phoneWidth:390,syntheticOnly:true,folder}));
}finally{await context.close();await browser.close();}
