import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {
  apiPath,
  bearer,
  boot,
  publishProject,
  resetDb,
  signupAndAccept,
  uniqNs,
} from './helpers.mjs';
import { aggregateDayLoader } from '../src/metrics.js';

let app;
let db;
let aggregateDay;
before(async () => {
  ({ app, db } = await boot());
  aggregateDay = aggregateDayLoader(db);
});
beforeEach(resetDb);
after(async () => {
  await db.$disconnect();
});

async function publishAs(ns, nsToken, adminToken, id, version, code) {
  await publishProject(app, ns, id, nsToken, { version, code });
  await request(app)
    .patch(apiPath(`/@${ns}/${id}/versions/${version}`))
    .set(bearer(adminToken))
    .send({ status: 'approved' })
    .expect(200);
}

async function makePublished() {
  const adminNs = uniqNs();
  const ab = await signupAndAccept(app, adminNs);
  const ownerNs = uniqNs();
  const ob = await signupAndAccept(app, ownerNs);
  await publishAs(ownerNs, ob.token, ab.token, 'hello', '1.0.0', '// v1.0.0');
  return { ownerNs, ownerToken: ob.token, adminToken: ab.token };
}

// The route records the download after it answers, so the event lands a moment
// after the response. Poll until the expected count shows up rather than guess
// at a delay.
async function waitForEvents(namespace, id, count) {
  for (let i = 0; i < 50; i += 1) {
    const [row] = await db.$queryRaw`
      SELECT COUNT(*)::int AS n FROM "DownloadEvents"
      WHERE "Namespace" = ${namespace} AND "ExtensionId" = ${id}
    `;
    if (row.n >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${count} download events`);
}

test('downloads roll up per version and appear on version objects', async () => {
  const adminNs = uniqNs();
  const admin = await signupAndAccept(app, adminNs);
  const ownerNs = uniqNs();
  const owner = await signupAndAccept(app, ownerNs);
  await publishAs(ownerNs, owner.token, admin.token, 'hello', '1.0.0', '// v1');
  // The owner's first publish was approved, so this one lands published.
  await publishProject(app, ownerNs, 'hello', owner.token, { version: '2.0.0', code: '// v2' });
  await publishProject(app, ownerNs, 'hello', owner.token, { version: '3.0.0', code: '// v3' });

  await request(app)
    .get(apiPath(`/@${ownerNs}/hello/versions/1.0.0/download`))
    .expect(200);
  await request(app)
    .get(apiPath(`/@${ownerNs}/hello/versions/1.0.0/download`))
    .expect(200);
  await request(app)
    .get(apiPath(`/@${ownerNs}/hello/versions/2.0.0/download`))
    .expect(200);
  await waitForEvents(ownerNs, 'hello', 3);

  await aggregateDay(new Date());

  // The per-version rollup keeps the versions apart...
  const buckets = await db.$queryRaw`
    SELECT "Version", "TotalDownloads" FROM "ExtensionVersionDailyDownloads"
    WHERE "Namespace" = ${ownerNs} AND "ExtensionId" = 'hello'
    ORDER BY "Version"
  `;
  assert.deepEqual(
    buckets.map((b) => [b.Version, Number(b.TotalDownloads)]),
    [
      ['1.0.0', 2],
      ['2.0.0', 1],
    ],
  );

  // ...and each single-version object reports its own count, not the total.
  const v1 = await request(app)
    .get(apiPath(`/@${ownerNs}/hello/versions/1.0.0`))
    .expect(200);
  assert.equal(v1.body.downloads, 2);
  const v2 = await request(app)
    .get(apiPath(`/@${ownerNs}/hello/versions/2.0.0`))
    .expect(200);
  assert.equal(v2.body.downloads, 1);

  // The extension detail carries the count on every version, and the total on
  // the summary.
  const detail = await request(app)
    .get(apiPath(`/@${ownerNs}/hello`))
    .expect(200);
  assert.equal(Number(detail.body.downloads), 3);
  const byVersion = new Map(detail.body.versions.map((v) => [v.version, v.downloads]));
  assert.equal(byVersion.get('1.0.0'), 2);
  assert.equal(byVersion.get('2.0.0'), 1);
  // A version nothing downloaded reports zero rather than being absent.
  assert.equal(byVersion.get('3.0.0'), 0);

  // The version list carries it too.
  const list = await request(app)
    .get(apiPath(`/@${ownerNs}/hello/versions`))
    .expect(200);
  const listed = new Map(list.body.data.map((v) => [v.version, v.downloads]));
  assert.equal(listed.get('1.0.0'), 2);
  assert.equal(listed.get('2.0.0'), 1);
  assert.equal(listed.get('3.0.0'), 0);
});

test('downloads are counted, surfaced, and feed trending', async () => {
  const { ownerNs, adminToken } = await makePublished();
  const w = await signupAndAccept(app, uniqNs());
  await publishAs(w.user.namespace, w.token, adminToken, 'widget', '1.0.0', '// widget');
  // gizmo needs a published version of its own, otherwise the trending lookup
  // finds nothing for it and the 7-day window is never actually exercised.
  // widget already published, so this one lands as published without review.
  await publishProject(app, w.user.namespace, 'gizmo', w.token, {
    version: '1.0.0',
    code: '// gizmo',
  });

  await request(app)
    .get(apiPath(`/@${ownerNs}/hello/versions/latest/download`))
    .expect(200);
  await request(app)
    .get(apiPath(`/@${ownerNs}/hello/versions/latest/download`))
    .expect(200);

  await db.$executeRawUnsafe(`
    INSERT INTO "DownloadEvents" ("Namespace", "ExtensionId", "Version", "UserAgent", "IpHash", "CreatedAt")
    SELECT e."Namespace", e."ExtensionId", '1.0.0', 'x', '10.0.0.1',
           now() - INTERVAL '3 days'
    FROM "Versions" e
    WHERE e."ExtensionId" = 'widget'
    UNION ALL
    SELECT e."Namespace", e."ExtensionId", '2.0.0', 'y', '10.0.0.2',
           now() - INTERVAL '8 days'
    FROM "Versions" e
    WHERE e."ExtensionId" = 'gizmo'
  `);
  for (const days of [3, 8]) {
    await aggregateDay(new Date(Date.now() - days * 86400000));
  }

  // the published extension's daily bucket only counts aggregations run so far
  await aggregateDay(new Date());
  const [bucket] = await db.$queryRaw`
    SELECT * FROM "ExtensionDailyDownloads"
    WHERE "Namespace" = ${ownerNs} AND "ExtensionId" = 'hello'
  `;
  assert.ok(Number(bucket.TotalDownloads) >= 2);

  const detail = await request(app)
    .get(apiPath(`/@${ownerNs}/hello`))
    .expect(200);
  assert.ok(Number(detail.body.downloads) >= 2);

  // widget (3 days ago) makes trending; gizmo (8 days) does not
  const trending = await request(app).get(apiPath('/extensions/trending')).expect(200);
  const entries = trending.body.data.map((e) => `${e.namespace}/${e.id}`);
  const trendingId = (id) => entries.find((key) => key.endsWith('/' + id));
  assert.ok(trendingId('widget'), `widget missing from ${entries.join(', ')}`);
  assert.ok(!trendingId('gizmo'), 'gizmo should not trend');

  const stats = await request(app).get(apiPath('/stats')).expect(200);
  assert.ok(Number(stats.body.downloads) >= 2);
});

test('trending includes six UTC days ago but excludes seven UTC days ago', async () => {
  const { ownerNs, ownerToken } = await makePublished();
  await publishProject(app, ownerNs, 'recent', ownerToken, { version: '1.0.0' });
  await publishProject(app, ownerNs, 'old', ownerToken, { version: '1.0.0' });

  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const sixDaysAgo = new Date(today - 6 * 86400000);
  const sevenDaysAgo = new Date(today - 7 * 86400000);
  await db.$executeRaw`
    INSERT INTO "DownloadEvents" ("Namespace", "ExtensionId", "Version", "UserAgent", "CreatedAt")
    VALUES (${ownerNs}, 'recent', '1.0.0', 'recent', ${sixDaysAgo.toISOString()}),
           (${ownerNs}, 'old', '1.0.0', 'old', ${sevenDaysAgo.toISOString()})
  `;
  await aggregateDay(sixDaysAgo);
  await aggregateDay(sevenDaysAgo);

  const trending = await request(app).get(apiPath('/extensions/trending')).expect(200);
  const ids = trending.body.data.map((entry) => entry.id);
  assert.ok(ids.includes('recent'));
  assert.ok(!ids.includes('old'));
});

test('trending selects a deprecated version when a newer version was yanked', async () => {
  const { ownerNs, ownerToken } = await makePublished();
  await publishProject(app, ownerNs, 'hello', ownerToken, { version: '2.0.0' });
  await db.$executeRaw`
    UPDATE "Versions" SET "Status" = 'deprecated'
    WHERE "Namespace" = ${ownerNs} AND "ExtensionId" = 'hello' AND "Version" = '1.0.0'
  `;
  await db.$executeRaw`
    UPDATE "Versions" SET "Status" = 'yanked'
    WHERE "Namespace" = ${ownerNs} AND "ExtensionId" = 'hello' AND "Version" = '2.0.0'
  `;
  await db.$executeRaw`
    INSERT INTO "ExtensionDailyDownloads" ("Namespace", "ExtensionId", "Day", "TotalDownloads")
    VALUES (${ownerNs}, 'hello', CURRENT_DATE, 3)
  `;

  const trending = await request(app).get(apiPath('/extensions/trending')).expect(200);
  assert.equal(trending.body.data.length, 1);
  assert.equal(trending.body.data[0].version, '1.0.0');
});

test('a download records a keyed hash of the address, never the address', async () => {
  const { ownerNs } = await makePublished();
  await request(app)
    .get(apiPath(`/@${ownerNs}/hello/versions/1.0.0/download`))
    .expect(200);
  await request(app)
    .get(apiPath(`/@${ownerNs}/hello/versions/1.0.0/download`))
    .expect(200);

  const readEvents = () => db.$queryRaw`
    SELECT "IpHash" FROM "DownloadEvents"
    WHERE "Namespace" = ${ownerNs} AND "ExtensionId" = 'hello'
    ORDER BY "Id"
  `;
  // The route records the event after it answers, so give the insert a moment.
  let events = await readEvents();
  for (let i = 0; i < 50 && events.length < 2; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    events = await readEvents();
  }
  assert.equal(events.length, 2);
  for (const event of events) {
    assert.ok(event.IpHash, 'the event still identifies the client');
    assert.ok(!event.IpHash.includes('127.0.0.1'), 'the raw loopback address is not stored');
    assert.equal(event.IpHash.length, 22);
  }
  assert.equal(events[0].IpHash, events[1].IpHash, 'the same client hashes the same way');

  // The hash still serves its purpose: one client, one distinct download.
  await aggregateDay(new Date());
  const [day] = await db.$queryRaw`
    SELECT "DistinctDownloads", "TotalDownloads" FROM "ExtensionDailyDownloads"
    WHERE "Namespace" = ${ownerNs} AND "ExtensionId" = 'hello' AND "Day" = CURRENT_DATE
  `;
  assert.equal(Number(day.TotalDownloads), 2);
  assert.equal(Number(day.DistinctDownloads), 1);
});
