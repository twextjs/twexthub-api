import { rm } from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import { hashPassword, verifyPassword } from '../password.js';
import { isAdmin, requireScope } from '../auth.js';
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
import { audit } from '../audit.js';

export function makeUsersRouter({ sql, config, termsGate, rateLimiter }) {
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
      await sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext('signup-bootstrap'))`;
        const [{ count }] = await tx`SELECT count(*)::int AS count FROM users`;
        const role = count === 0 ? 'admin' : 'normal';
        [user] = await tx`
          INSERT INTO users (namespace, display_name, password_hash, role)
          VALUES (${namespace}, ${effectiveDisplayName}, ${passwordHash}, ${role})
          RETURNING *
        `;
        created = await createSession(tx, user.id, sessionTtlMs);
      });
    } catch (error) {
      if (error.code === '23505') throw conflict('That namespace is already taken.');
      throw error;
    }

    res
      .location(mount(`/users/${user.namespace}`))
      .status(201)
      .json({
        user: userToObject(user, config),
        session: sessionToObject(created.session),
        token: created.token,
      });
  });

  function serializePublicUser(row, req) {
    const isOwner = req.auth?.user.namespace === row.namespace;
    // Whether to show another account's role and terms state, not whether the
    // caller may act on it, so this is the role alone and not `isAdmin`.
    const seesFullProfile = req.auth?.user.role === 'admin';
    if ((isOwner || seesFullProfile) && row.kind !== 'organization') {
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

    const rows = await sql`
      SELECT * FROM users
      ${cursor ? (back ? sql`WHERE id > ${cursor.i}` : sql`WHERE id < ${cursor.i}`) : sql``}
      ORDER BY id ${back ? sql`ASC` : sql`DESC`}
      LIMIT ${limit + 1}
    `;

    res.json(
      keysetPage(req, rows, {
        limit,
        back,
        cursor,
        serialize: (user) => serializePublicUser(user, req),
        keyOf: (user) => ({ i: Number(user.id) }),
      }),
    );
  });

  router.get('/:namespace', async (req, res) => {
    if (!isValidNamespace(req.params.namespace)) throw notFound();
    const [user] = await sql`SELECT * FROM users WHERE namespace = ${req.params.namespace}`;
    if (!user) throw notFound();
    res.json(serializePublicUser(user, req));
  });

  // Avatars and banners are the same three-state problem for an account and for
  // an organization, so both mount this; only who may write and what the row
  // serializes into differ.
  router.use(
    makeProfileImageRouter({
      sql,
      config,
      load: (namespace) => loadUserOr404(sql, namespace),
      mayWrite: (row, req) => req.auth.user.id === row.id,
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
    const target = await loadUserOr404(sql, req.params.namespace);
    if (target.kind === 'organization') {
      throw forbidden(`@${target.namespace} is an organization; change it through /orgs.`);
    }
    // Acting on another account is an administrative act, so it needs both
    // halves: the admin role on this account and the `admin` scope on the
    // credential. Same-account edits only need `manage:account`.
    if (req.auth.user.namespace !== target.namespace && !isAdmin(req.auth)) {
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
      const [terms] = await sql`SELECT version FROM legal_documents WHERE kind = 'terms'`;
      if (!terms) {
        throw notFound('There are no terms to accept yet.');
      }
      currentTermsVersion = Number(terms.version);
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
    const columns = [];
    const { patch: profileColumns, columns: profileColumnNames } = profilePatch(req.body);
    Object.assign(patch, profileColumns);
    columns.push(...profileColumnNames);
    if (role !== undefined) {
      patch.role = role;
      columns.push('role');
    }
    if (termsAcceptedVersion !== undefined) {
      patch.terms_accepted_version = currentTermsVersion;
      columns.push('terms_accepted_version');
    }
    if (password !== undefined) {
      // The current-password confirmation is the self-service path. An admin
      // resetting somebody else's password has no password to confirm, which
      // is why this asks for authority rather than for a role alone.
      if (!isAdmin(req.auth)) {
        const currentPassword = req.body.currentPassword;
        if (typeof currentPassword !== 'string' || currentPassword.length === 0) {
          throw fieldErrors([
            {
              field: 'currentPassword',
              message: 'Current password is required when changing your password.',
            },
          ]);
        }
        const valid = await verifyPassword(currentPassword, target.password_hash);
        if (!valid) throw forbidden('Current password is incorrect.');
      }
      patch.password_hash = await hashPassword(password, config.auth.scrypt);
      columns.push('password_hash');
    }

    const [updated] = await sql.begin(async (tx) => {
      await tx`UPDATE users SET ${sql(patch, columns)} WHERE id = ${target.id}`;
      if (password !== undefined) {
        await tx`DELETE FROM sessions WHERE user_id = ${target.id}`;
        await tx`DELETE FROM automation_tokens WHERE user_id = ${target.id}`;
        if (Number(req.auth.user.id) !== Number(target.id)) {
          await notifyUser(
            tx,
            target.id,
            'tokens.revoked',
            tokensRevokedMessage(req.auth.user.namespace),
            { actor: req.auth.user.namespace },
          );
        }
      }
      if (role !== undefined) {
        await notifyUser(tx, target.id, 'role.changed', roleChangedMessage(role), { role });
        await audit(
          tx,
          req.auth.user,
          'role.change',
          { namespace: target.namespace },
          {
            role,
            previousRole: target.role,
          },
        );
      }
      return tx`SELECT * FROM users WHERE id = ${target.id}`;
    });
    if (!updated) throw notFound();

    res.json(userToObject(updated, config));
  });

  router.delete('/:namespace', manageAccount, async (req, res) => {
    const target = await loadUserOr404(sql, req.params.namespace);
    if (target.kind === 'organization') {
      throw forbidden(`@${target.namespace} is an organization; delete it through /orgs.`);
    }
    if (req.auth.user.namespace !== target.namespace && !isAdmin(req.auth)) {
      throw forbidden('Only an admin can delete another account.');
    }
    const owned = await sql.begin(async (tx) => {
      // Serialize owner removals and account deletions on the organization rows.
      await tx`
        SELECT org.id FROM users org
        JOIN organization_owners g ON g.org_id = org.id
        WHERE g.user_id = ${target.id}
        ORDER BY org.id
        FOR UPDATE OF org
      `;
      const soleOwner = await tx`
        SELECT org.namespace
        FROM organization_owners g
        JOIN users org ON org.id = g.org_id
        WHERE g.user_id = ${target.id}
          AND 1 = (SELECT count(*) FROM organization_owners x WHERE x.org_id = g.org_id)
        ORDER BY org.namespace
      `;
      if (soleOwner.length > 0) {
        throw conflict(
          `You are the only owner of ${soleOwner.map((row) => `@${row.namespace}`).join(', ')}. Add another owner, or delete the organization, before deleting the account.`,
        );
      }
      // Save the digests before the owner_id cascade removes the versions.
      const rows = await tx`
        SELECT DISTINCT blob_digest, blob_path, source_digest
        FROM versions
        WHERE owner_id = ${target.id}
      `;
      // Delegated publishes charge the namespace account, not the publisher.
      await tx`
        UPDATE users u SET blob_bytes = GREATEST(u.blob_bytes - removed.bytes, 0)
        FROM (
          SELECT namespace, sum(COALESCE(blob_size, 0) + COALESCE(source_size, 0)) AS bytes
          FROM versions WHERE owner_id = ${target.id}
          GROUP BY namespace
        ) removed
        WHERE u.namespace = removed.namespace AND u.id <> ${target.id}
      `;
      await tx`DELETE FROM users WHERE id = ${target.id}`;
      return rows;
    });
    const profileDigests = [target.avatar_blob_digest, target.banner_blob_digest].filter(Boolean);

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
          .filter((row) => !row.blob_digest)
          .map((row) => row.blob_path)
          .filter(Boolean),
      ),
    ];
    try {
      await Promise.all([
        ...owned
          .map((row) => (row.blob_digest ? removeBlobIfUnused(sql, config, row.blob_digest) : null))
          .filter(Boolean),
        ...legacyPaths.map((rel) => rm(path.join(config.dataDir, rel), { force: true })),
        // The row is already gone, so no user can still point at these digests.
        ...profileDigests.map((digest) => removeProfileImageBlob(sql, config, digest)),
      ]);
    } catch (error) {
      console.error(`blob cleanup deferred for ${target.namespace}: ${error.message}`);
    }
    try {
      await Promise.all(
        [...new Set(owned.map((row) => row.source_digest).filter(Boolean))].map((digest) =>
          removeSourceIfUnused(sql, config, digest),
        ),
      );
    } catch (error) {
      console.error(`source cleanup deferred for ${target.namespace}: ${error.message}`);
    }
    res.status(204).end();
  });

  return router;
}

async function loadUserOr404(sql, namespace) {
  if (!isValidNamespace(namespace)) throw notFound();
  const [user] = await sql`SELECT * FROM users WHERE namespace = ${namespace}`;
  if (!user) throw notFound();
  return user;
}
