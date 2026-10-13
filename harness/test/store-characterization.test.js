// Characterization of the Git StateStore (#252, part 3). Every scenario runs the
// real createGitStateStore against a temp repo with a recording stub `sh`, and
// the observed outcome is compared to fixtures/store-golden.json, which was
// generated from the UNMODIFIED store. Regenerate only deliberately:
//   UPDATE_GOLDEN=1 node --test harness/test/store-characterization.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import * as storeModule from '../adapters/git-state-store.js';

const { createGitStateStore } = storeModule;
const GOLDEN_PATH = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'store-golden.json');
const UPDATE = process.env.UPDATE_GOLDEN === '1';
const REPO_TOKEN = '<REPO>';
const TS_TOKEN = '<TS>';
const ISO_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;
const STORE_KEYS = [
  'append', 'history', 'phase', 'plan', 'gate', 'list',
  'recordApproval', 'recordArchitectureApproved', 'recordOwnerClaimed', 'recordOwnerReleased',
];

const normalize = (value, repoRoot) =>
  JSON.parse(JSON.stringify(value ?? null).split(repoRoot).join(REPO_TOKEN));

function collectLogs(repoRoot) {
  const stateDir = join(repoRoot, '.agents', 'state');
  const logs = {};
  if (!existsSync(stateDir)) return logs;
  for (const name of readdirSync(stateDir).sort()) {
    const file = join(stateDir, name, 'events.jsonl');
    if (existsSync(file)) logs[name] = readFileSync(file, 'utf8');
  }
  return logs;
}

