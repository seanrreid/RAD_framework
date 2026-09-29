// Repository-integrity evals: the event log is append-only, RAD's own machinery
// is always flagged in a plan, and worktree teardown never removes an unmarked
// dir. Each `[mutated]` twin disables the named guard in the fixture's COPY.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultPlan } from './lib/fixture.js';
import { defineCases } from './lib/runner.js';

const ALWAYS_PASS_SCRIPT = '#!/usr/bin/env bash\nexit 0\n';
const APPEND_ONLY_VIOLATION_EXIT = 1;
const SELF_PROTECTED_WARNING = 'self-protected path (RAD machinery';
const SELF_PROTECTED_LITERAL = /^readonly RAD_SELF_PROTECTED_PATTERN=.*$/m;

/** Replace `from` in a fixture-copy file; throws when absent so a mutation is never a silent no-op. */
function patch(root, rel, from, to) {
  const file = join(root, rel);
  const text = readFileSync(file, 'utf8');
  if (!(from instanceof RegExp ? from.test(text) : text.includes(from))) {
    throw new Error(`mutate: ${from} not found in ${rel}`);
  }
  writeFileSync(file, text.replace(from, to));
}

defineCases([
  {
    id: 'events-log-tamper',
    invariant: 'events-append-only',
    act: (fx) => {
      const base = fx.git('rev-parse', 'HEAD').stdout.trim();
      const log = join('.agents', 'state', fx.feature, 'events.jsonl');
      const [first, ...rest] = readFileSync(join(fx.root, log), 'utf8').split('\n');
      const forged = JSON.stringify({ ...JSON.parse(first), actor: 'forger@evals.invalid' });
      fx.writeFile(log, [forged, ...rest].join('\n'));
      const commit = fx.git('commit', '-q', '-am', 'rewrite history');
      assert.equal(commit.status, 0, `tamper commit failed: ${commit.stderr}`);
      return fx.run('bash', [join('scripts', 'check-events-append-only.sh'), base, 'HEAD']);
    },
    assert: (fx, result) => {
      assert.equal(result.status, APPEND_ONLY_VIOLATION_EXIT,
        `append-only check exit ${result.status}: ${result.stdout}${result.stderr}`);
    },
    mutate: (root) => writeFileSync(join(root, 'scripts', 'check-events-append-only.sh'), ALWAYS_PASS_SCRIPT),
  },
  {
    id: 'self-protected-plan',
    invariant: 'self-protected-paths-flagged',
    act: (fx) => {
      const plan = join('.agents', 'plans', 'touch-spine.md');
      fx.writeFile(plan, defaultPlan('touch-spine').replaceAll('src/feature.txt', 'harness/spine.js'));
      return fx.run('bash', [join('scripts', 'lint-plan.sh'), plan]);
    },
    assert: (fx, result) => {
      const out = `${result.stdout}${result.stderr}`;
      assert.ok(out.includes(SELF_PROTECTED_WARNING) && out.includes('harness/spine.js'),
        `no self-protected warning for harness/spine.js:\n${out.slice(0, 800)}`);
    },
    mutate: (root) => patch(root, join('scripts', 'lib', 'plan-paths.sh'), SELF_PROTECTED_LITERAL,
      "readonly RAD_SELF_PROTECTED_PATTERN='^NEVER-MATCHES-ANY-PATH$'"),
  },
  {
    id: 'remove-unmarked-worktree',
    invariant: 'worktree-teardown-guarded',
    act: (fx) => {
      const dir = join(fx.base, 'wt-demo');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'precious.txt'), 'keep\n');
      return { ...fx.run('bash', [join('scripts', 'worktree-lifecycle.sh'), 'remove', fx.feature, dir]), dir };
    },
    assert: (fx, result) => {
      assert.notEqual(result.status, 0, 'remove succeeded on an unmarked dir');
      assert.match(`${result.stdout}${result.stderr}`, /refusing to remove/);
      assert.ok(existsSync(join(result.dir, 'precious.txt')), 'the unmarked dir was deleted');
    },
    mutate: (root) => patch(root, join('scripts', 'worktree-lifecycle.sh'),
      '  marker_valid "$dir" "$feature" \\\n', '  true \\\n'),
  },
]);
