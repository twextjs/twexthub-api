// Deleting an extension removes its blob files, and a publish of the same
// extension writes them. Both take the same per-address lock, and the delete
// holds it across its cleanup: without that, a publish queued behind the delete
// could have the bytes it just wrote unlinked by a cleanup that was still
// running. The two publishes below carry identical code on purpose, so the
// digest — and therefore the file path — is the one the delete is removing.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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
import { withLocks } from '../src/locks.js';

let app;
let db;
let config;
before(async () => {
  ({ app, db, config } = await boot());
});
beforeEach(resetDb);
after(async () => {
  await db.$disconnect();
});

test('a queued publish waits for the delete to finish its cleanup', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const owner = await signupAndAccept(app, uniqNs());
  const ns = owner.user.namespace;
  const code = '// identical bytes on both sides of the delete';

  await publishProject(app, ns, 'hello', owner.token, { code });
  await request(app)
    .patch(apiPath(`/@${ns}/hello/versions/1.0.0`))
    .set(bearer(admin.token))
    .send({ status: 'approved' })
    .expect(200);

  let deleteSettled = false;
  let publishSettled = false;
  let deletion;
  let publication;

  // Standing in for the first request's own transaction: while this holds the
  // address, neither endpoint can get past it.
  await withLocks(db, [`${ns}/hello`], async () => {
    deletion = request(app)
      .delete(apiPath(`/@${ns}/hello`))
      .set(bearer(owner.token))
      .then((response) => {
        deleteSettled = true;
        return response;
      });
    publication = publishProject(app, ns, 'hello', owner.token, { code }).then((response) => {
      publishSettled = true;
      return response;
    });

    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(deleteSettled, false, 'the delete waits for the address lock');
    assert.equal(publishSettled, false, 'the publish queues behind it on the same lock');
  });

  const [deleted, published] = await Promise.all([deletion, publication]);
  assert.equal(deleted.status, 204);
  assert.equal(published.status, 201);

  // The publish ran after the cleanup, so its bytes are still on disk — the
  // same path the cleanup would have removed had it run last.
  const [row] = await db.$queryRaw`
    SELECT blob_digest, blob_path, status FROM versions
    WHERE namespace = ${ns} AND extension_id = 'hello'
  `;
  assert.equal(row.status, 'published');
  assert.ok(row.blob_digest, 'the surviving version is content-addressed');
  assert.ok(
    fs.existsSync(path.join(config.dataDir, row.blob_path)),
    'the bytes the publish wrote are still there',
  );
  await request(app)
    .get(apiPath(`/@${ns}/hello/versions/1.0.0/download`))
    .set(bearer(owner.token))
    .expect(200);
});
