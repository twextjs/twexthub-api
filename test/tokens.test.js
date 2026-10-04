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

test('create/list/update/delete automation tokens', async () => {
  const { token } = await signupAndAccept(app, uniqNs());
  const created = await request(app)
    .post('/v1/tokens')
    .set(bearer(token))
    .send({ name: 'ci', scopes: ['publish'] })
    .expect(201);
  assert.ok(created.body.token);
  assert.equal(created.body.scopes.join(','), 'publish');

  const list = await request(app).get('/v1/tokens').set(bearer(token)).expect(200);
  assert.equal(list.body.data.length, 1);

  const id = created.body.id;
  await request(app)
    .patch(`/v1/tokens/${id}`)
    .set(bearer(token))
    .send({ scopes: ['publish', 'yank'] })
    .expect(200);

  const updated = await request(app).get('/v1/tokens').set(bearer(token)).expect(200);
  assert.equal(updated.body.data[0].scopes.includes('yank'), true);

  await request(app).delete(`/v1/tokens/${id}`).set(bearer(token)).expect(204);
  const after = await request(app).get('/v1/tokens').set(bearer(token)).expect(200);
  assert.equal(after.body.data.length, 0);

  await request(app).get('/v1/me').set(bearer(created.body.token)).expect(401);
});

test('automation token can publish with publish scope', async () => {
  const adminNs = uniqNs();
  const ab = await signupAndAccept(app, adminNs);
  assert.equal(ab.user.role, 'admin');

  const { user, token } = await signupAndAccept(app, uniqNs());
  const ns = user.namespace;

  const created = await request(app)
    .post('/v1/tokens')
    .set(bearer(token))
    .send({ name: 'auto', scopes: ['publish'] })
    .expect(201);
  const auto = created.body.token;

  const pub = await publishProject(app, ns, 'hello', auto);
  assert.equal(pub.status, 201);

  const queue = await request(app)
    .get('/v1/versions?status=pending')
    .set(bearer(ab.token))
    .expect(200);
  const version = queue.body.data[0].version;
  await request(app)
    .patch(`/v1/@${ns}/hello/versions/${version}`)
    .set(bearer(ab.token))
    .send({ status: 'approved' })
    .expect(200);
});

test('a token reaches only the endpoints its scopes cover', async () => {
  const { user, token } = await signupAndAccept(app, uniqNs());
  const created = await request(app)
    .post('/v1/tokens')
    .set(bearer(token))
    .send({ name: 'auto', scopes: ['publish'] })
    .expect(201);
  const auto = created.body.token;

  const me = await request(app).get('/v1/me').set(bearer(auto)).expect(200);
  assert.equal(me.body.namespace, user.namespace);

  // `publish` says nothing about credentials, so both listings stay closed.
  for (const path of ['/v1/sessions', '/v1/tokens']) {
    const denied = await request(app).get(path).set(bearer(auto)).expect(403);
    assert.match(
      denied.body.detail,
      /missing the required "(manage:sessions|manage:tokens)" scope/,
    );
  }

  const org = await request(app)
    .post('/v1/orgs')
    .set(bearer(auto))
    .send({ namespace: uniqNs() })
    .expect(403);
  assert.match(org.body.detail, /manage:orgs/);

  const account = await request(app)
    .patch(`/v1/users/${user.namespace}`)
    .set(bearer(auto))
    .send({ bio: 'set by a token' })
    .expect(403);
  assert.match(account.body.detail, /manage:account/);

  // Signing itself out is the one thing a token cannot do, because the route
  // deletes by its own token id and the id spaces of the two tables overlap.
  const own = await request(app).delete('/v1/sessions/current').set(bearer(auto)).expect(403);
  assert.match(own.body.detail, /Automation tokens/);
});

test('a token granted the management scopes can manage credentials', async () => {
  const { token } = await signupAndAccept(app, uniqNs());
  const created = await request(app)
    .post('/v1/tokens')
    .set(bearer(token))
    .send({ name: 'ops', scopes: ['manage:sessions', 'manage:tokens'] })
    .expect(201);
  const ops = created.body.token;

  const sessions = await request(app).get('/v1/sessions').set(bearer(ops)).expect(200);
  assert.equal(sessions.body.data.length, 1);

  const tokens = await request(app).get('/v1/tokens').set(bearer(ops)).expect(200);
  assert.equal(tokens.body.data.length, 1);

  // It can end the session that minted it, but only by id. Ending its *own*
  // session is the one thing no token can do, since that route deletes by the
  // caller's token id and the two tables' id spaces overlap.
  await request(app).delete('/v1/sessions/current').set(bearer(ops)).expect(403);
  const [session] = sessions.body.data;
  await request(app).delete(`/v1/sessions/${session.id}`).set(bearer(ops)).expect(204);
});

test('a token cannot grant a scope it does not hold', async () => {
  const { token } = await signupAndAccept(app, uniqNs());
  const created = await request(app)
    .post('/v1/tokens')
    .set(bearer(token))
    .send({ name: 'ops', scopes: ['manage:tokens'] })
    .expect(201);
  const ops = created.body.token;

  const escalate = await request(app)
    .post('/v1/tokens')
    .set(bearer(ops))
    .send({ name: 'pope', scopes: ['admin'] })
    .expect(422);
  assert.match(escalate.body.errors[0].message, /missing the "admin" scope/);

  // A scope it does hold is still fine, so the route is not simply closed.
  await request(app)
    .post('/v1/tokens')
    .set(bearer(ops))
    .send({ name: 'inner', scopes: ['manage:tokens'] })
    .expect(201);
});

