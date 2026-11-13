import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {installMock} from './helpers/payroll-browser-mock.mjs';

// Fully intercepted synthetic origin: no server, production request, credentials
// or real employee data. Suitable for runners with network access disabled.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const origin='https://payroll.invalid';
function seed(){
 const s=window.__payrollTest,[missing,known]=s.db.payroll_employees;
 Object.assign(missing,{name:'DEMO missing hire',employment_type:'part_time',employment_status:'active',payee_type:'employee',hire_date:null});
 Object.assign(known,{name:'DEMO known hire',employment_type:'part_time',employment_status:'active',payee_type:'employee',hire_date:'2026-11-01'});
 for(const term of s.db.payroll_terms)Object.assign(term,{effective_from:'2026-11-01',rate:25000,monthly_settlement:'statutory',break_start:'00:00',break_end:'00:00',weekly_rest_day:0});
 s.db.payroll_attendance_raw=[];s.db.payroll_employment_conversions=[];
 s.db.payroll_payments=[{id:'preserved-demo-payment',employee_id:missing.id,payroll_month:'2026-11-01',run_id:null,amount:160000,paid_on:'2026-11-10',method:'cash'}];
 const client=window.supabase.createClient(),original=client.rpc;
 client.rpc=async(name,args)=>{
  if(!['payroll_conversion_candidate','payroll_convert_employment'].includes(name))return original(name,args);
  s.rpcs.push({name,args:structuredClone(args)});
  const e=s.db.payroll_employees.find(row=>row.id===args.p_employee_id);
  const fail=message=>({data:null,error:{message}});
  if(name==='payroll_conversion_candidate'){
   if(s.failConversionCandidate)return fail('PAYROLL_CONVERSION_HIRE_DATE_REQUIRED');
   return {data:{employee_id:e.id,name:e.name,original_hire_date:e.hire_date,prior_employment_type:e.employment_type,repair:false,term:s.db.payroll_terms.filter(t=>t.employee_id===e.id).sort((a,b)=>a.effective_from.localeCompare(b.effective_from)).at(-1)},error:null};
  }
  if(args.p_expected_revision!==s.db.payroll_revision[0].version)return fail('PAYROLL_STALE_RELOAD_REQUIRED');
  const {original_hire_date,...terms}=args.p_terms;
  if(!e.hire_date&&!original_hire_date)return fail('PAYROLL_CONVERSION_HIRE_DATE_REQUIRED');
  if(e.hire_date&&original_hire_date&&e.hire_date!==original_hire_date)return fail('PAYROLL_CONVERSION_INVALID');
  const term={id:crypto.randomUUID(),employee_id:e.id,...terms,pay_type:args.p_employment_type==='full_time'?'monthly':'hourly',monthly_settlement:args.p_employment_type==='full_time'?'monthly_net':'statutory'};
  const row={id:crypto.randomUUID(),employee_id:e.id,original_hire_date:e.hire_date||original_hire_date,prior_employment_type:e.employment_type,employment_type:args.p_employment_type,effective_from:term.effective_from,prior_salary_amount:args.p_prior_salary_amount,term_id:term.id};
  s.db.payroll_terms.push(term);s.db.payroll_employment_conversions.push(row);e.hire_date=row.original_hire_date;e.employment_type=row.employment_type;s.db.payroll_revision[0].version++;
  return {data:row.id,error:null};
 };
}
const browser=await chromium.launch({headless:true,channel:process.env.PAYROLL_BROWSER_CHANNEL||'chrome'});
const context=await browser.newContext({viewport:{width:1440,height:900}});
await context.route('**/*',async route=>{
 const url=route.request().url();
 if(url.startsWith('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@'))return route.fulfill({contentType:'text/javascript',body:`(${installMock.toString()})('admin');(${seed.toString()})();`});
 if(new URL(url).origin!==origin)return route.fulfill({body:''});
 try{const file=path.resolve(root,decodeURIComponent(new URL(url).pathname).replace(/^\+|^\/+/,''));if(!file.startsWith(root+path.sep))throw Error('path');const body=await readFile(file);return route.fulfill({body,contentType:({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'})[path.extname(file)]||'application/octet-stream'});}catch{return route.fulfill({status:404,body:''});}
});
const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
page.setDefaultTimeout(10000);
const idle=()=>page.waitForFunction(()=>window.DGV_PAYROLL_APP?.state.loaded&&!DGV_PAYROLL_APP.state.busy);
const action=(id,kind)=>page.locator(`#staffList [data-staff-action="${kind}"][data-staff-id="${id}"]`);
const field=name=>page.locator(`#employmentConversionForm [name="${name}"]`);
const calls=()=>page.evaluate(()=>__payrollTest.rpcs.filter(r=>r.name==='payroll_convert_employment'));
const fillNewTerms=async()=>{await field('effective_from').fill('2026-11-13');await field('rate').fill('7000000');await field('reason').fill('DEMO conversion with confirmed hire date');await field('confirmed').check();};
try{
 await page.goto(origin+'/payroll.html#employees');await idle();await page.locator('#month').fill('2026-11');await page.locator('#month').dispatchEvent('change');await idle();
 const [missing,known]=await page.evaluate(()=>__payrollTest.db.payroll_employees.map(e=>e.id));
 const originalPayments=await page.evaluate(()=>structuredClone(__payrollTest.db.payroll_payments));
 await action(missing,'convert').click();await page.locator('#employmentConversionDialog').waitFor({state:'visible'});await idle();
 assert.equal(await field('original_hire_date').inputValue(),'','missing original hire date is never guessed from a term or attendance');
 assert.equal(await field('original_hire_date').getAttribute('required'),'');
 assert.equal(await field('original_hire_date').getAttribute('readonly'),null);
 assert.match(await page.locator('#employmentConversionTitle').innerText(),/정규직 전환/);
 await fillNewTerms();await page.locator('#employmentConversionForm button[type=submit]').click();
 assert.equal((await calls()).length,0,'a blank original hire date cannot submit a conversion');
 assert.equal(await page.locator('#employmentConversionDialog').isVisible(),true);
 await field('original_hire_date').fill('2026-11-03');await page.locator('#employmentConversionForm button[type=submit]').click();await idle();
 assert.equal(await page.locator('#employmentConversionDialog').isVisible(),false);
 const first=(await calls())[0];assert.equal(first.args.p_terms.original_hire_date,'2026-11-03');assert.equal(first.args.p_terms.effective_from,'2026-11-13');assert.equal(first.args.p_terms.rate,7000000);
 assert.equal(await page.evaluate(id=>__payrollTest.db.payroll_employees.find(e=>e.id===id).hire_date,missing),'2026-11-03');
 assert.deepEqual(await page.evaluate(()=>__payrollTest.db.payroll_payments),originalPayments);
 await action(known,'convert').click();await page.locator('#employmentConversionDialog').waitFor({state:'visible'});await idle();
 if(await field('original_hire_date').count()){
  const editable=await field('original_hire_date').isVisible()&&await field('original_hire_date').isEditable();
  assert.equal(editable,false,'an already stored hire date cannot be edited through conversion');
 }
 await fillNewTerms();await page.locator('#employmentConversionForm button[type=submit]').click();await idle();
 const second=(await calls())[1];assert.equal(Object.hasOwn(second.args.p_terms,'original_hire_date'),false,'existing original date is preserved without a replacement payload');
 assert.equal(await page.evaluate(id=>__payrollTest.db.payroll_employees.find(e=>e.id===id).hire_date,known),'2026-11-01');
 assert.deepEqual(await page.evaluate(()=>__payrollTest.db.payroll_payments),originalPayments);
 await page.evaluate(()=>{__payrollTest.failConversionCandidate=true;});await action(known,'convert').click();await idle();
 assert.equal(await page.locator('#employmentConversionDialog').isVisible(),true,'candidate failures keep a visible dialog rather than an off-screen notice');
 const error=page.locator('#employmentConversionDialog .dialog-error');assert.equal(await error.isVisible(),true);assert.ok((await error.innerText()).trim());
 assert.equal((await calls()).length,2,'a failed candidate does not save or modify payroll');
 assert.deepEqual(errors,[]);
 console.log('Missing-hire conversion browser passed: visible dialog, explicit required original hire, preserved known dates, unchanged terms input/payment history, and visible candidate failure.');
}finally{await context.close();await browser.close();}
