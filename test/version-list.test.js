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
  const owner = await signupAndAccept(app, uniqNs());
  const ns = owner.user.namespace;
  // The first publish is held for review; after its approval the rest go
  // straight to 'published'.
  const publish = async (version, approve) => {
    await publishProject(app, ns, 'ranger', owner.token, { version, code: `// ${version}` });
    if (approve) {
      await request(app)
        .patch(`/v1/@${ns}/ranger/versions/${version}`)
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

  const all = await request(app).get(`/v1/@${ns}/ranger/versions`).expect(200);
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
    const r = await request(app).get(`/v1/@${ns}/ranger/versions`).query({ range });
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
        .patch(`/v1/@${ons}/dep/versions/${version}`)
        .set(bearer(admin.token))
        .send({ status: 'approved' })
        .expect(200);
    }
  }
  await request(app)
    .patch(`/v1/@${ons}/dep/versions/1.1.0`)
    .set(bearer(owner.token))
    .send({ deprecationMessage: 'broken' })
    .expect(200);

  const r = await request(app).get(`/v1/@${ons}/dep/versions`).query({ range: '*' });
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
        .patch(`/v1/@${ns}/yank/versions/${version}`)
        .set(bearer(admin.token))
        .send({ status: 'approved' })
        .expect(200);
    }
  }
  await request(app).delete(`/v1/@${ns}/yank/versions/1.1.0`).set(bearer(owner.token)).expect(204);

  const r = await request(app).get(`/v1/@${ns}/yank/versions`).query({ range: '^1.0' });
  assert.equal(r.status, 200);
  assert.deepEqual(
    r.body.data.map((v) => v.version),
    ['1.0.0'],
  );
});

test('a range that matches nothing is an empty list, and a bad range is a 422', async () => {
  const { ns } = await makeSetup();

  const bad = await request(app).get(`/v1/@${ns}/ranger/versions`).query({ range: 'not-a-range' });
  assert.equal(bad.status, 422);
  assert.equal(bad.body.errors[0].field, 'range');

  // A filter that selects nothing is not a missing resource.
  const missing = await request(app).get(`/v1/@${ns}/ranger/versions`).query({ range: '^99.0.0' });
  assert.equal(missing.status, 200);
  assert.deepEqual(missing.body.data, []);
  assert.equal(missing.body._links.next, null);
});

test('the list pages by following its own links', async () => {
  const { ns } = await makeSetup();

  const first = await request(app).get(`/v1/@${ns}/ranger/versions?limit=2`).expect(200);
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
    .get(`/v1/@${ns}/ranger/versions`)
    .query({ cursor: 'not-a-cursor' });
  assert.equal(bad.status, 400);
});
