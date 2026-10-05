import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { blobPathFor } from '../src/blobs.js';
import { sourcePathFor } from '../src/sources.js';
import request from 'supertest';
import sharp from 'sharp';
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
let config;

// The sandbox resolver cannot invent a host, and a hook URL is resolved and
// checked before it is stored, so a created hook has to name a real one.
const PUBLIC_URL = 'https://example.com/twext-hook';

before(async () => {
  // An organization draws from the signup bucket the same as an account, and
  // these tests want more than the default five of them.
  ({ app, sql, config } = await boot({ rateLimits: { signupsPerIpPerWindow: 10_000 } }));
});
beforeEach(resetDb);
after(async () => {
  await sql.end();
});

async function org(body = {}) {
  const owner = await signupAndAccept(app, uniqNs());
  const namespace = body.namespace ?? uniqNs();
  const created = await request(app)
    .post('/v1/orgs')
    .set(bearer(owner.token))
    .send({ namespace, displayName: 'Acme Inc', ...body });
  assert.equal(created.status, 201, `org create failed: ${JSON.stringify(created.body)}`);
  return { ns: namespace, owner, ...created.body };
}

describe('creating an organization', () => {
  test('the creator is its first owner and it cannot sign in', async () => {
    const { ns, owner } = await org();

    const read = await request(app).get(`/v1/orgs/${ns}`).expect(200);
    assert.equal(read.body.namespace, ns);
    assert.equal(read.body.displayName, 'Acme Inc');
    assert.equal(read.body.bio, '');
    // An organization is a profile, not an account: no role, no password, no
    // terms of its own to be represented in the response.
    assert.equal(read.body.role, undefined);
    assert.equal(read.body.kind, undefined);

    const owners = await request(app).get(`/v1/orgs/${ns}/owners`).expect(200);
    assert.deepEqual(
      owners.body.data.map((row) => row.namespace),
      [owner.user.namespace],
    );

    // No password means no session: signing in has to say what the namespace is
    // rather than report bad credentials.
    const login = await request(app)
      .post('/v1/sessions')
      .send({ namespace: ns, password: 'correct-horse-battery-staple' });
    assert.equal(login.status, 403);
    assert.match(login.body.detail, /organization/);
  });

  test('an empty display name falls back to the namespace and preserves profile fields', async () => {
    const created = await org({ displayName: '', bio: 'Our team', github: 'acme' });
    assert.equal(created.displayName, created.ns);
    assert.equal(created.bio, 'Our team');
    assert.equal(created.github, 'acme');
    const read = await request(app).get(`/v1/orgs/${created.ns}`).expect(200);
    assert.equal(read.body.displayName, created.ns);
  });

  test('the namespace is shared with accounts', async () => {
    const owner = await signupAndAccept(app, uniqNs());
    const ns = uniqNs();
    const taken = await request(app)
      .post('/v1/orgs')
      .set(bearer(owner.token))
      .send({ namespace: ns })
      .expect(201);

    const clash = await request(app)
      .post('/v1/orgs')
      .set(bearer(owner.token))
      .send({ namespace: ns });
    assert.equal(clash.status, 409);

    // ...and an account cannot be signed up over one either.
    const account = await request(app)
      .post('/v1/users')
      .send({ namespace: ns, password: 'correct-horse-battery-staple' });
    assert.equal(account.status, 409);
    assert.equal(taken.body.namespace, ns);
  });

  test('profile fields are validated and stored', async () => {
    const owner = await signupAndAccept(app, uniqNs());
    const ns = uniqNs();
    const bad = await request(app)
      .post('/v1/orgs')
      .set(bearer(owner.token))
      .send({ namespace: ns, website: 'javascript:alert(1)', bio: 'x'.repeat(281) });
    assert.equal(bad.status, 422);
    assert.deepEqual(bad.body.errors.map((e) => e.field).sort(), ['bio', 'website']);

    const created = await request(app)
      .post('/v1/orgs')
      .set(bearer(owner.token))
      .send({
        namespace: ns,
        displayName: 'Acme',
        bio: 'We make things.',
        website: 'https://acme.test',
        github: 'acme',
      })
      .expect(201);
    assert.equal(created.body.bio, 'We make things.');
    assert.equal(created.body.website, 'https://acme.test');
    assert.equal(created.body.github, 'acme');
  });

  test('creation needs a session, accepted terms, and an account', async () => {
    await request(app).post('/v1/orgs').send({ namespace: uniqNs() }).expect(401);

    const owner = await signupAndAccept(app, uniqNs());
    const latecomer = await request(app)
      .post('/v1/users')
      .send({ namespace: uniqNs(), password: 'correct-horse-battery-staple' })
      .expect(201);
    // The terms gate is the same one that guards a publish: an organization
    // that nobody has agreed to the terms for should not go out.
    const gated = await request(app)
      .post('/v1/orgs')
      .set(bearer(latecomer.body.token))
      .send({ namespace: uniqNs() });
    assert.equal(gated.status, 403);
    assert.ok(owner.token);
  });

  test('managing organizations needs the manage:orgs scope', async () => {
    const { ns, owner } = await org();
    const created = await request(app)
      .post('/v1/tokens')
      .set(bearer(owner.token))
      .send({ name: 'automation', scopes: ['publish', 'yank'] })
      .expect(201);
    for (const [method, route, body] of [
      ['post', '/v1/orgs', { namespace: uniqNs() }],
      ['patch', `/v1/orgs/${ns}`, { bio: 'Changed' }],
      ['delete', `/v1/orgs/${ns}`],
      ['put', `/v1/orgs/${ns}/owners/${owner.user.namespace}`],
      ['delete', `/v1/orgs/${ns}/owners/${owner.user.namespace}`],
      ['get', `/v1/orgs/${ns}/webhooks`],
      ['post', `/v1/orgs/${ns}/webhooks`, { url: PUBLIC_URL, events: ['version.published'] }],
      ['delete', `/v1/orgs/${ns}/webhooks/1`],
    ]) {
      const client = request(app);
      const denied = await client[method](route)
        .set(bearer(created.body.token))
        .send(body)
        .expect(403);
      assert.match(denied.body.detail, /missing the required "manage:orgs" scope/);
    }
  });

  test('the list is public and pages', async () => {
    const a = await org();
    const b = await org();
    const list = await request(app).get('/v1/orgs').expect(200);
    assert.deepEqual(list.body.data.map((row) => row.namespace).sort(), [a.ns, b.ns].sort());
    assert.ok(list.body._links);
  });
});

