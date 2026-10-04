import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { makeConfig } from './helpers.mjs';
import { createApp } from '../src/app.js';
import { createDb, ensureDataDirs } from '../src/db.js';

test('logging.requests emits one JSON line per request', async () => {
  const config = makeConfig({ logging: { requests: true } });
  ensureDataDirs(config.dataDir);
  const sql = createDb(config);
  const { app } = createApp({ config, sql });

  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args);

  try {
    await request(app).get('/v1/meta').expect(200);
    await request(app).get('/v1/definitely-not-here').expect(404);
  } finally {
    console.log = original;
  }

  const parsed = lines.map((args) => {
    assert.equal(args.length, 1, 'log lines go to stdout via a single console.log argument');
    return JSON.parse(args[0]);
  });
  const ok = parsed.filter((entry) => entry.msg === 'request');
  assert.equal(ok.length, 2, `expected two request logs, got ${JSON.stringify(parsed)}`);

  const matched = ok.find((entry) => entry.route === '/v1/meta');
  assert.ok(matched, 'matched route is labeled by pattern, including the apiRoot');
  assert.equal(matched.method, 'GET');
  assert.equal(matched.status, 200);
  assert.equal(typeof matched.durationMs, 'number');
  assert.match(matched.path, /^\/v1\/meta$/);

  const unmatched = ok.find((entry) => entry.route === 'unmatched');
  assert.ok(unmatched, 'unmatched paths still get a line');
  assert.equal(unmatched.status, 404);

  await sql.end();
});
