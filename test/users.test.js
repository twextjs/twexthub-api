import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
import {
  FIXTURE_PASSWORD,
  apiPath,
  approveVersion,
  bearer,
  boot,
  publishProject,
  resetDb,
  signupAndAccept,
  uniqNs,
} from './helpers.mjs';
import { blobPathFor } from '../src/blobs.js';
import { resolvePublicWebhookTarget } from '../src/webhooks.js';

// The URL check at create time resolves the host with live DNS, which a sandbox
// cannot reach. Route the app through the resolver seam with a fixed public
// answer instead, so a created hook never depends on the network while every
// other rule (https only, no loopback, no private address) still runs on the
// production resolver.
const deterministicResolver = (rawUrl) =>
  resolvePublicWebhookTarget(rawUrl, async () => [{ address: '93.184.216.34', family: 4 }]);

let app;
let db;
let config;
before(async () => {
  ({ app, db, config } = await boot({}, { resolveTarget: deterministicResolver }));
});
beforeEach(resetDb);
after(async () => {
  await db.$disconnect();
});

test('users list is public and includes created users', async () => {
  const first = await signupAndAccept(app, uniqNs());
  const second = await signupAndAccept(app, uniqNs());

  const list = await request(app).get(apiPath('/users')).expect(200);
  const namespaces = list.body.data.map((u) => u.namespace);
  assert.ok(namespaces.includes(first.user.namespace));
  assert.ok(namespaces.includes(second.user.namespace));
  const firstUser = list.body.data.find((u) => u.namespace === first.user.namespace);
  assert.equal('role' in firstUser, false);
  assert.equal('termsAcceptedVersion' in firstUser, false);
  assert.equal(typeof firstUser.hasPublished, 'boolean');

  const mine = await request(app).get(apiPath('/users')).set(bearer(first.token)).expect(200);
  const me = mine.body.data.find((u) => u.namespace === first.user.namespace);
  assert.equal(me.role, 'admin');
});

test('user lookup by namespace returns profile', async () => {
  const { user } = await signupAndAccept(app, uniqNs());
  const r = await request(app)
    .get(apiPath(`/users/${user.namespace}`))
    .expect(200);
  assert.equal(r.body.namespace, user.namespace);
  assert.equal(r.body.hasPublished, false);
});

test('owner can update their own displayName', async () => {
  const { user, token } = await signupAndAccept(app, uniqNs());
  const r = await request(app)
    .patch(apiPath(`/users/${user.namespace}`))
    .set(bearer(token))
    .send({ displayName: 'Fresh Handle' })
    .expect(200);
  assert.equal(r.body.displayName, 'Fresh Handle');
});

test('changing password revokes existing sessions and tokens', async () => {
  const { user, token } = await signupAndAccept(app, uniqNs());
  const ns = user.namespace;

  const created = await request(app)
    .post(apiPath('/tokens'))
    .set(bearer(token))
    .send({ name: 'ci', scopes: ['publish'] })
    .expect(201);

  await request(app)
    .patch(apiPath(`/users/${ns}`))
    .set(bearer(token))
    .send({ password: 'newpassword9', currentPassword: FIXTURE_PASSWORD })
    .expect(200);

  await request(app).get(apiPath('/me')).set(bearer(token)).expect(401);
  await request(app).get(apiPath('/tokens')).set(bearer(created.body.token)).expect(401);

  const login = await request(app)
    .post(apiPath('/sessions'))
    .send({ namespace: ns, password: 'newpassword9' })
    .expect(201);
  assert.ok(login.body.token);
});

test('password rotation bypasses terms re-acceptance', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const { user, token } = await signupAndAccept(app, uniqNs());

  await request(app)
    .patch(apiPath('/admin/terms'))
    .set(bearer(admin.token))
    .send({ body: 'Terms v2.' })
    .expect(200);

  const r = await request(app)
    .patch(apiPath(`/users/${user.namespace}`))
    .set(bearer(token))
    .send({ password: 'newpassword9', currentPassword: FIXTURE_PASSWORD });
  assert.equal(r.status, 200);

  const login = await request(app)
    .post(apiPath('/sessions'))
    .send({ namespace: user.namespace, password: 'newpassword9' })
    .expect(201);
  assert.ok(login.body.token);
});

