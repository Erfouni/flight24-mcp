import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const issuer='https://traffic.example.test';
const resource=issuer+'/mcp';
const owner='synthetic-owner-password-for-tests-0123456789';
const redirect='https://chatgpt.example.test/oauth/callback';
const hash=v=>createHash('sha256').update(v).digest('base64url');
async function setup(t,extra={}){
  const {createOwnerOAuth}=await import('../oauth.mjs');
  const auth=createOwnerOAuth({issuerUrl:issuer,resourceUrl:resource,ownerSecret:owner,...extra});
  const app=express();auth.install(app);
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const request=(p,opts={})=>fetch(base+p,{redirect:'manual',...opts});
  const register=async(method='none',uri=redirect)=>{
    const r=await request('/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({redirect_uris:[uri],token_endpoint_auth_method:method,grant_types:['authorization_code','refresh_token'],response_types:['code'],client_name:'Test client'})});
    return {status:r.status,...await r.json()};
  };
  const authorize=async(client,extraParams={})=>{
    const verifier=randomBytes(32).toString('base64url');
    const params=new URLSearchParams({client_id:client.client_id,redirect_uri:redirect,response_type:'code',code_challenge:hash(verifier),code_challenge_method:'S256',scope:'mcp:read',state:'opaque-client-state',resource,...extraParams});
    const response=await request('/authorize?'+params);
    const html=await response.text();
    return {response,html,verifier,cookie:response.headers.get('set-cookie')?.split(';')[0],flow:/name="flow" value="([^"]+)"/.exec(html)?.[1],csrf:/name="csrf" value="([^"]+)"/.exec(html)?.[1]};
  };
  const consent=async(flow,secret=owner,headers={})=>request('/oauth/consent',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',cookie:flow.cookie??'',origin:issuer,...headers},body:new URLSearchParams({flow:flow.flow??'',csrf:flow.csrf??'',owner_secret:secret})});
  const exchange=async(client,params)=>request('/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:client.client_id,...(client.client_secret?{client_secret:client.client_secret}:{}),...params})});
  const grant=async(client)=>{const flow=await authorize(client);assert.equal(flow.response.status,200);const login=await consent(flow);assert.equal(login.status,302);const location=new URL(login.headers.get('location'));assert.equal(location.searchParams.get('iss'),issuer+'/');const code=location.searchParams.get('code');return {flow,code};};
  return {auth,request,register,authorize,consent,exchange,grant};
}

test('OAuth metadata advertises S256, DCR and exact protected resource',async t=>{
  const s=await setup(t);
  const metadata=await (await s.request('/.well-known/oauth-authorization-server')).json();
  assert.deepEqual(metadata.code_challenge_methods_supported,['S256']);
  assert.equal(metadata.authorization_endpoint,issuer+'/authorize');
  assert.equal(metadata.registration_endpoint,issuer+'/register');
  assert.equal(metadata.authorization_response_iss_parameter_supported,true);
  const protectedResource=await (await s.request('/.well-known/oauth-protected-resource/mcp')).json();
  assert.equal(protectedResource.resource,resource);
  assert.deepEqual(protectedResource.authorization_servers,[issuer+'/']);
});

test('owner passwords accept twenty characters and reject nineteen',async t=>{
  const {createOwnerOAuth}=await import('../oauth.mjs');
  assert.throws(()=>createOwnerOAuth({issuerUrl:issuer,resourceUrl:resource,ownerSecret:'T'.repeat(19)}),/at least 20/);
  const selected='T'.repeat(19)+'#';
  const s=await setup(t,{ownerSecret:selected}),client=await s.register(),flow=await s.authorize(client);
  assert.equal((await s.consent(flow,selected)).status,302);
});



test('authorization requires S256 and never grants access merely by visiting authorize',async t=>{
  const s=await setup(t),client=await s.register();
  const noPkce=await s.authorize(client,{code_challenge_method:'plain'});
  assert.equal(noPkce.response.status,302);
  assert.equal(new URL(noPkce.response.headers.get('location')).searchParams.get('error'),'invalid_request');
  const flow=await s.authorize(client);
  assert.equal(flow.response.status,200);
  assert.match(flow.html,/chatgpt\.example\.test/);
  assert.equal(flow.response.headers.get('cache-control'),'no-store');
  assert.equal(flow.response.headers.get('referrer-policy'),'same-origin');
  assert.match(flow.response.headers.get('set-cookie'),/HttpOnly/);
  assert.match(flow.response.headers.get('set-cookie'),/Secure/);
  assert.equal(flow.html.includes(owner),false);
  assert.equal(flow.response.headers.get('location'),null);
});

test('wrong owner password and missing CSRF cookie cannot produce authorization codes',async t=>{
  const s=await setup(t),client=await s.register(),flow=await s.authorize(client);
  const wrong=await s.consent(flow,'incorrect-owner-password');assert.equal(wrong.status,403);assert.equal(wrong.headers.get('location'),null);
  const csrf=await s.consent({...flow,cookie:''});assert.equal(csrf.status,403);
  const origin=await s.consent(flow,owner,{origin:'https://attacker.example'});assert.equal(origin.status,403);
  const opaqueOrigin=await s.consent(flow,owner,{origin:'null'});assert.equal(opaqueOrigin.status,403);
});

test('codes are client redirect resource and PKCE bound, single use, and access tokens have audience and scope',async t=>{
  const s=await setup(t),client=await s.register(),other=await s.register(),{flow,code}=await s.grant(client);
  const payload={grant_type:'authorization_code',code,code_verifier:flow.verifier,redirect_uri:redirect,resource};
  assert.equal((await s.exchange(other,payload)).status,400);
  assert.equal((await s.exchange(client,{...payload,resource:'https://other.example/mcp'})).status,400);
  assert.equal((await s.exchange(client,{...payload,redirect_uri:'https://chatgpt.example.test/other'})).status,400);
  assert.equal((await s.exchange(client,{...payload,code_verifier:'x'.repeat(43)})).status,400);
  const response=await s.exchange(client,payload);assert.equal(response.status,200);
  const tokens=await response.json();assert.equal(tokens.expires_in,3600);
  const info=await s.auth.verifyAccessToken(tokens.access_token);
  assert.equal(info.resource.href,resource);assert.deepEqual(info.scopes,['mcp:read']);assert.equal(info.clientId,client.client_id);
  assert.equal((await s.exchange(client,payload)).status,400);
});

test('refresh rotates and a replay is rejected, without scope or resource escalation',async t=>{
  const s=await setup(t),client=await s.register(),{flow,code}=await s.grant(client);
  const first=await (await s.exchange(client,{grant_type:'authorization_code',code,code_verifier:flow.verifier,redirect_uri:redirect})).json();
  assert.equal((await s.exchange(client,{grant_type:'refresh_token',refresh_token:first.refresh_token,resource:'https://other.example/mcp'})).status,400);
  assert.equal((await s.exchange(client,{grant_type:'refresh_token',refresh_token:first.refresh_token,scope:'admin'})).status,400);
  const nextResponse=await s.exchange(client,{grant_type:'refresh_token',refresh_token:first.refresh_token});assert.equal(nextResponse.status,200);
  const next=await nextResponse.json();assert.notEqual(next.refresh_token,first.refresh_token);
  assert.equal((await s.exchange(client,{grant_type:'refresh_token',refresh_token:first.refresh_token})).status,400);
  await assert.rejects(s.auth.verifyAccessToken(next.access_token));
});

test('authorization codes and access/refresh tokens enforce their actual expiry windows',async t=>{
  let clock=Date.now();const s=await setup(t,{now:()=>clock}),client=await s.register();
  const expired=await s.grant(client);clock+=5*60*1000+1;
  assert.equal((await s.exchange(client,{grant_type:'authorization_code',code:expired.code,code_verifier:expired.flow.verifier,redirect_uri:redirect})).status,400);
  const fresh=await s.grant(client);
  const tokens=await (await s.exchange(client,{grant_type:'authorization_code',code:fresh.code,code_verifier:fresh.flow.verifier,redirect_uri:redirect})).json();
  clock+=60*60*1000+1;await assert.rejects(s.auth.verifyAccessToken(tokens.access_token));
  clock+=30*86400000;
  assert.equal((await s.exchange(client,{grant_type:'refresh_token',refresh_token:tokens.refresh_token})).status,400);
});

test('revoking a refresh grant invalidates its access tokens and owner login attempts are limited',async t=>{
  const s=await setup(t),client=await s.register(),{flow,code}=await s.grant(client);
  const tokens=await (await s.exchange(client,{grant_type:'authorization_code',code,code_verifier:flow.verifier,redirect_uri:redirect})).json();
  const revoke=await s.request('/revoke',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:client.client_id,token:tokens.refresh_token,token_type_hint:'refresh_token'})});
  assert.equal(revoke.status,200);await assert.rejects(s.auth.verifyAccessToken(tokens.access_token));
  const login=await s.authorize(client);
  for(let i=0;i<4;i++)assert.equal((await s.consent(login,'bad-password')).status,403);
  assert.equal((await s.consent(login,'bad-password')).status,429);
});

