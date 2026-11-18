# Plan: plan-authoring friction fixes (Plan H: #311 push wording, #312 generated copies, #314 fixture copies)
Created: 2026-11-18
Author: developer
Status: pending-review
Branch: rad/plan-authoring-lint-and-skill-guidance
Source-Author: none (no source issue)
Source-Comments: none

## Context
Three open issues cost earlier deliveries a `fail-scope`, a plan edit and a re-approval, or misled the planner. #312: `scripts/check-scope.sh` declares scope from Files in Scope only, so an undeclared generated copy of a `.rad/` source fails the wave, yet `scripts/lint-plan.sh` warns "Plan edits generated output directly" when the copies ARE declared (it fires for any `.claude/*` path) and says nothing when they are missing; the plan template's `### Do Not Touch` comment also invites excluding them. #314: `scripts/test-draft-insights-plan.sh`, `test-lint-plan-preflight.sh` and `test-lint-plan.sh` build temp repos by `cp`-ing `lint-plan.sh` (plus `lib/plan-paths.sh`, `check-sensitive-content.sh`, `get-default-branch.sh`) into them, so a plan that makes one of those scripts call a new script breaks the fixtures at `verify-all` and the fix lands out of scope. #311: the rad-plan description and opening paragraph never say `plan-open` pushes the work branch to origin; only Step 5 does. Measured today: `rad generate` maps a skill source to `.claude/commands/<path>.md` and `.agents/skills/<name>/SKILL.md` (rad-plan and rad-adopt have no `openai.yaml`), and `harness/generate.js` exports `readSources` and `renderOutputs`, whose outputs carry their `source`, so the lint can ask the generator instead of re-deriving the mapping.

## Scope
| In scope | Out of scope |
|---|---|
| `lint-plan.sh`: warn when a declared `.rad/` source's generated copies are not declared; stop the "edits generated output directly" warning for copies whose source is declared (#312) | A `--no-push` flag on `plan-open` (#311 only asks to state the push; a flag is a separate design) |
| `lint-plan.sh`: warn when a declared `scripts/` file is `cp`-ed by other tests' fixtures that are not declared (#314) | Backlog issues #244, #239, #231 |
| rad-plan and rad-adopt template guidance: Do Not Touch comment, Reminders fixture note, push wording; `docs/daily-workflow.md` push wording | `check-scope.sh` behavior (it stays strict; the lint guides authors) |
| A small harness module that lists the generated outputs of given sources, so the lint reuses the generator's mapping | Any change to `rad generate` output or `harness/generate.js` |

## Acceptance Criteria
1. `node harness/generated-outputs.js <source>...` prints one `<generated path><TAB><source>` line per generated output of each named `.rad/` source (for example `.rad/skills/rad-plan/SKILL.md` prints `.agents/skills/rad-plan/SKILL.md` and `.claude/commands/team/rad-plan.md`), prints nothing for a source that is not a generator input, and exits non-zero with the generator's reason on stderr when `.rad/` cannot be read.
2. `scripts/lint-plan.sh` warns, once per missing path, when a plan declares a `.rad/skills/**` or `.rad/agents*/**` source but not one of that source's generated outputs; a plan that declares the source and every output gets no such warning. The exit code is unchanged (advisory).
3. `scripts/lint-plan.sh` no longer emits "Plan edits generated output directly" for a generated path whose source is declared in the same plan; it still emits it, with unchanged text, for a `.claude/*` path whose source is not declared (the existing `t_generated_output_advisory` expectations still hold).
4. `scripts/lint-plan.sh` warns when a plan declares a `scripts/**/*.sh` file that other `scripts/test-*.sh` files `cp` into a fixture repo, naming each such test file that the plan does not also declare; a declared script no fixture copies, or a script whose copying tests are all declared, gets no such warning. The exit code is unchanged (advisory). The three fixtures in this repo keep passing with the new code in `lint-plan.sh`.
5. The `### Do Not Touch` comment in the plan templates of `.rad/skills/rad-plan/SKILL.md` and `.rad/skills/rad-adopt/SKILL.md` says generated copies of a declared source belong in Files in Scope, not in Do Not Touch, and the `### Reminders` comment tells authors that tests which `cp` a script into a temp repo must be declared when that script gains a dependency; `harness/test/skill-bodies.test.js` pins both for the source and both generated copies of each skill.
6. The rad-plan description and opening paragraph, the rad-adopt opening paragraph and `docs/daily-workflow.md` state that `plan-open` pushes the `rad/<feature>` branch to origin and that there is no local-only mode; the rad-plan and rad-adopt statements are pinned the same way as AC#5.
7. `node harness/cli.js generate --check` passes with the four regenerated skill copies matching their sources.
8. `bash scripts/verify-all.sh` passes, and running the new `lint-plan.sh` on this plan reports no "edits generated output directly" warning for the declared `.claude/commands/team/` copies.

