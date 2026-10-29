(function () {
  "use strict";
  const $ = id => document.getElementById(id), storage = window.DGV_ATTENDANCE_STORE;
  const config = window.DGV_SUPABASE_CONFIG;
  if(!window.supabase?.createClient||!config||!storage||!window.DGV_ATTENDANCE_FACE){$("notice").hidden=false;$("notice").textContent="화면을 준비하지 못했습니다. 인터넷 연결을 확인하고 새로고침해 주세요. / Không tải được trang. Kiểm tra Internet rồi tải lại.";return;}
  const options = key => ({auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false,storageKey:key}});
  const kiosk = supabase.createClient(config.url,config.publishableKey,options("hana-attendance-public"));
  const admin = supabase.createClient(config.url,config.publishableKey,options("hana-attendance-admin"));
  let engine = DGV_ATTENDANCE_FACE.create();
  const state = {device:null,roster:[],faces:[],pending:null,busy:false,connected:false,admin:false,adminGeneration:0,adminTimer:null,abort:null,stream:null,adminEmployees:[],refreshing:false};
  const esc = value => String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const selected = () => state.roster.find(row=>row.id===$("employee").value);
  const faceFor = row => row && state.faces.find(face=>face.employeeId===row.id&&face.enrollmentId===row.enrollment_id&&face.deviceId===state.device?.device_id);
  const kindText = kind => kind==="in" ? "출근 / Vào ca" : "퇴근 / Tan ca";
  const uid = () => {
    if (crypto.randomUUID) return crypto.randomUUID();
    const b=crypto.getRandomValues(new Uint8Array(16));b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;
    const h=Array.from(b,x=>x.toString(16).padStart(2,"0")).join("");return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
  };
  const token = () => Array.from(crypto.getRandomValues(new Uint8Array(32)),x=>x.toString(16).padStart(2,"0")).join("");
  function errorText(error) {
    const value=String(error?.message||error||"");
    const messages={
      PAYROLL_KIOSK_INVALID_TOKEN:"기기 등록이 해제되었거나 유효하지 않습니다. 관리자 설정에서 확인해 주세요. / Thiết bị không còn được phép chấm công.",
      PAYROLL_KIOSK_DEVICE_NOT_ACTIVE:"사용 중지된 기기입니다. / Thiết bị đã bị vô hiệu hóa.",
      PAYROLL_KIOSK_EMPLOYEE_NOT_ACTIVE:"재직 상태와 근무 시작일을 확인해 주세요. / Kiểm tra trạng thái và ngày bắt đầu làm việc.",
      PAYROLL_KIOSK_EMPLOYEE_NOT_ENROLLED:"직원의 얼굴을 이 기기에 다시 등록해 주세요. / Đăng ký lại nhân viên trên máy này.",
      PAYROLL_KIOSK_SAME_DIRECTION:"이미 같은 출퇴근 상태입니다. 최근 기록을 확인해 주세요. / Đã ở trạng thái này. Kiểm tra lần chấm công gần nhất.",
      PAYROLL_KIOSK_CHECK_IN_REQUIRED:"출근 기록이 먼저 필요합니다. / Cần chấm công vào ca trước.",
      PAYROLL_KIOSK_COOLDOWN:"방금 기록했습니다. 30초 후 다시 시도해 주세요. / Vừa chấm công. Thử lại sau 30 giây.",
      PAYROLL_KIOSK_REQUEST_CONFLICT:"요청 정보가 일치하지 않습니다. 관리자에게 문의해 주세요. / Yêu cầu không khớp. Liên hệ quản trị.",
      AUTH_REQUIRED:"관리자 비밀번호로 설정을 다시 열어 주세요. / Mở lại thiết lập bằng mật khẩu quản trị."
    };
    for(const [code,message] of Object.entries(messages))if(value.includes(code))return message;
    if(error?.name==="NotAllowedError")return "카메라 권한을 허용해 주세요. 주소창의 사이트 설정에서 변경할 수 있습니다. / Hãy cho phép dùng máy ảnh trong cài đặt trang web.";
    if(error?.name==="NotFoundError")return "카메라를 찾지 못했습니다. / Không tìm thấy máy ảnh.";
    if(error?.name==="NotReadableError")return "카메라를 사용하는 다른 앱을 닫아 주세요. / Đóng ứng dụng khác đang dùng máy ảnh.";
    if(error?.name==="AbortError")return "작업을 취소했거나 연결 시간이 초과되었습니다. / Đã hủy hoặc kết nối quá thời gian.";
    if(/Invalid login|invalid_credentials/i.test(value))return "관리자 비밀번호가 올바르지 않습니다. / Mật khẩu quản trị không đúng.";
    if(/fetch|network|timeout|load failed/i.test(value))return "서버에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요. / Không kết nối được máy chủ. Kiểm tra Internet.";
    if(/PGRST202|schema cache|function.*not exist/i.test(value))return "출퇴근 서버 설정이 필요합니다. / Cần thiết lập máy chủ chấm công.";
    return value || "처리하지 못했습니다. 다시 시도해 주세요. / Không thực hiện được. Vui lòng thử lại.";
  }
  function notice(message,error=false,adminOnly=false) {
    const target=$(adminOnly?"adminNotice":"notice");target.textContent=message;target.hidden=!message;target.className=`notice${error?" error":""}`;
  }
  async function rpc(client,name,args={}) {
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
    try {const result=await client.rpc(name,args).abortSignal(controller.signal);if(result.error)throw result.error;return result.data;}
    finally{clearTimeout(timer);}
  }
  function render() {
    $("setup").hidden=Boolean(state.device);
    $("deviceLabel").textContent=state.device?.name||"등록되지 않은 기기 / Chưa đăng ký thiết bị";
    $("connection").textContent=!navigator.onLine?"인터넷 끊김 / Ngoại tuyến":state.connected?"서버 연결됨 / Đã kết nối":"연결 확인 필요 / Kiểm tra kết nối";
    $("connection").classList.toggle("offline",!state.connected||!navigator.onLine);
    const choice=$("employee").value,available=state.roster.filter(faceFor);
    $("employee").innerHTML='<option value="">이름을 선택해 주세요 / Chọn tên</option>'+available.map(row=>`<option value="${esc(row.id)}">${esc(row.name)} · ${esc(row.device_user_id)}</option>`).join("");
    if(available.some(row=>row.id===choice))$("employee").value=choice;
    $("employee").disabled=state.busy||!available.length||Boolean(state.pending);
    const row=selected(),ready=Boolean(row&&faceFor(row)&&state.connected&&navigator.onLine&&!state.busy&&!state.pending);
    $("clockIn").disabled=!ready;$("clockOut").disabled=!ready;$("testFace").disabled=!ready;
    const last=row?.last_punch;
    $("employeeState").textContent=last?`${kindText(last.punch_type)} · ${String(last.occurred_at).replace("T"," ").slice(0,19)}`:row?"아직 기록 없음 / Chưa chấm công":"이름을 선택해 주세요 / Chọn tên";
    $("pending").hidden=!state.pending;$("checkReceipt").disabled=state.busy||!navigator.onLine;
    $("pendingText").textContent=state.pending?`${state.pending.name} · ${kindText(state.pending.kind)}\n서버 저장 여부를 확인하기 전에는 다시 찍지 마세요. / Kiểm tra trước khi chấm công lại.`:"";
    for(const id of ["openCamera","setupButton","settings","stopCamera"])$(id).disabled=state.busy;
    $("closeAdmin").disabled=state.busy&&!state.abort;
    $("registerSection").hidden=Boolean(state.device);
    $("enrollSection").hidden=!state.device;
    $("forgetDevice").hidden=!state.device;
    for(const id of ["enrollFace","removeFace","enrollEmployee","deviceName","forgetDevice"])$(id).disabled=state.busy;
    $("adminLogin").querySelector("button").disabled=state.busy;
    $("registerDevice").querySelector("button").disabled=state.busy;
    document.querySelectorAll("[data-revoke]").forEach(button=>button.disabled=state.busy||button.dataset.revoked==="true");
  }
  async function action(operation,adminOnly=false) {
    if(state.busy)return;state.busy=true;render();
    try {
      const run=async()=>{state.pending=await storage.get("pending");await operation();};
      if(navigator.locks)await navigator.locks.request("hana-attendance-action",{ifAvailable:true},async lock=>{if(!lock)throw new Error("다른 출퇴근 탭에서 작업 중입니다. / Một thẻ chấm công khác đang hoạt động.");await run();});
      else await run();
    }catch(error){notice(errorText(error),true,adminOnly);}
    finally{state.busy=false;state.abort=null;$("cancelFace").hidden=true;$("cancelEnrollment").hidden=true;render();}
  }
  async function refresh({quiet=false}={}) {
    if(!state.device||state.refreshing)return;
    state.refreshing=true;
    try {
      const deviceId=state.device.device_id;
      const roster=await rpc(kiosk,"payroll_kiosk_roster",{p_token:state.device.token});
      if(state.device?.device_id!==deviceId)return;
      state.roster=roster.employees||[];state.faces=await storage.faces();state.connected=true;
      if(state.device.name!==roster.name){state.device.name=roster.name;await storage.put("device",state.device);}
    }catch(error){state.connected=false;if(!quiet)notice(errorText(error),true);if(String(error?.message).includes("INVALID_TOKEN")){state.roster=[];stopCamera();}}
    finally{state.refreshing=false;render();}
  }
  function stopCamera() {
    state.stream?.getTracks().forEach(track=>track.stop());state.stream=null;
    for(const id of ["camera","enrollCamera"]){$(id).srcObject=null;$(id).hidden=true;}
    $("cameraPlaceholder").hidden=false;$("stopCamera").hidden=true;
    $("cameraState").textContent="카메라 꺼짐 / Máy ảnh tắt";
  }
  async function camera(video) {
    if(!window.isSecureContext||!navigator.mediaDevices?.getUserMedia)throw new Error("HTTPS 주소에서 최신 Chrome으로 열어 주세요. / Mở địa chỉ HTTPS bằng Chrome mới nhất.");
    if(state.stream&&video.srcObject===state.stream&&state.stream.active)return;
    stopCamera();
    const generation=state.adminGeneration;
    const stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:"user",width:{ideal:640},height:{ideal:480},frameRate:{ideal:15,max:15}},audio:false});
    if(document.hidden||(video.id==="enrollCamera"&&(!state.admin||state.adminGeneration!==generation))||state.abort?.signal.aborted){stream.getTracks().forEach(track=>track.stop());throw new DOMException("Cancelled","AbortError");}
    state.stream=stream;video.srcObject=stream;video.hidden=false;await video.play();
    if(video.id==="camera"){$("cameraPlaceholder").hidden=true;$("stopCamera").hidden=false;$("cameraState").textContent="카메라 켜짐 / Máy ảnh đang bật";}
  }
  function cancelFace() {state.abort?.abort();engine.dispose();engine=DGV_ATTENDANCE_FACE.create();stopCamera();}
  function progress(id) {return value=>{$(id).textContent=value.message+(value.total?` (${(value.sampleIndex||0)+1}/${value.total})`:"");};}
  async function confirmFace(kind) {
    const row=selected(),registered=faceFor(row);
    if(!row||!registered||!state.device||state.pending)return;
    notice("");
    await refresh();
    const current=state.roster.find(item=>item.id===row.id);
    if(!state.connected||!current||!faceFor(current))throw new Error("직원 또는 기기 등록을 확인해 주세요. / Kiểm tra đăng ký nhân viên và thiết bị.");
    const currentFace=faceFor(current);
    state.abort=new AbortController();render();$("cancelFace").hidden=false;
    await camera($("camera"));
    const started=performance.now();
    const result=await engine.verify($("camera"),currentFace.template,{signal:state.abort.signal,onProgress:progress("faceProgress")});
    if(state.abort.signal.aborted||document.hidden)throw new DOMException("Cancelled","AbortError");
    const seconds=((performance.now()-started)/1000).toFixed(1);
    if(!result.matched){notice("등록된 얼굴과 일치하지 않습니다. 이름과 조명을 확인해 주세요. / Khuôn mặt không khớp. Kiểm tra tên và ánh sáng.",true);return;}
    $("faceProgress").textContent=`얼굴 확인 완료 · ${seconds}초 / Đã nhận diện · ${seconds}s`;
    if(kind==="test"){notice(`얼굴 확인 성공 · ${row.name}\n테스트 완료 (${seconds}초). 출퇴근 기록은 저장하지 않았습니다. / Thử thành công; không ghi giờ làm.`);return;}
    if(!navigator.onLine)throw new Error("인터넷에 연결한 뒤 다시 찍어 주세요. 아직 출퇴근 기록을 저장하지 않았습니다. / Kết nối Internet rồi chấm công lại; chưa lưu giờ làm.");
    const request={requestId:uid(),employeeId:row.id,name:row.name,kind,deviceId:state.device.device_id,attemptedAt:new Date().toISOString()};
    await storage.put("pending",request);state.pending=request;render();
    if(state.abort.signal.aborted||document.hidden){await storage.remove("pending");state.pending=null;throw new DOMException("Cancelled","AbortError");}
    // A cancelled response can still have committed. The durable request receipt
    // is checked instead of manufacturing a later clock time by blind retries.
    try {
      const receipt=await rpc(kiosk,"payroll_kiosk_punch",{p_token:state.device.token,p_employee_id:row.id,p_kind:kind,p_request_id:request.requestId});
      await complete(receipt,request);
    }catch(error){
      notice(`${errorText(error)}\n저장 여부 확인 버튼으로 결과를 확인해 주세요. / Nhấn Kiểm tra để xác nhận đã lưu hay chưa.`,true);
    }
  }
  async function complete(receipt,request) {
    if(!receipt||receipt.employee_id!==request.employeeId||receipt.punch_type!==request.kind)throw new Error("서버 응답이 요청과 다릅니다. / Phản hồi máy chủ không khớp.");
    await storage.remove("pending");state.pending=null;
    notice(`${request.name} · ${kindText(request.kind)} 완료 / Đã lưu\n${String(receipt.occurred_at).replace("T"," ").slice(0,19)} · 베트남 시각 / Giờ Việt Nam\n급여 페이지에 반영되었습니다. / Đã cập nhật vào bảng lương.`);
    $("notice").classList.add("success");
    stopCamera();await refresh({quiet:true});
  }
  async function checkReceipt() {
    if(!state.pending||!state.device)return;
    const request=state.pending;
    const receipt=await rpc(kiosk,"payroll_kiosk_receipt",{p_token:state.device.token,p_request_id:request.requestId});
    if(receipt){await complete(receipt,request);return;}
    await storage.remove("pending");state.pending=null;
    notice("서버에 저장된 기록이 없습니다. 얼굴 확인 후 다시 출퇴근을 찍어 주세요. / Chưa có bản ghi trên máy chủ. Nhận diện rồi chấm công lại.",true);
    await refresh({quiet:true});
  }
  async function requireAdmin() {
    const {data,error}=await admin.auth.getUser();
    if(error||data?.user?.app_metadata?.role!=="admin"||!state.admin)throw new Error("AUTH_REQUIRED");
    return state.adminGeneration;
  }
  async function closeAdmin(force=false) {
    if(state.busy&&!force&&!state.abort)return;
    state.adminGeneration++;state.admin=false;clearTimeout(state.adminTimer);cancelFace();
    $("adminPassword").value="";$("consent").checked=false;$("adminWorkspace").hidden=true;$("adminLogin").hidden=false;
    $("enrollEmployee").innerHTML="";$("devices").replaceChildren();$("localEnrollments").textContent="";state.adminEmployees=[];
    if($("adminDialog").open)$("adminDialog").close();
    await admin.auth.signOut({scope:"local"});
  }
  function openAdmin() {
    if(state.busy)return;stopCamera();notice("",false,true);$("adminPassword").value="";$("adminDialog").showModal();$("adminPassword").focus();
  }
  async function adminData() {
    const generation=await requireAdmin();
    const people=[];
    for(let offset=0;;offset+=500){
      const {data,error}=await admin.from("payroll_employees").select("id,device_user_id,name,active").eq("active",true).order("id").range(offset,offset+499);
      if(error)throw error;people.push(...data);if(data.length<500)break;if(offset>=4500)throw new Error("직원 목록이 너무 큽니다. / Danh sách quá lớn.");
    }
    const devices=await rpc(admin,"payroll_kiosk_devices");
    if(!state.admin||generation!==state.adminGeneration)return;
    state.adminEmployees=people;
    const old=$("enrollEmployee").value;
    $("enrollEmployee").innerHTML='<option value="">직원을 선택해 주세요 / Chọn nhân viên</option>'+people.map(row=>`<option value="${esc(row.id)}">${esc(row.name)} · ${esc(row.device_user_id)}</option>`).join("");
    if(people.some(row=>row.id===old))$("enrollEmployee").value=old;
    $("devices").innerHTML=(devices||[]).map(device=>`<div class="device-row"><div>${esc(device.name)}${device.device_id===state.device?.device_id?" · 이 기기 / Máy này":""}<small>${device.status==="active"?"사용 중 / Đang hoạt động":"사용 중지 / Đã ngừng"}</small></div><button class="secondary" data-revoke="${esc(device.device_id)}" data-revoked="${device.status!=="active"}" ${device.status!=="active"?"disabled":""}>등록 해제 / Gỡ</button></div>`).join("")||'<p class="muted">등록 기기 없음 / Chưa có thiết bị</p>';
    state.faces=await storage.faces();
    $("localEnrollments").textContent="이 기기에 저장된 얼굴 / Khuôn mặt đã lưu: "+state.faces.filter(face=>face.deviceId===state.device?.device_id).map(face=>people.find(person=>person.id===face.employeeId)?.name||"재직 확인 필요 / Kiểm tra nhân viên").join(", ");
    render();
  }
  async function login(event) {
    event.preventDefault();const password=$("adminPassword").value;$("adminPassword").value="";
    await action(async()=>{
      const generation=++state.adminGeneration;
      const {error}=await admin.auth.signInWithPassword({email:config.authAccounts.admin,password:`dgv-v2/admin/${password}`});if(error)throw error;
      const {data,error:verifyError}=await admin.auth.getUser();
      if(verifyError||data?.user?.app_metadata?.role!=="admin"||generation!==state.adminGeneration){await admin.auth.signOut({scope:"local"});throw new Error("AUTH_REQUIRED");}
      state.admin=true;$("adminWorkspace").hidden=false;$("adminLogin").hidden=true;notice("",false,true);
      clearTimeout(state.adminTimer);state.adminTimer=setTimeout(()=>void closeAdmin(true),300000);
      await adminData();
    },true);
  }
  async function registerDevice(event) {
    event.preventDefault();await action(async()=>{
      const generation=await requireAdmin(),name=$("deviceName").value.trim();
      if(!name)throw new Error("기기 이름을 입력해 주세요. / Nhập tên thiết bị.");
      let draft=await storage.get("registration");
      if(!draft||draft.name!==name)draft={device_id:uid(),name,token:token()};
      await storage.put("registration",draft);
      await rpc(admin,"payroll_kiosk_register",{p_device_id:draft.device_id,p_name:draft.name,p_token:draft.token});
      if(!state.admin||generation!==state.adminGeneration)return;
      await storage.put("device",draft);await storage.remove("registration");state.device=draft;
      if(generation!==state.adminGeneration)return;
      await navigator.storage?.persist?.().catch(()=>false);
      await refresh({quiet:true});await adminData();notice("기기를 등록했습니다. 직원 얼굴을 등록해 주세요. / Đã đăng ký thiết bị. Hãy đăng ký khuôn mặt.",false,true);
    },true);
  }
  async function enroll() {
    const generation=await requireAdmin(),employeeId=$("enrollEmployee").value,row=state.adminEmployees.find(item=>item.id===employeeId);
    if(!row||!state.device)throw new Error("직원을 선택해 주세요. / Chọn nhân viên.");
    if(!$("consent").checked)throw new Error("얼굴정보 사용에 대한 직원 동의를 확인해 주세요. / Xác nhận sự đồng ý của nhân viên.");
    state.abort=new AbortController();render();$("cancelEnrollment").hidden=false;notice("",false,true);
    await camera($("enrollCamera"));
    const template=await engine.enroll($("enrollCamera"),{signal:state.abort.signal,onProgress:progress("enrollProgress")});
    if(state.abort.signal.aborted||!state.admin||generation!==state.adminGeneration)throw new DOMException("Cancelled","AbortError");
    await requireAdmin();
    const enrollmentId=await rpc(admin,"payroll_kiosk_enroll",{p_device_id:state.device.device_id,p_employee_id:row.id,p_consent_version:"hana-local-face-v1"});
    if(!state.admin||generation!==state.adminGeneration)throw new Error("AUTH_REQUIRED");
    await storage.put(`face:${row.id}`,{employeeId:row.id,deviceId:state.device.device_id,enrollmentId,template});
    stopCamera();$("consent").checked=false;$("enrollProgress").textContent=`${row.name} · 얼굴 등록 완료 / Đã đăng ký khuôn mặt`;
    await refresh({quiet:true});await adminData();notice(`${row.name} · 등록했습니다. 설정을 닫고 얼굴인식을 테스트해 주세요. / Đã đăng ký. Đóng thiết lập và thử nhận diện.`,false,true);
  }
  async function removeFace() {
    await requireAdmin();const employeeId=$("enrollEmployee").value;
    if(!employeeId||!state.device)throw new Error("직원을 선택해 주세요. / Chọn nhân viên.");
    await rpc(admin,"payroll_kiosk_unenroll",{p_device_id:state.device.device_id,p_employee_id:employeeId,p_reason:"Administrator removed local face enrollment"});
    await storage.remove(`face:${employeeId}`);await refresh({quiet:true});await adminData();notice("직원 얼굴 등록을 해제했습니다. / Đã gỡ đăng ký khuôn mặt.",false,true);
  }
  async function revoke(deviceId) {
    await requireAdmin();
    await rpc(admin,"payroll_kiosk_revoke",{p_device_id:deviceId,p_reason:"Administrator revoked attendance device"});
    if(deviceId===state.device?.device_id){state.connected=false;state.roster=[];stopCamera();}
    await adminData();notice("기기 출퇴근 권한을 중지했습니다. / Đã ngừng quyền chấm công của thiết bị.",false,true);
  }
  async function forget() {
    await requireAdmin();if(!state.device)return;
    if(state.pending){
      // A revoked capability cannot read receipts. An administrator can resolve
      // the exact request through existing payroll RLS before clearing this device.
      const {error}=await admin.from("payroll_attendance_raw").select("id,employee_id,punch_type,occurred_at").eq("kiosk_request_id",state.pending.requestId).eq("kiosk_device_id",state.device.device_id).maybeSingle();
      if(error)throw error;
    }
    await rpc(admin,"payroll_kiosk_revoke",{p_device_id:state.device.device_id,p_reason:"Administrator cleared this browser"});
    await storage.clear();state.device=null;state.pending=null;state.faces=[];state.roster=[];state.connected=false;await adminData();notice("이 브라우저의 기기·얼굴정보를 지웠습니다. 서버의 근무기록은 보존됩니다. / Đã xóa dữ liệu trên máy này; giữ nguyên chấm công trên máy chủ.",false,true);
  }
  function clock() {
    const now=new Date();$("clock").textContent=new Intl.DateTimeFormat("en-GB",{timeZone:"Asia/Ho_Chi_Minh",hour:"2-digit",minute:"2-digit"}).format(now);
    $("date").textContent=new Intl.DateTimeFormat("ko-KR",{timeZone:"Asia/Ho_Chi_Minh",month:"long",day:"numeric",weekday:"short"}).format(now)+" · Giờ Việt Nam";
  }
  let wakeLock;
  async function wake() {try{if(navigator.wakeLock&&!document.hidden)wakeLock=await navigator.wakeLock.request("screen");}catch{/* The tablet's display settings remain authoritative. */}}
  $("employee").addEventListener("change",()=>{notice("");render();});
  $("openCamera").addEventListener("click",()=>void action(()=>camera($("camera"))));
  $("stopCamera").addEventListener("click",stopCamera);
  $("clockIn").addEventListener("click",()=>void action(()=>confirmFace("in")));
  $("clockOut").addEventListener("click",()=>void action(()=>confirmFace("out")));
  $("testFace").addEventListener("click",()=>void action(()=>confirmFace("test")));
  $("checkReceipt").addEventListener("click",()=>void action(checkReceipt));
  for(const id of ["cancelFace","cancelEnrollment"])$(id).addEventListener("click",cancelFace);
  for(const id of ["settings","setupButton"])$(id).addEventListener("click",openAdmin);
  $("closeAdmin").addEventListener("click",()=>void closeAdmin());
  $("adminDialog").addEventListener("cancel",event=>{event.preventDefault();void closeAdmin();});
  $("adminLogin").addEventListener("submit",login);$("registerDevice").addEventListener("submit",registerDevice);
  $("enrollFace").addEventListener("click",()=>void action(enroll,true));
  $("removeFace").addEventListener("click",()=>void action(removeFace,true));
  $("forgetDevice").addEventListener("click",()=>void action(forget,true));
  $("devices").addEventListener("click",event=>{const button=event.target.closest("[data-revoke]");if(button)void action(()=>revoke(button.dataset.revoke),true);});
  $("fullscreen").addEventListener("click",async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();await wake();}catch{notice("브라우저 메뉴에서 홈 화면에 추가해 사용할 수 있습니다. / Có thể thêm trang vào màn hình chính.");}});
  window.addEventListener("offline",()=>{state.connected=false;render();});
  window.addEventListener("online",()=>{if(!state.busy)void refresh();});
  document.addEventListener("visibilitychange",()=>{if(document.hidden){cancelFace();if(state.admin)void closeAdmin(true);}else{void wake();if(!state.busy)void refresh({quiet:true});}});
  window.addEventListener("pagehide",()=>{cancelFace();void wakeLock?.release();void admin.auth.signOut({scope:"local"});});
  setInterval(()=>{if(!document.hidden&&!state.busy&&!$("adminDialog").open)void refresh({quiet:true});},30000);
  setInterval(clock,1000);clock();render();
  (async()=>{try{state.device=await storage.get("device");state.pending=await storage.get("pending");state.faces=await storage.faces();await refresh();await wake();}catch(error){notice(errorText(error),true);}finally{render();}})();
})();
