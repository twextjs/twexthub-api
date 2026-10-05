import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { rm, readFile, utimes } from 'node:fs/promises';
import request from 'supertest';
import sharp from 'sharp';
import { blobPathFor } from '../src/blobs.js';
import { gcBlobs } from '../src/maintenance.js';
import { sniffImageType, supportedImageTypes } from '../src/image-sniff.js';
import { apiPath, bearer, boot, resetDb, signupAndAccept, uniqNs } from './helpers.mjs';

// Real images rather than signature bytes on their own: an upload is decoded
// before it is stored, so a fixture the decoder rejects would exercise the
// rejection path and pass for the wrong reason. Trailing bytes after the last
// chunk are still how a fixture reaches an exact size -- a decoder ignores them
// and the byte limit does not.
const [TINY_PNG, TINY_GIF, TINY_JPEG] = await Promise.all([
  sharp({
    create: {
      width: 8,
      height: 8,
      channels: 3,
      noise: { type: 'gaussian', mean: 128, sigma: 40 },
    },
  })
    .png()
    .toBuffer(),
  sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } } })
    .gif()
    .toBuffer(),
  sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 9, g: 8, b: 7 } } })
    .jpeg()
    .toBuffer(),
]);

function pngBytes(extra = 0) {
  return Buffer.concat([TINY_PNG, Buffer.alloc(extra, 0x5a)]);
}
const gifBytes = () => TINY_GIF;
const jpegBytes = () => TINY_JPEG;

let app;
let sql;
let config;

before(async () => {
  ({ app, sql, config } = await boot({
    // A small ceiling keeps the over-limit case cheap; the rest of the limits
    // section stays at its production default.
    limits: { maxProfileImageBytes: 4096 },
  }));
});
beforeEach(resetDb);
after(async () => {
  await sql.end();
});

const tokens = new Map();

async function account() {
  const ns = uniqNs();
  const res = await signupAndAccept(app, ns);
  tokens.set(ns, res.token);
  return ns;
}

const put = (ns, kind, body, type) =>
  request(app)
    .put(apiPath(`/users/${ns}/${kind}`))
    .set(bearer(tokens.get(ns)))
    .set('Content-Type', type)
    .send(body);

const avatarDigest = (ns) => sql`SELECT avatar_blob_digest FROM users WHERE namespace = ${ns}`;

// The published URL names the exact bytes, so it carries a short version token
// taken from the content digest. Reading it back from the row keeps a test from
// having to re-derive the hash.
// supertest needs the path the API is mounted on, not the absolute URL a reader
// would follow, so the published URL is trimmed back to that.
const asPath = (url) => url.replace(config.publicBaseUrl, '');

const versioned = async (ns, kind) => {
  const column = kind === 'avatar' ? 'avatar_blob_digest' : 'banner_blob_digest';
  const [row] = await sql`SELECT ${sql(column)} AS digest FROM users WHERE namespace = ${ns}`;
  assert.ok(row.digest, `expected ${ns} to have a ${kind} upload`);
  return `${config.publicBaseUrl}${apiPath(`/users/${ns}/${kind}`)}?v=${row.digest.slice(0, 16)}`;
};

