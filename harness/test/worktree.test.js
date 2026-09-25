import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { makeWorktreeLifecycle } from '../adapters/worktree.js';
import { deliverCommand } from '../cli.js';

const SCRIPT = 'scripts/worktree-lifecycle.sh';

// ---------------------------------------------------------------------------
// ADAPTER — harness/adapters/worktree.js with a fake sh
//
// Every side effect routes through the injected `sh` boundary. The fake records
// each call and returns a canned { status, stdout, stderr }, so the adapter is
// exercised with no real git. Mirrors spine.test.js's fake-sh-callable style.
// ---------------------------------------------------------------------------

/** A fake sh that records calls and returns a scripted result per invocation. */
function makeFakeSh(result = () => ({ status: 0, stdout: '', stderr: '' })) {
  const calls = [];
  const sh = (file, args, opts) => {
    calls.push({ file, args, opts });
    return result({ file, args, opts });
  };
  sh.calls = calls;
  return sh;
}

test('adapter: create(feature, branch) invokes the create subcommand and returns the parsed path', () => {
  const path = '/tmp/repo-rad-worktrees/demo';
  const sh = makeFakeSh(() => ({
    // The script prints diagnostics to stderr and the resolved dir as the LAST
    // line of stdout; the adapter must return that last line.
    status: 0,
    stdout: `Preparing worktree\n${path}\n`,
    stderr: '',
  }));
  const lifecycle = makeWorktreeLifecycle({ sh, now: () => 't0' });

  const got = lifecycle.create('demo', 'rad/demo');

  assert.equal(got, path);
  assert.equal(sh.calls.length, 1);
  assert.equal(sh.calls[0].file, SCRIPT);
  assert.deepEqual(sh.calls[0].args, ['create', 'demo', 'rad/demo']);
});

test('adapter: complete(feature) issues the remove subcommand', () => {
  const sh = makeFakeSh();
  const lifecycle = makeWorktreeLifecycle({ sh, now: () => 't0' });

  lifecycle.complete('demo');

  assert.equal(sh.calls.length, 1);
  assert.equal(sh.calls[0].file, SCRIPT);
  assert.deepEqual(sh.calls[0].args, ['remove', 'demo']);
});

test('adapter: preserve(feature) issues the preserve subcommand', () => {
  const sh = makeFakeSh();
  const lifecycle = makeWorktreeLifecycle({ sh, now: () => 't0' });

  lifecycle.preserve('demo');

  assert.equal(sh.calls.length, 1);
  assert.equal(sh.calls[0].file, SCRIPT);
  assert.deepEqual(sh.calls[0].args, ['preserve', 'demo']);
});

test('adapter: AC#5 — a non-zero status on remove (marker missing) is surfaced as a throw', () => {
  // The script's safety interlock exits non-zero when the .rad-worktree.json
  // marker is missing/invalid. The adapter must propagate that as an error
  // rather than swallow it — remove is refused at the port level.
  const sh = makeFakeSh(() => ({
    status: 1,
    stdout: '',
    stderr: "refusing to remove '/tmp/demo' — no valid .rad-worktree.json for feature 'demo'",
  }));
  const lifecycle = makeWorktreeLifecycle({ sh, now: () => 't0' });

  assert.throws(
    () => lifecycle.complete('demo'),
    /worktree-lifecycle remove failed \(status 1\)/,
  );
});

// ---------------------------------------------------------------------------
// DELIVER PATH — harness/cli.js deliverCommand exercised with injected fakes
//
// deliverCommand's only seams are { repoRoot, sh, runWave }. The worktree
// lifecycle is constructed INTERNALLY from `sh` (bound to repoRoot), so we
// inject a single fake `sh` that:
//   - answers `git show <branch>:<events log>` with a canned branch-tip log
//   - returns success + a temp worktree dir for `worktree-lifecycle.sh create`
//   - records every lifecycle subcommand fired (create/remove/preserve)
//   - records the cwd every spine post-check runs under
// and we drive the spine's terminal shape via an injected runWave.
//
// Worktree mode reads the gate from the work-branch TIP and the plan + event
// log from the worktree (#113), so mode-on fixtures place the plan and events
// ONLY in the fake worktree dir (simulating the checked-out work branch) and
// in the fake `git show` output — never in repoRoot (Lane B). No real git.
// ---------------------------------------------------------------------------

