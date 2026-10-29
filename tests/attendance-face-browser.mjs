import assert from "node:assert/strict";
import {createServer} from "node:http";
import {readFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {chromium} from "playwright";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),".."),vendor=path.join(root,"assets/vendor/attendance-face");
const manifest=JSON.parse(await readFile(path.join(vendor,"manifest.json"),"utf8"));
for(const item of manifest.files){assert.equal(item.path.includes(".."),false);const bytes=await readFile(path.join(vendor,item.path));assert.equal(bytes.length,item.bytes,item.path);assert.equal(createHash("sha256").update(bytes).digest("hex"),item.sha256,item.path);}
assert.deepEqual(manifest.packages.map(pkg=>[pkg.name,pkg.version]),[["@vladmandic/face-api","1.7.15"],["@tensorflow/tfjs-backend-wasm","4.22.0"]]);
const mime={".js":"text/javascript",".json":"application/json",".wasm":"application/wasm"};
const server=createServer(async(req,res)=>{try{if(req.url==="/"){res.writeHead(200,{"Content-Type":"text/html","Content-Security-Policy":"default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; media-src blob:;"});res.end('<!doctype html><meta charset="utf-8"><script src="/assets/attendance-face.js"></script>');return;}const file=path.resolve(root,new URL(req.url,"http://localhost").pathname.replace(/^\//,""));if(!file.startsWith(root+path.sep))throw new Error("path");res.writeHead(200,{"Content-Type":mime[path.extname(file)]||"application/octet-stream"});res.end(await readFile(file));}catch{res.writeHead(404);res.end();}});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,channel:process.env.PAYROLL_BROWSER_CHANNEL||"chrome"}),external=[];
try{
  const context=await browser.newContext();await context.route("**/*",route=>{if(!route.request().url().startsWith(origin)){external.push(route.request().url());return route.abort();}return route.continue();});
  const page=await context.newPage(),errors=[];page.on("pageerror",error=>errors.push(error.message));await page.goto(origin);
  const initialized=await page.evaluate(async()=>{const started=performance.now();window.faceEngine=DGV_ATTENDANCE_FACE.create();const status=await faceEngine.load();return {...status,ms:Math.round(performance.now()-started),version:faceapi.tf.version.tfjs,tensors:faceapi.tf.memory().numTensors};});
  assert.equal(initialized.backend,"wasm");assert.equal(initialized.version,"4.22.0");assert.equal(initialized.model,manifest.model);
  // No photographs or human face fixtures are used. Load/warmup runs on zeros;
  // the actual detector rejects a live stream of synthetic checkerboard pixels.
  const rejected=await page.evaluate(async()=>{const canvas=document.createElement("canvas");canvas.width=640;canvas.height=480;const ctx=canvas.getContext("2d");for(let y=0;y<480;y+=20)for(let x=0;x<640;x+=20){ctx.fillStyle=((x+y)/20)%2?"#999":"#555";ctx.fillRect(x,y,20,20);}const video=document.createElement("video");video.muted=true;video.srcObject=canvas.captureStream(10);await video.play();const timer=setInterval(()=>ctx.fillRect(0,0,1,1),100),controller=new AbortController();let issue;try{await faceEngine.enroll(video,{signal:controller.signal,onProgress(progress){if(progress.issue){issue=progress.issue;controller.abort();}}});return {accepted:true};}catch(error){return {accepted:false,issue,code:error.name};}finally{clearInterval(timer);video.srcObject.getTracks().forEach(track=>track.stop());video.srcObject=null;canvas.width=0;}});
  assert.equal(rejected.accepted,false);assert.equal(rejected.issue,"no_face");assert.equal(rejected.code,"AbortError");
  const replay=await page.evaluate(async()=>{const count=faceapi.tf.memory().numTensors;for(let i=0;i<3;i++)await faceEngine.load();return {count,after:faceapi.tf.memory().numTensors};});assert.equal(replay.count,replay.after,"repeated button initialization must reuse model tensors");
  assert.deepEqual(errors,[]);await context.close();
  const fallback=await browser.newContext();await fallback.route("**/*",route=>{const url=route.request().url();if(!url.startsWith(origin)){external.push(url);return route.abort();}if(url.endsWith(".wasm"))return route.fulfill({status:404,body:"Synthetic unavailable WASM"});return route.continue();});const fallbackPage=await fallback.newPage();await fallbackPage.goto(origin);
  const fallbackResult=await fallbackPage.evaluate(async()=>DGV_ATTENDANCE_FACE.create().load());assert.ok(["webgl","cpu"].includes(fallbackResult.backend));await fallback.close();
  assert.deepEqual(external,[],"model inference/assets must remain entirely same-origin");
  console.log(`Attendance real-model browser passed: ${manifest.files.length} pinned file hashes, TFJS ${initialized.version} WASM init/warmup ${initialized.ms}ms on this desktop, synthetic live-frame rejection, cached tensors, ${fallbackResult.backend} fallback, no remote requests. SM-T515 performance requires on-device check.`);
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
