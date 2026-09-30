import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DIGEST_RANK, buildDigest, gatherDigestInputs, renderDigest } from '../digest.js';
import { planFingerprint } from '../plan-fingerprint.js';

const FEATURE = 'feat';
const PLAN_TEXT = '# Plan: feat\n\nStatus: approved\n\n## Tasks\n\n### Wave 1\n\n#### Task 1.1: Do it\nFile: src/a.js\n';

const successHistory = () => [
  { type: 'approved', role: 'architect', actor: 'arch', data: { fingerprint: 'fp' } },
  { type: 'deliver-started', data: {} },
  { type: 'wave-attempt', feature: FEATURE, data: { wave: 1, outcome: 'success', usage: { input: 10, output: 5, total: 15 } } },
  { type: 'wave-complete', feature: FEATURE, data: { wave: 1 } },
  { type: 'pr-opened', data: {} },
];

const cleanInputs = () => ({
  feature: FEATURE,
  scope: { passed: true, violations: [] },
  paths: ['src/a.js'],
  approval: { gatePassed: true, gateReason: 'ok', storedFingerprint: 'fp', currentFingerprint: 'fp', frozenWaivers: null },
  highRisk: [],
  waivers: [],
  selfProtected: [],
  deficits: [],
  findings: [],
  history: successHistory(),
  waveCount: 1,
});

const flaggedInputs = () => ({
  ...cleanInputs(),
  scope: { passed: false, violations: [{ path: 'z/out.js', detail: 'likely undeclared rename target of declared file: src/a.js' }] },
  paths: ['src/a.js', 'src/auth/x.js', 'src/auth/y.js', 'harness/h.js'],
  approval: { gatePassed: true, gateReason: 'ok', storedFingerprint: 'old', currentFingerprint: 'new', frozenWaivers: null },
  highRisk: ['src/auth/x.js', 'src/auth/y.js'],
  waivers: [{ id: 'high-risk:src/auth/y.js', justification: 'reviewed by security' }],
  selfProtected: ['harness/h.js'],
  deficits: [{ path: 'src/a.js', deficits: { insufficientTesting: { features: ['f1', 'f2'], waves: [], attempts: 3 } } }],
  findings: [{ type: 'finding', file: 'src/a.js', priority: 'HIGH', category: 'security' }],
  history: [
    { type: 'deliver-started', data: {} },
    { type: 'wave-attempt', feature: FEATURE, data: { wave: 1, outcome: 'fail-tests' } },
    { type: 'wave-attempt', feature: FEATURE, data: { wave: 1, outcome: 'fail-tests' } },
    { type: 'deliver-stopped', data: { class: 'failed', reason: 'budget-exhausted', detail: 'wave 1' } },
  ],
});

test('buildDigest ranks items across all 8 kinds in DIGEST_RANK order', () => {
  const digest = buildDigest(flaggedInputs());
  const kinds = [...new Set(digest.items.map((i) => i.kind))];
  assert.deepEqual(kinds, [...DIGEST_RANK]);
  assert.match(digest.items[0].detail, /rename target/);
  assert.ok(digest.items.some((i) => i.kind === 'high-risk' && i.path === 'src/auth/x.js'));
  assert.ok(digest.items.some((i) => i.kind === 'run' && /stopped: failed\/budget-exhausted — wave 1/.test(i.detail)));
  assert.ok(digest.items.some((i) => i.kind === 'run' && /wave 1 took 2 attempts/.test(i.detail)));
  assert.ok(digest.items.some((i) => i.kind === 'run' && /completion not evidenced/.test(i.detail)));
});

test('clean inputs → "nothing flagged" and passing evidence', () => {
  const digest = buildDigest(cleanInputs());
  assert.deepEqual(digest.items, []);
  assert.deepEqual(digest.unavailable, []);
  assert.ok(digest.evidence.every((e) => e.ok), JSON.stringify(digest.evidence));
  const md = renderDigest(digest);
  assert.match(md, /^## Review digest — feat$/m);
  assert.match(md, /nothing flagged — every check below stayed inside the lines/);
  assert.match(md, /### Evidence/);
  assert.match(md, /✓ completion evidenced/);
});

test('each unavailable input renders its reason and fails its evidence check', () => {
  const inputs = { ...cleanInputs(), scope: { unavailable: 'check-scope.sh exit 2: boom' }, history: { unavailable: 'line 3 is not valid JSON' } };
  const digest = buildDigest(inputs);
  const md = renderDigest(digest);
  assert.match(md, /unavailable: scope — check-scope\.sh exit 2: boom/);
  assert.match(md, /unavailable: history — line 3 is not valid JSON/);
  assert.doesNotMatch(md, /every check below stayed inside the lines/);
  assert.equal(digest.evidence.find((e) => e.check === 'scope passed').ok, false);
  assert.equal(digest.evidence.find((e) => e.check === 'completion evidenced').ok, false);
});

test('waived high-risk hits show their frozen justification', () => {
  const md = renderDigest(buildDigest(flaggedInputs()));
  assert.match(md, /\*\*high-risk-waived\*\* `src\/auth\/y\.js` — waived: reviewed by security/);
  assert.match(md, /\*\*high-risk\*\* `src\/auth\/x\.js` — high-risk path with no waiver/);
});

test('gate not passing is an approval item', () => {
  const inputs = { ...cleanInputs(), approval: { ...cleanInputs().approval, gatePassed: false, gateReason: 'needs architect' } };
  const digest = buildDigest(inputs);
  assert.deepEqual(digest.items, [{ kind: 'approval', detail: 'approved gate not passing: needs architect' }]);
});

test('same inputs → identical output (deterministic)', () => {
  assert.equal(renderDigest(buildDigest(flaggedInputs())), renderDigest(buildDigest(flaggedInputs())));
});

test('buildDigest never throws on malformed input', () => {
  for (const bad of [null, undefined, 42, { scope: { passed: true, violations: 'nope' } }]) {
    const digest = buildDigest(bad);
    assert.ok(Array.isArray(digest.items));
    assert.equal(typeof renderDigest(digest), 'string');
  }
});

/** Temp repo with a plan, an approved log, and (optionally) findings. */
function makeRepo({ findings } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'rad-digest-'));
  mkdirSync(join(root, '.agents', 'plans'), { recursive: true });
  mkdirSync(join(root, '.agents', 'state', FEATURE), { recursive: true });
  writeFileSync(join(root, '.agents', 'plans', `${FEATURE}.md`), PLAN_TEXT);
  const approved = { type: 'approved', role: 'architect', actor: 'arch', data: { fingerprint: planFingerprint(PLAN_TEXT).hash } };
  writeFileSync(join(root, '.agents', 'state', FEATURE, 'events.jsonl'), `${JSON.stringify(approved)}\n`);
  if (findings !== undefined) writeFileSync(join(root, '.agents', 'findings.jsonl'), findings);
  return root;
}

