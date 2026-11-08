// Public pages only. No consent/login/mutations; all Supabase and YouTube browser requests blocked.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL('C:/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'));
let checks=0;const check=(v,m)=>{assert.ok(v,m);checks++;console.log('PASS',m);};
const origin='https://dalatgolfvoucher.com';
const normalize=s=>s.replace(/\r\n/g,'\n').trimEnd();
const paths=['tv.html','hana_karaoke_tv.html','hana_karaoke.html','hotel_reserv_list.html','assets/hotel-reserv-list.js','assets/hotel-report.js','assets/hana-karaoke.js','assets/hana-karaoke-tv.js','assets/hana-karaoke.css','assets/hana-karaoke-tv.css'];
for(const path of paths){const r=await fetch(origin+'/'+path+'?verify=20261108-final');check(r.ok&&normalize(await r.text())===normalize(await fs.readFile(path,'utf8')),'deployed source matches '+path);}
const response=await fetch(origin+'/tv?verify=20261108-final');check(response.ok&&(await response.text()).includes('HANA Karaoke TV'),'short /tv route serves the TV receiver');
const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
try{
 const context=await browser.newContext({viewport:{width:390,height:844}}), blocked=[],errors=[];
 await context.route(/https:\/\/(?:[^/]*supabase\.co|[^/]*youtube\.com|[^/]*ytimg\.com)\//,r=>{blocked.push(r.request().url());return r.fulfill({status:403,body:'blocked by read-only smoke test'});});
 const tv=await context.newPage();tv.on('pageerror',e=>errors.push(e.message));await tv.goto(origin+'/tv');
 await tv.locator('#create').waitFor();check(await tv.locator('#searchMode').inputValue()==='catalog','live /tv defaults to the shared catalogue');
 check(await tv.locator('#create').isDisabled()&&blocked.length===0,'no live karaoke API/YouTube calls before consent');
 const hotel=await context.newPage();hotel.on('pageerror',e=>errors.push(e.message));await hotel.goto(origin+'/hotel_reserv_list');
 await hotel.waitForFunction(()=>window.HotelReport&&document.querySelector('[name=balance_amount]').type==='text');
 check(await hotel.locator('#hotelStatus').inputValue()==='in_progress','live hotel list defaults to in-progress');
 const formatted=await hotel.evaluate(()=>{const el=document.querySelector('[name=balance_amount]');el.value='4500000';el.dispatchEvent(new Event('input',{bubbles:true}));return el.value;});
 check(formatted==='4,500,000','live hotel input immediately formats commas without saving');
 check(await hotel.locator('[name=booking_reference]').count()===1,'live hotel editor has a separate booking reference');
 check(await hotel.evaluate(()=>HotelReport.status({sale_amount:100,deposit_amount:30,balance_amount:70})==='completed'&&HotelReport.status({sale_amount:100,deposit_amount:30,balance_amount:60})==='in_progress'),'live hotel completion is calculated from actual received amounts');
 check(errors.length===0,'public pages load without JavaScript exceptions: '+errors.join('; '));
}finally{await browser.close();}
// Invalid invitation smoke: validates deployment/auth routing without creating a live room or spending Google quota.
const configContext={window:{}};vm.runInNewContext(await fs.readFile('assets/supabase-config.js','utf8'),configContext);
const config=configContext.window.DGV_SUPABASE_CONFIG;
const denied=await fetch(config.url+'/functions/v1/hana-karaoke',{method:'POST',headers:{apikey:config.publishableKey,'content-type':'application/json',origin},body:JSON.stringify({action:'library',requestId:randomUUID(),room:'111111',token:'0'.repeat(64),query:'test',category:'all'})});
check(denied.status===404&&(await denied.json()).code==='ROOM_NOT_FOUND','live catalogue requires a valid room capability and returns no songs to an invalid invitation');
console.log(`Read-only deployed smoke: ${checks} checks; no consent, login or reservation writes.`);

