import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { makeConfig, bearer, uniqNs, signupAndAccept, publishProject } from './helpers.mjs';
import { createApp } from '../src/app.js';
import { createDb, ensureDataDirs } from '../src/db.js';

// Separate app instances: the shared boot() cache is built once per process,
// and these tests need their own tiny rate-limit config to be exercisable.
let sql;
let looseApp;
let tightApp;
let coarseApp;
let coarseTelemetry;

function makeRateConfig(overrides = {}) {
  // makeConfig deep-merges, so the nulls switch off exactly these two buckets
  // and every other key stays at its default.
  return makeConfig({
    rateLimits: {
      publishPerWindow: null,
      downloadsPerIpPerWindow: null,
      ...overrides,
    },
  });
}

before(async () => {
  // One shared database and dataDir; the apps differ only in rate limits.
  const loose = makeRateConfig();
  const tight = makeRateConfig({
    publishPerWindow: 2,
    downloadsPerIpPerWindow: 1,
  });
  // The coarse limiter keys on req.ip and skips loopback, so this one counts a
  // forwarded address.
  const coarse = makeRateConfig({
    routeWindowMinutes: 60,
    routesPerIpPerWindow: 2,
  });
  coarse.trustProxy = true;
  tight.dataDir = loose.dataDir;
  coarse.dataDir = loose.dataDir;
  sql = createDb(loose);
  ensureDataDirs(loose.dataDir);
  looseApp = createApp({ config: loose, sql }).app;
  tightApp = createApp({ config: tight, sql }).app;
  const built = createApp({ config: coarse, sql });
  coarseApp = built.app;
  coarseTelemetry = built.telemetry;
});

beforeEach(async () => {
  // Shared database, so clear the rows both app instances see.
  await sql.unsafe(`
    TRUNCATE TABLE automation_tokens, sessions, versions, rate_limit_entries, notifications,
    users, legal_documents, download_events, extension_daily_downloads, dist_tags,
    webhook_deliveries, webhooks
    RESTART IDENTITY CASCADE
  `);
  await sql`
    INSERT INTO legal_documents (kind, version, body)
    VALUES ('terms', 1, 'Placeholder terms.'), ('privacy', 1, 'Placeholder privacy.')
  `;
});

after(async () => {
  await sql?.end();
});

test('the publish bucket is counted per account and rejects past the cap', async () => {
  const owner = await signupAndAccept(tightApp, uniqNs());
  const ns = owner.user.namespace;

  // An empty body fails validation with 415, but the bucket still counts it:
  // the server did the work.
  const publish = () =>
    request(tightApp)
      .post(`/v1/@${ns}/widget/versions`)
      .set(bearer(owner.token))
      .set('Content-Type', 'application/gzip')
      .send(Buffer.alloc(0));

  await publish().expect(415);
  await publish().expect(415);
  const third = await publish();
  assert.equal(third.status, 429);
  assert.ok(third.headers['retry-after'], 'a Retry-After rides the 429');

  // A different account has its own bucket.
  const peer = await signupAndAccept(tightApp, uniqNs());
  await request(tightApp)
    .post(`/v1/@${peer.user.namespace}/widget/versions`)
    .set(bearer(peer.token))
    .set('Content-Type', 'application/gzip')
    .send(Buffer.alloc(0))
    .expect(415);
});

test('the download bucket is per IP, keyed on real paths, and a null limit disables it', async () => {
  const admin = await signupAndAccept(tightApp, uniqNs());
  const owner = await signupAndAccept(tightApp, uniqNs());
  const ns = owner.user.namespace;
  await publishProject(tightApp, ns, 'hello', owner.token, { code: '// dl' });
  await request(tightApp)
    .patch(`/v1/@${ns}/hello/versions/1.0.0`)
    .set(bearer(admin.token))
    .send({ status: 'approved' })
    .expect(200);

  await request(tightApp).get(`/v1/@${ns}/hello/versions/1.0.0/download`).expect(200);
  const second = await request(tightApp).get(`/v1/@${ns}/hello/versions/1.0.0/download`);
  assert.equal(second.status, 429);

  // With the bucket disabled, repeated hits sail through and nothing is counted:
  // a null limit has to beat the 240-per-window default to be meaningful.
  await sql`DELETE FROM rate_limit_entries WHERE bucket LIKE 'download:%'`;
  for (let i = 0; i < 3; i += 1) {
    await request(looseApp).get(`/v1/@${ns}/hello/versions/1.0.0/download`).expect(200);
  }
  const disabled = await sql`
    SELECT 1 FROM rate_limit_entries WHERE bucket LIKE 'download:%'
  `;
  assert.equal(disabled.length, 0, 'a null download limit records no bucket');
});

test('signup and login limits still work alongside the new buckets', async () => {
  const ns = uniqNs();
  for (let i = 0; i < 5; i += 1) {
    await request(tightApp).post('/v1/sessions').send({ namespace: ns, password: 'wrong-pass' });
  }
  const sixth = await request(tightApp)
    .post('/v1/sessions')
    .send({ namespace: ns, password: 'wrong-pass' });
  assert.equal(sixth.status, 429);
});

test('the coarse limiter is mounted behind the request telemetry', async () => {
  const forwarded = { 'X-Forwarded-For': '203.0.113.7' };
  await request(coarseApp).get('/v1/meta').set(forwarded).expect(200);
  await request(coarseApp).get('/v1/meta').set(forwarded).expect(200);
  await request(coarseApp).get('/v1/meta').set(forwarded).expect(429);

  const counters = coarseTelemetry.render().join('\n');
  assert.ok(counters.includes('status="429"'), 'the 429 is missing from the counters');
});