describe('sniffImageType', () => {
  test('recognises a format from its signature bytes', () => {
    assert.equal(sniffImageType(pngBytes()), 'image/png');
    assert.equal(sniffImageType(gifBytes()), 'image/gif');
    assert.equal(sniffImageType(jpegBytes()), 'image/jpeg');
  });

  test('rejects SVG, which would execute script in the serving origin', () => {
    assert.equal(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
    assert.ok(!supportedImageTypes().includes('image/svg+xml'));
  });

  test('rejects non-images and truncated headers', () => {
    assert.equal(sniffImageType(Buffer.from('GIF87a')), null);
    assert.equal(sniffImageType(Buffer.from('<?php system($_GET[0]); ?>')), null);
    assert.equal(sniffImageType(Buffer.alloc(0)), null);
  });
});

describe('uploading a profile image', () => {
  test('stores the bytes and reports the canonical URL', async () => {
    const ns = await account();
    const res = await put(ns, 'avatar', pngBytes(), 'image/png');
    assert.equal(res.status, 200);
    assert.equal(res.body.avatarUrl, await versioned(ns, 'avatar'));

    const [row] = await sql`SELECT * FROM users WHERE namespace = ${ns}`;
    assert.match(row.avatar_blob_digest, /^[0-9a-f]{64}$/);
    assert.equal(row.avatar_content_type, 'image/png');
    assert.equal(row.avatar_bytes, TINY_PNG.length);
    assert.ok(existsSync(blobPathFor(config.dataDir, row.avatar_blob_digest)));
  });

  test('stores a banner', async () => {
    const ns = await account();
    const res = await put(ns, 'banner', pngBytes(), 'image/png');
    assert.equal(res.status, 200);
    assert.equal(res.body.bannerUrl, await versioned(ns, 'banner'));
  });

  test('deduplicates identical uploads across accounts', async () => {
    const a = await account();
    const b = await account();
    const bytes = pngBytes();
    await put(a, 'avatar', bytes, 'image/png');
    await put(b, 'avatar', bytes, 'image/png');
    const [ra] = await avatarDigest(a);
    const [rb] = await avatarDigest(b);
    assert.equal(ra.avatar_blob_digest, rb.avatar_blob_digest);
  });

  test('keeps an external reference, which the upload then shadows', async () => {
    const ns = await account();
    await request(app)
      .patch(apiPath(`/users/${ns}`))
      .set(bearer(tokens.get(ns)))
      .send({ avatarUrl: 'https://cdn.example/old.png' })
      .expect(200);

    const res = await put(ns, 'avatar', pngBytes(), 'image/png');

    const [row] =
      await sql`SELECT avatar_url, avatar_blob_digest FROM users WHERE namespace = ${ns}`;
    assert.equal(row.avatar_url, 'https://cdn.example/old.png');
    assert.ok(row.avatar_blob_digest);
    // The upload is what a visitor is shown, not the linked file.
    assert.equal(res.body.avatarUrl, await versioned(ns, 'avatar'));
    const served = await request(app).get(apiPath(`/users/${ns}/avatar`));
    assert.equal(served.status, 200);
    assert.equal(served.headers['content-type'], 'image/png');
  });
});

describe('upload validation', () => {
  test('rejects a non-image body declared as an image', async () => {
    const ns = await account();
    const res = await put(ns, 'avatar', 'not an image at all', 'image/png');
    assert.equal(res.status, 415);
  });

  test('rejects an SVG', async () => {
    const ns = await account();
    const res = await put(ns, 'avatar', Buffer.from('<svg onload="alert(1)"/>'), 'image/svg+xml');
    assert.equal(res.status, 415);
  });

  test('rejects a declared type that disagrees with the bytes', async () => {
    const ns = await account();
    const res = await put(ns, 'avatar', pngBytes(), 'image/jpeg');
    assert.equal(res.status, 415);
    assert.match(res.body.detail, /does not match/i);
  });

  test('accepts a generic content type and trusts the bytes', async () => {
    const ns = await account();
    const res = await put(ns, 'avatar', gifBytes(), 'application/octet-stream');
    assert.equal(res.status, 200);
  });

  test('ignores a charset parameter on the content type', async () => {
    const ns = await account();
    const res = await put(ns, 'avatar', pngBytes(), 'image/png; charset=binary');
    assert.equal(res.status, 200);
  });

  test('rejects an empty body', async () => {
    const ns = await account();
    const res = await put(ns, 'avatar', Buffer.alloc(0), 'image/png');
    assert.equal(res.status, 413);
  });

  test('rejects an image over the configured limit', async () => {
    const ns = await account();
    const res = await put(ns, 'avatar', pngBytes(config.limits.maxProfileImageBytes), 'image/png');
    assert.equal(res.status, 413);
  });

  // The body parser is built when the routes are wired, so with the configured
  // limit baked into it a change on the running instance would not reach the next
  // upload: the parser reads up to the ceiling and the live limit is applied to
  // what arrives. Both directions have to hold, so neither a lower limit that
  // still lets bytes through nor a higher one the parser would refuse can pass.
  test('applies a limit changed on the running instance', async () => {
    const ns = await account();
    const before = config.limits.maxProfileImageBytes;
    try {
      config.limits.maxProfileImageBytes = 64;
      const tooBig = await put(ns, 'avatar', pngBytes(2000), 'image/png');
      assert.equal(tooBig.status, 413);
      // The rejection names the setting rather than the parser's ceiling, which
      // is what says the live value was the one consulted.
      assert.match(tooBig.body.detail, /limit for this field/);

      // Above the 4 KiB this suite booted with, so a parser still holding that
      // value would refuse the body instead of storing it.
      config.limits.maxProfileImageBytes = 8192;
      assert.equal((await put(ns, 'avatar', pngBytes(5000), 'image/png')).status, 200);
    } finally {
      config.limits.maxProfileImageBytes = before;
    }
  });
});

describe('stored size', () => {
  // This suite booted with a 4 KiB ceiling so the over-limit case stays cheap,
  // and the real targets are bigger in bytes than that, so these raise it for
  // the length of one upload.
  const withCeiling = async (run) => {
    const before = config.limits.maxProfileImageBytes;
    config.limits.maxProfileImageBytes = 16 * 1024 * 1024;
    try {
      await run();
    } finally {
      config.limits.maxProfileImageBytes = before;
    }
  };

  const solidPng = (width, height) =>
    sharp({ create: { width, height, channels: 3, background: { r: 20, g: 90, b: 160 } } })
      .png()
      .toBuffer();

  // What ended up on disk, rather than what was sent: the point of these is the
  // stored copy, and reading it back is the only way to see what was kept.
  const storedMeta = async (ns, kind) => {
    const [row] = await sql`SELECT * FROM users WHERE namespace = ${ns}`;
    const bytes = await readFile(blobPathFor(config.dataDir, row[`${kind}_blob_digest`]));
    return { ...(await sharp(bytes).metadata()), bytes: bytes.length };
  };

  test('scales a large avatar down to 2000px, keeping its shape', async () => {
    const ns = await account();
    await withCeiling(async () => {
      const res = await put(ns, 'avatar', await solidPng(5000, 1200), 'image/png');
      assert.equal(res.status, 200);
    });
    const meta = await storedMeta(ns, 'avatar');
    assert.deepEqual([meta.width, meta.height], [2000, 480]);
  });

  test('leaves an avatar that already fits exactly as it was sent', async () => {
    const ns = await account();
    const bytes = await solidPng(400, 300);
    await withCeiling(async () => {
      assert.equal((await put(ns, 'avatar', bytes, 'image/png')).status, 200);
    });
    // Not merely the same dimensions: the same file, so the bytes are not spent
    // re-encoding an image that needed nothing.
    assert.equal((await storedMeta(ns, 'avatar')).bytes, bytes.length);
  });

  test('crops a banner to 3:1 and scales it to 3000x1000', async () => {
    const ns = await account();
    await withCeiling(async () => {
      const res = await put(ns, 'banner', await solidPng(4000, 4000), 'image/png');
      assert.equal(res.status, 200);
    });
    const meta = await storedMeta(ns, 'banner');
    assert.deepEqual([meta.width, meta.height], [3000, 1000]);
  });

  test('does not enlarge a banner that is smaller than the target', async () => {
    const ns = await account();
    const bytes = await solidPng(300, 100);
    await withCeiling(async () => {
      assert.equal((await put(ns, 'banner', bytes, 'image/png')).status, 200);
    });
    const meta = await storedMeta(ns, 'banner');
    assert.deepEqual([meta.width, meta.height], [300, 100]);
    assert.equal(meta.bytes, bytes.length);
  });

  test('keeps every frame of an animated GIF it has to scale', async () => {
    const ns = await account();
    const frame = (r) =>
      sharp({ create: { width: 2400, height: 2400, channels: 3, background: { r, g: 0, b: 0 } } })
        .png()
        .toBuffer();
    const animated = await sharp([await frame(200), await frame(100), await frame(50)], {
      join: { animated: true },
    })
      .gif()
      .toBuffer();
    assert.equal((await sharp(animated).metadata()).pages, 3);

    await withCeiling(async () => {
      const res = await put(ns, 'avatar', animated, 'image/gif');
      assert.equal(res.status, 200);
    });
    // A resize without the animated option keeps the first frame and drops the
    // rest, so the page count is the assertion that matters here.
    const stored = await readFile(
      blobPathFor(config.dataDir, (await avatarDigest(ns))[0].avatar_blob_digest),
    );
    const meta = await sharp(stored).metadata();
    assert.equal(meta.pages, 3);
    assert.equal(meta.width, 2000);
  });

  test('reports the type of the bytes it kept, after re-encoding them', async () => {
    const ns = await account();
    await withCeiling(async () => {
      const res = await put(ns, 'avatar', await solidPng(4000, 4000), 'image/png');
      assert.equal(res.status, 200);
    });
    const [row] = await sql`SELECT * FROM users WHERE namespace = ${ns}`;
    // The re-encode is a new file, so the type and the byte count have to
    // describe that one rather than what the client sent.
    assert.equal(row.avatar_content_type, 'image/png');
    assert.equal(row.avatar_bytes, (await storedMeta(ns, 'avatar')).bytes);
  });

  test('refuses a signed file that no decoder can read', async () => {
    const ns = await account();
    // The signature is a real PNG header, so the type check passes and the
    // stored-pixel bound would otherwise be the decoder's to enforce.
    const res = await put(ns, 'avatar', TINY_PNG.subarray(0, 20), 'image/png');
    assert.equal(res.status, 415);
  });
});

describe('upload authorization', () => {
  test('requires a session', async () => {
    const ns = await account();
    const res = await request(app)
      .put(apiPath(`/users/${ns}/avatar`))
      .set('Content-Type', 'image/png')
      .send(pngBytes());
    assert.equal(res.status, 401);
  });

  test('refuses another account, including for an admin', async () => {
    // The first account on a fresh database is the bootstrapped admin, so it has
    // to be created first for this to be testing the admin path.
    const adminRes = await signupAndAccept(app, uniqNs());
    const [adminRow] =
      await sql`SELECT role FROM users WHERE namespace = ${adminRes.user.namespace}`;
    assert.equal(adminRow.role, 'admin');

    const owner = await account();
    const res = await request(app)
      .put(apiPath(`/users/${owner}/avatar`))
      .set(bearer(adminRes.token))
      .set('Content-Type', 'image/png')
      .send(pngBytes());
    assert.equal(res.status, 403);
  });
});

describe('serving profile images', () => {
  test('streams the uploaded bytes back', async () => {
    const ns = await account();
    const bytes = pngBytes();
    await put(ns, 'avatar', bytes, 'image/png');

    const res = await request(app).get(apiPath(`/users/${ns}/avatar`));
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /image\/png/);
    assert.equal(Buffer.compare(res.body, bytes), 0);
  });

  // The upload is served from the API origin, and the validator reads the
  // leading signature only, so the response has to forbid content sniffing.
  test('sends nosniff with the bytes', async () => {
    const ns = await account();
    await put(ns, 'avatar', pngBytes(), 'image/png');

    const res = await request(app).get(apiPath(`/users/${ns}/avatar`));
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
  });

  // The two paths have to be cached differently, because only one of them names
  // the bytes it serves. Caching the bare path hard is how a re-upload keeps
  // showing the old picture for a year.
  test('caches the versioned URL immutably, because it names the bytes', async () => {
    const ns = await account();
    const upload = await put(ns, 'avatar', pngBytes(), 'image/png');
    const res = await request(app).get(asPath(upload.body.avatarUrl));
    assert.equal(res.status, 200);
    assert.equal(res.headers['cache-control'], 'public, max-age=31536000, immutable');
  });

  test('makes the bare path revalidate, and answers a match with 304', async () => {
    const ns = await account();
    await put(ns, 'avatar', pngBytes(), 'image/png');
    const res = await request(app).get(apiPath(`/users/${ns}/avatar`));
    assert.equal(res.headers['cache-control'], 'public, max-age=0, must-revalidate');
    const etag = res.headers.etag;
    assert.match(etag, /^"[0-9a-f]{64}"$/);

    const revalidated = await request(app)
      .get(apiPath(`/users/${ns}/avatar`))
      .set('If-None-Match', etag);
    assert.equal(revalidated.status, 304);
  });

  test('gives a reader a new version after a replacement', async () => {
    const ns = await account();
    const first = await put(ns, 'avatar', pngBytes(1), 'image/png');
    const replacement = await put(ns, 'avatar', pngBytes(2), 'image/png');
    assert.notEqual(first.body.avatarUrl, replacement.body.avatarUrl);
  });

  test('sends a reader holding a stale version to the current one', async () => {
    const ns = await account();
    const upload = await put(ns, 'avatar', pngBytes(1), 'image/png');
    const stale = new URL(upload.body.avatarUrl).searchParams.get('v');
    await put(ns, 'avatar', pngBytes(2), 'image/png');

    const res = await request(app).get(apiPath(`/users/${ns}/avatar?v=${stale}`));
    assert.equal(res.status, 302);
    assert.notEqual(
      new URL(res.headers.location, config.publicBaseUrl).searchParams.get('v'),
      stale,
    );

    const followed = await request(app).get(res.headers.location.replace(config.publicBaseUrl, ''));
    assert.equal(followed.status, 200);
  });

  test('serves a replacement under the same URL', async () => {
    const ns = await account();
    await put(ns, 'avatar', pngBytes(1), 'image/png');
    const first = await request(app).get(apiPath(`/users/${ns}/avatar`));
    await put(ns, 'avatar', pngBytes(2), 'image/png');
    const second = await request(app).get(apiPath(`/users/${ns}/avatar`));
    assert.notEqual(Buffer.compare(first.body, second.body), 0);
  });

  test('still redirects to an external reference when no upload exists', async () => {
    const ns = await account();
    await request(app)
      .patch(apiPath(`/users/${ns}`))
      .set(bearer(tokens.get(ns)))
      .send({ bannerUrl: 'https://cdn.example/banner.png' })
      .expect(200);
    const res = await request(app).get(apiPath(`/users/${ns}/banner`));
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, 'https://cdn.example/banner.png');
  });

  test('falls back to the identicon when an avatar has neither', async () => {
    const ns = await account();
    const res = await request(app).get(apiPath(`/users/${ns}/avatar`));
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /svg/);
  });

  test('404s a banner that was never set', async () => {
    const ns = await account();
    const res = await request(app).get(apiPath(`/users/${ns}/banner`));
    assert.equal(res.status, 404);
  });

  test('falls back instead of 500ing when the stored file has gone missing', async () => {
    const ns = await account();
    await put(ns, 'avatar', pngBytes(), 'image/png');
    const [row] = await avatarDigest(ns);
    await rm(blobPathFor(config.dataDir, row.avatar_blob_digest), { force: true });

    const res = await request(app).get(apiPath(`/users/${ns}/avatar`));
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /svg/);
  });

  test('404s an unknown namespace', async () => {
    const res = await request(app).get(apiPath('/users/nope-nope/avatar'));
    assert.equal(res.status, 404);
  });
});

