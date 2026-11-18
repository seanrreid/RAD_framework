import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listFeatures, readHistory, readAllHistory, readHistories, DEFAULT_STATE_DIR, EVENT_LOG } from '../insights-state.js';

const makeTmp = () => mkdtempSync(join(tmpdir(), 'insights-state-'));

/** A state dir with one feature whose events.jsonl holds `body` verbatim. */
function stateDirWithLog(body, feature = 'f') {
  const dir = makeTmp();
  mkdirSync(join(dir, feature));
  writeFileSync(join(dir, feature, EVENT_LOG), body);
  return dir;
}

test('exports the default state dir and log name', () => {
  assert.equal(DEFAULT_STATE_DIR, join('.agents', 'state'));
  assert.equal(EVENT_LOG, 'events.jsonl');
});

test('listFeatures: missing state dir -> []', () => {
  assert.deepEqual(listFeatures(join(makeTmp(), 'absent')), []);
});

test('listFeatures: sorted, skips dirs without a log and plain files', () => {
  const dir = makeTmp();
  for (const f of ['b', 'a']) {
    mkdirSync(join(dir, f));
    writeFileSync(join(dir, f, EVENT_LOG), '');
  }
  mkdirSync(join(dir, 'nolog'));
  writeFileSync(join(dir, 'stray.txt'), 'x');
  assert.deepEqual(listFeatures(dir), ['a', 'b']);
});

test('readHistory: empty events.jsonl -> []', () => {
  assert.deepEqual(readHistory(stateDirWithLog(''), 'f'), []);
});

test('readHistory: parses valid lines, ignores blank lines', () => {
  const dir = stateDirWithLog('{"type":"a"}\n\n{"type":"b","data":{"n":0}}\n');
  assert.deepEqual(readHistory(dir, 'f'), [{ type: 'a' }, { type: 'b', data: { n: 0 } }]);
});

test('readHistory: event missing fields and zero/non-array fields pass through unchanged', () => {
  const dir = stateDirWithLog('{}\n{"type":"x","data":{"count":0,"list":"nope"}}\n');
  assert.deepEqual(readHistory(dir, 'f'), [{}, { type: 'x', data: { count: 0, list: 'nope' } }]);
});

test('readHistory: valid-JSON null line throws naming file and line', () => {
  const dir = stateDirWithLog('{"type":"a"}\nnull\n');
  assert.throws(() => readHistory(dir, 'f'), (err) => {
    assert.match(err.message, /events\.jsonl:2/);
    assert.match(err.message, /not a JSON object/);
    return true;
  });
});

test('readHistory: number, array and string lines also throw', () => {
  for (const bad of ['5', '[1]', '"s"', '0']) {
    assert.throws(() => readHistory(stateDirWithLog(`${bad}\n`), 'f'), /events\.jsonl:1/, bad);
  }
});

test('readHistory: malformed JSON still throws', () => {
  assert.throws(() => readHistory(stateDirWithLog('{oops\n'), 'f'), SyntaxError);
});

test('readAllHistory: missing state dir -> []', () => {
  assert.deepEqual(readAllHistory(join(makeTmp(), 'nope')), []);
});

test('readAllHistory: empty events.jsonl contributes nothing', () => {
  assert.deepEqual(readAllHistory(stateDirWithLog('')), []);
});

test('readAllHistory: concatenates in sorted-feature order', () => {
  const dir = stateDirWithLog('{"n":"b1"}\n{"n":"b2"}\n', 'b-feat');
  mkdirSync(join(dir, 'a-feat'));
  writeFileSync(join(dir, 'a-feat', EVENT_LOG), '{"n":"a1"}\n');
  assert.deepEqual(readAllHistory(dir).map((e) => e.n), ['a1', 'b1', 'b2']);
});

test('readAllHistory: valid-JSON null line throws the named error', () => {
  const dir = stateDirWithLog('{"type":"a"}\nnull\n');
  assert.throws(() => readAllHistory(dir), /events\.jsonl:2: event is not a JSON object/);
});

test('readHistories: missing state dir -> {}', () => {
  assert.deepEqual(readHistories(join(makeTmp(), 'nope')), {});
});

test('readHistories: empty log -> feature present with []', () => {
  assert.deepEqual(readHistories(stateDirWithLog('')), { f: [] });
});

test('readHistories: dir without a log is skipped', () => {
  const dir = stateDirWithLog('{"n":1}\n');
  mkdirSync(join(dir, 'no-log'));
  assert.deepEqual(readHistories(dir), { f: [{ n: 1 }] });
});

test('readHistories: keys sorted regardless of creation order', () => {
  const dir = stateDirWithLog('{"n":"b"}\n', 'b-feat');
  mkdirSync(join(dir, 'a-feat'));
  writeFileSync(join(dir, 'a-feat', EVENT_LOG), '{"n":"a"}\n');
  const out = readHistories(dir);
  assert.deepEqual(Object.keys(out), ['a-feat', 'b-feat']);
  assert.deepEqual(out['a-feat'], [{ n: 'a' }]);
});

test('readHistories: malformed line throws', () => {
  assert.throws(() => readHistories(stateDirWithLog('{oops\n')), SyntaxError);
});

test('readHistories: JSON null line throws naming file and line 1', () => {
  assert.throws(() => readHistories(stateDirWithLog('null\n')), /events\.jsonl:1: event is not a JSON object/);
});

test('readHistories: mixed valid and non-object lines throw at the first bad line', () => {
  const dir = stateDirWithLog('{"n":1}\n[2]\nnull\n');
  assert.throws(() => readHistories(dir), /events\.jsonl:2: event is not a JSON object/);
});
