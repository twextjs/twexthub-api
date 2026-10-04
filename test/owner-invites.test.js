import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {
  approveVersion,
  bearer,
  boot,
  publishProject,
  resetDb,
  signupAndAccept,
  uniqNs,
} from './helpers.mjs';

let app;
let sql;

before(async () => {
  ({ app, sql } = await boot());
});
beforeEach(resetDb);
after(async () => {
  await sql.end();
});

async function makeOrg() {
  const owner = await signupAndAccept(app, uniqNs());
  const ns = uniqNs();
  const created = await request(app)
    .post('/v1/orgs')
    .set(bearer(owner.token))
    .send({ namespace: ns, displayName: 'Acme Inc' });
  assert.equal(created.status, 201, `org create failed: ${JSON.stringify(created.body)}`);
  return { ns, owner };
}

async function addOrgOwner(org, who) {
  await request(app)
    .put(`/v1/orgs/${org.ns}/owners/${who.user.namespace}`)
    .set(bearer(org.owner.token))
    .expect(204);
}

// An account with one approved public version. The admin is signed up first
// because the first account created after a reset is the one that gets the role.
async function publishedExtension(id = 'hello', opts = {}) {
  const admin = await signupAndAccept(app, uniqNs());
  const owner = await signupAndAccept(app, uniqNs());
  await publishProject(app, owner.user.namespace, id, owner.token, {
    code: `// ${id}@1.0.0`,
    ...opts,
  });
  await approveVersion(app, admin.token, owner.user.namespace, id, '1.0.0');
  return { ns: owner.user.namespace, owner, admin };
}

const ownerNames = async (ns, id) =>
  (await request(app).get(`/v1/@${ns}/${id}/owners`).expect(200)).body.data.map(
    (row) => row.namespace,
  );

const pendingFor = async (ns, id, token) =>
  (
    await request(app).get(`/v1/@${ns}/${id}/owners/pending`).set(bearer(token)).expect(200)
  ).body.data.map((row) => row.namespace);

const invite = (ns, id, who, token) =>
  request(app).put(`/v1/@${ns}/${id}/owners/${who}`).set(bearer(token)).expect(204);

const accept = (ns, id, who, token) =>
  request(app).post(`/v1/@${ns}/${id}/owners/${who}/accept`).set(bearer(token)).expect(200);

const notifications = async (token) =>
  (await request(app).get('/v1/notifications').set(bearer(token)).expect(200)).body.data;

