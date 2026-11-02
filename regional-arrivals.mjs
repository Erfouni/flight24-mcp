import {resolveAirports} from './regions.mjs';
import {AirportHistoryService} from './airport-history.mjs';
import {ClientError} from './session.mjs';

const invalid=()=>new ClientError('REGIONAL_ARRIVALS_INPUT_INVALID','Provide one region selection, a UTC interval of at most 31 days, maxAirports from 1 to 10, a nonnegative airportOffset and maxPages from 1 to 3');
function utc(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value))return NaN;
  const ms=Date.parse(value);return Number.isFinite(ms)&&new Date(ms).toISOString().slice(0,19)===value.slice(0,19)?ms:NaN;
}
const text=value=>typeof value==='string'&&value.trim()&&value.length<=500?value.trim():null;
const airportCode=value=>typeof value==='string'&&/^[A-Z]{3,4}$/i.test(value)?value.toUpperCase():null;
function safeCode(error){
  const code=error?.code;
  return typeof code==='string'&&(/^HTTP_[1-5]\d{2}$/.test(code)||['TIMEOUT','NETWORK_ERROR','FETCH_FAILED','AIRPORT_HISTORY_BAD_RESPONSE','AIRPORT_CODE_UNAVAILABLE'].includes(code))?code:'SOURCE_FAILED';
}
const airportSummary=airport=>({id:airport.id,iata:airport.iata,icao:airport.icao,name:airport.name,country:airport.country.alpha2,timezone:airport.timezone});

