import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import vm from "node:vm";

const source=await readFile(new URL("../assets/attendance-face.js",import.meta.url),"utf8");
function descriptor(value=.1){return Array(128).fill(value);}
function landmarks(yaw=0,roll=0){const points=Array.from({length:68},()=>({x:200,y:180}));for(let i=36;i<42;i++)points[i]={x:175,y:160};for(let i=42;i<48;i++)points[i]={x:225,y:160+Math.tan(roll)*50};points[30]={x:200+yaw*50,y:190};return points;}
function harness({failedBackends=[],failedWarmupBackends=[],backendError=false,initializationGate=null}={}){
  const stats={loads:0,captures:0,backends:[],yaw:0,sample:descriptor(),faceCount:1};
  const modelTimers=new Set();
  class Video{constructor(){this.readyState=2;this.videoWidth=640;this.videoHeight=480;this.paused=false;this.srcObject={getVideoTracks:()=>[{readyState:"live",enabled:true}]};this.tick=0;}get currentTime(){return ++this.tick/10;}}
  function canvas(){return {width:0,height:0,getContext(){return {drawImage(){},getImageData(){const data=new Uint8ClampedArray(96*96*4);for(let i=0;i<data.length;i+=4){data[i]=data[i+1]=data[i+2]=(i/4%2)?150:90;data[i+3]=255;}return {data};}};}};}
  const net=()=>({isLoaded:false,async loadFromUri(){stats.loads++;if(initializationGate)await initializationGate;this.isLoaded=true;},async detectLandmarks(){return {};},async computeFaceDescriptor(){if(failedWarmupBackends.includes(selected))throw new Error("missing synthetic kernel");return descriptor();},dispose(){this.isLoaded=false;}});
  let selected;
  const faceapi={tf:{zeros:()=>({dispose(){}}),setWasmPaths(){},env:()=>({set(){}}),async setBackend(name){stats.backends.push(name);if(backendError)throw new Error("backend unavailable");if(failedBackends.includes(name))return false;selected=name;return true;},async ready(){},getBackend:()=>selected},nets:{tinyFaceDetector:net(),faceLandmark68TinyNet:net(),faceRecognitionNet:net()},TinyFaceDetectorOptions:class{},detectAllFaces(){stats.captures++;return {withFaceLandmarks(){return {async withFaceDescriptors(){return Array.from({length:stats.faceCount},()=>({detection:{score:.95,box:{x:120,y:70,width:220,height:290}},landmarks:{positions:landmarks(stats.yaw)},descriptor:stats.sample}));}};}};}};
  const context={console,URL,Date,Float32Array,Uint8Array,Uint8ClampedArray,AbortController,DOMException,HTMLVideoElement:Video,document:{createElement:canvas},crypto:{getRandomValues(array){array[0]=1;return array;}},faceapi,
    setTimeout(callback,milliseconds){if(milliseconds===60000){const timer={callback};modelTimers.add(timer);return timer;}return setTimeout(callback,1);},
    clearTimeout(timer){if(!modelTimers.delete(timer))clearTimeout(timer);}};
  vm.createContext(context);vm.runInContext(source,context);return {api:context.DGV_ATTENDANCE_FACE,stats,Video,modelTimers,
    fireModelTimeouts(){for(const timer of [...modelTimers]){modelTimers.delete(timer);timer.callback();}}};
}
const {api,stats,Video}=harness({failedBackends:["wasm"]});
const template={version:1,model:api.MODEL,samples:[descriptor(),descriptor(.101),descriptor(.099)],createdAt:new Date().toISOString()};
assert.equal(api.validateTemplate(template),true);
assert.equal(api.validateTemplate({...template,model:"another-model"}),false);
assert.equal(api.validateTemplate({...template,samples:[descriptor(),descriptor()]}),false);
assert.equal(api.validateTemplate({...template,samples:[descriptor(),descriptor(),Array(128).fill(NaN)]}),false);
assert.equal(api.validateTemplate({...template,samples:[descriptor(),descriptor(),Array(128).fill(0)]}),false);
assert.equal(api.validateTemplate({...template,samples:[descriptor(),descriptor(),descriptor(.2)]}),false);
assert.equal(api.compare(descriptor(),template).matched,true);
assert.equal(api.compare(descriptor(.16),template).matched,false);
assert.throws(()=>api.compare(Array(127).fill(.1),template),/다시 등록/);
assert.equal(api.compare(descriptor(.06),{...template,samples:[descriptor(.1),descriptor(.14),descriptor(.14)]}).matched,false,"one nearest sample cannot authorize a mismatching pair");
assert.equal(api.poseFromLandmarks(landmarks(.2)).yaw,.2);
assert.equal(api.poseFromLandmarks([]),null);
const quality=api.imageQuality(new Uint8ClampedArray(64).fill(100),4,4);
assert.equal(Math.round(quality.brightness),100);assert.equal(quality.sharpness,0);
const face={score:.95,box:{x:100,y:60,width:200,height:300},pose:{yaw:0,roll:0}},dims={width:640,height:480};
assert.equal(api.qualityIssue(face,dims,{brightness:100,sharpness:50}),null);
assert.equal(api.qualityIssue(null,dims,{}),"no_face");
assert.equal(api.qualityIssue({...face,score:.4},dims,{}),"low_confidence");
assert.equal(api.qualityIssue({...face,box:{x:100,y:60,width:50,height:60}},dims,{}),"too_small");
assert.equal(api.qualityIssue({...face,box:{x:0,y:60,width:200,height:300}},dims,{}),"clipped");
assert.equal(api.qualityIssue(face,dims,{brightness:30,sharpness:50}),"dark");
assert.equal(api.qualityIssue(face,dims,{brightness:230,sharpness:50}),"bright");
assert.equal(api.qualityIssue(face,dims,{brightness:100,sharpness:0}),"blur");
assert.equal(api.qualityIssue({...face,pose:{yaw:0,roll:.4}},dims,{brightness:100,sharpness:50}),"pose");
const engine=api.create();assert.equal((await engine.load()).backend,"webgl");assert.deepEqual(stats.backends,["wasm","webgl"]);assert.equal(stats.loads,3);await engine.load();assert.equal(stats.loads,3,"model weights stay cached between button presses");
const steps=[];
function move(progress){if(steps.at(-1)!==progress.step)steps.push(progress.step);stats.yaw=0;}
const enrolled=await engine.enroll(new Video(),{onProgress:move});assert.equal(api.validateTemplate(enrolled),true);assert.deepEqual(steps,["loading","front"]);assert.equal(enrolled.samples.length,3);assert.equal("image" in enrolled,false);
const beforeVerify=stats.captures;
const matched=await engine.verify(new Video(),enrolled,{onProgress:move});assert.equal(matched.matched,true);assert.equal(matched.challenge,"none");assert.equal("samples" in matched,false,"verification must not expose temporary face descriptors");
assert.equal(stats.captures-beforeVerify,2,"verification uses only two automatic frontal samples without a pose challenge");
stats.sample=descriptor(.18);assert.equal((await engine.verify(new Video(),enrolled,{onProgress:move})).matched,false);stats.sample=descriptor();
await assert.rejects(engine.enroll({}),error=>error.code==="camera");
const paused=new Video();paused.paused=true;await assert.rejects(engine.enroll(paused),error=>error.code==="camera");
for(const count of [0,2]){const controller=new AbortController();stats.faceCount=count;let issue;await assert.rejects(engine.enroll(new Video(),{signal:controller.signal,onProgress(progress){if(progress.issue){issue=progress.issue;controller.abort();}}}),error=>error.name==="AbortError");assert.equal(issue,count?"multiple_faces":"no_face");}
stats.faceCount=1;
const controller=new AbortController();controller.abort();await assert.rejects(engine.verify(new Video(),enrolled,{signal:controller.signal}),error=>error.name==="AbortError");
const frozen=new Video();Object.defineProperty(frozen,"currentTime",{get:()=>1});const frozenAbort=new AbortController();setTimeout(()=>frozenAbort.abort(),20);await assert.rejects(engine.enroll(frozen,{signal:frozenAbort.signal,onProgress:move}),error=>error.name==="AbortError","one frozen frame cannot satisfy enrollment");
let concurrent;const running=engine.enroll(new Video(),{onProgress(progress){move(progress);if(progress.step==="front"&&!concurrent)concurrent=engine.enroll(new Video()).catch(error=>error.code);}});await running;assert.equal(await concurrent,"busy");
const disposal=api.create();await assert.rejects(disposal.enroll(new Video(),{onProgress(progress){if(progress.step==="front")disposal.dispose();}}),error=>error.name==="AbortError");
const fail=harness({backendError:true});await assert.rejects(fail.api.create().load(),error=>error.code==="model");
const kernelFail=harness({failedWarmupBackends:["wasm"]});assert.equal((await kernelFail.api.create().load()).backend,"webgl");assert.equal(kernelFail.stats.loads,6,"unsupported inference kernels trigger model disposal/reload on the fallback backend");