## Agent Scope
Developer role, no architect-only agents. Research was done directly: the three issues (`gh issue view`), `scripts/lint-plan.sh`, `scripts/lib/plan-paths.sh`, the three `cp` fixtures, `harness/generate.js` exports, and the rad-plan and rad-adopt templates.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| harness/generated-outputs.js | 1-60 | New: list the generated outputs of named `.rad/` sources (pure `generatedOutputsFor` plus a main) |
| harness/test/generated-outputs.test.js | 1-90 | New: unit and CLI tests for the module |
| scripts/lint-plan.sh | 385-470 | Rework the generated-output advisory; add the missing-copy and fixture-copy advisories |
| scripts/test-lint-plan.sh | 1560-1640 | New `t_` cases for AC#2-AC#4 plus their calls before `ALL PASS` |
| .rad/skills/rad-plan/SKILL.md | 1-20 | Description and opening paragraph state the push |
| .rad/skills/rad-plan/SKILL.md | 273-290 | Do Not Touch and Reminders template comments |
| .rad/skills/rad-adopt/SKILL.md | 14-18 | Opening paragraph states the push |
| .rad/skills/rad-adopt/SKILL.md | 203-216 | Do Not Touch and Reminders template comments |
| docs/daily-workflow.md | 108-122 | State the push in the "Planning a feature" steps |
| harness/test/skill-bodies.test.js | 285-325 | Pin the new rad-plan and rad-adopt strings in source and both copies |
| .agents/skills/rad-plan/SKILL.md | 1-1 | Regenerated copy (`rad generate`; whole file) |
| .claude/commands/team/rad-plan.md | 1-1 | Regenerated copy (`rad generate`; whole file) |
| .agents/skills/rad-adopt/SKILL.md | 1-1 | Regenerated copy (`rad generate`; whole file) |
| .claude/commands/team/rad-adopt.md | 1-1 | Regenerated copy (`rad generate`; whole file) |

## Program Design
```
// harness/generated-outputs.js
export async function generatedOutputsFor(root, sources) -> { ok, lines: [{ path, source }] } | { ok:false, errors }
  readSources(root) -> renderOutputs(sources) -> keep outputs whose .source is in `sources`
main: node harness/generated-outputs.js <source>...   // stdout "path<TAB>source"; stderr + exit 1 on { ok:false }

// scripts/lint-plan.sh (inside the existing advisory section, reusing plan_scope_paths)
declared = plan_scope_paths(plan)
srcs     = declared matching .rad/skills/* | .rad/agents*/*
if srcs: expected = node harness/generated-outputs.js $srcs   // skipped with a stderr reason if it exits non-zero
  warn "declares <src> but not its generated copy <path>"   for each expected path not in declared
  generated-output warning: skip a .claude/* path when it is in expected
for each declared scripts/**/*.sh: awk-join scripts/test-*.sh `\` continuations, keep `cp` lines containing "$HERE/<rel>"
  warn "<script> is cp-ed into temp-repo fixtures by <tests not declared>"
```
Added files: `harness/generated-outputs.js`, `harness/test/generated-outputs.test.js`. Changed: lint, its test, two skills, one doc, one test, four generated copies. Deleted: none. No new `scripts/` file, so the fixtures need no new `cp` line: `harness/` is copied wholesale into each of them.

## Execution Notes

### Do Not Touch
- scripts/check-scope.sh, harness/generate.js, scripts/lib/plan-paths.sh - behavior is the contract; the lint only reads their output.
- Backlog issues #244, #239, #231.

### Key Files
- scripts/lint-plan.sh - the generated-output advisory at ~392-402 is the code to rework; `plan_scope_paths` is the declared-path source.
- scripts/test-lint-plan.sh - `t_generated_output_advisory` (~224) must keep passing; new cases follow its `write_plan` / `run_lint` helpers.
- scripts/test-draft-insights-plan.sh and scripts/test-lint-plan-preflight.sh - fixtures that `cp` `lint-plan.sh`; they must pass unchanged.
- harness/generate.js - `readSources`, `renderOutputs`, outputs carry `source`.

