import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { chromium } from "playwright";

// Read-only production verification. No employee data or credentials are used.
const url=process.env.PAYROLL_LIVE_URL;
if(!url||!url.startsWith("https://"))throw new Error("Set PAYROLL_LIVE_URL to the HTTPS payroll page.");
const browser=await chromium.launch({headless:true,channel:process.env.PAYROLL_BROWSER_CHANNEL||"chrome"});
try{
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const page=await context.newPage(),errors=[];
  page.on("pageerror",error=>errors.push(error.message));
  const response=await page.goto(url,{waitUntil:"networkidle"});assert.equal(response.status(),200);
  await page.locator("#loginModal").waitFor({state:"visible"});
  assert.equal(await page.locator("#payrollApp").isVisible(),false);
  assert.equal(await page.locator("#evidenceDialog").isVisible(),false);
  assert.equal(await page.locator("#rangeReceiptPrint").isDisabled(),true);
  assert.equal(await page.locator('a[href="attendance.html"]').count(),0,"payroll header has no tablet attendance link");
  const assets=["payroll.html","home_admin.html","assets/payroll-workspace.js","assets/payroll-services.js","assets/payroll-workspace.css","assets/payroll-receipts.css","assets/payroll-core.js","assets/payroll-rules.js","assets/payroll.js","assets/payroll-advanced.js","assets/payroll-receipts.js","assets/payroll-tax.js","assets/payroll.css"];
  for(const asset of assets){
    const remote=await context.request.get(new URL(asset,url).href+"?release=services-20261029-10");
    assert.equal(remote.status(),200,asset);
    const local=await readFile(new URL("../"+asset,import.meta.url));
    const digest=bytes=>createHash("sha256").update(bytes).digest("hex");
    assert.equal(digest(await remote.body()),digest(local),asset+" deployed bytes match tested source");
  }
  const privacy=await page.evaluate(async()=>{
    const config=DGV_SUPABASE_CONFIG,headers={apikey:config.publishableKey};
    const attachments=await fetch(config.url+"/rest/v1/payroll_attachments?select=id&limit=1",{headers});
    const payments=await fetch(config.url+"/rest/v1/payroll_payments?select=id&limit=1",{headers});
    return {attachments:attachments.status,payments:payments.status};
  });
  assert.ok([401,403].includes(privacy.attachments));assert.ok([401,403].includes(privacy.payments));
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({page:response.status(),assets:assets.length,adminGate:true,anonymousDenied:privacy,errors:errors.length}));
}finally{await browser.close();}
