import express from 'express';
import {createHash,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {existsSync,lstatSync,readFileSync,mkdirSync,writeFileSync,renameSync,chmodSync} from 'node:fs';
import path from 'node:path';
import {mcpAuthRouter} from '@modelcontextprotocol/sdk/server/auth/router.js';
import {InvalidClientError,InvalidClientMetadataError,InvalidGrantError,InvalidRequestError,InvalidScopeError,InvalidTokenError} from '@modelcontextprotocol/sdk/server/auth/errors.js';

const SCOPE='mcp:read',MINUTE=60000,DAY=86400000;
const digest=value=>createHash('sha256').update(String(value)).digest('hex');
const equal=(a,b)=>timingSafeEqual(Buffer.from(digest(a),'hex'),Buffer.from(digest(b),'hex'));
const random=()=>randomBytes(32).toString('base64url');
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

/** Private-owner authorization server. storePath must be in an operator ACL-protected directory on Windows. */
export function createOwnerOAuth({issuerUrl,resourceUrl,ownerSecret,storePath,allowLocalhostRedirects=false,now=Date.now}={}) {
  const issuer=new URL(issuerUrl),resource=new URL(resourceUrl);
  const loopback=url=>['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  const safeUrl=url=>!url.username&&!url.password&&!url.search&&!url.hash;
  if(!safeUrl(issuer)||issuer.pathname!=='/'||(issuer.protocol!=='https:'&&!(allowLocalhostRedirects&&loopback(issuer)&&issuer.protocol==='http:')))throw new Error('OAuth issuer must be an HTTPS origin');
  if(!safeUrl(resource)||resource.origin!==issuer.origin||resource.protocol!==issuer.protocol)throw new Error('OAuth resource must be a URL on the configured issuer origin');
  if(typeof ownerSecret!=='string'||ownerSecret.length<20||ownerSecret.length>1024)throw new Error('OAuth owner password must contain at least 20 characters');
  if(storePath!==undefined&&(!path.isAbsolute(storePath)||storePath.startsWith('\\\\')))throw new Error('OAuth storePath must be an absolute local path');
  const ownerHash=digest(ownerSecret),clients=new Map(),access=new Map(),refresh=new Map(),usedRefresh=new Map(),codes=new Map(),flows=new Map(),loginAttempts=new Map();
  const cookieName='__Host-traffic-consent';
  const expired=record=>!record||!Number.isFinite(record.expiresAt)||record.expiresAt<=now();
  function prune(){
    for(const map of [access,refresh,usedRefresh,codes,flows])for(const[key,value]of map)if(expired(value))map.delete(key);
    for(const[key,value]of loginAttempts)if(value.until<=now())loginAttempts.delete(key);
  }
  if(storePath&&existsSync(storePath)){
    try{
      if(lstatSync(storePath).isSymbolicLink()||lstatSync(storePath).size>10*1024*1024)throw new Error();
      const data=JSON.parse(readFileSync(storePath,'utf8'));
      if(data.version!==1||data.issuer!==issuer.href||data.resource!==resource.href||data.ownerHash!==ownerHash)throw new Error();
      for(const[name,map]of [['clients',clients],['access',access],['refresh',refresh],['usedRefresh',usedRefresh]]){
        if(!Array.isArray(data[name])||data[name].length>10000)throw new Error();
        for(const entry of data[name]){if(!Array.isArray(entry)||entry.length!==2||typeof entry[0]!=='string'||!entry[1]||typeof entry[1]!=='object')throw new Error();map.set(entry[0],entry[1]);}
      }
      prune();
    }catch{throw new Error('OAuth store is invalid or does not match this issuer, resource and owner');}
  }
  function persist(){
    prune();
    if(!storePath)return;
    mkdirSync(path.dirname(storePath),{recursive:true,mode:0o700});
    const temp=storePath+'.'+randomUUID()+'.tmp';
    writeFileSync(temp,JSON.stringify({version:1,issuer:issuer.href,resource:resource.href,ownerHash,clients:[...clients],access:[...access],refresh:[...refresh],usedRefresh:[...usedRefresh]}),{mode:0o600,flag:'wx'});
    renameSync(temp,storePath);chmodSync(storePath,0o600);
  }
  function audience(value){if(value!==undefined&&value.href!==resource.href)throw new InvalidRequestError('Invalid resource');return resource.href;}
  function scopes(values){const out=values?.length?[...new Set(values)]:[SCOPE];if(out.some(s=>s!==SCOPE))throw new InvalidScopeError('Unsupported scope');return out;}
  function publicClient(record){if(!record)return undefined;const {secretHash,...metadata}=record;return structuredClone(metadata);}
  function validRedirect(value){
    let url;try{url=new URL(value);}catch{throw new InvalidClientMetadataError('Invalid redirect URI');}
    if(url.username||url.password||url.hash||url.href.length>2048||(url.protocol!=='https:'&&!(allowLocalhostRedirects&&loopback(url)&&url.protocol==='http:')))throw new InvalidClientMetadataError('Redirect URI must use HTTPS');
    return url.href;
  }
  function issue(clientId,grantedScopes,family=randomUUID()){
    prune();if(access.size>=10000||refresh.size>=10000||usedRefresh.size>=10000)throw new Error('OAuth token capacity reached');
    const token=random(),refreshToken=random();
    const common={clientId,scopes:[...grantedScopes],resource:resource.href,family};
    access.set(digest(token),{...common,expiresAt:now()+60*MINUTE});
    refresh.set(digest(refreshToken),{...common,expiresAt:now()+30*DAY});
    persist();
    return {access_token:token,token_type:'Bearer',expires_in:3600,scope:grantedScopes.join(' '),refresh_token:refreshToken};
  }
  function grant(client,code){const item=codes.get(digest(code));if(expired(item)||item.clientId!==client.client_id)throw new InvalidGrantError('Invalid authorization code');return item;}
  async function verifyAccessToken(token){
    if(typeof token!=='string'||token.length>256)throw new InvalidTokenError('Invalid access token');
    const item=access.get(digest(token));
    if(expired(item)||item.resource!==resource.href||!clients.has(item.clientId)||item.scopes.length!==1||item.scopes[0]!==SCOPE)throw new InvalidTokenError('Invalid access token');
    return {token,clientId:item.clientId,scopes:[...item.scopes],expiresAt:Math.floor(item.expiresAt/1000),resource:new URL(item.resource)};
  }
  const provider={
    clientsStore:{
      getClient:id=>publicClient(clients.get(id)),
      registerClient:async metadata=>{
        prune();if(clients.size>=1000)throw new InvalidClientMetadataError('Client registration capacity reached');
        if(!Array.isArray(metadata.redirect_uris)||metadata.redirect_uris.length<1||metadata.redirect_uris.length>10)throw new InvalidClientMetadataError('Provide one to ten redirect URIs');
        const redirects=metadata.redirect_uris.map(validRedirect);
        const method=metadata.token_endpoint_auth_method??'client_secret_post';
        if(!['none','client_secret_post'].includes(method))throw new InvalidClientMetadataError('Unsupported client authentication method');
        if(metadata.grant_types?.some(g=>!['authorization_code','refresh_token'].includes(g))||metadata.response_types?.some(r=>r!=='code'))throw new InvalidClientMetadataError('Unsupported client grant');
        const registered={client_id:metadata.client_id??randomUUID(),client_id_issued_at:metadata.client_id_issued_at??Math.floor(now()/1000),redirect_uris:redirects,token_endpoint_auth_method:method,grant_types:['authorization_code','refresh_token'],response_types:['code'],client_name:typeof metadata.client_name==='string'?metadata.client_name.slice(0,100):'MCP client',scope:SCOPE};
        if(method!=='none'){
          if(typeof metadata.client_secret!=='string')throw new InvalidClientMetadataError('Client secret missing');
          registered.client_secret_expires_at=metadata.client_secret_expires_at;
        }
        clients.set(registered.client_id,{...registered,...(method==='none'?{}:{secretHash:digest(metadata.client_secret)})});persist();
        return {...registered,...(method==='none'?{}:{client_secret:metadata.client_secret})};
      },
    },
    authorize:async(client,params,res)=>{
      audience(params.resource);const grantedScopes=scopes(params.scopes);
      if(!client.redirect_uris.includes(params.redirectUri))throw new InvalidRequestError('Redirect URI must match exactly');
      if(!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge)||params.state?.length>2048)throw new InvalidRequestError('Invalid PKCE challenge or state');
      prune();if(flows.size>=1000)throw new InvalidRequestError('Authorization capacity reached');
      const flow=random(),csrf=random(),cookie=random();
      flows.set(digest(flow),{clientId:client.client_id,redirectUri:params.redirectUri,codeChallenge:params.codeChallenge,state:params.state,scopes:grantedScopes,resource:resource.href,csrfHash:digest(csrf),cookieHash:digest(cookie),expiresAt:now()+5*MINUTE});
      res.setHeader('Set-Cookie',`${cookieName}=${cookie}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=300`);
      res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
      // Native HTML form POSTs use the document referrer policy when serializing
      // Origin. no-referrer turns it into "null", breaking the strict origin
      // check below. same-origin preserves the local form origin and still
      // suppresses referrer information on the external OAuth callback.
      res.setHeader('Referrer-Policy','same-origin');res.setHeader('X-Content-Type-Options','nosniff');
      res.type('html').send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Traffic private access</title><style>html{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(ellipse at 15% 10%,#173044,#090f19 65%);color:#eef5fc;font:16px/1.6 system-ui,sans-serif}main{width:min(100%,460px);padding:38px;background:#111c2bea;border:1px solid #2b3b50;border-radius:24px;box-shadow:0 24px 80px #0005}.brand{font-size:12px;letter-spacing:.17em;text-transform:uppercase;color:#82d8c8}h1{font-size:30px;line-height:1.2;letter-spacing:-.03em;margin:20px 0 12px}p{color:#b7c7d9}.client{padding:12px 16px;background:#18283b;border-radius:12px;color:#e4eff9;overflow-wrap:anywhere}label{display:block;margin:24px 0 8px;font-weight:600}input{width:100%;padding:13px 14px;border:1px solid #40566e;background:#0d1623;color:#fff;border-radius:10px;font:inherit}input:focus{outline:3px solid #54cbb677;outline-offset:2px}button{width:100%;border:0;border-radius:11px;margin-top:24px;padding:14px;background:#80e2ce;color:#072b29;font:600 16px system-ui;cursor:pointer}button:hover{background:#a0f0df}button:focus-visible{outline:3px solid #fff;outline-offset:3px}.note{font-size:13px;color:#90a6be;margin-top:20px}</style><main><div class="brand">Traffic private access</div><h1>Connect your assistant</h1><p>Authorize read access to your transport tools.</p><div class="client">${escape(new URL(params.redirectUri).hostname)}</div><form method="post" action="/oauth/consent"><input type="hidden" name="flow" value="${flow}"><input type="hidden" name="csrf" value="${csrf}"><label for="owner-secret">Owner password</label><input id="owner-secret" name="owner_secret" type="password" autocomplete="current-password" required maxlength="1024"><button type="submit">Authorize connection</button></form><p class="note">Only continue if you started this connection and recognize the client above.</p></main></html>`);
    },
    challengeForAuthorizationCode:async(client,code)=>grant(client,code).codeChallenge,
    exchangeAuthorizationCode:async(client,code,_verifier,redirectUri,target)=>{
      const item=grant(client,code);audience(target);
      if(redirectUri!==item.redirectUri||item.resource!==resource.href)throw new InvalidGrantError('Authorization binding mismatch');
      codes.delete(digest(code));return issue(client.client_id,item.scopes);
    },
    exchangeRefreshToken:async(client,token,requestedScopes,target)=>{
      audience(target);const key=digest(token),item=refresh.get(key);
      if(expired(item)||item.clientId!==client.client_id||item.resource!==resource.href||item.scopes.length!==1||item.scopes[0]!==SCOPE){
        const used=usedRefresh.get(key);
        if(used&&used.clientId===client.client_id){for(const map of [access,refresh])for(const[k,v]of map)if(v.family===used.family)map.delete(k);persist();}
        throw new InvalidGrantError('Invalid refresh token');
      }
      const nextScopes=requestedScopes===undefined?item.scopes:scopes(requestedScopes);
      if(nextScopes.some(s=>!item.scopes.includes(s)))throw new InvalidScopeError('Invalid scope');
      refresh.delete(key);usedRefresh.set(key,{clientId:item.clientId,family:item.family,expiresAt:item.expiresAt});
      return issue(client.client_id,nextScopes,item.family);
    },
    verifyAccessToken,
    revokeToken:async(client,request)=>{
      const key=digest(request.token),grant=refresh.get(key);
      if(grant?.clientId===client.client_id){
        for(const map of [access,refresh])for(const[k,item]of map)if(item.family===grant.family)map.delete(k);
      }else{const item=access.get(key);if(item?.clientId===client.client_id)access.delete(key);}
      persist();
    },
  };
  function install(app){
    app.use((req,res,next)=>{if(['/authorize','/token','/register','/revoke','/oauth/consent'].includes(req.path)||req.path.startsWith('/.well-known/')){res.setHeader('Cache-Control','no-store');res.setHeader('Pragma','no-cache');}next();});
    app.use('/.well-known/oauth-authorization-server',(_req,res,next)=>{const send=res.json.bind(res);res.json=value=>send({...value,authorization_response_iss_parameter_supported:true});next();});
    app.post('/oauth/consent',express.urlencoded({extended:false,limit:'8kb'}),(req,res)=>{
      prune();const ip=req.ip??req.socket.remoteAddress??'unknown';
      for(const key of ['global',ip]){const entry=loginAttempts.get(key)??{count:0,until:now()+15*MINUTE};if(entry.count>=(key==='global'?50:5))return res.status(429).send('Too many authorization attempts. Try again later.');entry.count++;loginAttempts.set(key,entry);}
      const flow=typeof req.body.flow==='string'?flows.get(digest(req.body.flow)):null;
      const cookie=(req.headers.cookie??'').split(';').map(s=>s.trim()).find(s=>s.startsWith(cookieName+'='))?.slice(cookieName.length+1);
      if(expired(flow)||req.headers.origin!==issuer.origin||typeof req.body.csrf!=='string'||!equal(digest(req.body.csrf),flow.csrfHash)||!cookie||!equal(digest(cookie),flow.cookieHash))return res.status(403).send('Authorization request could not be verified. Start the connection again.');
      if(typeof req.body.owner_secret!=='string'||req.body.owner_secret.length>1024||!equal(digest(req.body.owner_secret),ownerHash))return res.status(403).send('Owner password was not accepted.');
      flows.delete(digest(req.body.flow));const code=random();codes.set(digest(code),{...flow,expiresAt:now()+5*MINUTE});
      res.setHeader('Set-Cookie',`${cookieName}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`);
      const destination=new URL(flow.redirectUri);destination.searchParams.set('code',code);destination.searchParams.set('iss',issuer.href);if(flow.state!==undefined)destination.searchParams.set('state',flow.state);res.redirect(302,destination.href);
    });
    // SDK clientAuth expects plaintext stored secrets. Verify hashes before it,
    // then expose only public client metadata through clientsStore.getClient.
    app.use(['/token','/revoke'],express.urlencoded({extended:false,limit:'8kb'}),(req,res,next)=>{
      if(req.method!=='POST')return next();
      const record=clients.get(req.body.client_id);
      if(!record)return res.status(401).json({error:'invalid_client'});
      if(record.secretHash&&(typeof req.body.client_secret!=='string'||!equal(digest(req.body.client_secret),record.secretHash)||(record.client_secret_expires_at&&record.client_secret_expires_at<Math.floor(now()/1000))))return res.status(401).json({error:'invalid_client'});
      next();
    });
    app.use(mcpAuthRouter({provider,issuerUrl:issuer,resourceServerUrl:resource,scopesSupported:[SCOPE],resourceName:'Private traffic tools'}));
  }
  return {install,verifyAccessToken,resourceMetadataUrl:issuer.origin+'/.well-known/oauth-protected-resource'+resource.pathname};
}
