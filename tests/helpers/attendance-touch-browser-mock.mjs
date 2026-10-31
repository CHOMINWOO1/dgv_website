// The shared attendance mock supplies the existing device/auth/receipt boundary.
// This additional fixture is serialized only into the camera-free test page;
// existing face tests and production clients are not changed.
export function installTouchBoundary(seed){
  const original=window.supabase.createClient;
  const state=window.__touchTest={cameraRequests:0,calls:[],handlers:{},challenges:[],nextCodes:["0042","8173","0591","2468","1357","6024"],now:Date.parse("2026-10-31T01:00:00Z"),sequence:0,deferRpc:null,releaseRpc:null};
  if(seed)Object.assign(state,seed);
  const shared=window.__attendanceTest;
  shared.employees.push(
    {id:"00000000-0000-4000-8000-000000000003",device_user_id:"SERVICE",name:"DEMO · Contractor",active:true,payee_type:"service",employment_status:"active",archived_at:null},
    {id:"00000000-0000-4000-8000-000000000004",device_user_id:"ARCHIVED",name:"DEMO · Archived employee",active:false,payee_type:"employee",employment_status:"terminated",archived_at:"2026-10-30T00:00:00Z"}
  );
  const success=data=>({data:structuredClone(data),error:null});
  const failure=(message,code="P0001")=>({data:null,error:{message,code}});
  const deviceFor=token=>shared.devices.find(device=>device.token===token&&device.status==="active");
  const employeeFor=id=>shared.employees.find(employee=>employee.id===id&&employee.active&&employee.payee_type!=="service"&&!employee.archived_at&&employee.employment_status!=="terminated");
  const serverDay=()=>new Date(state.now+7*3600000).toISOString().slice(0,10);
  const latest=id=>shared.events.filter(row=>row.employee_id===id&&row.punch_type).sort((a,b)=>a.occurred_at.localeCompare(b.occurred_at)||a.event_id.localeCompare(b.event_id)).at(-1);
  function punchError(employeeId,kind){
    const prior=latest(employeeId);
    if(!prior)return kind==="out"?"check_in_required":null;
    const newDayIn=kind==="in"&&prior.punch_type==="in"&&prior.occurred_at.slice(0,10)<serverDay();
    if(prior.punch_type===kind&&!newDayIn)return "same_direction";
    if(Date.parse(prior.occurred_at+"+07:00")>state.now-30000)return "cooldown";
    return null;
  }
  function response(challenge){
    if(challenge.status==="completed")return {status:"completed",event:challenge.event};
    if(challenge.status==="pending"&&(latest(challenge.employeeId)?.event_id||null)!==challenge.priorEventId)challenge.status="stale_state";
    if(challenge.status==="pending"&&state.now>=challenge.expires)challenge.status="expired";
    return {status:challenge.status,challenge_id:challenge.id,request_id:challenge.requestId,employee_id:challenge.employeeId,punch_type:challenge.kind,code:challenge.status==="pending"?challenge.code:null,expires_at:new Date(challenge.expires).toISOString(),server_time:new Date(state.now).toISOString(),attempts_remaining:challenge.attempts};
  }
  state.handlers.payroll_kiosk_touch_challenge=async args=>{
    const device=deviceFor(args.p_token);if(!device)return failure("PAYROLL_KIOSK_INVALID_TOKEN","42501");
    if(!employeeFor(args.p_employee_id))return failure("PAYROLL_KIOSK_EMPLOYEE_NOT_ACTIVE");
    const prior=state.challenges.find(row=>row.requestId===args.p_request_id);
    if(prior){if(prior.deviceId!==device.device_id||prior.employeeId!==args.p_employee_id||prior.kind!==args.p_kind)return failure("PAYROLL_KIOSK_REQUEST_CONFLICT");return success(response(prior));}
    const denied=punchError(args.p_employee_id,args.p_kind);if(denied)return failure("PAYROLL_KIOSK_"+denied.toUpperCase());
    for(const row of state.challenges)if(row.deviceId===device.device_id&&row.status==="pending")row.status="cancelled";
    const challenge={id:crypto.randomUUID(),requestId:args.p_request_id,deviceId:device.device_id,employeeId:args.p_employee_id,kind:args.p_kind,code:state.nextCodes.shift()||String(++state.sequence).padStart(4,"0"),status:"pending",expires:state.now+120000,attempts:5,priorEventId:latest(args.p_employee_id)?.event_id||null};
    state.challenges.push(challenge);
    if(state.loseChallengeResponse){state.loseChallengeResponse=false;return failure("Synthetic challenge response lost","FETCH_ERROR");}
    return success(response(challenge));
  };
  state.handlers.payroll_kiosk_touch_confirm=async args=>{
    const device=deviceFor(args.p_token);if(!device)return failure("PAYROLL_KIOSK_INVALID_TOKEN","42501");
    const challenge=state.challenges.find(row=>row.id===args.p_challenge_id&&row.deviceId===device.device_id);if(!challenge)return failure("PAYROLL_KIOSK_TOUCH_CHALLENGE_NOT_FOUND");
    if(challenge.status==="completed")return success({ok:true,event:{...challenge.event,replayed:true}});
    if(state.loseConfirmBeforeCommit){state.loseConfirmBeforeCommit=false;return failure("Synthetic confirm result unknown","FETCH_ERROR");}
    response(challenge);
    if(state.forceResult){challenge.status=state.forceResult;state.forceResult=null;}
    if(challenge.status!=="pending")return success({ok:false,error:challenge.status,attempts_remaining:challenge.attempts});
    if(args.p_code!==challenge.code){challenge.attempts--;if(!challenge.attempts)challenge.status="locked";return success({ok:false,error:challenge.attempts?"code_mismatch":"locked",attempts_remaining:challenge.attempts});}
    if(!employeeFor(challenge.employeeId))return success({ok:false,error:"employee_not_active",attempts_remaining:challenge.attempts});
    const denied=punchError(challenge.employeeId,challenge.kind);
    if(denied)return success({ok:false,error:denied,attempts_remaining:challenge.attempts});
    const at=state.eventTimes?.shift()||new Date(state.now+7*3600000).toISOString().slice(0,19);
    const event={event_id:crypto.randomUUID(),employee_id:challenge.employeeId,punch_type:challenge.kind,occurred_at:at,server_received_at:new Date(state.now).toISOString(),replayed:false,verification:"visible_code_confirmation",verification_method:"visible_code_confirmation",device_id:device.device_id,source:"kiosk"};
    challenge.status="completed";challenge.event=event;shared.events.push(event);shared.receipts[challenge.requestId]=event;
    if(state.loseConfirmResponse){state.loseConfirmResponse=false;return failure("Synthetic saved response lost","FETCH_ERROR");}
    return success({ok:true,event});
  };
  state.handlers.payroll_kiosk_touch_receipt=async args=>{
    const device=deviceFor(args.p_token);if(!device)return failure("PAYROLL_KIOSK_INVALID_TOKEN","42501");
    const challenge=state.challenges.find(row=>row.requestId===args.p_request_id&&row.deviceId===device.device_id);
    if(!challenge)return failure("PAYROLL_KIOSK_TOUCH_CHALLENGE_NOT_FOUND");
    if(challenge.status==="completed")return success({status:"saved",event:challenge.event});
    if(challenge.status==="pending")challenge.status="cancelled";
    return success({status:"not_saved"});
  };
  state.handlers.payroll_kiosk_touch_admin_receipt=async(args,instance)=>{
    if(instance.role!=="admin")return failure("PAYROLL_ADMIN_REQUIRED","42501");
    const challenge=state.challenges.find(row=>row.requestId===args.p_request_id&&row.deviceId===args.p_device_id);if(!challenge)return failure("PAYROLL_KIOSK_TOUCH_CHALLENGE_NOT_FOUND");
    if(challenge.status==="completed")return success({status:"saved",event:challenge.event});
    if(challenge.status==="pending")challenge.status="cancelled";return success({status:"not_saved"});
  };
  if(navigator.mediaDevices)navigator.mediaDevices.getUserMedia=async()=>{state.cameraRequests++;throw new Error("A camera-free attendance page must not request media");};
  window.supabase.createClient=(...args)=>{
    const client=original(...args),instance=shared.clients.at(-1),rpc=client.rpc.bind(client);
    client.rpc=(name,params={})=>{
      if(!state.handlers[name]){
        const result=rpc(name,params);if(name!=="payroll_kiosk_roster")return result;
        const promise=Promise.resolve(result).then(response=>{if(response.data&&!response.error&&!state.omitRosterServerDate){response.data.server_date=serverDay();response.data.server_time=new Date(state.now).toISOString();}return response;});
        promise.abortSignal=()=>promise;return promise;
      }
      const call={rpc:name,args:structuredClone(params)};state.calls.push(call);
      const promise=(async()=>{
        const result=await state.handlers[name](params,instance);
        if(state.deferRpc===name){state.deferRpc=null;await new Promise(resolve=>{state.releaseRpc=resolve;});}
        return result;
      })();
      promise.abortSignal=()=>promise;return promise;
    };
    return client;
  };
}
