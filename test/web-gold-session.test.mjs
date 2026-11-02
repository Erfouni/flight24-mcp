import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inspect} from 'node:util';
const mod=await import('../web-gold-session.mjs').catch(()=>({}));
const fixture={kind:'fr24-web-session',origin:'https://www.flightradar24.com',capturedAt:'2026-11-02T10:00:00Z',cookieHeader:'FR24SID=fixture-session-secret; PHPSESSID=fixture-php-secret; _frr=fixture-refresh-secret',userAgent:'Fixture Browser/1.0',entitlementObserved:{gold:true,historyDays:365},passwordStored:false};
const now=()=>Date.parse('2026-11-02T12:00:00Z');
const create=(session=fixture,fetch=async()=>new Response('blocked-private-body',{status:403}))=>{assert.equal(typeof mod.WebGoldSession,'function');return new mod.WebGoldSession({session,fetch,clock:now});};

test('web session holds credentials privately and distinguishes observed browser entitlement from server validation',()=>{
  const session=create();
  const serialized=JSON.stringify(session),debug=inspect(session);
  for(const secret of ['fixture-session-secret','fixture-refresh-secret','Fixture Browser']){assert.ok(!serialized.includes(secret));assert.ok(!debug.includes(secret));}
  assert.equal(session.getStatus().configured,true);
  assert.equal(session.getStatus().serverEntitlementVerified,false);
  assert.equal(session.getStatus().authenticatedHistoryVerified,false);
  assert.equal(session.getStatus().passwordStored,false);
});

test('exact-origin SSR probe sends only approved FR24 cookies and never replays anti-bot cookies',async()=>{
  let request;
  const session=create({...fixture,cookieHeader:fixture.cookieHeader+'; cf_clearance=fixture-antibot-secret; __cf_bm=fixture-antibot-two'},async(url,options)=>{request={url,options};return new Response('private-block-body',{status:403,headers:{'content-type':'text/html'}});});
  const result=await session.probeAircraftHistory('EP-VAK');
  assert.equal(request.url,'https://www.flightradar24.com/data/aircraft/ep-vak');
  assert.equal(request.options.redirect,'error');assert.equal(request.options.headers.cookie,fixture.cookieHeader);
  assert.equal(request.options.headers['user-agent'],fixture.userAgent);
  assert.ok(!JSON.stringify(request.options).includes('fixture-antibot'));
  assert.equal(result.status,'blocked');assert.equal(result.httpStatus,403);
  assert.equal(result.serverEntitlementVerified,false);assert.ok(!JSON.stringify(result).includes('private-block-body'));
});

test('200 HTML without verified schema is diagnostic only and cannot become authenticated history records',async()=>{
  const result=await create(fixture,async()=>new Response('<html><body>365<table><tr data-flight-id="fixture"></tr></table></body></html>',{headers:{'content-type':'text/html'}})).probeAircraftHistory('ep-vak');
  assert.equal(result.status,'html_received_unparsed');assert.equal(result.htmlContains365,true);assert.equal(result.flightRowMarkerCount,1);
  assert.equal(result.authenticatedHistoryVerified,false);assert.equal(result.complete,false);
  assert.ok(!Object.hasOwn(result,'html'));assert.ok(!Object.hasOwn(result,'records'));
});

test('network, redirect and response parsing errors are bounded and redact underlying request details',async()=>{
  const result=await create(fixture,async()=>{throw Error('cookie=fixture-session-secret');}).probeAircraftHistory('EP-VAK');
  assert.equal(result.status,'network_error');assert.ok(!JSON.stringify(result).includes('fixture-session-secret'));
  const oversized=await create(fixture,async()=>new Response('x'.repeat(4*1024*1024+1),{headers:{'content-type':'text/html'}})).probeAircraftHistory('EP-VAK');
  assert.equal(oversized.status,'invalid_response');
});

test('invalid envelope, duplicate session cookies and header injection are rejected without exposing values',async()=>{
  for(const bad of [{origin:'https://evil.example'},{passwordStored:true},{capturedAt:'2026-02-30T00:00:00Z'},{cookieHeader:'cf_clearance=private-value'},{cookieHeader:'FR24SID=secret\r\nx-evil: 1'},{cookieHeader:'FR24SID=one; FR24SID=two'},{userAgent:'private\r\nheader'}])assert.throws(()=>create({...fixture,...bad}),e=>e.code==='WEB_SESSION_INVALID'&&!e.message.includes('private'));
  await assert.rejects(create().probeAircraftHistory('../account'),e=>e.code==='WEB_SESSION_INPUT_INVALID');
});

test('explicit server JSON and local current-user DPAPI stores remain separate with no implicit fallback',async()=>{
  assert.equal(typeof mod.loadWebGoldSession,'function');
  const directory=await mkdtemp(join(tmpdir(),'fr24-web-session-test-'));
  try{
    const jsonPath=join(directory,'session.json'),dpapiPath=join(directory,'session.dpapi');
    await writeFile(jsonPath,JSON.stringify(fixture));await writeFile(dpapiPath,'encrypted-fixture');
    const server=await mod.loadWebGoldSession({jsonPath},{clock:now});assert.equal(server.getStatus().storage,'explicit_server_json');
    let decrypted=false;
    const local=await mod.loadWebGoldSession({dpapiPath},{clock:now,decrypt:async input=>{assert.equal(input,'encrypted-fixture');decrypted=true;return JSON.stringify(fixture);}});
    assert.equal(decrypted,true);assert.equal(local.getStatus().storage,'current_user_dpapi');
    for(const config of [{},{jsonPath,dpapiPath},{jsonPath:join(directory,'absent')}])await assert.rejects(mod.loadWebGoldSession(config),e=>e.code.startsWith('WEB_SESSION_')&&!e.message.includes(directory));
    await writeFile(jsonPath,'x'.repeat(128*1024+1));await assert.rejects(mod.loadWebGoldSession({jsonPath}),e=>e.code==='WEB_SESSION_STORE_FAILED');
    await assert.rejects(mod.loadWebGoldSession({dpapiPath},{decrypt:async()=>{throw Error('private-plaintext');}}),e=>e.code==='WEB_SESSION_STORE_FAILED'&&!e.message.includes('private-plaintext'));
  }finally{await rm(directory,{recursive:true,force:true});}
});
