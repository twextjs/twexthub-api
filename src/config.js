import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { product } from './product.js';
import { normalizeApiRoot } from './util.js';

export const DEFAULTS = {
  port: 3000,
  dataDir: './data',
  apiRoot: product.defaults?.apiRoot ?? '/v0',
  publicBaseUrl: 'http://localhost:3000',
  requireHttps: false,
  trustProxy: false,
  database: {
    url: null,
    maxConnections: 10,
    connectTimeoutSeconds: 30,
    idleTimeoutSeconds: 60,
  },
  auth: {
    sessionTtlDays: 7,
    scrypt: { N: 16384, r: 8, p: 1 },
  },
  rateLimits: {
    loginAttemptsPerWindow: 5,
    loginWindowMinutes: 15,
    signupsPerIpPerWindow: 5,
    signupWindowMinutes: 15,
    publishPerWindow: 30,
    publishWindowMinutes: 60,
    downloadsPerIpPerWindow: 240,
    downloadWindowMinutes: 5,
    routesPerIpPerWindow: 600,
    routeWindowMinutes: 15,
  },
  pagination: {
    defaultLimit: 20,
    maxLimit: 50,
  },
  limits: {
    maxBlobBytes: 2 * 1024 * 1024,
    maxAccountBlobBytes: 64 * 1024 * 1024,
    maxSourceBytes: 1024 * 1024,
    maxProfileImageBytes: 2 * 1024 * 1024,
  },
  compiler: {
    command: null,
    timeoutMs: 30_000,
    memoryMb: 192,
    addressSpaceMb: 1536,
  },
  logging: {
    requests: false,
  },
  cors: {
    allowedOrigins: '*',
  },
};

// The buckets that a null switches off entirely, and the only keys for which a
// null is a value rather than the absence of one. An environment variable is a
// string, so "off" (or "null") is how an operator spells it there; no other key
// may use those spellings, or a mistyped port or quota would become null instead
// of failing startup.
const NULLABLE_KEYS = new Set([
  'rateLimits.publishPerWindow',
  'rateLimits.downloadsPerIpPerWindow',
]);

// Merge the config file over the defaults. `path` is the dotted key the value
// came from, because an explicit null means "off" for the two nullable buckets
// and "not set" for everything else: keeping the default when a file says
// `publishPerWindow: null` would silently leave the bucket on, which is the one
// thing that line is there to do.
function mergeDeep(base, override, path = '') {
  if (override === undefined) return base;
  if (override === null) return NULLABLE_KEYS.has(path) ? null : base;
  if (Array.isArray(base)) return override;
  if (typeof base === 'object' && base !== null) {
    const out = structuredClone(base);
    for (const [key, value] of Object.entries(override)) {
      if (value !== undefined)
        out[key] = mergeDeep(base[key], value, path ? `${path}.${key}` : key);
    }
    return out;
  }
  return override;
}

