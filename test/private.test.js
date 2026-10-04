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
import { aggregateDayLoader } from '../src/metrics.js';

let app;
let sql;
before(async () => {
  // The access-grant test signs up five accounts and then creates an
  // organization, which draws on the signup bucket too.
  ({ app, sql } = await boot({
    limits: { maxBlobBytes: 5000, maxAccountBlobBytes: 8000 },
    rateLimits: { signupsPerIpPerWindow: 10_000 },
  }));
});
beforeEach(resetDb);
after(async () => {
  await sql.end();
});

async function publishPrivate(
  { owner, id = 'secret', version = '1.0.0', code = 'const answer = 42;' },
  status = 201,
) {
  return publishProject(
    app,
    owner.user.namespace,
    id,
    owner.token,
    {
      visibility: 'private',
      version,
      code,
    },
    status,
  );
}

async function expectStatus(promise, status) {
  const res = await promise;
  assert.equal(res.status, status, JSON.stringify(res.body));
  return res;
}

test('private extensions are hidden from public surfaces but visible to the owner', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const owner = await signupAndAccept(app, uniqNs());
  const ns = owner.user.namespace;

  const published = await publishPrivate({ owner, code: '// secret@1.0.0' });
  assert.equal(published.status, 201);
  assert.equal(published.body.visibility, 'private');
  await request(app)
    .patch(`/v1/@${ns}/secret/versions/1.0.0`)
    .set(bearer(admin.token))
    .send({ status: 'approved' })
    .expect(200);

  // Public discovery and detail surfaces all come back empty or 404.
  const list = await request(app).get('/v1/extensions').expect(200);
  assert.ok(!list.body.data.some((e) => e.id === 'secret'));

  const search = await request(app).get('/v1/search?query=secret').expect(200);
  assert.equal(search.body.data.length, 0);

  const feed = await request(app).get('/v1/feed.atom').expect(200);
  assert.ok(!feed.text.includes('secret'));

  await request(app)
    .get('/v1/badge/@' + ns + '/secret')
    .expect(404);
  await request(app).get(`/v1/@${ns}/secret`).expect(404);
  await request(app).get(`/v1/@${ns}/secret/versions/1.0.0`).expect(404);
  const secretVersions = await request(app).get(`/v1/@${ns}/secret/versions`).expect(200);
  assert.deepEqual(secretVersions.body.data, []);
  await request(app).get(`/v1/@${ns}/secret/versions/1.0.0/download`).expect(404);
  await request(app).get(`/v1/@${ns}/secret/versions/1.0.0/source`).expect(401);
  await request(app).get(`/v1/@${ns}/secret/tags`).expect(404);
  await request(app).get(`/v1/@${ns}/secret/owners`).expect(404);
  await request(app).get('/v1/extensions/trending').expect(200);

  // Trending is public, so a private extension with download activity has to
  // stay off it for anonymous callers and show up for the owner.
  await sql`
    INSERT INTO download_events (namespace, extension_id, version, user_agent, ip_hash)
    VALUES (${ns}, 'secret', '1.0.0', 'test', '10.0.0.1')
  `;
  await aggregateDayLoader(sql)(new Date());
  const anonTrending = await request(app).get('/v1/extensions/trending').expect(200);
  assert.ok(!anonTrending.body.data.some((e) => e.id === 'secret'));
  const ownerTrending = await request(app)
    .get('/v1/extensions/trending')
    .set(bearer(owner.token))
    .expect(200);
  assert.ok(ownerTrending.body.data.some((e) => e.id === 'secret'));

  // Blobs are content-addressed, so knowing the digest is not authorization:
  // the blob route has to run the same visibility check as the download.
  const [blob] = await sql`
    SELECT blob_digest FROM versions
    WHERE namespace = ${ns} AND extension_id = 'secret' AND blob_digest IS NOT NULL
  `;
  await request(app).get(`/v1/blobs/${blob.blob_digest}`).expect(404);

  // The namespace account reads its own private extension, downloads the
  // compiled blob, and fetches the source tarball.
  const detail = await request(app).get(`/v1/@${ns}/secret`).set(bearer(owner.token)).expect(200);
  assert.equal(detail.body.id, 'secret');
  await request(app)
    .get(`/v1/@${ns}/secret/versions/1.0.0/download`)
    .set(bearer(owner.token))
    .expect(200);
  const blobFetch = await request(app)
    .get(`/v1/blobs/${blob.blob_digest}`)
    .set(bearer(owner.token))
    .expect(200);
  assert.match(blobFetch.headers['cache-control'], /private, no-store/);
  const src = await request(app)
    .get(`/v1/@${ns}/secret/versions/1.0.0/source`)
    .set(bearer(owner.token))
    .expect(200);
  assert.match(src.headers['content-type'], /gzip/);
});

