import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {chromium} from "playwright";

// Read-only deployed-page check. No administrator login or real punch occurs.
const url=process.env.ATTENDANCE_TOUCH_LIVE_URL;
if(!url||!url.startsWith("https://"))throw new Error("Set ATTENDANCE_TOUCH_LIVE_URL to the HTTPS touch attendance page.");
const browser=await chromium.launch({headless:true,channel:process.env.PAYROLL_BROWSER_CHANNEL||"chrome"});
try{
  const context=await browser.newContext({viewport:{width:800,height:1280},isMobile:true,hasTouch:true});
  const page=await context.newPage(),errors=[],requests=[];
  page.on("pageerror",error=>errors.push(error.message));page.on("request",request=>requests.push(request.url()));
  const response=await page.goto(url,{waitUntil:"networkidle"});assert.equal(response.status(),200);
  for(const file of ["attendance-touch.html","assets/attendance-touch.js","assets/attendance-touch.css","assets/attendance-store.js","attendance.html"]){
    const remote=await context.request.get(new URL(file,url).href+"?release="+encodeURIComponent(new URL(url).searchParams.get("v")||"current"));
    assert.equal(remote.status(),200,file);
    const digest=bytes=>createHash("sha256").update(bytes).digest("hex");
    assert.equal(digest(await remote.body()),digest(await readFile(new URL("../"+file,import.meta.url))),file+" deployed bytes match tested source");
  }
  await page.locator("#setup").waitFor({state:"visible"});
  assert.equal(await page.locator("#employee").isDisabled(),true);
  assert.equal(await page.locator("#clockIn").isDisabled(),true);
  assert.equal(await page.locator("#clockOut").isDisabled(),true);
  assert.equal(await page.locator("video,canvas").count(),0);
  assert.equal(requests.some(value=>/attendance-face|face-api-|\/wasm\/|\/models\//.test(value)),false);
  await page.locator("#settings").click();await page.locator("#adminLogin").waitFor({state:"visible"});
  assert.equal(await page.locator("#adminWorkspace").isVisible(),false);
  const anonymous=await page.evaluate(async()=>{
    const config=DGV_SUPABASE_CONFIG,headers={apikey:config.publishableKey,"Content-Type":"application/json"};
    const token=Array.from(crypto.getRandomValues(new Uint8Array(32)),x=>x.toString(16).padStart(2,"0")).join("");
    const status=async(name,args)=>{const result=await fetch(config.url+"/rest/v1/rpc/"+name,{method:"POST",headers,body:JSON.stringify(args)});return result.status;};
    return {
      roster:await status("payroll_kiosk_roster",{p_token:token}),
      challenge:await status("payroll_kiosk_touch_challenge",{p_token:token,p_employee_id:crypto.randomUUID(),p_kind:"in",p_request_id:crypto.randomUUID()}),
      confirm:await status("payroll_kiosk_touch_confirm",{p_token:token,p_challenge_id:crypto.randomUUID(),p_code:"0042"}),
      receipt:await status("payroll_kiosk_touch_receipt",{p_token:token,p_request_id:crypto.randomUUID()})
    };
  });
  for(const [name,status]of Object.entries(anonymous))assert.ok([401,403].includes(status),name+" rejects an unregistered device");
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({page:response.status(),assets:"match",unregistered:"locked",cameraRequests:0,anonymous,errors:0}));
}finally{await browser.close();}
