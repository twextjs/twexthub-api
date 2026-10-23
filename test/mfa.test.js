import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createAuthenticator } from './fake-authenticator.mjs';
import { hashToken, newToken } from '../src/auth.js';
import { CEREMONY_TTL_MS, CHALLENGE_KINDS, generateBackupCodes } from '../src/mfa.js';
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

let app;
let db;

before(async () => {
  ({ app, db } = await boot());
});
beforeEach(resetDb);
after(async () => {
  await (await boot()).db.$disconnect();
});

// The origin and RP ID the test app expects, which is what the software
// authenticator has to be answered with.
const site = new URL(TEST_PUBLIC_BASE_URL);
const ceremony = { origin: site.origin, rpId: site.hostname };

function assertion(authenticator, challenge) {
  return authenticator.authenticationResponse({ challenge, ...ceremony });
}

function signin(namespace) {
  return request(app).post(apiPath('/sessions')).send({ namespace, password: FIXTURE_PASSWORD });
}

// A sign-in that stopped at the second factor, as the client sees it.
async function pausedSignin(namespace) {
  const r = await signin(namespace).expect(202);
  assert.equal(r.body.mfaRequired, true, JSON.stringify(r.body));
  assert.equal(typeof r.body.mfaToken, 'string');
  assert.equal(r.body.token, undefined);
  return r.body;
}

async function finishWithPasskey(mfaToken, authenticator) {
  const options = await request(app)
    .post(apiPath('/auth/mfa/options'))
    .send({ mfaToken })
    .expect(200);
  return request(app)
    .post(apiPath('/auth/mfa/verify'))
    .send({ mfaToken, response: assertion(authenticator, options.body.options.challenge) })
    .expect(201);
}

// Let both requests read their pending sign-in before either can claim it.
// The real transaction then has to resolve the competing redemptions.
function synchronizePendingClaims(t) {
  const findUnique = db.MfaChallenges.findUnique;
  const ready = Promise.withResolvers();
  let reads = 0;
  // Prisma delegates are proxies without method descriptors for t.mock.method.
  t.after(() => {
    db.MfaChallenges.findUnique = findUnique;
  });
  db.MfaChallenges.findUnique = async (...args) => {
    const pending = await findUnique(...args);
    if (++reads === 2) ready.resolve();
    await ready.promise;
    return pending;
  };
}

test('the first passkey turns MFA on and shows a set of backup codes once', async () => {
  const { token } = await signupAndAccept(app, uniqNs());

  const before = await request(app).get(apiPath('/auth/mfa')).set(bearer(token)).expect(200);
  assert.equal(before.body.enabled, false);
  assert.deepEqual(before.body.passkeys, []);
  assert.equal(before.body.backupCodesRemaining, 0);

  const first = await registerPasskey(app, token, 'Laptop');
  assert.equal(first.body.passkey.label, 'Laptop');
  assert.equal(first.body.passkey.lastUsedAt, null);
  assert.deepEqual(Object.keys(first.body.passkey).sort(), [
    'createdAt',
    'id',
    'label',
    'lastUsedAt',
  ]);
  assert.equal(first.body.backupCodes.length, 10);
  assert.equal(new Set(first.body.backupCodes).size, 10);

  const after = await request(app).get(apiPath('/auth/mfa')).set(bearer(token)).expect(200);
  assert.equal(after.body.enabled, true);
  assert.equal(after.body.passkeys.length, 1);
  assert.equal(after.body.backupCodesRemaining, 10);

  // The codes belong to the moment MFA came on, so a second passkey does not
  // mint another set.
  const second = await registerPasskey(app, token, 'Phone');
  assert.equal(second.body.backupCodes, null);
  const list = await request(app).get(apiPath('/auth/mfa')).set(bearer(token)).expect(200);
  assert.equal(list.body.passkeys.length, 2);
  assert.equal(list.body.backupCodesRemaining, 10);
});

test('every backup code is twelve characters from the unambiguous alphabet', () => {
  // A code read off paper is only as good as its length. The alphabet has
  // thirty characters, so taking an index from five bits of a byte can run
  // past the end and drop a character when the group is joined.
  const codes = generateBackupCodes(200);
  for (const code of codes) {
    assert.match(
      code,
      /^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{4}(-[ABCDEFGHJKMNPQRSTVWXYZ23456789]{4}){2}$/,
    );
  }
});

