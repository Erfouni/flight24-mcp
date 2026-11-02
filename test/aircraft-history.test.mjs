import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,copyFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const api = await import('../aircraft-history.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
const available = typeof api.getAircraftHistory === 'function';
const now = () => Date.UTC(2026, 10, 2, 10);
const options = body => ({now, fetchImpl: async () => new Response(JSON.stringify(body), {headers: {'content-type':'application/json'}})});
const historyRow = {
  identification:{id:'42657bb4',number:{default:'VRH5917'},callsign:'VRH5917'},
  aircraft:{registration:'EP-VAK',hex:'73582B',model:{code:'B733',text:'Boeing 737-301'}},
  airline:{name:'Varesh Airlines'}, airport:{origin:{name:'Origin',code:{iata:'PGU',icao:'OIBP'}},destination:{name:'Destination',code:{iata:'THR',icao:'OIII'}}},
  status:{text:'Landed',live:false}, time:{scheduled:{departure:1793601000,arrival:1793606400},real:{departure:1793601677,arrival:1793607048},estimated:{arrival:null},other:{updated:1793607085}},
};
const historyBody = rows => ({result:{response:{timestamp:1793610000,page:{current:1,more:true},item:{total:null},data:rows}}});

test('before excludes recent provider rows when the provider ignores its timestamp anchor',async()=>{
  const result=await api.getAircraftHistory('EP-VAK',5,{...options(historyBody([historyRow])),before:'2026-10-15T00:00:00Z'});
  assert.equal(result.httpStatus,200);assert.equal(result.status,'date_boundary_not_honored');
  assert.equal(result.requestedBeforeHonored,false);assert.deepEqual(result.flights,[]);
  assert.equal(result.coverage.providerReturned,1);assert.equal(result.coverage.excludedAtOrAfterBefore,1);
  assert.equal(result.coverage.complete,false);assert.ok(result.nextCursor);
});

test('history filters before by source history timestamp and takes next cursor from the entire provider page',async()=>{
  const dated=(id,date)=>({...structuredClone(historyRow),identification:{...historyRow.identification,id},time:{scheduled:{departure:Date.parse(date)/1000}}});
  const rows=[dated('a1','2026-11-02T00:00:00Z'),dated('a2','2026-10-14T00:00:00Z'),dated('a3','2026-10-13T00:00:00Z')];
  const result=await api.getAircraftHistory('EP-VAK',1,{...options(historyBody(rows)),before:'2026-10-15T00:00:00Z'});
  assert.equal(result.status,'partial');assert.equal(result.requestedBeforeHonored,false);
  assert.deepEqual(result.flights.map(row=>row.flightId),['a2']);
  assert.equal(result.coverage.providerReturned,3);assert.equal(result.coverage.matchingBefore,2);
  assert.deepEqual(result.nextCursor,{page:2,before:'2026-10-12T23:59:00.000Z',olderThenFlightId:'a3'});
});

test('history cannot establish a before date for records with no source timestamp',async()=>{
  const unknown={...structuredClone(historyRow),time:{}};
  const result=await api.getAircraftHistory('EP-VAK',1,{...options(historyBody([unknown])),before:'2026-10-15T00:00:00Z'});
  assert.equal(result.status,'date_boundary_unverified');assert.equal(result.requestedBeforeHonored,null);
  assert.deepEqual(result.flights,[]);assert.equal(result.coverage.excludedUnknownTimestamp,1);assert.equal(result.nextCursor,null);
});

test('aircraft history module exposes lookup, history and trajectory operations', () => {
  for (const name of ['searchAircraft','getAircraftHistory','getAircraftTrack']) assert.equal(typeof api[name], 'function', name);
});

test('aircraft history loads bundled source settings when runtime settings are absent',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'fr24-history-fixture-'));
  try{
    for(const file of ['aircraft-history.mjs','session.mjs','bundled-settings.json'])await copyFile(new URL('../'+file,import.meta.url),join(directory,file));
    const fallback=await import(pathToFileURL(join(directory,'aircraft-history.mjs')).href);
    let url;
    await fallback.getAircraftHistory('EP-VAK',1,{...options(historyBody([historyRow])),fetchImpl:async value=>{url=new URL(value);return new Response(JSON.stringify(historyBody([historyRow])));}});
    assert.equal(url.hostname,'api.flightradar24.com');assert.equal(url.pathname,'/common/v1/flight/list.json');
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('registration history preserves real/scheduled time distinctions and paginated coverage', {skip:!available}, async () => {
  let requested;
  const result = await api.getAircraftHistory('ep-vak', 5, {...options(historyBody([historyRow])),fetchImpl:async(url,init)=>{
    requested = new URL(url); assert.equal(init.redirect,'error'); assert.ok(init.signal);
    assert.equal(init.headers.authorization,undefined); return new Response(JSON.stringify(historyBody([historyRow])));
  }});
  assert.equal(requested.pathname,'/common/v2/flight/list.json');
  assert.equal(requested.searchParams.get('query'),'EP-VAK'); assert.equal(requested.searchParams.get('fetchBy'),'reg');
  assert.equal(requested.searchParams.get('page'),'1'); assert.equal(requested.searchParams.get('limit'),'5');
  assert.equal(requested.searchParams.has('token'),false);
  assert.equal(result.status,'ok'); assert.equal(result.flights[0].flightId,'42657bb4');
  assert.equal(result.flights[0].times.actualDeparture,new Date(1793601677*1000).toISOString());
  assert.notEqual(result.flights[0].times.actualDeparture,result.flights[0].times.scheduledDeparture);
  assert.equal(result.flights[0].times.estimatedArrival,null);
  assert.equal(result.coverage.moreAvailable,true); assert.equal(result.coverage.complete,false);
  assert.equal(result.flights[0].origin.latitude,undefined);
});

test('history rejects a provider response for a different aircraft and does not invent flight identifiers', {skip:!available}, async () => {
  const mismatch = structuredClone(historyRow); mismatch.aircraft.registration='G-TEST';
  const result = await api.getAircraftHistory('EP-VAK', 5, options(historyBody([mismatch])));
  assert.equal(result.status,'invalid_response'); assert.deepEqual(result.flights,[]);
});

test('HTTP blocks and unauthenticated responses remain explicit outcomes', {skip:!available}, async () => {
  for (const [httpStatus,status] of [[403,'blocked'],[401,'unauthenticated'],[429,'rate_limited']]) {
    const result = await api.searchAircraft('EP-VAK',{now,fetchImpl:async()=>new Response('<html>blocked</html>',{status:httpStatus})});
    assert.equal(result.status,status); assert.equal(result.httpStatus,httpStatus); assert.deepEqual(result.aircraft,[]);
  }
});

test('playback returns measured samples in time order, reports gaps and excludes null/invalid coordinates', {skip:!available}, async () => {
  const flight = {identification:{id:'42657bb4',callsign:'VRH5917'},aircraft:{identification:{registration:'EP-VAK',modes:'73582B'}},track:[
    {latitude:28,longitude:52,timestamp:1793602600,altitude:{feet:24000},speed:{kts:388},heading:339},
    {latitude:27.4,longitude:52.6,timestamp:1793601800,altitude:{feet:4000},speed:{kts:230}},
    {latitude:null,longitude:50,timestamp:1793601810},
    {latitude:91,longitude:50,timestamp:1793601820},
    {latitude:27.4,longitude:52.6,timestamp:1793601800},
  ]};
  const result = await api.getAircraftTrack('42657bb4',options({result:{response:{timestamp:1793610000,data:{flight}}}}));
  assert.equal(result.status,'partial'); assert.equal(result.points.length,2);
  assert.equal(result.points[0].latitude,27.4); assert.equal(result.points[1].speedKnots,388);
  assert.equal(result.points[0].reportedAt,new Date(1793601800*1000).toISOString());
  assert.equal(result.coverage.invalidPointCount,2); assert.equal(result.coverage.duplicatePointCount,1);
  assert.equal(result.coverage.gaps[0].durationSeconds,800); assert.equal(result.coverage.complete,false);
  assert.equal(result.coverage.pointCount,2);
});

test('playback identity mismatch and missing track never become fabricated paths', {skip:!available}, async () => {
  const mismatch = await api.getAircraftTrack('42657bb4',options({result:{response:{data:{flight:{identification:{id:'bad12345'},track:[]}}}}}));
  assert.equal(mismatch.status,'invalid_response'); assert.deepEqual(mismatch.points,[]);
  const empty = await api.getAircraftTrack('42657bb4',options({result:{response:{data:{flight:{identification:{id:'42657bb4'},track:[]}}}}}));
  assert.equal(empty.status,'unavailable'); assert.equal(empty.coverage.complete,false);
});

test('bounds, allowlists and response limits are enforced before unsafe data can escape', {skip:!available}, async () => {
  let calls=0; const fetchImpl=async()=>{calls++;return new Response('{}');};
  await assert.rejects(api.getAircraftHistory('../bad',5,{fetchImpl}),/registration/i);
  await assert.rejects(api.getAircraftHistory('EP-VAK',101,{fetchImpl}),/limit/i);
  await assert.rejects(api.getAircraftTrack('https://example.com',{fetchImpl}),/flight/i);
  await assert.rejects(api.getAircraftHistory('EP-VAK',5,{fetchImpl,settings:{urls:{feed:{history:'example.com/common/v2/flight/list.json'}}}}),/endpoint/i);
  assert.equal(calls,0);
  const huge = await api.getAircraftHistory('EP-VAK',5,{now,fetchImpl:async()=>new Response('{}',{headers:{'content-length':'5000000'}})});
  assert.equal(huge.status,'invalid_response'); assert.deepEqual(huge.flights,[]);
});

test('an explicit historical anchor and page change the provider query without falsifying retrieval time', {skip:!available}, async () => {
  const before='2026-10-01T00:00:00Z';let requested;
  const result=await api.getAircraftHistory('EP-VAK',5,{now,before,page:3,fetchImpl:async url=>{
    requested=new URL(url);return new Response(JSON.stringify(historyBody([historyRow])));
  }});
  assert.equal(requested.searchParams.get('timestamp'),String(Date.parse(before)/1000));
  assert.equal(requested.searchParams.get('page'),'3');
  assert.equal(result.retrievedAt,new Date(now()).toISOString());
  assert.equal(result.requestedBefore,'2026-10-01T00:00:00.000Z');
  assert.equal(result.queryAnchorAt,'2026-10-01T00:00:00.000Z');
  assert.equal(result.coverage.page,3);assert.equal(result.coverage.providerPage,1);
  assert.equal(result.coverage.complete,false);
});

test('invalid history anchors and unbounded pages fail before any request', {skip:!available}, async () => {
  let calls=0;const fetchImpl=async()=>{calls++;return new Response('{}');};
  for(const page of [0,51,1.5,'2'])await assert.rejects(api.getAircraftHistory('EP-VAK',5,{page,fetchImpl}),/page/i);
  for(const before of ['yesterday','2026-10-01',123,'2026-02-30T00:00:00Z'])await assert.rejects(api.getAircraftHistory('EP-VAK',5,{before,fetchImpl}),/before|timestamp/i);
  assert.equal(calls,0);
});

test('authenticated legacy history attaches only the supplied private keys and source cursor without exposing them', {skip:!available},async()=>{
  const historyAuth={subscriptionKey:'fixture-private-subscription',publicKey:'fixture-private-publickey'};let requested;
  const result=await api.getAircraftHistory('EP-VAK',5,{now,page:2,before:'2026-10-01T00:00:00Z',olderThenFlightId:'42657bb4',historyAuth,
    settings:{urls:{feed:{history:'api.flightradar24.com/common/v1/flight/list.json'}}},
    fetchImpl:async url=>{requested=new URL(url);return new Response(JSON.stringify(historyBody([historyRow])));}});
  assert.equal(requested.hostname,'api.flightradar24.com');assert.equal(requested.searchParams.get('token'),historyAuth.subscriptionKey);
  assert.equal(requested.searchParams.get('pk'),historyAuth.publicKey);assert.equal(requested.searchParams.get('olderThenFlightId'),'42657bb4');
  assert.equal(result.authenticated,true);assert.equal(result.authenticationBasis,'request_keys_supplied');
  assert.ok(!JSON.stringify(result).includes('fixture-private'));assert.equal(new URL(result.endpoint).search,'');
});

test('authenticated playback uses the same source key pair and sanitizes transport failures', {skip:!available},async()=>{
  const historyAuth={subscriptionKey:'fixture-private-subscription',publicKey:'fixture-private-publickey'};let requested;
  const result=await api.getAircraftTrack('42657bb4',{now,historyAuth,fetchImpl:async url=>{requested=new URL(url);throw new Error('sensitive URL '+url);}});
  assert.equal(requested.searchParams.get('token'),historyAuth.subscriptionKey);assert.equal(requested.searchParams.get('pk'),historyAuth.publicKey);
  assert.equal(result.status,'network_error');assert.equal(result.authenticated,true);assert.ok(!JSON.stringify(result).includes('fixture-private'));
});

test('the observed web history token is valid with an explicitly empty public key', {skip:!available},async()=>{
  let requested;
  const result=await api.getAircraftHistory('EP-VAK',5,{now,historyAuth:{subscriptionKey:'fixture-private-webtoken',publicKey:''},settings:{urls:{feed:{history:'api.flightradar24.com/common/v1/flight/list.json'}}},fetchImpl:async url=>{requested=new URL(url);return new Response(JSON.stringify(historyBody([])));}});
  assert.equal(requested.searchParams.get('token'),'fixture-private-webtoken');assert.equal(requested.searchParams.has('pk'),true);assert.equal(requested.searchParams.get('pk'),'');
  assert.equal(result.authenticated,true);assert.equal(result.authenticationBasis,'request_keys_supplied');assert.ok(!JSON.stringify(result).includes('fixture-private'));
});

test('malformed private key pairs or history cursors fail before network access', {skip:!available},async()=>{
  let calls=0;const fetchImpl=async()=>{calls++;return new Response('{}');};
  for(const historyAuth of [{subscriptionKey:'one'}, {subscriptionKey:'bad\nvalue',publicKey:'two'},null]){
    await assert.rejects(api.getAircraftHistory('EP-VAK',5,{historyAuth,fetchImpl}),/history.*auth|key/i);
  }
  await assert.rejects(api.getAircraftHistory('EP-VAK',5,{olderThenFlightId:'not/a/flight',fetchImpl}),/cursor|flight/i);
  assert.equal(calls,0);
});

test('observed legacy cookie requests permit empty query keys and never expose or replay anti-bot cookies', {skip:!available},async()=>{
  let request;
  const result=await api.getAircraftHistory('EP-VAK',5,{now,historyAuth:{subscriptionKey:'',publicKey:''},authHeaders:{cookie:'FR24SID=fixture-private-session; cf_clearance=fixture-private-antibot','user-agent':'fixture Chrome agent'},settings:{urls:{feed:{history:'api.flightradar24.com/common/v1/flight/list.json'}}},fetchImpl:async(url,init)=>{request={url:new URL(url),init};return new Response(JSON.stringify(historyBody([])));}});
  assert.equal(request.init.headers.cookie,'FR24SID=fixture-private-session');assert.equal(request.init.headers['user-agent'],'fixture Chrome agent');
  assert.equal(result.authenticated,true);assert.equal(result.authenticationBasis,'account_cookies_supplied');
  assert.ok(!JSON.stringify(result).includes('fixture-private'));
  let calls=0;const fetchImpl=async()=>{calls++;return new Response('{}');};
  for(const authHeaders of [{cookie:'FR24SID=bad\nvalue'},{cookie:'cf_clearance=value'},{cookie:'FR24SID=value',authorization:'bad'}]){
    await assert.rejects(api.getAircraftHistory('EP-VAK',5,{authHeaders,fetchImpl,settings:{urls:{feed:{history:'api.flightradar24.com/common/v1/flight/list.json'}}}}),/auth|header|cookie/i);
  }
  await assert.rejects(api.getAircraftHistory('EP-VAK',5,{authHeaders:{cookie:'FR24SID=fixture-private'},fetchImpl}),/legacy|origin|header|cookie/i);
  assert.equal(calls,0);
});
