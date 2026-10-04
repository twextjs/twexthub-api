import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import {
  boot,
  resetDb,
  bearer,
  uniqNs,
  signupAndAccept,
  publishProject,
  approveVersion,
} from './helpers.mjs';

let app;
before(async () => {
  ({ app } = await boot());
});
beforeEach(resetDb);
after(async () => {
  await (await boot()).sql.end();
});

async function makeAdminAndOwner() {
  const adminNs = uniqNs();
  const ab = await signupAndAccept(app, adminNs);
  assert.equal(ab.user.role, 'admin');
  const ownerNs = uniqNs();
  const ob = await signupAndAccept(app, ownerNs);
  assert.equal(ob.user.role, 'normal');
  return { adminToken: ab.token, ownerToken: ob.token, adminNs, ownerNs };
}

test('first publish -> pending; list empty until approved', async () => {
  const ns = uniqNs();
  const { token } = await signupAndAccept(app, ns);
  const r = await publishProject(app, ns, 'hello', token);
  assert.equal(r.status, 201);
  assert.equal(r.body.status, 'pending');

  const list = await request(app).get('/v1/extensions');
  assert.equal(list.status, 200);
  assert.equal(list.body.data.length, 0);
});

test('unauthenticated publish is 401', async () => {
  const ns = uniqNs();
  await request(app)
    .post(`/v1/@${ns}/hello/versions`)
    .set('Content-Type', 'application/gzip')
    .send(Buffer.from('not-a-real-publish'))
    .expect(401);
});

test('one pending per owner: second publish conflicts', async () => {
  const ns = uniqNs();
  const { token } = await signupAndAccept(app, ns);
  await publishProject(app, ns, 'hello', token);
  const again = await publishProject(app, ns, 'hello', token, {}, 403);
  assert.match(again.body.detail, /awaiting review/i);
});

test('version must be strictly greater semver than published', async () => {
  const { adminToken, ownerToken, ownerNs } = await makeAdminAndOwner();
  const post = (v, status = 201) =>
    publishProject(app, ownerNs, 'hello', ownerToken, { version: v }, status);
  const approve = async () => {
    const queue = await request(app).get('/v1/versions?status=pending').set(bearer(adminToken));
    await approveVersion(app, adminToken, ownerNs, 'hello', queue.body.data[0].version);
  };

  await post('1.0.0');
  await post('1.0.0', 403); // pending slot
  await approve();
  await post('1.0.0', 422); // must be strictly greater
  await post('0.9.0', 422);
  await post('2.0.0');
});

test('admin approves pending; subsequent publishes auto-published', async () => {
  const { adminToken, ownerToken, ownerNs } = await makeAdminAndOwner();
  const first = await publishProject(app, ownerNs, 'hello', ownerToken);
  assert.equal(first.body.status, 'pending');

  const queue = await request(app).get('/v1/versions?status=pending').set(bearer(adminToken));
  assert.equal(queue.body.data.length, 1);
  const version = queue.body.data[0].version;

  const approve = await approveVersion(app, adminToken, ownerNs, 'hello', version);
  assert.equal(approve.body.status, 'published');

  const list = await request(app).get('/v1/extensions');
  assert.equal(list.body.data.length, 1);
  assert.equal(list.body.data[0].version, '1.0.0');

  const second = await publishProject(app, ownerNs, 'hello', ownerToken, { version: '2.0.0' });
  assert.equal(second.body.status, 'published');
  assert.equal(second.body.version, '2.0.0');
});

