import test from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../session.mjs').catch(() => ({}));
const settings = {urls: {account: {login: 'https://mobile.flightradar24.com/login', userSession: 'https://mobile.flightradar24.com/session'}}, grpc: {feed: {url: 'feed.flightradar24.com', port: 443}}};
const reply = (access = 'access-A', login = 'login-A') => ({success: true, userData: {accessToken: access, tokenLogin: login}});
const response = body => new Response(JSON.stringify(body), {status: 200});
function client(fetch, clock = () => 1000000) {
  assert.equal(typeof mod.SessionClient, 'function', 'SessionClient must be implemented');
  return new mod.SessionClient({settings, fetch, clock});
}

test('login submits the APK form and exposes only Bearer metadata', async () => {
  let request;
  const c = client(async (url, opts) => {request = {url, opts}; return response(reply());});
  await c.login('me@example.invalid', 'private-password', {sdkInt: 35});
  assert.equal(request.opts.method, 'POST');
  assert.equal(request.opts.redirect, 'error');
  const form = new URLSearchParams(request.opts.body);
  assert.equal(form.get('email'), 'me@example.invalid');
  assert.equal(form.get('password'), 'private-password');
  assert.equal(form.get('remember'), 'true');
  assert.equal(form.get('device'), 'android;35;101805070');
  assert.deepEqual(await c.authorization(), {authorization: 'Bearer access-A'});
  assert(!JSON.stringify(c).includes('private-password'));
  assert(!JSON.stringify(c).includes('access-A'));
});

test('refresh uses tokenLogin and adopts both rotated tokens', async () => {
  const requests = [];
  const c = client(async (url, opts) => {requests.push({url, opts}); return response(requests.length === 1 ? reply() : reply('access-B', 'login-B'));});
  await c.login('me', 'pw');
  await c.refresh();
  assert.equal(new URL(requests[1].url).searchParams.get('tokenLogin'), 'login-A');
  assert.equal(requests[1].opts.method, 'GET');
  assert.deepEqual(await c.authorization(), {authorization: 'Bearer access-B'});
  await c.refresh();
  assert.equal(new URL(requests[2].url).searchParams.get('tokenLogin'), 'login-B');
});

test('old sessions refresh once for concurrent calls', async () => {
  let now = 0, calls = 0;
  const c = client(async () => {calls++; return response(calls === 1 ? reply() : reply('new'));}, () => now);
  await c.login('me', 'pw');
  now = 1800001;
  const results = await Promise.all([c.authorization(), c.authorization(), c.authorization()]);
  assert.equal(calls, 2);
  assert(results.every(r => r.authorization === 'Bearer new'));
});

test('failed login or refresh cannot replace working state or leak server text', async () => {
  let ok = true;
  const c = client(async () => response(ok ? reply() : {success:false, message:'private-password access-A login-A', responseCode:108}));
  await c.login('me', 'pw'); ok = false;
  await assert.rejects(c.refresh(), e => e.code === 'SESSION_REJECTED' && !/password|access-A|login-A/.test(e.message));
  assert.deepEqual(await c.authorization(), {authorization:'Bearer access-A'});
});

test('rejects malformed token, expired JWT and unsafe endpoints', async () => {
  const c = client(async () => response(reply('bad\r\nheader')));
  await assert.rejects(c.login('me','pw'), /session response/i);
  const expired = 'e30.'+Buffer.from(JSON.stringify({exp:1})).toString('base64url')+'.signature';
  const c2 = client(async () => response(reply(expired)));
  await assert.rejects(c2.login('me','pw'), /expired/i);
  assert.throws(() => new mod.SessionClient({settings:{urls:{account:{login:'http://evil.invalid',userSession:'https://evil.invalid'}}}}), /HTTPS|Flightradar24/i);
});

test('unauthenticated access fails before a live query', async () => {
  const c = client(async () => {throw new Error('must not call');});
  await assert.rejects(c.authorization(), e => e.code === 'LOGIN_REQUIRED');
});

test('APK settings omit the HTTPS scheme; normalize the source-defined prefix', async () => {
  const raw = structuredClone(settings);
  raw.urls.account.login = 'mobile.flightradar24.com/mobile/login';
  raw.urls.account.userSession = 'mobile.flightradar24.com/mobile/user-session';
  let received;
  const c = new mod.SessionClient({settings:raw, fetch:async url => {received=url; return response(reply());}});
  await c.login('me','pw');
  assert.equal(received, 'https://mobile.flightradar24.com/mobile/login');
});

test('cached sessions retain their original age and refresh after reload', async () => {
  let now=0,calls=0;
  const c=client(async()=>response(reply()),()=>now);
  await c.login('me','pw');
  assert.equal(typeof c.exportSession,'function','Explicit protected-cache export must be implemented');
  const saved=c.exportSession();
  now=1800001;
  const reloaded=client(async()=>{calls++;return response(reply('rotated'));},()=>now);
  reloaded.importSession(saved);
  assert.deepEqual(await reloaded.authorization(),{authorization:'Bearer rotated'});
  assert.equal(calls,1);
});

test('a delayed old refresh cannot overwrite a newer explicit login', async () => {
  let finishRefresh;
  const c=client(async (url,opts)=>{
    if (opts.method==='GET') return new Promise(resolve=>{finishRefresh=()=>resolve(response(reply('stale-refresh')));});
    return response(new URLSearchParams(opts.body).get('email')==='new-user'?reply('new-login'):reply());
  });
  await c.login('old-user','pw');
  const pending=c.refresh();
  await c.login('new-user','pw');
  finishRefresh();await pending;
  assert.deepEqual(await c.authorization(),{authorization:'Bearer new-login'});
});

test('expired imported access tokens remain usable only to renew the session', async () => {
  const expired='e30.'+Buffer.from(JSON.stringify({exp:1})).toString('base64url')+'.signature';
  let calls=0;
  const c=client(async()=>{calls++;return response(reply('renewed'));});
  c.importSession({success:true,userData:{accessToken:expired,tokenLogin:'refresh-fixture'},receivedAt:0});
  assert.equal(c.serverValidated,false);
  assert.deepEqual(await c.authorization(),{authorization:'Bearer renewed'});
  assert.equal(c.serverValidated,true);
  assert.equal(calls,1);
});
