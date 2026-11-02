import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const api=await import('../chromium-transport.mjs').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error;});
const ready=typeof api.createChromiumFetch==='function';
const ROOT='https://www.flightradar24.com';
const URL=ROOT+'/api/v1/airport-history/916?date=2026-10-01&eventType=landed';
function fixture({nativeFetch=async()=>new Response('{"data":[]}',{headers:{'content-type':'application/json'}}),interaction=false,launchError=false,states=[]}={}){
  const seen={launches:0,navigations:[],cookies:[],nativeCalls:[],closed:0,inspections:0};
  const page={goto:async url=>{seen.navigations.push(url);return {status:()=>200};},url:()=>ROOT+'/',close:async()=>{},evaluate:async(fn,arg)=>{
    if(!arg?.url){seen.inspectionFunction=fn;const state=states[Math.min(seen.inspections,states.length-1)];seen.inspections++;return {origin:ROOT,interactionRequired:interaction,signInRequired:false,appReady:true,challengeLoading:false,...state};}
    seen.nativeCalls.push(arg);
    const execute=runInNewContext('('+fn.toString()+')',{fetch:nativeFetch,AbortController,TextDecoder,Uint8Array,setTimeout,clearTimeout,location:{origin:ROOT},btoa:value=>Buffer.from(value,'binary').toString('base64')});
    return execute(arg);
  }};
  const launchImpl=async(directory,options)=>{seen.launches++;seen.directory=directory;seen.launchOptions=options;if(launchError)throw Error('fixture-private-launch-error');return {addCookies:async cookies=>seen.cookies.push(...cookies),newPage:async()=>page,close:async()=>{seen.closed++;}};};
  return {seen,launchImpl,page,userDataDir:join(tmpdir(),'fr24-service-test-profile')};
}
test('standard Chromium fetch factory is available',()=>assert.equal(typeof api.createChromiumFetch,'function'));
test('uses a dedicated standard persistent browser and native same-origin fetch without manual cookies or spoofed browser headers',{skip:!ready},async()=>{
  let nativeRequest;
  const f=fixture({nativeFetch:async(url,options)=>{nativeRequest={url,options};return new Response('{"records":[1]}',{status:200,headers:{'content-type':'application/json','set-cookie':'fixture-private-response'}});}});
  const transport=await api.createChromiumFetch({...f,loadSession:async()=>({origin:ROOT,cookieHeader:'FR24SID=fixture-private-session; cf_clearance=fixture-private-antibot'})});
  const response=await transport(URL,{headers:{accessToken:'fixture-private-access','User-Agent':'not browser','Cookie':'cf_clearance=not-replayed',Referer:ROOT+'/'},redirect:'error'});
  assert.ok(response instanceof Response);assert.deepEqual(await response.json(),{records:[1]});
  assert.equal(f.seen.launches,1);assert.equal(f.seen.launchOptions.headless,true);assert.equal(f.seen.launchOptions.args,undefined);assert.equal(f.seen.launchOptions.ignoreHTTPSErrors,false);
  assert.equal(f.seen.cookies.length,1);assert.equal(f.seen.cookies[0].name,'FR24SID');assert.equal(f.seen.cookies[0].url,ROOT+'/');
  assert.equal(nativeRequest.options.credentials,'same-origin');assert.equal(nativeRequest.options.redirect,'error');
  assert.equal(nativeRequest.options.headers.accesstoken,'fixture-private-access');assert.equal(nativeRequest.options.headers.cookie,undefined);assert.equal(nativeRequest.options.headers['user-agent'],undefined);assert.equal(nativeRequest.options.headers.referer,undefined);
  assert.equal(response.headers.get('set-cookie'),null);assert.ok(!JSON.stringify(transport.getStatus()).includes('fixture-private'));
  await transport.close();assert.equal(f.seen.closed,1);
});
test('only fixed observed provider paths can receive private requests and invalid calls never launch a browser',{skip:!ready},async()=>{
  const f=fixture();const transport=await api.createChromiumFetch(f);
  for(const url of ['https://example.com/api/v1/airport-history/916','http://www.flightradar24.com/api/v1/airport-history/916',ROOT+'/api/v1/arbitrary',ROOT+'/api/v1/airport-history/916?redirect=https://example.com'])await assert.rejects(transport(url),e=>e.code==='BROWSER_REQUEST_INVALID');
  await assert.rejects(transport(URL,{method:'POST',body:'private'}),e=>e.code==='BROWSER_REQUEST_INVALID');
  await assert.rejects(transport('https://api.flightradar24.com/common/v1/flight/list.json?query=EP-VAK',{headers:{accessToken:'fixture-private-access'}}),e=>e.code==='BROWSER_REQUEST_INVALID');
  assert.equal(f.seen.launches,0);await transport.close();
});
test('challenge responses fail closed with INTERACTION_REQUIRED and are never returned as JSON or automatically retried',{skip:!ready},async()=>{
  const f=fixture({nativeFetch:async()=>new Response('<html><title>Just a moment...</title>Verify you are human fixture-private</html>',{status:403,headers:{'content-type':'text/html'}})});
  const transport=await api.createChromiumFetch(f);
  for(let i=0;i<2;i++)await assert.rejects(transport(URL),e=>e.code==='INTERACTION_REQUIRED'&&!e.message.includes('fixture-private'));
  assert.equal(f.seen.nativeCalls.length,1);assert.equal(transport.getStatus().interactionRequired,true);await transport.close();
});

