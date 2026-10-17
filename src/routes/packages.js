import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import express, { Router } from 'express';
import semver from 'semver';
import YAML from 'yaml';
import { Prisma } from '../../prisma/generated/client/index.js';
import {
  assertAdmin,
  isAdmin,
  isExtensionOwner as isExtensionOwnerRow,
  isOrganizationOwner,
  organizationsOwnedBy,
  requireAuth,
  requireScope,
} from '../auth.js';
import { uniqueViolation } from '../db.js';
import { withLocks } from '../locks.js';
import { conflict, forbidden, HttpError, fieldErrors, notFound, unauthorized } from '../errors.js';
import {
  buildSearchText,
  compareSemver,
  isValidExtensionId,
  isValidNamespace,
  maxVersionBySemver,
  normalizeApiRoot,
  normalizeSemver,
} from '../util.js';
import { extensionDetailFromRow, sourceUrl, versionToObject } from '../serialize.js';
import {
  addedAsOwnerMessage,
  invitedAsOwnerMessage,
  notifyOwnerCandidate,
  notifyUser,
  removedAsOwnerMessage,
  reviewApprovedMessage,
  reviewRejectedMessage,
  withdrawnAsOwnerMessage,
} from '../notify.js';
import { requireObjectBody } from './shared.js';
import {
  acceptTransfer,
  hasOrgOwner,
  loadNamespaceAccount as loadTransferRecipient,
  mayOfferTransfer,
  mayReceiveTransfer,
  openTransfer,
  pendingTransfersFor,
  redirectFor,
  withdrawTransfer,
} from '../transfer.js';
import {
  BLOB_GC_LOCK_KEY,
  blobPathFor,
  removeBlobIfUnused,
  removeBlobIfUnusedInTx,
  sha256Hex,
  sha512Base64,
  storeBlob,
  storeBlobBuffer,
} from '../blobs.js';
import { sourcePathFor, removeSourceIfUnusedInTx, storeSource } from '../sources.js';
import { manifestFromProject } from '../project-manifest.js';
import { extractTarballBuffer } from '../tarball.js';
import { compileProject } from '../compiler.js';
import { scanSourceWarnings } from '../risky-patterns.js';
import { minifyCode, MINIFY_INPUT_MAX_BYTES } from '../minify.js';
import {
  totalDownloads,
  versionDownloads,
  versionDownloadTotals,
  hashDownloadAddress,
} from '../metrics.js';
import { makeWebhooks, WebhookInputError } from '../webhooks.js';
import { makeWebhookDeliveryRoutes } from './webhook-deliveries.js';
import { audit, auditSoon } from '../audit.js';
import { decodeCursor, offsetPage, parseLimit } from '../pagination.js';

// Every state a version row can hold (the CHECK in 0001_init.sql plus 0007's
// deprecated). A stranger only ever reads the public pair; the rest are what
// the list endpoint's status filter opens to the address's owners and admins.
const VERSION_STATUSES = new Set([
  'staging',
  'pending',
  'published',
  'rejected',
  'yanked',
  'deprecated',
]);