test('a password sign-in stops at the second factor and a passkey finishes it', async () => {
  const { user, token } = await signupAndAccept(app, uniqNs());

  // Opt-in: the same sign-in is a plain one until a passkey exists.
  await signin(user.namespace).expect(201);

  const { authenticator } = await registerPasskey(app, token);
  const paused = await pausedSignin(user.namespace);
  assert.deepEqual(paused.methods, ['passkey', 'backup_code']);

  const verified = await finishWithPasskey(paused.mfaToken, authenticator);
  assert.equal(typeof verified.body.token, 'string');
  assert.equal(verified.body.user.namespace, user.namespace);
  const me = await request(app).get(apiPath('/me')).set(bearer(verified.body.token)).expect(200);
  assert.equal(me.body.namespace, user.namespace);

  // The claim was spent together with the challenge it answered, so a
  // completed sign-in cannot be run a second time on the same token.
  await request(app)
    .post(apiPath('/auth/mfa/verify'))
    .send({ mfaToken: paused.mfaToken, backupCode: 'ABCDEFGH-JKMN' })
    .expect(401);
});

test('a second sign-in replaces the pending one rather than adding a claim', async () => {
  const { user, token } = await signupAndAccept(app, uniqNs());
  const { authenticator } = await registerPasskey(app, token);

  const first = await pausedSignin(user.namespace);
  const second = await pausedSignin(user.namespace);

  await request(app)
    .post(apiPath('/auth/mfa/options'))
    .send({ mfaToken: first.mfaToken })
    .expect(401);
  const verified = await finishWithPasskey(second.mfaToken, authenticator);
  assert.equal(typeof verified.body.token, 'string');
});

test('a backup code finishes one sign-in and is then spent', async () => {
  const { user, token } = await signupAndAccept(app, uniqNs());
  const { body: registration } = await registerPasskey(app, token);
  const code = registration.backupCodes[0];

  const first = await pausedSignin(user.namespace);
  // Presented the way it is read back off paper: lower case, with the spaces
  // around it that pasting tends to bring along.
  const used = await request(app)
    .post(apiPath('/auth/mfa/verify'))
    .send({ mfaToken: first.mfaToken, backupCode: ` ${code.toLowerCase()} ` })
    .expect(201);
  assert.equal(typeof used.body.token, 'string');
  assert.equal(used.body.mfaToken, undefined);

  const state = await request(app).get(apiPath('/auth/mfa')).set(bearer(token)).expect(200);
  assert.equal(state.body.backupCodesRemaining, 9);
  const rows = await db.MfaBackupCodes.findMany();
  assert.equal(rows.length, 10);
  assert.equal(rows.filter((row) => row.UsedAt !== null).length, 1);

  const second = await pausedSignin(user.namespace);
  const refused = await request(app)
    .post(apiPath('/auth/mfa/verify'))
    .send({ mfaToken: second.mfaToken, backupCode: code })
    .expect(401);
  assert.match(refused.body.detail, /backup code/);
  // A bad code rolls back the claim, and its failure is recorded after that
  // rollback. The same pending sign-in can still be completed with a fresh code.
  assert.equal(await db.RateLimitEntries.count({ where: { Bucket: { startsWith: 'login:' } } }), 2);
  await request(app)
    .post(apiPath('/auth/mfa/verify'))
    .send({ mfaToken: second.mfaToken, backupCode: registration.backupCodes[1] })
    .expect(201);
});

test(
  'concurrent backup codes can finish a pending sign-in only once',
  { timeout: 10_000 },
  async (t) => {
    const { user, token } = await signupAndAccept(app, uniqNs());
    const { body: registration } = await registerPasskey(app, token);
    const pending = await pausedSignin(user.namespace);
    const sessionsBefore = await db.Sessions.count();
    synchronizePendingClaims(t);

    const results = await Promise.all(
      registration.backupCodes
        .slice(0, 2)
        .map((backupCode) =>
          request(app)
            .post(apiPath('/auth/mfa/verify'))
            .send({ mfaToken: pending.mfaToken, backupCode }),
        ),
    );
    assert.deepEqual(results.map((result) => result.status).sort(), [201, 400]);
    assert.match(results.find((result) => result.status === 400).body.detail, /already completed/);
    assert.equal(await db.Sessions.count(), sessionsBefore + 1);
    assert.equal(await db.MfaChallenges.count({ where: { Kind: CHALLENGE_KINDS.signin } }), 0);
    assert.equal(await db.MfaBackupCodes.count({ where: { UsedAt: null } }), 9);
    assert.equal(
      await db.RateLimitEntries.count({ where: { Bucket: { startsWith: 'login:' } } }),
      0,
    );
  },
);

