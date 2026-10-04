import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {
  boot,
  resetDb,
  bearer,
  uniqNs,
  acceptTerms,
  signupAndAccept,
  publishProject,
} from './helpers.mjs';

let app;
let sql;
before(async () => {
  ({ app, sql } = await boot());
});
beforeEach(resetDb);
after(async () => {
  await sql.end();
});

test('admin can update terms and privacy; version bumps', async () => {
  const admin = await signupAndAccept(app, uniqNs());

  const terms = await request(app)
    .patch('/v1/admin/terms')
    .set(bearer(admin.token))
    .send({ body: 'New terms v2.' })
    .expect(200);
  assert.equal(terms.body.version, 2);
  assert.equal(terms.body.body, 'New terms v2.');

  await acceptTerms(app, admin.user.namespace, admin.token);

  const privacy = await request(app)
    .patch('/v1/admin/privacy')
    .set(bearer(admin.token))
    .send({ body: 'New privacy v2.' })
    .expect(200);
  assert.equal(privacy.body.version, 2);

  const pub = await request(app).get('/v1/terms').expect(200);
  assert.equal(pub.body.version, 2);
});

test('bumping terms forces re-acceptance for other users', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const { user: owner, token } = await signupAndAccept(app, uniqNs());
  const ns = owner.namespace;

  await request(app)
    .patch('/v1/admin/terms')
    .set(bearer(admin.token))
    .send({ body: 'Terms v2.' })
    .expect(200);

  const pub = await publishProject(app, ns, 'aaa', token, {}, 403);
  assert.equal(pub.status, 403);
  assert.match(pub.body.detail, /Terms/i);

  await acceptTerms(app, ns, token);
  const after = await publishProject(app, ns, 'aaa', token);
  assert.equal(after.body.status, 'pending');
});

test('non-admin cannot update legal documents', async () => {
  const _admin = await signupAndAccept(app, uniqNs());
  const { token } = await signupAndAccept(app, uniqNs());

  const r = await request(app).patch('/v1/admin/terms').set(bearer(token)).send({ body: 'Nope.' });
  assert.equal(r.status, 403);
});
