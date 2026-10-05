import { normalizeApiRoot } from './util.js';

// An uploaded image is reported as this account's own canonical URL so every
// consumer -- the web UI, an extension fetching a profile, anything that only
// reads the serialized user -- resolves it without knowing that uploads exist.
//
// It is absolute, and built from publicBaseUrl and the configured api root the
// same way downloadUrl is, for the same reason: the web client is usually served
// from a different origin than the API, often behind a path the instance cannot
// see, so a relative path here is resolved against the web origin and points at
// nothing. A hardcoded "/v1" would also break a deployment that mounts the API
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
  const collection = row.kind === 'organization' ? 'orgs' : 'users';
  const base = `${config.publicBaseUrl.replace(/\/$/, '')}${root ? `/${root}` : ''}/${collection}/${row.namespace}/${kind}`;
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
  const digest = kind === 'avatar' ? row.avatar_blob_digest : row.banner_blob_digest;
  if (digest) return profileImagePath(config, row, kind, digest);
  const external = kind === 'avatar' ? row.avatar_url : row.banner_url;
  return external ?? null;
}

export function userToObject(row, config) {
  return {
    namespace: row.namespace,
    displayName: row.display_name,
    kind: row.kind ?? 'user',
    role: row.role,
    hasPublished: row.has_published,
    bio: row.bio ?? '',
    website: row.website ?? null,
    github: row.github ?? null,
    avatarUrl: profileImageUrl(row, 'avatar', config),
    bannerUrl: profileImageUrl(row, 'banner', config),
    createdAt: row.created_at.toISOString(),
    termsAcceptedVersion: row.terms_accepted_version ?? null,
  };
}

// The same row as an account, minus what does not apply: an organization has no
// role, no terms of its own, and no password, and pretending otherwise on a
// public profile would invite a client to offer controls that lead nowhere.
export function organizationToObject(row, config) {
  const root = normalizeApiRoot(config.apiRoot);
  const base = `${root ? `/${root}` : ''}/orgs/${encodeURIComponent(row.namespace)}`;
  return {
    namespace: row.namespace,
    displayName: row.display_name,
    bio: row.bio ?? '',
    website: row.website ?? null,
    github: row.github ?? null,
    avatarUrl: profileImageUrl(row, 'avatar', config),
    bannerUrl: profileImageUrl(row, 'banner', config),
    createdAt: row.created_at.toISOString(),
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
    id: String(row.id),
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    lastUsedAt: row.last_used_at ? row.last_used_at.toISOString() : null,
  };
}

export function automationTokenToObject(row) {
  return {
    id: String(row.id),
    name: row.name,
    scopes: row.scopes,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
    lastUsedAt: row.last_used_at ? row.last_used_at.toISOString() : null,
  };
}

export function notificationToObject(row) {
  return {
    id: String(row.id),
    kind: row.kind,
    message: row.message,
    payload: row.payload,
    read: row.read_at !== null,
    createdAt: row.created_at.toISOString(),
  };
}

export function legalDocumentToObject(row) {
  return {
    version: row.version,
    body: row.body,
    updatedAt: row.updated_at.toISOString(),
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
  const extension = `${base}/@${row.namespace}/${row.extension_id}`;
  const links = {
    self: `${extension}/versions/${encodeURIComponent(row.version)}`,
    extension,
    author: `${base}/users/${encodeURIComponent(row.namespace)}`,
  };
  if (row.status === 'published' || row.status === 'yanked' || row.status === 'deprecated') {
    links.download = downloadUrl(config, row.namespace, row.extension_id, row.version);
  }
  // Only a version the server still holds the source tarball for can be asked
  // for one.
  if (row.source_path)
    links.source = sourceUrl(config, row.namespace, row.extension_id, row.version);
  return links;
}

export function versionToObject(row, config) {
  const out = {
    namespace: row.namespace,
    id: row.extension_id,
    version: row.version,
    status: row.status,
    name: row.name,
    license: row.license,
    description: row.description,
    createdAt: row.created_at.toISOString(),
  };
  if (row.author) out.author = row.author;
  if (row.published_at) out.publishedAt = row.published_at.toISOString();
  if (row.status === 'deprecated') {
    out.deprecation = row.deprecation_message ?? null;
  }
  if (row.status === 'published' || row.status === 'yanked' || row.status === 'deprecated') {
    const dist = {
      downloadUrl: downloadUrl(config, row.namespace, row.extension_id, row.version),
    };
    if (row.blob_digest) {
      dist.digest = `sha256:${row.blob_digest}`;
      if (row.blob_sha512) dist.integrity = `sha512-${row.blob_sha512}`;
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
    namespace: row.namespace,
    id: row.extension_id,
    name: row.name,
    version: row.version,
    description: row.description,
    publishedAt: row.published_at.toISOString(),
  };
}

export function extensionDetailFromRow(row, versions) {
  return {
    ...extensionSummaryFromRow(row),
    author: row.author ?? '',
    license: row.license,
    color1: row.color1 ?? null,
    color2: row.color2 ?? null,
    color3: row.color3 ?? null,
    versions,
  };
}

export function pendingVersionToObject(row, config) {
  const out = {
    ...versionToObject(row, config),
    ownerNamespace: row.namespace,
  };
  if (row.build_log) out.buildLog = row.build_log;
  if (row.build_error) out.buildError = row.build_error;
  if (row.source_path)
    out.sourceUrl = sourceUrl(config, row.namespace, row.extension_id, row.version);
  return out;
}
