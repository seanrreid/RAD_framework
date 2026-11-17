# Plan: rad-insights skill trim (Plan F: shrink SKILL.md without changing report behavior)
Created: 2026-11-17
Author: developer
Status: approved
Approved-By: sean@torchcodelab.com
Approved-At: 2026-11-17T20:05:26.188Z
Recorded-By: sean@torchcodelab.com
Branch: rad/rad-insights-scripts-first-skill-trim
Source-Author: none (no source issue)
Source-Comments: none

## Context
Plans A-E (#316, #319, #322, #324, #326, #328) moved every Step 4 snippet into a harness module; `.rad/skills/rad-insights/SKILL.md` is now 1099 lines (generated copies: 1093 and 1092). The SkillEvaluator Tier 1 re-run passes all required checks but flags the size (limit 500 lines, ~14.7k est. tokens vs 5k). The bulk left is Step 4b-4j prose (12 "Reading the output:" field-doc blocks plus five repeats of "same invocation convention", twelve of `RAD_STATE_DIR`, eleven of "only reads") and the Step 5 report template (lines ~711-1045). The only guard on the skill body is `harness/test/skill-bodies.test.js`, which requires just two strings for `rad-insights` (`.agents/findings.jsonl`, `scripts/draft-insights-plan.sh`), so a trim could silently drop a degradation line (issue #313).

## Scope
| In scope | Out of scope |
|---|---|
| Pin load-bearing skill strings in `skill-bodies.test.js` first | Step 3c inline snippet (issue #332) |
| One shared Step 4 preamble replacing per-step boilerplate | Any harness module behavior or output |
| Dedupe each Step 4 "Reading the output" against the Step 5 template | Moving content to `references/` (generator disallows it) |
| Tighten Step 5 template comments without touching output text | Step 1-3d prose beyond what the pinned strings protect |

## Acceptance Criteria
1. `harness/test/skill-bodies.test.js` pins, for `rad-insights`, every Step 4 module invocation command (12) and every verbatim Step 5 string that is rendered to the reader (the degradation lines, the Code Legibility framing sentence, the deficit-proxy disclaimer, the Model Tiering spend note, the `no cache data reported` line), checked against the source and both generated copies; a non-vacuity test proves a body missing a pinned string fails.
2. After the trim every pinned string is still present byte-for-byte (the Wave 1 test passes unchanged).
3. Step 4 carries one shared preamble stating the invocation convention (run from repo root, read the JSON output, `RAD_STATE_DIR` is fixture-only, steps only read); the per-step repeats are removed.
4. Each Step 4b-4j "Reading the output" block states a field's meaning once; field meanings already stated in the Step 5 template are not repeated, and every instruction that changes what the report must say (for example "surface `skipping malformed JSON` stderr lines", "render insufficient labels, never a 0") is kept.
5. `.rad/skills/rad-insights/SKILL.md` is at most 1065 lines, measured with `wc -l`. This is a guard-the-skill change, not a shrink: a first delivery run measured 1060 lines (from 1099) after trimming every duplicate it could within scope, and stopped because the earlier 950 target was unreachable without cutting rendered Step 5 content or out-of-scope sections. Neither the 500-line target nor 950 is claimed.
6. `node harness/cli.js generate --check` passes and both generated copies match the source.
7. `bash scripts/verify-all.sh` passes.

## Agent Scope
Developer role, no architect-only agents. Research was done directly (the skill, the test, `wc -l` of the three copies, the repetition counts).

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| harness/test/skill-bodies.test.js | 36-110 | Add the pinned-strings table, its test and the non-vacuity test |
| .rad/skills/rad-insights/SKILL.md | 248-1045 | Shared Step 4 preamble, Step 4b-4j dedupe, Step 5 comment tightening |
| .agents/skills/rad-insights/SKILL.md | 1-1 | Regenerated copy (`rad generate`; whole file) |
| .claude/commands/shared/rad-insights.md | 1-1 | Regenerated copy (`rad generate`; whole file) |

## Program Design
```
const INSIGHTS_PINNED = [ ...12 module commands, ...Step 5 verbatim strings ]  // in skill-bodies.test.js
test: for source + .agents copy + .claude copy -> every INSIGHTS_PINNED string present
test: removing one pinned string from a fixture body makes the same check report it (non-vacuity)
```
Added files: none. Changed: the test, the skill source and its two generated copies. Deleted: none.

## Execution Notes

### Do Not Touch
- harness/*.js (modules, folds, `insights-state.js`) - behavior and output are the contract.
- Everything in the skill outside Steps 4b-5 except where Wave 2 text must reference the new preamble.
- The Step 3c inline snippet (issue #332).

### Key Files
- .rad/skills/rad-insights/SKILL.md - the only hand-edited skill file; `.agents/` and `.claude/` copies are generated.
- harness/test/skill-bodies.test.js - existing `REQUIRED_COMMANDS` and body-reading helpers (`readSource`, `codexBodyPath`, `claudeCommandPath`).

### Reminders
- Deliver with `RAD_WAVE_TIMEOUT_SECONDS=1800 RAD_VERIFY_TIMEOUT_SECONDS=1800`.
- A failed deliver stop (`class=failed`) cannot be resumed: fix, re-approve from the preserved worktree if the plan changed, remove the worktree, re-run `rad deliver` without `--resume`.
- Edit only `.rad/skills/rad-insights/SKILL.md`; never hand-edit the generated copies. Run `node harness/cli.js generate` after each skill wave so the copies and the pinned-string test agree.
- Pinned strings are copied from the skill on main BEFORE any trim, byte-for-byte (including backticks and bracket placeholders). Do not paraphrase them. If a pinned string must change, stop and report; do not edit the pin to match a trim.
- The sizing is advisory: after each trim wave record `wc -l` of the source in the task summary. If the measured result cannot reach AC#5 without removing a pinned string, stop and report rather than deleting template content.
- Trims remove duplication and boilerplate only. Do not reword instructions that tell the reader what to render, omit, or never do.
- Every file a task may create or change is declared above. Do not create fixtures. If a new file is truly needed, stop and report.
- Plan lint will warn on context budget (the skill range is ~800 lines); the copies are declared as 1-1 because they are regenerated whole.

## Wave Plan

### Wave 1 — sequential
Tasks in this wave must run in sequence (same file).

#### Task 1.1: Pin the Step 4 module invocations
File: harness/test/skill-bodies.test.js:36-80
What: Add `INSIGHTS_PINNED_COMMANDS`, the 12 `node harness/insights-*.js` invocations exactly as written in Steps 4b-4j (including the `DEFAULT_BRANCH="$DEFAULT_BRANCH"` and `SINCE=""` prefixed forms), and a test that checks each against the source and both generated copies.
Validate: AC#1 — test fails when any one command is removed from a fixture body (non-vacuity) and passes on main.

#### Task 1.2: Pin the Step 5 rendered strings and add non-vacuity
File: harness/test/skill-bodies.test.js:80-110
What: Add `INSIGHTS_PINNED_REPORT_STRINGS`: the verbatim degradation lines, the Code Legibility framing sentence, the deficit-proxy disclaimer, the Model Tiering spend note, the `no cache data reported` line and the `skipping malformed JSON` surfacing rule. Reuse the Task 1.1 checker; edge cases: a body missing one string, an empty body, and a body with the string only inside a different section's text (checker reports by string, not by section).
Validate: AC#1 — test names the missing string; AC#2 — passes on unmodified main.

### Wave 2 — sequential
Depends on: Wave 1 complete

#### Task 2.1: Add the shared Step 4 preamble and trim Steps 4b-4e
File: .rad/skills/rad-insights/SKILL.md:248-395
What: Add one preamble under Step 4 stating the convention (repo root, JSON output, `RAD_STATE_DIR` fixture-only, read-only). In Steps 4b-4e delete the per-step restatement and dedupe each "Reading the output" against the Step 5 section it feeds; keep invocation commands, degradation rules and "never X" instructions.
Validate: AC#3, AC#4 — `grep -c "RAD_STATE_DIR"` drops from 12 to at most 3; pinned-string test passes.

#### Task 2.2: Trim Steps 4f-4f4
File: .rad/skills/rad-insights/SKILL.md:395-541
What: Same treatment for 4f, 4f2, 4f3 and 4f4: remove restated convention text and field meanings already stated in the Model Tiering / Spend / Cache-Hit templates.
Validate: AC#4 — each remaining field is defined once; AC#2 — pinned strings intact.

### Wave 3 — sequential
Depends on: Wave 2 complete

#### Task 3.1: Trim Steps 4g-4j
File: .rad/skills/rad-insights/SKILL.md:542-710
What: Same treatment for 4g, 4h, 4i and 4j. Keep the `DEFAULT_BRANCH` and `SINCE` handling notes: they change how the command is run.
Validate: AC#4 — edge case: a field with a conditional rendering rule (null rate, empty list, unresolved items) keeps that rule.

#### Task 3.2: Tighten Step 5 template comments
File: .rad/skills/rad-insights/SKILL.md:711-1045
What: Shorten bracketed author instructions that repeat a degradation rule already stated in the same section or in Step 4; leave every line that is rendered to the reader exactly as it is.
Validate: AC#2 — pinned report strings intact; AC#5 — measure `wc -l`.

### Wave 4 — sequential
Depends on: Wave 3 complete
Verify: exec bash scripts/verify-all.sh

#### Task 4.1: Regenerate, measure and record
File: .agents/skills/rad-insights/SKILL.md:1-1, .claude/commands/shared/rad-insights.md:1-1
What: Run `node harness/cli.js generate`, then `generate --check`; record `wc -l` of the three files in the task summary and confirm the source is at most 1065 lines. If it is not, report the measured number and the blocker; do not delete pinned content.
Validate: AC#5 — source at most 1065; AC#6 — `generate --check` passes and the copies match; AC#7 — `bash scripts/verify-all.sh` passes (the wave's Verify line).

## Tests to Write
- [ ] Pinned module commands present in source and both generated copies, with non-vacuity — harness/test/skill-bodies.test.js
- [ ] Pinned Step 5 strings present, with missing-string, empty-body and wrong-section cases — harness/test/skill-bodies.test.js

## Non-Goals
- Reaching 500 lines, 950 lines or 5k tokens; those need rendered template content or the Rules and recurrence sections cut, a separate decision. Plan F is mainly the pinned-strings guard (#313).
- Changing any module, fold, or the rendered report wording.
- Moving the Step 3c snippet into a module (issue #332).

## Out-of-Scope Dependencies
None

## Risks
- The skill is prose the model follows: dropping a conditional rule changes the report without failing a unit test. The pinned strings cover the verbatim output; the Task 3.x edge-case checks and review cover conditional rules.
- The pin list is a judgment call; strings missed by Wave 1 are unprotected during the trim.