describe('removing a profile image', () => {
  test('reverts to the identicon and frees the bytes', async () => {
    const ns = await account();
    await put(ns, 'avatar', pngBytes(), 'image/png');
    const [row] = await avatarDigest(ns);
    const stored = blobPathFor(config.dataDir, row.avatar_blob_digest);

    const res = await request(app)
      .delete(apiPath(`/users/${ns}/avatar`))
      .set(bearer(tokens.get(ns)));
    assert.equal(res.status, 200);
    assert.equal(res.body.avatarUrl, null);
    assert.ok(!existsSync(stored));
  });

  test('leaves an external reference in place behind the upload', async () => {
    const ns = await account();
    await request(app)
      .patch(apiPath(`/users/${ns}`))
      .set(bearer(tokens.get(ns)))
      .send({ avatarUrl: 'https://cdn.example/a.png' })
      .expect(200);

    const res = await request(app)
      .delete(apiPath(`/users/${ns}/avatar`))
      .set(bearer(tokens.get(ns)));
    assert.equal(res.status, 200);
    assert.equal(res.body.avatarUrl, 'https://cdn.example/a.png');
  });

  test('refuses another account', async () => {
    const owner = await account();
    const other = await account();
    const res = await request(app)
      .delete(apiPath(`/users/${owner}/avatar`))
      .set(bearer(tokens.get(other)));
    assert.equal(res.status, 403);
  });

  // The blob is content-addressed, so an avatar and a banner holding the same
  // bytes are one file on disk. Dropping one of them has to leave the other
  // serving, which means the release cannot skip the account it just wrote.
  // The two kinds are scaled to different sizes, so a shared digest is not
  // something the upload path can be relied on to produce and is set directly.
  const pointBannerAtAvatar = async (ns) => {
    const [row] = await sql`
      SELECT avatar_blob_digest AS digest, avatar_bytes AS bytes
      FROM users WHERE namespace = ${ns}
    `;
    await sql`
      UPDATE users
      SET banner_blob_digest = ${row.digest}, banner_content_type = 'image/png',
          banner_bytes = ${row.bytes}
      WHERE namespace = ${ns}
    `;
  };

  test('keeps the bytes the account still points at with its other image', async () => {
    const ns = await account();
    const shared = pngBytes(5);
    await put(ns, 'avatar', shared, 'image/png');
    await put(ns, 'banner', shared, 'image/png');
    await pointBannerAtAvatar(ns);
    const [row] = await avatarDigest(ns);
    const stored = blobPathFor(config.dataDir, row.avatar_blob_digest);

    await request(app)
      .delete(apiPath(`/users/${ns}/avatar`))
      .set(bearer(tokens.get(ns)))
      .expect(200);

    assert.ok(existsSync(stored));
    const served = await request(app).get(apiPath(`/users/${ns}/banner`));
    assert.equal(served.status, 200);
    assert.equal(Buffer.compare(served.body, shared), 0);
  });

  test('keeps the bytes a replacement shares with the account other image', async () => {
    const ns = await account();
    const shared = pngBytes(5);
    await put(ns, 'avatar', shared, 'image/png');
    await put(ns, 'banner', shared, 'image/png');
    await pointBannerAtAvatar(ns);
    const [row] = await avatarDigest(ns);
    const stored = blobPathFor(config.dataDir, row.avatar_blob_digest);

    // Replacing the avatar releases the digest it used to name, and the banner
    // still names it.
    const replacement = await put(ns, 'avatar', pngBytes(7), 'image/png');
    assert.equal(replacement.status, 200);
    assert.ok(existsSync(stored));
    const served = await request(app).get(apiPath(`/users/${ns}/banner`));
    assert.equal(Buffer.compare(served.body, shared), 0);
  });

  test('frees the bytes once neither image names them', async () => {
    const ns = await account();
    const shared = pngBytes(5);
    await put(ns, 'avatar', shared, 'image/png');
    await put(ns, 'banner', shared, 'image/png');
    await pointBannerAtAvatar(ns);
    const [row] = await avatarDigest(ns);
    const stored = blobPathFor(config.dataDir, row.avatar_blob_digest);

    const del = (kind) =>
      request(app)
        .delete(apiPath(`/users/${ns}/${kind}`))
        .set(bearer(tokens.get(ns)))
        .expect(200);
    await del('avatar');
    assert.ok(existsSync(stored));
    await del('banner');
    assert.ok(!existsSync(stored));
  });
});

