import { installMock } from "./helpers/payroll-browser-mock.mjs";
import { openPayrollView } from "./helpers/payroll-navigation.mjs";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// Actual payroll UI/calculation with synthetic attendance. Only the remote
// Supabase boundary and the clock are replaced; nothing reaches production.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const server=createServer(async(req,res)=>{try{
  const file=path.resolve(root,decodeURIComponent(new URL(req.url,"http://localhost").pathname).replace(/^\/+/,"")||"payroll.html");if(!file.startsWith(root+path.sep))throw new Error("Invalid path");
  res.writeHead(200,{"Content-Type":({".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8"})[path.extname(file)]||"application/octet-stream"});res.end(await readFile(file));
}catch{res.writeHead(404);res.end();}});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,channel:process.env.PAYROLL_BROWSER_CHANNEL||"chrome"});
const context=await browser.newContext({viewport:{width:1280,height:1000}}),page=await context.newPage(),errors=[];
const noTerms="00000000-0000-4000-8000-000000000001",hourly="00000000-0000-4000-8000-000000000002",monthly="00000000-0000-4000-8000-000000000003";
function seedAutoAttendance(){
  const state=window.__payrollTest,[a,b]=state.db.payroll_employees,c={id:"00000000-0000-4000-8000-000000000003",device_user_id:"MONTHLY",name:"DEMO · Monthly C",active:true};
  a.name="DEMO · Terms pending A";b.name="DEMO · Hourly B";state.db.payroll_employees.push(c);
  const standard={effective_from:"2026-01-01",shift_start:"10:00:00",shift_end:"20:00:00",break_start:"12:00:00",break_end:"14:00:00"};
  state.db.payroll_terms=[{...standard,id:"hourly-term",employee_id:b.id,pay_type:"hourly",rate:30000},{...standard,id:"monthly-term",employee_id:c.id,pay_type:"monthly",monthly_settlement:"monthly_net",rate:7000000,weekly_rest_day:0}];
  let next=0;const punch=(employee_id,occurred_at,punch_type)=>({id:`auto-${++next}`,employee_id,occurred_at,punch_type,source:"kiosk",device_id:"TEST-TABLET"});
  state.db.payroll_attendance_raw=[
    punch(a.id,"2026-10-29T11:32:34","in"),punch(a.id,"2026-10-29T11:34:18","out"),punch(a.id,"2026-10-29T14:13:00","in"),
    punch(b.id,"2026-10-28T10:00:00","in"),punch(b.id,"2026-10-28T10:02:00","out"),
    punch(c.id,"2026-10-28T11:32:30","in"),punch(c.id,"2026-10-28T11:34:00","out"),punch(c.id,"2026-10-29T11:32:00","in"),punch(c.id,"2026-10-29T11:32:30","out")
  ];
}
await context.addInitScript(()=>{
  const NativeDate=Date,fixed=NativeDate.parse("2026-10-29T10:00:00Z");globalThis.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:[fixed]));}static now(){return fixed;}};
  const original=window.setInterval.bind(window);window.__automaticPayrollPolls=[];
  window.setInterval=(fn,delay,...args)=>{if(delay===30000){window.__automaticPayrollPolls.push(()=>fn(...args));return original(fn,2147483647,...args);}return original(fn,delay,...args);};
});
await context.route("**/*",route=>{const url=route.request().url();if(url.startsWith("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@"))return route.fulfill({contentType:"text/javascript",body:`(${installMock.toString()})("admin");(${seedAutoAttendance.toString()})();`});if(!url.startsWith(origin))return route.fulfill({body:""});return route.continue();});
page.on("pageerror",error=>errors.push(error.message));page.setDefaultTimeout(10000);
const idle=()=>page.waitForFunction(()=>DGV_PAYROLL_APP.state.loaded&&!DGV_PAYROLL_APP.state.busy);
const summary=id=>page.evaluate(id=>structuredClone(DGV_PAYROLL_APP.state.summaries.find(row=>row.employee_id===id)),id);
const select=async(id,view="attendance")=>{await openPayrollView(page,"ledger");await page.locator("#employeeFilter").selectOption(id);await openPayrollView(page,view);await page.locator("h1").click();};
const field=(form,name)=>page.locator(`#${form} [name="${name}"]`);
const submit=async form=>{await page.locator(`#${form} button[type="submit"]`).click();await idle();};
const poll=()=>page.evaluate(async()=>{for(const callback of __automaticPayrollPolls)await callback();});
async function screenshot(name,selector){if(!process.env.PAYROLL_SCREENSHOTS)return;await mkdir(process.env.PAYROLL_SCREENSHOTS,{recursive:true});await page.evaluate(async selector=>{const label=document.createElement("p");label.className="notice";label.textContent="자동 근무 계산 예시 · 합성 직원·기록 / DEMO";const element=document.querySelector(selector);element.prepend(label);await document.fonts.ready;element.scrollIntoView({behavior:"instant",block:"center"});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));},selector);await page.locator(selector).screenshot({path:path.join(process.env.PAYROLL_SCREENSHOTS,name),animations:"disabled"});}

