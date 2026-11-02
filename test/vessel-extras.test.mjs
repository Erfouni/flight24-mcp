import test from 'node:test';
import assert from 'node:assert/strict';

const load = () => import('../vessel-extras.mjs');
const identity = { mmsi: 636026627, imo: 9811000, name: 'EVER GIVEN', type: 'Container Ship', a2: 'LR' };
const master = { imoNumber: 9811000, vesselName: 'EVER GIVEN', shipType: 'Container Ship', flag: 'Liberia', grossTonnage: 219079, lengthOverall: 399.944, beam: 58.8, yearOfBuilt: 2018, builder: 'locked', manager: 'locked', ownerEmail: 'lockedSat', fail: 0 };
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const now = () => Date.parse('2026-11-02T09:00:00Z');
const fetchData = async url => url.pathname.endsWith('/search') ? json([identity]) : json(master);

test('vessel details return validated master particulars and explicit locked fields', async () => {
  const { getVesselDetails } = await load();
  const result = await getVesselDetails('EVER GIVEN', { now, fetchImpl: async (url, options) => {
    if (!url.pathname.endsWith('/search')) assert.equal(url.href, 'https://www.vesselfinder.com/api/mv4/shipmd/636026627/9811000');
    assert.equal(options.redirect, 'error');
    return fetchData(url);
  } });
  assert.equal(result.status, 'partial');
  assert.equal(result.details.vesselName, 'EVER GIVEN');
  assert.equal(result.details.lengthOverall, 399.944);
  assert.equal(result.details.builder, null);
  assert.deepEqual(result.lockedFields, ['builder', 'manager']);
  assert.equal(result.details.ownerEmail, undefined);
  assert.equal(result.dataKind, 'master_particulars');
  assert.equal(result.retrievedAt, '2026-11-02T09:00:00.000Z');
  assert.equal(result.reportedAt, undefined);
});

test('master details reject an IMO identity mismatch', async () => {
  const { getVesselDetails } = await load();
  await assert.rejects(getVesselDetails('EVER GIVEN', { fetchImpl: async url => url.pathname.endsWith('/search') ? json([identity]) : json({ ...master, imoNumber: 1234567 }) }), /identity/i);
});

test('a USS query cannot silently become similarly named passenger particulars', async () => {
  const { getVesselDetails } = await load();
  const result = await getVesselDetails('USS ABRAHAM LINCOLN', { now, fetchImpl: async () => json([{ ...identity, name: 'ABRAHAM LINCOLN', type: 'Passenger ship' }]) });
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.details, null);
});

test('missing vessel and absent master data have explicit no-data statuses', async () => {
  const { getVesselDetails } = await load();
  const missing = await getVesselDetails('UNKNOWN', { fetchImpl: async () => json([]) });
  assert.equal(missing.status, 'not_found');
  const absent = await getVesselDetails('636026627', { fetchImpl: async url => url.pathname.endsWith('/search') ? json([identity]) : json({ fail: 1 }) });
  assert.equal(absent.status, 'unavailable');
  assert.equal(absent.details, null);
});

test('details enforce bounded upstream responses and propagate HTTP failures', async () => {
  const { getVesselDetails } = await load();
  for (const response of [new Response('', { status: 400 }), new Response('x'.repeat(1024 * 1024 + 1))]) {
    await assert.rejects(getVesselDetails('EVER GIVEN', { fetchImpl: async url => url.pathname.endsWith('/search') ? json([identity]) : response }), /HTTP 400|too large/);
  }
});
