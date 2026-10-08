# Plan: Resume Merges Around Partial Work; Execution Log Pushed and Matched Exactly (#216, #220)
Created: 2026-10-08
Author: architect
Status: complete
Completed-At: 2026-10-08T18:18:43.026Z
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-08T18:13:56.090Z
Recorded-By: sean@torchcodelab.com
Branch: rad/resume-stash-and-log-publish
Issue: 216
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/216
Issue-Title: Resume reuse + prepare merge fails when main touched a file the stopped attempt left dirty

## Context
Two follow-ups from the live `rad deliver` runs:
- **#216:** #210 made `--resume` reuse the kept worktree, so a stopped attempt's uncommitted partial work survives. The resume's prepare phase then merges `origin/<base>` in that worktree (`mergeBase`, harness/deliver-prepare.js:122-138), and git refuses a merge that would overwrite uncommitted changes. When main touched a file the stopped attempt left dirty, the resume stops `prepare-failed` before any wave runs (seen on `deliver-docs-sweep`).
- **#220:** the #218 fix finds the run's execution logs with a `<feature>-*.md` prefix match (`executionLogPaths`, harness/cli.js:1322-1330). That also catches a longer-named feature's logs (`deliver` matches `deliver-hardening-…`). And, as noted on #220 after #221 merged, on a successful run the log is committed only by the teardown safety net, after the finish phase's last push, so it never reaches the PR.

