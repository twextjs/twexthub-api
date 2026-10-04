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
} from './helpers.mjs';

let app, sql;
before(async () => {
  ({ app, sql } = await boot());
});
beforeEach(resetDb);
after(async () => {
  await (await boot()).sql.end();
});

async function seedNotification(namespace, kind, message, payload = {}, readAt = null) {
  const [user] = await sql`SELECT id FROM users WHERE namespace = ${namespace}`;
  const [row] = await sql`
    INSERT INTO notifications (user_id, kind, message, payload, read_at)
    VALUES (${user.id}, ${kind}, ${message}, ${sql.json(payload)}::jsonb, ${readAt})
    RETURNING *
  `;
  return row;
}

test('notifications list requires auth', async () => {
  const r = await request(app).get('/v1/notifications').expect(401);
  assert.match(r.body.detail, /Missing or invalid bearer token/);
});

test('lists notifications newest first, unreadCount included', async () => {
  const { user, token } = await signupAndAccept(app, uniqNs());
  const maintenance = await seedNotification(
    user.namespace,
    'broadcast',
    'Maintenance tonight.',
    {},
    new Date(),
  );
  const oldest = await seedNotification(user.namespace, 'broadcast', 'Welcome to the registry.');
  const newest = await seedNotification(
    user.namespace,
    'review.rejected',
    'myext@1.0.0 was rejected: bad blocks.',
    { namespace: user.namespace, id: 'myext', version: '1.0.0', reason: 'bad blocks.' },
  );

  const r = await request(app).get('/v1/notifications').set(bearer(token)).expect(200);
  const ids = r.body.data.map((n) => n.id);
  assert.deepEqual(ids, [String(newest.id), String(oldest.id), String(maintenance.id)]);
  assert.equal(r.body.unreadCount, 2);
  assert.equal(r.body._links.next, null);

  const rejected = r.body.data.find((n) => n.kind === 'review.rejected');
  assert.equal(rejected.read, false);
  assert.deepEqual(rejected.payload, {
    namespace: user.namespace,
    id: 'myext',
    version: '1.0.0',
    reason: 'bad blocks.',
  });
});

test('one user never sees another user’s notifications', async () => {
  const mine = await signupAndAccept(app, uniqNs());
  const theirs = await signupAndAccept(app, uniqNs());
  await seedNotification(theirs.user.namespace, 'broadcast', 'not yours');

  const r = await request(app).get('/v1/notifications').set(bearer(mine.token)).expect(200);
  assert.equal(r.body.data.length, 0);
  assert.equal(r.body.unreadCount, 0);
});

test('unread=true filters, and unreadCount reflects all rows not the page', async () => {
  const { user, token } = await signupAndAccept(app, uniqNs());
  await seedNotification(user.namespace, 'broadcast', 'read one', {}, new Date());
  await seedNotification(user.namespace, 'broadcast', 'unread one');
  await seedNotification(user.namespace, 'broadcast', 'unread two');

  const r = await request(app).get('/v1/notifications?unread=true').set(bearer(token)).expect(200);
  assert.equal(r.body.data.length, 2);
  assert.ok(r.body.data.every((n) => n.read === false));
  assert.equal(r.body.unreadCount, 2);
});

test('unread=true rejects values other than true', async () => {
  const { token } = await signupAndAccept(app, uniqNs());
  await request(app).get('/v1/notifications?unread=1').set(bearer(token)).expect(400);
});

