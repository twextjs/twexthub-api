import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { compileProject, compilerCommand } from '../src/compiler.js';

test('the bundled compiler is used only when no command is configured', () => {
  const bundled = compilerCommand({ compiler: { command: null } });
  assert.match(bundled, /@twextjs\/twext\/src\/cli\.js$/);
  assert.equal(compilerCommand({ compiler: {} }), bundled);
  assert.equal(compilerCommand({}), bundled);
  assert.equal(
    compilerCommand({ compiler: { command: ' ./compiler.mjs ' } }),
    path.resolve('compiler.mjs'),
  );
});

test('rejected compiler commands fail before starting a build', async () => {
  for (const command of ['', '   ', './compiler.sh', 42]) {
    assert.throws(() => compilerCommand({ compiler: { command } }), /Invalid compiler\.command/);
    const result = await compileProject({ compiler: { command } }, '/nonexistent-project', {
      limitShell: '/nonexistent-shell',
    });
    assert.deepEqual(result, {
      ok: false,
      error: 'Invalid compiler.command: expected a non-empty .js, .mjs, or .cjs script path.',
      log: '',
      durationMs: 0,
    });
  }
});
