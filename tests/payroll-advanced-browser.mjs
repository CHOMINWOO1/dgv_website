import { installMock } from "./helpers/payroll-browser-mock.mjs";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// Real scripts + actual DOM, isolated synthetic Supabase boundary; never contacts production.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const mime={".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8"};
const server=createServer(async(req,res)=>{try{const file=path.resolve(root,decodeURIComponent(new URL(req.url,"http://localhost").pathname).replace(/^\/+/,"")||"payroll.html");if(!file.startsWith(root+path.sep))throw new Error("invalid path");res.writeHead(200,{"Content-Type":mime[path.extname(file)]||"application/octet-stream"});res.end(await readFile(file));}catch{res.writeHead(404);res.end();}});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,channel:process.env.PAYROLL_BROWSER_CHANNEL||"chrome"});
const context=await browser.newContext({viewport:{width:1440,height:1000}});
await context.addInitScript(()=>{window.print=()=>{window.__printed=true;};});
await context.route("**/*",route=>{const url=route.request().url();if(url.startsWith("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@"))return route.fulfill({contentType:"text/javascript",body:`(${installMock.toString()})("admin");`});if(!url.startsWith(origin))return route.fulfill({body:""});return route.continue();});
const page=await context.newPage(),errors=[];
page.on("pageerror",error=>errors.push(error.message));
page.setDefaultTimeout(10000);
const employee="00000000-0000-4000-8000-000000000001";
const idle=()=>page.waitForFunction(()=>!document.getElementById("workspace").disabled);
const field=(form,name)=>page.locator(`#${form} [name="${name}"]`);
const submit=async form=>{await page.locator(`#${form} button[type="submit"]`).click();await idle();};
const refresh=async()=>{await page.locator("#refresh").click();await idle();};
async function download(button){const event=page.waitForEvent("download");await page.locator(button).click();const file=await event;const bytes=await readFile(await file.path());assert.equal(bytes.readUInt32LE(),0x04034b50);return {name:file.suggestedFilename(),text:bytes.toString("utf8")};}

