import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateTransition, TransitionError } from '../transitions.js';

const ev = (type, extra = {}) => ({ feature: 'f', type, actor: 'harness', ts: 't', ...extra });

test('illegal (a): event after a terminal phase throws', () => {
  // 'done' is terminal.
  const history = [ev('done')];
  assert.throws(
    () => validateTransition(ev('wave-attempt'), { history }),
    (err) => {
      assert.ok(err instanceof TransitionError);
      assert.equal(err.rule, 'after-terminal');
      return true;
    },
  );
  // 'pr-opened' → delivered is also terminal.
  assert.throws(
    () => validateTransition(ev('wave-attempt'), { history: [ev('pr-opened')] }),
    TransitionError,
  );
});

test('illegal (b): wave-complete when not in-progress throws', () => {
  const history = [ev('approved', { actor: 'architect', role: 'architect' })]; // phase = approved
  assert.throws(
    () => validateTransition(ev('wave-complete'), { history }),
    (err) => {
      assert.ok(err instanceof TransitionError);
      assert.equal(err.rule, 'wave-complete-not-in-progress');
      return true;
    },
  );
});

test('illegal (c): revision-requested with no evaluator output throws', () => {
  const history = [ev('deliver-started')]; // in-progress but no wave-* yet
  assert.throws(
    () => validateTransition(ev('revision-requested'), { history }),
    (err) => {
      assert.ok(err instanceof TransitionError);
      assert.equal(err.rule, 'revision-without-evaluator');
      return true;
    },
  );
});

test('illegal (d): duplicate approved throws', () => {
  const history = [ev('approved', { actor: 'architect', role: 'architect' })];
  assert.throws(
    () => validateTransition(ev('approved', { actor: 'architect', role: 'architect' }), { history }),
    (err) => {
      assert.ok(err instanceof TransitionError);
      assert.equal(err.rule, 'duplicate-approved');
      return true;
    },
  );
});

test('legal moves return normally (no throw)', () => {
  // approval onto a planned feature
  assert.doesNotThrow(() =>
    validateTransition(ev('approved', { actor: 'architect', role: 'architect' }), {
      history: [ev('plan-created')],
    }),
  );
  // deliver-started onto approved
  assert.doesNotThrow(() =>
    validateTransition(ev('deliver-started'), {
      history: [ev('plan-created'), ev('approved', { actor: 'architect', role: 'architect' })],
    }),
  );
  // wave-complete while in-progress
  assert.doesNotThrow(() =>
    validateTransition(ev('wave-complete'), {
      history: [ev('deliver-started'), ev('wave-attempt')],
    }),
  );
  // revision-requested after evaluator output
  assert.doesNotThrow(() =>
    validateTransition(ev('revision-requested'), {
      history: [ev('deliver-started'), ev('wave-failed')],
    }),
  );
});

test('validateTransition tolerates empty / missing currentState', () => {
  assert.doesNotThrow(() => validateTransition(ev('research-created'), {}));
  assert.doesNotThrow(() => validateTransition(ev('research-created'), undefined));
});
