import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { boot, resetDb, bearer, uniqNs, signupAndAccept, FIXTURE_PASSWORD } from './helpers.mjs';

let app;
before(async () => {
  ({ app } = await boot());
});
beforeEach(resetDb);
after(async () => {
  await (await boot()).sql.end();
});

test('sessions lists only the current session for a user', async () => {
  const { user, token } = await signupAndAccept(app, uniqNs());
  const ns = user.namespace;

  const list = await request(app).get('/v1/sessions').set(bearer(token)).expect(200);
  assert.equal(list.body.data.length, 1);
  assert.equal(list.body.data[0].id, String(1));
  assert.equal(typeof list.body.data[0].createdAt, 'string');
  assert.equal(typeof list.body.data[0].expiresAt, 'string');

  // a second session appears for the same user
  const r = await request(app)
    .post('/v1/sessions')
    .send({ namespace: ns, password: FIXTURE_PASSWORD })
    .expect(201);
  const secondToken = r.body.token;

  const again = await request(app).get('/v1/sessions').set(bearer(secondToken)).expect(200);
  assert.equal(again.body.data.length, 2);
});

test('deleting a session revokes it', async () => {
  const { user, token } = await signupAndAccept(app, uniqNs());
  const ns = user.namespace;

  const login = await request(app)
    .post('/v1/sessions')
    .send({ namespace: ns, password: FIXTURE_PASSWORD })
    .expect(201);
  const secondToken = login.body.token;

  const list = await request(app).get('/v1/sessions').set(bearer(token)).expect(200);
  assert.equal(list.body.data.length, 2);

  const otherId = list.body.data.find((s) => s.id !== String(1)).id;
  await request(app).delete(`/v1/sessions/${otherId}`).set(bearer(token)).expect(204);

  const after = await request(app).get('/v1/sessions').set(bearer(token)).expect(200);
  assert.equal(after.body.data.length, 1);

  await request(app).get('/v1/me').set(bearer(secondToken)).expect(401);
});

test('listing sessions needs the manage:sessions scope', async () => {
  const { token } = await signupAndAccept(app, uniqNs());
  const created = await request(app)
    .post('/v1/tokens')
    .set(bearer(token))
    .send({ name: 'auto', scopes: ['publish'] })
    .expect(201);

  const r = await request(app).get('/v1/sessions').set(bearer(created.body.token)).expect(403);
  assert.match(r.body.detail, /missing the required "manage:sessions" scope/);

  const granted = await request(app)
    .post('/v1/tokens')
    .set(bearer(token))
    .send({ name: 'sessionbot', scopes: ['manage:sessions'] })
    .expect(201);
  const list = await request(app).get('/v1/sessions').set(bearer(granted.body.token)).expect(200);
  assert.equal(list.body.data.length, 1);
});

test('admin can inspect another account sessions', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const { user: other } = await signupAndAccept(app, uniqNs());

  const list = await request(app)
    .get(`/v1/sessions?namespace=${other.namespace}`)
    .set(bearer(admin.token))
    .expect(200);
  assert.equal(list.body.data.length, 1);
  assert.equal(typeof list.body.data[0].id, 'string');
});

test('non-admin cannot inspect another account sessions', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const { token } = await signupAndAccept(app, uniqNs());

  const r = await request(app)
    .get(`/v1/sessions?namespace=${admin.user.namespace}`)
    .set(bearer(token))
    .expect(403);
  assert.match(r.body.detail, /Only an admin/i);
});
