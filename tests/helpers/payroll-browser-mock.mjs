export function installMock(initialRole) {
  const a = "00000000-0000-4000-8000-000000000001";
  const b = "00000000-0000-4000-8000-000000000002";
  const state = window.__payrollTest = {
    role: initialRole, calls: [], rpcs: [], failRead: false, sensitive:{}, uploads:[], storageReads:[], storageObjects:{}, authSubscribers:[],
    db: {
      payroll_employees: [{ id: a, device_user_id: "2", name: "Test A", active: true }, { id: b, device_user_id: "9", name: "Test B", active: true }],
      payroll_terms: [a, b].map((employee_id, i) => ({ id: `term-${i}`, employee_id, effective_from: "2026-06-01", pay_type: "hourly", rate: 30000, shift_start: "10:00:00", shift_end: "20:00:00", break_start: "13:00:00", break_end: "15:00:00" })),
      payroll_attendance_raw: [a,b].flatMap((employee_id, i) => ["10:00:00", "20:00:00"].map((time, j) => ({id:`record-${i}-${j}`, employee_id, occurred_at:`2026-10-01T${time}`, device_id:"1"}))),
      payroll_days: [], payroll_runs: [], payroll_payments: [], payroll_imports: [], payroll_audit: [], payroll_revision: [{id:1,version:1}],
      payroll_rule_versions:[],payroll_reviews:[],payroll_run_adjustments:[],payroll_payment_reversals:[],payroll_attachments:[]
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
    upsert(value,options) { this.operation="upsert"; this.value=value; this.ignoreDuplicates=options?.ignoreDuplicates; return this; }
    update(value) { this.operation="update"; this.value=value; return this; }
    async then(resolve, reject) {
      try {
        state.calls.push({table:this.table,operation:this.operation,...(this.value?{payload:structuredClone(this.value)}:{})});
        if(this.operation==="select"&&state.deferReadFor===this.table){state.deferReadFor=null;await new Promise(resolve=>{state.releaseRead=resolve;});}
        if(state.failRead && this.operation==="select") return resolve({data:null,error:{message:"Synthetic read failure"}});
        if(this.operation==="select"&&state.bumpRevisionReadFor===this.table){state.bumpRevisionReadFor=null;state.db.payroll_revision[0].version++;}
        if(this.table==="payroll_attachments"&&this.operation==="insert"&&state.failAttachmentOnce){state.failAttachmentOnce=false;return resolve({data:null,error:{message:"Synthetic attachment metadata failure"}});}
        const source=state.db[this.table] ||= [];
        if(this.operation==="insert" || this.operation==="upsert") {
          for(const value of (Array.isArray(this.value)?this.value:[this.value])) {
            const old=this.operation==="upsert" ? source.find(row=>row.employee_id===value.employee_id && row.work_date===value.work_date) : null;
            if(old) {if(!this.ignoreDuplicates)Object.assign(old,value);} else source.push({id:crypto.randomUUID(),created_at:new Date().toISOString(),...value});
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
    storage:{from:bucket=>({
      upload:async(storagePath,file,options)=>{
        state.uploads.push({bucket,path:storagePath,byte_size:file.size,mime_type:options?.contentType||file.type,upsert:options?.upsert});
        if(state.failUploadOnce){state.failUploadOnce=false;return {data:null,error:{message:"Synthetic upload failure"}};}
        if(state.storageObjects[storagePath])return {data:null,error:{message:"Object already exists"}};
        state.storageObjects[storagePath]={bytes:Array.from(new Uint8Array(await file.arrayBuffer())),mime:options?.contentType||file.type};
        return {data:{path:storagePath},error:null};
      },
      createSignedUrl:async(storagePath,expiresIn)=>{state.storageReads.push({method:"createSignedUrl",path:storagePath,expiresIn,role:state.role});return {data:{signedUrl:`${location.origin}/test-private-evidence/${encodeURIComponent(storagePath)}?expires=${expiresIn}`},error:null};},
      download:async(storagePath)=>{
        state.storageReads.push({method:"download",path:storagePath,role:state.role});
        if(state.deferStorageDownload){state.deferStorageDownload=false;await new Promise(resolve=>{state.releaseStorageDownload=resolve;});}
        if(state.failDownloadOnce){state.failDownloadOnce=false;return {data:null,error:{message:"Synthetic download failure"}};}
        return state.storageObjects[storagePath]?{data:new Blob([new Uint8Array(state.storageObjects[storagePath].bytes)],{type:state.storageObjects[storagePath].mime}),error:null}:{data:null,error:{message:"Synthetic missing object"}};
      }
    })},
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
      signOut:async()=>{state.role=null;state.authSubscribers.forEach(callback=>callback("SIGNED_OUT",null));return {error:null};},
      onAuthStateChange:callback=>{state.authSubscribers.push(callback);return {data:{subscription:{unsubscribe(){state.authSubscribers=state.authSubscribers.filter(item=>item!==callback);}}}};}
    },
    rpc:async(name,args)=>{
      state.rpcs.push({name,args});
      if(state.role!=="admin") return {data:null,error:{message:"Forbidden"}};
      if(name==="payroll_save_employee") {
        const fail=message=>({data:null,error:{message}}), p=args.p_employee||{}, id=args.p_employee_id;
        if(typeof args.p_national_id!=="string"||!args.p_national_id.trim()||args.p_national_id.trim().length>300||/[\u0000-\u001f\u007f]/.test(args.p_national_id))return fail("PAYROLL_NATIONAL_ID_REQUIRED");
        const nationalId=args.p_national_id.trim();
        const allowed=["device_user_id","name","active","phone","employment_type","hire_date","termination_date","employment_status","payment_method"];
        if(Object.keys(p).some(key=>!allowed.includes(key)))return fail("PAYROLL_INVALID_EMPLOYEE_FIELDS");
        const old=state.db.payroll_employees.find(row=>row.id===id), unchanged=old&&Object.keys(p).every(key=>JSON.stringify(old[key])===JSON.stringify(p[key]))&&state.sensitive[id]?.national_id===nationalId;
        if(unchanged)return {data:id,error:null}; // Exact replay is safe even with the pre-commit revision.
        if(args.p_expected_revision!==state.db.payroll_revision[0].version)return fail("PAYROLL_STALE_RELOAD_REQUIRED");
        if(args.p_create&&old)return fail("PAYROLL_EMPLOYEE_ALREADY_EXISTS");
        if(!args.p_create&&!old)return fail("PAYROLL_EMPLOYEE_NOT_FOUND");
        if(state.db.payroll_employees.some(row=>row.id!==id&&row.device_user_id===p.device_user_id))return fail("PAYROLL_DEVICE_ID_EXISTS");
        if(state.failEmployeeSaveOnce){state.failEmployeeSaveOnce=false;return fail("Synthetic atomic employee save failure");}
        const row={...(old||{id,created_at:new Date().toISOString()}),...structuredClone(p)};
        if(old)Object.assign(old,row);else state.db.payroll_employees.push(row);
        state.sensitive[id]={...(state.sensitive[id]||{}),national_id:nationalId};
        state.db.payroll_audit.push({id:crypto.randomUUID(),table_name:"payroll_employees",record_id:id,action:old?"UPDATE":"INSERT",after_data:structuredClone(row),created_at:new Date().toISOString()});
        state.db.payroll_revision[0].version++;
        if(state.loseEmployeeSaveResponseOnce){state.loseEmployeeSaveResponseOnce=false;return fail("Synthetic lost employee save response");}
        return {data:id,error:null};
      }
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
        state.db.payroll_runs.push(run);state.db.payroll_revision[0].version++;return {data:run.id,error:null};
      }
      if(name==="payroll_pay") {
        const existing=state.db.payroll_payments.find(row=>row.request_id===args.p_request_id);
        if(existing)return {data:existing.id,error:null};
        if(state.failPaymentOnce){state.failPaymentOnce=false;return {data:null,error:{message:"Synthetic payment failure"}};}
        const payment={id:crypto.randomUUID(),run_id:args.p_run_id,amount:args.p_amount,paid_on:args.p_paid_on,method:args.p_method,reference:args.p_reference,note:args.p_note,request_id:args.p_request_id};
        state.db.payroll_payments.push(payment);state.db.payroll_revision[0].version++;
        if(state.losePaymentResponseOnce){state.losePaymentResponseOnce=false;return {data:null,error:{message:"Synthetic lost payment response"}};}
        return {data:payment.id,error:null};
      }
      if(name==="payroll_review") {
        if(args.p_expected_revision!==state.db.payroll_revision[0].version)return {data:null,error:{message:"PAYROLL_STALE_RELOAD_REQUIRED"}};
        const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==="object"?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
        const snapshot=JSON.stringify(stable(args.p_snapshot));
        const existing=state.db.payroll_reviews.find(row=>row.employee_id===args.p_employee_id&&row.month===args.p_month&&row.source_revision===args.p_expected_revision&&row.reason===args.p_reason&&JSON.stringify(stable(row.snapshot))===snapshot);
        if(existing)return {data:existing.id,error:null};
        const review={id:crypto.randomUUID(),employee_id:args.p_employee_id,month:args.p_month,snapshot:args.p_snapshot,reason:args.p_reason,source_revision:args.p_expected_revision,created_at:new Date().toISOString()};
        state.db.payroll_reviews.push(review);return {data:review.id,error:null};
      }
      if(name==="payroll_set_sensitive") {
        if(args.p_expected_revision!==undefined&&args.p_expected_revision!==state.db.payroll_revision[0].version)return {data:null,error:{message:"PAYROLL_STALE_RELOAD_REQUIRED"}};
        state.sensitive[args.p_employee_id]=structuredClone(args.p_data);
        state.db.payroll_revision[0].version++;
        return {data:crypto.randomUUID(),error:null};
      }
      if(name==="payroll_get_sensitive") {
        const data=structuredClone(state.sensitive[args.p_employee_id]||{});
        if(state.deferSensitiveRead){state.deferSensitiveRead=false;await new Promise(resolve=>{state.releaseSensitiveRead=resolve;});}
        if(state.failSensitiveReadOnce){state.failSensitiveReadOnce=false;return {data:null,error:{message:"Synthetic sensitive read failure"}};}
        return {data,error:null};
      }
      if(name==="payroll_adjust_run") {
        const row={id:crypto.randomUUID(),run_id:args.p_run_id,amount:args.p_amount,reason:args.p_reason,request_id:args.p_request_id,created_at:new Date().toISOString()};
        state.db.payroll_run_adjustments.push(row);state.db.payroll_revision[0].version++;return {data:row.id,error:null};
      }
      if(name==="payroll_reverse_payment") {
        const row={id:crypto.randomUUID(),payment_id:args.p_payment_id,reason:args.p_reason,request_id:args.p_request_id,created_at:new Date().toISOString()};
        state.db.payroll_payment_reversals.push(row);state.db.payroll_revision[0].version++;return {data:row.id,error:null};
      }
      if(name==="payroll_backup")return {data:{format:"DGV_PAYROLL_BACKUP",version:2,tables:structuredClone(state.db),sensitive:Object.entries(state.sensitive).map(([employee_id,data])=>({employee_id,data:structuredClone(data)}))},error:null};
      if(name==="payroll_restore") {
        const fingerprint=JSON.stringify(args.p_payload),replayed=state.restoreFingerprint===fingerprint;
        if(!replayed&&Object.entries(state.db).some(([table,values])=>table!=="payroll_revision"&&values.length))return {data:null,error:{message:"PAYROLL_RESTORE_REQUIRES_EMPTY_DATABASE"}};
        if(!replayed){state.db=structuredClone(args.p_payload.tables);state.sensitive=Object.fromEntries(args.p_payload.sensitive.map(row=>[row.employee_id,structuredClone(row.data)]));state.restoreFingerprint=fingerprint;}
        return {data:{restored:!replayed,replayed,missing_evidence:state.db.payroll_attachments.filter(row=>!state.storageObjects[row.storage_path])},error:null};
      }
      return {data:null,error:{message:`Unexpected RPC ${name}`}};
    }
  };
  window.supabase={createClient:()=>client};
}

