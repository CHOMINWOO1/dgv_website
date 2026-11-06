import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const ctx={};
vm.runInNewContext(await readFile(new URL('../assets/hotel-pricing.js',import.meta.url),'utf8'),ctx);
const p=ctx.HotelPricing;
const hotel={id:'h',version:1,weekend_days:[5,6]};
const types=[{id:'t',hotel_id:'h',name:'Twin',version:1,is_active:true,weekday_purchase:100,weekday_sale:150,weekend_purchase:200,weekend_sale:300},
 {id:'s',hotel_id:'h',name:'Suite',version:1,is_active:true,weekday_purchase:300,weekday_sale:500,weekend_purchase:400,weekend_sale:600}];
const data={hotel_id:'h',check_in:'2026-11-05',check_out:'2026-11-09',room_count:3,pricing_mode:'standard',
 room_items:[{room_type_id:'t',room_count:2,room_grade:'STANDARD',room_type_version:1},{room_type_id:'s',room_count:1,room_grade:'VIP',room_type_version:1}],
 includes_meals:true,meal_purchase_amount:80,meal_sale_amount:120};
const original=JSON.stringify(data);
const result=p.price(data,hotel,null,types);
assert.equal(result.roomPurchase,2600);assert.equal(result.roomSale,4000);
assert.equal(result.purchase,2680);assert.equal(result.sale,4120);assert.equal(result.roomCount,3);
assert.equal(result.items[1].room_grade,'VIP');assert.equal(JSON.stringify(data),original);
const prev={...data,room_items:result.items,rate_snapshot:result.rates,room_purchase_amount:result.roomPurchase,room_sale_amount:result.roomSale};
const changed=types.map(t=>({...t,weekday_purchase:9999,weekday_sale:9999,version:2,is_active:false}));
assert.equal(p.price({...data,note:'changed',deposit_amount:123},hotel,prev,changed).sale,4120);
assert.equal(p.price({...data,room_items:[data.room_items[1],data.room_items[0]]},hotel,prev,changed).sale,4120);
assert.throws(()=>p.price({...data,check_out:'2026-11-10'},hotel,prev,changed));
assert.throws(()=>p.price({...data,room_items:[]},hotel,null,types));
assert.throws(()=>p.price({...data,room_items:[{...data.room_items[0],room_count:1.2}]},hotel,null,types));
assert.throws(()=>p.price({...data,room_items:[{...data.room_items[0],room_grade:'GOLD'}]},hotel,null,types));
assert.throws(()=>p.price(data,hotel,null,types.map(t=>({...t,hotel_id:'other'}))));
assert.throws(()=>p.stay('2026-02-30','2026-03-04',[]));
const surcharge=p.price({...data,pricing_mode:'surcharge',room_purchase_amount:12000,room_sale_amount:15000},hotel,null,types);
assert.equal(surcharge.purchase,12080);assert.equal(surcharge.sale,15120);assert.equal(surcharge.items[0].room_sale_amount,null);
assert.equal(p.optionalMoney(''),null);assert.equal(p.optionalMoney(0),0);assert.throws(()=>p.optionalMoney(-1));
console.log('Hotel mixed room calculation and original snapshot preservation passed.');