test('a token with the admin scope is still bounded by its own account role', async () => {
  // The first account to sign up is the admin and every later one is normal, so
  // the two halves of this need signing up in that order.
  const ab = await signupAndAccept(app, uniqNs());
  assert.equal(ab.user.role, 'admin');
  const { user, token } = await signupAndAccept(app, uniqNs());
  assert.equal(user.role, 'normal');

  const created = await request(app)
    .post('/v1/tokens')
    .set(bearer(token))
    .send({ name: 'wannabe', scopes: ['admin'] })
    .expect(201);
  const auto = created.body.token;

  // A normal account cannot reach the admin surface with the scope, because the
  // scope is only ever half of the answer.
  const metrics = await request(app).get('/v1/admin/metrics').set(bearer(auto)).expect(403);
  assert.match(metrics.body.detail, /Admin privileges are required/);

  // The same grant on the admin's own account is what does reach it.
  const allowed = await request(app)
    .post('/v1/tokens')
    .set(bearer(ab.token))
    .send({ name: 'ops', scopes: ['admin'] })
    .expect(201);
  await request(app).get('/v1/admin/metrics').set(bearer(allowed.body.token)).expect(200);
});

test('an admin token with the admin scope reviews versions', async () => {
  const adminNs = uniqNs();
  const ab = await signupAndAccept(app, adminNs);
  assert.equal(ab.user.role, 'admin');

  const created = await request(app)
    .post('/v1/tokens')
    .set(bearer(ab.token))
    .send({ name: 'reviewer', scopes: ['admin'] })
    .expect(201);
  const reviewer = created.body.token;

  const { user, token } = await signupAndAccept(app, uniqNs());
  const ns = user.namespace;
  const pub = await publishProject(app, ns, 'hello', token);
  const version = pub.body.version;

  const queue = await request(app)
    .get('/v1/versions?status=pending')
    .set(bearer(reviewer))
    .expect(200);
  assert.equal(queue.body.data[0].version, version);

  await request(app)
    .patch(`/v1/@${ns}/hello/versions/${version}`)
    .set(bearer(reviewer))
    .send({ status: 'approved' })
    .expect(200);

  // Without the scope the same admin account is refused, which is the whole
  // difference the grant makes.
  const unscoped = await request(app)
    .post('/v1/tokens')
    .set(bearer(ab.token))
    .send({ name: 'reader', scopes: ['publish'] })
    .expect(201);
  const denied = await request(app)
    .patch(`/v1/@${ns}/hello/versions/${version}`)
    .set(bearer(unscoped.body.token))
    .send({ status: 'approved' })
    .expect(403);
  assert.match(denied.body.detail, /missing the required "admin" scope/);
});

test('yank scope: yank own version once approved', async () => {
  const adminNs = uniqNs();
  const ab = await signupAndAccept(app, adminNs);
  const { user, token } = await signupAndAccept(app, uniqNs());
  const ns = user.namespace;

  const pub = await publishProject(app, ns, 'hello', token);
  const version = pub.body.version;

  const queue = await request(app)
    .get('/v1/versions?status=pending')
    .set(bearer(ab.token))
    .expect(200);
  await request(app)
    .patch(`/v1/@${ns}/hello/versions/${queue.body.data[0].version}`)
    .set(bearer(ab.token))
    .send({ status: 'approved' })
    .expect(200);

  const created = await request(app)
    .post('/v1/tokens')
    .set(bearer(token))
    .send({ name: 'yankbot', scopes: ['yank'] })
    .expect(201);
  const yankToken = created.body.token;

  await request(app)
    .delete(`/v1/@${ns}/hello/versions/${version}`)
    .set(bearer(yankToken))
    .expect(204);

  const entry = await request(app).get(`/v1/@${ns}/hello/versions/${version}`);
  assert.equal(entry.status, 200);
  assert.equal(entry.body.status, 'yanked');
});

test('a token revokes itself, and only itself', async () => {
  const { token } = await signupAndAccept(app, uniqNs());
  const first = await request(app)
    .post('/v1/tokens')
    .set(bearer(token))
    .send({ name: 'one', scopes: ['publish'] })
    .expect(201);
  const second = await request(app)
    .post('/v1/tokens')
    .set(bearer(token))
    .send({ name: 'two', scopes: ['publish'] })
    .expect(201);

  await request(app).delete('/v1/tokens/current').set(bearer(first.body.token)).expect(204);

  // The revoked token is dead; the session and the other token are not.
  await request(app).get('/v1/me').set(bearer(first.body.token)).expect(401);
  await request(app).get('/v1/me').set(bearer(second.body.token)).expect(200);
  await request(app).get('/v1/me').set(bearer(token)).expect(200);
  const list = await request(app).get('/v1/tokens').set(bearer(token)).expect(200);
  assert.deepEqual(
    list.body.data.map((t) => t.name),
    ['two'],
  );
});

test('a session cannot revoke a token it does not have, and vice versa', async () => {
  const { token } = await signupAndAccept(app, uniqNs());
  const created = await request(app)
    .post('/v1/tokens')
    .set(bearer(token))
    .send({ name: 'ci', scopes: ['publish'] })
    .expect(201);

  // A session has no automation token of its own, so there is nothing to delete.
  const wrong = await request(app).delete('/v1/tokens/current').set(bearer(token)).expect(403);
  assert.match(wrong.body.detail, /session/i);

  // An automation token cannot end a session, including its caller's.
  const denied = await request(app).delete('/v1/sessions/current').set(bearer(created.body.token));
  assert.equal(denied.status, 403);

  // Neither of those attempts took the token away.
  const list = await request(app).get('/v1/tokens').set(bearer(token)).expect(200);
  assert.equal(list.body.data.length, 1);
  await request(app).delete(`/v1/tokens/${created.body.id}`).set(bearer(token)).expect(204);
});
