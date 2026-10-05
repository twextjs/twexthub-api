import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {
  boot,
  resetDb,
  bearer,
  uniqNs,
  signupAndAccept,
  publishProject,
  projectTarball,
} from './helpers.mjs';

let app;
let sql;
before(async () => {
  ({ app, sql } = await boot({
    limits: { maxBlobBytes: 5000, maxAccountBlobBytes: 8000 },
    rateLimits: { signupsPerIpPerWindow: 10_000 },
  }));
});
beforeEach(resetDb);
after(async () => {
  await sql.end();
});

test('blob size caps and the account quota are enforced on publish', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const owner = await signupAndAccept(app, uniqNs());
  const ns = owner.user.namespace;

  // A single compiled output over maxBlobBytes is rejected outright. The
  // default project compiles to ~500 bytes, so a large embedded literal pushes
  // the build past the 5000-byte cap.
  const oversized = await publishProject(
    app,
    ns,
    'big',
    owner.token,
    { code: `util.log(${JSON.stringify('x'.repeat(6000))});` },
    413,
  );
  assert.match(oversized.body.detail, /limit is 5000/);

  // First publish is pending and must clear review before the next one,
  // because an owner can only have one version awaiting review at a time.
  const first = await publishProject(app, ns, 'batch', owner.token);
  assert.equal(first.status, 201);
  await request(app)
    .patch(`/v1/@${ns}/batch/versions/1.0.0`)
    .set(bearer(admin.token))
    .send({ status: 'approved' })
    .expect(200);
  await publishProject(app, ns, 'batch', owner.token, {
    version: '2.0.0',
    code: '// second',
  });

  // Force the account near its quota; the charge covers both the compiled blob
  // and the retained source tarball, so even a small publish must be refused.
  await sql`UPDATE users SET blob_bytes = 7990 WHERE namespace = ${ns}`;
  const overflowing = await publishProject(
    app,
    ns,
    'batch',
    owner.token,
    { version: '3.0.0', code: '// overflow' },
    413,
  );
  assert.match(overflowing.body.detail, /quota/);
});

test('concurrent publishes to sibling extensions cannot both pass the quota', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const owner = await signupAndAccept(app, uniqNs());
  const coowner = await signupAndAccept(app, uniqNs());
  const ns = owner.user.namespace;

  await publishProject(app, ns, 'seed', owner.token);
  await request(app)
    .patch(`/v1/@${ns}/seed/versions/1.0.0`)
    .set(bearer(admin.token))
    .send({ status: 'approved' })
    .expect(200);
  await request(app)
    .put(`/v1/@${ns}/seed/owners/${coowner.user.namespace}`)
    .set(bearer(owner.token))
    .expect(204);
  await request(app)
    .post(`/v1/@${ns}/seed/owners/${coowner.user.namespace}/accept`)
    .set(bearer(coowner.token))
    .expect(200);

  // Size the account for one of the two publishes still to come.
  const [afterSeed] = await sql`SELECT blob_bytes FROM users WHERE namespace = ${ns}`;
  const quota = Math.ceil(Number(afterSeed.blob_bytes) * 1.5);
  await sql`UPDATE users SET blob_bytes = 0, max_blob_bytes = ${quota} WHERE namespace = ${ns}`;

  // A co-owner publishing a different extension charges the same account, and
  // the per-extension lock does not join the two requests.
  const publish = async (id, version, token) => {
    const buffer = await projectTarball({ id, version, code: '// alpha' });
    return request(app)
      .post(`/v1/@${ns}/${id}/versions`)
      .set(bearer(token))
      .set('Content-Type', 'application/gzip')
      .send(buffer);
  };
  const [alpha, seed] = await Promise.all([
    publish('alpha', '1.0.0', owner.token),
    publish('seed', '2.0.0', coowner.token),
  ]);
  assert.deepEqual([alpha.status, seed.status].sort(), [201, 413]);

  const [account] = await sql`SELECT blob_bytes FROM users WHERE namespace = ${ns}`;
  assert.ok(Number(account.blob_bytes) <= quota, `charged ${account.blob_bytes} of ${quota}`);
});

