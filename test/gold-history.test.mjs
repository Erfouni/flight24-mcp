import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WebGoldSession} from '../web-gold-session.mjs';
const api=await import('../gold-history.mjs').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error;});
const ready=typeof api.GoldHistoryService==='function';
test('authenticated history service can be configured with a private key loader',()=>assert.equal(typeof api.GoldHistoryService,'function'));
test('wrapper loads keys privately and preserves history paging on the observed legacy route',{skip:!ready},async()=>{
  let loaded=0,request;
  const service=new api.GoldHistoryService({loadKeys:async()=>{loaded++;return {subscriptionKey:'fixture-private-token',publicKey:'fixture-private-pk'};},now:()=>Date.parse('2026-11-02T12:00:00Z'),fetchImpl:async url=>{
    request=new URL(url);return new Response(JSON.stringify({result:{response:{timestamp:1793620800,page:{current:2,more:false},data:[]}}}));
  }});
  const result=await service.getAircraftHistory('EP-VAK',5,{before:'2026-10-01T00:00:00Z',page:2,olderThenFlightId:'42657bb4'});
  assert.equal(loaded,1);assert.equal(request.origin+request.pathname,'https://api.flightradar24.com/common/v1/flight/list.json');
  assert.equal(request.searchParams.get('token'),'fixture-private-token');assert.equal(request.searchParams.get('pk'),'fixture-private-pk');
  assert.equal(request.searchParams.get('olderThenFlightId'),'42657bb4');assert.equal(request.searchParams.get('page'),'2');
  assert.equal(result.requestedBefore,'2026-10-01T00:00:00.000Z');assert.equal(result.authenticated,true);
  assert.ok(!JSON.stringify(result).includes('fixture-private'));assert.ok(!JSON.stringify(service).includes('fixture-private'));
});
test('wrapper sanitizes key loader errors and prevents callers redirecting private-key requests',{skip:!ready},async()=>{
  const service=new api.GoldHistoryService({loadKeys:async()=>{throw Error('fixture-private-secret');}});
  await assert.rejects(service.getAircraftHistory('EP-VAK'),error=>error.code==='HISTORY_AUTH_UNAVAILABLE'&&!error.message.includes('fixture-private'));
  await assert.rejects(service.getAircraftHistory('EP-VAK',5,{settings:{}}),/option/i);
});

test('validated web sessions privately supply account headers without serializing credentials',()=>{
  const session=new WebGoldSession({session:{kind:'fr24-web-session',origin:'https://www.flightradar24.com',capturedAt:'2026-11-02T12:00:00Z',cookieHeader:'FR24SID=fixture-private-cookie; cf_clearance=fixture-antibot',userAgent:'fixture Chrome',passwordStored:false},clock:()=>Date.parse('2026-11-02T12:00:00Z')});
  assert.equal(typeof session.getHistoryRequestHeaders,'function');
  const headers=session.getHistoryRequestHeaders();assert.equal(headers.cookie,'FR24SID=fixture-private-cookie');assert.equal(headers['user-agent'],'fixture Chrome');
  assert.ok(!JSON.stringify(session).includes('fixture-private'));assert.ok(!headers.cookie.includes('cf_clearance'));
});

