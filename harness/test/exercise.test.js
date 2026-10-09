import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseExerciseBlock } from '../exercise.js';

const CRITERIA = '## Acceptance Criteria\n1. **One.** first\n2. **Two.** second\n\n';

function plan(exercise) {
  return `# Plan\n\n${CRITERIA}## Exercise\n${exercise}\n## Agent Scope\nnot part of the block\nLaunch: \`nope\`\n`;
}

test('parses a full block', () => {
  const b = parseExerciseBlock(plan(
    'Launch: `npm start`\nDrive: open the page\nObserve (AC#1): a heading shows\nObserve (AC#2): a button works\nTeardown: `rm -f x`\n',
  ));
  assert.equal(b.present, true);
  assert.equal(b.launch, 'npm start');
  assert.equal(b.teardown, 'rm -f x');
  assert.equal(b.drive, 'open the page');
  assert.deepEqual(b.observes, [
    { ac: 1, text: 'a heading shows' },
    { ac: 2, text: 'a button works' },
  ]);
  assert.deepEqual(b.warnings, []);
});

test('empty and non-string input yield an absent block without throwing', () => {
  for (const input of ['', undefined, null, 42, {}, []]) {
    const b = parseExerciseBlock(input);
    assert.equal(b.present, false);
    assert.deepEqual(b.warnings, []);
    assert.deepEqual(b.observes, []);
  }
});

test('a plan with no Exercise section has no warnings', () => {
  const b = parseExerciseBlock(`# Plan\n\n${CRITERIA}## Scope\nx\n`);
  assert.equal(b.present, false);
  assert.deepEqual(b.warnings, []);
});

test('a block with only Drive is absent and warns it will be skipped', () => {
  const b = parseExerciseBlock(plan('Drive: just click around\n'));
  assert.equal(b.present, false);
  assert.equal(b.drive, 'just click around');
  assert.equal(b.warnings.length, 1);
  assert.match(b.warnings[0], /will be skipped/);
});

