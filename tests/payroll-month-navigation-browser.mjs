import assert from "node:assert/strict";
import {readFile, mkdir} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {chromium} from "playwright";
import {installMock} from "./helpers/payroll-browser-mock.mjs";
import {openPayrollView} from "./helpers/payroll-navigation.mjs";

// Exercise the actual calendars and day editor using only synthetic records.
// Every request is intercepted, so this test never contacts production.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),".."),origin="https://payroll-month.test";
const browser=await chromium.launch({headless:true,channel:process.env.PAYROLL_BROWSER_CHANNEL||"chrome"});
const context=await browser.newContext({viewport:{width:1440,height:1000},timezoneId:"Asia/Seoul"});
await context.route("**/*",async route=>{
  const url=route.request().url();
  if(url.startsWith("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@"))return route.fulfill({contentType:"text/javascript",body:`(${installMock.toString()})("admin");`});
  if(!url.startsWith(origin+"/"))return route.fulfill({body:""});
  try{
    const file=path.resolve(root,decodeURIComponent(new URL(url).pathname).slice(1));
    if(!file.startsWith(root+path.sep))throw Error("Invalid path");
    return route.fulfill({contentType:file.endsWith(".html")?"text/html; charset=utf-8":file.endsWith(".js")?"text/javascript; charset=utf-8":"text/css",body:await readFile(file)});
  }catch{return route.fulfill({status:404,body:""});}
});
const page=await context.newPage(),errors=[],employee="00000000-0000-4000-8000-000000000001";
page.on("pageerror",error=>errors.push(error.message));page.setDefaultTimeout(10000);
const idle=()=>page.waitForFunction(()=>window.DGV_PAYROLL_APP?.state.loaded&&!DGV_PAYROLL_APP.state.busy);
const team=()=>page.locator("#teamCalendarMonthNavigation"),personal=()=>page.locator("#employeeCalendarMonthNavigation");
const picker=control=>control.locator("input[type=month][data-calendar-month]");
const input=name=>page.locator(`#dayForm [name="${name}"]`);
async function expectMonth(month,count){
  await idle();
  assert.equal(await page.locator("#month").inputValue(),month);
  assert.equal(await picker(team()).inputValue(),month,"team control follows the shared month");
  assert.equal(await picker(personal()).inputValue(),month,"employee control follows the shared month");
  assert.equal(await page.evaluate(()=>DGV_PAYROLL_APP.state.selected),employee,"changing month preserves the selected employee");
  assert.equal(await page.locator("#employeeFilter").inputValue(),employee);
  assert.equal(await page.locator("#calendar [data-day]").count(),count);
  assert.equal(await page.locator("#teamCalendar [data-team-date]").count(),count);
  assert.deepEqual(await page.locator("#calendar [data-day]").evaluateAll(nodes=>[...new Set(nodes.map(node=>node.dataset.day.slice(0,7)))]),[month]);
  assert.deepEqual(await page.locator("#teamCalendar [data-team-date]").evaluateAll(nodes=>[...new Set(nodes.map(node=>node.dataset.teamDate.slice(0,7)))]),[month]);
}
async function pick(control,month,count){await picker(control).fill(month);await picker(control).dispatchEvent("change");await expectMonth(month,count);}
async function step(control,direction,month,count){await control.locator(`[data-month-step="${direction}"]`).click();await expectMonth(month,count);}
async function capture(filename){
  if(!process.env.PAYROLL_SCREENSHOTS)return;
  await mkdir(process.env.PAYROLL_SCREENSHOTS,{recursive:true});
  await page.screenshot({path:path.join(process.env.PAYROLL_SCREENSHOTS,filename),fullPage:true,animations:"disabled"});
  await personal().screenshot({path:path.join(process.env.PAYROLL_SCREENSHOTS,filename.replace(".png","-controls.png")),animations:"disabled"});
}

