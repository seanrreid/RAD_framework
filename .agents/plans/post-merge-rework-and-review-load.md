# Plan: Delivery Folds: Post-Merge Rework Rate and Gate-2 Verification Load (1 of 2)
Created: 2026-10-15
Author: architect
Status: complete
Completed-At: 2026-10-15T21:43:32.402Z
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-15T20:43:51.500Z
Recorded-By: sean@torchcodelab.com
Branch: rad/post-merge-rework-and-review-load
Issue: 285
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/285
Issue-Title: Insights: post-merge rework rate and Gate-2 verification-load trends
Source-Author: seanrreid (OWNER)
Source-Comments: 0 total, 0 non-collaborator

## Context
RAD stops measuring when the deliver PR opens. `stageDurations` in `harness/cycle-metrics.js`
ends at `pr-opened`, so nothing can tell whether a delivered feature's files needed fixing soon
after merge, or whether Gate 2 (the architect reviewing the deliver PR) is turning into the
bottleneck. The issue cites Spotify's quality-at-velocity post
(https://engineering.atspotify.com/2026/9/ai-changed-how-spotify-builds-what-we-learned-and-fixed-about-quality-at-higher-velocity).
That post names an age-weighted rework rate and PR-size trends with thresholds deliberately left
unchanged. It does not define the rework window, the unit or the weighting, and it never mentions
review latency. This plan pins those down as recorded assumptions (see Issue Gaps).

The issue is split in two because one plan exceeded the lint context budget. **This plan (1 of 2)**
ships the harness: a pure fold module, a plain-git reader, their tests and the env-var doc row.
**Plan 2 of 2** (`rad/insights-rework-load-section`) adds the `/rad-insights` Step 4i, the report
section, the regenerated skill copies and the guide docs. It consumes this plan's exports and is
delivered after this plan merges.

The default branch is squash-merged. Each deliver merge is one first-parent commit with subject
`Deliver: <title> (#<PR>)`, and its body carries `deliver(<slug>)` / `Plan: .agents/plans/<slug>.md`.
The `pr-opened` event (`harness/spine.js`) carries `feature` and `ts` and nothing else, so this plan
joins on the feature slug.

## Scope
| In scope | Out of scope |
|---|---|
| Pure folds `reworkRate`, `verificationLoad`, `trend`, `resolveWindowDays` in a new `harness/delivery-metrics.js` | The `/rad-insights` step and report section (plan 2 of 2) |
| A git reader `readDeliveryHistory` in a new `harness/delivery-history.js` (plain git with injected `sh`; plan scope through `scripts/lib/plan-paths.sh`) | Any gate, warning or threshold driven by these numbers |
| `RAD_REWORK_WINDOW_DAYS` row in `docs/configuration.md` | Host-API calls (gh/glab) for PR data |
| | Code-complexity metrics (stack-specific, below the BYO seam) |
| | Changes to `harness/events.js` writer, `gates.js`, the fold, or `cycle-metrics.js` |

## Acceptance Criteria
1. `readDeliveryHistory` returns one record per deliver merge on the default branch's first-parent history: `{feature, sha, pr, mergedAt, files:[{path, added, deleted}], scopedFiles}`. It recognises both squash merges (`Deliver: … (#N)` and `deliver(<slug>)`/`Plan:` body) and two-parent merge commits (`Merge pull request #N from <owner>/rad/<slug>`, diffed against the first parent). It also returns every first-parent commit as `{sha, committedAt, isDeliver, feature?, touches:[{path, oldPath?, status}]}`, with renames detected (`-M`). Merges whose slug cannot be resolved are counted in `unresolved`, never guessed.
2. `verificationLoad(merges, histories)` returns per feature `{feature, pr, merged, files, linesChanged, openedToMergeMs}`. `openedToMergeMs` is the time from the last `pr-opened` event to `mergedAt`. It is `null` when the feature has no `pr-opened` event or the span runs backwards. A feature with a `pr-opened` event but no merge record is listed with `merged:false` and `openedToMergeMs:null`. Binary numstat (`-`) counts as 0 lines.
3. `reworkRate(merges, commits, {windowDays, now})` returns per feature `{feature, files, reworkedFiles, rate, reworkCommits, weightedRework, windowComplete}`:
   - **What counts:** a commit inside `(mergedAt, mergedAt + windowDays]` that touches a file the feature changed. Files are followed through renames, and a delete counts as a touch.
   - **Exclusions:** later deliver merges are excluded for files listed in their own `scopedFiles`, and `.agents/` paths are excluded from the file set.
   - **Formulas:** `rate = reworkedFiles / files`, or `null` when `files` is 0. `weightedRework` sums `1 - ageDays/windowDays` over rework touches, divided by `files`.
   - **Incomplete windows:** `windowComplete` is false when `mergedAt + windowDays > now`.
4. `trend(values)` returns `{arrow, n}` with `↑ / ↓ / →`, comparing the mean of the older half with the mean of the newer half. Fewer than 2 values gives `→`. There is no floor and no tolerance, and the sample size is always reported.
5. `resolveWindowDays(env)` parses `RAD_REWORK_WINDOW_DAYS` with `Number.parseInt`. Unset, 0, negative or NaN falls back to the named constant `DEFAULT_REWORK_WINDOW_DAYS = 14`. The variable is documented in `docs/configuration.md`.
6. Every edge case named in the issue has an explicit test: a feature with no merged PR, a PR with zero changed files, squash vs merge-commit, a file renamed after merge, a file deleted after merge, an empty history, and a window that runs past today.
7. Nothing new is written, and the change touches neither `harness/events.js`, `gates.js`, `cycle-metrics.js` nor `spine.js`. `scripts/verify-all.sh` passes.

## Agent Scope
Research was done by a general Explore sub-agent (read-only). No architect-only agents are needed.

## Program Design

**Signatures (new):**
```js
// harness/delivery-metrics.js — pure, no I/O
export const DEFAULT_REWORK_WINDOW_DAYS = 14;
export function resolveWindowDays(env) -> number
export function verificationLoad(merges, histories /* {feature: event[]} */) -> Row[]
export function reworkRate(merges, commits, { windowDays, now /* ms */ }) -> Row[]
export function trend(values /* oldest→newest, nulls dropped */) -> { arrow: '↑'|'↓'|'→', n }

// harness/delivery-history.js — the only module that shells out
export function readDeliveryHistory({ root, sh, defaultBranch }) -> { merges, commits, unresolved }
```

**Call-stack sketch (as plan 2's Step 4i will drive it):**
```
/rad-insights Step 4i
  → readDeliveryHistory({root, sh, defaultBranch})
      → git log --first-parent --diff-merges=first-parent -M … <defaultBranch>
      → per deliver merge: git show <sha>:.agents/plans/<slug>.md → tmp
          → sh '. scripts/lib/plan-paths.sh && plan_scope_paths' / path_matches → scopedFiles
  → verificationLoad(merges, histories)   // histories loaded as Step 4h does
  → reworkRate(merges, commits, {windowDays: resolveWindowDays(process.env), now: Date.now()})
  → trend(...) per series → JSON
```

**File-tree diff:**
```
+ harness/delivery-metrics.js
+ harness/delivery-history.js
+ harness/test/delivery-metrics.test.js
+ harness/test/delivery-history.test.js
~ docs/configuration.md   (one env-var row)
```

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| harness/delivery-metrics.js | 1-160 | NEW — pure folds and the window constant; header contract copied from cycle-metrics.js |
| harness/delivery-history.js | 1-180 | NEW — git reader: first-parent log parse, deliver-merge detection, rename-aware touches, scopedFiles via the shared plan-scope shell library |
| harness/test/delivery-metrics.test.js | 1-240 | NEW — node:test fold tests with inline literals |
| harness/test/delivery-history.test.js | 1-220 | NEW — temp-git-repo tests using the withRepo pattern |
| docs/configuration.md | 670-690 | Add the `RAD_REWORK_WINDOW_DAYS` env-var row |

## Execution Notes

### Do Not Touch
- harness/events.js
- harness/gates.js
- harness/cycle-metrics.js
- harness/spine.js
- scripts/lib/plan-paths.sh (call it; never reimplement its matching)

### Key Files
- harness/cycle-metrics.js — the read-side contract and the `spanMs`/`msOf` null semantics to mirror
- harness/test/deliver-finish.test.js — `git()` / `withRepo()` temp-repo helpers (lines 49-64)
- harness/digest.js — how JS invokes `plan_scope_paths` through an injected `sh` (lines ~29, ~60)
- scripts/lib/plan-paths.sh — `plan_scope_paths` (:82), `path_matches` (:94)

### Reminders
- Keep folds pure. `now` and `windowDays` are parameters, and all git and shell I/O lives in delivery-history.js.
- The PR number is the last `(#N)` in a squash subject, because some subjects also carry an issue number (`(#270) (#274)`).
- To read a past plan, `git show <sha>:.agents/plans/<slug>.md` into a temp file, then `plan_scope_paths`. If the plan is missing at that sha, `scopedFiles` is `[]`; never fail.
- Never swallow errors. A git failure in the reader throws with context, but an empty repo (no commits) returns empty arrays.
- Run `rad deliver` with `RAD_VERIFY_TIMEOUT_SECONDS=1800`.

## Wave Plan

### Wave 1 — parallel
Tasks in this wave can run in parallel.

#### Task 1.1: Pure delivery folds
File: harness/delivery-metrics.js, harness/test/delivery-metrics.test.js
What: Implement `DEFAULT_REWORK_WINDOW_DAYS`, `resolveWindowDays`, `verificationLoad`, `reworkRate`, `trend` per AC#2-5. Mirror cycle-metrics.js: header contract ("never read to block, warn or gate"), no I/O, null for missing or backwards spans. The tests cover a zero-file PR (`rate:null`), a missing `pr-opened`, a pr-opened without a merge, a backwards span, binary numstat, a window past `now` (`windowComplete:false`), a commit exactly at the window edge, a rename chain, a delete counted as a touch, a later deliver merge excluded only for its scoped files, `.agents/` paths excluded, the weighting (day-0 vs near-edge touch), an empty input (empty arrays), `trend` with 0, 1 and 2+ values and with nulls, and `resolveWindowDays` with unset, 0, -3, "abc" and "7".
Validate: AC#2, AC#3, AC#4, AC#5, AC#6 — `node --test harness/test/delivery-metrics.test.js`

#### Task 1.2: Git delivery-history reader
File: harness/delivery-history.js, harness/test/delivery-history.test.js
What: `readDeliveryHistory({root, sh, defaultBranch})` runs `git log --first-parent --diff-merges=first-parent -M` on the default branch, with numstat for line counts plus `--name-status` (or `--raw`) for status and rename pairs. It parses commits, detects deliver merges in both squash and merge-commit form, resolves `scopedFiles` per merge through `plan-paths.sh`, and returns `{merges, commits, unresolved}` per AC#1. Temp-repo tests build a squash-style deliver merge, a two-parent `Merge pull request #N from o/rad/<slug>` merge, a subject with two `(#N)` groups, a later direct fix commit, a later deliver merge whose plan scopes a shared file, a merge whose plan file is missing, a rename and a delete, an empty repo (empty arrays, no throw), and a deliver merge with zero changed files.
Validate: AC#1, AC#6 — `node --test harness/test/delivery-history.test.js`

### Wave 2 — sequential
Tasks in this wave must run in sequence.

#### Task 2.1: Document the env var and verify
File: docs/configuration.md:670-690
What: Add the `RAD_REWORK_WINDOW_DAYS` row to the further-variables table: default `14`, parsed like `parseInt` (unset/0/negative/non-numeric → default), read by `harness/delivery-metrics.js` (`resolveWindowDays`), information only. Then run the full suite and confirm the do-not-touch files are unchanged in the branch diff.
Validate: AC#5, AC#7 — `grep RAD_REWORK_WINDOW_DAYS docs/configuration.md` hits; `git diff --stat main -- harness/events.js harness/gates.js harness/cycle-metrics.js harness/spine.js` is empty; verify-all passes
Verify: exec bash scripts/verify-all.sh

## Tests to Write
- [ ] verificationLoad: sizes, binary numstat, missing pr-opened, no merge, backwards span — harness/test/delivery-metrics.test.js
- [ ] reworkRate: window bounds, incomplete window, rename follow, delete touch, scoped-deliver exclusion, .agents exclusion, zero files, weighting — harness/test/delivery-metrics.test.js
- [ ] trend + resolveWindowDays edge values — harness/test/delivery-metrics.test.js
- [ ] readDeliveryHistory: squash vs merge-commit, PR-number parse with two `(#N)`, plan scope at merge sha, missing plan, rename, delete, empty repo, zero-file merge — harness/test/delivery-history.test.js

## Non-Goals
- No gating, warning, target or threshold on any of these numbers, now or as a "soft" advisory.
- No host-API (gh/glab) lookups. Merge time and diff come from plain git only.
- No new events and no change to the event writer or the gate fold.
- No `/rad-insights` changes in this plan (plan 2 of 2).
- No code-complexity metric.

## Out-of-Scope Dependencies
None

## Risks
- Deliver merges made before the `deliver(<slug>)` body convention may not resolve to a slug. Those merges are counted in `unresolved`, never guessed.
- `git log` over the full history in a large repo could be slow. It runs only on demand from `/rad-insights`, never on a command path.
- File-level rework over-counts unrelated edits that happen to touch the same file (e.g. a shared docs file). It is reported as a signal, not a verdict, and the `.agents/` exclusion removes the main process-artifact noise.
- The plan adds files under `harness/`, so it is self-protected and flagged for architect review.

## Issue Gaps
- ASSUMPTION: the rework window defaults to **14 days**. The issue says "N days", and the Spotify post gives no window.
- ASSUMPTION: rework is measured per **file** (`reworkedFiles / files`), with commit count reported alongside. The issue and the post leave the unit open.
- ASSUMPTION: Spotify's "weighs the age of the code" is read as linear decay `1 - ageDays/windowDays` over each rework touch, so a fix the day after merge weighs more than one at day 13. It is reported as `weightedRework` next to the unweighted rate. The post gives no formula.
- ASSUMPTION: `.agents/` paths (plan, state, findings) are excluded from a feature's file set because they are process artifacts, not delivered code.
- ASSUMPTION: a file deleted within the window counts as rework, and a rename is followed so that later edits to the new path count.
- ASSUMPTION: direct (non-deliver) commits on the default branch count as rework. Later deliver merges are excluded only for files their own plan scopes.
- ASSUMPTION: "review latency" means the last `pr-opened` event to the merge commit's committer date. It is RAD's addition; Spotify's post tracks PR size and complexity but not latency.
- ASSUMPTION: trend arrows are computed in code (older-half mean vs newer-half mean, no tolerance), not left to the LLM the way the findings trend is. A tolerance would be a threshold.
- ASSUMPTION: the issue is split into two plans because a single plan exceeded the lint context budget (~3.8k lines, mostly the skill file and its two generated copies).
