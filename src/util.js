import semver from 'semver';

export const NAMESPACE_PATTERN = '^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$';
export const EXTENSION_ID_PATTERN = '^[a-z0-9]{1,64}$';
export const COLOR_PATTERN = '^#[0-9a-fA-F]{6}$';

export const namespacePattern = new RegExp(NAMESPACE_PATTERN);
export const extensionIdPattern = new RegExp(EXTENSION_ID_PATTERN);
export const colorPattern = new RegExp(COLOR_PATTERN);

export function isValidNamespace(value) {
  return typeof value === 'string' && namespacePattern.test(value);
}

export function isValidExtensionId(value) {
  return typeof value === 'string' && extensionIdPattern.test(value);
}

export function normalizeSemver(value) {
  return typeof value === 'string' ? semver.valid(value) : null;
}

export function compareSemver(a, b) {
  return semver.compare(a, b);
}

export function maxVersionBySemver(versions) {
  let max = null;
  for (const version of versions) {
    if (!semver.valid(version)) continue;
    if (max === null || semver.gt(version, max)) max = version;
  }
  return max;
}

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Query parameters and route parameters arrive as strings under normal
// routing, but a crafted query can surface arrays or objects. Returning a
// non-string as null keeps downstream string operations on verified values.
export function asString(value) {
  return typeof value === 'string' ? value : null;
}

// "v0", "/v0", "/v0/" all mean the same thing; "''" or "/" means "no prefix".
export function normalizeApiRoot(value) {
  if (value === undefined || value === null) return 'v0';
  return String(value).replace(/^\/+|\/+$/g, '');
}

export function foldText(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

export function buildSearchText({ name, id, namespace, description }) {
  return foldText([name, id, namespace, description].join(' '));
}
