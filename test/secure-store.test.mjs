import test from 'node:test';
import assert from 'node:assert/strict';
import {SessionClient, ClientError} from '../session.mjs';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {unlink} from 'node:fs/promises';
const mod=await import('../secure-store.mjs').catch(()=>({}));
test('Windows cache uses DPAPI and decrypts only through the current-user API',{skip:process.platform!=='win32'},async()=>{
  assert.equal(typeof mod.protect,'function','DPAPI cache must be implemented');
  const original='fixture-secret-not-a-real-token';
  const blob=await mod.protect(original);
  assert(!blob.includes(original));
  assert.equal(await mod.unprotect(blob),original);
});

test('token rotation is cached even when the following RPC fails',{skip:process.platform!=='win32'},async t=>{
  assert.equal(typeof mod.withSavedSession,'function','Failure-safe session caching must be implemented');
  const settings={urls:{account:{login:'https://mobile.flightradar24.com/login',userSession:'https://mobile.flightradar24.com/session'}}};
  const s=new SessionClient({settings,fetch:async()=>new Response(JSON.stringify({success:true,userData:{accessToken:'new-access',tokenLogin:'rotated-login'}}))});
  s.importSession({success:true,userData:{accessToken:'old-access',tokenLogin:'old-login'}});
  const path=resolve('private','test-'+randomUUID()+'.dpapi');
  t.after(()=>unlink(path).catch(()=>{}));
  await assert.rejects(mod.withSavedSession(path,s,async()=>{await s.refresh();throw new ClientError('GRPC_14','Fixture unavailable');}),e=>e.code==='GRPC_14');
  const restored=new SessionClient({settings});
  await mod.loadSession(path,restored);
  assert.equal(restored.exportSession().userData.tokenLogin,'rotated-login');
});
