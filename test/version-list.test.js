import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {
  apiPath,
  bearer,
  boot,
  publishProject,
  resetDb,
  signupAndAccept,
  uniqNs,
} from './helpers.mjs';

let app;
let db;
before(async () => {
  ({ app, db } = await boot());
});
beforeEach(resetDb);
after(async () => {
  await db.$disconnect();
});

async function makeSetup() {
  const admin = await signupAndAccept(app, uniqNs());
  const owner = await signupAndAccept(app, uniqNs());
  const ns = owner.user.namespace;
  // The first publish is held for review; after its approval the rest go
  // straight to 'published'.
  const publish = async (version, approve) => {
    await publishProject(app, ns, 'ranger', owner.token, { version, code: `// ${version}` });
    if (approve) {
      await request(app)
        .patch(apiPath(`/@${ns}/ranger/versions/${version}`))
        .set(bearer(admin.token))
        .send({ status: 'approved' })
        .expect(200);
    }
  };
  for (const [version, approve] of [
    ['1.0.0', true],
    ['1.2.0', false],
    ['1.9.9', false],
    ['2.0.0', false],
  ]) {
    await publish(version, approve);
  }
  return { admin, owner, ns };
}

test('the version list is highest-first and range filters it', async () => {
  const { ns } = await makeSetup();

  const all = await request(app)
    .get(apiPath(`/@${ns}/ranger/versions`))
    .expect(200);
  assert.deepEqual(
    all.body.data.map((v) => v.version),
    ['2.0.0', '1.9.9', '1.2.0', '1.0.0'],
  );
  assert.equal(all.body._links.next, null);
  assert.equal(all.body._links.prev, null);

  for (const [range, expected] of [
    ['^1.2', ['1.9.9', '1.2.0']],
    ['~1.0', ['1.0.0']],
    ['<2', ['1.9.9', '1.2.0', '1.0.0']],
    ['>=1.0.0 <1.3.0', ['1.2.0', '1.0.0']],
    ['*', ['2.0.0', '1.9.9', '1.2.0', '1.0.0']],
    ['2.0.0', ['2.0.0']],
  ]) {
    const r = await request(app)
      .get(apiPath(`/@${ns}/ranger/versions`))
      .query({ range });
    assert.equal(r.status, 200, `range ${range}`);
    assert.deepEqual(
      r.body.data.map((v) => v.version),
      expected,
      `range ${range}`,
    );
    // The first entry is the one a range resolution used to return on its own.
    assert.equal(
      r.body.data[0].dist.downloadUrl.includes(`/versions/${expected[0]}/download`),
      true,
    );
  }
});

test('the list keeps deprecated versions in place, flagged', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const owner = await signupAndAccept(app, uniqNs());
  const ons = owner.user.namespace;
  for (const [version, approve] of [
    ['1.0.0', true],
    ['1.1.0', false],
  ]) {
    await publishProject(app, ons, 'dep', owner.token, { version, code: `// ${version}` });
    if (approve) {
      await request(app)
        .patch(apiPath(`/@${ons}/dep/versions/${version}`))
        .set(bearer(admin.token))
        .send({ status: 'approved' })
        .expect(200);
    }
  }
  await request(app)
    .patch(apiPath(`/@${ons}/dep/versions/1.1.0`))
    .set(bearer(owner.token))
    .send({ deprecationMessage: 'broken' })
    .expect(200);

  const r = await request(app)
    .get(apiPath(`/@${ons}/dep/versions`))
    .query({ range: '*' });
  assert.equal(r.status, 200);
  assert.deepEqual(
    r.body.data.map((v) => v.version),
    ['1.1.0', '1.0.0'],
  );
  assert.ok(r.body.data[0].deprecation);
  assert.equal('deprecation' in r.body.data[1], false);
});

test('yanked versions are not in the list at all', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const owner = await signupAndAccept(app, uniqNs());
  const ns = owner.user.namespace;
  for (const [version, approve] of [
    ['1.0.0', true],
    ['1.1.0', false],
  ]) {
    await publishProject(app, ns, 'yank', owner.token, { version, code: `// ${version}` });
    if (approve) {
      await request(app)
        .patch(apiPath(`/@${ns}/yank/versions/${version}`))
        .set(bearer(admin.token))
        .send({ status: 'approved' })
        .expect(200);
    }
  }
  await request(app)
    .delete(apiPath(`/@${ns}/yank/versions/1.1.0`))
    .set(bearer(owner.token))
    .expect(204);

  const r = await request(app)
    .get(apiPath(`/@${ns}/yank/versions`))
    .query({ range: '^1.0' });
  assert.equal(r.status, 200);
  assert.deepEqual(
    r.body.data.map((v) => v.version),
    ['1.0.0'],
  );
});