describe('swapping one image source for another', () => {
  test('releases the replaced upload', async () => {
    const ns = await account();
    await put(ns, 'avatar', pngBytes(4), 'image/png');
    const [row] = await avatarDigest(ns);
    const first = blobPathFor(config.dataDir, row.avatar_blob_digest);

    await put(ns, 'avatar', pngBytes(8), 'image/png');
    assert.ok(!existsSync(first));
  });

  test('keeps the upload when PATCH installs an external URL', async () => {
    const ns = await account();
    await put(ns, 'avatar', pngBytes(), 'image/png');
    const [row] = await avatarDigest(ns);
    const stored = blobPathFor(config.dataDir, row.avatar_blob_digest);

    const res = await request(app)
      .patch(apiPath(`/users/${ns}`))
      .set(bearer(tokens.get(ns)))
      .send({ avatarUrl: 'https://cdn.example/new.png' })
      .expect(200);

    assert.ok(existsSync(stored));
    // The upload is still what the profile reports, so the URL only takes over
    // once the upload is removed.
    assert.equal(res.body.avatarUrl, await versioned(ns, 'avatar'));
  });

  test('falls back to the URL once the upload is removed', async () => {
    const ns = await account();
    await request(app)
      .patch(apiPath(`/users/${ns}`))
      .set(bearer(tokens.get(ns)))
      .send({ avatarUrl: 'https://cdn.example/fallback.png' })
      .expect(200);
    await put(ns, 'avatar', pngBytes(), 'image/png');

    const res = await request(app)
      .delete(apiPath(`/users/${ns}/avatar`))
      .set(bearer(tokens.get(ns)));

    assert.equal(res.status, 200);
    assert.equal(res.body.avatarUrl, 'https://cdn.example/fallback.png');
  });

  test('keeps bytes that another account still points at', async () => {
    const shared = pngBytes(3);
    const a = await account();
    const b = await account();
    await put(a, 'avatar', shared, 'image/png');
    await put(b, 'avatar', shared, 'image/png');
    const [row] = await avatarDigest(a);
    const stored = blobPathFor(config.dataDir, row.avatar_blob_digest);

    await request(app)
      .patch(apiPath(`/users/${a}`))
      .set(bearer(tokens.get(a)))
      .send({ avatarUrl: 'https://cdn.example/x.png' })
      .expect(200);
    // b still serves the identical bytes, so a's cleanup must not unlink them.
    assert.ok(existsSync(stored));
    const res = await request(app).get(apiPath(`/users/${b}/avatar`));
    assert.equal(res.status, 200);
  });
});

