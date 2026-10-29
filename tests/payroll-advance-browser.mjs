import { installMock } from "./helpers/payroll-browser-mock.mjs";
import { openPayrollView } from "./helpers/payroll-navigation.mjs";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// Synthetic money-only payments. Remote authorization/atomicity are exercised
// by SQL tests; this suite uses the actual payroll UI, calculation and exports.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const server=createServer(async(req,res)=>{try{
  const file=path.resolve(root,decodeURIComponent(new URL(req.url,"http://localhost").pathname).replace(/^\/+/,"")||"payroll.html");if(!file.startsWith(root+path.sep))throw new Error("Invalid path");
  res.writeHead(200,{"Content-Type":({".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8"})[path.extname(file)]||"application/octet-stream"});res.end(await readFile(file));
}catch{res.writeHead(404);res.end();}});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,channel:process.env.PAYROLL_BROWSER_CHANNEL||"chrome"});
const employee="00000000-0000-4000-8000-000000000001",parttime="00000000-0000-4000-8000-000000000002";
function seedAdvance(){
  const state=window.__payrollTest,[a,b]=state.db.payroll_employees;
  Object.assign(a,{name:"DEMO · Monthly An",employment_type:"full_time",hire_date:"2026-01-01",payment_method:"cash"});
  Object.assign(b,{name:"DEMO · Part-time Bình",employment_type:"part_time",hire_date:"2026-01-01",payment_method:"cash"});
  state.db.payroll_terms=[{id:"monthly-term",employee_id:a.id,effective_from:"2026-01-01",pay_type:"monthly",rate:7000000,monthly_settlement:"monthly_net",weekly_rest_day:3,shift_start:"10:00:00",shift_end:"20:00:00",break_start:"12:00:00",break_end:"14:00:00"}];
  state.db.payroll_attendance_raw=[];
  for(let day=1;day<=30;day++){const date=`2026-09-${String(day).padStart(2,"0")}`;if(new Date(date+"T12:00:00Z").getUTCDay()===3)continue;
    for(const time of ["10:00:00","20:00:00"])state.db.payroll_attendance_raw.push({id:`fixture-${date}-${time}`,employee_id:a.id,occurred_at:`${date}T${time}`,device_id:"1"});
  }
}
const context=await browser.newContext({viewport:{width:430,height:932},isMobile:true,hasTouch:true});
await context.addInitScript(()=>{window.print=()=>{window.__printed=true;};});
await context.route("**/*",route=>{const url=route.request().url();if(url.startsWith("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@"))return route.fulfill({contentType:"text/javascript",body:`(${installMock.toString()})("admin");(${seedAdvance.toString()})();`});if(!url.startsWith(origin))return route.fulfill({body:""});return route.continue();});
const page=await context.newPage(),errors=[];page.on("pageerror",error=>errors.push(error.message));page.setDefaultTimeout(10000);
const field=(form,name)=>page.locator(`#${form} [name="${name}"]`),idle=()=>page.waitForFunction(()=>!document.getElementById("workspace").disabled);
const submit=async form=>{await page.locator(`#${form} button[type="submit"]`).click();await idle();};
const refresh=async()=>{await page.locator("#refresh").click();await idle();};
const closeSignature=async()=>{await page.locator("#evidenceDialog").waitFor({state:"visible"});await page.locator("#evidenceForm [data-close]").click();};
async function openPayment(amount,date,note){await openPayrollView(page,"payments");await page.locator("#addPayment").click();await field("paymentForm","amount").fill(String(amount));await field("paymentForm","paid_on").fill(date);await field("paymentForm","note").fill(note);}
async function moneySummary(paid,remaining){
  await openPayrollView(page,"payments");
  assert.match(await page.locator('[data-testid="payment-paid"]').innerText(),new RegExp(paid.toLocaleString("en-US").replaceAll(",","[.,]")));
  if(remaining!==null)assert.match(await page.locator('[data-testid="payment-remaining"]').innerText(),new RegExp(remaining.toLocaleString("en-US").replaceAll(",","[.,]")));
}
async function sign(){
  await field("evidenceForm","signed_name").fill("DEMO · Monthly An");await page.locator("#signatureCanvas").scrollIntoViewIfNeeded();const box=await page.locator("#signatureCanvas").boundingBox();
  await page.mouse.move(box.x+20,box.y+50);await page.mouse.down();await page.mouse.move(box.x+90,box.y+20,{steps:8});await page.mouse.move(box.x+150,box.y+65,{steps:8});await page.mouse.up();await field("evidenceForm","acknowledged").check();await submit("evidenceForm");
}
async function reverse(id){await openPayrollView(page,"payments");await page.locator(`[data-reverse="${id}"]`).click();await field("amendForm","reason").fill("DEMO · Cancel duplicate advance");await submit("amendForm");}
async function comparison(period,count,total,paid,remaining){
  const previous=await page.locator('[data-payroll-tab][aria-selected="true"]').getAttribute("data-payroll-tab");
  await openPayrollView(page,"ledger");
  if(!await page.locator("#comparisonDetails").evaluate(node=>node.open))await page.locator("#comparisonDetails > summary").click();
  const cells=await page.locator("#comparisonResult tbody tr").filter({hasText:period}).locator("td").allTextContents();
  assert.equal(cells[0],period);
  assert.deepEqual(cells.slice(1).map(value=>Number(value.replace(/[^\d-]/g,""))),[count,total,paid,remaining],"monthly comparison credits each active finalized-month payment exactly once, including runless advances");
  await openPayrollView(page,previous);
}

