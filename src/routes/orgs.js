import { rm } from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import { Prisma } from '../../prisma/generated/client/index.js';
import { requireScope } from '../auth.js';
import { uniqueViolation } from '../db.js';
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
import { makeWebhookDeliveryRoutes } from './webhook-deliveries.js';
import { profileFieldErrors, profilePatch } from '../profile.js';
import { audit } from '../audit.js';

// The address-keyed tables an organization takes with it when it is deleted.
// They are constant names, never request values, so the raw DELETE that clears
// each one is safe to splice the table in for.
const ORG_SCOPED_TABLES = [
  '"DistTags"',
  '"ExtensionOwners"',
  '"ExtensionOwnerInvites"',
  '"DownloadEvents"',
  '"ExtensionDailyDownloads"',
  '"ExtensionVersionDailyDownloads"',
];

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
export function makeOrgsRouter({
  db,
  config,
  termsGate,
  rateLimiter,
  listExtensions,
  resolveTarget,
}) {
  const router = Router();

  // One scope answers every organization write below, since they all ask the
  // same question: may this credential act for an organization at all? Whether
  // it may act for *this* one is `loadOrgForWrite`'s job, and it runs after.
  const manageOrgs = requireScope('manage:orgs');
  const webhooks = makeWebhooks({ db, resolveTarget });
  const webhookDeliveries = makeWebhookDeliveryRoutes({ webhooks, config });
  const apiRoot = normalizeApiRoot(config.apiRoot);
  const orgPath = (namespace) =>
    `${apiRoot ? `/${apiRoot}` : ''}/orgs/${encodeURIComponent(namespace)}`;

  async function loadOrg(namespace) {
    if (!isValidNamespace(namespace)) throw notFound();
    const row = await db.Users.findFirst({
      where: { Namespace: namespace, Kind: 'organization' },
    });
    // A namespace that belongs to an account is a 404 here rather than a
    // redirect: /orgs is for organizations, and the account is one click away
    // at /users.
    if (!row) throw notFound('No such organization.');
    return row;
  }

  async function isOrgOwner(user, org) {
    if (user.Role === 'admin') return true;
    const row = await db.OrganizationOwners.findFirst({
      where: { UserId: user.Id, OrgId: org.Id },
      select: { OrgId: true },
    });
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
    const taken = await db.Users.findFirst({
      where: { Namespace: namespace },
      select: { Id: true },
    });
    if (taken) throw conflict('That namespace is already taken.');

    // Signups are the same act as signing in, so they share the window: an
    // organization is as expensive to mint as an account, and a caller who may
    // make five of one may make five of the other.
    await rateLimiter.signupCheck(`signup:${req.ip}`);

    // The profile columns come from the shared helper, so a field an account
    // accepts is a field an organization accepts, defaults included.
    const { patch } = profilePatch(req.body);
    const columns = {
      Namespace: namespace,
      Kind: 'organization',
      ...patch,
      DisplayName: effectiveDisplayName,
    };
    let org;
    try {
      await db.$transaction(async (tx) => {
        org = await tx.Users.create({ data: columns });
        await tx.OrganizationOwners.create({
          data: { OrgId: org.Id, UserId: req.auth.user.Id, AddedBy: req.auth.user.Id },
        });
        await audit(
          tx,
          req.auth.user,
          'org.create',
          { namespace },
          { displayName: effectiveDisplayName },
        );
      });
    } catch (error) {
      if (uniqueViolation(error)) throw conflict('That namespace is already taken.');
      throw error;
    }

    res.location(orgPath(org.Namespace)).status(201).json(organizationToObject(org, config));
  });

  // The organizations that exist, newest first, alongside accounts in /users.
  // Ordered by id rather than by creation time so the cursor is a plain integer
  // and a same-millisecond pair cannot be skipped or repeated.
  router.get('/', async (req, res) => {
    const limit = parseLimit(config, req.query.limit);
    const cursor = decodeCursor(req.query.cursor, { i: 'int' });
    const back = parseDir(req.query.dir);
    const rows = await db.Users.findMany({
      where: {
        Kind: 'organization',
        ...(cursor ? (back ? { Id: { gt: cursor.i } } : { Id: { lt: cursor.i } }) : {}),
      },
      orderBy: { Id: back ? 'asc' : 'desc' },
      take: limit + 1,
    });
    res.json(
      keysetPage(req, rows, {
        limit,
        back,
        cursor,
        serialize: (row) => organizationToObject(row, config),
        keyOf: (row) => ({ i: Number(row.Id) }),
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

    const updated = await db.Users.update({ where: { Id: org.Id }, data: patch });
    await audit(
      db,
      req.auth.user,
      'org.update',
      { namespace: org.Namespace },
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
    const owned = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "Id" FROM "Users" WHERE "Id" = ${org.Id} FOR UPDATE`;
      // The digests have to come back with the delete, so this keeps its
      // `RETURNING` rather than going through deleteMany.
      const rows = await tx.$queryRaw`
        DELETE FROM "Versions" WHERE "Namespace" = ${org.Namespace}
        RETURNING "BlobDigest", "BlobPath", "SourceDigest"
      `;
      await tx.Webhooks.deleteMany({ where: { Namespace: org.Namespace } });
      for (const table of ORG_SCOPED_TABLES) {
        await tx.$executeRaw`DELETE FROM ${Prisma.raw(table)} WHERE "Namespace" = ${org.Namespace}`;
      }
      await tx.ExtensionTransfers.deleteMany({
        where: { OR: [{ Namespace: org.Namespace }, { ToNamespace: org.Namespace }] },
      });
      await tx.ExtensionRedirects.deleteMany({
        where: { OR: [{ FromNamespace: org.Namespace }, { ToNamespace: org.Namespace }] },
      });
      await tx.Users.delete({ where: { Id: org.Id } });
      await audit(tx, req.auth.user, 'org.delete', { namespace: org.Namespace });
      return rows;
    });
    const profileDigests = [org.AvatarBlobDigest, org.BannerBlobDigest].filter(Boolean);

    // Only after the commit: a failed DELETE leaves the rows, and the keeper
    // check keeps any digest another account's version still references. A
    // cleanup failure costs disk, not correctness -- the boot-time sweep in
    // db.js collects whatever is left unreferenced.
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
        ...profileDigests.map((digest) => removeProfileImageBlob(db, config, digest)),
      ]);
    } catch (error) {
      console.error(`blob cleanup deferred for ${org.Namespace}: ${error.message}`);
    }
    try {
      await Promise.all(
        [...new Set(owned.map((row) => row.SourceDigest).filter(Boolean))].map((digest) =>
          removeSourceIfUnused(db, config, digest),
        ),
      );
    } catch (error) {
      console.error(`source cleanup deferred for ${org.Namespace}: ${error.message}`);
    }
    res.status(204).end();
  });

  // The owner list is public: it is the answer to "who runs this namespace",
  // and the same information is implied by every extension it publishes. Only
  // what identifies a person is exposed -- no role, no accepted terms, no
  // contact details. A two-table join with the avatar columns the URL needs, so
  // it stays a raw read.
  router.get('/:namespace/owners', async (req, res) => {
    const org = await loadOrg(req.params.namespace);
    const rows = await db.$queryRaw`
      SELECT u."Namespace", u."DisplayName", u."CreatedAt", g."AddedAt",
        u."AvatarBlobDigest", u."AvatarUrl"
      FROM "OrganizationOwners" g
      JOIN "Users" u ON u."Id" = g."UserId"
      WHERE g."OrgId" = ${org.Id}
      ORDER BY g."AddedAt", g."UserId"
    `;
    res.json({
      data: rows.map((row) => ({
        namespace: row.Namespace,
        displayName: row.DisplayName,
        avatarUrl: profileImageUrl(row, 'avatar', config),
        addedAt: row.AddedAt.toISOString(),
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
    const user = await db.Users.findUnique({ where: { Namespace: candidate } });
    if (!user) throw notFound('No such account to add.');
    if (user.Kind === 'organization') {
      throw fieldErrors([
        { field: 'namespace', message: 'An organization cannot own another organization.' },
      ]);
    }
    // Adding a co-owner is a grant like any other, so it is idempotent rather
    // than an error: a retry of a request that actually landed should not need
    // the caller to know it landed. The insert, its notification and its audit
    // entry commit together, so a failure after the insert cannot leave a
    // co-owner the audit trail never recorded.
    await db.$transaction(async (tx) => {
      const { count } = await tx.OrganizationOwners.createMany({
        data: [{ OrgId: org.Id, UserId: user.Id, AddedBy: req.auth.user.Id }],
        skipDuplicates: true,
      });
      if (count === 0) return;
      if (user.Id !== req.auth.user.Id) {
        await notifyUser(
          tx,
          user.Id,
          'organization.owner.added',
          addedAsOrgOwnerMessage(req.auth.user.Namespace, org.Namespace),
          { namespace: org.Namespace },
        );
      }
      await audit(
        tx,
        req.auth.user,
        'organization.owner.add',
        { namespace: org.Namespace },
        { added: user.Namespace },
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
    const user = await db.Users.findUnique({ where: { Namespace: candidate } });
    if (!user) throw notFound('No such account.');
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "Id" FROM "Users" WHERE "Id" = ${org.Id} FOR UPDATE`;
      const { count: deleted } = await tx.OrganizationOwners.deleteMany({
        where: { OrgId: org.Id, UserId: user.Id },
      });
      if (deleted === 0) throw notFound('That account is not an owner.');
      const count = await tx.OrganizationOwners.count({ where: { OrgId: org.Id } });
      if (count === 0) {
        throw conflict(
          'That is the only owner. Add another owner, or delete the organization, before removing it.',
        );
      }
      await notifyUser(
        tx,
        user.Id,
        'organization.owner.removed',
        removedAsOrgOwnerMessage(req.auth.user.Namespace, org.Namespace),
        { namespace: org.Namespace },
      );
      await audit(
        tx,
        req.auth.user,
        'organization.owner.remove',
        { namespace: org.Namespace },
        { removed: user.Namespace },
      );
    });
    res.status(204).end();
  });

  // What this organization publishes, newest first, using the registry listing
  // so the sort, license filter and cursor paging are the same ones the public
  // index uses.
  router.get('/:namespace/extensions', async (req, res) => {
    const org = await loadOrg(req.params.namespace);
    res.json(await listExtensions(req, { namespace: org.Namespace }));
  });

  // Namespace-wide webhooks: one hook that hears every version event under this
  // organization, instead of registering the same URL once per extension. The
  // per-extension hook at /@namespace/id/webhooks is unchanged.
  const manageChain = [manageOrgs, termsGate];

  router.get('/:namespace/webhooks', ...manageChain, async (req, res) => {
    const org = await loadOrgForWrite(req);
    res.json({ data: await webhooks.list(org.Namespace, null) });
  });

  router.post('/:namespace/webhooks', ...manageChain, async (req, res) => {
    const org = await loadOrgForWrite(req);
    requireObjectBody(req);
    let created;
    try {
      created = await webhooks.create(org.Namespace, null, req.body);
    } catch (error) {
      if (error instanceof WebhookInputError) throw fieldErrors(error.fields);
      throw error;
    }
    await audit(
      db,
      req.auth.user,
      'organization.webhook.create',
      { namespace: org.Namespace },
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
    if (!(await webhooks.remove(org.Namespace, null, id))) {
      throw notFound('No such webhook.');
    }
    await audit(
      db,
      req.auth.user,
      'organization.webhook.delete',
      { namespace: org.Namespace },
      {
        id,
      },
    );
    res.status(204).end();
  });

  router.get('/:namespace/webhooks/:webhookId/deliveries', ...manageChain, async (req, res) => {
    const org = await loadOrgForWrite(req);
    await webhookDeliveries.list(req, res, { namespace: org.Namespace, extensionId: null });
  });

  router.post(
    '/:namespace/webhooks/:webhookId/deliveries/:deliveryId/redeliver',
    ...manageChain,
    async (req, res) => {
      const org = await loadOrgForWrite(req);
      await webhookDeliveries.redeliver(req, res, { namespace: org.Namespace, extensionId: null });
    },
  );

  // Avatars and banners behave exactly as they do for an account, down to the
  // cached URL and the identicon fallback; only the owner list decides who may
  // replace them.
  router.use(
    makeProfileImageRouter({
      db,
      config,
      load: (namespace) => loadOrg(namespace),
      mayWrite: (row, req) => req.auth.user.Id !== undefined && isOrgOwner(req.auth.user, row),
      serialize: (row) => organizationToObject(row, config),
    }),
  );

  return router;
}
