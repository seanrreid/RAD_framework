# Plan: rad-insights scripts-first, last snippet (Step 3c reviewer calibration)
Created: 2026-11-17
Author: developer
Status: pending-review
Branch: rad/rad-insights-scripts-first-reviewer-calibration
Issue: 332
Source-Author: seanrreid (OWNER)
Source-Comments: 0 total, 0 non-collaborator

## Context
Step 3c of `.rad/skills/rad-insights/SKILL.md` (lines 172-215 on main, skill is 1056 lines) holds the last inline `node --input-type=module -e '...'` snippet. It reads only `.agents/findings.jsonl` (override `RAD_FINDINGS_FILE`), not the event logs, parses it line by line (a malformed line is reported on stderr as `skipping malformed JSON at <file>:<line>: <message>` and skipped), and prints `{ findingsLog: false }` when the file is absent, otherwise `{ findingsLog: true, ...reviewerCalibration(records) }` as 2-space JSON. The calibration math already lives in `harness/findings.js` (`reviewerCalibration`, tested in `findings.test.js`). Steps 4b-4j follow the module-plus-golden shape; this plan applies it to 3c. Because the only input is a findings file, the parity method is the simple fixture-golden one used for 4c-4f, not the scripted-repo method of 4i. A probe on main shows non-object JSON lines (`null`, `7`, `"x"`) do not throw: they are parsed, pushed and ignored by `reviewerCalibration`, so no behavior change is needed for them.

## Scope
| In scope | Out of scope |
|---|---|
| New `harness/insights-reviewer-calibration.js` (build/format/main) | Changing `reviewerCalibration` or the keyword classification in `harness/findings.js` |
| Findings-file parity golden captured from the old snippet | Sharing the findings-line reader with `harness/insights-human-corrections.js` (it keeps its own copy; see Risks) |
| Replace the Step 3c snippet with one command line and pin it in `skill-bodies.test.js` | Any other skill prose beyond Step 3c |

## Acceptance Criteria
1. `node harness/insights-reviewer-calibration.js` prints stdout byte-identical to the old Step 3c snippet for the scenarios: absent file, empty file, blank lines only, populated (verdict-labeled and keyword-fallback findings, one reviewer below `minLabeled` and one at it), cycle records only, non-object JSON lines, and a malformed line (stdout identical; stderr line identical in file, line number and message).
2. The module honors `RAD_FINDINGS_FILE` (default `.agents/findings.jsonl`) and exits 0 in every scenario above; it exports pure `buildReviewerCalibration` and `formatReviewerCalibration`.
3. A malformed line is skipped with the stderr message and never silently; a line that is blank after trim is ignored; edge cases named: missing file, empty file, missing field in a record, zero labeled findings, non-array-style input (non-object lines), malformed line.
4. The skill's Step 3c no longer contains `node --input-type=module`; it calls `node harness/insights-reviewer-calibration.js`, keeps the classification explanation, the "Reading the output" rules and the malformed-line surfacing rule, and `grep -c "node --input-type=module" .rad/skills/rad-insights/SKILL.md` is 0.
5. `.rad/skills/rad-insights/SKILL.md` is at most 1045 lines (measured on main: 1056; the snippet is 21 lines).
6. `harness/test/skill-bodies.test.js` pins the new command (13 commands) against the source and both generated copies, and still passes.
7. Live parity: the old snippet (extracted from main) and the module produce byte-identical stdout and stderr on the real `.agents/findings.jsonl`, recorded in the task summary.
8. `node harness/cli.js generate --check` and `bash scripts/verify-all.sh` pass.

