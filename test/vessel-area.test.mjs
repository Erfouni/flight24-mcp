import test from 'node:test';
import assert from 'node:assert/strict';

const load = () => import('../vessel-area.mjs');
const now = () => Date.parse('2026-11-02T10:00:00Z');
const bbox = [3.8,51.8,4.6,52.2];
const row = (mmsi, extra={}) => ({ mmsi, name_ais:'EXAMPLE', longitude:4.2,latitude:52,ship_type_id:80,timestamp_of_position:1793613540,...extra });
const json = rows => new Response(JSON.stringify(rows),{headers:{'content-type':'application/json'}});

test('area count deduplicates MMSI and separates stale unknown and future report times',async()=>{
  const {VesselAreaService}=await load();
  const service=new VesselAreaService({now,fetchImpl:async()=>json([
    row(123456789),row(123456789,{timestamp_of_position:1793613480}),
    row(223456789,{timestamp_of_position:1793606400}),
    row(323456789,{timestamp_of_position:null}),
    row(423456789,{timestamp_of_position:1793613660}),
    row(523456789,{ship_type_id:70}),row(623456789,{ship_type_id:null}),
  ])});
  const result=await service.count({bbox,type:'tanker'});
  assert.equal(result.count,1);
  assert.equal(result.statistics.duplicateRows,1);
  assert.equal(result.statistics.staleCount,1);
  assert.equal(result.statistics.unknownReportTimeCount,1);
  assert.equal(result.statistics.futureReportTimeCount,1);
  assert.equal(result.statistics.unknownTypeCount,1);
  assert.equal(result.coverage.completeness,'unknown');
  assert.equal(result.classification.oilTankerCount,null);
});

test('area list builds the source-verified query and never substitutes retrieval for missing report time',async()=>{
  const {VesselAreaService}=await load();
  const service=new VesselAreaService({now,fetchImpl:async(url,options)=>{
    assert.equal(url.origin,'https://www.aisfriends.com');
    assert.equal(url.pathname,'/vessels/bounding-box');
    assert.equal(url.searchParams.get('lon_min'),'3.8');
    assert.equal(url.searchParams.get('lat_max'),'52.2');
    assert.equal(url.searchParams.get('zoom'),'8');
    assert.equal(options.redirect,'error');
    return json([row(123456789),row(223456789,{timestamp_of_position:null})]);
  }});
  const result=await service.list({bbox});
  assert.equal(result.vessels.length,1);
  assert.equal(result.vessels[0].reportedAt,'2026-11-02T09:59:00.000Z');
  assert.equal(result.vessels[0].ageSeconds,60);
  assert.equal(result.retrievedAt,'2026-11-02T10:00:00.000Z');
  assert.equal(result.statistics.unknownReportTimeCount,1);
});

test('a local list cap does not change count and cached list/count use one provider read',async()=>{
  const {VesselAreaService}=await load();let calls=0;
  const service=new VesselAreaService({now,fetchImpl:async()=>{calls++;return json([row(123456789),row(223456789)]);}});
  const listed=await service.list({bbox,limit:1});
  const counted=await service.count({bbox,limit:1});
  assert.equal(listed.vessels.length,1);
  assert.equal(listed.count,2);
  assert.equal(listed.coverage.outputTruncated,true);
  assert.equal(counted.count,2);
  assert.equal(calls,1);
});

test('area and polygon boundaries are inclusive and outside rows are not counted',async()=>{
  const {VesselAreaService}=await load();
  const service=new VesselAreaService({now,fetchImpl:async()=>json([
    row(123456789,{longitude:4,latitude:52}),
    row(223456789,{longitude:4.1,latitude:52.1}),
    row(323456789,{longitude:4.5,latitude:52.1}),
    row(423456789,{longitude:5,latitude:52.1}),
  ])});
  const result=await service.count({bbox,polygon:[[4,51.9],[4.2,51.9],[4.2,52.1],[4,52.1]]});
  assert.equal(result.count,2);
  assert.equal(result.statistics.outsideAreaCount,2);
});

test('area adapter rejects invalid geography unbounded regions and false oil-subtype selectors',async()=>{
  const {VesselAreaService}=await load();
  const service=new VesselAreaService({now,fetchImpl:async()=>{throw new Error('no network expected');}});
  await assert.rejects(service.count({bbox:[-180,-90,180,90]}),/small|bounded/i);
  await assert.rejects(service.count({bbox:[4,52,3,51]}),/bbox/i);
  await assert.rejects(service.count({bbox,type:'oil_tanker'}),/type/i);
  await assert.rejects(service.count({bbox,maxAgeSeconds:0}),/age/i);
});

test('area adapter fails on HTTP denial and oversize bodies instead of fabricating zero traffic',async()=>{
  const {VesselAreaService}=await load();
  for(const response of [new Response('',{status:403}),new Response('x'.repeat(2*1024*1024+1))]){
    const service=new VesselAreaService({now,fetchImpl:async()=>response});
    await assert.rejects(service.count({bbox}),/HTTP 403|too large/);
  }
});

test('a zero-observation primary snapshot checks the source-backed secondary and preserves compact tanker provenance',async()=>{
  const {VesselAreaService}=await load();
  const service=new VesselAreaService({now,fetchImpl:async url=>{
    if(url.hostname==='www.aisfriends.com')return json([]);
    assert.equal(url.hostname,'www.myshiptracking.com');
    assert.equal(url.searchParams.get('minlat'),'51.8');
    assert.equal(url.searchParams.get('zoom'),'9');
    return new Response('1793613600\n2\n8\t0\t123456789\tEXAMPLE\t52\t4.2\t8\t90\t0\t1\t1\t1\t\t1793613540\n0.01');
  }});
  const result=await service.list({bbox,type:'tanker'});
  assert.equal(result.count,1);
  assert.equal(result.vessels[0].aisType,null);
  assert.equal(result.vessels[0].providerTypeCode,'8');
  assert.equal(result.vessels[0].provider,'MyShipTracking public map');
  assert.equal(result.vessels[0].reportedAt,'2026-11-02T09:59:00.000Z');
  assert.equal(result.classification.oilTankerCount,null);
  assert.equal(result.coverage.providerAttempts.length,2);
  assert.equal(result.coverage.perProviderStatistics[0].count,0);
  assert.equal(result.coverage.perProviderStatistics[1].count,1);
});

test('a secondary source with stale reports cannot turn missing live coverage into current traffic',async()=>{
  const {VesselAreaService}=await load();
  const service=new VesselAreaService({now,fetchImpl:async url=>url.hostname==='www.aisfriends.com'?json([]):new Response('1793613600\n2\n8\t0\t123456789\tEXAMPLE\t52\t4.2\t8\t90\t0\t1\t1\t1\t\t1793606400\n0.01')});
  const result=await service.count({bbox,type:'tanker'});
  assert.equal(result.count,0);
  assert.equal(result.statistics.staleCount,1);
  assert.equal(result.coverage.perProviderStatistics[1].statistics.staleCount,1);
  assert.equal(result.coverage.completeness,'unknown');
});
