import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { boot, resetDb, bearer, uniqNs, signupAndAccept, publishProject } from './helpers.mjs';

let app;
let sql;
before(async () => {
  ({ app, sql } = await boot());
});
beforeEach(resetDb);
after(async () => {
  await sql.end();
});

async function makeSetup() {
  const admin = await signupAndAccept(app, uniqNs());
  const ownerA = await signupAndAccept(app, uniqNs());
  const coowner = await signupAndAccept(app, uniqNs());
  const outsider = await signupAndAccept(app, uniqNs());

  await publishProject(app, ownerA.user.namespace, 'hello', ownerA.token, {
    code: '// hello@1.0.0',
  });
  await request(app)
    .patch(`/v1/@${ownerA.user.namespace}/hello/versions/1.0.0`)
    .set(bearer(admin.token))
    .send({ status: 'approved' })
    .expect(200);

  return {
    admin,
    ownerA,
    coowner,
    outsider,
    ns: ownerA.user.namespace,
  };
}

test('adding an owner grants publish/yank/tag access and notifies them', async () => {
  const { admin, ownerA, coowner, outsider, ns } = await makeSetup();

  // outsider cannot add owners
  await request(app).put(`/v1/@${ns}/hello/owners/coowner`).set(bearer(outsider.token)).expect(403);

  // owner grants co-owner
  await request(app)
    .put(`/v1/@${ns}/hello/owners/${coowner.user.namespace}`)
    .set(bearer(ownerA.token))
    .expect(204);

  // The invitation alone is not a grant, so the list does not name them yet.
  const pending = await request(app)
    .get(`/v1/@${ns}/hello/owners/pending`)
    .set(bearer(coowner.token))
    .expect(200);
  assert.deepEqual(
    pending.body.data.map((row) => row.namespace),
    [coowner.user.namespace],
  );

  // co-owner receives a notification
  const notes = await request(app).get('/v1/notifications').set(bearer(coowner.token)).expect(200);
  assert.equal(notes.body.data.length, 1);
  assert.match(notes.body.data[0].message, /accept management of @.*\/hello/);

  await publishProject(
    app,
    ns,
    'hello',
    coowner.token,
    {
      version: '2.0.0',
      code: '// x',
    },
    403,
  );

  await request(app)
    .post(`/v1/@${ns}/hello/owners/${coowner.user.namespace}/accept`)
    .set(bearer(coowner.token))
    .expect(200);

  const list = await request(app).get(`/v1/@${ns}/hello/owners`).expect(200);
  const namespaces = list.body.data.map((u) => u.namespace);
  assert.ok(namespaces.includes(ns));
  assert.ok(namespaces.includes(coowner.user.namespace));

  // co-owner publishes and yanks
  await publishProject(app, ns, 'hello', coowner.token, {
    version: '2.0.0',
    code: '// hello@2.0.0',
  });
  await request(app)
    .delete(`/v1/@${ns}/hello/versions/2.0.0`)
    .set(bearer(coowner.token))
    .expect(204);

  // co-owner can set dist-tags
  await request(app)
    .put(`/v1/@${ns}/hello/tags/stable`)
    .set(bearer(coowner.token))
    .send({ version: '1.0.0' })
    .expect(204);

  // ...but a fresh outsider still cannot
  await publishProject(
    app,
    ns,
    'hello',
    outsider.token,
    {
      version: '3.0.0',
      code: '// x',
    },
    403,
  );

  // removing an owner revokes the grant and notifies
  await request(app)
    .delete(`/v1/@${ns}/hello/owners/${coowner.user.namespace}`)
    .set(bearer(ownerA.token))
    .expect(204);

  const after = await request(app).get(`/v1/@${ns}/hello/owners`).expect(200);
  assert.ok(!after.body.data.some((u) => u.namespace === coowner.user.namespace));

  await publishProject(
    app,
    ns,
    'hello',
    coowner.token,
    {
      version: '3.0.0',
      code: '// x',
    },
    403,
  );

  // admin can still hand management around (invite, then accept)
  await request(app)
    .put(`/v1/@${ns}/hello/owners/${coowner.user.namespace}`)
    .set(bearer(admin.token))
    .expect(204);
  await request(app)
    .post(`/v1/@${ns}/hello/owners/${coowner.user.namespace}/accept`)
    .set(bearer(coowner.token))
    .expect(200);
});