test('account deletion bypasses terms re-acceptance', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const { user, token } = await signupAndAccept(app, uniqNs());

  await request(app)
    .patch(apiPath('/admin/terms'))
    .set(bearer(admin.token))
    .send({ body: 'Terms v2.' })
    .expect(200);

  await request(app)
    .delete(apiPath(`/users/${user.namespace}`))
    .set(bearer(token))
    .expect(204);
  await request(app)
    .get(apiPath(`/users/${user.namespace}`))
    .expect(404);
});

test('account deletion still removes sources when blob cleanup fails', async () => {
  await signupAndAccept(app, uniqNs());
  const owner = await signupAndAccept(app, uniqNs());
  const ns = owner.user.namespace;
  await publishProject(app, ns, 'cleanup', owner.token);
  const [version] = await db.$queryRaw`
    SELECT "BlobDigest" AS blob_digest, "SourcePath" AS source_path FROM "Versions"
    WHERE "Namespace" = ${ns} AND "ExtensionId" = 'cleanup'
  `;
  const blobPath = blobPathFor(config.dataDir, version.blob_digest);
  const sourcePath = path.join(config.dataDir, version.source_path);
  await fs.rm(blobPath);
  await fs.mkdir(blobPath);
  const errors = [];
  const originalError = console.error;
  console.error = (message) => errors.push(message);
  try {
    await request(app)
      .delete(apiPath(`/users/${ns}`))
      .set(bearer(owner.token))
      .expect(204);
  } finally {
    console.error = originalError;
    await fs.rm(blobPath, { recursive: true, force: true });
  }
  assert.ok(errors.some((message) => message.includes(`blob cleanup deferred for ${ns}`)));
  await assert.rejects(fs.stat(sourcePath), { code: 'ENOENT' });
});

test('non-owner cannot update another user', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const { token } = await signupAndAccept(app, uniqNs());

  const r = await request(app)
    .patch(apiPath(`/users/${admin.user.namespace}`))
    .set(bearer(token))
    .send({ displayName: 'Nope' });
  assert.equal(r.status, 403);
});

test('only admin can change a role', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const { user: other, token } = await signupAndAccept(app, uniqNs());

  const denied = await request(app)
    .patch(apiPath(`/users/${other.namespace}`))
    .set(bearer(token))
    .send({ role: 'admin' });
  assert.equal(denied.status, 403);

  const granted = await request(app)
    .patch(apiPath(`/users/${other.namespace}`))
    .set(bearer(admin.token))
    .send({ role: 'admin' })
    .expect(200);
  assert.equal(granted.body.role, 'admin');
});

test('manage:account alone does not reach another account, admin scope does', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const { user: other } = await signupAndAccept(app, uniqNs());

  const scoped = await request(app)
    .post(apiPath('/tokens'))
    .set(bearer(admin.token))
    .send({ name: 'selfcare', scopes: ['manage:account'] })
    .expect(201);
  const selfOnly = scoped.body.token;

  // Its own account is the point of the scope, and it keeps working.
  await request(app)
    .patch(apiPath(`/users/${admin.user.namespace}`))
    .set(bearer(selfOnly))
    .send({ bio: 'set by a token' })
    .expect(200);

  // Another account is an administrative act, which the scope alone does not cover.
  const crossAccount = await request(app)
    .patch(apiPath(`/users/${other.namespace}`))
    .set(bearer(selfOnly))
    .send({ displayName: 'Nope' });
  assert.equal(crossAccount.status, 403);

  // A role change is the sharpest edge of that, so it is checked on its own.
  const promote = await request(app)
    .patch(apiPath(`/users/${other.namespace}`))
    .set(bearer(selfOnly))
    .send({ role: 'admin' });
  assert.equal(promote.status, 403);

  const removal = await request(app)
    .delete(apiPath(`/users/${other.namespace}`))
    .set(bearer(selfOnly));
  assert.equal(removal.status, 403);

  // With the admin scope as well, the same account reaches all three.
  const full = await request(app)
    .post(apiPath('/tokens'))
    .set(bearer(admin.token))
    .send({ name: 'ops', scopes: ['manage:account', 'admin'] })
    .expect(201);
  const ops = full.body.token;

  await request(app)
    .patch(apiPath(`/users/${other.namespace}`))
    .set(bearer(ops))
    .send({ displayName: 'Renamed' })
    .expect(200);
  const promoted = await request(app)
    .patch(apiPath(`/users/${other.namespace}`))
    .set(bearer(ops))
    .send({ role: 'admin' })
    .expect(200);
  assert.equal(promoted.body.role, 'admin');
  await request(app)
    .delete(apiPath(`/users/${other.namespace}`))
    .set(bearer(ops))
    .expect(204);
});

