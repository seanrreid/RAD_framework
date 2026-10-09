/**
 * `rad approve <feature>` default (commit) path against a real temp repo with a
 * bare origin (AC#1, AC#2, AC#4).
 *
 * git runs for real. Three scripts are stubbed through the injected `sh`:
 * check-role.sh (its role config is covered by scripts/test-check-role.sh),
 * check-approval-blockers.sh (its verdict is an input here) and rad-label.sh
 * (it would reach real GitHub via gh). Helpers are copied from
 * cli-plan-open.test.js rather than imported, so each file stands alone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { defaultSh } from '../adapters/git-state-store.js';
import { approveCommand } from '../cli.js';

const SLUG = 'demo';
const BRANCH = `rad/${SLUG}`;
const PLAN_REL = `.agents/plans/${SLUG}.md`;
const EVENTS_REL = `.agents/state/${SLUG}/events.jsonl`;
const USER = 't@example.com';
const OTHER_ARCHITECT = 'arch@example.com';
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

function git(cwd, args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { status: res.status, stdout: (res.stdout ?? '').trim(), stderr: res.stderr ?? '' };
}

/**
 * A work clone whose rad/demo branch carries one plan commit, pushed to a bare
 * origin and checked out — the state rad plan-open leaves behind.
 */
async function withRepo(fn, plan = ISSUE_PLAN) {
  const base = mkdtempSync(join(tmpdir(), 'rad-approve-commit-'));
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
function makeSh(root, { architects = [USER], blockerStatus = 0 } = {}) {
  const calls = [];
  const sh = (file, args, opts) => {
    calls.push({ file, args });
    if (file === join(root, 'scripts/check-role.sh')) {
      const identity = args[2] ?? USER;
      return architects.includes(identity)
        ? { status: 0, stdout: '', stderr: '' }
        : { status: 1, stdout: `Permission denied: ${identity}\n`, stderr: '' };
    }
    if (file === join(root, 'scripts/check-approval-blockers.sh')) {
      return { status: blockerStatus, stdout: '', stderr: blockerStatus === 0 ? '' : 'ERROR: unresolved marker\n' };
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

function runApprove(root, argv, shOpts) {
  const { sh, calls } = makeSh(root, shOpts);
  return capture(() => approveCommand(argv, { repoRoot: root, sh }))
    .then((r) => ({ ...r, calls }));
}

const labelCalls = (calls) => calls.filter((c) => c.file.endsWith('scripts/rad-label.sh'));
const head = (root, ref = 'HEAD') => git(root, ['rev-parse', ref]).stdout;
const message = (root, ref = 'HEAD') => git(root, ['log', '-1', '--format=%B', ref]).stdout;
const filesIn = (root, ref = 'HEAD') => git(root, ['diff-tree', '--no-commit-id', '--name-only', '-r', ref]).stdout.split('\n').sort();
const approveSubjects = (root, range) => git(root, ['log', '--format=%s', range]).stdout.split('\n').filter((s) => s.startsWith('approve:'));
const readPlan = (root) => readFileSync(join(root, PLAN_REL), 'utf8');
const eventsExist = (root) => existsSync(join(root, EVENTS_REL));

/** Assert a refusal that wrote nothing: exit code, reason, same HEAD, no event log, plan untouched. */
function assertNothingWritten(root, r, code, reason, { headBefore, planBefore }) {
  assert.equal(r.code, code, r.stderr);
  assert.match(r.stderr, reason);
  assert.equal(head(root), headBefore);
  assert.equal(eventsExist(root), false, 'no event log written');
  assert.equal(readPlan(root), planBefore, 'plan untouched');
}

test('direct approve: one commit with the exact subject and body, only plan + event log, pushed, labeled approved', async () => {
  await withRepo(async ({ root }) => {
    const r = await runApprove(root, [SLUG]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(message(root), [
      'approve: demo',
      '',
      `Plan: ${PLAN_REL}`,
      'Issue: 42',
      `Approved-By: ${USER}`,
    ].join('\n'));
    assert.deepEqual(filesIn(root), [PLAN_REL, EVENTS_REL].sort());
    assert.equal(head(root, `origin/${BRANCH}`), head(root), 'origin has the approve commit');
    assert.match(readPlan(root), /^Status: approved$/m);
    assert.match(r.stdout, /^rad approve: ok feature=demo status=approved approved-by=t@example\.com .* proxy=false committed=true pushed=true$/m);
    assert.doesNotMatch(r.stdout, /resumed=true/);
    const labels = labelCalls(r.calls);
    assert.deepEqual(labels.map((c) => c.args), [['42', 'approved']]);
    const pushIdx = r.calls.findIndex((c) => c.file === 'git' && c.args[0] === 'push');
    assert.ok(pushIdx !== -1 && r.calls.indexOf(labels[0]) > pushIdx, 'label runs only after the push');
  });
});

test('proxy approve: body carries Recorded-By and Approval-Evidence after Approved-By', async () => {
  await withRepo(async ({ root }) => {
    const r = await runApprove(
      root,
      [SLUG, '--on-behalf-of', OTHER_ARCHITECT, '--evidence', 'Slack 2026-10-07'],
      { architects: [OTHER_ARCHITECT] },
    );
    assert.equal(r.code, 0, r.stderr);
    assert.equal(message(root), [
      'approve: demo',
      '',
      `Plan: ${PLAN_REL}`,
      'Issue: 42',
      `Approved-By: ${OTHER_ARCHITECT}`,
      `Recorded-By: ${USER}`,
      'Approval-Evidence: Slack 2026-10-07',
    ].join('\n'));
    assert.match(r.stdout, /proxy=true committed=true pushed=true$/m);
  });
});

test('re-approval: --no-commit approval, body edit, then approve again commits with the (re-approval) subject', async () => {
  await withRepo(async ({ root }) => {
    const first = await runApprove(root, [SLUG, '--no-commit']);
    assert.equal(first.code, 0, first.stderr);
    writeFileSync(join(root, PLAN_REL), `${readPlan(root)}#### Task 1.2: two\n`);
    const second = await runApprove(root, [SLUG]);
    assert.equal(second.code, 0, second.stderr);
    assert.equal(git(root, ['log', '-1', '--format=%s']).stdout, 'approve: demo (re-approval)');
    assert.deepEqual(filesIn(root), [PLAN_REL, EVENTS_REL].sort());
    const approvals = readFileSync(join(root, EVENTS_REL), 'utf8').split('\n').filter((l) => l.includes('"approved"'));
    assert.equal(approvals.length, 2);
  });
});

/** Approve, then mark the feature delivered (pr-opened) with the header Status set to `complete`. */
async function approveThenDeliver(root) {
  const first = await runApprove(root, [SLUG]);
  assert.equal(first.code, 0, first.stderr);
  const pr = JSON.stringify({ feature: SLUG, type: 'pr-opened', actor: 'harness', ts: '2026-10-09T00:00:00.000Z' });
  writeFileSync(join(root, EVENTS_REL), `${readFileSync(join(root, EVENTS_REL), 'utf8')}${pr}\n`);
  writeFileSync(join(root, PLAN_REL), readPlan(root).replace(/^Status: approved$/m, 'Status: complete'));
  git(root, ['add', PLAN_REL, EVENTS_REL]);
  git(root, ['commit', '-q', '-m', 'deliver: demo']);
}

test('re-approval after delivery (#228): Status stays complete, provenance updates, ok line reports it', async () => {
  await withRepo(async ({ root }) => {
    await approveThenDeliver(root);
    writeFileSync(join(root, PLAN_REL), `${readPlan(root)}#### Task 1.2: two\n`);
    const r = await runApprove(root, [SLUG]);
    assert.equal(r.code, 0, r.stderr);
    const plan = readPlan(root);
    assert.match(plan, /^Status: complete$/m);
    assert.match(plan, new RegExp(`^Approved-By: ${USER}$`, 'm'));
    assert.match(plan, /^Approved-At: 2/m);
    assert.match(r.stdout, /status=complete /);
    assert.equal(git(root, ['log', '-1', '--format=%s']).stdout, 'approve: demo (re-approval)');
    assert.equal(head(root, `origin/${BRANCH}`), head(root), 'pushed');
  });
});

test('re-approval after delivery: a same-fingerprint repeat resumes without a duplicate event', async () => {
  await withRepo(async ({ root }) => {
    await approveThenDeliver(root);
    const before = readFileSync(join(root, EVENTS_REL), 'utf8');
    const r = await runApprove(root, [SLUG]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /resumed=true/);
    assert.match(r.stdout, /status=complete /);
    assert.equal(readFileSync(join(root, EVENTS_REL), 'utf8'), before);
  });
});

test('trailers: appended after the body in the order given', async () => {
  await withRepo(async ({ root }) => {
    const r = await runApprove(root, [SLUG, '--trailer', 'Refs: #186', '--trailer', 'Co-Authored-By: A <a@example.com>']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(message(root), /\nApproved-By: t@example\.com\n\nRefs: #186\nCo-Authored-By: A <a@example\.com>$/);
  });
});

test('push failure: exit 1 with a safe-rerun hint; restored origin rerun resumes with exactly one approve commit', async () => {
  await withRepo(async ({ root, base }) => {
    git(root, ['config', 'remote.origin.pushurl', join(base, 'no-such-origin.git')]);
    const first = await runApprove(root, [SLUG]);
    assert.equal(first.code, 1, first.stderr);
    assert.match(first.stderr, /push failed: .*rerun of rad approve is safe/s);
    assert.equal(labelCalls(first.calls).length, 0, 'no label without a successful push');
    assert.deepEqual(approveSubjects(root, `origin/${BRANCH}..${BRANCH}`), ['approve: demo']);

    git(root, ['config', '--unset', 'remote.origin.pushurl']);
    const second = await runApprove(root, [SLUG]);
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /committed=false pushed=true resumed=true$/m);
    assert.deepEqual(approveSubjects(root, `origin/main..origin/${BRANCH}`), ['approve: demo']);
    assert.deepEqual(labelCalls(second.calls).map((c) => c.args), [['42', 'approved']]);
  });
});

test('rerun after a full publish: exit 0, no new commit, resumed=true', async () => {
  await withRepo(async ({ root }) => {
    assert.equal((await runApprove(root, [SLUG])).code, 0);
    const before = head(root);
    const r = await runApprove(root, [SLUG]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(head(root), before);
    assert.match(r.stdout, /committed=false pushed=false resumed=true$/m);
    assert.equal(r.calls.some((c) => c.file === 'git' && c.args[0] === 'commit'), false);
  });
});

test('wrong branch: HEAD off the work branch refuses with exit 2 and writes nothing', async () => {
  await withRepo(async ({ root }) => {
    git(root, ['checkout', '-q', '-b', 'other']);
    const state = { headBefore: head(root), planBefore: readPlan(root) };
    assertNothingWritten(root, await runApprove(root, [SLUG]), 2, /not the work branch 'rad\/demo'/, state);
  });
});

test('staged unrelated file refuses with exit 2 and writes nothing', async () => {
  await withRepo(async ({ root }) => {
    writeFileSync(join(root, 'staged.txt'), 'x\n');
    git(root, ['add', 'staged.txt']);
    const state = { headBefore: head(root), planBefore: readPlan(root) };
    assertNothingWritten(root, await runApprove(root, [SLUG]), 2, /staged changes are present/, state);
  });
});

test('invalid --trailer and --trailer with --no-commit refuse with exit 2 and write nothing', async () => {
  await withRepo(async ({ root }) => {
    const state = { headBefore: head(root), planBefore: readPlan(root) };
    assertNothingWritten(root, await runApprove(root, [SLUG, '--trailer', 'bad trailer']), 2, /invalid --trailer/, state);
    assertNothingWritten(root, await runApprove(root, [SLUG, '--trailer', 'Key:   ']), 2, /invalid --trailer/, state);
    assertNothingWritten(root, await runApprove(root, [SLUG, '--no-commit', '--trailer', 'Refs: #1']), 2, /only valid without --no-commit/, state);
  });
});

test('authority and blocker refusals come first: exit 1 even on the wrong branch', async () => {
  await withRepo(async ({ root }) => {
    git(root, ['checkout', '-q', '-b', 'other']);
    const state = { headBefore: head(root), planBefore: readPlan(root) };
    assertNothingWritten(root, await runApprove(root, [SLUG], { architects: [] }), 1, /requires the architect role/, state);
    assertNothingWritten(root, await runApprove(root, [SLUG], { blockerStatus: 1 }), 1, /unresolved approval blockers/, state);
  });
});

test('unrelated unstaged edit is never committed and stays dirty', async () => {
  await withRepo(async ({ root }) => {
    writeFileSync(join(root, 'seed.txt'), 'changed\n');
    const r = await runApprove(root, [SLUG]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(filesIn(root), [PLAN_REL, EVENTS_REL].sort());
    assert.equal(git(root, ['status', '--porcelain']).stdout, 'M seed.txt');
  });
});

test('--no-commit: records only (no commit, no label), and a second run on the same plan exits 1', async () => {
  await withRepo(async ({ root }) => {
    const before = head(root);
    const first = await runApprove(root, [SLUG, '--no-commit']);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(head(root), before, 'no commit');
    assert.ok(eventsExist(root));
    assert.match(readPlan(root), /^Status: approved$/m);
    assert.doesNotMatch(first.stdout, /committed=/);
    assert.equal(labelCalls(first.calls).length, 0);
    const second = await runApprove(root, [SLUG, '--no-commit']);
    assert.equal(second.code, 1, second.stderr);
    assert.match(second.stderr, /cannot record approval/);
    assert.equal(head(root), before);
  });
});

test('no issue: label skipped with a message, publish still succeeds', async () => {
  await withRepo(async ({ root }) => {
    const r = await runApprove(root, [SLUG]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /label skipped: no issue/);
    assert.equal(labelCalls(r.calls).length, 0);
    assert.doesNotMatch(message(root), /^Issue:/m);
  }, NO_ISSUE_PLAN);
});
