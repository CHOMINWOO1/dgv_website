import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {installMock} from './helpers/payroll-browser-mock.mjs';
import {openPayrollView} from './helpers/payroll-navigation.mjs';

// All URLs, including this synthetic HTTPS origin, are fulfilled from local
// source or fixtures. No local server, external network or live DB is used.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const origin='https://payroll.invalid';
const ids={monthly:'00000000-0000-4000-8000-000000000001',zero:'00000000-0000-4000-8000-000000000002',frozen:'00000000-0000-4000-8000-000000000003'};
const expected=Math.round(7000000*13/27);
function seed(){
 const s=window.__payrollTest,[a,b]=s.db.payroll_employees,c={id:'00000000-0000-4000-8000-000000000003',device_user_id:'FROZEN-EXIT'};
 Object.assign(a,{name:'DEMO monthly departure',hire_date:'2026-01-01',employment_type:'full_time',employment_status:'active',payment_method:'cash',payee_type:'employee',active:true});
 Object.assign(b,{name:'DEMO departure without punches',hire_date:'2026-01-01',employment_type:'full_time',employment_status:'terminated',termination_date:'2026-10-15',payment_method:'cash',payee_type:'employee',active:false});
 Object.assign(c,{name:'DEMO frozen salary',hire_date:'2026-01-01',employment_type:'full_time',employment_status:'active',payment_method:'cash',payee_type:'employee',active:true});
 s.db.payroll_employees.push(c);
 for(const e of [a,b,c])s.sensitive[e.id]={national_id:'0000-SYNTHETIC-'+e.device_user_id};
 s.db.payroll_terms=[a,b,c].map((e,i)=>({id:'monthly-exit-'+i,employee_id:e.id,effective_from:'2026-01-01',pay_type:'monthly',rate:i===2?6000000:7000000,monthly_settlement:'monthly_net',weekly_rest_day:0,shift_start:'10:00:00',shift_end:'20:00:00',break_start:'12:00:00',break_end:'14:00:00'}));
 s.db.payroll_attendance_raw=[];
 for(let day=1;day<=15;day++){const date='2026-10-'+String(day).padStart(2,'0');if(new Date(date+'T00:00:00Z').getUTCDay()===0)continue;for(const [i,time] of ['10:00:00','20:00:00'].entries())s.db.payroll_attendance_raw.push({id:'exit-punch-'+date+'-'+i,employee_id:a.id,occurred_at:date+'T'+time,punch_type:i?'out':'in',device_id:'SYNTHETIC'});}
 const snapshot={employee_id:c.id,name:c.name,device_user_id:c.device_user_id,employee:{...c},daily:[],minutes:12960,workedDays:27,baseAmount:6000000,unresolved:0,issues:[],warnings:[],settlementMode:'monthly_net',statutoryAmount:0,monthlyPlannedMinutes:12960,monthlyActualMinutes:12960,monthlyBalanceMinutes:0,monthlyExtraMinutes:0,monthlyExtraAmount:0,monthlyExtraHourlyRate:6000000/216,monthlyExtraBasisAmount:6000000,monthlyExtraBasisMinutes:12960,monthlyExpectedPayDate:'2026-11-05',wageBreakdown:[{code:'monthly_base',category:'base',label:'DEMO frozen monthly wage',amount:6000000,minutes:12960}]};
 s.db.payroll_runs=[{id:'frozen-exit-run',employee_id:c.id,month:'2026-10-01',base_amount:6000000,allowances:0,deductions:0,total:6000000,snapshot,created_at:'2026-11-01T00:00:00Z'}];
 s.db.payroll_payments=[
  {id:'exit-advance',run_id:null,employee_id:a.id,payroll_month:'2026-10-01',amount:1000000,paid_on:'2026-10-10',method:'cash',created_at:'2026-10-10T00:00:00Z'},
  {id:'exit-reversed',run_id:null,employee_id:a.id,payroll_month:'2026-10-01',amount:300000,paid_on:'2026-10-12',method:'cash',created_at:'2026-10-12T00:00:00Z'},
  {id:'previous-salary-month',run_id:null,employee_id:a.id,payroll_month:'2026-09-01',amount:400000,paid_on:'2026-10-05',method:'cash',created_at:'2026-10-05T00:00:00Z'},
  {id:'frozen-exit-payment',run_id:'frozen-exit-run',employee_id:c.id,payroll_month:'2026-10-01',amount:500000,paid_on:'2026-10-20',method:'cash',created_at:'2026-10-20T00:00:00Z'}
 ];
 s.db.payroll_payment_reversals=[{id:'reverse-exit-advance',payment_id:'exit-reversed',reason:'DEMO cancelled duplicate',created_at:'2026-10-13T00:00:00Z'}];
 const canvas=document.createElement('canvas');canvas.width=160;canvas.height=60;const ink=canvas.getContext('2d');ink.strokeStyle='#123';ink.lineWidth=2;ink.beginPath();ink.moveTo(10,40);ink.lineTo(40,15);ink.lineTo(70,45);ink.lineTo(130,20);ink.stroke();
 const bytes=Array.from(atob(canvas.toDataURL('image/png').split(',')[1]),c=>c.charCodeAt(0));
 s.db.payroll_attachments=['exit-advance','frozen-exit-payment'].map(payment_id=>({id:'signature-'+payment_id,payment_id,storage_path:payment_id+'/signature.png',filename:'DEMO-signature.png',mime_type:'image/png',byte_size:bytes.length,evidence_type:'signature',signed_name:'DEMO employee',acknowledged_at:'2026-10-20T00:00:00Z',created_at:'2026-10-20T00:00:00Z'}));
 for(const f of s.db.payroll_attachments)s.storageObjects[f.storage_path]={bytes:[...bytes],mime:'image/png'};
 s.db.payroll_employment_conversions=[];
}

