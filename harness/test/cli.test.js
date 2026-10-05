import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync, chmodSync, symlinkSync } from 'node:fs';
import { basename, join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  approveCommand, gateCommand, parsePlanCtx, deliverCommand, stopStatusCommand, forecastCommand, digestCommand,
  resolveHooksDir, makeSpineScriptPort, SCRIPT_ARG_KEYS, reviewCommand, resolveAgent, isMainModule,
  capabilitiesCommand,
} from '../cli.js';
import { buildReviewPrompt, reviewInstruction } from '../review.js';
import { REVIEW_INSTRUCTION } from '../evals/reviewers/lib.js';
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
const DELIVER_ENV_KEYS = ['RAD_MAX_FAILED_ATTEMPTS', 'RAD_WORKTREE', 'RAD_TOKEN_BUDGET', 'RAD_SYNC', 'RAD_HOOKS_DIR'];

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
  // Worktree isolation is the default; these main-checkout tests opt out unless
  // a test sets RAD_WORKTREE itself.
  process.env.RAD_WORKTREE = '0';
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

// ---------------------------------------------------------------------------
// rad forecast — advisory plan-time reliability readout (AC#8)
// ---------------------------------------------------------------------------

/** Capture stdout AND stderr around an async command call. */
async function captureStdio(fn) {
  const origErr = process.stderr.write.bind(process.stderr);
  let stderr = '';
  process.stderr.write = (chunk) => {
    stderr += chunk;
    return true;
  };
  try {
    const { value, stdout } = await captureStdout(fn);
    return { code: value, stdout, stderr };
  } finally {
    process.stderr.write = origErr;
  }
}

/** sh stub standing in for plan_scope_paths: fixed stdout, records calls. */
function scopePathsSh(paths, { status = 0, stderr = '' } = {}) {
  const calls = [];
  const sh = (file, args, opts) => {
    calls.push({ file, args, opts });
    return { status, stdout: paths.map((p) => `${p}\n`).join(''), stderr };
  };
  return { sh, calls };
}

const FORECAST_PLAN = '.agents/plans/target.md';
const HISTORY_PLAN = [
  '# history', '', '#### Task 1.1: Touch A', 'File: src/a.js', '',
  '#### Task 1.2: Touch B', 'File: src/b.js:10-20', '',
].join('\n');

/** Two features whose wave-1 attempt failed tests on Touch A and Touch B (feature stamped from dir). */
function seedForecastRepo(repoRoot) {
  mkdirSync(join(repoRoot, '.agents', 'plans'), { recursive: true });
  writeFileSync(join(repoRoot, FORECAST_PLAN), '# target\n', 'utf8');
  writeFileSync(join(repoRoot, '.agents', 'plans', 'history.md'), HISTORY_PLAN, 'utf8');
  for (const feature of ['feat-one', 'feat-two']) {
    const attempt = { type: 'wave-attempt', data: { wave: 1, outcome: 'fail-tests',
      tasks: [{ title: 'Touch A', status: 'failed' }, { title: 'Touch B', status: 'failed' }] } };
    mkdirSync(join(repoRoot, '.agents', 'state', feature), { recursive: true });
    writeFileSync(join(repoRoot, '.agents', 'state', feature, 'events.jsonl'), jsonl([attempt]), 'utf8');
  }
}

test('forecast AC#8 — signals printed only for in-scope paths, then the advisory summary', async () => {
  await withTempRepo(async (repoRoot) => {
    seedForecastRepo(repoRoot);
    const { sh, calls } = scopePathsSh(['src/a.js', 'src/c.js']);
    const { code, stdout } = await captureStdio(() => forecastCommand([FORECAST_PLAN], { repoRoot, sh }));
    assert.equal(code, 0);
    assert.equal(stdout, [
      'forecast: src/a.js — insufficientTesting in 2 feature(s) (feat-one, feat-two); '
        + 'consider a characterization test for the uncovered behavior',
      'forecast: 1 of 2 path(s) have reliability signals (history: 2 feature(s)); '
        + 'advisory only — these are proxies, not verdicts',
      '',
    ].join('\n'));
    assert.doesNotMatch(stdout, /src\/b\.js/, 'out-of-scope path never printed');
    assert.equal(calls[0].file, 'bash');
    assert.match(calls[0].args[1], /plan_scope_paths "\$1"/);
    assert.equal(calls[0].args[3], join(repoRoot, FORECAST_PLAN));
    assert.equal(calls[0].opts.cwd, repoRoot);
  });
});

test('forecast AC#8 — no in-scope signals → the no-signals summary line', async () => {
  await withTempRepo(async (repoRoot) => {
    seedForecastRepo(repoRoot);
    const { sh } = scopePathsSh(['src/c.js', '', 'src/d.js']);
    const { code, stdout } = await captureStdio(() => forecastCommand([FORECAST_PLAN], { repoRoot, sh }));
    assert.equal(code, 0);
    assert.equal(stdout, 'forecast: no reliability signals for 2 path(s) (history: 2 feature(s))\n');
  });
});

test('forecast AC#8 — no state dir → history 0 summary, exit 0', async () => {
  await withTempRepo(async (repoRoot) => {
    writeFileSync(join(repoRoot, 'plan.md'), '# p\n', 'utf8');
    const { sh } = scopePathsSh(['src/a.js']);
    const { code, stdout } = await captureStdio(() => forecastCommand(['plan.md'], { repoRoot, sh }));
    assert.equal(code, 0);
    assert.equal(stdout, 'forecast: no reliability signals for 1 path(s) (history: 0 feature(s))\n');
  });
});

test('forecast AC#8 — missing plan → exit 2 naming the plan; sh never called', async () => {
  await withTempRepo(async (repoRoot) => {
    const { sh, calls } = scopePathsSh([]);
    const { code, stdout, stderr } = await captureStdio(() => forecastCommand(['missing.md'], { repoRoot, sh }));
    assert.equal(code, 2);
    assert.equal(stdout, '');
    assert.match(stderr, /^rad forecast: cannot read plan missing\.md: /);
    assert.equal(calls.length, 0);
  });
});

test('forecast AC#8 — plan_scope_paths failure → exit 2 with its stderr as the reason', async () => {
  await withTempRepo(async (repoRoot) => {
    writeFileSync(join(repoRoot, 'plan.md'), '# p\n', 'utf8');
    const { sh } = scopePathsSh([], { status: 1, stderr: 'no such plan section\n' });
    const { code, stdout, stderr } = await captureStdio(() => forecastCommand(['plan.md'], { repoRoot, sh }));
    assert.equal(code, 2);
    assert.equal(stdout, '');
    assert.equal(stderr, 'rad forecast: plan_scope_paths failed: no such plan section\n');
  });
});

test('forecast AC#8 — malformed event log → exit 1 naming the feature', async () => {
  await withTempRepo(async (repoRoot) => {
    seedForecastRepo(repoRoot);
    writeFileSync(join(repoRoot, '.agents', 'state', 'feat-two', 'events.jsonl'), '{"type":\n', 'utf8');
    const { sh } = scopePathsSh(['src/a.js']);
    const { code, stdout, stderr } = await captureStdio(() => forecastCommand([FORECAST_PLAN], { repoRoot, sh }));
    assert.equal(code, 1);
    assert.equal(stdout, '');
    assert.match(stderr, /^rad forecast: malformed event log for feat-two: /);
  });
});