/** Fake sh port: check-scope.sh fails (status 2); plan-paths helpers answer. */
function fakeSh(calls) {
  return (cmd, args) => {
    calls.push(args);
    if (args[0] === 'scripts/check-scope.sh') return { status: 2, stdout: '', stderr: 'ERROR: work branch required\n' };
    const script = args[1];
    if (script.includes('plan_scope_paths')) return { status: 0, stdout: 'src/a.js\nharness/h.js\n', stderr: '' };
    if (script.includes('plan_high_risk_findings')) return { status: 0, stdout: '', stderr: '' };
    if (script.includes('plan_waivers')) return { status: 0, stdout: '', stderr: '' };
    if (script.includes('path_is_self_protected')) return { status: 0, stdout: 'harness/h.js\n', stderr: '' };
    return { status: 1, stdout: '', stderr: `unexpected: ${script}` };
  };
}

test('gatherDigestInputs: failing check-scope.sh → scope unavailable; other inputs gathered', async () => {
  const findings = `${JSON.stringify({ type: 'finding', file: 'src/a.js', priority: 'LOW', category: 'naming' })}\n`;
  const root = makeRepo({ findings });
  try {
    const calls = [];
    const inputs = await gatherDigestInputs({ repoRoot: root, sh: fakeSh(calls), feature: FEATURE, branch: 'rad/feat', base: 'main' });
    assert.match(inputs.scope.unavailable, /ERROR: work branch required/);
    assert.deepEqual(inputs.paths, ['src/a.js', 'harness/h.js']);
    assert.deepEqual(inputs.selfProtected, ['harness/h.js']);
    assert.equal(inputs.approval.gatePassed, true);
    assert.equal(inputs.approval.storedFingerprint, inputs.approval.currentFingerprint);
    assert.equal(inputs.findings.length, 1);
    assert.equal(inputs.waveCount, 1);
    assert.deepEqual(inputs.deficits, []);
    const md = renderDigest(buildDigest(inputs));
    assert.match(md, /unavailable: scope — check-scope\.sh exit 2: ERROR: work branch required/);
    assert.match(md, /\*\*findings\*\* `src\/a\.js`/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('gatherDigestInputs: missing findings.jsonl → [] (not unavailable)', async () => {
  const root = makeRepo();
  try {
    const inputs = await gatherDigestInputs({ repoRoot: root, sh: fakeSh([]), feature: FEATURE, branch: 'rad/feat', base: 'main' });
    assert.deepEqual(inputs.findings, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('gatherDigestInputs: malformed findings line → unavailable naming the line', async () => {
  const root = makeRepo({ findings: '{"type":"finding"}\nnot json\n' });
  try {
    const inputs = await gatherDigestInputs({ repoRoot: root, sh: fakeSh([]), feature: FEATURE, branch: 'rad/feat', base: 'main' });
    assert.match(inputs.findings.unavailable, /line 2/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('gatherDigestInputs: missing event log → history + approval unavailable, never fatal', async () => {
  const root = makeRepo();
  rmSync(join(root, '.agents', 'state', FEATURE, 'events.jsonl'));
  try {
    const inputs = await gatherDigestInputs({ repoRoot: root, sh: fakeSh([]), feature: FEATURE, branch: 'rad/feat', base: 'main' });
    assert.ok(inputs.history.unavailable);
    assert.match(inputs.approval.unavailable, /event log unavailable/);
    assert.deepEqual(inputs.paths, ['src/a.js', 'harness/h.js']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('gatherDigestInputs: unsafe feature name → every input unavailable, no fs/sh access', async () => {
  const calls = [];
  const inputs = await gatherDigestInputs({ repoRoot: '/nonexistent', sh: fakeSh(calls), feature: '../etc', branch: 'b', base: 'main' });
  assert.equal(calls.length, 0);
  assert.match(inputs.scope.unavailable, /invalid feature name/);
  assert.equal(buildDigest(inputs).unavailable.length, 10);
});
