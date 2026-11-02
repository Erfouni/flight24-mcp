import test from 'node:test';
import assert from 'node:assert/strict';
const mod=await import('../capture-session.mjs').catch(()=>({}));
test('extracts only session tokens from the app preference XML',()=>{
  assert.equal(typeof mod.parseAppPreferences,'function','App session parser must be implemented');
  const xml='<map><long name="user_key_token_timestamp" value="1700000000" /><string name="user_cache">{&quot;success&quot;:true,&quot;userData&quot;:{&quot;accessToken&quot;:&quot;fixture-access&quot;,&quot;tokenLogin&quot;:&quot;fixture-refresh&quot;,&quot;identity&quot;:&quot;private-email&quot;}}</string></map>';
  const value=mod.parseAppPreferences(xml);
  assert.deepEqual(value,{success:true,userData:{accessToken:'fixture-access',tokenLogin:'fixture-refresh'},receivedAt:1700000000000});
  assert(!JSON.stringify(value).includes('private-email'));
  assert.throws(()=>mod.parseAppPreferences('<map/>'),/session/i);
});