test('a public version does not expose a private sibling in the detail list', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const owner = await signupAndAccept(app, uniqNs());
  const ns = owner.user.namespace;

  await publishPrivate({ owner, code: '// private@1.0.0' });
  await request(app)
    .patch(`/v1/@${ns}/secret/versions/1.0.0`)
    .set(bearer(admin.token))
    .send({ status: 'approved' })
    .expect(200);
  await publishProject(app, ns, 'secret', owner.token, { version: '2.0.0', code: '// public' });

  // The extension is public now, but 1.0.0 is still private, so the detail
  // response has to be built from what this caller may see rather than from
  // whichever version happens to sort first.
  const anon = await request(app).get(`/v1/@${ns}/secret`).expect(200);
  assert.equal(anon.body.versions.length, 1);
  assert.equal(anon.body.versions[0].version, '2.0.0');
  assert.ok(
    !JSON.stringify(anon.body).includes('1.0.0'),
    'the private version must not appear anywhere in the response',
  );

  // The owner sees both, which is what makes the check per-version.
  const asOwner = await request(app).get(`/v1/@${ns}/secret`).set(bearer(owner.token)).expect(200);
  assert.deepEqual(
    asOwner.body.versions.map((v) => v.version),
    ['2.0.0', '1.0.0'],
  );
});

test('a semver range never resolves to a version the caller cannot see', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const owner = await signupAndAccept(app, uniqNs());
  const ns = owner.user.namespace;

  await publishPrivate({ owner, code: '// private@1.0.0' });
  await request(app)
    .patch(`/v1/@${ns}/secret/versions/1.0.0`)
    .set(bearer(admin.token))
    .send({ status: 'approved' })
    .expect(200);
  await publishProject(app, ns, 'secret', owner.token, { version: '2.0.0', code: '// public' });

  // The extension-level check passes on the public 2.0.0, so the list has to be
  // narrowed to what the caller may read before anything is handed over.
  const anon = await request(app).get(`/v1/@${ns}/secret/versions?range=1.0.0`).expect(200);
  assert.deepEqual(anon.body.data, []);
  // The range holds the private 1.0.0 and the public 2.0.0 outside it, so
  // nothing readable is left.
  const wide = await request(app).get(`/v1/@${ns}/secret/versions?range=1.x`);
  assert.equal(wide.status, 200);
  assert.deepEqual(wide.body.data, []);
  const everything = await request(app).get(`/v1/@${ns}/secret/versions?range=*`);
  assert.deepEqual(
    everything.body.data.map((v) => v.version),
    ['2.0.0'],
    'only the public version is readable anonymously',
  );

  // A range covering the public version still answers, and the owner, who may
  // read 1.0.0, gets it when they ask for it.
  const publicRange = await request(app).get(`/v1/@${ns}/secret/versions?range=2.0.0`).expect(200);
  assert.equal(publicRange.body.data[0].version, '2.0.0');
  const asOwner = await request(app)
    .get(`/v1/@${ns}/secret/versions?range=1.0.0`)
    .set(bearer(owner.token))
    .expect(200);
  assert.equal(asOwner.body.data[0].version, '1.0.0');
  assert.equal(asOwner.body.data[0].visibility, 'private');
});

