import {ClientError} from './session.mjs';

export const MIDDLE_EAST_BOUNDS=Object.freeze({south:10,north:43,west:25,east:66});
const TYPES=new Set(['K35R','K35E','K35A','K35T','KC46','KC10','KDC10','B762','B703','C130','C30J','KC130']);
const TANKER=/\b(?:KC[ -]?(?:46A?|135[A-Z]?|10A?|130[A-Z]?)|K35[ARET]|KDC10)\b/i;
const US_MILITARY=/\b(?:(?:UNITED STATES|U\.?S\.?)\s+(?:AIR FORCE|NAVY|MARINE CORPS|COAST GUARD|ARMY|DEPARTMENT OF DEFENSE)|USAF|USMC|USN)\b/i;
const validAge=n=>Number.isFinite(n)&&n>=0;
const coordinates=(lat,lon)=>Number.isFinite(lat)&&Number.isFinite(lon)&&Math.abs(lat)<=90&&Math.abs(lon)<=180;
const inside=(lat,lon,b)=>lat>=b.south&&lat<=b.north&&lon>=b.west&&lon<=b.east;
function location(a,b,elapsed) {
  if(coordinates(a.lat,a.lon)&&validAge(a.seen_pos)&&a.seen_pos+elapsed<=300)return {quality:'reported_position',inRegion:inside(a.lat,a.lon,b)};
  if(coordinates(a.rr_lat,a.rr_lon))return {quality:'receiver_estimate',inRegion:inside(a.rr_lat,a.rr_lon,b)};
  return {quality:'unknown',inRegion:null};
}
function snapshot(data,now) {
  const timestamp=Number(data?.now),ms=timestamp<1e12?timestamp*1000:timestamp;
  if(!Number.isFinite(ms)||Math.abs(now-ms)>60000)throw new ClientError('AIRCRAFT_SOURCE_STALE','Aircraft source snapshot is stale or has an invalid timestamp');
  if(!Array.isArray(data.ac)||data.ac.length>10000)throw new ClientError('AIRCRAFT_SOURCE_INVALID','Invalid aircraft collection');
  return {ms,elapsed:Math.max(0,(now-ms)/1000)};
}
function candidates(data,now,bounds) {
  const {elapsed}=snapshot(data,now),unique=new Map();
  for(const a of data.ac) {
    if(!/^[a-f0-9]{6}$/i.test(a?.hex??'')||!TYPES.has(a.t)||!validAge(a.seen)||a.seen+elapsed>60||!Number.isFinite(a.alt_baro)||a.alt_baro<=0)continue;
    const hex=a.hex.toLowerCase(),previous=unique.get(hex);
    if(!previous||a.seen<previous.seen)unique.set(hex,a);
  }
  return [...unique.values()].map(a=>({a,hex:a.hex.toLowerCase(),loc:location(a,bounds,elapsed)})).filter(x=>x.loc.inRegion!==false);
}
export function summarizeTankers(data,identities,{now=Date.now(),bounds=MIDDLE_EAST_BOUNDS}={}) {
  const {ms,elapsed}=snapshot(data,now),aircraft=[],unresolvedCandidates=[],unlocatedConfirmedTankers=[];
  for(const {a,hex,loc} of candidates(data,now,bounds)) {
    const identity=identities[hex];
    if(!identity||identity.hex?.toLowerCase()!==hex||!identity.registration||identity.registration.toUpperCase()!==(a.r??'').toUpperCase()) {unresolvedCandidates.push({hex,registration:a.r??null,reason:'identity_missing_or_mismatched'});continue;}
    const model=[identity.type,identity.icao_type_code].filter(Boolean).join(' ');
    if(!TANKER.test(model))continue;
    if(!US_MILITARY.test(identity.registered_owner??'')) {
      if(!identity.registered_owner)unresolvedCandidates.push({hex,registration:a.r,reason:'registered_owner_missing'});
      continue;
    }
    const item={hex,registration:a.r,model:identity.type,liveTypeCode:a.t,registeredOwner:identity.registered_owner,identitySource:'https://hexdb.io/api/v2/aircraft/'+hex,identityBasis:'Registered ownership; current operating agency not independently verified',reportedAltitudeFeet:a.alt_baro,messageAgeSeconds:a.seen+elapsed,positionQuality:loc.quality};
    if(loc.inRegion===null)unlocatedConfirmedTankers.push(item);else aircraft.push(item);
  }
  const preciseCount=aircraft.filter(a=>a.positionQuality==='reported_position').length,estimatedCount=aircraft.length-preciseCount;
  return {source:'ADSB.lol public military observations + HexDB aircraft identities',queriedAt:new Date(now).toISOString(),sourceTime:new Date(ms).toISOString(),bounds,regionDefinition:'Broad Middle East rectangle, not country-border geofencing',preciseCount,estimatedCount,observedIncludingEstimates:aircraft.length,complete:false,actualRegionalCount:null,aircraft,unlocatedConfirmedTankers,unresolvedCandidates,limits:['Public coverage is incomplete; absent aircraft are not counted as absent in reality','Generic B762/B703/C130 codes require exact airframe identity','Receiver estimates do not establish precise coordinates or certain region membership','Tanker-capable aircraft being airborne does not establish that refuelling is taking place','Unlocated aircraft and unresolved identities are excluded from regional totals and retained separately']};
}
async function json(url,fetchImpl,maxBytes) {
  let response;try{response=await fetchImpl(url,{redirect:'error',signal:AbortSignal.timeout(15000)});}catch{throw new ClientError('AIRCRAFT_NETWORK_FAILED','Aircraft data request failed');}
  if(!response.ok){await response.body?.cancel();throw new ClientError('AIRCRAFT_HTTP_'+response.status,'Aircraft source returned HTTP '+response.status);}
  const chunks=[];let bytes=0;
  for await(const chunk of response.body){bytes+=chunk.length;if(bytes>maxBytes)throw new ClientError('AIRCRAFT_RESPONSE_LIMIT','Aircraft response exceeded size limit');chunks.push(Buffer.from(chunk));}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new ClientError('AIRCRAFT_SOURCE_INVALID','Aircraft source returned invalid JSON');}
}
export class TankerService {
  #fetch;#clock;#identities=new Map();
  constructor({fetch=globalThis.fetch,clock=Date.now}={}){this.#fetch=fetch;this.#clock=clock;}
  async countMiddleEast() {
    // Worldwide feed retains Mode-S rows that geographic position queries omit.
    const data=await json('https://api.adsb.lol/v2/mil/',this.#fetch,8000000);
    const selected=candidates(data,this.#clock(),MIDDLE_EAST_BOUNDS),identities={},failures=[];
    let cursor=0;
    const worker=async()=>{while(cursor<Math.min(selected.length,50)) {
      const {hex}=selected[cursor++],cached=this.#identities.get(hex);
      if(cached&&this.#clock()-cached.at<86400000){identities[hex]=cached.value;continue;}
      try{const value=await json('https://hexdb.io/api/v2/aircraft/'+hex,this.#fetch,100000);identities[hex]=value;this.#identities.set(hex,{at:this.#clock(),value});}
      catch(error){failures.push({hex,code:error.code??'IDENTITY_FAILED'});}
    }};
    await Promise.all([worker(),worker(),worker()]);
    const result=summarizeTankers(data,identities,{now:this.#clock()});
    return {...result,identityLookupFailures:failures,identityLookupCapped:selected.length>50};
  }
}
