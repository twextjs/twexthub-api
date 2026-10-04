import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {
  boot,
  resetDb,
  bearer,
  uniqNs,
  signup,
  signupAccept,
  acceptTerms,
  FIXTURE_PASSWORD,
} from './helpers.mjs';

let app;
before(async () => {
  ({ app } = await boot());
});
beforeEach(resetDb);
after(async () => {
  await (await boot()).sql.end();
});

test('signing in creates a session, with its location and its own id', async () => {
  const ns = uniqNs();
  const password = 'password123';
  await request(app).post('/v1/users').send({ namespace: ns, password }).expect(201);

  const login = await request(app)
    .post('/v1/sessions')
    .send({ namespace: ns, password })
    .expect(201);
  assert.equal(login.body.user.namespace, ns);
  assert.equal(typeof login.body.token, 'string');
  assert.equal(typeof login.body.session.id, 'string');
  assert.equal(new Date(login.body.session.expiresAt) > new Date(), true);
  assert.equal(login.headers.location, `/v1/sessions/${login.body.session.id}`);

  // The session it just made is in the account's session list, alongside the
  // one the signup opened. Listing is behind the terms gate, so accept first.
  await acceptTerms(app, ns, login.body.token);
  const list = await request(app).get('/v1/sessions').set(bearer(login.body.token)).expect(200);
  assert.equal(list.body.data.length, 2);
  assert.ok(list.body.data.some((s) => s.id === login.body.session.id));
  await request(app).get('/v1/me').set(bearer(login.body.token)).expect(200);

  await request(app)
    .post('/v1/sessions')
    .send({ namespace: ns, password: 'wrong-password' })
    .expect(401);
});

test('login rate limit: failed attempts produce 429', async () => {
  const ns = uniqNs();
  await request(app).post('/v1/users').send({ namespace: ns, password: 'password123' }).expect(201);

  for (let i = 0; i < 5; i += 1) {
    await request(app)
      .post('/v1/sessions')
      .send({ namespace: ns, password: 'nope-nope-nope' })
      .expect(401);
  }
  const limited = await request(app)
    .post('/v1/sessions')
    .send({ namespace: ns, password: 'wrong-password' })
    .expect(429);
  assert.ok(limited.headers['retry-after']);
});

test('creating an account opens a session for it', async () => {
  const ns = uniqNs();
  const created = await request(app)
    .post('/v1/users')
    .send({ namespace: ns, password: FIXTURE_PASSWORD, displayName: 'First' })
    .expect(201);
  assert.equal(created.body.user.namespace, ns);
  assert.equal(created.body.user.displayName, 'First');
  assert.equal(created.headers.location, `/v1/users/${ns}`);
  assert.equal(typeof created.body.token, 'string');
  assert.equal(typeof created.body.session.id, 'string');

  const me = await request(app).get('/v1/me').set(bearer(created.body.token)).expect(200);
  assert.equal(me.body.namespace, ns);

  // The session the response named is real, and it is the only one. Listing is
  // behind the terms gate, so accept first.
  await acceptTerms(app, ns, created.body.token);
  const list = await request(app).get('/v1/sessions').set(bearer(created.body.token)).expect(200);
  assert.deepEqual(
    list.body.data.map((s) => s.id),
    [created.body.session.id],
  );
});

test('the old /auth surface is gone', async () => {
  const ns = uniqNs();
  const created = await request(app)
    .post('/v1/users')
    .send({ namespace: ns, password: FIXTURE_PASSWORD })
    .expect(201);
  for (const path of ['/v1/auth/login', '/v1/auth/signup', '/v1/auth/logout', '/v1/auth/me']) {
    await request(app).post(path).send({}).expect(404);
  }
  await request(app).get('/v1/auth/me').set(bearer(created.body.token)).expect(404);
});

test('DELETE /sessions/current revokes the session that called it', async () => {
  const { user, token } = await signupAccept(app, uniqNs());
  const list = await request(app).get('/v1/sessions').set(bearer(token)).expect(200);
  assert.equal(list.body.data.length, 1);

  await request(app).delete('/v1/sessions/current').set(bearer(token)).expect(204);

  await request(app).get('/v1/me').set(bearer(token)).expect(401);
  const login = await request(app)
    .post('/v1/sessions')
    .send({ namespace: user.namespace, password: FIXTURE_PASSWORD })
    .expect(201);
  assert.ok(login.body.token);
});

test('ending a session works without accepting terms', async () => {
  const r = await request(app)
    .post('/v1/users')
    .send({ namespace: uniqNs(), password: 'password123' });
  assert.equal(r.status, 201);
  await request(app).delete('/v1/sessions/current').set(bearer(r.body.token)).expect(204);
});

test('first user is admin', async () => {
  const u = await request(app)
    .post('/v1/users')
    .send({ namespace: uniqNs(), password: 'password123', displayName: 'First' })
    .expect(201);
  assert.equal(u.body.user.role, 'admin');
  const second = await request(app)
    .post('/v1/users')
    .send({ namespace: uniqNs(), password: 'password123' })
    .expect(201);
  assert.equal(second.body.user.role, 'normal');
});

test('duplicate namespace -> 409', async () => {
  const who = uniqNs();
  await request(app)
    .post('/v1/users')
    .send({ namespace: who, password: 'password123' })
    .expect(201);
  await request(app)
    .post('/v1/users')
    .send({ namespace: who, password: 'password123' })
    .expect(409);
});

test('short password -> 422', async () => {
  await request(app).post('/v1/users').send({ namespace: uniqNs(), password: 'short' }).expect(422);
});

test('me: valid token 200, garbage 401, none 401', async () => {
  const { token } = await signupAccept(app, uniqNs());
  await request(app).get('/v1/me').set(bearer(token)).expect(200);
  await request(app).get('/v1/me').set(bearer('garbage')).expect(401);
  await request(app).get('/v1/me').expect(401);
});

test('terms gate: 403 until accept', async () => {
  const res = await signup(app, uniqNs());
  const { token } = res.body;
  const ns = res.body.user.namespace;
  await request(app).get('/v1/me').set(bearer(token)).expect(200);
  await request(app)
    .patch(`/v1/users/${ns}`)
    .set(bearer(token))
    .send({ displayName: 'Updated' })
    .expect(403);
  await acceptTerms(app, ns, token);
  await request(app)
    .patch(`/v1/users/${ns}`)
    .set(bearer(token))
    .send({ displayName: 'Updated' })
    .expect(200);
});
