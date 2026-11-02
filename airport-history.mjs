import {ClientError,fetchJson,trustedUrl} from './session.mjs';

// APK vd/g.java:71 request; cc/k0.java:297 earlier-page cursor;
// gk/w0.java:57 initializes the anchor to current UNIX seconds.
const DEFAULT_ENDPOINT='https://mobile.flightradar24.com/common/v2/airport.json';
const invalid=()=>new ClientError('AIRPORT_HISTORY_INPUT_INVALID','Provide an IATA/ICAO airport, a UTC interval of at most 31 days and maxPages from 1 to 3; cargo filtering is unavailable on this board');
function utc(value) {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value))return NaN;
  const ms=Date.parse(value);return Number.isFinite(ms)&&new Date(ms).toISOString().slice(0,19)===value.slice(0,19)?ms:NaN;
}
const epoch=v=>Number.isInteger(v)&&v>0&&v<253402300800?v:null;
const string=v=>typeof v==='string'&&v.length<=500?v:null;
const code=v=>typeof v==='string'&&/^[A-Z]{3,4}$/.test(v.toUpperCase())?v.toUpperCase():null;
const codes=o=>[code(o?.iata),code(o?.icao)].filter(Boolean);

export class AirportHistoryService {
  #endpoint;#fetch;#clock;#cache=new Map();#pending=new Map();
  constructor({settings,fetch=globalThis.fetch,clock=Date.now}={}) {
    const endpoint=trustedUrl(settings?.urls?.search?.airport??DEFAULT_ENDPOINT);
    if(!['mobile.flightradar24.com','api.flightradar24.com'].includes(endpoint.hostname)||!/^\/common\/v[12]\/airport\.json$/.test(endpoint.pathname)||endpoint.search||endpoint.hash||endpoint.port)throw new ClientError('AIRPORT_HISTORY_CONFIG_INVALID','Invalid airport board endpoint');
    this.#endpoint=endpoint.href;this.#fetch=fetch;this.#clock=clock;
  }
  async getAirportArrivals(args) {
    if(!args||Object.keys(args).some(k=>!['airport','from','to','maxPages'].includes(k)))throw invalid();
    const airport=typeof args.airport==='string'?args.airport.trim().toUpperCase():'',fromMs=utc(args.from),toMs=utc(args.to),maxPages=args.maxPages??1;
    if(!/^[A-Z]{3,4}$/.test(airport)||!Number.isFinite(fromMs)||!Number.isFinite(toMs)||fromMs>=toMs||toMs-fromMs>31*86400000||!Number.isInteger(maxPages)||maxPages<1||maxPages>3)throw invalid();
    const query={airport,from:args.from,to:args.to,maxPages},key=JSON.stringify(query),cached=this.#cache.get(key);
    if(cached&&this.#clock()-cached.at<15000)return structuredClone(cached.value);
    if(this.#pending.has(key))return structuredClone(await this.#pending.get(key));
    const pending=this.#read(query,fromMs,toMs).then(value=>{
      if(this.#cache.size>=32)this.#cache.delete(this.#cache.keys().next().value);
      this.#cache.set(key,{at:this.#clock(),value});return value;
    });
    this.#pending.set(key,pending);
    try{return structuredClone(await pending);}finally{if(this.#pending.get(key)===pending)this.#pending.delete(key);}
  }
  async #read(query,fromMs,toMs) {
    let anchor=Math.floor(Math.min(toMs,this.#clock())/1000),stopReason='page_cap',airportCodes=[query.airport],timezone=null;
    const records=new Map(),pages=[],actualSeen=[];
    const excluded={invalidRows:0,missingActualArrival:0,notLanded:0,divertedAway:0,outsideInterval:0,duplicates:0};
    for(let step=0;step<query.maxPages;step++) {
      const url=new URL(this.#endpoint);
      for(const [k,v] of [['code',query.airport],['plugin[]','details'],['plugin[]','schedule'],['plugin-setting[schedule][mode]','arrivals'],['page','-1'],['limit','100'],['plugin-setting[schedule][timestamp]',String(anchor)],['device','android']])url.searchParams.append(k,v);
      let response;
      try{response=await fetchJson(url,{fetch:this.#fetch});}
      catch(error){if(!pages.length)throw error;stopReason=error instanceof ClientError?error.code:'SOURCE_FAILED';break;}
      const plugin=response?.result?.response?.airport?.pluginData,arrivals=plugin?.schedule?.arrivals;
      if(!Array.isArray(arrivals?.data)||arrivals.data.length>100||!codes(plugin.details?.code).includes(query.airport))throw new ClientError('AIRPORT_HISTORY_BAD_RESPONSE','Airport history response has invalid records or airport identity');
      airportCodes=codes(plugin.details.code);timezone=string(plugin.details.timezone?.name);
      const scheduled=[];
      for(const row of arrivals.data) {
        const f=row?.flight;if(!f||typeof f!=='object'){excluded.invalidRows++;continue;}
        const scheduledArrival=epoch(f.time?.scheduled?.arrival);if(scheduledArrival)scheduled.push(scheduledArrival);
        const actual=epoch(f.time?.real?.arrival);
        if(!actual){excluded.missingActualArrival++;continue;}actualSeen.push(actual);
        if(String(f.status?.generic?.status?.text).toLowerCase()!=='landed'){excluded.notLanded++;continue;}
        const realAirportCodes=codes(f.airport?.real?.code);
        if((realAirportCodes.length&&!realAirportCodes.some(c=>airportCodes.includes(c)))||(!realAirportCodes.length&&f.status?.generic?.status?.diverted)){excluded.divertedAway++;continue;}
        if(actual*1000<fromMs||actual*1000>=toMs){excluded.outsideInterval++;continue;}
        const flightId=string(f.identification?.id),sourceRowId=Number.isSafeInteger(f.identification?.row)?f.identification.row:null;
        const key=flightId?'flight:'+flightId:sourceRowId!==null?'row:'+sourceRowId:JSON.stringify([f.identification?.callsign,f.aircraft?.registration,actual]);
        if(records.has(key)){excluded.duplicates++;continue;}
        records.set(key,{flightId,sourceRowId,flightNumber:string(f.identification?.number?.default),callsign:string(f.identification?.callsign),registration:string(f.aircraft?.registration),aircraftType:string(f.aircraft?.model?.code),aircraftDescription:string(f.aircraft?.model?.text),airline:{name:string(f.airline?.name),iata:typeof f.airline?.code?.iata==='string'&&/^[A-Z0-9]{2}$/i.test(f.airline.code.iata)?f.airline.code.iata.toUpperCase():null,icao:code(f.airline?.code?.icao)},origin:{iata:code(f.airport?.origin?.code?.iata),icao:code(f.airport?.origin?.code?.icao)},destination:{iata:code(plugin.details.code.iata),icao:code(plugin.details.code.icao)},actualArrival:new Date(actual*1000).toISOString(),scheduledArrival:scheduledArrival?new Date(scheduledArrival*1000).toISOString():null,serviceCategory:null,cargoClassification:'unavailable from airport board',identityBasis:flightId?'FR24 flight ID':sourceRowId!==null?'scheduled board row':'callsign, registration and actual arrival composite'});
      }
      pages.push({anchorRequested:new Date(anchor*1000).toISOString(),sourcePageCurrent:Number.isInteger(arrivals.page?.current)?arrivals.page.current:null,sourcePageTotal:Number.isInteger(arrivals.page?.total)?arrivals.page.total:null,returnedRows:arrivals.data.length});
      if(arrivals.data.length<100){stopReason='short_board_page';break;}
      const next=scheduled.length?Math.min(...scheduled):null;
      if(next===null||next>=anchor){stopReason='cursor_did_not_advance';break;}
      if(next*1000<fromMs){stopReason='scheduled_anchor_precedes_requested_start';break;}
      anchor=next;
    }
    const values=[...records.values()].sort((a,b)=>a.actualArrival.localeCompare(b.actualArrival));
    return {source:'Flightradar24 APK airport schedule board',airport:query.airport,airportCodes,timezone,requestedInterval:{from:query.from,to:query.to,endExclusive:true},queriedAt:new Date(this.#clock()).toISOString(),records:values,actualArrivalRecordCount:values.length,distinctKnownFlightIds:new Set(values.map(r=>r.flightId).filter(Boolean)).size,uniqueObservedRegistrations:new Set(values.map(r=>r.registration).filter(Boolean)).size,complete:false,exactCount:null,exactCargoArrivalCount:null,cargoClassificationAvailable:false,excluded,coverage:{intervalComplete:false,allTrafficIncluded:false,boardPagesExhausted:stopReason==='short_board_page',pagesFetched:pages.length,maxPages:query.maxPages,stopReason,pages,earliestActualSeen:actualSeen.length?new Date(Math.min(...actualSeen)*1000).toISOString():null,latestActualSeen:actualSeen.length?new Date(Math.max(...actualSeen)*1000).toISOString():null,reason:'The scheduled airport board excludes unscheduled traffic and does not establish complete historical interval access. Exhausting pages does not prove an exact monthly census. Cargo classification is absent.'}};
  }
}
const defaultService=new AirportHistoryService();
export const getAirportArrivals=args=>defaultService.getAirportArrivals(args);