## Agent Scope
Developer role, no architect-only agents. Research done directly (issue #332, Step 3c, `harness/findings.js` exports, the 4j reader for the stderr message, the probe of non-object lines).

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| harness/insights-reviewer-calibration.js | 1-60 | New: `buildReviewerCalibration`, `formatReviewerCalibration`, main |
| harness/test/insights-reviewer-calibration.test.js | 1-170 | New: golden parity + edge-case tests |
| harness/test/fixtures/insights-parity/golden.txt | 2231-2330 | Append `3c:` sections captured from the OLD snippet |
| .rad/skills/rad-insights/SKILL.md | 172-215 | Replace the Step 3c snippet with the module call |
| .agents/skills/rad-insights/SKILL.md | 1-1 | Regenerated copy (`rad generate`; whole file) |
| .claude/commands/shared/rad-insights.md | 1-1 | Regenerated copy (`rad generate`; whole file) |
| harness/test/skill-bodies.test.js | 185-200 | Pin the new command in `INSIGHTS_PINNED_COMMANDS` |
| harness/test/skill-bodies.test.js | 285-285 | Update the command-count assertion from 12 to 13 |

## Program Design
```
buildReviewerCalibration({ findingsFile, onSkip }) ->
  { findingsLog: false }                                  // file absent
  | { findingsLog: true, ...reviewerCalibration(records) } // records = parsed lines
formatReviewerCalibration(result) -> JSON.stringify(result, null, 2)

main: findingsFile = RAD_FINDINGS_FILE || DEFAULT_FINDINGS_FILE;
      onSkip logs `skipping malformed JSON at <file>:<line>: <message>` to stderr;
      console.log(formatReviewerCalibration(buildReviewerCalibration(...)))
```
Added files: the module and its test. Changed: `golden.txt` (append), the skill and its two generated copies, `skill-bodies.test.js`. Deleted: none.

## Execution Notes

### Do Not Touch
- harness/findings.js — the calibration contract; this plan only calls it.
- harness/insights-human-corrections.js and the other `insights-*` modules — merged.

### Key Files
- harness/findings.js — `reviewerCalibration`, `CALIBRATION_MIN_LABELED`.
- harness/insights-human-corrections.js — the existing findings-line reader and the exact stderr message wording.
- harness/test/insights-cycle-time.test.js — the module-test shape (`goldenSection`, `withTmp`, `run`) to follow.

### Reminders
- Deliver with `RAD_WAVE_TIMEOUT_SECONDS=1800 RAD_VERIFY_TIMEOUT_SECONDS=1800`.
- A failed deliver stop (`class=failed`) cannot be resumed: fix the plan, re-approve from the preserved worktree if the plan changed, remove the worktree, re-run `rad deliver` without `--resume`.
- Capture the golden from the OLD snippet BEFORE editing the skill: extract it from `git show main:.rad/skills/rad-insights/SKILL.md` into the scratchpad and run it with `RAD_FINDINGS_FILE` pointing at each scenario file, from the repo root (it imports `./harness/findings.js`). Record stdout in `golden.txt` as `=== 3c:<scenario> ===` sections; capture the malformed-line stderr separately and assert it in the test by file, line number and message. Run the old snippet and the module with the same Node version so the `JSON.parse` message matches.
- The test builds every scenario file inline in a temp dir from one builder function that the golden capture also uses; do not create fixture files. The golden path in the test is the temp file path, so stderr assertions must match the path the test passes, not a fixed string.
- Set sizes from measurement: the AC limit of 1045 comes from 1056 minus a 21-line snippet plus the command line and a shorter convention paragraph (about 1040). If the measured result is over 1045, report the number; do not trim other sections.
- Keep rule text in Step 3c that tells the reader what to render ("insufficient labels", never a 0) and the stderr surfacing rule; the pinned report string for the malformed-JSON rule in `skill-bodies.test.js` must keep passing unchanged.
- Function-length lint: max 40 lines per function. Every file a task may create is declared above; if a new file is truly needed, stop and report.

## Wave Plan

### Wave 1 — sequential
Tasks in this wave must run in sequence (golden first, before the skill changes).

#### Task 1.1: Capture the golden from the old snippet
File: harness/test/fixtures/insights-parity/golden.txt:2231-2330
What: Extract the Step 3c snippet from main, build the scenario findings files (absent, empty, blank lines only, populated with verdict-labeled plus keyword-fallback findings spanning two reviewers around `minLabeled`, cycle records only, non-object lines, one malformed line), run the snippet on each with `RAD_FINDINGS_FILE`, and append the stdout as `=== 3c:<scenario> ===` sections. Do not edit the skill in this task.
Validate: AC#1 — each section is non-empty JSON; the absent-file section is `{ "findingsLog": false }`.

#### Task 1.2: Write the module
File: harness/insights-reviewer-calibration.js:1-60
What: Implement `buildReviewerCalibration`, `formatReviewerCalibration` and an `invokedDirectly` main (`realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)`), importing `reviewerCalibration` from `./findings.js`. Missing file returns `{ findingsLog: false }`; every other line is parsed and a failing line is reported through `onSkip` (stderr in main) and skipped; blank lines are ignored.
Validate: AC#2, AC#3 — main prints the formatted JSON and exits 0 for the absent file.

### Wave 2 — sequential
Depends on: Wave 1 complete

#### Task 2.1: Write the module tests
File: harness/test/insights-reviewer-calibration.test.js:1-170
What: Parity tests per golden scenario (stdout compared to the golden section), the malformed-line stderr assertion, and named edge cases: missing file, empty file, a record missing `reviewer`/`category`/`issue`, zero labeled findings (rates `null`), non-object lines, and `formatReviewerCalibration` is 2-space JSON without a trailing newline.
Validate: AC#1, AC#3 — every scenario has a test that fails if the module output drifts from the golden.

#### Task 2.2: Replace the snippet in the skill
File: .rad/skills/rad-insights/SKILL.md:172-215
What: Replace the snippet with `node harness/insights-reviewer-calibration.js`, drop the restated convention text that the Step 4 preamble covers only where Step 3c does not depend on it (the section sits before Step 4, so keep one sentence on `RAD_FINDINGS_FILE` and read-only), and keep the classification explanation and "Reading the output" bullets unchanged.
Validate: AC#4, AC#5 — `grep -c "node --input-type=module"` is 0; `wc -l` at most 1045.

#### Task 2.3: Pin the new command
File: harness/test/skill-bodies.test.js:185-200, harness/test/skill-bodies.test.js:285-285
What: Add `'node harness/insights-reviewer-calibration.js'` to `INSIGHTS_PINNED_COMMANDS` and update the count assertion from 12 to 13.
Validate: AC#6 — the test passes against the source and both generated copies after regeneration.

### Wave 3 — sequential
Depends on: Wave 2 complete
Verify: exec bash scripts/verify-all.sh

#### Task 3.1: Regenerate and prove live parity
File: .agents/skills/rad-insights/SKILL.md:1-1, .claude/commands/shared/rad-insights.md:1-1
What: Run `node harness/cli.js generate` then `generate --check`. Run the old snippet (extracted from main) and the module on the real `.agents/findings.jsonl`, `cmp` stdout and stderr, and record `cmp` exit codes and `wc -l` of the skill in the task summary.
Validate: AC#7 — both `cmp` calls exit 0; AC#8 — `generate --check` passes and the Verify line passes.

## Tests to Write
- [ ] Golden parity per scenario (absent, empty, blank, populated, cycle-only, non-object, malformed stdout) — harness/test/insights-reviewer-calibration.test.js
- [ ] Malformed-line stderr names file, line number and message — harness/test/insights-reviewer-calibration.test.js
- [ ] Edge cases: missing field, zero labeled findings, 2-space format — harness/test/insights-reviewer-calibration.test.js
- [ ] New command pinned (13) — harness/test/skill-bodies.test.js

## Non-Goals
- Changing calibration math, the verdict classification, or `harness/findings.js`.
- Deduplicating the findings-line reader with `harness/insights-human-corrections.js` (tracked as a follow-up if wanted).
- Cutting any other skill content; this plan removes one snippet.

## Out-of-Scope Dependencies
None

## Risks
- The findings reader now exists twice (here and in `insights-human-corrections.js`); a later change to the stderr wording must touch both. Parity tests on each catch drift loudly.
- The JSON.parse error text is produced by Node; the golden stderr is checked by file, line and message, so a Node upgrade that rewords it would fail the test visibly.
- The skill is prose the model follows: the pinned malformed-JSON surfacing string guards the rule that matters, but a reworded explanation of the keyword fallback would not fail a test; review covers it.
