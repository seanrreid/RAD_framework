# Plan: Rerun After a Failed Stop Names the Way Out
Created: 2026-10-16
Author: architect
Status: approved
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-16T20:39:26.731Z
Recorded-By: sean@torchcodelab.com
Branch: rad/rerun-after-failed-stop
Issue: 287
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/287
Issue-Title: rad deliver: the claude command preset sets no permission mode, so a delivery can write only what the launching session allows
Source-Author: seanrreid (OWNER)
Source-Comments: 1 total, 0 non-collaborator

## Context
Items 1, 2 and 4 of #287 shipped in #290, #291 and #292. Item 3 remains. After a failed stop (`finish-failed`, `doom-loop`) the worktree is preserved. A plain `rad deliver` rerun then refuses with a generic "already checked out in another worktree" message (`ensureBranchFree`, exit 2), and `--resume` refuses failed stops (`resolveResume`). Neither message names the way out. The way out that works today is removing the preserved worktree and rerunning, which resumes from the event log without redoing completed waves. Removal needs `git worktree remove --force` when the worktree holds a half-written draft, which `scripts/worktree-lifecycle.sh remove` refuses.

## Scope
| In scope | Out of scope |
|---|---|
| Name the removal step when the holder is this feature's preserved worktree | Reusing the preserved worktree on a plain rerun |
| Tell a `--resume` of a failed stop to remove the worktree and rerun without `--resume` | Making `--resume` accept failed stops |
| Say how to remove a dirty preserved worktree | Changing `worktree-lifecycle.sh` semantics or adding `--force` |
| Docs for the recovery path | Hand-finished deliveries (#295) |

## Acceptance Criteria
1. When a plain `rad deliver` refuses because the work branch is held by a worktree whose marker names this feature with status preserved, the message names that directory and the exact `scripts/worktree-lifecycle.sh remove <feature> <dir>` command, and says to rerun afterwards; the exit code stays 2.
2. The same message says that if the removal is refused because the worktree has uncommitted changes, `git worktree remove --force <dir>` discards them.
3. A holder with no marker, another feature's marker, an active marker, a malformed marker, or more than one holder keeps today's generic message unchanged (no removal advice for a worktree RAD does not own).
4. `rad deliver --resume` refusing a failed stop appends: a failed stop is not resumed; fix the cause, remove any preserved worktree, and rerun `rad deliver` without `--resume`.
5. `docs/rad-cli.md` documents the recovery path (when each message appears and the two removal commands).

## Agent Scope
Research ran inline (no sub-agent): `harness/cli.js` (`ensureBranchFree`, `findReusableWorktree`, `resolveResume`, `prepareWorktreeRoot`), `harness/stops.js` (`finish-failed`), `scripts/worktree-lifecycle.sh`, and the test files and fixtures that pin these messages. No out-of-scope agents.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| harness/cli.js | 1284-1303, 1550-1556 | Marker-aware holder message in `ensureBranchFree`; failed-stop hint in `resolveResume` |
| harness/test/worktree.test.js | 1-80 | Preserved-own-feature, no-marker, other-feature, active, malformed and two-holder cases |
| harness/test/cli.test.js | 1-80 | Failed-stop `--resume` refusal carries the hint |
| harness/test/fixtures/cli-commands-golden.json | 1-40 | Update only entries that pin the changed refusal text |
| docs/rad-cli.md | 1-60 | Recovery path under `rad deliver` |

## Execution Notes

### Do Not Touch
- `scripts/worktree-lifecycle.sh` (its marker interlock is the safety property; no `--force` is added)
- `harness/stops.js` and `docs/rad-wave-contract.md` stop table (decision texts are pinned by goldens and invariants; unchanged)

### Key Files
- `harness/cli.js` — `findReusableWorktree` already reads the marker and sanitizes its error; reuse that pattern, do not duplicate marker parsing
- `harness/adapters/worktree.js` — `readMarker` and `STATUS_PRESERVED`

### Reminders
- Fail closed: any marker read error means "not owned", i.e. today's generic message.
- Paths in the message come from `git worktree list`; quote them in the printed command.

## Wave Plan

### Wave 1 — sequential
#### Task 1.1: Marker-aware refusal and resume hint
File: harness/cli.js:1284-1303, 1550-1556, harness/test/worktree.test.js, harness/test/cli.test.js, harness/test/fixtures/cli-commands-golden.json
What: In `ensureBranchFree`, when there is exactly one holder, read its marker through the same `worktree.readMarker` path as `findReusableWorktree` (extract a small `ownedPreservedWorktree(feature, holder, worktree)` helper both use). If it is this feature's preserved worktree, print the removal guidance (AC#1, AC#2); in every other case print today's message. `ensureBranchFree` needs the feature and the lifecycle object passed in. In `resolveResume`, append the AC#4 hint to the failed-stop refusal. Tests per AC#1-4; regenerate golden entries only where the text is pinned.
Validate: AC#1, AC#2, AC#3, AC#4 — `node --test harness/test/worktree.test.js harness/test/cli.test.js` with one assertion per marker case and the exact exit code 2.

### Wave 2 — sequential
#### Task 2.1: Document the recovery path
File: docs/rad-cli.md:1-60
What: Under `rad deliver`, add a "Rerunning after a failed stop" subsection: a plain rerun is refused while the preserved worktree holds the branch; remove it with `scripts/worktree-lifecycle.sh remove <feature> <dir>` (or `git worktree remove --force <dir>` when it holds uncommitted changes, which discards them), then rerun; `--resume` is for needs-decision stops only.
Validate: AC#5 — grep the doc for both commands; `bash scripts/verify-all.sh` doc checks pass.

Verify: exec bash scripts/verify-all.sh

## Tests to Write
- [ ] preserved own-feature holder prints the remove command and the `--force` note, exit 2 — harness/test/worktree.test.js
- [ ] no-marker, other-feature, active, malformed marker and two holders keep the generic message — harness/test/worktree.test.js
- [ ] `--resume` on a failed stop carries the rerun-without-`--resume` hint — harness/test/cli.test.js

## Non-Goals
- Reusing the preserved worktree on a plain rerun (the issue's alternative fix); it would carry a half-written draft into the next attempt.
- Allowing `--resume` to continue a failed stop.
- Adding a `--force` mode to `worktree-lifecycle.sh`.
- Fixing the main-checkout branch switch that `rad deliver` performs.

## Out-of-Scope Dependencies
None

## Risks
- Touches `harness/`: self-protected, architect review applies; deliver with `RAD_VERIFY_TIMEOUT_SECONDS=1800`.
- The refusal text is pinned by goldens and may be matched elsewhere; the edit must update every pinned copy and nothing else.
- The message recommends a destructive `--force` removal. It names the discard explicitly and only for a worktree RAD itself marked as this feature's.

## Issue Gaps
- ASSUMPTION: the issue's choice between reuse and naming the remove step resolves to naming it. Reuse would carry an unvalidated draft into the next attempt and changes resume semantics; naming the step is the smaller, fail-closed change. Architect to confirm.
- ASSUMPTION: `git worktree remove --force` is the right advice for a dirty preserved worktree, because `worktree-lifecycle.sh remove` refuses one. This was the working recovery for the `permission-refusal-stop` delivery on 2026-10-16.
- ASSUMPTION: the `finish-failed` decision text ("re-run rad deliver to finish") is left as is; the actionable detail appears in the refusal a rerun produces. Changing it would touch goldens, invariants and the stop table in docs.
- The issue's wording "the message names the remove step" is read as the rerun refusal, not the original stop message.
