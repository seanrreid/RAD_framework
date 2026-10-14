# Plan: rad-cli.md Corrections and the RAD_SYNC Paragraph
Created: 2026-10-14
Author: architect
Status: complete
Completed-At: 2026-10-14T19:21:49.457Z
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-14T19:19:40.585Z
Recorded-By: sean@torchcodelab.com
Branch: rad/rad-cli-doc-corrections
Tier: light
Source-Author: none (no source issue)
Source-Comments: none

## Context
Fifth plan from the 2026-10-14 docs audit. `docs/rad-cli.md` (1,717 lines) is the main CLI reference. An audit agent compared it with `harness/cli.js` and its modules; I re-checked the items below against the code. This plan fixes what is wrong in existing text; documenting the eight CLI commands that have no section yet is a separate follow-up plan. It also repairs the `RAD_SYNC` paragraph in `docs/configuration.md` that the previous plan narrowed too far (#282).

**Wrong in `docs/rad-cli.md`**
- Lines 8-12: "never opens a PR" and "pushes a branch only in `approve`, `plan-open` and `plan-status`". `rad deliver` opens the deliver PR (it runs `scripts/open-pr.sh` after the scope check, `harness/cli.js` ~372 and ~1907) and pushes the branch; `rad wrap` pushes too (the doc says so at ~291). The same paragraph names only "a spawned CLI agent or the Claude Agent SDK", omitting the `acp` adapter.
- Line 962: `RAD_AGENT` is shown with default `command`. There is no default adapter: with neither `agent:` nor the environment set, deliver exits 2 (`no agent configured`, as the doc itself says at ~954); `command` is assumed only when `RAD_AGENT_CMD` is set without `RAD_AGENT`.
- Lines 958-968: the table has no `RAD_MAX_FAILED_ATTEMPTS` row, though line 1094 mentions it and `harness/cli.js` (`MAX_FAILED_ATTEMPTS_ENV`, ~1566) and `harness/stops.js` (`failed-attempt-cap`) implement it. Unset or empty means the cap is off.
- Line 1198: a `token-budget` stop "exits 1". It is a needs-decision stop (`harness/stops.js`, class `NEEDS_DECISION`) that exits **3**, as the doc's own exit-code table near line 1114 says.
- Lines 1194-1203: only the start-up "no token cap" warning is described. A second warning exists: when a budget is armed and a wave reports no usage, `warnOnUnmeteredBudget` (`harness/usage-watch.js`) says the budget cannot trip for that wave. Line 1203 ("waves whose adapter emits no usage contribute 0, so the breaker never trips spuriously") hides that.
- Lines 944-966 and 1029-1031: usage is described only for the SDK path, and the command path is shown as `RAD_AGENT_CMD="claude -p"`. The command adapter reads usage only from a `RAD_USAGE {json}` line on stdout; `scripts/claude-usage.mjs` is the supported way to get that from `claude -p`; plain `claude -p` reports none, so a token budget cannot trip. This is documented in `docs/rad-wave-contract.md` and `docs/configuration.md` but not here.
- Line 1562 says "`runwave.js` uses `query`"; `harness/runwave.js` does not exist (the SDK adapter is `harness/adapters/agent/sdk.js`). Line 1572 lists a fixed `allowedTools` set; the set is now built per wave in `sdk.js` (default tools unless the wave's capabilities narrow them).
- Line 1524: "Three cases" in `harness/test/deliver.test.js`; the count has drifted.
- Lines 1581-1706 (CI checks): `function-length-lint` and several other CI jobs (`harness-tests`, `script-tests`, `bash32-parse`, `claude-md-budget`, `shell-safety-lint`, `invariant-lint`, `generated-drift`, `evals-scripted`, `deliver-integrity`, `plan-lint`, `matrix-replay`) are not covered or indexed.
- Line 916 (finish phase) and ~502/570: `check-scope.sh` is described without its test-weakening guard (`scripts/lib/test-integrity.sh`, `test-removal:<path>` waivers).
- Line 1715: lists `rad status` as a "follow-up increment"; `rad status` exists.
- 17 bare `/rad-*` commands.

**Wrong in `docs/configuration.md` (from #282):** the `RAD_SYNC` paragraph (~lines 514-520) now says the sync push happens in two places in `harness/cli.js`. `RAD_SYNC` is also read in `scripts/check-plan-approved.sh` (fetches the branch tip before the gate reads the event log, lines ~83-90), `harness/plan-open.js` and `harness/deliver-finish.js`, and the earlier text about the fetch-before-gate-read and the divergence tripwire was true.

## Acceptance Criteria
1. **Intro is true.** Lines 8-12 say the CLI never calls a model itself, that `rad deliver` delegates model calls to the configured adapter (`command`, `acp` or `sdk`) and opens the single deliver PR through `scripts/open-pr.sh`, and name every verb that pushes (from the code: at least `approve`, `plan-open`, `plan-status`, `wrap` and `deliver`; the executor confirms the list by grepping for pushes in `harness/`).
2. **Adapter and env table.** The `RAD_AGENT` row no longer shows a default of `command` and says the adapter comes from `agent.adapter` or, when the environment is set, from `RAD_AGENT` (assumed `command` only if `RAD_AGENT_CMD` is set alone). A `RAD_MAX_FAILED_ATTEMPTS` row is added (positive integer, unset means off, stop reason `failed-attempt-cap`, exit 3 as a needs-decision stop). The `RAD_TOKEN_BUDGET` row cross-references the budget bullet.
3. **Budget text is right.** The `token-budget` stop is described as exit 3 (needs-decision, resumable with `--resume --context`); both warnings are described (start-up "no cap" and the per-wave "no usage reported, budget cannot trip"); the sentence about waves with no usage says they add nothing and therefore cannot trip the budget.
4. **Usage reporting.** One short subsection or paragraph near the adapter table says the command adapter reads usage only from a `RAD_USAGE {json}` first-match line, that `node scripts/claude-usage.mjs` produces it from `claude -p`, that plain `claude -p` reports no usage, and links to `rad-wave-contract.md` for the line format. The `RAD_AGENT_CMD="claude -p"` example is kept and annotated.
5. **SDK notes.** The "`runwave.js`" reference points at `harness/adapters/agent/sdk.js`; the `allowedTools` row says the set is per wave (default tools, narrowed by a wave's capabilities) instead of a fixed list; the "Three cases" count is removed.
6. **CI and guards.** The CI section gains a short index table of the 15 jobs in `.github/workflows/ci.yml` (job name, what it runs, in one line each, read from the workflow and `scripts/verify-all.sh --list`), including `function-length-lint` with a pointer to the ~40-line rule in `AGENTS.md`; the finish-phase text mentions the test-weakening guard and `test-removal:<path>` waivers with a link to `configuration.md`; "Known follow-ups" no longer lists `rad status`.
7. **RAD_SYNC paragraph.** In `docs/configuration.md` the `RAD_SYNC` paragraph again states, from the code, every place the variable is read (`harness/cli.js`, `harness/plan-open.js`, `harness/deliver-finish.js`, `scripts/check-plan-approved.sh`), including the fetch before the gate read and the divergence tripwire, and nothing the code does not do.
8. **Namespaced commands.** `docs/rad-cli.md` has no bare `/rad-<name>` unless part of a longer path or already namespaced (mapping as in earlier plans). Check: `grep -nE '(^|[^:/A-Za-z0-9_.-])/rad-' docs/rad-cli.md` prints nothing.
9. **Nothing else changes.** `git diff --stat` shows only `docs/rad-cli.md`, `docs/configuration.md` and this plan; relative links still resolve; no code or script is touched; the eight undocumented commands are NOT added here.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| docs/rad-cli.md | 8-12 | Intro (AC#1) |
| docs/rad-cli.md | 940-970 | Adapter and env table, `RAD_MAX_FAILED_ATTEMPTS` row (AC#2) |
| docs/rad-cli.md | 1025-1035 | Command-path example, usage paragraph (AC#4) |
| docs/rad-cli.md | 1090-1096 | Exit-code table cross-check (AC#3) |
| docs/rad-cli.md | 1190-1210 | Budget text (AC#3) |
| docs/rad-cli.md | 1518-1526 | Test count (AC#5) |
| docs/rad-cli.md | 1555-1575 | SDK notes (AC#5) |
| docs/rad-cli.md | 910-920 | Finish phase, test-weakening guard (AC#6) |
| docs/rad-cli.md | 1581-1594 | CI job index (AC#6) |
| docs/rad-cli.md | 1708-1717 | Known follow-ups (AC#6) |
| docs/configuration.md | 508-525 | `RAD_SYNC` paragraph (AC#7) |

## Wave Plan

### Wave 1 — sequential
Tasks in this wave must run in sequence.
Verify: none (documentation only; Task 1.3 runs the grep, link and diff checks)

#### Task 1.1: Intro, adapter table and usage reporting
File: docs/rad-cli.md:8-12, docs/rad-cli.md:940-970, docs/rad-cli.md:1025-1035
What: Apply AC#1, AC#2 and AC#4. Read `harness/cli.js` (the verbs that push; `MAX_FAILED_ATTEMPTS_ENV` and its parser), `harness/agent-select.js`, `harness/stops.js` and `docs/rad-wave-contract.md` (the `RAD_USAGE` section) before editing.
Validate: AC#1, AC#2, AC#4 — each statement matches the cited code; the push list comes from a grep, not memory.

#### Task 1.2: Budget, SDK notes, test count and exit codes
File: docs/rad-cli.md:1090-1096, docs/rad-cli.md:1190-1210, docs/rad-cli.md:1518-1526, docs/rad-cli.md:1555-1575
What: Apply AC#3 and AC#5. Read `harness/stops.js`, `harness/usage-watch.js` and `harness/adapters/agent/sdk.js` before editing.
Validate: AC#3, AC#5 — exit code and warning text match the code; no mention of `runwave.js` remains.

#### Task 1.3: CI index, guards, follow-ups, RAD_SYNC, sweep and checks
File: docs/rad-cli.md:910-920, docs/rad-cli.md:1581-1594, docs/rad-cli.md:1708-1717, docs/configuration.md:508-525
What: Apply AC#6, AC#7 and AC#8. For the CI index read `.github/workflows/ci.yml` and run `bash scripts/verify-all.sh --list`; for `RAD_SYNC` read every file named in AC#7. Then run the AC#8 grep, check every relative markdown link in both docs, and run `git diff --stat main...HEAD`.
Validate: AC#6, AC#7, AC#8, AC#9 — the grep prints nothing; no missing link target; the diff stat lists only the two docs and this plan.

## Tests to Write
- None. Documentation only; each statement is checked against the code it cites, and the grep, link and diff checks in Task 1.3 are the verification.

## Non-Goals
- Adding sections for `rad status`, `rad config`, `rad capabilities`, `rad generate`, `rad owner-claim`, `rad owner-release`, `rad architecture-approve` and `rad plan-fingerprint` (the next plan)
- Checking lines ~540-820 (`pr-body`, `review`, `exercise`) and the per-wave test gate in detail; the audit did not verify them either
- Changing any code, script or test
- The `harness-*` docs

## Risks
- Line numbers drift; the executor locates each passage by its text and treats the numbers as hints.
- The CI index can go stale when jobs change; it names `ci.yml` and `verify-all.sh --list` as the source of truth.
