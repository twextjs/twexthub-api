import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { acceptTransfer, loadNamespaceAccount } from '../src/transfer.js';
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
  await request(app)
    .post('/v1/orgs')
    .set(bearer(owner.token))
    .send({ namespace: ns, displayName: 'Acme Inc' })
    .expect(201);
  return { ns, owner };
}

async function addOrgOwner(org, who) {
  await request(app)
    .put(`/v1/orgs/${org.ns}/owners/${who.user.namespace}`)
    .set(bearer(org.owner.token))
    .expect(204);
}

// The admin is signed up first because the first account created after a reset
// is the one that gets the role, and the sender has to be an established
// namespace for the first version to publish without review.
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

const offer = (from, id, to, token) =>
  request(app).post(`/v1/@${from}/${id}/transfers`).set(bearer(token)).send({ to });

const accept = (from, id, to, token) =>
  request(app).post(`/v1/@${from}/${id}/transfers/${to}/accept`).set(bearer(token)).expect(200);

const notifications = async (token) =>
  (await request(app).get('/v1/notifications').set(bearer(token)).expect(200)).body.data;

const versions = async (ns, id) =>
  (await request(app).get(`/v1/@${ns}/${id}/versions`).expect(200)).body.data.map(
    (row) => row.version,
  );

// An address that has been moved answers 301, so a test that wants to know what
// lives there has to expect that rather than a body.
const versionsMoved = async (ns, id, to) => {
  const r = await request(app).get(`/v1/@${ns}/${id}/versions`).expect(301);
  assert.equal(r.headers.location, `/v1/@${to}/${id}/versions`);
  return versions(to, id);
};

describe('the recipient decides', () => {
  test('an offer grants nothing until it is accepted', async () => {
    const { ns, owner } = await publishedExtension();
    const other = await signupAndAccept(app, uniqNs());

    await offer(ns, 'hello', other.user.namespace, owner.token).expect(201);

    // Nothing has moved. The extension is still where it was, and the prospective
    // owner cannot touch it.
    assert.deepEqual(await versions(ns, 'hello'), ['1.0.0']);
    assert.deepEqual(await versions(other.user.namespace, 'hello'), []);
    await publishProject(app, ns, 'hello', other.token, { version: '2.0.0', code: '// x' }, 403);

    await accept(ns, 'hello', other.user.namespace, other.token);

    assert.deepEqual(await versionsMoved(ns, 'hello', other.user.namespace), ['1.0.0']);
    assert.deepEqual(await versions(other.user.namespace, 'hello'), ['1.0.0']);
    await publishProject(app, other.user.namespace, 'hello', other.token, {
      version: '2.0.0',
      code: '// hello@2.0.0',
    });
  });

  test('neither the sender nor a stranger can accept it', async () => {
    const { ns, owner, admin } = await publishedExtension();
    const other = await signupAndAccept(app, uniqNs());
    const stranger = await signupAndAccept(app, uniqNs());
    await offer(ns, 'hello', other.user.namespace, owner.token).expect(201);

    for (const token of [owner.token, stranger.token]) {
      await request(app)
        .post(`/v1/@${ns}/hello/transfers/${other.user.namespace}/accept`)
        .set(bearer(token))
        .expect(403);
    }
    // An admin stands for either side, so it is allowed.
    await accept(ns, 'hello', other.user.namespace, admin.token);
  });

  test('only the recipient sees the offer waiting, and it can be withdrawn', async () => {
    const { ns, owner } = await publishedExtension();
    const other = await signupAndAccept(app, uniqNs());
    await offer(ns, 'hello', other.user.namespace, owner.token).expect(201);

    const pending = (token) =>
      request(app).get(`/v1/@${ns}/hello/transfers`).set(bearer(token)).expect(200);

    const seen = (await pending(other.token).then((r) => r.body.data)).map((row) => row.to);
    assert.deepEqual(seen, [other.user.namespace]);
    assert.deepEqual(
      (await pending(owner.token).then((r) => r.body.data)).map((r) => r.to),
      [],
    );

    const notes = await notifications(other.token);
    assert.equal(notes.length, 1);
    assert.match(notes[0].message, /was offered to/);

    await request(app)
      .delete(`/v1/@${ns}/hello/transfers/${other.user.namespace}`)
      .set(bearer(owner.token))
      .expect(204);

    assert.deepEqual(
      (await pending(other.token).then((r) => r.body.data)).map((row) => row.to),
      [],
    );
    assert.ok((await notifications(other.token)).some((row) => /withdrawn/.test(row.message)));
    await request(app)
      .post(`/v1/@${ns}/hello/transfers/${other.user.namespace}/accept`)
      .set(bearer(other.token))
      .expect(404);
  });

  test('a co-owner cannot transfer the extension away from its address', async () => {
    const { ns, owner } = await publishedExtension();
    const coOwner = await signupAndAccept(app, uniqNs());
    await request(app)
      .put(`/v1/@${ns}/hello/owners/${coOwner.user.namespace}`)
      .set(bearer(owner.token))
      .expect(204);
    await request(app)
      .post(`/v1/@${ns}/hello/owners/${coOwner.user.namespace}/accept`)
      .set(bearer(coOwner.token))
      .expect(200);

    // It can publish to somebody else's extension, but moving that extension out
    // from under the address is not its call to make.
    const third = await signupAndAccept(app, uniqNs());
    await offer(ns, 'hello', third.user.namespace, coOwner.token).expect(403);
  });
});

