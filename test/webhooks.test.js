import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import https from 'node:https';
import request from 'supertest';
import { boot, resetDb, bearer, uniqNs, signupAndAccept, publishProject } from './helpers.mjs';
import {
  attemptDelivery,
  claimDue,
  makeWebhooks,
  signWebhookPayload,
  WEBHOOK_EVENTS,
} from '../src/webhooks.js';

let app;
let sql;
before(async () => {
  ({ app, sql } = await boot());
});
beforeEach(resetDb);
after(async () => {
  await sql.end();
});

// scheduleFor runs fire-and-forget; give it a tick to land its inserts.
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 50));
}

async function publishApproved(ns, token, adminToken, id, version) {
  await publishProject(app, ns, id, token, { version, code: `// ${id}@${version}` });
  await request(app)
    .patch(`/v1/@${ns}/${id}/versions/${version}`)
    .set(bearer(adminToken))
    .send({ status: 'approved' })
    .expect(200);
}

async function makeOwner() {
  const admin = await signupAndAccept(app, uniqNs());
  const owner = await signupAndAccept(app, uniqNs());
  const ns = owner.user.namespace;
  await publishApproved(ns, owner.token, admin.token, 'hooked', '1.0.0');
  return { admin, owner, ns };
}

// The worker claims a row before attempting it, and only the claim holder may
// write the outcome, so a driven attempt has to go through the same claim.
async function claimOne(id) {
  const [claimed] = (await claimDue(sql, Date.now())).filter((row) => row.id === id);
  assert.ok(claimed, `delivery ${id} was not claimable`);
  return claimed;
}

// A moment the worker will consider due.
//
// Both sides of the production comparison run on the worker's clock:
// attemptDelivery writes new Date(Date.now() + delay) and claimDue reads
// Date.now(). Writing next_attempt_at with the *database's* now() instead made
// claimDue compare a database timestamp against a worker timestamp, so the row
// only counted as due while the worker happened to be at or ahead of the
// database. A CI database whose clock runs 50ms ahead was enough to make every
// re-claim report "delivery 1 was not claimable", on some runs and not others,
// and never on a machine where the two share a clock.
//
// Deriving the timestamp from the worker clock is what removes the sensitivity:
// the database offset is simply never consulted, so the margin below only has to
// cover the gap between writing the row and claiming it.
const dueNow = () => new Date(Date.now() - 1000).toISOString();

// create() blocks loopback and unreachable URLs, so tests that exercise
// delivery insert the webhook row directly.
async function insertWebhook(ns, url, events) {
  const [row] = await sql`
    INSERT INTO webhooks (namespace, extension_id, url, secret, events)
    VALUES (${ns}, 'hooked', ${url}, 'test-secret-0123456789abcdef', ${events})
    RETURNING id
  `;
  return row.id;
}

// The sandbox resolver cannot resolve fake hosts, so create() calls in tests
// use a real, publicly-resolving name.
const PUBLIC_URL = 'https://example.com/twext-hook';

// The receiver below listens on loopback, which the delivery-time policy check
// refuses; these attempts stand in for an operator with a routable address.
// The hostname it is registered under does not resolve at all, so a delivery
// that reached it proves the connection used the address that was checked
// rather than a second DNS answer.
const RECEIVER_HOST = 'receiver.invalid';
const RECEIVER_CA = readFileSync(new URL('./fixtures/test-cert.pem', import.meta.url));
const RECEIVER_KEY = readFileSync(new URL('./fixtures/test-key.pem', import.meta.url));
const toLoopbackReceiver = async (url) => ({
  url: new URL(url),
  address: '127.0.0.1',
  family: 4,
  ca: RECEIVER_CA,
});

