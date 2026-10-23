// Guards the two rules the Prisma conversion is built on: nothing imports
// `postgres` any more, and every raw-SQL statement in `src/` sits inside a
// named function, so a reader can find the reason a statement is raw instead
// of typed. `Prisma.sql`/`Prisma.join`/`Prisma.raw`/`Prisma.empty` build
// fragments and are allowed anywhere; the four entry points that actually run a
// statement are not.
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCANNED_DIRS = ['src', 'test', 'scripts'];

// The functions that own a raw statement, each with one line saying why it
// cannot be typed. Adding a raw statement means adding its function here.
const ALLOWED_RAW_FUNCTIONS = new Map([
  ['acceptTransfer', 'namespace-wide rows move without a typed equivalent'],
  ['acquireAdvisoryLocks', 'advisory lock functions have no typed equivalent'],
  ['aggregateDay', 'both rollup upserts share one snapshot'],
  ['attachIdentity', 'ON CONFLICT DO NOTHING on a composite key'],
  ['claimDue', 'leases claim due rows with FOR UPDATE SKIP LOCKED'],
  ['isExtensionOwner', 'ownership resolves in one statement across roles'],
  ['isOrganizationOwner', 'ownership resolves in one statement across roles'],
  ['latestBadgeRow', 'window ranking picks the newest acceptable version'],
  ['listDeliveries', 'grouped counts alongside the page'],
  ['listLatestVersions', 'window ranking and keyset boundary'],
  ['lockByDeviceCode', 'row lock makes the poll and the approval race-free'],
  ['lockByUserCode', 'row lock makes the approval and the poll race-free'],
  ['makeAuthRouter', 'OIDC transitions update conditionally in one statement'],
  ['makeDiscoveryRouter', 'window ranking, keyset boundaries and rollups'],
  ['makeOrgsRouter', 'row locks and dynamic scoped-table deletes'],
  ['makePackagesRouter', 'row locks, RETURNING and grouped quota arithmetic'],
  ['notifyUsersMatching', 'fan-out insert selects its recipients'],
  ['organizationsOwnedBy', 'one statement joins owners and organizations'],
  ['owned', 'row locks and a grouped refund in one transaction'],
  ['pendingTransfersFor', 'one statement joins both addresses'],
  ['promote', 'conditional status update with RETURNING'],
  ['publishVersion', 'the locked quota check and search-text folding'],
  ['record', 'the bucket increment derives its value from the stored one'],
  ['reconcileOnBoot', 'GREATEST arithmetic in one statement'],
  ['redeliver', 'conditional lease reset with RETURNING'],
  ['refreshTrending', 'window ranking'],
  ['renderRegistryMetrics', 'grouped counts for the scrape'],
  ['runMigrations', 'advisory lock and the history tables'],
  ['scrubBlobs', 'DISTINCT ON has no typed equivalent'],
  ['storeProfileImage', 'the pointer update is one statement'],
  ['totalDownloads', 'grouped sums stay one round trip'],
  ['trendingExtensions', 'window ranking'],
  ['updated', 'conditional status update with RETURNING'],
  ['versionDownloadTotals', 'grouped sums stay one round trip'],
  ['versionDownloads', 'grouped sums stay one round trip'],
]);

