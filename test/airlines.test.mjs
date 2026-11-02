import test from 'node:test';
import assert from 'node:assert/strict';
const mod=await import('../airlines.mjs').catch(()=>({}));
const transport=await import('../live.mjs');

test('resolves Persian names and IATA/ICAO codes to one airline',()=>{
  assert.equal(typeof mod.resolveAirline,'function','Airline resolver must exist');
  assert.equal(mod.resolveAirline('ماهان').icao,'IRM');
  assert.equal(mod.resolveAirline('EK').icao,'UAE');
  assert.equal(mod.resolveAirline('Iran Air').icao,'IRA');
  assert.throws(()=>mod.resolveAirline('does-not-exist'),/airline/i);
});
test('applies the actual operating-airline and airborne filters on the server request',()=>{
  assert.equal(typeof transport.buildAirlineRequest,'function','Airline filter request must exist');
  const r=transport.buildAirlineRequest('IRM');
  assert.deepEqual(r.filters,[{airlines:[{icao:'IRM',type:1}]}]);
  assert.equal(r.settings.trafficType,2);
  assert.equal(r.maxage,300);
  assert.deepEqual(r.bounds,{north:90,south:-90,west:-180,east:180});
});
test('counts unique airborne flight IDs and labels a capped result incomplete',async()=>{
  assert.equal(typeof mod.AirlineService,'function','Airline service must exist');
  let called;
  const live={queryAirline:async(...args)=>{called=args;return {flights:[{flightId:1,onGround:false},{flightId:1,onGround:false},{flightId:2,onGround:true}],serverTimeMs:'1700000000000'};}};
  const service=new mod.AirlineService({live,fetchLimit:3});
  const result=await service.count('ماهان');
  assert.equal(called[1],'IRM');
  assert.equal(result.count,1);
  assert.equal(result.complete,false);
  assert.equal(result.airline.icao,'IRM');
  assert.equal(result.source,'Flightradar24');
});
