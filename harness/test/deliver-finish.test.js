/**
 * makeFinishPort against a real temp repo with a bare origin (AC#3, AC#5),
 * plus upsertPlanHeader.
 *
 * git runs for real; rad-label.sh (it would reach real GitHub via gh) is
 * stubbed through the injected `sh`. Helpers are copied from
 * deliver-prepare.test.js rather than imported.
 *
 * Edge cases named: rerun with nothing new (label only), existing
 * Completed-At kept, no events log yet, plan without Issue:, wrong branch,
 * staged change, unreachable origin, bad options; upsertPlanHeader replace,
 * insert after Status, no Status (after title), non-string arguments.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { defaultSh } from '../adapters/git-state-store.js';
import { makeFinishPort } from '../deliver-finish.js';
import { upsertPlanHeader } from '../plan-commit.js';

const SLUG = 'demo';
const BRANCH = `rad/${SLUG}`;
const BASE = 'main';
const PLAN_REL = `.agents/plans/${SLUG}.md`;
const EVENTS_REL = `.agents/state/${SLUG}/events.jsonl`;
const ISO_PATTERN = /^Completed-At: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/m;
const KEPT_AT = '2026-01-02T03:04:05.000Z';
const IDENTITY = [['user.email', 't@example.com'], ['user.name', 'Tester'], ['commit.gpgsign', 'false']];
const ISSUE_PLAN = `# Plan: Demo feature
Created: 2026-10-07
Author: tester
Status: in-progress
Branch: rad/demo
Issue: 42

## Context

Status: not-a-header
`;
const NO_ISSUE_PLAN = ISSUE_PLAN.replace('Issue: 42\n', '');
const SEED_EVENT = '{"type":"approved"}\n';

function git(cwd, args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { status: res.status, stdout: (res.stdout ?? '').trim(), stderr: res.stderr ?? '' };
}

/** A work clone on rad/demo with the plan (+ events log unless `events` is false) committed and pushed. */
async function withRepo(fn, { plan = ISSUE_PLAN, events = true } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'rad-deliver-finish-'));
  const origin = join(base, 'origin.git');
  const root = join(base, 'work');
  try {
    git(base, ['init', '-q', '--bare', '-b', BASE, origin]);
    mkdirSync(root);
    git(root, ['init', '-q', '-b', BASE]);
    for (const [k, v] of IDENTITY) git(root, ['config', k, v]);
    writeFileSync(join(root, 'seed.txt'), 'seed\n');
    git(root, ['add', 'seed.txt']);
    git(root, ['commit', '-q', '-m', 'seed']);
    git(root, ['remote', 'add', 'origin', origin]);
    git(root, ['push', '-q', 'origin', BASE]);
    git(root, ['checkout', '-q', '-b', BRANCH]);
    mkdirSync(join(root, '.agents', 'plans'), { recursive: true });
    writeFileSync(join(root, PLAN_REL), plan);
    git(root, ['add', PLAN_REL]);
    if (events) {
      mkdirSync(join(root, '.agents', 'state', SLUG), { recursive: true });
      writeFileSync(join(root, EVENTS_REL), SEED_EVENT);
      git(root, ['add', EVENTS_REL]);
    }
    git(root, ['commit', '-q', '-m', 'plan: Demo feature']);
    git(root, ['push', '-q', '-u', 'origin', BRANCH]);
    return await fn({ root, origin });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
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

async function finish(root, step) {
  const { sh, calls } = makeSh(root);
  const port = makeFinishPort({ sh, root, feature: SLUG, planPath: PLAN_REL, workBranch: BRANCH });
  const { result, stdout } = await capture(port[step]);
  return { result, stdout, calls };
}

const labelCalls = (calls) => calls.filter((c) => c.file.endsWith('scripts/rad-label.sh'));
const head = (root) => git(root, ['rev-parse', 'HEAD']).stdout;
const remoteHead = (origin) => git(origin, ['rev-parse', `refs/heads/${BRANCH}`]).stdout;
const readPlan = (root) => readFileSync(join(root, PLAN_REL), 'utf8');
const subject = (root) => git(root, ['log', '-1', '--format=%s']).stdout;
const commitBody = (root) => git(root, ['log', '-1', '--format=%b']).stdout;
const changedFiles = (root) => git(root, ['show', '--name-only', '--format=', 'HEAD']).stdout.split('\n').sort();
const appendEvent = (root, type) => appendFileSync(join(root, EVENTS_REL), `{"type":"${type}"}\n`);

test('beforePr marks complete, commits plan + events once, pushes, labels review (AC#3)', async () => {
  await withRepo(async ({ root, origin }) => {
    appendEvent(root, 'wave-completed');
    const { result, calls } = await finish(root, 'beforePr');
    assert.deepEqual(result, { ok: true, data: { committed: true, pushed: true } });
    const plan = readPlan(root);
    assert.match(plan, /^Status: complete\nCompleted-At: /m);
    assert.match(plan, ISO_PATTERN);
    assert.match(plan, /^Status: not-a-header$/m, 'body lines are never touched');
    assert.equal(subject(root), `deliver(${SLUG}): mark plan complete`);
    assert.equal(commitBody(root), `Plan: ${PLAN_REL}\nIssue: 42`);
    assert.deepEqual(changedFiles(root), [EVENTS_REL, PLAN_REL].sort());
    assert.equal(remoteHead(origin), head(root));
    assert.deepEqual(labelCalls(calls).map((c) => c.args), [['42', 'review']]);
    assert.equal(git(root, ['status', '--porcelain']).stdout, '');
  });
});

test('a second beforePr is a no-op apart from the label (AC#5)', async () => {
  await withRepo(async ({ root, origin }) => {
    await finish(root, 'beforePr');
    const plan = readPlan(root);
    const tip = head(root);
    const { result, calls } = await finish(root, 'beforePr');
    assert.deepEqual(result, { ok: true, data: { committed: false, pushed: false } });
    assert.equal(readPlan(root), plan, 'Completed-At is not rewritten');
    assert.equal(head(root), tip);
    assert.equal(remoteHead(origin), tip);
    assert.equal(calls.some((c) => c.file === 'git' && c.args[0] === 'push'), false);
    assert.deepEqual(labelCalls(calls).map((c) => c.args), [['42', 'review']]);
  });
});

test('an existing Completed-At is kept', async () => {
  const plan = ISSUE_PLAN.replace('Status: in-progress\n', `Status: in-progress\nCompleted-At: ${KEPT_AT}\n`);
  await withRepo(async ({ root }) => {
    const { result } = await finish(root, 'beforePr');
    assert.equal(result.ok, true);
    const text = readPlan(root);
    assert.match(text, new RegExp(`^Status: complete\\nCompleted-At: ${KEPT_AT}$`, 'm'));
    assert.equal(text.match(/^Completed-At:/gm).length, 1);
  }, { plan });
});

test('beforePr with no events log yet commits the plan alone', async () => {
  await withRepo(async ({ root, origin }) => {
    const { result } = await finish(root, 'beforePr');
    assert.deepEqual(result, { ok: true, data: { committed: true, pushed: true } });
    assert.deepEqual(changedFiles(root), [PLAN_REL]);
    assert.equal(remoteHead(origin), head(root));
  }, { events: false });
});

test('afterPr commits and pushes only the events log (AC#3)', async () => {
  await withRepo(async ({ root, origin }) => {
    await finish(root, 'beforePr');
    appendEvent(root, 'pr-opened');
    writeFileSync(join(root, 'unrelated.txt'), 'x\n');
    const { result, calls } = await finish(root, 'afterPr');
    assert.deepEqual(result, { ok: true, data: { committed: true, pushed: true } });
    assert.equal(subject(root), `deliver(${SLUG}): record pr-opened`);
    assert.equal(commitBody(root), `Plan: ${PLAN_REL}\nIssue: 42`);
    assert.deepEqual(changedFiles(root), [EVENTS_REL]);
    assert.equal(remoteHead(origin), head(root));
    assert.deepEqual(labelCalls(calls).map((c) => c.args), [['42', 'review']]);
    assert.equal(git(root, ['status', '--porcelain']).stdout, '?? unrelated.txt');
    const again = await finish(root, 'afterPr');
    assert.deepEqual(again.result, { ok: true, data: { committed: false, pushed: false } });
  });
});

test('afterPr with no events log fails closed', async () => {
  await withRepo(async ({ root }) => {
    const { result } = await finish(root, 'afterPr');
    assert.equal(result.ok, false);
    assert.match(result.detail, /events\.jsonl is missing/);
  }, { events: false });
});

test('a plan with no Issue: skips the label without error', async () => {
  await withRepo(async ({ root }) => {
    const { result, stdout, calls } = await finish(root, 'beforePr');
    assert.equal(result.ok, true);
    assert.match(stdout, /label skipped/);
    assert.equal(labelCalls(calls).length, 0);
    assert.equal(commitBody(root), `Plan: ${PLAN_REL}`);
  }, { plan: NO_ISSUE_PLAN });
});

test('the wrong branch is refused before anything is written', async () => {
  await withRepo(async ({ root }) => {
    git(root, ['checkout', '-q', BASE]);
    for (const step of ['beforePr', 'afterPr']) {
      const { result } = await finish(root, step);
      assert.equal(result.ok, false);
      assert.match(result.detail, /not the work branch/);
    }
  });
});

test('staged changes are refused', async () => {
  await withRepo(async ({ root }) => {
    writeFileSync(join(root, 'staged.txt'), 'x\n');
    git(root, ['add', 'staged.txt']);
    const plan = readPlan(root);
    for (const step of ['beforePr', 'afterPr']) {
      const { result } = await finish(root, step);
      assert.equal(result.ok, false);
      assert.match(result.detail, /staged changes/);
    }
    assert.equal(readPlan(root), plan);
  });
});

test('an unreachable origin is a failure, never skipped', async () => {
  await withRepo(async ({ root }) => {
    git(root, ['remote', 'set-url', 'origin', join(root, 'no-such-origin.git')]);
    const { result, calls } = await finish(root, 'beforePr');
    assert.equal(result.ok, false);
    assert.match(result.detail, /exited/);
    assert.equal(labelCalls(calls).length, 0, 'no label after a failed push');
  });
});

test('bad options throw TypeError', () => {
  const sh = () => ({ status: 0, stdout: '', stderr: '' });
  const good = { sh, root: '/r', feature: SLUG, planPath: PLAN_REL, workBranch: BRANCH };
  assert.throws(() => makeFinishPort(), TypeError);
  assert.throws(() => makeFinishPort({ ...good, sh: 'git' }), TypeError);
  for (const key of ['root', 'feature', 'planPath', 'workBranch']) {
    assert.throws(() => makeFinishPort({ ...good, [key]: undefined }), TypeError, key);
    assert.throws(() => makeFinishPort({ ...good, [key]: 7 }), TypeError, key);
    assert.throws(() => makeFinishPort({ ...good, [key]: ' ' }), TypeError, key);
  }
});

test('upsertPlanHeader replaces an existing header line', () => {
  const text = '# Plan: X\nStatus: done\nCompleted-At: old\n\n## Context\nCompleted-At: body\n';
  assert.equal(upsertPlanHeader(text, 'Completed-At', 'new'), '# Plan: X\nStatus: done\nCompleted-At: new\n\n## Context\nCompleted-At: body\n');
});

test('upsertPlanHeader inserts right after Status', () => {
  const text = '# Plan: X\nAuthor: a\nStatus: done\nIssue: 1\n\n## Context\n';
  assert.equal(upsertPlanHeader(text, 'Completed-At', 't'), '# Plan: X\nAuthor: a\nStatus: done\nCompleted-At: t\nIssue: 1\n\n## Context\n');
});

test('upsertPlanHeader inserts after the title when the anchor key is absent', () => {
  const text = '# Plan: X\nAuthor: a\n\n## Context\n';
  assert.equal(upsertPlanHeader(text, 'Completed-At', 't'), '# Plan: X\nCompleted-At: t\nAuthor: a\n\n## Context\n');
  assert.equal(upsertPlanHeader(text, 'Reviewed', 'y', { after: 'Author' }), '# Plan: X\nAuthor: a\nReviewed: y\n\n## Context\n');
});

test('upsertPlanHeader rejects non-string arguments and multi-line values', () => {
  assert.throws(() => upsertPlanHeader(null, 'K', 'v'), TypeError);
  assert.throws(() => upsertPlanHeader('# Plan: X\n', 7, 'v'), TypeError);
  assert.throws(() => upsertPlanHeader('# Plan: X\n', 'K', undefined), TypeError);
  assert.throws(() => upsertPlanHeader('# Plan: X\n', 'K', 'a\nb'), /single line/);
  assert.throws(() => upsertPlanHeader('no title\n', 'K', 'v'), /anchor/);
});
