import { Router } from 'express';
import { requireSession } from '../auth.js';
import {
  DEVICE_CODE_TTL_MS,
  MAX_CLIENT_NAME_LENGTH,
  POLL_INTERVAL_SECONDS,
  deviceEnabled,
  hashDeviceCode,
  hashUserCode,
  newDeviceCode,
  parseClientName,
  parseUserCode,
  verificationUri,
} from '../device.js';
import { conflict, fieldErrors, HttpError, notFound } from '../errors.js';
import { sessionToObject, userToObject } from '../serialize.js';
import { normalizeApiRoot } from '../util.js';
import { createSession, requireObjectBody } from './shared.js';

// A client with no browser cannot run a WebAuthn ceremony or read the provider
// page, so it does neither: it asks for a code, shows the person where to
// approve it, and polls. The browser half is the existing sign-in -- password,
// provider, passkey, backup code -- and approval only accepts a session, which
// is what makes the second factor part of the handoff without this router
// knowing anything about it.
export function makeDeviceRouter({ db, config }) {
  const router = Router();
  const enabled = deviceEnabled(config);
  const sessionTtlMs = config.auth.sessionTtlDays * 86_400_000;
  const root = normalizeApiRoot(config.apiRoot);

  router.post('/code', async (req, res) => {
    if (!enabled) throw notFound();
    requireObjectBody(req);
    const clientName = parseClientName(req.body.clientName);
    if (clientName === null) {
      throw fieldErrors([
        {
          field: 'clientName',
          message: `clientName must be a string of at most ${MAX_CLIENT_NAME_LENGTH} characters.`,
        },
      ]);
    }

    // Codes are swept as the next one is handed out, the same lazy way the OIDC
    // flow collects its expired rows.
    await db.DeviceCodes.deleteMany({ where: { ExpiresAt: { lt: new Date() } } });
    const pending = await createPending(clientName);
    const { verificationUri: uri, verificationUriComplete } = verificationUri(
      config,
      pending.userCode,
    );

    res.json({
      // Shown once, to the client that asked. The approval page never sees it,
      // so approving a code never puts the credential in front of the person.
      deviceCode: pending.deviceCode,
      userCode: pending.userCode,
      verificationUri: uri,
      verificationUriComplete,
      expiresIn: Math.round(DEVICE_CODE_TTL_MS / 1000),
      interval: POLL_INTERVAL_SECONDS,
    });
  });

  // What the approval page shows before the person commits: which client is
  // asking, and whether this code is still open. Session-only, like approve.
  router.post('/lookup', requireSession, async (req, res) => {
    if (!enabled) throw notFound();
    requireObjectBody(req);
    const row = await db.DeviceCodes.findUnique({
      where: { UserCodeHash: hashUserCode(requireUserCode(req.body)) },
    });
    const visible =
      row &&
      row.ExpiresAt > new Date() &&
      (row.UserId === null || Number(row.UserId) === Number(req.auth.user.Id));
    if (!visible) throw notFound('That code is not valid or has expired.');
    res.json({
      clientName: row.ClientName,
      expiresAt: row.ExpiresAt.toISOString(),
      approved: row.UserId !== null && row.DeniedAt === null,
      denied: row.DeniedAt !== null,
    });
  });

  router.post('/approve', requireSession, async (req, res) => {
    if (!enabled) throw notFound();
    requireObjectBody(req);
    const user = req.auth.user;
    const outcome = await db.$transaction(async (tx) => {
      const row = await lockByUserCode(tx, hashUserCode(requireUserCode(req.body)));
      if (!row) return { reason: 'unknown' };
      if (row.DeniedAt !== null) return { reason: 'denied' };
      if (row.UserId !== null) {
        if (Number(row.UserId) !== Number(user.Id)) return { reason: 'taken' };
        return { clientName: row.ClientName };
      }
      await tx.DeviceCodes.update({
        where: { Id: row.Id },
        data: { UserId: user.Id, ApprovedAt: new Date() },
      });
      return { clientName: row.ClientName };
    });
    if (outcome.reason === 'unknown') throw notFound('That code is not valid or has expired.');
    if (outcome.reason === 'denied') throw conflict('That code was declined.');
    if (outcome.reason === 'taken') {
      throw conflict('That code has already been approved by another account.');
    }
    res.json({ approved: true, clientName: outcome.clientName });
  });

  // A code that was approved but not yet collected can still be declined: the
  // CLI has not received its session until it polls, so the person who approved
  // it by mistake has a window to take it back.
  router.post('/deny', requireSession, async (req, res) => {
    if (!enabled) throw notFound();
    requireObjectBody(req);
    const user = req.auth.user;
    const outcome = await db.$transaction(async (tx) => {
      const row = await lockByUserCode(tx, hashUserCode(requireUserCode(req.body)));
      if (!row) return { reason: 'unknown' };
      if (row.UserId !== null && Number(row.UserId) !== Number(user.Id)) {
        return { reason: 'taken' };
      }
      if (row.DeniedAt === null) {
        await tx.DeviceCodes.update({
          where: { Id: row.Id },
          data: { DeniedAt: new Date() },
        });
      }
      return { denied: true };
    });
    if (outcome.reason === 'unknown') throw notFound('That code is not valid or has expired.');
    if (outcome.reason === 'taken') {
      throw conflict('That code belongs to another account.');
    }
    res.json({ denied: true });
  });

  // Polling is the client's only read: the answer is either "not yet", "slow
  // down", a refusal, or the session. Claiming the row and minting the session
  // are one transaction, so a captured device code cannot redeem twice and two
  // concurrent polls cannot both succeed.
  router.post('/token', async (req, res) => {
    if (!enabled) throw notFound();
    requireObjectBody(req);
    const { deviceCode } = req.body;
    if (typeof deviceCode !== 'string' || deviceCode === '') {
      throw fieldErrors([{ field: 'deviceCode', message: 'A device code is required.' }]);
    }

    const outcome = await db.$transaction(async (tx) => {
      const row = await lockByDeviceCode(tx, hashDeviceCode(deviceCode));
      if (!row) return { error: 'expired_token' };
      if (row.DeniedAt !== null) return { error: 'access_denied' };

      const now = Date.now();
      const lastPolledAt = row.LastPolledAt === null ? 0 : new Date(row.LastPolledAt).getTime();
      if (lastPolledAt && now - lastPolledAt < POLL_INTERVAL_SECONDS * 1000) {
        return { error: 'slow_down' };
      }
      // The poll that gets an answer is also the poll that sets the clock the
      // next one is measured against, including the one that says "not yet".
      await tx.DeviceCodes.update({
        where: { Id: row.Id },
        data: { LastPolledAt: new Date(now) },
      });

      if (row.UserId === null) return { error: 'authorization_pending' };
      const user = await tx.Users.findUnique({ where: { Id: row.UserId } });
      if (!user) return { error: 'access_denied' };
      const created = await createSession(tx, row.UserId, sessionTtlMs);
      await tx.DeviceCodes.delete({ where: { Id: row.Id } });
      return { created, user };
    });

    if (outcome.error) throw deviceError(outcome.error);
    res.location(`${root ? `/${root}` : ''}/sessions/${outcome.created.session.Id}`).json({
      session: sessionToObject(outcome.created.session),
      user: userToObject(outcome.user, config),
      token: outcome.created.token,
    });
  });

  return router;

  async function createPending(clientName) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const pending = newDeviceCode();
      try {
        await db.DeviceCodes.create({
          data: {
            DeviceCodeHash: hashDeviceCode(pending.deviceCode),
            UserCodeHash: hashUserCode(pending.userCode),
            ClientName: clientName,
            ExpiresAt: new Date(Date.now() + DEVICE_CODE_TTL_MS),
          },
        });
        return pending;
      } catch (error) {
        // A user code carries forty bits, so a collision is unlikely but not
        // impossible; the device code is long enough that it never is. Either
        // constraint failing just retries with a fresh pair.
        if (error?.code !== 'P2002') throw error;
      }
    }
    throw new Error('could not allocate a device code');
  }
}

