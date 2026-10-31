import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {installMock} from './helpers/payroll-browser-mock.mjs';
import {openPayrollView} from './helpers/payroll-navigation.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const server=createServer(async(req,res)=>{try{const file=path.resolve(root,new URL(req.url,'http://localhost').pathname.slice(1));if(!file.startsWith(root+path.sep))throw Error();res.setHeader('Content-Type',file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.js')?'text/javascript; charset=utf-8':'text/css');res.end(await readFile(file));}catch{res.writeHead(404);res.end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`,browser=await chromium.launch({channel:'chrome',headless:true});
const context=await browser.newContext({viewport:{width:1300,height:950}});
await context.addInitScript(()=>{window.print=()=>{window.__printedImages=[...document.images].map(image=>image.complete&&image.naturalWidth>0);window.__printed=true;};});
await context.route('**/*',route=>{const url=route.request().url();if(url.startsWith('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@'))return route.fulfill({contentType:'text/javascript',body:`(${installMock.toString()})("admin");`});if(!url.startsWith(origin))return route.fulfill({body:''});return route.continue();});
const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
const idle=()=>page.waitForFunction(()=>!document.getElementById('workspace').disabled);
try{
  await page.goto(origin+'/payroll.html');await page.waitForFunction(()=>window.DGV_PAYROLL_APP?.state.loaded);
  await page.evaluate(()=>{
    const t=__payrollTest;t.db.payroll_employees=[];t.db.payroll_runs=[];t.db.payroll_payments=[];t.db.payroll_attachments=[];t.db.payroll_payment_reversals=[];t.db.payroll_run_adjustments=[];
    for(let i=0;i<34;i++){
      const id=`synthetic-${i}`,name=i===0?'합성 직원 긴 이름 Nguyen Thi Synthetic Long Name':'합성 직원 '+String(i).padStart(2,'0');
      t.db.payroll_employees.push({id,name,device_user_id:`DEMO${i}`,active:true,phone:i===0?'000-0000-0000-EXT-LONG':'000-0000-0000',employment_type:'full_time'});
      t.sensitive[id]={national_id:'000-SYNTHETIC-ID-'+i,bank_account:'NEVER-PRINT-BANK'};
      if(i===33)continue;
      const run={id:`run-${i}`,employee_id:id,month:'2026-10-01',base_amount:1000000,allowances:0,deductions:0,total:1000000,snapshot:{name,minutes:150,workedDays:1,unresolved:0,daily:[{date:'2026-10-01',minutes:150,payType:'hourly',rate:40000}],issues:[]}};
      t.db.payroll_runs.push(run);
      if(i===32)continue;
      for(let part=0;part<(i===0?2:1);part++){
        const paymentId=`pay-${i}-${part}`,paid_on=part?'2026-11-03':'2026-10-01';
        t.db.payroll_payments.push({id:paymentId,run_id:run.id,employee_id:id,payroll_month:'2026-10-01',paid_on,amount:part?200000:300000,method:'cash',note:i===0?'합성 비고 긴 문장 '.repeat(12):'합성 메모'});
        if(i>0)continue;
        const canvas=document.createElement('canvas');canvas.width=240;canvas.height=90;const c=canvas.getContext('2d');c.fillStyle='white';c.fillRect(0,0,240,90);c.strokeStyle='black';c.lineWidth=3;c.beginPath();c.moveTo(10,60);c.lineTo(50+part*10,15);c.lineTo(90,60);c.lineTo(200,20+part*25);c.stroke();
        const bytes=Array.from(atob(canvas.toDataURL('image/png').split(',')[1]),char=>char.charCodeAt(0)),storage_path=`${paymentId}/synthetic.png`;
        t.storageObjects[storage_path]={bytes,mime:'image/png'};
        t.db.payroll_attachments.push({id:`sig-${part}`,payment_id:paymentId,storage_path,mime_type:'image/png',byte_size:bytes.length,evidence_type:'signature',signed_name:`합성 서명 ${part}`,acknowledged_at:paid_on+'T01:00:00Z'});
      }
    }
  });
  await page.locator('#refresh').click();await idle();await openPayrollView(page,'ledger');await page.locator('#month').fill('2026-10');await page.locator('#month').dispatchEvent('change');await idle();
  await openPayrollView(page,'payments');await page.locator('#exportKind').selectOption('ledger');await page.locator('#previewTax').click();await idle();await page.locator('#taxReviewed').check();
  const event=page.waitForEvent('popup');await page.locator('#printTax').click();const popup=await event;await popup.waitForFunction(()=>window.__printed===true);
  assert.deepEqual(await popup.locator('thead th').allTextContents(),['직원 이름Nhan vien','신분증번호CCCD / CMND','전화번호Dien thoai','지급일Ngay tra','근무시간Gio lam','시간당 금액VND / gio','월급여Luong thang','지급액So tien tra','서명Chu ky','상태Trang thai','비고Ghi chu']);
  const first=popup.locator('tr[data-payment-id="pay-0-0"]'),second=popup.locator('tr[data-payment-id="pay-0-1"]');
  assert.equal(await first.locator('td').nth(3).innerText(),'10월 1일\n2026-10-01');assert.match(await second.innerText(),/11월 3일/);
  assert.equal(await first.locator('td').nth(4).innerText(),'2시간 30분');assert.equal(await first.locator('img').count(),1);assert.match(await first.innerText(),/합성 서명 0/);assert.match(await second.innerText(),/합성 서명 1/);
  assert.deepEqual(await popup.evaluate(()=>__printedImages),[true,true]);assert.equal(await popup.locator('tbody tr').count(),35);
  assert.equal(await popup.locator('tbody tr').last().locator('td').nth(3).innerText(),'');assert.match(await popup.locator('tbody tr').last().locator('td').nth(6).innerText(),/미확정/);
  assert.doesNotMatch(await popup.locator('body').innerText(),/NEVER-PRINT-BANK/);
  await popup.emulateMedia({media:'print'});
  assert.equal(await popup.evaluate(()=>[...document.querySelectorAll('td,th')].every(cell=>cell.scrollWidth<=cell.clientWidth+1)),true,'all content wraps inside cells');
  const folder=path.join(root,'test-results','payroll-ledger-print');await mkdir(folder,{recursive:true});
  await popup.pdf({path:path.join(folder,'synthetic-ledger.pdf'),preferCSSPageSize:true,printBackground:true});
  await popup.screenshot({path:path.join(folder,'synthetic-ledger-browser.png'),fullPage:true});
  // A stored but unreadable signature must stop printing, not become unsigned.
  await popup.close();await page.evaluate(()=>{delete __payrollTest.storageObjects['pay-0-0/synthetic.png'];});
  const failedEvent=page.waitForEvent('popup');await page.locator('#printTax').click();const failed=await failedEvent;await idle();assert.equal(failed.isClosed(),true);
  await page.evaluate(()=>{__payrollTest.db.payroll_revision[0].version++;});
  const staleEvent=page.waitForEvent('popup');await page.locator('#printTax').click();const stale=await staleEvent;await idle();assert.equal(stale.isClosed(),true,'stale data blocks print before reading identities');
  await page.evaluate(()=>{__payrollTest.db.payroll_revision[0].version--;__payrollTest.deferSensitiveRead=true;});
  const logoutEvent=page.waitForEvent('popup');await page.locator('#printTax').click();const logoutPopup=await logoutEvent;await page.waitForFunction(()=>typeof __payrollTest.releaseSensitiveRead==='function');
  await page.evaluate(()=>DGV.supabase.auth.signOut());await page.evaluate(()=>__payrollTest.releaseSensitiveRead());await idle();assert.equal(logoutPopup.isClosed(),true,'logout during identity lookup closes pending print');
  assert.deepEqual(errors,[]);console.log('Ledger print passed: 11 columns, exact payment signature binding, split dates across months, 150-minute formatting, unpaid/draft rows, private bank exclusion, image decoding before print, failed-image print block, 35 synthetic rows and A4 landscape PDF.');
}finally{await context.close();await browser.close();await new Promise(resolve=>server.close(resolve));}
