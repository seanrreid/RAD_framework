# Plan: rad-insights scripts-first, part C (4f3 spend by model, 4f4 spend by provider)
Created: 2026-11-16
Author: architect
Status: complete
Completed-At: 2026-11-17T14:15:24.342Z
Approved-By: sean@torchcodelab.com
Approved-At: 2026-11-17T13:53:32.571Z
Recorded-By: sean@torchcodelab.com
Branch: rad/rad-insights-scripts-first-spend-folds
Source-Author: none (no source issue)
Source-Comments: none

## Context
`.rad/skills/rad-insights/SKILL.md` (1225 lines on main after #322) still carries the inline `node --input-type=module` snippets for Step 4f3 (spend by model, lines 469-543) and Step 4f4 (spend by provider, lines 544-595). Parts A (#319) and B (#322) moved 4b, 4d, 4f and 4f2 into harness modules with byte-identical parity goldens. This plan does the same for 4f3 and 4f4, reusing `readAllHistory` from `harness/insights-state.js` and importing `TIERING_MIN_FEATURES` from `harness/insights-wave-tiering.js` instead of redefining it. Steps 4h, 4i and 4j are plan D.

## Scope
| In scope | Out of scope |
|---|---|
| New `harness/insights-model-spend.js` (4f3) and `harness/insights-provider-spend.js` (4f4) with `build*`/`format*` exports and a runnable main | Steps 4h, 4i, 4j (plan D) |
| Parity goldens for both, captured from the OLD snippets, appended to `golden.txt` | Changing `modelTierSpend`, `modelTierAdvisories` or `providerSpend` in `harness/events.js` |
| Tests for both modules incl. named edge cases | Changing `insights-state.js` or `insights-wave-tiering.js` |
| Replacing the two skill snippets with run-and-read instructions; regenerating outputs | Changing the Step 5 template or any interpretation prose beyond the snippet swap |

## Acceptance Criteria
1. Step 4f3 becomes `harness/insights-model-spend.js`: its stdout is byte-identical to golden captured from the old inline snippet for the seven states enriched, legacy, mixed, provider, tiered, all (the five combined) and empty. It imports `TIERING_MIN_FEATURES` from `harness/insights-wave-tiering.js` (no second definition), reads logs through `readAllHistory`, imports `modelTierSpend`/`modelTierAdvisories` from `harness/events.js`, and exports `buildModelSpend` and `formatModelSpend`. Key order is `groups, features, advisories, minFeatures`; each group is `{...g, firstAttemptSuccessPct, retriedPct, meanTokens}` with `meanTokens` null when no wave reported usage.
2. Step 4f4 becomes `harness/insights-provider-spend.js`: stdout is byte-identical to golden captured from the old inline snippet for the same seven states. It reads logs through `readAllHistory`, imports `providerSpend` from `harness/events.js`, and exports `buildProviderSpend` and `formatProviderSpend`. Key order is `groups, features`; each group is `{...g, passPct}`.
3. Each new module has a test for each named edge case: missing state dir (exit 0, empty groups), empty `events.jsonl`, an event missing `data`/`feature`/`wave`, zero counts (percentages 0, never NaN), a non-array/non-object field, a valid-JSON null line (non-zero exit naming `file:line`), and a malformed line (non-zero exit). 4f3 additionally tests `meanTokens` null with no usage, the advisory floor at exactly `TIERING_MIN_FEATURES`, and `unrecorded`/`default` groups; 4f4 additionally tests the `unknown` group and an untagged attempt.
4. In `.rad/skills/rad-insights/SKILL.md` the 4f3 and 4f4 snippets are replaced by run-and-read instructions; the names `modelTierSpend`, `modelTierAdvisories`, `providerSpend`, `TIERING_MIN_FEATURES`, the Reading-the-output bullets and the Step 5 template are unchanged; the source is 1190 lines or fewer (main is 1225; the expected saving is about 50).
5. `node harness/cli.js generate --check`, `npm test --prefix harness` and `scripts/verify-all.sh` pass, including the function-length lint (every function at most 40 lines).
6. Live-log parity: each new module is compared byte for byte against the old inline snippet (taken from the skill on main) over the real `.agents/state`, and both results are stated in the task summary.

## Agent Scope
No sub-agents. Research was inline and read-only: the skill source on main (Steps 4f3 and 4f4), `harness/events.js` fold signatures, and the merged part B modules. Role: architect. No out-of-scope agent dependencies.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| harness/insights-model-spend.js | 1-70 | New: `buildModelSpend`, `formatModelSpend`, main |
| harness/test/insights-model-spend.test.js | 1-130 | New: parity + edge-case tests |
| harness/insights-provider-spend.js | 1-50 | New: `buildProviderSpend`, `formatProviderSpend`, main |
| harness/test/insights-provider-spend.test.js | 1-100 | New: parity + edge-case tests |
| harness/test/fixtures/insights-parity/golden.txt | 1536-1900 | Append `4f3:` and `4f4:` sections (about 180 lines each) |
| .rad/skills/rad-insights/SKILL.md | 469-543 | Replace the 4f3 snippet |
| .rad/skills/rad-insights/SKILL.md | 544-595 | Replace the 4f4 snippet |
| .agents/skills/rad-insights/SKILL.md | 469-595 | Regenerated copy (`rad generate`) |
| .claude/commands/shared/rad-insights.md | 469-595 | Regenerated copy (`rad generate`) |

## Program Design
```
buildModelSpend(stateDir)    -> { groups, features, advisories, minFeatures }
formatModelSpend(result)     -> JSON.stringify(result, null, 2)
buildProviderSpend(stateDir) -> { groups, features }
formatProviderSpend(result)  -> JSON.stringify(result, null, 2)

main: console.log(format*(build*(process.env.RAD_STATE_DIR || DEFAULT_STATE_DIR)))
build*: readAllHistory(stateDir) -> events.js fold -> add percentages / meanTokens
```
Added files: the two modules, their two tests. Changed: `golden.txt` (append), the skill and its two generated copies. Deleted: none.

## Execution Notes

### Do Not Touch
- harness/events.js — the folds are the contract; this plan only shapes their output.
- harness/insights-state.js, harness/insights-wave-tiering.js — merged, reused as-is.
- The Step 5 template and the 4h, 4i, 4j sections of the skill.

### Key Files
- harness/insights-wave-tiering.js — the part B module shape and the `TIERING_MIN_FEATURES` export.
- harness/insights-cache-hit.js and harness/test/insights-cache-hit.test.js — the module and test shape to follow.
- harness/insights-state.js — `readAllHistory`, `DEFAULT_STATE_DIR`.

### Reminders
- Deliver with `RAD_WAVE_TIMEOUT_SECONDS=1800 RAD_VERIFY_TIMEOUT_SECONDS=1800`; the default 600 s limit has bitten before.
- A failed deliver stop (`class=failed`) cannot be resumed: fix the plan or code, re-approve from the preserved worktree if the plan changed, remove the worktree, and re-run `rad deliver` without `--resume`.
- Capture each golden from the OLD snippet in the current SKILL.md BEFORE editing the skill: extract the bash fence under the step heading, run it from the repo root with `RAD_STATE_DIR` set to a temp dir holding the fixture, the five fixtures combined (`all`) and an empty dir (`empty`). Seven sections per step, headed `=== 4f3:<name> ===` / `=== 4f4:<name> ===`.
- Byte-identity traps: percentages use `Math.round`, never `toFixed`; keep object-literal key order exactly (`{...g, firstAttemptSuccessPct, retriedPct, meanTokens}` for 4f3, `{...g, passPct}` for 4f4); `meanTokens` is over known-usage waves only (`waves - unknownUsage`) and is `null`, not 0, when none; concatenate histories in sorted-feature order via `readAllHistory`.
- The old inline reader accepted non-object JSON lines; `readHistory` rejects them (fail closed). That is a deliberate, documented difference that only affects malformed logs, not any fixture.
- Importing `insights-wave-tiering.js` must not run its main; it is guarded by `invokedDirectly`, so a plain import is safe.
- Every file a task may create is declared above. Do not create fixture files; build edge cases inline in temp dirs. If a new file is truly needed, stop and report; do not widen scope silently.
- Skill line numbers shift as each step is converted; re-read the step headings before every skill edit.
- Run `node harness/cli.js generate` after every skill edit.

## Wave Plan

### Wave 1 — sequential
Step 4f3: spend by model.

#### Task 1.1: Capture the 4f3 golden and write the module
File: harness/insights-model-spend.js:1-70, harness/test/fixtures/insights-parity/golden.txt:1536-1720
What: Run the current Step 4f3 snippet against the seven states and append the outputs as `4f3:` sections. Implement `buildModelSpend`/`formatModelSpend` and main, importing `modelTierSpend`/`modelTierAdvisories` from `events.js`, `readAllHistory` from `insights-state.js` and `TIERING_MIN_FEATURES` from `insights-wave-tiering.js`.
Validate: AC#1 — output equals golden, the constant is imported not redefined, key order matches; AC#5 — functions at or under 40 lines.

#### Task 1.2: Test the 4f3 module
File: harness/test/insights-model-spend.test.js:1-130
What: Byte-parity test against each `4f3:` golden section, plus the named edge cases, `meanTokens` null when no wave reported usage, the advisory floor at exactly `TIERING_MIN_FEATURES` features, and `unrecorded`/`default` group handling, all built inline in temp dirs.
Validate: AC#1, AC#3.

#### Task 1.3: Replace the 4f3 snippet in the skill and regenerate
File: .rad/skills/rad-insights/SKILL.md:469-543
What: Replace the inline snippet with a run-and-read instruction naming `harness/insights-model-spend.js`; keep the prose, the names `modelTierSpend`, `modelTierAdvisories`, `TIERING_MIN_FEATURES`, and the Reading-the-output bullets; run `node harness/cli.js generate`.
Validate: AC#4 — pinned names unchanged, the Step 5 template is byte-identical, `node --test harness/test/skill-bodies.test.js` passes.

### Wave 2 — sequential
Depends on: Wave 1 complete. Step 4f4: spend by provider.

#### Task 2.1: Capture the 4f4 golden and write the module
File: harness/insights-provider-spend.js:1-50, harness/test/fixtures/insights-parity/golden.txt:1721-1900
What: Run the current Step 4f4 snippet (still in the skill; re-read its line numbers first) against the same seven states and append the outputs as `4f4:` sections. Implement `buildProviderSpend`/`formatProviderSpend` and main, importing `providerSpend` from `events.js` and `readAllHistory` from `insights-state.js`.
Validate: AC#2 — output equals golden and key order matches; AC#5 — functions at or under 40 lines.

#### Task 2.2: Test the 4f4 module
File: harness/test/insights-provider-spend.test.js:1-100
What: Byte-parity test against each `4f4:` golden section, plus the named edge cases, zero attempts (`passPct` 0, not NaN), the `unknown` group and an untagged attempt, all built inline in temp dirs.
Validate: AC#2, AC#3.

#### Task 2.3: Replace the 4f4 snippet in the skill and regenerate
File: .rad/skills/rad-insights/SKILL.md:500-560
What: Replace the inline snippet with a run-and-read instruction naming `harness/insights-provider-spend.js`; keep the prose, the name `providerSpend`, the non-zero-exit rule and the Reading-the-output bullets; run `node harness/cli.js generate`.
Validate: AC#4 — pinned names unchanged, the skill source is 1190 lines or fewer, the Step 5 template is byte-identical.

### Wave 3 — sequential
Depends on: Wave 2 complete. Verification.

#### Task 3.1: Live-log parity check
File: harness/insights-model-spend.js:1-70, harness/insights-provider-spend.js:1-50
What: Read-only. Extract the old 4f3 and 4f4 snippets from the skill on `main` (`git show main:.rad/skills/rad-insights/SKILL.md`), run them and the two new modules against the live `.agents/state/*/events.jsonl`, and diff stdout byte for byte. State each of the two results (identical or differs, with line counts) in the task summary. Do not commit live logs.
Validate: AC#6 — both comparisons are reported with their results.

#### Task 3.2: Full verification
File: .rad/skills/rad-insights/SKILL.md:469-595
What: Run `node harness/cli.js generate --check`, `npm test --prefix harness` and `scripts/verify-all.sh`; confirm the skill line count.
Validate: AC#4, AC#5.

Verify: exec bash scripts/verify-all.sh

## Tests to Write
- [ ] 4f3 byte-parity, edge cases, floor threshold, `meanTokens` null — harness/test/insights-model-spend.test.js
- [ ] 4f4 byte-parity, edge cases, `unknown` group — harness/test/insights-provider-spend.test.js

## Non-Goals
- Steps 4h, 4i (plan D) and Step 4j.
- Changing the fold functions in `harness/events.js` or the Step 5 template.
- Fixing the pre-existing temp-dir cleanup gap in `harness/test/insights-state.test.js`.

## Out-of-Scope Dependencies
None.

## Risks
- Byte-identity: key order, `Math.round`, and `meanTokens` null handling are the likely drift points; the goldens catch them.
- The skill is self-protected RAD machinery, so the deliver PR always needs architect review.
- The context budget lint warns (about 1100 declared lines, mostly goldens and generated copies); it is a warning, not an error, as in part B.
