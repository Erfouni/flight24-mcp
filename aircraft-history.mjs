import {readFileSync} from 'node:fs';
import {ClientError,DEFAULT_AGENT} from './session.mjs';

// Supplied APK: fk/i.java (registration history), di/c.java (search),
// qh/b.java and SinglePlaybackResponse/PlaybackTrackData (single-flight track).
// Current runtime settings select mobile/common/v2; bundled settings used api/v1.
const SETTINGS = (()=>{
  try{return JSON.parse(readFileSync(new URL('./runtime-settings.json',import.meta.url),'utf8'));}
  catch(error){if(error.code!=='ENOENT')throw error;return JSON.parse(readFileSync(new URL('./bundled-settings.json',import.meta.url),'utf8'));}
})();
const SOURCE = 'Flightradar24 APK and observed web endpoints';
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_POINTS = 20000;
const GAP_SECONDS = 300;
const ACCOUNT_COOKIES=new Set(['FR24SID','PHPSESSID','_frc','_frr','_frpk','_frPl','XSRFtoken']);
const ENDPOINTS = {
  history: new Set(['mobile.flightradar24.com/common/v2/flight/list.json','api.flightradar24.com/common/v1/flight/list.json']),
  playback: new Set(['mobile.flightradar24.com/common/v2/flight-playback.json','api.flightradar24.com/common/v1/flight-playback.json']),
  search: new Set(['mobile.flightradar24.com/v1/search/web/find']),
};
const text = value => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g,'').slice(0,200) : null;
const numeric = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const sameRegistration = (a,b) => typeof a === 'string' && a.replace(/[- ]/g,'').toUpperCase() === b.replace(/[- ]/g,'').toUpperCase();
function iso(value) {
  if (typeof value === 'string' && /^\d{1,10}$/.test(value)) value = Number(value);
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 4102444800 ? new Date(value*1000).toISOString() : null;
}
function endpoint(kind, options) {
  const settings = options.settings ?? SETTINGS;
  const value = kind === 'search' ? settings?.urls?.search?.freemium : settings?.urls?.feed?.[kind];
  let url;
  try { url = new URL(value?.startsWith('https://') ? value : 'https://' + value); } catch { throw new Error('Invalid aircraft endpoint configuration'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !ENDPOINTS[kind].has(url.host + url.pathname)) {
    throw new Error('Aircraft endpoint is outside the fixed HTTPS allowlist');
  }
  return url;
}
function base(kind, options, url) {
  return {source:SOURCE,dataKind:kind,retrievedAt:new Date((options.now ?? Date.now)()).toISOString(),endpoint:url.origin+url.pathname,status:'unavailable',httpStatus:null,upstreamTimestamp:null};
}
function historyKeys(options) {
  if(options.historyAuth===undefined)return null;
  const value=options.historyAuth;
  if(!value||typeof value!=='object'||Array.isArray(value)||!['subscriptionKey','publicKey'].every(key=>typeof value[key]==='string'&&value[key].length<=8192&&!/[^\x21-\x7e]/.test(value[key])))throw new Error('Invalid private history authentication key pair');
  if(value.subscriptionKey===''&&value.publicKey==='')return null;
  // The observed signed-in web request supplies token while pk is empty.
  if(!value.subscriptionKey)throw new Error('A nonempty private history subscription key is required');
  return {subscriptionKey:value.subscriptionKey,publicKey:value.publicKey};
}
function privateHeaders(options,url){
  if(options.authHeaders===undefined)return {};
  const value=options.authHeaders;
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['cookie','user-agent','origin','referer'].includes(key.toLowerCase())))throw new Error('Invalid private history authentication headers');
  if(url.origin!=='https://api.flightradar24.com')throw new Error('Account cookie headers are limited to the observed legacy API origin');
  const normalized={};
  for(const [key,contents]of Object.entries(value)){
    const name=key.toLowerCase();
    if(normalized[name]!==undefined||typeof contents!=='string'||!contents||/[^\x20-\x7e]/.test(contents)||contents.length>(name==='cookie'?32768:2048))throw new Error('Invalid private history authentication header value');
    normalized[name]=contents;
  }
  if(normalized.origin!==undefined&&normalized.origin!=='https://www.flightradar24.com')throw new Error('Invalid fixed history origin header');
  if(normalized.referer!==undefined&&normalized.referer!=='https://www.flightradar24.com/')throw new Error('Invalid fixed history referer header');
  if(normalized.cookie){
    const selected=[],seen=new Set();
    for(const part of normalized.cookie.split(';')){
      const pair=part.trim(),index=pair.indexOf('='),name=pair.slice(0,index),contents=pair.slice(index+1);
      if(index<1||!/^[A-Za-z0-9_-]+$/.test(name))throw new Error('Invalid account cookie header');
      if(!ACCOUNT_COOKIES.has(name))continue;
      if(seen.has(name)||!contents||!/^[\x21-\x3a\x3c-\x7e]+$/.test(contents))throw new Error('Invalid account cookie header');
      seen.add(name);selected.push(name+'='+contents);
    }
    if(!selected.length)throw new Error('No allowlisted account cookies were supplied');
    normalized.cookie=selected.join('; ');
  }
  return normalized;
}
function authentication(options,url,keys){
  const cookies=Boolean(privateHeaders(options,url).cookie);
  return {authenticated:Boolean(keys||cookies),authenticationBasis:keys&&cookies?'request_keys_and_account_cookies_supplied':keys?'request_keys_supplied':cookies?'account_cookies_supplied':'anonymous',serverEntitlementVerified:false};
}
async function request(url, options) {
  const headers={'user-agent':DEFAULT_AGENT,accept:'application/json',...privateHeaders(options,url)};
  let response;
  try {
    response = await (options.fetchImpl ?? fetch)(url, {headers,redirect:'error',signal:AbortSignal.timeout(15000)});
  } catch(error) { if(error?.code==='INTERACTION_REQUIRED')throw new ClientError('INTERACTION_REQUIRED','The provider browser requires human verification or sign-in');return {status:'network_error',httpStatus:null,message:'Provider request failed or timed out. No aircraft absence or movement can be inferred.'}; }
  if (!response.ok) {
    await response.body?.cancel();
    const status = ({401:'unauthenticated',403:'blocked',404:'not_found',429:'rate_limited'})[response.status] ?? 'upstream_error';
    return {status,httpStatus:response.status,message:`Provider returned HTTP ${response.status}. No account access level was asserted.`};
  }
  try {
    if (Number(response.headers.get('content-length')) > MAX_BYTES) { await response.body?.cancel(); throw new Error('large'); }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('empty');
    const chunks = []; let bytes = 0;
    while (true) {
      const {done,value} = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) { await reader.cancel(); throw new Error('large'); }
      chunks.push(Buffer.from(value));
    }
    return {data:JSON.parse(Buffer.concat(chunks,bytes).toString('utf8')),httpStatus:response.status};
  } catch { return {status:'invalid_response',httpStatus:response.status,message:'Provider did not return bounded valid JSON.'}; }
}
function identity(aircraft = {}) {
  return {registration:text(aircraft.registration ?? aircraft.identification?.registration),icao24:text(aircraft.hex ?? aircraft.identification?.modes),modelCode:text(aircraft.model?.code),modelName:text(aircraft.model?.text)};
}
function airport(value) {
  return value && typeof value === 'object' ? {name:text(value.name),iata:text(value.code?.iata),icao:text(value.code?.icao)} : null;
}
function flightRecord(row) {
  const times = {};
  for (const [group,prefix] of [['scheduled','scheduled'],['real','actual'],['estimated','estimated']]) {
    for (const event of ['departure','arrival']) times[prefix + event[0].toUpperCase()+event.slice(1)] = iso(row.time?.[group]?.[event]);
  }
  times.updatedAt = iso(row.time?.other?.updated);
  return {flightId:text(row.identification?.id),number:text(row.identification?.number?.default),callsign:text(row.identification?.callsign),aircraft:identity(row.aircraft),airline:text(row.airline?.name),origin:airport(row.airport?.origin),destination:airport(row.airport?.destination),status:{text:text(row.status?.text),live:typeof row.status?.live === 'boolean' ? row.status.live : null},times};
}
// AirportBoardFlightData.getTimeStamp() defines this precedence. This is a
// history ordering timestamp, which is not always an actual movement time.
function historyTime(row) {
  for(const [value,basis] of [
    [row.time?.scheduled?.departure,'scheduled_departure'],
    [row.time?.real?.departure,'actual_departure'],
    [row.status?.generic?.eventTime?.utc,'provider_event'],
    [row.time?.other?.updated,'provider_updated'],
    [row.aircraft?.onGroundUpdate,'provider_on_ground_update'],
  ])if(iso(value))return {seconds:Number(value),at:iso(value),basis};
  return null;
}
function historyAnchor(before) {
  if (typeof before !== 'string') throw new Error('History before must be an ISO timestamp with a timezone');
  const match=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(before);
  if (!match) throw new Error('History before must be an ISO timestamp with a timezone');
  const [year,month,day,hour,minute,second]=match.slice(1,7).map(Number);
  const milliseconds=Date.parse(before);
  if (month<1||month>12||day<1||day>new Date(Date.UTC(year,month,0)).getUTCDate()||hour>23||minute>59||second>59||!Number.isFinite(milliseconds)||!iso(Math.floor(milliseconds/1000))) {
    throw new Error('History before is not a valid timestamp');
  }
  return {requestedBefore:new Date(milliseconds).toISOString(),seconds:Math.floor(milliseconds/1000)};
}