describe('changing an organization', () => {
  test('an owner edits the profile, an outsider and another account do not', async () => {
    const { ns, owner } = await org();
    const outsider = await signupAndAccept(app, uniqNs());

    const updated = await request(app)
      .patch(`/v1/orgs/${ns}`)
      .set(bearer(owner.token))
      .send({ displayName: 'Acme Corp', bio: 'Now with a website.', website: null })
      .expect(200);
    assert.equal(updated.body.displayName, 'Acme Corp');
    assert.equal(updated.body.website, null);

    await request(app)
      .patch(`/v1/orgs/${ns}`)
      .set(bearer(outsider.token))
      .send({ displayName: 'Hijacked' })
      .expect(403);

    // An account of the same name is not the organization: /orgs/:ns is only
    // reachable for kind = 'organization'.
    await request(app).patch(`/v1/orgs/${ns}`).send({ displayName: 'x' }).expect(401);
  });

  test('an empty or invalid patch is rejected', async () => {
    const { ns, owner } = await org();
    await request(app).patch(`/v1/orgs/${ns}`).set(bearer(owner.token)).send({}).expect(422);
    const bad = await request(app)
      .patch(`/v1/orgs/${ns}`)
      .set(bearer(owner.token))
      .send({ github: 'not a username' });
    assert.equal(bad.status, 422);
    assert.equal(bad.body.errors[0].field, 'github');
  });

  test('the account routes refuse to touch an organization', async () => {
    const { ns, owner } = await org();
    const patched = await request(app)
      .patch(`/v1/users/${ns}`)
      .set(bearer(owner.token))
      .send({ displayName: 'Via users' });
    assert.equal(patched.status, 403);
    assert.match(patched.body.detail, /organization/);

    const removed = await request(app)
      .delete(`/v1/users/${ns}`)
      .set(bearer(owner.token))
      .expect(403);
    assert.match(removed.body.detail, /organization/);
  });

  test('the public user shows an organization without account fields', async () => {
    const { ns } = await org();
    const read = await request(app).get(`/v1/users/${ns}`).expect(200);
    assert.equal(read.body.kind, 'organization');
    assert.equal(read.body.role, undefined);
    assert.equal(read.body.termsAcceptedVersion, undefined);
    assert.equal(read.body.displayName, 'Acme Inc');
  });

  test('an admin is an owner of every organization', async () => {
    const admin = await signupAndAccept(app, uniqNs());
    await request(app)
      .patch(`/v1/users/${admin.user.namespace}`)
      .set(bearer(admin.token))
      .send({ role: 'admin' })
      .expect(200);
    const { ns } = await org();

    // No row in the owner list and no need for one: the admin reaches every
    // organization the same way an extension's owners reach their extension.
    const read = await request(app)
      .patch(`/v1/orgs/${ns}`)
      .set(bearer(admin.token))
      .send({ bio: 'edited by an admin' })
      .expect(200);
    assert.equal(read.body.bio, 'edited by an admin');
    const owners = await request(app).get(`/v1/orgs/${ns}/owners`).expect(200);
    assert.equal(owners.body.data.length, 1);
  });

  test('deleting the organization takes its namespace with it', async () => {
    const { ns, owner } = await org();
    await request(app).delete(`/v1/orgs/${ns}`).set(bearer(owner.token)).expect(204);
    await request(app).get(`/v1/orgs/${ns}`).expect(404);
    await request(app).get(`/v1/users/${ns}`).expect(404);
  });

  test('organization deletion clears namespace state at either transfer endpoint', async () => {
    const { ns, owner } = await org();
    const outside = owner.user.namespace;
    const [account] = await sql`SELECT id FROM users WHERE namespace = ${outside}`;
    for (const namespace of [ns, outside]) {
      await sql`INSERT INTO dist_tags (owner_id, namespace, extension_id, tag, version)
        VALUES (${account.id}, ${namespace}, 'cleanup', 'latest', '1.0.0')`;
      await sql`INSERT INTO extension_owners (owner_id, namespace, extension_id)
        VALUES (${account.id}, ${namespace}, 'cleanup')`;
      await sql`INSERT INTO extension_owner_invites (owner_id, namespace, extension_id)
        VALUES (${account.id}, ${namespace}, 'cleanup')`;
      await sql`INSERT INTO download_events (namespace, extension_id, version)
        VALUES (${namespace}, 'cleanup', '1.0.0')`;
      await sql`INSERT INTO extension_daily_downloads (namespace, extension_id, day)
        VALUES (${namespace}, 'cleanup', current_date)`;
    }
    for (const [from, to] of [
      [ns, outside],
      [outside, ns],
      [outside, outside],
    ]) {
      await sql`INSERT INTO extension_transfers (namespace, extension_id, to_namespace, requested_by)
        VALUES (${from}, 'cleanup', ${to}, ${account.id})`;
      await sql`INSERT INTO extension_redirects (from_namespace, from_extension_id, to_namespace, to_extension_id)
        VALUES (${from}, ${to}, ${to}, 'cleanup')`;
    }

    await request(app).delete(`/v1/orgs/${ns}`).set(bearer(owner.token)).expect(204);

    for (const table of [
      'dist_tags',
      'extension_owners',
      'extension_owner_invites',
      'download_events',
      'extension_daily_downloads',
      'extension_transfers',
    ]) {
      const rows = await sql`SELECT namespace FROM ${sql(table)}`;
      assert.deepEqual(
        rows.map((row) => row.namespace),
        [outside],
        table,
      );
    }
    const redirects = await sql`
      SELECT from_namespace, to_namespace FROM extension_redirects
      WHERE from_namespace IN (${ns}, ${outside}) OR to_namespace IN (${ns}, ${outside})
    `;
    assert.deepEqual([...redirects], [{ from_namespace: outside, to_namespace: outside }]);
  });

  test('organization deletion removes published files and both kinds of webhook', async () => {
    const { ns, owner } = await org();
    await publishProject(app, ns, 'cleanup', owner.token);
    const [version] = await sql`SELECT * FROM versions WHERE namespace = ${ns}`;
    for (const extensionId of [null, 'cleanup']) {
      const [hook] = await sql`
        INSERT INTO webhooks (namespace, extension_id, url, secret)
        VALUES (${ns}, ${extensionId}, ${PUBLIC_URL}, 'test-secret') RETURNING id
      `;
      await sql`
        INSERT INTO webhook_deliveries (webhook_id, event, payload, body, signature)
        VALUES (${hook.id}, 'version.published', '{}', '{}', 'test-signature')
      `;
    }
    await request(app).delete(`/v1/orgs/${ns}`).set(bearer(owner.token)).expect(204);
    assert.equal((await sql`SELECT 1 FROM versions WHERE namespace = ${ns}`).length, 0);
    assert.equal((await sql`SELECT 1 FROM webhooks WHERE namespace = ${ns}`).length, 0);
    assert.equal((await sql`SELECT 1 FROM webhook_deliveries`).length, 0);
    await assert.rejects(stat(blobPathFor(config.dataDir, version.blob_digest)), {
      code: 'ENOENT',
    });
    await assert.rejects(stat(sourcePathFor(config.dataDir, version.source_digest)), {
      code: 'ENOENT',
    });
    await request(app).get(`/v1/users/${owner.user.namespace}`).expect(200);
  });
});

