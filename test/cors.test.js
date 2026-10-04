import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import express from 'express';
import { boot } from './helpers.mjs';
import { makeCors } from '../src/cors.js';
import { DEFAULTS, loadConfig } from '../src/config.js';

let app;
before(async () => {
  ({ app } = await boot());
});
after(async () => {
  await (await boot()).sql.end();
});

test('cross-origin reads are allowed with the wildcard by default', async () => {
  const res = await request(app).get('/v1/meta').set('Origin', 'https://example.com');
  assert.equal(res.status, 200);
  assert.equal(res.headers['access-control-allow-origin'], '*');
});

test('preflight requests get the allow headers', async () => {
  const res = await request(app)
    .options('/v1/extensions')
    .set('Origin', 'https://example.com')
    .set('Access-Control-Request-Method', 'GET');
  assert.equal(res.status, 204);
  assert.equal(res.headers['access-control-allow-origin'], '*');
  assert.match(res.headers['access-control-allow-methods'], /GET/);
  assert.ok(res.headers['access-control-allow-headers']);
  assert.ok(res.headers['access-control-max-age']);
});

test('requests without an Origin get no CORS headers', async () => {
  const res = await request(app).get('/v1/meta');
  assert.equal(res.status, 200);
  assert.equal(res.headers['access-control-allow-origin'], undefined);
});

function allowlistApp(origins) {
  const expressApp = express();
  expressApp.use(makeCors({ allowedOrigins: origins }));
  expressApp.get('/ping', (req, res) => res.json({ ok: true }));
  return expressApp;
}

test('an allowed origin is echoed back with Vary: Origin', async () => {
  const res = await request(allowlistApp(['https://a.example', 'https://b.example']))
    .get('/ping')
    .set('Origin', 'https://b.example');
  assert.equal(res.headers['access-control-allow-origin'], 'https://b.example');
  assert.equal(res.headers.vary, 'Origin');
});

test('a disallowed origin gets no CORS headers but still Vary: Origin', async () => {
  const res = await request(allowlistApp(['https://a.example']))
    .get('/ping')
    .set('Origin', 'https://evil.example');
  assert.equal(res.status, 200);
  assert.equal(res.headers['access-control-allow-origin'], undefined);
  assert.equal(res.headers['access-control-allow-methods'], undefined);
  assert.equal(res.headers.vary, 'Origin');
});

test('an originless request in allowlist mode still gets Vary: Origin', async () => {
  const res = await request(allowlistApp(['https://a.example'])).get('/ping');
  assert.equal(res.status, 200);
  assert.equal(res.headers['access-control-allow-origin'], undefined);
  assert.equal(res.headers.vary, 'Origin');
});

function tempConfig(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twexthub-cors-'));
  const file = path.join(dir, 'config.yaml');
  fs.writeFileSync(file, content);
  return file;
}

test('loadConfig reads cors.allowedOrigins from the config file', () => {
  const file = tempConfig(
    [
      'database:',
      '  url: postgres://u@localhost:5432/db',
      'cors:',
      "  allowedOrigins: ['https://a.example', 'https://b.example']",
    ].join('\n'),
  );
  const config = loadConfig(file);
  assert.deepEqual(config.cors.allowedOrigins, ['https://a.example', 'https://b.example']);
});

// The docs offer `null` as the way to switch a rate-limit bucket off, and the
// config file is where an operator reaches for it. The merge used to read a null
// as "not set" and hand back the default, so the line that was supposed to turn
// the bucket off left it running.
test('loadConfig keeps the null that switches a rate-limit bucket off', () => {
  const file = tempConfig(
    [
      'database:',
      '  url: postgres://u@localhost:5432/db',
      'rateLimits:',
      '  publishPerWindow: null',
      '  downloadsPerIpPerWindow: null',
      'pagination:',
      '  maxLimit: null',
    ].join('\n'),
  );
  const config = loadConfig(file);
  assert.equal(config.rateLimits.publishPerWindow, null);
  assert.equal(config.rateLimits.downloadsPerIpPerWindow, null);
  // Every other key still reads a null as "not set". That is what keeps a
  // mistyped quota from blanking itself.
  assert.equal(config.pagination.maxLimit, DEFAULTS.pagination.maxLimit);
});

test('TWEXTHUB_CORS_ALLOWED_ORIGINS parses as a list or a wildcard', () => {
  const file = tempConfig('database:\n  url: postgres://u@localhost:5432/db\n');
  const prev = process.env.TWEXTHUB_CORS_ALLOWED_ORIGINS;
  try {
    process.env.TWEXTHUB_CORS_ALLOWED_ORIGINS = 'https://hub.example, https://editor.example';
    const config = loadConfig(file);
    assert.deepEqual(config.cors.allowedOrigins, ['https://hub.example', 'https://editor.example']);

    process.env.TWEXTHUB_CORS_ALLOWED_ORIGINS = '*';
    assert.equal(loadConfig(file).cors.allowedOrigins, '*');
  } finally {
    if (prev === undefined) delete process.env.TWEXTHUB_CORS_ALLOWED_ORIGINS;
    else process.env.TWEXTHUB_CORS_ALLOWED_ORIGINS = prev;
  }
});
