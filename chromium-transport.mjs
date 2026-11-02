import {isAbsolute} from 'node:path';
import {ClientError} from './session.mjs';

const ORIGIN='https://www.flightradar24.com',HOME=ORIGIN+'/';
const MAX_BYTES=4*1024*1024;
const COOKIES=new Set(['FR24SID','PHPSESSID','_frc','_frr','_frpk','_frPl','XSRFtoken']);
const MANAGED_HEADERS=new Set(['cookie','user-agent','origin','referer','host','connection','content-length','accept-encoding']);
const error=(code,message)=>new ClientError(code,message);
const invalid=()=>error('BROWSER_REQUEST_INVALID','Only bounded read requests to the fixed observed FR24 routes are supported');
function loopbackEndpoint(value){
  let url;try{url=new URL(value);}catch{throw error('BROWSER_CONFIG_INVALID','CDP attachment requires an explicit loopback HTTP endpoint');}
  if(url.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(url.hostname)||!url.port||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw error('BROWSER_CONFIG_INVALID','CDP attachment requires an explicit loopback HTTP endpoint');
  return url.href;
}
function requestSpec(input,init={}){
  if(typeof input!=='string'&&!(input instanceof URL))throw invalid();
  let url;try{url=new URL(input);}catch{throw invalid();}
  if(url.protocol!=='https:'||url.username||url.password||url.hash||url.port)throw invalid();
  let kind,keys;
  if(url.origin===ORIGIN&&/^\/api\/v1\/airport-history\/[1-9]\d{0,8}$/.test(url.pathname)){
    kind='airport';keys=new Set(['date','eventType']);
  }else if(url.origin===ORIGIN&&url.pathname==='/download/check-quota'){
    kind='quota';keys=new Set(['flight']);
  }else if(url.origin===ORIGIN&&url.pathname==='/download/'){
    kind='download';keys=new Set(['flight','file','trailLimit','history']);
  }else if((url.hostname==='api.flightradar24.com'&&url.pathname==='/common/v1/flight/list.json')||(url.hostname==='mobile.flightradar24.com'&&url.pathname==='/common/v2/flight/list.json')){
    kind='history';keys=new Set(['query','fetchBy','page','limit','timestamp','device','token','pk','olderThenFlightId']);
  }else if((url.hostname==='api.flightradar24.com'&&url.pathname==='/common/v1/flight-playback.json')||(url.hostname==='mobile.flightradar24.com'&&url.pathname==='/common/v2/flight-playback.json')){
    kind='playback';keys=new Set(['flightId','timestamp','token','pk','device']);
  }else throw invalid();
  if(url.href.length>32768||[...url.searchParams.keys()].some(key=>!keys.has(key))||!init||typeof init!=='object'||(init.method??'GET').toUpperCase()!=='GET'||(init.body!==undefined&&init.body!==null)||(init.redirect!==undefined&&init.redirect!=='error'))throw invalid();
  const headers={};
  try{
    for(const [name,value]of new Headers(init.headers)){
      if(MANAGED_HEADERS.has(name)||name.startsWith('sec-'))continue;
      if(!['accept','content-type','accesstoken','x-fetch'].includes(name)||value.length>(name==='accesstoken'?16384:2048)||/[^\x20-\x7e]/.test(value)||(name==='accesstoken'&&(kind!=='airport'||!value||/\s/.test(value)))||(name==='x-fetch'&&(!['quota','download'].includes(kind)||value!=='true')))throw invalid();
      headers[name]=value;
    }
  }catch{throw invalid();}
  return {url:url.href,headers,signal:init.signal};
}
function accountCookies(session){
  if(session&&typeof session.getStatus==='function'&&typeof session.getHistoryRequestHeaders==='function')session={origin:session.getStatus().origin,cookieHeader:session.getHistoryRequestHeaders().cookie};
  if(!session||session.origin!==ORIGIN||typeof session.cookieHeader!=='string'||!session.cookieHeader||session.cookieHeader.length>32768||/[^\x20-\x7e]/.test(session.cookieHeader))throw error('BROWSER_SESSION_INVALID','The owned FR24 account cookie envelope is invalid');
  const result=[],seen=new Set();
  for(const part of session.cookieHeader.split(';')){
    const pair=part.trim(),index=pair.indexOf('='),name=pair.slice(0,index),value=pair.slice(index+1);
    if(index<1||!/^[A-Za-z0-9_-]+$/.test(name))throw error('BROWSER_SESSION_INVALID','The owned FR24 account cookie envelope is invalid');
    if(!COOKIES.has(name))continue;
    if(seen.has(name)||!value||!/^[\x21-\x3a\x3c-\x7e]+$/.test(value))throw error('BROWSER_SESSION_INVALID','The owned FR24 account cookie envelope is invalid');
    seen.add(name);result.push({name,value,url:HOME});
  }
  if(!result.length)throw error('BROWSER_SESSION_INVALID','No approved FR24 account cookies were supplied');
  return result;
}
// Runs inside the actual page. It only returns booleans and the public origin.
function inspectPage(){
  const title=document.title??'',visible=(document.body?.innerText??'').slice(0,12000);
  const visibleElement=el=>el.getClientRects().length>0;
  const shown=selector=>[...document.querySelectorAll(selector)].some(visibleElement);
  const securityText=title+' '+visible;
  const challengeFrame=shown('iframe[src*="challenges.cloudflare.com"]');
  const explicitCheckbox=shown('input[type="checkbox"],[role="checkbox"]')&&/human|captcha|security check/i.test(securityText);
  const manualInstructions=/complete (?:the )?captcha|(?:click|select|check) (?:the )?(?:box|checkbox)|verify (?:that )?you are human by/i.test(visible);
  const interactionRequired=explicitCheckbox||shown('iframe[src*="recaptcha"],iframe[src*="hcaptcha"]')||(challengeFrame&&manualInstructions);
  // A loading title/managed spinner is not itself a request for human input.
  // Let the ordinary page's own JavaScript finish within the bounded settle time.
  const challengeLoading=/just a moment|attention required|security verification|checking your browser|verifying (?:that )?you are human|enable javascript and cookies to continue/i.test(securityText)||challengeFrame;
  const signInRequired=shown('input[type="password"]')&&/log ?in|sign ?in/i.test(securityText);
  const map=shown('#map,#map-canvas,canvas,.leaflet-container,.mapboxgl-map,[role="application"]');
  const authOrSearch=[...document.querySelectorAll('a,button,[role="button"]')].some(el=>visibleElement(el)&&/^(?:log ?in|sign ?in|my account|account|search|map)$/i.test((el.innerText??el.getAttribute('aria-label')??'').trim()));
  const providerHeading=/flightradar24|live flight tracker/i.test(title)&&shown('h1,h2');
  return {origin:location.origin,interactionRequired,challengeLoading,signInRequired,appReady:!interactionRequired&&!challengeLoading&&!signInRequired&&(map||authOrSearch||providerHeading)};
}
// This is browser-native fetch, not BrowserContext.request/APIRequestContext.
async function nativePageFetch({url,headers,timeoutMs,maxBytes}){
  if(location.origin!=='https://www.flightradar24.com')return {error:'BROWSER_ORIGIN_CHANGED'};
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const response=await fetch(url,{method:'GET',headers,mode:'cors',credentials:'same-origin',redirect:'error',cache:'no-store',signal:controller.signal});
    if(Number(response.headers.get('content-length'))>maxBytes){await response.body?.cancel();return {error:'BROWSER_RESPONSE_TOO_LARGE'};}
    const reader=response.body?.getReader(),chunks=[];let size=0;
    if(reader)while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maxBytes){await reader.cancel();return {error:'BROWSER_RESPONSE_TOO_LARGE'};}chunks.push(value);}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
    const contentType=response.headers.get('content-type')??'',text=new TextDecoder().decode(bytes);
    // The observed quota endpoint returns a JSON object with text/html MIME.
    // Validate the bytes before treating that MIME alone as an HTML page.
    let jsonValue,jsonDocument=false;
    if(/^\s*[\[{]/.test(text))try{jsonValue=JSON.parse(text);jsonDocument=jsonValue!==null&&typeof jsonValue==='object';}catch{}
    const html=/^\s*(?:<!doctype html|<html)/i.test(text)||(/text\/html/i.test(contentType)&&!jsonDocument);
    if(html&&(/<title[^>]*>\s*(?:just a moment|attention required|verify)/i.test(text)||/verify (?:that )?you are human|challenge-platform|cf-chl-|g-recaptcha|hcaptcha|enable javascript and cookies to continue/i.test(text)))return {error:'INTERACTION_REQUIRED'};
    if(html&&response.ok)return {error:'BROWSER_INVALID_RESPONSE'};
    if((response.status===401||response.status===403)&&jsonDocument){
      const message=String(jsonValue?.error?.code??jsonValue?.error??jsonValue?.message??'');
      if(/captcha|human verification|challenge_required/i.test(message))return {error:'INTERACTION_REQUIRED'};
    }
    let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));
    const safeHeaders={};for(const name of ['content-type','content-disposition','date','cache-control','retry-after']){const value=response.headers.get(name);if(value!==null)safeHeaders[name]=value;}
    return {status:response.status,headers:safeHeaders,bodyBase64:btoa(binary)};
  }catch{return {error:controller.signal.aborted?'BROWSER_TIMEOUT':'BROWSER_FETCH_FAILED'};}
  finally{clearTimeout(timer);}
}

