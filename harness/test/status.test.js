import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { statusCommand } from '../cli.js';
import { defaultSh } from '../adapters/git-state-store.js';

// ---------------------------------------------------------------------------
// Fixture helpers (mirror of cli.test.js)
// ---------------------------------------------------------------------------

async function withTempRepo(fn) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'rad-status-'));
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
// Capture stdout helper
// ---------------------------------------------------------------------------

/**
 * Run fn() while capturing process.stdout writes. Returns { code, stdout }.
 * statusCommand writes to process.stdout; we monkey-patch the write method to
 * capture output without spawning a child process.
 */
async function captureStdout(fn) {
  const chunks = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { chunks.push(chunk); return true; };
  let code;
  try {
    code = await fn();
  } finally {
    process.stdout.write = original;
  }
  return { code, stdout: chunks.join('') };
}

// ---------------------------------------------------------------------------
// AC#1 — status table: two features appear, exit 0
// ---------------------------------------------------------------------------

test('AC#1 — status table lists both features and exits 0', async () => {
  await withTempRepo(async (repoRoot) => {
    writePlanDoc(repoRoot, 'alpha', 'pending-review');
    writePlanDoc(repoRoot, 'beta', 'approved');

    const { code, stdout } = await captureStdout(() =>
      statusCommand([], { repoRoot, sh: defaultSh }),
    );

    assert.equal(code, 0, `statusCommand should return 0; got ${code}`);
    assert.ok(stdout.includes('alpha'), `stdout should include "alpha"; got:\n${stdout}`);
    assert.ok(stdout.includes('beta'), `stdout should include "beta"; got:\n${stdout}`);
    assert.ok(stdout.includes('Feature'), `stdout should include header "Feature"; got:\n${stdout}`);
    assert.ok(stdout.includes('Branch'), `stdout should include header "Branch"; got:\n${stdout}`);
    assert.ok(stdout.includes('rad/alpha'), `stdout should include "rad/alpha"; got:\n${stdout}`);
    assert.ok(stdout.includes('rad/beta'), `stdout should include "rad/beta"; got:\n${stdout}`);
  });
});

// ---------------------------------------------------------------------------
// AC#2 — phase filter: only the matching feature appears
// ---------------------------------------------------------------------------

/**
 * Write a minimal events.jsonl for a feature so state.list() derives the
 * correct phase from the event log. phase() is a pure fold over events —
 * the plan doc's Status header is not used by the state store.
 */
function writeEventLog(repoRoot, feature, eventType) {
  const stateDir = join(repoRoot, '.agents', 'state', feature);
  mkdirSync(stateDir, { recursive: true });
  const event = {
    feature,
    type: eventType,
    actor: 'test@example.com',
    ts: new Date().toISOString(),
    role: eventType === 'approved' ? 'architect' : undefined,
  };
  writeFileSync(
    join(stateDir, 'events.jsonl'),
    JSON.stringify(event) + '\n',
    'utf8',
  );
}

test('AC#2 — phase filter returns only matching features', async () => {
  await withTempRepo(async (repoRoot) => {
    writePlanDoc(repoRoot, 'alpha', 'pending-review');
    writePlanDoc(repoRoot, 'beta', 'approved');

    // phase() is derived from events.jsonl, not from the plan doc Status field.
    // Write a plan-created event for 'alpha' and an approved event for 'beta'.
    writeEventLog(repoRoot, 'alpha', 'plan-created');
    writeEventLog(repoRoot, 'beta', 'approved');

    const { code, stdout } = await captureStdout(() =>
      statusCommand(['--phase', 'approved'], { repoRoot, sh: defaultSh }),
    );

    assert.equal(code, 0, `statusCommand should return 0; got ${code}`);
    assert.ok(stdout.includes('beta'), `stdout should include "beta" (approved); got:\n${stdout}`);
    assert.ok(!stdout.includes('alpha'), `stdout should NOT include "alpha" (planned); got:\n${stdout}`);
  });
});

// ---------------------------------------------------------------------------
// AC#1 edge case / AC#5 — empty state: "no features found"
// ---------------------------------------------------------------------------

test('AC#5 — empty state exits 0 and prints "no features found"', async () => {
  await withTempRepo(async (repoRoot) => {
    // No plan docs, no state directory — completely empty repo.
    const { code, stdout } = await captureStdout(() =>
      statusCommand([], { repoRoot, sh: defaultSh }),
    );

    assert.equal(code, 0, `statusCommand should return 0; got ${code}`);
    assert.ok(
      stdout.includes('no features found'),
      `stdout should include "no features found"; got:\n${stdout}`,
    );
  });
});
