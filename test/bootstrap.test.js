import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { acceptTerms, apiPath, bearer, boot, signup, uniqNs } from './helpers.mjs';

// This file deliberately never seeds legal_documents (resetDb does), so it
// exercises a fresh registry where no terms or privacy document exists.

let app, sql;
before(async () => {
  ({ app, sql } = await boot());
});
beforeEach(async () => {
  await sql.unsafe(`
    TRUNCATE TABLE automation_tokens, sessions, versions, rate_limit_entries, notifications, users, legal_documents
    RESTART IDENTITY CASCADE
  `);
});
after(async () => {
  await (await boot()).sql.end();
});

test('a fresh registry can create its first legal documents, then gates writes', async () => {
  const admin = await signup(app, uniqNs());
  assert.equal(admin.body.user.role, 'admin');
  const adminToken = admin.body.token;

  // No terms exist yet, so the terms gate is open.
  await request(app)
    .patch(apiPath(`/users/${admin.body.user.namespace}`))
    .set(bearer(adminToken))
    .send({ displayName: 'Admin' })
    .expect(200);

  const terms = await request(app)
    .patch(apiPath('/admin/terms'))
    .set(bearer(adminToken))
    .send({ body: 'First terms.' })
    .expect(200);
  assert.equal(terms.body.version, 1);
  assert.equal(terms.body.body, 'First terms.');

  const publicTerms = await request(app).get(apiPath('/terms')).expect(200);
  assert.equal(publicTerms.body.version, 1);

  // The admin accepts the document they just created, so later edits pass.
  await acceptTerms(app, admin.body.user.namespace, adminToken);

  const privacy = await request(app)
    .patch(apiPath('/admin/privacy'))
    .set(bearer(adminToken))
    .send({ body: 'First privacy.' })
    .expect(200);
  assert.equal(privacy.body.version, 1);

  // Now that terms exist, an account that has not accepted them is blocked.
  const others = await signup(app, uniqNs());
  assert.equal(others.body.user.role, 'normal');
  await request(app)
    .patch(apiPath(`/users/${others.body.user.namespace}`))
    .set(bearer(others.body.token))
    .send({ displayName: 'Pledger' })
    .expect(403);

  await acceptTerms(app, others.body.user.namespace, others.body.token);
  await request(app)
    .patch(apiPath(`/users/${others.body.user.namespace}`))
    .set(bearer(others.body.token))
    .send({ displayName: 'Pledger' })
    .expect(200);
});
