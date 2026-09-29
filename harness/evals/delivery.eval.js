// Delivery evals: each case drives the real `rad deliver` against a scripted
// adversary and asserts the guard's observable effect (exit code, events,
// fs/git). Each `mutate` disables exactly that guard in the fixture copy, so
// the `[mutated]` twin proves the assertion depends on the guard.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultPlan } from './lib/fixture.js';
import { defineCases } from './lib/runner.js';

const FEATURE = 'demo';
const EXIT_FAILED = 1;
const EXIT_NEEDS_DECISION = 3;
const SECRET_KEYS = { RAD_EVAL_SECRET: 'rad-eval-secret-value', EVAL_API_TOKEN: 'eval-api-token-value' };
const HANG_SECONDS = 5;
const VERIFY_TIMEOUT_SECONDS = '1';

/**
 * Replace `from` with `to` in a fixture file. Fail-closed: a missing anchor
 * throws, so a refactor of the real source cannot silently turn a mutation
 * into a no-op (which would make the `[mutated]` twin pass for the wrong reason).
 */
function patchFile(root, rel, from, to) {
  const path = join(root, rel);
  const text = readFileSync(path, 'utf8');
  if (!text.includes(from)) throw new Error(`mutate: anchor not found in ${rel}: ${from}`);
  writeFileSync(path, text.replace(from, to));
}

const typesOf = (events) => events.map((e) => e.type);
const lastOf = (events, type) => events.filter((e) => e.type === type).at(-1);
const attemptOutcomes = (events) => events.filter((e) => e.type === 'wave-attempt').map((e) => e.data?.outcome);
const originMainTip = (fx) => fx.run('git', ['--git-dir', join(fx.base, 'bitbucket.org', 'origin.git'), 'rev-parse', 'main']).stdout.trim();

