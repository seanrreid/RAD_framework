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

// ---------------------------------------------------------------------------
// exerciseCommand
// ---------------------------------------------------------------------------

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exerciseCommand } from '../exercise.js';

const GOOD_FINDINGS = 'all held\n````rad-findings\n{"findings": []}\n````\n';
const FULL_BLOCK = 'Launch: `echo up`\nDrive: poke it\nObserve (AC#1): it shows\nTeardown: `true`\n';

/** Temp repo with a plan doc; `sh` is a fake that records worktree calls. */
function setup(exercise, { writePlan = true } = {}) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'rad-exercise-'));
  const wtDir = join(repoRoot, 'wt');
  mkdirSync(wtDir);
  mkdirSync(join(repoRoot, '.agents', 'plans'), { recursive: true });
  if (writePlan) writeFileSync(join(repoRoot, '.agents', 'plans', 'feat.md'), plan(exercise));
  const calls = [];
  const sh = (file, args) => {
    calls.push([file, ...args]);
    if (file === 'git') return { status: 0, stdout: 'abc123\n', stderr: '' };
    return { status: 0, stdout: `${wtDir}\n`, stderr: '' };
  };
  return { repoRoot, wtDir, sh, calls };
}

async function run(argv, ctx) {
  const captured = { stdout: '', stderr: '' };
  const originals = { stdout: process.stdout.write, stderr: process.stderr.write };
  for (const name of ['stdout', 'stderr']) {
    process[name].write = function write(chunk, ...rest) {
      if (typeof chunk !== 'string') return originals[name].call(this, chunk, ...rest);
      captured[name] += chunk;
      return true;
    };
  }
  try {
    const code = await exerciseCommand(argv, ctx);
    return { code, ...captured };
  } finally {
    process.stdout.write = originals.stdout;
    process.stderr.write = originals.stderr;
  }
}

const okAgent = async () => ({ agent: { cmd: '/usr/bin/fake-agent --flag', source: 'RAD_AGENT_CMD' } });
const fakeRun = (result, prompts = []) => async (opts) => { prompts.push(opts); return result; };

function ctxFor(s, extra = {}) {
  return {
    repoRoot: s.repoRoot, sh: s.sh, env: {}, resolveAgent: okAgent,
    launchSettleMs: 50, killGraceMs: 200, ...extra,
  };
}

test('usage: no feature, bad option, bad name, extra arg → exit 2', async () => {
  const s = setup(FULL_BLOCK);
  for (const argv of [[], ['--nope'], ['Bad_Name'], ['feat', 'extra']]) {
    const r = await run(argv, ctxFor(s));
    assert.equal(r.code, 2, JSON.stringify(argv));
    assert.match(r.stderr, /Usage: rad exercise/);
  }
  assert.equal(s.calls.length, 0);
});

test('missing plan doc → exit 2 (run and --check), nothing spawned', async () => {
  const s = setup(FULL_BLOCK, { writePlan: false });
  for (const argv of [['feat'], ['feat', '--check']]) {
    const r = await run(argv, ctxFor(s));
    assert.equal(r.code, 2);
    assert.match(r.stderr, /cannot read plan doc/);
  }
  assert.equal(s.calls.length, 0);
});

test('--check prints one warning line per parser warning and exits 0, spawning nothing', async () => {
  const s = setup('Frobnicate: x\nObserve: no ac ref\nObserve (AC#9): unknown ac\n');
  const r = await run(['feat', '--check'], ctxFor(s));
  assert.equal(r.code, 0);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 3);
  assert.ok(lines.every((l) => l.startsWith('warning: ')));
  assert.equal(s.calls.length, 0);
});

test('--check on an absent block prints nothing and exits 0', async () => {
  const s = setup('');
  writeFileSync(join(s.repoRoot, '.agents', 'plans', 'feat.md'), `# Plan\n\n${CRITERIA}`);
  const r = await run(['feat', '--check'], ctxFor(s));
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
});

test('absent block → skipped line, status=skipped, exit 0, no worktree or agent', async () => {
  const s = setup('Launch: `echo up`\n');
  let ran = false;
  const r = await run(['feat'], ctxFor(s, { runCommandPrompt: async () => { ran = true; } }));
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^Exercise: skipped \(no recipe\)\n$/);
  assert.match(r.stderr, /rad exercise: feature=feat status=skipped/);
  assert.equal(ran, false);
  assert.equal(s.calls.length, 0);
});

test('malformed RAD_EXERCISE_TIMEOUT_SECONDS (abc, 0, -5) → exit 2', async () => {
  const s = setup(FULL_BLOCK);
  for (const v of ['abc', '0', '-5']) {
    const r = await run(['feat'], ctxFor(s, { env: { RAD_EXERCISE_TIMEOUT_SECONDS: v } }));
    assert.equal(r.code, 2, v);
    assert.match(r.stderr, /RAD_EXERCISE_TIMEOUT_SECONDS/);
  }
  assert.equal(s.calls.length, 0);
});

test('RAD_EXERCISE_BLOCKING=maybe → exit 2', async () => {
  const s = setup(FULL_BLOCK);
  const r = await run(['feat'], ctxFor(s, { env: { RAD_EXERCISE_BLOCKING: 'maybe' } }));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /RAD_EXERCISE_BLOCKING/);
});

