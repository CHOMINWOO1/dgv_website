import { installMock } from "./helpers/payroll-browser-mock.mjs";
import { openPayrollView } from "./helpers/payroll-navigation.mjs";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const mime={".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8"};
const server=createServer(async(req,res)=>{try{const file=path.resolve(root,decodeURIComponent(new URL(req.url,"http://localhost").pathname).replace(/^\/+/,"")||"payroll.html");if(!file.startsWith(root+path.sep))throw new Error("invalid path");res.writeHead(200,{"Content-Type":mime[path.extname(file)]||"application/octet-stream"});res.end(await readFile(file));}catch{res.writeHead(404);res.end();}});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,channel:process.env.PAYROLL_BROWSER_CHANNEL||"chrome"});
const context=await browser.newContext({viewport:{width:1440,height:1000}});
await context.addInitScript(()=>{window.print=()=>{window.__printed=true;};});
await context.route("**/*",route=>{const url=route.request().url();if(url.startsWith("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@"))return route.fulfill({contentType:"text/javascript",body:`(${installMock.toString()})("admin");`});if(!url.startsWith(origin))return route.fulfill({body:""});return route.continue();});
const page=await context.newPage(),errors=[];page.on("pageerror",error=>errors.push(error.message));page.setDefaultTimeout(10000);
const employee="00000000-0000-4000-8000-000000000001";
const idle=()=>page.waitForFunction(()=>!document.getElementById("workspace").disabled);
const field=(form,name)=>page.locator(`#${form} [name="${name}"]`);
const submit=async form=>{await page.locator(`#${form} button[type="submit"]`).click();await idle();};
const refresh=async()=>{await page.locator("#refresh").click();await idle();};
const summary=()=>page.evaluate(id=>DGV_PAYROLL_APP.state.summaries.find(row=>row.employee_id===id),employee);
const closeDay=async(type,manual=false)=>{await field("dayForm","day_type").selectOption(type);await field("dayForm","check_in").fill(manual?"2026-09-02T10:00":"");await field("dayForm","check_out").fill(manual?"2026-09-02T20:00":"");await field("dayForm","reason").fill("Synthetic administrator calendar override");await submit("dayForm");};
try{
  await page.goto(`${origin}/payroll.html`);await page.locator("#ledgerBody [data-employee]").first().waitFor();
  await page.evaluate(id=>{
    // September has five Wednesdays, so this weekly rest pattern plans 25 × 8h.
    for(let day=1;day<=30;day++){
      const date=`2026-09-${String(day).padStart(2,"0")}`;if(new Date(`${date}T00:00:00Z`).getUTCDay()===3)continue;
      for(const time of ["10:00:00","20:00:00"])__payrollTest.db.payroll_attendance_raw.push({id:`monthly-${date}-${time}`,employee_id:id,occurred_at:`${date}T${time}`,device_id:"1"});
    }
    __payrollTest.db.payroll_revision[0].version++;
  },employee);
  await page.locator("#month").fill("2026-09");await page.locator("#month").dispatchEvent("change");await idle();await page.locator("#employeeFilter").selectOption(employee);
  await openPayrollView(page,"employees");
  await page.locator("#addTerms").click();
  assert.equal(await field("termsForm","pay_type").inputValue(),"hourly","salary edits start from the existing contract");
  assert.equal(await field("termsForm","break_start").inputValue(),"13:00");assert.equal(await field("termsForm","break_end").inputValue(),"15:00");
  await field("termsForm","pay_type").selectOption("monthly");await field("termsForm","monthly_settlement").selectOption("monthly_net");
  await field("termsForm","break_start").fill("12:00");await field("termsForm","break_end").fill("14:00");
  assert.equal(await field("termsForm","weekly_rest_day").inputValue(),"0");
  await field("termsForm","rate").fill("7000000");await field("termsForm","weekly_rest_day").selectOption("3");
  assert.equal(await field("termsForm","monthly_extra_hourly_rate").count(),0,"monthly extra hourly rate is calculated automatically without a separate input");
  await submit("termsForm");await openPayrollView(page,"ledger");
  let row=await summary();
  assert.equal(row.settlementMode,"monthly_net");assert.equal(row.monthlyPlannedMinutes,12000);assert.equal(row.monthlyActualMinutes,12000);assert.equal(row.monthlyBalanceMinutes,0);assert.equal(row.monthlyExtraAmount,0);assert.equal(row.baseAmount,7000000);assert.equal(row.statutoryAmount,0);assert.equal(row.scheduleDefaultUsed,true);
  assert.equal(row.daily.find(day=>day.date==="2026-09-01").minutes,480,"12–14 break is excluded from ten-hour presence");
  assert.equal(await page.evaluate(()=>__payrollTest.db.payroll_days.length),0,"automatic baseline does not create redundant stored day rows");
  assert.match(await page.locator('[data-testid="month-plan"]').innerText(),/200h 0m/);

  await page.evaluate(id=>{__payrollTest.db.payroll_attendance_raw.find(r=>r.employee_id===id&&r.occurred_at==="2026-09-01T20:00:00").occurred_at="2026-09-01T19:30:00";__payrollTest.db.payroll_revision[0].version++;},employee);await refresh();row=await summary();
  assert.equal(row.monthlyBalanceMinutes,-30);assert.equal(row.monthlyExtraMinutes,0);assert.equal(row.monthlyExtraAmount,0);assert.equal(row.baseAmount,7000000);assert.match(await page.locator("#draftTotal").innerText(),/7[.,]000[.,]000/);

  await page.evaluate(id=>{__payrollTest.db.payroll_attendance_raw.find(r=>r.employee_id===id&&r.occurred_at==="2026-09-01T19:30:00").occurred_at="2026-09-01T20:30:00";__payrollTest.db.payroll_attendance_raw.find(r=>r.employee_id===id&&r.occurred_at==="2026-09-03T20:00:00").occurred_at="2026-09-03T19:30:00";__payrollTest.db.payroll_revision[0].version++;},employee);await refresh();row=await summary();
  assert.equal(row.monthlyBalanceMinutes,0);assert.equal(row.monthlyExtraAmount,0,"one day's extra offsets another day's shortfall before pay");
  await page.evaluate(id=>{__payrollTest.db.payroll_attendance_raw.find(r=>r.employee_id===id&&r.occurred_at==="2026-09-03T19:30:00").occurred_at="2026-09-03T20:00:00";__payrollTest.db.payroll_revision[0].version++;},employee);await refresh();row=await summary();
  assert.equal(row.monthlyActualMinutes,12030);assert.equal(row.monthlyExtraMinutes,30);assert.equal(row.monthlyExtraHourlyRate,35000);assert.equal(row.monthlyExtraAmount,17500,"30 extra minutes use monthly base divided by 200 planned hours");assert.equal(row.statutoryAmount,0);
  assert.equal(await page.locator("#finalize").isDisabled(),false,"monthly net hours do not require daily statutory approvals");
  assert.match(await page.locator('[data-testid="month-extra-amount"]').innerText(),/17[.,]500/);

  // A manual work day overrides the Wednesday default without touching punches.
  const raw=await page.evaluate(()=>structuredClone(__payrollTest.db.payroll_attendance_raw));
  await openPayrollView(page,"attendance");
  await page.locator('#calendar [data-day="2026-09-02"]').click();await closeDay("work",true);row=await summary();
  assert.equal(row.monthlyPlannedMinutes,12480);assert.equal(row.monthlyActualMinutes,12510);assert.equal(row.monthlyExtraAmount,16827,"calendar changes recalculate the automatic rate; payable amount rounds only at the end");
  assert.deepEqual(await page.evaluate(()=>__payrollTest.db.payroll_attendance_raw),raw);
  await page.locator('#calendar [data-day="2026-09-02"]').click();await closeDay("rest");row=await summary();assert.equal(row.monthlyPlannedMinutes,12000);assert.equal(row.monthlyActualMinutes,12030);

  await openPayrollView(page,"ledger");
  await page.locator("#allowances").fill("100");await page.locator("#deductions").fill("50");await page.locator("#adjustmentNote").fill("Synthetic additional approved amounts");
  await page.locator("#saveReview").click();await idle();assert.match(await page.locator("#draftTotal").innerText(),/7[.,]017[.,]550/);
  await page.locator("#finalize").click();await page.locator('#confirmForm input[type="checkbox"]').check();await submit("confirmForm");
  const run=await page.evaluate(()=>__payrollTest.db.payroll_runs[0]);assert.equal(run.base_amount,7000000);assert.equal(run.allowances,17600);assert.equal(run.deductions,50);assert.equal(run.total,7017550);assert.equal(run.snapshot.monthlyExtraAmount,17500);assert.equal(run.snapshot.statutoryAmount,0);
  await page.evaluate(id=>{const term=__payrollTest.db.payroll_terms.find(t=>t.employee_id===id&&t.monthly_settlement==="monthly_net");term.rate=9000000;__payrollTest.db.payroll_revision[0].version++;},employee);await refresh();
  assert.match(await page.locator('[data-testid="month-extra-amount"]').innerText(),/17[.,]500/,"finalized monthly view keeps its saved rate and premium");
  await openPayrollView(page,"payments");
  await page.locator("#exportKind").selectOption("ledger");await page.locator("#previewTax").click();await idle();await page.locator("#taxReviewed").check();
  const downloadEvent=page.waitForEvent("download");await page.locator("#downloadTax").click();const workbook=await downloadEvent,bytes=await readFile(await workbook.path()),xml=bytes.toString();
  assert.equal(bytes.readUInt32LE(),0x04034b50);assert.match(xml,/월 기준분/);assert.match(xml,/자동 계산 시급/);assert.match(xml,/<v>12000<\/v>/);assert.match(xml,/<v>12030<\/v>/);assert.match(xml,/<v>35000<\/v>/);assert.match(xml,/<v>17500<\/v>/);assert.match(xml,/<v>7017550<\/v>/);
  const popupEvent=page.waitForEvent("popup");await page.locator("#printTax").click();const popup=await popupEvent;await popup.waitForFunction(()=>window.__printed===true);assert.match(await popup.locator("body").innerText(),/월 초과수당/);assert.equal(await popup.locator("table").count(),2);
  await page.locator("#closeTaxPreview").click();await openPayrollView(page,"ledger");
  if(process.env.PAYROLL_SCREENSHOTS){
    await page.evaluate(id=>{__payrollTest.db.payroll_terms.find(t=>t.employee_id===id&&t.monthly_settlement==="monthly_net").rate=7000000;__payrollTest.db.payroll_revision[0].version++;},employee);await refresh();
  }
  if(process.env.PAYROLL_SCREENSHOTS){const folder=process.env.PAYROLL_SCREENSHOTS;await mkdir(folder,{recursive:true});await page.evaluate(()=>{const p=document.createElement("p");p.textContent="화면 미리보기 · 예시 데이터 / Bản xem thử · Dữ liệu mẫu";p.className="notice";document.getElementById("employeeDetail").prepend(p);});await page.locator("#employeeDetail").screenshot({path:path.join(folder,"payroll-monthly-desktop.png")});await popup.evaluate(()=>{const p=document.createElement("p");p.textContent="화면 미리보기 · 예시 데이터 / Bản xem thử · Dữ liệu mẫu";document.body.prepend(p);});await popup.screenshot({path:path.join(folder,"payroll-monthly-print.png"),fullPage:true});await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.locator("#employeeDetail").screenshot({path:path.join(folder,"payroll-monthly-mobile.png")});await page.setViewportSize({width:1440,height:1000});}await popup.close();
  // Current month displays progress against the full-month plan before closing.
  const currentMonth=await page.evaluate(()=>DGV.formatYmdInTimeZone(new Date(),"Asia/Ho_Chi_Minh").slice(0,7));
  await page.locator("#month").fill(currentMonth);await page.locator("#month").dispatchEvent("change");await idle();
  assert.equal(await page.locator("#monthlyTimeSummary").isVisible(),true);assert.match(await page.locator("#detailSummary").innerText(),/예상값|Dự kiến/);
  const beforeSalaryEdit=await page.evaluate(()=>structuredClone(__payrollTest.db.payroll_terms));
  await openPayrollView(page,"employees");
  await page.locator("#addTerms").click();await field("termsForm","effective_from").fill("2026-11-01");await field("termsForm","pay_type").selectOption("monthly");await field("termsForm","rate").fill("8000000");await submit("termsForm");
  assert.deepEqual(await page.evaluate(ids=>__payrollTest.db.payroll_terms.filter(term=>ids.includes(term.id)),beforeSalaryEdit.map(term=>term.id)),beforeSalaryEdit,"salary edit appends an effective-date version and preserves all prior conditions");
  await openPayrollView(page,"ledger");
  await page.locator("#month").fill("2026-11");await page.locator("#month").dispatchEvent("change");await idle();assert.equal((await summary()).baseAmount,8000000);
  await page.locator("#month").fill("2026-09");await page.locator("#month").dispatchEvent("change");await idle();assert.match(await page.locator('[data-testid="month-extra-amount"]').innerText(),/17[.,]500/);assert.equal(await page.evaluate(()=>__payrollTest.db.payroll_runs[0].total),7017550,"new salary version keeps the finalized September payroll intact");

  // A midmonth hire uses the contract effective on the hire date, including
  // Wednesday rest, instead of falling back to the older first-of-month term.
  await page.reload();await page.locator("#ledgerBody [data-employee]").first().waitFor();
  await page.evaluate(id=>{
    __payrollTest.db.payroll_employees.find(e=>e.id===id).hire_date="2026-09-15";
    __payrollTest.db.payroll_terms.push({id:"midmonth-net",employee_id:id,effective_from:"2026-09-15",pay_type:"monthly",rate:7000000,monthly_settlement:"monthly_net",weekly_rest_day:3,shift_start:"10:00:00",shift_end:"20:00:00",break_start:"12:00:00",break_end:"14:00:00"});
    for(const date of ["2026-09-15","2026-09-17"])for(const time of ["10:00:00","20:00:30"])__payrollTest.db.payroll_attendance_raw.push({id:`seconds-${date}-${time}`,employee_id:id,occurred_at:`${date}T${time}`,device_id:"1"});
    __payrollTest.db.payroll_revision[0].version++;
  },employee);
  await page.locator("#month").fill("2026-09");await page.locator("#month").dispatchEvent("change");await idle();await page.locator("#employeeFilter").selectOption(employee);
  await openPayrollView(page,"employees");
  await page.locator("#addTerms").click();assert.equal(await field("termsForm","pay_type").inputValue(),"monthly");assert.equal(await field("termsForm","weekly_rest_day").inputValue(),"3");assert.equal(await field("termsForm","monthly_extra_hourly_rate").count(),0);await page.locator("#termsForm [data-close]").click();
  await openPayrollView(page,"attendance");
  await page.locator("#monthSchedule").click();assert.equal(await page.locator('#scheduleForm input[name="rest"]:checked').count(),1);assert.equal(await page.locator('#scheduleForm input[name="rest"]:checked').inputValue(),"3");assert.equal(await page.locator('#scheduleForm input[name="rest"]:checked').getAttribute("type"),"radio");await page.locator("#scheduleForm [data-close]").click();
  row=await summary();assert.equal(row.monthlyActualMinutes,961,"two 30-second tails carry once to a full minute in the monthly total");
  assert.equal(row.monthlyPlannedMinutes,6240);assert.equal(row.baseAmount,3640000,"September 15 hire earns 13 active days / 25 full-month days of the agreed salary");assert.equal(row.compensationUnresolved,0);assert.equal(row.monthlyExtraHourlyRate,35000,"hire proration keeps the full-month hourly basis");
  assert.equal(row.monthlyProration.fullPlannedMinutes,12000);assert.equal(row.monthlyProration.activePlannedMinutes,6240);assert.equal(row.monthlyExpectedPayDate,"2026-10-05");
  await openPayrollView(page,"ledger");
  assert.match(await page.locator('[data-testid="month-proration"]').innerText(),/3[.,]640[.,]000/);assert.match(await page.locator('[data-testid="month-pay-date"]').innerText(),/2026-10-05/);
  await openPayrollView(page,"payments");
  await page.locator("#rangeFrom").fill("2026-09-15");await page.locator("#rangeTo").fill("2026-09-17");await page.locator("#rangeEmployee").selectOption(employee);await page.locator("#rangeSearch").click();await idle();
  assert.match(await page.locator("#rangeResult .range-summary").innerText(),/16h 1m/,"range header agrees with the monthly seconds carry");assert.match(await page.locator("#rangeResult").innerText(),/실제 초|giây thực tế/);
  const rangeDownloadEvent=page.waitForEvent("download");await page.locator("#rangeExport").click();const rangeDownload=await rangeDownloadEvent,rangeXml=(await readFile(await rangeDownload.path())).toString();
  assert.match(rangeXml,/Chấm công/);assert.doesNotMatch(rangeXml,/Đối chiếu tháng|월 기준분|월 초과수당/,"partial attendance export does not present incomplete data as full-month settlement");
  await page.evaluate(id=>{
    for(let day=15;day<=30;day++){
      const date=`2026-09-${String(day).padStart(2,"0")}`;if([15,17].includes(day)||new Date(`${date}T00:00:00Z`).getUTCDay()===3)continue;
      for(const time of ["10:00:00","20:00:00"])__payrollTest.db.payroll_attendance_raw.push({id:`hire-${date}-${time}`,employee_id:id,occurred_at:`${date}T${time}`,device_id:"1"});
    }
    __payrollTest.db.payroll_revision[0].version++;
  },employee);await refresh();await openPayrollView(page,"ledger");row=await summary();
  assert.equal(row.monthlyActualMinutes,6241);assert.equal(row.monthlyExtraMinutes,1);assert.equal(row.monthlyExtraAmount,583);assert.equal(row.baseAmount,3640000);assert.equal(await page.locator("#finalize").isDisabled(),false,"a complete first hire month finalizes with automatic proration");
  await page.locator("#finalize").click();await page.locator('#confirmForm input[type="checkbox"]').check();await submit("confirmForm");
  const hireRun=await page.evaluate(()=>__payrollTest.db.payroll_runs[0]);assert.equal(hireRun.total,3640583);assert.equal(hireRun.snapshot.monthlyProration.baseAmount,3640000);assert.equal(hireRun.snapshot.monthlyExtraBasisAmount,7000000);assert.equal(hireRun.snapshot.monthlyExtraBasisMinutes,12000);assert.equal(hireRun.snapshot.monthlyExpectedPayDate,"2026-10-05");
  // The fifth is the due day, with overdue treatment starting on the sixth.
  async function setToday(iso){await page.evaluate(value=>{const RealDate=window.__payrollRealDate||Date;window.__payrollRealDate=RealDate;const fixed=new RealDate(value).getTime();window.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[fixed]));}static now(){return fixed;}};},iso);await refresh();}
  await setToday("2026-10-05T05:00:00Z");assert.doesNotMatch(await page.locator("#payrollAlerts").innerText(),/지급기한 경과|Quá hạn/);
  await setToday("2026-10-06T05:00:00Z");assert.match(await page.locator("#payrollAlerts").innerText(),/지급기한 경과|Quá hạn/);
  await page.evaluate(()=>{window.Date=window.__payrollRealDate;});await refresh();
  if(process.env.PAYROLL_SCREENSHOTS){await page.evaluate(()=>{const p=document.createElement("p");p.textContent="화면 미리보기 · 예시 데이터 / Bản xem thử · Dữ liệu mẫu";p.className="notice";document.getElementById("employeeDetail").prepend(p);});await page.locator("#employeeDetail").screenshot({path:path.join(process.env.PAYROLL_SCREENSHOTS,"payroll-hire-proration.png")});}

  // A reviewed monthly base also drives the automatic hourly rate, premium,
  // reviewed snapshot and final wage breakdown consistently.
  await page.reload();await page.locator("#ledgerBody [data-employee]").first().waitFor();
  await page.evaluate(id=>{
    for(const [effective_from,rate] of [["2026-09-01",7000000],["2026-09-15",8000000]])__payrollTest.db.payroll_terms.push({id:`review-${effective_from}`,employee_id:id,effective_from,pay_type:"monthly",rate,monthly_settlement:"monthly_net",weekly_rest_day:3,shift_start:"10:00:00",shift_end:"20:00:00",break_start:"12:00:00",break_end:"14:00:00"});
    for(let day=1;day<=30;day++){
      const date=`2026-09-${String(day).padStart(2,"0")}`;if(new Date(`${date}T00:00:00Z`).getUTCDay()===3)continue;
      for(const time of ["10:00:00",day===1?"20:30:00":"20:00:00"])__payrollTest.db.payroll_attendance_raw.push({id:`review-${date}-${time}`,employee_id:id,occurred_at:`${date}T${time}`,device_id:"1"});
    }
    __payrollTest.db.payroll_revision[0].version++;
  },employee);
  await page.locator("#month").fill("2026-09");await page.locator("#month").dispatchEvent("change");await idle();await page.locator("#employeeFilter").selectOption(employee);
  await page.locator("#reviewedBase").fill("7500000");await page.locator("#reviewedBaseReason").fill("Synthetic review of midmonth salary change");
  assert.match(await page.locator('[data-testid="month-hourly-rate"]').innerText(),/37[.,]500/);assert.match(await page.locator('[data-testid="month-extra-amount"]').innerText(),/18[.,]750/);
  await page.locator("#saveReview").click();await idle();assert.equal(await page.locator("#reviewedBase").inputValue(),"7500000");assert.match(await page.locator("#draftTotal").innerText(),/7[.,]518[.,]750/);
  await page.locator("#finalize").click();await page.locator('#confirmForm input[type="checkbox"]').check();await submit("confirmForm");
  const reviewedRun=await page.evaluate(()=>__payrollTest.db.payroll_runs[0]);
  assert.equal(reviewedRun.base_amount,7500000);assert.equal(reviewedRun.allowances,18750);assert.equal(reviewedRun.total,7518750);assert.equal(reviewedRun.snapshot.monthlyExtraHourlyRate,37500);assert.equal(reviewedRun.snapshot.monthlyExtraAmount,18750);assert.equal(reviewedRun.snapshot.reviewedAmounts.monthlyExtraAmount,18750);assert.equal(reviewedRun.snapshot.wageBreakdown.reduce((sum,item)=>sum+item.amount,0),7518750);
  assert.deepEqual(errors,[]);
  console.log("Payroll monthly browser passed: automatic base/planned-hours rate, 12–14 break, automatic weekly rest/overrides, monthly shortfall preservation and cross-day netting, 30-minute premium, retained monetary review, immutable finalized snapshot, typed Excel/direct readable print, current-month progress, midmonth hire defaults and consistent range seconds carry.");
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
