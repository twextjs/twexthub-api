import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import request from 'supertest';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { bootstrap } from '../src/server.js';
import { createTarballBuffer } from '../src/tarball.js';
import { DEFAULTS } from '../src/config.js';

export const TEST_DATABASE_URL =
  process.env.TWEXTHUB_TEST_DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/twexthub_test';

let cached = null;
let seq = 0;

export function uniqNs() {
  seq += 1;
  return 'ns' + seq + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// Deep-merges `overrides` over a base, one section at a time, so a test can
// override a single bucket (`signupsPerIpPerWindow: 10_000`) or a single limit
// without re-spelling its whole section. A null merges as a value, not a
// section: `publishPerWindow: null` means "off", and replacing an entire object
// (`database: {...}`) still works because the override replaces the leaf.
function mergeOverrides(base, overrides) {
  if (overrides === undefined) return base;
  if (
    overrides === null ||
    typeof overrides !== 'object' ||
    Array.isArray(overrides) ||
    base === null ||
    typeof base !== 'object' ||
    Array.isArray(base)
  ) {
    return overrides;
  }
  const out = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    out[key] = mergeOverrides(out[key], value);
  }
  return out;
}

export function makeConfig(overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'twexthub-test-'));
  // Built over the production DEFAULTS rather than restated key by key, so the
  // suite exercises what an instance actually ships with and a key the server
  // gains cannot be missing here. The keys a test config must pin for its own
  // sake — a fast scrypt, a short-lived database pool — are the overrides
  // below. This also fixes what the guard in makeHttpRateLimiter surfaced:
  // routeWindowMinutes used to be undefined at the coarse limiter (NaN window,
  // one validation error logged per app booted) because this literal had never
  // spelled the coarse-limiter keys out.
  const config = mergeOverrides(structuredClone(DEFAULTS), {
    port: 0,
    dataDir,
    apiRoot: '/v1',
    publicBaseUrl: 'http://hub.test:8080',
    requireHttps: false,
    trustProxy: false,
    database: { url: TEST_DATABASE_URL, maxConnections: 6 },
    // scrypt at production cost would dominate the suite's runtime.
    auth: { scrypt: { N: 16384, r: 8, p: 1 } },
    cors: { allowedOrigins: '*' },
  });
  return mergeOverrides(config, overrides);
}

// postgres.js connects lazily, so a database that is not there does not fail
// until bootstrap's first query, as a bare driver error. The two ways that
// usually happens are worth instructions rather than a stack trace: the server
// is not running, or the database has not been created. Everything else — bad
// password, deadlocked migration — is left exactly as the driver reported it.
const CONNECTION_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET']);

// The connection-check fallback interpolates the URL into its message, so
// strip the password first: a database URL pasted into the environment should
// not print its credentials into the test output. A URL that will not parse is
// shown as it is -- there is nothing in it to extract.
function redactDatabaseUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.password = '';
    return parsed.toString();
  } catch {
    return url;
  }
}

function describeBootFailure(error, url) {
  const shown = (() => {
    try {
      const parsed = new URL(url);
      parsed.password = '';
      return parsed.toString();
    } catch {
      return 'the URL in TWEXTHUB_TEST_DATABASE_URL';
    }
  })();
  const database = (() => {
    try {
      return new URL(url).pathname.slice(1);
    } catch {
      return 'twexthub_test';
    }
  })();

  if (error?.code === '3D000') {
    return (
      `the test database "${database}" does not exist.\n\n` +
      '`npm run test:setup` starts the test Postgres and creates it.'
    );
  }
  // The driver wraps its connect errors; the code and message worth showing can
  // sit one or two `cause`s down, and the top-level message can be empty.
  const chain = [];
  for (let e = error; e; e = e.cause) {
    chain.push(e);
    if (chain.length > 5) break;
  }
  const connectCode = chain.map((e) => e?.code).find((code) => CONNECTION_CODES.has(code));
  if (connectCode) {
    const detail = chain.map((e) => e?.message).find(Boolean) ?? connectCode;
    return (
      `the test database at ${shown} is not reachable (${detail}).\n\n` +
      '`npm test` needs the Postgres container CI runs — `npm run test:setup`\n' +
      'starts it. If your database lives elsewhere, point\n' +
      'TWEXTHUB_TEST_DATABASE_URL at it.'
    );
  }
  return null;
}

