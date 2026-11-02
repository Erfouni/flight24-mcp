import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir,readFile,mkdir,symlink,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const mod=await import('../airport-events.mjs').catch(()=>({}));
const q={airportId:916,date:'2026-10-01',eventType:'landed',timezone:'Asia/Dubai'};
const session={origin:'https://www.flightradar24.com',accessToken:'fixture-private-access',userAgent:'Fixture Browser/1.0'};
const row=(extra={})=>({type:'landed',time:1790884583,flightId:'fixture-flight-one',originId:571,destinationId:916,runway:null,airlineId:176,aircraftType:'B77W',registration:'A6-FIX',callsign:'FIX148',flightNumber:'FX148',available:['runway'],live:false,...extra});
const response=data=>new Response(JSON.stringify({data}),{headers:{'content-type':'application/json'}});
const create=options=>{assert.equal(typeof mod.AirportEventsService,'function');return new mod.AirportEventsService({loadSession:async()=>session,...options});};

test('airport events use the observed same-origin route, date string and raw accessToken header',async()=>{
  let request;
  const service=create({fetch:async(url,options)=>{request={url:new URL(url),options};return response([row()]);}});
  const result=await service.getAirportEvents(q);
  assert.equal(request.url.origin,'https://www.flightradar24.com');assert.equal(request.url.pathname,'/api/v1/airport-history/916');
  assert.deepEqual(Object.fromEntries(request.url.searchParams),{date:'2026-10-01',eventType:'landed'});
  assert.equal(request.options.headers.accessToken,session.accessToken);assert.equal(request.options.redirect,'error');assert.ok(!Object.hasOwn(request.options.headers,'authorization'));
  assert.equal(result.records[0].eventTime,'2026-10-01T19:56:23.000Z');assert.equal(result.records[0].actualArrival,result.records[0].eventTime);
  assert.equal(result.observedEventCount,1);assert.equal(result.complete,false);assert.equal(result.exactCount,null);assert.equal(result.exactCargoArrivalCount,null);
  assert.ok(!JSON.stringify(result).includes(session.accessToken));assert.ok(!JSON.stringify(service).includes(session.accessToken));
});

test('a local airport day retains unscheduled unknown-destination events and deduplicates identical flight event records',async()=>{
  const result=await create({fetch:async()=>response([row(),row(),row({flightId:'unknown-destination',time:1790798509,destinationId:null})])}).getAirportEvents(q);
  assert.equal(result.observedEventCount,2);assert.equal(result.coverage.duplicateRecords,1);assert.equal(result.coverage.routeDestinationUnknownCount,1);
  assert.equal(result.records[0].eventTime,'2026-09-30T20:01:49.000Z');
  assert.equal(result.records[0].eventAirportId,916);assert.equal(result.records[0].destinationId,null);
  assert.equal(result.unknownCargoClassificationCount,2);assert.equal(result.cargoClassificationAvailable,false);
});

test('takeoff event mapping preserves the departure timestamp without inventing an arrival',async()=>{
  const result=await create({fetch:async()=>response([row({type:'takeoff',originId:916,destinationId:571})])}).getAirportEvents({...q,eventType:'takeoff'});
  assert.equal(result.records[0].actualDeparture,'2026-10-01T19:56:23.000Z');assert.equal(result.records[0].actualArrival,null);
});

test('schema mismatches, wrong local day and inconsistent event identity fail closed',async()=>{
  for(const data of [[row({type:'takeoff'})],[row({time:0})],[row({time:Date.parse('2026-10-02T01:00:00Z')/1000})],[row({flightId:null})],null])await assert.rejects(create({fetch:async()=>response(data)}).getAirportEvents(q),e=>e.code==='AIRPORT_EVENTS_BAD_RESPONSE');
  const wrongType=create({fetch:async()=>new Response('private-cookie-body',{headers:{'content-type':'text/html'}})});
  await assert.rejects(wrongType.getAirportEvents(q),e=>e.code==='AIRPORT_EVENTS_BAD_RESPONSE'&&!e.message.includes('private'));
});

