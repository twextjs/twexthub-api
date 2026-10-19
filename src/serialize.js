import { normalizeApiRoot } from './util.js';

// An uploaded image is reported as this account's own canonical URL so every
// consumer -- the web UI, an extension fetching a profile, anything that only
// reads the serialized user -- resolves it without knowing that uploads exist.
//
// It is absolute, and built from publicBaseUrl and the configured api root the
// same way downloadUrl is, for the same reason: the web client is usually served
// from a different origin than the API, often behind a path the instance cannot
// see, so a relative path here is resolved against the web origin and points at
// nothing. A hardcoded root would also break a deployment that mounts the API
// elsewhere.
// The published URL carries the digest so that the URL names the exact bytes.
// Without it the path is the same before and after a re-upload, which makes a
// one-year immutable cache a lie: a reader would keep the old picture. A short
// prefix is enough to separate two different images and keeps the URL short.
//
// An organization is a row of the same table but has its own collection, so its
// images are published under /orgs rather than /users.
function profileImagePath(config, row, kind, digest) {
  const root = normalizeApiRoot(config.apiRoot);
  const collection = row.Kind === 'organization' ? 'orgs' : 'users';
  const base = `${config.publicBaseUrl.replace(/\/$/, '')}${root ? `/${root}` : ''}/${collection}/${row.Namespace}/${kind}`;
  return digest ? `${base}?v=${digest.slice(0, 16)}` : base;
}

// An account can hold an upload and a URL at once, and the upload is what the
// instance serves. A URL is the fallback, kept so that removing an upload does
// not leave the account with no image, and it is also the pointer a consumer can
// read to find the original file the account linked to.
// The image actually served for a profile: the upload if there is one, the
// external link otherwise, and null when the profile has neither. Exported
// because an organization's owner list shows each owner's avatar without
// serializing a whole account row.
export function profileImageUrl(row, kind, config) {
  const digest = kind === 'avatar' ? row.AvatarBlobDigest : row.BannerBlobDigest;
  if (digest) return profileImagePath(config, row, kind, digest);
  const external = kind === 'avatar' ? row.AvatarUrl : row.BannerUrl;
  return external ?? null;
}

export function userToObject(row, config) {
  return {
    namespace: row.Namespace,
    displayName: row.DisplayName,
    kind: row.Kind ?? 'user',
    role: row.Role,
    hasPublished: row.HasPublished,
    bio: row.Bio ?? '',
    website: row.Website ?? null,
    github: row.Github ?? null,
    avatarUrl: profileImageUrl(row, 'avatar', config),
    bannerUrl: profileImageUrl(row, 'banner', config),
    createdAt: row.CreatedAt.toISOString(),
    termsAcceptedVersion: row.TermsAcceptedVersion ?? null,
  };
}

// The same row as an account, minus what does not apply: an organization has no
// role, no terms of its own, and no password, and pretending otherwise on a
// public profile would invite a client to offer controls that lead nowhere.
export function organizationToObject(row, config) {
  const root = normalizeApiRoot(config.apiRoot);
  const base = `${root ? `/${root}` : ''}/orgs/${encodeURIComponent(row.Namespace)}`;
  return {
    namespace: row.Namespace,
    displayName: row.DisplayName,
    bio: row.Bio ?? '',
    website: row.Website ?? null,
    github: row.Github ?? null,
    avatarUrl: profileImageUrl(row, 'avatar', config),
    bannerUrl: profileImageUrl(row, 'banner', config),
    createdAt: row.CreatedAt.toISOString(),
    _links: {
      self: base,
      extensions: `${base}/extensions`,
      owners: `${base}/owners`,
      avatar: `${base}/avatar`,
      banner: `${base}/banner`,
    },
  };
}
export function sessionToObject(row) {
  return {
    id: String(row.Id),
    createdAt: row.CreatedAt.toISOString(),
    expiresAt: row.ExpiresAt.toISOString(),
    lastUsedAt: row.LastUsedAt ? row.LastUsedAt.toISOString() : null,
  };
}

export function automationTokenToObject(row) {
  return {
    id: String(row.Id),
    name: row.Name,
    scopes: row.Scopes,
    createdAt: row.CreatedAt.toISOString(),
    expiresAt: row.ExpiresAt ? row.ExpiresAt.toISOString() : null,
    lastUsedAt: row.LastUsedAt ? row.LastUsedAt.toISOString() : null,
  };
}

