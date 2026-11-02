import test from 'node:test';
import assert from 'node:assert/strict';
const mod=await import('../track-measurements.mjs').catch(()=>({}));
const point=(reportedAt,longitude,latitude=0)=>({reportedAt,longitude,latitude});

test('track measures one equatorial degree in an hour as a spherical endpoint lower bound',()=>{
  assert.equal(typeof mod.measureTrack,'function','measureTrack must exist');
  const result=mod.measureTrack([point('2026-11-02T00:00:00Z',0),point('2026-11-02T01:00:00Z',1)]);
  assert.equal(result.status,'measured');
  assert.equal(result.elapsedSeconds,3600);
  assert(Math.abs(result.observedDistanceKm-111.19508)<0.00001);
  assert(Math.abs(result.observedDistanceNm-60.04054)<0.00001);
  assert.equal(result.averageObservedSegmentSpeedKnots,result.observedDistanceNm);
  assert.equal(result.segments[0].derivedGroundSpeedKnots,result.observedDistanceNm);
  assert.equal(result.actualRouteDistanceKnown,false);
  assert.equal(result.historyRetentionKnown,false);
});

test('track sorts a copy and deduplicates repeated records without mutating caller data',()=>{
  const first=point('2026-11-02T00:00:00Z',0),last=point('2026-11-02T01:00:00Z',1);
  const input=[last,first,{...first}],before=JSON.stringify(input);
  const result=mod.measureTrack(input);
  assert.equal(JSON.stringify(input),before);
  assert.equal(result.inputPointCount,3);assert.equal(result.duplicateRecordsRemoved,1);
  assert.equal(result.usablePointCount,2);assert.equal(result.segments.length,1);
  assert.equal(result.firstReportedAt,'2026-11-02T00:00:00.000Z');
});

test('track takes the short two-degree path across the antimeridian',()=>{
  const result=mod.measureTrack([point('2026-11-02T00:00:00Z',179),point('2026-11-02T01:00:00Z',-179)]);
  assert(Math.abs(result.observedDistanceKm-222.39016)<0.00001);
  assert(result.segments[0].derivedGroundSpeedKnots<121);
});

test('track excludes long gaps and distinguishes connected-time speed from a wall-time ratio',()=>{
  const result=mod.measureTrack([point('2026-11-02T00:00:00Z',0),point('2026-11-02T01:00:00Z',1),point('2026-11-02T04:00:00Z',4),point('2026-11-02T05:00:00Z',5)]);
  assert.equal(result.elapsedSeconds,18000);assert.equal(result.observedSegmentSeconds,7200);
  assert.equal(result.excludedIntervalSeconds,10800);assert.equal(result.gaps.length,1);
  assert.equal(result.gaps[0].reason,'time_gap');assert.equal(result.gaps[0].elapsedSeconds,10800);
  assert(!('derivedGroundSpeedKnots' in result.gaps[0]));
  assert(Math.abs(result.observedDistanceKm-222.39016)<0.00001);
  assert(Math.abs(result.averageObservedSegmentSpeedKnots-60.04054)<0.00001);
  assert(Math.abs(result.observedDistanceOverWallTimeKnots-24.016216)<0.00001);
  const joined=mod.measureTrack([point('2026-11-02T00:00:00Z',0),point('2026-11-02T03:00:00Z',3)],{maxGapSeconds:10800});
  assert.equal(joined.gaps.length,0);assert.equal(joined.segments.length,1);
});

test('track flags timestamp collisions and excludes both adjacent intervals rather than inventing speed',()=>{
  const result=mod.measureTrack([point('2026-11-02T00:00:00Z',0),point('2026-11-02T00:30:00Z',0.5),point('2026-11-02T00:30:00Z',5),point('2026-11-02T01:00:00Z',1)]);
  assert.equal(result.conflictingTimestamps.length,1);
  assert.equal(result.conflictingTimestamps[0].distinctPositions,2);
  assert.equal(result.status,'insufficient_connected_points');
  assert.equal(result.segments.length,0);assert.equal(result.gaps.length,2);
  assert(result.gaps.every(g=>g.reason==='timestamp_conflict'));
  assert.equal(result.averageObservedSegmentSpeedKnots,null);
  assert.equal(result.observedDistanceOverWallTimeKnots,null);
});

test('track rejects non-finite or out-of-range coordinates and invalid UTC dates',()=>{
  for(const input of [null,[point('2026-11-02T00:00:00Z',181)],[point('2026-11-02T00:00:00Z',0,91)],[point('2026-11-02T00:00:00Z',NaN)],[point('2026-02-30T00:00:00Z',0)],[point('2026-11-02T00:00:00+03:00',0)]]){
    assert.throws(()=>mod.measureTrack(input),e=>e.code==='TRACK_INPUT_INVALID');
  }
  assert.throws(()=>mod.measureTrack([],{maxGapSeconds:0}),e=>e.code==='TRACK_INPUT_INVALID');
});

test('track with fewer than two usable records reports insufficient data without a zero-speed claim',()=>{
  for(const points of [[],[point('2026-11-02T00:00:00Z',0)]]){
    const result=mod.measureTrack(points);
    assert.equal(result.status,'insufficient_connected_points');
    assert.equal(result.averageObservedSegmentSpeedKnots,null);
    assert.equal(result.observedDistanceOverWallTimeKnots,null);
    assert.equal(result.actualRouteDistanceKnown,false);
  }
});
