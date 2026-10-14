# Plan: configuration.md and rad-wave-contract.md Accuracy
Created: 2026-10-14
Author: architect
Status: pending-review
Branch: rad/config-and-wave-contract-accuracy
Tier: light
Source-Author: none (no source issue)
Source-Comments: none

## Context
Fourth plan from the 2026-10-14 docs audit: the two reference docs most often read when setting RAD up. An audit agent compared them with the code; I re-checked the environment-variable claims below by grepping the code, and several of the audit's "undocumented env vars" turned out to be internal constants, not knobs, so they are excluded.

**`docs/configuration.md`**
- Line 564: the self-protected pattern is shown without `^\.codex/` and `^\.agents/skills/`; `RAD_SELF_PROTECTED_PATTERN` in `scripts/lib/plan-paths.sh:106` includes both.
- Lines 365-366: the `check-verify.sh` env allow-list omits `USER`; `scripts/check-verify.sh:68` includes it (the doc's own agent allow-list at line 226 lists it).
- Lines 283-290: says a `RAD_TOKEN_BUDGET` that is "not a positive integer" gets the no-cap warning. `parseTokenBudget` (`harness/cli.js:331-334`) uses `Number.parseInt`, so `12abc` arms a budget of 12 and `1.5` arms 1 with no warning. Decision (2026-10-14): fix the wording, not the code.
- Line 125: the `rad config init` row omits `--agent`, `--agent-cmd` and `--agent-adapter` (`harness/cli.js:116`).
- Line 652: the `## Waivers` description covers only high-risk findings; `- test-removal:<path>: <reason>` waivers (`RAD_TEST_WAIVER_PREFIX`, `scripts/lib/plan-paths.sh:521`, consumed by `scripts/check-scope.sh`) are not mentioned.
- Line 512: `RAD_SYNC` is described as covering `rad approve/deliver`; the code also gates it at `harness/cli.js` lines 497, 2230 and 2721. The scope must be stated from the code.
- 14 bare `/rad-*` commands.
- The doc says it covers every `RAD_*` variable, but these real knobs are missing: `RAD_REVIEW_AGENT_CMD`, `RAD_REVIEW_TIMEOUT_SECONDS` (default 600), `RAD_EXERCISE_TIMEOUT_SECONDS`, `RAD_EXERCISE_BLOCKING`, `RAD_FINDINGS_THRESHOLD`, `RAD_FINDINGS_FILE`, `RAD_ARCHITECT_OVERRIDE`, `RAD_PLATFORM`, `RAD_INVARIANTS_ROOT`, and the `RAD_HOOK_*` family (already documented in `scripts/hooks/README.md`). Not knobs, so not to be documented: `RAD_CLI`, `RAD_PLAN_PATHS_ROOT` and `RAD_LABEL_SCRIPT` (internal variables or constants), `RAD_LIGHT_MAX_*` (readonly constants) and `RAD_VERIFY_ALL_CHECKS_FILE` (test-only hook).

**`docs/rad-wave-contract.md`**
- Line 10 calls `command` "(default, vendor-neutral)". There is no default adapter: with nothing configured, `rad deliver` exits 2 with `no agent configured` (`harness/agent-select.js`); `command` is assumed only when `RAD_AGENT_CMD` is set without `RAD_AGENT`.
- Lines 61 and 632-633 say the adapter is "selected by `RAD_AGENT`" and that selection is "purely environment-driven (no config-file loader)". `selectAgent` reads `agent.adapter` and `agent.command` from `.rad/config.yml` when the environment sets neither `RAD_AGENT` nor `RAD_AGENT_CMD`, and the environment wins entirely when either is set. The table row near line 630 and the `RAD_AGENT_CMD` mentions near lines 14 and 259 have the same gap.
- The run-level table (lines 353-359) has no row for the command adapter's output cap: output beyond `MAX_OUTPUT_BYTES` (10 MB, `harness/adapters/agent/command.js:49`) kills the process and ends the wave as `fail-protocol`.
- A timeout kills the agent's whole process group (`harness/adapters/agent/process-group.js`), not just the child; the acp section (~lines 219-220) says only "SIGTERM and SIGKILL". `docs/rad-cli.md` already describes the group kill.
- 3 bare `/rad-*` commands.

## Acceptance Criteria
1. **`configuration.md` corrections.** The pattern at line ~564 shows the `.codex/` and `.agents/skills/` alternations exactly as in `plan-paths.sh:106`; the `check-verify.sh` allow-list includes `USER`; the `RAD_TOKEN_BUDGET` text says a value that begins with a positive integer arms the budget (the rest is ignored), and that a value with no leading positive integer, `0` or empty leaves it unarmed with the start-up warning; the `rad config init` row lists the three agent flags; the `## Waivers` text mentions `test-removal:<path>` waivers as consumed by the test-integrity guard in `check-scope.sh`; the `RAD_SYNC` text names exactly the verbs the code gates, taken from `harness/cli.js` lines 497, 2230 and 2721.
2. **Other environment variables.** `configuration.md` gains an "Other environment variables" table (variable, default, effect, where read) for exactly these variables: `RAD_REVIEW_AGENT_CMD`, `RAD_REVIEW_TIMEOUT_SECONDS`, `RAD_EXERCISE_TIMEOUT_SECONDS`, `RAD_EXERCISE_BLOCKING`, `RAD_FINDINGS_THRESHOLD`, `RAD_FINDINGS_FILE`, `RAD_ARCHITECT_OVERRIDE`, `RAD_PLATFORM`, `RAD_INVARIANTS_ROOT`, plus one row pointing the `RAD_HOOK_*` family at `scripts/hooks/README.md`. Each row's default and effect is read from the code at the cited location, not copied from memory; a variable the executor cannot find in code is left out and named in the task note. None of the excluded names above is added.
3. **`rad-wave-contract.md` corrections.** Line 10 no longer says "default"; the three selection statements (lines ~61, ~630, ~632-633) say the adapter comes from `agent.adapter` in `.rad/config.yml`, or from `RAD_AGENT`/`RAD_AGENT_CMD` when either is set (the environment then decides everything), and link to `configuration.md#agent-adapter`; the run-level table has the output-cap row; the acp and command timeout text says the whole process group is signalled and points to `docs/rad-cli.md` for detail.
4. **Namespaced commands.** In both files no bare `/rad-<name>` remains unless part of a longer path or already namespaced, with the mapping from earlier plans (`plan`, `research`, `adopt`, `deliver`, `review` to `/team:rad-<name>`; `approve`, `design`, `epic-decompose` to `/architect:rad-<name>`; `status`, `insights` to `/shared:rad-<name>`). Check: `grep -nE '(^|[^:/A-Za-z0-9_.-])/rad-' docs/configuration.md docs/rad-wave-contract.md` prints nothing.
5. **Nothing else changes.** `git diff --stat` shows only the two docs plus this plan; relative links still resolve; no other wording is edited and no code, script or test is touched.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| docs/configuration.md | 120-130, 280-292, 360-368, 508-515, 560-568, 645-653 | Corrections of AC#1, bare-command sweep (14) |
| docs/configuration.md | 168-170 | Anchor for the new env-variable table (placed at the end of "Environment Variables and Rules") |
| docs/rad-wave-contract.md | 8-16, 58-64, 215-222, 255-262, 350-360, 626-634 | Corrections of AC#3, bare-command sweep (3) |

## Wave Plan

### Wave 1 — sequential
Tasks in this wave must run in sequence.
Verify: none (documentation only; Task 1.3 runs the grep, link and diff checks)

#### Task 1.1: configuration.md corrections
File: docs/configuration.md:120-130, docs/configuration.md:280-292, docs/configuration.md:360-368, docs/configuration.md:508-515, docs/configuration.md:560-568, docs/configuration.md:645-653
What: Apply AC#1 and the `configuration.md` half of AC#4. Read `scripts/lib/plan-paths.sh:106` and `harness/cli.js` (lines 116, 331-334, 497, 2230, 2721) before editing. Change nothing outside these areas.
Validate: AC#1, AC#4 — each corrected statement matches the cited code; the AC#4 grep is empty for this file.

#### Task 1.2: rad-wave-contract.md corrections
File: docs/rad-wave-contract.md:8-16, docs/rad-wave-contract.md:58-64, docs/rad-wave-contract.md:215-222, docs/rad-wave-contract.md:255-262, docs/rad-wave-contract.md:350-360, docs/rad-wave-contract.md:626-634
What: Apply AC#3 and the `rad-wave-contract.md` half of AC#4. Read `harness/agent-select.js`, `harness/adapters/agent/command.js` (lines ~48-50, ~399-403) and `harness/adapters/agent/process-group.js` first; confirm the output-cap outcome is `fail-protocol` before writing the row.
Validate: AC#3, AC#4 — statements match the code read; the AC#4 grep is empty for this file.

#### Task 1.3: Other environment variables table and checks
File: docs/configuration.md:168-170
What: Add the AC#2 table at the end of "Environment Variables and Rules", reading each variable's default and effect from the code locations in Context (`harness/cli.js` ~3591-3593 and ~3679, `harness/exercise.js` ~274-275, `scripts/draft-insights-plan.sh`, `scripts/check-approval-integrity.sh` ~219, `scripts/fetch-provenance.sh` ~36, `scripts/lint-invariants.sh`). Then run the AC#4 grep, check every relative markdown link in both files, and run `git diff --stat main...HEAD`.
Validate: AC#2, AC#4, AC#5 — the table has exactly the listed rows (minus any the executor could not find, named in the task note); the grep prints nothing; the diff stat lists only the two docs and this plan.

## Tests to Write
- None. Documentation only; each statement is checked against the code it cites, and the grep, link and diff checks in Task 1.3 are the verification.

## Non-Goals
- Changing `parseTokenBudget` or any other code (the wording is fixed instead, as decided)
- Documenting internal constants or test-only variables
- `rad-cli.md` and the `harness-*` docs (separate plans)
- Editing prose beyond the items listed in Context

## Risks
- Code line numbers cited here drift; the executor should locate each by symbol and treat the numbers as hints.
- A default read from code may differ from a value in the audit; the code wins and the task note records any difference.
