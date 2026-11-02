import test from 'node:test';
import assert from 'node:assert/strict';
const mod=await import('../aircraft-area.mjs').catch(()=>({}));
const now=Date.parse('2026-11-02T10:00:00Z'),bbox=[50,35,52,37];
const flight=(id,extra={})=>({flightId:id,lat:36,lon:51,timestampMs:String(now-10000),onGround:false,callsign:'TEST'+id,extraInfo:{reg:'N'+id,type:'B762'},...extra});
function service(flights,limit=1000){assert.equal(typeof mod.AircraftAreaService,'function');return new mod.AircraftAreaService({live:{query:async()=>({flights,serverTimeMs:String(now)})},now:()=>now,fetchLimit:limit});}
test('area count deduplicates and excludes stale, missing-time, outside and ground reports',async()=>{
  const r=await service([flight(1),flight(1),flight(2,{onGround:true}),flight(3,{lat:40}),flight(4,{timestampMs:String(now-400000)}),flight(5,{timestampMs:undefined})]).count({bbox});
  assert.equal(r.count,1);assert.equal(r.staleReports,1);assert.equal(r.unknownTimeReports,1);assert.equal(r.complete,false);
});
test('type filters stay exact and list limits do not become count limits',async()=>{
  const r=await service([flight(1),flight(2),flight(3,{extraInfo:{reg:'N3',type:'A320'}})]).list({bbox,typeCode:'B762',limit:1});
  assert.equal(r.count,2);assert.equal(r.aircraft.length,1);assert.equal(r.outputTruncated,true);assert.equal(r.aircraft[0].typeCode,'B762');
});
test('a capped source and invalid bounds cannot be presented as a complete area census',async()=>{
  assert.equal((await service([flight(1)],1).count({bbox})).sourceCapped,true);
  await assert.rejects(service([]).count({bbox:[52,37,50,35]}),/bounds/i);
});
test('a duplicate with a missing timestamp cannot hide a later valid report',async()=>{
  assert.equal((await service([flight(1,{timestampMs:undefined}),flight(1)]).count({bbox})).count,1);
});
