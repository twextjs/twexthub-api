import { readFile } from 'node:fs/promises';
import path from 'node:path';

const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts']);

// A single line can match several patterns, and a minified file can put
// thousands of matches on one line, so the report is capped. The cap is per
// version: a handful of hits is enough to tell a reviewer what to look at.
const MAX_WARNINGS = 50;

const PATTERNS = [
  {
    code: 'fetch',
    // A member call is left alone: Scratch.fetch() is the sandboxed wrapper
    // TurboWarp asks extensions to use, so flagging it would be noise.
    match: /(?<!\.)\bfetch\s*\(/g,
    message: 'Calls fetch() directly; prefer Scratch.fetch().',
  },
  {
    code: 'eval',
    match: /\beval\s*\(/g,
    message: 'Runs a string as code with eval().',
  },
  {
    code: 'new-function',
    match: /\bnew\s+Function\b/g,
    message: 'Builds a function from a string with new Function().',
  },
  {
    code: 'xmlhttprequest',
    match: /\bXMLHttpRequest\b/g,
    message: 'Opens a raw XMLHttpRequest instead of using Scratch.fetch().',
  },
  {
    code: 'insecure-http',
    match: /http:\/\//g,
    message: 'References a plaintext http:// URL.',
  },
];

// Scan the extracted project for patterns an author should know about before
// the version reaches a reviewer. `files` is the extracted entry list, which
// the tarball reader has already checked stays inside projectDir.
export async function scanSourceWarnings(projectDir, files) {
  const warnings = [];
  // The tarball reader reports every accepted entry, so a tarball with
  // duplicate names lists a path twice. Dedupe before scanning or the second
  // pass repeats each warning and eats into the cap.
  for (const file of [...new Set(files)].sort()) {
    if (!SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase())) continue;
    let text;
    try {
      text = await readFile(path.join(projectDir, file), 'utf8');
    } catch {
      continue;
    }
    const found = [];
    for (let order = 0; order < PATTERNS.length; order++) {
      const pattern = PATTERNS[order];
      // Matching the whole text lets `\s` span a newline, so an expression
      // broken across lines (`fetch(\n...)`, `new\nFunction`) is still caught.
      // Matches arrive in order, so the line counter only moves forward and a
      // line that already produced a hit is skipped.
      let line = 1;
      let nextNewline = text.indexOf('\n');
      let lastLine = 0;
      let added = 0;
      for (const match of text.matchAll(pattern.match)) {
        while (nextNewline !== -1 && match.index > nextNewline) {
          line += 1;
          nextNewline = text.indexOf('\n', nextNewline + 1);
        }
        if (line === lastLine) continue;
        lastLine = line;
        found.push({ order, line, code: pattern.code, message: pattern.message });
        // Cap each pattern on its own, not on the shared list: capping in
        // pattern order would drop early lines from a later pattern and keep
        // late lines from an earlier one, so the sort below could not recover
        // the first MAX_WARNINGS findings in source order.
        if (++added >= MAX_WARNINGS) break;
      }
    }
    // Read in source order: top to bottom, and within a line the pattern order.
    found.sort((a, b) => a.line - b.line || a.order - b.order);
    for (const warning of found) {
      warnings.push({
        code: warning.code,
        file,
        line: warning.line,
        message: warning.message,
      });
      if (warnings.length >= MAX_WARNINGS) return warnings;
    }
  }
  return warnings;
}
