import { installMock } from "./helpers/payroll-browser-mock.mjs";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// Synthetic identities only. Real browser + real app scripts; every remote
// request is intercepted. Encryption/transactional authorization are SQL tests.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const mime={".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8"};
const server=createServer(async(req,res)=>{try{const file=path.resolve(root,decodeURIComponent(new URL(req.url,"http://localhost").pathname).replace(/^\/+/,"")||"payroll.html");if(!file.startsWith(root+path.sep))throw new Error("invalid path");res.writeHead(200,{"Content-Type":mime[path.extname(file)]||"application/octet-stream"});res.end(await readFile(file));}catch{res.writeHead(404);res.end();}});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,channel:process.env.PAYROLL_BROWSER_CHANNEL||"chrome"});
const context=await browser.newContext({viewport:{width:1440,height:1000}});
await context.addInitScript(()=>{window.print=()=>{window.__printed=true;};});
await context.route("**/*",route=>{const url=route.request().url();if(url.startsWith("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@"))return route.fulfill({contentType:"text/javascript",body:`(${installMock.toString()})("admin");`});if(!url.startsWith(origin))return route.fulfill({body:""});return route.continue();});
const page=await context.newPage(),errors=[],downloads=[];
page.on("pageerror",error=>errors.push(error.message));page.on("download",download=>downloads.push(download));page.setDefaultTimeout(10000);
const existingEmployee="00000000-0000-4000-8000-000000000001",otherEmployee="00000000-0000-4000-8000-000000000002";
const firstId="001234567890",changedId="000987654320",taxIdentity="000123450007",taxCode="000987654",bankAccount="000PRIVATE-BANK-ONLY";
const field=(form,name)=>page.locator(`#${form} [name="${name}"]`);
const idle=()=>page.waitForFunction(()=>!document.getElementById("workspace").disabled);
const submit=async form=>{await page.locator(`#${form} button[type="submit"]`).click();await idle();};
const refresh=async()=>{await page.locator("#refresh").click();await idle();};
async function ready(){await page.locator("#ledgerBody [data-employee]").first().waitFor();await page.locator("#month").fill("2026-10");await page.locator("#month").dispatchEvent("change");await idle();}
async function selectEmployee(id){await page.locator("#employeeFilter").selectOption(id);await page.locator("#employeeDetail").waitFor({state:"visible"});}
async function openNew(device,name,id){await page.locator("#addEmployee").click();await page.locator("#employeeDialog").waitFor({state:"visible"});await field("employeeForm","device_user_id").fill(device);await field("employeeForm","name").fill(name);if(id!==undefined)await field("employeeForm","national_id").fill(id);}
async function openEdit(){await page.locator("#editEmployee").click();await page.locator("#employeeDialog").waitFor({state:"visible"});}
async function workbookDownload(){const event=page.waitForEvent("download");await page.locator("#downloadTax").click();const download=await event;await idle();return (await readFile(await download.path())).toString("utf8");}
async function preview(kind){await page.locator("#exportKind").selectOption(kind);await page.locator("#previewTax").click();await idle();await page.locator("#taxPreview").waitFor({state:"visible"});}
async function assertNoPublicIdentity(id){
  const text=await page.evaluate(()=>JSON.stringify({database:__payrollTest.db,app:DGV_PAYROLL_APP.state,writes:__payrollTest.calls.filter(call=>call.operation!=="select"),storage:{local:{...localStorage},session:{...sessionStorage}}}));
  assert.equal(text.includes(id),false,"national ID must not enter employee rows, public audit, payroll snapshots, app state or browser storage");
}