const FEATURE = 'wt-feature';
const EVENTS_LOG_REL = join('.agents', 'state', FEATURE, 'events.jsonl');
const APPROVED_EVENTS_JSONL = JSON.stringify({
  type: 'approved',
  actor: 'arch@example.com',
  role: 'architect',
  ts: '2026-01-01T00:00:00.000Z',
}) + '\n';
/** A branch-tip log with no approval — the gate must refuse it. */
const UNAPPROVED_EVENTS_JSONL = JSON.stringify({
  type: 'plan-drafted',
  actor: 'dev@example.com',
  ts: '2026-01-01T00:00:00.000Z',
}) + '\n';
/** git's exit status for `git show` of a path absent at the ref. */
const GIT_SHOW_MISSING_STATUS = 128;

async function withTempDirs(fn) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'rad-worktree-'));
  const worktreeDir = mkdtempSync(join(tmpdir(), 'rad-worktree-wt-'));
  try {
    return await fn(repoRoot, worktreeDir);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(worktreeDir, { recursive: true, force: true });
  }
}

/** Write an APPROVED plan (doc Status + approved event) under `root`. */
function writeApprovedPlan(root, feature) {
  const plansDir = join(root, '.agents', 'plans');
  mkdirSync(plansDir, { recursive: true });
  writeFileSync(
    join(plansDir, `${feature}.md`),
    [
      `# ${feature}`,
      '',
      'Status: approved',
      `Branch: rad/${feature}`,
      '',
      '## Acceptance Criteria',
      '',
      '1. Example criterion.',
      '',
      '## Waves',
      '',
      '### Wave 1',
      '',
      '- [ ] Task A',
    ].join('\n'),
    'utf8',
  );
  const stateDir = join(root, '.agents', 'state', feature);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'events.jsonl'), APPROVED_EVENTS_JSONL, 'utf8');
}

/**
 * A fake sh for the deliver path. Categorizes each call so a test can read back
 * which lifecycle subcommands fired, which `git show` reads happened, and what
 * cwd the spine ran scripts under.
 *
 * @param {{ worktreePath?: string, branchEvents?: string|null }} opts
 *   branchEvents: stdout for `git show` (null → the log is absent at the ref)
 */