test('a range that matches nothing is an empty list, and a bad range is a 422', async () => {
  const { ns } = await makeSetup();

  const bad = await request(app)
    .get(apiPath(`/@${ns}/ranger/versions`))
    .query({ range: 'not-a-range' });
  assert.equal(bad.status, 422);
  assert.equal(bad.body.errors[0].field, 'range');

  // A filter that selects nothing is not a missing resource.
  const missing = await request(app)
    .get(apiPath(`/@${ns}/ranger/versions`))
    .query({ range: '^99.0.0' });
  assert.equal(missing.status, 200);
  assert.deepEqual(missing.body.data, []);
  assert.equal(missing.body._links.next, null);
});

test('the list pages by following its own links', async () => {
  const { ns } = await makeSetup();

  const first = await request(app)
    .get(apiPath(`/@${ns}/ranger/versions?limit=2`))
    .expect(200);
  assert.deepEqual(
    first.body.data.map((v) => v.version),
    ['2.0.0', '1.9.9'],
  );
  assert.ok(first.body._links.next);
  assert.equal(first.body._links.prev, null);

  const second = await request(app).get(first.body._links.next).expect(200);
  assert.deepEqual(
    second.body.data.map((v) => v.version),
    ['1.2.0', '1.0.0'],
  );
  assert.equal(second.body._links.next, null);

  // The last page can reach back, and the page before it points forward at the
  // one it was reached from.
  const back = await request(app).get(second.body._links.prev).expect(200);
  assert.deepEqual(
    back.body.data.map((v) => v.version),
    ['2.0.0', '1.9.9'],
  );
  assert.equal(back.body._links.next, second.body._links.self);
  assert.equal(back.body._links.prev, null);

  const bad = await request(app)
    .get(apiPath(`/@${ns}/ranger/versions`))
    .query({ cursor: 'not-a-cursor' });
  assert.equal(bad.status, 400);
});

test('an owner can list their own unpublished versions by status', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const owner = await signupAndAccept(app, uniqNs());
  const ns = owner.user.namespace;

  // The owner's first publish waits on review, so it lands as pending.
  await publishProject(app, ns, 'ranger', owner.token, { version: '1.0.0', code: '// 1.0.0' });
  await request(app)
    .patch(apiPath(`/@${ns}/ranger/versions/1.0.0`))
    .set(bearer(admin.token))
    .send({ status: 'rejected', reason: 'No loops.' })
    .expect(200);
  // A rejection clears the pending slot, so the next publish waits again.
  await publishProject(app, ns, 'ranger', owner.token, { version: '1.1.0', code: '// 1.1.0' });

  const pending = await request(app)
    .get(apiPath(`/@${ns}/ranger/versions`))
    .query({ status: 'pending' })
    .set(bearer(owner.token))
    .expect(200);
  assert.deepEqual(
    pending.body.data.map((v) => v.version),
    ['1.1.0'],
  );
  assert.equal(pending.body.data[0].status, 'pending');

  const rejected = await request(app)
    .get(apiPath(`/@${ns}/ranger/versions`))
    .query({ status: 'rejected' })
    .set(bearer(owner.token))
    .expect(200);
  assert.deepEqual(
    rejected.body.data.map((v) => v.version),
    ['1.0.0'],
  );
  assert.equal(rejected.body.data[0].rejectionReason, 'No loops.');

  // The reason also rides on the single-version read the list is matching.
  const one = await request(app)
    .get(apiPath(`/@${ns}/ranger/versions/1.0.0`))
    .set(bearer(owner.token))
    .expect(200);
  assert.equal(one.body.rejectionReason, 'No loops.');

  // The public view still shows neither: both are unpublished.
  const all = await request(app)
    .get(apiPath(`/@${ns}/ranger/versions`))
    .expect(200);
  assert.deepEqual(all.body.data, []);
});

test('an admin can filter any extension by status', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const owner = await signupAndAccept(app, uniqNs());
  const ns = owner.user.namespace;
  await publishProject(app, ns, 'ranger', owner.token, { version: '1.0.0', code: '// 1.0.0' });

  const r = await request(app)
    .get(apiPath(`/@${ns}/ranger/versions`))
    .query({ status: 'pending' })
    .set(bearer(admin.token))
    .expect(200);
  assert.deepEqual(
    r.body.data.map((v) => v.version),
    ['1.0.0'],
  );
});