test('latest resolves by SemVer across a yank/re-publish sequence', async () => {
  const { adminToken, ownerToken, ownerNs } = await makeAdminAndOwner();

  const post = (v, code, status = 201) =>
    publishProject(app, ownerNs, 'hello', ownerToken, { version: v, code }, status);
  const latest = () => request(app).get(`/v1/@${ownerNs}/hello/versions/latest`).expect(200);
  const approveFirst = async () => {
    const queue = await request(app).get('/v1/versions?status=pending').set(bearer(adminToken));
    await approveVersion(app, adminToken, ownerNs, 'hello', queue.body.data[0].version);
  };

  await post('1.0.0', 'console.log(1)');
  await approveFirst();
  await post('2.0.0', 'console.log(2)');

  assert.equal((await latest()).body.version, '2.0.0');

  // yank the newest version; latest must fall back to the next-highest published
  await request(app)
    .delete(`/v1/@${ownerNs}/hello/versions/2.0.0`)
    .set(bearer(ownerToken))
    .expect(204);
  assert.equal((await latest()).body.version, '1.0.0');

  // the yanked blob stays downloadable
  const yankedDownload = await request(app)
    .get(`/v1/@${ownerNs}/hello/versions/2.0.0/download`)
    .expect(200);
  assert.match(yankedDownload.text, /console\.log\(2\)/);

  // yanked versions still count toward the version ceiling
  const rePublishYanked = await post('2.0.0', 'console.log(2again)', 422);
  assert.equal(rePublishYanked.status, 422);

  // a strictly greater version publishes past the yanked one
  await post('2.0.1', 'console.log(2.1)');
  assert.equal((await latest()).body.version, '2.0.1');

  // extensions listing must not surface yanked versions
  const listing = await request(app).get('/v1/extensions').expect(200);
  assert.equal(listing.body.data.length, 1);
  assert.equal(listing.body.data[0].version, '2.0.1');
});

test('non-admin cannot review', async () => {
  const ns = uniqNs();
  const { token } = await signupAndAccept(app, ns);
  await publishProject(app, ns, 'hello', token);
  const normNs = uniqNs();
  const nb = await signupAndAccept(app, normNs);
  const queue = await request(app).get('/v1/versions?status=pending').set(bearer(nb.token));
  assert.equal(queue.status, 403);
});

test('download serves compiled output with javascript content type', async () => {
  const { adminToken, ownerToken, ownerNs } = await makeAdminAndOwner();
  await publishProject(app, ownerNs, 'hello', ownerToken, {
    code: 'console.log("DOWNLOAD_SPECIAL");',
  });
  const queue = await request(app).get('/v1/versions?status=pending').set(bearer(adminToken));
  await approveVersion(app, adminToken, ownerNs, 'hello', queue.body.data[0].version);

  const dl = await request(app).get(`/v1/@${ownerNs}/hello/versions/1.0.0/download`);
  assert.equal(dl.status, 200);
  assert.match(dl.headers['content-type'], /javascript/);
  assert.match(dl.text, /DOWNLOAD_SPECIAL/);
});

test('admin can download a pending version source for review', async () => {
  const { adminToken, ownerToken, ownerNs } = await makeAdminAndOwner();
  await publishProject(app, ownerNs, 'hello', ownerToken, {
    code: 'console.log("PENDING_REVIEW_CODE");',
  });

  const dl = await request(app)
    .get(`/v1/@${ownerNs}/hello/versions/1.0.0/download`)
    .set(bearer(adminToken));
  assert.equal(dl.status, 200);
  assert.match(dl.headers['content-type'], /javascript/);
  assert.match(dl.text, /PENDING_REVIEW_CODE/);
});

