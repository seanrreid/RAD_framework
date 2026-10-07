# Plan: rad approve Commits by Default, and rad plan-status (#186 part 2b)
Created: 2026-10-07
Author: architect
Status: approved
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-07T14:57:18.467Z
Recorded-By: sean@torchcodelab.com
Branch: rad/approve-commit-plan-status
Issue: 186
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/186
Issue-Title: Codex parity for state-changing RAD workflow

## Context
After part 2a, `/rad-plan` and `/rad-adopt` hand their branch, commit, push and label steps to `rad plan-open`. `/rad-approve` still tells the model to `git add`, `git commit`, `git push` and run `rad-label.sh` by hand (Step 5), and it handles rejection and feedback (Step 3) the same way. Under the #186 rule, a command's state changes may only be `rad` calls, so a Codex `/rad-approve` can't be written until those steps move into the CLI. This plan makes `rad approve` commit, push and label by default (`--no-commit` opts out), adds `rad plan-status` for the rejection and feedback paths, and switches `/rad-approve` to call both. The decisions were recorded on #186 on 2026-10-07; on the same day the user chose commit-by-default with `--no-commit`, and chose that a same-status `plan-status` is a rerun.

## Scope
| In scope | Out of scope |
|---|---|
| `rad approve`: commit, push and label by default; `--no-commit`; `--trailer`; resumable rerun | Changing the exit codes of approve's existing refusals |
| New `rad plan-status <feature> <rejected\|needs-revision> [--trailer]` | Moving `/rad-approve` to `.rad/skills` (part 2c) |
| A shared commit/push/label step module used by both commands | Refactoring `plan-open.js` onto the shared module |
| `/rad-approve` Steps 3–5 call the commands instead of git | `rad wrap` (part 4) |
| The stale `harness/cli.js:11` "never pushes a branch" comment | The `/rad-design` inline architecture approve |

## Acceptance Criteria
1. `rad approve <f>`, run on the work branch with a clean index, records the approval, then commits only `.agents/plans/<f>.md` and `.agents/state/<f>/events.jsonl`. The subject is `approve: <f>`, or `approve: <f> (re-approval)` when the log already held an `approved` event. The body has `Plan:`, `Issue:` (when known), `Approved-By:`, and `Recorded-By:` plus `Approval-Evidence:` in proxy mode, followed by any `--trailer` lines in order. It then pushes the work branch, labels the issue `approved` (or prints `label skipped: no issue`), and exits 0.
2. If the push fails after the commit, `rad approve` exits 1 and says a rerun is safe. A rerun on a plan whose latest `approved` event has the current fingerprint records nothing new: it commits only if the two paths still have changes, pushes if the branch isn't on origin, labels, and exits 0. A rerun after a fully published approval also exits 0 without writing anything.
3. `rad approve --no-commit <f>` behaves exactly as `rad approve` does today: it records the event and header only, and the RAD_SYNC best-effort push still applies. In this mode an already-approved plan is still refused, as today.
4. Before writing anything, the commit path refuses with exit 2 when HEAD is not the plan's work branch, when the index has staged changes, or when a `--trailer` is invalid. The existing authority and blocker refusals keep their current exit code (1) and still write nothing.
5. `rad plan-status <f> <rejected|needs-revision> [--trailer …]` refuses with exit 2, changing nothing, in each of these cases: the running user isn't an architect, the status argument isn't one of the two, the plan header's Status is `approved`, `in-progress` or `complete`, the approved gate passes for the feature, HEAD isn't the work branch, or there are staged changes. Otherwise it sets `Status: <status>` in the header, commits only the plan file with subject `review: <f> <status>` (body `Plan:`, `Issue:`, `Reviewed-By:`, then trailers), pushes, labels the issue `<status>`, and exits 0.
6. When `plan-status` finds the plan already at the requested status, it treats the call as a rerun: it commits the plan file only if it has uncommitted changes (for example, newly written `## Architect Feedback`), pushes if needed, labels, and exits 0. A push failure exits 1 and a rerun resumes.
7. `/rad-approve` no longer contains `git add`, `git commit`, `git push` or `rad-label.sh` steps. The approve, reject and feedback paths call `node harness/cli.js approve` and `node harness/cli.js plan-status`, and the prose says how to handle exit codes 0, 1 and 2 and how to pass `--trailer`.
8. `harness/cli.js` no longer says the CLI never pushes. `docs/rad-cli.md` documents the new default, `--no-commit`, `--trailer` and `rad plan-status`, and `UPGRADE.md` records the behavior change.
9. All existing harness tests pass, with callers that relied on the old no-commit behavior updated to pass `--no-commit`, and the eval fixture still builds an approved plan.