test('forecast AC#8 — missing plan arg / unknown flag / extra positional → usage, exit 2', async () => {
  await withTempRepo(async (repoRoot) => {
    const { sh, calls } = scopePathsSh([]);
    for (const argv of [[], ['--bogus', 'p.md'], ['p.md', 'extra']]) {
      const { code, stderr } = await captureStdio(() => forecastCommand(argv, { repoRoot, sh }));
      assert.equal(code, 2, `argv ${JSON.stringify(argv)} should exit 2`);
      assert.match(stderr, /Usage: rad forecast <plan>\n$/);
    }
    assert.equal(calls.length, 0);
  });
});

// ── CLI script arguments + hook wiring (adversarial-gate-evals Task 1.1) ──

const DEFAULT_BRANCH_STUB = 'main';

/** A recording sh: answers get-default-branch.sh with `defaultBranch`, else ok. */
function recordingSh({ defaultBranchStatus = 0 } = {}) {
  const calls = [];
  const sh = (file, args = [], opts = {}) => {
    calls.push({ file, args, opts });
    if (file.endsWith('scripts/get-default-branch.sh')) {
      return { status: defaultBranchStatus, stdout: `${DEFAULT_BRANCH_STUB}\n`, stderr: '' };
    }
    return okSh();
  };
  const argsFor = (script) => calls.filter((c) => c.file.endsWith(script)).map((c) => c.args);
  return { sh, calls, argsFor };
}

/** Every `scripts/*.sh` string the spine source can hand its `sh` port. */
function spineScriptStrings() {
  const src = readFileSync(join(HERE, '..', 'spine.js'), 'utf8');
  const literals = [...src.matchAll(/'(scripts\/[\w-]+\.sh)'/g)].map((m) => m[1]);
  const postChecks = /const POST_CHECKS = \[([^\]]*)\]/.exec(src);
  assert.ok(postChecks, 'spine.js must declare POST_CHECKS');
  const post = [...postChecks[1].matchAll(/'([\w-]+\.sh)'/g)].map((m) => `scripts/${m[1]}`);
  return [...new Set([...literals, ...post])];
}

test('script args — every script string the spine passes has an argument contract', () => {
  const scripts = spineScriptStrings();
  assert.ok(scripts.includes('scripts/check-scope.sh'));
  assert.ok(scripts.includes('scripts/open-pr.sh'));
  for (const script of scripts) {
    assert.ok(SCRIPT_ARG_KEYS.includes(script), `no SCRIPT_ARGS entry for ${script}`);
  }
});

test('script args — an unknown script throws naming it, never runs', () => {
  const { sh, calls } = recordingSh();
  const port = makeSpineScriptPort({ sh, repoRoot: '/r', root: '/r', scriptCtx: {} });
  assert.throws(() => port('scripts/unknown.sh', 'f'), /^Error: rad deliver: no argument contract for scripts\/unknown\.sh$/);
  assert.throws(() => port('toString', 'f'), /no argument contract for toString/);
  assert.equal(calls.length, 0);
});

test('script args — a real deliver passes each script its argv contract', async () => {
  await withTempRepo(async (repoRoot) => {
    seedApprovedTwoWavePlan(repoRoot);
    const rec = recordingSh();
    const { code, stderr } = await runDeliverCaptured({
      repoRoot, sh: rec.sh, runWave: async () => ({ outcome: 'success' }),
    });
    assert.equal(code, 0, `expected exit 0; stderr:\n${stderr}`);
    const planPath = join(repoRoot, '.agents', 'plans', `${DELIVER_FEATURE}.md`);
    const branch = `rad/${DELIVER_FEATURE}`;
    const scope = rec.argsFor('scripts/check-scope.sh');
    assert.ok(scope.length > 0, 'check-scope.sh must run');
    for (const args of scope) assert.deepEqual(args, [planPath, branch, DEFAULT_BRANCH_STUB]);
    const presence = rec.argsFor('scripts/check-tests-present.sh');
    assert.ok(presence.length > 0, 'check-tests-present.sh must run');
    for (const args of presence) assert.deepEqual(args, [planPath]);
    assert.deepEqual(rec.argsFor('scripts/open-pr.sh'), [[
      '--title', `Deliver: ${DELIVER_FEATURE}`, '--body', 'RAD deliver: 2 wave(s) complete',
      '--head', branch, '--no-draft', '--label', 'rad:deliver',
    ]]);
    // The base branch is resolved once per run, from the run root's .rad/config.yml.
    assert.deepEqual(rec.argsFor('scripts/get-default-branch.sh'), [[repoRoot]]);
  });
});

test('script args — get-default-branch.sh failing → deliver fails closed (exit 1)', async () => {
  await withTempRepo(async (repoRoot) => {
    seedApprovedTwoWavePlan(repoRoot);
    const rec = recordingSh({ defaultBranchStatus: 1 });
    const { code, stderr } = await runDeliverCaptured({
      repoRoot, sh: rec.sh, runWave: async () => ({ outcome: 'success' }),
    });
    assert.equal(code, 1);
    assert.match(stderr, /cannot resolve default branch \(scripts\/get-default-branch\.sh exited 1\)/);
    assert.equal(rec.argsFor('scripts/check-scope.sh').length, 0);
  });
});

test('hooks dir — resolveHooksDir: default, relative, absolute, malformed', () => {
  const root = '/work/root';
  assert.deepEqual(resolveHooksDir({}, root), { ok: true, dir: join(root, 'scripts', 'hooks') });
  assert.deepEqual(resolveHooksDir({ RAD_HOOKS_DIR: '  ' }, root), { ok: true, dir: join(root, 'scripts', 'hooks') });
  assert.deepEqual(resolveHooksDir({ RAD_HOOKS_DIR: 'ops/hooks' }, root), { ok: true, dir: resolve(root, 'ops/hooks') });
  assert.deepEqual(resolveHooksDir({ RAD_HOOKS_DIR: '/etc/rad-hooks' }, root), { ok: true, dir: '/etc/rad-hooks' });
  for (const raw of ['-rf', '--hooks', 'a\nb', 'a\rb']) {
    assert.deepEqual(resolveHooksDir({ RAD_HOOKS_DIR: raw }, root), { ok: false, raw });
  }
});

test('hooks dir — malformed RAD_HOOKS_DIR → exit 2 before any event', async () => {
  for (const raw of ['-x', 'hooks\ndir']) {
    await withTempRepo(async (repoRoot) => {
      const { logFile } = seedApprovedTwoWavePlan(repoRoot);
      const before = readFileSync(logFile, 'utf8');
      const rec = recordingSh();
      const { code, stderr } = await runDeliverCaptured({
        repoRoot, sh: rec.sh, env: { RAD_HOOKS_DIR: raw }, runWave: async () => ({ outcome: 'success' }),
      });
      assert.equal(code, 2, `RAD_HOOKS_DIR=${JSON.stringify(raw)} should exit 2`);
      assert.match(stderr, /RAD_HOOKS_DIR must be a directory path/);
      assert.equal(readFileSync(logFile, 'utf8'), before);
    });
  }
});