function requireUserCode(body) {
  const code = parseUserCode(body.userCode);
  if (!code) {
    throw fieldErrors([{ field: 'userCode', message: 'Enter the code the client is showing.' }]);
  }
  return code;
}

// `FOR UPDATE` on the pending row serializes the browser's approve/deny with
// the client's poll, so a decision and a redemption cannot both pass a check
// that only one of them should. Two helpers rather than one with the column as
// a parameter: the SQL is fixed either way, and a dynamic column name would be
// a name spliced into a statement.
async function lockByUserCode(tx, codeHash) {
  const [row] = await tx.$queryRaw`
    SELECT * FROM "DeviceCodes"
    WHERE "UserCodeHash" = ${codeHash} AND "ExpiresAt" > now()
    FOR UPDATE
  `;
  return row ?? null;
}

async function lockByDeviceCode(tx, codeHash) {
  const [row] = await tx.$queryRaw`
    SELECT * FROM "DeviceCodes"
    WHERE "DeviceCodeHash" = ${codeHash} AND "ExpiresAt" > now()
    FOR UPDATE
  `;
  return row ?? null;
}

function deviceError(code) {
  const detail = {
    authorization_pending: 'The sign-in has not been approved yet.',
    slow_down: `Poll no faster than once every ${POLL_INTERVAL_SECONDS} seconds.`,
    access_denied: 'The sign-in was declined.',
    expired_token: 'That device code is unknown or has expired.',
  }[code];
  return new HttpError(400, { detail, extra: { error: code } });
}