test('admins can read and tune per-account quota, and only admins view the audit log', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const owner = await signupAndAccept(app, uniqNs());
  const peer = await signupAndAccept(app, uniqNs());
  const ns = owner.user.namespace;

  // Quota defaults to the configured value, then tracks every publish byte.
  const initial = await request(app)
    .get(`/v1/admin/users/${ns}/quota`)
    .set(bearer(admin.token))
    .expect(200);
  assert.equal(initial.body.maxBlobBytes, null);

  await publishProject(app, ns, 'secret', owner.token, { code: '// secret' });
  const afterPublish = await request(app)
    .get(`/v1/admin/users/${ns}/quota`)
    .set(bearer(admin.token))
    .expect(200);
  assert.ok(Number(afterPublish.body.blobBytes) > 0, 'publish bytes are tracked');

  // A per-account override replaces the default; non-admins cannot set it.
  await request(app)
    .patch(`/v1/admin/users/${ns}/quota`)
    .set(bearer(peer.token))
    .send({ maxBlobBytes: 999 })
    .expect(403);
  await request(app)
    .patch(`/v1/admin/users/${ns}/quota`)
    .set(bearer(admin.token))
    .send({ maxBlobBytes: 999 })
    .expect(200);
  const tuned = await request(app)
    .get(`/v1/admin/users/${ns}/quota`)
    .set(bearer(admin.token))
    .expect(200);
  assert.equal(tuned.body.maxBlobBytes, 999);

  // Audit the whole flow: publish, owner invite, quota change, role change.
  const roleTarget = await signupAndAccept(app, uniqNs());
  await request(app)
    .put(`/v1/@${ns}/secret/owners/${peer.user.namespace}`)
    .set(bearer(owner.token))
    .expect(204);
  await request(app)
    .patch(`/v1/users/${roleTarget.user.namespace}`)
    .set(bearer(admin.token))
    .send({ role: 'admin' })
    .expect(200);

  const asPeer = await request(app).get('/v1/admin/audit').set(bearer(peer.token));
  assert.equal(asPeer.status, 403);

  const audit = await request(app).get('/v1/admin/audit').set(bearer(admin.token)).expect(200);
  const actions = audit.body.data.map((entry) => entry.action);
  for (const expected of ['version.publish', 'owner.invite', 'quota.set', 'role.change']) {
    assert.ok(actions.includes(expected), `expected audit action ${expected}, got ${actions}`);
  }
  const ownerInvite = audit.body.data.find((entry) => entry.action === 'owner.invite');
  assert.equal(ownerInvite.target.namespace, ns);
  assert.equal(ownerInvite.detail.invited, peer.user.namespace);
  const roleChange = audit.body.data.find((entry) => entry.action === 'role.change');
  assert.equal(roleChange.detail.role, 'admin');
  assert.equal(roleChange.detail.previousRole, 'normal');

  // Pagination follows its own links without repeating rows.
  const page1 = await request(app)
    .get('/v1/admin/audit?limit=2')
    .set(bearer(admin.token))
    .expect(200);
  assert.equal(page1.body.data.length, 2);
  assert.ok(page1.body._links.next);
  const page2 = await request(app).get(page1.body._links.next).set(bearer(admin.token)).expect(200);
  assert.equal(page2.body.data.length, 2);
  const seen = new Set([...page1.body.data, ...page2.body.data].map((e) => e.id));
  assert.equal(seen.size, 4);
});

test('deleting the extension refunds the account quota including source bytes', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const owner = await signupAndAccept(app, uniqNs());
  const ns = owner.user.namespace;

  await publishProject(app, ns, 'temp', owner.token, { code: '// temp' });
  const charged = await request(app)
    .get(`/v1/admin/users/${ns}/quota`)
    .set(bearer(admin.token))
    .expect(200);
  assert.ok(Number(charged.body.blobBytes) > 0);

  await request(app).delete(`/v1/@${ns}/temp`).set(bearer(owner.token)).expect(204);
  const refunded = await request(app)
    .get(`/v1/admin/users/${ns}/quota`)
    .set(bearer(admin.token))
    .expect(200);
  assert.equal(Number(refunded.body.blobBytes), 0);
});
