import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {installMock} from './helpers/payroll-browser-mock.mjs';

// All requests are fulfilled with local source and synthetic fixtures. This test
// never contacts a server or reads/writes a real employee or payroll record.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const origin='https://payroll.invalid';
const a='00000000-0000-4000-8000-000000000001',b='00000000-0000-4000-8000-000000000002';
function seed(){
 const s=window.__payrollTest;
 for(const [index,e] of s.db.payroll_employees.entries())Object.assign(e,{name:index?'DEMO Ledger Beta':'DEMO Ledger Alpha',hire_date:'2026-01-01',employment_type:'full_time',employment_status:'active',payee_type:'employee',active:true});
 s.db.payroll_terms=s.db.payroll_employees.map((e,index)=>({id:'ledger-popup-term-'+index,employee_id:e.id,effective_from:'2026-01-01',pay_type:'monthly',rate:index?5000000:7000000,monthly_settlement:'monthly_net',weekly_rest_day:0,shift_start:'10:00:00',shift_end:'20:00:00',break_start:'12:00:00',break_end:'14:00:00'}));
 s.db.payroll_attendance_raw=[];s.db.payroll_employment_conversions=[];
 s.db.payroll_payments=s.db.payroll_employees.map((e,index)=>({id:'ledger-popup-payment-'+index,employee_id:e.id,payroll_month:'2026-10-01',run_id:null,amount:index?2000000:1000000,paid_on:'2026-10-15',method:'cash',created_at:'2026-10-15T00:00:00Z'}));
}
const browser=await chromium.launch({headless:true,channel:process.env.PAYROLL_BROWSER_CHANNEL||'chrome'});
const context=await browser.newContext({viewport:{width:1440,height:1000}});
await context.addInitScript(()=>{const NativeDate=Date,fixed=NativeDate.parse('2026-11-01T05:00:00Z');globalThis.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:[fixed]));}static now(){return fixed;}};});
await context.route('**/*',async route=>{
 const url=route.request().url();
 if(url.startsWith('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@'))return route.fulfill({contentType:'text/javascript',body:`(${installMock.toString()})('admin');(${seed.toString()})();`});
 if(!url.startsWith(origin+'/'))return route.fulfill({body:''});
 try{const file=path.resolve(root,decodeURIComponent(new URL(url).pathname).replace(/^\/+/ ,''));if(!file.startsWith(root+path.sep))throw Error('outside root');return route.fulfill({contentType:({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'})[path.extname(file)]||'application/octet-stream',body:await readFile(file)});}catch{return route.fulfill({status:404,body:''});}
});
const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(10000);
const idle=()=>page.waitForFunction(()=>window.DGV_PAYROLL_APP?.state.loaded&&!DGV_PAYROLL_APP.state.busy);
const cardAction=id=>page.locator(`#staffList [data-staff-action="ledger"][data-staff-id="${id}"]`);
const financialState=()=>page.evaluate(()=>structuredClone({terms:__payrollTest.db.payroll_terms,payments:__payrollTest.db.payroll_payments,runs:__payrollTest.db.payroll_runs,attachments:__payrollTest.db.payroll_attachments,attendance:__payrollTest.db.payroll_attendance_raw}));
const amounts=async()=> (await page.locator('#staffDetailDialog #metrics .metric > strong').allTextContents()).slice(0,3).map(text=>Number(text.replace(/[^\d-]/g,'')));
async function open(id,name){
 await cardAction(id).click();await page.locator('#staffDetailDialog').waitFor({state:'visible'});
 assert.equal(new URL(page.url()).hash,'#employees','ledger button must not navigate away from employee management');
 assert.equal(await page.locator('[data-payroll-tab=employees]').getAttribute('aria-selected'),'true');
 assert.equal(await page.locator('#employeeFilter').inputValue(),id);
 assert.match(await page.locator('#staffDetailDialogTitle').innerText(),new RegExp(name));
 assert.match(await page.locator('#staffDetailDialogTitle').innerText(),/급여대장|Bảng lương/);
 assert.equal(await page.locator('#staffLedgerOverview #ledgerBody tr').count(),1);
 assert.match(await page.locator('#staffLedgerOverview #ledgerBody').innerText(),new RegExp(name));
 assert.equal(await page.locator('#staffDetailDialog #reviewArea').isVisible(),true);
 assert.equal(await page.locator('#staffLedgerExport').isVisible(),true);
}
async function close(){
 await page.locator('#staffDetailClose').click();await page.locator('#staffDetailDialog').waitFor({state:'hidden'});
 assert.equal(new URL(page.url()).hash,'#employees');
 assert.equal(await page.locator('#metrics').evaluate(node=>node.parentElement.id),'view-ledger');
 assert.equal(await page.locator('#ledgerTitle').evaluate(node=>node.closest('section').parentElement.id),'view-ledger');
 assert.equal(await page.locator('#employeeDetail').evaluate(node=>node.parentElement.getAttribute('data-detail-mount')),'employees');
}
try{
 await page.goto(origin+'/payroll.html#employees');await idle();await page.locator('#month').fill('2026-10');await page.locator('#month').dispatchEvent('change');await idle();
 const before=await financialState();
 await open(a,'DEMO Ledger Alpha');assert.deepEqual(await amounts(),[7000000,1000000,6000000]);
 assert.doesNotMatch(await page.locator('#staffLedgerOverview').innerText(),/DEMO Ledger Beta/);
 // The original editable review is moved rather than copied, so nested
 // confirmation and keyboard cancellation retain their existing behavior.
 await page.locator('#staffDetailDialog #allowances').fill('123');await page.locator('#staffDetailDialog #adjustmentNote').fill('DEMO unsaved popup review');
 assert.match(await page.locator('#staffDetailDialog #draftTotal').innerText(),/7[.,]000[.,]123/);
 await page.locator('#staffDetailDialog #finalize').click();await page.locator('#confirmDialog').waitFor({state:'visible'});
 await page.locator('#confirmForm [data-close]').click();assert.equal(await page.locator('#staffDetailDialog').isVisible(),true);
 assert.equal(await page.locator('#staffDetailDialog #allowances').inputValue(),'123');
 // Returning to the same employee keeps the unsaved review draft intact.
 await close();await open(a,'DEMO Ledger Alpha');
 assert.equal(await page.locator('#staffDetailDialog #allowances').inputValue(),'123');
 assert.equal(await page.locator('#staffDetailDialog #adjustmentNote').inputValue(),'DEMO unsaved popup review');
 assert.match(await page.locator('#staffDetailDialog #draftTotal').innerText(),/7[.,]000[.,]123/);
 // A failed nested confirmation belongs to that confirmation, not the
 // underlying staff popup. Intercept before the synthetic database can write.
 await page.evaluate(()=>{const client=DGV.supabase,original=client.rpc;window.__ledgerFailedAttempts=0;window.__restoreLedgerRpc=()=>{client.rpc=original;};client.rpc=async function(name,args){if(name==='payroll_review'){window.__ledgerFailedAttempts++;return {data:null,error:{message:'Synthetic nested payroll confirmation failure'}};}return original.call(this,name,args);};});
 await page.locator('#staffDetailDialog #finalize').click();await page.locator('#confirmDialog').waitFor({state:'visible'});
 await page.locator('#confirmForm input[type=checkbox]').check();await page.locator('#confirmForm button[type=submit]').click();await idle();
 assert.match(await page.locator('#confirmDialog .dialog-error').innerText(),/Synthetic nested payroll confirmation failure/);
 assert.equal(await page.locator('#staffDetailDialog .dialog-error').count(),0,'RPC errors must remain in the topmost confirmation dialog');
 assert.equal(await page.evaluate(()=>window.__ledgerFailedAttempts),1);
 await page.locator('#confirmForm [data-close]').click();await page.evaluate(()=>window.__restoreLedgerRpc());
 assert.equal(await page.locator('#staffDetailDialog').isVisible(),true);
 // Capture the exact workbook generated by the actual existing export flow.
 await page.evaluate(()=>{window.DGV_XLSX={...DGV_XLSX,downloadWorkbook(options){window.__ledgerPopupWorkbook={options,bytes:Array.from(DGV_XLSX.buildWorkbookBytes(options))};}};});
 await page.locator('#staffLedgerExport').click();await idle();
 const workbook=await page.evaluate(()=>window.__ledgerPopupWorkbook);assert.ok(workbook);assert.equal(Buffer.from(workbook.bytes).readUInt32LE(),0x04034b50);
 const xml=Buffer.from(workbook.bytes).toString();assert.match(xml,/DEMO Ledger Alpha/);assert.doesNotMatch(xml,/DEMO Ledger Beta/);
 assert.equal(await page.locator('#staffDetailDialog').isVisible(),true,'export must not navigate or dismiss the ledger');
 await close();await open(b,'DEMO Ledger Beta');assert.deepEqual(await amounts(),[5000000,2000000,3000000]);
 assert.doesNotMatch(await page.locator('#staffLedgerOverview').innerText(),/DEMO Ledger Alpha/);
 await close();
 // Main ledger tab is still an independent, working full-page view.
 await page.locator('[data-payroll-tab=ledger]').click();await page.locator('#employeeFilter').selectOption('');
 assert.equal(await page.locator('#ledgerBody tr').count(),2);assert.equal(await page.locator('#metrics').isVisible(),true);assert.equal(await page.locator('#staffDetailDialog').isVisible(),false);
 // A ledger row selects its detail without narrowing the All overview. Opening
 // that same employee from management must narrow only the overview, while
 // retaining the unsaved review already being edited for that employee.
 await page.locator(`#ledgerBody [data-employee="${a}"]`).click();
 assert.equal(await page.locator('#employeeFilter').inputValue(),'');
 assert.equal(await page.locator('#ledgerBody tr').count(),2);
 await page.locator('#allowances').fill('321');await page.locator('#adjustmentNote').fill('DEMO draft from full ledger');
 await page.locator('[data-payroll-tab=employees]').click();await open(a,'DEMO Ledger Alpha');
 assert.deepEqual(await amounts(),[7000000,1000000,6000000],'All-ledger selection cannot leak aggregate amounts into an employee popup');
 assert.doesNotMatch(await page.locator('#staffLedgerOverview').innerText(),/DEMO Ledger Beta/);
 assert.equal(await page.locator('#staffDetailDialog #allowances').inputValue(),'321');
 assert.equal(await page.locator('#staffDetailDialog #adjustmentNote').inputValue(),'DEMO draft from full ledger');
 assert.match(await page.locator('#staffDetailDialog #draftTotal').innerText(),/7[.,]000[.,]321/);
 await close();
 await page.locator('[data-payroll-tab=employees]').click();await page.setViewportSize({width:390,height:844});await open(a,'DEMO Ledger Alpha');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'popup tables must scroll inside the mobile viewport');
 const duplicateIds=await page.evaluate(()=>{const seen=new Set();return [...document.querySelectorAll('[id]')].map(n=>n.id).filter(id=>seen.has(id)||!seen.add(id));});assert.deepEqual(duplicateIds,[]);
 assert.deepEqual(await financialState(),before,'opening, export and cancellation never modify payroll data');
 assert.equal(await page.evaluate(()=>__payrollTest.calls.filter(call=>call.operation&&call.operation!=='select').length),0);
 const writeRpcs=await page.evaluate(()=>__payrollTest.rpcs.filter(call=>!['payroll_get_sensitive','payroll_backup'].includes(call.name)));assert.deepEqual(writeRpcs,[],'the flow performs no payroll write RPC');
 await page.evaluate(()=>DGV.supabase.auth.signOut());assert.equal(await page.locator('#staffDetailDialog').isVisible(),false);assert.equal(await page.locator('#payrollApp').isVisible(),false);
 assert.deepEqual(errors,[]);
 console.log('Ledger popup browser passed: no navigation, selected employee overview/review/export, retained same-employee draft, nested confirmation cancel/error scoping, second employee isolation, restored main ledger, no writes, mobile fit and sign-out cleanup.');
}finally{await context.close();await browser.close();}
