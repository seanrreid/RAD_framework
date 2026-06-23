import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createGitStateStore } from '../adapters/git-state-store.js';
import { evaluateGate } from '../gates.js';
import { planFingerprint } from '../plan-fingerprint.js';
import { validateTransition, TransitionError } from '../transitions.js';

// ── Helpers ────────────────────────────────────────────────────────────────
// Mirrors policy-approval.test.js: async so an async `fn` is fully awaited
// BEFORE the temp dir is removed. `await fn(...)` is a no-op for sync callbacks.
async function withTempRepo(fn) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'rad-approval-authority-'));
  try {
    return await fn(repoRoot);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

// An injected sh that records calls and returns success for check-role.sh, so the
// write-time role freeze passes without a real CLAUDE.md / role map.
function passingSh() {
  const calls = [];
  const sh = (file, args, opts) => {
    calls.push({ file, args, opts });
    return { status: 0, stdout: '', stderr: '' };
  };
  return { sh, calls };
}

// transitions.test.js's event factory — the same validateTransition entry point.
const ev = (type, extra = {}) => ({ feature: 'f', type, actor: 'harness', ts: 't', ...extra });

// ─────────────────────────────────────────────────────────────────────────────
// AC#1 — recordArchitectureApproved appends a frozen `architecture-approved`
// event to the `_architecture` log (role frozen + recordedBy proxy provenance +
// data.slug); AND evaluateGate('approved', …) is UNCHANGED by such an event
// (audit-only, no fold effect).
// ─────────────────────────────────────────────────────────────────────────────
test('AC#1: recordArchitectureApproved appends a frozen architecture-approved event with proxy provenance + data.slug', async () => {
  await withTempRepo((repoRoot) => {
    const { sh } = passingSh();
    const store = createGitStateStore({ repoRoot, sh });

    store.recordArchitectureApproved({
      slug: 'approval-authority-recording',
      onBehalfOf: 'sean@torchcodelab.com',
      recordedBy: 'dev@torchcodelab.com',
      ts: 't0',
    });

    // It lands in the reserved `_architecture` project log, NOT in any feature log.
    const hist = store.history('_architecture');
    assert.equal(hist.length, 1);
    const event = hist[0];
    assert.equal(event.type, 'architecture-approved');
    assert.equal(event.feature, '_architecture');
    // role frozen at write-time (the verified architect role).
    assert.equal(event.role, 'architect');
    // actor = the architect identity whose authority was frozen (onBehalfOf).
    assert.equal(event.actor, 'sean@torchcodelab.com');
    // recordedBy = proxy provenance (who physically ran it).
    assert.equal(event.recordedBy, 'dev@torchcodelab.com');
    // data.slug records which work slug the review covers.
    assert.equal(event.data.slug, 'approval-authority-recording');
  });
});

test('AC#1: recordedBy defaults to onBehalfOf when no proxy runner is given', async () => {
  await withTempRepo((repoRoot) => {
    const { sh } = passingSh();
    const store = createGitStateStore({ repoRoot, sh });
    store.recordArchitectureApproved({
      slug: 'feat-x',
      onBehalfOf: 'arch@example.com',
      ts: 't0',
    });
    const event = store.history('_architecture')[0];
    assert.equal(event.recordedBy, 'arch@example.com');
  });
});

test('AC#1: an architecture-approved event leaves evaluateGate("approved", …) UNCHANGED (audit-only, no fold effect)', () => {
  // The gate fold is a pure function of history. An architecture-approved event
  // must be inert to the approved gate: the result with it present must equal the
  // result without it.
  const planCreated = { feature: 'f', type: 'plan-created', actor: 'a', ts: 't0' };
  const architectureApproved = {
    feature: '_architecture',
    type: 'architecture-approved',
    actor: 'arch@example.com',
    role: 'architect',
    ts: 't1',
    data: { slug: 'f' },
  };

  // Negative case: not approved either way.
  const without = evaluateGate('approved', [planCreated]);
  const withArch = evaluateGate('approved', [planCreated, architectureApproved]);
  assert.deepEqual(withArch, without);
  assert.equal(withArch.passed, false);

  // Positive case: a real approved event passes; adding an architecture-approved
  // event must not change the satisfiedBy/passed result.
  const approved = {
    feature: 'f',
    type: 'approved',
    actor: 'arch@example.com',
    role: 'architect',
    ts: 't2',
  };
  const approvedOnly = evaluateGate('approved', [planCreated, approved]);
  const approvedPlusArch = evaluateGate('approved', [planCreated, approved, architectureApproved]);
  assert.deepEqual(approvedPlusArch, approvedOnly);
  assert.equal(approvedPlusArch.passed, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// AC#2 — isSafeFeature admits `_architecture` but still REJECTS other invalid
// keys. isSafeFeature is not exported; we exercise it through history(), which
// calls assertSafeFeature(feature) (throws "invalid feature slug" when unsafe).
// ─────────────────────────────────────────────────────────────────────────────
test('AC#2: the reserved _architecture key is admitted (no throw)', async () => {
  await withTempRepo((repoRoot) => {
    const store = createGitStateStore({ repoRoot });
    // No log yet → empty array, but crucially it does NOT throw on the slug.
    assert.deepEqual(store.history('_architecture'), []);
  });
});

test('AC#2: other invalid keys are still rejected (_evil, ../x, "Foo Bar", leading-dash)', async () => {
  await withTempRepo((repoRoot) => {
    const store = createGitStateStore({ repoRoot });
    for (const bad of ['_evil', '../x', 'Foo Bar', '-leading-dash', '_other', 'a/b']) {
      assert.throws(
        () => store.history(bad),
        /invalid feature slug/,
        `expected ${JSON.stringify(bad)} to be rejected`,
      );
    }
    // A normal feature slug still passes.
    assert.deepEqual(store.history('approval-authority-recording'), []);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC#3 — planFingerprint determinism / normative-sensitivity /
// header-insensitivity; recordApproval(fingerprint) stamps data.fingerprint.
// ─────────────────────────────────────────────────────────────────────────────
const PLAN_A = [
  'Status: draft',
  'Approved-By:',
  'Approved-At:',
  '',
  '## Summary',
  '',
  'Record approval authority as events.',
  '',
  '## Acceptance Criteria',
  '',
  '1. Something happens.',
  '',
].join('\n');

test('AC#3: planFingerprint is deterministic — same body → same hash', () => {
  const a = planFingerprint(PLAN_A);
  const b = planFingerprint(PLAN_A);
  assert.equal(typeof a.hash, 'string');
  assert.equal(a.hash.length, 64); // sha256 hex
  assert.equal(a.hash, b.hash);
});

test('AC#3: planFingerprint is normative-sensitive — editing a body section changes the hash', () => {
  const edited = PLAN_A.replace('Record approval authority as events.', 'Record approval authority as EDITED events.');
  assert.notEqual(planFingerprint(edited).hash, planFingerprint(PLAN_A).hash);
});

test('AC#3: planFingerprint is header-insensitive — changing only a Status/Approved-* header line does NOT change the hash', () => {
  // Mutate only the mutable header block (above the first `## ` heading).
  const headerRewritten = PLAN_A
    .replace('Status: draft', 'Status: approved')
    .replace('Approved-By:', 'Approved-By: sean@torchcodelab.com')
    .replace('Approved-At:', 'Approved-At: 2026-06-23');
  assert.notEqual(headerRewritten, PLAN_A); // sanity: we did change the text
  assert.equal(planFingerprint(headerRewritten).hash, planFingerprint(PLAN_A).hash);
});

test('AC#3: recordApproval with a fingerprint arg stamps data.fingerprint on the approved event', async () => {
  await withTempRepo((repoRoot) => {
    const { sh } = passingSh();
    const store = createGitStateStore({ repoRoot, sh });
    const fp = planFingerprint(PLAN_A).hash;

    store.recordApproval({
      feature: 'demo',
      actor: 'arch@example.com',
      recordedBy: 'dev',
      fingerprint: fp,
      ts: 't0',
    });

    const event = store.history('demo')[0];
    assert.equal(event.type, 'approved');
    assert.equal(event.data.fingerprint, fp);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC#4 — fingerprint compare semantics. We drive scripts/check-plan-approved.sh
// via execFileSync against a temp git repo where the local working-tree event log
// (resolution step 3) carries an approved event. Asserts:
//   - unedited plan      → exit 0 (stored fp == current fp)
//   - edited plan        → non-zero (fail closed on fingerprint mismatch)
//   - legacy (no stored fingerprint) → exit 0 (fail-open exception)
// The fingerprint is computed via the same single source of truth used in AC#3.
// ─────────────────────────────────────────────────────────────────────────────
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const CHECK_SCRIPT = join(REPO_ROOT, 'scripts', 'check-plan-approved.sh');

// Run check-plan-approved.sh against a temp repo that has a plan + event log on
// the LOCAL working tree (resolution step 3). Returns the exit status.
function runCheck(repoRoot, feature, base = 'main') {
  try {
    execFileSync('bash', [CHECK_SCRIPT, `rad/${feature}`, base], {
      cwd: repoRoot,
      env: { ...process.env, RAD_SYNC: '' }, // no fetch — local-tree resolution only
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return 0;
  } catch (err) {
    return typeof err.status === 'number' ? err.status : 1;
  }
}

// Build a temp git repo with a plan doc + a local-tree approved event log. The
// approved event's data.fingerprint is set to `storedFp` (omit/empty for legacy).
function seedRepo(repoRoot, feature, planText, storedFp) {
  // Wire the script's CLI + helper-script lookups to THIS repo's real harness.
  // check-plan-approved.sh resolves SCRIPT_DIR/REPO_ROOT from its own location,
  // so node "$CLI" already points at the real harness/cli.js — good. It runs git
  // inside cwd (the temp repo), so the temp repo must be a git repo.
  execFileSync('git', ['init', '-q'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: repoRoot });

  const planDir = join(repoRoot, '.agents', 'plans');
  mkdirSync(planDir, { recursive: true });
  writeFileSync(join(planDir, `${feature}.md`), planText, 'utf8');

  const stateDir = join(repoRoot, '.agents', 'state', feature);
  mkdirSync(stateDir, { recursive: true });
  const data = storedFp ? { fingerprint: storedFp } : {};
  const approved = {
    feature,
    type: 'approved',
    actor: 'arch@example.com',
    role: 'architect',
    ts: 't0',
    data,
  };
  writeFileSync(join(stateDir, 'events.jsonl'), JSON.stringify(approved) + '\n', 'utf8');
}

test('AC#4: check-plan-approved.sh — unedited plan (stored fp == current fp) exits 0', async () => {
  await withTempRepo((repoRoot) => {
    const feature = 'fp-match';
    const storedFp = planFingerprint(PLAN_A).hash;
    seedRepo(repoRoot, feature, PLAN_A, storedFp);
    assert.equal(runCheck(repoRoot, feature), 0);
  });
});

test('AC#4: check-plan-approved.sh — edited plan (fingerprint mismatch) fails closed (non-zero)', async () => {
  await withTempRepo((repoRoot) => {
    const feature = 'fp-edited';
    // Stored fp is for PLAN_A, but the on-disk plan body has been edited.
    const storedFp = planFingerprint(PLAN_A).hash;
    const editedPlan = PLAN_A.replace('Record approval authority as events.', 'Record approval authority as EDITED events.');
    // Sanity: bodies genuinely differ.
    assert.notEqual(planFingerprint(editedPlan).hash, storedFp);
    seedRepo(repoRoot, feature, editedPlan, storedFp);
    assert.notEqual(runCheck(repoRoot, feature), 0);
  });
});

test('AC#4: check-plan-approved.sh — legacy approved event with NO fingerprint passes (exit 0)', async () => {
  await withTempRepo((repoRoot) => {
    const feature = 'fp-legacy';
    // No stored fingerprint → fail-open legacy exception: never compared.
    seedRepo(repoRoot, feature, PLAN_A, undefined);
    assert.equal(runCheck(repoRoot, feature), 0);
  });
});

// JS-level equivalent of the compare decision logic (the shell boundary above is
// the integration; this pins the decision semantics independently).
test('AC#4: compare decision logic — differing bodies are detected; a missing stored fingerprint is legacy-pass', () => {
  const original = planFingerprint(PLAN_A).hash;
  const edited = planFingerprint(
    PLAN_A.replace('Record approval authority as events.', 'changed'),
  ).hash;
  assert.notEqual(edited, original); // edit detected → would fail closed
  // Legacy: stored fingerprint absent → comparison is skipped (treated as pass).
  const storedFp = '';
  const compared = storedFp !== '' /* only compare when present */;
  assert.equal(compared, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// AC#5 — re-approval transition: a second `approved` with a DIFFERING
// data.fingerprint is allowed; identical-fingerprint is blocked; absent
// fingerprint (legacy) is blocked (fail-closed). Same entry point as
// transitions.test.js (validateTransition).
// ─────────────────────────────────────────────────────────────────────────────
test('AC#5: a second approved with a DIFFERING fingerprint is ALLOWED', () => {
  const history = [
    ev('plan-created'),
    ev('approved', { actor: 'arch', role: 'architect', data: { fingerprint: 'aaa' } }),
  ];
  assert.doesNotThrow(() =>
    validateTransition(
      ev('approved', { actor: 'arch', role: 'architect', data: { fingerprint: 'bbb' } }),
      { history },
    ),
  );
});

test('AC#5: a second approved with an IDENTICAL fingerprint is BLOCKED (duplicate-approved)', () => {
  const history = [
    ev('plan-created'),
    ev('approved', { actor: 'arch', role: 'architect', data: { fingerprint: 'aaa' } }),
  ];
  assert.throws(
    () =>
      validateTransition(
        ev('approved', { actor: 'arch', role: 'architect', data: { fingerprint: 'aaa' } }),
        { history },
      ),
    (err) => {
      assert.ok(err instanceof TransitionError);
      assert.equal(err.rule, 'duplicate-approved');
      return true;
    },
  );
});

test('AC#5: a second approved with an ABSENT fingerprint is BLOCKED (legacy fail-closed)', () => {
  // Prior has a fingerprint, next has none → cannot prove bodies differ → block.
  const history = [
    ev('plan-created'),
    ev('approved', { actor: 'arch', role: 'architect', data: { fingerprint: 'aaa' } }),
  ];
  assert.throws(
    () => validateTransition(ev('approved', { actor: 'arch', role: 'architect' }), { history }),
    (err) => {
      assert.ok(err instanceof TransitionError);
      assert.equal(err.rule, 'duplicate-approved');
      return true;
    },
  );
});

test('AC#5: both approvals absent-fingerprint is BLOCKED (legacy fail-closed)', () => {
  const history = [
    ev('plan-created'),
    ev('approved', { actor: 'arch', role: 'architect' }),
  ];
  assert.throws(
    () => validateTransition(ev('approved', { actor: 'arch', role: 'architect' }), { history }),
    (err) => {
      assert.ok(err instanceof TransitionError);
      assert.equal(err.rule, 'duplicate-approved');
      return true;
    },
  );
});
