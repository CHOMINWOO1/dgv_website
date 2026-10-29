import { installMock } from "./helpers/payroll-browser-mock.mjs";
import { openPayrollView } from "./helpers/payroll-navigation.mjs";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// All employees, identities and payments below are synthetic. This runs the
// real browser UI against a local RPC contract; the SQL suite tests DB policy.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const server=createServer(async(req,res)=>{try{
  const file=path.resolve(root,decodeURIComponent(new URL(req.url,"http://localhost").pathname).replace(/^\/+/,"")||"payroll.html");
  if(!file.startsWith(root+path.sep))throw new Error("Invalid path");
  res.writeHead(200,{"Content-Type":({".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8"})[path.extname(file)]||"application/octet-stream"});res.end(await readFile(file));
}catch{res.writeHead(404);res.end();}});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,channel:process.env.PAYROLL_BROWSER_CHANNEL||"chrome"});
const employee="00000000-0000-4000-8000-000000000001",empty="00000000-0000-4000-8000-000000000003",stale="00000000-0000-4000-8000-000000000004";

function extendDeleteMock(){
  const state=window.__payrollTest,a=state.db.payroll_employees[0];
  a.name="DEMO · History preserved";a.phone="090-000-0001";
  for(const [id,device,name] of [["00000000-0000-4000-8000-000000000003","DELETE-EMPTY","DEMO · Mistaken registration"],["00000000-0000-4000-8000-000000000004","DELETE-STALE","DEMO · Revision changed"]]){
    state.db.payroll_employees.push({id,device_user_id:device,name,active:device!=="DELETE-STALE",employment_type:"full_time"});
    state.sensitive[id]={national_id:`PRIVATE-${device}`,bank_account:`PRIVATE-BANK-${device}`};
  }
  state.sensitive[a.id]={national_id:"PRIVATE-HISTORY-ID",bank_account:"PRIVATE-HISTORY-BANK"};
  state.db.payroll_runs.push({id:"protected-run",employee_id:a.id,month:"2026-10-01",base_amount:240000,allowances:0,deductions:0,total:240000,snapshot:{employee_id:a.id,name:a.name,device_user_id:a.device_user_id,minutes:480,baseAmount:240000,unresolved:0,daily:[]}});
  state.db.payroll_payments.push({id:"protected-payment",run_id:"protected-run",employee_id:a.id,payroll_month:"2026-10-01",amount:100000,paid_on:"2026-10-20",method:"cash",created_at:"2026-10-20T05:00:00Z",request_id:"protected-request"});
  state.db.payroll_attachments.push({id:"protected-signature",payment_id:"protected-payment",storage_path:"protected-payment/signature.png",filename:"signature.png",mime_type:"image/png",byte_size:99,evidence_type:"signature",signed_name:a.name,acknowledged_at:"2026-10-20T05:01:00Z"});
  state.storageObjects["protected-payment/signature.png"]={bytes:[137,80,78,71,1,2,3],mime:"image/png"};
  const createClient=window.supabase.createClient,client=createClient(),rpc=client.rpc;
  client.rpc=async(name,args)=>{
    if(name!=="payroll_set_employee_archived")return rpc(name,args);
    state.rpcs.push({name,args:structuredClone(args)});
    const fail=message=>({data:null,error:{message}});
    if(state.role!=="admin")return fail("Forbidden");
    if(!args.p_reason?.trim())return fail("PAYROLL_ARCHIVE_REASON_REQUIRED");
    const id=args.p_employee_id,existing=state.db.payroll_employees.find(item=>item.id===id);
    if(!existing)return fail("PAYROLL_EMPLOYEE_NOT_FOUND");
    const previous=state.lastArchiveRequest;
    if(previous&&previous.p_employee_id===id&&previous.p_archived===args.p_archived&&previous.p_reason===args.p_reason)return {data:id,error:null};
    if(args.p_expected_revision!==state.db.payroll_revision[0].version)return fail("PAYROLL_STALE_RELOAD_REQUIRED");
    if(state.failDeleteOnce){state.failDeleteOnce=false;return fail("Synthetic delete failure");}
    if(args.p_archived){existing.archived_previous_active=existing.active;existing.archived_previous_employment_status=existing.employment_status||"active";existing.archived_at=new Date().toISOString();existing.archived_by="test-user";existing.archive_reason=args.p_reason;existing.active=false;existing.employment_status="terminated";}
    else {existing.active=existing.archived_previous_active;existing.employment_status=existing.archived_previous_employment_status;existing.archived_at=null;existing.archived_by=null;existing.archive_reason=null;existing.archived_previous_active=null;existing.archived_previous_employment_status=null;}
    state.db.payroll_audit.push({id:crypto.randomUUID(),table_name:"payroll_employees",record_id:id,action:"UPDATE",reason:args.p_reason});
    state.lastArchiveRequest=structuredClone(args);state.db.payroll_revision[0].version++;
    if(state.loseArchiveReplyOnce){state.loseArchiveReplyOnce=false;return fail("Synthetic lost archive response");}
    if(state.deferArchiveReply){state.deferArchiveReply=false;await new Promise(resolve=>{state.releaseArchiveReply=resolve;});}
    return {data:id,error:null};
  };
  window.supabase.createClient=()=>client;
}
async function newContext(role){
  const context=await browser.newContext({viewport:{width:430,height:932},isMobile:true,hasTouch:true});
  await context.route("**/*",route=>{const url=route.request().url();if(url.startsWith("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@"))return route.fulfill({contentType:"text/javascript",body:`(${installMock.toString()})(${JSON.stringify(role)});(${extendDeleteMock.toString()})();`});if(!url.startsWith(origin))return route.fulfill({body:""});return route.continue();});
  return context;
}
const context=await newContext("admin"),page=await context.newPage(),errors=[];
page.on("pageerror",error=>errors.push(error.message));page.setDefaultTimeout(10000);
const field=(name)=>page.locator(`#deleteEmployeeForm [name="${name}"]`),idle=()=>page.waitForFunction(()=>!document.getElementById("workspace").disabled);
const count=()=>page.evaluate(()=>__payrollTest.rpcs.filter(call=>call.name==="payroll_set_employee_archived").length);
const submit=async()=>{await page.locator("#deleteEmployeeSubmit").click();await idle();};
const refresh=async()=>{await page.locator("#refresh").click();await idle();};
async function openDelete(id,restore=false){await openPayrollView(page,"employees");await page.locator("#staffStatus").selectOption(restore?"archived":"");await page.locator(`article.staff-card [data-staff-action="${restore?"restore":"delete"}"][data-staff-id="${id}"]`).click();await page.locator("#deleteEmployeeDialog").waitFor({state:"visible"});}
async function confirm(reason="DEMO · Incorrect employee registration"){await field("reason").fill(reason);await field("confirmed").check();}
async function protectedData(){return page.evaluate(()=>({terms:structuredClone(__payrollTest.db.payroll_terms),raw:structuredClone(__payrollTest.db.payroll_attendance_raw),runs:structuredClone(__payrollTest.db.payroll_runs),payments:structuredClone(__payrollTest.db.payroll_payments),attachments:structuredClone(__payrollTest.db.payroll_attachments),objects:structuredClone(__payrollTest.storageObjects),sensitive:structuredClone(__payrollTest.sensitive)}));}

