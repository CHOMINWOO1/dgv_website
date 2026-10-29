import { installMock } from "./helpers/payroll-browser-mock.mjs";
import { openPayrollView } from "./helpers/payroll-navigation.mjs";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// Real mobile DOM/canvas/PNG and print page, with an isolated synthetic server.
// No real employee names, signatures, identities or production writes are used.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const server=createServer(async(req,res)=>{try{
  const file=path.resolve(root,decodeURIComponent(new URL(req.url,"http://localhost").pathname).replace(/^\/+/,"")||"payroll.html");
  if(!file.startsWith(root+path.sep))throw new Error("Invalid path");
  res.writeHead(200,{"Content-Type":({".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8"})[path.extname(file)]||"application/octet-stream"});res.end(await readFile(file));
}catch{res.writeHead(404);res.end();}});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,channel:process.env.PAYROLL_BROWSER_CHANNEL||"chrome"});
const employee="00000000-0000-4000-8000-000000000001",other="00000000-0000-4000-8000-000000000002",cancelledOnly="00000000-0000-4000-8000-000000000003";
const employeeIdentity="001-DEMO-ID-A",otherIdentity="002-DEMO-ID-B",employeePhone="090-000-0001",otherPhone="090-000-0002";

function seedSignatures(){
  const state=window.__payrollTest,[a,b]=state.db.payroll_employees;
  a.name="DEMO · Nguyễn An";a.phone="090-000-0001";b.name="DEMO · Trần Bình";b.phone="090-000-0002";
  const c={id:"00000000-0000-4000-8000-000000000003",name:"DEMO · Cancelled only",device_user_id:"CANCELLED-ONLY",active:true,phone:"090-000-0003"};state.db.payroll_employees.push(c);
  state.sensitive[a.id]={national_id:"001-DEMO-ID-A",bank_account:"DO-NOT-PRINT-PRIVATE-BANK"};
  state.sensitive[b.id]={national_id:"002-DEMO-ID-B",bank_account:"DO-NOT-PRINT-OTHER-BANK"};
  state.sensitive[c.id]={national_id:"CANCELLED-ID-MUST-NOT-FETCH"};
  const run=(id,employee,month)=>({id,employee_id:employee.id,month,base_amount:1000000,allowances:0,deductions:0,total:1000000,snapshot:{employee_id:employee.id,name:employee.name,device_user_id:employee.device_user_id,minutes:480,baseAmount:1000000,daily:[],unresolved:0},created_at:"2026-10-01T00:00:00Z"});
  state.db.payroll_runs=[run("a-oct",a,"2026-10-01"),run("a-sep",a,"2026-09-01"),run("b-sep",b,"2026-09-01"),run("c-oct",c,"2026-10-01")];
  const payment=(id,run_id,paid_on,amount)=>({id,run_id,paid_on,amount,method:"cash",reference:`DEMO ${id}`,note:"Synthetic fixture",created_at:`${paid_on}T08:00:00Z`});
  state.db.payroll_payments=[payment("prior-signed","a-sep","2026-10-01",150000),payment("before-range","a-sep","2026-09-30",9000),payment("after-range","a-oct","2026-11-01",8000),payment("unsigned","a-oct","2026-10-21",10000),payment("cancelled","a-oct","2026-10-22",20000),payment("other-signed","b-sep","2026-10-01",70000),payment("cancelled-only","c-oct","2026-10-22",40000)];
  state.db.payroll_payment_reversals=[{id:"reversal",payment_id:"cancelled",reason:'DEMO <img src=x onerror="window.__receiptXss=1">',created_at:"2026-10-23T00:00:00Z"},{id:"reversal-only",payment_id:"cancelled-only",reason:"Cancelled-only employee",created_at:"2026-10-23T00:00:00Z"}];
  for(const [id,offset] of [["prior-signed",0],["other-signed",10],["cancelled",20],["cancelled-only",30]]){
    const canvas=document.createElement("canvas");canvas.width=220;canvas.height=80;const ctx=canvas.getContext("2d");ctx.fillStyle="white";ctx.fillRect(0,0,220,80);ctx.strokeStyle="#193c34";ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(10,50);ctx.lineTo(40+offset,15);ctx.lineTo(80,60);ctx.lineTo(140+offset,22);ctx.stroke();
    const bytes=Array.from(atob(canvas.toDataURL("image/png").split(",")[1]),c=>c.charCodeAt(0)),storagePath=`${id}/synthetic.png`;
    state.storageObjects[storagePath]={bytes,mime:"image/png"};
    state.db.payroll_attachments.push({id:`signature-${id}`,payment_id:id,storage_path:storagePath,filename:"synthetic-signature.png",mime_type:"image/png",byte_size:bytes.length,evidence_type:"signature",signed_name:`DEMO ${id}`,acknowledged_at:"2026-10-22T08:00:00Z",created_at:"2026-10-22T08:00:00Z"});
  }
}

