import { PassThrough } from 'node:stream';
import { create as createTar, extract as extractTar } from 'tar';

const MAX_ENTRIES = 1000;

// Pack a list of files (relative to cwd) into an in-memory gzip tarball.
export function createTarballBuffer(cwd, files, { gzip = true } = {}) {
  return new Promise((resolve, reject) => {
    const stream = createTar({ gzip, portable: true, cwd }, files);
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

// Expand an in-memory gzip tarball into destDir. Extraction is bounded: entries
// that escape the destination, symlink out of it, or would push past the byte
// and entry-count caps are skipped, so a hostile archive cannot write outside
// the sandbox or exhaust the disk.
export function extractTarballBuffer(buffer, destDir, { maxTotalBytes = Infinity } = {}) {
  return new Promise((resolve, reject) => {
    const input = new PassThrough();
    let accounted = 0;
    let entries = 0;
    const seen = [];
    const upstream = extractTar({
      cwd: destDir,
      gzip: true,
      preservePaths: false,
      onwarn: () => {},
      filter: (filePath, entry) => {
        if (filePath.includes('\0')) return false;
        if (entry.type === 'SymbolicLink' || entry.type === 'Link') return false;
        if (entries >= MAX_ENTRIES) return false;
        if (accounted + Math.max(entry.size, 0) > maxTotalBytes) return false;
        accounted += Math.max(entry.size, 0);
        entries += 1;
        seen.push(filePath);
        return true;
      },
    });
    upstream.on('finish', () => resolve(seen));
    upstream.on('error', (error) => {
      input.destroy();
      reject(error);
    });
    input.pipe(upstream);
    input.end(buffer);
  });
}
