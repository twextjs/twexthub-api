import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {
  apiPath,
  approveVersion,
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
  // The report window is small here so that the limit is reachable without a
  // hundred requests. The bucket is counted per reporter, and every test
  // files its reports under an account of its own. The signup window is opened
  // up alongside it, because the test that reaches the report limit needs a
  // target account for every report it files.
  ({ app, db } = await boot({ rateLimits: { reportsPerWindow: 5, signupsPerIpPerWindow: 100 } }));
});
beforeEach(resetDb);
after(async () => {
  await db.$disconnect();
});

// The first account created after a reset is the one that gets the admin role.
async function adminAccount() {
  return signupAndAccept(app, uniqNs());
}

const fileReport = (token, body) =>
  request(app).post(apiPath('/reports')).set(bearer(token)).send(body);

const queue = (token, query = '') =>
  request(app)
    .get(apiPath(`/admin/reports${query}`))
    .set(bearer(token));

const decide = (token, id, body) =>
  request(app)
    .patch(apiPath(`/admin/reports/${id}`))
    .set(bearer(token))
    .send(body);

test('a report needs an authenticated caller', async () => {
  await request(app)
    .post(apiPath('/reports'))
    .send({
      targetType: 'user',
      targetNamespace: uniqNs(),
      reason: 'spam',
      description: 'Spam.',
    })
    .expect(401);
});

test('a report has to be about something that is there', async () => {
  const admin = await adminAccount();
  const reporter = await signupAndAccept(app, uniqNs());

  // An account that does not exist.
  await fileReport(reporter.token, {
    targetType: 'user',
    targetNamespace: uniqNs(),
    reason: 'spam',
    description: 'Spam.',
  }).expect(404);

  // An extension that was never published.
  await fileReport(reporter.token, {
    targetType: 'extension',
    targetNamespace: admin.user.namespace,
    targetExtensionId: 'nothing',
    reason: 'spam',
    description: 'Spam.',
  }).expect(404);

  // A namespace that is not a namespace.
  await fileReport(reporter.token, {
    targetType: 'user',
    targetNamespace: 'Not A Namespace',
    reason: 'spam',
    description: 'Spam.',
  }).expect(422);

  // A category that is not one of the categories.
  await fileReport(reporter.token, {
    targetType: 'user',
    targetNamespace: admin.user.namespace,
    reason: 'because',
    description: 'Spam.',
  }).expect(422);

  // A description that says nothing.
  await fileReport(reporter.token, {
    targetType: 'user',
    targetNamespace: admin.user.namespace,
    reason: 'spam',
    description: '   ',
  }).expect(422);
});

test('an organization is a target of its own', async () => {
  const owner = await signupAndAccept(app, uniqNs());
  const org = uniqNs();
  await request(app)
    .post(apiPath('/orgs'))
    .set(bearer(owner.token))
    .send({ namespace: org, displayName: 'Acme Inc' })
    .expect(201);

  const reporter = await signupAndAccept(app, uniqNs());
  const created = await fileReport(reporter.token, {
    targetType: 'organization',
    targetNamespace: org,
    reason: 'impersonation',
    description: 'It pretends to be somebody else.',
  }).expect(201);
  assert.equal(created.body.target.namespace, org);

  // The same namespace filed as an account is a different kind of target, and
  // the report is refused rather than quietly recorded as one.
  await fileReport(reporter.token, {
    targetType: 'user',
    targetNamespace: org,
    reason: 'impersonation',
    description: 'It pretends to be somebody else.',
  }).expect(404);
});

test('the reporter is handed a receipt, not the record', async () => {
  const admin = await adminAccount();
  const reporter = await signupAndAccept(app, uniqNs());

  const created = await fileReport(reporter.token, {
    targetType: 'user',
    targetNamespace: admin.user.namespace,
    reason: 'spam',
    description: 'This account is sending spam.',
  }).expect(201);
  assert.equal(created.body.status, 'open');
  assert.equal(created.body.target.namespace, admin.user.namespace);
  assert.equal(created.body.reason, 'spam');
  // What the report says, and who said it, are the reviewer's business.
  assert.equal(created.body.description, undefined);
  assert.equal(created.body.reporter, undefined);
  assert.equal(created.body.resolutionNote, undefined);
  assert.equal(created.body.reviewedBy, undefined);

  // The reporter may read its own report, and it is the same reduced view.
  const own = await request(app)
    .get(apiPath(`/reports/${created.body.id}`))
    .set(bearer(reporter.token))
    .expect(200);
  assert.deepEqual(own.body, created.body);

  // And nobody else's.
  const stranger = await signupAndAccept(app, uniqNs());
  await request(app)
    .get(apiPath(`/reports/${created.body.id}`))
    .set(bearer(stranger.token))
    .expect(404);
  await request(app)
    .get(apiPath(`/reports/${created.body.id}`))
    .expect(401);
});