export function notificationToObject(row) {
  return {
    id: String(row.Id),
    kind: row.Kind,
    message: row.Message,
    payload: row.Payload,
    read: row.ReadAt !== null,
    createdAt: row.CreatedAt.toISOString(),
  };
}

export function legalDocumentToObject(row) {
  return {
    version: row.Version,
    body: row.Body,
    updatedAt: row.UpdatedAt.toISOString(),
  };
}

// The pages a version is reachable through, so a client holding one version
// does not have to know the shape of the paths to it. `self` and `extension`
// are relative to the API root like the collection links in a paginated body;
// `download` and `source` are absolute because they are served from
// publicBaseUrl, which need not be this server.
function versionLinks(config, row) {
  const root = normalizeApiRoot(config.apiRoot);
  const base = root ? `/${root}` : '';
  const extension = `${base}/@${row.Namespace}/${row.ExtensionId}`;
  const links = {
    self: `${extension}/versions/${encodeURIComponent(row.Version)}`,
    extension,
    author: `${base}/users/${encodeURIComponent(row.Namespace)}`,
  };
  if (row.Status === 'published' || row.Status === 'yanked' || row.Status === 'deprecated') {
    links.download = downloadUrl(config, row.Namespace, row.ExtensionId, row.Version);
  }
  // Only a version the server still holds the source tarball for can be asked
  // for one.
  if (row.SourcePath)
    links.source = sourceUrl(config, row.Namespace, row.ExtensionId, row.Version);
  return links;
}

export function versionToObject(row, config, downloads = 0) {
  const out = {
    namespace: row.Namespace,
    id: row.ExtensionId,
    version: row.Version,
    status: row.Status,
    name: row.Name,
    license: row.License,
    description: row.Description,
    createdAt: row.CreatedAt.toISOString(),
    downloads: Number(downloads),
  };
  if (row.Author) out.author = row.Author;
  if (row.PublishedAt) out.publishedAt = row.PublishedAt.toISOString();
  if (Array.isArray(row.Warnings) && row.Warnings.length > 0) out.warnings = row.Warnings;
  if (row.Status === 'deprecated') {
    out.deprecation = row.DeprecationMessage ?? null;
  }
  if (row.Status === 'rejected') {
    out.rejectionReason = row.RejectionReason ?? null;
  }
  if (row.Status === 'published' || row.Status === 'yanked' || row.Status === 'deprecated') {
    const dist = {
      downloadUrl: downloadUrl(config, row.Namespace, row.ExtensionId, row.Version),
    };
    if (row.BlobDigest) {
      dist.digest = `sha256:${row.BlobDigest}`;
      if (row.BlobSha512) dist.integrity = `sha512-${row.BlobSha512}`;
    }
    out.dist = dist;
  }
  out._links = versionLinks(config, row);
  return out;
}

export function downloadUrl(config, namespace, id, version) {
  const apiRoot = normalizeApiRoot(config.apiRoot);
  const root = apiRoot ? `/${apiRoot}` : '';
  return `${config.publicBaseUrl.replace(/\/$/, '')}${root}/@${namespace}/${id}/versions/${version}/download`;
}

export function sourceUrl(config, namespace, id, version) {
  const apiRoot = normalizeApiRoot(config.apiRoot);
  const root = apiRoot ? `/${apiRoot}` : '';
  return `${config.publicBaseUrl.replace(/\/$/, '')}${root}/@${namespace}/${id}/versions/${version}/source`;
}

export function extensionSummaryFromRow(row) {
  return {
    namespace: row.Namespace,
    id: row.ExtensionId,
    name: row.Name,
    version: row.Version,
    description: row.Description,
    publishedAt: row.PublishedAt.toISOString(),
  };
}

export function extensionDetailFromRow(row, versions) {
  return {
    ...extensionSummaryFromRow(row),
    author: row.Author ?? '',
    license: row.License,
    isUnsandboxed: row.IsUnsandboxed ?? null,
    color1: row.Color1 ?? null,
    color2: row.Color2 ?? null,
    color3: row.Color3 ?? null,
    versions,
  };
}

export function pendingVersionToObject(row, config) {
  const out = {
    ...versionToObject(row, config),
    ownerNamespace: row.Namespace,
  };
  if (row.BuildLog) out.buildLog = row.BuildLog;
  if (row.BuildError) out.buildError = row.BuildError;
  if (row.SourcePath)
    out.sourceUrl = sourceUrl(config, row.Namespace, row.ExtensionId, row.Version);
  return out;
}
