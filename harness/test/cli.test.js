import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { approveCommand, gateCommand, parsePlanCtx, deliverCommand, stopStatusCommand } from '../cli.js';
import { planFingerprint } from '../plan-fingerprint.js';
import { createGitStateStore, defaultSh } from '../adapters/git-state-store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'cli.js');

// ---------------------------------------------------------------------------
// parsePlanCtx — per-wave model tiering (AC#2)
// ---------------------------------------------------------------------------

test('parsePlanCtx — a Model: line under ### Wave 2 lands in planCtx.waveModels[2]', () => {
  const plan = [
    '# feature',
    'Branch: rad/feature',
    '',
    '## Waves',
    '',
    '### Wave 1',
    'Type: sequential',
    '',
    '### Wave 2',
    'Type: sequential',
    'Model: claude-haiku-4-5',
    '',
    '### Wave 3',
    'Type: parallel',
  ].join('\n');

  const ctx = parsePlanCtx(plan);
  assert.equal(ctx.waveModels[2], 'claude-haiku-4-5', 'wave 2 model is captured');
  assert.equal(ctx.waveModels[1], undefined, 'wave 1 declares no model');
  assert.equal(ctx.waveModels[3], undefined, 'wave 3 declares no model');
});

// ---------------------------------------------------------------------------
// parsePlanCtx — per-wave verification declaration (AC#1)
//
// `Verify:` is OPT-IN and mirrors `Model:` exactly: same wave-block scoping,
// same "absent from the map when undeclared" rule. The absence case is the one
// that matters most — it is what guarantees a plan declaring no `Verify:`
// anywhere behaves byte-for-byte as it did before the feature existed.
// ---------------------------------------------------------------------------

test('parsePlanCtx — a Verify: line under ### Wave 2 lands in planCtx.waveVerify[2]', () => {
  const plan = [
    '# feature',
    'Branch: rad/feature',
    '',
    '## Waves',
    '',
    '### Wave 1',
    'Type: sequential',
    '',
    '### Wave 2',
    'Type: sequential',
    'Verify: npm test --prefix harness',
    '',
    '### Wave 3',
    'Type: parallel',
  ].join('\n');

  const ctx = parsePlanCtx(plan);
  assert.equal(ctx.waveVerify[2], 'npm test --prefix harness', 'wave 2 command is captured');
  assert.equal(ctx.waveVerify[1], undefined, 'wave 1 declares no command');
  assert.equal(ctx.waveVerify[3], undefined, 'wave 3 declares no command');
});

test('parsePlanCtx — AC#1: a plan with no Verify: line anywhere yields an EMPTY map', () => {
  const plan = [
    '# feature',
    'Branch: rad/feature',
    '',
    '## Waves',
    '',
    '### Wave 1',
    'Type: sequential',
    'Model: claude-haiku-4-5',
    '',
    '### Wave 2',
    'Type: sequential',
  ].join('\n');

  const ctx = parsePlanCtx(plan);
  // Empty, not undefined: the spine's default is `{}` and cli.js must hand it the
  // same thing, so the wave loop executes nothing and appends no `verify` key.
  assert.deepEqual(ctx.waveVerify, {}, 'no declaration → no entries at all');
  assert.equal(Object.keys(ctx.waveVerify).length, 0);
  // Declaring a Model: must not imply a Verify:, and vice versa — the two lines
  // are parsed independently.
  assert.equal(ctx.waveModels[1], 'claude-haiku-4-5');
});

test('parsePlanCtx — Verify: edge cases: empty value ignored, non-Wave heading ends the block, #### subheadings stay inside', () => {
  const plan = [
    '# feature',
    'Branch: rad/feature',
    '',
    '### Wave 1',
    'Verify:',                      // empty value → not a declaration
    '',
    '### Wave 2',
    '#### Task 2.1',                // deeper heading stays INSIDE wave 2
    'Verify:   bash scripts/test-check-verify.sh   ',
    '',
    '## Post-Delivery',             // a non-Wave heading closes the block
    'Verify: this must not be captured',
  ].join('\n');

  const ctx = parsePlanCtx(plan);
  assert.equal(ctx.waveVerify[1], undefined, 'an empty Verify: value declares nothing');
  assert.equal(
    ctx.waveVerify[2],
    'bash scripts/test-check-verify.sh',
    'a Verify: under a #### task subheading still belongs to the wave, trimmed',
  );
  // Nothing leaked out of the wave blocks into a stray key.
  assert.deepEqual(Object.keys(ctx.waveVerify), ['2']);
});

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

