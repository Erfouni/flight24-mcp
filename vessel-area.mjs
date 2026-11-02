// Public route and base schema verified against the MIT-licensed upstream
// tools-mcp/vessel-traffic-mcp AIS Friends adapter and a bounded live JSON read.
const ORIGIN = 'https://www.aisfriends.com';
const MAX_BYTES = 2 * 1024 * 1024;
const CACHE_MS = 30000;
const SOURCE = { provider:'AIS Friends public map', landingUrl:ORIGIN+'/', endpoint:ORIGIN+'/vessels/bounding-box' };
const SECONDARY = {provider:'MyShipTracking public map',landingUrl:'https://www.myshiptracking.com/',endpoint:'https://www.myshiptracking.com/requests/vesselsonmaptempTTT.php'};
const number = value => (typeof value === 'number' || (typeof value === 'string' && value.trim())) && Number.isFinite(Number(value)) ? Number(value) : null;
const string = value => typeof value === 'string' && value.trim() ? value.trim().slice(0,150) : null;

function validate(query) {
  const {bbox,polygon}=query;
  if(!Array.isArray(bbox)||bbox.length!==4||!bbox.every(Number.isFinite)) throw new Error('bbox must be [west,south,east,north] with finite coordinates');
  const [w,s,e,n]=bbox;
  if(w < -180||e > 180||s < -90||n > 90||w>=e||s>=n) throw new Error('Invalid bbox coordinate bounds or ordering');
  if(e-w>10||n-s>10||(e-w)*(n-s)>25) throw new Error('Use a small bounded region no larger than 25 square degrees and 10 degrees per side');
  const type=query.type??'all',maxAgeSeconds=query.maxAgeSeconds??1800,limit=query.limit??200;
  if(!['all','tanker'].includes(type)) throw new Error('type must be all or tanker; oil subtypes are not established by this feed');
  if(!Number.isInteger(maxAgeSeconds)||maxAgeSeconds<1||maxAgeSeconds>86400) throw new Error('Maximum report age must be an integer from 1 to 86400 seconds');
  if(!Number.isInteger(limit)||limit<1||limit>2000) throw new Error('limit must be an integer from 1 to 2000');
  if(polygon!==undefined&&(!Array.isArray(polygon)||polygon.length<3||polygon.length>100||!polygon.every(p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite)&&p[0]>=w&&p[0]<=e&&p[1]>=s&&p[1]<=n))) throw new Error('polygon must contain 3 to 100 [longitude,latitude] vertices inside bbox');
  return {bbox:[...bbox],polygon,type,maxAgeSeconds,limit};
}

function insidePolygon(x,y,vertices) {
  let inside=false;
  for(let i=0,j=vertices.length-1;i<vertices.length;j=i++) {
    const [xi,yi]=vertices[i],[xj,yj]=vertices[j];
    const cross=(x-xi)*(yj-yi)-(y-yi)*(xj-xi);
    if(Math.abs(cross)<1e-10&&x>=Math.min(xi,xj)-1e-10&&x<=Math.max(xi,xj)+1e-10&&y>=Math.min(yi,yj)-1e-10&&y<=Math.max(yi,yj)+1e-10)return true;
    if((yi>y)!==(yj>y)&&x<(xj-xi)*(y-yi)/(yj-yi)+xi)inside=!inside;
  }
  return inside;
}

function normalize(row,provider=SOURCE.provider) {
  if(!row||typeof row!=='object'||!/^\d{9}$/.test(String(row.mmsi)))return null;
  const latitude=number(row.latitude),longitude=number(row.longitude);
  if(latitude===null||longitude===null||Math.abs(latitude)>90||Math.abs(longitude)>180)return null;
  const timestamp=number(row.timestamp_of_position);
  const reportSeconds=Number.isInteger(timestamp)&&timestamp>=946684800&&timestamp<=4102444800?timestamp:null;
  const rawType=number(row.ship_type_id);
  const aisType=Number.isInteger(rawType)&&rawType>=10&&rawType<=99?rawType:null;
  return { mmsi:String(row.mmsi),imo:/^\d{7}$/.test(String(row.imo))?String(row.imo):null,
    name:string(row.name)??string(row.name_ais),flag:string(row.flag),latitude,longitude,
    aisType,providerSubtypeId:number(row.detailed_type_id),providerTypeLiteral:string(row.ship_type_name)??string(row.vessel_type)??null,
    provider,providerTypeCode:provider===SECONDARY.provider?string(row.compactTypeCode):null,
    category:provider===SECONDARY.provider?(String(row.compactTypeCode)==='8'?'tanker':row.compactTypeCode==null?'unknown':'other'):aisType===null?'unknown':aisType>=80&&aisType<=89?'tanker':'other',
    reportSeconds,reportedAt:reportSeconds===null?null:new Date(reportSeconds*1000).toISOString(),
    speedKnots:number(row.speed_over_ground),navigationStatus:number(row.navigational_status_id),
  };
}

