import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scanSourceWarnings } from '../src/risky-patterns.js';

async function writeProject(files) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'twexthub-scan-'));
  for (const [name, contents] of Object.entries(files)) {
    const abs = path.join(dir, name);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, contents);
  }
  return dir;
}

test('reports each risky pattern with its file and line, sorted by file', async () => {
  const dir = await writeProject({
    'src/b.js': 'eval("x");\n',
    'src/index.js': [
      'const body = fetch("http://example.com");',
      'new Function("return 1")();',
      'const request = new XMLHttpRequest();',
    ].join('\n'),
  });
  try {
    const warnings = await scanSourceWarnings(dir, ['src/index.js', 'src/b.js']);
    assert.deepEqual(warnings, [
      { code: 'eval', file: 'src/b.js', line: 1, message: 'Runs a string as code with eval().' },
      {
        code: 'fetch',
        file: 'src/index.js',
        line: 1,
        message: 'Calls fetch() directly; prefer Scratch.fetch().',
      },
      {
        code: 'insecure-http',
        file: 'src/index.js',
        line: 1,
        message: 'References a plaintext http:// URL.',
      },
      {
        code: 'new-function',
        file: 'src/index.js',
        line: 2,
        message: 'Builds a function from a string with new Function().',
      },
      {
        code: 'xmlhttprequest',
        file: 'src/index.js',
        line: 3,
        message: 'Opens a raw XMLHttpRequest instead of using Scratch.fetch().',
      },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('leaves the sanctioned wrapper and unrelated identifiers alone', async () => {
  const dir = await writeProject({
    'src/index.js': [
      'const response = await Scratch.fetch("https://example.com");',
      'const prefetch = 1;',
      'return evaluate(prefetch);',
    ].join('\n'),
  });
  try {
    assert.deepEqual(await scanSourceWarnings(dir, ['src/index.js']), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ignores files that are not JavaScript source', async () => {
  const dir = await writeProject({
    'twext.yml': 'description: fetch("http://example.com")\n',
    'README.md': 'See http://example.com for details.\n',
  });
  try {
    assert.deepEqual(await scanSourceWarnings(dir, ['twext.yml', 'README.md']), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('caps the report so a minified file cannot produce an unbounded row', async () => {
  const dir = await writeProject({
    'src/index.js': Array.from({ length: 80 }, () => 'eval("x");').join('\n'),
  });
  try {
    assert.equal((await scanSourceWarnings(dir, ['src/index.js'])).length, 50);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('keeps the first findings in source order when a later pattern is capped', async () => {
  // eval is a later entry in PATTERNS than fetch, so a shared-list cap fills
  // with fetch first and drops these earlier eval lines. The assertion below
  // fails under that behavior and passes only when each pattern is capped on
  // its own.
  const lines = [
    ...Array.from({ length: 60 }, () => 'eval("x");'),
    ...Array.from({ length: 40 }, () => ''),
    ...Array.from({ length: 60 }, () => 'fetch("https://example.com");'),
  ];
  const dir = await writeProject({ 'src/index.js': lines.join('\n') });
  try {
    const warnings = await scanSourceWarnings(dir, ['src/index.js']);
    assert.equal(warnings.length, 50);
    assert.deepEqual(
      warnings.map((warning) => warning.code),
      Array.from({ length: 50 }, () => 'eval'),
    );
    assert.deepEqual(
      warnings.map((warning) => warning.line),
      Array.from({ length: 50 }, (_, index) => index + 1),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('scans a path listed twice only once', async () => {
  const dir = await writeProject({ 'src/index.js': 'eval("x");\n' });
  try {
    const once = await scanSourceWarnings(dir, ['src/index.js']);
    const twice = await scanSourceWarnings(dir, ['src/index.js', 'src/index.js']);
    assert.deepEqual(twice, once);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('catches risky patterns split across lines', async () => {
  const dir = await writeProject({
    'src/index.js': [
      'const body = fetch',
      '  ("http://example.com");',
      'const build = new',
      '  Function("return 1");',
    ].join('\n'),
  });
  try {
    const warnings = await scanSourceWarnings(dir, ['src/index.js']);
    assert.deepEqual(
      warnings.map((warning) => [warning.code, warning.line]),
      [
        ['fetch', 1],
        ['insecure-http', 2],
        ['new-function', 3],
      ],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
