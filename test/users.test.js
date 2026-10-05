import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
import {
  FIXTURE_PASSWORD,
  apiPath,
  bearer,
  boot,
  publishProject,
  resetDb,
  signupAndAccept,
  uniqNs,
} from './helpers.mjs';
import { blobPathFor } from '../src/blobs.js';

let app;
let sql;
let config;
before(async () => {
  ({ app, sql, config } = await boot());
});
beforeEach(resetDb);
after(async () => {
  await sql.end();
});

test('users list is public and includes created users', async () => {
  const first = await signupAndAccept(app, uniqNs());
  const second = await signupAndAccept(app, uniqNs());

  const list = await request(app).get(apiPath('/users')).expect(200);
  const namespaces = list.body.data.map((u) => u.namespace);
  assert.ok(namespaces.includes(first.user.namespace));
  assert.ok(namespaces.includes(second.user.namespace));
  const firstUser = list.body.data.find((u) => u.namespace === first.user.namespace);
  assert.equal('role' in firstUser, false);
  assert.equal('termsAcceptedVersion' in firstUser, false);
  assert.equal(typeof firstUser.hasPublished, 'boolean');

  const mine = await request(app).get(apiPath('/users')).set(bearer(first.token)).expect(200);
  const me = mine.body.data.find((u) => u.namespace === first.user.namespace);
  assert.equal(me.role, 'admin');
});

test('user lookup by namespace returns profile', async () => {
  const { user } = await signupAndAccept(app, uniqNs());
  const r = await request(app)
    .get(apiPath(`/users/${user.namespace}`))
    .expect(200);
  assert.equal(r.body.namespace, user.namespace);
  assert.equal(r.body.hasPublished, false);
});

test('owner can update their own displayName', async () => {
  const { user, token } = await signupAndAccept(app, uniqNs());
  const r = await request(app)
    .patch(apiPath(`/users/${user.namespace}`))
    .set(bearer(token))
    .send({ displayName: 'Fresh Handle' })
    .expect(200);
  assert.equal(r.body.displayName, 'Fresh Handle');
});

test('changing password revokes existing sessions and tokens', async () => {
  const { user, token } = await signupAndAccept(app, uniqNs());
  const ns = user.namespace;

  const created = await request(app)
    .post(apiPath('/tokens'))
    .set(bearer(token))
    .send({ name: 'ci', scopes: ['publish'] })
    .expect(201);

  await request(app)
    .patch(apiPath(`/users/${ns}`))
    .set(bearer(token))
    .send({ password: 'newpassword9', currentPassword: FIXTURE_PASSWORD })
    .expect(200);

  await request(app).get(apiPath('/me')).set(bearer(token)).expect(401);
  await request(app).get(apiPath('/tokens')).set(bearer(created.body.token)).expect(401);

  const login = await request(app)
    .post(apiPath('/sessions'))
    .send({ namespace: ns, password: 'newpassword9' })
    .expect(201);
  assert.ok(login.body.token);
});

test('password rotation bypasses terms re-acceptance', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const { user, token } = await signupAndAccept(app, uniqNs());

  await request(app)
    .patch(apiPath('/admin/terms'))
    .set(bearer(admin.token))
    .send({ body: 'Terms v2.' })
    .expect(200);

  const r = await request(app)
    .patch(apiPath(`/users/${user.namespace}`))
    .set(bearer(token))
    .send({ password: 'newpassword9', currentPassword: FIXTURE_PASSWORD });
  assert.equal(r.status, 200);

  const login = await request(app)
    .post(apiPath('/sessions'))
    .send({ namespace: user.namespace, password: 'newpassword9' })
    .expect(201);
  assert.ok(login.body.token);
});

test('account deletion bypasses terms re-acceptance', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const { user, token } = await signupAndAccept(app, uniqNs());

  await request(app)
    .patch(apiPath('/admin/terms'))
    .set(bearer(admin.token))
    .send({ body: 'Terms v2.' })
    .expect(200);

  await request(app)
    .delete(apiPath(`/users/${user.namespace}`))
    .set(bearer(token))
    .expect(204);
  await request(app)
    .get(apiPath(`/users/${user.namespace}`))
    .expect(404);
});

test('account deletion still removes sources when blob cleanup fails', async () => {
  await signupAndAccept(app, uniqNs());
  const owner = await signupAndAccept(app, uniqNs());
  const ns = owner.user.namespace;
  await publishProject(app, ns, 'cleanup', owner.token);
  const [version] = await sql`
    SELECT blob_digest, source_path FROM versions
    WHERE namespace = ${ns} AND extension_id = 'cleanup'
  `;
  const blobPath = blobPathFor(config.dataDir, version.blob_digest);
  const sourcePath = path.join(config.dataDir, version.source_path);
  await fs.rm(blobPath);
  await fs.mkdir(blobPath);
  const errors = [];
  const originalError = console.error;
  console.error = (message) => errors.push(message);
  try {
    await request(app)
      .delete(apiPath(`/users/${ns}`))
      .set(bearer(owner.token))
      .expect(204);
  } finally {
    console.error = originalError;
    await fs.rm(blobPath, { recursive: true, force: true });
  }
  assert.ok(errors.some((message) => message.includes(`blob cleanup deferred for ${ns}`)));
  await assert.rejects(fs.stat(sourcePath), { code: 'ENOENT' });
});