test('an unreviewed version needs the admin scope, not just the role', async () => {
  const ab = await signupAndAccept(app, uniqNs());
  assert.equal(ab.user.role, 'admin');
  const { user, token } = await signupAndAccept(app, uniqNs());
  await publishProject(app, user.namespace, 'hello', token);

  // The owner always sees their own pending version.
  await request(app)
    .get(apiPath(`/@${user.namespace}/hello/versions/1.0.0`))
    .set(bearer(token))
    .expect(200);

  const unscoped = await request(app)
    .post(apiPath('/tokens'))
    .set(bearer(ab.token))
    .send({ name: 'curious', scopes: ['publish'] })
    .expect(201);
  const denied = await request(app).get(apiPath(`/@${user.namespace}/hello/versions/1.0.0`));
  assert.equal(denied.status, 404, 'an unauthenticated caller cannot see it either');
  const viaToken = await request(app)
    .get(apiPath(`/@${user.namespace}/hello/versions/1.0.0`))
    .set(bearer(unscoped.body.token));
  assert.equal(viaToken.status, 404);

  const scoped = await request(app)
    .post(apiPath('/tokens'))
    .set(bearer(ab.token))
    .send({ name: 'reviewer', scopes: ['admin'] })
    .expect(201);
  await request(app)
    .get(apiPath(`/@${user.namespace}/hello/versions/1.0.0`))
    .set(bearer(scoped.body.token))
    .expect(200);
});

// Account-level webhooks: the namespace-wide collection an organization gets
// at /orgs/:ns/webhooks, keyed on a personal namespace, so one URL hears every
// extension an author publishes instead of a hook per extension id.
const PUBLIC_URL = 'https://example.com/twext-hook';

test('an account hook hears every extension under the namespace', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const { user, token } = await signupAndAccept(app, uniqNs());
  const ns = user.namespace;

  const created = await request(app)
    .post(apiPath(`/users/${ns}/webhooks`))
    .set(bearer(token))
    .send({ url: PUBLIC_URL, events: ['version.published'] })
    .expect(201);
  assert.ok(created.body.secret, 'the secret is returned once, at creation');
  assert.equal(created.body.extension_id, null, 'the hook names no single extension');

  const list = await request(app)
    .get(apiPath(`/users/${ns}/webhooks`))
    .set(bearer(token))
    .expect(200);
  assert.equal(list.body.data.length, 1);
  assert.equal(list.body.data[0].secret, undefined, 'listing never returns the secret');
  assert.equal(list.body.data[0].url, PUBLIC_URL);

  // The first version in a namespace is held for review and the next one is
  // published on arrival, so this walks both paths: approval is what fires the
  // event for the first, the publish itself fires it for the second.
  for (const id of ['one', 'two']) {
    const published = await publishProject(app, ns, id, token);
    if (published.body.status === 'pending') {
      await approveVersion(app, admin.token, ns, id, published.body.version);
    }
  }
  // Scheduling is fire-and-forget, so poll for the two rows the account hook
  // must hear rather than sleeping one fixed tick.
  const accountDeliveries = async () => {
    const rows = await db.$queryRaw`
      SELECT d."Event" AS event, d."Payload" AS payload
      FROM "WebhookDeliveries" d
      JOIN "Webhooks" w ON w."Id" = d."WebhookId"
      WHERE w."Namespace" = ${ns} AND w."ExtensionId" IS NULL
      ORDER BY d."Id"
    `;
    return rows.length === 2 ? rows : null;
  };
  const deadline = Date.now() + 2000;
  let deliveries;
  while (true) {
    deliveries = await accountDeliveries();
    if (deliveries) break;
    assert.ok(Date.now() < deadline, 'the account hook should hear both publishes');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.deepEqual(deliveries.map((row) => row.payload.id).sort(), ['one', 'two']);
  for (const row of deliveries) {
    assert.equal(row.event, 'version.published');
    assert.equal(row.payload.namespace, ns);
    assert.match(row.payload.message, new RegExp(`^@${ns}/`));
  }
});