describe('blob collection', () => {
  // gcBlobs skips files younger than an hour, so the mtime has to be aged for a
  // test to observe the sweep.
  async function age(paths) {
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    for (const p of paths) await utimes(p, old, old);
  }

  test('keeps an avatar a users row still points at', async () => {
    const ns = await account();
    await put(ns, 'avatar', pngBytes(), 'image/png');
    const [row] = await avatarDigest(ns);
    const stored = blobPathFor(config.dataDir, row.avatar_blob_digest);
    await age([stored]);

    await gcBlobs(sql, config.dataDir);
    assert.ok(existsSync(stored));
  });

  test('keeps a banner a users row still points at', async () => {
    const ns = await account();
    await put(ns, 'banner', gifBytes(), 'image/gif');
    const [row] = await sql`SELECT banner_blob_digest FROM users WHERE namespace = ${ns}`;
    const stored = blobPathFor(config.dataDir, row.banner_blob_digest);
    await age([stored]);

    await gcBlobs(sql, config.dataDir);
    assert.ok(existsSync(stored));
  });

  test('collects the bytes once the last reference is gone', async () => {
    const ns = await account();
    await put(ns, 'avatar', pngBytes(), 'image/png');
    const [row] = await avatarDigest(ns);
    const stored = blobPathFor(config.dataDir, row.avatar_blob_digest);
    await request(app)
      .delete(apiPath(`/users/${ns}/avatar`))
      .set(bearer(tokens.get(ns)))
      .expect(200);

    assert.ok(!existsSync(stored));
  });

  test('collects an image when its account is deleted', async () => {
    const ns = await account();
    await put(ns, 'avatar', pngBytes(), 'image/png');
    const [row] = await avatarDigest(ns);
    const stored = blobPathFor(config.dataDir, row.avatar_blob_digest);

    await request(app)
      .delete(apiPath(`/users/${ns}`))
      .set(bearer(tokens.get(ns)))
      .expect(204);
    assert.ok(!existsSync(stored));
  });
});

