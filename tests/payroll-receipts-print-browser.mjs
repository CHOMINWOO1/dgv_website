import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
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
      t.db.payroll_employees.push({id,name:names[i]||`합성 직원 ${i} · Nguyễn Thị`,device_user_id:`DEMO-${String(i+1).padStart(3,'0')}`,active:true,payee_type:'employee',employment_type:'part_time',phone:`090-000-${String(i+1).padStart(4,'0')}`});
      t.sensitive[id]={national_id:`000-DEMO-ID-${String(i+1).padStart(3,'0')}`,bank_account:'PRIVATE-BANK-NEVER-PRINT'};
    }
    const amounts=[240000,220000,280000,200000,160000,250000],dates=['03','05','08','11','15','18'],person=[0,1,2,0,3,4];
    for(let i=0;i<count;i++){
      const employee=t.db.payroll_employees[count===6?person[i]:i%people],id=`synthetic-pay-${String(i).padStart(3,'0')}`;
      const paid_on=`2026-10-${count===6?dates[i]:String(i%28+1).padStart(2,'0')}`;
      t.db.payroll_payments.push({id,run_id:null,employee_id:employee.id,payroll_month:i===0?'2026-09-01':'2026-10-01',paid_on,amount:count===6?amounts[i]:100000+i*1000,method:count===6?(i===5?'bank':'cash'):(i%3?'cash':'bank'),note:'Synthetic payout only'});
      const canvas=document.createElement('canvas');canvas.width=240;canvas.height=80;
      const c=canvas.getContext('2d');c.fillStyle='white';c.fillRect(0,0,240,80);c.strokeStyle='#19364f';c.lineWidth=2.5;c.beginPath();c.moveTo(12,58);c.lineTo(48+i%8,17);c.lineTo(83,61);c.lineTo(132+i%12,22);c.lineTo(204,54);c.stroke();
      const dataUrl=canvas.toDataURL('image/png'),bytes=Array.from(atob(dataUrl.split(',')[1]),char=>char.charCodeAt(0)),storage_path=`${id}/signature.png`;
      t.storageObjects[storage_path]={bytes,mime:'image/png'};
      t.db.payroll_attachments.push({id:`signature-${i}`,payment_id:id,storage_path,mime_type:'image/png',byte_size:bytes.length,evidence_type:'signature',signed_name:`합성 서명 ${i+1}`,acknowledged_at:`${paid_on}T01:02:03Z`});
    }
    const sample=t.db.payroll_payments[0];
    t.db.payroll_payments.push({...sample,id:'cancelled-do-not-print',amount:987654},{...sample,id:'before-range',paid_on:'2026-09-30',amount:11111},{...sample,id:'after-range',paid_on:'2026-11-01',amount:22222});
    t.db.payroll_payment_reversals.push({id:'synthetic-reversal',payment_id:'cancelled-do-not-print',reason:'Synthetic cancellation',created_at:'2026-11-03T01:00:00Z'});
    if(count>6){t.db.payroll_employees[0].name='합성 긴 이름 Nguyễn Thị Thanh Hương Long Name';t.db.payroll_employees[0].phone='000-0000-0000-EXT-LONG';t.sensitive[t.db.payroll_employees[0].id].national_id='000-SYNTHETIC-LONG-ID-NUMBER';}
    t.db.payroll_revision[0].version++;
  },size);
  await page.locator('#refresh').click();await idle();
}
async function query(){
  await openPayrollView(page,'payments');
  for(const [selector,value] of [['#rangeFrom','2026-10-01'],['#rangeTo','2026-10-31']]){await page.locator(selector).fill(value);await page.locator(selector).dispatchEvent('change');}
  await page.locator('#rangeEmployee').selectOption('');await page.locator('#rangeSearch').click();await idle();
  assert.equal(await page.locator('#rangeReceiptPrint').isDisabled(),false);
}
async function popup(){const pending=page.waitForEvent('popup');await page.locator('#rangeReceiptPrint').click();const result=await pending;result.on('pageerror',error=>errors.push(error.message));await result.waitForFunction(()=>window.__printed===true);return result;}
async function assertFits(result){
  assert.equal(await result.evaluate(()=>[...document.querySelectorAll('.receipt-table th,.receipt-table td')].every(cell=>cell.scrollWidth<=cell.clientWidth+1)),true,'all printed table content fits its cells');
  assert.equal(await result.locator('.receipt-table').evaluate(table=>getComputedStyle(table.querySelector('thead')).display),'table-header-group','long reports repeat their column headings');
  const images=await result.locator('.receipt-table img').evaluateAll(images=>images.map(image=>({height:image.getBoundingClientRect().height,width:image.getBoundingClientRect().width,loaded:image.complete&&image.naturalWidth>0})));
  assert.ok(images.every(image=>image.loaded&&image.height<=53&&image.width<=137),'every payment signature is decoded and remains compact');
}
async function capture(result,name,expectedPages){
  await result.setViewportSize({width:1122,height:794});await result.emulateMedia({media:'print'});await assertFits(result);
  // Label test artifacts within an existing line so the marker itself does not
  // introduce a page break absent from the actual application's printout.
  await result.evaluate(()=>{document.querySelector('footer p').append(' · 합성 직원·지급·서명 / DỮ LIỆU MẪU');});
  const bytes=await result.pdf({path:path.join(folder,name+'.pdf'),preferCSSPageSize:true,printBackground:true});
  const pages=(bytes.toString('latin1').match(/\/Type\s*\/Page\b/g)||[]).length;
  assert.ok(pages>0,'PDF page tree is present');
  if(expectedPages!==1)assert.ok(pages>=2,'35 payments paginate across A4 pages');
  const media=bytes.toString('latin1').match(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/);
  assert.ok(media&&Math.abs(Number(media[1])-841.89)<2&&Math.abs(Number(media[2])-595.28)<2,'printed PDF uses A4 landscape dimensions');
  await result.screenshot({path:path.join(folder,name+'.png'),fullPage:true});return pages;
}

