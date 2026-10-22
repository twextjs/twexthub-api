import { rm } from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import { hashPassword, verifyPassword } from '../password.js';
import { isAdmin, requireScope } from '../auth.js';
import { uniqueViolation } from '../db.js';
import { withLocks } from '../locks.js';
import { removeBlobIfUnused } from '../blobs.js';
import { removeProfileImageBlob } from '../profile-images.js';
import { removeSourceIfUnused } from '../sources.js';
import { decodeCursor, keysetPage, parseDir, parseLimit } from '../pagination.js';
import { conflict, fieldErrors, forbidden, notFound } from '../errors.js';
import { profileFieldErrors, profilePatch } from '../profile.js';
import { isValidNamespace, normalizeApiRoot } from '../util.js';
import { sessionToObject, userToObject } from '../serialize.js';
import { notifyUser, roleChangedMessage, tokensRevokedMessage } from '../notify.js';
import { createSession, requireObjectBody } from './shared.js';
import { makeProfileImageRouter } from './profile-images.js';
import { makeWebhooks, WebhookInputError } from '../webhooks.js';
import { makeWebhookDeliveryRoutes } from './webhook-deliveries.js';
import { audit } from '../audit.js';

export function makeUsersRouter({ db, config, termsGate, rateLimiter, resolveTarget }) {
  const root = normalizeApiRoot(config.apiRoot);
  // normalizeApiRoot strips the surrounding slashes, so the prefix is rebuilt
  // here: every path handed back to a client needs exactly one leading slash.
  const mount = (path) => `${root ? `/${root}` : ''}${path}`;
  const router = Router();

  // An account's own settings are a grantable capability, so a token can hold
  // them; the route still checks that the caller is that account or an admin.
  const manageAccount = requireScope('manage:account');
  const scrypt = config.auth.scrypt;
  const sessionTtlMs = config.auth.sessionTtlDays * 86_400_000;

  // Creating the account is the same act as signing in, so a new user arrives
  // with a session already: the response is the user, the session that was
  // opened for it, and the token to use for both.
  router.post('/', async (req, res) => {
    // IdP-only mode: accounts are created by signing in at the provider, so a
    // direct password registration is refused.
    if (config.auth.oidc.required) {
      throw forbidden(
        'Registration is turned off. Sign in with the identity provider to get an account.',
      );
    }
    requireObjectBody(req);
    const { namespace, password, displayName } = req.body;

    const errors = [];
    if (typeof namespace !== 'string' || !isValidNamespace(namespace)) {
      errors.push({
        field: 'namespace',
        message: 'Must be lowercase letters, digits and hyphens; no leading/trailing hyphen.',
      });
    }
    if (typeof password !== 'string') {
      errors.push({ field: 'password', message: 'Password is required.' });
    } else if (password.length < 8) {
      errors.push({ field: 'password', message: 'Password must be at least 8 characters.' });
    }
    if (displayName !== undefined && typeof displayName !== 'string') {
      errors.push({ field: 'displayName', message: 'Must be a string.' });
    } else if (displayName !== undefined && displayName.length > 80) {
      errors.push({
        field: 'displayName',
        message: 'Display name must be at most 80 characters.',
      });
    }
    if (errors.length > 0) throw fieldErrors(errors);

    const effectiveDisplayName =
      typeof displayName === 'string' && displayName.length > 0 ? displayName : namespace;

    await rateLimiter.signupCheck(`signup:${req.ip}`);
    const passwordHash = await hashPassword(password, scrypt);

    let user;
    let created;
    try {
      // The bootstrap lock makes "is this the first account, and therefore an
      // admin" a decision only one signup at a time can make.
      await withLocks(db, ['signup-bootstrap'], async (tx) => {
        const count = await tx.Users.count();
        const role = count === 0 ? 'admin' : 'normal';
        user = await tx.Users.create({
          data: {
            Namespace: namespace,
            DisplayName: effectiveDisplayName,
            PasswordHash: passwordHash,
            Role: role,
          },
        });
        created = await createSession(tx, user.Id, sessionTtlMs);
      });
    } catch (error) {
      if (uniqueViolation(error)) throw conflict('That namespace is already taken.');
      throw error;
    }

    res
      .location(mount(`/users/${user.Namespace}`))
      .status(201)
      .json({
        user: userToObject(user, config),
        session: sessionToObject(created.session),
        token: created.token,
      });
  });

  function serializePublicUser(row, req) {
    const isOwner = req.auth?.user.Namespace === row.Namespace;
    // Whether to show another account's role and terms state, not whether the
    // caller may act on it, so this is the role alone and not `isAdmin`.
    const seesFullProfile = req.auth?.user.Role === 'admin';
    if ((isOwner || seesFullProfile) && row.Kind !== 'organization') {
      return userToObject(row, config);
    }
    // An organization has no role and accepts no terms; whoever runs it is named
    // on its owner list.
    const { role: _role, termsAcceptedVersion: _terms, ...rest } = userToObject(row, config);
    return rest;
  }

  router.get('/', async (req, res) => {
    const limit = parseLimit(config, req.query.limit);
    const cursor = decodeCursor(req.query.cursor, { i: 'int' });
    const back = parseDir(req.query.dir);

    const rows = await db.Users.findMany({
      where: cursor ? (back ? { Id: { gt: cursor.i } } : { Id: { lt: cursor.i } }) : {},
      orderBy: { Id: back ? 'asc' : 'desc' },
      take: limit + 1,
    });

    res.json(
      keysetPage(req, rows, {
        limit,
        back,
        cursor,
        serialize: (user) => serializePublicUser(user, req),
        keyOf: (user) => ({ i: Number(user.Id) }),
      }),
    );
  });

  router.get('/:namespace', async (req, res) => {
    if (!isValidNamespace(req.params.namespace)) throw notFound();
    const user = await db.Users.findUnique({ where: { Namespace: req.params.namespace } });
    if (!user) throw notFound();
    res.json(serializePublicUser(user, req));
  });

  // Avatars and banners are the same three-state problem for an account and for
  // an organization, so both mount this; only who may write and what the row
  // serializes into differ.
  router.use(
    makeProfileImageRouter({
      db,
      config,
      load: (namespace) => loadUserOr404(db, namespace),
      mayWrite: (row, req) => req.auth.user.Id === row.Id,
      serialize: (row) => userToObject(row, config),
    }),
  );

  // A pure password change stays reachable when the terms have moved on, so an
  // account can still be secured. The old check read "any profile field is
  // present" and so was always false next to a password, which meant a password
  // field alone waved the whole request through: attaching one smuggled a
  // profile or role edit past the gate too. Only the fields that are themselves
  // gated or ungated alike are exempt: a password change has to work before the
  // terms are accepted (it is the way out of a locked account), and so does the
  // acceptance itself.
  function skipTermsForAcceptance(req, res, next) {
    const {
      password,
      currentPassword: _currentPassword,
      termsAcceptedVersion,
      ...rest
    } = req.body ?? {};
    const onlyUngated =
      (password !== undefined || termsAcceptedVersion !== undefined) &&
      Object.values(rest).every((value) => value === undefined);
    return onlyUngated ? next() : termsGate(req, res, next);
  }

  router.patch('/:namespace', manageAccount, skipTermsForAcceptance, async (req, res) => {
    const target = await loadUserOr404(db, req.params.namespace);
    if (target.Kind === 'organization') {
      throw forbidden(`@${target.Namespace} is an organization; change it through /orgs.`);
    }
    // Acting on another account is an administrative act, so it needs both
    // halves: the admin role on this account and the `admin` scope on the
    // credential. Same-account edits only need `manage:account`.
    if (req.auth.user.Namespace !== target.Namespace && !isAdmin(req.auth)) {
      throw forbidden('Only an admin can update another account.');
    }
    requireObjectBody(req);

    const {
      displayName,
      password,
      role,
      bio,
      website,
      github,
      avatarUrl,
      bannerUrl,
      termsAcceptedVersion,
    } = req.body;
    if (
      displayName === undefined &&
      password === undefined &&
      role === undefined &&
      bio === undefined &&
      website === undefined &&
      github === undefined &&
      avatarUrl === undefined &&
      bannerUrl === undefined &&
      termsAcceptedVersion === undefined
    ) {
      throw fieldErrors([{ field: 'body', message: 'Provide at least one field to update.' }]);
    }

    const errors = profileFieldErrors(req.body);
    if (password !== undefined && (typeof password !== 'string' || password.length < 8)) {
      errors.push({ field: 'password', message: 'Password must be at least 8 characters.' });
    }
    if (role !== undefined && role !== 'admin' && role !== 'normal') {
      errors.push({ field: 'role', message: 'Role must be "admin" or "normal".' });
    }
    // The client sends back the version it actually read, so an acceptance
    // cannot be recorded against text the account never saw. A stale one means
    // the terms changed since: the client has to read them again. Only an
    // integer or a digit-only string can name a version -- String() would
    // otherwise coerce one into shape from, say, an array ["1"] -- and the row
    // records the server's own current version rather than the spelling that
    // arrived.
    let currentTermsVersion = null;
    if (termsAcceptedVersion !== undefined) {
      const wellFormed =
        (typeof termsAcceptedVersion === 'number' && Number.isInteger(termsAcceptedVersion)) ||
        (typeof termsAcceptedVersion === 'string' && /^\d+$/.test(termsAcceptedVersion));
      const terms = await db.LegalDocuments.findUnique({
        where: { Kind: 'terms' },
        select: { Version: true },
      });
      if (!terms) {
        throw notFound('There are no terms to accept yet.');
      }
      currentTermsVersion = Number(terms.Version);
      if (!wellFormed || String(termsAcceptedVersion) !== String(currentTermsVersion)) {
        errors.push({
          field: 'termsAcceptedVersion',
          message: `Must be the current terms version ${currentTermsVersion}. Read GET ${mount('/terms')} to see it.`,
        });
      }
    }
    if (errors.length > 0) throw fieldErrors(errors);

    if (role !== undefined && !isAdmin(req.auth)) {
      throw forbidden('Only an admin can change a role.');
    }

    const patch = {};
    const { patch: profileColumns } = profilePatch(req.body);
    Object.assign(patch, profileColumns);
    if (role !== undefined) patch.Role = role;
    if (termsAcceptedVersion !== undefined) patch.TermsAcceptedVersion = currentTermsVersion;
    if (password !== undefined) {
      // The current-password confirmation is the self-service path. An admin
      // resetting somebody else's password has no password to confirm, which
      // is why this asks for authority rather than for a role alone.
      if (!isAdmin(req.auth)) {
        // An account created through the provider has no password to confirm,
        // and letting a session set one would turn a stolen session into a
        // standing credential, so that stays an admin action.
        if (!target.PasswordHash) {
          throw forbidden(
            'This account signs in with the identity provider. An admin can set a password for it.',
          );
        }
        const currentPassword = req.body.currentPassword;
        if (typeof currentPassword !== 'string' || currentPassword.length === 0) {
          throw fieldErrors([
            {
              field: 'currentPassword',
              message: 'Current password is required when changing your password.',
            },
          ]);
        }
        const valid = await verifyPassword(currentPassword, target.PasswordHash);
        if (!valid) throw forbidden('Current password is incorrect.');
      }
      patch.PasswordHash = await hashPassword(password, config.auth.scrypt);
    }

    const updated = await db.$transaction(async (tx) => {
      await tx.Users.update({ where: { Id: target.Id }, data: patch });
      if (password !== undefined) {
        await tx.Sessions.deleteMany({ where: { UserId: target.Id } });
        await tx.AutomationTokens.deleteMany({ where: { UserId: target.Id } });
        if (Number(req.auth.user.Id) !== Number(target.Id)) {
          await notifyUser(
            tx,
            target.Id,
            'tokens.revoked',
            tokensRevokedMessage(req.auth.user.Namespace),
            { actor: req.auth.user.Namespace },
          );
        }
      }
      if (role !== undefined) {
        await notifyUser(tx, target.Id, 'role.changed', roleChangedMessage(role), { role });
        await audit(
          tx,
          req.auth.user,
          'role.change',
          { namespace: target.Namespace },
          {
            role,
            previousRole: target.Role,
          },
        );
      }
      return tx.Users.findUnique({ where: { Id: target.Id } });
    });
    if (!updated) throw notFound();

    res.json(userToObject(updated, config));
  });

  router.delete('/:namespace', manageAccount, async (req, res) => {
    const target = await loadUserOr404(db, req.params.namespace);
    if (target.Kind === 'organization') {
      throw forbidden(`@${target.Namespace} is an organization; delete it through /orgs.`);
    }
    if (req.auth.user.Namespace !== target.Namespace && !isAdmin(req.auth)) {
      throw forbidden('Only an admin can delete another account.');
    }
    const owned = await db.$transaction(async (tx) => {
      // Serialize owner removals and account deletions on the organization rows.
      await tx.$queryRaw`
        SELECT org."Id" FROM "Users" org
        JOIN "OrganizationOwners" g ON g."OrgId" = org."Id"
        WHERE g."UserId" = ${target.Id}
        ORDER BY org."Id"
        FOR UPDATE OF org
      `;
      const soleOwner = await tx.$queryRaw`
        SELECT org."Namespace"
        FROM "OrganizationOwners" g
        JOIN "Users" org ON org."Id" = g."OrgId"
        WHERE g."UserId" = ${target.Id}
          AND 1 = (SELECT count(*) FROM "OrganizationOwners" x WHERE x."OrgId" = g."OrgId")
        ORDER BY org."Namespace"
      `;
      if (soleOwner.length > 0) {
        throw conflict(
          `You are the only owner of ${soleOwner.map((row) => `@${row.Namespace}`).join(', ')}. Add another owner, or delete the organization, before deleting the account.`,
        );
      }
      // Save the digests before the owner_id cascade removes the versions.
      const rows = await tx.Versions.findMany({
        where: { OwnerId: target.Id },
        select: { BlobDigest: true, BlobPath: true, SourceDigest: true },
      });
      // Delegated publishes charge the namespace account, not the publisher.
      // The refund is one statement against a grouped sum of the rows being
      // removed, which the typed client cannot express.
      await tx.$executeRaw`
        UPDATE "Users" u SET "BlobBytes" = GREATEST(u."BlobBytes" - removed.bytes, 0)
        FROM (
          SELECT "Namespace", sum(COALESCE("BlobSize", 0) + COALESCE("SourceSize", 0)) AS bytes
          FROM "Versions" WHERE "OwnerId" = ${target.Id}
          GROUP BY "Namespace"
        ) removed
        WHERE u."Namespace" = removed."Namespace" AND u."Id" <> ${target.Id}
      `;
      // A webhook is keyed on the namespace text with no user foreign key, so
      // deleting the user row would leave its per-extension and account-wide
      // hooks orphaned; take them, and the deliveries they cascade to, with it.
      await tx.Webhooks.deleteMany({ where: { Namespace: target.Namespace } });
      await tx.Users.delete({ where: { Id: target.Id } });
      // After the owner cascade, keep identities that co-owners' versions
      // still use. The typed client has no relation between these tables.
      await tx.$executeRaw`
        DELETE FROM "Extensions" e
        WHERE e."Namespace" = ${target.Namespace}
          AND NOT EXISTS (
            SELECT 1 FROM "Versions" v
            WHERE v."Namespace" = e."Namespace" AND v."ExtensionId" = e."ExtensionId"
          )
      `;
      return rows;
    });
    const profileDigests = [target.AvatarBlobDigest, target.BannerBlobDigest].filter(Boolean);

    // Only after the commit: a failed DELETE leaves the rows, and the keeper
    // check keeps any digest another account's version still references.
    // A cleanup failure costs disk, not correctness -- the boot-time sweep in
    // db.js collects whatever is left unreferenced.
    // blob_path is set on digest-backed rows too, so the legacy unlink is
    // mutually exclusive with the digest path: doing both would delete a file
    // the keeper check had just decided to keep.
    const legacyPaths = [
      ...new Set(
        owned
          .filter((row) => !row.BlobDigest)
          .map((row) => row.BlobPath)
          .filter(Boolean),
      ),
    ];
    try {
      await Promise.all([
        ...owned
          .map((row) => (row.BlobDigest ? removeBlobIfUnused(db, config, row.BlobDigest) : null))
          .filter(Boolean),
        ...legacyPaths.map((rel) => rm(path.join(config.dataDir, rel), { force: true })),
        // The row is already gone, so no user can still point at these digests.
        ...profileDigests.map((digest) => removeProfileImageBlob(db, config, digest)),
      ]);
    } catch (error) {
      console.error(`blob cleanup deferred for ${target.Namespace}: ${error.message}`);
    }
    try {
      await Promise.all(
        [...new Set(owned.map((row) => row.SourceDigest).filter(Boolean))].map((digest) =>
          removeSourceIfUnused(db, config, digest),
        ),
      );
    } catch (error) {
      console.error(`source cleanup deferred for ${target.Namespace}: ${error.message}`);
    }
    res.status(204).end();
  });

  // Account-wide webhooks: one hook that hears every version event under this
  // account's namespace, instead of registering the same URL once per
  // extension. The per-extension hook at /@namespace/id/webhooks is a separate
  // collection and is unchanged. An organization is what /orgs manages, so a
  // namespace that belongs to one is directed there rather than answered here.
  const webhooks = makeWebhooks({ db, resolveTarget });
  const webhookDeliveries = makeWebhookDeliveryRoutes({ webhooks, config });
  const accountWebhookChain = [manageAccount, termsGate];

  router.get('/:namespace/webhooks', accountWebhookChain, async (req, res) => {
    const target = await loadUserForWrite(db, req);
    res.json({ data: await webhooks.list(target.Namespace, null) });
  });

  router.post('/:namespace/webhooks', accountWebhookChain, async (req, res) => {
    const target = await loadUserForWrite(db, req);
    requireObjectBody(req);
    let created;
    try {
      created = await webhooks.create(target.Namespace, null, req.body);
    } catch (error) {
      if (error instanceof WebhookInputError) throw fieldErrors(error.fields);
      throw error;
    }
    await audit(
      db,
      req.auth.user,
      'account.webhook.create',
      { namespace: target.Namespace },
      {
        url: created.url,
        events: created.events,
      },
    );
    res.status(201).json(created);
  });

  router.delete('/:namespace/webhooks/:webhookId', accountWebhookChain, async (req, res) => {
    const target = await loadUserForWrite(db, req);
    const id = Number(req.params.webhookId);
    if (!Number.isInteger(id)) throw notFound();
    if (!(await webhooks.remove(target.Namespace, null, id))) {
      throw notFound('No such webhook.');
    }
    await audit(
      db,
      req.auth.user,
      'account.webhook.delete',
      { namespace: target.Namespace },
      {
        id,
      },
    );
    res.status(204).end();
  });

  router.get(
    '/:namespace/webhooks/:webhookId/deliveries',
    accountWebhookChain,
    async (req, res) => {
      const target = await loadUserForWrite(db, req);
      await webhookDeliveries.list(req, res, { namespace: target.Namespace, extensionId: null });
    },
  );

  router.post(
    '/:namespace/webhooks/:webhookId/deliveries/:deliveryId/redeliver',
    accountWebhookChain,
    async (req, res) => {
      const target = await loadUserForWrite(db, req);
      await webhookDeliveries.redeliver(req, res, {
        namespace: target.Namespace,
        extensionId: null,
      });
    },
  );

  return router;
}

async function loadUserOr404(db, namespace) {
  if (!isValidNamespace(namespace)) throw notFound();
  const user = await db.Users.findUnique({ where: { Namespace: namespace } });
  if (!user) throw notFound();
  return user;
}

// The account-wide write gate: the caller is the account itself, or an admin
// acting on it. An organization namespace is a 403 that points at /orgs, where
// its own namespace-wide webhooks live.
async function loadUserForWrite(db, req) {
  const target = await loadUserOr404(db, req.params.namespace);
  if (target.Kind === 'organization') {
    throw forbidden(`@${target.Namespace} is an organization; manage its webhooks through /orgs.`);
  }
  if (req.auth.user.Namespace !== target.Namespace && !isAdmin(req.auth)) {
    throw forbidden('Only the account or an admin can manage its webhooks.');
  }
  return target;
}