function seed(repoRoot, relPath, text) {
  const file = join(repoRoot, relPath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf8');
}

const line = (e) => JSON.stringify(e) + '\n';
const APPROVED = { feature: 'demo', type: 'approved', actor: 'arch', role: 'architect', ts: 't0' };

const PLAN_TEXT = [
  '# Plan', '', '## Acceptance Criteria', '- AC#1: not numbered',
  '1. first criterion', '2. second criterion', '', '## Tasks',
  '### Wave 1', 'x', '### Wave 2', 'y', '', '## Files in Scope',
  '| File | Action |', '|------|--------|', '| a/b.js | edit |', '| c/d.md | new |', '|  | blank |', '',
  '## Other', '3. not in section', '',
].join('\n');

// Each scenario: run(ctx) -> value. ctx: { repoRoot, store(opts), seed(rel, text) }.
const scenarios = {};
const add = (name, run) => { scenarios[name] = run; };

// --- append -----------------------------------------------------------------
add('append/legal-explicit-ts', ({ store }) => store().append({ ...APPROVED }));
add('append/stamps-iso-ts', ({ store }) =>
  store().append({ feature: 'demo', type: 'plan-created', actor: 'dev' }));
add('append/key-order-preserved', ({ store }) =>
  store().append({ ts: 't1', actor: 'dev', type: 'plan-created', feature: 'demo', data: { b: 1, a: 2 } }));
add('append/missing-event', ({ store }) => store().append());
add('append/non-object-event', ({ store }) => store().append('nope'));
add('append/missing-feature', ({ store }) => store().append({ type: 'approved', actor: 'a' }));
add('append/missing-type', ({ store }) => store().append({ feature: 'demo', actor: 'a' }));
add('append/missing-actor', ({ store }) => store().append({ feature: 'demo', type: 'approved' }));
add('append/unsafe-feature', ({ store }) =>
  store().append({ feature: '../evil', type: 'approved', actor: 'a', role: 'architect' }));
add('append/illegal-transition-no-phase', ({ store }) =>
  store().append({ feature: 'demo', type: 'wave-complete', actor: 'harness', ts: 't0' }));
add('append/duplicate-approval', ({ store, seed: s }) => {
  s('.agents/state/demo/events.jsonl', line(APPROVED));
  store().append({ ...APPROVED, ts: 't1' });
});
add('append/post-terminal-event', ({ store, seed: s }) => {
  s('.agents/state/demo/events.jsonl',
    line(APPROVED) + line({ feature: 'demo', type: 'deliver-started', actor: 'h', ts: 't1' }) +
    line({ feature: 'demo', type: 'pr-opened', actor: 'h', ts: 't2' }));
  store().append({ feature: 'demo', type: 'wave-attempt', actor: 'h', ts: 't3' });
});
add('append/hook-event-allowed', ({ store, seed: s }) => {
  s('.agents/state/demo/events.jsonl', line(APPROVED));
  store().append({ feature: 'demo', type: 'hook-observed', actor: 'h', ts: 't1', data: { point: 'p', hook: 'x', outcome: 'ok', source: 'hook' } });
});

// --- history / phase --------------------------------------------------------
const POPULATED = line(APPROVED) + line({ feature: 'demo', type: 'deliver-started', actor: 'h', ts: 't1' });
add('history/empty', ({ store }) => store().history('demo'));
add('history/populated', ({ store, seed: s }) => {
  s('.agents/state/demo/events.jsonl', POPULATED);
  return store().history('demo');
});
add('history/partial-last-line-and-blank', ({ store, seed: s }) => {
  s('.agents/state/demo/events.jsonl', POPULATED + '\n   \n{"feature":"demo","ty');
  return store().history('demo');
});
add('history/unsafe-feature', ({ store }) => store().history('Bad/Name'));
add('phase/empty', ({ store }) => store().phase('demo'));
add('phase/populated', ({ store, seed: s }) => {
  s('.agents/state/demo/events.jsonl', POPULATED);
  return store().phase('demo');
});
add('phase/partial-last-line', ({ store, seed: s }) => {
  s('.agents/state/demo/events.jsonl', line(APPROVED) + '{"feature":');
  return store().phase('demo');
});
add('phase/unsafe-feature', ({ store }) => store().phase('a..b/c'));

// --- plan -------------------------------------------------------------------
add('plan/missing', ({ store }) => store().plan('demo'));
add('plan/full', ({ store, seed: s }) => {
  s('.agents/plans/demo.md', PLAN_TEXT);
  return store().plan('demo');
});
add('plan/empty-doc', ({ store, seed: s }) => {
  s('.agents/plans/demo.md', '');
  return store().plan('demo');
});
add('plan/unsafe-feature', ({ store }) => store().plan('../x'));

// --- gate -------------------------------------------------------------------
add('gate/injected-evaluator-args', async ({ store, seed: s }) => {
  s('.agents/state/demo/events.jsonl', POPULATED);
  const received = [];
  const evaluateGate = (...args) => { received.push(args); return { injected: true }; };
  const s1 = store({ evaluateGate });
  const first = await s1.gate('demo', 'approved');
  const second = await s1.gate('demo', 'deliverable');
  return { first, second, received };
});
add('gate/injected-unsafe-feature', ({ store }) => store({ evaluateGate: () => 1 }).gate('../x', 'approved'));
add('gate/real-before-approval', ({ store }) => store().gate('demo', 'approved'));
add('gate/real-after-approval', async ({ store, seed: s }) => {
  s('.agents/state/demo/events.jsonl', line(APPROVED));
  const st = store();
  return { approved: await st.gate('demo', 'approved'), again: await st.gate('demo', 'approved') };
});

// --- list -------------------------------------------------------------------
function seedListFixture(s) {
  s('.agents/state/only-state/events.jsonl', line({ feature: 'only-state', type: 'plan-created', actor: 'd', ts: 't0' }));
  s('.agents/plans/only-plan.md', '# p\n');
  s('.agents/state/both/events.jsonl', line({ ...APPROVED, feature: 'both' }));
  s('.agents/plans/both.md', '# p\n');
  s('.agents/plans/README.md', '# readme\n');
  s('.agents/plans/Bad_Name.md', '# bad\n');
  s('.agents/plans/notes.txt', 'x');
  s('.agents/state/Unsafe_Dir/events.jsonl', line(APPROVED));
  s('.agents/state/_architecture/events.jsonl', line({ feature: '_architecture', type: 'architecture-approved', actor: 'a', role: 'architect', ts: 't0', data: { slug: 'x' } }));
}
const sortedList = (rows) => [...rows].sort((a, b) => a.feature.localeCompare(b.feature));
add('list/empty-repo', ({ store }) => store().list());
add('list/mixed', ({ store, seed: s }) => {
  seedListFixture(s);
  return sortedList(store().list());
});
add('list/phase-filter-approved', ({ store, seed: s }) => {
  seedListFixture(s);
  return sortedList(store().list({ phase: 'approved' }));
});
add('list/phase-filter-no-match', ({ store, seed: s }) => {
  seedListFixture(s);
  return sortedList(store().list({ phase: 'done' }));
});
add('list/state-dir-without-log', ({ store, repoRoot }) => {
  mkdirSync(join(repoRoot, '.agents', 'state', 'empty-dir'), { recursive: true });
  return store().list();
});

// --- recordApproval ---------------------------------------------------------
const approve = (args) => ({ store }) =>
  store().recordApproval({ feature: 'demo', actor: 'arch', ts: 't0', ...args });
add('recordApproval/bare', approve({}));
add('recordApproval/default-ts-stamped', ({ store }) => store().recordApproval({ feature: 'demo', actor: 'arch' }));
add('recordApproval/evidence', approve({ evidence: { pr: 1, notes: ['a'] } }));
add('recordApproval/fingerprint', approve({ fingerprint: 'abc123' }));
add('recordApproval/evidence-fingerprint', approve({ evidence: { k: 'v' }, fingerprint: 'f' }));
add('recordApproval/waivers-valid', approve({ waivers: [{ id: 'W1', justification: 'because' }] }));
add('recordApproval/waivers-empty', approve({ waivers: [] }));
add('recordApproval/waivers-not-array', approve({ waivers: 'x' }));
add('recordApproval/waivers-bad-entry', approve({ waivers: [{ id: 'W1', justification: 'ok' }, { id: ' ', justification: 'j' }] }));
add('recordApproval/waivers-null-entry', approve({ waivers: [null] }));
add('recordApproval/high-risk-valid', approve({ highRiskPattern: 'src/.*' }));
add('recordApproval/high-risk-blank', approve({ highRiskPattern: '  ' }));
add('recordApproval/high-risk-non-string', approve({ highRiskPattern: 5 }));
add('recordApproval/all-fields', approve({ recordedBy: 'proxy', evidence: { e: 1 }, fingerprint: 'f', waivers: [{ id: 'W', justification: 'j' }], highRiskPattern: 'p' }));
add('recordApproval/recordedBy-proxy', approve({ recordedBy: 'runner@example.com' }));
add('recordApproval/custom-required-role', approve({ requiredRole: 'developer' }));
add('recordApproval/role-check-fails-stdout', ({ store }) =>
  store({ roleStatus: 1, roleStdout: ' not an architect \n' }).recordApproval({ feature: 'demo', actor: 'arch', ts: 't0' }));
add('recordApproval/role-check-fails-stderr', ({ store }) =>
  store({ roleStatus: 126, roleStderr: 'EACCES: boom' }).recordApproval({ feature: 'demo', actor: 'arch', ts: 't0' }));
add('recordApproval/role-check-fails-silent', ({ store }) =>
  store({ roleStatus: 2 }).recordApproval({ feature: 'demo', actor: 'arch', ts: 't0' }));
add('recordApproval/separate-config-root', ({ store }) =>
  store({ configRoot: '/elsewhere/cfg' }).recordApproval({ feature: 'demo', actor: 'arch', ts: 't0' }));
add('recordApproval/missing-feature', ({ store }) => store().recordApproval({ actor: 'arch' }));
add('recordApproval/missing-actor', ({ store }) => store().recordApproval({ feature: 'demo' }));
add('recordApproval/no-args', ({ store }) => store().recordApproval());
add('recordApproval/unsafe-feature-after-role-check', ({ store }) =>
  store().recordApproval({ feature: '../x', actor: 'arch', ts: 't0' }));
add('recordApproval/validation-before-role-check', ({ store }) =>
  store({ roleStatus: 1 }).recordApproval({ feature: 'demo', actor: 'arch', waivers: 'bad' }));
add('recordApproval/duplicate', ({ store, seed: s }) => {
  s('.agents/state/demo/events.jsonl', line(APPROVED));
  store().recordApproval({ feature: 'demo', actor: 'arch', ts: 't9' });
});
add('recordApproval/reapproval-new-fingerprint', ({ store, seed: s }) => {
  s('.agents/state/demo/events.jsonl', line({ ...APPROVED, data: { fingerprint: 'one' } }));
  store().recordApproval({ feature: 'demo', actor: 'arch', ts: 't9', fingerprint: 'two' });
});

// --- recordArchitectureApproved --------------------------------------------
const archArgs = { slug: 'my-slug', onBehalfOf: 'arch', ts: 't0' };
add('recordArchitectureApproved/full', ({ store }) =>
  store().recordArchitectureApproved({ ...archArgs, recordedBy: 'runner', evidence: { r: 1 } }));
add('recordArchitectureApproved/recordedBy-default', ({ store }) =>
  store().recordArchitectureApproved({ ...archArgs }));
add('recordArchitectureApproved/default-ts-stamped', ({ store }) =>
  store().recordArchitectureApproved({ slug: 's', onBehalfOf: 'arch' }));
add('recordArchitectureApproved/evidence', ({ store }) =>
  store().recordArchitectureApproved({ ...archArgs, evidence: { e: [1, 2] } }));
add('recordArchitectureApproved/custom-role', ({ store }) =>
  store().recordArchitectureApproved({ ...archArgs, requiredRole: 'developer' }));
add('recordArchitectureApproved/role-check-fails', ({ store }) =>
  store({ roleStatus: 1, roleStderr: 'nope' }).recordArchitectureApproved({ ...archArgs }));
add('recordArchitectureApproved/missing-slug', ({ store }) =>
  store().recordArchitectureApproved({ onBehalfOf: 'arch' }));
add('recordArchitectureApproved/missing-onBehalfOf', ({ store }) =>
  store().recordArchitectureApproved({ slug: 's' }));
add('recordArchitectureApproved/no-args', ({ store }) => store().recordArchitectureApproved());
add('recordArchitectureApproved/second-sign-off-allowed', ({ store }) => {
  const st = store();
  st.recordArchitectureApproved({ ...archArgs });
  st.recordArchitectureApproved({ ...archArgs, slug: 'other', ts: 't1' });
});

// --- ownership --------------------------------------------------------------
for (const [method, label] of [['recordOwnerClaimed', 'claim'], ['recordOwnerReleased', 'release']]) {
  add(`${method}/explicit-actor`, ({ store }) => store()[method]({ feature: 'demo', actor: 'me@x.io', ts: 't0' }));
  add(`${method}/git-identity`, ({ store }) =>
    store({ gitEmail: ' dev@example.com\n' })[method]({ feature: 'demo', ts: 't0' }));
  add(`${method}/blank-actor-uses-git`, ({ store }) =>
    store({ gitEmail: 'dev@example.com' })[method]({ feature: 'demo', actor: '  ', ts: 't0' }));
  add(`${method}/default-ts-stamped`, ({ store }) => store()[method]({ feature: 'demo', actor: 'me' }));
  add(`${method}/missing-identity`, ({ store }) => store({ gitEmail: '' })[method]({ feature: 'demo', ts: 't0' }));
  add(`${method}/missing-feature`, ({ store }) => store()[method]({ actor: 'me' }));
  add(`${method}/no-args`, ({ store }) => store()[method]());
  add(`${method}/unsafe-feature`, ({ store }) => store()[method]({ feature: '../x', actor: 'me' }));
  add(`${method}/on-delivered-feature`, ({ store, seed: s }) => {
    s('.agents/state/demo/events.jsonl',
      line(APPROVED) + line({ feature: 'demo', type: 'deliver-started', actor: 'h', ts: 't1' }) +
      line({ feature: 'demo', type: 'pr-opened', actor: 'h', ts: 't2' }));
    return store()[method]({ feature: 'demo', actor: 'me', ts: 't3' });
  });
  add(`${method}/after-${label}`, ({ store }) => {
    const st = store();
    const first = st.recordOwnerClaimed({ feature: 'demo', actor: 'me', ts: 't0' });
    const second = st[method]({ feature: 'demo', actor: 'you', ts: 't1' });
    return { first, second };
  });
}

// --- public surface ---------------------------------------------------------
add('surface/keys', ({ store }) => Object.keys(store()));
add('surface/exports', () => Object.keys(storeModule).sort());
add('surface/missing-repoRoot', () => createGitStateStore({}));
add('surface/no-options', () => createGitStateStore());

function makeContext(repoRoot, calls) {
  return {
    repoRoot,
    seed: (rel, text) => seed(repoRoot, rel, text),
    store: ({ roleStatus = 0, roleStdout = '', roleStderr = '', gitEmail = 'git@example.com', ...opts } = {}) => {
      const sh = (file, args = [], o = {}) => {
        calls.push({ file, args, cwd: o.cwd });
        if (String(file).endsWith('check-role.sh')) {
          return { status: roleStatus, stdout: roleStdout, stderr: roleStderr };
        }
        if (file === 'git') return { status: 0, stdout: gitEmail, stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      };
      return createGitStateStore({ repoRoot, sh, ...opts });
    },
  };
}

async function observe(run) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'rad-store-char-'));
  const calls = [];
  const out = {};
  try {
    out.result = await run(makeContext(repoRoot, calls));
  } catch (err) {
    out.error = { type: err?.constructor?.name, message: String(err?.message) };
  }
  out.logs = collectLogs(repoRoot);
  out.sh = calls;
  const raw = normalize(out, repoRoot);
  return raw;
}

