import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBranchCommits } from '../branch-commits.js';

const FEATURE = 'demo-feature';
const PR_OPENED = '2026-01-01T00:00:10Z';
const IDENTITY = [['user.email', 'dev@example.com'], ['user.name', 'Dev']];

function git(cwd, args, env = {}) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
  return (res.stdout ?? '').trim();
}

/** Commit with a fixed committer date so second-precision cases are exact. */
function commitAt(root, subject, iso) {
  git(root, ['commit', '-q', '--allow-empty', '-m', subject], { GIT_COMMITTER_DATE: iso, GIT_AUTHOR_DATE: iso });
}

function withRepo(fn) {
  const root = mkdtempSync(join(tmpdir(), 'rad-branch-commits-'));
  try {
    git(root, ['init', '-q', '-b', 'main']);
    for (const [k, v] of IDENTITY) git(root, ['config', k, v]);
    commitAt(root, 'seed', '2025-12-31T00:00:00Z');
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const subjects = (result) => result.commits.map((c) => c.subject);

test('commit at the pr-opened second is excluded; one second later is included', () => {
  withRepo((root) => {
    git(root, ['checkout', '-q', '-b', `rad/${FEATURE}`]);
    commitAt(root, 'fix: same second', PR_OPENED);
    commitAt(root, 'fix: one second later', '2026-01-01T00:00:11Z');
    const result = readBranchCommits({ root, feature: FEATURE, since: '2026-01-01T00:00:10.900Z' });
    assert.equal(result.available, true);
    assert.deepEqual(subjects(result), ['fix: one second later']);
  });
});

test('harness-subject commits are excluded', () => {
  withRepo((root) => {
    git(root, ['checkout', '-q', '-b', `rad/${FEATURE}`]);
    commitAt(root, 'deliver(demo-feature): Task', '2026-01-02T00:00:00Z');
    commitAt(root, 'approve: demo-feature', '2026-01-02T00:00:01Z');
    commitAt(root, 'review: fixes', '2026-01-02T00:00:02Z');
    commitAt(root, 'fix: real follow-up', '2026-01-02T00:00:03Z');
    const result = readBranchCommits({ root, feature: FEATURE, since: PR_OPENED });
    assert.deepEqual(subjects(result), ['fix: real follow-up']);
  });
});

test('local ref is preferred over the origin ref', () => {
  withRepo((root) => {
    git(root, ['checkout', '-q', '-b', `rad/${FEATURE}`]);
    commitAt(root, 'fix: local', '2026-01-02T00:00:00Z');
    const head = git(root, ['rev-parse', 'HEAD']);
    git(root, ['update-ref', `refs/remotes/origin/rad/${FEATURE}`, git(root, ['rev-parse', 'main'])]);
    const result = readBranchCommits({ root, feature: FEATURE, since: PR_OPENED });
    assert.equal(result.ref, `refs/heads/rad/${FEATURE}`);
    assert.equal(result.commits[0].sha, head);
  });
});

test('origin-only ref is used when no local branch exists', () => {
  withRepo((root) => {
    git(root, ['checkout', '-q', '-b', 'tmp']);
    commitAt(root, 'fix: remote only', '2026-01-02T00:00:00Z');
    git(root, ['update-ref', `refs/remotes/origin/rad/${FEATURE}`, 'HEAD']);
    git(root, ['checkout', '-q', 'main']);
    const result = readBranchCommits({ root, feature: FEATURE, since: PR_OPENED });
    assert.equal(result.available, true);
    assert.equal(result.ref, `refs/remotes/origin/rad/${FEATURE}`);
    assert.deepEqual(subjects(result), ['fix: remote only']);
  });
});

test('neither ref gives unavailable with a reason, not an error', () => {
  withRepo((root) => {
    const result = readBranchCommits({ root, feature: FEATURE, since: PR_OPENED });
    assert.equal(result.available, false);
    assert.match(result.reason, /no rad\/demo-feature branch ref/);
  });
});

test('missing or invalid pr-opened timestamp gives unavailable with its reason', () => {
  withRepo((root) => {
    for (const since of [undefined, null, '', 'not-a-date']) {
      const result = readBranchCommits({ root, feature: FEATURE, since });
      assert.deepEqual(result, { available: false, reason: 'no pr-opened event' });
    }
  });
});

test('hostile feature names are rejected before reaching git', () => {
  withRepo((root) => {
    const hostile = ['', '--upload-pack=x', '../x', 'a b', 'a;rm -rf /', 'A', '$(x)', 'a\nb', undefined, 42];
    for (const feature of hostile) {
      assert.throws(() => readBranchCommits({ root, feature, since: PR_OPENED }), /unsafe feature name/);
    }
  });
});

test('a long but well-formed feature name is accepted, matching the harness slug rule', () => {
  withRepo((root) => {
    const result = readBranchCommits({ root, feature: 'a'.repeat(120), since: PR_OPENED });
    assert.equal(result.available, false);
    assert.match(result.reason, /branch ref/);
  });
});

test('returned commits carry their committer time in whole seconds', () => {
  withRepo((root) => {
    git(root, ['checkout', '-q', '-b', `rad/${FEATURE}`]);
    commitAt(root, 'fix: later', '2026-01-02T00:00:00Z');
    const result = readBranchCommits({ root, feature: FEATURE, since: PR_OPENED });
    assert.equal(result.commits[0].seconds, Date.parse('2026-01-02T00:00:00Z') / 1000);
  });
});

test('a git failure on an existing ref is thrown, not swallowed', () => {
  withRepo((root) => {
    git(root, ['checkout', '-q', '-b', `rad/${FEATURE}`]);
    const sh = (file, args, opts) =>
      args[0] === 'log' ? { status: 128, stdout: '', stderr: 'boom' } : spawnSync(file, args, { ...opts, encoding: 'utf8' });
    assert.throws(() => readBranchCommits({ root, feature: FEATURE, since: PR_OPENED, sh }), /exit 128.*boom/);
  });
});

test('reading writes no files in the working tree', () => {
  withRepo((root) => {
    git(root, ['checkout', '-q', '-b', `rad/${FEATURE}`]);
    commitAt(root, 'fix: later', '2026-01-02T00:00:00Z');
    const before = readdirSync(root).sort();
    readBranchCommits({ root, feature: FEATURE, since: PR_OPENED });
    assert.deepEqual(readdirSync(root).sort(), before);
    assert.equal(git(root, ['status', '--porcelain']), '');
  });
});