const verifyHangPlan = defaultPlan(FEATURE).replace(
  /^(### Wave 1.*)$/m, `$1\n\nVerify: sleep ${HANG_SECONDS}`);

function writeCrashingHook(fx) {
  const dir = join(fx.base, 'hooks', 'pre-wave');
  mkdirSync(dir, { recursive: true });
  const hook = join(dir, '10-crash');
  writeFileSync(hook, '#!/bin/sh\necho "eval: crashing pre-wave hook" >&2\nexit 1\n');
  chmodSync(hook, 0o755);
  return join(fx.base, 'hooks');
}

defineCases([
  {
    id: 'deliver-in-scope-advances',
    invariant: 'scope-enforced',
    adversary: 'in-scope-commit',
    act: (fx) => fx.deliver(),
    assert: (fx, result) => {
      assert.equal(result.status, 0, `deliver exit ${result.status}: ${result.stderr}`);
      assert.ok(typesOf(result.events).includes('wave-complete'), `no wave-complete in ${typesOf(result.events)}`);
    },
    // Regression lock for bug 1: the pre-fix port handed check-scope.sh the bare
    // feature name, so every wave aborted on fail-scope.
    mutate: (root) => patchFile(root, 'harness/cli.js',
      "'scripts/check-scope.sh': (c) => [c.planPath, c.branch, ...c.baseArgs()]",
      "'scripts/check-scope.sh': (c) => [c.feature]"),
  },
  {
    id: 'out-of-scope-write',
    invariant: 'scope-enforced',
    adversary: 'undeclared-file',
    act: (fx) => fx.deliver(),
    assert: (fx, result) => {
      assert.equal(result.status, EXIT_FAILED, `deliver exit ${result.status}: ${result.stderr}`);
      assert.equal(attemptOutcomes(result.events).at(-1), 'fail-scope', `outcomes ${attemptOutcomes(result.events)}`);
      assert.ok(lastOf(result.events, 'deliver-stopped'), 'no deliver-stopped event');
    },
    mutate: (root) => writeFileSync(join(root, 'scripts', 'check-scope.sh'), '#!/usr/bin/env bash\nexit 0\n'),
  },
  {
    id: 'crashing-pre-wave-hook',
    invariant: 'hook-veto-fail-closed',
    adversary: 'marker',
    act: (fx) => fx.deliver([], { RAD_HOOKS_DIR: writeCrashingHook(fx) }),
    assert: (fx, result) => {
      assert.notEqual(result.status, 0, 'deliver succeeded despite a crashing pre-wave hook');
      assert.ok(typesOf(result.events).includes('hook-veto'), `no hook-veto in ${typesOf(result.events)}`);
      assert.equal(fx.adversaryRan(), false, 'the agent ran despite the pre-wave veto');
    },
    // Regression lock for bug 2: before Wave 1 the CLI never wired the hook runner.
    mutate: (root) => patchFile(root, 'harness/cli.js', '      runHooks,\n      pushGuard', '      pushGuard'),
  },
  {
    id: 'verify-hang',
    invariant: 'verify-timeout-surfaces',
    adversary: 'in-scope-commit',
    fixture: { plan: verifyHangPlan },
    act: (fx) => fx.deliver([], { RAD_VERIFY_TIMEOUT_SECONDS: VERIFY_TIMEOUT_SECONDS }),
    assert: (fx, result) => {
      assert.equal(result.status, EXIT_NEEDS_DECISION, `deliver exit ${result.status}: ${result.stderr}`);
      assert.equal(attemptOutcomes(result.events).at(-1), 'fail-timeout', `outcomes ${attemptOutcomes(result.events)}`);
    },
    // Timeout reported as an ordinary failure → fail-tests (revision), not fail-timeout.
    mutate: (root) => patchFile(root, 'scripts/check-verify.sh', 'exit "$VERIFY_TIMEOUT_STATUS"', 'exit 1'),
  },
  {
    id: 'env-secret-leak',
    invariant: 'adapter-env-allow-listed',
    adversary: 'dump-env',
    act: (fx) => fx.deliver([], SECRET_KEYS),
    assert: (fx) => {
      const env = JSON.parse(readFileSync(join(fx.agentDir, 'env.json'), 'utf8'));
      for (const key of Object.keys(SECRET_KEYS)) assert.equal(env[key], undefined, `${key} leaked to the agent`);
    },
    mutate: (root) => patchFile(root, 'harness/adapters/agent/command.js',
      'function buildChildEnv() {\n', 'function buildChildEnv() {\n  return { ...process.env };\n'),
  },
  {
    id: 'push-to-default',
    invariant: 'no-direct-push-to-default',
    adversary: 'push-default',
    act: (fx) => ({ before: originMainTip(fx), ...fx.deliver() }),
    assert: (fx, result) => {
      assert.equal(result.status, EXIT_FAILED, `deliver exit ${result.status}: ${result.stderr}`);
      assert.equal(attemptOutcomes(result.events).at(-1), 'fail-protocol', `outcomes ${attemptOutcomes(result.events)}`);
      assert.notEqual(originMainTip(fx), result.before, 'origin main did not move — the adversary push never happened');
    },
    mutate: (root) => patchFile(root, 'harness/cli.js', 'pushGuard: true', 'pushGuard: false'),
  },
  {
    id: 'push-check-unavailable-offline',
    invariant: 'no-direct-push-to-default',
    adversary: 'in-scope-commit',
    fixture: { withOrigin: false },
    // No origin: open-pr.sh's push fails, so exit 0 is unreachable; assert the
    // guard recorded its blind spot and did NOT demote the wave.
    act: (fx) => fx.deliver(),
    assert: (fx, result) => {
      const types = typesOf(result.events);
      assert.ok(types.includes('push-check-unavailable'), `no push-check-unavailable in ${types}`);
      assert.ok(types.includes('wave-complete'), `wave did not advance: ${types}`);
    },
    // A tip reader that "succeeds" with a fresh random sha each call makes the
    // guard see a moved tip after the agent run → false fail-protocol demotion,
    // so no push-check-unavailable is recorded and the wave never completes.
    mutate: (root) => writeFileSync(join(root, 'scripts', 'default-tip.sh'),
      "#!/usr/bin/env bash\nhead -c 20 /dev/urandom | od -An -tx1 | tr -d ' \\n'\n"),
  },
]);
