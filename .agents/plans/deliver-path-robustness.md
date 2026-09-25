# Plan: Deliver-Path Robustness
Created: 2026-09-25
Author: architect
Status: approved
Approved-By: sean@torchcodelab.com
Approved-At: 2026-09-25T16:20:09.567Z
Recorded-By: sean@torchcodelab.com
Branch: rad/deliver-path-robustness
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/129
Issue-Title: Command adapter never kills the agent on timeout (orphaned CLI); probe timeout is hard-coded and mislabelled 'wave timed out'

## Context

This plan batches two deliver-path bugs, and closes both #129 and #113.

**#129.** When the command adapter's wall-clock timeout fires, RAD stops waiting
but never stops the agent. `withTimeout` (`harness/adapters/agent/contract.js`)
aborts an `AbortController` only if one is passed. `sdk.js` passes one;
`command.js` passes none at either call site (`probeCommand`, `runCommand`), and
`spawnOnce` gets no signal. The agent CLI survives as an orphan and may keep
editing the tree after its wave was recorded as `fail-timeout`. There are two
smaller problems too: the preflight timeout (60s) can't be configured from the
CLI, and it reports as "wave timed out".

**#113.** `RAD_WORKTREE` can't succeed for any Lane B plan. `deliverCommand`
reads the plan doc from the main working tree before creating the worktree, but
under Lane B the plan only exists on `rad/<feature>`, and that branch can't be
checked out in the main tree if a worktree is to be added for it. Research found
the problem is wider than the issue says: the approval gate, the plan's wave list
(`git-state-store.plan()`) and the event log are **all** read from `repoRoot`, the
main checkout. So with `main` checked out, the gate can't see the approval either,
and a worktree deliver would write its events into the main tree. Reading only the
plan doc via `git show` (the issue's option 1) would not be enough.

#119 (record `wave-started` before `runWave`) was scoped into this batch, then
split out. It touches different files (`spine.js`, `events.js`), changes the event
sequence of every deliver, and needs design calls this plan shouldn't make.

## Scope

| In scope | Out of scope |
|---|---|
| Kill the command adapter's child on timeout (wave and probe), SIGTERM then SIGKILL after a named grace period | The SDK adapter (already aborts via its controller) |
| A `withTimeout` label so probe timeouts say "agent preflight"; wave messages unchanged | Changing the `_isRadTimeout` sentinel or how callers detect timeouts |
| `RAD_AGENT_PREFLIGHT_TIMEOUT_SECONDS`, with malformed values a hard error (exit 2) like `RAD_VERIFY_TIMEOUT_SECONDS` | #119's `wave-started` event, orphan convergence and resume attempt seeding |
| Worktree mode: gate via the branch tip, create the worktree, then root the plan read, state store and spine at the worktree | Making worktree isolation the default (#61) |
| Document the Lane B interaction and the new knob | Changing `scripts/worktree-lifecycle.sh` or the lifecycle marker contract |

## Acceptance Criteria

1. After a command-adapter wall-clock timeout (wave **or** preflight), the spawned agent process is terminated: SIGTERM, then SIGKILL after a named grace constant if it's still alive. A test with a fake agent that records its PID and sleeps shows the process is gone after the timeout, and that a post-timeout marker file is never written.
2. An in-process `probeCommand` / `runCommand` call against a hanging fake agent resolves promptly after the timeout, without waiting for the child to exit on its own.
3. A preflight timeout's error names the preflight (`agent preflight timed out after <ms>ms`). The wave timeout message is byte-identical to today's (`wave timed out after <ms>ms`), and `_isRadTimeout` is still set on both.
4. `RAD_AGENT_PREFLIGHT_TIMEOUT_SECONDS` sets the probe deadline when it's a positive integer. Unset or empty means the 60s default. A malformed value (non-numeric, zero, negative) makes `rad deliver` exit 2 with a message naming the variable, never a silent fallback.
5. With `RAD_WORKTREE=1` and the main checkout on the default branch, `rad deliver <feature>` succeeds for a plan (and approval) that exists **only** on `rad/<feature>`. The gate is evaluated against the branch tip, the worktree is created on the work branch, and the plan read, state store (events read and written) and spine all run rooted at the worktree. The main checkout's working tree is left unmodified.
6. In worktree mode, an unapproved branch tip fails the gate **before** any worktree is created. The non-worktree path (`RAD_WORKTREE` unset) is behaviourally unchanged: existing `deliver.test.js` and `worktree.test.js` cases pass as they are.
7. CLAUDE.md documents `RAD_AGENT_PREFLIGHT_TIMEOUT_SECONDS` (Agent Adapter section) and the worktree/Lane B interaction (Worktree Isolation section), including that the main checkout must not have the work branch checked out. `docs/rad-cli.md` matches. `npm test --prefix harness` passes.

## Agent Scope

No agents were called. Research was one Explore sub-agent (10 of 10 searches)
covering `contract.js` / `command.js` / `sdk.js` timeouts, the `cli.js` deliver
path, `git-state-store.js` read sites, `spine.js` resume and attempt counting,
`transitions.js`, the `events.js` folds, `gates.js`, the worktree adapter, and the
deliver/worktree/spine tests.

## Files in Scope

| File | Lines | Change |
|------|-------|--------|
| harness/adapters/agent/contract.js | 565-598 | `withTimeout` takes an optional label (default `'wave'`) |
| harness/adapters/agent/command.js | 60-290 | AbortController per call; `spawnOnce` accepts a signal and kills on abort (SIGTERM, then SIGKILL after grace); probe passes the `'agent preflight'` label |
| harness/cli.js | 396-590 | Preflight timeout knob; worktree-mode reorder (branch-tip gate, create worktree, re-root plan read / state / spine) |
| harness/test/agent-adapters.test.js | 800-860 | Kill-on-timeout, prompt-return, label, and knob tests |
| harness/test/worktree.test.js | 100-280 | Lane B fixture: plan and approval only on `rad/<feature>`; unapproved-tip-fails-before-create; main tree untouched |
| CLAUDE.md | 105-200 | Agent Adapter: preflight timeout knob. Worktree Isolation: Lane B interaction |
| docs/rad-cli.md | 100-200 | The same two additions |

## Program Design

```js
// contract.js
export function withTimeout(promise, ms, abortController, label = 'wave')
// → rejects Error(`${label} timed out after ${ms}ms`) with err._isRadTimeout = true

// command.js
const KILL_GRACE_MS = 5_000;
function spawnOnce(cmd, prompt, cwd, model, { signal } = {})   // abort → SIGTERM, grace → SIGKILL
export async function probeCommand({ cmd, repoRoot, timeoutMs })  // passes 'agent preflight'
```

```
rad deliver <f>   (RAD_WORKTREE set)
  ├─ branch   = rad/<f>   (RAD_BRANCH_PREFIX aware; the existing fallback)
  ├─ gate     = evaluate approved over `git show <branch>:.agents/state/<f>/events.jsonl`
  │             (the same branch-tip read as check-plan-approved.sh / `rad gate --stdin`)
  │             fail → exit 1, no worktree
  ├─ wt       = worktree.create(f, branch)
  ├─ root     = wt                     ← plan read, git-state-store, sh cwd all use root
  ├─ planCtx  = parsePlanCtx(read(root/.agents/plans/<f>.md))
  ├─ preflight (unchanged; timeout knob)
  └─ deliverSpine({ state: store(root), ... })  → complete / preserve (unchanged)

rad deliver <f>   (RAD_WORKTREE unset) → today's order, unchanged
```

No files are added, moved or deleted.

## Execution Notes

### Do Not Touch
- `harness/spine.js`, `harness/events.js`, `harness/transitions.js`, `harness/gates.js`: no event, fold or transition change (that is #119's territory).
- `harness/adapters/agent/sdk.js`: the reference pattern, already correct.
- `harness/adapters/worktree.js` and `scripts/worktree-lifecycle.sh`: the `create(feature, branch)` contract is enough.
- `harness/adapters/git-state-store.js`: re-root it by constructing it with the worktree path rather than editing it. If it hard-codes `repoRoot` in a way that prevents that, stop and report `blocked_intent`.
- `harness/matrix.yaml`, `harness/matrix.js`.

### Key Files
- `harness/adapters/agent/contract.js`: `withTimeout` and the `_isRadTimeout` sentinel.
- `harness/adapters/agent/sdk.js`: the AbortController pattern to copy.
- `harness/adapters/agent/command.js`: `spawnOnce` (it already kills on output overflow, so reuse that path), `probeCommand`, `runCommand`.
- `harness/cli.js`: `preflightPassed`, the plan read, the gate check, adapter construction, worktree creation, and the `deliverSpine` call, including how `sh` and `state` are constructed from `repoRoot`.
- `harness/adapters/git-state-store.js`: how it is constructed and which paths it derives from `repoRoot`.
- `scripts/check-plan-approved.sh` and the `gate --stdin` path in `cli.js`: the existing branch-tip gate read to reuse.
- `scripts/check-verify.sh`: the `RAD_VERIFY_TIMEOUT_SECONDS` malformed-is-exit-2 convention.
- `harness/test/worktree.test.js`, `harness/test/agent-adapters.test.js`: the fake-`sh` and `fakeCmd` patterns.

### Reminders
- Wave timeout message bytes must not change (`agent-adapters.test.js` asserts `timed out after <ms>ms`, and operators may grep logs).
- Kill tests must not leave stray processes. Clean up by PID in `finally`.
- Only the worktree path is reordered. The non-worktree deliver must stay byte-for-byte identical in behaviour and event sequence.
- Named constants for the grace period and the default preflight timeout. Never swallow errors: a failed kill is logged with context, not ignored.
- `harness/` is self-protected, so this plan is never auto-clearable.

## Wave Plan

### Wave 1 — sequential
Verify: npm test --prefix harness

#129: both tasks touch the timeout path (`contract.js` / `command.js`, then `cli.js`).

#### Task 1.1: Kill the agent on timeout and label the probe timeout
File: harness/adapters/agent/contract.js, harness/adapters/agent/command.js, harness/test/agent-adapters.test.js
What: Add an optional `label` parameter (default `'wave'`) to `withTimeout`. In `command.js`, create an `AbortController` per `probeCommand` / `runCommand` call and pass it to `withTimeout`, and pass its signal into `spawnOnce`. On abort, send the child SIGTERM, then SIGKILL after `KILL_GRACE_MS` if it hasn't exited. Reuse the existing overflow-kill path where possible, and log (don't swallow) a kill error. The probe passes `'agent preflight'`. Tests use a fake agent that writes its PID and sleeps, plus a small timeout: the PID is dead after the timeout, a post-timeout marker is never written, the call resolves promptly, a probe timeout error reads `agent preflight timed out after <ms>ms`, a wave timeout still reads `wave timed out after <ms>ms`, and `_isRadTimeout` is set on both.
Validate: AC#1, AC#2, AC#3 — `npm test --prefix harness` passes, including the new cases, with no stray processes left.

#### Task 1.2: Configurable preflight timeout
File: harness/cli.js:396-420, harness/test/agent-adapters.test.js
What: `preflightPassed` reads `RAD_AGENT_PREFLIGHT_TIMEOUT_SECONDS`. Unset or empty uses the default. A positive integer is converted to ms and passed as `timeoutMs`. Any other value makes `rad deliver` write `rad deliver: RAD_AGENT_PREFLIGHT_TIMEOUT_SECONDS must be a positive integer (got '<v>')` and return 2, before the probe runs. Tests: valid value passed through (observable via a fast timeout against a sleeping fake); malformed values `abc`, `0` and `-5` each return 2 with the message; unset uses the default.
Validate: AC#4 — `npm test --prefix harness` passes.

### Wave 2 — sequential
Depends on: Wave 1 complete (both edit `cli.js`)
Verify: npm test --prefix harness

#### Task 2.1: Worktree mode reads everything from the work branch
File: harness/cli.js:420-590, harness/test/worktree.test.js
What: When `RAD_WORKTREE` is set, reorder `deliverCommand`:
1. Resolve the work branch by the existing convention (`RAD_BRANCH_PREFIX` + feature).
2. Evaluate the approved gate over the branch tip's event log (`git show <branch>:.agents/state/<f>/events.jsonl`), reusing the `gate --stdin` evaluation. Fail with the existing gate message and exit 1 *before* creating a worktree.
3. Create the worktree.
4. From then on use the worktree path as the root for the plan read (`parsePlanCtx`), the state store, the `sh` cwd and the spine.

Restate the v1 constraint comment to say what the operator must do: keep the work branch checked out nowhere else, e.g. stay on the default branch. Leave the non-worktree path exactly as it is. Tests (fake `sh`): a Lane B fixture where the plan and approval exist only via `git show rad/<f>:…` and not on disk in `repoRoot` delivers successfully in worktree mode, with state reads and writes under the worktree root and nothing written under the main `repoRoot/.agents/state`; an unapproved branch tip fails before any `worktree-lifecycle.sh create` call; existing worktree and deliver tests pass unchanged.
Validate: AC#5, AC#6 — `npm test --prefix harness` passes, including the new Lane B cases and every existing `deliver.test.js` / `worktree.test.js` case.

#### Task 2.2: Document the knob and the Lane B interaction
File: CLAUDE.md, docs/rad-cli.md
What: CLAUDE.md Agent Adapter section: add `RAD_AGENT_PREFLIGHT_TIMEOUT_SECONDS` (default 60, malformed is exit 2). Worktree Isolation section: explain that in worktree mode the gate, plan and event log are read from the work branch, so the main checkout should stay on the default branch, and the branch must not be checked out there. `docs/rad-cli.md`: the same two additions, in its existing format.
Validate: AC#7 — both files state the knob and the interaction; `npm test --prefix harness` passes.

## Tests to Write
- [ ] Timeout kills the fake agent (PID gone, no post-timeout marker) and the call returns promptly, for wave and probe — harness/test/agent-adapters.test.js
- [ ] Probe timeout message names the preflight; wave message unchanged; sentinel set on both — harness/test/agent-adapters.test.js
- [ ] RAD_AGENT_PREFLIGHT_TIMEOUT_SECONDS valid value applied; abc, 0 and -5 exit 2 with the message — harness/test/agent-adapters.test.js
- [ ] Worktree mode delivers a plan present only on the rad branch, state rooted at the worktree, main tree untouched — harness/test/worktree.test.js
- [ ] Worktree mode with an unapproved branch tip fails before any worktree is created — harness/test/worktree.test.js

## Non-Goals
- #119: `wave-started`, orphan convergence, and seeding attempts or doom-loop state from history on resume.
- Making worktree isolation the default (#61).
- Changing the SDK adapter's timeout behaviour.
- Reading event logs from branch tips outside worktree mode.

## Out-of-Scope Dependencies
None. Every file is architect-writable.

## Risks
- **Process-kill tests can be flaky or leave strays.** Use short, deterministic sleeps, assert by PID, and always clean up in `finally`.
- **SIGTERM-ignoring agents:** handled by the SIGKILL escalation after `KILL_GRACE_MS`.
- **The worktree reorder touches the deliver entry point.** The non-worktree path must stay untouched, which the existing tests guard. The reorder only runs under `RAD_WORKTREE`, which today can't succeed for any Lane B plan, so there's no working behaviour to regress.
- **Events written in the worktree land on the work branch's working copy, not the main tree.** That is correct under Lane B (the log belongs on `rad/<feature>`), but it differs from where a pre-Lane-B worktree run would have written. It's documented in AC#7.

## Issue Gaps

- **#113 fix design: reorder rather than `git show` the plan doc.** #113 leaned toward option 1 (read the plan via `git show`), but research found the gate and the event log are also read from the main tree, so option 1 alone would still fail at the gate. This plan uses a branch-tip gate first, then creates the worktree, then roots everything there. *Verify: agree, or prefer a branch-aware read inside `git-state-store`?*
- **Probe-timeout knob name and units.** `RAD_AGENT_PREFLIGHT_TIMEOUT_SECONDS` (seconds, malformed means exit 2) mirrors `RAD_VERIFY_TIMEOUT_SECONDS`. #129 left the knob optional. *Verify: is a knob wanted at all, or keep 60s fixed?*
- **Kill escalation.** SIGTERM, then SIGKILL after `KILL_GRACE_MS = 5000`. #129 suggested this shape without numbers. *Verify: is 5s the right grace period?*
- **#119 split out.** It changes every deliver's event sequence and needs three design calls: how an orphan is classified (`fail-timeout → surface` or `fail-tests → revision`); whether resume should seed `MAX_ATTEMPTS` and the doom-loop fingerprint from history for *all* waves (today both reset on every run, orphan or not); and whether to land #67's replay check first. *Verify: plan #119 separately once those are decided.*
