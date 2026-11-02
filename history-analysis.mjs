import {resolveAirports as defaultResolveAirports,resolveAirport as defaultResolveAirport} from './regions.mjs';
import {ClientError} from './session.mjs';

const invalid=()=>new ClientError('HISTORY_ANALYSIS_INPUT_INVALID','Provide a bounded event snapshot, exact ICAO aircraft types, a valid origin selector and supported grouping');
const text=value=>typeof value==='string'&&value.trim().length>0&&value.length<=200?value.trim():null;
const type=value=>typeof value==='string'&&/^[A-Z0-9]{2,4}$/.test(value.trim().toUpperCase())?value.trim().toUpperCase():null;
const id=value=>Number.isSafeInteger(value)&&value>0?value:null;
function instant(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value))return null;
  const ms=Date.parse(value);return Number.isFinite(ms)&&new Date(ms).toISOString().slice(0,19)===value.slice(0,19)?new Date(ms).toISOString():null;
}
const range=values=>{let first=null,last=null;for(const value of values)if(value){if(first===null||value<first)first=value;if(last===null||value>last)last=value;}return {first,last};};
function safeJob(job){
  const progress={};for(const key of ['completedRequestCount','plannedRequestCount','failedRequestCount','unqueriedRequestCount'])if(Number.isSafeInteger(job?.progress?.[key])&&job.progress[key]>=0)progress[key]=job.progress[key];
  return {jobId:typeof job?.jobId==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(job.jobId)?job.jobId:null,
    status:['queued','running','waiting','completed','partial_failed','interruption_required'].includes(job?.status)?job.status:null,
    updatedAt:instant(job?.updatedAt)?job.updatedAt:null,createdAt:instant(job?.createdAt)?job.createdAt:null,progress};
}

