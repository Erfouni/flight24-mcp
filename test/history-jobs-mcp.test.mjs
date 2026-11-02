import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createMcpApp} from '../mcp-server.mjs';
import {ttlForTool} from '../query-cache.mjs';

test('MCP queues a history query, resumes explicitly and downloads only archived records',async t=>{
 const token='fixture-history-job-bearer-0123456789',jobId='a'.repeat(32),captured=[];
 const historyJobs={start:async(q,options)=>(captured.push({q,options}),{jobId,status:'queued',exactCargoArrivalCount:null}),get:async id=>({jobId:id,status:'waiting',retryAt:'2026-11-02T15:00:00Z'}),download:async q=>({metadata:{jobId:q.jobId,status:'completed',complete:false,exactCargoArrivalCount:null},records:[{flightId:'fixture',eventTime:'2026-10-01T01:00:00Z'}],nextOffset:null})};
 const server=createMcpApp({token,airlines:{},historyJobs}).listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(r=>server.close(r)));
 const c=new Client({name:'job-mcp-fixture',version:'1'});t.after(()=>c.close());await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`),{requestInit:{headers:{Authorization:'Bearer '+token}}}));
 const tools=(await c.listTools()).tools;for(const name of ['start_region_history_job','get_region_history_job','download_region_history_job'])assert.ok(tools.some(t=>t.name===name),name);
 const start=await c.callTool({name:'start_region_history_job',arguments:{selection:{country:'AE'},fromDate:'2026-10-01',toDate:'2026-10-10',resumeFailed:true}});assert.equal(start.structuredContent.jobId,jobId);assert.equal(captured[0].options.resumeFailed,true);assert.equal(captured[0].q.resumeFailed,undefined);
 const status=await c.callTool({name:'get_region_history_job',arguments:{jobId}});assert.equal(status.structuredContent.status,'waiting');assert.equal(ttlForTool('get_region_history_job'),0);
 const file=await c.callTool({name:'download_region_history_job',arguments:{jobId}});assert.equal(file.structuredContent.downloadedRecordCount,1);assert.equal(file.structuredContent.exactCargoArrivalCount,null);assert.equal(JSON.parse(file.content[1].resource.text).records[0].flightId,'fixture');
 const invalid=await c.callTool({name:'get_region_history_job',arguments:{jobId:'../private'}});assert.equal(invalid.isError,true);
});

test('MCP exposes safe provider retry deadlines without error text or credentials',async t=>{
 const token='fixture-history-job-bearer-0123456789';const historyJobs={start:async()=>{throw Object.assign(Error('private credential must not escape'),{code:'HTTP_429',retryAt:'2026-11-02T15:00:00Z',retryAfterSeconds:60});}};
 const server=createMcpApp({token,airlines:{},historyJobs}).listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(r=>server.close(r)));
 const c=new Client({name:'retry-mcp-fixture',version:'1'});t.after(()=>c.close());await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`),{requestInit:{headers:{Authorization:'Bearer '+token}}}));
 const result=await c.callTool({name:'start_region_history_job',arguments:{selection:{country:'AE'},fromDate:'2026-10-01',toDate:'2026-10-10'}});const body=JSON.parse(result.content[0].text);assert.equal(body.retryAfterSeconds,60);assert.equal(body.retryAt,'2026-11-02T15:00:00Z');assert.equal(JSON.stringify(result).includes('private credential'),false);
});
