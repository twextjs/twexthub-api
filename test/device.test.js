import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {
  FIXTURE_PASSWORD,
  TEST_PUBLIC_BASE_URL,
  apiPath,
  bearer,
  boot,
  registerPasskey,
  resetDb,
  signupAndAccept,
  uniqNs,
} from './helpers.mjs';

const VERIFICATION_URL = 'https://app.test/device';

let app;
let db;

before(async () => {
  ({ app, db } = await boot({ auth: { device: { verificationUrl: VERIFICATION_URL } } }));
});
beforeEach(resetDb);
after(async () => {
  await (await boot()).db.$disconnect();
});

function requestCode(clientName = 'Twext CLI') {
  return request(app).post(apiPath('/auth/device/code')).send({ clientName });
}

function poll(deviceCode) {
  return request(app).post(apiPath('/auth/device/token')).send({ deviceCode });
}

function approve(token, userCode) {
  return request(app).post(apiPath('/auth/device/approve')).set(bearer(token)).send({ userCode });
}

// The interval is what a real client waits out between polls; a test that
// approved in between should not have to sleep through it.
async function clearPollClock() {
  await db.DeviceCodes.updateMany({ data: { LastPolledAt: null } });
}

function signin(namespace) {
  return request(app).post(apiPath('/sessions')).send({ namespace, password: FIXTURE_PASSWORD });
}

