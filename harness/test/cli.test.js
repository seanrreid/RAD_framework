import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { approveCommand, parsePlanCtx } from '../cli.js';
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