function parseSecondary(body) {
  const lines=body.split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
  if(lines.length<2||!/^\d{10}$/.test(lines[0]))throw new Error('Invalid MyShipTracking area response');
  return lines.slice(2).filter(l=>l.includes('\t')).map(line=>{
    const p=line.split('\t');
    const timestamp=p.slice(9).map(number).find(n=>Number.isInteger(n)&&n>=946684800&&n<=4102444800);
    return {mmsi:p[2],name:p[3],latitude:p[4],longitude:p[5],speed_over_ground:p[6],compactTypeCode:p[0],timestamp_of_position:timestamp};
  });
}

export class VesselAreaService {
  constructor({fetchImpl=fetch,now=Date.now}={}) {this.fetchImpl=fetchImpl;this.now=now;this.cache=new Map();this.lastRequestAt=new Map();}

  async snapshot(bbox,secondary=false) {
    const source=secondary?SECONDARY:SOURCE;
    const key=source.provider+':'+bbox.join(','),cached=this.cache.get(key),now=this.now();
    if(cached&&now-cached.startedAt<CACHE_MS)return cached.promise;
    const last=this.lastRequestAt.get(source.provider);
    if(last!==undefined&&now-last<5000)throw new Error('Area provider is rate limited; wait at least five seconds between uncached requests');
    this.lastRequestAt.set(source.provider,now);
    const promise=(async()=>{
      const url=new URL(source.endpoint);
      const params=secondary?{type:'json',minlat:bbox[1],maxlat:bbox[3],minlon:bbox[0],maxlon:bbox[2],zoom:9,selid:0,seltype:0,timecode:0,filters:'{}'}:{lon_min:bbox[0],lat_min:bbox[1],lon_max:bbox[2],lat_max:bbox[3],zoom:8};
      for(const [key,value]of Object.entries(params))url.searchParams.set(key,String(value));
      const response=await this.fetchImpl(url,{headers:{accept:'application/json,text/plain,*/*',referer:source.landingUrl},redirect:'error',signal:AbortSignal.timeout(20000)});
      if(!response.ok){await response.body?.cancel();throw new Error(`${source.provider} area request failed with HTTP ${response.status}`);}
      if(Number(response.headers.get('content-length'))>MAX_BYTES){await response.body?.cancel();throw new Error('AIS Friends response too large');}
      const chunks=[];let bytes=0;
      for await(const chunk of response.body??[]){bytes+=chunk.byteLength;if(bytes>MAX_BYTES)throw new Error('AIS Friends response too large');chunks.push(Buffer.from(chunk));}
      const body=Buffer.concat(chunks,bytes).toString('utf8');
      const rows=secondary?parseSecondary(body):JSON.parse(body);
      if(!Array.isArray(rows)||rows.length>20000)throw new Error('Invalid AIS Friends area response: expected bounded vessel array');
      return {rows,retrievedAt:new Date(this.now()).toISOString(),source};
    })();
    this.cache.set(key,{startedAt:now,promise});
    while(this.cache.size>16)this.cache.delete(this.cache.keys().next().value);
    try{return await promise;}catch(error){this.cache.delete(key);throw error;}
  }

  async list(query={}) {
    const q=validate(query),snapshots=[],providerAttempts=[];
    try{snapshots.push(await this.snapshot(q.bbox));providerAttempts.push({provider:SOURCE.provider,status:'ok'});}catch(error){providerAttempts.push({provider:SOURCE.provider,status:'unavailable',message:error.message});}
    let result=snapshots.length?this.measure(q,snapshots,providerAttempts):null;
    if(!result||result.count===0){
      try{snapshots.push(await this.snapshot(q.bbox,true));providerAttempts.push({provider:SECONDARY.provider,status:'ok'});}catch(error){providerAttempts.push({provider:SECONDARY.provider,status:'unavailable',message:error.message});}
      if(!snapshots.length)throw new Error(providerAttempts.map(p=>p.message).join('; '));
      result=this.measure(q,snapshots,providerAttempts);
    }
    return result;
  }

