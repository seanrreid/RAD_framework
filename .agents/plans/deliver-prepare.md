# Plan: rad deliver Prepare Phase — Sync, Merge, In-Progress (#186 part 3b-i)
Created: 2026-10-07
Author: architect
Status: in-progress
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-07T18:45:33.826Z
Recorded-By: sean@torchcodelab.com
Branch: rad/deliver-prepare
Issue: 186
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/186
Issue-Title: Codex parity for state-changing RAD workflow

## Context
Part 3 makes `rad deliver` the only deliver path for every tool (decision C on #186, 2026-10-07). Today the `/rad-deliver` prose brings the branch up to date, commits `Status: in-progress` and labels the issue before any wave, but `rad deliver` does none of that. Its first remote contact is the push inside `open-pr.sh`, after every wave has run.

On 2026-10-07 the user decided three things for 3b-i:
1. Bring the branch up to date with main by **merging** `origin/<default>` into the work branch, never rebasing.
2. Require a reachable remote, failing early before any wave if the fetch or push fails.
3. Run these steps **inside the spine**, as a prepare phase right after `deliver-started`, reached through an injected port. A merge conflict is then an ordinary `needs-decision` stop that `--resume` can continue.

The end-of-run steps (3b-ii) and the PR body (3b-iii) are separate plans.

## Scope
| In scope | Out of scope |
|---|---|
| An optional `prepare` port in `deliverSpine` and an audit-only `run-prepared` event | `complete`/`Completed-At`, `review` label, `pr-opened` commit/push (3b-ii) |
| Two new stop reasons: `merge-conflict` (needs-decision) and `prepare-failed` (failed) | The PR body and existing-PR handling (3b-iii) |
| A real `prepare` port in the CLI: fetch, fast-forward from origin, merge `origin/<default>`, commit and push `Status: in-progress`, label `in-progress` | The test wave (3c), the deliver skill (3d) |
| The CLI supplies the port in both worktree and main mode | Changing `checkout-plan.sh` (#201) |
| Tests: spine phase, the real-git port, CLI wiring; the offline eval reworked to keep an origin | Changing how waves run |
| Docs: stop table, event list, rad-cli deliver section | |

## Acceptance Criteria
1. **The spine port.** `deliverSpine` accepts an optional `prepare` port, an async function with no arguments that returns `{ ok: true, data }` or `{ ok: false, stopped: 'merge-conflict' | 'prepare-failed', detail }`.
   - When it's supplied, the spine calls it once, right after `deliver-started` and any `run-resumed`, and before the first wave or orphan handling.
   - On success it appends `run-prepared` with the port's `data`.
   - On failure it stops the run through `stopRun` with the given `stopped` value and `detail`, appending no `run-prepared`.
   - When it's not supplied, the spine behaves exactly as today, with the same event sequence.
2. **The stop reasons.** `harness/stops.js` `STOP_TABLE` has `merge-conflict`, class `needs-decision`, decision "merging origin/{base} into {branch} conflicts ({detail}); resolve the conflict on the branch, commit, and re-run with --resume". It also has `prepare-failed`, class `failed`, decision "prepare failed: {detail}". `rad deliver` exits 3 and 1 for them respectively, through the existing `reportStop`.
3. **The event.** `run-prepared` is an audit-only event: absent from `PHASE_BY_TYPE`, documented in the events.js type list. Its `data` is `{ base, merged: bool, fastForwarded: bool, committed: bool, pushed: bool }`.
4. **What the real port does, in order.** It runs in the run's root: the worktree in worktree mode, or the repo root in main mode.
   - **(a) Ready check.** `requirePublishReady(sh, root, workBranch)`: HEAD must be the work branch with nothing staged. A refusal is `prepare-failed`.
   - **(b) Fetch.** `git fetch origin <default> <workBranch>`. A failure is `prepare-failed`, with detail "cannot reach origin: …".
   - **(c) Catch up with the remote branch.** If `origin/<workBranch>` exists and is not an ancestor of HEAD, fast-forward to it with `merge --ff-only`. If that can't fast-forward, it's `prepare-failed` with "diverged from origin/<branch>".
   - **(d) Catch up with main.** If `origin/<default>` is not an ancestor of HEAD, run `git merge --no-edit origin/<default>`. On a conflict, run `git merge --abort` and return `merge-conflict`, with the conflicted paths (`git diff --name-only --diff-filter=U`, captured before the abort) as detail. Any other merge failure is `prepare-failed`.
   - **(e) Mark in progress.** If the plan header Status isn't `in-progress`, write it with `setPlanStatus`.
   - **(f) Publish.** Call `publishPlanChange` with `paths: [plan]`, the message `deliver(<f>): begin execution` plus `Plan:` and `Issue:` lines, the issue from `planIssueNumber`, and `labelStatus: 'in-progress'`. This also pushes the merge commit when nothing else changed. A non-zero result is `prepare-failed` with its message.
   - **(g) Return** `{ ok: true, data }`.
5. **Safe to repeat.** Running the port twice on an up-to-date, already-in-progress branch makes no new commit, does no merge and pushes nothing; it only labels and returns `ok`. After a resolved conflict (the user merges and commits), `--resume` reruns the port, which merges nothing new, publishes the status and continues to the first wave that isn't complete.
6. **Wiring.** `rad deliver` supplies the real port in both modes, built from the run root, the work branch (`resolveWorkBranch`), the default branch (`readDefaultBranch`), the plan path and the injected `sh`. A test context can inject `ctx.prepare` to replace it, as it can `ctx.runWave`. Every existing cli, worktree and deliver test keeps passing, through test helpers that inject a no-op port; no assertions change.
7. **Real git and evals.**
   - **Port tests:** `harness/test/deliver-prepare.test.js` runs the real port against real git with a bare origin. Cases:
     - already up to date: no-op, labels only;
     - main ahead: merges and pushes;
     - remote branch ahead: fast-forwards;
     - local and remote branch diverged: `prepare-failed`;
     - merge conflict: `merge-conflict`, the merge is aborted, and the tree is clean and unchanged;
     - fetch failure with no origin: `prepare-failed` "cannot reach origin";
     - wrong branch or staged changes: `prepare-failed`;
     - Status written and pushed once, then idempotent;
     - no `Issue:`: "label skipped".
   - **Evals:** `node --test harness/evals/*.eval.js` passes. `push-check-unavailable-offline` is reworked to keep a reachable origin while still making the default-tip read fail, so it still tests the push guard. The fixture's approve-and-commit flow still works.
8. **Docs.**
   - `docs/rad-wave-contract.md`: the stop table gains both rows, and the prepare phase is described.
   - `docs/rad-cli.md` `### rad deliver`: the prepare phase and that deliver needs a reachable remote, the exit-3 merge-conflict stop with the `--resume` flow, and the main-mode requirement to be on the work branch.
   - `harness/events.js`: the type list documents `run-prepared`.

## Agent Scope
Research was done through a read-only sub-agent survey of deliverCommand, the spine, stops, events, open-pr.sh, branch-publish, plan-commit, tests and evals, plus targeted greps in this session. There are no out-of-scope dependencies.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| harness/spine.js | 1-80 | Read: `stopRun` |
| harness/spine.js | 540-612 | `deliverSpine` options doc and signature gain `prepare`; call it after `deliver-started`/`run-resumed` |
| harness/stops.js | 1-121 | `merge-conflict` and `prepare-failed` rows |
| harness/events.js | 14-45 | Document the audit-only `run-prepared` |
| harness/deliver-prepare.js | 1-1 | New: `makePreparePort({ sh, root, feature, planPath, workBranch, baseBranch })` |
| harness/branch-publish.js | 1-142 | Read only: `requirePublishReady`, `publishPlanChange` |
| harness/plan-commit.js | 228-278 | Read only: `setPlanStatus` |
| harness/cli.js | 1001-1030 | `setupMainRun`: expose root and plan path for the port |
| harness/cli.js | 1204-1235 | `setupWorktreeRun`: the same |
| harness/cli.js | 1456-1510 | `resolveWorkBranch`, `readDefaultBranch` and `makeScriptCtx` reused to build the port |
| harness/cli.js | 1640-1700 | `deliverCommand`: build the port (or use `ctx.prepare`) and pass it to `deliverSpine` |
| harness/test/spine-prepare.test.js | 1-1 | New: the prepare phase in the spine (event order, both stops, absent port unchanged, resume reruns prepare) |
| harness/test/deliver-prepare.test.js | 1-1 | New: the real port against real git (AC#7) |
| harness/test/cli.test.js | 555-600 | `runDeliverCaptured` injects a no-op `prepare` by default; one wiring case asserts the port is called |
| harness/test/worktree.test.js | 170-260 | The deliver helper injects a no-op `prepare` |
| harness/test/deliver.test.js | 1-60 | Inject a no-op `prepare` where deliver is called |
| harness/evals/lib/fixture.js | 100-170 | Keep the fixture compatible (clean index, on the work branch); adjust only if needed |
| harness/evals/delivery.eval.js | 55-192 | Rework `push-check-unavailable-offline` to keep an origin |
| docs/rad-wave-contract.md | 328-372 | Stop table rows; prepare phase note |
| docs/rad-cli.md | 485-520 | The deliver section: prepare phase, reachable remote, main-mode branch requirement |
| docs/rad-cli.md | 640-670 | Exit-code table and Resuming: `merge-conflict` |

## Execution Notes

### Do Not Touch
- harness/gates.js, harness/transitions.js — the fold and phases don't change; `run-prepared` is audit-only
- scripts/open-pr.sh, scripts/checkout-plan.sh, scripts/worktree-lifecycle.sh
- harness/adapters/agent/* — wave execution is unchanged
- The `POST_CHECKS` sequence and `pr-opened` (3b-ii)

### Key Files
- harness/spine.js `stopRun` (~59) and the start of `deliverSpine` (~569-612): where `deliver-started` and `run-resumed` are appended
- harness/stops.js `STOP_TABLE` and `classifyStop`: placeholder filling (`{wave}`, `{check}` …)
- harness/branch-publish.js: `requirePublishReady`, `publishPlanChange` (resumable commit/push/label)
- harness/plan-commit.js: `setPlanStatus`, `planIssueNumber`
- harness/cli.js `setupMainRun` (1001), `setupWorktreeRun` (1204), `resolveWorkBranch` (1460), `readDefaultBranch` (1469), `makeScriptCtx` (1482), the `deliverSpine` call (1654), `reportStop`
- harness/test/cli-plan-status.test.js: the real-git bare-origin setup to copy for deliver-prepare.test.js
- harness/test/spine.test.js (top ~120 lines): the fake ports and helpers to reuse for spine-prepare.test.js
- harness/evals/delivery.eval.js:135-151 and harness/evals/lib/fixture.js: the offline case and the fixture's origin handling

### Reminders
- The spine stays pure. The real port lives in `harness/deliver-prepare.js` and is injected; the spine never calls git.
- `prepare` is optional in the spine, so all ~100 existing spine tests keep their exact event sequences.
- Every git call is an args array through the injected `sh`, with `cwd` set to the run root. Capture conflicted paths BEFORE `git merge --abort`.
- No rebase, and no force-push anywhere.
- `publishPlanChange` commits only the listed path. A merge commit already on HEAD is pushed by its push step, because the local HEAD differs from the remote.
- Fail closed: any unexpected git result is `prepare-failed` with its stderr as detail, never silently skipped.

## Program Design

**Signatures**
```js
// harness/deliver-prepare.js
export function makePreparePort({ sh, root, feature, planPath, workBranch, baseBranch }) // → async () => PrepareResult
// PrepareResult = { ok: true, data: { base, merged, fastForwarded, committed, pushed } }
//               | { ok: false, stopped: 'merge-conflict' | 'prepare-failed', detail }
// harness/spine.js
export async function deliverSpine({ …existing, prepare })   // prepare optional
```

**Call stack: `rad deliver <f>`**
```
deliverCommand
  setup (worktree | main) → { root, state, planPath, … }
  port = ctx.prepare ?? makePreparePort({ sh, root, feature, planPath, workBranch, baseBranch })
  deliverSpine({ …, prepare: port })
    gate → deliver-started → run-resumed?
    r = await prepare()
      r.ok      → append run-prepared(r.data)
      !r.ok     → stopRun({ stopped: r.stopped, detail: r.detail, base, branch })  → exit 3 | 1
    … waves (unchanged) …
```

**Call stack: the real port**
```
requirePublishReady → fetch origin <base> <branch>
  → ff-only to origin/<branch> if behind
  → merge --no-edit origin/<base> if not contained   (conflict → collect U paths → merge --abort → merge-conflict)
  → setPlanStatus(in-progress) if needed
  → publishPlanChange(plan, 'deliver(<f>): begin execution', issue, 'in-progress')
  → { ok: true, data }
```

**File tree diff**
```
harness/deliver-prepare.js           + new
harness/spine.js                     ~ optional prepare phase
harness/stops.js                     ~ two rows
harness/events.js                    ~ doc
harness/cli.js                       ~ build/inject port
harness/test/spine-prepare.test.js   + new
harness/test/deliver-prepare.test.js + new
harness/test/{cli,worktree,deliver}.test.js ~ no-op port in helpers
harness/evals/delivery.eval.js       ~ offline case keeps an origin
docs/rad-wave-contract.md, docs/rad-cli.md ~
```

## Wave Plan

### Wave 1 — parallel
The spine phase and the real port don't depend on each other's code; they share only the `PrepareResult` contract above.

#### Task 1.1: Spine prepare phase, stops and event
File: harness/spine.js:540-612, harness/stops.js:1-121, harness/events.js:14-45, harness/test/spine-prepare.test.js:1-1
What: Add the optional `prepare` option to `deliverSpine` (document it in the options comment). After `deliver-started` and any `run-resumed`, and before orphan convergence and waves:
- `const r = await prepare()`;
- on `r.ok`, append `run-prepared` with `r.data`;
- otherwise `return stopRun(...)` with `stopped: r.stopped` and `detail: r.detail`, passing `base`/`branch` from `r` if present, for placeholders.

A port that throws is treated as `prepare-failed`, with the error message as detail. Add the `merge-conflict` (needs-decision) and `prepare-failed` (failed) rows to `STOP_TABLE`, with the AC#2 decisions; make sure their placeholders render, with the missing-field fallback. Document `run-prepared` in the events.js type list as audit-only. New `spine-prepare.test.js`, reusing spine.test.js-style fakes:
- an absent port gives an unchanged sequence;
- success appends `run-prepared` before `wave-started`;
- a merge-conflict result gives `deliver-stopped` needs-decision and no `run-prepared` or `wave-started`;
- a prepare-failed result gives class failed;
- a throwing port gives prepare-failed;
- on resume, prepare runs after `run-resumed`, and completed waves are still skipped.
Validate: AC#1, AC#2, AC#3 — `node --test harness/test/spine-prepare.test.js harness/test/spine.test.js` passes

#### Task 1.2: The real prepare port
File: harness/deliver-prepare.js:1-1, harness/test/deliver-prepare.test.js:1-1
What: `makePreparePort({ sh, root, feature, planPath, workBranch, baseBranch })` returns an async function implementing AC#4 steps (a)–(g) in small helpers under ~40 lines, with named constants for the commands and messages. Use `requirePublishReady`/`publishPlanChange` from branch-publish.js, and `setPlanStatus`/`planIssueNumber` from plan-commit.js. `planPath` is relative to `root`; read and write it under `root`. Write a module header comment covering the order, no rebase/no force, and that it's safe to repeat. Add real-git tests covering every AC#7 case, copying the bare-origin setup from cli-plan-status.test.js, with `rad-label.sh` stubbed through the injected `sh` and real git for everything else.
Validate: AC#4, AC#5, AC#7 — `node --test harness/test/deliver-prepare.test.js` passes

### Wave 2 — sequential
Wire the CLI, keep the existing suites green, and rework the eval.

#### Task 2.1: CLI wiring
File: harness/cli.js:1001-1030, 1204-1235, 1456-1510, 1640-1700, harness/test/cli.test.js:555-600, harness/test/worktree.test.js:170-260, harness/test/deliver.test.js:1-60
What: In `deliverCommand`, after setup, build the port. Use `ctx.prepare` if it's provided; otherwise `makePreparePort` with the run root (the worktree path or the repo root), `resolveWorkBranch(setup, planCtx, feature)`, `readDefaultBranch(...)` (a failure exits like today's default-branch error) and the plan path relative to the root. Pass it to `deliverSpine` as `prepare`. Expose whatever setup values are needed from `setupMainRun`/`setupWorktreeRun` without changing their behavior. In the test helpers (`runDeliverCaptured`, the worktree deliver helper, deliver.test.js calls), inject `ctx.prepare = async () => ({ ok: true, data: {} })` by default, and add one cli.test case asserting that the injected port is called and that its `merge-conflict` result exits 3. Change no existing assertions, apart from event-sequence assertions that now include `run-prepared`; list any you touch.
Validate: AC#6 — `node --test harness/test/*.test.js` passes in full (report the counts)

#### Task 2.2: Evals
File: harness/evals/delivery.eval.js:55-192, harness/evals/lib/fixture.js:100-170
What: Run `node --test harness/evals/*.eval.js`. Rework `push-check-unavailable-offline` so the fixture keeps a reachable origin (the prepare fetch and push succeed) but the default-tip read still fails. For example, stub or break `scripts/default-tip.sh` in the fixture, or point it at a missing remote name, whichever fits the fixture's existing knobs. The case keeps its assertion that the push guard records `push-check-unavailable` and doesn't demote. Adjust the fixture only if the prepare phase needs it (a clean index on the work branch; a plan without `Issue:` gives "label skipped"). Make sure `deliver-isolated-by-default` and the push-to-default cases still pass.
Validate: AC#7 — `node --test harness/evals/*.eval.js` passes (report the counts)

### Wave 3 — parallel
Docs.

#### Task 3.1: Docs
File: docs/rad-wave-contract.md:328-372, docs/rad-cli.md:485-520, 640-670
What: Add the two stop rows to the contract table, plus a short "Prepare phase" paragraph: order, merge-not-rebase, the reachable-remote requirement, safe to repeat, and the audit-only `run-prepared`. In the rad-cli.md deliver section, describe the prepare phase, that a reachable origin is required, and that main mode (`RAD_WORKTREE=0`) must be on the work branch with nothing staged. Add `merge-conflict` to the exit-3 examples and to "Resuming a stopped run": resolve the conflict on the branch, commit, then `rad deliver <f> --resume --context "<what you did>"`.
Validate: AC#8 — `grep -n 'merge-conflict' docs/rad-wave-contract.md docs/rad-cli.md` matches in both files; `grep -n 'run-prepared' harness/events.js docs/rad-wave-contract.md` matches in both files

## Tests to Write
- [ ] Spine prepare phase: order, both stops, absent port unchanged, resume — harness/test/spine-prepare.test.js
- [ ] The real prepare port against real git with a bare origin — harness/test/deliver-prepare.test.js
- [ ] CLI wiring: injected port called; merge-conflict exits 3 — harness/test/cli.test.js

## Non-Goals
- End-of-run status and label commits, `pr-opened` publishing, and handling an existing PR (3b-ii).
- The PR body (3b-iii) and the test wave (3c).
- Changing `checkout-plan.sh`'s divergence message (#201).
- Committing preserved-worktree events after a stop (a pre-existing behavior).

## Out-of-Scope Dependencies
None

## Risks
- **Every deliver now needs a reachable origin and a clean work branch.** That's intended (decision A), but an offline run that used to reach the PR step now stops before any wave, and main mode now refuses when HEAD isn't the work branch.
- **The merge creates a commit on the work branch.** That's intended (no rewrite). `check-scope` diffs `origin/<base>...<branch>`, so changes merged in from main aren't counted, as long as the prepare fetch updated `origin/<base>`.
- **Worktree-mode stops keep their events in the preserved worktree** (pre-existing). For a merge conflict, the user resolves it in that worktree or on the branch. The docs must say where.
- **Test-helper defaults hide the real port in old tests.** Mitigation: the real port has its own real-git test file, and one cli case asserts the port is wired and its stop maps to exit 3.
- **Self-protected paths** (`harness/`): this plan needs architect review by design.

## Issue Gaps
- **Assumption — fast-forward from origin/<branch> first:** another machine may have pushed to the work branch. Fast-forwarding keeps the in-progress push from being rejected; true divergence fails closed.
- **Assumption — a throwing port is `prepare-failed`:** unexpected errors never escape the spine as "unexpected error" exit 1 without a stop event.
- **Assumption — `run-prepared` is a new audit-only event:** this makes a run that stopped in prepare visible, in line with decision A ("every run records a prepare step"). Being audit-only, it changes no phase or gate.
- **Assumption — the commit message** is `deliver(<f>): begin execution`, the same subject the prose uses today, plus `Plan:`/`Issue:` lines.
- **Assumption — where to resolve a conflict:** in worktree mode the worktree is preserved on a stop, so the user resolves the conflict there or on the branch. The docs state this, and the plan doesn't change worktree preservation.