for (const ownership of ['co-owner', 'organization co-owner', 'organization owner']) {
  test(`${ownership} can follow unpublished version self links`, async () => {
    const admin = await signupAndAccept(app, uniqNs());
    const owner = await signupAndAccept(app, uniqNs());
    const delegate = await signupAndAccept(app, uniqNs());
    const outsider = await signupAndAccept(app, uniqNs());
    let ns = owner.user.namespace;
    let grant = delegate.user;
    if (ownership !== 'co-owner') {
      const org = await request(app)
        .post(apiPath('/orgs'))
        .set(bearer(delegate.token))
        .send({ namespace: uniqNs(), displayName: 'Delegated owners' })
        .expect(201);
      grant = org.body;
      if (ownership === 'organization owner') ns = org.body.namespace;
    }
    await publishProject(
      app,
      ns,
      'ranger',
      ownership === 'organization owner' ? delegate.token : owner.token,
    );
    if (ownership === 'organization owner') {
      // Exercise namespace authority without an extension ownership row.
      await db.$executeRaw`DELETE FROM extension_owners WHERE namespace = ${ns} AND extension_id = 'ranger'`;
    } else {
      await db.$executeRaw`
        INSERT INTO extension_owners (owner_id, namespace, extension_id)
        SELECT id, ${ns}, 'ranger' FROM users WHERE namespace = ${grant.namespace}
      `;
    }

    for (const status of ['pending', 'rejected']) {
      if (status === 'rejected') {
        await request(app)
          .patch(apiPath(`/@${ns}/ranger/versions/1.0.0`))
          .set(bearer(admin.token))
          .send({ status, reason: 'Needs changes.' })
          .expect(200);
      }
      const list = await request(app)
        .get(apiPath(`/@${ns}/ranger/versions`))
        .query({ status })
        .set(bearer(delegate.token))
        .expect(200);
      assert.equal(list.body.data.length, 1);
      const self = list.body.data[0]._links.self;
      for (const token of [delegate.token, admin.token]) {
        const one = await request(app).get(self).set(bearer(token)).expect(200);
        assert.deepEqual(one.body, list.body.data[0]);
      }
      if (ns === owner.user.namespace) {
        await request(app).get(self).set(bearer(owner.token)).expect(200);
      }
      await request(app).get(self).expect(404);
      await request(app).get(self).set(bearer(outsider.token)).expect(404);
    }
  });
}

test('the status filter is owner-and-admin only, and rejects an unknown status', async () => {
  const owner = await signupAndAccept(app, uniqNs());
  const other = await signupAndAccept(app, uniqNs());
  const ns = owner.user.namespace;
  await publishProject(app, ns, 'ranger', owner.token, { version: '1.0.0', code: '// 1.0.0' });

  await request(app)
    .get(apiPath(`/@${ns}/ranger/versions`))
    .query({ status: 'pending' })
    .expect(401);
  await request(app)
    .get(apiPath(`/@${ns}/ranger/versions`))
    .query({ status: 'pending' })
    .set(bearer(other.token))
    .expect(403);

  const bad = await request(app)
    .get(apiPath(`/@${ns}/ranger/versions`))
    .query({ status: 'nonsense' })
    .set(bearer(owner.token));
  assert.equal(bad.status, 422);
  assert.equal(bad.body.errors[0].field, 'status');
});

test('a status filter needs the admin scope, not just the role', async () => {
  const ab = await signupAndAccept(app, uniqNs());
  assert.equal(ab.user.role, 'admin');
  const owner = await signupAndAccept(app, uniqNs());
  const ns = owner.user.namespace;
  await publishProject(app, ns, 'ranger', owner.token, { version: '1.0.0', code: '// 1.0.0' });

  const unscoped = await request(app)
    .post(apiPath('/tokens'))
    .set(bearer(ab.token))
    .send({ name: 'curious', scopes: ['publish'] })
    .expect(201);
  await request(app)
    .get(apiPath(`/@${ns}/ranger/versions`))
    .query({ status: 'pending' })
    .set(bearer(unscoped.body.token))
    .expect(403);
  await request(app)
    .get(apiPath(`/@${ns}/ranger/versions/1.0.0`))
    .set(bearer(unscoped.body.token))
    .expect(404);

  const scoped = await request(app)
    .post(apiPath('/tokens'))
    .set(bearer(ab.token))
    .send({ name: 'reviewer', scopes: ['admin'] })
    .expect(201);
  const r = await request(app)
    .get(apiPath(`/@${ns}/ranger/versions`))
    .query({ status: 'pending' })
    .set(bearer(scoped.body.token))
    .expect(200);
  assert.deepEqual(
    r.body.data.map((v) => v.version),
    ['1.0.0'],
  );
  await request(app).get(r.body.data[0]._links.self).set(bearer(scoped.body.token)).expect(200);
});
