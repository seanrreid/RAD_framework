import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadMatrix, resolveOutcome, DEFAULT_MATRIX_PATH } from '../matrix.js';

const VALID_ACTIONS = new Set([
  'advance',
  'retry',
  'revision',
  'abort',
  'skip-to',
  'surface',
]);

test('loadMatrix parses matrix.yaml to an object of phase rows', () => {
  const matrix = loadMatrix();
  assert.equal(typeof matrix, 'object');
  assert.ok(matrix.implement);
  assert.ok(matrix.verify);
  // path defaults to the YAML next to the module.
  assert.ok(DEFAULT_MATRIX_PATH.endsWith('matrix.yaml'));
});

test('EXHAUSTIVENESS: every declared (phase, outcome) pair resolves to a defined action, no fallthrough', () => {
  const matrix = loadMatrix();
  for (const [phase, row] of Object.entries(matrix)) {
    for (const outcome of Object.keys(row)) {
      const resolved = resolveOutcome(phase, outcome, matrix);
      assert.ok(
        resolved && VALID_ACTIONS.has(resolved.action),
        `(${phase}, ${outcome}) resolved to an undefined/invalid action: ${JSON.stringify(resolved)}`,
      );
      // advance / skip-to must name a target phase.
      if (resolved.action === 'advance' || resolved.action === 'skip-to') {
        assert.ok(
          typeof resolved.to === 'string' && resolved.to.length > 0,
          `(${phase}, ${outcome}) action '${resolved.action}' must declare a 'to' phase`,
        );
      }
    }
  }
});

test('resolveOutcome returns the YAML-declared action for sample pairs', () => {
  const matrix = loadMatrix();
  assert.deepEqual(resolveOutcome('implement', 'success', matrix), {
    action: 'advance',
    to: 'verify',
  });
  assert.deepEqual(resolveOutcome('implement', 'fail-tests', matrix), {
    action: 'revision',
  });
  assert.deepEqual(resolveOutcome('implement', 'fail-scope', matrix), {
    action: 'abort',
  });
  assert.deepEqual(resolveOutcome('verify', 'success', matrix), {
    action: 'advance',
    to: 'done',
  });
  assert.deepEqual(resolveOutcome('verify', 'no-changes', matrix), {
    action: 'advance',
    to: 'done',
  });
});

test('resolveOutcome throws (no default) on an unknown applicable pair', () => {
  const matrix = loadMatrix();
  // Unknown outcome within a known phase.
  assert.throws(
    () => resolveOutcome('implement', 'totally-unknown-outcome', matrix),
    /No stop-condition entry/,
  );
  // Unknown phase entirely.
  assert.throws(
    () => resolveOutcome('no-such-phase', 'success', matrix),
    /No stop-condition entry/,
  );
});
