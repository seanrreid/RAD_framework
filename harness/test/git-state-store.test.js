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

    // approved events must carry a frozen role (transition rule e).
    store.append({ feature, type: 'approved', actor: 'architect', role: 'architect', ts: 't0' });
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
    // approved events must carry role (transition rule e).
    store.append({ feature, type: 'approved', actor: 'architect', role: 'architect', ts: 't0' });
    assert.throws(
      () => store.append({ feature, type: 'approved', actor: 'architect', role: 'architect', ts: 't1' }),
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

test('recordApproval stamps role and appends a proxy-aware approved event', async () => {
  await withTempRepo((repoRoot) => {
    // Inject sh so check-role.sh is not invoked against the real (temp) repo.
    const sh = () => ({ status: 0, stdout: '', stderr: '' });
    const store = createGitStateStore({ repoRoot, sh });
    const feature = 'demo';
    store.recordApproval({ feature, actor: 'architect', recordedBy: 'dev', ts: 't0' });
    const hist = store.history(feature);
    assert.equal(hist.length, 1);
    assert.equal(hist[0].type, 'approved');
    assert.equal(hist[0].actor, 'architect');
    // role is frozen at write-time by recordApproval.
    assert.equal(hist[0].role, 'architect');
    assert.equal(hist[0].recordedBy, 'dev');
  });
});

test('recordApproval refuses and writes nothing when check-role.sh fails', async () => {
  await withTempRepo((repoRoot) => {
    const sh = () => ({ status: 1, stdout: 'Permission denied', stderr: '' });
    const store = createGitStateStore({ repoRoot, sh });
    const feature = 'demo';
    assert.throws(
      () => store.recordApproval({ feature, actor: 'not-an-architect', ts: 't0' }),
      /role check failed/,
    );
    // Nothing written — the log must remain absent.
    assert.equal(store.history(feature).length, 0);
  });
});

test('append(approved) without role is rejected by transition guard (rule e)', async () => {
  await withTempRepo((repoRoot) => {
    const store = createGitStateStore({ repoRoot });
    const feature = 'demo';
    // Bypass recordApproval and directly append an approved event without role —
    // validateTransition must reject it.
    assert.throws(
      () => store.append({ feature, type: 'approved', actor: 'architect', ts: 't0' }),
      (err) => {
        assert.ok(err instanceof TransitionError);
        assert.equal(err.rule, 'approved-missing-role');
        return true;
      },
    );
    assert.equal(store.history(feature).length, 0);
  });
});

test('gate(approved) is a pure fold — no sh called, decides from history alone (passed:true)', async () => {
  await withTempRepo(async (repoRoot) => {
    const shCalls = [];
    const sh = (file, args) => {
      shCalls.push({ file, args });
      return { status: 0, stdout: '', stderr: '' };
    };
    // Inject the gate evaluator to control what evaluateGate returns.
    const evaluateGate = (_name, _hist) => ({
      passed: true,
      reason: 'ok',
      requiredRole: 'architect',
      satisfiedBy: { actor: 'sean@torchcodelab.com', role: 'architect', recordedBy: 'dev' },
    });
    const store = createGitStateStore({ repoRoot, sh, evaluateGate });
    const feature = 'demo';
    store.recordApproval({ feature, actor: 'sean@torchcodelab.com', recordedBy: 'dev', ts: 't0' });

    const result = await store.gate(feature, 'approved');
    assert.equal(result.passed, true);
    assert.deepEqual(result.satisfiedBy, { actor: 'sean@torchcodelab.com', role: 'architect', recordedBy: 'dev' });
    // Pure fold: gate() must NOT call any shell scripts.
    // (sh is still injected; calls from recordApproval are separate — we verify
    //  that no calls happened AFTER the store was created, but recordApproval may
    //  call sh for the write-time role check. Reset to isolate gate() calls.)
    shCalls.length = 0;
    await store.gate(feature, 'approved');
    assert.equal(shCalls.length, 0, 'gate() must not invoke sh at read-time');
  });
});

test('gate(approved) returns passed:false for a role-less event (pure fold, no sh)', async () => {
  await withTempRepo(async (repoRoot) => {
    const shCalls = [];
    const sh = (file, args) => {
      shCalls.push({ file, args });
      return { status: 0, stdout: '', stderr: '' };
    };
    // Inject evaluateGate to simulate a history with no matching role.
    const evaluateGate = (_name, _hist) => ({
      passed: false,
      reason: 'needs an approved event with role:architect frozen at write-time',
      requiredRole: 'architect',
      satisfiedBy: null,
    });
    const store = createGitStateStore({ repoRoot, sh, evaluateGate });

    shCalls.length = 0; // isolate gate() from any prior calls
    const result = await store.gate('demo', 'approved');
    assert.equal(result.passed, false);
    assert.match(result.reason, /architect/);
    assert.equal(result.satisfiedBy, null);
    // Still no sh calls from gate() itself.
    assert.equal(shCalls.length, 0, 'gate() must not invoke sh even on failure');
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