describe('an invitation grants nothing until it is accepted', () => {
  test('concurrent acceptances grant ownership only once', async () => {
    const { ns, owner } = await publishedExtension();
    const candidate = await signupAndAccept(app, uniqNs());
    await invite(ns, 'hello', candidate.user.namespace, owner.token);
    const attempts = [];
    await sql.begin(async (tx) => {
      await tx`LOCK TABLE extension_owner_invites IN SHARE MODE`;
      for (let i = 0; i < 2; i += 1) {
        attempts.push(
          request(app)
            .post(`/v1/@${ns}/hello/owners/${candidate.user.namespace}/accept`)
            .set(bearer(candidate.token))
            .then((response) => response),
        );
      }
      // Hold both DELETEs until each request has read the pending invitation.
      const deadline = Date.now() + 5000;
      while (true) {
        const [{ waiting }] = await sql`
          SELECT count(*)::int AS waiting FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND query LIKE '%DELETE FROM extension_owner_invites%'
        `;
        if (waiting === 2) break;
        assert.ok(Date.now() < deadline, 'both acceptances should reach the claim');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    });
    const responses = await Promise.all(attempts);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 404]);
    assert.ok((await ownerNames(ns, 'hello')).includes(candidate.user.namespace));
  });

  test('publishing is refused before acceptance and allowed after', async () => {
    const { ns, owner } = await publishedExtension();
    const candidate = await signupAndAccept(app, uniqNs());
    const stranger = await signupAndAccept(app, uniqNs());

    await invite(ns, 'hello', candidate.user.namespace, owner.token);

    assert.ok(!(await ownerNames(ns, 'hello')).includes(candidate.user.namespace));
    await publishProject(
      app,
      ns,
      'hello',
      candidate.token,
      { version: '2.0.0', code: '// x' },
      403,
    );

    await accept(ns, 'hello', candidate.user.namespace, candidate.token);

    assert.ok((await ownerNames(ns, 'hello')).includes(candidate.user.namespace));
    await publishProject(app, ns, 'hello', candidate.token, {
      version: '2.0.0',
      code: '// hello@2.0.0',
    });

    // Accepting is the invited account's own move.
    const other = await signupAndAccept(app, uniqNs());
    await invite(ns, 'hello', other.user.namespace, owner.token);
    await request(app)
      .post(`/v1/@${ns}/hello/owners/${other.user.namespace}/accept`)
      .set(bearer(stranger.token))
      .expect(403);
  });

  test('the candidate sees the invitation waiting and a retry is idempotent', async () => {
    const { ns, owner } = await publishedExtension();
    const candidate = await signupAndAccept(app, uniqNs());

    await invite(ns, 'hello', candidate.user.namespace, owner.token);
    await invite(ns, 'hello', candidate.user.namespace, owner.token);

    const pending = await request(app)
      .get(`/v1/@${ns}/hello/owners/pending`)
      .set(bearer(candidate.token))
      .expect(200);
    assert.deepEqual(pending.body.data, [
      {
        namespace: candidate.user.namespace,
        display_name: candidate.user.namespace,
        kind: 'user',
        created_at: pending.body.data[0].created_at,
        invited_by: ns,
      },
    ]);

    // Three invitations, one notification: a retried request does not announce
    // itself three times.
    const notes = await notifications(candidate.token);
    assert.equal(notes.length, 1);
    assert.match(notes[0].message, /accept management of/);

    // Nobody else can read it.
    const stranger = await signupAndAccept(app, uniqNs());
    assert.deepEqual(await pendingFor(ns, 'hello', stranger.token), []);
  });

  test('the namespace account cannot be invited', async () => {
    const { ns, owner } = await publishedExtension();
    await request(app).put(`/v1/@${ns}/hello/owners/${ns}`).set(bearer(owner.token)).expect(422);
  });

  test('a co-owner cannot invite a third party', async () => {
    const { ns, owner } = await publishedExtension();
    const coOwner = await signupAndAccept(app, uniqNs());
    await invite(ns, 'hello', coOwner.user.namespace, owner.token);
    await accept(ns, 'hello', coOwner.user.namespace, coOwner.token);

    // Being able to publish is not standing for the address: the invitation is
    // the namespace account's to send, and an admin's.
    const third = await signupAndAccept(app, uniqNs());
    await request(app)
      .put(`/v1/@${ns}/hello/owners/${third.user.namespace}`)
      .set(bearer(coOwner.token))
      .expect(403);
    assert.ok(!(await ownerNames(ns, 'hello')).includes(third.user.namespace));
    assert.deepEqual(await pendingFor(ns, 'hello', third.token), []);
  });
});

describe('an organization as an extension owner', () => {
  test('any of its owners accepts, and every one of them can then publish', async () => {
    const { ns, owner } = await publishedExtension();
    const acme = await makeOrg();
    const partner = await signupAndAccept(app, uniqNs());

    await invite(ns, 'hello', acme.ns, owner.token);

    // The organization has no session, so nothing has changed yet.
    assert.ok(!(await ownerNames(ns, 'hello')).includes(acme.ns));
    // The organization's own owner sees it; the namespace account, who sent it,
    // does not need to.
    assert.deepEqual(await pendingFor(ns, 'hello', acme.owner.token), [acme.ns]);
    assert.deepEqual(await pendingFor(ns, 'hello', owner.token), []);

    // An account that is not on the organization's owner list cannot see the
    // invitation or speak for it, however well it knows the extension.
    assert.deepEqual(await pendingFor(ns, 'hello', partner.token), []);
    await request(app)
      .post(`/v1/@${ns}/hello/owners/${acme.ns}/accept`)
      .set(bearer(partner.token))
      .expect(403);

    await addOrgOwner(acme, partner);
    assert.deepEqual(await pendingFor(ns, 'hello', partner.token), [acme.ns]);
    await accept(ns, 'hello', acme.ns, partner.token);

    assert.ok((await ownerNames(ns, 'hello')).includes(acme.ns));
    const listed = (await request(app).get(`/v1/@${ns}/hello/owners`).expect(200)).body.data.find(
      (row) => row.namespace === acme.ns,
    );
    assert.equal(listed.kind, 'organization');
    assert.deepEqual(await pendingFor(ns, 'hello', acme.owner.token), []);

    // The partner knows; the account that accepted does not need telling.
    assert.ok(
      (await notifications(acme.owner.token)).some((row) => /can now manage/.test(row.message)),
    );

    await publishProject(app, ns, 'hello', acme.owner.token, {
      version: '2.0.0',
      code: '// hello@2.0.0',
    });
    await publishProject(app, ns, 'hello', partner.token, {
      version: '3.0.0',
      code: '// hello@3.0.0',
    });
  });

  test('the grant reaches the private surface and the listing filter', async () => {
    const { ns, owner } = await publishedExtension('secret', { visibility: 'private' });
    const acme = await makeOrg();
    const outsider = await signupAndAccept(app, uniqNs());

    const seen = async (token) =>
      (await request(app).get(`/v1/extensions?namespace=${ns}`).set(bearer(token)).expect(200)).body
        .data.length;
    await request(app).get(`/v1/@${ns}/secret`).set(bearer(acme.owner.token)).expect(404);
    assert.equal(await seen(acme.owner.token), 0);

    await invite(ns, 'secret', acme.ns, owner.token);
    await accept(ns, 'secret', acme.ns, acme.owner.token);

    const detail = await request(app)
      .get(`/v1/@${ns}/secret`)
      .set(bearer(acme.owner.token))
      .expect(200);
    assert.equal(detail.body.namespace, ns);
    assert.equal(await seen(acme.owner.token), 1);

    // A private extension stays out of everyone else's hands, and the address
    // is still the account's, not the organization's.
    assert.equal(await seen(outsider.token), 0);
    await request(app).get(`/v1/@${ns}/secret`).set(bearer(outsider.token)).expect(404);
    const orgListing = await request(app)
      .get(`/v1/extensions?namespace=${acme.ns}`)
      .set(bearer(acme.owner.token))
      .expect(200);
    assert.equal(orgListing.body.data.length, 0);
  });

  test('deleting the organization drops the row it held', async () => {
    const { ns, owner } = await publishedExtension();
    const acme = await makeOrg();
    await invite(ns, 'hello', acme.ns, owner.token);
    await accept(ns, 'hello', acme.ns, acme.owner.token);
    assert.ok((await ownerNames(ns, 'hello')).includes(acme.ns));

    await request(app).delete(`/v1/orgs/${acme.ns}`).set(bearer(acme.owner.token)).expect(204);

    assert.ok(!(await ownerNames(ns, 'hello')).includes(acme.ns));
    await publishProject(
      app,
      ns,
      'hello',
      acme.owner.token,
      { version: '2.0.0', code: '// x' },
      403,
    );
  });
});

