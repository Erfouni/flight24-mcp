import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const mod=await import('../mcp-server.mjs').catch(()=>({}));
const token='fixture-mcp-token-0123456789-abcdef';

test('search returns a distinct deadline error rather than a false empty result',async t=>{
  const vessels={searchVessels:async()=>{await new Promise(r=>setTimeout(r,60));return {vessels:[]};}};
  const server=mod.createMcpApp({token,airlines:{},vessels,searchTimeoutMs:5}).listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(r=>server.close(r)));
  const client=new Client({name:'deadline-fixture',version:'1'});t.after(()=>client.close());await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`),{requestInit:{headers:{Authorization:'Bearer '+token}}}));
  const result=await client.callTool({name:'search_vessels',arguments:{query:'fixture'}});assert.equal(result.isError,true);assert.equal(JSON.parse(result.content[0].text).error,'SEARCH_TIMEOUT');
});

test('MCP requires Bearer and exposes tested flight/vessel tools through real SDK transport',async t=>{
  assert.equal(typeof mod.createMcpApp,'function','MCP server must be implemented');
  const airlines={count:async airline=>({airline,count:7,complete:true,source:'fixture'}),list:async airline=>({airline,flights:[],source:'fixture'})};
  const vessels={searchVessels:async query=>({query,vessels:[],source:'fixture'}),getVesselPosition:async identifier=>({identifier,position:null,source:'fixture'}),getVesselHistory:async(identifier,{limit})=>({identifier,limit,latestReportedPosition:{reportedAt:'2026-11-01T15:05:09.000Z'},coverage:{completeness:'unknown'},source:'fixture'})};
  const app=mod.createMcpApp({token,airlines,vessels});
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(r=>server.close(r)));
  const url=new URL(`http://127.0.0.1:${server.address().port}/mcp`);
  const bad=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  assert.equal(bad.status,401);
  const client=new Client({name:'integration-fixture',version:'1.0'});
  const transport=new StreamableHTTPClientTransport(url,{requestInit:{headers:{Authorization:'Bearer '+token}}});
  t.after(()=>client.close());
  await client.connect(transport);
  const tools=await client.listTools();
  assert.deepEqual(tools.tools.map(t=>t.name).sort(),['count_airline_airborne','export_historical_track','get_vessel_history','get_vessel_position','list_airline_airborne','search_vessels']);
  const result=await client.callTool({name:'count_airline_airborne',arguments:{airline:'ماهان'}});
  assert.equal(result.structuredContent.count,7);
  assert.equal(result.structuredContent.airline,'ماهان');
  const history=await client.callTool({name:'get_vessel_history',arguments:{identifier:'EVER GIVEN',limit:5}});
  assert.equal(history.structuredContent.identifier,'EVER GIVEN');
  assert.equal(history.structuredContent.limit,5);
  assert.equal(history.structuredContent.latestReportedPosition.reportedAt,'2026-11-01T15:05:09.000Z');
  assert.equal(history.structuredContent.coverage.completeness,'unknown');
});

