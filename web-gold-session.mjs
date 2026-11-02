import {open} from 'node:fs/promises';
import {unprotect} from './secure-store.mjs';
import {ClientError} from './session.mjs';

const ORIGIN='https://www.flightradar24.com';
const STORE_LIMIT=128*1024,HTML_LIMIT=4*1024*1024;
const COOKIE_NAMES=new Set(['FR24SID','PHPSESSID','_frc','_frr','_frpk','_frPl','XSRFtoken']);
const invalid=()=>new ClientError('WEB_SESSION_INVALID','The stored FR24 web session has an invalid envelope or headers');
const storeFailed=()=>new ClientError('WEB_SESSION_STORE_FAILED','The explicitly configured web session store could not be loaded');
function timestamp(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value))return NaN;
  const ms=Date.parse(value);return Number.isFinite(ms)&&new Date(ms).toISOString().slice(0,19)===value.slice(0,19)?ms:NaN;
}
function cookieHeader(value){
  if(typeof value!=='string'||value.length>32768||!value||/[^\x20-\x7e]/.test(value))throw invalid();
  const selected=[],seen=new Set();
  for(const raw of value.split(';')){
    const pair=raw.trim(),index=pair.indexOf('='),name=pair.slice(0,index),contents=pair.slice(index+1);
    if(index<1||!/^[A-Za-z0-9_-]+$/.test(name))throw invalid();
    // Anti-bot, analytics and unrelated cookies are never replayed, even if a
    // future capture accidentally includes them. No names/values are exposed.
    if(!COOKIE_NAMES.has(name))continue;
    if(seen.has(name)||!contents||!/^[\x21-\x3a\x3c-\x7e]+$/.test(contents))throw invalid();
    seen.add(name);selected.push(name+'='+contents);
  }
  if(!selected.length)throw invalid();
  return selected.join('; ');
}
async function boundedStore(path){
  let file;
  try{
    file=await open(path,'r');const info=await file.stat();
    if(!info.isFile()||info.size>STORE_LIMIT)throw storeFailed();
    const buffer=Buffer.alloc(STORE_LIMIT+1);let length=0;
    while(length<buffer.length){const {bytesRead}=await file.read(buffer,length,buffer.length-length,null);if(!bytesRead)break;length+=bytesRead;}
    if(length>STORE_LIMIT)throw storeFailed();
    return buffer.subarray(0,length).toString('utf8');
  }catch{throw storeFailed();}finally{await file?.close().catch(()=>{});}
}
async function boundedHtml(response){
  if(Number(response.headers.get('content-length'))>HTML_LIMIT)throw Error('size');
  const reader=response.body?.getReader();if(!reader)throw Error('body');
  let length=0;const chunks=[];
  try{
    while(true){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>HTML_LIMIT)throw Error('size');chunks.push(Buffer.from(value));}
    return Buffer.concat(chunks,length).toString('utf8');
  }catch{await reader.cancel().catch(()=>{});throw Error('invalid');}
}