test('pagination walks newest to oldest', async () => {
  const { user, token } = await signupAndAccept(app, uniqNs());
  for (let i = 0; i < 5; i += 1) {
    await seedNotification(user.namespace, 'broadcast', `note ${i}`);
  }

  const page1 = await request(app).get('/v1/notifications?limit=2').set(bearer(token)).expect(200);
  assert.equal(page1.body.data.length, 2);
  assert.ok(page1.body._links.next);
  assert.equal(page1.body._links.prev, null);

  const page2 = await request(app).get(page1.body._links.next).set(bearer(token)).expect(200);
  assert.equal(page2.body.data.length, 2);
  assert.ok(page2.body._links.next);

  const page3 = await request(app).get(page2.body._links.next).set(bearer(token)).expect(200);
  assert.equal(page3.body.data.length, 1);
  assert.equal(page3.body._links.next, null);

  const all = [...page1.body.data, ...page2.body.data, ...page3.body.data];
  assert.deepEqual(
    all.map((n) => n.message),
    ['note 4', 'note 3', 'note 2', 'note 1', 'note 0'],
  );

  // Each page can be undone, and following prev all the way out rebuilds the
  // walk in reverse without repeating or dropping a row.
  const backwards = [...page3.body.data];
  let link = page3.body._links.prev;
  while (link) {
    const page = await request(app).get(link).set(bearer(token)).expect(200);
    backwards.unshift(...page.body.data);
    link = page.body._links.prev;
  }
  assert.deepEqual(
    backwards.map((n) => n.message),
    ['note 4', 'note 3', 'note 2', 'note 1', 'note 0'],
  );

  // A page reached by going back points forward at the page it came from, so
  // the two links close the same loop the forward walk opened.
  const before = await request(app).get(page2.body._links.prev).set(bearer(token)).expect(200);
  assert.equal(before._links, undefined);
  assert.equal(before.body._links.next, page2.body._links.self);
});

test('automation tokens can list notifications', async () => {
  const { token } = await signupAndAccept(app, uniqNs());
  const created = await request(app)
    .post('/v1/tokens')
    .set(bearer(token))
    .send({ name: 'ci', scopes: ['publish'] })
    .expect(201);

  const r = await request(app).get('/v1/notifications').set(bearer(created.body.token)).expect(200);
  assert.equal(r.body.data.length, 0);
});

test('mark-read with ids only touches the caller’s rows', async () => {
  const mine = await signupAndAccept(app, uniqNs());
  const theirs = await signupAndAccept(app, uniqNs());
  const a = await seedNotification(mine.user.namespace, 'broadcast', 'a');
  const b = await seedNotification(mine.user.namespace, 'broadcast', 'b');
  await seedNotification(theirs.user.namespace, 'broadcast', 'theirs');

  const r = await request(app)
    .patch('/v1/notifications')
    .set(bearer(mine.token))
    .send({ ids: [a.id, b.id] })
    .expect(200);
  assert.equal(r.body.updated, 2);

  const list = await request(app).get('/v1/notifications').set(bearer(mine.token)).expect(200);
  assert.equal(list.body.unreadCount, 0);
  assert.ok(list.body.data.every((n) => n.read === true));

  const other = await request(app).get('/v1/notifications').set(bearer(theirs.token)).expect(200);
  assert.equal(other.body.unreadCount, 1);
  assert.equal(other.body.data[0].read, false);
});

test('mark-read is idempotent and reports only newly read rows', async () => {
  const { user, token } = await signupAndAccept(app, uniqNs());
  const a = await seedNotification(user.namespace, 'broadcast', 'a');
  const b = await seedNotification(user.namespace, 'broadcast', 'b');

  const first = await request(app)
    .patch('/v1/notifications')
    .set(bearer(token))
    .send({ ids: [a.id] })
    .expect(200);
  assert.equal(first.body.updated, 1);

  const again = await request(app)
    .patch('/v1/notifications')
    .set(bearer(token))
    .send({ ids: [a.id] })
    .expect(200);
  assert.equal(again.body.updated, 0);

  const rest = await request(app)
    .patch('/v1/notifications')
    .set(bearer(token))
    .send({ ids: [String(a.id), b.id] })
    .expect(200);
  assert.equal(rest.body.updated, 1);
});

test('mark-read with all clears the mailbox', async () => {
  const { user, token } = await signupAndAccept(app, uniqNs());
  await seedNotification(user.namespace, 'broadcast', 'a');
  await seedNotification(user.namespace, 'broadcast', 'b');

  const r = await request(app)
    .patch('/v1/notifications')
    .set(bearer(token))
    .send({ all: true })
    .expect(200);
  assert.equal(r.body.updated, 2);

  const list = await request(app).get('/v1/notifications').set(bearer(token)).expect(200);
  assert.equal(list.body.unreadCount, 0);
  assert.equal(list.body.data.length, 2);
});