/** Observations from a bounded set of scheduled boards, never a full traffic census. */
export class RegionalArrivalsService {
  #history;#clock;
  constructor({airportHistory=new AirportHistoryService(),clock=Date.now}={}){
    if(typeof airportHistory?.getAirportArrivals!=='function')throw new ClientError('REGIONAL_ARRIVALS_CONFIG_INVALID','An airport history service is required');
    this.#history=airportHistory;this.#clock=clock;
  }
  async getRegionalArrivals(args){
    if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(key=>!['selection','from','to','maxAirports','airportOffset','maxPages'].includes(key)))throw invalid();
    const {selection,from,to}=args,maxAirports=args.maxAirports??3,airportOffset=args.airportOffset??0,maxPages=args.maxPages??1;
    const fromMs=utc(from),toMs=utc(to);
    if(!Number.isFinite(fromMs)||!Number.isFinite(toMs)||fromMs>=toMs||toMs-fromMs>31*86400000||!Number.isInteger(maxAirports)||maxAirports<1||maxAirports>10||!Number.isSafeInteger(airportOffset)||airportOffset<0||!Number.isInteger(maxPages)||maxPages<1||maxPages>3)throw invalid();
    const resolved=resolveAirports(selection),airports=resolved.airports.slice(airportOffset,airportOffset+maxAirports);
    const selectedCodes=new Set(resolved.airports.flatMap(a=>[airportCode(a.iata),airportCode(a.icao)]).filter(Boolean));
    const outcomes=new Array(airports.length);let cursor=0;
    const worker=async()=>{
      while(cursor<airports.length){
        const index=cursor++,airport=airports[index];
        try{
          const code=airportCode(airport.iata)??airportCode(airport.icao);
          if(!code)throw {code:'AIRPORT_CODE_UNAVAILABLE'};
          const result=await this.#history.getAirportArrivals({airport:code,from,to,maxPages});
          if(!Array.isArray(result?.records)||result.records.length>300)throw {code:'AIRPORT_HISTORY_BAD_RESPONSE'};
          outcomes[index]={airport,result};
        }catch(error){outcomes[index]={airport,error:safeCode(error)};}
      }
    };
    await Promise.all(Array.from({length:Math.min(3,airports.length)},worker));
    const records=new Map(),failures=[],airportResults=[];
    const excluded={invalidRows:0,invalidActualArrival:0,outsideInterval:0,destinationOutsideSelection:0};
    let duplicateRecords=0,successfulAirportCount=0;
    for(const {airport,result,error} of outcomes){
      if(error){failures.push({airport:airportSummary(airport),code:error});continue;}
      successfulAirportCount++;
      // Preserve the source coverage, including a later-page failure, without error bodies.
      const stopReason=result.coverage?.stopReason;
      const sourceFailure=typeof stopReason==='string'&&(/^(HTTP_|SOURCE_FAILED|TIMEOUT|NETWORK_ERROR|FETCH_FAILED)/.test(stopReason));
      const coverage={pagesFetched:Number.isInteger(result.coverage?.pagesFetched)?result.coverage.pagesFetched:null,stopReason:['page_cap','short_board_page','cursor_did_not_advance','scheduled_anchor_precedes_requested_start'].includes(stopReason)?stopReason:stopReason?safeCode({code:stopReason}):null};
      airportResults.push({airport:airportSummary(airport),coverage});
      if(sourceFailure)failures.push({airport:airportSummary(airport),code:safeCode({code:stopReason}),partialResult:true});
      for(const row of result.records){
        if(!row||typeof row!=='object'||Array.isArray(row)){excluded.invalidRows++;continue;}
        const arrival=utc(row.actualArrival);
        if(!Number.isFinite(arrival)){excluded.invalidActualArrival++;continue;}
        if(arrival<fromMs||arrival>=toMs){excluded.outsideInterval++;continue;}
        const destinationCodes=[airportCode(row.destination?.iata),airportCode(row.destination?.icao)].filter(Boolean);
        if(!destinationCodes.some(code=>selectedCodes.has(code))){excluded.destinationOutsideSelection++;continue;}
        const flightId=text(row.flightId),registration=text(row.registration);
        const fallback=Number.isSafeInteger(row.sourceRowId)?['row',row.sourceRowId]:['composite',arrival,registration,text(row.callsign),text(row.flightNumber)];
        const key=flightId?'flight:'+flightId:JSON.stringify([airport.id,...fallback]);
        if(records.has(key)){duplicateRecords++;continue;}
        records.set(key,{...structuredClone(row),flightId,registration,actualArrival:new Date(arrival).toISOString(),serviceCategory:null,cargoClassification:'unavailable from airport board',regionalIdentityBasis:flightId?'FR24 flight ID':'per-airport fallback; unique flight leg unverified'});
      }
    }
    const values=[...records.values()].sort((a,b)=>a.actualArrival.localeCompare(b.actualArrival));
    const unavailable=airports.length>0&&successfulAirportCount===0;
    const countsUnavailable=unavailable||(resolved.count>0&&airports.length===0);
    const status=unavailable?'unavailable':resolved.count===0?'no_selected_airports':airports.length===0?'no_airports_in_window':'partial';
    return {
      source:'Flightradar24 APK airport schedule boards',status,scope:'airport_destinations',selection:resolved.selection,catalog:resolved.catalog,
      requestedInterval:{from,to,endExclusive:true},queriedAt:new Date(this.#clock()).toISOString(),maxAirports,airportOffset,maxPages,
      airports:airports.map(airportSummary),records:values,
      observedFlightLegCount:countsUnavailable?null:values.length,actualArrivalRecordCount:countsUnavailable?null:values.length,
      distinctKnownFlightIds:countsUnavailable?null:new Set(values.map(row=>row.flightId).filter(Boolean)).size,
      uniqueObservedRegistrations:countsUnavailable?null:new Set(values.map(row=>row.registration?.toUpperCase()).filter(Boolean)).size,
      unknownCargoClassificationCount:countsUnavailable?null:values.length,cargoClassificationAvailable:false,
      complete:false,exactCount:null,exactCargoArrivalCount:null,excluded,failures,airportResults,
      coverage:{selectedAirportCount:resolved.count,queriedAirportCount:airports.length,successfulAirportCount,failedAirportCount:outcomes.filter(o=>o.error).length,
        unqueriedAirportCount:resolved.count-airports.length,partialFailure:failures.length>0,allSelectedAirportsQueried:resolved.count===airports.length,
        intervalComplete:false,allTrafficIncluded:false,overflightsIncluded:false,airspaceBoundary:false,duplicateRecords,
        fallbackIdentityRecordCount:values.filter(row=>!row.flightId).length,
        reason:'Bounded observations from scheduled airport boards in a dated airport catalog. These boards do not establish complete historical traffic or cargo coverage. Flight legs and aircraft registrations are separate counts; per-airport fallback identities cannot prove distinct legs. No route, role or cargo category is inferred.'}
    };
  }
}
const defaultService=new RegionalArrivalsService();
export const getRegionalArrivals=args=>defaultService.getRegionalArrivals(args);
