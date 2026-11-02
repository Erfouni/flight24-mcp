import grpc from '@grpc/grpc-js';
import loader from '@grpc/proto-loader';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {ClientError, DEFAULT_AGENT} from './session.mjs';

const definition=loader.loadSync(fileURLToPath(new URL('./feed.proto',import.meta.url)),{longs:String,arrays:true,defaults:false});
const Feed=grpc.loadPackageDefinition(definition).fr24.feed.api.v1.Feed;

export function buildLiveRequest(bounds, limit=100) {
  if (!bounds || !['north','south','west','east'].every(k=>Number.isFinite(bounds[k])) ||
      bounds.north > 90 || bounds.south < -90 || bounds.north <= bounds.south ||
      bounds.west < -180 || bounds.east > 180 || bounds.west >= bounds.east) {
    throw new ClientError('BOUNDS_INVALID','Invalid geographic bounds; north must exceed south and east must exceed west');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new ClientError('LIMIT_INVALID','Limit must be an integer from 1 to 1000');
  // Source oj/m.java and zj/a.java: all sources, all service categories, all traffic.
  // Omit restriction mode; no access level is invented or asserted by this client.
  return {bounds,limit,maxage:14400,fieldMask:{paths:['type','reg','flight','route','vspeed','age','logo_id']},settings:{sources:[0,1,2,3,4,5,6,7,8,9],services:[0,1,2,3,4,5,6,7,8,9,10,11],trafficType:3}};
}

export function buildAirlineRequest(icao,limit=1000) {
  if (!/^[A-Z0-9]{3}$/.test(icao)) throw new ClientError('AIRLINE_INVALID','Supply a resolved ICAO airline code');
  const request=buildLiveRequest({north:90,south:-90,west:-180,east:180},limit);
  request.filters=[{airlines:[{icao,type:1}]}]; // sr/l and sr/m: OPERATED_BY=1.
  request.settings.trafficType=2; // sr/m1: AIRBORNE_ONLY.
  request.maxage=300;request.stats=true;
  return request;
}

export class LiveFlights {
  #client; #deviceId;
  constructor({settings, target, credentials, userAgent=DEFAULT_AGENT, deviceId='android-d-'+randomUUID()}={}) {
    if (!/^android-[A-Za-z0-9_-]{1,180}$/.test(deviceId)) throw new ClientError('CONFIG_INVALID','Invalid client device identifier');
    this.#deviceId=deviceId;
    if (!target) {
      const host=settings?.grpc?.feed?.url, port=settings?.grpc?.feed?.port;
      if (typeof host !== 'string' || !/^[a-z0-9.-]+\.flightradar24\.com$/i.test(host) ||
          !Number.isInteger(port) || port < 1 || port > 65535) throw new ClientError('CONFIG_INVALID','Invalid runtime gRPC host or port');
      target=host+':'+port;
      credentials=grpc.credentials.createSsl();
    } else if (!/^127\.0\.0\.1:\d+$/.test(target)) {
      throw new ClientError('CONFIG_INVALID','Explicit transport overrides are limited to loopback fixtures');
    }
    this.#client=new Feed(target,credentials,{'grpc.primary_user_agent':userAgent,'grpc.max_receive_message_length':8000000});
  }
  async query(session,bounds,limit=100) { return this.#request(session,buildLiveRequest(bounds,limit)); }
  async queryAirline(session,icao,limit=1000) { return this.#request(session,buildAirlineRequest(icao,limit)); }
  async #request(session,request) {
    const call=async()=>{
      const metadata=new grpc.Metadata();
      // Required metadata from gd/a.java, applied by oj/o.java in the APK.
      metadata.set('fr24-device-id',this.#deviceId);
      metadata.set('fr24-platform','android-10.18.0');
      for (const [key,value] of Object.entries(await session.authorization())) metadata.set(key,value);
      return new Promise((resolve,reject)=>this.#client.LiveFeed(request,metadata,{deadline:Date.now()+20000},(err,data)=>err?reject(err):resolve(data)));
    };
    try { return await call(); } catch (error) {
      if (error.code === grpc.status.UNAUTHENTICATED && typeof session.refresh === 'function') {
        await session.refresh();
        try { return await call(); } catch (again) { throw new ClientError('GRPC_'+again.code,'LiveFeed failed with gRPC status '+again.code); }
      }
      if (error instanceof ClientError) throw error;
      throw new ClientError('GRPC_'+error.code,'LiveFeed failed with gRPC status '+error.code);
    }
  }
  close() { this.#client.close(); }
}