try{
  await page.goto(`${origin}/payroll.html`);await page.locator("#ledgerBody [data-employee]").first().waitFor();
  await page.locator("#month").fill("2026-10");await page.locator("#month").dispatchEvent("change");await idle();
  await page.locator("#employeeFilter").selectOption(employee);
  assert.equal(await page.locator('#taxCenter a[href="admin.html"],#taxCenter a[href="expense.html"]').count(),0,"payroll exports stay on payroll page");
  assert.equal(await page.locator('[name="fund_account_id"],#fundAccount').count(),0);

  await page.locator("#editEmployee").click();
  await field("employeeForm","phone").fill("090-TEST-0001");
  await field("employeeForm","employment_type").selectOption("part_time");
  await field("employeeForm","hire_date").fill("2026-06-01");
  await field("employeeForm","payment_method").selectOption("mixed");
  await submit("employeeForm");
  const savedEmployee=await page.evaluate(id=>__payrollTest.db.payroll_employees.find(e=>e.id===id),employee);
  assert.equal(savedEmployee.employment_type,"part_time");assert.equal(savedEmployee.phone,"090-TEST-0001");assert.equal(savedEmployee.payment_method,"mixed");

  await page.locator("#sensitiveInfo").click();await page.locator("#sensitiveDialog").waitFor({state:"visible"});
  await field("sensitiveForm","bank_account").fill("SYNTHETIC-PRIVATE-ACCOUNT");
  await field("sensitiveForm","national_id").fill("SYNTHETIC-PRIVATE-ID");
  await field("sensitiveForm","reason").fill("Synthetic private data test");await submit("sensitiveForm");
  assert.equal(await page.evaluate(id=>__payrollTest.sensitive[id].bank_account,employee),"SYNTHETIC-PRIVATE-ACCOUNT");
  assert.equal(await field("sensitiveForm","bank_account").inputValue(),"","closing clears decrypted private fields");
  await page.locator("#sensitiveInfo").click();assert.equal(await field("sensitiveForm","bank_account").inputValue(),"SYNTHETIC-PRIVATE-ACCOUNT");
  await page.locator("#sensitiveForm [data-close]").click();
  assert.doesNotMatch(await page.locator("#payrollApp").innerText(),/SYNTHETIC-PRIVATE/);

  await page.evaluate(id=>{__payrollTest.db.payroll_days.push({id:"preserved-day",employee_id:id,work_date:"2026-10-01",day_type:"work",reason:"Keep this manual day"});},employee);
  await refresh();const originalDay=await page.evaluate(()=>structuredClone(__payrollTest.db.payroll_days[0]));
  await page.locator("#monthSchedule").click();await submit("scheduleForm");
  assert.deepEqual(await page.evaluate(()=>__payrollTest.db.payroll_days.find(d=>d.id==="preserved-day")),originalDay);
  assert.equal(await page.evaluate(id=>__payrollTest.db.payroll_days.filter(d=>d.employee_id===id).length,employee),31);
  assert.equal(await page.evaluate(()=>__payrollTest.db.payroll_days.find(d=>d.work_date==="2026-10-04").day_type),"rest");
  await page.evaluate(()=>{__payrollTest.db.payroll_days=__payrollTest.db.payroll_days.filter(d=>d.id==="preserved-day");});await refresh();

  await page.locator("#saveReview").click();await idle();
  assert.equal(await page.evaluate(()=>__payrollTest.db.payroll_reviews.length),1);
  const reviewedRevision=await page.evaluate(()=>__payrollTest.db.payroll_revision[0].version);
  await page.locator("#saveReview").click();await idle();assert.equal(await page.evaluate(()=>__payrollTest.db.payroll_reviews.length),1,"exact review retry is idempotent");
  await page.locator("#adjustmentNote").fill("Changed review justification at same source revision");await page.locator("#saveReview").click();await idle();
  assert.equal(await page.evaluate(()=>__payrollTest.db.payroll_reviews.length),2,"changed review content keeps a new audit record");
  assert.equal(await page.evaluate(()=>__payrollTest.db.payroll_revision[0].version),reviewedRevision,"reviews alone do not advance data revision");
  await page.locator("#finalize").click();await page.locator('#confirmForm input[type="checkbox"]').check();await submit("confirmForm");
  const originalRun=await page.evaluate(()=>structuredClone(__payrollTest.db.payroll_runs[0]));assert.equal(originalRun.total,240000);
  assert.equal(await page.evaluate(()=>__payrollTest.db.payroll_reviews.length),2,"finalize reuses the identical review without suppressing changed reviews");
  await page.locator("#editEmployee").click();await field("employeeForm","payment_method").selectOption("bank");await submit("employeeForm");
  for(const [method,amount] of [["cash",100000],["bank",50000]]){
    await page.locator("#addPayment").click();assert.equal(await field("paymentForm","method").inputValue(),"bank","employee preferred payment method opens by default");await field("paymentForm","paid_on").fill("2026-10-05");await field("paymentForm","amount").fill(String(amount));await field("paymentForm","method").selectOption(method);await field("paymentForm","reference").fill("TEST-REFERENCE");await submit("paymentForm");
  }
  const payments=await page.evaluate(()=>structuredClone(__payrollTest.db.payroll_payments));
  await page.locator("#adjustRun").click();await field("amendForm","amount").fill("10000");await field("amendForm","reason").fill("Synthetic approved adjustment");await submit("amendForm");
  await page.locator(`[data-reverse="${payments[1].id}"]`).click();await field("amendForm","reason").fill("Synthetic duplicate payment reversal");await submit("amendForm");
  assert.deepEqual(await page.evaluate(()=>__payrollTest.db.payroll_runs[0]),originalRun);
  assert.deepEqual(await page.evaluate(()=>__payrollTest.db.payroll_payments),payments);
  assert.match(await page.locator("#paymentArea").innerText(),/250[.,]000/);assert.match(await page.locator("#paymentArea").innerText(),/150[.,]000/);

  // Storage upload succeeded but metadata failed: retry must retain object/id and upload only once.
  await page.locator(`[data-evidence="${payments[0].id}"]`).click();
  await field("evidenceForm","file").setInputFiles({name:"synthetic-receipt.pdf",mimeType:"application/pdf",buffer:Buffer.from("%PDF-1.4\nSynthetic receipt only\n%%EOF")});
  await page.evaluate(()=>{__payrollTest.failAttachmentOnce=true;});await submit("evidenceForm");
  assert.equal(await page.locator("#evidenceDialog").isVisible(),true);assert.equal(await page.evaluate(()=>__payrollTest.uploads.length),1);
  await submit("evidenceForm");assert.equal(await page.evaluate(()=>__payrollTest.uploads.length),1);assert.equal(await page.evaluate(()=>__payrollTest.db.payroll_attachments.length),1);
  assert.equal(await page.evaluate(()=>__payrollTest.uploads[0].upsert),false);

  await page.locator(`[data-evidence="${payments[0].id}"]`).click();await field("evidenceForm","evidence_type").selectOption("signature");
  await field("evidenceForm","signed_name").fill("Synthetic Test A");await submit("evidenceForm");
  assert.equal(await page.locator("#evidenceDialog").isVisible(),true);assert.equal(await page.evaluate(()=>__payrollTest.uploads.length),1);
  const canvas=await page.locator("#signatureCanvas").boundingBox();
  await page.mouse.move(canvas.x+20,canvas.y+35);await page.mouse.down();await page.mouse.move(canvas.x+130,canvas.y+60,{steps:12});await page.mouse.move(canvas.x+210,canvas.y+35,{steps:8});await page.mouse.up();
  await field("evidenceForm","acknowledged").check();await submit("evidenceForm");
  const signature=await page.evaluate(()=>__payrollTest.db.payroll_attachments.find(a=>a.evidence_type==="signature"));
  assert.equal(signature.signed_name,"Synthetic Test A");assert.ok(signature.acknowledged_at);assert.equal(signature.mime_type,"image/png");assert.ok(signature.byte_size>100);

  // Prior payroll paid inside the chosen dates must appear in payment-date range.
  await page.evaluate(id=>{
    __payrollTest.db.payroll_runs.push({id:"prior-run",employee_id:id,month:"2026-09-01",base_amount:300000,allowances:0,deductions:0,total:300000,snapshot:{employee_id:id,name:"Test A",minutes:480,daily:[{date:"2026-09-30",checkIn:"2026-09-30T10:00:00",checkOut:"2026-09-30T20:00:00",minutes:480,issues:[]}],unresolved:0}});
    for(const paid_on of ["2026-09-30","2026-10-01"])__payrollTest.db.payroll_payments.push({id:`prior-${paid_on}`,run_id:"prior-run",amount:20000,paid_on,method:"cash"});
    for(const time of ["10:00:00","20:00:00"])__payrollTest.db.payroll_attendance_raw.push({id:`prior-${time}`,employee_id:id,occurred_at:`2026-09-30T${time}`,device_id:"1"});
  },employee);await refresh();
  await page.locator("#rangeFrom").fill("2026-09-30");await page.locator("#rangeTo").fill("2026-10-01");await page.locator("#rangeEmployee").selectOption(employee);await page.locator("#rangeSearch").click();await idle();
  assert.match(await page.locator("#rangeResult").innerText(),/16h 0m/);assert.match(await page.locator("#rangeResult").innerText(),/40[.,]000/);assert.match(await page.locator("#rangeResult").innerText(),/2026-09-30/);
  const rangeWorkbook=await download("#rangeExport");assert.match(rangeWorkbook.name,/2026-09-30_2026-10-01/);assert.match(rangeWorkbook.text,/2026-09/);
  // Another admin's correction must be fetched by range search even without page refresh.
  await page.evaluate(id=>{__payrollTest.db.payroll_payment_reversals.push({id:"remote-reversal",payment_id:"prior-2026-10-01",reason:"Remote correction"});__payrollTest.db.payroll_employees.find(e=>e.id===id).name="Remote refreshed A";__payrollTest.db.payroll_revision[0].version++;},employee);
  await page.locator("#rangeSearch").click();await idle();
  assert.match(await page.locator("#rangeResult .range-summary").innerText(),/20[.,]000/);assert.doesNotMatch(await page.locator("#rangeResult .range-summary").innerText(),/40[.,]000/);assert.match(await page.locator("#rangeResult").innerText(),/Remote refreshed A/);assert.match(await page.locator("#rangeResult").innerText(),/Đã hủy/);
  assert.match((await download("#rangeExport")).text,/Remote correction/,"range export uses freshly fetched reversals");
  const rangeReads=await page.evaluate(()=>__payrollTest.calls.filter(c=>c.table==="payroll_payments"&&c.operation==="select").length);
  await page.evaluate(()=>{__payrollTest.bumpRevisionReadFor="payroll_payments";});await page.locator("#rangeSearch").click();await idle();
  assert.equal(await page.evaluate(()=>__payrollTest.calls.filter(c=>c.table==="payroll_payments"&&c.operation==="select").length),rangeReads+4,"range search retries inconsistent read (each attempt fetches records plus empty end page)");
  assert.match(await page.locator("#rangeResult .range-summary").innerText(),/20[.,]000/);
  await page.locator("#rangeTo").fill("2026-10-02");await page.locator("#rangeTo").dispatchEvent("change");assert.equal(await page.locator("#rangeExport").isDisabled(),true);

  // Seven direct report downloads and real popup printing; hostile source text stays text.
  await page.evaluate(id=>{const name='<img src=x onerror="window.__payrollXss=1"><script>window.__payrollXss=1</script>';__payrollTest.db.payroll_employees.find(e=>e.id===id).name=name;__payrollTest.db.payroll_runs.find(r=>r.month==="2026-10-01").snapshot.name=name;},employee);await refresh();
  for(const kind of ["ledger","attendance","parttime","cash","bank","outstanding","tax"]){
    await page.locator("#exportKind").selectOption(kind);await page.locator("#previewTax").click();await idle();
    assert.equal(await page.locator("#downloadTax").isDisabled(),true);assert.equal(await page.locator("#printTax").isDisabled(),true);
    await page.locator("#taxReviewed").check();const workbook=await download("#downloadTax");assert.match(workbook.name,/\.xlsx$/);assert.doesNotMatch(workbook.text,/SYNTHETIC-PRIVATE/);
    const popupEvent=page.waitForEvent("popup");await page.locator("#printTax").click();const popup=await popupEvent;await popup.waitForFunction(()=>window.__printed===true);
    assert.equal(await popup.locator("script,img").count(),0);assert.equal(await popup.evaluate(()=>window.__payrollXss),undefined);assert.equal(await popup.locator("table").count()>0,true);assert.match(await popup.locator("body").innerText(),/2026-10/);
    assert.equal(await popup.evaluate(()=>window.opener===null),true);await popup.close();
  }
  assert.equal(await page.evaluate(()=>window.__payrollXss),undefined);

  // A failed month reload must invalidate both prior previews and date-range exports.
  await page.evaluate(()=>{__payrollTest.failRead=true;});await page.locator("#month").fill("2026-11");await page.locator("#month").dispatchEvent("change");await idle();
  assert.equal(await page.locator("#taxPreview").isVisible(),false);assert.equal(await page.locator("#rangeExport").isDisabled(),true);assert.equal(await page.locator("#previewTax").isDisabled(),true);assert.equal(await page.locator("#rangeSearch").isDisabled(),true);
  assert.equal(await page.locator("#rangeResult").innerText(),"");assert.equal(await page.locator("#comparisonResult").innerText(),"");
  await page.evaluate(id=>{__payrollTest.failRead=false;__payrollTest.db.payroll_employees.find(e=>e.id===id).name="Test A";__payrollTest.db.payroll_runs.find(r=>r.month==="2026-10-01").snapshot.name="Test A";},employee);
  await page.locator("#month").fill("2026-10");await page.locator("#month").dispatchEvent("change");await idle();

  // Backups use the actual browser crypto path. Remote restore access/atomicity
  // is covered by SQL; this checks the UI's envelope, password, and retry flow.
  const password="Synthetic-archive-password-2026";
  await page.locator("#openBackup").click();await field("archiveForm","password").fill(password);await field("archiveForm","confirmed").check();
  const archiveEvent=page.waitForEvent("download");await submit("archiveForm");const archive=await archiveEvent,archiveBytes=await readFile(await archive.path());
  assert.match(archive.suggestedFilename(),/\.payroll$/);assert.doesNotMatch(archiveBytes.toString(),/SYNTHETIC-PRIVATE|Test A|synthetic-receipt/);assert.equal(JSON.parse(archiveBytes).format,"DGV_PAYROLL_ENCRYPTED");
  assert.equal(await field("archiveForm","password").inputValue(),"");
  await page.locator("#openRestore").click();await field("archiveForm","archive_file").setInputFiles({name:"synthetic.payroll",mimeType:"application/octet-stream",buffer:archiveBytes});await field("archiveForm","password").fill("wrong-password-twelve");await field("archiveForm","confirmed").check();await submit("archiveForm");
  assert.equal(await page.evaluate(()=>__payrollTest.rpcs.filter(r=>r.name==="payroll_restore").length),0,"wrong password must not call restore");
  await field("archiveForm","password").fill(password);await submit("archiveForm");assert.match(await page.locator("#archiveDialog .dialog-error").innerText(),/EMPTY_DATABASE/);
  const originalCounts=await page.evaluate(()=>Object.fromEntries(Object.entries(__payrollTest.db).map(([table,rows])=>[table,rows.length])));
  await page.evaluate(()=>{for(const table of Object.keys(__payrollTest.db))__payrollTest.db[table]=table==="payroll_revision"?[{id:1,version:1}]:[];__payrollTest.storageObjects={};__payrollTest.failUploadOnce=true;});
  await submit("archiveForm");assert.equal(await page.locator("#archiveDialog").isVisible(),true,"partial evidence failure stays retryable");
  await submit("archiveForm");assert.equal(await page.locator("#archiveDialog").isVisible(),false);
  assert.deepEqual(await page.evaluate(()=>Object.fromEntries(Object.entries(__payrollTest.db).map(([table,rows])=>[table,rows.length]))),originalCounts);
  assert.equal(await page.evaluate(()=>Object.keys(__payrollTest.storageObjects).length),2);assert.equal(await page.evaluate(id=>__payrollTest.sensitive[id].national_id,employee),"SYNTHETIC-PRIVATE-ID");

  if(process.env.PAYROLL_SCREENSHOTS){
    const folder=process.env.PAYROLL_SCREENSHOTS;await mkdir(folder,{recursive:true});
    await page.locator("#exportKind").selectOption("tax");await page.locator("#previewTax").click();await idle();await page.locator("#taxReviewed").check();
    await page.evaluate(()=>{const banner=document.createElement("p");banner.textContent="화면 미리보기 · 예시 데이터 / Bản xem thử · Dữ liệu mẫu";banner.className="notice";document.getElementById("taxCenter").prepend(banner);});
    await page.locator("#taxCenter").screenshot({path:path.join(folder,"payroll-tax-desktop.png")});
    const popupEvent=page.waitForEvent("popup");await page.locator("#printTax").click();const popup=await popupEvent;await popup.waitForFunction(()=>window.__printed===true);
    await popup.evaluate(()=>{const banner=document.createElement("p");banner.textContent="화면 미리보기 · 예시 데이터 / Bản xem thử · Dữ liệu mẫu";document.body.prepend(banner);});
    await popup.screenshot({path:path.join(folder,"payroll-print-preview.png"),fullPage:true});await popup.close();
    await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.locator("#taxCenter").screenshot({path:path.join(folder,"payroll-tax-mobile.png")});await page.setViewportSize({width:1440,height:1000});
  }

  // Effective rule and approval form: extra actual hours require explicit interval approval.
  await page.evaluate(id=>{__payrollTest.db.payroll_runs=[];__payrollTest.db.payroll_payments=[];__payrollTest.db.payroll_reviews=[];__payrollTest.db.payroll_run_adjustments=[];__payrollTest.db.payroll_payment_reversals=[];__payrollTest.db.payroll_attachments=[];__payrollTest.db.payroll_employees.find(e=>e.id===id).name="Test A";__payrollTest.db.payroll_attendance_raw.find(r=>r.employee_id===id&&r.occurred_at==="2026-10-01T20:00:00").occurred_at="2026-10-01T23:00:37";__payrollTest.db.payroll_revision[0].version++;},employee);await refresh();
  assert.equal(await page.locator("#finalize").isDisabled(),true);
  await page.locator("#newRule").click();await field("ruleForm","effective_from").fill("2026-10-01");await field("ruleForm","ot_enabled").check();await field("ruleForm","reason").fill("Synthetic reviewed overtime rules");await submit("ruleForm");
  assert.equal(await page.evaluate(()=>__payrollTest.db.payroll_rule_versions.length),1);assert.equal(await page.locator("#finalize").isDisabled(),true,"rule alone does not approve hours");
  await page.locator('[data-day="2026-10-01"]').click();await page.locator("#fillCandidates").click();
  assert.match(await field("dayForm","overtime_intervals").inputValue(),/20:00:00.*23:00:37/);assert.match(await field("dayForm","night_intervals").inputValue(),/22:00:00.*23:00:37/);
  await field("dayForm","reason").fill("Synthetic verified times");await field("dayForm","approval_reason").fill("Synthetic manager verified overtime and night intervals");await submit("dayForm");
  const approved=await page.evaluate(()=>DGV_PAYROLL_APP.state.summaries.find(s=>s.employee_id===DGV_PAYROLL_APP.state.selected));
  assert.ok(approved.regularOvertimeMinutes>180&&approved.regularOvertimeMinutes<181);assert.ok(approved.nightMinutes>60&&approved.nightMinutes<61);assert.ok(approved.statutoryAmount>135000);assert.equal(await page.locator("#finalize").isDisabled(),false);
  await page.locator('[data-day="2026-10-01"]').click();assert.match(await field("dayForm","overtime_intervals").inputValue(),/23:00:37/);await page.locator("#dayForm [data-close]").click();

  // Fresh fixture: review persistence includes monetary draft values, not just
  // the attendance snapshot and note. Reload must retain what was reviewed.
  await page.reload();await page.locator("#ledgerBody [data-employee]").first().waitFor();
  await page.locator("#month").fill("2026-10");await page.locator("#month").dispatchEvent("change");await idle();
  const otherEmployee="00000000-0000-4000-8000-000000000002";
  for(const [employeeId,finalAllowance] of [[employee,100],[otherEmployee,200]]){
    await page.locator("#employeeFilter").selectOption(employeeId);
    await page.locator("#allowances").fill("100");await page.locator("#adjustmentNote").fill("Same reviewed monetary adjustment");
    await page.locator("#saveReview").click();await idle();
    assert.equal(await page.locator("#allowances").inputValue(),"100","saved allowance survives the automatic reload");
    await refresh();assert.equal(await page.locator("#allowances").inputValue(),"100","saved allowance survives explicit refresh");
    assert.equal(await page.locator("#adjustmentNote").inputValue(),"Same reviewed monetary adjustment");
    if(finalAllowance===200){
      const version=await page.evaluate(()=>__payrollTest.db.payroll_revision[0].version);
      await page.locator("#allowances").fill("200");await page.locator("#saveReview").click();await idle();
      assert.equal(await page.locator("#allowances").inputValue(),"200");
      assert.equal(await page.evaluate(id=>__payrollTest.db.payroll_reviews.filter(r=>r.employee_id===id).length,employeeId),2,"changed allowance with unchanged note creates a new review");
      assert.equal(await page.evaluate(()=>__payrollTest.db.payroll_revision[0].version),version);
      await page.locator("#saveReview").click();await idle();
      assert.equal(await page.evaluate(id=>__payrollTest.db.payroll_reviews.filter(r=>r.employee_id===id).length,employeeId),2,"exact monetary review retry does not duplicate");
    }
    await page.locator("#finalize").click();await page.locator('#confirmForm input[type="checkbox"]').check();await submit("confirmForm");
    const run=await page.evaluate(id=>__payrollTest.db.payroll_runs.find(r=>r.employee_id===id),employeeId);
    assert.equal(run.allowances,finalAllowance);assert.equal(run.total,240000+finalAllowance);
    assert.equal(run.snapshot.reviewedAmounts.allowances,finalAllowance);assert.equal(run.snapshot.reviewedAmounts.total,run.total);
    assert.equal(await page.evaluate(id=>__payrollTest.db.payroll_reviews.filter(r=>r.employee_id===id).length,employeeId),finalAllowance===100?1:2,"finalization reuses its exact saved monetary review");
  }
  assert.deepEqual(errors,[]);
  console.log("Payroll advanced browser passed: employee/private fields, preserved month schedule, review/finalize, immutable adjustments/reversals, receipt metadata retry, acknowledged canvas signature, cross-month actual-payment range, seven direct Excel + safe print popups, stale-preview lockout, encrypted backup/restore retry, explicit overtime/night approval, saved monetary review retention and exact replay.");
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
