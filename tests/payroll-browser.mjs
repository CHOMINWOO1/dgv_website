import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Local UI contract test. All database/auth requests are mocked; the separate
// payroll-db test exercises the PostgreSQL authorization and transactions.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modules = process.env.PAYROLL_BROWSER_MODULES;
const { chromium } = modules
  ? await import(pathToFileURL(path.join(modules, "playwright/index.mjs")))
  : await import("playwright");
const screenshots = process.env.PAYROLL_SCREENSHOTS || path.resolve(root, "../payroll-qa");
await mkdir(screenshots, { recursive: true });
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const server = createServer(async (req, res) => {
  try {
    const relative = decodeURIComponent(new URL(req.url, "http://localhost").pathname).replace(/^\/+/, "");
    const file = path.resolve(root, relative || "payroll.html");
    if (!file.startsWith(root + path.sep)) throw new Error("invalid path");
    res.writeHead(200, { "Content-Type": mime[path.extname(file)] || "application/octet-stream" });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404); res.end("Not found");
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, channel: process.env.PAYROLL_BROWSER_CHANNEL || "chrome" });

function installMock(initialRole) {
  const a = "00000000-0000-4000-8000-000000000001";
  const b = "00000000-0000-4000-8000-000000000002";
  const state = window.__payrollTest = {
    role: initialRole, calls: [], rpcs: [], failRead: false,
    db: {
      payroll_employees: [{ id: a, device_user_id: "2", name: "Test A", active: true }, { id: b, device_user_id: "9", name: "Test B", active: true }],
      payroll_terms: [a, b].map((employee_id, i) => ({ id: `term-${i}`, employee_id, effective_from: "2026-06-01", pay_type: "hourly", rate: 30000, shift_start: "10:00:00", shift_end: "20:00:00", break_start: "13:00:00", break_end: "15:00:00" })),
      payroll_attendance_raw: [a,b].flatMap((employee_id, i) => ["10:00:00", "20:00:00"].map((time, j) => ({id:`record-${i}-${j}`, employee_id, occurred_at:`2026-10-01T${time}`, device_id:"1"}))),
      payroll_days: [], payroll_runs: [], payroll_payments: [], payroll_imports: [], payroll_audit: [], payroll_revision: [{id:1,version:1}]
    }
  };
  class Query {
    constructor(table) { this.table=table; this.filters=[]; this.offset=0; this.end=Infinity; this.operation="select"; this.singleRow=false; }
    select() { return this; }
    eq(key,value) { this.filters.push(row=>row[key]===value); return this; }
    gte(key,value) { this.filters.push(row=>row[key]>=value); return this; }
    lte(key,value) { this.filters.push(row=>row[key]<=value); return this; }
    gt(key,value) { this.filters.push(row=>row[key]>value); return this; }
    lt(key,value) { this.filters.push(row=>row[key]<value); return this; }
    in(key,values) { this.filters.push(row=>values.includes(row[key])); return this; }
    order() { return this; }
    limit(n) { this.end=n-1; return this; }
    range(a,b) { this.offset=a; this.end=b; return this; }
    single() { this.singleRow=true; return this; }
    maybeSingle() { this.singleRow=true; return this; }
    insert(value) { this.operation="insert"; this.value=value; return this; }
    upsert(value) { this.operation="upsert"; this.value=value; return this; }
    update(value) { this.operation="update"; this.value=value; return this; }
    async then(resolve, reject) {
      try {
        state.calls.push({table:this.table,operation:this.operation});
        if(state.failRead && this.operation==="select") return resolve({data:null,error:{message:"Synthetic read failure"}});
        const source=state.db[this.table] ||= [];
        if(this.operation==="insert" || this.operation==="upsert") {
          for(const value of (Array.isArray(this.value)?this.value:[this.value])) {
            const old=this.operation==="upsert" ? source.find(row=>row.employee_id===value.employee_id && row.work_date===value.work_date) : null;
            if(old) Object.assign(old,value); else source.push({id:crypto.randomUUID(),...value});
          }
          state.db.payroll_revision[0].version++;
        } else if(this.operation==="update") {
          source.filter(row=>this.filters.every(filter=>filter(row))).forEach(row=>Object.assign(row,this.value));
          state.db.payroll_revision[0].version++;
        }
        const data=source.filter(row=>this.filters.every(filter=>filter(row))).slice(this.offset,this.end+1);
        resolve({data:this.singleRow?(data[0]||null):structuredClone(data),error:null});
      } catch(error) { reject(error); }
    }
  }
  const client={
    from:table=>new Query(table),
    auth:{
      getSession:async()=>({data:{session:state.role?{access_token:"synthetic-test-token"}:null},error:null}),
      getUser:async()=>({data:{user:state.role?{id:"test-user",app_metadata:{role:state.role}}:null},error:null}),
      signInWithPassword:async({email,password})=>{
        const requestedRole=password.split("/")[1];
        state.calls.push({auth:"signInWithPassword",email,requestedRole});
        if(!["admin","manager","staff"].includes(requestedRole)
          || email!==window.DGV_SUPABASE_CONFIG.authAccounts[requestedRole]
          || password!==`dgv-v2/${requestedRole}/${requestedRole}-test`) return {data:null,error:new Error("Invalid test credentials")};
        state.role=requestedRole;return {data:{user:{id:"test-user",app_metadata:{role:state.role}}},error:null};
      },
      signOut:async()=>{state.role=null;return {error:null};},
      onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})
    },
    rpc:async(name,args)=>{
      state.rpcs.push({name,args});
      if(state.role!=="admin") return {data:null,error:{message:"Forbidden"}};
      if(name==="payroll_import") {
        let inserted=0;
        for(const record of args.p_records) {
          let employee=state.db.payroll_employees.find(row=>row.device_user_id===record.device_user_id);
          if(!employee){employee={id:crypto.randomUUID(),device_user_id:record.device_user_id,name:record.name,active:true};state.db.payroll_employees.push(employee);}
          const exists=state.db.payroll_attendance_raw.some(row=>row.employee_id===employee.id && row.occurred_at===record.occurred_at && row.device_id===record.device_id);
          if(!exists){state.db.payroll_attendance_raw.push({id:crypto.randomUUID(),employee_id:employee.id,occurred_at:record.occurred_at,device_id:record.device_id});inserted++;}
        }
        state.db.payroll_revision[0].version++;
        const imported={id:crypto.randomUUID(),filename:args.p_filename,inserted_count:inserted,duplicate_count:args.p_records.length-inserted,created_at:new Date().toISOString()};
        state.db.payroll_imports.push(imported);
        return {data:{import_id:imported.id,inserted_count:inserted,duplicate_count:args.p_records.length-inserted,employee_count:2},error:null};
      }
      if(name==="payroll_finalize") {
        const run={id:crypto.randomUUID(),employee_id:args.p_employee_id,month:args.p_month,base_amount:args.p_base_amount,allowances:args.p_allowances,deductions:args.p_deductions,total:args.p_base_amount+args.p_allowances-args.p_deductions,snapshot:args.p_snapshot,created_at:new Date().toISOString()};
        state.db.payroll_runs.push(run);return {data:run.id,error:null};
      }
      if(name==="payroll_pay") {
        const payment={id:crypto.randomUUID(),run_id:args.p_run_id,amount:args.p_amount,paid_on:args.p_paid_on,method:args.p_method,reference:args.p_reference,note:args.p_note,request_id:args.p_request_id};
        state.db.payroll_payments.push(payment);return {data:payment.id,error:null};
      }
      return {data:null,error:{message:`Unexpected RPC ${name}`}};
    }
  };
  window.supabase={createClient:()=>client};
}

