import {installAttendanceMock} from './helpers/attendance-browser-mock.mjs';
import {installTouchBoundary} from './helpers/attendance-touch-browser-mock.mjs';
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

// Exercise the real page and encrypted device store against an isolated fixture.
// Every app resource is fulfilled from this checkout; no production requests.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.join(root,'test-results','attendance-touch-layout');
const origin='https://attendance-touch-layout.test';
const employeeId='00000000-0000-4000-8000-000000000001';
const browser=await chromium.launch({headless:true,channel:process.env.PAYROLL_BROWSER_CHANNEL||'chrome'});
const context=await browser.newContext({viewport:{width:800,height:1280},isMobile:true,hasTouch:true,timezoneId:'Asia/Seoul'});
const page=await context.newPage(),errors=[],failures=[],results=[];
page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));
await context.addInitScript(()=>{
  const original=setInterval;
  window.setInterval=(fn,ms,...args)=>{if(ms===1000)window.__touchExpiryTick=()=>fn(...args);return ms===30000?0:original(fn,ms,...args);};
});
await context.route('**/*',async route=>{
  const url=route.request().url();
  if(url.startsWith('https://cdn.jsdelivr.net/npm/@supabase/'))return route.fulfill({contentType:'text/javascript',body:`(${installAttendanceMock.toString()})(null);(${installTouchBoundary.toString()})(null);`});
  if(!url.startsWith(origin))return route.fulfill({body:'/* isolated layout test */'});
  const file=path.resolve(root,new URL(url).pathname.slice(1));
  if(!file.startsWith(root+path.sep))return route.fulfill({status:403,body:''});
  try{return route.fulfill({contentType:({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'})[path.extname(file)]||'application/octet-stream',body:await readFile(file)});}catch{return route.fulfill({status:404,body:''});}
});
const idle=()=>page.waitForFunction(()=>!document.getElementById('closeAdmin').disabled);
const type=async code=>{for(const digit of code)await page.locator(`[data-digit="${digit}"]`).tap();};
const mainSelectors=['#employee','#clockIn','#clockOut'];
const modalSelectors=['#challengeCode','#touchDigits','#touchCancel',...Array.from({length:10},(_,n)=>`[data-digit="${n}"]`),'#touchClear','#touchBackspace','#touchConfirm'];

async function check(view,state,selectors,{dialog=false,landscape=true}={}){
  await page.evaluate(inDialog=>{window.scrollTo(0,0);if(inDialog)document.getElementById('touchDialog').scrollTop=0;},dialog);
  const metrics=await page.evaluate(({selectors,dialog})=>{
    const viewport={width:innerWidth,height:innerHeight};
    const measure=selector=>{
      const element=document.querySelector(selector);if(!element)return {selector,missing:true};
      const rect=element.getBoundingClientRect(),style=getComputedStyle(element);
      const visible=rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility!=='hidden';
      let clipped=false;
      for(let ancestor=element.parentElement;ancestor;ancestor=ancestor.parentElement){
        const css=getComputedStyle(ancestor),box=ancestor.getBoundingClientRect();
        if(['hidden','clip','auto','scroll'].includes(css.overflowY)&&(rect.top<box.top-1||rect.bottom>box.bottom+1))clipped=true;
        if(['hidden','clip','auto','scroll'].includes(css.overflowX)&&(rect.left<box.left-1||rect.right>box.right+1))clipped=true;
      }
      return {selector,visible,clipped,x:rect.x,y:rect.y,width:rect.width,height:rect.height,bottom:rect.bottom,right:rect.right,touchTarget:element.matches('button,select,a')};
    };
    const modal=document.getElementById('touchDialog');
    return {viewport,pageWidth:document.documentElement.scrollWidth,pageHeight:document.documentElement.scrollHeight,
      dialogScroll:dialog?modal.scrollHeight-modal.clientHeight:0,elements:selectors.map(measure)};
  },{selectors,dialog});
  const add=message=>failures.push({view,state,message});
  if(metrics.pageWidth>metrics.viewport.width+1)add(`page horizontal overflow ${metrics.pageWidth}`);
  if(landscape&&!dialog&&metrics.pageHeight>metrics.viewport.height+1)add(`page vertical scroll ${metrics.pageHeight} > ${metrics.viewport.height}`);
  if(landscape&&dialog&&metrics.dialogScroll>1)add(`dialog needs ${metrics.dialogScroll}px vertical scroll`);
  for(const item of metrics.elements){
    if(item.missing||!item.visible){add(`${item.selector} hidden or absent`);continue;}
    if(item.touchTarget&&(item.width<43.9||item.height<43.9))add(`${item.selector} touch target ${item.width.toFixed(1)}x${item.height.toFixed(1)}`);
    const fullyVisible=!item.clipped&&item.x>=-1&&item.y>=-1&&item.right<=metrics.viewport.width+1&&item.bottom<=metrics.viewport.height+1;
    if(landscape&&!fullyVisible)add(`${item.selector} clipped/outside viewport, y=${item.y.toFixed(1)} bottom=${item.bottom.toFixed(1)}`);
    if(!landscape&&!fullyVisible){
      await page.locator(item.selector).scrollIntoViewIfNeeded();
      const box=await page.locator(item.selector).boundingBox();
      if(!box||box.y<0||box.y+box.height>metrics.viewport.height+1)add(`${item.selector} not reachable through portrait scrolling`);
    }
  }
  await page.evaluate(inDialog=>{window.scrollTo(0,0);if(inDialog)document.getElementById('touchDialog').scrollTop=0;},dialog);
  await page.screenshot({path:path.join(output,`${view}-${state}.png`),fullPage:false});
  results.push({view,state,pageHeight:metrics.pageHeight,dialogScroll:metrics.dialogScroll});
}
async function refresh(){await page.locator('#refreshRoster').click();await idle();await page.locator('#employee').selectOption(employeeId);}
async function begin(){await page.locator('#clockIn').click();await page.locator('#touchDialog').waitFor({state:'visible'});await idle();return (await page.locator('#challengeCode').innerText()).trim();}
async function cancel(){await page.locator('#touchCancel').click();await page.locator('#touchDialog').waitFor({state:'hidden'});await idle();}

try{
  await mkdir(output,{recursive:true});await page.goto(origin+'/attendance-touch.html');await page.locator('#setup').waitFor({state:'visible'});
  await page.locator('#setupButton').click();await page.locator('#adminPassword').fill('admin-test');await page.locator('#adminLogin button').click();await idle();
  await page.locator('#deviceName').fill('DEMO · Galaxy Tab A');await page.locator('#registerDevice button').click();await idle();await page.locator('#closeAdmin').click();
  await page.locator('#adminDialog').waitFor({state:'hidden'});await page.locator('#employee').selectOption(employeeId);
  const viewports=[[1280,640],[1024,550],[960,480],[800,480],[960,420],[800,400],[800,1280],[390,844]];
  for(const [width,height] of viewports){
    const view=`${width}x${height}`,landscape=width>height;
    await page.setViewportSize({width,height});
    await page.evaluate(()=>{__attendanceTest.events=[];});await refresh();
    await check(view,'main',mainSelectors,{landscape});
    // The real prior-day missing-checkout warning is longer than idle guidance.
    await page.evaluate(id=>{__attendanceTest.events=[{event_id:'synthetic-yesterday',employee_id:id,punch_type:'in',occurred_at:'2026-10-30T10:00:00',source:'kiosk'}];},employeeId);await refresh();
    assert.match(await page.locator('#employeeAvailability').innerText(),/오늘 새로 출근/);
    await check(view,'prior-day-warning',[...mainSelectors,'#employeeAvailability','#employeeState'],{landscape});
    let code=await begin();assert.match(code,/^\d{4}$/);
    await check(view,'keypad',modalSelectors,{dialog:true,landscape});
    await type(code==='0000'?'1111':'0000');await page.locator('#touchConfirm').click();await idle();await page.locator('#touchNotice').waitFor({state:'visible'});
    await check(view,'wrong-code',[...modalSelectors,'#touchNotice'],{dialog:true,landscape});
    // Expiry is based on elapsed monotonic time, not the tablet's wall clock.
    await page.evaluate(()=>{const original=performance.now.bind(performance);window.__layoutPerformanceNow=original;Object.defineProperty(performance,'now',{configurable:true,value:()=>original()+121000});__touchExpiryTick();});
    await page.locator('#touchRenew').waitFor({state:'visible'});
    await check(view,'expired',[...modalSelectors,'#touchRenew'],{dialog:true,landscape});
    await page.locator('#touchRenew').click();await idle();assert.equal(await page.locator('#touchRenew').isVisible(),false);
    await page.evaluate(()=>Object.defineProperty(performance,'now',{configurable:true,value:window.__layoutPerformanceNow}));await cancel();
    code=await begin();await page.evaluate(()=>{__touchTest.loseConfirmBeforeCommit=true;});await type(code);await page.locator('#touchConfirm').click();await idle();await page.locator('#pending').waitFor({state:'visible'});
    assert.equal(await page.locator('#touchDialog').isVisible(),false);
    await check(view,'pending-recovery',['#notice','#pendingText','#checkReceipt'],{landscape});
    await page.locator('#checkReceipt').click();await idle();await page.locator('#pending').waitFor({state:'hidden'});
    assert.equal(await page.evaluate(()=>__attendanceTest.events.length),1,'uncertain fixture confirmation never invents an attendance event');
    code=await begin();await type(code);await page.locator('#touchConfirm').click();await idle();await page.locator('#touchDialog').waitFor({state:'hidden'});
    assert.match(await page.locator('#notice').innerText(),/급여 페이지에 반영/);
    await check(view,'saved',[...mainSelectors,'#notice','#employeeAvailability'],{landscape});
  }
  assert.equal(await page.evaluate(()=>__touchTest.cameraRequests),0);assert.deepEqual(errors,[]);
  await writeFile(path.join(output,'layout-results.json'),JSON.stringify({results,failures},null,2));
  if(failures.length)console.log(JSON.stringify({failures},null,2));
  assert.equal(failures.length,0,'every landscape control must fit without scrolling or clipping; portrait fallbacks remain reachable');
  console.log(JSON.stringify({result:'passed',viewports:viewports.length,states:results.length,minimumTouchTarget:44,landscapeNoScroll:true,syntheticOnly:true,output}));
}finally{await context.close();await browser.close();}