## Agent Scope
Research was done directly in this session: harness/cli.js, harness/plan-open.js, harness/plan-commit.js, rad-approve.md, rad-label.sh, lint-plan.sh, the approve tests and the eval fixture. No context-tool agents were called. There are no out-of-scope dependencies.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| harness/plan-commit.js | 1-193 | Add pure `approveCommitMessage`, `reviewCommitMessage` and `setPlanStatus(text, status)` helpers |
| harness/branch-publish.js | 1-1 | New: a shared resumable commit/push/label step for a fixed set of paths on the work branch |
| harness/plan-status.js | 1-1 | New: `planStatusCommand`, `parsePlanStatusArgs`, `PLAN_STATUS_USAGE` |
| harness/cli.js | 1-20 | Fix the "never pushes a branch" comment; list `approve` flags and `plan-status` |
| harness/cli.js | 56-60 | Import the plan-status module |
| harness/cli.js | 86-96 | Update `approve` usage/summary |
| harness/cli.js | 178-190 | Add the `plan-status` SUBCOMMANDS entry |
| harness/cli.js | 336-400 | `parseApproveArgs`: `--no-commit`, repeatable `--trailer` |
| harness/cli.js | 1800-1990 | `approveCommand`: branch and index precheck, resume path, commit/push/label via branch-publish |
| harness/test/cli.test.js | 250-280 | Pass `--no-commit` where the test expects the old behavior |
| harness/test/approval-authority-recording.test.js | 440-520 | Pass `--no-commit` where the tests expect the old behavior |
| harness/test/portable-process-memory.test.js | 390-430 | Pass `--no-commit` (this test covers the RAD_SYNC path) |
| harness/evals/lib/fixture.js | 125-135 | Fixture approve passes `--no-commit` and keeps its own commit |
| harness/test/plan-commit.test.js | 1-1 | Extend: tests for the new message and status helpers |
| harness/test/cli-approve-commit.test.js | 1-1 | New: real-git tests for approve commit, push, resume and refusals |
| harness/test/cli-plan-status.test.js | 1-1 | New: real-git tests for plan-status |
| .claude/commands/architect/rad-approve.md | 300-390 | Steps 3–5 call `approve` and `plan-status`; remove the hand-run git and label steps |
| .claude/commands/architect/rad-approve.md | 420-430 | Rules: the commit is made by the CLI |
| docs/rad-cli.md | 1-12 | Intro: the CLI pushes in `approve`, `plan-open` and `plan-status` |
| docs/rad-cli.md | 40-66 | `### rad approve` update and a new `### rad plan-status` section |
| UPGRADE.md | 10-30 | Rows for approve-commits-by-default and `rad plan-status` |

## Execution Notes

### Do Not Touch
- harness/plan-open.js — it stays as delivered in 2a; sharing code with it is a follow-up
- harness/gates.js, harness/events.js, harness/transitions.js — the gate fold and event model don't change
- scripts/rad-label.sh, scripts/check-role.sh — called, not changed

### Key Files
- harness/plan-open.js — the pattern to copy: the stop classes, `gitOrStop`, the exit-code constants, success-line format, `--trailer` parsing and the resume-by-checking style
- harness/plan-commit.js — `planCommitMessage`, `validateTrailer`, `planIssueNumber`, `planWorkBranch`
- harness/test/cli-plan-open.test.js — the real-git-with-bare-origin test setup to reuse
- harness/cli.js `approveCommand` — authority, blocker check, `recordApproval`, `writePlanStatus`, `bestEffortSyncPush`

### Reminders
- Every git call is an args array through `sh`. Commit with an explicit pathspec (`git commit -m … -- <paths>`) so unrelated files can never ride along.
- Every precheck that can refuse runs BEFORE `recordApproval` or any header write, so a refusal changes nothing.
- The resume check for approve is "the latest `approved` event's fingerprint equals the current plan fingerprint". Only the commit path uses it; `--no-commit` keeps today's refusal.
- The re-approval subject is decided from the log BEFORE the new event is appended.
- The RAD_SYNC best-effort push runs only under `--no-commit`. The default path always pushes and fails closed (exit 1).
- The label runs only after a successful push.

## Program Design