const ENV_OVERRIDES = [
  ['port', 'TWEXTHUB_PORT'],
  ['dataDir', 'TWEXTHUB_DATA_DIR'],
  ['apiRoot', 'TWEXTHUB_API_ROOT'],
  ['publicBaseUrl', 'TWEXTHUB_PUBLIC_BASE_URL'],
  ['requireHttps', 'TWEXTHUB_REQUIRE_HTTPS'],
  ['trustProxy', 'TWEXTHUB_TRUST_PROXY'],
  ['database.url', 'TWEXTHUB_DATABASE_URL'],
  ['database.maxConnections', 'TWEXTHUB_DATABASE_MAX_CONNECTIONS'],
  ['auth.sessionTtlDays', 'TWEXTHUB_SESSION_TTL_DAYS'],
  ['rateLimits.loginAttemptsPerWindow', 'TWEXTHUB_LOGIN_ATTEMPTS_PER_WINDOW'],
  ['rateLimits.loginWindowMinutes', 'TWEXTHUB_LOGIN_WINDOW_MINUTES'],
  ['rateLimits.signupsPerIpPerWindow', 'TWEXTHUB_SIGNUPS_PER_IP_PER_WINDOW'],
  ['rateLimits.signupWindowMinutes', 'TWEXTHUB_SIGNUP_WINDOW_MINUTES'],
  ['rateLimits.publishPerWindow', 'TWEXTHUB_PUBLISH_PER_WINDOW'],
  ['rateLimits.publishWindowMinutes', 'TWEXTHUB_PUBLISH_WINDOW_MINUTES'],
  ['rateLimits.downloadsPerIpPerWindow', 'TWEXTHUB_DOWNLOADS_PER_IP_PER_WINDOW'],
  ['rateLimits.downloadWindowMinutes', 'TWEXTHUB_DOWNLOAD_WINDOW_MINUTES'],
  ['rateLimits.routesPerIpPerWindow', 'TWEXTHUB_ROUTES_PER_IP_PER_WINDOW'],
  ['rateLimits.routeWindowMinutes', 'TWEXTHUB_ROUTE_WINDOW_MINUTES'],
  ['pagination.defaultLimit', 'TWEXTHUB_PAGINATION_DEFAULT_LIMIT'],
  ['pagination.maxLimit', 'TWEXTHUB_PAGINATION_MAX_LIMIT'],
  ['limits.maxBlobBytes', 'TWEXTHUB_MAX_BLOB_BYTES'],
  ['limits.maxAccountBlobBytes', 'TWEXTHUB_MAX_ACCOUNT_BLOB_BYTES'],
  ['limits.maxSourceBytes', 'TWEXTHUB_MAX_SOURCE_BYTES'],
  ['limits.maxProfileImageBytes', 'TWEXTHUB_MAX_PROFILE_IMAGE_BYTES'],
  ['compiler.command', 'TWEXTHUB_COMPILER'],
  ['compiler.timeoutMs', 'TWEXTHUB_COMPILER_TIMEOUT_MS'],
  ['compiler.memoryMb', 'TWEXTHUB_COMPILER_MEMORY_MB'],
  ['compiler.addressSpaceMb', 'TWEXTHUB_COMPILER_ADDRESS_SPACE_MB'],
  ['logging.requests', 'TWEXTHUB_LOG_REQUESTS'],
  ['cors.allowedOrigins', 'TWEXTHUB_CORS_ALLOWED_ORIGINS'],
];

// `fallback` is the DEFAULTS value for the key, not whatever YAML merged in: the
// coercion each value goes through is the one its default type calls for.
function coerceEnvValue(raw, fallback, envName, key) {
  if (NULLABLE_KEYS.has(key) && (raw === 'off' || raw === 'null')) return null;
  if (typeof fallback === 'boolean') {
    if (raw === 'true' || raw === '1') return true;
    if (raw === 'false' || raw === '0') return false;
    throw new Error(`${envName} must be "true" or "false" (got "${raw}")`);
  }
  if (typeof fallback === 'number') {
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`${envName} must be a positive integer (got "${raw}")`);
    }
    return n;
  }
  return raw;
}

function coerceTrustProxy(raw) {
  if (raw === 'true') return true;
  if (raw === 'false' || raw === '0') return false;
  if (/^[1-9]\d*$/.test(raw)) return Number(raw);
  return raw;
}

function coerceAllowedOrigins(raw) {
  if (raw === '*') return '*';
  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function applyEnvOverrides(config) {
  for (const [key, envName] of ENV_OVERRIDES) {
    const raw = process.env[envName];
    if (raw === undefined) continue;
    const parts = key.split('.');
    const target = parts.slice(0, -1).reduce((acc, part) => acc[part], config);
    const last = parts[parts.length - 1];
    if (key === 'trustProxy') {
      target[last] = coerceTrustProxy(raw);
      continue;
    }
    if (key === 'cors.allowedOrigins') {
      target[last] = coerceAllowedOrigins(raw);
      continue;
    }
    target[last] = coerceEnvValue(
      raw,
      parts.reduce((acc, part) => acc[part], DEFAULTS),
      envName,
      key,
    );
  }
}

export function loadConfig(configPath = product.defaults?.configFilename ?? 'config.yaml') {
  let raw = {};
  if (existsSync(configPath)) {
    const parsed = YAML.parse(readFileSync(configPath, 'utf8'));
    if (parsed && typeof parsed === 'object') raw = parsed;
  }
  const config = mergeDeep(DEFAULTS, raw);
  applyEnvOverrides(config);
  config.apiRoot = normalizeApiRoot(config.apiRoot);
  if (!config.database.url) {
    throw new Error(
      `database.url is required (set it in ${configPath}, pass a file via --config, or set TWEXTHUB_DATABASE_URL)`,
    );
  }
  config.dataDir = path.resolve(process.cwd(), config.dataDir);
  // Recorded so the admin configuration endpoints can edit the same file this
  // instance was started from, rather than guessing at a name.
  config.configPath = path.resolve(configPath);
  return config;
}
