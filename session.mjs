// Behavioral sources: vj/a0.java, vj/d0.java, qi/e.java, oj/f0.java, gd/b.java.
export class ClientError extends Error {
  constructor(code, message) { super(message); this.name = 'ClientError'; this.code = code; }
}

export function trustedUrl(value) {
  let url;
  // fk/i.java prefixes the scheme-less strings in MobileSettingsData with https://.
  if (typeof value === 'string' && /^[a-z0-9.-]+\//i.test(value)) value = 'https://' + value;
  try { url = new URL(value); } catch { throw new ClientError('CONFIG_INVALID', 'A runtime endpoint URL is missing or invalid'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash ||
      !(url.hostname === 'flightradar24.com' || url.hostname.endsWith('.flightradar24.com'))) {
    throw new ClientError('CONFIG_INVALID', 'Endpoints must use HTTPS on a Flightradar24 host');
  }
  return url;
}

function validToken(value) { return typeof value === 'string' && /^[\x21-\x7e]+$/.test(value); }
function expiration(token) {
  const pieces = token.split('.');
  if (pieces.length !== 3) return Infinity;
  try {
    const value = JSON.parse(Buffer.from(pieces[1], 'base64url').toString('utf8')).exp;
    return typeof value === 'number' && Number.isFinite(value) ? value * 1000 : Infinity;
  } catch { return Infinity; } // Decoding is only a freshness hint, never signature verification.
}

export const BOOTSTRAP = 'https://mobile.flightradar24.com/mobile/settings?version=5';
// Exact source fallback used when the Android runtime user agent is unavailable.
export const DEFAULT_AGENT = 'Flightradar24/101805070 Android unknown device';

export async function fetchJson(url, {fetch = globalThis.fetch, userAgent = DEFAULT_AGENT, ...options} = {}) {
  let result;
  try {
    result = await fetch(trustedUrl(url).href, {
      ...options, redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: {'user-agent':userAgent, accept:'application/json', ...options.headers},
    });
  } catch (e) {
    if (e instanceof ClientError) throw e;
    throw new ClientError('NETWORK_FAILED', 'Request failed; check connectivity, TLS, or blocked redirects');
  }
  if (!result.ok) throw new ClientError('HTTP_'+result.status, 'Upstream returned HTTP '+result.status);
  const length = Number(result.headers.get('content-length') || 0);
  if (length > 2000000) throw new ClientError('BAD_RESPONSE','Upstream response exceeds the size limit');
  try {
    // Stream with a bound so a missing Content-Length cannot cause unlimited buffering.
    const reader = result.body.getReader(); let total = 0; const chunks = [];
    while (true) {
      const {done, value} = await reader.read(); if (done) break;
      total += value.length;
      if (total > 2000000) { await reader.cancel(); throw new Error('large'); }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { throw new ClientError('BAD_RESPONSE', 'Upstream did not return bounded valid JSON'); }
}

export async function bootstrap(options = {}) {
  const url = new URL(BOOTSTRAP); url.searchParams.set('timestamp','0');
  const response = await fetchJson(url, options);
  // The APK adapter resolves Update.data; accept the already unwrapped settings too.
  const settings = response.data ?? response;
  if (!settings?.urls?.account?.login || !settings?.grpc?.feed?.url) {
    throw new ClientError('CONFIG_INVALID','Bootstrap response lacks account or gRPC settings');
  }
  return settings;
}

export class SessionClient {
  #settings; #fetch; #clock; #agent; #session; #refreshing; #validated=false;
  constructor({settings, fetch = globalThis.fetch, clock = Date.now, userAgent = DEFAULT_AGENT}) {
    trustedUrl(settings?.urls?.account?.login); trustedUrl(settings?.urls?.account?.userSession);
    this.#settings = settings; this.#fetch = fetch; this.#clock = clock; this.#agent = userAgent;
  }
  get settings() { return structuredClone(this.#settings); }
  get serverValidated() { return this.#validated; }
  toJSON() { return {authenticated: Boolean(this.#session)}; }
  #adopt(response,{fromCache=false}={}) {
    if (response?.success !== true) throw new ClientError('SESSION_REJECTED','The server rejected this session');
    const access = response?.userData?.accessToken, login = response?.userData?.tokenLogin;
    if (!validToken(access) || !validToken(login)) throw new ClientError('BAD_SESSION','Malformed session response');
    const expires = expiration(access);
    if (!fromCache && expires <= this.#clock()) throw new ClientError('SESSION_EXPIRED','The server returned an expired session');
    this.#session = {access, login, receivedAt:this.#clock(), expires};
    this.#validated=!fromCache;
  }
  async login(email, password, {sdkInt = 35} = {}) {
    if (!email || !password || !Number.isInteger(sdkInt) || sdkInt < 1) throw new ClientError('LOGIN_INPUT','Login fields are required');
    const body = new URLSearchParams({email, password, remember:'true', device:`android;${sdkInt};101805070`});
    this.#adopt(await fetchJson(this.#settings.urls.account.login, {fetch:this.#fetch,userAgent:this.#agent,
      method:'POST', headers:{'content-type':'application/x-www-form-urlencoded;charset=UTF-8'}, body}));
  }
  async refresh() {
    if (!this.#session) throw new ClientError('LOGIN_REQUIRED','Sign in to your own account before querying');
    if (this.#refreshing) return this.#refreshing;
    const current=this.#session;
    const url = trustedUrl(this.#settings.urls.account.userSession);
    url.searchParams.set('tokenLogin',this.#session.login);
    this.#refreshing = (async () => {
      const response=await fetchJson(url, {fetch:this.#fetch,userAgent:this.#agent,method:'GET'});
      if (this.#session === current) this.#adopt(response);
    })();
    try { await this.#refreshing; } finally { this.#refreshing = undefined; }
  }
  // Import only a response obtained from the user's own authenticated session.
  importSession(response) {
    this.#adopt(response,{fromCache:true});
    if (Number.isFinite(response.receivedAt) && response.receivedAt >= 0 && response.receivedAt <= this.#clock()) this.#session.receivedAt=response.receivedAt;
  }
  // Sensitive: pass this only to an encrypted current-user store, never a logger.
  exportSession() {
    if (!this.#session) throw new ClientError('LOGIN_REQUIRED','No session to store');
    return {success:true,userData:{accessToken:this.#session.access,tokenLogin:this.#session.login},receivedAt:this.#session.receivedAt};
  }
  async authorization() {
    if (!this.#session) throw new ClientError('LOGIN_REQUIRED','Sign in to your own account before querying');
    const now = this.#clock();
    if (now - this.#session.receivedAt >= 1800000 || now >= this.#session.expires - 30000) await this.refresh();
    return {authorization:'Bearer '+this.#session.access};
  }
}
