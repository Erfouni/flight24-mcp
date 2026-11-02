import {ClientError} from './session.mjs';
import {getAircraftHistory,getAircraftTrack,searchAircraft} from './aircraft-history.mjs';
import {loadWebGoldSession} from './web-gold-session.mjs';
import {open} from 'node:fs/promises';
import {unprotect} from './secure-store.mjs';

// History route observed in the user's signed-in browser and supplied APK
// fallback settings. Playback route is the APK's corresponding legacy endpoint.
const LEGACY_SETTINGS={urls:{feed:{history:'api.flightradar24.com/common/v1/flight/list.json',playback:'api.flightradar24.com/common/v1/flight-playback.json'}}};
const unavailable=()=>new ClientError('HISTORY_AUTH_UNAVAILABLE','The explicitly configured account history session could not be loaded');

/** Private callbacks supply request credentials; no Gold tier is fabricated. */
export class GoldHistoryService{
  #loadKeys;#loadAuthHeaders;#fetch;#clock;#version;
  constructor({loadKeys,loadAuthHeaders,fetchImpl=globalThis.fetch,now=Date.now,historyEndpointVersion='legacy'}={}){
    if((typeof loadKeys!=='function'&&typeof loadAuthHeaders!=='function')||(loadKeys!==undefined&&typeof loadKeys!=='function')||(loadAuthHeaders!==undefined&&typeof loadAuthHeaders!=='function')||typeof fetchImpl!=='function'||typeof now!=='function')throw new ClientError('HISTORY_AUTH_CONFIG_INVALID','Configure a private history key or account-header loader');
    if(!['legacy','runtime'].includes(historyEndpointVersion)||(historyEndpointVersion==='runtime'&&typeof loadKeys!=='function'))throw new ClientError('HISTORY_AUTH_CONFIG_INVALID','Choose legacy or runtime history; runtime authentication requires a key provider');
    this.#loadKeys=loadKeys;this.#loadAuthHeaders=loadAuthHeaders;this.#fetch=fetchImpl;this.#clock=now;this.#version=historyEndpointVersion;
  }
  toJSON(){return {configured:true,historyEndpointVersion:this.#version,endpointSelection:this.#version==='legacy'?'observed_legacy_api':'APK_runtime_settings',serverEntitlementVerified:false};}
  async #options(options={}){
    if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(key=>!['before','page','olderThenFlightId'].includes(key)))throw new ClientError('HISTORY_AUTH_INPUT_INVALID','Unexpected authenticated history request option');
    let keys,headers;
    try{if(this.#loadKeys)keys=await this.#loadKeys();if(this.#version==='legacy'&&this.#loadAuthHeaders)headers=await this.#loadAuthHeaders();}
    catch{throw unavailable();}
    if(!keys?.subscriptionKey&&!headers?.cookie&&!headers?.Cookie)throw unavailable();
    // Explicit endpoint selection, never an automatic retry/fallback. The APK
    // runtime protocol uses its own User-Agent and token/pk query fields, not
    // replayed website cookies or the legacy browser Origin/Referer headers.
    if(this.#version==='runtime')return {...options,fetchImpl:this.#fetch,now:this.#clock,historyAuth:keys};
    const fixedHeaders={...headers,origin:'https://www.flightradar24.com',referer:'https://www.flightradar24.com/'};
    return {...options,settings:LEGACY_SETTINGS,fetchImpl:this.#fetch,now:this.#clock,...(keys?{historyAuth:keys}:{}),authHeaders:fixedHeaders};
  }
  async getAircraftHistory(registration,limit=20,options={}){return getAircraftHistory(registration,limit,await this.#options(options));}
  async getAircraftTrack(flightId){return getAircraftTrack(flightId,await this.#options());}
  async searchAircraft(identifier){return searchAircraft(identifier,{fetchImpl:this.#fetch,now:this.#clock});}
}

/** Sensitive private key material, never an MCP result or diagnostic output. */
export async function loadHistoryKeys(config,{decrypt=unprotect,now=Date.now}={}){
  if(!config||typeof config!=='object'||Array.isArray(config)||Object.keys(config).some(k=>!['dpapiPath','jsonPath'].includes(k)))throw new ClientError('HISTORY_AUTH_CONFIG_INVALID','Configure one explicit history-key store');
  const modes=['dpapiPath','jsonPath'].filter(k=>config[k]!==undefined);
  if(modes.length!==1||typeof config[modes[0]]!=='string'||!config[modes[0]])throw new ClientError('HISTORY_AUTH_CONFIG_INVALID','Configure one explicit history-key store');
  let file;
  try{
    file=await open(config[modes[0]],'r');const stat=await file.stat();
    const limit=128*1024;if(!stat.isFile()||stat.size>limit)throw unavailable();
    const buffer=Buffer.alloc(limit+1);let length=0;
    while(length<buffer.length){const {bytesRead}=await file.read(buffer,length,buffer.length-length,null);if(!bytesRead)break;length+=bytesRead;}
    if(length>limit)throw unavailable();
    let raw=buffer.subarray(0,length).toString('utf8');if(modes[0]==='dpapiPath')raw=await decrypt(raw);
    if(typeof raw!=='string'||Buffer.byteLength(raw)>limit)throw unavailable();
    const value=JSON.parse(raw),captured=Date.parse(value?.capturedAt);
    if(value?.kind!=='fr24-history-keys'||value.sourceEndpoint!=='https://api.flightradar24.com/common/v1/flight/list.json'||typeof value.capturedAt!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value.capturedAt)||!Number.isFinite(captured)||new Date(captured).toISOString().slice(0,19)!==value.capturedAt.slice(0,19)||captured>now()+300000||typeof value.subscriptionKey!=='string'||!value.subscriptionKey||value.subscriptionKey.length>8192||/[^\x21-\x7e]/.test(value.subscriptionKey)||typeof value.publicKey!=='string'||value.publicKey.length>8192||/[^\x21-\x7e]/.test(value.publicKey))throw unavailable();
    return {subscriptionKey:value.subscriptionKey,publicKey:value.publicKey};
  }catch{throw unavailable();}finally{await file?.close().catch(()=>{});}
}

/** Explicit stores only; server DPAPI must be provisioned under its own identity. */
export async function loadGoldHistoryService(config,{decrypt,fetchImpl=globalThis.fetch,now=Date.now}={}){
  const allowed=['dpapiPath','jsonPath','keysDpapiPath','keysJsonPath','includeAccountCookies','historyEndpointVersion'];
  if(!config||typeof config!=='object'||Array.isArray(config)||Object.keys(config).some(k=>!allowed.includes(k))||(config.includeAccountCookies!==undefined&&typeof config.includeAccountCookies!=='boolean'))throw new ClientError('HISTORY_AUTH_CONFIG_INVALID','Configure explicit history-key and/or web-session stores');
  const keyModes=['keysDpapiPath','keysJsonPath'].filter(k=>config[k]!==undefined),webModes=['dpapiPath','jsonPath'].filter(k=>config[k]!==undefined);
  if(keyModes.length>1||webModes.length>1||(!keyModes.length&&!webModes.length))throw new ClientError('HISTORY_AUTH_CONFIG_INVALID','Use one mode per explicit history-key or web-session store');
  let keys,session;
  if(keyModes.length)keys=await loadHistoryKeys({[keyModes[0]==='keysDpapiPath'?'dpapiPath':'jsonPath']:config[keyModes[0]]},{...(decrypt?{decrypt}:{}),now});
  if(webModes.length)session=await loadWebGoldSession({[webModes[0]]:config[webModes[0]]},{...(decrypt?{decrypt}:{}),fetch:fetchImpl,clock:now});
  const includeCookies=config.includeAccountCookies??!keys;
  return new GoldHistoryService({historyEndpointVersion:config.historyEndpointVersion??'legacy',...(keys?{loadKeys:async()=>keys}:{}),...(session?{loadAuthHeaders:async()=>{
    const headers=session.getHistoryRequestHeaders();return includeCookies?headers:{'user-agent':headers['user-agent']};
  }}:{}),fetchImpl,now});
}
