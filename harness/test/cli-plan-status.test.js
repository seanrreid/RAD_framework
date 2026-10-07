/**
 * `rad plan-status <feature> <rejected|needs-revision>` against a real temp repo
 * with a bare origin (AC#5, AC#6).
 *
 * git runs for real. check-role.sh (its role config is covered by
 * scripts/test-check-role.sh) and rad-label.sh (it would reach real GitHub via
 * gh) are stubbed through the injected `sh`; check-approval-blockers.sh is
 * stubbed too, for the setup step that records an approval with `rad approve`.
 * Helpers are copied from cli-plan-open.test.js rather than imported.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { defaultSh } from '../adapters/git-state-store.js';
import { planStatusCommand } from '../plan-status.js';
import { setPlanStatus } from '../plan-commit.js';
import { approveCommand } from '../cli.js';

const SLUG = 'demo';
const BRANCH = `rad/${SLUG}`;
const PLAN_REL = `.agents/plans/${SLUG}.md`;
const USER = 't@example.com';
const ISSUE_PLAN = `# Plan: Demo feature
Created: 2026-10-07
Author: tester
Status: pending-review
Branch: rad/demo
Issue: 42

## Context

Demo.

### Wave 1
#### Task 1.1: one
`;
const LOCKED_STATUSES = ['approved', 'in-progress', 'complete'];

function git(cwd, args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { status: res.status, stdout: (res.stdout ?? '').trim(), stderr: res.stderr ?? '' };
}

/**
 * A work clone whose rad/demo branch carries one plan commit, pushed to a bare
 * origin and checked out — the state rad plan-open leaves behind.
 */
