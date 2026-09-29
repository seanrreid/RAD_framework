import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyStop, STOP_CLASSES, STOP_TABLE } from '../stops.js';

const { NEEDS_DECISION, FAILED } = STOP_CLASSES;

test('STOP_CLASSES and STOP_TABLE are frozen', () => {
  assert.deepEqual({ ...STOP_CLASSES }, { NEEDS_DECISION: 'needs-decision', FAILED: 'failed' });
  assert.ok(Object.isFrozen(STOP_CLASSES));
  assert.ok(Object.isFrozen(STOP_TABLE));
  for (const row of Object.values(STOP_TABLE)) assert.ok(Object.isFrozen(row));
});

test('matrix + surface → needs-decision, reason = outcome', () => {
  assert.deepEqual(
    classifyStop({ stopped: 'matrix', ok: false, wave: 2, action: 'surface', outcome: 'fail-timeout' }),
    {
      class: NEEDS_DECISION,
      reason: 'fail-timeout',
      decision:
        'wave 2: fail-timeout — non-deterministic failure (e.g. timeout/orphaned attempt); retry, raise the limit, or split the wave',
    },
  );
});

test('matrix + abort → failed, reason = outcome', () => {
  assert.deepEqual(
    classifyStop({ stopped: 'matrix', ok: false, wave: 1, action: 'abort', outcome: 'fail-scope' }),
    {
      class: FAILED,
      reason: 'fail-scope',
      decision: 'wave 1: fail-scope — the work is wrong for the plan; fix the plan or the code and re-run',
    },
  );
});

test('hook-veto + surface → needs-decision with the veto suffix', () => {
  const r = classifyStop({
    stopped: 'hook-veto', ok: false, wave: 1, action: 'surface', outcome: 'fail-timeout',
    point: 'pre-wave', hook: '10-policy.sh',
  });
  assert.equal(r.class, NEEDS_DECISION);
  assert.equal(r.reason, 'fail-timeout');
  assert.equal(
    r.decision,
    'wave 1: fail-timeout — non-deterministic failure (e.g. timeout/orphaned attempt); retry, raise the limit, or split the wave — vetoed by hook 10-policy.sh at pre-wave',
  );
});

test('hook-veto + abort → failed with the veto suffix', () => {
  const r = classifyStop({
    stopped: 'hook-veto', ok: false, wave: 3, action: 'abort', outcome: 'abort-user',
    point: 'pre-wave', hook: '10-policy.sh',
  });
  assert.equal(r.class, FAILED);
  assert.equal(r.reason, 'abort-user');
  assert.equal(
    r.decision,
    'wave 3: abort-user — the work is wrong for the plan; fix the plan or the code and re-run — vetoed by hook 10-policy.sh at pre-wave',
  );
});

test('doom-loop → failed', () => {
  assert.deepEqual(classifyStop({ stopped: 'doom-loop', ok: false, wave: 2, outcome: 'fail-tests' }), {
    class: FAILED,
    reason: 'doom-loop',
    decision: 'wave 2 failed identically twice — a retry cannot fix it',
  });
});

test('budget (maxAttempts) → failed', () => {
  assert.deepEqual(classifyStop({ stopped: 'budget', ok: false, wave: 4 }), {
    class: FAILED,
    reason: 'budget',
    decision: 'wave 4 exhausted its attempts',
  });
});

test('post-check → failed', () => {
  assert.deepEqual(classifyStop({ stopped: 'post-check', ok: false, check: 'check-scope.sh', status: 1 }), {
    class: FAILED,
    reason: 'post-check',
    decision: 'post-check check-scope.sh exited 1',
  });
});

test('resume-verify → failed (a promised test file is missing)', () => {
  const r = classifyStop({ stopped: 'resume-verify', ok: false });
  assert.equal(r.class, FAILED);
  assert.equal(r.reason, 'resume-verify');
  assert.match(r.decision, /^resume verify: /);
});

test('token-budget → needs-decision', () => {
  assert.deepEqual(
    classifyStop({ stopped: 'token-budget', ok: false, wave: 2, spent: 1500, budget: 1000 }),
    {
      class: NEEDS_DECISION,
      reason: 'token-budget',
      decision: 'token budget 1000 reached (spent 1500); raise RAD_TOKEN_BUDGET or stop',
    },
  );
});

test('failed-attempt-cap → needs-decision', () => {
  assert.deepEqual(classifyStop({ stopped: 'failed-attempt-cap', ok: false, failed: 5, cap: 5 }), {
    class: NEEDS_DECISION,
    reason: 'failed-attempt-cap',
    decision: '5 failed attempts reached RAD_MAX_FAILED_ATTEMPTS=5; raise the cap, re-plan, or stop',
  });
});