test('creating a webhook returns the secret once; listing never does', async () => {
  const { owner, ns } = await makeOwner();

  const created = await request(app)
    .post(`/v1/@${ns}/hooked/webhooks`)
    .set(bearer(owner.token))
    .send({ url: PUBLIC_URL, events: ['version.published'] })
    .expect(201);
  assert.equal(created.body.secret.length, 32);
  assert.equal(created.body.active, true);
  assert.ok(created.body.id);

  const list = await request(app)
    .get(`/v1/@${ns}/hooked/webhooks`)
    .set(bearer(owner.token))
    .expect(200);
  assert.equal(list.body.data.length, 1);
  assert.equal(list.body.data[0].secret, undefined);
  assert.equal(list.body.data[0].url, PUBLIC_URL);
});

test('webhook validation rejects bad events, bad urls, and non-owners', async () => {
  const { owner, ns } = await makeOwner();
  const outsider = await signupAndAccept(app, uniqNs());

  await request(app)
    .post(`/v1/@${ns}/hooked/webhooks`)
    .set(bearer(outsider.token))
    .send({ url: PUBLIC_URL, events: ['version.published'] })
    .expect(403);

  const badEvents = await request(app)
    .post(`/v1/@${ns}/hooked/webhooks`)
    .set(bearer(owner.token))
    .send({ url: PUBLIC_URL, events: ['nope'] });
  assert.equal(badEvents.status, 422);
  assert.equal(badEvents.body.errors[0].field, 'events');

  const missingUrl = await request(app)
    .post(`/v1/@${ns}/hooked/webhooks`)
    .set(bearer(owner.token))
    .send({ events: ['version.published'] });
  assert.equal(missingUrl.status, 422);
  assert.equal(missingUrl.body.errors[0].field, 'url');

  const localhost = await request(app)
    .post(`/v1/@${ns}/hooked/webhooks`)
    .set(bearer(owner.token))
    .send({ url: 'https://localhost:9911/hook', events: ['version.published'] });
  assert.equal(localhost.status, 422);
  assert.match(localhost.body.errors[0].message, /Localhost|public/);

  const plaintext = await request(app)
    .post(`/v1/@${ns}/hooked/webhooks`)
    .set(bearer(owner.token))
    .send({ url: 'http://hooks.example.com/hook', events: ['version.published'] });
  assert.equal(plaintext.status, 422, 'only https destinations are accepted');
  assert.match(plaintext.body.errors[0].message, /https/);
});

test('webhook targets inside non-RFC1918 internal ranges are refused', async () => {
  // Carrier-grade NAT, the benchmarking range, and the IETF protocol
  // assignments are not RFC1918, but each is routed inside networks an operator
  // runs, so a delivery aimed at one is still an SSRF attempt.
  const { owner, ns } = await makeOwner();
  const refused = ['100.64.0.1', '100.127.255.255', '198.18.0.1', '198.19.255.255', '192.0.0.1'];
  for (const address of refused) {
    const r = await request(app)
      .post(`/v1/@${ns}/hooked/webhooks`)
      .set(bearer(owner.token))
      .send({ url: `https://${address}/hook`, events: ['version.published'] });
    assert.equal(r.status, 422, `${address} should be refused`);
    assert.match(r.body.errors[0].message, /public/);
  }
});

test('neighbours just outside the refused ranges are still allowed', async () => {
  // The guards are on exact prefixes, so the addresses on either side have to
  // keep working.
  const { owner, ns } = await makeOwner();
  const allowed = ['100.63.255.255', '100.128.0.0', '198.17.255.255', '198.20.0.0', '192.0.1.1'];
  for (const address of allowed) {
    const r = await request(app)
      .post(`/v1/@${ns}/hooked/webhooks`)
      .set(bearer(owner.token))
      .send({ url: `https://${address}/hook`, events: ['version.published'] });
    assert.equal(r.status, 201, `${address} should be accepted, got ${JSON.stringify(r.body)}`);
  }
});

