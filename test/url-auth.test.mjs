import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createMcpApp} from '../mcp-server.mjs';

const token='fixture-url-token-0123456789-abcdef';
async function fixture(t,allowUrlToken){
  const oauth={resourceMetadataUrl:'https://example.invalid/.well-known/oauth-protected-resource/mcp',install(){},verifyAccessToken:async()=>{throw Error('fixture');}};
  const server=createMcpApp({token,allowUrlToken,oauth,airlines:{},capabilities:{fixture:true}}).listen(0,'127.0.0.1');
  await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/mcp`;
}
test('URL credentials are disabled by default and never echoed',async t=>{
  const base=await fixture(t,undefined),r=await fetch(base+'?access_token='+token);
  assert.equal(r.status,401);assert.equal((await r.text()).includes(token),false);
});
test('explicit URL authentication supports real SDK discovery without an OAuth prompt',async t=>{
  const base=await fixture(t,true),url=base+'?access_token='+token;
  const probe=await fetch(url);assert.equal(probe.status,405);assert.equal(probe.headers.get('cache-control'),'no-store');assert.equal(probe.headers.get('referrer-policy'),'no-referrer');
  const client=new Client({name:'url-fixture',version:'1'});t.after(()=>client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  const catalog=await client.listTools();assert.deepEqual(catalog.tools.find(x=>x.name==='get_capabilities')._meta.securitySchemes,[{type:'noauth'}]);
  const result=await client.callTool({name:'get_capabilities',arguments:{}});assert.equal(result.structuredContent.fixture,true);
});
test('wrong duplicate conflicting and cross-origin URL credentials are rejected',async t=>{
  const base=await fixture(t,true);
  assert.equal((await fetch(base+'?access_token=incorrect')).status,401);
  assert.equal((await fetch(base+'?access_token='+token+'&access_token='+token)).status,401);
  assert.equal((await fetch(base+'?access_token='+token,{headers:{Authorization:'Bearer '+token}})).status,400);
  assert.equal((await fetch(base+'?access_token='+token,{headers:{Origin:'https://attacker.invalid'}})).status,403);
  assert.equal((await fetch(base,{headers:{Authorization:'Bearer '+token}})).status,405);
});
