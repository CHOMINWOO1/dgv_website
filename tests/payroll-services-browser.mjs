import { installMock } from "./helpers/payroll-browser-mock.mjs";
import { openPayrollView } from "./helpers/payroll-navigation.mjs";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// Only synthetic people, amounts, identifiers and signatures. The browser runs
// actual product scripts; local RPC contract stubs never contact Supabase.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const server=createServer(async(req,res)=>{try{
  const file=path.resolve(root,decodeURIComponent(new URL(req.url,"http://localhost").pathname).replace(/^\/+/,"")||"payroll.html");
  if(!file.startsWith(root+path.sep))throw new Error("Invalid path");
  res.writeHead(200,{"Content-Type":({".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8"})[path.extname(file)]||"application/octet-stream"});res.end(await readFile(file));
}catch{res.writeHead(404);res.end();}});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,channel:process.env.PAYROLL_BROWSER_CHANNEL||"chrome"});
const staff="00000000-0000-4000-8000-000000000001",provider="00000000-0000-4000-8000-000000000003";

function installServicesMock(){
  const state=window.__payrollTest,a=state.db.payroll_employees[0];
  state.db.payroll_employees.push({id:"00000000-0000-4000-8000-000000000003",device_user_id:"SERVICE-DEMO-003",payee_type:"service",name:"DEMO · Electrical contractor",phone:"090-000-0003",active:true});
  state.sensitive["00000000-0000-4000-8000-000000000003"]={national_id:"003-SYNTHETIC-SERVICE-ID",bank_account:"NEVER-PRINT-SERVICE-BANK"};
  state.sensitive[a.id]={national_id:"001-STAFF-PRIVATE-ID"};
  state.db.payroll_runs.push({id:"ordinary-run",employee_id:a.id,month:"2026-10-01",base_amount:240000,allowances:0,deductions:0,total:240000,snapshot:{employee_id:a.id,name:a.name,device_user_id:a.device_user_id,minutes:480,baseAmount:240000,unresolved:0,daily:[]}});
  state.db.payroll_payments.push({id:"ordinary-payment",run_id:"ordinary-run",employee_id:a.id,payroll_month:"2026-10-01",amount:100000,paid_on:"2026-10-20",method:"cash",created_at:"2026-10-20T05:00:00Z"});
  state.db.payroll_service_payment_details=[];
  const client=window.supabase.createClient(),rpc=client.rpc;
  client.rpc=async(name,args)=>{
    if(!["payroll_save_service_provider","payroll_pay_service"].includes(name))return rpc(name,args);
    state.rpcs.push({name,args:structuredClone(args)});
    const fail=message=>({data:null,error:{message}});
    if(state.role!=="admin")return fail("Forbidden");
    if(name==="payroll_save_service_provider"){
      if(args.p_expected_revision!==state.db.payroll_revision[0].version)return fail("PAYROLL_STALE_RELOAD_REQUIRED");
      if(state.failServiceProviderOnce){state.failServiceProviderOnce=false;return fail("Synthetic service provider save failure");}
      const existing=state.db.payroll_employees.find(row=>row.id===args.p_employee_id);
      const value={id:args.p_employee_id,device_user_id:existing?.device_user_id||"SERVICE-"+args.p_employee_id,payee_type:"service",active:existing?.active??true,name:args.p_name,phone:args.p_phone};
      if(existing)Object.assign(existing,value);else state.db.payroll_employees.push(value);
      state.sensitive[args.p_employee_id]={...(state.sensitive[args.p_employee_id]||{}),national_id:args.p_national_id};
      state.db.payroll_revision[0].version++;return {data:args.p_employee_id,error:null};
    }
    const previous=state.db.payroll_payments.find(payment=>payment.request_id===args.p_request_id);
    if(previous)return {data:previous.id,error:null};
    const person=state.db.payroll_employees.find(row=>row.id===args.p_employee_id);
    if(!person||person.payee_type!=="service")return fail("PAYROLL_SERVICE_PROVIDER_REQUIRED");
    const payment={id:crypto.randomUUID(),employee_id:args.p_employee_id,run_id:null,payroll_month:args.p_paid_on.slice(0,7)+"-01",amount:args.p_amount,paid_on:args.p_paid_on,method:args.p_method,reference:args.p_reference,note:"",request_id:args.p_request_id,created_at:new Date().toISOString()};
    state.db.payroll_payments.push(payment);
    state.db.payroll_service_payment_details.push({id:payment.id,payment_id:payment.id,work_from:args.p_work_from,work_to:args.p_work_to,description:args.p_description});
    state.db.payroll_revision[0].version++;
    if(state.loseServicePaymentOnce){state.loseServicePaymentOnce=false;return fail("Synthetic lost service payment response");}
    return {data:payment.id,error:null};
  };
  window.supabase.createClient=()=>client;
}
async function newContext(role="admin"){
  const context=await browser.newContext({viewport:{width:430,height:932},isMobile:true,hasTouch:true});
  await context.addInitScript(()=>{window.print=()=>{window.__printed=true;};});
  await context.route("**/*",route=>{const url=route.request().url();if(url.startsWith("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@"))return route.fulfill({contentType:"text/javascript",body:`(${installMock.toString()})(${JSON.stringify(role)});(${installServicesMock.toString()})();`});if(!url.startsWith(origin))return route.fulfill({body:""});return route.continue();});
  return context;
}
const context=await newContext(),page=await context.newPage(),errors=[];
page.on("pageerror",error=>errors.push(error.message));page.setDefaultTimeout(10000);
const field=(form,name)=>page.locator(`#${form} [name="${name}"]`),idle=()=>page.waitForFunction(()=>!document.getElementById("workspace").disabled);
const submit=async form=>{await page.locator(`#${form} button[type="submit"]`).click();await idle();};
async function sign(name){
  await page.locator("#evidenceDialog").waitFor({state:"visible"});await field("evidenceForm","signed_name").fill(name);
  await page.locator("#signatureCanvas").scrollIntoViewIfNeeded();const box=await page.locator("#signatureCanvas").boundingBox();
  await page.mouse.move(box.x+20,box.y+50);await page.mouse.down();await page.mouse.move(box.x+90,box.y+20,{steps:8});await page.mouse.move(box.x+150,box.y+65,{steps:8});await page.mouse.up();await field("evidenceForm","acknowledged").check();
}
async function capture(filename){
  if(!process.env.PAYROLL_SCREENSHOTS)return;await mkdir(process.env.PAYROLL_SCREENSHOTS,{recursive:true});
  await page.evaluate(()=>{if(!document.getElementById("serviceDemoBanner")){const note=document.createElement("p");note.id="serviceDemoBanner";note.className="notice";note.textContent="예시 · 모든 작업자·지급·신분증은 합성 데이터 / DEMO";document.getElementById("servicesMount").prepend(note);}window.scrollTo({top:0,behavior:"instant"});});
  await page.screenshot({path:path.join(process.env.PAYROLL_SCREENSHOTS,filename),fullPage:true});
}
const serviceAction=(id,action)=>page.locator(`#servicePayees [data-service-action="${action}"][data-service-id="${id}"]`);
async function openPayment(id,{amount,date,from,to,description}){
  await serviceAction(id,"pay").click();await page.locator("#servicePaymentDialog").waitFor({state:"visible"});
  for(const [name,value] of Object.entries({amount:String(amount),paid_on:date,work_from:from,work_to:to,description}))await field("servicePaymentForm",name).fill(value);
}
async function search(from="2026-10-01",to="2026-10-31",id=""){
  for(const [name,value] of [["serviceFrom",from],["serviceTo",to]]){await page.locator("#"+name).fill(value);await page.locator("#"+name).dispatchEvent("change");}
  await page.locator("#serviceEmployee").selectOption(id);await page.locator("#serviceSearch").click();await idle();
}

