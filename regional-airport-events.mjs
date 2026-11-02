import {resolveAirports as defaultResolveAirports} from './regions.mjs';
import {ClientError} from './session.mjs';

const MAX_RECORDS=100000,DAY_MS=86400000;
const invalid=()=>new ClientError('REGIONAL_AIRPORT_EVENTS_INPUT_INVALID','Provide one airport region, inclusive YYYY-MM-DD local dates spanning at most 31 days, landed/takeoff, requestOffset >= 0 and maxRequests from 1 to 12');
const badResponse=()=>new ClientError('AIRPORT_EVENTS_BAD_RESPONSE','Airport events returned mismatched or invalid records');
function dateMs(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return NaN;
  const time=Date.parse(value+'T00:00:00Z');return Number.isFinite(time)&&new Date(time).toISOString().slice(0,10)===value?time:NaN;
}
function instant(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value))return NaN;
  const ms=Date.parse(value);return Number.isFinite(ms)&&new Date(ms).toISOString().slice(0,19)===value.slice(0,19)?ms:NaN;
}
function safeCode(error){const code=error?.code;return typeof code==='string'&&(/^HTTP_[1-5]\d{2}$/.test(code)||['INTERACTION_REQUIRED','AIRPORT_TIMEZONE_UNAVAILABLE','AIRPORT_EVENTS_BAD_RESPONSE','AIRPORT_EVENTS_NOT_CONFIGURED','AIRPORT_EVENTS_SESSION_INVALID','AIRPORT_EVENTS_NETWORK_FAILED','AIRPORT_EVENTS_QUEUE_FULL','AIRPORT_EVENTS_CACHE_FAILED','AIRPORT_EVENTS_CACHE_UNSAFE'].includes(code))?code:'SOURCE_FAILED';}
function safeRetry(error){return {retryAt:Number.isFinite(instant(error?.retryAt))?new Date(error.retryAt).toISOString():null,retryAfterSeconds:Number.isSafeInteger(error?.retryAfterSeconds)&&error.retryAfterSeconds>=0?error.retryAfterSeconds:null};}
function localDate(formatter,ms){const parts=Object.fromEntries(formatter.formatToParts(ms).map(p=>[p.type,p.value]));return parts.year+'-'+parts.month+'-'+parts.day;}
const airportInfo=a=>({id:a.id,iata:a.iata??null,icao:a.icao??null,name:a.name??null,timezone:a.timezone??null});