test('native fetch accepts valid quota JSON mislabeled text/html while preserving its original bytes and MIME',{skip:!ready},async()=>{
  const body='{"expires":1793696400,"quotaLeft":23}';
  const f=fixture({nativeFetch:async()=>new Response(body,{headers:{'content-type':'text/html; charset=utf-8'}})});
  const transport=await api.createChromiumFetch(f);
  const response=await transport(ROOT+'/download/check-quota?flight=42657bb4');
  assert.equal(response.status,200);assert.equal(await response.text(),body);
  assert.match(response.headers.get('content-type'),/text\/html/);assert.equal(f.seen.nativeCalls.length,1);
  await transport.close();
});

test('wrong-MIME tolerance still rejects actual HTML and recognizes JSON verification errors',{skip:!ready},async()=>{
  for(const [body,status,code]of [
    ['<html><title>Account sign in</title><body>Sign in</body></html>',200,'BROWSER_INVALID_RESPONSE'],
    ['<html><title>Just a moment</title>Verify you are human</html>',200,'INTERACTION_REQUIRED'],
    ['{"error":{"code":"challenge_required"}}',403,'INTERACTION_REQUIRED'],
  ]){
    const f=fixture({nativeFetch:async()=>new Response(body,{status,headers:{'content-type':'text/html'}})});
    const transport=await api.createChromiumFetch(f);
    await assert.rejects(transport(ROOT+'/download/check-quota?flight=42657bb4'),e=>e.code===code);
    assert.equal(f.seen.nativeCalls.length,1);await transport.close();
  }
});
test('preflight human verification prevents private API requests',{skip:!ready},async()=>{
  const f=fixture({interaction:true});const transport=await api.createChromiumFetch(f);
  await assert.rejects(transport(URL),e=>e.code==='INTERACTION_REQUIRED');assert.equal(f.seen.nativeCalls.length,0);await transport.close();
});
test('native response streams are bounded to four MiB and do not forward response secrets',{skip:!ready},async()=>{
  let canceled=false;
  const f=fixture({nativeFetch:async()=>new Response(new ReadableStream({pull(c){c.enqueue(new Uint8Array(1100000));},cancel(){canceled=true;}}),{headers:{'content-type':'application/json'}})});
  const transport=await api.createChromiumFetch(f);await assert.rejects(transport(URL),e=>e.code==='BROWSER_RESPONSE_TOO_LARGE');assert.equal(canceled,true);await transport.close();
});
test('cross-origin legacy history uses browser CORS and query authentication without inventing cookies or mutating the URL',{skip:!ready},async()=>{
  const f=fixture();const transport=await api.createChromiumFetch(f);
  const url='https://api.flightradar24.com/common/v1/flight/list.json?query=EP-VAK&fetchBy=reg&page=2&limit=10&token=fixture-private-token&pk=&timestamp=1790812800&olderThenFlightId=42657bb4';
  const response=await transport(url);assert.equal(response.status,200);assert.equal(f.seen.nativeCalls[0].url,url);assert.equal(f.seen.nativeCalls[0].headers.cookie,undefined);
  assert.ok(!JSON.stringify(transport.getStatus()).includes('fixture-private'));await transport.close();
});
test('browser launch and network exceptions do not expose credential-bearing arguments',{skip:!ready},async()=>{
  const launch=fixture({launchError:true});const unavailable=await api.createChromiumFetch(launch);
  await assert.rejects(unavailable(URL),e=>e.code==='BROWSER_UNAVAILABLE'&&!e.message.includes('fixture-private'));await unavailable.close();
  const net=fixture({nativeFetch:async()=>{throw Error('fixture-private-token-in-error');}});const transport=await api.createChromiumFetch(net);
  await assert.rejects(transport(URL),e=>e.code==='BROWSER_FETCH_FAILED'&&!e.message.includes('fixture-private'));await transport.close();
});

