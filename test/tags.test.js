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

async function makeOwnerWithVersions() {
  const adminNs = uniqNs();
  const ab = await signupAndAccept(app, adminNs);
  const ownerNs = uniqNs();
  const ob = await signupAndAccept(app, ownerNs);
  const outsiderNs = uniqNs();
  const outside = await signupAndAccept(app, outsiderNs);
  async function publish(version) {
    await publishProject(app, ownerNs, 'hello', ob.token, { version, code: `// v${version}` });
  }
  await publish('1.0.0');
  await request(app)
    .patch(`/v1/@${ownerNs}/hello/versions/1.0.0`)
    .set(bearer(ab.token))
    .send({ status: 'approved' })
    .expect(200);
  await publish('2.0.0');
  return { adminToken: ab.token, ownerToken: ob.token, ownerNs, outside: outside.token };
}

test('dist-tags point version resolution at a chosen published version', async () => {
  const { ownerToken, ownerNs } = await makeOwnerWithVersions();

  await request(app)
    .put(`/v1/@${ownerNs}/hello/tags/stable`)
    .set(bearer(ownerToken))
    .send({ version: '1.0.0' })
    .expect(204);
  await request(app)
    .put(`/v1/@${ownerNs}/hello/tags/next`)
    .set(bearer(ownerToken))
    .send({ version: '2.0.0' })
    .expect(204);

  const tags = await request(app).get(`/v1/@${ownerNs}/hello/tags`).expect(200);
  assert.deepEqual(tags.body, { next: '2.0.0', stable: '1.0.0' });

  const stable = await request(app).get(`/v1/@${ownerNs}/hello/versions/stable`).expect(200);
  assert.equal(stable.body.version, '1.0.0');
  const next = await request(app).get(`/v1/@${ownerNs}/hello/versions/next`).expect(200);
  assert.equal(next.body.version, '2.0.0');
  const dl = await request(app).get(`/v1/@${ownerNs}/hello/versions/stable/download`).expect(200);
  assert.match(dl.text, /v1\.0\.0/);
});

test('tags are versioned, movable, and removable, but never latest', async () => {
  const { adminToken, ownerToken, ownerNs, outside } = await makeOwnerWithVersions();

  await request(app)
    .put(`/v1/@${ownerNs}/hello/tags/stable`)
    .set(bearer(ownerToken))
    .send({ version: '1.0.0' })
    .expect(204);
  // move the tag forward
  await request(app)
    .put(`/v1/@${ownerNs}/hello/tags/stable`)
    .set(bearer(ownerToken))
    .send({ version: '2.0.0' })
    .expect(204);
  const stable = await request(app).get(`/v1/@${ownerNs}/hello/versions/stable`).expect(200);
  assert.equal(stable.body.version, '2.0.0');

  // cannot tag unpublished versions or use 'latest'
  await request(app)
    .put(`/v1/@${ownerNs}/hello/tags/never`)
    .set(bearer(ownerToken))
    .send({ version: '9.9.9' })
    .expect(404);
  await request(app)
    .put(`/v1/@${ownerNs}/hello/tags/latest`)
    .set(bearer(ownerToken))
    .send({ version: '1.0.0' })
    .expect(422);

  // only owners/admins may manage tags
  await request(app)
    .put(`/v1/@${ownerNs}/hello/tags/nope`)
    .set(bearer(outside))
    .send({ version: '1.0.0' })
    .expect(403);

  // an admin can move a tag too
  await request(app)
    .put(`/v1/@${ownerNs}/hello/tags/stable`)
    .set(bearer(adminToken))
    .send({ version: '1.0.0' })
    .expect(204);

  await request(app)
    .delete(`/v1/@${ownerNs}/hello/tags/stable`)
    .set(bearer(ownerToken))
    .expect(204);
  await request(app).get(`/v1/@${ownerNs}/hello/versions/stable`).expect(404);
  await request(app).get(`/v1/@${ownerNs}/hello/tags`).expect(404);
});
