import { installMock } from "./helpers/payroll-browser-mock.mjs";
import { openPayrollView } from "./helpers/payroll-navigation.mjs";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// Real menu, dialogs, keyboard and mobile layout. Only the remote Supabase
// boundary is replaced with synthetic fixtures; this never contacts production.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const server=createServer(async(req,res)=>{try{
  const file=path.resolve(root,decodeURIComponent(new URL(req.url,"http://localhost").pathname).replace(/^\/+/,"")||"payroll.html");
  if(!file.startsWith(root+path.sep))throw new Error("Invalid path");
  res.writeHead(200,{"Content-Type":({".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8"})[path.extname(file)]||"application/octet-stream"});res.end(await readFile(file));
}catch{res.writeHead(404);res.end();}});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,channel:process.env.PAYROLL_BROWSER_CHANNEL||"chrome"});
const a="00000000-0000-4000-8000-000000000001",b="00000000-0000-4000-8000-000000000002",c="00000000-0000-4000-8000-000000000003",d="00000000-0000-4000-8000-000000000004";
function seedNavigation(){
  const state=window.__payrollTest,[a,b]=state.db.payroll_employees;
  Object.assign(a,{name:"DEMO · Nguyễn An",employment_type:"full_time",employment_status:"active",hire_date:"2026-01-01"});
  Object.assign(b,{name:"DEMO · Trần Bình",employment_type:"part_time",employment_status:"active",hire_date:"2026-01-01"});
  state.db.payroll_employees.push(
    {id:"00000000-0000-4000-8000-000000000003",device_user_id:"ARCHIVED-03",name:"DEMO · Former Chi",active:false,employment_status:"terminated",termination_date:"2026-09-30"},
    {id:"00000000-0000-4000-8000-000000000004",device_user_id:"NEW-04",name:"DEMO · New Dũng",active:true,employment_status:"active",hire_date:"2026-10-01"}
  );
  Object.assign(state.db.payroll_terms[0],{pay_type:"monthly",rate:7000000,monthly_settlement:"monthly_net",weekly_rest_day:0,break_start:"12:00:00",break_end:"14:00:00"});
  state.db.payroll_attendance_raw=state.db.payroll_attendance_raw.filter(row=>row.employee_id!==a.id);
  for(const [i,time,type] of [[1,"10:00:00","in"],[2,"12:00:00","out"],[3,"14:00:00","in"],[4,"20:00:00","out"]])state.db.payroll_attendance_raw.push({id:`split-${i}`,employee_id:a.id,occurred_at:`2026-10-01T${time}`,punch_type:type,source:"kiosk",device_id:"DEMO-TABLET"});
  state.db.payroll_runs=[{id:"frozen-october",employee_id:a.id,month:"2026-10-01",base_amount:7000000,allowances:0,deductions:0,total:7000000,snapshot:{employee_id:a.id,name:a.name,device_user_id:a.device_user_id,minutes:480,baseAmount:7000000,daily:[],unresolved:0},created_at:"2026-11-01T00:00:00Z"}];
  state.db.payroll_payments=[{id:"frozen-payment",run_id:"frozen-october",employee_id:a.id,payroll_month:"2026-10-01",amount:100000,paid_on:"2026-10-15",method:"cash",created_at:"2026-10-15T00:00:00Z"}];
  for(const employee of state.db.payroll_employees)state.sensitive[employee.id]={national_id:`PRIVATE-DO-NOT-LIST-${employee.device_user_id}`};
}
const context=await browser.newContext({viewport:{width:1440,height:1000}});
await context.route("**/*",route=>{const url=route.request().url();if(url.startsWith("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@"))return route.fulfill({contentType:"text/javascript",body:`(${installMock.toString()})("admin");(${seedNavigation.toString()})();`});if(!url.startsWith(origin))return route.fulfill({body:""});return route.continue();});
const page=await context.newPage(),errors=[];page.on("pageerror",error=>errors.push(error.message));page.setDefaultTimeout(10000);
const idle=()=>page.waitForFunction(()=>window.DGV_PAYROLL_APP?.state.loaded&&!DGV_PAYROLL_APP.state.busy);
const field=(form,name)=>page.locator(`#${form} [name="${name}"]`);
const submit=async form=>{await page.locator(`#${form} button[type="submit"]`).click();await idle();};
const card=id=>page.locator(`#staffList article.staff-card[data-staff-id="${id}"]`);
const action=(id,kind)=>page.locator(`#staffList [data-staff-action="${kind}"][data-staff-id="${id}"]`);
async function fit(){assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,"the page must fit the mobile viewport; wide tables scroll inside their own container");}
async function capture(filename){
  if(!process.env.PAYROLL_SCREENSHOTS)return;
  await mkdir(process.env.PAYROLL_SCREENSHOTS,{recursive:true});
  await page.evaluate(async()=>{await document.fonts.ready;if(!document.getElementById("syntheticBanner")){const p=document.createElement("p");p.id="syntheticBanner";p.className="notice";p.textContent="예시 화면 · 모든 직원·급여는 합성 데이터 / DEMO";document.getElementById("payrollApp").prepend(p);}window.scrollTo({top:0,behavior:"instant"});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
  await page.screenshot({path:path.join(process.env.PAYROLL_SCREENSHOTS,filename),fullPage:true,animations:"disabled"});
}

try{
  await page.goto(origin+"/payroll.html#employees");await idle();
  assert.equal(await page.locator("#view-employees").isVisible(),true,"a direct employee-management link opens its own menu");
  await openPayrollView(page,"employees");
  await page.locator('[data-payroll-tab="employees"]').press("ArrowLeft");
  assert.equal(await page.locator('[data-payroll-tab="ledger"]').getAttribute("aria-selected"),"true");
  await page.locator('[data-payroll-tab="ledger"]').press("End");
  assert.equal(await page.locator('[data-payroll-tab="payments"]').getAttribute("aria-selected"),"true");
  await page.locator('[data-payroll-tab="payments"]').press("Home");
  assert.equal(await page.locator('[data-payroll-tab="ledger"]').getAttribute("aria-selected"),"true");
  await openPayrollView(page,"employees");
  await page.locator("#month").fill("2026-10");await page.locator("#month").dispatchEvent("change");await idle();
  assert.equal(await page.locator("#addEmployee").isVisible(),true);
  assert.equal(await page.locator("#employeeFilter").isVisible(),false,"employee management has its own searchable list");
  assert.equal(await page.locator("#advancedSettings").evaluate(node=>node.open),false,"advanced settings do not crowd ordinary employee work");
  assert.equal(await action(c,"info").count(),1,"former employees without a monthly payroll remain manageable");
  assert.equal(await action(d,"info").count(),1,"new employees without terms or payroll history remain manageable");
  assert.doesNotMatch(await page.locator("#staffList").innerText(),/PRIVATE-DO-NOT-LIST/);
  assert.equal(await page.evaluate(()=>__payrollTest.rpcs.filter(row=>row.name==="payroll_get_sensitive").length),0,"listing staff never decrypts identifiers");

  await page.locator("#staffSearch").fill("NEW-04");
  assert.equal(await page.locator('#staffList [data-staff-action="info"]').count(),1);assert.equal(await action(d,"info").count(),1);
  await page.locator("#staffSearch").fill("Former Chi");assert.equal(await action(c,"info").count(),1);
  await page.locator("#staffSearch").fill("");await page.locator("#staffStatus").selectOption("terminated");
  assert.equal(await page.locator('#staffList [data-staff-action="info"]').count(),1);assert.equal(await action(c,"info").count(),1);
  await page.locator("#staffStatus").selectOption("active");assert.equal(await action(c,"info").count(),0);assert.equal(await action(d,"info").count(),1);
  await page.locator("#staffStatus").selectOption("");

  const original=await page.evaluate(()=>({terms:structuredClone(__payrollTest.db.payroll_terms),runs:structuredClone(__payrollTest.db.payroll_runs),payments:structuredClone(__payrollTest.db.payroll_payments)}));
  await action(a,"info").click();await page.locator("#employeeDialog").waitFor({state:"visible"});
  assert.match(await field("employeeForm","national_id").inputValue(),/^PRIVATE-DO-NOT-LIST/);
  await field("employeeForm","name").fill("DEMO · Nguyễn An updated");await field("employeeForm","phone").fill("090-DEMO-0001");await submit("employeeForm");
  assert.equal(await field("employeeForm","national_id").inputValue(),"");
  assert.match(await card(a).innerText(),/Nguyễn An updated/);

  await action(a,"salary").click();await page.locator("#termsDialog").waitFor({state:"visible"});
  assert.equal(await field("termsForm","pay_type").inputValue(),"monthly");assert.equal(await field("termsForm","rate").inputValue(),"7000000");
  assert.equal(await field("termsForm","shift_start").inputValue(),"10:00");assert.equal(await field("termsForm","shift_end").inputValue(),"20:00");
  assert.equal(await field("termsForm","break_start").inputValue(),"12:00");assert.equal(await field("termsForm","break_end").inputValue(),"14:00");
  assert.equal(await field("termsForm","monthly_settlement").inputValue(),"monthly_net");assert.equal(await field("termsForm","weekly_rest_day").inputValue(),"0");
  await field("termsForm","effective_from").fill("2026-11-01");await field("termsForm","pay_type").selectOption("monthly");await field("termsForm","rate").fill("8000000");await submit("termsForm");
  const terms=await page.evaluate(id=>__payrollTest.db.payroll_terms.filter(term=>term.employee_id===id),a);
  assert.equal(terms.length,2);assert.deepEqual(terms[0],original.terms[0]);assert.equal(terms[1].effective_from,"2026-11-01");assert.equal(terms[1].rate,8000000);
  assert.deepEqual(await page.evaluate(()=>__payrollTest.db.payroll_runs),original.runs,"future salary changes cannot rewrite finalized payroll snapshots");
  assert.deepEqual(await page.evaluate(()=>__payrollTest.db.payroll_payments),original.payments);

  // Registration is directly available from its independent menu and the new
  // employee immediately appears in search, even without salary conditions.
  await page.locator("#addEmployee").click();await field("employeeForm","device_user_id").fill("NEW-05");await field("employeeForm","name").fill("DEMO · New Employee E");await field("employeeForm","national_id").fill("000-DEMO-NEW-05");await submit("employeeForm");
  const newId=await page.evaluate(()=>__payrollTest.db.payroll_employees.find(e=>e.device_user_id==="NEW-05").id);
  await page.locator("#staffSearch").fill("NEW-05");assert.equal(await action(newId,"salary").count(),1);
  await page.locator("#staffSearch").fill("");
  await capture("payroll-employees-desktop.png");

  // Changing tabs moves the same detail nodes, preserving a reviewed draft.
  await openPayrollView(page,"ledger");await page.locator("#employeeFilter").selectOption(b);
  await page.locator("#allowances").fill("1234");await page.locator("#adjustmentNote").fill("DEMO unsaved review stays intact");
  const counts=await page.evaluate(()=>({calls:__payrollTest.calls.length,rpcs:__payrollTest.rpcs.length,revision:DGV_PAYROLL_APP.state.revision}));
  for(const view of ["employees","attendance","payments","ledger"]){
    await openPayrollView(page,view);
    assert.equal(await page.locator("#workspaceAlerts").isVisible(),view==="ledger"||view==="payments","payment evidence reminders appear only in payroll and payment workspaces");
  }
  assert.equal(await page.locator("#allowances").inputValue(),"1234");assert.equal(await page.locator("#adjustmentNote").inputValue(),"DEMO unsaved review stays intact");
  assert.equal(await page.locator("#month").inputValue(),"2026-10");assert.equal(await page.locator("#employeeFilter").inputValue(),b);
  assert.deepEqual(await page.evaluate(()=>({calls:__payrollTest.calls.length,rpcs:__payrollTest.rpcs.length,revision:DGV_PAYROLL_APP.state.revision})),counts,"switching menus alone never writes or reloads payroll data");
  assert.equal(await page.locator("#export").isVisible(),true);

  // The team calendar is independent of the selected employee and shows both
  // completed shifts for the same date without losing another worker.
  await openPayrollView(page,"employees");await action(a,"attendance").click();
  assert.equal(new URL(page.url()).hash,"#attendance");await page.locator('[data-team-date="2026-10-01"]').click();
  const teamText=await page.locator("#teamDayRows").innerText();assert.match(teamText,/Nguyễn An updated/);assert.match(teamText,/Trần Bình/);
  assert.match(teamText,/10:00/);assert.match(teamText,/12:00/);assert.match(teamText,/14:00/);assert.match(teamText,/20:00/);
  assert.equal(await page.evaluate(()=>DGV_PAYROLL_APP.state.selected),a);
  await page.locator(`#teamDayRows [data-team-employee="${b}"]`).click();assert.equal(await page.evaluate(()=>DGV_PAYROLL_APP.state.selected),b);
  assert.match(await page.locator("#teamDayRows").innerText(),/Nguyễn An updated/);assert.match(await page.locator("#detailTitle").innerText(),/Trần Bình/);
  assert.equal(await page.locator("#export").isVisible(),false);
  await capture("payroll-team-calendar-desktop.png");

  // Starting a payment uses the explicit employee selector and immediately
  // opens the existing payment/signature flow, without requiring a final run.
  await openPayrollView(page,"payments");await page.locator("#paymentEmployee").selectOption(d);await page.locator("#startPayment").click();
  await page.locator("#paymentDialog").waitFor({state:"visible"});assert.match(await page.locator("#paymentContext").innerText(),/New Dũng/);
  await field("paymentForm","amount").fill("25000");await field("paymentForm","paid_on").fill("2026-10-20");await field("paymentForm","note").fill("DEMO quick payment from menu");await submit("paymentForm");
  await page.locator("#evidenceDialog").waitFor({state:"visible"});
  const paid=await page.evaluate(id=>__payrollTest.db.payroll_payments.find(p=>p.employee_id===id),d);
  assert.equal(paid.run_id,null);assert.equal(paid.amount,25000);assert.equal(await page.locator("#evidencePaymentSummary").getAttribute("data-payment-id"),paid.id);
  await page.locator("#evidenceForm [data-close]").click();
  await page.locator("#paymentEmployee").selectOption("");
  assert.equal(await page.locator("#employeeFilter").inputValue(),"","clearing the payment selection also clears the shared employee filter");
  assert.equal(await page.evaluate(()=>DGV_PAYROLL_APP.state.selected),"");
  assert.equal(await page.locator("#employeeDetail").isVisible(),false);
  assert.equal(await page.locator("#startPayment").isDisabled(),true);

  await page.setViewportSize({width:390,height:844});
  for(const view of ["ledger","attendance","payments","employees"]){await openPayrollView(page,view);await fit();}
  await capture("payroll-employees-mobile.png");
  await page.locator("#staffSearch").fill("NEW-05");await action(newId,"info").click();await page.locator("#employeeDialog").waitFor({state:"visible"});await fit();await page.locator("#employeeForm [data-close]").click();
  await page.waitForFunction(()=>document.querySelector('#employeeForm [name="national_id"]').value==="");
  assert.equal(await field("employeeForm","national_id").inputValue(),"");
  await openPayrollView(page,"attendance");await capture("payroll-team-calendar-mobile.png");
  const duplicates=await page.evaluate(()=>{const seen=new Set();return [...document.querySelectorAll("[id]")].map(node=>node.id).filter(id=>seen.has(id)||!seen.add(id));});assert.deepEqual(duplicates,[],"moving detail nodes never creates duplicate IDs");

  // Existing shared links resolve to the right new menu on a fresh session.
  await page.goto(origin+"/payroll.html#rangePanel");await idle();await page.locator("#view-payments").waitFor({state:"visible"});
  assert.equal(await page.locator('[data-payroll-tab="payments"]').getAttribute("aria-selected"),"true");
  await page.evaluate(()=>DGV.supabase.auth.signOut());assert.equal(await page.locator("#payrollApp").isVisible(),false);
  assert.equal(await field("employeeForm","national_id").inputValue(),"");assert.deepEqual(errors,[]);
  console.log("Payroll navigation passed: independent searchable employee management, status/no-history staff, atomic employee edit, effective-date salary history, preserved finalized amounts, four real tabs/drafts, all-staff split-shift calendar, quick advance/signature flow, mobile layout, private identity cleanup and legacy links.");
}finally{await context.close();await browser.close();await new Promise(resolve=>server.close(resolve));}
