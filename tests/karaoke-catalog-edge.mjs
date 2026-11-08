import assert from 'node:assert/strict';
import {test} from 'node:test';
import {handler,parseRequest,sha256} from '../supabase/functions/hana-karaoke/index.ts';
import {handler as refresh,metadata} from '../supabase/functions/hana-karaoke-catalog-refresh/index.ts';
const id='2bda52d8-1c07-4a2e-b8cd-1af7915a40cd',token='a'.repeat(64),vid='dQw4w9WgXcQ';
const base={requestId:id,room:'123456',token};
const state={room:'123456',current:null,queue:[],topic:'opaque',revision:1};
const request=(data)=>new Request('https://test.invalid',{method:'POST',headers:{'content-type':'application/json',apikey:'public-unit'},body:JSON.stringify(data)});
function mock(t,fn){const oldDeno=globalThis.Deno,oldFetch=globalThis.fetch;
 globalThis.Deno={env:{get:key=>({SUPABASE_URL:'https://project.invalid',SUPABASE_SECRET_KEYS:JSON.stringify({default:'sb_secret_test'}),SUPABASE_ANON_KEY:'public-unit',YOUTUBE_API_KEY:'youtube-secret-test'})[key]}};
 const calls=[];globalThis.fetch=async(url,init)=>{calls.push({url:String(url),init});return fn(String(url),init);};
 t.after(()=>{globalThis.fetch=oldFetch;if(oldDeno===undefined)delete globalThis.Deno;else globalThis.Deno=oldDeno;});return calls;}
const json=data=>new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
test('catalogue validates category, Unicode query and bounded page tokens',()=>{
 assert.equal(parseRequest({...base,action:'library',query:'  Đà Lạt  ',category:'vi',pageToken:'10'}).data.query,'Đà Lạt');
 for(const extra of [{category:'bad'},{pageToken:'20001'},{pageToken:10},{query:' '},{query:'x\u0000'},{title:'client'}])
 assert.throws(()=>parseRequest({...base,action:'library',query:'song',category:'all',...extra}));
});
test('catalogue search uses hashed capabilities and no Google request',async t=>{
 const calls=mock(t,()=>json({source:'catalog',items:[],nextPageToken:null}));
 const r=await handler(request({...base,action:'library',query:'song',category:'ko'}));assert.equal(r.status,200);
 assert.equal(calls.length,1);assert.ok(calls[0].url.endsWith('/hana_karaoke_catalog_search'));
 const body=JSON.parse(calls[0].init.body);assert.equal(body.p_token_hash,await sha256(token));assert.equal(body.p_offset,0);
 assert.equal(JSON.stringify(calls).includes('googleapis'),false);
});
test('successful normal and priority adds remember trusted video ID only',async t=>{
 const calls=mock(t,url=>json(url.endsWith('/hana_karaoke_command')?{state,changed:true}:{inserted:1}));
 for(const priority of [false,true])assert.equal((await handler(request({...base,action:'add',videoId:vid,title:'client text',...(priority?{priority:true}:{})}))).status,200);
 const saves=calls.filter(c=>c.url.endsWith('/hana_karaoke_catalog_remember'));
 assert.equal(saves.length,2);assert.deepEqual(JSON.parse(saves[0].init.body),{p_video_id:vid});
});
test('a catalogue failure cannot fail an already committed reservation',async t=>{
 mock(t,url=>{if(url.endsWith('/hana_karaoke_catalog_remember'))throw Error('offline');return json({state,changed:false});});
 const r=await handler(request({...base,action:'add',videoId:vid,title:'client text'}));assert.equal(r.status,200);assert.deepEqual((await r.json()).state,state);
});
test('failed reservations never write catalogue entries',async t=>{
 const calls=mock(t,()=>new Response(JSON.stringify({message:'KARAOKE_QUEUE_FULL'}),{status:400}));
 assert.equal((await handler(request({...base,action:'add',videoId:vid,title:'client text'}))).status,409);
 assert.equal(calls.length,1);
});
test('refresh rejects missing/invalid/replayed jobs before Google',async t=>{
 const calls=mock(t,()=>json(null));
 assert.equal((await refresh(request({token:'bad'}))).status,404);assert.equal(calls.length,0);
 assert.equal((await refresh(request({token}))).status,404);assert.equal(calls.length,1);
});
test('refresh uses at most four videos.list calls, never search.list',async t=>{
 const ids=Array.from({length:200},(_,i)=>'VIDEOID'+String(i).padStart(4,'0'));
 const calls=mock(t,(url,init)=>{
  if(url.endsWith('_claim'))return json({leaseId:id,videoIds:ids});
  if(url.includes('googleapis')){const batch=new URL(url).searchParams.get('id').split(',');return json({items:batch.map(id=>({id,status:{privacyStatus:'public',embeddable:true},snippet:{title:'Song',channelTitle:'Channel'},contentDetails:{duration:'PT3M10S'}}))});}
  assert.equal(JSON.parse(init.body).p_items.length,200);return json({refreshed:200,removed:0});
 });
 const r=await refresh(request({token}));assert.equal(r.status,200);
 const google=calls.filter(c=>c.url.includes('googleapis'));assert.equal(google.length,4);
 for(const c of google){assert.equal(new URL(c.url).pathname,'/youtube/v3/videos');assert.equal(c.url.includes('youtube-secret-test'),false);assert.equal(c.init.headers['x-goog-api-key'],'youtube-secret-test');}
});
test('provider failure never deletes or claims metadata refreshed',async t=>{
 const calls=mock(t,url=>url.endsWith('_claim')?json({leaseId:id,videoIds:[vid]}):new Response('{}',{status:403}));
 assert.equal((await refresh(request({token}))).status,503);assert.equal(calls.some(c=>c.url.endsWith('_finish')),false);
});
test('private, blocked and unembeddable videos are omitted on refresh',()=>{
 const item={id:vid,status:{privacyStatus:'public',embeddable:true},snippet:{title:'Valid song'},contentDetails:{duration:'PT4M'}};
 assert.equal(metadata({items:[item]},[vid]).items.length,1);
 for(const variant of [{...item,status:{privacyStatus:'private',embeddable:true}},{...item,status:{privacyStatus:'public',embeddable:false}},{...item,contentDetails:{duration:'PT4M',regionRestriction:{blocked:['VN']}}}])assert.deepEqual(metadata({items:[variant]},[vid]).removed,[vid]);
});

