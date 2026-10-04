// An uploaded image is served back to browsers from our own origin, so the
// declared Content-Type cannot be trusted: a caller can label arbitrary bytes
// as image/png. Every accepted type is therefore matched against the leading
// signature bytes of the format, and the type the caller declared is only used
// when it agrees with what the bytes actually are. Formats without a signature
// (SVG is XML) are rejected outright -- an SVG is a document that executes
// script in the origin that serves it, so accepting one here would hand every
// account a stored-XSS primitive against every visitor.
const SIGNATURES = [
  {
    type: 'image/png',
    ext: 'png',
    // \x89PNG\r\n\x1a\n then the IHDR length/type.
    test: (b) =>
      b.length > 24 &&
      b[0] === 0x89 &&
      b[1] === 0x50 &&
      b[2] === 0x4e &&
      b[3] === 0x47 &&
      b[4] === 0x0d &&
      b[5] === 0x0a &&
      b[6] === 0x1a &&
      b[7] === 0x0a &&
      b[12] === 0x49 &&
      b[13] === 0x48 &&
      b[14] === 0x44 &&
      b[15] === 0x52,
  },
  {
    type: 'image/jpeg',
    ext: 'jpg',
    // SOI marker followed by any other marker byte.
    test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    type: 'image/gif',
    ext: 'gif',
    // "GIF87a" and "GIF89a" both exist and are both valid.
    test: (b) =>
      b.length > 10 &&
      b[0] === 0x47 &&
      b[1] === 0x49 &&
      b[2] === 0x46 &&
      b[3] === 0x38 &&
      ((b[4] === 0x37 && b[5] === 0x61) || (b[4] === 0x39 && b[5] === 0x61)),
  },
  {
    type: 'image/webp',
    ext: 'webp',
    // RIFF....WEBP
    test: (b) =>
      b.length > 12 &&
      b[0] === 0x52 &&
      b[1] === 0x49 &&
      b[2] === 0x46 &&
      b[3] === 0x46 &&
      b[8] === 0x57 &&
      b[9] === 0x45 &&
      b[10] === 0x42 &&
      b[11] === 0x50,
  },
  {
    type: 'image/avif',
    ext: 'avif',
    // ISO-BMFF ftyp box whose brand is one of the AVIF-compatible ones. The
    // compatible-brand list is the "avif"/"avis" minor version on the major
    // brand, so match the brand string at offset 8 and require "mif1" or "miaf"
    // among the compatible brands.
    test: (b) => {
      if (b.length < 12 || b[4] !== 0x66 || b[5] !== 0x74 || b[6] !== 0x79 || b[7] !== 0x70)
        return false;
      const brand = b.subarray(8, 12).toString('latin1');
      if (brand !== 'avif' && brand !== 'avis') return false;
      const boxLength = b.readUInt32BE(0);
      // Walk the compatible brands rather than trusting a fixed box size, but
      // stop at the declared end of the box and at the buffer end.
      const end = Math.min(b.length, boxLength >= 8 ? boxLength : b.length);
      for (let offset = 16; offset + 4 <= end; offset += 4) {
        const compatible = b.subarray(offset, offset + 4).toString('latin1');
        if (compatible === 'mif1' || compatible === 'miaf') return true;
      }
      return false;
    },
  },
];

const SUPPORTED = new Set(SIGNATURES.map((entry) => entry.type));

/** The image types the upload endpoints accept, for error messages and docs. */
export function supportedImageTypes() {
  return [...SUPPORTED];
}

/**
 * Returns the sniffed image type for `buffer`, or null when the bytes are not
 * one of the accepted raster formats.
 */
export function sniffImageType(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  for (const entry of SIGNATURES) {
    try {
      if (entry.test(buffer)) return entry.type;
    } catch {
      // A truncated header can make a signature check read past the end; that
      // is a malformed upload, not a crash.
      return null;
    }
  }
  return null;
}