describe('withdrawing', () => {
  test('a withdrawn invitation cannot be accepted', async () => {
    const { ns, owner } = await publishedExtension();
    const candidate = await signupAndAccept(app, uniqNs());
    await invite(ns, 'hello', candidate.user.namespace, owner.token);

    await request(app)
      .delete(`/v1/@${ns}/hello/owners/${candidate.user.namespace}`)
      .set(bearer(owner.token))
      .expect(204);

    assert.ok((await notifications(candidate.token)).some((row) => /withdrawn/.test(row.message)));
    await request(app)
      .post(`/v1/@${ns}/hello/owners/${candidate.user.namespace}/accept`)
      .set(bearer(candidate.token))
      .expect(404);
    await publishProject(
      app,
      ns,
      'hello',
      candidate.token,
      { version: '2.0.0', code: '// x' },
      403,
    );

    // Nothing left to withdraw or remove.
    await request(app)
      .delete(`/v1/@${ns}/hello/owners/${candidate.user.namespace}`)
      .set(bearer(owner.token))
      .expect(404);
  });

  test('removing an accepted organization revokes it for every one of its owners', async () => {
    const { ns, owner } = await publishedExtension();
    const acme = await makeOrg();
    const partner = await signupAndAccept(app, uniqNs());
    await addOrgOwner(acme, partner);
    await invite(ns, 'hello', acme.ns, owner.token);
    await accept(ns, 'hello', acme.ns, acme.owner.token);
    await publishProject(app, ns, 'hello', acme.owner.token, {
      version: '2.0.0',
      code: '// hello@2.0.0',
    });

    await request(app)
      .delete(`/v1/@${ns}/hello/owners/${acme.ns}`)
      .set(bearer(owner.token))
      .expect(204);

    for (const token of [acme.owner.token, partner.token]) {
      await publishProject(app, ns, 'hello', token, { version: '3.0.0', code: '// x' }, 403);
    }
  });

  test('deleting the extension clears the invitations waiting on it', async () => {
    const { ns, owner } = await publishedExtension();
    const candidate = await signupAndAccept(app, uniqNs());
    await invite(ns, 'hello', candidate.user.namespace, owner.token);

    await request(app).delete(`/v1/@${ns}/hello`).set(bearer(owner.token)).expect(204);

    const [{ count }] = await sql`SELECT count(*)::int AS count FROM extension_owner_invites`;
    assert.equal(count, 0);
    await request(app)
      .post(`/v1/@${ns}/hello/owners/${candidate.user.namespace}/accept`)
      .set(bearer(candidate.token))
      .expect(404);
  });
});
