# Plan: rad-insights scripts-first, part E (4i post-merge rework and Gate-2 verification load)
Created: 2026-11-17
Author: architect
Status: complete
Completed-At: 2026-11-17T16:16:02.464Z
Approved-By: sean@torchcodelab.com
Approved-At: 2026-11-17T15:53:43.009Z
Recorded-By: sean@torchcodelab.com
Branch: rad/rad-insights-scripts-first-rework-load
Source-Author: none (no source issue)
Source-Comments: none

## Context
`.rad/skills/rad-insights/SKILL.md` (1128 lines on main after #326) has one inline `node --input-type=module` snippet left: Step 4i (lines 628-700), which reads the default branch's git history through `readDeliveryHistory` and folds it with `verificationLoad`, `reworkRate`, `trend` and `resolveWindowDays`. Parts A-D moved every other Step 4 snippet into a harness module with a byte-identical parity golden. 4i cannot use fixture state directories alone: it depends on a git repository and on `Date.now()`. This plan moves it into a module, with parity established differently: the golden is captured by running the OLD snippet inside a scripted throwaway git repo (fixed identity and commit dates) with a frozen clock, and the module is tested through an explicit `now`.

## Scope
| In scope | Out of scope |
|---|---|
| New `harness/insights-rework-load.js` with `buildReworkLoad`, `formatReworkLoad` and a runnable main | Changing `harness/delivery-history.js` or `harness/delivery-metrics.js` |
| Parity golden captured from the OLD snippet over a scripted temp repo, appended to `golden.txt` | Any other Step 4 section or the Step 5 template |
| Tests: golden parity via explicit `now`, edge cases, exit codes | Adding an env var or flag for the clock (the clock is a function argument only) |
| Replacing the 4i snippet with a run-and-read instruction; regenerating outputs | Changing the interpretation prose beyond the snippet swap |

## Acceptance Criteria
1. Step 4i becomes `harness/insights-rework-load.js`, exporting `buildReworkLoad({ stateDir, root, defaultBranch, env, now })` and `formatReworkLoad(result)`. It imports `readDeliveryHistory` from `harness/delivery-history.js`, the four folds from `harness/delivery-metrics.js`, and `listFeatures`/`readHistory`/`DEFAULT_STATE_DIR` from `harness/insights-state.js`. Result key order is `noMerges, windowDays, unresolved, load, rework, trends`; `trends` is `reworkRate, prSize, reviewLatency`.
2. Parity: for each scenario in a scripted temp repo (a populated history with deliver squash merges, an in-window rework commit, an unmerged feature with a `pr-opened` event, and an empty repo with no commits), `formatReworkLoad(buildReworkLoad({...}))` with a fixed `now` is byte-identical to golden captured from the old inline snippet run in that same repo with `Date.now()` frozen to the same value. The golden sections are headed `=== 4i:<scenario> ===`.
3. Tests cover the named edge cases: missing state dir (loads from git only, exit 0), empty `events.jsonl`, a missing field, zero counts (`rate` null for a merge with no product files, never NaN or 0), a non-array/non-object field, a valid-JSON null line (non-zero exit naming `file:line`), a malformed line (non-zero exit), `RAD_REWORK_WINDOW_DAYS` honored through `resolveWindowDays`, an unmerged feature row, and a missing `DEFAULT_BRANCH` (non-zero exit with a message naming it). The default-branch-not-found error from `readDeliveryHistory` exits non-zero with its message on stderr.
4. In `.rad/skills/rad-insights/SKILL.md` the 4i snippet is replaced by run-and-read instructions that keep the `DEFAULT_BRANCH=$(node harness/cli.js config get default_branch) || { ...; exit 1; }` guard line and run `DEFAULT_BRANCH="$DEFAULT_BRANCH" node harness/insights-rework-load.js`; the names `readDeliveryHistory`, `verificationLoad`, `reworkRate`, `trend`, `resolveWindowDays`, the non-zero-exit rule, the Reading-the-output bullets and the Step 5 template are unchanged; the source is 1105 lines or fewer (main is 1128; the expected saving is about 36).
5. `node harness/cli.js generate --check`, `npm test --prefix harness` and `scripts/verify-all.sh` pass, including the function-length lint (every function at most 40 lines).
6. Live parity: the new module and the old inline snippet (from the skill on main) produce byte-identical stdout over the real repository and real `.agents/state`, both run with `Date.now()` frozen to the same value through a `NODE_OPTIONS=--import` preload kept in the scratchpad (never committed); the result, including the output line count, is stated in the task summary.

## Agent Scope
No sub-agents. Research was inline and read-only: the skill source on main (Step 4i), `harness/delivery-history.js` (signature, `sh` injection, deliver-commit recognition), `harness/delivery-metrics.js` exports, `harness/test/delivery-history.test.js` helpers, and the part A-D module shape. Role: architect. No out-of-scope agent dependencies.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| harness/insights-rework-load.js | 1-90 | New: `buildReworkLoad`, `formatReworkLoad`, main |
| harness/test/insights-rework-load.test.js | 1-230 | New: scripted-repo parity + edge-case tests |
| harness/test/fixtures/insights-parity/golden.txt | 2109-2260 | Append `4i:` sections |
| .rad/skills/rad-insights/SKILL.md | 628-700 | Replace the 4i snippet |
| .agents/skills/rad-insights/SKILL.md | 628-700 | Regenerated copy (`rad generate`) |
| .claude/commands/shared/rad-insights.md | 628-700 | Regenerated copy (`rad generate`) |

## Program Design
```
buildReworkLoad({ stateDir, root, defaultBranch, env = process.env, now = Date.now() })
  -> { noMerges, windowDays, unresolved, load, rework, trends }
formatReworkLoad(result) -> JSON.stringify(result, null, 2)

main: DEFAULT_BRANCH required (exit non-zero, message names it) ->
      console.log(formatReworkLoad(buildReworkLoad({
        stateDir: RAD_STATE_DIR || DEFAULT_STATE_DIR, root: process.cwd(),
        defaultBranch: DEFAULT_BRANCH })))
build: readDeliveryHistory({ root, defaultBranch }) + per-feature readHistory ->
       verificationLoad / reworkRate({ windowDays, now }) / trend
```
Added files: the module and its test. Changed: `golden.txt` (append), the skill and its two generated copies. Deleted: none.

## Execution Notes

### Do Not Touch
- harness/delivery-history.js, harness/delivery-metrics.js — the reader and folds are the contract.
- harness/insights-state.js and the part A-D modules — merged, reused as-is.
- The Step 4h and 4j sections and the Step 5 template of the skill.

### Key Files
- harness/test/delivery-history.test.js — the temp-repo helpers (`git`, `write`, `commit`) to copy the style of.
- harness/delivery-history.js — how a deliver squash merge is recognised (`Deliver:` subject plus `deliver(<slug>)` or `Plan: .agents/plans/<slug>.md` in the body) and how `plan_scope_paths` supplies scoped files.
- harness/insights-cycle-time.js — the part D module shape.

### Reminders
- Deliver with `RAD_WAVE_TIMEOUT_SECONDS=1800 RAD_VERIFY_TIMEOUT_SECONDS=1800`; the default 600 s limit has bitten before.
- A failed deliver stop (`class=failed`) cannot be resumed: fix the plan or code, re-approve from the preserved worktree if the plan changed, remove the worktree, and re-run `rad deliver` without `--resume`.
- Capture the golden from the OLD snippet BEFORE editing the skill. The old snippet imports `./harness/...` and reads `process.cwd()`, so run it with the scripted temp repo as the working directory, after `ln -s <repo>/harness <temp repo>/harness` (the symlink is untracked, so `git log` ignores it). Freeze the clock with a scratchpad preload (`NODE_OPTIONS="--import <scratchpad>/freeze-now.mjs"` overriding `Date.now` from an env var). Neither the preload nor the symlink is committed; the test builds the same repo inline and never needs them.
- The scripted repo must be deterministic: set `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL`, `GIT_AUTHOR_DATE` and `GIT_COMMITTER_DATE` on every commit, and use the same builder function for the capture and for the test so the golden and the test see identical history. Dates are ISO strings in the past relative to the frozen `now`, with at least one rework commit inside the 14-day window and one merge younger than the window (`windowComplete: false`).
- The clock is a function argument. Do NOT add an environment variable or flag for it; production behavior stays `Date.now()` at call time in main.
- The old snippet loaded every state directory with a bare `JSON.parse`; `readHistory` fails closed on a valid-JSON non-object line (documented difference, only affects malformed logs). The old loop did not sort; `verificationLoad` sorts unmerged features, so order must not matter, and the live parity task confirms it.
- `DEFAULT_BRANCH` is resolved by the skill's shell line (it fails closed there). The module must also fail closed when it is unset or empty, with a message naming `DEFAULT_BRANCH`; this is a deliberate tightening of the old behavior, tested.
- Every file a task may create is declared above. Do not create fixture files; build the repo and edge cases inline in temp dirs. If a new file is truly needed, stop and report; do not widen scope silently.
- Skill line numbers shift after edits; re-read the Step 4i heading before the skill edit.
- Run `node harness/cli.js generate` after the skill edit.

## Wave Plan

### Wave 1 — sequential
Step 4i: post-merge rework and Gate-2 verification load.

#### Task 1.1: Capture the 4i golden and write the module
File: harness/insights-rework-load.js:1-90, harness/test/fixtures/insights-parity/golden.txt:2109-2260
What: Build the scripted temp repos (populated history, empty repo) with the deterministic builder, run the current Step 4i snippet in each under the frozen clock, and append the outputs as `4i:<scenario>` sections. Implement `buildReworkLoad`/`formatReworkLoad` and main per the Program Design, importing from `delivery-history.js`, `delivery-metrics.js` and `insights-state.js`.
Validate: AC#1 — exports and key order match; AC#2 — output equals the golden for each scenario; AC#5 — functions at or under 40 lines.

#### Task 1.2: Test the 4i module
File: harness/test/insights-rework-load.test.js:1-230
What: Build the same scripted repos inline and assert byte parity with each `4i:` golden section through `buildReworkLoad`/`formatReworkLoad` with the fixed `now`; add the named edge cases from AC#3 (spawn-based for the exit codes and stderr text, direct calls for the shaping), including the unmerged feature row, `RAD_REWORK_WINDOW_DAYS`, and the missing `DEFAULT_BRANCH`.
Validate: AC#2, AC#3.

#### Task 1.3: Replace the 4i snippet in the skill and regenerate
File: .rad/skills/rad-insights/SKILL.md:628-700
What: Replace the inline snippet with the run-and-read instruction from AC#4; keep the `git fetch`/fast-forward note, the prose, the fold names and the Reading-the-output bullets; run `node harness/cli.js generate`.
Validate: AC#4 — pinned names unchanged, the guard line is kept, the Step 5 template is byte-identical, the skill source is 1105 lines or fewer, `node --test harness/test/skill-bodies.test.js` passes.

### Wave 2 — sequential
Depends on: Wave 1 complete. Verification.

#### Task 2.1: Live parity check
File: harness/insights-rework-load.js:1-90
What: Read-only. Extract the old 4i snippet from the skill on `main` (`git show main:.rad/skills/rad-insights/SKILL.md`), run it and the new module over the real repository and real `.agents/state` with `Date.now()` frozen to the same value via the scratchpad preload, and diff stdout and exit status byte for byte. State the result (identical or differs, with the line count) in the task summary. Do not commit the preload or live logs.
Validate: AC#6 — the comparison is reported with its result.

#### Task 2.2: Full verification
File: .rad/skills/rad-insights/SKILL.md:628-700
What: Run `node harness/cli.js generate --check`, `npm test --prefix harness` and `scripts/verify-all.sh`; confirm the skill line count and that no `node --input-type=module` snippet remains in Step 4.
Validate: AC#4, AC#5.

Verify: exec bash scripts/verify-all.sh

## Tests to Write
- [ ] 4i scripted-repo parity, edge cases, unmerged feature, window env, missing `DEFAULT_BRANCH`, exit codes — harness/test/insights-rework-load.test.js

## Non-Goals
- Changing the reader or the folds, or adding a clock env var or flag.
- Any other Step 4 section, the Step 5 template, or shrinking the skill's interpretation prose.
- Fixing the pre-existing temp-dir-before-`withTmp` pattern in the older merged tests.

## Out-of-Scope Dependencies
None.

## Risks
- Determinism: the golden depends on a scripted git repo with fixed dates and identity; if the builder differs between capture and test, parity fails loudly rather than silently.
- The old snippet's cwd and relative imports force the symlink workaround for capture only; a mistake there would show up as an import error, not wrong output.
- Frozen-clock parity cannot prove real-time behavior; the unfrozen call in main is a single `Date.now()` and is covered by reading the code plus the live parity task.
- The skill is self-protected RAD machinery, so the deliver PR always needs architect review.