test('explicit server session loading enables cookie-only legacy history with no query key fabrication',{skip:!ready},async t=>{
  assert.equal(typeof api.loadGoldHistoryService,'function');
  const directory=await mkdtemp(join(tmpdir(),'fr24-history-fixture-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const path=join(directory,'session.json');
  await writeFile(path,JSON.stringify({kind:'fr24-web-session',origin:'https://www.flightradar24.com',capturedAt:'2026-11-02T12:00:00Z',cookieHeader:'FR24SID=fixture-private-cookie',userAgent:'fixture Chrome',passwordStored:false}));
  let request;
  const service=await api.loadGoldHistoryService({jsonPath:path},{now:()=>Date.parse('2026-11-02T12:00:00Z'),fetchImpl:async(url,init)=>{request={url:new URL(url),init};return new Response(JSON.stringify({result:{response:{data:[]}}}));}});
  const result=await service.getAircraftHistory('EP-VAK',5);
  assert.equal(request.url.hostname,'api.flightradar24.com');assert.equal(request.init.headers.cookie,'FR24SID=fixture-private-cookie');
  assert.equal(request.init.redirect,'error');assert.equal(request.url.searchParams.has('token'),false);assert.equal(request.url.searchParams.has('pk'),false);
  assert.equal(result.authenticated,true);assert.equal(result.authenticationBasis,'account_cookies_supplied');assert.equal(result.serverEntitlementVerified,false);
  assert.ok(!JSON.stringify(result).includes('fixture-private'));
});

test('a captured history key file plus web User-Agent reproduces fixed browser origin headers without unobserved cookies',{skip:!ready},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'fr24-history-keys-fixture-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const keysPath=join(directory,'keys.json'),sessionPath=join(directory,'session.json');
  await writeFile(keysPath,JSON.stringify({kind:'fr24-history-keys',sourceEndpoint:'https://api.flightradar24.com/common/v1/flight/list.json',capturedAt:'2026-11-02T12:00:00Z',subscriptionKey:'fixture-private-webtoken',publicKey:'',observedQuery:{fetchBy:'reg',query:'EP-VAK'}}));
  await writeFile(sessionPath,JSON.stringify({kind:'fr24-web-session',origin:'https://www.flightradar24.com',capturedAt:'2026-11-02T12:00:00Z',cookieHeader:'FR24SID=fixture-private-cookie',userAgent:'fixture Chrome',passwordStored:false}));
  let request;
  const service=await api.loadGoldHistoryService({keysJsonPath:keysPath,jsonPath:sessionPath},{now:()=>Date.parse('2026-11-02T12:00:00Z'),fetchImpl:async(url,init)=>{request={url:new URL(url),init};return new Response(JSON.stringify({result:{response:{data:[]}}}));}});
  const result=await service.getAircraftHistory('EP-VAK',5);
  assert.equal(request.url.searchParams.get('token'),'fixture-private-webtoken');assert.equal(request.url.searchParams.get('pk'),'');
  assert.equal(request.init.headers['user-agent'],'fixture Chrome');assert.equal(request.init.headers.origin,'https://www.flightradar24.com');assert.equal(request.init.headers.referer,'https://www.flightradar24.com/');
  assert.equal(request.init.headers.cookie,undefined);assert.equal(result.authenticationBasis,'request_keys_supplied');
  assert.ok(!JSON.stringify(result).includes('fixture-private'));
});

test('history key stores validate the exact capture origin and never fall back from failed DPAPI to plaintext',{skip:!ready},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'fr24-key-validation-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const path=join(directory,'keys.dat');
  const envelope={kind:'fr24-history-keys',sourceEndpoint:'https://api.flightradar24.com/common/v1/flight/list.json',capturedAt:'2026-11-02T12:00:00Z',subscriptionKey:'fixture-private-token',publicKey:''};
  await writeFile(path,JSON.stringify(envelope));
  const now=()=>Date.parse('2026-11-02T12:00:00Z');
  await assert.rejects(api.loadHistoryKeys({dpapiPath:path},{now,decrypt:async()=>{throw Error('fixture-private-error');}}),e=>e.code==='HISTORY_AUTH_UNAVAILABLE'&&!e.message.includes('fixture-private'));
  const keys=await api.loadHistoryKeys({dpapiPath:path},{now,decrypt:async raw=>raw});
  assert.equal(keys.subscriptionKey,'fixture-private-token');assert.equal(keys.publicKey,'');
  await writeFile(path,JSON.stringify({...envelope,sourceEndpoint:'https://example.com/common/v1/flight/list.json'}));
  await assert.rejects(api.loadHistoryKeys({jsonPath:path},{now}),e=>e.code==='HISTORY_AUTH_UNAVAILABLE');
});

test('runtime history selection uses the APK endpoint and key pair once without replaying browser headers or retrying legacy',{skip:!ready},async()=>{
  let calls=0,request;
  const service=new api.GoldHistoryService({historyEndpointVersion:'runtime',loadKeys:async()=>({subscriptionKey:'fixture-private-token',publicKey:''}),loadAuthHeaders:async()=>{throw Error('browser headers must not be read for runtime protocol');},fetchImpl:async(url,init)=>{calls++;request={url:new URL(url),init};return new Response('blocked',{status:403});}});
  const result=await service.getAircraftHistory('EP-VAK',5);
  assert.equal(calls,1);assert.equal(request.url.origin+request.url.pathname,'https://mobile.flightradar24.com/common/v2/flight/list.json');
  assert.equal(request.url.searchParams.get('token'),'fixture-private-token');assert.equal(request.url.searchParams.get('pk'),'');
  assert.equal(request.init.headers.cookie,undefined);assert.equal(request.init.headers.origin,undefined);assert.equal(request.init.headers.referer,undefined);
  assert.equal(result.status,'blocked');assert.equal(result.serverEntitlementVerified,false);
});
