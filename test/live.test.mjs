import test from 'node:test';
import assert from 'node:assert/strict';
import grpc from '@grpc/grpc-js';
import loader from '@grpc/proto-loader';
import {fileURLToPath} from 'node:url';

const mod = await import('../live.mjs').catch(() => ({}));
test('live client must exist and validate geographic bounds', () => {
  assert.equal(typeof mod.buildLiveRequest,'function','LiveFeed client must be implemented');
  assert.throws(() => mod.buildLiveRequest({north:91,south:20,west:40,east:60}),/bounds/i);
  assert.throws(() => mod.buildLiveRequest({north:20,south:30,west:40,east:60}),/bounds/i);
  assert.throws(() => mod.buildLiveRequest({north:40,south:20,west:40,east:60},0),/limit/i);
});
test('gRPC performs real protobuf serialization and carries session metadata', async t => {
  assert.equal(typeof mod.LiveFlights,'function','LiveFeed client must be implemented');
  const def=loader.loadSync(fileURLToPath(new URL('../feed.proto',import.meta.url)),{longs:String});
  const proto=grpc.loadPackageDefinition(def).fr24.feed.api.v1;
  let seen;
  const server=new grpc.Server();
  server.addService(proto.Feed.service,{LiveFeed(call,cb){
    seen={request:call.request,authorization:call.metadata.get('authorization'),platform:call.metadata.get('fr24-platform')[0],deviceId:call.metadata.get('fr24-device-id')[0]};
    cb(null,{flights:[{flightId:42,lat:35.5,lon:51.5,alt:30000,callsign:'FIXTURE42',timestamp:'1700000000'}],serverTimeMs:'1700000000000'});
  }});
  const port=await new Promise((resolve,reject)=>server.bindAsync('127.0.0.1:0',grpc.ServerCredentials.createInsecure(),(e,p)=>e?reject(e):resolve(p)));
  t.after(()=>new Promise(r=>server.tryShutdown(r)));
  const client=new mod.LiveFlights({target:`127.0.0.1:${port}`,credentials:grpc.credentials.createInsecure()});
  t.after(()=>client.close());
  const session={authorization:async()=>({authorization:'Bearer fixture-token'})};
  const result=await client.query(session,{north:36,south:35,west:50,east:52},10);
  assert.equal(result.flights[0].callsign,'FIXTURE42');
  assert.equal(result.flights[0].flightId,42);
  assert.deepEqual(seen.authorization,['Bearer fixture-token']);
  assert.equal(seen.platform, 'android-10.18.0');
  assert.match(seen.deviceId,/^android-/);
  assert.equal(seen.request.bounds.north,36);
  assert.equal(seen.request.limit,10);
  assert.deepEqual(seen.request.fieldMask?.paths,['type','reg','flight','route','vspeed','age','logo_id']);
});
