import test from 'node:test';
import assert from 'node:assert/strict';
const mod=await import('../tankers.mjs').catch(()=>({}));
const now=Date.parse('2026-11-02T09:40:00Z');
const row={hex:'ae5bc1',r:'16-46016',t:'B762',dbFlags:1,alt_baro:27500,seen:0.5,rr_lat:25.4,rr_lon:53.9};
const identity={hex:'AE5BC1',registration:'16-46016',type:'KC-46A Pegasus',registered_owner:'United States Air Force'};
const run=(rows,ids={'ae5bc1':identity})=>{assert.equal(typeof mod.summarizeTankers,'function');return mod.summarizeTankers({now,ac:rows},ids,{now});};
test('KC-46 encoded B762 survives classification and stays in the rough-position count',()=>{
  const r=run([row]);assert.equal(r.preciseCount,0);assert.equal(r.estimatedCount,1);assert.equal(r.observedIncludingEstimates,1);assert.equal(r.aircraft[0].registration,'16-46016');assert.equal(r.aircraft[0].positionQuality,'receiver_estimate');assert.equal(r.complete,false);
});
test('generic B762 without exact identity is unresolved rather than assumed a tanker',()=>{
  const r=run([row],{});assert.equal(r.observedIncludingEstimates,0);assert.equal(r.unresolvedCandidates.length,1);
});
test('foreign ownership and identity registration mismatch cannot establish a US tanker',()=>{
  assert.equal(run([row],{'ae5bc1':{...identity,registered_owner:'Italian Air Force'}}).observedIncludingEstimates,0);
  assert.equal(run([row],{'ae5bc1':{...identity,registration:'different'}}).observedIncludingEstimates,0);
});
test('fresh measured positions are separate from rough estimates and duplicates count once',()=>{
  const a={...row,lat:25,lon:53,seen_pos:2};const r=run([a,a]);assert.equal(r.preciseCount,1);assert.equal(r.estimatedCount,0);
});
test('stale measured location cannot hide a fresh receiver estimate and absent positions remain unknown',()=>{
  assert.equal(run([{...row,lat:50,lon:1,seen_pos:1000}]).estimatedCount,1);
  const {rr_lat,rr_lon,...unlocated}=row;const r=run([unlocated]);assert.equal(r.observedIncludingEstimates,0);assert.equal(r.unlocatedConfirmedTankers.length,1);
});
test('ground, missing altitude, stale and invalid message ages never become airborne observations',()=>{
  for(const change of [{alt_baro:'ground'},{alt_baro:undefined},{seen:61},{seen:-1},{seen:undefined}])assert.equal(run([{...row,...change}]).observedIncludingEstimates,0);
});
test('fresh measured position outside the region takes priority over a rough position inside',()=>{
  assert.equal(run([{...row,lat:50,lon:1,seen_pos:1}]).observedIncludingEstimates,0);
});
test('a stale source snapshot raises an error instead of returning a fresh zero',()=>{
  assert.equal(typeof mod.summarizeTankers,'function');assert.throws(()=>mod.summarizeTankers({now:now-120000,ac:[row]},{'ae5bc1':identity},{now}),/stale/i);
});
