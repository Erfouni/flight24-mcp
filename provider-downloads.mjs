import {createHash} from 'node:crypto';
import {ClientError} from './session.mjs';

// Actual Gold website handler: data.schedules.e1115c7b46767e36ffc7.js
// fnDownloadFile: account-cookie quota check, then the /download/ iframe.
// Both csv and kml use this handler. No tokenLogin or account API is substituted.
const ORIGIN='https://www.flightradar24.com',MAX_FILE=4*1024*1024,MAX_CACHE=128*1024*1024,TTL=86400000;
const COOKIE_NAMES=new Set(['FR24SID','PHPSESSID','_frc','_frr','_frpk','_frPl','XSRFtoken']);
const TRANSPORT_CODES=new Set(['BROWSER_REQUEST_INVALID','BROWSER_UNAVAILABLE','BROWSER_SESSION_INVALID','BROWSER_CLOSED','BROWSER_ABORTED','BROWSER_BUSY','BROWSER_PREFLIGHT_NOT_READY','BROWSER_INVALID_RESPONSE','BROWSER_RESPONSE_TOO_LARGE','BROWSER_TIMEOUT','BROWSER_ORIGIN_CHANGED','BROWSER_FETCH_FAILED']);
const error=(code,message)=>new ClientError(code,message);
function headersFromPrivate(input){
  if(!input||typeof input!=='object')throw Error('headers');
  const supplied=Object.fromEntries(Object.entries(input).map(([key,value])=>[key.toLowerCase(),value]));
  if(Object.keys(supplied).some(key=>!['cookie','user-agent'].includes(key)))throw Error('headers');
  const cookie=supplied.cookie,agent=supplied['user-agent'];
  if(typeof cookie!=='string'||cookie.length>32768||/[^\x20-\x7e]/.test(cookie)||typeof agent!=='string'||!agent||agent.length>2048||/[^\x20-\x7e]/.test(agent))throw Error('headers');
  const pairs=[],seen=new Set();
  for(const raw of cookie.split(';')){const pair=raw.trim(),index=pair.indexOf('='),name=pair.slice(0,index);if(!COOKIE_NAMES.has(name))continue;if(index<1||seen.has(name)||!pair.slice(index+1))throw Error('cookie');seen.add(name);pairs.push(pair);}
  if(!pairs.length)throw Error('cookie');
  return {cookie:pairs.join('; '),'user-agent':agent};
}
async function bytesFrom(response,max,code){
  const reader=response.body?.getReader();if(!reader)throw error(code,'Provider returned an empty response');
  try{
    if(Number(response.headers.get('content-length'))>max)throw Error('size');
    const chunks=[];let total=0;
    while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>max)throw Error('size');chunks.push(Buffer.from(value));}
    return Buffer.concat(chunks,total);
  }catch{await reader.cancel().catch(()=>{});throw error(code,'Provider response is invalid or exceeds the size bound');}
}
function filename(header,fallback,format){
  let name;
  if(typeof header==='string'&&header.length<=2000){
    const extended=/filename\*=UTF-8''([^;]+)/i.exec(header),simple=/filename="([^"]+)"|filename=([^;]+)/i.exec(header);
    try{name=extended?decodeURIComponent(extended[1]):simple?.[1]??simple?.[2]?.trim();}catch{}
  }
  return typeof name==='string'&&name.length<=200&&!/[\\/\x00-\x1f\x7f]/.test(name)&&!name.startsWith('.')&&name.toLowerCase().endsWith('.'+format)?name:fallback;
}
const clone=value=>({metadata:structuredClone(value.metadata),bytes:Buffer.from(value.bytes)});

