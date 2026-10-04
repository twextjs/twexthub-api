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
  followPages,
} from './helpers.mjs';

let app;
before(async () => {
  ({ app } = await boot());
});
beforeEach(resetDb);
after(async () => {
  await (await boot()).sql.end();
});

function publish(nsToken, ns, id, version, extra = {}, status = 201) {
  return publishProject(
    app,
    ns,
    id,
    nsToken,
    {
      version,
      code: `// ${id} ${version}`,
      ...extra,
    },
    status,
  );
}

// First publish of an owner is pending; approve it to unlock auto-publishing.
async function approvePending(adminToken, ns, id) {
  const queue = await request(app)
    .get('/v1/versions?status=pending')
    .set(bearer(adminToken))
    .expect(200);
  const entry = queue.body.data.find((v) => v.namespace === ns && v.id === id);
  assert.ok(entry, 'pending entry present');
  const r = await request(app)
    .patch(`/v1/@${ns}/${id}/versions/${entry.version}`)
    .set(bearer(adminToken))
    .send({ status: 'approved' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return entry.version;
}

test('extensions lists published extensions, newest first, latest version each', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const owner = await signupAndAccept(app, uniqNs());
  const ns = owner.user.namespace;

  const alpha10 = await publish(owner.token, ns, 'alpha', '1.0.0');
  assert.equal(alpha10.body.status, 'pending');
  await approvePending(admin.token, ns, 'alpha');

  // Once approved, later publishes from the same owner skip review.
  await publish(owner.token, ns, 'beta', '1.0.0');
  await publish(owner.token, ns, 'alpha', '1.1.0');

  const r = await request(app).get('/v1/extensions').expect(200);
  assert.deepEqual(
    r.body.data.map((e) => e.id),
    ['alpha', 'beta'],
  );
  const byId = Object.fromEntries(r.body.data.map((e) => [e.id, e.version]));
  assert.deepEqual(Object.keys(byId).sort(), ['alpha', 'beta']);
  assert.equal(byId.alpha, '1.1.0');
  assert.equal(byId.beta, '1.0.0');
  assert.equal(r.body._links.next, null);
});

test('search filters by name/id/namespace', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const owner = await signupAndAccept(app, uniqNs());
  const ns = owner.user.namespace;

  await publish(owner.token, ns, 'banana', '1.0.0', {
    description: 'yellow fruit',
    name: 'Sweet Banana',
  });
  await approvePending(admin.token, ns, 'banana');
  await publish(owner.token, ns, 'grape', '1.0.0', { description: 'purple fruit' });

  const id = await request(app).get('/v1/search?query=banana').expect(200);
  assert.equal(id.body.data.length, 1);
  assert.equal(id.body.data[0].id, 'banana');

  const byName = await request(app).get('/v1/search?query=Sweet').expect(200);
  assert.equal(byName.body.data.length, 1);
  assert.equal(byName.body.data[0].id, 'banana');

  const byNs = await request(app).get(`/v1/search?query=${ns}`).expect(200);
  assert.deepEqual(byNs.body.data.map((e) => e.id).sort(), ['banana', 'grape']);

  const desc = await request(app).get('/v1/search?query=purple').expect(200);
  assert.equal(desc.body.data[0].id, 'grape');

  const none = await request(app).get('/v1/search?query=zzzz').expect(200);
  assert.equal(none.body.data.length, 0);
});

test('extensions pagination cursor walks all pages', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const owner = await signupAndAccept(app, uniqNs());
  const ns = owner.user.namespace;

  await publish(owner.token, ns, 'ext0', '1.0.0');
  await approvePending(admin.token, ns, 'ext0');
  for (let i = 1; i < 5; i += 1) {
    await publish(owner.token, ns, 'ext' + i, '1.0.0');
  }

  const { rows, pages } = await followPages(app, '/v1/extensions?limit=2');

  const seen = rows.map((e) => e.id);
  assert.equal(seen.length, 5);
  assert.equal(new Set(seen).size, 5);
  assert.ok(
    pages.every((p) => p.data.length <= 2),
    'a page went over the limit',
  );
  // The head of the list has nowhere before it and the tail nowhere after it.
  assert.equal(pages[0]._links.prev, null);
  assert.equal(pages.at(-1)._links.next, null);
  assert.ok(
    pages.slice(1).every((p) => p._links.prev !== null),
    'a page past the first should offer a way back',
  );
  assert.equal(pages[0]._links.self, '/v1/extensions?limit=2');
});