describe('owners', () => {
  test('a second owner can edit the organization and its extensions', async () => {
    const { ns, owner } = await org();
    const coowner = await signupAndAccept(app, uniqNs());

    await request(app)
      .put(`/v1/orgs/${ns}/owners/${coowner.user.namespace}`)
      .set(bearer(owner.token))
      .expect(204);

    // Adding yourself again is a no-op rather than a duplicate row.
    await request(app)
      .put(`/v1/orgs/${ns}/owners/${coowner.user.namespace}`)
      .set(bearer(coowner.token))
      .expect(204);
    const owners = await request(app).get(`/v1/orgs/${ns}/owners`).expect(200);
    assert.equal(owners.body.data.length, 2);

    await request(app)
      .patch(`/v1/orgs/${ns}`)
      .set(bearer(coowner.token))
      .send({ bio: 'edited by a co-owner' })
      .expect(200);

    const notes = await request(app)
      .get('/v1/notifications')
      .set(bearer(coowner.token))
      .expect(200);
    assert.equal(notes.body.data.length, 1);
    assert.match(notes.body.data[0].message, /manage @/);
    assert.ok(!/manage @.*\//.test(notes.body.data[0].message));
  });

  test('only an owner may add or remove owners', async () => {
    const { ns, owner } = await org();
    const outsider = await signupAndAccept(app, uniqNs());
    const candidate = await signupAndAccept(app, uniqNs());

    await request(app)
      .put(`/v1/orgs/${ns}/owners/${candidate.user.namespace}`)
      .set(bearer(outsider.token))
      .expect(403);
    await request(app)
      .delete(`/v1/orgs/${ns}/owners/${owner.user.namespace}`)
      .set(bearer(outsider.token))
      .expect(403);
  });

  test('an organization cannot own another organization', async () => {
    const { ns, owner } = await org();
    const other = await org();
    const refused = await request(app)
      .put(`/v1/orgs/${ns}/owners/${other.ns}`)
      .set(bearer(owner.token));
    assert.equal(refused.status, 422);
    assert.equal(refused.body.errors[0].field, 'namespace');
  });

  test('the last owner cannot be removed', async () => {
    const { ns, owner } = await org();
    const coowner = await signupAndAccept(app, uniqNs());
    await request(app)
      .put(`/v1/orgs/${ns}/owners/${coowner.user.namespace}`)
      .set(bearer(owner.token))
      .expect(204);

    // With two owners the co-owner can step down, and the creator cannot
    // follow them out.
    await request(app)
      .delete(`/v1/orgs/${ns}/owners/${coowner.user.namespace}`)
      .set(bearer(coowner.token))
      .expect(204);
    const refused = await request(app)
      .delete(`/v1/orgs/${ns}/owners/${owner.user.namespace}`)
      .set(bearer(owner.token));
    assert.equal(refused.status, 409);
    assert.match(refused.body.detail, /only owner/);

    const notes = await request(app)
      .get('/v1/notifications')
      .set(bearer(coowner.token))
      .expect(200);
    assert.match(notes.body.data[0].message, /removed as an owner/);
  });

  test('removing a non-owner returns 404 even when there is only one owner', async () => {
    const { ns, owner } = await org();
    const outsider = await signupAndAccept(app, uniqNs());
    await request(app)
      .delete(`/v1/orgs/${ns}/owners/${outsider.user.namespace}`)
      .set(bearer(owner.token))
      .expect(404);
  });

  for (const actions of [
    ['remove', 'remove'],
    ['delete', 'delete'],
    ['remove', 'delete'],
  ]) {
    test(`concurrent ${actions.join(' and ')} preserves the last owner`, async () => {
      const { ns, owner } = await org();
      const coowner = await signupAndAccept(app, uniqNs());
      await request(app)
        .put(`/v1/orgs/${ns}/owners/${coowner.user.namespace}`)
        .set(bearer(owner.token))
        .expect(204);
      const accounts = [owner, coowner];
      const responses = await Promise.all(
        actions.map((action, i) => {
          const account = accounts[i];
          const route =
            action === 'remove'
              ? `/v1/orgs/${ns}/owners/${account.user.namespace}`
              : `/v1/users/${account.user.namespace}`;
          return request(app).delete(route).set(bearer(account.token));
        }),
      );
      assert.deepEqual(responses.map((r) => r.status).sort(), [204, 409]);
      const owners = await request(app).get(`/v1/orgs/${ns}/owners`).expect(200);
      assert.equal(owners.body.data.length, 1);
      const retained = accounts[responses.findIndex((r) => r.status === 409)];
      assert.equal(owners.body.data[0].namespace, retained.user.namespace);
      await request(app).get(`/v1/users/${retained.user.namespace}`).expect(200);
    });
  }

  test('deleting a co-owner refunds each namespace for cascaded versions', async () => {
    const first = await org();
    const admin = first.owner;
    const publisher = await signupAndAccept(app, uniqNs());
    const organizations = [first, await org()];
    for (const [index, { ns, owner }] of organizations.entries()) {
      const id = `removed${index}`;
      await request(app)
        .put(`/v1/orgs/${ns}/owners/${publisher.user.namespace}`)
        .set(bearer(owner.token))
        .expect(204);
      await publishProject(app, ns, id, publisher.token, { code: 'const removed = 1;' });
      await approveVersion(app, admin.token, ns, id, '1.0.0');
      await publishProject(app, ns, 'retained', owner.token, { code: 'const retained = 2;' });
    }
    const removed = await sql`SELECT * FROM versions WHERE extension_id LIKE 'removed%'`;
    await request(app)
      .delete(`/v1/users/${publisher.user.namespace}`)
      .set(bearer(publisher.token))
      .expect(204);
    for (const { ns } of organizations) {
      const rows = await sql`SELECT * FROM versions WHERE namespace = ${ns}`;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].extension_id, 'retained');
      const [account] = await sql`SELECT blob_bytes FROM users WHERE namespace = ${ns}`;
      assert.equal(
        Number(account.blob_bytes),
        Number(rows[0].blob_size) + Number(rows[0].source_size),
      );
      await stat(blobPathFor(config.dataDir, rows[0].blob_digest));
      await stat(sourcePathFor(config.dataDir, rows[0].source_digest));
    }
    for (const row of removed) {
      await assert.rejects(stat(blobPathFor(config.dataDir, row.blob_digest)), { code: 'ENOENT' });
      await assert.rejects(stat(sourcePathFor(config.dataDir, row.source_digest)), {
        code: 'ENOENT',
      });
    }
  });

  test('an account that is the last owner of an organization cannot be deleted', async () => {
    const { ns, owner } = await org();
    const refused = await request(app)
      .delete(`/v1/users/${owner.user.namespace}`)
      .set(bearer(owner.token));
    assert.equal(refused.status, 409);
    assert.match(refused.body.detail, new RegExp(`@${ns}`));

    // With a co-owner in place the same deletion goes through, and the owner
    // list loses the row.
    const coowner = await signupAndAccept(app, uniqNs());
    await request(app)
      .put(`/v1/orgs/${ns}/owners/${coowner.user.namespace}`)
      .set(bearer(owner.token))
      .expect(204);
    await request(app)
      .delete(`/v1/users/${owner.user.namespace}`)
      .set(bearer(owner.token))
      .expect(204);
    const owners = await request(app).get(`/v1/orgs/${ns}/owners`).expect(200);
    assert.deepEqual(
      owners.body.data.map((row) => row.namespace),
      [coowner.user.namespace],
    );
  });
});

