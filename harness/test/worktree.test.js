import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
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
//   - returns success + a canned path for `worktree-lifecycle.sh create`
//   - records every lifecycle subcommand fired (create/remove/preserve)
//   - records the cwd every spine post-check runs under
// and we drive the spine's terminal shape via an injected runWave.
//
// No real git anywhere: the gate fold reads the events.jsonl fixture and the
// fake sh answers every script call.
// ---------------------------------------------------------------------------

const WORKTREE_PATH = '/tmp/fake-rad-worktrees/wt-feature';

async function withTempRepo(fn) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'rad-worktree-'));
  try {
    return await fn(repoRoot);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

/** Write an APPROVED plan (doc Status + approved event) so the gate fold passes. */
function writeApprovedPlan(repoRoot, feature) {
  const plansDir = join(repoRoot, '.agents', 'plans');
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
  const stateDir = join(repoRoot, '.agents', 'state', feature);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, 'events.jsonl'),
    JSON.stringify({
      type: 'approved',
      actor: 'arch@example.com',
      role: 'architect',
      ts: '2026-01-01T00:00:00.000Z',
    }) + '\n',
    'utf8',
  );
}

/**
 * A fake sh for the deliver path. Categorizes each call so a test can read back
 * which lifecycle subcommands fired and what cwd the spine ran scripts under.
 * Returns success for everything (gate fold reads the fixture, not sh).
 */
function makeDeliverSh() {
  const lifecycle = []; // { cmd, args, cwd }
  const spineCwds = []; // cwd of each non-lifecycle script call
  const sh = (file, args, opts) => {
    if (typeof file === 'string' && file.endsWith('worktree-lifecycle.sh')) {
      lifecycle.push({ cmd: args[0], args, cwd: opts?.cwd });
      // `create` must return the resolved path on the last stdout line.
      if (args[0] === 'create') {
        return { status: 0, stdout: `${WORKTREE_PATH}\n`, stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    }
    // Any other script (git config, check-*.sh, open-pr.sh) — record its cwd.
    spineCwds.push(opts?.cwd);
    return { status: 0, stdout: '', stderr: '' };
  };
  sh.lifecycle = lifecycle;
  sh.spineCwds = spineCwds;
  return sh;
}

const FEATURE = 'wt-feature';

/** Run deliverCommand with RAD_WORKTREE forced on/off, restoring env after. */
async function runDeliver({ worktree, repoRoot, sh, runWave }) {
  const saved = {
    wt: process.env.RAD_WORKTREE,
    agent: process.env.RAD_AGENT,
    key: process.env.ANTHROPIC_API_KEY,
  };
  if (worktree) process.env.RAD_WORKTREE = '1';
  else delete process.env.RAD_WORKTREE;
  // Injected runWave skips adapter construction, so no credentials are needed.
  delete process.env.RAD_AGENT;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    return await deliverCommand([FEATURE], { repoRoot, sh, runWave });
  } finally {
    for (const [k, envName] of [
      ['wt', 'RAD_WORKTREE'],
      ['agent', 'RAD_AGENT'],
      ['key', 'ANTHROPIC_API_KEY'],
    ]) {
      if (saved[k] !== undefined) process.env[envName] = saved[k];
      else delete process.env[envName];
    }
  }
}

test('deliver: AC#6 — mode-on + spine ok → complete called, preserve NOT called', async () => {
  await withTempRepo(async (repoRoot) => {
    writeApprovedPlan(repoRoot, FEATURE);
    const sh = makeDeliverSh();
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
  await withTempRepo(async (repoRoot) => {
    writeApprovedPlan(repoRoot, FEATURE);
    const sh = makeDeliverSh();
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
  await withTempRepo(async (repoRoot) => {
    writeApprovedPlan(repoRoot, FEATURE);
    const sh = makeDeliverSh();
    const runWave = async () => ({ outcome: 'success' });

    const code = await runDeliver({ worktree: false, repoRoot, sh, runWave });

    assert.equal(code, 0);
    assert.equal(sh.lifecycle.length, 0, 'mode-off must make NO worktree-lifecycle calls');
    // Parity: every spine script call runs under repoRoot (never a worktree dir).
    assert.ok(sh.spineCwds.length > 0, 'the spine must have run at least one script');
    assert.ok(
      sh.spineCwds.every((cwd) => cwd === repoRoot),
      `mode-off must bind sh to repoRoot; got cwds: ${JSON.stringify(sh.spineCwds)}`,
    );
  });
});

test('deliver: AC#1 — mode-on → spine sh bound to the worktree path, not repoRoot', async () => {
  await withTempRepo(async (repoRoot) => {
    writeApprovedPlan(repoRoot, FEATURE);
    const sh = makeDeliverSh();
    const runWave = async () => ({ outcome: 'success' });

    await runDeliver({ worktree: true, repoRoot, sh, runWave });

    // The spine's post-checks (check-scope/open-pr) must run inside the worktree.
    const spineInWorktree = sh.spineCwds.filter((cwd) => cwd === WORKTREE_PATH);
    assert.ok(
      spineInWorktree.length > 0,
      `mode-on must bind spine sh to the worktree path; got cwds: ${JSON.stringify(sh.spineCwds)}`,
    );
  });
});
