import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import request from 'supertest';
import {
  apiPath,
  bearer,
  boot,
  publishProject,
  resetDb,
  signupAndAccept,
  uniqNs,
} from './helpers.mjs';
import { blobPathFor } from '../src/blobs.js';

// A small storage limit makes the publish-time minify behavior testable with
// ordinary source sizes: a trusted build whose raw output would be rejected
// passes once it minifies under the limit.
let app;
let sql;
let config;
before(async () => {
  ({ app, sql, config } = await boot({ limits: { maxBlobBytes: 4096 } }));
});
beforeEach(resetDb);
after(async () => {
  await sql.end();
});

const padded = (lines) =>
  Array.from({ length: lines }, (_, n) => `  // padding #${n}`).join('\n') + '\n  return 42;\n';

test('a trusted publish is accepted when minification brings the build under the blob limit', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const owner = await signupAndAccept(app, uniqNs());
  const ns = owner.user.namespace;

  await publishProject(app, ns, 'seed', owner.token, { code: '// seed' });
  await request(app)
    .patch(apiPath(`/@${ns}/seed/versions/1.0.0`))
    .set(bearer(admin.token))
    .send({ status: 'approved' })
    .expect(200);

  // Raw compiler output is well over the 4 KiB blob limit; comments only close
  // to the code when the source is embedded in the compiled handler.
  const code = padded(600);
  const pub = await publishProject(app, ns, 'big', owner.token, { code });
  assert.equal(pub.body.status, 'published');

  const [row] = await sql`
    SELECT blob_digest, blob_size FROM versions
    WHERE namespace = ${ns} AND extension_id = 'big'
  `;
  assert.equal(pub.body.dist.digest, `sha256:${row.blob_digest}`);
  assert.ok(Number(row.blob_size) <= 4096, 'the stored blob respects the limit');
  const bytes = fs.readFileSync(blobPathFor(config.dataDir, row.blob_digest));
  assert.equal(bytes.length, Number(row.blob_size));
  assert.ok(!bytes.toString('utf8').includes('padding #'), 'the served bytes are minified');
});

test('an untrusted publish of the same build is still rejected on its raw size', async () => {
  const owner = await signupAndAccept(app, uniqNs());
  const ns = owner.user.namespace;

  const res = await publishProject(app, ns, 'big', owner.token, { code: padded(600) }, 413);
  assert.match(res.body.detail, /bytes; the limit is 4096/);
});

test('a trusted build that cannot minify under the limit is rejected on its final size', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const owner = await signupAndAccept(app, uniqNs());
  const ns = owner.user.namespace;

  await publishProject(app, ns, 'seed', owner.token, { code: '// seed' });
  await request(app)
    .patch(apiPath(`/@${ns}/seed/versions/1.0.0`))
    .set(bearer(admin.token))
    .send({ status: 'approved' })
    .expect(200);

  // Unique string literals survive minification, so the build stays oversized
  // even after the pass.
  const code =
    'return [' + Array.from({ length: 600 }, (_, i) => `"0000000000000000-${i}"`).join(',') + '];';
  const res = await publishProject(app, ns, 'wide', owner.token, { code }, 413);
  assert.match(res.body.detail, /bytes; the limit is 4096/);
});
