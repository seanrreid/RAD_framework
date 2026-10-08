/**
 * makePreparePort against a real temp repo with a bare origin (AC#4, AC#5, AC#7).
 *
 * git runs for real; rad-label.sh (it would reach real GitHub via gh) is
 * stubbed through the injected `sh`. Helpers are copied from
 * cli-plan-status.test.js rather than imported.
 *
 * Edge cases named: already up to date (second run), main ahead, remote work
 * branch ahead, local/remote diverged, conflicting change on main, no origin
 * remote, wrong branch, staged change, Status written once then idempotent,
 * plan without Issue:, work branch not yet on origin; partial tracked work
 * merged around non-conflictingly, partial work conflicting with main, merge
 * conflict with partial work stashed, untracked-only partial file, no partial
 * work (no stash call).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { defaultSh } from '../adapters/git-state-store.js';
import { makePreparePort } from '../deliver-prepare.js';

const SLUG = 'demo';
const BRANCH = `rad/${SLUG}`;
const BASE = 'main';
const PLAN_REL = `.agents/plans/${SLUG}.md`;
const USER = 't@example.com';
const IDENTITY = [['user.email', USER], ['user.name', 'Tester'], ['commit.gpgsign', 'false']];
const ISSUE_PLAN = `# Plan: Demo feature
Created: 2026-10-07
Author: tester
Status: approved
Branch: rad/demo
Issue: 42

## Context

Demo.
`;
const NO_ISSUE_PLAN = ISSUE_PLAN.replace('Issue: 42\n', '');

function git(cwd, args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { status: res.status, stdout: (res.stdout ?? '').trim(), stderr: res.stderr ?? '' };
}

function configure(cwd) {
  for (const [k, v] of IDENTITY) git(cwd, ['config', k, v]);
}

/**
 * A work clone on rad/demo carrying one plan commit (pushed to a bare origin
 * unless `pushBranch` is false), plus a helper to change origin from a second clone.
 */
