import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {
  boot,
  resetDb,
  bearer,
  uniqNs,
  signup,
  signupAndAccept,
  publishProject,
  approveVersion,
  followPages,
  FIXTURE_PASSWORD,
} from './helpers.mjs';

let app;
before(async () => {
  // Every test here needs a handful of accounts, and the signup limiter counts
  // per connection address for a quarter of an hour without being reset by
  // resetDb, so a file this size would otherwise be signing itself out.
  ({ app } = await boot({
    rateLimits: {
      loginAttemptsPerWindow: 5,
      loginWindowMinutes: 15,
      signupsPerIpPerWindow: 10_000,
      signupWindowMinutes: 15,
    },
  }));
});
beforeEach(resetDb);
after(async () => {
  await (await boot()).sql.end();
});

// An owner may hold one queued version at a time, so a queue of N is N owners.
// This is the shape the admin queue is normally read in.
async function seedPending(count) {
  const admin = await signupAndAccept(app, uniqNs());
  for (let i = 0; i < count; i += 1) {
    const owner = await signupAndAccept(app, uniqNs());
    await publishProject(app, owner.user.namespace, `ext${i}`, owner.token, {
      version: '1.0.0',
      code: `// ext${i}`,
    });
  }
  return admin;
}

// One owner publishing several extensions would fill the queue and stall, so
// published extensions are spread across owners and approved one by one.
async function seedPublished(ids) {
  const admin = await signupAndAccept(app, uniqNs());
  for (const id of ids) {
    const owner = await signupAndAccept(app, uniqNs());
    const ns = owner.user.namespace;
    await publishProject(app, ns, id, owner.token, { version: '1.0.0', code: `// ${id}` });
    await approveVersion(app, admin.token, ns, id, '1.0.0');
  }
  return admin;
}

// A list that fits in one page is still a page: it says so with absent links
// rather than an empty object the client has to guess at.
test('a list that fits in one page offers no neighbours', async () => {
  await signupAndAccept(app, uniqNs());

  const r = await request(app).get('/v1/extensions').expect(200);
  assert.deepEqual(r.body._links, { self: '/v1/extensions', next: null, prev: null });
  assert.equal(r.body.pagination, undefined, 'the old cursor block is gone');
});

test('a list points back at itself, not at the cursor it was given', async () => {
  const { token } = await signupAndAccept(app, uniqNs());
  for (let i = 0; i < 3; i += 1) {
    await request(app)
      .post('/v1/sessions')
      .send({
        namespace: (await request(app).get('/v1/me').set(bearer(token))).body.namespace,
        password: FIXTURE_PASSWORD,
      })
      .expect(201);
  }

  const head = await request(app).get('/v1/sessions?limit=2').set(bearer(token)).expect(200);
  assert.equal(head.body._links.self, '/v1/sessions?limit=2');
  assert.equal(head.body._links.prev, null);

  const second = await request(app).get(head.body._links.next).set(bearer(token)).expect(200);
  // self is the page as it was requested, cursor and all.
  assert.equal(
    second.body._links.self,
    `/v1/sessions?limit=2&cursor=${new URL(second.body._links.self, 'http://x').searchParams.get('cursor')}`,
  );
  assert.match(second.body._links.self, /^\/v1\/sessions\?limit=2&cursor=/);
  assert.equal(second.body._links.next, null);
});

test('a filter survives the next and prev links', async () => {
  const admin = await seedPending(3);

  const queue = await request(app)
    .get('/v1/versions?status=pending&limit=2')
    .set(bearer(admin.token))
    .expect(200);
  assert.equal(queue.body.data.length, 2);
  // The link is a complete request, so the status filter the server insists on
  // has to be carried across; a client replaying it verbatim still gets a page.
  for (const part of ['status=pending', 'limit=2', 'cursor=']) {
    assert.ok(queue.body._links.next.includes(part), `${part} missing from next`);
  }
  const replayed = await request(app)
    .get(queue.body._links.next)
    .set(bearer(admin.token))
    .expect(200);
  assert.equal(replayed.body.data.length, 1);
});

// The point of the prev link: a client walks forward, changes its mind, and
// walks back without having kept a stack of the cursors it passed through.
test('walking back retraces the walk forward', async () => {
  const admin = await seedPending(3);

  const { rows: forward, pages } = await followPages(
    app,
    '/v1/versions?status=pending&limit=2',
    bearer(admin.token),
  );
  const ids = forward.map((v) => v.id);
  assert.equal(ids.length, 3, 'expected more than one page');
  assert.equal(new Set(ids).size, 3, 'no repeats going forward');

  const backwards = [...pages.at(-1).data];
  let link = pages.at(-1)._links.prev;
  while (link) {
    const page = await request(app).get(link).set(bearer(admin.token)).expect(200);
    backwards.unshift(...page.body.data);
    link = page.body._links.prev;
  }
  assert.deepEqual(
    backwards.map((v) => v.id),
    ids,
    'the reverse walk visits the same rows in the opposite order',
  );
});