test(
  'concurrent pending sign-ins can spend a backup code only once',
  { timeout: 10_000 },
  async (t) => {
    const { user, token } = await signupAndAccept(app, uniqNs());
    const { body: registration } = await registerPasskey(app, token);
    const first = await pausedSignin(user.namespace);
    const account = await db.Users.findUnique({ where: { Namespace: user.namespace } });
    // Normal sign-in replaces an older pending claim. Seed a second live claim
    // to exercise code consumption independently of the pending-claim check.
    const secondToken = newToken();
    await db.MfaChallenges.create({
      data: {
        UserId: account.Id,
        Kind: CHALLENGE_KINDS.signin,
        SecretHash: hashToken(secondToken),
        ExpiresAt: new Date(Date.now() + CEREMONY_TTL_MS),
      },
    });
    const sessionsBefore = await db.Sessions.count();
    synchronizePendingClaims(t);

    const results = await Promise.all(
      [first.mfaToken, secondToken].map((mfaToken) =>
        request(app)
          .post(apiPath('/auth/mfa/verify'))
          .send({ mfaToken, backupCode: registration.backupCodes[0] }),
      ),
    );
    assert.deepEqual(results.map((result) => result.status).sort(), [201, 401]);
    assert.match(results.find((result) => result.status === 401).body.detail, /backup code/);
    assert.equal(await db.Sessions.count(), sessionsBefore + 1);
    assert.equal(await db.MfaChallenges.count({ where: { Kind: CHALLENGE_KINDS.signin } }), 1);
    assert.equal(await db.MfaBackupCodes.count({ where: { UsedAt: null } }), 9);
    assert.equal(
      await db.RateLimitEntries.count({ where: { Bucket: { startsWith: 'login:' } } }),
      2,
    );
  },
);

test('backup codes stop being offered once the set is used up', async () => {
  const { user, token } = await signupAndAccept(app, uniqNs());
  const { authenticator } = await registerPasskey(app, token);
  // The rows are this account's own in a freshly reset database.
  await db.MfaBackupCodes.updateMany({ data: { UsedAt: new Date() } });

  const paused = await pausedSignin(user.namespace);
  assert.deepEqual(paused.methods, ['passkey']);
  await finishWithPasskey(paused.mfaToken, authenticator);
});

test('removing the last passkey turns MFA off and abandons a waiting sign-in', async () => {
  const { user, token } = await signupAndAccept(app, uniqNs());
  const { body: registration } = await registerPasskey(app, token);
  const paused = await pausedSignin(user.namespace);

  await request(app)
    .delete(apiPath(`/auth/mfa/passkeys/${registration.passkey.id}`))
    .set(bearer(token))
    .expect(204);

  const state = await request(app).get(apiPath('/auth/mfa')).set(bearer(token)).expect(200);
  assert.equal(state.body.enabled, false);
  assert.equal(state.body.backupCodesRemaining, 0);

  // With no factor left there is nothing to offer the sign-in that is waiting.
  await request(app)
    .post(apiPath('/auth/mfa/options'))
    .send({ mfaToken: paused.mfaToken })
    .expect(401);
  await signin(user.namespace).expect(201);
});

test('adding or removing a passkey and replacing the codes need a recent sign-in', async () => {
  const { token, session } = await signupAndAccept(app, uniqNs());
  const { authenticator, body: registration } = await registerPasskey(app, token);
  const registrationOptions = await request(app)
    .post(apiPath('/auth/mfa/passkeys/options'))
    .set(bearer(token))
    .expect(200);
  const response = createAuthenticator().registrationResponse({
    challenge: registrationOptions.body.options.challenge,
    ...ceremony,
  });

  // Still valid, but an hour past the window the reauth check reads.
  await db.Sessions.update({
    where: { Id: BigInt(session.id) },
    data: { CreatedAt: new Date(Date.now() - 3600_000) },
  });

  const refused = await request(app)
    .delete(apiPath(`/auth/mfa/passkeys/${registration.passkey.id}`))
    .set(bearer(token))
    .expect(403);
  assert.match(refused.body.detail, /recent/i);
  await request(app).post(apiPath('/auth/mfa/passkeys/options')).set(bearer(token)).expect(403);
  await request(app)
    .post(apiPath('/auth/mfa/passkeys'))
    .set(bearer(token))
    .send({ response })
    .expect(403);
  await request(app).post(apiPath('/auth/mfa/backup-codes')).set(bearer(token)).expect(403);

  // The passkey pair refreshes the session's own authentication instead of
  // making the account sign in again.
  const options = await request(app)
    .post(apiPath('/auth/mfa/reauth/options'))
    .set(bearer(token))
    .expect(200);
  const reauth = await request(app)
    .post(apiPath('/auth/mfa/reauth'))
    .set(bearer(token))
    .send({ response: assertion(authenticator, options.body.options.challenge) })
    .expect(200);
  assert.equal(typeof reauth.body.reauthenticatedAt, 'string');
  await request(app)
    .post(apiPath('/auth/mfa/passkeys'))
    .set(bearer(token))
    .send({ response })
    .expect(201);
  await registerPasskey(app, token, 'After reauthentication');

  const codes = await request(app)
    .post(apiPath('/auth/mfa/backup-codes'))
    .set(bearer(token))
    .expect(201);
  assert.equal(codes.body.backupCodes.length, 10);
  await request(app)
    .delete(apiPath(`/auth/mfa/passkeys/${registration.passkey.id}`))
    .set(bearer(token))
    .expect(204);
});

