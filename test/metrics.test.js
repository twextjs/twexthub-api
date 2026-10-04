import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { boot, resetDb, bearer, uniqNs, signupAndAccept, publishProject } from './helpers.mjs';
import { aggregateDayLoader } from '../src/metrics.js';

let app;
let sql;
let aggregateDay;
before(async () => {
  ({ app, sql } = await boot());
  aggregateDay = aggregateDayLoader(sql);
});
beforeEach(resetDb);
after(async () => {
  await sql.end();
});

async function publishAs(ns, nsToken, adminToken, id, version, code) {
  await publishProject(app, ns, id, nsToken, { version, code });
  await request(app)
    .patch(`/v1/@${ns}/${id}/versions/${version}`)
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

  await request(app).get(`/v1/@${ownerNs}/hello/versions/latest/download`).expect(200);
  await request(app).get(`/v1/@${ownerNs}/hello/versions/latest/download`).expect(200);

  await sql.unsafe(`
    INSERT INTO download_events (namespace, extension_id, version, user_agent, ip_hash, created_at)
    SELECT e.namespace, e.extension_id, '1.0.0', 'x', '10.0.0.1',
           now() - INTERVAL '3 days'
    FROM versions e
    WHERE e.extension_id = 'widget'
    UNION ALL
    SELECT e.namespace, e.extension_id, '2.0.0', 'y', '10.0.0.2',
           now() - INTERVAL '8 days'
    FROM versions e
    WHERE e.extension_id = 'gizmo'
  `);
  for (const days of [3, 8]) {
    await aggregateDay(new Date(Date.now() - days * 86400000));
  }

  // the published extension's daily bucket only counts aggregations run so far
  await aggregateDay(new Date());
  const [bucket] = await sql`
    SELECT * FROM extension_daily_downloads
    WHERE namespace = ${ownerNs} AND extension_id = 'hello'
  `;
  assert.ok(Number(bucket.total_downloads) >= 2);

  const detail = await request(app).get(`/v1/@${ownerNs}/hello`).expect(200);
  assert.ok(Number(detail.body.downloads) >= 2);

  // widget (3 days ago) makes trending; gizmo (8 days) does not
  const trending = await request(app).get('/v1/extensions/trending').expect(200);
  const entries = trending.body.data.map((e) => `${e.namespace}/${e.id}`);
  const trendingId = (id) => entries.find((key) => key.endsWith('/' + id));
  assert.ok(trendingId('widget'), `widget missing from ${entries.join(', ')}`);
  assert.ok(!trendingId('gizmo'), 'gizmo should not trend');

  const stats = await request(app).get('/v1/stats').expect(200);
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
  await sql`
    INSERT INTO download_events (namespace, extension_id, version, user_agent, created_at)
    VALUES (${ownerNs}, 'recent', '1.0.0', 'recent', ${sixDaysAgo.toISOString()}),
           (${ownerNs}, 'old', '1.0.0', 'old', ${sevenDaysAgo.toISOString()})
  `;
  await aggregateDay(sixDaysAgo);
  await aggregateDay(sevenDaysAgo);

  const trending = await request(app).get('/v1/extensions/trending').expect(200);
  const ids = trending.body.data.map((entry) => entry.id);
  assert.ok(ids.includes('recent'));
  assert.ok(!ids.includes('old'));
});

test('trending selects a deprecated version when a newer version was yanked', async () => {
  const { ownerNs, ownerToken } = await makePublished();
  await publishProject(app, ownerNs, 'hello', ownerToken, { version: '2.0.0' });
  await sql`
    UPDATE versions SET status = 'deprecated'
    WHERE namespace = ${ownerNs} AND extension_id = 'hello' AND version = '1.0.0'
  `;
  await sql`
    UPDATE versions SET status = 'yanked'
    WHERE namespace = ${ownerNs} AND extension_id = 'hello' AND version = '2.0.0'
  `;
  await sql`
    INSERT INTO extension_daily_downloads (namespace, extension_id, day, total_downloads)
    VALUES (${ownerNs}, 'hello', CURRENT_DATE, 3)
  `;

  const trending = await request(app).get('/v1/extensions/trending').expect(200);
  assert.equal(trending.body.data.length, 1);
  assert.equal(trending.body.data[0].version, '1.0.0');
});

test('a download records a keyed hash of the address, never the address', async () => {
  const { ownerNs } = await makePublished();
  await request(app).get(`/v1/@${ownerNs}/hello/versions/1.0.0/download`).expect(200);
  await request(app).get(`/v1/@${ownerNs}/hello/versions/1.0.0/download`).expect(200);

  const readEvents = () => sql`
    SELECT ip_hash FROM download_events
    WHERE namespace = ${ownerNs} AND extension_id = 'hello'
    ORDER BY id
  `;
  // The route records the event after it answers, so give the insert a moment.
  let events = await readEvents();
  for (let i = 0; i < 50 && events.length < 2; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    events = await readEvents();
  }
  assert.equal(events.length, 2);
  for (const event of events) {
    assert.ok(event.ip_hash, 'the event still identifies the client');
    assert.ok(!event.ip_hash.includes('127.0.0.1'), 'the raw loopback address is not stored');
    assert.equal(event.ip_hash.length, 22);
  }
  assert.equal(events[0].ip_hash, events[1].ip_hash, 'the same client hashes the same way');

  // The hash still serves its purpose: one client, one distinct download.
  await aggregateDay(new Date());
  const [day] = await sql`
    SELECT distinct_downloads, total_downloads FROM extension_daily_downloads
    WHERE namespace = ${ownerNs} AND extension_id = 'hello' AND day = CURRENT_DATE
  `;
  assert.equal(Number(day.total_downloads), 2);
  assert.equal(Number(day.distinct_downloads), 1);
});
