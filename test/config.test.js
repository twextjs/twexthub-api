import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { DEFAULTS, loadConfig } from '../src/config.js';

test('loadConfig validates the device approval page', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twexthub-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.yaml');
  const previous = process.env.TWEXTHUB_DEVICE_VERIFICATION_URL;
  delete process.env.TWEXTHUB_DEVICE_VERIFICATION_URL;
  t.after(() => {
    if (previous === undefined) delete process.env.TWEXTHUB_DEVICE_VERIFICATION_URL;
    else process.env.TWEXTHUB_DEVICE_VERIFICATION_URL = previous;
  });
  function writeConfig(verificationUrl) {
    fs.writeFileSync(
      file,
      YAML.stringify({
        database: { url: 'postgres://u@localhost:5432/db' },
        auth: { device: { verificationUrl } },
      }),
    );
  }

  for (const value of [5, {}, true, 'not a url', 'ftp://app.test/device']) {
    writeConfig(value);
    assert.throws(() => loadConfig(file), /auth\.device\.verificationUrl must be/);
  }
  for (const value of [null, undefined, '']) {
    writeConfig(value);
    assert.equal(loadConfig(file).auth.device.verificationUrl, null);
  }
  writeConfig('https://app.test/device');
  assert.equal(loadConfig(file).auth.device.verificationUrl, 'https://app.test/device');
});

test('loadConfig validates and normalizes the recent-authentication window', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twexthub-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.yaml');
  const previous = process.env.TWEXTHUB_REAUTH_WINDOW_MINUTES;
  delete process.env.TWEXTHUB_REAUTH_WINDOW_MINUTES;
  t.after(() => {
    if (previous === undefined) delete process.env.TWEXTHUB_REAUTH_WINDOW_MINUTES;
    else process.env.TWEXTHUB_REAUTH_WINDOW_MINUTES = previous;
  });
  function writeConfig(reauthWindowMinutes) {
    fs.writeFileSync(
      file,
      YAML.stringify({
        database: { url: 'postgres://u@localhost:5432/db' },
        auth: { reauthWindowMinutes },
      }),
    );
  }

  for (const value of [
    0,
    -1,
    NaN,
    Infinity,
    -Infinity,
    '',
    'bad',
    'NaN',
    'Infinity',
    true,
    false,
    [],
    [10],
    {},
  ]) {
    writeConfig(value);
    assert.throws(
      () => loadConfig(file),
      /auth\.reauthWindowMinutes must be a finite positive number/,
    );
  }
  for (const value of [10, 0.5, '15', '2.5']) {
    writeConfig(value);
    assert.equal(loadConfig(file).auth.reauthWindowMinutes, Number(value));
  }
  // Null means "not set" under the configuration merge rules.
  for (const value of [null, undefined]) {
    writeConfig(value);
    assert.equal(loadConfig(file).auth.reauthWindowMinutes, DEFAULTS.auth.reauthWindowMinutes);
  }
});
