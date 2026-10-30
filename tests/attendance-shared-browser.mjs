import { installAttendanceMock,installAttendanceFaceMock } from "./helpers/attendance-browser-mock.mjs";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile,mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// A separate synthetic backend serves independent browser contexts. Real UI,
// encrypted IndexedDB and media streams run locally; no production API is used.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const server=createServer(async(req,res)=>{try{
  if(req.url==="/test-backend"){res.writeHead(200,{"Content-Type":"text/html"});return res.end("<!doctype html><title>Synthetic backend</title>");}
  const file=path.resolve(root,new URL(req.url,"http://localhost").pathname.slice(1)||"attendance.html");if(!file.startsWith(root+path.sep))throw new Error("Invalid path");
  const bytes=await readFile(file);res.writeHead(200,{"Content-Type":({".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8"})[path.extname(file)]||"application/octet-stream"});res.end(bytes);
}catch{res.writeHead(404);res.end();}});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,channel:process.env.PAYROLL_BROWSER_CHANNEL||"chrome"});
const backendContext=await browser.newContext(),backend=await backendContext.newPage();await backend.goto(origin+"/test-backend");
await backend.evaluate(()=>{window.DGV_SUPABASE_CONFIG={authAccounts:{admin:"admin@dgv.local"}};});await backend.evaluate(installAttendanceMock);
const a="00000000-0000-4000-8000-000000000001",b="00000000-0000-4000-8000-000000000002",c="00000000-0000-4000-8000-000000000006";
await backend.evaluate(async()=>{
  __attendanceTest.employees.push({id:"00000000-0000-4000-8000-000000000003",name:"DEMO · Service recipient",device_user_id:"SERVICE",payee_type:"service",employment_status:"active",active:true},{id:"00000000-0000-4000-8000-000000000004",name:"DEMO · Archived",device_user_id:"ARCHIVED",payee_type:"employee",employment_status:"terminated",active:false,archived_at:"2026-10-29T00:00:00Z"});
  window.__backendClients={public:supabase.createClient(),admin:supabase.createClient()};
  await __backendClients.admin.auth.signInWithPassword({email:"admin@dgv.local",password:"dgv-v2/admin/admin-test"});
});
const contexts=[],errors=[];
const remote=payload=>backend.evaluate(async({role,name,args})=>await __backendClients[role==="admin"?"admin":"public"].rpc(name,args),payload);
const serverState=()=>backend.evaluate(()=>structuredClone({devices:__attendanceTest.devices,grants:__attendanceTest.grants,faces:__attendanceTest.faceProfiles,events:__attendanceTest.events,calls:__attendanceTest.calls}));
async function newDevice(legacy){
  const employees=await backend.evaluate(()=>structuredClone(__attendanceTest.employees));
  const context=await browser.newContext({viewport:{width:800,height:1280},isMobile:true,hasTouch:true});contexts.push(context);
  await context.exposeBinding("__attendanceRemote",(_source,payload)=>remote(payload));
  await context.addInitScript(()=>{const interval=window.setInterval.bind(window);window.__attendanceIntervals=[];window.setInterval=(fn,ms,...args)=>ms===30000?(window.__attendanceIntervals.push(()=>fn(...args)),0):interval(fn,ms,...args);});
  await context.route("**/*",async route=>{
    const url=route.request().url();
    if(url.startsWith("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@"))return route.fulfill({contentType:"text/javascript",body:`(${installAttendanceMock.toString()})(${JSON.stringify({employees})});`});
    if(url.startsWith(origin+"/assets/attendance-face.js"))return route.fulfill({contentType:"text/javascript",body:`(${installAttendanceFaceMock.toString()})();`});
    if(legacy&&url.startsWith(origin+"/assets/attendance-store.js"))return route.fulfill({contentType:"text/javascript",body:(await readFile(path.join(root,"assets/attendance-store.js"),"utf8"))+`;window.__legacyReady=(async()=>{const input=${JSON.stringify(legacy)};await DGV_ATTENDANCE_STORE.put("device",input.device);for(const face of input.faces)await DGV_ATTENDANCE_STORE.put("face:"+face.employeeId,face);})();`});
    if(legacy&&url.startsWith(origin+"/assets/attendance.js"))return route.fulfill({contentType:"text/javascript",body:`window.__legacyReady.then(()=>{${await readFile(path.join(root,"assets/attendance.js"),"utf8")}});`});
    if(!url.startsWith(origin))return route.fulfill({body:"/* isolated test */"});return route.continue();
  });
  const page=await context.newPage();page.on("pageerror",error=>errors.push(error.message));page.setDefaultTimeout(10000);
  await page.goto(origin+"/attendance.html");return page;
}
const idle=page=>page.waitForFunction(()=>!document.getElementById("settings").disabled);
async function login(page){await page.bringToFront();await page.locator("#settings").click();await page.locator("#adminPassword").fill("admin-test");await page.locator("#adminLogin button").click();await page.locator("#adminWorkspace").waitFor({state:"visible"});await idle(page);}
async function setup(page,name){await login(page);await page.locator("#deviceName").fill(name);await page.locator("#registerDevice button").click();await idle(page);await page.locator("#enrollSection").waitFor({state:"visible"});}
async function closeAdmin(page){await page.locator("#closeAdmin").click();await page.locator("#adminDialog").waitFor({state:"hidden"});await idle(page);}
async function select(page,id){await page.bringToFront();await page.locator("#employee").selectOption(id);await idle(page);}
async function sync(page){await page.bringToFront();await page.locator("#syncFaces").click();await idle(page);}
async function enroll(page,id,marker=0){await page.locator("#enrollEmployee").selectOption(id);await page.locator("#consent").check();await page.evaluate(marker=>{__faceTest.marker=marker;},marker);await page.locator("#enrollFace").click();await idle(page);}
async function expectReady(page){await page.locator("#testFace").waitFor({state:"visible"});await page.waitForFunction(()=>!document.getElementById("testFace").disabled);}
async function assertEncrypted(page){
  const values=await page.evaluate(async()=>{const db=await new Promise(resolve=>{const request=indexedDB.open("hana-attendance-v1",1);request.onsuccess=()=>resolve(request.result);});const records=await new Promise(resolve=>{const request=db.transaction("records").objectStore("records").getAll();request.onsuccess=()=>resolve(request.result);});return {encrypted:records.every(row=>row.iv instanceof Uint8Array&&row.cipher instanceof ArrayBuffer),text:records.map(row=>new TextDecoder().decode(row.cipher)).join(""),storage:JSON.stringify({...localStorage,...sessionStorage})};});
  assert.equal(values.encrypted,true);assert.doesNotMatch(values.text,/samples|Nguyễn|synthetic-admin-session/);assert.doesNotMatch(values.storage,/samples|synthetic-admin-session|admin-test/);
}