describe('the old address redirects', () => {
  test('publishing to a transferred address is rejected', async () => {
    const { ns, owner } = await publishedExtension();
    const other = await signupAndAccept(app, uniqNs());
    await offer(ns, 'hello', other.user.namespace, owner.token).expect(201);
    await accept(ns, 'hello', other.user.namespace, other.token);

    const rejected = await publishProject(app, ns, 'hello', owner.token, { version: '2.0.0' }, 409);
    assert.match(rejected.body.detail, /transferred away/);
    assert.equal((await sql`SELECT 1 FROM versions WHERE namespace = ${ns}`).length, 0);
    assert.deepEqual(await versionsMoved(ns, 'hello', other.user.namespace), ['1.0.0']);
  });

  test('a pinned address keeps resolving, and the query string comes along', async () => {
    const { ns, owner } = await publishedExtension();
    const other = await signupAndAccept(app, uniqNs());
    await offer(ns, 'hello', other.user.namespace, owner.token).expect(201);
    await accept(ns, 'hello', other.user.namespace, other.token);

    const detail = await request(app).get(`/v1/@${ns}/hello`).expect(301);
    assert.equal(detail.headers.location, `/v1/@${other.user.namespace}/hello`);

    const version = await request(app).get(`/v1/@${ns}/hello/versions/1.0.0`).expect(301);
    assert.equal(version.headers.location, `/v1/@${other.user.namespace}/hello/versions/1.0.0`);

    const download = await request(app)
      .get(`/v1/@${ns}/hello/versions/latest/download`)
      .expect(301);
    assert.equal(
      download.headers.location,
      `/v1/@${other.user.namespace}/hello/versions/latest/download`,
    );

    // A cursor is part of the URL, not the body, so dropping it would quietly
    // reset somebody's page to the first one.
    const paged = await request(app).get(`/v1/@${ns}/hello/versions?limit=5`).expect(301);
    assert.equal(paged.headers.location, `/v1/@${other.user.namespace}/hello/versions?limit=5`);

    // Following it lands on the extension.
    const followed = await request(app).get(detail.headers.location).expect(200);
    assert.equal(followed.body.namespace, other.user.namespace);
  });

  test('a redirect points at the address the extension moved to', async () => {
    const { ns, owner } = await publishedExtension('secret');
    const other = await signupAndAccept(app, uniqNs());
    await offer(ns, 'secret', other.user.namespace, owner.token).expect(201);
    await accept(ns, 'secret', other.user.namespace, other.token);

    const mine = await request(app).get(`/v1/@${ns}/secret`).set(bearer(other.token)).expect(301);
    assert.equal(mine.headers.location, `/v1/@${other.user.namespace}/secret`);

    // Following it lands on the extension.
    const followed = await request(app).get(mine.headers.location).expect(200);
    assert.equal(followed.body.namespace, other.user.namespace);
  });

  test('a second transfer collapses onto the final address', async () => {
    const { ns, owner } = await publishedExtension();
    const second = await signupAndAccept(app, uniqNs());
    const third = await signupAndAccept(app, uniqNs());

    await offer(ns, 'hello', second.user.namespace, owner.token).expect(201);
    await accept(ns, 'hello', second.user.namespace, second.token);
    await offer(second.user.namespace, 'hello', third.user.namespace, second.token).expect(201);
    await accept(second.user.namespace, 'hello', third.user.namespace, third.token);

    // The first address points at the last one, not at the middle hop, so
    // resolving is a single lookup and no chain can be walked into a cycle.
    const hop = await request(app).get(`/v1/@${ns}/hello`).expect(301);
    assert.equal(hop.headers.location, `/v1/@${third.user.namespace}/hello`);
    assert.equal((await request(app).get(hop.headers.location)).status, 200);

    const [{ hops }] = await sql`
      SELECT count(*)::int AS hops FROM extension_redirects WHERE to_namespace = ${ns}
    `;
    assert.equal(hops, 0);
  });

  test('an address that has moved cannot receive a different extension', async () => {
    const { ns, owner } = await publishedExtension();
    const second = await signupAndAccept(app, uniqNs());
    await offer(ns, 'hello', second.user.namespace, owner.token).expect(201);
    await accept(ns, 'hello', second.user.namespace, second.token);

    // @second/hello is now a redirect, and an address can only ever be one thing.
    // Somebody else who happens to publish their own `hello` cannot be delivered
    // into it, or the address would resolve to two different extensions.
    const third = await signupAndAccept(app, uniqNs());
    await publishProject(app, third.user.namespace, 'hello', third.token, {
      code: '// theirs@1.0.0',
    });
    await offer(third.user.namespace, 'hello', second.user.namespace, third.token).expect(409);
  });
});