function makeDeliverSh({ worktreePath = '/nonexistent', branchEvents = APPROVED_EVENTS_JSONL } = {}) {
  const lifecycle = []; // { cmd, args, cwd }
  const gitShows = []; // { args, cwd }
  const spineCwds = []; // cwd of each other script call
  const sh = (file, args, opts) => {
    if (typeof file === 'string' && file.endsWith('worktree-lifecycle.sh')) {
      lifecycle.push({ cmd: args[0], args, cwd: opts?.cwd });
      // `create` must return the resolved path on the last stdout line.
      if (args[0] === 'create') {
        return { status: 0, stdout: `${worktreePath}\n`, stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    }
    if (file === 'git' && args[0] === 'show') {
      gitShows.push({ args, cwd: opts?.cwd });
      if (branchEvents === null) {
        return { status: GIT_SHOW_MISSING_STATUS, stdout: '', stderr: 'fatal: path does not exist' };
      }
      return { status: 0, stdout: branchEvents, stderr: '' };
    }
    // Any other script (check-*.sh, open-pr.sh) — record its cwd.
    spineCwds.push(opts?.cwd);
    return { status: 0, stdout: '', stderr: '' };
  };
  sh.lifecycle = lifecycle;
  sh.gitShows = gitShows;
  sh.spineCwds = spineCwds;
  return sh;
}

/** Run deliverCommand with RAD_WORKTREE forced on/off, restoring env after. */
async function runDeliver({ worktree, repoRoot, sh, runWave, env = {} }) {
  const names = ['RAD_WORKTREE', 'RAD_AGENT', 'ANTHROPIC_API_KEY', 'RAD_BRANCH_PREFIX'];
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  if (worktree) process.env.RAD_WORKTREE = '1';
  else delete process.env.RAD_WORKTREE;
  // Injected runWave skips adapter construction, so no credentials are needed.
  delete process.env.RAD_AGENT;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.RAD_BRANCH_PREFIX;
  Object.assign(process.env, env);
  try {
    return await deliverCommand([FEATURE], { repoRoot, sh, runWave });
  } finally {
    for (const n of names) {
      if (saved[n] !== undefined) process.env[n] = saved[n];
      else delete process.env[n];
    }
  }
}

test('deliver: AC#6 — mode-on + spine ok → complete called, preserve NOT called', async () => {
  await withTempDirs(async (repoRoot, worktreeDir) => {
    writeApprovedPlan(worktreeDir, FEATURE);
    const sh = makeDeliverSh({ worktreePath: worktreeDir });
    const runWave = async () => ({ outcome: 'success' });

    const code = await runDeliver({ worktree: true, repoRoot, sh, runWave });

    assert.equal(code, 0, 'a successful deliver returns exit 0');
    const cmds = sh.lifecycle.map((c) => c.cmd);
    assert.ok(cmds.includes('create'), 'worktree create must fire when mode-on');
    assert.ok(cmds.includes('remove'), 'complete → remove must fire on success');
    assert.ok(!cmds.includes('preserve'), 'preserve must NOT fire on success');
  });
});

test('deliver: AC#6 — mode-on + spine stopped terminal → preserve called, complete NOT called', async () => {
  await withTempDirs(async (repoRoot, worktreeDir) => {
    writeApprovedPlan(worktreeDir, FEATURE);
    const sh = makeDeliverSh({ worktreePath: worktreeDir });
    // A doom-loop-style stop: same outcome+summary on repeat is a terminal stop,
    // surfacing the spine's { stopped: ... } shape without a real failure path.
    const runWave = async () => ({ outcome: 'fail-tests', summary: 'same failure' });

    const code = await runDeliver({ worktree: true, repoRoot, sh, runWave });

    assert.equal(code, 1, 'a stopped deliver returns exit 1');
    const cmds = sh.lifecycle.map((c) => c.cmd);
    assert.ok(cmds.includes('create'), 'worktree create must fire when mode-on');
    assert.ok(cmds.includes('preserve'), 'preserve → must fire on a stopped terminal');
    assert.ok(!cmds.includes('remove'), 'complete/remove must NOT fire on a stop');
  });
});

test('deliver: AC#1 — mode-off → no lifecycle calls, spine sh bound to repoRoot', async () => {
  await withTempDirs(async (repoRoot) => {
    writeApprovedPlan(repoRoot, FEATURE);
    const sh = makeDeliverSh();
    const runWave = async () => ({ outcome: 'success' });

    const code = await runDeliver({ worktree: false, repoRoot, sh, runWave });

    assert.equal(code, 0);
    assert.equal(sh.lifecycle.length, 0, 'mode-off must make NO worktree-lifecycle calls');
    assert.equal(sh.gitShows.length, 0, 'mode-off must gate on the local log, not the branch tip');
    // Parity: every spine script call runs under repoRoot (never a worktree dir).
    assert.ok(sh.spineCwds.length > 0, 'the spine must have run at least one script');
    assert.ok(
      sh.spineCwds.every((cwd) => cwd === repoRoot),
      `mode-off must bind sh to repoRoot; got cwds: ${JSON.stringify(sh.spineCwds)}`,
    );
  });
});

test('deliver: AC#1 — mode-on → spine sh bound to the worktree path, not repoRoot', async () => {
  await withTempDirs(async (repoRoot, worktreeDir) => {
    writeApprovedPlan(worktreeDir, FEATURE);
    const sh = makeDeliverSh({ worktreePath: worktreeDir });
    const runWave = async () => ({ outcome: 'success' });

    await runDeliver({ worktree: true, repoRoot, sh, runWave });

    // The spine's post-checks (check-scope/open-pr) must run inside the worktree.
    assert.ok(sh.spineCwds.length > 0, 'the spine must have run at least one script');
    assert.ok(
      sh.spineCwds.every((cwd) => cwd === worktreeDir),
      `mode-on must bind spine sh to the worktree path; got cwds: ${JSON.stringify(sh.spineCwds)}`,
    );
  });
});

test('deliver: #113 AC#5 — Lane B: plan + approval only on the work branch → delivers, state rooted at the worktree', async () => {
  await withTempDirs(async (repoRoot, worktreeDir) => {
    writeApprovedPlan(worktreeDir, FEATURE);
    const sh = makeDeliverSh({ worktreePath: worktreeDir });
    const runWave = async () => ({ outcome: 'success' });

    const code = await runDeliver({ worktree: true, repoRoot, sh, runWave });

    assert.equal(code, 0, 'Lane B worktree deliver must succeed');
    // Gate read the branch tip through the sh port, from the main checkout.
    assert.deepEqual(sh.gitShows, [
      { args: ['show', `rad/${FEATURE}:.agents/state/${FEATURE}/events.jsonl`], cwd: repoRoot },
    ]);
    const create = sh.lifecycle.find((c) => c.cmd === 'create');
    assert.deepEqual(create.args, ['create', FEATURE, `rad/${FEATURE}`]);
    // Events were read + appended in the worktree (on the work branch)…
    const lines = readFileSync(join(worktreeDir, EVENTS_LOG_REL), 'utf8').trim().split('\n');
    assert.ok(lines.length > 1, 'the spine must append wave events under the worktree root');
    // …and the main checkout was never written.
    assert.ok(!existsSync(join(repoRoot, '.agents')), 'nothing may be written under repoRoot/.agents');
  });
});

test('deliver: #113 — worktree mode honors RAD_BRANCH_PREFIX for the gate read and the worktree', async () => {
  await withTempDirs(async (repoRoot, worktreeDir) => {
    writeApprovedPlan(worktreeDir, FEATURE);
    const sh = makeDeliverSh({ worktreePath: worktreeDir });
    const runWave = async () => ({ outcome: 'success' });

    const code = await runDeliver({
      worktree: true, repoRoot, sh, runWave, env: { RAD_BRANCH_PREFIX: 'feature/' },
    });

    assert.equal(code, 0);
    assert.equal(sh.gitShows[0].args[1], `feature/${FEATURE}:.agents/state/${FEATURE}/events.jsonl`);
    assert.deepEqual(sh.lifecycle.find((c) => c.cmd === 'create').args, ['create', FEATURE, `feature/${FEATURE}`]);
  });
});

test('deliver: #113 AC#6 — unapproved branch tip → exit 1 before any worktree is created', async () => {
  await withTempDirs(async (repoRoot, worktreeDir) => {
    writeApprovedPlan(worktreeDir, FEATURE); // even an approved worktree copy must not matter
    const sh = makeDeliverSh({ worktreePath: worktreeDir, branchEvents: UNAPPROVED_EVENTS_JSONL });
    let called = false;
    const runWave = async () => { called = true; return { outcome: 'success' }; };

    const code = await runDeliver({ worktree: true, repoRoot, sh, runWave });

    assert.equal(code, 1, 'an unapproved tip must fail the gate');
    assert.equal(sh.lifecycle.length, 0, 'no worktree-lifecycle call may happen before the gate passes');
    assert.equal(called, false, 'runWave must never be called');
  });
});

test('deliver: #113 AC#6 — event log absent at the branch tip (git show fails) → fail closed, no worktree', async () => {
  await withTempDirs(async (repoRoot, worktreeDir) => {
    const sh = makeDeliverSh({ worktreePath: worktreeDir, branchEvents: null });
    const runWave = async () => ({ outcome: 'success' });

    const code = await runDeliver({ worktree: true, repoRoot, sh, runWave });

    assert.equal(code, 1, 'a missing branch-tip log must fail the gate (fail-closed)');
    assert.equal(sh.lifecycle.length, 0, 'no worktree may be created when the log is absent');
  });
});

test('deliver: #113 — plan doc missing in the worktree → exit 1 and the worktree is preserved', async () => {
  await withTempDirs(async (repoRoot, worktreeDir) => {
    const sh = makeDeliverSh({ worktreePath: worktreeDir });
    const runWave = async () => ({ outcome: 'success' });

    const code = await runDeliver({ worktree: true, repoRoot, sh, runWave });

    assert.equal(code, 1);
    assert.deepEqual(sh.lifecycle.map((c) => c.cmd), ['create', 'preserve']);
  });
});
