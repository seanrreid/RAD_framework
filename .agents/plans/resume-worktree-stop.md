# Plan: Resume a Stopped Run in Worktree Mode (#210)
Created: 2026-10-08
Author: architect
Status: complete
Completed-At: 2026-10-08T15:43:11Z
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-08T15:22:57.752Z
Recorded-By: sean@torchcodelab.com
Branch: rad/resume-worktree-stop
Issue: 210
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/210
Issue-Title: rad deliver --resume cannot see a stop in worktree mode

## Context
In worktree mode (the default), a stopped `rad deliver` run keeps its worktree, but the run's event log stays **uncommitted** there. `--resume` reads history from the local branch tip (`readResumeHistory` → `readBranchTipHistory`, cli.js:834-842), which has no stop, so it refuses with "nothing to resume" (exit 2). Past that check, it would hit `ensureBranchFree` (cli.js:1152-1164), which refuses with exit 2 because the kept worktree still has `rad/<f>` checked out.

This was found in the first live end-to-end run (`deliver-docs-sweep`, held at its wave-2 `fail-timeout` stop as this fix's acceptance test).

The user decided on 2026-10-08:
1. **On stop, commit only the event log to the work branch,** locally inside the kept worktree, with the subject `deliver(<f>): record stopped run`. There is no push, and partial code stays uncommitted. If that commit fails, the run behaves as today and prints the reason.
2. **On `--resume`, reuse the kept worktree** instead of creating one. With no kept worktree, the resume creates one as usual. A plain rerun is unchanged.

## Scope
| In scope | Out of scope |
|---|---|
| Commit the event log when a worktree-mode run doesn't complete | Pushing on stop |
| Reuse a kept RAD worktree for the same feature on `--resume` | `rad stop-status` reading the main checkout instead of the branch tip (a separate gap) |
| Adapter: optional `dir` on `preserve`/`complete`, plus `reactivate` | The wave timeout (#211) |
| Docs and an invariant anchor | Main mode (`RAD_WORKTREE=0`), which already reads the checkout's log |

## Acceptance Criteria
1. **Adapter.** `makeWorktreeLifecycle` (harness/adapters/worktree.js) changes in three ways:
   - `preserve(feature, dir?)` and `complete(feature, dir?)` pass `dir` to `worktree-lifecycle.sh` when given.
   - The new `reactivate(dir)` rewrites `<dir>/.rad-worktree.json` from `status: "preserved"` to `"active"` and returns `dir`. A marker that's missing, malformed or not `preserved` throws.
   - `readMarker(dir)` returns the parsed marker, or `null` when there is none.
   - It is pure JS file I/O; `worktree-lifecycle.sh` is unchanged.
2. **Commit on stop.** When a worktree-mode run doesn't complete, `finishWorktree`'s not-completed branch calls a new `commitStopEvents({ sh, root, feature })` before `worktree.preserve(...)`.
   - It runs `git add -- .agents/state/<f>/events.jsonl` and checks `git diff --cached --quiet -- <that path>`.
   - If that path has staged changes, it runs `git commit -m "deliver(<f>): record stopped run" -- .agents/state/<f>/events.jsonl`. The pathspec means nothing else is committed, whether staged by the agent or untracked like the marker.
   - If nothing changed, it does nothing.
   - On a git failure it prints `rad deliver: could not commit the stopped run's events — <reason>` and continues to preserve; the exit code is the stop's, as today.
   - `commitRunEvents` (the success path) is unchanged.
3. **Reuse on resume.** `deliverCommand` passes `resume` into `setupWorktreeRun` and `prepareWorktreeRoot`. With `resume` set, after the approved gate:
   - **A reusable worktree:** if `rad/<f>` is held by exactly one worktree, and its marker has this `feature` and `status: "preserved"`, the worktree is reactivated and used as the run root. No `create` runs, and `rad deliver: resuming in the preserved worktree <dir>` is printed. Later `preserve`/`complete` calls for that run pass `dir`.
   - **Anything else holds the branch** (no marker, another feature, an `active` marker, or more than one holder): today's `already checked out in another worktree` refusal, exit 2, with the text unchanged.
   - **Nothing holds the branch:** `create` as today.
   - **Without `resume`:** behavior is byte-identical to today.
4. **The end-to-end effect.** After a worktree-mode stop, `--resume --context …` is eligible, because the branch-tip log now has the `deliver-stopped`. It reuses the kept worktree and keeps that worktree's uncommitted partial work.
5. **Tests.**
   - harness/test/worktree.test.js:
     - adapter: `preserve`/`complete` with `dir`; `reactivate` (preserved → active, plus missing, malformed and not-preserved each throwing); `readMarker`.
     - commit on stop: the exact add, diff and pathspec commit args; nothing to commit; a commit failure still preserves and exits with the stop's code; the success path is unchanged.
     - reuse: a kept worktree for this feature is reused (no create; reactivate is called); an `active` marker, another feature's marker, or no marker → exit 2 with today's text; no resume while a kept worktree holds the branch → exit 2 as today.
   - harness/test/cli.test.js: a worktree-mode resume whose branch-tip log has a needs-decision stop is eligible and reaches setup. The existing "nothing to resume" and "failed stop" cases are unchanged.
   - No existing assertion changes. If one must, list it.
6. **Docs and invariant.**
   - docs/rad-cli.md:
     - "Resuming a stopped run": a stop commits its event log locally; `--resume` reuses the kept worktree; the merge-conflict paragraph says to resolve and commit in the kept worktree (the run's events are already committed); and the stale "when `RAD_WORKTREE` is set" becomes "in worktree mode (the default)".
     - The worktree lifecycle "preserve (on failure)" item mentions the stop commit.
   - docs/rad-wave-contract.md "Resuming a stopped run" gets one sentence on the worktree-mode behavior.
   - docs/invariants.yaml `resume-needs-decision-only` gains an `enforced_by` anchor on `commitStopEvents` in harness/cli.js, and `bash scripts/lint-invariants.sh` passes.

## Agent Scope
Research came from a read-only sub-agent survey of the post-spine worktree flow, `prepareWorktreeRoot`/`ensureBranchFree`, the lifecycle script and adapter, the branch-tip readers, the worktree, cli and resume tests, the docs and invariants.yaml. There are no out-of-scope dependencies.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| harness/adapters/worktree.js | 1-60 | `dir` on preserve/complete; `reactivate`; `readMarker` |
| scripts/worktree-lifecycle.sh | 1-169 | Read only: marker format and `[dir]` argument |
| harness/cli.js | 1093-1110 | Read: `mainGit`, `worktreesOnBranch` |
| harness/cli.js | 1150-1285 | `ensureBranchFree`, `prepareWorktreeRoot`, `writePreservedPointer`, `commitRunEvents`, `finishWorktree`, `setupWorktreeRun`: reuse and commit-on-stop |
| harness/cli.js | 1855-1865 | Pass `resume` in `setupOpts` |
| harness/cli.js | 1940-1980 | Read: post-spine flow |
| harness/test/worktree.test.js | 1-1 | Adapter, commit-on-stop and reuse cases (append; see the helpers at 31-90 and 178-265) |
| harness/test/cli.test.js | 1095-1155 | Read: the worktree resume cases; append the eligible case |
| docs/rad-cli.md | 833-880 | Resuming a stopped run |
| docs/rad-cli.md | 940-1003 | Worktree lifecycle: preserve, branch held |
| docs/rad-wave-contract.md | 485-508 | Resuming: worktree mode |
| docs/invariants.yaml | 140-165 | `resume-needs-decision-only` anchor |

## Execution Notes

### Do Not Touch
- scripts/worktree-lifecycle.sh: the adapter does the marker rewrite in JS
- harness/spine.js, harness/transitions.js, harness/gates.*
- `commitRunEvents` behavior and its existing assertions
- The `is already checked out in another worktree` refusal text (an invariants.yaml anchor)
- The stopped `deliver-docs-sweep` worktree and branch: they're this fix's acceptance test

### Key Files
- harness/cli.js: `ensureBranchFree` (1152-1164), `worktreesOnBranch` (1103-1109), `prepareWorktreeRoot` (1176-1198), `writePreservedPointer` (1201-1206), `commitRunEvents` (1227-1236), `finishWorktree` (1243-1259), `setupWorktreeRun` (1267-1283), `deliverCommand` setup (1859-1863)
- harness/adapters/worktree.js `makeWorktreeLifecycle` (19-56)
- harness/test/worktree.test.js: the adapter tests (31-90), `makeDeliverSh` (178-238), `runDeliver` (249-265), the stop/preserve test (285-301)

### Reminders
- **Waves run under a fixed 10-minute agent limit (#211).** Validate with only the targeted test files named in each task. Don't run the full harness, eval or script suites inside a wave; the reviewer runs those after the run.
- **Every git call is an args array through `sh`, and the stop commit always uses the pathspec.** No push.
- **Fail closed on reuse:** reuse only on an exact match (one holder, same feature, `preserved`). Everything else keeps today's refusal.
- **Helpers stay under ~40 lines, with named constants** (the stop subject, the marker filename and the statuses).

## Program Design
```js
// harness/adapters/worktree.js
makeWorktreeLifecycle({ sh, now }) → { create(f, b), complete(f, dir?), preserve(f, dir?), reactivate(dir), readMarker(dir) }
// harness/cli.js
commitStopEvents({ sh, root, feature })                   // pathspec commit of events.jsonl; logs and continues on failure
findReusableWorktree({ feature, workBranch, repoRoot, sh, worktree }) // → dir | null (exact match only)
prepareWorktreeRoot({ feature, repoRoot, sh, resume })    // gate → (resume && reusable ? reactivate : ensureBranchFree + create)
```
```
run stops (worktree mode) → finishWorktree(!completed) → commitStopEvents → preserve(f, root) → pointer
rad deliver f --resume → resolveResume (branch tip now has deliver-stopped) → setupWorktreeRun({…, resume})
  → prepareWorktreeRoot → gate → findReusableWorktree → reactivate(dir) → spine on dir
```
```
harness/adapters/worktree.js   ~ dir args, reactivate, readMarker
harness/cli.js                 ~ commitStopEvents, findReusableWorktree, resume threaded into setup
harness/test/worktree.test.js  ~ appended cases
harness/test/cli.test.js       ~ appended case
docs/*.md, docs/invariants.yaml ~
```

## Wave Plan

### Wave 1 — sequential

#### Task 1.1: Lifecycle adapter
File: harness/adapters/worktree.js:1-60, harness/test/worktree.test.js:1-1
What: Write AC#1 and its adapter tests (append to worktree.test.js near the adapter section).
Validate: AC#1, AC#5 — `node --test harness/test/worktree.test.js` passes

### Wave 2 — sequential

#### Task 2.1: Commit on stop
File: harness/cli.js:1150-1285, harness/test/worktree.test.js:1-1
What: Write AC#2 and its worktree.test.js cases.
Validate: AC#2, AC#5 — `node --test harness/test/worktree.test.js` passes

### Wave 3 — sequential

#### Task 3.1: Reuse on resume
File: harness/cli.js:1150-1285, 1855-1865, harness/test/worktree.test.js:1-1, harness/test/cli.test.js:1095-1155
What: Write AC#3 and AC#4 and their worktree.test.js and cli.test.js cases.
Validate: AC#3, AC#4, AC#5 — `node --test harness/test/worktree.test.js harness/test/cli.test.js` passes

### Wave 4 — sequential

#### Task 4.1: Docs and invariant
File: docs/rad-cli.md:833-880, 940-1003, docs/rad-wave-contract.md:485-508, docs/invariants.yaml:140-165
What: Write AC#6.
Validate: AC#6 — `bash scripts/lint-invariants.sh` passes; `grep -n "record stopped run" docs/rad-cli.md` matches

## Tests to Write
- [ ] Adapter dir/reactivate/readMarker, commit on stop, reuse on resume — harness/test/worktree.test.js
- [ ] Worktree-mode resume eligible after a committed stop — harness/test/cli.test.js

## Non-Goals
- Pushing the stop commit, or resuming on another machine.
- Fixing `rad stop-status` to read the branch tip (a separate gap; file it).
- A configurable wave timeout (#211).
- Changing main-mode behavior.

## Out-of-Scope Dependencies
None

## Risks
- **A reused worktree carries uncommitted partial work into the prepare phase.** The prepare merge of `origin/<base>` refuses if that work conflicts with incoming changes. That surfaces as `prepare-failed`, never as silent loss.
- **The stop commit adds an event-log commit on the branch for every stop.** It's only the run's own audit trail, and `check-scope` exempts `.agents/`.
- **Changing `finishWorktree`'s not-completed branch** also covers "ok but not evidenced", which is fine: its events are worth committing too.
- **Self-protected paths** (`harness/`): this plan needs architect review by design.

## Issue Gaps
- **Assumption — the reuse match is exact:** exactly one holder, a marker with the same `feature`, and `status: "preserved"`. Anything else keeps today's exit 2.
- **Assumption — the reactivation is done in JS on the marker** rather than as a new lifecycle subcommand. That keeps the bash script and its tests unchanged.
- **Assumption — a failed stop commit is reported but doesn't change the exit code;** the stop's own class decides it, as today.
- **Assumption — `rad stop-status` reading the main checkout is a separate gap,** filed as an issue rather than fixed here.
