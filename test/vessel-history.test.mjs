import test from 'node:test';
import assert from 'node:assert/strict';

const load = () => import('../vessels.mjs');
const now = () => Date.parse('2026-11-02T09:00:00Z');
const older = '6553f100aec38cd557370f5556d15528';
const newer = '6553f13caef34e955724c91556bd5531';

test('history decodes signed XOR coordinates and keeps original report times in chronological order', async () => {
  const { getVesselHistory } = await load();
  const result = await getVesselHistory('123456789', { now, fetchImpl: async url => {
    assert.equal(url.href, 'https://www.vesselfinder.com/api/mv4/track/123456789');
    return new Response(Buffer.from(newer + older, 'hex'));
  } });
  assert.equal(result.status, 'ok');
  assert.equal(result.points.length, 2);
  assert.deepEqual(result.points[0], { reportedAt: '2023-11-14T22:13:20.000Z', longitude: -123.33333333333333, latitude: 66.66666666666667, courseDegrees: 90, speedKnots: 12.5 });
  assert.equal(result.latestReportedPosition.reportedAt, '2023-11-14T22:14:20.000Z');
  assert.equal(result.coverage.completeness, 'unknown');
  assert.equal(result.coverage.providerRetentionDays, null);
});

test('history limits output to the latest reports and reports output truncation honestly', async () => {
  const { getVesselHistory } = await load();
  const result = await getVesselHistory('123456789', { now, limit: 1, fetchImpl: async () => new Response(Buffer.from(newer + older, 'hex')) });
  assert.equal(result.points.length, 1);
  assert.equal(result.totalDecodedPoints, 2);
  assert.equal(result.points[0].reportedAt, '2023-11-14T22:14:20.000Z');
  assert.equal(result.coverage.outputTruncated, true);
  assert.equal(result.coverage.completeness, 'unknown');
});

test('history does not replace a requested USS with a similarly named passenger vessel', async () => {
  const { getVesselHistory } = await load();
  const result = await getVesselHistory('USS ABRAHAM LINCOLN', { now, fetchImpl: async () => new Response(JSON.stringify([{ mmsi: 366990620, imo: 0, name: 'ABRAHAM LINCOLN', type: 'Passenger ship', a2: 'US' }])) });
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.points.length, 0);
  assert.equal(result.latestReportedPosition, null);
});

test('empty history is unavailable and truncated binary is rejected', async () => {
  const { getVesselHistory } = await load();
  const empty = await getVesselHistory('123456789', { now, fetchImpl: async () => new Response(new Uint8Array()) });
  assert.equal(empty.status, 'unavailable');
  assert.equal(empty.latestReportedPosition, null);
  await assert.rejects(getVesselHistory('123456789', { fetchImpl: async () => new Response(Buffer.from(older + 'ff', 'hex')) }), /truncated/i);
});

test('history rejects unsupported day selection and unbounded point limits', async () => {
  const { getVesselHistory } = await load();
  await assert.rejects(getVesselHistory('123456789', { days: 7 }), /day.*not supported/i);
  await assert.rejects(getVesselHistory('123456789', { limit: 10001 }), /limit/i);
});
