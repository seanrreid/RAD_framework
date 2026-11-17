# Plan: rad-insights scripts-first, part D (4h cycle metrics, 4j human corrections)
Created: 2026-11-17
Author: architect
Status: in-progress
Approved-By: sean@torchcodelab.com
Approved-At: 2026-11-17T14:51:19.225Z
Recorded-By: sean@torchcodelab.com
Branch: rad/rad-insights-scripts-first-cycle-corrections
Source-Author: none (no source issue)
Source-Comments: none

## Context
`.rad/skills/rad-insights/SKILL.md` (1171 lines on main after #324) still carries inline `node --input-type=module` snippets for Step 4h (cycle time, human touches, tokens per delivered feature; lines 591-647), Step 4i (lines 648-720) and Step 4j (human corrections; lines 721-782). Parts A-C (#319, #322, #324) moved 4b, 4d, 4f, 4f2, 4f3 and 4f4 into harness modules with byte-identical parity goldens. This plan does the same for 4h and 4j, which read only the per-feature event logs (and, for 4j, the findings file and `git log`). Step 4i is plan E: it reads real git history and `Date.now()`, so it cannot use fixture goldens and needs its own parity method.

## Scope
| In scope | Out of scope |
|---|---|
| New `harness/insights-cycle-time.js` (4h) and `harness/insights-human-corrections.js` (4j) with `build*`/`format*` exports and a runnable main | Step 4i (plan E) |
| Parity goldens for both, captured from the OLD snippets, appended to `golden.txt` | Changing `harness/cycle-metrics.js` or `harness/human-corrections.js` |
| Tests for both modules incl. named edge cases | Changing `harness/insights-state.js` |
| Replacing the two skill snippets with run-and-read instructions; regenerating outputs | Changing the Step 5 template or interpretation prose beyond the snippet swap |

## Acceptance Criteria
1. Step 4h becomes `harness/insights-cycle-time.js`: its stdout is byte-identical to golden captured from the old inline snippet for the seven states enriched, legacy, mixed, provider, tiered, all (the five combined) and empty. It imports `stageDurations`, `humanTouches` and `tokensPerDeliveredFeature` from `harness/cycle-metrics.js`, reads logs through `listFeatures`/`readHistory` from `harness/insights-state.js`, and exports `buildCycleTime` and `formatCycleTime`. Key order is `noEventLogs, perFeature, tokens`; each feature is `{durations, touches}`.
2. Step 4j becomes `harness/insights-human-corrections.js`: stdout is byte-identical to golden captured from the old inline snippet for the same seven states, run with `RAD_FINDINGS_FILE` pointing at a nonexistent temp path and `SINCE` empty. It imports `parseEventLog`, `postDeliverFixRows`, `buildCorrections` and `formatCorrections` from `harness/human-corrections.js`, and exports `buildHumanCorrections` and `formatHumanCorrections`. It keeps `SINCE`, `RAD_STATE_DIR` and `RAD_FINDINGS_FILE` handling, `--since` applied by the fold, and the old behavior of skipping a malformed findings line with a `skipping malformed JSON at <file>:<line>` message on stderr.
3. Each new module has a test for each named edge case: missing state dir, empty `events.jsonl`, a missing field, zero counts, a non-array/non-object field, a valid-JSON null line (non-zero exit naming `file:line`) and a malformed line (non-zero exit). 4h additionally tests an unfinished feature (null durations, never 0) and a delivered feature with no usage (null, excluded from the mean). 4j additionally tests a findings file with a malformed line (skipped, stderr names `file:line`, exit 0), `SINCE` boundary inclusion (a row exactly on the boundary is kept) and a bad `SINCE` (non-zero exit).
4. In `.rad/skills/rad-insights/SKILL.md` the 4h and 4j snippets are replaced by run-and-read instructions (4j keeps the `SINCE=...` invocation); the names `stageDurations`, `humanTouches`, `tokensPerDeliveredFeature`, `parseEventLog`, `postDeliverFixRows`, `buildCorrections`, `formatCorrections`, the Reading-the-output bullets and the Step 5 template are unchanged; the source is 1135 lines or fewer (main is 1171; the expected saving is about 50).
5. `node harness/cli.js generate --check`, `npm test --prefix harness` and `scripts/verify-all.sh` pass, including the function-length lint (every function at most 40 lines).
6. Live-log parity: each new module is compared byte for byte against the old inline snippet (taken from the skill on main) over the real `.agents/state`, with the real findings file for 4j, and both results are stated in the task summary.

## Agent Scope
No sub-agents. Research was inline and read-only: the skill source on main (Steps 4h-4j), `harness/insights-state.js`, and the merged part A-C module shape. Role: architect. No out-of-scope agent dependencies.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| harness/insights-cycle-time.js | 1-60 | New: `buildCycleTime`, `formatCycleTime`, main |
| harness/test/insights-cycle-time.test.js | 1-140 | New: parity + edge-case tests |
| harness/insights-human-corrections.js | 1-80 | New: `buildHumanCorrections`, `formatHumanCorrections`, main |
| harness/test/insights-human-corrections.test.js | 1-160 | New: parity + edge-case tests |
| harness/test/fixtures/insights-parity/golden.txt | 1872-2200 | Append `4h:` and `4j:` sections |
| .rad/skills/rad-insights/SKILL.md | 591-647 | Replace the 4h snippet |
| .rad/skills/rad-insights/SKILL.md | 721-782 | Replace the 4j snippet |
| .agents/skills/rad-insights/SKILL.md | 591-782 | Regenerated copy (`rad generate`) |
| .claude/commands/shared/rad-insights.md | 591-782 | Regenerated copy (`rad generate`) |

## Program Design
```
buildCycleTime(stateDir)  -> { noEventLogs, perFeature, tokens }
formatCycleTime(result)   -> JSON.stringify(result, null, 2)
buildHumanCorrections({ stateDir, findingsFile, since, root }) -> text
formatHumanCorrections(x) -> formatCorrections(x)  // text, printed as-is

4h main: console.log(formatCycleTime(buildCycleTime(RAD_STATE_DIR || DEFAULT_STATE_DIR)))
4j main: console.log(buildHumanCorrections({ stateDir, findingsFile: RAD_FINDINGS_FILE || ".agents/findings.jsonl", since: SINCE || undefined, root: process.cwd() }))
```
Added files: the two modules, their two tests. Changed: `golden.txt` (append), the skill and its two generated copies. Deleted: none.

## Execution Notes

### Do Not Touch
- harness/cycle-metrics.js, harness/human-corrections.js, harness/delivery-*.js — the folds are the contract.
- harness/insights-state.js and the part A-C modules — merged, reused as-is.
- The Step 4i section and the Step 5 template of the skill.

### Key Files
- harness/insights-cache-hit.js and harness/test/insights-cache-hit.test.js — the module and test shape to follow.
- harness/insights-state.js — `listFeatures`, `readHistory`, `DEFAULT_STATE_DIR`, `EVENT_LOG`.
- harness/human-corrections.js — `parseEventLog` error format (`<log>: line N: ...`).

### Reminders
- Deliver with `RAD_WAVE_TIMEOUT_SECONDS=1800 RAD_VERIFY_TIMEOUT_SECONDS=1800`; the default 600 s limit has bitten before.
- A failed deliver stop (`class=failed`) cannot be resumed: fix the plan or code, re-approve from the preserved worktree if the plan changed, remove the worktree, and re-run `rad deliver` without `--resume`.
- Capture each golden from the OLD snippet in the current SKILL.md BEFORE editing the skill: extract the bash fence under the step heading, run it from the repo root with `RAD_STATE_DIR` set to a temp dir holding the fixture, the five fixtures combined (`all`) and an empty dir (`empty`). Seven sections per step, headed `=== 4h:<name> ===` / `=== 4j:<name> ===`. For 4j also set `RAD_FINDINGS_FILE` to a nonexistent path inside the temp dir so the real findings file never leaks into the golden, and leave `SINCE` empty.
- 4j's `postDeliverFixRows` runs `git log` in the repo root. Fixture feature names have no `rad/<name>` branch, so those rows render as `Unavailable:` lines; that is deterministic and is what the golden records. The 4j tests must run with the repo root as the working directory.
- 4h and 4j read logs differently: 4h uses `readHistory` (fail-closed on a non-object line, a documented difference from the old bare `JSON.parse`); 4j keeps `parseEventLog` (already fail-closed, error text `<log>: line N: ...`). Do not swap them.
- The old snippets did not sort features; `listFeatures` does. If the live parity check shows an ordering difference, stop and report it rather than editing the golden.
- Byte-identity traps: key order (`noEventLogs, perFeature, tokens`; `{durations, touches}`); 4j prints the formatted text as-is, not JSON; `null` durations stay null.
- Every file a task may create is declared above. Do not create fixture files; build edge cases inline in temp dirs. If a new file is truly needed, stop and report; do not widen scope silently.
- Skill line numbers shift as each step is converted; re-read the step headings before every skill edit.
- Run `node harness/cli.js generate` after every skill edit.

## Wave Plan

### Wave 1 — sequential
Step 4h: cycle time, human touches, tokens per delivered feature.

#### Task 1.1: Capture the 4h golden and write the module
File: harness/insights-cycle-time.js:1-60, harness/test/fixtures/insights-parity/golden.txt:1872-2030
What: Run the current Step 4h snippet against the seven states and append the outputs as `4h:` sections. Implement `buildCycleTime`/`formatCycleTime` and main, importing the three folds from `cycle-metrics.js` and `listFeatures`/`readHistory`/`DEFAULT_STATE_DIR` from `insights-state.js`.
Validate: AC#1 — output equals golden and key order matches; AC#5 — functions at or under 40 lines.

#### Task 1.2: Test the 4h module
File: harness/test/insights-cycle-time.test.js:1-140
What: Byte-parity test against each `4h:` golden section, plus the named edge cases, an unfinished feature (null durations, never 0) and a delivered feature with no usage (null, excluded from the mean), all built inline in temp dirs.
Validate: AC#1, AC#3.

#### Task 1.3: Replace the 4h snippet in the skill and regenerate
File: .rad/skills/rad-insights/SKILL.md:591-647
What: Replace the inline snippet with a run-and-read instruction naming `harness/insights-cycle-time.js`; keep the prose, the fold names, the Reading-the-output bullets and the reporting-only note; run `node harness/cli.js generate`.
Validate: AC#4 — pinned names unchanged, the Step 5 template is byte-identical, `node --test harness/test/skill-bodies.test.js` passes.

### Wave 2 — sequential
Depends on: Wave 1 complete. Step 4j: human corrections.

#### Task 2.1: Capture the 4j golden and write the module
File: harness/insights-human-corrections.js:1-80, harness/test/fixtures/insights-parity/golden.txt:2031-2200
What: Run the current Step 4j snippet (still in the skill; re-read its line numbers first) against the same seven states with `RAD_FINDINGS_FILE` pointing at a nonexistent temp path and `SINCE` empty; append the outputs as `4j:` sections. Implement `buildHumanCorrections`/`formatHumanCorrections` and main with the env handling and malformed-findings-line skip described in AC#2.
Validate: AC#2 — output equals golden, env handling and the stderr message are preserved; AC#5 — functions at or under 40 lines.

#### Task 2.2: Test the 4j module
File: harness/test/insights-human-corrections.test.js:1-160
What: Byte-parity test against each `4j:` golden section, plus the named edge cases, a findings file with a malformed line, a confirmed review finding row, the `SINCE` boundary-inclusive case and a bad `SINCE`, all built inline in temp dirs, run with the repo root as the working directory.
Validate: AC#2, AC#3.

#### Task 2.3: Replace the 4j snippet in the skill and regenerate
File: .rad/skills/rad-insights/SKILL.md:690-750
What: Replace the inline snippet with a run-and-read instruction that keeps the `SINCE="..." node harness/insights-human-corrections.js` form; keep the prose, the fold names, the non-zero-exit rule and the Reading-the-output bullets; run `node harness/cli.js generate`.
Validate: AC#4 — pinned names unchanged, the skill source is 1135 lines or fewer, the Step 5 template is byte-identical.

### Wave 3 — sequential
Depends on: Wave 2 complete. Verification.

#### Task 3.1: Live-log parity check
File: harness/insights-cycle-time.js:1-60, harness/insights-human-corrections.js:1-80
What: Read-only. Extract the old 4h and 4j snippets from the skill on `main` (`git show main:.rad/skills/rad-insights/SKILL.md`), run them and the two new modules against the live `.agents/state/*/events.jsonl` (and the real `.agents/findings.jsonl` for 4j), and diff stdout and exit status byte for byte. State each of the two results (identical or differs, with line counts) in the task summary. Do not commit live logs.
Validate: AC#6 — both comparisons are reported with their results.

#### Task 3.2: Full verification
File: .rad/skills/rad-insights/SKILL.md:591-782
What: Run `node harness/cli.js generate --check`, `npm test --prefix harness` and `scripts/verify-all.sh`; confirm the skill line count.
Validate: AC#4, AC#5.

Verify: exec bash scripts/verify-all.sh

## Tests to Write
- [ ] 4h byte-parity, edge cases, null durations, no-usage delivered feature — harness/test/insights-cycle-time.test.js
- [ ] 4j byte-parity, edge cases, malformed findings line, `SINCE` boundary and bad `SINCE` — harness/test/insights-human-corrections.test.js

## Non-Goals
- Step 4i (plan E).
- Changing the fold functions in `harness/cycle-metrics.js` or `harness/human-corrections.js`, or the Step 5 template.
- Fixing the pre-existing unguarded `goldenSection` helper in the older merged tests.

## Out-of-Scope Dependencies
None.

## Risks
- Byte-identity: key order, null handling and the 4j text format are the likely drift points; the goldens catch them.
- Feature ordering: the old 4h/4j snippets did not sort, `listFeatures` does; the live parity task surfaces any difference.
- 4j shells out to `git log`; tests and goldens assume the repo root as cwd and no `rad/<fixture>` branches.
- The skill is self-protected RAD machinery, so the deliver PR always needs architect review.
- The context budget lint warns (declared goldens and generated copies); it is a warning, not an error, as in parts B and C.
