# Plan: rad deliver Finish Port and Existing-PR Success (#186 part 3b-ii-a)
Created: 2026-10-07
Author: architect
Status: in-progress
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-07T19:51:43.297Z
Recorded-By: sean@torchcodelab.com
Branch: rad/deliver-finish-port
Issue: 186
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/186
Issue-Title: Codex parity for state-changing RAD workflow

## Context
Part 3 makes `rad deliver` the only deliver path (decision C on #186). 3b-i (PR #203) added the prepare phase. The end of the run is still prose-only. The `/rad-deliver` command (step 9) writes `Status: complete` and `Completed-At:`, commits `deliver(<f>): mark plan complete`, pushes, and labels the issue `review`. `rad deliver` instead runs `check-scope.sh` then `open-pr.sh` back to back (`POST_CHECKS`, spine.js:317) and appends `pr-opened`. If a PR already exists, `open-pr.sh` fails, and every rerun fails the same way.

Decisions the user made on 2026-10-07:
1. `open-pr.sh` treats an existing open PR for the branch as success.
2. A rerun of a feature that is already `delivered` short-circuits in `rad deliver` before the spine.
3. An injected two-step `finish` port, mirroring `prepare`. Run order: `check-scope.sh`, `beforePr`, `open-pr.sh`, append `pr-opened`, `afterPr`.

3b-ii is split to fit the plan read budget:
- **This plan (3b-ii-a)** builds the spine phase, the real port and the `open-pr.sh` change. The spine port is optional, so nothing changes for `rad deliver` until 3b-ii-b wires it.
- **3b-ii-b** adds the CLI wiring, the `delivered` short-circuit, the test-helper defaults, evals and docs.

## Scope
| In scope | Out of scope |
|---|---|
| An optional two-step `finish` port in `deliverSpine`, and a new `finish-failed` stop | CLI wiring, `ctx.finish`, the `delivered` short-circuit (3b-ii-b) |
| A real `finish` port in a new `harness/deliver-finish.js` | Test-helper defaults, evals and docs for the finish phase (3b-ii-b) |
| A `Completed-At:` header writer in plan-commit.js | The deterministic PR body (3b-iii), the test wave (3c) |
| `open-pr.sh` treats an existing open PR/MR (gh, glab, tea) as success | Changing `transitions.js` or the gate fold |

## Acceptance Criteria
1. **The spine port.** `deliverSpine` accepts an optional `finish` port `{ beforePr, afterPr }`. Each step is an async function with no arguments that returns `{ ok: true, data }` or `{ ok: false, detail }`.
   - **Order:** with the port supplied, the end of the run is: approval-during-run guard, `check-scope.sh`, `beforePr()`, `open-pr.sh`, append `pr-opened`, `afterPr()`.
   - **A failed `beforePr`** (an `ok: false` result, or a throw) stops the run through `stopRun` with `stopped: 'finish-failed'` and the detail. `open-pr.sh` is not called and `pr-opened` is not appended.
   - **A failed `afterPr`** (an `ok: false` result, or a throw) returns `{ ok: false, stopped: 'finish-failed', detail, reason: detail, afterPr: true }` WITHOUT appending anything. `pr-opened` already made the phase terminal `delivered`, so any append would throw.
   - **Success** returns `{ ok: true, waves }` as today.
   - **Without the port,** the event sequence and script calls are exactly as today, and every existing spine test passes unchanged.
   - **The `POST_CHECKS` declaration keeps its single-array-literal shape,** so `spineScriptStrings()` in cli.test.js:1237-1245 still finds `open-pr.sh`.
2. **The stop reason.** `STOP_TABLE` has `finish-failed`, class `failed`, decision "finishing the run failed: {detail}; re-run rad deliver to finish". The decision renders with its placeholder filled and falls back to `unknown` when the value is missing.
3. **The real port** is `makeFinishPort({ sh, root, feature, planPath, workBranch })` in `harness/deliver-finish.js`. It returns `{ beforePr, afterPr }`, and both steps run in `root`.
   - **`beforePr`:**
     - (a) runs `requirePublishReady(sh, root, workBranch)`;
     - (b) sets header `Status: complete` and upserts `Completed-At: <ISO now>` right after `Status:`. If `Completed-At:` is already present, it is kept, so a rerun keeps the first completion time;
     - (c) calls `publishPlanChange` with `paths: [planPath, .agents/state/<f>/events.jsonl]`, the message `deliver(<f>): mark plan complete` plus `Plan:` and `Issue:` lines, the issue from `planIssueNumber`, and `labelStatus: 'review'`;
     - (d) returns `{ ok: true, data: { committed, pushed } }`. A refusal or a non-zero publish is `{ ok: false, detail }`.
   - **`afterPr`:** runs `requirePublishReady`, then `publishPlanChange` with `paths: [.agents/state/<f>/events.jsonl]`, the message `deliver(<f>): record pr-opened` plus a `Plan:` line, the issue, and `labelStatus: 'review'`. It returns the same shapes.
   - **Safe to repeat:** each step run a second time with nothing new makes no commit and does no push. It only labels and returns `ok`.
   - **Options:** missing or non-string options throw `TypeError` (programmer error), like `makePreparePort`.
4. **An existing PR is success.** `scripts/open-pr.sh` checks, before creating anything, for an open PR or MR whose head is `--head`:
   - GitHub: `gh pr list --head <head> --state open --json url --jq '.[0].url'`;
   - GitLab: `glab mr list --source-branch <head>`, taking the first MR URL;
   - Forgejo/Gitea: `tea pr list --state open`, filtered to the head branch.
   - **When one exists,** it prints `PR already open: <url>` to stdout, pushes the branch, and exits 0 without calling create. GitHub skips `verify_closing_links`.
   - **When the list command fails,** the script prints the reason to stderr and exits non-zero. It never falls through to create (fail-closed).
   - **When none exists,** behavior is exactly as today. `manual` is unchanged.
5. **Tests.**
   - `harness/test/spine-finish.test.js` covers every AC#1 and AC#2 case. It records `sh` calls to prove `open-pr.sh` is not called after `beforePr` fails, and checks the event log to prove nothing is appended after `pr-opened` when `afterPr` fails.
   - `harness/test/deliver-finish.test.js` runs real git with a bare origin. Cases:
     - `beforePr` writes both headers, commits plan and events in one commit with the right subject, pushes and labels `review`;
     - a second `beforePr` is a no-op apart from the label;
     - an existing `Completed-At:` is kept;
     - `afterPr` commits and pushes only `events.jsonl`;
     - a plan with no `Issue:` gives "label skipped";
     - a wrong branch or staged changes give `ok: false`;
     - a push to an unreachable origin gives `ok: false`.
   - `scripts/test-open-pr.sh` adds four cases:
     - gh existing PR: exit 0, `PR already open:` printed, no `pr create` call;
     - gh list fails: non-zero, no create;
     - glab existing MR: exit 0, no `mr create`;
     - glab list fails: non-zero, no create.
   - Existing cases keep passing.

## Agent Scope
Research was done through a read-only sub-agent survey of the spine, stops, deliver-prepare, branch-publish, plan-commit, open-pr.sh and its test, plus targeted greps in this session. There are no out-of-scope dependencies.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| harness/spine.js | 40-120 | `runFinishStep` helper next to `runPrepare`; read `stopRun` |
| harness/spine.js | 310-320 | `POST_CHECKS` (keep the declaration's shape) |
| harness/spine.js | 595-635 | Options doc and signature gain `finish` |
| harness/spine.js | 1118-1143 | `beforePr` before `open-pr.sh`; `afterPr` after `pr-opened` |
| harness/stops.js | 40-130 | `finish-failed` row |
| harness/deliver-finish.js | 1-1 | New: `makeFinishPort` |
| harness/deliver-prepare.js | 1-214 | Read only: the port model |
| harness/branch-publish.js | 45-142 | Read only: `requirePublishReady`, `publishPlanChange` |
| harness/plan-commit.js | 65-80 | Read only: `planIssueNumber` |
| harness/plan-commit.js | 228-260 | New exported `upsertPlanHeader(text, key, value, { after })`; `setPlanStatus` unchanged |
| harness/test/spine-finish.test.js | 1-1 | New (AC#5) |
| harness/test/spine-prepare.test.js | 20-70 | Read only: fakes to copy |
| harness/test/deliver-finish.test.js | 1-1 | New (AC#5) |
| harness/test/deliver-prepare.test.js | 40-135 | Read only: bare-origin setup to copy |
| scripts/open-pr.sh | 1-255 | Existing-PR lookups in `open_github`, `open_gitlab`, `open_forgejo` |
| scripts/test-open-pr.sh | 1-225 | Subcommand-aware gh/glab stubs; four cases |

## Execution Notes

### Do Not Touch
- harness/cli.js and the four deliver test helpers: the wiring is 3b-ii-b
- harness/transitions.js, harness/gates.js, harness/gates.yaml: `delivered` stays terminal
- harness/deliver-prepare.js (read only)
- .claude/commands/team/rad-deliver.md: the prose is replaced in 3d

### Key Files
- harness/spine.js `stopRun` (~59), `runPrepare` (~90), the end of `deliverSpine` (~1118-1143)
- harness/deliver-prepare.js: the structure to mirror (constants, a stop-style error class, the `publish` helper, `requirePortOptions`)
- harness/branch-publish.js `publishPlanChange` (128-142): returns `{ code, committed, pushed, message }` and commits only `paths`
- scripts/test-open-pr.sh `make_stubs` (19-37) and `make_link_stubs` (93-114): the stateful gh stub pattern to copy

### Reminders
- **Nothing may be appended after `pr-opened`.** The spine-test fake state doesn't validate transitions, so assert "no append after pr-opened" explicitly.
- **Keep `const POST_CHECKS = ['check-scope.sh', 'open-pr.sh'];` as it is.** Call `beforePr` in the loop right before `open-pr.sh`.
- **Make the open-pr test stubs branch on `$1 $2`.** The existing stubs truncate `<cli>.argv` on every call, so an extra `gh pr list` would overwrite what `pr create` captured.
- **Shell rules:** every git call is an args array through the injected `sh`, with `cwd: root`. No rebase, no force-push.
- **Fail closed:** an unexpected git or CLI result is a failure with its stderr as detail, never silently skipped.

## Program Design

**Signatures**
```js
// harness/deliver-finish.js
export function makeFinishPort({ sh, root, feature, planPath, workBranch }) // → { beforePr, afterPr }
// step: async () => { ok: true, data: { committed, pushed } } | { ok: false, detail }
// harness/plan-commit.js
export function upsertPlanHeader(text, key, value, { after = 'Status' } = {}) // → text
// harness/spine.js
export async function deliverSpine({ …existing, prepare, finish })   // finish optional
```

**Call stack: end of `deliverSpine`**
```
approval-during-run guard
for script of POST_CHECKS:
  if script === 'open-pr.sh' && finish: r = runFinishStep(finish.beforePr)  !ok → stopRun(finish-failed)
  sh(script)  non-zero → stopRun(post-check)
append pr-opened
if finish: r = runFinishStep(finish.afterPr)  !ok → return { ok:false, stopped:'finish-failed', detail, reason, afterPr:true }
return { ok:true, waves }
```

**File tree diff**
```
harness/deliver-finish.js             + new
harness/plan-commit.js                ~ upsertPlanHeader
harness/spine.js                      ~ optional finish phase
harness/stops.js                      ~ one row
scripts/open-pr.sh                    ~ existing-PR lookups
scripts/test-open-pr.sh               ~ stubs + four cases
harness/test/spine-finish.test.js     + new
harness/test/deliver-finish.test.js   + new
```

## Wave Plan

### Wave 1 — parallel
The three tasks share only the step-result contract above. Each task stages only its own files.

#### Task 1.1: Spine finish phase and stop
File: harness/spine.js:40-120, 310-320, 595-635, 1118-1143, harness/stops.js:40-130, harness/test/spine-finish.test.js:1-1
What: Add the optional `finish` option (default `null`) to `deliverSpine` and document it in the options comment. Add `runFinishStep(step)` next to `runPrepare`; it turns a throw into `{ ok: false, detail }` using the existing `errorMessage`. Then:
- in the post-check loop, call `beforePr` right before `open-pr.sh`, and on failure `stopRun({ stopped: 'finish-failed', ok: false, detail, reason: detail })`;
- after `pr-opened`, call `afterPr`, and on failure return `{ ok: false, stopped: 'finish-failed', detail, reason: detail, afterPr: true }` without appending;
- keep the `POST_CHECKS` declaration unchanged;
- add the `finish-failed` row to `STOP_TABLE`.

The new test file copies the spine-prepare.test.js fakes and covers AC#1 and AC#2.
Validate: AC#1, AC#2, AC#5 — `node --test harness/test/spine-finish.test.js harness/test/spine.test.js harness/test/spine-prepare.test.js harness/test/stops*.test.js` passes

#### Task 1.2: The real finish port
File: harness/deliver-finish.js:1-1, harness/plan-commit.js:228-260, harness/test/deliver-finish.test.js:1-1
What: Add the exported `upsertPlanHeader` to plan-commit.js:
- it replaces `key:` if the header has it, and otherwise inserts it after the `after` key, or after the title when that key is absent;
- non-string input throws `TypeError`.

Then implement `makeFinishPort` per AC#3 in deliver-finish.js:
- mirror deliver-prepare.js, with small helpers under ~40 lines;
- use named constants for `complete`, `review` and both message subjects;
- add a module header comment covering the order, the required push, and that it is safe to repeat.

The real-git tests copy the deliver-prepare.test.js bare-origin setup, stub `rad-label.sh` through `sh`, and cover every AC#5 port case. Add `upsertPlanHeader` cases (replace, insert after `Status:`, no `Status:`, non-string) to the same file.
Validate: AC#3, AC#5 — `node --test harness/test/deliver-finish.test.js harness/test/plan-commit*.test.js` passes

#### Task 1.3: open-pr.sh treats an existing PR as success
File: scripts/open-pr.sh:1-255, scripts/test-open-pr.sh:1-225
What: Add one small lookup function per platform (`existing_github`, `existing_gitlab`, `existing_forgejo`). Each prints the URL, or nothing, and returns non-zero when the list command fails. Call it at the top of `open_github`, `open_gitlab` and `open_forgejo`, after the CLI-exists check:
- a URL means: print `PR already open: <url>`, push the branch, return 0;
- a lookup failure means: print the reason to stderr and exit 1.

Then update `scripts/test-open-pr.sh`:
- make the gh and glab stubs answer `pr list`/`mr list` from an env-controlled fixture (URL, empty or fail), and keep `create` argv capture intact;
- add the four AC#5 cases.
Validate: AC#4, AC#5 — `bash scripts/test-open-pr.sh` passes, existing cases included

## Tests to Write
- [ ] Spine finish phase: order, both failure paths, no append after pr-opened, absent port unchanged — harness/test/spine-finish.test.js
- [ ] The real finish port and upsertPlanHeader against real git with a bare origin — harness/test/deliver-finish.test.js
- [ ] open-pr.sh: existing PR/MR and failing list (gh, glab) — scripts/test-open-pr.sh

## Non-Goals
- Wiring the port into `rad deliver`, the `delivered` short-circuit, test-helper defaults, evals and docs (3b-ii-b).
- The deterministic PR body (3b-iii) and the test wave (3c).
- Changing `transitions.js` so events can follow `delivered`.
- Rewriting `/rad-deliver` prose step 9 (3d replaces it).

## Out-of-Scope Dependencies
None

## Risks
- **The `open-pr.sh` change is live as soon as this merges,** because the prose deliver path calls it too. That's intended: an existing PR is now success everywhere. A failing list command now blocks PR creation where it used to be skipped (fail-closed by design).
- **The spine port ships unused until 3b-ii-b.** The real-git and spine tests are the only proof until then.
- **Plan-status timing:** `beforePr` commits `Status: complete` before `open-pr.sh`. If `open-pr.sh` then fails, the plan says complete while the run is stopped. The next run's prepare phase rewrites `in-progress`, so the header self-corrects. This matters only after 3b-ii-b wires the port.
- **Self-protected paths** (`harness/`, `scripts/`): this plan needs architect review by design.

## Issue Gaps
- **Assumption — `Completed-At:` goes right after `Status:`,** matching the 3b-i plan header layout. An existing value is kept, so a rerun keeps the first completion time.
- **Assumption — `beforePr` commits the event log with the plan** (decision 3: "stage plan + .agents/state/<feature>/"). Only `events.jsonl` is listed, because `publishPlanChange` commits paths, not directories.
- **Assumption — the `afterPr` subject is `deliver(<f>): record pr-opened`.** No prose subject exists for this step.
- **Assumption — `tea pr list` output is filtered by head branch in shell,** because tea has no `--head` filter. The forgejo path has no existing test stub, so it is covered by code review rather than a fixture case.
- **Assumption — a PR that already exists also pushes the branch,** so commits made since it was opened reach it. This matches what `open-pr.sh` does before create today.
