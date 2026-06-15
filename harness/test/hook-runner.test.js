import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHookRunner } from '../hook-runner.js';

/**
 * Build a fake `sh` from a map of `hookPath → { status, stdout }`. Records every
 * invocation (path + argv + env) so tests can assert ordering and arguments.
 * Mirrors the spine.test.js style of injecting a recording fake rather than
 * executing real scripts.
 */
function makeFakeSh(responses) {
  const calls = [];
  const sh = (file, args, opts) => {
    calls.push({ file, args, env: opts && opts.env });
    const r = responses[file];
    if (typeof r === 'function') return r();
    return r ?? { status: 0, stdout: '', stderr: '' };
  };
  return { sh, calls };
}

/** A discover that returns a fixed, already-sorted script list per point. */
function discoverOf(map) {
  return (_hooksDir, point) => map[point] ?? [];
}

const fixedClock = () => {
  let i = 0;
  return () => `t${i++}`;
};

test('(a) absent hooks dir → no-op neutral result', () => {
  // discover returns [] for every point → nothing runs.
  const { sh, calls } = makeFakeSh({});
  const runner = createHookRunner({ sh, now: fixedClock(), discover: () => [] });
  const result = runner.runHooks('post-wave', { feature: 'demo', wave: 1 });
  assert.deepEqual(result, { point: 'post-wave', ran: [], veto: null, failures: [] });
  assert.equal(calls.length, 0); // sh never invoked
});

test('(b) lexical filename ordering of multiple scripts at a point', () => {
  // Real defaultDiscover sorts; here we hand the runner a pre-sorted list and
  // assert the runner preserves it (runs in the order discovery returns).
  const scripts = ['hooks/post-wave/10-a.sh', 'hooks/post-wave/20-b.sh', 'hooks/post-wave/30-c.sh'];
  const responses = Object.fromEntries(scripts.map((s) => [s, { status: 0, stdout: 'success' }]));
  const { sh, calls } = makeFakeSh(responses);
  const runner = createHookRunner({ sh, discover: discoverOf({ 'post-wave': scripts }) });
  const result = runner.runHooks('post-wave', { feature: 'demo', wave: 2, outcome: 'success' });
  assert.deepEqual(calls.map((c) => c.file), scripts);
  assert.equal(result.veto, null);
  // argv contract: $1=feature $2=wave $3=point $4=current-outcome.
  assert.deepEqual(calls[0].args, ['demo', '2', 'post-wave', 'success']);
  // RAD_HOOK_* env present.
  assert.equal(calls[0].env.RAD_HOOK_FEATURE, 'demo');
  assert.equal(calls[0].env.RAD_HOOK_POINT, 'post-wave');
});

test('(c) observe-class non-zero exit → fail-open: hook-failed signal, flow unchanged, no veto', () => {
  const scripts = ['hooks/on-error/notify.sh'];
  const { sh } = makeFakeSh({ 'hooks/on-error/notify.sh': { status: 3, stdout: 'boom' } });
  const runner = createHookRunner({ sh, discover: discoverOf({ 'on-error': scripts }) });
  const result = runner.runHooks('on-error', { feature: 'demo', wave: 1, outcome: 'fail-tests' });
  assert.equal(result.veto, null); // never vetoes
  assert.equal(result.ran.length, 1);
  assert.equal(result.ran[0].vetoed, false);
  assert.deepEqual(result.failures, [{ hook: 'hooks/on-error/notify.sh', reason: 'exit 3' }]);
});

test('(c2) observe-class hook that throws → fail-open failure, still no veto', () => {
  const scripts = ['hooks/wave-complete/log.sh'];
  const sh = () => {
    throw new Error('spawn failed');
  };
  const runner = createHookRunner({ sh, discover: discoverOf({ 'wave-complete': scripts }) });
  const result = runner.runHooks('wave-complete', { feature: 'demo', wave: 1 });
  assert.equal(result.veto, null);
  assert.equal(result.failures[0].reason, 'threw');
});

test('(d) veto-class hook returning a valid token → veto with that outcome', () => {
  const scripts = ['hooks/post-wave/gate.sh'];
  const { sh } = makeFakeSh({ 'hooks/post-wave/gate.sh': { status: 0, stdout: 'fail-scope\n' } });
  const runner = createHookRunner({ sh, discover: discoverOf({ 'post-wave': scripts }) });
  const result = runner.runHooks('post-wave', { feature: 'demo', wave: 1, outcome: 'success' });
  assert.deepEqual(result.veto, { hook: 'hooks/post-wave/gate.sh', outcome: 'fail-scope' });
  assert.equal(result.ran[0].vetoed, true);
  assert.equal(result.ran[0].outcome, 'fail-scope');
});

test('(d2) veto-class clean exit with token "success" → explicit pass, no veto', () => {
  const scripts = ['hooks/pre-wave/ok.sh'];
  const { sh } = makeFakeSh({ 'hooks/pre-wave/ok.sh': { status: 0, stdout: 'success' } });
  const runner = createHookRunner({ sh, discover: discoverOf({ 'pre-wave': scripts }) });
  const result = runner.runHooks('pre-wave', { feature: 'demo', wave: 1 });
  assert.equal(result.veto, null);
  assert.equal(result.ran[0].vetoed, false);
  assert.equal(result.ran[0].outcome, 'success');
});