describe('extensions', () => {
  test('organization owners manage extension invitations and owners', async () => {
    const admin = await signupAndAccept(app, uniqNs());
    const { ns, owner } = await org();
    const manager = await signupAndAccept(app, uniqNs());
    const candidate = await signupAndAccept(app, uniqNs());
    await request(app)
      .put(`/v1/orgs/${ns}/owners/${manager.user.namespace}`)
      .set(bearer(owner.token))
      .expect(204);
    await publishProject(app, ns, 'secret', owner.token);
    await approveVersion(app, admin.token, ns, 'secret', '1.0.0');
    const extensionPath = `/v1/@${ns}/secret`;
    const ownerPath = `${extensionPath}/owners/${candidate.user.namespace}`;

    await request(app).put(ownerPath).set(bearer(manager.token)).expect(204);
    const pending = await request(app)
      .get(`${extensionPath}/owners/pending`)
      .set(bearer(candidate.token))
      .expect(200);
    assert.deepEqual(
      pending.body.data.map((row) => row.namespace),
      [candidate.user.namespace],
    );
    await request(app).delete(ownerPath).set(bearer(manager.token)).expect(204);
    await request(app).post(`${ownerPath}/accept`).set(bearer(candidate.token)).expect(404);

    await request(app).put(ownerPath).set(bearer(manager.token)).expect(204);
    await request(app).post(`${ownerPath}/accept`).set(bearer(candidate.token)).expect(200);
    const owners = await request(app).get(`${extensionPath}/owners`).expect(200);
    assert.ok(owners.body.data.some((row) => row.namespace === candidate.user.namespace));
    await request(app).delete(ownerPath).set(bearer(manager.token)).expect(204);
    await request(app)
      .delete(`${extensionPath}/owners/${ns}`)
      .set(bearer(manager.token))
      .expect(422);
  });

  test('outsiders, removed organization owners and extension co-owners cannot manage namespace grants', async () => {
    await signupAndAccept(app, uniqNs());
    const { ns, owner } = await org();
    const formerOwner = await signupAndAccept(app, uniqNs());
    const outsider = await signupAndAccept(app, uniqNs());
    const coowner = await signupAndAccept(app, uniqNs());
    const candidate = await signupAndAccept(app, uniqNs());
    await request(app)
      .put(`/v1/orgs/${ns}/owners/${formerOwner.user.namespace}`)
      .set(bearer(owner.token))
      .expect(204);
    await request(app)
      .delete(`/v1/orgs/${ns}/owners/${formerOwner.user.namespace}`)
      .set(bearer(owner.token))
      .expect(204);
    await publishProject(app, ns, 'hello', owner.token);
    const extensionPath = `/v1/@${ns}/hello`;
    await request(app)
      .put(`${extensionPath}/owners/${coowner.user.namespace}`)
      .set(bearer(owner.token))
      .expect(204);
    await request(app)
      .post(`${extensionPath}/owners/${coowner.user.namespace}/accept`)
      .set(bearer(coowner.token))
      .expect(200);
    await request(app)
      .put(`${extensionPath}/owners/${candidate.user.namespace}`)
      .set(bearer(owner.token))
      .expect(204);

    for (const actor of [outsider, formerOwner, coowner]) {
      await request(app)
        .put(`${extensionPath}/owners/${outsider.user.namespace}`)
        .set(bearer(actor.token))
        .expect(403);
      for (const target of [candidate, coowner]) {
        await request(app)
          .delete(`${extensionPath}/owners/${target.user.namespace}`)
          .set(bearer(actor.token))
          .expect(403);
      }
    }

    await request(app)
      .post(`${extensionPath}/owners/${candidate.user.namespace}/accept`)
      .set(bearer(candidate.token))
      .expect(200);
    await request(app)
      .delete(`${extensionPath}/owners/${coowner.user.namespace}`)
      .set(bearer(owner.token))
      .expect(204);
  });

  test('an organization owner publishes, and the list is scoped to it', async () => {
    const admin = await signupAndAccept(app, uniqNs());
    const { ns, owner } = await org();
    await publishProject(app, ns, 'widget', owner.token);
    await approveVersion(app, admin.token, ns, 'widget', '1.0.0');

    const list = await request(app).get(`/v1/orgs/${ns}/extensions`).expect(200);
    assert.deepEqual(
      list.body.data.map((row) => `${row.namespace}/${row.id}`),
      [`${ns}/widget`],
    );

    // The same filter is available on the registry listing, and the two agree.
    const registry = await request(app).get(`/v1/extensions?namespace=${ns}`).expect(200);
    assert.deepEqual(
      registry.body.data.map((row) => `${row.namespace}/${row.id}`),
      [`${ns}/widget`],
    );

    const bad = await request(app).get('/v1/extensions?namespace=Not Valid');
    assert.equal(bad.status, 400);
  });
});

