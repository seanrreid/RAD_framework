# Plan: Report Token Usage from claude -p, and Warn When a Budget Cannot Trip (#270)
Created: 2026-10-13
Author: architect
Status: in-progress
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-13T19:23:30.405Z
Recorded-By: sean@torchcodelab.com
Branch: rad/claude-usage-wrapper-and-budget-warning
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/270 (options 1 and 4; the issue stays open until the config switch is verified)
Issue-Title: Command adapter with 'claude -p' records no token usage, so the token budget never trips and cost metrics are empty
Source-Author: seanrreid (OWNER)
Source-Comments: 1 total, 0 non-collaborator

## Context
With the configured agent (`command: "claude -p"`), 0 of 106 recorded wave attempts carry a `usage` object, so the token-budget breaker (`RAD_TOKEN_BUDGET`) can never trip, tokens per delivered feature is always `null`, and the cache fields (#121) are never populated. Investigation on 2026-10-13, with one real one-word call, established:

- `claude -p --output-format json` prints **one JSON object**: `result` (the text), `is_error`, `total_cost_usd`, `num_turns`, and `usage` with `input_tokens` (2), `output_tokens` (4), `cache_creation_input_tokens` (16,570) and `cache_read_input_tokens` (10,977). A thin wrapper can turn that into the `RAD_USAGE` line the command adapter already parses.
- **Almost all consumption is in the cache fields.** RAD computes `total` as an explicit total if given, else `input + output`, so a plain pass-through would report about 6 for a call that processed about 27.5K tokens and the budget would still essentially never trip. The wrapper therefore sends an **explicit `total` that includes all four token types** (decision by the architect, 2026-10-13): input, output, cache creation and cache read. Cost is sent separately as `cost`.

**Decisions (architect, 2026-10-13):** (1) build the wrapper; (4) add a loud warning when a budget is armed but a wave reports no usage; `total` counts all four token types.

**What this plan does:**
1. `scripts/claude-usage.mjs`, a wrapper the command adapter runs in place of `claude -p`. It runs the real CLI in JSON mode, prints a `RAD_USAGE` line **first** (so text written by the agent can never pre-empt it, because the adapter takes the first match), then the result text, and passes the exit status through. If the CLI's output is not the expected JSON, it passes the raw output through unchanged, so a broken CLI is visible and not hidden.
2. `harness/usage-watch.js`, a small decorator over `runWave` that writes one stderr line, once per run, when a budget is armed and a wave returns no `usage`. It works for any adapter and changes no result.
3. Tests, docs, and the one recorded characterization value that changes on purpose.

**What it deliberately does not do:** it does not switch `.rad/config.yml`. CI cannot call the real `claude`, so the switch (`command: "node scripts/claude-usage.mjs"`) is a documented one-line change made after merge, once a real call through the wrapper has been checked. The issue therefore stays open until then. The plan has no `Issue:` header for the same reason.

**Blast radius, measured.** A prototype of the warning, run through the whole harness suite (2,052 tests), broke exactly one test: the recorded scenario `deliver — armed budget does not warn` (its injected wave reports no usage, so it now also prints the new warning). One other test, an ACP `ignore-cancel` timing test, failed once and is a pre-existing flake (it also failed once in two clean-`main` runs and passed three of three on the prototype).

## Scope
| In scope | Out of scope |
|---|---|
| `scripts/claude-usage.mjs` and its tests (unit and end-to-end with a fake `claude`) | Switching `.rad/config.yml` to use the wrapper (post-merge, after a real-call check) |
| `harness/usage-watch.js`, its tests, and a one-line wrap in `cli.js` | A cost-based breaker (`RAD_COST_BUDGET`) or any change to the spine, the stop table or the matrix |
| New characterization scenarios, and the one recorded value that must change | Changing how the SDK adapter computes `total` |
| Docs for the wrapper, the config line and the unit of `total` | The ACP `ignore-cancel` flake |

## Acceptance Criteria
1. **Usage line first.** For a successful JSON result, the wrapper's stdout begins with exactly one line `RAD_USAGE {json}` and then the result text. The JSON has `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, an explicit `total` equal to the sum of those four, and `cost` taken from `total_cost_usd`; a field that is missing or not a finite non-negative number is omitted, and if none of the four token fields is usable the line is omitted.
2. **The adapter understands it.** Feeding the wrapper's stdout through the command adapter's own usage extraction yields `usage.total` equal to the four-field sum, `cacheRead`, `cacheWrite` and `cost`.
3. **Agent text cannot spoof usage.** If the result text itself contains a line starting `RAD_USAGE`, the adapter still takes the wrapper's first line.
4. **Exit status is honest.** The wrapper exits with the CLI's non-zero status; if the CLI exits 0 but the JSON has `is_error: true`, it prints the usage line and the result text and exits 1; a CLI killed by a signal, or a CLI that cannot be spawned, exits non-zero with a message on stderr.
5. **Failure is transparent.** If stdout is not a JSON object of `type` `result`, or `result` is not a string, the wrapper writes the CLI's raw stdout to stdout and raw stderr to stderr unchanged, adds no `RAD_USAGE` line, and exits with the CLI's status.
6. **Arguments and prompt pass through.** Arguments after the script name are forwarded to the CLI after `-p --output-format json`; the prompt on stdin reaches the CLI's stdin unchanged, including a large (over 1 MiB) prompt and an empty one.
7. **The warning, once.** With a valid positive `RAD_TOKEN_BUDGET` and a wave result that has no `usage`, `rad deliver` writes exactly one stderr line naming the variable and the wave, however many waves follow; with a wave that reports usage, or with no valid budget, nothing is written. The wave result, its identity and any thrown error are passed through unchanged.
8. **Recorded behavior changes narrowly.** After regenerating `cli-commands-golden.json`, exactly one existing value changes, `deliver — armed budget does not warn` (it gains the one warning line); new scenarios cover an armed budget with a usage-reporting wave (no warning) and an armed budget with several usage-less waves (one warning); nothing else in the file changes.
9. **Ratchet intact.** `node scripts/lint-function-length.mjs` exits 0 with the empty baseline (every function, including any helper added to `cli.js`, is 40 lines or fewer).
10. **Documented.** `docs/rad-wave-contract.md` describes the wrapper and the explicit `total`; `docs/configuration.md` shows the config line and says what `RAD_TOKEN_BUDGET` counts when the wrapper is used; `docs/rad-decisions.md` has one bullet.
11. **Full suite passes.** `scripts/verify-all.sh` passes on the delivered branch.

## Agent Scope
No sub-agents were called. Research was inline (14 tool calls, over the usual cap because the plan has to name every test it can disturb): the CLI help and one real JSON call, how usage keys are accepted and totaled, where the breaker reads usage, how the command adapter tokenizes its command, where `runWave` reaches the spine, and a prototype of the warning run through the whole suite in a scratch checkout (removed; the repository was not modified).

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| scripts/claude-usage.mjs | 1-130 | New (mode 100755). Pure converters plus a main guard that spawns the CLI |
| harness/test/claude-usage.test.js | 1-180 | New. Unit tests of the converters |
| scripts/test-claude-usage.sh | 1-140 | New (mode 100755). End-to-end tests with a fake `claude` on `PATH` |
| harness/usage-watch.js | 1-70 | New. The decorator and its message constant |
| harness/test/usage-watch.test.js | 1-100 | New. Unit tests of the decorator |
| harness/cli.js | 68-76 | Import the decorator |
| harness/cli.js | 2160-2200 | Wrap `runWave` when a budget is armed (in a helper if `buildSpineArgs` would exceed 40 lines) |
| harness/test/cli-commands-characterization.test.js | 515-525 | New scenarios beside `armed budget does not warn` |
| harness/test/fixtures/cli-commands-golden.json | 1-1 | Regenerated; exactly one existing value changes |
| docs/rad-wave-contract.md | 96-125 | The `RAD_USAGE` section: the wrapper and the explicit total |
| docs/configuration.md | 280-300 | The agent command line and the unit of `RAD_TOKEN_BUDGET` |
| docs/rad-decisions.md | 15-45 | One bullet |

## Execution Notes

### Do Not Touch
- harness/spine.js, harness/stops.js, harness/matrix.yaml, harness/events.js and the adapters under harness/adapters/ (the warning is a decorator in `cli.js`; the wrapper is a separate script)
- `.rad/config.yml` (the switch is a post-merge step)
- Every existing test other than adding scenarios to `cli-commands-characterization.test.js` and regenerating its golden file

### Key Files
- harness/adapters/agent/command.js — `extractUsage` (`^RAD_USAGE\s+(\{.*\})\s*$`, multiline, first match) and `tokenizeCommand` (whitespace split, `{prompt}` and `{model}` tokens; `{model}` is only substituted when a model is set, so the wrapper command must not hard-code it)
- harness/adapters/agent/contract.js — `normalizeUsage` and `OPTIONAL_USAGE_FIELDS` (`cache_read_input_tokens` to `cacheRead`, `cache_creation_input_tokens` to `cacheWrite`, `cost`)
- harness/cli.js — `parseTokenBudget` (~331), `tokenBudgetWarning` (~341), `buildSpineArgs` (~2164)
- harness/test/cli-commands-characterization.test.js — `withWave`, `usageWave`, the budget scenarios (~521-574), `UPDATE_GOLDEN=1`
- docs/rad-wave-contract.md — the existing `RAD_USAGE` section

### Reminders
- harness/, scripts/ and docs are touched: architect approval and the last-wave full-suite Verify. Deliver with `RAD_WAVE_TIMEOUT_SECONDS=1800` AND `RAD_VERIFY_TIMEOUT_SECONDS=1800`.
- New `.sh` and `.mjs` files under `scripts/` must be committed mode 100755 and the shell test must parse under bash 3.2 (no associative arrays, no `mapfile`). Top-level `scripts/*.mjs` and `*.sh` are installed into consumer projects, so the wrapper must not depend on anything in `scripts/vendor/` or `harness/`.
- The wrapper must not use a shell: spawn `claude` directly with an argument array. It inherits the environment the command adapter gives it (already allow-listed) and adds nothing.
- Print the usage line before the result text and write the whole output in one go; do not stream partial text before the usage line.
- The end-to-end test must never call the real `claude`: put a fake executable named `claude` first on `PATH` that prints a scripted JSON object, echoes its arguments and stdin to a file, and exits with a scripted status.
- For the golden file: regenerate with `UPDATE_GOLDEN=1`, then read `git diff` and confirm exactly one existing value changed and the new scenarios were added; if any other value changed, stop and report.
- Keep every function at 40 lines or fewer. If wrapping `runWave` would push `buildSpineArgs` over 40 lines, put the wrapping in a small helper.
- Comments that state a constraint stay (for example why the usage line comes first).

## Program Design

```js
// scripts/claude-usage.mjs  (exports for tests; the spawn/IO code runs only when invoked directly)
export const USAGE_TOKEN_KEYS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];
export function parseClaudeJson(stdout)        // -> { result: string, isError: boolean, usage: object|null, cost: number|null } | null  (null => not the expected shape)
export function buildUsageLine(usage, cost)    // -> 'RAD_USAGE {...}' | null   (explicit total = sum of the four; omits unusable fields)
export function renderOutput(parsed)           // -> stdout text: usage line (if any), then result text
export function exitStatus(childStatus, signal, parsed)   // -> number
export function main(argv, io)                 // spawn claude -p --output-format json ...argv; never throws

// harness/usage-watch.js
export const UNMETERED_BUDGET_WARNING = (waveId) => `rad deliver: RAD_TOKEN_BUDGET is set but wave ${waveId} reported no token usage, so the budget cannot trip ...\n`;
export function warnOnUnmeteredBudget(runWave, { armed, write })   // -> runWave (wrapped when armed, else the same function)
```

Call stack:

```
command adapter -> spawn "node scripts/claude-usage.mjs" (prompt on stdin) -> main -> claude -p --output-format json
                -> renderOutput: "RAD_USAGE {...}\n<result text>"  -> extractUsage -> usage.total / cacheRead / cacheWrite / cost
rad deliver -> buildSpineArgs/runSpine -> warnOnUnmeteredBudget(runWave, { armed: parseTokenBudget(env) !== null, write: stderr })
```

File tree diff:

```
scripts/claude-usage.mjs, scripts/test-claude-usage.sh          NEW
harness/usage-watch.js, harness/test/{claude-usage,usage-watch}.test.js   NEW
harness/cli.js                         + import, + wrap
harness/test/cli-commands-characterization.test.js, fixtures/cli-commands-golden.json   + scenarios, 1 value changed
docs/rad-wave-contract.md, docs/configuration.md, docs/rad-decisions.md   docs
```

## Wave Plan

### Wave 1 — sequential
Tasks in this wave must run in sequence (1.2 tests the script written in 1.1).
Verify: node --test harness/test/claude-usage.test.js harness/test/usage-watch.test.js && bash scripts/test-claude-usage.sh && bash scripts/lint-shell-safety.sh && bash scripts/test-bash32-parse.sh

#### Task 1.1: The wrapper and its unit tests
File: scripts/claude-usage.mjs:1-130, harness/test/claude-usage.test.js:1-180
What: Write the wrapper as specified in Program Design and AC#1-AC#6, with a main guard so importing it runs nothing. Unit-test the converters: the real shape seen on 2026-10-13 (including `usage.iterations`, `modelUsage` and the extra fields, which are ignored); each missing or malformed field (non-number, negative, `NaN`, string); no usable token field (no usage line); `total` equals the four-field sum; `cost` passes through; `is_error` true; `result` not a string; the input not JSON, a JSON array, `null`, an empty string; a very large result; the usage line is first; a result containing a line that starts `RAD_USAGE`.
Validate: AC#1, AC#3, AC#4, AC#5 — each case is a named assertion; the extraction round trip of AC#2 is asserted with the command adapter's own extractor.

#### Task 1.2: End-to-end tests with a fake claude
File: scripts/test-claude-usage.sh:1-140
What: A shell test that puts a scripted fake `claude` on `PATH` and runs the wrapper for: success with usage (usage line first, text second, exit 0); a pass-through of extra arguments and of the prompt on stdin, including a prompt over 1 MiB and an empty prompt; `is_error` with exit 0 (exit 1); a CLI exiting non-zero with a JSON body; a CLI exiting non-zero with plain text (raw pass-through, same status); non-JSON output with exit 0 (raw pass-through, no usage line, exit 0); a CLI that is not on `PATH` (non-zero, message on stderr); a CLI killed by a signal.
Validate: AC#4, AC#5, AC#6 — each scenario asserts stdout, stderr and the exit status.

#### Task 1.3: The budget warning decorator
File: harness/usage-watch.js:1-70, harness/test/usage-watch.test.js:1-100
What: Write `warnOnUnmeteredBudget`: not armed returns the same function untouched; armed returns a wrapper that awaits the real `runWave`, and the first time a result is `null`, `undefined` or has no `usage` (or `usage` is `null`) writes one line through `write` naming the wave, then never again for that wrapper; it returns the result object unchanged and lets thrown errors propagate. Test: unarmed identity; armed with usage (no write); armed without usage across several waves (exactly one write); a thrown error; a falsy result; `usage: 0`-total results still count as reporting usage; the wave id appears in the message.
Validate: AC#7 — each case is a named assertion; edge cases (null result, null usage, thrown error, several waves) are explicit.

### Wave 2 — sequential
Tasks in this wave must run in sequence (2.2 needs the wiring from 2.1).
Verify: exec bash scripts/verify-all.sh

#### Task 2.1: Wire the decorator into rad deliver
File: harness/cli.js:68-76, harness/cli.js:2160-2200
What: Import `warnOnUnmeteredBudget` and apply it to the `runWave` handed to `deliverSpine`, with `armed` from `parseTokenBudget(process.env) !== null` and `write` bound to stderr, in a helper if needed to keep `buildSpineArgs` at 40 lines or fewer. The unarmed-budget warning and the breaker are unchanged.
Validate: AC#7, AC#9 — the new decorator tests and the existing deliver tests pass; `node scripts/lint-function-length.mjs` exits 0.

#### Task 2.2: Characterization scenarios and the one changed value
File: harness/test/cli-commands-characterization.test.js:515-525, harness/test/fixtures/cli-commands-golden.json:1-1
What: Add the scenarios of AC#8 beside `armed budget does not warn`, then run `UPDATE_GOLDEN=1 node --test harness/test/cli-commands-characterization.test.js` and review `git diff` of the golden file: exactly one existing value must change (`deliver — armed budget does not warn`, gaining the one warning line) and the new scenarios must appear. Then run the test without the variable twice.
Validate: AC#8 — the golden diff is exactly that; if anything else changed, stop and report.

#### Task 2.3: Docs
File: docs/rad-wave-contract.md:96-125, docs/configuration.md:280-300, docs/rad-decisions.md:15-45
What: In the `RAD_USAGE` section describe the wrapper, the first-line rule, the explicit `total` (input + output + cache creation + cache read, so a trivial call is already about 27K) and that `cost` is carried separately. In `docs/configuration.md` show `command: "node scripts/claude-usage.mjs"` as the way to enable usage for the `claude` CLI, note not to hard-code `{model}`, and say what `RAD_TOKEN_BUDGET` counts when the wrapper is used. Add one bullet to `docs/rad-decisions.md`.
Validate: AC#10, AC#11 — the wording is present; `harness/test/skill-bodies.test.js` and the docs-related checks still pass; the wave's full-suite Verify passes.

## Tests to Write
- [ ] Wrapper converters, the usage line, the explicit total, spoof resistance and failure transparency — harness/test/claude-usage.test.js
- [ ] Wrapper end to end with a fake `claude` (arguments, stdin, exit statuses, raw pass-through) — scripts/test-claude-usage.sh
- [ ] The unmetered-budget decorator — harness/test/usage-watch.test.js
- [ ] Armed budget with and without usage in the deliver command — harness/test/cli-commands-characterization.test.js

## Non-Goals
- Switching the repository's agent command (post-merge)
- A cost-based budget, or any change to the spine, stop table or matrix
- Changing how the SDK adapter computes `total`
- Fixing the ACP `ignore-cancel` timing flake

## Out-of-Scope Dependencies
None.

## Risks
- The wrapper sits between the harness and the agent. A bug would break deliveries once the config points at it. Mitigations: the plan does not switch the config; the harness preflight (`probeCommand`) runs the configured command once before any wave and fails closed on a non-zero exit; and non-JSON output passes through unchanged. Rollback is the one-line config change back to `claude -p`.
- The CLI's JSON shape is not a documented contract. The wrapper degrades to a raw pass-through when the shape differs, so a changed CLI loses usage data but not deliveries; the tests pin the shape seen on 2026-10-13.
- Counting cache reads in `total` makes the number large (a trivial call is about 27K). Budgets must be sized in "tokens processed"; the docs say so, and `cost` is carried for anyone who wants dollars.
- `--output-format json` returns the whole result at once, so nothing streams to a terminal while a wave runs; the command adapter captures stdout anyway.
- The warning writes to stderr only and is not recorded as an event, like the existing unarmed-budget warning.

## Issue Gaps
- ASSUMPTION: no `Issue:` header, because merging this plan does not complete #270; the config switch and one real-call check are the remaining steps, and the issue is closed by hand after them.
- ASSUMPTION: `total` includes cache reads and cache creation, per the architect's decision; `cost` is reported separately and is not used by any breaker.
- ASSUMPTION: the warning is advisory and does not stop the run. A stop could be added later if a budget set without usage should be a hard failure.
- ASSUMPTION: the wrapper forwards extra arguments after the script name to the CLI but always sets `-p --output-format json` itself; a caller-supplied `--output-format` would be a conflict, and the wrapper does not try to reconcile it.
- ASSUMPTION: line ranges for the docs and `cli.js` are estimates from grep results; the executor should stay within the named areas.
