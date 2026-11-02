// Protocol verified against the user-supplied VesselFinder 4.0.6 APK source maps.
// These are public product/platform identifiers, not account credentials.
const ORIGIN = 'https://www.vesselfinder.com';
const HEADERS = { S34ASAX0: 's12a', P174RM: 'a3d' };
const MAX_BYTES = 1024 * 1024;
const SOURCE = 'VesselFinder public AIS';

async function request(path, options) {
  const response = await (options.fetchImpl ?? fetch)(new URL(path, ORIGIN), {
    headers: HEADERS,
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`VesselFinder request failed with HTTP ${response.status}`);
  }
  if (Number(response.headers.get('content-length')) > MAX_BYTES) {
    await response.body?.cancel();
    throw new Error('VesselFinder response too large');
  }
  const chunks = [];
  let bytes = 0;
  if (response.body) {
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > MAX_BYTES) throw new Error('VesselFinder response too large');
      chunks.push(Buffer.from(chunk));
    }
  }
  return Buffer.concat(chunks, bytes);
}

function queryText(query) {
  if (typeof query !== 'string' || query.trim().length < 3 || query.trim().length > 100 || /[\u0000-\u001f\u007f]/u.test(query)) {
    throw new Error('Vessel query must contain 3 to 100 characters');
  }
  return query.trim();
}

const text = value => typeof value === 'string' ? value.slice(0, 250) : null;
const epochISO = value => Number.isInteger(value) && value > 0 && value <= 0x7fffffff ? new Date(value * 1000).toISOString() : null;
const retrievedAt = options => new Date((options.now ?? Date.now)()).toISOString();

export async function searchVessels(query, options = {}) {
  query = queryText(query);
  const url = new URL('/api/mv4/search', ORIGIN);
  url.searchParams.set('term', query.toUpperCase());
  url.searchParams.set('limit', '20');
  const data = JSON.parse((await request(url.pathname + url.search, options)).toString('utf8'));
  if (!Array.isArray(data) || data.length > 20) throw new Error('Invalid VesselFinder search response');
  const vessels = data.map(item => {
    if (!item || !/^\d{9}$/.test(String(item.mmsi)) || typeof item.name !== 'string') {
      throw new Error('Invalid VesselFinder vessel identity');
    }
    return {
      mmsi: String(item.mmsi),
      imo: /^\d{7}$/.test(String(item.imo)) ? String(item.imo) : null,
      name: text(item.name), type: text(item.type), flag: text(item.a2),
      destination: text(item.dest), eta: epochISO(item.etaTS),
      // Live responses use r; older source maps called it INRANGE.
      inRangeCode: [0, 1, 2].includes(item.r ?? item.INRANGE) ? (item.r ?? item.INRANGE) : null,
    };
  });
  return { source: SOURCE, retrievedAt: retrievedAt(options), query, vessels };
}