test('an Observe with no AC records ac null and warns', () => {
  const b = parseExerciseBlock(plan('Observe: something happens\n'));
  assert.equal(b.present, true);
  assert.deepEqual(b.observes, [{ ac: null, text: 'something happens' }]);
  assert.match(b.warnings.join('\n'), /no \(AC#N\)/);
});

test('an AC number absent from the plan warns', () => {
  const b = parseExerciseBlock(plan('Observe (AC#9): ghost\n'));
  assert.equal(b.present, true);
  assert.match(b.warnings.join('\n'), /AC#9/);
});

test('an unknown key warns', () => {
  const b = parseExerciseBlock(plan('Wait: 5s\nObserve (AC#1): ok\n'));
  assert.equal(b.present, true);
  assert.equal(b.warnings.length, 1);
  assert.match(b.warnings[0], /unknown key "Wait:"/);
});

test('the block ends at the next ## heading', () => {
  const b = parseExerciseBlock(plan('Observe (AC#1): ok\n'));
  assert.equal(b.launch, null);
  assert.equal(b.observes.length, 1);
});

test('a #### sub-heading stays inside the block', () => {
  const b = parseExerciseBlock(plan('Launch: `a`\n#### Notes\nObserve (AC#1): after the subheading\n'));
  assert.equal(b.launch, 'a');
  assert.equal(b.observes.length, 1);
});

test('CRLF line endings parse the same', () => {
  const text = plan('Launch: `npm start`\nObserve (AC#1): ok\n').replace(/\n/g, '\r\n');
  const b = parseExerciseBlock(text);
  assert.equal(b.launch, 'npm start');
  assert.deepEqual(b.observes, [{ ac: 1, text: 'ok' }]);
  assert.deepEqual(b.warnings, []);
});

test('an empty Launch or Teardown warns and stays null', () => {
  const b = parseExerciseBlock(plan('Launch:\nTeardown: ``\nObserve (AC#1): ok\n'));
  assert.equal(b.launch, null);
  assert.equal(b.teardown, null);
  assert.equal(b.warnings.length, 2);
});

test('prose lines with colons that are not Key: lines are ignored', () => {
  const b = parseExerciseBlock(plan('see http://x.y for more: info\nObserve (AC#1): ok\n'));
  assert.deepEqual(b.warnings, []);
});

// ---------------------------------------------------------------------------
// Isolated recipe runner
// ---------------------------------------------------------------------------

import { startLaunch, stopGroup, runTeardown, withDetachedWorktree, exerciseWorktreeName } from '../exercise.js';

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (cond, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
};
const quiet = () => {};

test('stopGroup kills a grandchild spawned by Launch', async () => {
  const launch = startLaunch({ command: 'sleep 300 & echo gc=$!; wait', cwd: process.cwd() });
  await until(() => /gc=\d+/.test(launch.tail()));
  const gc = Number(/gc=(\d+)/.exec(launch.tail())[1]);
  assert.equal(alive(gc), true);
  await stopGroup(launch, { killGraceMs: 2000, log: quiet });
  await launch.exited;
  await until(() => !alive(gc));
  assert.equal(alive(gc), false);
});

test('stopGroup escalates to SIGKILL when SIGTERM is ignored', async () => {
  const launch = startLaunch({ command: "trap '' TERM; echo ready; while :; do sleep 1; done", cwd: process.cwd() });
  await until(() => /ready/.test(launch.tail()));
  await stopGroup(launch, { killGraceMs: 200, log: quiet });
  const r = await launch.exited;
  assert.equal(r.signal, 'SIGKILL');
});

test('a Launch that exits 0 immediately resolves exited with code 0', async () => {
  const launch = startLaunch({ command: 'echo hi', cwd: process.cwd() });
  const r = await launch.exited;
  assert.equal(r.code, 0);
  assert.match(launch.tail(), /hi/);
  assert.equal(launch.hasExited(), true);
  await stopGroup(launch, { killGraceMs: 100, log: quiet }); // no-op on a dead group
});

test('a Launch that exits non-zero reports its code and output tail', async () => {
  const launch = startLaunch({ command: 'echo boom >&2; exit 3', cwd: process.cwd() });
  const r = await launch.exited;
  assert.equal(r.code, 3);
  assert.match(launch.tail(), /boom/);
});

test('a Launch that never exits stays running until stopGroup', async () => {
  const launch = startLaunch({ command: 'while :; do sleep 1; done', cwd: process.cwd() });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(launch.hasExited(), false);
  await stopGroup(launch, { killGraceMs: 2000, log: quiet });
  const r = await launch.exited;
  assert.equal(r.signal, 'SIGTERM');
});

test('a spawn failure resolves exited with an error instead of throwing', async () => {
  const launch = startLaunch({ command: 'true', cwd: '/nonexistent-dir-for-exercise-test' });
  const r = await launch.exited;
  assert.ok(r.error);
  assert.equal(r.code, null);
  await stopGroup(launch, { log: quiet });
});

test('stopGroup tolerates a missing pid', async () => {
  await stopGroup(undefined, { log: quiet });
  await stopGroup({ pid: undefined }, { log: quiet });
});

test('a parent-env secret is invisible to Launch and Teardown', async () => {
  process.env.RAD_EXERCISE_TEST_SECRET = 's3cret';
  try {
    const launch = startLaunch({ command: 'echo "v=[${RAD_EXERCISE_TEST_SECRET}]"', cwd: process.cwd() });
    await launch.exited;
    assert.match(launch.tail(), /v=\[\]/);
    const t = runTeardown({ command: 'echo "v=[${RAD_EXERCISE_TEST_SECRET}]"', cwd: process.cwd(), log: quiet });
    assert.equal(t.ok, true);
    assert.match(t.output, /v=\[\]/);
  } finally {
    delete process.env.RAD_EXERCISE_TEST_SECRET;
  }
});

test('a failing Teardown is logged with its exit code and never throws', () => {
  const logs = [];
  const t = runTeardown({ command: 'echo nope >&2; exit 7', cwd: process.cwd(), log: (m) => logs.push(m) });
  assert.equal(t.ok, false);
  assert.equal(t.code, 7);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /teardown failed \(exit code 7\)/);
});

test('a null/empty Teardown is a no-op success', () => {
  for (const command of [null, '', undefined]) {
    assert.deepEqual(runTeardown({ command, cwd: process.cwd(), log: quiet }), { ok: true, code: 0, output: '' });
  }
});

test('withDetachedWorktree creates at the tip SHA and removes after success', async () => {
  const calls = [];
  const worktree = {
    create: (n, ref) => { calls.push(['create', n, ref]); return '/tmp/wt'; },
    complete: (n, d) => { calls.push(['complete', n, d]); },
  };
  const out = await withDetachedWorktree({ worktree, feature: 'f', tip: 'abc123', fn: async (d) => d, log: quiet });
  assert.equal(out, '/tmp/wt');
  assert.deepEqual(calls, [['create', 'exercise-f', 'abc123'], ['complete', 'exercise-f', '/tmp/wt']]);
  assert.equal(exerciseWorktreeName('f'), 'exercise-f');
});

test('withDetachedWorktree removes the worktree after fn fails and rethrows', async () => {
  const calls = [];
  const worktree = { create: () => '/tmp/wt', complete: () => { calls.push('complete'); } };
  await assert.rejects(
    withDetachedWorktree({ worktree, feature: 'f', tip: 'x', fn: async () => { throw new Error('agent died'); }, log: quiet }),
    /agent died/,
  );
  assert.deepEqual(calls, ['complete']);
});

test('a worktree removal failure is logged and does not mask the result', async () => {
  const logs = [];
  const worktree = { create: () => '/tmp/wt', complete: () => { throw new Error('dirty'); } };
  const out = await withDetachedWorktree({ worktree, feature: 'f', tip: 'x', fn: async () => 'ok', log: (m) => logs.push(m) });
  assert.equal(out, 'ok');
  assert.match(logs[0], /worktree removal failed: dirty/);
});

test('a worktree create failure propagates without attempting removal', async () => {
  const calls = [];
  const worktree = { create: () => { throw new Error('no branch'); }, complete: () => calls.push('complete') };
  await assert.rejects(withDetachedWorktree({ worktree, feature: 'f', tip: 'x', fn: async () => 1, log: quiet }), /no branch/);
  assert.deepEqual(calls, []);
});