test('hooks dir — RAD_HOOKS_DIR set → the runner discovers and fires hooks from it', async () => {
  await withTempRepo(async (repoRoot) => {
    seedApprovedTwoWavePlan(repoRoot);
    const hooksDir = join(repoRoot, 'ops-hooks');
    const hook = join(hooksDir, 'wave-complete', '10-observe.sh');
    mkdirSync(dirname(hook), { recursive: true });
    writeFileSync(hook, '#!/usr/bin/env bash\nexit 0\n', 'utf8');
    chmodSync(hook, 0o755);
    const rec = recordingSh();
    const { code, stderr } = await runDeliverCaptured({
      repoRoot, sh: rec.sh, env: { RAD_HOOKS_DIR: hooksDir }, runWave: async () => ({ outcome: 'success' }),
    });
    assert.equal(code, 0, `expected exit 0; stderr:\n${stderr}`);
    const fired = rec.calls.filter((c) => c.file === hook);
    assert.ok(fired.length > 0, 'the wave-complete hook must fire');
    assert.equal(fired[0].args[0], DELIVER_FEATURE);
    assert.equal(fired[0].args[2], 'wave-complete');
    assert.equal(fired[0].opts.cwd, repoRoot);
    assert.equal(fired[0].opts.env.RAD_HOOK_POINT, 'wave-complete');
    assert.equal(fired[0].opts.env.PATH, process.env.PATH);
  });
});