const RAW_CALL = /\$(?:query|execute)Raw(?:Unsafe)?\s*\(|\$(?:query|execute)Raw`/;
const POSTGRES_IMPORT = /\bfrom\s+['"]postgres['"]|require\(\s*['"]postgres['"]\s*\)/;

async function walk(dir, out = []) {
  for (const entry of await readdir(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'generated') await walk(rel, out);
    else if (/\.(?:js|mjs)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

// Walks the source once, tracking a stack of `{` scopes and the name of the
// function each one opens. A call site is attributed to the nearest enclosing
// scope that has a name, so a raw statement inside an anonymous callback is
// attributed to the function that owns the callback. Strings, template
// literals, comments and regexes are skipped so their braces do not count.
const BLOCK_KEYWORDS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'else',
  'do',
  'try',
  'finally',
  'return',
  'function',
  'new',
  'typeof',
  'async',
  'await',
]);

function scopeNames(source) {
  const scopes = [];
  const nameAt = new Array(source.length).fill(null);
  let i = 0;
  let lastMeaningful = '';

  // The name in the header immediately before the `{` at `i`, or null when the
  // brace opens something anonymous (an object literal, a destructuring
  // pattern, a bare block). Only a header ending in `)` or `=>` can open a
  // function body, which is what keeps object literals from being named after
  // the property before them.
  const readHeaderName = () => {
    const text = source.slice(Math.max(0, i - 800), i).replace(/\s+$/, '');
    if (text.endsWith('=>')) {
      const match = /(?:^|[;{}\n])\s*(?:const|let|var)\s+(\w+)\s*=[^;{}]*=>$/.exec(text);
      return match ? match[1] : null;
    }
    if (!text.endsWith(')')) return null;
    // Walk back to the `(` that opens the final parameter list. Matching it with
    // a regex means counting nested parens, which a default argument holding a
    // call (`config = loadConfig()`) puts in the header.
    let depth = 0;
    let open = -1;
    for (let p = text.length - 1; p >= 0; p -= 1) {
      if (text[p] === ')') depth += 1;
      else if (text[p] === '(') {
        depth -= 1;
        if (depth === 0) {
          open = p;
          break;
        }
      }
    }
    if (open < 0) return null;
    const before = text.slice(0, open).replace(/\s+$/, '');
    const named = /function\s+(\w+)$/.exec(before);
    if (named) return named[1];
    const method = /(?:^|[;{}\n])\s*(\w+)$/.exec(before);
    return method ? method[1] : null;
  };

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i += 1;
      while (i < source.length && source[i] !== quote) i += source[i] === '\\' ? 2 : 1;
      i += 1;
      continue;
    }
    if (ch === '`') {
      i += 1;
      let depth = 0;
      while (i < source.length) {
        if (source[i] === '\\') {
          i += 2;
          continue;
        }
        if (source[i] === '$' && source[i + 1] === '{') {
          depth += 1;
          i += 2;
          continue;
        }
        if (depth > 0) {
          if (source[i] === '{') depth += 1;
          else if (source[i] === '}') depth -= 1;
          i += 1;
          continue;
        }
        if (source[i] === '`') break;
        i += 1;
      }
      i += 1;
      continue;
    }
    // A `/` in a value position opens a regex; in an operator position it is
    // division. Only the former can hide braces.
    if (ch === '/' && /[=(,:;[!&|?{}+\-*%<>~^]|^$|return$|typeof$|case$/.test(lastMeaningful)) {
      i += 1;
      while (i < source.length && source[i] !== '/' && source[i] !== '\n') {
        i += source[i] === '\\' ? 2 : 1;
      }
      i += 1;
      lastMeaningful = 'x';
      continue;
    }

    if (ch === '{') {
      const own = readHeaderName();
      const inherited = scopes.length > 0 ? scopes[scopes.length - 1].resolved : null;
      // A named function owns its body outright; an anonymous block or object
      // literal leaves the statement attributed to whatever encloses it.
      scopes.push({ resolved: own && !BLOCK_KEYWORDS.has(own) ? own : inherited });
    } else if (ch === '}') {
      if (scopes.length > 0) scopes.pop();
    }

    if (scopes.length > 0) nameAt[i] = scopes[scopes.length - 1].resolved;
    if (!/\s/.test(ch)) lastMeaningful = ch;
    i += 1;
  }
  return nameAt;
}

async function main() {
  const problems = [];
  for (const dir of SCANNED_DIRS) {
    for (const file of await walk(dir)) {
      const source = await readFile(path.join(ROOT, file), 'utf8');
      const lines = source.split('\n');
      const lineStart = [];
      let offset = 0;
      for (const line of lines) {
        lineStart.push(offset);
        offset += line.length + 1;
      }

      lines.forEach((line, i) => {
        if (POSTGRES_IMPORT.test(line)) {
          problems.push(`${file}:${i + 1} imports postgres; use the injected Prisma client`);
        }
      });

      if (!dir.startsWith('src')) continue;
      const names = scopeNames(source);
      lines.forEach((line, i) => {
        if (!RAW_CALL.test(line)) return;
        const name = names[lineStart[i]];
        if (name && ALLOWED_RAW_FUNCTIONS.has(name)) return;
        problems.push(
          `${file}:${i + 1} runs a raw statement outside an allowed raw-query function` +
            (name ? ` (found \`${name}\`)` : ' (found no named function)'),
        );
      });
    }
  }

  if (problems.length > 0) {
    console.error(problems.join('\n'));
    console.error('\nA raw statement belongs in a named function; add that function to');
    console.error('ALLOWED_RAW_FUNCTIONS in scripts/check-prisma-usage.mjs with the reason it');
    console.error('cannot be expressed with typed Prisma calls.');
    process.exit(1);
  }
  console.log('prisma usage check passed');
}

await main();