test('pending version source is gated to owners and admins', async () => {
  const { adminToken, ownerToken, ownerNs } = await makeAdminAndOwner();
  await publishProject(app, ownerNs, 'hello', ownerToken, {
    code: 'console.log("SECRET_PENDING_CODE");',
  });

  // The compiled blob stays hidden until approval: anonymous 404, owner 404.
  const anonymousDownload = await request(app).get(`/v1/@${ownerNs}/hello/versions/1.0.0/download`);
  assert.equal(anonymousDownload.status, 404);

  const ownerDownload = await request(app)
    .get(`/v1/@${ownerNs}/hello/versions/1.0.0/download`)
    .set(bearer(ownerToken));
  assert.equal(ownerDownload.status, 404);

  // The source tarball is review-grade material: anonymous 401, the owner can
  // fetch their own, and an unrelated authenticated user gets a 404.
  const anonymousSource = await request(app).get(`/v1/@${ownerNs}/hello/versions/1.0.0/source`);
  assert.equal(anonymousSource.status, 401);

  const otherNs = uniqNs();
  const other = await signupAndAccept(app, otherNs);
  const otherSource = await request(app)
    .get(`/v1/@${ownerNs}/hello/versions/1.0.0/source`)
    .set(bearer(other.token));
  assert.equal(otherSource.status, 404);

  const ownerSource = await request(app)
    .get(`/v1/@${ownerNs}/hello/versions/1.0.0/source`)
    .set(bearer(ownerToken));
  assert.equal(ownerSource.status, 200);
  assert.match(ownerSource.headers['content-type'], /gzip/);
  assert.ok(ownerSource.body.length > 0);

  const adminSource = await request(app)
    .get(`/v1/@${ownerNs}/hello/versions/1.0.0/source`)
    .set(bearer(adminToken));
  assert.equal(adminSource.status, 200);
});

test('reading version source needs the read:source scope', async () => {
  const { adminToken, ownerToken, ownerNs } = await makeAdminAndOwner();
  await publishProject(app, ownerNs, 'hello', ownerToken, {
    code: 'console.log("REVIEW_ONLY");',
  });

  const created = await request(app)
    .post('/v1/tokens')
    .set(bearer(adminToken))
    .send({ name: 'ci', scopes: ['publish'] })
    .expect(201);

  // The admin role alone is not what reads source, and neither is being able to
  // download a pending build.
  const dl = await request(app)
    .get(`/v1/@${ownerNs}/hello/versions/1.0.0/download`)
    .set(bearer(created.body.token));
  assert.equal(dl.status, 404);

  const src = await request(app)
    .get(`/v1/@${ownerNs}/hello/versions/1.0.0/source`)
    .set(bearer(created.body.token));
  assert.equal(src.status, 403);
  assert.match(src.body.detail, /missing the required "read:source" scope/);

  // With the scope the same account reads it, and a pending version with it.
  const granted = await request(app)
    .post('/v1/tokens')
    .set(bearer(adminToken))
    .send({ name: 'srcbot', scopes: ['read:source'] })
    .expect(201);
  const ok = await request(app)
    .get(`/v1/@${ownerNs}/hello/versions/1.0.0/source`)
    .set(bearer(granted.body.token))
    .expect(200);
  assert.match(ok.headers['content-type'], /gzip/);

  // The scope does not substitute for ownership, though: another account's
  // extension stays invisible to it.
  const stranger = await signupAndAccept(app, uniqNs());
  const strangerToken = await request(app)
    .post('/v1/tokens')
    .set(bearer(stranger.token))
    .send({ name: 'nosy', scopes: ['read:source'] })
    .expect(201);
  const denied = await request(app)
    .get(`/v1/@${ownerNs}/hello/versions/1.0.0/source`)
    .set(bearer(strangerToken.body.token));
  assert.equal(denied.status, 404);
});

test('published versions expose digest and integrity, served from /blobs/:digest', async () => {
  const { adminToken, ownerToken, ownerNs } = await makeAdminAndOwner();
  await publishProject(app, ownerNs, 'hello', ownerToken, { code: 'const DIGESTY = 42;' });
  const queue = await request(app).get('/v1/versions?status=pending').set(bearer(adminToken));
  const approved = await approveVersion(
    app,
    adminToken,
    ownerNs,
    'hello',
    queue.body.data[0].version,
  );
  assert.match(approved.body.dist.digest, /^sha256:[0-9a-f]{64}$/);
  assert.match(approved.body.dist.integrity, /^sha512-[A-Za-z0-9+/=]+$/);

  const compiled = (
    await request(app).get(`/v1/@${ownerNs}/hello/versions/1.0.0/download`).expect(200)
  ).text;

  const byDigest = await request(app)
    .get(`/v1/blobs/${approved.body.dist.digest.slice(7)}`)
    .expect(200);
  assert.equal(byDigest.text, compiled);
  assert.match(byDigest.headers['cache-control'], /immutable/);

  // Identical source under a new version is byte-deterministic: it shares the
  // same compiled blob (and the same digest) on disk.
  const second = await publishProject(app, ownerNs, 'hello', ownerToken, {
    version: '2.0.0',
    code: 'const DIGESTY = 42;',
  });
  assert.equal(second.body.status, 'published');
  assert.equal(second.body.dist.digest, approved.body.dist.digest);
  assert.equal(second.body.dist.integrity, approved.body.dist.integrity);

  const dir = (await boot()).config.dataDir;
  const digest = approved.body.dist.digest.slice(7);
  const blobFile = fs.readFileSync(
    path.join(dir, 'blobs', digest.slice(0, 2), digest.slice(2)),
    'utf8',
  );
  assert.equal(blobFile, compiled);
});