// One connection attempt, classified by describeBootFailure. `npm test` runs
// this before the suite (see test/preflight.mjs) so a missing database is one
// clear message and a stop, rather than every test file failing on its own
// boot() with the same hint 200-odd times. boot() keeps its own rewrite as the
// fallback for files run directly, which skip the preflight.
export async function checkTestDatabase(url = TEST_DATABASE_URL) {
  const probe = postgres(url, { max: 1, connect_timeout: 5, idle_timeout: 1 });
  try {
    await probe`SELECT 1`;
  } catch (error) {
    const hint =
      describeBootFailure(error, url) ??
      `the test database at ${redactDatabaseUrl(url)} rejected the connection check.`;
    throw new Error(hint, { cause: error });
  } finally {
    await probe.end({ timeout: 5 });
  }
}

export async function boot(overrides = {}, appOptions = {}) {
  if (cached) {
    if (Object.keys(overrides).length > 0) {
      throw new Error(
        'boot() was already called; overrides are ignored. Use a separate test file.',
      );
    }
    return cached;
  }
  const config = makeConfig(overrides);
  let booted;
  try {
    booted = await bootstrap(config, { backgroundJobs: false, ...appOptions });
  } catch (error) {
    const hint = describeBootFailure(error, config.database.url);
    if (!hint) throw error;
    throw new Error(hint, { cause: error });
  }
  cached = booted;
  return cached;
}

export async function resetDb() {
  const { sql } = await boot();
  await sql.unsafe(`
    TRUNCATE TABLE automation_tokens, sessions, versions, rate_limit_entries, notifications,
    users, legal_documents, download_events, extension_daily_downloads, dist_tags,
    webhook_deliveries, webhooks
    RESTART IDENTITY CASCADE
  `);
  await sql`
    INSERT INTO legal_documents (kind, version, body)
    VALUES ('terms', 1, 'Placeholder terms.'), ('privacy', 1, 'Placeholder privacy.')
  `;
}

// Walk a collection the way a client that has never seen this API would: hand
// each response's own `next` link straight back until it stops offering one.
// `pages` is here so a caller can assert on the shape of the pages themselves,
// not only on everything they add up to.
export async function followPages(app, startUrl, headers = {}) {
  const rows = [];
  const pages = [];
  let url = startUrl;
  while (url) {
    const r = await request(app).get(url).set(headers).expect(200);
    rows.push(...r.body.data);
    pages.push(r.body);
    url = r.body._links.next;
    if (pages.length > 200) throw new Error('pagination did not terminate');
  }
  return { rows, pages };
}

export function bearer(token) {
  return { Authorization: 'Bearer ' + token };
}

// The fixture password is a passphrase rather than something spelled like a
// password: CodeQL reads a password-shaped signup response as a password, and
// that taint then follows the account's namespace into test webhook payloads.
export const FIXTURE_PASSWORD = 'correct-horse-battery-staple';

export async function signup(app, namespace, password = FIXTURE_PASSWORD, displayName = namespace) {
  return request(app).post('/v1/users').send({ namespace, password, displayName });
}

export async function acceptTerms(app, namespace, token) {
  const terms = await request(app).get('/v1/terms').expect(200);
  const accepted = await request(app)
    .patch(`/v1/users/${namespace}`)
    .set(bearer(token))
    .send({ termsAcceptedVersion: String(terms.body.version) });
  assert.equal(accepted.status, 200, `terms accept failed: ${JSON.stringify(accepted.body)}`);
  return accepted.body;
}

export async function signupAndAccept(app, namespace, password = FIXTURE_PASSWORD) {
  const r = await signup(app, namespace, password);
  assert.equal(r.status, 201, `signup failed: ${JSON.stringify(r.body)}`);
  await acceptTerms(app, namespace, r.body.token);
  return r.body;
}

