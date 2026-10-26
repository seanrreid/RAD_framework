# Plan: Delivery Record Accuracy (#293, #294, #295)
Created: 2026-10-26
Author: developer
Status: complete
Completed-At: 2026-10-26T16:17:20.846Z
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-26T15:47:35.714Z
Recorded-By: sean@torchcodelab.com
Branch: rad/delivery-record-accuracy
Issue: 293
Source-Author: seanrreid (OWNER)
Source-Comments: 0 total, 0 non-collaborator

## Context
Three defects make the delivery record untrustworthy. (#293) `rad digest` reports the latest `deliver-stopped` event as the feature's state even after a later run completed and opened the PR. (#294) The rework fold in `harness/delivery-metrics.js` follows a git copy (`C`) touch back to its source, so copying a file counts as rework of the untouched source. (#295) A delivery finished by hand after `rad deliver` stops leaves a `deliver-stopped` event, no `pr-opened` event and a plan `Status` still `approved`; nothing records that the PR exists. Closes #293, closes #294, closes #295.

## Scope
| In scope | Out of scope |
|---|---|
| Digest stops reporting a stop that a later `pr-opened` supersedes (new pure fold; `latestStop` unchanged) | Changing `latestStop`/`dormantStop` semantics or the stop-status verb |
| Copy (`C`) touches no longer count as rework of the source path | Reworking how renames or deletes are followed |
| New `rad record-pr <feature> --pr <n>` verb: records `pr-opened` and marks the plan complete for an OPEN PR whose head is the work branch | Adopting an already-merged PR or a deleted work branch |
| Docs for the new verb in `docs/rad-cli.md` | Any change to `rad deliver` flag parsing |

## Acceptance Criteria
1. `rad digest` omits the `stopped:` line when a `pr-opened` event follows the latest `deliver-stopped`, and still shows it when no `pr-opened` follows or when a stop occurs after the `pr-opened`.
2. A touch with status `C` does not add its source path to the reworked set, does not change `live`, and is not counted as a rework commit; a `C` whose destination is a tracked live path is judged by that destination. Renames, deletes and plain modifications behave as before.
3. `rad record-pr <feature> --pr <n>` on an approved feature whose open PR head is `rad/<feature>` appends exactly one `pr-opened` event carrying the PR number and a hand-finished marker, sets the plan header `Status: complete` with `Completed-At:`, and publishes only the plan file and `events.jsonl` to the work branch.
4. The verb refuses (exit 2, nothing written) when: the feature is not approved; the history already evidences a `pr-opened` after the last `deliver-started`; `--pr` is missing, non-integer or not positive; the PR is not open; the PR head is not the work branch; or the PR lookup fails. A lookup failure is reported with its reason, never treated as success.
5. A rerun after a publish failure resumes without appending a second `pr-opened`.
6. `docs/rad-cli.md` documents `rad record-pr` (usage, exit codes, refusals, and that it is for hand-finished deliveries only).

## Agent Scope
Research done inline against `harness/digest.js`, `harness/events.js`, `harness/delivery-metrics.js`, `harness/delivery-history.js`, `harness/deliver-finish.js`, `harness/plan-status.js`, `harness/cli.js`, `harness/plan-commit.js`, `harness/branch-publish.js`. No sub-agents. No out-of-scope agent dependencies.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| harness/events.js | 1307-1347 | add pure fold `currentStop(history)`: the latest stop unless a `pr-opened` follows it |
| harness/test/events.test.js | 1500-1574 | tests for `currentStop` |
| harness/digest.js | 185-195 | use `currentStop` for the `stopped:` line |
| harness/test/digest.test.js | 150-197 | stopped-then-delivered renders no stopped line; stop after PR still renders |
| harness/delivery-metrics.js | 105-122 | `reworkTouches` keys a copy touch by its destination, never its source |
| harness/test/delivery-metrics.test.js | 150-219 | copy of a live file is not rework; plain-modify and moved-file cases unchanged |
| harness/record-pr.js | 1-150 | new verb module: parse args, gate, PR lookup, append event, mark complete, publish |
| harness/test/record-pr.test.js | 1-250 | new tests for every AC#3-5 path, edge cases named below |
| harness/cli.js | 225-240 | register the `record-pr` subcommand |
| docs/rad-cli.md | 176-228 | document `rad record-pr` beside `rad plan-status` |

## Program Design
```
// events.js
export function currentStop(history: Event[]): object | null   // throws on non-array, like latestStop
// record-pr.js
export const RECORD_PR_USAGE = 'rad record-pr <feature> --pr <n>'
export function parseRecordPrArgs(argv): { feature, pr }        // throws a usage error (exit 2)
export async function recordPrCommand(argv, ctx): exit code     // 0 ok | 1 publish failed (rerun safe) | 2 refused
```
Flow: `recordPrCommand` → parse → `isSafeFeature` → read history from the work-branch tip (as `deliver` does) → refuse unless approved and not already `pr-opened` → `gh pr view <n> --json state,headRefName` via `sh` → refuse unless OPEN and head == work branch → `state.append({type:'pr-opened', data:{pr, handFinished:true}})` → mark plan `complete` → `publishPlanChange` (plan + events only).
New files: harness/record-pr.js, harness/test/record-pr.test.js.

## Execution Notes

### Do Not Touch
- harness/gates.js, harness/matrix.yaml — no gate or stop-matrix change
- `latestStop` / `dormantStop` — audit and resume semantics stay exactly as they are
- harness/spine.js — the normal delivery path is unchanged

### Key Files
- harness/deliver-finish.js — `markComplete`, `Completed-At`, and the pr-opened publish are the model for the verb
- harness/plan-status.js — publish-ready checks, `isSafeFeature`, and exit-code conventions the verb mirrors
- harness/events.js — `PHASE_BY_TYPE` maps `pr-opened` to `delivered`; the new event must pass `validateTransition`

### Reminders
- Edge cases to test: empty history, non-array history, `pr-opened` before the stop, stop with no `data`, `C` touch with no `oldPath`, `C` onto an already-live path, `--pr 0`, `--pr -3`, `--pr abc`, `--pr 1.5`, missing feature.
- Never swallow a `gh` failure: exit non-zero with the reason.
- The new verb must stay under ~40 lines per function with named constants; every catch rethrows, exits non-zero or logs the reason.

## Wave Plan

### Wave 1 — sequential
Tasks in this wave must run in sequence.

#### Task 1.1: Supersede a stop once the PR is opened
File: harness/events.js:1307-1347, harness/digest.js:185-195
What: Add `currentStop(history)` returning `latestStop(history)` unless a `pr-opened` event comes after the last `deliver-stopped`, then null; non-array history throws. Switch the digest's `stopped:` line to it.
Validate: AC#1 — digest tests show the line gone after a later `pr-opened` and present otherwise.

#### Task 1.2: Tests for the stop supersede
File: harness/test/events.test.js:1500-1574, harness/test/digest.test.js:150-197
What: Cover stop-only, stop-then-pr-opened, pr-opened-then-stop, no stop, empty array, and non-array input for `currentStop`; digest renders accordingly.
Validate: AC#1 — `node --test harness/test/events.test.js harness/test/digest.test.js` passes.

### Wave 2 — sequential
Depends on: Wave 1 complete

#### Task 2.1: Copy touches are not rework of the source
File: harness/delivery-metrics.js:105-122
What: In `reworkTouches`, resolve a `C`-status touch by `touch.path` (the destination) instead of `oldPath`, so the source is never marked touched; leave `R`, `D` and modify handling unchanged.
Validate: AC#2 — metrics tests.

#### Task 2.2: Tests for copy handling
File: harness/test/delivery-metrics.test.js:150-219
What: Copy of a live source is not rework and leaves `live` untouched; copy onto a live destination is judged by the destination; copy with no `oldPath`; rename, delete and modify regressions still count.
Validate: AC#2 — `node --test harness/test/delivery-metrics.test.js` passes.

### Wave 3 — sequential
Depends on: Wave 2 complete

#### Task 3.1: The `record-pr` verb
File: harness/record-pr.js:1-150
What: Implement `parseRecordPrArgs` and `recordPrCommand` per Program Design: gate on an `approved` event and no `pr-opened` after the last `deliver-started`; look the PR up with `gh pr view <n> --json state,headRefName` through the injected `sh`; refuse unless OPEN and head equals the work branch; append `pr-opened` with `data: { pr, handFinished: true }`; mark the plan `Status: complete` plus `Completed-At:`; publish only the plan and `events.jsonl`. A rerun finding the event already recorded resumes at publish.
Validate: AC#3, AC#4, AC#5 — verb tests.

#### Task 3.2: Register the verb and test it
File: harness/cli.js:225-240, harness/test/record-pr.test.js:1-250
What: Add the `record-pr` entry (summary, usage, run) beside `plan-status`; write tests with an injected `sh` and state store for the success path, each refusal in AC#4, the lookup failure, and the resume in AC#5.
Validate: AC#3, AC#4, AC#5 — `node --test harness/test/record-pr.test.js harness/test/cli.test.js` passes.

#### Task 3.3: Document the verb
File: docs/rad-cli.md:176-228
What: Add a `### rad record-pr` section: usage, what it records, exit codes 0/1/2, the refusal list, and that it exists only for deliveries finished by hand.
Validate: AC#6 — the section exists with usage matching `RECORD_PR_USAGE`.

Verify: exec bash scripts/verify-all.sh

## Tests to Write
- [ ] currentStop supersedes a stop after pr-opened — harness/test/events.test.js
- [ ] digest drops a superseded stopped line — harness/test/digest.test.js
- [ ] copy touches are not rework of the source — harness/test/delivery-metrics.test.js
- [ ] record-pr success, refusals, lookup failure and resume — harness/test/record-pr.test.js

## Non-Goals
- Recording a hand-finished delivery whose PR is already merged or whose work branch is gone.
- Changing `rad deliver` flags (the issue's `--adopt-pr` spelling is replaced by a separate verb).
- Backfilling events for deliveries finished by hand before this lands (#288, #290).

## Out-of-Scope Dependencies
None. The plan edits `harness/` (self-protected), so it is flagged for architect review.

## Risks
- A new event writer is a new way to move a feature to `delivered`. Mitigated by gating on an `approved` event, an open PR whose head is the work branch, and no existing `pr-opened`; the event is marked `handFinished`.
- `gh` is an external dependency of the verb; its failure must stop the verb rather than record anything.
- The digest change hides a stop only when a `pr-opened` follows it, so a stop after a PR still shows.