async function withRepo(fn, plan = ISSUE_PLAN) {
  const base = mkdtempSync(join(tmpdir(), 'rad-plan-status-'));
  const origin = join(base, 'origin.git');
  const root = join(base, 'work');
  try {
    git(base, ['init', '-q', '--bare', '-b', 'main', origin]);
    mkdirSync(root);
    git(root, ['init', '-q', '-b', 'main']);
    for (const [k, v] of [['user.email', USER], ['user.name', 'Tester'], ['commit.gpgsign', 'false']]) {
      git(root, ['config', k, v]);
    }
    writeFileSync(join(root, 'seed.txt'), 'seed\n');
    git(root, ['add', 'seed.txt']);
    git(root, ['commit', '-q', '-m', 'seed']);
    git(root, ['remote', 'add', 'origin', origin]);
    git(root, ['push', '-q', 'origin', 'main']);
    git(root, ['checkout', '-q', '-b', BRANCH]);
    mkdirSync(join(root, '.agents', 'plans'), { recursive: true });
    writeFileSync(join(root, PLAN_REL), plan);
    git(root, ['add', PLAN_REL]);
    git(root, ['commit', '-q', '-m', 'plan: Demo feature']);
    git(root, ['push', '-q', '-u', 'origin', BRANCH]);
    return await fn({ root, origin, base });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

/**
 * `sh` that stubs check-role.sh (passes when the identity — the explicit third
 * arg, else the running user — is in `architects`), check-approval-blockers.sh
 * and rad-label.sh, and records every call; git runs for real.
 */
function makeSh(root, { architects = [USER] } = {}) {
  const calls = [];
  const sh = (file, args, opts) => {
    calls.push({ file, args });
    if (file === join(root, 'scripts/check-role.sh')) {
      const identity = args[2] ?? USER;
      return architects.includes(identity)
        ? { status: 0, stdout: '', stderr: '' }
        : { status: 1, stdout: `Permission denied: ${identity}\n`, stderr: '' };
    }
    if (file === join(root, 'scripts/check-approval-blockers.sh')) return { status: 0, stdout: '', stderr: '' };
    if (file === join(root, 'scripts/rad-label.sh')) return { status: 0, stdout: '', stderr: '' };
    return defaultSh(file, args, opts);
  };
  return { sh, calls };
}

async function capture(fn) {
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  let stdout = '';
  let stderr = '';
  process.stdout.write = (c) => { stdout += c; return true; };
  process.stderr.write = (c) => { stderr += c; return true; };
  try {
    return { code: await fn(), stdout, stderr };
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
}

function runPlanStatus(root, argv, shOpts) {
  const { sh, calls } = makeSh(root, shOpts);
  return capture(() => planStatusCommand(argv, { repoRoot: root, sh }))
    .then((r) => ({ ...r, calls }));
}

const labelCalls = (calls) => calls.filter((c) => c.file.endsWith('scripts/rad-label.sh'));
const head = (root, ref = 'HEAD') => git(root, ['rev-parse', ref]).stdout;
const message = (root, ref = 'HEAD') => git(root, ['log', '-1', '--format=%B', ref]).stdout;
const filesIn = (root, ref = 'HEAD') => git(root, ['diff-tree', '--no-commit-id', '--name-only', '-r', ref]).stdout;
const reviewSubjects = (root, range) => git(root, ['log', '--format=%s', range]).stdout.split('\n').filter((s) => s.startsWith('review:'));
const readPlan = (root) => readFileSync(join(root, PLAN_REL), 'utf8');

/** Commit a header Status directly, as a prior verb would have left it. */
function commitStatus(root, status) {
  writeFileSync(join(root, PLAN_REL), setPlanStatus(readPlan(root), status));
  git(root, ['commit', '-q', '-m', `status ${status}`, '--', PLAN_REL]);
}

/** Assert a refusal that changed nothing: exit 2, reason, same HEAD, plan text unchanged. */
function assertRefusedUnchanged(root, r, reason, { headBefore, planBefore }) {
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, reason);
  assert.equal(head(root), headBefore);
  assert.equal(readPlan(root), planBefore, 'plan untouched');
  assert.equal(labelCalls(r.calls).length, 0);
}

const snapshot = (root) => ({ headBefore: head(root), planBefore: readPlan(root) });

for (const status of ['rejected', 'needs-revision']) {
  test(`${status}: sets the Status header, commits only the plan with the review message, pushes and labels ${status}`, async () => {
    await withRepo(async ({ root }) => {
      const r = await runPlanStatus(root, [SLUG, status, '--trailer', 'Refs: #186', '--trailer', 'Co-Authored-By: A <a@example.com>']);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(message(root), [
        `review: demo ${status}`,
        '',
        `Plan: ${PLAN_REL}`,
        'Issue: 42',
        `Reviewed-By: ${USER}`,
        '',
        'Refs: #186',
        'Co-Authored-By: A <a@example.com>',
      ].join('\n'));
      assert.equal(filesIn(root), PLAN_REL);
      assert.match(readPlan(root), new RegExp(`^Status: ${status}$`, 'm'));
      assert.equal(head(root, `origin/${BRANCH}`), head(root), 'origin has the review commit');
      assert.equal(r.stdout.trim(), `rad plan-status: ok feature=demo status=${status} committed=true pushed=true issue=42`);
      const labels = labelCalls(r.calls);
      assert.deepEqual(labels.map((c) => c.args), [['42', status]]);
      const pushIdx = r.calls.findIndex((c) => c.file === 'git' && c.args[0] === 'push');
      assert.ok(pushIdx !== -1 && r.calls.indexOf(labels[0]) > pushIdx, 'label runs only after the push');
    });
  });
}

for (const locked of LOCKED_STATUSES) {
  test(`refused header Status '${locked}': exit 2, nothing changed`, async () => {
    await withRepo(async ({ root }) => {
      commitStatus(root, locked);
      assertRefusedUnchanged(root, await runPlanStatus(root, [SLUG, 'rejected']), new RegExp(`plan Status is '${locked}'`), snapshot(root));
    });
  });
}

test('passing approved gate with a pending-review header: exit 2, nothing changed', async () => {
  await withRepo(async ({ root }) => {
    const { sh } = makeSh(root);
    const approved = await capture(() => approveCommand([SLUG, '--no-commit'], { repoRoot: root, sh }));
    assert.equal(approved.code, 0, approved.stderr);
    writeFileSync(join(root, PLAN_REL), setPlanStatus(readPlan(root), 'pending-review'));
    assertRefusedUnchanged(root, await runPlanStatus(root, [SLUG, 'rejected']), /the approved gate passes/, snapshot(root));
  });
});

test('non-architect, bad status and bad feature names: exit 2, nothing changed', async () => {
  await withRepo(async ({ root }) => {
    const state = snapshot(root);
    assertRefusedUnchanged(root, await runPlanStatus(root, [SLUG, 'rejected'], { architects: [] }), /requires the architect role/, state);
    assertRefusedUnchanged(root, await runPlanStatus(root, [SLUG, 'approved']), /status must be one of rejected, needs-revision/, state);
    assertRefusedUnchanged(root, await runPlanStatus(root, [SLUG, '']), /status must be one of/, state);
    assertRefusedUnchanged(root, await runPlanStatus(root, ['Bad_Slug', 'rejected']), /invalid feature/, state);
    assertRefusedUnchanged(root, await runPlanStatus(root, ['_architecture', 'rejected']), /invalid feature/, state);
    assertRefusedUnchanged(root, await runPlanStatus(root, [SLUG]), /expected <feature> and <status>/, state);
    assertRefusedUnchanged(root, await runPlanStatus(root, [SLUG, 'rejected', '--trailer', 'bad trailer']), /invalid --trailer/, state);
  });
});

test('wrong branch and staged changes: exit 2, nothing changed', async () => {
  await withRepo(async ({ root }) => {
    git(root, ['checkout', '-q', '-b', 'other']);
    assertRefusedUnchanged(root, await runPlanStatus(root, [SLUG, 'rejected']), /not the work branch 'rad\/demo'/, snapshot(root));
    git(root, ['checkout', '-q', BRANCH]);
    writeFileSync(join(root, 'staged.txt'), 'x\n');
    git(root, ['add', 'staged.txt']);
    assertRefusedUnchanged(root, await runPlanStatus(root, [SLUG, 'rejected']), /staged changes are present/, snapshot(root));
  });
});

test('same-status rerun with newly appended ## Architect Feedback: commits only the plan file', async () => {
  await withRepo(async ({ root }) => {
    writeFileSync(join(root, 'seed.txt'), 'unrelated edit\n');
    assert.equal((await runPlanStatus(root, [SLUG, 'needs-revision'])).code, 0);
    const before = head(root);
    writeFileSync(join(root, PLAN_REL), `${readPlan(root)}\n## Architect Feedback\n\nSplit wave 1.\n`);
    const r = await runPlanStatus(root, [SLUG, 'needs-revision']);
    assert.equal(r.code, 0, r.stderr);
    assert.notEqual(head(root), before);
    assert.equal(filesIn(root), PLAN_REL);
    assert.match(git(root, ['show', 'HEAD:' + PLAN_REL]).stdout, /## Architect Feedback\n\nSplit wave 1\./);
    assert.match(r.stdout, /committed=true pushed=true/);
    assert.equal(git(root, ['status', '--porcelain']).stdout, 'M seed.txt', 'unrelated edit never committed');
  });
});

test('same-status rerun with nothing to commit: no commit, no push needed, still labels, exit 0', async () => {
  await withRepo(async ({ root }) => {
    assert.equal((await runPlanStatus(root, [SLUG, 'rejected'])).code, 0);
    const before = head(root);
    const r = await runPlanStatus(root, [SLUG, 'rejected']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(head(root), before);
    assert.match(r.stdout, /committed=false pushed=false/);
    assert.deepEqual(labelCalls(r.calls).map((c) => c.args), [['42', 'rejected']]);
  });
});

test('push failure: exit 1 with a safe-rerun hint; rerun pushes without a new commit, exit 0', async () => {
  await withRepo(async ({ root, base }) => {
    git(root, ['config', 'remote.origin.pushurl', join(base, 'no-such-origin.git')]);
    const first = await runPlanStatus(root, [SLUG, 'rejected']);
    assert.equal(first.code, 1, first.stderr);
    assert.match(first.stderr, /push failed: .*rerun of rad plan-status is safe/s);
    assert.equal(labelCalls(first.calls).length, 0, 'no label without a successful push');
    assert.deepEqual(reviewSubjects(root, `origin/${BRANCH}..${BRANCH}`), ['review: demo rejected']);

    git(root, ['config', '--unset', 'remote.origin.pushurl']);
    const second = await runPlanStatus(root, [SLUG, 'rejected']);
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /committed=false pushed=true/);
    assert.deepEqual(reviewSubjects(root, `origin/main..origin/${BRANCH}`), ['review: demo rejected']);
    assert.deepEqual(labelCalls(second.calls).map((c) => c.args), [['42', 'rejected']]);
  });
});