try{
  await page.goto(origin+"/payroll.html");await page.locator("#ledgerBody [data-employee]").first().waitFor();
  assert.equal(await page.locator('header a[href*="attendance.html"]').count(),0,"payroll header must not show the removed tablet-attendance shortcut");
  await page.locator("#month").fill("2026-09");await page.locator("#month").dispatchEvent("change");await idle();await page.locator("#employeeFilter").selectOption(employee);
  assert.equal(await page.locator("#addPayment").isEnabled(),true,"unfinalized monthly salary can receive an advance");
  await moneySummary(0,7000000);assert.equal(await page.evaluate(()=>__payrollTest.db.payroll_runs.length),0);
  const originalAttendance=await page.evaluate(()=>structuredClone(__payrollTest.db.payroll_attendance_raw));
  await openPayment(100000,"2026-09-15","DEMO · Partial salary advance");
  assert.equal(await page.locator('#paymentForm input[type="time"],#paymentForm input[name*="hour"],#paymentForm input[name*="minute"]').count(),0,"money-only payments must not ask for hours");
  await page.evaluate(()=>{__payrollTest.loseAdvanceResponseOnce=true;});await submit("paymentForm");
  assert.equal(await page.locator("#paymentDialog").isVisible(),true);assert.equal(await page.evaluate(()=>__payrollTest.db.payroll_payments.length),1);
  const first=await page.evaluate(()=>structuredClone(__payrollTest.db.payroll_payments[0]));await submit("paymentForm");await page.locator("#evidenceDialog").waitFor({state:"visible"});
  assert.equal(await page.evaluate(()=>__payrollTest.db.payroll_payments.length),1);assert.equal(first.run_id,null);assert.equal(first.employee_id,employee);assert.equal(first.payroll_month,"2026-09-01");assert.equal(first.paid_on,"2026-09-15");
  assert.equal(await page.locator("#evidencePaymentSummary").getAttribute("data-payment-id"),first.id);
  const attempts=await page.evaluate(()=>__payrollTest.rpcs.filter(call=>call.name==="payroll_pay_advance"));assert.equal(attempts.length,2);assert.equal(attempts[0].args.p_request_id,attempts[1].args.p_request_id);
  assert.deepEqual(Object.keys(attempts[0].args).sort(),["p_employee_id","p_payroll_month","p_amount","p_paid_on","p_method","p_reference","p_note","p_request_id"].sort(),"advance payload contains money/date context and never fabricated work time or client creation time");
  assert.match(first.created_at,/^\d{4}-\d{2}-\d{2}T/);
  await sign();assert.equal(await page.evaluate(()=>__payrollTest.db.payroll_attachments.filter(a=>a.payment_id===__payrollTest.db.payroll_payments[0].id).length),1);
  await moneySummary(100000,6900000);await refresh();await moneySummary(100000,6900000);
  assert.match(await page.locator("#paymentArea").innerText(),/지급일/);assert.match(await page.locator("#paymentArea").innerText(),/입력\s*시각/);
  assert.equal(await page.evaluate(()=>__payrollTest.db.payroll_runs.length),0,"paying an advance must not fabricate a final payroll run");
  if(process.env.PAYROLL_SCREENSHOTS){await mkdir(process.env.PAYROLL_SCREENSHOTS,{recursive:true});await page.evaluate(()=>{const label=document.createElement("p");label.className="notice";label.textContent="예시 · 월급 확정 전 선지급 / DEMO";document.getElementById("paymentArea").prepend(label);});await page.locator("#paymentArea").screenshot({path:path.join(process.env.PAYROLL_SCREENSHOTS,"payroll-advance-before-finalization.png")});}

  // Salary month and actual payment day are separate, including across months.
  await openPayment(50000,"2026-10-02","DEMO · September salary paid in October");await submit("paymentForm");await closeSignature();
  const second=await page.evaluate(()=>structuredClone(__payrollTest.db.payroll_payments[1]));assert.equal(second.payroll_month,"2026-09-01");await moneySummary(150000,6850000);
  await page.locator("#rangeFrom").fill("2026-10-01");await page.locator("#rangeTo").fill("2026-10-03");await page.locator("#rangeEmployee").selectOption(employee);await page.locator("#rangeSearch").click();await idle();
  assert.deepEqual(await page.locator("#rangeReceipts [data-payment-id]").evaluateAll(rows=>rows.map(row=>row.dataset.paymentId)),[second.id]);
  assert.match(await page.locator("#rangeReceipts").innerText(),/2026-09/);assert.match(await page.locator('[data-receipt-total="activeTotal"]').innerText(),/50[.,]000/);
  const popupEvent=context.waitForEvent("page");await page.locator("#rangeReceiptPrint").click();const popup=await popupEvent;await popup.waitForFunction(()=>window.__printed===true);
  assert.deepEqual(await popup.locator("[data-payment-id]").evaluateAll(rows=>rows.map(row=>row.dataset.paymentId)),[second.id]);await popup.close();

  // An ad hoc part-time payment is available without terms or attendance.
  await page.locator("#employeeFilter").selectOption(parttime);assert.equal(await page.locator("#addPayment").isEnabled(),true);
  await openPayment(25000,"2026-09-21","DEMO · Agreed one-off part-time payment");await submit("paymentForm");await closeSignature();
  const shortPay=await page.evaluate(id=>structuredClone(__payrollTest.db.payroll_payments.find(p=>p.employee_id===id)),parttime);
  assert.equal(shortPay.run_id,null);assert.equal(shortPay.amount,25000);await moneySummary(25000,null);
  assert.deepEqual(await page.evaluate(()=>__payrollTest.db.payroll_attendance_raw),originalAttendance,"ad hoc payouts must not synthesize worked hours");
  assert.equal(await page.evaluate(id=>__payrollTest.db.payroll_terms.some(t=>t.employee_id===id),parttime),false);
  assert.equal(await page.evaluate(id=>__payrollTest.db.payroll_runs.some(r=>r.employee_id===id),parttime),false);
  await comparison("2026-09",0,0,0,0);
  if(process.env.PAYROLL_SCREENSHOTS){await page.evaluate(()=>{const label=document.createElement("p");label.className="notice";label.textContent="예시 · 파트타임 금액만 수시 지급 / DEMO";document.getElementById("paymentArea").prepend(label);});await page.locator("#paymentArea").screenshot({path:path.join(process.env.PAYROLL_SCREENSHOTS,"payroll-adhoc-parttime.png")});}

  // Finalization credits the existing advance rows without rebinding or copying.
  await page.locator("#employeeFilter").selectOption(employee);await openPayrollView(page,"ledger");await page.locator("#finalize").click();await page.locator('#confirmForm input[type="checkbox"]').check();await submit("confirmForm");
  const run=await page.evaluate(id=>structuredClone(__payrollTest.db.payroll_runs.find(r=>r.employee_id===id)),employee);assert.equal(run.total,7000000);
  await moneySummary(150000,6850000);assert.equal(await page.evaluate(id=>__payrollTest.db.payroll_payments.find(p=>p.id===id).run_id,first.id),null);
  await comparison("2026-09",1,7000000,150000,6850000);
  assert.equal(await page.evaluate(()=>__payrollTest.db.payroll_payments.length),3,"finalization must not duplicate advance payments");
  await reverse(second.id);await moneySummary(100000,6900000);
  await comparison("2026-09",1,7000000,100000,6900000);
  await openPayment(200000,"2026-10-03","DEMO · Payment after finalization");await submit("paymentForm");await closeSignature();
  const regular=await page.evaluate(()=>structuredClone(__payrollTest.db.payroll_payments.at(-1)));assert.equal(regular.run_id,run.id);assert.equal(regular.employee_id,employee);assert.equal(regular.payroll_month,"2026-09-01");
  assert.equal(await page.evaluate(()=>__payrollTest.rpcs.filter(call=>call.name==="payroll_pay").length),1);await moneySummary(300000,6700000);
  await comparison("2026-09",1,7000000,300000,6700000);
  await reverse(first.id);await moneySummary(200000,6800000);
  await comparison("2026-09",1,7000000,200000,6800000);
  assert.equal(await page.evaluate(id=>__payrollTest.db.payroll_attachments.some(a=>a.payment_id===id),first.id),true,"cancelled advance keeps its original signature audit evidence");
  assert.equal(await page.evaluate(()=>__payrollTest.db.payroll_payments.length),4);
  await page.locator("#addPayment").click();assert.equal(await field("paymentForm","amount").getAttribute("max"),"6800000","regular payout cap credits active advances and reversals once");await page.locator("#paymentForm [data-close]").click();
  if(process.env.PAYROLL_SCREENSHOTS){await mkdir(process.env.PAYROLL_SCREENSHOTS,{recursive:true});await page.evaluate(()=>{const label=document.createElement("p");label.className="notice";label.textContent="합성 데이터 · 선지급/수시 지급 검증 / DEMO";document.getElementById("paymentArea").prepend(label);});await page.locator("#paymentArea").screenshot({path:path.join(process.env.PAYROLL_SCREENSHOTS,"payroll-advance-payments.png")});}

  // A valid final salary may be lower than a recorded advance. Preserve both
  // amounts, expose the overpayment, and never silently carry it to another month.
  const excessEmployee="00000000-0000-4000-8000-000000000003";
  await page.evaluate(id=>{
    __payrollTest.db.payroll_employees.push({id,device_user_id:"EXCESS",name:"DEMO · Overpaid C",active:true,employment_type:"part_time"});
    __payrollTest.db.payroll_terms.push({id:"excess-term",employee_id:id,effective_from:"2026-01-01",pay_type:"hourly",rate:30000,shift_start:"10:00:00",shift_end:"20:00:00",break_start:"12:00:00",break_end:"14:00:00"});
    for(const time of ["10:00:00","20:00:00"])__payrollTest.db.payroll_attendance_raw.push({id:`excess-${time}`,employee_id:id,occurred_at:`2026-09-01T${time}`,device_id:"1"});
    __payrollTest.db.payroll_revision[0].version++;
  },excessEmployee);await refresh();await page.locator("#employeeFilter").selectOption(excessEmployee);
  await openPayment(300000,"2026-09-15","DEMO · Previously agreed advance");await submit("paymentForm");await closeSignature();
  await openPayrollView(page,"ledger");await page.locator("#finalize").click();await page.locator('#confirmForm input[type="checkbox"]').check();await submit("confirmForm");
  await openPayrollView(page,"payments");
  assert.equal(await page.evaluate(id=>__payrollTest.db.payroll_runs.find(r=>r.employee_id===id).total,excessEmployee),240000);
  assert.match(await page.locator('[data-testid="payment-paid"]').innerText(),/300[.,]000/);assert.match(await page.locator('[data-testid="payment-remaining"]').innerText(),/60[.,]000/);
  assert.match(await page.locator("#paymentArea").innerText(),/초과|vượt/i);assert.equal(await page.locator("#addPayment").isDisabled(),true);
  await page.locator("#month").fill("2026-10");await page.locator("#month").dispatchEvent("change");await idle();
  await moneySummary(0,null);assert.equal(await page.locator("#paymentArea .payment-card").count(),0,"September overpayment does not become an October payment or automatic deduction");
  await comparison("2026-09",2,7240000,500000,6740000);
  await comparison("2026-10",0,0,0,0);

  // Received kiosk records remain visible even when they cannot yet generate
  // payable hours: a two-minute pair, an unmatched arrival and absent terms.
  const rawEmployee="00000000-0000-4000-8000-000000000004";
  await page.evaluate(id=>{
    __payrollTest.db.payroll_employees.push({id,device_user_id:"RAW",name:"DEMO · Pending attendance",active:true});
    for(const [index,time,punch_type] of [[1,"11:32:00","in"],[2,"11:34:00","out"],[3,"12:13:00","in"]])__payrollTest.db.payroll_attendance_raw.push({id:`typed-visible-${index}`,employee_id:id,occurred_at:`2026-10-29T${time}`,punch_type,source:"kiosk",device_id:"TEST-TABLET"});
    __payrollTest.db.payroll_revision[0].version++;
  },rawEmployee);await refresh();await page.locator("#employeeFilter").selectOption(rawEmployee);
  await openPayrollView(page,"attendance");
  assert.match(await page.locator("#rawAttendanceSummary").innerText(),/3/);assert.equal(await page.locator("#rawAttendanceRows tr").count(),3);
  const rawText=await page.locator("#rawAttendanceRows").innerText();for(const time of ["11:32","11:34","12:13"])assert.ok(rawText.includes(time));assert.match(rawText,/출근|Vào/);assert.match(rawText,/퇴근|Ra/);
  assert.match(await page.locator("#ledgerBody").innerText(),/원본\s*3\s*건/);
  const unresolved=await page.evaluate(id=>DGV_PAYROLL_APP.state.summaries.find(row=>row.employee_id===id),rawEmployee);
  assert.equal(unresolved.minutes,2,"the completed two-minute pair is recognized even with a later open arrival and missing wage terms");assert.ok(unresolved.unresolved>0);assert.equal(unresolved.baseAmount,null);await moneySummary(0,null);
  await openPayrollView(page,"attendance");
  if(process.env.PAYROLL_SCREENSHOTS){await page.setViewportSize({width:1100,height:850});await page.evaluate(()=>{const label=document.createElement("p");label.className="notice";label.textContent="예시 · 미계산 출퇴근도 원본 확인 / DEMO · Synthetic attendance";document.getElementById("rawAttendancePanel").prepend(label);});await page.locator("#rawAttendancePanel").screenshot({path:path.join(process.env.PAYROLL_SCREENSHOTS,"payroll-raw-attendance.png")});}
  assert.deepEqual(errors,[]);
  console.log("Payroll advances passed: money-only pre-finalization monthly and ad hoc part-time payments, exact replay, signature linkage, paid-date cross-month receipts, credited balances/cancellations, overpayment without cross-month carry and visible unpayable raw attendance.");
}finally{await context.close();await browser.close();await new Promise(resolve=>server.close(resolve));}
