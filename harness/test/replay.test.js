import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replayDecisions, diffDecisions, gateNameUnion } from '../replay.js';
import { loadMatrix } from '../matrix.js';
import { loadGates } from '../gates.js';

const FEATURE = 'demo';

function baseMatrix() {
  return {
    implement: {
      success: { action: 'advance' },
      'fail-tests': { action: 'retry' },
      'fail-scope': { action: 'abort' },
    },
  };
}

function baseGates() {
  return {
    approved: {
      eventType: 'approved',
      requiredRole: 'architect',
      condition: 'role-equals',
      reason: 'needs approval',
    },
  };
}

const approved = { type: 'approved', feature: FEATURE, actor: 'a', role: 'architect' };
const started = { type: 'deliver-started', feature: FEATURE };
const attempt = (wave, n, outcome) => ({
  type: 'wave-attempt',
  feature: FEATURE,
  data: { wave, attempt: n, outcome },
});

function history() {
  return [
    approved,
    started,
    attempt(1, 1, 'fail-tests'),
    attempt(1, 2, 'success'),
  ];
}

test('empty or non-array history replays to []', () => {
  const tables = { matrix: baseMatrix(), gates: baseGates() };
  assert.deepEqual(replayDecisions([], tables), []);
  assert.deepEqual(replayDecisions(null, tables), []);
  assert.deepEqual(replayDecisions('nope', tables), []);
});

test('non-decision events and non-object entries replay to []', () => {
  const h = [
    { type: 'owner-claimed', feature: FEATURE },
    { type: 'architecture-approved', feature: FEATURE, role: 'architect' },
    null,
    42,
    { type: 'wave-attempt', feature: FEATURE, data: {} },
  ];
  assert.deepEqual(
    replayDecisions(h, { matrix: baseMatrix(), gates: baseGates() }),
    [],
  );
});

test('replay emits matrix and gate decisions with expected shape', () => {
  const d = replayDecisions(history(), { matrix: baseMatrix(), gates: baseGates() });
  assert.deepEqual(d, [
    { kind: 'gate', feature: FEATURE, index: 1, gate: 'approved', passed: true },
    { kind: 'matrix', feature: FEATURE, index: 2, wave: 1, attempt: 1, outcome: 'fail-tests', action: 'retry' },
    { kind: 'matrix', feature: FEATURE, index: 3, wave: 1, attempt: 2, outcome: 'success', action: 'advance' },
  ]);
});

test('identical tables produce an empty diff', () => {
  const h = history();
  const a = replayDecisions(h, { matrix: baseMatrix(), gates: baseGates() });
  const b = replayDecisions(h, { matrix: baseMatrix(), gates: baseGates() });
  assert.deepEqual(diffDecisions(a, b), []);
});

test('changing fail-tests retry→abort surfaces the divergence', () => {
  const h = history();
  const proposed = baseMatrix();
  proposed.implement['fail-tests'] = { action: 'abort' };
  const diff = diffDecisions(
    replayDecisions(h, { matrix: baseMatrix(), gates: baseGates() }),
    replayDecisions(h, { matrix: proposed, gates: baseGates() }),
  );
  assert.deepEqual(diff, [
    {
      key: `${FEATURE}|matrix|2|`,
      feature: FEATURE,
      kind: 'matrix',
      index: 2,
      detail: 'wave 1 attempt 1 outcome fail-tests',
      base: 'retry',
      proposed: 'abort',
    },
  ]);
});

test('outcome missing from proposed table becomes a throws: divergence', () => {
  const h = history();
  const proposed = baseMatrix();
  delete proposed.implement.success;
  let diff;
  assert.doesNotThrow(() => {
    diff = diffDecisions(
      replayDecisions(h, { matrix: baseMatrix(), gates: baseGates() }),
      replayDecisions(h, { matrix: proposed, gates: baseGates() }),
    );
  });
  assert.equal(diff.length, 1);
  assert.equal(diff[0].base, 'advance');
  assert.match(diff[0].proposed, /^throws: No stop-condition entry/);
});

test('gate removed from proposed table (gateNames union) → throws: divergence', () => {
  const h = history();
  const base = baseGates();
  const proposed = {};
  const gateNames = gateNameUnion(base, proposed);
  assert.deepEqual(gateNames, ['approved']);
  const diff = diffDecisions(
    replayDecisions(h, { matrix: baseMatrix(), gates: base, gateNames }),
    replayDecisions(h, { matrix: baseMatrix(), gates: proposed, gateNames }),
  );
  assert.equal(diff.length, 1);
  assert.equal(diff[0].kind, 'gate');
  assert.equal(diff[0].gate, 'approved');
  assert.equal(diff[0].detail, 'gate approved');
  assert.equal(diff[0].base, true);
  assert.match(diff[0].proposed, /^throws: No gate rule declared/);
});

test('gate is evaluated only on history before each deliver-started', () => {
  const h = [started, approved, started];
  const d = replayDecisions(h, { matrix: baseMatrix(), gates: baseGates() });
  assert.deepEqual(
    d.map((x) => [x.index, x.passed]),
    [[0, false], [2, true]],
  );
});

test('one-sided key reports the missing side as absent', () => {
  const only = [{ kind: 'gate', feature: FEATURE, index: 0, gate: 'g', passed: false }];
  const diff = diffDecisions(only, []);
  assert.equal(diff[0].base, false);
  assert.equal(diff[0].proposed, 'absent');
  assert.equal(diffDecisions([], only)[0].base, 'absent');
});

test('diff order is deterministic: feature, then index, then gate', () => {
  const mk = (feature, index, gate) => ({ kind: 'gate', feature, index, gate, passed: true });
  const base = [mk('b', 0, 'x'), mk('a', 5, 'z'), mk('a', 5, 'y'), mk('a', 1, 'x')];
  const expected = ['a|gate|1|x', 'a|gate|5|y', 'a|gate|5|z', 'b|gate|0|x'];
  assert.deepEqual(diffDecisions(base, []).map((e) => e.key), expected);
  assert.deepEqual(diffDecisions([...base].reverse(), []).map((e) => e.key), expected);
});

test('gateNameUnion is sorted, unique, and tolerates absent tables', () => {
  assert.deepEqual(gateNameUnion({ b: 1, a: 1 }, { a: 1, c: 1 }), ['a', 'b', 'c']);
  assert.deepEqual(gateNameUnion(undefined, null), []);
});

test('real matrix.yaml + gates.yaml replay against themselves with no diff', () => {
  const tables = { matrix: loadMatrix(), gates: loadGates() };
  const h = history();
  const d = replayDecisions(h, tables);
  assert.ok(d.some((x) => x.kind === 'gate' && x.passed === true));
  assert.ok(d.every((x) => x.kind !== 'matrix' || !String(x.action).startsWith('throws:')));
  assert.deepEqual(diffDecisions(d, replayDecisions(h, tables)), []);
});