try{
  await page.goto(`${origin}/payroll.html`);await ready();
  assert.equal(await page.evaluate(()=>__payrollTest.rpcs.filter(call=>call.name==="payroll_get_sensitive").length),0,"normal payroll load never decrypts identifiers");
  await openNew("00301","Synthetic Identity New");
  assert.equal(await field("employeeForm","national_id").evaluate(input=>input.type),"text");
  assert.equal(await field("employeeForm","national_id").getAttribute("autocomplete"),"off");
  assert.equal(await field("employeeForm","national_id").getAttribute("maxlength"),"300");
  assert.equal(await field("employeeForm","national_id").evaluate(input=>input.required),true);
  await submit("employeeForm");
  assert.equal(await page.evaluate(()=>__payrollTest.rpcs.filter(call=>call.name==="payroll_save_employee").length),0,"blank required ID cannot submit a manual employee");
  await field("employeeForm","national_id").fill(firstId);
  await page.evaluate(()=>{__payrollTest.failEmployeeSaveOnce=true;});await submit("employeeForm");
  assert.equal(await page.locator("#employeeDialog").isVisible(),true);
  assert.equal(await page.evaluate(()=>__payrollTest.db.payroll_employees.length),2,"failed atomic save creates no public employee");
  assert.equal(await page.evaluate(()=>Object.keys(__payrollTest.sensitive).length),0,"failed atomic save creates no partial private record");
  assert.equal(await field("employeeForm","national_id").inputValue(),firstId,"an unsuccessful request remains retryable");
  const firstRequest=await page.evaluate(()=>structuredClone(__payrollTest.rpcs.filter(call=>call.name==="payroll_save_employee").at(-1).args));
  assert.equal(firstRequest.p_national_id,firstId);
  assert.equal(firstRequest.p_employee.device_user_id,"00301");
  assert.equal("national_id" in firstRequest.p_employee,false);
  await submit("employeeForm");await page.locator("#employeeDialog").waitFor({state:"hidden"});
  const newEmployee=firstRequest.p_employee_id;
  assert.equal(await page.evaluate(id=>__payrollTest.sensitive[id].national_id,newEmployee),firstId);
  assert.equal(await page.evaluate(()=>__payrollTest.db.payroll_employees.length),3);
  assert.equal(await field("employeeForm","national_id").inputValue(),"");
  assert.equal(await page.evaluate(()=>__payrollTest.calls.filter(call=>call.table==="payroll_employees"&&call.operation!=="select").length),0,"manual employee writes use only the atomic RPC");
  await assertNoPublicIdentity(firstId);

  // Editing only the identifier must preserve all encrypted bank/tax keys.
  await page.evaluate(({id,bank})=>{Object.assign(__payrollTest.sensitive[id],{bank_name:"Synthetic Bank",bank_account:bank,account_holder:"Synthetic Holder",tax_id:"000-TEST-TAX"});},{id:newEmployee,bank:bankAccount});
  await selectEmployee(newEmployee);await openEdit();
  assert.equal(await field("employeeForm","national_id").inputValue(),firstId);
  await field("employeeForm","national_id").fill("");await submit("employeeForm");assert.equal(await page.locator("#employeeDialog").isVisible(),true);
  await field("employeeForm","national_id").fill(changedId);await field("employeeForm","name").fill("Synthetic Identity Edited");
  await page.evaluate(()=>{__payrollTest.failEmployeeSaveOnce=true;});await submit("employeeForm");
  assert.equal(await page.evaluate(id=>__payrollTest.sensitive[id].national_id,newEmployee),firstId);
  assert.equal(await page.evaluate(id=>__payrollTest.db.payroll_employees.find(row=>row.id===id).name,newEmployee),"Synthetic Identity New");
  await submit("employeeForm");
  assert.deepEqual(await page.evaluate(id=>__payrollTest.sensitive[id],newEmployee),{national_id:changedId,bank_name:"Synthetic Bank",bank_account:bankAccount,account_holder:"Synthetic Holder",tax_id:"000-TEST-TAX"});
  await assertNoPublicIdentity(changedId);await assertNoPublicIdentity(bankAccount);
  await openEdit();await field("employeeForm","national_id").fill("000CANCELLED-DRAFT");await page.locator("#employeeForm [data-close]").click();
  await page.waitForFunction(()=>document.querySelector('#employeeForm [name="national_id"]').value==="");
  assert.equal(await field("employeeForm","national_id").inputValue(),"","cancel clears the decrypted/draft identifier");
  assert.equal(await page.evaluate(id=>__payrollTest.sensitive[id].national_id,newEmployee),changedId);

  // A stale bank-details dialog cannot overwrite a more recently changed ID.
  await page.locator("#sensitiveInfo").click();await page.locator("#sensitiveDialog").waitFor({state:"visible"});
  await field("sensitiveForm","reason").fill("Synthetic concurrent update check");
  await page.evaluate(id=>{__payrollTest.sensitive[id].national_id="000CONCURRENT-ID";__payrollTest.db.payroll_revision[0].version++;},newEmployee);
  await submit("sensitiveForm");
  assert.equal(await page.locator("#sensitiveDialog").isVisible(),true);
  assert.equal(await page.evaluate(id=>__payrollTest.sensitive[id].national_id,newEmployee),"000CONCURRENT-ID");
  await page.locator("#sensitiveForm [data-close]").click();await refresh();

  // A successful commit whose response was lost is replayed with the same UUID/revision.
  await openNew("00302","Synthetic Lost Response","000000000999");
  await page.evaluate(()=>{__payrollTest.loseEmployeeSaveResponseOnce=true;});await submit("employeeForm");
  const afterLost=await page.evaluate(()=>({employees:__payrollTest.db.payroll_employees.length,revision:__payrollTest.db.payroll_revision[0].version,audits:__payrollTest.db.payroll_audit.length,args:structuredClone(__payrollTest.rpcs.filter(call=>call.name==="payroll_save_employee").at(-1).args)}));
  assert.equal(afterLost.employees,4);assert.equal(await page.locator("#employeeDialog").isVisible(),true);
  await submit("employeeForm");
  assert.equal(await page.evaluate(()=>__payrollTest.db.payroll_employees.length),afterLost.employees);
  assert.equal(await page.evaluate(()=>__payrollTest.db.payroll_revision[0].version),afterLost.revision);
  assert.equal(await page.evaluate(()=>__payrollTest.db.payroll_audit.length),afterLost.audits);
  assert.deepEqual(await page.evaluate(()=>__payrollTest.rpcs.filter(call=>call.name==="payroll_save_employee").at(-1).args),afterLost.args);

  // Existing POS imports can still create employees without a manual identity field.
  const importedRows=[["User ID","Name","Dept","IN/OUT Time","Device ID"],["00303","Synthetic POS Imported","Test","2026-10-01 10:00",1],["00303","Synthetic POS Imported","Test","2026-10-01 20:00",1]];
  const bytes=await page.evaluate(rows=>Array.from(DGV_XLSX.buildWorkbookBytes({sheets:[{name:"Sheet",rows}]})),importedRows);
  await page.locator("#importFile").setInputFiles({name:"synthetic-identity-pos.xlsx",mimeType:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",buffer:Buffer.from(bytes)});
  await page.locator("#previewImport").click();await page.locator("#saveImport").waitFor({state:"visible"});await page.locator("#saveImport").click();await idle();
  const imported=await page.evaluate(()=>__payrollTest.db.payroll_employees.find(row=>row.device_user_id==="00303"));assert.ok(imported);
  assert.equal(await page.evaluate(id=>__payrollTest.sensitive[id]||null,imported.id),null);
  assert.equal(await page.evaluate(()=>__payrollTest.db.payroll_attendance_raw.filter(row=>row.employee_id===__payrollTest.db.payroll_employees.find(item=>item.device_user_id==="00303").id).length),2);

  // Required tax identifiers are fetched only for the explicitly selected tax report.
  await selectEmployee(existingEmployee);await preview("tax");
  assert.equal(await page.locator("#taxReviewed").isDisabled(),true);assert.equal(await page.locator("#downloadTax").isDisabled(),true);
  assert.match(await page.locator("#taxPreview").innerText(),/신분증|định danh/);
  await page.evaluate(({id,national,tax,bank})=>{__payrollTest.sensitive[id]={national_id:national,tax_id:tax,bank_account:bank};},{id:existingEmployee,national:taxIdentity,tax:taxCode,bank:bankAccount});
  await refresh();await preview("tax");
  assert.equal(await page.locator("#taxReviewed").isDisabled(),false);assert.equal(await page.locator("#downloadTax").isDisabled(),true);
  assert.equal((await page.locator("#taxPreview").innerText()).includes(taxIdentity),false,"preview reports identifier presence without printing the identifier");
  assert.match(await page.locator('#taxPreview label').innerText(),/신분증 번호 포함|số định danh/);
  await page.locator("#taxReviewed").check();const taxXml=await workbookDownload();
  assert.match(taxXml,/Định danh thuế/);assert.ok(taxXml.includes(taxIdentity));assert.ok(taxXml.includes(taxCode));assert.equal(taxXml.includes(bankAccount),false);
  assert.ok(taxXml.includes(`t="inlineStr"><is><t xml:space="preserve">${taxIdentity}</t>`),"leading zeros are exported as text cells");assert.equal(taxXml.includes(`<v>${taxIdentity}</v>`),false);
  const popupEvent=page.waitForEvent("popup");await page.locator("#printTax").click();const popup=await popupEvent;await popup.waitForFunction(()=>window.__printed===true);
  assert.ok((await popup.locator("body").innerText()).includes(taxIdentity));assert.equal(await popup.evaluate(()=>window.opener===null),true);await popup.close();
  await assertNoPublicIdentity(taxIdentity);
  const decryptCount=await page.evaluate(()=>__payrollTest.rpcs.filter(call=>call.name==="payroll_get_sensitive").length);
  for(const kind of ["ledger","attendance","parttime","cash","bank","outstanding"]){await preview(kind);await page.locator("#taxReviewed").check();const xml=await workbookDownload();assert.equal(xml.includes(taxIdentity),false,kind+" must omit identifiers");assert.equal(xml.includes(taxCode),false);assert.equal(xml.includes(bankAccount),false);}
  assert.equal(await page.evaluate(()=>__payrollTest.rpcs.filter(call=>call.name==="payroll_get_sensitive").length),decryptCount,"ordinary reports do not decrypt private identities");
  await preview("tax");await page.locator("#taxReviewed").check();const beforeStale=downloads.length;
  await page.evaluate(()=>{__payrollTest.db.payroll_revision[0].version++;});await page.locator("#downloadTax").click();await idle();
  assert.equal(downloads.length,beforeStale,"a stale tax preview cannot export its cached identity values");assert.equal(await page.locator("#taxPreview").isVisible(),false);
  await refresh();await preview("tax");await selectEmployee(otherEmployee);
  assert.equal(await page.locator("#taxPreview").isVisible(),false,"changing employee invalidates the selected identity scope");
  await preview("tax");assert.equal(await page.locator("#taxReviewed").isDisabled(),true);
  await selectEmployee(existingEmployee);await preview("tax");await page.locator("#closeTaxPreview").click();
  assert.equal(await page.locator("#taxPreview").isVisible(),false);assert.equal(await page.locator("#taxPreview").innerHTML(),"");

  // Identities never enter retained review/finalized payroll snapshots.
  await page.locator("#finalize").click();await page.locator('#confirmForm input[type="checkbox"]').check();await submit("confirmForm");
  await assertNoPublicIdentity(taxIdentity);
  assert.equal(await page.evaluate(()=>__payrollTest.db.payroll_runs.length),1);

  // Logout clears open forms and ignores late decrypt responses for every entry point.
  await openEdit();assert.equal(await field("employeeForm","national_id").inputValue(),taxIdentity);
  await page.evaluate(()=>DGV.supabase.auth.signOut());
  assert.equal(await page.locator("#employeeDialog").isVisible(),false);assert.equal(await field("employeeForm","national_id").inputValue(),"");
  for(const entry of ["editEmployee","sensitiveInfo","previewTax"]){
    await page.reload();await ready();await selectEmployee(existingEmployee);
    await page.evaluate(({id,national,bank})=>{__payrollTest.sensitive[id]={national_id:national,bank_account:bank};__payrollTest.deferSensitiveRead=true;},{id:existingEmployee,national:taxIdentity,bank:bankAccount});
    if(entry==="previewTax")await page.locator("#exportKind").selectOption("tax");
    await page.locator("#"+entry).click();await page.waitForFunction(()=>typeof __payrollTest.releaseSensitiveRead==="function");
    await page.evaluate(()=>DGV.supabase.auth.signOut());await page.evaluate(()=>__payrollTest.releaseSensitiveRead());await idle();
    assert.equal(await page.locator("#payrollApp").isVisible(),false);
    assert.equal(await page.locator("dialog[open]").count(),0,entry+" late response must not reopen a private dialog after logout");
    assert.equal(await field("employeeForm","national_id").inputValue(),"");assert.equal(await field("sensitiveForm","national_id").inputValue(),"");assert.equal(await field("sensitiveForm","bank_account").inputValue(),"");
    assert.equal(await page.locator("#taxPreview").isVisible(),false);
  }

  if(process.env.PAYROLL_SCREENSHOTS){
    await page.reload();await ready();await openNew("00301","예시 직원 / Nhân viên mẫu",firstId);
    await field("employeeForm","phone").fill("090-TEST-0001");await field("employeeForm","hire_date").fill("2026-10-29");
    await page.evaluate(()=>{const p=document.createElement("p");p.className="notice";p.textContent="화면 예시 · 모든 정보는 가상 데이터 / Dữ liệu minh họa";document.getElementById("employeeForm").prepend(p);});
    await mkdir(process.env.PAYROLL_SCREENSHOTS,{recursive:true});await page.locator("#employeeDialog").screenshot({path:path.join(process.env.PAYROLL_SCREENSHOTS,"payroll-employee-identity.png")});
  }
  assert.deepEqual(errors,[]);
  console.log("Payroll identity browser passed: required manual ID, leading zeros, atomic save/retry, private-key preservation, unchanged POS import, tax-only consent export, scope/revision guards and logout/decrypt race cleanup.");
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
