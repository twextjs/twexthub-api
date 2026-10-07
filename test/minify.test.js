import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
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
import { minifyCode } from '../src/minify.js';

let app;
let sql;
let config;
before(async () => {
  ({ app, sql, config } = await boot());
});
beforeEach(resetDb);
after(async () => {
  await sql.end();
});

test('minifyCode strips comments and whitespace but keeps property names', async () => {
  const source = `// MARKER_ABC
(function (Scratch) {
  "use strict";
  class Widget {
    getInfo() {
      return {
        id: "widget",
        name: "A widget",
        blocks: [
          { opcode: "hello", blockType: Scratch.BlockType.COMMAND, text: "hello" },
        ],
      };
    }
    hello(args) {
      const unused = 1 + 1;
      return 42;
    }
  }
  Scratch.extensions.register(new Widget());
})(Scratch);`;

  const result = await minifyCode(Buffer.from(source));
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  const out = result.code.toString('utf8');
  assert.ok(Buffer.byteLength(out) < Buffer.byteLength(source), 'output is smaller');
  assert.ok(!out.includes('MARKER_ABC'), 'comments are dropped');
  assert.ok(out.includes('"hello"'), 'opcodes survive mangling');
  assert.ok(out.includes('opcode:'), 'block keys survive mangling');
  assert.ok(out.includes('getInfo'), 'method names are preserved');
  assert.ok(out.includes('extensions.register'), 'registration survives');
});

test('minifyCode reports ok=false on bad input and on oversized input', async () => {
  const invalid = await minifyCode(Buffer.from('function { this is not valid'));
  assert.equal(invalid.ok, false);

  const oversized = await minifyCode(Buffer.from('const x = 1;'), { maxBytes: 8 });
  assert.equal(oversized.ok, false);
  assert.match(oversized.error, /minify limit/);
});

test('minifyCode hands the original bytes back when the pass would not shrink', async () => {
  const source = 'x';
  const result = await minifyCode(Buffer.from(source));
  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
  assert.equal(result.code.toString('utf8'), source);
});

test('approval minifies a pending build and updates digest, integrity, size, and quota', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const owner = await signupAndAccept(app, uniqNs());
  const ns = owner.user.namespace;
  const code = '// REMOVE_ME_SENTINEL_ABC\nreturn 42;';

  await publishProject(app, ns, 'mini', owner.token, { code });
  const [row] = await sql`
    SELECT blob_digest, blob_size, source_size FROM versions
    WHERE namespace = ${ns} AND extension_id = 'mini'
  `;
  const beforeText = fs.readFileSync(blobPathFor(config.dataDir, row.blob_digest), 'utf8');
  assert.match(beforeText, /REMOVE_ME_SENTINEL_ABC/, 'the pending blob keeps the comment');
  assert.equal(Number(row.blob_size), Buffer.byteLength(beforeText));

  const approved = await request(app)
    .patch(apiPath('/@' + ns + '/mini/versions/1.0.0'))
    .set(bearer(admin.token))
    .send({ status: 'approved' })
    .expect(200);

  const [after] = await sql`
    SELECT blob_digest, blob_size FROM versions
    WHERE namespace = ${ns} AND extension_id = 'mini'
  `;
  assert.notEqual(after.blob_digest, row.blob_digest, 'the approved blob has a new digest');
  const afterBytes = fs.readFileSync(blobPathFor(config.dataDir, after.blob_digest));
  assert.ok(!afterBytes.toString('utf8').includes('REMOVE_ME_SENTINEL_ABC'));
  assert.ok(afterBytes.length < Buffer.byteLength(beforeText), 'the approved blob is smaller');
  assert.equal(Number(after.blob_size), afterBytes.length);

  // The serialized digest and integrity describe the bytes now served.
  assert.equal(approved.body.dist.digest, `sha256:${after.blob_digest}`);
  assert.equal(createHash('sha256').update(afterBytes).digest('hex'), after.blob_digest);

  // The publish charged the unminified build; approval refunded the shaved bytes.
  const [account] = await sql`SELECT blob_bytes FROM users WHERE namespace = ${ns}`;
  assert.equal(Number(account.blob_bytes), Number(after.blob_size) + Number(row.source_size));

  // The old unminified file is no longer referenced and is swept.
  await assert.rejects(fs.promises.stat(blobPathFor(config.dataDir, row.blob_digest)), {
    code: 'ENOENT',
  });
});

test('a trusted account publishes minified output directly', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const owner = await signupAndAccept(app, uniqNs());
  const ns = owner.user.namespace;

  // The first reviewed publish is what makes the namespace trusted.
  await publishProject(app, ns, 'first', owner.token, { code: '// seed' });
  await request(app)
    .patch(apiPath('/@' + ns + '/first/versions/1.0.0'))
    .set(bearer(admin.token))
    .send({ status: 'approved' })
    .expect(200);

  const published = await publishProject(app, ns, 'mini', owner.token, {
    code: '// REMOVE_ME_SENTINEL_XYZ\nreturn 42;',
  });
  assert.equal(published.body.status, 'published', 'trusted publishes skip review');

  const [row] = await sql`
    SELECT blob_digest FROM versions
    WHERE namespace = ${ns} AND extension_id = 'mini'
  `;
  const text = fs.readFileSync(blobPathFor(config.dataDir, row.blob_digest), 'utf8');
  assert.ok(!text.includes('REMOVE_ME_SENTINEL_XYZ'), 'the served blob is minified');
  assert.match(published.body.dist.digest, /^sha256:[0-9a-f]{64}$/);
});
