import {createHash,randomUUID} from 'node:crypto';
import {mkdir,lstat,realpath,readdir,open,rename,unlink} from 'node:fs/promises';
import {resolve,join,isAbsolute,dirname} from 'node:path';
import {ClientError} from './session.mjs';

const STORE_BYTES=64*1024*1024,DOWNLOAD_BYTES=4*1024*1024;
const ID=/^[a-f0-9]{32}$/;
const STATES=new Set(['queued','running','waiting','completed','partial_failed','interruption_required']);
const ACTIVE=new Set(['queued','running','waiting']);
const fail=(code,message)=>new ClientError(code,message);
const input=()=>fail('HISTORY_JOB_INPUT_INVALID','Provide a valid history job ID and bounded dataset page');
const storage=()=>fail('HISTORY_JOBS_STORE_UNAVAILABLE','The private history job store is unavailable or invalid');
const iso=value=>new Date(value).toISOString();
const safeCode=value=>typeof value==='string'&&(/^HTTP_[1-5]\d{2}$/.test(value)||['INTERACTION_REQUIRED','AIRPORT_TIMEZONE_UNAVAILABLE','AIRPORT_EVENTS_BAD_RESPONSE','AIRPORT_EVENTS_NOT_CONFIGURED','AIRPORT_EVENTS_SESSION_INVALID','AIRPORT_EVENTS_NETWORK_FAILED','SOURCE_FAILED','HISTORY_JOBS_RECORD_LIMIT','HISTORY_JOBS_STORE_UNAVAILABLE'].includes(value))?value:'SOURCE_FAILED';
const terminalCode=code=>code==='HTTP_401'||code==='HTTP_403'||code==='INTERACTION_REQUIRED'||code==='AIRPORT_TIMEZONE_UNAVAILABLE'||code==='AIRPORT_EVENTS_NOT_CONFIGURED'||code==='AIRPORT_EVENTS_SESSION_INVALID';
async function assertDirectoryAncestors(directory,{allowMissing=false}={}){
  const paths=[];
  for(let path=directory;;path=dirname(path)){paths.push(path);if(dirname(path)===path)break;}
  for(const path of paths.reverse()){
    // Node reports EISDIR for an extended-namespace drive root. Its ordinary
    // drive spelling refers to that same root; children are still checked.
    const inspected=process.platform==='win32'&&/^\\\\\?\\[A-Za-z]:\\$/.test(path)?path.slice(4):path;
    let stat;try{stat=await lstat(inspected);}catch(error){if(allowMissing&&error.code==='ENOENT')return;throw error;}
    if(stat.isSymbolicLink()||!stat.isDirectory())throw storage();
  }
}

/** Serial, durable observations. Completed means the request plan finished,
 * never that the provider supplied a complete traffic census or cargo count. */
