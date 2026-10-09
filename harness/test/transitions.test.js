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

const arch = (fp) => ev('approved', { actor: 'architect', role: 'architect', data: fp === undefined ? {} : { fingerprint: fp } });

test('re-approval after delivered (#228): changed fingerprint is legal', () => {
  const history = [arch('a'), ev('pr-opened')];
  assert.doesNotThrow(() => validateTransition(arch('b'), { history }));
});

test('re-approval after delivered: identical fingerprint is a duplicate', () => {
  const history = [arch('a'), ev('pr-opened')];
  assert.throws(() => validateTransition(arch('a'), { history }), (e) => e.rule === 'duplicate-approved');
});

test('re-approval after delivered: absent fingerprint fails closed as a duplicate', () => {
  const history = [arch('a'), ev('pr-opened')];
  assert.throws(() => validateTransition(arch(undefined), { history }), (e) => e.rule === 'duplicate-approved');
});

test('re-approval after delivered: a role-less approved is still rejected (rule e)', () => {
  const history = [arch('a'), ev('pr-opened')];
  const noRole = ev('approved', { actor: 'x', data: { fingerprint: 'b' } });
  assert.throws(() => validateTransition(noRole, { history }), (e) => e.rule === 'approved-missing-role');
});

test('re-approval after done is still rejected', () => {
  const history = [arch('a'), ev('pr-opened'), ev('done')];
  assert.throws(() => validateTransition(arch('b'), { history }), (e) => e.rule === 'after-terminal');
});

test('other event types after delivered are still rejected', () => {
  const history = [arch('a'), ev('pr-opened')];
  for (const type of ['wave-attempt', 'deliver-started', 'architecture-approved']) {
    assert.throws(() => validateTransition(ev(type, { role: 'architect' }), { history }), (e) => e.rule === 'after-terminal', type);
  }
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

test('illegal (e): approved without role is rejected', () => {
  // An approved event missing the role field bypassed write-time authority.
  // validateTransition is the backstop — it must reject it.
  assert.throws(
    () => validateTransition(ev('approved', { actor: 'architect' }), {
      history: [ev('plan-created')],
    }),
    (err) => {
      assert.ok(err instanceof TransitionError);
      assert.equal(err.rule, 'approved-missing-role');
      return true;
    },
  );
});

test('validateTransition tolerates empty / missing currentState', () => {
  assert.doesNotThrow(() => validateTransition(ev('research-created'), {}));
  assert.doesNotThrow(() => validateTransition(ev('research-created'), undefined));
});