describe('webhooks', () => {
  test('an organization hook hears every extension under the namespace', async () => {
    const admin = await signupAndAccept(app, uniqNs());
    const { ns, owner } = await org();
    const url = PUBLIC_URL;
    const created = await request(app)
      .post(`/v1/orgs/${ns}/webhooks`)
      .set(bearer(owner.token))
      .send({ url, events: ['version.published'] })
      .expect(201);
    assert.ok(created.body.secret, 'the secret is returned once, at creation');
    assert.equal(created.body.extension_id, null, 'the hook names no single extension');

    const list = await request(app).get(`/v1/orgs/${ns}/webhooks`).set(bearer(owner.token));
    assert.equal(list.body.data.length, 1);
    assert.equal(list.body.data[0].secret, undefined, 'listing never returns the secret');

    // The first version in a namespace is held for review and the next one is
    // published on arrival, so this walks both paths: approval is what fires the
    // event for the first, the publish itself fires it for the second.
    for (const id of ['one', 'two']) {
      const published = await publishProject(app, ns, id, owner.token);
      if (published.body.status === 'pending') {
        await approveVersion(app, admin.token, ns, id, published.body.version);
      }
    }
    // Scheduling is fire-and-forget, so give it the tick it takes to insert.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const deliveries = await sql`
      SELECT d.event, d.payload
      FROM webhook_deliveries d
      JOIN webhooks w ON w.id = d.webhook_id
      WHERE w.namespace = ${ns} AND w.extension_id IS NULL
      ORDER BY d.id
    `;
    assert.deepEqual(deliveries.map((row) => row.payload.id).sort(), ['one', 'two']);
    for (const row of deliveries) {
      assert.equal(row.event, 'version.published');
      assert.equal(row.payload.namespace, ns);
      assert.match(row.payload.message, new RegExp(`^@${ns}/`));
    }
  });

  test('a hook on one extension is not the organization hook', async () => {
    const { ns, owner } = await org();
    const created = await request(app)
      .post(`/v1/orgs/${ns}/webhooks`)
      .set(bearer(owner.token))
      .send({ url: PUBLIC_URL, events: ['version.published'] })
      .expect(201);
    const orgHookId = created.body.id;

    await publishProject(app, ns, 'one', owner.token);

    // The per-extension collection is a different scope, so the namespace-wide
    // hook must not turn up in it...
    const perExtension = await request(app)
      .get(`/v1/@${ns}/one/webhooks`)
      .set(bearer(owner.token))
      .expect(200);
    assert.deepEqual(perExtension.body.data, []);

    // ...and deleting the id from either collection is refused when it belongs
    // to the other one.
    const wrongScope = await request(app)
      .delete(`/v1/@${ns}/one/webhooks/${orgHookId}`)
      .set(bearer(owner.token))
      .expect(404);
    assert.equal(wrongScope.status, 404);

    await request(app)
      .delete(`/v1/orgs/${ns}/webhooks/${orgHookId}`)
      .set(bearer(owner.token))
      .expect(204);
    await request(app)
      .get(`/v1/orgs/${ns}/webhooks`)
      .set(bearer(owner.token))
      .expect(200)
      .expect((r) => assert.deepEqual(r.body.data, []));
  });

  test('only an owner manages the hooks', async () => {
    const { ns } = await org();
    const outsider = await signupAndAccept(app, uniqNs());
    await request(app)
      .post(`/v1/orgs/${ns}/webhooks`)
      .set(bearer(outsider.token))
      .send({ url: PUBLIC_URL, events: ['version.published'] })
      .expect(403);
    await request(app).get(`/v1/orgs/${ns}/webhooks`).set(bearer(outsider.token)).expect(403);
  });

  test('hook input is validated the same way as an extension hook', async () => {
    const { ns, owner } = await org();
    const badEvents = await request(app)
      .post(`/v1/orgs/${ns}/webhooks`)
      .set(bearer(owner.token))
      .send({ url: PUBLIC_URL, events: ['nope'] });
    assert.equal(badEvents.status, 422);
    assert.equal(badEvents.body.errors[0].field, 'events');

    const badUrl = await request(app)
      .post(`/v1/orgs/${ns}/webhooks`)
      .set(bearer(owner.token))
      .send({ url: 'https://localhost:9911/hook', events: ['version.published'] });
    assert.equal(badUrl.status, 422);
    assert.equal(badUrl.body.errors[0].field, 'url');
  });
});

describe('images', () => {
  test('an avatar is served under /orgs and the identicon is the fallback', async () => {
    const { ns } = await org();
    const identicon = await request(app).get(`/v1/orgs/${ns}/avatar`).expect(200);
    assert.match(identicon.headers['content-type'], /svg/);

    const orgProfile = await request(app).get(`/v1/orgs/${ns}`).expect(200);
    // Nothing uploaded and nothing linked: the body says so rather than
    // pointing at the identicon, which is what an account reports too.
    assert.equal(orgProfile.body.avatarUrl, null);
    assert.equal(orgProfile.body.bannerUrl, null);
  });

  test('an owner may replace the image and the URL names the bytes', async () => {
    const { ns, owner } = await org();
    const outsider = await signupAndAccept(app, uniqNs());
    const png = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 9, g: 8, b: 7 } },
    })
      .png()
      .toBuffer();

    await request(app)
      .put(`/v1/orgs/${ns}/avatar`)
      .set(bearer(outsider.token))
      .set('Content-Type', 'image/png')
      .send(png)
      .expect(403);

    const uploaded = await request(app)
      .put(`/v1/orgs/${ns}/avatar`)
      .set(bearer(owner.token))
      .set('Content-Type', 'image/png')
      .send(png)
      .expect(200);
    const url = new URL(uploaded.body.avatarUrl);
    assert.equal(url.pathname, `/v1/orgs/${ns}/avatar`);
    assert.ok(url.searchParams.get('v'), 'the published URL names the exact bytes');

    const fetched = await request(app)
      .get(url.pathname + url.search)
      .expect(200);
    assert.equal(fetched.headers['cache-control'], 'public, max-age=31536000, immutable');

    await request(app).delete(`/v1/orgs/${ns}/avatar`).set(bearer(owner.token)).expect(200);
    const cleared = await request(app).get(`/v1/orgs/${ns}`).expect(200);
    assert.equal(cleared.body.avatarUrl, null);
  });
});
