# Plan: Switch This Repository's Agent Command to the Usage Wrapper (#270)
Created: 2026-10-13
Author: architect
Status: in-progress
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-13T19:55:32.323Z
Recorded-By: sean@torchcodelab.com
Branch: rad/switch-agent-to-usage-wrapper
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/270 (the config switch; the wrapper and the budget warning shipped in #273)
Issue-Title: Command adapter with 'claude -p' records no token usage, so the token budget never trips and cost metrics are empty
Source-Author: seanrreid (OWNER)
Source-Comments: 1 total, 0 non-collaborator

## Context
#273 added `scripts/claude-usage.mjs`, a wrapper that runs `claude -p --output-format json` and prints a `RAD_USAGE` line (with an explicit `total` that counts input, output, cache creation and cache read tokens, plus the cache fields and `cost`) before the result text, and a one-time warning when a token budget is armed but a wave reports no usage. It deliberately did not change this repository's own agent command, because CI cannot call the real `claude`. This plan is that switch: one line in `.rad/config.yml`.

**Evidence that it is safe to switch (2026-10-13), gathered before planning:**
- The delivered wrapper, run against the real CLI with a one-word prompt, exited 0 and printed `RAD_USAGE {"input_tokens":2,"output_tokens":4,"cache_read_input_tokens":10977,"cache_creation_input_tokens":16476,"total":27459,"cost":0.0670457}` as its first line and `OK` as its second; the command adapter's own extractor turned that into `total 27459`, `cacheRead`, `cacheWrite` and `cost`.
- The harness's own preflight, `probeCommand`, run with `node scripts/claude-usage.mjs` as the command, returned `{"ok":true}` in 7.3 seconds. That is the check `rad deliver` runs once before any wave, so a broken wrapper would fail closed and visibly.
- Nothing in the repository's tests or scripts asserts the current value `claude -p`. The only other mentions are consumer-facing docs describing the `claude` init preset, which this plan leaves alone.

**This delivery runs on the old command.** `rad deliver` reads the configuration on `main` when it starts, which still says `claude -p`; the new value takes effect for the deliveries after this one merges.

**Rollback** is the same one line reverted to `claude -p`; nothing else depends on it.

## Scope
| In scope | Out of scope |
|---|---|
| The `agent.command` value in this repository's `.rad/config.yml`, plus one explanatory comment line | The `claude` init preset that consumer projects get (`rad config init --agent claude`); a separate decision |
| | Setting `RAD_TOKEN_BUDGET` (an environment choice, made later from observed totals) |
| | Any change to the wrapper, the harness or the docs |

## Acceptance Criteria
1. **One value changes.** In `.rad/config.yml`, `agent.adapter` stays `command` and `agent.command` becomes `node scripts/claude-usage.mjs`; one comment line above `agent:` says the command is the usage wrapper and that reverting to `claude -p` drops it. The diff is those lines only; every other key, including `roles`, `platform`, `default_branch` and `agent_scope_map`, is byte-identical.
2. **The config is valid and reads back.** `node harness/cli.js config validate` exits 0, and `node harness/cli.js config get agent` prints `{"adapter":"command","command":"node scripts/claude-usage.mjs"}`.
3. **The wrapper is where the command points.** `scripts/claude-usage.mjs` exists, is executable (mode 100755) and passes `node --check`.
4. **Nothing else moved.** The whole existing suite passes unchanged.
5. **Full suite passes.** `scripts/verify-all.sh` passes on the delivered branch.

## Agent Scope
No sub-agents were called. Research was inline (5 tool calls): the current config, every mention of `claude -p` in code, scripts, tests and docs, and a real preflight dry run with the new command (a one-word call, about 7 seconds, run from the main checkout before planning).

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| .rad/config.yml | 1-12 | The `agent.command` value and one comment line above `agent:` |

## Execution Notes

### Do Not Touch
- Every file other than `.rad/config.yml`
- The `roles`, `platform`, `default_branch`, `settings` and `agent_scope_map` sections of the same file

### Key Files
- .rad/config.yml — the `agent:` block at lines 6-8
- scripts/claude-usage.mjs — the command's target (read only)

### Reminders
- `.rad/` is self-protected: architect approval and the last-wave full-suite Verify. Deliver with `RAD_WAVE_TIMEOUT_SECONDS=1800` AND `RAD_VERIFY_TIMEOUT_SECONDS=1800`.
- Use the exact command string `node scripts/claude-usage.mjs`: no `{model}` token (it is substituted only when a model is set, so the literal would reach the CLI), no extra arguments.
- Do not run the real `claude` CLI from the wave; the delivery agent is itself the CLI, and the real-call evidence is recorded above. The wave's checks are `config validate`, `config get agent` and the suite.
- Keep the YAML style of the file (two-space indent, unquoted scalar as today).

## Wave Plan

### Wave 1 — sequential
Tasks in this wave must run in sequence.
Verify: exec bash scripts/verify-all.sh

#### Task 1.1: Change the agent command
File: .rad/config.yml:1-12
What: Replace `command: claude -p` with `command: node scripts/claude-usage.mjs` under `agent:` and add one comment line directly above `agent:` stating that the command is the usage wrapper (`scripts/claude-usage.mjs`, which reports token usage and cost to the harness) and that reverting to `claude -p` removes usage reporting. Change nothing else in the file.
Validate: AC#1, AC#2, AC#3 — `git diff` shows only those lines; `node harness/cli.js config validate` exits 0; `node harness/cli.js config get agent` prints the new object; `test -x scripts/claude-usage.mjs` and `node --check scripts/claude-usage.mjs` succeed. This is configuration data with no new behavior to unit test; the existing config tests and the validate command are the checks.

#### Task 1.2: Full-suite check
File: .rad/config.yml:1-12
What: No further edit. The wave's Verify runs the full suite, which includes `config-validate` and the config tests.
Validate: AC#4, AC#5 — `scripts/verify-all.sh` passes.

## Tests to Write
- None. This plan changes one configuration value; the validation command and the existing config tests cover it, and the real behavior was checked by the real-call evidence in Context.

## Non-Goals
- Changing the `claude` init preset for consumer projects
- Setting a token budget
- Any change to the wrapper or the harness

## Out-of-Scope Dependencies
None.

## Risks
- Every delivery after this one goes through the wrapper. A wrapper bug would stop deliveries. The preflight probe runs the command once before any wave and fails closed, the wrapper passes raw output through when the CLI's JSON is not as expected, and the real-call evidence above shows it working; rollback is one line.
- `--output-format json` returns the whole result at once, so nothing streams to a terminal while a wave runs; the command adapter already captures stdout, so deliveries are unaffected.
- With usage now recorded, a `RAD_TOKEN_BUDGET` would start to trip, and a trivial call is already about 27K "tokens processed". No budget is set by this plan; the variable remains unset in the environment.
- If the CLI's JSON shape changes in a future version, the wrapper degrades to a raw pass-through and usage stops being recorded, which `/rad-insights` would show as tokens per feature returning to `null`.

## Issue Gaps
- ASSUMPTION: the plan carries no `Issue:` header and does not itself close #270, which stays open until a real delivery after this one is observed to record usage (`wave-attempt` events with a `usage` object and `/rad-insights` showing tokens per feature).
- ASSUMPTION: one comment line above `agent:` is acceptable in the config file; it explains the non-obvious command and the rollback.
- ASSUMPTION: the command is written relative to the repository root (`node scripts/claude-usage.mjs`), which is the agent's working directory in the main checkout and in worktrees (both carry `scripts/`).