/** Analyze one caller-owned immutable archive snapshot. No provider or network access. */
export function analyzeHistoryRecords(args,{resolveAirports=defaultResolveAirports,resolveAirport=defaultResolveAirport}={}){
  if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!['records','job','aircraftTypes','originFilter','groupBy','maxGroups'].includes(k)))throw invalid();
  const {records,job,aircraftTypes,originFilter,groupBy='aircraftType',maxGroups=20}=args;
  if(!Array.isArray(records)||records.length>100000||!['aircraftType','originCountry','airlineId'].includes(groupBy)||!Number.isInteger(maxGroups)||maxGroups<1||maxGroups>50||typeof resolveAirports!=='function'||typeof resolveAirport!=='function'||(job!==undefined&&(!job||typeof job!=='object'||Array.isArray(job))))throw invalid();
  let selectedTypes=null,originIds=null;
  if(aircraftTypes!==undefined){
    if(!Array.isArray(aircraftTypes)||aircraftTypes.length<1||aircraftTypes.length>100||aircraftTypes.some(v=>!type(v)))throw invalid();
    selectedTypes=new Set(aircraftTypes.map(type));
  }
  if(originFilter!==undefined){
    if(!originFilter||typeof originFilter!=='object'||Array.isArray(originFilter)||Object.keys(originFilter).some(k=>!['selection','mode'].includes(k))||!['inside','outside'].includes(originFilter.mode))throw invalid();
    try{const result=resolveAirports(originFilter.selection);if(!Array.isArray(result?.airports)||result.airports.some(a=>!id(a?.id)))throw invalid();originIds=new Set(result.airports.map(a=>a.id));}catch{throw invalid();}
  }
  const unique=new Map();
  for(const row of records){
    const eventTime=instant(row?.eventTime);
    if(!row||typeof row!=='object'||Array.isArray(row)||!eventTime||!['landed','takeoff'].includes(row.eventType)||!id(row.eventAirportId)||(row.flightId!=null&&!text(row.flightId)))throw invalid();
    const key=JSON.stringify([row.flightId??null,eventTime,row.eventType,row.eventAirportId]);
    if(!unique.has(key))unique.set(key,{row,eventTime,aircraftType:type(row.aircraftType)});
  }
  const originCache=new Map(),groups=new Map(),registrations=new Set(),flightIds=new Set();
  const originCounts={inside:originIds?0:null,outside:originIds?0:null,unknown:0};
  const sourceTimes=[],matchedTimes=[],retrievedTimes=[];let unknownTypeCount=0,typeMatchingEvents=0,observedMatchingEvents=0;
  for(const item of unique.values()){
    const {row,eventTime,aircraftType}=item;sourceTimes.push(eventTime);retrievedTimes.push(instant(row.sourcePoint?.retrievedAt));
    if(!aircraftType)unknownTypeCount++;
    if(selectedTypes&&!selectedTypes.has(aircraftType))continue;
    typeMatchingEvents++;
    const originId=id(row.originId);
    if(originId&&!originCache.has(originId)){
      try{const airport=resolveAirport(originId);originCache.set(originId,id(airport?.id)===originId?airport:null);}catch{originCache.set(originId,null);}
    }
    const airport=originCache.get(originId)??null,originClass=airport?(originIds?(originIds.has(originId)?'inside':'outside'):'known'):'unknown';
    if(originClass!=='known')originCounts[originClass]++;
    if(originIds&&originClass!==originFilter.mode)continue;
    observedMatchingEvents++;matchedTimes.push(eventTime);
    const registration=text(row.registration)?.toUpperCase(),flightId=text(row.flightId);
    if(registration)registrations.add(registration);if(flightId)flightIds.add(flightId);
    const country=airport?.country?.alpha2;
    const key=groupBy==='aircraftType'?aircraftType:groupBy==='airlineId'?id(row.airlineId):(typeof country==='string'&&/^[A-Z]{2}$/.test(country)?country:null);
    const bucket=groups.get(key)??{key,observedMatchingEvents:0,registrations:new Set(),flightIds:new Set()};
    bucket.observedMatchingEvents++;if(registration)bucket.registrations.add(registration);if(flightId)bucket.flightIds.add(flightId);groups.set(key,bucket);
  }
  const sorted=[...groups.values()].sort((a,b)=>b.observedMatchingEvents-a.observedMatchingEvents||String(a.key).localeCompare(String(b.key)));
  return {source:'offline regional airport-event archive analysis',snapshot:{...safeJob(job),deduplicatedRecordCount:unique.size,reportedTimeRange:range(sourceTimes),sourceRetrievalTimeRange:range(retrievedTimes)},
    inputRecordCount:records.length,duplicateEventsRemoved:records.length-unique.size,typeMatchingEvents,observedMatchingEvents,
    distinctKnownFlightIds:flightIds.size,uniqueObservedRegistrations:registrations.size,unknownTypeCount,unknownOriginCount:originCounts.unknown,originCounts,
    filters:{aircraftTypes:selectedTypes?[...selectedTypes]:null,originMode:originFilter?.mode??null,selectedOriginAirportCount:originIds?.size??null},
    counterScopes:{unknownTypeCount:'All deduplicated snapshot events',originCounts:'After aircraft-type filtering, before origin filtering; inside/outside are null without an origin selector',matching:'After all filters; events, distinct known flight IDs and registrations are different grains'},
    groupBy,groupCount:sorted.length,omittedGroupCount:Math.max(0,sorted.length-maxGroups),groups:sorted.slice(0,maxGroups).map(g=>({key:g.key,observedMatchingEvents:g.observedMatchingEvents,distinctKnownFlightIds:g.flightIds.size,uniqueObservedRegistrations:g.registrations.size})),
    reportedTimeRange:range(matchedTimes),complete:false,exactCount:null,exactCargoArrivalCount:null,cargoClassificationAvailable:false,
    limitations:['Aircraft type is not verified cargo/service classification','Unknown or catalog-missing origins never qualify as outside','Counts cover retained observations in this one snapshot, not a complete traffic census']};
}
