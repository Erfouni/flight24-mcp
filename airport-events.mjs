import {ClientError} from './session.mjs';
import {AirportEventsCache} from './airport-events-cache.mjs';

// Observed signed-in Gold website request, 2026-11-02:
// GET /api/v1/airport-history/916?date=2026-10-01&eventType=landed
// Raw accessToken header, application/json, browser user-agent. HTTP 200;
// {data:[496 landing events]}. Date is the airport's LOCAL calendar day.
const ORIGIN='https://www.flightradar24.com',MAX_BYTES=4*1024*1024,MAX_ROWS=20000;
const inputError=()=>new ClientError('AIRPORT_EVENTS_INPUT_INVALID','Provide a numeric airport ID, YYYY-MM-DD local date, landed or takeoff eventType and optional valid IANA timezone');
const badResponse=()=>new ClientError('AIRPORT_EVENTS_BAD_RESPONSE','Airport events did not return a bounded valid event response');
const nullableText=value=>value==null||value===''?null:typeof value==='string'&&value.length<=200&&!/[\x00-\x1f\x7f]/.test(value)?value:undefined;
const nullableId=value=>value==null?null:Number.isSafeInteger(value)&&value>0?value:undefined;
function dateValid(value){return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;}
function localDate(formatter,time){const parts=Object.fromEntries(formatter.formatToParts(new Date(time*1000)).map(p=>[p.type,p.value]));return parts.year+'-'+parts.month+'-'+parts.day;}
async function readJson(response){
  const reader=response.body?.getReader();
  if(!reader)throw badResponse();
  try{
    if(Number(response.headers.get('content-length'))>MAX_BYTES)throw badResponse();
    const chunks=[];let bytes=0;
    while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>MAX_BYTES)throw badResponse();chunks.push(Buffer.from(value));}
    return JSON.parse(Buffer.concat(chunks,bytes).toString('utf8'));
  }catch{await reader.cancel().catch(()=>{});throw badResponse();}
}
function normalize(row,query,formatter){
  if(!row||typeof row!=='object'||Array.isArray(row)||row.type!==query.eventType||!Number.isSafeInteger(row.time)||row.time<=0||row.time>=253402300800||typeof row.live!=='boolean'||!Array.isArray(row.available)||row.available.length>30)throw badResponse();
  const strings=Object.fromEntries(['flightId','aircraftType','registration','callsign','flightNumber','runway'].map(key=>[key,nullableText(row[key])]));
  const ids=Object.fromEntries(['originId','destinationId','airlineId'].map(key=>[key,nullableId(row[key])]));
  if(Object.values(strings).some(value=>value===undefined)||!strings.flightId||Object.values(ids).some(value=>value===undefined)||row.available.some(value=>typeof value!=='string'||!/^[A-Za-z_-]{1,64}$/.test(value)))throw badResponse();
  if(formatter&&localDate(formatter,row.time)!==query.date)throw badResponse();
  const eventTime=new Date(row.time*1000).toISOString();
  // Route origin/destination may be absent for unscheduled movements. The event
  // airport is established by the requested airport-history route, not guessed
  // from a planned destination or a flight number.
  return {eventType:row.type,eventTime,eventAirportId:query.airportId,...strings,...ids,live:row.live,availableFieldNames:[...row.available],
    actualArrival:row.type==='landed'?eventTime:null,actualDeparture:row.type==='takeoff'?eventTime:null,
    serviceCategory:null,cargoClassification:'unavailable from airport event response'};
}

