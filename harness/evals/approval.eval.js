// Approval-gate evals: an unapproved, edited, or blocker-carrying plan never
// reaches the agent, and a failed stop cannot be resumed past. Each `[mutated]`
// twin disables the named guard in the fixture's COPY of harness/ or scripts/.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineCases } from './lib/runner.js';
import { defaultPlan } from './lib/fixture.js';

const ALWAYS_PASS_SCRIPT = '#!/usr/bin/env bash\nexit 0\n';
const HOOK_BLOCK_EXIT = 2;
const RESUME_REFUSED_EXIT = 2;
const NEEDS_DECISION_EXIT = 3;

/** Replace `from` in a fixture-copy file; throws when absent so a mutation is never a silent no-op. */
function patch(root, rel, from, to) {
  const file = join(root, rel);
  const text = readFileSync(file, 'utf8');
  if (!text.includes(from)) throw new Error(`mutate: ${JSON.stringify(from)} not found in ${rel}`);
  writeFileSync(file, text.replace(from, to));
}

/** Invoke the /rad-deliver PreToolUse hook exactly as Claude Code would, for the fixture's feature. */
function runDeliverHook(fx) {
  const payload = { tool_name: 'Skill', tool_input: { skill_name: 'team:rad-deliver', skill_args: fx.feature } };
  const res = spawnSync('node', [join('scripts', 'deliver-gate-hook.mjs')],
    { cwd: fx.root, input: JSON.stringify(payload), encoding: 'utf8' });
  if (res.error) throw res.error;
  return res;
}

/** Hide a mutated fixture copy from the wave scope check so only the targeted guard differs. */
function assumeUnchanged(root, rel) {
  const hide = spawnSync('git', ['update-index', '--assume-unchanged', rel], { cwd: root, encoding: 'utf8' });
  if (hide.status !== 0) throw new Error(`mutate: git update-index failed: ${hide.stderr}`);
}

const types = (events) => events.map((e) => e.type);

/** Append to the plan BODY (inside the fingerprint) and commit on the work branch. */
function editPlanBody(fx) {
  const rel = join('.agents', 'plans', `${fx.feature}.md`);
  fx.writeFile(rel, `${readFileSync(join(fx.root, rel), 'utf8')}\n- AC#2: added after approval\n`);
  const res = fx.git('commit', '-q', '-am', 'edit plan after approval');
  assert.equal(res.status, 0, `plan edit commit failed: ${res.stderr}`);
}