/** Public aircraft/live/schedule lookup. A blocked provider remains blocked. */
export async function searchAircraft(identifier, options = {}) {
  if (typeof identifier !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 .-]{0,79}$/.test(identifier.trim())) throw new Error('Supply a valid aircraft identifier or registration');
  identifier = identifier.trim().toUpperCase();
  const url = endpoint('search',options); url.search = new URLSearchParams({query:identifier,limit:'20'});
  const result = {...base('aircraft_search',options,url),identifier,aircraft:[]};
  const response = await request(url,options);
  if (!response.data) return {...result,...response};
  if (!Array.isArray(response.data.results)) return {...result,status:'invalid_response',httpStatus:response.httpStatus,message:'Unexpected aircraft search response structure.'};
  const aircraft = response.data.results.filter(r=>r && ['aircraft','live','schedule'].includes(r.type)).slice(0,20).map(r=>({
    resultType:r.type,id:text(r.id),label:text(r.label),registration:text(r.type==='aircraft' ? r.id : r.detail?.reg),callsign:text(r.detail?.callsign),flightNumber:text(r.detail?.flight),aircraftType:text(r.detail?.equip ?? r.detail?.ac_type),
  }));
  return {...result,httpStatus:response.httpStatus,status:aircraft.length ? 'ok':'not_found',aircraft,message:'Identity search results only. Search coordinates without report times are not exposed as current positions.'};
}