test('an independent Node deadline bounds an unresponsive page evaluation',{skip:!ready,timeout:2000},async()=>{
  const f=fixture({nativeFetch:async()=>new Promise(()=>{})});
  const transport=await api.createChromiumFetch({...f,requestTimeoutMs:20});
  await assert.rejects(transport(URL),e=>e.code==='BROWSER_TIMEOUT');await transport.close();
});
test('closing during launch prevents later page navigation and releases the newly created context',{skip:!ready},async()=>{
  const f=fixture();let started,release;
  const entered=new Promise(r=>started=r),gate=new Promise(r=>release=r);
  const transport=await api.createChromiumFetch({...f,launchImpl:async(...args)=>{started();await gate;return f.launchImpl(...args);}});
  const pending=transport(URL);await entered;await transport.close();release();
  await assert.rejects(pending,e=>e.code==='BROWSER_CLOSED');assert.equal(f.seen.closed,1);assert.equal(f.seen.navigations.length,0);
});
test('observed original quota and download paths preserve provider bytes and safe filename metadata',{skip:!ready},async()=>{
  const bytes=new Uint8Array([0,255,1,10]);
  const f=fixture({nativeFetch:async url=>url.includes('check-quota')?new Response('{"quotaLeft":24}',{headers:{'content-type':'application/json'}}):new Response(bytes,{headers:{'content-type':'application/vnd.google-earth.kml+xml','content-disposition':'attachment; filename="flight.kml"'}})});
  const transport=await api.createChromiumFetch(f);
  const quota=await transport(ROOT+'/download/check-quota?flight=42657bb4',{headers:{'X-Fetch':'true','Content-Type':'application/json;charset=utf-8'}});
  assert.equal((await quota.json()).quotaLeft,24);assert.equal(f.seen.nativeCalls[0].headers['x-fetch'],'true');
  const response=await transport(ROOT+'/download/?flight=42657bb4&file=kml&trailLimit=0&history=1793601677');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()),bytes);assert.equal(response.headers.get('content-disposition'),'attachment; filename="flight.kml"');
  await transport.close();
});

test('ordinary automatic page verification may settle to the app without a second navigation or API retry',{skip:!ready},async()=>{
  const f=fixture({states:[{challengeLoading:true,appReady:false},{challengeLoading:false,appReady:true}]});
  const transport=await api.createChromiumFetch({...f,settleTimeoutMs:1000});
  const response=await transport(URL);assert.equal(response.status,200);assert.ok(f.seen.inspections>=2);
  assert.equal(f.seen.navigations.length,1);assert.equal(f.seen.nativeCalls.length,1);assert.equal(transport.getStatus().pageState,'ready');
  assert.equal(transport.getStatus().interactionRequired,false);await transport.close();
});
test('persistent automatic verification has a bounded wait and a distinct safe interaction reason',{skip:!ready,timeout:2000},async()=>{
  const f=fixture({states:[{challengeLoading:true,appReady:false}]});
  const transport=await api.createChromiumFetch({...f,settleTimeoutMs:30});
  await assert.rejects(transport(URL),e=>e.code==='INTERACTION_REQUIRED');
  assert.equal(f.seen.navigations.length,1);assert.equal(f.seen.nativeCalls.length,0);assert.equal(transport.getStatus().interactionReason,'challenge_timeout');
  await transport.close();
});
test('manual verification, sign-in and origin changes expose separate enums without waiting for automatic completion',{skip:!ready},async()=>{
  for(const [state,reason]of [[{interactionRequired:true},'visible_challenge'],[{signInRequired:true},'sign_in_required'],[{origin:'https://example.com'},'origin_changed']]){
    const f=fixture({states:[state]});const transport=await api.createChromiumFetch({...f,settleTimeoutMs:1000});
    await assert.rejects(transport(URL),e=>e.code==='INTERACTION_REQUIRED');assert.equal(transport.getStatus().interactionReason,reason);
    assert.equal(f.seen.inspections,1);assert.equal(f.seen.nativeCalls.length,0);assert.ok(!JSON.stringify(transport.getStatus()).includes('example.com'));await transport.close();
  }
});
test('the actual page predicate distinguishes a loading title from an explicit visible checkbox',{skip:!ready},async()=>{
  const f=fixture();const transport=await api.createChromiumFetch(f);await transport(URL);
  const inspect=(title,body,checkbox=false)=>runInNewContext('('+f.seen.inspectionFunction.toString()+')',{location:{origin:ROOT},document:{title,body:{innerText:body},querySelectorAll:selector=>checkbox&&selector.includes('input[type="checkbox"]')?[{getClientRects:()=>[{}]}]:[]}})();
  const loading=inspect('Just a moment...','Verifying you are human. This may take a few seconds.');
  assert.equal(loading.challengeLoading,true);assert.equal(loading.interactionRequired,false);assert.equal(loading.appReady,false);
  const manual=inspect('Security verification','Verify you are human by checking the checkbox',true);assert.equal(manual.interactionRequired,true);
  await transport.close();
});