test('hooks dir — no hooks dir → event sequence identical to an empty hooks dir run', async () => {
  const typesOf = async (env) => withTempRepo(async (repoRoot) => {
    const { logFile } = seedApprovedTwoWavePlan(repoRoot);
    if (env.RAD_HOOKS_DIR === '') {
      env = { RAD_HOOKS_DIR: join(repoRoot, 'empty-hooks') };
      mkdirSync(env.RAD_HOOKS_DIR);
    }
    const { code } = await runDeliverCaptured({
      repoRoot, sh: recordingSh().sh, env, runWave: async () => ({ outcome: 'success' }),
    });
    assert.equal(code, 0);
    return readLog(logFile).map(({ type, data }) => JSON.stringify({ type, data }));
  });
  const noDir = await typesOf({});
  assert.ok(!noDir.some((e) => /"type":"hook-/.test(e)), 'no hook events without hooks');
  assert.deepEqual(await typesOf({ RAD_HOOKS_DIR: '' }), noDir);
});

test('deliver #161 — an approval-changed stop prints its free-text reason as detail= on the stop line', async () => {
  await withTempRepo(async (repoRoot) => {
    const { planFile } = seedApprovedTwoWavePlan(repoRoot);
    const { code, stderr } = await runDeliverCaptured({
      repoRoot,
      runWave: async (wave) => {
        if (wave.n === 1) writeFileSync(planFile, twoWavePlanText('- [ ] Task C (sneaked in)'), 'utf8');
        return { outcome: 'success' };
      },
    });
    assert.equal(code, 3, `expected exit 3; stderr:\n${stderr}`);
    const line = stderr.split('\n').find((l) => l.startsWith('rad deliver: failed'));
    assert.ok(line, `no stop line; stderr:\n${stderr}`);
    assert.match(line, /stopped=approval-changed/);
    assert.match(line, / class=needs-decision decision="[^"]*" detail="(?:[^"\\]|\\.)+"$/);
  });
});

test('deliver #161 — a stop without a free-text reason prints no detail=', async () => {
  await withTempRepo(async (repoRoot) => {
    seedApprovedTwoWavePlan(repoRoot);
    let n = 0;
    const { code, stderr } = await runDeliverCaptured({
      repoRoot,
      env: { RAD_MAX_FAILED_ATTEMPTS: '1' },
      runWave: async () => ({ outcome: 'fail-tests', summary: `failure ${(n += 1)}` }),
    });
    assert.equal(code, 3, `expected exit 3; stderr:\n${stderr}`);
    assert.match(stderr, /stopped=failed-attempt-cap/);
    assert.doesNotMatch(stderr, /detail=/);
  });
});

// ---------------------------------------------------------------------------
// rad digest — ranked, read-only review digest (AC#4)
// ---------------------------------------------------------------------------

const DIGEST_FEATURE = 'dig-feat';
const DIGEST_PLAN = [
  '# dig-feat', '', 'Branch: rad/dig-feat', '', '## Files in Scope', '- src/a.js', '',
  '### Wave 1', '', '#### Task 1.1: Touch A', 'File: src/a.js', '',
].join('\n');

/** Plan + optional state log for DIGEST_FEATURE under a temp repo. */
function seedDigestRepo(repoRoot, { log } = {}) {
  mkdirSync(join(repoRoot, '.agents', 'plans'), { recursive: true });
  writeFileSync(join(repoRoot, '.agents', 'plans', `${DIGEST_FEATURE}.md`), DIGEST_PLAN, 'utf8');
  if (log === undefined) return;
  mkdirSync(join(repoRoot, '.agents', 'state', DIGEST_FEATURE), { recursive: true });
  writeFileSync(join(repoRoot, '.agents', 'state', DIGEST_FEATURE, 'events.jsonl'), log, 'utf8');
}

/** sh stub: plan_scope_paths → src/a.js, check-scope → pass, other plan-paths helpers → empty. */
function digestSh() {
  const calls = [];
  const sh = (file, args, opts) => {
    calls.push({ file, args, opts });
    const script = args.join(' ');
    if (script.includes('plan_scope_paths')) return { status: 0, stdout: 'src/a.js\n', stderr: '' };
    if (script.includes('check-scope.sh')) return { status: 0, stdout: '✓ scope passed\n', stderr: '' };
    if (file.endsWith('get-default-branch.sh')) return { status: 0, stdout: 'main\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  return { sh, calls };
}

for (const [label, argv] of [
  ['no feature', []],
  ['--branch without a value', [DIGEST_FEATURE, '--branch']],
  ['--base followed by a flag', [DIGEST_FEATURE, '--base', '--branch', 'x']],
  ['unknown flag', [DIGEST_FEATURE, '--nope']],
  ['extra positional', [DIGEST_FEATURE, 'extra']],
  ['traversal feature name', ['../etc']],
]) {
  test(`digest AC#4 — usage error (${label}) → exit 2 with usage; sh never called`, async () => {
    await withTempRepo(async (repoRoot) => {
      const { sh, calls } = digestSh();
      const { code, stdout, stderr } = await captureStdio(() => digestCommand(argv, { repoRoot, sh }));
      assert.equal(code, 2);
      assert.equal(stdout, '');
      assert.match(stderr, /^rad digest: .*\nUsage: rad digest <feature> \[--branch <ref>\] \[--base <ref>\]\n$/);
      assert.equal(calls.length, 0);
    });
  });
}

test('digest AC#4 — unreadable plan → exit 2 naming the plan', async () => {
  await withTempRepo(async (repoRoot) => {
    const { sh, calls } = digestSh();
    const { code, stdout, stderr } = await captureStdio(() => digestCommand([DIGEST_FEATURE], { repoRoot, sh }));
    assert.equal(code, 2);
    assert.equal(stdout, '');
    assert.match(stderr, /^rad digest: cannot read plan \.agents\/plans\/dig-feat\.md: /);
    assert.equal(calls.length, 0);
  });
});

test('digest AC#4 — malformed event log → exit 1 naming the feature', async () => {
  await withTempRepo(async (repoRoot) => {
    seedDigestRepo(repoRoot, { log: '{"type":\n' });
    const { sh } = digestSh();
    const { code, stdout, stderr } = await captureStdio(() => digestCommand([DIGEST_FEATURE], { repoRoot, sh }));
    assert.equal(code, 1);
    assert.equal(stdout, '');
    assert.match(stderr, /^rad digest: malformed event log for dig-feat: /);
  });
});

test('digest AC#4 — default-branch script failure → exit 1 (fail-closed, no silent main)', async () => {
  await withTempRepo(async (repoRoot) => {
    seedDigestRepo(repoRoot);
    const sh = (file) => (file.endsWith('get-default-branch.sh')
      ? { status: 7, stdout: '', stderr: 'boom' } : { status: 0, stdout: '', stderr: '' });
    const { code, stdout, stderr } = await captureStdio(() => digestCommand([DIGEST_FEATURE], { repoRoot, sh }));
    assert.equal(code, 1);
    assert.equal(stdout, '');
    assert.match(stderr, /^rad digest: cannot resolve default branch/);
  });
});

test('digest AC#4 — happy path prints the ranked digest; branch from the plan header, base from the script', async () => {
  await withTempRepo(async (repoRoot) => {
    seedDigestRepo(repoRoot, { log: jsonl([{ type: 'deliver-started', feature: DIGEST_FEATURE }]) });
    const { sh, calls } = digestSh();
    const { code, stdout, stderr } = await captureStdio(() => digestCommand([DIGEST_FEATURE], { repoRoot, sh }));
    assert.equal(code, 0, `stderr:\n${stderr}`);
    assert.match(stdout, /^## Review digest — dig-feat\n/);
    assert.match(stdout, /\n### Look here\n/);
    assert.match(stdout, /\n### Evidence\n/);
    const scope = calls.find((c) => c.args.join(' ').includes('check-scope.sh'));
    assert.deepEqual(scope.args.slice(-2), ['rad/dig-feat', 'main']);
  });
});

test('digest AC#4 — explicit --branch/--base override defaults; default-branch script not run', async () => {
  await withTempRepo(async (repoRoot) => {
    seedDigestRepo(repoRoot);
    const { sh, calls } = digestSh();
    const { code } = await captureStdio(() => digestCommand(
      [DIGEST_FEATURE, '--branch', 'topic', '--base', 'trunk'], { repoRoot, sh }));
    assert.equal(code, 0);
    assert.equal(calls.some((c) => c.file.endsWith('get-default-branch.sh')), false);
    const scope = calls.find((c) => c.args.join(' ').includes('check-scope.sh'));
    assert.deepEqual(scope.args.slice(-2), ['topic', 'trunk']);
  });
});

// ---------------------------------------------------------------------------
// harness/review.js — shared reviewer prompt (moved from review.test.js)
// ---------------------------------------------------------------------------

const LEGACY_INSTRUCTION = [
  '---', '', '## Task', '',
  'Review the changes on the current branch versus main (`git diff main...HEAD`).',
  'Follow your process above. End your response with the ````rad-findings block',
  'exactly as specified, containing every finding you report.',
].join('\n');

test('reviewInstruction default and eval REVIEW_INSTRUCTION are byte-identical to the legacy text', () => {
  assert.equal(reviewInstruction(), LEGACY_INSTRUCTION);
  assert.equal(REVIEW_INSTRUCTION, LEGACY_INSTRUCTION);
});

test('reviewInstruction interpolates a valid base ref', () => {
  const text = reviewInstruction('origin/release-1.2_x');
  assert.match(text, /versus origin\/release-1\.2_x \(`git diff origin\/release-1\.2_x\.\.\.HEAD`\)/);
});

test('reviewInstruction falls back to main for invalid bases (never throws)', () => {
  for (const bad of ['', '-rf', '--output=x', 'main; rm -rf /', 'a b', '$(x)', null, 42, {}]) {
    assert.equal(reviewInstruction(bad), LEGACY_INSTRUCTION, `base=${String(bad)}`);
  }
});

test('buildReviewPrompt threads base and defaults to main', () => {
  const md = '---\nname: x\n---\nBody\n';
  assert.equal(buildReviewPrompt(md), `Body\n\n${LEGACY_INSTRUCTION}\n`);
  assert.match(buildReviewPrompt(md, { base: 'develop' }), /git diff develop\.\.\.HEAD/);
  assert.equal(buildReviewPrompt(md, undefined), buildReviewPrompt(md));
});

// ---------------------------------------------------------------------------
// rad review — the cross-vendor review lane (AC#3, AC#4, AC#5, AC#7, AC#9)
// ---------------------------------------------------------------------------

const REVIEWER = 'fake-reviewer';
const REVIEWER_BODY = 'You are the fake reviewer. Check everything.';
const FINDINGS_OUT = 'analysis...\n````rad-findings\n{"findings":[{"id":"a"},{"id":"b"}]}\n````\n';

/** Seed `.claude/agents/<REVIEWER>.md` (with frontmatter) under repoRoot. */
function seedReviewer(repoRoot) {
  const dir = join(repoRoot, '.claude', 'agents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${REVIEWER}.md`), `---\nname: ${REVIEWER}\nmodel: x\n---\n${REVIEWER_BODY}\n`);
}

/**
 * A node fake agent: dumps its stdin + env as JSON to `<dir>/<name>.dump.json`,
 * then prints `out`. Returns the `node <path>` cmd string.
 */
function fakeReviewCmd(dir, name, out) {
  const file = join(dir, `${name}.js`);
  const dump = join(dir, `${name}.dump.json`);
  writeFileSync(file, [
    "const fs = require('node:fs');",
    "let stdin = ''; process.stdin.on('data', (c) => { stdin += c; });",
    'process.stdin.on(\'end\', () => {',
    `  fs.writeFileSync(${JSON.stringify(dump)}, JSON.stringify({ stdin, env: process.env }));`,
    `  process.stdout.write(${JSON.stringify(out)});`,
    '});',
  ].join('\n'));
  return { cmd: `${process.execPath} ${file}`, dump: () => JSON.parse(readFileSync(dump, 'utf8')) };
}

/** Temp repo with the fake reviewer seeded. */
async function withReviewRepo(fn) {
  return withTempRepo(async (repoRoot) => {
    seedReviewer(repoRoot);
    return fn(repoRoot);
  });
}

/**
 * Run reviewCommand capturing string writes to stdout/stderr. Non-string chunks
 * pass through: while a real fake agent is spawned the test runner keeps
 * streaming its (binary) reporter protocol on stdout, which must not be eaten.
 */
async function runReview(argv, ctx) {
  const captured = { stdout: '', stderr: '' };
  const originals = { stdout: process.stdout.write, stderr: process.stderr.write };
  for (const name of ['stdout', 'stderr']) {
    process[name].write = function write(chunk, ...rest) {
      if (typeof chunk !== 'string') return originals[name].call(this, chunk, ...rest);
      captured[name] += chunk;
      return true;
    };
  }
  try {
    const code = await reviewCommand(argv, ctx);
    return { code, ...captured };
  } finally {
    process.stdout.write = originals.stdout;
    process.stderr.write = originals.stderr;
  }
}

/** Temporarily set process.env keys (undefined deletes), restoring afterwards. */
async function withProcessEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const apply = (v) => Object.entries(v).forEach(([k, val]) => {
    if (val === undefined) delete process.env[k]; else process.env[k] = val;
  });
  apply(vars);
  try {
    return await fn();
  } finally {
    apply(saved);
  }
}

test('review — usage errors exit 2 with the usage line', async () => {
  await withReviewRepo(async (repoRoot) => {
    const env = { RAD_AGENT_CMD: 'never-run' };
    const bad = [[], ['Bad_Name'], ['../x'], [REVIEWER, 'extra'], [REVIEWER, '--nope'],
      [REVIEWER, '--base'], [REVIEWER, '--base', '-rf'], [REVIEWER, '--base', 'a;b'], [REVIEWER, '--base', '']];
    for (const argv of bad) {
      const { code, stdout, stderr } = await runReview(argv, { repoRoot, env });
      assert.equal(code, 2, `argv=${JSON.stringify(argv)}`);
      assert.equal(stdout, '');
      assert.match(stderr, /Usage: rad review <reviewer> \[--base <ref>\]/);
    }
  });
});

test('review — unreadable agent file exits 2 naming it', async () => {
  await withReviewRepo(async (repoRoot) => {
    const { code, stderr } = await runReview(['missing-one'], { repoRoot, env: { RAD_AGENT_CMD: 'x' } });
    assert.equal(code, 2);
    assert.match(stderr, /cannot read reviewer agent \.claude\/agents\/missing-one\.md/);
  });
});

test('review — neither command var set (or blank) exits 2 naming both', async () => {
  await withReviewRepo(async (repoRoot) => {
    for (const env of [{}, { RAD_REVIEW_AGENT_CMD: '', RAD_AGENT_CMD: '   ' }]) {
      const { code, stderr } = await runReview([REVIEWER, '--base', 'main'], { repoRoot, env });
      assert.equal(code, 2);
      assert.match(stderr, /no review agent configured — set RAD_REVIEW_AGENT_CMD or RAD_AGENT_CMD/);
    }
  });
});

test('review — malformed RAD_REVIEW_TIMEOUT_SECONDS exits 2 (never silently defaults)', async () => {
  await withReviewRepo(async (repoRoot) => {
    for (const bad of ['0', '-3', '1.5', 'abc', ' 5', '10s']) {
      const env = { RAD_AGENT_CMD: 'x', RAD_REVIEW_TIMEOUT_SECONDS: bad };
      const { code, stderr } = await runReview([REVIEWER, '--base', 'main'], { repoRoot, env });
      assert.equal(code, 2, `timeout=${bad}`);
      assert.match(stderr, /RAD_REVIEW_TIMEOUT_SECONDS must be a positive integer/);
    }
  });
});

test('review — stdout verbatim; timeout seconds become ms (default 600s); label names the reviewer', async () => {
  await withReviewRepo(async (repoRoot) => {
    const calls = [];
    const fake = async (opts) => { calls.push(opts); return { ok: true, stdout: FINDINGS_OUT }; };
    const argv = [REVIEWER, '--base', 'main'];
    const first = await runReview(argv, { repoRoot, env: { RAD_AGENT_CMD: 'x' }, runCommandPrompt: fake });
    assert.equal(first.code, 0);
    assert.equal(first.stdout, FINDINGS_OUT, 'agent stdout is printed verbatim');
    await runReview(argv, { repoRoot, env: { RAD_AGENT_CMD: 'x', RAD_REVIEW_TIMEOUT_SECONDS: '7' }, runCommandPrompt: fake });
    assert.equal(calls[0].timeoutMs, 600_000);
    assert.equal(calls[1].timeoutMs, 7000);
    assert.equal(calls[0].label, `rad review ${REVIEWER}`);
    assert.equal(calls[0].repoRoot, repoRoot);
  });
});

test('review — findings block → exit 0, stdout verbatim, findings=<n>; RAD_REVIEW_AGENT_CMD wins', async () => {
  await withReviewRepo(async (repoRoot) => {
    const winner = fakeReviewCmd(repoRoot, 'winner', FINDINGS_OUT);
    const loser = fakeReviewCmd(repoRoot, 'loser', 'nope');
    const env = { RAD_REVIEW_AGENT_CMD: winner.cmd, RAD_AGENT_CMD: loser.cmd };
    const { code, stdout, stderr } = await runReview([REVIEWER, '--base', 'main'], { repoRoot, env });
    assert.equal(code, 0, stderr);
    assert.equal(stdout, FINDINGS_OUT);
    assert.equal(stderr,
      `rad review: reviewer=${REVIEWER} agent=RAD_REVIEW_AGENT_CMD executable=${basename(process.execPath)} findings=2\n`);
    assert.equal(existsSync(join(repoRoot, 'loser.dump.json')), false);
    assert.equal(stderr.includes(winner.cmd), false, 'full command string is never printed');
  });
});

test('review — falls back to RAD_AGENT_CMD; no findings block → exit 1, stdout still printed', async () => {
  await withReviewRepo(async (repoRoot) => {
    const fake = fakeReviewCmd(repoRoot, 'plain', 'looks fine to me\n');
    const { code, stdout, stderr } = await runReview([REVIEWER, '--base', 'main'],
      { repoRoot, env: { RAD_REVIEW_AGENT_CMD: '', RAD_AGENT_CMD: fake.cmd } });
    assert.equal(code, 1);
    assert.equal(stdout, 'looks fine to me\n');
    assert.match(stderr, /agent=RAD_AGENT_CMD executable=\S+ findings=none\n$/);
  });
});

test('review — failed run reports a sanitized error and exits 1 even with findings', async () => {
  await withReviewRepo(async (repoRoot) => {
    const fake = async () => ({ ok: false, stdout: FINDINGS_OUT, error: 'exit 3: "bad"\nsk-ant-abcdefghijklmnop' });
    const { code, stdout, stderr } = await runReview([REVIEWER, '--base', 'main'],
      { repoRoot, env: { RAD_AGENT_CMD: '/opt/bin/codex exec --secret-flag' }, runCommandPrompt: fake });
    assert.equal(code, 1);
    assert.equal(stdout, FINDINGS_OUT);
    assert.match(stderr, /executable=codex findings=2 error="exit 3: 'bad' \[REDACTED\]"\n$/);
    assert.equal(stderr.includes('--secret-flag'), false);
  });
});

test('review — stdin carries the agent body (frontmatter stripped) and the --base diff', async () => {
  await withReviewRepo(async (repoRoot) => {
    const fake = fakeReviewCmd(repoRoot, 'stdin', FINDINGS_OUT);
    const { code } = await runReview([REVIEWER, '--base', 'origin/dev'], { repoRoot, env: { RAD_AGENT_CMD: fake.cmd } });
    assert.equal(code, 0);
    const { stdin } = fake.dump();
    assert.ok(stdin.startsWith(REVIEWER_BODY), stdin);
    assert.equal(stdin.includes('model: x'), false);
    assert.match(stdin, /`git diff origin\/dev\.\.\.HEAD`/);
  });
});

test('review — base defaults to the default-branch script, else main; script failure → exit 1', async () => {
  await withReviewRepo(async (repoRoot) => {
    const calls = [];
    const fake = async (opts) => { calls.push(opts); return { ok: true, stdout: FINDINGS_OUT }; };
    const ctxFor = (stdout, status = 0) => ({
      repoRoot, env: { RAD_AGENT_CMD: 'x' }, runCommandPrompt: fake, sh: () => ({ status, stdout, stderr: '' }),
    });
    assert.equal((await runReview([REVIEWER], ctxFor('trunk\n'))).code, 0);
    assert.match(calls[0].prompt, /git diff trunk\.\.\.HEAD/);
    assert.equal((await runReview([REVIEWER], ctxFor(''))).code, 0);
    assert.match(calls[1].prompt, /git diff main\.\.\.HEAD/);
    const failed = await runReview([REVIEWER], ctxFor('', 7));
    assert.equal(failed.code, 1);
    assert.match(failed.stderr, /^rad review: cannot resolve default branch/);
    assert.equal(calls.length, 2, 'no agent run after a base-resolution failure');
  });
});

test('review AC#5 — an exported secret never reaches the review agent env', async () => {
  await withReviewRepo(async (repoRoot) => {
    const fake = fakeReviewCmd(repoRoot, 'envdump', FINDINGS_OUT);
    await withProcessEnv({ RAD_REVIEW_SECRET_PROBE: 'shh-123', ANTHROPIC_API_KEY: 'sk-ant-probe', RAD_AGENT_CMD: undefined,
      RAD_REVIEW_AGENT_CMD: fake.cmd }, async () => {
      const { code } = await runReview([REVIEWER, '--base', 'main'], { repoRoot });
      assert.equal(code, 0);
    });
    const { env } = fake.dump();
    assert.equal(env.RAD_REVIEW_SECRET_PROBE, undefined);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.RAD_REVIEW_AGENT_CMD, undefined);
  });
});

test('review AC#7 — two lanes: rad review runs B while deliver resolution still yields A', async () => {
  await withReviewRepo(async (repoRoot) => {
    const a = fakeReviewCmd(repoRoot, 'laneA', 'A ran\n');
    const b = fakeReviewCmd(repoRoot, 'laneB', FINDINGS_OUT);
    await withProcessEnv({ RAD_AGENT_CMD: a.cmd, RAD_REVIEW_AGENT_CMD: b.cmd }, async () => {
      const { code, stdout } = await runReview([REVIEWER, '--base', 'main'], { repoRoot });
      assert.equal(code, 0);
      assert.equal(stdout, FINDINGS_OUT);
      assert.deepEqual(resolveAgent({}, 'command'), { kind: 'command', cmd: a.cmd });
    });
    assert.equal(existsSync(join(repoRoot, 'laneA.dump.json')), false);
    assert.equal(existsSync(join(repoRoot, 'laneB.dump.json')), true);
  });
});

// ---------------------------------------------------------------------------
// #168 — main-module guard through a symlinked path
//
// import.meta.url is the real path; argv[1] is the path as invoked. A raw
// compare made every verb a silent exit 0 through a symlink, so the approval
// gate read as passed. The guard compares realpaths.
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(HERE, '..', '..');

/** Run `node <symlink-to-repo>/harness/cli.js ...argv`; returns { status, stdout, stderr }. */
function withSymlinkedCli(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rad-cli-symlink-'));
  const link = join(dir, 'link');
  symlinkSync(REPO_ROOT, link, 'dir');
  const run = (argv) => {
    try {
      const stdout = execFileSync(process.execPath, [join(link, 'harness', 'cli.js'), ...argv], {
        encoding: 'utf8', cwd: link, stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { status: 0, stdout, stderr: '' };
    } catch (err) {
      return { status: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
    }
  };
  try {
    return fn(run);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('#168 AC#4 — symlinked gate on an unknown feature exits 1 with passed=false', () => {
  withSymlinkedCli((run) => {
    const { status, stdout } = run(['gate', 'no-such-feature-168', 'approved']);
    assert.equal(status, 1, `symlinked gate must fail closed; got ${status}, stdout:\n${stdout}`);
    assert.ok(stdout.includes('passed=false'), `stdout should report passed=false; got:\n${stdout}`);
  });
});

test('#168 AC#4 — symlinked config validate runs and prints a verdict', () => {
  const real = run168Real(['config', 'validate']);
  withSymlinkedCli((run) => {
    const { status, stdout, stderr } = run(['config', 'validate']);
    assert.ok((stdout + stderr).trim().length > 0, 'symlinked config validate must print output, not exit silently');
    assert.equal(status, real.status, 'symlinked exit code matches the real-path exit code');
  });
});

/** Run the CLI through its real path from the repo root, for comparison. */
function run168Real(argv) {
  try {
    execFileSync(process.execPath, [CLI, ...argv], { encoding: 'utf8', cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 0 };
  } catch (err) {
    return { status: err.status ?? 1 };
  }
}

test('#168 — isMainModule: argv[1] undefined never runs main', () => {
  assert.equal(isMainModule(undefined, CLI), false);
  assert.equal(isMainModule('', CLI), false);
});

test('#168 — isMainModule: a symlinked invocation path matches the real module path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rad-ismain-'));
  try {
    const link = join(dir, 'cli-link.js');
    symlinkSync(CLI, link);
    assert.equal(isMainModule(link, CLI), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#168 — isMainModule: nonexistent argv[1] falls back to the raw string compare', () => {
  const ghost = join(tmpdir(), 'rad-no-such-dir-168', 'cli.js');
  assert.equal(isMainModule(ghost, ghost), true, 'identical raw strings still match');
  assert.equal(isMainModule(ghost, CLI), false, 'a foreign nonexistent path never matches');
});

// ---------------------------------------------------------------------------
// rad deliver — per-wave capability classes (#85, AC#2/#5/#6). Every refusal
// exits 2 before any event is appended.
// ---------------------------------------------------------------------------

/** A two-wave plan with optional `Capabilities:` lines in the header and each wave block. */
function capabilityPlanText({ header, wave1, wave2 } = {}) {
  const line = (value) => (value === undefined ? [] : [`Capabilities: ${value}`]);
  return [
    `# ${DELIVER_FEATURE}`, '', 'Status: approved', `Branch: rad/${DELIVER_FEATURE}`, ...line(header), '',
    '## Waves', '',
    '### Wave 1', ...line(wave1), '', '#### Task 1.1', '- [ ] Task A', '',
    '### Wave 2', ...line(wave2), '', '- [ ] Task B', '',
  ].join('\n');
}

/** Seed `text` as the approved plan (fingerprinted); returns the event-log path. */
function seedApprovedPlanText(repoRoot, text) {
  const planFile = join(repoRoot, '.agents', 'plans', `${DELIVER_FEATURE}.md`);
  mkdirSync(dirname(planFile), { recursive: true });
  writeFileSync(planFile, text, 'utf8');
  const event = { ...approvedEvent(DELIVER_FEATURE), data: { fingerprint: planFingerprint(text).hash } };
  return writeEventLog(repoRoot, DELIVER_FEATURE, [event]);
}

/** Write a valid .rad/config.yml carrying `capabilities.deny`. */
function writeDenyConfig(repoRoot, deny) {
  mkdirSync(join(repoRoot, '.rad'), { recursive: true });
  writeFileSync(join(repoRoot, '.rad', 'config.yml'), [
    'version: 1', 'platform: manual', 'default_branch: main',
    'roles:', '  architect: [a@example.com]', '  developers: []', '  designers: []',
    'capabilities:', `  deny: [${deny.join(', ')}]`, '',
  ].join('\n'), 'utf8');
}

/** Real (non-injected) command adapter env: no preflight, a trivial command. */
const COMMAND_AGENT_ENV = { RAD_AGENT: 'command', RAD_AGENT_CMD: 'true', RAD_AGENT_PREFLIGHT: 'off' };
const FAKE_SDK_ENV = { RAD_AGENT: 'sdk', ANTHROPIC_API_KEY: 'sk-ant-fake-key-value-1234567890' };
const injectedOk = async () => ({ outcome: 'success' });

/** Assert a refusal: exit 2, stderr matching each pattern, and the event log untouched. */
function assertRefusedBeforeEvents({ code, stderr }, logFile, patterns) {
  assert.equal(code, 2, `expected exit 2; stderr:\n${stderr}`);
  for (const p of patterns) assert.match(stderr, p);
  assert.deepEqual(readLog(logFile).map((e) => e.type), ['approved'], 'no event appended');
}

test('parsePlanCtx — Capabilities: header is the plan default, a wave line replaces it, #### stays inside', () => {
  const ctx = parsePlanCtx(capabilityPlanText({ header: 'fs_read, shell', wave2: 'FS_READ net' }));
  assert.deepEqual(ctx.planCapabilities, ['fs_read', 'shell']);
  assert.deepEqual(ctx.waveCapabilities, { 2: ['fs_read', 'net'] });
  assert.deepEqual(ctx.capabilityErrors, []);
  assert.deepEqual(ctx.waveNumbers, [1, 2]);
  const none = parsePlanCtx(capabilityPlanText());
  assert.equal(none.planCapabilities, undefined);
  assert.deepEqual(none.waveCapabilities, {});
});

test('parsePlanCtx — Capabilities: malformed, empty and duplicate lines are errors naming their scope', () => {
  const ctx = parsePlanCtx(capabilityPlanText({ header: '', wave1: 'fs_read, telepathy' }));
  assert.equal(ctx.capabilityErrors.length, 2);
  assert.match(ctx.capabilityErrors[0], /^plan header: .*empty/);
  assert.match(ctx.capabilityErrors[1], /^wave 1: .*telepathy/);
  const dup = parsePlanCtx(capabilityPlanText({ wave1: 'fs_read\nCapabilities: shell' }));
  assert.match(dup.capabilityErrors[0], /^wave 1: .*more than once/);
});

test('deliver capabilities — a malformed wave line → exit 2 naming the wave, no events', async () => {
  await withTempRepo(async (repoRoot) => {
    const logFile = seedApprovedPlanText(repoRoot, capabilityPlanText({ wave2: 'fs_read, telepathy' }));
    const res = await runDeliverCaptured({ repoRoot, runWave: injectedOk });
    assertRefusedBeforeEvents(res, logFile, [/malformed Capabilities: line/, /wave 2/, /telepathy/]);
  });
});

test('deliver capabilities — a malformed plan-header line → exit 2 naming the plan header, no events', async () => {
  await withTempRepo(async (repoRoot) => {
    const logFile = seedApprovedPlanText(repoRoot, capabilityPlanText({ header: 'everything' }));
    const res = await runDeliverCaptured({ repoRoot, runWave: injectedOk });
    assertRefusedBeforeEvents(res, logFile, [/plan header/, /everything/]);
  });
});

test('deliver capabilities — an explicit request denied by .rad/config.yml → exit 2, no events', async () => {
  await withTempRepo(async (repoRoot) => {
    const logFile = seedApprovedPlanText(repoRoot, capabilityPlanText({ wave1: 'fs_read, net' }));
    writeDenyConfig(repoRoot, ['net']);
    const res = await runDeliverCaptured({ repoRoot, runWave: injectedOk });
    assertRefusedBeforeEvents(res, logFile, [/Wave 1/, /'net'/, /capabilities\.deny/]);
  });
});

test('deliver capabilities — an invalid .rad/config.yml → exit 2 (a deny list that cannot be read is not empty)', async () => {
  await withTempRepo(async (repoRoot) => {
    const logFile = seedApprovedPlanText(repoRoot, capabilityPlanText());
    mkdirSync(join(repoRoot, '.rad'), { recursive: true });
    writeFileSync(join(repoRoot, '.rad', 'config.yml'), 'version: 1\n', 'utf8');
    const res = await runDeliverCaptured({ repoRoot, runWave: injectedOk });
    assertRefusedBeforeEvents(res, logFile, [/config\.yml is invalid/]);
  });
});

test('deliver capabilities — an injected runWave skips the adapter check and records effective classes', async () => {
  await withTempRepo(async (repoRoot) => {
    const logFile = seedApprovedPlanText(repoRoot, capabilityPlanText({ wave1: 'fs_read, mcp' }));
    const { code, stderr } = await runDeliverCaptured({ repoRoot, runWave: injectedOk });
    assert.equal(code, 0, `expected exit 0; stderr:\n${stderr}`);
    const started = readLog(logFile).filter((e) => e.type === 'wave-started');
    assert.deepEqual(started.map((e) => e.data.capabilities), [['fs_read', 'mcp'], undefined]);
  });
});

test('deliver capabilities — command adapter + a narrowed wave → exit 2 naming the wave and set, no events', async () => {
  await withTempRepo(async (repoRoot) => {
    const logFile = seedApprovedPlanText(repoRoot, capabilityPlanText({ wave2: 'fs_read' }));
    const res = await withProcessEnv(COMMAND_AGENT_ENV, () => runDeliverCaptured({ repoRoot }));
    assertRefusedBeforeEvents(res, logFile, [/Wave 2/, /\[fs_read\]/, /RAD_AGENT=sdk/]);
  });
});

test('deliver capabilities — command adapter + an all-default explicit declaration is refused (lacks net, mcp)', async () => {
  await withTempRepo(async (repoRoot) => {
    const logFile = seedApprovedPlanText(repoRoot, capabilityPlanText({ header: 'fs_read, fs_write, shell' }));
    const res = await withProcessEnv(COMMAND_AGENT_ENV, () => runDeliverCaptured({ repoRoot }));
    assertRefusedBeforeEvents(res, logFile, [/Wave 1/, /\[fs_read, fs_write, shell\]/]);
  });
});

/**
 * Run deliverCommand capturing stderr ONLY. A real agent spawn yields the event
 * loop; replacing process.stdout.write across that yield would swallow the
 * node:test runner's own report stream, so stdout is left alone here.
 */
async function runDeliverStderrOnly({ repoRoot, env }) {
  const originalErr = process.stderr.write.bind(process.stderr);
  let stderr = '';
  process.stderr.write = (chunk) => { stderr += chunk; return true; };
  try {
    const code = await withProcessEnv({ ...env, RAD_WORKTREE: '0' }, () =>
      deliverCommand([DELIVER_FEATURE], { repoRoot, sh: okSh }));
    return { code, stderr };
  } finally {
    process.stderr.write = originalErr;
  }
}

test('deliver capabilities — command adapter + no declarations runs as today (no capabilities key)', async () => {
  await withTempRepo(async (repoRoot) => {
    const logFile = seedApprovedPlanText(repoRoot, capabilityPlanText());
    // `{prompt}` puts the prompt in argv, so nothing is written to a child stdin
    // that `true` never reads (on Linux that write races into an uncaught EPIPE).
    const env = { ...COMMAND_AGENT_ENV, RAD_AGENT_CMD: 'true {prompt}' };
    const { code, stderr } = await runDeliverStderrOnly({ repoRoot, env });
    assert.notEqual(code, 2, `setup must not refuse; stderr:\n${stderr}`);
    const started = readLog(logFile).filter((e) => e.type === 'wave-started');
    assert.ok(started.length > 0, 'the run reached the agent');
    assert.ok(started.every((e) => !('capabilities' in e.data)));
  });
});

test('deliver capabilities — sdk adapter + an mcp wave → exit 2 before any SDK call, no events', async () => {
  await withTempRepo(async (repoRoot) => {
    const logFile = seedApprovedPlanText(repoRoot, capabilityPlanText({ wave1: 'fs_read, mcp' }));
    const res = await withProcessEnv(FAKE_SDK_ENV, () => runDeliverCaptured({ repoRoot }));
    assertRefusedBeforeEvents(res, logFile, [/Wave 1/, /mcp/, /sdk adapter/]);
  });
});

// ---------------------------------------------------------------------------
// rad capabilities — read-only per-wave view (#85 part 2, AC#1). Refusals use
// the SAME text as rad deliver; nothing is written.
// ---------------------------------------------------------------------------

/** Write `text` as the feature's plan doc (no event log); returns the plan path. */
function writeCapabilityPlan(repoRoot, text, rel = join('.agents', 'plans', `${DELIVER_FEATURE}.md`)) {
  const planFile = join(repoRoot, rel);
  mkdirSync(dirname(planFile), { recursive: true });
  writeFileSync(planFile, text, 'utf8');
  return planFile;
}

function runCapabilities(repoRoot, argv = [DELIVER_FEATURE]) {
  return captureStdio(() => capabilitiesCommand(argv, { repoRoot }));
}

test('capabilities AC#1 — undeclared plan: every wave is the default set, source default', async () => {
  await withTempRepo(async (repoRoot) => {
    writeCapabilityPlan(repoRoot, capabilityPlanText());
    const res = await runCapabilities(repoRoot);
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.stdout, 'wave 1: fs_read, fs_write, shell (default)\nwave 2: fs_read, fs_write, shell (default)\n');
    assert.ok(!existsSync(join(repoRoot, '.agents', 'state')), 'nothing written');
  });
});

test('capabilities AC#1 — a plan line and a wave override report plan vs wave source', async () => {
  await withTempRepo(async (repoRoot) => {
    writeCapabilityPlan(repoRoot, capabilityPlanText({ header: 'fs_read, shell', wave2: 'fs_read, net' }));
    const res = await runCapabilities(repoRoot);
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.stdout, 'wave 1: fs_read, shell (plan)\nwave 2: fs_read, net (wave)\n');
  });
});

test('capabilities AC#1 — deny narrows the implicit default and is reported as denied', async () => {
  await withTempRepo(async (repoRoot) => {
    writeCapabilityPlan(repoRoot, capabilityPlanText());
    writeDenyConfig(repoRoot, ['shell']);
    const res = await runCapabilities(repoRoot);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /^wave 1: fs_read, fs_write \(default\); denied: shell$/m);
  });
});

test('capabilities AC#1 — a denied explicit request → exit 2 with the same text rad deliver gives', async () => {
  await withTempRepo(async (repoRoot) => {
    const text = capabilityPlanText({ wave1: 'fs_read, net' });
    const logFile = seedApprovedPlanText(repoRoot, text);
    writeDenyConfig(repoRoot, ['net']);
    const res = await runCapabilities(repoRoot);
    assert.equal(res.code, 2);
    assert.equal(res.stdout, '');
    const deliver = await runDeliverCaptured({ repoRoot, runWave: injectedOk });
    assertRefusedBeforeEvents(deliver, logFile, [/Wave 1/]);
    const reason = (stderr, verb) => stderr.trim().slice(`rad ${verb}: `.length);
    assert.equal(reason(res.stderr, 'capabilities'), reason(deliver.stderr, 'deliver'));
  });
});

test('capabilities AC#1 — a malformed Capabilities: line → exit 2 naming the wave', async () => {
  await withTempRepo(async (repoRoot) => {
    writeCapabilityPlan(repoRoot, capabilityPlanText({ wave2: 'fs_read, telepathy' }));
    const res = await runCapabilities(repoRoot);
    assert.equal(res.code, 2);
    assert.match(res.stderr, /malformed Capabilities: line in \.agents\/plans\/.*wave 2: .*telepathy/);
  });
});

test('capabilities AC#1 — missing plan → exit 1; invalid config → exit 1 listing errors', async () => {
  await withTempRepo(async (repoRoot) => {
    const missing = await runCapabilities(repoRoot);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /no plan doc at \.agents\/plans\//);
    writeCapabilityPlan(repoRoot, capabilityPlanText());
    mkdirSync(join(repoRoot, '.rad'), { recursive: true });
    writeFileSync(join(repoRoot, '.rad', 'config.yml'), 'version: 1\n', 'utf8');
    const invalid = await runCapabilities(repoRoot);
    assert.equal(invalid.code, 1);
    assert.match(invalid.stderr, /config\.yml is invalid/);
  });
});

test('capabilities AC#1 — bad argv (extra arg, valueless --plan, missing feature, unknown flag) → exit 2', async () => {
  await withTempRepo(async (repoRoot) => {
    for (const argv of [[DELIVER_FEATURE, 'extra'], [DELIVER_FEATURE, '--plan'], [], [DELIVER_FEATURE, '--nope']]) {
      const res = await runCapabilities(repoRoot, argv);
      assert.equal(res.code, 2, `argv ${JSON.stringify(argv)}`);
      assert.match(res.stderr, /Usage: rad capabilities/);
    }
  });
});

test('capabilities AC#1 — --plan <path> reads that file instead of the feature plan', async () => {
  await withTempRepo(async (repoRoot) => {
    writeCapabilityPlan(repoRoot, capabilityPlanText({ wave1: 'mcp' }), join('elsewhere', 'p.md'));
    const res = await runCapabilities(repoRoot, [DELIVER_FEATURE, '--plan', 'elsewhere/p.md']);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /^wave 1: mcp \(wave\)$/m);
  });
});
