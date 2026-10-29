import assert from "node:assert/strict";
import { chromium } from "playwright";

// Read-only release check. Never signs in, enrolls faces or submits attendance.
const url=process.env.ATTENDANCE_LIVE_URL;
if(!url||!url.startsWith("https://"))throw new Error("Set ATTENDANCE_LIVE_URL to the HTTPS attendance page.");
const browser=await chromium.launch({headless:true,channel:process.env.PAYROLL_BROWSER_CHANNEL||"chrome"});
try{
  const context=await browser.newContext({viewport:{width:1280,height:800}}),page=await context.newPage(),errors=[];
  page.on("pageerror",error=>errors.push(error.message));
  const response=await page.goto(url,{waitUntil:"networkidle"});assert.equal(response.status(),200);
  await page.locator("#setup").waitFor({state:"visible"});
  assert.equal(await page.locator("#clockIn").isDisabled(),true);assert.equal(await page.locator("#clockOut").isDisabled(),true);
  assert.equal(await page.locator("#employee option").count(),1,"unenrolled public browser has no employee roster");
  await page.locator("#settings").click();await page.locator("#adminLogin").waitFor({state:"visible"});
  assert.equal(await page.locator("#adminWorkspace").isVisible(),false);await page.locator("#closeAdmin").click();
  const api=await page.evaluate(async()=>{
    const config=DGV_SUPABASE_CONFIG,headers={apikey:config.publishableKey,"Content-Type":"application/json"};
    const token=Array.from(crypto.getRandomValues(new Uint8Array(32)),x=>x.toString(16).padStart(2,"0")).join("");
    const roster=await fetch(config.url+"/rest/v1/rpc/payroll_kiosk_roster",{method:"POST",headers,body:JSON.stringify({p_token:token})});
    const employees=await fetch(config.url+"/rest/v1/payroll_employees?select=id&limit=1",{headers});
    const devices=await fetch(config.url+"/rest/v1/rpc/payroll_kiosk_devices",{method:"POST",headers,body:"{}"});
    return {roster:roster.status,employees:employees.status,devices:devices.status};
  });
  assert.ok([401,403].includes(api.roster));assert.ok([401,403].includes(api.employees));assert.ok([401,403].includes(api.devices));
  const model=await page.evaluate(async()=>{const engine=DGV_ATTENDANCE_FACE.create();const result=await engine.load();engine.dispose();return result;});
  assert.equal(model.model,"dlib-resnet128-faceapi-1.7.15-tiny68-v1");assert.ok(["wasm","webgl","cpu"].includes(model.backend));
  const payroll=await context.newPage();payroll.on("pageerror",error=>errors.push(error.message));
  await payroll.goto(new URL("payroll.html",url).href,{waitUntil:"networkidle"});
  await payroll.locator("#loginModal").waitFor({state:"visible"});assert.equal(await payroll.locator("#payrollApp").isVisible(),false);
  assert.ok(await payroll.locator('script[src*="payroll-core.js?v=20261029-3"]').count());
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({page:response.status(),unregistered:"locked",anonymous:api,model: model.backend,payroll:"admin gated",errors:errors.length}));
}finally{await browser.close();}