// Each page and its neighbour are two halves of one loop, so a back link from a
// page and a next link from the page before it have to land on the same URL.
test('a page reached backwards points forward at where it came from', async () => {
  const admin = await seedPending(3);
  const list = (url) => request(app).get(url).set(bearer(admin.token)).expect(200);

  const first = await list('/v1/versions?status=pending&limit=2');
  const second = await list(first.body._links.next);
  const backToFirst = await list(second.body._links.prev);
  assert.deepEqual(
    backToFirst.body.data.map((v) => v.id),
    first.body.data.map((v) => v.id),
  );
  assert.equal(backToFirst.body._links.next, second.body._links.self);
  assert.equal(backToFirst.body._links.prev, null, 'the head of the list has nothing before it');
});

// An id-keyed list, the other common shape: newest first, and the tie is
// nothing at all because ids are unique.
test('an id-keyed list pages both ways', async () => {
  const { token } = await signupAndAccept(app, uniqNs());
  const ns = (await request(app).get('/v1/me').set(bearer(token))).body.namespace;
  for (let i = 0; i < 4; i += 1) {
    await request(app).post('/v1/sessions').send({ namespace: ns, password: FIXTURE_PASSWORD });
  }

  const { rows, pages } = await followPages(app, '/v1/sessions?limit=2', bearer(token));
  const ids = rows.map((s) => s.id).sort();
  assert.equal(new Set(ids).size, 5, 'four logins plus the one signup session');
  assert.equal(pages.length, 3);

  const backwards = [...pages.at(-1).data];
  let link = pages.at(-1)._links.prev;
  while (link) {
    const page = await request(app).get(link).set(bearer(token)).expect(200);
    backwards.unshift(...page.body.data);
    link = page.body._links.prev;
  }
  assert.deepEqual(backwards.map((s) => s.id).sort(), ids);
});

test('paging arguments are validated like any other', async () => {
  await signupAndAccept(app, uniqNs());
  for (const query of [{ dir: 'sideways' }, { dir: '' }, { cursor: 'not-a-cursor' }]) {
    const r = await request(app).get('/v1/extensions').query(query);
    assert.equal(r.status, 400, `${JSON.stringify(query)} should be rejected`);
    assert.equal(r.body.title, 'Bad Request');
  }
});

// A cursor is a promise about a position in one ordering, and this ordering
// reads A→Z, so a page taken backwards through it has to come back the same way
// round.
test('a sort that reads forwards pages backwards correctly too', async () => {
  await seedPublished(['alpha', 'bravo', 'charlie', 'delta']);

  const { rows, pages } = await followPages(app, '/v1/extensions?sort=name&limit=1');
  assert.deepEqual(
    rows.map((e) => e.id),
    ['alpha', 'bravo', 'charlie', 'delta'],
  );

  const backwards = [...pages.at(-1).data];
  let link = pages.at(-1)._links.prev;
  while (link) {
    const page = await request(app).get(link).expect(200);
    backwards.unshift(...page.body.data);
    link = page.body._links.prev;
  }
  assert.deepEqual(
    backwards.map((e) => e.id),
    ['alpha', 'bravo', 'charlie', 'delta'],
  );
});

// Offset paging cannot compare keys, so its neighbours are offsets. The links
// still have to close the loop the same way.
test('an offset-paged list closes the same loop', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const { user, token } = await signupAndAccept(app, uniqNs());
  // One extension, one owner, published in order: the first waits for review and
  // the rest go straight out, so one extension ends up with four versions.
  for (const version of ['1.0.0', '1.2.0', '1.9.9', '2.0.0']) {
    await publishProject(app, user.namespace, 'ranger', token, { version, code: `// ${version}` });
    if (version === '1.0.0')
      await approveVersion(app, admin.token, user.namespace, 'ranger', version);
  }

  const list = (url) => request(app).get(url).expect(200);
  const first = await list(`/v1/@${user.namespace}/ranger/versions?limit=3`);
  assert.deepEqual(
    first.body.data.map((v) => v.version),
    ['2.0.0', '1.9.9', '1.2.0'],
  );
  const second = await list(first.body._links.next);
  assert.deepEqual(
    second.body.data.map((v) => v.version),
    ['1.0.0'],
  );
  const back = await list(second.body._links.prev);
  assert.deepEqual(
    back.body.data.map((v) => v.version),
    ['2.0.0', '1.9.9', '1.2.0'],
  );
  assert.equal(back.body._links.next, second.body._links.self);
});

test('signup order and paging are independent of the caller', async () => {
  // The public account list is the one collection anyone can walk without a
  // token, so it is the one most likely to be walked by something unauthenticated.
  const first = await signup(app, uniqNs());
  const second = await signup(app, uniqNs());
  const third = await signup(app, uniqNs());

  const { rows, pages } = await followPages(app, '/v1/users?limit=2');
  assert.deepEqual(
    rows.map((u) => u.namespace),
    [third.body.user.namespace, second.body.user.namespace, first.body.user.namespace],
    'newest first',
  );
  assert.equal(pages.length, 2);
  assert.equal(pages[0]._links.prev, null);
  assert.equal(pages.at(-1)._links.next, null);
  // An outsider never sees the role or the terms state of another account.
  for (const user of rows) {
    assert.equal(user.role, undefined);
    assert.equal(user.termsAcceptedVersion, undefined);
  }
});
