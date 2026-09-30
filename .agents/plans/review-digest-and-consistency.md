# Plan: Review Digest, Plan-Consistency Passes, Post-Merge Convergence
Created: 2026-09-30
Author: architect
Status: pending-review
Branch: rad/review-digest-and-consistency
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/59, https://github.com/seanrreid/RAD_framework/issues/70, https://github.com/seanrreid/RAD_framework/issues/72
Issue-Title: Deliver-PR review digest (#59) + /rad-review cross-artifact consistency passes (#70) + Post-merge convergence check (#72)

## Context

This is Batch B, the review stage. RAD invests heavily in gating *entry* to work and little in compressing *exit* review:
- **#59:** Gate 2 is binary. The architect either reads the whole diff or rubber-stamps it, and nothing brings together the signals RAD already records.
- **#70:** plans get AC→task coverage but no deterministic task→AC check, and nothing catches vague adjectives, duplication or terminology drift.
- **#72:** nothing asks, after merge, whether the delivered code still matches the approved plan.

**What research found:**
- **Every digest signal is already computable read-only:**

  | Signal | Source |
  |---|---|
  | Scope conformance | `scripts/check-scope.sh <plan> <branch> [base]`: 0 in scope / 1 violation / 2 usage; `✗ <file>` lines plus a rename hint (:152-213) |
  | High-risk hits and waivers | `scripts/lib/plan-paths.sh` `plan_high_risk_findings` (:382, prints `high-risk:<path>`), `plan_waivers` (:424) and `path_is_self_protected` (:110) |
  | What approval froze | `approved.data.{fingerprint, waivers, highRiskPattern}` (`harness/adapters/git-state-store.js:418-432`) |
  | Run evidence | `harness/events.js` folds `outcomeCounts` (:345), `retryCounts` (:401), `totalUsage` (:293), `deliverCompleted` (:1202) and `latestStop` (:1234) |
  | Deficit forecast | `fileDeficitSignals` (:792) and `forecastForPaths` (:821), with the task→file mapping from `harness/plan-tasks.js` |
  | Approval intact | `planFingerprint` (`harness/plan-fingerprint.js:56`) and `cli.js` `latestApprovedEvent` (:832) and `makeApprovalIntact` (:846) |

  Finding recurrence per file has **no** JS fold yet; the only one is jq in `rad-insights.md:66`. A small pure fold is added to `harness/findings.js`.
- **`rad forecast` already has reusable gatherers:** `forecastScopePaths` (:1986, `plan_scope_paths` through the `sh` port), `forecastTaskFiles` (:2004) and `forecastHistory` (:2017). The `stop-status` and `forecast` commands show the subcommand pattern (:1931-2094).
- **`lint-plan.sh`** has only a *count* warning for tasks without an AC (:117-122). No task is named, and no AC→"no task cites it" check exists. Advisories append to `WARNINGS` before the budget section (:411).
- **Convergence locator:** `git log --diff-filter=A --format=%H main -- .agents/plans/<feature>.md` returns the deliver squash commit, because the plan first lands on `main` via the deliver PR (verified). Drift is then `git log <that>..main -- <plan_scope_paths>`.
- **`/rad-review`:** Step 1 defines `FEATURE`/`PLAN`/`BASE` (:30-42), Step 3 is plan fidelity (:76-81), and the Step 6 template has `### Scope` at :185. CI `deliver-integrity` (:130-172) has no `$GITHUB_STEP_SUMMARY` use yet.

**Architect decisions (2026-09-30):**
- Batch B is #59 + #70 + #72. #52 (interactive evaluation) moves to its own research-first plan.
- The digest is **one read-only CLI with two readers:** `/rad-review` prints it as a header, and the CI `deliver-integrity` job writes it to the job summary. There's no PR-comment posting, so no new host-API write path.
- Batch C (#154, #156, #161-163) is being delivered in parallel; see Risks for the shared CI job.

## Scope

| In scope | Out of scope |
|---|---|
| `harness/digest.js` (pure gather-with-injected-`sh` + rank + render) and `rad digest <feature>` | Posting a PR comment; any host-API write |
| `findingsByFile` fold in `harness/findings.js` | Model-written digest prose (#59's optional later layer) |
| `lint-plan.sh` advisories: named orphan tasks, uncited ACs, vague-adjective wordlist | Making any new lint check an error, or blocking approval |
| `/rad-review`: digest header + duplication and terminology-drift checklist items | #52 interactive evaluation (its own plan) |
| `scripts/check-plan-convergence.sh <feature>` (advisory) | Re-attesting drifted plans; any gate on drift |
| CI `deliver-integrity` job summary step; docs | Changing the `deliver-integrity` detection logic (Batch C, #154) |

## Acceptance Criteria

1. `findingsByFile(records, paths)` in `harness/findings.js` returns, for each path in `paths`, the count of `finding` records for that file, split by priority, plus the distinct categories. Paths with no findings are omitted. Bad input returns `{}`, and the function never throws.
2. `harness/digest.js` exports `buildDigest(inputs)` and `renderDigest(digest)`, both pure. Items are ranked by a **fixed** order and never suppressed (the digest is recall-oriented):
   1. scope violations
   2. approval not intact (fingerprint mismatch or gate not passing)
   3. un-waived high-risk hits
   4. waived high-risk hits, with their frozen justification
   5. self-protected paths touched
   6. deficit-forecast signals on in-scope paths
   7. finding recurrence on in-scope paths
   8. run evidence: retries, failed attempts, the latest stop, completion, token spend

   `renderDigest` produces markdown with three parts, in order:
   - `## Review digest — <feature>`
   - **"Look here"**: the ranked items. When there are none, it says `nothing flagged — every check below stayed inside the lines`.
   - **"Evidence"**: which checks passed.

   A missing input (e.g. no event log) renders an explicit `unavailable: <reason>` line and is never dropped.
3. `gatherDigestInputs({ repoRoot, sh, feature, branch, base })` in `harness/digest.js` collects every AC#2 input read-only, through the injected `sh` (the plan-paths functions and `check-scope.sh`) and the existing readers (state history, `findings.jsonl`, plans for task→file). It never writes and never calls a host API. A failing script becomes an `unavailable` input with its reason. It is never swallowed and never fatal.
4. `rad digest <feature> [--branch <ref>] [--base <ref>]` prints the rendered digest and exits 0.
   - **Defaults:** `--branch` comes from the plan's `Branch:` header, and `--base` from `scripts/get-default-branch.sh`.
   - **Exit 2:** bad arguments or an unreadable plan.
   - **Exit 1:** a malformed event log, naming the feature.
   - **Sections:** each section is produced even when its data is unavailable.
5. `scripts/lint-plan.sh` adds three **advisory** warnings, never errors:
   - **Orphan tasks:** each task whose `Validate:` cites no `AC#N` is named (`task '<Task N.M: title>' cites no AC`), replacing today's count-only warning.
   - **Uncited ACs:** each numbered AC that no task's `Validate:` cites is named (`AC#N is cited by no task`).
   - **Vague adjectives:** a fixed wordlist, as a named constant, applied to the Acceptance Criteria section and to task `What:` / `Validate:` lines. Fenced code blocks and inline code are excluded, and matching is case-insensitive on whole words.

   The exit status is unchanged.
6. `scripts/test-lint-plan.sh` covers AC#5 under `bash` and `/bin/bash`:
   - an orphan task named
   - all tasks citing ACs → no warning
   - an uncited AC named
   - a wordlist hit in an AC → warning
   - the same word inside a code fence or backticks → no warning
   - an empty plan section → no crash

   Every existing assertion still passes. Every committed plan in `.agents/plans/` is re-linted with main's lint and this branch's lint (temp copies, never a stash). The only differences may be the new advisory warnings, and no plan gains an **error**.
7. `/rad-review` changes in three places:
   - **Step 1b:** runs `node harness/cli.js digest "$FEATURE"` and includes its output. A non-zero exit is reported, and the review continues.
   - **Step 6 output:** gains a `### Digest` section before `### Scope`.
   - **Step 3 (plan fidelity):** gains two checklist items (**duplication** — near-duplicate or conflicting tasks or ACs; **terminology drift** — one concept named differently across sections), each severity-tagged and advisory.
8. `scripts/check-plan-convergence.sh <feature> [--base <ref>]` reports post-merge drift.
   - **Locating the delivery:** it finds the delivery commit with `git log --diff-filter=A` on the plan doc in `<base>` (default: the default branch).
   - **Path set:** it takes the plan's declared path set via `plan_scope_paths`.
   - **Report:** for each in-scope file changed after that commit, it lists `<file>: <sha7> <date> <author> <subject>`, or prints `converged — no in-scope file changed since delivery (<sha7>)`.
   - **Exit codes:**

     | Case | Exit |
     |---|---|
     | report (converged or drift) | 0 |
     | plan never delivered to `<base>` | 2, with a clear message |
     | missing or unreadable plan, or bad arguments | 2 |
     | git failure | 1, naming the command |

   Inputs are guarded (shell-safety lint), and variables go to git as arguments.
9. `scripts/test-check-plan-convergence.sh` passes under `bash` and `/bin/bash` in a hermetic fixture repo. It covers:
   - delivered with no later change → converged
   - one in-scope file changed after delivery → listed with its sha
   - an out-of-scope change → not listed
   - a plan never delivered → exit 2
   - a missing plan → exit 2
   - bad arguments → exit 2
10. The CI `deliver-integrity` job gains a final step, `if: always()` and not skipped, that runs `node harness/cli.js digest <feature> --branch origin/<head> --base <base>` and appends the output to `$GITHUB_STEP_SUMMARY`. It's a thin wrapper, and a digest failure prints a `::warning::` without failing the job.
11. The docs are updated:
    - `docs/rad-cli.md` gains a `### rad digest` subsection.
    - `docs/daily-workflow.md` covers the digest in the self-review and architect deliver-PR checklist sections, the new lint advisories, and `check-plan-convergence.sh`.
12. Every existing suite stays green: `npm test --prefix harness`, `node --test harness/evals/*.eval.js`, every shell test under both shells, `lint-shell-safety`, and `lint-invariants`.

## Agent Scope

An `Explore` agent (general, read-only) mapped:
- every digest signal, with its fold or script and its output format
- the `cli.js` subcommand and forecast-gatherer patterns
- the `rad-review.md` step layout
- the `lint-plan.sh` warning structure and its `test-lint-plan.sh` helpers
- the convergence git locator, verified on `main`
- the CI job lines and the doc sections

## Files in Scope

| File | Lines | Change |
|------|-------|--------|
| harness/findings.js | 80-110 | `findingsByFile` fold |
| harness/test/findings.test.js | 150-190 | Tests for AC#1 |
| harness/digest.js | 1-190 | New: `gatherDigestInputs`, `buildDigest`, `renderDigest` |
| harness/test/digest.test.js | 1-160 | New: AC#2-3 tests (ranking, rendering, unavailable inputs, fake `sh`) |
| harness/cli.js | 48-112 | `DIGEST_USAGE` + `SUBCOMMANDS` entry |
| harness/cli.js | 2094-2140 | New thin `digestCommand` |
| harness/test/cli.test.js | 1300-1350 | Tests for AC#4 |
| scripts/lint-plan.sh | 111-123 | Named orphan tasks + uncited ACs (replacing the count warning) |
| scripts/lint-plan.sh | 395-411 | Vague-adjective advisory (+ wordlist constant) |
| scripts/test-lint-plan.sh | 940-1000 | Tests for AC#6 |
| .claude/commands/team/rad-review.md | 30-45 | Step 1b: digest |
| .claude/commands/team/rad-review.md | 76-81 | Step 3: duplication and terminology-drift checklist |
| .claude/commands/team/rad-review.md | 177-190 | Step 6: `### Digest` section |
| scripts/check-plan-convergence.sh | 1-120 | New: AC#8 |
| scripts/test-check-plan-convergence.sh | 1-150 | New: AC#9 |
| .github/workflows/ci.yml | 165-185 | `deliver-integrity` digest summary step |
| docs/rad-cli.md | 116-150 | `### rad digest` |
| docs/daily-workflow.md | 142-148 | New lint advisories |
| docs/daily-workflow.md | 210-240 | Digest in self-review + architect checklist; convergence check |

## Program Design

### 1. Signatures

```js
// harness/findings.js
export function findingsByFile(records, paths) /* → { [path]: { total, high, medium, low, categories: string[] } } */

// harness/digest.js
export const DIGEST_RANK = Object.freeze(['scope', 'approval', 'high-risk', 'high-risk-waived',
  'self-protected', 'deficit', 'findings', 'run']);
export async function gatherDigestInputs({ repoRoot, sh, feature, branch, base }) /* → inputs; failures → { unavailable: reason } */
export function buildDigest(inputs) /* → { feature, items: [{ kind, path?, detail }], evidence: [{ check, ok, detail }], unavailable: [...] } */
export function renderDigest(digest) /* → markdown string */
```

### 2. Flow

```
rad digest <feature>  (cli.js, thin)
 └─ gatherDigestInputs ─┬─ sh: check-scope.sh <plan> <branch> <base>        → scope
                        ├─ sh: bash -c '. plan-paths.sh; plan_scope_paths'  → paths
                        ├─ sh: plan_high_risk_findings / plan_waivers        → high-risk (+ waivers)
                        ├─ state.history(feature)                            → approval, run evidence
                        ├─ .agents/findings.jsonl → findingsByFile(paths)    → findings
                        └─ plans + all histories → fileDeficitSignals → forecastForPaths(paths) → deficit
    → buildDigest → renderDigest → stdout
readers: /rad-review Step 1b · CI deliver-integrity summary step
```

### 3. File-tree diff

```
harness/digest.js, harness/test/digest.test.js                              A
scripts/check-plan-convergence.sh, scripts/test-check-plan-convergence.sh   A
harness/findings.js, harness/cli.js, scripts/lint-plan.sh (+ tests)        M
.claude/commands/team/rad-review.md, .github/workflows/ci.yml, docs/*.md  M
```

## Execution Notes

### Do Not Touch
- harness/gates.js, events.js (read its folds; don't change them), spine.js, stops.js, transitions.js
- scripts/check-scope.sh, scripts/lib/plan-paths.sh (call them; don't change them)
- The `deliver-integrity` job's detection step and `if:` (Batch C, #154, changes those)

### Key Files
- harness/cli.js — `forecastCommand` + gatherers (1967-2094), `stopStatusCommand` (1931-1964), `latestApprovedEvent` / `makeApprovalIntact` (832-860), `SUBCOMMANDS` (48-110)
- harness/events.js — the folds listed in Context; harness/findings.js; harness/plan-tasks.js; harness/plan-fingerprint.js
- scripts/lib/plan-paths.sh — `plan_scope_paths`, `plan_high_risk_findings`, `plan_waivers`, `path_is_self_protected`, `require_readable_plan`
- scripts/lint-plan.sh (111-123, 226-266, 395-411, 569-608); scripts/test-lint-plan.sh helpers (`write_plan` :61, `run_lint_in_repo` :253, `GREPO` :273)
- .claude/commands/team/rad-review.md (30-42, 76-91, 177-226)

### Reminders
- **Read-side only.** Nothing here writes events, touches the gate fold, or calls a host API. The digest *informs* Gate 2 and never gates it.
- **Recall over precision.** Rank everything and suppress nothing. An unavailable input is shown as unavailable.
- **Lint advisories stay warnings.** Re-lint every committed plan with main's lint vs the branch's lint (temp copies, never a stash). Success-line tests must run in the hermetic `GREPO` fixture.
- **Shell-safety lint** on every new script, and portability to bash 3.2 (`/bin/bash`) and BSD tools.
- **Coordinate with Batch C:** it edits the same `deliver-integrity` job. Rebase onto `main` before Wave 3 if Batch C has merged, and add the digest step without touching detection.
- **Long final checks** exceed the 2-minute foreground timeout. Run them with `run_in_background`.

## Wave Plan

### Wave 1 — parallel
Tasks in this wave can run in parallel (disjoint files).

#### Task 1.1: Digest module + findings fold
File: harness/findings.js:80-110, harness/test/findings.test.js:150-190, harness/digest.js:1-190, harness/test/digest.test.js:1-160
What: Implement AC#1-3. `gatherDigestInputs` reuses the forecast gatherers' approach, re-implementing their small pieces inside `digest.js` if they aren't exported from `cli.js`; it never imports `cli.js`, to avoid a cycle.
Tests (fake `sh`, temp dirs):
- rank order across all eight kinds
- a clean digest renders "nothing flagged"
- each unavailable input renders its reason
- waived hits show their justification
- the digest is deterministic for the same inputs
Validate: AC#1, AC#2, AC#3 — `npm test --prefix harness`.

#### Task 1.2: lint-plan consistency advisories
File: scripts/lint-plan.sh:111-123, 395-411, scripts/test-lint-plan.sh:940-1000
What: Implement AC#5 and the AC#6 tests. Then re-lint every committed plan with both lints and paste the diff summary in the commit body.
Validate: AC#5, AC#6 — `bash scripts/test-lint-plan.sh && /bin/bash scripts/test-lint-plan.sh` (ALL PASS); `scripts/lint-shell-safety.sh` shows no `✗`; the re-lint diff shows only new warnings.

#### Task 1.3: Post-merge convergence check
File: scripts/check-plan-convergence.sh:1-120, scripts/test-check-plan-convergence.sh:1-150
What: Implement AC#8 and AC#9, following the guardrail-script conventions (header, usage, exit-code block).
Validate: AC#8, AC#9 — both shells ALL PASS; `scripts/lint-shell-safety.sh` shows no `✗`; a real run `scripts/check-plan-convergence.sh insights-arc` exits 0 (paste its output).

### Wave 2 — parallel
Tasks in this wave can run in parallel. Both depend on Wave 1.

#### Task 2.1: rad digest command
File: harness/cli.js:48-112, 2094-2140, harness/test/cli.test.js:1300-1350
What: Implement AC#4: a thin `digestCommand` over `digest.js`.
Tests: usage errors → 2; an unreadable plan → 2; a malformed log → 1; a happy path with a fixture repo and an injected `sh` prints all sections.
Validate: AC#4 — `npm test --prefix harness`; a real run `node harness/cli.js digest invariant-registry-and-replay --branch main --base main` exits 0 (paste the first 20 lines).

#### Task 2.2: /rad-review wiring
File: .claude/commands/team/rad-review.md:30-45, 76-81, 177-190
What: Implement AC#7.
Validate: AC#7 — no testable surface (skill prose). `grep -n "harness/cli.js digest\|### Digest\|terminology drift\|duplication" .claude/commands/team/rad-review.md` shows all four.

### Wave 3 — sequential
CI and docs, after rebasing onto `main` if Batch C has merged.

#### Task 3.1: CI summary step + docs
File: .github/workflows/ci.yml:165-185, docs/rad-cli.md:116-150, docs/daily-workflow.md:142-148, 210-240
What: Implement AC#10 and AC#11.
Validate: AC#10, AC#11, AC#12:
- `ci.yml` parses with js-yaml
- the step has `if: always()` and writes to `$GITHUB_STEP_SUMMARY`
- every suite in AC#12 is green

## Tests to Write
- [ ] findingsByFile — harness/test/findings.test.js
- [ ] digest ranking, rendering, unavailable inputs — harness/test/digest.test.js
- [ ] rad digest command — harness/test/cli.test.js
- [ ] lint-plan consistency advisories — scripts/test-lint-plan.sh
- [ ] convergence check — scripts/test-check-plan-convergence.sh

## Non-Goals
- #52 interactive evaluation. It gets its own research-first plan.
- A PR comment or any host-API write. The digest renders to the terminal and to the CI job summary only.
- Making any new lint finding an error or an approval blocker.
- Configurable digest ranking. It's fixed in v1; a later change can make it configurable.
- Re-attesting a drifted plan, or gating on drift.

## Out-of-Scope Dependencies
None. All paths are architect-owned, and the author is the architect.

## Risks
- **Shared CI job with Batch C.** Both plans edit `deliver-integrity`: Batch C changes detection (#154), and this plan adds a final step. Wave 3 rebases first and touches only the new step.
- **New lint warnings on existing plans.** These are expected and advisory. The re-lint diff in Task 1.2 proves no plan gains an error. CI `plan-lint` is already `continue-on-error`.
- **Wordlist false positives.** Words like "simple" can be legitimate. The wordlist is short, whole-word, excludes code, and is advisory only.
- **Digest cost in CI.** It's read-only folds over local files plus two short scripts, so negligible.
- **Self-protected paths:** `harness/`, `scripts/`, `.claude/` and `.github/` trigger advisory lint warnings by design.

## Issue Gaps
- **ASSUMPTION — scope.** #52 is out, and #72 is in as a script (not a `/rad-insights` section). Architect decision, 2026-09-30.
- **ASSUMPTION — render surface.** One CLI with two readers (`/rad-review` header, CI job summary), and no PR comment. Architect decision, 2026-09-30.
- **ASSUMPTION — digest ranking.** The fixed order in AC#2 follows #59's suggested heuristic ("high-risk hit > scope drift > finding recurrence > retry count"), with scope violations and a broken approval placed above high-risk hits because they are outright gate failures.
- **ASSUMPTION — reverse coverage in lint, not the reviewer.** #70 asked for the deterministic passes to prefer the script. Orphan tasks, uncited ACs and the wordlist go to `lint-plan.sh`. Duplication and terminology drift stay LLM checklist items.
- **ASSUMPTION — the vague-adjective wordlist.** It starts with: scalable, intuitive, fast, robust, user-friendly, seamless, efficient, easy, flexible, performant, appropriate, properly, as needed, etc. It lives in a named constant so it can be tuned.
- **ASSUMPTION — convergence locator.** The first commit adding the plan doc to the default branch is the delivery. Features whose plans reached `main` before delivery (pre-Lane-B) are reported as "delivered at <sha>" with a note that the locator is heuristic for them.
