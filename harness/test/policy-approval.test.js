import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createGitStateStore } from '../adapters/git-state-store.js';
import { evaluateGate } from '../gates.js';

// Async so an async `fn` is fully awaited BEFORE the temp dir is removed (see the
// note in git-state-store.test.js). `await fn(...)` is a no-op for sync callbacks.
async function withTempRepo(fn) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'rad-policy-'));
  try {
    return await fn(repoRoot);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

// ── Provenance: the policy (severity-gate) write path stamps the right shape ───
test('recordPolicyApproval appends an approved event with severity-gate / policy provenance + patterns+scope', async () => {
  await withTempRepo((repoRoot) => {
    const store = createGitStateStore({ repoRoot });
    const feature = 'demo';
    const patterns = ['\\.md$', '\\.css$'];
    const scope = ['docs/guide.md', 'styles/main.css'];

    store.recordPolicyApproval({ feature, patterns, scope, ts: 't0' });

    const hist = store.history(feature);
    assert.equal(hist.length, 1);
    const ev = hist[0];
    assert.equal(ev.type, 'approved');
    // Frozen provenance: machine actor, architect authority by policy.
    assert.equal(ev.actor, 'severity-gate');
    assert.equal(ev.role, 'architect');
    assert.equal(ev.recordedBy, 'policy');
    // The audit payload carries the matched patterns + the scope set it covered.
    assert.deepEqual(ev.data, { patterns, scope });
  });
});

test('recordPolicyApproval defaults patterns+scope to empty arrays when omitted', async () => {
  await withTempRepo((repoRoot) => {
    const store = createGitStateStore({ repoRoot });
    store.recordPolicyApproval({ feature: 'demo', ts: 't0' });
    const ev = store.history('demo')[0];
    assert.deepEqual(ev.data, { patterns: [], scope: [] });
  });
});

// ── evaluateGate accepts the policy approval exactly like a human one ──────────
test("evaluateGate('approved', history) returns passed:true on a policy approval", async () => {
  await withTempRepo((repoRoot) => {
    const store = createGitStateStore({ repoRoot });
    const feature = 'demo';
    store.recordPolicyApproval({
      feature,
      patterns: ['\\.md$'],
      scope: ['docs/guide.md'],
      ts: 't0',
    });

    // The real gate fold (no injection) — proves the policy event satisfies the
    // approved gate identically to a human approval (authority rides on `role`).
    const result = evaluateGate('approved', store.history(feature));
    assert.equal(result.passed, true);
    assert.equal(result.requiredRole, 'architect');
    assert.deepEqual(result.satisfiedBy, {
      actor: 'severity-gate',
      role: 'architect',
      recordedBy: 'policy',
    });
  });
});

// ── The policy path does NOT invoke check-role.sh (spied sh records zero calls) ─
test('recordPolicyApproval branches around check-role.sh (no role-check spawn)', async () => {
  await withTempRepo((repoRoot) => {
    const shCalls = [];
    const sh = (file, args, opts) => {
      shCalls.push({ file, args, opts });
      return { status: 0, stdout: '', stderr: '' };
    };
    const store = createGitStateStore({ repoRoot, sh });

    store.recordPolicyApproval({
      feature: 'demo',
      patterns: ['\\.md$'],
      scope: ['docs/guide.md'],
      ts: 't0',
    });

    // The policy path establishes authority at config time, not at runtime — it
    // must never shell out to check-role.sh (or anything else).
    assert.equal(shCalls.length, 0, 'policy path must not invoke any shell-out');
    const calledRoleCheck = shCalls.some((c) => /check-role\.sh$/.test(c.file));
    assert.equal(calledRoleCheck, false, 'policy path must not invoke check-role.sh');
    // And the event still landed.
    assert.equal(store.history('demo').length, 1);
  });
});

// ── The human path's existing behavior is untouched: it DOES call check-role.sh ─
test('recordApproval (human path) still invokes check-role.sh — policy path does not relax it', async () => {
  await withTempRepo((repoRoot) => {
    const shCalls = [];
    const sh = (file, args, opts) => {
      shCalls.push({ file, args, opts });
      return { status: 0, stdout: '', stderr: '' };
    };
    const store = createGitStateStore({ repoRoot, sh });

    store.recordApproval({ feature: 'demo', actor: 'architect', recordedBy: 'dev', ts: 't0' });

    const roleCall = shCalls.find((c) => /check-role\.sh$/.test(c.file));
    assert.ok(roleCall, 'human path must still invoke check-role.sh');
    // Authority is verified for the architect role, against the actor identity.
    assert.equal(roleCall.args[0], 'architect', 'check-role.sh must be asked for the architect role');
    assert.equal(roleCall.args[roleCall.args.length - 1], 'architect', 'check-role.sh must be passed the actor identity');
    // And its event has human provenance, distinct from the policy path.
    const ev = store.history('demo')[0];
    assert.equal(ev.actor, 'architect');
    assert.equal(ev.role, 'architect');
    assert.notEqual(ev.recordedBy, 'policy');
  });
});

// ── A failing role check on the human path REJECTS the approval (no event lands) ─
test('recordApproval (human path) is rejected when check-role.sh returns non-zero', async () => {
  await withTempRepo((repoRoot) => {
    const shCalls = [];
    // Injected sh: check-role.sh fails (actor does not hold the architect role).
    const sh = (file, args, opts) => {
      shCalls.push({ file, args, opts });
      if (/check-role\.sh$/.test(file)) return { status: 1, stdout: 'not an architect', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const store = createGitStateStore({ repoRoot, sh });

    // The role check fails ⇒ recordApproval must throw and NOT record an event.
    assert.throws(
      () => store.recordApproval({ feature: 'demo', actor: 'mallory', recordedBy: 'mallory', ts: 't0' }),
      /role check failed/,
      'a failed role check must reject the approval',
    );
    assert.equal(store.history('demo').length, 0, 'no approved event may be recorded when the role check fails');
  });
});