/** Original provider files. The caller must authorize any quota-consuming use. */
export class ProviderDownloadsService{
  #headers;#fetch;#clock;#cache=new Map();#pending=new Map();#cacheBytes=0;
  constructor({getRequestHeaders,fetch=globalThis.fetch,clock=Date.now}={}){this.#headers=getRequestHeaders;this.#fetch=fetch;this.#clock=clock;}
  toJSON(){return {source:'FR24 original provider exports',credentialsExposed:false,cacheScope:'process_memory',cacheTtlSeconds:TTL/1000};}
  async downloadOriginal(args){
    if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(key=>!['flightId','format','historyTimestamp'].includes(key))||typeof args.flightId!=='string'||!/^[a-f0-9]{6,16}$/i.test(args.flightId)||!['csv','kml'].includes(args.format)||!Number.isSafeInteger(args.historyTimestamp)||args.historyTimestamp<=0||args.historyTimestamp>=253402300800)throw error('PROVIDER_DOWNLOAD_INPUT_INVALID','Provide a hexadecimal flight ID, csv/kml and the original positive UNIX-second historyTimestamp');
    const query={flightId:args.flightId.toLowerCase(),format:args.format,historyTimestamp:args.historyTimestamp},key=JSON.stringify(query),cached=this.#cache.get(key);
    if(cached&&this.#clock()-cached.at<TTL){const result=clone(cached.value);result.metadata.cacheHit=true;return result;}
    if(cached){this.#cache.delete(key);this.#cacheBytes-=cached.value.bytes.length;}
    if(this.#pending.has(key))return clone(await this.#pending.get(key));
    const pending=this.#read(query).then(value=>{
      while(this.#cache.size>=32||this.#cacheBytes+value.bytes.length>MAX_CACHE){const oldest=this.#cache.keys().next().value;if(oldest===undefined)break;this.#cacheBytes-=this.#cache.get(oldest).value.bytes.length;this.#cache.delete(oldest);}
      this.#cache.set(key,{at:this.#clock(),value});this.#cacheBytes+=value.bytes.length;return value;
    });
    this.#pending.set(key,pending);try{return clone(await pending);}finally{if(this.#pending.get(key)===pending)this.#pending.delete(key);}
  }
  async #request(url,headers){
    const requestPhase=url.pathname==='/download/check-quota'?'quota_check':'file_download';
    let response;
    try{response=await this.#fetch(url.href,{method:'GET',headers,credentials:'include',redirect:'error',signal:AbortSignal.timeout(30000)});}
    catch(cause){
      const code=cause?.code==='INTERACTION_REQUIRED'?'INTERACTION_REQUIRED':TRANSPORT_CODES.has(cause?.code)?cause.code:'PROVIDER_DOWNLOAD_NETWORK_FAILED';
      const failure=error(code,code==='INTERACTION_REQUIRED'?'The provider requires normal browser interaction before original downloads can continue':'Original provider '+(requestPhase==='quota_check'?'quota check':'file download')+' could not complete; no automatic retry was performed');
      failure.requestPhase=requestPhase;failure.quotaConsumptionMayHaveOccurred=requestPhase==='file_download';throw failure;
    }
    if(!response.ok){await response.body?.cancel().catch(()=>{});throw error('HTTP_'+response.status,'Original provider export returned HTTP '+response.status);}
    return response;
  }
  async #read(query){
    let privateHeaders={};
    if(this.#headers){try{privateHeaders=headersFromPrivate(await this.#headers());}catch{throw error('PROVIDER_DOWNLOAD_SESSION_INVALID','The private web session headers could not be loaded');}}
    const quotaUrl=new URL(ORIGIN+'/download/check-quota');quotaUrl.search=new URLSearchParams({flight:query.flightId});
    const quotaResponse=await this.#request(quotaUrl,{...privateHeaders,'Content-Type':'application/json; charset=utf-8','X-Fetch':'true'});
    let quota;
    try{quota=JSON.parse((await bytesFrom(quotaResponse,65536,'PROVIDER_DOWNLOAD_QUOTA_INVALID')).toString('utf8'));}catch{throw error('PROVIDER_DOWNLOAD_QUOTA_INVALID','Provider quota response is invalid');}
    if(!Number.isSafeInteger(quota?.quotaLeft)||quota.quotaLeft<0||quota.quotaLeft>100000)throw error('PROVIDER_DOWNLOAD_QUOTA_INVALID','Provider quota response lacks a valid remaining count');
    const expires=typeof quota.expires==='string'||typeof quota.expires==='number'?new Date(quota.expires).getTime():NaN;
    if(quota.quotaLeft===0){const denied=error('PROVIDER_DOWNLOAD_QUOTA_EXHAUSTED','The provider original-file download quota is exhausted');denied.quotaRemaining=0;denied.quotaResetsAt=Number.isFinite(expires)?new Date(expires).toISOString():null;throw denied;}
    const fileUrl=new URL(ORIGIN+'/download/');fileUrl.search=new URLSearchParams({flight:query.flightId,file:query.format,trailLimit:'0',history:String(query.historyTimestamp)});
    const response=await this.#request(fileUrl,privateHeaders),bytes=await bytesFrom(response,MAX_FILE,'PROVIDER_DOWNLOAD_FILE_INVALID');
    const prefix=bytes.subarray(0,4096).toString('utf8').replace(/^\uFEFF/,'').trimStart();
    const contentType=response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()??'';
    const valid=query.format==='kml'?/<kml(?:\s|>)/i.test(prefix):bytes.length>0&&!/^(?:<!doctype\s+html|<html|\{|\[)/i.test(prefix)&&prefix.includes(',')&&/[\r\n]/.test(prefix);
    if(!valid||/text\/html|application\/json/i.test(contentType))throw error('PROVIDER_DOWNLOAD_FILE_INVALID','Provider returned a non-file or unexpected export format');
    const mimeType=query.format==='csv'?'text/csv':'application/vnd.google-earth.kml+xml';
    return {bytes,metadata:{source:'Flightradar24 original provider export',flightId:query.flightId,format:query.format,sourceHistoryTimestamp:query.historyTimestamp,
      filename:filename(response.headers.get('content-disposition'),query.flightId+'.'+query.format,query.format),mimeType,providerContentType:contentType||null,byteLength:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),
      downloadedAt:new Date(this.#clock()).toISOString(),providerOriginalBytes:true,derivedFromTrack:false,complete:false,quotaRemainingBeforeDownload:quota.quotaLeft,quotaRemainingAfterDownload:null,
      quotaConsumptionMayHaveOccurred:true,cacheHit:false,cacheScope:'process_memory',cacheTtlSeconds:TTL/1000,
      coverage:'Unmodified original provider file for the source flight/history anchor. File retrieval does not establish full route coverage. A failed request is never retried automatically; repeated calls after process restart or cache eviction may consume quota again.'}};
  }
}