test('the namespace account is a permanent owner', async () => {
  const { ownerA, ns } = await makeSetup();

  const remove = await request(app)
    .delete(`/v1/@${ns}/hello/owners/${ns}`)
    .set(bearer(ownerA.token));
  assert.equal(remove.status, 422);

  const list = await request(app).get(`/v1/@${ns}/hello/owners`).expect(200);
  assert.ok(list.body.data.some((u) => u.namespace === ns));
});

test('organization co-owners cannot manage owners in another namespace', async () => {
  const { ownerA, coowner, outsider, ns } = await makeSetup();
  const orgNamespace = uniqNs();
  await request(app)
    .post('/v1/orgs')
    .set(bearer(coowner.token))
    .send({ namespace: orgNamespace })
    .expect(201);
  const extensionPath = `/v1/@${ns}/hello`;
  await request(app)
    .put(`${extensionPath}/owners/${orgNamespace}`)
    .set(bearer(ownerA.token))
    .expect(204);
  await request(app)
    .post(`${extensionPath}/owners/${orgNamespace}/accept`)
    .set(bearer(coowner.token))
    .expect(200);
  await request(app)
    .put(`${extensionPath}/owners/${outsider.user.namespace}`)
    .set(bearer(ownerA.token))
    .expect(204);

  await request(app)
    .put(`${extensionPath}/owners/${coowner.user.namespace}`)
    .set(bearer(coowner.token))
    .expect(403);
  for (const target of [outsider.user.namespace, orgNamespace]) {
    await request(app)
      .delete(`${extensionPath}/owners/${target}`)
      .set(bearer(coowner.token))
      .expect(403);
  }
  await request(app)
    .post(`${extensionPath}/owners/${outsider.user.namespace}/accept`)
    .set(bearer(outsider.token))
    .expect(200);
});

test("a co-owner's approval trusts the namespace, not the co-owner", async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const ownerA = await signupAndAccept(app, uniqNs());
  const coowner = await signupAndAccept(app, uniqNs());
  const ns = ownerA.user.namespace;

  const hasPublished = async (namespace) => {
    const [row] = await sql`SELECT has_published FROM users WHERE namespace = ${namespace}`;
    return row.has_published;
  };

  // The namespace has never had a version approved, so its first publish waits
  // for review. The version row is enough for ownerA to hand out ownership.
  const first = await publishProject(app, ns, 'hello', ownerA.token, { code: '// hello@1.0.0' });
  assert.equal(first.body.status, 'pending');
  assert.equal(await hasPublished(ns), false);

  await request(app)
    .put(`/v1/@${ns}/hello/owners/${coowner.user.namespace}`)
    .set(bearer(ownerA.token))
    .expect(204);
  await request(app)
    .post(`/v1/@${ns}/hello/owners/${coowner.user.namespace}/accept`)
    .set(bearer(coowner.token))
    .expect(200);

  // The co-owner publishes into the namespace as a separate publisher, so their
  // version reaches review too and owner_id on that row is the co-owner.
  const staged = await publishProject(app, ns, 'hello', coowner.token, {
    version: '2.0.0',
    code: '// hello@2.0.0',
  });
  assert.equal(staged.body.status, 'pending');
  await request(app)
    .patch(`/v1/@${ns}/hello/versions/2.0.0`)
    .set(bearer(admin.token))
    .send({ status: 'approved' })
    .expect(200);

  assert.equal(await hasPublished(ns), true);
  assert.equal(await hasPublished(coowner.user.namespace), false);

  // The namespace skips review from here, and the co-owner's own namespace does
  // not inherit the trust granted in someone else's.
  const trusted = await publishProject(app, ns, 'hello', coowner.token, {
    version: '3.0.0',
    code: '// hello@3.0.0',
  });
  assert.equal(trusted.body.status, 'published');

  const own = await publishProject(app, coowner.user.namespace, 'own', coowner.token, {
    version: '1.0.0',
    code: '// own@1.0.0',
  });
  assert.equal(own.body.status, 'pending');
  await request(app).get(`/v1/@${coowner.user.namespace}/own/versions/1.0.0`).expect(404);
});
