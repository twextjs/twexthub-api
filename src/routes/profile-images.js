import { createHash } from 'node:crypto';
import express, { Router } from 'express';
import { requireScope } from '../auth.js';
import {
  MAX_PROFILE_IMAGE_BYTES,
  profileImagePointer,
  removeProfileImageBlob,
  resolveProfileImage,
  storeProfileImage,
} from '../profile-images.js';
import { forbidden, HttpError, notFound } from '../errors.js';
import { isValidNamespace } from '../util.js';

// An account and an organization both publish an avatar and a banner, and the
// awkward parts of that are the same for both: three states per kind (upload,
// external reference, absent), a URL that names the exact bytes so it can be
// cached hard, a 304 for the unversioned URL, and a last owner of the bytes
// keeping a replaced file alive. The routes live here so an organization's
// images behave identically to an account's instead of being a second
// implementation that drifts.
//
// The two sides differ only in who may write and what the row is serialized
// into, so the caller supplies those:
//
//   load(namespace)      -> the row, or throws 404
//   mayWrite(row, req)   -> the caller's right to replace an image, awaited so
//                           an owner-list lookup can decide it
//   serialize(row)       -> the response body after a write or a delete
export function makeProfileImageRouter({ sql, config, load, mayWrite, serialize }) {
  const router = Router();

  // One endpoint per image kind serves all three states in priority order: an
  // uploaded image is streamed from the blob store, an external reference is
  // redirected, and an avatar with neither falls back to the namespace
  // identicon. Serving the upload here rather than publishing a blob URL keeps
  // the URL stable across re-uploads, so a client that cached it does not
  // break when the picture changes.
  const serve = (kind, fallback) => async (req, res) => {
    if (!isValidNamespace(req.params.namespace)) throw notFound();
    const row = await load(req.params.namespace);
    // The upload is tried first because a profile can hold both, and the file
    // it uploaded is the one the instance is responsible for serving.
    const stored = await resolveProfileImage(config, row, kind);
    if (stored) {
      // A URL carrying the digest names the exact bytes, so it can be cached
      // hard: a replacement upload is published under a new URL rather than
      // served behind the old one. The path without a version is the same
      // before and after a re-upload, so it revalidates instead, and a stale
      // version is sent to the current one rather than answered with bytes the
      // URL did not name.
      const asked = typeof req.query.v === 'string' ? req.query.v : null;
      if (asked !== null && asked !== stored.digest.slice(0, 16)) {
        res.redirect(
          302,
          `${req.baseUrl}/${row.namespace}/${kind}?v=${stored.digest.slice(0, 16)}`,
        );
        return;
      }
      if (asked === null) {
        res.set('Cache-Control', 'public, max-age=0, must-revalidate');
        res.set('ETag', `"${stored.digest}"`);
        if (req.headers['if-none-match'] === `"${stored.digest}"`) {
          res.status(304).end();
          return;
        }
      } else {
        res.set('Cache-Control', 'public, max-age=31536000, immutable');
      }
      res.set('Content-Type', stored.contentType);
      // The validator reads the leading signature only, so an upload can carry
      // anything after it. These bytes are served from the API origin, and
      // nosniff is what keeps a browser from reading past the declared type.
      res.set('X-Content-Type-Options', 'nosniff');
      if (stored.expectedSize !== null && stored.expectedSize !== stored.size) {
        // The row and the file disagree. Serving a truncated image is worse than
        // reporting the damage, so fail loudly instead of caching it.
        throw new HttpError(500, {
          title: 'Internal Server Error',
          detail: `Stored ${kind} image does not match its recorded size.`,
        });
      }
      res.set('Content-Length', String(stored.size));
      res.sendFile(stored.abs);
      return;
    }
    const external = kind === 'avatar' ? row.avatar_url : row.banner_url;
    if (external) {
      res.redirect(external);
      return;
    }
    if (!fallback) throw notFound('No banner has been set.');
    res.set('Cache-Control', 'public, max-age=3600');
    res.type('image/svg+xml').send(identiconSvg(row.namespace));
  };

  // Raw bodies rather than multipart: the caller uploads one file, the file is
  // the entire payload, and parsing multipart here would mean accepting a
  // second content type that carries no extra meaning for this endpoint.
  const rawImageBody = express.raw({
    type: ['image/*', 'application/octet-stream'],
    // The ceiling, not the limit: the parser is built once, so it reads up to
    // the largest body any configuration allows and validateProfileImage
    // applies the configured limit on the request that arrives.
    limit: MAX_PROFILE_IMAGE_BYTES,
  });

  const upload = (kind) => [
    requireScope('manage:account'),
    rawImageBody,
    async (req, res) => {
      const target = await load(req.params.namespace);
      if (!(await mayWrite(target, req))) {
        throw forbidden('You can only change your own profile images.');
      }
      const declared = req.get('content-type');
      const stored = await storeProfileImage(sql, config, target, kind, req.body, declared);
      // The replaced image is only unlinked after the new pointer is committed,
      // and only when nothing else references those bytes.
      if (stored.previous && stored.previous !== stored.digest) {
        await removeProfileImageBlob(sql, config, stored.previous);
      }
      res.json(serialize(await load(req.params.namespace)));
    },
  ];

  // Removes an upload. An external reference, if the profile has one, becomes
  // the image again; otherwise the avatar falls back to the identicon and the
  // banner disappears.
  const clear = (kind) => [
    requireScope('manage:account'),
    async (req, res) => {
      const target = await load(req.params.namespace);
      if (!(await mayWrite(target, req))) {
        throw forbidden('You can only change your own profile images.');
      }
      const { digest, updates } = profileImagePointer(target, kind);
      await sql`
        UPDATE users
        SET ${sql(updates)}
        WHERE id = ${target.id}
      `;
      if (digest) await removeProfileImageBlob(sql, config, digest);
      res.json(serialize(await load(req.params.namespace)));
    },
  ];

  router.get('/:namespace/avatar', serve('avatar', true));
  router.get('/:namespace/banner', serve('banner', false));
  router.put('/:namespace/avatar', ...upload('avatar'));
  router.put('/:namespace/banner', ...upload('banner'));
  router.delete('/:namespace/avatar', ...clear('avatar'));
  router.delete('/:namespace/banner', ...clear('banner'));

  return router;
}

// 8x8 horizontally-mirrored identicon: the left 4 columns are decided by the
// namespace's SHA-256, then mirrored. Two of the hash bytes pick one of six
// hue-rotated foreground colors on a fixed light background.
export function identiconSvg(namespace) {
  const hash = createHash('sha256').update(namespace).digest();
  const cells = [];
  for (let y = 0; y < 8; y += 1) {
    const left = [];
    for (let x = 0; x < 4; x += 1) {
      left.push(hash[y * 4 + x] % 2 === 1);
    }
    cells.push([...left, ...left.toReversed()]);
  }
  const hue = hash[31] % 360;
  const rect = [];
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      if (cells[y][x]) rect.push(`<rect x="${x * 12}" y="${y * 12}" width="12" height="12"/>`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">
  <rect width="96" height="96" fill="hsl(${hue}, 18%, 92%)"/>
  <g fill="hsl(${hue}, 65%, 45%)">${rect.join('')}</g>
</svg>`;
}
