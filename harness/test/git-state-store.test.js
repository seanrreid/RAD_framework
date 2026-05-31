import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createGitStateStore } from '../adapters/git-state-store.js';
import { TransitionError } from '../transitions.js';

// Async so an async `fn` is fully awaited BEFORE the temp dir is removed. With a
// synchronous try/finally, an async fn's body would run after cleanup, executing
// I/O against an already-deleted directory (false-passing tests). `await fn(...)`
// is a no-op for synchronous callbacks, so both styles are correct.
async function withTempRepo(fn) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'rad-state-'));
  try {
    return await fn(repoRoot);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

const eventsFile = (repoRoot, feature) =>
  join(repoRoot, '.agents', 'state', feature, 'events.jsonl');

test('append writes a JSONL line per legal event; phase derives from the log', async () => {
  await withTempRepo((repoRoot) => {
    const store = createGitStateStore({ repoRoot });
    const feature = 'demo';

    store.append({ feature, type: 'approved', actor: 'architect', ts: 't0' });
    store.append({ feature, type: 'deliver-started', actor: 'harness', ts: 't1' });
    store.append({ feature, type: 'wave-attempt', actor: 'harness', ts: 't2' });

    const file = eventsFile(repoRoot, feature);
    assert.ok(existsSync(file));
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 3);
    assert.equal(JSON.parse(lines[0]).type, 'approved');

    assert.equal(store.phase(feature), 'in-progress');
    assert.equal(store.history(feature).length, 3);
  });
});

test('an illegal transition throws TransitionError and writes nothing', async () => {
  await withTempRepo((repoRoot) => {
    const store = createGitStateStore({ repoRoot });
    const feature = 'demo';

    // wave-complete with no in-progress phase is illegal (rule b).
    assert.throws(
      () => store.append({ feature, type: 'wave-complete', actor: 'harness', ts: 't0' }),
      TransitionError,
    );
    // No file should have been written for a rejected first append.
    assert.equal(existsSync(eventsFile(repoRoot, feature)), false);
    assert.equal(store.history(feature).length, 0);
  });
});

test('duplicate approved is rejected and does not corrupt the log', async () => {
  await withTempRepo((repoRoot) => {
    const store = createGitStateStore({ repoRoot });
    const feature = 'demo';
    store.append({ feature, type: 'approved', actor: 'architect', ts: 't0' });
    assert.throws(
      () => store.append({ feature, type: 'approved', actor: 'architect', ts: 't1' }),
      TransitionError,
    );
    assert.equal(store.history(feature).length, 1);
  });
});

test('history() skips an unparseable trailing line (crash tolerance)', async () => {
  await withTempRepo((repoRoot) => {
    const store = createGitStateStore({ repoRoot });
    const feature = 'demo';
    store.append({ feature, type: 'plan-created', actor: 'dev', ts: 't0' });

    // Simulate a half-written crash line appended to the log.
    appendFileSync(eventsFile(repoRoot, feature), '{ "type": "wave-att', 'utf8');

    const hist = store.history(feature);
    assert.equal(hist.length, 1);
    assert.equal(hist[0].type, 'plan-created');
  });
});

test('recordApproval appends a proxy-aware approved event', async () => {
  await withTempRepo((repoRoot) => {
    const store = createGitStateStore({ repoRoot });
    const feature = 'demo';
    store.recordApproval({ feature, actor: 'architect', recordedBy: 'dev', ts: 't0' });
    const hist = store.history(feature);
    assert.equal(hist.length, 1);
    assert.equal(hist[0].type, 'approved');
    assert.equal(hist[0].actor, 'architect');
    assert.equal(hist[0].recordedBy, 'dev');
  });
});

test('gate(approved) is hermetic with an injected sh + injected evaluator', async () => {
  await withTempRepo(async (repoRoot) => {
    const calls = [];
    const sh = (file, args) => {
      calls.push({ file, args });
      return { status: 0, stdout: '', stderr: '' };
    };
    // Inject the gate evaluator so gates.js / scripts are not loaded for real.
    const evaluateGate = (name, history) => ({
      passed: true,
      reason: 'ok',
      requiredRole: 'architect',
      satisfiedBy: { actor: 'architect', recordedBy: 'dev' },
    });
    const store = createGitStateStore({ repoRoot, sh, evaluateGate });
    const feature = 'demo';
    store.recordApproval({ feature, actor: 'architect', recordedBy: 'dev', ts: 't0' });

    const result = await store.gate(feature, 'approved');
    assert.equal(result.passed, true);
    assert.deepEqual(result.satisfiedBy, { actor: 'architect', recordedBy: 'dev' });
    // Both branch-tip authority scripts were consulted via injected sh.
    const scripts = calls.map((c) => c.file);
    assert.ok(scripts.some((s) => s.endsWith('check-plan-approved.sh')));
    assert.ok(scripts.some((s) => s.endsWith('check-role.sh')));
  });
});

test('gate(approved) is downgraded when the branch-tip script reports not-approved', async () => {
  await withTempRepo(async (repoRoot) => {
    const sh = (file) => {
      if (file.endsWith('check-plan-approved.sh')) return { status: 1, stdout: 'not approved', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const evaluateGate = () => ({
      passed: true,
      reason: 'ok',
      requiredRole: 'architect',
      satisfiedBy: { actor: 'architect' },
    });
    const store = createGitStateStore({ repoRoot, sh, evaluateGate });
    const result = await store.gate('demo', 'approved');
    assert.equal(result.passed, false);
    assert.match(result.reason, /check-plan-approved\.sh/);
  });
});

test('append rejects an unsafe feature slug (path traversal) and writes nothing', async () => {
  await withTempRepo((repoRoot) => {
    const store = createGitStateStore({ repoRoot });
    for (const bad of ['../escape', 'a/b', '..', 'UPPER', '']) {
      assert.throws(
        () => store.append({ feature: bad, type: 'deliver-started', actor: 'harness', ts: 't0' }),
        /invalid feature slug|event\.feature is required/,
      );
    }
  });
});

test('append requires event.type and event.actor', async () => {
  await withTempRepo((repoRoot) => {
    const store = createGitStateStore({ repoRoot });
    assert.throws(
      () => store.append({ feature: 'demo', actor: 'harness', ts: 't0' }),
      /event\.type is required/,
    );
    assert.throws(
      () => store.append({ feature: 'demo', type: 'deliver-started', ts: 't0' }),
      /event\.actor is required/,
    );
    // Nothing persisted from the rejected appends.
    assert.equal(store.history('demo').length, 0);
  });
});

test('history/phase/plan reject an unsafe feature slug', async () => {
  await withTempRepo((repoRoot) => {
    const store = createGitStateStore({ repoRoot });
    assert.throws(() => store.history('../x'), /invalid feature slug/);
    assert.throws(() => store.phase('a/b'), /invalid feature slug/);
    assert.throws(() => store.plan('..'), /invalid feature slug/);
  });
});

test('createGitStateStore requires repoRoot', () => {
  assert.throws(() => createGitStateStore({}), /repoRoot is required/);
});