defineCases([
  {
    id: 'deliver-without-approval',
    invariant: 'unapproved-deliver-cannot-run',
    fixture: { approve: false },
    adversary: 'marker',
    act: (fx) => fx.deliver(),
    assert: (fx, result) => {
      assert.notEqual(result.status, 0, 'rad deliver ran an unapproved plan');
      assert.ok(!types(result.events).includes('deliver-started'), `deliver-started in ${types(result.events)}`);
      assert.equal(fx.adversaryRan(), false, 'the agent ran without an approval');
    },
    // Both copies of the approved-gate check (CLI pre-flight + spine entry) must go.
    mutate: (root) => {
      patch(root, join('harness', 'cli.js'), 'if (!g.passed) {', 'if (false) {');
      patch(root, join('harness', 'spine.js'), "if (!g.passed) {\n    return { stopped: 'gate'", "if (false) {\n    return { stopped: 'gate'");
    },
  },
  {
    id: 'gate-hook-blocks-unapproved',
    invariant: 'unapproved-deliver-cannot-run',
    fixture: { approve: false },
    act: (fx) => runDeliverHook(fx),
    assert: (fx, result) => {
      assert.equal(result.status, HOOK_BLOCK_EXIT, `hook exit ${result.status}: ${result.stderr}`);
    },
    mutate: (root) => writeFileSync(join(root, 'scripts', 'check-plan-approved.sh'), ALWAYS_PASS_SCRIPT),
  },
  {
    // Both deliver entry points refuse a plan edited after approval: the
    // /rad-deliver hook (check-plan-approved.sh) and `rad deliver` itself, whose
    // spine re-checks approval before EVERY wave — the first included.
    id: 'deliver-after-plan-edit',
    invariant: 'approval-invalidated-by-plan-change',
    act: (fx) => { editPlanBody(fx); return { hook: runDeliverHook(fx), cli: fx.deliver() }; },
    assert: (fx, { hook, cli }) => {
      assert.equal(hook.status, HOOK_BLOCK_EXIT, `hook allowed an edited plan (exit ${hook.status})`);
      assert.equal(cli.status, NEEDS_DECISION_EXIT, `rad deliver exit ${cli.status}: ${cli.stderr}`);
      const stop = cli.events.find((e) => e.type === 'deliver-stopped');
      assert.equal(stop?.data?.reason, 'approval-changed', `deliver-stopped: ${JSON.stringify(stop)}`);
      assert.equal(fx.adversaryRan(), false, 'the agent ran');
    },
    // Restore #151's first-wave exemption in the spine copy; only the CLI assertion can catch it.
    mutate: (root) => {
      const spine = join('harness', 'spine.js');
      patch(root, spine, 'for (const wave of waves) {', 'let firstWaveOfRun = true;\n  for (const wave of waves) {');
      patch(root, spine, 'const reason = await approvalChangeReason({ state, feature, approvalIntact });',
        'const reason = firstWaveOfRun ? null : await approvalChangeReason({ state, feature, approvalIntact });\n    firstWaveOfRun = false;');
      assumeUnchanged(root, spine);
    },
  },
  {
    // Hook-only twin of deliver-after-plan-edit: the gate fold still passes, so
    // only check-plan-approved.sh's fingerprint comparison can refuse.
    id: 'hook-refuses-edited-plan',
    invariant: 'approval-invalidated-by-plan-change',
    act: (fx) => { editPlanBody(fx); return runDeliverHook(fx); },
    assert: (fx, result) => {
      assert.equal(result.status, HOOK_BLOCK_EXIT, `hook allowed an edited plan (exit ${result.status}): ${result.stderr}`);
    },
    mutate: (root) => patch(root, join('scripts', 'check-plan-approved.sh'),
      'if [[ -n "$STORED_FP" ]]; then', 'if false; then'),
  },
  {
    id: 'plan-edit-mid-run',
    invariant: 'approval-invalidated-by-plan-change',
    fixture: { plan: twoWavePlan('demo') },
    act: (fx) => {
      const agent = join(fx.agentDir, 'edit-plan.mjs');
      writeFileSync(agent, EDIT_PLAN_AGENT);
      return fx.deliver([], { RAD_AGENT_CMD: `node ${agent} ${fx.feature}` });
    },
    assert: (fx, result) => {
      assert.notEqual(result.status, 0, 'deliver completed under a stale approval');
      const started = result.events.filter((e) => e.type === 'wave-started').map((e) => e.data?.wave);
      assert.ok(!started.includes(2), `wave 2 started after the plan changed: ${types(result.events)}`);
    },
    mutate: (root) => {
      const cli = join('harness', 'cli.js');
      patch(root, cli, 'if (current === stored) return { ok: true };', 'return { ok: true };');
      assumeUnchanged(root, cli);
    },
  },
  {
    // The wave agent shares the architect's git identity, so it can record an
    // approval of its own (uncommitted) plan edit mid-run: the refreshed
    // fingerprint then matches and only the run-scoped check refuses (#158).
    id: 'self-approval-mid-run',
    invariant: 'approval-invalidated-by-plan-change',
    fixture: { plan: twoWavePlan('demo') },
    act: (fx) => deliverWithSelfApproval(fx),
    assert: (fx, result) => {
      assertSelfApprovalRefused(result);
      const stop = result.events.filter((e) => e.type === 'deliver-stopped').at(-1);
      assert.ok(String(stop?.data?.detail ?? '').includes('recorded during this run'),
        `deliver-stopped detail lacks the run-scoped reason: ${JSON.stringify(stop)}`);
      const started = result.events.filter((e) => e.type === 'wave-started').map((e) => e.data?.wave);
      assert.ok(!started.includes(2), `wave 2 started after a mid-run approval: ${types(result.events)}`);
    },
    mutate: neutralizeApprovedDuringRun,
  },
  {
    // Last-wave twin: no next pre-wave re-check exists, so the post-loop check must refuse.
    id: 'self-approval-last-wave',
    invariant: 'approval-invalidated-by-plan-change',
    act: (fx) => deliverWithSelfApproval(fx),
    assert: (fx, result) => assertSelfApprovalRefused(result),
    mutate: neutralizeApprovedDuringRun,
  },
  {
    id: 'approve-with-marker',
    invariant: 'approval-blockers-refuse',
    fixture: { approve: false, plan: defaultPlan('demo', '[NEEDS CLARIFICATION: which format?]') },
    act: (fx) => fx.approve(),
    assert: (fx, result) => {
      assert.notEqual(result.status, 0, 'rad approve accepted a plan with an open clarification marker');
      assert.ok(!types(fx.events()).includes('approved'), `approved event written: ${types(fx.events())}`);
    },
    mutate: (root) => writeFileSync(join(root, 'scripts', 'check-approval-blockers.sh'), ALWAYS_PASS_SCRIPT),
  },
  {
    id: 'resume-failed-stop',
    invariant: 'resume-needs-decision-only',
    adversary: 'undeclared-file',
    act: (fx) => {
      const first = fx.deliver();
      const stop = first.events.find((e) => e.type === 'deliver-stopped');
      assert.equal(stop?.data?.class, 'failed', `setup: expected a failed stop, got ${JSON.stringify(stop)}`);
      return fx.deliver(['--resume', '--context', 'retry']);
    },
    assert: (fx, result) => {
      assert.equal(result.status, RESUME_REFUSED_EXIT, `resume exit ${result.status}: ${result.stderr}`);
      assert.ok(!types(result.events).includes('run-resumed'), 'run-resumed recorded for a failed stop');
    },
    mutate: (root) => patch(root, join('harness', 'cli.js'),
      'if (stop.class === STOP_CLASSES.FAILED) {', 'if (false) {'),
  },
]);