// The recent and updated sorts key their cursors on whole microseconds, so a
// page and its neighbours can share a millisecond of publish time without the
// cursor rounding one of them away: walking one row at a time has to visit
// every extension exactly once, in both directions.
test('recent and updated cursors survive same-millisecond publishes', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const owner = await signupAndAccept(app, uniqNs());
  const ns = owner.user.namespace;

  await publish(owner.token, ns, 'ext0', '1.0.0');
  await approvePending(admin.token, ns, 'ext0');
  // Published back to back inside the same clock tick: under a
  // millisecond-precision cursor this ordering ties and pages skip or repeat
  // rows.
  for (let i = 1; i < 5; i += 1) {
    await publish(owner.token, ns, 'ext' + i, '1.0.0');
  }

  for (const sort of ['recent', 'updated']) {
    const { rows, pages } = await followPages(app, `/v1/extensions?sort=${sort}&limit=1`);
    const seen = rows.map((e) => e.id);
    assert.equal(new Set(seen).size, seen.length, `${sort}: an id repeated across pages`);
    assert.equal(seen.length, 5, `${sort}: a page walked over or under the set`);
    assert.ok(
      pages.slice(1).every((p) => p._links.prev !== null),
      `${sort}: a page past the first should offer a way back`,
    );

    // Back down the same list via each page's own prev link: the union of the
    // two walks is the whole set and no id is visited twice.
    const backwards = [...pages.at(-1).data];
    let link = pages.at(-1)._links.prev;
    while (link) {
      const page = await request(app).get(link).expect(200);
      backwards.unshift(...page.body.data);
      link = page.body._links.prev;
    }
    assert.deepEqual(
      backwards.map((e) => e.id),
      seen,
      `${sort}: the backward walk is the forward walk in reverse`,
    );
  }
});

test('stats reports published count, pending, and authors', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const owner = await signupAndAccept(app, uniqNs());
  const ns = owner.user.namespace;

  await publish(owner.token, ns, 'aaa', '1.0.0');
  let stats = await request(app).get('/v1/stats').expect(200);
  assert.equal(stats.body.published, 0);
  assert.equal(stats.body.pending, 1);

  await approvePending(admin.token, ns, 'aaa');
  await publish(owner.token, ns, 'bbb', '1.0.0');

  stats = await request(app).get('/v1/stats').expect(200);
  assert.equal(stats.body.published, 2);
  assert.equal(stats.body.pending, 0);
  assert.equal(stats.body.authors, 1);
});

test('terms and privacy documents are public', async () => {
  const terms = await request(app).get('/v1/terms').expect(200);
  assert.equal(terms.body.version, 1);
  assert.equal(typeof terms.body.body, 'string');
  assert.equal(typeof terms.body.updatedAt, 'string');

  const privacy = await request(app).get('/v1/privacy').expect(200);
  assert.equal(privacy.body.version, 1);
});

test('accepting terms on the user records the version that was read', async () => {
  const { token, user } = await signupAndAccept(app, uniqNs());
  const me = await request(app).get('/v1/me').set(bearer(token)).expect(200);
  assert.equal(me.body.termsAcceptedVersion, 1);

  // The version has to be the one the account was shown, so a stale acceptance
  // is refused rather than quietly recorded.
  const stale = await request(app)
    .patch(`/v1/users/${user.namespace}`)
    .set(bearer(token))
    .send({ termsAcceptedVersion: 99 });
  assert.equal(stale.status, 422);
  assert.equal(stale.body.errors[0].field, 'termsAcceptedVersion');
  assert.match(stale.body.errors[0].message, /current terms version 1/);
});

test('publish without accepting terms is forbidden', async () => {
  const r = await request(app)
    .post('/v1/users')
    .send({ namespace: uniqNs(), password: 'password123', displayName: 'd' });
  const { token } = r.body;
  const pub = await publish(token, r.body.user.namespace, 'aaa', '1.0.0', {}, 403);
  assert.equal(pub.status, 403);
  assert.match(pub.body.detail, /Terms/i);
});