try{
  await mkdir(folder,{recursive:true});
  await page.goto(origin+'/payroll.html');await page.waitForFunction(()=>window.DGV_PAYROLL_APP?.state.loaded);
  await seed();await query();const report=await popup();
  assert.equal(await report.locator('.receipt-table tbody tr[data-payment-id]').count(),6);
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
    assert.match(await row.innerText(),new RegExp(`합성 서명 ${i+1}`));
    assert.equal(await row.locator('img').getAttribute('src'),await page.evaluate(index=>`data:image/png;base64,${btoa(String.fromCharCode(...__payrollTest.storageObjects[`synthetic-pay-${String(index).padStart(3,'0')}/signature.png`].bytes))}`,i),'signature is bound to that exact instalment');
    assert.match(await row.innerText(),/08:02:03/,'signature wall time stays Vietnamese in a Korean browser timezone');
    assert.match(await row.locator('[data-receipt-field="national-id"]').innerText(),/000-DEMO-ID-/);
    assert.match(await row.locator('[data-receipt-field="phone"]').innerText(),/090-000-/);
  }
  assert.equal(await report.locator('script').count(),0);assert.equal(await report.evaluate(()=>opener===null),true);
  const samplePages=await capture(report,'sample-six-payments',1);
  await report.emulateMedia({media:'screen'});await report.setViewportSize({width:390,height:844});
  assert.equal(await report.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'phone popup contains any wide table within its own scroll area');
  await report.screenshot({path:path.join(folder,'sample-phone.png'),fullPage:true});await report.close();
  await seed(35);await query();const long=await popup();
  assert.equal(await long.locator('.receipt-table tbody tr[data-payment-id]').count(),35);
  assert.equal(await long.locator('.receipt-table img').count(),35);
  const longPages=await capture(long,'many-payments',2);await long.close();
  assert.equal(await page.evaluate(()=>__payrollTest.calls.some(call=>call.operation!=='select')),false,'printing does not mutate data');
  assert.equal(await page.evaluate(()=>__payrollTest.storageReads.some(read=>read.path?.startsWith('cancelled'))),false);
  assert.deepEqual(errors,[]);
  assert.equal(samplePages,1,'six payments fit one A4 landscape page');
  console.log(JSON.stringify({result:'passed',samplePayments:6,uniqueEmployees:5,paid:1350000,cash:1100000,bank:250000,samplePages,longPayments:35,longPages,phoneWidth:390,syntheticOnly:true,folder}));
}finally{await context.close();await browser.close();}
