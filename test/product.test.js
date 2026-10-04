import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import request from 'supertest';
import { product } from '../src/product.js';
import { DEFAULTS } from '../src/config.js';
import { boot } from './helpers.mjs';

let app;
before(async () => {
  ({ app } = await boot());
});
after(async () => {
  await (await boot()).sql.end();
});

test('product.yml loads with required fields', () => {
  assert.equal(product.name, 'TwextHub');
  assert.ok(product.version);
  assert.ok(product.tagline);
  assert.ok(product.homepage);
  assert.ok(product.defaults?.configFilename);
  assert.ok(product.defaults?.apiRoot);
});

test('product.yml version matches package.json', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  assert.equal(product.version, pkg.version);
});

test('config DEFAULTS.apiRoot is sourced from product.yml', () => {
  assert.equal(DEFAULTS.apiRoot, product.defaults.apiRoot);
});

test('GET /v1/meta returns product metadata', async () => {
  const r = await request(app).get('/v1/meta');
  assert.equal(r.status, 200);
  assert.equal(r.body.name, product.name);
  assert.equal(r.body.version, product.version);
  assert.equal(r.body.tagline, product.tagline);
  assert.equal(r.body.homepage, product.homepage);
});
