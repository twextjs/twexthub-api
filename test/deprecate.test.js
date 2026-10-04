import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { boot, resetDb, bearer, uniqNs, signupAndAccept, publishProject } from './helpers.mjs';

let app;
before(async () => {
  ({ app } = await boot());
});
beforeEach(resetDb);
after(async () => {
  await (await boot()).sql.end();
});

function publish(ns, token, version) {
  return publishProject(app, ns, 'hello', token, { version, code: `// v${version}` });
}

function approve(adminToken, ns, version) {
  return request(app)
    .patch(`/v1/@${ns}/hello/versions/${version}`)
    .set(bearer(adminToken))
    .send({ status: 'approved' })
    .expect(200);
}

async function makeAdminAndOwner() {
  const adminNs = uniqNs();
  const ab = await signupAndAccept(app, adminNs);
  const ownerNs = uniqNs();
  const ob = await signupAndAccept(app, ownerNs);
  return { adminToken: ab.token, ownerToken: ob.token, adminNs, ownerNs };
}

test('deprecating flags a version but keeps it listable and downloadable', async () => {
  const { adminToken, ownerToken, ownerNs } = await makeAdminAndOwner();
  // first publish is pending; approve to unlock auto-publish
  await publish(ownerNs, ownerToken, '1.0.0');
  await approve(adminToken, ownerNs, '1.0.0');
  await publish(ownerNs, ownerToken, '2.0.0');

  const upgrade = await request(app)
    .patch(`/v1/@${ownerNs}/hello/versions/2.0.0`)
    .set(bearer(ownerToken))
    .send({ deprecationMessage: 'Use the rewritten API surface.' })
    .expect(200);
  assert.equal(upgrade.body.status, 'deprecated');
  assert.equal(upgrade.body.deprecation, 'Use the rewritten API surface.');

  // latest falls back to the highest non-deprecated version
  const latest = await request(app).get(`/v1/@${ownerNs}/hello/versions/latest`).expect(200);
  assert.equal(latest.body.version, '1.0.0');

  // the deprecated blob stays downloadable
  const dl = await request(app).get(`/v1/@${ownerNs}/hello/versions/2.0.0/download`).expect(200);
  assert.match(dl.text, /v2\.0\.0/);

  // deprecated entries stay in version metadata with the message
  const version = await request(app).get(`/v1/@${ownerNs}/hello/versions/2.0.0`).expect(200);
  assert.equal(version.body.deprecation, 'Use the rewritten API surface.');

  // the extension is still listed
  const list = await request(app).get('/v1/extensions').expect(200);
  const entry = list.body.data.find((e) => e.namespace === ownerNs);
  assert.ok(entry);
  assert.equal(entry.version, '1.0.0');

  // clearing the deprecation restores published state
  const cleared = await request(app)
    .patch(`/v1/@${ownerNs}/hello/versions/2.0.0`)
    .set(bearer(ownerToken))
    .send({ deprecationMessage: null })
    .expect(200);
  assert.equal(cleared.body.status, 'published');
  assert.ok(!('deprecation' in cleared.body));
  const latestAfter = await request(app).get(`/v1/@${ownerNs}/hello/versions/latest`).expect(200);
  assert.equal(latestAfter.body.version, '2.0.0');
});

test('non-owners cannot deprecate; admin can', async () => {
  const { adminToken, ownerToken, ownerNs } = await makeAdminAndOwner();
  const outsiderNs = uniqNs();
  const outside = await signupAndAccept(app, outsiderNs);

  await publish(ownerNs, ownerToken, '1.0.0');
  await approve(adminToken, ownerNs, '1.0.0');
  await publish(ownerNs, ownerToken, '2.0.0');

  const denied = await request(app)
    .patch(`/v1/@${ownerNs}/hello/versions/2.0.0`)
    .set(bearer(outside.token))
    .send({ deprecationMessage: 'no' });
  assert.equal(denied.status, 403);

  const asAdmin = await request(app)
    .patch(`/v1/@${ownerNs}/hello/versions/2.0.0`)
    .set(bearer(adminToken))
    .send({ deprecationMessage: 'Admin says so.' })
    .expect(200);
  assert.equal(asAdmin.body.status, 'deprecated');
});

test('the version PATCH refuses an ambiguous or empty body', async () => {
  const { adminToken, ownerToken, ownerNs } = await makeAdminAndOwner();
  await publish(ownerNs, ownerToken, '1.0.0');
  await approve(adminToken, ownerNs, '1.0.0');

  const both = await request(app)
    .patch(`/v1/@${ownerNs}/hello/versions/1.0.0`)
    .set(bearer(adminToken))
    .send({ status: 'approved', deprecationMessage: 'no longer current' });
  assert.equal(both.status, 422);
  assert.equal(both.body.errors[0].field, 'status');

  const neither = await request(app)
    .patch(`/v1/@${ownerNs}/hello/versions/1.0.0`)
    .set(bearer(adminToken))
    .send({});
  assert.equal(neither.status, 422);

  const blank = await request(app)
    .patch(`/v1/@${ownerNs}/hello/versions/1.0.0`)
    .set(bearer(ownerToken))
    .send({ deprecationMessage: '   ' });
  assert.equal(blank.status, 422);
  assert.equal(blank.body.errors[0].field, 'deprecationMessage');
});