**Signatures**
```js
// harness/plan-commit.js (pure)
export function approveCommitMessage(text, { feature, reapproval, approvedBy, recordedBy, evidence, proxy }, trailers = []) // → string
export function reviewCommitMessage(text, { feature, status, reviewedBy }, trailers = [])  // → string
export function setPlanStatus(text, status)                                                 // → string
// harness/branch-publish.js
export function requirePublishReady(sh, repoRoot, branch)                                   // → string | null (refusal)
export function publishPlanChange(sh, repoRoot, { verb, branch, paths, message, issue, labelStatus }) // → { code, committed, pushed, message }
// harness/plan-status.js
export const PLAN_STATUS_USAGE = 'rad plan-status <feature> <rejected|needs-revision> [--trailer "Key: Value"]...';
export function parsePlanStatusArgs(argv)        // → { feature, status, trailers }
export async function planStatusCommand(argv, ctx) // → 0 | 1 | 2
```

**Call stack: `rad approve <f>` (default path)**
```
approveCommand
  parseApproveArgs            → { feature, onBehalfOf, evidence, noCommit, trailers }
  authority + blockers        (unchanged; refusals exit 1)
  requirePublishReady         → refusal → exit 2, nothing written
  latestApprovedEvent(history).fingerprint === planHash ?
     yes → resume (skip record)
     no  → reapproval = any approved event; recordApproval; writePlanStatus
  publishPlanChange(paths=[plan, events], approveCommitMessage(...), labelStatus='approved')
     commit-if-dirty → push-if-needed → label → code 0 | 1
```

**Call stack: `rad plan-status <f> <status>`**
```
planStatusCommand
  parsePlanStatusArgs → isSafeFeature / reserved slug / plan exists / check-role architect
  refuse if header Status ∈ {approved,in-progress,complete} or approved gate passes
  requirePublishReady
  header Status !== status ? write setPlanStatus(...)
  publishPlanChange(paths=[plan], reviewCommitMessage(...), labelStatus=status)
```

**File tree diff**
```
harness/
  branch-publish.js            + new
  plan-status.js               + new
  plan-commit.js               ~ three helpers
  cli.js                       ~ approve flags/flow, plan-status wiring, header comment
  evals/lib/fixture.js         ~ --no-commit
  test/cli-approve-commit.test.js  + new
  test/cli-plan-status.test.js     + new
  test/{cli,approval-authority-recording,portable-process-memory,plan-commit}.test.js ~
.claude/commands/architect/rad-approve.md ~
docs/rad-cli.md, UPGRADE.md   ~
```

## Wave Plan

### Wave 1 — parallel
Pure helpers and the shared publish step. They don't depend on each other.

#### Task 1.1: Commit-message and status helpers
File: harness/plan-commit.js:1-193, harness/test/plan-commit.test.js:1-1
What: Add `approveCommitMessage(text, { feature, reapproval, approvedBy, recordedBy, evidence, proxy }, trailers)`, which builds the AC#1 subject and body: `Plan: .agents/plans/<f>.md`, `Issue:` from `planIssueNumber` (omitted when null), `Approved-By:`, and `Recorded-By:`/`Approval-Evidence:` in proxy mode only, then the trailers. Add `reviewCommitMessage(text, { feature, status, reviewedBy }, trailers)`, which builds `review: <f> <status>` with `Plan:`, `Issue:`, `Reviewed-By:` and the trailers. Add `setPlanStatus(text, status)`, which replaces the first `Status:` header line (inserting it after `Author:` if missing) and returns the new text. Both message builders throw on an invalid trailer, using `validateTrailer`. Extend plan-commit.test.js with these edge cases: no issue, proxy vs direct, re-approval subject, trailer order, invalid trailer, a missing `Status:` line, and a `Status:` line inside a fenced block below the header that must not be touched.
Validate: AC#1, AC#5 — `node --test harness/test/plan-commit.test.js` passes

#### Task 1.2: Shared resumable publish step
File: harness/branch-publish.js:1-1
What: Export `publishPlanChange(sh, repoRoot, { verb, branch, paths, message, issue, labelStatus })`. It commits `paths` only if `git status --porcelain -- <paths>` is non-empty (`git add -- <paths>`, then `git commit -m <message> -- <paths>`). It pushes with `git push -u origin <branch>` when the remote branch is missing or the local tip differs from `origin/<branch>`. After a successful push it runs `scripts/rad-label.sh <issue> <labelStatus>`, or prints `label skipped: no issue` when `issue` is null. It returns `{ code: 0|1, committed, pushed, message }`. A failed commit, push or label returns code 1 with a message ending "a rerun of <verb> is safe and resumes". Also export `requirePublishReady(sh, repoRoot, branch)`, which returns a refusal message when HEAD isn't `branch` or `git diff --cached --quiet` is non-zero, and null otherwise. Use named constants for the exit codes and script paths, and an args array for every call.
Validate: AC#2, AC#6 — covered by the Wave 3 real-git tests; in this wave, `node -e "import('./harness/branch-publish.js')"` loads cleanly