test('missing/invalid sessions and upstream denials remain explicit, sanitized failures',async()=>{
  await assert.rejects(new mod.AirportEventsService().getAirportEvents(q),e=>e.code==='AIRPORT_EVENTS_NOT_CONFIGURED');
  for(const loadSession of [async()=>{throw Error('private-secret');},async()=>({...session,origin:'https://evil.example'}),async()=>({...session,accessToken:'private\r\ninjected'})])await assert.rejects(create({loadSession}).getAirportEvents(q),e=>e.code==='AIRPORT_EVENTS_SESSION_INVALID'&&!e.message.includes('private'));
  await assert.rejects(create({fetch:async()=>new Response('private-token-body',{status:403})}).getAirportEvents(q),e=>e.code==='HTTP_403'&&!e.message.includes('private'));
  await assert.rejects(create({fetch:async()=>{throw Error('private-token');}}).getAirportEvents(q),e=>e.code==='AIRPORT_EVENTS_NETWORK_FAILED'&&!e.message.includes('private'));
});

test('input and response sizes are bounded before use and do not silently truncate history',async()=>{
  let calls=0;const service=create({fetch:async()=>{calls++;return response([]);}});
  for(const bad of [{airportId:'916/evil'},{date:'2026-02-30'},{eventType:'arrivals'},{timezone:'invented/timezone'},{extra:true}])await assert.rejects(service.getAirportEvents({...q,...bad}),e=>e.code==='AIRPORT_EVENTS_INPUT_INVALID');
  assert.equal(calls,0);
  await assert.rejects(create({fetch:async()=>response(Array(20001).fill(row()))}).getAirportEvents(q),e=>e.code==='AIRPORT_EVENTS_BAD_RESPONSE');
  await assert.rejects(create({fetch:async()=>new Response('x'.repeat(4*1024*1024+1),{headers:{'content-type':'application/json'}})}).getAirportEvents(q),e=>e.code==='AIRPORT_EVENTS_BAD_RESPONSE');
});

test('concurrent identical reads coalesce and historical cache preserves retrieval time and isolated results',async()=>{
  let now=Date.parse('2026-11-02T12:00:00Z'),calls=0;
  const service=create({clock:()=>now,fetch:async()=>{calls++;return response([row()]);}});
  const [a,b]=await Promise.all([service.getAirportEvents(q),service.getAirportEvents(q)]);
  assert.equal(calls,1);a.records[0].registration='changed';assert.equal(b.records[0].registration,'A6-FIX');
  now+=2*86400000;const cached=await service.getAirportEvents(q);
  assert.equal(calls,1);assert.equal(cached.retrievedAt,b.retrievedAt);assert.equal(cached.cache.hit,true);assert.equal(cached.cache.ttlSeconds,7*86400);
});

test('one shared serial queue spaces different network reads without concurrent calls',async()=>{
  let now=Date.parse('2026-11-02T12:00:00Z'),active=0,peak=0;const starts=[],sleeps=[];
  const service=create({clock:()=>now,sleep:async ms=>{sleeps.push(ms);now+=ms;},minIntervalMs:1000,fetch:async()=>{starts.push(now);active++;peak=Math.max(peak,active);await Promise.resolve();active--;return response([]);}});
  await Promise.all([916,917,918].map(airportId=>service.getAirportEvents({...q,airportId})));
  assert.equal(peak,1);assert.deepEqual(starts,[Date.parse('2026-11-02T12:00:00Z'),Date.parse('2026-11-02T12:00:01Z'),Date.parse('2026-11-02T12:00:02Z')]);assert.deepEqual(sleeps,[1000,1000]);
});

test('distinct pending requests are bounded while cache hits and singleflight remain available',async()=>{
  let release,entered,calls=0;const gate=new Promise(resolve=>release=resolve),active=new Promise(resolve=>entered=resolve);
  const service=create({maxQueuedRequests:2,minIntervalMs:0,fetch:async url=>{calls++;if(new URL(url).pathname.endsWith('/919'))return response([]);entered();await gate;return response([]);}});
  await service.getAirportEvents({...q,airportId:919});
  const first=service.getAirportEvents(q);await active;
  const second=service.getAirportEvents({...q,airportId:917});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(service.getStatus().pendingRequests,2);
  await assert.rejects(service.getAirportEvents({...q,airportId:918}),e=>e.code==='AIRPORT_EVENTS_QUEUE_FULL');
  const duplicate=service.getAirportEvents(q),cached=await service.getAirportEvents({...q,airportId:919});assert.equal(cached.cache.hit,true);
  release();await Promise.all([first,second,duplicate]);assert.equal(calls,3);
});