async function withRepo(fn, { plan = ISSUE_PLAN, pushBranch = true } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'rad-deliver-prepare-'));
  const origin = join(base, 'origin.git');
  const root = join(base, 'work');
  try {
    git(base, ['init', '-q', '--bare', '-b', BASE, origin]);
    mkdirSync(root);
    git(root, ['init', '-q', '-b', BASE]);
    configure(root);
    writeFileSync(join(root, 'seed.txt'), 'seed\n');
    git(root, ['add', 'seed.txt']);
    git(root, ['commit', '-q', '-m', 'seed']);
    git(root, ['remote', 'add', 'origin', origin]);
    git(root, ['push', '-q', 'origin', BASE]);
    git(root, ['checkout', '-q', '-b', BRANCH]);
    mkdirSync(join(root, '.agents', 'plans'), { recursive: true });
    writeFileSync(join(root, PLAN_REL), plan);
    git(root, ['add', PLAN_REL]);
    git(root, ['commit', '-q', '-m', 'plan: Demo feature']);
    if (pushBranch) git(root, ['push', '-q', '-u', 'origin', BRANCH]);
    const upstream = (branch, file, content) => pushFromOther(base, origin, branch, file, content);
    return await fn({ root, origin, upstream });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

/** Commit `file` on `branch` in a second clone and push it to origin. */
function pushFromOther(base, origin, branch, file, content) {
  const other = join(base, `other-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  git(base, ['clone', '-q', '-b', branch, origin, other]);
  configure(other);
  writeFileSync(join(other, file), content);
  git(other, ['add', file]);
  git(other, ['commit', '-q', '-m', `upstream ${file}`]);
  const res = git(other, ['push', '-q', 'origin', branch]);
  assert.equal(res.status, 0, res.stderr);
}

/** `sh` that stubs rad-label.sh and records every call; git runs for real. */
function makeSh(root) {
  const calls = [];
  const sh = (file, args, opts) => {
    calls.push({ file, args });
    if (file === join(root, 'scripts/rad-label.sh')) return { status: 0, stdout: '', stderr: '' };
    return defaultSh(file, args, opts);
  };
  return { sh, calls };
}

async function capture(fn) {
  const out = process.stdout.write.bind(process.stdout);
  let stdout = '';
  process.stdout.write = (c) => { stdout += c; return true; };
  try {
    return { result: await fn(), stdout };
  } finally {
    process.stdout.write = out;
  }
}

async function prepare(root) {
  const { sh, calls } = makeSh(root);
  const port = makePreparePort({ sh, root, feature: SLUG, planPath: PLAN_REL, workBranch: BRANCH, baseBranch: BASE });
  const { result, stdout } = await capture(port);
  return { result, stdout, calls };
}

const labelCalls = (calls) => calls.filter((c) => c.file.endsWith('scripts/rad-label.sh'));
const head = (root, ref = 'HEAD') => git(root, ['rev-parse', ref]).stdout;
const remoteHead = (origin, branch = BRANCH) => git(origin, ['rev-parse', `refs/heads/${branch}`]).stdout;
const readPlan = (root) => readFileSync(join(root, PLAN_REL), 'utf8');
const isAncestor = (cwd, a, b) => git(cwd, ['merge-base', '--is-ancestor', a, b]).status === 0;
const stashCalls = (calls) => calls.filter((c) => c.file === 'git' && c.args[0] === 'stash');
const stashList = (root) => git(root, ['stash', 'list', '--format=%gs']).stdout;
const STASH_SUBJECT = /rad deliver: partial work before merging origin\/main$/;

function assertStopped(result, stopped, detail) {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.stopped, stopped);
  assert.match(result.detail, detail);
  assert.equal(result.base, BASE);
  assert.equal(result.branch, BRANCH);
}

test('Status is written and pushed once, with the begin-execution message (AC#5)', async () => {
  await withRepo(async ({ root, origin }) => {
    const { result, calls } = await prepare(root);
    assert.deepEqual(result, { ok: true, data: { base: BASE, merged: false, fastForwarded: false, committed: true, pushed: true } });
    assert.match(readPlan(root), /^Status: in-progress$/m);
    assert.equal(git(root, ['log', '-1', '--format=%B']).stdout,
      `deliver(${SLUG}): begin execution\n\nPlan: ${PLAN_REL}\nIssue: 42`);
    assert.equal(remoteHead(origin), head(root));
    assert.deepEqual(labelCalls(calls).map((c) => c.args), [['42', 'in-progress']]);
  });
});

test('already up to date: a second run makes no commit, merge or push, labels only', async () => {
  await withRepo(async ({ root, origin }) => {
    assert.equal((await prepare(root)).result.ok, true);
    const before = head(root);
    const { result, calls } = await prepare(root);
    assert.deepEqual(result, { ok: true, data: { base: BASE, merged: false, fastForwarded: false, committed: false, pushed: false } });
    assert.equal(head(root), before);
    assert.equal(remoteHead(origin), before);
    assert.equal(labelCalls(calls).length, 1);
    assert.equal(calls.some((c) => c.args[0] === 'push'), false);
  });
});

test('main ahead: merges origin/main and pushes the merge (AC#4)', async () => {
  await withRepo(async ({ root, origin, upstream }) => {
    upstream(BASE, 'main.txt', 'from main\n');
    const { result, calls } = await prepare(root);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.data.merged, true);
    assert.equal('stashed' in result.data, false);
    assert.deepEqual(stashCalls(calls), []);
    assert.equal(result.data.pushed, true);
    assert.equal(readFileSync(join(root, 'main.txt'), 'utf8'), 'from main\n');
    assert.equal(remoteHead(origin), head(root));
    assert.ok(isAncestor(origin, `refs/heads/${BASE}`, `refs/heads/${BRANCH}`));
  });
});

test('partial tracked work, main touching the same file cleanly: merges, restores, stashed: true', async () => {
  await withRepo(async ({ root, origin, upstream }) => {
    upstream(BASE, 'multi.txt', 'a\nb\nc\nd\ne\n');
    git(root, ['fetch', '-q', 'origin', BASE]);
    git(root, ['merge', '-q', '--no-edit', `origin/${BASE}`]);
    upstream(BASE, 'multi.txt', 'A\nb\nc\nd\ne\n');
    writeFileSync(join(root, 'multi.txt'), 'a\nb\nc\nd\nE\n');
    const { result, calls } = await prepare(root);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.data.merged, true);
    assert.equal(result.data.stashed, true);
    assert.equal(readFileSync(join(root, 'multi.txt'), 'utf8'), 'A\nb\nc\nd\nE\n');
    assert.equal(stashList(root), '');
    const push = stashCalls(calls).find((c) => c.args[1] === 'push');
    assert.deepEqual(push.args, ['stash', 'push', '-q', '-m', 'rad deliver: partial work before merging origin/main']);
    assert.equal(remoteHead(origin), head(root));
  });
});

test('partial work conflicting with main: merge-conflict, stash kept, tree clean, HEAD is the merge', async () => {
  await withRepo(async ({ root, upstream }) => {
    upstream(BASE, 'seed.txt', 'main side\n');
    writeFileSync(join(root, 'seed.txt'), 'partial\n');
    const { result } = await prepare(root);
    assertStopped(result, 'merge-conflict',
      /^partial work conflicts with origin\/main in seed\.txt; it is kept in git stash \(stash@\{0\}\)$/);
    assert.match(stashList(root), STASH_SUBJECT);
    assert.match(git(root, ['stash', 'show', '-p']).stdout, /\+partial/);
    assert.equal(git(root, ['status', '--porcelain']).stdout, '');
    assert.ok(isAncestor(root, `origin/${BASE}`, 'HEAD'));
    assert.equal(git(root, ['rev-parse', '-q', '--verify', 'HEAD^2']).status, 0);
    assert.equal(readFileSync(join(root, 'seed.txt'), 'utf8'), 'main side\n');
  });
});

test('merge conflict with partial work stashed: aborted, partial work restored, merge-conflict', async () => {
  await withRepo(async ({ root, upstream }) => {
    writeFileSync(join(root, 'seed.txt'), 'branch side\n');
    git(root, ['commit', '-q', '-am', 'branch edit']);
    upstream(BASE, 'seed.txt', 'main side\n');
    const partial = `${readPlan(root)}partial line\n`;
    writeFileSync(join(root, PLAN_REL), partial);
    const before = head(root);
    const { result } = await prepare(root);
    assertStopped(result, 'merge-conflict', /^seed\.txt$/);
    assert.equal(head(root), before);
    assert.equal(stashList(root), '');
    assert.equal(readPlan(root), partial);
    assert.equal(git(root, ['status', '--porcelain']).stdout, `M ${PLAN_REL}`);
  });
});

test('untracked-only partial file: no stash, merges as before', async () => {
  await withRepo(async ({ root, upstream }) => {
    upstream(BASE, 'main.txt', 'from main\n');
    writeFileSync(join(root, 'scratch.txt'), 'untracked\n');
    const { result, calls } = await prepare(root);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.data.merged, true);
    assert.equal('stashed' in result.data, false);
    assert.deepEqual(stashCalls(calls), []);
    assert.equal(readFileSync(join(root, 'scratch.txt'), 'utf8'), 'untracked\n');
  });
});

test('remote work branch ahead: fast-forwards to it', async () => {
  await withRepo(async ({ root, origin, upstream }) => {
    upstream(BRANCH, 'remote.txt', 'remote\n');
    const remoteTip = remoteHead(origin);
    const { result } = await prepare(root);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.data.fastForwarded, true);
    assert.equal(result.data.merged, false);
    assert.ok(isAncestor(root, remoteTip, 'HEAD'));
    assert.equal(readFileSync(join(root, 'remote.txt'), 'utf8'), 'remote\n');
  });
});

test('local and remote work branch diverged: prepare-failed "diverged", HEAD unchanged', async () => {
  await withRepo(async ({ root, upstream }) => {
    upstream(BRANCH, 'remote.txt', 'remote\n');
    writeFileSync(join(root, 'local.txt'), 'local\n');
    git(root, ['add', 'local.txt']);
    git(root, ['commit', '-q', '-m', 'local']);
    const before = head(root);
    const { result } = await prepare(root);
    assertStopped(result, 'prepare-failed', /diverged from origin\/rad\/demo/);
    assert.equal(head(root), before);
  });
});

test('conflicting change on main: merge-conflict naming the paths, merge aborted, tree clean (AC#7)', async () => {
  await withRepo(async ({ root, upstream }) => {
    writeFileSync(join(root, 'seed.txt'), 'branch side\n');
    git(root, ['commit', '-q', '-am', 'branch edit']);
    upstream(BASE, 'seed.txt', 'main side\n');
    const before = head(root);
    const { result } = await prepare(root);
    assertStopped(result, 'merge-conflict', /^seed\.txt$/);
    assert.notEqual(git(root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).status, 0);
    assert.equal(git(root, ['status', '--porcelain']).stdout, '');
    assert.equal(head(root), before);
    assert.match(readPlan(root), /^Status: approved$/m);
  });
});

test('no origin remote: prepare-failed "cannot reach origin"', async () => {
  await withRepo(async ({ root }) => {
    git(root, ['remote', 'remove', 'origin']);
    const { result } = await prepare(root);
    assertStopped(result, 'prepare-failed', /^cannot reach origin: /);
  });
});

test('wrong branch: prepare-failed, nothing changed', async () => {
  await withRepo(async ({ root }) => {
    git(root, ['checkout', '-q', BASE]);
    const before = head(root);
    const { result } = await prepare(root);
    assertStopped(result, 'prepare-failed', /not the work branch 'rad\/demo'/);
    assert.equal(head(root), before);
  });
});

test('staged change: prepare-failed, nothing changed', async () => {
  await withRepo(async ({ root }) => {
    writeFileSync(join(root, 'staged.txt'), 'staged\n');
    git(root, ['add', 'staged.txt']);
    const before = head(root);
    const { result } = await prepare(root);
    assertStopped(result, 'prepare-failed', /staged changes are present/);
    assert.equal(head(root), before);
  });
});

test('plan without Issue: label skipped and ok, no Issue line in the message', async () => {
  await withRepo(async ({ root }) => {
    const { result, stdout, calls } = await prepare(root);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.match(stdout, /label skipped/);
    assert.equal(labelCalls(calls).length, 0);
    assert.equal(git(root, ['log', '-1', '--format=%B']).stdout,
      `deliver(${SLUG}): begin execution\n\nPlan: ${PLAN_REL}`);
  }, { plan: NO_ISSUE_PLAN });
});

test('work branch not yet on origin: ok, and pushes it', async () => {
  await withRepo(async ({ root, origin }) => {
    assert.notEqual(git(origin, ['rev-parse', '--verify', '-q', `refs/heads/${BRANCH}`]).status, 0);
    const { result } = await prepare(root);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.data.fastForwarded, false);
    assert.equal(result.data.pushed, true);
    assert.equal(remoteHead(origin), head(root));
  }, { pushBranch: false });
});

test('missing required option is a programmer error at construction', () => {
  assert.throws(() => makePreparePort({ sh: defaultSh, root: '/x', feature: SLUG, planPath: '', workBranch: BRANCH, baseBranch: BASE }),
    /planPath is required/);
});
