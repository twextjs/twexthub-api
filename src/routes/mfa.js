import { Router } from 'express';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { hashToken, makeRequireRecentAuth, requireSession } from '../auth.js';
import { audit } from '../audit.js';
import { fieldErrors, forbidden, HttpError, notFound, unauthorized } from '../errors.js';
import {
  CEREMONY_TTL_MS,
  CHALLENGE_KINDS,
  decodePublicKey,
  encodePublicKey,
  generateBackupCodes,
  hashBackupCode,
  unusedBackupCodeCount,
  webauthnSettings,
} from '../mfa.js';
import { passkeyToObject, sessionToObject, userToObject } from '../serialize.js';
import { createSession, requireObjectBody } from './shared.js';

const MAX_LABEL_LENGTH = 80;
const MAX_TRANSPORTS = 10;

// Multi-factor authentication is a second step for a sign-in that has already
// passed its first one, plus the account's own management of the factor. The
// pending sign-in is a challenge row: it carries the account, the secret the
// anonymous half uses to claim it, and -- once options have been handed out --
// the challenge an assertion has to answer.
export function makeMfaRouter({ db, config, rateLimiter }) {
  const router = Router();
  const requireRecentAuth = makeRequireRecentAuth(config);
  const sessionTtlMs = config.auth.sessionTtlDays * 86_400_000;
  const settings = webauthnSettings(config);

  // Registration adds to an account's security rather than risking a lockout,
  // so it needs a session but not a recent one. Removing the last passkey or
  // replacing the backup codes can strand the account, and does.
  const manage = [requireSession];
  const sensitive = [requireSession, requireRecentAuth];

  // ---- Managing the account's own passkeys -------------------------------

  router.get('/', manage, async (req, res) => {
    const [passkeys, unusedCodes] = await Promise.all([
      db.Passkeys.findMany({ where: { UserId: req.auth.user.Id }, orderBy: { Id: 'asc' } }),
      unusedBackupCodeCount(db, req.auth.user.Id),
    ]);
    res.json({
      enabled: passkeys.length > 0,
      passkeys: passkeys.map(passkeyToObject),
      backupCodesRemaining: unusedCodes,
    });
  });

  router.post('/passkeys/options', manage, async (req, res) => {
    const user = req.auth.user;
    const existing = await db.Passkeys.findMany({
      where: { UserId: user.Id },
      select: { CredentialId: true, Transports: true },
    });
    const options = await generateRegistrationOptions({
      rpID: settings.rpId,
      rpName: settings.rpName,
      userID: new TextEncoder().encode(String(user.Id)),
      userName: user.Namespace,
      userDisplayName: user.DisplayName,
      // A passkey already on the authenticator is skipped rather than silently
      // enrolled a second time.
      excludeCredentials: credentialDescriptors(existing),
      // A second factor is stronger when the authenticator also verifies the
      // person (a PIN or a biometric), not only that the key is present.
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    });
    await replaceChallenge(user.Id, CHALLENGE_KINDS.register, options.challenge);
    res.json({ options });
  });

  router.post('/passkeys', manage, async (req, res) => {
    requireObjectBody(req);
    const { response, label } = req.body;
    const user = req.auth.user;
    const challenge = await takeChallenge(user.Id, CHALLENGE_KINDS.register);
    if (!challenge) {
      throw new HttpError(400, { detail: 'That registration attempt is unknown or has expired.' });
    }
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: settings.origins,
        expectedRPID: settings.rpId,
        requireUserVerification: true,
      });
    } catch {
      throw new HttpError(400, { detail: 'The passkey could not be verified.' });
    }
    if (!verification.verified || !verification.registrationInfo) {
      throw new HttpError(400, { detail: 'The passkey could not be verified.' });
    }
    const { credential } = verification.registrationInfo;
    const name = parseLabel(label, { required: false });
    const transports = sanitizeTransports(response?.response?.transports);

    // The first passkey turns MFA on, and that is the moment to mint the backup
    // codes that recover the account when it is lost. Both are written in one
    // transaction so MFA never comes on without a way back in.
    const result = await db.$transaction(async (tx) => {
      const wasFirst = (await tx.Passkeys.count({ where: { UserId: user.Id } })) === 0;
      const created = await tx.Passkeys.create({
        data: {
          UserId: user.Id,
          CredentialId: credential.id,
          PublicKey: encodePublicKey(credential.publicKey),
          Counter: BigInt(credential.counter),
          Label: name,
          Transports: transports,
        },
      });
      if (!wasFirst) return { passkey: created, codes: null };
      const fresh = generateBackupCodes();
      await tx.MfaBackupCodes.createMany({
        data: fresh.map((code) => ({ UserId: user.Id, CodeHash: hashBackupCode(code) })),
      });
      return { passkey: created, codes: fresh };
    });
    await audit(
      db,
      user,
      'mfa.passkey.register',
      { namespace: user.Namespace },
      { label: name, first: result.codes !== null },
    );
    res.status(201).json({ passkey: passkeyToObject(result.passkey), backupCodes: result.codes });
  });

  router.patch('/passkeys/:id', manage, async (req, res) => {
    requireObjectBody(req);
    const id = parseId(req.params.id);
    const label = parseLabel(req.body.label, { required: true });
    const updated = await db.Passkeys.updateMany({
      where: { Id: id, UserId: req.auth.user.Id },
      data: { Label: label },
    });
    if (updated.count === 0) throw notFound('No such passkey.');
    const passkey = await db.Passkeys.findUnique({ where: { Id: id } });
    res.json(passkeyToObject(passkey));
  });

  router.delete('/passkeys/:id', sensitive, async (req, res) => {
    const id = parseId(req.params.id);
    const user = req.auth.user;
    await db.$transaction(async (tx) => {
      const deleted = await tx.Passkeys.deleteMany({ where: { Id: id, UserId: user.Id } });
      if (deleted.count === 0) throw notFound('No such passkey.');
      const remaining = await tx.Passkeys.count({ where: { UserId: user.Id } });
      // With the last passkey gone MFA is off, and the codes that stand in for
      // one have nothing left to stand in for. A sign-in already waiting on its
      // second factor is abandoned for the same reason: there is no factor to
      // offer it, so the client starts over and gets a plain session.
      if (remaining === 0) {
        await tx.MfaBackupCodes.deleteMany({ where: { UserId: user.Id } });
        await tx.MfaChallenges.deleteMany({ where: { UserId: user.Id } });
      }
    });
    await audit(db, user, 'mfa.passkey.remove', { namespace: user.Namespace }, { id: String(id) });
    res.status(204).end();
  });

  router.post('/backup-codes', sensitive, async (req, res) => {
    const user = req.auth.user;
    const codes = generateBackupCodes();
    // Replacing rather than adding: a regeneration is what an account does when
    // it believes the old sheet has been seen, so leaving those codes valid
    // would defeat the point of regenerating them.
    await db.$transaction([
      db.MfaBackupCodes.deleteMany({ where: { UserId: user.Id } }),
      db.MfaBackupCodes.createMany({
        data: codes.map((code) => ({ UserId: user.Id, CodeHash: hashBackupCode(code) })),
      }),
    ]);
    await audit(db, user, 'mfa.backup_codes.regenerate', { namespace: user.Namespace });
    res.status(201).json({ backupCodes: codes });
  });

  // ---- Finishing a sign-in that stopped at the second factor -------------

  router.post('/options', async (req, res) => {
    requireObjectBody(req);
    const pending = await claimPendingSignin(req);
    const passkeys = await db.Passkeys.findMany({
      where: { UserId: pending.UserId },
      select: { CredentialId: true, Transports: true },
    });
    const options = await generateAuthenticationOptions({
      rpID: settings.rpId,
      allowCredentials: credentialDescriptors(passkeys),
      userVerification: 'required',
    });
    await db.MfaChallenges.update({
      where: { Id: pending.Id },
      data: { Challenge: options.challenge, ExpiresAt: new Date(Date.now() + CEREMONY_TTL_MS) },
    });
    res.json({ options });
  });

  router.post('/verify', async (req, res) => {
    requireObjectBody(req);
    const pending = await claimPendingSignin(req);
    const { response, backupCode } = req.body;
    if (response !== undefined) {
      return res.status(201).json(await finishWithPasskey(req, pending, response));
    }
    if (typeof backupCode === 'string') {
      return res.status(201).json(await finishWithBackupCode(req, pending, backupCode));
    }
    throw fieldErrors([
      { field: 'response', message: 'Present a passkey assertion or a backup code.' },
    ]);
  });

  // ---- Refreshing a session's authentication ----------------------------

  router.post('/reauth/options', [requireSession], async (req, res) => {
    const passkeys = await db.Passkeys.findMany({
      where: { UserId: req.auth.user.Id },
      select: { CredentialId: true, Transports: true },
    });
    if (passkeys.length === 0) {
      throw forbidden('This account has no passkey to verify with. Sign in again instead.');
    }
    const options = await generateAuthenticationOptions({
      rpID: settings.rpId,
      allowCredentials: credentialDescriptors(passkeys),
      userVerification: 'required',
    });
    await replaceChallenge(req.auth.user.Id, CHALLENGE_KINDS.reauth, options.challenge);
    res.json({ options });
  });

  router.post('/reauth', [requireSession], async (req, res) => {
    requireObjectBody(req);
    const user = req.auth.user;
    const challenge = await takeChallenge(user.Id, CHALLENGE_KINDS.reauth);
    if (!challenge) {
      throw new HttpError(400, { detail: 'That verification attempt is unknown or has expired.' });
    }
    const passkey = await verifiedPasskey(req.body.response, challenge, user.Id);
    const now = new Date();
    await db.$transaction(async (tx) => {
      await tx.Sessions.updateMany({ where: { Id: req.auth.tokenId }, data: { ReauthAt: now } });
      await touchPasskey(tx, passkey);
    });
    res.json({ reauthenticatedAt: now.toISOString() });
  });

  return router;

  // The client holds a secret while a sign-in waits on its second factor. It is
  // looked up by its hash, like a session token, and the row is what names the
  // account: the requests that follow are anonymous, so they have nothing else.
  async function claimPendingSignin(req) {
    const { mfaToken } = req.body;
    if (typeof mfaToken !== 'string' || mfaToken === '') {
      throw unauthorized('Invalid or expired second-factor token.');
    }
    const pending = await db.MfaChallenges.findUnique({
      where: {
        SecretHash_Kind: { SecretHash: hashToken(mfaToken), Kind: CHALLENGE_KINDS.signin },
      },
    });
    if (!pending || pending.ExpiresAt <= new Date()) {
      throw unauthorized('Invalid or expired second-factor token.');
    }
    return pending;
  }

  async function finishWithPasskey(req, pending, response) {
    if (!pending.Challenge) {
      throw new HttpError(400, { detail: 'Request the passkey options first.' });
    }
    const user = await db.Users.findUnique({ where: { Id: pending.UserId } });
    if (!user) throw unauthorized('Invalid or expired second-factor token.');
    const recordFailures = await loginFailures(req, user.Namespace);

    let passkey;
    try {
      passkey = await verifiedPasskey(response, pending.Challenge, user.Id);
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) {
        await Promise.all(recordFailures.map((record) => record()));
      }
      throw error;
    }
    // The claim consumes the challenge the assertion answered, so a captured
    // assertion cannot be replayed and a second sign-in cannot ride the same
    // one. Naming the challenge in the filter means an assertion made for an
    // older ceremony never consumes a re-issued one.
    const created = await db.$transaction(async (tx) => {
      const claimed = await tx.MfaChallenges.deleteMany({
        where: { Id: pending.Id, Challenge: pending.Challenge },
      });
      if (claimed.count === 0) {
        throw new HttpError(400, { detail: 'That sign-in was already completed.' });
      }
      await touchPasskey(tx, passkey);
      return createSession(tx, user.Id, sessionTtlMs);
    });
    return sessionBody(created, user);
  }

  async function finishWithBackupCode(req, pending, code) {
    const user = await db.Users.findUnique({ where: { Id: pending.UserId } });
    if (!user) throw unauthorized('Invalid or expired second-factor token.');
    const recordFailures = await loginFailures(req, user.Namespace);

    // Consuming the code and checking it are one statement: a code that has been
    // spent cannot be spent again, even by a request racing this one. A blank
    // presentation hashes to something no row holds, so the count stays zero.
    const consumed = await db.MfaBackupCodes.updateMany({
      where: { UserId: user.Id, CodeHash: hashBackupCode(code), UsedAt: null },
      data: { UsedAt: new Date() },
    });
    if (consumed.count === 0) {
      await Promise.all(recordFailures.map((record) => record()));
      throw unauthorized('That backup code is not valid.');
    }

    const created = await db.$transaction(async (tx) => {
      await tx.MfaChallenges.deleteMany({ where: { Id: pending.Id } });
      return createSession(tx, user.Id, sessionTtlMs);
    });
    return sessionBody(created, user);
  }

  // A failed second-factor attempt counts against the same buckets a failed
  // password does, keyed the same way, so guessing a backup code is throttled
  // by exactly the limit that throttles guessing a password.
  function loginFailures(req, namespace) {
    return Promise.all([
      rateLimiter.loginCheck(`login:${namespace}|${req.ip}`),
      rateLimiter.loginCheck(`login:ip:${req.ip}`),
    ]);
  }

  function sessionBody(created, user) {
    return {
      session: sessionToObject(created.session),
      user: userToObject(user, config),
      token: created.token,
    };
  }

  // Resolves the assertion against the account's stored passkey. Every reason
  // it can fail -- an unknown credential, a bad signature, a stale sign counter
  // -- is the same 401 to the caller, which is what "this passkey did not prove
  // the account" means.
  async function verifiedPasskey(response, challenge, userId) {
    const credentialId = response?.id;
    if (typeof credentialId !== 'string' || credentialId === '') {
      throw unauthorized('That passkey is not valid.');
    }
    const passkey = await db.Passkeys.findUnique({ where: { CredentialId: credentialId } });
    if (!passkey || Number(passkey.UserId) !== Number(userId)) {
      throw unauthorized('That passkey is not valid.');
    }
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: settings.origins,
        expectedRPID: settings.rpId,
        credential: {
          id: passkey.CredentialId,
          publicKey: decodePublicKey(passkey.PublicKey),
          counter: Number(passkey.Counter),
        },
        requireUserVerification: true,
      });
    } catch {
      throw unauthorized('That passkey could not be verified.');
    }
    if (!verification.verified) throw unauthorized('That passkey could not be verified.');
    return { ...passkey, newCounter: verification.authenticationInfo.newCounter };
  }

  // The counter is the authenticator's own tally of assertions, so it moves
  // forward on every one; an assertion that does not move it forward is what a
  // cloned passkey looks like, and the library records that in newCounter too.
  async function touchPasskey(tx, passkey) {
    await tx.Passkeys.update({
      where: { Id: passkey.Id },
      data: {
        Counter: BigInt(passkey.newCounter ?? Number(passkey.Counter)),
        LastUsedAt: new Date(),
      },
    });
  }

  // One ceremony per account and kind: a fresh request replaces whatever the
  // last one left, so an abandoned challenge cannot be answered later.
  async function replaceChallenge(userId, kind, challenge) {
    await db.$transaction([
      db.MfaChallenges.deleteMany({ where: { UserId: userId, Kind: kind } }),
      db.MfaChallenges.create({
        data: {
          UserId: userId,
          Kind: kind,
          Challenge: challenge,
          ExpiresAt: new Date(Date.now() + CEREMONY_TTL_MS),
        },
      }),
    ]);
  }

  // A challenge is good for one answer: taking it consumes it, so the next
  // request has to ask for a new one rather than reuse the challenge a captured
  // assertion already answered. The delete is what takes it -- of two requests
  // racing the same ceremony, only one's delete matches a row.
  async function takeChallenge(userId, kind) {
    const row = await db.MfaChallenges.findFirst({
      where: { UserId: userId, Kind: kind, ExpiresAt: { gt: new Date() } },
    });
    if (!row) return null;
    const taken = await db.MfaChallenges.deleteMany({ where: { Id: row.Id } });
    return taken.count === 1 ? row.Challenge : null;
  }
}

function credentialDescriptors(passkeys) {
  return passkeys.map((passkey) => ({
    id: passkey.CredentialId,
    transports: passkey.Transports.length ? passkey.Transports : undefined,
  }));
}

function parseId(raw) {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw notFound('No such passkey.');
  return id;
}

function parseLabel(label, { required }) {
  if (label === undefined || label === null) {
    if (required) throw fieldErrors([{ field: 'label', message: 'A label is required.' }]);
    return 'Passkey';
  }
  if (typeof label !== 'string') {
    throw fieldErrors([{ field: 'label', message: 'A label must be a string.' }]);
  }
  const trimmed = label.trim();
  if (required && trimmed === '') {
    throw fieldErrors([{ field: 'label', message: 'A label is required.' }]);
  }
  if (trimmed.length > MAX_LABEL_LENGTH) {
    throw fieldErrors([
      { field: 'label', message: `A label may be at most ${MAX_LABEL_LENGTH} characters.` },
    ]);
  }
  return trimmed === '' ? 'Passkey' : trimmed;
}

function sanitizeTransports(transports) {
  if (!Array.isArray(transports)) return [];
  return transports
    .filter((value) => typeof value === 'string' && value.length <= 32)
    .slice(0, MAX_TRANSPORTS);
}
