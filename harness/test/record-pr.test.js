/**
 * `rad record-pr <feature> --pr <n>` against a real temp repo with a bare
 * origin (AC#3, AC#4, AC#5).
 *
 * git runs for real. gh (the PR lookup), check-approval-blockers.sh and
 * rad-label.sh are stubbed through the injected `sh` (check-role.sh too, for the approval setup). Helpers are copied from
 * cli-plan-status.test.js rather than imported.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { createGitStateStore, defaultSh } from '../adapters/git-state-store.js';
import { parseRecordPrArgs, recordPrCommand } from '../record-pr.js';
import { approveCommand } from '../cli.js';

const SLUG = 'demo';
const BRANCH = `rad/${SLUG}`;
const PLAN_REL = `.agents/plans/${SLUG}.md`;
const EVENTS_REL = `.agents/state/${SLUG}/events.jsonl`;
const USER = 't@example.com';
const PR = 77;
const PLAN = `# Plan: Demo feature
Created: 2026-10-07
Author: tester
Status: approved
Branch: rad/demo
Issue: 42

## Context

Demo.

### Wave 1
#### Task 1.1: one
`;
const OPEN_PR = { state: 'OPEN', headRefName: BRANCH };

function git(cwd, args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { status: res.status, stdout: (res.stdout ?? '').trim(), stderr: res.stderr ?? '' };
}

/** A work clone on rad/demo with a pushed plan commit and an `approved` event on disk. */
async function withRepo(fn) {
  const base = mkdtempSync(join(tmpdir(), 'rad-record-pr-'));
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
    writeFileSync(join(root, PLAN_REL), PLAN);
    git(root, ['add', PLAN_REL]);
    git(root, ['commit', '-q', '-m', 'plan: Demo feature']);
    git(root, ['push', '-q', '-u', 'origin', BRANCH]);
    return await fn({ root });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

/** `sh` stubbing gh (replies with `pr`, or fails when `ghFail`), the blockers check and the label script. */
function makeSh(root, { pr = OPEN_PR, ghFail = null, pushFail = false } = {}) {
  const calls = [];
  const sh = (file, args, opts) => {
    calls.push({ file, args });
    if (file === 'gh') {
      return ghFail ? { status: 1, stdout: '', stderr: ghFail } : { status: 0, stdout: JSON.stringify(pr), stderr: '' };
    }
    if (file === join(root, 'scripts/check-role.sh')) return { status: 0, stdout: '', stderr: '' };
    if (file === join(root, 'scripts/check-approval-blockers.sh')) return { status: 0, stdout: '', stderr: '' };
    if (file === join(root, 'scripts/rad-label.sh')) return { status: 0, stdout: '', stderr: '' };
    if (pushFail && file === 'git' && args[0] === 'push') return { status: 1, stdout: '', stderr: 'remote down' };
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

async function approve(root) {
  const { sh } = makeSh(root);
  const r = await capture(() => approveCommand([SLUG, '--no-commit'], { repoRoot: root, sh }));
  assert.equal(r.code, 0, r.stderr);
}

/** Append hand-built history events (a spine run that stopped, or one that opened its PR). */
function appendEvents(root, types) {
  const { sh } = makeSh(root);
  const state = createGitStateStore({ repoRoot: root, sh });
  for (const type of types) state.append({ feature: SLUG, type, actor: 'harness' });
}

async function run(root, argv, shOpts) {
  const { sh, calls } = makeSh(root, shOpts);
  const r = await capture(() => recordPrCommand(argv, { repoRoot: root, sh }));
  return { ...r, calls };
}

const head = (root, ref = 'HEAD') => git(root, ['rev-parse', ref]).stdout;
const filesIn = (root) => git(root, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']).stdout.split('\n').sort();
const readPlan = (root) => readFileSync(join(root, PLAN_REL), 'utf8');
const events = (root) => readFileSync(join(root, EVENTS_REL), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const prOpened = (root) => events(root).filter((e) => e.type === 'pr-opened');

async function assertRefused(root, argv, reason, shOpts) {
  const before = { head: head(root), plan: readPlan(root), events: readFileSync(join(root, EVENTS_REL), 'utf8') };
  const r = await run(root, argv, shOpts);
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, reason);
  assert.equal(head(root), before.head);
  assert.equal(readPlan(root), before.plan, 'plan untouched');
  assert.equal(readFileSync(join(root, EVENTS_REL), 'utf8'), before.events, 'events untouched');
}

test('success: one pr-opened with the PR number and marker, plan complete, only plan + events published', async () => {
  await withRepo(async ({ root }) => {
    await approve(root);
    const r = await run(root, [SLUG, '--pr', String(PR)]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(prOpened(root).map((e) => e.data), [{ pr: PR, handFinished: true }]);
    assert.match(readPlan(root), /^Status: complete$/m);
    assert.match(readPlan(root), /^Completed-At: \d{4}-\d{2}-\d{2}T/m);
    assert.deepEqual(filesIn(root), [PLAN_REL, EVENTS_REL].sort());
    assert.equal(head(root, `origin/${BRANCH}`), head(root), 'origin has the commit');
    assert.match(r.stdout, /rad record-pr: ok feature=demo pr=77 committed=true pushed=true issue=42/);
    assert.deepEqual(r.calls.find((c) => c.file === 'gh').args, ['pr', 'view', String(PR), '--json', 'state,headRefName']);
  });
});

test('refused: feature not approved', async () => {
  await withRepo(async ({ root }) => {
    mkdirSync(join(root, '.agents/state', SLUG), { recursive: true });
    writeFileSync(join(root, EVENTS_REL), '');
    await assertRefused(root, [SLUG, '--pr', String(PR)], /not approved/);
  });
});

test('refused: a pr-opened already follows the last deliver-started', async () => {
  await withRepo(async ({ root }) => {
    await approve(root);
    appendEvents(root, ['deliver-started', 'pr-opened']);
    await assertRefused(root, [SLUG, '--pr', String(PR)], /already records a pr-opened/);
  });
});

test('refused: PR not open, wrong head, unparseable output', async () => {
  await withRepo(async ({ root }) => {
    await approve(root);
    const argv = [SLUG, '--pr', String(PR)];
    await assertRefused(root, argv, /is MERGED, not OPEN/, { pr: { state: 'MERGED', headRefName: BRANCH } });
    await assertRefused(root, argv, /head is 'other', not the work branch 'rad\/demo'/, { pr: { state: 'OPEN', headRefName: 'other' } });
    await assertRefused(root, argv, /is in an unknown state/, { pr: {} });
    await assertRefused(root, argv, /is in an unknown state/, { pr: null });
  });
});

test('refused: lookup failure is reported with its reason', async () => {
  await withRepo(async ({ root }) => {
    await approve(root);
    await assertRefused(root, [SLUG, '--pr', String(PR)], /cannot look up PR #77 \(gh exited 1\): no such PR/, { ghFail: 'no such PR' });
  });
});

test('refused: not on the work branch', async () => {
  await withRepo(async ({ root }) => {
    await approve(root);
    const co = git(root, ['checkout', '-q', '-b', 'other']);
    assert.equal(co.status, 0, co.stderr);
    await assertRefused(root, [SLUG, '--pr', String(PR)], /not the work branch/);
  });
});

test('refused: missing plan file', async () => {
  await withRepo(async ({ root }) => {
    const r = await run(root, ['ghost', '--pr', '5']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /plan file not found/);
  });
});

test('argument errors: --pr missing, 0, negative, non-numeric, fractional; missing feature', () => {
  const bad = (argv, re) => assert.throws(() => parseRecordPrArgs(argv), (e) => e.code === 2 && re.test(e.message));
  bad([SLUG], /--pr <n> is required/);
  bad([SLUG, '--pr'], /--pr requires/);
  for (const v of ['0', '-3', 'abc', '1.5', '']) bad([SLUG, '--pr', v], /positive integer/);
  bad(['--pr', '5'], /exactly one <feature>/);
  bad(['Bad_Slug', '--pr', '5'], /invalid feature/);
  bad([SLUG, '--pr', '5', '--bogus'], /unknown option/);
  assert.deepEqual(parseRecordPrArgs([SLUG, '--pr', '12']), { feature: SLUG, pr: 12 });
});

test('rerun after a publish failure resumes without a second pr-opened', async () => {
  await withRepo(async ({ root }) => {
    await approve(root);
    const argv = [SLUG, '--pr', String(PR)];
    const failed = await run(root, argv, { pushFail: true });
    assert.equal(failed.code, 1);
    assert.match(failed.stderr, /a rerun of rad record-pr is safe and resumes/);
    assert.equal(prOpened(root).length, 1);
    // The resume must not need the lookup: a dead gh cannot block it.
    const rerun = await run(root, argv, { ghFail: 'offline' });
    assert.equal(rerun.code, 0, rerun.stderr);
    assert.equal(prOpened(root).length, 1, 'still exactly one pr-opened');
    assert.equal(rerun.calls.filter((c) => c.file === 'gh').length, 0);
    assert.equal(head(root, `origin/${BRANCH}`), head(root));
  });
});

test('a different PR number after a recorded one is refused, not appended', async () => {
  await withRepo(async ({ root }) => {
    await approve(root);
    assert.equal((await run(root, [SLUG, '--pr', String(PR)])).code, 0);
    await assertRefused(root, [SLUG, '--pr', '99'], /already records a pr-opened/);
  });
});

test('--help prints usage and exits 0', async () => {
  const r = await capture(() => recordPrCommand(['--help'], { repoRoot: '/nonexistent' }));
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Usage: rad record-pr <feature> --pr <n>/);
});