async function resolveVessel(identifier, options) {
  if (typeof identifier !== 'string' || !/^[\p{L}\p{N}][\p{L}\p{N}\p{M} ._()'\-]{2,99}$/u.test(identifier.trim())) {
    throw new Error('Vessel identifier must be a MMSI, IMO, or vessel name');
  }
  identifier = identifier.trim();
  const base = { source: SOURCE, identifier };
  let vessel = { mmsi: identifier, imo: null, name: null, type: null };
  if (!/^\d{9}$/.test(identifier)) {
    const lookup = identifier.replace(/^U\.S\.S\.\s*/i, 'USS ');
    const result = await searchVessels(lookup, options);
    if (!result.vessels.length) return { ...base, status: 'not_found', retrievedAt: result.retrievedAt, candidates: [], message: 'No matching public AIS vessel was found. This does not establish the vessel location.' };
    const militaryNameMismatch = /^USS\s/i.test(lookup) && result.vessels.some(v => v.name.toUpperCase() !== lookup.toUpperCase());
    if (result.vessels.length > 1 || militaryNameMismatch) return { ...base, status: 'ambiguous', retrievedAt: result.retrievedAt, candidates: result.vessels, message: 'Select a vessel by MMSI after checking its name and type. A similarly named vessel does not establish the requested identity.' };
    vessel = result.vessels[0];
  }
  return { ...base, vessel };
}

export async function getVesselPosition(identifier, options = {}) {
  const resolved = await resolveVessel(identifier, options);
  const base = { ...resolved, position: null };
  if (resolved.status) return base;
  const { vessel } = resolved;
  const data = await request(`/api/mv4/ml/${vessel.mmsi}`, options);
  const at = retrievedAt(options);
  if (data.length < 3) return { ...base, status: 'unavailable', retrievedAt: at, vessel, message: 'No public AIS position report is available.' };
  if (data.length < 19) throw new Error('Truncated VesselFinder position response');
  const longitude = data.readInt32BE(3) / 600000;
  const latitude = data.readInt32BE(7) / 600000;
  if (Math.abs(longitude) > 180 || Math.abs(latitude) > 90) throw new Error('Invalid VesselFinder position coordinates');
  const timestamp = data.readInt32BE(11);
  const reportedAt = epochISO(timestamp);
  const age = reportedAt ? Math.floor((Date.parse(at) - timestamp * 1000) / 1000) : null;
  const ageSeconds = age !== null && age >= 0 ? age : null;
  const providerMarkedOld = data[15] !== 0;
  return {
    ...base, status: 'ok', retrievedAt: at, vessel,
    position: {
      latitude, longitude, reportedAt, ageSeconds, providerMarkedOld,
      freshness: ageSeconds === null ? 'unknown' : (providerMarkedOld || ageSeconds > 86400 ? 'stale' : 'last_report'),
      newerSatellitePositionAvailable: (data[0] & 0x10) !== 0,
    },
    message: 'Coordinates are the last public AIS report, not a guarantee of the current vessel location. Check vessel identity and reportedAt.',
  };
}

export async function getVesselHistory(identifier, options = {}) {
  if (options.days !== undefined) throw new Error('Day selection is not supported by the verified VesselFinder endpoint');
  const limit = options.limit ?? 2000;
  if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw new Error('History point limit must be an integer from 1 to 10000');
  const resolved = await resolveVessel(identifier, options);
  const base = { ...resolved, points: [], latestReportedPosition: null };
  if (resolved.status) return base;
  const data = await request(`/api/mv4/track/${resolved.vessel.mmsi}`, options);
  const at = retrievedAt(options);
  const coverage = { completeness: 'unknown', providerRetentionDays: null, outputTruncated: false, oldestReportedAt: null, newestReportedAt: null };
  if (data.length < 3) return { ...base, status: 'unavailable', retrievedAt: at, coverage, totalDecodedPoints: 0, skippedRecords: 0, message: 'No public AIS historical track is available. This does not establish the vessel location.' };
  if (data.length % 16 !== 0) throw new Error('Truncated VesselFinder historical track response');
  const points = [];
  let skippedRecords = 0;
  for (let offset = 0; offset < data.length; offset += 16) {
    const timestamp = data.readUInt32BE(offset);
    const longitudeRaw = data.readUInt32BE(offset + 4) ^ 0x55555555;
    const latitudeRaw = data.readUInt32BE(offset + 8) ^ 0x55555555;
    const reportedAt = epochISO(timestamp);
    // Match the APK's track filter, including its supported map latitude range.
    if (!reportedAt || longitudeRaw < -108000000 || longitudeRaw > 108000000 || longitudeRaw === 0 || latitudeRaw < -51030000 || latitudeRaw > 51030000 || latitudeRaw === 0) {
      skippedRecords++;
      continue;
    }
    points.push({
      reportedAt, longitude: longitudeRaw / 600000, latitude: latitudeRaw / 600000,
      courseDegrees: (data.readUInt16BE(offset + 12) ^ 0x5555) / 10,
      speedKnots: (data.readUInt16BE(offset + 14) ^ 0x5555) / 10,
    });
  }
  points.sort((a, b) => a.reportedAt.localeCompare(b.reportedAt));
  const latestReportedPosition = points.at(-1) ?? null;
  coverage.oldestReportedAt = points[0]?.reportedAt ?? null;
  coverage.newestReportedAt = latestReportedPosition?.reportedAt ?? null;
  coverage.outputTruncated = points.length > limit;
  return {
    ...base, status: points.length ? 'ok' : 'unavailable', retrievedAt: at,
    points: points.slice(-limit), latestReportedPosition, totalDecodedPoints: points.length, skippedRecords, coverage,
    message: 'Historical public AIS reports only. Track retention and completeness are unknown. The latest report is not a guarantee of current location; the endpoint does not support selecting a number of days.',
  };
}