test('a reporter cannot pile a second open report onto the same target', async () => {
  const admin = await adminAccount();
  const reporter = await signupAndAccept(app, uniqNs());
  const body = {
    targetType: 'user',
    targetNamespace: admin.user.namespace,
    reason: 'spam',
    description: 'Spam.',
  };

  const first = await fileReport(reporter.token, body).expect(201);
  await fileReport(reporter.token, body).expect(409);

  // Once the report has been decided, the reporter may file another one.
  await decide(admin.token, first.body.id, {
    status: 'dismissed',
    note: 'Not a violation.',
  }).expect(200);
  await fileReport(reporter.token, body).expect(201);
});

test('the report and the reporter are the reviewer’s to read', async () => {
  const admin = await adminAccount();
  const target = await signupAndAccept(app, uniqNs());
  const reporter = await signupAndAccept(app, uniqNs());
  const created = await fileReport(reporter.token, {
    targetType: 'user',
    targetNamespace: target.user.namespace,
    reason: 'spam',
    description: 'This account is sending spam.',
  }).expect(201);

  // The queue is not for the reporter, and not for a stranger either.
  await queue(reporter.token).expect(403);
  await queue(target.token).expect(403);
  await request(app).get(apiPath('/admin/reports')).expect(401);

  const list = await queue(admin.token).expect(200);
  assert.equal(list.body.data.length, 1);
  const row = list.body.data[0];
  assert.equal(row.id, created.body.id);
  assert.equal(row.reporter, reporter.user.namespace);
  assert.equal(row.description, 'This account is sending spam.');
  assert.equal(row.status, 'open');

  // The queue can be narrowed to the reports still waiting.
  await queue(admin.token, '?status=open').expect(200);
  const decided = await queue(admin.token, '?status=resolved').expect(200);
  assert.equal(decided.body.data.length, 0);
  await queue(admin.token, '?status=maybe').expect(422);
});

test('a decision records who made it, when, and why', async () => {
  const admin = await adminAccount();
  const reporter = await signupAndAccept(app, uniqNs());
  const created = await fileReport(reporter.token, {
    targetType: 'user',
    targetNamespace: admin.user.namespace,
    reason: 'spam',
    description: 'This account is sending spam.',
  }).expect(201);

  const decided = await decide(admin.token, created.body.id, {
    status: 'resolved',
    note: 'The account was suspended.',
  }).expect(200);
  assert.equal(decided.body.status, 'resolved');
  assert.equal(decided.body.reviewedBy, admin.user.namespace);
  assert.ok(decided.body.reviewedAt);
  assert.equal(decided.body.resolutionNote, 'The account was suspended.');

  // The reporter learns that it was decided, and nothing else.
  const own = await request(app)
    .get(apiPath(`/reports/${created.body.id}`))
    .set(bearer(reporter.token))
    .expect(200);
  assert.equal(own.body.status, 'resolved');
  assert.equal(own.body.resolutionNote, undefined);
  assert.equal(own.body.reviewedBy, undefined);

  // The decision is in the audit trail, with the reviewer who made it.
  const trail = await request(app)
    .get(apiPath('/admin/audit'))
    .set(bearer(admin.token))
    .expect(200);
  const entry = trail.body.data.find((row) => row.action === 'report.resolve');
  assert.ok(entry, 'the decision is audited');
  assert.equal(entry.detail.reportId, created.body.id);
  assert.equal(entry.actor, admin.user.namespace);
});

test('a decision has to be one of the two outcomes', async () => {
  const admin = await adminAccount();
  const reporter = await signupAndAccept(app, uniqNs());
  const created = await fileReport(reporter.token, {
    targetType: 'user',
    targetNamespace: admin.user.namespace,
    reason: 'spam',
    description: 'Spam.',
  }).expect(201);

  // There is no way back to open, and no outcome that is not one of the two.
  await decide(admin.token, created.body.id, { status: 'open' }).expect(422);
  await decide(admin.token, created.body.id, { status: 'deleted' }).expect(422);
  // A decision without a reason is not a decision anybody can account for.
  await decide(admin.token, created.body.id, { status: 'resolved', note: '  ' }).expect(422);

  // The reporter cannot decide their own report, and a missing one is a 404.
  await decide(reporter.token, created.body.id, { status: 'resolved' }).expect(403);
  await decide(admin.token, 999999, { status: 'resolved' }).expect(404);
});

test('submissions are rate limited per reporter', async () => {
  await adminAccount();
  const reporter = await signupAndAccept(app, uniqNs());
  const targets = [];
  for (let i = 0; i < 6; i += 1) targets.push(await signupAndAccept(app, uniqNs()));

  for (const target of targets.slice(0, 5)) {
    await fileReport(reporter.token, {
      targetType: 'user',
      targetNamespace: target.user.namespace,
      reason: 'spam',
      description: 'Spam.',
    }).expect(201);
  }
  await fileReport(reporter.token, {
    targetType: 'user',
    targetNamespace: targets[5].user.namespace,
    reason: 'spam',
    description: 'Spam.',
  }).expect(429);
});