describe('what the move refuses', () => {
  test('a destination that already has the extension', async () => {
    const { ns, owner } = await publishedExtension();
    const other = await signupAndAccept(app, uniqNs());
    await publishProject(app, other.user.namespace, 'hello', other.token, {
      code: '// theirs@1.0.0',
    });

    await offer(ns, 'hello', other.user.namespace, owner.token).expect(409);
  });

  test('a destination with no room, checked when the offer is made and again on accept', async () => {
    const { ns, owner } = await publishedExtension();
    const other = await signupAndAccept(app, uniqNs());
    const admin = await signupAndAccept(app, uniqNs());

    // The extension's real size, so the limit is set below it rather than at a
    // guessed number of bytes.
    const [size] = await sql`
      SELECT COALESCE(SUM(blob_size + source_size), 0)::int AS bytes
      FROM versions WHERE namespace = ${ns} AND extension_id = 'hello'
    `;
    assert.ok(size.bytes > 0);
    await sql`UPDATE users SET max_blob_bytes = ${size.bytes - 1} WHERE namespace = ${other.user.namespace}`;

    const refused = await offer(ns, 'hello', other.user.namespace, owner.token).expect(409);
    assert.match(refused.body.detail, /does not have room/);

    // The same refusal has to hold on accept, because the destination can fill up
    // in between, which is the only moment the charge actually lands.
    await sql`UPDATE users SET max_blob_bytes = NULL WHERE namespace = ${other.user.namespace}`;
    await offer(ns, 'hello', other.user.namespace, owner.token).expect(201);
    await sql`UPDATE users SET max_blob_bytes = ${size.bytes - 1} WHERE namespace = ${other.user.namespace}`;
    await request(app)
      .post(`/v1/@${ns}/hello/transfers/${other.user.namespace}/accept`)
      .set(bearer(other.token))
      .expect(409);

    assert.deepEqual(await versions(ns, 'hello'), ['1.0.0']);
    assert.ok(admin);
  });

  test('a namespace that does not exist, and the sender itself', async () => {
    const { ns, owner } = await publishedExtension();
    await offer(ns, 'hello', 'no-such-namespace', owner.token).expect(404);
    await offer(ns, 'hello', ns, owner.token).expect(422);
    await offer(ns, 'hello', 'not a namespace', owner.token).expect(422);
  });
});