test('mark-read rejects unknown fields and invalid ids', async () => {
  const { user, token } = await signupAndAccept(app, uniqNs());
  const n = await seedNotification(user.namespace, 'broadcast', 'a');

  const both = await request(app)
    .patch('/v1/notifications')
    .set(bearer(token))
    .send({ ids: [n.id], all: true })
    .expect(422);
  assert.ok(both.body.errors.some((e) => e.field === 'ids'));

  const neither = await request(app)
    .patch('/v1/notifications')
    .set(bearer(token))
    .send({})
    .expect(422);

  const notArray = await request(app)
    .patch('/v1/notifications')
    .set(bearer(token))
    .send({ ids: n.id })
    .expect(422);

  const zero = await request(app)
    .patch('/v1/notifications')
    .set(bearer(token))
    .send({ ids: [0, -3, 1.5] })
    .expect(422);

  const allFalse = await request(app)
    .patch('/v1/notifications')
    .set(bearer(token))
    .send({ all: false })
    .expect(422);

  assert.equal(neither.status, 422);
  assert.equal(notArray.status, 422);
  assert.equal(zero.status, 422);
  assert.equal(allFalse.status, 422);
});

test('mark-read caps ids at 100', async () => {
  const { token } = await signupAndAccept(app, uniqNs());
  const ids = Array.from({ length: 101 }, (_, i) => i + 1);
  const r = await request(app)
    .patch('/v1/notifications')
    .set(bearer(token))
    .send({ ids })
    .expect(422);
  assert.match(r.body.errors[0].message, /at most 100/);
});

test('the 200-row prune keeps the newest per-user rows', async () => {
  const { user, token } = await signupAndAccept(app, uniqNs());
  for (let i = 0; i < 210; i += 1) {
    await seedNotification(user.namespace, 'broadcast', `note ${i}`);
  }

  const r = await request(app).get('/v1/notifications?limit=50').set(bearer(token)).expect(200);
  assert.equal(r.body.data.length, 50);
  assert.ok(r.body._links.next);

  const [count] = await sql`
    SELECT COUNT(*) AS count FROM notifications
    WHERE user_id = (SELECT id FROM users WHERE namespace = ${user.namespace})
  `;
  assert.equal(Number(count.count), 200);
  assert.equal(r.body.data[0].message, 'note 209');
});

test('mark-read requires auth', async () => {
  await request(app).patch('/v1/notifications').send({ all: true }).expect(401);
});

test('one notification is patched on its own resource', async () => {
  const { user, token } = await signupAndAccept(app, uniqNs());
  await seedNotification(user.namespace, 'broadcast', 'only mine');
  const other = await signupAndAccept(app, uniqNs());
  await seedNotification(other.user.namespace, 'broadcast', 'someone else');

  const before = await request(app).get('/v1/notifications').set(bearer(token)).expect(200);
  const id = before.body.data[0].id;
  assert.equal(before.body.data[0].read, false);

  const patched = await request(app)
    .patch(`/v1/notifications/${id}`)
    .set(bearer(token))
    .expect(200);
  assert.equal(patched.body.id, id);
  assert.equal(patched.body.read, true);
  assert.equal(patched.body.message, 'only mine');

  // Idempotent: patching again reports read, and the mailbox still shows it once.
  const again = await request(app).patch(`/v1/notifications/${id}`).set(bearer(token)).expect(200);
  assert.equal(again.body.read, true);
  const after = await request(app).get('/v1/notifications').set(bearer(token)).expect(200);
  assert.equal(after.body.unreadCount, 0);

  // Another account's notification is a 404, so this does not confirm it exists.
  const [theirs] = await sql`
    SELECT id FROM notifications
    WHERE user_id = (SELECT id FROM users WHERE namespace = ${other.user.namespace})
  `;
  await request(app).patch(`/v1/notifications/${theirs.id}`).set(bearer(token)).expect(404);
  await request(app).patch('/v1/notifications/abc').set(bearer(token)).expect(404);
  await request(app).patch('/v1/notifications/999999').set(bearer(token)).expect(404);
});

// ---- emit points

async function promoteToAdmin(namespace) {
  await sql`UPDATE users SET role = 'admin' WHERE namespace = ${namespace}`;
}

async function publishPending(app, { token, namespace, id, version }) {
  return publishProject(app, namespace, id, token, { version, code: 'console.log(1);' });
}

async function notificationsFor(token, query = '') {
  const r = await request(app).get(`/v1/notifications${query}`).set(bearer(token)).expect(200);
  return r.body;
}

