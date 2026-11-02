import {readFileSync} from 'node:fs';
import {ClientError} from './session.mjs';
const catalog=JSON.parse(readFileSync(new URL('./airlines.json',import.meta.url),'utf8')).rows;
const normalize=s=>s.normalize('NFKC').replace(/ي/g,'ی').replace(/ك/g,'ک').toLowerCase().replace(/[\s\u200c\u200d_-]+/g,'');
const aliases={'ماهان':'IRM','ماهانایر':'IRM','ایرانایر':'IRA','هما':'IRA','امارات':'UAE','قطر':'QTR','قطرایرویز':'QTR','ترکیش':'THY','ترکیشایرلاینز':'THY','آسمان':'IRC','کاسپین':'CPN','وارش':'VRH','کیشایر':'KIS'};
export function resolveAirline(query) {
  if (typeof query!=='string' || !query.trim() || query.length>120) throw new ClientError('AIRLINE_INVALID','Provide an airline name or IATA/ICAO code');
  const key=normalize(query), code=aliases[key]||query.trim().toUpperCase();
  const active=catalog.filter(r=>r.active!==false);
  let matches=active.filter(r=>r.icao===code);
  if (!matches.length) matches=active.filter(r=>r.iata===code);
  if (!matches.length) matches=active.filter(r=>normalize(r.name)===key);
  if (!matches.length && key.length>=3) matches=active.filter(r=>normalize(r.name).includes(key));
  if (!matches.length) throw new ClientError('AIRLINE_UNKNOWN','Airline not found; use its ICAO code or full name');
  if (matches.length!==1) throw new ClientError('AIRLINE_AMBIGUOUS','Airline is ambiguous: '+matches.slice(0,5).map(r=>r.name+' ('+r.icao+')').join(', '));
  const {id,name,icao,iata}=matches[0];return {id,name,icao,iata};
}
export class AirlineService {
  constructor({live,session={authorization:async()=>({})},fetchLimit=1000}) {this.live=live;this.session=session;this.fetchLimit=fetchLimit;}
  async #fetch(query) {
    const airline=resolveAirline(query);
    const result=await this.live.queryAirline(this.session,airline.icao,this.fetchLimit);
    const raw=result.flights||[];
    const flights=[...new Map(raw.filter(f=>f.onGround!==true).map(f=>[f.flightId,f])).values()];
    const complete=raw.length<this.fetchLimit;
    return {source:'Flightradar24',airline,count:flights.length,complete,countMeaning:complete?'tracked airborne flights returned by the airline-filtered query':'at least this many; the response reached its fetch limit',operatorBasis:'operated_by',queriedAt:new Date().toISOString(),serverTime:result.serverTimeMs?new Date(Number(result.serverTimeMs)).toISOString():null,maxReportAgeSeconds:300,coverage:'Aircraft visible in the Flightradar24 feed; aircraft outside tracking coverage are not included',flights};
  }
  async count(query) {const {flights,...result}=await this.#fetch(query);return result;}
  async list(query,limit=100) {
    if (!Number.isInteger(limit)||limit<1||limit>200) throw new ClientError('LIMIT_INVALID','List limit must be from 1 to 200');
    const result=await this.#fetch(query);const displayed=result.flights.slice(0,limit);
    return {...result,flights:displayed,listed:displayed.length,listTruncated:displayed.length<result.count};
  }
}
