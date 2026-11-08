// Isolated PostgreSQL with real extensions. No hosted API or Google calls.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const root='C:/Users/user/Documents/Codex/2026-08-07/c/tmp/hotel-test-tools/pglite/package/dist/';
const {PGlite}=await import(pathToFileURL(root+'index.js'));
const {pg_trgm}=await import(pathToFileURL(root+'contrib/pg_trgm.js'));
const {unaccent}=await import(pathToFileURL(root+'contrib/unaccent.js'));
const db=new PGlite({extensions:{pg_trgm,unaccent}});
let n=0;const eq=(a,b)=>{assert.deepEqual(a,b);n++;};
const q=async(sql,args=[]) => (await db.query(sql,args)).rows;
const hash=s=>createHash('sha256').update(s).digest('hex');
const migration=async file=>db.exec(await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
const room='765432',host='a'.repeat(64),guest='b'.repeat(64);
const cmd=async(action,data={})=>(await q('select public.hana_karaoke_command($1,$2,$3,$4,$5::jsonb,$6,false) r',[action,room,host,randomUUID(),JSON.stringify(data),'c'.repeat(64)]))[0].r;
const search=async(query,category='all',offset=0,token=guest)=>(await q('select public.hana_karaoke_catalog_search($1,$2,$3,$4,$5,$6) r',[room,token,randomUUID(),query,category,offset]))[0].r;
try{
 await db.exec(`create schema extensions; create role anon;create role authenticated;create role service_role bypassrls;
 grant usage on schema public to anon,authenticated,service_role;
 create schema cron;create table cron.test_jobs(name text primary key,schedule text,command text);
 create function cron.schedule(text,text,text) returns bigint language sql as 'insert into cron.test_jobs values($1,$2,$3) on conflict(name) do update set schedule=excluded.schedule,command=excluded.command returning 1::bigint';
 create schema net;create table net.calls(body jsonb);
 create function net.http_post(url text,body jsonb,headers jsonb,timeout_milliseconds int) returns bigint language sql as 'insert into net.calls values($2) returning 1::bigint';
 grant usage on schema net to service_role; grant insert,select on net.calls to service_role;
 create table public.business_fixture(id int,amount bigint);insert into public.business_fixture values(1,8150000);grant select on public.business_fixture to service_role;`);
 await migration('20261108044359_hana_karaoke_serverless.sql');
 await migration('20261108050724_hana_karaoke_search_priority.sql');
 await db.exec('set role service_role');await cmd('create',{hostHash:host,joinHash:guest,topic:'hana-karaoke:'+'d'.repeat(64)});
 await cmd('add',{videoId:'dQw4w9WgXcQ',title:'Do not touch'});
 const before=(await q('select to_jsonb(r) r from public.hana_karaoke_rooms r'))[0].r;
 await db.exec('reset role');await migration('20261108083132_hana_karaoke_shared_catalog.sql');
 await migration('20261108084113_hana_karaoke_catalog_retention_window.sql');
 if(process.env.CATALOG_EXPANSION_MIGRATION) await migration(process.env.CATALOG_EXPANSION_MIGRATION);
 if(process.env.CATALOG_REFRESH_DUE_MIGRATION) await migration(process.env.CATALOG_REFRESH_DUE_MIGRATION);
 eq((await q('select to_jsonb(r) r from public.hana_karaoke_rooms r'))[0].r,before);
 eq((await q('select amount from public.business_fixture'))[0].amount,8150000);
 for(const role of ['anon','authenticated']){
  await db.exec('set role '+role);
  for(const sql of ['select * from public.hana_karaoke_catalog','select * from karaoke_private.catalog_refresh_jobs',"select public.hana_karaoke_catalog_import('[]')",'select public.hana_karaoke_catalog_search(null,null,null,null,null,null)',"select public.hana_karaoke_catalog_remember('dQw4w9WgXcQ')","select public.hana_karaoke_catalog_refresh_claim('x')"]){await assert.rejects(()=>q(sql),/permission denied/);n++;}
  await db.exec('reset role');
 }
 await db.exec('set role service_role');
 const songs=[{videoId:'dQw4w9WgXcQ',title:'Đừng làm trái tim anh đau',songTitle:'Đừng làm trái tim anh đau',artist:'Sơn Tùng',category:'vi',checkedAt:new Date().toISOString()},
  {videoId:'J5KM-L-EPrI',title:'사랑은 늘 도망가',artist:'임영웅',category:'ko',checkedAt:new Date().toISOString()},
  ...Array.from({length:12},(_,i)=>({videoId:'TESTVIDEO'+String(i).padStart(2,'0'),title:'Pop '+i,category:'pop',checkedAt:new Date().toISOString()}))];
 const put=async data=>(await q('select public.hana_karaoke_catalog_import($1::jsonb) r',[JSON.stringify(data)]))[0].r;
 eq(await put(songs),{inserted:14});eq(await put(songs),{inserted:0});
 eq((await search('dung lam trai tim')).items[0].videoId,'dQw4w9WgXcQ');
 eq((await search('son tung')).items.length,1);eq((await search('임영웅')).items.length,1);
 if(process.env.CATALOG_EXPANSION_MIGRATION){
  eq((await search('사랑은늘도망가')).items.length,1);
  eq((await search('사 랑 은  늘 도 망 가')).items.length,1);
  eq((await search('사랑은\u3000늘\u00a0도망가')).items.length,1);
  eq((await search('dunglamtraitim')).items.length,1);
  eq((await search('sontung')).items.length,1);
  eq((await search('đừnglàmtráitim')).items.length,1);
  eq((await search('\u200b')).items.length,0);
  const beforeEnrich=(await q("select to_jsonb(c)-array['view_count','channel_id','published_at'] r from public.hana_karaoke_catalog c where video_id=$1",[songs[0].videoId]))[0].r;
  eq(await put([{...songs[0],views:12345,channelId:'UC'+'x'.repeat(22),publishedAt:'2020-01-01T00:00:00Z'}]),{inserted:0});
  eq((await q("select view_count from public.hana_karaoke_catalog where video_id=$1",[songs[0].videoId]))[0].view_count,12345);
  eq((await q("select to_jsonb(c)-array['view_count','channel_id','published_at'] r from public.hana_karaoke_catalog c where video_id=$1",[songs[0].videoId]))[0].r,beforeEnrich);
  await q("update public.hana_karaoke_catalog set view_count=case when video_id='TESTVIDEO05' then 2000000 when video_id='TESTVIDEO03' then 1000000 else 1 end where category='pop'");
  eq((await search('Pop','pop')).items.slice(0,2).map(i=>i.videoId),['TESTVIDEO05','TESTVIDEO03']);
  eq(await put([{videoId:'SAMEART0001',title:'동명곡 테스트 - 가수 A',songTitle:'동명곡 테스트',artist:'가수 A',category:'ko',checkedAt:new Date().toISOString()},
   {videoId:'SAMEART0002',title:'동명곡 테스트 - 가수 B',songTitle:'동명곡 테스트',artist:'가수 B',category:'ko',checkedAt:new Date().toISOString()}]),{inserted:2});
  eq((await search('동명곡 테스트','ko')).items.length,2);
  await db.exec('reset role');
  eq((await q("select schedule from cron.test_jobs where name='hana_karaoke_catalog_refresh'"))[0].schedule,'43 3 * * *');
  eq((await q("select command from cron.test_jobs where name='hana_karaoke_catalog_refresh'"))[0].command,'select karaoke_private.enqueue_catalog_refresh_if_due()');
  await db.exec('reset role;set role anon');await assert.rejects(()=>q("select public.hana_karaoke_catalog_compact('secret')"),/permission denied/);n++;
  await db.exec('reset role;set role service_role');
 }
 eq((await search('도망가','vi')).items.length,0);eq((await search('%')).items.length,0);
 const first=await search('Pop','pop');eq(first.items.length,10);eq(first.nextPageToken,'10');
 eq((await search('Pop','pop',10)).items.length,2);
 await assert.rejects(()=>search('Pop','all',0,'f'.repeat(64)),/KARAOKE/);n++;
 eq((await q('select calls from public.hana_karaoke_search_quota'))[0].calls,0);
 // A title typed by a client cannot become a public catalogue entry.
 eq((await q("select public.hana_karaoke_catalog_remember('NOTINDB0001') r"))[0].r,{inserted:0});
 await q(`insert into public.hana_karaoke_search_cache(cache_key,lease_id,lease_quota_day,lease_until,expires_at,result)
 values($1,$2,current_date,now(),now()+interval '24 hours',$3::jsonb)`,[hash('cache'),randomUUID(),JSON.stringify({items:[{videoId:'NEWSOURCE01',title:'Trusted YouTube title',channelTitle:'Official'}]})]);
 eq((await q("select public.hana_karaoke_catalog_remember('NEWSOURCE01') r"))[0].r,{inserted:1});
 eq((await q("select title from public.hana_karaoke_catalog where video_id='NEWSOURCE01'"))[0].title,'Trusted YouTube title');
 if(process.env.CATALOG_EXPANSION_MIGRATION){
  await q('select karaoke_private.enqueue_catalog_refresh_if_due()');
  eq((await q('select count(*)::int n from net.calls'))[0].n,0);
 }
 await db.exec(`update public.hana_karaoke_catalog set checked_at=now()-interval '31 days' where video_id='J5KM-L-EPrI'`);
 eq((await search('임영웅')).items.length,0);
 await q('select karaoke_private.enqueue_catalog_refresh()');
 const token=(await q('select body from net.calls'))[0].body.token;
 const claim=(await q('select public.hana_karaoke_catalog_refresh_claim($1) r',[token]))[0].r;
 eq((await q('select public.hana_karaoke_catalog_refresh_claim($1) r',[token]))[0].r,null);
 eq((await q("select count(*)::int n from public.hana_karaoke_catalog where video_id='J5KM-L-EPrI'"))[0].n,0);
 const id=claim.videoIds[0];
 await assert.rejects(()=>q('select public.hana_karaoke_catalog_refresh_finish($1,$2::jsonb,$3)',[claim.leaseId,JSON.stringify([{videoId:'UNLEASED000',title:'bad'}]),[]]),/Unleased/);n++;
 const refreshedIds=process.env.CATALOG_EXPANSION_MIGRATION?claim.videoIds:[id];
 eq((await q('select public.hana_karaoke_catalog_refresh_finish($1,$2::jsonb,$3) r',[claim.leaseId,JSON.stringify(refreshedIds.map(videoId=>({videoId,title:'Updated metadata',channelTitle:'Verified',durationSeconds:200,views:345,channelId:'UC'+'v'.repeat(22),publishedAt:'2020-02-01T00:00:00Z'}))),[]]))[0].r.refreshed,refreshedIds.length);
 eq((await q('select count(*)::int n from karaoke_private.catalog_refresh_jobs'))[0].n,0);
 await db.exec('reset role');
 if(process.env.CATALOG_EXPANSION_MIGRATION){
  eq((await q('select count(*)::int n from karaoke_private.catalog_refresh_cycles where completed_at is not null'))[0].n,1);
  const callsBefore=(await q('select count(*)::int n from net.calls'))[0].n;
  await q('select karaoke_private.enqueue_catalog_refresh_if_due()');
  eq((await q('select count(*)::int n from net.calls'))[0].n,callsBefore);
  if(process.env.CATALOG_REFRESH_DUE_MIGRATION){
   // A newly remembered entry can be older than the most recently finished cycle.
   await db.exec("update public.hana_karaoke_catalog set checked_at=now()-interval '29 days' where video_id='NEWSOURCE01'");
   await q('select karaoke_private.enqueue_catalog_refresh_if_due()');
   eq((await q('select count(*)::int n from net.calls'))[0].n,callsBefore+1);
   eq((await q('select count(*)::int n from karaoke_private.catalog_refresh_cycles where completed_at is null'))[0].n,1);
   // Test fixture cleanup only; no hosted connection exists in this test.
   await db.exec('delete from karaoke_private.catalog_refresh_jobs;delete from karaoke_private.catalog_refresh_cycles where completed_at is null');
  }
  // A 401-row cycle requires three sequential batches; never overlapping jobs.
  await db.exec('set role service_role');
  for(let offset=0;offset<401;offset+=250) await put(Array.from({length:Math.min(250,401-offset)},(_,i)=>({videoId:'CYCLE'+String(offset+i).padStart(6,'0'),title:'Cycle fixture',category:'other',checkedAt:new Date().toISOString()})));
  await db.exec("reset role;update karaoke_private.catalog_refresh_cycles set completed_at=now()-interval '29 days';update public.hana_karaoke_catalog set checked_at=now()-interval '29 days'");
  await q('select karaoke_private.enqueue_catalog_refresh_if_due()');
  const seen=new Set();let batches=0;
  while((await q('select count(*)::int n from karaoke_private.catalog_refresh_jobs'))[0].n){
   eq((await q('select count(*)::int n from karaoke_private.catalog_refresh_jobs'))[0].n,1);
   const jobToken=(await q('select body from net.calls order by ctid desc limit 1'))[0].body.token;
   await db.exec('set role service_role');
   const lease=(await q('select public.hana_karaoke_catalog_refresh_claim($1) r',[jobToken]))[0].r;
   assert.ok(lease.videoIds.length<=200);n++;
   for(const videoId of lease.videoIds){assert.equal(seen.has(videoId),false);seen.add(videoId);}
   await assert.rejects(()=>q('select public.hana_karaoke_catalog_refresh_finish($1,$2::jsonb,$3)',[lease.leaseId,'[]',[]]),/Incomplete/);n++;
   if(batches===0){
    await db.exec("reset role;update karaoke_private.catalog_refresh_jobs set expires_at=now()-interval '1 minute'");
    await q('select karaoke_private.enqueue_catalog_refresh_if_due()');
    const retryToken=(await q('select body from net.calls order by ctid desc limit 1'))[0].body.token;
    await db.exec('set role service_role');
    const retry=(await q('select public.hana_karaoke_catalog_refresh_claim($1) r',[retryToken]))[0].r;
    eq(retry.videoIds,lease.videoIds);Object.assign(lease,retry);
   }
   await q('select public.hana_karaoke_catalog_refresh_finish($1,$2::jsonb,$3)',[lease.leaseId,JSON.stringify(lease.videoIds.map(videoId=>({videoId,title:'Refreshed cycle fixture',durationSeconds:180}))),[]]);
   await db.exec('reset role');batches++;
  }
  eq(batches,3);eq(seen.size,417);
  eq((await q('select refreshed_count from karaoke_private.catalog_refresh_cycles order by started_at desc limit 1'))[0].refreshed_count,417);
  const doneCalls=(await q('select count(*)::int n from net.calls'))[0].n;
  await q('select karaoke_private.enqueue_catalog_refresh_if_due()');
  eq((await q('select count(*)::int n from net.calls'))[0].n,doneCalls);
 }
 await db.exec("update public.hana_karaoke_catalog set checked_at=now()-interval '29 days 23 hours' where video_id='NEWSOURCE01'");
 await db.exec((await q("select command from cron.test_jobs where name='hana_karaoke_catalog_retention'"))[0].command);
 eq((await q("select count(*)::int n from public.hana_karaoke_catalog where video_id='NEWSOURCE01'"))[0].n,0);
 eq((await q('select amount from public.business_fixture'))[0].amount,8150000);
 console.log(`Catalogue DB: ${n} checks passed (capabilities, permissions, accents, pagination, zero search quota, cache-only auto-save, bounded refresh, retention, unchanged business/rooms).`);
}catch(error){console.error({message:error.message,code:error.code,where:error.where,query:error.query,stack:error.stack});process.exitCode=1;}finally{await db.close();}
