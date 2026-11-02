import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createMcpApp} from '../mcp-server.mjs';

test('the full tool catalog uses homogeneous array schemas accepted by ChatGPT',async t=>{
 const token='fixture-schema-token-0123456789-abcdef';
 const satellite={searchScenes:async q=>({bbox:q.bbox})};
 const server=createMcpApp({token,allowUrlToken:true,airlines:{},vessels:{},satellite,vesselExtras:{},tankers:{},vesselArea:{},aircraftArea:{},aircraftHistory:{},measurements:()=>({}),airportHistory:{},airportEvents:{},regionalAirportEvents:{},providerDownloads:{},historyJobs:{},capabilities:{},popularity:{},geography:{},regionalHistory:{}}).listen(0,'127.0.0.1');
 await once(server,'listening');t.after(()=>new Promise(r=>server.close(r)));
 const client=new Client({name:'schema-fixture',version:'1'});t.after(()=>client.close());
 await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp?access_token=${token}`)));
 const tools=(await client.listTools()).tools;assert.equal(tools.length,31);
 function check(schema,path){if(!schema||typeof schema!=='object')return;if(schema.type==='array'){assert.ok(schema.items&&typeof schema.items==='object'&&!Array.isArray(schema.items),path+' must use a single items schema');assert.equal(schema.prefixItems,undefined,path+' must not use prefixItems');}for(const [key,value]of Object.entries(schema))if(value&&typeof value==='object'){if(Array.isArray(value))value.forEach((x,i)=>check(x,`${path}.${key}[${i}]`));else check(value,path+'.'+key);}}
 for(const tool of tools){check(tool.inputSchema,tool.name);assert.deepEqual(tool._meta.securitySchemes,[{type:'noauth'}],tool.name);}
 const invalid=await client.callTool({name:'search_satellite_scenes',arguments:{bbox:[50,25,51],from:'2026-11-01T00:00:00Z',to:'2026-11-02T00:00:00Z'}});assert.equal(invalid.isError,true);
 const valid=await client.callTool({name:'search_satellite_scenes',arguments:{bbox:[50,25,51,26],from:'2026-11-01T00:00:00Z',to:'2026-11-02T00:00:00Z'}});assert.deepEqual(valid.structuredContent.bbox,[50,25,51,26]);
});
