import {constants} from 'node:fs';
import {lstat,mkdir,open,rename,unlink,readdir} from 'node:fs/promises';
import {resolve,parse,join,isAbsolute} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {ClientError} from './session.mjs';

const ENTRY_LIMIT=8*1024*1024,TOTAL_LIMIT=64*1024*1024,FILE_LIMIT=256;
const unsafe=()=>new ClientError('AIRPORT_EVENTS_CACHE_UNSAFE','Airport cache must use a bounded regular directory without symbolic links');
const storeError=()=>new ClientError('AIRPORT_EVENTS_CACHE_FAILED','Airport cache could not be safely read or written');
const allowed=/^airport-events-(?:[a-f0-9]{64}|cooldown)\.json$/;
export class AirportEventsCache{
  #directory;
  constructor(directory){if(typeof directory!=='string'||!isAbsolute(directory)||directory.includes('\0'))throw unsafe();this.#directory=resolve(directory);}
  async init(){
    const root=parse(this.#directory).root;let current=root;
    for(const part of this.#directory.slice(root.length).split(/[\\/]/).filter(Boolean)){
      current=join(current,part);let info;
      try{info=await lstat(current);}catch(error){if(error.code!=='ENOENT')throw storeError();await mkdir(current,{mode:0o700});info=await lstat(current);}
      if(info.isSymbolicLink()||!info.isDirectory())throw unsafe();
    }
    const files=await this.#inventory();if(files.length>FILE_LIMIT||files.reduce((sum,file)=>sum+file.size,0)>TOTAL_LIMIT)throw unsafe();
  }
  #path(key){return join(this.#directory,'airport-events-'+createHash('sha256').update(key).digest('hex')+'.json');}
  async #read(path,max=ENTRY_LIMIT){
    let file;
    try{
      await this.init();
      const before=await lstat(path);if(before.isSymbolicLink()||!before.isFile()||before.size>max)throw unsafe();
      file=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));const after=await file.stat();
      if(!after.isFile()||after.size>max||(before.ino&&after.ino&&before.ino!==after.ino))throw unsafe();
      const buffer=Buffer.alloc(max+1);let length=0;
      while(length<buffer.length){const {bytesRead}=await file.read(buffer,length,buffer.length-length,null);if(!bytesRead)break;length+=bytesRead;}
      if(length>max)throw unsafe();return JSON.parse(buffer.subarray(0,length).toString('utf8'));
    }catch(error){if(error.code==='ENOENT')return null;if(error instanceof ClientError)throw error;throw storeError();}
    finally{await file?.close().catch(()=>{});}
  }
  async #inventory(){
    let entries;try{entries=await readdir(this.#directory,{withFileTypes:true});}catch{throw storeError();}
    if(entries.length>2048)throw unsafe();const files=[];
    for(const entry of entries){
      if(!allowed.test(entry.name))continue;
      if(entry.isSymbolicLink()||!entry.isFile())throw unsafe();
      const path=join(this.#directory,entry.name),info=await lstat(path);
      if(info.isSymbolicLink()||!info.isFile()||info.size>ENTRY_LIMIT)throw unsafe();
      if(entry.name!=='airport-events-cooldown.json')files.push({path,size:info.size,mtime:info.mtimeMs});
    }
    if(files.length>FILE_LIMIT+1||files.reduce((sum,file)=>sum+file.size,0)>TOTAL_LIMIT+ENTRY_LIMIT)throw unsafe();
    return files.sort((a,b)=>a.mtime-b.mtime);
  }
  async #write(path,value){
    await this.init();
    const text=JSON.stringify(value);if(Buffer.byteLength(text)>ENTRY_LIMIT)throw storeError();
    try{const existing=await lstat(path);if(existing.isSymbolicLink()||!existing.isFile())throw unsafe();}catch(error){if(error.code!=='ENOENT')throw error;}
    const temporary=join(this.#directory,'airport-events-tmp-'+randomUUID()+'.tmp');let file;
    try{file=await open(temporary,'wx',0o600);await file.writeFile(text,'utf8');await file.sync();await file.close();file=null;await rename(temporary,path);}
    catch(error){if(error instanceof ClientError)throw error;throw storeError();}
    finally{await file?.close().catch(()=>{});await unlink(temporary).catch(()=>{});}
    const files=await this.#inventory();let total=files.reduce((sum,entry)=>sum+entry.size,0);
    while(files.length>FILE_LIMIT||total>TOTAL_LIMIT){const oldest=files.shift();await unlink(oldest.path);total-=oldest.size;}
  }
  read(key){return this.#read(this.#path(key));}
  write(key,value){return this.#write(this.#path(key),value);}
  async readCooldown(){const value=await this.#read(join(this.#directory,'airport-events-cooldown.json'),4096);if(value===null)return 0;if(value.version!==1||typeof value.retryAt!=='string'||!Number.isFinite(Date.parse(value.retryAt)))throw storeError();return Date.parse(value.retryAt);}
  writeCooldown(until){return this.#write(join(this.#directory,'airport-events-cooldown.json'),{version:1,retryAt:new Date(until).toISOString()});}
}
