import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {
  apiPath,
  bearer,
  ensureTestDatabase,
  makeConfig,
  publishProject,
  signupAndAccept,
  uniqNs,
} from './helpers.mjs';
import { createApp } from '../src/app.js';
import { createDb, ensureDataDirs } from '../src/db.js';

// Separate app instances: the shared boot() cache is built once per process,
// and these tests need their own tiny rate-limit config to be exercisable.
let db;
let looseApp;
let tightApp;
let coarseApp;
let coarseTelemetry;

function makeRateConfig(overrides = {}) {
  // makeConfig deep-merges, so the nulls switch off exactly these three
  // buckets and every other key stays at its default. The signup bucket is
  // opened up because these tests need several accounts and the signup
  // window is not what they are about.
  return makeConfig({
    rateLimits: {
      publishPerWindow: null,
      downloadsPerIpPerWindow: null,
      reportsPerWindow: null,
      signupsPerIpPerWindow: 10_000,
      ...overrides,
    },
  });
}

before(async () => {
  // This file builds its own app instances instead of calling boot(), so it
  // creates its per-process database clone itself.
  await ensureTestDatabase();
  // One shared database and dataDir; the apps differ only in rate limits.
  const loose = makeRateConfig();
  const tight = makeRateConfig({
    publishPerWindow: 2,
    downloadsPerIpPerWindow: 1,
    reportsPerWindow: 2,
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
  db = createDb(loose);
  ensureDataDirs(loose.dataDir);
  looseApp = createApp({ config: loose, db }).app;
  tightApp = createApp({ config: tight, db }).app;
  const built = createApp({ config: coarse, db });
  coarseApp = built.app;
  coarseTelemetry = built.telemetry;
});

beforeEach(async () => {
  // Shared database, so clear the rows both app instances see.
  await db.$executeRawUnsafe(`
    TRUNCATE TABLE "AutomationTokens", "Sessions", "Versions", "RateLimitEntries", "Notifications",
    "Users", "LegalDocuments", "DownloadEvents", "ExtensionDailyDownloads", "ExtensionVersionDailyDownloads", "DistTags",
    "WebhookDeliveries", "Webhooks"
    RESTART IDENTITY CASCADE
  `);
  await db.$executeRaw`
    INSERT INTO "LegalDocuments" ("Kind", "Version", "Body")
    VALUES ('terms', 1, 'Placeholder terms.'), ('privacy', 1, 'Placeholder privacy.')
  `;
});

after(async () => {
  await db?.$disconnect();
});

test('the publish bucket is counted per account and rejects past the cap', async () => {
  const owner = await signupAndAccept(tightApp, uniqNs());
  const ns = owner.user.namespace;

  // An empty body fails validation with 415, but the bucket still counts it:
  // the server did the work.
  const publish = () =>
    request(tightApp)
      .post(apiPath(`/@${ns}/widget/versions`))
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
    .post(apiPath(`/@${peer.user.namespace}/widget/versions`))
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
    .patch(apiPath(`/@${ns}/hello/versions/1.0.0`))
    .set(bearer(admin.token))
    .send({ status: 'approved' })
    .expect(200);

  await request(tightApp)
    .get(apiPath(`/@${ns}/hello/versions/1.0.0/download`))
    .expect(200);
  const second = await request(tightApp).get(apiPath(`/@${ns}/hello/versions/1.0.0/download`));
  assert.equal(second.status, 429);

  // With the bucket disabled, repeated hits sail through and nothing is counted:
  // a null limit has to beat the 240-per-window default to be meaningful.
  await db.$executeRaw`DELETE FROM "RateLimitEntries" WHERE "Bucket" LIKE 'download:%'`;
  for (let i = 0; i < 3; i += 1) {
    await request(looseApp)
      .get(apiPath(`/@${ns}/hello/versions/1.0.0/download`))
      .expect(200);
  }
  const disabled = await db.$queryRaw`
    SELECT 1 FROM "RateLimitEntries" WHERE "Bucket" LIKE 'download:%'
  `;
  assert.equal(disabled.length, 0, 'a null download limit records no bucket');
});

test('the report bucket is per reporter, and a null limit disables it', async () => {
  const reporter = await signupAndAccept(tightApp, uniqNs());
  const target = await signupAndAccept(tightApp, uniqNs());
  const report = (app) =>
    request(app).post(apiPath('/reports')).set(bearer(reporter.token)).send({
      targetType: 'user',
      targetNamespace: target.user.namespace,
      reason: 'spam',
      description: 'This account is sending spam.',
    });

  await report(tightApp).expect(201);
  // The same target twice is a 409, but it still counts: the server did the
  // work either way.
  await report(tightApp).expect(409);
  const third = await report(tightApp);
  assert.equal(third.status, 429);
  assert.ok(third.headers['retry-after'], 'a Retry-After rides the 429');

  // A different reporter has its own bucket.
  const peer = await signupAndAccept(tightApp, uniqNs());
  await request(tightApp)
    .post(apiPath('/reports'))
    .set(bearer(peer.token))
    .send({
      targetType: 'user',
      targetNamespace: target.user.namespace,
      reason: 'spam',
      description: 'This account is sending spam.',
    })
    .expect(201);

  // With the bucket disabled, reports keep landing and nothing is counted. The
  // targets are different accounts, so each one is a filing rather than a
  // duplicate of the report above.
  await db.$executeRaw`DELETE FROM "RateLimitEntries" WHERE "Bucket" LIKE 'report:%'`;
  const others = [];
  for (let i = 0; i < 3; i += 1) others.push(await signupAndAccept(tightApp, uniqNs()));
  for (const other of others) {
    await request(looseApp)
      .post(apiPath('/reports'))
      .set(bearer(reporter.token))
      .send({
        targetType: 'user',
        targetNamespace: other.user.namespace,
        reason: 'spam',
        description: 'This account is sending spam.',
      })
      .expect(201);
  }
  const disabled = await db.$queryRaw`
    SELECT 1 FROM "RateLimitEntries" WHERE "Bucket" LIKE 'report:%'
  `;
  assert.equal(disabled.length, 0, 'a null report limit records no bucket');
});

test('signup and login limits still work alongside the new buckets', async () => {
  const ns = uniqNs();
  for (let i = 0; i < 5; i += 1) {
    await request(tightApp)
      .post(apiPath('/sessions'))
      .send({ namespace: ns, password: 'wrong-pass' });
  }
  const sixth = await request(tightApp)
    .post(apiPath('/sessions'))
    .send({ namespace: ns, password: 'wrong-pass' });
  assert.equal(sixth.status, 429);
});

test('the coarse limiter is mounted behind the request telemetry', async () => {
  const forwarded = { 'X-Forwarded-For': '203.0.113.7' };
  await request(coarseApp).get(apiPath('/meta')).set(forwarded).expect(200);
  await request(coarseApp).get(apiPath('/meta')).set(forwarded).expect(200);
  await request(coarseApp).get(apiPath('/meta')).set(forwarded).expect(429);

  const counters = coarseTelemetry.render().join('\n');
  assert.ok(counters.includes('status="429"'), 'the 429 is missing from the counters');
});
