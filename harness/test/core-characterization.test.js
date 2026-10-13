// Characterization of the gate / transition / hook-runner / worktree modules
// (#252, part 4). Every scenario runs the real module with stubbed boundaries
// (sh, discover, clock) and compares the observed outcome to
// fixtures/core-golden.json, which was generated from the UNMODIFIED modules.
// Regenerate only deliberately:
//   UPDATE_GOLDEN=1 node --test harness/test/core-characterization.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import * as transitionsModule from '../transitions.js';
import * as gatesModule from '../gates.js';
import * as hookModule from '../hook-runner.js';
import * as worktreeModule from '../adapters/worktree.js';

const { validateTransition, TransitionError } = transitionsModule;
const { evaluateGate } = gatesModule;
const { createHookRunner } = hookModule;
const { makeWorktreeLifecycle, readMarker } = worktreeModule;

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = join(HERE, 'fixtures', 'core-golden.json');
const EVENTS_SOURCE = join(HERE, '..', 'events.js');
const UPDATE = process.env.UPDATE_GOLDEN === '1';
const DIR_TOKEN = '<DIR>';
const PARSE_ERROR_TOKEN = '<PARSE-ERROR>';
const UNKNOWN_TYPE = 'unknown-type';
const MIN_KNOWN_EVENT_TYPES = 20;

/** Stable text for any value, keeping `undefined` visible. */
const show = (value) =>
  JSON.stringify(value, (_k, v) => (v === undefined ? '<undefined>' : v)) ?? '<undefined>';

/** Run `fn`; return `ok` (or its value) or a `throw:...` string. */
function outcomeOf(fn, describeThrow) {
  try {
    const value = fn();
    return value === undefined ? 'ok' : `ok:${show(value)}`;
  } catch (err) {
    return describeThrow(err);
  }
}

// ── transitions ────────────────────────────────────────────────────────────

