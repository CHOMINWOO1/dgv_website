import {installAttendanceMock} from "./helpers/attendance-browser-mock.mjs";
import {installTouchBoundary} from "./helpers/attendance-touch-browser-mock.mjs";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {readFile,mkdir} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {chromium} from "playwright";
import vm from "node:vm";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const outputs=process.env.PAYROLL_SCREENSHOTS||path.resolve(root,"../payroll-qa");
const server=createServer(async(req,res)=>{try{
  const file=path.resolve(root,new URL(req.url,"http://localhost").pathname.slice(1)||"attendance-touch.html");
  if(!file.startsWith(root+path.sep))throw new Error("Invalid path");
  const bytes=await readFile(file);res.writeHead(200,{"Content-Type":({".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8"})[path.extname(file)]||"application/octet-stream"});res.end(bytes);
}catch{res.writeHead(404);res.end();}});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,channel:process.env.PAYROLL_BROWSER_CHANNEL||"chrome"});
const context=await browser.newContext({viewport:{width:800,height:1280},isMobile:true,hasTouch:true,timezoneId:"Asia/Seoul"});
const page=await context.newPage(),errors=[],requests=[];let seed=null,touchSeed=null;
const employeeId="00000000-0000-4000-8000-000000000001",otherEmployeeId="00000000-0000-4000-8000-000000000002";
page.setDefaultTimeout(10000);page.on("pageerror",error=>errors.push(error.message));page.on("request",request=>requests.push(request.url()));
await context.addInitScript(()=>{
  const original=setInterval;window.__touchIntervals=[];
  window.setInterval=(fn,ms,...args)=>{if(ms===1000)window.__touchExpiryTick=()=>fn(...args);return ms===30000?(__touchIntervals.push(()=>fn(...args)),0):original(fn,ms,...args);};
});
await context.route("**/*",async route=>{
  const url=route.request().url();
  if(url.startsWith("https://cdn.jsdelivr.net/npm/@supabase/"))return route.fulfill({contentType:"text/javascript",body:`(${installAttendanceMock.toString()})(${JSON.stringify(seed)});(${installTouchBoundary.toString()})(${JSON.stringify(touchSeed)});`});
  if(!url.startsWith(origin))return route.fulfill({body:"/* isolated synthetic boundary */"});
  // Serve the local app through Playwright as well, so this fully offline
  // synthetic suite requires no browser network/socket access.
  const file=path.resolve(root,new URL(url).pathname.slice(1));
  if(!file.startsWith(root+path.sep))return route.fulfill({status:403,body:""});
  try{return route.fulfill({contentType:({".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8"})[path.extname(file)]||"application/octet-stream",body:await readFile(file)});}catch{return route.fulfill({status:404,body:""});}
});
const idle=()=>page.waitForFunction(()=>!document.getElementById("closeAdmin").disabled);
const rpcCount=name=>page.evaluate(name=>__attendanceTest.calls.filter(call=>call.rpc===name).length+__touchTest.calls.filter(call=>call.rpc===name).length,name);
async function login(password="admin-test"){
  await page.locator("#settings").click();await page.locator("#adminPassword").fill(password);await page.locator("#adminLogin button").click();await idle();
}
async function reload(){
  seed=await page.evaluate(()=>{const {devices,grants,faceProfiles,faceRequests,events,receipts,sequence,calls}=__attendanceTest;return {devices,grants,faceProfiles,faceRequests,events,receipts,sequence,calls};});
  touchSeed=await page.evaluate(()=>{const {challenges,nextCodes,now,sequence,eventTimes,calls}=__touchTest;return {challenges,nextCodes,now,sequence,eventTimes,calls};});
  await page.reload();await page.waitForFunction(()=>document.getElementById("connection").textContent.includes("서버 연결됨")||!document.getElementById("setup").hidden);await idle();
}
async function begin(kind="in",id=employeeId){await idle();await page.locator("#employee").selectOption(id);await page.locator(kind==="in"?"#clockIn":"#clockOut").click();await page.locator("#touchDialog").waitFor({state:"visible"});await idle();const code=(await page.locator("#challengeCode").innerText()).trim();assert.match(code,/^\d{4}$/);return code;}
async function type(code){for(const digit of code)await page.locator(`[data-digit="${digit}"]`).tap();}
async function cancel(){if(await page.locator("#touchDialog").isVisible()){await page.locator("#touchCancel").click();await page.locator("#touchDialog").waitFor({state:"hidden"});await idle();}}
const events=()=>page.evaluate(()=>structuredClone(__attendanceTest.events));
async function assertNoCamera(){
  assert.equal(await page.evaluate(()=>__touchTest.cameraRequests),0);
  assert.equal(requests.some(url=>/attendance-face\.js|face-api-|\/wasm\/|\/models\//.test(url)),false,"touch mode must not request any face engine or model");
  assert.equal(await page.locator("video,canvas").count(),0,"touch page has no capture surface");
  assert.equal(await page.evaluate(()=>__attendanceTest.calls.some(call=>/face_|enroll|kiosk_punch$/.test(call.rpc||""))),false,"touch mode never reads faces or uses the face-verification punch");
}
try{
  await page.goto(origin+"/attendance-touch.html");await page.locator("#setup").waitFor({state:"visible"});
  assert.equal(await page.locator("#employee").isDisabled(),true);assert.equal(await page.evaluate(()=>__attendanceTest.calls.some(call=>call.table)),false);
  await login("manager-test");assert.equal(await page.locator("#adminWorkspace").isVisible(),false);assert.equal(await page.locator("#adminPassword").inputValue(),"");
  assert.deepEqual(await page.evaluate(()=>__attendanceTest.calls.filter(call=>call.method==="signInWithPassword").map(call=>call.email)),["admin@dgv.local"]);
  await page.evaluate(()=>{__attendanceTest.forceLoginRole="manager";});await page.locator("#adminPassword").fill("admin-test");await page.locator("#adminLogin button").click();await idle();
  assert.equal(await page.locator("#adminWorkspace").isVisible(),false,"the verified app_metadata admin role remains required");
  await page.evaluate(()=>{delete __attendanceTest.forceLoginRole;});await page.locator("#adminPassword").fill("admin-test");await page.locator("#adminLogin button").click();await page.locator("#adminWorkspace").waitFor({state:"visible"});await idle();
  await page.locator("#deviceName").fill("DEMO · Touch tablet");await page.locator("#registerDevice button").click();await idle();
  const device=await page.evaluate(()=>DGV_ATTENDANCE_STORE.get("device"));assert.match(device.token,/^[a-f0-9]{64}$/);assert.equal(await rpcCount("payroll_kiosk_register"),1);
  await page.locator("#closeAdmin").click();await page.locator("#adminDialog").waitFor({state:"hidden"});
  assert.equal(await page.evaluate(()=>__attendanceTest.clients.some(client=>client.role)),false,"setup session must be discarded after closing");
  assert.equal(await page.evaluate(()=>__attendanceTest.clients.every(client=>client.options.auth.persistSession===false)),true);
  assert.equal(await page.locator("#employee option").count(),3,"all two active staff are present; archived employees and contractors are excluded");
  assert.equal(await page.locator('#employee option[value="00000000-0000-4000-8000-000000000003"]').count(),0);
  await reload();assert.equal(await rpcCount("payroll_kiosk_register"),1,"the existing encrypted device registration is reused across reloads");
  assert.equal(await page.evaluate(()=>__attendanceTest.faceProfiles.length),0,"touch attendance has no dependency on enrolled faces");

  // A face-page receipt is a different protocol and cannot be discarded here.
  const facePending={requestId:"00000000-0000-4000-8000-000000000077",employeeId,name:"DEMO · previous face attendance",kind:"in",deviceId:device.device_id};
  await page.evaluate(async value=>{await DGV_ATTENDANCE_STORE.put("pending",value);await DGV_ATTENDANCE_STORE.put("face:untouched",{fixture:"legacy face record preserved"});},facePending);
  await reload();await page.locator("#otherPending").waitFor({state:"visible"});assert.equal(await page.locator("#employee").isDisabled(),true);assert.equal(await rpcCount("payroll_kiosk_touch_confirm"),0);
  assert.deepEqual(await page.evaluate(()=>DGV_ATTENDANCE_STORE.get("pending")),facePending);assert.match(await page.locator("#otherPending a").getAttribute("href"),/attendance\.html/);
  await page.evaluate(()=>DGV_ATTENDANCE_STORE.remove("pending"));await reload();

  // Issuance uses a server-returned string, including both leading zeroes.
  let code=await begin();assert.equal(code,"0042");
  await type("00");await page.locator("#touchBackspace").tap();await type("04");assert.equal(await page.locator("#touchConfirm").isDisabled(),true);
  await page.evaluate(()=>{window.__touchOriginalDateNow=Date.now;Date.now=()=>Date.parse("2099-01-01T00:00:00Z");});
  await page.locator("#touchClear").tap();await type("0000");assert.equal(await page.locator("#touchConfirm").isDisabled(),false,"changing the device wall clock cannot expire a server-duration challenge");
  await page.evaluate(()=>{Date.now=__touchOriginalDateNow;});await page.locator("#touchConfirm").click();await idle();
  assert.equal((await events()).length,0,"wrong visible code produces no attendance");
  assert.match(await page.locator("#touchNotice").textContent(),/번호|mã/i);
  assert.equal(await page.evaluate(()=>__touchTest.calls.filter(c=>c.rpc==="payroll_kiosk_touch_confirm").at(-1).args.p_code),"0000");
  await page.locator("#touchClear").tap();await type(code);
  await page.evaluate(()=>{__touchTest.eventTimes=["2026-10-31T08:00:00","2026-10-31T10:00:00"];__touchTest.deferRpc="payroll_kiosk_touch_confirm";});
  const before=await rpcCount("payroll_kiosk_touch_confirm");await page.locator("#touchConfirm").evaluate(button=>{button.click();button.click();});
  await page.waitForFunction(()=>typeof __touchTest.releaseRpc==="function");assert.equal(await rpcCount("payroll_kiosk_touch_confirm"),before+1,"rapid repeated taps dispatch one confirmation");
  const stored=await page.evaluate(()=>DGV_ATTENDANCE_STORE.get("touch-pending"));assert.ok(stored);assert.equal("code" in stored,false,"the visible code is not persisted with an uncertain attendance request");
  await page.evaluate(()=>__touchTest.releaseRpc());await idle();await page.locator("#touchDialog").waitFor({state:"hidden"});
  assert.equal((await events()).length,1);assert.equal((await events())[0].occurred_at,"2026-10-31T08:00:00");assert.match(await page.locator("#notice").textContent(),/31\/10\/2026.*08:00:00/s,"Vietnam server wall time is preserved on a browser set to Korea time");
  assert.equal(await page.evaluate(()=>DGV_ATTENDANCE_STORE.get("touch-pending")),null);
  const completed=await page.evaluate(()=>structuredClone(__touchTest.challenges.find(row=>row.status==="completed")));
  const replay=await page.evaluate(async({device,completed})=>await supabase.createClient().rpc("payroll_kiosk_touch_confirm",{p_token:device.token,p_challenge_id:completed.id,p_code:completed.code}),{device,completed});assert.equal(replay.data.event.replayed,true);assert.equal((await events()).length,1);

  await page.evaluate(()=>{__touchTest.now=Date.parse("2026-10-31T03:00:00Z");});
  code=await begin("out");assert.notEqual(code,"0042");await type(code);await page.locator("#touchConfirm").click();await idle();await page.locator("#touchDialog").waitFor({state:"hidden"});
  const pair=await events();assert.equal(pair.length,2);assert.equal(pair[1].occurred_at,"2026-10-31T10:00:00");
  const scope={console};scope.globalThis=scope;vm.runInNewContext(await readFile(path.join(root,"assets/payroll-core.js"),"utf8"),scope);
  const summary=scope.DGV_PAYROLL_CORE.summarizeMonth({month:"2026-10",today:"2026-11-01",employees:[{id:employeeId,device_user_id:"TEST-1",name:"DEMO",active:true,employment_type:"part_time"}],terms:[{employee_id:employeeId,effective_from:"2026-10-01",pay_type:"hourly",rate:40000,shift_start:"08:00",shift_end:"18:00",break_start:"12:00",break_end:"14:00"}],days:[],records:pair})[0];
  assert.equal(summary.minutes,120);assert.equal(summary.baseAmount,80000,"touch server timestamps feed the same typed payroll calculation");
  await page.evaluate(()=>{__touchTest.now+=31000;});

  // Cancel and expire attempts never create an extra event; a new attempt gets
  // a new server challenge rather than reusing a completed code as a fixed PIN.
  code=await begin();const cancelledId=await page.evaluate(()=>__touchTest.challenges.at(-1).id);await cancel();assert.equal((await events()).length,2);
  const nextCode=await begin();assert.notEqual(await page.evaluate(()=>__touchTest.challenges.at(-1).id),cancelledId);assert.notEqual(nextCode,code);
  await page.evaluate(()=>{__touchTest.now+=121000;});await type(nextCode);await page.locator("#touchConfirm").click();await idle();assert.equal((await events()).length,2);await cancel();

  code=await begin();const beforeRenew=await page.evaluate(()=>__touchTest.challenges.at(-1).id);
  await page.evaluate(()=>{const original=performance.now.bind(performance);window.__touchOriginalPerformanceNow=original;Object.defineProperty(performance,"now",{configurable:true,value:()=>original()+121000});__touchExpiryTick();});
  assert.equal(await page.locator('[data-digit="0"]').isDisabled(),true);await page.locator("#touchRenew").waitFor({state:"visible"});await page.locator("#touchRenew").click();await idle();
  assert.notEqual(await page.evaluate(()=>__touchTest.challenges.at(-1).id),beforeRenew,"client expiry offers a fresh server challenge");
  await cancel();await page.evaluate(()=>{Object.defineProperty(performance,"now",{configurable:true,value:__touchOriginalPerformanceNow});});

  // Issuance response loss retries the same UUID, with only one server record.
  await page.evaluate(()=>{__touchTest.loseChallengeResponse=true;});await page.locator("#clockIn").click();await idle();
  const issuedId=await page.evaluate(()=>__touchTest.challenges.at(-1).requestId);code=await begin();
  assert.equal(await page.evaluate(()=>__touchTest.challenges.at(-1).requestId),issuedId);assert.equal(await page.evaluate(id=>__touchTest.challenges.filter(row=>row.requestId===id).length,issuedId),1);await cancel();

  // Unknown confirmation outcomes survive reload. Recovery reads/cancels the
  // original request; it never manufactures a new confirmation timestamp.
  code=await begin();await page.evaluate(()=>{__touchTest.loseConfirmBeforeCommit=true;});await type(code);await page.locator("#touchConfirm").click();await idle();await page.locator("#pending").waitFor({state:"visible"});
  const pendingArgs=await page.evaluate(()=>structuredClone(__touchTest.calls.filter(call=>call.rpc==="payroll_kiosk_touch_confirm").at(-1).args));const attempts=await rpcCount("payroll_kiosk_touch_confirm");
  await reload();await page.locator("#pending").waitFor({state:"visible"});assert.equal(await page.locator("#employee").isDisabled(),true);
  await page.locator("#checkReceipt").click();await idle();await page.locator("#pending").waitFor({state:"hidden"});assert.equal(await rpcCount("payroll_kiosk_touch_confirm"),attempts);
  const late=await page.evaluate(async args=>await supabase.createClient().rpc("payroll_kiosk_touch_confirm",args),pendingArgs);assert.equal(late.data.ok,false);assert.equal(late.data.error,"cancelled");assert.equal((await events()).length,2);

  code=await begin();await page.evaluate(()=>{__touchTest.loseConfirmResponse=true;});await type(code);await page.locator("#touchConfirm").click();await idle();await page.locator("#pending").waitFor({state:"visible"});assert.equal((await events()).length,3);
  const savedTime=(await events())[2].occurred_at,savedConfirmCount=await rpcCount("payroll_kiosk_touch_confirm");await reload();await page.locator("#checkReceipt").click();await idle();assert.equal((await events()).length,3);assert.equal((await events())[2].occurred_at,savedTime);assert.equal(await rpcCount("payroll_kiosk_touch_confirm"),savedConfirmCount);

  // A new face/touch event on another device invalidates an older challenge.
  code=await begin("in",otherEmployeeId);await page.evaluate(id=>{__attendanceTest.events.push({event_id:"00000000-0000-4000-8000-000000000066",employee_id:id,punch_type:"in",occurred_at:"2026-10-31T09:00:00",source:"kiosk",verification:"trusted_kiosk_verification"});},otherEmployeeId);
  await type(code);await page.locator("#touchConfirm").click();await idle();await page.locator("#touchDialog").waitFor({state:"hidden"});assert.equal((await events()).length,4);assert.equal(await page.evaluate(()=>__touchTest.challenges.at(-1).status),"stale_state");
  await page.evaluate(()=>{__touchTest.now+=31000;});
  code=await begin("out");for(let index=0;index<5;index++){await type(code==="9999"?"8888":"9999");await page.locator("#touchConfirm").click();await idle();}
  await page.locator("#touchDialog").waitFor({state:"hidden"});assert.equal((await events()).length,4);assert.equal(await page.evaluate(()=>__touchTest.challenges.at(-1).status),"locked");

  // A revoked pending credential requires admin receipt recovery before it can
  // be replaced. The original request and all face records remain protected.
  code=await begin("out");await page.evaluate(()=>{__touchTest.loseConfirmBeforeCommit=true;});await type(code);await page.locator("#touchConfirm").click();await idle();await page.locator("#pending").waitFor({state:"visible"});
  await page.evaluate(()=>{__attendanceTest.devices[0].status="revoked";});await page.locator("#refreshRoster").click();await idle();await page.locator("#setup").waitFor({state:"visible"});assert.equal(await page.locator("#clockIn").isDisabled(),true);
  await login();await page.locator("#adminWorkspace").waitFor({state:"visible"});assert.equal(await page.locator("#registerDevice button").isDisabled(),true);await page.locator("#adminCheckReceipt").click();await idle();assert.equal(await rpcCount("payroll_kiosk_touch_admin_receipt"),1);assert.equal((await events()).length,4);assert.equal(await page.evaluate(()=>DGV_ATTENDANCE_STORE.get("touch-pending")),null);
  await page.locator("#deviceName").fill("DEMO · Reconnected touch tablet");await page.locator("#registerDevice button").click();await idle();
  const replacement=await page.evaluate(()=>DGV_ATTENDANCE_STORE.get("device"));assert.notEqual(replacement.device_id,device.device_id);await page.locator("#closeAdmin").click();await page.locator("#adminDialog").waitFor({state:"hidden"});assert.equal(await page.locator("#employee").isDisabled(),false);
  assert.deepEqual(await page.evaluate(()=>DGV_ATTENDANCE_STORE.get("face:untouched")),{fixture:"legacy face record preserved"},"touch registration never deletes existing face enrollments");

  await page.locator("#employee").selectOption(otherEmployeeId);await mkdir(outputs,{recursive:true});await page.evaluate(()=>{__touchTest.nextCodes.unshift("0042");});code=await begin("out",otherEmployeeId);assert.equal(code,"0042");await type("00");
  await page.evaluate(()=>{const banner=document.createElement("p");banner.textContent="DEMO · 합성 직원·모의 서버 / Nhân viên và máy chủ thử nghiệm";banner.style.cssText="padding:12px;background:#e6f3e8;border-radius:10px;font-size:14px";document.querySelector("main").prepend(banner);});
  await page.screenshot({path:path.join(outputs,"attendance-touch-tablet.png"),fullPage:false});
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,"phone layout must not overflow horizontally");
  for(const button of await page.locator("[data-digit]").all()){const box=await button.boundingBox();assert.ok(box.width>=44&&box.height>=44,"phone keypad targets remain at least 44px");}
  await page.locator("#touchClear").tap();await type("0042");assert.match(await page.locator("#touchDigits").innerText(),/0\s+0\s+4\s+2/);
  await page.locator("#touchConfirm").scrollIntoViewIfNeeded();const confirmBox=await page.locator("#touchConfirm").boundingBox();assert.ok(confirmBox.y>=0&&confirmBox.y+confirmBox.height<=844,"phone confirm remains reachable by scrolling inside the dialog");assert.equal(await page.locator("#touchConfirm").isDisabled(),false);
  await page.screenshot({path:path.join(outputs,"attendance-touch-phone.png"),fullPage:false});
  await page.setViewportSize({width:1280,height:720});await page.locator("#touchConfirm").scrollIntoViewIfNeeded();
  const landscapeConfirm=await page.locator("#touchConfirm").boundingBox();assert.ok(landscapeConfirm.y>=0&&landscapeConfirm.y+landscapeConfirm.height<=720,"landscape tablet confirmation stays reachable inside the dialog");assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  for(const button of await page.locator("[data-digit]").all()){const box=await button.boundingBox();assert.ok(box.width>=44&&box.height>=44);}
  await page.screenshot({path:path.join(outputs,"attendance-touch-landscape.png"),fullPage:false});await cancel();

  // A missed checkout on the prior Vietnam day must not block the next day's
  // check-in. This is a server-day rule, not a midnight guess by the tablet.
  const priorDayEvents=await events(),priorDayIn=priorDayEvents.filter(row=>row.employee_id===employeeId).at(-1);
  assert.equal(priorDayIn.punch_type,"in");
  await page.evaluate(()=>{
    __touchTest.now=Date.parse("2026-11-01T01:00:00Z");delete __touchTest.eventTimes;
    const NativeDate=Date;window.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:["2099-01-01T00:00:00Z"]));}static now(){return NativeDate.parse("2099-01-01T00:00:00Z");}};
  });
  await page.locator("#refreshRoster").click();await idle();await page.locator("#employee").selectOption(employeeId);
  assert.match(await page.locator("#employeeState").innerText(),/이전 날짜 기록/);
  assert.match(await page.locator("#employeeAvailability").innerText(),/오늘 새로 출근/);
  assert.equal(await page.evaluate(()=>new Date().getUTCFullYear()),2099,"fixture skews the entire tablet clock, not the server");
  code=await begin("in");await page.evaluate(()=>{__touchTest.loseConfirmResponse=true;});await type(code);await page.locator("#touchConfirm").click();await idle();await page.locator("#pending").waitFor({state:"visible"});
  const todaySaved=(await events()).at(-1),todayConfirmCount=await rpcCount("payroll_kiosk_touch_confirm");
  assert.equal(todaySaved.occurred_at,"2026-11-01T08:00:00");assert.equal(todaySaved.punch_type,"in");assert.equal((await events()).length,priorDayEvents.length+1);
  assert.deepEqual((await events()).find(row=>row.event_id===priorDayIn.event_id),priorDayIn,"new-day check-in never changes the prior IN or inserts an automatic OUT");
  await reload();await page.locator("#checkReceipt").click();await idle();assert.equal(await rpcCount("payroll_kiosk_touch_confirm"),todayConfirmCount);assert.deepEqual((await events()).at(-1),todaySaved,"unknown new-day confirmation recovers the original event exactly once");
  await page.locator("#employee").selectOption(employeeId);assert.doesNotMatch(await page.locator("#employeeState").innerText(),/이전 날짜 기록/);
  await page.locator("#clockIn").click();await idle();assert.equal(await page.locator("#touchDialog").isVisible(),false);assert.match(await page.locator("#notice").innerText(),/이미 같은/);assert.equal((await events()).length,priorDayEvents.length+1,"same-day repeated IN remains rejected");
  await page.locator("#clockOut").click();await idle();assert.equal(await page.locator("#touchDialog").isVisible(),false);assert.match(await page.locator("#notice").innerText(),/30초/);assert.equal((await events()).length,priorDayEvents.length+1,"new-day exception retains the 30-second cooldown");
  await page.evaluate(()=>{__touchTest.now+=31000;});code=await begin("out");await type(code);await page.locator("#touchConfirm").click();await idle();assert.equal((await events()).at(-1).punch_type,"out");assert.equal((await events()).at(-1).occurred_at,"2026-11-01T08:00:31");
  // An actual overnight shift still ends with OUT; it is not reset at midnight.
  const overnightIn=(await events()).filter(row=>row.employee_id===otherEmployeeId).at(-1);assert.equal(overnightIn.punch_type,"in");assert.match(overnightIn.occurred_at,/^2026-10-31/);
  code=await begin("out",otherEmployeeId);await type(code);await page.locator("#touchConfirm").click();await idle();assert.equal((await events()).at(-1).employee_id,otherEmployeeId);assert.equal((await events()).at(-1).punch_type,"out");assert.deepEqual((await events()).find(row=>row.event_id===overnightIn.event_id),overnightIn);
  await page.evaluate(()=>{__touchTest.omitRosterServerDate=true;});await page.locator("#refreshRoster").click();await idle();assert.equal(await page.locator("#employee").isDisabled(),false,"older roster payloads without server_date remain compatible");assert.doesNotMatch(await page.locator("#employeeState").innerText(),/이전 날짜 기록/);
  await assertNoCamera();assert.deepEqual(errors,[]);
  console.log("Touch attendance browser passed: admin-only device reuse/recovery, camera-free employee scope, fresh server code, exactly-once/atomic recovery, keypad layouts, payroll integration, prior-day IN to new-day IN under a skewed tablet clock, same-day duplicate/cooldown rejection, and valid overnight OUT.");
}finally{
  await context.close();await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