try{
  await page.goto(origin+"/payroll.html#employees");await idle();
  await page.evaluate(()=>{
    const fixture=__payrollTest;fixture.db.payroll_attendance_raw=[];
    fixture.db.payroll_employees.forEach(row=>Object.assign(row,{employment_type:"part_time",hire_date:"2024-01-01"}));
    fixture.db.payroll_terms.forEach(row=>Object.assign(row,{effective_from:"2024-01-01",rate:30000,break_start:"12:00:00",break_end:"12:00:00"}));
    fixture.db.payroll_revision[0].version++;
  });
  await page.locator("#month").fill("2026-11");await page.locator("#month").dispatchEvent("change");await idle();
  await openPayrollView(page,"employees");
  await page.locator(`[data-staff-action="attendance"][data-staff-id="${employee}"]`).click();
  await expectMonth("2026-11",30);

  // The ordinary employee-management path opens a calendar from which October
  // can be reached without finding the shared filter at the top of the page.
  await step(personal(),-1,"2026-10",31);
  await page.locator('#calendar [data-day="2026-10-31"]').click();
  await page.locator("#dayDialog").waitFor({state:"visible"});
  assert.equal(await input("work_date").inputValue(),"2026-10-31");
  await input("check_in").fill("2026-10-31T10:00");
  await input("check_out").fill("2026-10-31T18:00");
  await input("reason").fill("Synthetic October work entered from month navigation");
  await page.locator('#dayForm button[type="submit"]').click();
  await page.locator("#dayDialog").waitFor({state:"hidden"});await expectMonth("2026-10",31);
  const saved=await page.evaluate(employee=>__payrollTest.db.payroll_days.find(row=>row.employee_id===employee&&row.work_date==="2026-10-31"),employee);
  assert.equal(saved.check_in,"2026-10-31T10:00:00");assert.equal(saved.check_out,"2026-10-31T18:00:00");
  assert.equal(await page.evaluate(()=>__payrollTest.db.payroll_days.filter(row=>row.work_date.startsWith("2026-11")).length),0,"October input never writes a November record");
  await step(team(),1,"2026-11",30);
  await step(team(),-1,"2026-10",31);
  await page.locator("#refresh").click();await expectMonth("2026-10",31);
  await page.locator('#calendar [data-day="2026-10-31"]').click();
  await page.locator("#dayDialog").waitFor({state:"visible"});
  assert.equal(await input("check_in").inputValue(),"2026-10-31T10:00");
  assert.equal(await input("check_out").inputValue(),"2026-10-31T18:00");
  await page.locator("#dayDialog [data-close]").click();
  assert.equal(await page.evaluate(employee=>DGV_PAYROLL_APP.state.summaries.find(row=>row.employee_id===employee).daily.find(day=>day.date==="2026-10-31").minutes,employee),480);
  await capture("payroll-month-navigation-desktop.png");

  await pick(team(),"2026-12",31);
  await step(personal(),1,"2027-01",31);
  await step(personal(),-1,"2026-12",31);
  await pick(personal(),"2024-03",31);
  await step(team(),-1,"2024-02",29);
  assert.equal(await page.locator('#calendar [data-day="2024-02-29"]').count(),1);
  await step(personal(),1,"2024-03",31);
  await pick(team(),"2025-02",28);
  assert.equal(await page.locator('#calendar [data-day="2025-02-29"]').count(),0);

  // The original picker must also update both new controls.
  await page.locator("#month").fill("2026-11");await page.locator("#month").dispatchEvent("change");await expectMonth("2026-11",30);
  await page.setViewportSize({width:390,height:844});
  await step(personal(),-1,"2026-10",31);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,"month controls fit the 390px mobile viewport");
  for(const control of [team(),personal()]){
    assert.equal(await picker(control).isVisible(),true);
    const bounds=await control.boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=390,"the entire month toolbar stays on screen");
  }
  await capture("payroll-month-navigation-mobile.png");
  assert.deepEqual(errors,[]);
  console.log("Payroll month navigation passed: synchronized controls, employee retention, October save/reload, year boundary, leap February, direct selection and mobile layout.");
}finally{await context.close();await browser.close();}