test('MCP exposes area counts and history/measurement tools without upgrading coverage claims',async t=>{
  const vesselArea={count:async q=>({count:4,type:q.type,classification:{oilTankerCount:null},coverage:{completeness:'unknown'}}),list:async()=>({count:4,vessels:[]})};
  const aircraftArea={count:async()=>({count:3,complete:false}),list:async()=>({count:3,aircraft:[]})};
  const aircraftHistory={getAircraftHistory:async (registration,limit,options)=>({registration,limit,requestedBefore:options.before,page:options.page,olderThenFlightId:options.olderThenFlightId,flights:[],coverage:{complete:false}}),getAircraftTrack:async flightId=>({flightId,points:[],coverage:{complete:false}}),searchAircraft:async identifier=>({identifier,status:'blocked'})};
  const measurements=()=>({observedDistanceKm:1,status:'partial'});
  const airportHistory={getAirportArrivals:async q=>({airport:q.airport,actualArrivalRecordCount:7,exactCount:null,complete:false})};
  const popularity={getMostTrackedFlights:async()=>({metric:{period:'current_snapshot',cumulativeViewsAvailable:false},flights:[{rank:1,currentTrackerCount:456}]})};
  const server=mod.createMcpApp({token,airlines:{},vesselArea,aircraftArea,aircraftHistory,measurements,airportHistory,popularity}).listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(r=>server.close(r)));
  const client=new Client({name:'measurement-fixture',version:'1'});t.after(()=>client.close());await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`),{requestInit:{headers:{Authorization:'Bearer '+token}}}));
  const names=(await client.listTools()).tools.map(x=>x.name);
  for(const name of ['count_vessels_in_area','list_vessels_in_area','count_aircraft_in_area','list_aircraft_in_area','search_aircraft','get_aircraft_history','get_aircraft_track','get_track_statistics','get_airport_arrivals'])assert.ok(names.includes(name),name);
  const counted=await client.callTool({name:'count_vessels_in_area',arguments:{bbox:[56,26,57,27],type:'tanker'}});assert.equal(counted.structuredContent.count,4);assert.equal(counted.structuredContent.classification.oilTankerCount,null);
  const history=await client.callTool({name:'get_aircraft_history',arguments:{registration:'EP-VAK',limit:3}});assert.equal(history.structuredContent.registration,'EP-VAK');assert.equal(history.structuredContent.coverage.complete,false);
  const cursorHistory=await client.callTool({name:'get_aircraft_history',arguments:{registration:'EP-VAK',limit:100,page:3,before:'2026-08-30T11:29:35Z',olderThenFlightId:'416c433b'}});assert.equal(cursorHistory.structuredContent.olderThenFlightId,'416c433b');
  const olderHistory=await client.callTool({name:'get_aircraft_history',arguments:{registration:'EP-VAK',limit:5,before:'2026-10-15T00:00:00Z',page:2}});assert.equal(olderHistory.structuredContent.requestedBefore,'2026-10-15T00:00:00Z');assert.equal(olderHistory.structuredContent.page,2);assert.equal(olderHistory.structuredContent.limit,5);
  const track=await client.callTool({name:'get_aircraft_track',arguments:{flightId:'42657bb4'}});assert.equal(track.structuredContent.flightId,'42657bb4');
  const exported=await client.callTool({name:'export_historical_track',arguments:{points:[{reportedAt:'2026-11-01T00:00:00Z',latitude:25,longitude:55}],format:'csv',name:'verified-route'}});assert.equal(exported.structuredContent.pointCount,1);assert.equal(exported.structuredContent.coverage.complete,false);assert.equal(exported.content[1].type,'resource');assert.equal(exported.content[1].resource.mimeType,'text/csv');assert.ok(exported.content[1].resource.text.includes('2026-11-01T00:00:00.000Z'));
  const arrivals=await client.callTool({name:'get_airport_arrivals',arguments:{airport:'DXB',from:'2026-11-01T00:00:00Z',to:'2026-11-02T00:00:00Z'}});assert.equal(arrivals.structuredContent.actualArrivalRecordCount,7);assert.equal(arrivals.structuredContent.exactCount,null);
  const popular=await client.callTool({name:'get_most_tracked_flights',arguments:{limit:3}});assert.equal(popular.structuredContent.flights[0].currentTrackerCount,456);assert.equal(popular.structuredContent.metric.cumulativeViewsAvailable,false);
});

test('MCP exposes configured satellite search and returns image content with acquisition metadata',async t=>{
  const satellite={
    searchScenes:async args=>({source:'fixture',scenes:[{id:'scene-fixture',datetime:'2026-10-30T10:00:00Z'}],bbox:args.bbox}),
    getImage:async()=>({metadata:{source:'fixture',acquiredAt:'2026-10-30T10:00:00Z'},image:Buffer.from([137,80,78,71,13,10,26,10])})
  };
  const vesselExtras={getVesselDetails:async identifier=>({identifier,status:'partial',details:{vesselName:'EVER GIVEN',grossTonnage:null},lockedFields:['grossTonnage']})};
  const tankers={countMiddleEast:async()=>({preciseCount:0,estimatedCount:2,observedIncludingEstimates:2,complete:false,actualRegionalCount:null})};
  const server=mod.createMcpApp({token,airlines:{},satellite,vesselExtras,tankers}).listen(0,'127.0.0.1');
  await once(server,'listening');t.after(()=>new Promise(r=>server.close(r)));
  const client=new Client({name:'satellite-fixture',version:'1.0'});t.after(()=>client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`),{requestInit:{headers:{Authorization:'Bearer '+token}}}));
  const names=(await client.listTools()).tools.map(x=>x.name);
  assert.ok(names.includes('search_satellite_scenes'));
  assert.ok(names.includes('get_satellite_image'));
  assert.ok(names.includes('get_vessel_details'));
  assert.ok(names.includes('count_us_tankers_middle_east'));
  const args={bbox:[51.35,35.68,51.37,35.70],from:'2026-10-01T00:00:00Z',to:'2026-11-01T00:00:00Z'};
  const search=await client.callTool({name:'search_satellite_scenes',arguments:args});
  assert.equal(search.structuredContent.scenes[0].id,'scene-fixture');
  const picture=await client.callTool({name:'get_satellite_image',arguments:args});
  assert.equal(picture.structuredContent.acquiredAt,'2026-10-30T10:00:00Z');
  assert.equal(picture.content[1].type,'image');
  assert.equal(picture.content[1].mimeType,'image/png');
  assert.equal(picture.content[1].data,Buffer.from([137,80,78,71,13,10,26,10]).toString('base64'));
  const details=await client.callTool({name:'get_vessel_details',arguments:{identifier:'EVER GIVEN'}});
  assert.equal(details.structuredContent.status,'partial');
  assert.equal(details.structuredContent.details.grossTonnage,null);
  assert.deepEqual(details.structuredContent.lockedFields,['grossTonnage']);
  const counted=await client.callTool({name:'count_us_tankers_middle_east',arguments:{}});
  assert.equal(counted.structuredContent.estimatedCount,2);
  assert.equal(counted.structuredContent.preciseCount,0);
  assert.equal(counted.structuredContent.actualRegionalCount,null);
});