export const signupAccept = signupAndAccept;

export async function approveVersion(app, adminToken, ns, id, version) {
  const r = await request(app)
    .patch(`/v1/@${ns}/${id}/versions/${version}`)
    .set(bearer(adminToken))
    .send({ status: 'approved' });
  assert.equal(r.status, 200, `approve failed: ${JSON.stringify(r.body)}`);
  return r;
}

function scalar(value) {
  const s = String(value ?? '');
  if (/^[a-zA-Z][a-zA-Z0-9 _./[\](),;:'"-]*$/.test(s)) return s;
  return JSON.stringify(s);
}

// Builds a minimal but valid twext project and returns its gzipped tarball.
// opts maps to twext.yml fields: id, name, version, description, author,
// license, color1/color2/color3, blockType, blockText, entryPoint. The `code`
// option is embedded verbatim as the body of the project's single handler.
export async function projectTarball(opts = {}) {
  const id = opts.id ?? 'hello';
  const version = opts.version ?? '1.0.0';
  const description = opts.description ?? 'A test extension.';
  const author = opts.author ?? 'Test Author';
  const license = opts.license ?? 'MIT';
  const blockType = opts.blockType ?? 'command';
  const blockText = opts.blockText ?? 'hello';
  const entryPoint = opts.entryPoint ?? 'src/index.js';
  const code = opts.code ?? '// default';
  // The opcode declared in twext.yml. When it differs from the exported
  // handler name ("hello"), the compiler fails: no handler for the opcode.
  const opcode = opts.opcode ?? 'hello';

  const yml =
    [
      `entryPoint: ${scalar(entryPoint)}`,
      `name: ${scalar(opts.name ?? id)}`,
      `version: ${scalar(version)}`,
      `description: ${scalar(description)}`,
      `author: ${scalar(author)}`,
      `license: ${scalar(license)}`,
      `extension:`,
      `  id: ${scalar(id)}`,
      `  name: ${scalar(opts.extensionName ?? opts.name ?? id)}`,
      `  color1: ${scalar(opts.color1 ?? '#ff8800')}`,
      `  color2: ${scalar(opts.color2 ?? '#ffffff')}`,
      `  color3: ${scalar(opts.color3 ?? '#000000')}`,
      `blocks:`,
      `  - opcode: ${scalar(opcode)}`,
      `    blockType: ${scalar(blockType)}`,
      `    text: ${scalar(blockText)}`,
    ].join('\n') + '\n';

  const entry =
    `export const blocks = {\n` +
    `  hello(args, util) {\n` +
    `${code
      .split('\n')
      .map((line) => (line.length > 0 ? `    ${line}` : line))
      .join('\n')}\n` +
    `  },\n` +
    `};\n`;

  const dir = await mkdtemp(path.join(os.tmpdir(), 'twexthub-proj-'));
  try {
    await writeFile(path.join(dir, 'twext.yml'), yml);
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: id, version, type: 'module', private: true }),
    );
    await mkdir(path.join(dir, path.dirname(entryPoint)), { recursive: true });
    await writeFile(path.join(dir, entryPoint), entry);
    return await createTarballBuffer(dir, ['twext.yml', 'package.json', entryPoint]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function listTarballFiles(dir, root) {
  const entries = await readdir(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    if (entry.name === 'dist' || entry.name === 'node_modules') continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listTarballFiles(abs, root)));
    } else {
      out.push(path.relative(root, abs));
    }
  }
  return out;
}

export async function tarballFromDir(dir) {
  return createTarballBuffer(dir, await listTarballFiles(dir, dir));
}

// Publishes the default project as `@ns/id` with the given project opts. Returns
// the response (asserting `status`, default 201).
export async function publishProject(app, ns, id, token, opts = {}, status = 201) {
  const buffer = await projectTarball({ id, ...opts });
  return request(app)
    .post(`/v1/@${ns}/${id}/versions`)
    .set(bearer(token))
    .set('Content-Type', 'application/gzip')
    .expect(status)
    .send(buffer);
}