test('registry events schedule deliveries for subscribed hooks', async () => {
  const { owner, ns } = await makeOwner();
  await request(app)
    .post(`/v1/@${ns}/hooked/webhooks`)
    .set(bearer(owner.token))
    .send({ url: PUBLIC_URL, events: WEBHOOK_EVENTS })
    .expect(201);

  // 2.0.0 publishes straight to 'published' since the owner's first version
  // was approved; no admin call needed.
  await publishProject(app, ns, 'hooked', owner.token, {
    version: '2.0.0',
    code: '// hooked@2.0.0',
  });
  await request(app)
    .patch(`/v1/@${ns}/hooked/versions/2.0.0`)
    .set(bearer(owner.token))
    .send({ deprecationMessage: 'old' })
    .expect(200);
  await request(app)
    .delete(`/v1/@${ns}/hooked/versions/2.0.0`)
    .set(bearer(owner.token))
    .expect(204);
  const other = await signupAndAccept(app, uniqNs());
  await request(app)
    .put(`/v1/@${ns}/hooked/owners/${other.user.namespace}`)
    .set(bearer(owner.token))
    .expect(204);
  await request(app)
    .post(`/v1/@${ns}/hooked/owners/${other.user.namespace}/accept`)
    .set(bearer(other.token))
    .expect(200);
  await request(app)
    .delete(`/v1/@${ns}/hooked/owners/${other.user.namespace}`)
    .set(bearer(owner.token))
    .expect(204);

  await settle();
  const events = await sql`SELECT event, payload, body FROM webhook_deliveries ORDER BY id`;
  const seen = events.map((row) => row.event);
  for (const event of [
    'version.published',
    'version.deprecated',
    'version.yanked',
    'owners.invited',
    'owners.changed',
  ]) {
    assert.ok(seen.includes(event), `${event} should schedule a delivery`);
  }
  const [published] = events.filter((row) => row.event === 'version.published');
  assert.equal(published.payload.version, '2.0.0');
  assert.equal(published.payload.namespace, ns);
  assert.ok(published.payload.occurredAt);
  assert.equal(published.payload.message, `@${ns}/hooked 2.0.0 was published.`);
  const [ownerChange] = events.filter((row) => row.event === 'owners.changed');
  assert.match(ownerChange.payload.message, /^[a-z0-9-]+ was (added|removed) as an owner of /);
  for (const row of events) {
    // Discord and Slack read the bytes that went out, not the jsonb the hub
    // keeps, so the aliases have to be in the signed body.
    const wire = JSON.parse(row.body);
    assert.ok(wire.message, `${row.event} should carry a rendered line`);
    assert.equal(wire.content, wire.message, `${row.event} should carry a content alias`);
    assert.equal(wire.text, wire.message, `${row.event} should carry a text alias`);
    // A namespace can be `everyone` or `here` and the line opens with
    // @namespace, so the payload has to tell Discord not to read one as a ping.
    assert.deepEqual(
      wire.allowed_mentions,
      { parse: [] },
      `${row.event} should carry an empty mention parse list`,
    );
  }
});

test('version.rejected fires from the review endpoint', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const newcomer = await signupAndAccept(app, uniqNs());
  const newcomerNs = newcomer.user.namespace;

  // A webhook on an extension that has no versions yet is allowed; the first
  // publish is then held as pending and rejected by an admin.
  await request(app)
    .post(`/v1/@${newcomerNs}/fresh/webhooks`)
    .set(bearer(newcomer.token))
    .send({ url: PUBLIC_URL, events: ['version.rejected'] })
    .expect(201);
  await publishProject(app, newcomerNs, 'fresh', newcomer.token, {
    version: '1.0.0',
    code: '// x',
  });
  await request(app)
    .patch(`/v1/@${newcomerNs}/fresh/versions/1.0.0`)
    .set(bearer(admin.token))
    .send({ status: 'rejected', reason: 'nope' })
    .expect(200);
  await settle();

  const [delivery] = await sql`
    SELECT event, payload FROM webhook_deliveries WHERE event = 'version.rejected'
  `;
  assert.ok(delivery, 'a rejection should schedule a delivery');
  assert.equal(delivery.payload.id, 'fresh');
  assert.equal(delivery.payload.actor, admin.user.namespace);
});