/**
 * Dedicated standard headless Chrome/Chromium. No stealth, clearance copying,
 * CAPTCHA solving, manual browser-managed headers, API retries or auth minting.
 * The callable returns native Node Response objects. INTERACTION_REQUIRED is a
 * thrown ClientError and must be preserved by the calling provider adapter.
 */
export async function createChromiumFetch({userDataDir,executablePath,browserType,launchImpl,connectImpl,cdpEndpoint,loadSession,now=Date.now,requestTimeoutMs=15000,navigationTimeoutMs=20000,settleTimeoutMs=12000}={}){
  const attaching=cdpEndpoint!==undefined,endpoint=attaching?loopbackEndpoint(cdpEndpoint):null;
  if(((!attaching||userDataDir!==undefined)&&(typeof userDataDir!=='string'||!isAbsolute(userDataDir)||!userDataDir||/\x00/.test(userDataDir)))||(executablePath!==undefined&&(typeof executablePath!=='string'||!isAbsolute(executablePath)))||(loadSession!==undefined&&typeof loadSession!=='function')||(launchImpl!==undefined&&typeof launchImpl!=='function')||(connectImpl!==undefined&&(typeof connectImpl!=='function'||!attaching))||typeof now!=='function'||!Number.isInteger(requestTimeoutMs)||requestTimeoutMs<1||requestTimeoutMs>30000||!Number.isInteger(navigationTimeoutMs)||navigationTimeoutMs<1||navigationTimeoutMs>30000)throw error('BROWSER_CONFIG_INVALID','Configure a dedicated absolute browser profile or loopback attachment and bounded transport settings');
  if(!Number.isInteger(settleTimeoutMs)||settleTimeoutMs<1||settleTimeoutMs>15000)throw error('BROWSER_CONFIG_INVALID','Normal page settling must be bounded to at most fifteen seconds');
  let context,page,attachedBrowser,closed=false,interactionRequired=false,interactionReason=null,pageState='not_started',pageReady=false,tail=Promise.resolve(),pending=0,lastErrorCode=null,lastRequestAt=null,requestsAttempted=0,seededAccountCookies=0;
  async function dispose(){
    const current=context,connection=attachedBrowser;context=undefined;page=undefined;attachedBrowser=undefined;pageReady=false;
    // Official connectOverCDP browser.close disconnects its transport. Never
    // close the existing default context or any page in the user's Chrome.
    if(attaching){if(connection)await connection.close().catch(()=>{});}
    else if(current)await current.close().catch(()=>{});
  }
  async function boundedOperation(promise,milliseconds){
    let timer;
    try{return await Promise.race([promise,new Promise((_resolve,reject)=>{timer=setTimeout(()=>{void dispose().catch(()=>{});reject(error('BROWSER_TIMEOUT','The browser operation exceeded its independent time limit'));},milliseconds);})]);}
    finally{clearTimeout(timer);}
  }
  async function requireInteraction(reason=interactionReason??'challenge_response'){interactionRequired=true;interactionReason=reason;pageState=reason;await dispose();throw error('INTERACTION_REQUIRED','The FR24 browser requires human verification or sign-in. Complete it through the normal authorized workflow before restarting this transport.');}
  async function inspect(){
    const deadline=performance.now()+settleTimeoutMs;
    while(true){
      if(closed)throw error('BROWSER_CLOSED','The dedicated browser transport is closed');
      let state;try{state=await boundedOperation(page.evaluate(inspectPage),Math.min(navigationTimeoutMs,Math.max(1,deadline-performance.now())));}catch(e){if(e instanceof ClientError){if(e.code==='BROWSER_TIMEOUT'&&pageState==='automatic_verification')await requireInteraction('challenge_timeout');throw e;}throw error('BROWSER_UNAVAILABLE','The dedicated browser page could not be inspected');}
      if(state?.origin!==ORIGIN)await requireInteraction('origin_changed');
      if(state?.signInRequired)await requireInteraction('sign_in_required');
      if(state?.interactionRequired)await requireInteraction('visible_challenge');
      if(state?.appReady&&!state.challengeLoading){pageReady=true;pageState='ready';return state;}
      pageReady=false;pageState=state?.challengeLoading?'automatic_verification':'loading';
      const remaining=deadline-performance.now();
      if(remaining<=0){
        if(state?.challengeLoading)await requireInteraction('challenge_timeout');
        pageState='app_not_ready';throw error('BROWSER_PREFLIGHT_NOT_READY','The ordinary provider page did not become ready within the bounded loading interval');
      }
      // Read-only observations of this same page. No navigation, challenge
      // interaction, cookie copying, provider API retry or fingerprint change.
      await new Promise(resolve=>setTimeout(resolve,Math.min(200,remaining)));
    }
  }
  async function start(){
    if(context&&page)return;
    try{
      if(!context){
        if(attaching){
          let connect=connectImpl;
          if(!connect){const type=browserType??(await import('playwright-core')).chromium;if(typeof type?.connectOverCDP!=='function'||(typeof type.name==='function'&&type.name()!=='chromium'))throw Error('type');connect=type.connectOverCDP.bind(type);}
          attachedBrowser=await connect(endpoint,{timeout:navigationTimeoutMs,noDefaults:true});
          context=attachedBrowser.contexts()[0];if(!context)throw Error('context');
          // Reuse only an existing page at the owned provider origin. Leave
          // unrelated/ongoing sign-in pages untouched. No reload or reseeding.
          page=context.pages().find(candidate=>{try{return new URL(candidate.url()).origin===ORIGIN;}catch{return false;}});
        }else{
          let launch=launchImpl;
          if(!launch){
            const type=browserType??(await import('playwright-core')).chromium;
            if(typeof type?.launchPersistentContext!=='function'||(typeof type.name==='function'&&type.name()!=='chromium'))throw Error('type');
            launch=type.launchPersistentContext.bind(type);
          }
          context=await launch(userDataDir,{headless:true,acceptDownloads:false,ignoreHTTPSErrors:false,chromiumSandbox:true,timeout:30000,...(executablePath?{executablePath}:{})});
        }
        if(closed){await dispose();throw error('BROWSER_CLOSED','The dedicated browser transport is closed');}
        if(!attaching&&loadSession){let cookies;try{cookies=accountCookies(await loadSession());}catch{throw error('BROWSER_SESSION_INVALID','The owned account session could not be loaded');}await context.addCookies(cookies);seededAccountCookies=cookies.length;}
      }
      if(!page){
        page=await context.newPage();
        if(closed){await dispose();throw error('BROWSER_CLOSED','The dedicated browser transport is closed');}
        await page.goto(HOME,{waitUntil:'domcontentloaded',timeout:navigationTimeoutMs});
      }
      await inspect();
    }catch(e){await dispose();if(e instanceof ClientError)throw e;throw error('BROWSER_UNAVAILABLE','Official Chromium could not start or reach the provider. Check its installation and the dedicated profile.');}
  }
  async function perform(spec){
    if(closed)throw error('BROWSER_CLOSED','The dedicated browser transport is closed');
    if(interactionRequired)await requireInteraction();
    if(spec.signal?.aborted)throw error('BROWSER_ABORTED','The browser request was canceled');
    await start();await inspect();
    if(spec.signal?.aborted)throw error('BROWSER_ABORTED','The browser request was canceled');
    requestsAttempted++;lastRequestAt=new Date(now()).toISOString();
    let onAbort;
    const canceled=new Promise((_resolve,reject)=>{if(spec.signal){onAbort=()=>{if(attaching)void dispose().catch(()=>{});else{const current=page;page=undefined;void current?.close().catch(()=>{});}reject(error('BROWSER_ABORTED','The browser request was canceled'));};spec.signal.addEventListener('abort',onAbort,{once:true});}});
    let value;
    try{value=await boundedOperation(Promise.race([page.evaluate(nativePageFetch,{url:spec.url,headers:spec.headers,timeoutMs:requestTimeoutMs,maxBytes:MAX_BYTES}),canceled]),requestTimeoutMs+100);}
    catch(e){if(e instanceof ClientError)throw e;throw error('BROWSER_FETCH_FAILED','The standard browser request failed; network or browser CORS restrictions may prevent it.');}
    finally{if(onAbort)spec.signal.removeEventListener('abort',onAbort);}
    if(value?.error==='INTERACTION_REQUIRED')await requireInteraction('challenge_response');
    const failures={BROWSER_RESPONSE_TOO_LARGE:'Provider response exceeds four MiB',BROWSER_INVALID_RESPONSE:'The provider returned HTML where API data was expected',BROWSER_TIMEOUT:'The browser request timed out',BROWSER_ORIGIN_CHANGED:'The browser left the fixed provider origin',BROWSER_FETCH_FAILED:'The standard browser fetch failed; network or CORS may prevent access'};
    if(value?.error)throw error(Object.hasOwn(failures,value.error)?value.error:'BROWSER_FETCH_FAILED',failures[value.error]??failures.BROWSER_FETCH_FAILED);
    if(!Number.isInteger(value?.status)||value.status<200||value.status>599||typeof value.bodyBase64!=='string'||value.bodyBase64.length>Math.ceil(MAX_BYTES/3)*4)throw error('BROWSER_INVALID_RESPONSE','The browser returned an invalid API response envelope');
    const body=Buffer.from(value.bodyBase64,'base64');if(body.length>MAX_BYTES)throw error('BROWSER_RESPONSE_TOO_LARGE','Provider response exceeds four MiB');
    const headers={};for(const name of ['content-type','content-disposition','date','cache-control','retry-after'])if(typeof value.headers?.[name]==='string')headers[name]=value.headers[name];headers['content-length']=String(body.length);
    return new Response([204,205,304].includes(value.status)?null:body,{status:value.status,headers});
  }
  const transport=async(input,init)=>{
    const spec=requestSpec(input,init);if(pending>=32)throw error('BROWSER_BUSY','The browser request queue is full');pending++;
    const task=tail.then(()=>perform(spec));tail=task.catch(()=>{});
    try{return await task;}catch(e){lastErrorCode=e instanceof ClientError?e.code:'BROWSER_FETCH_FAILED';if(e instanceof ClientError)throw e;throw error('BROWSER_FETCH_FAILED','The standard browser request could not complete');}finally{pending--;}
  };
  transport.close=async()=>{closed=true;await dispose();};
  transport.getStatus=()=>({configured:true,connectionMode:attaching?'loopback_cdp':'dedicated_persistent',ready:pageReady,closed,interactionRequired,interactionReason,pageState,standardBrowser:true,stealth:false,requestsAttempted,pending,seededAccountCookies,lastRequestAt,lastErrorCode});
  return transport;
}