async function newPage(role, viewport={width:1440,height:1100}) {
  const page=await browser.newPage({viewport});
  const errors=[];
  page.on("pageerror",error=>errors.push(error.message));
  await page.route("**/*",async route=>{
    const url=route.request().url();
    if(url.startsWith("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@")) return route.fulfill({contentType:"text/javascript",body:`(${installMock.toString()})(${JSON.stringify(role)});`});
    if(!url.startsWith(origin)) return route.fulfill({contentType:"text/javascript",body:"/* network disabled for isolated payroll test */"});
    return route.continue();
  });
  await page.goto(`${origin}/payroll.html`);
  return {page,errors};
}

try {
  // Use the real shared DGV client and QRStaff login implementation, replacing
  // only the remote Supabase server boundary with explicit test credentials.
  for (const role of [null,"staff","manager"]) {
    const {page,errors}=await newPage(role);
    await page.locator("#loginModal").waitFor({state:"visible"});
    assert.equal(await page.locator("#payrollApp").isVisible(),false);
    assert.equal(await page.evaluate(()=>__payrollTest.calls.filter(call=>call.table).length),0,"unauthorized sessions must not request payroll data");
    if(role==="manager") {
      await page.locator("#loginPassword").fill("manager-test");
      await page.locator("#loginConfirm").click();
      await page.waitForFunction(()=>__payrollTest.calls.some(call=>call.auth==="signInWithPassword"));
      await page.waitForFunction(()=>!document.getElementById("loginConfirm").disabled);
      assert.equal(await page.locator("#loginModal").isVisible(),true,"manager password must be rejected");
      assert.equal(await page.locator("#payrollApp").isVisible(),false);
      assert.deepEqual(await page.evaluate(()=>__payrollTest.calls.filter(call=>call.auth).map(call=>call.requestedRole)),["admin"],"password login must never fall back to manager/staff");
      await page.locator("#loginPassword").fill("admin-test");
      await page.locator("#loginConfirm").click();
      await page.locator("#payrollApp").waitFor({state:"visible"});
      await page.locator("#ledgerBody [data-employee]").first().waitFor();
      assert.equal(await page.locator("#loginModal").isVisible(),false);
      assert.equal(await page.evaluate(()=>__payrollTest.role),"admin");
    }
    assert.deepEqual(errors,[]);
    await page.close();
  }

  const {page,errors}=await newPage("admin");
  await page.locator("#ledgerBody [data-employee]").first().waitFor();
  await page.locator("#month").fill("2026-10");
  await page.locator("#month").dispatchEvent("change");
  await page.waitForFunction(()=>!document.getElementById("workspace").disabled);
  assert.equal(await page.locator("#ledgerBody [data-employee]").count(),2);
  const employeeA="00000000-0000-4000-8000-000000000001";
  const employeeB="00000000-0000-4000-8000-000000000002";
  await page.locator("#employeeFilter").selectOption(employeeA);
  assert.equal(await page.locator("#ledgerBody [data-employee]").count(),1,"employee filter must reduce the ledger");
  await page.locator("#employeeDetail").waitFor({state:"visible"});
  assert.match(await page.locator("#detailTitle").innerText(),/Test A/);

  async function workbookFile(rows,name="synthetic-n308.xlsx") {
    const bytes=await page.evaluate(rows=>Array.from(DGV_XLSX.buildWorkbookBytes({sheets:[{name:"Sheet",rows}]})),rows);
    return {name,mimeType:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",buffer:Buffer.from(bytes)};
  }
  async function importFile(file,inserted,duplicates) {
    await page.locator("#importFile").setInputFiles(file);
    await page.locator("#previewImport").click();
    await page.locator("#saveImport").waitFor({state:"visible"});
    await page.locator("#saveImport").click();
    await page.waitForFunction(()=>!document.getElementById("workspace").disabled);
    assert.match(await page.locator("#notice").innerText(),new RegExp(`신규 ${inserted}건, 중복 ${duplicates}건`));
  }
  const headers=["User ID","Name","Dept","IN/OUT Time","Device ID"];
  const file=await workbookFile([headers,
    [2,"Test A","Test","2026-10-01 10:00",1],[2,"Test A","Test","2026-10-01 20:00",1],
    [2,"Test A","Test","2026-10-02 10:00",1],[2,"Test A","Test","2026-10-02 20:00",1]
  ]);
  await importFile(file,2,2);
  const afterFirst=await page.evaluate(()=>structuredClone(__payrollTest.db.payroll_attendance_raw));
  await importFile(file,0,4);
  assert.deepEqual(await page.evaluate(()=>__payrollTest.db.payroll_attendance_raw),afterFirst,"repeated workbook must preserve original records exactly");
  assert.match(await page.locator("#ledgerBody").innerText(),/480[.,]000/);

  // Missing punches cannot be finalized. Corrections preserve raw data.
  const missing=await workbookFile([headers,[9,"Test B","Test","2026-10-03 10:00",1]],"single-punch.xlsx");
  await importFile(missing,1,0);
  await page.locator("#employeeFilter").selectOption(employeeB);
  assert.equal(await page.locator("#finalize").isDisabled(),true);
  await page.locator('[data-day="2026-10-03"]').click();
  await page.locator('#dayForm [name="check_in"]').fill("2026-10-03T10:00");
  await page.locator('#dayForm [name="check_out"]').fill("2026-10-03T20:00");
  await page.locator('#dayForm [name="reason"]').fill("관리자 확인 테스트 / Kiểm tra thử");
  await page.locator('#dayForm button[type="submit"]').click();
  await page.locator("#dayDialog").waitFor({state:"hidden"});
  await page.waitForFunction(()=>!document.getElementById("workspace").disabled);
  assert.equal(await page.locator("#finalize").isDisabled(),false);
  assert.equal(await page.evaluate(()=>__payrollTest.db.payroll_attendance_raw.length),7);

  // Approve one employee then record separate cash and bank payments.
  await page.locator("#employeeFilter").selectOption(employeeA);
  await page.locator("#finalize").click();
  await page.locator('#confirmForm input[type="checkbox"]').check();
  await page.locator('#confirmForm button[type="submit"]').click();
  await page.locator("#confirmDialog").waitFor({state:"hidden"});
  await page.locator("#addPayment").waitFor();
  for(const [amount,method] of [[100000,"cash"],[150000,"bank"]]) {
    await page.locator("#addPayment").click();
    await page.locator('#paymentForm [name="amount"]').fill(String(amount));
    await page.locator('#paymentForm [name="method"]').selectOption(method);
    await page.locator('#paymentForm [name="reference"]').fill("TEST-RECEIPT");
    await page.locator('#paymentForm button[type="submit"]').click();
    await page.locator("#paymentDialog").waitFor({state:"hidden"});
    await page.waitForFunction(()=>!document.getElementById("workspace").disabled);
  }
  assert.match(await page.locator("#paymentArea").innerText(),/250[.,]000/);
  assert.match(await page.locator("#paymentArea").innerText(),/230[.,]000/);
  assert.deepEqual(await page.evaluate(()=>__payrollTest.db.payroll_payments.map(row=>row.method)),["cash","bank"]);
  const download=page.waitForEvent("download");
  await page.locator("#export").click();
  const exported=await download;
  assert.equal(exported.suggestedFilename(),"HANA_payroll_2026-10.xlsx");
  const downloaded=await readFile(await exported.path());
  assert.equal(downloaded.subarray(0,2).toString(),"PK");
  assert.ok(downloaded.length>1000);
  const zipFiles=new Map();
  for(let offset=0;downloaded.readUInt32LE(offset)===0x04034b50;) {
    const compression=downloaded.readUInt16LE(offset+8);
    const length=downloaded.readUInt32LE(offset+18),nameLength=downloaded.readUInt16LE(offset+26),extraLength=downloaded.readUInt16LE(offset+28);
    const name=downloaded.subarray(offset+30,offset+30+nameLength).toString("utf8");
    const start=offset+30+nameLength+extraLength;
    assert.equal(compression,0,"local XLSX export uses stored ZIP entries");
    zipFiles.set(name,downloaded.subarray(start,start+length).toString("utf8"));
    offset=start+length;
  }
  const ledgerXml=zipFiles.get("xl/worksheets/sheet1.xml");
  assert.match(ledgerXml,/Nhân viên \/ 직원/);
  assert.match(ledgerXml,/<pane ySplit="2"/);
  assert.match(ledgerXml,/<col min="2" max="2" width="24"/);
  assert.match(ledgerXml,/<v>250000<\/v>/,"export stores actual paid amount as a number");
  assert.match(ledgerXml,/<v>230000<\/v>/,"export stores outstanding amount as a number");

  // Monetary review can resolve contract-dependent amounts without allowing
  // unresolved attendance to pass through the same review path.
  const originalDb=await page.evaluate(()=>structuredClone(__payrollTest.db));
  await page.evaluate(employeeB=>{
    const term=__payrollTest.db.payroll_terms.find(row=>row.employee_id===employeeB);
    term.pay_type="monthly";term.rate=7000000;
    __payrollTest.db.payroll_terms.push({...term,id:"mid-month-rate",effective_from:"2026-10-15",rate:8000000});
    __payrollTest.db.payroll_revision[0].version++;
  },employeeB);
  await page.locator("#refresh").click();
  await page.waitForFunction(()=>!document.getElementById("workspace").disabled);
  await page.locator("#employeeFilter").selectOption(employeeB);
  await page.locator("#reviewedBase").waitFor();
  const priorFinalizations=await page.evaluate(()=>__payrollTest.rpcs.filter(call=>call.name==="payroll_finalize").length);
  await page.locator("#finalize").click();
  await page.waitForFunction(()=>!document.getElementById("workspace").disabled);
  assert.equal(await page.locator("#confirmDialog").isVisible(),false,"missing reviewed amount blocks confirmation");
  await page.locator("#reviewedBase").fill("7500000");
  await page.locator("#finalize").click();
  await page.waitForFunction(()=>!document.getElementById("workspace").disabled);
  assert.equal(await page.locator("#confirmDialog").isVisible(),false,"missing calculation reason blocks confirmation");
  assert.equal(await page.evaluate(()=>__payrollTest.rpcs.filter(call=>call.name==="payroll_finalize").length),priorFinalizations);
  await page.locator("#reviewedBaseReason").fill("계약에 따른 월중 변경 금액 검토 / Đã kiểm tra thay đổi giữa tháng");
  await page.locator("#finalize").click();
  await page.locator('#confirmForm input[type="checkbox"]').check();
  await page.locator('#confirmForm button[type="submit"]').click();
  await page.locator("#confirmDialog").waitFor({state:"hidden"});
  await page.waitForFunction(()=>!document.getElementById("workspace").disabled);
  const reviewed=await page.evaluate(employeeB=>__payrollTest.db.payroll_runs.find(run=>run.employee_id===employeeB),employeeB);
  assert.equal(reviewed.base_amount,7500000);
  assert.equal(reviewed.snapshot.unresolved,0);
  assert.equal(reviewed.snapshot.originalUnresolved,1);
  assert.equal(reviewed.snapshot.reviewedBase.amount,7500000);
  assert.match(reviewed.snapshot.reviewedBase.reason,/월중 변경/);
  assert.equal(reviewed.snapshot.attendanceUnresolved,0);
  assert.equal(reviewed.snapshot.compensationUnresolved,1,"review preserves original monetary issue for audit");
  await page.evaluate(employeeB=>{
    __payrollTest.db.payroll_runs=__payrollTest.db.payroll_runs.filter(run=>run.employee_id!==employeeB);
    __payrollTest.db.payroll_days=__payrollTest.db.payroll_days.filter(day=>day.employee_id!==employeeB);
    __payrollTest.db.payroll_revision[0].version++;
  },employeeB);
  await page.locator("#refresh").click();
  await page.waitForFunction(()=>!document.getElementById("workspace").disabled);
  assert.equal(await page.locator("#reviewedBase").count(),0,"a missing punch must not offer the monetary override path");
  assert.equal(await page.locator("#finalize").isDisabled(),true);

  // Inactive employees with no monthly activity disappear, while approved
  // history and the corresponding cash/bank payment totals stay visible.
  await page.evaluate(({originalDb,employeeA,employeeB})=>{
    __payrollTest.db=structuredClone(originalDb);
    __payrollTest.db.payroll_employees.forEach(employee=>{employee.active=false;});
    __payrollTest.db.payroll_attendance_raw=[];
    __payrollTest.db.payroll_days=[];
    __payrollTest.db.payroll_revision[0].version++;
  },{originalDb,employeeA,employeeB});
  await page.locator("#refresh").click();
  await page.waitForFunction(()=>!document.getElementById("workspace").disabled);
  await page.locator("#employeeFilter").selectOption("");
  assert.equal(await page.locator("#ledgerBody [data-employee]").count(),1);
  assert.equal(await page.locator("#ledgerBody [data-employee]").getAttribute("data-employee"),employeeA);
  assert.match(await page.locator("#ledgerBody").innerText(),/250[.,]000/);
  assert.match(await page.locator("#ledgerBody").innerText(),/16h 0m/,"finalized history keeps its original worked hours");
  await page.evaluate(originalDb=>{__payrollTest.db=structuredClone(originalDb);},originalDb);
  await page.locator("#refresh").click();
  await page.waitForFunction(()=>!document.getElementById("workspace").disabled);
  await page.locator("#employeeFilter").selectOption(employeeA);

  // A failed load cannot leave the previous employee's actionable payroll on screen.
  await page.evaluate(()=>{__payrollTest.failRead=true;});
  await page.locator("#refresh").click();
  await page.waitForFunction(()=>!document.getElementById("workspace").disabled);
  assert.equal(await page.locator("#employeeDetail").isVisible(),false);
  assert.equal(await page.locator("#export").isDisabled(),true);
  assert.match(await page.locator("#notice").innerText(),/Synthetic read failure/);
  await page.evaluate(()=>{__payrollTest.failRead=false;});
  await page.locator("#refresh").click();
  await page.waitForFunction(()=>!document.getElementById("workspace").disabled);
  await page.locator("#employeeFilter").selectOption("");
  await page.locator(`[data-employee="${employeeA}"]`).click();
  await page.evaluate(()=>{
    document.getElementById("notice").hidden=true;
    const banner=document.createElement("p");
    banner.textContent="화면 미리보기 · 예시 데이터 / Bản xem thử · Dữ liệu mẫu";
    banner.style.cssText="padding:8px 14px;background:#e9f3ed;border-radius:8px;margin-bottom:14px;color:#245e47;font-size:12px";
    document.getElementById("payrollApp").prepend(banner);
    window.scrollTo(0,0);
  });
  assert.deepEqual(errors,[]);
  await page.screenshot({path:path.join(screenshots,"payroll-desktop.png"),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,"mobile viewport must not overflow horizontally");
  await page.screenshot({path:path.join(screenshots,"payroll-mobile.png"),fullPage:true});
  if(process.env.PAYROLL_SAMPLE_FILE) {
    // The optional user-supplied workbook is read locally and never committed,
    // uploaded to a remote service, or used in the demo screenshots above.
    await page.setViewportSize({width:1440,height:1100});
    await page.evaluate(()=>{
      for(const table of Object.keys(__payrollTest.db)) {
        __payrollTest.db[table]=table==="payroll_revision"?[{id:1,version:1}]:[];
      }
    });
    await page.locator("#refresh").click();
    await page.waitForFunction(()=>!document.getElementById("workspace").disabled);
    await importFile(process.env.PAYROLL_SAMPLE_FILE,140,0);
    const sampleRecords=await page.evaluate(()=>structuredClone(__payrollTest.db.payroll_attendance_raw));
    assert.equal(sampleRecords.length,140);
    assert.equal(await page.evaluate(()=>__payrollTest.db.payroll_employees.length),2);
    await importFile(process.env.PAYROLL_SAMPLE_FILE,0,140);
    assert.deepEqual(await page.evaluate(()=>__payrollTest.db.payroll_attendance_raw),sampleRecords);
    console.log("User workbook check passed: actual N308 140 rows -> first import 140 new; repeat import 0 new / 140 skipped.");
  }
  await page.close();
  console.log("Payroll browser passed: admin-only password/session gate, repeated/overlapping upload, employee/month filters, correction, approval, split payments, XLSX download, failed-load lockout, desktop/mobile screenshots.");
} finally {
  await browser.close();
  await new Promise(resolve=>server.close(resolve));
}
