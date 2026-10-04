import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { dirname } from 'node:path';
import request from 'supertest';
import {
  applyServerConfig,
  configStorage,
  editableSettings,
  EDITABLE_SETTINGS,
} from '../src/server-config.js';
import { boot, bearer, resetDb, signupAndAccept, uniqNs } from './helpers.mjs';

let app;
let sql;
let config;
let configFile;
let originalConfigPath;

const CONFIG_YAML = `# Instance settings. Keep this file: it is mounted, not baked in.
port: 3000
publicBaseUrl: http://localhost:3000
limits:
  maxSourceBytes: 1048576
`;

// Mount tables are written by hand rather than read, so the test does not depend
// on where the checkout happens to live or on whether the host has /tmp mounted.
// A single mount at the root is what a container's own writable layer looks like
// from inside; the second table adds a bind mount over the temp directory, which
// is what an operator mounting the config into a volume gets.
const CONTAINER_MOUNT = '1 0 0:1 / / rw,relatime - overlay overlay rw\n';
const volumeMount = (dir) => `${CONTAINER_MOUNT}2 0 0:2 / ${dir} rw,relatime - ext4 /dev/sda1 rw\n`;

before(async () => {
  configFile = path.join(mkdtempSync(path.join(tmpdir(), 'twexthub-config-')), 'config.yaml');
  // The HTTP config tests go through the route, which asks configStorage about
  // the real filesystem. Left to itself the answer depends on where the suite
  // happens to run: inside a container the temp directory sits on the root
  // overlay, and the route then answers 409 to a change that is safe to make
  // here. A bind mount over the temp directory is what an operator mounting
  // the config into a volume gets, so the probe says that instead of reading
  // the host's mount table.
  ({ app, sql, config } = await boot(
    {},
    { storageProbe: { mountInfo: volumeMount(dirname(configFile)), container: true } },
  ));
  writeFileSync(configFile, CONFIG_YAML, 'utf8');
  originalConfigPath = config.configPath;
  config.configPath = configFile;
});
beforeEach(async () => {
  await resetDb();
  writeFileSync(configFile, CONFIG_YAML, 'utf8');
  config.pagination.defaultLimit = 20;
  config.pagination.maxLimit = 50;
});
after(async () => {
  config.configPath = originalConfigPath;
  await sql.end();
});

async function admin() {
  const account = await signupAndAccept(app, uniqNs());
  await sql`UPDATE users SET role = 'admin' WHERE namespace = ${account.user.namespace}`;
  return account;
}

// The first account on a fresh instance is made an admin, so a test that wants
// an ordinary account says so rather than depending on the signup order.
async function ordinary() {
  const account = await signupAndAccept(app, uniqNs());
  await sql`UPDATE users SET role = 'normal' WHERE namespace = ${account.user.namespace}`;
  return account;
}

describe('configStorage', () => {
  test('calls a file under the root mount read-only inside a container', () => {
    const storage = configStorage(configFile, { mountInfo: CONTAINER_MOUNT, container: true });
    assert.equal(storage.writable, true);
    assert.equal(storage.persistent, false);
    assert.match(storage.reason, /volume/i);
  });

  test('accepts a file on the host filesystem, which a recreate does not discard', () => {
    // A host install writing to its own root filesystem keeps the file, so
    // refusing the change there would refuse one that is safe to make.
    const storage = configStorage(configFile, { mountInfo: CONTAINER_MOUNT, container: false });
    assert.equal(storage.persistent, true);
    assert.equal(storage.reason, null);
  });

  test('calls a file under a bind mount persistent', () => {
    const storage = configStorage(configFile, {
      mountInfo: volumeMount(dirname(configFile)),
      container: true,
    });
    assert.equal(storage.writable, true);
    assert.equal(storage.persistent, true);
    assert.equal(storage.reason, null);
  });

  test('reports a missing or unwritable file as read-only', () => {
    const storage = configStorage('/nonexistent/twexthub/config.yaml', {
      mountInfo: volumeMount(dirname(configFile)),
      container: true,
    });
    assert.equal(storage.writable, false);
    assert.equal(storage.persistent, false);
    assert.match(storage.reason, /not writable/i);
  });
});