export class RegionalHistoryJobs{
  #regional;#directory;#clock;#maxJobs;#maxRecords;#maxRetries;#maxPlanned;#pace;#retryBase;#jobs=new Map();
  #init;#timer;#worker;#closed=false;#startTail=Promise.resolve();#notBefore=0;
  constructor({regionalAirportEvents,storeDir,clock=Date.now,maxJobs=20,maxRecords=100000,maxRetries=3,maxPlannedRequests=10000,paceMs=1000,retryBaseMs=1000}={}){
    if(typeof regionalAirportEvents?.getRegionalAirportEvents!=='function'||typeof regionalAirportEvents?.describeRegionalAirportEvents!=='function'||typeof storeDir!=='string'||!isAbsolute(storeDir)||/\0/.test(storeDir)||typeof clock!=='function'||!Number.isInteger(maxJobs)||maxJobs<1||maxJobs>20||!Number.isInteger(maxRecords)||maxRecords<1||maxRecords>100000||!Number.isInteger(maxRetries)||maxRetries<1||maxRetries>3||!Number.isInteger(paceMs)||paceMs<0||paceMs>60000)throw fail('HISTORY_JOBS_CONFIG_INVALID','Configure a private absolute job store, a regional service and bounded job settings');
    if(!Number.isInteger(retryBaseMs)||retryBaseMs<1||retryBaseMs>60000||!Number.isInteger(maxPlannedRequests)||maxPlannedRequests<1||maxPlannedRequests>10000)throw fail('HISTORY_JOBS_CONFIG_INVALID','Configure bounded retry and planned-request limits');
    this.#regional=regionalAirportEvents;this.#directory=resolve(storeDir);this.#clock=clock;this.#maxJobs=maxJobs;this.#maxRecords=maxRecords;this.#maxRetries=maxRetries;this.#maxPlanned=maxPlannedRequests;this.#pace=paceMs;this.#retryBase=retryBaseMs;
  }
  async #plainFile(path){const stat=await lstat(path);if(stat.isSymbolicLink()||!stat.isFile()||stat.size>STORE_BYTES)throw storage();return stat;}
  async #save(job){
    const filename=join(this.#directory,job.jobId+'.json'),temporary=join(this.#directory,'.'+job.jobId+'.'+randomUUID()+'.tmp');
    let handle;
    try{
      try{await this.#plainFile(filename);}catch(error){if(error.code!=='ENOENT')throw error;}
      const bytes=JSON.stringify(job);if(Buffer.byteLength(bytes)>STORE_BYTES)throw storage();
      handle=await open(temporary,'wx',0o600);await handle.writeFile(bytes,'utf8');await handle.sync();await handle.close();handle=undefined;
      await rename(temporary,filename);
    }catch{throw storage();}finally{await handle?.close().catch(()=>{});await unlink(temporary).catch(()=>{});}
  }
  initialize(){
    if(!this.#init)this.#init=this.#load();
    return this.#init;
  }
  async #load(){
    try{
      // Inspect links themselves before creating anything. A short Windows
      // filename or namespace alias is legitimate and is not a symbolic link.
      await assertDirectoryAncestors(this.#directory,{allowMissing:true});
      await mkdir(this.#directory,{recursive:true,mode:0o700});
      await assertDirectoryAncestors(this.#directory);
      this.#directory=await realpath(this.#directory);
      await assertDirectoryAncestors(this.#directory);
      const entries=(await readdir(this.#directory)).filter(name=>/^[a-f0-9]{32}\.json$/.test(name));
      if(entries.length>this.#maxJobs)throw storage();
      for(const name of entries){
        const path=join(this.#directory,name);await this.#plainFile(path);let handle;
        let job;try{handle=await open(path,'r');const stat=await handle.stat();if(stat.size>STORE_BYTES)throw storage();job=JSON.parse(await handle.readFile('utf8'));}finally{await handle?.close();}
        this.#validateStored(job,name.slice(0,-5));
        if(job.status==='running')job.status='queued';
        this.#notBefore=Math.max(this.#notBefore,Date.parse(job.retryAt)||0);
        this.#jobs.set(job.jobId,job);
      }
    }catch{throw storage();}
    this.#arm();return {initialized:true,jobCount:this.#jobs.size};
  }
  #validateStored(job,id){
    if(!job||job.kind!=='regional-history-job'||job.version!==1||job.jobId!==id||!ID.test(id)||!STATES.has(job.status)||!Array.isArray(job.records)||job.records.length>this.#maxRecords||!Number.isInteger(job.plannedRequestCount)||job.plannedRequestCount<0||!Number.isInteger(job.completedRequestCount)||job.completedRequestCount<0||job.completedRequestCount>job.plannedRequestCount||(job.nextOffset!==null&&(!Number.isInteger(job.nextOffset)||job.nextOffset<0||job.nextOffset>=job.plannedRequestCount))||!Number.isInteger(job.attemptsAtCheckpoint)||job.attemptsAtCheckpoint<0||job.attemptsAtCheckpoint>3||!Number.isFinite(Date.parse(job.createdAt))||!Number.isFinite(Date.parse(job.updatedAt))||(job.retryAt!==null&&!Number.isFinite(Date.parse(job.retryAt))))throw storage();
    const plan=this.#regional.describeRegionalAirportEvents(job.query);
    if(this.#id(plan.query)!==id||plan.plannedRequestCount!==job.plannedRequestCount||JSON.stringify(plan.query)!==JSON.stringify(job.query))throw storage();
    if(job.lastErrorCode!==null&&safeCode(job.lastErrorCode)!==job.lastErrorCode)throw storage();
  }
  #id(query){return createHash('sha256').update(JSON.stringify(query)).digest('hex').slice(0,32);}
  #summary(job){
    return {jobId:job.jobId,status:job.status,createdAt:job.createdAt,updatedAt:job.updatedAt,query:structuredClone(job.query),selection:structuredClone(job.selection),catalog:structuredClone(job.catalog),recordCount:job.records.length,nextOffset:job.nextOffset,retryAt:job.retryAt,lastErrorCode:job.lastErrorCode,
      progress:{plannedRequestCount:job.plannedRequestCount,completedRequestCount:job.completedRequestCount,remainingRequestCount:job.plannedRequestCount-job.completedRequestCount,attemptsAtCheckpoint:job.attemptsAtCheckpoint},
      scope:'actual_airport_events',limits:{maxJobs:this.#maxJobs,maxRecordsPerJob:this.#maxRecords,maxPlannedRequests:this.#maxPlanned,maxAttemptsPerCheckpoint:this.#maxRetries,maxDatasetPageBytes:DOWNLOAD_BYTES},allPlannedRequestsProcessed:job.status==='completed',complete:false,exactCount:null,exactCargoArrivalCount:null,cargoClassificationAvailable:false,
      message:'Archived detected airport events. A completed job has processed its request plan; source completeness, all traffic and cargo counts remain unverified.'};
  }
  async start(query,options={}){
    if(!query||typeof query!=='object'||Array.isArray(query)||Object.keys(query).some(key=>!['selection','fromDate','toDate','eventType'].includes(key)))throw input();
    if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(key=>key!=='resumeFailed')||(options.resumeFailed!==undefined&&typeof options.resumeFailed!=='boolean'))throw input();
    await this.initialize();
    const task=this.#startTail.then(async()=>{
      if(this.#closed)throw fail('HISTORY_JOBS_CLOSED','The history job worker is closed');
      const plan=this.#regional.describeRegionalAirportEvents(query),jobId=this.#id(plan.query),existing=this.#jobs.get(jobId);
      if(existing){
        if(options.resumeFailed&&['partial_failed','interruption_required'].includes(existing.status)){
          if(existing.plannedRequestCount>this.#maxPlanned)throw fail('HISTORY_JOBS_PLAN_LIMIT','The job exceeds the configured planned-request limit');
          const retryAt=Date.parse(existing.retryAt)>this.#clock()?existing.retryAt:null;
          const resumed={...existing,status:retryAt?'waiting':'queued',retryAt,attemptsAtCheckpoint:0,updatedAt:iso(this.#clock())};
          await this.#save(resumed);this.#jobs.set(jobId,resumed);this.#arm();return this.#summary(resumed);
        }
        return this.#summary(existing);
      }
      if(plan.plannedRequestCount>this.#maxPlanned)throw fail('HISTORY_JOBS_PLAN_LIMIT','The job exceeds the configured planned-request limit');
      if(this.#jobs.size>=this.#maxJobs)throw fail('HISTORY_JOBS_LIMIT','The durable job limit has been reached');
      const now=iso(this.#clock()),job={kind:'regional-history-job',version:1,jobId,query:plan.query,selection:plan.selection,catalog:plan.catalog,status:plan.plannedRequestCount?'queued':'completed',createdAt:now,updatedAt:now,plannedRequestCount:plan.plannedRequestCount,completedRequestCount:0,nextOffset:plan.plannedRequestCount?0:null,attemptsAtCheckpoint:0,retryAt:null,lastErrorCode:null,records:[]};
      await this.#save(job);this.#jobs.set(jobId,job);this.#arm();return this.#summary(job);
    });
    this.#startTail=task.catch(()=>{});return task;
  }
  async get(jobId){await this.initialize();if(typeof jobId!=='string'||!ID.test(jobId))throw input();const job=this.#jobs.get(jobId);if(!job)throw fail('HISTORY_JOB_NOT_FOUND','The history job does not exist');return this.#summary(job);}
  async download({jobId,offset=0,limit=1000,...extra}={}){
    if(Object.keys(extra).length||!Number.isSafeInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>1000)throw input();
    await this.get(jobId);const job=this.#jobs.get(jobId),metadata={...this.#summary(job),offset,requestedLimit:limit,format:'application/json'};
    const records=[];let size=Buffer.byteLength(JSON.stringify(metadata))+128;
    for(const row of job.records.slice(offset,offset+limit)){
      const bytes=Buffer.byteLength(JSON.stringify(row))+1;if(size+bytes>DOWNLOAD_BYTES)break;records.push(structuredClone(row));size+=bytes;
    }
    if(!records.length&&offset<job.records.length)throw fail('HISTORY_JOB_PAGE_TOO_LARGE','One archived record exceeds the bounded dataset page size');
    return {metadata,records,nextOffset:offset+records.length<job.records.length?offset+records.length:null};
  }
  #arm(){
    if(this.#closed||this.#worker)return;
    clearTimeout(this.#timer);this.#timer=undefined;
    const pending=[...this.#jobs.values()].filter(job=>ACTIVE.has(job.status));if(!pending.length)return;
    const earliest=Math.min(...pending.map(job=>Math.max(this.#notBefore,Date.parse(job.retryAt)||0)));
    const delay=Math.min(2147483647,Math.max(0,earliest-this.#clock()));
    this.#timer=setTimeout(()=>{this.#timer=undefined;if(this.#closed)return;this.#worker=this.#run().finally(()=>{this.#worker=undefined;this.#arm();});},delay);this.#timer.unref?.();
  }
  async #run(){
    while(!this.#closed){
      const now=this.#clock();if(now<this.#notBefore)return;
      const job=[...this.#jobs.values()].filter(item=>ACTIVE.has(item.status)&&(Date.parse(item.retryAt)||0)<=now).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.jobId.localeCompare(b.jobId))[0];
      if(!job)return;
      const draft=structuredClone(job);draft.status='running';draft.updatedAt=iso(now);
      try{
        await this.#save(draft);this.#jobs.set(draft.jobId,structuredClone(draft));
        let batch;
        try{batch=await this.#regional.getRegionalAirportEvents({...draft.query,requestOffset:draft.nextOffset,maxRequests:1});}
        catch(error){batch={failures:[{code:safeCode(error?.code),retryAt:error?.retryAt,retryAfterSeconds:error?.retryAfterSeconds}],records:[]};}
        const error=batch?.failures?.[0];
        if(error){
          const code=safeCode(error.code);draft.attemptsAtCheckpoint++;draft.lastErrorCode=code;
          const deadline=Date.parse(error.retryAt??batch.retryAt),seconds=Number.isSafeInteger(error.retryAfterSeconds??batch.retryAfterSeconds)?(error.retryAfterSeconds??batch.retryAfterSeconds):null;
          const backoff=Math.min(60000,this.#retryBase*2**(draft.attemptsAtCheckpoint-1));
          const retryTime=Math.max(this.#clock()+backoff,Number.isFinite(deadline)?deadline:0,seconds!==null&&seconds>=0?this.#clock()+seconds*1000:0);
          if(!Number.isFinite(new Date(retryTime).getTime()))throw fail('AIRPORT_EVENTS_BAD_RESPONSE','Provider retry time is outside the supported timestamp range');
          draft.retryAt=iso(retryTime);
          if(code==='HTTP_429')this.#notBefore=Math.max(this.#notBefore,retryTime);
          draft.status=code==='INTERACTION_REQUIRED'?'interruption_required':terminalCode(code)||draft.attemptsAtCheckpoint>=this.#maxRetries?'partial_failed':'waiting';
        }else{
          if(!Array.isArray(batch?.records)||batch.coverage?.completedRequestCount!==1||(batch.nextOffset!==null&&batch.nextOffset!==draft.nextOffset+1))throw fail('AIRPORT_EVENTS_BAD_RESPONSE','Invalid regional checkpoint');
          const unique=new Map(draft.records.map(row=>[JSON.stringify([row.flightId,row.eventTime,row.eventType,row.eventAirportId]),row]));
          for(const row of batch.records)unique.set(JSON.stringify([row.flightId,row.eventTime,row.eventType,row.eventAirportId]),row);
          if(unique.size>this.#maxRecords){draft.status='partial_failed';draft.lastErrorCode='HISTORY_JOBS_RECORD_LIMIT';}
          else{draft.records=[...unique.values()].sort((a,b)=>a.eventTime.localeCompare(b.eventTime));draft.completedRequestCount++;draft.nextOffset=batch.nextOffset;draft.attemptsAtCheckpoint=0;draft.retryAt=null;draft.lastErrorCode=null;draft.status=batch.nextOffset===null?'completed':'queued';}
        }
        draft.updatedAt=iso(this.#clock());await this.#save(draft);this.#jobs.set(draft.jobId,draft);
        this.#notBefore=Math.max(this.#notBefore,this.#clock()+this.#pace);
      }catch(error){
        const prior=this.#jobs.get(job.jobId);this.#jobs.set(job.jobId,{...prior,status:'partial_failed',lastErrorCode:error?.code==='AIRPORT_EVENTS_BAD_RESPONSE'?'AIRPORT_EVENTS_BAD_RESPONSE':'HISTORY_JOBS_STORE_UNAVAILABLE',updatedAt:iso(this.#clock())});return;
      }
      // Yield between batches; the timer implements pacing and long Retry-After.
      if(this.#clock()<this.#notBefore)return;
    }
  }
  async close(){this.#closed=true;clearTimeout(this.#timer);await this.#worker;}
}
