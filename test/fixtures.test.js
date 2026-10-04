import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import YAML from 'yaml';
import { boot, resetDb, bearer, uniqNs, signupAndAccept, tarballFromDir } from './helpers.mjs';
import { compileProject } from '../src/compiler.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test-fixtures');

let app;
let config;
before(async () => {
  ({ app, config } = await boot());
});
beforeEach(resetDb);
after(async () => {
  await (await boot()).sql.end();
});

async function approveFixture(adminToken, ns, id, version) {
  const queue = await request(app)
    .get('/v1/versions?status=pending')
    .set(bearer(adminToken))
    .expect(200);
  const entry = queue.body.data.find((v) => v.namespace === ns && v.id === id);
  assert.ok(entry, `pending entry for ${id}`);
  await request(app)
    .patch(`/v1/@${ns}/${id}/versions/${version}`)
    .set(bearer(adminToken))
    .send({ status: 'approved' })
    .expect(200);
}

function compileFixtureLocally(fixtureDir, expectedFile) {
  // Rebuild the same source the server received so tests can compare against
  // byte-identical output, mirroring the committed dist/ artifacts.
  return {
    async run(overrides = {}) {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'twexthub-fx-'));
      try {
        await mkdir(dir, { recursive: true });
        const entries = await fs.promises.readdir(fixtureDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name === 'dist' || entry.name === 'node_modules') continue;
          await fs.promises.cp(path.join(fixtureDir, entry.name), path.join(dir, entry.name), {
            recursive: true,
          });
        }
        if (overrides.twextYml) {
          await writeFile(path.join(dir, 'twext.yml'), overrides.twextYml);
        }
        if (overrides.sourceFiles) {
          for (const [rel, text] of Object.entries(overrides.sourceFiles)) {
            const abs = path.join(dir, rel);
            await mkdir(path.dirname(abs), { recursive: true });
            await writeFile(abs, text);
          }
        }
        const build = await compileProject(config, dir, {
          outFile: path.join(dir, expectedFile),
        });
        assert.equal(build.ok, true, build.error ?? build.log);
        return await readFile(path.join(dir, expectedFile));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

test('fixture greeter round-trips byte-for-byte', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const owner = await signupAndAccept(app, uniqNs());
  const ns = owner.user.namespace;

  const manifest = YAML.parse(fs.readFileSync(path.join(FIXTURES, 'greeter', 'twext.yml'), 'utf8'));
  const compiled = fs.readFileSync(path.join(FIXTURES, 'greeter', 'dist', 'Greeter.js'));
  const id = manifest.extension.id;
  const version = manifest.version;

  const pub = await request(app)
    .post(`/v1/@${ns}/${id}/versions`)
    .set(bearer(owner.token))
    .set('Content-Type', 'application/gzip')
    .send(await tarballFromDir(path.join(FIXTURES, 'greeter')))
    .expect(201);
  assert.equal(pub.body.status, 'pending');
  assert.equal(pub.body.id, id);
  assert.equal(pub.body.version, version);
  assert.equal(pub.body.name, 'Greetings');

  await approveFixture(admin.token, ns, id, version);

  // The server's sandbox build must reproduce the committed artifact exactly.
  const dl = await request(app).get(`/v1/@${ns}/${id}/versions/${version}/download`).expect(200);
  assert.match(dl.headers['content-type'], /javascript/);
  assert.deepEqual(
    Buffer.from(dl.text, 'utf8'),
    compiled,
    'downloaded bytes must match the compiled fixture exactly',
  );

  const detail = await request(app).get(`/v1/@${ns}/${id}`).expect(200);
  assert.equal(detail.body.version, version);
  assert.equal(detail.body.color1, '#0094FF');
  assert.equal(detail.body.license, 'MIT');
});

test('fixture hello auto-publishes after first approval; source changes are honored', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const owner = await signupAndAccept(app, uniqNs());
  const ns = owner.user.namespace;

  const manifest = YAML.parse(fs.readFileSync(path.join(FIXTURES, 'hello', 'twext.yml'), 'utf8'));
  const id = manifest.extension.id;
  const version = manifest.version;
  const helloFixture = compileFixtureLocally(path.join(FIXTURES, 'hello'), 'dist/Hello.js');
  const original = await helloFixture.run();

  await request(app)
    .post(`/v1/@${ns}/${id}/versions`)
    .set(bearer(owner.token))
    .set('Content-Type', 'application/gzip')
    .send(await tarballFromDir(path.join(FIXTURES, 'hello')))
    .expect(201);
  await approveFixture(admin.token, ns, id, version);

  const firstDownload = await request(app)
    .get(`/v1/@${ns}/${id}/versions/${version}/download`)
    .expect(200);
  assert.deepEqual(Buffer.from(firstDownload.text, 'utf8'), original);

  // Mutate the greeting in source, publish again: the server compiles the new
  // source and the second build reflects the change.
  const sourceFiles = {
    'src/blocks/hello.js': "export function hello() {\n  return 'hello again';\n}\n",
  };
  const replaced = await helloFixture.run({ sourceFiles });
  assert.ok(!replaced.equals(original), 'mutating the greeting must change the bundle');

  const second = await publishFixture(
    ns,
    id,
    owner.token,
    path.join(FIXTURES, 'hello'),
    sourceFiles,
    '0.2.0',
  );
  assert.equal(second.status, 201);
  assert.equal(second.body.status, 'published');

  const dl = await request(app).get(`/v1/@${ns}/${id}/versions/0.2.0/download`).expect(200);
  assert.deepEqual(Buffer.from(dl.text, 'utf8'), replaced);
});

async function publishFixture(ns, id, token, fixtureDir, sourceFiles, version = '0.1.0') {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'twexthub-fx-pub-'));
  try {
    const entries = await fs.promises.readdir(fixtureDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'dist' || entry.name === 'node_modules') continue;
      await fs.promises.cp(path.join(fixtureDir, entry.name), path.join(dir, entry.name), {
        recursive: true,
      });
    }
    const ymlPath = path.join(dir, 'twext.yml');
    const yml = YAML.parse(fs.readFileSync(ymlPath, 'utf8'));
    await writeFile(ymlPath, YAML.stringify({ ...yml, version }));
    if (sourceFiles) {
      for (const [rel, text] of Object.entries(sourceFiles)) {
        const abs = path.join(dir, rel);
        await mkdir(path.dirname(abs), { recursive: true });
        await writeFile(abs, text);
      }
    }
    return await request(app)
      .post(`/v1/@${ns}/${id}/versions`)
      .set(bearer(token))
      .set('Content-Type', 'application/gzip')
      .send(await tarballFromDir(dir))
      .expect(201);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
