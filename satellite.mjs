import {readFile} from 'node:fs/promises';
import {inspect} from 'node:util';
import {ClientError} from './session.mjs';

const PROVIDER='Copernicus Data Space Ecosystem / Sentinel Hub';
const ATTRIBUTION='Copernicus Sentinel data via Copernicus Data Space Ecosystem';
const configData=new WeakMap();
const TOKEN_URL='https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token';
const PROCESS_URL='https://sh.dataspace.copernicus.eu/process/v1';
const CATALOG_URL='https://sh.dataspace.copernicus.eu/catalog/v1/search';
const envKeys=new Set(['COPERNICUS_CLIENT_ID','COPERNICUS_CLIENT_SECRET','COPERNICUS_TOKEN_URL','COPERNICUS_PROCESS_URL','COPERNICUS_CLIENT_EXPIRES_UTC','COPERNICUS_CATALOG_URL']);
const fail=(code,message)=>new ClientError('SATELLITE_'+code,message);
const invalid=()=>fail('INPUT_INVALID','Use valid WGS84 bounds, bounded dimensions, a UTC time interval of at most 31 days and valid query limits');
function endpoint(value,kind) {
  let u;try{u=new URL(value);}catch{throw fail('CONFIG_INVALID','Invalid Copernicus endpoint configuration');}
  const paths=kind==='token'?['/auth/realms/CDSE/protocol/openid-connect/token']:kind==='process'?['/process/v1','/api/v1/process']:['/catalog/v1/search','/api/v1/catalog/1.0.0/search'];
  if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||u.port||u.hostname!==(kind==='token'?'identity.dataspace.copernicus.eu':'sh.dataspace.copernicus.eu')||!paths.includes(u.pathname)) throw fail('CONFIG_INVALID','Copernicus endpoints must use approved HTTPS hosts and service paths');
  return u.href;
}
function utc(value) {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value))return NaN;
  const ms=Date.parse(value);
  return Number.isFinite(ms)&&new Date(ms).toISOString().slice(0,19)===value.slice(0,19)?ms:NaN;
}
function validateConfig(input) {
  if(!input||!['clientId','clientSecret'].every(k=>typeof input[k]==='string'&&input[k].length>0&&input[k].length<=16000&&!/[\r\n\0]/.test(input[k])))throw fail('CONFIG_INVALID','Copernicus client credentials are missing or malformed');
  const expires=input.clientExpiresUtc?utc(input.clientExpiresUtc):Infinity;
  if(Number.isNaN(expires))throw fail('CONFIG_INVALID','Copernicus client expiry must be an ISO UTC timestamp');
  return {clientId:input.clientId,clientSecret:input.clientSecret,tokenUrl:endpoint(input.tokenUrl??TOKEN_URL,'token'),processUrl:endpoint(input.processUrl??PROCESS_URL,'process'),catalogUrl:endpoint(input.catalogUrl??CATALOG_URL,'catalog'),clientExpiresAt:expires};
}
export async function loadSatelliteConfig(path) {
  let text;try{text=await readFile(path,'utf8');}catch{throw fail('CONFIG_UNAVAILABLE','The local Copernicus configuration could not be read');}
  if(Buffer.byteLength(text)>65536)throw fail('CONFIG_INVALID','Copernicus configuration exceeds the size limit');
  const values={};
  for(const line of text.replace(/^\uFEFF/,'').split(/\r?\n/)) {
    if(!line.trim()||line.trimStart().startsWith('#'))continue;
    const match=/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if(!match||!envKeys.has(match[1])||Object.hasOwn(values,match[1]))throw fail('CONFIG_INVALID','Copernicus configuration contains an unknown, duplicate or malformed setting');
    let value=match[2];
    if(value.startsWith('"')||value.startsWith("'")) {
      if(value.at(-1)!==value[0]||value.length<2)throw fail('CONFIG_INVALID','Copernicus configuration contains malformed quoting');
      value=value.slice(1,-1);
    }
    values[match[1]]=value;
  }
  const data=validateConfig({clientId:values.COPERNICUS_CLIENT_ID,clientSecret:values.COPERNICUS_CLIENT_SECRET,tokenUrl:values.COPERNICUS_TOKEN_URL,processUrl:values.COPERNICUS_PROCESS_URL,catalogUrl:values.COPERNICUS_CATALOG_URL,clientExpiresUtc:values.COPERNICUS_CLIENT_EXPIRES_UTC});
  const safe=Object.freeze({toJSON:()=>({provider:PROVIDER,configured:true}),[inspect.custom]:()=>({provider:PROVIDER,configured:true})});
  configData.set(safe,data);return safe;
}
function parameters(args,maxSpan) {
  const {bbox,from,to,maxCloudCover=30}=args??{};
  if(!Array.isArray(bbox)||bbox.length!==4||!bbox.every(Number.isFinite))throw invalid();
  const [w,s,e,n]=bbox,a=utc(from),b=utc(to);
  if(w< -180||e>180||s< -90||n>90||w>=e||s>=n||e-w>maxSpan||n-s>maxSpan||!Number.isFinite(a)||!Number.isFinite(b)||a>=b||b-a>31*86400000||!Number.isFinite(maxCloudCover)||maxCloudCover<0||maxCloudCover>100)throw invalid();
  return {bbox:[...bbox],from,to,maxCloudCover};
}
function parseJson(bytes) {
  try{const value=JSON.parse(bytes.toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw Error();return value;}
  catch{throw fail('BAD_RESPONSE','Copernicus returned malformed JSON');}
}
async function bounded(response,maxBytes) {
  const reader=response.body?.getReader();
  if(!reader)throw fail('BAD_RESPONSE','Copernicus returned an empty response');
  if(Number(response.headers.get('content-length'))>maxBytes){await reader.cancel().catch(()=>{});throw fail('BAD_RESPONSE','Copernicus response exceeds the size limit');}
  const chunks=[];let length=0;
  try {
    while(true){const {value,done}=await reader.read();if(done)break;length+=value.length;if(length>maxBytes){await reader.cancel().catch(()=>{});throw fail('BAD_RESPONSE','Copernicus response exceeds the size limit');}chunks.push(Buffer.from(value));}
  }catch(e){if(e instanceof ClientError)throw e;throw fail('NETWORK_FAILED','Copernicus response could not be read');}
  return Buffer.concat(chunks,length);
}
// Official Process API multi-response TAR stays entirely in memory: no extraction.
function imageArchive(bytes) {
  const files={};let offset=0;
  while(offset+512<=bytes.length) {
    const h=bytes.subarray(offset,offset+512);if(h.every(v=>v===0))break;
    const octal=(a,b)=>{const v=h.toString('ascii',a,b).replace(/\0.*$/,'').trim();if(!/^[0-7]+$/.test(v))throw fail('BAD_RESPONSE','Copernicus returned an invalid image archive');return parseInt(v,8);};
    const size=octal(124,136),checksum=octal(148,156);
    let actual=0;for(let i=0;i<512;i++)actual+=i>=148&&i<156?32:h[i];
    if(checksum!==actual||offset+512+size>bytes.length)throw fail('BAD_RESPONSE','Copernicus returned an invalid image archive');
    const name=h.toString('utf8',0,100).replace(/\0.*$/,'');
    if(name==='default.png'||name==='userdata.json') {
      if(files[name]||(name==='userdata.json'&&size>65536))throw fail('BAD_RESPONSE','Copernicus returned an invalid image archive');
      files[name]=bytes.subarray(offset+512,offset+512+size);
    }
    offset+=512+Math.ceil(size/512)*512;
  }
  if(!files['default.png']||!files['userdata.json'])throw fail('BAD_RESPONSE','Copernicus image or acquisition metadata is missing');
  const image=files['default.png'];
  if(image.length<24||!image.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||image.toString('ascii',12,16)!=='IHDR')throw fail('BAD_RESPONSE','Copernicus did not return a valid PNG header');
  return {image,userdata:parseJson(files['userdata.json']),width:image.readUInt32BE(16),height:image.readUInt32BE(20)};
}
// TILE makes samples[0] correspond to scenes.tiles[0], so userdata describes the
// tile actually rendered. Transparent pixels preserve missing spatial coverage.
const TRUE_COLOR=`//VERSION=3
function setup(){return {input:["B04","B03","B02","dataMask"],output:{id:"default",bands:4},mosaicking:"TILE"};}
function evaluatePixel(samples){if(!samples.length)return [0,0,0,0];const s=samples[0];return [2.5*s.B04,2.5*s.B03,2.5*s.B02,s.dataMask];}
function updateOutputMetadata(scenes,inputMetadata,outputMetadata){const t=scenes.tiles&&scenes.tiles[0];outputMetadata.userData={acquisitions:t?[{date:t.date,cloudCoverage:t.cloudCoverage}]:[]};}`;

export class SatelliteService {
  #config;#fetch;#clock;#access;#authPending;
  constructor({config,fetch=globalThis.fetch,clock=Date.now}) {this.#config=configData.get(config)??validateConfig(config);this.#fetch=fetch;this.#clock=clock;}
  toJSON(){return {provider:PROVIDER,configured:true};}
  [inspect.custom](){return this.toJSON();}
  async #response(url,options,maxBytes) {
    let response;
    try{response=await this.#fetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(30000)});}
    catch{throw fail('NETWORK_FAILED','Copernicus request failed; check connectivity, TLS or blocked redirects');}
    if(!response.ok){await response.body?.cancel().catch(()=>{});throw fail('HTTP_'+response.status,'Copernicus returned HTTP '+response.status);}
    return {bytes:await bounded(response,maxBytes),contentType:(response.headers.get('content-type')??'').split(';')[0].trim().toLowerCase()};
  }
  async #json(url,options,maxBytes=2000000) {
    const {bytes,contentType}=await this.#response(url,options,maxBytes);
    if(contentType!=='application/json'&&!contentType.endsWith('+json'))throw fail('BAD_RESPONSE','Copernicus did not return JSON');
    return parseJson(bytes);
  }
  async #authorization() {
    if(this.#config.clientExpiresAt<=this.#clock())throw fail('CLIENT_EXPIRED','The configured Copernicus OAuth client has expired');
    if(this.#access&&this.#clock()<this.#access.expiresAt-60000)return 'Bearer '+this.#access.value;
    if(this.#authPending)return this.#authPending;
    const pending=(async()=>{
      const body=new URLSearchParams({grant_type:'client_credentials',client_id:this.#config.clientId,client_secret:this.#config.clientSecret});
      const token=await this.#json(this.#config.tokenUrl,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',accept:'application/json'},body},65536);
      if(typeof token.access_token!=='string'||!/[\x21-\x7e]/.test(token.access_token)||token.access_token.length>16384||/[\s\x00-\x20\x7f-\uffff]/.test(token.access_token)||typeof token.token_type!=='string'||token.token_type.toLowerCase()!=='bearer'||!Number.isFinite(token.expires_in)||token.expires_in<=0)throw fail('BAD_RESPONSE','Copernicus returned a malformed OAuth response');
      this.#access={value:token.access_token,expiresAt:this.#clock()+token.expires_in*1000};return 'Bearer '+this.#access.value;
    })();
    this.#authPending=pending;
    try{return await pending;}finally{if(this.#authPending===pending)this.#authPending=undefined;}
  }
  #metadata(p){return {provider:PROVIDER,attribution:ATTRIBUTION,collection:'sentinel-2-l2a',bbox:p.bbox,requestedTimeRange:{from:p.from,to:p.to},queriedAt:new Date(this.#clock()).toISOString(),currentPositionGuarantee:false,freshness:'Satellite acquisition times are historical observations; request time does not imply live imagery',nativeRgbResolutionMetres:10};}
  async searchScenes(args) {
    const p=parameters(args,10),limit=args?.limit??10;
    if(!Number.isInteger(limit)||limit<1||limit>100)throw invalid();
    const data=await this.#json(this.#config.catalogUrl,{method:'POST',headers:{authorization:await this.#authorization(),'content-type':'application/json',accept:'application/geo+json, application/json'},body:JSON.stringify({bbox:p.bbox,datetime:p.from+'/'+p.to,collections:['sentinel-2-l2a'],limit,filter:'eo:cloud_cover <= '+p.maxCloudCover,'filter-lang':'cql2-text'})});
    if(!Array.isArray(data.features)||data.features.length>100)throw fail('BAD_RESPONSE','Copernicus returned an invalid scene collection');
    const scenes=data.features.map(f=>{
      const timestamp=f?.properties?.datetime,cloud=f?.properties?.['eo:cloud_cover'];
      if(typeof f?.id!=='string'||f.id.length>1024||!Number.isFinite(utc(timestamp)))throw fail('BAD_RESPONSE','Copernicus returned invalid scene metadata');
      return {id:f.id,timestamp,cloudCoverPercent:Number.isFinite(cloud)?cloud:null,bbox:Array.isArray(f.bbox)&&f.bbox.length===4&&f.bbox.every(Number.isFinite)?f.bbox:null};
    });
    const hasMore=data.context?.next!=null||(Array.isArray(data.links)&&data.links.some(l=>l.rel==='next'));
    return {...this.#metadata(p),scenes,count:scenes.length,complete:!hasMore,hasMore};
  }
  async getImage(args) {
    const p=parameters(args,1),width=args?.width??512,height=args?.height??512;
    if(![width,height].every(v=>Number.isInteger(v)&&v>=1&&v<=1024))throw invalid();
    const body={input:{bounds:{bbox:p.bbox,properties:{crs:'http://www.opengis.net/def/crs/OGC/1.3/CRS84'}},data:[{type:'sentinel-2-l2a',dataFilter:{timeRange:{from:p.from,to:p.to},maxCloudCoverage:p.maxCloudCover,mosaickingOrder:'mostRecent'}}]},output:{width,height,responses:[{identifier:'default',format:{type:'image/png'}},{identifier:'userdata',format:{type:'application/json'}}]},evalscript:TRUE_COLOR};
    const response=await this.#response(this.#config.processUrl,{method:'POST',headers:{authorization:await this.#authorization(),'content-type':'application/json',accept:'application/tar'},body:JSON.stringify(body)},10000000);
    if(!['application/tar','application/x-tar'].includes(response.contentType))throw fail('BAD_RESPONSE','Copernicus did not return the requested image archive');
    const parsed=imageArchive(response.bytes),acquisitions=parsed.userdata.acquisitions;
    if(!Array.isArray(acquisitions)||!acquisitions.length)throw fail('NO_SCENES','No satellite acquisition was available for the requested image');
    const timestamp=acquisitions[0]?.date,ms=utc(timestamp);
    if(!Number.isFinite(ms)||ms<utc(p.from)||ms>utc(p.to)||acquisitions.length!==1||parsed.width!==width||parsed.height!==height)throw fail('BAD_RESPONSE','Copernicus returned inconsistent image acquisition metadata or dimensions');
    return {metadata:{...this.#metadata(p),mimeType:'image/png',width:parsed.width,height:parsed.height,acquisitionTime:timestamp,acquisitionTimeSource:'Process API userdata for rendered tile',cloudCoverPercent:Number.isFinite(acquisitions[0].cloudCoverage)?acquisitions[0].cloudCoverage:null,rendering:'True colour from newest matching Sentinel-2 tile; transparent pixels indicate no data',spatialCoverageComplete:null},image:parsed.image};
  }
}