### Reminders
- Deliver with `RAD_WAVE_TIMEOUT_SECONDS=1800 RAD_VERIFY_TIMEOUT_SECONDS=1800`.
- A failed deliver stop (`class=failed`) cannot be resumed: fix, re-approve from the preserved worktree if the plan changed, remove the worktree, re-run `rad deliver` without `--resume`.
- Edit only `.rad/skills/*/SKILL.md`; never hand-edit the four generated copies. Run `node harness/cli.js generate` after the skill wave.
- The lint change must not call any new script: three fixtures `cp` `lint-plan.sh` into temp repos. The only new dependency is `harness/generated-outputs.js`, which those fixtures already get through their `harness/` copy. Run `bash scripts/test-draft-insights-plan.sh` and `bash scripts/test-lint-plan-preflight.sh` after the lint waves.
- The module is only invoked when the plan declares a `.rad/skills/` or `.rad/agents` source, so fixtures that declare none never run it.
- Plan lint will warn on self-protected paths; the generated copies are declared as 1-1 because they are regenerated whole.
- No numeric AC depends on an estimate: the checks are behavioral.

## Wave Plan

### Wave 1 — sequential
Tasks in this wave must run in sequence (the lint task uses the module).

#### Task 1.1: Add the generated-outputs module
File: harness/generated-outputs.js:1-60, harness/test/generated-outputs.test.js:1-90
What: Export `generatedOutputsFor(root, sources)` (reads sources with `readSources`, renders with `renderOutputs`, keeps outputs whose `source` is in the list) and a main that prints `path<TAB>source` lines, exiting 1 with the generator's errors on stderr when `{ ok: false }`. Edge cases, each a test: a source with no outputs (an unknown path), an empty source list, a source list containing a duplicate, a root with no `.rad/` (non-zero exit, reason on stderr), and a skill whose targets produce two outputs (rad-plan: both paths, sorted).
Validate: AC#1 - the module test passes; `node harness/generated-outputs.js .rad/skills/rad-plan/SKILL.md` prints the two real paths.

#### Task 1.2: Rework the generated-output advisory and add the missing-copy warning
File: scripts/lint-plan.sh:385-470, scripts/test-lint-plan.sh:1560-1640
What: When `plan_scope_paths` yields a `.rad/skills/**` or `.rad/agents*/**` source, run the module; warn once per expected output not declared ("declares <source> but not its generated copy <path>; rad generate rewrites it and check-scope fails the wave"); skip the "Plan edits generated output directly" warning for any path in the expected set; keep it unchanged otherwise. If the module exits non-zero, print its reason on stderr and skip both new behaviors (never silent, never an error). Edge cases, each a test: source declared with all copies (no warning), source with one copy missing (one warning naming it), `.claude/commands/x.md` with no source (original warning, `t_generated_output_advisory` unchanged), a source that is not a generator input, an agent source (`.rad/agents/*.md` -> both `.claude/agents` and `.codex/agents`), and a repo without `.rad/` skills (module never run).
Validate: AC#2, AC#3 - the new `t_` cases pass; `bash scripts/test-lint-plan.sh` prints ALL PASS.

### Wave 2 — sequential
Depends on: Wave 1 complete