export function makePackagesRouter({ db, config, termsGate, rateLimiter, resolveTarget }) {
  const router = Router();
  const root = normalizeApiRoot(config.apiRoot);
  // normalizeApiRoot strips the surrounding slashes, so the prefix is rebuilt
  // here: a Location header needs exactly one leading slash or the client
  // resolves it against the wrong origin.
  const mount = (path) => `${root ? `/${root}` : ''}${path}`;
  const webhooks = makeWebhooks({ db, resolveTarget });
  const webhookDeliveries = makeWebhookDeliveryRoutes({ webhooks, config });

  const yankChain = [requireAuth, termsGate, requireScope('yank')];
  const ownerChain = [requireAuth, termsGate];
  const publishChain = [requireAuth, termsGate, requireScope('publish')];

  // Three ways to hold an extension. The namespace account owns the address.
  // An organization owner owns the address of the organization they own, which
  // is a separate test because it has to hold before the extension's first
  // publish, when there is no ownership row to find. And an ownership row --
  // the account's own, or one held by an organization the account is on the
  // owner list of -- makes a co-owner of somebody else's extension.
  async function isExtensionOwner(user, namespace, id) {
    if (user.role === 'admin') return true;
    if (user.namespace === namespace) return true;
    if (await isExtensionOwnerRow(db, user, namespace, id)) return true;
    return isOrganizationOwner(db, user, namespace);
  }

  // Reading an unpublished version is the same authority the single-version
  // endpoint asks for before it hands back a pending or rejected build: the
  // owner half is every holder of the address, and the admin half is the role
  // plus the `admin` scope, because a role on its own is not permission to
  // walk the moderation queue.
  async function maySeeUnpublished(req, namespace, id) {
    if (isAdmin(req.auth)) return true;
    const user = req.auth?.user;
    if (!user) return false;
    if (user.namespace === namespace) return true;
    if (await isExtensionOwnerRow(db, user, namespace, id)) return true;
    return isOrganizationOwner(db, user, namespace);
  }

  async function loadNamespaceAccount(namespace) {
    return db.users.findUnique({ where: { namespace } });
  }

  async function loadVersion(namespace, id, version) {
    return db.versions.findFirst({
      where: { namespace, extension_id: id, version },
    });
  }

  // Whether the address has ever held a version. The owner rows outlive a
  // deleted extension on purpose, so an empty owner list is not on its own
  // evidence that there is nothing at the address.
  async function extensionExists(namespace, id) {
    const row = await db.versions.findFirst({
      where: { namespace, extension_id: id, status: { not: 'rejected' } },
      select: { id: true },
    });
    return Boolean(row);
  }

  // `latest` picks the highest published version, falling back to the deprecated
  // ones when nothing is still published.
  async function loadLatestPublished(namespace, id) {
    const rows = await db.versions.findMany({
      where: { namespace, extension_id: id, status: { in: ['published', 'deprecated'] } },
    });
    if (rows.length === 0) return null;
    const published = rows.filter((row) => row.status === 'published');
    const pool = published.length > 0 ? published : rows;
    const ceiling = maxVersionBySemver(pool.map((row) => row.version));
    return pool.find((row) => row.version === ceiling);
  }

  async function resolveVersion(params) {
    const { namespace, id, version } = params;
    const row =
      version === 'latest'
        ? await loadLatestPublished(namespace, id)
        : await loadVersion(namespace, id, version);
    if (row) return row;
    if (!/^[a-zA-Z0-9-]{1,30}$/.test(version)) throw notFound();
    const tagRow = await db.dist_tags.findFirst({
      where: { namespace, extension_id: id, tag: version },
      select: { version: true },
    });
    if (!tagRow) throw notFound();
    return await loadVersion(namespace, id, tagRow.version);
  }

  // An address that has been transferred away answers with the address that
  // replaced it, so a pinned `@old/id` keeps resolving.
  async function redirectIfMoved(req, res, suffix = '') {
    const { namespace, id } = req.params;
    const moved = await redirectFor(db, namespace, id);
    if (!moved) return false;
    const query = req.originalUrl.includes('?')
      ? `?${req.originalUrl.slice(req.originalUrl.indexOf('?') + 1)}`
      : '';
    res.redirect(301, mount(`/@${moved.namespace}/${moved.id}${suffix}${query}`));
    return true;
  }

  // A range is a filter on the collection, not a lookup of its own: the list is
  // every version the caller can see that satisfies it, highest SemVer first, so
  // the first entry is the one a "resolve" would have picked.
  router.get('/@:namespace/:id/versions', async (req, res) => {
    const { namespace, id } = req.params;
    if (!isValidNamespace(namespace) || !isValidExtensionId(id)) throw notFound();
    if (await redirectIfMoved(req, res, '/versions')) return;
    const { range, status } = req.query;
    if (range !== undefined && (typeof range !== 'string' || !semver.validRange(range.trim()))) {
      throw fieldErrors([{ field: 'range', message: 'Must be a valid SemVer range.' }]);
    }
    // The pair a stranger sees. Naming any other status is how an owner or an
    // admin reads their own moderation state -- most often the build that is
    // still waiting on review -- so it takes the same authority the
    // single-version endpoint asks for to hand back an unpublished row.
    if (status !== undefined) {
      if (typeof status !== 'string' || !VERSION_STATUSES.has(status)) {
        throw fieldErrors([{ field: 'status', message: 'Must be a valid version status.' }]);
      }
      if (!req.auth) throw unauthorized();
      if (!(await maySeeUnpublished(req, namespace, id))) {
        throw forbidden('Only an owner or an admin can filter by status.');
      }
    }
    const limit = parseLimit(config, req.query.limit);
    const cursor = decodeCursor(req.query.cursor, { o: 'int' });
    // This list is sorted and filtered in memory, so the cursor is an offset
    // into the result rather than a key to compare against. Paging is still
    // link-driven: `offsetPage` points at the neighbouring offsets, and a
    // `dir` on the request is meaningless here and ignored.
    const offset = cursor ? cursor.o - 1 : 0;

    const visibility =
      status === undefined
        ? Prisma.sql`status IN ('published', 'deprecated')`
        : Prisma.sql`status = ${status}`;
    const rows = await db.$queryRaw`
      SELECT * FROM versions
      WHERE namespace = ${namespace} AND extension_id = ${id}
        AND ${visibility}
    `;
    const matches = rows
      .map((row) => ({ row, coerced: semver.valid(row.version) }))
      .filter(
        (entry) =>
          entry.coerced &&
          (range === undefined ||
            semver.satisfies(entry.coerced, range.trim(), { includePrerelease: true })),
      );
    // SemVer order is not something Postgres can sort, and a dist-tag or a
    // build-metadata string would sort wrong as text, so the ordering happens
    // here over the versions already filtered.
    matches.sort((a, b) => semver.rcompare(a.coerced, b.coerced));

    const totals = await versionDownloadTotals(db, namespace, id);
    res.json(
      offsetPage(req, matches.slice(offset, offset + limit), {
        limit,
        offset,
        total: matches.length,
        serialize: (entry) =>
          versionToObject(entry.row, config, totals.get(entry.row.version) ?? 0n),
      }),
    );
  });

  router.post(
    '/@:namespace/:id/versions',
    requireAuth,
    express.raw({
      type: ['application/gzip', 'application/octet-stream'],
      limit: config.limits?.maxSourceBytes ?? 1024 * 1024,
    }),
    termsGate,
    requireScope('publish'),
    async (req, res, next) => {
      try {
        // Counted per account, not per IP: CI runners often share egress IPs.
        await rateLimiter.publishCheck(`publish:${req.auth.user.namespace}`)();
        next();
      } catch (error) {
        next(error);
      }
    },
    async (req, res) => {
      const { namespace, id } = req.params;
      if (!isValidExtensionId(id)) {
        throw fieldErrors([{ field: 'id', message: 'Invalid extension id.' }]);
      }
      if (!isValidNamespace(namespace)) throw notFound();

      // The JSON parser is skipped for this path, but nothing stops a crafted
      // request from landing here with a body of another type — a parsed
      // object or a bare string, whose `length` is whatever the sender put
      // there. The type is settled once, here, so the size and quota
      // arithmetic below always reads a real Buffer.
      const upload = req.body;
      if (typeof upload !== 'object' || !Buffer.isBuffer(upload) || upload.length === 0) {
        throw new HttpError(415, {
          title: 'Unsupported Media Type',
          detail:
            'Publish a gzip tarball (application/gzip) containing twext.yml, src/, and a package.json with "type": "module".',
        });
      }
      const tarball = upload;

      const owner = await loadNamespaceAccount(namespace);
      if (!owner) throw notFound('No such publishing account.');
      if (!(await isExtensionOwner(req.auth.user, namespace, id))) {
        throw forbidden('You can only publish to an extension you own.');
      }

      if (await redirectFor(db, namespace, id)) {
        throw conflict('This extension address has been transferred away.');
      }

      const maxSource = config.limits?.maxSourceBytes ?? 1024 * 1024;
      if (tarball.length > maxSource) {
        throw new HttpError(413, {
          title: 'Payload Too Large',
          detail: `Source tarball is ${tarball.length} bytes; the limit is ${maxSource}.`,
        });
      }

      const jobDir = await mkdtemp(path.join(config.dataDir, 'tmp', 'build-'));
      let manifest;
      let buildLog;
      let compiled;
      let warnings;
      try {
        const projectDir = path.join(jobDir, 'project');
        await mkdir(projectDir, { recursive: true });
        let files;
        try {
          files = await extractTarballBuffer(tarball, projectDir, {
            maxTotalBytes: maxSource * 16,
          });
        } catch (error) {
          throw new HttpError(422, {
            title: 'Invalid Tarball',
            detail: error.message,
          });
        }
        warnings = await scanSourceWarnings(projectDir, files);

        let projectText;
        try {
          projectText = await readFile(path.join(projectDir, 'twext.yml'), 'utf8');
        } catch {
          throw fieldErrors([
            { field: 'twext.yml', message: 'The tarball must contain a twext.yml project file.' },
          ]);
        }
        let projectConfig;
        try {
          projectConfig = YAML.parse(projectText) ?? {};
        } catch (error) {
          throw fieldErrors([
            { field: 'twext.yml', message: `twext.yml is not valid YAML: ${error.message}` },
          ]);
        }
        const derived = manifestFromProject(projectConfig, id);
        if (derived.errors.length > 0) throw fieldErrors(derived.errors);
        manifest = derived.manifest;

        const build = await compileProject(config, projectDir);
        buildLog = build.log;
        if (!build.ok) {
          throw new HttpError(422, {
            title: 'Build Failed',
            detail: build.error,
            extra: { buildLog, buildError: build.error },
          });
        }
        compiled = build.code;

        // Size caps: per-blob, then the account's cumulative quota (their own
        // override when set, otherwise the configured default). Both the served
        // blob and the retained source count toward the quota. The quota is
        // checked again under a row lock where the charge commits; this one
        // spares the caller a build it cannot afford.
        // The compiler resolves to a Buffer in every branch (see compileProject);
        // the guard also gives the length computations below a type-narrowed value.
        if (!(compiled instanceof Buffer)) {
          throw new HttpError(500, { detail: 'Compiler returned no compiled output.' });
        }
        const maxBlob = config.limits?.maxBlobBytes ?? 2 * 1024 * 1024;
        // A trusted account skips review, so its build is minified here; a
        // version that has to be reviewed is minified when an admin approves
        // it. The storage check below runs on the bytes that will actually be
        // kept, so a build that minifies under the limit passes even when the
        // raw compiler output is larger. The minifier's own input cap is
        // separate: it only bounds the parse, not what is allowed to be stored.
        const shrunk =
          owner.has_published && config.compiler?.minify !== false
            ? await minifyCode(compiled, { maxBytes: MINIFY_INPUT_MAX_BYTES })
            : null;
        if (shrunk?.ok) compiled = shrunk.code;
        const codeBytes = compiled.length;
        if (codeBytes > maxBlob) {
          throw new HttpError(413, {
            title: 'Payload Too Large',
            detail: `Compiled output is ${codeBytes} bytes; the limit is ${maxBlob}.`,
          });
        }
        const quota =
          owner.max_blob_bytes ?? config.limits?.maxAccountBlobBytes ?? 64 * 1024 * 1024;
        const charge = codeBytes + tarball.length;
        if (Number(owner.blob_bytes ?? 0) + charge > quota) {
          throw new HttpError(413, {
            title: 'Payload Too Large',
            detail: `Publishing ${charge} bytes would exceed the ${quota}-byte storage quota for @${owner.namespace}.`,
          });
        }
      } finally {
        await rm(jobDir, { recursive: true, force: true });
      }

      const row = await publishVersion(db, config, owner, {
        id,
        manifest,
        code: compiled,
        sourceBuffer: tarball,
        buildLog,
        warnings,
        stagedBy: req.auth.user,
      });
      if (row.status === 'published') {
        void webhooks.scheduleFor(namespace, id, 'version.published', {
          version: row.version,
          occurredAt: new Date().toISOString(),
          actor: req.auth.user.namespace,
        });
      }
      res.status(201).json({
        ...versionToObject(row, config),
        ...(buildLog ? { buildLog } : {}),
        ...(row.source_path
          ? { sourceUrl: sourceUrl(config, row.namespace, row.extension_id, row.version) }
          : {}),
      });
    },
  );

  router.get('/@:namespace/:id/webhooks', publishChain, async (req, res) => {
    const { namespace, id } = req.params;
    if (!isValidNamespace(namespace) || !isValidExtensionId(id)) throw notFound();
    if (!(await isExtensionOwner(req.auth.user, namespace, id))) {
      throw forbidden('Only an owner or an admin can list webhooks.');
    }
    res.json({ data: await webhooks.list(namespace, id) });
  });

  router.post('/@:namespace/:id/webhooks', publishChain, async (req, res) => {
    const { namespace, id } = req.params;
    if (!isValidNamespace(namespace) || !isValidExtensionId(id)) throw notFound();
    if (!(await isExtensionOwner(req.auth.user, namespace, id))) {
      throw forbidden('Only an owner or an admin can create webhooks.');
    }
    requireObjectBody(req);
    try {
      const created = await webhooks.create(namespace, id, req.body);
      res.status(201).json(created);
    } catch (error) {
      if (error instanceof WebhookInputError) {
        throw fieldErrors(error.fields);
      }
      throw error;
    }
  });

  router.delete('/@:namespace/:id/webhooks/:webhookId', publishChain, async (req, res) => {
    const { namespace, id, webhookId } = req.params;
    if (!isValidNamespace(namespace) || !isValidExtensionId(id)) throw notFound();
    if (!(await isExtensionOwner(req.auth.user, namespace, id))) {
      throw forbidden('Only an owner or an admin can delete webhooks.');
    }
    const removed = await webhooks.remove(namespace, id, Number(webhookId));
    if (!removed) throw notFound();
    res.status(204).end();
  });

  router.get('/@:namespace/:id/webhooks/:webhookId/deliveries', publishChain, async (req, res) => {
    const { namespace, id } = req.params;
    if (!isValidNamespace(namespace) || !isValidExtensionId(id)) throw notFound();
    if (!(await isExtensionOwner(req.auth.user, namespace, id))) {
      throw forbidden('Only an owner or an admin can view webhook deliveries.');
    }
    await webhookDeliveries.list(req, res, { namespace, extensionId: id });
  });

  router.post(
    '/@:namespace/:id/webhooks/:webhookId/deliveries/:deliveryId/redeliver',
    publishChain,
    async (req, res) => {
      const { namespace, id } = req.params;
      if (!isValidNamespace(namespace) || !isValidExtensionId(id)) throw notFound();
      if (!(await isExtensionOwner(req.auth.user, namespace, id))) {
        throw forbidden('Only an owner or an admin can redeliver a webhook.');
      }
      await webhookDeliveries.redeliver(req, res, { namespace, extensionId: id });
    },
  );

  router.get('/@:namespace/:id/tags', async (req, res) => {
    const { namespace, id } = req.params;
    if (!isValidNamespace(namespace) || !isValidExtensionId(id)) throw notFound();
    if (await redirectIfMoved(req, res, '/tags')) return;
    const rows = await db.dist_tags.findMany({
      where: { namespace, extension_id: id },
      select: { tag: true, version: true },
      orderBy: { tag: 'asc' },
    });
    const tags = Object.fromEntries(rows.map((row) => [row.tag, row.version]));
    if (Object.keys(tags).length === 0) throw notFound();
    res.json(tags);
  });

  router.put('/@:namespace/:id/tags/:tag', publishChain, async (req, res) => {
    const { namespace, id, tag } = req.params;
    if (!isValidNamespace(namespace) || !isValidExtensionId(id)) throw notFound();
    if (tag === 'latest' || !/^[a-zA-Z0-9-]{1,30}$/.test(tag)) {
      throw fieldErrors([
        {
          field: 'tag',
          message: 'Must be 1-30 letters, digits, or hyphens; "latest" is reserved.',
        },
      ]);
    }
    if (!(await isExtensionOwner(req.auth.user, namespace, id))) {
      throw forbidden('Only an owner or an admin can set tags.');
    }
    requireObjectBody(req);
    const version = req.body.version;
    const normalized = normalizeSemver(version);
    if (!normalized) {
      throw fieldErrors([{ field: 'version', message: 'Must be a valid SemVer string.' }]);
    }
    const exists = await db.versions.findFirst({
      where: {
        namespace,
        extension_id: id,
        version: normalized,
        status: 'published',
      },
      select: { id: true },
    });
    if (!exists) throw notFound('Tagged versions must be published.');
    // The unique triple is the conflict target, so the typed upsert knows which
    // row to update.
    await db.dist_tags.upsert({
      where: { namespace_extension_id_tag: { namespace, extension_id: id, tag } },
      create: { owner_id: req.auth.user.id, namespace, extension_id: id, tag, version: normalized },
      update: { version: normalized, owner_id: req.auth.user.id },
    });
    auditSoon(db, req.auth.user, 'tag.set', { namespace, id, version: normalized }, { tag });
    res.status(204).end();
  });

  router.delete('/@:namespace/:id/tags/:tag', publishChain, async (req, res) => {
    const { namespace, id, tag } = req.params;
    if (!isValidNamespace(namespace) || !isValidExtensionId(id)) throw notFound();
    if (tag === 'latest') {
      throw fieldErrors([{ field: 'tag', message: '"latest" is reserved.' }]);
    }
    if (!(await isExtensionOwner(req.auth.user, namespace, id))) {
      throw forbidden('Only an owner or an admin can remove tags.');
    }
    const { count } = await db.dist_tags.deleteMany({
      where: { namespace, extension_id: id, tag },
    });
    if (count === 0) throw notFound();
    auditSoon(db, req.auth.user, 'tag.remove', { namespace, id }, { tag });
    res.status(204).end();
  });

  router.get('/@:namespace/:id/versions/:version', async (req, res) => {
    if (await redirectIfMoved(req, res, `/versions/${req.params.version}`)) return;
    const row = await resolveVersion(req.params);
    const isVisible =
      row.status === 'published' || row.status === 'yanked' || row.status === 'deprecated';
    if (!isVisible && !(await maySeeUnpublished(req, req.params.namespace, req.params.id))) {
      throw notFound();
    }
    res.json(
      versionToObject(
        row,
        config,
        await versionDownloads(db, row.namespace, row.extension_id, row.version),
      ),
    );
  });

  // A deprecation and a moderation decision are both edits to the version's own
  // fields, so they share the one PATCH on the version and the body says which
  // of the two it is.
  async function deprecateVersion(req, res, message) {
    if (!req.auth.scopes.includes('publish')) {
      throw forbidden('This token is missing the required "publish" scope.');
    }
    const { namespace, id, version } = req.params;
    if (!isValidNamespace(namespace) || !isValidExtensionId(id)) throw notFound();
    const row = await db.versions.findFirst({
      where: { namespace, extension_id: id, version },
    });
    if (!row || (row.status !== 'published' && row.status !== 'deprecated')) throw notFound();
    const canManage = await isExtensionOwner(req.auth.user, namespace, id);
    if (!canManage) {
      throw forbidden('Only an owner or an admin can deprecate this version.');
    }
    const updated = await db.versions.update({
      where: { id: row.id },
      data: {
        status: message === null ? 'published' : 'deprecated',
        deprecation_message: message ?? null,
      },
    });
    auditSoon(
      db,
      req.auth.user,
      message === null ? 'version.undeprecate' : 'version.deprecate',
      { namespace, id, version: updated.version },
      { message: message ?? null },
    );
    // A null message puts the version back, so it is not a deprecation.
    if (message !== null) {
      void webhooks.scheduleFor(namespace, id, 'version.deprecated', {
        version: updated.version,
        occurredAt: new Date().toISOString(),
        actor: req.auth.user.namespace,
      });
    }
    res.json(
      versionToObject(
        updated,
        config,
        await versionDownloads(db, updated.namespace, updated.extension_id, updated.version),
      ),
    );
  }

  // A version awaiting approval is stored as the compiler produced it, so a
  // reviewer can read the exact bytes that would be served. Approval is when
  // they become public; minifying now means the digest and integrity hash the
  // API reports describe the minified output. A failed pass is not fatal — the
  // original bytes are still a valid build.
  async function minifyPendingBlob(row) {
    if (config.compiler?.minify === false) return null;
    const abs = row.blob_digest
      ? blobPathFor(config.dataDir, row.blob_digest)
      : path.join(config.dataDir, row.blob_path);
    let original;
    try {
      original = await readFile(abs);
    } catch {
      return null;
    }
    const maxBytes = config.limits?.maxBlobBytes ?? 2 * 1024 * 1024;
    const shrunk = await minifyCode(original, { maxBytes });
    if (!shrunk.ok || !shrunk.changed) return null;
    return { code: shrunk.code };
  }

  // A review is a moderation decision, so it needs the admin role on the
  // account and the `admin` scope on the credential. An automation token held by
  // an admin can review once it is granted that scope; a non-admin cannot get
  // there, because the role check runs first.
  async function reviewVersion(req, res, status) {
    assertAdmin(req.auth);
    const { namespace, id, version } = req.params;
    if (!isValidNamespace(namespace) || !isValidExtensionId(id)) throw notFound();
    const row = await db.versions.findFirst({
      where: { namespace, extension_id: id, version, status: 'pending' },
    });
    if (!row) throw notFound('No pending version matches that address.');
    if (status !== 'approved' && status !== 'rejected') {
      throw fieldErrors([{ field: 'status', message: 'Must be "approved" or "rejected".' }]);
    }

    if (status === 'rejected') {
      const reason = req.body.reason;
      if (typeof reason !== 'string' || reason.trim().length === 0) {
        throw fieldErrors([{ field: 'reason', message: 'A reason is required when rejecting.' }]);
      }
      const updated = await db.$transaction(async (tx) => {
        // The status guard is part of the update, so a concurrent review that
        // already moved the row is not overwritten.
        const rows = await tx.$queryRaw`
          UPDATE versions SET status = 'rejected', rejection_reason = ${reason}
          WHERE id = ${row.id} AND status = 'pending'
          RETURNING *
        `;
        if (rows[0]) {
          await notifyUser(
            tx,
            row.owner_id,
            'review.rejected',
            reviewRejectedMessage(row.extension_id, row.version, reason),
            { namespace: row.namespace, id: row.extension_id, version: row.version, reason },
          );
          await audit(
            tx,
            req.auth.user,
            'version.reject',
            { namespace, id, version: row.version },
            { reason },
          );
        }
        return rows[0];
      });
      if (!updated) {
        throw conflict('That version is no longer pending review.');
      }
      void webhooks.scheduleFor(namespace, id, 'version.rejected', {
        version: updated.version,
        occurredAt: new Date().toISOString(),
        actor: req.auth.user.namespace,
      });
      return res.json(
        versionToObject(
          updated,
          config,
          await versionDownloads(db, updated.namespace, updated.extension_id, updated.version),
        ),
      );
    }

    // Minify before the transaction so the CPU-bound pass does not hold the row
    // lock. The output is content-addressed, so a concurrent approval that loses
    // the status race writes the same bytes and is harmless.
    const shrunk = await minifyPendingBlob(row);

    const promote = async (tx) => {
      let stored = null;
      if (shrunk) {
        // GC holds the exclusive lock; the promotion shares it until the new
        // digest commits, so a sweep cannot unlink the bytes being promoted.
        stored = await storeBlobBuffer(config.dataDir, shrunk.code);
      }
      const rows = stored
        ? await tx.$queryRaw`
            UPDATE versions
            SET status = 'published', published_at = now(),
                blob_path = ${path.join('blobs', stored.digest.slice(0, 2), stored.digest.slice(2))},
                blob_digest = ${stored.digest}, blob_size = ${stored.size},
                blob_sha512 = ${stored.sha512}
            WHERE id = ${row.id} AND status = 'pending'
            RETURNING *
          `
        : await tx.$queryRaw`
            UPDATE versions SET status = 'published', published_at = now()
            WHERE id = ${row.id} AND status = 'pending'
            RETURNING *
          `;
      if (rows[0]) {
        // The gate that decides whether a version needs review reads
        // has_published from the namespace account (finalStatus, and the boot
        // reconcile in db.js), and owner_id holds the delegated publisher rather
        // than the namespace, so the flag has to be set by namespace here or a
        // co-owner's first approval would leave the namespace in review forever.
        await tx.users.update({
          where: { namespace: row.namespace },
          data: { has_published: true },
        });
        // The publish charged the unminified build; a smaller approved blob
        // hands the difference back to the account's quota.
        if (stored && Number(row.blob_size) > stored.size) {
          const refund = Number(row.blob_size) - stored.size;
          await tx.$executeRaw`
            UPDATE users SET blob_bytes = GREATEST(blob_bytes - ${refund}, 0)
            WHERE namespace = ${row.namespace}
          `;
        }
        await notifyUser(
          tx,
          row.owner_id,
          'review.approved',
          reviewApprovedMessage(row.namespace, row.extension_id, row.version),
          { namespace: row.namespace, id: row.extension_id, version: row.version },
        );
        await audit(tx, req.auth.user, 'version.approve', { namespace, id, version: row.version });
      }
      return rows[0];
    };

    // The shared blob-gc lock is only needed when a new digest is written; the
    // no-minify path takes a plain transaction.
    const updated = shrunk
      ? await withLocks(db, [{ key: BLOB_GC_LOCK_KEY, shared: true }], promote)
      : await db.$transaction(promote);
    if (!updated) {
      throw conflict('That version is no longer pending review.');
    }
    // The unminified digest is no longer referenced once this row points at the
    // minified one, so sweep the old file. A sibling version sharing the
    // original bytes keeps it (see removeBlobIfUnused).
    if (shrunk && row.blob_digest) {
      try {
        await removeBlobIfUnused(db, config, row.blob_digest, null);
      } catch {
        // The approval is committed. A leftover unminified blob is harmless.
      }
    }
    void webhooks.scheduleFor(namespace, id, 'version.published', {
      version: updated.version,
      occurredAt: new Date().toISOString(),
      actor: req.auth.user.namespace,
    });
    res.json(
      versionToObject(
        updated,
        config,
        await versionDownloads(db, updated.namespace, updated.extension_id, updated.version),
      ),
    );
  }

  router.patch('/@:namespace/:id/versions/:version', requireAuth, termsGate, async (req, res) => {
    requireObjectBody(req);
    const { status, deprecationMessage } = req.body;
    const reviewing = status !== undefined;
    if (reviewing === (deprecationMessage !== undefined)) {
      throw fieldErrors([
        {
          field: 'status',
          message:
            'Provide "status" to review or "deprecationMessage" to deprecate, not both or neither.',
        },
      ]);
    }

    if (reviewing) return reviewVersion(req, res, status);

    const message = deprecationMessage;
    // An explicit null clears the notice and puts the version back, anything
    // else has to be a real string. Omitting it once fell through and
    // deprecated with a NULL notice.
    if (message !== null && (typeof message !== 'string' || message.trim().length === 0)) {
      throw fieldErrors([
        { field: 'deprecationMessage', message: 'Must be a non-empty string, or null to clear.' },
      ]);
    }
    return deprecateVersion(req, res, message);
  });

  router.delete('/@:namespace/:id/versions/:version', yankChain, async (req, res) => {
    const { namespace, id } = req.params;
    if (!isValidNamespace(namespace) || !isValidExtensionId(id)) throw notFound();
    const row = await resolveVersion(req.params);
    if (row.status !== 'published' && row.status !== 'deprecated') throw notFound();
    if (!(await isExtensionOwner(req.auth.user, namespace, id))) {
      throw forbidden('You can only yank your own extensions.');
    }
    await db.versions.updateMany({ where: { id: row.id }, data: { status: 'yanked' } });
    auditSoon(db, req.auth.user, 'version.yank', { namespace, id, version: row.version });
    void webhooks.scheduleFor(namespace, id, 'version.yanked', {
      version: row.version,
      occurredAt: new Date().toISOString(),
      actor: req.auth.user.namespace,
    });
    res.status(204).end();
  });

  router.get('/@:namespace/:id/versions/:version/download', async (req, res, next) => {
    try {
      await rateLimiter.downloadCheck(`download:${req.ip}`)();
    } catch (error) {
      return next(error);
    }
    const { namespace, id } = req.params;
    if (!isValidNamespace(namespace) || !isValidExtensionId(id)) throw notFound();
    if (await redirectIfMoved(req, res, `/versions/${req.params.version}/download`)) return;
    const row = await resolveVersion(req.params);
    const isPublished =
      row.status === 'published' || row.status === 'yanked' || row.status === 'deprecated';
    if (!isPublished && !(row.status === 'pending' && isAdmin(req.auth))) throw notFound();
    const abs = row.blob_digest
      ? blobPathFor(config.dataDir, row.blob_digest)
      : path.join(config.dataDir, row.blob_path);
    if (existsSync(abs)) {
      res.type('application/javascript');
      res.sendFile(abs);
      // Metrics never get in the way of a download, so a failure here costs the
      // event, not the blob.
      const ipHash = await hashDownloadAddress(db, config, req.ip).catch(() => null);
      void db.download_events
        .create({
          data: {
            namespace: row.namespace,
            extension_id: row.extension_id,
            version: row.version,
            user_agent: String(req.headers['user-agent'] ?? '').slice(0, 250),
            ip_hash: ipHash,
          },
        })
        .catch(() => {});
    } else {
      throw notFound('Compiled output is missing.');
    }
  });

  router.get(
    '/@:namespace/:id/versions/:version/source',
    requireAuth,
    termsGate,
    async (req, res) => {
      const { namespace, id } = req.params;
      if (!isValidNamespace(namespace) || !isValidExtensionId(id)) throw notFound();
      if (!(await isExtensionOwner(req.auth.user, namespace, id))) {
        throw notFound('Only an owner or an admin can fetch the source.');
      }
      if (!req.auth.scopes.includes('read:source')) {
        throw forbidden('This token is missing the required "read:source" scope.');
      }
      const row = await resolveVersion(req.params);
      if (!row.source_path || !row.source_digest) {
        throw notFound('Source is unavailable for this version.');
      }
      const abs = sourcePathFor(config.dataDir, row.source_digest);
      if (!existsSync(abs)) throw notFound('Source is missing.');
      res.type('application/gzip');
      res.set('Content-Disposition', `attachment; filename="${id}-${row.version}.tgz"`);
      res.sendFile(abs);
    },
  );

  router.get('/@:namespace/:id/owners', async (req, res) => {
    const { namespace, id } = req.params;
    if (!isValidNamespace(namespace) || !isValidExtensionId(id)) throw notFound();
    if (!(await extensionExists(namespace, id))) throw notFound();
    // A two-table join whose output is the response body, kept raw.
    const rows = await db.$queryRaw`
      SELECT u.namespace, u.display_name, u.role, u.kind, u.created_at, o.added_at
      FROM extension_owners o
      JOIN users u ON u.id = o.owner_id
      WHERE o.namespace = ${namespace} AND o.extension_id = ${id}
      ORDER BY o.added_at
    `;
    res.json({ data: rows });
  });

  // Invitations addressed to the caller: their own, plus any held by an
  // organization they own. An organization cannot sign in, so an account acting
  // for one needs to see what is waiting on the organization, not only what is
  // waiting on them.
  router.get('/@:namespace/:id/owners/pending', requireAuth, async (req, res) => {
    const { namespace, id } = req.params;
    if (!isValidNamespace(namespace) || !isValidExtensionId(id)) throw notFound();
    const organizations = await organizationsOwnedBy(db, req.auth.user);
    const rows = await db.$queryRaw`
      SELECT u.namespace, u.display_name, u.kind, i.created_at,
        a.namespace AS invited_by_namespace
      FROM extension_owner_invites i
      JOIN users u ON u.id = i.owner_id
      LEFT JOIN users a ON a.id = i.invited_by
      WHERE i.namespace = ${namespace} AND i.extension_id = ${id}
        AND (
          i.owner_id = ${req.auth.user.id}
          OR u.namespace = ANY (${organizations}::text[])
        )
      ORDER BY i.created_at
    `;
    res.json({
      data: rows.map((row) => ({
        namespace: row.namespace,
        display_name: row.display_name,
        kind: row.kind,
        created_at: row.created_at.toISOString(),
        invited_by: row.invited_by_namespace,
      })),
    });
  });

  router.put('/@:namespace/:id/owners/:ownerNamespace', ownerChain, async (req, res) => {
    const { namespace: targetNamespace, id, ownerNamespace: candidate } = req.params;
    if (
      req.auth.user.namespace !== targetNamespace &&
      req.auth.user.role !== 'admin' &&
      !(await isOrganizationOwner(db, req.auth.user, targetNamespace))
    ) {
      throw forbidden('Only an existing owner or an admin can add owners.');
    }
    if (
      !isValidNamespace(targetNamespace) ||
      !isValidNamespace(candidate) ||
      !isValidExtensionId(id)
    ) {
      throw notFound();
    }
    const existing = await db.versions.findFirst({
      where: { namespace: targetNamespace, extension_id: id, status: { not: 'rejected' } },
      select: { id: true },
    });
    if (!existing) throw notFound();
    if (candidate === targetNamespace) {
      throw fieldErrors([
        { field: 'namespace', message: 'The namespace account already owns this extension.' },
      ]);
    }
    const candidateUser = await db.users.findUnique({ where: { namespace: candidate } });
    if (!candidateUser) throw notFound('No such account to invite.');
    const alreadyOwner = await db.extension_owners.findFirst({
      where: { namespace: targetNamespace, extension_id: id, owner_id: candidateUser.id },
      select: { owner_id: true },
    });
    if (alreadyOwner) {
      // Nothing to invite, and clearing a leftover invitation keeps the two from
      // disagreeing about whether it took.
      await db.extension_owner_invites.deleteMany({
        where: { namespace: targetNamespace, extension_id: id, owner_id: candidateUser.id },
      });
      res.status(204).end();
      return;
    }
    // An invitation is idempotent rather than an error, so a retried request does
    // not need to know whether the first attempt landed.
    const invited = await db.$transaction(async (tx) => {
      const { count } = await tx.extension_owner_invites.createMany({
        data: [
          {
            namespace: targetNamespace,
            extension_id: id,
            owner_id: candidateUser.id,
            invited_by: req.auth.user.id,
          },
        ],
        skipDuplicates: true,
      });
      if (count > 0) {
        await notifyOwnerCandidate(
          tx,
          candidateUser,
          'extension.owner.invited',
          invitedAsOwnerMessage(req.auth.user.namespace, targetNamespace, id),
          { namespace: targetNamespace, id },
        );
        await audit(
          tx,
          req.auth.user,
          'owner.invite',
          { namespace: targetNamespace, id },
          { invited: candidateUser.namespace },
        );
      }
      return count > 0;
    });
    if (invited) {
      void webhooks.scheduleFor(targetNamespace, id, 'owners.invited', {
        actor: req.auth.user.namespace,
        invited: candidateUser.namespace,
        occurredAt: new Date().toISOString(),
      });
    }
    res.status(204).end();
  });

  // The second step of the grant. An account accepts its own invitation; an
  // organization holds no session, so any of the accounts on its owner list can
  // accept, and one of them accepting speaks for the rest.
  router.post(
    '/@:namespace/:id/owners/:ownerNamespace/accept',
    requireAuth,
    termsGate,
    async (req, res) => {
      const { namespace: targetNamespace, id, ownerNamespace: candidate } = req.params;
      if (
        !isValidNamespace(targetNamespace) ||
        !isValidNamespace(candidate) ||
        !isValidExtensionId(id)
      ) {
        throw notFound();
      }
      const [invite] = await db.$queryRaw`
          SELECT i.owner_id, u.kind
          FROM extension_owner_invites i
          JOIN users u ON u.id = i.owner_id
          WHERE i.namespace = ${targetNamespace} AND i.extension_id = ${id}
            AND u.namespace = ${candidate}
        `;
      if (!invite) throw notFound('There is no pending invitation to accept.');
      const mine = invite.owner_id === req.auth.user.id;
      if (!mine && invite.kind !== 'organization') {
        throw forbidden('Only the invited account can accept this invitation.');
      }
      if (!mine && !(await isOrganizationOwner(db, req.auth.user, candidate))) {
        throw forbidden('Only an owner of the invited organization can accept this invitation.');
      }
      await db.$transaction(async (tx) => {
        const { count: claimed } = await tx.extension_owner_invites.deleteMany({
          where: { namespace: targetNamespace, extension_id: id, owner_id: invite.owner_id },
        });
        if (claimed === 0) throw notFound('There is no pending invitation to accept.');
        await tx.extension_owners.createMany({
          data: [
            {
              owner_id: invite.owner_id,
              namespace: targetNamespace,
              extension_id: id,
              added_by: req.auth.user.id,
            },
          ],
          skipDuplicates: true,
        });
        // The account that accepted knows already; the partners on an
        // organization's owner list do not, so they are the ones told.
        if (invite.kind === 'organization') {
          const partners = await tx.organization_owners.findMany({
            where: { org_id: invite.owner_id, user_id: { not: req.auth.user.id } },
            select: { user_id: true },
          });
          for (const row of partners) {
            await notifyUser(
              tx,
              row.user_id,
              'extension.owner.added',
              addedAsOwnerMessage(req.auth.user.namespace, targetNamespace, id),
              { namespace: targetNamespace, id },
            );
          }
        }
        await audit(
          tx,
          req.auth.user,
          'owner.accept',
          { namespace: targetNamespace, id },
          { added: candidate },
        );
      });
      void webhooks.scheduleFor(targetNamespace, id, 'owners.changed', {
        actor: req.auth.user.namespace,
        added: candidate,
        occurredAt: new Date().toISOString(),
      });
      res.json({ data: { namespace: targetNamespace, id, owner: candidate } });
    },
  );

  router.delete('/@:namespace/:id/owners/:ownerNamespace', ownerChain, async (req, res) => {
    const { namespace: targetNamespace, id, ownerNamespace: target } = req.params;
    if (
      !isValidNamespace(targetNamespace) ||
      !isValidNamespace(target) ||
      !isValidExtensionId(id)
    ) {
      throw notFound();
    }
    if (
      req.auth.user.namespace !== targetNamespace &&
      req.auth.user.role !== 'admin' &&
      !(await isOrganizationOwner(db, req.auth.user, targetNamespace))
    ) {
      throw forbidden('Only an owner or an admin can remove owners.');
    }
    const account = await db.versions.findFirst({
      where: { namespace: targetNamespace, extension_id: id, status: { not: 'rejected' } },
      select: { id: true },
    });
    if (!account) throw notFound();
    if (target === targetNamespace) {
      throw fieldErrors([
        {
          field: 'namespace',
          message: 'The namespace account owns the published address and cannot be removed.',
        },
      ]);
    }
    const candidateUser = await db.users.findUnique({ where: { namespace: target } });
    if (!candidateUser) throw notFound('No such account.');

    // Withdrawing an invitation and removing a grant are one request from the
    // namespace account's side, and the invitation is looked for first so that
    // reporting which of the two happened is not a guess.
    const withdrawn = await db.$transaction(async (tx) => {
      const { count } = await tx.extension_owner_invites.deleteMany({
        where: {
          owner_id: candidateUser.id,
          namespace: targetNamespace,
          extension_id: id,
        },
      });
      if (count > 0) {
        await notifyOwnerCandidate(
          tx,
          candidateUser,
          'extension.owner.withdrawn',
          withdrawnAsOwnerMessage(req.auth.user.namespace, targetNamespace, id),
          { namespace: targetNamespace, id },
        );
        await audit(
          tx,
          req.auth.user,
          'owner.withdraw',
          { namespace: targetNamespace, id },
          { withdrawn: candidateUser.namespace },
        );
      }
      return count > 0;
    });
    if (withdrawn) {
      void webhooks.scheduleFor(targetNamespace, id, 'owners.invited', {
        actor: req.auth.user.namespace,
        withdrawn: target,
        occurredAt: new Date().toISOString(),
      });
      res.status(204).end();
      return;
    }

    const deleted = await db.$transaction(async (tx) => {
      const { count } = await tx.extension_owners.deleteMany({
        where: { owner_id: candidateUser.id, namespace: targetNamespace, extension_id: id },
      });
      if (count > 0) {
        await notifyOwnerCandidate(
          tx,
          candidateUser,
          'extension.owner.removed',
          removedAsOwnerMessage(req.auth.user.namespace, targetNamespace, id),
          { namespace: targetNamespace, id },
        );
        await audit(
          tx,
          req.auth.user,
          'owner.remove',
          { namespace: targetNamespace, id },
          { removed: candidateUser.namespace },
        );
      }
      return count > 0;
    });
    if (!deleted) throw notFound('That account is not an owner.');
    void webhooks.scheduleFor(targetNamespace, id, 'owners.changed', {
      actor: req.auth.user.namespace,
      removed: target,
      occurredAt: new Date().toISOString(),
    });
    res.status(204).end();
  });

  // Offering an extension to another namespace. Two steps, like an owner grant
  // and for the same reason: the recipient is the one whose name ends up on the
  // address and whose quota pays for it, so it is the one that agrees. Until it
  // does, nothing about @namespace/id has changed and the recipient cannot even
  // see the offer unless it asks.
  router.post('/@:namespace/:id/transfers', ownerChain, async (req, res) => {
    const { namespace: from, id } = req.params;
    if (!isValidNamespace(from) || !isValidExtensionId(id)) throw notFound();
    requireObjectBody(req);
    const to = req.body.to;
    if (!isValidNamespace(to)) {
      throw fieldErrors([{ field: 'to', message: 'Must be a valid namespace.' }]);
    }
    if (to === from) {
      throw fieldErrors([
        { field: 'to', message: 'An extension cannot be transferred to itself.' },
      ]);
    }
    if (!(await mayOfferTransfer(db, req.auth.user, from))) {
      throw forbidden('Only the namespace account or an admin can transfer an extension away.');
    }
    const recipient = await loadTransferRecipient(db, to);
    if (!recipient) throw notFound('No such account to transfer to.');
    if (recipient.kind === 'organization' && !(await hasOrgOwner(db, recipient.id))) {
      throw conflict('An organization with no owners cannot receive an extension.');
    }
    await db.$transaction(async (tx) => {
      await openTransfer(tx, {
        config,
        actor: req.auth.user,
        namespace: from,
        id,
        toNamespace: to,
        recipient,
      });
    });
    res.status(201).json({ data: { namespace: from, id, to } });
  });

  // What has been offered at this address that the caller can answer for.
  router.get('/@:namespace/:id/transfers', requireAuth, async (req, res) => {
    const { namespace, id } = req.params;
    if (!isValidNamespace(namespace) || !isValidExtensionId(id)) throw notFound();
    res.json({ data: await pendingTransfersFor(db, req.auth.user, namespace, id) });
  });

  // The recipient accepts, and the move happens. Same transaction as the audit
  // entry, the notification and the redirect row, so a transfer either lands
  // whole or not at all.
  router.post(
    '/@:namespace/:id/transfers/:toNamespace/accept',
    requireAuth,
    termsGate,
    async (req, res) => {
      const { namespace: from, id, toNamespace: to } = req.params;
      if (!isValidNamespace(from) || !isValidNamespace(to) || !isValidExtensionId(id)) {
        throw notFound();
      }
      const recipient = await loadTransferRecipient(db, to);
      if (!recipient) throw notFound();
      if (!(await mayReceiveTransfer(db, req.auth.user, to))) {
        throw forbidden('Only the receiving namespace or an admin can accept this transfer.');
      }
      const moved = await db.$transaction(async (tx) => {
        return await acceptTransfer(tx, {
          config,
          actor: req.auth.user,
          namespace: from,
          id,
          toNamespace: to,
          recipient,
        });
      });
      // Fired against the new address: the webhooks moved with the extension, and
      // a subscriber that wanted to hear about this extension is now the new
      // owner's.
      void webhooks.scheduleFor(to, id, 'extension.transferred', {
        actor: req.auth.user.namespace,
        from,
        to,
        id,
        occurredAt: new Date().toISOString(),
      });
      res.json({ data: { namespace: to, id, from, versions: moved.versions } });
    },
  );

  router.delete('/@:namespace/:id/transfers/:toNamespace', ownerChain, async (req, res) => {
    const { namespace: from, id, toNamespace: to } = req.params;
    if (!isValidNamespace(from) || !isValidNamespace(to) || !isValidExtensionId(id)) {
      throw notFound();
    }
    if (!(await mayOfferTransfer(db, req.auth.user, from))) {
      throw forbidden('Only the namespace account or an admin can withdraw a transfer.');
    }
    const recipient = await loadTransferRecipient(db, to);
    if (!recipient) throw notFound();
    await db.$transaction(async (tx) => {
      await withdrawTransfer(tx, {
        actor: req.auth.user,
        namespace: from,
        id,
        toNamespace: to,
        recipient,
      });
    });
    res.status(204).end();
  });

  router.get('/@:namespace/:id', async (req, res) => {
    const { namespace, id } = req.params;
    if (!isValidNamespace(namespace) || !isValidExtensionId(id)) throw notFound();
    if (await redirectIfMoved(req, res)) return;
    const rows = await db.versions.findMany({
      where: { namespace, extension_id: id, status: { in: ['published', 'deprecated'] } },
      orderBy: [{ created_at: 'desc' }],
    });
    if (rows.length === 0) throw notFound();
    const versions = [...rows].sort((a, b) => compareSemver(b.version, a.version));
    const top = versions.find((row) => row.status === 'published') ?? versions[0];
    const totals = await versionDownloadTotals(db, namespace, id);
    const summary = extensionDetailFromRow(
      top,
      versions.map((row) => versionToObject(row, config, totals.get(row.version) ?? 0n)),
    );
    summary.downloads = await totalDownloads(db, namespace, id);
    res.json(summary);
  });

  router.delete('/@:namespace/:id', ownerChain, async (req, res) => {
    const { namespace, id } = req.params;
    if (!isValidNamespace(namespace) || !isValidExtensionId(id)) throw notFound();
    const lockKey = `${namespace}/${id}`;
    // The per-extension lock is the same one publishVersion uses. The delete
    // commits its row changes first, then the filesystem cleanup reacquires this
    // lock (and the GC lock) so a concurrent publish cannot reuse a blob path
    // and have its freshly written bytes removed by a cleanup that is still
    // running. The keeper check in the cleanup has to see the committed delete,
    // which is why it runs after the transaction rather than inside it.
    const { rows, charged } = await withLocks(db, [lockKey, BLOB_GC_LOCK_KEY], async (tx) => {
      if (!(await isExtensionOwner(req.auth.user, namespace, id))) {
        throw forbidden('You can only delete your own extensions.');
      }
      const found = await tx.versions.findMany({
        where: { namespace, extension_id: id },
        select: {
          blob_digest: true,
          blob_path: true,
          status: true,
          blob_size: true,
          source_digest: true,
          source_size: true,
        },
      });
      if (found.length === 0) throw notFound();
      if (found.some((row) => row.status === 'staging')) {
        throw conflict('A publish is in progress for this extension.');
      }
      await tx.versions.deleteMany({ where: { namespace, extension_id: id } });
      // An invitation to manage an extension that no longer exists can never
      // be accepted, and the extension_owners rows survive on purpose, so
      // these have to be cleared here rather than left for a cascade.
      await tx.extension_owner_invites.deleteMany({ where: { namespace, extension_id: id } });
      await tx.extension_transfers.deleteMany({ where: { namespace, extension_id: id } });
      // Refund the account's quota for every byte this extension charged.
      const total = found.reduce(
        (sum, row) => sum + Number(row.blob_size ?? 0) + Number(row.source_size ?? 0),
        0,
      );
      if (total > 0) {
        const account = await tx.users.findUnique({
          where: { namespace },
          select: { id: true },
        });
        if (account) {
          await tx.$executeRaw`
              UPDATE users SET blob_bytes = GREATEST(blob_bytes - ${total}, 0)
              WHERE id = ${account.id}
            `;
        }
      }
      // The filesystem cleanup is deliberately not part of this transaction: it
      // can be slow, and unlinking before the commit would remove a file a later
      // rollback still needs. Hand the digests back and clean up once this has
      // committed, under the same locks.
      return { rows: found, charged: total };
    });
    // Reacquired after the commit, so the keeper check sees this delete: a digest
    // another version still references is kept, and holding the address lock
    // keeps a concurrent publish from reusing a path this cleanup removes.
    try {
      await withLocks(db, [lockKey, BLOB_GC_LOCK_KEY], async (tx) => {
        for (const version of rows) {
          if (version.blob_digest) {
            await removeBlobIfUnusedInTx(tx, config, version.blob_digest, null);
          } else if (version.blob_path) {
            await rm(path.join(config.dataDir, version.blob_path), { force: true });
          }
        }
        const dedupedSources = new Set(rows.map((row) => row.source_digest).filter(Boolean));
        for (const digest of dedupedSources) {
          await removeSourceIfUnusedInTx(tx, config, digest);
        }
      });
    } catch (error) {
      // A cleanup failure costs disk, not correctness: the boot-time sweep in
      // db.js collects whatever is left unreferenced.
      console.error(`blob cleanup deferred for ${namespace}/${id}: ${error.message}`);
    }
    auditSoon(
      db,
      req.auth.user,
      'extension.delete',
      { namespace, id },
      {
        versions: rows.length,
        bytesRefunded: charged,
      },
    );
    res.status(204).end();
  });

  return router;
}