// Mirror the async wrapper from git-state-store.test.js: await fn() so an
// async callback completes before cleanup, and so both sync and async
// callbacks work transparently.
async function withTempRepo(fn) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'rad-cli-'));
  try {
    return await fn(repoRoot);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

/** Write a minimal plan doc with the given Status header. */
function writePlanDoc(repoRoot, feature, status = 'pending-review') {
  const plansDir = join(repoRoot, '.agents', 'plans');
  mkdirSync(plansDir, { recursive: true });
  const planFile = join(plansDir, `${feature}.md`);
  writeFileSync(
    planFile,
    [
      `# ${feature}`,
      '',
      `Status: ${status}`,
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
  return planFile;
}

// ---------------------------------------------------------------------------
// AC#1 — dispatch + help + unknown-subcommand exit codes
//
// These tests shell out to `node harness/cli.js` so they exercise the real
// process dispatch path (main → spec.run → process.exit) rather than the
// imported function.
// ---------------------------------------------------------------------------

test('AC#1 — --help exits 0 and stdout includes "approve"', () => {
  let stdout;
  try {
    stdout = execFileSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
  } catch (err) {
    // execFileSync throws on non-zero exit; re-throw with context.
    throw new Error(`expected exit 0, got ${err.status}: ${err.stderr}`);
  }
  assert.ok(stdout.includes('approve'), `stdout should mention "approve"; got:\n${stdout}`);
});

test('AC#1 — bare invocation (no args) exits 0 and prints usage', () => {
  let stdout;
  try {
    stdout = execFileSync(process.execPath, [CLI], { encoding: 'utf8' });
  } catch (err) {
    throw new Error(`expected exit 0, got ${err.status}: ${err.stderr}`);
  }
  assert.ok(stdout.length > 0, 'expected non-empty usage output');
  assert.ok(stdout.includes('rad'), `stdout should include "rad"; got:\n${stdout}`);
});

test('AC#1 — unknown subcommand exits non-zero with a message', () => {
  let threw = false;
  let exitCode;
  let stderr = '';
  try {
    execFileSync(process.execPath, [CLI, 'unknownverb'], { encoding: 'utf8' });
  } catch (err) {
    threw = true;
    exitCode = err.status;
    stderr = err.stderr ?? '';
  }
  assert.ok(threw, 'expected a non-zero exit for an unknown subcommand');
  assert.ok(exitCode !== 0, `expected non-zero exit code, got ${exitCode}`);
  assert.ok(stderr.includes('unknownverb'), `stderr should echo the unknown command; got:\n${stderr}`);
});

// ---------------------------------------------------------------------------
// AC#2 — approve records one `approved` event and satisfies the gate
//
// Uses a temp directory with a real CLAUDE.md and plan doc. sh is a hybrid
// mock: returns success for check-role.sh (simulates architect), and
// delegates to defaultSh for git operations (so `git config user.email`
// resolves correctly against the actual git config).
// ---------------------------------------------------------------------------

test('AC#2 — approve records approved event and gate passes (temp-repo fixture)', async () => {
  await withTempRepo(async (repoRoot) => {
    // A minimal CLAUDE.md so recordApproval's path exists.
    writeFileSync(join(repoRoot, 'CLAUDE.md'), '# CLAUDE\n', 'utf8');

    // Create a scripts/ directory placeholder so the roleScript path resolves.
    mkdirSync(join(repoRoot, 'scripts'), { recursive: true });

    const feature = 'test-feature';
    writePlanDoc(repoRoot, feature, 'pending-review');

    // Determine git user.email from the real git config (needed for assertion).
    const gitEmail = defaultSh('git', ['config', 'user.email'], { cwd: repoRoot });
    const expectedActor = (gitEmail.stdout || '').trim();

    // Hybrid mock sh:
    //   - check-role.sh calls → exit 0 (simulates architect)
    //   - all other calls (git ...) → delegate to defaultSh
    const roleScript = join(repoRoot, 'scripts', 'check-role.sh');
    const mockSh = (file, args, opts) => {
      if (file === roleScript || (typeof file === 'string' && file.endsWith('check-role.sh'))) {
        return { status: 0, stdout: '', stderr: '' };
      }
      if (typeof file === 'string' && file.endsWith('check-approval-blockers.sh')) {
        return { status: 0, stdout: '', stderr: '' };
      }
      return defaultSh(file, args, opts);
    };

    const code = await approveCommand([feature], { repoRoot, sh: mockSh });
    assert.equal(code, 0, `approveCommand should return 0; got ${code}`);

    // Assert exactly one approved event in events.jsonl.
    const eventsFile = join(repoRoot, '.agents', 'state', feature, 'events.jsonl');
    assert.ok(existsSync(eventsFile), 'events.jsonl should exist after approval');
    const lines = readFileSync(eventsFile, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1, 'should contain exactly one event');

    const event = JSON.parse(lines[0]);
    assert.equal(event.type, 'approved');
    // actor is the human identity (git user email), not the string 'architect'.
    assert.equal(event.actor, expectedActor, `actor should be git user email "${expectedActor}"`);
    assert.equal(event.role, 'architect', 'role should be frozen as "architect"');

    // Assert gate('test-feature', 'approved') passes.
    // Use the same mockSh for the store; inject no evaluateGate so the real
    // gates.js fold runs against the written event.
    const store = createGitStateStore({ repoRoot, sh: mockSh });
    const gateResult = await store.gate(feature, 'approved');
    assert.equal(gateResult.passed, true, `gate should pass; reason: ${gateResult.reason}`);

    // Assert the plan doc's Status line was updated to `approved` (dual-write).
    const planFile = join(repoRoot, '.agents', 'plans', `${feature}.md`);
    const planText = readFileSync(planFile, 'utf8');
    assert.ok(
      /^Status:\s*approved$/m.test(planText),
      `plan doc Status should be "approved"; got:\n${planText}`,
    );
  });
});

// ---------------------------------------------------------------------------
// AC#3 — non-architect is refused and nothing is written
//
// sh always returns non-zero for check-role.sh to simulate a caller who is
// not a configured architect. approve must return 1 and write no events.
// ---------------------------------------------------------------------------

test('AC#3 — non-architect is refused and no event is written', async () => {
  await withTempRepo(async (repoRoot) => {
    writeFileSync(join(repoRoot, 'CLAUDE.md'), '# CLAUDE\n', 'utf8');
    mkdirSync(join(repoRoot, 'scripts'), { recursive: true });

    const feature = 'test-feature';
    writePlanDoc(repoRoot, feature, 'pending-review');

    // Hybrid mock: check-role.sh returns non-zero (not an architect), git
    // calls delegate to defaultSh so `git config user.email` still resolves.
    const roleScript = join(repoRoot, 'scripts', 'check-role.sh');
    const mockSh = (file, args, opts) => {
      if (file === roleScript || (typeof file === 'string' && file.endsWith('check-role.sh'))) {
        return { status: 1, stdout: 'Permission denied', stderr: '' };
      }
      return defaultSh(file, args, opts);
    };

    const code = await approveCommand([feature], { repoRoot, sh: mockSh });
    assert.equal(code, 1, `approveCommand should return 1 for a non-architect; got ${code}`);

    // Nothing should have been written.
    const eventsFile = join(repoRoot, '.agents', 'state', feature, 'events.jsonl');
    assert.equal(
      existsSync(eventsFile),
      false,
      'events.jsonl must not exist when approval is refused',
    );
  });
});

// ---------------------------------------------------------------------------
// AC#1 (gate verb) — `gate <feature> <name>` pass / fail / no-write
//
// The on-disk gate path (state.gate → readEvents → evaluateGate) reads the
// per-feature events.jsonl directly from disk under repoRoot. Like the AC#2
// approve tests, these invoke the exported gateCommand with an injected
// `repoRoot` so the seeded temp-repo log is the one evaluated (the CLI's
// REPO_ROOT is fixed to the harness package, so a shelled-out cwd cannot
// redirect the on-disk path — only the injected repoRoot does). This still
// exercises the verb end-to-end: arg parse → state.gate → structured line →
// exit code.
//
// The --stdin path reads fd 0, so its tests shell out to `node cli.js` and pipe
// JSONL via execFileSync's `input` — repoRoot is irrelevant there.
//
// The approved event mirrors recordApproval's persisted shape:
//   { feature, type: 'approved', actor, role: 'architect', ts }.
// ---------------------------------------------------------------------------

/** Write a per-feature events.jsonl with the given events (one JSON object per line). */
function writeEventLog(repoRoot, feature, events) {
  const stateDir = join(repoRoot, '.agents', 'state', feature);
  mkdirSync(stateDir, { recursive: true });
  const file = join(stateDir, 'events.jsonl');
  writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  return file;
}

/** A well-formed approved event carrying the architect role (satisfies the gate). */
function approvedEvent(feature) {
  return {
    feature,
    type: 'approved',
    actor: 'architect@example.com',
    role: 'architect',
    ts: '2026-06-15T00:00:00.000Z',
  };
}

/** Capture the structured stdout line gateCommand writes (read-only assertion). */
function captureStdout(fn) {
  const original = process.stdout.write.bind(process.stdout);
  let captured = '';
  process.stdout.write = (chunk) => {
    captured += chunk;
    return true;
  };
  return Promise.resolve(fn())
    .then((value) => ({ value, stdout: captured }))
    .finally(() => {
      process.stdout.write = original;
    });
}

/** Invoke `node cli.js gate ...` as a subprocess. Returns { status, stdout, stderr }. */
function runGateProc(argv, opts = {}) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, 'gate', ...argv], {
      encoding: 'utf8',
      ...opts,
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return { status: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

test('AC#1 (gate) — approved event in the log → exit 0 and passed=true', async () => {
  await withTempRepo(async (repoRoot) => {
    writeFileSync(join(repoRoot, 'CLAUDE.md'), '# CLAUDE\n', 'utf8');

    const feature = 'gate-feature';
    writeEventLog(repoRoot, feature, [approvedEvent(feature)]);

    const { value: code, stdout } = await captureStdout(() =>
      gateCommand([feature, 'approved'], { repoRoot }),
    );
    assert.equal(code, 0, `gate should return 0 when an approved event exists; got ${code}`);
    assert.ok(stdout.includes('passed=true'), `stdout should report passed=true; got:\n${stdout}`);
    assert.ok(stdout.includes('source=log'), `stdout should report source=log; got:\n${stdout}`);
  });
});

test('AC#1 (gate) — no approved event → non-zero exit and passed=false', async () => {
  await withTempRepo(async (repoRoot) => {
    writeFileSync(join(repoRoot, 'CLAUDE.md'), '# CLAUDE\n', 'utf8');

    const feature = 'gate-feature';
    // A log that exists but holds no approved event — gate must fail closed.
    writeEventLog(repoRoot, feature, [
      { feature, type: 'planned', actor: 'dev@example.com', role: 'developer', ts: '2026-06-15T00:00:00.000Z' },
    ]);

    const { value: code, stdout } = await captureStdout(() =>
      gateCommand([feature, 'approved'], { repoRoot }),
    );
    assert.ok(code !== 0, `gate should return non-zero with no approved event; got ${code}`);
    assert.ok(stdout.includes('passed=false'), `stdout should report passed=false; got:\n${stdout}`);
  });
});

test('AC#1 (gate) — missing log fails closed → non-zero exit', async () => {
  await withTempRepo(async (repoRoot) => {
    writeFileSync(join(repoRoot, 'CLAUDE.md'), '# CLAUDE\n', 'utf8');

    const feature = 'gate-feature';
    // No events.jsonl written at all: absence must never pass the gate.
    const { value: code, stdout } = await captureStdout(() =>
      gateCommand([feature, 'approved'], { repoRoot }),
    );
    assert.ok(code !== 0, `gate should fail closed when the log is missing; got ${code}`);
    assert.ok(stdout.includes('passed=false'), `stdout should report passed=false; got:\n${stdout}`);
  });
});

test('AC#1 (gate) — writes nothing: log unchanged, no plan doc created', async () => {
  await withTempRepo(async (repoRoot) => {
    writeFileSync(join(repoRoot, 'CLAUDE.md'), '# CLAUDE\n', 'utf8');

    const feature = 'gate-feature';
    const logFile = writeEventLog(repoRoot, feature, [approvedEvent(feature)]);
    const before = readFileSync(logFile, 'utf8');

    const { value: code } = await captureStdout(() =>
      gateCommand([feature, 'approved'], { repoRoot }),
    );
    assert.equal(code, 0, 'gate should pass for the seeded approved event');

    // The verb is read-only: the event log is byte-for-byte unchanged...
    const after = readFileSync(logFile, 'utf8');
    assert.equal(after, before, 'gate must not mutate the event log');

    // ...and no plan doc was created as a side effect.
    const planFile = join(repoRoot, '.agents', 'plans', `${feature}.md`);
    assert.equal(existsSync(planFile), false, 'gate must not create a plan doc');
  });
});

test('AC#1 (gate) — --stdin path: piped approved event → exit 0 and source=stdin', async () => {
  await withTempRepo(async (repoRoot) => {
    writeFileSync(join(repoRoot, 'CLAUDE.md'), '# CLAUDE\n', 'utf8');

    const feature = 'gate-feature';
    // No on-disk log; the event arrives purely via stdin (JSONL). Shell out so
    // the verb reads a real fd 0.
    const piped = JSON.stringify(approvedEvent(feature)) + '\n';

    const { status, stdout } = runGateProc([feature, 'approved', '--stdin'], {
      cwd: repoRoot,
      input: piped,
    });
    assert.equal(status, 0, `gate --stdin should exit 0 for a piped approved event; got ${status}`);
    assert.ok(stdout.includes('passed=true'), `stdout should report passed=true; got:\n${stdout}`);
    assert.ok(stdout.includes('source=stdin'), `stdout should report source=stdin; got:\n${stdout}`);

    // --stdin path writes nothing on disk: no event log materialized.
    const logFile = join(repoRoot, '.agents', 'state', feature, 'events.jsonl');
    assert.equal(existsSync(logFile), false, 'gate --stdin must not write an event log');
  });
});

test('AC#1 (gate) — --stdin path: empty stdin fails closed → non-zero exit', async () => {
  await withTempRepo(async (repoRoot) => {
    writeFileSync(join(repoRoot, 'CLAUDE.md'), '# CLAUDE\n', 'utf8');

    const feature = 'gate-feature';
    const { status, stdout } = runGateProc([feature, 'approved', '--stdin'], {
      cwd: repoRoot,
      input: '',
    });
    assert.ok(status !== 0, `gate --stdin should fail closed on empty stdin; got ${status}`);
    assert.ok(stdout.includes('passed=false'), `stdout should report passed=false; got:\n${stdout}`);
  });
});

// ---------------------------------------------------------------------------
// rad deliver — stop-contract exit codes, completion fold, cap parsing, and
// the approvalIntact port (#77, AC#5 cli part + AC#6). Driven through
// deliverCommand with an injected runWave and a mock sh (no agent, no git).
// ---------------------------------------------------------------------------

const DELIVER_FEATURE = 'stop-feature';
/** Env knobs these tests control; saved and restored around each run. */
const DELIVER_ENV_KEYS = ['RAD_MAX_FAILED_ATTEMPTS', 'RAD_WORKTREE', 'RAD_TOKEN_BUDGET', 'RAD_SYNC'];

/** A two-wave plan doc body; `extra` appends body text (changes the fingerprint). */
function twoWavePlanText(extra = '') {
  return [
    `# ${DELIVER_FEATURE}`,
    '',
    'Status: approved',
    `Branch: rad/${DELIVER_FEATURE}`,
    '',
    '## Waves',
    '',
    '### Wave 1',
    '',
    '- [ ] Task A',
    '',
    '### Wave 2',
    '',
    '- [ ] Task B',
    extra,
  ].join('\n');
}

/** Seed the plan doc and an approved event carrying its body fingerprint. */
function seedApprovedTwoWavePlan(repoRoot) {
  const planFile = join(repoRoot, '.agents', 'plans', `${DELIVER_FEATURE}.md`);
  mkdirSync(dirname(planFile), { recursive: true });
  const text = twoWavePlanText();
  writeFileSync(planFile, text, 'utf8');
  const event = {
    ...approvedEvent(DELIVER_FEATURE),
    data: { fingerprint: planFingerprint(text).hash },
  };
  const logFile = writeEventLog(repoRoot, DELIVER_FEATURE, [event]);
  return { planFile, logFile };
}

const okSh = () => ({ status: 0, stdout: '', stderr: '' });

/** Run deliverCommand with the given env overrides, capturing stderr. */
async function runDeliverCaptured({ repoRoot, runWave, sh = okSh, env = {}, args = [] }) {
  const saved = Object.fromEntries(DELIVER_ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of DELIVER_ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  const originalErr = process.stderr.write.bind(process.stderr);
  let stderr = '';
  process.stderr.write = (chunk) => { stderr += chunk; return true; };
  try {
    const { value: code } = await captureStdout(() =>
      deliverCommand([DELIVER_FEATURE, ...args], { repoRoot, sh, runWave }),
    );
    return { code, stderr };
  } finally {
    process.stderr.write = originalErr;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const readLog = (logFile) => readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('deliver AC#6 — ok with the fold confirming completion → exit 0', async () => {
  await withTempRepo(async (repoRoot) => {
    const { logFile } = seedApprovedTwoWavePlan(repoRoot);
    const { code, stderr } = await runDeliverCaptured({
      repoRoot,
      runWave: async () => ({ outcome: 'success' }),
    });
    assert.equal(code, 0, `expected exit 0; stderr:\n${stderr}`);
    assert.ok(readLog(logFile).some((e) => e.type === 'pr-opened'));
  });
});

test('deliver AC#6 — surface terminal (fail-timeout) → exit 3 with class=needs-decision', async () => {
  await withTempRepo(async (repoRoot) => {
    seedApprovedTwoWavePlan(repoRoot);
    const { code, stderr } = await runDeliverCaptured({
      repoRoot,
      runWave: async () => ({ outcome: 'fail-timeout' }),
    });
    assert.equal(code, 3, `expected exit 3; stderr:\n${stderr}`);
    assert.match(stderr, /stopped=matrix/);
    assert.match(stderr, /class=needs-decision/);
    assert.match(stderr, /decision="wave 1: fail-timeout/);
  });
});

test('deliver AC#6 — abort terminal (fail-scope) → exit 1 with class=failed', async () => {
  await withTempRepo(async (repoRoot) => {
    seedApprovedTwoWavePlan(repoRoot);
    const { code, stderr } = await runDeliverCaptured({
      repoRoot,
      runWave: async () => ({ outcome: 'fail-scope' }),
    });
    assert.equal(code, 1, `expected exit 1; stderr:\n${stderr}`);
    assert.match(stderr, /class=failed/);
    assert.match(stderr, /decision="/);
  });
});

test('deliver AC#6 — spine ok but the log lacks a wave-complete → exit 1 completion not evidenced', async () => {
  await withTempRepo(async (repoRoot) => {
    const { logFile } = seedApprovedTwoWavePlan(repoRoot);
    // The post-checks run after every wave-complete and before pr-opened; this
    // sh strips the wave-complete events there, so the spine still returns ok.
    const stripSh = (script) => {
      if (String(script).includes('check-scope')) {
        const kept = readLog(logFile).filter((e) => e.type !== 'wave-complete');
        writeFileSync(logFile, kept.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
      }
      return okSh();
    };
    const { code, stderr } = await runDeliverCaptured({
      repoRoot,
      sh: stripSh,
      runWave: async () => ({ outcome: 'success' }),
    });
    assert.equal(code, 1, `expected exit 1; stderr:\n${stderr}`);
    assert.match(stderr, /completion not evidenced/);
  });
});

test('deliver AC#6 — resumed run completes waves a prior run finished → exit 0', async () => {
  await withTempRepo(async (repoRoot) => {
    const { logFile } = seedApprovedTwoWavePlan(repoRoot);
    // Prior run: wave 1 succeeds, wave 2 aborts (fail-scope) → the log holds
    // wave 1's wave-complete BEFORE the resumed run's deliver-started.
    const first = await runDeliverCaptured({
      repoRoot,
      runWave: async (wave) => ({ outcome: wave.n === 1 ? 'success' : 'fail-scope' }),
    });
    assert.equal(first.code, 1, `prior run must stop; stderr:\n${first.stderr}`);
    // Resumed run: only wave 2 runs; wave 1's completion is from the prior run.
    const ran = [];
    const { code, stderr } = await runDeliverCaptured({
      repoRoot,
      runWave: async (wave) => { ran.push(wave.n); return { outcome: 'success' }; },
    });
    assert.equal(code, 0, `expected exit 0; stderr:\n${stderr}`);
    assert.deepEqual(ran, [2], 'the resumed run must skip wave 1');
    const log = readLog(logFile);
    const lastStart = log.map((e) => e.type).lastIndexOf('deliver-started');
    const wave1Done = log.findIndex((e) => e.type === 'wave-complete' && e.data && e.data.wave === 1);
    assert.ok(wave1Done !== -1 && wave1Done < lastStart, 'wave 1 completed before the latest deliver-started');
    assert.ok(log.slice(lastStart + 1).some((e) => e.type === 'pr-opened'));
  });
});

for (const bad of ['abc', '0', '-1', '1.5', ' 2']) {
  test(`deliver AC#5 — malformed RAD_MAX_FAILED_ATTEMPTS '${bad}' → exit 2, no events appended`, async () => {
    await withTempRepo(async (repoRoot) => {
      const { logFile } = seedApprovedTwoWavePlan(repoRoot);
      const before = readFileSync(logFile, 'utf8');
      let calls = 0;
      const { code, stderr } = await runDeliverCaptured({
        repoRoot,
        env: { RAD_MAX_FAILED_ATTEMPTS: bad },
        runWave: async () => { calls += 1; return { outcome: 'success' }; },
      });
      assert.equal(code, 2, `expected exit 2; stderr:\n${stderr}`);
      assert.match(stderr, /RAD_MAX_FAILED_ATTEMPTS must be a positive integer/);
      assert.equal(readFileSync(logFile, 'utf8'), before, 'no event may be appended');
      assert.equal(calls, 0, 'runWave must never run');
    });
  });
}

test('deliver AC#5 — a valid RAD_MAX_FAILED_ATTEMPTS arms the cap → exit 3 failed-attempt-cap', async () => {
  await withTempRepo(async (repoRoot) => {
    seedApprovedTwoWavePlan(repoRoot);
    let n = 0;
    const { code, stderr } = await runDeliverCaptured({
      repoRoot,
      env: { RAD_MAX_FAILED_ATTEMPTS: '1' },
      // Distinct summaries so the doom-loop check does not trip first.
      runWave: async () => ({ outcome: 'fail-tests', summary: `failure ${(n += 1)}` }),
    });
    assert.equal(code, 3, `expected exit 3; stderr:\n${stderr}`);
    assert.match(stderr, /stopped=failed-attempt-cap/);
    assert.match(stderr, /class=needs-decision/);
  });
});

test('deliver AC#6 — plan edited during wave 1 → exit 3 approval-changed before wave 2', async () => {
  await withTempRepo(async (repoRoot) => {
    const { planFile, logFile } = seedApprovedTwoWavePlan(repoRoot);
    const ran = [];
    const { code, stderr } = await runDeliverCaptured({
      repoRoot,
      runWave: async (wave) => {
        ran.push(wave.n);
        if (wave.n === 1) writeFileSync(planFile, twoWavePlanText('- [ ] Task C (sneaked in)'), 'utf8');
        return { outcome: 'success' };
      },
    });
    assert.equal(code, 3, `expected exit 3; stderr:\n${stderr}`);
    assert.match(stderr, /stopped=approval-changed/);
    assert.match(stderr, /class=needs-decision/);
    assert.deepEqual(ran, [1], 'wave 2 must never run');
    const last = readLog(logFile).at(-1);
    assert.equal(last.type, 'deliver-stopped');
  });
});

test('deliver AC#6 — legacy approval without a fingerprint passes the approval port', async () => {
  await withTempRepo(async (repoRoot) => {
    const { planFile } = seedApprovedTwoWavePlan(repoRoot);
    writeEventLog(repoRoot, DELIVER_FEATURE, [approvedEvent(DELIVER_FEATURE)]);
    const { code, stderr } = await runDeliverCaptured({
      repoRoot,
      runWave: async (wave) => {
        if (wave.n === 1) writeFileSync(planFile, twoWavePlanText('- [ ] edited'), 'utf8');
        return { outcome: 'success' };
      },
    });
    assert.equal(code, 0, `legacy approval is fail-open for an unprovable edit; stderr:\n${stderr}`);
  });
});

// ---------------------------------------------------------------------------
// rad deliver --resume --context — eligibility table (AC#1, AC#4) and the
// run-resumed happy path. Stops are produced by the REAL spine (a prior run),
// so the deliver-stopped shape is the one production writes.
// ---------------------------------------------------------------------------

const RESUMER_EMAIL = 'operator@example.com';

/** sh that answers `git config user.email` with `email`, everything else ok. */
function emailSh(email = RESUMER_EMAIL) {
  return (file, argv) => (file === 'git' && argv[0] === 'config'
    ? { status: 0, stdout: `${email}\n`, stderr: '' }
    : okSh());
}

/** Prior run stopped by the failed-attempt cap → a needs-decision deliver-stopped. */
async function seedNeedsDecisionStop(repoRoot) {
  const seeded = seedApprovedTwoWavePlan(repoRoot);
  const first = await runDeliverCaptured({
    repoRoot,
    env: { RAD_MAX_FAILED_ATTEMPTS: '1' },
    runWave: async () => ({ outcome: 'fail-tests', summary: 'first failure' }),
  });
  assert.equal(first.code, 3, `prior run must stop needs-decision; stderr:\n${first.stderr}`);
  return seeded;
}

/** Prior run aborted (fail-scope) → a failed deliver-stopped. */
async function seedFailedStop(repoRoot) {
  const seeded = seedApprovedTwoWavePlan(repoRoot);
  const first = await runDeliverCaptured({ repoRoot, runWave: async () => ({ outcome: 'fail-scope' }) });
  assert.equal(first.code, 1, `prior run must stop failed; stderr:\n${first.stderr}`);
  return seeded;
}

const RESUME_REFUSALS = [
  { name: '--context without --resume', seed: seedApprovedTwoWavePlan, args: ['--context', 'go'], match: /--context requires --resume/ },
  { name: '--resume without --context', seed: seedNeedsDecisionStop, args: ['--resume'], match: /--resume requires --context "<text>"/ },
  { name: '--context with no value', seed: seedNeedsDecisionStop, args: ['--resume', '--context'], match: /--context requires a value/ },
  { name: 'whitespace-only context', seed: seedNeedsDecisionStop, args: ['--resume', '--context', '  \n\t '], match: /--context must not be empty/ },
  { name: 'context over 8000 chars', seed: seedNeedsDecisionStop, args: ['--resume', '--context', 'x'.repeat(8001)], match: /--context exceeds 8000 characters \(8001\)/ },
  { name: 'no deliver-stopped event', seed: seedApprovedTwoWavePlan, args: ['--resume', '--context', 'go'], match: /nothing to resume: stop-feature has no deliver-stopped event/ },
  { name: 'failed stop', seed: seedFailedStop, args: ['--resume', '--context', 'go'], match: /cannot resume a failed stop \(fail-scope\): wave 1: fail-scope/ },
  { name: 'empty git user.email', seed: seedNeedsDecisionStop, args: ['--resume', '--context', 'go'], sh: okSh, match: /cannot resolve git user.email for run-resumed.recordedBy/ },
];

for (const c of RESUME_REFUSALS) {
  test(`deliver --resume AC#4 — ${c.name} → exit 2, reason on stderr, log unchanged`, async () => {
    await withTempRepo(async (repoRoot) => {
      const { logFile } = await c.seed(repoRoot);
      const before = readFileSync(logFile, 'utf8');
      let calls = 0;
      const { code, stderr } = await runDeliverCaptured({
        repoRoot,
        args: c.args,
        sh: c.sh ?? emailSh(),
        runWave: async () => { calls += 1; return { outcome: 'success' }; },
      });
      assert.equal(code, 2, `expected exit 2; stderr:\n${stderr}`);
      assert.match(stderr, c.match);
      assert.equal(readFileSync(logFile, 'utf8'), before, 'no event may be appended');
      assert.equal(calls, 0, 'runWave must never run');
    });
  });
}

test('deliver --resume AC#4 — an 8000-char context is accepted (boundary is inclusive)', async () => {
  await withTempRepo(async (repoRoot) => {
    const { logFile } = await seedNeedsDecisionStop(repoRoot);
    const context = 'y'.repeat(8000);
    const { code, stderr } = await runDeliverCaptured({
      repoRoot,
      args: ['--resume', '--context', context],
      sh: emailSh(),
      runWave: async () => ({ outcome: 'success' }),
    });
    assert.equal(code, 0, `expected exit 0; stderr:\n${stderr}`);
    const resumed = readLog(logFile).find((e) => e.type === 'run-resumed');
    assert.equal(resumed.data.context.length, 8000, 'context is never truncated');
  });
});

test('deliver --resume AC#1 — needs-decision stop + context → run-resumed recorded, operatorContext on first runWave', async () => {
  await withTempRepo(async (repoRoot) => {
    const { logFile } = await seedNeedsDecisionStop(repoRoot);
    const context = 'Raise the budget; the flaky test is quarantined.\n  keep "quotes" verbatim';
    const calls = [];
    const { code, stderr } = await runDeliverCaptured({
      repoRoot,
      args: ['--resume', '--context', context],
      sh: emailSh(),
      runWave: async (wave, attemptCtx) => { calls.push(attemptCtx); return { outcome: 'success' }; },
    });
    assert.equal(code, 0, `expected exit 0; stderr:\n${stderr}`);
    const log = readLog(logFile);
    const lastStart = log.map((e) => e.type).lastIndexOf('deliver-started');
    const resumed = log[lastStart + 1];
    assert.equal(resumed.type, 'run-resumed', 'run-resumed immediately follows deliver-started');
    assert.equal(resumed.data.context, context, 'context recorded verbatim');
    assert.equal(resumed.data.recordedBy, RESUMER_EMAIL);
    assert.equal(resumed.data.stop.class, 'needs-decision');
    assert.equal(resumed.data.stop.reason, 'failed-attempt-cap');
    assert.ok(calls.length >= 1, 'runWave ran');
    assert.equal(calls[0].operatorContext.context, context, 'first runWave call carries operatorContext');
    assert.equal(calls[0].operatorContext.stop.reason, 'failed-attempt-cap');
    for (const later of calls.slice(1)) assert.equal(later.operatorContext, undefined);
  });
});

test('deliver AC#7 — without --resume no run-resumed is appended and runWave gets no operatorContext', async () => {
  await withTempRepo(async (repoRoot) => {
    const { logFile } = await seedNeedsDecisionStop(repoRoot);
    const calls = [];
    const { code, stderr } = await runDeliverCaptured({
      repoRoot,
      runWave: async (wave, attemptCtx) => { calls.push(attemptCtx); return { outcome: 'success' }; },
    });
    assert.equal(code, 0, `expected exit 0; stderr:\n${stderr}`);
    assert.ok(!readLog(logFile).some((e) => e.type === 'run-resumed'));
    assert.ok(calls.every((c) => !('operatorContext' in c)));
  });
});

/**
 * sh for worktree mode: `git show <branch>:<log>` returns `tipLog` (JSONL), git
 * config returns the email; records every call so the test can prove the read
 * source and that no worktree was created.
 */
function branchTipSh(tipLog, seen) {
  return (file, argv, opts) => {
    seen.push([file, ...argv]);
    if (file === 'git' && argv[0] === 'show') return { status: 0, stdout: tipLog, stderr: '' };
    return emailSh()(file, argv, opts);
  };
}

test('deliver --resume AC#4 — worktree mode reads eligibility from the BRANCH-TIP log, not the main checkout', async () => {
  await withTempRepo(async (repoRoot) => {
    // Main checkout holds a resumable needs-decision stop; the branch tip does not.
    const { logFile } = await seedNeedsDecisionStop(repoRoot);
    const tipLog = JSON.stringify({ ...approvedEvent(DELIVER_FEATURE) }) + '\n';
    const seen = [];
    const before = readFileSync(logFile, 'utf8');
    const { code, stderr } = await runDeliverCaptured({
      repoRoot,
      env: { RAD_WORKTREE: '1' },
      args: ['--resume', '--context', 'go'],
      sh: branchTipSh(tipLog, seen),
      runWave: async () => ({ outcome: 'success' }),
    });
    assert.equal(code, 2, `expected exit 2; stderr:\n${stderr}`);
    assert.match(stderr, /nothing to resume: stop-feature has no deliver-stopped event/);
    assert.ok(
      seen.some((c) => c[1] === 'show' && c[2] === `rad/${DELIVER_FEATURE}:.agents/state/${DELIVER_FEATURE}/events.jsonl`),
      'eligibility reads the work-branch tip via git show',
    );
    assert.ok(!seen.some((c) => String(c[0]).includes('worktree') || c.includes('worktree')), 'no worktree created');
    assert.equal(readFileSync(logFile, 'utf8'), before);
  });
});

test('deliver --resume AC#4 — worktree mode: a failed stop on the branch tip is refused even when main has none', async () => {
  await withTempRepo(async (repoRoot) => {
    seedApprovedTwoWavePlan(repoRoot);
    const stopped = {
      feature: DELIVER_FEATURE, type: 'deliver-stopped', actor: 'harness', ts: '2026-09-29T00:00:00.000Z',
      data: { class: 'failed', reason: 'abort-scope', decision: 'fix the scope', wave: 1 },
    };
    const tipLog = [approvedEvent(DELIVER_FEATURE), stopped].map((e) => JSON.stringify(e)).join('\n') + '\n';
    const { code, stderr } = await runDeliverCaptured({
      repoRoot,
      env: { RAD_WORKTREE: '1' },
      args: ['--resume', '--context', 'go'],
      sh: branchTipSh(tipLog, []),
      runWave: async () => ({ outcome: 'success' }),
    });
    assert.equal(code, 2, `expected exit 2; stderr:\n${stderr}`);
    assert.match(stderr, /cannot resume a failed stop \(abort-scope\): fix the scope/);
  });
});

// ---------------------------------------------------------------------------
// rad stop-status (AC#9) — read-only dormant-stop report.
// ---------------------------------------------------------------------------

/** Invoke `node cli.js stop-status ...` as a subprocess. Returns { status, stdout, stderr }. */
function runStopStatusProc(argv, opts = {}) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, 'stop-status', ...argv], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      ...opts,
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return { status: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

const needsDecisionStopEvent = {
  feature: 'f', type: 'deliver-stopped', actor: 'harness', ts: '2026-09-29T00:00:01.000Z',
  data: { class: 'needs-decision', reason: 'token-budget', decision: 'raise RAD_TOKEN_BUDGET', wave: 2 },
};
const jsonl = (events) => events.map((e) => JSON.stringify(e)).join('\n') + '\n';

test('stop-status AC#9 — dormant needs-decision stop in the feature log → the dormant line, exit 0', async () => {
  await withTempRepo(async (repoRoot) => {
    await seedNeedsDecisionStop(repoRoot);
    const { value: code, stdout } = await captureStdout(() => stopStatusCommand([DELIVER_FEATURE], { repoRoot }));
    assert.equal(code, 0);
    assert.match(stdout, /^dormant class=needs-decision reason=failed-attempt-cap wave=1 decision="[^"]*"\n$/);
  });
});

test('stop-status AC#9 — --stdin dormant stop → exact line', () => {
  const { status, stdout } = runStopStatusProc(['f', '--stdin'], { input: jsonl([needsDecisionStopEvent]) });
  assert.equal(status, 0);
  assert.equal(stdout, 'dormant class=needs-decision reason=token-budget wave=2 decision="raise RAD_TOKEN_BUDGET"\n');
});

test('stop-status AC#9 — a stop with no wave prints wave=unknown', () => {
  const noWave = { ...needsDecisionStopEvent, data: { ...needsDecisionStopEvent.data, wave: undefined } };
  const { status, stdout } = runStopStatusProc(['f', '--stdin'], { input: jsonl([noWave]) });
  assert.equal(status, 0);
  assert.match(stdout, / wave=unknown /);
});

test('stop-status AC#9 — no stop → none; a failed stop → none', () => {
  assert.equal(runStopStatusProc(['f', '--stdin'], { input: '' }).stdout, 'none\n');
  const failed = { ...needsDecisionStopEvent, data: { ...needsDecisionStopEvent.data, class: 'failed' } };
  assert.equal(runStopStatusProc(['f', '--stdin'], { input: jsonl([failed]) }).stdout, 'none\n');
});

test('stop-status AC#9 — needs-decision stop followed by deliver-started → none', () => {
  const started = { feature: 'f', type: 'deliver-started', actor: 'harness', ts: '2026-09-29T00:00:02.000Z' };
  const { status, stdout } = runStopStatusProc(['f', '--stdin'], { input: jsonl([needsDecisionStopEvent, started]) });
  assert.equal(status, 0);
  assert.equal(stdout, 'none\n');
});

test('stop-status AC#9 — malformed stdin → exit 1 with the message on stderr', () => {
  const { status, stdout, stderr } = runStopStatusProc(['f', '--stdin'], { input: '{"type":"deliver-stopped"\n' });
  assert.equal(status, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /rad stop-status: malformed event log: line 1/);
});

test('stop-status AC#9 — missing feature / unknown flag / extra positional → usage, exit 2', () => {
  for (const argv of [[], ['--bogus', 'f'], ['f', 'extra']]) {
    const { status, stderr } = runStopStatusProc(argv, { input: '' });
    assert.equal(status, 2, `argv ${JSON.stringify(argv)} should exit 2`);
    assert.match(stderr, /Usage: rad stop-status <feature> \[--stdin\]/);
  }
});
