/**
 * `rad wrap <feature>` against a real temp repo with a bare origin (AC#2, AC#6),
 * plus `publishPlanChange` with no `labelStatus` (AC#1).
 *
 * git runs for real. rad-label.sh (it would reach real GitHub via gh) is
 * stubbed through the injected `sh` so a stray label call is recorded, not
 * made. Helpers are copied from cli-plan-status.test.js rather than imported.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { defaultSh } from '../adapters/git-state-store.js';
import { publishPlanChange } from '../branch-publish.js';
import { wrapCommand } from '../wrap.js';

const SLUG = 'demo';
const BRANCH = `rad/${SLUG}`;
const PLAN_REL = `.agents/plans/${SLUG}.md`;
const LOG_REL = `.agents/logs/${SLUG}-2026-10-09.md`;
const PREFIX_LOG_REL = `.agents/logs/${SLUG}-extra-2026-10-09.md`;
const USER = 't@example.com';
const PLAN = `# Plan: Demo feature
Created: 2026-10-07
Author: tester
Status: in-progress
Branch: rad/demo
Issue: 42

## Context

Demo.

### Wave 1
#### Task 1.1: one
`;
const NOTES = '\n## Session Notes\n\n- 2026-10-09: wrapped wave 1.\n';
const WRAP_SUBJECT = 'wrap(demo): session notes';

function git(cwd, args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { status: res.status, stdout: (res.stdout ?? '').trim(), stderr: res.stderr ?? '' };
}

/** A work clone whose rad/demo branch carries one plan commit, pushed to a bare origin and checked out. */
async function withRepo(fn, plan = PLAN) {
  const base = mkdtempSync(join(tmpdir(), 'rad-wrap-'));
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
    mkdirSync(join(root, '.agents', 'logs'), { recursive: true });
    writeFileSync(join(root, PLAN_REL), plan);
    git(root, ['add', PLAN_REL]);
    git(root, ['commit', '-q', '-m', 'plan: Demo feature']);
    git(root, ['push', '-q', '-u', 'origin', BRANCH]);
    return await fn({ root, origin, base });
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

function runWrap(root, argv = [SLUG]) {
  const { sh, calls } = makeSh(root);
  return capture(() => wrapCommand(argv, { repoRoot: root, sh })).then((r) => ({ ...r, calls }));
}

const labelCalls = (calls) => calls.filter((c) => c.file.endsWith('scripts/rad-label.sh'));
const head = (root, ref = 'HEAD') => git(root, ['rev-parse', ref]).stdout;
const message = (root, ref = 'HEAD') => git(root, ['log', '-1', '--format=%B', ref]).stdout;
const filesIn = (root, ref = 'HEAD') => git(root, ['diff-tree', '--no-commit-id', '--name-only', '-r', ref]).stdout.split('\n').sort();
const readPlan = (root) => readFileSync(join(root, PLAN_REL), 'utf8');
const statusLine = (text) => text.split('\n').find((l) => l.startsWith('Status:'));
const addNotes = (root) => appendFileSync(join(root, PLAN_REL), NOTES);

/** Assert a refusal that changed nothing: exit 2, reason, same HEAD, no label call. */
function assertRefused(root, r, reason, headBefore) {
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, reason);
  assert.equal(head(root), headBefore);
  assert.equal(labelCalls(r.calls).length, 0);
}

test('notes: commits only the plan with the wrap message, pushes, and never labels', async () => {
  await withRepo(async ({ root }) => {
    addNotes(root);
    writeFileSync(join(root, 'unrelated.txt'), 'dirty\n');
    const r = await runWrap(root);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /rad wrap: ok feature=demo committed=true pushed=true/);
    assert.match(r.stdout, /label skipped: no label requested/);
    assert.equal(labelCalls(r.calls).length, 0, 'no label call');
    assert.equal(message(root), `${WRAP_SUBJECT}\n\nPlan: ${PLAN_REL}`);
    assert.deepEqual(filesIn(root), [PLAN_REL]);
    assert.equal(head(root), head(root, `origin/${BRANCH}`));
    assert.equal(git(root, ['status', '--porcelain', '--', 'unrelated.txt']).stdout, '?? unrelated.txt');
  });
});

test('execution log: the exact-name log rides along; a prefix-sharing feature log does not', async () => {
  await withRepo(async ({ root }) => {
    addNotes(root);
    writeFileSync(join(root, LOG_REL), '| 1 | Wave 1 | one | ✓ complete |\n');
    writeFileSync(join(root, PREFIX_LOG_REL), 'other feature\n');
    const r = await runWrap(root);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(filesIn(root), [LOG_REL, PLAN_REL].sort());
    assert.equal(git(root, ['status', '--porcelain', '--', PREFIX_LOG_REL]).stdout, `?? ${PREFIX_LOG_REL}`);
  });
});

test('nothing to publish: exit 0, no commit, no push', async () => {
  await withRepo(async ({ root }) => {
    const before = head(root);
    const r = await runWrap(root);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /rad wrap: nothing to publish/);
    assert.match(r.stdout, /committed=false pushed=false/);
    assert.equal(head(root), before);
    assert.equal(labelCalls(r.calls).length, 0);
  });
});