test('delivery posts the signed payload and records status', async () => {
  const received = [];
  const server = https.createServer({ key: RECEIVER_KEY, cert: RECEIVER_CA }, (req, res) => {
    let chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received.push({
        event: req.headers['x-twexthub-event'],
        signature: req.headers['x-twexthub-signature'],
        delivery: req.headers['x-twexthub-delivery'],
        userAgent: req.headers['user-agent'],
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.writeHead(200);
      res.end('ok');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const { owner, ns } = await makeOwner();
    const created = await request(app)
      .post(`/v1/@${ns}/hooked/webhooks`)
      .set(bearer(owner.token))
      .send({ url: PUBLIC_URL, events: ['version.published'] })
      .expect(201);
    const { secret, id: webhookId } = created.body;
    const url = `https://${RECEIVER_HOST}:${port}/hook`;
    await sql`UPDATE webhooks SET url = ${url} WHERE id = ${webhookId}`;

    const payload = {
      event: 'version.published',
      namespace: ns,
      id: 'hooked',
      version: '1.0.0',
      occurredAt: new Date().toISOString(),
      actor: ns,
    };
    const body = JSON.stringify(payload);
    const signature = signWebhookPayload(secret, body);
    const [delivery] = await sql`
      INSERT INTO webhook_deliveries (webhook_id, event, payload, body, signature)
      VALUES (${webhookId}, 'version.published', ${sql.json(payload)}, ${body}, ${signature})
      RETURNING *
    `;

    const result = await attemptDelivery(
      sql,
      { ...(await claimOne(delivery.id)), url },
      toLoopbackReceiver,
    );
    assert.equal(result.ok, true);
    assert.equal(received.length, 1);
    assert.equal(received[0].event, 'version.published');
    assert.equal(received[0].signature, signature);
    // Cloudflare-fronted hosts answer a request with no User-Agent at all with
    // 403, and Node sends none unless it is set here.
    assert.equal(received[0].userAgent, 'TwextHub-Webhooks');
    assert.deepEqual(JSON.parse(received[0].body), payload);

    const [after] =
      await sql`SELECT status, attempt FROM webhook_deliveries WHERE id = ${delivery.id}`;
    assert.equal(after.status, 'delivered');
    const [hook] = await sql`SELECT last_delivery_status FROM webhooks WHERE id = ${webhookId}`;
    assert.equal(hook.last_delivery_status, 'ok');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a delivery connects to the address it validated, not the hostname', async () => {
  const server = https.createServer({ key: RECEIVER_KEY, cert: RECEIVER_CA }, (req, res) => {
    res.writeHead(200);
    res.end('ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const { owner, ns } = await makeOwner();
    const created = await request(app)
      .post(`/v1/@${ns}/hooked/webhooks`)
      .set(bearer(owner.token))
      .send({ url: PUBLIC_URL, events: ['version.published'] })
      .expect(201);
    const { secret, id: webhookId } = created.body;
    // A name that resolves nowhere, paired with an address that resolves
    // nowhere else. Only a socket pinned to the checked address can complete.
    const url = `https://${RECEIVER_HOST}:${port}/hook`;
    await sql`UPDATE webhooks SET url = ${url} WHERE id = ${webhookId}`;

    const body = JSON.stringify({ event: 'version.published', id: 'hooked' });
    const [delivery] = await sql`
      INSERT INTO webhook_deliveries (webhook_id, event, payload, body, signature)
      VALUES (${webhookId}, 'version.published', ${sql.json(JSON.parse(body))}, ${body},
              ${signWebhookPayload(secret, body)})
      RETURNING *
    `;

    const result = await attemptDelivery(
      sql,
      { ...(await claimOne(delivery.id)), url },
      toLoopbackReceiver,
    );
    assert.equal(result.ok, true);
    const [after] = await sql`SELECT status FROM webhook_deliveries WHERE id = ${delivery.id}`;
    assert.equal(after.status, 'delivered');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('failed deliveries retry with backoff then mark failed', async () => {
  const { owner, ns } = await makeOwner();
  const rejected = await request(app)
    .post(`/v1/@${ns}/hooked/webhooks`)
    .set(bearer(owner.token))
    .send({ url: 'https://never.invalid/hook', events: ['version.published'] });
  assert.equal(rejected.status, 422, 'unresolvable hosts are rejected at create time');

  const webhookId = await insertWebhook(ns, 'https://172.31.255.7/hook', ['version.published']);
  const secret = 'test-secret-0123456789abcdef';

  const payload = { event: 'version.published', namespace: ns, id: 'hooked', version: '1.0.0' };
  const body = JSON.stringify(payload);
  const [delivery] = await sql`
    INSERT INTO webhook_deliveries (webhook_id, event, payload, body, signature)
    VALUES (${webhookId}, 'version.published', ${sql.json(payload)}, ${body},
            ${signWebhookPayload(secret, body)})
    RETURNING *
  `;

  // This delivery carries no destination of its own, so the attempt fails on
  // the check rather than reaching a receiver, and the retry bookkeeping runs.
  const first = await attemptDelivery(sql, await claimOne(delivery.id));
  assert.equal(first.ok, false);
  const [afterFirst] =
    await sql`SELECT status, attempt, next_attempt_at FROM webhook_deliveries WHERE id = ${delivery.id}`;
  assert.equal(afterFirst.status, 'retrying');
  assert.equal(afterFirst.attempt, 1);
  assert.ok(afterFirst.next_attempt_at, 'retrying rows must carry a next_attempt_at');

  await sql`UPDATE webhook_deliveries SET next_attempt_at = ${dueNow()} WHERE id = ${delivery.id}`;
  await attemptDelivery(sql, await claimOne(delivery.id));
  const [afterSecond] =
    await sql`SELECT status, attempt FROM webhook_deliveries WHERE id = ${delivery.id}`;
  assert.equal(afterSecond.status, 'retrying');
  await sql`UPDATE webhook_deliveries SET next_attempt_at = ${dueNow()} WHERE id = ${delivery.id}`;
  await attemptDelivery(sql, await claimOne(delivery.id));
  const [afterThird] =
    await sql`SELECT status, attempt FROM webhook_deliveries WHERE id = ${delivery.id}`;
  assert.equal(afterThird.status, 'retrying');
  await sql`UPDATE webhook_deliveries SET next_attempt_at = ${dueNow()} WHERE id = ${delivery.id}`;
  await attemptDelivery(sql, await claimOne(delivery.id));
  const [afterFourth] =
    await sql`SELECT status, attempt, next_attempt_at FROM webhook_deliveries WHERE id = ${delivery.id}`;
  assert.equal(afterFourth.status, 'failed');
  assert.equal(afterFourth.attempt, 4);
  assert.equal(afterFourth.next_attempt_at, null);

  const [hook] = await sql`SELECT last_delivery_status FROM webhooks WHERE id = ${webhookId}`;
  assert.equal(hook.last_delivery_status, 'error');
});

test('the retry delay is measured from the end of the attempt, not the claim', async () => {
  // The claim's clock is taken before the attempt, and an attempt can take up to
  // DELIVERY_TIMEOUT_MS. Stamping the deadline from the claim meant a slow first
  // attempt wrote a retry date that had already passed, so the row was due again
  // the moment it landed and the backoff bought nothing.
  const { ns } = await makeOwner();
  const webhookId = await insertWebhook(ns, 'https://172.31.255.7/hook', ['version.published']);
  const [delivery] = await sql`
    INSERT INTO webhook_deliveries (webhook_id, event, payload, body, signature)
    VALUES (${webhookId}, 'version.published', ${sql.json({ hello: 'world' })}, '{}', 'sig')
    RETURNING id
  `;

  // A long-failing attempt, the way a destination that stops answering looks.
  const claimed = await claimOne(delivery.id);
  const startedAt = Date.now();
  const result = await attemptDelivery(sql, claimed, async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    throw new Error('receiver is gone');
  });
  const completedAt = Date.now();
  assert.equal(result.ok, false);
  assert.ok(
    completedAt - startedAt >= 400,
    'the attempt has to take real time for the two clocks to differ',
  );

  // RETRY_DELAYS_MS[1]: the first retry waits 5s. The tolerance only has to
  // cover the round trip that writes the row, and stays well under the 400ms
  // the attempt took, so a deadline measured from the claim (which would land
  // 5s after it) cannot pass.
  const [after] =
    await sql`SELECT next_attempt_at FROM webhook_deliveries WHERE id = ${delivery.id}`;
  const deadline = new Date(after.next_attempt_at).getTime();
  assert.ok(deadline >= completedAt + 5000 - 100, 'the wait starts when the attempt ended');
  assert.ok(
    deadline >= startedAt + 5200,
    'a deadline measured from the claim would land inside the attempt',
  );
});

test('deleting a webhook removes its pending deliveries', async () => {
  const { owner, ns } = await makeOwner();
  const created = await request(app)
    .post(`/v1/@${ns}/hooked/webhooks`)
    .set(bearer(owner.token))
    .send({ url: PUBLIC_URL, events: ['version.published'] })
    .expect(201);

  const webhooks = makeWebhooks({ sql });
  await webhooks.scheduleFor(ns, 'hooked', 'version.published', { version: '1.0.0' });
  await settle();
  const count =
    await sql`SELECT COUNT(*)::int AS n FROM webhook_deliveries WHERE webhook_id = ${created.body.id}`;
  assert.equal(count[0].n, 1);

  await request(app)
    .delete(`/v1/@${ns}/hooked/webhooks/${created.body.id}`)
    .set(bearer(owner.token))
    .expect(204);
  await request(app)
    .delete(`/v1/@${ns}/hooked/webhooks/${created.body.id}`)
    .set(bearer(owner.token))
    .expect(404);

  const after =
    await sql`SELECT COUNT(*)::int AS n FROM webhook_deliveries WHERE webhook_id = ${created.body.id}`;
  assert.equal(after[0].n, 0);
});

test('ssrf guard rejects loopback hosts and non-https schemes', async () => {
  const { assertPublicWebhookUrl } = await import('../src/webhooks.js');

  await assert.rejects(() => assertPublicWebhookUrl('https://localhost:8080/'), /Localhost/);
  await assert.rejects(() => assertPublicWebhookUrl('https://127.0.0.1:8080/'), /public/);
  await assert.rejects(() => assertPublicWebhookUrl('ftp://hooks.example.test/'), /https/);
  // A private destination is refused, so no receiver gains from plaintext.
  await assert.rejects(() => assertPublicWebhookUrl('http://hooks.example.com/'), /https/);
});

test('a delivery re-checks the destination and refuses a private address', async () => {
  const { ns } = await makeOwner();
  const webhookId = await insertWebhook(ns, 'https://172.31.255.7/hook', ['version.published']);
  const [delivery] = await sql`
    INSERT INTO webhook_deliveries (webhook_id, event, payload, body, signature)
    VALUES (${webhookId}, 'version.published', ${sql.json({ hello: 'world' })}, '{}',
            'test-signature')
    RETURNING *
  `;

  // The row was written while the name resolved to a public address, so only a
  // check at delivery time can catch the host flipping to a private one.
  const result = await attemptDelivery(sql, {
    ...(await claimOne(delivery.id)),
    url: 'https://169.254.169.254/latest',
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /public|address/i);
  const [after] =
    await sql`SELECT status, attempt FROM webhook_deliveries WHERE id = ${delivery.id}`;
  assert.equal(after.status, 'retrying');
  assert.equal(after.attempt, 1);
});

test('a claimed delivery is not handed to a second worker', async () => {
  // The old poller selected due rows and only then marked them, so two workers
  // could read the same pending row and both POST it. The claim has to exclude
  // rows an in-flight attempt already owns.
  const { ns } = await makeOwner();
  const webhookId = await insertWebhook(ns, 'https://198.51.100.9/hook', ['version.published']);
  const [delivery] = await sql`
    INSERT INTO webhook_deliveries (webhook_id, event, payload, body, signature)
    VALUES (${webhookId}, 'version.published', ${sql.json({ hello: 'world' })}, '{}', 'sig')
    RETURNING id
  `;

  const first = await claimDue(sql, Date.now());
  assert.deepEqual(
    first.map((row) => row.id),
    [delivery.id],
  );
  assert.equal(first[0].status, 'delivering');
  assert.ok(first[0].next_attempt_at, 'a claimed row carries its lease deadline');

  // A second poll at the same instant -- a peer process, or this worker's own
  // next tick while the attempt is still open -- must come back empty.
  assert.equal((await claimDue(sql, Date.now())).length, 0);
});

test('a delivery stranded as delivering is reclaimed once its lease expires', async () => {
  // A worker that dies mid-attempt never writes an outcome, so its row would sit
  // in 'delivering' forever. The lease in next_attempt_at is what releases it.
  const { ns } = await makeOwner();
  const webhookId = await insertWebhook(ns, 'https://198.51.100.9/hook', ['version.published']);
  const [delivery] = await sql`
    INSERT INTO webhook_deliveries (webhook_id, event, payload, body, signature)
    VALUES (${webhookId}, 'version.published', ${sql.json({ hello: 'world' })}, '{}', 'sig')
    RETURNING id
  `;

  const claimed = (await claimDue(sql, Date.now()))[0];
  assert.equal(claimed.id, delivery.id);

  // Not yet: the lease is still held.
  assert.equal((await claimDue(sql, Date.now())).length, 0);

  const [after] =
    await sql`SELECT status, attempt FROM webhook_deliveries WHERE id = ${delivery.id}`;
  assert.equal(after.status, 'delivering');
  assert.equal(after.attempt, 0, 'a claim alone must not count as an attempt');

  // Past the lease: reclaimed for another attempt.
  await sql`UPDATE webhook_deliveries SET next_attempt_at = ${dueNow()}
            WHERE id = ${delivery.id}`;
  const reclaimed = await claimDue(sql, Date.now());
  assert.deepEqual(
    reclaimed.map((row) => row.id),
    [delivery.id],
  );
});

test('a stale attempt cannot overwrite a delivery another worker has taken', async () => {
  // The guarded write is what stops the original holder from landing its result
  // on a row that has since been reclaimed and possibly retried.
  const { ns } = await makeOwner();
  const webhookId = await insertWebhook(ns, 'https://172.31.255.7/hook', ['version.published']);
  const [delivery] = await sql`
    INSERT INTO webhook_deliveries (webhook_id, event, payload, body, signature)
    VALUES (${webhookId}, 'version.published', ${sql.json({ hello: 'world' })}, '{}', 'sig')
    RETURNING *
  `;

  const claimed = await claimOne(delivery.id);
  // A peer's lease expired and its re-claim landed first, moving the deadline
  // and starting that attempt's own bookkeeping.
  await sql`UPDATE webhook_deliveries SET status = 'delivering', attempt = 2,
              next_attempt_at = now() + interval '1 minute'
            WHERE id = ${delivery.id}`;

  // The stale holder now reports failure; it must not be recorded.
  const result = await attemptDelivery(sql, claimed, async () => {
    throw new Error('receiver is gone');
  });
  assert.equal(result.ok, false);

  const [after] =
    await sql`SELECT status, attempt, last_error FROM webhook_deliveries WHERE id = ${delivery.id}`;
  assert.equal(after.status, 'delivering', 'a non-holder must not resolve the row');
  assert.equal(after.attempt, 2, 'the claim holder attempt count is left alone');
  assert.equal(after.last_error, null);
});