test('a hook on one extension is not the account hook', async () => {
  const { user, token } = await signupAndAccept(app, uniqNs());
  const ns = user.namespace;
  const created = await request(app)
    .post(apiPath(`/users/${ns}/webhooks`))
    .set(bearer(token))
    .send({ url: PUBLIC_URL, events: ['version.published'] })
    .expect(201);
  const accountHookId = created.body.id;

  // The per-extension collection is a different scope, so the namespace-wide
  // hook must not turn up in it...
  const perExtension = await request(app)
    .get(apiPath(`/@${ns}/one/webhooks`))
    .set(bearer(token))
    .expect(200);
  assert.deepEqual(perExtension.body.data, []);

  // ...and deleting the id from either collection is refused when it belongs
  // to the other one.
  await request(app)
    .delete(apiPath(`/@${ns}/one/webhooks/${accountHookId}`))
    .set(bearer(token))
    .expect(404);

  await request(app)
    .delete(apiPath(`/users/${ns}/webhooks/${accountHookId}`))
    .set(bearer(token))
    .expect(204);
  await request(app)
    .get(apiPath(`/users/${ns}/webhooks`))
    .set(bearer(token))
    .expect(200)
    .expect((r) => assert.deepEqual(r.body.data, []));
});

test('only the account or an admin manages the hooks', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const { user, token } = await signupAndAccept(app, uniqNs());
  const ns = user.namespace;
  const outsider = await signupAndAccept(app, uniqNs());

  // A stranger is refused on every verb.
  await request(app)
    .post(apiPath(`/users/${ns}/webhooks`))
    .set(bearer(outsider.token))
    .send({ url: PUBLIC_URL, events: ['version.published'] })
    .expect(403);
  await request(app)
    .get(apiPath(`/users/${ns}/webhooks`))
    .set(bearer(outsider.token))
    .expect(403);

  // Acting on another account is an administrative act: the admin role is not
  // enough without the `admin` scope on the credential, just as on the rest of
  // the account routes. A `manage:account`-only token still serves its own.
  const roleOnly = await request(app)
    .post(apiPath('/tokens'))
    .set(bearer(admin.token))
    .send({ name: 'role-only', scopes: ['manage:account'] })
    .expect(201);
  await request(app)
    .get(apiPath(`/users/${ns}/webhooks`))
    .set(bearer(roleOnly.body.token))
    .expect(403);

  const selfOnly = await request(app)
    .post(apiPath('/tokens'))
    .set(bearer(token))
    .send({ name: 'self-only', scopes: ['manage:account'] })
    .expect(201);
  await request(app)
    .get(apiPath(`/users/${ns}/webhooks`))
    .set(bearer(selfOnly.body.token))
    .expect(200);

  // An admin session (every scope including `admin`) can act for the account.
  await request(app)
    .get(apiPath(`/users/${ns}/webhooks`))
    .set(bearer(admin.token))
    .expect(200);
});

test('hook input is validated the same way as an extension hook', async () => {
  const { user, token } = await signupAndAccept(app, uniqNs());
  const ns = user.namespace;

  const badEvents = await request(app)
    .post(apiPath(`/users/${ns}/webhooks`))
    .set(bearer(token))
    .send({ url: PUBLIC_URL, events: ['nope'] });
  assert.equal(badEvents.status, 422);
  assert.equal(badEvents.body.errors[0].field, 'events');

  const badUrl = await request(app)
    .post(apiPath(`/users/${ns}/webhooks`))
    .set(bearer(token))
    .send({ url: 'https://localhost:9911/hook', events: ['version.published'] });
  assert.equal(badUrl.status, 422);
  assert.equal(badUrl.body.errors[0].field, 'url');
});

