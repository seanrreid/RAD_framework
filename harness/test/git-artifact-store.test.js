import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createGitArtifactStore } from '../adapters/git-artifact-store.js';

function withTempRepo(fn) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'rad-artifact-'));
  try {
    return fn(repoRoot);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

test('write then read round-trips a named document', () => {
  withTempRepo((repoRoot) => {
    const docs = createGitArtifactStore({ repoRoot });
    const content = '# Plan\n\nStatus: anything\n';
    docs.write('demo', 'plan', content);
    assert.ok(existsSync(join(repoRoot, '.agents', 'plans', 'demo.md')));
    assert.equal(docs.read('demo', 'plan'), content);
  });
});

test('read returns null for a missing document', () => {
  withTempRepo((repoRoot) => {
    const docs = createGitArtifactStore({ repoRoot });
    assert.equal(docs.read('demo', 'research'), null);
  });
});

test('write persists content verbatim (no Status interpretation/mutation)', () => {
  withTempRepo((repoRoot) => {
    const docs = createGitArtifactStore({ repoRoot });
    const raw = 'Status: draft\nbody line\n';
    docs.write('demo', 'log', raw);
    // Decision 2: content is stored byte-for-byte; Status is never rewritten.
    assert.equal(docs.read('demo', 'log'), raw);
  });
});

test('Decision 2: the artifact store exposes NO Status-mutating method', () => {
  withTempRepo((repoRoot) => {
    const docs = createGitArtifactStore({ repoRoot });
    // Only read/write are exposed — nothing that mutates a doc Status field.
    assert.deepEqual(Object.keys(docs).sort(), ['read', 'write']);
    for (const key of Object.keys(docs)) {
      assert.ok(
        !/status/i.test(key),
        `unexpected status-related method on artifact store: ${key}`,
      );
    }
  });
});

test('createGitArtifactStore requires repoRoot', () => {
  assert.throws(() => createGitArtifactStore({}), /repoRoot is required/);
});