describe('visibility', () => {
  test('reports the upload to a stranger, since profile images are public', async () => {
    const ns = await account();
    await put(ns, 'avatar', pngBytes(), 'image/png');
    const res = await request(app).get(apiPath(`/users/${ns}`));
    assert.equal(res.status, 200);
    assert.equal(res.body.avatarUrl, await versioned(ns, 'avatar'));
  });

  test('includes it in the auth payload, so the UI needs no second fetch', async () => {
    const ns = await account();
    await put(ns, 'avatar', pngBytes(), 'image/png');
    const res = await request(app)
      .get(apiPath('/me'))
      .set(bearer(tokens.get(ns)));
    assert.equal(res.status, 200);
    assert.equal(res.body.avatarUrl, await versioned(ns, 'avatar'));
  });

  test('carries the other profile fields the auth payload used to drop', async () => {
    const ns = await account();
    await request(app)
      .patch(apiPath(`/users/${ns}`))
      .set(bearer(tokens.get(ns)))
      .send({ bio: 'Hello there', website: 'https://kane.dev', github: 'kane' })
      .expect(200);

    const res = await request(app)
      .get(apiPath('/me'))
      .set(bearer(tokens.get(ns)));
    assert.equal(res.body.bio, 'Hello there');
    assert.equal(res.body.website, 'https://kane.dev');
    assert.equal(res.body.github, 'kane');
  });
});