test('a report outlives the account it is about', async () => {
  const admin = await adminAccount();
  const target = await signupAndAccept(app, uniqNs());
  const reporter = await signupAndAccept(app, uniqNs());
  const created = await fileReport(reporter.token, {
    targetType: 'user',
    targetNamespace: target.user.namespace,
    reason: 'spam',
    description: 'This account is sending spam.',
  }).expect(201);

  await request(app)
    .delete(apiPath(`/users/${target.user.namespace}`))
    .set(bearer(admin.token))
    .expect(204);

  // The report is still in the queue, still saying what was reported: a
  // deleted account does not take the complaint about it with it.
  const list = await queue(admin.token).expect(200);
  assert.equal(list.body.data.length, 1);
  assert.equal(list.body.data[0].id, created.body.id);
  assert.equal(list.body.data[0].target.namespace, target.user.namespace);
});

test('a report follows the extension it is about', async () => {
  const admin = await adminAccount();
  const owner = await signupAndAccept(app, uniqNs());
  const recipient = await signupAndAccept(app, uniqNs());
  const reporter = await signupAndAccept(app, uniqNs());
  await publishProject(app, owner.user.namespace, 'hello', owner.token);
  await approveVersion(app, admin.token, owner.user.namespace, 'hello', '1.0.0');

  const created = await fileReport(reporter.token, {
    targetType: 'extension',
    targetNamespace: owner.user.namespace,
    targetExtensionId: 'hello',
    reason: 'malicious_code',
    description: 'It runs code it should not.',
  }).expect(201);
  assert.equal(created.body.target.namespace, owner.user.namespace);
  assert.equal(created.body.target.id, 'hello');

  await request(app)
    .post(apiPath(`/@${owner.user.namespace}/hello/transfers`))
    .set(bearer(owner.token))
    .send({ to: recipient.user.namespace })
    .expect(201);
  await request(app)
    .post(apiPath(`/@${owner.user.namespace}/hello/transfers/${recipient.user.namespace}/accept`))
    .set(bearer(recipient.token))
    .expect(200);

  // The extension moved, so the report about it moved with it: a reviewer
  // reads about the extension, not about the address it used to live at.
  const list = await queue(admin.token).expect(200);
  assert.equal(list.body.data.length, 1);
  assert.equal(list.body.data[0].id, created.body.id);
  assert.equal(list.body.data[0].target.namespace, recipient.user.namespace);
  assert.equal(list.body.data[0].target.id, 'hello');
});

test('a report is filed against where the extension lives now', async () => {
  const admin = await adminAccount();
  const owner = await signupAndAccept(app, uniqNs());
  const recipient = await signupAndAccept(app, uniqNs());
  const reporter = await signupAndAccept(app, uniqNs());
  await publishProject(app, owner.user.namespace, 'hello', owner.token);
  await approveVersion(app, admin.token, owner.user.namespace, 'hello', '1.0.0');

  await request(app)
    .post(apiPath(`/@${owner.user.namespace}/hello/transfers`))
    .set(bearer(owner.token))
    .send({ to: recipient.user.namespace })
    .expect(201);
  await request(app)
    .post(apiPath(`/@${owner.user.namespace}/hello/transfers/${recipient.user.namespace}/accept`))
    .set(bearer(recipient.token))
    .expect(200);

  // The old address redirects, and the report lands on the extension.
  const created = await fileReport(reporter.token, {
    targetType: 'extension',
    targetNamespace: owner.user.namespace,
    targetExtensionId: 'hello',
    reason: 'malicious_code',
    description: 'It runs code it should not.',
  }).expect(201);
  assert.equal(created.body.target.namespace, recipient.user.namespace);
});

test('reports do not act on the target by themselves', async () => {
  const admin = await adminAccount();
  const owner = await signupAndAccept(app, uniqNs());
  await publishProject(app, owner.user.namespace, 'hello', owner.token);
  await approveVersion(app, admin.token, owner.user.namespace, 'hello', '1.0.0');

  // Three accounts, three reports, one extension.
  for (let i = 0; i < 3; i += 1) {
    const reporter = await signupAndAccept(app, uniqNs());
    await fileReport(reporter.token, {
      targetType: 'extension',
      targetNamespace: owner.user.namespace,
      targetExtensionId: 'hello',
      reason: 'malicious_code',
      description: 'It runs code it should not.',
    }).expect(201);
  }

  // Nothing was suspended, hidden, or removed: enforcement is a decision
  // somebody makes by hand, not a count.
  await request(app)
    .get(apiPath(`/@${owner.user.namespace}/hello`))
    .expect(200);
  await publishProject(app, owner.user.namespace, 'hello', owner.token, {
    version: '2.0.0',
    code: '// two',
  });
  const list = await queue(admin.token).expect(200);
  assert.equal(list.body.data.length, 3);
});
