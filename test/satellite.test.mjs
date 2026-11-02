import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

const mod=await import('../satellite.mjs').catch(()=>({}));
const config={clientId:'fixture-client',clientSecret:'fixture-secret',tokenUrl:'https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token',processUrl:'https://sh.dataspace.copernicus.eu/process/v1'};
const query={bbox:[51.35,35.68,51.37,35.70],from:'2026-10-01T00:00:00Z',to:'2026-10-30T00:00:00Z'};
const json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
const token=()=>json({access_token:'fixture-bearer',token_type:'Bearer',expires_in:120});
const scene=()=>({type:'FeatureCollection',features:[{type:'Feature',id:'S2-fixture',bbox:[51,35,52,36],properties:{datetime:'2026-10-29T07:11:00Z','eo:cloud_cover':7}}],context:{returned:1}});
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFoUAAAAASUVORK5CYII=','base64');
// Minimal USTAR fixture, encoded independently from the production parser.
function tar(entries) {
  const parts=[];
  for(const [name,data] of Object.entries(entries)) {
    const bytes=Buffer.isBuffer(data)?data:Buffer.from(data);
    const header=Buffer.alloc(512);
    header.write(name);header.write('0000600\0',100);header.write('0000000\0',108);header.write('0000000\0',116);
    header.write(bytes.length.toString(8).padStart(11,'0')+'\0',124);header.write('00000000000\0',136);
    header.fill(32,148,156);header[156]=48;header.write('ustar\0',257);
    header.write([...header].reduce((a,b)=>a+b,0).toString(8).padStart(6,'0')+'\0 ',148);
    parts.push(header,bytes,Buffer.alloc((512-bytes.length%512)%512));
  }
  return Buffer.concat([...parts,Buffer.alloc(1024)]);
}
function imageResponse(acquisitions=[{date:'2026-10-29T07:11:00Z',cloudCoverage:7}]) {
  return new Response(tar({'default.png':png,'userdata.json':JSON.stringify({acquisitions})}),{headers:{'content-type':'application/tar'}});
}

test('satellite OAuth form and Catalog filters use trusted endpoints without credential output',async()=>{
  assert.equal(typeof mod.SatelliteService,'function','SatelliteService must exist');
  const requests=[];
  const service=new mod.SatelliteService({config,fetch:async(url,options)=>{requests.push({url,options});return requests.length===1?token():json(scene());}});
  const result=await service.searchScenes({...query,maxCloudCover:15,limit:4});
  assert.equal(requests[0].url,config.tokenUrl);
  assert.equal(requests[0].options.redirect,'error');
  assert.equal(new URLSearchParams(requests[0].options.body).get('grant_type'),'client_credentials');
  assert.equal(new URLSearchParams(requests[0].options.body).get('client_secret'),'fixture-secret');
  assert.equal(requests[1].url,'https://sh.dataspace.copernicus.eu/catalog/v1/search');
  assert.equal(requests[1].options.headers.authorization,'Bearer fixture-bearer');
  const body=JSON.parse(requests[1].options.body);
  assert.deepEqual(body.bbox,[51.35,35.68,51.37,35.70]);
  assert.deepEqual(body.collections,['sentinel-2-l2a']);
  assert.equal(body.datetime,'2026-10-01T00:00:00Z/2026-10-30T00:00:00Z');
  assert.equal(body.limit,4);
  assert.equal(body.filter,'eo:cloud_cover <= 15');
  assert.equal(result.scenes[0].timestamp,'2026-10-29T07:11:00Z');
  assert.equal(result.scenes[0].cloudCoverPercent,7);
  assert.equal(result.currentPositionGuarantee,false);
  assert(!JSON.stringify(service).includes('fixture-'));
  assert(!JSON.stringify(result).includes('fixture-secret'));
});

test('satellite token renewal is single-flight and refreshes before expiry',async()=>{
  let now=0,authCalls=0;
  const service=new mod.SatelliteService({config,clock:()=>now,fetch:async(url)=>{
    if(url===config.tokenUrl){authCalls++;await Promise.resolve();return token();}
    return json(scene());
  }});
  await Promise.all([service.searchScenes(query),service.searchScenes(query),service.searchScenes(query)]);
  assert.equal(authCalls,1);
  now=59000;await service.searchScenes(query);assert.equal(authCalls,1);
  now=60000;await Promise.all([service.searchScenes(query),service.searchScenes(query)]);assert.equal(authCalls,2);
});

test('satellite env loader allowlists keys and hides client credentials in inspection',async t=>{
  const path=join(tmpdir(),'satellite-fixture-'+randomUUID()+'.env');t.after(()=>unlink(path));
  await writeFile(path,'COPERNICUS_CLIENT_ID=fixture-client\nCOPERNICUS_CLIENT_SECRET="fixture-secret"\nCOPERNICUS_TOKEN_URL='+config.tokenUrl+'\nCOPERNICUS_PROCESS_URL='+config.processUrl+'\n');
  const loaded=await mod.loadSatelliteConfig(path);
  assert(!JSON.stringify(loaded).includes('fixture-'));
  const service=new mod.SatelliteService({config:loaded,fetch:async u=>u===config.tokenUrl?token():json(scene())});
  assert.equal((await service.searchScenes(query)).scenes.length,1);
  await writeFile(path,'COPERNICUS_CLIENT_ID=fixture-client\nCOPERNICUS_CLIENT_SECRET=fixture-secret\nUNRELATED_TOKEN=must-not-use\n');
  await assert.rejects(mod.loadSatelliteConfig(path),e=>e.code==='SATELLITE_CONFIG_INVALID'&&!/must-not-use|fixture/.test(e.message));
});

