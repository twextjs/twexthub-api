import { existsSync, statSync } from 'node:fs';
import { Router } from 'express';
import { notFound } from '../errors.js';
import { canSee, isAdmin } from '../auth.js';
import { blobPathFor, hashFile } from '../blobs.js';

// A digest is only as secret as the URL carrying it, so the blob route applies
// the same status and visibility rules as the download route: anyone can fetch
// compiled output that is published and public, everything else needs to pass
// the caller's access check.
const PUBLIC_STATUSES = new Set(['published', 'deprecated', 'yanked']);

export function makeBlobsRouter({ sql, config }) {
  const router = Router();

  router.get('/blobs/:digest', async (req, res) => {
    // The capture is the only value that reaches blobPathFor: a digest that
    // survived this match is pure lowercase hex, so no separator or traversal
    // sequence can be part of the assembled path.
    const digestMatch = /^([0-9a-f]{64})$/.exec(req.params.digest);
    if (!digestMatch) throw notFound();
    const [, digest] = digestMatch;
    const abs = blobPathFor(config.dataDir, digest);
    if (!existsSync(abs)) throw notFound();
    const rows = await sql`
      SELECT namespace, extension_id, status, visibility, blob_size
      FROM versions
      WHERE blob_digest = ${digest}
      ORDER BY id DESC
    `;
    if (rows.length === 0) throw notFound();
    const [row] = rows;
    const isPublic = rows.some(
      (candidate) => PUBLIC_STATUSES.has(candidate.status) && candidate.visibility === 'public',
    );
    if (isPublic) {
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
    } else {
      // Same status rule as the download route, and it comes first: canSee
      // answers visibility, so asking it about a pending or staging row would
      // let its owner read a blob the download route refuses.
      if (!PUBLIC_STATUSES.has(row.status) && !(row.status === 'pending' && isAdmin(req.auth)))
        throw notFound();
      if (!(await canSee(sql, req.auth?.user ?? null, row))) throw notFound();
      res.set('Cache-Control', 'private, no-store');
    }
    if (row.blob_size !== null && row.blob_size !== undefined) {
      if (statSync(abs).size !== Number(row.blob_size)) {
        throw notFound('Blob integrity check failed.');
      }
    }
    if ((await hashFile(abs)) !== digest) throw notFound('Blob integrity check failed.');
    res.type('application/javascript');
    res.sendFile(abs);
  });

  return router;
}
