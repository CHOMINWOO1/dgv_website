import {installAttendanceMock,installAttendanceFaceMock} from "./helpers/attendance-browser-mock.mjs";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {readFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {chromium} from "playwright";
import {execFileSync} from "node:child_process";

// Actual page, encryption and camera streams; only the remote boundary and
// camera permission/initialization completion are controlled. No live writes.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const probe=process.argv.includes("--probe");
const baseline=probe&&process.argv.includes("--baseline");
const sources=Object.fromEntries(await Promise.all(["attendance.js","attendance-store.js","attendance-face.js"].map(async name=>[name,baseline?execFileSync("git",["show",`HEAD:assets/${name}`],{cwd:root,encoding:"utf8"}):await readFile(path.join(root,"assets",name),"utf8")])));
const server=createServer(async(req,res)=>{try{
  const file=path.resolve(root,new URL(req.url,"http://localhost").pathname.slice(1)||"attendance.html");
  if(!file.startsWith(root+path.sep))throw new Error("Invalid path");
  const bytes=await readFile(file);res.writeHead(200,{"Content-Type":({".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8"})[path.extname(file)]||"application/octet-stream"});res.end(bytes);
}catch{res.writeHead(404);res.end();}});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,channel:process.env.PAYROLL_BROWSER_CHANNEL||"chrome"});
const employeeId="00000000-0000-4000-8000-000000000001";
const device={device_id:"00000000-0000-4000-8000-000000000099",name:"DEMO · recovery tablet",token:"a".repeat(64),status:"active"};
const template={version:1,model:"dlib-resnet128-faceapi-1.7.15-tiny68-v1",samples:Array.from({length:3},()=>Array(128).fill(.1)),createdAt:"2026-10-30T00:00:00Z"};
const seed={devices:[device],faceProfiles:[{employee_id:employeeId,face_revision:1,template}]};
const contexts=[],errors=[];

