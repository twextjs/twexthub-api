import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { apiPath, bearer, boot, resetDb, signupAndAccept, uniqNs } from './helpers.mjs';

let app;

before(async () => {
  ({ app } = await boot());
});
beforeEach(resetDb);
after(async () => {
  await (await boot()).db.$disconnect();
});

// Without a page to approve on, a client that asked for a code would wait for
// something nobody can do, so the flow is off rather than half on.
test('the flow is off when no approval page is configured', async () => {
  const descriptor = await request(app).get(apiPath('/auth')).expect(200);
  assert.equal(descriptor.body.device, null);

  await request(app)
    .post(apiPath('/auth/device/code'))
    .send({ clientName: 'Twext CLI' })
    .expect(404);

  const account = await signupAndAccept(app, uniqNs());
  await request(app)
    .post(apiPath('/auth/device/lookup'))
    .set(bearer(account.token))
    .send({ userCode: 'ABCD-EFGH' })
    .expect(404);
  await request(app)
    .post(apiPath('/auth/device/token'))
    .send({ deviceCode: 'anything' })
    .expect(404);
});