test('the descriptor advertises the approval page and the code endpoint hands out a code', async () => {
  const descriptor = await request(app).get(apiPath('/auth')).expect(200);
  assert.equal(descriptor.body.device.verificationUrl, VERIFICATION_URL);

  const r = await requestCode().expect(200);
  assert.equal(typeof r.body.deviceCode, 'string');
  assert.ok(r.body.deviceCode.length >= 32);
  assert.match(r.body.userCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(r.body.verificationUri, VERIFICATION_URL);
  assert.equal(r.body.expiresIn, 600);
  assert.equal(r.body.interval, 5);

  const complete = new URL(r.body.verificationUriComplete);
  assert.equal(complete.origin, 'https://app.test');
  assert.equal(complete.pathname, '/device');
  assert.equal(complete.searchParams.get('user_code'), r.body.userCode);
  // The code that redeems the sign-in is not in the URL a person visits.
  assert.equal(complete.searchParams.has('device_code'), false);
});

test('a code stays pending until a session approves it, then issues one once', async () => {
  const account = await signupAndAccept(app, uniqNs());
  const code = (await requestCode('Twext CLI on build-box').expect(200)).body;

  const pending = await poll(code.deviceCode).expect(400);
  assert.equal(pending.body.error, 'authorization_pending');

  // Typed back however the person retyped it: lower case, a space for the
  // hyphen.
  const approved = await approve(
    account.token,
    code.userCode.toLowerCase().replace('-', ' '),
  ).expect(200);
  assert.equal(approved.body.approved, true);
  assert.equal(approved.body.clientName, 'Twext CLI on build-box');

  // The pending poll set the clock, so the next one is asked to wait.
  const tooSoon = await poll(code.deviceCode).expect(400);
  assert.equal(tooSoon.body.error, 'slow_down');

  await clearPollClock();
  const issued = await poll(code.deviceCode).expect(200);
  assert.equal(issued.body.user.namespace, account.user.namespace);
  assert.equal(typeof issued.body.token, 'string');

  // The credential works like any other session.
  const me = await request(app).get(apiPath('/auth/mfa')).set(bearer(issued.body.token));
  assert.equal(me.status, 200);

  // And the code is spent, so a second poll cannot mint a second session.
  await clearPollClock();
  const again = await poll(code.deviceCode).expect(400);
  assert.equal(again.body.error, 'expired_token');
});

test('polling faster than the issued interval is told to slow down', async () => {
  const code = (await requestCode().expect(200)).body;
  const first = await poll(code.deviceCode).expect(400);
  assert.equal(first.body.error, 'authorization_pending');
  const second = await poll(code.deviceCode).expect(400);
  assert.equal(second.body.error, 'slow_down');
});

test('approval needs a session, and a code cannot be approved by another account', async () => {
  const alice = await signupAndAccept(app, uniqNs());
  const bob = await signupAndAccept(app, uniqNs());
  const code = (await requestCode().expect(200)).body;

  await request(app)
    .post(apiPath('/auth/device/approve'))
    .send({ userCode: code.userCode })
    .expect(401);

  // The page shows what is asking before the button is pressed.
  const lookedUp = await request(app)
    .post(apiPath('/auth/device/lookup'))
    .set(bearer(bob.token))
    .send({ userCode: code.userCode })
    .expect(200);
  assert.equal(lookedUp.body.clientName, 'Twext CLI');
  assert.equal(lookedUp.body.approved, false);

  await approve(alice.token, code.userCode).expect(200);
  // Approving again from the same account is a reload, not a second sign-in.
  await approve(alice.token, code.userCode).expect(200);

  const taken = await approve(bob.token, code.userCode).expect(409);
  assert.match(taken.body.detail, /another account/);
  // Once it belongs to somebody else it is not even shown to this account.
  await request(app)
    .post(apiPath('/auth/device/lookup'))
    .set(bearer(bob.token))
    .send({ userCode: code.userCode })
    .expect(404);
});

test('a declined code ends the sign-in, even after it was approved', async () => {
  const account = await signupAndAccept(app, uniqNs());
  const code = (await requestCode().expect(200)).body;

  await approve(account.token, code.userCode).expect(200);
  await request(app)
    .post(apiPath('/auth/device/deny'))
    .set(bearer(account.token))
    .send({ userCode: code.userCode })
    .expect(200);

  const denied = await poll(code.deviceCode).expect(400);
  assert.equal(denied.body.error, 'access_denied');

  await request(app)
    .post(apiPath('/auth/device/approve'))
    .set(bearer(account.token))
    .send({ userCode: code.userCode })
    .expect(409);
});

test('a passkey account approves only after its second factor has been answered', async () => {
  const account = await signupAndAccept(app, uniqNs());
  const { authenticator } = await registerPasskey(app, account.token);
  const code = (await requestCode().expect(200)).body;

  const paused = await signin(account.user.namespace).expect(202);
  assert.equal(paused.body.mfaRequired, true);

  // The pending second factor is not a session, so it cannot approve anything.
  await approve(paused.body.mfaToken, code.userCode).expect(401);

  const options = await request(app)
    .post(apiPath('/auth/mfa/options'))
    .send({ mfaToken: paused.body.mfaToken })
    .expect(200);
  const site = new URL(TEST_PUBLIC_BASE_URL);
  const finished = await request(app)
    .post(apiPath('/auth/mfa/verify'))
    .send({
      mfaToken: paused.body.mfaToken,
      response: authenticator.authenticationResponse({
        challenge: options.body.options.challenge,
        origin: site.origin,
        rpId: site.hostname,
      }),
    })
    .expect(201);

  await approve(finished.body.token, code.userCode).expect(200);
  const issued = await poll(code.deviceCode).expect(200);
  assert.equal(issued.body.user.namespace, account.user.namespace);
});

test('a malformed code, user code, or client name is refused', async () => {
  const account = await signupAndAccept(app, uniqNs());

  const longName = await requestCode('x'.repeat(81)).expect(422);
  assert.equal(longName.body.errors[0].field, 'clientName');

  // The alphabet excludes 0/O and 1/I/L, so a code carrying one is not a code.
  await request(app)
    .post(apiPath('/auth/device/lookup'))
    .set(bearer(account.token))
    .send({ userCode: 'OOOO-OOOO' })
    .expect(422);

  await request(app)
    .post(apiPath('/auth/device/lookup'))
    .set(bearer(account.token))
    .send({ userCode: 'ABCD-EFGH' })
    .expect(404);

  await request(app).post(apiPath('/auth/device/token')).send({}).expect(422);
});