test('an organization namespace is managed through /orgs, not /users', async () => {
  const owner = await signupAndAccept(app, uniqNs());
  const orgNs = uniqNs();
  await request(app)
    .post(apiPath('/orgs'))
    .set(bearer(owner.token))
    .send({ namespace: orgNs, displayName: 'Acme Inc' })
    .expect(201);

  const denied = await request(app)
    .post(apiPath(`/users/${orgNs}/webhooks`))
    .set(bearer(owner.token))
    .send({ url: PUBLIC_URL, events: ['version.published'] });
  assert.equal(denied.status, 403);
  assert.match(denied.body.detail, /\/orgs/);
});

test('deleting an account removes its webhooks and their deliveries', async () => {
  const { user, token } = await signupAndAccept(app, uniqNs());
  const ns = user.namespace;

  // One hook in each of the two collections that share the namespace.
  await request(app)
    .post(apiPath(`/users/${ns}/webhooks`))
    .set(bearer(token))
    .send({ url: PUBLIC_URL, events: ['version.published'] })
    .expect(201);
  await request(app)
    .post(apiPath(`/@${ns}/one/webhooks`))
    .set(bearer(token))
    .send({ url: PUBLIC_URL, events: ['version.published'] })
    .expect(201);

  // The first version in a namespace is held for review, and approving it is
  // what fires version.published — both hooks hear the same event.
  const published = await publishProject(app, ns, 'one', token);
  if (published.body.status === 'pending') {
    // This test signs up first, so the account is the admin and its own
    // session can approve the held version.
    await approveVersion(app, token, ns, 'one', published.body.version);
  }

  // Scheduling is fire-and-forget, so poll until both hooks carry their
  // delivery rather than sleeping one fixed tick.
  const hookState = async () => {
    const [row] = await db.$queryRaw`
      SELECT
        (SELECT count(*)::int FROM "Webhooks" WHERE "Namespace" = ${ns}) AS hooks,
        (SELECT count(*)::int FROM "WebhookDeliveries" d
           JOIN "Webhooks" w ON w."Id" = d."WebhookId"
          WHERE w."Namespace" = ${ns}) AS deliveries
    `;
    return row;
  };
  const deadline = Date.now() + 2000;
  let before;
  while (true) {
    before = await hookState();
    if (before.hooks === 2 && before.deliveries === 2) break;
    assert.ok(Date.now() < deadline, 'two hooks and their two deliveries should land first');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  await request(app)
    .delete(apiPath(`/users/${ns}`))
    .set(bearer(token))
    .expect(204);

  const after = await hookState();
  assert.deepEqual(after, { hooks: 0, deliveries: 0 });
});

test('an account hook exposes its delivery log and redelivers', async () => {
  const { user, token } = await signupAndAccept(app, uniqNs());
  const ns = user.namespace;
  const created = await request(app)
    .post(apiPath(`/users/${ns}/webhooks`))
    .set(bearer(token))
    .send({ url: PUBLIC_URL, events: ['version.published'] })
    .expect(201);

  const [delivery] = await db.$queryRaw`
    INSERT INTO "WebhookDeliveries" ("WebhookId", "Event", "Payload", "Body", "Signature", "Status", "Attempt")
    VALUES (${created.body.id}, 'version.published', ${{ id: 'one' }}, '{}', 'sig',
            'delivered', 1)
    RETURNING "Id" AS id
  `;
  // The listing answers with string ids, so the row this is compared against
  // carries one too.
  delivery.id = String(delivery.id);

  const listed = await request(app)
    .get(apiPath(`/users/${ns}/webhooks/${created.body.id}/deliveries`))
    .set(bearer(token))
    .expect(200);
  assert.equal(listed.body.data.length, 1);
  assert.equal(listed.body.data[0].id, delivery.id);
  assert.equal(listed.body.data[0].status, 'delivered');

  const redelivered = await request(app)
    .post(apiPath(`/users/${ns}/webhooks/${created.body.id}/deliveries/${delivery.id}/redeliver`))
    .set(bearer(token))
    .expect(202);
  assert.equal(redelivered.body.status, 'pending');

  const outsider = await signupAndAccept(app, uniqNs());
  await request(app)
    .get(apiPath(`/users/${ns}/webhooks/${created.body.id}/deliveries`))
    .set(bearer(outsider.token))
    .expect(403);
});