test('approving a pending version notifies the owner', async () => {
  const owner = await signupAndAccept(app, uniqNs());
  const admin = await signupAndAccept(app, uniqNs());
  await promoteToAdmin(admin.user.namespace);

  const published = await publishPending(app, {
    token: owner.token,
    namespace: owner.user.namespace,
    id: 'myext',
    version: '1.0.0',
  });
  assert.equal(published.status, 201, `publish failed: ${JSON.stringify(published.body)}`);
  assert.equal(published.body.status, 'pending');

  const approve = await request(app)
    .patch(`/v1/@${owner.user.namespace}/myext/versions/1.0.0`)
    .set(bearer(admin.token))
    .send({ status: 'approved' })
    .expect(200);
  assert.equal(approve.body.status, 'published');

  const body = await notificationsFor(owner.token);
  assert.equal(body.unreadCount, 1);
  const note = body.data[0];
  assert.equal(note.kind, 'review.approved');
  assert.match(note.message, /myext@1\.0\.0 was approved/);
  assert.deepEqual(note.payload, {
    namespace: owner.user.namespace,
    id: 'myext',
    version: '1.0.0',
  });
});

test('rejecting a pending version notifies the owner with the reason', async () => {
  const owner = await signupAndAccept(app, uniqNs());
  const admin = await signupAndAccept(app, uniqNs());
  await promoteToAdmin(admin.user.namespace);

  await publishPending(app, {
    token: owner.token,
    namespace: owner.user.namespace,
    id: 'myext',
    version: '1.0.0',
  });

  const reason = 'The block ID collides with an existing extension.';
  const reject = await request(app)
    .patch(`/v1/@${owner.user.namespace}/myext/versions/1.0.0`)
    .set(bearer(admin.token))
    .send({ status: 'rejected', reason })
    .expect(200);
  assert.equal(reject.body.status, 'rejected');

  const body = await notificationsFor(owner.token);
  assert.equal(body.unreadCount, 1);
  const note = body.data[0];
  assert.equal(note.kind, 'review.rejected');
  assert.match(note.message, new RegExp(`was rejected: ${reason}`));
  assert.equal(note.payload.reason, reason);
});

test('publishes that skip review do not notify', async () => {
  const owner = await signupAndAccept(app, uniqNs());
  await sql`UPDATE users SET has_published = true WHERE namespace = ${owner.user.namespace}`;

  const published = await publishPending(app, {
    token: owner.token,
    namespace: owner.user.namespace,
    id: 'myext',
    version: '1.0.0',
  });
  assert.equal(published.status, 201, `publish failed: ${JSON.stringify(published.body)}`);
  assert.equal(published.body.status, 'published');

  const body = await notificationsFor(owner.token);
  assert.equal(body.data.length, 0);
});

test('a terms bump notifies only accounts that had accepted the previous version', async () => {
  const accepted = await signupAndAccept(app, uniqNs());
  const neverAccepted = await signup(app, uniqNs());
  assert.equal(neverAccepted.status, 201);
  const admin = await signupAndAccept(app, uniqNs());
  await promoteToAdmin(admin.user.namespace);

  const bump = await request(app)
    .patch('/v1/admin/terms')
    .set(bearer(admin.token))
    .send({ body: 'Updated terms body.' })
    .expect(200);
  assert.equal(bump.body.version, 2);

  const acceptedList = await notificationsFor(accepted.token);
  assert.equal(acceptedList.unreadCount, 1);
  assert.equal(acceptedList.data[0].kind, 'terms.bumped');
  assert.match(acceptedList.data[0].message, /version 2/);

  const adminList = await notificationsFor(admin.token);
  assert.equal(adminList.unreadCount, 1);

  const neverList = await request(app)
    .get('/v1/notifications')
    .set(bearer(neverAccepted.body.token))
    .expect(200);
  assert.equal(neverList.body.data.length, 0);
});

test('the first terms document is not a bump', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  await promoteToAdmin(admin.user.namespace);

  // Roll the registry back to the pre-terms bootstrap state.
  await sql`DELETE FROM legal_documents`;
  await sql`UPDATE users SET terms_accepted_version = NULL`;

  const created = await request(app)
    .patch('/v1/admin/terms')
    .set(bearer(admin.token))
    .send({ body: 'First terms.' })
    .expect(200);
  assert.equal(created.body.version, 1);

  const body = await notificationsFor(admin.token);
  assert.equal(body.data.length, 0);
});

