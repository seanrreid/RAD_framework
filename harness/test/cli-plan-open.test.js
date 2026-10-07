/**
 * `rad plan-open` (AC#4) against a real temp repo with a bare origin.
 *
 * git runs for real. The three scripts plan-open calls are stubbed through the
 * injected `sh`: get-default-branch.sh needs the repo's own harness/cli.js,
 * rad-label.sh would reach real GitHub via gh, and lint-plan.sh's verdict is
 * the input under test (its own rules are covered by scripts/test-lint-plan.sh).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { defaultSh } from '../adapters/git-state-store.js';
import { planOpenCommand } from '../plan-open.js';
import { planCommitMessage } from '../plan-commit.js';
import { main } from '../cli.js';

const SLUG = 'demo';
const BRANCH = `rad/${SLUG}`;
const PLAN_REL = `.agents/plans/${SLUG}.md`;
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
const NO_ISSUE_PLAN = ISSUE_PLAN.replace('Issue: 42\n', '');
const ADOPT_PLAN = ISSUE_PLAN.replace('Issue: 42\n', 'Adopted-From: https://github.com/o/r/issues/7\n');

function git(cwd, args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { status: res.status, stdout: (res.stdout ?? '').trim(), stderr: res.stderr ?? '' };
}

/** A work clone with one commit on main, pushed to a bare origin. */
async function withRepo(fn) {
  const base = mkdtempSync(join(tmpdir(), 'rad-plan-open-'));
  const origin = join(base, 'origin.git');
  const root = join(base, 'work');
  try {
    git(base, ['init', '-q', '--bare', '-b', 'main', origin]);
    mkdirSync(root);
    git(root, ['init', '-q', '-b', 'main']);
    for (const [k, v] of [['user.email', 't@example.com'], ['user.name', 'Tester'], ['commit.gpgsign', 'false']]) {
      git(root, ['config', k, v]);
    }
    writeFileSync(join(root, 'seed.txt'), 'seed\n');
    git(root, ['add', 'seed.txt']);
    git(root, ['commit', '-q', '-m', 'seed']);
    git(root, ['remote', 'add', 'origin', origin]);
    git(root, ['push', '-q', 'origin', 'main']);
    mkdirSync(join(root, '.agents', 'plans'), { recursive: true });
    return await fn({ root, origin, base });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

function writePlan(root, text) {
  writeFileSync(join(root, PLAN_REL), text);
}

/** `sh` that stubs the three scripts and records every call; git runs for real. */
function makeSh(root, { lintStatus = 0, lintOut = '', defaultStatus = 0 } = {}) {
  const calls = [];
  const sh = (file, args, opts) => {
    calls.push({ file, args });
    if (file === join(root, 'scripts/lint-plan.sh')) return { status: lintStatus, stdout: lintOut, stderr: '' };
    if (file === join(root, 'scripts/get-default-branch.sh')) {
      return { status: defaultStatus, stdout: defaultStatus === 0 ? 'main\n' : '', stderr: '' };
    }
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

function runPlanOpen(root, argv, shOpts) {
  const { sh, calls } = makeSh(root, shOpts);
  return capture(() => planOpenCommand(argv, { repoRoot: root, sh, env: {} }))
    .then((r) => ({ ...r, calls }));
}

const labelCalls = (calls) => calls.filter((c) => c.file.endsWith('scripts/rad-label.sh'));
const onOrigin = (root) => git(root, ['ls-remote', '--heads', 'origin', BRANCH]).stdout !== '';
const localExists = (root) => git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${BRANCH}`]).status === 0;

/** Assert a refusal: exit 2, a reason on stderr, no branch anywhere. */
function assertRefusedClean(root, r, reason) {
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, reason);
  assert.equal(localExists(root), false);
  assert.equal(onOrigin(root), false);
}

test('fresh run: branch on origin, one plan commit with the derived message, label after push', async () => {
  await withRepo(async ({ root }) => {
    writePlan(root, ISSUE_PLAN);
    const r = await runPlanOpen(root, [PLAN_REL]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(onOrigin(root));
    assert.equal(git(root, ['rev-list', '--count', `origin/main..${BRANCH}`]).stdout, '1');
    assert.equal(git(root, ['log', '-1', '--format=%B', BRANCH]).stdout, planCommitMessage(ISSUE_PLAN, []));
    assert.match(git(root, ['log', '-1', '--format=%s', BRANCH]).stdout, /^plan: Demo feature$/);
    assert.equal(git(root, ['diff-tree', '--no-commit-id', '--name-only', '-r', BRANCH]).stdout, PLAN_REL);
    const sha = git(root, ['rev-parse', BRANCH]).stdout;
    assert.equal(r.stdout.trim(), `rad plan-open: ok feature=demo branch=${BRANCH} commit=${sha} issue=42`);
    const labels = labelCalls(r.calls);
    assert.deepEqual(labels.map((c) => c.args), [['42', 'pending-review']]);
    const pushIdx = r.calls.findIndex((c) => c.file === 'git' && c.args[0] === 'push');
    assert.ok(pushIdx !== -1 && r.calls.indexOf(labels[0]) > pushIdx, 'label runs only after the push');
  });
});

test('adopted plan: adopt subject, --trailer appended, issue from Adopted-From', async () => {
  await withRepo(async ({ root }) => {
    writePlan(root, ADOPT_PLAN);
    const r = await runPlanOpen(root, [PLAN_REL, '--trailer', 'Refs: #186']);
    assert.equal(r.code, 0, r.stderr);
    const msg = git(root, ['log', '-1', '--format=%B', BRANCH]).stdout;
    assert.equal(msg, planCommitMessage(ADOPT_PLAN, ['Refs: #186']));
    assert.match(msg, /^adopt: Demo feature/);
    assert.match(msg, /\n\nRefs: #186$/);
    assert.deepEqual(labelCalls(r.calls).map((c) => c.args), [['7', 'pending-review']]);
  });
});

test('no issue: label skipped, ok line says issue=none', async () => {
  await withRepo(async ({ root }) => {
    writePlan(root, NO_ISSUE_PLAN);
    const r = await runPlanOpen(root, [PLAN_REL]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /label skipped: no issue/);
    assert.match(r.stdout, /issue=none$/m);
    assert.equal(labelCalls(r.calls).length, 0);
  });
});

test('refusals before any git change: bad argv, invalid trailer, bad path, Branch header', async () => {
  await withRepo(async ({ root }) => {
    writePlan(root, ISSUE_PLAN);
    assertRefusedClean(root, await runPlanOpen(root, []), /exactly one <plan-file>/);
    assertRefusedClean(root, await runPlanOpen(root, [PLAN_REL, '--trailer']), /requires/);
    assertRefusedClean(root, await runPlanOpen(root, [PLAN_REL, '--trailer', 'bad trailer']), /invalid --trailer/);
    assertRefusedClean(root, await runPlanOpen(root, [PLAN_REL, '--trailer', 'Key:   ']), /invalid --trailer/);
    assertRefusedClean(root, await runPlanOpen(root, ['seed.txt']), /\.agents\/plans\/<slug>\.md/);
    assertRefusedClean(root, await runPlanOpen(root, ['.agents/plans/Bad_Slug.md']), /invalid plan slug/);
    assertRefusedClean(root, await runPlanOpen(root, ['.agents/plans/missing.md']), /not found/);
    writePlan(root, ISSUE_PLAN.replace('Branch: rad/demo\n', ''));
    assertRefusedClean(root, await runPlanOpen(root, [PLAN_REL]), /no Branch: header/);
    writePlan(root, ISSUE_PLAN.replace('Branch: rad/demo', 'Branch: rad/other'));
    assertRefusedClean(root, await runPlanOpen(root, [PLAN_REL]), /must equal 'rad\/demo'/);
  });
});

test('lint failure refuses with its output passed through and no branch', async () => {
  await withRepo(async ({ root }) => {
    writePlan(root, ISSUE_PLAN);
    const r = await runPlanOpen(root, [PLAN_REL], { lintStatus: 1, lintOut: 'ERROR: Missing required section\n' });
    assertRefusedClean(root, r, /Missing required section/);
  });
});

test('dirty tracked tree refuses', async () => {
  await withRepo(async ({ root }) => {
    writePlan(root, ISSUE_PLAN);
    writeFileSync(join(root, 'seed.txt'), 'changed\n');
    assertRefusedClean(root, await runPlanOpen(root, [PLAN_REL]), /uncommitted changes/);
  });
});

test('default-branch lookup failure refuses', async () => {
  await withRepo(async ({ root }) => {
    writePlan(root, ISSUE_PLAN);
    assertRefusedClean(root, await runPlanOpen(root, [PLAN_REL], { defaultStatus: 1 }), /cannot resolve default branch/);
  });
});

test('branch only on origin refuses', async () => {
  await withRepo(async ({ root }) => {
    writePlan(root, ISSUE_PLAN);
    git(root, ['push', '-q', 'origin', `main:refs/heads/${BRANCH}`]);
    const r = await runPlanOpen(root, [PLAN_REL]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /exists on origin but not locally/);
    assert.equal(localExists(root), false);
  });
});

test('local branch with an unrelated commit refuses and is left untouched', async () => {
  await withRepo(async ({ root }) => {
    writePlan(root, ISSUE_PLAN);
    git(root, ['checkout', '-q', '-b', BRANCH]);
    writeFileSync(join(root, 'other.txt'), 'x\n');
    git(root, ['add', 'other.txt']);
    git(root, ['commit', '-q', '-m', 'unrelated']);
    const before = git(root, ['rev-parse', BRANCH]).stdout;
    const r = await runPlanOpen(root, [PLAN_REL]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /not this plan's commit/);
    assert.equal(git(root, ['rev-parse', BRANCH]).stdout, before);
    assert.equal(onOrigin(root), false);
  });
});

test('resume: an empty local branch continues at commit', async () => {
  await withRepo(async ({ root }) => {
    writePlan(root, ISSUE_PLAN);
    git(root, ['branch', BRANCH, 'origin/main']);
    const r = await runPlanOpen(root, [PLAN_REL]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(git(root, ['rev-list', '--count', `origin/main..${BRANCH}`]).stdout, '1');
    assert.ok(onOrigin(root));
  });
});

test('push failure exits 1 with a local commit; rerun pushes, exactly one plan commit', async () => {
  await withRepo(async ({ root, base }) => {
    writePlan(root, ISSUE_PLAN);
    git(root, ['config', 'remote.origin.pushurl', join(base, 'no-such-origin.git')]);
    const first = await runPlanOpen(root, [PLAN_REL]);
    assert.equal(first.code, 1, first.stderr);
    assert.match(first.stderr, /committed locally on rad\/demo; push failed: .*rerun of rad plan-open is safe/s);
    assert.equal(git(root, ['rev-list', '--count', `origin/main..${BRANCH}`]).stdout, '1');
    assert.equal(onOrigin(root), false);
    assert.equal(labelCalls(first.calls).length, 0, 'no label without a successful push');

    git(root, ['config', '--unset', 'remote.origin.pushurl']);
    const second = await runPlanOpen(root, [PLAN_REL]);
    assert.equal(second.code, 0, second.stderr);
    assert.ok(onOrigin(root));
    assert.equal(git(root, ['rev-list', '--count', `origin/main..origin/${BRANCH}`]).stdout, '1');
    assert.equal(second.calls.some((c) => c.file === 'git' && c.args[0] === 'commit'), false, 'rerun only pushes');
    assert.equal(labelCalls(second.calls).length, 1);
  });
});

test('rad help lists plan-open', async () => {
  const r = await capture(() => main(['--help']));
  assert.equal(r.code, 0);
  assert.match(r.stdout, /plan-open/);
  assert.match(r.stdout, /rad plan-open <plan-file> \[--trailer "Key: Value"\]\.\.\./);
});
