import test from 'node:test';
import assert from 'node:assert/strict';
const mod=await import('../track-export.mjs').catch(()=>({}));
const p=(reportedAt,longitude=51,latitude=25,extra={})=>({reportedAt,longitude,latitude,...extra});
const first=p('2026-11-01T00:00:00Z',51,25,{altitudeFeet:1000,speedKnots:120});
const second=p('2026-11-01T00:01:00Z',51.1,25.1);
function exportTrack(...args){assert.equal(typeof mod.exportTrack,'function');return mod.exportTrack(...args);}

test('CSV export preserves all supplied samples and measurements in chronological order without mutation',()=>{
  const input=[second,first,first],before=structuredClone(input);
  const result=exportTrack(input,{format:'csv',name:'Flight samples'});
  assert.equal(result.filename,'Flight-samples.csv');assert.equal(result.mimeType,'text/csv');assert.equal(result.pointCount,3);
  assert.deepEqual(input,before);
  const lines=result.text.trimEnd().split('\r\n');
  assert.equal(lines[0],'"reportedAt","latitude","longitude","altitudeFeet","speedKnots"');
  assert.equal(lines[1],'"2026-11-01T00:00:00.000Z","25","51","1000","120"');
  assert.equal(lines[2],lines[1]);assert.equal(lines[3],'"2026-11-01T00:01:00.000Z","25.1","51.1","",""');
  assert.equal(result.coverage.complete,false);
});

test('KML escapes XML names, retains timestamps and measurements, and explicitly renders a ground-projected path',()=>{
  const result=exportTrack([first,second],{format:'kml',name:'A < B & "C"'});
  assert.equal(result.mimeType,'application/vnd.google-earth.kml+xml');
  assert.ok(result.text.includes('A &lt; B &amp; &quot;C&quot;'));
  assert.equal((result.text.match(/<when>/g)??[]).length,2);
  assert.equal((result.text.match(/<gx:coord>/g)??[]).length,2);
  assert.ok(result.text.includes('<gx:coord>51 25 0</gx:coord>'));
  assert.ok(result.text.includes('<altitudeMode>clampToGround</altitudeMode>'));
  assert.ok(result.text.includes('<gx:value>1000</gx:value>'));
  assert.ok(result.text.includes('<gx:value>unknown</gx:value>'));
  assert.ok(!result.text.includes('<gx:value></gx:value>'));
  assert.equal(result.coverage.altitudeRendering,'ground_projection_not_measured_elevation');
});

test('KML splits time gaps and antimeridian crossings without interpolating samples',()=>{
  const points=[p('2026-11-01T00:00:00Z',179),p('2026-11-01T00:01:00Z',-179),p('2026-11-01T02:00:00Z',-178)];
  const result=exportTrack(points,{format:'kml'});
  assert.equal((result.text.match(/<gx:Track>/g)??[]).length,3);
  assert.equal((result.text.match(/<gx:coord>/g)??[]).length,3);
  assert.equal(result.coverage.segmentCount,3);assert.equal(result.coverage.breaks.antimeridian,1);assert.equal(result.coverage.breaks.timeGap,1);
  assert.ok(!result.text.includes('<gx:interpolate>1'));
});

test('conflicting positions at one timestamp cannot connect to neighbours but all original samples remain exported',()=>{
  const result=exportTrack([first,p(first.reportedAt,52),second],{format:'kml'});
  assert.equal(result.pointCount,3);assert.equal(result.coverage.segmentCount,3);
  assert.equal((result.text.match(/<when>/g)??[]).length,3);
  assert.ok(result.coverage.breaks.timestampConflict>=2);
});

test('invalid records, coordinates, timestamps, optional measurements and unsafe options fail instead of fabricating data',()=>{
  for(const bad of [null,{...first,latitude:91},{...first,longitude:Infinity},{...first,reportedAt:'2026-02-30T00:00:00Z'},{...first,reportedAt:'2026-11-01T00:00:00+00:00'},{...first,speedKnots:'=HYPERLINK("evil")'},{...first,altitudeFeet:NaN},{...first,speedKnots:-1}])assert.throws(()=>exportTrack([bad],{format:'csv'}),e=>e.code==='TRACK_EXPORT_INPUT_INVALID');
  for(const options of [{format:'exe'},{format:'csv',maxGapSeconds:0},{format:'csv',name:'bad\u0001name'},{format:'csv',name:'a'.repeat(121)},{format:'csv',unknown:true}])assert.throws(()=>exportTrack([first],options),e=>e.code==='TRACK_EXPORT_INPUT_INVALID');
  assert.throws(()=>exportTrack(Array(10001).fill(first),{format:'csv'}),e=>e.code==='TRACK_EXPORT_INPUT_INVALID');
});

test('export filenames cannot escape a directory or start a spreadsheet formula and empty tracks remain explicit',()=>{
  const result=exportTrack([],{format:'csv',name:'../../=SUM(1,2)'});
  assert.ok(!/[\\/]/.test(result.filename));assert.ok(!/^[=+@-]/.test(result.filename));
  assert.equal(result.pointCount,0);assert.equal(result.coverage.complete,false);
  assert.ok(Buffer.byteLength(result.text,'utf8')<=4*1024*1024);
});

test('large valid sample sets obey both the sample bound and the 4 MiB UTF-8 output bound',()=>{
  const start=Date.parse('2026-01-01T00:00:00Z');
  const points=Array.from({length:10000},(_,i)=>p(new Date(start+i*7200000).toISOString()));
  const result=exportTrack(points,{format:'csv'});assert.equal(result.pointCount,10000);
  assert.throws(()=>exportTrack(points,{format:'kml'}),e=>e.code==='TRACK_EXPORT_TOO_LARGE');
});

test('sparse sample arrays are malformed input rather than silent sample loss',()=>{
  assert.throws(()=>exportTrack(new Array(2),{format:'csv'}),e=>e.code==='TRACK_EXPORT_INPUT_INVALID');
});