test('DCR rejects unsafe redirects and confidential clients cannot omit their secret',async t=>{
  const s=await setup(t);
  assert.equal((await s.register('none','http://attacker.example/callback')).status,400);
  const client=await s.register('client_secret_post'),{flow,code}=await s.grant(client);
  assert.equal(client.status,201);assert.ok(client.client_secret);
  const payload={grant_type:'authorization_code',code,code_verifier:flow.verifier,redirect_uri:redirect};
  assert.equal((await s.exchange({...client,client_secret:null},payload)).status,401);
  assert.equal((await s.exchange(client,payload)).status,200);
});

test('durable store contains only token and client-secret hashes and reload preserves refresh capability',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'owner-oauth-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const storePath=path.join(directory,'oauth.json');
  const s=await setup(t,{storePath}),client=await s.register('client_secret_post'),{flow,code}=await s.grant(client);
  const tokens=await (await s.exchange(client,{grant_type:'authorization_code',code,code_verifier:flow.verifier,redirect_uri:redirect})).json();
  const text=await readFile(storePath,'utf8');
  for(const secret of [owner,client.client_secret,tokens.access_token,tokens.refresh_token,code])assert.equal(text.includes(secret),false);
  const restarted=await setup(t,{storePath});
  assert.equal((await restarted.exchange(client,{grant_type:'refresh_token',refresh_token:tokens.refresh_token})).status,200);
});