test('a version awaiting moderation is not served by digest', async () => {
  const { adminToken, ownerToken, ownerNs } = await makeAdminAndOwner();
  const published = await publishProject(app, ownerNs, 'hello', ownerToken);
  assert.equal(published.body.status, 'pending');
  // A pending version publishes no dist, so the digest comes from the row. It
  // is the whole address of the bytes: anyone can derive it from a build.
  const { sql } = await boot();
  const [row] = await sql`
    SELECT blob_digest FROM versions
    WHERE namespace = ${ownerNs} AND extension_id = 'hello' AND blob_digest IS NOT NULL
  `;
  assert.ok(row.blob_digest, 'the pending version should have compiled output');

  // A pending version is public until an admin approves it, so a check on
  // visibility alone would hand its compiled output to any caller holding the
  // digest. The status rule the download route applies has to come first.
  await request(app).get(`/v1/blobs/${row.blob_digest}`).expect(404);
  // Not to the owner either: the download route refuses them the same way.
  await request(app).get(`/v1/blobs/${row.blob_digest}`).set(bearer(ownerToken)).expect(404);
  // The moderation queue is where an unapproved version is meant to be read.
  await request(app).get(`/v1/blobs/${row.blob_digest}`).set(bearer(adminToken)).expect(200);
});

test('a version points at itself, its extension, its author and its bytes', async () => {
  const { adminToken, ownerToken, ownerNs } = await makeAdminAndOwner();
  await publishProject(app, ownerNs, 'hello', ownerToken);

  const queued = await request(app)
    .get('/v1/versions?status=pending')
    .set(bearer(adminToken))
    .expect(200);
  const pending = queued.body.data[0];
  assert.equal(pending.status, 'pending');
  assert.equal(pending._links.self, `/v1/@${ownerNs}/hello/versions/${pending.version}`);
  assert.equal(pending._links.extension, `/v1/@${ownerNs}/hello`);
  assert.equal(pending._links.author, `/v1/users/${ownerNs}`);
  // Nothing has been approved, so there are no bytes to point at yet.
  assert.equal(pending._links.download, undefined);
  // The source is there, though, and that is what a moderator reads.
  assert.equal(
    pending._links.source,
    pending.sourceUrl,
    'the source link and the source url are the same page',
  );

  await approveVersion(app, adminToken, ownerNs, 'hello', pending.version);
  const got = await request(app)
    .get(`/v1/@${ownerNs}/hello/versions/${pending.version}`)
    .expect(200);
  assert.equal(got.body._links.download, got.body.dist.downloadUrl);
  assert.equal(got.body._links.self, `/v1/@${ownerNs}/hello/versions/${pending.version}`);

  // Every link a version carries has to be a page that answers, or following it
  // is a 404 the client has to guess the meaning of.
  for (const [rel, url] of Object.entries(got.body._links)) {
    const link = await request(app)
      .get(url.replace(/^https?:\/\/[^/]+/, ''))
      .set(bearer(ownerToken));
    assert.equal(link.status, 200, `version ${rel} link: ${JSON.stringify(link.body)}`);
  }
});