test('an automation token cannot manage passkeys', async () => {
  const { token } = await signupAndAccept(app, uniqNs());
  const created = await request(app)
    .post(apiPath('/tokens'))
    .set(bearer(token))
    .send({ name: 'ci', scopes: ['manage:account'] })
    .expect(201);
  const automation = created.body.token;

  await request(app).get(apiPath('/auth/mfa')).set(bearer(automation)).expect(403);
  await request(app)
    .post(apiPath('/auth/mfa/passkeys/options'))
    .set(bearer(automation))
    .expect(403);
  await request(app).post(apiPath('/auth/mfa/backup-codes')).set(bearer(automation)).expect(403);
});

test('a passkey can be renamed', async () => {
  const { token } = await signupAndAccept(app, uniqNs());
  const { body: registration } = await registerPasskey(app, token);
  const id = registration.passkey.id;

  const renamed = await request(app)
    .patch(apiPath(`/auth/mfa/passkeys/${id}`))
    .set(bearer(token))
    .send({ label: '  Work laptop  ' })
    .expect(200);
  assert.equal(renamed.body.label, 'Work laptop');

  await request(app)
    .patch(apiPath(`/auth/mfa/passkeys/${id}`))
    .set(bearer(token))
    .send({ label: '' })
    .expect(422);
  await request(app)
    .patch(apiPath('/auth/mfa/passkeys/999999'))
    .set(bearer(token))
    .send({ label: 'Nowhere' })
    .expect(404);
});

test('a registration ceremony has to be started before it can be answered', async () => {
  const { token } = await signupAndAccept(app, uniqNs());
  const authenticator = createAuthenticator();
  const response = authenticator.registrationResponse({
    challenge: 'unstarted-challenge',
    ...ceremony,
  });

  await request(app)
    .post(apiPath('/auth/mfa/passkeys'))
    .set(bearer(token))
    .send({ response })
    .expect(400);

  const state = await request(app).get(apiPath('/auth/mfa')).set(bearer(token)).expect(200);
  assert.equal(state.body.enabled, false);
});

test('an assertion the stored passkey cannot have made is refused', async () => {
  const { user, token } = await signupAndAccept(app, uniqNs());
  const { authenticator } = await registerPasskey(app, token);
  const paused = await pausedSignin(user.namespace);

  const options = await request(app)
    .post(apiPath('/auth/mfa/options'))
    .send({ mfaToken: paused.mfaToken })
    .expect(200);
  // A different key answering in the registered credential's name: the id
  // finds the stored passkey, the signature does not match it.
  const impostor = createAuthenticator().authenticationResponse({
    challenge: options.body.options.challenge,
    ...ceremony,
  });
  impostor.id = authenticator.credentialId;
  impostor.rawId = authenticator.credentialId;

  const refused = await request(app)
    .post(apiPath('/auth/mfa/verify'))
    .send({ mfaToken: paused.mfaToken, response: impostor })
    .expect(401);
  assert.match(refused.body.detail, /passkey/);

  // The real passkey still finishes the same sign-in: a failed attempt spends
  // nothing.
  await finishWithPasskey(paused.mfaToken, authenticator);
});

test('a pending sign-in expires', async () => {
  const { user, token } = await signupAndAccept(app, uniqNs());
  const { authenticator } = await registerPasskey(app, token);
  const paused = await pausedSignin(user.namespace);

  await db.MfaChallenges.updateMany({
    where: { Kind: 'signin' },
    data: { ExpiresAt: new Date(Date.now() - 1_000) },
  });

  await request(app)
    .post(apiPath('/auth/mfa/options'))
    .send({ mfaToken: paused.mfaToken })
    .expect(401);
  const fresh = await pausedSignin(user.namespace);
  await finishWithPasskey(fresh.mfaToken, authenticator);
});
