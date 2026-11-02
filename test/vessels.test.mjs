import test from 'node:test';
import assert from 'node:assert/strict';

const load = () => import('../vessels.mjs');
const now = () => Date.parse('2026-11-02T09:00:00Z');
const item = { name: 'EXAMPLE SHIP', mmsi: 123456789, imo: 1234567, type: 'Container Ship', a2: 'GB', r: 1, dest: 'PORT', etaTS: 0 };
const json = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });

test('search encodes a literal query and preserves vessel identity without claiming a position', async () => {
  const { searchVessels } = await load();
  const result = await searchVessels('Example & ship', { now, fetchImpl: async (url, options) => {
    assert.equal(url.origin, 'https://www.vesselfinder.com');
    assert.equal(url.pathname, '/api/mv4/search');
    assert.equal(url.searchParams.get('term'), 'EXAMPLE & SHIP');
    assert.equal(url.searchParams.get('limit'), '20');
    assert.equal(options.redirect, 'error');
    return json([item]);
  } });
  assert.equal(result.vessels[0].name, 'EXAMPLE SHIP');
  assert.equal(result.vessels[0].mmsi, '123456789');
  assert.equal(result.vessels[0].type, 'Container Ship');
  assert.equal(result.retrievedAt, '2026-11-02T09:00:00.000Z');
  assert.equal(result.vessels[0].reportedAt, undefined);
});

test('an absent USS name never becomes the similarly named passenger ship', async () => {
  const { getVesselPosition } = await load();
  const result = await getVesselPosition('USS ABRAHAM LINCOLN', { now, fetchImpl: async () => json([]) });
  assert.equal(result.status, 'not_found');
  assert.equal(result.position, null);
});

test('multiple vessel names require an explicit MMSI', async () => {
  const { getVesselPosition } = await load();
  const result = await getVesselPosition('EXAMPLE', { now, fetchImpl: async () => json([item, { ...item, mmsi: 987654321 }]) });
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.candidates.length, 2);
  assert.equal(result.position, null);
});

test('a fuzzy passenger-ship match cannot satisfy an explicit USS identity', async () => {
  const { getVesselPosition } = await load();
  const result = await getVesselPosition('USS ABRAHAM LINCOLN', { now, fetchImpl: async () => json([{ ...item, name: 'ABRAHAM LINCOLN', type: 'Passenger ship' }]) });
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.position, null);
  assert.equal(result.candidates[0].type, 'Passenger ship');
});

test('decodes the independently captured 19-byte big-endian report with its original report timestamp', async () => {
  const { getVesselPosition } = await load();
  const result = await getVesselPosition('636026627', { now, fetchImpl: async () => new Response(Buffer.from('11008c045c88c400fb4cfb6ae7552a01030204', 'hex')) });
  assert.equal(result.status, 'ok');
  assert.equal(result.position.longitude, 121.95531333333334);
  assert.equal(result.position.latitude, 27.448738333333335);
  assert.equal(result.position.reportedAt, '2026-11-01T15:05:14.000Z');
  assert.equal(result.position.providerMarkedOld, true);
  assert.equal(result.position.freshness, 'stale');
  assert.equal(result.position.newerSatellitePositionAvailable, true);
});

test('no report and malformed reports cannot become a zero-coordinate current location', async () => {
  const { getVesselPosition } = await load();
  const empty = await getVesselPosition('123456789', { now, fetchImpl: async () => new Response(new Uint8Array()) });
  assert.equal(empty.status, 'unavailable');
  assert.equal(empty.position, null);
  await assert.rejects(getVesselPosition('123456789', { now, fetchImpl: async () => new Response(new Uint8Array(10)) }), /truncated/i);
});

test('rejects upstream errors and oversized responses instead of guessing data', async () => {
  const { searchVessels } = await load();
  await assert.rejects(searchVessels('EXAMPLE', { fetchImpl: async () => new Response('', { status: 410 }) }), /410/);
  await assert.rejects(searchVessels('EXAMPLE', { fetchImpl: async () => new Response('x'.repeat(1024 * 1024 + 1)) }), /too large/i);
});

test('rejects short or invalid identifiers before requesting upstream', async () => {
  const { searchVessels, getVesselPosition } = await load();
  const fetchImpl = async () => { throw new Error('should not request'); };
  await assert.rejects(searchVessels('ab', { fetchImpl }), /3.*100/);
  await assert.rejects(getVesselPosition('../', { fetchImpl }), /identifier/i);
});