function installTimers(){
  const set=window.setTimeout.bind(window),clear=window.clearTimeout.bind(window),interval=window.setInterval.bind(window);
  const timers=window.__recoveryTimers=new Map();
  window.setTimeout=(fn,ms,...args)=>{
    if(ms<15000||ms>60000)return set(fn,ms,...args);
    const id=set(()=>{timers.delete(id);fn(...args);},300000);timers.set(id,{ms,fire(){clear(id);timers.delete(id);fn(...args);}});return id;
  };
  window.clearTimeout=id=>{timers.delete(id);clear(id);};
  window.setInterval=(fn,ms,...args)=>ms===30000?0:interval(fn,ms,...args);
  const NativeWorker=window.Worker,audit=window.__workerAudit={created:0,terminated:0,frames:0,started:0};
  window.Worker=class extends NativeWorker{
    constructor(...args){super(...args);audit.created++;this.ended=false;this.addEventListener("message",event=>{if(event.data.kind==="started")audit.started++;});}
    postMessage(message,...args){if(message.type==="frame")audit.frames++;return super.postMessage(message,...args);}
    terminate(){if(!this.ended){this.ended=true;audit.terminated++;}return super.terminate();}
  };
}
function installRecoveryControls(){
  const original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices),play=HTMLMediaElement.prototype.play;
  const state=window.__recovery={mediaMode:"normal",playMode:"normal",requests:[],streams:[],plays:[]};
  const store=window.DGV_ATTENDANCE_STORE;
  window.DGV_ATTENDANCE_STORE={...store,get:async id=>{
    if(id==="pending"&&state.deferPending){state.deferPending=false;return new Promise(resolve=>{state.releasePending=async()=>resolve(await store.get(id));});}
    return store.get(id);
  }};
  async function stream(){const value=await original();state.streams.push(value);return value;}
  navigator.mediaDevices.getUserMedia=async()=>{
    if(state.mediaMode!=="defer")return stream();
    state.mediaMode="normal";
    return new Promise(resolve=>state.requests.push({released:false,async release(){const value=await stream();this.released=true;resolve(value);return value.id;}}));
  };
  HTMLMediaElement.prototype.play=async function(){
    await play.call(this);
    if(state.playMode!=="defer")return;
    state.playMode="normal";await new Promise(resolve=>state.plays.push({release:resolve}));
  };
}
async function openPage({actualFace=false,workerMode=null,blockWorker=false}={}){
  const context=await browser.newContext({viewport:{width:800,height:1280},isMobile:true,hasTouch:true});contexts.push(context);
  await context.addInitScript(installTimers);const page=await context.newPage(),libraries=[];
  let libraryReady;const libraryRequested=new Promise(resolve=>{libraryReady=resolve;});
  page.setDefaultTimeout(6000);page.on("pageerror",error=>errors.push(error.message));
  await context.route("**/*",async route=>{
    const url=route.request().url();
    if(blockWorker&&url===origin+"/attendance.html")return route.fulfill({contentType:"text/html",headers:{"Content-Security-Policy":"worker-src 'none'"},body:await readFile(path.join(root,"attendance.html"),"utf8")});
    if(url.startsWith("https://cdn.jsdelivr.net/npm/@supabase/"))return route.fulfill({contentType:"text/javascript",body:`(${installAttendanceMock.toString()})(${JSON.stringify(seed)});`});
    if(url.startsWith(origin+"/assets/attendance-store.js"))return route.fulfill({contentType:"text/javascript",body:sources["attendance-store.js"]+`;window.__recoveryReady=DGV_ATTENDANCE_STORE.put("device",${JSON.stringify(device)});`});
    if(url.startsWith(origin+"/assets/attendance-face.js"))return route.fulfill({contentType:"text/javascript",body:`if(typeof window!=="undefined"){(${installAttendanceFaceMock.toString()})();(${installRecoveryControls.toString()})();}`+(actualFace?sources["attendance-face.js"]:"")});
    if(url.startsWith(origin+"/assets/attendance.js"))return route.fulfill({contentType:"text/javascript",body:`__recoveryReady.then(()=>{${sources["attendance.js"]}});`});
    if(url.includes("/attendance-face-worker.js")&&workerMode)return route.fulfill({contentType:"text/javascript",body:`onmessage=event=>{const {id,type}=event.data;if(type==="load"){postMessage({id,value:{backend:"wasm",model:"dlib-resnet128-faceapi-1.7.15-tiny68-v1"}});return;}postMessage({kind:"started"});${workerMode==="freeze"?"while(true){}":workerMode==="error"?'throw new Error("Synthetic inference failure")':"/* intentionally unresolved inference */"}};`});
    if(url.includes("/vendor/attendance-face/face-api-")){libraries.push(route);libraryReady();return;}
    if(!url.startsWith(origin))return route.fulfill({body:"/* isolated synthetic boundary */"});return route.continue();
  });
  await page.goto(origin+"/attendance.html");await page.waitForFunction(()=>document.getElementById("connection").textContent.includes("서버 연결됨")&&!document.getElementById("employee").disabled);
  await page.locator("#employee").selectOption(employeeId);await page.waitForFunction(()=>!document.getElementById("testFace").disabled);
  return {page,libraries,libraryRequested};
}
const idle=page=>page.waitForFunction(()=>!document.getElementById("settings").disabled&&!document.getElementById("employee").disabled);
const snapshot=page=>page.evaluate(()=>({roster:document.getElementById("rosterStatus").textContent,employeeDisabled:document.getElementById("employee").disabled,settingsDisabled:document.getElementById("settings").disabled,cancelVisible:!document.getElementById("cancelFace").hidden,pendingVisible:!document.getElementById("pending").hidden,timeoutMs:[...__recoveryTimers.values()].map(t=>t.ms)}));
async function fireTimeout(page,ms){
  const count=await page.evaluate(ms=>{const timers=[...__recoveryTimers.values()].filter(t=>t.ms===ms);for(const timer of timers)timer.fire();return timers.length;},ms);
  assert.ok(count>0,`the actual ${ms}ms recovery timeout must be installed`);
}
async function noPunch(page){assert.equal(await page.evaluate(()=>__attendanceTest.calls.filter(call=>call.rpc==="payroll_kiosk_punch").length),0);}
try{
  const {page}=await openPage();
  await page.evaluate(()=>{__recovery.mediaMode="defer";});await page.locator("#openCamera").click();await page.waitForFunction(()=>__recovery.requests.length===1);
  assert.equal((await snapshot(page)).employeeDisabled,true,"camera startup reproduces the reported disabled employee selector with a populated roster");
  if(probe){
    console.log("Unresolved getUserMedia before recovery:",JSON.stringify(await snapshot(page)));
    const real=await openPage({actualFace:true});await real.page.locator("#testFace").click();await real.libraryRequested;
    await real.page.locator("#cancelFace").click();await real.page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    console.log("Cancelled real model library wait:",JSON.stringify(await snapshot(real.page)));
  }else{
    await page.locator("#cancelFace").waitFor({state:"visible"});await page.locator("#cancelFace").click();await idle(page);await noPunch(page);
    // A second camera may open before the cancelled permission request resolves.
    await page.locator("#openCamera").click();await idle(page);
    const newerId=await page.evaluate(()=>document.getElementById("camera").srcObject.id);
    const oldId=await page.evaluate(()=>__recovery.requests[0].release());
    await page.waitForFunction(id=>__recovery.streams.find(s=>s.id===id).getTracks().every(t=>t.readyState==="ended"),oldId);
    assert.equal(await page.evaluate(()=>document.getElementById("camera").srcObject.id),newerId,"late cancelled camera cannot replace or stop a newer stream");
    assert.equal(await page.evaluate(id=>__recovery.streams.find(s=>s.id===id).getTracks().every(t=>t.readyState==="live"),newerId),true);
    await page.locator("#stopCamera").click();

    await page.evaluate(()=>{__recovery.mediaMode="defer";});await page.locator("#openCamera").click();await page.waitForFunction(()=>__recovery.requests.length===2);
    await fireTimeout(page,18000);await idle(page);assert.match(await page.locator("#notice").textContent(),/18초|18 giây/);
    await page.locator("#openCamera").click();await idle(page);const retryId=await page.evaluate(()=>document.getElementById("camera").srcObject.id);
    const timedId=await page.evaluate(()=>__recovery.requests[1].release());await page.waitForFunction(id=>__recovery.streams.find(s=>s.id===id).getTracks().every(t=>t.readyState==="ended"),timedId);await noPunch(page);
    assert.equal(await page.evaluate(()=>document.getElementById("camera").srcObject.id),retryId,"late timed-out camera cannot replace the successful retry");
    assert.equal(await page.evaluate(id=>__recovery.streams.find(s=>s.id===id).getTracks().every(t=>t.readyState==="live"),retryId),true);await page.locator("#stopCamera").click();

    // Playback itself can hang after permission has already supplied a stream.
    await page.evaluate(()=>{__recovery.playMode="defer";});await page.locator("#openCamera").click();await page.waitForFunction(()=>__recovery.plays.length===1);
    await fireTimeout(page,18000);await idle(page);assert.equal(await page.evaluate(()=>__recovery.streams.at(-1).getTracks().every(t=>t.readyState==="ended")),true);
    await page.evaluate(()=>__recovery.plays[0].release());await noPunch(page);

    // The normal verification path remains functional after both recoveries.
    await page.locator("#testFace").click();await idle(page);await noPunch(page);
    await page.locator("#clockIn").click();await idle(page);
    assert.equal(await page.evaluate(()=>__attendanceTest.events.length),1);assert.equal(await page.evaluate(()=>__attendanceTest.events[0].punch_type),"in");

    for(const mode of ["cancel","hidden"]){
      const preflight=await openPage({actualFace:true,workerMode:"freeze"}),p=preflight.page;
      await p.evaluate(()=>{__attendanceTest.deferRpc="payroll_kiosk_roster";});
      await p.locator("#clockIn").click();await p.waitForFunction(()=>typeof __attendanceTest.releaseRpc==="function");
      if(mode==="cancel")await p.locator("#cancelFace").click();else await p.evaluate(()=>{Object.defineProperty(document,"hidden",{configurable:true,value:true});document.dispatchEvent(new Event("visibilitychange"));Object.defineProperty(document,"hidden",{configurable:true,value:false});});
      await idle(p);await p.locator("#employee").selectOption("");
      await p.evaluate(()=>__attendanceTest.releaseRpc());await p.waitForFunction(()=>!document.getElementById("syncFaces").disabled);
      assert.equal(await p.evaluate(()=>__faceTest.cameraStarts),0,"cancelled preflight must never open a late camera");
      assert.equal(await p.evaluate(()=>__workerAudit.created),0);await noPunch(p);
    }
    const initialRead=await openPage({actualFace:true,workerMode:"freeze"}),ip=initialRead.page;
    await ip.evaluate(()=>{__recovery.deferPending=true;});await ip.locator("#clockIn").click();await ip.waitForFunction(()=>typeof __recovery.releasePending==="function");
    await ip.evaluate(()=>{Object.defineProperty(document,"hidden",{configurable:true,value:true});document.dispatchEvent(new Event("visibilitychange"));Object.defineProperty(document,"hidden",{configurable:true,value:false});});
    await idle(ip);await ip.locator("#employee").selectOption("");await ip.evaluate(()=>__recovery.releasePending());
    await ip.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await ip.evaluate(()=>__faceTest.cameraStarts),0,"cancel during initial pending read cannot start a later authentication");
    assert.equal(await ip.evaluate(()=>__workerAudit.created),0);await noPunch(ip);
    const blocked=await openPage({actualFace:true,blockWorker:true});
    await blocked.page.locator("#testFace").click();await idle(blocked.page);await noPunch(blocked.page);
    assert.equal(await blocked.page.evaluate(()=>__recovery.streams.every(s=>s.getTracks().every(t=>t.readyState==="ended"))),true,"CSP worker denial closes the camera and releases the selector");
    const uncertain=await openPage(),pendingPage=uncertain.page;
    await pendingPage.evaluate(()=>{__attendanceTest.deferRpc="payroll_kiosk_punch";__attendanceTest.losePunchResponse=true;});
    await pendingPage.locator("#clockIn").click();await pendingPage.waitForFunction(()=>typeof __attendanceTest.releaseRpc==="function");
    const pendingRequest=await pendingPage.evaluate(()=>DGV_ATTENDANCE_STORE.get("pending"));assert.ok(pendingRequest);
    await pendingPage.locator("#cancelFace").click();await pendingPage.evaluate(()=>__attendanceTest.releaseRpc());
    await pendingPage.waitForFunction(()=>!document.getElementById("settings").disabled);
    assert.equal((await pendingPage.evaluate(()=>DGV_ATTENDANCE_STORE.get("pending"))).requestId,pendingRequest.requestId,"cancelling an already sent request preserves its uncertain receipt reference");
    await pendingPage.locator("#checkReceipt").click();await idle(pendingPage);
    assert.equal(await pendingPage.evaluate(()=>__attendanceTest.events.length),1);
    assert.equal(await pendingPage.evaluate(()=>__attendanceTest.calls.filter(call=>call.rpc==="payroll_kiosk_punch").length),1,"receipt recovery cannot submit a duplicate punch");

    for(const mode of ["cancel","timeout"]){
      const real=await openPage({actualFace:true});await real.page.locator("#testFace").click();await real.libraryRequested;
      if(mode==="cancel")await real.page.locator("#cancelFace").click();else await fireTimeout(real.page,60000);
      await idle(real.page);await noPunch(real.page);
      if(mode==="timeout")assert.match(await real.page.locator("#notice").textContent(),/모델|mô hình/);
      // A delayed library response must not revive a cancelled verification.
      for(const route of real.libraries)await route.abort("failed").catch(()=>{});
      await real.page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await idle(real.page);await noPunch(real.page);
    }
    for(const mode of ["cancel","timeout","deadline","error","hidden"]){
      const real=await openPage({actualFace:true,workerMode:mode==="error"?"error":"freeze"});
      await real.page.locator("#testFace").click();await real.page.waitForFunction(()=>__workerAudit.started===1);
      // The worker is executing a synchronous infinite kernel; the UI must
      // still run, render controls, and be able to terminate that execution.
      assert.equal(await real.page.evaluate(()=>2+2),4);
      if(mode==="cancel")await real.page.locator("#cancelFace").click();
      if(mode==="timeout")await fireTimeout(real.page,15000);
      if(mode==="deadline")await fireTimeout(real.page,45000);
      if(mode==="hidden")await real.page.evaluate(()=>{Object.defineProperty(document,"hidden",{configurable:true,value:true});document.dispatchEvent(new Event("visibilitychange"));});
      await idle(real.page);await noPunch(real.page);
      assert.equal(await real.page.evaluate(()=>__workerAudit.terminated),1,mode+" kills the old inference worker");
      assert.equal(await real.page.evaluate(()=>__recovery.streams.every(s=>s.getTracks().every(t=>t.readyState==="ended"))),true,mode+" closes camera tracks");
      assert.equal(await real.page.locator("#cancelFace").isVisible(),false);
      if(mode==="timeout")assert.match(await real.page.locator("#notice").textContent(),/응답하지|không phản hồi/);
      // Changing the selected employee after recovery must remain possible.
      await real.page.locator("#employee").selectOption("");await real.page.locator("#employee").selectOption(employeeId);
      if(mode==="hidden")await real.page.evaluate(()=>{Object.defineProperty(document,"hidden",{configurable:true,value:false});});
      if(mode!=="error"){
        await real.page.waitForFunction(()=>!document.getElementById("testFace").disabled);
        await real.page.locator("#testFace").click();await real.page.waitForFunction(()=>__workerAudit.started===2);
        assert.equal(await real.page.evaluate(()=>__workerAudit.created),2,"retry uses a fresh worker");
        await real.page.locator("#cancelFace").click();await idle(real.page);await noPunch(real.page);
      }
    }
    for(const mode of ["cancel","timeout"]){
      const real=await openPage({actualFace:true,workerMode:"freeze"});
      await real.page.locator("#settings").click();await real.page.locator("#adminPassword").fill("admin-test");await real.page.locator("#adminLogin button").click();
      await real.page.locator("#adminWorkspace").waitFor({state:"visible"});await idle(real.page);
      await real.page.locator("#enrollEmployee").selectOption(employeeId);await real.page.locator("#consent").check();
      await real.page.locator("#enrollFace").click();await real.page.waitForFunction(()=>__workerAudit.started===1);
      if(mode==="cancel")await real.page.locator("#cancelEnrollment").click();else await fireTimeout(real.page,15000);
      await idle(real.page);
      assert.equal(await real.page.locator("#enrollEmployee").isEnabled(),true);
      assert.equal(await real.page.locator("#cancelEnrollment").isVisible(),false);
      assert.equal(await real.page.evaluate(()=>__recovery.streams.every(s=>s.getTracks().every(t=>t.readyState==="ended"))),true);
      assert.equal(await real.page.evaluate(()=>__attendanceTest.calls.filter(call=>call.rpc==="payroll_kiosk_face_save").length),0,"stalled enrollment cannot replace an existing template");
      await noPunch(real.page);await real.page.locator("#closeAdmin").click();await idle(real.page);
      await real.page.locator("#employee").selectOption("");await real.page.locator("#employee").selectOption(employeeId);
    }
    const enrolling=await openPage({actualFace:true,workerMode:"freeze"}),ep=enrolling.page;
    await ep.locator("#settings").click();await ep.locator("#adminPassword").fill("admin-test");await ep.locator("#adminLogin button").click();
    await ep.locator("#adminWorkspace").waitFor({state:"visible"});await idle(ep);
    await ep.locator("#enrollEmployee").selectOption(employeeId);await ep.locator("#consent").check();
    await ep.evaluate(()=>{__attendanceTest.deferRpc="payroll_kiosk_roster";});await ep.locator("#enrollFace").click();await ep.waitForFunction(()=>typeof __attendanceTest.releaseRpc==="function");
    await ep.locator("#cancelEnrollment").click();await idle(ep);await ep.evaluate(()=>__attendanceTest.releaseRpc());await ep.waitForFunction(()=>!document.getElementById("syncFaces").disabled);
    assert.equal(await ep.evaluate(()=>__faceTest.cameraStarts),0);assert.equal(await ep.evaluate(()=>__workerAudit.created),0);
    assert.equal(await ep.evaluate(()=>__attendanceTest.calls.filter(call=>call.rpc==="payroll_kiosk_face_save").length),0);await noPunch(ep);
    assert.deepEqual(errors,[]);
    console.log("Attendance recovery browser passed: bounded camera/model waits; synchronous inference worker stalls killed by cancel/15s timeout/45s deadline/tab hiding; worker errors recover selector and camera; employee changes and fresh retry succeed; no stale punch; normal face/punch succeeds.");
  }
}finally{
  await Promise.all(contexts.map(context=>context.close()));await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
