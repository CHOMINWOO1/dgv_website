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
    const id=`synthetic-employee-${index}`,employment_type=index<2?'part_time':index<4?'full_time':null;state.db.payroll_employees.push({id,name:names[index],device_user_id:`DEMO-${String(index+1).padStart(3,'0')}`,active:true,payee_type:'employee',employment_type,phone:`090-000-${String(index+1).padStart(4,'0')}`});
    state.sensitive[id]={national_id:`000-DEMO-ID-${String(index+1).padStart(3,'0')}`,bank_account:'PRIVATE-BANK-NEVER-EXPORT'};
    if(employment_type)state.db.payroll_terms.push({id:`terms-${index}`,employee_id:id,effective_from:'2026-09-01',pay_type:employment_type==='part_time'?'hourly':'monthly',rate:employment_type==='part_time'?40000:7000000,monthly_settlement:employment_type==='part_time'?'statutory':'monthly_net',weekly_rest_day:0,shift_start:'10:00:00',shift_end:'20:00:00',break_start:'12:00:00',break_end:'14:00:00'});
    for(const [date,start,end] of [['2026-09-28','10:00:00','12:00:00'],['2026-09-29','14:00:00','17:30:00'],['2026-10-01','09:00:00','11:30:00'],['2026-10-25','14:00:00','18:00:00']]){
      for(const [time,punch_type] of [[start,'in'],[end,'out']])state.db.payroll_attendance_raw.push({id:`punch-${index}-${date}-${punch_type}`,employee_id:id,occurred_at:`${date}T${time}`,punch_type,source:'kiosk',device_id:'SYNTHETIC-TABLET'});
    }
  }
  const amounts=[240000,220000,280000,200000,160000,250000],dates=['03','05','08','11','15','18'],people=[0,1,2,0,3,4];
  for(let index=0;index<6;index++){
    const id=`synthetic-pay-${index}`,employee=state.db.payroll_employees[people[index]],paid_on=`2026-10-${dates[index]}`;
    state.db.payroll_payments.push({id,run_id:null,employee_id:employee.id,payroll_month:index===0||index===3?'2026-09-01':'2026-10-01',paid_on,amount:amounts[index],method:index===5?'bank':'cash',note:'Synthetic payout only'});
    const canvas=document.createElement('canvas');canvas.width=240;canvas.height=80;const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,240,80);ctx.strokeStyle='#19364f';ctx.lineWidth=2.5;ctx.beginPath();ctx.moveTo(12,58);ctx.lineTo(48+index,17);ctx.lineTo(83,61);ctx.lineTo(132+index,22);ctx.lineTo(204,54);ctx.stroke();
    const bytes=Array.from(atob(canvas.toDataURL('image/png').split(',')[1]),char=>char.charCodeAt(0)),storage_path=`${id}/signature.png`;
    state.storageObjects[storage_path]={bytes,mime:'image/png'};
    state.db.payroll_attachments.push({id:`signature-${index}`,payment_id:id,storage_path,mime_type:'image/png',byte_size:bytes.length,evidence_type:'signature',signed_name:`합성 서명 ${index+1}`,acknowledged_at:`${paid_on}T01:02:03Z`});
  }
  state.db.payroll_runs.push({id:'synthetic-finalized-c',employee_id:'synthetic-employee-2',month:'2026-10-01',base_amount:7000000,allowances:120000,deductions:30000,total:7090000,snapshot:{employee_id:'synthetic-employee-2',name:names[2],device_user_id:'DEMO-003',employmentType:'full_time',settlementMode:'monthly_net',minutes:960,monthlyActualMinutes:960,monthlyExtraHourlyRate:7000000/216,baseAmount:7000000,daily:[{date:'2026-10-01',minutes:480},{date:'2026-10-02',minutes:480}],unresolved:0}});
  state.db.payroll_payments.find(payment=>payment.id==='synthetic-pay-2').run_id='synthetic-finalized-c';
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
function paymentRow(files,id){
  const drawing=xml(files,'xl/drawings/drawing1.xml'),anchor=[...drawing.matchAll(/<xdr:oneCellAnchor>[\s\S]*?<\/xdr:oneCellAnchor>/g)].find(match=>match[0].includes(`Payment ${id} · Attachment`));
  assert.ok(anchor,'each payment has its own signature drawing: '+id);return Number(/<xdr:row>(\d+)<\/xdr:row>/.exec(anchor[0])[1])+1;
}
function valueAt(values,column,row){return values.find(cell=>cell.reference===column+row)?.value??null;}
try{
  await mkdir(folder,{recursive:true});
  for(const role of [null,'manager','staff']){
    const denied=await newContext(role),tab=await denied.newPage();await tab.goto(origin+'/payroll.html');await tab.locator('#loginModal').waitFor({state:'visible'});
    assert.equal(await tab.locator('#payrollApp').isVisible(),false);assert.equal(await tab.locator('#rangeReceiptExcel').isVisible(),false);
    assert.equal(await tab.evaluate(()=>__payrollTest.calls.some(call=>call.table)),false);assert.equal(await tab.evaluate(()=>__payrollTest.storageReads.length),0);await denied.close();
  }
  await page.goto(origin+'/payroll.html');await page.waitForFunction(()=>window.DGV_PAYROLL_APP?.state.loaded);await query();
  const baseline=await page.evaluate(()=>({db:JSON.stringify(__payrollTest.db),uploads:__payrollTest.uploads.length}));
  const files=await download('sample-six-payments.xlsx'),sheet=xml(files,'xl/worksheets/sheet1.xml'),all=cells(sheet),money=all.filter(cell=>/^I\d+$/.test(cell.reference)&&cell.type==='n').map(cell=>cell.value);
  assert.ok(money.includes(1350000));for(const amount of [240000,220000,280000,200000,160000,250000])assert.equal(money.filter(value=>value===amount).length,1);
  assert.ok(all.some(cell=>cell.value===1100000),'cash total matches five payments');assert.ok(all.some(cell=>cell.value===250000),'bank total is included');
  for(const text of ['2026-09','000-DEMO-ID-001','090-000-0001','08:02:03'])assert.ok(sheet.includes(text));
  assert.doesNotMatch(sheet,/987654|11111|22222|PRIVATE-BANK|cancelled-never-export/);
  const media=[...files].filter(([name])=>name.startsWith('xl/media/'));assert.equal(media.length,6);
  const text=all.filter(cell=>typeof cell.value==='string').map(cell=>cell.value).join('\n');assert.ok(text.indexOf('파트타임')<text.indexOf('정규직'));assert.ok(text.indexOf('정규직')<text.search(/고용(?:유형|형태) 확인 필요/));
  for(const [index,amount] of [240000,220000,280000,200000,160000,250000].entries()){
    const row=paymentRow(files,`synthetic-pay-${index}`);assert.equal(valueAt(all,'I',row),amount,'all six actual payments retain separate amount and signature rows');
    const expectedDate=Date.parse(`2026-10-${['03','05','08','11','15','18'][index]}T00:00:00Z`)/86400000+25569;assert.equal(valueAt(all,'J',row+1),expectedDate,'every payment keeps its own numeric paid date');
  }
  const first=paymentRow(files,'synthetic-pay-0'),continuation=paymentRow(files,'synthetic-pay-3'),finalized=paymentRow(files,'synthetic-pay-2');
  assert.equal(valueAt(all,'D',first),'5시간 30분\n5 giờ 30 phút');assert.equal(valueAt(all,'E',first),40000);assert.equal(valueAt(all,'F',first),220000,'September full-month hourly wages, paid in October');
  for(const column of ['C','D','E','F','G','H'])assert.equal(valueAt(all,column,continuation),null,'monthly data appears only once across split payments');
  for(const [column,value] of [['F',7000000],['G',120000],['H',30000]])assert.equal(valueAt(all,column,finalized),value,'saved finalized monthly components remain intact');
  assert.equal(valueAt(all,'F',paymentRow(files,'synthetic-pay-5')),'—','unknown wage conditions stay unavailable');
  const originals=await page.evaluate(()=>Object.values(__payrollTest.storageObjects).map(file=>file.bytes));
  for(const original of originals)assert.equal(media.filter(([,actual])=>actual.equals(Buffer.from(original))).length,1);
  assert.equal(await page.locator('#rangeReceipts [data-payment-id]').count(),6,'Excel uses the same six visible payments as print');
  assert.deepEqual(await page.evaluate(()=>({db:JSON.stringify(__payrollTest.db),uploads:__payrollTest.uploads.length})),baseline,'downloading is read-only');
  await page.screenshot({path:path.join(folder,'export-controls.png'),fullPage:true});
  await query('2026-10-03','2026-10-03','synthetic-employee-0');const one=await download('selected-single-payment.xlsx'),oneSheet=xml(one,'xl/worksheets/sheet1.xml');
  assert.equal([...one.keys()].filter(name=>name.startsWith('xl/media/')).length,1);assert.doesNotMatch(oneSheet,/000-DEMO-ID-002|Trần Bình|250000/);assert.match(oneSheet,/2026-09/);
  assert.equal(valueAt(cells(oneSheet),'F',paymentRow(one,'synthetic-pay-0')),220000,'a single paid-date boundary still uses the full salary month');
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
  await page.evaluate(()=>{for(const [index,day] of [[0,'05'],[3,'06']]){const id=`synthetic-pay-${index}`,payment=__payrollTest.db.payroll_payments.find(item=>item.id===id);Object.assign(payment,{paid_on:`2026-11-${day}`,payroll_month:'2026-10-01'});const signature=__payrollTest.db.payroll_attachments.find(item=>item.payment_id===id);if(signature)signature.acknowledged_at=`2026-11-${day}T01:02:03Z`;}__payrollTest.db.payroll_revision[0].version++;});
  await page.locator('#refresh').click();await idle();await query('2026-11-05','2026-11-06','synthetic-employee-0');const nextMonth=await download('cross-month-instalments.xlsx'),nextValues=cells(xml(nextMonth,'xl/worksheets/sheet1.xml'));
  const nextAmount=nextValues.find(cell=>/^I\d+$/.test(cell.reference)&&cell.value===240000),nextRow=Number(nextAmount.reference.slice(1));
  assert.equal(valueAt(nextValues,'D',nextRow),'6시간 30분\n6 giờ 30 phút');assert.equal(valueAt(nextValues,'F',nextRow),260000,'November payments include all October work, including Oct 25');
  assert.equal(valueAt(nextValues,'I',paymentRow(nextMonth,'synthetic-pay-3')),200000);assert.equal(valueAt(nextValues,'F',paymentRow(nextMonth,'synthetic-pay-3')),null);
  assert.equal(await page.evaluate(()=>__payrollTest.calls.some(call=>call.operation!=='select')),false);assert.equal(await page.evaluate(()=>__payrollTest.storageReads.some(read=>read.path?.startsWith('cancelled'))),false);
  count=downloads.length;await deferredRevision();await page.evaluate(()=>DGV_PAYROLL_APP.db.auth.signOut());await page.evaluate(()=>__payrollTest.releaseRead());await idle();
  assert.equal(downloads.length,count,'logout during final revision read blocks private download');assert.equal(await page.locator('#payrollApp').isVisible(),false);assert.equal(await button().isDisabled(),true);assert.equal(await page.locator('#rangeReceipts').innerText(),'');
  await page.reload();await page.waitForFunction(()=>window.DGV_PAYROLL_APP?.state.loaded);await query();
  await page.evaluate(()=>{delete __payrollTest.releaseSensitiveRead;__payrollTest.deferSensitiveRead=true;});await page.locator('#rangeSearch').click();await page.waitForFunction(()=>typeof __payrollTest.releaseSensitiveRead==='function');
  await page.evaluate(()=>DGV_PAYROLL_APP.db.auth.signOut());await page.evaluate(()=>__payrollTest.releaseSensitiveRead());await idle();assert.equal(await button().isDisabled(),true);assert.equal(await page.locator('#rangeReceipts').innerText(),'','late private responses after logout cannot restore Excel access');
  assert.deepEqual(errors,[]);console.log(JSON.stringify({result:downloadFailures.length?'app checks passed; native download failed':'passed',syntheticOnly:true,samplePayments:6,signatures:6,total:1350000,actualDownloads:downloads.length,downloadFailures,checks:'administrator gate, date/employee scope, missing image/private data, revision and logout races, unsigned, read-only',folder}));
  assert.deepEqual(downloadFailures,[],'all real browser downloads must complete; captured synthetic Blobs above are diagnostic artifacts only');
}finally{await context.close();await browser.close();}
