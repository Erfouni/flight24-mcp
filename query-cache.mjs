const HISTORICAL_TOOLS=new Set(['get_aircraft_history','get_aircraft_track','get_vessel_history','get_vessel_details','get_track_statistics','search_satellite_scenes','resolve_region_airports']);
export const ttlForTool=name=>['get_capabilities','start_region_history_job','get_region_history_job','analyze_region_history_job'].includes(name)?0:HISTORICAL_TOOLS.has(name)?60000:15000;
export class QueryCache {
  constructor({clock=Date.now,maxEntries=64,maxBytes=8000000}={}){this.clock=clock;this.maxEntries=maxEntries;this.maxBytes=maxBytes;this.bytes=0;this.entries=new Map();}
  drop(key){const old=this.entries.get(key);if(old){this.bytes-=old.bytes;this.entries.delete(key);}}
  async read(name,args,produce,ttl=15000){
    const key=name+':'+JSON.stringify(args);
    if(key.length>250000||ttl<=0)return produce();
    const hit=this.entries.get(key);
    if(hit&&hit.expiresAt>this.clock()){this.entries.delete(key);this.entries.set(key,hit);return hit.promise;}
    this.drop(key);
    const entry={expiresAt:Infinity,bytes:0,promise:null};
    entry.promise=Promise.resolve().then(produce).then(value=>{
      const keep=!value?.isError&&(!value?.status||['ok','partial','insufficient_connected_points'].includes(value.status));
      const bytes=Buffer.byteLength(JSON.stringify(value)??'null');
      if(!keep||bytes>this.maxBytes){if(this.entries.get(key)===entry)this.drop(key);return value;}
      if(this.entries.get(key)===entry){entry.bytes=bytes;entry.expiresAt=this.clock()+ttl;this.bytes+=bytes;
        while(this.entries.size>this.maxEntries||this.bytes>this.maxBytes)this.drop(this.entries.keys().next().value);}
      return value;
    },error=>{if(this.entries.get(key)===entry)this.drop(key);throw error;});
    this.entries.set(key,entry);
    while(this.entries.size>this.maxEntries)this.drop(this.entries.keys().next().value);
    return entry.promise;
  }
}