/** One bounded history page. Airport locations are never substituted for a track. */
export async function getAircraftHistory(registration, limit = 20, options = {}) {
  if (typeof registration !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{1,14}$/.test(registration.trim())) throw new Error('Supply an aircraft registration');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('History limit must be an integer from 1 to 100');
  const page=options.page??1;
  if (!Number.isInteger(page)||page<1||page>50) throw new Error('History page must be an integer from 1 to 50');
  // bj/c.java uses timestamp as an older-history cursor: last record time - 60.
  // The requested anchor is independent of actual request/retrieval time.
  const anchor=options.before===undefined?{requestedBefore:null,seconds:Math.floor((options.now??Date.now)()/1000)}:historyAnchor(options.before);
  const keys=historyKeys(options),cursor=options.olderThenFlightId;
  if(cursor!==undefined&&(typeof cursor!=='string'||!/^[a-f0-9]{1,16}$/i.test(cursor)))throw new Error('Invalid older history flight cursor');
  registration = registration.trim().toUpperCase();
  const url = endpoint('history',options);
  url.search = new URLSearchParams({query:registration,fetchBy:'reg',page:String(page),limit:String(limit),timestamp:String(anchor.seconds),device:'android'});
  if(keys){url.searchParams.set('token',keys.subscriptionKey);url.searchParams.set('pk',keys.publicKey);}
  if(cursor!==undefined)url.searchParams.set('olderThenFlightId',cursor.toLowerCase());
  const result = {...base('aircraft_flight_history',options,url),...authentication(options,url,keys),registration,requestedBefore:anchor.requestedBefore,requestedBeforeHonored:null,queryAnchorAt:iso(anchor.seconds),requestedOlderThenFlightId:cursor?.toLowerCase()??null,nextCursor:null,flights:[],coverage:{page,providerPage:null,requestedLimit:limit,returned:0,providerReturned:0,matchingBefore:0,excludedAtOrAfterBefore:0,excludedUnknownTimestamp:0,omittedByLimit:0,moreAvailable:null,providerTotal:null,complete:false}};
  const response = await request(url,options);
  if (!response.data) return {...result,...response};
  const body = response.data.result?.response;
  if (!Array.isArray(body?.data)) return {...result,httpStatus:response.httpStatus,status:'invalid_response',message:'Unexpected aircraft history response structure.'};
  const rows = body.data;
  if (rows.some(row=>!row || !sameRegistration(row.aircraft?.registration,registration) || !/^[a-f0-9]{1,16}$/i.test(row.identification?.id ?? ''))) {
    return {...result,httpStatus:response.httpStatus,status:'invalid_response',message:'Provider returned an invalid flight identity or a different aircraft registration.'};
  }
  const providerPage=Number.isInteger(body.page?.current)&&body.page.current>=1&&body.page.current<=50?body.page.current:null;
  const moreAvailable=typeof body.page?.more==='boolean'?body.page.more:null;
  let excludedAtOrAfterBefore=0,excludedUnknownTimestamp=0;
  const matching=rows.filter(row=>{
    if(!anchor.requestedBefore)return true;
    const timestamp=historyTime(row);
    if(!timestamp){excludedUnknownTimestamp++;return false;}
    if(timestamp.seconds>=anchor.seconds){excludedAtOrAfterBefore++;return false;}
    return true;
  });
  const flights=matching.slice(0,limit).map(row=>({...flightRecord(row),historyTimestamp:historyTime(row)?.at??null,historyTimestampBasis:historyTime(row)?.basis??null}));
  // Preserve the full upstream page cursor even when the displayed records
  // are date-filtered or limited. The timestamp-minus-60 rule is from bj/c.java;
  // the additional ID and page fields were observed in the signed-in web UI.
  const last=rows.at(-1),lastTime=last?historyTime(last):null,nextPage=(providerPage??page)+1;
  const nextCursor=lastTime&&iso(lastTime.seconds-60)&&moreAvailable!==false&&nextPage<=50
    ?{page:nextPage,before:iso(lastTime.seconds-60),olderThenFlightId:last.identification.id.toLowerCase()}:null;
  const requestedBeforeHonored=!anchor.requestedBefore||!rows.length?null:excludedAtOrAfterBefore?false:excludedUnknownTimestamp?null:true;
  const status=flights.length?(excludedAtOrAfterBefore||excludedUnknownTimestamp?'partial':'ok')
    :excludedAtOrAfterBefore?'date_boundary_not_honored':excludedUnknownTimestamp?'date_boundary_unverified':'not_found';
  return {...result,status,httpStatus:response.httpStatus,upstreamTimestamp:iso(body.timestamp),requestedBeforeHonored,nextCursor,flights,
    coverage:{...result.coverage,providerPage,returned:flights.length,providerReturned:rows.length,matchingBefore:matching.length,excludedAtOrAfterBefore,excludedUnknownTimestamp,omittedByLimit:Math.max(0,matching.length-limit),moreAvailable,providerTotal:Number.isInteger(body.item?.total)?body.item.total:null},
    message:'One provider page. Before is enforced against the explicit historyTimestamp, whose basis may be scheduled departure or a provider update rather than an actual movement. A provider query timestamp alone does not guarantee older data. nextCursor contains the full provider page continuation, including its own before anchor; it is not proof of coverage of the originally requested date. Completeness and access to every past date are not guaranteed.'};
}