// A stalled shared download cannot trap the sequence busy lock. Cancelling one
// waiter must leave the single initialization available to other/new callers.
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
async function flush(){for(let i=0;i<12;i++)await Promise.resolve();}
const gate=deferred(),delayed=harness({initializationGate:gate.promise});
const abortedEngine=delayed.api.create(),loadingAbort=new AbortController(),loadingSteps=[];
let cancelledCompleted=false;
const abortWait=abortedEngine.enroll(new delayed.Video(),{signal:loadingAbort.signal,onProgress:value=>loadingSteps.push(value.step)})
  .then(value=>{cancelledCompleted=true;return value;});
const abortCheck=assert.rejects(abortWait,error=>error.name==="AbortError");
await flush();assert.equal(delayed.stats.loads,1);assert.equal(delayed.modelTimers.size,1);
loadingAbort.abort();await abortCheck;
assert.equal(delayed.modelTimers.size,0,"cancel cleans the 60-second timer immediately");

const timeoutEngine=delayed.api.create();
const timeoutWait=timeoutEngine.enroll(new delayed.Video());
const timeoutCheck=assert.rejects(timeoutWait,error=>error.code==="model_timeout");
await flush();assert.equal(delayed.modelTimers.size,1,"new sequence starts while the same initialization remains pending");
assert.equal(delayed.stats.loads,1,"cancelled waiter did not start another model download");
delayed.fireModelTimeouts();await timeoutCheck;
assert.equal(delayed.modelTimers.size,0);