function knownEventTypes() {
  const src = readFileSync(EVENTS_SOURCE, 'utf8');
  const listed = src.match(/e\.g\. ([\s\S]*?)\.\n/)[1];
  const types = [...listed.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
  assert.ok(types.length >= MIN_KNOWN_EVENT_TYPES, 'event type list parsed from the typedef');
  assert.ok(types.includes('run-prepared') && types.includes('approved'));
  return types;
}

const ev = (type, extra = {}) => ({ feature: 'f', type, actor: 'a', ts: 't', ...extra });
const approvedEvent = (fp) => ev('approved', { role: 'architect', ...(fp ? { data: { fingerprint: fp } } : {}) });

/** Histories per phase; `fp` is the prior approval's fingerprint ('' = none). */
function historyFor(phase, fp) {
  const approved = approvedEvent(fp);
  const byPhase = {
    none: [],
    planned: [ev('plan-created')],
    approved: [ev('plan-created'), approved],
    'in-progress': [approved, ev('deliver-started')],
    delivered: [approved, ev('deliver-started'), ev('pr-opened')],
    done: [approved, ev('deliver-started'), ev('pr-opened'), ev('done')],
  };
  return byPhase[phase];
}

const PHASES = ['none', 'planned', 'approved', 'in-progress', 'delivered', 'done'];
const PHASES_WITH_APPROVAL = new Set(['approved', 'in-progress', 'delivered', 'done']);
const describeTransitionThrow = (err) =>
  `throw:${err instanceof TransitionError ? err.rule : err.name}:${err.message}`;

function transitionCases() {
  const cases = {};
  const types = [...knownEventTypes(), UNKNOWN_TYPE];
  for (const type of types) {
    for (const phase of PHASES) {
      const priors = PHASES_WITH_APPROVAL.has(phase) ? ['', 'fp1'] : ['-'];
      for (const prior of priors) {
        for (const evaluator of [false, true]) {
          for (const next of ['', 'fp1', 'fp2']) {
            for (const withRole of [true, false]) {
              const history = historyFor(phase, prior === '-' ? '' : prior);
              if (evaluator) history.push(ev('wave-attempt'));
              const data = next ? { data: { fingerprint: next } } : {};
              const role = withRole ? { role: 'architect' } : {};
              const key = [type, phase, `prior=${prior}`, `eval=${evaluator}`, `next=${next || '-'}`, `role=${withRole}`].join('|');
              cases[key] = outcomeOf(
                () => validateTransition(ev(type, { ...data, ...role }), { history }),
                describeTransitionThrow,
              );
            }
          }
        }
      }
    }
  }
  return cases;
}

function missingStateCases() {
  const cases = {};
  const states = { undefined: undefined, null: null, empty: {}, 'null-history': { history: null } };
  for (const [label, state] of Object.entries(states)) {
    for (const type of [...knownEventTypes(), UNKNOWN_TYPE]) {
      for (const withRole of [true, false]) {
        const event = ev(type, withRole ? { role: 'architect' } : {});
        cases[`${label}|${type}|role=${withRole}`] = outcomeOf(
          () => validateTransition(event, state),
          describeTransitionThrow,
        );
      }
    }
  }
  return cases;
}

function transitionPins() {
  const pins = {};
  const roleless = (type) => ev(type);
  const pairs = {
    'approved-after-done-roleless': [roleless('approved'), historyFor('done', 'fp1')],
    'approved-after-delivered-ok': [approvedEvent('fp2'), historyFor('delivered', 'fp1')],
    'approved-after-delivered-dup': [approvedEvent('fp1'), historyFor('delivered', 'fp1')],
    'approved-after-delivered-roleless': [roleless('approved'), historyFor('delivered', 'fp1')],
    'wave-complete-after-delivered': [ev('wave-complete'), historyFor('delivered', 'fp1')],
    'revision-no-evaluator-planned': [ev('revision-requested'), historyFor('planned', '')],
    'dup-and-roleless': [roleless('approved'), historyFor('approved', 'fp1')],
    'arch-approved-roleless': [roleless('architecture-approved'), historyFor('planned', '')],
  };
  for (const [name, [event, history]] of Object.entries(pairs)) {
    pins[name] = outcomeOf(() => validateTransition(event, { history }), describeTransitionThrow);
  }
  try {
    const event = roleless('approved');
    validateTransition(event, { history: historyFor('done', '') });
  } catch (err) {
    pins['error-shape'] = show({
      name: err.name, isTransitionError: err instanceof TransitionError,
      isError: err instanceof Error, rule: err.rule, hasEvent: err.event?.type,
    });
  }
  pins['error-defaults'] = show(new TransitionError('m'));
  return pins;
}

// ── gates ──────────────────────────────────────────────────────────────────

const GATE_REASON = 'needs an approval';
const RULES = {
  absent: {},
  ok: { approved: { eventType: 'approved', requiredRole: 'architect', condition: 'role-equals', reason: GATE_REASON } },
  'cond-other': { approved: { eventType: 'approved', requiredRole: 'architect', condition: 'other', reason: GATE_REASON } },
  'cond-missing': { approved: { eventType: 'approved', requiredRole: 'architect', reason: GATE_REASON } },
  'empty-rule': { approved: {} },
  'null-valued': { approved: null },
};

const gev = (type, role, extra = {}) => ({ feature: 'f', type, actor: `actor-${role}`, role, ts: 't', ...extra });
const GATE_HISTORIES = {
  empty: [],
  match: [gev('approved', 'architect')],
  'match-recordedBy': [gev('approved', 'architect', { recordedBy: 'proxy' })],
  'match-recordedBy-null': [gev('approved', 'architect', { recordedBy: null })],
  'match-recordedBy-empty': [gev('approved', 'architect', { recordedBy: '' })],
  'null-entries-then-match': [null, undefined, gev('approved', 'architect')],
  'role-mismatch': [gev('approved', 'dev')],
  'type-mismatch': [gev('review', 'architect')],
  'role-lead': [gev('approved', 'lead')],
  'two-matches': [gev('approved', 'architect', { actor: 'first' }), gev('approved', 'architect', { actor: 'second', recordedBy: 'x' })],
  'mismatch-then-match': [gev('approved', 'dev'), gev('approved', 'architect')],
  'only-null': [null],
  'non-array-undefined': undefined,
  'non-array-null': null,
  'non-array-string': 'approved',
  'non-array-object': { type: 'approved', role: 'architect' },
  'non-array-number': 42,
};
const ROLE_OF = {
  none: undefined,
  empty: {},
  identity: { roleOf: (r) => r },
  'lead-to-architect': { roleOf: (r) => (r === 'lead' ? 'architect' : r) },
  'always-dev': { roleOf: () => 'dev' },
  'non-function': { roleOf: 'architect' },
  'undefined-roleOf': { roleOf: undefined },
};
const describeGateThrow = (err) => `throw:${err.name}:${err.message}`;

function gateCases() {
  const cases = {};
  for (const [ruleName, rules] of Object.entries(RULES)) {
    for (const gate of ['approved', 'no-such-gate']) {
      for (const [histName, history] of Object.entries(GATE_HISTORIES)) {
        for (const [roleName, opts] of Object.entries(ROLE_OF)) {
          const key = [ruleName, gate, histName, roleName].join('|');
          cases[key] = outcomeOf(() => evaluateGate(gate, history, rules, opts), describeGateThrow);
        }
      }
    }
  }
  return cases;
}

function defaultRuleCases() {
  const hist = GATE_HISTORIES;
  const calls = {
    'default-empty': () => evaluateGate('approved', hist.empty),
    'default-match': () => evaluateGate('approved', hist.match),
    'default-proxy': () => evaluateGate('approved', hist['match-recordedBy']),
    'default-mismatch': () => evaluateGate('approved', hist['role-mismatch']),
    'default-unknown-gate': () => evaluateGate('nope', hist.match),
    'default-undefined-gates': () => evaluateGate('approved', hist.match, undefined, {}),
    'default-roleOf': () => evaluateGate('approved', hist['role-lead'], undefined, ROLE_OF['lead-to-architect']),
    'default-non-array': () => evaluateGate('approved', null),
  };
  return Object.fromEntries(
    Object.entries(calls).map(([k, fn]) => [k, outcomeOf(fn, describeGateThrow)]),
  );
}

// ── hook runner ────────────────────────────────────────────────────────────

const HOOK_POINTS = ['pre-wave', 'post-wave', 'on-outcome', 'on-retry', 'on-error', 'wave-complete', 'bogus-point'];
const SH_RESULTS = {
  success: { ret: { status: 0, stdout: 'success\n', stderr: '' } },
  'fail-tests': { ret: { status: 0, stdout: 'fail-tests', stderr: '' } },
  'fail-scope': { ret: { status: 0, stdout: 'fail-scope\n', stderr: '' } },
  'fail-protocol': { ret: { status: 0, stdout: 'fail-protocol\n', stderr: '' } },
  'fail-timeout': { ret: { status: 0, stdout: 'fail-timeout\n', stderr: '' } },
  'no-changes': { ret: { status: 0, stdout: 'no-changes\n', stderr: '' } },
  'abort-user': { ret: { status: 0, stdout: 'abort-user\n', stderr: '' } },
  'out-of-vocab': { ret: { status: 0, stdout: 'banana\n', stderr: '' } },
  empty: { ret: { status: 0, stdout: '', stderr: '' } },
  'blank-lines': { ret: { status: 0, stdout: '\n  \n\t\n', stderr: '' } },
  'leading-blank-then-token': { ret: { status: 0, stdout: '\n\n  fail-tests  trailing words\nsuccess', stderr: '' } },
  'success-then-other-line': { ret: { status: 0, stdout: 'success\nfail-tests\n', stderr: '' } },
  'nonzero-with-success': { ret: { status: 2, stdout: 'success\n', stderr: 'boom' } },
  'nonzero-empty': { ret: { status: 127, stdout: '', stderr: '' } },
  threw: { throws: new Error('kaboom') },
  'threw-string': { throws: 'plain string' },
  'threw-null': { throws: null },
  'status-string': { ret: { status: '0', stdout: 'success\n', stderr: '' } },
  'status-missing': { ret: { stdout: 'success\n' } },
  'stdout-number': { ret: { status: 0, stdout: 123, stderr: '' } },
  'stdout-missing': { ret: { status: 0 } },
  'returns-undefined': { ret: undefined },
  'returns-null': { ret: null },
};

/** Stub `sh` replaying a scripted result per call; records every invocation. */
function scriptedSh(script) {
  const calls = [];
  const sh = (...args) => {
    const step = script[calls.length];
    calls.push({ file: args[0], args: args[1], opts: args[2], argc: args.length });
    if (step.throws !== undefined) throw step.throws;
    return step.ret;
  };
  return { sh, calls };
}

function runScenario({ point, results, ctx, runnerOpts = {} }) {
  const hooks = results.map((_r, i) => `/hooks/${point}/h${i}`);
  const discovered = [];
  const discover = (dir, p) => { discovered.push([dir, p]); return hooks; };
  const { sh, calls } = scriptedSh(results.map((name) => SH_RESULTS[name]));
  const runner = createHookRunner({ sh, now: () => 'T', discover, ...runnerOpts });
  const result = ctx === 'omit' ? runner.runHooks(point) : runner.runHooks(point, ctx);
  return show({ result, calls, discovered });
}

function hookSingleCases() {
  const cases = {};
  for (const point of HOOK_POINTS) {
    for (const name of Object.keys(SH_RESULTS)) {
      cases[`${point}|${name}`] = runScenario({ point, results: [name], ctx: { feature: 'feat', wave: 2, outcome: 'success' } });
    }
  }
  return cases;
}

function hookSequenceCases() {
  const cases = {};
  const names = Object.keys(SH_RESULTS);
  for (const point of HOOK_POINTS) {
    for (const first of names) {
      for (const second of names) {
        cases[`${point}|${first}>${second}`] = runScenario({ point, results: [first, second], ctx: {} });
      }
    }
    cases[`${point}|triple-pass-fail-pass`] = runScenario({ point, results: ['success', 'nonzero-empty', 'success'], ctx: {} });
    cases[`${point}|triple-pass-pass-veto`] = runScenario({ point, results: ['success', 'success', 'fail-scope'], ctx: {} });
    cases[`${point}|triple-threw-x-y`] = runScenario({ point, results: ['threw', 'out-of-vocab', 'empty'], ctx: {} });
  }
  return cases;
}

function hookContextCases() {
  const cases = {};
  const ctxs = {
    omit: 'omit',
    empty: {},
    full: { feature: 'feat', wave: 3, outcome: 'fail-tests' },
    'wave-zero': { feature: 'feat', wave: 0, outcome: '' },
    'wave-string': { feature: 7, wave: 'w', outcome: null },
    'null-parts': { feature: null, wave: null, outcome: null },
  };
  for (const point of ['post-wave', 'on-outcome']) {
    for (const [label, ctx] of Object.entries(ctxs)) {
      cases[`${point}|${label}`] = runScenario({ point, results: ['success'], ctx });
    }
  }
  cases['custom-hooksDir'] = runScenario({ point: 'pre-wave', results: ['success'], ctx: {}, runnerOpts: { hooksDir: 'my/hooks' } });
  return cases;
}

function hookDiscoveryCases() {
  const cases = {};
  const sh = () => { throw new Error('sh must not run'); };
  for (const point of HOOK_POINTS) {
    const none = createHookRunner({ sh, discover: () => [] }).runHooks(point, { feature: 'f' });
    cases[`no-scripts|${point}`] = show(none);
  }
  cases['no-opts-unknown-point'] = show(createHookRunner().runHooks('bogus-point'));
  cases['no-sh-default-arg'] = outcomeOf(
    () => createHookRunner({ discover: () => ['/h'] }).runHooks('post-wave', {}),
    (err) => `throw:${err.name}`,
  );
  return cases;
}

/** defaultDiscover is private: exercise it through a real temp hooks dir. */
function realDiscoveryCase() {
  const root = mkdtempSync(join(tmpdir(), 'core-char-hooks-'));
  try {
    const dir = join(root, 'post-wave');
    mkdirSync(join(dir, 'subdir'), { recursive: true });
    const files = { '20-b.sh': 0o755, '10-a.sh': 0o755, '15-noexec.sh': 0o644, '05-group.sh': 0o010 };
    for (const [name, mode] of Object.entries(files)) {
      writeFileSync(join(dir, name), '#!/bin/sh\n');
      chmodSync(join(dir, name), mode);
    }
    const results = {};
    for (const point of ['post-wave', 'pre-wave']) {
      const { sh, calls } = scriptedSh(Array(8).fill({ ret: { status: 0, stdout: 'success\n', stderr: '' } }));
      const out = createHookRunner({ sh, hooksDir: root }).runHooks(point, { feature: 'f', wave: 1 });
      results[point] = { out, calls };
    }
    return show(results).split(root).join(DIR_TOKEN);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function hookExports() {
  return {
    names: Object.keys(hookModule).sort(),
    vocab: [...hookModule.OUTCOME_VOCAB],
    veto: [...hookModule.VETO_POINTS],
    observe: [...hookModule.OBSERVE_POINTS],
    abort: hookModule.VETO_ABORT_OUTCOME,
  };
}

// ── worktree ───────────────────────────────────────────────────────────────

function recordingSh(reply) {
  const calls = [];
  const sh = (...args) => {
    calls.push({ args, argc: args.length });
    return typeof reply === 'function' ? reply(calls.length) : reply;
  };
  return { sh, calls };
}

const SH_REPLIES = {
  'ok-multiline': { status: 0, stdout: 'noise\nmore\n/path/to/wt\n', stderr: '' },
  'ok-single': { status: 0, stdout: '/wt', stderr: '' },
  'ok-padded': { status: 0, stdout: '  \n/wt  \n\n', stderr: '' },
  'ok-empty': { status: 0, stdout: '', stderr: '' },
  'ok-number': { status: 0, stdout: 5, stderr: '' },
  'fail-stderr': { status: 1, stdout: 'out', stderr: 'bad thing' },
  'fail-stdout-only': { status: 2, stdout: 'only out', stderr: '' },
  'fail-no-output': { status: 3, stdout: '', stderr: '' },
  'fail-string-status': { status: '0', stdout: 'x', stderr: '' },
};

function worktreeShCases() {
  const cases = {};
  const ops = {
    create: (wt) => wt.create('feat', 'rad/feat'),
    'complete-nodir': (wt) => wt.complete('feat'),
    'complete-dir': (wt) => wt.complete('feat', '/some/dir'),
    'complete-emptydir': (wt) => wt.complete('feat', ''),
    'preserve-nodir': (wt) => wt.preserve('feat'),
    'preserve-dir': (wt) => wt.preserve('feat', '/some/dir'),
  };
  for (const [replyName, reply] of Object.entries(SH_REPLIES)) {
    for (const [opName, op] of Object.entries(ops)) {
      const { sh, calls } = recordingSh(reply);
      const wt = makeWorktreeLifecycle({ sh, now: () => 'T' });
      const value = outcomeOf(() => op(wt), (err) => `throw:${err.message}`);
      cases[`${replyName}|${opName}`] = show({ value, calls });
    }
  }
  return cases;
}

const MARKER_FILES = {
  absent: null,
  preserved: JSON.stringify({ feature: 'f', status: 'preserved', branch: 'rad/f' }),
  'preserved-pretty': JSON.stringify({ status: 'preserved', extra: { n: [1, 2] } }, null, 4),
  active: JSON.stringify({ feature: 'f', status: 'active' }),
  'status-missing': JSON.stringify({ feature: 'f' }),
  'json-null': 'null',
  'json-string': '"preserved"',
  'json-array': '[]',
  malformed: '{not json',
  empty: '',
};

function withMarkerDir(text, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'core-char-wt-'));
  try {
    if (text !== null) writeFileSync(join(dir, worktreeModule.MARKER_NAME), text);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Message with the dir tokenised and any engine-specific JSON detail removed. */
function describeWorktreeThrow(dir) {
  return (err) => {
    const msg = err.message.split(dir).join(DIR_TOKEN);
    return `throw:${msg.replace(/(malformed [^:]*: ).*$/s, `$1${PARSE_ERROR_TOKEN}`)}`;
  };
}

function markerCases() {
  const cases = {};
  const wtOf = () => makeWorktreeLifecycle({ sh: recordingSh({ status: 0, stdout: '', stderr: '' }).sh, now: () => 'T' });
  for (const [name, text] of Object.entries(MARKER_FILES)) {
    cases[`readMarker|${name}`] = withMarkerDir(text, (dir) =>
      outcomeOf(() => readMarker(dir), describeWorktreeThrow(dir)));
    cases[`reactivate|${name}`] = withMarkerDir(text, (dir) => {
      const value = outcomeOf(() => wtOf().reactivate(dir), describeWorktreeThrow(dir));
      const path = join(dir, worktreeModule.MARKER_NAME);
      const after = existsSync(path) ? readFileSync(path, 'utf8') : null;
      return show({ value: value.split(dir).join(DIR_TOKEN), after });
    });
  }
  cases['readMarker|missing-dir'] = outcomeOf(() => readMarker('/no/such/dir/anywhere'), (e) => `throw:${e.message}`);
  return cases;
}

function worktreeExports() {
  return {
    names: Object.keys(worktreeModule).sort(),
    marker: worktreeModule.MARKER_NAME,
    active: worktreeModule.STATUS_ACTIVE,
    preserved: worktreeModule.STATUS_PRESERVED,
    lifecycleKeys: Object.keys(makeWorktreeLifecycle({ sh: () => ({}), now: () => 'T' })),
    arity: [validateTransition.length, evaluateGate.length, readMarker.length, makeWorktreeLifecycle.length, createHookRunner.length],
  };
}

function surfaceExports() {
  return {
    transitions: Object.keys(transitionsModule).sort(),
    gates: Object.keys(gatesModule).sort(),
    gatesDefaultPath: gatesModule.DEFAULT_GATES_PATH.endsWith('gates.yaml'),
    hooks: hookExports(),
    worktree: worktreeExports(),
  };
}

// ── harness ────────────────────────────────────────────────────────────────

const scenarios = {
  'transitions-cross-product': transitionCases,
  'transitions-missing-state': missingStateCases,
  'transitions-pins': transitionPins,
  'gates-cross-product': gateCases,
  'gates-default-rules': defaultRuleCases,
  'hooks-single': hookSingleCases,
  'hooks-sequences': hookSequenceCases,
  'hooks-context': hookContextCases,
  'hooks-discovery': hookDiscoveryCases,
  'hooks-real-discovery': realDiscoveryCase,
  'worktree-sh': worktreeShCases,
  'worktree-marker': markerCases,
  'public-surface': surfaceExports,
};

const golden = UPDATE || !existsSync(GOLDEN_PATH) ? {} : JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'));
const observedAll = {};

for (const [name, run] of Object.entries(scenarios)) {
  test(`characterization: ${name}`, () => {
    const observed = JSON.parse(JSON.stringify(run()));
    observedAll[name] = observed;
    if (UPDATE) return;
    assert.ok(Object.hasOwn(golden, name), `${name}: no golden entry (run with UPDATE_GOLDEN=1 on the unmodified modules)`);
    assert.deepEqual(observed, golden[name]);
  });
}

test('characterization: golden file and scenarios agree', () => {
  if (UPDATE) {
    mkdirSync(dirname(GOLDEN_PATH), { recursive: true });
    const sorted = Object.fromEntries(Object.keys(observedAll).sort().map((k) => [k, observedAll[k]]));
    writeFileSync(GOLDEN_PATH, `${JSON.stringify(sorted)}\n`, 'utf8');
    return;
  }
  assert.deepEqual(Object.keys(golden).sort(), Object.keys(scenarios).sort());
});
