import test from 'node:test';
import assert from 'node:assert/strict';
const mod=await import('../regional-airport-events.mjs').catch(()=>({}));
const airports=[{id:2,iata:'TWO',icao:'KTWO',name:'Second',timezone:'America/New_York',timezoneValid:true},{id:1,iata:'ONE',icao:'OMON',name:'First',timezone:'Asia/Dubai',timezoneValid:true}];
const resolved={airports,count:2,selection:{mode:'airports'},catalog:{airportUpdatedAt:'2026-01-01'},source:'fixture source catalog'};
const q={selection:{airports:['ONE','TWO']},fromDate:'2026-10-01',toDate:'2026-10-02'};
const row=(extra={})=>({flightId:'one',eventType:'landed',eventTime:'2026-10-01T12:00:00Z',eventAirportId:1,registration:'A6-FIX',serviceCategory:null,...extra});
const reply=records=>({source:'Flightradar24 signed-in airport event history',records,complete:false,coverage:{sourceResponseDayComplete:false,rowsTruncated:false}});
function service(read,resolve=()=>resolved){assert.equal(typeof mod.RegionalAirportEventsService,'function');return new mod.RegionalAirportEventsService({airportEvents:{getAirportEvents:read},resolveAirports:resolve});}

test('regional event plan is airport-ID/date ordered and forwards each source IANA timezone',async()=>{
  const calls=[];
  const result=await service(async args=>{calls.push(args);return reply([]);}).getRegionalAirportEvents({...q,maxRequests:3});
  assert.deepEqual(calls.map(c=>[c.airportId,c.date,c.timezone]),[[1,'2026-10-01','Asia/Dubai'],[1,'2026-10-02','Asia/Dubai'],[2,'2026-10-01','America/New_York']]);
  assert.equal(result.scope,'airport_events');
  assert.equal(result.coverage.plannedRequestCount,4);assert.equal(result.coverage.completedRequestCount,3);assert.equal(result.coverage.unqueriedRequestCount,1);assert.equal(result.nextOffset,3);
  const tail=await service(async()=>reply([])).getRegionalAirportEvents({...q,requestOffset:3});
  assert.equal(tail.coverage.attemptedRequestCount,1);assert.equal(tail.nextOffset,null);assert.equal(tail.requests[0].date,'2026-10-02');
});

test('duplicate actual events collapse across responses while separate events and aircraft remain distinct',async()=>{
  const result=await service(async({airportId,date})=>reply(airportId===1?[row({eventTime:date+'T12:00:00Z'}),row({eventTime:date+'T12:00:00Z'}),row({eventTime:date+'T12:01:00Z'})]:[])).getRegionalAirportEvents({...q,maxRequests:4});
  assert.equal(result.observedEventCount,4);assert.equal(result.distinctKnownFlightIds,1);assert.equal(result.uniqueObservedRegistrations,1);
  assert.equal(result.coverage.duplicateRecords,2);assert.equal(result.unknownCargoClassificationCount,4);
  assert.equal(result.exactCount,null);assert.equal(result.exactCargoArrivalCount,null);assert.equal(result.complete,false);
});

test('event reads run serially and no more than twelve requests run per call',async()=>{
  let active=0,peak=0,calls=0;
  const result=await service(async()=>{calls++;active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,4));active--;return reply([]);}).getRegionalAirportEvents({...q,toDate:'2026-10-10',maxRequests:12});
  assert.equal(peak,1);assert.equal(calls,12);assert.equal(result.coverage.plannedRequestCount,20);assert.equal(result.nextOffset,12);
});

test('429 stops the window immediately and checkpoints the first failed request with safe retry metadata',async()=>{
  let calls=0;
  const result=await service(async()=>{calls++;if(calls===2)throw Object.assign(Error('secret'),{code:'HTTP_429',retryAt:'2026-11-02T13:00:00.000Z',retryAfterSeconds:120});return reply([row()]);}).getRegionalAirportEvents({...q,maxRequests:4});
  assert.equal(calls,2);assert.equal(result.nextOffset,1);assert.equal(result.retryAt,'2026-11-02T13:00:00.000Z');assert.equal(result.retryAfterSeconds,120);
  assert.equal(result.coverage.attemptedRequestCount,2);assert.equal(result.coverage.unqueriedRequestCount,2);
  assert.equal(result.coverage.remainingRequestsAfterWindow,3);assert.deepEqual(result.unqueriedRequests.map(r=>r.requestIndex),[2,3]);
  assert.equal(result.failures[0].requestIndex,1);assert.equal(result.exactCargoArrivalCount,null);
});