const disposedEngine=delayed.api.create();
const disposalWait=disposedEngine.load();
const disposalCheck=assert.rejects(disposalWait,error=>error.name==="AbortError");
await flush();disposedEngine.dispose();await disposalCheck;
assert.equal(delayed.modelTimers.size,0,"dispose also cancels direct load calls");
const liveEngine=delayed.api.create(),liveWait=liveEngine.load();
gate.resolve();assert.equal((await liveWait).backend,"wasm");await flush();
assert.equal(delayed.stats.loads,3,"all callers shared one three-network initialization");
assert.equal(delayed.stats.backends.length,1);assert.equal(delayed.stats.captures,1,"late resolution runs synthetic warmup only, never a cancelled face capture");
assert.deepEqual(loadingSteps,["loading"]);assert.equal(cancelledCompleted,false);
assert.equal(delayed.modelTimers.size,0,"successful completion also clears its timeout");
const recovered=await timeoutEngine.enroll(new delayed.Video());
assert.equal(delayed.api.validateTemplate(recovered),true,"timed-out engine can retry after shared loading recovers");
await assert.rejects(disposedEngine.load(),error=>error.name==="AbortError");

const rejectGate=deferred(),lateFailure=harness({initializationGate:rejectGate.promise});
const failedEngine=lateFailure.api.create(),failedWait=failedEngine.load();
const failedCheck=assert.rejects(failedWait,error=>error.name==="AbortError");
await flush();failedEngine.dispose();await failedCheck;rejectGate.reject(new Error("late model download failure"));await flush();
assert.equal(lateFailure.modelTimers.size,0,"late initialization rejection is consumed after the caller has cancelled");
console.log("Attendance face unit tests passed: strict template/model validation, conservative 1:1 match, quality, live samples, fallback, abort, concurrency and bounded cancellable shared model loading.");