export class AirportEventsService{
  #loadSession;#fetch;#clock;#sleep;#minInterval;#maxQueued;#store;#ready;#tail=Promise.resolve();#pending=new Map();#cache=new Map();#cacheBytes=0;#lastStart=null;#cooldownUntil=0;#active=false;#networkRequests=0;#cacheHits=0;#storeHealthy=true;
  constructor({loadSession,fetch=globalThis.fetch,clock=Date.now,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),cacheDir,minIntervalMs=1000,maxQueuedRequests=32}={}){
    if(!Number.isInteger(minIntervalMs)||minIntervalMs<0||minIntervalMs>60000||!Number.isInteger(maxQueuedRequests)||maxQueuedRequests<1||maxQueuedRequests>64||typeof clock!=='function'||typeof sleep!=='function')throw new ClientError('AIRPORT_EVENTS_CONFIG_INVALID','Configure bounded nonnegative pacing, 1 to 64 pending requests and clock/sleep functions');
    this.#loadSession=loadSession;this.#fetch=fetch;this.#clock=clock;this.#sleep=sleep;this.#minInterval=minIntervalMs;this.#maxQueued=maxQueuedRequests;this.#store=cacheDir===undefined?null:new AirportEventsCache(cacheDir);
  }
  get configured(){return typeof this.#loadSession==='function';}
  toJSON(){return {configured:this.configured,source:'FR24 account airport events',credentialsExposed:false};}
  getStatus(){return {configured:this.configured,pendingRequests:this.#pending.size,maxQueuedRequests:this.#maxQueued,queuedRequests:Math.max(0,this.#pending.size-(this.#active?1:0)),activeRequest:this.#active,minIntervalMs:this.#minInterval,networkRequests:this.#networkRequests,cacheEntries:this.#cache.size,cacheHits:this.#cacheHits,durableCacheEnabled:!!this.#store,cacheStoreHealthy:this.#storeHealthy,cooldownActive:this.#cooldownUntil>this.#clock(),retryAt:this.#cooldownUntil>this.#clock()?new Date(this.#cooldownUntil).toISOString():null,retryAfterSeconds:Math.max(0,Math.ceil((this.#cooldownUntil-this.#clock())/1000))};}
  #rateLimited(){const failure=new ClientError('HTTP_429','Airport history is cooling down after provider rate limiting; no automatic retry was performed');failure.retryAt=new Date(this.#cooldownUntil).toISOString();failure.retryAfterSeconds=Math.max(0,Math.ceil((this.#cooldownUntil-this.#clock())/1000));return failure;}
  async #initialize(){if(!this.#ready)this.#ready=(async()=>{if(this.#store){await this.#store.init();this.#cooldownUntil=Math.max(this.#cooldownUntil,await this.#store.readCooldown());}})().catch(error=>{this.#storeHealthy=false;throw error;});await this.#ready;}
  #remember(key,entry){const size=Buffer.byteLength(JSON.stringify(entry));if(size>8*1024*1024)return;while(this.#cache.size>=64||this.#cacheBytes+size>64*1024*1024){const oldest=this.#cache.keys().next().value;if(oldest===undefined)break;this.#cacheBytes-=this.#cache.get(oldest).size;this.#cache.delete(oldest);}this.#cache.set(key,{entry,size});this.#cacheBytes+=size;}
  #cachedValue(entry,key,query,formatter,storage){
    if(!entry||entry.version!==1||entry.key!==key||!Number.isFinite(entry.storedAt)||!Number.isFinite(entry.expiresAt)||entry.storedAt>this.#clock()+300000||entry.expiresAt<=entry.storedAt||entry.expiresAt<=this.#clock()||entry.expiresAt-entry.storedAt>7*86400000||typeof entry.retrievedAt!=='string'||!Number.isFinite(Date.parse(entry.retrievedAt)))return null;
    const value=this.#render(entry,query,formatter);value.cache={hit:true,storage,storedAt:new Date(entry.storedAt).toISOString(),ageSeconds:Math.max(0,Math.floor((this.#clock()-entry.storedAt)/1000)),ttlSeconds:(entry.expiresAt-entry.storedAt)/1000};return value;
  }
  async getAirportEvents(args){
    if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(key=>!['airportId','date','eventType','timezone'].includes(key)))throw inputError();
    const {airportId,date,eventType='landed',timezone}=args;
    if(!Number.isSafeInteger(airportId)||airportId<1||airportId>2147483647||!dateValid(date)||!['landed','takeoff'].includes(eventType)||(timezone!==undefined&&(typeof timezone!=='string'||timezone.length>100)))throw inputError();
    let formatter;
    if(timezone!==undefined){try{formatter=new Intl.DateTimeFormat('en-US',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'});}catch{throw inputError();}}
    const query={airportId,date,eventType,timezone},key=JSON.stringify(query);
    await this.#initialize();
    const memory=this.#cache.get(key);if(memory){const hit=this.#cachedValue(memory.entry,key,query,formatter,'memory');if(hit){this.#cacheHits++;return hit;}this.#cache.delete(key);this.#cacheBytes-=memory.size;}
    if(this.#pending.has(key))return structuredClone(await this.#pending.get(key));
    if(this.#store){let entry;try{entry=await this.#store.read(key);}catch(error){this.#storeHealthy=false;throw error;}const hit=this.#cachedValue(entry,key,query,formatter,'disk');if(hit){this.#remember(key,entry);this.#cacheHits++;return hit;}}
    // A disk lookup can yield. Recheck coalescing before admitting a new key.
    if(this.#pending.has(key))return structuredClone(await this.#pending.get(key));
    if(this.#cooldownUntil>this.#clock())throw this.#rateLimited();
    if(this.#pending.size>=this.#maxQueued){const failure=new ClientError('AIRPORT_EVENTS_QUEUE_FULL','Airport history request queue is full; cached and coalesced reads remain available');failure.retryAfterSeconds=Math.max(1,Math.ceil(this.#minInterval/1000));throw failure;}
    const pending=(async()=>{
      const task=this.#tail.then(async()=>{
        if(this.#store)try{this.#cooldownUntil=Math.max(this.#cooldownUntil,await this.#store.readCooldown());}catch(error){this.#storeHealthy=false;throw error;}
        if(this.#cooldownUntil>this.#clock())throw this.#rateLimited();
        const delay=this.#lastStart===null?0:Math.max(0,this.#lastStart+this.#minInterval-this.#clock());if(delay)await this.#sleep(delay);
        if(this.#cooldownUntil>this.#clock())throw this.#rateLimited();
        this.#active=true;
        try{
          const data=await this.#fetchDay(query),value=this.#render(data,query,formatter),now=this.#clock();
          const today=formatter?localDate(formatter,Math.floor(now/1000)):new Date(now).toISOString().slice(0,10);
          const ttl=Date.parse(date+'T00:00:00Z')<Date.parse(today+'T00:00:00Z')-86400000?7*86400000:60000;
          const entry={version:1,key,storedAt:now,expiresAt:now+ttl,...data};this.#remember(key,entry);
          if(this.#store)try{await this.#store.write(key,entry);}catch(error){this.#storeHealthy=false;throw error;}
          value.cache={hit:false,storage:this.#store?'disk_and_memory':'memory',storedAt:new Date(now).toISOString(),ageSeconds:0,ttlSeconds:ttl/1000};return value;
        }finally{this.#active=false;}
      });
      this.#tail=task.catch(()=>{});return task;
    })();
    this.#pending.set(key,pending);try{return structuredClone(await pending);}finally{if(this.#pending.get(key)===pending)this.#pending.delete(key);}
  }
  async #fetchDay({airportId,date,eventType}){
    if(!this.configured)throw new ClientError('AIRPORT_EVENTS_NOT_CONFIGURED','A separately provisioned FR24 airport session is required');
    let session;
    try{
      session=await this.#loadSession();
      if(session?.origin!==ORIGIN||typeof session.accessToken!=='string'||!session.accessToken||session.accessToken.length>16384||!/^[\x21-\x7e]+$/.test(session.accessToken)||typeof session.userAgent!=='string'||!session.userAgent||session.userAgent.length>2048||!/^[\x20-\x7e]+$/.test(session.userAgent))throw Error('session');
    }catch{throw new ClientError('AIRPORT_EVENTS_SESSION_INVALID','The configured airport session could not be loaded or validated');}
    const url=new URL(ORIGIN+'/api/v1/airport-history/'+airportId);url.search=new URLSearchParams({date,eventType});
    let response;
    this.#lastStart=this.#clock();this.#networkRequests++;
    try{response=await this.#fetch(url.href,{method:'GET',headers:{'Content-Type':'application/json',accept:'application/json',accessToken:session.accessToken,'User-Agent':session.userAgent,Referer:ORIGIN+'/'},redirect:'error',signal:AbortSignal.timeout(20000)});}
    catch(error){if(error?.code==='INTERACTION_REQUIRED')throw new ClientError('INTERACTION_REQUIRED','The provider browser requires human verification or account sign-in');throw new ClientError('AIRPORT_EVENTS_NETWORK_FAILED','Airport event request failed or timed out');}
    if(response.status===429){
      const raw=response.headers.get('retry-after')?.trim(),now=this.#clock();let until;
      if(raw&&/^\d+$/.test(raw)){const seconds=Number(raw);if(Number.isSafeInteger(seconds)&&seconds>=0&&now+seconds*1000<=253402300799000)until=now+seconds*1000;}
      else if(raw&&/^(?:[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT|[A-Za-z]+, \d{2}-[A-Za-z]{3}-\d{2} \d{2}:\d{2}:\d{2} GMT|[A-Za-z]{3} [A-Za-z]{3} [ \d]\d \d{2}:\d{2}:\d{2} \d{4})$/.test(raw)){const parsed=Date.parse(raw);if(Number.isFinite(parsed)&&parsed<=253402300799000)until=Math.max(now,parsed);}
      this.#cooldownUntil=Math.max(this.#cooldownUntil,until??now+60000);await response.body?.cancel().catch(()=>{});
      const failure=this.#rateLimited();if(this.#store)try{await this.#store.writeCooldown(this.#cooldownUntil);failure.cooldownPersisted=true;}catch{this.#storeHealthy=false;failure.cooldownPersisted=false;}throw failure;
    }
    if(!response.ok){await response.body?.cancel().catch(()=>{});throw new ClientError('HTTP_'+response.status,'Airport event provider returned HTTP '+response.status);}
    if(!/^application\/json(?:;|$)/i.test(response.headers.get('content-type')??'')){await response.body?.cancel().catch(()=>{});throw badResponse();}
    const payload=await readJson(response);
    if(!payload||!Array.isArray(payload.data)||payload.data.length>MAX_ROWS)throw badResponse();
    const keys=['type','time','flightId','originId','destinationId','runway','airlineId','aircraftType','registration','callsign','flightNumber','available','live'];
    return {payload:{data:payload.data.map(row=>row&&typeof row==='object'?Object.fromEntries(keys.map(key=>[key,row[key]])):null)},retrievedAt:new Date(this.#clock()).toISOString()};
  }
  #render({payload,retrievedAt},{airportId,date,eventType,timezone},formatter){
    if(!payload||typeof payload!=='object'||Array.isArray(payload)||!Array.isArray(payload.data)||payload.data.length>MAX_ROWS)throw badResponse();
    const unique=new Map();let duplicateRecords=0;
    for(const raw of payload.data){const row=normalize(raw,{airportId,date,eventType},formatter),key=JSON.stringify([row.flightId,row.eventType,row.eventTime]);if(unique.has(key)){duplicateRecords++;continue;}unique.set(key,row);}
    const records=[...unique.values()].sort((a,b)=>a.eventTime.localeCompare(b.eventTime));
    return {source:'Flightradar24 signed-in airport event history',dataKind:'actual_airport_events',airportId,requestedLocalDate:date,airportTimezone:timezone??null,eventType,
      retrievedAt,httpStatus:200,records,observedEventCount:records.length,actualLandingRecordCount:eventType==='landed'?records.length:null,
      distinctKnownFlightIds:new Set(records.map(row=>row.flightId)).size,uniqueObservedRegistrations:new Set(records.map(row=>row.registration?.toUpperCase()).filter(Boolean)).size,
      complete:false,exactCount:null,exactCargoArrivalCount:null,cargoClassificationAvailable:false,unknownCargoClassificationCount:records.length,
      coverage:{requestedDayIsAirportLocal:true,localDayValidated:!!formatter,sourceReturnedRows:payload.data.length,duplicateRecords,rowsTruncated:false,paginationAdvertised:false,sourceResponseDayComplete:false,allTrafficIncluded:false,
        earliestEvent:records[0]?.eventTime??null,latestEvent:records.at(-1)?.eventTime??null,routeDestinationUnknownCount:records.filter(row=>row.destinationId===null).length,
        routeOriginUnknownCount:records.filter(row=>row.originId===null).length,
        reason:'Actual detected airport events for one local date. The observed response contains a data array without pagination or a completeness assertion. No all-traffic census or cargo classification is established. Unknown planned destinations remain unknown; event airport comes from the requested source route.'}};
  }
}
