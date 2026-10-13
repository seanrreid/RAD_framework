import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CRASH_PATTERN, findMutantCrash, judgeMutatedRun } from '../evals/lib/runner.js';

const CASE_ID = 'demo-case';
const ALTERNATIVES = [
  'ReferenceError', 'TypeError', 'SyntaxError', 'RangeError', 'command not found',
  'unbound variable', 'Cannot find module', 'is not a function', 'is not defined',
];
const ORDINARY_STDERR = 'rad deliver: failed feature=x';

test('findMutantCrash finds a crash in result.stderr', () => {
  assert.equal(findMutantCrash({ stderr: 'boom TypeError: x' }), 'TypeError');
});

test('findMutantCrash finds a crash in nested cli.stderr and hook.stderr', () => {
  assert.equal(findMutantCrash({ cli: { stderr: 'x is not defined' } }), 'is not defined');
  assert.equal(findMutantCrash({ hook: { stderr: 'foo: command not found' } }), 'command not found');
});

test('findMutantCrash finds a crash inside an array', () => {
  assert.equal(findMutantCrash({ runs: [{ stderr: 'ok' }, { stderr: 'RangeError: bad' }] }), 'RangeError');
  assert.equal(findMutantCrash([{ stderr: 'SyntaxError' }]), 'SyntaxError');
});

for (const alt of ALTERNATIVES) {
  test(`findMutantCrash matches the "${alt}" alternative`, () => {
    assert.equal(findMutantCrash({ stderr: `prefix ${alt} suffix` }), alt);
    assert.match(alt, CRASH_PATTERN);
  });
}

test('findMutantCrash ignores crash text in stdout and events', () => {
  assert.equal(findMutantCrash({ stdout: 'TypeError', stderr: '' }), null);
  assert.equal(findMutantCrash({ events: [{ stderr: 'TypeError', data: 'ReferenceError' }] }), null);
  assert.equal(findMutantCrash({ other: 'TypeError' }), null);
});

test('findMutantCrash does not flag an ordinary stderr', () => {
  assert.equal(findMutantCrash({ stderr: ORDINARY_STDERR, cli: { stderr: ORDINARY_STDERR } }), null);
});

test('findMutantCrash returns null for null, undefined, primitives and empty objects', () => {
  for (const value of [null, undefined, 'TypeError', 42, true, {}, []]) {
    assert.equal(findMutantCrash(value), null, `value: ${String(value)}`);
  }
});

test('findMutantCrash ignores a non-string stderr', () => {
  assert.equal(findMutantCrash({ stderr: null }), null);
  assert.equal(findMutantCrash({ stderr: 42 }), null);
});

test('judgeMutatedRun rejects a crashing result without running the assertion', async () => {
  let asserted = false;
  const c = { id: CASE_ID, assert: () => { asserted = true; } };
  await assert.rejects(
    judgeMutatedRun(c, {}, { cli: { stderr: 'TypeError: nope' } }),
    (err) => err.message.includes(CASE_ID) && err.message.includes('the mutant crashed (TypeError) instead of failing its assertion'),
  );
  assert.equal(asserted, false);
});

test('judgeMutatedRun rejects when the assertion still passes', async () => {
  const c = { id: CASE_ID, assert: () => {} };
  await assert.rejects(judgeMutatedRun(c, {}, { stderr: '' }), /assertion still passed with the guard removed/);
});

test('judgeMutatedRun resolves when the assertion throws', async () => {
  const c = { id: CASE_ID, assert: () => { throw new Error('guard gone'); } };
  await assert.doesNotReject(judgeMutatedRun(c, {}, { stderr: ORDINARY_STDERR }));
});

test('judgeMutatedRun awaits an async assertion that rejects', async () => {
  const c = { id: CASE_ID, assert: async () => { throw new Error('guard gone'); } };
  await assert.doesNotReject(judgeMutatedRun(c, {}, {}));
});
