import { HttpError } from './errors.js';

const CURSOR_KEY_TYPES = {
  int: (value) => {
    let n;
    if (typeof value === 'number') n = value;
    else if (typeof value === 'string' && /^[0-9]+$/.test(value)) n = Number(value);
    else return null;
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  },
  string: (value) => (typeof value === 'string' && value.length > 0 ? value : null),
  // Whole microseconds since the epoch, as a timestamptz cursor has to be
  // counted. A cursor cannot carry the column as a timestamp string or a Date:
  // JavaScript keeps only milliseconds, and both it and the database driver
  // quietly round a parsed timestamp down to them, so the cursor would name a
  // moment slightly before the row it came from and that row would come back on
  // the following page. Comparing the same integer expression on both sides of
  // the boundary is exact whatever rounding each side does on its own.
  micros: (value) => {
    const text = typeof value === 'number' ? String(value) : value;
    if (typeof text !== 'string' || !/^[0-9]+$/.test(text)) return null;
    return BigInt(text).toString();
  },
};

export function parseLimit(config, raw) {
  if (raw === undefined) return config.pagination.defaultLimit;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) {
    throw new HttpError(400, { title: 'Bad Request', detail: 'Invalid limit.' });
  }
  const value = Number(raw.trim());
  if (value < 1) throw new HttpError(400, { title: 'Bad Request', detail: 'Invalid limit.' });
  return Math.min(value, config.pagination.maxLimit);
}

// Paging is forward-only in the query, so a page needs to be able to ask for the
// rows on the other side of itself. `dir=back` is that request: same cursor, the
// comparison and the ordering both reversed.
export function parseDir(raw) {
  if (raw === undefined) return false;
  if (raw === 'back') return true;
  throw new HttpError(400, { title: 'Bad Request', detail: 'Invalid dir.' });
}

export function encodeCursor(payload) {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export function decodeCursor(raw, requiredKeys = {}) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new HttpError(400, { title: 'Bad Request', detail: 'Invalid cursor.' });
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new HttpError(400, { title: 'Bad Request', detail: 'Invalid cursor.' });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, { title: 'Bad Request', detail: 'Invalid cursor.' });
  }
  for (const [key, type] of Object.entries(requiredKeys)) {
    const value = CURSOR_KEY_TYPES[type]?.(parsed[key]);
    if (value === null || value === undefined) {
      throw new HttpError(400, { title: 'Bad Request', detail: 'Invalid cursor.' });
    }
    parsed[key] = value;
  }
  return parsed;
}

// Rebuild the request's own URL with some query parameters replaced. A null
// value deletes the parameter, which is how the forward link drops the `dir=back`
// that produced it: without it the link would page backwards again.
function pageUrl(req, overrides) {
  const url = new URL(req.originalUrl, 'http://pagination.invalid');
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null || value === undefined) url.searchParams.delete(key);
    else url.searchParams.set(key, value);
  }
  return `${url.pathname}${url.search}`;
}

// The `_links` block every collection carries. `self` is the request as it was
// made, and each neighbour is a full URL the client can hand straight back,
// cursor included, instead of assembling a query of its own.
export function pageLinks(req, { next = null, prev = null } = {}) {
  return { self: pageUrl(req, {}), next, prev };
}

// Turn one over-fetched keyset result into a page plus the links to its
// neighbours, and drop the cursor fields the client should no longer assemble
// by hand.
//
// `rows` is the query's output: the first `limit` rows in the requested
// direction, plus one more if the page has a neighbour that way. Going back runs
// the query in the opposite order, which walks out from the anchor towards the
// rows before it, so the page is that head of the result flipped back into
// display order. Either way the surplus row is the last one and gets dropped,
// which keeps the client from keeping a stack of cursors it visited: every page
// knows how to undo itself.
//
// The two neighbours are not read off the fetch. A page always points forward
// at its oldest row and backward at its newest, and each link appears only when
// a page really exists in that direction — an incoming cursor is itself the
// proof of a previous page, and one surplus row is the proof of a next one.
export function keysetPage(req, rows, { limit, back, cursor, serialize, keyOf, extra }) {
  const surplus = rows.length > limit;
  const kept = surplus ? rows.slice(0, limit) : rows;
  const page = back ? kept.reverse() : kept;

  const hasForward = page.length > 0 && (back ? Boolean(cursor) : surplus);
  const hasBackward = page.length > 0 && (back ? surplus : Boolean(cursor));
  const last = page[page.length - 1];
  const first = page[0];

  return {
    ...extra,
    data: page.map(serialize),
    _links: pageLinks(req, {
      next: hasForward ? pageUrl(req, { cursor: encodeCursor(keyOf(last)), dir: null }) : null,
      prev: hasBackward ? pageUrl(req, { cursor: encodeCursor(keyOf(first)), dir: 'back' }) : null,
    }),
  };
}

// The same shape for a list whose page is an offset into a set the server has
// already materialised. There is no key to compare against, so the neighbour
// offsets are arithmetic, and `dir` has nothing to reverse.
export function offsetPage(req, rows, { limit, offset, total, serialize }) {
  const page = rows;
  const hasForward = offset + page.length < total;
  const hasBackward = offset > 0;
  return {
    data: page.map(serialize),
    _links: pageLinks(req, {
      next: hasForward
        ? pageUrl(req, { cursor: encodeCursor({ o: offset + page.length + 1 }) })
        : null,
      prev: hasBackward
        ? pageUrl(req, { cursor: encodeCursor({ o: Math.max(1, offset - limit + 1) }) })
        : null,
    }),
  };
}
