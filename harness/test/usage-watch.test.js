import { test } from 'node:test';
import assert from 'node:assert/strict';

import { warnOnUnmeteredBudget } from '../usage-watch.js';

const recorder = () => {
  const lines = [];
  return { lines, write: (line) => lines.push(line) };
};

test('warnOnUnmeteredBudget — unarmed returns the same function untouched', () => {
  const runWave = async () => ({ outcome: 'success' });
  const { write } = recorder();
  assert.equal(warnOnUnmeteredBudget(runWave, { armed: false, write }), runWave);
});

test('warnOnUnmeteredBudget — armed with a usage-reporting wave writes nothing', async () => {
  const { lines, write } = recorder();
  const watched = warnOnUnmeteredBudget(async () => ({ outcome: 'success', usage: { total: 5 } }), { armed: true, write });
  await watched({ n: 1 }, {});
  assert.deepEqual(lines, []);
});

test('warnOnUnmeteredBudget — usage-less waves write exactly one line however many follow', async () => {
  const { lines, write } = recorder();
  const watched = warnOnUnmeteredBudget(async () => ({ outcome: 'success' }), { armed: true, write });
  for (const n of [1, 2, 3, 4]) await watched({ n }, {});
  assert.equal(lines.length, 1);
  assert.ok(lines[0].endsWith('\n') && lines[0].split('\n').length === 2, 'a single line');
});

test('warnOnUnmeteredBudget — the line names the variable and the wave', async () => {
  const { lines, write } = recorder();
  const watched = warnOnUnmeteredBudget(async () => ({ outcome: 'success' }), { armed: true, write });
  await watched({ n: 7 }, {});
  assert.match(lines[0], /RAD_TOKEN_BUDGET/);
  assert.match(lines[0], /wave 7\b/);
});

test('warnOnUnmeteredBudget — the first wave to lack usage is the one named, after reporting waves', async () => {
  const { lines, write } = recorder();
  const results = [{ usage: { total: 1 } }, {}, {}];
  const watched = warnOnUnmeteredBudget(async () => results.shift(), { armed: true, write });
  for (const n of [1, 2, 3]) await watched({ n }, {});
  assert.equal(lines.length, 1);
  assert.match(lines[0], /wave 2\b/);
});

test('warnOnUnmeteredBudget — the result is returned as the same object', async () => {
  const { write } = recorder();
  const result = { outcome: 'success', tasks: [] };
  const watched = warnOnUnmeteredBudget(async () => result, { armed: true, write });
  assert.equal(await watched({ n: 1 }, {}), result);
});

test('warnOnUnmeteredBudget — wave and planCtx are forwarded to the real runWave', async () => {
  const { write } = recorder();
  const seen = [];
  const watched = warnOnUnmeteredBudget(async (...args) => { seen.push(args); return { usage: { total: 1 } }; }, { armed: true, write });
  const wave = { n: 2 };
  const planCtx = { feature: 'f' };
  await watched(wave, planCtx);
  assert.deepEqual(seen, [[wave, planCtx]]);
});

test('warnOnUnmeteredBudget — a thrown error propagates unchanged and writes no warning', async () => {
  const { lines, write } = recorder();
  const boom = new Error('agent crashed');
  const watched = warnOnUnmeteredBudget(async () => { throw boom; }, { armed: true, write });
  await assert.rejects(() => watched({ n: 1 }, {}), (err) => err === boom);
  assert.deepEqual(lines, []);
});

test('warnOnUnmeteredBudget — null and undefined results warn once and pass through', async () => {
  for (const value of [null, undefined]) {
    const { lines, write } = recorder();
    const watched = warnOnUnmeteredBudget(async () => value, { armed: true, write });
    assert.equal(await watched({ n: 1 }, {}), value);
    await watched({ n: 2 }, {});
    assert.equal(lines.length, 1);
  }
});

test('warnOnUnmeteredBudget — usage null counts as usage-less', async () => {
  const { lines, write } = recorder();
  const watched = warnOnUnmeteredBudget(async () => ({ usage: null }), { armed: true, write });
  await watched({ n: 1 }, {});
  assert.equal(lines.length, 1);
});

test('warnOnUnmeteredBudget — a zero-total usage still counts as reporting usage', async () => {
  const { lines, write } = recorder();
  const watched = warnOnUnmeteredBudget(async () => ({ usage: { input: 0, output: 0, total: 0 } }), { armed: true, write });
  await watched({ n: 1 }, {});
  assert.deepEqual(lines, []);
});

test('warnOnUnmeteredBudget — each wrapper warns independently', async () => {
  const run = async () => ({});
  const a = recorder();
  const b = recorder();
  await warnOnUnmeteredBudget(run, { armed: true, write: a.write })({ n: 1 }, {});
  await warnOnUnmeteredBudget(run, { armed: true, write: b.write })({ n: 1 }, {});
  assert.equal(a.lines.length + b.lines.length, 2);
});

test('warnOnUnmeteredBudget — a wave with no id is named "?"', async () => {
  const { lines, write } = recorder();
  await warnOnUnmeteredBudget(async () => ({}), { armed: true, write })({}, {});
  assert.match(lines[0], /wave \?/);
});
