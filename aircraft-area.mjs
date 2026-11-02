import {ClientError} from './session.mjs';
const invalid=()=>new ClientError('AIRCRAFT_AREA_INPUT_INVALID','Use valid WGS84 bounds, report age and output limits');
export class AircraftAreaService {
  constructor({live,session={authorization:async()=>({})},now=Date.now,fetchLimit=1000}){this.live=live;this.session=session;this.now=now;this.fetchLimit=fetchLimit;}
  async list({bbox,typeCode,registration,callsign,airborneOnly=true,maxAgeSeconds=300,limit=200}={}) {
    if(!Array.isArray(bbox)||bbox.length!==4||!bbox.every(Number.isFinite))throw invalid();
    const [west,south,east,north]=bbox;
    if(west< -180||east>180||south< -90||north>90||west>=east||south>=north||east-west>30||north-south>30||!Number.isInteger(maxAgeSeconds)||maxAgeSeconds<1||maxAgeSeconds>3600||!Number.isInteger(limit)||limit<1||limit>1000||typeof airborneOnly!=='boolean')throw invalid();
    for(const value of [typeCode,registration,callsign])if(value!==undefined&&(typeof value!=='string'||!value.trim()||value.length>30))throw invalid();
    const response=await this.live.query(this.session,{west,south,east,north},this.fetchLimit),at=this.now();
    const unique=new Map();
    for(const f of response.flights??[])if(Number.isInteger(f.flightId)) {
      const stamp=Number(f.timestampMs??(f.timestamp?Number(f.timestamp)*1000:NaN)),previous=unique.get(f.flightId);
      if(!previous||(Number.isFinite(stamp)&&(!Number.isFinite(previous.stamp)||stamp>previous.stamp)))unique.set(f.flightId,{f,stamp});
    }
    const aircraft=[];let staleReports=0,unknownTimeReports=0;
    for(const {f,stamp} of unique.values()) {
      if(!Number.isFinite(f.lat)||!Number.isFinite(f.lon)||f.lat<south||f.lat>north||f.lon<west||f.lon>east)continue;
      const extra=f.extraInfo??{};
      if(airborneOnly&&f.onGround===true)continue;
      if(typeCode&&(extra.type??'').toUpperCase()!==typeCode.trim().toUpperCase())continue;
      if(registration&&(extra.reg??'').toUpperCase()!==registration.trim().toUpperCase())continue;
      if(callsign&&(f.callsign??'').trim().toUpperCase()!==callsign.trim().toUpperCase())continue;
      const age=(at-stamp)/1000;
      if(!Number.isFinite(age)||age<0){unknownTimeReports++;continue;}
      if(age>maxAgeSeconds){staleReports++;continue;}
      aircraft.push({flightId:f.flightId,callsign:f.callsign??null,registration:extra.reg??null,typeCode:extra.type??null,latitude:f.lat,longitude:f.lon,altitudeFeet:Number.isFinite(f.alt)?f.alt:null,speedKnots:Number.isFinite(f.speed)?f.speed:null,trackDegrees:Number.isFinite(f.track)?f.track:null,onGround:f.onGround===true,reportedAt:new Date(stamp).toISOString(),ageSeconds:age,route:extra.route??null});
    }
    const sourceCapped=(response.flights?.length??0)>=this.fetchLimit;
    return {source:'Flightradar24 public LiveFeed',queriedAt:new Date(at).toISOString(),bbox,filters:{typeCode:typeCode??null,registration:registration??null,callsign:callsign??null,airborneOnly,maxAgeSeconds},count:aircraft.length,aircraft:aircraft.slice(0,limit),outputTruncated:aircraft.length>limit,sourceCapped,staleReports,unknownTimeReports,complete:false,actualAircraftCount:null,coverage:'Fresh tracked positions within requested rectangle only; reception coverage and aircraft without positions are not known. Type codes do not establish aircraft roles.'};
  }
  async count(args){const {aircraft,outputTruncated,...result}=await this.list(args);return result;}
}
