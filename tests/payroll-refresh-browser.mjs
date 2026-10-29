import { installMock } from "./helpers/payroll-browser-mock.mjs";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const server=createServer(async(req,res)=>{
  try{
    const file=path.resolve(root,decodeURIComponent(new URL(req.url,"http://localhost").pathname).replace(/^\/+/,"")||"payroll.html");
    if(!file.startsWith(root+path.sep))throw new Error("Invalid path");
    res.writeHead(200,{"Content-Type":({".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8"})[path.extname(file)]||"application/octet-stream"});res.end(await readFile(file));
  }catch{res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,channel:process.env.PAYROLL_BROWSER_CHANNEL||"chrome"});
const errors=[];
async function newPage(role){
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  page.on("pageerror",error=>errors.push(error.message));
  await page.addInitScript(()=>{
    // Drive the production 30-second callback deterministically, without
    // exposing test-only methods in the application or sleeping 30 seconds.
    const original=window.setInterval.bind(window);window.__payrollPolls=[];
    window.setInterval=(fn,delay,...args)=>{if(delay===30000){window.__payrollPolls.push(()=>fn(...args));return original(fn,2147483647,...args);}return original(fn,delay,...args);};
  });
  await page.route("**/*",route=>{
    const url=route.request().url();
    if(url.startsWith("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@"))return route.fulfill({contentType:"text/javascript",body:`(${installMock.toString()})(${JSON.stringify(role)});`});
    if(!url.startsWith(origin))return route.fulfill({body:"/* isolated test: remote disabled */",contentType:"text/javascript"});
    return route.continue();
  });
  await page.goto(origin+"/payroll.html");return page;
}
const poll=page=>page.evaluate(async()=>{for(const callback of __payrollPolls)await callback();});
const revision=page=>page.evaluate(()=>DGV_PAYROLL_APP.state.revision);
const bump=page=>page.evaluate(()=>++__payrollTest.db.payroll_revision[0].version);
try{
  for(const role of [null,"manager","staff"]){
    const page=await newPage(role);await page.locator("#loginModal").waitFor({state:"visible"});await poll(page);
    assert.equal(await page.evaluate(()=>__payrollTest.calls.filter(call=>call.table).length),0,"polling cannot read payroll for a guest or non-admin");await page.close();
  }
  const page=await newPage("admin");await page.waitForFunction(()=>DGV_PAYROLL_APP?.state.loaded);
  await page.locator("#month").fill("2026-10");await page.locator("#month").dispatchEvent("change");await page.waitForFunction(()=>DGV_PAYROLL_APP.state.loaded&&!DGV_PAYROLL_APP.state.busy);await page.locator("h1").click();
  assert.equal(await page.evaluate(()=>__payrollPolls.length),1);
  const readsBefore=await page.evaluate(()=>__payrollTest.calls.filter(call=>call.table==="payroll_employees").length);
  await poll(page);
  assert.equal(await page.evaluate(()=>__payrollTest.calls.filter(call=>call.table==="payroll_employees").length),readsBefore,"unchanged revision never reloads the whole payroll");
  const employeeId=await page.evaluate(()=>__payrollTest.db.payroll_employees[0].id);
  const next=await page.evaluate(()=>{
    const test=__payrollTest,id=test.db.payroll_employees[0].id;
    test.db.payroll_attendance_raw.push(...["in","out"].map((type,i)=>({id:"typed-auto-"+i,employee_id:id,device_id:"web-kiosk",punch_type:type,source:"kiosk",occurred_at:"2026-10-02T"+(i?"18:00:00":"10:00:00")})));
    return ++test.db.payroll_revision[0].version;
  });
  await poll(page);assert.equal(await revision(page),next);
  assert.equal(await page.evaluate(()=>DGV_PAYROLL_APP.state.summaries[0].minutes),840,"incoming typed attendance reaches the real payroll calculation automatically");
  assert.equal(await page.evaluate(()=>__payrollTest.rpcs.filter(call=>call.name==="payroll_get_sensitive").length),0,"background polling never fetches encrypted identity or bank data");

  await page.locator("#employeeFilter").selectOption(employeeId);await page.locator("#allowances").fill("100");await page.locator("h1").click();
  const editedRevision=await revision(page);await bump(page);await poll(page);
  assert.equal(await revision(page),editedRevision);assert.equal(await page.locator("#allowances").inputValue(),"100");
  assert.match(await page.locator("#payrollRefreshStatus").textContent(),/입력·미리보기는 유지/);
  await page.locator("#refresh").click();await page.waitForFunction(()=>DGV_PAYROLL_APP.state.loaded&&!DGV_PAYROLL_APP.state.busy);
  assert.equal(await page.locator("#allowances").inputValue(),"0","the explicit reload, unlike polling, may reset unsaved fields");

  await page.locator('[data-day="2026-10-02"]').click();await page.locator('#dayForm [name="reason"]').fill("Unsaved attendance note");
  const dialogRevision=await revision(page);await bump(page);await poll(page);
  assert.equal(await revision(page),dialogRevision);assert.equal(await page.locator("#dayDialog").isVisible(),true);
  assert.equal(await page.locator('#dayForm [name="reason"]').inputValue(),"Unsaved attendance note");
  await page.locator("#dayDialog [data-close]").click();await page.locator("h1").click();await poll(page);
  assert.equal(await revision(page),dialogRevision+1);

  await page.locator("#exportKind").selectOption("ledger");await page.locator("#previewTax").click();await page.locator("#taxPreview").waitFor({state:"visible"});
  await page.locator("#taxReviewed").check();const previewText=await page.locator("#taxPreview").textContent(),previewRevision=await revision(page);
  await bump(page);await poll(page);
  assert.equal(await revision(page),previewRevision);assert.equal(await page.locator("#taxPreview").textContent(),previewText);assert.equal(await page.locator("#taxReviewed").isChecked(),true);
  await page.locator("#closeTaxPreview").click();await page.locator("h1").click();await poll(page);assert.equal(await revision(page),previewRevision+1);

  const hiddenRevision=await revision(page);await bump(page);
  await page.evaluate(()=>{window.__syntheticHidden=true;Object.defineProperty(document,"hidden",{configurable:true,get:()=>window.__syntheticHidden});});
  await poll(page);assert.equal(await revision(page),hiddenRevision);
  await page.evaluate(()=>{window.__syntheticHidden=false;document.dispatchEvent(new Event("visibilitychange"));});
  await page.waitForFunction(wanted=>DGV_PAYROLL_APP.state.revision===wanted,hiddenRevision+1);
  await page.waitForFunction(()=>!DGV_PAYROLL_APP.state.busy);

  // A failed check leaves the currently displayed snapshot intact; the next
  // check recovers. It must never erase unsaved data or produce an empty month.
  const failureRevision=await revision(page);await page.evaluate(()=>{__payrollTest.failRead=true;});await poll(page);
  assert.equal(await revision(page),failureRevision);assert.equal(await page.evaluate(()=>DGV_PAYROLL_APP.state.loaded),true);
  assert.match(await page.locator("#payrollRefreshStatus").textContent(),/자동 갱신을 확인하지 못했습니다/);
  await page.evaluate(()=>{__payrollTest.failRead=false;});await poll(page);assert.equal(await page.locator("#payrollRefreshStatus").isVisible(),false,"an unchanged successful check clears a connection failure");
  await page.evaluate(()=>{__payrollTest.failRead=false;__payrollTest.db.payroll_revision[0].version++;});await poll(page);assert.equal(await revision(page),failureRevision+1);

  // Slow refresh responses are invalid after logout, including a response to
  // the full load that was started before the session was removed.
  await page.evaluate(()=>{
    const client=DGV.supabase,original=client.from.bind(client);window.__deferPayrollTable="payroll_attendance_raw";
    client.from=table=>{
      const query=original(table),then=query.then;
      query.then=async function(resolve,reject){
        if(table===window.__deferPayrollTable){
          window.__deferPayrollTable=null;
          const response=await new Promise((done,fail)=>then.call(this,done,fail));
          await new Promise(done=>{window.__releasePayrollRead=done;});return resolve(response);
        }
        return then.call(this,resolve,reject);
      };return query;
    };
    __payrollTest.db.payroll_revision[0].version++;
    window.__pendingPoll=__payrollPolls[0]();
  });
  await page.waitForFunction(()=>Boolean(window.__releasePayrollRead));await page.evaluate(()=>DGV.supabase.auth.signOut());
  await page.evaluate(async()=>{__releasePayrollRead();await __pendingPoll;});
  assert.equal(await page.locator("#payrollApp").isVisible(),false);assert.equal(await page.evaluate(()=>DGV_PAYROLL_APP.state.loaded),false);
  const afterLogout=await page.evaluate(()=>__payrollTest.calls.length);await poll(page);assert.equal(await page.evaluate(()=>__payrollTest.calls.length),afterLogout);
  assert.deepEqual(errors,[]);await page.close();
  console.log("Payroll refresh browser passed: typed attendance arrival, admin-only polling, draft/dialog/report preservation, visibility, failure recovery and logout race.");
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
