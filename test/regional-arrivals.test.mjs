import test from 'node:test';
import assert from 'node:assert/strict';
const mod=await import('../regional-arrivals.mjs').catch(()=>({}));
const interval={from:'2026-10-01T00:00:00Z',to:'2026-11-01T00:00:00Z'};
const q={selection:{airports:['DXB','DWC']},...interval};
const record=(flightId,destination='DXB',registration='A6-TEST',extra={})=>({flightId,sourceRowId:1,registration,destination:{iata:destination},actualArrival:'2026-10-15T12:00:00Z',serviceCategory:null,...extra});
const board=records=>({records,coverage:{pagesFetched:1,stopReason:'short_board_page'}});
function service(read){assert.equal(typeof mod.RegionalArrivalsService,'function');return new mod.RegionalArrivalsService({airportHistory:{getAirportArrivals:read},clock:()=>Date.parse('2026-11-02T00:00:00Z')});}

test('regional arrivals deduplicate flight legs across airports, keep aircraft counts separate and never invent cargo',async()=>{
  const result=await service(async()=>board([record('one'),record('two','DWC'),record('two','DWC')])).getRegionalArrivals(q);
  assert.equal(result.observedFlightLegCount,2);
  assert.equal(result.uniqueObservedRegistrations,1);
  assert.equal(result.unknownCargoClassificationCount,2);
  assert.equal(result.exactCargoArrivalCount,null);
  assert.equal(result.exactCount,null);assert.equal(result.complete,false);
  assert.equal(result.coverage.duplicateRecords,4);
});

test('regional arrivals enforce actual timestamp half-open interval and selected destination membership',async()=>{
  const result=await service(async()=>board([
    record('start','DXB','A6-1',{actualArrival:interval.from}),
    record('end','DXB','A6-2',{actualArrival:interval.to}),
    record('outside','LHR'),record('invalid','DXB',null,{actualArrival:'2026-02-30T00:00:00Z'}),
    record('before','DXB',null,{actualArrival:'2026-09-30T23:59:59Z'})
  ])).getRegionalArrivals({...q,maxAirports:1});
  assert.deepEqual(result.records.map(r=>r.flightId),['start']);
  assert.equal(result.excluded.outsideInterval,2);assert.equal(result.excluded.destinationOutsideSelection,1);assert.equal(result.excluded.invalidActualArrival,1);
});

test('country, bbox and polygon scopes use the shared catalog and bounded offset windows',async()=>{
  const read=async()=>board([]);
  const country=await service(read).getRegionalArrivals({selection:{country:'AE'},...interval,maxAirports:1,airportOffset:1,maxPages:3});
  assert.equal(country.coverage.queriedAirportCount,1);assert.ok(country.coverage.selectedAirportCount>1);
  assert.equal(country.coverage.unqueriedAirportCount,country.coverage.selectedAirportCount-1);
  assert.equal(country.airportOffset,1);assert.equal(country.maxPages,3);
  for(const selection of [{bbox:[55.34,25.24,55.39,25.27]},{polygon:{type:'Polygon',coordinates:[[[55.34,25.24],[55.39,25.24],[55.39,25.27],[55.34,25.27],[55.34,25.24]]]}}]){
    const result=await service(read).getRegionalArrivals({selection,...interval});
    assert.ok(result.airports.some(a=>a.iata==='DXB'));
  }
});

test('no more than three airport reads run concurrently and the airport/page caps are forwarded',async()=>{
  let active=0,peak=0,calls=0;
  const result=await service(async args=>{calls++;active++;peak=Math.max(peak,active);assert.equal(args.maxPages,2);await new Promise(resolve=>setTimeout(resolve,5));active--;return board([]);}).getRegionalArrivals({selection:{airports:['DXB','DWC','AUH','SHJ','LHR']},...interval,maxAirports:4,maxPages:2});
  assert.equal(calls,4);assert.equal(peak,3);assert.equal(result.coverage.unqueriedAirportCount,1);
});

test('partial failures are sanitized and all failed reads never report zero arrivals',async()=>{
  const partial=await service(async({airport})=>{if(airport==='DWC')throw Object.assign(Error('secret-token-value'),{code:'HTTP_401'});return board([record('one')]);}).getRegionalArrivals(q);
  assert.equal(partial.status,'partial');assert.equal(partial.coverage.failedAirportCount,1);assert.equal(partial.observedFlightLegCount,1);
  assert.equal(partial.failures[0].code,'HTTP_401');assert.ok(!JSON.stringify(partial).includes('secret-token-value'));
  const failed=await service(async()=>{throw Object.assign(Error('private-value'),{code:'PRIVATE_VALUE_IS_SECRET'});}).getRegionalArrivals(q);
  assert.equal(failed.status,'unavailable');assert.equal(failed.observedFlightLegCount,null);assert.equal(failed.uniqueObservedRegistrations,null);
  assert.equal(failed.failures[0].code,'SOURCE_FAILED');assert.ok(!JSON.stringify(failed).includes('PRIVATE_VALUE'));
});

test('missing flight IDs use per-airport fallback identities and do not imply exact unique legs',async()=>{
  const result=await service(async({airport})=>board([record(null,airport,null),record(null,airport,null)])).getRegionalArrivals(q);
  assert.equal(result.records.length,2);assert.equal(result.coverage.fallbackIdentityRecordCount,2);
  assert.equal(result.distinctKnownFlightIds,0);assert.equal(result.complete,false);assert.equal(result.exactCount,null);
});

test('invalid and unbounded regional requests are rejected before airport reads',async()=>{
  let calls=0;const instance=service(async()=>{calls++;return board([]);});
  for(const bad of [{maxAirports:11},{maxAirports:0},{airportOffset:-1},{maxPages:4},{from:'2026-02-30T00:00:00Z'},{from:'2026-09-01T00:00:00Z'},{to:interval.from},{extra:'invalid'}])await assert.rejects(instance.getRegionalArrivals({...q,...bad}));
  assert.equal(calls,0);
});

test('offset beyond the selected airports does not imply zero observed arrivals',async()=>{
  const result=await service(async()=>{throw Error('must not query');}).getRegionalArrivals({...q,airportOffset:100});
  assert.equal(result.status,'no_airports_in_window');
  assert.equal(result.observedFlightLegCount,null);assert.equal(result.uniqueObservedRegistrations,null);
  assert.equal(result.coverage.queriedAirportCount,0);assert.equal(result.coverage.unqueriedAirportCount,2);
});