describe('applyServerConfig', () => {
  test('refuses to write a config that would not survive a restart', () => {
    assert.throws(
      () =>
        applyServerConfig({
          config,
          configPath: configFile,
          patch: { 'pagination.defaultLimit': 10 },
          mountInfo: CONTAINER_MOUNT,
          container: true,
        }),
      (err) => err.status === 409 && /volume/i.test(err.detail),
    );
    assert.match(readFileSync(configFile, 'utf8'), /maxSourceBytes: 1048576/);
  });

  test('edits the file without disturbing the comments around it', () => {
    const result = applyServerConfig({
      config,
      configPath: configFile,
      patch: { 'pagination.defaultLimit': 25 },
      mountInfo: volumeMount(dirname(configFile)),
      container: true,
    });
    assert.deepEqual(result.changes['pagination.defaultLimit'], { before: 20, after: 25 });
    const written = readFileSync(configFile, 'utf8');
    assert.match(written, /^# Instance settings\./m);
    assert.match(written, /maxSourceBytes: 1048576/);
    assert.match(written, /defaultLimit: 25/);
  });

  test('applies a hot setting to the running config', () => {
    applyServerConfig({
      config,
      configPath: configFile,
      patch: { 'pagination.maxLimit': 120 },
      mountInfo: volumeMount(dirname(configFile)),
      container: true,
    });
    assert.equal(config.pagination.maxLimit, 120);
  });

  test('reports a setting that is already at that value as no change', () => {
    const result = applyServerConfig({
      config,
      configPath: configFile,
      patch: { 'pagination.defaultLimit': 20 },
      mountInfo: volumeMount(dirname(configFile)),
      container: true,
    });
    assert.deepEqual(result.changes, {});
  });

  test('rejects a value outside the allowed range without writing', () => {
    assert.throws(
      () =>
        applyServerConfig({
          config,
          configPath: configFile,
          patch: { 'pagination.maxLimit': 100000 },
          mountInfo: volumeMount(dirname(configFile)),
          container: true,
        }),
      (err) => err.status === 422 && err.errors[0].field === 'pagination.maxLimit',
    );
    assert.doesNotMatch(readFileSync(configFile, 'utf8'), /maxLimit/);
  });

  test('rejects a base URL that is not one', () => {
    assert.throws(
      () =>
        applyServerConfig({
          config,
          configPath: configFile,
          patch: { publicBaseUrl: 'not a url' },
          mountInfo: volumeMount(dirname(configFile)),
          container: true,
        }),
      (err) => err.status === 422 && err.errors[0].field === 'publicBaseUrl',
    );
  });

  // A null would pass the form's own type check and then reach consumers that
  // read the key as the type the form advertises.
  test('rejects a null setting', () => {
    const rejects = (patch) =>
      assert.throws(
        () =>
          applyServerConfig({
            config,
            configPath: configFile,
            patch,
            mountInfo: volumeMount(dirname(configFile)),
            container: true,
          }),
        (err) => err.status === 422 && /value is required/i.test(err.errors[0].message),
      );
    rejects({ publicBaseUrl: null });
    rejects({ 'pagination.maxLimit': null });
    rejects({ 'logging.requests': null });
    rejects({ 'cors.allowedOrigins': null });
  });

  test('leaves the running config alone when a null is rejected', () => {
    const before = config.publicBaseUrl;
    assert.throws(() =>
      applyServerConfig({
        config,
        configPath: configFile,
        patch: { publicBaseUrl: null, 'pagination.defaultLimit': 30 },
        mountInfo: volumeMount(dirname(configFile)),
        container: true,
      }),
    );
    assert.equal(config.publicBaseUrl, before);
    assert.equal(config.pagination.defaultLimit, 20);
  });

  // The list is matched against the Origin header, so anything that does not
  // serialize to exactly one origin is a value that can never match.
  test('rejects an allowed origin that is not exactly an origin', () => {
    const rejects = (value) =>
      assert.throws(
        () =>
          applyServerConfig({
            config,
            configPath: configFile,
            patch: { 'cors.allowedOrigins': value },
            mountInfo: volumeMount(dirname(configFile)),
            container: true,
          }),
        (err) => err.status === 422 && /absolute origin/i.test(err.errors[0].message),
      );
    rejects('not a url');
    rejects('https://a.example/x');
    rejects('https://a.example?q=1');
    rejects('https://a.example:443');
    rejects('data:text/plain,hi');
    rejects('https://ok.example,not a url');
  });

  test('accepts a plain origin, with or without a trailing slash', () => {
    for (const [value, stored] of [
      ['https://a.example', ['https://a.example']],
      // The Origin header carries no trailing slash, so the stored value is the
      // serialized form: that is the string makeCors compares against.
      ['https://b.example/', ['https://b.example']],
      ['http://localhost:3000', ['http://localhost:3000']],
    ]) {
      const result = applyServerConfig({
        config,
        configPath: configFile,
        patch: { 'cors.allowedOrigins': value },
        mountInfo: volumeMount(dirname(configFile)),
        container: true,
      });
      assert.deepEqual(result.changes['cors.allowedOrigins'].after, stored);
    }
  });

  test('collects every bad field rather than stopping at the first', () => {
    try {
      applyServerConfig({
        config,
        configPath: configFile,
        patch: { 'pagination.maxLimit': 0, 'compiler.memoryMb': 0 },
        mountInfo: volumeMount(dirname(configFile)),
        container: true,
      });
      assert.fail('expected a validation error');
    } catch (err) {
      assert.equal(err.status, 422);
      assert.deepEqual(err.errors.map((e) => e.field).sort(), [
        'compiler.memoryMb',
        'pagination.maxLimit',
      ]);
    }
  });
});

describe('editable settings', () => {
  test('never offers the settings that would stop the instance answering', () => {
    const keys = EDITABLE_SETTINGS.map((setting) => setting.key);
    for (const denied of ['database.url', 'apiRoot', 'port', 'dataDir', 'compiler.command']) {
      assert.ok(!keys.includes(denied), `${denied} must not be editable`);
    }
  });

  test('reports the current value of each setting', () => {
    const settings = editableSettings(config);
    const limit = settings.find((s) => s.key === 'limits.maxProfileImageBytes');
    assert.equal(limit.type, 'bytes');
    assert.equal(limit.min, 1024);
    // The harness boots without a limits block, so a setting the config never
    // set reads as unset rather than as a default the operator cannot see.
    assert.equal(limit.value, config.limits?.maxProfileImageBytes ?? null);

    const pageSize = settings.find((s) => s.key === 'pagination.maxLimit');
    assert.equal(pageSize.value, config.pagination.maxLimit);
  });

  test('describes every setting with a label and a type', () => {
    for (const setting of editableSettings(config)) {
      assert.ok(setting.label, `${setting.key} needs a label`);
      assert.ok(setting.type, `${setting.key} needs a type`);
      assert.equal(typeof setting.restartRequired, 'boolean');
    }
  });

  // A setting the running process copies while it starts cannot take effect
  // until the instance restarts, so saying otherwise is how an admin saves a
  // value and watches the old one keep being enforced.
  test('calls a setting hot only when its value is read per request', () => {
    const restart = EDITABLE_SETTINGS.filter((s) => s.restartRequired)
      .map((s) => s.key)
      .sort();
    assert.deepEqual(restart, [
      'auth.sessionTtlDays',
      'cors.allowedOrigins',
      'limits.maxSourceBytes',
      'logging.requests',
    ]);
    // publicBaseUrl, the limits, pagination, and the compiler settings are all
    // read as each operation runs, so all of them stay hot.
    for (const key of [
      'publicBaseUrl',
      'pagination.defaultLimit',
      'pagination.maxLimit',
      'limits.maxBlobBytes',
      'limits.maxAccountBlobBytes',
      'limits.maxProfileImageBytes',
      'compiler.timeoutMs',
      'compiler.memoryMb',
      'compiler.addressSpaceMb',
    ]) {
      assert.equal(
        EDITABLE_SETTINGS.find((s) => s.key === key).restartRequired,
        false,
        `${key} is read per request and should not claim a restart`,
      );
    }
  });
});

describe('GET /admin/config', () => {
  test('refuses an unauthenticated caller', async () => {
    await request(app).get('/v1/admin/config').expect(401);
  });

  test('refuses an account that is not an admin', async () => {
    const account = await ordinary();
    await request(app).get('/v1/admin/config').set(bearer(account.token)).expect(403);
  });

  test('refuses an automation token', async () => {
    const account = await admin();
    const res = await request(app)
      .post('/v1/tokens')
      .set(bearer(account.token))
      .send({ name: 'ci', scopes: ['publish'] })
      .expect(201);
    await request(app).get('/v1/admin/config').set(bearer(res.body.token)).expect(403);
  });

  test('reports the settings and whether the file can hold a change', async () => {
    const account = await admin();
    const res = await request(app).get('/v1/admin/config').set(bearer(account.token)).expect(200);
    assert.equal(typeof res.body.editable, 'boolean');
    assert.equal(res.body.configPath, configFile);
    assert.ok(Array.isArray(res.body.settings));
    assert.ok(res.body.settings.length > 0);
    // Whatever the host looks like, the body must not carry the connection
    // details that the file also holds.
    assert.doesNotMatch(JSON.stringify(res.body), /postgres:\/\//);
  });
});

describe('PUT /admin/config', () => {
  test('refuses an account that is not an admin', async () => {
    const account = await ordinary();
    await request(app)
      .put('/v1/admin/config')
      .set(bearer(account.token))
      .send({ settings: { 'pagination.maxLimit': 60 } })
      .expect(403);
  });

  test('writes the setting to the file and reports the change', async () => {
    const account = await admin();
    const res = await request(app)
      .put('/v1/admin/config')
      .set(bearer(account.token))
      .send({ settings: { 'pagination.maxLimit': 60 } })
      .expect(200);
    assert.deepEqual(res.body.changed['pagination.maxLimit'], { before: 50, after: 60 });
    assert.deepEqual(res.body.restartRequired, []);
  });

  test('refuses a setting the interface does not offer, by name', async () => {
    const account = await admin();
    const res = await request(app)
      .put('/v1/admin/config')
      .set(bearer(account.token))
      .send({ settings: { 'database.url': 'postgres://elsewhere/db' } })
      .expect(422);
    assert.equal(res.body.errors[0].field, 'database.url');
    assert.equal(config.database.url.includes('elsewhere'), false);
  });

  test('rejects a body that is not a settings object', async () => {
    const account = await admin();
    await request(app)
      .put('/v1/admin/config')
      .set(bearer(account.token))
      .send({ settings: 'pagination.maxLimit=60' })
      .expect(422);
  });

  test('writes an audit row naming the settings that changed', async () => {
    const account = await admin();
    await request(app)
      .put('/v1/admin/config')
      .set(bearer(account.token))
      .send({ settings: { 'pagination.maxLimit': 60 } })
      .expect(200);

    // Read without waiting: the route awaits this write, so the row is committed
    // by the time the response lands. A fire-and-forget audit would leave the
    // read to race the insert.
    const [row] = await sql`
      SELECT action, detail FROM audit_log WHERE action = 'config.update'
    `;
    assert.ok(row, 'expected a config.update audit row');
    assert.equal(row.detail.changed['pagination.maxLimit'].after, 60);
  });
});
