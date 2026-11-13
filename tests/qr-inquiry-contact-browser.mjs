// Fully isolated UI test: every QR API request is mocked; never writes hosted data.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const modulePath=process.env.PLAYWRIGHT_MODULE||'C:/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const {chromium}=await import(pathToFileURL(modulePath).href);
const payload={ok:true,table:{id:'test-table',label:'102'},current_total_vnd:120000,current_total_usd:5,
 items:[{id:'test-item',ko_name:'짜파게티',en_name:'Black Bean Noodles',vi_name:'Mì tương đen',category_id:'single',price_vnd:120000,price_usd:5,is_active:true,is_orderable:true}],
 current_orders:[{order_number:'TEST-001',status:'submitted',total_vnd:120000,total_usd:5,submitted_at:'2026-11-13T06:22:00Z',items:[{ko_name:'짜파게티',en_name:'Black Bean Noodles',vi_name:'Mì tương đen',qty:1,unit_vnd:120000,line_vnd:120000,unit_usd:5,line_usd:5}]}]};
const allowed=new Set(['/menu.html','/assets/qr-menu.js','/assets/qr-menu.css','/image/logo.png']);
const server=createServer(async(req,res)=>{
 const pathname=new URL(req.url,'http://localhost').pathname;
 if(pathname==='/assets/supabase-config.js'){res.setHeader('content-type','text/javascript');res.end('window.DGV_SUPABASE_CONFIG={url:"https://qr-inquiry-test.supabase.co",publishableKey:"test-only"};');return;}
 if(!allowed.has(pathname)){res.writeHead(404);res.end();return;}
 try{res.setHeader('content-type',pathname.endsWith('.js')?'text/javascript':pathname.endsWith('.css')?'text/css':pathname.endsWith('.png')?'image/png':'text/html');res.end(await readFile(path.join(root,pathname)));}catch{res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`,calls=[],errors=[];
let browser,checks=0;
const check=(condition,message)=>{assert.ok(condition,message);checks++;console.log('PASS',message);};
try{
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 const context=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'});
 await context.route('**/*',async route=>{
  if(route.request().url().startsWith(origin+'/'))return route.continue();
  if(route.request().url()==='https://qr-inquiry-test.supabase.co/functions/v1/qr-menu'){
   const body=route.request().postDataJSON();calls.push(body);
   const response=body.action==='submit_order'?{ok:true,order:{id:'test-order',order_number:'TEST-002',total_vnd:120000}}:payload;
   return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(response)});
  }
  return route.abort();
 });
 const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
 await page.goto(origin+'/menu.html#t=test-token');await page.locator('#menuApp:not([hidden])').waitFor();
 check(await page.locator('.inquiry-contact').count()===3,'exactly three inquiry notices are present');
 check(await page.locator('a[href^="tel:"]').count()===0,'internal extension is not misrepresented as a mobile telephone link');
 const languages={ko:['문의 전화:','호텔 내선번호'],en:['For inquiries:','Hotel extension'],vi:['Liên hệ:','Số nội bộ khách sạn']};
 for(const width of [320,390,768]){
  await page.setViewportSize({width,height:844});
  for(const [language,[label,extension]] of Object.entries(languages)){
   await page.locator(`[data-language="${language}"]`).click();
   check(await page.locator('[data-copy=inquiryLabel]').evaluateAll((nodes,text)=>nodes.every(node=>node.textContent===text),label),`${width}px ${language}: all three inquiry labels translate`);
   check(await page.locator('[data-copy=hotelExtension]').evaluateAll((nodes,text)=>nodes.every(node=>node.textContent===text),extension),`${width}px ${language}: all three extension labels translate`);
   check(await page.locator('.inquiry-contact strong').evaluateAll(nodes=>nodes.every(node=>node.textContent==='1188')),`${width}px ${language}: extension stays 1188`);
   check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${width}px ${language}: menu has no horizontal overflow`);
   await page.locator('.menu-card').first().click();await page.locator('#detailAdd').click();await page.locator('#cartButton').click();
   await page.locator('#cartSheet').evaluate(async node=>{await Promise.all(node.getAnimations().map(animation=>animation.finished.catch(()=>{})));});
   check(await page.locator('#cartSheet .inquiry-contact').isVisible(),`${width}px ${language}: cart header notice stays visible`);
   check(await page.locator('.inquiry-contact:visible').evaluateAll(nodes=>nodes.every(node=>{const r=node.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;})),`${width}px ${language}: notices remain inside the screen`);
   const checkout=await page.locator('#reviewButton').evaluate(node=>{const r=node.getBoundingClientRect();return{top:r.top,bottom:r.bottom,height:innerHeight};});
   if(checkout.top<0||checkout.bottom>checkout.height+1){await mkdir(path.join(root,'tmp'),{recursive:true});await page.screenshot({path:path.join(root,'tmp/qr-inquiry-layout-failure.png')});}
   check(checkout.top>=0&&checkout.bottom<=checkout.height+1,`${width}px ${language}: fixed checkout button stays visible ${JSON.stringify(checkout)}`);
   if(width===390&&language==='ko'){await mkdir(path.join(root,'tmp'),{recursive:true});await page.screenshot({path:path.join(root,'tmp/qr-inquiry-cart.png')});}
   await page.locator('#cartClose').click();
   // Reset the local cart, not a server order, between layout cases.
   await page.locator('#cartButton').click();await page.locator('.remove-line').click();await page.locator('#cartClose').click();
  }
 }
 await page.setViewportSize({width:390,height:844});await page.locator('[data-language=ko]').click();
 await page.locator('#menuSearch').fill('없는 메뉴');check(await page.locator('.menu-empty-results').count()===1,'search behavior still works');await page.locator('#menuSearchClear').click();
 await page.locator('.menu-card').first().click();await page.locator('#detailAdd').click();await page.locator('#cartButton').click();await page.locator('#reviewButton').click();await page.locator('#submitOrder').click();await page.locator('#successBackdrop:not([hidden])').waitFor();
 const submitted=calls.filter(body=>body.action==='submit_order');check(submitted.length===1&&submitted[0].items[0].qty===1&&submitted[0].items[0].menu_item_id==='test-item','existing review/submit flow keeps the original item payload');
 check(!JSON.stringify(submitted[0]).includes('1188'),'inquiry copy is never added to order data');
 await page.locator('#newOrderButton').click();await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:path.join(root,'tmp/qr-inquiry-menu.png')});
 check(errors.length===0,'no JavaScript exceptions: '+errors.join('; '));
 console.log(`QR inquiry contact: ${checks} browser checks passed; all API traffic mocked.`);
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