test('429 Retry-After seconds pauses queued requests without retry and valid cache remains available',async()=>{
  let now=Date.parse('2026-11-02T12:00:00Z'),calls=0;
  const service=create({clock:()=>now,minIntervalMs:0,fetch:async()=>{calls++;return calls===1?response([row()]):new Response('private-rate-limit-body',{status:429,headers:{'retry-after':'120'}});}});
  const cached=await service.getAirportEvents(q);
  const results=await Promise.allSettled([917,918,919].map(airportId=>service.getAirportEvents({...q,airportId})));
  assert.equal(calls,2);
  for(const result of results){assert.equal(result.status,'rejected');assert.equal(result.reason.code,'HTTP_429');assert.equal(result.reason.retryAt,'2026-11-02T12:02:00.000Z');assert.equal(result.reason.retryAfterSeconds,120);assert.ok(!result.reason.message.includes('private'));}
  now+=1000;const hit=await service.getAirportEvents(q);assert.equal(hit.retrievedAt,cached.retrievedAt);assert.equal(hit.cache.hit,true);assert.equal(calls,2);assert.equal(service.getStatus().cooldownActive,true);
});

test('HTTP-date Retry-After and missing header have safe cooldown timestamps',async()=>{
  const now=Date.parse('2026-11-02T12:00:00Z');
  for(const [header,seconds]of [['Mon, 02 Nov 2026 12:03:00 GMT',180],[null,60],['-1',60],['not-a-date',60]]){
    const service=create({clock:()=>now,fetch:async()=>new Response('rate limited',{status:429,headers:header?{'retry-after':header}:{}})});
    await assert.rejects(service.getAirportEvents(q),e=>e.code==='HTTP_429'&&e.retryAfterSeconds===seconds&&e.retryAt===new Date(now+seconds*1000).toISOString());
  }
});

test('durable cache refuses oversized files and symbolic-link entries before provider requests',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'fr24-airport-file-bounds-'));
  try{
    const keyFile='airport-events-'+'a'.repeat(64)+'.json';await writeFile(join(directory,keyFile),'x'.repeat(8*1024*1024+1));
    await assert.rejects(create({cacheDir:directory,fetch:async()=>{throw Error('network must not run');}}).getAirportEvents(q),e=>e.code==='AIRPORT_EVENTS_CACHE_UNSAFE');
    await rm(join(directory,keyFile));const target=join(directory,'target');await mkdir(target);await symlink(target,join(directory,keyFile),'junction');
    await assert.rejects(create({cacheDir:directory,fetch:async()=>{throw Error('network must not run');}}).getAirportEvents(q),e=>e.code==='AIRPORT_EVENTS_CACHE_UNSAFE');
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('durable public-data cache and cooldown survive service restarts without storing account headers',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'fr24-airport-cache-'));let now=Date.parse('2026-11-02T12:00:00Z'),calls=0;
  try{
    const options={cacheDir:directory,clock:()=>now,minIntervalMs:0,fetch:async()=>{calls++;return calls===1?response([row()]):new Response('private-body',{status:429,headers:{'retry-after':'90'}});}};
    const first=create(options);const value=await first.getAirportEvents(q);await assert.rejects(first.getAirportEvents({...q,airportId:917}),e=>e.code==='HTTP_429');
    const restarted=create(options);const hit=await restarted.getAirportEvents(q);assert.equal(hit.retrievedAt,value.retrievedAt);assert.equal(hit.cache.storage,'disk');assert.equal(calls,2);
    await assert.rejects(restarted.getAirportEvents({...q,airportId:918}),e=>e.code==='HTTP_429'&&e.retryAfterSeconds===90);assert.equal(calls,2);
    const stored=(await Promise.all((await readdir(directory)).map(file=>readFile(join(directory,file),'utf8')))).join('');assert.ok(!stored.includes(session.accessToken));assert.ok(!stored.includes(session.userAgent));assert.ok(!stored.includes('private-body'));
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('recent-day cache expires after sixty seconds and unsafe cache directories fail before network',async()=>{
  let now=Date.parse('2026-11-02T12:00:00Z'),calls=0;const service=create({clock:()=>now,minIntervalMs:0,fetch:async()=>{calls++;return response([]);}});
  const recent={...q,date:'2026-11-02'};await service.getAirportEvents(recent);now+=59000;await service.getAirportEvents(recent);assert.equal(calls,1);now+=2000;await service.getAirportEvents(recent);assert.equal(calls,2);
  const directory=await mkdtemp(join(tmpdir(),'fr24-airport-link-'));
  try{await mkdir(join(directory,'target'));await symlink(join(directory,'target'),join(directory,'linked'),'junction');await assert.rejects(create({cacheDir:join(directory,'linked'),fetch:async()=>{throw Error('network must not run');}}).getAirportEvents(q),e=>e.code==='AIRPORT_EVENTS_CACHE_UNSAFE');}finally{await rm(directory,{recursive:true,force:true});}
});