#### Task 2.1: Warn on fixture-copied scripts
File: scripts/lint-plan.sh:385-470, scripts/test-lint-plan.sh:1560-1640
What: For each declared `scripts/**/*.sh` path, scan `scripts/test-*.sh` (relative to the script's own directory) with an awk that joins backslash-continued lines and keeps `cp` lines containing `$HERE/<path relative to scripts/>`; warn with the sorted names of such test files that are not declared in the plan ("<script> is cp-ed into temp-repo fixtures by <tests>; if it gains a dependency those fixtures need the new file too (#314)"). No `scripts/test-*.sh` present (fixture repos) means no warning. Edge cases, each a test: a script copied by two fixtures (names both), a declared script whose copying tests are also declared (no warning), a script copied by none, a multi-line `cp` with a trailing backslash, a path under `scripts/lib/`, and a test file that only invokes the script without `cp` (not matched).
Validate: AC#4 - the new cases pass; `bash scripts/test-draft-insights-plan.sh` and `bash scripts/test-lint-plan-preflight.sh` still pass.

### Wave 3 — sequential
Depends on: Wave 2 complete

#### Task 3.1: Skill and doc wording
File: .rad/skills/rad-plan/SKILL.md:1-20, .rad/skills/rad-plan/SKILL.md:273-290, .rad/skills/rad-adopt/SKILL.md:14-18, .rad/skills/rad-adopt/SKILL.md:203-216, docs/daily-workflow.md:108-122
What: In rad-plan state in the description and opening paragraph that `rad plan-open` pushes the `rad/<feature>` branch to origin and that there is no local-only mode; mirror the sentence in the rad-adopt opening and the `daily-workflow.md` "Planning a feature" steps. In both templates rewrite the `### Do Not Touch` comment to say generated copies of a declared `.rad/` source go in Files in Scope, not here, and add to the `### Reminders` comment that tests which `cp` a script into a temp repo must be declared when that script gains a dependency. Keep every existing instruction; only add or reword these comments. The description stays within the generator's accepted front matter keys.
Validate: AC#5, AC#6 - the strings are present in the source files (grep) and `node harness/cli.js generate --check` reports only the four expected copies as stale until Task 3.2.

#### Task 3.2: Regenerate and pin the new strings
File: harness/test/skill-bodies.test.js:285-325, .agents/skills/rad-plan/SKILL.md:1-1, .claude/commands/team/rad-plan.md:1-1, .agents/skills/rad-adopt/SKILL.md:1-1, .claude/commands/team/rad-adopt.md:1-1
What: Run `node harness/cli.js generate`. Add pinned strings (the push sentence, the Do Not Touch generated-copies sentence, the Reminders fixture sentence) for rad-plan and rad-adopt, checked against the source and both generated copies, reusing `missingPins`; add a non-vacuity case showing a body missing one pinned string fails. Edge case: a string present only in the source and not in a copy must fail.
Validate: AC#5, AC#6, AC#7 - `node --test harness/test/skill-bodies.test.js` passes and `node harness/cli.js generate --check` passes.

### Wave 4 — sequential
Depends on: Wave 3 complete
Verify: exec bash scripts/verify-all.sh

#### Task 4.1: Dogfood the lint and run the full verify
File: scripts/lint-plan.sh:385-470
What: Run `scripts/lint-plan.sh .agents/plans/plan-authoring-lint-and-skill-guidance.md` with the delivered lint and record the output: no "edits generated output directly" warning for the declared `.claude/commands/team/` copies and no missing-copy warning; one fixture-copy warning for `scripts/lint-plan.sh` naming only tests this plan does not declare is expected (`test-draft-insights-plan.sh`, `test-lint-plan-preflight.sh`). Fix the lint if the output differs; do not edit the plan or the generated copies.
Validate: AC#8 - recorded lint output matches the above; `bash scripts/verify-all.sh` passes (the wave's Verify line).

## Tests to Write
- [ ] Module outputs, unknown source, empty list, duplicates, unreadable `.rad/`, two-output skill - harness/test/generated-outputs.test.js
- [ ] Missing-copy warning, suppressed generated-output warning, unchanged original warning, agent source, no-skills repo - scripts/test-lint-plan.sh
- [ ] Fixture-copy warning: two copiers, declared copiers, no copiers, multi-line `cp`, `scripts/lib/` path, invoke-only test - scripts/test-lint-plan.sh
- [ ] New wording pinned in source and both copies of rad-plan and rad-adopt, with non-vacuity - harness/test/skill-bodies.test.js

## Non-Goals
- A `--no-push` or local-only mode for `plan-open` (#311's "consider" item): this plan documents the push; a flag is its own design.
- Making `scripts/check-scope.sh` auto-include generated copies of declared sources; it stays strict and the lint guides authors.
- Detecting fixture copies made by anything other than `cp` (`ln`, `install`, `rsync`); the advisory covers the pattern the three known fixtures use.
- Backlog issues #244, #239, #231.

## Out-of-Scope Dependencies
None

## Risks
- `lint-plan.sh` is copied into three fixtures; if it calls anything beyond `harness/` they break at `verify-all`. Mitigated by the Reminders note and by running the two other fixtures in Wave 2.
- The fixture-copy advisory is a text heuristic over `cp` lines; it can miss a differently written copy or flag a harmless one. It is advisory only and never changes the lint exit code.
- Running `node` from the lint adds a process start to plans that declare `.rad/` sources; plans without them are unaffected.
- Declaring `scripts/lint-plan.sh` makes this plan trigger its own fixture-copy warning; that is the expected dogfood result, not a defect.
