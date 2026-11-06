/**
 * `rad approve --disposition <category>:<disposition>[:<reason>]` (AC#6).
 *
 * Real temp repo + bare origin, as in cli-approve-commit.test.js. The real
 * record-insights-disposition.sh (and its lib) are copied into the repo so rows
 * land through the sanctioned writer; check-role.sh, check-approval-blockers.sh
 * and rad-label.sh stay stubbed through the injected `sh`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { defaultSh } from '../adapters/git-state-store.js';
import { approveCommand } from '../cli.js';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts');
const LEDGER_REL = '.agents/insights-ledger.jsonl';
const RECORD_SCRIPT = 'scripts/record-insights-disposition.sh';

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
    mkdirSync(join(root, 'scripts', 'lib'), { recursive: true });
    copyFileSync(join(SCRIPTS, 'record-insights-disposition.sh'), join(root, RECORD_SCRIPT));
    copyFileSync(join(SCRIPTS, 'lib', 'insights-ledger.sh'), join(root, 'scripts/lib/insights-ledger.sh'));
    git(root, ['add', PLAN_REL, 'scripts']);
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
function makeSh(root, { architects = [USER], blockerStatus = 0, failRecord = false } = {}) {
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
    if (failRecord && file === join(root, RECORD_SCRIPT)) return { status: 1, stdout: '', stderr: 'boom: disk full\n' };
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

const head = (root, ref = 'HEAD') => git(root, ['rev-parse', ref]).stdout;
const filesIn = (root, ref = 'HEAD') => git(root, ['diff-tree', '--no-commit-id', '--name-only', '-r', ref]).stdout.split('\n').sort();
const eventsExist = (root) => existsSync(join(root, EVENTS_REL));


const ledgerRows = (root) => {
  const f = join(root, LEDGER_REL);
  return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};

test('no --disposition: behavior unchanged — no ledger, commit holds only plan + event log', async () => {
  await withRepo(async ({ root }) => {
    const r = await runApprove(root, [SLUG]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(existsSync(join(root, LEDGER_REL)), false);
    assert.deepEqual(filesIn(root), [PLAN_REL, EVENTS_REL].sort());
    assert.equal(r.calls.some((c) => c.file.endsWith('record-insights-disposition.sh')), false);
  });
});

test('--disposition x2: rows appended after approval, in the approve commit, with the architect as actor', async () => {
  await withRepo(async ({ root }) => {
    const r = await runApprove(root, [SLUG, '--disposition', 'testing:adopted:wired', '--disposition', 'security:declined']);
    assert.equal(r.code, 0, r.stderr);
    const rows = ledgerRows(root);
    assert.deepEqual(rows.map((x) => [x.category, x.disposition, x.reason, x.actor]),
      [['testing', 'adopted', 'wired', USER], ['security', 'declined', undefined, USER]]);
    assert.deepEqual(filesIn(root), [PLAN_REL, EVENTS_REL, LEDGER_REL].sort());
    assert.equal(head(root, `origin/${BRANCH}`), head(root));
  });
});

test('reason containing ":" keeps everything after the second colon', async () => {
  await withRepo(async ({ root }) => {
    const r = await runApprove(root, [SLUG, '--disposition', 'testing:deferred:see PR: #12 (later)']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(ledgerRows(root)[0].reason, 'see PR: #12 (later)');
  });
});

test('two flags for one category: the latest wins, one row written', async () => {
  await withRepo(async ({ root }) => {
    const r = await runApprove(root, [SLUG, '--disposition', 'testing:declined:no', '--disposition', 'testing:adopted:yes']);
    assert.equal(r.code, 0, r.stderr);
    const rows = ledgerRows(root);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].disposition, rows[0].reason], ['adopted', 'yes']);
  });
});

const BAD_VALUES = [
  ['unknown disposition', 'testing:maybe', /unknown disposition 'maybe'/],
  ['missing disposition', 'testing', /unknown disposition ''/],
  ['empty category', ':adopted', /category must not be empty/],
];
for (const [name, value, reason] of BAD_VALUES) {
  test(`invalid disposition (${name}): exit 2, no approval, no row, valid sibling not written`, async () => {
    await withRepo(async ({ root }) => {
      const headBefore = head(root);
      const planBefore = readFileSync(join(root, PLAN_REL), 'utf8');
      const r = await runApprove(root, [SLUG, '--disposition', 'security:adopted', '--disposition', value]);
      assert.equal(r.code, 2, r.stderr);
      assert.match(r.stderr, reason);
      assert.equal(head(root), headBefore);
      assert.equal(eventsExist(root), false);
      assert.equal(existsSync(join(root, LEDGER_REL)), false);
      assert.equal(readFileSync(join(root, PLAN_REL), 'utf8'), planBefore);
    });
  });
}

test('--disposition without a value is a usage error with nothing written', async () => {
  await withRepo(async ({ root }) => {
    const r = await runApprove(root, [SLUG, '--disposition']);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /--disposition requires/);
    assert.equal(eventsExist(root), false);
  });
});

test('append failure after approval: non-zero exit, reason on stderr, approval event stays recorded, nothing committed', async () => {
  await withRepo(async ({ root }) => {
    const headBefore = head(root);
    const r = await runApprove(root, [SLUG, '--disposition', 'testing:adopted'], { failRecord: true });
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /approval recorded but the insights-ledger append failed for 'testing'/);
    assert.match(r.stderr, /boom: disk full/);
    assert.equal(eventsExist(root), true, 'approval stays recorded (rerun resumes)');
    assert.equal(head(root), headBefore, 'no approve commit when the ledger append failed');
    assert.equal(existsSync(join(root, LEDGER_REL)), false);
  });
});

test('--no-commit: rows appended after the record-only approval', async () => {
  await withRepo(async ({ root }) => {
    const r = await runApprove(root, [SLUG, '--no-commit', '--disposition', 'testing:adopted:ok']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(eventsExist(root), true);
    assert.equal(ledgerRows(root)[0].category, 'testing');
  });
});