test('Status: is never changed, whatever it reads', async () => {
  await withRepo(async ({ root }) => {
    addNotes(root);
    const r = await runWrap(root);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(statusLine(readPlan(root)), 'Status: in-progress');
    assert.equal(readPlan(root), PLAN + NOTES, 'plan content exactly as the model left it');
  });
});

test('refusal: HEAD is not the plan work branch (exit 2)', async () => {
  await withRepo(async ({ root }) => {
    git(root, ['checkout', '-q', 'main']);
    git(root, ['checkout', '-q', BRANCH, '--', PLAN_REL]);
    git(root, ['reset', '-q']);
    const before = head(root);
    assertRefused(root, await runWrap(root), /HEAD is on 'main', not the work branch 'rad\/demo'/, before);
  });
});

test('refusal: staged changes are present (exit 2)', async () => {
  await withRepo(async ({ root }) => {
    addNotes(root);
    writeFileSync(join(root, 'staged.txt'), 'x\n');
    git(root, ['add', 'staged.txt']);
    const before = head(root);
    assertRefused(root, await runWrap(root), /staged changes are present/, before);
  });
});

test('refusal: plan file missing (exit 2)', async () => {
  await withRepo(async ({ root }) => {
    const before = head(root);
    assertRefused(root, await runWrap(root, ['missing']), /plan file not found: \.agents\/plans\/missing\.md/, before);
  });
});

test('refusal: plan has no Branch: header (exit 2)', async () => {
  await withRepo(async ({ root }) => {
    const before = head(root);
    assertRefused(root, await runWrap(root), /has no Branch: header/, before);
  }, PLAN.replace('Branch: rad/demo\n', ''));
});

for (const bad of ['Bad_Name', '../x', '_architecture']) {
  test(`refusal: invalid feature '${bad}' prints usage (exit 2)`, async () => {
    await withRepo(async ({ root }) => {
      const r = await runWrap(root, [bad]);
      assertRefused(root, r, /invalid feature/, head(root));
      assert.match(r.stderr, /Usage: rad wrap <feature>/);
    });
  });
}

test('refusal: no feature, extra args, or an unknown option (exit 2)', async () => {
  await withRepo(async ({ root }) => {
    for (const argv of [[], [SLUG, 'extra'], [SLUG, '--label']]) {
      const r = await runWrap(root, argv);
      assert.equal(r.code, 2, `${argv.join(' ')}: ${r.stderr}`);
      assert.match(r.stderr, /Usage: rad wrap <feature>/);
    }
  });
});

test('push failure: exit 1 with a safe-rerun hint; rerun pushes without a new commit', async () => {
  await withRepo(async ({ root, base }) => {
    addNotes(root);
    git(root, ['config', 'remote.origin.pushurl', join(base, 'no-such-origin.git')]);
    const first = await runWrap(root);
    assert.equal(first.code, 1, first.stderr);
    assert.match(first.stderr, /push failed: .*rerun of rad wrap is safe/s);
    assert.equal(message(root).split('\n')[0], WRAP_SUBJECT);

    git(root, ['config', '--unset', 'remote.origin.pushurl']);
    const second = await runWrap(root);
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /committed=false pushed=true/);
    assert.equal(head(root), head(root, `origin/${BRANCH}`));
    assert.equal(labelCalls([...first.calls, ...second.calls]).length, 0);
  });
});

test('publishPlanChange: absent or null labelStatus skips labelling even with an issue', async () => {
  await withRepo(async ({ root }) => {
    for (const labelStatus of [undefined, null]) {
      addNotes(root);
      const { sh, calls } = makeSh(root);
      const req = { verb: 'rad test', branch: BRANCH, paths: [PLAN_REL], message: 'notes', issue: 42, labelStatus };
      const r = await capture(() => publishPlanChange(sh, root, req));
      assert.equal(r.code.code, 0, r.code.message);
      assert.match(r.stdout, /label skipped: no label requested/);
      assert.equal(labelCalls(calls).length, 0);
    }
  });
});

test('publishPlanChange: a given labelStatus still labels the issue', async () => {
  await withRepo(async ({ root }) => {
    addNotes(root);
    const { sh, calls } = makeSh(root);
    const req = { verb: 'rad test', branch: BRANCH, paths: [PLAN_REL], message: 'notes', issue: 42, labelStatus: 'rejected' };
    const r = await capture(() => publishPlanChange(sh, root, req));
    assert.equal(r.code.code, 0, r.code.message);
    assert.deepEqual(labelCalls(calls).map((c) => c.args), [['42', 'rejected']]);
  });
});

for (const labelStatus of ['', '   ']) {
  test(`publishPlanChange: a blank labelStatus (${JSON.stringify(labelStatus)}) is a TypeError`, () => {
    const req = { verb: 'rad test', branch: BRANCH, paths: [PLAN_REL], message: 'notes', issue: 42, labelStatus };
    assert.throws(() => publishPlanChange(() => assert.fail('sh must not run'), '/nowhere', req), TypeError);
  });
}
