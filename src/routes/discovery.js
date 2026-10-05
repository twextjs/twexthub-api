import { Router } from 'express';
import { requireAdmin } from '../auth.js';
import { decodeCursor, keysetPage, pageLinks, parseDir, parseLimit } from '../pagination.js';
import { HttpError, notFound } from '../errors.js';
import {
  asString,
  foldText,
  isValidExtensionId,
  isValidNamespace,
  normalizeApiRoot,
} from '../util.js';
import { trendingExtensions, totalDownloads } from '../metrics.js';
import { product } from '../product.js';
import {
  extensionSummaryFromRow,
  legalDocumentToObject,
  pendingVersionToObject,
} from '../serialize.js';

const SORTS = new Set(['recent', 'downloads', 'updated', 'name']);

export function makeDiscoveryRouter({ sql, config, termsGate }) {
  const router = Router();

  function escapeLike(value) {
    return value.replace(/[\\%_]/g, (ch) => '\\' + ch);
  }

  // Keyset pagination over the latest-version-per-extension view. The cursor
  // carries the sort key plus (namespace, id) as the tiebreaker, so every sort
  // needs both a WHERE condition and an ORDER BY on the same columns. Sorting
  // is descending except for name, which reads naturally A→Z.
  const SORT_COLUMNS = {
    downloads: 'downloads',
    name: 'name',
  };
  // recent and updated are keyed on whole microseconds of the timestamp, not
  // the timestamp itself. A Date keeps only milliseconds, so a key built from
  // the ISO string rounds the boundary: rows published within the same
  // millisecond as the cursor are skipped going forward and repeated going
  // back. The same trade the admin queue's cursor makes -- the boundary
  // becomes an expression that cannot be index-seeked, while the ordering
  // below stays on the timestamptz.
  const TIMESTAMP_SORT_KEYS = {
    recent: sql`((extract(epoch from s.published_at) * 1000000)::bigint)`,
    updated: sql`((extract(epoch from s.updated_at) * 1000000)::bigint)`,
  };
  const SORT_TYPES = {
    recent: 'int8',
    updated: 'int8',
    // int8 rather than the bigint alias: the cast is emitted as a quoted type
    // name, and only int8 is a real entry in pg_type.
    downloads: 'int8',
    name: 'text',
  };

  // The sort key moves descending for every sort but name, while the
  // (namespace, id) tiebreaker always moves ascending. A row-wise comparison
  // against the tuple would drag the sort key's direction onto the
  // tiebreaker, skipping or repeating rows whenever the sort key ties, so the
  // two are compared separately.
  function cursorCondition(cursor, sort, back) {
    if (!cursor) return sql``;
    // downloads is a joined aggregate, not a column of the versions subquery,
    // and the timestamp sorts compare their whole-microsecond keys.
    const col =
      sort === 'downloads'
        ? sql`COALESCE(d.total, 0)::bigint`
        : (TIMESTAMP_SORT_KEYS[sort] ?? sql('s.' + SORT_COLUMNS[sort]));
    const key = sql`${cursor.k}::${sql(SORT_TYPES[sort])}`;
    // The name sort reads A→Z and everything else reads newest-first, so which
    // side of the cursor the next rows fall on depends on the sort. The
    // (namespace, id) tiebreaker ascends in the forward direction whatever the
    // sort key does, and only reverses when the whole page does.
    const ascending = sort === 'name';
    const after = ascending !== back ? sql`${col} > ${key}` : sql`${col} < ${key}`;
    const tie = back ? sql`<` : sql`>`;
    return sql`
      AND (${after}
        OR (${col} = ${key}
          AND (s.namespace, s.extension_id) ${tie} (${cursor.ns}, ${cursor.id})))
    `;
  }

  const SORT_ORDER = {
    recent: sql`s.published_at DESC, s.namespace ASC, s.extension_id ASC`,
    updated: sql`s.updated_at DESC, s.namespace ASC, s.extension_id ASC`,
    downloads: sql`downloads DESC, s.namespace ASC, s.extension_id ASC`,
    name: sql`s.name ASC, s.namespace ASC, s.extension_id ASC`,
  };

  const SORT_ORDER_BACK = {
    recent: sql`s.published_at ASC, s.namespace DESC, s.extension_id DESC`,
    updated: sql`s.updated_at ASC, s.namespace DESC, s.extension_id DESC`,
    downloads: sql`downloads ASC, s.namespace DESC, s.extension_id DESC`,
    name: sql`s.name DESC, s.namespace DESC, s.extension_id DESC`,
  };

  async function listLatestVersions({
    req,
    limit,
    cursor,
    sort = 'recent',
    license,
    namespace = null,
    searchFilter = sql``,
  }) {
    const back = parseDir(req.query.dir);
    const rows = await sql`
      SELECT s.*, COALESCE(d.total, 0)::bigint AS downloads,
        ${TIMESTAMP_SORT_KEYS.recent}::text AS published_key,
        ${TIMESTAMP_SORT_KEYS.updated}::text AS updated_key
      FROM (
        SELECT v.*,
          row_number() OVER (
            PARTITION BY namespace, extension_id
            ORDER BY
              CASE WHEN v.status = 'published' THEN 0 ELSE 1 END,
              v.published_at DESC, v.id DESC
          ) AS rn,
          -- updated_at: publication time of the newest accepted version
          MAX(v.published_at) OVER (PARTITION BY namespace, extension_id) AS updated_at
        FROM versions v
        WHERE v.status IN ('published', 'deprecated')
      ) s
      LEFT JOIN (
        SELECT namespace, extension_id, SUM(total_downloads) AS total
        FROM extension_daily_downloads
        GROUP BY namespace, extension_id
      ) d ON d.namespace = s.namespace AND d.extension_id = s.extension_id
      WHERE rn = 1
        ${namespace ? sql`AND s.namespace = ${namespace}` : sql``}
        ${license ? sql`AND s.license = ${license}` : sql``}
        ${searchFilter}
        ${cursorCondition(cursor, sort, back)}
      ORDER BY ${back ? SORT_ORDER_BACK[sort] : SORT_ORDER[sort]}
      LIMIT ${limit + 1}
    `;

    // The timestamp keys come off the query as exact microsecond text, never
    // through a Date, which would round them back to milliseconds.
    const sortKeyOf = (row) => ({
      k:
        sort === 'downloads'
          ? String(Number(row.downloads ?? 0))
          : sort === 'name'
            ? row.name
            : sort === 'recent'
              ? row.published_key
              : row.updated_key,
      ns: row.namespace,
      id: row.extension_id,
    });

    return keysetPage(req, rows, {
      limit,
      back,
      cursor,
      keyOf: sortKeyOf,
      serialize: (row) => {
        const summary = extensionSummaryFromRow(row);
        summary.downloads = Number(row.downloads ?? 0);
        return summary;
      },
    });
  }

  function parseSort(raw) {
    if (raw === undefined) return 'recent';
    if (!SORTS.has(raw)) {
      throw new HttpError(400, {
        title: 'Bad Request',
        detail: 'sort must be one of: recent, downloads, updated, name.',
      });
    }
    return raw;
  }

  // The registry listing, shared with an organization's own extension list so
  // sorting and cursor paging cannot drift between the two. The namespace is a
  // filter rather than a separate collection for the same reason.
  async function listExtensions(req, { namespace = null } = {}) {
    const limit = parseLimit(config, req.query.limit);
    const sort = parseSort(req.query.sort);
    // SPDX identifiers are case-sensitive ("Apache-2.0"), so no normalization.
    const license =
      typeof req.query.license === 'string' && req.query.license.length > 0
        ? req.query.license
        : null;
    const cursor = decodeCursor(req.query.cursor, {
      // recent and updated cursors carry whole-microsecond keys, so they are
      // validated as digit strings rather than free text: a hand-made cursor
      // that cannot cast to int8 is a 400 here, not a Postgres error.
      k: sort === 'recent' || sort === 'updated' ? 'micros' : 'string',
      ns: 'string',
      id: 'string',
    });
    return listLatestVersions({
      req,
      limit,
      cursor,
      sort,
      license,
      namespace,
    });
  }

  router.get('/extensions', async (req, res) => {
    const namespace = asString(req.query.namespace);
    if (namespace !== null && !isValidNamespace(namespace)) {
      throw new HttpError(400, { title: 'Bad Request', detail: 'Invalid namespace.' });
    }
    res.json(await listExtensions(req, { namespace }));
  });

  router.get('/extensions/trending', async (req, res) => {
    // Trending is lenient about a bad limit rather than throwing like
    // parseLimit, so clamp here: a negative or fractional value used to reach
    // the query as a negative or fractional LIMIT.
    const requested = Number(req.query.limit ?? 10);
    const limit = Math.min(Number.isInteger(requested) && requested > 0 ? requested : 10, 50);
    const trending = await trendingExtensions(sql, { limit });
    if (trending.length === 0) {
      return res.json({ data: [], _links: pageLinks(req) });
    }
    const t = trending;
    // Trending is a flat (namespace, id) list, so the pair has to be joined as a
    // pair: two ANY() lists would match every combination of both columns.
    const namespaces = t.map((e) => e.namespace);
    const ids = t.map((e) => e.id);
    const rows = await sql`
      SELECT * FROM (
        SELECT v.*,
          row_number() OVER (
            PARTITION BY v.namespace, v.extension_id
            ORDER BY CASE WHEN v.status = 'published' THEN 0 ELSE 1 END,
                     v.published_at DESC, v.id DESC
          ) AS rn
        FROM versions v
        JOIN unnest(${namespaces}::text[], ${ids}::text[]) AS trending(namespace, extension_id)
          ON trending.namespace = v.namespace AND trending.extension_id = v.extension_id
        WHERE v.status IN ('published', 'deprecated')
      ) s
      WHERE rn = 1
    `;
    const byKey = new Map(trending.map((e) => [`${e.namespace}/${e.id}`, e]));
    const page = rows
      .map((row) => {
        const summary = extensionSummaryFromRow(row);
        summary.downloads = byKey.get(`${row.namespace}/${row.extension_id}`)?.downloads ?? 0;
        return summary;
      })
      .sort((a, b) => Number(b.downloads) - Number(a.downloads));
    res.json({ data: page, _links: pageLinks(req) });
  });

  router.get('/search', async (req, res) => {
    const query = typeof req.query.query === 'string' ? req.query.query.trim() : null;
    const folded = query && query.length > 0 ? foldText(query) : null;
    const limit = parseLimit(config, req.query.limit);
    const sort = parseSort(req.query.sort);
    const license =
      typeof req.query.license === 'string' && req.query.license.length > 0
        ? req.query.license
        : null;
    const cursor = decodeCursor(req.query.cursor, {
      // recent and updated cursors carry whole-microsecond keys, so they are
      // validated as digit strings rather than free text: a hand-made cursor
      // that cannot cast to int8 is a 400 here, not a Postgres error.
      k: sort === 'recent' || sort === 'updated' ? 'micros' : 'string',
      ns: 'string',
      id: 'string',
    });
    const searchFilter = folded
      ? sql`AND search_text LIKE ${'%' + escapeLike(folded) + '%'}`
      : sql``;
    res.json(
      await listLatestVersions({
        req,
        limit,
        cursor,
        sort,
        license,
        searchFilter,
      }),
    );
  });

  router.get('/meta', (req, res) => {
    res.json({
      name: product.name,
      version: product.version,
      tagline: product.tagline,
      homepage: product.homepage,
    });
  });

  router.get('/stats', async (req, res) => {
    const [published, pending, authors, downloads] = await Promise.all([
      sql`SELECT COUNT(DISTINCT (namespace, extension_id)) AS count FROM versions WHERE status IN ('published', 'deprecated')`,
      sql`SELECT COUNT(*) AS count FROM versions WHERE status = 'pending'`,
      sql`SELECT COUNT(DISTINCT owner_id) AS count FROM versions WHERE status IN ('published', 'deprecated')`,
      sql`SELECT COALESCE(SUM(total_downloads), 0)::bigint AS count FROM extension_daily_downloads`,
    ]);
    res.json({
      published: Number(published[0].count),
      pending: Number(pending[0].count),
      authors: Number(authors[0].count),
      downloads: Number(downloads[0].count),
    });
  });

  const XML_ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

  // Badge text is laid out by hand, so the pills have to be as wide as the
  // glyphs they hold. These are DejaVu Sans advance widths in font units, one
  // per printable ASCII code point from 0x20, read out of the font's hmtx
  // table; a flat per-character guess over-pads exactly the narrow glyphs that
  // dominate the right pill (space, |, i, l).
  //
  // The stack below names this font first, and that ordering is load-bearing:
  // the widths above are DejaVu's, so a viewer that substitutes a wider face
  // first would render text wider than the pill holding it. Verdana and Geneva
  // are the next most likely faces on a desktop and both run wider than DejaVu,
  // so they are worth naming explicitly rather than letting each platform pick a
  // default -- a little slack in the gutter absorbs the difference.
  const ADVANCE_UNITS = `
  651 821 942 1716 1303 1946 1597 563 799 799 1024 1716
  651 739 651 690 1303 1303 1303 1303 1303 1303 1303 1303
  1303 1303 690 690 1716 1716 1716 1087 2048 1401 1405 1430
  1577 1294 1178 1587 1540 604 604 1343 1141 1767 1532 1612
  1235 1612 1423 1300 1251 1499 1401 2025 1403 1251 1403 799
  690 799 1716 1024 1024 1255 1300 1126 1300 1260 721 1300
  1298 569 569 1186 569 1995 1298 1253 1300 1300 842 1067
  803 1298 1212 1675 1212 1212 1075 1303 690 1303 1716
  `
    .trim()
    .split(/\s+/)
    .map(Number);
  const UNITS_PER_EM = 2048;
  const BADGE_FONT_SIZE = 11;
  // Fallback advance for a code point the table above does not cover. The mean
  // of printable ASCII is about right for proportional scripts -- Cyrillic and
  // Greek land near it -- so that is what those get.
  const MEAN_ADVANCE = Math.round(
    ADVANCE_UNITS.reduce((sum, units) => sum + units, 0) / ADVANCE_UNITS.length,
  );
  // East Asian wide and fullwidth ranges, plus the emoji blocks, are not
  // proportional at all: each glyph is one em. Measuring them at the mean
  // under-counts by ~40%, which pushes the text out past the edge of its own
  // pill. shields.io hits the same problem and resolves it the same way, by
  // guessing at the em rather than at an average; it simply owns a table with
  // real widths for everything except emoji, so em is its only fallback.
  //
  // Guessing wide is the safe direction to be wrong in: it wastes a few pixels
  // of padding, where guessing narrow clips the text.
  const FULL_WIDTH_RANGES = [
    [0x1100, 0x115f], // Hangul Jamo
    [0x2e80, 0x303e], // CJK radicals, Kangxi radicals, CJK symbols
    [0x3041, 0x33ff], // Hiragana, Katakana, Bopomofo, Hangul compat, Kanbun
    [0x3400, 0x4dbf], // CJK unified ext A
    [0x4e00, 0x9fff], // CJK unified ideographs
    [0xa000, 0xa4cf], // Yi
    [0xac00, 0xd7a3], // Hangul syllables
    [0xf900, 0xfaff], // CJK compatibility ideographs
    [0xfe10, 0xfe19], // vertical forms
    [0xfe30, 0xfe6f], // CJK compatibility forms, small form variants
    [0xff00, 0xff60], // fullwidth ASCII variants
    [0xffe0, 0xffe6], // fullwidth signs
    [0x1f000, 0x1faff], // emoji and pictographs
  ];

  function advanceOf(codePoint) {
    const index = codePoint - 0x20;
    if (index >= 0 && index < ADVANCE_UNITS.length) return ADVANCE_UNITS[index];
    for (const [lower, upper] of FULL_WIDTH_RANGES) {
      if (codePoint >= lower && codePoint <= upper) return UNITS_PER_EM;
    }
    return MEAN_ADVANCE;
  }
  // A fixed gutter either side of the text. It has to clear the ~4.5px the text
  // already sits from the top and bottom: at 5px the long right-hand pill read
  // as flush while the short label pill looked generously padded.
  const BADGE_PADDING = 16;
  // The label is caller-supplied, and the badge is sized to fit it, so an
  // unbounded ?label= would let a short URL ask for an arbitrarily wide SVG.
  // Long real names fit well inside this; the cap only bounds the pathological.
  const MAX_LABEL_WIDTH = 320;

  function textWidth(text) {
    let units = 0;
    for (const char of text) {
      units += advanceOf(char.codePointAt(0));
    }
    return (units * BADGE_FONT_SIZE) / UNITS_PER_EM;
  }

  // Widths are measured on the raw label and the escaped label is what gets
  // written out, because the two render identically -- an entity is how the
  // markup spells a glyph, not extra glyphs. Cutting is therefore a plain
  // per-glyph budget on the raw text and cannot land inside an entity.
  function fitLabel(value) {
    let out = '';
    let units = 0;
    for (const char of String(value)) {
      const advance = advanceOf(char.codePointAt(0));
      if ((units + advance) * BADGE_FONT_SIZE > (MAX_LABEL_WIDTH - BADGE_PADDING) * UNITS_PER_EM) {
        break;
      }
      units += advance;
      out += char;
    }
    return out;
  }

  const round = (value) => Math.round(value * 100) / 100;

  // The right pill's fill is derived from the extension's identity rather than
  // its license, so a registry full of MIT packages is not a wall of identical
  // green. The hue has to be a *hash* and not a random number: a badge is served
  // with a five minute public max-age, so a per-request random colour would
  // hand caches and CDNs different bytes for one URL and the badge would flicker
  // on every reload.
  //
  // It is seeded from the namespace and id, never from ?label=, because the
  // label is caller-supplied -- seeding on it would let anyone repaint any
  // badge by changing the query string.
  //
  // Nothing is lost by dropping the license colour: the license is still spelled
  // out in the pill's text, so the colour is decoration and the meaning is in
  // the words.
  function hashString(value) {
    // FNV-1a, 32-bit. Cheap, and spreads short similar strings like "zoo" and
    // "zooo" across the hue circle instead of clustering them.
    let hash = 0x811c9dc5;
    for (let i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
  }

  function hslToHex(hue, saturation, lightness) {
    const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
    const sector = hue / 60;
    const second = chroma * (1 - Math.abs((sector % 2) - 1));
    const [r, g, b] =
      sector < 1
        ? [chroma, second, 0]
        : sector < 2
          ? [second, chroma, 0]
          : sector < 3
            ? [0, chroma, second]
            : sector < 4
              ? [0, second, chroma]
              : sector < 5
                ? [second, 0, chroma]
                : [chroma, 0, second];
    const match = lightness - chroma / 2;
    const channel = (value) =>
      Math.round((value + match) * 255)
        .toString(16)
        .padStart(2, '0');
    return `#${channel(r)}${channel(g)}${channel(b)}`;
  }

  // WCAG relative luminance and contrast ratio, so "readable" is a checked
  // property rather than a hope about which hue came up.
  function relativeLuminance(hex) {
    const channel = (offset) => {
      const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
      return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  }

  function contrastRatio(background, foreground) {
    const a = relativeLuminance(background);
    const b = relativeLuminance(foreground);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }

  const BADGE_DARK_TEXT = '#333333';
  const BADGE_LIGHT_TEXT = '#ffffff';
  const BADGE_SATURATIONS = [0.5, 0.55, 0.6, 0.65];

  // Returns the pill fill and the text colour to set on top of it. The fill is
  // the lightest version of the colour that still passes 4.5:1 against one of
  // the two text colours, so the badge keeps a vivid colour where it can and
  // only darkens the hues that would otherwise be unreadable. Searching from
  // the light end matters: always darkening instead would converge every hue on
  // the same murky shade, which is the same uniformity this is here to avoid.
  //
  // Hue alone would be 360 buckets, which is a lot of repeats once a registry
  // has a few hundred packages, and neighbouring hues are near enough to look
  // identical side by side. A little saturation variation on top of the hue
  // widens the space and separates neighbours that would otherwise collide.
  function badgeColors(seed) {
    const hash = hashString(seed);
    const hue = hash % 360;
    const saturation = BADGE_SATURATIONS[(hash >>> 9) % BADGE_SATURATIONS.length];
    for (let step = 0; step <= 8; step++) {
      const background = hslToHex(hue, saturation, 0.55 - step * 0.05);
      if (contrastRatio(background, BADGE_LIGHT_TEXT) >= 4.5) {
        return { background, text: BADGE_LIGHT_TEXT };
      }
      if (contrastRatio(background, BADGE_DARK_TEXT) >= 4.5) {
        return { background, text: BADGE_DARK_TEXT };
      }
    }
    // Unreachable: at lightness 0.15 every hue passes against white. Kept so the
    // function is total rather than able to return undefined into a template.
    const background = hslToHex(hue, saturation, 0.15);
    return { background, text: BADGE_LIGHT_TEXT };
  }

  // One pass over every metacharacter, so the ampersands introduced by the
  // earlier entities are not escaped again.
  function xmlEscape(value) {
    return String(value).replace(/[&<>"']/g, (ch) => XML_ENTITIES[ch]);
  }

  // shields-style flat badge: two pills, 20px tall, each sized to its own text
  // plus the gutter. Sizing to the content is what makes the badge look right; a
  // fixed total width either leaves a short label marooned in a huge blue pill
  // or squeezes the right-hand text off the end.
  //
  // The markup is the same for one fact or three. shields.io does the same
  // thing: with no label it sets leftWidth to 0 and the label colour to the
  // message colour, so the left rect is simply zero-width.
  function renderBadgeSvg({ label, message, color, textColor, ariaLabel }) {
    const labelWidth = round(textWidth(label) + BADGE_PADDING);
    const rightWidth = round(textWidth(message) + BADGE_PADDING);
    const totalWidth = round(labelWidth + rightWidth);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="20" viewBox="0 0 ${totalWidth} 20" role="img" aria-label="${xmlEscape(ariaLabel ?? `${label}: ${message}`)}">
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r"><rect width="${totalWidth}" height="20" rx="3"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelWidth}" height="20" fill="#555"/>
    <rect x="${labelWidth}" width="${rightWidth}" height="20" fill="${color}"/>
    <rect width="${totalWidth}" height="20" fill="url(#s)"/>
  </g>
  <g text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="11">
    <text x="${labelWidth / 2}" y="14" fill="#ffffff">${xmlEscape(label)}</text>
    <text x="${labelWidth + rightWidth / 2}" y="14" fill="${textColor}">${xmlEscape(message)}</text>
  </g>
</svg>`;
  }

  // The latest published or deprecated version, which is what every badge
  // variant reports on.
  async function latestBadgeRow(namespace, id) {
    const rows = await sql`
      SELECT * FROM (
        SELECT v.*, row_number() OVER (
          PARTITION BY namespace, extension_id
          ORDER BY CASE WHEN status = 'published' THEN 0 ELSE 1 END,
                   published_at DESC, id DESC
        ) AS rn
        FROM versions v
        WHERE namespace = ${namespace} AND extension_id = ${id}
          AND status IN ('published', 'deprecated')
      ) s
      WHERE rn = 1
    `;
    if (rows.length === 0) throw notFound();
    return rows[0];
  }

  function requestedLabel(req, fallback) {
    return (
      fitLabel(
        typeof req.query.label === 'string' && req.query.label.length > 0
          ? req.query.label
          : fallback,
      ) || fallback
    );
  }

  function sendBadge(res, { label, message, namespace, id, ariaLabel }) {
    const { background, text } = badgeColors(`${namespace}/${id}`);
    res.set('Cache-Control', 'public, max-age=300');
    res
      .type('image/svg+xml')
      .send(renderBadgeSvg({ label, message, color: background, textColor: text, ariaLabel }));
  }

  // One fact per badge: version, downloads, or license.
  //
  // A combined "v1.2.3 | 48k downloads | MIT" pill is the sum of these three and
  // runs about 250px, which is too wide to sit comfortably in a README next to
  // anything else. Each fact alone is 90-140px, and a README can embed just the
  // ones it cares about -- usually version and license, with downloads as an
  // opt-in. That is the same split npm-style badges have always used.
  //
  // The left pill names the fact, so the right pill can be a bare value: the
  // unit lives in the label, which also means no pluralisation to get wrong.
  const BADGE_FIELDS = new Set(['version', 'downloads', 'license']);

  router.get('/badge/@:namespace/:id/:field', async (req, res) => {
    const { namespace, id, field } = req.params;
    // An unrecognised trailing segment is a 404, not a fallback to the combined
    // badge: silently answering a different question than the one asked is worse
    // than not answering.
    if (!BADGE_FIELDS.has(field)) throw notFound();
    if (!isValidNamespace(namespace) || !isValidExtensionId(id)) throw notFound();
    const row = await latestBadgeRow(namespace, id);
    let message;
    if (field === 'version') {
      message = `v${row.version}`;
    } else if (field === 'license') {
      message = row.license;
    } else {
      message = String(Number((await totalDownloads(sql, namespace, id)) ?? 0));
    }
    sendBadge(res, {
      label: requestedLabel(req, field),
      message,
      namespace,
      id,
      ariaLabel: `${field}: ${message}`,
    });
  });

  // All three facts in one pill, for anyone who wants a single badge.
  router.get('/badge/@:namespace/:id', async (req, res) => {
    const { namespace, id } = req.params;
    if (!isValidNamespace(namespace) || !isValidExtensionId(id)) throw notFound();
    const row = await latestBadgeRow(namespace, id);
    const downloads = Number((await totalDownloads(sql, namespace, id)) ?? 0);
    const versionText = `v${row.version}`;
    const downloadsText = downloads === 1 ? '1 download' : `${downloads} downloads`;
    sendBadge(res, {
      label: requestedLabel(req, id),
      message: `${versionText} | ${downloadsText} | ${row.license}`,
      namespace,
      id,
      ariaLabel: `${requestedLabel(req, id)}: ${versionText}`,
    });
  });

  router.get('/feed.atom', async (req, res) => {
    const rows = await sql`
      SELECT * FROM (
        SELECT v.*, row_number() OVER (
          PARTITION BY namespace, extension_id
          ORDER BY CASE WHEN status = 'published' THEN 0 ELSE 1 END,
                   published_at DESC, id DESC
        ) AS rn
        FROM versions v
        WHERE status IN ('published', 'deprecated') AND published_at IS NOT NULL
      ) s
      WHERE rn = 1
      ORDER BY published_at DESC
      LIMIT 50
    `;
    const base = config.publicBaseUrl.replace(/\/$/, '');
    const root = normalizeApiRoot(config.apiRoot);
    const entries = rows
      .map(
        (row) => `  <entry>
    <id>tag:twexthub,${row.published_at.toISOString().slice(0, 10)}:${xmlEscape(
      `@${row.namespace}/${row.extension_id}-${row.version}`,
    )}</id>
    <title>${xmlEscape(`${row.name} v${row.version}`)}</title>
    <link rel="alternate" href="${xmlEscape(
      `${base}${root}/@${row.namespace}/${row.extension_id}`,
    )}"/>
    <published>${row.published_at.toISOString()}</published>
    <updated>${row.published_at.toISOString()}</updated>
    <author><name>${xmlEscape(row.author || row.namespace)}</name></author>
    <summary>${xmlEscape(row.description)}</summary>
  </entry>`,
      )
      .join('\n');
    const feed = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${xmlEscape(product.name)} — new releases</title>
  <id>${xmlEscape(`${base}${root}/feed.atom`)}</id>
  <link rel="self" href="${xmlEscape(`${base}${root}/feed.atom`)}"/>
  <updated>${rows[0]?.published_at?.toISOString() ?? new Date().toISOString()}</updated>
${entries}
</feed>
`;
    res.type('application/atom+xml').send(feed);
  });

  router.get('/terms', async (req, res) => {
    const [row] = await sql`SELECT * FROM legal_documents WHERE kind = 'terms'`;
    if (!row) throw notFound();
    res.json(legalDocumentToObject(row));
  });

  router.get('/privacy', async (req, res) => {
    const [row] = await sql`SELECT * FROM legal_documents WHERE kind = 'privacy'`;
    if (!row) throw notFound();
    res.json(legalDocumentToObject(row));
  });

  router.get('/versions', requireAdmin, termsGate, async (req, res) => {
    if (req.query.status !== 'pending') {
      throw new HttpError(400, {
        title: 'Bad Request',
        detail: 'status must be "pending".',
      });
    }
    const limit = parseLimit(config, req.query.limit);
    const cursor = decodeCursor(req.query.cursor, { c: 'micros', i: 'int' });
    const back = parseDir(req.query.dir);
    const ahead = back ? sql`<` : sql`>`;

    // created_at is keyed on as whole microseconds and compared as whole
    // microseconds, so the boundary is exact. A cursor carrying the column as a
    // timestamp would be rounded to milliseconds somewhere in the round trip and
    // the queue would hand the same version out on two pages. The cost is that
    // the range itself is an expression and so cannot be index-seeked; the
    // ordering stays on the timestamptz, and the pending set is small enough
    // that the filter is not worth an approximate boundary.
    const key = sql`((extract(epoch from created_at) * 1000000)::bigint)`;
    const rows = await sql`
      SELECT *, (${key})::text AS created_key
      FROM versions
      WHERE status = 'pending'
        ${
          cursor
            ? sql`AND (${key} ${ahead} ${cursor.c}::bigint
              OR (${key} = ${cursor.c}::bigint AND id ${ahead} ${cursor.i}))`
            : sql``
        }
      ORDER BY created_at ${back ? sql`DESC` : sql`ASC`}, id ${back ? sql`DESC` : sql`ASC`}
      LIMIT ${limit + 1}
    `;

    res.json(
      keysetPage(req, rows, {
        limit,
        back,
        cursor,
        serialize: (row) => pendingVersionToObject(row, config),
        keyOf: (row) => ({ c: row.created_key, i: Number(row.id) }),
      }),
    );
  });

  // An organization's extension list is the registry listing scoped to its
  // namespace, so the router hands the query out rather than the organization
  // routes keeping a second copy of it: sorting and cursor paging would then
  // have to be kept in step in two places.
  return { router, listExtensions };
}