  measure(q,snapshots,providerAttempts,includePerProvider=true) {
    const now=this.now(),snapshot=snapshots.at(-1);
    const statistics={receivedRows:snapshots.reduce((n,s)=>n+s.rows.length,0),invalidRows:0,duplicateRows:0,outsideAreaCount:0,unknownTypeCount:0,filteredTypeCount:0,staleCount:0,unknownReportTimeCount:0,futureReportTimeCount:0,activeCount:0};
    const unique=new Map();
    for(const sourceSnapshot of snapshots)for(const row of sourceSnapshot.rows){
      const item=normalize(row,sourceSnapshot.source.provider);if(!item){statistics.invalidRows++;continue;}
      const old=unique.get(item.mmsi);
      if(old){statistics.duplicateRows++;const rank=v=>v.reportSeconds!==null&&v.reportSeconds*1000<=now?v.reportSeconds:-1;if(rank(item)<=rank(old))continue;}
      unique.set(item.mmsi,item);
    }
    const vessels=[];let oldest=null,newest=null;
    for(const item of unique.values()){
      const [w,s,e,n]=q.bbox;
      if(item.longitude<w||item.longitude>e||item.latitude<s||item.latitude>n||(q.polygon&&!insidePolygon(item.longitude,item.latitude,q.polygon))){statistics.outsideAreaCount++;continue;}
      if(item.category==='unknown')statistics.unknownTypeCount++;
      if(q.type==='tanker'&&item.category!=='tanker'){statistics.filteredTypeCount++;continue;}
      if(item.reportSeconds===null){statistics.unknownReportTimeCount++;continue;}
      if(item.reportSeconds*1000>now){statistics.futureReportTimeCount++;continue;}
      const ageSeconds=Math.floor((now-item.reportSeconds*1000)/1000);
      if(ageSeconds>q.maxAgeSeconds){statistics.staleCount++;continue;}
      const {reportSeconds,...publicItem}=item;
      vessels.push({...publicItem,ageSeconds});
      oldest=oldest===null||item.reportedAt<oldest?item.reportedAt:oldest;
      newest=newest===null||item.reportedAt>newest?item.reportedAt:newest;
    }
    vessels.sort((a,b)=>a.mmsi.localeCompare(b.mmsi));statistics.activeCount=vessels.length;
    const result={source:snapshots.length===1?snapshot.source:{provider:'AIS Friends and MyShipTracking public maps',sources:snapshots.map(s=>s.source)},retrievedAt:snapshot.retrievedAt,evaluatedAt:new Date(now).toISOString(),bbox:q.bbox,polygon:q.polygon??null,type:q.type,maxAgeSeconds:q.maxAgeSeconds,count:vessels.length,vessels:vessels.slice(0,q.limit),statistics,
      classification:{definition:q.type==='tanker'?'AIS ship_type_id 80 through 89 or source-verified MyShipTracking compact class 8, broad tanker class':'All observed vessel types',oilTankerCount:null,oilSubtypeVerified:false,note:'Broad tanker class does not establish crude oil, product, chemical or gas subtype. Provider subtype IDs are retained without an unverified mapping.'},
      coverage:{completeness:'unknown',providerTotal:null,pagination:'not_exposed',providerAttempts,sourceRetrievalTimes:snapshots.map(s=>({provider:s.source.provider,retrievedAt:s.retrievedAt})),outputTruncated:vessels.length>q.limit,oldestIncludedReportAt:oldest,newestIncludedReportAt:newest},
      message:'Count is unique MMSI observations with reported positions inside the requested geometry and age threshold. Provider coverage/caps are unknown; zero observations is not proof of zero traffic. Retrieval time never replaces report time.'};
    if(includePerProvider)result.coverage.perProviderStatistics=snapshots.map(s=>{
      const single=this.measure(q,[s],[],false);
      return {provider:s.source.provider,retrievedAt:s.retrievedAt,count:single.count,statistics:single.statistics,oldestIncludedReportAt:single.coverage.oldestIncludedReportAt,newestIncludedReportAt:single.coverage.newestIncludedReportAt};
    });
    return result;
  }

  async count(query={}) {const {vessels,...result}=await this.list(query);return result;}
}
