import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {installMock} from './helpers/payroll-browser-mock.mjs';
import {openPayrollView} from './helpers/payroll-navigation.mjs';
import {readXlsx,xml,cells} from './payroll-receipts-xlsx.mjs';

// Exercise the actual administrator UI and native browser download. All data,
// identities and signatures are synthetic; every HTTP request is fulfilled locally.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const folder=path.join(root,'test-results','payroll-receipts-xlsx'),origin='http://127.0.0.1:8765';
await mkdir(path.join(folder,'browser-downloads'),{recursive:true});
const browser=await chromium.launch({channel:process.env.PAYROLL_BROWSER_CHANNEL||'chrome',headless:true,downloadsPath:path.join(folder,'browser-downloads')});
function seed(){
  const state=window.__payrollTest;
  for(const table of ['payroll_employees','payroll_terms','payroll_attendance_raw','payroll_days','payroll_runs','payroll_payments','payroll_attachments','payroll_payment_reversals','payroll_run_adjustments'])state.db[table]=[];
  state.sensitive={};state.storageObjects={};
  const names=['합성 직원 A · Nguyễn An','합성 직원 B · Trần Bình','합성 직원 C · Lê Chi','합성 직원 D · Đặng Dũng','합성 직원 E · Phạm Hà'];
  for(let index=0;index<5;index++){
    const id=`synthetic-employee-${index}`;state.db.payroll_employees.push({id,name:names[index],device_user_id:`DEMO-${String(index+1).padStart(3,'0')}`,active:true,payee_type:'employee',employment_type:'part_time',phone:`090-000-${String(index+1).padStart(4,'0')}`});
    state.sensitive[id]={national_id:`000-DEMO-ID-${String(index+1).padStart(3,'0')}`,bank_account:'PRIVATE-BANK-NEVER-EXPORT'};
  }
  const amounts=[240000,220000,280000,200000,160000,250000],dates=['03','05','08','11','15','18'],people=[0,1,2,0,3,4];
  for(let index=0;index<6;index++){
    const id=`synthetic-pay-${index}`,employee=state.db.payroll_employees[people[index]],paid_on=`2026-10-${dates[index]}`;
    state.db.payroll_payments.push({id,run_id:null,employee_id:employee.id,payroll_month:index===0?'2026-09-01':'2026-10-01',paid_on,amount:amounts[index],method:index===5?'bank':'cash',note:'Synthetic payout only'});
    const canvas=document.createElement('canvas');canvas.width=240;canvas.height=80;const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,240,80);ctx.strokeStyle='#19364f';ctx.lineWidth=2.5;ctx.beginPath();ctx.moveTo(12,58);ctx.lineTo(48+index,17);ctx.lineTo(83,61);ctx.lineTo(132+index,22);ctx.lineTo(204,54);ctx.stroke();
    const bytes=Array.from(atob(canvas.toDataURL('image/png').split(',')[1]),char=>char.charCodeAt(0)),storage_path=`${id}/signature.png`;
    state.storageObjects[storage_path]={bytes,mime:'image/png'};
    state.db.payroll_attachments.push({id:`signature-${index}`,payment_id:id,storage_path,mime_type:'image/png',byte_size:bytes.length,evidence_type:'signature',signed_name:`합성 서명 ${index+1}`,acknowledged_at:`${paid_on}T01:02:03Z`});
  }
  const first=state.db.payroll_payments[0];
  state.db.payroll_payments.push({...first,id:'cancelled-never-export',amount:987654},{...first,id:'before-range',paid_on:'2026-09-30',amount:11111},{...first,id:'after-range',paid_on:'2026-11-01',amount:22222});
  state.db.payroll_payment_reversals.push({id:'synthetic-reversal',payment_id:'cancelled-never-export',reason:'Synthetic cancellation',created_at:'2026-11-03T01:00:00Z'});
}
async function newContext(role='admin'){
  const context=await browser.newContext({viewport:{width:1280,height:900},timezoneId:'Asia/Seoul',acceptDownloads:true});
  // Keep the exact synthetic Blob for diagnosis if the browser/host cancels a
  // download. Cancellation still fails the test; this is not a passing fallback.
  await context.addInitScript(()=>{const create=URL.createObjectURL.bind(URL);URL.createObjectURL=blob=>{if(blob.type==='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')window.__receiptTestBlob=blob;return create(blob);};});
  await context.route('**/*',async route=>{
    const url=route.request().url();
    if(url.startsWith('blob:'))return route.continue();
    if(url.startsWith('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@'))return route.fulfill({contentType:'text/javascript',body:`(${installMock.toString()})(${JSON.stringify(role)});(${seed.toString()})();`});
    if(!url.startsWith(origin))return route.fulfill({body:''});
    try{const file=path.resolve(root,decodeURIComponent(new URL(url).pathname).slice(1));if(!file.startsWith(root+path.sep))throw Error('Invalid path');return route.fulfill({contentType:({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css'})[path.extname(file)]||'application/octet-stream',body:await readFile(file)});}catch{return route.fulfill({status:404,body:''});}
  });return context;
}
const context=await newContext(),page=await context.newPage(),errors=[],downloads=[],downloadFailures=[];
page.on('pageerror',error=>errors.push(error.message));page.on('download',download=>downloads.push(download));page.setDefaultTimeout(12000);
const button=()=>page.locator('#rangeReceiptExcel'),idle=()=>page.waitForFunction(()=>!document.getElementById('workspace').disabled);
async function query(from='2026-10-01',to='2026-10-31',employee=''){
  await openPayrollView(page,'payments');
  for(const [id,value] of [['rangeFrom',from],['rangeTo',to]]){await page.locator('#'+id).fill(value);await page.locator('#'+id).dispatchEvent('change');}
  await page.locator('#rangeEmployee').selectOption(employee);await page.locator('#rangeSearch').click();await idle();
}
async function download(name){
  assert.equal(await button().isDisabled(),false);const pending=page.waitForEvent('download');await button().click();const actual=await pending;await idle();
  assert.match(actual.suggestedFilename(),/\.xlsx$/);const failure=await actual.failure(),target=path.join(folder,name);
  if(failure){downloadFailures.push({name,failure});const bytes=await page.evaluate(async()=>Array.from(new Uint8Array(await window.__receiptTestBlob.arrayBuffer())));await writeFile(target,Buffer.from(bytes));}
  else await actual.saveAs(target);
  return readXlsx(await readFile(target));
}
async function deferredRevision(){
  await page.evaluate(()=>{delete __payrollTest.releaseRead;__payrollTest.deferReadFor='payroll_revision';});
  await button().click();await page.waitForFunction(()=>typeof __payrollTest.releaseRead==='function');
}
try{
  await mkdir(folder,{recursive:true});
  for(const role of [null,'manager','staff']){
    const denied=await newContext(role),tab=await denied.newPage();await tab.goto(origin+'/payroll.html');await tab.locator('#loginModal').waitFor({state:'visible'});
    assert.equal(await tab.locator('#payrollApp').isVisible(),false);assert.equal(await tab.locator('#rangeReceiptExcel').isVisible(),false);
    assert.equal(await tab.evaluate(()=>__payrollTest.calls.some(call=>call.table)),false);assert.equal(await tab.evaluate(()=>__payrollTest.storageReads.length),0);await denied.close();
  }
  await page.goto(origin+'/payroll.html');await page.waitForFunction(()=>window.DGV_PAYROLL_APP?.state.loaded);await query();
  const baseline=await page.evaluate(()=>({db:JSON.stringify(__payrollTest.db),uploads:__payrollTest.uploads.length}));
  const files=await download('sample-six-payments.xlsx'),sheet=xml(files,'xl/worksheets/sheet1.xml'),all=cells(sheet),money=all.filter(cell=>/^G\d+$/.test(cell.reference)&&cell.type==='n').map(cell=>cell.value);
  assert.ok(money.includes(1350000));for(const amount of [240000,220000,280000,200000,160000,250000])assert.equal(money.filter(value=>value===amount).length,1);
  assert.ok(all.some(cell=>cell.value===1100000),'cash total matches five payments');assert.ok(all.some(cell=>cell.value===250000),'bank total is included');
  for(const text of ['2026-09','000-DEMO-ID-001','090-000-0001','08:02:03'])assert.ok(sheet.includes(text));
  assert.doesNotMatch(sheet,/987654|11111|22222|PRIVATE-BANK|cancelled-never-export/);
  const media=[...files].filter(([name])=>name.startsWith('xl/media/'));assert.equal(media.length,6);
  const originals=await page.evaluate(()=>Object.values(__payrollTest.storageObjects).map(file=>file.bytes));
  for(const original of originals)assert.equal(media.filter(([,actual])=>actual.equals(Buffer.from(original))).length,1);
  assert.equal(await page.locator('#rangeReceipts [data-payment-id]').count(),6,'Excel uses the same six visible payments as print');
  assert.deepEqual(await page.evaluate(()=>({db:JSON.stringify(__payrollTest.db),uploads:__payrollTest.uploads.length})),baseline,'downloading is read-only');
  await page.screenshot({path:path.join(folder,'export-controls.png'),fullPage:true});
  await query('2026-10-03','2026-10-03','synthetic-employee-0');const one=await download('selected-single-payment.xlsx'),oneSheet=xml(one,'xl/worksheets/sheet1.xml');
  assert.equal([...one.keys()].filter(name=>name.startsWith('xl/media/')).length,1);assert.doesNotMatch(oneSheet,/000-DEMO-ID-002|Trần Bình|250000/);assert.match(oneSheet,/2026-09/);
  await page.locator('#rangeEmployee').selectOption('synthetic-employee-1');assert.equal(await button().isDisabled(),true,'employee changes invalidate a captured report');
  await query();await page.locator('#rangeTo').fill('2026-10-30');await page.locator('#rangeTo').dispatchEvent('change');assert.equal(await button().isDisabled(),true,'date changes invalidate a captured report');
  await query();await page.evaluate(()=>{__payrollTest.failDownloadOnce=true;});await query();assert.equal(await button().isDisabled(),true,'a stored PNG that cannot be fetched blocks export');
  await query();await page.evaluate(()=>{__payrollTest.failSensitiveReadOnce=true;});await query();assert.equal(await button().isDisabled(),true,'a failed private identity read cannot reuse a prior export');
  await query();let count=downloads.length;await page.evaluate(()=>{__payrollTest.failRead=true;});await button().click();await idle();assert.equal(downloads.length,count,'a failed final revision read blocks download');await page.evaluate(()=>{__payrollTest.failRead=false;});
  await query();count=downloads.length;await page.evaluate(()=>{__payrollTest.db.payroll_revision[0].version++;});await button().click();await idle();assert.equal(downloads.length,count,'a revision change before export blocks a stale download');
  await page.locator('#refresh').click();await idle();await query();count=downloads.length;await deferredRevision();
  await page.evaluate(()=>{document.getElementById('rangeTo').value='2026-10-30';document.getElementById('rangeTo').dispatchEvent(new Event('change'));__payrollTest.releaseRead();});await idle();assert.equal(downloads.length,count,'scope changed during final revision read blocks download');
  await query();count=downloads.length;await deferredRevision();await page.evaluate(()=>{__payrollTest.db.payroll_revision[0].version++;__payrollTest.releaseRead();});await idle();assert.equal(downloads.length,count,'revision changed during final read blocks download');
  await page.locator('#refresh').click();await idle();await page.evaluate(()=>{__payrollTest.db.payroll_attachments=__payrollTest.db.payroll_attachments.filter(attachment=>attachment.payment_id!=='synthetic-pay-0');});await query();
  const unsigned=await download('unsigned-payment.xlsx');assert.match(xml(unsigned,'xl/worksheets/sheet1.xml'),/서명 미등록|Chưa ký/);assert.equal([...unsigned.keys()].filter(name=>name.startsWith('xl/media/')).length,5,'unsigned is explicitly labelled, not filled with another payment signature');
  assert.equal(await page.evaluate(()=>__payrollTest.calls.some(call=>call.operation!=='select')),false);assert.equal(await page.evaluate(()=>__payrollTest.storageReads.some(read=>read.path?.startsWith('cancelled'))),false);
  count=downloads.length;await deferredRevision();await page.evaluate(()=>DGV_PAYROLL_APP.db.auth.signOut());await page.evaluate(()=>__payrollTest.releaseRead());await idle();
  assert.equal(downloads.length,count,'logout during final revision read blocks private download');assert.equal(await page.locator('#payrollApp').isVisible(),false);assert.equal(await button().isDisabled(),true);assert.equal(await page.locator('#rangeReceipts').innerText(),'');
  await page.reload();await page.waitForFunction(()=>window.DGV_PAYROLL_APP?.state.loaded);await query();
  await page.evaluate(()=>{delete __payrollTest.releaseSensitiveRead;__payrollTest.deferSensitiveRead=true;});await page.locator('#rangeSearch').click();await page.waitForFunction(()=>typeof __payrollTest.releaseSensitiveRead==='function');
  await page.evaluate(()=>DGV_PAYROLL_APP.db.auth.signOut());await page.evaluate(()=>__payrollTest.releaseSensitiveRead());await idle();assert.equal(await button().isDisabled(),true);assert.equal(await page.locator('#rangeReceipts').innerText(),'','late private responses after logout cannot restore Excel access');
  assert.deepEqual(errors,[]);console.log(JSON.stringify({result:downloadFailures.length?'app checks passed; native download failed':'passed',syntheticOnly:true,samplePayments:6,signatures:6,total:1350000,actualDownloads:downloads.length,downloadFailures,checks:'administrator gate, date/employee scope, missing image/private data, revision and logout races, unsigned, read-only',folder}));
  assert.deepEqual(downloadFailures,[],'all real browser downloads must complete; captured synthetic Blobs above are diagnostic artifacts only');
}finally{await context.close();await browser.close();}