try{
  const one=await newDevice();await setup(one,"DEMO · Shared tablet A");
  assert.equal(await one.locator('#enrollEmployee option[value="00000000-0000-4000-8000-000000000003"]').count(),0,"external service payees cannot enroll as employees");
  await closeAdmin(one);await select(one,b);
  assert.equal(await one.locator("#employee").isEnabled(),true);assert.equal(await one.locator("#clockIn").isDisabled(),true);assert.match(await one.locator("#employeeAvailability").innerText(),/등록|đăng ký/);
  await login(one);await enroll(one,a);await closeAdmin(one);await select(one,a);await expectReady(one);
  assert.equal((await serverState()).faces[0].face_revision,1);await assertEncrypted(one);
  await one.locator("#clockIn").click();await idle(one);assert.equal((await serverState()).events.length,1);

  const two=await newDevice();assert.equal(await two.evaluate(()=>DGV_ATTENDANCE_STORE.get("device")),null);assert.deepEqual(await two.evaluate(()=>DGV_ATTENDANCE_STORE.faces()),[]);assert.deepEqual(await two.evaluate(()=>DGV_ATTENDANCE_STORE.sharedFaces()),[]);
  await setup(two,"DEMO · Shared tablet B");await closeAdmin(two);await select(two,a);await expectReady(two);
  assert.equal((await serverState()).faces.length,1);assert.equal(await two.evaluate(()=>__attendanceTest.calls.filter(call=>call.rpc==="payroll_kiosk_face_save").length),0,"a new device retrieves the existing face without enrolling again");
  assert.equal(await two.locator(`#employee option[value="${b}"]`).count(),1,"all active staff are listed even when they have no face profile");
  assert.equal(await two.locator('#employee option[value="00000000-0000-4000-8000-000000000003"],#employee option[value="00000000-0000-4000-8000-000000000004"]').count(),0);
  await two.evaluate(()=>{__faceTest.matched=false;});await two.locator("#clockOut").click();await idle(two);assert.equal((await serverState()).events.length,1,"a different face cannot use another employee's shared template");
  await two.evaluate(()=>{__faceTest.matched=true;});await two.locator("#clockOut").click();await idle(two);assert.deepEqual((await serverState()).events.map(event=>event.punch_type),["in","out"]);
  const sharedEvents=(await serverState()).events;assert.notEqual(sharedEvents[0].device_id,sharedEvents[1].device_id);await assertEncrypted(two);
  await two.locator("#clockOut").click();await idle(two);assert.equal((await serverState()).events.length,2,"a repeated out cannot create a second attendance event");
  if(await two.locator("#pending").isVisible()){await two.locator("#checkReceipt").click();await idle(two);}

  await select(two,a);await two.evaluate(id=>{window.__selectedEmployeeOption=document.querySelector('#employee option[value="'+id+'"]');},a);await sync(two);
  assert.equal(await two.locator("#employee").inputValue(),a);assert.equal(await two.evaluate(id=>window.__selectedEmployeeOption===document.querySelector('#employee option[value="'+id+'"]'),a),true,"unchanged roster refresh preserves the actual option node used by a native selector");
  await two.evaluate(async id=>DGV_ATTENDANCE_STORE.remove("shared-face:"+id),a);await sync(two);await expectReady(two);
  assert.equal((await two.evaluate(()=>DGV_ATTENDANCE_STORE.sharedFaces())).length,1,"missing local encrypted cache is restored from the central profile");

  await login(one);await enroll(one,a,.25);await closeAdmin(one);assert.equal((await serverState()).faces[0].face_revision,2);
  await backend.evaluate(()=>{__attendanceTest.failRpcOnce="payroll_kiosk_face_get";});await two.bringToFront();await sync(two);
  if(await two.locator("#testFace").isDisabled())await sync(two);await expectReady(two);
  assert.equal(await two.locator("#employee").inputValue(),a,"reconnecting with a newer face profile preserves the selected employee");
  await two.locator("#testFace").click();await idle(two);assert.equal(await two.evaluate(()=>__faceTest.lastTemplate.samples[0][0]),.251);
  assert.equal((await serverState()).events.length,2,"testing a synchronized face does not clock attendance");

  await two.evaluate(()=>{__faceTest.defer=true;});await two.locator("#clockIn").click();await two.waitForFunction(()=>typeof __faceTest.release==="function");
  const profile=(await serverState()).faces.find(profile=>profile.employee_id===a),changed=structuredClone(profile.template);changed.samples=changed.samples.map(vector=>vector.map(value=>value+.25));
  await remote({role:"admin",name:"payroll_kiosk_face_save",args:{p_employee_id:a,p_template:changed,p_consent_version:"synthetic-shared-test",p_expected_revision:2,p_request_id:"00000000-0000-4000-8000-000000009003"}});
  await two.evaluate(()=>__faceTest.release());await idle(two);assert.equal((await serverState()).events.length,2,"verification with an obsolete face revision cannot record a punch");
  const stalePunch=await two.evaluate(()=>__attendanceTest.calls.filter(call=>call.rpc==="payroll_kiosk_punch").at(-1));assert.equal(stalePunch.args.p_face_revision,2);
  if(await two.locator("#pending").isVisible()){await two.locator("#checkReceipt").click();await idle(two);}await sync(two);await expectReady(two);

  await login(one);await one.locator("#enrollEmployee").selectOption(a);await one.locator("#removeFace").click();await idle(one);await closeAdmin(one);
  assert.equal((await serverState()).faces.find(profile=>profile.employee_id===a).template,null);
  await sync(two);await select(two,a);assert.equal(await two.locator("#clockIn").isDisabled(),true);assert.equal(await two.locator("#testFace").isDisabled(),true);assert.equal(await two.locator("#employee").isEnabled(),true,"deleted face registration does not hide the employee or make the name selector unusable");

  const legacyDevice={device_id:"11111111-1111-4111-8111-111111111111",name:"DEMO · Legacy tablet",token:"c".repeat(64)},legacyTemplate=structuredClone(profile.template);
  await backend.evaluate(({device,a,b,c})=>{__attendanceTest.devices.push({...device,status:"active"});for(const [id,grant]of[[a,"legacy-a"],[b,"legacy-b"],[c,"legacy-c"]])__attendanceTest.grants.push({id:grant,device_id:device.device_id,employee_id:id});__attendanceTest.employees.push({id:c,device_user_id:"TEST-6",name:"DEMO · Mismatched legacy",active:true,payee_type:"employee",employment_status:"active",archived_at:null});},{device:legacyDevice,a,b,c});
  const legacy={device:legacyDevice,faces:[{employeeId:a,deviceId:legacyDevice.device_id,enrollmentId:"legacy-a",template:legacyTemplate},{employeeId:b,deviceId:legacyDevice.device_id,enrollmentId:"legacy-b",template:legacyTemplate},{employeeId:c,deviceId:legacyDevice.device_id,enrollmentId:"wrong-enrollment",template:legacyTemplate}]};
  const three=await newDevice(legacy);await three.waitForFunction(()=>document.getElementById("connection").textContent.includes("서버 연결됨"));await sync(three);
  const afterMigration=await serverState();assert.equal(afterMigration.faces.find(profile=>profile.employee_id===b)?.face_revision,1,"a matching legacy local face migrates automatically without another admin login");
  assert.equal(afterMigration.faces.find(profile=>profile.employee_id===a).template,null,"legacy caches cannot resurrect a centrally deleted face");assert.equal(afterMigration.faces.some(profile=>profile.employee_id===c),false,"mismatched local enrollment cannot become a shared identity");
  assert.equal(await three.evaluate(()=>__attendanceTest.calls.some(call=>call.method==="signInWithPassword")),false);
  assert.equal(await three.evaluate(async id=>(await DGV_ATTENDANCE_STORE.faces()).some(face=>face.employeeId===id),c),true,"failed or unmatched legacy migration preserves the original encrypted local template");
  await select(three,b);await expectReady(three);await assertEncrypted(three);
  await backend.evaluate(id=>{__attendanceTest.devices.find(device=>device.device_id===id).status="revoked";},legacyDevice.device_id);await sync(three);
  assert.equal(await three.locator("#employee").isDisabled(),true);assert.equal(await three.locator("#clockIn").isDisabled(),true);assert.equal(await three.locator("#testFace").isDisabled(),true,"a revoked device cannot use a valid cached shared face");

  await two.bringToFront();await sync(two);await select(two,b);await expectReady(two);
  if(process.env.PAYROLL_SCREENSHOTS){await mkdir(process.env.PAYROLL_SCREENSHOTS,{recursive:true});await two.evaluate(()=>{const p=document.createElement("p");p.className="notice";p.textContent="공유 얼굴·직원 선택 예시 / DEMO · 합성 얼굴·모의 카메라";document.querySelector(".shell").prepend(p);});await two.screenshot({path:path.join(process.env.PAYROLL_SCREENSHOTS,"attendance-shared-tablet.png"),fullPage:true});}
  assert.deepEqual(errors,[]);
  console.log("Shared attendance browser passed: independent devices share centrally versioned faces, full active roster and stable selection, encrypted cache recovery, different-person and stale-revision denial, central delete tombstone, safe automatic legacy migration and revoked-device lockout.");
}finally{for(const context of contexts)await context.close();await backendContext.close();await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
