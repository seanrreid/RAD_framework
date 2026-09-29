/**
 * Invariant registry: validateRegistry error cases, checkAnchors literal-substring
 * semantics, and bypassInventory ordering (invariant-registry-and-replay, AC#2/#3).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REGISTRY_VERSION,
  validateRegistry,
  checkAnchors,
  bypassInventory,
} from '../invariants.js';

const entry = (over = {}) => ({
  id: 'inv-a',
  claim: 'the approved event is the gate',
  authority: 'events.jsonl',
  enforced_by: [{ file: 'harness/gates.js', symbol: 'foldGate' }],
  bypasses: [],
  not_evalable: 'fixture',
  ...over,
});
const doc = (...invariants) => ({ version: REGISTRY_VERSION, invariants });
const hasError = (errors, re) => assert.ok(errors.some((e) => re.test(e)), errors.join('\n'));

test('valid doc and empty invariants are valid', () => {
  assert.deepEqual(validateRegistry(doc(entry())), []);
  assert.deepEqual(validateRegistry(doc()), []);
});

test('non-object inputs return errors without throwing', () => {
  for (const bad of [null, undefined, 42, 'x', [], [doc()]]) {
    hasError(validateRegistry(bad), /doc must be an object/);
  }
});

test('version missing or 2 fails', () => {
  hasError(validateRegistry({ invariants: [] }), /version must be 1/);
  hasError(validateRegistry({ version: 2, invariants: [] }), /version must be 1/);
});

test('invariants not an array fails', () => {
  hasError(validateRegistry({ version: 1 }), /invariants must be an array/);
  hasError(validateRegistry({ version: 1, invariants: {} }), /invariants must be an array/);
});

test('entry not an object names its index', () => {
  hasError(validateRegistry(doc(entry(), 'str')), /invariants\[1\]: entry must be an object/);
});

test('missing or empty id names its index', () => {
  hasError(validateRegistry(doc(entry({ id: undefined }))), /invariants\[0\]: missing id/);
  hasError(validateRegistry(doc(entry({ id: '' }))), /invariants\[0\]: missing id/);
});

test('duplicate id is reported', () => {
  hasError(validateRegistry(doc(entry(), entry())), /inv-a: duplicate id/);
});

test('missing claim and authority name the id', () => {
  hasError(validateRegistry(doc(entry({ claim: undefined }))), /inv-a: missing claim/);
  hasError(validateRegistry(doc(entry({ authority: '' }))), /inv-a: missing authority/);
});

test('enforced_by missing, empty, or not an array fails', () => {
  for (const eb of [undefined, [], 'harness/gates.js']) {
    hasError(validateRegistry(doc(entry({ enforced_by: eb }))), /inv-a: enforced_by must be a non-empty array/);
  }
});

test('enforced_by anchor missing file or symbol fails', () => {
  hasError(validateRegistry(doc(entry({ enforced_by: [{ file: 'a.js' }] }))), /inv-a: enforced_by\[0\]/);
  hasError(validateRegistry(doc(entry({ enforced_by: [{ symbol: 's', file: '' }] }))), /inv-a: enforced_by\[0\]/);
});

test('absent bypasses is "not analyzed"; [] is valid', () => {
  const { bypasses, ...noKey } = entry();
  hasError(validateRegistry(doc(noKey)), /inv-a: bypasses not analyzed \(use \[\] for none\)/);
  assert.deepEqual(validateRegistry(doc(entry({ bypasses: [] }))), []);
});

test('bypasses not an array fails', () => {
  hasError(validateRegistry(doc(entry({ bypasses: null }))), /inv-a: bypasses must be an array/);
});

test('bypass missing id, surface, or guarded fails', () => {
  hasError(validateRegistry(doc(entry({ bypasses: [{ surface: 's', guarded: 'yes' }] }))), /inv-a: bypasses\[0\] requires/);
  hasError(validateRegistry(doc(entry({ bypasses: [{ id: 'b', guarded: 'no' }] }))), /inv-a: bypasses\[0\] requires/);
  hasError(validateRegistry(doc(entry({ bypasses: [{ id: 'b', surface: 's' }] }))), /inv-a: bypasses\[0\] guarded/);
});

test('guarded must be the exact string yes/no (boolean true rejected)', () => {
  for (const g of [true, false, 'Yes', 'maybe']) {
    hasError(validateRegistry(doc(entry({ bypasses: [{ id: 'b', surface: 's', guarded: g }] }))), /guarded must be the string/);
  }
  assert.deepEqual(validateRegistry(doc(entry({ bypasses: [{ id: 'b', surface: 's', guarded: 'no' }] }))), []);
});

const files = {
  'harness/gates.js': 'line1\nline2\nexport function foldGate() {}\n',
  'docs/x.md': 'mentions displaySym here',
};
const readFile = (p) => (p in files ? files[p] : null);

test('checkAnchors passes when symbol present, regardless of position', () => {
  assert.deepEqual(checkAnchors(doc(entry()), readFile), []);
  const moved = { 'harness/gates.js': 'export function foldGate() {}\n\n\n// later' };
  assert.deepEqual(checkAnchors(doc(entry()), (p) => moved[p] ?? null), []);
});

test('checkAnchors missing file names id and file', () => {
  const d = doc(entry({ enforced_by: [{ file: 'nope.js', symbol: 'x' }] }));
  assert.deepEqual(checkAnchors(d, readFile), ['inv-a: nope.js not found']);
});

test('checkAnchors missing symbol names id, file, and symbol', () => {
  const d = doc(entry({ enforced_by: [{ file: 'harness/gates.js', symbol: 'gone' }] }));
  assert.deepEqual(checkAnchors(d, readFile), ['inv-a: symbol not found in harness/gates.js: gone']);
});

test('display_only anchors checked only with both file and symbol', () => {
  const d = doc(entry({
    display_only: [
      { file: 'docs/x.md', symbol: 'missingSym' },
      { file: 'nope.md', note: 'no symbol — skipped' },
      { note: 'prose only — skipped' },
    ],
  }));
  assert.deepEqual(checkAnchors(d, readFile), ['inv-a: symbol not found in docs/x.md: missingSym']);
});

test('checkAnchors returns [] on invalid shape without throwing', () => {
  for (const bad of [null, 7, [], { version: 1 }]) assert.deepEqual(checkAnchors(bad, readFile), []);
});

test('bypassInventory flattens in registry order with fields', () => {
  const d = doc(
    entry({ id: 'a', bypasses: [{ id: 'a1', surface: 's1', guarded: 'yes', note: 'n' }, { id: 'a2', surface: 's2', guarded: 'no' }] }),
    entry({ id: 'b', bypasses: [] }),
    entry({ id: 'c', bypasses: [{ id: 'c1', surface: 's3', guarded: 'no' }] }),
  );
  assert.deepEqual(bypassInventory(d), [
    { invariant: 'a', id: 'a1', surface: 's1', guarded: 'yes', note: 'n' },
    { invariant: 'a', id: 'a2', surface: 's2', guarded: 'no', note: undefined },
    { invariant: 'c', id: 'c1', surface: 's3', guarded: 'no', note: undefined },
  ]);
  assert.deepEqual(bypassInventory(null), []);
});

// Eval-link schema (adversarial-gate-evals AC#9): exactly one of evals / not_evalable.
const withEvals = (evals) => {
  const { not_evalable, ...rest } = entry();
  return { ...rest, evals };
};

test('evals and not_evalable both present is an error', () => {
  hasError(validateRegistry(doc(entry({ evals: ['harness/test/x.test.js'] }))),
    /^inv-a: set exactly one of evals \/ not_evalable \(both present\)$/);
});

test('neither evals nor not_evalable names the id', () => {
  const { not_evalable, ...bare } = entry();
  hasError(validateRegistry(doc(bare)), /^inv-a: eval coverage not recorded \(set evals or not_evalable\)$/);
});

test('evals empty, non-array, or holding a non-string/empty path fails', () => {
  for (const bad of [[], 'harness/test/x.test.js', null, ['ok.js', 7], ['']]) {
    hasError(validateRegistry(doc(withEvals(bad))), /^inv-a: evals must be a non-empty list of paths$/);
  }
});

test('not_evalable empty or non-string fails', () => {
  for (const bad of ['', null, 3, ['reason']]) {
    hasError(validateRegistry(doc(entry({ not_evalable: bad }))), /^inv-a: not_evalable must be a non-empty reason$/);
  }
});

test('valid evals with an existing file passes schema and anchors', () => {
  const d = doc(withEvals(['docs/x.md']));
  assert.deepEqual(validateRegistry(d), []);
  assert.deepEqual(checkAnchors(d, readFile), []);
});

test('checkAnchors missing eval file names id and path', () => {
  const d = doc(withEvals(['docs/x.md', 'harness/test/gone.test.js']));
  assert.deepEqual(checkAnchors(d, readFile), ['inv-a: eval file not found: harness/test/gone.test.js']);
});
