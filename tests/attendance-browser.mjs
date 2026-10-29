import { installAttendanceMock,installAttendanceFaceMock } from "./helpers/attendance-browser-mock.mjs";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile,mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),".."),outputs=process.env.PAYROLL_SCREENSHOTS||path.resolve(root,"../payroll-qa");
const server=createServer(async(req,res)=>{try{
  const file=path.resolve(root,decodeURIComponent(new URL(req.url,"http://localhost").pathname).replace(/^\/+/,"")||"attendance.html");
  if(!file.startsWith(root+path.sep))throw new Error("Invalid path");
  res.writeHead(200,{"Content-Type":({".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8"})[path.extname(file)]||"application/octet-stream"});res.end(await readFile(file));
}catch{res.writeHead(404);res.end();}});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,channel:process.env.PAYROLL_BROWSER_CHANNEL||"chrome"});
const context=await browser.newContext({viewport:{width:1280,height:800}}),page=await context.newPage(),errors=[];let seed=null;
page.on("pageerror",error=>errors.push(error.message));
await page.addInitScript(()=>{
  const original=window.setInterval.bind(window);window.__attendanceIntervals=[];
  window.setInterval=(fn,delay,...args)=>{if(delay===30000){window.__attendanceIntervals.push(()=>fn(...args));return original(fn,2147483647,...args);}return original(fn,delay,...args);};
});
await page.route("**/*",async route=>{
  const url=route.request().url();
  if(url.startsWith("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@"))return route.fulfill({contentType:"text/javascript",body:`(${installAttendanceMock.toString()})(${JSON.stringify(seed)});`});
  if(url.startsWith(origin+"/assets/attendance-face.js"))return route.fulfill({contentType:"text/javascript",body:`(${installAttendanceFaceMock.toString()})();`});
  if(url.startsWith(origin+"/assets/attendance-store.js"))return route.fulfill({contentType:"text/javascript",body:(await readFile(path.join(root,"assets/attendance-store.js"),"utf8"))+`;(()=>{const real=DGV_ATTENDANCE_STORE;window.__storageTest={};window.DGV_ATTENDANCE_STORE={...real,put:async(id,value)=>{if(id==='pending'&&__storageTest.deferPending){__storageTest.deferPending=false;await new Promise(resolve=>{__storageTest.release=resolve;});}return real.put(id,value);}};})();`});
  if(!url.startsWith(origin))return route.fulfill({contentType:"text/javascript",body:"/* no remote calls in isolated attendance test */"});
  return route.continue();
});
const rpcCount=name=>page.evaluate(name=>__attendanceTest.calls.filter(call=>call.rpc===name).length,name);
const idle=()=>page.waitForFunction(()=>!document.getElementById("settings").disabled);
async function login(){
  await page.locator("#settings").click();await page.locator("#adminPassword").fill("admin-test");await page.locator("#adminLogin button").click();await page.locator("#adminWorkspace").waitFor({state:"visible"});await idle();
}
async function localFaces(){return page.evaluate(()=>DGV_ATTENDANCE_STORE.faces());}
async function tick(){await page.evaluate(()=>{for(const callback of __attendanceIntervals)callback();});await page.waitForFunction(()=>!document.getElementById("settings").disabled);}
async function reload(){
  seed=await page.evaluate(()=>{const {devices,grants,events,receipts,sequence,employees,calls}=__attendanceTest;return {devices,grants,events,receipts,sequence,employees,calls};});
  await page.reload();await page.waitForFunction(()=>__attendanceTest.calls.some(call=>call.rpc==="payroll_kiosk_roster")&&document.getElementById("deviceLabel").textContent.includes("DEMO"));
  await page.waitForFunction(()=>document.getElementById("connection").textContent.includes("서버 연결됨"));
}
try{
  await page.goto(origin+"/attendance.html");await page.locator("#setup").waitFor({state:"visible"});
  assert.equal(await page.locator("#clockIn").isDisabled(),true);assert.equal(await page.locator("#clockOut").isDisabled(),true);
  assert.equal(await page.evaluate(()=>__attendanceTest.calls.filter(call=>call.table).length),0,"unregistered public screen must not query payroll staff data");
  await page.locator("#setupButton").click();await page.locator("#adminPassword").fill("manager-test");await page.locator("#adminLogin button").click();await idle();
  assert.equal(await page.locator("#adminWorkspace").isVisible(),false);assert.equal(await page.locator("#adminPassword").inputValue(),"");
  assert.deepEqual(await page.evaluate(()=>__attendanceTest.calls.filter(call=>call.method==="signInWithPassword").map(call=>call.email)),["admin@dgv.local"],"setup never attempts manager/staff accounts");
  await page.evaluate(()=>{__attendanceTest.forceLoginRole="manager";});await page.locator("#adminPassword").fill("admin-test");await page.locator("#adminLogin button").click();await idle();
  assert.equal(await page.locator("#adminWorkspace").isVisible(),false,"the verified app_metadata role is required even after a password response");
  assert.equal(await page.evaluate(()=>__attendanceTest.clients.some(client=>client.role)),false);await page.evaluate(()=>{delete __attendanceTest.forceLoginRole;});
  await page.locator("#adminPassword").fill("admin-test");await page.locator("#adminLogin button").click();await page.locator("#adminWorkspace").waitFor({state:"visible"});await idle();
  assert.equal(await page.evaluate(()=>__attendanceTest.clients.every(client=>client.options.auth.persistSession===false&&client.options.auth.autoRefreshToken===false)),true);
  await page.locator("#deviceName").fill("DEMO · HANA tablet");await page.locator("#registerDevice button").click();await idle();await page.locator("#enrollSection").waitFor({state:"visible"});
  const ids=await page.evaluate(()=>__attendanceTest.employees.map(row=>row.id));
  await page.locator("#enrollEmployee").selectOption(ids[0]);await page.locator("#enrollFace").click();await idle();
  assert.equal(await rpcCount("payroll_kiosk_enroll"),0,"no biometric capture/storage without recorded employee consent");
  await page.locator("#consent").check();await page.locator("#enrollFace").click();await idle();
  assert.equal(await rpcCount("payroll_kiosk_enroll"),1);assert.equal((await localFaces()).length,1);
  assert.equal(await page.evaluate(()=>__faceTest.cameraStops>0),true,"enrollment closes its media tracks");
  const device=await page.evaluate(()=>DGV_ATTENDANCE_STORE.get("device"));assert.match(device.token,/^[a-f0-9]{64}$/);
  const encrypted=await page.evaluate(async()=>{
    const db=await new Promise((resolve,reject)=>{const request=indexedDB.open("hana-attendance-v1",1);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    const records=await new Promise((resolve,reject)=>{const request=db.transaction("records").objectStore("records").getAll();request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    const key=await new Promise((resolve,reject)=>{const request=db.transaction("key").objectStore("key").get("aes");request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    return {encrypted:records.every(record=>record.iv instanceof Uint8Array&&record.cipher instanceof ArrayBuffer),texts:records.map(record=>new TextDecoder().decode(record.cipher)),extractable:key.extractable,storage:JSON.stringify({...localStorage,...sessionStorage})};
  });
  assert.equal(encrypted.encrypted,true);assert.equal(encrypted.extractable,false);
  assert.equal(encrypted.texts.some(text=>text.includes(device.token)||text.includes("samples")||text.includes("Nguyễn")),false,"persisted entries must be ciphertext, not employee names or face arrays");
  assert.equal(encrypted.storage.includes(device.token)||encrypted.storage.includes("admin-test")||encrypted.storage.includes("synthetic-admin-session"),false);
  await page.locator("#closeAdmin").click();await page.locator("#adminDialog").waitFor({state:"hidden"});
  assert.equal(await page.evaluate(()=>__attendanceTest.clients.some(client=>client.role)),false,"administrator session is discarded when settings close");
  assert.equal(await page.locator("#enrollEmployee option").count(),0);assert.equal(await page.locator("#adminPassword").inputValue(),"");
  await page.locator("#employee").selectOption(ids[0]);

  await page.evaluate(()=>{__faceTest.matched=false;});await page.locator("#clockIn").click();await idle();
  assert.equal(await rpcCount("payroll_kiosk_punch"),0);assert.match(await page.locator("#notice").textContent(),/일치하지 않습니다/);
  await page.evaluate(()=>{__faceTest.matched=true;});await page.locator("#testFace").click();await idle();
  assert.equal(await rpcCount("payroll_kiosk_punch"),0);assert.match(await page.locator("#notice").textContent(),/테스트 완료/);

  // Cancellation ignores even a late successful face response; a subsequent
  // attempt must use a usable engine, rather than a disposed instance.
  await page.evaluate(()=>{__faceTest.defer=true;__faceTest.ignoreAbort=true;});await page.locator("#clockIn").click();await page.waitForFunction(()=>typeof __faceTest.release==="function");
  await page.locator("#cancelFace").click();await page.evaluate(()=>{__faceTest.release();__faceTest.release=null;});await idle();
  assert.equal(await rpcCount("payroll_kiosk_punch"),0);assert.equal(await page.evaluate(()=>DGV_ATTENDANCE_STORE.get("pending")),null);
  await page.evaluate(()=>{__faceTest.ignoreAbort=false;});await page.locator("#clockIn").click();await idle();
  assert.equal(await rpcCount("payroll_kiosk_punch"),1);assert.match(await page.locator("#employeeState").textContent(),/출근/);
  const punchArgs=await page.evaluate(()=>__attendanceTest.calls.find(call=>call.rpc==="payroll_kiosk_punch").args);
  assert.deepEqual(Object.keys(punchArgs).sort(),["p_employee_id","p_kind","p_request_id","p_token"],"no photo, template, browser time or payroll information is submitted");

  await page.evaluate(()=>{__attendanceTest.losePunchResponse=true;});await page.locator("#clockOut").click();await idle();
  assert.equal(await page.locator("#pending").isVisible(),true);assert.equal(await page.locator("#clockIn").isDisabled(),true);
  const requestId=await page.evaluate(async()=>(await DGV_ATTENDANCE_STORE.get("pending")).requestId),punchesBeforeReload=await rpcCount("payroll_kiosk_punch");
  await reload();assert.equal(await page.locator("#pending").isVisible(),true);assert.equal(await page.evaluate(async()=>(await DGV_ATTENDANCE_STORE.get("pending")).requestId),requestId);
  await page.locator("#checkReceipt").click();await idle();
  assert.equal(await rpcCount("payroll_kiosk_punch"),punchesBeforeReload,"unknown-result recovery never creates another punch");
  assert.equal(await page.evaluate(()=>__attendanceTest.events.length),2);assert.equal(await page.evaluate(()=>DGV_ATTENDANCE_STORE.get("pending")),null);
  assert.equal(await page.locator("#pending").isVisible(),false);

  // A completed morning shift does not close attendance for the whole day.
  // The same employee can verify again and create a second distinct in/out pair.
  await page.locator("#employee").selectOption(ids[0]);assert.equal(await page.locator("#clockIn").isEnabled(),true);
  await page.locator("#clockIn").click();await idle();assert.match(await page.locator("#employeeState").innerText(),/출근/);
  await page.locator("#clockOut").click();await idle();assert.match(await page.locator("#employeeState").innerText(),/퇴근/);
  const twoCycles=await page.evaluate(()=>structuredClone(__attendanceTest.events));
  assert.deepEqual(twoCycles.map(event=>event.punch_type),["in","out","in","out"]);
  assert.equal(new Set(twoCycles.map(event=>event.event_id)).size,4);assert.equal(new Set(twoCycles.map(event=>event.occurred_at.slice(0,10))).size,1,"both shifts belong to the same day");
  assert.equal(await rpcCount("payroll_kiosk_punch"),4,"each successful face action creates exactly one new attendance request");
  await reload();await page.locator("#employee").selectOption(ids[0]);
  assert.match(await page.locator("#employeeState").innerText(),/퇴근/);assert.equal(await page.locator("#clockIn").isEnabled(),true,"a reload preserves both cycles and permits another return to work");
  assert.deepEqual(await page.evaluate(()=>__attendanceTest.events),twoCycles);

  await page.locator("#employee").selectOption(ids[0]);await page.evaluate(()=>{__attendanceTest.losePunchBeforeCommit=true;});await page.locator("#clockIn").click();await idle();
  const failedCount=await rpcCount("payroll_kiosk_punch");await page.locator("#checkReceipt").click();await idle();
  assert.equal(await rpcCount("payroll_kiosk_punch"),failedCount);assert.equal(await page.evaluate(()=>__attendanceTest.events.length),4);assert.match(await page.locator("#notice").textContent(),/저장된 기록이 없습니다/);

  await page.evaluate(()=>{__storageTest.deferPending=true;});await page.locator("#clockIn").click();await page.waitForFunction(()=>typeof __storageTest.release==="function");
  const beforeStorageCancel=await rpcCount("payroll_kiosk_punch");await page.locator("#cancelFace").click();await page.evaluate(()=>__storageTest.release());await idle();
  assert.equal(await rpcCount("payroll_kiosk_punch"),beforeStorageCancel,"cancelling during durable-request storage must not create a late punch");
  assert.equal(await page.evaluate(()=>DGV_ATTENDANCE_STORE.get("pending")),null);

  // Closing setup while face enrollment is pending discards the late result.
  await login();await page.locator("#enrollEmployee").selectOption(ids[1]);await page.locator("#consent").check();
  await page.evaluate(()=>{__faceTest.defer=true;__faceTest.ignoreAbort=true;});await page.locator("#enrollFace").click();await page.waitForFunction(()=>typeof __faceTest.release==="function");
  const grantCount=await rpcCount("payroll_kiosk_enroll");await page.locator("#closeAdmin").click();await page.evaluate(()=>{__faceTest.release();__faceTest.release=null;});await idle();
  assert.equal(await rpcCount("payroll_kiosk_enroll"),grantCount);assert.equal((await localFaces()).length,1);assert.equal(await page.locator("#adminDialog").isVisible(),false);
  assert.equal(await page.evaluate(()=>__attendanceTest.clients.some(client=>client.role)),false);
  await page.evaluate(()=>{__faceTest.ignoreAbort=false;});await page.locator("#employee").selectOption(ids[0]);await page.locator("#testFace").click();await idle();assert.match(await page.locator("#notice").textContent(),/테스트 완료/);

  // An ordinary connection loss or revoked capability blocks attendance until
  // the server confirms the device and roster again.
  await page.evaluate(()=>{__attendanceTest.failRpcOnce="payroll_kiosk_roster";window.dispatchEvent(new Event("online"));});
  await page.waitForFunction(()=>document.getElementById("connection").textContent.includes("확인 필요"));assert.equal(await page.locator("#clockIn").isDisabled(),true);
  await tick();await page.waitForFunction(()=>document.getElementById("connection").textContent.includes("서버 연결됨"));
  await page.locator("#employee").selectOption(ids[0]);await page.locator("#testFace").click();await idle();
  await page.evaluate(()=>{const label=document.createElement("p");label.id="syntheticPreview";label.className="notice";label.textContent="화면 예시 · 합성 직원·모의 카메라 / DEMO · Dữ liệu mô phỏng (실제 인식속도 측정 아님)";document.querySelector(".shell").prepend(label);});
  await mkdir(outputs,{recursive:true});await page.screenshot({path:path.join(outputs,"attendance-tablet.png"),fullPage:true});
  await page.setViewportSize({width:768,height:1024});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),true,"tablet portrait must not scroll horizontally");
  await page.screenshot({path:path.join(outputs,"attendance-tablet-portrait.png"),fullPage:true});
  await page.evaluate(()=>{__attendanceTest.losePunchResponse=true;});await page.locator("#clockIn").click();await idle();
  const revokedPending=await page.evaluate(()=>DGV_ATTENDANCE_STORE.get("pending")),savedEventCount=await page.evaluate(()=>__attendanceTest.events.length);
  assert.ok(revokedPending);
  await page.evaluate(()=>{__attendanceTest.devices[0].status="revoked";window.dispatchEvent(new Event("online"));});
  await page.waitForFunction(()=>document.getElementById("employee").disabled);
  assert.equal(await page.locator("#clockIn").isDisabled(),true);assert.equal(await page.locator("#clockOut").isDisabled(),true);
  assert.equal(await page.locator("#employee option").count(),1,"revoked devices lose the public roster");
  await login();await page.evaluate(()=>{__attendanceTest.failTableOnce="payroll_attendance_raw";});await page.locator("#forgetDevice").click();await idle();
  assert.equal((await page.evaluate(()=>DGV_ATTENDANCE_STORE.get("pending"))).requestId,revokedPending.requestId,"failed privileged receipt lookup must retain the recoverable pending request");
  assert.ok(await page.evaluate(()=>DGV_ATTENDANCE_STORE.get("device")));
  await page.locator("#forgetDevice").click();await idle();assert.equal(await page.evaluate(()=>DGV_ATTENDANCE_STORE.get("device")),null);
  assert.equal(await page.evaluate(()=>DGV_ATTENDANCE_STORE.get("pending")),null);assert.equal((await localFaces()).length,0);
  assert.equal(await page.evaluate(()=>__attendanceTest.events.length),savedEventCount,"clearing a revoked browser preserves the committed attendance record");
  const recoveryReads=await page.evaluate(()=>__attendanceTest.calls.filter(call=>call.table==="payroll_attendance_raw"));
  assert.ok(recoveryReads.length);for(const read of recoveryReads){assert.equal(read.role,"admin");assert.deepEqual(read.conditions,[["kiosk_request_id",revokedPending.requestId],["kiosk_device_id",device.device_id]]);}
  await page.locator("#deviceName").fill("DEMO · delayed registration");await page.evaluate(()=>{__attendanceTest.deferRpc="payroll_kiosk_register";});await page.locator("#registerDevice button").click();
  await page.waitForFunction(()=>typeof __attendanceTest.releaseRpc==="function");
  await page.evaluate(()=>{window.__syntheticHidden=true;Object.defineProperty(document,"hidden",{configurable:true,get:()=>window.__syntheticHidden});document.dispatchEvent(new Event("visibilitychange"));});
  await page.evaluate(()=>__attendanceTest.releaseRpc());await idle();
  assert.equal(await page.locator("#adminDialog").isVisible(),false);assert.equal(await page.evaluate(()=>__attendanceTest.clients.some(client=>client.role)),false);
  assert.equal(await page.evaluate(()=>DGV_ATTENDANCE_STORE.get("device")),null,"a late registration response after administrator exit cannot activate the browser");
  assert.ok(await page.evaluate(()=>DGV_ATTENDANCE_STORE.get("registration")),"the encrypted registration draft remains available for an explicit safe retry");
  assert.equal(await page.evaluate(()=>__attendanceTest.calls.filter(call=>call.table).every(call=>["payroll_employees","payroll_attendance_raw"].includes(call.table)&&call.role==="admin")),true,"payroll reads occur only in the ephemeral administrator client");
  assert.deepEqual(errors,[]);
  console.log("Attendance browser passed: admin-only setup, real encrypted local storage, consent, face mismatch/test-only paths, two same-day in/out cycles, receipt-only recovery across reload, cancellation retry, closed-session enrollment guard and revoked-device lockout.");
}finally{await context.close();await browser.close();await new Promise(resolve=>server.close(resolve));}