### Wave 2 — sequential
The commands are wired on top of Wave 1, then the old callers are updated.

#### Task 2.1: approve commits by default
File: harness/cli.js:1-20, 86-96, 336-400, 1800-1990
What: `parseApproveArgs` accepts `--no-commit` and a repeatable `--trailer` (validated with `validateTrailer`; an invalid trailer → exit 2 on the commit path). In `approveCommand`, keep the current flow for `--no-commit`. On the default path:
(a) After the authority and blocker checks, and before any write, call `requirePublishReady` (refusal → exit 2).
(b) Read the history. If the latest `approved` event's fingerprint equals the current plan hash, skip `recordApproval` and `writePlanStatus` and go to publish (the resume path, AC#2). Otherwise note whether any `approved` event exists (the re-approval flag), then record and write the header as today.
(c) Call `publishPlanChange` with the plan and events paths, `approveCommitMessage`, `planIssueNumber`, and `labelStatus: 'approved'`. Return its code. On 0, print the existing success line with ` committed=<bool> pushed=<bool>` appended.
The default path doesn't call `bestEffortSyncPush`. Fix the header comment at line 11 to say the CLI pushes only through the `approve`, `plan-open` and `plan-status` publish steps, and update the subcommand usage lines.
Validate: AC#1, AC#2, AC#3, AC#4 — `node --test harness/test/cli.test.js` passes after Task 2.3

#### Task 2.2: rad plan-status
File: harness/plan-status.js:1-1, harness/cli.js:56-60, 178-190
What: `rad plan-status <feature> <rejected|needs-revision> [--trailer "Key: Value"]...`. Validate the feature name with `isSafeFeature` and refuse `_architecture`. Read `.agents/plans/<f>.md` (missing → exit 2) and check the architect role through `scripts/check-role.sh architect <repoRoot>`. Refuse with exit 2 when the header Status is `approved`, `in-progress` or `complete`, or when `evaluateGate('approved', history)` passes (read the log through `createGitStateStore`). Then call `requirePublishReady`. If the header Status differs from the requested one, write it with `setPlanStatus`. Call `publishPlanChange` with the plan path only, `reviewCommitMessage` (`reviewedBy` = git `user.email`), the issue and `labelStatus: <status>`. On 0, print `rad plan-status: ok feature=… status=… committed=… pushed=… issue=…`. Register it in SUBCOMMANDS with `PLAN_STATUS_USAGE`.
Validate: AC#5, AC#6 — `node harness/cli.js plan-status --help` and a bad-status call exit 2 with usage

#### Task 2.3: Update callers that relied on the no-commit default
File: harness/test/cli.test.js:250-280, harness/test/approval-authority-recording.test.js:440-520, harness/test/portable-process-memory.test.js:390-430, harness/evals/lib/fixture.js:125-135
What: Add `--no-commit` to the existing `approveCommand` and fixture approve calls so they keep testing the record-only behavior. Change no assertions. The fixture keeps its own `git add -A` and commit.
Validate: AC#3, AC#9 — `node --test harness/test/` passes in full

### Wave 3 — parallel
Tests for the new behavior, plus prose and docs.

#### Task 3.1: Real-git tests for approve and plan-status
File: harness/test/cli-approve-commit.test.js:1-1, harness/test/cli-plan-status.test.js:1-1
What: Reuse the cli-plan-open.test.js setup (a real repo with a bare origin, `check-role.sh` and `rad-label.sh` stubbed through the injected `sh`, real git for everything else). The approve cases are: a direct commit with the exact subject and body, proxy fields, the re-approval subject, trailer order, a push failure (origin removed) → exit 1 then a rerun → 0 with a single commit, a rerun after full publish → 0 with no new commit, wrong branch → 2 and nothing written, a staged unrelated file → 2 and nothing written, an unrelated unstaged edit that is never committed, and `--no-commit` matching today's behavior. The plan-status cases are: rejected and needs-revision commits, each refused status → 2, a passing approved gate → 2, non-architect → 2, bad status → 2, a same-status rerun with new feedback that commits the plan file only, a same-status rerun with nothing to commit that pushes and labels, and a push failure → 1 then a rerun → 0.
Validate: AC#1, AC#2, AC#4, AC#5, AC#6 — `node --test harness/test/cli-approve-commit.test.js harness/test/cli-plan-status.test.js` passes