The user decided (#216 Q1, 2026-10-08) that when the prepare merge is needed and the worktree has tracked uncommitted changes, `rad deliver` should **stash, merge, then restore**. If the restore conflicts, it undoes it, keeps the stash, and stops with `merge-conflict` (needs-decision, exit 3), naming the files. With no partial work, behavior is unchanged.

## Scope
| In scope | Out of scope |
|---|---|
| Stash, merge and restore around the prepare merge when tracked changes exist | Untracked partial files; the stash covers tracked changes only |
| Execution-log match on the exact `<feature>-YYYY-MM-DD.md` name | Changing the wave prompt's log instruction |
| The finish port publishes the execution log with plan and events | Pushing on stop |
| Docs | |

## Acceptance Criteria
1. **Exact log match (#220).** One shared helper, `executionLogPaths(root, feature)`, exported from harness/deliver-finish.js and imported by harness/cli.js in place of its local copy. It returns only files named `<feature>-YYYY-MM-DD.md` (regex `^<escaped feature>-\d{4}-\d{2}-\d{2}\.md$`) under `.agents/logs/`, sorted, as explicit root-relative paths. A missing directory returns `[]`.
2. **The log rides the finish publishes (#220).**
   - **`beforePr`** publishes `[plan, events, ...executionLogPaths]`, present paths only.
   - **`afterPr`** publishes `[events, ...executionLogPaths]`. The missing-events check is unchanged.
   - So a successful run's execution log is pushed with the PR. `commitRunEvents` and `commitStopEvents` keep using the same helper.
3. **Stash, merge and restore (#216).** In `mergeBase`, only when a merge is needed (HEAD lacks `origin/<base>`), and only when the worktree has tracked uncommitted changes (`git diff --quiet` exits 1):
   1. **Stash:** `git stash push -q -m "rad deliver: partial work before merging origin/<base>"`, tracked files only (no `-u`).
   2. **Merge:** as today.
      - **A clean merge** moves on to step 3.
      - **A merge conflict** keeps today's handling (collect the paths, `merge --abort`, then `merge-conflict`), but first restores the stash with `git stash pop` so the partial work isn't left hidden.
      - **Any other merge failure:** abort as today, restore the stash, then `prepare-failed`.
   3. **Restore:** `git stash pop -q`.
      - **If it conflicts:** collect the conflicted paths (`git diff --name-only --diff-filter=U`), run `git reset -q --hard HEAD` in the run root (the work is still in the stash), and stop with `merge-conflict`. The detail is `partial work conflicts with origin/<base> in <paths>; it is kept in git stash (stash@{0})`.
      - **If it fails any other way:** `prepare-failed`, with the stash kept and named in the detail.
   - **No tracked changes, or no merge needed:** every git call is exactly as today.
   - `run-prepared` data gains `stashed: true` only when a stash happened.
4. **Tests.**
   - harness/test/deliver-finish.test.js: the exact match (a prefix-sharing feature's log excluded; a non-date name excluded); `beforePr` and `afterPr` commit and push the log; no log means the paths are unchanged.
   - harness/test/deliver-prepare.test.js, with real git and a bare origin:
     - partial tracked work plus main touching the same file non-conflictingly: merges, restores, the partial work is present, and `stashed: true`;
     - partial work that conflicts with main: `merge-conflict` with the conflict detail, the stash is kept, the tree is clean, and HEAD is the merge;
     - an untracked-only partial file: no stash, unchanged behavior;
     - no partial work: unchanged.
   - harness/test/worktree.test.js: existing log cases pass, with listed adjustments only if the exact-name match changes a fixture's log name.
5. **Docs.**
   - docs/rad-cli.md "Prepare phase" and "Resuming a stopped run": the stash, merge and restore behavior, how to recover a kept stash (`git stash list`, `git stash pop` in the kept worktree, resolve, commit, `--resume`), and that the execution log is pushed with the PR.
   - docs/rad-wave-contract.md "Prepare phase": one sentence.

## Agent Scope
Research came from targeted reads of `mergeBase`, `runPrepare` and the stop helpers in deliver-prepare.js, the finish port's paths in deliver-finish.js, `executionLogPaths` and the commit helpers in cli.js, and the #216 and #220 issue text. There are no out-of-scope dependencies.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| harness/deliver-finish.js | 1-149 | Export `executionLogPaths`; include logs in `beforePr`/`afterPr` |
| harness/cli.js | 1310-1370 | Use the shared `executionLogPaths`; drop the local copy |
| harness/deliver-prepare.js | 1-214 | Stash, merge and restore in `mergeBase`; `stashed` in data |
| harness/test/deliver-finish.test.js | 1-280 | Append cases (AC#4) |
| harness/test/deliver-prepare.test.js | 1-270 | Append real-git cases (AC#4) |
| harness/test/worktree.test.js | 1-1 | Only if a fixture log name needs the date form (list it) |
| docs/rad-cli.md | 560-620 | Prepare phase |
| docs/rad-cli.md | 840-900 | Resuming a stopped run |
| docs/rad-wave-contract.md | 380-410 | Prepare phase |

## Execution Notes

### Do Not Touch
- harness/spine.js, harness/stops.js: `merge-conflict` and `prepare-failed` already exist
- scripts/worktree-lifecycle.sh
- `fetchOrigin`, `fastForwardWork` and `publish` behavior in deliver-prepare.js

### Key Files
- harness/deliver-prepare.js: `mergeBase` (122-138), `abortMerge` (104), `mergeInProgress` (110), `runPrepare` (173-183), `PrepareStop`, the constants (22-32)
- harness/deliver-finish.js: `eventsPath` (38), `presentPaths` (77), `runBeforePr` (101), `runAfterPr` (108)
- harness/cli.js: `executionLogPaths` (1322-1330), `commitRunEvents` (~1339), `commitStopEvents` (~1361)
- harness/test/deliver-prepare.test.js: `withRepo`, `pushFromOther`, `makeSh`, `assertStopped` (40-135)

### Reminders
- **Waves run under the default 10-minute agent limit.** Validate with only the targeted test files.
- **Every git call is an args array through `sh`, with `cwd` set to the run root.** No `-u` on the stash, and no force-push.
- **`git reset --hard` runs only after a conflicting stash pop, in the run root,** and only while the work is safe in the stash.
- **No partial work, or no merge needed: byte-identical git calls.**
- **Helpers stay under ~40 lines, with named constants** (the stash message and the date regex).

## Program Design
```js
// harness/deliver-finish.js
export function executionLogPaths(root, feature)   // exact <feature>-YYYY-MM-DD.md
// harness/deliver-prepare.js
hasTrackedChanges(sh, root)                         // git diff --quiet → 1 means changes
stashPartial(sh, root, ref) / restorePartial(sh, root, ref)   // pop; conflict → reset --hard, PrepareStop(merge-conflict)
mergeBase(...)                                      // needs merge? → (tracked changes ? stash : -) → merge → (stashed ? restore : -)
```

## Wave Plan

### Wave 1 — sequential

#### Task 1.1: Exact log match and log publish
File: harness/deliver-finish.js:1-149, harness/cli.js:1310-1370, harness/test/deliver-finish.test.js:1-280, harness/test/worktree.test.js:1-1
What: Write AC#1 and AC#2 and their deliver-finish.test.js cases. Run worktree.test.js, and adjust a fixture log name only if needed (list it).
Validate: AC#1, AC#2, AC#4 — `node --test harness/test/deliver-finish.test.js harness/test/worktree.test.js` passes

### Wave 2 — sequential

#### Task 2.1: Stash, merge and restore
File: harness/deliver-prepare.js:1-214, harness/test/deliver-prepare.test.js:1-270
What: Write AC#3 and its real-git deliver-prepare.test.js cases.
Validate: AC#3, AC#4 — `node --test harness/test/deliver-prepare.test.js harness/test/spine-prepare.test.js` passes

### Wave 3 — sequential

#### Task 3.1: Docs
File: docs/rad-cli.md:560-620, 840-900, docs/rad-wave-contract.md:380-410
What: Write AC#5.
Validate: AC#5 — `grep -n "git stash" docs/rad-cli.md` matches; docs only

## Tests to Write
- [ ] Exact log match; logs published by beforePr/afterPr — harness/test/deliver-finish.test.js
- [ ] Stash, merge and restore: clean, conflicting, untracked-only, none — harness/test/deliver-prepare.test.js

## Non-Goals
- Stashing untracked partial files.
- Pushing on stop.
- Changing the execution-log instruction in wave prompts.

## Out-of-Scope Dependencies
None

## Risks
- **`git reset --hard` in the run worktree after a conflicting pop.** Mitigation: it runs only once the work is confirmed in the stash, and the stop detail names the stash.
- **Untracked partial files** (for example a brand-new file the attempt created) aren't stashed. They usually survive the merge, unless main added the same path, in which case the merge fails `prepare-failed` as today.
- **Self-protected paths** (`harness/`): this plan needs architect review by design.

## Issue Gaps
- **Assumption — only tracked changes are stashed,** which keeps the marker, logs and untracked files out of the stash.
- **Assumption — a conflicting restore is a `merge-conflict` (needs-decision),** reusing the existing stop rather than adding a new one.
- **Assumption — the shared log helper moves to deliver-finish.js,** the module that now needs it first.
