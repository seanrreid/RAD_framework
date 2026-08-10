import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { approveCommand, gateCommand, parsePlanCtx } from '../cli.js';
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
