// Isolated remote boundary for the actual attendance page. Never contacts a
// production account; encryption and IndexedDB stay real in the browser.
export function installAttendanceMock(seed){
  const state=window.__attendanceTest={clients:[],calls:[],events:[],receipts:{},devices:[],grants:[],sequence:0,
    employees:[{id:"00000000-0000-4000-8000-000000000001",device_user_id:"TEST-1",name:"DEMO · Nguyễn An",active:true},
      {id:"00000000-0000-4000-8000-000000000002",device_user_id:"TEST-2",name:"DEMO · Trần Bình",active:true}]};
  if(seed)Object.assign(state,seed);
  const failure=(message,code="P0001")=>({data:null,error:{message,code}}),success=data=>({data:structuredClone(data),error:null});
  function deviceFor(token){return state.devices.find(row=>row.token===token&&row.status==="active");}
  function buildClient(url,key,options){
    const instance={id:state.clients.length,options:structuredClone(options||{}),role:null,subscriptions:[]};state.clients.push(instance);
    const auth={
      getSession:async()=>success({session:instance.role?{access_token:"synthetic-admin-session",user:{id:"admin-test",app_metadata:{role:instance.role}}}:null}),
      getUser:async()=>success({user:instance.role?{id:"admin-test",app_metadata:{role:instance.role}}:null}),
      signInWithPassword:async({email,password})=>{
        state.calls.push({client:instance.id,method:"signInWithPassword",email,password});
        if(email!==window.DGV_SUPABASE_CONFIG.authAccounts.admin||password!=="dgv-v2/admin/admin-test")return failure("Invalid login credentials","invalid_credentials");
        instance.role=state.forceLoginRole||"admin";const user={id:"admin-test",app_metadata:{role:instance.role}};
        instance.subscriptions.forEach(fn=>fn("SIGNED_IN",{user}));return success({user,session:{access_token:"synthetic-admin-session",user}});
      },
      signOut:async()=>{state.calls.push({client:instance.id,method:"signOut"});instance.role=null;instance.subscriptions.forEach(fn=>fn("SIGNED_OUT",null));return {error:null};},
      onAuthStateChange:fn=>{instance.subscriptions.push(fn);return {data:{subscription:{unsubscribe(){instance.subscriptions=instance.subscriptions.filter(item=>item!==fn);}}}};},
      stopAutoRefresh(){},startAutoRefresh(){}
    };
    class Query{
      constructor(table){this.table=table;this.filters=[];this.conditions=[];this.start=0;this.end=Infinity;this.single=false;}
      select(){return this;}order(){return this;}limit(limit){this.end=limit-1;return this;}range(start,end){this.start=start;this.end=end;return this;}
      eq(key,value){this.conditions.push([key,value]);this.filters.push(row=>row[key]===value);return this;}in(key,values){this.filters.push(row=>values.includes(row[key]));return this;}
      maybeSingle(){this.single=true;return this;}
      then(resolve,reject){
        try{state.calls.push({client:instance.id,role:instance.role,table:this.table,conditions:this.conditions});if(instance.role!=="admin")return resolve(failure("Forbidden","42501"));
          if(state.failTableOnce===this.table){state.failTableOnce=null;return resolve(failure("Synthetic read failure","FETCH_ERROR"));}
          const source=this.table==="payroll_employees"?state.employees:this.table==="payroll_attendance_raw"?Object.entries(state.receipts).map(([requestId,event])=>({...event,id:event.event_id,kiosk_request_id:requestId,kiosk_device_id:event.device_id})):null;
          if(!source)return resolve(failure("Unexpected table "+this.table));
          const rows=source.filter(row=>this.filters.every(fn=>fn(row))).slice(this.start,this.end+1);
          return resolve(success(this.single?(rows[0]||null):rows));
        }catch(error){return reject(error);}
      }
    }
    const rpc=async(name,args={})=>{
      state.calls.push({client:instance.id,role:instance.role,rpc:name,args:structuredClone(args)});
      const privileged=["payroll_kiosk_register","payroll_kiosk_devices","payroll_kiosk_revoke","payroll_kiosk_enroll","payroll_kiosk_unenroll"];
      if(privileged.includes(name)&&instance.role!=="admin")return failure("PAYROLL_ADMIN_REQUIRED","42501");
      if(state.failRpcOnce===name){state.failRpcOnce=null;return failure("Synthetic network failure","FETCH_ERROR");}
      if(name==="payroll_kiosk_register"){
        let device=state.devices.find(row=>row.device_id===args.p_device_id);
        if(!device){device={device_id:args.p_device_id,name:args.p_name,token:args.p_token,status:"active",created_at:"2026-10-29T01:00:00Z",revoked_at:null};state.devices.push(device);}
        return success({device_id:device.device_id,name:device.name,status:device.status});
      }
      if(name==="payroll_kiosk_devices")return success(state.devices.map(({token,...row})=>({...row,enrollment_count:state.grants.filter(grant=>grant.device_id===row.device_id).length})));
      if(name==="payroll_kiosk_revoke"){
        const device=state.devices.find(row=>row.device_id===args.p_device_id);if(!device)return failure("Missing device");device.status="revoked";device.revoked_at="2026-10-29T02:00:00Z";return success(device.device_id);
      }
      if(name==="payroll_kiosk_enroll"){
        let grant=state.grants.find(row=>row.device_id===args.p_device_id&&row.employee_id===args.p_employee_id);
        if(!grant){grant={id:crypto.randomUUID(),device_id:args.p_device_id,employee_id:args.p_employee_id};state.grants.push(grant);}return success(grant.id);
      }
      if(name==="payroll_kiosk_unenroll"){state.grants=state.grants.filter(row=>row.device_id!==args.p_device_id||row.employee_id!==args.p_employee_id);return success(args.p_employee_id);}
      const device=deviceFor(args.p_token);if(!device)return failure("PAYROLL_KIOSK_INVALID_TOKEN","42501");
      if(name==="payroll_kiosk_roster")return success({device_id:device.device_id,name:device.name,employees:state.employees.filter(employee=>employee.active&&state.grants.some(grant=>grant.device_id===device.device_id&&grant.employee_id===employee.id)).map(employee=>({id:employee.id,name:employee.name,device_user_id:employee.device_user_id,enrollment_id:state.grants.find(grant=>grant.device_id===device.device_id&&grant.employee_id===employee.id).id,last_punch:state.events.filter(event=>event.employee_id===employee.id).at(-1)||null}))});
      if(name==="payroll_kiosk_receipt"){const receipt=state.receipts[args.p_request_id];return success(receipt?.device_id===device.device_id?{...receipt,replayed:true}:null);}
      if(name==="payroll_kiosk_punch"){
        const receipt=state.receipts[args.p_request_id];if(receipt)return receipt.device_id===device.device_id?success({...receipt,replayed:true}):failure("PAYROLL_KIOSK_REQUEST_CONFLICT");
        if(!state.grants.some(grant=>grant.device_id===device.device_id&&grant.employee_id===args.p_employee_id))return failure("PAYROLL_KIOSK_NOT_ENROLLED");
        const latest=state.events.filter(event=>event.employee_id===args.p_employee_id).at(-1);
        if((!latest&&args.p_kind!=="in")||latest?.punch_type===args.p_kind)return failure("PAYROLL_KIOSK_INVALID_SEQUENCE");
        if(state.losePunchBeforeCommit){state.losePunchBeforeCommit=false;return failure("Synthetic result unknown","FETCH_ERROR");}
        const minute=String(++state.sequence).padStart(2,"0"),event={event_id:crypto.randomUUID(),device_id:device.device_id,employee_id:args.p_employee_id,punch_type:args.p_kind,occurred_at:`2026-10-29T08:${minute}:00`,server_received_at:`2026-10-29T01:${minute}:00Z`,replayed:false,verification:"trusted_kiosk_verification"};
        state.events.push(event);state.receipts[args.p_request_id]=event;
        if(state.losePunchResponse){state.losePunchResponse=false;return failure("Synthetic saved but response lost","FETCH_ERROR");}
        return success(event);
      }
      return failure("Unexpected RPC "+name);
    };
    return {auth,from:table=>new Query(table),rpc:(name,args)=>{const pending=(async()=>{const response=await rpc(name,args);if(state.deferRpc===name){state.deferRpc=null;await new Promise(resolve=>{state.releaseRpc=resolve;});}return response;})();pending.abortSignal=()=>pending;return pending;}};
  }
  window.supabase={createClient:buildClient};
}

