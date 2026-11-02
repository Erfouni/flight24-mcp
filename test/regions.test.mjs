import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const api=await import('../regions.mjs').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error;});
const ready=typeof api.resolveAirport==='function';

test('source catalog region and airport resolvers exist',()=>{
  assert.equal(typeof api.resolveAirport,'function');assert.equal(typeof api.resolveAirports,'function');
});
test('IATA, ICAO and numeric ID resolve to the same verified airport and timezone',{skip:!ready},()=>{
  const a=api.resolveAirport('DXB'),b=api.resolveAirport('omdb'),c=api.resolveAirport(916);
  assert.equal(a.id,916);assert.deepEqual(a,b);assert.deepEqual(a,c);
  assert.equal(a.country.alpha2,'AE');assert.equal(a.country.name,'United Arab Emirates');
  assert.equal(a.latitude,25.252769);assert.equal(a.longitude,55.364441);
  assert.equal(a.timezone,'Asia/Dubai');assert.equal(a.timezoneValid,true);
  assert.throws(()=>api.resolveAirport('NO_SUCH_AIRPORT'),/airport/i);
});
test('country selectors use the actual country catalog and declare airport destination scope',{skip:!ready},()=>{
  const iso=api.resolveAirports({country:'IR'}),name=api.resolveAirports({country:'Iran'});
  assert.equal(iso.count,name.count);assert.ok(iso.count>20);
  assert.ok(iso.airports.every(a=>a.country.alpha2==='IR'));
  assert.equal(iso.scope,'airport_destinations');assert.equal(iso.catalog.airportCount,6389);
  assert.equal(iso.catalog.airportUpdatedAt,'2025-10-18T20:07:33Z');
  assert.equal(iso.coverage.completeWorldwideAirportCensus,false);
  assert.throws(()=>api.resolveAirports({country:'Made Up Country'}),/country/i);
});
test('explicit aliases deduplicate by real airport ID and never silently ignore an unknown code',{skip:!ready},()=>{
  const result=api.resolveAirports({airports:['DXB','OMDB',916,'THR','OIII']});
  assert.equal(result.count,2);assert.deepEqual(result.airports.map(a=>a.id).sort((a,b)=>a-b),[916,3469]);
  assert.throws(()=>api.resolveAirports({airports:['DXB','ZZZZ']}),/airport/i);
});
test('bbox and polygon use airport coordinates, include outer boundaries and exclude holes',{skip:!ready},()=>{
  const dxb=api.resolveAirport('DXB');
  const box=api.resolveAirports({bbox:[55.3,25.2,55.4,25.3]});assert.ok(box.airports.some(a=>a.id===916));
  const outer=[[55,25],[56,25],[56,26],[55,26],[55,25]];
  const polygon=api.resolveAirports({polygon:{type:'Polygon',coordinates:[outer]}});assert.ok(polygon.airports.some(a=>a.id===916));
  const hole=[[55.35,25.24],[55.38,25.24],[55.38,25.27],[55.35,25.27],[55.35,25.24]];
  const excluded=api.resolveAirports({polygon:{type:'Polygon',coordinates:[outer,hole]}});assert.ok(!excluded.airports.some(a=>a.id===916));
  const boundary=api.resolveAirports({bbox:[dxb.longitude,dxb.latitude,56,26]});assert.ok(boundary.airports.some(a=>a.id===916));
});
test('antimeridian bounding boxes select both sides without enclosing Greenwich',{skip:!ready},()=>{
  const selected=api.resolveAirports({bbox:[170,-60,-170,60]});
  assert.ok(selected.count>0);assert.ok(selected.airports.every(a=>Math.abs(a.longitude)>=170));
});

test('GeoJSON polygon edges preserve wide longitude spans without silently selecting the opposite region',{skip:!ready},()=>{
  const ring=[[-100,0],[100,0],[100,70],[-100,70],[-100,0]];
  const poly=api.resolveAirports({polygon:{type:'Polygon',coordinates:[ring]}});
  const bbox=api.resolveAirports({bbox:[-100,0,100,70]});
  assert.deepEqual(poly.airports.map(a=>a.id),bbox.airports.map(a=>a.id));
  assert.ok(poly.airports.some(a=>a.iata==='LHR'));assert.ok(!poly.airports.some(a=>a.iata==='HNL'));
});
test('exclusive modes and invalid geometries fail instead of broadening a traffic query',{skip:!ready},()=>{
  for(const selector of [{},{country:'IR',bbox:[40,20,60,40]},{bbox:[0,0,0,1]},{bbox:[0,-91,1,1]},{polygon:{type:'Polygon',coordinates:[[[0,0],[1,0],[0,1]]]}}])assert.throws(()=>api.resolveAirports(selector));
});
test('normalized data retains every real row and country join and returned records cannot mutate the index',{skip:!ready},()=>{
  const catalog=JSON.parse(readFileSync(new URL('../airport-catalog.json',import.meta.url),'utf8'));
  assert.equal(catalog.airports.length,6389);assert.equal(new Set(catalog.airports.map(a=>a.id)).size,6389);
  const countries=new Set(catalog.countries.map(c=>c.id));assert.ok(catalog.airports.every(a=>countries.has(a.countryId)));
  const record=api.resolveAirport('THR');record.country.name='changed';
  assert.equal(api.resolveAirport('THR').country.name,'Iran');
  assert.equal(api.resolveAirports({bbox:[-180,-90,180,90]}).count,6389);
});