/** Timestamped provider samples for one historical flight; no interpolated points. */
export async function getAircraftTrack(flightId, options = {}) {
  if (typeof flightId !== 'string' || !/^[a-f0-9]{1,16}$/i.test(flightId)) throw new Error('Supply a provider flight ID from aircraft history');
  flightId = flightId.toLowerCase();
  const keys=historyKeys(options);
  const url = endpoint('playback',options);
  // qh/b.java always includes token/pk. Anonymous APK values are empty strings.
  url.search = new URLSearchParams({flightId,timestamp:String(Math.floor((options.now ?? Date.now)()/1000)),token:keys?.subscriptionKey??'',pk:keys?.publicKey??''});
  const coverage = {pointCount:0,providerPointCount:0,invalidPointCount:0,duplicatePointCount:0,truncated:false,complete:false,firstReportedAt:null,lastReportedAt:null,gapThresholdSeconds:GAP_SECONDS,gaps:[]};
  const result = {...base('aircraft_historical_track',options,url),...authentication(options,url,keys),flightId,aircraft:null,flight:null,points:[],coverage};
  const response = await request(url,options);
  if (!response.data) return {...result,...response};
  const body = response.data.result?.response, flight = body?.data?.flight;
  if (!flight) return {...result,httpStatus:response.httpStatus,status:'unavailable',message:'Provider returned no historical flight data.'};
  if (typeof flight.identification?.id !== 'string' || flight.identification.id.toLowerCase() !== flightId) return {...result,httpStatus:response.httpStatus,status:'invalid_response',message:'Playback flight identity does not match the requested flight.'};
  if (!Array.isArray(flight.track)) return {...result,httpStatus:response.httpStatus,status:'unavailable',message:'Provider did not supply timestamped trajectory samples.'};
  const points = []; const seen = new Set();
  coverage.providerPointCount = flight.track.length; coverage.truncated = flight.track.length > MAX_POINTS;
  for (const row of flight.track.slice(0,MAX_POINTS)) {
    const lat = numeric(row?.latitude), lon = numeric(row?.longitude), reportedAt = iso(row?.timestamp);
    if (lat===null || lon===null || lat < -90 || lat > 90 || lon < -180 || lon > 180 || !reportedAt) { coverage.invalidPointCount++; continue; }
    const key = `${reportedAt}:${lat}:${lon}`;
    if (seen.has(key)) { coverage.duplicatePointCount++; continue; } seen.add(key);
    const speed = numeric(row.speed?.kts), heading = numeric(row.heading);
    points.push({latitude:lat,longitude:lon,reportedAt,altitudeFeet:numeric(row.altitude?.feet),speedKnots:speed!==null&&speed>=0?speed:null,headingDegrees:heading!==null&&heading>=0&&heading<=360?heading:null});
  }
  points.sort((a,b)=>a.reportedAt.localeCompare(b.reportedAt));
  for (let i=1;i<points.length;i++) {
    const seconds = (Date.parse(points[i].reportedAt)-Date.parse(points[i-1].reportedAt))/1000;
    if (seconds > GAP_SECONDS) coverage.gaps.push({afterIndex:i-1,beforeIndex:i,durationSeconds:seconds});
  }
  coverage.pointCount = points.length; coverage.firstReportedAt = points[0]?.reportedAt??null; coverage.lastReportedAt=points.at(-1)?.reportedAt??null;
  const partial = coverage.invalidPointCount || coverage.duplicatePointCount || coverage.truncated || coverage.gaps.length;
  return {...result,httpStatus:response.httpStatus,status:points.length?(partial?'partial':'ok'):'unavailable',upstreamTimestamp:iso(body.timestamp),aircraft:identity(flight.aircraft),flight:flightRecord(flight),points,coverage,
    message:'Historical provider samples, not a live location or guaranteed complete route. No coordinates are inferred from airports, schedules or missing intervals.'};
}