export function installAttendanceFaceMock(){
  const MODEL="dlib-resnet128-faceapi-1.7.15-tiny68-v1",THRESHOLD=0.48;
  const state=window.__faceTest={matched:true,loadCalls:0,enrollCalls:0,verifyCalls:0,disposeCalls:0,cameraStarts:0,cameraStops:0};
  const template=()=>({version:1,model:MODEL,samples:Array.from({length:3},()=>Array.from({length:128},(_,i)=>(i+1)/1000)),createdAt:"2026-10-29T00:00:00.000Z"});
  const delay=async signal=>{
    if(state.defer){state.defer=false;await new Promise(resolve=>{state.release=resolve;});}
    if(signal?.aborted&&!state.ignoreAbort)throw new DOMException("Synthetic cancel","AbortError");
  };
  window.DGV_ATTENDANCE_FACE={MODEL,THRESHOLD,validateTemplate:value=>value?.model===MODEL&&Array.isArray(value.samples)&&value.samples.length===3,
    create:()=>{let disposed=false;const check=()=>{if(disposed)throw new DOMException("Disposed","AbortError");};return {load:async()=>{check();state.loadCalls++;return {backend:"wasm",model:MODEL};},enroll:async(video,{signal,onProgress}={})=>{check();state.enrollCalls++;onProgress?.({step:"front",message:"DEMO · 정면 확인 중 / Nhìn thẳng"});await delay(signal);return template();},
      verify:async(video,value,{signal,onProgress}={})=>{check();state.verifyCalls++;onProgress?.({step:"front",message:"DEMO · 얼굴 확인 중 / Kiểm tra khuôn mặt"});await delay(signal);return {matched:state.matched,distance:state.matched?0.2:0.8,threshold:THRESHOLD,challenge:"none",model:MODEL,backend:"wasm"};},dispose:()=>{disposed=true;state.disposeCalls++;}};}};
  navigator.mediaDevices.getUserMedia=async()=>{
    state.cameraStarts++;const canvas=document.createElement("canvas");canvas.width=640;canvas.height=480;const ctx=canvas.getContext("2d");ctx.fillStyle="#d9e7e3";ctx.fillRect(0,0,640,480);ctx.fillStyle="#49635b";ctx.font="28px sans-serif";ctx.fillText("DEMO · Synthetic camera",125,240);
    const stream=canvas.captureStream(1);for(const track of stream.getTracks()){const stop=track.stop.bind(track);track.stop=()=>{state.cameraStops++;stop();};}return stream;
  };
}