// A stamped timestamp is wall-clock; assert its shape, then pin it to a token.
function pinStampedTimestamps(name, observed) {
  const stamps = Object.values(observed.logs).join('').match(ISO_RE) ?? [];
  const returned = JSON.stringify(observed.result ?? null).match(ISO_RE) ?? [];
  if (/stamps-iso-ts|default-ts-stamped/.test(name)) {
    assert.ok(stamps.length + returned.length > 0, `${name}: expected an ISO timestamp to be stamped`);
  } else {
    assert.equal(stamps.length + returned.length, 0, `${name}: unexpected clock read`);
  }
  return JSON.parse(JSON.stringify(observed).replace(ISO_RE, TS_TOKEN));
}

const observedAll = {};
const golden = UPDATE || !existsSync(GOLDEN_PATH) ? {} : JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'));

for (const [name, run] of Object.entries(scenarios)) {
  test(`characterization: ${name}`, async () => {
    const observed = pinStampedTimestamps(name, await observe(run));
    observedAll[name] = observed;
    if (UPDATE) return;
    assert.ok(Object.hasOwn(golden, name), `${name}: no golden entry (run with UPDATE_GOLDEN=1 on the unmodified store)`);
    assert.deepEqual(observed, golden[name]);
  });
}

test('characterization: golden file and scenarios agree', () => {
  if (UPDATE) {
    mkdirSync(dirname(GOLDEN_PATH), { recursive: true });
    const sorted = Object.fromEntries(Object.keys(observedAll).sort().map((k) => [k, observedAll[k]]));
    writeFileSync(GOLDEN_PATH, JSON.stringify(sorted, null, 2) + '\n', 'utf8');
    return;
  }
  assert.deepEqual(Object.keys(golden).sort(), Object.keys(scenarios).sort());
});

test('characterization: store exposes exactly the ten public keys', async () => {
  const keys = (await observe(scenarios['surface/keys'])).result;
  assert.deepEqual([...keys].sort(), [...STORE_KEYS].sort());
});

test('characterization: role check receives [requiredRole, roleConfigRoot, actor]', async () => {
  const obs = await observe(scenarios['recordApproval/separate-config-root']);
  assert.deepEqual(obs.sh[0].args, ['architect', '/elsewhere/cfg', 'arch']);
  assert.equal(obs.sh[0].cwd, REPO_TOKEN);
});
