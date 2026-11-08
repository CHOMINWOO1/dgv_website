// Offline UI test. All hotel/auth/export calls are local fixtures.
import assert from 'node:assert/strict';import fs from 'node:fs/promises';import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE||'C:/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'});let n=0;
const check=(ok,label)=>{assert.ok(ok,label);n++;console.log('PASS',label);};
try{
 const context=await browser.newContext({viewport:{width:1280,height:1000}});await context.addInitScript(()=>{window.print=()=>{window.__printed=true;};});
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 const html=(await fs.readFile('hotel_reserv_list.html','utf8')).replace(/<script\b[\s\S]*?<\/script>/g,'');const css=await fs.readFile('assets/qr-staff.css','utf8');
 await context.route('**/*',r=>r.fulfill({status:200,contentType:r.request().url().endsWith('.css')?'text/css':'text/html',body:r.request().url().endsWith('.css')?css:html}));await page.goto('https://hotel-fixture.test/');
 for(const file of ['assets/hotel-pricing.js','assets/hotel-report.js'])await page.addScriptTag({content:await fs.readFile(file,'utf8')});
 await page.evaluate(()=>{
  const hotel={id:'h',name:'Test Hotel',version:1,weekend_days:[0,6],extra_bed_purchase:0,extra_bed_sale:0};
  const grade={id:'g',hotel_id:'h',name:'Deluxe',version:1};
  const types=['DOUBLE','TWIN','TRIPLE'].map((room_kind,i)=>({id:'type'+i,hotel_id:'h',grade_id:'g',grade_name:'Deluxe',room_kind,name:room_kind,version:2,is_active:true,weekday_purchase:1000000,weekday_sale:1500000,weekend_purchase:1000000,weekend_sale:1500000}));
  window.fixture={hotels:[hotel],grades:[grade],types,rows:[],writes:[],excel:[]};
  window.QRStaff={requireLogin:async()=>{},toast:()=>{}};window.DGV_XLSX={downloadWorkbook:data=>fixture.excel.push(data)};
  const getter=name=>({name,data:null,conditions:{},select(){return this;},eq(k,v){this.conditions[k]=v;return this;},update(data){this.data=data;return this;},insert(data){this.data=data;return this;},async single(){
   const collection=name==='hotel_properties'?fixture.hotels:fixture.rows;const old=collection.find(x=>x.id===this.conditions.id);
   if(this.conditions.version!==undefined&&old?.version!==this.conditions.version)return{error:{code:'PGRST116',message:'Version conflict'}};
   let saved={...old,...this.data,id:old?.id||this.data.id,version:(old?.version||0)+1};
   if(name==='hotel_reservations'){
    const hotel=fixture.hotels.find(h=>h.id===saved.hotel_id),result=HotelPricing.price(saved,hotel,old,fixture.types);
    saved={...saved,hotel_name:hotel.name,room_items:result.items,room_count:result.roomCount,rate_snapshot:result.rates,weekday_nights:result.weekday,weekend_nights:result.weekend,
     room_purchase_amount:result.roomPurchase,room_sale_amount:result.roomSale,extra_bed_rate_snapshot:result.extraBedRates,extra_bed_hotel_version:result.extraBedVersion,extra_bed_purchase_amount:result.extraBedPurchase,extra_bed_sale_amount:result.extraBedSale,purchase_amount:result.purchase,sale_amount:result.sale};
   }
   const index=collection.findIndex(x=>x.id===saved.id);if(index<0)collection.push(saved);else collection[index]=saved;
   fixture.writes.push({name,data:structuredClone(this.data)});return{data:structuredClone(saved),error:null};
  }});
  window.DGV={supabase:{from:getter,rpc:async()=>({data:{},error:null})},collectSupabasePages:async get=>{const name=get().name;return structuredClone(name==='hotel_properties'?fixture.hotels:name==='hotel_room_grades'?fixture.grades:name==='hotel_room_types'?fixture.types:fixture.rows);}};
 });
 await page.addScriptTag({content:await fs.readFile('assets/hotel-reserv-list.js','utf8')});await page.locator('#propertyRows button').first().waitFor();await page.locator('#propertyRows button').first().click();
 check((await page.locator('#roomTypeDialog').innerText()).includes('트윈 / Hai giường đơn'),'new room-kind labels use Double/Twin/Triple in Korean and Vietnamese');
 check(await page.locator('[data-room-kind=SINGLE]').count()===0,'deprecated SINGLE editor is not offered');
 await page.locator('#extraBedForm [name=extra_bed_purchase]').fill('100000');await page.locator('#extraBedForm [name=extra_bed_sale]').fill('150000');
 check(await page.locator('#extraBedForm [name=extra_bed_sale]').inputValue()==='150,000','bed rate formats commas while typing');
 await page.locator('#extraBedForm button[type=submit]').click();await page.waitForFunction(()=>fixture.writes.length===1);
 check(await page.evaluate(()=>Object.keys(fixture.writes[0].data).sort().join(',')==='extra_bed_purchase,extra_bed_sale'&&fixture.writes[0].data.extra_bed_sale===150000),'bed settings save numeric prices only, without overwriting hotel room rates');
 await page.evaluate(()=>{fixture.hotels[0].version++;});await page.locator('#extraBedForm [name=extra_bed_sale]').fill('200000');await page.locator('#extraBedForm button[type=submit]').click();await page.locator('#extraBedError').waitFor();
 check((await page.locator('#extraBedError').innerText()).includes('다른 곳'),'stale bed-price edit is rejected instead of overwriting another update');
 await page.locator('[data-close=roomTypeDialog]:visible').click();await page.locator('#reloadButton').click();await page.locator('#addButton').click();
 await page.locator('#hotelSelect').selectOption('h');await page.locator('#hotelForm [name=check_in]').fill('2026-11-06');await page.locator('#hotelForm [name=check_out]').fill('2026-11-09');
 await page.locator('#roomItemRows select').nth(0).selectOption('g');await page.locator('#roomItemRows select').nth(1).selectOption('type0');
 await page.locator('#hotelForm [name=guest_names]').fill('Test A; Test B');await page.locator('#hotelForm [name=extra_bed_count]').fill('2');
 check((await page.locator('#pricePreview').innerText()).includes('5,400,000'),'two beds × three nights are added automatically to room sales');
 await page.locator('#hotelForm [name=extra_bed_count]').fill('1.5');check(!await page.locator('#hotelForm [name=extra_bed_count]').evaluate(e=>e.checkValidity()),'fractional bed quantities are not accepted');await page.locator('#hotelForm [name=extra_bed_count]').fill('2');
 await page.locator('#saveButton').click();await page.waitForFunction(()=>fixture.rows.length===1);
 check(await page.evaluate(()=>{const p=fixture.writes.find(w=>w.name==='hotel_reservations').data;return p.extra_bed_count===2&&p.extra_bed_hotel_version===3&&!('extra_bed_sale_amount'in p);}), 'booking sends quantity and quote version, not trusted computed totals');
 await page.locator('#hotelRows tr[data-reservation-id]').click();
 check((await page.locator('#hotelDetailContent').innerText()).includes('900,000'),'booking detail shows the separate saved bed charge');await page.locator('[data-close=hotelDetailDialog]').click();
 await page.evaluate(()=>{fixture.hotels[0].extra_bed_sale=500000;fixture.hotels[0].version++;});await page.locator('#reloadButton').click();await page.locator('#hotelRows tr[data-reservation-id]').click();await page.locator('#editHotelDetailButton').click();
 check((await page.locator('#pricePreview').innerText()).includes('5,400,000'),'reopening after a bed-price change preserves the saved booking amount');
 await page.locator('#hotelForm [name=extra_bed_count]').fill('3');check((await page.locator('#pricePreview').innerText()).includes('5,850,000'),'quantity edit uses the booking’s saved per-night bed price');
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:'tmp/hotel-extra-bed-mobile.png'});
 check(await page.locator('#hotelDialog').evaluate(e=>e.scrollWidth<=e.clientWidth+1),'mobile booking editor has no horizontal overflow');await page.locator('#saveButton').click();await page.waitForFunction(()=>fixture.rows[0].extra_bed_count===3);
 await page.locator('#excelHotelListButton').click();await page.waitForFunction(()=>fixture.excel.length===1);
 check(await page.evaluate(()=>fixture.excel[0].sheets[0].rows[4][28].value===1350000),'Excel includes the saved bed amount for the selected list');
 const popupEvent=context.waitForEvent('page');await page.locator('#printHotelListButton').click();const popup=await popupEvent;await popup.waitForFunction(()=>window.__printed===true);
 check((await popup.locator('body').innerText()).includes('1,350,000'),'print output includes saved bed quantity/rate and amount');
 check(errors.length===0,'no browser exceptions: '+errors.join('; '));console.log(`Hotel extra-bed browser: ${n} checks passed (all API traffic mocked).`);
}finally{await browser.close();}

