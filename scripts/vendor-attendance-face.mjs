// Run explicitly when updating the pinned, self-hosted attendance-face runtime.
// Fetches only public package/model/license artifacts; no user data is sent.
import {createHash} from "node:crypto";
import {gunzipSync} from "node:zlib";
import {mkdir,writeFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import path from "node:path";
const target=fileURLToPath(new URL("../assets/vendor/attendance-face/",import.meta.url));
const files=[],packages=[],pending=[];
const pinnedIntegrity={
  "@vladmandic/face-api@1.7.15":"sha512-WDMmK3CfNLo8jylWqMoQgf4nIst3M0fzx1dnac96wv/dvMTN4DxC/Pq1DGtduDk1lktCamQ3MIDXFnvrdHTXDw==",
  "@tensorflow/tfjs-backend-wasm@4.22.0":"sha512-/IYhReRIp4jg/wYW0OwbbJZG8ON87mbz0PgkiP3CdcACRSvUN0h8rvC0O3YcDtkTQtFWF/tcXq/KlVDyV49wmA=="
};
const hash=(buffer,kind="sha256")=>createHash(kind).update(buffer).digest("hex");
async function get(url){const response=await fetch(url);if(!response.ok)throw new Error(`Download failed ${response.status}: ${url}`);return Buffer.from(await response.arrayBuffer());}
function untar(buffer){const contents=new Map();for(let at=0;at+512<=buffer.length;){const header=buffer.subarray(at,at+512),name=header.subarray(0,100).toString().replace(/\0.*$/s,""),prefix=header.subarray(345,500).toString().replace(/\0.*$/s,"");if(!name)break;const size=parseInt(header.subarray(124,136).toString().replace(/\0.*$/s,"").trim()||"0",8);if(!Number.isFinite(size)||size<0||at+512+size>buffer.length)throw new Error("Invalid tar entry");const type=header[156];if(type===0||type===48)contents.set(prefix?prefix+"/"+name:name,buffer.subarray(at+512,at+512+size));at+=512+Math.ceil(size/512)*512;}return contents;}
async function packageContents(name,version){const meta=JSON.parse((await get(`https://registry.npmjs.org/${name}/${version}`)).toString());if(meta.version!==version)throw new Error("Version mismatch");const expected=pinnedIntegrity[name+"@"+version];if(!expected||expected!==meta.dist.integrity)throw new Error("Published package integrity differs from reviewed pin");const tarball=await get(meta.dist.tarball),actual="sha512-"+createHash("sha512").update(tarball).digest("base64");if(actual!==expected)throw new Error("Package integrity mismatch");packages.push({name,version,tarball:meta.dist.tarball,integrity:meta.dist.integrity,gitHead:meta.gitHead||null});return {entries:untar(gunzipSync(tarball)),url:meta.dist.tarball,gitHead:meta.gitHead};}
async function save(relative,buffer,source){if(relative.includes("..")||path.isAbsolute(relative))throw new Error("Invalid target path");pending.push({relative,buffer});files.push({path:relative,bytes:buffer.length,sha256:hash(buffer),source});}
function entry(pkg,name){const value=pkg.entries.get("package/"+name);if(!value)throw new Error("Missing package file: "+name);return value;}
async function packageLicense(pkg,filename,fallback){const name=[...pkg.entries.keys()].find(value=>/^package\/licen[cs]e(?:\.txt|\.md)?$/i.test(value));if(name)await save(filename,pkg.entries.get(name),pkg.url+"#"+name);else await save(filename,await get(fallback),fallback);}
const face=await packageContents("@vladmandic/face-api","1.7.15");
await save("face-api-1.7.15.js",entry(face,"dist/face-api.js"),face.url+"#package/dist/face-api.js");
// The npm metadata omits gitHead. For a missing license file, use this reviewed
// archived 1.7.15 source commit rather than a moving branch or guessed tag.
const faceSourceCommit="189226d63aabb48cb40776fd1c453ebc0fa722f1";
packages[0].licenseSourceCommit=faceSourceCommit;
await packageLicense(face,"face-api.LICENSE.txt",`https://raw.githubusercontent.com/vladmandic/face-api/${faceSourceCommit}/LICENSE`);
for(const model of ["tiny_face_detector_model","face_landmark_68_tiny_model","face_recognition_model"]){
  const manifestName=model+"-weights_manifest.json",manifest=entry(face,"model/"+manifestName);
  await save("models/"+manifestName,manifest,face.url+"#package/model/"+manifestName);
  for(const group of JSON.parse(manifest.toString()))for(const part of group.paths){if(!/^[a-z0-9_.-]+$/i.test(part))throw new Error("Unexpected external model shard");await save("models/"+part,entry(face,"model/"+part),face.url+"#package/model/"+part);}
}
const wasm=await packageContents("@tensorflow/tfjs-backend-wasm","4.22.0");
for(const file of ["tfjs-backend-wasm.wasm","tfjs-backend-wasm-simd.wasm","tfjs-backend-wasm-threaded-simd.wasm"])await save("wasm/"+file,entry(wasm,"dist/"+file),wasm.url+"#package/dist/"+file);
await packageLicense(wasm,"tensorflow.LICENSE.txt","https://raw.githubusercontent.com/tensorflow/tfjs/tfjs-v4.22.0/LICENSE");
const original="https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/LICENSE";
await save("original-face-api.LICENSE.txt",await get(original),original);
const dlibSource="https://raw.githubusercontent.com/davisking/dlib-models/master/README.md",dlib=await get(dlibSource);
const dlibStatement=dlib.toString().split(/\r?\n/).filter(line=>line.includes("public domain"));
if(dlibStatement.length!==1)throw new Error("Dlib model license statement changed; review it before vendoring.");
await save("dlib-models.LICENSE.txt",Buffer.from("Davis King / dlib face recognition model\nSource: "+dlibSource+"\nSource SHA-256: "+hash(dlib)+"\n\n"+dlibStatement[0]+"\n"),dlibSource);
// Validate/download everything before modifying the vendored directory.
for(const {relative,buffer} of pending){const output=path.join(target,relative);await mkdir(path.dirname(output),{recursive:true});await writeFile(output,buffer);}
await writeFile(path.join(target,"manifest.json"),JSON.stringify({format:"DGV_ATTENDANCE_FACE_VENDOR",version:1,model:"dlib-resnet128-faceapi-1.7.15-tiny68-v1",packages,files},null,2)+"\n");
console.log(JSON.stringify({directory:target,files:files.length,totalBytes:files.reduce((sum,file)=>sum+file.bytes,0),packages:packages.map(({name,version})=>({name,version}))}));
