import { test } from 'node:test';
import assert from 'node:assert/strict';
import { manifestFromProject } from '../src/project-manifest.js';

// The publish path shells out to the twext compiler, which rejects
// extension.isUnsandboxed until twext#4 ships, so the allowlist is covered here
// directly rather than through a publish.

function project(extension = {}, rest = {}) {
  return {
    version: '1.0.0',
    name: 'Probe',
    license: 'MIT',
    extension: { id: 'probe', ...extension },
    ...rest,
  };
}

test('isUnsandboxed is carried through from twext.yml to the manifest', () => {
  const { errors, manifest } = manifestFromProject(project({ isUnsandboxed: true }), 'probe');
  assert.deepEqual(errors, []);
  assert.equal(manifest.isUnsandboxed, true);
});

test('an explicit isUnsandboxed: false is preserved rather than dropped', () => {
  const { errors, manifest } = manifestFromProject(project({ isUnsandboxed: false }), 'probe');
  assert.deepEqual(errors, []);
  assert.equal(manifest.isUnsandboxed, false);
});

test('an undeclared isUnsandboxed stays null so "absent" is distinguishable', () => {
  const { errors, manifest } = manifestFromProject(project(), 'probe');
  assert.deepEqual(errors, []);
  assert.equal(manifest.isUnsandboxed, null);
});

test('a string isUnsandboxed is rejected instead of being coerced', () => {
  const { errors, manifest } = manifestFromProject(project({ isUnsandboxed: 'true' }), 'probe');
  assert.equal(manifest, null);
  assert.equal(errors[0].field, 'extension.isUnsandboxed');
});

test('a numeric isUnsandboxed is rejected', () => {
  const { errors, manifest } = manifestFromProject(project({ isUnsandboxed: 1 }), 'probe');
  assert.equal(manifest, null);
  assert.equal(errors[0].field, 'extension.isUnsandboxed');
});

test('the allowlist still drops keys it does not name', () => {
  const { errors, manifest } = manifestFromProject(
    project({ isUnsandboxed: true, somethingElse: 'nope' }),
    'probe',
  );
  assert.deepEqual(errors, []);
  assert.equal(manifest.isUnsandboxed, true);
  assert.equal('somethingElse' in manifest, false);
});
