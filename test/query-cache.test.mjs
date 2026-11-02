import test from 'node:test';import assert from 'node:assert/strict';
const mod=await import('../query-cache.mjs').catch(()=>({}));
test('live most-tracked rankings expire after15seconds while historical tracks retain60seconds',()=>{
  assert.equal(typeof mod.ttlForTool,'function');assert.equal(mod.ttlForTool('get_most_tracked_flights'),15000);assert.equal(mod.ttlForTool('get_aircraft_track'),60000);assert.equal(mod.ttlForTool('count_vessels_in_area'),15000);
});
test('cache coalesces concurrent reads and expiry fetches a fresh source result',async()=>{
  assert.equal(typeof mod.QueryCache,'function');let now=0,calls=0;const c=new mod.QueryCache({clock:()=>now});const fetch=async()=>({sourceTime:'original',value:++calls});
  const [a,b]=await Promise.all([c.read('x',{q:1},fetch,1000),c.read('x',{q:1},fetch,1000)]);assert.equal(calls,1);assert.deepEqual(a,b);now=1001;assert.equal((await c.read('x',{q:1},fetch,1000)).value,2);
});
test('different inputs stay separate and failed or blocked reads are not cached',async()=>{
  assert.equal(typeof mod.QueryCache,'function');const c=new mod.QueryCache();let n=0;const fetch=async()=>({value:++n});await c.read('x',{a:1},fetch);await c.read('x',{a:2},fetch);assert.equal(n,2);
  let failures=0;for(let i=0;i<2;i++)await assert.rejects(c.read('bad',{},async()=>{failures++;throw Error('fixture');}));assert.equal(failures,2);
  let blocks=0;for(let i=0;i<2;i++)await c.read('blocked',{},async()=>({status:'blocked',attempt:++blocks}));assert.equal(blocks,2);
});