try{
  const denied=await newContext("manager"),deniedPage=await denied.newPage();
  await deniedPage.goto(origin+"/payroll.html#employees");await deniedPage.locator("#loginModal").waitFor({state:"visible"});
  assert.equal(await deniedPage.locator("#payrollApp").isVisible(),false);
  assert.equal(await deniedPage.evaluate(()=>__payrollTest.calls.filter(call=>call.table).length),0,"manager sessions never query employee or payroll data");
  assert.equal(await deniedPage.evaluate(()=>__payrollTest.rpcs.some(call=>call.name==="payroll_set_employee_archived")),false);await denied.close();

  await page.goto(origin+"/payroll.html");await page.waitForFunction(()=>DGV_PAYROLL_APP.state.loaded);
  await page.locator("#month").fill("2026-10");await page.locator("#month").dispatchEvent("change");await idle();
  await openDelete(empty);
  assert.match(await page.locator("#deleteEmployeeContext").innerText(),/Mistaken registration/);
  assert.match(await page.locator("#deleteEmployeeContext").innerText(),/DELETE-EMPTY/);
  assert.equal(await field("reason").getAttribute("maxlength"),"1000");
  assert.equal(await field("reason").evaluate(node=>node.required),true);assert.equal(await field("confirmed").evaluate(node=>node.required),true);
  assert.doesNotMatch(await page.locator("#deleteEmployeeDialog").innerText(),/PRIVATE-/);
  await page.locator("#deleteEmployeeForm [data-close]").click();assert.equal(await count(),0,"opening or cancelling deletion does not write");

  await openDelete(empty);await submit();assert.equal(await count(),0,"reason and explicit confirmation are required");
  await field("reason").fill("DEMO · Incorrect employee registration");await submit();assert.equal(await count(),0,"reason alone does not authorize deletion");
  await field("confirmed").check();await page.evaluate(()=>{__payrollTest.failDeleteOnce=true;});await submit();
  assert.equal(await page.locator("#deleteEmployeeDialog").isVisible(),true);
  assert.match(await page.locator("#deleteEmployeeDialog .dialog-error").innerText(),/Synthetic delete failure/);
  assert.equal(await page.evaluate(id=>__payrollTest.db.payroll_employees.some(row=>row.id===id),empty),true);
  assert.equal(await page.evaluate(id=>__payrollTest.sensitive[id].national_id,empty),"PRIVATE-DELETE-EMPTY");
  await submit();await page.locator("#deleteEmployeeDialog").waitFor({state:"hidden"});
  assert.equal(await page.locator(`article.staff-card[data-staff-id="${empty}"]`).count(),0);
  assert.equal(await page.evaluate(id=>__payrollTest.db.payroll_employees.some(row=>row.id===id&&row.archived_at&&row.active===false),empty),true,"list deletion archives the original employee row");
  assert.equal(await page.evaluate(id=>__payrollTest.sensitive[id].national_id,empty),"PRIVATE-DELETE-EMPTY","list deletion preserves the encrypted identifier");
  assert.equal(await page.locator(`#employeeFilter option[value="${empty}"],#paymentEmployee option[value="${empty}"],#rangeEmployee option[value="${empty}"]`).count(),3,"historical employee selectors retain the archived employee");
  const deletion=await page.evaluate(()=>__payrollTest.rpcs.filter(call=>call.name==="payroll_set_employee_archived").at(-1));
  assert.deepEqual(Object.keys(deletion.args).sort(),["p_employee_id","p_archived","p_reason","p_expected_revision"].sort());
  assert.equal(deletion.args.p_employee_id,empty);assert.equal(deletion.args.p_reason,"DEMO · Incorrect employee registration");
  assert.equal(deletion.args.p_archived,true);
  assert.equal(await page.evaluate(()=>__payrollTest.calls.some(call=>call.table==="payroll_employees"&&call.operation!=="select")),false,"deletion uses only its guarded RPC");
  await openDelete(empty,true);assert.equal(await page.locator("#deleteEmployeeForm").getAttribute("data-archived"),"false");
  await confirm("DEMO · Restore mistaken list removal");await submit();await page.locator("#deleteEmployeeDialog").waitFor({state:"hidden"});
  assert.equal(await page.locator("#staffStatus").inputValue(),"","restoration returns to the normal staff list");
  assert.equal(await page.locator(`article.staff-card[data-staff-id="${empty}"]`).count(),1);
  await page.locator("#staffStatus").selectOption("archived");
  assert.equal(await page.locator(`article.staff-card[data-staff-id="${empty}"]`).count(),0,"restored employee is no longer in the archived-only list");
  assert.equal(await page.evaluate(id=>__payrollTest.db.payroll_employees.find(row=>row.id===id).active,empty),true,"restoration restores the prior active state");

  // New server activity must not let a dialog delete using stale assumptions.
  await openDelete(stale);await confirm();await page.evaluate(()=>{__payrollTest.db.payroll_revision[0].version++;});await submit();
  assert.equal(await page.locator("#deleteEmployeeDialog").isVisible(),true);
  assert.match(await page.locator("#deleteEmployeeDialog .dialog-error").innerText(),/새로고침|tải lại/i);
  assert.equal(await page.evaluate(id=>__payrollTest.db.payroll_employees.some(row=>row.id===id),stale),true);
  await page.locator("#deleteEmployeeForm [data-close]").click();await refresh();
  await openDelete(stale);await confirm();await submit();await page.locator("#deleteEmployeeDialog").waitFor({state:"hidden"});
  await openDelete(stale,true);await confirm("DEMO · Restore previously inactive employee");await submit();await page.locator("#deleteEmployeeDialog").waitFor({state:"hidden"});
  assert.equal(await page.evaluate(id=>__payrollTest.db.payroll_employees.find(row=>row.id===id).active,stale),false,"restoring a previously inactive employee must not reactivate them");

  const before=await protectedData();await openDelete(employee);await confirm();await page.evaluate(()=>{__payrollTest.loseArchiveReplyOnce=true;});await submit();
  assert.equal(await page.locator("#deleteEmployeeDialog").isVisible(),true);
  const committed=await page.evaluate(()=>({revision:__payrollTest.db.payroll_revision[0].version,audits:__payrollTest.db.payroll_audit.length,args:__payrollTest.rpcs.filter(call=>call.name==="payroll_set_employee_archived").at(-1).args}));
  await submit();
  await page.locator("#deleteEmployeeDialog").waitFor({state:"hidden"});
  assert.deepEqual(await page.evaluate(()=>({revision:__payrollTest.db.payroll_revision[0].version,audits:__payrollTest.db.payroll_audit.length,args:__payrollTest.rpcs.filter(call=>call.name==="payroll_set_employee_archived").at(-1).args})),committed,"lost successful archive response retries the same operation without another audit or revision");
  assert.equal(await page.locator(`article.staff-card[data-staff-id="${employee}"]`).count(),0);
  assert.deepEqual(await protectedData(),before,"archiving preserves terms, raw punches, finalized pay, original payment, signature bytes and all private identity fields");
  await page.locator("#staffStatus").selectOption("archived");
  assert.equal(await page.locator(`article.staff-card[data-staff-id="${employee}"] [data-staff-action="restore"]`).count(),1);
  assert.equal(await page.locator(`article.staff-card[data-staff-id="${employee}"] [data-staff-action="info"],article.staff-card[data-staff-id="${employee}"] [data-staff-action="salary"],article.staff-card[data-staff-id="${employee}"] [data-staff-action="pay"]`).count(),0,"archived employee cards offer historical viewing rather than new registration actions");
  if(process.env.PAYROLL_SCREENSHOTS){await mkdir(process.env.PAYROLL_SCREENSHOTS,{recursive:true});await page.evaluate(()=>{const note=document.createElement("p");note.className="notice";note.textContent="합성 직원 목록 삭제 · 이력 보존 확인 / DEMO";document.querySelector("#staffList").prepend(note);});await page.locator("#staffList").screenshot({path:path.join(process.env.PAYROLL_SCREENSHOTS,"payroll-employee-archived.png")});}

  // A mistaken completed payment is reversed, while its signed original stays.
  await page.locator(`article.staff-card[data-staff-id="${employee}"] [data-staff-action="history"]`).click();
  assert.equal(await page.locator("#view-payments").isVisible(),true);
  assert.equal(await page.locator("#paymentDialog").isVisible(),false,"history navigation does not start a new payment");
  for(const id of ["startPayment","addPayment","editEmployee","addTerms"])assert.equal(await page.locator("#"+id).isDisabled(),true,`${id} does not add or change data for an archived employee`);
  assert.match(await page.locator('[data-testid="payment-paid"]').innerText(),/100[.,]000/);
  assert.match(await page.locator('[data-testid="payment-remaining"]').innerText(),/140[.,]000/);
  await page.locator('[data-reverse="protected-payment"]').click();
  await page.locator('#amendForm button[type="submit"]').click();await idle();
  assert.equal(await page.evaluate(()=>__payrollTest.db.payroll_payment_reversals.length),0,"payment reversal requires its own reason");
  await page.locator('#amendForm [name="reason"]').fill("DEMO · Payment entered in error");await page.locator('#amendForm button[type="submit"]').click();await idle();
  assert.deepEqual(await protectedData(),before,"reversal keeps the original paid amount, signature, attendance and private identity intact");
  assert.equal(await page.evaluate(()=>__payrollTest.db.payroll_payment_reversals.length),1);
  assert.match(await page.locator('[data-payment-card="protected-payment"]').innerText(),/취소|Đã hủy/);
  assert.equal(await page.locator('[data-signature="protected-payment"]').count(),0,"a cancelled payment cannot accept a new receipt signature");
  assert.match(await page.locator('[data-testid="payment-remaining"]').innerText(),/240[.,]000/);
  await page.locator("#rangeFrom").fill("2026-10-01");await page.locator("#rangeTo").fill("2026-10-31");await page.locator("#rangeEmployee").selectOption(employee);await page.locator("#rangeSearch").click();await idle();
  assert.equal(await page.locator('#rangeReceipts [data-payment-id="protected-payment"]').count(),0,"reversed payment is excluded from receipt output");
  assert.equal(await page.locator("#rangeReceiptPrint").isDisabled(),true);
  assert.equal(await page.evaluate(()=>__payrollTest.storageReads.length),0,"cancelled signature stays stored without being fetched for output");
  assert.equal(await page.evaluate(()=>__payrollTest.rpcs.some(call=>call.name==="payroll_get_sensitive")),false,"deletion or cancelled-only receipts never request private identity");
  await page.reload();await page.waitForFunction(()=>DGV_PAYROLL_APP.state.loaded);await openDelete(empty);await confirm();
  await page.evaluate(()=>{__payrollTest.deferArchiveReply=true;});await page.locator("#deleteEmployeeSubmit").click();await page.waitForFunction(()=>typeof __payrollTest.releaseArchiveReply==="function");
  await page.evaluate(()=>DGV_PAYROLL_APP.db.auth.signOut());await page.evaluate(()=>__payrollTest.releaseArchiveReply());await idle();
  assert.equal(await page.locator("#payrollApp").isVisible(),false);assert.equal(await page.locator("#deleteEmployeeDialog").isVisible(),false);
  assert.equal(await field("reason").inputValue(),"");assert.equal(await page.locator("#deleteEmployeeForm").getAttribute("data-employee-id"),null,"logout clears the bound destructive action target");
  assert.deepEqual(errors,[]);
  console.log("Employee delete browser passed: admin-only list archive/restore, required reason/confirmation, safe retry and stale refusal, prior active state restoration, private/payroll/attendance/signature preservation, payment reversal and restored balance with receipt exclusion.");
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