test('loopback CDP reuses the already verified provider page and disconnects without changing its profile or closing user Chrome',{skip:!ready},async()=>{
  const f=fixture();let connects=0,disconnects=0,contextCloses=0,pageCloses=0,newPages=0,cookieSeeds=0,loads=0;
  f.page.close=async()=>{pageCloses++;};
  const context={pages:()=>[f.page],newPage:async()=>{newPages++;return f.page;},addCookies:async()=>{cookieSeeds++;},close:async()=>{contextCloses++;}};
  const transport=await api.createChromiumFetch({cdpEndpoint:'http://127.0.0.1:9227',loadSession:async()=>{loads++;throw Error('must not overwrite attached profile');},connectImpl:async(endpoint,options)=>{connects++;assert.equal(endpoint,'http://127.0.0.1:9227/');assert.equal(options.noDefaults,true);return {contexts:()=>[context],close:async()=>{disconnects++;}};}});
  assert.equal((await transport(URL)).status,200);assert.equal(connects,1);assert.equal(newPages,0);assert.equal(f.seen.navigations.length,0);assert.equal(loads,0);assert.equal(cookieSeeds,0);
  assert.equal(transport.getStatus().connectionMode,'loopback_cdp');await transport.close();
  assert.equal(disconnects,1);assert.equal(contextCloses,0);assert.equal(pageCloses,0);
});

test('CDP configuration rejects non-loopback endpoints and challenge handoff preserves the user browser',{skip:!ready},async()=>{
  for(const endpoint of ['http://example.com:9227','https://127.0.0.1:9227','http://127.0.0.1:9227/proxy','http://user:password@127.0.0.1:9227','http://127.0.0.1:9227/?target=other'])await assert.rejects(api.createChromiumFetch({cdpEndpoint:endpoint}),e=>e.code==='BROWSER_CONFIG_INVALID');
  const f=fixture({interaction:true});let disconnected=0,contextClosed=0;
  const transport=await api.createChromiumFetch({cdpEndpoint:'http://127.0.0.1:9227',connectImpl:async()=>({contexts:()=>[{pages:()=>[f.page],close:async()=>{contextClosed++;}}],close:async()=>{disconnected++;}})});
  await assert.rejects(transport(URL),e=>e.code==='INTERACTION_REQUIRED');assert.equal(disconnected,1);assert.equal(contextClosed,0);assert.equal(f.seen.nativeCalls.length,0);
  await transport.close();assert.equal(disconnected,1);
});

test('an inspection timeout after automatic-verification state is reported as a human handoff rather than a generic timeout',{skip:!ready,timeout:2000},async()=>{
  const f=fixture({states:[{challengeLoading:true,appReady:false}]});const original=f.page.evaluate;
  f.page.evaluate=async(fn,arg)=>{if(!arg?.url&&f.seen.inspections>=1)return new Promise(()=>{});return original(fn,arg);};
  const transport=await api.createChromiumFetch({...f,settleTimeoutMs:30,navigationTimeoutMs:30});
  await assert.rejects(transport(URL),e=>e.code==='INTERACTION_REQUIRED');assert.equal(transport.getStatus().interactionReason,'challenge_timeout');assert.equal(f.seen.nativeCalls.length,0);await transport.close();
});