#### Task 3.2: /rad-approve calls the commands
File: .claude/commands/architect/rad-approve.md:300-390, 420-430
What: In Step 3, **no** runs `node harness/cli.js plan-status "$FEATURE" rejected` (proxy-mode cancel is unchanged). **feedback** first appends the `## Architect Feedback` section to the plan file, then runs `node harness/cli.js plan-status "$FEATURE" needs-revision`. Step 4 runs `node harness/cli.js approve "$FEATURE" [--trailer …]`, which now also commits, pushes and labels. Remove Step 5 (the hand-run git and label commands) and renumber Step 6. Add exit-code handling: 0 continue; 1 report, then fix a refusal or rerun once the push can succeed (a rerun is safe); 2 nothing changed, fix and rerun. Add one `--trailer "Key: Value"` per attribution line the tool requires. Update the Rules so the commit is made by the CLI and contains only the plan and event log.
Validate: AC#7 — `grep -nE 'git (add|commit|push)|rad-label' .claude/commands/architect/rad-approve.md` returns nothing; `scripts/lint-agent-files.sh` and `node harness/cli.js generate --check` exit 0

#### Task 3.3: Docs
File: docs/rad-cli.md:1-12, 40-66, UPGRADE.md:10-30
What: Update the rad-cli intro (the CLI pushes only in `approve`, `plan-open` and `plan-status`). Rewrite `### rad approve` for the default commit, push and label, the resume, `--no-commit`, `--trailer`, the exit codes and the success-line fields. Add a `### rad plan-status` section. Add UPGRADE rows: "`rad approve` now commits and pushes; pass `--no-commit` for the old behavior" and "new `rad plan-status`".
Validate: AC#8 — `grep -n 'never pushes' harness/cli.js docs/rad-cli.md` returns nothing; `grep -n 'rad plan-status' docs/rad-cli.md UPGRADE.md` matches

## Tests to Write
- [ ] Commit-message and status helper unit tests — harness/test/plan-commit.test.js
- [ ] Approve commit, push, resume and refusal tests (real git) — harness/test/cli-approve-commit.test.js
- [ ] plan-status tests (real git) — harness/test/cli-plan-status.test.js

## Non-Goals
- Changing approve's existing refusal exit codes from 1 to 2. Unifying them is a follow-up.
- Moving `/rad-approve` to `.rad/skills`, or adding a Codex wrapper (part 2c).
- Refactoring `plan-open.js` to use `branch-publish.js`.
- Adding `rejected`/`needs-revision` events to the event log. The header and label remain the only record, as today.
- Proxy (`--on-behalf-of`) support for `plan-status`.

## Out-of-Scope Dependencies
None

## Risks
- **Behavior change for anything that runs `rad approve` and then commits by hand.** That second commit now finds nothing to commit. Known callers are the `/rad-approve` prose (updated here), the eval fixture and the approve tests (both given `--no-commit`). The user confirmed on 2026-10-07 that usage is narrow enough to accept this.
- **The live-eval prompt-injection case** (`harness/evals/live.eval.js`) has an agent run `node harness/cli.js approve demo` mid-run. It will now also try to commit and push inside the fixture. The #158 run-scoped freeze still stops the run; the eval asserts on events, not commits. It isn't run in CI.
- **Mixed exit-code meaning for approve.** Exit 1 now covers both the old refusals (nothing written) and the new resumable publish failure. Both are safe to rerun, and the message says which applies.
- **Self-protected paths** (`harness/`, `.claude/`): this plan needs architect review by design.

## Issue Gaps
- **Assumption — exit codes:** approve's existing refusals keep exit 1. The new commit-path refusals use exit 2 and publish failures use exit 1, matching plan-open. Architect to verify.
- **Assumption — branch and index precheck:** the commit path refuses unless HEAD is the work branch and the index is clean. Unrelated unstaged edits are allowed and never committed (explicit pathspec).
- **Assumption — plan-status refusal also uses the event log:** besides the display-only header, `plan-status` refuses when the approved gate passes, so a plan whose header is stale but which is still approved can't be marked rejected. The `plan-status` architect check is direct only, with no proxy.
- **Assumption — Reviewed-By:** the `review:` commit body carries `Reviewed-By: <git user.email>`. Nothing in the decisions named this line.
- **Assumption — the old default on resume:** under `--no-commit`, an already-approved plan is still refused (exit 1), so today's behavior holds exactly.
