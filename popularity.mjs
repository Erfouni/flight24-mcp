import {DEFAULT_AGENT} from './session.mjs';

// Supplied runtime/bundled settings: urls.feed.getMostTrackedFlights.
// MostTrackedFlight.java, hh/a.java and qe/a.java render clicks as followers.
// strings.xml: "top 10 flights ... following right now". This is not lifetime
// aircraft view history. The current REST response uses snake_case field names.
const ENDPOINT = 'https://mobile.flightradar24.com/flights/most-tracked';
const PROVIDER_LIMIT = 10;
const MAX_BYTES = 1024 * 1024;
const TTL_MS = 15000;
const snapshots = new WeakMap();
const text = value => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g,'').slice(0,200) : null;
function timestamp(value) {
  return Number.isFinite(value) && value > 0 && value < 4102444800 ? new Date(value * 1000).toISOString() : null;
}
function envelope(now) {
  return {
    source:'Flightradar24 most-tracked flights',endpoint:ENDPOINT,
    dataKind:'current_flight_popularity',retrievedAt:new Date(now()).toISOString(),upstreamUpdatedAt:null,
    status:'unavailable',httpStatus:null,
    metric:{scope:'flight',rawField:'clicks',label:'Current tracking count',period:'current_snapshot',cumulativeViewsAvailable:false,
      meaning:'Provider clicks field displayed as Followers or Tracked by. Flights being followed right now; not lifetime aircraft views or a historical view total.'},
    flights:[],coverage:{providerLimit:PROVIDER_LIMIT,providerReturned:0,returned:0,invalidRowCount:0,invalidCountCount:0,complete:false,rankBasis:'provider_order'},
  };
}
async function fetchSnapshot(fetchImpl, now) {
  const result = envelope(now);
  let response;
  try {
    response = await fetchImpl(ENDPOINT,{headers:{'user-agent':DEFAULT_AGENT,accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(15000)});
  } catch { return {...result,status:'network_error',message:'The popularity provider request failed or timed out.'}; }
  result.httpStatus = response.status;
  if (!response.ok) {
    await response.body?.cancel();
    return {...result,status:({401:'unauthenticated',403:'blocked',404:'unavailable',429:'rate_limited'})[response.status]??'upstream_error',message:`Provider returned HTTP ${response.status}; no popularity ranking was obtained.`};
  }
  let body;
  try {
    if (Number(response.headers.get('content-length')) > MAX_BYTES) { await response.body?.cancel(); throw new Error('large'); }
    const reader = response.body?.getReader(); if (!reader) throw new Error('empty');
    const chunks=[];let bytes=0;
    while (true) {
      const {done,value}=await reader.read();if(done)break;
      bytes+=value.byteLength;
      if(bytes>MAX_BYTES){await reader.cancel();throw new Error('large');}
      chunks.push(Buffer.from(value));
    }
    body=JSON.parse(Buffer.concat(chunks,bytes).toString('utf8'));
  } catch { return {...result,status:'invalid_response',message:'Popularity provider did not return valid JSON within the 1 MiB response limit.'}; }
  if (!Array.isArray(body?.data)) return {...result,status:'invalid_response',message:'Unexpected popularity response structure.'};
  result.upstreamUpdatedAt=timestamp(body.update_time);
  result.coverage.providerReturned=body.data.length;
  for (const [index,row] of body.data.slice(0,PROVIDER_LIMIT).entries()) {
    const id=row?.flight_id??row?.flightId;
    if (typeof id!=='string'||!/^[a-f0-9]{1,16}$/i.test(id)) { result.coverage.invalidRowCount++;continue; }
    const count=Number.isSafeInteger(row.clicks)&&row.clicks>=0?row.clicks:null;
    if(count===null)result.coverage.invalidCountCount++;
    result.flights.push({rank:index+1,flightId:id.toLowerCase(),currentTrackerCount:count,
      registration:text(row.registration??row.reg),callsign:text(row.callsign),flightNumber:text(row.flight),
      aircraftType:{code:text(row.model),name:text(row.type)},
      route:{origin:{iata:text(row.from_iata??row.fromIata),city:text(row.from_city??row.fromCity)},destination:{iata:text(row.to_iata??row.toIata),city:text(row.to_city??row.toCity)}}});
  }
  result.coverage.returned=result.flights.length;
  result.status=result.flights.length?(result.coverage.invalidRowCount||result.coverage.invalidCountCount?'partial':'ok'):'unavailable';
  result.message='Provider top-ten flight snapshot in provider order. Missing aircraft registrations remain null. Current tracking counts are not cumulative or historical views.';
  return result;
}
function project(snapshot,limit,clock,hit) {
  const result=structuredClone(snapshot.result);
  result.flights=result.flights.slice(0,limit);
  result.coverage.requestedLimit=limit;result.coverage.returned=result.flights.length;
  result.cache={hit,ttlSeconds:TTL_MS/1000,ageSeconds:Math.max(0,(clock-snapshot.at)/1000)};
  return result;
}

/** One bounded, anonymous top-ten snapshot. Shared in-flight call and 15 s cache. */
export async function getMostTrackedFlights({limit=PROVIDER_LIMIT,fetchImpl=globalThis.fetch,now=Date.now}={}) {
  if(!Number.isInteger(limit)||limit<1||limit>PROVIDER_LIMIT)throw new Error('Popularity limit must be an integer from 1 to 10, the source top-ten scope');
  if(typeof fetchImpl!=='function'||typeof now!=='function')throw new Error('Invalid popularity request options');
  let slot=snapshots.get(fetchImpl);
  if(!slot){slot={cached:null,inflight:null};snapshots.set(fetchImpl,slot);}
  const clock=now(),age=slot.cached?clock-slot.cached.at:Infinity;
  if(age>=0&&age<TTL_MS)return project(slot.cached,limit,clock,true);
  const shared=Boolean(slot.inflight);
  if(!slot.inflight){
    slot.inflight=fetchSnapshot(fetchImpl,now).then(result=>{
      slot.cached={result,at:now()};return slot.cached;
    }).finally(()=>{slot.inflight=null;});
  }
  return project(await slot.inflight,limit,now(),shared);
}