test('regional MCP selectors and bounded paging reach their services without declaring exact counts',async t=>{
  const geography={resolveAirports:selection=>({selection,count:2})};
  const regionalHistory={getRegionalArrivals:async args=>({...args,status:'partial',exactCount:null,exactCargoArrivalCount:null})};
  const server=mod.createMcpApp({token,airlines:{},geography,regionalHistory}).listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(r=>server.close(r)));
  const client=new Client({name:'regional-fixture',version:'1'});t.after(()=>client.close());await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`),{requestInit:{headers:{Authorization:'Bearer '+token}}}));
  const resolved=await client.callTool({name:'resolve_region_airports',arguments:{selection:{country:'IR'}}});assert.equal(resolved.structuredContent.selection.country,'IR');
  const args={selection:{airports:['DXB','DWC']},from:'2026-10-01T00:00:00Z',to:'2026-11-01T00:00:00Z',airportOffset:1,maxAirports:1,maxPages:2};
  const response=await client.callTool({name:'get_region_arrivals',arguments:args});assert.equal(response.structuredContent.airportOffset,1);assert.equal(response.structuredContent.maxAirports,1);assert.equal(response.structuredContent.maxPages,2);assert.equal(response.structuredContent.exactCargoArrivalCount,null);
  const invalid=await client.callTool({name:'resolve_region_airports',arguments:{selection:{country:'IR',airports:['DXB']}}});assert.equal(invalid.isError,true);
});
