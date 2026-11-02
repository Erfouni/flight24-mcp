import { searchVessels } from './vessels.mjs';

const ORIGIN = 'https://www.vesselfinder.com';
const HEADERS = { S34ASAX0: 's12a', P174RM: 'a3d' };
const MAX_BYTES = 1024 * 1024;
const FIELDS = ['imoNumber', 'vesselName', 'shipType', 'flag', 'homePort', 'grossTonnage', 'summerDeadweight', 'lengthOverall', 'beam', 'draught', 'yearOfBuilt', 'builder', 'placeOfBuilt', 'yard', 'teu', 'crude', 'grain', 'bale', 'classificationSociety', 'registeredOwner', 'manager'];

async function requestJson(path, options) {
  const response = await (options.fetchImpl ?? fetch)(new URL(path, ORIGIN), {
    headers: HEADERS, redirect: 'error', signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`VesselFinder request failed with HTTP ${response.status}`);
  }
  if (Number(response.headers.get('content-length')) > MAX_BYTES) {
    await response.body?.cancel();
    throw new Error('VesselFinder response too large');
  }
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body ?? []) {
    bytes += chunk.byteLength;
    if (bytes > MAX_BYTES) throw new Error('VesselFinder response too large');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
}

// Verified source: ship.service.ts master() and ship.particulars.model.ts.
// The separate dynamic shipdetails and teaser endpoints failed live probes.
export async function getVesselDetails(identifier, options = {}) {
  if (typeof identifier !== 'string' || !/^[\p{L}\p{N}][\p{L}\p{N}\p{M} ._()'\-]{2,99}$/u.test(identifier.trim())) {
    throw new Error('Vessel identifier must be a MMSI, IMO, or vessel name');
  }
  identifier = identifier.trim();
  const lookup = identifier.replace(/^U\.S\.S\.\s*/i, 'USS ');
  const search = await searchVessels(lookup, options);
  let candidates = search.vessels;
  if (/^\d{9}$/.test(lookup)) candidates = candidates.filter(v => v.mmsi === lookup);
  if (/^\d{7}$/.test(lookup)) candidates = candidates.filter(v => v.imo === lookup);
  const base = { source: 'VesselFinder public AIS', dataKind: 'master_particulars', identifier, retrievedAt: search.retrievedAt, details: null };
  if (!candidates.length) return { ...base, status: 'not_found', candidates: [], message: 'No matching public vessel identity was found.' };
  if (candidates.length > 1 || (/^USS\s/i.test(lookup) && candidates[0].name.toUpperCase() !== lookup.toUpperCase())) {
    return { ...base, status: 'ambiguous', candidates, message: 'Check vessel name and type and select the intended MMSI. A similarly named vessel is not the requested identity.' };
  }
  const vessel = candidates[0];
  const endpoint = `/api/mv4/shipmd/${vessel.mmsi}/${vessel.imo ?? '0'}`;
  const data = await requestJson(endpoint, options);
  const at = new Date((options.now ?? Date.now)()).toISOString();
  if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error('Invalid VesselFinder master particulars response');
  if (data.fail === 1) return { ...base, vessel, retrievedAt: at, status: 'unavailable', message: 'No public master particulars are available for this vessel.' };
  if (!Number.isInteger(Number(data.imoNumber)) || (vessel.imo && String(data.imoNumber) !== vessel.imo) || typeof data.vesselName !== 'string') {
    throw new Error('VesselFinder master particulars identity mismatch or invalid response');
  }
  const details = {}; const lockedFields = []; const unavailableFields = [];
  for (const key of FIELDS) {
    const value = data[key];
    if (value === 'locked' || value === 'lockedSat') {
      details[key] = null; lockedFields.push(key);
    } else if (typeof value === 'string') details[key] = value.slice(0, 300);
    else if (typeof value === 'number' && Number.isFinite(value)) details[key] = value;
    else { details[key] = null; unavailableFields.push(key); }
  }
  return {
    ...base, vessel, retrievedAt: at, status: lockedFields.length || unavailableFields.length ? 'partial' : 'ok', details, lockedFields, unavailableFields,
    message: 'Master particulars only. Locked or unavailable fields are null. Retrieval time is not a position report timestamp; these particulars do not establish a vessel location.',
  };
}