test('non-owner cannot update another user', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const { token } = await signupAndAccept(app, uniqNs());

  const r = await request(app)
    .patch(apiPath(`/users/${admin.user.namespace}`))
    .set(bearer(token))
    .send({ displayName: 'Nope' });
  assert.equal(r.status, 403);
});

test('only admin can change a role', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const { user: other, token } = await signupAndAccept(app, uniqNs());

  const denied = await request(app)
    .patch(apiPath(`/users/${other.namespace}`))
    .set(bearer(token))
    .send({ role: 'admin' });
  assert.equal(denied.status, 403);

  const granted = await request(app)
    .patch(apiPath(`/users/${other.namespace}`))
    .set(bearer(admin.token))
    .send({ role: 'admin' })
    .expect(200);
  assert.equal(granted.body.role, 'admin');
});

test('manage:account alone does not reach another account, admin scope does', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const { user: other } = await signupAndAccept(app, uniqNs());

  const scoped = await request(app)
    .post(apiPath('/tokens'))
    .set(bearer(admin.token))
    .send({ name: 'selfcare', scopes: ['manage:account'] })
    .expect(201);
  const selfOnly = scoped.body.token;

  // Its own account is the point of the scope, and it keeps working.
  await request(app)
    .patch(apiPath(`/users/${admin.user.namespace}`))
    .set(bearer(selfOnly))
    .send({ bio: 'set by a token' })
    .expect(200);

  // Another account is an administrative act, which the scope alone does not cover.
  const crossAccount = await request(app)
    .patch(apiPath(`/users/${other.namespace}`))
    .set(bearer(selfOnly))
    .send({ displayName: 'Nope' });
  assert.equal(crossAccount.status, 403);

  // A role change is the sharpest edge of that, so it is checked on its own.
  const promote = await request(app)
    .patch(apiPath(`/users/${other.namespace}`))
    .set(bearer(selfOnly))
    .send({ role: 'admin' });
  assert.equal(promote.status, 403);

  const removal = await request(app)
    .delete(apiPath(`/users/${other.namespace}`))
    .set(bearer(selfOnly));
  assert.equal(removal.status, 403);

  // With the admin scope as well, the same account reaches all three.
  const full = await request(app)
    .post(apiPath('/tokens'))
    .set(bearer(admin.token))
    .send({ name: 'ops', scopes: ['manage:account', 'admin'] })
    .expect(201);
  const ops = full.body.token;

  await request(app)
    .patch(apiPath(`/users/${other.namespace}`))
    .set(bearer(ops))
    .send({ displayName: 'Renamed' })
    .expect(200);
  const promoted = await request(app)
    .patch(apiPath(`/users/${other.namespace}`))
    .set(bearer(ops))
    .send({ role: 'admin' })
    .expect(200);
  assert.equal(promoted.body.role, 'admin');
  await request(app)
    .delete(apiPath(`/users/${other.namespace}`))
    .set(bearer(ops))
    .expect(204);
});

test('an unreviewed version needs the admin scope, not just the role', async () => {
  const ab = await signupAndAccept(app, uniqNs());
  assert.equal(ab.user.role, 'admin');
  const { user, token } = await signupAndAccept(app, uniqNs());
  await publishProject(app, user.namespace, 'hello', token);

  // The owner always sees their own pending version.
  await request(app)
    .get(apiPath(`/@${user.namespace}/hello/versions/1.0.0`))
    .set(bearer(token))
    .expect(200);

  const unscoped = await request(app)
    .post(apiPath('/tokens'))
    .set(bearer(ab.token))
    .send({ name: 'curious', scopes: ['publish'] })
    .expect(201);
  const denied = await request(app).get(apiPath(`/@${user.namespace}/hello/versions/1.0.0`));
  assert.equal(denied.status, 404, 'an unauthenticated caller cannot see it either');
  const viaToken = await request(app)
    .get(apiPath(`/@${user.namespace}/hello/versions/1.0.0`))
    .set(bearer(unscoped.body.token));
  assert.equal(viaToken.status, 404);

  const scoped = await request(app)
    .post(apiPath('/tokens'))
    .set(bearer(ab.token))
    .send({ name: 'reviewer', scopes: ['admin'] })
    .expect(201);
  await request(app)
    .get(apiPath(`/@${user.namespace}/hello/versions/1.0.0`))
    .set(bearer(scoped.body.token))
    .expect(200);
});
