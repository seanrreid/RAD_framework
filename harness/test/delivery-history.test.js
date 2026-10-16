import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readDeliveryHistory } from '../delivery-history.js';

const BASE = 'main';
const IDENTITY = [['user.email', 'dev@example.com'], ['user.name', 'Dev']];

const planFor = (title, paths) => `# Plan: ${title}

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
${paths.map((p) => `| ${p} | 1-10 | edit |`).join('\n')}
`;

function git(cwd, args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
  return (res.stdout ?? '').trim();
}

function write(root, rel, content) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

/** Stage everything and commit with a (possibly multi-paragraph) message. */
function commit(root, message) {
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '--allow-empty', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']);
}

/** A fresh repo on `main`; `seed` false leaves it with no commits. */
function withRepo(fn, { seed = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'rad-delivery-history-'));
  try {
    git(root, ['init', '-q', '-b', BASE]);
    for (const [k, v] of IDENTITY) git(root, ['config', k, v]);
    if (seed) {
      write(root, 'shared.js', 'one\n');
      commit(root, 'seed');
    }
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const read = (root) => readDeliveryHistory({ root, defaultBranch: BASE });
const squashBody = (slug) => `* plan: x\n\n* approve: ${slug}\n\nPlan: .agents/plans/${slug}.md\n\n* deliver(${slug}): begin execution`;

/** A squash-style deliver merge of `slug` touching `files` with its plan scoping `scope`. */
function squashDeliver(root, slug, pr, files, scope = Object.keys(files)) {
  write(root, `.agents/plans/${slug}.md`, planFor(slug, scope));
  for (const [path, content] of Object.entries(files)) write(root, path, content);
  return commit(root, `Deliver: ${slug} (#${pr})\n\n${squashBody(slug)}`);
}

test('readDeliveryHistory: an empty repo returns empty arrays and does not throw', () => {
  withRepo((root) => {
    assert.deepEqual(read(root), { merges: [], commits: [], unresolved: 0 });
  }, { seed: false });
});

test('readDeliveryHistory: a missing default branch in a non-empty repo throws with context', () => {
  withRepo((root) => {
    assert.throws(() => readDeliveryHistory({ root, defaultBranch: 'nope' }), /default branch 'nope' not found/);
  });
});

test('readDeliveryHistory: a log record with no header terminator throws instead of parsing garbage', () => {
  // rev-parse succeeds; `git log` returns a record missing the \x03 header terminator.
  const truncated = '\x01abc123\x02\x022026-10-16T00:00:00Z\x02Deliver: x (#1)\x02body with no terminator';
  const sh = (_cmd, args) => (args[0] === 'rev-parse'
    ? { status: 0, stdout: 'abc123\n', stderr: '' }
    : { status: 0, stdout: truncated, stderr: '' });
  assert.throws(
    () => readDeliveryHistory({ root: tmpdir(), sh, defaultBranch: BASE }),
    /malformed git log record \(no header terminator\): "abc123/,
  );
});

test('readDeliveryHistory: squash deliver merge yields a merge record with numstat and scope', () => {
  withRepo((root) => {
    const sha = squashDeliver(root, 'alpha', 12, { 'a.js': 'x\ny\n', 'shared.js': 'one\ntwo\n' }, ['a.js', 'shared.js']);
    const { merges, commits, unresolved } = read(root);
    assert.equal(unresolved, 0);
    assert.equal(merges.length, 1);
    const [m] = merges;
    assert.equal(m.feature, 'alpha');
    assert.equal(m.sha, sha);
    assert.equal(m.pr, 12);
    assert.ok(Number.isFinite(Date.parse(m.mergedAt)));
    const byPath = Object.fromEntries(m.files.map((f) => [f.path, f]));
    assert.deepEqual(byPath['a.js'], { path: 'a.js', added: 2, deleted: 0 });
    assert.deepEqual(byPath['shared.js'], { path: 'shared.js', added: 1, deleted: 0 });
    assert.ok(byPath['.agents/plans/alpha.md']);
    assert.deepEqual(m.scopedFiles, ['a.js', 'shared.js']);
    assert.equal(commits.length, 2);
    assert.deepEqual(commits.map((c) => c.isDeliver), [false, true]);
    assert.equal(commits[1].feature, 'alpha');
  });
});

test('readDeliveryHistory: a subject with two (#N) groups takes the last as the PR', () => {
  withRepo((root) => {
    write(root, '.agents/plans/beta.md', planFor('beta', ['b.js']));
    write(root, 'b.js', 'b\n');
    commit(root, `Deliver: Fix the thing (#270) (#274)\n\n${squashBody('beta')}`);
    assert.equal(read(root).merges[0].pr, 274);
  });
});

test('readDeliveryHistory: a two-parent merge is recognised and diffed against its first parent', () => {
  withRepo((root) => {
    git(root, ['checkout', '-q', '-b', 'rad/gamma']);
    write(root, '.agents/plans/gamma.md', planFor('gamma', ['g.js']));
    write(root, 'g.js', 'g1\ng2\ng3\n');
    commit(root, 'deliver(gamma): work');
    git(root, ['checkout', '-q', BASE]);
    write(root, 'other.js', 'o\n');
    commit(root, 'unrelated on main');
    git(root, ['merge', '-q', '--no-ff', 'rad/gamma', '-m', 'Merge pull request #31 from someone/rad/gamma']);
    const { merges, commits } = read(root);
    assert.equal(merges.length, 1);
    const [m] = merges;
    assert.equal(m.feature, 'gamma');
    assert.equal(m.pr, 31);
    assert.deepEqual(m.files.map((f) => f.path).sort(), ['.agents/plans/gamma.md', 'g.js']);
    assert.deepEqual(m.files.find((f) => f.path === 'g.js'), { path: 'g.js', added: 3, deleted: 0 });
    assert.deepEqual(m.scopedFiles, ['g.js']);
    // first-parent only: the branch's own commit is not in the history
    assert.deepEqual(commits.map((c) => c.isDeliver), [false, false, true]);
  });
});

test('readDeliveryHistory: a merge from a non-rad branch is not a deliver merge', () => {
  withRepo((root) => {
    git(root, ['checkout', '-q', '-b', 'docs/x']);
    write(root, 'd.md', 'd\n');
    commit(root, 'docs');
    git(root, ['checkout', '-q', BASE]);
    git(root, ['merge', '-q', '--no-ff', 'docs/x', '-m', 'Merge pull request #9 from someone/docs/x']);
    const { merges, commits, unresolved } = read(root);
    assert.deepEqual(merges, []);
    assert.equal(unresolved, 0);
    assert.equal(commits.at(-1).isDeliver, false);
  });
});

test('readDeliveryHistory: a later direct fix is a non-deliver commit touching the file', () => {
  withRepo((root) => {
    squashDeliver(root, 'alpha', 12, { 'a.js': 'x\n' });
    write(root, 'a.js', 'x fixed\n');
    const fix = commit(root, 'fix a.js');
    const last = read(root).commits.at(-1);
    assert.deepEqual(last, { sha: fix, committedAt: last.committedAt, isDeliver: false, touches: [{ path: 'a.js', status: 'M' }] });
  });
});

test('readDeliveryHistory: a later deliver merge carries its own plan scope for the shared file', () => {
  withRepo((root) => {
    squashDeliver(root, 'alpha', 12, { 'shared.js': 'one\ntwo\n' });
    const later = squashDeliver(root, 'delta', 13, { 'shared.js': 'one\ntwo\nthree\n', 'd.js': 'd\n' }, ['shared.js']);
    const { merges, commits } = read(root);
    assert.deepEqual(merges.map((m) => m.feature), ['alpha', 'delta']);
    assert.deepEqual(merges[1].scopedFiles, ['shared.js']);
    const c = commits.find((x) => x.sha === later);
    assert.equal(c.isDeliver, true);
    assert.equal(c.feature, 'delta');
    assert.ok(c.touches.some((t) => t.path === 'shared.js' && t.status === 'M'));
  });
});

test('readDeliveryHistory: a merge whose plan file is missing has scopedFiles []', () => {
  withRepo((root) => {
    write(root, 'e.js', 'e\n');
    commit(root, `Deliver: epsilon (#40)\n\n* deliver(epsilon): begin execution`);
    const [m] = read(root).merges;
    assert.equal(m.feature, 'epsilon');
    assert.deepEqual(m.scopedFiles, []);
  });
});

test('readDeliveryHistory: a Deliver: squash with no slug in the body is counted unresolved', () => {
  withRepo((root) => {
    write(root, 'u.js', 'u\n');
    commit(root, 'Deliver: mystery (#41)\n\nno slug here');
    write(root, 'v.js', 'v\n');
    commit(root, 'Deliver: two slugs (#42)\n\n* deliver(one): a\n* deliver(two): b');
    const { merges, commits, unresolved } = read(root);
    assert.deepEqual(merges, []);
    assert.equal(unresolved, 2);
    assert.ok(commits.slice(1).every((c) => c.isDeliver && !('feature' in c)));
  });
});

test('readDeliveryHistory: a rename after merge is reported with oldPath; a delete with status D', () => {
  withRepo((root) => {
    squashDeliver(root, 'alpha', 12, { 'a.js': 'line 1\nline 2\nline 3\nline 4\n', 'b.js': 'b\n' });
    renameSync(join(root, 'a.js'), join(root, 'a2.js'));
    commit(root, 'rename a.js');
    unlinkSync(join(root, 'b.js'));
    commit(root, 'delete b.js');
    const { commits } = read(root);
    const [renamed, deleted] = commits.slice(-2);
    assert.equal(renamed.touches.length, 1);
    assert.equal(renamed.touches[0].path, 'a2.js');
    assert.equal(renamed.touches[0].oldPath, 'a.js');
    assert.match(renamed.touches[0].status, /^R\d+$/);
    assert.deepEqual(deleted.touches, [{ path: 'b.js', status: 'D' }]);
  });
});

test('readDeliveryHistory: a deliver merge with zero changed files has files []', () => {
  withRepo((root) => {
    write(root, '.agents/plans/zeta.md', planFor('zeta', ['z.js']));
    commit(root, 'plan: zeta');
    commit(root, `Deliver: zeta (#50)\n\n${squashBody('zeta')}`);
    const [m] = read(root).merges;
    assert.equal(m.feature, 'zeta');
    assert.deepEqual(m.files, []);
    assert.deepEqual(m.scopedFiles, ['z.js']);
  });
});

test('readDeliveryHistory: a binary file reports null line counts', () => {
  withRepo((root) => {
    write(root, '.agents/plans/eta.md', planFor('eta', ['img.bin']));
    writeFileSync(join(root, 'img.bin'), Buffer.from([0, 1, 2, 0, 255]));
    commit(root, `Deliver: eta (#51)\n\n${squashBody('eta')}`);
    const f = read(root).merges[0].files.find((x) => x.path === 'img.bin');
    assert.deepEqual(f, { path: 'img.bin', added: null, deleted: null });
  });
});

test('readDeliveryHistory: a failing git call throws with context', () => {
  const sh = (file, args) => (args[0] === 'rev-parse' ? { status: 0, stdout: '', stderr: '' } : { status: 128, stdout: '', stderr: 'boom' });
  assert.throws(() => readDeliveryHistory({ root: '/nowhere', sh, defaultBranch: BASE }), /git log --first-parent failed \(exit 128\): boom/);
});