/** Account cookies remain private. Browser observations are not server auth. */
export class WebGoldSession {
  #cookies;#userAgent;#capturedAt;#observed;#fetch;#clock;#storage;
  constructor({session,fetch=globalThis.fetch,clock=Date.now,storage='in_memory'}={}){
    const captured=timestamp(session?.capturedAt);
    if(!session||typeof session!=='object'||Array.isArray(session)||typeof session.kind!=='string'||!session.kind||session.kind.length>80||session.origin!==ORIGIN||session.passwordStored!==false||!Number.isFinite(captured)||captured>clock()+300000||typeof session.userAgent!=='string'||!session.userAgent||session.userAgent.length>2048||/[^\x20-\x7e]/.test(session.userAgent)||typeof fetch!=='function'||!['in_memory','current_user_dpapi','explicit_server_json'].includes(storage))throw invalid();
    this.#cookies=cookieHeader(session.cookieHeader);this.#userAgent=session.userAgent;this.#capturedAt=new Date(captured).toISOString();
    this.#observed=Boolean(session.entitlementObserved);this.#fetch=fetch;this.#clock=clock;this.#storage=storage;
  }
  getStatus(){return {configured:true,storage:this.#storage,origin:ORIGIN,capturedAt:this.#capturedAt,captureAgeSeconds:Math.max(0,Math.floor((this.#clock()-Date.parse(this.#capturedAt))/1000)),browserEntitlementObservedFromCapture:this.#observed,serverEntitlementVerified:false,authenticatedHistoryVerified:false,sessionExpiryKnown:false,passwordStored:false,antiBotCookiesReplayed:false};}
  toJSON(){return this.getStatus();}
  // Sensitive internal transport material. Never register this as an MCP tool,
  // serialize it or log it. The history client pins the legacy API origin/path.
  getHistoryRequestHeaders(){return {cookie:this.#cookies,'user-agent':this.#userAgent};}
  /** One diagnostic page read only. No unverified HTML schema becomes records. */
  async probeAircraftHistory(registration){
    if(typeof registration!=='string'||!/^[A-Z0-9][A-Z0-9-]{0,19}$/i.test(registration))throw new ClientError('WEB_SESSION_INPUT_INVALID','Provide an aircraft registration');
    registration=registration.toUpperCase();
    const base={source:'FR24 account-cookie website diagnostic',registration,retrievedAt:new Date(this.#clock()).toISOString(),complete:false,serverEntitlementVerified:false,authenticatedHistoryVerified:false,antiBotCookiesSent:false};
    let response;
    try{response=await this.#fetch(ORIGIN+'/data/aircraft/'+registration.toLowerCase(),{headers:{cookie:this.#cookies,'user-agent':this.#userAgent,accept:'text/html'},redirect:'error',signal:AbortSignal.timeout(20000)});}
    catch{return {...base,status:'network_error',httpStatus:null};}
    const httpStatus=response.status;
    if(!response.ok){await response.body?.cancel().catch(()=>{});return {...base,status:({401:'unauthenticated',403:'blocked',404:'not_found',429:'rate_limited'})[httpStatus]??'upstream_error',httpStatus};}
    if(!/^text\/html(?:;|$)/i.test(response.headers.get('content-type')??'')){await response.body?.cancel().catch(()=>{});return {...base,status:'invalid_response',httpStatus};}
    try{
      const html=await boundedHtml(response);
      return {...base,status:'html_received_unparsed',httpStatus,htmlContains365:/\b365\b/.test(html),flightRowMarkerCount:(html.match(/data-(?:flight-id|row)=/g)??[]).length,message:'HTML received without a verified history schema. Incidental numbers and row markers do not validate account entitlement or historical completeness.'};
    }catch{return {...base,status:'invalid_response',httpStatus};}
  }
}

/**
 * Local DPAPI is tied to its Windows user/machine. Provision a new DPAPI file
 * under the server service identity, or explicitly point jsonPath at a protected
 * server secret file. No automatic plaintext fallback or credential copying.
 */
export async function loadWebGoldSession(config,{decrypt=unprotect,fetch=globalThis.fetch,clock=Date.now}={}){
  if(!config||typeof config!=='object'||Array.isArray(config)||Object.keys(config).some(key=>!['dpapiPath','jsonPath'].includes(key)))throw new ClientError('WEB_SESSION_CONFIG_INVALID','Configure exactly one DPAPI or explicit server JSON session path');
  const supplied=['dpapiPath','jsonPath'].filter(key=>config[key]!==undefined);
  if(supplied.length!==1||typeof config[supplied[0]]!=='string'||!config[supplied[0]])throw new ClientError('WEB_SESSION_CONFIG_INVALID','Configure exactly one DPAPI or explicit server JSON session path');
  const encrypted=supplied[0]==='dpapiPath';let envelope;
  try{
    let raw=await boundedStore(config[supplied[0]]);
    if(encrypted)raw=await decrypt(raw);
    if(typeof raw!=='string'||Buffer.byteLength(raw,'utf8')>STORE_LIMIT)throw storeFailed();
    envelope=JSON.parse(raw);
  }catch{throw storeFailed();}
  return new WebGoldSession({session:envelope,fetch,clock,storage:encrypted?'current_user_dpapi':'explicit_server_json'});
}