test('a private version does not hide the public one before it', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const owner = await signupAndAccept(app, uniqNs());
  const ns = owner.user.namespace;

  await publishProject(app, ns, 'later', owner.token, { version: '1.0.0', code: '// public' });
  await request(app)
    .patch(`/v1/@${ns}/later/versions/1.0.0`)
    .set(bearer(admin.token))
    .send({ status: 'approved' })
    .expect(200);
  // Past the first publish, so this one goes out without review.
  const priv = await publishPrivate({ owner, id: 'later', version: '2.0.0', code: '// private@2' });
  assert.equal(priv.body.status, 'published');

  // The newest row is private, which used to make the whole endpoint answer
  // 404 — including for a range that only the public version satisfies.
  const anon = await request(app).get(`/v1/@${ns}/later/versions?range=1.0.0`).expect(200);
  assert.equal(anon.body.data[0].version, '1.0.0');
  assert.equal(anon.body.data[0].visibility, 'public');

  // The private one is still only listed for someone who may read it.
  const asOwner = await request(app)
    .get(`/v1/@${ns}/later/versions?range=2.0.0`)
    .set(bearer(owner.token))
    .expect(200);
  assert.equal(asOwner.body.data[0].version, '2.0.0');
  const denied = await request(app).get(`/v1/@${ns}/later/versions?range=2.0.0`);
  assert.equal(denied.status, 200);
  assert.deepEqual(denied.body.data, []);
});

test('private downloads do not consume anonymous trending slots', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const owner = await signupAndAccept(app, uniqNs());
  const ns = owner.user.namespace;
  await publishPrivate({ owner });
  await request(app)
    .patch(`/v1/@${ns}/secret/versions/1.0.0`)
    .set(bearer(admin.token))
    .send({ status: 'approved' })
    .expect(200);
  await publishProject(app, ns, 'open', owner.token, { code: '// open' });

  await sql`
    INSERT INTO extension_daily_downloads (namespace, extension_id, day, total_downloads)
    VALUES (${ns}, 'secret', CURRENT_DATE, 5), (${ns}, 'open', CURRENT_DATE, 1)
  `;
  const anonymous = await request(app).get('/v1/extensions/trending?limit=1').expect(200);
  assert.deepEqual(
    anonymous.body.data.map((entry) => entry.id),
    ['open'],
  );

  const owned = await request(app)
    .get('/v1/extensions/trending?limit=1')
    .set(bearer(owner.token))
    .expect(200);
  assert.deepEqual(
    owned.body.data.map((entry) => entry.id),
    ['secret'],
  );
});

