import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir,readFile,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,toNamespacedPath} from 'node:path';
import {execFileSync} from 'node:child_process';
import {RegionalAirportEventsService} from '../regional-airport-events.mjs';
const {RegionalHistoryJobs}=await import('../history-jobs.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
const query={selection:{airports:['ONE']},fromDate:'2026-10-01',toDate:'2026-10-02',eventType:'landed'};
const airport={id:1,iata:'ONE',timezone:'UTC',timezoneValid:true};
const region=read=>new RegionalAirportEventsService({airportEvents:{getAirportEvents:read},resolveAirports:()=>({airports:[airport],selection:{mode:'airports'},catalog:{airportUpdatedAt:'2026-01-01'}})});
const reply=date=>({records:[{flightId:date,eventAirportId:1,eventType:'landed',eventTime:date+'T12:00:00Z',registration:'A6-FIX'}]});
async function until(read,predicate){const end=Date.now()+2000;while(Date.now()<end){const value=await read();if(predicate(value))return value;await new Promise(r=>setTimeout(r,5));}throw Error('job did not reach fixture state');}
async function temporary(fn){const storeDir=await mkdtemp(join(tmpdir(),'fr24-history-jobs-'));let jobs;try{await fn(storeDir,value=>jobs=value);}finally{await jobs?.close();await rm(storeDir,{recursive:true,force:true});}}

test('jobs return a fast summary, deduplicate equivalent pinned airport queries and archive completed observations',async()=>temporary(async(storeDir,own)=>{
  assert.equal(typeof RegionalHistoryJobs,'function');let calls=0;
  const jobs=new RegionalHistoryJobs({regionalAirportEvents:region(async({date})=>{calls++;return reply(date);}),storeDir,paceMs:0});own(jobs);
  await jobs.initialize();const started=await jobs.start(query);assert.equal(calls,0);assert.equal(started.status,'queued');assert.equal(started.records,undefined);
  const duplicate=await jobs.start({...query,selection:{airports:['KONE']}});assert.equal(duplicate.jobId,started.jobId);
  const done=await until(()=>jobs.get(started.jobId),j=>j.status==='completed');assert.equal(calls,2);assert.equal(done.progress.completedRequestCount,2);assert.equal(done.recordCount,2);
  assert.equal(done.complete,false);assert.equal(done.exactCargoArrivalCount,null);
  const page=await jobs.download({jobId:done.jobId,limit:1});assert.equal(page.records.length,1);assert.equal(page.nextOffset,1);assert.equal(page.metadata.exactCargoArrivalCount,null);
  const tail=await jobs.download({jobId:done.jobId,offset:1,limit:1000});assert.equal(tail.records.length,1);assert.equal(tail.nextOffset,null);
  assert.equal((await jobs.start(query)).jobId,done.jobId);assert.equal(calls,2);
  const files=await readdir(storeDir);assert.deepEqual(files,[done.jobId+'.json']);const stored=JSON.parse(await readFile(join(storeDir,files[0]),'utf8'));assert.equal(stored.nextOffset,null);assert.equal(stored.records.length,2);
}));

test('429 persists the failed checkpoint and long retry deadline then resumes after restart without skipping a day',async()=>temporary(async(storeDir,own)=>{
  let clock=Date.UTC(2026,10,2),calls=0;const retryAt=new Date(clock+86400000).toISOString();
  const first=new RegionalHistoryJobs({regionalAirportEvents:region(async({date})=>{calls++;if(date.endsWith('02'))throw Object.assign(Error('private'),{code:'HTTP_429',retryAt,retryAfterSeconds:86400});return reply(date);}),storeDir,clock:()=>clock,paceMs:0});own(first);
  const start=await first.start(query);const waiting=await until(()=>first.get(start.jobId),j=>j.status==='waiting');
  assert.equal(waiting.nextOffset,1);assert.equal(waiting.retryAt,retryAt);assert.equal(waiting.recordCount,1);assert.equal(calls,2);await first.close();
  const restarted=new RegionalHistoryJobs({regionalAirportEvents:region(async({date})=>{calls++;return reply(date);}),storeDir,clock:()=>clock,paceMs:0});own(restarted);await restarted.initialize();
  assert.equal((await restarted.get(start.jobId)).status,'waiting');await new Promise(r=>setTimeout(r,15));assert.equal(calls,2);await restarted.close();
  clock+=86400001;
  const resumed=new RegionalHistoryJobs({regionalAirportEvents:region(async({date})=>{calls++;assert.equal(date,'2026-10-02');return reply(date);}),storeDir,clock:()=>clock,paceMs:0});own(resumed);await resumed.initialize();
  const done=await until(()=>resumed.get(start.jobId),j=>j.status==='completed');assert.equal(calls,3);assert.equal(done.recordCount,2);assert.equal(done.progress.completedRequestCount,2);
}));

test('interaction and source failures keep unknown work checkpointed and bounded retries stop',async()=>temporary(async(storeDir,own)=>{
  let calls=0;const jobs=new RegionalHistoryJobs({regionalAirportEvents:region(async()=>{calls++;throw Object.assign(Error('private-auth-value'),{code:'INTERACTION_REQUIRED'});}),storeDir,paceMs:0});own(jobs);
  const started=await jobs.start(query);const stopped=await until(()=>jobs.get(started.jobId),j=>j.status==='interruption_required');
  assert.equal(calls,1);assert.equal(stopped.nextOffset,0);assert.equal(stopped.recordCount,0);assert.equal(stopped.lastErrorCode,'INTERACTION_REQUIRED');assert.ok(!JSON.stringify(stopped).includes('private-auth'));
}));

test('transient failures stop after three attempts at the same durable checkpoint',async()=>temporary(async(storeDir,own)=>{
  let calls=0;const jobs=new RegionalHistoryJobs({regionalAirportEvents:region(async()=>{calls++;throw Object.assign(Error('private'),{code:'HTTP_503'});}),storeDir,paceMs:0,retryBaseMs:1});own(jobs);
  const started=await jobs.start(query);const stopped=await until(()=>jobs.get(started.jobId),j=>j.status==='partial_failed');
  assert.equal(calls,3);assert.equal(stopped.nextOffset,0);assert.equal(stopped.progress.attemptsAtCheckpoint,3);assert.equal(stopped.lastErrorCode,'HTTP_503');
}));

test('record bound preserves already archived records and the first unarchived request',async()=>temporary(async(storeDir,own)=>{
  const jobs=new RegionalHistoryJobs({regionalAirportEvents:region(async({date})=>reply(date)),storeDir,paceMs:0,maxRecords:1});own(jobs);
  const started=await jobs.start(query);const stopped=await until(()=>jobs.get(started.jobId),j=>j.status==='partial_failed');
  assert.equal(stopped.recordCount,1);assert.equal(stopped.nextOffset,1);assert.equal(stopped.lastErrorCode,'HISTORY_JOBS_RECORD_LIMIT');
  assert.equal((await jobs.download({jobId:started.jobId})).records.length,1);
}));

test('failed jobs resume only on explicit request after sign-in without losing their checkpoint',async()=>temporary(async(storeDir,own)=>{
  let blocked=true,calls=0;const jobs=new RegionalHistoryJobs({regionalAirportEvents:region(async({date})=>{calls++;if(blocked)throw Object.assign(Error('private'),{code:'INTERACTION_REQUIRED'});return reply(date);}),storeDir,paceMs:0,retryBaseMs:1});own(jobs);
  const started=await jobs.start(query);await until(()=>jobs.get(started.jobId),j=>j.status==='interruption_required');
  blocked=false;assert.equal((await jobs.start(query)).status,'interruption_required');assert.equal(calls,1);
  const resumed=await jobs.start(query,{resumeFailed:true});assert.equal(resumed.jobId,started.jobId);assert.equal(resumed.progress.attemptsAtCheckpoint,0);
  const done=await until(()=>jobs.get(started.jobId),j=>j.status==='completed');assert.equal(done.recordCount,2);assert.equal(calls,3);
}));

test('explicit resumption never shortens a future provider Retry-After and broad plans are rejected before reads',async()=>temporary(async(storeDir,own)=>{
  const now=Date.UTC(2026,10,2),retryAt=new Date(now+86400000).toISOString();let calls=0;
  const jobs=new RegionalHistoryJobs({regionalAirportEvents:region(async()=>{calls++;throw Object.assign(Error('private'),{code:'HTTP_429',retryAt,retryAfterSeconds:86400});}),storeDir,clock:()=>now,paceMs:0,maxRetries:1,maxPlannedRequests:2});own(jobs);
  await assert.rejects(jobs.start({...query,toDate:'2026-10-03'}),e=>e.code==='HISTORY_JOBS_PLAN_LIMIT');assert.equal(calls,0);
  const started=await jobs.start(query);await until(()=>jobs.get(started.jobId),j=>j.status==='partial_failed');
  const resumed=await jobs.start(query,{resumeFailed:true});assert.equal(resumed.status,'waiting');assert.equal(resumed.retryAt,retryAt);assert.equal(resumed.limits.maxPlannedRequests,2);
  await new Promise(r=>setTimeout(r,10));assert.equal(calls,1);
}));

test('job bounds, strict IDs and paginated download inputs fail without provider traffic',async()=>temporary(async(storeDir,own)=>{
  let calls=0;const jobs=new RegionalHistoryJobs({regionalAirportEvents:region(async({date})=>{calls++;return reply(date);}),storeDir,paceMs:0,maxJobs:1});own(jobs);
  await assert.rejects(jobs.start({...query,toDate:'2026-11-01'}));assert.equal(calls,0);
  const started=await jobs.start(query);await until(()=>jobs.get(started.jobId),j=>j.status==='completed');
  await assert.rejects(jobs.start({...query,toDate:'2026-10-03'}),e=>e.code==='HISTORY_JOBS_LIMIT');
  await assert.rejects(jobs.get('../secret'),e=>e.code==='HISTORY_JOB_INPUT_INVALID');
  for(const bad of [{offset:-1},{limit:1001},{limit:0}])await assert.rejects(jobs.download({jobId:started.jobId,...bad}),e=>e.code==='HISTORY_JOB_INPUT_INVALID');
}));

test('archive analysis uses one existing snapshot and returns compact counts without new provider reads',async()=>temporary(async(storeDir,own)=>{
  let calls=0;const jobs=new RegionalHistoryJobs({regionalAirportEvents:region(async({date})=>{calls++;const result=reply(date);result.records[0].aircraftType='B744';return result;}),storeDir,paceMs:0});own(jobs);
  const started=await jobs.start(query);const queued=await jobs.analyze({jobId:started.jobId});
  assert.equal(queued.inputRecordCount,0);assert.equal(calls,0);
  const done=await until(()=>jobs.get(started.jobId),j=>j.status==='completed');
  const result=await jobs.analyze({jobId:started.jobId,aircraftTypes:['B744'],groupBy:'aircraftType',maxGroups:1});
  assert.equal(calls,2);assert.equal(result.observedMatchingEvents,2);assert.equal(result.snapshot.updatedAt,done.updatedAt);
  assert.equal(result.snapshot.progress.completedRequestCount,2);assert.equal(result.groups[0].key,'B744');
  assert.equal(result.records,undefined);assert.equal(result.complete,false);assert.equal(result.exactCargoArrivalCount,null);
  await assert.rejects(jobs.analyze({jobId:'../invalid'}),e=>e.code==='HISTORY_JOB_INPUT_INVALID');
  await assert.rejects(jobs.analyze({jobId:started.jobId,records:[]}),e=>e.code==='HISTORY_JOB_INPUT_INVALID');
}));

test('queue errors remain retryable while cache failures require explicit repair and resumption',async()=>temporary(async(storeDir,own)=>{
  let code='AIRPORT_EVENTS_QUEUE_FULL',calls=0;
  const jobs=new RegionalHistoryJobs({regionalAirportEvents:region(async()=>{calls++;throw Object.assign(Error('private'),{code,retryAfterSeconds:60});}),storeDir,paceMs:0});own(jobs);
  const started=await jobs.start(query);const waiting=await until(()=>jobs.get(started.jobId),j=>j.status==='waiting');
  assert.equal(waiting.lastErrorCode,code);assert.equal(calls,1);await jobs.close();
  const other=new RegionalHistoryJobs({regionalAirportEvents:region(async()=>{calls++;throw Object.assign(Error('private'),{code:'AIRPORT_EVENTS_CACHE_UNSAFE'});}),storeDir:join(storeDir,'cache-failure'),paceMs:0});own(other);
  const broken=await other.start(query);const failed=await until(()=>other.get(broken.jobId),j=>j.status==='partial_failed');
  assert.equal(failed.lastErrorCode,'AIRPORT_EVENTS_CACHE_UNSAFE');assert.equal(failed.progress.attemptsAtCheckpoint,1);assert.equal(failed.nextOffset,0);assert.equal(calls,2);
}));

test('symlinked storage is rejected before any job or provider request',async()=>temporary(async(storeDir,own)=>{
  const link=storeDir+'-link';try{await symlink(storeDir,link,process.platform==='win32'?'junction':'dir');const jobs=new RegionalHistoryJobs({regionalAirportEvents:region(async()=>{throw Error('not called');}),storeDir:link});own(jobs);await assert.rejects(jobs.initialize(),e=>e.code==='HISTORY_JOBS_STORE_UNAVAILABLE');}finally{await rm(link,{force:true});}
}));

test('legitimate Windows namespace aliases initialize and write to the canonical private directory',{skip:process.platform!=='win32'},async()=>temporary(async(storeDir,own)=>{
  const jobs=new RegionalHistoryJobs({regionalAirportEvents:region(async({date})=>reply(date)),storeDir:toNamespacedPath(storeDir),paceMs:0});own(jobs);
  const started=await jobs.start(query);await until(()=>jobs.get(started.jobId),j=>j.status==='completed');
  assert.ok((await readdir(storeDir)).includes(started.jobId+'.json'));
}));

test('legitimate Windows 8.3 directory aliases work when short names are available',{skip:process.platform!=='win32'},async t=>temporary(async(storeDir,own)=>{
  let alias;
  try{alias=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$fso = New-Object -ComObject Scripting.FileSystemObject; $fso.GetFolder($env:HISTORY_JOB_ALIAS_TARGET).ShortPath"],{encoding:'utf8',env:{...process.env,HISTORY_JOB_ALIAS_TARGET:storeDir},windowsHide:true}).trim();}
  catch{t.skip('Windows short-path lookup is unavailable');return;}
  if(!alias||alias.toLowerCase()===storeDir.toLowerCase()){t.skip('This volume does not expose an 8.3 alias for the fixture');return;}
  const jobs=new RegionalHistoryJobs({regionalAirportEvents:region(async({date})=>reply(date)),storeDir:alias,paceMs:0});own(jobs);
  const started=await jobs.start(query);await until(()=>jobs.get(started.jobId),j=>j.status==='completed');
  assert.ok((await readdir(storeDir)).includes(started.jobId+'.json'));
}));

test('a linked ancestor cannot hide behind a regular final storage directory',async()=>temporary(async(storeDir,own)=>{
  const link=storeDir+'-ancestor';try{
    await symlink(storeDir,link,process.platform==='win32'?'junction':'dir');
    const jobs=new RegionalHistoryJobs({regionalAirportEvents:region(async()=>{throw Error('not called');}),storeDir:join(link,'child')});own(jobs);
    await assert.rejects(jobs.initialize(),e=>e.code==='HISTORY_JOBS_STORE_UNAVAILABLE');
    assert.ok(!(await readdir(storeDir)).includes('child'));
  }finally{await rm(link,{force:true});}
}));
