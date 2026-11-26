import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

// All HTML, scripts and data are synthetic and supplied in memory. Never
// contact Supabase, a deployed site, or an administrator's real records.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const source=await readFile(path.join(root,'assets/payroll-break-settings.js'),'utf8');
const appSource=await readFile(path.join(root,'assets/payroll.js'),'utf8');
const extract=(start,end)=>appSource.slice(appSource.indexOf(start),appSource.indexOf(end));
const realFunctions=[extract('  function messageOf(error) {','  async function task(action) {'),extract('  async function task(action) {','  const rows = '),extract('  function openDialog(id) {','  async function employeeDialog(edit) {')].join('\n').replace('location.reload();','window.__breakTest.reloads++;');
const browser=await chromium.launch({headless:true,channel:process.env.PAYROLL_BROWSER_CHANNEL||'chrome'});
const context=await browser.newContext({viewport:{width:1200,height:900}});
const external=[];
await context.route('**/*',route=>{external.push(route.request().url());return route.fulfill({status:403,body:''});});
const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(5000);
await page.setContent('<!doctype html><html lang="ko"><meta charset="utf-8"><body><div id="notice" hidden></div><div id="payrollApp"><fieldset id="workspace"><div id="termsList"></div></fieldset></div></body></html>');
await page.evaluate(()=>{
  const employee={id:'synthetic-full-time',name:'Synthetic Employee',employment_type:'full_time',employment_status:'active',payee_type:'employee'};
  const terms=[{id:'monthly-current',employee_id:employee.id,effective_from:'2026-11-13',pay_type:'monthly',monthly_settlement:'monthly_net',rate:7000000,shift_start:'10:00:00',shift_end:'20:00:00',break_start:'12:00:00',break_end:'14:00:00'},{id:'monthly-history',employee_id:employee.id,effective_from:'2026-11-01',pay_type:'monthly',monthly_settlement:'monthly_net',rate:7000000,shift_start:'10:00:00',shift_end:'20:00:00',break_start:'00:00:00',break_end:'00:00:00'},{id:'hourly-history',employee_id:employee.id,effective_from:'2026-10-01',pay_type:'hourly',rate:25000,shift_start:'10:00:00',shift_end:'20:00:00',break_start:'00:00:00',break_end:'00:00:00'}];
  const protectedData={records:[{id:'raw-preserved',occurred_at:'2026-11-13T20:32:31'}],runs:[{id:'run-preserved',total:5900000,snapshot:{minutes:10894,workedDays:20}}],payments:[{id:'payment-preserved',amount:1700000}],signatures:[{id:'signature-preserved',payment_id:'payment-preserved'}]};
  window.__breakTest={seed:{employee,terms},db:{terms:structuredClone(terms),...protectedData},protectedBefore:JSON.stringify(protectedData),calls:[],events:[],authChecks:0,reloads:0};
});
await page.addScriptTag({content:`(()=>{
  const test=window.__breakTest,$=id=>document.getElementById(id),state={busy:false,loaded:true,selected:test.seed.employee.id,revision:11,employees:[structuredClone(test.seed.employee)],terms:structuredClone(test.seed.terms)};
  const notice=(message,error=false)=>{test.events.push({kind:'notice',message,error});$('notice').textContent=message;$('notice').hidden=!message;};
  const clearAuthenticatedState=()=>{state.loaded=false;test.authCleared=true;document.querySelectorAll('dialog[open]').forEach(dialog=>dialog.close());};
  const DGV={requireAuth:async()=>{test.authChecks++;if(test.authDenied)throw Error('AUTH_REQUIRED');}};
  ${realFunctions}
  const render=()=>{$('termsList').innerHTML=state.terms.filter(term=>term.employee_id===state.selected).slice().sort((a,b)=>b.effective_from.localeCompare(a.effective_from)).slice(0,5).map(term=>'<div class="term-row"><strong>'+term.pay_type+' '+term.rate+'</strong><p>'+term.effective_from+' · '+term.break_start+'–'+term.break_end+'</p></div>').join('');};
  test.reset=()=>{state.busy=false;state.loaded=true;state.selected=test.seed.employee.id;state.revision=11;state.employees=[structuredClone(test.seed.employee)];state.terms=structuredClone(test.seed.terms);test.db.terms=structuredClone(test.seed.terms);test.rpcError=null;test.failLoad=false;test.holdLoad=false;test.badResponse=false;test.authDenied=false;notice('');render();};
  const db={rpc:async(name,args)=>{test.calls.push({name,args:structuredClone(args)});test.events.push({kind:'rpc'});if(test.rpcError)return {error:{message:test.rpcError},data:null};if(test.badResponse)return {data:{},error:null};const term=test.db.terms.find(term=>term.id===args.p_term_id);term.break_start=args.p_break_start;term.break_end=args.p_break_end;return {data:{term:structuredClone(term)},error:null};}};
  const load=async()=>{test.events.push({kind:'load-start'});state.loaded=false;if(test.holdLoad)await new Promise(resolve=>test.releaseLoad=resolve);if(test.failLoad)throw Error('Synthetic refresh failure');state.terms=structuredClone(test.db.terms);state.revision++;state.loaded=true;render();test.events.push({kind:'load-done'});};
  window.DGV_PAYROLL_APP={state,db,$,esc:value=>String(value),field,openDialog,task,result,load,notice};test.render=render;render();
})();`});
await page.addScriptTag({content:source});
const state=()=>page.evaluate(()=>DGV_PAYROLL_APP.state);
const reset=async()=>{await page.evaluate(()=>{document.querySelector('dialog[open]')?.close();__breakTest.reset();});await page.waitForFunction(()=>document.querySelectorAll('[data-break-term]').length===2);};
const open=async(id='monthly-current')=>{await page.locator(`[data-break-term="${id}"]`).click();await page.locator('#payrollBreakDialog').waitFor({state:'visible'});};
const field=name=>page.locator(`#payrollBreakForm [name="${name}"]`);
const valid=async()=>{await field('break_start').fill('00:00');await field('break_end').fill('00:00');await field('reason').fill('  Synthetic administrator break setting  ');await field('confirmed').check();};
const submit=async()=>{await page.locator('#payrollBreakForm button[type=submit]').click();await page.waitForFunction(()=>!DGV_PAYROLL_APP.state.busy);};
const callCount=()=>page.evaluate(()=>__breakTest.calls.length);
try{
  await page.waitForFunction(()=>document.querySelectorAll('[data-break-term]').length===2);
  await page.evaluate(()=>{DGV_PAYROLL_BREAK_SETTINGS.attach();DGV_PAYROLL_BREAK_SETTINGS.attach();document.querySelector('#termsList .term-row p').append(' updated');});
  assert.equal(await page.locator('[data-break-term]').count(),2,'observer and repeated renders never duplicate buttons');
  assert.equal(await page.locator('[data-break-term="hourly-history"]').count(),0,'hourly history has no break-setting button');
  await open('monthly-history');assert.match(await page.locator('#payrollBreakContext').innerText(),/Synthetic Employee.*2026-11-01.*10:00–20:00/);
  assert.equal(await page.locator('#payrollBreakForm [name=effective_from]').count(),0,'effective date is contextual and not editable');
  assert.equal(await field('break_start').inputValue(),'00:00');assert.equal(await field('break_end').inputValue(),'00:00');
  await page.locator('[data-break-close]').click();assert.equal(await page.locator('#payrollBreakDialog').isVisible(),false);
  assert.equal(await page.evaluate(()=>document.activeElement.dataset.breakTerm),'monthly-history','cancel restores invoking button focus');
  await open();await field('reason').fill('discarded');await field('confirmed').check();await page.keyboard.press('Escape');
  await page.locator('#payrollBreakDialog').waitFor({state:'hidden'});assert.equal(await page.evaluate(()=>document.activeElement.dataset.breakTerm),'monthly-current');
  await open();assert.equal(await field('reason').inputValue(),'');assert.equal(await field('confirmed').isChecked(),false);
  const initially=await callCount();await submit();assert.equal(await callCount(),initially,'required reason and confirmation prevent RPC');
  await field('reason').fill('   ');await field('confirmed').check();await submit();assert.equal(await callCount(),initially,'whitespace-only reason prevents RPC');
  assert.match(await page.locator('.dialog-error').innerText(),/설정 사유와 확인/);
  await valid();await field('break_start').fill('');await submit();assert.equal(await callCount(),initially,'empty time prevents RPC');
  await field('break_start').fill('00:00');await field('confirmed').uncheck();await submit();assert.equal(await callCount(),initially);

  for(const revision of [null,undefined,NaN,'11']){
    await reset();await page.evaluate(revision=>DGV_PAYROLL_APP.state.revision=revision,revision);const before=await callCount();
    await page.locator('[data-break-term="monthly-current"]').click();
    assert.equal(await page.locator('#payrollBreakDialog').isVisible(),false,'a missing or invalid revision cannot capture a correction request');
    assert.equal(await callCount(),before);
  }

  for(const change of ['revision','selected','employee','term','loaded']){
    await reset();await open();await valid();const before=await callCount();
    await page.evaluate(change=>{const state=DGV_PAYROLL_APP.state;if(change==='revision')state.revision++;if(change==='selected')state.selected='another-employee';if(change==='employee')state.employees=[];if(change==='term')state.terms[0].break_start='13:00:00';if(change==='loaded')state.loaded=false;},change);
    await submit();assert.equal(await callCount(),before,`${change} changes cancel before any RPC`);assert.match(await page.locator('.dialog-error').innerText(),/근무자료가 변경/);
  }
  for(const [code,expected] of [['PAYROLL_BREAK_FINALIZED',/이미 확정/],['PAYROLL_STALE_RELOAD_REQUIRED',/근무자료가 변경/],['ADMIN_REQUIRED',/관리자 로그인/],['PAYROLL_BREAK_REASON_INVALID',/설정 사유/],['PAYROLL_BREAK_TIME_INVALID',/휴게시간을 확인/],['TERM_NOT_FOUND',/휴게시간을 확인/]]){
    await reset();await open();await valid();await page.evaluate(code=>__breakTest.rpcError=code,code);await submit();
    assert.match(await page.locator('.dialog-error').innerText(),expected);assert.equal(await page.locator('#payrollBreakDialog').isVisible(),true);
  }
  await reset();await open();await valid();await page.evaluate(()=>__breakTest.badResponse=true);await submit();assert.match(await page.locator('.dialog-error').innerText(),/저장 결과를 확인/);

  await reset();await open();await valid();const savedCalls=await callCount();
  await page.evaluate(()=>{__breakTest.holdLoad=true;__breakTest.events=[];});
  await page.locator('#payrollBreakForm button[type=submit]').click();await page.waitForFunction(()=>typeof __breakTest.releaseLoad==='function');
  assert.equal(await page.locator('#payrollBreakDialog').isVisible(),false);assert.equal((await state()).busy,true);
  assert.equal(await page.locator('#workspace').evaluate(element=>element.disabled),true);assert.equal(await page.locator('#payrollApp').getAttribute('aria-busy'),'true');
  assert.equal(await page.evaluate(()=>__breakTest.events.some(event=>event.kind==='notice'&&!event.error)),false,'success notice waits for refresh');
  await page.evaluate(()=>__breakTest.releaseLoad());await page.waitForFunction(()=>!DGV_PAYROLL_APP.state.busy);
  assert.equal(await callCount(),savedCalls+1);
  assert.deepEqual(await page.evaluate(()=>__breakTest.calls.at(-1)),{name:'payroll_correct_term_break',args:{p_term_id:'monthly-current',p_break_start:'00:00',p_break_end:'00:00',p_reason:'Synthetic administrator break setting',p_expected_revision:11}});
  const events=await page.evaluate(()=>__breakTest.events);assert.ok(events.findIndex(event=>event.kind==='load-done')<events.findIndex(event=>event.kind==='notice'));
  assert.match(await page.locator('#notice').innerText(),/휴게시간을 저장/);assert.equal(await page.locator('#workspace').evaluate(element=>element.disabled),false);
  assert.equal(await page.locator('[data-break-term]').count(),2);assert.doesNotMatch(await page.locator('#termsList').innerText(),/정정됨/);

  await reset();await open();await valid();await page.evaluate(()=>__breakTest.failLoad=true);await submit();
  assert.equal(await page.locator('#payrollBreakDialog').isVisible(),false);assert.match(await page.locator('#notice').innerText(),/저장되었습니다.*갱신에 실패/s);
  const failedCount=await callCount();await page.evaluate(()=>document.getElementById('payrollBreakForm').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true})));
  await page.waitForFunction(()=>!DGV_PAYROLL_APP.state.busy);assert.equal(await callCount(),failedCount,'failed reload clears the captured request and cannot resubmit');
  await reset();await open();assert.equal(await field('reason').inputValue(),'');assert.equal(await field('confirmed').isChecked(),false);await page.keyboard.press('Escape');

  for(const change of ['part_time','service','archived']){
    await reset();await page.evaluate(change=>{const employee=DGV_PAYROLL_APP.state.employees[0];if(change==='part_time')employee.employment_type='part_time';if(change==='service')employee.payee_type='service';if(change==='archived')employee.archived_at='2026-11-01';__breakTest.render();},change);
    assert.equal(await page.locator('[data-break-term]').count(),0,`ineligible ${change} does not get a setting button`);
  }
  await reset();await open();await valid();const authCalls=await callCount();await page.evaluate(()=>__breakTest.authDenied=true);await submit();
  assert.equal(await callCount(),authCalls);assert.equal(await page.evaluate(()=>__breakTest.authCleared),true);assert.equal(await page.evaluate(()=>__breakTest.reloads),1,'real task wrapper handles auth expiry before any RPC');
  assert.ok(await page.evaluate(()=>__breakTest.authChecks>10));
  assert.equal(await page.evaluate(()=>JSON.stringify({records:__breakTest.db.records,runs:__breakTest.db.runs,payments:__breakTest.db.payments,signatures:__breakTest.db.signatures})===__breakTest.protectedBefore),true,'attendance originals, finalized runs, payments and signatures never mutate');
  assert.ok((await page.evaluate(()=>__breakTest.calls)).every(call=>call.name==='payroll_correct_term_break'));
  assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
  console.log('Payroll break setting browser passed: normal history buttons, no duplicates, read-only context, validation, captured revision/state guards, mapped errors, exact RPC, refresh-before-notice, failed-refresh retry safety, cancel/Escape/focus, eligibility/auth and preserved financial records.');
}finally{await context.close();await browser.close();}