const browser=await chromium.launch({headless:true,channel:process.env.PAYROLL_BROWSER_CHANNEL||'chrome'});
const context=await browser.newContext({viewport:{width:1440,height:1000}});
await context.addInitScript(()=>{const NativeDate=Date,fixed=NativeDate.parse('2026-11-01T05:00:00Z');globalThis.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:[fixed]));}static now(){return fixed;}};window.print=()=>{window.__printed=true;};});
const requests=[];
await context.route('**/*',async route=>{
 const url=route.request().url();requests.push(url);
 if(url.startsWith('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@'))return route.fulfill({contentType:'text/javascript',body:`(${installMock.toString()})('admin');(${seed.toString()})();`});
 if(!url.startsWith(origin+'/'))return route.fulfill({status:200,body:''});
 try{const file=path.resolve(root,decodeURIComponent(new URL(url).pathname).replace(/^\/+/,''));if(!file.startsWith(root+path.sep))throw Error('outside root');return route.fulfill({status:200,contentType:({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'})[path.extname(file)]||'application/octet-stream',body:await readFile(file)});}catch{return route.fulfill({status:404,body:''});}
});
const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(10000);
const idle=()=>page.waitForFunction(()=>window.DGV_PAYROLL_APP?.state.loaded&&!DGV_PAYROLL_APP.state.busy);
const field=(form,name)=>page.locator(`#${form} [name="${name}"]`);
const action=(id,kind)=>page.locator(`#staffList [data-staff-action="${kind}"][data-staff-id="${id}"]`);
const submit=async form=>{await page.locator(`#${form} button[type=submit]`).click();await idle();};
const summary=id=>page.evaluate(id=>structuredClone(DGV_PAYROLL_APP.state.summaries.find(r=>r.employee_id===id)),id);
const financialState=()=>page.evaluate(()=>({runs:structuredClone(__payrollTest.db.payroll_runs),payments:structuredClone(__payrollTest.db.payroll_payments),attachments:structuredClone(__payrollTest.db.payroll_attachments),reversals:structuredClone(__payrollTest.db.payroll_payment_reversals),attendance:structuredClone(__payrollTest.db.payroll_attendance_raw)}));
const refresh=async()=>{await page.locator('#refresh').click();await idle();};
async function select(id){await openPayrollView(page,'ledger');await page.locator('#employeeFilter').selectOption(id);}
async function editExit(id,date){await openPayrollView(page,'employees');await action(id,'info').click();await page.locator('#employeeDialog').waitFor({state:'visible'});await field('employeeForm','employment_status').selectOption('terminated');await field('employeeForm','termination_date').fill(date);await submit('employeeForm');assert.equal(await page.locator('#employeeDialog').isVisible(),false);}
async function balances(paid,remaining){await openPayrollView(page,'payments');const numbers=await page.locator('[data-testid="payment-paid"],[data-testid="payment-remaining"]').allTextContents();assert.deepEqual(numbers.map(x=>Number(x.replace(/[^\d-]/g,''))),[paid,remaining]);}

try{
 await page.goto(origin+'/payroll.html#employees');await idle();await page.locator('#month').fill('2026-10');await page.locator('#month').dispatchEvent('change');await idle();
 const before=await financialState();
 await editExit(ids.monthly,'2026-10-15');
 const employee=await page.evaluate(id=>structuredClone(__payrollTest.db.payroll_employees.find(e=>e.id===id)),ids.monthly);
 assert.equal(employee.employment_status,'terminated');assert.equal(employee.termination_date,'2026-10-15');assert.equal(employee.hire_date,'2026-01-01');assert.equal(employee.active,false);
 assert.deepEqual(await financialState(),before,'saving a termination date changes no wages, payments, signatures, reversals or punches');
 await openPayrollView(page,'ledger');await page.locator('#employeeFilter').selectOption('');
 const zeroInAll=page.locator('#ledgerBody tr').filter({has:page.locator(`[data-employee="${ids.zero}"]`)});
 assert.equal(await zeroInAll.count(),1,'default all-employees ledger must include a terminated monthly employee with a valid unpaid estimate even without punches or payments');
 assert.match(await zeroInAll.innerText(),/DEMO departure without punches/);assert.match(await zeroInAll.innerText(),/3[.,]370[.,]370/);
 const allMetrics=await page.locator('#metrics .metric > strong').allTextContents();
 assert.deepEqual(allMetrics.slice(0,3).map(x=>Number(x.replace(/[^\d-]/g,''))),[expected*2+6000000,1500000,expected*2+4500000],'all-employees wage and unpaid totals include the no-punch terminated employee exactly once');
 await select(ids.monthly);let row=await summary(ids.monthly);
 assert.equal(row.baseAmount,expected);assert.equal(row.compensationUnresolved,0);assert.equal(row.monthlyPlannedMinutes,13*480);assert.equal(row.monthlyActualMinutes,13*480);
 const proration=await page.locator('[data-testid="month-proration"]').innerText();assert.match(proration,/퇴사|재직기간/);assert.match(proration,/2026-10-15/);assert.doesNotMatch(proration,/입사월 비례 기본급/);
 assert.equal(await page.locator('#ledgerBody tr').count(),1);assert.match(await page.locator('#ledgerBody').innerText(),/2[.,]370[.,]370/);
 await balances(1000000,expected-1000000);

 // A terminated fixed-salary employee without punches still has a contractual
 // prorated estimate; inactive filtering must not erase it or invent hours.
 await select(ids.zero);row=await summary(ids.zero);assert.equal(row.baseAmount,expected);assert.equal(row.monthlyActualMinutes,0);assert.equal(row.workedDays,0);assert.equal(row.compensationUnresolved,0);
 assert.match(await page.locator('#ledgerBody').innerText(),/3[.,]370[.,]370/);await balances(0,expected);

 // Finalize through the actual application. The old runless advance remains
 // untouched; linked payments fetched by two query routes must count only once.
 await select(ids.monthly);await page.locator('#finalize').click();await page.locator('#confirmForm input[type=checkbox]').check();await submit('confirmForm');
 const run=await page.evaluate(id=>structuredClone(__payrollTest.db.payroll_runs.find(r=>r.employee_id===id)),ids.monthly);
 assert.equal(run.total,expected);assert.equal(run.snapshot.monthlyProration.terminationDate,'2026-10-15');
 await page.evaluate(({id,runId})=>{__payrollTest.db.payroll_payments.push({id:'exit-linked-after-final',run_id:runId,employee_id:id,payroll_month:'2026-10-01',amount:500000,paid_on:'2026-10-20',method:'bank',reference:'SYNTHETIC',created_at:'2026-10-20T00:00:00Z'});__payrollTest.db.payroll_revision[0].version++;},{id:ids.monthly,runId:run.id});await refresh();
 await balances(1500000,expected-1500000);assert.equal(await page.locator('#paymentArea .payment-card').count(),3,'current month shows advance, reversed item and linked payment only');
 assert.equal(await page.evaluate(()=>__payrollTest.db.payroll_payments.find(p=>p.id==='exit-advance').run_id),null);
 assert.match(await page.locator('[data-payment-card="exit-advance"]').innerText(),/서명 저장됨|Đã lưu chữ ký/);

 // Use the actual export controls but capture exact generated XLSX bytes in
 // this restricted runner instead of asking the OS to save a download.
 await page.evaluate(()=>{window.DGV_XLSX={...DGV_XLSX,downloadWorkbook(options){window.__exitWorkbook={options,bytes:Array.from(DGV_XLSX.buildWorkbookBytes(options))};}};});
 await page.locator('#exportKind').selectOption('ledger');await page.locator('#previewTax').click();await idle();await page.locator('#taxReviewed').check();await page.locator('#downloadTax').click();await idle();
 const workbook=await page.evaluate(()=>window.__exitWorkbook),bytes=Buffer.from(workbook.bytes),xml=bytes.toString();assert.equal(bytes.readUInt32LE(),0x04034b50);assert.match(xml,new RegExp(`<v>${expected}</v>`));assert.match(xml,/<v>1500000<\/v>/);assert.match(xml,new RegExp(`<v>${expected-1500000}</v>`));assert.match(xml,/퇴사|재직기간/);
 const popupEvent=page.waitForEvent('popup');await page.locator('#printTax').click();const popup=await popupEvent;try{await popup.waitForFunction(()=>window.__printed===true);}catch(error){throw Error('Print failed: '+await page.locator('#notice').innerText()+'; '+error.message);}
 const print=await popup.locator('body').innerText();assert.match(print,/DEMO monthly departure/);assert.match(print,/3[.,]370[.,]370/);assert.match(print,/1[.,]000[.,]000/);assert.match(print,/500[.,]000/);await popup.close();await page.locator('#closeTaxPreview').click();

 // Changing later employee metadata and salary inputs cannot rewrite a saved
 // payroll amount, payment or captured signature, even if recalculation differs.
 const preserved=await financialState();
 await editExit(ids.monthly,'2026-10-20');
 await editExit(ids.frozen,'2026-10-15');
 await page.evaluate(id=>{__payrollTest.db.payroll_terms.find(t=>t.employee_id===id).rate=9000000;__payrollTest.db.payroll_revision[0].version++;},ids.frozen);await refresh();
 assert.deepEqual(await financialState(),preserved);
 await select(ids.monthly);assert.match(await page.locator('#ledgerBody').innerText(),/3[.,]370[.,]370/);await balances(1500000,expected-1500000);
 await select(ids.frozen);assert.match(await page.locator('#ledgerBody').innerText(),/6[.,]000[.,]000/);await balances(500000,5500000);
 assert.equal(await page.evaluate(id=>__payrollTest.db.payroll_runs.find(r=>r.employee_id===id).snapshot.monthlyProration,ids.frozen),undefined,'pre-existing finalized snapshot is not backfilled');
 await page.setViewportSize({width:390,height:844});await select(ids.zero);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
 assert.deepEqual(errors,[]);assert.equal(requests.some(url=>/^https?:\/\/127\./.test(url)),false,'no local server is used');
 console.log('Termination browser passed: actual employee exit save, inclusive monthly proration, same-month advance/linked/reversal netting, zero-punch estimate, accurate saved XLSX/print, frozen salaries/payments/signatures and mobile layout; every URL fulfilled offline.');
}finally{await context.close();await browser.close();}
