# Flight24 MCP

**English** · [فارسی](README.fa.md)

A self-hosted MCP server for source-backed aircraft and vessel observations, available route history, airport events and dated satellite imagery. Developed by **Erfouni**.

The server uses MCP Streamable HTTP at `/mcp`. Tool availability depends on configured providers: up to 27 tools are available with all existing providers configured, with up to 31 when the four optional regional archive tools are enabled. A running server does not automatically provide authenticated Gold history or satellite access.

## Capabilities

| Area | Available operations | Interpretation |
| --- | --- | --- |
| Aircraft | Airline and area counts/lists, aircraft search, available flight history and tracks | Tracked observations, with provider limits and gaps |
| Airport history | Scheduled arrivals, actual landing/takeoff events, country/bbox/polygon airport selection and bounded regional history | Source availability and selected airports constrain coverage |
| Vessels | Search, last AIS position, available history, particulars and area counts/lists | Last report time is preserved; silence does not establish absence |
| Track files | Statistics, CSV/KML from supplied observations, optional original provider downloads | Derived exports and original provider files remain distinct |
| Satellite | Copernicus scene search and true-colour images | Dated acquisitions with cloud and resolution limits, not live video |
| Regional jobs | `start_region_history_job`, `get_region_history_job`, `download_region_history_job`, `analyze_region_history_job` | Optional queued, resumable archive workflow |

Every result should be read with its report time, freshness, coverage and failure fields. Partial observations are not complete traffic totals. Historical cargo classification can be unavailable: exact cargo counts remain unknown rather than being inferred from aircraft type. Broad tanker classes do not verify oil cargo. A regional airport query counts events at selected airports, not overflights or all traffic in that region.

## Quick start

Requires **Node.js 22 or newer** and npm. From the repository root:

```sh
npm ci
npm test
cp .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

On PowerShell, use `Copy-Item .env.example .env` for the copy step. Paste the generated value into `MCP_BEARER_TOKEN` in your private `.env`. Generate a separate random 32-byte value for `OAUTH_OWNER_SECRET` if enabling owner OAuth. Keep both values private; neither is a provider account token.

Review `.env` before starting. Enable only the providers you have configured; remove an explicit `COPERNICUS_ENV_FILE` setting until its credential file exists. Then run:

```sh
node --env-file=.env run-mcp.mjs
```

The default listener is `127.0.0.1:8080`. `/health` reports process health; it does not certify every upstream provider. Configure HTTPS through your own reverse proxy before remote access.

## Connect an MCP client

Use your own HTTPS endpoint and send the token as a header:

```text
URL: https://your-mcp.example/mcp
Authorization: Bearer <YOUR_MCP_TOKEN>
```

Owner OAuth is optional. Set `PUBLIC_URL` to your HTTPS origin, supply a separate `OAUTH_OWNER_SECRET`, and configure `OAUTH_STORE_PATH` in a private persistent directory. The owner signs in through the authorization page; provider account passwords are unrelated to this password. Protect persistent state with filesystem permissions.

For clients that require a URL-only connection, explicitly set `MCP_ALLOW_URL_TOKEN=true` and use `https://your-mcp.example/mcp?access_token=<YOUR_MCP_TOKEN>`. Treat that entire URL as a secret: it may be retained in client settings, browser history or proxy logs. URL authentication is disabled by default. Do not send both URL and header credentials.

## Optional provider configuration

**Gold history.** Provision your own authorized account/session separately. The Windows integration supports private DPAPI-protected session material and a standard headed Chrome session through loopback CDP, for example `http://127.0.0.1:9227`. Relevant settings include `FR24_BROWSER_PROFILE`, `FR24_BROWSER_CDP_ENDPOINT` and the `FR24_*_DPAPI_FILE` options in the runtime. DPAPI material is tied to its Windows identity and must be provisioned under the account running the application.

Sign in normally, keep the dedicated browser open, and restore the desktop/browser session after reboot as needed. Session expiry and automatic renewal are not guaranteed; manual sign-in may be required. Gold website access is separate from the official commercial API and does not establish permission for redistribution. This project does not unlock premium access, supply an account, or share a hosted private session.

**Copernicus.** Supply your own supported Sentinel Hub credentials through `COPERNICUS_ENV_FILE`. The credential file is external to the source tree. Satellite tools are optional and subject to provider permissions and coverage.

## History jobs and rate limits

The history workflow supports shared caching, paced requests and `Retry-After` handling. Optional durable regional jobs allow bounded work to be queued and resumed rather than repeating an entire archive request. Use `get_region_history_job` to inspect progress, failures and coverage before downloading a job result.

The integration settings are `FR24_HISTORY_CACHE_DIR`, `FR24_HISTORY_MIN_INTERVAL_MS` and `HISTORY_JOB_DIR` when configured. Keep cache/job directories private and persistent. Cached results retain their original source and retrieval times; they are not newly observed traffic. These controls reduce repeated requests but cannot guarantee that a provider will never return HTTP 429. No undocumented provider quota is assumed. Follow provider responses and account terms; repeated retries cannot create missing access or data.

## Public release boundaries

This repository contains application code and a factual public airport reference catalog with source metadata. It excludes private credentials, account/session files, APKs, decompiled third-party source, raw private reports, proprietary logos and captured provider datasets. Generate your own secrets and provision your own authorized provider access.

Provider availability can change. A tool may be registered while its source is blocked, locked, unavailable or incomplete; inspect its actual response. The project does not claim that every graphical Gold website feature is implemented as an MCP tool.

[Repository](https://github.com/Erfouni/flight24-mcp) · Developer: **Erfouni**

### Batch example

1. Call `start_region_history_job` with `selection: {"country":"AE"}`, `fromDate: "2026-10-01"`, `toDate: "2026-10-10"`.
2. Poll `get_region_history_job` using the returned `jobId`; respect `retryAt` when waiting.
3. Call `download_region_history_job` with the same ID, `offset: 0`, `limit: 200`, then follow `nextOffset`. Downloads read the archive without new provider requests.
4. Reuse the same query to reuse its job. After resolving a failed job's cause, explicitly set `resumeFailed: true` on the start call to continue its checkpoint.

Default bounds are 20 jobs, 10,000 airport/day requests per plan, 100,000 records per job and 4 MiB per downloaded page. These are local safety limits, not published provider quotas. Two DPAPI integration tests run only on Windows; other tests run on Windows and Linux.

### Analyze locally in one call

Use `analyze_region_history_job` with `jobId`, optional exact `aircraftTypes`, optional `originFilter: {"mode":"outside","selection":{"country":"AE"}}`, and `groupBy: "aircraftType"` (also `originCountry` or `airlineId`). It returns compact counts from one consistent stored snapshot with zero provider requests. Unknown origins remain separate and are never classified as outside. Aircraft type alone does not establish cargo role or aircraft nationality.