async function publishVersion(
  db,
  config,
  owner,
  { id, manifest, code, sourceBuffer, buildLog, warnings = [], stagedBy },
) {
  const version = normalizeSemver(manifest.version);
  const name = typeof manifest.name === 'string' && manifest.name.length > 0 ? manifest.name : id;
  const codeBuffer = code;
  const charge = codeBuffer.length + sourceBuffer.length;
  const digest = sha256Hex(codeBuffer);
  const sha512 = sha512Base64(codeBuffer);
  const blobRelative = path.join('blobs', digest.slice(0, 2), digest.slice(2));
  const tmpDir = path.join(config.dataDir, 'tmp');
  await mkdir(tmpDir, { recursive: true });
  const tmpPath = path.join(tmpDir, `upload-${randomBytes(8).toString('hex')}.tmp`);
  const lockKey = `${owner.namespace}/${id}`;
  const credentialOwner = stagedBy ?? owner;

  const searchText = buildSearchText({
    name,
    id,
    namespace: owner.namespace,
    description: manifest.description,
  });

  const finalStatus = owner.has_published ? 'published' : 'pending';

  try {
    await writeFile(tmpPath, codeBuffer);

    // The source tarball is only stored once the uniqueness checks commit, so
    // a lower/duplicate publish never leaves an orphaned source file.
    let staged;
    await withLocks(db, [lockKey], async (tx) => {
      // Serialize per namespace/extension so concurrent publishes cannot both
      // validate against the same ceiling snapshot.
      if (await redirectFor(tx, owner.namespace, id)) {
        throw conflict('This extension address has been transferred away.');
      }

      const pending = await tx.versions.findFirst({
        where: { owner_id: credentialOwner.id, status: { in: ['staging', 'pending'] } },
        select: { id: true },
      });
      if (pending) {
        throw forbidden('The owner already has a version awaiting review.');
      }

      const existing = await tx.versions.findMany({
        where: { namespace: owner.namespace, extension_id: id },
        select: { version: true },
      });
      const ceiling = maxVersionBySemver(existing.map((row) => row.version));
      if (ceiling && !semver.gt(version, ceiling)) {
        throw new HttpError(422, {
          detail: `Version ${version} is not strictly greater than the current highest version (${ceiling}).`,
        });
      }

      const recorded = await tx.versions.create({
        data: {
          owner_id: credentialOwner.id,
          namespace: owner.namespace,
          extension_id: id,
          version,
          status: 'staging',
          name,
          license: manifest.license,
          description: manifest.description,
          author: manifest.author ?? null,
          color1: manifest.color1 ?? null,
          color2: manifest.color2 ?? null,
          color3: manifest.color3 ?? null,
          is_unsandboxed: manifest.isUnsandboxed ?? null,
          blob_path: blobRelative,
          blob_digest: digest,
          blob_size: codeBuffer.length,
          blob_sha512: sha512,
          search_text: searchText,
          source_size: sourceBuffer.length,
          build_log: buildLog,
          warnings,
        },
      });
      await tx.extension_owners.createMany({
        data: [
          { owner_id: owner.id, namespace: owner.namespace, extension_id: id, added_by: owner.id },
        ],
        skipDuplicates: true,
      });
      // Charge the blob and source bytes to the namespace account. Identical
      // content is re-charged per version row; deleting a version refunds it.
      // The route's quota check read the balance before the build, and the
      // advisory lock above only covers this extension, so the balance is
      // re-read under a row lock: publishes to sibling extensions queue here
      // instead of both charging against the same ceiling.
      const [account] = await tx.$queryRaw`
        SELECT blob_bytes, max_blob_bytes FROM users WHERE id = ${owner.id} FOR UPDATE
      `;
      if (account) {
        const accountQuota =
          account.max_blob_bytes ?? config.limits?.maxAccountBlobBytes ?? 64 * 1024 * 1024;
        if (Number(account.blob_bytes ?? 0) + charge > accountQuota) {
          throw new HttpError(413, {
            title: 'Payload Too Large',
            detail: `Publishing ${charge} bytes would exceed the ${accountQuota}-byte storage quota for @${owner.namespace}.`,
          });
        }
      }
      await tx.users.update({
        where: { id: owner.id },
        data: { blob_bytes: { increment: charge } },
      });
      staged = recorded;
    });

    // The staging row commits before either artifact is placed: uniqueness
    // checks in the transaction reject duplicate/lower-version publishes, so
    // only the committed version may write its blob and source. A crash before
    // they are placed leaves a staging row that reconcileOnBoot promotes once
    // both exist or removes when either is missing.
    await withLocks(db, [{ key: BLOB_GC_LOCK_KEY, shared: true }], async (tx) => {
      // GC holds the exclusive lock; publishers share it until the source
      // digest commits, so cleanup cannot unlink a source another publish is
      // about to reference.
      const stored = await storeSource(config.dataDir, sourceBuffer);
      await tx.versions.update({
        where: { id: staged.id },
        data: { source_path: stored.path, source_digest: stored.digest },
      });
    });
    const row = await withLocks(db, [{ key: BLOB_GC_LOCK_KEY, shared: true }], async (tx) => {
      // GC holds the exclusive lock; publishers share it through promotion.
      await storeBlob(config.dataDir, tmpPath, codeBuffer);
      const promoted = await tx.versions.update({
        where: { id: staged.id },
        data: {
          status: finalStatus,
          published_at: finalStatus === 'published' ? new Date() : null,
        },
      });
      // The audit commits with the promotion so a pending publish is never
      // recorded until it sticks, and the write can never race a reset.
      await audit(
        tx,
        stagedBy,
        'version.publish',
        { namespace: owner.namespace, id, version: staged.version },
        {
          status: finalStatus,
          bytes: codeBuffer.length,
          sourceBytes: sourceBuffer.length,
        },
      );
      return promoted;
    });
    if (!row) {
      throw new HttpError(409, { detail: 'Version row disappeared before promotion.' });
    }
    return row;
  } catch (error) {
    const violation = uniqueViolation(error);
    if (violation) {
      if (violation.constraint === 'versions_one_pending_idx') {
        throw forbidden('The owner already has a version awaiting review.');
      }
      throw new HttpError(409, { detail: `Version ${version} already exists for this extension.` });
    }
    throw error;
  } finally {
    // The upload file is only needed until storeBlob copies it into place;
    // drop it on success and failure alike so publishes leave no uncharged
    // compiled copy behind.
    await rm(tmpPath, { force: true });
  }
}