test('all failures preserve the unprocessed checkpoint and interaction requirements are not erased',async()=>{
  const result=await service(async()=>{throw Object.assign(Error('secret'),{code:'INTERACTION_REQUIRED'});}).getRegionalAirportEvents({...q,maxRequests:4});
  assert.equal(result.nextOffset,0);assert.equal(result.coverage.attemptedRequestCount,1);assert.equal(result.failures[0].code,'INTERACTION_REQUIRED');
  assert.equal(result.unqueriedRequests.length,3);assert.ok(!JSON.stringify(result).includes('secret'));
});

test('planning validates and pins a deterministic airport selection without fetching provider data',()=>{
  const instance=service(()=>{throw Error('no request allowed');});
  const plan=instance.describeRegionalAirportEvents(q);
  assert.equal(plan.plannedRequestCount,4);assert.deepEqual(plan.query.selection,{airports:[1,2]});
  assert.equal(plan.query.eventType,'landed');assert.equal(plan.catalog.airportUpdatedAt,'2026-01-01');
});

test('per-request failures are sanitized and complete failure or an empty offset window produces unknown counts',async()=>{
  const result=await service(async({airportId})=>{if(airportId===2)throw Object.assign(Error('private-session'),{code:'HTTP_403'});return reply([row()]);}).getRegionalAirportEvents({...q,toDate:q.fromDate});
  assert.equal(result.status,'partial');assert.equal(result.observedEventCount,1);assert.equal(result.coverage.failedRequestCount,1);assert.equal(result.failures[0].code,'HTTP_403');assert.ok(!JSON.stringify(result).includes('private-session'));
  const failed=await service(async()=>{throw Object.assign(Error('secret'),{code:'SECRET_ACCESS_TOKEN'});}).getRegionalAirportEvents(q);
  assert.equal(failed.status,'unavailable');assert.equal(failed.observedEventCount,null);assert.equal(failed.uniqueObservedRegistrations,null);assert.equal(failed.failures[0].code,'SOURCE_FAILED');
  const empty=await service(async()=>{throw Error('must not call');}).getRegionalAirportEvents({...q,requestOffset:50});assert.equal(empty.status,'no_requests_in_window');assert.equal(empty.observedEventCount,null);
});

test('invalid dates, selections and unbounded windows reject before event reads',async()=>{
  let calls=0;const instance=service(async()=>{calls++;return reply([]);});
  for(const bad of [{fromDate:'2026-02-30'},{fromDate:'2026-10-03'},{toDate:'2026-11-01'},{eventType:'cargo'},{maxRequests:13},{maxRequests:0},{requestOffset:-1},{unexpected:true}])await assert.rejects(instance.getRegionalAirportEvents({...q,...bad}),e=>e.code==='REGIONAL_AIRPORT_EVENTS_INPUT_INVALID');
  assert.equal(calls,0);
});

test('missing source timezones and mismatched event identity cannot silently produce valid regional events',async()=>{
  const unknownZone=await service(async()=>{throw Error('must not call');},()=>({...resolved,airports:[{...airports[0],timezone:'invalid/zone'}],count:1})).getRegionalAirportEvents(q);
  assert.equal(unknownZone.status,'unavailable');assert.equal(unknownZone.failures[0].code,'AIRPORT_TIMEZONE_UNAVAILABLE');
  const mismatch=await service(async()=>reply([row({eventAirportId:999})])).getRegionalAirportEvents({...q,toDate:q.fromDate});
  assert.equal(mismatch.status,'unavailable');assert.equal(mismatch.failures[0].code,'AIRPORT_EVENTS_BAD_RESPONSE');
});

test('country and geometry selectors resolve actual catalog destinations through the shared resolver',async()=>{
  const instance=new mod.RegionalAirportEventsService({airportEvents:{getAirportEvents:async()=>reply([])}});
  const country=await instance.getRegionalAirportEvents({...q,selection:{country:'AE'}});
  assert.ok(country.coverage.selectedAirportCount>1);assert.equal(country.selection.mode,'country');
  for(const selection of [{bbox:[55.34,25.24,55.39,25.27]},{polygon:{type:'Polygon',coordinates:[[[55.34,25.24],[55.39,25.24],[55.39,25.27],[55.34,25.27],[55.34,25.24]]]}}]){
    const result=await instance.getRegionalAirportEvents({...q,selection});
    assert.equal(result.coverage.selectedAirportCount,1);assert.equal(result.requests[0].airport.iata,'DXB');assert.equal(result.requests[0].airport.timezone,'Asia/Dubai');
  }
});
