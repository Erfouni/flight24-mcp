import test from 'node:test';
import assert from 'node:assert/strict';
const mod=await import('../airport-history.mjs').catch(()=>({}));
const now=Date.parse('2026-11-02T12:00:00Z');
const q={airport:'DXB',from:'2026-11-02T00:00:00Z',to:'2026-11-02T12:00:00Z'};
function row(id,hour,{status='landed',actual=true,real=null}={}) {
  const timestamp=Date.parse('2026-11-02T'+String(hour).padStart(2,'0')+':00:00Z')/1000;
  return {flight:{identification:{id,row:id==='one'?1:2,number:{default:'FIX1'},callsign:'FIXTURE'},status:{generic:{status:{text:status}}},aircraft:{model:{code:'B77L',text:'Boeing 777-200LR'},registration:'A6-FIX'},airline:{name:'Fixture airline',code:{icao:'FIX',iata:'FX'}},airport:{origin:{code:{iata:'LHR',icao:'EGLL'}},real},time:{scheduled:{arrival:timestamp},real:{arrival:actual?timestamp:null}}}};
}
const reply=rows=>new Response(JSON.stringify({result:{response:{airport:{pluginData:{details:{code:{iata:'DXB',icao:'OMDB'},timezone:{name:'Asia/Dubai'}},schedule:{arrivals:{page:{current:1,total:1},item:{current:rows.length,total:rows.length,limit:100},timestamp:now/1000,data:rows}}}}}}}),{headers:{'content-type':'application/json'}});

test('airport history uses APK earlier-page requests and counts only actual landed non-diverted records',async()=>{
  assert.equal(typeof mod.AirportHistoryService,'function','AirportHistoryService must exist');
  let request;
  const service=new mod.AirportHistoryService({clock:()=>now,fetch:async u=>{request=new URL(u);return reply([row('one',9),row('one',9),row('scheduled',10,{actual:false,status:'scheduled'}),row('canceled',11,{status:'canceled'}),row('diverted',8,{real:{code:{iata:'AUH',icao:'OMAA'}}})]);}});
  const result=await service.getAirportArrivals(q);
  assert.equal(request.hostname,'mobile.flightradar24.com');
  assert.equal(request.pathname,'/common/v2/airport.json');
  assert.equal(request.searchParams.get('page'),'-1');
  assert.equal(request.searchParams.get('plugin-setting[schedule][timestamp]'),String(now/1000));
  assert.equal(request.searchParams.get('limit'),'100');
  assert.equal(request.searchParams.get('plugin-setting[schedule][mode]'),'arrivals');
  assert.equal(result.actualArrivalRecordCount,1);
  assert.equal(result.records[0].actualArrival,'2026-11-02T09:00:00.000Z');
  assert.equal(result.records[0].airline.iata,'FX');
  assert.equal(result.records[0].serviceCategory,null);
  assert.equal(result.complete,false);assert.equal(result.exactCount,null);
  assert.equal(result.coverage.intervalComplete,false);
});

test('exhausting a scheduled airport page never proves complete airport or cargo coverage',async()=>{
  const service=new mod.AirportHistoryService({clock:()=>now,fetch:async()=>reply([row('one',9)])});
  const result=await service.getAirportArrivals(q);
  assert.equal(result.coverage.boardPagesExhausted,true);
  assert.equal(result.complete,false);assert.equal(result.exactCount,null);
  assert.equal(result.coverage.allTrafficIncluded,false);
  assert.equal(result.cargoClassificationAvailable,false);
});

test('earlier airport pages advance their timestamp anchor and stop at the configured cap',async()=>{
  const anchors=[];
  const service=new mod.AirportHistoryService({clock:()=>now,fetch:async u=>{anchors.push(Number(new URL(u).searchParams.get('plugin-setting[schedule][timestamp]')));const rows=Array.from({length:100},(_,i)=>row('id-'+i,anchors.length===1?9:8));return reply(rows);}});
  const result=await service.getAirportArrivals({...q,maxPages:2});
  assert.deepEqual(anchors,[now/1000,Date.parse('2026-11-02T09:00:00Z')/1000]);
  assert.equal(result.coverage.pagesFetched,2);
  assert.equal(result.complete,false);
});

test('repeated airport queries share a cached read while upstream denials never become zero arrivals',async()=>{
  let calls=0;
  const service=new mod.AirportHistoryService({clock:()=>now,fetch:async()=>{calls++;return reply([row('one',9)]);}});
  const [a,b]=await Promise.all([service.getAirportArrivals(q),service.getAirportArrivals(q)]);
  assert.equal(calls,1);assert.deepEqual(a,b);
  const denied=new mod.AirportHistoryService({fetch:async()=>new Response('private-token-must-not-appear',{status:400}),clock:()=>now});
  await assert.rejects(denied.getAirportArrivals({...q,from:'2026-10-01T00:00:00Z',to:'2026-10-02T00:00:00Z'}),e=>e.code==='HTTP_400'&&!e.message.includes('private-token'));
});

test('airport history rejects invalid ranges, airports and unbounded page requests before network access',async()=>{
  let calls=0;const service=new mod.AirportHistoryService({fetch:async()=>{calls++;throw Error();}});
  for(const bad of [{airport:'DXB&token=x'},{from:'2026-02-30T00:00:00Z'},{from:'2026-11-03T00:00:00Z'},{maxPages:4},{maxPages:0},{from:'2026-01-01T00:00:00Z'}])await assert.rejects(service.getAirportArrivals({...q,...bad}),e=>e.code==='AIRPORT_HISTORY_INPUT_INVALID');
  assert.equal(calls,0);
});
