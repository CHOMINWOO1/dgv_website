import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const context={console,Date,Uint8Array,Uint32Array};context.globalThis=context;
for(const file of ['payroll-receipts.js','payroll-tax.js'])vm.runInNewContext(await readFile(new URL('../assets/'+file,import.meta.url),'utf8'),context);
const data={kind:'ledger',month:'2026-10',employees:[{id:'a',name:'Synthetic',phone:'000-TEST'},{id:'b',name:'Unpaid'},{id:'c',name:'Draft'}],identities:[{employee_id:'a',national_id:'000-DEMO'}],runs:[{id:'r',employee_id:'a',month:'2026-10-01',base_amount:1000,total:1000,snapshot:{name:'Historical',settlementMode:'hourly_actual',minutes:999,hourlyActualMinutes:150,hourlyRates:[40000,50000],daily:[]}},{id:'unpaid',employee_id:'b',month:'2026-10-01',base_amount:2000,total:2000,snapshot:{settlementMode:'monthly_net',minutes:999,monthlyActualMinutes:61,monthlyExtraHourlyRate:123.45}}],payments:[{id:'one',run_id:'r',paid_on:'2026-11-01',amount:100,method:'cash',note:'<script>synthetic</script>'},{id:'two',run_id:'r',paid_on:'2026-11-02',amount:200,method:'cash'},{id:'void',run_id:'r',paid_on:'2026-10-01',amount:900,method:'cash'}],reversals:[{id:'rv',payment_id:'void'}],adjustments:[{id:'adj',run_id:'r',amount:500,reason:'Synthetic correction'}]};
const before=JSON.stringify(data),print=()=>context.DGV_PAYROLL_TAX.buildPayrollPrintHtml(data),html=print();
assert.equal(JSON.stringify(data),before);
assert.match(html,/11월 1일/);assert.doesNotMatch(html,/data-payment-id="void"/);assert.match(html,/2시간 30분/);assert.match(html,/1시간 1분/);assert.doesNotMatch(html,/16시간 39분/);
assert.match(html,/40\.000 \/ 50\.000/);assert.match(html,/복수 단가/);assert.match(html,/월 정산시급/);assert.match(html,/123,45/);
assert.match(html,/1\.500/);assert.match(html,/000-DEMO/);assert.match(html,/&lt;script&gt;synthetic/);assert.doesNotMatch(html,/<script>/);
assert.equal((html.match(/2시간 30분/g)||[]).length,1);assert.equal((html.match(/1\.500/g)||[]).length,1,'monthly salary appears once across instalments');
assert.match(html,/미확정/);assert.match(html,/실제 지급 합계[^<]*300/);
data.runs[0].snapshot.hourlyRates=[];data.runs[0].snapshot.hourlyRate=42000;assert.match(print(),/42\.000/);
data.runs[0].snapshot.hourlyActualMinutes=null;data.runs[0].snapshot.minutes=null;assert.doesNotMatch(print(),/0시간 0분/,'missing work duration stays empty');
data.payments[0].paid_on='2026-11-31';assert.throws(print,/date|날짜|ngay/i);
console.log('Ledger print unit passed: historical names, private identity strings, actual dates, cancelled exclusions, hourly/monthly duration sources, multiple hourly rates, labelled monthly conversion, adjusted finalized salary once, draft/null handling, escaping and immutable input.');

// Exercise the actual async loader: logout can happen while its final revision
// read is in flight even though the revision number itself remains unchanged.
const advanced=await readFile(new URL('../assets/payroll-advanced.js',import.meta.url),'utf8');
const loader=advanced.slice(advanced.indexOf('  async function ledgerPrintInput()'),advanced.indexOf('  async function renderReceiptRange('));
let revisionReads=0,releaseRevision,reachedFinal;
const finalRead=new Promise(resolve=>{releaseRevision=resolve;}),reached=new Promise(resolve=>{reachedFinal=resolve;});
const state={loaded:true,revision:1};
const query={select(){return this;},eq(){return this;},single(){if(++revisionReads===2){reachedFinal();return finalRead;}return {version:1};}};
const loaderContext={state,taxScope:()=>"synthetic-scope",taxPreviewGeneration:0,$:id=>({value:id==='exportKind'?'ledger':''}),taxInput:()=>({attachments:[]}),result:async value=>value,db:{from:()=>query},DGV_PAYROLL_TAX:{summarizePayroll:()=>({rows:[]})}};
vm.createContext(loaderContext);vm.runInContext(loader+'\nglobalThis.loadLedger=ledgerPrintInput;',loaderContext);
const pending=loaderContext.loadLedger();await reached;state.loaded=false;releaseRevision({version:1});
await assert.rejects(pending,/Tra cuu lai/,'logout during final revision must reject before returning private print input');
console.log('Ledger loader race passed: logout during final revision rejects before returning print data.');
