(function () {
  "use strict";
  const $=id=>document.getElementById(id),storage=window.DGV_ATTENDANCE_STORE,config=window.DGV_SUPABASE_CONFIG;
  if(!window.supabase?.createClient||!config||!storage){$("notice").hidden=false;$("notice").textContent="화면을 준비하지 못했습니다. 인터넷 연결 후 새로고침해 주세요. / Không tải được trang. Kiểm tra Internet rồi tải lại.";return;}
  const authOptions=key=>({auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false,storageKey:key}});
  const kiosk=supabase.createClient(config.url,config.publishableKey,authOptions("hana-touch-public"));
  const admin=supabase.createClient(config.url,config.publishableKey,authOptions("hana-touch-admin"));
  const state={device:null,roster:[],connected:false,revoked:false,busy:false,refreshing:false,pending:null,otherPending:null,challenge:null,digits:"",admin:false,adminGeneration:0,adminTimer:null,deviceEpoch:0,devices:[],storageReady:false};
  let refreshing=null,wakeLock;
  const selected=()=>state.roster.find(row=>row.id===$("employee").value);
  const kindText=kind=>kind==="in"?"출근 / Vào ca":"퇴근 / Tan ca";
  const uid=()=>{if(crypto.randomUUID)return crypto.randomUUID();const b=crypto.getRandomValues(new Uint8Array(16));b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;const h=Array.from(b,x=>x.toString(16).padStart(2,"0")).join("");return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;};
  const token=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),x=>x.toString(16).padStart(2,"0")).join("");
  // Raw attendance uses Vietnam wall time, independent of the tablet timezone.
  const timeText=value=>{const text=String(value||"").replace(" ","T"),date=new Date(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)?text:`${text}+07:00`);return Number.isFinite(date.getTime())?new Intl.DateTimeFormat("en-GB",{timeZone:"Asia/Ho_Chi_Minh",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false}).format(date):"";};
  function errorText(error){
    const value=String(error?.message||error||"");
    const messages={
      PAYROLL_KIOSK_INVALID_TOKEN:"기기 등록이 해제되었습니다. 관리자 설정에서 다시 등록해 주세요. / Thiết bị đã bị gỡ. Đăng ký lại trong thiết lập quản trị.",
      PAYROLL_KIOSK_DEVICE_NOT_ACTIVE:"사용 중지된 기기입니다. 관리자 설정에서 다시 등록해 주세요. / Thiết bị đã ngừng. Đăng ký lại trong thiết lập quản trị.",
      PAYROLL_KIOSK_EMPLOYEE_NOT_ACTIVE:"출퇴근 가능한 재직 직원인지 확인해 주세요. / Kiểm tra nhân viên đang làm việc.",
      PAYROLL_KIOSK_TOUCH_CHALLENGE_NOT_FOUND:"이전 요청을 확인하지 못했습니다. 관리자에게 문의해 주세요. 기록은 지우지 않았습니다. / Không tìm thấy yêu cầu trước. Liên hệ quản trị; dữ liệu vẫn được giữ.",
      PAYROLL_KIOSK_REQUEST_CONFLICT:"요청 정보가 일치하지 않습니다. 관리자에게 문의해 주세요. / Yêu cầu không khớp. Liên hệ quản trị.",
      PAYROLL_KIOSK_TOUCH_REQUEST_CONFLICT:"요청 정보가 일치하지 않습니다. 관리자에게 문의해 주세요. / Yêu cầu không khớp. Liên hệ quản trị.",
      PAYROLL_KIOSK_INVALID_PUNCH:"출퇴근 요청을 확인하지 못했습니다. 목록을 새로고침해 주세요. / Yêu cầu không hợp lệ. Tải lại danh sách.",
      PAYROLL_KIOSK_SAME_DIRECTION:"이미 같은 출퇴근 상태입니다. 최근 기록을 확인해 주세요. / Đã ở trạng thái này. Kiểm tra lần gần nhất.",
      PAYROLL_KIOSK_COOLDOWN:"방금 기록했습니다. 30초 후 다시 시도해 주세요. / Vừa chấm công. Thử lại sau 30 giây.",
      PAYROLL_KIOSK_CHECK_IN_REQUIRED:"출근 기록이 먼저 필요합니다. / Cần chấm công vào ca trước.",
      TOUCH_PENDING:"이전 출퇴근의 저장 여부를 먼저 확인해 주세요. / Kiểm tra kết quả chấm công trước.",
      TOUCH_DEVICE_CHANGED:"기기 등록이 변경되었습니다. 목록을 새로고침해 주세요. / Thiết bị đã thay đổi. Tải lại danh sách.",
      TOUCH_STORAGE:"이 기기에 저장 결과를 안전하게 보관할 수 없습니다. 브라우저 저장공간을 확인해 주세요. / Không lưu được trạng thái an toàn. Kiểm tra bộ nhớ trình duyệt.",
      TOUCH_RESPONSE:"서버 응답을 확인하지 못했습니다. 저장 여부 확인을 눌러 주세요. / Không xác nhận được phản hồi. Nhấn Kiểm tra kết quả.",
      AUTH_REQUIRED:"관리자 비밀번호로 설정을 다시 열어 주세요. / Mở lại thiết lập bằng mật khẩu quản trị."
    };
    for(const [code,message]of Object.entries(messages))if(value.includes(code))return message;
    if(/Invalid login|invalid_credentials/i.test(value))return "관리자 비밀번호가 올바르지 않습니다. / Mật khẩu quản trị không đúng.";
    if(error?.name==="AbortError"||/timeout|fetch|network|load failed/i.test(value))return "서버 응답을 받지 못했습니다. 인터넷 연결을 확인해 주세요. / Chưa nhận được phản hồi. Kiểm tra Internet.";
    if(/PGRST202|schema cache|function.*not exist/i.test(value))return "터치 출퇴근 서버 설정이 필요합니다. 관리자에게 문의해 주세요. / Cần thiết lập chấm công bằng số. Liên hệ quản trị.";
    return value||"처리하지 못했습니다. 다시 시도해 주세요. / Không thực hiện được. Thử lại.";
  }
  function notice(message,error=false,target="notice") {const el=$(target);el.textContent=message;el.hidden=!message;el.className=`notice${error?" error":""}`;}
  async function bounded(operation,abort){let timer;try{return await Promise.race([operation,new Promise((_,reject)=>{timer=setTimeout(()=>{abort?.();reject(new DOMException("Timeout","AbortError"));},20000);})]);}finally{clearTimeout(timer);}}
  async function rpc(client,name,args={}){const controller=new AbortController();const result=await bounded(client.rpc(name,args).abortSignal(controller.signal),()=>controller.abort());if(result.error)throw result.error;return result.data;}
  function optionsFor(select,people){const entries=people.map(row=>[row.id,`${row.name} · ${row.device_user_id}`]),signature=JSON.stringify(entries);if(select.dataset.options===signature)return;const value=select.value;select.replaceChildren(new Option("이름을 선택해 주세요 / Chọn tên",""),...entries.map(([id,label])=>new Option(label,id)));if(entries.some(([id])=>id===value))select.value=value;select.dataset.options=signature;}
  const blocked=()=>Boolean(state.pending||state.otherPending);
  function render(){
    $("setup").hidden=Boolean(state.device&&!state.revoked);
    $("setupTitle").textContent=state.revoked?"기기를 다시 등록해 주세요 / Đăng ký lại thiết bị":"이 기기를 등록해 주세요 / Đăng ký thiết bị";
    $("setupText").textContent=state.revoked?"이 기기의 사용 권한이 중지되었습니다. 관리자 설정에서 다시 등록할 수 있습니다. / Quyền sử dụng máy đã ngừng. Quản trị có thể đăng ký lại.":"관리자 비밀번호로 한 번 등록하면 사용할 수 있습니다. / Đăng ký một lần bằng mật khẩu quản trị.";
    $("deviceLabel").textContent=state.device?.name||"등록되지 않은 기기 / Chưa đăng ký thiết bị";
    $("connection").textContent=!navigator.onLine?"인터넷 끊김 / Ngoại tuyến":state.revoked?"등록 해제됨 / Đã bị gỡ":state.connected?"서버 연결됨 / Đã kết nối":"연결 확인 필요 / Kiểm tra kết nối";
    $("connection").classList.toggle("offline",!navigator.onLine||!state.connected);
    optionsFor($("employee"),state.roster);$("employee").disabled=state.busy||blocked()||!state.roster.length||Boolean(state.challenge);
    const row=selected(),ready=Boolean(row&&state.connected&&!state.revoked&&navigator.onLine&&!state.busy&&!blocked()&&!state.challenge&&state.storageReady);
    $("clockIn").disabled=!ready;$("clockOut").disabled=!ready;
    $("rosterStatus").textContent=state.device?`${state.roster.length}명 / nhân viên`:"";
    $("employeeAvailability").textContent=blocked()?"이전 요청의 저장 결과를 먼저 확인해 주세요. / Kiểm tra kết quả trước khi chấm công tiếp.":state.busy?"처리 중입니다. 잠시 기다려 주세요. / Đang xử lý. Vui lòng chờ.":!state.storageReady?"기기 저장공간을 확인하고 있습니다. / Đang kiểm tra bộ nhớ máy.":!state.device||state.revoked?"관리자 설정에서 기기를 등록해 주세요. / Đăng ký máy trong thiết lập quản trị.":!state.connected?"인터넷 연결을 확인한 뒤 새로고침해 주세요. / Kiểm tra Internet rồi tải lại.":row?"출근 또는 퇴근을 누르고 화면의 숫자를 입력해 주세요. / Chọn Vào ca hoặc Tan ca rồi nhập mã hiển thị.":state.roster.length?"내 이름을 선택해 주세요. / Chọn tên của bạn.":"출퇴근 가능한 재직 직원이 없습니다. / Chưa có nhân viên đang làm việc.";
    $("employeeState").textContent=row?.last_punch?`${kindText(row.last_punch.punch_type)} · ${timeText(row.last_punch.occurred_at)}`:row?"아직 기록 없음 / Chưa chấm công":"이름을 선택해 주세요 / Chọn tên";
    const receiptNeedsAdmin=Boolean(state.revoked||!state.device||(state.pending&&state.pending.deviceId!==state.device.device_id));
    $("pending").hidden=!state.pending;$("pendingText").textContent=state.pending?`${state.pending.name} · ${kindText(state.pending.kind)}\n${receiptNeedsAdmin?"기기 등록이 변경되었습니다. 관리자 설정에서 저장 여부를 확인해 주세요. / Thiết bị đã thay đổi. Kiểm tra kết quả trong thiết lập quản trị.":"다시 찍지 말고 저장 여부를 확인해 주세요. / Kiểm tra kết quả, không chấm công lại."}`:"";
    $("checkReceipt").disabled=state.busy||!navigator.onLine||receiptNeedsAdmin;
    $("otherPending").hidden=!state.otherPending;$("otherPendingText").textContent=state.otherPending?`${state.otherPending.name} · ${kindText(state.otherPending.kind)}\n이전에 사용한 화면에서 저장 여부를 확인해 주세요. 기기가 해제되었다면 관리자 설정에서 확인할 수 있습니다. / Kiểm tra trên trang trước; nếu máy bị gỡ, mở thiết lập quản trị.`:"";
    for(const id of ["settings","setupButton"])$(id).disabled=state.busy||Boolean(state.challenge);
    $("refreshRoster").disabled=state.busy||state.refreshing||!state.device||Boolean(state.challenge);
    $("registerSection").hidden=Boolean(state.device&&!state.revoked);
    $("registerDevice").querySelector("button").disabled=state.busy||blocked()||!state.storageReady;
    $("registrationHelp").textContent=blocked()?"먼저 아래에서 이전 저장 결과를 확인해 주세요. / Kiểm tra kết quả trước ở bên dưới.":"기존 근무기록과 등록정보는 보존됩니다. / Giữ nguyên dữ liệu chấm công và đăng ký hiện có.";
    $("adminRecovery").hidden=!blocked();$("adminCheckReceipt").disabled=state.busy||!navigator.onLine;
    $("closeAdmin").disabled=state.busy;$("adminLogin").querySelector("button").disabled=state.busy;$("deviceName").disabled=state.busy;
    document.querySelectorAll("[data-revoke]").forEach(button=>button.disabled=state.busy||button.dataset.revoked==="true");
    renderChallenge();
  }
  function renderChallenge(){
    $("touchDigits").textContent=Array.from({length:4},(_,index)=>state.digits[index]??"—").join(" ");
    const expired=state.challenge&&performance.now()>=state.challenge.deadline;
    $("touchConfirm").disabled=state.busy||state.digits.length!==4||!state.challenge||expired;
    document.querySelectorAll("#keypad button").forEach(button=>button.disabled=state.busy||!state.challenge||expired);
    $("touchCancel").disabled=state.busy;$("touchRenew").hidden=!expired;$("touchRenew").disabled=state.busy||blocked();
    if(state.challenge){const seconds=Math.max(0,Math.ceil((state.challenge.deadline-performance.now())/1000));$("challengeExpiry").textContent=seconds?`${seconds}초 안에 입력 / Nhập trong ${seconds}s`:"확인번호가 만료되었습니다. 새 확인번호를 받아 주세요. / Mã hết hạn. Hãy lấy mã mới.";}
  }
  async function readPending(){const [pending,other]=await Promise.all([storage.get("touch-pending"),storage.get("pending")]);state.pending=pending;state.otherPending=other;}
  async function syncDevice(){const device=await storage.get("device");if(state.device?.device_id!==device?.device_id||state.device?.token!==device?.token){state.deviceEpoch++;state.device=device;state.connected=false;state.revoked=false;state.roster=[];closeChallenge();}}
  async function action(operation,target="notice"){
    if(state.busy)return;state.busy=true;render();
    try{const run=async()=>{await readPending();await syncDevice();await operation();};if(navigator.locks)await navigator.locks.request("hana-attendance-action",{ifAvailable:true},async lock=>{if(!lock)throw new Error("다른 출퇴근 탭에서 작업 중입니다. / Một thẻ chấm công khác đang hoạt động.");await run();});else await run();}
    catch(error){if(/INVALID_TOKEN|DEVICE_NOT_ACTIVE/.test(String(error?.message))){state.revoked=true;state.connected=false;state.roster=[];closeChallenge();}notice(errorText(error),true,target);}
    finally{state.busy=false;render();}
  }
  async function refresh({quiet=false}={}){
    if(!state.device)return;if(refreshing)return refreshing;
    const device=state.device,epoch=state.deviceEpoch;state.refreshing=true;render();
    refreshing=(async()=>{try{const result=await rpc(kiosk,"payroll_kiosk_roster",{p_token:device.token});if(epoch!==state.deviceEpoch)return;if(result?.device_id!==device.device_id||!Array.isArray(result.employees))throw new Error("PAYROLL_KIOSK_INVALID_TOKEN");state.roster=result.employees;state.connected=true;state.revoked=false;}catch(error){if(epoch===state.deviceEpoch){state.connected=false;if(/INVALID_TOKEN|DEVICE_NOT_ACTIVE/.test(String(error?.message))){state.revoked=true;state.roster=[];closeChallenge();}if(!quiet||state.revoked)notice(errorText(error),true);}}finally{state.refreshing=false;refreshing=null;render();}})();return refreshing;
  }
  function closeChallenge(){state.challenge=null;state.digits="";$("challengeCode").textContent="";$("touchDigits").textContent="— — — —";if($("touchDialog").open)$("touchDialog").close();}
  function confirmRequest(request,event,isTouch){if(!event||event.employee_id!==request.employeeId||event.punch_type!==request.kind||!timeText(event.occurred_at)||(isTouch&&event.verification!=="visible_code_confirmation"))throw new Error("TOUCH_RESPONSE");}
  async function complete(event,request,key="touch-pending"){
    confirmRequest(request,event,key==="touch-pending");await storage.remove("touch-challenge-draft");await storage.remove(key);if(key==="touch-pending")state.pending=null;else state.otherPending=null;closeChallenge();
    notice(`${request.name} · ${kindText(request.kind)} 완료 / Đã lưu\n${timeText(event.occurred_at)} · 베트남 시각 / Giờ Việt Nam\n급여 페이지에 반영되었습니다. / Đã cập nhật vào bảng lương.`);$("notice").classList.add("success");if(!state.revoked)await refresh({quiet:true});
  }
  async function begin(kind){
    if(blocked())throw new Error("TOUCH_PENDING");const row=selected(),device=state.device;if(!row||!device||state.revoked||!navigator.onLine)return;
    notice("");let draft=await storage.get("touch-challenge-draft");
    if(!draft||draft.employeeId!==row.id||draft.kind!==kind||draft.deviceId!==device.device_id){draft={requestId:uid(),employeeId:row.id,name:row.name,kind,deviceId:device.device_id};await storage.put("touch-challenge-draft",draft);}
    const result=await rpc(kiosk,"payroll_kiosk_touch_challenge",{p_token:device.token,p_employee_id:row.id,p_kind:kind,p_request_id:draft.requestId});
    if(document.hidden)return;
    if(result?.status==="completed"){await complete(result.event,draft);return;}
    if(result?.status!=="pending"){await storage.remove("touch-challenge-draft");await refresh({quiet:true});throw new Error(result?.status==="stale_state"?rejectionText("stale_state"):"확인번호가 만료되었거나 취소되었습니다. 출근·퇴근을 다시 눌러 주세요. / Mã đã hết hạn hoặc bị hủy. Chọn lại Vào ca/Tan ca.");}
    if(result.employee_id!==draft.employeeId||result.request_id!==draft.requestId||result.punch_type!==draft.kind||!result.challenge_id||!/^\d{4}$/.test(result.code))throw new Error("TOUCH_RESPONSE");
    const lifetime=Date.parse(result.expires_at)-Date.parse(result.server_time);if(!Number.isFinite(lifetime)||lifetime<=0)throw new Error("확인번호가 만료되었습니다. 다시 눌러 주세요. / Mã đã hết hạn. Thử lại.");
    state.challenge={...draft,challengeId:result.challenge_id,deadline:performance.now()+Math.min(lifetime,300000)};state.digits="";
    $("touchEmployee").textContent=`${row.name} · ${kindText(kind)}`;$("touchInstruction").textContent="화면의 4자리 숫자를 아래 숫자판으로 입력해 주세요. / Nhập 4 số hiển thị bằng bàn phím bên dưới.";
    $("challengeCode").textContent=result.code;$("challengePanel").hidden=false;notice("",false,"touchNotice");$("touchDialog").showModal();renderChallenge();
  }
  const rejectionText=code=>({code_mismatch:"숫자가 다릅니다. 표시된 4자리를 다시 눌러 주세요. / Mã chưa đúng. Nhập lại 4 số hiển thị.",expired:"확인번호가 만료되었습니다. 다시 출근·퇴근을 눌러 주세요. / Mã đã hết hạn. Chọn lại Vào ca/Tan ca.",locked:"입력 횟수를 초과했습니다. 다시 출근·퇴근을 눌러 주세요. / Đã quá số lần nhập. Chọn lại Vào ca/Tan ca.",cancelled:"확인 요청이 취소되었습니다. 다시 출근·퇴근을 눌러 주세요. / Yêu cầu đã hủy. Chọn lại Vào ca/Tan ca.",stale_state:"다른 화면에서 출퇴근 상태가 변경되었습니다. 최근 기록을 확인하고 다시 눌러 주세요. / Trạng thái đã đổi trên trang khác. Kiểm tra lần gần nhất rồi thử lại.",record_unavailable:"이전에 저장된 기록을 현재 찾을 수 없습니다. 관리자에게 확인해 주세요. / Không tìm thấy bản ghi đã lưu trước đó. Liên hệ quản trị.",same_direction:errorText("PAYROLL_KIOSK_SAME_DIRECTION"),cooldown:errorText("PAYROLL_KIOSK_COOLDOWN"),check_in_required:errorText("PAYROLL_KIOSK_CHECK_IN_REQUIRED"),employee_not_active:errorText("PAYROLL_KIOSK_EMPLOYEE_NOT_ACTIVE")}[code]||"출퇴근을 저장하지 못했습니다. 새로고침해 주세요. / Chưa lưu được. Tải lại danh sách.");
  async function submit(){
    if(blocked())throw new Error("TOUCH_PENDING");const challenge=state.challenge,code=state.digits;if(!challenge||code.length!==4||document.hidden)return;
    if(challenge.deviceId!==state.device?.device_id)throw new Error("TOUCH_DEVICE_CHANGED");
    const request={requestId:challenge.requestId,challengeId:challenge.challengeId,employeeId:challenge.employeeId,name:challenge.name,kind:challenge.kind,deviceId:challenge.deviceId};
    // Persist before dispatch. Neither the displayed code nor typed digits is
    // kept in storage. Unknown outcomes use receipt/cancel, never confirm replay.
    await storage.put("touch-pending",request);state.pending=request;
    if(document.hidden){await storage.remove("touch-pending");state.pending=null;closeChallenge();return;}
    try{
      const result=await rpc(kiosk,"payroll_kiosk_touch_confirm",{p_token:state.device.token,p_challenge_id:challenge.challengeId,p_code:code});state.digits="";
      if(result?.ok===true){await complete(result.event,request);return;}
      if(result?.ok!==false||!result.error)throw new Error("TOUCH_RESPONSE");
      await storage.remove("touch-pending");state.pending=null;
      if(result.error==="code_mismatch"&&Number(result.attempts_remaining)>0){notice(`${rejectionText(result.error)}\n남은 횟수 / Số lần còn lại: ${result.attempts_remaining}`,true,"touchNotice");}
      else{await storage.remove("touch-challenge-draft");closeChallenge();notice(rejectionText(result.error),true);await refresh({quiet:true});}
    }catch(error){closeChallenge();if(/INVALID_TOKEN|DEVICE_NOT_ACTIVE/.test(String(error?.message))){state.revoked=true;state.connected=false;state.roster=[];}notice(`${errorText(error)}\n다시 찍지 말고 저장 여부 확인을 눌러 주세요. / Không chấm công lại; nhấn Kiểm tra kết quả.`,true);}
  }
  async function resolveTouch(asAdmin=false){
    const request=state.pending;if(!request)return;
    if(!asAdmin&&request.deviceId!==state.device?.device_id)throw new Error("TOUCH_DEVICE_CHANGED");
    const result=await rpc(asAdmin?admin:kiosk,asAdmin?"payroll_kiosk_touch_admin_receipt":"payroll_kiosk_touch_receipt",asAdmin?{p_device_id:request.deviceId,p_request_id:request.requestId}:{p_token:state.device.token,p_request_id:request.requestId});
    if(result?.status==="saved"){await complete(result.event,request);return;}
    if(result?.status!=="not_saved")throw new Error("TOUCH_RESPONSE");
    // The server atomically cancels the unsaved challenge before answering;
    // a delayed confirmation cannot create a later attendance timestamp.
    await storage.remove("touch-challenge-draft");await storage.remove("touch-pending");state.pending=null;closeChallenge();notice(result.reason==="record_unavailable"?rejectionText("record_unavailable"):"저장된 기록이 없으며 이전 요청을 취소했습니다. 다시 출근·퇴근을 눌러 주세요. / Chưa có bản ghi; đã hủy yêu cầu trước. Chọn lại Vào ca/Tan ca.",result.reason==="record_unavailable");if(!state.revoked)await refresh({quiet:true});
  }
  async function requireAdmin(){const generation=state.adminGeneration;const {data,error}=await bounded(admin.auth.getUser());if(error||!state.admin||generation!==state.adminGeneration||data?.user?.app_metadata?.role!=="admin")throw new Error("AUTH_REQUIRED");return generation;}
  async function closeAdmin(force=false){if(state.busy&&!force)return;state.adminGeneration++;state.admin=false;clearTimeout(state.adminTimer);$("adminPassword").value="";$("adminWorkspace").hidden=true;$("adminLogin").hidden=false;$("devices").replaceChildren();state.devices=[];if($("adminDialog").open)$("adminDialog").close();void admin.auth.signOut({scope:"local"});}
  function openAdmin(){if(state.busy)return;closeChallenge();notice("",false,"adminNotice");$("adminPassword").value="";$("adminDialog").showModal();$("adminPassword").focus();}
  async function adminData(){const generation=await requireAdmin(),devices=await rpc(admin,"payroll_kiosk_devices");if(!state.admin||generation!==state.adminGeneration)return;state.devices=devices||[];$("devices").replaceChildren();for(const device of state.devices){const row=document.createElement("div");row.className="device-row";const label=document.createElement("div");label.textContent=device.name+(device.device_id===state.device?.device_id?" · 이 기기 / Máy này":"");const detail=document.createElement("small");detail.textContent=device.status==="active"?"사용 중 / Đang hoạt động":"사용 중지 / Đã ngừng";label.append(detail);const button=document.createElement("button");button.type="button";button.className="secondary";button.dataset.revoke=device.device_id;button.dataset.revoked=String(device.status!=="active");button.textContent="등록 해제 / Gỡ";row.append(label,button);$("devices").append(row);}render();}
  async function login(event){event.preventDefault();const password=$("adminPassword").value;$("adminPassword").value="";await action(async()=>{const generation=++state.adminGeneration;try{const {error}=await bounded(admin.auth.signInWithPassword({email:config.authAccounts.admin,password:`dgv-v2/admin/${password}`}));if(error)throw error;const {data,error:verifyError}=await bounded(admin.auth.getUser());if(verifyError||data?.user?.app_metadata?.role!=="admin"||generation!==state.adminGeneration||!$("adminDialog").open)throw new Error("AUTH_REQUIRED");state.admin=true;$("adminWorkspace").hidden=false;$("adminLogin").hidden=true;notice("",false,"adminNotice");clearTimeout(state.adminTimer);state.adminTimer=setTimeout(()=>void closeAdmin(true),300000);await refresh({quiet:true});await adminData();}catch(error){state.admin=false;void admin.auth.signOut({scope:"local"});throw error;}},"adminNotice");}
  async function registerDevice(event){event.preventDefault();await action(async()=>{const generation=await requireAdmin();if(blocked())throw new Error("TOUCH_PENDING");if(state.device&&!state.revoked)return;const name=$("deviceName").value.trim();if(!name)throw new Error("기기 이름을 입력해 주세요. / Nhập tên thiết bị.");let draft=await storage.get("registration");if(!draft||draft.name!==name)draft={device_id:uid(),name,token:token()};await storage.put("registration",draft);await rpc(admin,"payroll_kiosk_register",{p_device_id:draft.device_id,p_name:draft.name,p_token:draft.token});if(!state.admin||generation!==state.adminGeneration)return;await storage.put("device",draft);await storage.remove("registration");state.deviceEpoch++;state.device=draft;state.revoked=false;state.roster=[];state.connected=false;void navigator.storage?.persist?.().catch(()=>false);await refresh({quiet:true});await adminData();notice("기기를 등록했습니다. 설정을 닫고 직원 이름을 선택해 주세요. / Đã đăng ký máy. Đóng thiết lập rồi chọn tên.",false,"adminNotice");},"adminNotice");}
  async function revoke(deviceId){await requireAdmin();await rpc(admin,"payroll_kiosk_revoke",{p_device_id:deviceId,p_reason:"Administrator revoked touch attendance device"});if(deviceId===state.device?.device_id){state.revoked=true;state.connected=false;state.roster=[];closeChallenge();}await adminData();notice("기기 권한을 중지했습니다. 현재 기기는 위에서 다시 등록할 수 있습니다. / Đã ngừng quyền thiết bị. Có thể đăng ký lại máy này ở trên.",false,"adminNotice");}
  async function adminRecovery(){await requireAdmin();if(state.pending)await resolveTouch(true);if(state.otherPending){const request=state.otherPending;await adminData();const device=state.devices.find(item=>item.device_id===request.deviceId);if(!device||device.status==="active")throw new Error("이전 기기가 아직 활성 상태입니다. 이전 출퇴근 화면에서 결과를 확인하거나 등록을 해제한 뒤 확인해 주세요. / Máy trước còn hoạt động. Kiểm tra trên trang trước hoặc gỡ máy rồi kiểm tra.");const {data,error}=await bounded(admin.from("payroll_attendance_raw").select("id,employee_id,punch_type,occurred_at").eq("kiosk_request_id",request.requestId).eq("kiosk_device_id",request.deviceId).maybeSingle());if(error)throw error;if(data)await complete(data,request,"pending");else{await storage.remove("pending");state.otherPending=null;notice("이전 기기의 요청은 저장되지 않았습니다. 해제된 기기의 기록 권한은 중지되어 있습니다. / Yêu cầu trước chưa được lưu; máy đã bị gỡ không thể ghi thêm.");}}notice("이전 저장 결과를 확인했습니다. / Đã kiểm tra kết quả trước.",false,"adminNotice");}
  function digit(value){if(state.busy||!state.challenge||state.digits.length>=4||performance.now()>=state.challenge.deadline)return;state.digits+=value;renderChallenge();}
  function clock(){const now=new Date();$("clock").textContent=new Intl.DateTimeFormat("en-GB",{timeZone:"Asia/Ho_Chi_Minh",hour:"2-digit",minute:"2-digit"}).format(now);$("date").textContent=new Intl.DateTimeFormat("ko-KR",{timeZone:"Asia/Ho_Chi_Minh",month:"long",day:"numeric",weekday:"short"}).format(now)+" · Giờ Việt Nam";renderChallenge();}
  async function wake(){try{if(navigator.wakeLock&&!document.hidden)wakeLock=await navigator.wakeLock.request("screen");}catch{/* Optional on older tablets. */}}
  $("employee").addEventListener("change",()=>{notice("");render();});
  $("clockIn").addEventListener("click",()=>void action(()=>begin("in")));$("clockOut").addEventListener("click",()=>void action(()=>begin("out")));
  $("touchConfirm").addEventListener("click",()=>void action(submit,"touchNotice"));
  $("touchRenew").addEventListener("click",()=>{const kind=state.challenge?.kind;if(!kind||state.busy)return;void action(async()=>{closeChallenge();await storage.remove("touch-challenge-draft");await begin(kind);});});
  $("keypad").addEventListener("click",event=>{const button=event.target.closest("[data-digit]");if(button)digit(button.dataset.digit);});
  $("touchClear").addEventListener("click",()=>{if(!state.busy){state.digits="";renderChallenge();}});$("touchBackspace").addEventListener("click",()=>{if(!state.busy){state.digits=state.digits.slice(0,-1);renderChallenge();}});
  function cancel(){if(state.busy)return;closeChallenge();void action(async()=>{await storage.remove("touch-challenge-draft");});}
  $("touchCancel").addEventListener("click",cancel);$("touchDialog").addEventListener("cancel",event=>{event.preventDefault();cancel();});
  $("touchDialog").addEventListener("keydown",event=>{if(/^[0-9]$/.test(event.key)){event.preventDefault();digit(event.key);}else if(event.key==="Backspace"){event.preventDefault();$("touchBackspace").click();}else if(event.key==="Enter"&&!event.target.closest("button")){event.preventDefault();if(!$("touchConfirm").disabled)$("touchConfirm").click();}});
  $("checkReceipt").addEventListener("click",()=>void action(()=>resolveTouch()));$("adminCheckReceipt").addEventListener("click",()=>void action(adminRecovery,"adminNotice"));
  $("refreshRoster").addEventListener("click",()=>void action(()=>refresh()));for(const id of["settings","setupButton"])$(id).addEventListener("click",openAdmin);
  $("adminLogin").addEventListener("submit",login);$("registerDevice").addEventListener("submit",registerDevice);$("closeAdmin").addEventListener("click",()=>void closeAdmin());$("adminDialog").addEventListener("cancel",event=>{event.preventDefault();void closeAdmin();});
  $("devices").addEventListener("click",event=>{const button=event.target.closest("[data-revoke]");if(button)void action(()=>revoke(button.dataset.revoke),"adminNotice");});
  $("fullscreen").addEventListener("click",async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();await wake();}catch{notice("브라우저 메뉴에서 홈 화면에 추가할 수 있습니다. / Có thể thêm trang vào màn hình chính.");}});
  async function backgroundRefresh(){if(state.busy||state.challenge||$("adminDialog").open||document.hidden)return;try{await readPending();await syncDevice();await refresh({quiet:true});}catch(error){notice(errorText(error),true);}finally{render();}}
  window.addEventListener("offline",()=>{state.connected=false;render();});window.addEventListener("online",()=>void backgroundRefresh());
  document.addEventListener("visibilitychange",()=>{if(document.hidden){state.digits="";if(!state.busy)closeChallenge();if(state.admin)void closeAdmin(true);}else{void wake();void backgroundRefresh();}});
  window.addEventListener("pagehide",()=>{state.digits="";void wakeLock?.release();void closeAdmin(true);});
  setInterval(()=>void backgroundRefresh(),30000);setInterval(clock,1000);clock();render();
  (async()=>{try{state.device=await storage.get("device");await readPending();state.storageReady=true;await refresh();await wake();}catch(error){notice(errorText(error),true);}finally{render();}})();
})();