async function newContext(role){
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:1});
  await context.addInitScript(()=>{window.print=()=>{window.__printed=true;};});
  await context.route("**/*",async route=>{
    const url=route.request().url();
    if(url.startsWith("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@"))return route.fulfill({contentType:"text/javascript",body:`(${installMock.toString()})(${JSON.stringify(role)});(${seedSignatures.toString()})();`});
    if(!url.startsWith(origin))return route.fulfill({body:""});
    return route.continue();
  });
  return context;
}

const context=await newContext("admin"),page=await context.newPage(),errors=[];
page.on("pageerror",error=>errors.push(error.message));page.setDefaultTimeout(10000);
const field=(form,name)=>page.locator(`#${form} [name="${name}"]`);
const idle=()=>page.waitForFunction(()=>!document.getElementById("workspace").disabled);
const submit=async form=>{await page.locator(`#${form} button[type="submit"]`).click();await idle();};
const refresh=async()=>{await page.locator("#refresh").click();await idle();};
const paymentCalls=()=>page.evaluate(()=>__payrollTest.rpcs.filter(call=>call.name==="payroll_pay").length);
async function drawTouch(){
  await page.locator("#signatureCanvas").scrollIntoViewIfNeeded();const box=await page.locator("#signatureCanvas").boundingBox();
  const client=await context.newCDPSession(page),point=(x,y)=>({x:box.x+box.width*x,y:box.y+box.height*y,radiusX:2,radiusY:2,force:0.8,id:7});
  await client.send("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[point(.08,.7)]});
  for(const [x,y] of [[.2,.2],[.35,.8],[.55,.3],[.8,.6]])await client.send("Input.dispatchTouchEvent",{type:"touchMove",touchPoints:[point(x,y)]});
  await client.send("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]});await client.detach();
}
async function search(from="2026-10-01",to="2026-10-31",id=employee){
  await openPayrollView(page,"payments");
  for(const [selector,value] of [["#rangeFrom",from],["#rangeTo",to]]){await page.locator(selector).fill(value);await page.locator(selector).dispatchEvent("change");}
  await page.locator("#rangeEmployee").selectOption(id);await page.locator("#rangeSearch").click();await idle();
}
async function printReceipts(){
  const event=context.waitForEvent("page");await page.locator("#rangeReceiptPrint").click();const popup=await event;
  await popup.waitForFunction(()=>window.__printed===true);return popup;
}

try{
  // The same real admin gate must protect the new receipt/signature controls.
  for(const role of [null,"manager","staff"]){
    const denied=await newContext(role),deniedPage=await denied.newPage();await deniedPage.goto(origin+"/payroll.html");
    await deniedPage.locator("#loginModal").waitFor({state:"visible"});
    assert.equal(await deniedPage.locator("#payrollApp").isVisible(),false);
    assert.equal(await deniedPage.evaluate(()=>__payrollTest.calls.some(call=>call.table)),false);
    assert.equal(await deniedPage.evaluate(()=>__payrollTest.storageReads.length),0);await denied.close();
  }
  await page.goto(origin+"/payroll.html");await page.locator("#ledgerBody [data-employee]").first().waitFor();
  assert.equal(await page.locator("#rangeEmployee option").count(),4,"initial cached admin load must initialize advanced controls without a month-change workaround");
  await page.locator("#month").fill("2026-10");await page.locator("#month").dispatchEvent("change");await idle();
  await page.locator("#employeeFilter").selectOption(employee);
  await openPayrollView(page,"payments");
  await page.locator("#addPayment").click();await field("paymentForm","paid_on").fill("2026-10-20");await field("paymentForm","amount").fill("100000");await field("paymentForm","note").fill('DEMO <script>window.__receiptXss=1</script>');await submit("paymentForm");
  await page.locator("#evidenceDialog").waitFor({state:"visible"});
  const paid=await page.evaluate(()=>structuredClone(__payrollTest.db.payroll_payments.find(p=>p.request_id)));
  assert.equal(await paymentCalls(),1);assert.equal(await field("evidenceForm","evidence_type").inputValue(),"signature");
  assert.equal(await page.locator("#evidencePaymentSummary").getAttribute("data-payment-id"),paid.id);
  assert.match(await page.locator("#evidencePaymentSummary").innerText(),/2026-10-20/);assert.match(await page.locator("#evidencePaymentSummary").innerText(),/100[.,]000/);
  assert.match(await page.locator("#evidencePaymentSummary").innerText(),/Nguyễn An/);
  assert.equal(await page.locator("#signatureCanvas").evaluate(canvas=>getComputedStyle(canvas).touchAction),"none","phone strokes must not scroll the page");
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,"phone view must fit without horizontal scrolling");
  await field("evidenceForm","signed_name").fill("DEMO · Nguyễn An");await field("evidenceForm","acknowledged").check();await submit("evidenceForm");
  assert.equal(await page.locator("#evidenceDialog").isVisible(),true);assert.equal(await page.evaluate(()=>__payrollTest.uploads.length),0,"blank signature must not upload");
  await drawTouch();const drawingBeforeResize=await page.locator("#signatureCanvas").evaluate(canvas=>canvas.toDataURL());await page.setViewportSize({width:844,height:390});
  assert.equal(await page.locator("#signatureCanvas").evaluate(canvas=>canvas.toDataURL()),drawingBeforeResize,"rotation must preserve the existing signature bitmap");await page.setViewportSize({width:390,height:844});
  await page.locator("#clearSignature").click();await submit("evidenceForm");
  assert.equal(await page.evaluate(()=>__payrollTest.uploads.length),0,"clearing resets the drawn-signature requirement");
  await drawTouch();await page.evaluate(()=>{__payrollTest.failUploadOnce=true;});await submit("evidenceForm");
  assert.equal(await page.locator("#evidenceDialog").isVisible(),true);assert.equal(await paymentCalls(),1);
  await page.evaluate(()=>{__payrollTest.failAttachmentOnce=true;});await submit("evidenceForm");
  assert.equal(await page.locator("#evidenceDialog").isVisible(),true);assert.equal(await paymentCalls(),1);
  const uploadsBeforeRetry=await page.evaluate(()=>__payrollTest.uploads.length);await submit("evidenceForm");
  await page.locator("#evidenceDialog").waitFor({state:"hidden"});assert.equal(await paymentCalls(),1);
  assert.equal(await page.evaluate(()=>__payrollTest.uploads.length),uploadsBeforeRetry,"metadata retry reuses the uploaded immutable PNG");
  const saved=await page.evaluate(id=>__payrollTest.db.payroll_attachments.filter(a=>a.payment_id===id),paid.id);
  assert.equal(saved.length,1);assert.equal(saved[0].evidence_type,"signature");assert.equal(saved[0].mime_type,"image/png");assert.equal(saved[0].signed_name,"DEMO · Nguyễn An");assert.ok(saved[0].acknowledged_at);assert.ok(saved[0].byte_size>100);
  const stored=await page.evaluate(storagePath=>__payrollTest.storageObjects[storagePath],saved[0].storage_path);
  assert.deepEqual(stored.bytes.slice(0,8),[137,80,78,71,13,10,26,10]);
  assert.match(await page.locator(`[data-signature-status="${paid.id}"]`).innerText(),/완료|등록|Đã/);

  if(process.env.PAYROLL_SCREENSHOTS){
    await mkdir(process.env.PAYROLL_SCREENSHOTS,{recursive:true});await page.setViewportSize({width:430,height:1100});await page.locator(`[data-signature="${paid.id}"]`).click();await drawTouch();await field("evidenceForm","acknowledged").check();
    await page.evaluate(()=>{const label=document.createElement("p");label.className="notice";label.textContent="화면 예시 · 합성 직원·서명 / DEMO";document.getElementById("evidenceForm").prepend(label);document.getElementById("evidenceDialog").scrollTop=0;});
    await page.locator("#evidenceDialog").screenshot({path:path.join(process.env.PAYROLL_SCREENSHOTS,"payroll-signature-mobile.png")});await page.locator("#evidenceForm [data-close]").click();
    await page.setViewportSize({width:390,height:844});
  }

  const privateReadsBefore=await page.evaluate(()=>__payrollTest.rpcs.filter(call=>call.name==="payroll_get_sensitive").length);
  assert.equal(privateReadsBefore,0,"normal payroll, payout and signature entry do not decrypt national IDs");
  await search();assert.equal(await page.locator("#rangeReceiptPrint").isDisabled(),false);
  const periodIds=await page.locator("#rangeReceipts [data-payment-id]").evaluateAll(rows=>rows.map(row=>row.dataset.paymentId));
  assert.deepEqual(periodIds.slice().sort(),["prior-signed","unsigned",paid.id].sort(),"paid_on range includes active payments from earlier payroll months, excluding cancelled payments, dates outside the range and other employees");
  assert.deepEqual(await page.evaluate(()=>__payrollTest.rpcs.filter(call=>call.name==="payroll_get_sensitive").map(call=>call.args.p_employee_id)),[employee],"only the active report employee needs one identity read");
  assert.equal(await page.locator('[data-receipt-total="cancelledCount"]').count(),0);
  assert.doesNotMatch(await page.locator("#rangeReceipts").innerText(),/취소|hủy|CANCELLED-ID|DO-NOT-PRINT/);
  for(const value of await page.locator('[data-receipt-field="national-id"]').allTextContents())assert.equal(value,employeeIdentity);
  for(const value of await page.locator('[data-receipt-field="phone"]').allTextContents())assert.equal(value,employeePhone);
  assert.match(await page.locator('[data-payment-card="cancelled"]').innerText(),/취소|hủy/i,"management history still contains the cancelled payment");
  assert.match(await page.locator('[data-receipt-total="activeCount"]').innerText(),/3건/);assert.match(await page.locator('[data-receipt-total="unsignedCount"]').innerText(),/1건/);
  if(process.env.PAYROLL_SCREENSHOTS){await page.setViewportSize({width:1280,height:1000});await page.evaluate(()=>{const label=document.createElement("p");label.className="notice";label.textContent="화면 예시 · 합성 직원·지급·서명 / DEMO";document.getElementById("rangeReceipts").prepend(label);});await page.locator("#rangePanel").screenshot({path:path.join(process.env.PAYROLL_SCREENSHOTS,"payroll-signature-period.png")});}
  const popup=await printReceipts();
  const printedIds=await popup.locator("[data-payment-id]").evaluateAll(rows=>rows.map(row=>row.dataset.paymentId));
  assert.deepEqual(printedIds.slice().sort(),periodIds.slice().sort());
  const printedText=await popup.locator("body").innerText();assert.match(printedText,/2026-09/);assert.match(printedText,/260[.,]000/);assert.doesNotMatch(printedText,/취소|hủy/i);assert.match(printedText,/미서명|미등록|Chưa/);
  assert.ok(printedText.includes(employeeIdentity));assert.ok(printedText.includes(employeePhone));assert.equal(printedText.includes(otherIdentity),false);
  assert.doesNotMatch(printedText,/DO-NOT-PRINT-PRIVATE|other-signed|before-range|after-range/);
  assert.equal(await popup.evaluate(()=>window.__receiptXss),undefined);assert.equal(await popup.locator("script").count(),0);assert.equal(await popup.evaluate(()=>window.opener===null),true);
  const ownSignature=popup.locator(`[data-payment-id="${paid.id}"] img`);assert.equal(await ownSignature.count(),1);
  assert.equal(await ownSignature.evaluate(img=>img.complete&&img.naturalWidth>0),true,"saved PNG must be loaded before print");
  assert.equal(await ownSignature.getAttribute("src"),`data:image/png;base64,${Buffer.from(stored.bytes).toString("base64")}`,"receipt signature must belong to exactly that payment");
  assert.equal(await popup.locator('[data-payment-id="unsigned"] img').count(),0);
  if(process.env.PAYROLL_SCREENSHOTS){await popup.setViewportSize({width:1122,height:794});await popup.evaluate(()=>{const label=document.createElement("p");label.textContent="인쇄 미리보기 · 합성 직원·신분증 번호·전화번호·서명 / DEMO";document.body.prepend(label);});await popup.screenshot({path:path.join(process.env.PAYROLL_SCREENSHOTS,"payroll-signature-receipts.png"),fullPage:true});}await popup.close();await page.setViewportSize({width:390,height:844});
  const retained=await page.evaluate(()=>JSON.stringify({database:__payrollTest.db,app:DGV_PAYROLL_APP.state,local:{...localStorage},session:{...sessionStorage}}));
  assert.equal(retained.includes(employeeIdentity),false,"explicit receipt identities do not enter retained payroll data or browser storage");
  assert.equal(await page.evaluate(()=>__payrollTest.storageReads.some(read=>read.path?.startsWith("cancelled"))),false,"cancelled signatures must not be downloaded");
  assert.equal(await page.evaluate(()=>["cancelled","cancelled-only"].every(id=>__payrollTest.db.payroll_payments.some(p=>p.id===id)&&__payrollTest.db.payroll_payment_reversals.some(r=>r.payment_id===id)&&__payrollTest.db.payroll_attachments.some(a=>a.payment_id===id))),true,"filtered output preserves both cancelled payments, reversals and signatures in management data");
  assert.equal(await page.evaluate(()=>__payrollTest.storageReads.every(read=>read.role==="admin")),true);

  await page.locator("#rangeTo").fill("2026-10-22");await page.locator("#rangeTo").dispatchEvent("change");assert.equal(await page.locator("#rangeReceiptPrint").isDisabled(),true,"changed dates invalidate the prior print scope");
  await search("2026-10-01","2026-10-01",other);
  assert.deepEqual(await page.locator("#rangeReceipts [data-payment-id]").evaluateAll(rows=>rows.map(row=>row.dataset.paymentId)),["other-signed"]);
  assert.equal(await page.locator('[data-receipt-field="national-id"]').innerText(),otherIdentity);assert.equal(await page.locator('[data-receipt-field="phone"]').innerText(),otherPhone);
  assert.equal((await page.locator("#rangeReceipts").innerText()).includes(employeeIdentity),false,"changing employees must not reuse the previous identity");
  const cancelledReads=await page.evaluate(()=>__payrollTest.rpcs.filter(call=>call.name==="payroll_get_sensitive").length);
  await search("2026-10-01","2026-10-31",cancelledOnly);
  assert.equal(await page.locator("#rangeReceipts [data-payment-id]").count(),0);assert.equal(await page.locator("#rangeReceiptPrint").isDisabled(),true);
  assert.equal(await page.evaluate(()=>__payrollTest.rpcs.filter(call=>call.name==="payroll_get_sensitive").length),cancelledReads,"an employee with only cancelled payments never has their identity fetched");
  assert.equal(await page.evaluate(id=>__payrollTest.rpcs.some(call=>call.name==="payroll_get_sensitive"&&call.args.p_employee_id===id),cancelledOnly),false);
  await search("2026-10-01","2026-10-01",employee);
  assert.deepEqual(await page.locator("#rangeReceipts [data-payment-id]").evaluateAll(rows=>rows.map(row=>row.dataset.paymentId)),["prior-signed"],"inclusive boundary dates use paid_on, not payroll month");
  await page.evaluate(()=>{__payrollTest.failDownloadOnce=true;});await search("2026-10-01","2026-10-01",employee);
  assert.equal(await page.locator("#rangeReceiptPrint").isDisabled(),true,"a saved signature that failed to download must never silently disappear from a printed receipt");
  assert.match(await page.locator('[data-receipt-total="unavailableCount"]').innerText(),/1건/);await search("2026-10-01","2026-10-01",employee);assert.equal(await page.locator("#rangeReceiptPrint").isDisabled(),false);
  await page.evaluate(()=>{__payrollTest.failSensitiveReadOnce=true;});await search("2026-10-01","2026-10-01",employee);
  assert.equal(await page.locator("#rangeReceiptPrint").isDisabled(),true,"failed identity reads must not reuse a prior receipt identity");
  assert.equal((await page.locator("#rangeReceipts").innerText()).includes(employeeIdentity),false);
  await search("2026-10-01","2026-10-01",employee);
  // A private response is bound to both the requested range and revision.
  await page.evaluate(()=>{delete __payrollTest.releaseSensitiveRead;__payrollTest.deferSensitiveRead=true;});await page.locator("#rangeSearch").click();await page.waitForFunction(()=>typeof __payrollTest.releaseSensitiveRead==="function");
  await page.evaluate(()=>{document.getElementById("rangeTo").value="2026-10-02";document.getElementById("rangeTo").dispatchEvent(new Event("change"));__payrollTest.releaseSensitiveRead();});await idle();
  assert.equal(await page.locator("#rangeReceipts").innerText(),"");assert.equal(await page.locator("#rangeReceiptPrint").isDisabled(),true,"scope changes discard late private identity responses");
  await search("2026-10-01","2026-10-01",employee);
  await page.evaluate(()=>{delete __payrollTest.releaseSensitiveRead;__payrollTest.deferSensitiveRead=true;});await page.locator("#rangeSearch").click();await page.waitForFunction(()=>typeof __payrollTest.releaseSensitiveRead==="function");
  await page.evaluate(()=>{__payrollTest.db.payroll_revision[0].version++;__payrollTest.releaseSensitiveRead();});await idle();
  assert.equal(await page.locator("#rangeReceipts").innerText(),"");assert.equal(await page.locator("#rangeReceiptPrint").isDisabled(),true,"changed payroll revision cannot mix old identity data with new report records");
  await search("2026-10-01","2026-10-01",employee);
  await page.evaluate(()=>{__payrollTest.deferStorageDownload=true;});await page.locator("#rangeSearch").click();await page.waitForFunction(()=>typeof __payrollTest.releaseStorageDownload==="function");
  await page.evaluate(()=>{document.getElementById("rangeTo").value="2026-10-02";document.getElementById("rangeTo").dispatchEvent(new Event("change"));__payrollTest.releaseStorageDownload();});await idle();
  assert.equal(await page.locator("#rangeReceiptPrint").isDisabled(),true);assert.equal(await page.locator("#rangeReceipts").innerText(),"","a changed date scope discards late downloaded signatures");
  await refresh();assert.equal(await page.locator("#rangeReceiptPrint").isDisabled(),true);assert.equal(await page.locator("#rangeReceipts").innerText(),"");
  // A committed payout with a lost response must retry the same request and
  // open the signature for the existing payment, never create a second payout.
  await page.locator("#addPayment").click();await field("paymentForm","paid_on").fill("2026-10-23");await field("paymentForm","amount").fill("5000");
  const paymentCountBefore=await page.evaluate(()=>__payrollTest.db.payroll_payments.length);await page.evaluate(()=>{__payrollTest.losePaymentResponseOnce=true;});await submit("paymentForm");
  assert.equal(await page.locator("#paymentDialog").isVisible(),true);assert.equal(await page.evaluate(()=>__payrollTest.db.payroll_payments.length),paymentCountBefore+1);
  const committed=await page.evaluate(()=>structuredClone(__payrollTest.db.payroll_payments.at(-1)));await submit("paymentForm");
  assert.equal(await page.evaluate(()=>__payrollTest.db.payroll_payments.length),paymentCountBefore+1);assert.equal(await page.locator("#evidencePaymentSummary").getAttribute("data-payment-id"),committed.id);
  const retries=await page.evaluate(()=>__payrollTest.rpcs.filter(call=>call.name==="payroll_pay").slice(-2));assert.equal(retries[0].args.p_request_id,retries[1].args.p_request_id);
  await page.locator("#evidenceForm [data-close]").click();
  await page.evaluate(()=>{__payrollTest.deferReadFor="payroll_attendance_raw";});await page.locator("#rangeSearch").click();await page.waitForFunction(()=>typeof __payrollTest.releaseRead==="function");
  await page.evaluate(()=>DGV_PAYROLL_APP.db.auth.signOut());await page.evaluate(()=>__payrollTest.releaseRead());await idle();
  assert.equal(await page.locator("#payrollApp").isVisible(),false);assert.equal(await page.locator("#rangeReceipts").innerText(),"");assert.equal(await page.locator("#rangeResult").innerText(),"");assert.equal(await page.locator("#rangeReceiptPrint").isDisabled(),true,"late range reads after logout cannot restore payroll signatures");
  // Logout during the separate private lookup must invalidate its response too.
  await page.reload();await page.waitForFunction(()=>window.DGV_PAYROLL_APP?.state.loaded);await search("2026-10-01","2026-10-01",employee);
  await page.evaluate(()=>{delete __payrollTest.releaseSensitiveRead;__payrollTest.deferSensitiveRead=true;});await page.locator("#rangeSearch").click();await page.waitForFunction(()=>typeof __payrollTest.releaseSensitiveRead==="function");
  await page.evaluate(()=>DGV_PAYROLL_APP.db.auth.signOut());await page.evaluate(()=>__payrollTest.releaseSensitiveRead());await idle();
  assert.equal(await page.locator("#payrollApp").isVisible(),false);assert.equal(await page.locator("#rangeReceipts").innerText(),"");assert.equal(await page.locator("#rangeReceiptPrint").isDisabled(),true);
  assert.equal((await page.locator("body").textContent()).includes(employeeIdentity),false,"logout leaves no identity in the receipt DOM after the late response");
  // Fresh synthetic session: hold the print window during image decoding, then
  // sign out. Private receipt content must close before a deferred print runs.
  await page.reload();await page.waitForFunction(()=>window.DGV_PAYROLL_APP?.state.loaded);assert.equal(await page.locator("#rangeEmployee option").count(),4);await search("2026-10-01","2026-10-01",employee);
  await page.evaluate(()=>{
    const originalOpen=window.open.bind(window);window.__finishPrintDecodes=[];window.__receiptPrintCalls=0;
    window.open=(...args)=>{const popup=originalOpen(...args),nativeDecode=popup.HTMLImageElement.prototype.decode;
      popup.HTMLImageElement.prototype.decode=function(){const image=this;return new Promise((resolve,reject)=>{window.__finishPrintDecodes.push(()=>nativeDecode.call(image).then(resolve,reject));});};
      popup.print=()=>{window.__receiptPrintCalls++;};return popup;
    };
  });
  const pendingPopupEvent=context.waitForEvent("page");await page.locator("#rangeReceiptPrint").click();const pendingPopup=await pendingPopupEvent;
  await page.waitForFunction(()=>window.__finishPrintDecodes.length>0);await page.evaluate(()=>DGV_PAYROLL_APP.db.auth.signOut());
  if(!pendingPopup.isClosed())await pendingPopup.waitForEvent("close");
  await page.evaluate(()=>{for(const finish of window.__finishPrintDecodes)finish();});await idle();
  assert.equal(await page.evaluate(()=>window.__receiptPrintCalls),0,"logout while decoding a receipt must cancel the pending print");
  assert.equal(await page.locator("#rangeReceipts").innerText(),"");
  assert.deepEqual(errors,[]);
  console.log("Payroll signature browser passed: admin-only mobile signatures/retry, active-only paid-date receipts with intact cancelled history, exact employee identity/phone output, no cancelled-only identity or image requests, private lookup failure/scope/revision/logout guards and safe captured print.");
}finally{await context.close();await browser.close();await new Promise(resolve=>server.close(resolve));}
