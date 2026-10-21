import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {
  boot,
  resetDb,
  apiPath,
  bearer,
  registerPasskey,
  signupAndAccept,
  uniqNs,
  TEST_PUBLIC_BASE_URL,
} from './helpers.mjs';
import { roundTripProvider, startFakeIdp } from './fake-idp.mjs';

let app;
let idp;

before(async () => {
  idp = await startFakeIdp();
  ({ app } = await boot({
    auth: { oidc: { issuer: idp.issuer, clientId: 'twexthub-test' } },
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

// A browser that carries the flow cookie from authorize to callback. Each flow
// gets its own agent so two flows cannot accidentally share a binding.
function browser() {
  return request.agent(app);
}

async function signIn(claims) {
  idp.setClaims(claims);
  const agent = browser();
  const authorize = await agent.get(apiPath('/auth/oidc/authorize')).expect(200);
  const { code, state } = await roundTripProvider(authorize.body.authorizationUrl);
  return agent.get(apiPath('/auth/oidc/callback')).query({ code, state });
}

// Start a link from a fresh browser signed in with `token`.
async function startLink(token, claims, body = {}) {
  idp.setClaims(claims);
  const agent = browser();
  const link = await agent.post(apiPath('/auth/oidc/link')).set(bearer(token)).send(body);
  return { agent, link };
}

test('the descriptor advertises the provider and password sign-in', async () => {
  const r = await request(app).get(apiPath('/auth')).expect(200);
  assert.equal(r.body.passwordAuth, true);
  assert.equal(r.body.oidc.issuer, idp.issuer);
  assert.equal(r.body.oidc.required, false);
});

test('a first sign-in creates an admin account and a second reuses it', async () => {
  const first = await signIn({ sub: 'sub-alice', preferred_username: 'alice', name: 'Alice' });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.user.namespace, 'alice');
  assert.equal(first.body.user.role, 'admin');
  assert.equal(typeof first.body.token, 'string');
  assert.equal(typeof first.body.session.id, 'string');

  const second = await signIn({ sub: 'sub-alice', preferred_username: 'alice', name: 'Alice' });
  assert.equal(second.status, 201);
  assert.equal(second.body.user.namespace, first.body.user.namespace);
  assert.equal(second.body.user.createdAt, first.body.user.createdAt);
});

test('a browser sign-in returns a one-time code that trades for a session', async () => {
  idp.setClaims({ sub: 'sub-bob', preferred_username: 'bob' });
  const agent = browser();
  const authorize = await agent
    .get(apiPath('/auth/oidc/authorize'))
    .query({ returnTo: '/welcome' })
    .set('Accept', 'text/html')
    .redirects(0)
    .expect(302);
  const { code, state } = await roundTripProvider(authorize.headers.location);

  const callback = await agent
    .get(apiPath('/auth/oidc/callback'))
    .query({ code, state })
    .set('Accept', 'text/html')
    .redirects(0)
    .expect(302);
  const target = new URL(callback.headers.location);
  assert.equal(target.pathname, '/welcome');
  const oidcCode = target.searchParams.get('oidc_code');
  assert.ok(oidcCode);

  const exchange = await request(app)
    .post(apiPath('/auth/oidc/exchange'))
    .send({ code: oidcCode })
    .expect(201);
  assert.equal(exchange.body.user.namespace, 'bob');
  assert.equal(typeof exchange.body.token, 'string');

  // The code is one-time: redeeming it again finds nothing.
  await request(app).post(apiPath('/auth/oidc/exchange')).send({ code: oidcCode }).expect(400);
});

test('an email shared by two subjects does not merge the accounts', async () => {
  const one = await signIn({ sub: 'sub-one', email: 'shared@example.test' });
  const two = await signIn({ sub: 'sub-two', email: 'shared@example.test' });
  assert.notEqual(one.body.user.namespace, two.body.user.namespace);
});

test('a claimed name that cannot be a namespace falls back to a digest', async () => {
  const r = await signIn({ sub: 'sub-weird', preferred_username: '!!!' });
  assert.match(r.body.user.namespace, /^user-[0-9a-f]{12}$/);
});

test('a taken namespace gains a suffix', async () => {
  const first = await signIn({ sub: 'sub-claim-a', preferred_username: 'clash' });
  const second = await signIn({ sub: 'sub-claim-b', preferred_username: 'clash' });
  assert.equal(first.body.user.namespace, 'clash');
  assert.equal(second.body.user.namespace, 'clash-2');
});

test('replaying a state is refused', async () => {
  idp.setClaims({ sub: 'sub-replay' });
  const agent = browser();
  const authorize = await agent.get(apiPath('/auth/oidc/authorize')).expect(200);
  const { code, state } = await roundTripProvider(authorize.body.authorizationUrl);
  await agent.get(apiPath('/auth/oidc/callback')).query({ code, state }).expect(201);
  await agent.get(apiPath('/auth/oidc/callback')).query({ code, state }).expect(400);
});

test('a callback in a different browser is refused', async () => {
  idp.setClaims({ sub: 'sub-crossbrowser' });
  const starter = browser();
  const authorize = await starter.get(apiPath('/auth/oidc/authorize')).expect(200);
  const { code, state } = await roundTripProvider(authorize.body.authorizationUrl);

  // A second browser never saw the flow cookie.
  await request(app).get(apiPath('/auth/oidc/callback')).query({ code, state }).expect(400);
});

test('an unknown state is refused', async () => {
  await request(app)
    .get(apiPath('/auth/oidc/callback'))
    .query({ code: 'whatever', state: 'never-issued' })
    .expect(400);
});

test('an ID token without an exp is rejected', async () => {
  idp.setClaims({ sub: 'sub-noexp' });
  idp.setTokenOptions({ omitExp: true });
  const r = await signIn({ sub: 'sub-noexp' });
  assert.equal(r.status, 502);
  assert.match(r.body.detail, /ID token/);
});

test('a returnTo that is not an allowed origin is refused', async () => {
  for (const returnTo of ['https://evil.example/steal', '//evil.example', 'ftp://evil.example']) {
    await request(app).get(apiPath('/auth/oidc/authorize')).query({ returnTo }).expect(422);
  }
});

test('a returnTo that hides an off-origin redirect behind control characters is refused', async () => {
  // "/<tab>/evil.example" passes a naive leading-slash check, but the URL
  // parser strips the tab and the value resolves to "//evil.example".
  for (const returnTo of ['/\t/evil.example', '/\n/evil.example', `/${'\r'}/evil.example`]) {
    await request(app).get(apiPath('/auth/oidc/authorize')).query({ returnTo }).expect(422);
  }
});

test('an allowed path is kept and an off-origin absolute URL is refused', async () => {
  const ok = await request(app)
    .get(apiPath('/auth/oidc/authorize'))
    .query({ returnTo: '/settings/preferences?tab=account#top' })
    .expect(200);
  assert.ok(ok.body.authorizationUrl);
  await request(app)
    .get(apiPath('/auth/oidc/authorize'))
    .query({ returnTo: 'https://evil.example/steal' })
    .expect(422);
});

test('linking an identity lets the account sign in through it', async () => {
  const { user, token } = await signupAndAccept(app, uniqNs());

  const { agent, link } = await startLink(
    token,
    { sub: 'sub-link', email: 'link@example.test' },
    {
      returnTo: '/settings',
    },
  );
  assert.equal(link.status, 200);
  const { code, state } = await roundTripProvider(link.body.authorizationUrl);
  const callback = await agent
    .get(apiPath('/auth/oidc/callback'))
    .query({ code, state })
    .expect(200);
  assert.equal(callback.body.linked, true);

  const list = await request(app).get(apiPath('/auth/oidc/identities')).set(bearer(token));
  assert.equal(list.status, 200);
  assert.equal(list.body.data.length, 1);
  assert.equal(list.body.data[0].issuer, idp.issuer);
  assert.equal(list.body.data[0].subject, 'sub-link');

  const signedIn = await signIn({ sub: 'sub-link' });
  assert.equal(signedIn.body.user.namespace, user.namespace);
});

test('linking the same identity twice is idempotent for the same account', async () => {
  const { token } = await signupAndAccept(app, uniqNs());
  for (let i = 0; i < 2; i += 1) {
    const { agent, link } = await startLink(token, { sub: 'sub-twice' });
    const { code, state } = await roundTripProvider(link.body.authorizationUrl);
    await agent.get(apiPath('/auth/oidc/callback')).query({ code, state }).expect(200);
  }
  const list = await request(app)
    .get(apiPath('/auth/oidc/identities'))
    .set(bearer(token))
    .expect(200);
  assert.equal(list.body.data.length, 1);
});

test('an identity already linked to another account cannot be claimed again', async () => {
  const owner = await signIn({ sub: 'sub-owner', preferred_username: 'owner' });
  assert.ok(owner.body.token);

  const { token } = await signupAndAccept(app, uniqNs());
  const { agent, link } = await startLink(token, { sub: 'sub-owner' });
  const { code, state } = await roundTripProvider(link.body.authorizationUrl);
  const callback = await agent.get(apiPath('/auth/oidc/callback')).query({ code, state });
  assert.equal(callback.status, 409);
});

test('an account with a password may unlink its only identity', async () => {
  const { token } = await signupAndAccept(app, uniqNs());
  const { agent, link } = await startLink(token, { sub: 'sub-unlink' });
  const { code, state } = await roundTripProvider(link.body.authorizationUrl);
  await agent.get(apiPath('/auth/oidc/callback')).query({ code, state }).expect(200);

  const list = await request(app)
    .get(apiPath('/auth/oidc/identities'))
    .set(bearer(token))
    .expect(200);
  await request(app)
    .delete(apiPath(`/auth/oidc/identities/${list.body.data[0].id}`))
    .set(bearer(token))
    .expect(204);
  const after = await request(app)
    .get(apiPath('/auth/oidc/identities'))
    .set(bearer(token))
    .expect(200);
  assert.equal(after.body.data.length, 0);
});

test('a passwordless account cannot unlink its only way in', async () => {
  const signedIn = await signIn({ sub: 'sub-solo', preferred_username: 'solo' });
  const token = signedIn.body.token;
  const list = await request(app)
    .get(apiPath('/auth/oidc/identities'))
    .set(bearer(token))
    .expect(200);
  assert.equal(list.body.data.length, 1);
  await request(app)
    .delete(apiPath(`/auth/oidc/identities/${list.body.data[0].id}`))
    .set(bearer(token))
    .expect(409);
});

const site = new URL(TEST_PUBLIC_BASE_URL);

// What the second step of a sign-in looks like once the provider has done its
// half: options, then the assertion that answers them.
async function finishMfa(mfaToken, authenticator) {
  const options = await request(app)
    .post(apiPath('/auth/mfa/options'))
    .send({ mfaToken })
    .expect(200);
  return request(app)
    .post(apiPath('/auth/mfa/verify'))
    .send({
      mfaToken,
      response: authenticator.authenticationResponse({
        challenge: options.body.options.challenge,
        origin: site.origin,
        rpId: site.hostname,
      }),
    })
    .expect(201);
}

test('a provider sign-in for an account with a passkey stops at the second factor', async () => {
  const first = await signIn({ sub: 'sub-mfa', preferred_username: 'mfa-owner' });
  assert.equal(first.status, 201);
  const { authenticator } = await registerPasskey(app, first.body.token);

  // The provider vouched for the identity, not for the person at the keyboard.
  const paused = await signIn({ sub: 'sub-mfa', preferred_username: 'mfa-owner' });
  assert.equal(paused.status, 202, JSON.stringify(paused.body));
  assert.equal(paused.body.mfaRequired, true);
  assert.deepEqual(paused.body.methods, ['passkey', 'backup_code']);

  const verified = await finishMfa(paused.body.mfaToken, authenticator);
  assert.equal(verified.body.user.namespace, 'mfa-owner');
  assert.equal(typeof verified.body.token, 'string');
});

test('a browser exchange answers with the second factor rather than a session', async () => {
  const first = await signIn({ sub: 'sub-mfa-web', preferred_username: 'mfa-web' });
  assert.equal(first.status, 201);
  const { authenticator } = await registerPasskey(app, first.body.token);

  const agent = browser();
  const authorize = await agent
    .get(apiPath('/auth/oidc/authorize'))
    .query({ returnTo: '/welcome' })
    .set('Accept', 'text/html')
    .redirects(0)
    .expect(302);
  const { code, state } = await roundTripProvider(authorize.headers.location);
  const callback = await agent
    .get(apiPath('/auth/oidc/callback'))
    .query({ code, state })
    .set('Accept', 'text/html')
    .redirects(0)
    .expect(302);
  const oidcCode = new URL(callback.headers.location).searchParams.get('oidc_code');
  assert.ok(oidcCode);

  const exchange = await request(app)
    .post(apiPath('/auth/oidc/exchange'))
    .send({ code: oidcCode })
    .expect(202);
  assert.equal(exchange.body.mfaRequired, true);

  const verified = await finishMfa(exchange.body.mfaToken, authenticator);
  assert.equal(verified.body.user.namespace, 'mfa-web');
});