test('no agent configured → agent refusal code propagates (exit 2)', async () => {
  const s = setup(FULL_BLOCK);
  const r = await run(['feat'], ctxFor(s, { resolveAgent: async () => ({ code: 2 }) }));
  assert.equal(r.code, 2);
  assert.equal(s.calls.length, 0);
});

test('success: stdout verbatim, summary line, mode, prompt content, detached SHA, worktree removed', async () => {
  const s = setup(FULL_BLOCK);
  const prompts = [];
  const r = await run(['feat'], ctxFor(s, {
    env: { RAD_EXERCISE_BLOCKING: '1' },
    runCommandPrompt: fakeRun({ ok: true, stdout: GOOD_FINDINGS }, prompts),
  }));
  assert.equal(r.code, 0);
  assert.equal(r.stdout, GOOD_FINDINGS);
  assert.match(r.stderr, /rad exercise: feature=feat agent=RAD_AGENT_CMD executable=fake-agent mode=blocking findings=0\n/);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].repoRoot, s.wtDir);
  assert.match(prompts[0].prompt, /Drive: poke it/);
  assert.match(prompts[0].prompt, /Observe \(AC#1: \*\*One\.\*\* first\): it shows/);
  assert.match(prompts[0].prompt, /"reviewer": "exercise" and "category": "behavior"/);
  const create = s.calls.find((c) => c[1] === 'create');
  assert.deepEqual(create.slice(1, 4), ['create', 'exercise-feat', 'abc123']);
  assert.ok(s.calls.some((c) => c[1] === 'remove' && c[2] === 'exercise-feat'));
});

test('observe-only mode is the default and never changes the exit code', async () => {
  const s = setup(FULL_BLOCK);
  const findings = '````rad-findings\n{"findings":[{"reviewer":"exercise","category":"behavior"}]}\n````';
  for (const v of [undefined, '', '0', 'false']) {
    const r = await run(['feat'], ctxFor(s, {
      env: { RAD_EXERCISE_BLOCKING: v },
      runCommandPrompt: fakeRun({ ok: true, stdout: findings }),
    }));
    assert.equal(r.code, 0);
    assert.match(r.stderr, /mode=observe-only findings=1/);
  }
});

test('agent exits non-zero → exit 1, error= in summary, no findings printed', async () => {
  const s = setup(FULL_BLOCK);
  const r = await run(['feat'], ctxFor(s, {
    runCommandPrompt: fakeRun({ ok: false, stdout: GOOD_FINDINGS, error: 'agent exited with code 3' }),
  }));
  assert.equal(r.code, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /findings=none error="agent exited with code 3"/);
});

test('non-array findings and a missing findings block → exit 1', async () => {
  const s = setup(FULL_BLOCK);
  for (const stdout of ['````rad-findings\n{"findings": "none"}\n````', 'no block here']) {
    const r = await run(['feat'], ctxFor(s, { runCommandPrompt: fakeRun({ ok: true, stdout }) }));
    assert.equal(r.code, 1);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /findings=none error="no parsable rad-findings block"/);
  }
});

test('a secret-looking error value is sanitized in the summary line', async () => {
  const s = setup(FULL_BLOCK);
  const secret = `sk-ant-${'a'.repeat(30)}`;
  const r = await run(['feat'], ctxFor(s, {
    runCommandPrompt: fakeRun({ ok: false, stdout: '', error: `boom ${secret}` }),
  }));
  assert.equal(r.code, 1);
  assert.doesNotMatch(r.stderr, /sk-ant-/);
  assert.match(r.stderr, /\[REDACTED\]/);
});

test('Launch exiting non-zero before the agent runs → exit 1, agent never invoked, teardown ran', async () => {
  const marker = join(tmpdir(), `rad-exercise-td-${process.pid}`);
  const s = setup(`Launch: \`exit 7\`\nObserve (AC#1): x\nTeardown: \`touch ${marker}\`\n`);
  let ran = false;
  const r = await run(['feat'], ctxFor(s, {
    launchSettleMs: 2000,
    runCommandPrompt: async () => { ran = true; return { ok: true, stdout: GOOD_FINDINGS }; },
  }));
  assert.equal(r.code, 1);
  assert.equal(ran, false);
  assert.match(r.stderr, /error="Launch failed: Launch exited with code 7"/);
  assert.ok(existsSync(marker));
  rmSync(marker);
  assert.ok(s.calls.some((c) => c[1] === 'remove'));
});

test('a failing Teardown is logged with its exit code and does not change the exit code', async () => {
  const s = setup('Launch: `echo up`\nObserve (AC#1): x\nTeardown: `exit 4`\n');
  const r = await run(['feat'], ctxFor(s, { runCommandPrompt: fakeRun({ ok: true, stdout: GOOD_FINDINGS }) }));
  assert.equal(r.code, 0);
  assert.match(r.stderr, /teardown failed \(exit code 4\)/);
});

test('branch that cannot be resolved → exit 1 with error', async () => {
  const s = setup(FULL_BLOCK);
  const sh = () => ({ status: 128, stdout: '', stderr: 'fatal' });
  const r = await run(['feat'], ctxFor(s, { sh, runCommandPrompt: fakeRun({ ok: true, stdout: GOOD_FINDINGS }) }));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /error="cannot resolve branch rad\/feat"/);
});