test('(e) veto-class crash → fail-closed veto (abort-user)', () => {
  const scripts = ['hooks/pre-wave/x.sh'];
  const sh = () => {
    throw new Error('hook crashed');
  };
  const runner = createHookRunner({ sh, discover: discoverOf({ 'pre-wave': scripts }) });
  const result = runner.runHooks('pre-wave', { feature: 'demo', wave: 1 });
  assert.deepEqual(result.veto, { hook: 'hooks/pre-wave/x.sh', outcome: 'abort-user' });
  assert.equal(result.failures[0].reason, 'threw');
});

test('(e2) veto-class empty stdout → fail-closed veto (abort-user)', () => {
  const scripts = ['hooks/post-wave/silent.sh'];
  const { sh } = makeFakeSh({ 'hooks/post-wave/silent.sh': { status: 0, stdout: '' } });
  const runner = createHookRunner({ sh, discover: discoverOf({ 'post-wave': scripts }) });
  const result = runner.runHooks('post-wave', { feature: 'demo', wave: 1 });
  assert.deepEqual(result.veto, { hook: 'hooks/post-wave/silent.sh', outcome: 'abort-user' });
  assert.equal(result.failures[0].reason, 'empty-stdout');
});

test('(e3) veto-class out-of-vocabulary token → fail-closed veto (abort-user)', () => {
  const scripts = ['hooks/post-wave/typo.sh'];
  const { sh } = makeFakeSh({ 'hooks/post-wave/typo.sh': { status: 0, stdout: 'kinda-failed' } });
  const runner = createHookRunner({ sh, discover: discoverOf({ 'post-wave': scripts }) });
  const result = runner.runHooks('post-wave', { feature: 'demo', wave: 1 });
  assert.deepEqual(result.veto, { hook: 'hooks/post-wave/typo.sh', outcome: 'abort-user' });
  assert.equal(result.failures[0].reason, 'bad-token:kinda-failed');
});

test('(e4) veto-class non-zero exit → fail-closed veto (abort-user)', () => {
  const scripts = ['hooks/post-wave/fails.sh'];
  const { sh } = makeFakeSh({ 'hooks/post-wave/fails.sh': { status: 2, stdout: 'whatever' } });
  const runner = createHookRunner({ sh, discover: discoverOf({ 'post-wave': scripts }) });
  const result = runner.runHooks('post-wave', { feature: 'demo', wave: 1 });
  assert.deepEqual(result.veto, { hook: 'hooks/post-wave/fails.sh', outcome: 'abort-user' });
  assert.equal(result.failures[0].reason, 'exit 2');
});

test('(f) first-veto-wins: remaining scripts at the point do not run', () => {
  const scripts = ['hooks/post-wave/1-veto.sh', 'hooks/post-wave/2-after.sh'];
  const { sh, calls } = makeFakeSh({
    'hooks/post-wave/1-veto.sh': { status: 0, stdout: 'fail-tests' },
    'hooks/post-wave/2-after.sh': { status: 0, stdout: 'success' },
  });
  const runner = createHookRunner({ sh, discover: discoverOf({ 'post-wave': scripts }) });
  const result = runner.runHooks('post-wave', { feature: 'demo', wave: 1 });
  assert.deepEqual(result.veto, { hook: 'hooks/post-wave/1-veto.sh', outcome: 'fail-tests' });
  // Short-circuited: only the first script ran.
  assert.deepEqual(calls.map((c) => c.file), ['hooks/post-wave/1-veto.sh']);
  assert.equal(result.ran.length, 1);
});

test('(g) provenance fields present in the runner result', () => {
  const scripts = ['hooks/post-wave/gate.sh'];
  const { sh } = makeFakeSh({ 'hooks/post-wave/gate.sh': { status: 0, stdout: 'no-changes' } });
  const runner = createHookRunner({ sh, discover: discoverOf({ 'post-wave': scripts }) });
  const result = runner.runHooks('post-wave', { feature: 'demo', wave: 1 });
  // The result names the point and the vetoing hook+outcome — the provenance the
  // spine folds into a hook-veto event ({ point, hook, outcome, source:'hook' }).
  assert.equal(result.point, 'post-wave');
  assert.equal(result.veto.hook, 'hooks/post-wave/gate.sh');
  assert.equal(result.veto.outcome, 'no-changes');
  assert.equal(result.ran[0].hook, 'hooks/post-wave/gate.sh');
});

test('(h) unknown point → neutral no-op (runner does not police the vocabulary)', () => {
  const { sh, calls } = makeFakeSh({});
  const runner = createHookRunner({ sh, discover: discoverOf({ bogus: ['x.sh'] }) });
  const result = runner.runHooks('bogus', { feature: 'demo' });
  assert.deepEqual(result, { point: 'bogus', ran: [], veto: null, failures: [] });
  assert.equal(calls.length, 0);
});