try{
  for(const role of [null,"manager","staff"]){const denied=await newContext(role),other=await denied.newPage();await other.goto(origin+"/payroll.html#services");await other.locator("#loginModal").waitFor({state:"visible"});assert.equal(await other.locator("#payrollApp").isVisible(),false);assert.equal(await other.evaluate(()=>__payrollTest.calls.some(call=>call.table)),false);await denied.close();}
  await page.goto(origin+"/payroll.html#services");await page.waitForFunction(()=>DGV_PAYROLL_APP.state.loaded);await openPayrollView(page,"services");
  assert.equal(await page.locator("#sharedToolbar").isVisible(),false);
  assert.doesNotMatch(await page.locator("#servicesMount").innerText(),/월 기준|예상 잔액|미지급 잔액/);
  assert.doesNotMatch(await page.locator("#servicesMount").innerText(),/SYNTHETIC-SERVICE-ID|NEVER-PRINT/);
  assert.equal(await page.evaluate(()=>__payrollTest.rpcs.filter(call=>call.name==="payroll_get_sensitive").length),0,"listing external providers does not decrypt identifiers");
  for(const id of ["employeeFilter","paymentEmployee","rangeEmployee"])assert.equal(await page.locator(`#${id} option[value="${provider}"]`).count(),0,"service providers are excluded from payroll selectors");
  assert.equal(await page.locator(`#ledgerBody [data-employee="${provider}"],#staffList article[data-staff-id="${provider}"]`).count(),0,"service providers never become salary rows or employee cards");
  assert.equal(await page.evaluate(id=>DGV_PAYROLL_APP.state.summaries.some(row=>row.employee_id===id),provider),false,"service providers do not acquire attendance or salary summaries");
  const originalStaff=await page.evaluate(()=>({terms:structuredClone(__payrollTest.db.payroll_terms),raw:structuredClone(__payrollTest.db.payroll_attendance_raw),runs:structuredClone(__payrollTest.db.payroll_runs),payment:structuredClone(__payrollTest.db.payroll_payments[0])}));
  await page.locator("#addServicePayee").click();await page.locator("#serviceProviderDialog").waitFor({state:"visible"});
  assert.equal(await field("serviceProviderForm","national_id").getAttribute("autocomplete"),"off");
  assert.equal(await page.locator('#serviceProviderForm [name="device_user_id"],#serviceProviderForm [name="rate"]').count(),0,"external providers do not need a timeclock ID or wage rate");
  await field("serviceProviderForm","name").fill("DEMO · Plumbing service");await field("serviceProviderForm","phone").fill("090-000-0004");await submit("serviceProviderForm");
  assert.equal(await page.evaluate(()=>__payrollTest.rpcs.filter(call=>call.name==="payroll_save_service_provider").length),0,"private identity is required for a new provider");
  await field("serviceProviderForm","national_id").fill("0004-DEMO-SERVICE-ID");await page.evaluate(()=>{__payrollTest.failServiceProviderOnce=true;});await submit("serviceProviderForm");
  assert.equal(await page.locator("#serviceProviderDialog").isVisible(),true);
  assert.equal(await page.evaluate(()=>__payrollTest.db.payroll_employees.filter(e=>e.payee_type==="service").length),1,"failed provider save creates no partial public record");
  await submit("serviceProviderForm");await page.locator("#serviceProviderDialog").waitFor({state:"hidden"});
  const newProvider=await page.evaluate(()=>__payrollTest.db.payroll_employees.find(e=>e.name==="DEMO · Plumbing service").id);
  assert.equal(await page.evaluate(id=>__payrollTest.sensitive[id].national_id,newProvider),"0004-DEMO-SERVICE-ID");
  assert.equal(await field("serviceProviderForm","national_id").inputValue(),"");
  assert.equal(await page.locator(`#employeeFilter option[value="${newProvider}"],#paymentEmployee option[value="${newProvider}"],#rangeEmployee option[value="${newProvider}"],#staffList article[data-staff-id="${newProvider}"]`).count(),0);
  await serviceAction(provider,"edit").click();await page.locator("#serviceProviderDialog").waitFor({state:"visible"});
  assert.equal(await field("serviceProviderForm","national_id").inputValue(),"003-SYNTHETIC-SERVICE-ID");
  await field("serviceProviderForm","phone").fill("090-000-0303");await submit("serviceProviderForm");
  assert.equal(await page.evaluate(id=>__payrollTest.sensitive[id].bank_account,provider),"NEVER-PRINT-SERVICE-BANK","provider identity edits preserve unrelated private keys");
  assert.doesNotMatch(await page.evaluate(()=>JSON.stringify({db:__payrollTest.db,state:DGV_PAYROLL_APP.state,local:{...localStorage},session:{...sessionStorage}})),/003-SYNTHETIC-SERVICE-ID|0004-DEMO-SERVICE-ID|NEVER-PRINT/);

  const work='DEMO · Electrical repair <img src=x onerror="window.__serviceXss=1">';
  await openPayment(provider,{amount:500000,date:"2026-10-20",from:"2026-09-29",to:"2026-10-02",description:work});
  assert.equal(await field("servicePaymentForm","employee_id").locator(`option[value="${staff}"]`).count(),0,"service payment selection never includes ordinary staff");
  assert.equal(await page.locator('#servicePaymentForm [name="hour"],#servicePaymentForm [name="rate"],#servicePaymentForm [name="payroll_month"]').count(),0,"service payouts record money and work dates without fabricating salary conditions");
  await field("servicePaymentForm","work_to").fill("2026-09-28");await submit("servicePaymentForm");
  assert.equal(await page.evaluate(()=>__payrollTest.rpcs.filter(call=>call.name==="payroll_pay_service").length),0);
  await field("servicePaymentForm","work_to").fill("2026-10-02");await page.evaluate(()=>{__payrollTest.loseServicePaymentOnce=true;});await submit("servicePaymentForm");
  assert.equal(await page.locator("#servicePaymentDialog").isVisible(),true);
  assert.equal(await page.evaluate(()=>__payrollTest.db.payroll_service_payment_details.length),1);
  await submit("servicePaymentForm");await page.locator("#evidenceDialog").waitFor({state:"visible"});
  const first=await page.evaluate(()=>structuredClone(__payrollTest.db.payroll_payments.find(p=>p.employee_id==="00000000-0000-4000-8000-000000000003")));
  assert.equal(first.amount,500000);assert.equal(first.run_id,null);assert.equal(first.payroll_month,"2026-10-01");
  assert.equal(await page.evaluate(()=>__payrollTest.db.payroll_service_payment_details.length),1,"lost response replay produces exactly one service payment and detail row");
  const calls=await page.evaluate(()=>__payrollTest.rpcs.filter(call=>call.name==="payroll_pay_service"));assert.equal(calls.length,2);assert.deepEqual(calls[0].args,calls[1].args);
  assert.deepEqual(Object.keys(calls[0].args).sort(),["p_employee_id","p_amount","p_paid_on","p_method","p_reference","p_description","p_work_from","p_work_to","p_request_id"].sort());
  assert.equal(await page.locator("#evidencePaymentSummary").getAttribute("data-payment-id"),first.id);
  assert.match(await page.locator("#evidencePaymentSummary").innerText(),/2026-09-29/);
  assert.doesNotMatch(await page.locator("#evidenceDialog").innerText(),/급여월|Tháng lương|급여 수령|nhận lương/);
  await field("evidenceForm","acknowledged").check();await submit("evidenceForm");
  assert.equal(await page.evaluate(()=>__payrollTest.db.payroll_attachments.length),0,"blank external-service signature cannot be saved");
  await sign("DEMO · Electrical contractor");await page.evaluate(()=>{__payrollTest.failAttachmentOnce=true;});await submit("evidenceForm");
  assert.equal(await page.locator("#evidenceDialog").isVisible(),true);assert.equal(await page.evaluate(()=>__payrollTest.uploads.length),1);
  await submit("evidenceForm");await page.locator("#evidenceDialog").waitFor({state:"hidden"});
  assert.equal(await page.evaluate(()=>__payrollTest.uploads.length),1,"metadata retry reuses the same immutable signature file");
  assert.equal(await page.evaluate(()=>__payrollTest.db.payroll_payments.length),2,"signature retries never create another service payment");
  assert.equal(await page.evaluate(id=>__payrollTest.db.payroll_attachments[0].payment_id,first.id),first.id);
  await search();
  assert.deepEqual(await page.locator("#servicePayments [data-service-payment]").evaluateAll(nodes=>nodes.map(node=>node.dataset.servicePayment)),[first.id]);
  assert.deepEqual(await page.locator("#serviceReceipts tr[data-payment-id]").evaluateAll(nodes=>nodes.map(node=>node.dataset.paymentId)),[first.id]);
  assert.match(await page.locator("#serviceReceipts").innerText(),/003-SYNTHETIC-SERVICE-ID/);assert.match(await page.locator("#serviceReceipts").innerText(),/090-000-0303/);
  assert.match(await page.locator("#serviceReceipts").innerText(),/2026-09-29/);assert.match(await page.locator("#serviceReceipts").innerText(),/2026-10-02/);
  assert.doesNotMatch(await page.locator("#serviceReceipts").innerText(),/001-STAFF-PRIVATE-ID|NEVER-PRINT|미확정|Chưa chốt|급여월/);
  assert.equal(await page.evaluate(()=>window.__serviceXss),undefined);assert.equal(await page.locator("#servicePrint").isEnabled(),true);
  assert.equal(await page.locator("#servicePrint").isVisible(),true);assert.equal(new URL(page.url()).hash,"#services");
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,"service receipt columns and full-resolution signatures must scroll internally without enlarging the mobile page");
  const signatureBox=await page.locator("#serviceReceipts img").boundingBox();assert.ok(signatureBox.width<=120&&signatureBox.height<=48,"service preview uses compact receipt signatures rather than the original canvas size");
  await page.waitForFunction(()=>!DGV_PAYROLL_APP.state.busy&&!document.getElementById("workspace").disabled);
  let popup;
  try{const opened=context.waitForEvent("page",{timeout:12000});opened.catch(()=>{});await page.locator("#servicePrint").click();popup=await opened;}
  catch(error){if(process.env.PAYROLL_SCREENSHOTS)await page.screenshot({path:path.join(process.env.PAYROLL_SCREENSHOTS,"payroll-service-print-debug.png"),fullPage:true});throw error;}
  await popup.waitForFunction(()=>window.__printed===true);await idle();
  assert.match(await popup.locator("body").innerText(),/외주|dịch vụ/i);assert.match(await popup.locator("body").innerText(),/003-SYNTHETIC-SERVICE-ID/);
  assert.equal(await popup.locator('tr[data-payment-id="ordinary-payment"]').count(),0);assert.equal(await popup.evaluate(()=>window.__serviceXss),undefined);
  assert.equal(await popup.locator(`tr[data-payment-id="${first.id}"] img`).count(),1);
  if(process.env.PAYROLL_SCREENSHOTS){await mkdir(process.env.PAYROLL_SCREENSHOTS,{recursive:true});await popup.setViewportSize({width:1123,height:794});await popup.emulateMedia({media:"print"});await popup.evaluate(()=>{const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let text;while(text=walker.nextNode())if(text.nodeValue.includes("<img"))text.nodeValue=text.nodeValue.replace(/<img[^>]*>/g,"").trim();const banner=document.createElement("p");banner.textContent="합성 외주 작업·지급·서명·신분증 / DEMO";document.body.prepend(banner);});await popup.screenshot({path:path.join(process.env.PAYROLL_SCREENSHOTS,"payroll-services-print.png"),fullPage:true});}
  await popup.close();
  if(process.env.PAYROLL_SCREENSHOTS)await page.evaluate(()=>{for(const id of ["servicePayments","serviceReceipts"]){const walker=document.createTreeWalker(document.getElementById(id),NodeFilter.SHOW_TEXT);let text;while(text=walker.nextNode())if(text.nodeValue.includes("<img"))text.nodeValue=text.nodeValue.replace(/<img[^>]*>/g,"").trim();}});
  await capture("payroll-services-mobile.png");
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,"service UI fits a mobile viewport with internal scrolling for receipt columns");

  await openPayment(newProvider,{amount:300000,date:"2026-09-30",from:"2026-10-01",to:"2026-10-03",description:"DEMO · Advance plumbing repair"});await submit("servicePaymentForm");await page.locator("#evidenceDialog").waitFor({state:"visible"});await page.locator("#evidenceForm [data-close]").click();
  const second=await page.evaluate(id=>structuredClone(__payrollTest.db.payroll_payments.find(p=>p.employee_id===id)),newProvider);
  await search("2026-10-01","2026-10-31");assert.equal(await page.locator(`#servicePayments [data-service-payment="${second.id}"]`).count(),0,"October work does not move a September-paid service into October output");
  await search("2026-09-30","2026-09-30",newProvider);assert.equal(await page.locator(`#servicePayments [data-service-payment="${second.id}"]`).count(),1,"paid_on boundaries are inclusive even when work happens in a different month");
  assert.doesNotMatch(await page.locator("#serviceReceipts").innerText(),/003-SYNTHETIC-SERVICE-ID/);assert.match(await page.locator("#serviceReceipts").innerText(),/0004-DEMO-SERVICE-ID/);
  await search();
  const beforeReverse=await page.evaluate(()=>({payments:structuredClone(__payrollTest.db.payroll_payments),details:structuredClone(__payrollTest.db.payroll_service_payment_details),attachments:structuredClone(__payrollTest.db.payroll_attachments),objects:structuredClone(__payrollTest.storageObjects)}));
  await page.locator(`[data-service-reverse="${first.id}"]`).click();await field("serviceReverseForm","reason").fill("DEMO · Entered twice");await submit("serviceReverseForm");
  assert.deepEqual(await page.evaluate(()=>({payments:structuredClone(__payrollTest.db.payroll_payments),details:structuredClone(__payrollTest.db.payroll_service_payment_details),attachments:structuredClone(__payrollTest.db.payroll_attachments),objects:structuredClone(__payrollTest.storageObjects)})),beforeReverse);
  assert.match(await page.locator(`[data-service-payment="${first.id}"]`).innerText(),/취소|Đã hủy/);assert.equal(await page.locator(`#serviceReceipts tr[data-payment-id="${first.id}"]`).count(),0);assert.equal(await page.locator("#servicePrint").isDisabled(),true);
  assert.deepEqual(await page.evaluate(()=>({terms:__payrollTest.db.payroll_terms,raw:__payrollTest.db.payroll_attendance_raw,runs:__payrollTest.db.payroll_runs,payment:__payrollTest.db.payroll_payments.find(p=>p.id==="ordinary-payment")})),originalStaff,"external service payments and reversal never change staff attendance, rates, payroll or payments");
  await openPayrollView(page,"payments");await page.locator("#rangeFrom").fill("2026-09-01");await page.locator("#rangeTo").fill("2026-10-31");await page.locator("#rangeSearch").click();await idle();
  assert.deepEqual(await page.locator("#rangeReceipts tr[data-payment-id]").evaluateAll(nodes=>nodes.map(node=>node.dataset.paymentId)),["ordinary-payment"],"the ordinary payroll receipt excludes both active and reversed external services");

  await openPayrollView(page,"services");await search("2026-09-30","2026-09-30",newProvider);
  await page.evaluate(()=>{__payrollTest.deferSensitiveRead=true;delete __payrollTest.releaseSensitiveRead;});await page.locator("#serviceSearch").click();await page.waitForFunction(()=>typeof __payrollTest.releaseSensitiveRead==="function");
  await page.evaluate(()=>{document.getElementById("serviceTo").value="2026-10-01";document.getElementById("serviceTo").dispatchEvent(new Event("change",{bubbles:true}));__payrollTest.releaseSensitiveRead();});await idle();
  assert.equal(await page.locator("#serviceReceipts").innerText(),"");assert.equal(await page.locator("#servicePrint").isDisabled(),true,"a delayed private lookup cannot populate a changed range");
  await page.evaluate(()=>{__payrollTest.deferSensitiveRead=true;delete __payrollTest.releaseSensitiveRead;});await serviceAction(provider,"edit").click();await page.waitForFunction(()=>typeof __payrollTest.releaseSensitiveRead==="function");
  await page.evaluate(()=>DGV.supabase.auth.signOut());await page.evaluate(()=>__payrollTest.releaseSensitiveRead());await idle();
  assert.equal(await page.locator("#payrollApp").isVisible(),false);assert.equal(await page.locator("#serviceProviderDialog").isVisible(),false);assert.equal(await field("serviceProviderForm","national_id").inputValue(),"");
  assert.deepEqual(errors,[]);
  console.log("Payroll services browser passed: admin-only provider identity, staff/payroll separation, money-only work-period payouts, exact replay, real canvas signature metadata retry, paid-date print with isolated identity, immutable cancellation, mobile fit and stale-scope/logout guards.");
}finally{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
