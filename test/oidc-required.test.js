import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { boot, resetDb, apiPath, FIXTURE_PASSWORD } from './helpers.mjs';
import { roundTripProvider, startFakeIdp } from './fake-idp.mjs';

let app;
let idp;

before(async () => {
  idp = await startFakeIdp();
  ({ app } = await boot({
    auth: { oidc: { issuer: idp.issuer, clientId: 'twexthub-test', required: true } },
    rateLimits: { signupsPerIpPerWindow: 10_000 },
  }));
});
beforeEach(async () => {
  await resetDb();
  idp.setClaims({});
  idp.setTokenOptions({});
});
after(async () => {
  await idp.close();
  await (await boot()).db.$disconnect();
});

test('the descriptor says password sign-in is off', async () => {
  const r = await request(app).get(apiPath('/auth')).expect(200);
  assert.equal(r.body.passwordAuth, false);
  assert.equal(r.body.oidc.required, true);
});

test('password registration is refused', async () => {
  const r = await request(app)
    .post(apiPath('/users'))
    .send({ namespace: 'nope', password: FIXTURE_PASSWORD, displayName: 'Nope' });
  assert.equal(r.status, 403);
});

test('password sign-in is refused', async () => {
  const r = await request(app)
    .post(apiPath('/sessions'))
    .send({ namespace: 'whoever', password: FIXTURE_PASSWORD });
  assert.equal(r.status, 403);
});

test('the provider is still a way in', async () => {
  idp.setClaims({ sub: 'sub-required', preferred_username: 'required-user' });
  const agent = request.agent(app);
  const authorize = await agent.get(apiPath('/auth/oidc/authorize')).expect(200);
  const { code, state } = await roundTripProvider(authorize.body.authorizationUrl);
  const callback = await agent.get(apiPath('/auth/oidc/callback')).query({ code, state });
  assert.equal(callback.status, 201);
  assert.equal(callback.body.user.namespace, 'required-user');
});