test('an admin password reset notifies the target, self-service does not', async () => {
  const target = await signupAndAccept(app, uniqNs());
  const admin = await signupAndAccept(app, uniqNs());
  await promoteToAdmin(admin.user.namespace);

  await request(app)
    .patch(`/v1/users/${target.user.namespace}`)
    .set(bearer(admin.token))
    .send({ password: 'newpassword1' })
    .expect(200);

  const rows = await sql`
    SELECT kind, message FROM notifications
    WHERE user_id = (SELECT id FROM users WHERE namespace = ${target.user.namespace})
    ORDER BY id DESC
  `;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'tokens.revoked');
  assert.match(rows[0].message, new RegExp(`@${admin.user.namespace}`));

  const relogin = await request(app)
    .post('/v1/sessions')
    .send({ namespace: target.user.namespace, password: 'newpassword1' })
    .expect(201);
  await request(app)
    .patch(`/v1/users/${target.user.namespace}`)
    .set(bearer(relogin.body.token))
    .send({ password: 'newpassword2', currentPassword: 'newpassword1' })
    .expect(200);

  const after = await sql`
    SELECT COUNT(*) AS count FROM notifications
    WHERE user_id = (SELECT id FROM users WHERE namespace = ${target.user.namespace})
  `;
  assert.equal(Number(after[0].count), 1);
});

test('a role change notifies the target', async () => {
  const target = await signupAndAccept(app, uniqNs());
  const admin = await signupAndAccept(app, uniqNs());
  await promoteToAdmin(admin.user.namespace);

  await request(app)
    .patch(`/v1/users/${target.user.namespace}`)
    .set(bearer(admin.token))
    .send({ role: 'admin' })
    .expect(200);

  const body = await notificationsFor(target.token);
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].kind, 'role.changed');
  assert.deepEqual(body.data[0].payload, { role: 'admin' });
});

// ---- broadcast

test('only an admin can broadcast, and it reaches every account', async () => {
  const a = await signupAndAccept(app, uniqNs());
  const b = await signupAndAccept(app, uniqNs());
  const admin = await signupAndAccept(app, uniqNs());
  await promoteToAdmin(admin.user.namespace);

  const asAdmin = await request(app)
    .post('/v1/admin/notifications')
    .set(bearer(admin.token))
    .send({ message: 'Scheduled maintenance tonight at 02:00 UTC.' })
    .expect(201);
  // resetDb truncates users with RESTART IDENTITY, so exactly these three
  // accounts exist; an extra row here means the fan-out double-inserted.
  assert.equal(asAdmin.body.created, 3);

  for (const account of [a, b, admin]) {
    const body = await notificationsFor(account.token);
    const note = body.data.find((n) => n.kind === 'broadcast');
    assert.ok(note, `no broadcast for ${account.user.namespace}`);
    assert.equal(note.message, 'Scheduled maintenance tonight at 02:00 UTC.');
    assert.deepEqual(note.payload, {});
  }
});

test('broadcast requires a session and a non-empty message', async () => {
  await signupAndAccept(app, uniqNs());
  const admin = await signupAndAccept(app, uniqNs());
  await promoteToAdmin(admin.user.namespace);

  await request(app).post('/v1/admin/notifications').send({ message: 'x' }).expect(401);

  const created = await request(app)
    .post('/v1/tokens')
    .set(bearer(admin.token))
    .send({ name: 'ci', scopes: ['publish'] })
    .expect(201);
  await request(app)
    .post('/v1/admin/notifications')
    .set(bearer(created.body.token))
    .send({ message: 'x' })
    .expect(403);

  await request(app)
    .post('/v1/admin/notifications')
    .set(bearer(admin.token))
    .send({ message: '' })
    .expect(422);
  await request(app).post('/v1/admin/notifications').set(bearer(admin.token)).send({}).expect(422);

  const long = await request(app)
    .post('/v1/admin/notifications')
    .set(bearer(admin.token))
    .send({ message: 'x'.repeat(281) })
    .expect(422);
  assert.match(long.body.errors[0].message, /280/);
});