test('approval-changed → needs-decision', () => {
  assert.deepEqual(classifyStop({ stopped: 'approval-changed', ok: false }), {
    class: NEEDS_DECISION,
    reason: 'approval-changed',
    decision: 'the plan changed since approval (or approval no longer holds); re-approve before re-running',
  });
});

test('gate (pre-start) → needs-decision', () => {
  assert.deepEqual(classifyStop({ stopped: 'gate', gate: 'approved', reason: 'needs an approved event' }), {
    class: NEEDS_DECISION,
    reason: 'gate',
    decision: 'plan not approved; run /rad-approve',
  });
});

test('templating: missing optional fields render gracefully', () => {
  assert.equal(classifyStop({ stopped: 'budget' }).decision, 'the wave exhausted its attempts');
  assert.equal(
    classifyStop({ stopped: 'doom-loop' }).decision,
    'the wave failed identically twice — a retry cannot fix it',
  );
  assert.equal(
    classifyStop({ stopped: 'matrix', action: 'abort', outcome: 'no-changes' }).decision,
    'the wave: no-changes — the work is wrong for the plan; fix the plan or the code and re-run',
  );
  assert.equal(classifyStop({ stopped: 'post-check' }).decision, 'post-check unknown exited unknown');
  assert.match(
    classifyStop({ stopped: 'hook-veto', wave: 1, action: 'abort', outcome: 'abort-user' }).decision,
    / — vetoed by hook unknown at unknown$/,
  );
  // A zero is a real value, not a missing one.
  assert.equal(classifyStop({ stopped: 'post-check', check: 'x.sh', status: 0 }).decision, 'post-check x.sh exited 0');
  assert.ok(!/undefined|null|\{/.test(classifyStop({ stopped: 'token-budget' }).decision));
});

test('every spine terminal shape classifies to exactly one known class', () => {
  // Enumerates each `return { stopped: ... }` in harness/spine.js (shapes as returned).
  const terminals = [
    { stopped: 'gate', gate: 'approved', reason: 'r' },
    { stopped: 'token-budget', ok: false, wave: 1, spent: 10, budget: 5 },
    { stopped: 'resume-verify', ok: false },
    { stopped: 'matrix', ok: false, wave: 1, action: 'surface', outcome: 'fail-timeout' }, // orphan
    { stopped: 'hook-veto', ok: false, wave: 1, action: 'abort', outcome: 'abort-user', point: 'pre-wave', hook: 'h' },
    { stopped: 'doom-loop', ok: false, wave: 1, outcome: 'fail-tests' },
    { stopped: 'matrix', ok: false, wave: 1, action: 'abort', outcome: 'fail-scope' },
    { stopped: 'budget', ok: false, wave: 1 },
    { stopped: 'post-check', ok: false, check: 'open-pr.sh', status: 2 },
  ];
  const classes = new Set(Object.values(STOP_CLASSES));
  for (const t of terminals) {
    const r = classifyStop(t);
    assert.ok(classes.has(r.class), `${t.stopped} → ${r.class}`);
    assert.equal(typeof r.reason, 'string');
    assert.ok(r.decision.length > 0);
  }
});

test('unknown stopped throws', () => {
  assert.throws(() => classifyStop({ stopped: 'nope' }), /classifyStop: unknown stopped "nope"/);
  assert.throws(() => classifyStop({}), /classifyStop: unknown stopped/);
  assert.throws(() => classifyStop({ stopped: 'toString' }), /classifyStop: unknown stopped/);
});

test('unknown action for matrix / hook-veto throws', () => {
  for (const stopped of ['matrix', 'hook-veto']) {
    for (const action of ['retry', 'advance', 'revision', undefined, 'bogus']) {
      assert.throws(() => classifyStop({ stopped, action, outcome: 'fail-tests' }), /classifyStop: unknown action/);
    }
  }
});

test('matrix / hook-veto with no outcome throws', () => {
  assert.throws(() => classifyStop({ stopped: 'matrix', action: 'abort' }), /classifyStop: missing outcome/);
  assert.throws(() => classifyStop({ stopped: 'hook-veto', action: 'surface', outcome: '' }), /missing outcome/);
});

test('null / non-object input throws', () => {
  for (const bad of [null, undefined, 'matrix', 42, [], true]) {
    assert.throws(() => classifyStop(bad), /classifyStop: unknown result/);
  }
});
