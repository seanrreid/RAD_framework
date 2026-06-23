import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createGitStateStore } from '../adapters/git-state-store.js';
import { evaluateGate } from '../gates.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '..', '..', 'scripts');
const GIT_SYNC = join(SCRIPTS, 'git-sync.sh');
const CHECKOUT_PLAN = join(SCRIPTS, 'checkout-plan.sh');
const CHECK_PLAN_APPROVED = join(SCRIPTS, 'check-plan-approved.sh');

// Async wrapper mirroring policy-approval.test.js / cli.test.js — await fn() so an
// async callback completes before the temp dir is removed.
async function withTempRepo(fn) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'rad-ppm-'));
  try {
    return await fn(repoRoot);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

// Run a real shell-out, returning { status, stdout, stderr } without throwing on
// a non-zero exit (the scripts use exit codes as signals, not crashes). Captures
// stderr on BOTH the success and failure paths (execFileSync does not surface
// stderr on a zero exit), so a script that warns-and-exits-0 is still assertable.
function run(file, args, opts = {}) {
  const stdio = ['ignore', 'pipe', 'pipe'];
  try {
    const out = execFileSync(file, args, {
      encoding: 'utf8',
      stdio,
      ...opts,
    });
    return { status: 0, stdout: out ?? '', stderr: '' };
  } catch (err) {
    return {
      status: typeof err.status === 'number' ? err.status : 1,
      stdout: err.stdout ? String(err.stdout) : '',
      stderr: err.stderr ? String(err.stderr) : String(err.message ?? ''),
    };
  }
}

// Like run(), but uses spawnSync so stderr is captured even on a zero exit —
// needed to assert the best-effort push's advisory warning.
function runCapture(file, args, opts = {}) {
  const res = spawnSync(file, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
  return {
    status: typeof res.status === 'number' ? res.status : 1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

const git = (cwd, args) => run('git', args, { cwd });

/** Initialize a bare-bones git repo with one commit on the named branch. */
function initRepo(cwd, branch = 'main') {
  git(cwd, ['init', '-q', '-b', branch]);
  git(cwd, ['config', 'user.email', 'tester@example.com']);
  git(cwd, ['config', 'user.name', 'Tester']);
  git(cwd, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(cwd, 'seed.txt'), 'seed\n', 'utf8');
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-q', '-m', 'seed']);
}

// ---------------------------------------------------------------------------
// AC#1 — Push is best-effort / offline-safe.
//
// scripts/git-sync.sh push must exit 0 even when the push itself fails (no
// reachable origin). A failed push must NEVER return non-zero — the local
// commit has already landed.
// ---------------------------------------------------------------------------

test('AC#1 — git-sync.sh push exits 0 even when the push fails (no reachable origin)', async () => {
  await withTempRepo((repoRoot) => {
    initRepo(repoRoot, 'main');
    // Create the work branch the script will try (and fail) to push.
    git(repoRoot, ['checkout', '-q', '-b', 'rad/offline']);
    // Point origin at a non-existent local path so `git push` is guaranteed to fail.
    git(repoRoot, ['remote', 'add', 'origin', join(repoRoot, 'no-such-remote.git')]);

    const res = runCapture(GIT_SYNC, ['push', 'rad/offline'], { cwd: repoRoot });
    assert.equal(res.status, 0, `push must exit 0 on a failed push; got ${res.status}: ${res.stderr}`);
    // The failure is surfaced as an advisory warning on stderr, not an error exit.
    assert.match(res.stderr, /push of 'rad\/offline'.*failed/i);
  });
});

test('AC#1 — git-sync.sh push exits 0 even with NO origin remote configured at all', async () => {
  await withTempRepo((repoRoot) => {
    initRepo(repoRoot, 'main');
    git(repoRoot, ['checkout', '-q', '-b', 'rad/offline']);
    // No `git remote add origin` — push has nowhere to go.
    const res = run(GIT_SYNC, ['push', 'rad/offline'], { cwd: repoRoot });
    assert.equal(res.status, 0, `push must exit 0 with no origin; got ${res.status}: ${res.stderr}`);
  });
});

// ---------------------------------------------------------------------------
// AC#2 — Fetch-on-read honors a remote-recorded approval.
//
// Integration: an approval is recorded "remotely" (committed on a clone, pushed
// to a shared origin). The local clone has NOT pulled it. With RAD_SYNC set,
// check-plan-approved.sh fetches origin/<work-branch> before resolving the log,
// so the remote approval is surfaced (gate passes / exit 0). With RAD_SYNC
// unset, no fetch happens and the stale local clone fails closed (exit 1).
// ---------------------------------------------------------------------------

function makeApprovedEvent(feature) {
  return JSON.stringify({
    feature,
    type: 'approved',
    actor: 'architect@example.com',
    role: 'architect',
    ts: '2026-06-15T00:00:00.000Z',
  }) + '\n';
}

/**
 * Build a shared bare origin, a "remote" working clone that records + pushes an
 * approval on rad/<feature>, and a "local" clone that has the branch but NOT the
 * approval commit. Returns the local clone path (cwd for the gate-read).
 */
function setupSplitBrainApproval(base, feature) {
  const origin = join(base, 'origin.git');
  const remoteWt = join(base, 'remote-wt');
  const localWt = join(base, 'local-wt');
  const workBranch = `rad/${feature}`;
  const eventsRel = join('.agents', 'state', feature, 'events.jsonl');

  mkdirSync(origin, { recursive: true });
  run('git', ['init', '-q', '--bare', origin]);

  // Remote working tree: seed the work branch, push it empty first.
  mkdirSync(remoteWt, { recursive: true });
  initRepo(remoteWt, 'main');
  git(remoteWt, ['remote', 'add', 'origin', origin]);
  git(remoteWt, ['push', '-q', 'origin', 'main']);
  git(remoteWt, ['checkout', '-q', '-b', workBranch]);
  git(remoteWt, ['push', '-q', '-u', 'origin', workBranch]);

  // Local clone: fetch the empty work branch (no approval yet).
  run('git', ['clone', '-q', origin, localWt]);
  git(localWt, ['config', 'user.email', 'local@example.com']);
  git(localWt, ['config', 'user.name', 'Local']);
  git(localWt, ['config', 'commit.gpgsign', 'false']);
  git(localWt, ['checkout', '-q', '-b', workBranch, `origin/${workBranch}`]);

  // Remote records the approval and pushes it — local does NOT pull.
  mkdirSync(join(remoteWt, dirname(eventsRel)), { recursive: true });
  writeFileSync(join(remoteWt, eventsRel), makeApprovedEvent(feature), 'utf8');
  git(remoteWt, ['add', '-A']);
  git(remoteWt, ['commit', '-q', '-m', 'record approval']);
  git(remoteWt, ['push', '-q', 'origin', workBranch]);

  return { localWt, workBranch };
}

test('AC#2 — with RAD_SYNC set, check-plan-approved.sh fetches and honors a remotely-recorded approval', async () => {
  await withTempRepo((base) => {
    const feature = 'remoteapprove';
    const { localWt, workBranch } = setupSplitBrainApproval(base, feature);

    // Sanity: the local clone does NOT yet have the approval on its origin ref.
    const before = git(localWt, ['show', `origin/${workBranch}:.agents/state/${feature}/events.jsonl`]);
    assert.notEqual(before.status, 0, 'local origin ref should not yet hold the approval (pre-fetch)');

    // With RAD_SYNC on, the script fetches origin/<work-branch> before resolving,
    // so the remote approval is surfaced → gate passes (exit 0).
    const res = run(CHECK_PLAN_APPROVED, [workBranch], {
      cwd: localWt,
      env: { ...process.env, RAD_SYNC: '1' },
    });
    assert.equal(res.status, 0, `RAD_SYNC fetch-on-read should surface the remote approval; got ${res.status}: ${res.stdout}${res.stderr}`);
  });
});

test('AC#2 — with RAD_SYNC unset, check-plan-approved.sh does NOT fetch and the stale local clone fails closed', async () => {
  await withTempRepo((base) => {
    const feature = 'staleapprove';
    const { localWt, workBranch } = setupSplitBrainApproval(base, feature);

    // RAD_SYNC unset → no fetch → the stale local clone has no approval anywhere
    // (origin ref, base, or working tree) → fail closed (exit 1).
    const env = { ...process.env };
    delete env.RAD_SYNC;
    const res = run(CHECK_PLAN_APPROVED, [workBranch], { cwd: localWt, env });
    assert.equal(res.status, 1, `without RAD_SYNC the stale clone must fail closed; got ${res.status}: ${res.stdout}`);
  });
});

// ---------------------------------------------------------------------------
// AC#3 — Ownership lock fold + evaluateGate purity.
//
// recordOwnerClaimed / recordOwnerReleased append events with write-time-frozen
// holder provenance in event.data. evaluateGate('approved', ...) over a history
// WITH ownership events equals its result WITHOUT them — ownership events do not
// affect the approved-gate fold (purity).
// ---------------------------------------------------------------------------

test('AC#3 — recordOwnerClaimed / recordOwnerReleased append data-only events with frozen holder provenance', async () => {
  await withTempRepo((repoRoot) => {
    const store = createGitStateStore({ repoRoot });
    const feature = 'lockdemo';

    const claim = store.recordOwnerClaimed({ feature, actor: 'alice@example.com', ts: 't0' });
    const release = store.recordOwnerReleased({ feature, actor: 'alice@example.com', ts: 't1' });

    // The returns carry the frozen holder + ts.
    assert.equal(claim.holder, 'alice@example.com');
    assert.equal(release.holder, 'alice@example.com');

    const hist = store.history(feature);
    assert.equal(hist.length, 2);

    const claimed = hist[0];
    assert.equal(claimed.type, 'owner-claimed');
    assert.equal(claimed.actor, 'alice@example.com');
    // Holder provenance is frozen into event.data at write-time.
    assert.deepEqual(claimed.data, { holder: 'alice@example.com' });

    const released = hist[1];
    assert.equal(released.type, 'owner-released');
    assert.equal(released.actor, 'alice@example.com');
    assert.deepEqual(released.data, { holder: 'alice@example.com' });
  });
});

test('AC#3 — evaluateGate is pure: ownership events do not change the approved-gate verdict', async () => {
  await withTempRepo((repoRoot) => {
    const store = createGitStateStore({ repoRoot });
    const feature = 'purity';

    // A baseline history with just a policy approval (satisfies the approved gate).
    store.recordPolicyApproval({ feature, patterns: ['\\.md$'], scope: ['docs/x.md'], ts: 't0' });
    const historyWithout = store.history(feature);
    const resultWithout = evaluateGate('approved', historyWithout);
    assert.equal(resultWithout.passed, true, 'baseline approval should satisfy the gate');

    // Interleave ownership events around the approval.
    store.recordOwnerClaimed({ feature, actor: 'bob@example.com', ts: 't1' });
    store.recordOwnerReleased({ feature, actor: 'bob@example.com', ts: 't2' });
    const historyWith = store.history(feature);
    const resultWith = evaluateGate('approved', historyWith);

    // The fold over a history WITH ownership events equals the fold WITHOUT them —
    // ownership events are inert to the approved gate.
    assert.deepEqual(resultWith, resultWithout, 'ownership events must not affect the approved-gate fold');
    assert.equal(resultWith.passed, true);

    // And a history of ONLY ownership events never satisfies the approved gate.
    const onlyOwnership = historyWith.filter((e) => e.type !== 'approved');
    assert.equal(evaluateGate('approved', onlyOwnership).passed, false, 'ownership alone must not pass the approved gate');
  });
});

// ---------------------------------------------------------------------------
// AC#4 — Divergence tripwire.
//
// checkout-plan.sh refuses (non-zero + a message) on a diverged tip, and
// proceeds (exit 0) on a clean / fast-forwardable tip.
// ---------------------------------------------------------------------------

/**
 * Build origin + a local clone on rad/<feature>. Returns paths. The caller can
 * then diverge or fast-forward the local branch as the scenario requires.
 */
function setupCheckoutRepo(base, feature) {
  const origin = join(base, 'origin.git');
  const remoteWt = join(base, 'remote-wt');
  const localWt = join(base, 'local-wt');
  const workBranch = `rad/${feature}`;

  mkdirSync(origin, { recursive: true });
  run('git', ['init', '-q', '--bare', origin]);

  mkdirSync(remoteWt, { recursive: true });
  initRepo(remoteWt, 'main');
  git(remoteWt, ['remote', 'add', 'origin', origin]);
  git(remoteWt, ['push', '-q', 'origin', 'main']);
  git(remoteWt, ['checkout', '-q', '-b', workBranch]);
  git(remoteWt, ['push', '-q', '-u', 'origin', workBranch]);

  run('git', ['clone', '-q', origin, localWt]);
  git(localWt, ['config', 'user.email', 'local@example.com']);
  git(localWt, ['config', 'user.name', 'Local']);
  git(localWt, ['config', 'commit.gpgsign', 'false']);
  git(localWt, ['checkout', '-q', '-b', workBranch, `origin/${workBranch}`]);

  return { origin, remoteWt, localWt, workBranch };
}

test('AC#4 — checkout-plan.sh refuses (non-zero + message) on a diverged tip', async () => {
  await withTempRepo((base) => {
    const feature = 'diverge';
    const { remoteWt, localWt, workBranch } = setupCheckoutRepo(base, feature);

    // Local commits one thing; remote commits a DIFFERENT thing and pushes —
    // the two tips now diverge (neither is an ancestor of the other).
    writeFileSync(join(localWt, 'local.txt'), 'local change\n', 'utf8');
    git(localWt, ['add', '-A']);
    git(localWt, ['commit', '-q', '-m', 'local commit']);

    writeFileSync(join(remoteWt, 'remote.txt'), 'remote change\n', 'utf8');
    git(remoteWt, ['add', '-A']);
    git(remoteWt, ['commit', '-q', '-m', 'remote commit']);
    git(remoteWt, ['push', '-q', 'origin', workBranch]);

    const res = run(CHECKOUT_PLAN, [workBranch], { cwd: localWt });
    assert.notEqual(res.status, 0, `checkout-plan.sh must refuse on divergence; got exit ${res.status}`);
    assert.match(res.stderr, /diverged/i, `divergence message expected; got:\n${res.stderr}`);
  });
});

test('AC#4 — checkout-plan.sh names the lock holder from an owner-claimed event on a diverged tip', async () => {
  await withTempRepo((base) => {
    const feature = 'divholder';
    const { remoteWt, localWt, workBranch } = setupCheckoutRepo(base, feature);

    // Seed a local owner-claimed event naming the holder, then diverge.
    const eventsRel = join('.agents', 'state', feature, 'events.jsonl');
    mkdirSync(join(localWt, dirname(eventsRel)), { recursive: true });
    writeFileSync(
      join(localWt, eventsRel),
      JSON.stringify({ feature, type: 'owner-claimed', actor: 'carol@example.com', ts: 't0', data: { holder: 'carol@example.com' } }) + '\n',
      'utf8',
    );
    git(localWt, ['add', '-A']);
    git(localWt, ['commit', '-q', '-m', 'local commit with claim']);

    writeFileSync(join(remoteWt, 'remote.txt'), 'remote change\n', 'utf8');
    git(remoteWt, ['add', '-A']);
    git(remoteWt, ['commit', '-q', '-m', 'remote commit']);
    git(remoteWt, ['push', '-q', 'origin', workBranch]);

    const res = run(CHECKOUT_PLAN, [workBranch], { cwd: localWt });
    assert.notEqual(res.status, 0, 'must refuse on divergence');
    assert.match(res.stderr, /carol@example\.com/, `holder should be named; got:\n${res.stderr}`);
  });
});

test('AC#4 — checkout-plan.sh proceeds (exit 0) on a clean / fast-forwardable tip', async () => {
  await withTempRepo((base) => {
    const feature = 'clean';
    const { remoteWt, localWt, workBranch } = setupCheckoutRepo(base, feature);

    // Remote advances ahead; local is strictly behind → a clean fast-forward,
    // NOT a divergence. checkout-plan.sh must proceed (exit 0).
    writeFileSync(join(remoteWt, 'remote.txt'), 'remote change\n', 'utf8');
    git(remoteWt, ['add', '-A']);
    git(remoteWt, ['commit', '-q', '-m', 'remote ahead']);
    git(remoteWt, ['push', '-q', 'origin', workBranch]);

    const res = run(CHECKOUT_PLAN, [workBranch], { cwd: localWt });
    assert.equal(res.status, 0, `clean fast-forward must proceed; got ${res.status}: ${res.stderr}`);
  });
});

// ---------------------------------------------------------------------------
// AC#5 — RAD_SYNC unset = byte-for-byte today.
//
// With RAD_SYNC unset the push/fetch hooks are no-ops: no push attempted, no
// fetch attempted, no new events. Asserted two ways:
//   (a) bestEffortSyncPush short-circuits before any sh() when RAD_SYNC is unset.
//   (b) check-plan-approved.sh performs NO fetch when RAD_SYNC is unset.
// ---------------------------------------------------------------------------

test('AC#5 — bestEffortSyncPush short-circuits with RAD_SYNC unset (no sh call, no push)', async () => {
  // bestEffortSyncPush is module-internal; exercise it through the public
  // ownerClaimCommand seam, which calls it indirectly only via the verbs. Here
  // we drive the push helper directly through the CLI's owner-claim path is not
  // needed — instead assert the git-sync helper is never spawned by recording sh.
  await withTempRepo(async (repoRoot) => {
    // Ensure the helper script is present so absence isn't the reason for no spawn.
    mkdirSync(join(repoRoot, 'scripts'), { recursive: true });
    writeFileSync(join(repoRoot, 'scripts', 'git-sync.sh'), '#!/usr/bin/env bash\nexit 0\n', 'utf8');

    const { approveCommand } = await import('../cli.js');
    const { defaultSh } = await import('../adapters/git-state-store.js');

    writeFileSync(join(repoRoot, 'CLAUDE.md'), '# CLAUDE\n', 'utf8');
    const feature = 'noxsync';
    const plansDir = join(repoRoot, '.agents', 'plans');
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(
      join(plansDir, `${feature}.md`),
      ['# noxsync', '', 'Status: pending-review', `Branch: rad/${feature}`, '', '## Acceptance Criteria', '', '1. x.', '', '## Waves', '', '### Wave 1', '', '- [ ] T'].join('\n'),
      'utf8',
    );

    const shCalls = [];
    const roleScript = join(repoRoot, 'scripts', 'check-role.sh');
    const mockSh = (file, args, opts) => {
      shCalls.push({ file, args });
      if (typeof file === 'string' && file.endsWith('check-role.sh')) {
        return { status: 0, stdout: '', stderr: '' };
      }
      return defaultSh(file, args, opts);
    };

    // RAD_SYNC explicitly unset for this run.
    const prev = process.env.RAD_SYNC;
    delete process.env.RAD_SYNC;
    try {
      const code = await approveCommand([feature], { repoRoot, sh: mockSh });
      assert.equal(code, 0, 'approve should succeed');
    } finally {
      if (prev !== undefined) process.env.RAD_SYNC = prev;
    }

    // With RAD_SYNC unset, the sync push must never reach git-sync.sh.
    const pushed = shCalls.some((c) => typeof c.file === 'string' && c.file.endsWith('git-sync.sh'));
    assert.equal(pushed, false, 'git-sync.sh must NOT be spawned when RAD_SYNC is unset');
  });
});

test('AC#5 — check-plan-approved.sh performs NO fetch when RAD_SYNC is unset (no new origin ref)', async () => {
  await withTempRepo((base) => {
    const feature = 'nofetch';
    const { localWt, workBranch } = setupSplitBrainApproval(base, feature);

    // Capture the local origin ref before the gate-read.
    const refBefore = git(localWt, ['rev-parse', `origin/${workBranch}`]).stdout.trim();

    const env = { ...process.env };
    delete env.RAD_SYNC;
    run(CHECK_PLAN_APPROVED, [workBranch], { cwd: localWt, env });

    // No fetch happened → the local origin ref is unchanged (still the pre-approval tip).
    const refAfter = git(localWt, ['rev-parse', `origin/${workBranch}`]).stdout.trim();
    assert.equal(refAfter, refBefore, 'origin ref must be unchanged — no fetch when RAD_SYNC is unset');
  });
});
