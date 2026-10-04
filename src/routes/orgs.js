import { rm } from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import { requireScope } from '../auth.js';
import { removeBlobIfUnused } from '../blobs.js';
import { removeProfileImageBlob } from '../profile-images.js';
import { removeSourceIfUnused } from '../sources.js';
import { conflict, fieldErrors, forbidden, notFound } from '../errors.js';
import { decodeCursor, keysetPage, parseDir, parseLimit } from '../pagination.js';
import { organizationToObject, profileImageUrl } from '../serialize.js';
import { isValidNamespace, normalizeApiRoot } from '../util.js';
import { addedAsOrgOwnerMessage, notifyUser, removedAsOrgOwnerMessage } from '../notify.js';
import { requireObjectBody } from './shared.js';
import { makeProfileImageRouter } from './profile-images.js';
import { makeWebhooks, WebhookInputError } from '../webhooks.js';
import { profileFieldErrors, profilePatch } from '../profile.js';
import { audit } from '../audit.js';

// An organization is a pseudo-account: a namespace that publishes extensions,
// carries a profile and holds webhooks, but has no password and no session of
// its own. It is a row in the same table as an account because a published
// address is a namespace and everything keyed on a namespace -- packages, image
// blobs, review trust, GC -- then needs no special case. What marks the row is
// `kind`, and the owner list is what says who acts for it.
//
// Nothing here creates a session: an organization is acted for by its owners
// with their own credentials, so there is nothing to steal and nothing to
// revoke apart from the account.
export function makeOrgsRouter({ sql, config, termsGate, rateLimiter, listExtensions }) {
  const router = Router();

  // One scope answers every organization write below, since they all ask the
  // same question: may this credential act for an organization at all? Whether
  // it may act for *this* one is `loadOrgForWrite`'s job, and it runs after.
  const manageOrgs = requireScope('manage:orgs');
  const webhooks = makeWebhooks({ sql });
  const apiRoot = normalizeApiRoot(config.apiRoot);
  const orgPath = (namespace) =>
    `${apiRoot ? `/${apiRoot}` : ''}/orgs/${encodeURIComponent(namespace)}`;

  async function loadOrg(namespace) {
    if (!isValidNamespace(namespace)) throw notFound();
    const [row] = await sql`
      SELECT * FROM users WHERE namespace = ${namespace} AND kind = 'organization'
    `;
    // A namespace that belongs to an account is a 404 here rather than a
    // redirect: /orgs is for organizations, and the account is one click away
    // at /users.
    if (!row) throw notFound('No such organization.');
    return row;
  }

  async function isOrgOwner(user, org) {
    if (user.role === 'admin') return true;
    const [row] = await sql`
      SELECT 1 FROM organization_owners WHERE user_id = ${user.id} AND org_id = ${org.id}
    `;
    return Boolean(row);
  }

  // Reads the organization and checks the caller may change it in one step, so
  // every write route below starts from the same answer.
  async function loadOrgForWrite(req) {
    const org = await loadOrg(req.params.namespace);
    if (!(await isOrgOwner(req.auth.user, org))) {
      throw forbidden('Only an owner or an admin can change this organization.');
    }
    return org;
  }

  // Creating an organization is a signup: it takes a namespace, it is rate
  // limited like one, and it needs accepted terms since it publishes a profile
  // and an extension namespace. The caller becomes its first owner, which is
  // the only reason it exists -- an organization with no owner could not be
  // changed by anyone.
  router.post('/', manageOrgs, termsGate, async (req, res) => {
    requireObjectBody(req);
    const { namespace, displayName } = req.body;

    const errors = [];
    if (typeof namespace !== 'string' || !isValidNamespace(namespace)) {
      errors.push({
        field: 'namespace',
        message: 'Must be lowercase letters, digits and hyphens; no leading/trailing hyphen.',
      });
    }
    if (displayName !== undefined && (typeof displayName !== 'string' || displayName.length > 80)) {
      errors.push({ field: 'displayName', message: 'Must be a string of at most 80 characters.' });
    }
    errors.push(...profileFieldErrors(req.body));
    if (errors.length > 0) throw fieldErrors(errors);

    const effectiveDisplayName =
      typeof displayName === 'string' && displayName.length > 0 ? displayName : namespace;
    // The namespace is shared with accounts, so an organization cannot be
    // created on a name a version already publishes under. The unique index
    // settles it either way; this only makes the error a 409 about the name
    // instead of an unhandled constraint violation.
    const [taken] = await sql`
      SELECT 1 FROM users WHERE namespace = ${namespace}
    `;
    if (taken) throw conflict('That namespace is already taken.');

    // Signups are the same act as signing in, so they share the window: an
    // organization is as expensive to mint as an account, and a caller who may
    // make five of one may make five of the other.
    await rateLimiter.signupCheck(`signup:${req.ip}`);

    // The profile columns come from the shared helper, so a field an account
    // accepts is a field an organization accepts, defaults included. The object
    // is turned into a column list, which keeps the column names written once
    // instead of once in the helper and once in the query.
    const { patch } = profilePatch(req.body);
    const columns = {
      namespace,
      kind: 'organization',
      ...patch,
      display_name: effectiveDisplayName,
    };
    let org;
    try {
      await sql.begin(async (tx) => {
        [org] = await tx`INSERT INTO users ${tx(columns)} RETURNING *`;
        await tx`
          INSERT INTO organization_owners (org_id, user_id, added_by)
          VALUES (${org.id}, ${req.auth.user.id}, ${req.auth.user.id})
        `;
        await audit(
          tx,
          req.auth.user,
          'org.create',
          { namespace },
          { displayName: effectiveDisplayName },
        );
      });
    } catch (error) {
      if (error.code === '23505') throw conflict('That namespace is already taken.');
      throw error;
    }

    res.location(orgPath(org.namespace)).status(201).json(organizationToObject(org, config));
  });

  // The organizations that exist, newest first, alongside accounts in /users.
  // Ordered by id rather than by creation time so the cursor is a plain integer
  // and a same-millisecond pair cannot be skipped or repeated.
  router.get('/', async (req, res) => {
    const limit = parseLimit(config, req.query.limit);
    const cursor = decodeCursor(req.query.cursor, { i: 'int' });
    const back = parseDir(req.query.dir);
    const rows = await sql`
      SELECT * FROM users
      WHERE kind = 'organization'
      ${cursor ? (back ? sql`AND id > ${cursor.i}` : sql`AND id < ${cursor.i}`) : sql``}
      ORDER BY id ${back ? sql`ASC` : sql`DESC`}
      LIMIT ${limit + 1}
    `;
    res.json(
      keysetPage(req, rows, {
        limit,
        back,
        cursor,
        serialize: (row) => organizationToObject(row, config),
        keyOf: (row) => ({ i: Number(row.id) }),
      }),
    );
  });

  router.get('/:namespace', async (req, res) => {
    const org = await loadOrg(req.params.namespace);
    res.json(organizationToObject(org, config));
  });

  // Only the profile fields, and only from the owner list. An organization has
  // no password, no role and no terms of its own, so this is the whole of what
  // can be changed about it -- the members are changed through /owners.
  router.patch('/:namespace', manageOrgs, termsGate, async (req, res) => {
    const org = await loadOrgForWrite(req);
    requireObjectBody(req);
    const { patch, columns } = profilePatch(req.body);
    if (columns.length === 0) {
      throw fieldErrors([
        {
          field: 'body',
          message:
            'Provide at least one of displayName, bio, website, github, avatarUrl, bannerUrl.',
        },
      ]);
    }
    const errors = profileFieldErrors(req.body);
    if (errors.length > 0) throw fieldErrors(errors);

    const [updated] = await sql`
      UPDATE users SET ${sql(patch)} WHERE id = ${org.id} RETURNING *
    `;
    await audit(
      sql,
      req.auth.user,
      'org.update',
      { namespace: org.namespace },
      {
        changed: Object.keys(patch),
      },
    );
    res.json(organizationToObject(updated, config));
  });

  // Deleting the namespace takes its extensions, its images and its hooks with
  // it. The blobs and sources are content-addressed rather than filed under the
  // namespace, so keep their digests when deleting the version rows.
  router.delete('/:namespace', manageOrgs, termsGate, async (req, res) => {
    const org = await loadOrgForWrite(req);
    const owned = await sql.begin(async (tx) => {
      await tx`SELECT id FROM users WHERE id = ${org.id} FOR UPDATE`;
      const rows = await tx`
        DELETE FROM versions WHERE namespace = ${org.namespace}
        RETURNING blob_digest, blob_path, source_digest
      `;
      await tx`DELETE FROM webhooks WHERE namespace = ${org.namespace}`;
      for (const table of [
        'dist_tags',
        'extension_owners',
        'extension_owner_invites',
        'extension_access',
        'download_events',
        'extension_daily_downloads',
      ]) {
        await tx`DELETE FROM ${tx(table)} WHERE namespace = ${org.namespace}`;
      }
      await tx`
        DELETE FROM extension_transfers
        WHERE namespace = ${org.namespace} OR to_namespace = ${org.namespace}
      `;
      await tx`
        DELETE FROM extension_redirects
        WHERE from_namespace = ${org.namespace} OR to_namespace = ${org.namespace}
      `;
      await tx`DELETE FROM users WHERE id = ${org.id}`;
      await audit(tx, req.auth.user, 'org.delete', { namespace: org.namespace });
      return rows;
    });
    const profileDigests = [org.avatar_blob_digest, org.banner_blob_digest].filter(Boolean);

    // Only after the commit: a failed DELETE leaves the rows, and the keeper
    // check keeps any digest another account's version still references. A
    // cleanup failure costs disk, not correctness -- the boot-time sweep in
    // db.js collects whatever is left unreferenced.
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
        ...profileDigests.map((digest) => removeProfileImageBlob(sql, config, digest)),
      ]);
    } catch (error) {
      console.error(`blob cleanup deferred for ${org.namespace}: ${error.message}`);
    }
    try {
      await Promise.all(
        [...new Set(owned.map((row) => row.source_digest).filter(Boolean))].map((digest) =>
          removeSourceIfUnused(sql, config, digest),
        ),
      );
    } catch (error) {
      console.error(`source cleanup deferred for ${org.namespace}: ${error.message}`);
    }
    res.status(204).end();
  });

  // The owner list is public: it is the answer to "who runs this namespace",
  // and the same information is implied by every extension it publishes. Only
  // what identifies a person is exposed -- no role, no accepted terms, no
  // contact details.
  router.get('/:namespace/owners', async (req, res) => {
    const org = await loadOrg(req.params.namespace);
    const rows = await sql`
      SELECT u.namespace, u.display_name, u.created_at, g.added_at,
        u.avatar_blob_digest, u.avatar_url
      FROM organization_owners g
      JOIN users u ON u.id = g.user_id
      WHERE g.org_id = ${org.id}
      ORDER BY g.added_at, g.user_id
    `;
    res.json({
      data: rows.map((row) => ({
        namespace: row.namespace,
        displayName: row.display_name,
        avatarUrl: profileImageUrl(row, 'avatar', config),
        addedAt: row.added_at.toISOString(),
      })),
    });
  });

  // An owner is an account, never another organization: an organization owns
  // nothing but people, so a second ring of pseudo-accounts would be a way to
  // lose track of who is actually accountable.
  router.put('/:namespace/owners/:ownerNamespace', manageOrgs, termsGate, async (req, res) => {
    const org = await loadOrgForWrite(req);
    const candidate = req.params.ownerNamespace;
    if (!isValidNamespace(candidate)) throw notFound();
    const [user] = await sql`SELECT * FROM users WHERE namespace = ${candidate}`;
    if (!user) throw notFound('No such account to add.');
    if (user.kind === 'organization') {
      throw fieldErrors([
        { field: 'namespace', message: 'An organization cannot own another organization.' },
      ]);
    }
    // Adding a co-owner is a grant like any other, so it is idempotent rather
    // than an error: a retry of a request that actually landed should not need
    // the caller to know it landed.
    const [inserted] = await sql`
      INSERT INTO organization_owners (org_id, user_id, added_by)
      VALUES (${org.id}, ${user.id}, ${req.auth.user.id})
      ON CONFLICT (org_id, user_id) DO NOTHING
      RETURNING 1
    `;
    if (!inserted) {
      res.status(204).end();
      return;
    }
    await sql.begin(async (tx) => {
      if (user.id !== req.auth.user.id) {
        await notifyUser(
          tx,
          user.id,
          'organization.owner.added',
          addedAsOrgOwnerMessage(req.auth.user.namespace, org.namespace),
          { namespace: org.namespace },
        );
      }
      await audit(
        tx,
        req.auth.user,
        'organization.owner.add',
        { namespace: org.namespace },
        { added: user.namespace },
      );
    });
    res.status(204).end();
  });

  // The last owner cannot be removed. An organization nobody owns has no way
  // back: its namespace is published to and its profile is frozen, so the row
  // is either handed on or the organization is deleted.
  router.delete('/:namespace/owners/:ownerNamespace', manageOrgs, termsGate, async (req, res) => {
    const org = await loadOrgForWrite(req);
    const candidate = req.params.ownerNamespace;
    if (!isValidNamespace(candidate)) throw notFound();
    const [user] = await sql`SELECT * FROM users WHERE namespace = ${candidate}`;
    if (!user) throw notFound('No such account.');
    await sql.begin(async (tx) => {
      await tx`SELECT id FROM users WHERE id = ${org.id} FOR UPDATE`;
      const [deleted] = await tx`
          DELETE FROM organization_owners
          WHERE org_id = ${org.id} AND user_id = ${user.id}
          RETURNING 1
        `;
      if (!deleted) throw notFound('That account is not an owner.');
      const [{ count }] = await tx`
          SELECT count(*)::int AS count FROM organization_owners WHERE org_id = ${org.id}
        `;
      if (count === 0) {
        throw conflict(
          'That is the only owner. Add another owner, or delete the organization, before removing it.',
        );
      }
      await notifyUser(
        tx,
        user.id,
        'organization.owner.removed',
        removedAsOrgOwnerMessage(req.auth.user.namespace, org.namespace),
        { namespace: org.namespace },
      );
      await audit(
        tx,
        req.auth.user,
        'organization.owner.remove',
        { namespace: org.namespace },
        { removed: user.namespace },
      );
    });
    res.status(204).end();
  });

  // What this organization publishes, newest first, using the registry listing
  // so the sort, license filter and cursor paging are the same ones the public
  // index uses. Owners see their private extensions; everyone else does not.
  router.get('/:namespace/extensions', async (req, res) => {
    const org = await loadOrg(req.params.namespace);
    res.json(await listExtensions(req, { namespace: org.namespace }));
  });

  // Namespace-wide webhooks: one hook that hears every version event under this
  // organization, instead of registering the same URL once per extension. The
  // per-extension hook at /@namespace/id/webhooks is unchanged.
  const manageChain = [manageOrgs, termsGate];

  router.get('/:namespace/webhooks', ...manageChain, async (req, res) => {
    const org = await loadOrgForWrite(req);
    res.json({ data: await webhooks.list(org.namespace, null) });
  });

  router.post('/:namespace/webhooks', ...manageChain, async (req, res) => {
    const org = await loadOrgForWrite(req);
    requireObjectBody(req);
    let created;
    try {
      created = await webhooks.create(org.namespace, null, req.body);
    } catch (error) {
      if (error instanceof WebhookInputError) throw fieldErrors(error.fields);
      throw error;
    }
    await audit(
      sql,
      req.auth.user,
      'organization.webhook.create',
      { namespace: org.namespace },
      {
        url: created.url,
        events: created.events,
      },
    );
    res.status(201).json(created);
  });

  router.delete('/:namespace/webhooks/:webhookId', ...manageChain, async (req, res) => {
    const org = await loadOrgForWrite(req);
    const id = Number(req.params.webhookId);
    if (!Number.isInteger(id)) throw notFound();
    if (!(await webhooks.remove(org.namespace, null, id))) {
      throw notFound('No such webhook.');
    }
    await audit(
      sql,
      req.auth.user,
      'organization.webhook.delete',
      { namespace: org.namespace },
      {
        id,
      },
    );
    res.status(204).end();
  });

  // Avatars and banners behave exactly as they do for an account, down to the
  // cached URL and the identicon fallback; only the owner list decides who may
  // replace them.
  router.use(
    makeProfileImageRouter({
      sql,
      config,
      load: (namespace) => loadOrg(namespace),
      mayWrite: (row, req) => req.auth.user.id !== undefined && isOrgOwner(req.auth.user, row),
      serialize: (row) => organizationToObject(row, config),
    }),
  );

  return router;
}
