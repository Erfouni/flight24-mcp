import {createHash,timingSafeEqual} from 'node:crypto';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {createMcpExpressApp} from '@modelcontextprotocol/sdk/server/express.js';
import * as z from 'zod/v4';
import {QueryCache,ttlForTool} from './query-cache.mjs';
import {exportTrack} from './track-export.mjs';

const digest=s=>createHash('sha256').update(s).digest();
const toolAnnotations={readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true};
function result(value) {return {content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value};}
function safeError(error) {
  const code=typeof error?.code==='string' && /^[A-Z0-9_]+$/.test(error.code)?error.code:'SOURCE_FAILED';
  const message=code==='INTERACTION_REQUIRED'?'The provider browser needs human verification or account sign-in. Complete the normal provider login before using Gold tools.':code==='SEARCH_TIMEOUT'?'The search source did not respond within the search deadline. This is not an empty search result.':'The data source could not complete this query. Do not invent a result.';
  const retry={};
  if(typeof error?.retryAt==='string'&&error.retryAt.length<=40&&Number.isFinite(Date.parse(error.retryAt)))retry.retryAt=error.retryAt;
  if(Number.isSafeInteger(error?.retryAfterSeconds)&&error.retryAfterSeconds>=0)retry.retryAfterSeconds=error.retryAfterSeconds;
  return {isError:true,content:[{type:'text',text:JSON.stringify({error:code,message,...retry})}]};
}
function deadline(promise,milliseconds){let timer;return Promise.race([promise,new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('Search deadline exceeded'),{code:'SEARCH_TIMEOUT'})),milliseconds);})]).finally(()=>clearTimeout(timer));}
export function createMcpApp({token,oauth,allowUrlToken=false,airlines,vessels,satellite,vesselExtras,tankers,vesselArea,aircraftArea,aircraftHistory,measurements,airportHistory,airportEvents,regionalAirportEvents,historyJobs,providerDownloads,capabilities,popularity,geography,regionalHistory,searchTimeoutMs=5000,allowedHosts=['localhost','127.0.0.1','[::1]'],allowedOrigins=[]}) {
  if (typeof token!=='string'||token.length<32||/\s/.test(token)) throw new Error('MCP_BEARER_TOKEN must contain at least 32 non-whitespace characters');
  if(!Number.isInteger(searchTimeoutMs)||searchTimeoutMs<1||searchTimeoutMs>30000)throw new Error('Search timeout must be from 1 to 30000 milliseconds');
  if(typeof allowUrlToken!=='boolean')throw new Error('allowUrlToken must be boolean');
  const expected=digest(token);
  const queryCache=new QueryCache();
  const app=createMcpExpressApp({allowedHosts});
  app.disable('x-powered-by');
  if(oauth){app.set('trust proxy','loopback');oauth.install(app);}
  app.get('/health',(_req,res)=>res.json({status:'ok',service:'live-transport-mcp'}));
  app.use('/mcp',async(req,res,next)=>{
    res.set('Cache-Control','no-store');res.set('Referrer-Policy','no-referrer');
    const header=req.headers.authorization||'';
    const queryToken=req.query.access_token;
    if(allowUrlToken&&queryToken!==undefined&&header)return res.status(400).json({error:'ambiguous_credentials'});
    const urlAuthorized=allowUrlToken&&typeof queryToken==='string'&&queryToken.length<=4096&&timingSafeEqual(digest(queryToken),expected);
    let authorized=urlAuthorized||(header.startsWith('Bearer ')&&timingSafeEqual(digest(header.slice(7)),expected));
    if(!authorized&&oauth&&header.startsWith('Bearer ')){try{const identity=await oauth.verifyAccessToken(header.slice(7));authorized=identity.scopes?.includes('mcp:read')===true;}catch{authorized=false;}}
    if (!authorized) {
      res.set('WWW-Authenticate',oauth?'Bearer resource_metadata="'+oauth.resourceMetadataUrl+'"':'Bearer realm="live-transport-mcp"');
      return res.status(401).json({error:'unauthorized'});
    }
    if (req.headers.origin && !allowedOrigins.includes(req.headers.origin)) return res.status(403).json({error:'origin_not_allowed'});
    res.locals.urlTokenAuthenticated=urlAuthorized;
    next();
  });
  const makeServer=(urlTokenAuthenticated=false)=>{
    const server=new McpServer({name:'live-transport',version:'0.1.0'}, {instructions:'Use these tools for current source-backed aircraft and vessel questions. Report observation time and incomplete results. Airline counts cover tracked airborne flights, not every physical aircraft or total fleet size. Vessel positions are last AIS reports: never call old or missing positions current. Verify ship name/type; USS Abraham Lincoln must not be confused with a passenger ship of the same name.'});
    const authMeta=urlTokenAuthenticated?{securitySchemes:[{type:'noauth'}]}:oauth?{securitySchemes:[{type:'oauth2',scopes:['mcp:read']}]}:undefined;
    const register=(name,description,inputSchema,handler,annotations=toolAnnotations)=>server.registerTool(name,{description,inputSchema,annotations,...(authMeta?{_meta:authMeta}:{})},async args=>{try{const pending=queryCache.read(name,args,()=>handler(args),ttlForTool(name));return result(await (name.startsWith('search_')?deadline(pending,searchTimeoutMs):pending));}catch(error){return safeError(error);}});
    if(capabilities)register('get_capabilities','Read the verified website feature inventory, source restrictions and deployment configuration. Configured account access does not prove successful provider responses; inspect individual tool results.',{},()=>typeof capabilities==='function'?capabilities():capabilities);
    if(providerDownloads)server.registerTool('download_original_flight_track',{description:'Download the ORIGINAL Flightradar24 CSV or KML for a verified flight ID and its source history timestamp in UNIX seconds. Uses account quota (Gold website observed25/day); successful files are cached per process. Use only when the user requests original files. Retrieval does not guarantee a complete track; preserve quota errors.',inputSchema:{flightId:z.string().regex(/^[a-f0-9]{6,16}$/i),format:z.enum(['csv','kml']),historyTimestamp:z.number().int().positive()},annotations:{...toolAnnotations,idempotentHint:false},...(authMeta?{_meta:authMeta}:{})},async q=>{try{const {metadata,bytes}=await providerDownloads.downloadOriginal(q);return {content:[{type:'text',text:JSON.stringify(metadata)},{type:'resource',resource:{uri:'original-track://local/'+encodeURIComponent(metadata.filename),mimeType:metadata.mimeType,blob:bytes.toString('base64')}}],structuredContent:metadata};}catch(error){return safeError(error);}});
    register('count_airline_airborne','Count currently tracked airborne flights operated by an airline worldwide. Accepts Persian/English names, IATA or ICAO. Check complete and the observation time; a capped result is a lower bound.',{airline:z.string().min(1).max(120)},({airline})=>airlines.count(airline));
    register('list_airline_airborne','List current tracked airborne flights of an operating airline, including available callsign, registration, route, position and last report. The returned count may exceed the displayed list.',{airline:z.string().min(1).max(120),limit:z.number().int().min(1).max(200).default(100)},({airline,limit})=>airlines.list(airline,limit));
    if (vessels) {
      register('search_vessels','Search VesselFinder by ship name or MMSI and return identity candidates. Confirm the correct ship and type before retrieving position. Use full USS designation for a US Navy ship.',{query:z.string().min(1).max(120)},({query})=>vessels.searchVessels(query));
      register('get_vessel_position','Get the last publicly reported AIS position by MMSI or unambiguous full name. Always preserve report time and stale/unavailable status. For USS Abraham Lincoln search that full name; a passenger vessel named ABRAHAM LINCOLN is a different ship.',{identifier:z.string().min(1).max(120)},({identifier})=>vessels.getVesselPosition(identifier));
      register('get_vessel_history','Read available historical AIS track reports from VesselFinder by MMSI or unambiguous full ship name. Includes latestReportedPosition and coverage. This endpoint provides no selectable date window or completeness guarantee. Report the actual historical timestamp; never infer the current location or substitute a similarly named vessel.',{identifier:z.string().min(3).max(100),limit:z.number().int().min(1).max(10000).default(2000)},({identifier,limit})=>vessels.getVesselHistory(identifier,{limit}));
    }
    if (satellite) {
      const areaAndTime={bbox:z.array(z.number()).length(4).describe('WGS84 [west, south, east, north]'),from:z.iso.datetime().describe('UTC start, ending in Z'),to:z.iso.datetime().describe('UTC end, ending in Z; at most 31 days after start'),maxCloudCover:z.number().min(0).max(100).default(30)};
      register('search_satellite_scenes','Search dated Copernicus Sentinel-2 scenes in a geographic rectangle, up to 10 degrees per axis and a 31-day UTC interval. Returns actual acquisition timestamps, cloud cover and pagination state. Satellite images are observations from the listed dates.',{...areaAndTime,limit:z.number().int().min(1).max(100).default(10)},args=>satellite.searchScenes(args));
      server.registerTool('get_satellite_image',{description:'Get a Copernicus true-colour satellite PNG for WGS84 bounds, up to 1 degree per axis and a 31-day UTC interval. Returns the acquisition time of the tile actually rendered and cloud metadata. Native Sentinel-2 RGB resolution is 10 metres. Do not infer a vessel identity or current position from this image alone.',inputSchema:{...areaAndTime,width:z.number().int().min(1).max(1024).default(512),height:z.number().int().min(1).max(1024).default(512)},annotations:toolAnnotations,...(authMeta?{_meta:authMeta}:{})},async args=>{
        try {const {metadata,image}=await satellite.getImage(args);return {content:[{type:'text',text:JSON.stringify(metadata)},{type:'image',mimeType:'image/png',data:image.toString('base64')}],structuredContent:metadata};}
        catch(error){return safeError(error);}
      });
    }
    if (vesselExtras) register('get_vessel_details','Get available VesselFinder master particulars by ship name, MMSI or IMO. Check status, lockedFields and unavailableFields: locked or absent values are null. These particulars do not establish a current position or unlock paid information.',{identifier:z.string().min(3).max(100)},({identifier})=>vesselExtras.getVesselDetails(identifier));
    if (tankers) register('count_us_tankers_middle_east','Count publicly observed airborne tanker-capable aircraft registered to US military agencies in the broad Middle East rectangle 10–43N,25–66E. Resolves exact airframe identity so generic B762 is not missed or blindly classified. Report preciseCount separately from estimatedCount; receiver estimates do not establish certain regional membership. complete=false and actualRegionalCount=null mean the real total remains unknown. Aircraft being airborne does not prove active refuelling.',{},()=>tankers.countMiddleEast());
    const bbox=z.array(z.number()).length(4).describe('WGS84 [west,south,east,north]; report the actual counted geometry');
    if(vesselArea){
      const input={bbox,polygon:z.array(z.array(z.number()).length(2)).min(3).max(100).optional(),type:z.enum(['all','tanker']).default('all'),maxAgeSeconds:z.number().int().min(1).max(86400).default(1800),limit:z.number().int().min(1).max(2000).default(200)};
      register('count_vessels_in_area','Count unique fresh AIS vessel reports within a rectangle or polygon. Tanker means broad AIS80–89 and DOES NOT establish oil, chemical or gas subtype. Check classification.oilTankerCount and unknown/stale reports; unknown coverage means the real total is not established.',input,q=>vesselArea.count(q));
      register('list_vessels_in_area','List fresh AIS vessels in a rectangle or polygon with MMSI, report time, position and available type. Output limit is separate from the observed count. Use verified particulars before calling broad tankers oil tankers.',input,q=>vesselArea.list(q));
    }
    if(aircraftArea){
      const input={bbox,typeCode:z.string().min(1).max(30).optional(),registration:z.string().min(1).max(30).optional(),callsign:z.string().min(1).max(30).optional(),airborneOnly:z.boolean().default(true),maxAgeSeconds:z.number().int().min(1).max(3600).default(300),limit:z.number().int().min(1).max(1000).default(200)};
      register('count_aircraft_in_area','Count unique fresh Flightradar24 positions within a rectangle with optional exact type/registration/callsign filters. Type codes alone do not establish aircraft roles. Missing/old reports and unknown reception coverage prevent a real-world complete census.',input,q=>aircraftArea.count(q));
      register('list_aircraft_in_area','List fresh aircraft position reports within a rectangle, with identity, speed, altitude and original observation timestamps. List limits do not become count limits.',input,q=>aircraftArea.list(q));
    }
    if(aircraftHistory){
      register('search_aircraft','Search the APK-defined FR24 aircraft search endpoint. Preserve blocked/not-found/source statuses; a blocked endpoint is not evidence that an aircraft is absent.',{identifier:z.string().min(1).max(80)},q=>aircraftHistory.searchAircraft(q.identifier));
      register('get_aircraft_history','Get available flight-history records for an aircraft registration, with actual/scheduled times and provider flight IDs. Use nextCursor from the preceding full source page to request older flights with before, page and olderThenFlightId together. A before timestamp alone may be ignored by the provider; check requestedBeforeHonored and coverage; a page is not a complete monthly airport-arrival dataset.',{registration:z.string().min(2).max(15),limit:z.number().int().min(1).max(100).default(20),before:z.iso.datetime().optional(),page:z.number().int().min(1).max(50).default(1),olderThenFlightId:z.string().regex(/^[a-f0-9]{1,16}$/i).optional()},q=>aircraftHistory.getAircraftHistory(q.registration,q.limit,{before:q.before,page:q.page,olderThenFlightId:q.olderThenFlightId}));
      register('get_aircraft_track','Get timestamped historical trajectory points using a flight ID returned by aircraft history. Preserves source timestamps, skipped records and gaps; never call missing trajectory sections observed.',{flightId:z.string().regex(/^[a-f0-9]{1,16}$/i)},q=>aircraftHistory.getAircraftTrack(q.flightId));
    }
    if(measurements)register('get_track_statistics','Measure supplied aircraft or vessel history: endpoint distances, connected observation duration and derived speeds. Long gaps and conflicting timestamps are excluded; straight segment distances are lower bounds rather than a reconstructed full route.',{points:z.array(z.object({reportedAt:z.iso.datetime(),latitude:z.number().min(-90).max(90),longitude:z.number().min(-180).max(180)})).max(10000),maxGapSeconds:z.number().positive().default(3600)},q=>measurements(q.points,{maxGapSeconds:q.maxGapSeconds}));
    server.registerTool('export_historical_track',{description:'Generate a CSV or KML file from supplied timestamped aircraft/vessel history points. Preserves original observations and gaps. This exports supplied samples and does not claim a complete route or consume an official provider file-download allowance. KML is ground-projected; reported altitude remains a separate field.',inputSchema:{points:z.array(z.object({reportedAt:z.iso.datetime(),latitude:z.number().min(-90).max(90),longitude:z.number().min(-180).max(180),altitudeFeet:z.number().nullable().optional(),speedKnots:z.number().nonnegative().nullable().optional()})).min(1).max(10000),format:z.enum(['csv','kml']),name:z.string().min(1).max(120).default('track'),maxGapSeconds:z.number().positive().default(3600)},annotations:toolAnnotations,...(authMeta?{_meta:authMeta}:{})},async q=>{try{const {points,...options}=q;const file=exportTrack(points,options);const {text:body,...metadata}=file;return {content:[{type:'text',text:JSON.stringify(metadata)},{type:'resource',resource:{uri:'track-export://local/'+encodeURIComponent(file.filename),mimeType:file.mimeType,text:body}}],structuredContent:metadata};}catch(error){return safeError(error);}});
    if(airportHistory)register('get_airport_arrivals','Read available completed arrivals from the APK airport schedule board over a UTC interval, maximum31days. Separates actual landing times, scheduled times and unique registrations. This scheduled-board subset is incomplete and lacks cargo classification: exactCount and exactCargoArrivalCount remain null. Do not turn partial pages into an exact monthly cargo count. Dubai DXB/OMDB and DWC/OMDW are separate airports.',{airport:z.string().regex(/^[A-Za-z]{3,4}$/),from:z.iso.datetime(),to:z.iso.datetime(),maxPages:z.number().int().min(1).max(3).default(1)},q=>airportHistory.getAirportArrivals(q));
    if(airportEvents&&geography){
      const input={airport:z.union([z.string().min(1).max(12),z.number().int().positive()]),date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),eventType:z.enum(['landed','takeoff']).default('landed')};
      const getEvents=async q=>{const airport=geography.resolveAirport(q.airport);return airportEvents.getAirportEvents({airportId:airport.id,date:q.date,eventType:q.eventType,timezone:airport.timezone});};
      register('get_airport_events','Read actual detected landing or takeoff events from the signed-in Gold airport history for one airport LOCAL calendar date. Uses source airport IDs and IANA timezones, includes unscheduled observations and unknown route endpoints. Distinct from the scheduled board. No cargo category or complete-traffic guarantee is supplied.',{...input,limit:z.number().int().min(1).max(1000).default(200)},async q=>{const data=await getEvents(q);return {...data,records:data.records.slice(0,q.limit),displayedRecords:Math.min(data.records.length,q.limit),displayTruncated:data.records.length>q.limit};});
      register('count_airport_events','Count observed actual airport landing/takeoff records on a LOCAL date using the Gold event-history source. Counts flight events separately from unique aircraft. Cargo classification is unknown and exact real-world totals remain null.',input,async q=>{const {records,...data}=await getEvents(q);return data;});
    }
    if(popularity)register('get_most_tracked_flights','Get the current FR24 top-ten flights ranked by provider order, with the number currently following each flight and the source update time. This is current flight popularity, not cumulative aircraft views or lifetime popularity. Registration can be unavailable.',{limit:z.number().int().min(1).max(10).default(10)},q=>popularity.getMostTrackedFlights(q));
    if(geography||regionalHistory||historyJobs){
      const selection=z.union([
        z.object({country:z.string().min(2).max(100).describe('Country ISO2/ISO3 or source English name')}).strict(),
        z.object({bbox}).strict(),
        z.object({polygon:z.object({type:z.literal('Polygon'),coordinates:z.array(z.array(z.array(z.number()).length(2)).min(4).max(2000)).min(1).max(20)}).strict()}).strict(),
        z.object({airports:z.array(z.union([z.string().min(1).max(12),z.number().int().positive()])).min(1).max(500)}).strict()
      ]);
      if(geography)register('resolve_region_airports','Resolve destination airports for any source-catalog country, WGS84 rectangle, GeoJSON Polygon or explicit IATA/ICAO/airport IDs. Includes catalog date and IANA timezones. This selects destination airports, not overflights or a complete current airport census.',{selection},q=>geography.resolveAirports(q.selection));
      if(historyJobs){
        const jobId=z.string().regex(/^[a-f0-9]{32}$/);
        register('start_region_history_job','Queue a durable regional airport-history archive and return its job ID immediately. Downloads are serialized, cached and resumed after provider Retry-After deadlines. Reuse the same query to find an existing archive. Set resumeFailed only to explicitly resume a stopped job after resolving its cause. A finished request plan is not a complete traffic census or exact cargo count.',{selection,fromDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),toDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),eventType:z.enum(['landed','takeoff']).default('landed'),resumeFailed:z.boolean().default(false)},q=>{const {resumeFailed,...query}=q;return historyJobs.start(query,{resumeFailed});},{...toolAnnotations,readOnlyHint:false});
        register('get_region_history_job','Read current progress, retained record count, failures and retry deadline for a regional archive without making provider requests. Waiting means respect retryAt; do not restart the whole query.',{jobId},q=>historyJobs.get(q.jobId));
        server.registerTool('download_region_history_job',{description:'Download one JSON page of already archived airport events without fetching the provider again. Follow nextOffset for the next page. Partial jobs export only retained observations; source completeness and cargo totals remain unknown.',inputSchema:{jobId,offset:z.number().int().min(0).default(0),limit:z.number().int().min(1).max(1000).default(200)},annotations:toolAnnotations,...(authMeta?{_meta:authMeta}:{})},async q=>{try{const page=await historyJobs.download(q);const metadata={...page.metadata,nextOffset:page.nextOffset,downloadedRecordCount:page.records.length};return {content:[{type:'text',text:JSON.stringify(metadata)},{type:'resource',resource:{uri:`history-archive://local/${q.jobId}/${q.offset}.json`,mimeType:'application/json',text:JSON.stringify(page)}}],structuredContent:metadata};}catch(error){return safeError(error);}});
      }
      if(regionalHistory)register('get_region_arrivals','Retrieve a bounded batch of available airport-arrival history across a country or geographic region. UTC interval [from,to), maximum31days. maxAirports/airportOffset explicitly bound airport coverage. Counts observed flight legs separately from unique registrations. Partial schedule boards lack cargo classification and do not establish an exact monthly cargo count; inspect failures and unqueried airports.',{selection,from:z.iso.datetime(),to:z.iso.datetime(),maxAirports:z.number().int().min(1).max(10).default(3),airportOffset:z.number().int().min(0).max(10000).default(0),maxPages:z.number().int().min(1).max(3).default(1)},q=>regionalHistory.getRegionalArrivals(q));
      if(regionalAirportEvents)register('get_region_airport_events','Read actual Gold airport-history events across a country/region and an inclusive date range of at most31 calendar days. Dates mean each airport LOCAL calendar. Batches use requestOffset and maxRequests<=12, serialized requests and resumable failure checkpoints. Follow nextOffset to continue; each call counts its own observed events only. Unknown cargo category and unverified source completeness keep exact counts null.',{selection,fromDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),toDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),eventType:z.enum(['landed','takeoff']).default('landed'),requestOffset:z.number().int().min(0).default(0),maxRequests:z.number().int().min(1).max(12).default(3)},q=>regionalAirportEvents.getRegionalAirportEvents(q));
    }
    return server;
  };
  app.post('/mcp',async(req,res)=>{
    const server=makeServer(res.locals.urlTokenAuthenticated===true);
    const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
    res.on('close',()=>{void transport.close();void server.close();});
    try {await server.connect(transport);await transport.handleRequest(req,res,req.body);}
    catch {if(!res.headersSent)res.status(500).json({jsonrpc:'2.0',error:{code:-32603,message:'MCP request failed'},id:null});}
  });
  app.get('/mcp',(_req,res)=>res.status(405).json({error:'Use POST with Streamable HTTP'}));
  app.delete('/mcp',(_req,res)=>res.status(405).json({error:'Stateless transport has no persistent session'}));
  app.use((error,_req,res,_next)=>res.status(error?.status===413?413:400).json({error:'invalid_request'}));
  return app;
}
