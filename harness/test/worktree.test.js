import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { makeWorktreeLifecycle } from '../adapters/worktree.js';
import { deliverCommand, worktreeEnabled } from '../cli.js';

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
 * @param {{ worktreePath?: string, branchEvents?: string|null, mainHead?: string,
 *   mainStatus?: string, worktreeList?: string, defaultBranch?: string }} opts
 *   branchEvents: stdout for `git show` (null → the log is absent at the ref)
 *   mainHead / mainStatus / worktreeList: the main checkout's `git rev-parse
 *   --abbrev-ref HEAD`, `git status --porcelain`, and `git worktree list --porcelain`
 *   defaultBranch: stdout of get-default-branch.sh
 *   staged: whether `git diff --cached --quiet` reports staged run events
 *   commitStatus: exit status of the run-events `git commit`
 */
function makeDeliverSh({
  worktreePath = '/nonexistent', branchEvents = APPROVED_EVENTS_JSONL,
  mainHead = 'main', mainStatus = '', worktreeList = '', defaultBranch = '',
  staged = true, commitStatus = 0,
} = {}) {
  const lifecycle = []; // { cmd, args, cwd }
  const gitShows = []; // { args, cwd }
  const gitCalls = []; // { args, cwd } — main-checkout inspection + checkout
  const spineCwds = []; // cwd of each other script call
  const runEventCalls = []; // { args, cwd } — run-events add / diff --cached / commit
  const order = []; // 'git <sub>' | 'lifecycle <cmd>', in call order
  const gitReplies = {
    'rev-parse': mainHead, status: mainStatus, worktree: worktreeList, checkout: '',
  };
  const runEventReplies = {
    add: () => 0, diff: () => (staged ? 1 : 0), commit: () => commitStatus,
  };
  const sh = (file, args, opts) => {
    if (file === 'git' && Object.hasOwn(runEventReplies, args[0])) {
      runEventCalls.push({ args, cwd: opts?.cwd });
      order.push(`git ${args[0]}`);
      const status = runEventReplies[args[0]]();
      return { status, stdout: '', stderr: status > 1 ? 'fatal: commit refused' : '' };
    }
    if (file === 'git' && Object.hasOwn(gitReplies, args[0])) {
      gitCalls.push({ args, cwd: opts?.cwd });
      return { status: 0, stdout: `${gitReplies[args[0]]}\n`, stderr: '' };
    }
    if (typeof file === 'string' && file.endsWith('get-default-branch.sh')) {
      spineCwds.push(opts?.cwd);
      return { status: 0, stdout: defaultBranch, stderr: '' };
    }
    if (typeof file === 'string' && file.endsWith('worktree-lifecycle.sh')) {
      lifecycle.push({ cmd: args[0], args, cwd: opts?.cwd });
      order.push(`lifecycle ${args[0]}`);
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
  sh.gitCalls = gitCalls;
  sh.spineCwds = spineCwds;
  sh.runEventCalls = runEventCalls;
  sh.order = order;
  return sh;
}

/**
 * Run deliverCommand with RAD_WORKTREE forced on ('1') / off ('0' — the only
 * opt-out; unset is ON), or left UNSET when `worktree` is undefined. Restores env after.
 */
async function runDeliver({ worktree, repoRoot, sh, runWave, env = {} }) {
  const names = ['RAD_WORKTREE', 'RAD_AGENT', 'ANTHROPIC_API_KEY', 'RAD_BRANCH_PREFIX'];
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  if (worktree === undefined) delete process.env.RAD_WORKTREE;
  else process.env.RAD_WORKTREE = worktree ? '1' : '0';
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

// ---------------------------------------------------------------------------
// WORKTREE BY DEFAULT + CHECKED-OUT RESOLUTION
//
// Isolation is ON unless RAD_WORKTREE is exactly '0'. Before create, the main
// checkout holding the work branch is switched to the default branch when clean,
// refused (exit 2, nothing touched) when dirty; a branch held by another
// worktree is refused (exit 2). A preserved worktree prints a cleanup command.
// ---------------------------------------------------------------------------

/** Run deliver capturing stderr; the plan + approval live in the fake worktree. */
async function runCaptured(opts) {
  const orig = process.stderr.write.bind(process.stderr);
  let stderr = '';
  process.stderr.write = (c) => { stderr += c; return true; };
  try {
    return { code: await runDeliver(opts), stderr };
  } finally {
    process.stderr.write = orig;
  }
}

test('worktreeEnabled: only exactly "0" opts out', () => {
  assert.equal(worktreeEnabled({}), true, 'unset → ON');
  assert.equal(worktreeEnabled({ RAD_WORKTREE: '' }), true, 'empty → ON');
  assert.equal(worktreeEnabled({ RAD_WORKTREE: '1' }), true);
  assert.equal(worktreeEnabled({ RAD_WORKTREE: 'false' }), true, 'any other value → ON');
  assert.equal(worktreeEnabled({ RAD_WORKTREE: ' 0' }), true, 'not exactly "0" → ON');
  assert.equal(worktreeEnabled({ RAD_WORKTREE: '0' }), false);
});

test('deliver: RAD_WORKTREE unset → isolated (worktree created, spine rooted there)', async () => {
  await withTempDirs(async (repoRoot, worktreeDir) => {
    writeApprovedPlan(worktreeDir, FEATURE);
    const sh = makeDeliverSh({ worktreePath: worktreeDir });

    const code = await runDeliver({ worktree: undefined, repoRoot, sh, runWave: async () => ({ outcome: 'success' }) });

    assert.equal(code, 0);
    assert.deepEqual(sh.lifecycle.map((c) => c.cmd), ['create', 'remove']);
    assert.ok(sh.spineCwds.every((cwd) => cwd === worktreeDir), JSON.stringify(sh.spineCwds));
  });
});

test('deliver: RAD_WORKTREE="" → isolated (empty is not the opt-out)', async () => {
  await withTempDirs(async (repoRoot, worktreeDir) => {
    writeApprovedPlan(worktreeDir, FEATURE);
    const sh = makeDeliverSh({ worktreePath: worktreeDir });

    const code = await runDeliver({
      worktree: undefined, repoRoot, sh, runWave: async () => ({ outcome: 'success' }), env: { RAD_WORKTREE: '' },
    });

    assert.equal(code, 0);
    assert.ok(sh.lifecycle.some((c) => c.cmd === 'create'), 'empty RAD_WORKTREE must still isolate');
  });
});

test('deliver: RAD_WORKTREE="0" → unisolated (no lifecycle, no main-checkout inspection)', async () => {
  await withTempDirs(async (repoRoot) => {
    writeApprovedPlan(repoRoot, FEATURE);
    const sh = makeDeliverSh();

    const code = await runDeliver({ worktree: false, repoRoot, sh, runWave: async () => ({ outcome: 'success' }) });

    assert.equal(code, 0);
    assert.equal(sh.lifecycle.length, 0);
    assert.equal(sh.gitCalls.length, 0, 'opt-out must not inspect or switch the main checkout');
  });
});

// ---------------------------------------------------------------------------
// Amendment 1 — run events are committed in the worktree BEFORE the non-forced
// lifecycle remove, so a successful isolated deliver leaves a clean tree.
// ---------------------------------------------------------------------------

const RUN_EVENTS_SUBJECT = `deliver(${FEATURE}): record deliver run events`;
/** A `git commit` status that makes the run-events commit fail. */
const COMMIT_FAILED_STATUS = 128;

test('deliver: success → run events added + committed in the worktree BEFORE remove', async () => {
  await withTempDirs(async (repoRoot, worktreeDir) => {
    writeApprovedPlan(worktreeDir, FEATURE);
    const sh = makeDeliverSh({ worktreePath: worktreeDir });

    const code = await runDeliver({ worktree: undefined, repoRoot, sh, runWave: async () => ({ outcome: 'success' }) });

    assert.equal(code, 0);
    assert.deepEqual(sh.order.slice(-4), ['git add', 'git diff', 'git commit', 'lifecycle remove']);
    const [add, , commit] = sh.runEventCalls;
    assert.deepEqual(add.args, ['add', '--', `.agents/state/${FEATURE}/`]);
    assert.deepEqual(commit.args, ['commit', '-m', RUN_EVENTS_SUBJECT]);
    assert.ok(sh.runEventCalls.every((c) => c.cwd === worktreeDir), 'git runs in the worktree root');
  });
});

test('deliver: success with nothing staged → no commit call, remove still runs', async () => {
  await withTempDirs(async (repoRoot, worktreeDir) => {
    writeApprovedPlan(worktreeDir, FEATURE);
    const sh = makeDeliverSh({ worktreePath: worktreeDir, staged: false });

    const code = await runDeliver({ worktree: undefined, repoRoot, sh, runWave: async () => ({ outcome: 'success' }) });

    assert.equal(code, 0);
    assert.deepEqual(sh.order.slice(-3), ['git add', 'git diff', 'lifecycle remove']);
    assert.ok(!sh.order.includes('git commit'), 'nothing staged → no commit');
  });
});

test('deliver: run-events commit fails → preserve + pointer, exit 1, remove NOT called', async () => {
  await withTempDirs(async (repoRoot, worktreeDir) => {
    writeApprovedPlan(worktreeDir, FEATURE);
    const sh = makeDeliverSh({ worktreePath: worktreeDir, commitStatus: COMMIT_FAILED_STATUS });

    const { code, stderr } = await runCaptured({
      worktree: undefined, repoRoot, sh, runWave: async () => ({ outcome: 'success' }),
    });

    assert.equal(code, 1);
    const cmds = sh.lifecycle.map((c) => c.cmd);
    assert.ok(cmds.includes('preserve'), 'a failed commit preserves the worktree');
    assert.ok(!cmds.includes('remove'), 'never remove (let alone force) a dirty worktree');
    assert.ok(stderr.includes('could not commit run events'), stderr);
    assert.ok(stderr.includes('fatal: commit refused'), 'the git reason is surfaced');
    assert.ok(stderr.includes(`rad deliver: worktree preserved at ${worktreeDir}`), stderr);
  });
});

test('deliver: RAD_WORKTREE="0" success → no run-events add/diff/commit calls', async () => {
  await withTempDirs(async (repoRoot) => {
    writeApprovedPlan(repoRoot, FEATURE);
    const sh = makeDeliverSh();

    const code = await runDeliver({ worktree: false, repoRoot, sh, runWave: async () => ({ outcome: 'success' }) });

    assert.equal(code, 0);
    assert.equal(sh.runEventCalls.length, 0, 'unisolated runs make no new git calls');
  });
});

test('deliver: main checkout on the work branch + clean → checkout <default>, then create', async () => {
  await withTempDirs(async (repoRoot, worktreeDir) => {
    writeApprovedPlan(worktreeDir, FEATURE);
    const sh = makeDeliverSh({ worktreePath: worktreeDir, mainHead: `rad/${FEATURE}`, defaultBranch: 'main' });

    const { code, stderr } = await runCaptured({
      worktree: undefined, repoRoot, sh, runWave: async () => ({ outcome: 'success' }),
    });

    assert.equal(code, 0);
    const checkout = sh.gitCalls.find((c) => c.args[0] === 'checkout');
    assert.deepEqual(checkout, { args: ['checkout', 'main'], cwd: repoRoot });
    assert.equal(sh.lifecycle[0].cmd, 'create', 'create runs after the switch');
    assert.ok(stderr.includes(
      `rad deliver: switched the main checkout from rad/${FEATURE} to main so the worktree can use rad/${FEATURE}`,
    ), stderr);
  });
});

test('deliver: main checkout on the work branch + dirty → exit 2, no events, no checkout, no create', async () => {
  await withTempDirs(async (repoRoot, worktreeDir) => {
    writeApprovedPlan(worktreeDir, FEATURE);
    const eventsBefore = readFileSync(join(worktreeDir, EVENTS_LOG_REL), 'utf8');
    const sh = makeDeliverSh({
      worktreePath: worktreeDir, mainHead: `rad/${FEATURE}`, mainStatus: ' M harness/cli.js', defaultBranch: 'main',
    });
    let called = false;

    const { code, stderr } = await runCaptured({
      worktree: undefined, repoRoot, sh, runWave: async () => { called = true; return { outcome: 'success' }; },
    });

    assert.equal(code, 2);
    assert.ok(!sh.gitCalls.some((c) => c.args[0] === 'checkout'), 'a dirty tree must never be switched');
    assert.equal(sh.lifecycle.length, 0, 'no worktree may be created');
    assert.equal(called, false);
    assert.equal(readFileSync(join(worktreeDir, EVENTS_LOG_REL), 'utf8'), eventsBefore, 'no event appended');
    assert.ok(!existsSync(join(repoRoot, '.agents')), 'nothing written under repoRoot');
    assert.ok(stderr.includes('Commit or stash your changes'), stderr);
    assert.ok(stderr.includes('git checkout main'), stderr);
  });
});

test('deliver: work branch checked out in another worktree → exit 2 with a git worktree list pointer', async () => {
  await withTempDirs(async (repoRoot, worktreeDir) => {
    writeApprovedPlan(worktreeDir, FEATURE);
    const worktreeList = [
      `worktree ${repoRoot}`, 'HEAD abc', 'branch refs/heads/main', '',
      'worktree /elsewhere/wt', 'HEAD def', `branch refs/heads/rad/${FEATURE}`, '',
    ].join('\n');
    const sh = makeDeliverSh({ worktreePath: worktreeDir, worktreeList });

    const { code, stderr } = await runCaptured({
      worktree: undefined, repoRoot, sh, runWave: async () => ({ outcome: 'success' }),
    });

    assert.equal(code, 2);
    assert.equal(sh.lifecycle.length, 0, 'no worktree may be created');
    assert.ok(stderr.includes('git worktree list'), stderr);
    assert.ok(stderr.includes('/elsewhere/wt'), stderr);
  });
});

test('deliver: a preserved worktree prints its path and the lifecycle remove command', async () => {
  await withTempDirs(async (repoRoot, worktreeDir) => {
    writeApprovedPlan(worktreeDir, FEATURE);
    const sh = makeDeliverSh({ worktreePath: worktreeDir });

    const { code, stderr } = await runCaptured({
      worktree: undefined, repoRoot, sh, runWave: async () => ({ outcome: 'fail-tests', summary: 'same failure' }),
    });

    assert.equal(code, 1);
    assert.ok(sh.lifecycle.some((c) => c.cmd === 'preserve'));
    assert.ok(stderr.includes(`rad deliver: worktree preserved at ${worktreeDir}`), stderr);
    assert.ok(stderr.includes(`scripts/worktree-lifecycle.sh remove ${FEATURE} ${worktreeDir}`), stderr);
  });
});
