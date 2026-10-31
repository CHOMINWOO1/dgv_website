import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {deflateSync} from 'node:zlib';
import vm from 'node:vm';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Shared, read-only package inspection for the unit and actual-download tests.
export function readXlsx(bytes){
  const data=Buffer.from(bytes),files=new Map();let offset=0;
  while(offset+30<=data.length&&data.readUInt32LE(offset)===0x04034b50){
    assert.equal(data.readUInt16LE(offset+8),0,'native workbook uses STORE ZIP entries');
    const size=data.readUInt32LE(offset+18),nameSize=data.readUInt16LE(offset+26),extraSize=data.readUInt16LE(offset+28);
    const name=data.subarray(offset+30,offset+30+nameSize).toString('utf8'),start=offset+30+nameSize+extraSize;
    const content=data.subarray(start,start+size);assert.equal(content.length,size,'ZIP entry is complete');
    assert.equal(crc(content),data.readUInt32LE(offset+14),'ZIP entry CRC matches '+name);
    assert.equal(files.has(name),false,'ZIP entries have unique names');files.set(name,content);offset=start+size;
  }
  assert.equal(data.readUInt32LE(offset),0x02014b50,'central ZIP directory follows the files');
  return files;
}
export function xml(files,name){assert.ok(files.has(name),'workbook contains '+name);return files.get(name).toString('utf8');}
export function unescapeXml(value){return value.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');}
export function cells(sheet){
  return [...sheet.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map(match=>{
    const attributes=match[1],body=match[2]||'',reference=/\br="([^"]+)"/.exec(attributes)?.[1];
    const type=/\bt="([^"]+)"/.exec(attributes)?.[1]||'n';
    const text=[...body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(item=>unescapeXml(item[1])).join('');
    const number=/<v>([^<]+)<\/v>/.exec(body)?.[1];
    return {reference,type,value:type==='inlineStr'?text:number===undefined?null:Number(number),body,attributes};
  });
}
export function crc(bytes){let value=0xffffffff;for(const byte of bytes){value^=byte;for(let bit=0;bit<8;bit++)value=value&1?0xedb88320^(value>>>1):value>>>1;}return (value^0xffffffff)>>>0;}
function chunk(type,bytes){const label=Buffer.from(type),result=Buffer.alloc(bytes.length+12);result.writeUInt32BE(bytes.length);label.copy(result,4);bytes.copy(result,8);result.writeUInt32BE(crc(Buffer.concat([label,bytes])),8+bytes.length);return result;}
function png(seed){
  const width=80,height=24,header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;
  const data=Buffer.alloc((1+width*4)*height,255);for(let y=0;y<height;y++){data[y*(width*4+1)]=0;for(let x=0;x<width;x++){const n=y*(width*4+1)+1+x*4;data[n]=data[n+1]=data[n+2]=(x+y*seed)%17<2?25:255;}}
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(data)),chunk('IEND',Buffer.alloc(0))]);
}
function fixture(){
  const images=[png(1),png(3),png(5)],payments=[
    {id:'a-first',employee_id:'a',payroll_month:'2026-09-01',paid_on:'2026-10-01',amount:220000,method:'cash'},
    {id:'a-second',employee_id:'a',payroll_month:'2026-10-01',paid_on:'2026-10-31',amount:180000,method:'bank'},
    {id:'b-unsigned',employee_id:'b',payroll_month:'2026-10-01',paid_on:'2026-10-15',amount:70000,method:'voucher'},
    {id:'cancelled',employee_id:'b',payroll_month:'2026-10-01',paid_on:'2026-10-20',amount:987654,method:'cash'},
    {id:'before',employee_id:'a',payroll_month:'2026-09-01',paid_on:'2026-09-30',amount:123456,method:'bank'},
    {id:'after',employee_id:'a',payroll_month:'2026-10-01',paid_on:'2026-11-01',amount:654321,method:'cash'}
  ],attachments=[],signatureImages={};
  for(const [index,paymentId] of ['a-first','a-second','a-second'].entries()){
    const id='signature-'+index,storagePath=paymentId+'/'+id+'.png';
    attachments.push({id,payment_id:paymentId,storage_path:storagePath,evidence_type:'signature',mime_type:'image/png',byte_size:images[index].length,signed_name:index===0?'=SUM(1,2) <receiver>':'SYNTHETIC receiver '+index,acknowledged_at:'2026-10-01T17:01:02Z'});
    signatureImages[id]={paymentId,storagePath,dataUrl:'data:image/png;base64,'+images[index].toString('base64')};
  }
  return {images,input:{fromDate:'2026-10-01',toDate:'2026-10-31',employeeId:'',employees:[
    {id:'a',name:'=HYPERLINK("https://unsafe.invalid","name")',device_user_id:'0001',phone:'00123456789',employment_type:'full_time',bank_account:'PRIVATE-BANK-EXCLUDED'},
    {id:'b',name:'SYNTHETIC employee B <&>',device_user_id:'0002',phone:'00987654321',employment_type:'part_time'}
  ],identities:[{employee_id:'a',national_id:'001234567890'},{employee_id:'b',national_id:'+012345678901'}],receiptSummaries:[
    {employee_id:'b',month:'2026-10',employmentType:'part_time',settlementMode:'hourly_actual',hourlyActualMinutes:330,workedDays:1,hourlyRates:[40000],baseAmount:220000,daily:[{date:'2026-10-15',minutes:330}]},
    {employee_id:'a',month:'2026-10',employmentType:'full_time',settlementMode:'monthly_net',monthlyActualMinutes:12480,workedDays:26,monthlyExtraHourlyRate:33653.84615384615,baseAmount:7000000,daily:[{date:'2026-10-02',minutes:480}]}
  ],runs:[],payments,reversals:[{id:'r',payment_id:'cancelled'}],attachments,signatureImages}};
}
async function test(){
  const context={console,Date,Uint8Array,Uint32Array,DataView,ArrayBuffer,TextEncoder,TextDecoder,atob,btoa};vm.createContext(context);
  for(const asset of ['payroll-receipts.js','dgv-xlsx.js','payroll-receipts-xlsx.js'])vm.runInContext(await readFile(new URL('../assets/'+asset,import.meta.url),'utf8'),context);
  const {input,images}=fixture(),receipts=context.DGV_PAYROLL_RECEIPTS,builder=context.DGV_PAYROLL_RECEIPTS_XLSX;
  const model=receipts.buildModel(input),before=JSON.stringify(model),options={generatedOn:'2026-11-01'};
  const workbook=builder.buildWorkbook(model,options),files=readXlsx(context.DGV_XLSX.buildWorkbookBytes(workbook));
  assert.equal(JSON.stringify(model),before,'export does not mutate the captured print model');assert.equal(workbook.sheets.length,1);
  assert.match(workbook.filename,/2026-10-01/);assert.match(workbook.filename,/2026-10-31/);assert.match(workbook.filename,/\.xlsx$/);
  const sheet=xml(files,'xl/worksheets/sheet1.xml'),values=cells(sheet),texts=values.filter(cell=>cell.type==='inlineStr').map(cell=>cell.value).join('\n');
  const money=values.filter(cell=>/^I\d+$/.test(cell.reference)&&cell.type==='n'&&cell.value!==null);
  const totalRow=Number(values.find(cell=>typeof cell.value==='string'&&cell.value.startsWith('합계 / Tổng cộng'))?.reference.slice(1));assert.ok(totalRow);
  for(const amount of [220000,180000,70000])assert.equal(money.filter(cell=>Number(cell.reference.slice(1))<totalRow&&cell.value===amount).length,1,'each actual payment amount occurs once in its numeric money column');
  assert.ok(money.some(cell=>cell.value===470000),'total is 470,000 VND');
  assert.doesNotMatch(sheet,/<f(?:\s|>)/,'employee text can never become an Excel formula');
  for(const text of ['001234567890','00123456789','+012345678901','=HYPERLINK("https://unsafe.invalid","name")','=SUM(1,2) <receiver>','2026-09','2026-10-01','2026-10-31','2026-11-01','2026-10-02 00:01:02'])assert.ok(texts.includes(text),'preserves exact text '+text);
  assert.match(texts,/서명 미등록|Chưa ký/);assert.doesNotMatch(texts,/PRIVATE-BANK|cancelled|before|after/);
  assert.match(texts,/지급 3건 · 직원 2명/,'two instalments for one employee do not inflate headcount');
  const summaryRow=values.find(cell=>cell.value==='지급 합계 (VND)\nTổng đã trả')?.reference.slice(1);assert.ok(summaryRow);
  for(const [column,expected] of [['C',470000],['F',220000],['K',180000]])assert.equal(values.find(cell=>cell.reference===column+summaryRow)?.value,expected,'payment-method summary reconciles');
  const otherRow=values.find(cell=>typeof cell.value==='string'&&cell.value.startsWith('지급수단 확인 필요 (VND)'))?.reference.slice(1);assert.ok(otherRow);assert.equal(values.find(cell=>cell.reference==='I'+otherRow)?.value,70000,'unknown methods remain visible and included in grand total');
  for(const amount of [987654,123456,654321])assert.equal(values.some(cell=>cell.value===amount),false,'cancelled and out-of-period money is excluded');
  for(const amount of [220000,180000,70000]){const row=money.find(cell=>cell.value===amount).reference.slice(1);assert.equal(values.find(cell=>cell.reference==='B'+row)?.type,'inlineStr','employee identity and telephone fields stay text');}
  const paidDates=values.filter(cell=>/^J\d+$/.test(cell.reference)&&cell.type==='n'&&cell.value!==null);
  assert.deepEqual(paidDates.map(cell=>cell.value).sort((a,b)=>a-b),[46296,46310,46326],'every actual payment date is a numeric Excel date beneath its method');
  const header=workbook.sheets[0].rows[5].map(cell=>cell.value.split('\n')[0]);assert.deepEqual(Array.from(header),['번호','직원 / 코드','근무일','실근무','시급 (VND)','기본급 (VND)','수당','공제','실지급액 (VND)','지급수단','수령확인']);
  assert.ok(texts.indexOf('파트타임 /')<texts.indexOf('정규직 /'),'part-time section precedes full-time despite employee name/date sort');
  const hourlyRow=money.find(cell=>cell.value===70000).reference.slice(1),monthlyRow=money.find(cell=>cell.value===180000).reference.slice(1),unknownDetailRow=money.find(cell=>cell.value===220000).reference.slice(1);
  assert.match(values.find(cell=>cell.reference==='C'+hourlyRow).value,/10\/15.*\n1일/);assert.match(values.find(cell=>cell.reference==='D'+hourlyRow).value,/5시간 30분/);
  assert.equal(values.find(cell=>cell.reference==='E'+hourlyRow).value,40000);assert.equal(values.find(cell=>cell.reference==='F'+hourlyRow).value,220000);
  assert.equal(values.find(cell=>cell.reference==='G'+hourlyRow).value,'—','unfinalized manual allowances are unavailable rather than invented zero');assert.equal(values.find(cell=>cell.reference==='H'+hourlyRow).value,'—');
  assert.equal(values.find(cell=>cell.reference==='F'+monthlyRow).value,7000000);assert.equal(values.find(cell=>cell.reference==='E'+monthlyRow).value,33653.84615384615,'calculated hourly-rate precision survives numeric export');
  assert.equal((texts.match(/현재 월 계산값/g)||[]).length,1,'common calculated-source disclaimer appears once for all employees');
  assert.equal((texts.match(/수기 수당·공제 미확정/g)||[]).length,1,'common unfinalized allowances/deductions disclaimer appears once');
  assert.match(values.find(cell=>cell.reference==='B'+monthlyRow).value,/계산† \/ Tạm tính†/,'compact source marker points to the shared explanation');
  assert.match(texts,/월 환산시급 \/ Đơn giá quy đổi tháng/,'specific hourly-rate context remains visible');
  for(const column of 'CDEFGH')assert.equal(values.find(cell=>cell.reference===column+unknownDetailRow).value,'—','missing monthly data is explicitly unknown');
  const print=receipts.buildPrintHtml(model);assert.equal((print.match(/<tr data-payment-id=/g)||[]).length,3);
  assert.equal(model.totals.activeTotal,470000);assert.equal(model.totals.unsignedCount,1);assert.equal(new Set(model.rows.map(row=>row.employeeId)).size,2);
  assert.match(sheet,/orientation="landscape"/);assert.match(sheet,/fitToWidth="1"/);assert.match(sheet,/fitToHeight="0"/);assert.match(sheet,/showGridLines="0"/);
  assert.match(xml(files,'xl/workbook.xml'),/_xlnm.Print_Area/);assert.match(xml(files,'xl/workbook.xml'),/_xlnm.Print_Titles/);
  assert.match(xml(files,'xl/styles.xml'),/19364F|17365D|17324D|1B365D|17365d|19364f/i,'report has a navy style');
  assert.match(xml(files,'xl/worksheets/_rels/sheet1.xml.rels'),/Target="\.\.\/drawings\/drawing1.xml"/);
  const drawing=xml(files,'xl/drawings/drawing1.xml'),rels=xml(files,'xl/drawings/_rels/drawing1.xml.rels');
  assert.equal((drawing.match(/<xdr:oneCellAnchor>/g)||[]).length,3,'every stored signature is embedded');
  assert.equal((rels.match(/<Relationship /g)||[]).length,3);
  const anchors=[...drawing.matchAll(/<xdr:row>(\d+)<\/xdr:row>/g)].map(match=>Number(match[1]));assert.equal(new Set(anchors).size,3,'multiple proofs have separate rows');
  for(const match of drawing.matchAll(/<xdr:col>(\d+)<\/xdr:col>/g))assert.equal(Number(match[1]),10,'signatures anchor only to K signature column');
  const media=[...files].filter(([name])=>name.startsWith('xl/media/'));assert.equal(media.length,3);
  for(const bytes of images)assert.equal(media.filter(([,actual])=>actual.equals(bytes)).length,1,'exact per-payment PNG bytes survive the workbook');
  for(const [name,bytes] of files)if(name.endsWith('.rels'))assert.doesNotMatch(bytes.toString(),/TargetMode="External"|https:\/\/unsafe/,'no external references');
  assert.match(sheet,/<mergeCell ref="I\d+:I\d+"/,'multiple signatures merge money cells without duplicating their value');
  for(const [,left,top,right,bottom] of sheet.matchAll(/<mergeCell ref="([A-K])(\d+):([A-K])(\d+)"/g)){
    for(const cell of values){const coordinate=/^([A-K])(\d+)$/.exec(cell.reference);if(!coordinate)continue;
      if(coordinate[1]>=left&&coordinate[1]<=right&&Number(coordinate[2])>=Number(top)&&Number(coordinate[2])<=Number(bottom)&&cell.reference!==left+top)assert.equal(cell.value===null||cell.value==='',true,'merged cells must not hide a total or label at '+cell.reference);
    }
  }
  const selected=receipts.buildModel({...input,employeeId:'a',fromDate:'2026-10-31',toDate:'2026-10-31'}),selectedFiles=readXlsx(context.DGV_XLSX.buildWorkbookBytes(builder.buildWorkbook(selected,options)));
  const selectedValues=cells(xml(selectedFiles,'xl/worksheets/sheet1.xml'));
  assert.equal(selected.rows.length,1);assert.equal(selected.totals.activeTotal,180000);
  assert.equal([...selectedFiles.keys()].filter(name=>name.startsWith('xl/media/')).length,2);
  assert.equal(selectedValues.some(cell=>cell.value===220000||cell.value===70000),false,'selected person and inclusive paid-date scope match the print model');
  assert.doesNotMatch(xml(selectedFiles,'xl/worksheets/sheet1.xml'),/employee B|00987654321/);
  const forged=structuredClone(model);forged.rows.push({...structuredClone(model.rows[0]),paymentId:'injected-cancelled',status:'cancelled',amount:999999});forged.totals.activeTotal=999999;
  assert.deepEqual(JSON.parse(JSON.stringify(builder.buildWorkbook(forged,options))),JSON.parse(JSON.stringify(workbook)),'cancelled rows and stale summary totals cannot be restored by a caller');
  const missing=receipts.buildModel({...input,signatureImages:{}});assert.throws(()=>builder.buildWorkbook(missing,options),/서명|signature|chữ ký/i,'stored but unavailable signatures block export');
  const borrowed=receipts.buildModel({...input,signatureImages:{...input.signatureImages,'signature-0':{...input.signatureImages['signature-0'],paymentId:'a-second'}}});assert.throws(()=>builder.buildWorkbook(borrowed,options),/서명|signature|chữ ký/i,'a different payout signature cannot be borrowed');
  const invalid=structuredClone(model);invalid.rows[0].signatures[0].imageDataUrl='data:image/svg+xml,<svg/>';assert.throws(()=>builder.buildWorkbook(invalid,options),/서명|signature|chữ ký|PNG/i);
  const groupedInput=structuredClone(input);
  groupedInput.employees.push({id:'c',name:'SYNTHETIC unknown',device_user_id:'0003',employment_type:'unmapped'});
  groupedInput.payments.push({id:'b-second',employee_id:'b',payroll_month:'2026-10-01',paid_on:'2026-10-16',amount:30000,method:'bank'},{id:'c-unknown',employee_id:'c',payroll_month:'2026-10-01',paid_on:'2026-10-02',amount:11000,method:'cash'});
  groupedInput.payments.reverse();
  groupedInput.runs=[{id:'a-september-final',employee_id:'a',month:'2026-09-01',base_amount:6500000,allowances:500000,deductions:100000,snapshot:{employmentType:'full_time',settlementMode:'monthly_net',monthlyActualMinutes:960,workedDays:2,monthlyExtraHourlyRate:33333.333333,daily:[{date:'2026-09-27',minutes:480},{date:'2026-09-28',minutes:480}]}}];
  groupedInput.adjustments=[{id:'september-adjustment',run_id:'a-september-final',amount:-12000}];
  const grouped=builder.buildWorkbook(receipts.buildModel(groupedInput),options),groupedValues=cells(xml(readXlsx(context.DGV_XLSX.buildWorkbookBytes(grouped)),'xl/worksheets/sheet1.xml'));
  const groupedText=groupedValues.filter(cell=>cell.type==='inlineStr').map(cell=>cell.value).join('\n'),groupedTotal=Number(groupedValues.find(cell=>typeof cell.value==='string'&&cell.value.startsWith('합계 / Tổng cộng')).reference.slice(1));
  const payouts=groupedValues.filter(cell=>/^I\d+$/.test(cell.reference)&&cell.type==='n'&&cell.value!==null&&Number(cell.reference.slice(1))<groupedTotal);
  assert.deepEqual(payouts.map(cell=>cell.value),[70000,30000,220000,180000,11000],'role, employee/month, then paid date order is independent of source order');
  assert.ok(groupedText.indexOf('파트타임 /')<groupedText.indexOf('정규직 /')&&groupedText.indexOf('정규직 /')<groupedText.indexOf('고용유형 확인 필요 /'),'unknown staff are a clearly separate section after regular staff');
  const splitRow=payouts.find(cell=>cell.value===30000).reference.slice(1);
  for(const column of 'CDEFGH')assert.equal(groupedValues.find(cell=>cell.reference===column+splitRow).value,null,'a second payment cannot repeat monthly work/wage data');
  assert.equal(groupedValues.filter(cell=>/^F\d+$/.test(cell.reference)&&cell.value===220000).length,1,'monthly base wages appear once despite multiple actual payouts');
  const finalRow=payouts.find(cell=>cell.value===220000).reference.slice(1);
  assert.match(groupedValues.find(cell=>cell.reference==='B'+finalRow).value,/2026-09 · 확정/,'previous salary-month identity remains distinct from October paid date');
  assert.match(groupedValues.find(cell=>cell.reference==='C'+finalRow).value,/09\/27–09\/28/);
  for(const [column,amount] of [['F',6500000],['G',500000],['H',100000]])assert.equal(groupedValues.find(cell=>cell.reference===column+finalRow).value,amount,'finalized saved wage components remain actual saved values');
  assert.match(groupedText,/별도 조정액.*-12,000 VND/);assert.match(groupedText,/지급 5건 · 직원 3명/);
  assert.equal(groupedValues.find(cell=>cell.reference==='I'+groupedTotal).value,511000,'payout totals use actual payments, not monthly wages or adjustments');
  const conflict=receipts.buildModel(groupedInput);conflict.rows.find(row=>row.paymentId==='b-second').detail={...conflict.rows.find(row=>row.paymentId==='b-second').detail,minutes:331};
  assert.throws(()=>builder.buildWorkbook(conflict,options),/일치|khớp/,'conflicting monthly data blocks a misleading workbook');
  const fractional=structuredClone(model);fractional.rows.find(row=>row.employeeId==='b').detail.minutes=330.5;
  assert.ok(builder.buildWorkbook(fractional,options).sheets[0].rows.flat().some(cell=>typeof cell.value==='string'&&cell.value.includes('5시간 30.5분')),'fractional minutes are preserved rather than rejected or rounded into extra work');
  const warned=structuredClone(model);warned.rows.find(row=>row.employeeId==='b').detail.issues.push('근무·급여조건 확인 필요 / Cần kiểm tra chấm công và điều kiện lương','자동 계산 추가급여 12,345 VND · 수기 수당·공제 미확정 / Phần tự tính; phụ cấp, khấu trừ thủ công chưa chốt');
  const warnedText=builder.buildWorkbook(warned,options).sheets[0].rows.flat().map(cell=>cell.value).join('\n');
  assert.match(warnedText,/근무·급여조건 확인 필요/,'employee-specific warnings survive common-note compaction');
  assert.match(warnedText,/자동 계산 추가급여 \/ Phần tự tính: 12,345 VND/,'employee-specific automatic amount survives without repeating the generic suffix');
  assert.equal((warnedText.match(/수기 수당·공제 미확정/g)||[]).length,1);
  const empty=builder.buildWorkbook(receipts.buildModel({...input,payments:[]}),options);assert.equal(empty.sheets[0].images.length,0);assert.ok(empty.sheets[0].rows.flat().some(cell=>cell.value==='선택기간 지급 내역 없음 / Không có khoản trả trong kỳ'));
  console.log('Payroll receipt XLSX passed: 11 columns, role sections, monthly details once per employee/month, finalized/current/unknown data, split payments, numeric payment dates/rates/amounts, exact PNG relationships, text identities, cancellation/scope and unavailable-signature blocking.');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await test();
