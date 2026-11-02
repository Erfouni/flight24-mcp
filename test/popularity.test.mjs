import test from 'node:test';
import assert from 'node:assert/strict';
const api = await import('../popularity.mjs').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error;});
const available = typeof api.getMostTrackedFlights === 'function';
const sample = {update_time:1793614990,data:[
  {flight_id:'42652fc7',clicks:233,callsign:'UAE98X',flight:'EK179',model:'B77W',type:'Boeing 777',from_city:'Dubai',from_iata:'DXB',to_city:'Warsaw',to_iata:'WAW'},
  {flight_id:'4265dd30',clicks:999,callsign:'AAL705',flight:'AA705',model:'B772',from_iata:'FRA',to_iata:'CLT'},
]};
const json = value => new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});

test('popularity operation is available',()=>assert.equal(typeof api.getMostTrackedFlights,'function'));

test('provider ordering, current counts and flight identity remain distinct from lifetime aircraft views',{skip:!available},async()=>{
  let request;
  const result=await api.getMostTrackedFlights({limit:2,now:()=>1793615000000,fetchImpl:async(url,init)=>{request={url:new URL(url),init};return json(sample);}});
  assert.equal(request.url.href,'https://mobile.flightradar24.com/flights/most-tracked');
  assert.equal(request.init.redirect,'error');assert.ok(request.init.signal);
  assert.equal(request.init.headers.authorization,undefined);
  assert.equal(result.status,'ok');assert.equal(result.flights[0].flightId,'42652fc7');
  assert.equal(result.flights[0].rank,1);assert.equal(result.flights[1].rank,2);
  assert.equal(result.flights[0].currentTrackerCount,233);assert.equal(result.flights[1].currentTrackerCount,999);
  assert.equal(result.flights[0].registration,null);
  assert.equal(result.flights[0].route.origin.iata,'DXB');
  assert.equal(result.upstreamUpdatedAt,new Date(1793614990*1000).toISOString());
  assert.equal(result.metric.scope,'flight');assert.equal(result.metric.cumulativeViewsAvailable,false);
  assert.equal(result.coverage.providerLimit,10);
});

test('one request serves concurrent callers and cached results are isolated for 15 seconds',{skip:!available},async()=>{
  let calls=0,clock=1793615000000,release;
  const gate=new Promise(resolve=>release=resolve);
  const fetchImpl=async()=>{calls++;await gate;return json(sample);};
  const a=api.getMostTrackedFlights({limit:1,fetchImpl,now:()=>clock});
  const b=api.getMostTrackedFlights({limit:2,fetchImpl,now:()=>clock});
  release();const [one,two]=await Promise.all([a,b]);
  assert.equal(calls,1);assert.equal(one.flights.length,1);assert.equal(two.flights.length,2);
  one.flights[0].currentTrackerCount=100000;
  clock+=14000;const cached=await api.getMostTrackedFlights({fetchImpl,now:()=>clock});
  assert.equal(calls,1);assert.equal(cached.cache.hit,true);assert.equal(cached.flights[0].currentTrackerCount,233);
  assert.equal(cached.retrievedAt,two.retrievedAt);
  clock+=1001;await api.getMostTrackedFlights({fetchImpl,now:()=>clock});assert.equal(calls,2);
});

test('invalid rows preserve original ranks and invalid counts do not become fake zeroes',{skip:!available},async()=>{
  const body={data:[{flight_id:'not-an-id',clicks:4},{flight_id:'4265dd30',clicks:-1},{flight_id:'42652fc7',clicks:0}]};
  const result=await api.getMostTrackedFlights({fetchImpl:async()=>json(body)});
  assert.equal(result.status,'partial');assert.equal(result.flights[0].rank,2);
  assert.equal(result.flights[0].currentTrackerCount,null);assert.equal(result.flights[1].currentTrackerCount,0);
  assert.equal(result.coverage.invalidRowCount,1);assert.equal(result.coverage.invalidCountCount,1);
});

test('blocked provider and oversized streams remain explicit bounded outcomes',{skip:!available},async()=>{
  const blocked=await api.getMostTrackedFlights({fetchImpl:async()=>new Response('blocked',{status:403})});
  assert.equal(blocked.status,'blocked');assert.equal(blocked.httpStatus,403);assert.deepEqual(blocked.flights,[]);
  let canceled=false;
  const stream=new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(600000));},cancel(){canceled=true;}});
  const oversized=await api.getMostTrackedFlights({fetchImpl:async()=>new Response(stream)});
  assert.equal(oversized.status,'invalid_response');assert.equal(canceled,true);assert.deepEqual(oversized.flights,[]);
});

test('request limits use the actual top-ten source scope and fail before I/O',{skip:!available},async()=>{
  let calls=0;const fetchImpl=async()=>{calls++;return json(sample);};
  for(const limit of [0,11,50,1.5])await assert.rejects(api.getMostTrackedFlights({limit,fetchImpl}),/limit/i);
  assert.equal(calls,0);
});