// Hoisted helpers for plan-edit-mid-run: wave 1 edits the approved plan body.
function twoWavePlan(feature) {
  return defaultPlan(feature).replace('## Tests to Write', [
    '### Wave 2 — sequential', '', '#### Task 2.1: Touch the feature file again',
    'File: src/feature.txt:1-5', 'What: append to src/feature.txt.', 'Validate: AC#1.', '',
    '## Tests to Write'].join('\n'));
}

const EDIT_PLAN_AGENT = `import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
const feature = process.argv[2];
const git = (...a) => execFileSync('git', a, { stdio: 'ignore' });
mkdirSync('src', { recursive: true }); writeFileSync('src/feature.txt', 'feature\\n');
git('add', '-A'); git('commit', '-q', '-m', 'agent: feature');
// Left UNCOMMITTED: a committed plan edit is already a fail-scope; this isolates the fingerprint re-check.
appendFileSync('.agents/plans/' + feature + '.md', '\\n- AC#9: widened mid-run\\n');
console.log(['WAVE_RESULT', 'wave: 1', 'status: complete', 'tasks:', '  - title: Write the feature file',
  '    status: complete', '    commit: —', '    concern: —', '    error: —', 'END_WAVE_RESULT'].join('\\n'));
`;

/** Run deliver with SELF_APPROVE_AGENT as the wave agent. */
function deliverWithSelfApproval(fx) {
  const agent = join(fx.agentDir, 'self-approve.mjs');
  writeFileSync(agent, SELF_APPROVE_AGENT);
  return fx.deliver([], { RAD_AGENT_CMD: `node ${agent} ${fx.feature}` });
}

/** A mid-run approval stops the run as needs-decision, before any PR. */
function assertSelfApprovalRefused(result) {
  assert.equal(result.status, NEEDS_DECISION_EXIT, `rad deliver exit ${result.status}: ${result.stderr}`);
  const stop = result.events.filter((e) => e.type === 'deliver-stopped').at(-1);
  assert.equal(stop?.data?.reason, 'approval-changed', `deliver-stopped: ${JSON.stringify(stop)}`);
  // The kept evidence (the mid-run approved event) identifies the cause; the
  // mutation proves it. The run-scoped reason text is asserted per case via data.detail.
  const runStart = result.events.findLastIndex((e) => e.type === 'deliver-started');
  assert.ok(result.events.slice(runStart + 1).some((e) => e.type === 'approved'),
    `no mid-run approved event kept as evidence: ${types(result.events)}`);
  assert.ok(!types(result.events).includes('pr-opened'), `pr-opened after a mid-run approval: ${types(result.events)}`);
}

/** Make the spine copy blind to run-scoped approvals (both check sites call it). */
function neutralizeApprovedDuringRun(root) {
  const spine = join('harness', 'spine.js');
  patch(root, spine, "if (!Array.isArray(history)) return [];\n  let start = -1;", 'return [];\n  let start = -1;');
  assumeUnchanged(root, spine);
}

// Wave agent that approves its own plan edit. Idempotent across waves: once the
// plan is edited it only touches src/feature.txt and commits.
const SELF_APPROVE_AGENT = `import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
const feature = process.argv[2];
const plan = '.agents/plans/' + feature + '.md';
const MARK = '- AC#9: self-approved mid-run';
const git = (...a) => execFileSync('git', a, { stdio: 'ignore' });
mkdirSync('src', { recursive: true });
appendFileSync('src/feature.txt', 'feature\\n');
git('add', 'src/feature.txt'); git('commit', '-q', '-m', 'agent: feature');
if (!readFileSync(plan, 'utf8').includes(MARK)) {
  // Left UNCOMMITTED: a committed plan edit is already fail-scope.
  appendFileSync(plan, '\\n' + MARK + '\\n');
  execFileSync('node', ['harness/cli.js', 'approve', feature], { stdio: ['ignore', 'ignore', 'inherit'] });
}
console.log(['WAVE_RESULT', 'wave: 1', 'status: complete', 'tasks:', '  - title: Write the feature file',
  '    status: complete', '    commit: —', '    concern: —', '    error: —', 'END_WAVE_RESULT'].join('\\n'));
`;