try{
  await page.goto(origin+"/payroll.html");await idle();assert.equal(await page.locator("#month").inputValue(),"2026-10");
  await select(noTerms);let row=await summary(noTerms),day=row.daily.find(day=>day.date==="2026-10-29");
  assert.equal(row.minutes,1,"104 seconds are automatically recognized as one completed minute");assert.equal(day.actualSeconds,104);assert.equal(day.attendanceStatus,"in_progress");assert.equal(day.isOpen,true);assert.equal(day.openCheckIn,"2026-10-29T14:13:00");
  assert.equal(row.baseAmount,null,"attendance recognition must not invent a missing wage rate");assert.ok(row.unresolved>0);assert.equal(day.attendanceDefaultUsed,true);
  assert.equal(await page.locator("#rawAttendanceRows tr").count(),3);assert.match(await page.locator('[data-testid="auto-attendance-minutes"]').innerText(),/0h 1m/);
  assert.match(await page.locator("#autoAttendanceSummary").innerText(),/자동|Tự/);assert.doesNotMatch(await page.locator("#rawAttendanceSummary").innerText(),/5분 미만.*확인/);
  await screenshot("payroll-auto-attendance-pending.png","#autoAttendanceSummary");

  await select(monthly);row=await summary(monthly);
  assert.equal(row.monthlyActualMinutes,2,"monthly seconds carry: a 90-second day plus a 30-second day produce two minutes");
  assert.equal(row.minutes,2);assert.equal(row.daily.filter(d=>d.workIntervals?.length).reduce((sum,d)=>sum+d.actualSeconds,0),120);
  assert.equal(row.baseAmount,7000000,"short valid attendance preserves the monthly base salary");assert.equal(row.monthlyExtraAmount,0);
  assert.match(await page.locator('[data-testid="auto-attendance-minutes"]').innerText(),/0h 2m/);

  await select(hourly);row=await summary(hourly);day=row.daily.find(day=>day.date==="2026-10-28");
  assert.equal(row.minutes,2);assert.equal(row.baseAmount,1000);assert.equal(row.unresolved,0);assert.equal(day.attendanceStatus,"recognized");assert.equal(day.isOpen,false);
  assert.match(await page.locator('[data-testid="auto-attendance-status"]').innerText(),/자동|Tự/);
  await openPayrollView(page,"ledger");assert.equal(await page.locator("#finalize").isEnabled(),true,"a complete short pair needs no manual work confirmation");
  await openPayrollView(page,"attendance");
  await page.locator('#calendar [data-day="2026-10-28"]').click();assert.match(await page.locator("#dayDialog h2").innerText(),/수정/);await page.locator("#dayForm [data-close]").click();
  assert.equal(await page.evaluate(()=>__payrollTest.db.payroll_days.length),0);assert.equal(await page.evaluate(()=>__payrollTest.db.payroll_reviews.length),0);assert.equal(await page.evaluate(()=>__payrollTest.db.payroll_runs.length),0);
  assert.equal(await page.evaluate(()=>__payrollTest.calls.some(call=>call.operation&&call.operation!=="select")),false,"automatic recognition only reads original records; it never writes approval/correction rows");
  assert.equal(await page.evaluate(()=>__payrollTest.rpcs.length),0);

  // Salary finalization and actual payment remain explicit administrator actions.
  await openPayrollView(page,"ledger");
  await page.locator("#finalize").click();await page.locator('#confirmForm input[type="checkbox"]').check();await submit("confirmForm");
  await openPayrollView(page,"payments");
  await page.locator("#addPayment").click();await field("paymentForm","amount").fill("400");await field("paymentForm","paid_on").fill("2026-10-29");await submit("paymentForm");
  await page.locator("#evidenceDialog").waitFor({state:"visible"});await field("evidenceForm","signed_name").fill("DEMO · Hourly B");await page.locator("#signatureCanvas").scrollIntoViewIfNeeded();const box=await page.locator("#signatureCanvas").boundingBox();
  await page.mouse.move(box.x+20,box.y+50);await page.mouse.down();await page.mouse.move(box.x+110,box.y+20,{steps:8});await page.mouse.move(box.x+180,box.y+70,{steps:8});await page.mouse.up();await field("evidenceForm","acknowledged").check();await submit("evidenceForm");
  const frozen=await page.evaluate(()=>structuredClone({runs:__payrollTest.db.payroll_runs,payments:__payrollTest.db.payroll_payments,attachments:__payrollTest.db.payroll_attachments,objects:__payrollTest.storageObjects,dayWrites:__payrollTest.db.payroll_days}));
  assert.equal(frozen.runs[0].total,1000);assert.equal(frozen.runs[0].snapshot.minutes,2);assert.equal(frozen.payments[0].amount,400);assert.equal(frozen.attachments.length,1);

  // A later departure completes the open pair on the normal revision poll.
  // Completed work was never discarded while waiting for this final event.
  await select(noTerms);const wanted=await page.evaluate(({a,b})=>{
    __payrollTest.db.payroll_attendance_raw.push({id:"auto-close",employee_id:a,occurred_at:"2026-10-29T14:16:00",punch_type:"out",source:"kiosk",device_id:"TEST-TABLET"},
      {id:"after-final-in",employee_id:b,occurred_at:"2026-10-29T15:00:00",punch_type:"in",source:"kiosk",device_id:"TEST-TABLET"},{id:"after-final-out",employee_id:b,occurred_at:"2026-10-29T15:02:00",punch_type:"out",source:"kiosk",device_id:"TEST-TABLET"});
    return ++__payrollTest.db.payroll_revision[0].version;
  },{a:noTerms,b:hourly});await poll();await page.waitForFunction(revision=>DGV_PAYROLL_APP.state.revision===revision,wanted);await idle();
  row=await summary(noTerms);day=row.daily.find(day=>day.date==="2026-10-29");assert.equal(row.minutes,4);assert.equal(day.actualSeconds,284);assert.equal(day.attendanceStatus,"recognized");assert.equal(day.isOpen,false);assert.equal(row.baseAmount,null);
  assert.equal(await page.locator("#rawAttendanceRows tr").count(),4);assert.match(await page.locator('[data-testid="auto-attendance-minutes"]').innerText(),/0h 4m/);
  await screenshot("payroll-auto-attendance-completed.png","#autoAttendanceSummary");
  assert.deepEqual(await page.evaluate(()=>({runs:__payrollTest.db.payroll_runs,payments:__payrollTest.db.payroll_payments,attachments:__payrollTest.db.payroll_attachments,objects:__payrollTest.storageObjects,dayWrites:__payrollTest.db.payroll_days})),frozen,"late attendance must preserve finalized salary, payment, signature and correction history");
  await select(hourly,"payments");assert.equal((await summary(hourly)).minutes,4);assert.match(await page.locator('[data-testid="payment-expected"]').innerText(),/1[.,]000/);assert.match(await page.locator('[data-testid="payment-paid"]').innerText(),/400/);assert.match(await page.locator('[data-testid="payment-remaining"]').innerText(),/600/);
  await openPayrollView(page,"attendance");
  const currentDay=page.locator("#dailyBody tr").filter({hasText:"2026-10-29"});assert.equal(await currentDay.count(),1);assert.match(await currentDay.innerText(),/15:00/);assert.match(await currentDay.innerText(),/15:02/);assert.match(await currentDay.innerText(),/0h 2m/);
  assert.match(await page.locator('[data-testid="auto-attendance-minutes"]').innerText(),/0h 4m/);assert.match(await page.locator("#autoAttendanceSummary").innerText(),/확정 급여.*유지/);
  await openPayrollView(page,"ledger");
  assert.match(await page.locator("#ledgerBody tr td").nth(1).innerText(),/0h 4m/,"the ledger also shows current automatic attendance after payroll was finalized");assert.match(await page.locator("#ledgerBody tr td").nth(2).innerText(),/1[.,]000/,"the current attendance display does not recalculate the finalized wage");
  assert.equal(await page.evaluate(()=>__payrollTest.db.payroll_days.length),0);assert.equal(await page.evaluate(()=>__payrollTest.rpcs.filter(call=>call.name==="payroll_finalize").length),1);assert.equal(await page.evaluate(()=>__payrollTest.rpcs.filter(call=>call.name==="payroll_pay").length),1);
  assert.deepEqual(errors,[]);
  console.log("Automatic attendance browser passed: sub-five-minute pairs, seconds carry, completed work beside an open arrival, missing-rate time recognition, optional correction only, poll-driven completion and frozen salary/payment/signature preservation.");
}finally{await context.close();await browser.close();await new Promise(resolve=>server.close(resolve));}
