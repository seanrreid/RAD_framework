# Plan: Exercise the Artifact in /rad-review: Step 4c, Lint and Docs (#52 part 2)
Created: 2026-10-09
Author: architect
Status: in-progress
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-09T19:36:36.600Z
Recorded-By: sean@torchcodelab.com
Branch: rad/exercise-review-step
Issue: 52
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/52
Issue-Title: Interactive evaluation step in /rad-review (exercise the artifact)

## Context
Part 1 (PR #238) shipped `rad exercise <feature> [--check]`: it parses a plan's `## Exercise` block, runs the recipe through the configured agent in a throwaway worktree, and prints a `rad-findings` block (docs/rad-cli.md `### rad exercise`). Nothing calls it yet. This part wires it into `/rad-review` as Step 4c in both variants, surfaces `--check` warnings in `lint-plan.sh`, and documents the plan format and the review step.

Settled design (user, 2026-10-09), encoded below:
- Step 4c runs automatically when the plan has an `## Exercise` block; `--no-exercise` skips it.
- The step is fail-open: a failed run is recorded (`ran: false`), never "0 findings", and the review continues.
- Observe-only by default; `RAD_EXERCISE_BLOCKING` (`1`/`true`) makes behavioral HIGH findings self-review blockers only, never the approval gate.
- The Claude variant (hand-written) persists findings in Step 7; the Codex skill stays read-only and only reports.
- `lint-plan.sh` never nags about an absent block (revisit: #239); it only relays `--check` warnings for a present one.

## Scope
| In scope | Out of scope |
|---|---|
| `/rad-review` Step 4c, report section, Step 7 persistence and the cycle `exercise` field (Claude, hand-written) | Changing `rad exercise` itself (part 1, merged) |
| The Codex skill source: a read-only exercise step, regenerated outputs | Any change to the approval gate, events or `findings.jsonl` readers |
| `lint-plan.sh` relaying `rad exercise <feature> --check` warnings, with tests | An advisory for an absent block (#239) |
| rad-plan / rad-adopt template mention, regenerated outputs, doc updates | `/rad-insights` changes (it reads reviewers generically) |

## Acceptance Criteria
1. **Claude Step 4c.** `.claude/commands/team/rad-review.md` gains `### Step 4c: Exercise the artifact` between Step 4b and Step 5. It runs `node harness/cli.js exercise "$FEATURE"` unless `$ARGUMENTS` contains `--no-exercise` (that token is removed from the file list). It prints `Exercise: skipped (--no-exercise)` when skipped by flag, keeps the command's `Exercise: skipped (no recipe)` stdout when there is no block, and otherwise includes the command's stdout (its `rad-findings` block) and keeps the stderr summary line for Step 7. A non-zero exit records the exit code and stderr line, and the review continues.
2. **Claude report and blocking.** The Step 6 template gains `### Behavioral Exercise` (Recipe present/skipped, Mode, findings) after Guardrails. Mode is `blocking` only when `RAD_EXERCISE_BLOCKING` is `1` or `true`, else `observe-only`. In blocking mode, HIGH exercise findings count in `Blocking issues` and set `Status: NEEDS FIXES FIRST`; in observe-only mode they are listed as advisory and do not. The text states this is self-review only and never touches the approval gate.
3. **Claude persistence.** Step 7 persists exercise findings as `reviewer: "exercise"`, `category: "behavior"`, `wcag: null`, and the cycle record gains `"exercise":{"ran":<bool>,"mode":"observe-only|blocking"}`. `ran` is true only when the command exited 0 and did not skip; skipped (flag or no recipe) and failed runs record `ran: false`. A note explains that `ran: false` means "not exercised", not "nothing found".
4. **Codex step.** `.rad/skills/rad-review/SKILL.md` gains a read-only exercise step (after the reviewer sub-agents, before the combined summary) with the same skip, failure and blocking-mode rules, using `{{args}}` for `--no-exercise`. It reports the output as a "Behavioral Exercise" section and adds blocking-mode HIGH findings to the blocking list. It writes nothing; the Rules still say never to write `.agents/findings.jsonl`. `node harness/cli.js generate` regenerates `.agents/skills/rad-review/SKILL.md`, and `generate --check` exits 0.
5. **Lint relay.** `scripts/lint-plan.sh` runs `node harness/cli.js exercise <slug> --check` (slug from the `Branch:` header, cwd the repo root) and adds each stdout `warning: ...` line to `WARNINGS`. It adds nothing for a plan with no `## Exercise` section. It skips silently when `node` or `harness/cli.js` is missing or the check exits non-zero. Its exit code never changes because of this check.
6. **Templates.** `.rad/skills/rad-plan/SKILL.md` and `.rad/skills/rad-adopt/SKILL.md` mention the optional `## Exercise` block (keys, AC tie, "skipped when absent", pointer to docs/rad-cli.md) in the plan template; a light plan omits it. `node harness/cli.js generate` regenerates the Claude commands and `.agents/skills` outputs; `generate --check` exits 0.
7. **Docs.** docs/daily-workflow.md, docs/how-it-works.md, docs/rad-tool-portability.md and docs/rad-cli.md describe the `## Exercise` plan section, `/rad-review` Step 4c (including `--no-exercise`, `ran: false`, and the self-review-only blocking), and that the Codex skill reports without persisting.
8. **Tests.** A new `harness/test/rad-review-exercise.test.js` asserts that both review bodies call `harness/cli.js exercise` and mention `--no-exercise` and `RAD_EXERCISE_BLOCKING`; that the Claude body carries the cycle `exercise` field and the `reviewer: "exercise"` persistence while the Codex source does not instruct writing findings; and that neither adds a `rad gate`/approval call. `scripts/test-lint-plan.sh` covers AC#5. `harness/test/skill-bodies.test.js` asserts the two templates mention `## Exercise`.

## Agent Scope
Research came from a read-only sub-agent survey of both review variants, the registries and tests, `lint-plan.sh` and its test helpers, the plan templates, the docs and the findings readers. The key anchors were spot-checked against the checkout. There are no out-of-scope dependencies.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| scripts/lint-plan.sh | 370-392 | Exercise `--check` relay after the last-wave Verify advisory |
| scripts/test-lint-plan.sh | 1340-1425 | New `t_exercise_check_relay` and its registration |
| .claude/commands/team/rad-review.md | 14-24 | Input: `--no-exercise` |
| .claude/commands/team/rad-review.md | 160-166 | New Step 4c |
| .claude/commands/team/rad-review.md | 263-277 | Step 6 Behavioral Exercise section and blocking logic |
| .claude/commands/team/rad-review.md | 283-336 | Step 7 persistence, cycle field, Rules |
| .rad/skills/rad-review/SKILL.md | 18-85 | Input and the read-only exercise step, summary, Rules |
| .agents/skills/rad-review/SKILL.md | 1-1 | Regenerated |
| harness/test/rad-review-exercise.test.js | 1-1 | New |
| harness/test/skill-bodies.test.js | 30-60 | Template assertion |
| .rad/skills/rad-plan/SKILL.md | 273-289 | `## Exercise` template mention |
| .rad/skills/rad-adopt/SKILL.md | 201-217 | `## Exercise` template mention |
| .claude/commands/team/rad-plan.md | 1-1 | Regenerated |
| .claude/commands/team/rad-adopt.md | 1-1 | Regenerated |
| .agents/skills/rad-plan/SKILL.md | 1-1 | Regenerated |
| .agents/skills/rad-adopt/SKILL.md | 1-1 | Regenerated |
| docs/daily-workflow.md | 100-110 | Plan sections |
| docs/daily-workflow.md | 260-275 | Review step |
| docs/how-it-works.md | 84-90 | Plan structure |
| docs/how-it-works.md | 120-132 | Self-review bullets |
| docs/rad-tool-portability.md | 78-92 | The rad-review paragraph |
| docs/rad-cli.md | 668-745 | Cross-link from `### rad exercise` to Step 4c |

## Execution Notes

### Do Not Touch
- harness/exercise.js and `rad exercise` behavior (part 1)
- harness/gates.js, harness/events.js, harness/findings.js, harness/plan-fingerprint.js
- .rad/skills/rad-insights/SKILL.md (reviewer handling is generic)
- Other skills' sources (regenerate only; others must report unchanged)

### Key Files
- docs/rad-cli.md:668-745 — the `rad exercise` contract: stdout, the stderr summary line, exit codes, `--check`
- .claude/commands/team/rad-review.md — hand-written; Step 4 (125-148) is the review-lane model for Step 4c; Step 7 (283-324) is the persistence model
- .rad/skills/rad-review/SKILL.md — generated Codex source; `claude: none`, so only `.agents/skills/rad-review/SKILL.md` is generated
- scripts/lint-plan.sh:104-137 — the playbook node-call pattern (a model for calling the harness from lint)
- scripts/test-lint-plan.sh:1024 (`t_playbook_no_node`) — the model for the no-node test

### Reminders
- **Edit sources, then run `node harness/cli.js generate`.** Never hand-edit generated outputs; `generate --check` must exit 0.
- **The Claude variant is hand-written** (portability doc: it stays so by design); edit it directly.
- **The Codex skill is read-only.** Its Rules must still say never to write `.agents/findings.jsonl`; do not tell it to run `rad review`.
- **Fail-open everywhere:** a missing or failing exercise never stops the review or the lint.
- **Waves run under the 10-minute agent limit**; run delivery with `RAD_WAVE_TIMEOUT_SECONDS=1800 RAD_VERIFY_TIMEOUT_SECONDS=1800`.

## Program Design

Step 4c flow (both variants share it; only persistence differs):
```
FEATURE from the rad/ branch
  --no-exercise in args?  -> "Exercise: skipped (--no-exercise)"  (ran:false)
  node harness/cli.js exercise "$FEATURE"
    exit 0, stdout "Exercise: skipped (no recipe)" -> ran:false
    exit 0, rad-findings block                     -> ran:true, report findings
    exit != 0                                      -> record code + stderr, ran:false, continue
  RAD_EXERCISE_BLOCKING in (1,true) -> HIGH counts as blocking, else advisory
Claude only: Step 7 appends findings (reviewer "exercise") + cycle {"exercise":{ran,mode}}
```

Lint relay:
```
BRANCH header -> slug -> (cd repo root) node harness/cli.js exercise <slug> --check
  stdout "warning: X" -> WARNINGS+=("Exercise block: X")
  no node / no cli / exit != 0 / no section -> nothing
```

## Wave Plan

### Wave 1 — sequential

#### Task 1.1: The lint relay
File: scripts/lint-plan.sh:370-392, scripts/test-lint-plan.sh:1340-1425
What: Write AC#5 and its tests, following the playbook node-call pattern and `t_playbook_no_node`.
Validate: AC#5 — `bash scripts/test-lint-plan.sh` passes; `bash scripts/lint-shell-safety.sh` exits 0; edge cases covered: a present block with an unknown `AC#N` (warning relayed), a clean present block (no warning), no `## Exercise` section (no warning), no `node` on PATH (skipped silently), the check exiting non-zero (skipped silently), a `Branch:` header missing (skipped), and the lint exit code unchanged in every case

### Wave 2 — sequential

#### Task 2.1: The Claude review step
File: .claude/commands/team/rad-review.md:14-24, 160-166, 263-277, 283-336
What: Write AC#1, AC#2 and AC#3 in the hand-written command.
Validate: AC#1, AC#2, AC#3 — `grep -c 'harness/cli.js exercise' .claude/commands/team/rad-review.md` is non-zero; `grep -c -- '--no-exercise' .claude/commands/team/rad-review.md` is non-zero; `grep -n '"exercise":{"ran"' .claude/commands/team/rad-review.md` matches; `bash scripts/lint-claude-md.sh` passes; edge cases covered in the text: flag skip, no recipe, non-zero exit, blocking vs observe-only, `ran: false` meaning

### Wave 3 — sequential

#### Task 3.1: The Codex step and the review tests
File: .rad/skills/rad-review/SKILL.md:18-85, .agents/skills/rad-review/SKILL.md:1-1, harness/test/rad-review-exercise.test.js:1-1
What: Write AC#4 and the review-body tests of AC#8. Edit the source only, then run `node harness/cli.js generate`.
Validate: AC#4, AC#8 — `node harness/cli.js generate --check` exits 0; `node --test harness/test/rad-review-exercise.test.js harness/test/skill-bodies.test.js` passes; `grep -c '\$ARGUMENTS' .agents/skills/rad-review/SKILL.md` prints 0; edge cases covered: the Codex body never instructs writing findings, neither body references an approval call, the Claude body has the cycle field and the Codex source does not

### Wave 4 — sequential

#### Task 4.1: Templates and docs
File: .rad/skills/rad-plan/SKILL.md:273-289, .rad/skills/rad-adopt/SKILL.md:201-217, .claude/commands/team/rad-plan.md:1-1, .claude/commands/team/rad-adopt.md:1-1, .agents/skills/rad-plan/SKILL.md:1-1, .agents/skills/rad-adopt/SKILL.md:1-1, harness/test/skill-bodies.test.js:30-60
What: Write AC#6 and the template assertion of AC#8. Edit the two sources, run `node harness/cli.js generate`.
Validate: AC#6, AC#8 — `node harness/cli.js generate --check` exits 0; `node --test harness/test/skill-bodies.test.js` passes; `grep -c '## Exercise' .agents/skills/rad-plan/SKILL.md .agents/skills/rad-adopt/SKILL.md` is non-zero for each; `grep -c 'git add\|git commit\|git push' .agents/skills/rad-plan/SKILL.md .agents/skills/rad-adopt/SKILL.md` prints 0 for each

#### Task 4.2: Docs
File: docs/daily-workflow.md:100-110, 260-275, docs/how-it-works.md:84-90, 120-132, docs/rad-tool-portability.md:78-92, docs/rad-cli.md:668-745
What: Write AC#7.
Validate: AC#7 — `grep -n 'Step 4c' docs/daily-workflow.md docs/how-it-works.md docs/rad-tool-portability.md` matches in each; `grep -n -- '--no-exercise' docs/rad-cli.md` matches; `bash scripts/lint-claude-md.sh` passes; docs only

### Wave 5 — sequential
Final verification, run by the harness: the full set of CI-equivalent checks.

Verify: exec bash scripts/verify-all.sh

#### Task 5.1: Full verification
File: .claude/commands/team/rad-review.md:160-166
What: The harness runs the `Verify:` command above after this task returns, so make no edits unless the harness feeds back a failure that traces to this plan's changes, and such a fix stays within the scope above. Report any other failure as `blocked_intent`.
Validate: AC#1 — the harness's Verify gate passes (`verify-all: ... 0 failed`)

## Tests to Write
- [ ] Lint relay: present block with a bad AC, clean block, no section, no node, failing check, missing Branch — scripts/test-lint-plan.sh
- [ ] Both review bodies call `harness/cli.js exercise`, name `--no-exercise` and `RAD_EXERCISE_BLOCKING`; Claude-only cycle field and persistence; Codex never writes findings; no approval call — harness/test/rad-review-exercise.test.js
- [ ] rad-plan / rad-adopt templates mention `## Exercise` — harness/test/skill-bodies.test.js

## Non-Goals
- An advisory for an absent `## Exercise` block (revisit: #239).
- Persisting exercise findings from the Codex skill, or making `--no-exercise` a config setting.
- Any change to `rad exercise` (part 1), `/rad-insights`, or how the approval gate works.
- Making `RAD_EXERCISE_BLOCKING` affect anything but the self-review summary.

## Out-of-Scope Dependencies
None

## Risks
- **Hand-written Claude review file is long.** Mitigation: all edits are anchored insertions at known step boundaries; the tests assert required markers, not structure.
- **Cycle totals now include exercise findings.** In observe-only mode a HIGH exercise finding raises `high` without changing `outcome`; documented under AC#3.
- **Lint relay depends on the plan path.** `rad exercise --check` reads `.agents/plans/<slug>.md`; a plan linted from elsewhere is skipped silently by design.
- **Self-protected paths** (`.rad/`, `scripts/`, `harness/`, `.claude/`): this plan needs architect review by design.

## Issue Gaps
- **Assumption — `high`/`medium`/`low` cycle totals include exercise findings,** while `outcome` follows the blocking mode. Insights can tell the difference from the `exercise` field.
- **Assumption — `ran` is true only for a clean, non-skipped exit 0;** a flag skip, no recipe, or a failed run all record `ran: false`.
- **Assumption — the lint relay skips silently on any failure of the check,** because it is advisory and `rad exercise --check` already reports an unreadable plan on its own.
- **Assumption — `--no-exercise` is parsed from the same args as the file list,** removed before the files are used.
- **Assumption — `rad-review` is not added to `TOOL_NEUTRAL_SKILLS`,** since its Claude variant stays hand-written by design; the new test file covers its markers instead.