test('access grants open private detail/download to the grantee and revoke cleanly', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const owner = await signupAndAccept(app, uniqNs());
  const grantee = await signupAndAccept(app, uniqNs());
  const outsider = await signupAndAccept(app, uniqNs());
  const ns = owner.user.namespace;

  await expectStatus(publishPrivate({ owner, code: '// secret@1.0.0' }), 201);
  await request(app)
    .patch(`/v1/@${ns}/secret/versions/1.0.0`)
    .set(bearer(admin.token))
    .send({ status: 'approved' })
    .expect(200);

  // Only an owner or admin can grant.
  await request(app)
    .put(`/v1/@${ns}/secret/access/${outsider.user.namespace}`)
    .set(bearer(outsider.token))
    .expect(403);
  await request(app)
    .put(`/v1/@${ns}/secret/access/${grantee.user.namespace}`)
    .set(bearer(owner.token))
    .expect(204);

  // The grantee can now see and download, and shows up in the access list.
  await request(app).get(`/v1/@${ns}/secret`).set(bearer(grantee.token)).expect(200);
  await request(app)
    .get(`/v1/@${ns}/secret/versions/1.0.0/download`)
    .set(bearer(grantee.token))
    .expect(200);
  const grants = await request(app)
    .get(`/v1/@${ns}/secret/access`)
    .set(bearer(owner.token))
    .expect(200);
  assert.ok(grants.body.data.some((g) => g.namespace === grantee.user.namespace));

  // The namespace account cannot be granted to itself.
  await request(app).put(`/v1/@${ns}/secret/access/${ns}`).set(bearer(owner.token)).expect(422);

  // Revoking hides it again.
  await request(app)
    .delete(`/v1/@${ns}/secret/access/${grantee.user.namespace}`)
    .set(bearer(owner.token))
    .expect(204);
  await request(app).get(`/v1/@${ns}/secret`).set(bearer(grantee.token)).expect(404);
  await request(app)
    .get(`/v1/@${ns}/secret/versions/1.0.0/download`)
    .set(bearer(grantee.token))
    .expect(404);

  // A co-owner sees it without a grant.
  const coowner = await signupAndAccept(app, uniqNs());
  await request(app)
    .put(`/v1/@${ns}/secret/owners/${coowner.user.namespace}`)
    .set(bearer(owner.token))
    .expect(204);
  await request(app)
    .post(`/v1/@${ns}/secret/owners/${coowner.user.namespace}/accept`)
    .set(bearer(coowner.token))
    .expect(200);
  await request(app).get(`/v1/@${ns}/secret`).set(bearer(coowner.token)).expect(200);
  await request(app)
    .put(`/v1/@${ns}/secret/access/${grantee.user.namespace}`)
    .set(bearer(coowner.token))
    .expect(403);

  const orgNamespace = uniqNs();
  await request(app)
    .post('/v1/orgs')
    .set(bearer(outsider.token))
    .send({ namespace: orgNamespace })
    .expect(201);
  await request(app)
    .put(`/v1/@${ns}/secret/owners/${orgNamespace}`)
    .set(bearer(owner.token))
    .expect(204);
  await request(app)
    .post(`/v1/@${ns}/secret/owners/${orgNamespace}/accept`)
    .set(bearer(outsider.token))
    .expect(200);
  await request(app).get(`/v1/@${ns}/secret`).set(bearer(outsider.token)).expect(200);
  await request(app)
    .put(`/v1/@${ns}/secret/access/${grantee.user.namespace}`)
    .set(bearer(outsider.token))
    .expect(403);

  await request(app)
    .put(`/v1/@${ns}/secret/access/${grantee.user.namespace}`)
    .set(bearer(admin.token))
    .expect(204);
  for (const actor of [coowner, outsider]) {
    await request(app)
      .delete(`/v1/@${ns}/secret/access/${grantee.user.namespace}`)
      .set(bearer(actor.token))
      .expect(403);
  }
  await request(app)
    .delete(`/v1/@${ns}/secret/access/${grantee.user.namespace}`)
    .set(bearer(admin.token))
    .expect(204);
  await request(app).get(`/v1/@${ns}/secret`).set(bearer(grantee.token)).expect(404);
});

test('blob size caps and the account quota are enforced on publish', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const owner = await signupAndAccept(app, uniqNs());
  const ns = owner.user.namespace;

  // A single compiled output over maxBlobBytes is rejected outright. The
  // default project compiles to ~500 bytes, so a large embedded literal pushes
  // the build past the 5000-byte cap.
  const oversized = await expectStatus(
    publishPrivate(
      {
        owner,
        id: 'big',
        code: `util.log(${JSON.stringify('x'.repeat(6000))});`,
      },
      413,
    ),
    413,
  );
  assert.match(oversized.body.detail, /limit is 5000/);

  // First publish is pending and must clear review before the next one,
  // because an owner can only have one version awaiting review at a time.
  const first = await publishPrivate({ owner, id: 'batch' });
  assert.equal(first.status, 201);
  await request(app)
    .patch(`/v1/@${ns}/batch/versions/1.0.0`)
    .set(bearer(admin.token))
    .send({ status: 'approved' })
    .expect(200);
  const second = await publishPrivate({
    owner,
    id: 'batch',
    version: '2.0.0',
    code: '// second',
  });
  assert.equal(second.status, 201);

  // Force the account near its quota; the charge covers both the compiled blob
  // and the retained source tarball, so even a small publish must be refused.
  await sql`UPDATE users SET blob_bytes = 7990 WHERE namespace = ${ns}`;
  const overflowing = await expectStatus(
    publishPrivate(
      {
        owner,
        id: 'batch',
        version: '3.0.0',
        code: '// overflow',
      },
      413,
    ),
    413,
  );
  assert.match(overflowing.body.detail, /quota/);
});

test('concurrent publishes to sibling extensions cannot both pass the quota', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const owner = await signupAndAccept(app, uniqNs());
  const coowner = await signupAndAccept(app, uniqNs());
  const ns = owner.user.namespace;

  await publishPrivate({ owner, id: 'seed' });
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

  await expectStatus(publishPrivate({ owner, code: '// secret@1.0.0' }), 201);
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

  await expectStatus(publishPrivate({ owner, id: 'temp', code: '// temp' }), 201);
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
