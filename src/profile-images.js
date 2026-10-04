import { stat } from 'node:fs/promises';
import sharp from 'sharp';
import { sniffImageType, supportedImageTypes } from './image-sniff.js';
import { BLOB_GC_LOCK_KEY, blobPathFor, removeBlobIfUnused, storeBlobBuffer } from './blobs.js';
import { payloadTooLarge, unsupportedMediaType } from './errors.js';

// The body parser is built once, when the routes are wired, so it cannot read
// the configured limit the way validateProfileImage does. It accepts up to this
// ceiling and the configured limit is enforced per request, which is what keeps
// limits.maxProfileImageBytes hot. The ceiling is the hard cap: a configured or
// per-kind limit above it is unreachable, because this is the largest body the
// route will read.
export const MAX_PROFILE_IMAGE_BYTES = 16 * 1024 * 1024;

// Which images an account can upload, and how each maps to the columns and the
// serving path. Keeping both in one table means adding a third image later
// cannot half-work in the upload route and the serving route.
export const PROFILE_IMAGES = {
  avatar: {
    digestColumn: 'avatar_blob_digest',
    typeColumn: 'avatar_content_type',
    bytesColumn: 'avatar_bytes',
    // Avatars are small and render on every listing, so the ceiling is tighter
    // than a banner's. Both default from limits.maxProfileImageBytes when the
    // operator has not overridden them.
    maxBytes: 'maxAvatarBytes',
    // An avatar keeps its aspect ratio: cropping one to a square would cut out
    // whatever the account chose to frame, and the servers that do square it
    // let the holder pick the crop.
    width: 2000,
    height: 2000,
    fit: 'inside',
  },
  banner: {
    digestColumn: 'banner_blob_digest',
    typeColumn: 'banner_content_type',
    bytesColumn: 'banner_bytes',
    maxBytes: 'maxBannerBytes',
    // A banner is a decorative strip behind a profile, so it is cropped to the
    // ratio and scaled to exactly this size. Anything else leaves a client
    // guessing how to crop it, and every client guesses differently.
    width: 3000,
    height: 1000,
    fit: 'cover',
  },
};

function limitFor(config, kind) {
  const key = PROFILE_IMAGES[kind].maxBytes;
  return config.limits?.[key] ?? config.limits?.maxProfileImageBytes ?? 2 * 1024 * 1024;
}

/**
 * Validates an uploaded profile image and returns the metadata to store, or
 * throws. `declaredType` is what the caller sent as Content-Type; it is only
 * used to reject a mismatch, never to decide what the bytes are.
 */
export function validateProfileImage(config, kind, buffer, declaredType) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw payloadTooLarge('Image body is empty.');
  }
  const max = limitFor(config, kind);
  if (buffer.length > max) {
    throw payloadTooLarge(
      `Image is larger than the ${Math.floor(max / 1024)} KiB limit for this field.`,
    );
  }
  const sniffed = sniffImageType(buffer);
  if (!sniffed) {
    throw unsupportedMediaType(
      `Unsupported image type. Upload a PNG, JPEG, GIF, WebP, or AVIF file (${supportedImageTypes().join(', ')}).`,
    );
  }
  // A client that labels a real PNG as a JPEG has a bug; a client that labels
  // arbitrary bytes as a PNG is an attack. Rejecting only the mismatched
  // labels is what makes the sniff authoritative.
  const declared = String(declaredType ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (declared && declared !== 'application/octet-stream' && declared !== sniffed) {
    throw unsupportedMediaType(
      `Image content type ${declared} does not match the uploaded data, which is ${sniffed}.`,
    );
  }
  return { contentType: sniffed, size: buffer.length };
}

/**
 * Scales an upload to the stored size for its kind, or hands the bytes back
 * untouched when they already fit.
 *
 * Nothing is ever enlarged. An account that uploads a 400px avatar gets their
 * own file back rather than a five-times-larger copy of it, and a small banner
 * that is already 3:1 is left at the size it was authored at instead of being
 * stretched to fill 3000x1000.
 *
 * A file that will not decode is refused rather than stored as-is: the stored
 * pixels are what this bounds, and letting an unreadable upload past would make
 * the bound a property of the decoder rather than of the endpoint.
 */
