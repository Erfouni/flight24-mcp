import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const mod=await import('../provider-downloads.mjs').catch(()=>({}));
const q={flightId:'4263c7e5',format:'csv',historyTimestamp:1793552700};
const csv=Buffer.from('Timestamp,UTC,Callsign,Position,Altitude,Speed,Direction\r\n1793552700,2026-11-01T00:00:00Z,BA85,"51.4,-0.4",1000,140,270\r\n');
const quota=remaining=>new Response(JSON.stringify({quotaLeft:remaining,expires:'2026-11-03T00:00:00Z'}),{headers:{'content-type':'application/json'}});
function create(options){assert.equal(typeof mod.ProviderDownloadsService,'function');return new mod.ProviderDownloadsService(options);}

test('original provider bytes and source flight/timestamp are preserved after the source-backed quota check',async()=>{
  const calls=[];const service=create({getRequestHeaders:async()=>({cookie:'FR24SID=fixture-secret; cf_clearance=not-replayed','user-agent':'Fixture Browser'}),fetch:async(url,options)=>{calls.push({url:new URL(url),options});return calls.length===1?quota(25):new Response(csv,{headers:{'content-type':'text/csv','content-disposition':'attachment; filename="original-BA85.csv"'}});}});
  const result=await service.downloadOriginal(q);
  assert.equal(calls[0].url.pathname,'/download/check-quota');assert.deepEqual(Object.fromEntries(calls[0].url.searchParams),{flight:q.flightId});assert.equal(calls[0].options.headers['X-Fetch'],'true');
  assert.equal(calls[1].url.pathname,'/download/');assert.deepEqual(Object.fromEntries(calls[1].url.searchParams),{flight:q.flightId,file:'csv',trailLimit:'0',history:String(q.historyTimestamp)});
  for(const call of calls){assert.equal(call.url.origin,'https://www.flightradar24.com');assert.equal(call.options.redirect,'error');assert.ok(!call.options.headers.cookie.includes('cf_clearance'));}
  assert.deepEqual(result.bytes,csv);assert.equal(result.metadata.sha256,createHash('sha256').update(csv).digest('hex'));assert.equal(result.metadata.filename,'original-BA85.csv');assert.equal(result.metadata.sourceHistoryTimestamp,q.historyTimestamp);
  assert.equal(result.metadata.providerOriginalBytes,true);assert.ok(!JSON.stringify(result.metadata).includes('fixture-secret'));
});

test('identical and concurrent requests share one original file download with isolated buffers',async()=>{
  let calls=0;const service=create({fetch:async url=>{calls++;await new Promise(resolve=>setTimeout(resolve,2));return new URL(url).pathname.includes('check-quota')?quota(2):new Response(csv,{headers:{'content-type':'text/csv'}});}});
  const [a,b]=await Promise.all([service.downloadOriginal(q),service.downloadOriginal(q)]);assert.equal(calls,2);a.bytes[0]=0;assert.deepEqual(b.bytes,csv);
  const cached=await service.downloadOriginal(q);assert.deepEqual(cached.bytes,csv);assert.equal(calls,2);assert.equal(cached.metadata.cacheHit,true);
});

test('quota exhaustion or malformed quota blocks the file request and never becomes an empty file',async()=>{
  for(const response of [quota(0),new Response('{"quotaLeft":"unknown"}',{headers:{'content-type':'application/json'}})]){
    let calls=0;await assert.rejects(create({fetch:async()=>{calls++;return response;}}).downloadOriginal(q),e=>['PROVIDER_DOWNLOAD_QUOTA_EXHAUSTED','PROVIDER_DOWNLOAD_QUOTA_INVALID'].includes(e.code));assert.equal(calls,1);
  }
  await assert.rejects(create({fetch:async()=>new Response(JSON.stringify({quotaLeft:0,expires:Date.parse('2026-11-03T00:00:00Z')}))}).downloadOriginal(q),e=>e.code==='PROVIDER_DOWNLOAD_QUOTA_EXHAUSTED'&&e.quotaResetsAt==='2026-11-03T00:00:00.000Z');
});

test('KML uses the same provider handler without rewriting the original XML',async()=>{
  const original=Buffer.from('<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document/></kml>');
  const result=await create({fetch:async url=>new URL(url).pathname.includes('check-quota')?quota(3):new Response(original,{headers:{'content-type':'application/vnd.google-earth.kml+xml'}})}).downloadOriginal({...q,format:'kml'});
  assert.deepEqual(result.bytes,original);assert.equal(result.metadata.format,'kml');assert.equal(result.metadata.complete,false);
});

test('explicit browser interaction requirements and upstream failures stay sanitized without automatic retries',async()=>{
  await assert.rejects(create({fetch:async()=>{throw Object.assign(Error('private-cookie'),{code:'INTERACTION_REQUIRED'});}}).downloadOriginal(q),e=>e.code==='INTERACTION_REQUIRED'&&!e.message.includes('private-cookie'));
  await assert.rejects(create({fetch:async()=>new Response('private-session-body',{status:403})}).downloadOriginal(q),e=>e.code==='HTTP_403'&&!e.message.includes('private-session'));
  let calls=0;await assert.rejects(create({fetch:async()=>{calls++;throw Error('private-token');}}).downloadOriginal(q),e=>e.code==='PROVIDER_DOWNLOAD_NETWORK_FAILED'&&!e.message.includes('private-token'));assert.equal(calls,1);
});

test('known browser transport failures retain safe codes and the quota/file phase without leaking details',async()=>{
  for(const code of ['BROWSER_INVALID_RESPONSE','BROWSER_REQUEST_INVALID','BROWSER_TIMEOUT','BROWSER_RESPONSE_TOO_LARGE','BROWSER_FETCH_FAILED']){
    await assert.rejects(create({fetch:async()=>{throw Object.assign(Error('private-cookie-in-transport-error'),{code});}}).downloadOriginal(q),e=>e.code===code&&e.requestPhase==='quota_check'&&!e.message.includes('private-cookie'));
  }
  let calls=0;
  await assert.rejects(create({fetch:async()=>{calls++;if(calls===1)return quota(2);throw Object.assign(Error('private-file-request'),{code:'BROWSER_INVALID_RESPONSE'});}}).downloadOriginal(q),e=>e.code==='BROWSER_INVALID_RESPONSE'&&e.requestPhase==='file_download'&&e.quotaConsumptionMayHaveOccurred===true&&!e.message.includes('private-file'));
  assert.equal(calls,2);
});

test('invalid inputs, HTML disguised as a file and oversize responses fail closed',async()=>{
  let calls=0;const instance=create({fetch:async()=>{calls++;return quota(1);}});
  for(const bad of [{flightId:'../account'},{format:'exe'},{historyTimestamp:0},{historyTimestamp:'1793552700'},{unexpected:true}])await assert.rejects(instance.downloadOriginal({...q,...bad}),e=>e.code==='PROVIDER_DOWNLOAD_INPUT_INVALID');assert.equal(calls,0);
  for(const body of ['<html>private-access-denial</html>','x'.repeat(4*1024*1024+1)])await assert.rejects(create({fetch:async url=>new URL(url).pathname.includes('check-quota')?quota(1):new Response(body,{headers:{'content-type':'text/csv'}})}).downloadOriginal(q),e=>e.code==='PROVIDER_DOWNLOAD_FILE_INVALID');
});
