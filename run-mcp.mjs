import {readFile,access} from 'node:fs/promises';
import {LiveFlights} from './live.mjs';
import {AirlineService} from './airlines.mjs';
import {createMcpApp} from './mcp-server.mjs';
import * as vessels from './vessels.mjs';
import {loadSatelliteConfig,SatelliteService} from './satellite.mjs';
import * as vesselExtras from './vessel-extras.mjs';
import {TankerService} from './tankers.mjs';
import {VesselAreaService} from './vessel-area.mjs';
import {AircraftAreaService} from './aircraft-area.mjs';
import * as publicAircraftHistory from './aircraft-history.mjs';
import {loadGoldHistoryService} from './gold-history.mjs';
import {createOwnerOAuth} from './oauth.mjs';
import {AirportEventsService} from './airport-events.mjs';
import {RegionalAirportEventsService} from './regional-airport-events.mjs';
import {RegionalHistoryJobs} from './history-jobs.mjs';
import {createChromiumFetch} from './chromium-transport.mjs';
import {loadWebGoldSession} from './web-gold-session.mjs';
import {unprotect} from './secure-store.mjs';
import {ProviderDownloadsService} from './provider-downloads.mjs';
import {measureTrack} from './track-measurements.mjs';
import {AirportHistoryService} from './airport-history.mjs';
import * as popularity from './popularity.mjs';
import * as geography from './regions.mjs';
import {RegionalArrivalsService} from './regional-arrivals.mjs';

const settings=JSON.parse(await readFile(new URL('./runtime-settings.json',import.meta.url),'utf8').catch(()=>readFile(new URL('./bundled-settings.json',import.meta.url),'utf8')));
const live=new LiveFlights({settings});
const airlines=new AirlineService({live});
const tankers=new TankerService();
const vesselArea=new VesselAreaService();
const aircraftArea=new AircraftAreaService({live});
const airportHistory=new AirportHistoryService({settings});
const regionalHistory=new RegionalArrivalsService({airportHistory});
const satellitePath=process.env.COPERNICUS_ENV_FILE||new URL('../.secrets/copernicus.env',import.meta.url);
let satellite;
try {await access(satellitePath);satellite=new SatelliteService({config:await loadSatelliteConfig(satellitePath)});}
catch(error) {if(error.code!=='ENOENT'||process.env.COPERNICUS_ENV_FILE)throw error;}
const host=process.env.HOST||'127.0.0.1';
const port=Number(process.env.PORT||8080);
const publicUrl=process.env.PUBLIC_URL?new URL(process.env.PUBLIC_URL):null;
let aircraftHistory=publicAircraftHistory;
let providerFetch=globalThis.fetch;
const webSession=process.env.FR24_WEB_SESSION_DPAPI_FILE?await loadWebGoldSession({dpapiPath:process.env.FR24_WEB_SESSION_DPAPI_FILE}):null;
if(process.env.FR24_BROWSER_PROFILE){
  providerFetch=await createChromiumFetch({userDataDir:process.env.FR24_BROWSER_PROFILE,executablePath:process.env.FR24_BROWSER_EXECUTABLE,cdpEndpoint:process.env.FR24_BROWSER_CDP_ENDPOINT,loadSession:async()=>webSession});
}
if(process.env.FR24_HISTORY_KEYS_DPAPI_FILE){
  aircraftHistory=await loadGoldHistoryService({keysDpapiPath:process.env.FR24_HISTORY_KEYS_DPAPI_FILE,...(process.env.FR24_WEB_SESSION_DPAPI_FILE?{dpapiPath:process.env.FR24_WEB_SESSION_DPAPI_FILE}:{}),historyEndpointVersion:process.env.FR24_HISTORY_ENDPOINT_VERSION||'runtime'},{fetchImpl:providerFetch});
}
let airportEvents,regionalAirportEvents,historyJobs;
if(process.env.FR24_AIRPORT_SESSION_DPAPI_FILE){
  const raw=await readFile(process.env.FR24_AIRPORT_SESSION_DPAPI_FILE,'utf8');
  if(raw.length>128*1024)throw new Error('Airport session file is too large');
  const session=JSON.parse(await unprotect(raw));
  airportEvents=new AirportEventsService({loadSession:async()=>session,fetch:providerFetch,cacheDir:process.env.FR24_HISTORY_CACHE_DIR,minIntervalMs:Number(process.env.FR24_HISTORY_MIN_INTERVAL_MS??1000)});
  regionalAirportEvents=new RegionalAirportEventsService({airportEvents});
}
if(process.env.HISTORY_JOB_DIR){
  if(!regionalAirportEvents)throw new Error('HISTORY_JOB_DIR requires configured airport history');
  historyJobs=new RegionalHistoryJobs({regionalAirportEvents,storeDir:process.env.HISTORY_JOB_DIR});
  await historyJobs.initialize();
}
const websiteInventory=JSON.parse(await readFile(new URL('./website-capabilities.json',import.meta.url),'utf8'));
const capabilities=()=>({website:websiteInventory,configured:{goldAircraftHistory:aircraftHistory!==publicAircraftHistory,goldAirportEvents:!!airportEvents,regionalHistoryJobs:!!historyJobs,satellite:!!satellite,oauth:!!oauth},airportHistory:airportEvents?.getStatus?.()??null,browser:providerFetch.getStatus?.()??null,sessionExpiryKnown:false,sourceCompletenessGuaranteed:false});
const providerDownloads=webSession?new ProviderDownloadsService({fetch:providerFetch,getRequestHeaders:()=>webSession.getHistoryRequestHeaders()}):undefined;
let oauth;
if(process.env.OAUTH_OWNER_SECRET){
  if(!publicUrl)throw new Error('PUBLIC_URL is required for private OAuth');
  oauth=createOwnerOAuth({issuerUrl:publicUrl.origin,resourceUrl:new URL('/mcp',publicUrl).href,ownerSecret:process.env.OAUTH_OWNER_SECRET,storePath:process.env.OAUTH_STORE_PATH});
}
const allowedHosts=['localhost','127.0.0.1','[::1]',...(publicUrl?[publicUrl.hostname]:[])];
const app=createMcpApp({token:process.env.MCP_BEARER_TOKEN,oauth,allowUrlToken:process.env.MCP_ALLOW_URL_TOKEN==='true',airlines,vessels,satellite,vesselExtras,tankers,vesselArea,aircraftArea,aircraftHistory,measurements:measureTrack,airportHistory,airportEvents,regionalAirportEvents,historyJobs,providerDownloads,capabilities,popularity,geography,regionalHistory,allowedHosts,allowedOrigins:publicUrl?[publicUrl.origin,'https://chatgpt.com']:[]});
const listener=app.listen(port,host,()=>console.error(`Live transport MCP listening on ${host}:${port}/mcp`));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>listener.close(async()=>{await historyJobs?.close();live.close();await providerFetch.close?.();process.exit(0);}));