export async function fitProfileImage(kind, buffer, contentType) {
  const { width, height, fit } = PROFILE_IMAGES[kind];
  let source;
  try {
    source = await sharp(buffer).metadata();
  } catch {
    throw unsupportedMediaType('The uploaded file is not a readable image.');
  }
  // An avatar is left alone at any size that fits, since inside is a bound and
  // not a target. A banner has to reach the ratio as well as the size, so the
  // only banner that needs no work is the one already at 3000x1000: a larger one
  // still has to be cropped and scaled down. Nothing below enlarges anything, so
  // a banner too small to fill the box comes out the size it went in at.
  const settled =
    fit === 'cover'
      ? source.width === width && source.height === height
      : source.width <= width && source.height <= height;
  if (settled) return { buffer, contentType };

  // A GIF's frames are scaled as frames. Without this the resize keeps the
  // first one and quietly throws the rest away, which is a lossy change nobody
  // asked for on a file that was accepted seconds earlier.
  let resized;
  try {
    resized = await sharp(buffer, { animated: contentType === 'image/gif' })
      .resize(width, height, { fit, position: 'centre', withoutEnlargement: true })
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw unsupportedMediaType('The uploaded file is not a readable image.');
  }
  // A small banner reaches none of this and comes back the same size it went in
  // at, so the re-encode would only cost CPU and change the bytes for nothing.
  // An animated GIF never matches here, its height being all its frames
  // stacked, which is the right way round: that one does have to be re-encoded.
  if (resized.info.width === source.width && resized.info.height === source.height) {
    return { buffer, contentType };
  }
  // sharp keeps the input format, so this agrees with what was sniffed before
  // the resize; re-reading it is what keeps the stored type a fact about the
  // stored bytes rather than an assumption carried across an encode.
  return {
    buffer: resized.data,
    contentType: sniffImageType(resized.data) ?? contentType,
  };
}

/**
 * Stores the image and points the account's column at it, in one transaction.
 *
 * The blob lands on disk before the row that references it, which is the same
 * order publish uses, and the shared lock keeps the collector from unlinking
 * the file between the two statements.
 */
export async function storeProfileImage(sql, config, user, kind, buffer, declaredType) {
  const { contentType } = validateProfileImage(config, kind, buffer, declaredType);
  const columns = PROFILE_IMAGES[kind];
  const previous = user[columns.digestColumn] ?? null;
  const fitted = await fitProfileImage(kind, buffer, contentType);
  const size = fitted.buffer.length;
  const { digest } = await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock_shared(hashtextextended(${BLOB_GC_LOCK_KEY}, 0))`;
    const stored = await storeBlobBuffer(config.dataDir, fitted.buffer);
    // The external reference is left alone. An account can hold a URL and an
    // upload at once; the upload is what a visitor sees, and the URL is what
    // comes back if the upload is removed, so neither write has to destroy the
    // other. It is also the only copy the instance controls, and dropping it
    // because someone picked a file would silently discard it.
    await tx`
      UPDATE users
      SET ${tx(columns.digestColumn)} = ${stored.digest},
          ${tx(columns.typeColumn)} = ${fitted.contentType},
          ${tx(columns.bytesColumn)} = ${size}
      WHERE id = ${user.id}
    `;
    return stored;
  });
  return { digest, contentType: fitted.contentType, size, previous };
}

/**
 * Resolves a stored image to an on-disk path and metadata, or null when the
 * account has no upload for this kind. A row that points at a digest whose
 * file has gone missing reads as "no upload" so the caller can fall back
 * rather than 500.
 */
export async function resolveProfileImage(config, user, kind) {
  const columns = PROFILE_IMAGES[kind];
  const digest = user[columns.digestColumn];
  if (!digest) return null;
  const abs = blobPathFor(config.dataDir, digest);
  let size;
  try {
    size = (await stat(abs)).size;
  } catch {
    return null;
  }
  return {
    abs,
    digest,
    size,
    contentType: user[columns.typeColumn] ?? 'application/octet-stream',
    expectedSize: user[columns.bytesColumn] ?? null,
  };
}

/**
 * Describes what dropping a kind's upload pointer means for the account: the
 * columns to null, and the digest that may now be collectable.
 *
 * This computes nothing and writes nothing. The caller commits the row with
 * `updates` and only then releases the bytes, so the unlink never runs for a
 * pointer that is still set.
 */
export function profileImagePointer(user, kind) {
  const columns = PROFILE_IMAGES[kind];
  return {
    digest: user[columns.digestColumn] ?? null,
    updates: {
      [columns.digestColumn]: null,
      [columns.typeColumn]: null,
      [columns.bytesColumn]: null,
    },
  };
}

/**
 * Unlinks a profile image's bytes once nothing points at them.
 *
 * The blob store is shared with version uploads and is content-addressed, so a
 * digest can be referenced by a version row, by an account's avatar, by that
 * same account's banner, or by all of them. removeBlobIfUnused asks about every
 * one of those under the GC lock before it unlinks, so the check cannot go
 * stale between the decision and the delete.
 *
 * Callers run this after the pointer update has committed, so the account that
 * just dropped its avatar no longer names those bytes in that column. Excluding
 * its row would also hide the other column on the same account, which is how an
 * avatar and a banner that share bytes would end up with the file unlinked under
 * the banner.
 */
export async function removeProfileImageBlob(sql, config, digest) {
  return removeBlobIfUnused(sql, config, digest, null);
}
