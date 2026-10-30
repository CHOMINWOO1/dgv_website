(function (root) {
  "use strict";

  // Only one claimed employee is compared with their explicitly enrolled template.
  // No identification search, images, attributes, network upload or persistence.
  const MODEL = "dlib-resnet128-faceapi-1.7.15-tiny68-v1";
  const THRESHOLD = 0.48;
  const MODEL_LOAD_TIMEOUT_MS = 60000;
  const scriptUrl = root.document?.currentScript?.src;
  const baseUrl = scriptUrl ? new URL("vendor/attendance-face/", scriptUrl).href : "assets/vendor/attendance-face/";
  let loading = null, loaded = null, running = false;
  const messages = {
    loading:"얼굴 확인 모델을 준비합니다. / Đang tải mô hình nhận diện.",
    front:"카메라를 정면으로 보세요. / Nhìn thẳng vào máy ảnh.",
    no_face:"얼굴이 보이지 않습니다. 카메라를 보세요. / Không thấy khuôn mặt. Hãy nhìn vào máy ảnh.",
    multiple_faces:"한 사람만 화면에 보여야 합니다. / Chỉ một người trong khung hình.",
    low_confidence:"얼굴이 잘 보이도록 정면을 향해 주세요. / Để khuôn mặt rõ trong khung hình.",
    too_small:"카메라에 조금 더 가까이 오세요. / Đến gần máy ảnh hơn.",
    clipped:"얼굴 전체가 화면 안에 들어오게 해 주세요. / Đưa toàn bộ khuôn mặt vào khung hình.",
    dark:"조명을 밝게 해 주세요. / Cần thêm ánh sáng.",
    bright:"강한 역광을 피하세요. / Tránh ánh sáng quá mạnh.",
    blur:"움직임을 잠시 멈추고 렌즈를 확인해 주세요. / Giữ yên và kiểm tra ống kính.",
    pose:"고개를 너무 기울이지 마세요. / Không nghiêng đầu quá nhiều.",
    camera:"실시간 카메라를 켜 주세요. / Hãy bật máy ảnh trực tiếp.",
    timeout:"시간이 초과되었습니다. 자세와 조명을 확인하고 다시 시도하세요. / Hết thời gian. Kiểm tra tư thế, ánh sáng rồi thử lại.",
    inconsistent:"세 번의 얼굴이 일치하지 않습니다. 한 사람이 다시 등록해 주세요. / Ba mẫu không khớp. Một người hãy đăng ký lại.",
    model:"얼굴 모델을 준비하지 못했습니다. 연결과 브라우저를 확인하세요. / Không tải được mô hình. Kiểm tra kết nối và trình duyệt.",
    model_timeout:"얼굴 모델을 불러오는 데 시간이 오래 걸립니다. 인터넷 연결을 확인하고 다시 시도하세요. / Tải mô hình quá lâu. Kiểm tra kết nối mạng rồi thử lại.",
    busy:"이미 얼굴을 확인하고 있습니다. / Đang kiểm tra khuôn mặt.",
    template:"얼굴 등록정보를 다시 등록해 주세요. / Hãy đăng ký lại dữ liệu khuôn mặt."
  };
  function failure(code) { const error = new Error(messages[code] || code); error.code = code; return error; }
  function abort(signal) { if(signal?.aborted) throw new DOMException("Cancelled", "AbortError"); }
  function descriptor(value) {
    if (!value || value.length !== 128) return null;
    const array = Array.from(value);
    if (array.some(v => typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > 5)) return null;
    const norm = Math.sqrt(array.reduce((sum, v) => sum + v*v, 0));
    return norm >= 0.1 && norm <= 5 ? array : null;
  }
  function distance(a, b) { return Math.sqrt(a.reduce((sum, value, i) => sum + (value-b[i])**2, 0)); }
  function validateTemplate(value) {
    if (!value || value.version !== 1 || value.model !== MODEL || !Array.isArray(value.samples) || value.samples.length !== 3) return false;
    const samples = value.samples.map(descriptor);
    return samples.every(Boolean) && samples.every((sample, i) => samples.slice(i+1).every(other => distance(sample, other) <= 0.5));
  }
  function compare(probe, template) {
    const sample = descriptor(probe);
    if (!sample || !validateTemplate(template)) throw failure("template");
    const distances = template.samples.map(other => distance(sample, other)).sort((a,b) => a-b);
    const center = Array.from({length:128}, (_,i) => template.samples.reduce((sum, s) => sum+s[i], 0)/3);
    const centerDistance = distance(sample, center);
    // Two enrolled views AND the average must agree. Never use a single nearest view.
    return {matched:distances[1] <= THRESHOLD && centerDistance <= THRESHOLD, distance:centerDistance, threshold:THRESHOLD};
  }
  function poseFromLandmarks(points) {
    if (!points || points.length !== 68 || points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return null;
    const eye = start => ({x:points.slice(start,start+6).reduce((s,p)=>s+p.x,0)/6,y:points.slice(start,start+6).reduce((s,p)=>s+p.y,0)/6});
    const a=eye(36), b=eye(42), dx=b.x-a.x, dy=b.y-a.y, width=Math.hypot(dx,dy);
    if(width<8) return null;
    return {yaw:(points[30].x-(a.x+b.x)/2)/width,roll:Math.atan2(dy,dx)};
  }
  function imageQuality(data, width, height) {
    if(!data || data.length!==width*height*4 || width<3 || height<3) return {brightness:0,sharpness:0};
    const gray=new Float32Array(width*height);let brightness=0;
    for(let i=0;i<gray.length;i++){gray[i]=.299*data[i*4]+.587*data[i*4+1]+.114*data[i*4+2];brightness+=gray[i];}
    let sum=0,squares=0,count=0;
    for(let y=1;y<height-1;y++)for(let x=1;x<width-1;x++){const i=y*width+x,v=4*gray[i]-gray[i-1]-gray[i+1]-gray[i-width]-gray[i+width];sum+=v;squares+=v*v;count++;}
    return {brightness:brightness/gray.length,sharpness:Math.max(0,squares/count-(sum/count)**2)};
  }
  function qualityIssue(face, dimensions, quality) {
    if(!face) return "no_face";
    const b=face.box;
    if(!b || ![b.x,b.y,b.width,b.height,face.score].every(Number.isFinite))return "low_confidence";
    if(face.score<0.7)return "low_confidence";
    if(b.width<Math.max(90,dimensions.width*.18)||b.height<Math.max(90,dimensions.height*.22))return "too_small";
    if(b.x<4||b.y<4||b.x+b.width>dimensions.width-4||b.y+b.height>dimensions.height-4)return "clipped";
    if(quality.brightness<45)return "dark";
    if(quality.brightness>225)return "bright";
    if(quality.sharpness<12)return "blur";
    if(!face.pose||Math.abs(face.pose.roll)>.28||Math.abs(face.pose.yaw)>.65)return "pose";
    return null;
  }
  function liveVideo(video) {
    const tracks=video?.srcObject?.getVideoTracks?.();
    if(!(video instanceof root.HTMLVideoElement) || video.readyState<2 || !video.videoWidth || !video.videoHeight || video.paused || !tracks?.some(track=>track.readyState==="live"&&track.enabled))throw failure("camera");
  }
  function pause(milliseconds, signal) {
    abort(signal);
    return new Promise((resolve,reject)=>{const cancel=()=>{clearTimeout(timer);signal?.removeEventListener("abort",cancel);reject(new DOMException("Cancelled","AbortError"));};const timer=setTimeout(()=>{signal?.removeEventListener("abort",cancel);resolve();},milliseconds);signal?.addEventListener("abort",cancel,{once:true});});
  }
  function waitForModels(promise, signals) {
    signals.forEach(abort);
    return new Promise((resolve,reject)=>{
      let settled=false;
      const finish=(error,value)=>{
        if(settled)return;settled=true;clearTimeout(timer);
        signals.forEach(signal=>signal?.removeEventListener("abort",cancel));
        if(error)reject(error);else resolve(value);
      };
      const cancel=()=>finish(new DOMException("Cancelled","AbortError"));
      const timer=setTimeout(()=>finish(failure("model_timeout")),MODEL_LOAD_TIMEOUT_MS);
      signals.forEach(signal=>signal?.addEventListener("abort",cancel,{once:true}));
      // Cancel only this waiter. A shared initialization must not be duplicated
      // or dispose the networks while another caller is still awaiting it.
      promise.then(value=>finish(null,value),error=>finish(error));
    });
  }
  async function library() {
    if(root.faceapi)return root.faceapi;
    await new Promise((resolve,reject)=>{const script=root.document.createElement("script");script.src=baseUrl+"face-api-1.7.15.js";script.integrity="sha256-AWD3rzqMeM7ORcfsx2U4O610vs/UOLt4fN1iey1vLPY=";script.async=true;script.onload=resolve;script.onerror=()=>{script.remove();reject(failure("model"));};root.document.head.append(script);});
    if(!root.faceapi)throw failure("model");return root.faceapi;
  }
  function nets(api){return [api.nets.tinyFaceDetector,api.nets.faceLandmark68TinyNet,api.nets.faceRecognitionNet];}
  async function initialize(preferred) {
    const api=await library(),tf=api.tf;
    tf.setWasmPaths(baseUrl+"wasm/");
    // Avoid SharedArrayBuffer/cross-origin-isolation requirements on older tablets.
    tf.env().set("WASM_HAS_MULTITHREAD_SUPPORT",false);
    for(const backend of [...new Set([preferred||"wasm","webgl","cpu"])]){
      try{
        if(!await tf.setBackend(backend))continue;
        await tf.ready();
        for(const net of nets(api))await net.loadFromUri(baseUrl+"models");
        // Exercise every network on synthetic pixels before choosing a backend.
        // A backend can initialize successfully yet lack a required model kernel.
        const pixels=tf.zeros([160,160,3]);
        try{
          await api.detectAllFaces(pixels,new api.TinyFaceDetectorOptions({inputSize:160,scoreThreshold:.35}));
          await api.nets.faceLandmark68TinyNet.detectLandmarks(pixels);
          await api.nets.faceRecognitionNet.computeFaceDescriptor(pixels);
        }finally{pixels.dispose();}
        loaded={backend:tf.getBackend(),model:MODEL};return loaded;
      }catch{
        for(const net of nets(api))if(net.isLoaded)net.dispose();
      }
    }
    throw failure("model");
  }
  function create(options={}) {
    if(options.backend && !["wasm","webgl","cpu"].includes(options.backend))throw failure("model");
    let disposed=false,controller=null;const lifetime=new AbortController();
    function check(signal){abort(signal);if(disposed)throw new DOMException("Disposed","AbortError");}
    async function load({signal}={}){
      check(signal);if(loaded)return {...loaded};
      if(!loading)loading=initialize(options.backend).finally(()=>{loading=null;});
      const result=await waitForModels(loading,[signal,lifetime.signal]);check(signal);return {...result};
    }
    async function frame(video,signal){
      check(signal);liveVideo(video);
      const canvas=root.document.createElement("canvas"),scale=Math.min(1,640/video.videoWidth);
      canvas.width=Math.round(video.videoWidth*scale);canvas.height=Math.round(video.videoHeight*scale);
      const context=canvas.getContext("2d",{willReadFrequently:true});context.drawImage(video,0,0,canvas.width,canvas.height);
      try{
        const api=root.faceapi,faces=await api.detectAllFaces(canvas,new api.TinyFaceDetectorOptions({inputSize:320,scoreThreshold:.35})).withFaceLandmarks(true).withFaceDescriptors();
        check(signal);liveVideo(video);
        if(faces.length!==1)return {issue:faces.length?"multiple_faces":"no_face"};
        const found=faces[0],box=found.detection.box,pose=poseFromLandmarks(found.landmarks.positions);
        const crop=root.document.createElement("canvas");crop.width=96;crop.height=96;
        const cropContext=crop.getContext("2d",{willReadFrequently:true});
        cropContext.drawImage(canvas,box.x,box.y,box.width,box.height,0,0,96,96);
        const quality=imageQuality(cropContext.getImageData(0,0,96,96).data,96,96);crop.width=0;crop.height=0;
        const issue=qualityIssue({box,score:found.detection.score,pose},{width:canvas.width,height:canvas.height},quality);
        const sample=descriptor(found.descriptor);
        return issue?{issue}:!sample?{issue:"low_confidence"}:{sample,pose};
      }finally{canvas.width=0;canvas.height=0;}
    }
    async function sequence(video,{signal,onProgress}={},count=3){
      check(signal);if(running)throw failure("busy");running=true;controller=new AbortController();
      const cancel=()=>controller?.abort();signal?.addEventListener("abort",cancel,{once:true});
      const localSignal=controller.signal;
      try{
        check(signal);liveVideo(video);onProgress?.({step:"loading",message:messages.loading,attempt:0});await load({signal:localSignal});check(localSignal);
        const samples=[];let attempt=0,lastTime=-1;
        const deadline=Date.now()+45000;
        for(let sampleIndex=0;sampleIndex<count;sampleIndex++){
          const step="front";let accepted=null;
          onProgress?.({step,message:messages.front,attempt,sampleIndex,total:count});
          while(Date.now()<deadline){
            check(localSignal);liveVideo(video);
            // Distinct live frames only; there is deliberately no pose challenge.
            if(video.currentTime===lastTime){await pause(200,localSignal);continue;}
            lastTime=video.currentTime;
            const result=await frame(video,localSignal);attempt++;
            if(result.issue){onProgress?.({step,message:messages[result.issue],issue:result.issue,attempt,sampleIndex,total:count});}
            else{
              if(Math.abs(result.pose.yaw)<.20){accepted=result;break;}
              onProgress?.({step,message:messages.front,attempt,sampleIndex,total:count});
            }
            await pause(250,localSignal);
          }
          if(!accepted)throw failure("timeout");
          samples.push(accepted.sample);
          await pause(300,localSignal);
        }
        return {samples};
      }finally{signal?.removeEventListener("abort",cancel);controller=null;running=false;}
    }
    async function enroll(video,settings){
      const {samples}=await sequence(video,settings),template={version:1,model:MODEL,samples,createdAt:new Date().toISOString()};
      if(!validateTemplate(template))throw failure("inconsistent");return template;
    }
    async function verify(video,template,settings){
      if(!validateTemplate(template))throw failure("template");
      const {samples}=await sequence(video,settings,2);
      const results=samples.map(sample=>compare(sample,template));
      return {matched:results.every(result=>result.matched),distance:Math.max(...results.map(result=>result.distance)),threshold:THRESHOLD,challenge:"none",model:MODEL,backend:loaded.backend};
    }
    function dispose(){disposed=true;lifetime.abort();controller?.abort();}
    return Object.freeze({load,enroll,verify,dispose});
  }
  root.DGV_ATTENDANCE_FACE=Object.freeze({create,validateTemplate,MODEL,THRESHOLD,compare,poseFromLandmarks,imageQuality,qualityIssue});
})(typeof window!=="undefined"?window:globalThis);