/** Bounded observations across each selected airport's own local calendar days. */
export class RegionalAirportEventsService{
  #events;#resolve;
  constructor({airportEvents,resolveAirports=defaultResolveAirports}={}){
    if(typeof airportEvents?.getAirportEvents!=='function'||typeof resolveAirports!=='function')throw new ClientError('REGIONAL_AIRPORT_EVENTS_CONFIG_INVALID','An airport events service and source airport resolver are required');
    this.#events=airportEvents;this.#resolve=resolveAirports;
  }
  #plan(args){
    if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(key=>!['selection','fromDate','toDate','eventType','requestOffset','maxRequests'].includes(key)))throw invalid();
    const {selection,fromDate,toDate,eventType='landed',requestOffset=0,maxRequests=3}=args,start=dateMs(fromDate),end=dateMs(toDate);
    if(!Number.isFinite(start)||!Number.isFinite(end)||start>end||(end-start)/DAY_MS>=31||!['landed','takeoff'].includes(eventType)||!Number.isSafeInteger(requestOffset)||requestOffset<0||!Number.isInteger(maxRequests)||maxRequests<1||maxRequests>12)throw invalid();
    const resolved=this.#resolve(selection),airports=[...resolved.airports].sort((a,b)=>a.id-b.id),dayCount=(end-start)/DAY_MS+1;
    return {selection,fromDate,toDate,eventType,requestOffset,maxRequests,start,end,resolved,airports,dayCount};
  }
  describeRegionalAirportEvents(args){
    const {selection,fromDate,toDate,eventType,resolved,airports,dayCount}=this.#plan(args);
    return {query:{selection:airports.length?{airports:airports.map(a=>a.id)}:structuredClone(selection),fromDate,toDate,eventType},selection:resolved.selection,catalog:resolved.catalog,plannedRequestCount:airports.length*dayCount,selectedAirportCount:airports.length};
  }
  async getRegionalAirportEvents(args){
    const {fromDate,toDate,eventType,requestOffset,maxRequests,start,resolved,airports,dayCount}=this.#plan(args);
    const plannedRequestCount=airports.length*dayCount,windowEnd=Math.min(plannedRequestCount,requestOffset+maxRequests),plan=[];
    for(let index=requestOffset;index<windowEnd;index++){
      const airport=airports[Math.floor(index/dayCount)],date=new Date(start+(index%dayCount)*DAY_MS).toISOString().slice(0,10);
      plan.push({index,airport,date,eventType});
    }
    const outcomes=[];
      for(const request of plan){
        const airport=request.airport;
        try{
          let formatter;
          try{if(typeof airport.timezone!=='string'||!airport.timezone||airport.timezoneValid===false)throw Error('timezone');formatter=new Intl.DateTimeFormat('en-US',{timeZone:airport.timezone,year:'numeric',month:'2-digit',day:'2-digit'});}catch{throw {code:'AIRPORT_TIMEZONE_UNAVAILABLE'};}
          const result=await this.#events.getAirportEvents({airportId:airport.id,date:request.date,eventType,timezone:airport.timezone});
          if(!Array.isArray(result?.records)||result.records.length>20000)throw badResponse();
          const records=result.records.map(row=>{
            const ms=instant(row?.eventTime);
            if(!row||row.eventAirportId!==airport.id||row.eventType!==eventType||typeof row.flightId!=='string'||!row.flightId||row.flightId.length>200||!Number.isFinite(ms)||localDate(formatter,ms)!==request.date||(row.registration!=null&&typeof row.registration!=='string'))throw badResponse();
            return {...structuredClone(row),eventTime:new Date(ms).toISOString(),serviceCategory:null,cargoClassification:'unavailable from airport event response'};
          });
          outcomes.push({request,records,sourceRetrievedAt:Number.isFinite(instant(result.retrievedAt))?new Date(result.retrievedAt).toISOString():null});
        }catch(error){outcomes.push({request,error:safeCode(error),...safeRetry(error)});break;}
      }
    const unique=new Map(),failures=[],requests=[];let duplicateRecords=0,completedRequestCount=0;
    for(const {request,records,error,retryAt,retryAfterSeconds,sourceRetrievedAt}of outcomes){
      const sourcePoint={requestIndex:request.index,airport:airportInfo(request.airport),date:request.date,eventType};
      if(error){failures.push({...sourcePoint,code:error,retryAt,retryAfterSeconds});requests.push({...sourcePoint,status:'failed',code:error,retryAt,retryAfterSeconds});continue;}
      completedRequestCount++;requests.push({...sourcePoint,status:'observed',retrievedAt:sourceRetrievedAt,returnedRecordCount:records.length,sourceComplete:false});
      for(const row of records){
        const key=JSON.stringify([row.flightId,row.eventTime,row.eventType]);
        if(unique.has(key)){duplicateRecords++;continue;}
        if(unique.size>=MAX_RECORDS)throw new ClientError('REGIONAL_AIRPORT_EVENTS_TOO_LARGE','Regional events exceed the 100000 distinct-record bound; use a smaller request window');
        unique.set(key,{...row,sourcePoint:{airportId:request.airport.id,localDate:request.date,timezone:request.airport.timezone,retrievedAt:sourceRetrievedAt}});
      }
    }
    const records=[...unique.values()].sort((a,b)=>a.eventTime.localeCompare(b.eventTime)),unknown=airports.length>0&&completedRequestCount===0;
    const firstUnprocessed=failures[0]?.requestIndex??windowEnd;
    const unqueriedRequests=plan.slice(outcomes.length).map(request=>({requestIndex:request.index,airport:airportInfo(request.airport),date:request.date,eventType,status:'unqueried'}));
    return {source:'Flightradar24 signed-in actual airport event history',status:plan.length?(completedRequestCount?'partial':'unavailable'):airports.length?'no_requests_in_window':'no_selected_airports',
      scope:'airport_events',selection:resolved.selection,catalog:resolved.catalog,eventType,requestedLocalDateRange:{fromDate,toDate,bothInclusive:true,daysPerAirport:dayCount},
      calendarMeaning:'Each selected airport uses its source IANA timezone. Identical date labels represent different UTC intervals across airports; this is not one common UTC interval.',
      requestOffset,maxRequests,nextOffset:firstUnprocessed<plannedRequestCount?firstUnprocessed:null,retryAt:failures[0]?.retryAt??null,retryAfterSeconds:failures[0]?.retryAfterSeconds??null,requests,failures,unqueriedRequests,unqueriedRequestsScope:'current_window',records,
      observedEventCount:unknown?null:records.length,actualLandingRecordCount:unknown||eventType!=='landed'?null:records.length,
      distinctKnownFlightIds:unknown?null:new Set(records.map(row=>row.flightId)).size,uniqueObservedRegistrations:unknown?null:new Set(records.map(row=>row.registration?.trim().toUpperCase()).filter(Boolean)).size,
      unknownCargoClassificationCount:unknown?null:records.length,cargoClassificationAvailable:false,complete:false,exactCount:null,exactCargoArrivalCount:null,
      coverage:{selectedAirportCount:airports.length,queriedAirportCount:new Set(outcomes.map(p=>p.request.airport.id)).size,plannedRequestCount,attemptedRequestCount:outcomes.length,completedRequestCount,failedRequestCount:failures.length,
        unqueriedRequestCount:plannedRequestCount-outcomes.length,requestsBeforeWindow:Math.min(requestOffset,plannedRequestCount),remainingRequestsAfterWindow:Math.max(0,plannedRequestCount-firstUnprocessed),partialFailure:failures.length>0,
        allPlannedRequestsAttemptedThisCall:outcomes.length===plannedRequestCount,sourceComplete:false,allTrafficIncluded:false,overflightsIncluded:false,duplicateRecords,rowsTruncated:false,
        earliestEvent:records[0]?.eventTime??null,latestEvent:records.at(-1)?.eventTime??null,
        reason:'Only this bounded call is aggregated. Other request offsets must be fetched and deduplicated separately. Every source day remains incomplete as a traffic census; cargo roles and categories are unavailable, and landing events are not unique aircraft or distinct flight legs.'}};
  }
}