test('satellite rejects credential destinations outside the exact HTTPS host and endpoint allowlist',()=>{
  for(const tokenUrl of ['http://identity.dataspace.copernicus.eu/token','https://identity.dataspace.copernicus.eu.evil.invalid/token','https://user:pass@identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token','https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token?leak=yes']){
    assert.throws(()=>new mod.SatelliteService({config:{...config,tokenUrl}}),e=>e.code==='SATELLITE_CONFIG_INVALID');
  }
  assert.throws(()=>new mod.SatelliteService({config:{...config,processUrl:'https://elsewhere.invalid/process/v1'}}),e=>e.code==='SATELLITE_CONFIG_INVALID');
});

test('satellite validates bounds and real UTC dates before authenticating',async()=>{
  let calls=0;const service=new mod.SatelliteService({config,fetch:async()=>{calls++;throw new Error('must not fetch');}});
  for(const invalid of [{bbox:[51,35,50,36]},{bbox:[-181,35,0,36]},{bbox:[40,35,51,36]},{from:'2026-02-30T00:00:00Z'},{from:'2026-10-01T03:00:00+03:00'},{from:'2026-10-31T00:00:00Z'},{from:'2026-01-01T00:00:00Z'},{maxCloudCover:101},{limit:101}]){
    await assert.rejects(service.searchScenes({...query,...invalid}),e=>e.code==='SATELLITE_INPUT_INVALID');
  }
  await assert.rejects(service.getImage({...query,bbox:[50,35,52,36]}),e=>e.code==='SATELLITE_INPUT_INVALID');
  await assert.rejects(service.getImage({...query,width:1025}),e=>e.code==='SATELLITE_INPUT_INVALID');
  assert.equal(calls,0);
});

test('satellite image returns actual Process acquisition metadata and raw PNG separately',async()=>{
  let processRequest;
  const service=new mod.SatelliteService({config,fetch:async(url,options)=>{
    if(url===config.tokenUrl)return token();processRequest={url,options};return imageResponse();
  }});
  const result=await service.getImage({...query,width:1,height:1,maxCloudCover:100});
  assert.equal(processRequest.url,config.processUrl);
  const body=JSON.parse(processRequest.options.body);
  assert.equal(body.input.data[0].type,'sentinel-2-l2a');
  assert.equal(body.input.data[0].dataFilter.mosaickingOrder,'mostRecent');
  assert.equal(body.input.data[0].dataFilter.maxCloudCoverage,100);
  assert.equal(body.output.width,1);assert.equal(body.output.height,1);
  assert.deepEqual(body.output.responses.map(r=>r.identifier),['default','userdata']);
  assert.equal(processRequest.options.headers.accept,'application/tar');
  assert.match(body.evalscript,/B04/);assert.match(body.evalscript,/B03/);assert.match(body.evalscript,/B02/);
  assert(Buffer.isBuffer(result.image));assert.deepEqual(result.image,png);
  assert.equal(result.metadata.acquisitionTime,'2026-10-29T07:11:00Z');
  assert.equal(result.metadata.acquisitionTimeSource,'Process API userdata for rendered tile');
  assert.equal(result.metadata.currentPositionGuarantee,false);
  assert(!('image' in result.metadata));assert(!JSON.stringify(result.metadata).includes('base64'));
});

test('satellite image without real acquisition metadata is rejected',async()=>{
  const service=new mod.SatelliteService({config,fetch:async u=>u===config.tokenUrl?token():imageResponse([])});
  await assert.rejects(service.getImage(query),e=>e.code==='SATELLITE_NO_SCENES');
});

test('satellite HTTP and network errors never include bodies, credentials or thrown request text',async()=>{
  for(const failure of [new Response('fixture-secret fixture-bearer',{status:401}),new Error('fixture-secret fixture-bearer')]){
    let calls=0;const service=new mod.SatelliteService({config,fetch:async()=>{calls++;if(failure instanceof Error)throw failure;return failure;}});
    await assert.rejects(service.searchScenes(query),e=>!JSON.stringify({message:e.message,stack:e.stack}).includes('fixture-')&&e.code===(failure instanceof Error?'SATELLITE_NETWORK_FAILED':'SATELLITE_HTTP_401'));
    assert.equal(calls,1);
  }
});

test('satellite bounds response sizes even without Content-Length',async()=>{
  const service=new mod.SatelliteService({config,fetch:async u=>u===config.tokenUrl?token():new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(2_000_001));c.close();}}),{headers:{'content-type':'application/json'}})});
  await assert.rejects(service.searchScenes(query),e=>e.code==='SATELLITE_BAD_RESPONSE');
});