describe('what the move carries', () => {
  test('the sender can no longer publish to the transferred extension', async () => {
    const { ns, owner } = await publishedExtension();
    const other = await signupAndAccept(app, uniqNs());
    await offer(ns, 'hello', other.user.namespace, owner.token).expect(201);
    await accept(ns, 'hello', other.user.namespace, other.token);

    await publishProject(
      app,
      other.user.namespace,
      'hello',
      owner.token,
      { version: '2.0.0' },
      403,
    );
    const rows = await sql`
      SELECT owner_id FROM extension_owners
      WHERE namespace = ${other.user.namespace} AND extension_id = 'hello'
    `;
    const recipient = await loadNamespaceAccount(sql, other.user.namespace);
    assert.deepEqual(
      rows.map((row) => row.owner_id),
      [recipient.id],
    );
  });

  test('deleting an extension clears offers before its address is reused', async () => {
    const { ns, owner } = await publishedExtension();
    const other = await signupAndAccept(app, uniqNs());
    await offer(ns, 'hello', other.user.namespace, owner.token).expect(201);
    await request(app).delete(`/v1/@${ns}/hello`).set(bearer(owner.token)).expect(204);
    await publishProject(app, ns, 'hello', owner.token, { version: '2.0.0' });

    await request(app)
      .post(`/v1/@${ns}/hello/transfers/${other.user.namespace}/accept`)
      .set(bearer(other.token))
      .expect(404);
    assert.deepEqual(await versions(ns, 'hello'), ['2.0.0']);
  });

  test('acceptance checks the current quota and balance and preserves a refused offer', async () => {
    const { ns, owner } = await publishedExtension();
    const other = await signupAndAccept(app, uniqNs());
    await offer(ns, 'hello', other.user.namespace, owner.token).expect(201);
    const recipient = await loadNamespaceAccount(sql, other.user.namespace);
    await sql`
      UPDATE users SET blob_bytes = 100, max_blob_bytes = 100
      WHERE id = ${recipient.id}
    `;

    await assert.rejects(
      sql.begin((tx) =>
        acceptTransfer(tx, {
          config: {},
          actor: { ...other.user, id: recipient.id },
          namespace: ns,
          id: 'hello',
          toNamespace: other.user.namespace,
          recipient,
        }),
      ),
      (error) => {
        assert.equal(error.status, 409);
        assert.match(error.detail, /limit is 100 and it holds 100/);
        return true;
      },
    );
    assert.equal((await sql`SELECT 1 FROM extension_transfers WHERE namespace = ${ns}`).length, 1);
    assert.deepEqual(await versions(ns, 'hello'), ['1.0.0']);
  });

  test('tags, owners, webhooks, history and the quota charge', async () => {
    const { ns, owner } = await publishedExtension();
    const other = await signupAndAccept(app, uniqNs());
    const coOwner = await signupAndAccept(app, uniqNs());

    await request(app)
      .put(`/v1/@${ns}/hello/tags/stable`)
      .set(bearer(owner.token))
      .send({ version: '1.0.0' })
      .expect(204);
    await request(app)
      .put(`/v1/@${ns}/hello/owners/${coOwner.user.namespace}`)
      .set(bearer(owner.token))
      .expect(204);
    await request(app)
      .post(`/v1/@${ns}/hello/owners/${coOwner.user.namespace}/accept`)
      .set(bearer(coOwner.token))
      .expect(200);
    await request(app)
      .post(`/v1/@${ns}/hello/webhooks`)
      .set(bearer(owner.token))
      .send({ url: 'https://example.com/twext-hook', events: ['version.published'] })
      .expect(201);
    await request(app).get(`/v1/@${ns}/hello/versions/latest/download`).expect(200);
    // Seeded rather than waited for: in production the rollup is filled by a
    // scheduled job, and the raw event above is what a download actually wrote.
    await sql`
      INSERT INTO extension_daily_downloads (namespace, extension_id, day, total_downloads)
      VALUES (${ns}, 'hello', current_date, 7)
    `;

    const events = async (namespace) =>
      Number(
        (
          await sql`SELECT count(*)::int AS n FROM download_events
            WHERE namespace = ${namespace} AND extension_id = 'hello'`
        )[0].n,
      );
    const rolled = async (namespace) =>
      Number(
        (
          await sql`SELECT COALESCE(SUM(total_downloads), 0)::int AS n
            FROM extension_daily_downloads
            WHERE namespace = ${namespace} AND extension_id = 'hello'`
        )[0].n,
      );
    const [charged] = await sql`SELECT blob_bytes FROM users WHERE namespace = ${ns}`;
    assert.ok(Number(charged.blob_bytes) > 0);
    assert.ok((await events(ns)) > 0);

    await offer(ns, 'hello', other.user.namespace, owner.token).expect(201);
    await accept(ns, 'hello', other.user.namespace, other.token);
    const to = other.user.namespace;

    // Everything that was attached to the extension is still attached to it,
    // which is the whole difference between a move and a republish.
    assert.deepEqual((await request(app).get(`/v1/@${to}/hello/tags`).expect(200)).body, {
      stable: '1.0.0',
    });
    const owners = (await request(app).get(`/v1/@${to}/hello/owners`).expect(200)).body.data.map(
      (row) => row.namespace,
    );
    assert.ok(owners.includes(coOwner.user.namespace));
    const hooks = (
      await request(app).get(`/v1/@${to}/hello/webhooks`).set(bearer(other.token)).expect(200)
    ).body.data;
    assert.equal(hooks.length, 1);

    // The download counts belong to the extension, so the new address does not
    // start from zero.
    assert.equal(await events(ns), 0);
    assert.ok((await events(to)) > 0);
    assert.equal(await rolled(ns), 0);
    assert.equal(await rolled(to), 7);
    assert.equal(
      Number((await request(app).get(`/v1/@${to}/hello`).expect(200)).body.downloads),
      7,
    );

    // The charge moved with the bytes, so the sender is not billed for storage
    // the recipient is serving and the recipient is not given it for free.
    const [sender] = await sql`SELECT blob_bytes FROM users WHERE namespace = ${ns}`;
    const [recipient] = await sql`SELECT blob_bytes FROM users WHERE namespace = ${to}`;
    assert.equal(Number(sender.blob_bytes), 0);
    assert.equal(Number(recipient.blob_bytes), Number(charged.blob_bytes));
  });

  test("the transferred extension's author display name follows the new owner", async () => {
    const { ns, owner } = await publishedExtension('hello', { author: 'Sender Name' });
    const other = await signupAndAccept(app, uniqNs());

    await request(app)
      .patch(`/v1/users/${other.user.namespace}`)
      .set(bearer(other.token))
      .send({ displayName: 'Receiver Name' })
      .expect(200);

    const before = await request(app).get(`/v1/@${ns}/hello`).expect(200);
    assert.equal(before.body.author, 'Sender Name');

    await offer(ns, 'hello', other.user.namespace, owner.token).expect(201);
    await accept(ns, 'hello', other.user.namespace, other.token);

    const after = await request(app).get(`/v1/@${other.user.namespace}/hello`).expect(200);
    assert.equal(after.body.author, 'Receiver Name');
  });

  test('receiving an extension does not buy the recipient out of review', async () => {
    const { ns, owner } = await publishedExtension();
    const other = await signupAndAccept(app, uniqNs());

    await offer(ns, 'hello', other.user.namespace, owner.token).expect(201);
    await accept(ns, 'hello', other.user.namespace, other.token);

    // The versions that moved were reviewed for the address they were published
    // under. They do not vouch for whatever the destination publishes next, so
    // `has_published` stays where it was and the next version is still held.
    // Otherwise two accounts could sell each other the review gate, and the
    // moderation queue would be worth nothing.
    const [recipient] = await sql`
      SELECT has_published FROM users WHERE namespace = ${other.user.namespace}
    `;
    assert.equal(recipient.has_published, false);
    const next = await publishProject(app, other.user.namespace, 'second', other.token, {
      code: '// second@1.0.0',
    });
    assert.equal(next.body.status, 'pending');
  });

  test('the sender is told, because it is the only party that did not act', async () => {
    const { ns, owner } = await publishedExtension();
    const other = await signupAndAccept(app, uniqNs());
    await offer(ns, 'hello', other.user.namespace, owner.token).expect(201);
    await accept(ns, 'hello', other.user.namespace, other.token);

    // Losing an extension is news for whoever owned it, and the namespace that
    // accepted already knows because it just did the accepting. The sender's
    // inbox also holds the approval from publishing, so this looks at the
    // transfer rather than at the whole list.
    const outcomes = (await notifications(owner.token)).filter((row) =>
      /now belongs to/.test(row.message),
    );
    assert.equal(outcomes.length, 1);
    assert.match(outcomes[0].message, new RegExp(other.user.namespace));
    assert.ok(
      (await notifications(other.token)).every((row) => !/now belongs to/.test(row.message)),
    );
  });

  test('an organization receives it, and any of its owners can accept', async () => {
    const { ns, owner } = await publishedExtension();
    const acme = await makeOrg();
    const partner = await signupAndAccept(app, uniqNs());
    await addOrgOwner(acme, partner);

    await offer(ns, 'hello', acme.ns, owner.token).expect(201);
    await accept(ns, 'hello', acme.ns, partner.token);

    assert.deepEqual(await versionsMoved(ns, 'hello', acme.ns), ['1.0.0']);
    assert.deepEqual(await versions(acme.ns, 'hello'), ['1.0.0']);
    // The organization can then publish through either of its owners.
    await publishProject(app, acme.ns, 'hello', acme.owner.token, {
      version: '2.0.0',
      code: '// hello@2.0.0',
    });
  });

  test('a subscriber hears about the move, at the address it moved to', async () => {
    const { ns, owner } = await publishedExtension();
    const other = await signupAndAccept(app, uniqNs());
    await request(app)
      .post(`/v1/@${ns}/hello/webhooks`)
      .set(bearer(owner.token))
      .send({ url: 'https://example.com/twext-hook', events: ['extension.transferred'] })
      .expect(201);

    await offer(ns, 'hello', other.user.namespace, owner.token).expect(201);
    await accept(ns, 'hello', other.user.namespace, other.token);
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The hook moved with the extension, so the delivery belongs to the hook at
    // the new address and says which way the extension went.
    const rows = await sql`
      SELECT w.namespace, w.extension_id, d.event, d.payload
      FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id
    `;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].namespace, other.user.namespace);
    assert.equal(rows[0].event, 'extension.transferred');
    assert.equal(rows[0].payload.from, ns);
    assert.equal(rows[0].payload.to, other.user.namespace);
    assert.match(rows[0].payload.message, new RegExp(`Moved from @${ns}/hello to @`));
  });

  test('version attribution stays with whoever published it', async () => {
    const { ns, owner } = await publishedExtension();
    const other = await signupAndAccept(app, uniqNs());
    await offer(ns, 'hello', other.user.namespace, owner.token).expect(201);
    await accept(ns, 'hello', other.user.namespace, other.token);

    // owner_id is the account that ran the publish, not the namespace, and it is
    // deliberately not rewritten: the audit trail has to still say who pushed
    // 1.0.0 after the address it was published under is gone.
    const [row] = await sql`
      SELECT v.namespace, u.namespace AS publisher
      FROM versions v JOIN users u ON u.id = v.owner_id
      WHERE v.namespace = ${other.user.namespace} AND v.extension_id = 'hello'
    `;
    assert.equal(row.namespace, other.user.namespace);
    assert.equal(row.publisher, ns);
  });
});
